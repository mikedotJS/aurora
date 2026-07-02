// EMPTY/FIRST-RUN family (edge-case matrix §8): empty startup state + intro dialog.

import { browser, $, expect } from "@wdio/globals";
import { resetToFirstRun, readAppStorage, reloadFrontend, waitForText, expectNoText } from "../lib/harness.js";

describe("First run & empty state", () => {
  before(async () => {
    await resetToFirstRun();
  });

  it("EMPTY-1: fresh state shows the intro dialog", async () => {
    // Note: expect(...).toBeDisplayed() is unreliable with the embedded driver
    // (getComputedStyle polyfill returns "" in WKWebView) — check via the DOM.
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

  it("EMPTY-2: empty rail shows zero workspaces and the empty-state hero", async () => {
    await waitForText("no workspaces yet");
    await waitForText("Add repository");
    await waitForText("A shell that understands plain language.");
  });

  it("EMPTY-3: 'Got it' dismisses the intro and persists introSeen", async () => {
    await $("button=Got it").click();
    await $("button=Got it").waitForExist({ reverse: true, timeout: 5_000 });
    const settings = await readAppStorage<{ introSeen: boolean }>("aurora.settings");
    expect(settings?.introSeen).toBe(true);
  });

  it("EMPTY-4: intro does not reappear after a frontend reload", async () => {
    await reloadFrontend();
    await expectNoText("Introducing Workspaces");
    // Empty state is still there (no workspaces were created).
    await waitForText("no workspaces yet");
    await browser.saveScreenshot("./e2e/artifacts/01-empty-state.png");
  });
});
