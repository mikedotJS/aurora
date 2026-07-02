// Coverage suite for src/lib/teardown.ts — deleteWorkspace orchestrator.
//
// Drives the REAL Zustand store (src/state/store.ts) via useStore.setState(),
// with only the Tauri leaf mocked (test/mocks/tauri.ts, wired by the preload).
// worktree.ts, sys.ts, term/pty.ts and store.ts all run for real against invoke().

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, type Workspace, type Group, type PaneState } from "../src/state/store";
import { deleteWorkspace } from "../src/lib/teardown";

let paneIdSeq = 700000;

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: paneIdSeq++,
    ptyId: null,
    ptyEpoch: 0,
    isZsh: false,
    cwd: "/repo/wt",
    branch: null,
    input: "",
    ghost: "",
    history: [],
    hIndex: -1,
    suggestion: null,
    suggestionLoading: false,
    pendingFix: null,
    completion: null,
    inputSelected: false,
    rawMode: false,
    exited: false,
    ready: false,
    dirNames: [],
    blocks: [],
    repoRoot: null,
    firedHooks: [],
    hook: null,
    ...overrides,
  };
}

function mkGroup(overrides: Partial<Group> = {}): Group {
  return { id: 600000 + Math.floor(Math.random() * 100000), panes: [mkPane()], active: 0, split: "h", ...overrides };
}

const REPO = "/repo";
const WT_DIR = "/repo/.aurora-worktrees/feat-x";

function mkWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws1",
    repoId: REPO,
    title: "feat/x",
    issueKey: null,
    branch: "feat/x",
    baseBranch: "main",
    dir: WT_DIR,
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [mkGroup()],
    active: 0,
    createdAt: 1,
    lastActive: 1,
    serverTabId: null,
    ...overrides,
  };
}

function resetStore(patch: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState(
    {
      repos: [],
      workspaces: [],
      activeWs: null,
      ...patch,
    } as Partial<ReturnType<typeof useStore.getState>>,
    false,
  );
}

beforeEach(() => {
  tauri.reset();
  tauri.invoke({
    pty_kill: () => undefined,
    worktree_remove: () => undefined,
    worktree_list: () => [
      { path: REPO, branch: "main", head: null },
      { path: WT_DIR, branch: "feat/x", head: null },
    ],
    path_resolve: (a) => a.path as string,
  });
});

describe("guard: workspace not found", () => {
  it("returns ok:false with a 'not found' message and makes zero side-effect calls", async () => {
    resetStore({ workspaces: [mkWs({ id: "a" }), mkWs({ id: "b" })], activeWs: "a" });
    const r = await deleteWorkspace("missing");
    expect(r).toEqual({ ok: false, error: "workspace not found" });
    expect(tauri.calls().length).toBe(0);
  });
});

describe("guard: last workspace", () => {
  it("refuses to remove the only remaining workspace", async () => {
    resetStore({ workspaces: [mkWs({ id: "only" })], activeWs: "only" });
    const r = await deleteWorkspace("only");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/last/i);
    expect(tauri.calls().length).toBe(0);
  });
});

describe("guard: manual lane (repoId == null)", () => {
  it("succeeds without ever calling worktreeList/worktreeRemove, still kills PTYs and drops the store entry", async () => {
    resetStore({
      workspaces: [
        mkWs({ id: "manual", repoId: null, dir: "/manual/path", tabs: [mkGroup({ panes: [mkPane({ ptyId: "pty-m" })] })] }),
        mkWs({ id: "other" }),
      ],
      activeWs: "manual",
    });
    const r = await deleteWorkspace("manual");
    expect(r).toEqual({ ok: true });
    expect(tauri.calls().some((c) => c.cmd === "worktree_list")).toBe(false);
    expect(tauri.calls().some((c) => c.cmd === "worktree_remove")).toBe(false);
    expect(tauri.lastCall("pty_kill")?.args).toEqual({ id: "pty-m" });
    expect(useStore.getState().workspaces.some((w) => w.id === "manual")).toBe(false);
  });
});

describe("guard: main checkout (dir === repoId, exact match)", () => {
  it("refuses before touching PTYs or the worktree registry", async () => {
    resetStore({
      workspaces: [mkWs({ id: "main-ws", repoId: REPO, dir: REPO }), mkWs({ id: "other" })],
      activeWs: "main-ws",
    });
    const r = await deleteWorkspace("main-ws");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/main checkout/i);
    expect(tauri.calls().length).toBe(0); // zero side effects: no pty.kill, no worktreeList
    expect(useStore.getState().workspaces.some((w) => w.id === "main-ws")).toBe(true);
  });
});

describe("guard: dir not a registered secondary worktree", () => {
  it("aborts WITHOUT killing PTYs when dir is absent from the worktree registry", async () => {
    tauri.invoke({ worktree_list: () => [{ path: REPO, branch: "main", head: null }] }); // no secondary
    resetStore({ workspaces: [mkWs({ id: "gone" }), mkWs({ id: "other" })], activeWs: "gone" });
    const r = await deleteWorkspace("gone");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/not a registered removable worktree/i);
    expect(tauri.calls().some((c) => c.cmd === "pty_kill")).toBe(false);
    expect(tauri.calls().some((c) => c.cmd === "worktree_remove")).toBe(false);
    expect(useStore.getState().workspaces.some((w) => w.id === "gone")).toBe(true);
  });

  it("resolves symlinked dirs before comparing (a canonical match still succeeds)", async () => {
    tauri.invoke({
      worktree_list: () => [
        { path: REPO, branch: "main", head: null },
        { path: "/private/tmp/wt", branch: "feat/x", head: null }, // canonical form
      ],
      path_resolve: () => "/private/tmp/wt", // dir "/tmp/wt" resolves to the canonical form
      worktree_remove: () => undefined,
    });
    resetStore({ workspaces: [mkWs({ id: "sym", dir: "/tmp/wt" }), mkWs({ id: "other" })], activeWs: "sym" });
    const r = await deleteWorkspace("sym");
    expect(r).toEqual({ ok: true });
  });
});

describe("PTY collection + call order", () => {
  it("kills only non-null ptyIds across multiple tabs/panes, all before worktreeRemove", async () => {
    const order: string[] = [];
    tauri.invoke({
      pty_kill: (a) => {
        order.push(`kill:${a.id}`);
        return undefined;
      },
      worktree_remove: () => {
        order.push("worktreeRemove");
        return undefined;
      },
    });
    resetStore({
      workspaces: [
        mkWs({
          id: "multi",
          tabs: [
            mkGroup({ panes: [mkPane({ ptyId: "pty-1" }), mkPane({ ptyId: null }), mkPane({ ptyId: "pty-2" })] }),
            mkGroup({ panes: [mkPane({ ptyId: null }), mkPane({ ptyId: "pty-3" })] }),
          ],
        }),
        mkWs({ id: "other" }),
      ],
      activeWs: "multi",
    });
    const r = await deleteWorkspace("multi");
    expect(r).toEqual({ ok: true });
    const killed = order.filter((e) => e.startsWith("kill:")).sort();
    expect(killed).toEqual(["kill:pty-1", "kill:pty-2", "kill:pty-3"]);
    expect(order.indexOf("worktreeRemove")).toBe(order.length - 1); // remove happens last
  });

  it("makes zero pty.kill calls when every pane has ptyId==null", async () => {
    resetStore({
      workspaces: [
        mkWs({ id: "noPty", tabs: [mkGroup({ panes: [mkPane({ ptyId: null }), mkPane({ ptyId: null })] })] }),
        mkWs({ id: "other" }),
      ],
      activeWs: "noPty",
    });
    await deleteWorkspace("noPty");
    expect(tauri.calls().some((c) => c.cmd === "pty_kill")).toBe(false);
  });
});

describe("rollback: worktreeRemove failure", () => {
  it("does not drop the store entry, and surfaces the git error", async () => {
    tauri.invoke({
      worktree_remove: () => {
        throw new Error("git locked");
      },
    });
    resetStore({ workspaces: [mkWs({ id: "fail" }), mkWs({ id: "other" })], activeWs: "fail" });
    const r = await deleteWorkspace("fail");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain("git locked");
    expect(useStore.getState().workspaces.some((w) => w.id === "fail")).toBe(true); // NOT dropped
  });
});

describe("happy path: worktree-backed workspace", () => {
  it("removes the worktree with force=true and drops the workspace, re-pointing activeWs", async () => {
    resetStore({ workspaces: [mkWs({ id: "ok" }), mkWs({ id: "other" })], activeWs: "ok" });
    const r = await deleteWorkspace("ok");
    expect(r).toEqual({ ok: true });
    expect(tauri.lastCall("worktree_remove")?.args).toEqual({ root: REPO, dir: WT_DIR, force: true });
    const state = useStore.getState();
    expect(state.workspaces.map((w) => w.id)).toEqual(["other"]);
    expect(state.activeWs).toBe("other"); // re-pointed off the removed workspace
  });
});
