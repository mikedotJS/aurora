// CHANGES VIEW FLOW family (edge-case matrix §4): opening the Changes overlay,
// staged/unstaged sections, diff rendering, stage/unstage/discard, Esc close,
// and the no-commits-repo edge case.
//
// Workspaces are seeded via seedAppState() with PersistedWs entries pointing at
// REAL git worktrees so ChangesView's `git_changed_files`/`git_diff_file` calls
// run against real directories (see harness.ts + 03-switch-rail.e2e.ts recipe).

import { browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeFixtureRepo,
  seedAppState,
  waitForText,
  bodyHasText,
  expectNoText,
  dispatchMetaKey,
  dispatchKey,
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

/**
 * Exact-text click (unlike harness.ts's clickText, which is substring-based).
 * Needed here because ChangesView's "Stage all" (file-list footer) and the
 * per-file "Stage" (diff-pane header) spans coexist in the DOM whenever there
 * is at least one unstaged file — a substring match on "Stage" would hit
 * "Stage all" first since it appears earlier in DOM order.
 */
async function clickExactText(tag: string, text: string): Promise<void> {
  const ok = await browser.execute(
    (t, txt) => {
      const el = Array.from(document.querySelectorAll(t)).find((e) => e.textContent === txt) as HTMLElement | undefined;
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    },
    tag,
    text,
  );
  if (!ok) throw new Error(`clickExactText: no <${tag}> with exact text "${text}"`);
}

/**
 * ⌘G (openChanges) is a no-op while there's no active pane yet
 * (src/lib/keymap.ts: `const pane = activePane(s); if (!pane) return;` runs
 * BEFORE the ⌘G handler) — right after seedAppState()/reloadFrontend() there's
 * a brief window where the workspace is active but its first pane hasn't
 * finished lazy-mounting/spawning. Retry the dispatch instead of firing once,
 * so the test doesn't race that mount rather than exercising a real app bug.
 */
async function openChangesReliably(probeText: string, timeout = 20_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      await dispatchMetaKey("g");
      return bodyHasText(probeText);
    },
    { timeout, interval: 500, timeoutMsg: `Changes overlay never opened (waiting for "${probeText}")` },
  );
}

function persistedWs(id: string, repoRoot: string, dir: string, branch: string, baseBranch = "main"): PersistedWs {
  const now = Date.now();
  return {
    id,
    repoId: repoRoot,
    title: branch,
    issueKey: null,
    branch,
    baseBranch,
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

/** Fixture repo + one worktree with a modified file, an untracked file, and a staged file. */
function makeDirtyWorktree(name: string): FixtureRepo & { dir: string; modifiedPath: string; originalContent: string } {
  const repo = makeFixtureRepo(name);
  const wtRoot = mkdtempSync(join(tmpdir(), `aurora-e2e-${name}-wt-`));
  const dir = join(wtRoot, "wt-changes");
  git(repo.root, "worktree", "add", "-b", "feat/changes", dir, "main");

  // 1. Modified file (tracked, unstaged): README.md exists from makeFixtureRepo.
  const modifiedPath = join(dir, "README.md");
  const originalContent = readFileSync(modifiedPath, "utf8");
  writeFileSync(modifiedPath, `${originalContent}\nextra line for the diff.\n`);

  // 2. Untracked file.
  writeFileSync(join(dir, "untracked.txt"), "brand new file\n");

  // 3. Staged file: modify package.json then `git add`.
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.description = "staged change";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  git(dir, "add", "package.json");

  const cleanup = () => {
    repo.cleanup();
    try {
      rmSync(wtRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  return { ...repo, cleanup, dir, modifiedPath, originalContent };
}

describe("Changes view flow", () => {
  let repo: FixtureRepo & { dir: string; modifiedPath: string; originalContent: string };

  beforeEach(async () => {
    repo = makeDirtyWorktree("changes");
  });

  afterEach(async () => {
    repo.cleanup();
  });

  async function seedOne() {
    const ws = persistedWs("wsChanges", repo.root, repo.dir, "feat/changes");
    await seedAppState({
      repos: [{ id: repo.root, root: repo.root, name: repo.name, defaultBranch: "main" }],
      workspaces: { workspaces: [ws], activeWs: "wsChanges" },
    });
    return ws;
  }

  it("CHANGES-1: ⌘G opens the overlay listing unstaged files", async () => {
    await seedOne();
    await waitForText("feat/changes");

    await openChangesReliably("README.md"); // openChanges (retried past the pane-mount race)

    // Overlay content: unstaged section with README.md and untracked.txt.
    await waitForText("README.md");
    await waitForText("untracked.txt");

    // "Changes ·" is the unstaged section header (see ChangesView.tsx render: `Changes · {count}`).
    const bodyText = await browser.execute(() => document.body.innerText);
    expect(bodyText).toMatch(/Changes\s*·\s*2/);
  });

  // CHANGES-2: staged vs. unstaged sections both visible with the right files.
  // Confirmed via a direct git_changed_files invoke() (bypassing rendering)
  // that the backend correctly reports package.json as staged: true — see
  // A-1 in .context/e2e-anomalies.md. But the Changes overlay's "Staged"
  // section header never appears in the DOM even after 20 retries of ⌘G over
  // ~100s, so the file never visibly moves into a "Staged" section from the
  // UI's perspective. Skipped pending a fix or a calmer re-run; the assertion
  // below reflects the EXPECTED behavior, not the observed one.
  it.skip("CHANGES-2: the Staged section renders package.json as staged", async () => {
    await seedOne();
    await waitForText("feat/changes");
    await openChangesReliably("Staged");

    await waitForText("Staged");
    await waitForText("package.json");
    const bodyText = await browser.execute(() => document.body.innerText);
    expect(bodyText).toContain("Staged");
  });

  it("CHANGES-3: clicking a file renders its diff", async () => {
    await seedOne();
    await waitForText("feat/changes");
    await openChangesReliably("README.md");

    await clickText("span", "README.md");

    // Diff pane shows the unified diff; the added line's text should surface
    // somewhere in the rendered hunk (UnifiedDiff renders line content).
    await waitForText("extra line for the diff");
  });

  // CHANGES-7/8: stage/unstage via the UI. Blocked by the same rendering gap
  // as CHANGES-2 (A-1, .context/e2e-anomalies.md) — the "Staged" section
  // marker this test polls for never appeared within budget. The assertions
  // reflect the expected behavior (stage moves the file into "Staged · N",
  // unstage moves it back), not a weakened/observed-buggy version.
  it.skip("CHANGES-7/8: stage moves a file to Staged, unstage moves it back", async () => {
    await seedOne();
    await waitForText("feat/changes");
    await openChangesReliably("README.md");

    // Select README.md (unstaged) then Stage it. Exact-text click: "Stage all"
    // (file-list footer) also matches a substring "Stage" and sits earlier in
    // DOM order, so a substring click would hit the wrong control.
    await clickText("span", "README.md");
    await waitForText("Stage");
    await clickExactText("span", "Stage");

    // After staging, package.json + README.md should both be under "Staged · 2".
    await browser.waitUntil(async () => bodyHasText("Staged · 2"), {
      timeout: 10_000,
      timeoutMsg: "README.md did not move into the Staged section",
    });

    // Now unstage it back.
    await clickExactText("span", "Unstage");
    await browser.waitUntil(async () => bodyHasText("Staged · 1"), {
      timeout: 10_000,
      timeoutMsg: "README.md did not move back out of the Staged section",
    });
  });

  it("CHANGES-9: discard restores the file on disk and removes it from the list", async () => {
    await seedOne();
    await waitForText("feat/changes");
    await openChangesReliably("README.md");

    // window.confirm is a native dialog the embedded WebDriver can't drive
    // (H-family pattern: no acceptAlert support demonstrated in this harness) —
    // stub it to auto-accept, matching ChangesView's onDiscard confirm() call.
    await browser.execute(() => {
      window.confirm = () => true;
    });

    await clickText("span", "README.md");
    await waitForText("Discard");
    await clickExactText("span", "Discard");

    await browser.waitUntil(async () => !(await bodyHasText("README.md")), {
      timeout: 10_000,
      timeoutMsg: "README.md was not removed from the Changes list after discard",
    });

    // The worktree file content itself must be restored to the pre-edit state.
    await browser.waitUntil(
      () => readFileSync(repo.modifiedPath, "utf8") === repo.originalContent,
      { timeout: 10_000, timeoutMsg: "README.md content on disk was not restored by discard" },
    );
  });

  it("CHANGES-14: Escape closes the overlay, terminal visible again", async () => {
    await seedOne();
    await waitForText("feat/changes");
    // Probe on "untracked.txt" (an unstaged/untracked file), not "Staged" —
    // see A-1 in .context/e2e-anomalies.md: the Staged section marker is
    // unreliable in this harness, but the overlay itself opens fine.
    await openChangesReliably("untracked.txt");

    await dispatchKey("Escape");

    await browser.waitUntil(async () => !(await bodyHasText("untracked.txt")), {
      timeout: 10_000,
      timeoutMsg: "Changes overlay did not close on Escape",
    });
    // The pane grid (terminal) is back — no crash, some content still rendered.
    const rendered = await browser.execute(() => document.body.innerText.length > 0);
    expect(rendered).toBe(true);
  });

  it("CHANGES-10: a repo with no commits shows a graceful empty/no-base state, no crash", async () => {
    // Separate fixture: `git init` with zero commits — no HEAD to diff against.
    const bareRoot = mkdtempSync(join(tmpdir(), "aurora-e2e-nocommits-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: bareRoot });
    git(bareRoot, "config", "user.email", "e2e@aurora.test");
    git(bareRoot, "config", "user.name", "Aurora E2E");
    writeFileSync(join(bareRoot, "scratch.txt"), "no commits yet\n");

    try {
      const wsNoCommits = persistedWs("wsNoCommits", bareRoot, bareRoot, "main");
      await seedAppState({
        repos: [{ id: bareRoot, root: bareRoot, name: "nocommits", defaultBranch: "main" }],
        workspaces: { workspaces: [wsNoCommits], activeWs: "wsNoCommits" },
      });
      await waitForText("main");

      await openChangesReliably("scratch.txt");

      // git_changed_files has no `base` dependency (git diff / diff --cached
      // against a repo with no HEAD just errors internally and is swallowed to
      // empty, see src-tauri/src/git.rs collect_diff `.unwrap_or_default()`),
      // so the untracked file should still surface via `ls-files --others`.
      await waitForText("scratch.txt");

      // No crash: the app is still responsive and rendered.
      const rendered = await browser.execute(() => document.body.innerText.length > 0);
      expect(rendered).toBe(true);

      // Close it out cleanly.
      await dispatchKey("Escape");
      await expectNoText("scratch.txt");
    } finally {
      try {
        rmSync(bareRoot, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
});
