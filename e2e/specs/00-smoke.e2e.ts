import { browser, $, expect } from "@wdio/globals";

describe("Aurora smoke", () => {
  it("launches and renders the main UI", async () => {
    // React mounts into #root (index.html / src/main.tsx).
    const root = $("#root");
    await root.waitForExist({ timeout: 20_000 });

    // The app actually rendered something, not a white/black screen
    // (guards the Zustand-selector black-screen class of bug).
    await browser.waitUntil(async () => (await root.$$("*").length) > 0, {
      timeout: 20_000,
      timeoutMsg: "#root stayed empty — app did not render",
    });

    await expect(browser).toHaveTitle("Aurora");
    await browser.saveScreenshot("./e2e/artifacts/smoke.png");
  });
});
