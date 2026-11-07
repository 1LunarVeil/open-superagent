/**
 * Persistence-layer tests against a real SQLite file: the pieces the kernel suite cannot reach because they need the
 * Store, and where the reliability bugs of a durable daemon actually live (lease recovery, effect coalescing, settings
 * merging, schema refusal).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Settings } from '../src/persist/settings.ts'
import { Store } from '../src/persist/store.ts'
import { UserError } from '../src/kernel/errors.ts'
import { Effects, Later } from '../src/persist/effects.ts'
import { HealthBoard } from '../src/persist/health.ts'
import { policyVersion } from '../src/kernel/policy.ts'
import type { EngineForSettings } from '../src/kernel/engine.ts'
import type { SourceScope } from '../src/kernel/ports.ts'

let dir: string
let store: Store

/** A SourceScope that listens to everything, which is what the daemon's manual Source does. */
const scope: SourceScope = { scope: () => ({ listened: true, observed: true, row: 'default' }) }

/** A stand-in for the Engine: records the policy-change notifications Settings hands it. */
function engineStub() {
  const changes: { from: string; to: string }[] = []
  const engine: Pick<EngineForSettings, 'policyChanged'> = {
    policyChanged: (from, to) => { changes.push({ from, to }) },
  }
  return { engine, changes }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'open-superagent-test-'))
  store = new Store(join(dir, 'test.sqlite'))
})

afterEach(() => {
  try { store?.close() } catch { /* The schema test leaves the store closed on purpose. */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('Store schema', () => {
  it('creates the whole schema on a fresh file and reports its version', () => {
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name))
    for (const table of ['trigger', 'disposition', 'thread', 'ticket', 'decision', 'outbox', 'trigger_thread', 'effect', 'kv']) {
      expect(tables).toContain(table)
    }
  })

  it('refuses a database written by another schema version instead of corrupting it', () => {
    store.db.prepare("UPDATE kv SET value = '10' WHERE key = 'schema'").run()
    const path = join(dir, 'test.sqlite')
    store.close()
    expect(() => new Store(path)).toThrow(/Unsupported open-superagent database version/)
    // The refused constructor closes its own handle; nothing to close here, and the file is removed by afterEach.
  })
})

describe('Settings', () => {
  it('merges a named block key by key so saving sources keeps the rules', () => {
    const { engine } = engineStub()
    const settings = new Settings(store, engine, () => scope)
    const before = settings.get()
    const saved = settings.save('policy', { sources: { manual: { allowed: [{ id: 'operator' }] } } }, 'tool')
    expect(saved.settings.policy.rules).toEqual(before.policy.rules)
    expect(saved.settings.policy.rules.length).toBeGreaterThan(0)
    expect(saved.settings.policy.sources.manual?.allowed).toEqual([{ id: 'operator' }])
  })

  it('replaces an array wholesale rather than concatenating it', () => {
    const { engine } = engineStub()
    const settings = new Settings(store, engine, () => scope)
    settings.save('policy', { rules: [{ id: 'only', name: 'Only', enabled: true, instruction: 'One rule.' }] }, 'tool')
    expect(settings.get().policy.rules.map(rule => rule.id)).toEqual(['only'])
  })

  it('refuses a save whose expected revision is stale', () => {
    const { engine } = engineStub()
    const settings = new Settings(store, engine, () => scope)
    const revision = settings.revision('pause')
    settings.save('pause', true, 'tool', revision)
    expect(() => settings.save('pause', false, 'tool', revision)).toThrow(UserError)
    try { settings.save('pause', false, 'tool', revision) } catch (error) { expect((error as UserError).code).toBe('revisionConflict') }
  })

  it('does not cancel in-flight work for a save that leaves the policy unchanged', () => {
    // Pause and executor settings are not part of the policy version. Notifying the Engine anyway would record an
    // `unavailable` decision for every candidate under assessment, silently discarding work.
    const { engine, changes } = engineStub()
    const settings = new Settings(store, engine, () => scope)
    const paused = settings.save('pause', true, 'tool')
    expect(paused.policyChanged).toBe(false)
    expect(changes).toEqual([])
    const executor = settings.save('executor', { maxWorkers: 2 }, 'tool')
    expect(executor.policyChanged).toBe(false)
    expect(changes).toEqual([])
  })

  it('notifies the Engine when the policy itself changes', () => {
    const { engine, changes } = engineStub()
    const settings = new Settings(store, engine, () => scope)
    const saved = settings.save('policy', { rules: [{ id: 'only', name: 'Only', enabled: true, instruction: 'One rule.' }] }, 'tool')
    expect(saved.policyChanged).toBe(true)
    expect(changes.length).toBe(1)
    expect(changes[0]!.to).toBe(policyVersion(settings.get()))
  })

  it('merges policy.sources one level deeper so one Source save keeps the others', () => {
    const { engine } = engineStub()
    const settings = new Settings(store, engine, () => scope)
    settings.save('policy', { sources: { manual: { allowed: [{ id: 'a' }] }, other: { allowed: [{ id: 'b' }] } } }, 'tool')
    // Saving only `manual` must not drop `other`.
    settings.save('policy', { sources: { manual: { allowed: [{ id: 'c' }] } } }, 'tool')
    const sources = settings.get().policy.sources
    expect(sources.manual?.allowed).toEqual([{ id: 'c' }])
    expect(sources.other?.allowed).toEqual([{ id: 'b' }])
  })

  it('keeps a history of saved revisions', () => {
    const { engine } = engineStub()
    const settings = new Settings(store, engine, () => scope)
    settings.save('pause', true, 'tool')
    settings.save('pause', false, 'tool')
    expect(settings.history(10).length).toBeGreaterThanOrEqual(2)
    expect(settings.history(10)[0]!.revision).toBeGreaterThan(settings.history(10)[1]!.revision)
  })
})

describe('Effects', () => {
  /** An Effects whose clock the test moves by hand, so backoff is observable without waiting. */
  function effectsHarness() {
    const clock = { now: 1_000_000 }
    const board = new HealthBoard()
    const effects = new Effects(store, board, () => clock.now)
    return { effects, board, clock }
  }

  it('coalesces an enqueue on the same kind and key, keeping one row', () => {
    const { effects } = effectsHarness()
    effects.enqueue('launch', 'a1', { ticketId: 't1', assignmentId: 'a1' })
    effects.enqueue('launch', 'a1', { ticketId: 't2', assignmentId: 'a1' })
    expect(effects.pending('launch')).toBe(true)
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM effect WHERE kind = ?').get('launch')
    expect(Number(rows?.n)).toBe(1)
  })

  it('reschedules a Later without counting a failure', async () => {
    const { effects, clock } = effectsHarness()
    let attempts = 0
    effects.handle('delivery', async () => {
      attempts += 1
      if (attempts === 1) throw new Later('busy')
    }, { retry: [5_000, 60_000] })
    effects.enqueue('delivery', 't1', { ticketId: 't1', assignmentId: 'a1' })
    effects.start()
    await effects.idle('delivery')
    const row = store.db.prepare("SELECT attempts, due FROM effect WHERE kind = 'delivery'").get()
    expect(Number(row?.attempts)).toBe(0)
    expect(Number(row?.due)).toBe(clock.now + 5_000)
    // Once the clock passes the retry delay the effect runs again.
    clock.now += 5_001
    await effects.idle('delivery')
    expect(attempts).toBe(2)
    expect(effects.pending('delivery')).toBe(false)
  })

  it('backs off exponentially on a real failure and marks the kind as error', async () => {
    const { effects, board, clock } = effectsHarness()
    effects.handle('reply', async () => { throw new Error('boom') }, { retry: [1_000, 8_000] })
    effects.enqueue('reply', 'm1', {} as never)
    effects.start()
    await effects.idle('reply')
    let row = store.db.prepare("SELECT attempts, due, error FROM effect WHERE kind = 'reply'").get()
    expect(Number(row?.attempts)).toBe(1)
    expect(Number(row?.due)).toBe(clock.now + 1_000)
    expect(String(row?.error)).toContain('boom')
    clock.now = Number(row?.due)
    await effects.idle('reply')
    row = store.db.prepare("SELECT attempts, due FROM effect WHERE kind = 'reply'").get()
    expect(Number(row?.attempts)).toBe(2)
    expect(Number(row?.due)).toBe(clock.now + 2_000)
    clock.now = Number(row?.due)
    await effects.idle('reply')
    expect(board.all.reply?.state).toBe('error')
  })

  it('keeps the newest payload when a row is replaced while its first attempt ran', async () => {
    const { effects } = effectsHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const seen: string[] = []
    effects.handle('relay', async payload => {
      seen.push((payload as unknown as { text: string }).text)
      if (seen.length === 1) await gate
    }, { ordered: true, retry: [1_000, 1_000] })
    effects.enqueue('relay', 'r1', { text: 'first' })
    effects.start()
    await Promise.resolve()
    // Replace the payload while the first attempt is still running; the generation changes.
    effects.enqueue('relay', 'r1', { text: 'second' })
    release()
    await effects.idle('relay')
    // The stale attempt must not delete the newer payload, so the retry runs with 'second' and only then retires the row.
    expect(seen).toEqual(['first', 'second'])
    expect(effects.pending('relay')).toBe(false)
  })

  it('runs one ordered effect at a time and holds later rows behind a failure', async () => {
    const { effects, clock } = effectsHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ran: string[] = []
    effects.handle('reply', async payload => {
      const text = (payload as unknown as { text: string }).text
      ran.push(text)
      if (text === 'first') { await gate; throw new Error('stuck') }
    }, { ordered: true, retry: [1_000, 1_000] })
    effects.enqueue('reply', 'a', { text: 'first' } as never)
    effects.enqueue('reply', 'b', { text: 'second' } as never)
    effects.start()
    await Promise.resolve()
    expect(ran).toEqual(['first'])
    release()
    await effects.idle('reply')
    expect(ran).toEqual(['first'])
    // While the first row is failing, the second never starts.
    clock.now += 1_001
    await effects.idle('reply')
    expect(ran).toEqual(['first', 'first'])
  })
})
