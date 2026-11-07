/** Settings management: validated saves per block, policy versioning, and Engine notification. */
import { policyEffects, policyVersion, settingsPolicy, SettingsSchema, type Settings as SettingsValue, type SettingsOrigin, type SettingsSave } from '../kernel/policy.ts'
import { UserError } from '../kernel/errors.ts'
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
 * @param expectedRevision When given, the save is refused unless the block is still at that revision, so two writers
 *   cannot silently overwrite each other.
 * @throws UserError `revisionConflict` when `expectedRevision` no longer matches, and the zod error when the merged
 *   settings do not validate.
 */
  save(block: SettingsSave, value: unknown, origin: SettingsOrigin = 'panel', expectedRevision?: number): SettingsSaveResult {
    const current = this.store.blockRevision(block)
    if (expectedRevision !== undefined && expectedRevision !== current)
      throw new UserError('revisionConflict', { block, revision: String(expectedRevision) })
    const before = this.get()
    const merged = mergeBlock(before, block, value)
    const settings = SettingsSchema.parse(merged)
    const effects = policyEffects(this.store.tickets.open(), before, settings, this.scope)
    const from = policyVersion(before), to = policyVersion(settings)
    const changed = from !== to || Object.keys(effects).length > 0
    const saved = this.store.saveSettings(settings, { source: origin, block, policyVersion: to, policyChanged: changed, notified: [] })
    // Only a real policy change may cancel in-flight Evals. A pause or executor save leaves the policy version untouched,
    // and telling the Engine otherwise would record an `unavailable` decision for every candidate under assessment.
    if (changed) this.engine.policyChanged(from, to, effects)
    return { settings: saved, revision: saved ? this.store.blockRevision(block) : 0, policyVersion: to, policyChanged: changed }
  }
}

/** The named blocks that merge key by key rather than replacing wholesale. */
type NamedBlock = 'policy' | 'eval' | 'executor'

/**
 * Merges one settings block's value into `before`. A named block (`policy`, `eval`, `executor`) merges key by key, so a
 * caller that saves only `sources` keeps the rules it did not mention; `source:<id>` blocks replace their instance whole,
 * because a Source's config is one opaque object. Arrays always replace, never concatenate.
 */
export function mergeBlock(before: SettingsValue, block: SettingsSave, value: unknown): unknown {
  if (block === 'pause') return { ...before, paused: value !== false }
  if (block.startsWith('source:')) {
    const id = block.slice('source:'.length)
    return { ...before, sources: { ...before.sources, [id]: value } }
  }
  const named = block as NamedBlock
  const current: unknown = before[named]
  if (!isRecord(value) || !isRecord(current)) return { ...before, [named]: value }
  const merged = { ...current, ...value }
  // `policy.sources` is a map of per-Source policy: merge it one level further, so saving one Source's policy does not
  // drop every other Source's allowlist and admission table.
  if (named === 'policy' && isRecord(current.sources) && isRecord(value.sources)) merged.sources = { ...current.sources, ...value.sources }
  return { ...before, [named]: merged }
}

/** True for a plain object, the only shape a merged block may have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The Policy for the current settings, for tools that need gate decisions without the Engine. */
export function currentPolicy(store: Store, scope: ScopeFactory) {
  return settingsPolicy(store.settings(), scope(store.settings()))
}
