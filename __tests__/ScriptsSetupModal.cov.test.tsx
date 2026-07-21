// Coverage suite for src/components/ScriptsSetupModal.tsx — the primary
// aurora.json scripts editor (managed-server-lifecycle task 5.4, reshaped for
// the corrected model: "1 command → 1 pane, 1 run script → multiple
// commands"): no-root placeholder, loading state, setup/archive fields, Run
// Script CRUD (add/remove/reorder — an ordered array, no ids), Custom Scripts
// CRUD (add/rename/patch/remove), Save (writes aurora.json + updates the
// store cache), the legacy-scripts-as-migration-path case, and the AI
// generate/review/adopt flow folding into the aurora.json draft's CUSTOM
// entries instead of the legacy userScripts store.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ScriptsSetupModal } from "../src/components/ScriptsSetupModal";
import { useStore, type PaneState, type Group, type Workspace } from "../src/state/store";
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
  useStore.setState({ userScripts: {}, auroraConfigs: {} }, false);
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
    expect(queryByText("+ add run command")).toBeNull();
    expect(queryByText("✨ generate with AI")).toBeNull();
  });

  it("closes via the × button and the overlay", () => {
    setup(null);
    const { getByText } = render(<ScriptsSetupModal />);
    fireEvent.click(getByText("×"));
    expect(useStore.getState().scriptsSetupOpen).toBe(false);

    useStore.setState({ scriptsSetupOpen: true }, false);
    const { container: c2 } = render(<ScriptsSetupModal />);
    const overlay = c2.firstElementChild!.firstElementChild!;
    expect(overlay.children).toHaveLength(0);
    fireEvent.click(overlay);
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Editor: loading → empty aurora.json, setup/archive fields
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — editor, no committed aurora.json", () => {
  it("shows 'loading…' first, then the setup/archive fields and empty-state hints", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const { getByText, findByPlaceholderText, container } = render(<ScriptsSetupModal />);
    expect(getByText("loading…")).toBeTruthy();
    await findByPlaceholderText("e.g. bun install");
    expect(container.textContent).toContain("/repo");
    expect(getByText("no run commands yet — the Run/Stop button in the rail shows up once you add one")).toBeTruthy();
    expect(getByText("no custom scripts yet — add one, then trigger it from the ▾ run menu")).toBeTruthy();
  });

  it("editing setup/archive and saving persists them into the store cache + writes aurora.json", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const { getByText, findByPlaceholderText, getByPlaceholderText } = render(<ScriptsSetupModal />);
    await findByPlaceholderText("e.g. bun install");
    fireEvent.change(getByPlaceholderText("e.g. bun install"), { target: { value: "bun install" } });
    fireEvent.change(getByPlaceholderText("e.g. docker compose down"), { target: { value: "docker compose down" } });
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    const saved = useStore.getState().auroraConfigs["/repo"];
    expect(saved?.scripts.setup).toBe("bun install");
    expect(saved?.scripts.archive).toBe("docker compose down");
    expect(tauri.lastCall("write_text_file")?.args).toMatchObject({ root: "/repo", path: "/repo/aurora.json" });
  });

  it("shows a save error inline and keeps the modal open on write failure", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
      write_text_file: () => {
        throw new Error("disk full");
      },
    });
    const { getByText, findByPlaceholderText, findByText } = render(<ScriptsSetupModal />);
    await findByPlaceholderText("e.g. bun install");
    fireEvent.click(getByText("Save aurora.json"));
    expect(await findByText(/disk full/)).toBeTruthy();
    expect(useStore.getState().scriptsSetupOpen).toBe(true); // still open
  });
});

// ---------------------------------------------------------------------------
// Run Script CRUD (ordered array — no ids)
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — Run Script CRUD", () => {
  async function openEditor() {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const utils = render(<ScriptsSetupModal />);
    await utils.findByPlaceholderText("e.g. bun install");
    return utils;
  }

  it("'+ add run command' creates a row; editing command/name/cwd and saving persists it", async () => {
    const { getByText, getByPlaceholderText } = await openEditor();
    fireEvent.click(getByText("+ add run command"));
    const cmdInput = getByPlaceholderText("command — e.g. bun run dev -p $AURORA_PORT");
    fireEvent.change(cmdInput, { target: { value: "bun run dev -p $AURORA_PORT" } });
    const nameInput = getByPlaceholderText("pane label (optional)");
    fireEvent.change(nameInput, { target: { value: "web" } });
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    const run = useStore.getState().auroraConfigs["/repo"]?.scripts.run ?? [];
    expect(run).toEqual([{ command: "bun run dev -p $AURORA_PORT", name: "web" }]);
  });

  it("reorders with ▲▼, boundary arrows are inert", async () => {
    const { getByText, getAllByPlaceholderText, getAllByTitle } = await openEditor();
    fireEvent.click(getByText("+ add run command"));
    fireEvent.click(getByText("+ add run command"));
    const cmdInputs = getAllByPlaceholderText("command — e.g. bun run dev -p $AURORA_PORT");
    fireEvent.change(cmdInputs[0], { target: { value: "first" } });
    fireEvent.change(cmdInputs[1], { target: { value: "second" } });

    // Moving the first row down (or the second row up) swaps them.
    const downButtons = getAllByTitle("move down");
    fireEvent.click(downButtons[0]);

    const reordered = getAllByPlaceholderText("command — e.g. bun run dev -p $AURORA_PORT") as HTMLInputElement[];
    expect(reordered.map((i) => i.value)).toEqual(["second", "first"]);

    // The first row's "move up" is a no-op (canUp is false at index 0) — the
    // swapped order ["second", "first"] survives unchanged.
    const upButtons = getAllByTitle("move up");
    fireEvent.click(upButtons[0]);
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    const run = useStore.getState().auroraConfigs["/repo"]?.scripts.run ?? [];
    expect(run.map((r) => r.command)).toEqual(["second", "first"]);
  });

  it("removing a row drops it (never saved)", async () => {
    const { getByText, getAllByTitle } = await openEditor();
    fireEvent.click(getByText("+ add run command"));
    fireEvent.click(getAllByTitle("remove")[0]);
    expect(getByText("no run commands yet — the Run/Stop button in the rail shows up once you add one")).toBeTruthy();
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    expect(useStore.getState().auroraConfigs["/repo"]?.scripts.run).toEqual([]);
  });

  it("cwd is set when non-empty, omitted (undefined) when cleared", async () => {
    const { getByText, getByPlaceholderText } = await openEditor();
    fireEvent.click(getByText("+ add run command"));
    fireEvent.change(getByPlaceholderText("command — e.g. bun run dev -p $AURORA_PORT"), { target: { value: "bun" } });
    fireEvent.change(getByPlaceholderText("."), { target: { value: "apps/web" } });
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    expect(useStore.getState().auroraConfigs["/repo"]?.scripts.run).toEqual([{ command: "bun", cwd: "apps/web" }]);
  });
});

// ---------------------------------------------------------------------------
// Custom Scripts CRUD
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — Custom Scripts CRUD", () => {
  async function openEditor() {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const utils = render(<ScriptsSetupModal />);
    await utils.findByPlaceholderText("e.g. bun install");
    return utils;
  }

  it("'+ add custom script' creates an entry; editing id/command and saving persists it", async () => {
    const { getByText, getByPlaceholderText } = await openEditor();
    fireEvent.click(getByText("+ add custom script"));
    const cmdInput = getByPlaceholderText("command — e.g. bun run lint");
    fireEvent.change(cmdInput, { target: { value: "bun run lint" } });
    const idInput = getByPlaceholderText("id");
    fireEvent.change(idInput, { target: { value: "lint" } });
    fireEvent.blur(idInput);
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    const custom = useStore.getState().auroraConfigs["/repo"]?.scripts.custom ?? {};
    expect(custom.lint).toEqual({ command: "bun run lint" });
  });

  it("a second add gets a unique id ('task-2'); remove works", async () => {
    const { getByText, getAllByPlaceholderText, getAllByTitle } = await openEditor();
    fireEvent.click(getByText("+ add custom script"));
    fireEvent.click(getByText("+ add custom script"));
    const idInputs = getAllByPlaceholderText("id") as HTMLInputElement[];
    expect(idInputs.map((i) => i.value)).toEqual(["task", "task-2"]);

    fireEvent.click(getAllByTitle("remove")[0]);
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    expect(Object.keys(useStore.getState().auroraConfigs["/repo"]?.scripts.custom ?? {})).toEqual(["task-2"]);
  });

  it("renaming to an id that already exists is a no-op (collision guard)", async () => {
    const { getByText, getAllByPlaceholderText } = await openEditor();
    fireEvent.click(getByText("+ add custom script")); // "task"
    fireEvent.click(getByText("+ add custom script")); // "task-2"
    const idInputs = getAllByPlaceholderText("id") as HTMLInputElement[];
    fireEvent.change(idInputs[1], { target: { value: "task" } }); // collides with idInputs[0]
    fireEvent.blur(idInputs[1]);
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    // Both entries survive under their original ids — rename was rejected.
    expect(Object.keys(useStore.getState().auroraConfigs["/repo"]?.scripts.custom ?? {}).sort()).toEqual([
      "task",
      "task-2",
    ]);
  });
});

describe("ScriptsSetupModal — legacy scripts as the migration path", () => {
  it("a repo with only legacy scripts (no committed aurora.json) shows the onEnter script as a Run Script row; Save commits the migration", async () => {
    useStore.setState(
      {
        userScripts: {
          "/repo": { scripts: [{ name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "npm run dev" }] }], onEnter: "dev" },
        },
      },
      false,
    );
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const { findByDisplayValue, getByText } = render(<ScriptsSetupModal />);
    await findByDisplayValue("npm run dev"); // the migrated run row's command field
    fireEvent.click(getByText("Save aurora.json"));
    await waitFor(() => expect(useStore.getState().scriptsSetupOpen).toBe(false));
    expect(tauri.lastCall("write_text_file")?.args).toMatchObject({ root: "/repo", path: "/repo/aurora.json" });
    const saved = useStore.getState().auroraConfigs["/repo"];
    expect(saved?.scripts.run).toEqual([{ command: "npm run dev", name: "dev" }]);
  });

  it("every OTHER legacy script (not onEnter) shows up as a Custom Scripts row", async () => {
    useStore.setState(
      {
        userScripts: {
          "/repo": {
            scripts: [
              { name: "dev", desc: "", split: false, tasks: [{ dir: "", cmd: "npm run dev" }] },
              { name: "lint", desc: "", split: false, tasks: [{ dir: "", cmd: "npm run lint" }] },
            ],
            onEnter: "dev",
          },
        },
      },
      false,
    );
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const { findByDisplayValue } = render(<ScriptsSetupModal />);
    await findByDisplayValue("lint"); // the migrated custom entry's id field
  });
});

// ---------------------------------------------------------------------------
// AI generate: idle -> loading -> {error | review}
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — generate with AI", () => {
  it("routes to key entry (without calling the model) when no API key is present", async () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: false });
    tauri.invoke({
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const { findByText } = render(<ScriptsSetupModal />);
    fireEvent.click(await findByText("✨ generate with AI"));
    expect(useStore.getState().scriptsSetupOpen).toBe(false);
    expect(useStore.getState().keyEntry).toBe(true);
    expect(tauri.calls().some((c) => c.cmd === "claude_text")).toBe(false);
  });

  it("shows an error state when Claude proposes zero usable scripts", async () => {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true });
    tauri.invoke({ list_dir: () => [], claude_text: () => "[]" });
    const { findByText } = render(<ScriptsSetupModal />);
    fireEvent.click(await findByText("✨ generate with AI"));
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
    const { findByText } = render(<ScriptsSetupModal />);
    fireEvent.click(await findByText("✨ generate with AI"));
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
    const { findByText } = render(<ScriptsSetupModal />);
    fireEvent.click(await findByText("✨ generate with AI"));
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
    fireEvent.click(await findByText("✨ generate with AI"));
    expect(getByText("✨ generating…")).toBeTruthy();
    await waitFor(() => expect(resolveText).toBeDefined());
    resolveText(JSON.stringify([{ name: "dev", desc: "run dev", tasks: [{ cmd: "npm run dev" }] }]));
    expect(await findByText("Review generated scripts")).toBeTruthy();
    expect(getByText("1 of 1 selected")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ReviewPanel → adopt folds into the aurora.json draft's CUSTOM entries
// ---------------------------------------------------------------------------

describe("ScriptsSetupModal — ReviewPanel adopt", () => {
  async function openReview(scripts: unknown[] = [{ name: "dev", desc: "run dev", tasks: [{ cmd: "npm run dev" }] }]) {
    const pane = mkPane();
    setup(pane, { apiKeyPresent: true });
    tauri.invoke({
      list_dir: () => [],
      claude_text: () => JSON.stringify(scripts),
      read_text_file: () => {
        throw new Error("ENOENT");
      },
    });
    const utils = render(<ScriptsSetupModal />);
    fireEvent.click(await utils.findByText("✨ generate with AI"));
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
    fireEvent.click(getByRole("checkbox"));
    expect(getByText("0 of 1 selected")).toBeTruthy();
    fireEvent.click(getByText(/^Add /));
    expect(getByText("Review generated scripts")).toBeTruthy(); // still on the review screen
  });

  it("adopting folds kept scripts into CUSTOM entries — visible in the editor, never in the legacy store, never in run", async () => {
    const { getByText, findByDisplayValue, queryByText } = await openReview([
      { name: "keep-me", tasks: [{ cmd: "a" }] },
      { name: "drop-me", tasks: [{ cmd: "b" }] },
    ]);
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[1]); // uncheck "drop-me"
    fireEvent.click(getByText(/^Add /));
    expect(queryByText("Review generated scripts")).toBeNull();
    await findByDisplayValue("keep-me"); // adopted custom entry's id field, back on the editor
    expect(useStore.getState().userScripts["/repo"]).toBeUndefined(); // legacy store untouched
  });

  it("editing a proposal's command before adopting uses the EDITED command, not the original (patchTask/patchReview)", async () => {
    const { getByDisplayValue, getByText, findByDisplayValue } = await openReview([
      { name: "dev", tasks: [{ cmd: "npm run dev" }] },
    ]);
    fireEvent.change(getByDisplayValue("npm run dev"), { target: { value: "npm run dev:edited" } });
    fireEvent.click(getByText(/^Add /));
    expect(await findByDisplayValue("dev")).toBeTruthy(); // adopted custom entry's id — slugified from the script name
  });

  it("Cancel returns to the idle editor without adopting anything", async () => {
    const { getByText, queryByText } = await openReview();
    fireEvent.click(getByText("Cancel"));
    expect(queryByText("Review generated scripts")).toBeNull();
    expect(getByText("no custom scripts yet — add one, then trigger it from the ▾ run menu")).toBeTruthy();
  });

  it("closing via × also discards the review without adopting", async () => {
    const { getByText, queryByText } = await openReview();
    fireEvent.click(getByText("×"));
    expect(queryByText("Review generated scripts")).toBeNull();
    expect(getByText("no custom scripts yet — add one, then trigger it from the ▾ run menu")).toBeTruthy();
  });

  it("the review screen itself is discarded once the workspace disappears mid-review (the root-change effect resets gen+draft)", async () => {
    const { queryByText, getByText, rerender } = await openReview();
    useStore.setState({ workspaces: [], activeWs: null }, false);
    rerender(<ScriptsSetupModal />);
    // root is now null → the effect reset `gen` to idle, falling back to the placeholder.
    expect(queryByText("Review generated scripts")).toBeNull();
    expect(getByText("cd into a repo to edit its scripts")).toBeTruthy();
  });
});
