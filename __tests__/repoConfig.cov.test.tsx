// Line-coverage suite for src/lib/repoConfig.ts — per-repo workspace config
// (presets, defaults, integrations) backed by the real store + localStorage.
// Note: __tests__/repoConfig.migrate.test.ts already exercises migrate() deeply
// with a mocked store; this file re-covers migrate() (needed since coverage is
// measured per test file) plus every other export (layoutToPanes,
// defaultRepoConfig, loadRepoConfigs, getRepoConfig, saveRepoConfig,
// updateRepoConfig, hasSavedConfig).

import { describe, it, expect, beforeEach } from "bun:test";
import { useStore } from "../src/state/store";
import {
  CONFIG_VERSION,
  REPO_CONFIG_KEY,
  layoutToPanes,
  defaultRepoConfig,
  migrate,
  loadRepoConfigs,
  getRepoConfig,
  saveRepoConfig,
  updateRepoConfig,
  hasSavedConfig,
  type RepoConfig,
} from "../src/lib/repoConfig";

const ROOT = "/repo/aurora";

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ repoConfigs: {} }, false);
});

describe("layoutToPanes", () => {
  it("'2-split' → 2 panes, h split", () => {
    expect(layoutToPanes("2-split")).toEqual({ paneCount: 2, split: "h" });
  });
  it("'2x2' → 4 panes, h split", () => {
    expect(layoutToPanes("2x2")).toEqual({ paneCount: 4, split: "h" });
  });
  it("'1' → 1 pane, no split key", () => {
    expect(layoutToPanes("1")).toEqual({ paneCount: 1 });
  });
});

describe("defaultRepoConfig", () => {
  it("stamps the current CONFIG_VERSION, empty presets, and sane defaults", () => {
    const cfg = defaultRepoConfig(ROOT);
    expect(cfg.version).toBe(CONFIG_VERSION);
    expect(cfg.root).toBe(ROOT);
    expect(cfg.presets).toEqual([]);
    expect(cfg.defaults.baseBranch).toBe("main");
    expect(cfg.defaults.showRailOnLaunch).toBe(true);
    expect(cfg.defaults.jiraSyncDefault).toBe(false);
    expect(cfg.defaults.aiDefaultId).toBeNull();
    expect(cfg.integrations).toEqual({
      jiraConnectionId: null,
      jiraProjectKey: "",
      jiraInProgress: "In Progress",
      jiraDone: "Done",
    });
  });
});

describe("migrate", () => {
  it("is a no-op (same reference) when already at CONFIG_VERSION", () => {
    const cfg = defaultRepoConfig(ROOT);
    expect(migrate(cfg)).toBe(cfg);
  });

  it("strips dead preset fields (agent/autoStart) and fills preset defaults", () => {
    const legacy = {
      version: 4,
      root: ROOT,
      presets: [{ id: "p1", name: "custom", agent: "claude", autoStart: true }],
      defaults: { baseBranch: "develop", autoPortOffset: true, isolation: "container", basePort: 4000 },
      integrations: { jiraConnectionId: "c1" },
    } as unknown as RepoConfig;
    const out = migrate(legacy);
    expect(out.version).toBe(CONFIG_VERSION);
    expect(out.presets).toHaveLength(1);
    expect(out.presets[0]).toEqual({
      id: "p1",
      name: "custom",
      issueTypes: [],
      paneLayout: "1",
      runOnOpen: null,
      env: {},
      baseOverride: null,
      portOffset: "auto",
      envFiles: [],
      jiraSync: false,
    });
    expect("agent" in out.presets[0]).toBe(false);
    expect("autoStart" in out.presets[0]).toBe(false);
    expect("basePort" in out.defaults).toBe(false);
    expect("autoPortOffset" in out.defaults).toBe(false);
    expect("isolation" in out.defaults).toBe(false);
    expect(out.defaults.baseBranch).toBe("develop");
    expect(out.integrations.jiraConnectionId).toBe("c1");
    expect(out.integrations.jiraProjectKey).toBe("");
    expect(out.integrations.jiraInProgress).toBe("In Progress");
    expect(out.integrations.jiraDone).toBe("Done");
  });

  it("handles a config with no presets/defaults/integrations objects at all", () => {
    const bare = { version: 1, root: ROOT } as unknown as RepoConfig;
    const out = migrate(bare);
    expect(out.version).toBe(CONFIG_VERSION);
    expect(out.presets).toEqual([]);
    expect(out.defaults.baseBranch).toBe("main");
    expect(out.defaults.showRailOnLaunch).toBe(true);
    expect(out.defaults.jiraSyncDefault).toBe(false);
    expect(out.defaults.aiDefaultId).toBeNull();
    expect(out.integrations.jiraConnectionId).toBeNull();
  });

  it("preserves a fully-populated preset's kept fields (all non-null branches)", () => {
    const legacy = {
      version: 3,
      root: ROOT,
      presets: [
        {
          id: "p1",
          name: "full",
          issueTypes: ["Bug"],
          paneLayout: "2x2",
          runOnOpen: "bun dev",
          env: { A: "1" },
          baseOverride: "develop",
          portOffset: 20,
          jiraSync: true,
        },
      ],
      defaults: {
        branchNaming: { source: "manual" },
        baseBranch: "develop",
        showRailOnLaunch: false,
        jiraSyncDefault: true,
        aiDefaultId: "acc-1",
      },
      integrations: {
        jiraConnectionId: "c1",
        jiraProjectKey: "PROJ",
        jiraInProgress: "Doing",
        jiraDone: "Shipped",
      },
    } as unknown as RepoConfig;
    const out = migrate(legacy);
    expect(out.presets[0]).toMatchObject({
      issueTypes: ["Bug"],
      paneLayout: "2x2",
      runOnOpen: "bun dev",
      env: { A: "1" },
      baseOverride: "develop",
      portOffset: 20,
      jiraSync: true,
    });
    expect(out.defaults.branchNaming).toEqual({ source: "manual" });
    expect(out.defaults.showRailOnLaunch).toBe(false);
    expect(out.defaults.jiraSyncDefault).toBe(true);
    expect(out.defaults.aiDefaultId).toBe("acc-1");
    expect(out.integrations.jiraProjectKey).toBe("PROJ");
    expect(out.integrations.jiraInProgress).toBe("Doing");
    expect(out.integrations.jiraDone).toBe("Shipped");
  });
});

describe("loadRepoConfigs", () => {
  it("returns {} when nothing is persisted", () => {
    expect(loadRepoConfigs()).toEqual({});
  });

  it("returns {} and swallows malformed JSON (catch branch)", () => {
    localStorage.setItem(REPO_CONFIG_KEY, "{not json");
    expect(loadRepoConfigs()).toEqual({});
  });

  it("passes through configs already at CONFIG_VERSION unchanged", () => {
    const cfg = defaultRepoConfig(ROOT);
    localStorage.setItem(REPO_CONFIG_KEY, JSON.stringify({ [ROOT]: cfg }));
    const out = loadRepoConfigs();
    expect(out[ROOT]).toEqual(cfg);
  });

  it("migrates + re-persists old configs (changed branch)", () => {
    const legacy = { version: 3, root: ROOT, presets: [], defaults: {}, integrations: {} };
    localStorage.setItem(REPO_CONFIG_KEY, JSON.stringify({ [ROOT]: legacy }));
    const out = loadRepoConfigs();
    expect(out[ROOT].version).toBe(CONFIG_VERSION);
    // Re-persisted: reading raw storage again shows the migrated shape.
    const raw = JSON.parse(localStorage.getItem(REPO_CONFIG_KEY)!);
    expect(raw[ROOT].version).toBe(CONFIG_VERSION);
  });

  it("swallows a localStorage.setItem failure during re-persist (inner catch)", () => {
    const legacy = { version: 2, root: ROOT, presets: [], defaults: {}, integrations: {} };
    localStorage.setItem(REPO_CONFIG_KEY, JSON.stringify({ [ROOT]: legacy }));
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => loadRepoConfigs()).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });
});

describe("getRepoConfig", () => {
  it("returns a fresh default config for a null root", () => {
    const cfg = getRepoConfig(null);
    expect(cfg.root).toBe("");
    expect(cfg.presets).toEqual([]);
  });

  it("returns a fresh default config for an unsaved root", () => {
    const cfg = getRepoConfig(ROOT);
    expect(cfg.root).toBe(ROOT);
    expect(cfg.version).toBe(CONFIG_VERSION);
  });

  it("returns the saved config from the store when present", () => {
    const cfg = defaultRepoConfig(ROOT);
    cfg.defaults.baseBranch = "develop";
    useStore.setState({ repoConfigs: { [ROOT]: cfg } }, false);
    expect(getRepoConfig(ROOT).defaults.baseBranch).toBe("develop");
  });
});

describe("saveRepoConfig", () => {
  it("writes through the store's setRepoConfig action", () => {
    const cfg = defaultRepoConfig(ROOT);
    cfg.defaults.baseBranch = "release";
    saveRepoConfig(cfg);
    expect(useStore.getState().repoConfigs[ROOT].defaults.baseBranch).toBe("release");
  });
});

describe("updateRepoConfig", () => {
  it("seeds a default config, mutates it, and persists (unsaved root)", () => {
    updateRepoConfig(ROOT, (c) => {
      c.defaults.baseBranch = "trunk";
    });
    const saved = useStore.getState().repoConfigs[ROOT];
    expect(saved.root).toBe(ROOT);
    expect(saved.defaults.baseBranch).toBe("trunk");
  });

  it("mutates an existing saved config in place (deep-clones first)", () => {
    const cfg = defaultRepoConfig(ROOT);
    cfg.presets.push({
      id: "p1",
      name: "feature",
      issueTypes: [],
      paneLayout: "1",
      runOnOpen: null,
      env: {},
      baseOverride: null,
      portOffset: "auto",
      jiraSync: false,
    });
    useStore.setState({ repoConfigs: { [ROOT]: cfg } }, false);
    updateRepoConfig(ROOT, (c) => {
      c.presets[0].name = "renamed";
    });
    const saved = useStore.getState().repoConfigs[ROOT];
    expect(saved.presets[0].name).toBe("renamed");
    // Original object passed to setState was cloned, not mutated in place.
    expect(cfg.presets[0].name).toBe("feature");
  });
});

describe("hasSavedConfig", () => {
  it("is false for a null root", () => {
    expect(hasSavedConfig(null)).toBe(false);
  });
  it("is false when the repo has no saved config", () => {
    expect(hasSavedConfig(ROOT)).toBe(false);
  });
  it("is true once a config has been saved", () => {
    saveRepoConfig(defaultRepoConfig(ROOT));
    expect(hasSavedConfig(ROOT)).toBe(true);
  });
});
