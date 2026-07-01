// Coverage suite for src/components/EmptyState.tsx — the 0-workspace surface:
// Add repository (busy/error/success/cancel), and the conditional Create a
// workspace action once at least one repo is known.
//
// addRepoFromFolder wraps the native folder dialog, which the shared Tauri
// mock hardcodes to resolve `null` — there's no way to reach ok:true/ok:false
// through the real dialog. Mirroring WorkspaceRail.cov.test.tsx's approach, we
// control lib/repo's return value directly so every EmptyState branch is
// reachable.
import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

let addRepoCalls = 0;
let addRepoImpl: () => Promise<unknown> = () => Promise.resolve({ cancelled: true });
mock.module("../src/lib/repo", () => ({
  addRepoFromFolder: () => {
    addRepoCalls++;
    return addRepoImpl();
  },
}));

const { useStore } = await import("../src/state/store");
const { EmptyState } = await import("../src/components/EmptyState");

function seed(overrides: Record<string, unknown> = {}) {
  useStore.setState({ repos: [], initialized: true, command: null, ...overrides }, false);
}

beforeEach(() => {
  addRepoCalls = 0;
  addRepoImpl = () => Promise.resolve({ cancelled: true });
  seed();
});
afterEach(() => {
  cleanup();
});

describe("EmptyState — base copy", () => {
  it("shows the empty-state copy and Add repository, with no Create workspace when there are no repos", () => {
    const { getByText, queryByText } = render(<EmptyState />);
    expect(getByText("aurora")).toBeTruthy();
    expect(getByText("No workspace open — add a repository to get started.")).toBeTruthy();
    expect(getByText("Add repository")).toBeTruthy();
    expect(queryByText("Create a workspace")).toBeNull();
  });

  it("shows Create a workspace once at least one repo is known, and clicking opens the command palette", () => {
    seed({ repos: [{ id: "/repo", root: "/repo", name: "repo", defaultBranch: "main" }] });
    const { getByText } = render(<EmptyState />);
    const btn = getByText("Create a workspace");
    fireEvent.click(btn);
    expect(useStore.getState().command).not.toBeNull();
  });
});

describe("EmptyState — Add repository flow", () => {
  it("shows 'Opening…' while busy, then reverts on a cancelled result with no error shown", async () => {
    let resolveAdd!: (v: unknown) => void;
    addRepoImpl = () => new Promise((res) => { resolveAdd = res; });
    const { getByText, queryByText } = render(<EmptyState />);
    fireEvent.click(getByText("Add repository"));
    await waitFor(() => expect(queryByText("Opening…")).toBeTruthy());

    // A second click while busy must not call addRepoFromFolder again.
    fireEvent.click(getByText("Opening…"));
    expect(addRepoCalls).toBe(1);

    resolveAdd({ cancelled: true });
    await waitFor(() => expect(queryByText("Add repository")).toBeTruthy());
    expect(queryByText("Opening…")).toBeNull();
    // cancelled has no "ok" key -> the error guard must not fire.
    expect(document.querySelector('[style*="color: var(--err)"]')).toBeNull();
  });

  it("shows the error message and clears busy when the result is ok:false", async () => {
    addRepoImpl = () => Promise.resolve({ ok: false, error: "That folder isn't inside a git repository." });
    const { getByText, findByText } = render(<EmptyState />);
    fireEvent.click(getByText("Add repository"));
    const err = await findByText("That folder isn't inside a git repository.");
    expect(err).toBeTruthy();
    expect(getByText("Add repository")).toBeTruthy(); // busy cleared
  });

  it("clears any prior error on a fresh attempt and settles quietly on ok:true", async () => {
    addRepoImpl = () => Promise.resolve({ ok: false, error: "boom" });
    const { getByText, findByText, queryByText } = render(<EmptyState />);
    fireEvent.click(getByText("Add repository"));
    await findByText("boom");

    addRepoImpl = () => Promise.resolve({ ok: true, root: "/repo", name: "repo" });
    fireEvent.click(getByText("Add repository"));
    await waitFor(() => expect(queryByText("boom")).toBeNull());
    expect(addRepoCalls).toBe(2);
  });
});
