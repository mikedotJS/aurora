// FIRST-RUN family (edge-case matrix §8), updated for the home-terminal merge:
// a permanent Home terminal (kind:"home") is created at every boot, so there is
// no "empty" state anymore — the zero-repo first run shows the Home shell plus
// the rail's "Start with a repository" onboarding CTA.

import { browser, $, expect } from "@wdio/globals";
import { resetToFirstRun, readAppStorage, reloadFrontend, waitForText, expectNoText } from "../lib/harness.js";

describe("First run & zero-repo state", () => {
  before(async () => {
    await resetToFirstRun();
  });

  it("FIRSTRUN-1: fresh state shows the intro dialog", async () => {
    // toBeDisplayed() is unreliable with the embedded driver (H-3) — check via DOM.
    const visible = await browser.execute(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return false;
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    expect(visible).toBe(true);
    await waitForText("Introducing Workspaces");
    await expect($("button=Got it")).toBeExisting();
  });

  it("FIRSTRUN-2: 'Got it' dismisses the intro and persists introSeen", async () => {
    await $("button=Got it").click();
    await $("button=Got it").waitForExist({ reverse: true, timeout: 5_000 });
    const settings = await readAppStorage<{ introSeen: boolean }>("aurora.settings");
    expect(settings?.introSeen).toBe(true);
  });

  it("FIRSTRUN-2b: the WorkspaceTour coach-marks start automatically right after, showing all 4 steps even on this zero-repo boot (deep coverage — including the full 4-step walk and the zero-mutation checks — lives in 09-workspace-tour.e2e.ts; this only confirms it shows up in the real first-run sequence, then gets it out of the way for the rest of this file)", async () => {
    // WorkspaceTour now renders its OWN opaque decor (TourStage.tsx) instead
    // of pointing at the real app's rail/StatusBar, so all four coach-marks
    // are ALWAYS present regardless of the real app's state — including this
    // zero-repo boot (no repos, no servers, no branch resolved on the Home
    // terminal). The counter reads "1/4", never a variable "1/1"-through-"1/3"
    // like the old present-step model. "Skip" closes it immediately from
    // any step.
    await waitForText("1/4");
    await expect($('[role="dialog"][aria-modal="true"]')).toBeExisting();
    await $("button=Skip").click();
    await $("button=Skip").waitForExist({ reverse: true, timeout: 5_000 });
    const settings = await readAppStorage<{ tutorialSeen: boolean }>("aurora.settings");
    expect(settings?.tutorialSeen).toBe(true);
  });

  it("FIRSTRUN-3: zero-repo boot shows the Home terminal + rail onboarding CTA", async () => {
    // The rail's zero-repo onboarding is the single primary gesture.
    await waitForText("Start with a repository");
    await waitForText("Add repository");
    // The permanent Home workspace exists (kind:"home") and is the active one.
    const ws = await readAppStorage<{ workspaces: Array<{ kind?: string; title: string }>; activeWs: string }>(
      "aurora.workspaces",
    );
    const home = ws?.workspaces.find((w) => w.kind === "home");
    expect(home).toBeTruthy();
    // The tagline now lives in the Home pane's welcome banner (Pane.tsx) —
    // its presence doubles as proof the Home terminal actually rendered.
    await waitForText("a shell that understands plain language.");
  });

  it("FIRSTRUN-4: neither the intro nor the WorkspaceTour reappear after a frontend reload", async () => {
    await reloadFrontend();
    await expectNoText("Introducing Workspaces");
    await expectNoText("1/4"); // WorkspaceTour's step counter — proof it didn't remount either
    // Zero-repo onboarding is still the surface (Home terminal is recreated, not persisted away).
    await waitForText("Start with a repository");
    await browser.saveScreenshot("./e2e/artifacts/01-first-run.png");
  });
});
