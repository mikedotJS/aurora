// Wires `aurora.json` (+ legacy fallback) into the store as the resolved,
// cached source of truth for setup/run/archive scripts (managed-server-lifecycle
// task 1.3). File IO is async; callers needing a synchronous read use
// `getCachedAuroraConfig`, which returns `defaultAuroraConfig()` until the
// load kicked off by `ensureAuroraConfigLoaded` resolves and populates the
// store's `auroraConfigs` cache.
//
// Precedence (see lib/auroraConfig.ts `resolveConfigSource`): a committed
// `aurora.json` always wins; otherwise a NON-PERSISTED migration candidate
// built from legacy `userScripts`/onEnter (lib/scriptsMigration.ts) is used so
// existing scripts keep working as managed run scripts immediately — nothing
// is written to disk until the user explicitly accepts via
// `acceptAuroraMigration` (task 6.2: never overwrite silently).

import { useStore } from "../state/store";
import {
  loadAuroraConfig,
  saveAuroraConfig,
  defaultAuroraConfig,
  resolveConfigSource,
  type AuroraConfig,
  type ConfigSource,
} from "./auroraConfig";
import { repoScriptsToAuroraConfig } from "./scriptsMigration";
import { requestConfigWatch } from "./configWatch";

const inFlight = new Map<string, Promise<AuroraConfig>>();
/** The source the cached config for a root last resolved from — used to offer
 *  the migration banner only when there's legacy data and no committed file. */
const sourceByRoot = new Map<string, ConfigSource>();

/** Best-known config for `root` without awaiting IO. */
export function getCachedAuroraConfig(root: string | null): AuroraConfig {
  if (!root) return defaultAuroraConfig();
  return useStore.getState().auroraConfigs[root] ?? defaultAuroraConfig();
}

/** Whether `root`'s cached config came from legacy data with no committed
 *  `aurora.json` on disk — the migration-offer condition (task 6.2). False
 *  before the load resolves. */
export function isUnmigrated(root: string | null): boolean {
  if (!root) return false;
  return sourceByRoot.get(root) === "legacy";
}

/**
 * Load (once) the resolved config for `root` and cache it in the store.
 * Concurrent callers for the same root share one in-flight load.
 */
export function ensureAuroraConfigLoaded(root: string | null): Promise<AuroraConfig> {
  if (!root) return Promise.resolve(defaultAuroraConfig());
  // Watch this root's aurora.json so a later on-disk edit re-reads without a relaunch. Called on
  // every load (including cache hits) but deduped in requestConfigWatch, so a root first loaded
  // before the watcher was reachable still gets registered. Fire-and-forget — never blocks the load.
  requestConfigWatch(root);
  const cached = useStore.getState().auroraConfigs[root];
  if (cached) return Promise.resolve(cached);
  const existing = inFlight.get(root);
  if (existing) return existing;

  const p = (async () => {
    const { config: committed } = await loadAuroraConfig(root);
    const legacy = committed ? null : repoScriptsToAuroraConfig(useStore.getState().userScripts[root]);
    const { config, source } = resolveConfigSource(committed, legacy);
    sourceByRoot.set(root, source);
    useStore.getState().setAuroraConfig(root, config);
    inFlight.delete(root);
    return config;
  })();
  inFlight.set(root, p);
  return p;
}

/** Drop the cached entry so the next `ensureAuroraConfigLoaded` re-reads disk
 *  (e.g. after the script-editing UI writes `aurora.json`). */
export function invalidateAuroraConfig(root: string): void {
  useStore.setState((s) => {
    if (!(root in s.auroraConfigs)) return {};
    const next = { ...s.auroraConfigs };
    delete next[root];
    return { auroraConfigs: next };
  });
  sourceByRoot.delete(root);
}

/** Write `config` to `root`'s `aurora.json`, cache it, and mark the source
 *  "committed" — the shared postcondition for both accepting a migration
 *  offer as-is and explicitly saving from the scripts editor (task 5.4). */
async function commitAuroraConfig(root: string, config: AuroraConfig): Promise<void> {
  await saveAuroraConfig(root, config);
  sourceByRoot.set(root, "committed");
  useStore.getState().setAuroraConfig(root, config);
}

/**
 * Accept the migration offer for `root`: write the currently-cached
 * (legacy-derived) config to `aurora.json` as-is, then mark it committed.
 * Non-destructive by construction — this only ever runs when `isUnmigrated`
 * is true, i.e. no committed file exists yet (task 6.2).
 */
export async function acceptAuroraMigration(root: string): Promise<void> {
  await commitAuroraConfig(root, getCachedAuroraConfig(root));
}

/**
 * Save an explicitly-edited config from the scripts editor UI (task 5.4).
 * Same commit semantics as `acceptAuroraMigration` but takes the caller's
 * draft instead of the cache — a repo with only legacy scripts (no committed
 * file yet) editing+saving here IS how migration happens from that surface,
 * same non-destructive "write exactly what the user asked for" contract.
 */
export async function saveAuroraConfigEdit(root: string, config: AuroraConfig): Promise<void> {
  await commitAuroraConfig(root, config);
}

/**
 * Load `root`'s config and, if it has legacy scripts but no committed
 * `aurora.json` and hasn't been dismissed this session, surface the
 * migration-offer banner (task 6.2 — "on repo open", not just inside the
 * Scripts panel). Fire-and-forget from repo-add/repo-adopt call sites.
 */
export async function checkMigrationOffer(root: string): Promise<void> {
  await ensureAuroraConfigLoaded(root);
  const st = useStore.getState();
  if (isUnmigrated(root) && !st.dismissedMigrationRepos.includes(root)) {
    st.setMigrationBannerRepo(root);
  }
}
