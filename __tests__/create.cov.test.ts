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
  installCommand,
  createPrelude,
  type BuildCreateSpecInput,
  type CreateSpec,
  type Preset,
} from "../src/lib/create";
import { deleteWorkspace } from "../src/lib/teardown";

const REPO = { root: "/repo/aurora", name: "aurora", defaultBranch: "repo-default" };

beforeEach(() => {
  tauri.reset();
  useStore.setState(
    {
      workspaces: [],
      repos: [],
      activeWs: null,
      repoConfigs: {},
      // auroraConfigStore.ts caches by repo root in this map — without resetting
      // it, a later test's read_text_file override is silently ignored (the
      // earlier test's cached config, e.g. the default from a no-setup create,
      // wins) since ensureAuroraConfigLoaded short-circuits on a cache hit.
      auroraConfigs: {},
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

// ── createPrelude / installCommand ──────────────────────────────────────────
//
// New scripts model: `installCommand` is no longer called automatically by
// `runCreate` (see the "no install step automatically" test below) — Setup
// Script (aurora.json `scripts.setup`) is the ONLY thing that auto-runs on
// create. Both functions stay exported (scripts-editor UI / a one-click
// "suggest an install command" affordance could still use `installCommand`),
// so their own branches are tested directly here rather than going uncovered.

describe("createPrelude — setup only, no auto-install fallback", () => {
  it("a configured setup is returned as-is", () => {
    expect(createPrelude("bun install")).toBe("bun install");
  });

  it("no setup → undefined (create.ts runs nothing extra)", () => {
    expect(createPrelude(null)).toBeUndefined();
  });
});

describe("installCommand — lockfile detection (not auto-invoked by runCreate anymore)", () => {
  beforeEach(() => tauri.reset());

  it("detects bun.lockb", async () => {
    tauri.invoke({ list_dir: () => [{ name: "bun.lockb", isDir: false }] });
    expect(await installCommand("/repo")).toBe("bun install");
  });

  it("detects pnpm-lock.yaml", async () => {
    tauri.invoke({ list_dir: () => [{ name: "pnpm-lock.yaml", isDir: false }] });
    expect(await installCommand("/repo")).toBe("pnpm install");
  });

  it("detects yarn.lock", async () => {
    tauri.invoke({ list_dir: () => [{ name: "yarn.lock", isDir: false }] });
    expect(await installCommand("/repo")).toBe("yarn install");
  });

  it("detects package-lock.json", async () => {
    tauri.invoke({ list_dir: () => [{ name: "package-lock.json", isDir: false }] });
    expect(await installCommand("/repo")).toBe("npm install");
  });

  it("detects a bare package.json (no lockfile) → npm install", async () => {
    tauri.invoke({ list_dir: () => [{ name: "package.json", isDir: false }] });
    expect(await installCommand("/repo")).toBe("npm install");
  });

  it("non-JS project (no recognized files) → null", async () => {
    tauri.invoke({ list_dir: () => [{ name: "Cargo.toml", isDir: false }] });
    expect(await installCommand("/repo")).toBeNull();
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
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.env.AURORA_PORT_OFFSET).toBe("0");
  });

  it("portOffset 'auto' picks the lowest unused multiple of 10 across ALL repos (cross-repo), ignoring NaN offsets", async () => {
    useStore.setState(
      {
        workspaces: [
          { id: "w1", repoId: REPO.root, env: { AURORA_PORT_OFFSET: "0" } } as never,
          { id: "w2", repoId: REPO.root, env: { AURORA_PORT_OFFSET: "10" } } as never,
          // A DIFFERENT repo's live workspace at offset 20 must still be reserved —
          // managed-server-lifecycle fault #6: a same-repo-only scan let two
          // different repos collide on the same real OS port once both bound it.
          { id: "w3", repoId: "/other/repo", env: { AURORA_PORT_OFFSET: "20" } } as never,
          { id: "w4", repoId: REPO.root, env: { AURORA_PORT_OFFSET: "not-a-number" } } as never, // NaN — ignored
        ],
      },
      false,
    );
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.env.AURORA_PORT_OFFSET).toBe("30");
  });

  it("portOffset a fixed number is used as-is (no scan)", async () => {
    const r = await runCreate(baseSpec({ portOffset: 777 }));
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.env.AURORA_PORT_OFFSET).toBe("777");
  });

  it("create runs NO install step automatically anymore — list_dir is never called (new scripts model: no magic install)", async () => {
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
    // Regression guard: runCreateInner used to call installCommand(spec.repoRoot),
    // which lists the worktree dir to sniff a lockfile. That call is gone — Setup
    // Script (aurora.json scripts.setup) is now the ONLY thing that auto-runs on
    // create, and a repo with no `setup` runs nothing extra.
    expect(tauri.calls().some((c) => c.cmd === "list_dir")).toBe(false);
  });

  it("no committed aurora.json → auroraConfigs caches the default (setup: null), create still succeeds with no prelude", async () => {
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
    expect(useStore.getState().auroraConfigs[REPO.root]?.scripts.setup).toBeNull();
  });

  it("a committed aurora.json's scripts.setup is loaded into auroraConfigs during create (the setup-only prelude wiring)", async () => {
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({
          version: 1,
          scripts: { setup: "bun install", run: [], custom: {}, archive: null },
        }),
    });
    const r = await runCreate(baseSpec());
    expect(r.ok).toBe(true);
    expect(useStore.getState().auroraConfigs[REPO.root]?.scripts.setup).toBe("bun install");
  });

  it("DISPATCHES the Setup Script on create even when a preset on-open script (scriptName) is set but missing — setup is not gated behind the legacy script lookup", async () => {
    // Regression (live-caught): create used to run setup only as the prelude of
    // the legacy on-open `runScript`; a truthy-but-missing `scriptName` made
    // runScript early-return and silently DROP the Setup Script. Setup must now
    // run unconditionally (servers come from managed Run Scripts / ⌘R).
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: "bun install", run: [], custom: {}, archive: null } }),
    });
    const r = await runCreate(baseSpec({ scriptName: "ghost-onopen" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Mark the freshly-created pane ready so the pending runWhenReady tick sends.
    const ws = useStore.getState().workspaces.find((w) => w.id === r.wsId)!;
    const g = ws.tabs[ws.active];
    const paneId = g.panes[g.active].id;
    useStore.getState().setPaneRuntime(paneId, { ptyId: "pty-setup", isZsh: false });
    useStore.getState().setReady(paneId);
    // runWhenReady polls ~every 60ms; poll for the dispatch (real timers).
    const start = Date.now();
    let sent = false;
    while (Date.now() - start < 1500) {
      if (tauri.calls().some((c) => c.cmd === "pty_write" && String(c.args.data).includes("bun install"))) {
        sent = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(sent).toBe(true); // setup dispatched despite the missing on-open script
  });

  it("bakes the workspace title from spec.title, falling back to branch when title is empty", async () => {
    const r = await runCreate(baseSpec({ title: "" }));
    expect(r.ok).toBe(true);
    const ws = useStore.getState().workspaces.find((w) => (r.ok ? w.id === r.wsId : false));
    expect(ws?.title).toBe("feat/my-feature");
  });

  it("an env-file spec that escapes the workspace surfaces a warn notify but doesn't fail the create", async () => {
    const r = await runCreate(baseSpec({ envFiles: [{ path: "../escape.env", content: "X=1" }] }));
    expect(r.ok).toBe(true);
    expect(useStore.getState().notifLog[0]).toMatchObject({ headline: expect.stringContaining("env file") });
  });

  it("a write failure for one env file is reported without blocking the others (materializeEnvFiles per-spec independence)", async () => {
    tauri.invoke({
      list_dir: () => [],
      write_text_file: (a) => {
        if ((a.path as string).includes("bad")) throw new Error("disk full");
      },
    });
    const r = await runCreate(
      baseSpec({
        envFiles: [
          { path: "good.env", content: "A=1" },
          { path: "bad.env", content: "B=2" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(useStore.getState().notifLog[0]?.sub).toContain("disk full");
  });

  describe("envFiles from the repo's committed aurora.json", () => {
    const writes = () =>
      tauri.calls().filter((c) => c.cmd === "write_text_file").map((c) => ({
        path: String(c.args.path),
        contents: String(c.args.contents ?? c.args.content ?? ""),
      }));

    it("materializes aurora.json envFiles into the worktree with ${port:BASE} expanded", async () => {
      tauri.invoke({
        list_dir: () => [],
        read_text_file: () =>
          JSON.stringify({
            version: 1,
            scripts: { setup: null, run: [], custom: {}, archive: null },
            envFiles: [{ path: "apps/api/.env.local", content: "PORT=${port:3000}\n" }],
          }),
      });
      const r = await runCreate(baseSpec({ portOffset: 10, envFiles: [] }));
      expect(r.ok).toBe(true);

      const written = writes().find((w) => w.path.endsWith("apps/api/.env.local"));
      expect(written).toBeDefined();
      expect(written!.contents).toBe("PORT=3010\n");
    });

    it("a preset envFile wins over an aurora.json envFile at the same path, and is written once", async () => {
      tauri.invoke({
        list_dir: () => [],
        read_text_file: () =>
          JSON.stringify({
            version: 1,
            scripts: { setup: null, run: [], custom: {}, archive: null },
            envFiles: [{ path: "shared.env", content: "FROM=aurora-json\n" }],
          }),
      });
      const r = await runCreate(
        baseSpec({ portOffset: 0, envFiles: [{ path: "shared.env", content: "FROM=preset\n" }] }),
      );
      expect(r.ok).toBe(true);

      const shared = writes().filter((w) => w.path.endsWith("shared.env"));
      expect(shared).toHaveLength(1); // concurrent writes to one path would race
      expect(shared[0].contents).toBe("FROM=preset\n");
    });
  });
});

describe("port offset — reclaimed on teardown, reused by the next create (task 3.3)", () => {
  it("frees the departed workspace's offset for the next auto-create", async () => {
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: false }),
      list_dir: () => [],
      path_resolve: (a) => a.path as string,
    });

    // Create A → offset 0 (first auto-allocation for this repo).
    tauri.invoke({ worktree_add: () => ({ path: "/repo/.aurora-worktrees/aurora/feat-a", branch: "feat/a", head: "a" }) });
    const rA = await runCreate(baseSpec({ branch: "feat/a" }));
    expect(rA.ok).toBe(true);
    const wsAId = rA.ok ? rA.wsId : "";
    expect(useStore.getState().workspaces.find((w) => w.id === wsAId)?.env.AURORA_PORT_OFFSET).toBe("0");

    // Create B → offset 10 (A still holds 0, so B gets the next free slot).
    tauri.invoke({ worktree_add: () => ({ path: "/repo/.aurora-worktrees/aurora/feat-b", branch: "feat/b", head: "b" }) });
    const rB = await runCreate(baseSpec({ branch: "feat/b" }));
    expect(rB.ok).toBe(true);
    expect(useStore.getState().workspaces.find((w) => w.id === (rB.ok ? rB.wsId : ""))?.env.AURORA_PORT_OFFSET).toBe("10");

    // Tear down A through the real orchestrator (not a manual store splice) —
    // this is the reclamation path under test.
    tauri.invoke({
      worktree_list: () => [
        { path: REPO.root, branch: "main", head: null },
        { path: "/repo/.aurora-worktrees/aurora/feat-a", branch: "feat/a", head: null },
        { path: "/repo/.aurora-worktrees/aurora/feat-b", branch: "feat/b", head: null },
      ],
      worktree_remove: () => undefined,
      pty_kill: () => undefined,
    });
    const rDel = await deleteWorkspace(wsAId);
    expect(rDel).toEqual({ ok: true });
    expect(useStore.getState().workspaces.some((w) => w.id === wsAId)).toBe(false);

    // Create C → offset 0 REUSED (A's slot was freed by teardown), not 20 —
    // proves allocOffset's live-workspace scan actually observes the removal.
    tauri.invoke({ worktree_add: () => ({ path: "/repo/.aurora-worktrees/aurora/feat-c", branch: "feat/c", head: "c" }) });
    const rC = await runCreate(baseSpec({ branch: "feat/c" }));
    expect(rC.ok).toBe(true);
    expect(useStore.getState().workspaces.find((w) => w.id === (rC.ok ? rC.wsId : ""))?.env.AURORA_PORT_OFFSET).toBe("0");
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
