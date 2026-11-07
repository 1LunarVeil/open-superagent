/** Settings management: validated saves per block, policy versioning, and Engine notification. */
import { type Settings as SettingsValue, type SettingsOrigin, type SettingsSave } from '../kernel/policy.ts';
import type { EngineForSettings } from '../kernel/index.ts';
import type { SourceScope } from '../kernel/index.ts';
import type { Store } from './store.ts';
/** Builds the SourceScope for a Settings; the Sources layer owns the per-Source rules. */
export type ScopeFactory = (settings: SettingsValue) => SourceScope;
export interface SettingsSaveResult {
    settings: SettingsValue;
    revision: number;
    policyVersion: string;
    policyChanged: boolean;
}
/**
 * Reads and saves settings through the Store's versioned snapshots.
 * Every save parses the full resulting Settings, records the snapshot with its origin and block, tells the Engine how the
 * change bears on open tickets (`policyChanged` with per-ticket effects), and returns the new policy version.
 * Port note: upstream guards panel-only fields (executor environment, account CLIs) against tool-origin saves; v1 has a
 * single local operator, so every writer is trusted — the guard returns with the panel phase.
 */
export declare class Settings {
    private readonly store;
    private readonly engine;
    private readonly scope;
    constructor(store: Store, engine: EngineForSettings, scope: ScopeFactory);
    /** Current validated settings. */
    get(): SettingsValue;
    revision(block: SettingsSave): number;
    history(limit?: number): import("./store.ts").SettingsVersion[];
    /** The policy version the current settings produce, without saving. */
    version(): string;
    /**
     * Validate and save one settings block as the next revision, and tell the Engine of the change.
     * @param expectedRevision When given, the save is refused unless the block is still at that revision, so two writers
     *   cannot silently overwrite each other.
     * @throws UserError `revisionConflict` when `expectedRevision` no longer matches, and the zod error when the merged
     *   settings do not validate.
     */
    save(block: SettingsSave, value: unknown, origin?: SettingsOrigin, expectedRevision?: number): SettingsSaveResult;
}
/**
 * Merges one settings block's value into `before`. A named block (`policy`, `eval`, `executor`) merges key by key, so a
 * caller that saves only `sources` keeps the rules it did not mention; `source:<id>` blocks replace their instance whole,
 * because a Source's config is one opaque object. Arrays always replace, never concatenate.
 */
export declare function mergeBlock(before: SettingsValue, block: SettingsSave, value: unknown): unknown;
/** The Policy for the current settings, for tools that need gate decisions without the Engine. */
export declare function currentPolicy(store: Store, scope: ScopeFactory): import("../kernel/ports.ts").Policy;
