// Coverage suite for src/components/ScriptsSheet.tsx — the run-script bottom
// sheet: empty state, row rendering, keyboard nav (↑↓ ↵), mouse hover/click,
// the "edit scripts" link, and the shared Sheet/Empty chrome it uses.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ScriptsSheet } from "../src/components/ScriptsSheet";
import { useStore, type PaneState, type Group, type Workspace } from "../src/state/store";
import { addScript, updateScript, updateTask } from "../src/lib/scripts";
import { tauri } from "../test/mocks/tauri";

let seq = 9000;

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: seq++,
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
    ready: true,
    dirNames: [],
    blocks: [],
    repoRoot: "/repo",
    firedHooks: [],
    hook: null,
    ...overrides,
  };
}

function setup(pane: PaneState | null, extra: { home?: string } = {}) {
  const base = {
    initialized: true,
    home: extra.home ?? "/Users/test",
    panel: "scripts" as const,
    scriptsSetupOpen: false,
  };
  if (!pane) {
    useStore.setState({ ...base, workspaces: [], activeWs: null }, false);
    return { ws: undefined };
  }
  const group: Group = { id: seq++, panes: [pane], active: 0, split: "h" };
  const ws: Workspace = {
    id: "w-" + pane.id,
    repoId: null,
    title: "ws",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: pane.cwd,
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [group],
    active: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
    serverTabId: null,
  };
  useStore.setState({ ...base, workspaces: [ws], activeWs: ws.id }, false);
  return { ws };
}

beforeEach(() => {
  tauri.reset();
  useStore.setState({ userScripts: {} }, false);
});
afterEach(() => cleanup());

describe("ScriptsSheet — no active pane", () => {
  it("renders without a subtitle and skips the empty-state hint (root is null)", () => {
    setup(null);
    const { container, queryByText } = render(<ScriptsSheet />);
    expect(container.textContent).toContain("scripts");
    expect(container.textContent).not.toContain("/repo");
    expect(queryByText(/no scripts here yet/)).toBeNull();
  });
});

describe("ScriptsSheet — empty script list", () => {
  it("shows the empty state and the repo subtitle", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, container } = render(<ScriptsSheet />);
    expect(getByText(/no scripts here yet/)).toBeTruthy();
    expect(container.textContent).toContain("/repo");
  });
});

describe("ScriptsSheet — populated list", () => {
  function seedScripts() {
    const root = "/repo";
    addScript(root);
    updateScript(root, 0, { name: "dev", desc: "run the dev server" });
    updateTask(root, 0, 0, { cmd: "npm run dev" });
    addScript(root);
    updateScript(root, 1, { name: "test-suite", split: true });
    updateTask(root, 1, 0, { cmd: "npm test" });
    return root;
  }

  it("renders a row per script, with desc/split badge shown conditionally", () => {
    seedScripts();
    const pane = mkPane();
    setup(pane);
    const { getByText, queryByText, container } = render(<ScriptsSheet />);
    expect(getByText("dev")).toBeTruthy();
    expect(getByText("run the dev server")).toBeTruthy();
    expect(getByText("test-suite")).toBeTruthy();
    expect(getByText("split")).toBeTruthy(); // only the split script shows the badge
    expect(queryByText(/no scripts here yet/)).toBeNull();
    expect(container.textContent).toContain("▶ run");
  });

  it("clicking a row closes the panel and runs that script", () => {
    seedScripts();
    const pane = mkPane({ ready: true, ptyId: "pty-1" });
    setup(pane);
    const { getByText } = render(<ScriptsSheet />);
    fireEvent.click(getByText("dev"));
    expect(useStore.getState().panel).toBeNull();
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "npm run dev\n" });
  });

  it("clicking '✎ edit scripts' opens the setup modal", () => {
    seedScripts();
    const pane = mkPane();
    setup(pane);
    const { getByText } = render(<ScriptsSheet />);
    fireEvent.click(getByText("✎ edit scripts"));
    expect(useStore.getState().scriptsSetupOpen).toBe(true);
    expect(useStore.getState().panel).toBeNull(); // openScriptsSetup also closes the panel
  });

  it("ArrowDown/ArrowUp move the selection and clamp at the bounds, Enter runs the selected script", () => {
    seedScripts();
    const pane = mkPane({ ready: true, ptyId: "pty-1" });
    setup(pane);
    render(<ScriptsSheet />);
    // Clamp at 0 first (already selected index 0).
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowDown" }); // -> index 1 ("test-suite")
    fireEvent.keyDown(window, { key: "ArrowDown" }); // clamp at last index (still 1)
    fireEvent.keyDown(window, { key: "Enter" });
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "npm test\n" });
    expect(useStore.getState().panel).toBeNull();
  });

  it("hovering a row updates the selection so Enter runs the hovered script", () => {
    seedScripts();
    const pane = mkPane({ ready: true, ptyId: "pty-1" });
    setup(pane);
    const { getByText } = render(<ScriptsSheet />);
    fireEvent.mouseEnter(getByText("test-suite"));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(tauri.lastCall("pty_write")?.args.data).toBe("npm test\n");
  });

  it("Enter is a no-op when there's no pane (nothing to run into)", () => {
    seedScripts();
    setup(null);
    expect(() => fireEvent.keyDown(window, { key: "Enter" })).not.toThrow();
    expect(tauri.calls().some((c) => c.cmd === "pty_write")).toBe(false);
  });
});

describe("Sheet chrome (shared by ScriptsSheet)", () => {
  it("closes on the × button", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText } = render(<ScriptsSheet />);
    fireEvent.click(getByText("×"));
    expect(useStore.getState().panel).toBeNull();
  });

  it("closes on an overlay click", () => {
    const pane = mkPane();
    setup(pane);
    const { container } = render(<ScriptsSheet />);
    // The overlay is the Fragment's first child: an empty absolutely-positioned div.
    const overlay = container.firstElementChild;
    expect(overlay?.tagName).toBe("DIV");
    expect(overlay?.children).toHaveLength(0);
    fireEvent.click(overlay!);
    expect(useStore.getState().panel).toBeNull();
  });

  it("shows the ↑↓ / ↵ / esc hint row", () => {
    const pane = mkPane();
    setup(pane);
    const { container } = render(<ScriptsSheet />);
    expect(container.textContent).toContain("select");
    expect(container.textContent).toContain("run");
    expect(container.textContent).toContain("close");
  });
});
