/**
 * Composition root and lifecycle owner of the open-superagent daemon: it locks the state directory, opens the Store, and
 * wires Engine, Sources scope, Assessor, Executor, Outbox, Settings, Actions, Effects, and Passes. Port note: upstream
 * locks its state directory the same way before opening SQLite, so concurrent processes cannot corrupt or double-migrate
 * state. Wiring is two-phase — `open` builds the storage parts, `initialize` builds the Engine and installs its ports —
 * because the Assessor, Executor, and Outbox all register their effect handlers on an Effects that must exist first, while
 * the Engine that calls those ports needs them in hand at its own construction.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { Engine } from '../kernel/index.ts'
import type { ScopeResult, SourceScope } from '../kernel/index.ts'
import { settingsPolicy } from '../kernel/policy.ts'
import { Actions } from './actions.ts'
import { MasterAssessor } from './assessor.ts'
import { ZcodeExecutor } from './executor.ts'
import { HealthBoard } from '../persist/health.ts'
import type { Health } from '../persist/health.ts'
import { Effects } from '../persist/effects.ts'
import { Outbox } from '../persist/outbox.ts'
import type { ReplySenders } from '../persist/outbox.ts'
import { Passes } from '../persist/passes.ts'
import { Settings } from '../persist/settings.ts'
import { Store } from '../persist/store.ts'

/** Options for `Runtime.open`. */
export interface RuntimeOptions { stateDir: string }

/** The state directory is held by another daemon instance; the entry point exits with code 3. */
export class StateLocked extends Error {
  constructor() { super('open-superagent state directory is locked by another daemon instance') }
}

/** Parts built by `open` before the Runtime exists, assigned as readonly fields in its constructor. */
interface StorageParts {
  stateDir: string
  store: Store
  board: HealthBoard
  effects: Effects
  actions: Actions
  release: () => Promise<void>
}

export class Runtime {
  readonly stateDir: string
  readonly store: Store
  readonly effects: Effects
  readonly actions: Actions
  private readonly board: HealthBoard
  private readonly releaseLock?: () => Promise<void>
  private readonly stopped = new AbortController()
  private stoppingFlag = false
  private stopPromise?: Promise<void>
  /** Built by `initialize`, which runs before any Engine command or MCP tool can run. */
  engine!: Engine
  settings!: Settings
  private assessor!: MasterAssessor
  private executor!: ZcodeExecutor
  private outbox!: Outbox
  private passesRef?: Passes

  private constructor(parts: StorageParts) {
    this.stateDir = parts.stateDir
    this.store = parts.store
    this.board = parts.board
    this.effects = parts.effects
    this.actions = parts.actions
    this.releaseLock = parts.release
  }

  /**
   * Creates the runtime: makes the state directory private to the user, locks it against a second daemon, and opens the
   * SQLite Store. The lock has no periodic `update` refresh here — the type has no `null` for it and omitting it behaves
   * the same, refreshing at half the stale interval while this process lives.
   * @throws StateLocked when another daemon instance holds the state directory.
   */
  static async open(options: RuntimeOptions): Promise<Runtime> {
    const { stateDir } = options
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    let release: (() => Promise<void>) | undefined
    try {
      release = await lock(stateDir, { stale: 30_000, realpath: false })
    } catch {
      throw new StateLocked()
    }
    try {
      const store = new Store(join(stateDir, 'open-superagent.sqlite'), error => {
        process.stderr.write('open-superagent: ' + String(error) + '\n')
      })
      const board = new HealthBoard()
      const effects = new Effects(store, board)
      const actions = new Actions(store)
      return new Runtime({ stateDir, store, board, effects, actions, release })
    } catch (error) {
      // Release the lock so a later attempt in another process can take it.
      await release().catch(() => {})
      throw error
    }
  }

  /** Wires the domain and its ports; called once, before the MCP server connects and before `passes.start()`. */
  async initialize(): Promise<void> {
    const assessor = this.assessor = new MasterAssessor()
    const executor = this.executor = new ZcodeExecutor()
    const outbox = this.outbox = new Outbox({
      store: this.store,
      effects: this.effects,
      sources: this.manualSenders(),
      paused: () => this.settingsRef()?.get().paused ?? false,
    })
    // The v1 Sources scope: one manual Source that listens to and observes everything.
    const scope: SourceScope = { scope: input => this.scopeFor(input) }
    const engine = this.engine = new Engine({
      repo: this.store,
      scope,
      // Lazy because Settings is built after the Engine; until then the Store's current settings are the same value.
      policy: () => settingsPolicy(this.settingsRef()?.get() ?? this.store.settings(), scope),
      assessor,
      executor,
      outbox,
    })
    const settings = this.settings = new Settings(this.store, engine, () => scope)
    assessor.install({
      effects: this.effects,
      actions: this.actions,
      engine,
      store: this.store,
      paused: () => settings.get().paused,
    })
    executor.install({
      effects: this.effects,
      actions: this.actions,
      engine,
      store: this.store,
      slots: () => settings.get().executor.maxWorkers,
      paused: () => settings.get().paused,
      workRoot: () => settings.get().executor.directory || join(this.stateDir, 'work'),
    })
    this.passesRef = new Passes({
      engine,
      effects: this.effects,
      health: this.board.claim('runtime', { state: 'starting', detail: 'Opening state' }),
      lifetime: this.stopped.signal,
      configured: () => true,
      closing: () => this.stoppingFlag,
    })
    // Effects dispatch only between start and drain, so rows queued by an earlier run wait until now; passes themselves
    // start later, once the MCP server is connected (the entry point calls `passes.start()`).
    this.effects.start()
  }

  /** The orchestration passes; the daemon starts them once the MCP server is connected. */
  get passes(): Passes {
    if (!this.passesRef) throw new Error('The runtime is not initialized')
    return this.passesRef
  }

  /** All health entries, for status and health tools. */
  healthSnapshot(): Readonly<Record<string, Health>> { return this.board.all }

  /** Idempotent stop; concurrent or repeated calls share one shutdown. */
  stop(): Promise<void> {
    this.stoppingFlag = true
    return this.stopPromise ??= this.shutdown()
  }

  /** Stops the passes, drains the effect queue, then closes the Store before releasing the lock, so another process cannot open the database mid-write. */
  private async shutdown(): Promise<void> {
    await this.passesRef?.stop()
    try {
      await this.effects.drain()
    } finally {
      try { this.store.close() } finally {
        try { await this.releaseLock?.() } finally { this.stopped.abort() }
      }
    }
  }

  /** The Settings instance, once built; the Engine's policy reads it lazily because Settings is wired after the Engine. */
  private settingsRef(): Settings | undefined { return this.settings }

  /**
   * The v1 manual Source scope: every trigger is listened to and observed, and the receiving scope row is the
   * conversation key from the trigger's `meta.threadId` (or the default row when a Source sends none).
   */
  private scopeFor(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    return { listened: true, observed: true, row: String(input.meta?.threadId ?? 'default') }
  }

  /**
   * The manual ReplySenders for the Outbox: v1 has no channel adapters, so `instance` knows only the manual Source, every
   * channel is allowed, and a send is recorded as a `reply_recorded` action the orchestrator acts on from its tick.
   */
  private manualSenders(): ReplySenders {
    return {
      instance: source => source === 'manual' ? { enabled: true } : undefined,
      channelAllowed: () => true,
      send: async receipt => {
        this.store.atomic(() => this.actions.add({
          kind: 'reply_recorded',
          messageId: receipt.id,
          channel: receipt.channel,
          text: receipt.text,
          messageKind: receipt.kind,
          ...(receipt.ticketId !== undefined ? { ticketId: receipt.ticketId } : {}),
        }, new Date().toISOString()))
        return 'sent'
      },
    }
  }
}
