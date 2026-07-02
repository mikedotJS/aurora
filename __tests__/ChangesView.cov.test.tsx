// Coverage suite for src/components/ChangesView.tsx — the staged/unstaged file
// list, diff pane (unified/split, binary/empty/no-changes states), per-file
// stage/unstage/discard, stage-all, and the Open-MR handoff (existing MR /
// create-success / create-failure / no-branch).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ChangesView } from "../src/components/ChangesView";
import { useStore, type PaneState, type Group, type Workspace } from "../src/state/store";
import { tauri } from "../test/mocks/tauri";
import type { ChangedFile } from "../src/lib/git";

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
    ready: false,
    dirNames: [],
    blocks: [],
    repoRoot: null,
    firedHooks: [],
    hook: null,
    ...overrides,
  };
}

function mkWorkspace(pane: PaneState, wsOverrides: Partial<Workspace> = {}): Workspace {
  const group: Group = { id: seq++, panes: [pane], active: 0, split: "h" };
  return {
    id: "w-" + pane.id,
    repoId: null,
    title: "ws",
    issueKey: null,
    branch: "feature/x",
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
    tabs: [group],
    active: 0,
    createdAt: Date.now(),
    lastActive: Date.now(),
    serverTabId: null,
    ...wsOverrides,
  };
}

/** Installs `ws` (built around `pane`) as the sole, active workspace. */
function setup(pane: PaneState, wsOverrides: Partial<Workspace> = {}) {
  const ws = mkWorkspace(pane, wsOverrides);
  useStore.setState({ workspaces: [ws], activeWs: ws.id, initialized: true }, false);
  return ws;
}

function mkFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/foo.ts",
    old_path: null,
    status: "M",
    staged: false,
    added: 3,
    removed: 1,
    ...overrides,
  };
}

const UNIFIED_DIFF = ["@@ -1,2 +1,2 @@", " ctx", "-old line", "+new line"].join("\n");

beforeEach(() => {
  tauri.reset();
});
afterEach(() => {
  cleanup();
});

describe("ChangesView — no matching workspace", () => {
  it("renders the empty state and does nothing on Open MR when no workspace owns the pane", async () => {
    // No workspace installed at all: ws lookup fails, dir/base/branch all fall back to "".
    // With no base, the view compares against the working tree (not a base branch).
    useStore.setState({ workspaces: [], activeWs: null, initialized: true }, false);
    const { container, getByText } = render(<ChangesView wsId="none" />);
    await waitFor(() => expect(container.textContent).toContain("no uncommitted changes"));
    expect(container.textContent).toContain("select a file to view its diff");
    fireEvent.click(getByText("⇋ Open MR"));
    // branch is "" -> onOpenMr returns early; no glab_mr_create call.
    expect(tauri.calls().some((c) => c.cmd === "glab_mr_create")).toBe(false);
  });
});

describe("ChangesView — empty changes", () => {
  it("shows the 'no changes' placeholder against the base branch when the file list is empty", async () => {
    const pane = mkPane();
    setup(pane, { baseBranch: "develop" });
    tauri.invoke({ git_changed_files: () => [] });
    const { container } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(container.textContent).toContain("no changes against develop"));
    expect(container.textContent).toContain("select a file to view its diff");
  });
});

describe("ChangesView — file list & selection", () => {
  it("lists staged and unstaged sections, auto-selects the first file, and loads its worktree diff", async () => {
    const pane = mkPane();
    const ws = setup(pane);
    const files: ChangedFile[] = [
      mkFile({ path: "src/a.ts", status: "A", staged: true, added: 5, removed: 1 }),
      mkFile({ path: "lib/b.ts", status: "M", staged: false, added: 2, removed: 4 }),
      mkFile({ path: "c.ts", status: "?", staged: false, added: null, removed: null }),
    ];
    tauri.invoke({
      git_changed_files: () => files,
      git_diff_file: () => UNIFIED_DIFF,
      git_status_summary: () => ({ files: 3, added: 7, removed: 4, conflicted: 0 }),
    });
    const { container, getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(container.textContent).toContain("Staged · 1"));
    expect(container.textContent).toContain("Changes · 2");
    expect(container.textContent).toContain("a.ts");
    expect(container.textContent).toContain("b.ts");
    expect(container.textContent).toContain("c.ts");
    // dirOf renders the parent directory badge next to the basename.
    expect(container.textContent).toContain("lib");
    // First file (staged a.ts) auto-selected; its diff is fetched in "staged" mode.
    await waitFor(() => expect(tauri.lastCall("git_diff_file")).toBeTruthy());
    expect(tauri.lastCall("git_diff_file")?.args).toMatchObject({ dir: "/repo", base: "main", path: "src/a.ts", mode: "staged" });
    // status summary rolled into the workspace's diff badge.
    await waitFor(() => expect(useStore.getState().workspaces.find((w) => w.id === ws.id)?.diff).toEqual({ files: 3, added: 7, removed: 4, conflicted: 0 }));
    // footer totals: 5+2+0 added, 1+4+0 removed
    expect(container.textContent).toContain("3 files");
    expect(getByText("+7")).toBeTruthy();
    expect(getByText("−5")).toBeTruthy();
  });

  it("selects a clicked unstaged file and fetches its diff in worktree mode", async () => {
    const pane = mkPane();
    setup(pane);
    const files: ChangedFile[] = [mkFile({ path: "a.ts", staged: true }), mkFile({ path: "b.ts", staged: false, status: "M" })];
    tauri.invoke({ git_changed_files: () => files, git_diff_file: () => UNIFIED_DIFF });
    const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("b.ts")).toBeTruthy());
    fireEvent.click(getByText("b.ts"));
    await waitFor(() => expect(tauri.lastCall("git_diff_file")?.args).toMatchObject({ path: "b.ts", mode: "worktree" }));
  });

  it("fetches an untracked ('?') file's diff in worktree mode", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "new.ts", status: "?", staged: false })],
      git_diff_file: () => "",
    });
    const { container } = render(<ChangesView wsId={"w-" + pane.id} />);
    // "new.ts" appears both in the file-list row and the auto-selected diff header.
    await waitFor(() => expect(container.textContent).toContain("new.ts"));
    await waitFor(() => expect(tauri.lastCall("git_diff_file")?.args).toMatchObject({ mode: "worktree" }));
    // no textual hunks + status "?" -> the "stage it to see its diff" hint
    await waitFor(() => expect(document.body.textContent).toContain("Untracked file — stage it to see its diff."));
  });
});

describe("ChangesView — diff pane states", () => {
  it("shows the binary-file placeholder when the diff is flagged binary", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "img.png" })],
      git_diff_file: () => "Binary files a/img.png and b/img.png differ",
    });
    render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(document.body.textContent).toContain("Binary file — no text diff."));
  });

  it("shows 'No textual changes.' for a tracked file with an empty, non-binary diff", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "same.ts", status: "M" })],
      git_diff_file: () => "",
    });
    render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(document.body.textContent).toContain("No textual changes."));
  });

  it("renders the unified diff by default, then switches to split view and shows the base/working headers", async () => {
    const pane = mkPane();
    setup(pane, { baseBranch: "main", branch: "feature/x" });
    tauri.invoke({ git_changed_files: () => [mkFile({ path: "a.ts" })], git_diff_file: () => UNIFIED_DIFF });
    const { getByText, container } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(container.textContent).toContain("new line"));
    expect(container.textContent).toContain("old line");
    // switch to split
    fireEvent.click(getByText("Split"));
    await waitFor(() => expect(container.textContent).toContain("base"));
    expect(container.textContent).toContain("working tree");
    expect(container.textContent).toContain("⎇ feature/x");
    // switch back to unified
    fireEvent.click(getByText("Unified"));
    await waitFor(() => expect(container.textContent).not.toContain("working tree"));
  });

  it("falls back to 'working' label in the split header when the workspace has no branch", async () => {
    const pane = mkPane();
    setup(pane, { branch: null });
    tauri.invoke({ git_changed_files: () => [mkFile({ path: "a.ts" })], git_diff_file: () => UNIFIED_DIFF });
    const { getByText, container } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(container.textContent).toContain("new line"));
    fireEvent.click(getByText("Split"));
    await waitFor(() => expect(container.textContent).toContain("⎇ working · working tree"));
  });
});

describe("ChangesView — stage / unstage / discard / stage-all", () => {
  it("unstages a staged, selected file, reloads the list, and follows it to the unstaged section", async () => {
    const pane = mkPane();
    setup(pane);
    let staged = true;
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "a.ts", staged, added: 1, removed: 0 })],
      git_diff_file: () => "",
      git_unstage: () => {
        staged = false;
        return undefined;
      },
    });
    const { getByText, container } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("Unstage")).toBeTruthy());
    fireEvent.click(getByText("Unstage"));
    await waitFor(() => expect(tauri.lastCall("git_unstage")?.args).toMatchObject({ dir: "/repo", path: "a.ts" }));
    await waitFor(() => expect(getByText("Stage")).toBeTruthy());
    // The file followed into the "Changes" (unstaged) section, still selected.
    expect(container.textContent).toContain("Changes · 1");
  });

  it("stages an unstaged, selected file via the header Stage action", async () => {
    const pane = mkPane();
    setup(pane);
    let staged = false;
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "a.ts", staged })],
      git_diff_file: () => "",
      git_stage: () => {
        staged = true;
        return undefined;
      },
    });
    const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("Stage")).toBeTruthy());
    fireEvent.click(getByText("Stage"));
    await waitFor(() => expect(tauri.lastCall("git_stage")?.args).toMatchObject({ dir: "/repo", path: "a.ts" }));
    await waitFor(() => expect(getByText("Unstage")).toBeTruthy());
  });

  it("stages all unstaged files via the 'Stage all' footer action", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "a.ts", staged: false })],
      git_diff_file: () => "",
      git_stage_all: () => undefined,
    });
    const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("Stage all")).toBeTruthy());
    fireEvent.click(getByText("Stage all"));
    await waitFor(() => expect(tauri.calls().some((c) => c.cmd === "git_stage_all" && c.args.dir === "/repo")).toBe(true));
  });

  it("discards a tracked file's changes only after confirm() returns true, passing untracked=false", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "a.ts", status: "M", staged: false })],
      git_diff_file: () => "",
      git_discard: () => undefined,
    });
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
      await waitFor(() => expect(getByText("Discard")).toBeTruthy());
      fireEvent.click(getByText("Discard"));
      await waitFor(() => expect(tauri.lastCall("git_discard")).toBeTruthy());
      expect(tauri.lastCall("git_discard")?.args).toMatchObject({ dir: "/repo", path: "a.ts", untracked: false });
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it("discards an untracked file's changes with untracked=true", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "new.ts", status: "?", staged: false })],
      git_diff_file: () => "",
      git_discard: () => undefined,
    });
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
      await waitFor(() => expect(getByText("Discard")).toBeTruthy());
      fireEvent.click(getByText("Discard"));
      await waitFor(() => expect(tauri.lastCall("git_discard")?.args).toMatchObject({ path: "new.ts", untracked: true }));
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it("does not discard when confirm() returns false", async () => {
    const pane = mkPane();
    setup(pane);
    tauri.invoke({
      git_changed_files: () => [mkFile({ path: "a.ts", staged: false })],
      git_diff_file: () => "",
      git_discard: () => undefined,
    });
    const originalConfirm = window.confirm;
    window.confirm = () => false;
    try {
      const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
      await waitFor(() => expect(getByText("Discard")).toBeTruthy());
      fireEvent.click(getByText("Discard"));
      // give any microtasks a chance to run, then assert git_discard was never called
      await waitFor(() => expect(tauri.calls().some((c) => c.cmd === "git_changed_files")).toBe(true));
      expect(tauri.calls().some((c) => c.cmd === "git_discard")).toBe(false);
    } finally {
      window.confirm = originalConfirm;
    }
  });
});

describe("ChangesView — Open MR", () => {
  it("creates an MR successfully when the workspace has no MR yet, toggling the busy label meanwhile", async () => {
    const pane = mkPane();
    setup(pane, { branch: "feature/x", mr: null });
    let resolveMr: (v: undefined) => void;
    const gate = new Promise<undefined>((res) => (resolveMr = res));
    tauri.invoke({
      git_changed_files: () => [],
      glab_mr_create: () => gate,
    });
    const { getByText, queryByText } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("⇋ Open MR")).toBeTruthy());
    fireEvent.click(getByText("⇋ Open MR"));
    await waitFor(() => expect(queryByText("⇋ Opening…")).toBeTruthy());
    resolveMr!(undefined);
    await waitFor(() => expect(queryByText("⇋ Opening…")).toBeFalsy());
    expect(tauri.lastCall("glab_mr_create")?.args).toMatchObject({ cwd: "/repo", branch: "feature/x" });
  });

  it("shows a raw error toast when MR creation fails with a non-glab-missing error", async () => {
    const pane = mkPane();
    setup(pane, { branch: "feature/x", mr: null });
    tauri.invoke({
      git_changed_files: () => [],
      glab_mr_create: () => {
        throw new Error("remote rejected the push");
      },
    });
    const { getByText, container } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("⇋ Open MR")).toBeTruthy());
    fireEvent.click(getByText("⇋ Open MR"));
    await waitFor(() => expect(container.textContent).toContain("remote rejected the push"));
  });

  it("shows the 'glab not found' toast when the error message contains 'not-found'", async () => {
    const pane = mkPane();
    setup(pane, { branch: "feature/x", mr: null });
    tauri.invoke({
      git_changed_files: () => [],
      glab_mr_create: () => {
        throw new Error("glab-not-found: command missing");
      },
    });
    const { getByText, container } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("⇋ Open MR")).toBeTruthy());
    fireEvent.click(getByText("⇋ Open MR"));
    await waitFor(() => expect(container.textContent).toContain("GitLab CLI (glab) not found."));
  });

  it("opens the existing MR url directly (no create call) when the workspace already has one", async () => {
    const pane = mkPane();
    setup(pane, { branch: "feature/x", mr: { iid: 1, state: "open", url: "https://gitlab.example/mr/1" } });
    tauri.invoke({ git_changed_files: () => [] });
    const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("⇋ Open MR")).toBeTruthy());
    fireEvent.click(getByText("⇋ Open MR"));
    // glab_mr_create must never be invoked when an MR already exists.
    await waitFor(() => expect(tauri.calls().some((c) => c.cmd === "git_changed_files")).toBe(true));
    expect(tauri.calls().some((c) => c.cmd === "glab_mr_create")).toBe(false);
  });

  it("does nothing when there is no MR and no branch (early return)", async () => {
    const pane = mkPane();
    setup(pane, { branch: null, mr: null });
    tauri.invoke({ git_changed_files: () => [] });
    const { getByText } = render(<ChangesView wsId={"w-" + pane.id} />);
    await waitFor(() => expect(getByText("⇋ Open MR")).toBeTruthy());
    fireEvent.click(getByText("⇋ Open MR"));
    await waitFor(() => expect(tauri.calls().some((c) => c.cmd === "git_changed_files")).toBe(true));
    expect(tauri.calls().some((c) => c.cmd === "glab_mr_create")).toBe(false);
  });
});

describe("ChangesView — close control", () => {
  it("closes the overlay (clears changesWsId) via the ⌗ control", async () => {
    const pane = mkPane();
    const ws = setup(pane);
    useStore.getState().openChanges();
    tauri.invoke({ git_changed_files: () => [] });
    const { getByTitle } = render(<ChangesView wsId={ws.id} />);
    fireEvent.click(getByTitle("close (Esc)"));
    await waitFor(() => expect(useStore.getState().changesWsId).toBeNull());
  });
});
