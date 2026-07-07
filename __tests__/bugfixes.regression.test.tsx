/// <reference types="bun-types" />
// Regression tests for bugs found + adversarially verified by the bug-hunt pass.
// Each test fails against the pre-fix code and passes after the fix.

import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore } from "../src/state/store";
import { runCreate, type CreateSpec } from "../src/lib/create";

// ── Bug 1: concurrent same-repo creates must not share an AURORA_PORT_OFFSET ──
// allocOffset reads the store's live workspaces, but the picked offset isn't
// registered until createWorkspace — and materializeEnvFiles awaits in between.
// Two overlapping creates for the same repo used to both read a stale used-set
// and allocate offset 0. runCreate now serializes per repoRoot.
describe("runCreate — concurrent creates for the same repo (port-offset race)", () => {
  beforeEach(() => {
    tauri.reset();
    useStore.setState({ workspaces: [], repos: [], activeWs: null, repoConfigs: {} }, false);
    tauri.invoke({
      validate_branch_name: () => ({ ok: true, message: null, enforced: false }),
      worktree_add: () => ({ path: "/repo/.aurora-worktrees/aurora/x", branch: "x", head: "abc" }),
      list_dir: () => [], // no lockfile → no install step
    });
  });

  function spec(branch: string): CreateSpec {
    return {
      repoRoot: "/repo/aurora",
      repoName: "aurora",
      source: "branch",
      issueKey: null,
      title: branch,
      branch,
      baseBranch: "main",
      newBranch: true,
      preset: null,
      scriptName: null,
      paneCount: 1,
      jiraStatus: null,
      jiraUrl: null,
      jiraSync: false,
      env: {},
      portOffset: "auto",
      // envFiles force the materializeEnvFiles await between allocOffset and
      // createWorkspace — the exact window the race needed.
      envFiles: [{ path: ".env.local", content: "PORT=${port:3000}\n" }],
    };
  }

  it("allocates distinct offsets when two same-repo creates overlap", async () => {
    const [a, b] = await Promise.all([runCreate(spec("feat/a")), runCreate(spec("feat/b"))]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const offsets = useStore
      .getState()
      .workspaces.map((w) => w.env.AURORA_PORT_OFFSET)
      .sort();
    expect(offsets).toEqual(["0", "10"]);
  });
});

// ── Bug 2: serverTabId must survive tab merges / clears cleanly ────────────────
// serverTabId is a stable Group id used by serversUp()/stopServers(). Merging
// the server tab into another moves its panes but removed the source group, so
// serverTabId dangled; closing the server tab left it pointing at nothing.
describe("mergeTabs / closeTab — serverTabId reconciliation", () => {
  beforeEach(() => {
    useStore.setState({ workspaces: [], repos: [], activeWs: null }, false);
  });

  function twoTabWorkspaceWithServerTab(serverTabIndex: number): { wsId: string } {
    const wsId = useStore.getState().createWorkspace({ repoId: "/r", title: "t", dir: "/r", branch: "main" });
    useStore.setState({ activeWs: wsId }, false);
    useStore.getState().newTab(); // now two tabs
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    const serverTabId = ws.tabs[serverTabIndex].id;
    useStore.setState(
      { workspaces: useStore.getState().workspaces.map((w) => (w.id === wsId ? { ...w, serverTabId } : w)) },
      false,
    );
    return { wsId };
  }

  it("mergeTabs re-points serverTabId to the merged group when the server tab is the source", () => {
    const { wsId } = twoTabWorkspaceWithServerTab(0); // server tab = index 0
    const before = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    const targetId = before.tabs[1].id;
    useStore.getState().mergeTabs(0, 1); // merge server tab (0) into tab 1
    const after = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0].id).toBe(targetId); // merged group keeps the target's id
    expect(after.serverTabId).toBe(targetId); // re-pointed, not dangling
    expect(useStore.getState().workspaces.find((w) => w.id === wsId)!.tabs[0].id).toBe(after.serverTabId);
  });

  it("mergeTabs leaves serverTabId untouched when the server tab is the destination", () => {
    const { wsId } = twoTabWorkspaceWithServerTab(1); // server tab = index 1 (dest)
    const destId = useStore.getState().workspaces.find((w) => w.id === wsId)!.tabs[1].id;
    useStore.getState().mergeTabs(0, 1);
    const after = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    expect(after.serverTabId).toBe(destId);
  });

  it("closeTab clears serverTabId when the closed tab is the server tab", () => {
    const { wsId } = twoTabWorkspaceWithServerTab(0);
    useStore.getState().closeTab(0);
    const after = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    expect(after.serverTabId).toBeNull();
  });

  it("closeTab keeps serverTabId when a non-server tab is closed", () => {
    const { wsId } = twoTabWorkspaceWithServerTab(1); // server tab = index 1
    const serverId = useStore.getState().workspaces.find((w) => w.id === wsId)!.tabs[1].id;
    useStore.getState().closeTab(0); // close the non-server tab
    const after = useStore.getState().workspaces.find((w) => w.id === wsId)!;
    expect(after.serverTabId).toBe(serverId);
  });
});
