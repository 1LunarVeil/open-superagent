/**
 * Daemon-layer tests: the durable hand-out queue, the ticket workspace, and restart reconciliation. These are the parts
 * that decide whether a real session can finish a ticket, so they are exercised against a real SQLite file and a real
 * temporary git repository rather than stubs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Actions, LEASE_MS } from '../src/daemon/actions.ts'
import { ZcodeExecutor } from '../src/daemon/executor.ts'
import { insideRoot, prepareWorkspace, PrepareFailed, releaseWorkspace } from '../src/daemon/sandbox.ts'
import { Store } from '../src/persist/store.ts'
import { Effects } from '../src/persist/effects.ts'
import { HealthBoard } from '../src/persist/health.ts'

let dir: string
let store: Store | undefined

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'open-superagent-daemon-')) })

afterEach(() => {
  try { store?.close() } catch { /* Already closed by the test. */ }
  store = undefined
  rmSync(dir, { recursive: true, force: true })
})

/** A git repository with one commit, so worktree creation has something to check out. */
function initRepo(): string {
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' } })
  }
  git('init', '--initial-branch=main')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  return repo
}

describe('Actions lease queue', () => {
  /** An Actions whose clock the test moves by hand. */
  function harness() {
    store = new Store(join(dir, 'actions.sqlite'))
    const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') }
    return { actions: new Actions(store, () => clock.now), clock }
  }

  const relay = { kind: 'relay' as const, text: 'worker ready', ticketId: 't1' }

  it('hands out a queued action once and keeps it leased to that reader', () => {
    const { actions } = harness()
    actions.add(relay, new Date().toISOString())
    const first = actions.take()
    expect(first).toHaveLength(1)
    expect(first[0]!.actionId).toBeTruthy()
    // A second tick inside the lease sees nothing, so one action is never acted on twice in a row.
    expect(actions.take()).toHaveLength(0)
  })

  it('hands the same action out again after its lease lapses, marked as a retry', () => {
    const { actions, clock } = harness()
    actions.add(relay, new Date().toISOString())
    const [first] = actions.take()
    clock.now += LEASE_MS + 1
    const [again] = actions.take()
    expect(again?.actionId).toBe(first!.actionId)
    expect(again?.retry).toBe(true)
  })

  it('retires an acknowledged action for good', () => {
    const { actions, clock } = harness()
    actions.add(relay, new Date().toISOString())
    const [first] = actions.take()
    expect(actions.ack([first!.actionId])).toBe(1)
    clock.now += LEASE_MS + 1
    expect(actions.take()).toHaveLength(0)
    expect(actions.count()).toBe(0)
  })

  it('ignores a repeated acknowledgement', () => {
    const { actions } = harness()
    actions.add(relay, new Date().toISOString())
    const [first] = actions.take()
    actions.ack([first!.actionId])
    expect(actions.ack([first!.actionId])).toBe(0)
  })

  it('deduplicates equal actions by content', () => {
    const { actions } = harness()
    actions.add(relay, new Date().toISOString())
    actions.add(relay, new Date().toISOString())
    expect(actions.take()).toHaveLength(1)
  })

  it('cancels a ticket\'s undelivered work but keeps notices', () => {
    const { actions } = harness()
    actions.add(relay, new Date().toISOString())
    actions.add({ kind: 'notice', summary: 'policy changed', value: {} }, new Date().toISOString())
    actions.cancelForTicket('t1')
    const handed = actions.take()
    expect(handed.map(action => action.kind)).toEqual(['notice'])
  })

  it('prunes delivered rows past the retention window', () => {
    const { actions, clock } = harness()
    const at = new Date(clock.now).toISOString()
    actions.add(relay, at)
    const [first] = actions.take()
    actions.ack([first!.actionId])
    // Still inside the retention window, so nothing is pruned yet.
    expect(actions.prune()).toBe(0)
    clock.now += 8 * 24 * 60 * 60_000
    expect(actions.prune()).toBe(1)
  })
})

describe('ticket workspace', () => {
  it('rejects a directory outside the work root and a traversal segment', () => {
    const root = join(dir, 'work')
    expect(insideRoot(join(root, 'ticket-1'), root)).toBe(true)
    expect(insideRoot(join(dir, 'elsewhere', 'ticket-1'), root)).toBe(false)
    expect(insideRoot(join(root, '..', 'escape'), root)).toBe(false)
    expect(insideRoot(root, root)).toBe(false)
  })

  it('creates a detached worktree of the project repository', async () => {
    const repo = initRepo()
    const root = join(dir, 'work')
    const directory = join(root, 'ticket-abcdef')
    const notes = await prepareWorkspace({ directory, workRoot: root, worktree: true, projectDir: repo, timeoutMs: 60_000 })
    expect(existsSync(join(directory, 'README.md'))).toBe(true)
    expect(notes.join(' ')).toContain('detached git worktree')
    // The worktree is registered with git, and its HEAD is detached rather than on a branch.
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(list).toContain(directory.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:'))
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
    expect(head).toBe('HEAD')
  })

  it('leaves an empty directory when worktrees are disabled or the project is not a repository', async () => {
    const root = join(dir, 'work')
    const plain = join(dir, 'plain')
    mkdirSync(plain, { recursive: true })
    const directory = join(root, 'ticket-plain')
    mkdirSync(directory, { recursive: true })
    const notes = await prepareWorkspace({ directory, workRoot: root, worktree: true, projectDir: plain, timeoutMs: 60_000 })
    expect(notes.join(' ')).toContain('not a git work tree')
    expect(readdirSync(directory)).toEqual([])
  })

  it('fails a ticket directory that escapes the work root instead of creating it', async () => {
    const root = join(dir, 'work')
    await expect(prepareWorkspace({ directory: join(dir, 'outside', 't'), workRoot: root, worktree: false, timeoutMs: 1_000 }))
      .rejects.toBeInstanceOf(PrepareFailed)
  })

  it('rejects a base ref that would be read as a git option or contain a traversal', async () => {
    const repo = initRepo()
    const root = join(dir, 'work')
    await expect(prepareWorkspace({ directory: join(root, 'ticket-ref'), workRoot: root, worktree: true, projectDir: repo, ref: '--upload-pack=evil', timeoutMs: 5_000 }))
      .rejects.toBeInstanceOf(PrepareFailed)
  })

  it('removes a clean worktree and keeps a dirty one', async () => {
    const repo = initRepo()
    const root = join(dir, 'work')
    const clean = join(root, 'ticket-clean')
    await prepareWorkspace({ directory: clean, workRoot: root, worktree: true, projectDir: repo, timeoutMs: 60_000 })
    await releaseWorkspace(clean, repo)
    expect(existsSync(clean)).toBe(false)

    const dirty = join(root, 'ticket-dirty')
    await prepareWorkspace({ directory: dirty, workRoot: root, worktree: true, projectDir: repo, timeoutMs: 60_000 })
    writeFileSync(join(dirty, 'untracked.txt'), 'work in progress\n')
    await releaseWorkspace(dirty, repo)
    expect(existsSync(join(dirty, 'untracked.txt'))).toBe(true)
  })
})

describe('executor reconciliation', () => {
  /**
   * A minimal domain stub: enough of the Store and Engine for `reconcile` to inspect tickets and report what it did.
   * The executor only reads tickets/actions/effects and calls `assignmentInterrupted`, so that contract is all it needs.
   */
  function harness(tickets: unknown[]) {
    store = new Store(join(dir, 'reconcile.sqlite'))
    const calls: string[] = []
    const enqueued: string[] = []
    const logs: string[] = []
    const effects = new Effects(store, new HealthBoard())
    const executor = new ZcodeExecutor()
    executor.install({
      effects: { enqueue: (kind, key) => { enqueued.push(kind + ':' + key) }, handle: () => undefined, pending: () => false },
      actions: new Actions(store),
      engine: {
        assignmentStarted: () => undefined,
        assignmentClaimed: () => undefined,
        workspacePrepared: () => undefined,
        inputsDelivered: () => undefined,
        inputsRead: () => undefined,
        turnEnded: () => undefined,
        report: () => { throw new Error('not used') },
        assignmentInterrupted: (ticketId: string) => { calls.push(ticketId) },
      },
      store: { get tickets() { return { active: () => tickets } } } as never,
      slots: () => 3,
      paused: () => false,
      workRoot: () => join(dir, 'work'),
      projectDir: () => undefined,
      worktree: () => false,
      prepareTimeoutMs: () => 1_000,
      baseRef: () => 'HEAD',
      log: message => logs.push(message),
    })
    return { executor, calls, enqueued, logs, effects }
  }

  const ticket = (overrides: Record<string, unknown>) => ({
    id: 't1', title: 'T', ended: undefined, assignments: [], inputs: [], undelivered: [], origin: { triggerId: 'x', triggerIds: ['x'] },
    mandate: {}, channels: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  })

  it('restarts an assignment the domain thinks runs but no queued spawn ever delivered', () => {
    const { executor, calls } = harness([ticket({ assignments: [{ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:00.000Z' }] })])
    executor.reconcile()
    expect(calls).toEqual(['t1'])
  })

  it('leaves a running assignment alone while its spawn is still queued', () => {
    const { executor, calls } = harness([ticket({ assignments: [{ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:00.000Z' }] })])
    // Queue the spawn the way a successful launch would, then reconcile.
    const actions = (executor as unknown as { deps: { actions: Actions } }).deps.actions
    actions.add({ kind: 'spawn_worker', ticketId: 't1', assignmentId: 'a1', title: 'T', prompt: 'p', directory: '/tmp/x' }, new Date().toISOString())
    executor.reconcile()
    expect(calls).toEqual([])
  })

  it('queues a pending launch again when the effect row is gone', () => {
    const { executor, enqueued } = harness([ticket({ assignments: [{ id: 'a2', state: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }] })])
    executor.reconcile()
    expect(enqueued).toEqual(['launch:a2'])
  })

  it('skips ended tickets and tickets without assignments', () => {
    const { executor, calls, enqueued } = harness([
      ticket({ ended: { at: '2026-01-02T00:00:00.000Z', by: 'person', outcome: 'completed' }, assignments: [{ id: 'a1', state: 'running' }] }),
      ticket({ id: 't2' }),
    ])
    executor.reconcile()
    expect(calls).toEqual([])
    expect(enqueued).toEqual([])
  })

  it('does not restart an assignment a worker already claimed', () => {
    // A claim is the only proof a worker exists. `reconcile` still hands the fact to the Engine, but the Engine must not
    // restart a claimed assignment: doing so would put a second worker into the same directory while the first edits it.
    const { executor, calls } = harness([ticket({
      assignments: [{ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:00.000Z', claimedAt: '2026-01-01T00:00:05.000Z' }],
    })])
    executor.reconcile()
    // The executor reports the interruption; the Engine's `interrupted` is what declines to restart a claimed assignment
    // (covered by the kernel suite). Here the contract is that the executor does not decide on its own to skip.
    expect(calls).toEqual(['t1'])
  })

  it('does not relaunch a pending assignment that already reported failed', () => {
    // The environment is what failed; relaunching repeats the same failure instead of waiting for the person to retry.
    const { executor, enqueued } = harness([ticket({
      assignments: [{ id: 'a3', state: 'pending', createdAt: '2026-01-01T00:00:00.000Z', report: { state: 'failed', summary: 'no git', at: '2026-01-01T00:00:01.000Z' } }],
    })])
    executor.reconcile()
    expect(enqueued).toEqual([])
  })
})
