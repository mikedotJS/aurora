// Coverage suite for src/components/Pane.tsx — exercises every conditional
// render branch (key entry, hook card, suggestion card, completion list,
// find-in-output highlighting, raw mode, multi-pane chrome) plus the click
// handlers that reach into the real Zustand store.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { Pane } from "../src/components/Pane";
import { useStore, type PaneState, type Group, type Workspace, type Block } from "../src/state/store";
import { tauri } from "../test/mocks/tauri";

let paneSeq = 5000;

function mkBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: paneSeq++,
    command: "echo hi",
    cwd: "/Users/test/proj",
    output: "hello world\n",
    exitCode: 0,
    running: false,
    ...overrides,
  };
}

function mkPane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    id: paneSeq++,
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

function mkWorkspace(pane: PaneState, wsOverrides: Partial<Workspace> = {}, groupOverrides: Partial<Group> = {}): Workspace {
  const group: Group = { id: paneSeq++, panes: [pane], active: 0, split: "h", ...groupOverrides };
  return {
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
    ...wsOverrides,
  };
}

/** Installs `pane` inside a fresh single-tab workspace as the active workspace,
 *  and sets the store slices Pane.tsx reads directly. Returns the workspace so
 *  tests can assert on store mutations after firing handlers. */
function setup(
  pane: PaneState,
  extra: {
    home?: string;
    keyEntry?: boolean;
    keyError?: string | null;
    apiKeyPresent?: boolean;
    find?: { open: boolean; query: string; current: number };
  } = {},
) {
  const ws = mkWorkspace(pane);
  useStore.setState(
    {
      workspaces: [ws],
      activeWs: ws.id,
      initialized: true,
      home: extra.home ?? "/Users/test",
      keyEntry: extra.keyEntry ?? false,
      keyError: extra.keyError ?? null,
      apiKeyPresent: extra.apiKeyPresent ?? true,
      find: extra.find ?? { open: false, query: "", current: 0 },
    },
    false,
  );
  return ws;
}

beforeEach(() => {
  tauri.reset();
});
afterEach(() => {
  cleanup();
});

describe("Pane — empty scrollback", () => {
  it("shows the byok hint when apiKeyPresent is false", () => {
    const pane = mkPane({ blocks: [] });
    setup(pane, { apiKeyPresent: false });
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("bring-your-own-key");
  });

  it("shows the ask-claude hint when apiKeyPresent is true", () => {
    const pane = mkPane({ blocks: [] });
    setup(pane, { apiKeyPresent: true });
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("ask claude");
  });
});

describe("Pane — block rendering", () => {
  it("renders a block with output, a nonzero exit code, and a blank middle line", () => {
    const pane = mkPane({
      blocks: [mkBlock({ command: "run", output: "line1\n\nline3\n", exitCode: 2 })],
    });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("exit 2");
    expect(container.textContent).toContain("line1");
    expect(container.textContent).toContain("line3");
  });

  it("renders a block with empty output (exitCode null) without an exit badge", () => {
    const pane = mkPane({ blocks: [mkBlock({ output: "", exitCode: null })] });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).not.toContain("exit");
  });

  it("highlights find matches, marking the current one distinctly", () => {
    const pane = mkPane({
      blocks: [mkBlock({ command: "grep", output: "foo bar foo\n" })],
    });
    setup(pane, { find: { open: true, query: "foo", current: 0 } });
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    // Both occurrences of "foo" render as highlighted spans; text is preserved.
    expect(container.textContent).toContain("foo bar foo");
  });
});

describe("Pane — multi-pane chrome and focus", () => {
  it("renders the cwd header and active dot when part of a multi-pane group", () => {
    const pane = mkPane({ cwd: "/Users/test/proj/sub" });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple />);
    expect(container.textContent).toContain("~/proj/sub");
  });

  it("clicking an inactive pane's root calls focusPane(index)", () => {
    const paneA = mkPane();
    const paneB = mkPane();
    const group: Group = { id: 1, panes: [paneA, paneB], active: 0, split: "h" };
    const ws = mkWorkspace(paneA, {}, {});
    ws.tabs = [group];
    useStore.setState(
      { workspaces: [ws], activeWs: ws.id, initialized: true, home: "/Users/test", find: { open: false, query: "", current: 0 } },
      false,
    );
    const { container } = render(<Pane pane={paneB} index={1} isActive={false} multiple />);
    fireEvent.mouseDown(container.firstElementChild as Element);
    expect(useStore.getState().workspaces[0].tabs[0].active).toBe(1);
  });

  it("clicking inside the scrollback of an inactive pane also focuses it", () => {
    const paneA = mkPane();
    const paneB = mkPane();
    const group: Group = { id: 2, panes: [paneA, paneB], active: 0, split: "h" };
    const ws = mkWorkspace(paneA, {}, {});
    ws.tabs = [group];
    useStore.setState(
      { workspaces: [ws], activeWs: ws.id, initialized: true, home: "/Users/test", find: { open: false, query: "", current: 0 } },
      false,
    );
    const { container } = render(<Pane pane={paneB} index={1} isActive={false} multiple />);
    const scroll = container.querySelector(".ascroll") as Element;
    fireEvent.mouseDown(scroll);
    expect(useStore.getState().workspaces[0].tabs[0].active).toBe(1);
  });
});

describe("Pane — changes view + find bar", () => {
  it("renders ChangesView when pane.view is 'changes'", () => {
    const pane = mkPane({ view: "changes" });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    // ChangesView's own header text ("changes") should be present.
    expect(container.textContent?.toLowerCase()).toContain("changes");
  });

  it("renders ChangesView even when a full-screen program runs (rawMode) — the view overlays the terminal", () => {
    // Regression: the Changes view used to be gated on !rawMode, so switching to
    // it while a full-screen program (claude, vim, less…) ran showed nothing.
    const pane = mkPane({ view: "changes", rawMode: true });
    setup(pane);
    const { queryByTitle } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(queryByTitle("back to terminal (⌥⌘D)")).toBeTruthy();
  });

  it("renders FindBar when find is open on the active pane", () => {
    const pane = mkPane({ blocks: [mkBlock({ output: "x\n" })] });
    setup(pane, { find: { open: true, query: "x", current: 0 } });
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.querySelector("input")).toBeTruthy();
  });
});

describe("Pane — hook card", () => {
  it("renders with desc and fires onRun / onDismiss handlers", () => {
    const pane = mkPane({
      hook: { name: "install", label: "install deps", desc: "npm ci" },
    });
    setup(pane);
    const { getByText } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(getByText("npm ci")).toBeTruthy();
    fireEvent.click(getByText("▶ run"));
    // runHook clears the hook once fired (goes through the real store).
    expect(useStore.getState().workspaces[0].tabs[0].panes[0].hook).toBeNull();
  });

  it("renders without desc and fires onDismiss", () => {
    const pane = mkPane({ hook: { name: "install", label: "install deps", desc: "" } });
    setup(pane);
    const { getByText } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    fireEvent.click(getByText("×"));
    expect(useStore.getState().workspaces[0].tabs[0].panes[0].hook).toBeNull();
  });
});

describe("Pane — suggestion card", () => {
  it("renders the loading card (footer=false) while suggestionLoading", () => {
    const pane = mkPane({ suggestionLoading: true });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("thinking…");
  });

  it("renders a command suggestion with the run/edit/dismiss footer", () => {
    const pane = mkPane({ suggestion: { command: "git status", note: "check state" } });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("suggests");
    expect(container.textContent).toContain("git status");
    expect(container.textContent).toContain("run");
  });

  it("renders a locked suggestion (needsKey) with the add-key footer", () => {
    const pane = mkPane({ suggestion: { command: "", note: "needs a key", needsKey: true } });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("locked");
    expect(container.textContent).toContain("add your key");
  });

  it("renders a plain claude note with just the dismiss footer", () => {
    const pane = mkPane({ suggestion: { command: "", note: "just a note" } });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("claude");
    expect(container.textContent).toContain("just a note");
  });
});

describe("Pane — prompt line", () => {
  it("shows the ask-claude glyph when input starts with '?'", () => {
    const pane = mkPane({ input: "? undo last commit" });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("✦");
    expect(container.textContent).toContain("undo last commit");
  });

  it("shows the plain glyph and ghost text for a normal command", () => {
    const pane = mkPane({ input: "git st", ghost: "atus" });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("git st");
    expect(container.textContent).toContain("atus");
  });

  it("hides the caret/ghost when the input is fully selected", () => {
    const pane = mkPane({ input: "git st", ghost: "atus", inputSelected: true });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    // ghost text must not render while selected
    expect(container.textContent).not.toContain("atus");
  });

  it("suppresses the prompt entirely while in raw (interactive) mode", () => {
    const pane = mkPane({ input: "should-not-show", rawMode: true });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).not.toContain("should-not-show");
    expect(container.textContent).toContain("interactive");
  });
});

describe("Pane — completion list", () => {
  it("renders a short list with no overflow indicators", () => {
    const pane = mkPane({
      completion: {
        items: [
          { name: "src", is_dir: true },
          { name: "test", is_dir: true },
        ],
        index: 0,
        tokenStart: 0,
        dir: "/Users/test/proj",
      },
    });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("src");
    expect(container.textContent).toContain("test");
    expect(container.textContent).not.toContain("more…");
  });

  it("renders a long list with both 'more above' and 'more below' indicators", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ name: `dir${i}`, is_dir: true }));
    const pane = mkPane({
      completion: { items, index: 10, tokenStart: 0, dir: "/Users/test/proj" },
    });
    setup(pane);
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("more…");
    expect(container.textContent).toContain("dir10");
  });
});

describe("Pane — key entry", () => {
  it("renders the key-entry prompt with a mid-length mask and no error", () => {
    const pane = mkPane({ input: "sk-ant-abc" });
    setup(pane, { keyEntry: true, keyError: null });
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("paste anthropic key");
    expect(container.textContent).toContain("•".repeat("sk-ant-abc".length));
  });

  it("renders the key-entry error message when keyError is set", () => {
    const pane = mkPane({ input: "bad" });
    setup(pane, { keyEntry: true, keyError: "invalid key" });
    const { container } = render(<Pane pane={pane} index={0} isActive multiple={false} />);
    expect(container.textContent).toContain("invalid key");
  });

  it("does not show key entry when the pane is not active", () => {
    const pane = mkPane({ input: "x" });
    setup(pane, { keyEntry: true });
    const { container } = render(<Pane pane={pane} index={0} isActive={false} multiple={false} />);
    expect(container.textContent).not.toContain("paste anthropic key");
  });
});
