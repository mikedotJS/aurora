// Line-coverage suite for src/lib/create.ts — workspace-creation orchestration
// (validate → worktree add → register workspace → install deps → run on-open
// script). Uses the real Zustand store + the shared Tauri invoke mock so every
// branch (validation failure, worktree failure w/ humanized messages, offset
// allocation, install-command detection, script/command dispatch, rollback on
// createWorkspace throwing) is exercised end to end.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import {
  buildCreateSpec,
  resolveCreateDefaults,
  runCreate,
  type BuildCreateSpecInput,
  type CreateSpec,
  type Preset,
} from "../src/lib/create";

const REPO = { root: "/repo/aurora", name: "aurora", defaultBranch: "repo-default" };

beforeEach(() => {
  tauri.reset();
  useStore.setState(
    {
      workspaces: [],
      repos: [],
      activeWs: null,
      repoConfigs: {},
    },
    false,
  );
});

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: "p1",
    name: "feature",
    issueTypes: [],
    paneLayout: "2-split",
    runOnOpen: "bun dev",
    env: { PORT: "3001" },
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

function baseSpec(overrides: Partial<CreateSpec> = {}): CreateSpec {
  return {
    repoRoot: REPO.root,
    repoName: REPO.name,
    source: "branch",
    issueKey: null,
    title: "My feature",
    branch: "feat/my-feature",
    baseBranch: "main",
    newBranch: true,
    preset: null,
    scriptName: null,
    paneCount: 1,
    split: undefined,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    portOffset: "auto",
    ...overrides,
  };
}

// ── resolveCreateDefaults / buildCreateSpec ──────────────────────────────────

describe("resolveCreateDefaults", () => {
  it("falls to cfg.defaults.baseBranch ('main') when no repo config is saved and no preset/explicit base", () => {
    const def = resolveCreateDefaults({ repo: REPO, preset: null, baseBranch: null });
    expect(def).toEqual({ base: "main", presetName: null, scriptName: null });
  });

  it("falls all the way to repo.defaultBranch when cfg.defaults.baseBranch is explicitly null", () => {
    useStore.setState({ repoConfigs: { [REPO.root]: defaultCfg() } }, false);
    const def = resolveCreateDefaults({ repo: REPO, preset: null, baseBranch: null });
    expect(def).toEqual({ base: "repo-default", presetName: null, scriptName: null });
  });

  it("cfg.defaults.baseBranch wins over repo.defaultBranch once a config is saved", () => {
    useStore.setState(
      {
        repoConfigs: { [REPO.root]: { ...defaultCfg(), defaults: { ...defaultCfg().defaults, baseBranch: "develop" } } },
      },
      false,
    );
    const def = resolveCreateDefaults({ repo: REPO, preset: null });
    expect(def.base).toBe("develop");
  });

  it("preset.baseOverride wins over cfg + repo defaults", () => {
    const def = resolveCreateDefaults({ repo: REPO, preset: makePreset({ baseOverride: "preset-base" }) });
    expect(def.base).toBe("preset-base");
    expect(def.presetName).toBe("feature");
    expect(def.scriptName).toBe("bun dev");
  });

  it("explicit baseBranch wins over everything", () => {
    const def = resolveCreateDefaults({
      repo: REPO,
      preset: makePreset({ baseOverride: "preset-base" }),
      baseBranch: "explicit",
    });
    expect(def.base).toBe("explicit");
  });

  it("scriptName '' → null (explicit none) even with a preset default", () => {
    const def = resolveCreateDefaults({ repo: REPO, preset: makePreset({ runOnOpen: "bun dev" }), scriptName: "" });
    expect(def.scriptName).toBeNull();
  });
});

function defaultCfg() {
  return {
    version: 6,
    root: REPO.root,
    presets: [],
    defaults: { branchNaming: {} as never, baseBranch: null as unknown as string, showRailOnLaunch: true, jiraSyncDefault: false, aiDefaultId: null },
    integrations: { jiraConnectionId: null, jiraProjectKey: "", jiraInProgress: "In Progress", jiraDone: "Done" },
  };
}

describe("buildCreateSpec", () => {
  it("assembles a full spec from a preset, carrying env/portOffset/paneCount/split", () => {
    const spec = buildCreateSpec(baseInput({ preset: makePreset() }));
    expect(spec.repoRoot).toBe(REPO.root);
    expect(spec.repoName).toBe(REPO.name);
    expect(spec.env).toEqual({ PORT: "3001" });
    expect(spec.portOffset).toBe(100);
    expect(spec.paneCount).toBe(2);
    expect(spec.split).toBe("h");
    expect(spec.preset).toBe("feature");
    expect(spec.scriptName).toBe("bun dev");
  });

  it("assembles a minimal spec with no preset (paneCount 1, env {}, portOffset auto)", () => {
    const spec = buildCreateSpec(baseInput());
    expect(spec.preset).toBeNull();
    expect(spec.paneCount).toBe(1);
    expect(spec.split).toBeUndefined();
    expect(spec.env).toEqual({});
    expect(spec.portOffset).toBe("auto");
    expect(spec.scriptName).toBeNull();
  });

  it("carries jira metadata through when set", () => {
    const spec = buildCreateSpec(
      baseInput({ issueKey: "PROJ-1", jiraStatus: "In Progress", jiraUrl: "https://x/PROJ-1", jiraSync: true }),
    );
    expect(spec.issueKey).toBe("PROJ-1");
    expect(spec.jiraStatus).toBe("In Progress");
    expect(spec.jiraUrl).toBe("https://x/PROJ-1");
    expect(spec.jiraSync).toBe(true);
  });
});

// ── runCreate ─────────────────────────────────────────────────────────────────

describe("runCreate — validation failures short-circuit before any invoke", () => {
  it("rejects a locally-invalid branch name without calling the backend", async () => {
    const r = await runCreate(baseSpec({ branch: "" }));
    expect(r).toEqual({ ok: false, error: "Enter a branch name." });
    expect(tauri.calls()).toEqual([]);
  });

  it("rejects when the backend validator reports invalid, with its message", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: false, message: "Branch must start with JIRA-", enforced: true }) });
    const r = await runCreate(baseSpec());
    expect(r).toEqual({ ok: false, error: "Branch must start with JIRA-" });
    expect(tauri.lastCall("worktree_add")).toBeUndefined();
  });

  it("falls back to a generic message when the backend validator gives none", async () => {
    tauri.invoke({ validate_branch_name: () => ({ ok: false, message: null, enforced: true }) });
    const r = await runCreate(baseSpec());
    expect(r).toEqual({ ok: false, error: "That branch name fails the repo's naming rule." });
  });
});

describe("runCreate — worktree failure is humanized", () => {
  beforeEach(() => {
    tauri.invoke({ validate_branch_name: () => ({ ok: true, message: null, enforced: false }) });
  });

  it("'already exists' → a friendly pick-a-different-name message", async () => {
    tauri.invoke({
      worktree_add: () => {
        throw new Error("fatal: branch already exists");
      },
    });
    const r = await runCreate(baseSpec({ branch: "feat/dup" }));
    expect(r).toEqual({ ok: false, error: "“feat/dup” already exists — pick a different branch name." });
  });

  it("'already used by worktree' → the same friendly message", async () => {
    tauri.invoke({
      worktree_add: () => {
        throw new Error("'feat/dup' is already used by worktree at /x");
      },
    });
    const r = await runCreate(baseSpec({ branch: "feat/dup" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("already exists — pick a different branch name.");
  });

  it("'not a valid object name' → base branch doesn't exist", async () => {
    tauri.invoke({
      worktree_add: () => {
        throw new Error("fatal: not a valid object name: 'ghost-base'");
      },
    });
    const r = await runCreate(baseSpec({ baseBranch: "ghost-base" }));
    expect(r).toEqual({ ok: false, error: "The base branch doesn't exist." });
  });

  it("'invalid reference' → base branch doesn't exist", async () => {
    tauri.invoke({
      worktree_add: () => {
        throw new Error("invalid reference: ghost-base");
      },
    });
    const r = await runCreate(baseSpec({ baseBranch: "ghost-base" }));
    expect(r).toEqual({ ok: false, error: "The base branch doesn't exist." });
  });

  it("generic multi-line git error: takes the first non-empty line, strips one leading error:/fatal:/git: prefix", async () => {
    // String(new Error("fatal: ...")) renders as "Error: fatal: ..." — humanize()
    // strips exactly one leading "<word>:" prefix (case-insensitively), so the
    // "Error: " wrapper is stripped but the inner "fatal:" survives.
    tauri.invoke({
      worktree_add: () => {
        throw new Error("fatal: something went wrong\nmore detail on line 2");
      },
    });
    const r = await runCreate(baseSpec());
    expect(r).toEqual({ ok: false, error: "fatal: something went wrong" });
  });

  it("empty error string (zero non-empty lines) → the generic fallback message", async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercise the
    // raw-string rejection path (String("") === ""), distinct from `new Error("")`
    // which stringifies to the non-empty literal "Error".
    tauri.invoke({
      worktree_add: () => {
        throw "";
      },
    });
    const r = await runCreate(baseSpec());
    expect(r).toEqual({ ok: false, error: "Couldn't create the workspace." });
  });
});

describe("runCreate — success path: offset allocation, install detection, script/command dispatch", () => {
  beforeEach(() => {
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: false }),
      worktree_add: () => ({ path: "/repo/.aurora-worktrees/aurora/feat-my-feature", branch: "feat/my-feature", head: "abc" }),
    });
  });

  it("portOffset 'auto' with no existing workspaces for the repo → offset 0", async () => {
    tauri.invoke({ list_dir: () => [] }); // no lockfile → non-JS, no install
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.env.AURORA_PORT_OFFSET).toBe("0");
  });

  it("portOffset 'auto' picks the lowest unused multiple of 10, ignoring other repos + NaN offsets", async () => {
    useStore.setState(
      {
        workspaces: [
          { id: "w1", repoId: REPO.root, env: { AURORA_PORT_OFFSET: "0" } } as never,
          { id: "w2", repoId: REPO.root, env: { AURORA_PORT_OFFSET: "10" } } as never,
          { id: "w3", repoId: "/other/repo", env: { AURORA_PORT_OFFSET: "0" } } as never, // different repo — ignored
          { id: "w4", repoId: REPO.root, env: { AURORA_PORT_OFFSET: "not-a-number" } } as never, // NaN — ignored
        ],
      },
      false,
    );
    tauri.invoke({ list_dir: () => [] });
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.env.AURORA_PORT_OFFSET).toBe("20");
  });

  it("portOffset a fixed number is used as-is (no scan)", async () => {
    tauri.invoke({ list_dir: () => [] });
    const r = await runCreate(baseSpec({ portOffset: 777 }));
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.env.AURORA_PORT_OFFSET).toBe("777");
  });

  it("detects bun.lockb and runs the on-open script with the install as a prelude (scriptName set)", async () => {
    tauri.invoke({ list_dir: () => [{ name: "bun.lockb", isDir: false }] });
    const r = await runCreate(baseSpec({ scriptName: "dev" }));
    expect(r.ok).toBe(true);
  });

  it("detects pnpm-lock.yaml and runs the bare install command (no scriptName)", async () => {
    tauri.invoke({ list_dir: () => [{ name: "pnpm-lock.yaml", isDir: false }] });
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
  });

  it("detects yarn.lock", async () => {
    tauri.invoke({ list_dir: () => [{ name: "yarn.lock", isDir: false }] });
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
  });

  it("detects package-lock.json", async () => {
    tauri.invoke({ list_dir: () => [{ name: "package-lock.json", isDir: false }] });
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
  });

  it("detects a bare package.json (no lockfile) → npm install", async () => {
    tauri.invoke({ list_dir: () => [{ name: "package.json", isDir: false }] });
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
  });

  it("non-JS project (no recognized files) → no install, no scriptName → neither runScript nor runCommand", async () => {
    tauri.invoke({ list_dir: () => [{ name: "Cargo.toml", isDir: false }] });
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
  });

  it("bakes the workspace title from spec.title, falling back to branch when title is empty", async () => {
    tauri.invoke({ list_dir: () => [] });
    const r = await runCreate(baseSpec({ title: "" }));
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.title).toBe("feat/my-feature");
  });
});

describe("runCreate — createWorkspace throwing rolls back the worktree", () => {
  it("removes the worktree and returns ok:false with the stringified error", async () => {
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: false }),
      worktree_add: () => ({ path: "/x", branch: "feat/my-feature", head: "abc" }),
      list_dir: () => [],
    });
    const origCreate = useStore.getState().createWorkspace;
    useStore.setState(
      {
        createWorkspace: () => {
          throw new Error("boom: duplicate id");
        },
      },
      false,
    );
    try {
      const r = await runCreate(baseSpec());
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("boom: duplicate id");
      expect(tauri.lastCall("worktree_remove")?.args).toMatchObject({ force: true });
    } finally {
      useStore.setState({ createWorkspace: origCreate }, false);
    }
  });
});
