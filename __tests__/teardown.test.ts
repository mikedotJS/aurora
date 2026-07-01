/// <reference types="bun-types" />
/**
 * Unit tests for the deleteWorkspace orchestrator (src/lib/teardown.ts).
 *
 * All dependencies are mocked so the tests cover only the orchestration logic:
 *   - pty.kill          (src/term/pty)
 *   - worktreeRemove    (src/lib/worktree)
 *   - worktreeList      (src/lib/worktree)  ← used for removability pre-check (M1+M2)
 *   - pathResolve       (src/lib/sys)       ← identity in tests (no real fs)
 *   - useStore          (src/state/store)   — mocked as a thin in-memory list
 *
 * The store reducer behaviour (removeWorkspace, activeWs re-point) is already
 * tested in storeCommand.test.ts. Here we only verify the orchestrator calls or
 * withholds removeWorkspace at the right moments.
 *
 * Covered:
 *   - Guards: last workspace, not-found
 *   - Removability pre-check (M1+M2):
 *       • repoId == null (manual lane) → no worktreeList call; success
 *       • dir === repoId (main checkout, exact match) → abort before any side effects
 *       • dir not in secondary worktrees list → abort; pty.kill NOT called
 *   - Call order: PTY kills before worktreeRemove (sequenced via a log array)
 *   - PTY collection: non-null ids across tabs/panes; null ids skipped
 *   - Rollback: worktreeRemove failure → removeWorkspace NOT called
 *   - Happy path: removeWorkspace called after successful worktreeRemove
 *   - worktreeRemove called with force=true
 */
import { mock, describe, it, expect, beforeEach } from "bun:test";

// ── Controllable mock functions ───────────────────────────────────────────────

const ptyKill = mock((): Promise<void> => Promise.resolve());

const worktreeRemoveFn = mock(
  (): Promise<{ ok: true } | { ok: false; error: string }> => Promise.resolve({ ok: true }),
);

const worktreeListFn = mock(
  (): Promise<{ path: string; branch: string | null; head: string | null }[]> =>
    Promise.resolve([
      { path: REPO, branch: "main", head: null },
      { path: WT_DIR, branch: "feat/test", head: null },
    ]),
);

const removeWorkspaceFn = mock((): void => {});

// In-memory workspace list — mutated by seed(), reset in beforeEach.
let storeWorkspaces: unknown[] = [];

// ── Module mocks ──────────────────────────────────────────────────────────────

// Store: thin in-memory shim; getState() returns the current storeWorkspaces.
mock.module("../src/state/store", () => ({
  useStore: {
    getState: () => ({
      workspaces: storeWorkspaces,
      removeWorkspace: removeWorkspaceFn,
    }),
  },
}));

mock.module("../src/term/pty", () => ({
  pty: { kill: ptyKill },
}));

mock.module("../src/lib/worktree", () => ({
  worktreeRemove: worktreeRemoveFn,
  worktreeList: worktreeListFn,
  worktreeAdd: () => Promise.resolve({ ok: false, error: "mocked" }),
  worktreeSafety: () => Promise.resolve({ dirty: false, ahead: 0, hasUpstream: true }),
}));

// pathResolve is an identity in tests (no real filesystem; paths are already exact strings).
mock.module("../src/lib/sys", () => ({
  pathResolve: (p: string) => Promise.resolve(p),
}));

// The preload (test/setup.ts) already stubs every Tauri/xterm module and the
// real theme.ts applyTheme() works fine under happy-dom, so no per-file mocks
// are needed for those — only the 4 behavior mocks above (store/pty/worktree/sys).
//
// bun test automatically un-registers a file's own mock.module() calls once
// that file's tests finish (verified empirically — no manual mock.restore()
// needed, and calling it here would double-pop bun's internal mock stack and
// corrupt state for later real-store files).

// ── Load the real orchestrator after mocks ────────────────────────────────────

const { deleteWorkspace } = await import("../src/lib/teardown");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO = "/repo";
const WT_DIR = "/repo/.aurora-worktrees/feat-test";

function makePane(ptyId: string | null) {
  return { id: Math.random(), ptyId };
}

/** A worktree-backed workspace by default (repoId set, dir !== repoId). */
function ws(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    repoId: REPO,
    dir: WT_DIR,
    branch: "feat/test",
    tabs: [{ id: 1, panes: [makePane("pty-1")], active: 0, split: "h" }],
    ...overrides,
  };
}

function seed(...workspaces: unknown[]) {
  storeWorkspaces = workspaces;
}

// ── Reset ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  storeWorkspaces = [];
  ptyKill.mockReset();
  ptyKill.mockImplementation(() => Promise.resolve());
  worktreeRemoveFn.mockReset();
  worktreeRemoveFn.mockImplementation(() => Promise.resolve({ ok: true }));
  worktreeListFn.mockReset();
  worktreeListFn.mockImplementation(() =>
    Promise.resolve([
      { path: REPO, branch: "main", head: null },
      { path: WT_DIR, branch: "feat/test", head: null },
    ]),
  );
  removeWorkspaceFn.mockReset();
});

// ── Guard: not found ──────────────────────────────────────────────────────────

describe("guard: workspace not found", () => {
  it("returns { ok:false } with 'not found' when id is unknown", async () => {
    seed(ws("ws-a"), ws("ws-b"));
    const r = await deleteWorkspace("does-not-exist");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/not found/i);
  });

  it("makes zero side-effect calls when not found", async () => {
    seed(ws("ws-a"), ws("ws-b"));
    await deleteWorkspace("does-not-exist");
    expect(ptyKill.mock.calls.length).toBe(0);
    expect(worktreeRemoveFn.mock.calls.length).toBe(0);
    expect(removeWorkspaceFn.mock.calls.length).toBe(0);
  });
});

// ── Guard: last workspace ─────────────────────────────────────────────────────

describe("guard: last workspace", () => {
  it("refuses with an error message matching /last/i", async () => {
    seed(ws("ws-only"));
    const r = await deleteWorkspace("ws-only");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/last/i);
  });

  it("makes zero side-effect calls on the last-workspace guard", async () => {
    seed(ws("ws-only"));
    await deleteWorkspace("ws-only");
    expect(ptyKill.mock.calls.length).toBe(0);
    expect(worktreeRemoveFn.mock.calls.length).toBe(0);
    expect(removeWorkspaceFn.mock.calls.length).toBe(0);
  });
});

// ── Guard: manual lane (repoId == null) ──────────────────────────────────────
// Manual lanes have no worktree. They skip the removability check entirely and
// succeed: PTYs killed, store entry dropped, no worktreeRemove call.

describe("guard: manual lane (repoId == null)", () => {
  it("succeeds without calling worktreeRemove or worktreeList", async () => {
    seed(ws("ws-manual", { repoId: null, dir: "/manual/path" }), ws("ws-b"));
    const r = await deleteWorkspace("ws-manual");
    expect(r.ok).toBe(true);
    expect(worktreeRemoveFn.mock.calls.length).toBe(0);
    expect(worktreeListFn.mock.calls.length).toBe(0);
  });

  it("still kills PTYs and calls removeWorkspace", async () => {
    seed(
      ws("ws-manual", {
        repoId: null,
        dir: "/manual/path",
        tabs: [{ id: 1, panes: [makePane("pty-m")], active: 0, split: "h" }],
      }),
      ws("ws-b"),
    );
    await deleteWorkspace("ws-manual");
    expect(ptyKill.mock.calls.length).toBe(1);
    expect(removeWorkspaceFn.mock.calls.length).toBe(1);
  });
});

// ── Guard: main checkout (dir === repoId, exact string) ───────────────────────
// M1+M2: the fast-path exact-string check returns an error BEFORE calling
// worktreeList or killing any PTYs. This prevents zombie cards caused by
// PTYs being killed before a remove that would fail.

describe("guard: main checkout (dir === repoId, exact match)", () => {
  it("returns { ok:false } without touching PTYs or the store", async () => {
    seed(ws("ws-main", { repoId: REPO, dir: REPO }), ws("ws-b"));
    const r = await deleteWorkspace("ws-main");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/main checkout/i);
  });

  it("makes zero side-effect calls (no pty.kill, no worktreeList, no removeWorkspace)", async () => {
    seed(ws("ws-main", { repoId: REPO, dir: REPO }), ws("ws-b"));
    await deleteWorkspace("ws-main");
    expect(ptyKill.mock.calls.length).toBe(0);
    expect(worktreeListFn.mock.calls.length).toBe(0);
    expect(worktreeRemoveFn.mock.calls.length).toBe(0);
    expect(removeWorkspaceFn.mock.calls.length).toBe(0);
  });
});

// ── Guard: dir not a registered secondary worktree (M1+M2 core) ──────────────
// When the worktree registry does not list `dir` as a secondary worktree,
// deleteWorkspace must abort WITHOUT killing any PTYs. This prevents zombie
// cards where PTYs are dead but the worktree (and UI card) cannot be removed.

describe("guard: dir not a registered secondary worktree (M1+M2)", () => {
  it("does NOT call pty.kill when dir is absent from secondary worktrees", async () => {
    // Only the main checkout in the list — WT_DIR is not registered.
    worktreeListFn.mockImplementation(() =>
      Promise.resolve([{ path: REPO, branch: "main", head: null }]),
    );
    seed(ws("ws-gone"), ws("ws-other"));
    await deleteWorkspace("ws-gone");
    expect(ptyKill.mock.calls.length).toBe(0);
  });

  it("returns { ok:false } when dir is absent from secondary worktrees", async () => {
    worktreeListFn.mockImplementation(() =>
      Promise.resolve([{ path: REPO, branch: "main", head: null }]),
    );
    seed(ws("ws-gone2"), ws("ws-other"));
    const r = await deleteWorkspace("ws-gone2");
    expect(r.ok).toBe(false);
    // Error must mention the missing registration, not a generic message.
    expect((r as { ok: false; error: string }).error).toMatch(
      /not a registered|removable worktree/i,
    );
  });

  it("also makes zero removeWorkspace and worktreeRemove calls", async () => {
    worktreeListFn.mockImplementation(() =>
      Promise.resolve([{ path: REPO, branch: "main", head: null }]),
    );
    seed(ws("ws-gone3"), ws("ws-other"));
    await deleteWorkspace("ws-gone3");
    expect(worktreeRemoveFn.mock.calls.length).toBe(0);
    expect(removeWorkspaceFn.mock.calls.length).toBe(0);
  });
});

// ── Call order ────────────────────────────────────────────────────────────────

describe("call order: PTY kills before worktreeRemove", () => {
  it("all pty.kill calls appear in the log before worktreeRemove", async () => {
    const log: string[] = [];
    ptyKill.mockImplementation((id: string) => {
      log.push(`kill:${id}`);
      return Promise.resolve();
    });
    worktreeRemoveFn.mockImplementation(() => {
      log.push("worktreeRemove");
      return Promise.resolve({ ok: true });
    });

    seed(
      ws("ws-ord", {
        tabs: [{ id: 1, panes: [makePane("pty-a"), makePane("pty-b")], active: 0, split: "h" }],
      }),
      ws("ws-other"),
    );
    await deleteWorkspace("ws-ord");

    const removeAt = log.indexOf("worktreeRemove");
    expect(removeAt).toBeGreaterThan(0); // worktreeRemove happened
    const allKillsBefore = log
      .slice(0, removeAt)
      .filter((e) => e.startsWith("kill:")).length;
    expect(allKillsBefore).toBe(2); // both kills preceded the remove
  });
});

// ── PTY collection ────────────────────────────────────────────────────────────

describe("PTY collection across tabs and panes", () => {
  it("kills only non-null ptyIds across multiple tabs/panes", async () => {
    seed(
      ws("ws-multi", {
        tabs: [
          { id: 1, panes: [makePane("pty-1"), makePane(null), makePane("pty-2")], active: 0, split: "h" },
          { id: 2, panes: [makePane(null), makePane("pty-3")], active: 0, split: "v" },
        ],
      }),
      ws("ws-other"),
    );
    await deleteWorkspace("ws-multi");
    const killed = (ptyKill.mock.calls as string[][]).map((c) => c[0]).sort();
    expect(killed).toEqual(["pty-1", "pty-2", "pty-3"]);
  });

  it("makes zero pty.kill calls when all panes have ptyId==null", async () => {
    seed(
      ws("ws-noPty", {
        tabs: [{ id: 1, panes: [makePane(null), makePane(null)], active: 0, split: "h" }],
      }),
      ws("ws-other"),
    );
    await deleteWorkspace("ws-noPty");
    expect(ptyKill.mock.calls.length).toBe(0);
  });
});

// ── Rollback on worktreeRemove failure ────────────────────────────────────────

describe("rollback: worktreeRemove failure", () => {
  it("does NOT call removeWorkspace when worktreeRemove fails", async () => {
    worktreeRemoveFn.mockImplementation(() =>
      Promise.resolve({ ok: false, error: "git locked" }),
    );
    seed(ws("ws-fail"), ws("ws-other"));
    await deleteWorkspace("ws-fail");
    // Critical: removeWorkspace must NOT be called (no orphaned directory)
    expect(removeWorkspaceFn.mock.calls.length).toBe(0);
  });

  it("returns { ok:false } with the worktreeRemove error surfaced", async () => {
    worktreeRemoveFn.mockImplementation(() =>
      Promise.resolve({ ok: false, error: "git locked" }),
    );
    seed(ws("ws-err"), ws("ws-other"));
    const r = await deleteWorkspace("ws-err");
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain("git locked");
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("happy path: worktree-backed workspace", () => {
  it("returns { ok:true } and calls removeWorkspace(id)", async () => {
    seed(ws("ws-ok"), ws("ws-other"));
    const r = await deleteWorkspace("ws-ok");
    expect(r.ok).toBe(true);
    expect(removeWorkspaceFn.mock.calls.length).toBe(1);
    expect((removeWorkspaceFn.mock.calls[0] as string[])[0]).toBe("ws-ok");
  });

  it("calls worktreeRemove with (repoId, dir, force=true)", async () => {
    seed(ws("ws-args"), ws("ws-other"));
    await deleteWorkspace("ws-args");
    expect(worktreeRemoveFn.mock.calls.length).toBe(1);
    const [root, dir, force] = worktreeRemoveFn.mock.calls[0] as [string, string, boolean];
    expect(root).toBe(REPO);
    expect(dir).toBe(WT_DIR);
    expect(force).toBe(true);
  });
});
