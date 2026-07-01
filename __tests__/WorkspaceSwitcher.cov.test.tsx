import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { WorkspaceSwitcher } from "../src/components/WorkspaceSwitcher";
import { useStore, type Workspace, type Repo } from "../src/state/store";

function makeWorkspace(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    repoId: null,
    title: "Untitled",
    issueKey: null,
    branch: null,
    baseBranch: "main",
    dir: "/tmp",
    preset: null,
    diff: null,
    mr: null,
    pipeline: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    mounted: true,
    tabs: [],
    active: 0,
    createdAt: 0,
    lastActive: 0,
    serverTabId: null,
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  useStore.setState(
    { workspaces: [], repos: [], activeWs: null, railCollapsed: false, command: null },
    false,
  );
});

describe("WorkspaceSwitcher trigger", () => {
  it("shows 'no workspace' and no dot when nothing is active", () => {
    const { getByText, queryByRole } = render(<WorkspaceSwitcher />);
    expect(getByText("no workspace")).toBeTruthy();
    expect(queryByRole("listbox")).toBeNull();
  });

  it("shows the plain title when the active workspace has no issue key", () => {
    useStore.setState(
      { workspaces: [makeWorkspace({ id: "w1", title: "My Workspace" })], activeWs: "w1" },
      false,
    );
    const { getByText } = render(<WorkspaceSwitcher />);
    expect(getByText("My Workspace")).toBeTruthy();
  });

  it("shows 'ISSUE · title' when the active workspace has an issue key", () => {
    useStore.setState(
      {
        workspaces: [makeWorkspace({ id: "w1", title: "Fix bug", issueKey: "ABC-123" })],
        activeWs: "w1",
      },
      false,
    );
    const { getByText } = render(<WorkspaceSwitcher />);
    expect(getByText("ABC-123 · Fix bug")).toBeTruthy();
  });

  it("opens the dropdown on click, and the '›' control expands the rail", () => {
    useStore.setState(
      { workspaces: [makeWorkspace({ id: "w1", title: "W1" })], activeWs: "w1", railCollapsed: true },
      false,
    );
    const { getByText, getByRole, getByTitle } = render(<WorkspaceSwitcher />);
    fireEvent.click(getByText("W1"));
    expect(getByRole("listbox")).toBeTruthy();
    fireEvent.click(getByTitle("show rail (⌘B)"));
    expect(useStore.getState().railCollapsed).toBe(false);
  });
});

describe("SwitcherDropdown", () => {
  function openDropdown(triggerText = "no workspace") {
    const utils = render(<WorkspaceSwitcher />);
    fireEvent.click(utils.getByText(triggerText));
    return utils;
  }

  it("shows 'no workspaces' when the list is empty and there's no query", () => {
    const { getByText } = openDropdown();
    expect(getByText("no workspaces")).toBeTruthy();
  });

  it("groups workspaces by repo (including a 'local' fallback for a missing/absent repoId)", () => {
    const repos: Repo[] = [
      { id: "r1", root: "/r1", name: "repoA", defaultBranch: "main" },
      { id: "r2", root: "/r2", name: "repoB", defaultBranch: "main" },
    ];
    const workspaces: Workspace[] = [
      makeWorkspace({ id: "w1", repoId: "r1", title: "Alpha", issueKey: "ABC-1", branch: "feature/alpha" }),
      makeWorkspace({ id: "w2", repoId: "r1", title: "Beta", branch: "feature/beta" }),
      makeWorkspace({ id: "w3", repoId: "r2", title: "Gamma" }),
      makeWorkspace({ id: "w4", repoId: "unknown-repo-id", title: "Delta" }),
      makeWorkspace({ id: "w5", repoId: null, title: "Epsilon" }),
    ];
    useStore.setState({ repos, workspaces, activeWs: "w2" }, false);
    // Trigger shows the active workspace ("Beta"); scope row assertions to the listbox
    // since the trigger's own label ("Beta") also appears as a dropdown row.
    const { getByRole } = openDropdown("Beta");
    const rows = within(getByRole("listbox"));
    // Header groups: repoA once, repoB once, "local" appears for both the unknown-repo-id
    // workspace and the null-repoId workspace (two separate header rows, same label).
    expect(rows.getByText("repoA")).toBeTruthy();
    expect(rows.getByText("repoB")).toBeTruthy();
    expect(rows.getAllByText("local")).toHaveLength(2);
    // repoA header shown once even though it groups 2 consecutive workspaces.
    expect(rows.queryAllByText("repoA")).toHaveLength(1);
    // w1 has an issue key, so its row label is the combined "ISSUE · title" string.
    for (const t of ["ABC-1 · Alpha", "Beta", "Gamma", "Delta", "Epsilon"]) {
      expect(rows.getByText(t)).toBeTruthy();
    }
  });

  it("filters by title, issueKey, and branch (case-insensitive), and shows a no-match state", () => {
    const workspaces: Workspace[] = [
      makeWorkspace({ id: "w1", title: "Alpha", issueKey: "ABC-1", branch: "feature/alpha" }),
      makeWorkspace({ id: "w2", title: "Beta", branch: "feature/beta" }),
      makeWorkspace({ id: "w3", title: "Gamma", branch: null }),
    ];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    // w1 (active) has an issue key, so the trigger reads "ABC-1 · Alpha".
    const { getByPlaceholderText, getByText, getByRole } = openDropdown("ABC-1 · Alpha");
    const listbox = getByRole("listbox");
    const input = getByPlaceholderText("find a workspace…");

    fireEvent.change(input, { target: { value: "alpha" } });
    expect(within(listbox).getByText("ABC-1 · Alpha")).toBeTruthy();
    expect(within(listbox).queryByText("Beta")).toBeNull();

    fireEvent.change(input, { target: { value: "abc-1" } });
    expect(within(listbox).getByText("ABC-1 · Alpha")).toBeTruthy();

    fireEvent.change(input, { target: { value: "feature/beta" } });
    expect(within(listbox).getByText("Beta")).toBeTruthy();
    expect(within(listbox).queryByText("ABC-1 · Alpha")).toBeNull();

    fireEvent.change(input, { target: { value: "nothing-matches-this" } });
    expect(getByText("no workspace matches “nothing-matches-this”")).toBeTruthy();
  });

  it("keyboard: ArrowDown/ArrowUp/Enter switch the active workspace and close the dropdown", async () => {
    const workspaces: Workspace[] = [
      makeWorkspace({ id: "w1", title: "Alpha" }),
      makeWorkspace({ id: "w2", title: "Beta" }),
      makeWorkspace({ id: "w3", title: "Gamma" }),
    ];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    const { getByPlaceholderText, queryByRole } = openDropdown("Alpha");
    const input = getByPlaceholderText("find a workspace…");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(queryByRole("listbox")).toBeNull());
    expect(useStore.getState().activeWs).toBe("w2");
  });

  it("Escape closes the dropdown without switching", () => {
    const workspaces: Workspace[] = [makeWorkspace({ id: "w1", title: "Alpha" })];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    const { getByPlaceholderText, queryByRole } = openDropdown("Alpha");
    fireEvent.keyDown(getByPlaceholderText("find a workspace…"), { key: "Escape" });
    expect(queryByRole("listbox")).toBeNull();
    expect(useStore.getState().activeWs).toBe("w1");
  });

  it("⌘<N> jumps directly to the Nth workspace", async () => {
    const workspaces: Workspace[] = [
      makeWorkspace({ id: "w1", title: "Alpha" }),
      makeWorkspace({ id: "w2", title: "Beta" }),
      makeWorkspace({ id: "w3", title: "Gamma" }),
    ];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    const { getByPlaceholderText, queryByRole } = openDropdown("Alpha");
    fireEvent.keyDown(getByPlaceholderText("find a workspace…"), { key: "2", metaKey: true });
    await waitFor(() => expect(queryByRole("listbox")).toBeNull());
    expect(useStore.getState().activeWs).toBe("w2");
  });

  it("⌘<N> out of range is a no-op (stays open, no switch)", () => {
    const workspaces: Workspace[] = [makeWorkspace({ id: "w1", title: "Alpha" })];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    const { getByPlaceholderText, queryByRole } = openDropdown("Alpha");
    fireEvent.keyDown(getByPlaceholderText("find a workspace…"), { key: "5", metaKey: true });
    expect(queryByRole("listbox")).toBeTruthy();
    expect(useStore.getState().activeWs).toBe("w1");
  });

  it("clicking a workspace row (and hovering another first) switches to the clicked one", () => {
    const workspaces: Workspace[] = [
      makeWorkspace({ id: "w1", title: "Alpha" }),
      makeWorkspace({ id: "w2", title: "Beta" }),
    ];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    const { getByRole, queryByRole } = openDropdown("Alpha");
    const rows = within(getByRole("listbox"));
    fireEvent.mouseEnter(rows.getByText("Alpha"));
    fireEvent.click(rows.getByText("Beta"));
    expect(queryByRole("listbox")).toBeNull();
    expect(useStore.getState().activeWs).toBe("w2");
  });

  it("'+New workspace' closes the dropdown and opens the command palette", () => {
    const workspaces: Workspace[] = [makeWorkspace({ id: "w1", title: "Alpha" })];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    const { getByText, queryByRole } = openDropdown("Alpha");
    fireEvent.click(getByText("New workspace"));
    expect(queryByRole("listbox")).toBeNull();
    expect(useStore.getState().command).toEqual({ query: "", sel: 0, repoId: null });
  });

  it("closes on an outside mousedown (overlay)", () => {
    const workspaces: Workspace[] = [makeWorkspace({ id: "w1", title: "Alpha" })];
    useStore.setState({ workspaces, activeWs: "w1" }, false);
    const { container, queryByRole } = openDropdown("Alpha");
    expect(queryByRole("listbox")).toBeTruthy();
    const overlay = container.querySelector('div[style*="position: fixed"]')!;
    expect(overlay).toBeTruthy();
    fireEvent.mouseDown(overlay);
    expect(queryByRole("listbox")).toBeNull();
  });
});
