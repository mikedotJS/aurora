// WORKSPACETOUR coach-marks e2e (workspace-tour-onboarding): the spotlight
// tutorial that starts right after "Introducing Workspaces" is dismissed
// (introSeen: true && !tutorialSeen). Deep, real-WKWebView coverage of what a
// happy-dom/jsdom unit test cannot prove (see __tests__/WorkspaceTour.cov.test.tsx's
// header comment): real getBoundingClientRect-driven spotlight placement,
// keyboard-driven navigation reaching the same DOM the mouse would, whether
// keystrokes/focus leak to the xterm pane behind the overlay, and — the
// flagship property of this refactor — that the four coach-marks are ALWAYS
// present, even on a boot with zero repos / no active branch / no configured
// servers, because WorkspaceTour now renders its OWN opaque decor
// (TourStage.tsx) instead of pointing at the real app's rail/StatusBar.
//
// DECOR MODEL (replaces the old "present-step" model entirely): STEPS has
// exactly four ids (rail, new-workspace, run-servers, mr) and ALL FOUR are
// always reachable — the walk is strictly linear, tourStep 0..3, counter
// "pos/4", never variable. The old present-step machinery (a runtime-derived
// N of 2 or 3, run-servers/mr silently skipped) is gone along with the bug it
// used to work around: on a zero-repo boot the OLD tour evaporated after step
// 2 because "mr"/"run-servers" never had a real target to point at. That bug
// is now structurally impossible — the decor's four `data-tour` nodes exist
// unconditionally — and TOUR-1 below is the direct regression test for it.
//
// NOTE: WorkspaceRail.tsx/StatusBar.tsx used to carry their own `data-tour`
// attributes (rail/new-workspace/run-servers/mr) — leftover from the old
// "point at the real DOM" model. That dead markup has since been removed
// from the real components now that WorkspaceTour scopes every lookup to its
// own stage. TOUR-2 below still proves the scoping invariant positively (not
// just against a unit-test-fabricated decoy): it seeds a real repo/branch
// that visually differs from the decor's hardcoded demo content, confirms
// the tour never reflects it, AND pins down that no same-id collision
// candidate exists on the real rail anymore (a regression guard in case the
// dead attribute ever comes back).

import { browser, $, expect } from "@wdio/globals";
import {
  makeFixtureRepo,
  seedAppState,
  readAppStorage,
  dispatchKey,
  dispatchKeyOn,
  clickText,
  bodyHasText,
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

/** Reads the spotlight's real on-screen rect (getBoundingClientRect-derived, minus the tour's own 6px inset). */
async function spotlightRect(): Promise<{ top: number; left: number; width: number; height: number } | null> {
  return browser.execute(() => {
    const el = document.querySelector(".aurora-tour-spotlight") as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });
}

/**
 * The spotlight's COMMITTED target rect, read from its inline style (which the
 * component sets directly from the freshly-measured target's
 * getBoundingClientRect). Use this — not spotlightRect() — when comparing the
 * spotlight ACROSS steps: the spotlight has a CSS top/left glide transition, and
 * this e2e window is occluded, so the display link that drives both rAF and CSS
 * transitions is paused (see the harness's H-notes). getBoundingClientRect would
 * therefore report the spotlight still frozen mid-glide at the PREVIOUS step's
 * position; the inline style reflects the real, current measurement regardless
 * of whether the glide animation could advance.
 */
async function spotlightTargetRect(): Promise<{ top: number; left: number; width: number; height: number } | null> {
  return browser.execute(() => {
    const el = document.querySelector(".aurora-tour-spotlight") as HTMLElement | null;
    if (!el) return null;
    const px = (v: string) => parseFloat(v || "0");
    return { top: px(el.style.top), left: px(el.style.left), width: px(el.style.width), height: px(el.style.height) };
  });
}

async function stepCounterText(): Promise<string | null> {
  return browser.execute(() => document.querySelector(".aurora-tour-step-counter")?.textContent ?? null);
}

/** Parse the "pos/total" counter into numbers, or null if no bubble is showing. */
async function readCounter(): Promise<{ pos: number; total: number } | null> {
  const t = await stepCounterText();
  const m = t?.match(/^(\d+)\/(\d+)$/);
  return m ? { pos: Number(m[1]), total: Number(m[2]) } : null;
}

/** The label on the tour's primary action button ("Next" | "Done"), or null. */
async function primaryLabel(): Promise<string | null> {
  return browser.execute(() => document.querySelector(".aurora-tour-btn--primary")?.textContent ?? null);
}

async function dialogExists(): Promise<boolean> {
  return browser.execute(() => !!document.querySelector('[role="dialog"][aria-modal="true"]'));
}

async function waitForPos(pos: number): Promise<void> {
  await browser.waitUntil(async () => (await readCounter())?.pos === pos, {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: `the tour never reached step ${pos}`,
  });
}

describe("WorkspaceTour coach-marks", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = makeFixtureRepo("tour");
  });

  afterEach(async () => {
    repo.cleanup();
  });

  async function seedOneWorkspace(branch = "main") {
    const ws = persistedWs("ws-tour", repo.root, repo.root, branch);
    await seedAppState({
      repos: [{ id: repo.root, root: repo.root, name: repo.name, defaultBranch: "main" }],
      workspaces: { workspaces: [ws], activeWs: "ws-tour" },
      introSeen: true,
      tutorialSeen: false, // the condition under test
    });
  }

  /** Zero-repo boot: no repos, no workspaces seeded — only the permanent Home
   *  terminal exists once boot completes. This is the exact state that used to
   *  evaporate the OLD present-step tour after step 2. */
  async function seedZeroRepoBoot() {
    await seedAppState({
      introSeen: true,
      tutorialSeen: false,
    });
  }

  it("TOUR-1 (THE CENTRAL REGRESSION TEST): on a ZERO-repo boot — no repos, no workspaces, no servers, only the permanent Home terminal — all FOUR coach-marks still appear in full, 1/4 through 4/4", async () => {
    await seedZeroRepoBoot();

    await waitForPos(1);
    await expect($('[role="dialog"][aria-modal="true"]')).toBeExisting();
    expect(await readCounter()).toEqual({ pos: 1, total: 4 });

    // The stage's demo content — proof this is decor, not a reflection of the
    // (nonexistent) real workspace state. If the tour were still pointing at
    // real DOM, a zero-repo boot could never produce this text at all.
    expect(await bodyHasText("feat/search-facets")).toBe(true);
    expect(await bodyHasText("1 MR")).toBe(true);

    await browser.saveScreenshot("./e2e/artifacts/09-tour-step1-zero-repo.png");

    // Walk all four steps with the primary button, checking a real, non-zero
    // spotlight rect at EVERY one — the old bug left the tour rendering
    // nothing (blank overlay, no spotlight) once it ran out of real targets.
    for (let pos = 1; pos <= 4; pos++) {
      await waitForPos(pos);
      expect(await readCounter()).toEqual({ pos, total: 4 });

      const rect = await spotlightRect();
      expect(rect).not.toBeNull();
      expect(rect!.width).toBeGreaterThan(0);
      expect(rect!.height).toBeGreaterThan(0);

      if (pos < 4) {
        expect(await primaryLabel()).toBe("Next");
        await clickText("button", "Next");
      } else {
        expect(await primaryLabel()).toBe("Done");
        await clickText("button", "Done");
      }
    }

    await browser.waitUntil(
      async () => (await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings"))?.tutorialSeen === true,
      { timeout: 10_000, timeoutMsg: "walking all 4 steps on a zero-repo boot did not finish the tour" },
    );
    expect(await dialogExists()).toBe(false);
  });

  it("TOUR-2: the tour's targets are the DECOR's, not the real (also-`data-tour`-tagged) rail/StatusBar — proven with a real repo whose branch visibly differs from the decor's fixed demo content", async () => {
    // A branch name chosen specifically to be unmistakable if it ever leaked
    // into the tour's rendering.
    await seedOneWorkspace("release/DECOY-9000-should-never-appear-in-tour");

    await waitForPos(1);

    // WorkspaceRail.tsx/StatusBar.tsx used to ALSO carry `data-tour="rail"`
    // etc (dead leftover from the pre-decor model) — that dead markup has
    // since been removed from the real components, so today there is exactly
    // ONE `data-tour="rail"` node in the whole document: the decor's. Pin
    // that down as a regression guard (if the collision candidate ever came
    // back on the real rail, this is the tripwire) — the invariant that
    // actually matters, proven below regardless of how many same-id nodes
    // exist, is that the tour's own SCOPED lookup targets the decor, never
    // whatever real DOM happens to also carry the id.
    const railNodeCount = await browser.execute(() => document.querySelectorAll('[data-tour="rail"]').length);
    expect(railNodeCount).toBe(1); // only the decor's — the real rail no longer carries this attribute

    // The decor's fixed demo content is what renders — never the real seeded
    // branch. Scoped to `.aurora-tour-root` itself, NOT document.body: the
    // real (seeded) rail is still mounted in the DOM underneath the opaque
    // decor (only visually hidden, z-index doesn't unmount it), so a
    // body-wide text scan would find the real branch name too and prove
    // nothing about what the TOUR renders.
    const tourText = await browser.execute(() => document.querySelector(".aurora-tour-root")?.textContent ?? "");
    expect(tourText).toContain("feat/search-facets");
    expect(tourText).not.toContain("release/DECOY-9000-should-never-appear-in-tour");

    // And the spotlight's committed target rect is exactly the SCOPED decor
    // node's own rect (queried the same way WorkspaceTour.tsx does: scoped to
    // `.aurora-tour-root`), not some other same-id node's.
    const scopedRailRect = await browser.execute(() => {
      const el = document.querySelector('.aurora-tour-root [data-tour="rail"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    });
    const target = await spotlightTargetRect();
    expect(scopedRailRect).not.toBeNull();
    expect(target).not.toBeNull();
    // Spotlight rect = target rect - 6px inset on top/left, +12 on width/height.
    expect(target!.top).toBeCloseTo(scopedRailRect!.top - 6, 0);
    expect(target!.left).toBeCloseTo(scopedRailRect!.left - 6, 0);
  });

  it("TOUR-3: 'Next' advances through all 4 targets; the spotlight rect actually moves to a different target every time", async () => {
    await seedOneWorkspace();
    await waitForPos(1);

    const rects: Array<{ top: number; left: number; width: number; height: number } | null> = [];
    rects.push(await spotlightTargetRect());
    for (let i = 0; i < 3; i++) {
      await clickText("button", "Next");
      await waitForPos(i + 2);
      rects.push(await spotlightTargetRect());
    }

    expect(rects).toHaveLength(4);
    for (const r of rects) expect(r).not.toBeNull();
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i]).not.toEqual(rects[i - 1]);
    }

    await browser.saveScreenshot("./e2e/artifacts/09-tour-step4-mr.png");
  });

  it("TOUR-4: 'Back' navigates back", async () => {
    await seedOneWorkspace();
    await waitForPos(1);
    await clickText("button", "Next");
    await waitForPos(2);

    await clickText("button", "Back");
    await waitForPos(1);
  });

  it("TOUR-5: ArrowRight/Space/ArrowLeft drive the same navigation as the buttons", async () => {
    await seedOneWorkspace();
    await waitForPos(1);

    await dispatchKey("ArrowRight");
    await waitForPos(2);

    await dispatchKey(" ");
    await waitForPos(3);

    await dispatchKey("ArrowLeft");
    await waitForPos(2);
  });

  it("TOUR-6 (THE OLD BUG, now structurally impossible): a 'Next' click can never evaporate the tour mid-flow — the total is always exactly 4, and only the last step's explicit 'Done' finishes it", async () => {
    await seedOneWorkspace();
    await waitForPos(1);

    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await readCounter();
      expect(c).not.toBeNull();
      expect(c!.total).toBe(4); // never variable, never < 4
      seen.push(`${c!.pos}/${c!.total}`);
      const label = await primaryLabel();

      if (label === "Done") {
        await clickText("button", "Done");
        break;
      }
      await clickText("button", "Next");
      await waitForPos(c!.pos + 1);
      // A mid-tour "Next" must NEVER finish the tour.
      expect(await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings").then((s) => s?.tutorialSeen)).not.toBe(
        true,
      );
      expect(await dialogExists()).toBe(true);
    }

    expect(seen).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    await browser.waitUntil(
      async () => (await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings"))?.tutorialSeen === true,
      { timeout: 10_000, timeoutMsg: "Done did not persist tutorialSeen" },
    );
  });

  it("TOUR-7: 'Skip' closes the tour immediately and persists tutorialSeen — it does not reappear after reload", async () => {
    await seedOneWorkspace();
    await waitForPos(1);
    await clickText("button", "Skip");
    await browser.waitUntil(async () => !(await dialogExists()), { timeout: 10_000, timeoutMsg: "Skip did not close the tour" });
    const settings = await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings");
    expect(settings?.tutorialSeen).toBe(true);

    await seedAppState({
      repos: [{ id: repo.root, root: repo.root, name: repo.name, defaultBranch: "main" }],
      workspaces: { workspaces: [persistedWs("ws-tour", repo.root, repo.root, "main")], activeWs: "ws-tour" },
      introSeen: true,
      tutorialSeen: true, // simulate the persisted-from-before state surviving a relaunch
    });
    expect(await dialogExists()).toBe(false);
  });

  it("TOUR-8: reaching the last step (4/4) and pressing ArrowRight there also persists tutorialSeen (keymap.ts's unconditional tourNext() boundary safety net)", async () => {
    await seedOneWorkspace();
    await waitForPos(1);
    for (let i = 0; i < 3; i++) {
      await dispatchKey("ArrowRight");
    }
    await waitForPos(4);
    expect(await primaryLabel()).toBe("Done");

    await dispatchKey("ArrowRight"); // pushes tourStep to 4 — must finish, not stall blank
    await browser.waitUntil(async () => !(await dialogExists()), {
      timeout: 10_000,
      timeoutMsg: "ArrowRight past the last step did not close the tour",
    });
    const settings = await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings");
    expect(settings?.tutorialSeen).toBe(true);
  });

  it("TOUR-9: keystrokes during the tour do not leak to the xterm pane behind the overlay", async () => {
    await seedOneWorkspace();
    await waitForPos(1);

    // Pane.tsx has no stable class/testid on the prompt line, so anchor on its
    // actual DOM structure instead (src/components/Pane.tsx): the caret glyph
    // ("❯" normally, "✦" mid-AI-command) is rendered in a <span> immediately
    // followed by a sibling <span> whose text IS `pane.input` verbatim. A plain
    // letter is swallowed by the tour's keyboard guard (keymap.ts's introSeen &&
    // !tutorialSeen block) — only Esc/←/→/Space act — so if "q" leaked through it
    // would land in that sibling span.
    function readPromptInput(): string | null {
      const caret = Array.from(document.querySelectorAll("span")).find(
        (s) => s.textContent === "❯" || s.textContent === "✦",
      );
      const inputSpan = caret?.nextElementSibling;
      return inputSpan ? inputSpan.textContent : null;
    }
    const promptBefore = await browser.execute(readPromptInput);
    expect(promptBefore).not.toBeNull(); // sanity: the prompt line must actually be found

    await dispatchKey("q");
    await browser.pause(200);
    const promptAfter = await browser.execute(readPromptInput);
    expect(promptAfter).toBe(promptBefore);
    // The tour itself is still up — "q" didn't close it either.
    await expect($('[role="dialog"][aria-modal="true"]')).toBeExisting();
  });

  // NOTE: this e2e window runs OCCLUDED (confirmed via diagnostic:
  // document.hidden===true, document.hasFocus()===false throughout the run —
  // consistent with the documented WKWebView-pauses-when-occluded behavior
  // that's also why the tour measures via useLayoutEffect, never rAF). Under
  // occlusion, `document.activeElement`/`.focus()` are NOT a reliable signal
  // here — a real `.focus()` call in the component does not reliably show up
  // as `document.activeElement` matching that node (confirmed empirically:
  // even the tour's OWN initial auto-focus-on-mount, asserted well after
  // waitForPos(1) resolves, reads back as a bare unfocused DIV). So this test
  // proves the trap via its actually-user-relevant OUTCOME instead — same
  // technique as TOUR-9 — dispatch Tab, then a real character key, and
  // confirm it never lands in the xterm pane's prompt behind the overlay,
  // which is what "focus never leaks to the xterm" cashes out to for the
  // user regardless of what `document.activeElement` reports in this harness.
  it("TOUR-10: Tab does not hand focus to the xterm pane behind the overlay — a keystroke right after Tab still never reaches the prompt", async () => {
    await seedOneWorkspace();
    await waitForPos(1);

    function readPromptInput(): string | null {
      const caret = Array.from(document.querySelectorAll("span")).find(
        (s) => s.textContent === "❯" || s.textContent === "✦",
      );
      const inputSpan = caret?.nextElementSibling;
      return inputSpan ? inputSpan.textContent : null;
    }
    const promptBefore = await browser.execute(readPromptInput);
    expect(promptBefore).not.toBeNull(); // sanity: the prompt line must actually be found

    await dispatchKeyOn('[role="dialog"]', "Tab");
    await browser.pause(100);
    await dispatchKey("z"); // if Tab had handed focus to a real input, this native keystroke would land there
    await browser.pause(100);

    const promptAfter = await browser.execute(readPromptInput);
    expect(promptAfter).toBe(promptBefore);
    // The tour is still up — neither key closed or broke it.
    await expect($('[role="dialog"][aria-modal="true"]')).toBeExisting();
    expect(await readCounter()).toEqual({ pos: 1, total: 4 });
  });

  it("TOUR-11: zero mutation of real app state — a full walk through all 4 steps to 'Done' leaves settings (besides tutorialSeen), scripts, repoconfig, repos, and workspace identities byte-for-byte untouched; the decor's fake targets are inert (no server actually launched, no MR panel opened)", async () => {
    await seedOneWorkspace("main");
    await browser.execute(() => {
      localStorage.setItem("aurora.scripts", JSON.stringify({ dev: { cmd: "echo hi" } }));
      localStorage.setItem("aurora.repoconfig", JSON.stringify({ marker: "untouched-by-tour" }));
    });
    await waitForPos(1);

    const settingsBefore = await readAppStorage<Record<string, unknown>>("aurora.settings");
    const scriptsBefore = await readAppStorage<unknown>("aurora.scripts");
    const repoconfigBefore = await readAppStorage<unknown>("aurora.repoconfig");
    const reposBefore = await readAppStorage<unknown>("aurora.repos");
    const wsBefore = await readAppStorage<{ workspaces: Array<{ id: string; branch: string | null }>; activeWs: string | null }>(
      "aurora.workspaces",
    );

    // Clicking the decor's fake "Run" and "mr" targets mid-tour must do
    // nothing real: no MR panel opening (StatusBar's real "mr" pill calls
    // openPanel("mr")), no server actually starting.
    await clickText("button", "Next"); // -> step 2 (new-workspace)
    await waitForPos(2);
    await browser.execute(() => {
      const el = document.querySelector('.aurora-tour-root [data-tour="new-workspace"]');
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await clickText("button", "Next"); // -> step 3 (run-servers)
    await waitForPos(3);
    await browser.execute(() => {
      const el = document.querySelector('.aurora-tour-root [data-tour="run-servers"]');
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await clickText("button", "Next"); // -> step 4 (mr)
    await waitForPos(4);
    await browser.execute(() => {
      const el = document.querySelector('.aurora-tour-root [data-tour="mr"]');
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await browser.pause(150);
    // No MR panel opened by the decor's fake "mr" click. MrSheet.tsx has no
    // stable class/testid, so key off its unique search input's placeholder —
    // the one DOM fingerprint that only exists once that real panel is mounted.
    expect(
      await browser.execute(
        () => !!document.querySelector('input[placeholder="Search title, branch, author, !iid…"]'),
      ),
    ).toBe(false);

    await clickText("button", "Done");
    await browser.waitUntil(
      async () => (await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings"))?.tutorialSeen === true,
      { timeout: 10_000, timeoutMsg: "Done did not persist tutorialSeen" },
    );

    const settingsAfter = await readAppStorage<Record<string, unknown>>("aurora.settings");
    const scriptsAfter = await readAppStorage<unknown>("aurora.scripts");
    const repoconfigAfter = await readAppStorage<unknown>("aurora.repoconfig");
    const reposAfter = await readAppStorage<unknown>("aurora.repos");
    const wsAfter = await readAppStorage<{ workspaces: Array<{ id: string; branch: string | null }>; activeWs: string | null }>(
      "aurora.workspaces",
    );

    // Only tutorialSeen changed among the fields the seed actually wrote.
    // NOTE: seedAppState() seeds "aurora.settings" as a MINIMAL
    // {introSeen, tutorialSeen} object (see harness.ts) — the app's live
    // store has the FULL settings shape in memory from boot (defaults merged
    // in), but nothing writes that full shape back to localStorage until the
    // first real setSetting() call, which finishTutorial() itself triggers.
    // So settingsAfter legitimately gaining extra default-filled keys
    // (accent, model, etc.) that were never in settingsBefore is expected
    // normal persistence behavior, NOT a mutation the tour caused — assert
    // only that every field the seed DID write is unchanged.
    for (const key of Object.keys(settingsBefore ?? {})) {
      if (key === "tutorialSeen") continue;
      expect(settingsAfter?.[key]).toEqual(settingsBefore![key]);
    }
    expect(settingsAfter?.tutorialSeen).toBe(true);

    // Untouched entirely.
    expect(scriptsAfter).toEqual(scriptsBefore);
    expect(repoconfigAfter).toEqual(repoconfigBefore);
    expect(reposAfter).toEqual(reposBefore);

    // Workspace identities (ids + branches) unchanged — no worktree/server
    // side effect created or removed a workspace.
    expect(wsAfter?.workspaces.map((w) => ({ id: w.id, branch: w.branch }))).toEqual(
      wsBefore?.workspaces.map((w) => ({ id: w.id, branch: w.branch })),
    );
    expect(wsAfter?.activeWs).toBe(wsBefore?.activeWs);
  });

  it("TOUR-12: every one of the 4 steps renders a real, non-zero spotlight — no step ever blanks out", async () => {
    await seedOneWorkspace();
    await waitForPos(1);

    for (let pos = 1; pos <= 4; pos++) {
      await waitForPos(pos);
      const rect = await spotlightRect();
      expect(rect).not.toBeNull(); // spotlight must be present at every step, 1..4
      expect(rect!.width).toBeGreaterThan(0);
      expect(rect!.height).toBeGreaterThan(0);
      if (pos < 4) {
        await clickText("button", "Next");
      } else {
        expect(await primaryLabel()).toBe("Done");
        await clickText("button", "Done");
      }
    }
    await browser.waitUntil(
      async () => (await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings"))?.tutorialSeen === true,
      { timeout: 10_000, timeoutMsg: "walking every step did not finish the tour" },
    );
  });
});
