// Headline end-to-end integration test for managed-server-lifecycle (task 4.7).
//
// Drives the REAL Zustand store through the public entry points of all three
// orchestrators — create.ts, servers.ts, teardown.ts — plus server.ts and
// ports.ts, with only the Tauri `invoke` boundary doubled (server_spawn/
// status/stop/probe, worktree_*, pty_*, read/write_text_file). No internal
// function is called directly; every step goes through the same API surface
// the UI does.
//
// Flow under test (one continuous workspace lifecycle):
//   create (aurora.json setup/run/archive loaded, port offset allocated)
//     -> scripts.setup runs in the workspace's pane (prelude -> pty_write)
//     -> run.web spawns a managed process (server_spawn)
//     -> poll probes the bound port -> "up", ports recorded
//     -> a second workspace's server binds the SAME port -> collision detected
//     -> stop frees the port ("down", server_stop)
//     -> teardown runs scripts.archive, then removes the worktree
//     -> the freed port offset is reused by the next create
//
// This is the one test in the suite that spans create -> run -> probe ->
// collision -> stop -> archive -> teardown -> reclaim in a single flow; each
// phase individually already has narrower coverage elsewhere (create.cov,
// servers.cov, teardown.cov, ports.cov) — this test proves they compose.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import { runCreate, type CreateSpec } from "../src/lib/create";
import { deleteWorkspace } from "../src/lib/teardown";
import { runOneRunCommand, stopServer, serversUp, managedServerId, runCommandId, ensureServerPoll, stopServerPoll } from "../src/lib/servers";

const REPO_ROOT = "/repo/aurora";
const REPO_NAME = "aurora";

const AURORA_JSON = JSON.stringify({
  version: 1,
  scripts: {
    setup: "bun install",
    run: [{ command: "bun run dev", name: "web" }],
    archive: "bun run clean",
  },
});

function mkSpec(branch: string, overrides: Partial<CreateSpec> = {}): CreateSpec {
  return {
    repoRoot: REPO_ROOT,
    repoName: REPO_NAME,
    source: "branch",
    issueKey: null,
    title: branch,
    branch,
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
    envFiles: [],
    ...overrides,
  };
}

beforeEach(() => {
  tauri.reset();
  useStore.setState(
    {
      workspaces: [],
      repos: [],
      activeWs: null,
      repoConfigs: {},
      userScripts: {},
      auroraConfigs: {},
      managedServers: {},
      portCollisions: [],
      notifLog: [],
      notifs: [],
      unseen: 0,
      muted: false,
    } as Partial<ReturnType<typeof useStore.getState>>,
    false,
  );
  stopServerPoll();
  tauri.invoke({
    validate_branch_name: () => ({ ok: true, message: null, enforced: false }),
    path_resolve: (a) => a.path as string,
    list_dir: () => [], // no lockfile: prelude comes from aurora.json's setup, not install-inference
    read_text_file: () => AURORA_JSON,
    worktree_add: () => ({}),
  });
});

afterEach(() => {
  stopServerPoll();
});

describe("managed-server-lifecycle — full end-to-end flow (task 4.7)", () => {
  it("create -> setup runs -> run spawns -> probe (up) -> collision -> stop (down) -> archive -> teardown -> port reclaimed", async () => {
    // Capture the poll's tick function instead of waiting on the real 1.5s
    // interval — same technique as servers.cov.test.tsx's poll suite.
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    let tick: (() => Promise<void>) | null = null;
    (globalThis as unknown as { setInterval: unknown }).setInterval = ((cb: () => Promise<void>) => {
      tick = cb;
      return 999 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as unknown as { clearInterval: unknown }).clearInterval = (() => {}) as typeof clearInterval;

    try {
      // ── 1. Create workspace A ────────────────────────────────────────────
      const rA = await runCreate(mkSpec("feat/a"));
      expect(rA.ok).toBe(true);
      const wsAId = rA.ok ? rA.wsId : "";

      const wsA = () => useStore.getState().workspaces.find((w) => w.id === wsAId)!;
      expect(wsA().env.AURORA_PORT_OFFSET).toBe("0"); // first auto-allocation
      expect(wsA().env.AURORA_PORT).toBe("3000"); // AURORA_PORT_BASE + 0
      // The repo's aurora.json was loaded and cached as part of create (task 4.4).
      expect(useStore.getState().auroraConfigs[REPO_ROOT]?.scripts.run[0]).toBeDefined();

      // ── 2. scripts.setup runs into the workspace's pane ─────────────────
      // create.ts resolved `prelude = commandSpecToShell(setup) ?? install` and
      // wrote it via runCommand -> runWhenReady, which polls (real 60ms timer)
      // until the pane has a live PTY. Simulate the pane's shell coming up
      // (what Terminal.tsx's mount effect does in the real app), then let the
      // pending timer fire and observe the command actually reach pty_write.
      const paneA = wsA().tabs[wsA().active].panes[0];
      useStore.getState().setPaneRuntime(paneA.id, { ptyId: "pty-a", isZsh: false });
      useStore.getState().setReady(paneA.id);
      await new Promise((r) => setTimeout(r, 200)); // let the queued runWhenReady retry land

      const setupWrite = tauri.calls().find((c) => c.cmd === "pty_write" && c.args.id === "pty-a");
      expect(setupWrite).toBeDefined();
      expect(String(setupWrite!.args.data)).toContain("bun install");

      // ── 3. run[0] spawns a managed process ──────────────────────────────
      await runOneRunCommand(wsAId, 0);
      const spawnA = tauri.lastCall("server_spawn")!;
      expect(spawnA.args).toMatchObject({ id: managedServerId(wsAId, runCommandId(0)), command: "bun run dev", args: [], cwd: wsA().dir });
      expect(useStore.getState().managedServers[managedServerId(wsAId, runCommandId(0))]).toMatchObject({ status: "running" });
      expect(tick).not.toBeNull(); // runOneRunCommand's spawn kicked ensureServerPoll()

      // ── 4. Poll probes the bound port -> up ──────────────────────────────
      tauri.invoke({ server_status: () => ({ state: "running" }), server_probe: () => [3000] });
      await tick!();
      expect(useStore.getState().managedServers[managedServerId(wsAId, runCommandId(0))]).toMatchObject({ ports: [3000] });
      expect(serversUp(wsAId, useStore.getState().managedServers)).toBe(true);
      expect(useStore.getState().portCollisions).toEqual([]); // 3000 is inside A's [3000,3009] range, sole owner

      // ── 5. Workspace B's server binds the SAME port -> collision ────────
      tauri.invoke({ worktree_add: () => ({}) });
      const rB = await runCreate(mkSpec("feat/b"));
      expect(rB.ok).toBe(true);
      const wsBId = rB.ok ? rB.wsId : "";
      expect(useStore.getState().workspaces.find((w) => w.id === wsBId)?.env.AURORA_PORT_OFFSET).toBe("10");

      await runOneRunCommand(wsBId, 0);
      // Both A and B now probe port 3000 — shared across workspaces, and
      // outside B's own reserved [3010,3019] range.
      tauri.invoke({ server_probe: () => [3000] });
      await tick!();

      const collisions = useStore.getState().portCollisions;
      expect(collisions.some((c) => c.wsId === wsAId && c.reason === "shared-with-another-workspace")).toBe(true);
      expect(collisions.some((c) => c.wsId === wsBId && c.reason === "shared-with-another-workspace")).toBe(true);
      expect(collisions.some((c) => c.wsId === wsBId && c.reason === "outside-range")).toBe(true);
      expect(useStore.getState().notifLog.some((n) => n.headline.includes("Port collision"))).toBe(true);

      // ── 6. Stop frees the port -> down ───────────────────────────────────
      await stopServer(wsAId, runCommandId(0));
      expect(tauri.lastCall("server_stop")!.args).toEqual({ id: managedServerId(wsAId, runCommandId(0)) });
      expect(useStore.getState().managedServers[managedServerId(wsAId, runCommandId(0))]).toBeUndefined();
      expect(serversUp(wsAId, useStore.getState().managedServers)).toBe(false);

      // ── 7. Teardown: archive script runs, then the worktree is removed ──
      tauri.invoke({
        server_status: (a) => ((a.id as string).startsWith("archive:") ? { state: "exited", code: 0 } : { state: "running" }),
        worktree_list: () => [
          { path: REPO_ROOT, branch: "main", head: null },
          { path: wsA().dir, branch: "feat/a", head: null },
          { path: useStore.getState().workspaces.find((w) => w.id === wsBId)!.dir, branch: "feat/b", head: null },
        ],
        worktree_remove: () => undefined,
        pty_kill: () => undefined,
      });
      const wsAEnvBefore = wsA().env;
      const rDel = await deleteWorkspace(wsAId);
      expect(rDel).toEqual({ ok: true });

      const archiveSpawn = tauri.calls().find((c) => c.cmd === "server_spawn" && c.args.id === `archive:${wsAId}`);
      expect(archiveSpawn).toBeDefined();
      expect(archiveSpawn!.args).toMatchObject({ command: "bun run clean", args: [] });
      expect(archiveSpawn!.args.env).toEqual(Object.entries(wsAEnvBefore));
      expect(tauri.calls().some((c) => c.cmd === "pty_kill" && c.args.id === "pty-a")).toBe(true);
      expect(useStore.getState().workspaces.some((w) => w.id === wsAId)).toBe(false);

      // ── 8. The freed offset is reused, not skipped ───────────────────────
      tauri.invoke({ worktree_add: () => ({}) });
      const rC = await runCreate(mkSpec("feat/c"));
      expect(rC.ok).toBe(true);
      expect(useStore.getState().workspaces.find((w) => w.id === (rC.ok ? rC.wsId : ""))?.env.AURORA_PORT_OFFSET).toBe("0");
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
    }
  });
});
