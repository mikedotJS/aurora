// SWITCH/RAIL FLOW family (edge-case matrix §3): activating workspaces from
// the rail, rapid switching, the collapsed-rail switcher, filtering, the
// last-workspace removal guard, rail collapse/expand, and the title bar.
//
// Workspaces are seeded via seedAppState() with PersistedWs entries pointing
// at REAL git worktrees (created with `git worktree add` in the fixture), so
// activation (which reads/derives git state) works against real directories.

import { browser, $, $$, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeFixtureRepo,
  seedAppState,
  readAppStorage,
  waitForText,
  bodyHasText,
  dispatchMetaKey,
  dispatchKeyOn,
  clickText,
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

/** A fixture repo plus N real worktrees (one per branch), for seeding PersistedWs. */
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

function persistedWs(id: string, repoRoot: string, dir: string, branch: string, title?: string): PersistedWs {
  const now = Date.now();
  return {
    id,
    repoId: repoRoot,
    title: title ?? branch,
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

describe("Switch / Rail flow", () => {
  let repo: FixtureRepo & { worktreeDirs: string[] };

  beforeEach(async () => {
    repo = makeRepoWithWorktrees("switch", ["feat/alpha", "feat/beta", "feat/gamma"]);
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

  it("SWITCH-1: clicking a workspace card switches the active workspace", async () => {
    await seedThree();
    await waitForText("feat/alpha");
    await waitForText("feat/beta");

    const cards = await $$(".aurora-ws-card");
    expect(cards.length).toBe(3);

    // Click the card for feat/beta (find by text within each card).
    let target: WebdriverIO.Element | null = null;
    for (const card of cards) {
      const text = await card.getText();
      if (text.includes("feat/beta")) {
        target = card;
        break;
      }
    }
    expect(target).not.toBeNull();
    await target!.click();

    await browser.waitUntil(
      async () => (await readAppStorage<{ activeWs: string }>("aurora.workspaces"))?.activeWs === "wsB",
      { timeout: 10_000, timeoutMsg: "activeWs did not switch to wsB" },
    );
  });

  it("SWITCH-2: rapid switching A -> B -> A -> C lands on the correct active workspace", async () => {
    await seedThree();
    await waitForText("feat/alpha");

    // clickText (H-7, harness.ts) — wdio's element.click() is unreliable in
    // this harness; a synthetic in-page click is not.
    const clickByBranch = (branch: string) => clickText(".aurora-ws-card", branch);

    await clickByBranch("feat/beta");
    await clickByBranch("feat/alpha");
    await clickByBranch("feat/gamma");

    await browser.waitUntil(
      async () => (await readAppStorage<{ activeWs: string }>("aurora.workspaces"))?.activeWs === "wsC",
      { timeout: 10_000, timeoutMsg: "activeWs did not settle on wsC after rapid switching" },
    );
    // No crash: the UI still renders workspace content, not a blank screen.
    const rendered = await browser.execute(() => document.body.innerText.length > 0);
    expect(rendered).toBe(true);
  });

  it("SWITCH-6: rail filter narrows cards by branch, clearing restores them", async () => {
    await seedThree();
    await waitForText("feat/alpha");

    const filter = $('input[placeholder="Filter…"]');
    await filter.waitForExist({ timeout: 5_000 });
    await filter.setValue("beta");

    await browser.waitUntil(async () => (await (await $$(".aurora-ws-card")).length) === 1, {
      timeout: 5_000,
      timeoutMsg: "filter did not narrow to 1 card",
    });
    // Not expectNoText("feat/alpha") — wsA/feat/alpha is the seeded activeWs,
    // so the title bar ("⎇ feat/alpha") legitimately keeps showing it even
    // while its rail card is filtered out. Check the remaining card directly.
    const remaining = await $$(".aurora-ws-card");
    expect(await remaining[0].getText()).toContain("feat/beta");
    await waitForText("feat/beta");

    await filter.setValue("");
    await browser.waitUntil(async () => (await (await $$(".aurora-ws-card")).length) === 3, {
      timeout: 5_000,
      timeoutMsg: "clearing the filter did not restore all cards",
    });
  });

  it("SWITCH-10: last-workspace removal guard hides the trash icon on a single workspace", async () => {
    const [dirA] = repo.worktreeDirs;
    const wsA = persistedWs("wsSolo", repo.root, dirA, "feat/alpha");
    await seedAppState({
      repos: [{ id: repo.root, root: repo.root, name: repo.name, defaultBranch: "main" }],
      workspaces: { workspaces: [wsA], activeWs: "wsSolo" },
    });
    await waitForText("feat/alpha");

    // showTrash = worktreeBacked && !isLast — with a single workspace, isLast is
    // true, so the trash icon is never rendered regardless of worktree backing.
    const trash = $(".aurora-ws-trash");
    await browser.pause(500); // let the async worktreeList/pathResolve check settle
    expect(await trash.isExisting()).toBe(false);
  });

  it("SWITCH-11: collapsing then expanding the rail preserves the active workspace", async () => {
    await seedThree();
    await waitForText("feat/alpha");

    // Switch to feat/beta first so we're not just re-confirming the seeded default.
    const cards = await $$(".aurora-ws-card");
    for (const card of cards) {
      if ((await card.getText()).includes("feat/beta")) {
        await card.click();
        break;
      }
    }
    await browser.waitUntil(
      async () => (await readAppStorage<{ activeWs: string }>("aurora.workspaces"))?.activeWs === "wsB",
      { timeout: 10_000 },
    );

    await dispatchMetaKey("b"); // toggleRail
    await browser.waitUntil(async () => bodyHasText("feat/beta"), {
      timeout: 5_000,
      timeoutMsg: "collapsed rail's title-bar pill did not show the active workspace",
    });
    // Rail cards are gone once collapsed.
    expect((await $$(".aurora-ws-card")).length).toBe(0);

    await dispatchMetaKey("b"); // expand again
    await browser.waitUntil(async () => (await (await $$(".aurora-ws-card")).length) === 3, {
      timeout: 5_000,
      timeoutMsg: "rail did not re-expand",
    });
    const activeAfter = await readAppStorage<{ activeWs: string }>("aurora.workspaces");
    expect(activeAfter?.activeWs).toBe("wsB");
  });

  it("SWITCH-14: title bar shows the active workspace's branch", async () => {
    await seedThree();
    await waitForText("feat/alpha");
    // TitleBar renders "⎇ <branch>" for the active workspace (wsA / feat/alpha).
    await waitForText("⎇ feat/alpha");
  });

  it("SWITCH-4: ⌘2 in the collapsed switcher dropdown activates the second workspace", async () => {
    await seedThree();
    await waitForText("feat/alpha");

    // ⌘1-9 is scoped to WorkspaceSwitcher's SwitcherDropdown (its focused filter
    // input intercepts the chord directly in onKeyDown) — not a global shortcut.
    // Reaching it requires: collapse the rail, open the pill's dropdown, then send
    // the chord while the dropdown's input has focus. Dispatched via
    // dispatchKeyOn (H-5) rather than browser.keys(), since this input's own
    // React onKeyDown must see the event's target for the ⌘1-9 branch to fire.
    await dispatchMetaKey("b"); // collapse rail -> title-bar pill appears
    await waitForText("feat/alpha"); // pill shows the active workspace's title/branch

    const pill = $('span[title="switch workspace"]');
    await pill.waitForExist({ timeout: 5_000 });
    // clickText (H-7) — wdio's element.click() is unreliable in this harness.
    await browser.execute(() => {
      const el = document.querySelector('span[title="switch workspace"]') as HTMLElement | null;
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    });

    const dropdown = $('div[role="listbox"][aria-label="Switch workspace"]');
    await dropdown.waitForExist({ timeout: 5_000 });
    const dropdownInput = 'div[role="listbox"][aria-label="Switch workspace"] input';
    await $(dropdownInput).waitForExist({ timeout: 5_000 });

    // The dropdown lists workspaces in `workspaces` array order: wsA, wsB, wsC.
    // ⌘2 should activate the second entry (wsB / feat/beta).
    await dispatchKeyOn(dropdownInput, "2", { meta: true });

    await browser.waitUntil(
      async () => (await readAppStorage<{ activeWs: string }>("aurora.workspaces"))?.activeWs === "wsB",
      { timeout: 10_000, timeoutMsg: "⌘2 did not activate the second workspace" },
    );
    // Choosing a workspace closes the dropdown.
    await dropdown.waitForExist({ reverse: true, timeout: 5_000 });

    // Restore the rail for hygiene (not strictly required — each test reseeds).
    await dispatchMetaKey("b");
  });
});
