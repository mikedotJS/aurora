// Coverage suite for the store's `cd` frecency wiring:
//  - setCwd (src/state/store.ts) bumps aurora.dirFrecency only for home-workspace
//    panes, and only on a real cwd change.
//  - openCdSuggest/moveCdSuggest/acceptCdSuggest/closeCdSuggest (the popover
//    reducers) — acceptCdSuggest completes the input WITHOUT sending anything
//    to the pty; closeCdSuggest/Escape leave input untouched.
import { describe, it, expect, beforeEach } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, findPane, type PaneState } from "../src/state/store";
import { loadDirFrecency } from "../src/lib/dirFrecency";

function mkPane(kind: "home" | "workspace", dir = "/Users/test/proj"): number {
  const wsId = useStore.getState().createWorkspace({ repoId: null, title: "t" + Math.random(), dir, branch: null, kind });
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
  return ws.tabs[0].panes[0].id;
}
function pane(id: number): PaneState {
  return findPane(useStore.getState(), id)!;
}

beforeEach(() => {
  localStorage.clear();
  tauri.reset();
});

describe("setCwd — frecency increment is home-only", () => {
  it("a cwd change in a home-workspace pane bumps aurora.dirFrecency", () => {
    const id = mkPane("home", "/Users/test");
    useStore.getState().setCwd(id, "/Users/test/newdir");
    const data = loadDirFrecency();
    expect(data["/Users/test/newdir"]).toBeDefined();
    expect(data["/Users/test/newdir"].count).toBe(1);
  });

  it("a cwd change in a non-home workspace pane does NOT bump frecency", () => {
    const id = mkPane("workspace", "/Users/test/repo");
    useStore.getState().setCwd(id, "/Users/test/repo/sub");
    const data = loadDirFrecency();
    expect(data["/Users/test/repo/sub"]).toBeUndefined();
    expect(Object.keys(data).length).toBe(0);
  });

  it("repeating the same cwd is a no-op — does not double-increment", () => {
    const id = mkPane("home", "/Users/test");
    useStore.getState().setCwd(id, "/Users/test/newdir");
    useStore.getState().setCwd(id, "/Users/test/newdir"); // same cwd again
    const data = loadDirFrecency();
    expect(data["/Users/test/newdir"].count).toBe(1);
  });

  it("two distinct cwd changes in the home pane bump the count for each transition", () => {
    const id = mkPane("home", "/Users/test");
    useStore.getState().setCwd(id, "/Users/test/a");
    useStore.getState().setCwd(id, "/Users/test/b");
    useStore.getState().setCwd(id, "/Users/test/a"); // back to a: a real change again (b -> a)
    const data = loadDirFrecency();
    expect(data["/Users/test/a"].count).toBe(2);
    expect(data["/Users/test/b"].count).toBe(1);
  });

  it("still updates pane.cwd for a non-home pane even though frecency isn't touched", () => {
    const id = mkPane("workspace");
    useStore.getState().setCwd(id, "/elsewhere");
    expect(pane(id).cwd).toBe("/elsewhere");
  });
});

describe("cdSuggest reducers — accept completes without executing", () => {
  function open(id: number, items: string[]) {
    useStore.getState().openCdSuggest(id, items);
  }

  it("acceptCdSuggest sets input to `cd <path>` and does not write to the pty", () => {
    const id = mkPane("home");
    useStore.getState().setPaneRuntime(id, { ptyId: "pty-1", isZsh: false });
    open(id, ["/a", "/b", "/c"]);
    useStore.getState().acceptCdSuggest(id);
    expect(pane(id).input).toBe("cd /a");
    expect(pane(id).cdSuggest).toBeNull();
    // No command was ever sent to the shell — accept only stages the input.
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("acceptCdSuggest with an explicit index accepts that row, not the current selection", () => {
    const id = mkPane("home");
    open(id, ["/a", "/b", "/c"]);
    useStore.getState().moveCdSuggest(id, 1); // index -> 1 ("/b")
    useStore.getState().acceptCdSuggest(id, 2); // explicit index overrides current selection
    expect(pane(id).input).toBe("cd /c");
  });

  it("acceptCdSuggest is a no-op when there is no open popover", () => {
    const id = mkPane("home");
    useStore.getState().setInput(id, "untouched");
    useStore.getState().acceptCdSuggest(id);
    expect(pane(id).input).toBe("untouched");
  });

  it("closeCdSuggest (Escape) clears the popover without touching input", () => {
    const id = mkPane("home");
    useStore.getState().setInput(id, "cd /so");
    open(id, ["/some/dir"]);
    useStore.getState().closeCdSuggest(id);
    expect(pane(id).cdSuggest).toBeNull();
    expect(pane(id).input).toBe("cd /so");
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("moveCdSuggest wraps the index around the item list", () => {
    const id = mkPane("home");
    open(id, ["/a", "/b", "/c"]);
    useStore.getState().moveCdSuggest(id, -1); // wraps from 0 to last
    expect(pane(id).cdSuggest!.index).toBe(2);
    useStore.getState().moveCdSuggest(id, 1);
    expect(pane(id).cdSuggest!.index).toBe(0);
  });
});
