/// <reference types="bun-types" />
/**
 * Unit tests for store command-palette actions — unify-workspace-create OpenSpec change.
 *
 * Tests the actual Zustand store (not a mock), so the assertions reflect the
 * real reducer behaviour. Two bugs this covers:
 *
 *  1. setCommandQuery must preserve repoId (the pinned target) across keystrokes.
 *     Before the fix, typing would re-create the command object without spreading
 *     the prior state, silently dropping repoId.
 *
 *  2. setCommandRepo must preserve query and sel while pinning a new repo target.
 *     Both actions must be no-ops when command is null.
 */

import { describe, it, expect, beforeEach } from "bun:test";

// ── Load the actual store ─────────────────────────────────────────────────────
// The preload (test/setup.ts) already stubs every Tauri/xterm module the store
// import chain touches, and the real theme.ts applyTheme() works fine under
// happy-dom — no per-file module mocks needed.
//
// NOTE: co-located with the init/boot-lane tests below because this is a file
// whose REAL-store import must survive the full-suite run (bun's mock.module for
// "../src/state/store" — registered by teardown/runServers/buildCreateSpec — is
// process-global; those files restore it via afterAll so it doesn't leak here).
const storeMod = (await import("../src/state/store")) as typeof import("../src/state/store");
const { useStore, activeWorkspace, activePane, activeGroup } = storeMod;
const { statusOf, statusLine } = (await import("../src/lib/workspace")) as typeof import("../src/lib/workspace");
const ports = (await import("../src/lib/ports")) as typeof import("../src/lib/ports");

// localStorage shim so init()'s savePersisted / loadRepos don't throw in Bun.
const _ls = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => void _ls.set(k, String(v)),
  removeItem: (k: string) => void _ls.delete(k),
  clear: () => _ls.clear(),
  key: () => null,
  length: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reset the command state before each test to avoid cross-test contamination. */
beforeEach(() => {
  useStore.setState({ command: null });
});

function openWith(query: string, repoId: string | null, sel = 0) {
  useStore.setState({ command: { query, sel, repoId } });
}

// ── Tests: setCommandQuery preserves repoId ───────────────────────────────────

describe("setCommandQuery — repoId survives a keystroke", () => {
  it("repoId is preserved after setCommandQuery", () => {
    openWith("", "repo-abc", 0);
    useStore.getState().setCommandQuery("feat");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("repo-abc");
    expect(cmd.query).toBe("feat");
  });

  it("repoId null is preserved (not converted to undefined)", () => {
    openWith("", null, 0);
    useStore.getState().setCommandQuery("foo");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBeNull();
    expect(cmd.query).toBe("foo");
  });

  it("sel is reset to 0 after typing", () => {
    openWith("", "repo-1", 3);
    useStore.getState().setCommandQuery("x");
    expect(useStore.getState().command!.sel).toBe(0);
  });

  it("is a no-op (command stays null) when command is closed", () => {
    // command is null from beforeEach
    useStore.getState().setCommandQuery("anything");
    expect(useStore.getState().command).toBeNull();
  });

  it("multiple keystrokes all preserve repoId", () => {
    openWith("", "pinned-repo", 0);
    useStore.getState().setCommandQuery("f");
    useStore.getState().setCommandQuery("fe");
    useStore.getState().setCommandQuery("feat");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("pinned-repo");
    expect(cmd.query).toBe("feat");
  });
});

// ── Tests: setCommandRepo preserves query/sel ─────────────────────────────────

describe("setCommandRepo — query and sel survive a repo change", () => {
  it("query and sel are preserved after setCommandRepo", () => {
    openWith("my-branch", "repo-1", 2);
    useStore.getState().setCommandRepo("repo-2");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("repo-2");
    expect(cmd.query).toBe("my-branch");
    expect(cmd.sel).toBe(2);
  });

  it("setCommandRepo to null clears the target while keeping query/sel", () => {
    openWith("foo", "repo-1", 1);
    useStore.getState().setCommandRepo(null);
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBeNull();
    expect(cmd.query).toBe("foo");
    expect(cmd.sel).toBe(1);
  });

  it("is a strict no-op when command is null (returns empty patch)", () => {
    // command is null from beforeEach
    useStore.getState().setCommandRepo("repo-xyz");
    // must stay null — not open the palette
    expect(useStore.getState().command).toBeNull();
  });
});

// ── Tests: openCommand → setCommandQuery/setCommandRepo round-trip ────────────

describe("openCommand + command actions — combined round-trip", () => {
  it("openCommand sets repoId; setCommandQuery preserves it", () => {
    useStore.getState().openCommand("the-repo");
    useStore.getState().setCommandQuery("some-branch");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("the-repo");
    expect(cmd.query).toBe("some-branch");
  });

  it("openCommand → setCommandRepo → setCommandQuery preserves the new repoId", () => {
    useStore.getState().openCommand("repo-A");
    useStore.getState().setCommandRepo("repo-B");
    useStore.getState().setCommandQuery("typed");
    const cmd = useStore.getState().command!;
    expect(cmd.repoId).toBe("repo-B");
    expect(cmd.query).toBe("typed");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// init() boot-lane logic — superseded at boot by home-terminal
//
// init() creates+unshifts a repo boot lane ONLY when boot.repo is a real repo
// checkout — a repo launch is a real context. It additionally ALWAYS ensures a
// permanent, singleton Home terminal (`kind: "home"`, repoId: null, rooted at
// the user's home dir) exists — reusing a restored one (matched by `kind`) or
// synthesizing one. This supersedes empty-startup-state's prior "0 repo
// context + 0 restored settles on workspaces = [], activeWs = null" outcome:
// a contextless boot now lands on the Home terminal instead (see
// openspec/changes/home-terminal design.md D2/D5). An undefined bootWs must
// still never crash activeWs computation.
//
// A repoId:null ("manual") lane distinct from Home can still exist — via the
// surviving creation path, createWorkspace({ repoId: null, ... }) — and the
// render path (derived selectors + pure status/port helpers) must stay
// null-safe for it, same as before.
// ══════════════════════════════════════════════════════════════════════════════

const HOME = "/Users/michaelromain";
const SETTINGS = storeMod.DEFAULT_SETTINGS;
type BootInfo = import("../src/state/store").BootInfo;
type PersistedWs = import("../src/lib/workspace").PersistedWs;

function repoWs(overrides: Partial<PersistedWs> = {}): PersistedWs {
  return {
    id: "w-gody", repoId: "/Users/michaelromain/Dev/gody", title: "GODY-123", issueKey: "GODY-123",
    branch: "feat/x", baseBranch: "develop", dir: "/Users/michaelromain/Dev/gody", preset: null,
    jiraStatus: "In Progress", jiraUrl: null, jiraSync: false, env: {}, createdAt: 1, lastActive: 2,
    ...overrides,
  };
}

describe("init boot-lane — empty-startup-state", () => {
  it("guard: this file's real store is loaded (init is a function)", () => {
    expect(typeof useStore.getState().init).toBe("function");
  });

  it("repo lane: boot.repo set, nothing restored → one repo lane active, plus the always-present Home terminal", () => {
    const boot: BootInfo = { repo: { root: "/repo", name: "repo", defaultBranch: "main", currentBranch: "main" }, restored: [], activeWs: null };
    useStore.getState().init(HOME, SETTINGS, false, boot);
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(2);
    const bootWs = s.workspaces.find((w) => w.repoId === "/repo")!;
    expect(bootWs).toBeDefined();
    expect(s.activeWs).toBe(bootWs.id);
    expect(s.initialized).toBe(true);
    // The Home terminal is present but not active.
    const home = s.workspaces.find((w) => w.kind === "home")!;
    expect(home).toBeDefined();
    expect(home.repoId).toBeNull();
    expect(s.activeWs).not.toBe(home.id);
  });

  it("contextless boot: no repo, nothing restored → the Home terminal is synthesized and active (never activeWs=null)", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].kind).toBe("home");
    expect(s.workspaces[0].repoId).toBeNull();
    expect(s.workspaces[0].dir).toBe(HOME);
    expect(s.activeWs).toBe(s.workspaces[0].id);
    expect(s.activeWs).not.toBeNull();
    expect(s.initialized).toBe(true);
    expect(activeWorkspace(s)).toBeDefined();
  });

  it("contextless boot persists across a relaunch: Home is reused, not duplicated, on the second init", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
    const firstHomeId = useStore.getState().workspaces[0].id;
    // Simulate the next launch: persisted Home comes back through `restored`.
    const persistedHome = useStore.getState().workspaces.map((w) => ({
      id: w.id, kind: w.kind, repoId: w.repoId, title: w.title, issueKey: w.issueKey,
      branch: w.branch, baseBranch: w.baseBranch, dir: w.dir, preset: w.preset,
      jiraStatus: w.jiraStatus, jiraUrl: w.jiraUrl, jiraSync: w.jiraSync, env: w.env,
      createdAt: w.createdAt, lastActive: w.lastActive,
    }));
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: persistedHome, activeWs: firstHomeId });
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].id).toBe(firstHomeId);
    expect(s.activeWs).toBe(firstHomeId);
  });

  it("restored repo lane + no boot repo → restored lane active, plus the always-present Home terminal", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [repoWs()], activeWs: "w-gody" });
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(2);
    expect(s.workspaces.some((w) => w.id === "w-gody")).toBe(true);
    expect(s.activeWs).toBe("w-gody");
    expect(s.workspaces.filter((w) => w.kind === "home")).toHaveLength(1);
  });

  it("restored lane + invalid activeWs → falls back to the Home terminal, not workspaces[0]; no crash on undefined bootWs", () => {
    expect(() =>
      useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [repoWs()], activeWs: "does-not-exist" }),
    ).not.toThrow();
    const s = useStore.getState();
    const home = s.workspaces.find((w) => w.kind === "home")!;
    expect(s.activeWs).toBe(home.id);
  });

  it("boot repo already among restored (same dir) → reused, not duplicated", () => {
    useStore.getState().init(HOME, SETTINGS, false, {
      repo: { root: "/Users/michaelromain/Dev/gody", name: "gody", defaultBranch: "develop", currentBranch: "feat/x" },
      restored: [repoWs()], activeWs: "w-gody",
    });
    const s = useStore.getState();
    expect(s.workspaces.filter((w) => w.id === "w-gody")).toHaveLength(1);
    expect(s.activeWs).toBe("w-gody");
  });

  it("exactly one workspace is mounted (the active one); Home stays unmounted when not active", () => {
    useStore.getState().init(HOME, SETTINGS, false, {
      repo: null,
      restored: [repoWs(), repoWs({ id: "w-2", dir: "/Users/michaelromain/Dev/two", repoId: "/Users/michaelromain/Dev/two", title: "two" })],
      activeWs: "w-2",
    });
    const s = useStore.getState();
    expect(s.workspaces.filter((w) => w.mounted)).toHaveLength(1);
    expect(s.workspaces.find((w) => w.mounted)!.id).toBe("w-2");
    expect(s.workspaces.find((w) => w.kind === "home")!.mounted).toBe(false);
  });
});

describe("manual lane (repoId:null) is null-safe — regression", () => {
  // init() no longer synthesizes a manual lane on a contextless boot — it
  // synthesizes the permanent Home terminal instead (kind: "home"). A
  // repoId:null "manual" lane distinct from Home is still only created via an
  // explicit createWorkspace({ repoId: null, ... }) call — start from a
  // contextless boot (which now lands on Home), then create a manual lane on
  // top, to keep this regression coverage alive.
  beforeEach(() => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
    useStore.getState().createWorkspace({ repoId: null, title: "manual", dir: HOME, branch: null });
  });

  it("active workspace is the manual lane with null repo/branch and empty base", () => {
    const ws = activeWorkspace(useStore.getState())!;
    expect(ws.repoId).toBeNull();
    expect(ws.branch).toBeNull();
    expect(ws.baseBranch).toBe("");
    expect(ws.env).toEqual({});
  });

  it("active selectors resolve (no undefined tab/pane) for the manual lane", () => {
    const s = useStore.getState();
    expect(activeGroup(s)).toBeDefined();
    expect(activePane(s)).toBeDefined();
    expect(activePane(s)!.repoRoot).toBeNull();
  });

  it("status helpers do not throw and report a manual lane", () => {
    const ws = activeWorkspace(useStore.getState())!;
    expect(() => statusOf(ws)).not.toThrow();
    expect(statusOf(ws)).toBe("idle");
    expect(statusLine(ws).text).toBe("manual branch");
  });

  it("port helpers are null-safe for an empty env + no scripts", () => {
    const ws = activeWorkspace(useStore.getState())!;
    expect(Number.isNaN(ports.readOffset(ws.env))).toBe(true);
    expect(ports.parseDerivedPorts([], NaN)).toEqual([]);
    expect(ports.portScripts([])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// createWorkspace on top of a contextless (Home-only) boot + the non-goal guard
// ══════════════════════════════════════════════════════════════════════════════

describe("createWorkspace on top of the Home-only boot", () => {
  it("createWorkspace from a Home-only store sets activeWs to the new workspace's id", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(useStore.getState().workspaces[0].kind).toBe("home");
    expect(useStore.getState().activeWs).not.toBeNull();

    const id = useStore.getState().createWorkspace({ repoId: null, title: "first", dir: HOME, branch: null });
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(2); // Home + the new lane
    expect(s.activeWs).toBe(id);
    expect(activeWorkspace(s)!.id).toBe(id);
  });
});

describe("removeWorkspace never drops below the Home terminal (non-goal guard)", () => {
  it("refuses to remove the last remaining non-Home workspace's neighbor guard still holds, and Home itself is never removable", () => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
    const homeId = useStore.getState().workspaces[0].id;
    const id = useStore.getState().createWorkspace({ repoId: null, title: "only", dir: HOME, branch: null });
    expect(useStore.getState().workspaces).toHaveLength(2);

    // Home itself refuses removal even with >1 workspace present.
    useStore.getState().removeWorkspace(homeId);
    expect(useStore.getState().workspaces.some((w) => w.id === homeId)).toBe(true);

    // The ordinary lane can still be removed (Home remains as the floor).
    useStore.getState().removeWorkspace(id);
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].id).toBe(homeId);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// introSeen — the one-time "Introducing Workspaces" flag (workspaces-intro-dialog)
// ══════════════════════════════════════════════════════════════════════════════

describe("introSeen — persisted onboarding flag + dismissIntro()", () => {
  beforeEach(() => {
    useStore.getState().init(HOME, SETTINGS, false, { repo: null, restored: [], activeWs: null });
  });

  it("fresh install: init() with DEFAULT_SETTINGS (no persisted settings at all) defaults introSeen to false", () => {
    expect(useStore.getState().settings.introSeen).toBe(false);
  });

  it("updater path: stored settings predating the flag (App.tsx's boot merge `{ ...DEFAULT_SETTINGS, ...parsed }`) default introSeen to false without dropping other persisted settings", () => {
    // A pre-upgrade user's stored aurora.settings has no introSeen key at all.
    const storedFromBeforeThisFeature = { model: "claude-opus-4-8", accent: "amber" };
    expect("introSeen" in storedFromBeforeThisFeature).toBe(false);
    const merged = { ...storeMod.DEFAULT_SETTINGS, ...storedFromBeforeThisFeature };

    useStore.getState().init(HOME, merged, false, { repo: null, restored: [], activeWs: null });

    const s = useStore.getState();
    expect(s.settings.introSeen).toBe(false); // defaulted, not left undefined
    expect(s.settings.model).toBe("claude-opus-4-8"); // other persisted settings survive the merge
    expect(s.settings.accent).toBe("amber");
  });

  it("dismissIntro() sets settings.introSeen to true and persists it to aurora.settings", () => {
    expect(useStore.getState().settings.introSeen).toBe(false);

    useStore.getState().dismissIntro();

    expect(useStore.getState().settings.introSeen).toBe(true);
    const raw = localStorage.getItem("aurora.settings");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).introSeen).toBe(true);
  });

  it("dismissIntro() persists introSeen without clobbering other settings already in place", () => {
    useStore.getState().init(HOME, { ...storeMod.DEFAULT_SETTINGS, accent: "amber" }, false, {
      repo: null,
      restored: [],
      activeWs: null,
    });

    useStore.getState().dismissIntro();

    const parsed = JSON.parse(localStorage.getItem("aurora.settings")!);
    expect(parsed.accent).toBe("amber");
    expect(parsed.introSeen).toBe(true);
  });
});
