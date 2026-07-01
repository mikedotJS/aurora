/// <reference types="bun-types" />
/**
 * Smoke-test: config migration up to the current CONFIG_VERSION.
 *
 * Tasks: 8.3 (cut-dead-workspace-surface) + workspace-port-isolation.
 *
 * What is tested:
 *  - All dead keys (lifecycle, defaults.autoPortOffset, defaults.isolation,
 *    defaults.basePort, preset.agent, preset.autoStart) are stripped.
 *  - All kept keys (baseBranch, branchNaming, showRailOnLaunch,
 *    jiraSyncDefault, aiDefaultId, root, integrations, preset fields) are
 *    preserved losslessly.
 *  - version is bumped to CONFIG_VERSION.
 *  - All presets are preserved (lossless — no filtering by name).
 *  - migrate() is idempotent: a second call is a no-op (same reference).
 *  - Missing optional fields fall back to sensible defaults (no crash).
 */

import { mock, describe, it, expect } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────
// Must be called before any dynamic import. The preload (test/setup.ts) already
// stubs every Tauri/xterm module, so only the STORE needs a per-file override
// here (repoConfig.ts imports it, but migrate() itself never touches it — mock
// it to short-circuit the full store+workspace+Tauri load).
// Path resolves to /…/aurora/src/state/store.ts (same resolution as the
// relative import "../state/store" inside src/lib/repoConfig.ts).
//
// bun test automatically un-registers a file's own mock.module() calls once
// that file's tests finish (verified empirically — no manual mock.restore()
// needed, and calling it here would double-pop bun's internal mock stack and
// corrupt state for later real-store files).
mock.module("../src/state/store", () => ({
  useStore: {
    getState: () => ({ repoConfigs: {}, setRepoConfig: () => {} }),
  },
}));

// ── Load the module under test ────────────────────────────────────────────────
// Double-cast required: the dynamic import is `unknown` to tsc, and the input
// type is intentionally widened to accept pre-migration shapes (extra keys like
// `lifecycle` that are not in the current RepoConfig interface).
const { migrate, CONFIG_VERSION } = (await import("../src/lib/repoConfig.ts")) as unknown as {
  migrate: (cfg: Record<string, unknown>) => Record<string, unknown>;
  CONFIG_VERSION: number;
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BRANCH_NAMING_KEPT = { source: "manual", template: "{key}/{slug}" };

/** A realistic v4 config carrying all the dead keys plus all kept keys. */
function makeV4Config() {
  return {
    version: 4,
    root: "/repo/aurora",
    presets: [
      // user-defined preset — should survive
      {
        id: "p-custom",
        name: "my-custom",
        agent: "claude",      // DEAD — must be stripped
        autoStart: true,      // DEAD — must be stripped
        issueTypes: ["Bug"],
        paneLayout: "2-split",
        runOnOpen: "bun dev",
        env: { PORT: "3000" },
        baseOverride: "develop",
        portOffset: 8000,
        jiraSync: true,
      },
      // previously-seeded presets — must be PRESERVED by migrate() (lossless)
      { id: "s-fix",     name: "fix",     issueTypes: [], paneLayout: "1",  runOnOpen: null, env: {}, baseOverride: null, portOffset: "auto", jiraSync: false },
      { id: "s-feature", name: "feature", issueTypes: [], paneLayout: "1",  runOnOpen: null, env: {}, baseOverride: null, portOffset: "auto", jiraSync: false },
      { id: "s-spike",   name: "spike",   issueTypes: [], paneLayout: "1",  runOnOpen: null, env: {}, baseOverride: null, portOffset: "auto", jiraSync: false },
    ],
    defaults: {
      branchNaming: BRANCH_NAMING_KEPT,
      baseBranch: "develop",
      showRailOnLaunch: false,
      jiraSyncDefault: true,
      aiDefaultId: "account-xyz",
      basePort: 4200,
      autoPortOffset: true,   // DEAD — must be stripped
      isolation: "container", // DEAD — must be stripped
    },
    // Top-level lifecycle object — DEAD — must be absent from output
    lifecycle: {
      pruneWorktreeOnMerge: true,
      closeAction: "close",
    },
    integrations: {
      jiraConnectionId: "jira-conn-1",
      jiraProjectKey: "PROJ",
      jiraInProgress: "In Progress",
      jiraDone: "Done",
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("migrate() — v4 → current", () => {
  it("bumps version to CONFIG_VERSION (6)", () => {
    const result = migrate(makeV4Config());
    expect(result.version).toBe(CONFIG_VERSION);
    expect(CONFIG_VERSION).toBe(6);
  });

  it("strips dead key: lifecycle (top-level)", () => {
    const result = migrate(makeV4Config());
    expect("lifecycle" in result).toBe(false);
  });

  it("strips dead key: defaults.autoPortOffset", () => {
    const result = migrate(makeV4Config());
    const defaults = result.defaults as Record<string, unknown>;
    expect("autoPortOffset" in defaults).toBe(false);
  });

  it("strips dead key: defaults.isolation", () => {
    const result = migrate(makeV4Config());
    const defaults = result.defaults as Record<string, unknown>;
    expect("isolation" in defaults).toBe(false);
  });

  it("strips dead key: defaults.basePort (removed by workspace-port-isolation)", () => {
    const result = migrate(makeV4Config());
    const defaults = result.defaults as Record<string, unknown>;
    expect("basePort" in defaults).toBe(false);
  });

  it("strips dead keys from presets: agent and autoStart (all presets)", () => {
    const result = migrate(makeV4Config());
    const presets = result.presets as Record<string, unknown>[];
    // All 4 presets are preserved (1 custom + 3 previously-seeded)
    expect(presets).toHaveLength(4);
    for (const p of presets) {
      expect("agent" in p).toBe(false);
      expect("autoStart" in p).toBe(false);
    }
  });

  it("preserves all presets losslessly — no filtering by name", () => {
    const result = migrate(makeV4Config());
    const presets = result.presets as Array<{ name: string }>;
    const names = presets.map((p) => p.name);
    // Previously-seeded presets are kept (user may have customised them)
    expect(names).toContain("fix");
    expect(names).toContain("feature");
    expect(names).toContain("spike");
    expect(names).toContain("my-custom");
  });

  it("preserves kept preset fields losslessly", () => {
    const result = migrate(makeV4Config());
    const presets = result.presets as Array<Record<string, unknown>>;
    const p = presets[0];
    expect(p.id).toBe("p-custom");
    expect(p.name).toBe("my-custom");
    expect(p.issueTypes).toEqual(["Bug"]);
    expect(p.paneLayout).toBe("2-split");
    expect(p.runOnOpen).toBe("bun dev");
    expect(p.env).toEqual({ PORT: "3000" });
    expect(p.baseOverride).toBe("develop");
    expect(p.portOffset).toBe(8000);
    expect(p.jiraSync).toBe(true);
  });

  it("preserves kept defaults losslessly", () => {
    const result = migrate(makeV4Config());
    const d = result.defaults as Record<string, unknown>;
    expect(d.branchNaming).toEqual(BRANCH_NAMING_KEPT);
    expect(d.baseBranch).toBe("develop");
    expect(d.showRailOnLaunch).toBe(false);
    expect(d.jiraSyncDefault).toBe(true);
    expect(d.aiDefaultId).toBe("account-xyz");
    // basePort removed as of workspace-port-isolation (Option A) — now stripped
    expect("basePort" in d).toBe(false);
  });

  it("preserves root and integrations losslessly", () => {
    const result = migrate(makeV4Config());
    expect(result.root).toBe("/repo/aurora");
    const integrations = result.integrations as Record<string, unknown>;
    expect(integrations.jiraConnectionId).toBe("jira-conn-1");
    expect(integrations.jiraProjectKey).toBe("PROJ");
    expect(integrations.jiraInProgress).toBe("In Progress");
    expect(integrations.jiraDone).toBe("Done");
  });
});

describe("migrate() — idempotency", () => {
  it("returns the same reference when version === CONFIG_VERSION (no-op)", () => {
    const v4 = makeV4Config();
    const v5 = migrate(v4);
    const v5Again = migrate(v5);
    // second call must be a strict no-op: same object reference
    expect(v5Again).toBe(v5);
  });

  it("does not change any field on a second call", () => {
    const v5 = migrate(makeV4Config());
    const v5Again = migrate(v5);
    expect(JSON.stringify(v5Again)).toBe(JSON.stringify(v5));
  });
});

describe("migrate() — edge cases", () => {
  it("handles config with no presets array (absent/undefined)", () => {
    const cfg = { version: 4, root: "/r", defaults: {}, integrations: { jiraConnectionId: null } };
    const result = migrate(cfg);
    expect(Array.isArray(result.presets)).toBe(true);
    expect((result.presets as unknown[]).length).toBe(0);
  });

  it("fills defaults for missing optional default fields", () => {
    const cfg = { version: 4, root: "/r", presets: [], defaults: { baseBranch: "custom" }, integrations: {} };
    const result = migrate(cfg);
    const d = result.defaults as Record<string, unknown>;
    // kept fields present
    expect(d.baseBranch).toBe("custom");
    // falls back to defaults for missing ones
    expect(typeof d.showRailOnLaunch).toBe("boolean");
    expect("basePort" in d).toBe(false);
    expect(d.jiraSyncDefault).toBe(false);
    expect(d.aiDefaultId).toBe(null);
  });

  it("handles absent version field (pre-v2 data)", () => {
    const cfg = { root: "/old", presets: [], defaults: {}, integrations: {} };
    const result = migrate(cfg);
    expect(result.version).toBe(CONFIG_VERSION);
  });
});
