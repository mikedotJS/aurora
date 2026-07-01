/// <reference types="bun-types" />
/**
 * Unit tests for buildCreateSpec() — unify-workspace-create OpenSpec change.
 *
 * Covers:
 *  - quick form ≡ scope form: same inputs → identical CreateSpec
 *  - preset fields (env, portOffset, paneCount, split, scriptName) flow through
 *  - base branch precedence: baseBranch > preset.baseOverride > cfg.defaults.baseBranch > repo.defaultBranch
 *  - scriptName resolution: undefined→preset fallback; ""/null→explicit none; string→explicit value
 */

import { mock, describe, it, expect } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────
// Must appear before any dynamic import. The preload (test/setup.ts) already
// stubs every Tauri/xterm module the import chain touches, so only the STORE
// needs a per-file override here.

// Mutable cfg defaults — tests reassign to control the config layer of the
// base-branch precedence chain. The factory captures the variable by reference,
// so reassignment before a test call is visible to getRepoConfig().
let cfgDefaults: Record<string, unknown> = {
  baseBranch: "cfg-main",
  basePort: 0,
  branchNaming: {},
  showRailOnLaunch: true,
  jiraSyncDefault: false,
  aiDefaultId: null,
};

// Mock the store so getRepoConfig() (in repoConfig.ts) returns controlled data.
// Must also export every runtime symbol that the import chain (scripts.ts,
// keymap.ts, …) pulls in — types are erased at runtime so only functions and
// constants matter.
mock.module("../src/state/store", () => ({
  useStore: {
    getState: () => ({
      repoConfigs: {
        "/repo/aurora": {
          version: 5,
          root: "/repo/aurora",
          presets: [],
          defaults: cfgDefaults,
          integrations: { jiraConnectionId: null, jiraProjectKey: "", jiraInProgress: "", jiraDone: "" },
        },
      },
      setRepoConfig: () => {},
      workspaces: [],
      userScripts: {},
    }),
  },
  // Pure helper functions — simple stubs; none are called by buildCreateSpec.
  activeWorkspace: () => undefined,
  activeGroup: () => undefined,
  activePane: () => undefined,
  findPane: () => undefined,
  workspaceOfPane: () => undefined,
  allRepoRoots: () => new Set(),
  MODEL_OPTIONS: [],
  DEFAULT_SETTINGS: {},
}));

// bun test automatically un-registers a file's own mock.module() calls once
// that file's tests finish (verified empirically — no manual mock.restore()
// needed, and calling it here would double-pop bun's internal mock stack and
// corrupt state for later real-store files).

// ── Load module under test ────────────────────────────────────────────────────
type Preset = {
  id: string;
  name: string;
  issueTypes: string[];
  paneLayout: string;
  runOnOpen: string | null;
  env: Record<string, string>;
  baseOverride: string | null;
  portOffset: "auto" | number;
  jiraSync: boolean;
};

type BuildCreateSpecInput = {
  repo: { root: string; name: string; defaultBranch: string };
  source: string;
  preset?: Preset | null;
  branch: string;
  title: string;
  baseBranch?: string | null;
  scriptName?: string | null;
  newBranch: boolean;
  issueKey?: string | null;
  jiraStatus?: string | null;
  jiraUrl?: string | null;
  jiraSync?: boolean;
};

type CreateSpec = {
  repoRoot: string;
  repoName: string;
  source: string;
  issueKey: string | null;
  title: string;
  branch: string;
  baseBranch: string;
  newBranch: boolean;
  preset: string | null;
  scriptName: string | null;
  paneCount: number;
  split?: "h" | "v";
  jiraStatus: string | null;
  jiraUrl: string | null;
  jiraSync: boolean;
  env: Record<string, string>;
  portOffset: "auto" | number;
};

type ResolveCreateDefaultsInput = {
  repo: { root: string; defaultBranch: string };
  preset?: Preset | null;
  baseBranch?: string | null;
  scriptName?: string | null;
};
type CreateDefaults = {
  base: string;
  presetName: string | null;
  scriptName: string | null;
};

const { buildCreateSpec, resolveCreateDefaults } = (await import("../src/lib/create.ts")) as {
  buildCreateSpec: (input: BuildCreateSpecInput) => CreateSpec;
  resolveCreateDefaults: (input: ResolveCreateDefaultsInput) => CreateDefaults;
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO = { root: "/repo/aurora", name: "aurora", defaultBranch: "repo-default" };

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "p1",
    name: "feature",
    issueTypes: [],
    paneLayout: "2-split",
    runOnOpen: "bun dev",
    env: { PORT: "3001", APP: "aurora" },
    baseOverride: "preset-base",
    portOffset: 100,
    jiraSync: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildCreateSpecInput> = {}): BuildCreateSpecInput {
  return {
    repo: REPO,
    source: "branch",
    branch: "feat/my-feature",
    title: "My feature",
    newBranch: true,
    ...overrides,
  };
}

// ── Tests: quick form ≡ scope form equivalence ────────────────────────────────

describe("buildCreateSpec — equivalence: same inputs produce identical spec", () => {
  it("deterministic: two calls with identical input return the same spec", () => {
    const input = baseInput({ preset: makePreset() });
    const a = buildCreateSpec(input);
    const b = buildCreateSpec(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("preset path and no-preset path both include repoRoot, branch, source", () => {
    const withPreset = buildCreateSpec(baseInput({ preset: makePreset() }));
    const withoutPreset = buildCreateSpec(baseInput());
    expect(withPreset.repoRoot).toBe(REPO.root);
    expect(withPreset.repoName).toBe(REPO.name);
    expect(withPreset.branch).toBe("feat/my-feature");
    expect(withPreset.source).toBe("branch");
    expect(withoutPreset.repoRoot).toBe(REPO.root);
    expect(withoutPreset.branch).toBe("feat/my-feature");
  });
});

// ── Tests: preset fields flow through ────────────────────────────────────────

describe("buildCreateSpec — preset fields are carried into the spec", () => {
  it("env, portOffset, paneCount, split, scriptName, preset name are all set from preset", () => {
    const spec = buildCreateSpec(baseInput({ preset: makePreset() }));
    expect(spec.env).toEqual({ PORT: "3001", APP: "aurora" });
    expect(spec.portOffset).toBe(100);
    expect(spec.paneCount).toBe(2);
    expect(spec.split).toBe("h");
    expect(spec.scriptName).toBe("bun dev");
    expect(spec.preset).toBe("feature");
  });

  it("paneLayout '1' → paneCount 1, split undefined", () => {
    const spec = buildCreateSpec(baseInput({ preset: makePreset({ paneLayout: "1" }) }));
    expect(spec.paneCount).toBe(1);
    expect(spec.split).toBeUndefined();
  });

  it("paneLayout '2x2' → paneCount 4, split 'h'", () => {
    const spec = buildCreateSpec(baseInput({ preset: makePreset({ paneLayout: "2x2" }) }));
    expect(spec.paneCount).toBe(4);
    expect(spec.split).toBe("h");
  });

  it("without preset: env={}, portOffset='auto', paneCount=1, scriptName=null, preset=null", () => {
    const spec = buildCreateSpec(baseInput());
    expect(spec.env).toEqual({});
    expect(spec.portOffset).toBe("auto");
    expect(spec.paneCount).toBe(1);
    expect(spec.split).toBeUndefined();
    expect(spec.scriptName).toBeNull();
    expect(spec.preset).toBeNull();
  });
});

// ── Tests: base branch precedence ────────────────────────────────────────────

describe("buildCreateSpec — base branch precedence", () => {
  it("[P1] explicit baseBranch beats preset.baseOverride, cfg and repo defaults", () => {
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ baseOverride: "preset-base" }),
      baseBranch: "explicit-base",
    }));
    expect(spec.baseBranch).toBe("explicit-base");
  });

  it("[P2] preset.baseOverride beats cfg.defaults.baseBranch and repo.defaultBranch", () => {
    // cfgDefaults.baseBranch = "cfg-main", repo.defaultBranch = "repo-default"
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ baseOverride: "preset-base" }),
      // baseBranch absent → undefined → falls to preset
    }));
    expect(spec.baseBranch).toBe("preset-base");
  });

  it("[P3] cfg.defaults.baseBranch beats repo.defaultBranch when preset has no override", () => {
    // cfgDefaults.baseBranch = "cfg-main"
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ baseOverride: null }),
    }));
    expect(spec.baseBranch).toBe("cfg-main");
  });

  it("[P4] repo.defaultBranch is last resort when cfg.defaults.baseBranch is null", () => {
    const saved = cfgDefaults;
    cfgDefaults = { ...cfgDefaults, baseBranch: null };
    try {
      const spec = buildCreateSpec(baseInput({
        preset: makePreset({ baseOverride: null }),
      }));
      expect(spec.baseBranch).toBe("repo-default");
    } finally {
      cfgDefaults = saved;
    }
  });

  it("[P4b] repo.defaultBranch is last resort with no preset and null cfg.baseBranch", () => {
    const saved = cfgDefaults;
    cfgDefaults = { ...cfgDefaults, baseBranch: null };
    try {
      const spec = buildCreateSpec(baseInput());
      expect(spec.baseBranch).toBe("repo-default");
    } finally {
      cfgDefaults = saved;
    }
  });
});

// ── Tests: scriptName resolution ──────────────────────────────────────────────

describe("buildCreateSpec — scriptName resolution", () => {
  it("scriptName absent (undefined) → falls back to preset.runOnOpen", () => {
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ runOnOpen: "bun dev" }),
      // scriptName not provided → undefined
    }));
    expect(spec.scriptName).toBe("bun dev");
  });

  it("scriptName '' (empty string) → null (user explicitly chose none)", () => {
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ runOnOpen: "bun dev" }),
      scriptName: "",
    }));
    expect(spec.scriptName).toBeNull();
  });

  it("scriptName null → null (user explicitly chose none, even with preset runOnOpen)", () => {
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ runOnOpen: "bun dev" }),
      scriptName: null,
    }));
    expect(spec.scriptName).toBeNull();
  });

  it("explicit scriptName wins over preset.runOnOpen", () => {
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ runOnOpen: "bun dev" }),
      scriptName: "bun start:prod",
    }));
    expect(spec.scriptName).toBe("bun start:prod");
  });

  it("scriptName absent, no preset → null", () => {
    const spec = buildCreateSpec(baseInput());
    expect(spec.scriptName).toBeNull();
  });

  it("scriptName absent, preset.runOnOpen = null → null", () => {
    const spec = buildCreateSpec(baseInput({
      preset: makePreset({ runOnOpen: null }),
    }));
    expect(spec.scriptName).toBeNull();
  });
});

// ── Tests: resolveCreateDefaults — clone via shared resolver ──────────────────
// Asserts that ⇥ (form seed) and ↵ (quickCreate) produce the same base/preset
// because both now delegate to resolveCreateDefaults instead of recomputing.

describe("resolveCreateDefaults — clone defaults match active workspace", () => {
  it("explicit baseBranch (active branch) wins over preset.baseOverride", () => {
    const def = resolveCreateDefaults({
      repo: REPO,
      preset: makePreset({ baseOverride: "preset-base" }),
      baseBranch: "feat/active-branch",
    });
    expect(def.base).toBe("feat/active-branch");
    expect(def.presetName).toBe("feature");
    expect(def.scriptName).toBe("bun dev");
  });

  it("resolveCreateDefaults and buildCreateSpec agree on clone inputs", () => {
    const preset = makePreset();
    const activeBranch = "feat/active-branch";
    const def = resolveCreateDefaults({ repo: REPO, preset, baseBranch: activeBranch });
    const spec = buildCreateSpec(baseInput({
      source: "clone",
      preset,
      baseBranch: activeBranch,
      newBranch: true,
    }));
    expect(spec.baseBranch).toBe(def.base);
    expect(spec.preset).toBe(def.presetName);
    expect(spec.scriptName).toBe(def.scriptName);
  });

  it("without active preset, base falls back through cfg → repo.defaultBranch when no active branch", () => {
    const def = resolveCreateDefaults({
      repo: REPO,
      preset: null,
      baseBranch: null,
    });
    // cfg-main from cfgDefaults fixture
    expect(def.base).toBe("cfg-main");
    expect(def.presetName).toBeNull();
    expect(def.scriptName).toBeNull();
  });
});

describe("resolveCreateDefaults — branch display defaults", () => {
  it("no baseBranch: preset.baseOverride wins over cfg", () => {
    const def = resolveCreateDefaults({
      repo: REPO,
      preset: makePreset({ baseOverride: "preset-base" }),
    });
    expect(def.base).toBe("preset-base");
  });

  it("no preset, no baseBranch: falls through cfg.defaults.baseBranch", () => {
    const def = resolveCreateDefaults({ repo: REPO, preset: null });
    expect(def.base).toBe("cfg-main");
  });
});
