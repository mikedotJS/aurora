// Coverage suite for src/components/ManagedServerPane.tsx — the Servers-tab
// pane rendering for a MANAGED process (subscribes to its own "server:data"
// stream and feeds the block model directly; no xterm/shell involved). Only
// invoke/Tauri leaf used indirectly is the event bus (via serverHub), driven
// through the shared tauri mock's emit().

import { describe, it, expect, afterEach } from "bun:test";
import { render, cleanup, act } from "@testing-library/react";
import { tauri } from "../test/mocks/tauri";
import { useStore, type Workspace } from "../src/state/store";
import { ManagedServerPane } from "../src/components/ManagedServerPane";

function mkWs(paneId: number, serverId: string): Workspace {
  return {
    id: "ws1",
    kind: "workspace",
    repoId: "/repo",
    title: "t",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: "/repo",
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    active: 0,
    createdAt: 1,
    lastActive: 1,
    serverTabId: 1,
    tabs: [
      {
        id: 1,
        active: 0,
        split: "h",
        panes: [
          {
            id: paneId,
            ptyId: null,
            ptyEpoch: 0,
            isZsh: false,
            cwd: "/repo",
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
            blocks: [{ id: 1, command: "bun run dev", cwd: "/repo", output: "", exitCode: null, running: true }],
            repoRoot: null,
            firedHooks: [],
            hook: null,
            serverId,
          },
        ],
      },
    ],
  } as unknown as Workspace;
}

function seedPane(paneId: number, serverId: string) {
  useStore.setState({ workspaces: [mkWs(paneId, serverId)], activeWs: "ws1" } as Partial<
    ReturnType<typeof useStore.getState>
  >, false);
}

function firstBlock(paneId: number) {
  const ws = useStore.getState().workspaces[0];
  return ws.tabs[0].panes.find((p) => p.id === paneId)!.blocks[0];
}

async function flushRaf() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 0));
  });
}

// NOTE: no tauri.reset() here (same rationale as server.cov.test.tsx) —
// serverHub is a module singleton that registers its "server:data" listener
// exactly once, eagerly, at import time; a reset() would wipe it for the rest
// of this file.
afterEach(() => {
  cleanup();
});

describe("ManagedServerPane", () => {
  it("marks the pane ready on mount", () => {
    seedPane(9501, "ws1:web-1");
    render(<ManagedServerPane paneId={9501} serverId="ws1:web-1" />);
    const pane = useStore.getState().workspaces[0].tabs[0].panes[0];
    expect(pane.ready).toBe(true);
  });

  it("appends server:data output into the running block, batched", async () => {
    seedPane(9502, "ws1:web-2");
    render(<ManagedServerPane paneId={9502} serverId="ws1:web-2" />);
    tauri.emit("server:data", { id: "ws1:web-2", data: btoa("hello from server\n") });
    await flushRaf();
    expect(firstBlock(9502).output).toContain("hello from server");
  });

  it("multiple chunks in one tick coalesce into a single appendOutput call's worth of text", async () => {
    seedPane(9503, "ws1:web-3");
    render(<ManagedServerPane paneId={9503} serverId="ws1:web-3" />);
    tauri.emit("server:data", { id: "ws1:web-3", data: btoa("chunk1 ") });
    tauri.emit("server:data", { id: "ws1:web-3", data: btoa("chunk2") });
    await flushRaf();
    expect(firstBlock(9503).output).toBe("chunk1 chunk2");
  });

  it("ignores output for a different serverId", async () => {
    seedPane(9504, "ws1:web-4");
    render(<ManagedServerPane paneId={9504} serverId="ws1:web-4" />);
    tauri.emit("server:data", { id: "ws1:other", data: btoa("nope") });
    await flushRaf();
    expect(firstBlock(9504).output).toBe("");
  });

  it("unsubscribes on unmount — output emitted after unmount is not appended", async () => {
    seedPane(9505, "ws1:web-5");
    const { unmount } = render(<ManagedServerPane paneId={9505} serverId="ws1:web-5" />);
    unmount();
    await flushRaf();
    tauri.emit("server:data", { id: "ws1:web-5", data: btoa("late") });
    await flushRaf();
    expect(firstBlock(9505).output).toBe("");
  });
});
