// Coverage suite for src/components/StatusBar.tsx — cwd/branch display, MR
// count chip, diff summary, scripts entry, notification bell (muted/unseen),
// and the tab counter.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { StatusBar } from "../src/components/StatusBar";
import { useStore, type Group, type PaneState, type Workspace } from "../src/state/store";

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

/** Reset every piece of state StatusBar (or its BranchChip child) reads. */
function seed(overrides: Record<string, unknown> = {}) {
  useStore.setState(
    {
      workspaces: [],
      activeWs: null,
      initialized: true,
      home: "/Users/home",
      userScripts: {},
      repoMrs: {},
      unseen: 0,
      muted: false,
      panel: null,
      ...overrides,
    },
    false,
  );
}

beforeEach(() => {
  seed();
});
afterEach(() => {
  cleanup();
});

describe("StatusBar — cwd + branch", () => {
  it("shows '~' and no branch chip when there is no active pane", () => {
    const { getByText, queryByTitle } = render(<StatusBar />);
    expect(getByText("~")).toBeTruthy();
    expect(queryByTitle("switch branch")).toBeNull();
    expect(queryByTitle("show open merge requests")).toBeNull();
  });

  it("shows the shortened cwd and a branch chip when the active pane has a branch", () => {
    const pane = mkPane({ cwd: "/Users/home/project", branch: "main" });
    const ws = mkWorkspace([mkGroup({ panes: [pane] })]);
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByText, getByTitle } = render(<StatusBar />);
    expect(getByText("~/project")).toBeTruthy();
    expect(getByTitle("switch branch").textContent).toContain("main");
  });
});

describe("StatusBar — merge requests chip", () => {
  it("shows the bare 'MRs' label when repoMrs has no entry for the repo root", () => {
    const pane = mkPane({ branch: "main", repoRoot: "/repo" });
    const ws = mkWorkspace([mkGroup({ panes: [pane] })]);
    seed({ workspaces: [ws], activeWs: ws.id, repoMrs: {} });
    const { getByTitle } = render(<StatusBar />);
    expect(getByTitle("show open merge requests").textContent).toContain("MRs");
    expect(getByTitle("show open merge requests").textContent).not.toMatch(/^\d/);
  });

  it("shows the MR count and clicking it opens the mr panel", () => {
    const pane = mkPane({ branch: "main", repoRoot: "/repo" });
    const ws = mkWorkspace([mkGroup({ panes: [pane] })]);
    seed({
      workspaces: [ws],
      activeWs: ws.id,
      repoMrs: { "/repo": [{ iid: 1 }, { iid: 2 }] as never },
    });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("show open merge requests");
    expect(chip.textContent).toContain("2 MRs");
    fireEvent.click(chip);
    expect(useStore.getState().panel).toBe("mr");
  });
});

describe("StatusBar — diff summary", () => {
  it("still shows a clickable 'Changes' control (no counts) when files is 0", () => {
    const pane = mkPane();
    const ws = mkWorkspace([mkGroup({ panes: [pane] })], { diff: { files: 0, added: 0, removed: 0, conflicted: 0 } });
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("review changes (⌘G)");
    expect(chip.textContent).toContain("Changes");
    expect(chip.textContent).not.toContain("changed");
    fireEvent.click(chip);
    expect(useStore.getState().workspaces[0].tabs[0].panes[0].view).toBe("changes");
  });

  it("shows a clickable 'Changes' control even when the diff summary is null (never populated)", () => {
    const pane = mkPane();
    const ws = mkWorkspace([mkGroup({ panes: [pane] })], { diff: null });
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("review changes (⌘G)");
    expect(chip.textContent).toContain("Changes");
    fireEvent.click(chip);
    expect(useStore.getState().workspaces[0].tabs[0].panes[0].view).toBe("changes");
  });

  it("hides the Changes control only when there is no active pane", () => {
    seed({ workspaces: [], activeWs: null });
    const { queryByTitle } = render(<StatusBar />);
    expect(queryByTitle("review changes (⌘G)")).toBeNull();
  });

  it("shows +added only when removed is 0, and clicking switches the pane to the Changes view", () => {
    const pane = mkPane();
    const ws = mkWorkspace([mkGroup({ panes: [pane] })], { diff: { files: 3, added: 5, removed: 0, conflicted: 0 } });
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("review changes (⌘G)");
    expect(chip.textContent).toContain("3 changed");
    expect(chip.textContent).toContain("+5");
    expect(chip.textContent).not.toContain("−");
    fireEvent.click(chip);
    const updatedPane = useStore.getState().workspaces[0].tabs[0].panes[0];
    expect(updatedPane.view).toBe("changes");
  });

  it("shows -removed only when added is 0", () => {
    const pane = mkPane();
    const ws = mkWorkspace([mkGroup({ panes: [pane] })], { diff: { files: 2, added: 0, removed: 4, conflicted: 0 } });
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("review changes (⌘G)");
    expect(chip.textContent).toContain("−4");
    expect(chip.textContent).not.toContain("+");
  });

  it("shows both +added and -removed when both are non-zero", () => {
    const pane = mkPane();
    const ws = mkWorkspace([mkGroup({ panes: [pane] })], { diff: { files: 6, added: 2, removed: 3, conflicted: 0 } });
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("review changes (⌘G)");
    expect(chip.textContent).toContain("+2");
    expect(chip.textContent).toContain("−3");
  });
});

describe("StatusBar — scripts entry", () => {
  it("hides the scripts chip when the repo has no configured scripts", () => {
    const pane = mkPane({ repoRoot: "/repo" });
    const ws = mkWorkspace([mkGroup({ panes: [pane] })]);
    seed({ workspaces: [ws], activeWs: ws.id, userScripts: {} });
    const { queryByTitle } = render(<StatusBar />);
    expect(queryByTitle("run a script")).toBeNull();
  });

  it("shows the scripts chip and opens the scripts panel on click, keyed off cwd when repoRoot is null", () => {
    const pane = mkPane({ repoRoot: null, cwd: "/Users/home/project" });
    const ws = mkWorkspace([mkGroup({ panes: [pane] })]);
    seed({
      workspaces: [ws],
      activeWs: ws.id,
      userScripts: { "/Users/home/project": { scripts: [{ name: "build", desc: "", split: false, tasks: [] }], onEnter: null } },
    });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("run a script");
    fireEvent.click(chip);
    expect(useStore.getState().panel).toBe("scripts");
  });
});

describe("StatusBar — notifications", () => {
  it("shows 'muted' with no badge when muted is true", () => {
    seed({ muted: true, unseen: 0 });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("notification history");
    expect(chip.textContent).toBe("○muted");
  });

  it("shows 'alerts' with the raw unseen count when <= 9", () => {
    seed({ muted: false, unseen: 5 });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("notification history");
    expect(chip.textContent).toContain("alerts");
    expect(chip.textContent).toContain("5");
  });

  it("clamps the badge to '9+' above 9 and clears unseen on click", () => {
    seed({ muted: false, unseen: 15 });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("notification history");
    expect(chip.textContent).toContain("9+");
    fireEvent.click(chip);
    expect(useStore.getState().unseen).toBe(0);
    expect(useStore.getState().panel).toBe("notif");
  });

  it("hides the badge entirely when unseen is 0 and unmuted", () => {
    seed({ muted: false, unseen: 0 });
    const { getByTitle } = render(<StatusBar />);
    const chip = getByTitle("notification history");
    expect(chip.textContent).toBe("◉alerts");
  });
});

describe("StatusBar — tab counter", () => {
  it("hides the tab counter for a single-tab workspace", () => {
    const ws = mkWorkspace([mkGroup()]);
    seed({ workspaces: [ws], activeWs: ws.id });
    const { queryByText } = render(<StatusBar />);
    expect(queryByText(/^tab \d\/\d$/)).toBeNull();
  });

  it("shows 'tab N/M' for a multi-tab workspace at the right 1-based index", () => {
    const ws = mkWorkspace([mkGroup(), mkGroup()], { active: 1 });
    seed({ workspaces: [ws], activeWs: ws.id });
    const { getByText } = render(<StatusBar />);
    expect(getByText("tab 2/2")).toBeTruthy();
  });
});

describe("StatusBar — static keyboard hints", () => {
  it("always renders the hint row", () => {
    const { container } = render(<StatusBar />);
    const hints = container.querySelector(".aurora-statusbar-hints") as HTMLElement;
    expect(hints).toBeTruthy();
    expect(hints.textContent).toContain("new tab");
    expect(hints.textContent).toContain("split");
    expect(hints.textContent).toContain("accept");
    expect(hints.textContent).toContain("ask claude");
  });
});
