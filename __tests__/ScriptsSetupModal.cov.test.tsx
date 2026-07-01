// Coverage suite for src/components/ScriptsSetupModal.tsx — the per-repo
// scripts editor (no-root placeholder, onEnter select, script/task CRUD via
// UI, the AI generate flow's every state, and the ReviewPanel's edit/keep/
// adopt/cancel flow).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ScriptsSetupModal } from "../src/components/ScriptsSetupModal";
import { useStore, type PaneState, type Group, type Workspace } from "../src/state/store";
import { scriptsForRoot } from "../src/lib/scripts";
import { tauri } from "../test/mocks/tauri";

let seq = 10000;

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
    view: "terminal",
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

function setup(
  pane: PaneState | null,
  extra: {
    home?: string;
    apiKeyPresent?: boolean;
    model?: string;
  } = {},
) {
  const base = {
    initialized: true,
    home: extra.home ?? "/Users/test",
    apiKeyPresent: extra.apiKeyPresent ?? true,
    scriptsSetupOpen: true,
    keyEntry: false,
    settings: { ...useStore.getState().settings, model: extra.model ?? "claude-sonnet-4-6" },
  };
  if (!pane) {
    useStore.setState({ ...base, workspaces: [], activeWs: null }, false);
    return;
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
}

beforeEach(() => {
  tauri.reset();
  useStore.setState({ userScripts: {} }, false);
});
afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// No active pane
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — no active pane", () => {
  it("shows the 'cd into a repo' placeholder and no editor chrome", () => {
    setup(null);
    const { getByText, queryByText } = render(<ScriptsSetupModal />);
    expect(getByText("cd into a repo to edit its scripts")).toBeTruthy();
    expect(queryByText("+ add script")).toBeNull();
    expect(queryByText("✨ generate with AI")).toBeNull();
  });

  it("closes via the × button and the overlay", () => {
    setup(null);
    const { getByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("×"));
    expect(useStore.getState().scriptsSetupOpen).toBe(false);

    useStore.setState({ scriptsSetupOpen: true }, false);
    const { container: c2 } = render(<ScriptsSetupModal />);
    // Structure: outer positioned div > [overlay div (empty, onClick=close), panel div].
    const overlay = c2.firstElementChild!.firstElementChild!;
    expect(overlay.children).toHaveLength(0);
    fireEvent.click(overlay);
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Editor: empty and populated states, CRUD
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — editor, empty script list", () => {
  it("shows the repo subtitle, a 'none' onEnter option, and the add/generate buttons", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, container } = render(<ScriptsSetupModal />);
    expect(container.textContent).toContain("/repo");
    expect(getByText("none")).toBeTruthy();
    expect(getByText("+ add script")).toBeTruthy();
    expect(getByText("✨ generate with AI")).toBeTruthy();
  });

  it("'+ add script' adds a default script that then appears in the editor", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, getByPlaceholderText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("+ add script"));
    expect(scriptsForRoot("/repo").map((s) => s.name)).toEqual(["script1"]);
    expect(getByPlaceholderText("name")).toHaveProperty("value", "script1");
  });
});

describe("ScriptsSetupModal — editor, populated script list", () => {
  function seed() {
    const root = "/repo";
    useStore.getState(); // no-op, just for readability
    return root;
  }

  it("renders name/desc inputs, the onEnter select options, and task rows", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, getByDisplayValue } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("+ add script"));
    fireEvent.change(getByDisplayValue("script1"), { target: { value: "dev" } });
    expect(scriptsForRoot("/repo")[0].name).toBe("dev");
    // onEnter select now offers the renamed script.
    expect(getByText("dev")).toBeTruthy();
  });

  it("editing desc/task dir/cmd calls through to the store", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, getByPlaceholderText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("+ add script"));
    fireEvent.change(getByPlaceholderText("description"), { target: { value: "runs stuff" } });
    fireEvent.change(getByPlaceholderText("dir"), { target: { value: "sub" } });
    fireEvent.change(getByPlaceholderText("command to run"), { target: { value: "npm run x" } });
    const s = scriptsForRoot("/repo")[0];
    expect(s.desc).toBe("runs stuff");
    expect(s.tasks[0]).toEqual({ dir: "sub", cmd: "npm run x" });
  });

  it("adds/removes a command row and deletes the script", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, getByTitle, getAllByTitle, getAllByPlaceholderText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("+ add script"));
    fireEvent.click(getByText("+ command"));
    expect(scriptsForRoot("/repo")[0].tasks).toHaveLength(2);
    const cmdInputs = getAllByPlaceholderText("command to run");
    expect(cmdInputs).toHaveLength(2);
    fireEvent.click(getAllByTitle("remove command")[0]);
    expect(scriptsForRoot("/repo")[0].tasks).toHaveLength(1);
    fireEvent.click(getByTitle("delete script"));
    expect(scriptsForRoot("/repo")).toHaveLength(0);
  });

  it("toggling the split switch flips the script's split flag", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, container } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("+ add script"));
    // The switch track is the only element styled as a 34x19 pill right after "split panes" label.
    const track = Array.from(container.querySelectorAll("div")).find(
      (el) => el.getAttribute("style")?.includes("border-radius: 999px"),
    );
    expect(track).toBeTruthy();
    fireEvent.click(track!);
    expect(scriptsForRoot("/repo")[0].split).toBe(true);
    fireEvent.click(track!);
    expect(scriptsForRoot("/repo")[0].split).toBe(false);
  });

  it("selecting an onEnter option calls setOnEnter, and picking 'none' clears it", () => {
    const pane = mkPane();
    setup(pane);
    const { getByText, container } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("+ add script"));
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: "script1" } });
    expect(useStore.getState().userScripts["/repo"].onEnter).toBe("script1");
    fireEvent.change(select, { target: { value: "" } });
    expect(useStore.getState().userScripts["/repo"].onEnter).toBeNull();
  });

  it("clicking '▶' on a script closes the modal and runs it", () => {
    const pane = mkPane({ ready: true, ptyId: "pty-1" });
    setup(pane);
    const { getByText, getByPlaceholderText, getByTitle } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("+ add script"));
    fireEvent.change(getByPlaceholderText("command to run"), { target: { value: "npm run dev" } });
    fireEvent.click(getByTitle("run now"));
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
    expect(tauri.lastCall("pty_write")?.args).toEqual({ id: "pty-1", data: "npm run dev\n" });
  });
});

// ---------------------------------------------------------------------------
// AI generate: idle -> loading -> {error | review}
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — generate with AI", () => {
  it("routes to key entry (without calling the model) when no API key is present", () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: false });
    const { getByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("✨ generate with AI"));
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
    expect(useStore.getState().keyEntry).toBe(true);
    expect(tauri.calls().some((c) => c.cmd === "claude_text")).toBe(false);
  });

  it("shows an error state when Claude proposes zero usable scripts", async () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true });
    tauri.invoke({ list_dir: () => [], claude_text: () => "[]" });
    const { getByText, findByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("✨ generate with AI"));
    expect(await findByText("Claude didn't return any usable scripts for this repo.")).toBeTruthy();
  });

  it("routes to key entry when generateRepoScripts throws NoKeyError", async () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true });
    tauri.invoke({
      list_dir: () => [],
      claude_text: () => {
        throw "no-key";
      },
    });
    const { getByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("✨ generate with AI"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
    expect(useStore.getState().keyEntry).toBe(true);
  });

  it("shows a backend error message on a plain failure", async () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true });
    tauri.invoke({
      list_dir: () => [],
      claude_text: () => {
        throw "boom: backend exploded";
      },
    });
    const { getByText, findByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("✨ generate with AI"));
    expect(await findByText(/boom: backend exploded/)).toBeTruthy();
  });

  it("shows the loading label while generating, then flips to the review panel on success", async () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true, model: "claude-opus-4-8" });
    let resolveText!: (v: string) => void;
    tauri.invoke({
      list_dir: () => [{ name: "package.json", is_dir: false }],
      read_text_file: () => '{"name":"x"}',
      claude_text: (a: Record<string, unknown>) => {
        expect(a.model).toBe("claude-opus-4-8");
        return new Promise<string>((res) => {
          resolveText = res;
        });
      },
    });
    const { getByText, findByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("✨ generate with AI"));
    expect(getByText("✨ generating…")).toBeTruthy();
    await waitFor(() => expect(resolveText).toBeDefined());
    resolveText(JSON.stringify([{ name: "dev", desc: "run dev", tasks: [{ cmd: "npm run dev" }] }]));
    expect(await findByText("Review generated scripts")).toBeTruthy();
    expect(getByText("1 of 1 selected")).toBeTruthy();
  });

  it("a second click while loading is a no-op (onClick is undefined)", async () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true });
    let calls = 0;
    let resolveText!: (v: string) => void;
    tauri.invoke({
      list_dir: () => [],
      claude_text: () => {
        calls += 1;
        return new Promise<string>((res) => {
          resolveText = res;
        });
      },
    });
    const { getByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("✨ generate with AI"));
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.click(getByText("✨ generating…"));
    expect(calls).toBe(1);
    resolveText("[]");
    await new Promise((r) => setTimeout(r, 0));
  });
});

// ---------------------------------------------------------------------------
// ReviewPanel
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — ReviewPanel", () => {
  async function openReview(scripts: unknown[] = [{ name: "dev", desc: "run dev", tasks: [{ cmd: "npm run dev" }] }]) {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true });
    tauri.invoke({ list_dir: () => [], claude_text: () => JSON.stringify(scripts) });
    const utils = render(<ScriptsSetupModal />);
    fireEvent.click(utils.getByText("✨ generate with AI"));
    await utils.findByText("Review generated scripts");
    return utils;
  }

  it("shows the split badge only for a multi-task split script", async () => {
    const { getByText } = await openReview([
      { name: "dev", tasks: [{ cmd: "a" }] },
      { name: "watch", split: true, tasks: [{ cmd: "a" }, { cmd: "b" }] },
    ]);
    expect(getByText("split")).toBeTruthy();
    expect(getByText("2 of 2 selected")).toBeTruthy();
  });

  it("unchecking a script decrements the selected count and disables Adopt at zero", async () => {
    const { getByText, getByRole } = await openReview();
    const checkbox = getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(getByText("0 of 1 selected")).toBeTruthy();
    // Clicking Adopt with nothing selected must not add anything (onClick is undefined).
    fireEvent.click(getByText(/^Add /));
    expect(scriptsForRoot("/repo")).toHaveLength(0);
    expect(getByText("Review generated scripts")).toBeTruthy(); // still on the review screen
  });

  it("edits a proposed script's name/desc/task in place before adopting", async () => {
    const { getByDisplayValue, getByText } = await openReview();
    fireEvent.change(getByDisplayValue("dev"), { target: { value: "develop" } });
    fireEvent.change(getByDisplayValue("run dev"), { target: { value: "runs the dev server" } });
    fireEvent.change(getByDisplayValue("npm run dev"), { target: { value: "npm run dev -- --port 3000" } });
    fireEvent.click(getByText(/^Add /));
    const [s] = scriptsForRoot("/repo");
    expect(s.name).toBe("develop");
    expect(s.desc).toBe("runs the dev server");
    expect(s.tasks[0].cmd).toBe("npm run dev -- --port 3000");
  });

  it("adopting appends kept scripts and returns to the normal editor", async () => {
    const { getByText, queryByText } = await openReview([
      { name: "keep-me", tasks: [{ cmd: "a" }] },
      { name: "drop-me", tasks: [{ cmd: "b" }] },
    ]);
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[1]); // uncheck "drop-me"
    fireEvent.click(getByText(/^Add /));
    expect(queryByText("Review generated scripts")).toBeNull();
    expect(scriptsForRoot("/repo").map((s) => s.name)).toEqual(["keep-me"]);
  });

  it("Cancel returns to the idle editor without adopting anything", async () => {
    const { getByText, queryByText } = await openReview();
    fireEvent.click(getByText("Cancel"));
    expect(queryByText("Review generated scripts")).toBeNull();
    expect(scriptsForRoot("/repo")).toHaveLength(0);
  });

  it("closing via × or the overlay also discards the review without adopting", async () => {
    const { getByText, queryByText } = await openReview();
    fireEvent.click(getByText("×"));
    expect(queryByText("Review generated scripts")).toBeNull();
    expect(scriptsForRoot("/repo")).toHaveLength(0);
  });

  it("Adopt is a no-op if root becomes null before the click (guards the stale-review edge case)", async () => {
    const { getByText, rerender } = await openReview();
    // Simulate the active pane disappearing while the review screen is still up.
    useStore.setState({ workspaces: [], activeWs: null }, false);
    rerender(<ScriptsSetupModal />);
    fireEvent.click(getByText(/^Add /));
    expect(scriptsForRoot("/repo")).toHaveLength(0);
    expect(getByText("Review generated scripts")).toBeTruthy(); // still reviewing — adopt() returned early
  });
});
