// Coverage suite for src/components/MrSheet.tsx — the GitLab merge-requests
// bottom sheet: all empty-state branches (no repo, loading, no MRs, no
// search/mine matches), row rendering (draft/author/updated optionality),
// the local `matches()` filter (title/branch/author/iid/!iid, case-insens,
// empty query), keyboard nav (↑↓ Enter Esc ⌘M), the mine toggle (enabled vs
// disabled), row click/hover, and the focus-once-per-mount guard.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as opener from "@tauri-apps/plugin-opener";
import { MrSheet } from "../src/components/MrSheet";
import { useStore, type PaneState, type Group, type Workspace, type GitlabMr } from "../src/state/store";
import { tauri } from "../test/mocks/tauri";

let paneSeq = 9000;

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

function mkWorkspace(pane: PaneState): Workspace {
  const group: Group = { id: paneSeq++, panes: [pane], active: 0, split: "h" };
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
  };
}

// src/lib/notifications.ts keeps module-level caches keyed by repo root
// (userByRoot for ensureGlabUser, snapshots/notGitlab for MR polling) that are
// never reset between tests in this file. Reusing the same root string across
// tests would leak a previous test's cached glab user / MR snapshot into a
// later one, so every setup() call gets its own unique root.
let rootSeq = 0;

/** Installs a pane with the given repoRoot as the sole active pane, and resets
 *  the panel-relevant store slices MrSheet reads. A non-null `repoRootBase` is
 *  suffixed to guarantee a fresh root per test (see note above). */
function setup(
  repoRootBase: string | null,
  extra: { home?: string; repoMrs?: Record<string, GitlabMr[]>; glabUser?: string | null } = {},
) {
  const repoRoot = repoRootBase === null ? null : `${repoRootBase}#${rootSeq++}`;
  const pane = mkPane({ repoRoot, cwd: repoRoot ?? "/Users/test/proj" });
  const ws = mkWorkspace(pane);
  useStore.setState(
    {
      workspaces: [ws],
      activeWs: ws.id,
      initialized: true,
      home: extra.home ?? "/Users/test",
      panel: "mr",
      repoMrs: extra.repoMrs ?? {},
      glabUser: extra.glabUser ?? null,
    },
    false,
  );
  return ws;
}

function mkMr(overrides: Partial<GitlabMr> = {}): GitlabMr {
  return {
    iid: 1,
    title: "Add feature",
    branch: "feature/a",
    draft: false,
    author: "alice",
    web_url: "https://gitlab.example.com/mr/1",
    updated: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

let openUrlSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tauri.reset();
  openUrlSpy = spyOn(opener, "openUrl");
  openUrlSpy.mockClear();
});
afterEach(cleanup);

describe("MrSheet — no repo", () => {
  it("shows the 'not a git repository' empty state, resolves glabUser to null without polling glab_mr_list", async () => {
    useStore.setState({ glabUser: "someone-stale" }, false);
    setup(null);
    const { getByText } = render(<MrSheet />);
    expect(getByText("not a git repository")).toBeTruthy();
    await waitFor(() => expect(useStore.getState().glabUser).toBeNull());
    expect(tauri.calls().some((c) => c.cmd === "glab_mr_list")).toBe(false);
  });

  it("disables the 'mine' toggle when there is no glab user", () => {
    setup(null);
    const { getByText } = render(<MrSheet />);
    const mineBtn = getByText("mine") as HTMLButtonElement;
    expect(mineBtn.disabled).toBe(true);
  });
});

describe("MrSheet — loading and empty-result states", () => {
  it("shows 'loading merge requests…' before the force-refresh resolves", () => {
    let resolveMrs!: (v: GitlabMr[]) => void;
    tauri.invoke({ glab_mr_list: () => new Promise<GitlabMr[]>((res) => (resolveMrs = res)) });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    expect(getByText("loading merge requests…")).toBeTruthy();
    resolveMrs([]); // let the pending invoke settle so it doesn't leak into the next test
  });

  it("shows the 'no open merge requests' empty state once refreshed with an empty list", async () => {
    tauri.invoke({ glab_mr_list: () => [] });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText(/no open merge requests/)).toBeTruthy());
  });

  it("shows the same empty state when glab isn't installed/authed (glab_mr_list rejects, mrs stays undefined)", async () => {
    tauri.invoke({
      glab_mr_list: () => {
        throw new Error("glab: command not found");
      },
    });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText(/no open merge requests/)).toBeTruthy());
  });

  it("shows a search-specific empty state when a query matches nothing", async () => {
    tauri.invoke({ glab_mr_list: () => [mkMr()] });
    setup("/Users/test/proj");
    const { getByPlaceholderText, getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("Add feature")).toBeTruthy());
    fireEvent.change(getByPlaceholderText("Search title, branch, author, !iid…"), { target: { value: "zzz-nope" } });
    expect(getByText("no merge requests match your search")).toBeTruthy();
  });

  it("shows a mine-specific empty state when 'mine' filters out every MR", async () => {
    // ensureGlabUser() re-resolves glabUser from glab_current_user on mount, so
    // the mock must agree with the "alice" we seed via setup()'s extra.glabUser
    // — otherwise the effect clobbers it back to the default (null).
    tauri.invoke({ glab_mr_list: () => [mkMr({ author: "bob" })], glab_current_user: () => "alice" });
    setup("/Users/test/proj", { glabUser: "alice" });
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("Add feature")).toBeTruthy());
    const mineBtn = getByText("mine") as HTMLButtonElement;
    expect(mineBtn.disabled).toBe(false);
    fireEvent.click(mineBtn);
    expect(getByText("none of your merge requests match")).toBeTruthy();
  });
});

describe("MrSheet — row rendering", () => {
  it("renders title, !iid, branch, author, and formatted updated date", async () => {
    tauri.invoke({ glab_mr_list: () => [mkMr({ iid: 42, title: "Ship it", branch: "feature/x", author: "alice", updated: "2026-06-01T00:00:00Z" })] });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("Ship it")).toBeTruthy());
    expect(getByText("!42")).toBeTruthy();
    expect(getByText("⎇ feature/x")).toBeTruthy();
    expect(getByText("· alice")).toBeTruthy();
    expect(getByText(new Date("2026-06-01T00:00:00Z").toLocaleDateString(), { exact: false })).toBeTruthy();
  });

  it("shows the draft badge only for draft MRs", async () => {
    tauri.invoke({ glab_mr_list: () => [mkMr({ iid: 1, draft: true }), mkMr({ iid: 2, draft: false })] });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("!1")).toBeTruthy());
    const draftBadges = document.querySelectorAll("body *");
    expect([...draftBadges].some((el) => el.textContent === "draft")).toBe(true);
  });

  it("omits author and updated spans when those fields are empty", async () => {
    tauri.invoke({ glab_mr_list: () => [mkMr({ author: "", updated: "" })] });
    setup("/Users/test/proj");
    const { getByText, queryByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("Add feature")).toBeTruthy());
    expect(queryByText("· alice")).toBeNull();
  });

  it("clicking a row with a web_url opens it; hovering a row updates its selection highlight", async () => {
    tauri.invoke({ glab_mr_list: () => [mkMr({ iid: 1, web_url: "https://gitlab.example.com/mr/1" }), mkMr({ iid: 2, web_url: "https://gitlab.example.com/mr/2" })] });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("!2")).toBeTruthy());
    fireEvent.mouseEnter(getByText("!2"));
    fireEvent.click(getByText("!2"));
    expect(openUrlSpy).toHaveBeenCalledWith("https://gitlab.example.com/mr/2");
  });

  it("clicking a row without a web_url does nothing", async () => {
    tauri.invoke({ glab_mr_list: () => [mkMr({ web_url: "" })] });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("Add feature")).toBeTruthy());
    fireEvent.click(getByText("Add feature"));
    expect(openUrlSpy).not.toHaveBeenCalled();
  });
});

describe("MrSheet — search filter (matches())", () => {
  const mrs = [
    mkMr({ iid: 7, title: "Fix login bug", branch: "fix/login", author: "carol", web_url: "u1" }),
    mkMr({ iid: 99, title: "Add dashboard", branch: "feature/dash", author: "dave", web_url: "u2" }),
  ];

  async function renderFiltered() {
    tauri.invoke({ glab_mr_list: () => mrs });
    setup("/Users/test/proj");
    const utils = render(<MrSheet />);
    await waitFor(() => expect(utils.getByText("Fix login bug")).toBeTruthy());
    return utils;
  }

  it("matches by title (case-insensitive)", async () => {
    const { getByPlaceholderText, getByText, queryByText } = await renderFiltered();
    fireEvent.change(getByPlaceholderText("Search title, branch, author, !iid…"), { target: { value: "LOGIN" } });
    expect(getByText("Fix login bug")).toBeTruthy();
    expect(queryByText("Add dashboard")).toBeNull();
  });

  it("matches by branch", async () => {
    const { getByPlaceholderText, getByText, queryByText } = await renderFiltered();
    fireEvent.change(getByPlaceholderText("Search title, branch, author, !iid…"), { target: { value: "feature/dash" } });
    expect(getByText("Add dashboard")).toBeTruthy();
    expect(queryByText("Fix login bug")).toBeNull();
  });

  it("matches by author", async () => {
    const { getByPlaceholderText, getByText, queryByText } = await renderFiltered();
    fireEvent.change(getByPlaceholderText("Search title, branch, author, !iid…"), { target: { value: "dave" } });
    expect(getByText("Add dashboard")).toBeTruthy();
    expect(queryByText("Fix login bug")).toBeNull();
  });

  it("matches by bare iid substring", async () => {
    const { getByPlaceholderText, getByText, queryByText } = await renderFiltered();
    fireEvent.change(getByPlaceholderText("Search title, branch, author, !iid…"), { target: { value: "99" } });
    expect(getByText("Add dashboard")).toBeTruthy();
    expect(queryByText("Fix login bug")).toBeNull();
  });

  it("matches by !iid form", async () => {
    const { getByPlaceholderText, getByText, queryByText } = await renderFiltered();
    fireEvent.change(getByPlaceholderText("Search title, branch, author, !iid…"), { target: { value: "!7" } });
    expect(getByText("Fix login bug")).toBeTruthy();
    expect(queryByText("Add dashboard")).toBeNull();
  });

  it("a whitespace-only query behaves like an empty query (all match)", async () => {
    const { getByPlaceholderText, getByText } = await renderFiltered();
    fireEvent.change(getByPlaceholderText("Search title, branch, author, !iid…"), { target: { value: "   " } });
    expect(getByText("Fix login bug")).toBeTruthy();
    expect(getByText("Add dashboard")).toBeTruthy();
  });
});

describe("MrSheet — keyboard navigation", () => {
  async function renderTwo() {
    tauri.invoke({
      glab_mr_list: () => [
        mkMr({ iid: 1, title: "First", web_url: "https://gitlab.example.com/mr/1" }),
        mkMr({ iid: 2, title: "Second", web_url: "https://gitlab.example.com/mr/2" }),
      ],
    });
    setup("/Users/test/proj");
    const utils = render(<MrSheet />);
    await waitFor(() => expect(utils.getByText("First")).toBeTruthy());
    return utils;
  }

  it("Escape closes the panel", async () => {
    const { getByPlaceholderText } = await renderTwo();
    fireEvent.keyDown(getByPlaceholderText("Search title, branch, author, !iid…"), { key: "Escape" });
    expect(useStore.getState().panel).toBeNull();
  });

  it("ArrowDown/ArrowUp move the selection and Enter opens the selected MR", async () => {
    const { getByPlaceholderText } = await renderTwo();
    const input = getByPlaceholderText("Search title, branch, author, !iid…");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // sel -> 1 (Second)
    fireEvent.keyDown(input, { key: "ArrowDown" }); // clamped at 1 (only 2 items)
    fireEvent.keyDown(input, { key: "ArrowUp" }); // sel -> 0 (First)
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openUrlSpy).toHaveBeenCalledWith("https://gitlab.example.com/mr/1");
  });

  it("Enter with an empty filtered list is a no-op", async () => {
    const { getByPlaceholderText } = await renderTwo();
    const input = getByPlaceholderText("Search title, branch, author, !iid…");
    fireEvent.change(input, { target: { value: "zzz-nope" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openUrlSpy).not.toHaveBeenCalled();
  });

  it("⌘M toggles 'mine' when a glab user is available, filtering out MRs by other authors", async () => {
    // ensureGlabUser() re-resolves glabUser from glab_current_user on mount, so
    // the mock must agree with setup()'s extra.glabUser or the effect clobbers it.
    tauri.invoke({
      glab_mr_list: () => [mkMr({ iid: 1, author: "alice" }), mkMr({ iid: 2, author: "bob" })],
      glab_current_user: () => "alice",
    });
    setup("/Users/test/proj", { glabUser: "alice" });
    const { getByPlaceholderText, getByText, queryByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("!1")).toBeTruthy());
    expect(getByText("!2")).toBeTruthy();
    const input = getByPlaceholderText("Search title, branch, author, !iid…");
    fireEvent.keyDown(input, { key: "m", metaKey: true }); // mine on
    expect(getByText("!1")).toBeTruthy();
    expect(queryByText("!2")).toBeNull();
    fireEvent.keyDown(input, { key: "m", ctrlKey: true }); // toggles back off
    expect(getByText("!2")).toBeTruthy();
  });

  it("⌘M does nothing when there is no glab user (canMine false)", async () => {
    const { getByPlaceholderText, getByText } = await renderTwo();
    const input = getByPlaceholderText("Search title, branch, author, !iid…");
    fireEvent.keyDown(input, { key: "m", metaKey: true });
    // both MRs still render — the (disabled) mine filter never engaged
    expect(getByText("First")).toBeTruthy();
    expect(getByText("Second")).toBeTruthy();
  });
});

describe("MrSheet — mine button + focus-once guard + overlay close", () => {
  it("clicking the enabled mine button toggles filtering", async () => {
    // ensureGlabUser() re-resolves glabUser from glab_current_user on mount, so
    // the mock must agree with setup()'s extra.glabUser or the effect clobbers it.
    tauri.invoke({
      glab_mr_list: () => [mkMr({ iid: 1, author: "alice" }), mkMr({ iid: 2, author: "bob" })],
      glab_current_user: () => "alice",
    });
    setup("/Users/test/proj", { glabUser: "alice" });
    const { getByText, queryByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText("!1")).toBeTruthy());
    expect(getByText("!2")).toBeTruthy();
    fireEvent.click(getByText("mine"));
    expect(queryByText("none of your merge requests match")).toBeNull();
    // only alice's MR should remain; bob's row (iid 2) has the same default
    // title, so assert via the !iid marker instead.
    expect(getByText("!1")).toBeTruthy();
    expect(queryByText("!2")).toBeNull();
  });

  it("focuses the search field on animationend, and a second animationend is a no-op (focus-once guard)", async () => {
    tauri.invoke({ glab_mr_list: () => [] });
    setup("/Users/test/proj");
    const { getByPlaceholderText, container } = render(<MrSheet />);
    const sheet = container.children[1] as HTMLElement; // [overlay, sheet]
    const input = getByPlaceholderText("Search title, branch, author, !iid…") as HTMLInputElement;
    fireEvent.animationEnd(sheet);
    expect(document.activeElement).toBe(input);
    input.blur();
    fireEvent.animationEnd(sheet); // focusedRef already true -> early return, no re-focus
    expect(document.activeElement).not.toBe(input);
  });

  it("clicking the dimmed overlay closes the panel", async () => {
    tauri.invoke({ glab_mr_list: () => [] });
    setup("/Users/test/proj");
    const { container } = render(<MrSheet />);
    const overlay = container.children[0] as HTMLElement;
    fireEvent.click(overlay);
    expect(useStore.getState().panel).toBeNull();
  });

  it("clicking the × closes the panel", async () => {
    tauri.invoke({ glab_mr_list: () => [] });
    setup("/Users/test/proj");
    const { getByText } = render(<MrSheet />);
    fireEvent.click(getByText("×"));
    expect(useStore.getState().panel).toBeNull();
  });

  it("shows the shortened repo path next to the header when a repo is active", async () => {
    tauri.invoke({ glab_mr_list: () => [] });
    setup("/Users/test/proj/nested", { home: "/Users/test" });
    const { getByText } = render(<MrSheet />);
    await waitFor(() => expect(getByText(/~\/proj\/nested/)).toBeTruthy());
  });
});
