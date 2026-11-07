/** Settings management: validated saves per block, policy versioning, and Engine notification. */
import { policyEffects, policyVersion, settingsPolicy, SettingsSchema, type Settings as SettingsValue, type SettingsOrigin, type SettingsSave } from '../kernel/policy.ts'
import type { EngineForSettings } from '../kernel/index.ts'
import type { SourceScope } from '../kernel/index.ts'
import type { Store } from './store.ts'

/** Builds the SourceScope for a Settings; the Sources layer owns the per-Source rules. */
export type ScopeFactory = (settings: SettingsValue) => SourceScope

export interface SettingsSaveResult {
  settings: SettingsValue
  revision: number
  policyVersion: string
  policyChanged: boolean
}

/**
 * Reads and saves settings through the Store's versioned snapshots.
 * Every save parses the full resulting Settings, records the snapshot with its origin and block, tells the Engine how the
 * change bears on open tickets (`policyChanged` with per-ticket effects), and returns the new policy version.
 * Port note: upstream guards panel-only fields (executor environment, account CLIs) against tool-origin saves; v1 has a
 * single local operator, so every writer is trusted — the guard returns with the panel phase.
 */
export class Settings {
  constructor(private readonly store: Store, private readonly engine: EngineForSettings, private readonly scope: ScopeFactory) {}
  /** Current validated settings. */
  get(): SettingsValue { return this.store.settings() }
  revision(block: SettingsSave): number { return this.store.blockRevision(block) }
  history(limit = 20) { return this.store.settingsHistory(limit) }
  /** The policy version the current settings produce, without saving. */
  version(): string { return policyVersion(this.get()) }
  /**
   * Validate and save one settings block as the next revision, and tell the Engine of the change.
   * @throws the zod error when the merged settings do not validate.
   */
  save(block: SettingsSave, value: unknown, origin: SettingsOrigin = 'panel'): SettingsSaveResult {
    const before = this.get()
    const merged = mergeBlock(before, block, value)
    const settings = SettingsSchema.parse(merged)
    const effects = policyEffects(this.store.tickets.open(), before, settings, this.scope)
    const saved = this.store.saveSettings(settings, { source: origin, block, policyVersion: policyVersion(settings), policyChanged: Object.keys(effects).length > 0 || policyVersion(before) !== policyVersion(settings), notified: [] })
    this.engine.policyChanged(policyVersion(before), policyVersion(settings), effects)
    return { settings: saved, revision: saved ? this.store.blockRevision(block) : 0, policyVersion: policyVersion(settings), policyChanged: policyVersion(before) !== policyVersion(settings) }
  }
}

/** Merges one settings block's value into `before`, replacing `source:<id>` blocks wholesale. */
export function mergeBlock(before: SettingsValue, block: SettingsSave, value: unknown): unknown {
  if (block === 'pause') return { ...before, paused: value !== false }
  if (block.startsWith('source:')) {
    const id = block.slice('source:'.length)
    return { ...before, sources: { ...before.sources, [id]: value } }
  }
  return { ...before, [block]: value }
}

/** The Policy for the current settings, for tools that need gate decisions without the Engine. */
export function currentPolicy(store: Store, scope: ScopeFactory) {
  return settingsPolicy(store.settings(), scope(store.settings()))
}
