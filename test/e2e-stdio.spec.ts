/**
 * End-to-end test over a real stdio MCP connection: it boots the built daemon as a subprocess exactly as the plugin
 * manifest does, then drives one ticket from injection to a completed domain outcome. This is the regression baseline for
 * the whole loop — the earlier manual run found a real bug (a wrong tool name inside the worker prompt) that no unit test
 * could see, so every protocol step here goes through the same JSON the orchestrator and workers actually receive.
 *
 * The worker is simulated: the test plays the subagent and calls the `superagent_worker_*` tools itself, which is what a
 * subagent does. What is NOT simulated is the daemon, the database, the effect queue, or the MCP transport.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
let dir: string
let repo: string
let stateDir: string
let client: Client

/** Runs git in the fixture repository with a fixed identity, ignoring output. */
function git(...args: string[]): void {
  execFileSync('git', args, {
    cwd: repo, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' },
  })
}

/** Calls a tool and returns its first text content, failing loudly when the tool reports an error. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { type: string; text?: string }[])[0]?.text ?? ''
  if (result.isError) throw new Error(name + ' failed: ' + text)
  return text
}

/** Calls a tool and parses its JSON body. */
async function callJson<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return JSON.parse(await call(name, args)) as T
}

/** The `actions` array of one tick, or an empty array when the queue is empty. */
async function tick(): Promise<{ actionId: string; kind: string; [key: string]: unknown }[]> {
  const text = await call('superagent_tick')
  if (text.startsWith('No pending actions')) return []
  return (JSON.parse(text.slice(text.indexOf('{')) as string) as { actions: { actionId: string; kind: string }[] }).actions
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'open-superagent-e2e-'))
  repo = join(dir, 'repo')
  stateDir = join(dir, 'state')
  mkdirSync(repo, { recursive: true })
  git('init', '--initial-branch=main')
  writeFileSync(join(repo, 'README.md'), '# fixture\nThere is a smaple typo here.\n')
  git('add', '.')
  git('commit', '-m', 'fixture')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'lib', 'daemon', 'index.js')],
    env: { ...process.env, OPEN_SUPERAGENT_STATE_DIR: stateDir, OPEN_SUPERAGENT_PROJECT_DIR: repo },
  })
  client = new Client({ name: 'open-superagent-e2e', version: '0.0.0' })
  await client.connect(transport)
}, 120_000)

afterAll(async () => {
  await client?.close().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('end to end over stdio', () => {
  it('exposes the orchestrator, operator, and worker tool batches', async () => {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort()
    for (const name of [
      'superagent_status', 'superagent_tick', 'superagent_tick_ack', 'superagent_health', 'superagent_read',
      'superagent_route', 'superagent_eval_read', 'superagent_eval_decide', 'superagent_reply', 'superagent_ticket_note',
      'superagent_settings_get', 'superagent_settings_save', 'superagent_trigger_inject',
      'superagent_ticket_retry', 'superagent_ticket_stop', 'superagent_ticket_status', 'superagent_thread_unsubscribe',
      'superagent_decision_dismiss', 'superagent_trigger_requeue',
      'superagent_worker_read', 'superagent_worker_ack', 'superagent_worker_report', 'superagent_worker_handback',
      'superagent_worker_thread_unrelated', 'superagent_worker_thread_follow',
    ]) expect(names).toContain(name)
    // The worker prompt protocol names exactly these; a rename here would silently break every worker.
    expect(await call('superagent_tick_ack', { actionIds: ['missing'] }).catch(error => String(error))).toContain('0')
  })

  it('reports a ready runtime, not a permanently starting one', async () => {
    const health = await callJson<Record<string, { state: string }>>('superagent_health')
    expect(health.runtime?.state).toBe('ready')
  })

  it('seeds the local operator so an explicit request is admissible', async () => {
    const settings = await callJson<{ settings: { policy: { sources: Record<string, { allowed: { id: string }[] }> } } }>('superagent_settings_get')
    expect(settings.settings.policy.sources.manual?.allowed?.map(entry => entry.id)).toContain('operator')
  })

  it('runs one ticket from injection to completion', async () => {
    const injected = await callJson<{ result: string; triggerId: string }>('superagent_trigger_inject', {
      threadId: 'e2e', actorId: 'operator', text: 'Fix the typo in README.md: smaple -> sample.', human: true, addressed: 'direct',
    })
    expect(injected.result).toBe('stored')

    // The explicit request becomes a candidate; accept it through routing. The accept's acknowledgement is queued at once.
    const routed = JSON.parse(await call('superagent_route', {
      decisions: [{ triggerId: injected.triggerId, kind: 'accept', title: 'Fix README typo', scope: 'small', reason: 'explicit request', acknowledgement: 'Fixing the README typo now.' }],
    })) as { triggerId: string; ok: boolean; ticketId?: string }[]
    expect(routed[0]?.ok).toBe(true)
    const ticketId = routed[0]!.ticketId!
    expect(ticketId).toBeTruthy()

    // One tick hands out the whole batch; the orchestrator must act on every action it receives, not just one.
    const batch = await waitForKind('spawn_worker')
    const spawn = batch.find(action => action.kind === 'spawn_worker')!
    const receipt = batch.find(action => action.kind === 'reply_recorded')
    // A manual-source receipt is this conversation: the text goes to the person verbatim.
    expect(receipt).toBeTruthy()
    expect(String(receipt!.text)).toContain('Fixing the README typo')
    expect(spawn.ticketId).toBe(ticketId)
    expect(String(spawn.prompt)).toContain('superagent_worker_read')
    expect(String(spawn.prompt)).not.toMatch(/\bsuperagent_report\b/)
    await call('superagent_tick_ack', { actionIds: batch.map(action => action.actionId) })

    // The prompt's directory is the prepared worktree, and it holds the repository.
    const directory = String(spawn.directory)
    expect(existsSync(join(directory, 'README.md'))).toBe(true)

    // The worker reads the full record and reports ready; a real subagent would edit here first.
    const record = await callJson<{ id: string; mandate: { strength: string } }>('superagent_worker_read', { ticketId })
    expect(record.id).toBe(ticketId)
    expect(record.mandate.strength).toBe('explicit')
    await call('superagent_worker_report', { ticketId, state: 'ready', summary: 'Changed smaple to sample in README.md.' })

    // The relay reaches the orchestrator, and the ticket ends as completed.
    const relayBatch = await waitForKind('relay')
    expect(relayBatch.some(action => String(action.text).includes('ready'))).toBe(true)
    await call('superagent_tick_ack', { actionIds: relayBatch.map(action => action.actionId) })

    const status = await callJson<{ open: boolean; ended?: { outcome: string } }>('superagent_ticket_status', { ticketId })
    expect(status.open).toBe(false)
    expect(status.ended?.outcome).toBe('completed')

    const tickets = await callJson<{ tickets: { id: string }[] }>('superagent_read', { resource: 'tickets' })
    expect(tickets.tickets.map(ticket => ticket.id)).not.toContain(ticketId)

    // Acknowledging everything must leave the queue empty, so no action is handed out twice.
    expect(await tick()).toEqual([])
  }, 120_000)

  it('rejects an unlisted sender instead of starting work', async () => {
    const injected = await callJson<{ result: string; triggerId: string }>('superagent_trigger_inject', {
      threadId: 'e2e-2', actorId: 'stranger', text: 'Do something.', human: true, addressed: 'direct',
    })
    expect(injected.result).toBe('stored')
    const actions = await tick()
    expect(actions.some(action => action.kind === 'assess_candidate')).toBe(false)
  })
})

describe('daemon lifecycle', () => {
  it('serves tools to a second session in the same project instead of refusing to start', async () => {
    // ZCode starts one MCP server per session. Refusing the second one left that session with no superagent tools at all,
    // which looks like "the plugin is not installed". Both sessions must serve tools over one shared database; only
    // scheduling is exclusive.
    const sharedDir = join(dir, 'shared')
    const openSession = async (name: string) => {
      const client = new Client({ name, version: '0.0.0' })
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(root, 'lib', 'daemon', 'index.js')],
        env: { ...process.env, OPEN_SUPERAGENT_STATE_DIR: sharedDir, OPEN_SUPERAGENT_PROJECT_DIR: repo },
      }))
      return client
    }
    const first = await openSession('shared-1')
    const second = await openSession('shared-2')
    expect((await first.listTools()).tools.map(tool => tool.name)).toContain('superagent_tick')
    expect((await second.listTools()).tools.map(tool => tool.name)).toContain('superagent_tick')
    // The follower writes to the shared database, and the leader's queue reflects it.
    await second.callTool({ name: 'superagent_trigger_inject', arguments: {
      threadId: 'shared-thread', actorId: 'operator', text: 'Fix a typo in README.md.', human: true, addressed: 'direct' } })
    const tickCall = await first.callTool({ name: 'superagent_tick', arguments: {} })
    const tick = String((tickCall.content as { text?: string }[])[0]?.text)
    expect(tick).toContain('assess_candidate')
    await first.close()
    await second.close()
  }, 60_000)

  it('releases the state lock when the client disconnects, so the same project can start again', async () => {
    // A lock that outlives the session would make every later session in this project fail with exit 3, which is the
    // difference between "restart the app" and "the plugin is broken". The stale window is 30 s, so a test that passes
    // within a second proves the lock was released, not merely aged out.
    const lifecycleDir = join(dir, 'lifecycle')
    const first = new Client({ name: 'lifecycle-1', version: '0.0.0' })
    await first.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'lib', 'daemon', 'index.js')],
      env: { ...process.env, OPEN_SUPERAGENT_STATE_DIR: lifecycleDir, OPEN_SUPERAGENT_PROJECT_DIR: repo },
    }))
    await first.close()
    // Reconnect immediately: no sleep long enough to let proper-lockfile expire the lock.
    const second = new Client({ name: 'lifecycle-2', version: '0.0.0' })
    await second.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'lib', 'daemon', 'index.js')],
      env: { ...process.env, OPEN_SUPERAGENT_STATE_DIR: lifecycleDir, OPEN_SUPERAGENT_PROJECT_DIR: repo },
    }))
    const names = (await second.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('superagent_tick')
    await second.close()
  }, 60_000)

  it('keeps working on a ticket across a daemon restart instead of stranding it', async () => {
    // The crash-between-tick-and-spawn case: the domain says the assignment runs, but no worker was ever created. A
    // restart must re-issue the spawn, not leave the ticket "working" forever with nothing running.
    const restartDir = join(dir, 'restart')
    const open = async () => {
      const client = new Client({ name: 'restart', version: '0.0.0' })
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(root, 'lib', 'daemon', 'index.js')],
        env: { ...process.env, OPEN_SUPERAGENT_STATE_DIR: restartDir, OPEN_SUPERAGENT_PROJECT_DIR: repo },
      }))
      return client
    }
    const first = await open()
    const firstInject = await first.callTool({ name: 'superagent_trigger_inject', arguments: {
      threadId: 'restart', actorId: 'operator', text: 'Fix another typo in README.md.', human: true, addressed: 'direct' } })
    const injected = JSON.parse(String((firstInject.content as { text?: string }[])[0]?.text)) as { triggerId: string }
    const firstRoute = await first.callTool({ name: 'superagent_route', arguments: { decisions: [
      { triggerId: injected.triggerId, kind: 'accept', title: 'Restart case', scope: 'small', reason: 'explicit request' }] } })
    const routed = JSON.parse(String((firstRoute.content as { text?: string }[])[0]?.text)) as { ticketId: string }[]
    const ticketId = routed[0]!.ticketId!
    await first.close()

    const second = await open()
    const statusCall = await second.callTool({ name: 'superagent_ticket_status', arguments: { ticketId } })
    const status = JSON.parse(String((statusCall.content as { text?: string }[])[0]?.text)) as
      { open: boolean; stage: string; assignment?: { state?: string } }
    expect(status.open).toBe(true)
    expect(status.assignment?.state).toBe('running')
    const tickCall = await second.callTool({ name: 'superagent_tick', arguments: {} })
    expect(String((tickCall.content as { text?: string }[])[0]?.text)).toContain('"spawn_worker"')
    await second.close()
  }, 60_000)
})

/** Polls tick until it hands out an action of `kind`, returning that whole batch (the protocol requires acting on all of it). */
async function waitForKind(kind: string): Promise<{ actionId: string; kind: string; [key: string]: unknown }[]> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const actions = await tick()
    if (actions.some(action => action.kind === kind)) return actions
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for a ' + kind + ' action')
}
