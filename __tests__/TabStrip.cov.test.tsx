// Coverage suite for src/components/TabStrip.tsx — tabTitle() label derivation,
// active/inactive tab rendering, split-count badge, drag-to-merge, and the
// pinned new-tab / split-pane buttons.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { TabStrip } from "../src/components/TabStrip";
import { useStore, type Group, type PaneState, type Workspace } from "../src/state/store";

// Start well above the store's own internal groupSeq/paneSeq counters (which
// persist across tests in this file) so fixture ids never collide with ids the
// real store actions (newTab/splitPane/mergeTabs) generate internally.
let seq = 90000;

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: seq++,
    ptyId: null,
    ptyEpoch: 0,
    isZsh: false,
    cwd: "/Users/home/project",
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
    view: "terminal",
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

function mkGroup(overrides: Partial<Group> & { panes?: PaneState[] } = {}): Group {
  return { id: seq++, panes: overrides.panes ?? [mkPane()], active: 0, split: "h", ...overrides };
}

function mkWorkspace(tabs: Group[], overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w-" + seq++,
    repoId: null,
    title: "ws",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: "/Users/home/project",
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs,
    active: 0,
    createdAt: 0,
    lastActive: 0,
    serverTabId: null,
    ...overrides,
  };
}

function seed(workspaces: Workspace[], activeWs: string | null, home = "/Users/home") {
  useStore.setState({ workspaces, activeWs, home, initialized: true }, false);
}

function fakeDataTransfer() {
  return { effectAllowed: "", dropEffect: "" } as unknown as DataTransfer;
}

afterEach(() => {
  cleanup();
});

// Note: TabStrip is only ever mounted by App.tsx when an active workspace
// exists (hasActiveWs gates it) and every real Workspace always has >=1 tab
// (closeTab refuses to drop below 1) — so an "no active workspace" / "zero
// tabs" render is not a reachable production state and isn't exercised here.

describe("TabStrip — tabTitle()", () => {
  it("uses the trimmed explicit tab name when set", () => {
    const g = mkGroup({ name: "  My Tab  " });
    const ws = mkWorkspace([g]);
    seed([ws], ws.id);
    const { getByText } = render(<TabStrip />);
    expect(getByText("My Tab")).toBeTruthy();
  });

  it("falls back to the last cwd segment when unnamed", () => {
    const g = mkGroup({ panes: [mkPane({ cwd: "/Users/home/aurora" })] });
    const ws = mkWorkspace([g]);
    seed([ws], ws.id, "/Users/home");
    const { getByText } = render(<TabStrip />);
    expect(getByText("aurora")).toBeTruthy();
  });

  it("falls back to 'zsh' when the shortened cwd collapses to home (~)", () => {
    const g = mkGroup({ panes: [mkPane({ cwd: "/Users/home" })] });
    const ws = mkWorkspace([g]);
    seed([ws], ws.id, "/Users/home");
    const { getByText } = render(<TabStrip />);
    expect(getByText("zsh")).toBeTruthy();
  });
});

describe("TabStrip — rendering", () => {
  it("marks the active tab distinctly and shows the split-count badge for multi-pane tabs", () => {
    const tabA = mkGroup({ panes: [mkPane(), mkPane()] }); // 2 panes -> badge
    const tabB = mkGroup({ panes: [mkPane()] });
    const ws = mkWorkspace([tabA, tabB], { active: 0 });
    seed([ws], ws.id);
    const { getByTitle } = render(<TabStrip />);
    const badge = getByTitle("2 panes");
    expect(badge.textContent).toBe("⊟2");
  });

  it("selecting a non-active tab calls selectTab and updates the active index", () => {
    const tabA = mkGroup({ panes: [mkPane({ cwd: "/Users/home/a" })] });
    const tabB = mkGroup({ panes: [mkPane({ cwd: "/Users/home/b" })] });
    const ws = mkWorkspace([tabA, tabB], { active: 0 });
    seed([ws], ws.id);
    const { getByText } = render(<TabStrip />);
    fireEvent.click(getByText("b"));
    expect(useStore.getState().workspaces[0].active).toBe(1);
  });

  it("closing a tab via the × icon removes it without selecting the closed tab", () => {
    const tabA = mkGroup({ panes: [mkPane({ cwd: "/Users/home/a" })] });
    const tabB = mkGroup({ panes: [mkPane({ cwd: "/Users/home/b" })] });
    const ws = mkWorkspace([tabA, tabB], { active: 0 });
    seed([ws], ws.id);
    const { getAllByText } = render(<TabStrip />);
    const closeIcons = getAllByText("×");
    expect(closeIcons.length).toBe(2);
    fireEvent.click(closeIcons[1]); // close tab B; stopPropagation must prevent selectTab(1)
    const after = useStore.getState().workspaces[0];
    expect(after.tabs.length).toBe(1);
    expect(after.active).toBe(0); // stayed on A, not accidentally moved
  });

  it("clicking the pinned + button opens a new tab", () => {
    const ws = mkWorkspace([mkGroup()]);
    seed([ws], ws.id);
    const { getByTitle } = render(<TabStrip />);
    fireEvent.click(getByTitle("new tab (⌘T)"));
    expect(useStore.getState().workspaces[0].tabs.length).toBe(2);
  });

  it("clicking the pinned split button splits the active tab's pane", () => {
    const ws = mkWorkspace([mkGroup()]);
    seed([ws], ws.id);
    const { getByTitle } = render(<TabStrip />);
    fireEvent.click(getByTitle("split pane (⌘D)"));
    expect(useStore.getState().workspaces[0].tabs[0].panes.length).toBe(2);
  });
});

describe("TabStrip — drag to merge", () => {
  it("dragging tab A onto tab B shows the drop hint, then merges A's panes into B on drop", () => {
    const tabA = mkGroup({ panes: [mkPane({ cwd: "/Users/home/a" })] });
    const tabB = mkGroup({ panes: [mkPane({ cwd: "/Users/home/b" })] });
    const ws = mkWorkspace([tabA, tabB], { active: 0 });
    seed([ws], ws.id);
    const { getByText, queryByText } = render(<TabStrip />);
    const elA = getByText("a").closest("div[draggable]") as HTMLElement;
    const elB = getByText("b").closest("div[draggable]") as HTMLElement;

    const dt = fakeDataTransfer();
    fireEvent.dragStart(elA, { dataTransfer: dt });
    fireEvent.dragOver(elB, { dataTransfer: dt });
    expect(queryByText("⊟ split")).toBeTruthy(); // drop-target hint now showing on B

    fireEvent.drop(elB, { dataTransfer: dt });
    const after = useStore.getState().workspaces[0];
    expect(after.tabs.length).toBe(1); // A merged into B
    expect(after.tabs[0].panes.length).toBe(2);
  });

  it("dragging over the same tab does not arm a drop target, and dragLeave clears it", () => {
    const tabA = mkGroup({ panes: [mkPane({ cwd: "/Users/home/a" })] });
    const tabB = mkGroup({ panes: [mkPane({ cwd: "/Users/home/b" })] });
    const ws = mkWorkspace([tabA, tabB], { active: 0 });
    seed([ws], ws.id);
    const { getByText, queryByText } = render(<TabStrip />);
    const elA = getByText("a").closest("div[draggable]") as HTMLElement;
    const elB = getByText("b").closest("div[draggable]") as HTMLElement;
    const dt = fakeDataTransfer();

    fireEvent.dragStart(elA, { dataTransfer: dt });
    fireEvent.dragOver(elA, { dataTransfer: dt }); // same index as dragIdx -> no drop target armed
    expect(queryByText("⊟ split")).toBeNull();

    fireEvent.dragOver(elB, { dataTransfer: dt });
    expect(queryByText("⊟ split")).toBeTruthy();
    fireEvent.dragLeave(elB);
    expect(queryByText("⊟ split")).toBeNull();
  });

  it("dragEnd resets drag state so a later drop on a stale target is a no-op", () => {
    const tabA = mkGroup({ panes: [mkPane({ cwd: "/Users/home/a" })] });
    const tabB = mkGroup({ panes: [mkPane({ cwd: "/Users/home/b" })] });
    const ws = mkWorkspace([tabA, tabB], { active: 0 });
    seed([ws], ws.id);
    const { getByText } = render(<TabStrip />);
    const elA = getByText("a").closest("div[draggable]") as HTMLElement;
    const elB = getByText("b").closest("div[draggable]") as HTMLElement;
    const dt = fakeDataTransfer();

    fireEvent.dragStart(elA, { dataTransfer: dt });
    fireEvent.dragOver(elB, { dataTransfer: dt });
    fireEvent.dragEnd(elA);
    fireEvent.drop(elB, { dataTransfer: dt }); // dragIdx now null -> mergeTabs must not fire
    expect(useStore.getState().workspaces[0].tabs.length).toBe(2);
  });

  it("dropping a tab on itself (src === i) does not merge", () => {
    const tabA = mkGroup({ panes: [mkPane({ cwd: "/Users/home/a" })] });
    const ws = mkWorkspace([tabA], { active: 0 });
    seed([ws], ws.id);
    const { getByText } = render(<TabStrip />);
    const elA = getByText("a").closest("div[draggable]") as HTMLElement;
    const dt = fakeDataTransfer();
    fireEvent.dragStart(elA, { dataTransfer: dt });
    fireEvent.drop(elA, { dataTransfer: dt });
    expect(useStore.getState().workspaces[0].tabs.length).toBe(1);
  });
});
