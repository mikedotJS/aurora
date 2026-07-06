// TEARDOWN/REMOVE FLOW family (edge-case matrix §6): deleting a workspace from
// the rail (non-active + active), the last-workspace guard, and the
// changesWsId stale-overlay guard when the workspace with Changes open is the
// one being deleted.
//
// Workspaces are seeded via seedAppState() with PersistedWs entries pointing
// at REAL git worktrees (see 03-switch-rail.e2e.ts recipe), so deleteWorkspace's
// worktree_remove call runs against a real directory we can assert against on
// disk afterward.
//
// window.confirm is a native dialog the embedded WebDriver can't drive
// (H-family pattern; no acceptAlert support demonstrated in this harness) —
// every test that triggers WorkspaceRail's handleDelete stubs it to
// auto-accept first, matching the real "Delete" choice a user would make.

import { browser, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeFixtureRepo,
  seedAppState,
  readAppStorage,
  waitForText,
  bodyHasText,
  dispatchMetaKey,
  type FixtureRepo,
} from "../lib/harness.js";

interface PersistedWs {
  id: string;
  repoId: string | null;
  title: string;
  issueKey: string | null;
  branch: string | null;
  baseBranch: string;
  dir: string;
  preset: string | null;
  jiraStatus: string | null;
  jiraUrl: string | null;
  jiraSync: boolean;
  env: Record<string, string>;
  createdAt: number;
  lastActive: number;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithWorktrees(name: string, branches: string[]): FixtureRepo & { worktreeDirs: string[] } {
  const repo = makeFixtureRepo(name);
  const wtRoot = mkdtempSync(join(tmpdir(), `aurora-e2e-${name}-wt-`));
  const worktreeDirs = branches.map((b, i) => {
    const dir = join(wtRoot, `wt-${i}-${b.replace(/\//g, "-")}`);
    git(repo.root, "worktree", "add", "-b", b, dir, "main");
    return dir;
  });
  const cleanup = () => {
    repo.cleanup();
    try {
      rmSync(wtRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  return { ...repo, cleanup, worktreeDirs };
}

function persistedWs(id: string, repoRoot: string, dir: string, branch: string): PersistedWs {
  const now = Date.now();
  return {
    id,
    repoId: repoRoot,
    title: branch,
    issueKey: null,
    branch,
    baseBranch: "main",
    dir,
    preset: null,
    jiraStatus: null,
    jiraUrl: null,
    jiraSync: false,
    env: {},
    createdAt: now,
    lastActive: now,
  };
}

/** Stub window.confirm to auto-accept, as a user clicking "Delete" would. */
async function stubConfirmAccept(): Promise<void> {
  await browser.execute(() => {
    window.confirm = () => true;
  });
}

describe("Teardown / remove flow", () => {
  let repo: FixtureRepo & { worktreeDirs: string[] };

  beforeEach(async () => {
    repo = makeRepoWithWorktrees("teardown", ["feat/alpha", "feat/beta", "feat/gamma"]);
  });

  afterEach(async () => {
    repo.cleanup();
  });

  async function seedThree() {
    const [dirA, dirB, dirC] = repo.worktreeDirs;
    const wsA = persistedWs("wsA", repo.root, dirA, "feat/alpha");
    const wsB = persistedWs("wsB", repo.root, dirB, "feat/beta");
    const wsC = persistedWs("wsC", repo.root, dirC, "feat/gamma");
    await seedAppState({
      repos: [{ id: repo.root, root: repo.root, name: repo.name, defaultBranch: "main" }],
      workspaces: { workspaces: [wsA, wsB, wsC], activeWs: "wsA" },
    });
    return { wsA, wsB, wsC };
  }

  it("TEARDOWN-1: deleting a non-active workspace removes the card, the worktree on disk, and updates localStorage", async () => {
    const { wsB } = await seedThree();
    await waitForText("feat/beta");
    expect(existsSync(wsB.dir)).toBe(true);

    await stubConfirmAccept();

    // Trash only rides worktree-backed, non-last cards — wait for the async
    // worktreeList check (WorkspaceRail.tsx) to settle before clicking it.
    await browser.waitUntil(async () => (await (await $$(".aurora-ws-trash")).length) === 3, {
      timeout: 10_000,
      timeoutMsg: "trash icons did not appear on the worktree-backed cards",
    });

    // Click the trash icon inside feat/beta's card specifically.
    const ok = await browser.execute(() => {
      const cards = Array.from(document.querySelectorAll(".aurora-ws-card"));
      const card = cards.find((c) => c.textContent?.includes("feat/beta"));
      const trash = card?.querySelector(".aurora-ws-trash") as HTMLElement | null;
      if (!trash) return false;
      trash.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    expect(ok).toBe(true);

    await browser.waitUntil(async () => !(await bodyHasText("feat/beta")), {
      timeout: 15_000,
      timeoutMsg: "feat/beta card was not removed from the rail after delete",
    });

    // localStorage no longer lists wsB (3 remain: Home + wsA + wsC — the boot
    // always adds the permanent kind:"home" workspace since the home-terminal merge).
    const persisted = await readAppStorage<{ workspaces: PersistedWs[]; activeWs: string }>("aurora.workspaces");
    expect(persisted?.workspaces.some((w) => w.id === "wsB")).toBe(false);
    expect(persisted?.workspaces.length).toBe(3);

    // The worktree directory itself is gone from disk (worktree_remove ran).
    await browser.waitUntil(() => !existsSync(wsB.dir), {
      timeout: 15_000,
      timeoutMsg: "worktree directory for feat/beta still exists on disk after delete",
    });
  });

  it("TEARDOWN active workspace: deleting the active workspace re-points activeWs without a crash", async () => {
    const { wsA } = await seedThree();
    await waitForText("feat/alpha"); // wsA is seeded active

    await stubConfirmAccept();
    await browser.waitUntil(async () => (await (await $$(".aurora-ws-trash")).length) === 3, { timeout: 10_000 });

    const ok = await browser.execute(() => {
      const cards = Array.from(document.querySelectorAll(".aurora-ws-card"));
      const card = cards.find((c) => c.textContent?.includes("feat/alpha"));
      const trash = card?.querySelector(".aurora-ws-trash") as HTMLElement | null;
      if (!trash) return false;
      trash.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    expect(ok).toBe(true);

    await browser.waitUntil(
      async () => {
        const persisted = await readAppStorage<{ workspaces: PersistedWs[]; activeWs: string }>("aurora.workspaces");
        // 3 remain post-delete: Home + wsB + wsC (Home is always added at boot).
        return persisted != null && persisted.activeWs !== "wsA" && persisted.workspaces.length === 3;
      },
      { timeout: 15_000, timeoutMsg: "activeWs did not re-point after deleting the active workspace" },
    );

    const persisted = await readAppStorage<{ workspaces: PersistedWs[]; activeWs: string }>("aurora.workspaces");
    // removeWorkspace picks workspaces[min(idx, len-1)] — wsA was idx 0, so the
    // new active workspace is the one that slid into index 0 (wsB).
    expect(persisted?.activeWs).toBe("wsB");
    expect(existsSync(wsA.dir)).toBe(false);

    // No crash: the app is still responsive and rendered.
    const rendered = await browser.execute(() => document.body.innerText.length > 0);
    expect(rendered).toBe(true);
    await waitForText("feat/beta");
  });

  it("TEARDOWN-3: deleting the last repo workspace falls back to the permanent Home terminal", async () => {
    const [dirA] = repo.worktreeDirs;
    const wsA = persistedWs("wsSolo", repo.root, dirA, "feat/alpha");
    await seedAppState({
      repos: [{ id: repo.root, root: repo.root, name: repo.name, defaultBranch: "main" }],
      workspaces: { workspaces: [wsA], activeWs: "wsSolo" },
    });
    await waitForText("feat/alpha");

    // Post home-terminal merge the solo repo workspace is no longer "last"
    // (Home always exists), so it IS deletable — deleting it must hand the
    // active slot to Home, not crash into an empty state.
    await stubConfirmAccept();
    await browser.waitUntil(async () => (await (await $$(".aurora-ws-trash")).length) === 1, {
      timeout: 10_000,
      timeoutMsg: "trash icon did not appear on the solo repo card",
    });
    await browser.execute(() => {
      const trash = document.querySelector(".aurora-ws-trash") as HTMLElement | null;
      trash?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    });
    await browser.waitUntil(
      async () => {
        const persisted = await readAppStorage<{ workspaces: Array<{ kind?: string }>; activeWs: string | null }>(
          "aurora.workspaces",
        );
        return persisted != null && persisted.workspaces.length === 1 && persisted.workspaces[0].kind === "home";
      },
      { timeout: 15_000, timeoutMsg: "deleting the solo repo workspace did not fall back to Home" },
    );
  });

  it("changesWsId stale-overlay guard: deleting the workspace with Changes open closes the overlay (no zombie)", async function () {
    // H-12/H-13: this test's own seedThree() + Changes-open retry loop pays a
    // growing PTY-mount tax post home-terminal-merge (every reload spawns a
    // fresh Home shell that the Rust backend never tears down across reloads
    // in the same session) — give it explicit headroom past the 120s default.
    this.timeout(180_000);
    await seedThree();
    await waitForText("feat/alpha"); // wsA active

    // Open Changes for the active workspace (wsA). ⌘G/openChanges is a no-op
    // until the workspace's first pane finishes lazy-mounting (src/lib/keymap.ts:
    // `const pane = activePane(s); if (!pane) return;` runs before the ⌘G
    // handler) — retry the dispatch rather than racing that mount once.
    await browser.waitUntil(
      async () => {
        await dispatchMetaKey("g");
        return bodyHasText("no changes against main");
      },
      { timeout: 20_000, interval: 500, timeoutMsg: "Changes overlay never opened for wsA" },
    );

    await stubConfirmAccept();
    await browser.waitUntil(async () => (await (await $$(".aurora-ws-trash")).length) === 3, { timeout: 10_000 });

    // Delete wsA (the workspace whose Changes overlay is currently open).
    const ok = await browser.execute(() => {
      const cards = Array.from(document.querySelectorAll(".aurora-ws-card"));
      const card = cards.find((c) => c.textContent?.includes("feat/alpha"));
      const trash = card?.querySelector(".aurora-ws-trash") as HTMLElement | null;
      if (!trash) return false;
      trash.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    expect(ok).toBe(true);

    // store.removeWorkspace clears changesWsId when it matches the removed id
    // (src/state/store.ts ~line 777) — verify the overlay text is really gone,
    // not just the card. A zombie overlay would keep "no changes against main"
    // (or a staged/unstaged section) visible even though wsA no longer exists.
    await browser.waitUntil(async () => !(await bodyHasText("no changes against main")), {
      timeout: 15_000,
      timeoutMsg: "Changes overlay remained open (zombie) after its owning workspace was deleted",
    });

    const persisted = await readAppStorage<{ workspaces: PersistedWs[]; activeWs: string }>("aurora.workspaces");
    expect(persisted?.workspaces.some((w) => w.id === "wsA")).toBe(false);

    // The new active workspace's own terminal/rail content renders normally —
    // confirms we're not stuck behind an invisible full-screen overlay.
    await waitForText("feat/beta");
    const rendered = await browser.execute(() => document.body.innerText.length > 0);
    expect(rendered).toBe(true);
  });
});
