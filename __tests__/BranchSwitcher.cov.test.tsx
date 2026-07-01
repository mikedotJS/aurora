import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { BranchChip } from "../src/components/BranchSwitcher";
import { tauri } from "../test/mocks/tauri";

afterEach(cleanup);
beforeEach(() => {
  tauri.reset();
});

function openChip(opts: { paneId?: number; cwd?: string; branch?: string } = {}) {
  const paneId = opts.paneId ?? 1;
  const cwd = opts.cwd ?? "/repo";
  const branch = opts.branch ?? "main";
  const utils = render(<BranchChip paneId={paneId} cwd={cwd} branch={branch} />);
  fireEvent.click(utils.getByText(branch));
  return utils;
}

describe("BranchChip (closed state)", () => {
  it("renders the branch label and hover toggling without opening the dropdown", () => {
    const { container, getByText, queryByRole } = render(<BranchChip paneId={1} cwd="/repo" branch="main" />);
    expect(getByText("main")).toBeTruthy();
    const chip = container.querySelector('[title="switch branch"]')!;
    fireEvent.mouseEnter(chip);
    fireEvent.mouseLeave(chip);
    expect(queryByRole("listbox")).toBeNull();
  });
});

describe("BranchSwitcher dropdown", () => {
  it("loads branches, pre-selects the first non-current branch, and lists them", async () => {
    tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "feature/a", "feature/b"] }) });
    const { getByText, getByRole } = openChip();
    await waitFor(() => expect(getByText("feature/a")).toBeTruthy());
    expect(getByRole("listbox")).toBeTruthy();
    expect(getByText("current")).toBeTruthy();
    expect(tauri.lastCall("git_branches")?.args).toEqual({ cwd: "/repo" });
  });

  it("falls back to a single [current] row when git_branches returns no branch list but a current branch", async () => {
    tauri.invoke({ git_branches: () => ({ current: "main", branches: [] }) });
    const { getByRole } = openChip();
    // list = [current] here, so filtered.length is 1 — this is NOT the "no other branches
    // yet" empty state (that only fires when there are truly zero rows).
    await waitFor(() => expect(within(getByRole("listbox")).getByText("current")).toBeTruthy());
    const listbox = getByRole("listbox");
    expect(within(listbox).getByText("main")).toBeTruthy();
    expect(within(listbox).queryByText("no other branches yet")).toBeNull();
  });

  it("shows the empty state when there is neither a current branch nor a branch list", async () => {
    tauri.invoke({ git_branches: () => ({ current: null, branches: [] }) });
    const { getByText } = openChip();
    await waitFor(() => expect(getByText("no other branches yet")).toBeTruthy());
  });

  it("filters the list as you type and shows a no-match state", async () => {
    tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "feature/a", "feature/b"] }) });
    const { getByPlaceholderText, getByText, getByRole } = openChip();
    await waitFor(() => expect(getByText("feature/a")).toBeTruthy());
    const listbox = getByRole("listbox");
    const input = getByPlaceholderText("find a branch…");
    fireEvent.change(input, { target: { value: "feature" } });
    // Scope to the listbox: the trigger chip always shows the branch name ("main") too.
    expect(within(listbox).queryByText("main")).toBeNull();
    expect(within(listbox).getByText("feature/a")).toBeTruthy();
    fireEvent.change(input, { target: { value: "zzz-nope" } });
    await waitFor(() => expect(getByText("no branch matches “zzz-nope”")).toBeTruthy());
  });

  it("keyboard: ArrowDown/ArrowUp move selection and Escape closes", async () => {
    tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "feature/a", "feature/b"] }) });
    const { getByPlaceholderText, queryByRole } = openChip();
    const input = getByPlaceholderText("find a branch…");
    await waitFor(() => expect(queryByRole("listbox")).toBeTruthy());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(queryByRole("listbox")).toBeNull();
  });

  it("switches branch on Enter and re-reads git_branch for the resolved name", async () => {
    tauri.invoke({
      git_branches: () => ({ current: "main", branches: ["main", "feature/a"] }),
      git_switch: () => undefined,
      git_branch: () => "feature/a",
    });
    const { getByPlaceholderText, getByText, queryByRole } = openChip();
    const input = getByPlaceholderText("find a branch…");
    // Wait for the async branch list to actually land (sel is auto-set to "feature/a")
    // before pressing Enter — otherwise `filtered` is still empty and Enter is a no-op.
    await waitFor(() => expect(getByText("feature/a")).toBeTruthy());
    // switchTo's success path awaits gitSwitch *then* gitBranch — wrap in act() so both
    // resulting state updates flush deterministically (without it this hangs for many
    // seconds under React 19 + happy-dom's timer-based scheduler fallback).
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(queryByRole("listbox")).toBeNull();
    expect(tauri.lastCall("git_switch")?.args).toEqual({ cwd: "/repo", branch: "feature/a" });
    expect(tauri.calls().some((c) => c.cmd === "git_branch")).toBe(true);
  });

  it("clicking the current branch just closes, without calling git_switch", async () => {
    tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "feature/a"] }) });
    const { getByText, getByRole, queryByRole } = openChip();
    await waitFor(() => expect(getByText("feature/a")).toBeTruthy());
    // Scope to the listbox row: the trigger chip also renders the text "main".
    fireEvent.click(within(getByRole("listbox")).getByText("main"));
    expect(queryByRole("listbox")).toBeNull();
    expect(tauri.calls().some((c) => c.cmd === "git_switch")).toBe(false);
  });

  it("hovering an item updates selection, and clicking another branch switches to it (falls back to requested branch when git_branch resolves null)", async () => {
    tauri.invoke({
      git_branches: () => ({ current: "main", branches: ["main", "feature/a", "feature/b"] }),
      git_switch: () => undefined,
      git_branch: () => null,
    });
    const { getByText, queryByRole } = openChip();
    await waitFor(() => expect(getByText("feature/b")).toBeTruthy());
    fireEvent.mouseEnter(getByText("feature/b"));
    // See the Enter test above for why this needs an explicit act() wrap.
    await act(async () => {
      fireEvent.click(getByText("feature/a"));
    });
    expect(queryByRole("listbox")).toBeNull();
    expect(tauri.lastCall("git_switch")?.args.branch).toBe("feature/a");
  });

  it("shows a busy 'switching…' state while the switch is pending, and ignores a second click while busy", async () => {
    let resolveSwitch!: () => void;
    const pending = new Promise<void>((res) => {
      resolveSwitch = res;
    });
    let switchCalls = 0;
    tauri.invoke({
      git_branches: () => ({ current: "main", branches: ["main", "feature/a", "feature/b"] }),
      git_switch: async () => {
        switchCalls += 1;
        await pending;
      },
      git_branch: () => "feature/a",
    });
    const { getByText, queryByRole } = openChip();
    await waitFor(() => expect(getByText("feature/a")).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByText("feature/a"));
    });
    expect(getByText("switching…")).toBeTruthy();
    // A second click on another branch while busy must be ignored (early-return on `busy`).
    fireEvent.click(getByText("feature/b"));
    expect(switchCalls).toBe(1);
    await act(async () => {
      resolveSwitch();
      await pending;
      await Promise.resolve();
    });
    expect(queryByRole("listbox")).toBeNull();
  });

  it("humanizes an 'uncommitted changes' git error and keeps the dropdown open", async () => {
    tauri.invoke({
      git_branches: () => ({ current: "main", branches: ["main", "feature/a"] }),
      git_switch: () => {
        throw "error: Your local changes to the following files would be overwritten by checkout";
      },
    });
    const { getByText, queryByRole } = openChip();
    await waitFor(() => expect(getByText("feature/a")).toBeTruthy());
    fireEvent.click(getByText("feature/a"));
    await waitFor(() =>
      expect(getByText("You have uncommitted changes — commit or stash them first.")).toBeTruthy(),
    );
    expect(queryByRole("listbox")).toBeTruthy();
  });

  it("humanizes a missing-branch git error using the branch name", async () => {
    tauri.invoke({
      git_branches: () => ({ current: "main", branches: ["main", "gone-branch"] }),
      git_switch: () => {
        throw "fatal: invalid reference: gone-branch";
      },
    });
    const { getByText } = openChip();
    await waitFor(() => expect(getByText("gone-branch")).toBeTruthy());
    fireEvent.click(getByText("gone-branch"));
    await waitFor(() => expect(getByText("“gone-branch” no longer exists.")).toBeTruthy());
  });

  it("humanizes an unrecognized git error to its first line, stripping an error/fatal prefix", async () => {
    tauri.invoke({
      git_branches: () => ({ current: "main", branches: ["main", "weird"] }),
      git_switch: () => {
        throw "fatal: some weird thing happened\nmore detail";
      },
    });
    const { getByText } = openChip();
    await waitFor(() => expect(getByText("weird")).toBeTruthy());
    fireEvent.click(getByText("weird"));
    await waitFor(() => expect(getByText("some weird thing happened")).toBeTruthy());
  });

  it("falls back to a generic message for an empty git error", async () => {
    tauri.invoke({
      git_branches: () => ({ current: "main", branches: ["main", "blank"] }),
      git_switch: () => {
        throw "";
      },
    });
    const { getByText } = openChip();
    await waitFor(() => expect(getByText("blank")).toBeTruthy());
    fireEvent.click(getByText("blank"));
    await waitFor(() => expect(getByText("Couldn't switch branch.")).toBeTruthy());
  });

  it("closes on an outside mousedown (overlay)", async () => {
    tauri.invoke({ git_branches: () => ({ current: "main", branches: ["main", "feature/a"] }) });
    const { container, queryByRole } = openChip();
    await waitFor(() => expect(queryByRole("listbox")).toBeTruthy());
    const overlay = container.querySelector('div[style*="position: fixed"]')!;
    expect(overlay).toBeTruthy();
    fireEvent.mouseDown(overlay);
    expect(queryByRole("listbox")).toBeNull();
  });

  it("unmounts cleanly while the branch fetch is still in flight (effect cleanup)", async () => {
    let resolveBranches!: (v: { current: string | null; branches: string[] }) => void;
    tauri.invoke({
      git_branches: () =>
        new Promise((res) => {
          resolveBranches = res;
        }),
    });
    const { unmount, getByText } = render(<BranchChip paneId={1} cwd="/repo" branch="main" />);
    fireEvent.click(getByText("main"));
    unmount();
    expect(() => resolveBranches({ current: "main", branches: ["main"] })).not.toThrow();
  });
});
