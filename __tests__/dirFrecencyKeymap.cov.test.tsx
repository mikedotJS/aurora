// Coverage suite for the `cd ` frecency popover as driven through
// handleKeyDown (src/lib/keymap.ts): updateCdSuggest open/update/close on real
// typing, Tab/Enter accept, Escape close, and the ⌥1..9 direct-accept-by-row
// shortcut. Mirrors the harness in __tests__/keymap.cov.test.tsx (real Zustand
// store via createWorkspace, synthetic KeyboardEvent-shaped objects).
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { tauri } from "../test/mocks/tauri";
import { useStore, findPane, DEFAULT_SETTINGS, type PaneState } from "../src/state/store";
import { handleKeyDown } from "../src/lib/keymap";
import { saveDirFrecency } from "../src/lib/dirFrecency";

function mkPane(kind: "home" | "workspace", dir = "/Users/test/proj"): number {
  const wsId = useStore.getState().createWorkspace({ repoId: null, title: "t" + Math.random(), dir, branch: null, kind });
  const ws = useStore.getState().workspaces.find((w) => w.id === wsId)!;
  return ws.tabs[0].panes[0].id;
}
function pane(id: number): PaneState {
  return findPane(useStore.getState(), id)!;
}
function keyEvt(key: string, opts: Record<string, unknown> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    preventDefault: mock(() => {}),
    ...opts,
  } as unknown as KeyboardEvent;
}
function typeChars(s: string) {
  for (const ch of s) handleKeyDown(keyEvt(ch));
}

beforeEach(() => {
  localStorage.clear();
  tauri.reset();
  useStore.setState({
    command: null,
    panel: null,
    settingsOpen: false,
    scriptsSetupOpen: false,
    find: { open: false, query: "", current: 0 },
    keyEntry: false,
    keyError: null,
    apiKeyPresent: false,
    railCollapsed: false,
    settings: { ...DEFAULT_SETTINGS, introSeen: true },
  });
});

describe("updateCdSuggest — opens/updates/closes via real typing", () => {
  it("typing `cd <prefix>` in a home pane opens the popover with matching frecency entries", () => {
    saveDirFrecency({
      "/Users/me/projects": { count: 5, lastVisit: Date.now() },
      "/Users/me/scratch": { count: 5, lastVisit: Date.now() },
    });
    const id = mkPane("home");
    typeChars("cd pro");
    expect(pane(id).cdSuggest).not.toBeNull();
    expect(pane(id).cdSuggest!.items).toEqual(["/Users/me/projects"]);
  });

  it("does NOT open the popover in a non-home workspace pane", () => {
    saveDirFrecency({ "/Users/me/projects": { count: 5, lastVisit: Date.now() } });
    const id = mkPane("workspace");
    typeChars("cd pro");
    expect(pane(id).cdSuggest).toBeNull();
  });

  it("closes the popover once the input no longer matches `cd <token>` (extra space = second arg)", () => {
    saveDirFrecency({ "/Users/me/projects": { count: 5, lastVisit: Date.now() } });
    const id = mkPane("home");
    typeChars("cd pro");
    expect(pane(id).cdSuggest).not.toBeNull();
    typeChars(" x"); // "cd pro x" — a second token, no longer a bare path prefix
    expect(pane(id).cdSuggest).toBeNull();
  });

  it("Backspace back past the `cd ` prefix closes the popover", () => {
    saveDirFrecency({ "/Users/me/projects": { count: 5, lastVisit: Date.now() } });
    const id = mkPane("home");
    typeChars("cd pro");
    expect(pane(id).cdSuggest).not.toBeNull();
    for (let i = 0; i < 6; i++) handleKeyDown(keyEvt("Backspace"));
    expect(pane(id).input).toBe("");
    expect(pane(id).cdSuggest).toBeNull();
  });

  it("no matching frecency entries -> popover stays closed", () => {
    saveDirFrecency({ "/Users/me/projects": { count: 5, lastVisit: Date.now() } });
    const id = mkPane("home");
    typeChars("cd zzz-nope");
    expect(pane(id).cdSuggest).toBeNull();
  });
});

describe("cdSuggest — Tab/Enter accept, Escape close (via handleKeyDown)", () => {
  function openPopover(id: number) {
    saveDirFrecency({ "/Users/me/projects": { count: 5, lastVisit: Date.now() } });
    typeChars("cd pro");
  }

  it("Tab accepts the top suggestion and does not write to the pty", () => {
    const id = mkPane("home");
    useStore.getState().setPaneRuntime(id, { ptyId: "pty-1", isZsh: false });
    openPopover(id);
    handleKeyDown(keyEvt("Tab"));
    expect(pane(id).input).toBe("cd /Users/me/projects");
    expect(pane(id).cdSuggest).toBeNull();
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("Enter also accepts the suggestion (does not submit/execute the line)", () => {
    const id = mkPane("home");
    useStore.getState().setPaneRuntime(id, { ptyId: "pty-1", isZsh: false });
    openPopover(id);
    handleKeyDown(keyEvt("Enter"));
    expect(pane(id).input).toBe("cd /Users/me/projects");
    expect(pane(id).blocks).toEqual([]); // no command was run
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("Escape closes the popover, leaving the typed input untouched", () => {
    const id = mkPane("home");
    openPopover(id);
    const before = pane(id).input;
    handleKeyDown(keyEvt("Escape"));
    expect(pane(id).cdSuggest).toBeNull();
    expect(pane(id).input).toBe(before);
  });

  it("ArrowDown/ArrowUp move the selection instead of falling through to history nav", () => {
    saveDirFrecency({
      "/Users/me/projects": { count: 5, lastVisit: Date.now() },
      "/Users/me/proto": { count: 4, lastVisit: Date.now() },
    });
    const id = mkPane("home");
    typeChars("cd pro");
    expect(pane(id).cdSuggest!.items.length).toBe(2);
    handleKeyDown(keyEvt("ArrowDown"));
    expect(pane(id).cdSuggest!.index).toBe(1);
    handleKeyDown(keyEvt("ArrowUp"));
    expect(pane(id).cdSuggest!.index).toBe(0);
  });
});

describe("cdSuggest — ⌥1..9 direct-accept by physical digit row", () => {
  function openThree(id: number) {
    saveDirFrecency({
      "/Users/me/aaa": { count: 9, lastVisit: Date.now() },
      "/Users/me/bbb": { count: 8, lastVisit: Date.now() },
      "/Users/me/ccc": { count: 7, lastVisit: Date.now() },
    });
    typeChars("cd ");
  }

  it("⌥+Digit2 (altKey + e.code) accepts the entry at index 1, without executing it", () => {
    const id = mkPane("home");
    useStore.getState().setPaneRuntime(id, { ptyId: "pty-1", isZsh: false });
    openThree(id);
    expect(pane(id).cdSuggest!.items).toEqual(["/Users/me/aaa", "/Users/me/bbb", "/Users/me/ccc"]);
    const evt = keyEvt("2", { altKey: true, code: "Digit2" });
    handleKeyDown(evt);
    expect(pane(id).input).toBe("cd /Users/me/bbb");
    expect(pane(id).cdSuggest).toBeNull();
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect(tauri.lastCall("pty_write")).toBeUndefined();
  });

  it("⌥+Digit9 with only 3 items is swallowed (preventDefault) but does not accept anything", () => {
    const id = mkPane("home");
    openThree(id);
    const evt = keyEvt("9", { altKey: true, code: "Digit9" });
    handleKeyDown(evt);
    expect(pane(id).cdSuggest).not.toBeNull(); // still open, no accept happened
    expect((evt.preventDefault as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("⌥+Digit1 accepts the first (currently-selected) row", () => {
    const id = mkPane("home");
    openThree(id);
    handleKeyDown(keyEvt("1", { altKey: true, code: "Digit1" }));
    expect(pane(id).input).toBe("cd /Users/me/aaa");
  });
});
