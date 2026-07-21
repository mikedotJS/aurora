// Coverage suite for src/lib/teardown.ts — deleteWorkspace orchestrator.
//
// Drives the REAL Zustand store (src/state/store.ts) via useStore.setState(),
// with only the Tauri leaf mocked (test/mocks/tauri.ts, wired by the preload).
// worktree.ts, sys.ts, term/pty.ts and store.ts all run for real against invoke().

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, type Workspace, type Group, type PaneState } from "../src/state/store";
import { deleteWorkspace, runArchiveScript } from "../src/lib/teardown";

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
      // Reset the per-repo aurora.json cache + managed-server registry every
      // test — otherwise a config/entry seeded by one test's mocks leaks into
      // the next (ensureAuroraConfigLoaded caches by root and only re-reads
      // `read_text_file` when the store cache is empty).
      auroraConfigs: {},
      managedServers: {},
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
    // Default: no committed aurora.json → default config (no setup/archive).
    read_text_file: () => {
      throw new Error("ENOENT");
    },
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

describe("guard: Home terminal (kind === 'home')", () => {
  // Ported from the retired __tests__/teardown.test.ts (hand-mocked style,
  // superseded by this real-store suite — see that file's own docblock). Its
  // narrow module mocks (a `useStore` shim with only `workspaces`/
  // `removeWorkspace`, and a `sys` mock with only `pathResolve`) can no longer
  // satisfy `deleteWorkspace`'s new dependencies (managed-server-lifecycle:
  // `stopServers` reads `managedServers`, `runArchiveScript` reads
  // `auroraConfigs`/calls real `sys.readTextFile`/`writeTextFile` transitively
  // via lib/auroraConfig.ts) — rather than hand-patch that shim to also fake
  // those, this guard (the one scenario that file covered and this one
  // didn't) is ported here onto the real store, and the old file is deleted.
  it("refuses with an error message matching /home/i, even with other workspaces present, before any side effect", async () => {
    resetStore({
      workspaces: [mkWs({ id: "home", kind: "home" as Workspace["kind"], repoId: null, dir: "/Users/tester" }), mkWs({ id: "other" })],
      activeWs: "home",
    });
    const r = await deleteWorkspace("home");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/home/i);
    expect(tauri.calls().length).toBe(0);
  });

  it("refuses Home even when it is the only workspace (would otherwise also trip the last-workspace guard)", async () => {
    resetStore({
      workspaces: [mkWs({ id: "home", kind: "home" as Workspace["kind"], repoId: null, dir: "/Users/tester" })],
      activeWs: "home",
    });
    const r = await deleteWorkspace("home");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/home/i);
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

// ── scripts.archive (task 4.5) ───────────────────────────────────────────────

describe("scripts.archive: runs before worktree removal", () => {
  it("spawns the configured archive command in the workspace's dir/env, waits for it to exit, then proceeds to worktree_remove", async () => {
    const order: string[] = [];
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: null, run: [], archive: "bun run clean" } }),
      server_spawn: (a) => {
        order.push(`spawn:${a.id}`);
        expect(a.command).toBe("bun run clean");
        expect(a.args).toEqual([]);
        expect(a.cwd).toBe(WT_DIR);
        expect(a.env).toEqual([["FOO", "bar"]]);
        return { pid: 1, pgid: 1, ptyId: "archive-pty" };
      },
      server_status: () => ({ state: "exited", code: 0 }),
      worktree_remove: () => {
        order.push("worktreeRemove");
        return undefined;
      },
    });
    resetStore({ workspaces: [mkWs({ id: "arch", env: { FOO: "bar" } }), mkWs({ id: "other" })], activeWs: "arch" });
    const r = await deleteWorkspace("arch");
    expect(r).toEqual({ ok: true });
    expect(order).toEqual(["spawn:archive:arch", "worktreeRemove"]);
  });

  it("no scripts.archive configured → server_spawn is never called, teardown proceeds normally", async () => {
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: null, run: [], archive: null } }),
    });
    resetStore({ workspaces: [mkWs({ id: "noarch" }), mkWs({ id: "other" })], activeWs: "noarch" });
    const r = await deleteWorkspace("noarch");
    expect(r).toEqual({ ok: true });
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });

  it("a failing spawn is logged, never fails or blocks teardown (best-effort)", async () => {
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: null, run: [], archive: "bun run clean" } }),
      server_spawn: () => {
        throw new Error("spawn exploded");
      },
    });
    resetStore({ workspaces: [mkWs({ id: "boom" }), mkWs({ id: "other" })], activeWs: "boom" });
    const r = await deleteWorkspace("boom");
    expect(r).toEqual({ ok: true });
    expect(tauri.calls().some((c) => c.cmd === "worktree_remove")).toBe(true);
  });

  it("manual lane (repoId == null) never attempts an archive script", async () => {
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: null, run: [], archive: "bun run clean" } }),
    });
    resetStore({
      workspaces: [mkWs({ id: "manual2", repoId: null, dir: "/manual/path2" }), mkWs({ id: "other" })],
      activeWs: "manual2",
    });
    const r = await deleteWorkspace("manual2");
    expect(r).toEqual({ ok: true });
    expect(tauri.calls().some((c) => c.cmd === "server_spawn")).toBe(false);
  });
});

describe("runArchiveScript: bounded timeout", () => {
  it("SIGKILLs (server_stop) a hanging archive script once the timeout elapses, and never throws", async () => {
    let stoppedId: string | null = null;
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: null, run: [], archive: "sleep 999" } }),
      server_status: () => ({ state: "running" }), // never exits on its own
      server_stop: (a) => {
        stoppedId = a.id as string;
        return undefined;
      },
    });
    resetStore();
    const ws = mkWs({ id: "hang" });
    await runArchiveScript(ws, { timeoutMs: 50, pollMs: 10 });
    expect(stoppedId).toBe("archive:hang");
  });

  // Regression (review finding #4): the happy path (archive script exits on
  // its own, before the timeout) used to `return` without ever calling
  // server_stop — leaking the Rust-side registry entry for every normal
  // archive run; only the timeout branch above reaped. Both branches must
  // reap now.
  it("reaps the Rust registry entry (server_stop) on the happy path too, when the script exits on its own", async () => {
    let stoppedId: string | null = null;
    tauri.invoke({
      read_text_file: () =>
        JSON.stringify({ version: 1, scripts: { setup: null, run: [], archive: "bun run clean" } }),
      server_status: () => ({ state: "exited", code: 0 }),
      server_stop: (a) => {
        stoppedId = a.id as string;
        return undefined;
      },
    });
    resetStore();
    const ws = mkWs({ id: "done" });
    await runArchiveScript(ws, { timeoutMs: 5000, pollMs: 10 });
    expect(stoppedId).toBe("archive:done"); // reaped even though it exited well before the timeout
  });
});

// ── managed servers reclaimed on teardown (task 3.3 leak fix) ───────────────

describe("managed servers: stopped before the worktree is removed", () => {
  it("stops a workspace's tracked managed server (real server_stop + store cleanup) before worktree_remove", async () => {
    const order: string[] = [];
    tauri.invoke({
      server_stop: (a) => {
        order.push(`stop:${a.id}`);
        return undefined;
      },
      worktree_remove: () => {
        order.push("worktreeRemove");
        return undefined;
      },
    });
    resetStore({
      workspaces: [mkWs({ id: "srvws" }), mkWs({ id: "other" })],
      activeWs: "srvws",
      managedServers: {
        "srvws:web": { wsId: "srvws", scriptId: "web", paneId: 999999, status: "running", exitCode: null, ports: [3000] },
      },
    });
    const r = await deleteWorkspace("srvws");
    expect(r).toEqual({ ok: true });
    expect(order).toEqual(["stop:srvws:web", "worktreeRemove"]);
    expect(useStore.getState().managedServers["srvws:web"]).toBeUndefined();
  });

  it("a workspace with no managed servers tears down without any server_stop call", async () => {
    resetStore({ workspaces: [mkWs({ id: "clean" }), mkWs({ id: "other" })], activeWs: "clean" });
    const r = await deleteWorkspace("clean");
    expect(r).toEqual({ ok: true });
    expect(tauri.calls().some((c) => c.cmd === "server_stop")).toBe(false);
  });
});
