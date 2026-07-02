// Coverage suite for src/components/PaneGrid.tsx — exercises gridShape()'s
// branches (1 pane, <=3 panes split h/v, >3 panes auto-grid), the
// multiple/visible styling toggles, and PaneArea's mounted/active filtering
// across several workspaces and tab groups.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { PaneArea } from "../src/components/PaneGrid";
import { useStore, type PaneState, type Group, type Workspace } from "../src/state/store";
import { tauri } from "../test/mocks/tauri";

let seq = 9000;

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: seq++,
    ptyId: null,
    ptyEpoch: 0,
    isZsh: false,
    cwd: "/Users/test/proj",
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

function mkGroup(paneCount: number, split: "h" | "v", active = 0): Group {
  const panes = Array.from({ length: paneCount }, () => mkPane());
  return { id: seq++, panes, active, split };
}

function mkWorkspace(tabs: Group[], overrides: Partial<Workspace> = {}): Workspace {
  const id = "w-" + seq++;
  return {
    id,
    repoId: null,
    title: "ws",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: "/Users/test/proj",
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
    createdAt: Date.now(),
    lastActive: Date.now(),
    serverTabId: null,
    ...overrides,
  };
}

function resetStore() {
  useStore.setState(
    {
      workspaces: [],
      activeWs: null,
      changesWsId: null,
      initialized: true,
      home: "/Users/test",
      keyEntry: false,
      keyError: null,
      apiKeyPresent: true,
      find: { open: false, query: "", current: 0 },
    },
    false,
  );
}

/** Grid wrapper divs are the only elements PaneGrid gives a gridTemplateColumns
 *  style to (Pane's own root divs use flex, not grid) — a stable selector. */
function gridDivs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("div")).filter(
    (el) => el.style.gridTemplateColumns !== "",
  );
}

beforeEach(() => {
  tauri.reset();
  resetStore();
});
afterEach(() => {
  cleanup();
});

describe("PaneArea — gridShape via rendered grid style", () => {
  it("a single pane gets a 1x1 grid with no gap/padding (not 'multiple')", () => {
    const group = mkGroup(1, "h");
    const ws = mkWorkspace([group]);
    useStore.setState({ workspaces: [ws], activeWs: ws.id }, false);
    const { container } = render(<PaneArea />);
    const [grid] = gridDivs(container);
    expect(grid.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
    expect(grid.style.gridTemplateRows).toBe("repeat(1, minmax(0, 1fr))");
    expect(grid.style.gap).toBe("0");
    expect(grid.style.padding).toBe("0px");
  });

  it("2 panes split horizontally lay out as a single row ('multiple' gap applied)", () => {
    const group = mkGroup(2, "h");
    const ws = mkWorkspace([group]);
    useStore.setState({ workspaces: [ws], activeWs: ws.id }, false);
    const { container } = render(<PaneArea />);
    const [grid] = gridDivs(container);
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(grid.style.gridTemplateRows).toBe("repeat(1, minmax(0, 1fr))");
    expect(grid.style.gap).toBe("6px");
    expect(grid.style.padding).toBe("6px");
  });

  it("3 panes split vertically stack as a single column", () => {
    const group = mkGroup(3, "v");
    const ws = mkWorkspace([group]);
    useStore.setState({ workspaces: [ws], activeWs: ws.id }, false);
    const { container } = render(<PaneArea />);
    const [grid] = gridDivs(container);
    expect(grid.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
    expect(grid.style.gridTemplateRows).toBe("repeat(3, minmax(0, 1fr))");
  });

  it("5 panes (>3) auto-grid into a near-square layout (ceil(sqrt(5))=3 cols, 2 rows)", () => {
    const group = mkGroup(5, "h");
    const ws = mkWorkspace([group]);
    useStore.setState({ workspaces: [ws], activeWs: ws.id }, false);
    const { container } = render(<PaneArea />);
    const [grid] = gridDivs(container);
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(grid.style.gridTemplateRows).toBe("repeat(2, minmax(0, 1fr))");
  });
});

describe("PaneArea — mounted filtering and active-tab visibility", () => {
  it("skips unmounted workspaces entirely (no grid rendered for them)", () => {
    const mountedGroup = mkGroup(1, "h");
    const mountedWs = mkWorkspace([mountedGroup]);
    const unmountedGroup = mkGroup(2, "h");
    const unmountedWs = mkWorkspace([unmountedGroup], { mounted: false });
    useStore.setState({ workspaces: [unmountedWs, mountedWs], activeWs: mountedWs.id }, false);
    const { container } = render(<PaneArea />);
    // Only the mounted workspace's single group should have been rendered.
    expect(gridDivs(container).length).toBe(1);
  });

  it("shows only the active workspace's active tab; other tabs/workspaces render hidden (display:none)", () => {
    const tabA = mkGroup(1, "h");
    const tabB = mkGroup(2, "h");
    const activeWs = mkWorkspace([tabA, tabB], { active: 1 }); // tab B is the visible one
    const otherGroup = mkGroup(1, "h");
    const otherWs = mkWorkspace([otherGroup]); // mounted but not the active workspace
    useStore.setState({ workspaces: [activeWs, otherWs], activeWs: activeWs.id }, false);
    const { container } = render(<PaneArea />);
    const grids = gridDivs(container);
    expect(grids.length).toBe(3); // tabA + tabB (activeWs) + otherGroup (otherWs)
    const visible = grids.filter((g) => g.style.display === "grid");
    const hidden = grids.filter((g) => g.style.display === "none");
    expect(visible.length).toBe(1);
    expect(hidden.length).toBe(2);
    // The visible one must be tabB (2 panes -> 2-col grid), not tabA (1x1) or otherGroup (1x1).
    expect(visible[0].style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("renders nothing when there are zero workspaces", () => {
    useStore.setState({ workspaces: [], activeWs: null }, false);
    const { container } = render(<PaneArea />);
    expect(gridDivs(container).length).toBe(0);
  });
});

describe("PaneArea — Changes overlay (disjoint, never takes a pane)", () => {
  it("renders the Changes overlay over the grid when changesWsId matches the active workspace", () => {
    const ws = mkWorkspace([mkGroup(1, "h")]);
    useStore.setState({ workspaces: [ws], activeWs: ws.id, changesWsId: ws.id }, false);
    const { queryByTitle, container } = render(<PaneArea />);
    // The overlay's close affordance proves ChangesView mounted…
    expect(queryByTitle("close (Esc)")).toBeTruthy();
    // …and the pane grid is still present underneath (overlay, not replacement).
    expect(gridDivs(container).length).toBe(1);
  });

  it("does not render the overlay when changesWsId is null", () => {
    const ws = mkWorkspace([mkGroup(1, "h")]);
    useStore.setState({ workspaces: [ws], activeWs: ws.id, changesWsId: null }, false);
    const { queryByTitle } = render(<PaneArea />);
    expect(queryByTitle("close (Esc)")).toBeNull();
  });

  it("does not render the overlay for a non-active workspace (switching away hides it)", () => {
    const wsA = mkWorkspace([mkGroup(1, "h")]);
    const wsB = mkWorkspace([mkGroup(1, "h")]);
    // changesWsId points at A, but B is active → overlay stays hidden.
    useStore.setState({ workspaces: [wsA, wsB], activeWs: wsB.id, changesWsId: wsA.id }, false);
    const { queryByTitle } = render(<PaneArea />);
    expect(queryByTitle("close (Esc)")).toBeNull();
  });
});
