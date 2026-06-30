// Per-repo configuration (workspace-config): presets, new-workspace defaults,
// and integration surface. Keyed by repo root and persisted via the store
// (localStorage["aurora.repoconfig"]).
//
// Presets start empty for a new repo — the user defines their own. Existing
// presets are preserved losslessly on migration (no re-seeding, no filtering by
// name).

import { useStore } from "../state/store";
import { type BranchNamingConfig, DEFAULT_BRANCH_NAMING } from "./branchNaming";

export type PaneLayout = "1" | "2-split" | "2x2";

export interface Preset {
  id: string;
  name: string;
  /** Jira issue types this preset auto-selects for (e.g. ["Bug"]). */
  issueTypes: string[];
  paneLayout: PaneLayout;
  runOnOpen: string | null;
  /** Environment variables exported into the workspace's panes. */
  env: Record<string, string>;
  /** null = inherit defaults.baseBranch. */
  baseOverride: string | null;
  /** "auto" = a distinct offset per workspace; a number = fixed. Exposed to panes as $AURORA_PORT_OFFSET. */
  portOffset: "auto" | number;
  jiraSync: boolean;
}

/** Bumped when the persisted shape changes; triggers a one-time migration. */
export const CONFIG_VERSION = 6;

export interface RepoConfig {
  /** Schema version of the persisted config (absent on pre-v2 data). */
  version?: number;
  root: string;
  presets: Preset[];
  defaults: {
    branchNaming: BranchNamingConfig;
    baseBranch: string;
    showRailOnLaunch: boolean;
    jiraSyncDefault: boolean;
    /** Which pooled AI account this repo uses by default (null = terminal key). Inert
     *  until multi-account AI is wired up (DEFER). */
    aiDefaultId: string | null;
  };
  integrations: {
    /** Which pooled Jira connection this repo is bound to (null = none). */
    jiraConnectionId: string | null;
    jiraProjectKey: string;
    /** Target status names for two-way sync (workflows vary per project). */
    jiraInProgress: string;
    jiraDone: string;
  };
}

/** Layout → pane count + split, for stamping a preset onto a new workspace. */
export function layoutToPanes(layout: PaneLayout): { paneCount: number; split?: "h" | "v" } {
  if (layout === "2-split") return { paneCount: 2, split: "h" };
  if (layout === "2x2") return { paneCount: 4, split: "h" };
  return { paneCount: 1 };
}

export function defaultRepoConfig(root: string): RepoConfig {
  return {
    version: CONFIG_VERSION,
    root,
    presets: [],
    defaults: {
      branchNaming: DEFAULT_BRANCH_NAMING,
      baseBranch: "main",
      showRailOnLaunch: true,
      jiraSyncDefault: false,
      aiDefaultId: null,
    },
    integrations: { jiraConnectionId: null, jiraProjectKey: "", jiraInProgress: "In Progress", jiraDone: "Done" },
  };
}

export const REPO_CONFIG_KEY = "aurora.repoconfig";

/**
 * One-time migration of a persisted config to the current CONFIG_VERSION.
 *
 * v6 removes: `defaults.basePort` (the base-port knob, superseded by the
 * per-workspace `$AURORA_PORT_OFFSET` convention). All other fields —
 * including all user presets — are preserved losslessly.
 *
 * v5 removed: `agent`/`autoStart` from each preset; `defaults.autoPortOffset`,
 * `defaults.isolation`, and the top-level `lifecycle` object.
 *
 * Old stored data carries these legacy fields — we access them via intersection
 * types so we can strip them without resorting to `any`.
 *
 * Idempotent via the version gate (version === CONFIG_VERSION → no-op).
 */
export function migrate(cfg: RepoConfig): RepoConfig {
  if (cfg.version === CONFIG_VERSION) return cfg;

  // Legacy preset shape (v1–v4 stored data may carry `agent` and `autoStart`).
  type LegacyPreset = {
    id: string;
    name: string;
    issueTypes?: string[];
    agent?: unknown;
    autoStart?: unknown;
    paneLayout?: PaneLayout;
    runOnOpen?: string | null;
    env?: Record<string, string>;
    baseOverride?: string | null;
    portOffset?: "auto" | number;
    jiraSync?: boolean;
  };

  const presets: Preset[] = ((cfg.presets ?? []) as unknown as LegacyPreset[])
    .map(({ agent: _a, autoStart: _as, ...p }) => ({
      id: p.id,
      name: p.name,
      issueTypes: p.issueTypes ?? [],
      paneLayout: p.paneLayout ?? "1",
      runOnOpen: p.runOnOpen ?? null,
      env: p.env ?? {},
      baseOverride: p.baseOverride ?? null,
      portOffset: p.portOffset ?? "auto",
      jiraSync: p.jiraSync ?? false,
    }));

  // Legacy defaults shape (v1–v5 may carry `autoPortOffset`, `isolation`, and `basePort`).
  type LegacyDefaults = Partial<RepoConfig["defaults"]> & {
    autoPortOffset?: unknown;
    isolation?: unknown;
    basePort?: unknown;
  };
  const { autoPortOffset: _apo, isolation: _iso, basePort: _bp, ...keptDef } = (cfg.defaults ?? {}) as LegacyDefaults;
  const defaults: RepoConfig["defaults"] = {
    branchNaming: keptDef.branchNaming ?? DEFAULT_BRANCH_NAMING,
    baseBranch: keptDef.baseBranch ?? "main",
    showRailOnLaunch: keptDef.showRailOnLaunch ?? true,
    jiraSyncDefault: keptDef.jiraSyncDefault ?? false,
    aiDefaultId: keptDef.aiDefaultId ?? null,
  };

  const integrations = {
    ...cfg.integrations,
    jiraConnectionId: cfg.integrations?.jiraConnectionId ?? null,
    jiraProjectKey: cfg.integrations?.jiraProjectKey ?? "",
    jiraInProgress: cfg.integrations?.jiraInProgress ?? "In Progress",
    jiraDone: cfg.integrations?.jiraDone ?? "Done",
  };

  // Rebuild from scratch so legacy top-level keys (lifecycle, aiAccounts) are
  // absent from the returned object.
  return { version: CONFIG_VERSION, root: cfg.root, presets, defaults, integrations };
}

/** Load all persisted repo configs from localStorage, migrating + re-persisting old data. */
export function loadRepoConfigs(): Record<string, RepoConfig> {
  try {
    const raw = localStorage.getItem(REPO_CONFIG_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, RepoConfig>) : {};
    let changed = false;
    const out: Record<string, RepoConfig> = {};
    for (const [root, cfg] of Object.entries(parsed)) {
      const next = migrate(cfg);
      if (next !== cfg) changed = true;
      out[root] = next;
    }
    if (changed) {
      try {
        localStorage.setItem(REPO_CONFIG_KEY, JSON.stringify(out));
      } catch {
        /* ignore */
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The config for a repo, or a fresh (empty) default when none is saved yet.
 * Read-only — does not persist (call `saveRepoConfig` to persist).
 */
export function getRepoConfig(root: string | null): RepoConfig {
  if (!root) return defaultRepoConfig(root ?? "");
  return useStore.getState().repoConfigs[root] ?? defaultRepoConfig(root);
}

/** Persist a repo config (writes through the store + localStorage). */
export function saveRepoConfig(cfg: RepoConfig): void {
  useStore.getState().setRepoConfig(cfg.root, cfg);
}

/** Mutate a repo's config in place (seeds a default first if unsaved). */
export function updateRepoConfig(root: string, fn: (c: RepoConfig) => void): void {
  const next: RepoConfig = JSON.parse(JSON.stringify(getRepoConfig(root)));
  fn(next);
  next.root = root;
  saveRepoConfig(next);
}

/** True when the repo has saved config (i.e. settings have been opened/edited). */
export function hasSavedConfig(root: string | null): boolean {
  return !!root && !!useStore.getState().repoConfigs[root];
}
