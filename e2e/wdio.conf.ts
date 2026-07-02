import { browser } from "@wdio/globals";
import { fileURLToPath } from "node:url";

// Absolute path — the service resolves relative paths against cwd, not this file.
const APP_BINARY = fileURLToPath(new URL("../src-tauri/target/debug/aurora", import.meta.url));

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  // One desktop app instance at a time.
  maxInstances: 1,
  capabilities: [
    // "tauri:options" comes from @wdio/tauri-service, unknown to the stock wdio capability types.
    {
      browserName: "tauri",
      "tauri:options": {
        application: APP_BINARY,
      },
    } as WebdriverIO.Capabilities,
  ],
  services: [
    [
      "tauri",
      {
        appBinaryPath: APP_BINARY,
        driverProvider: "embedded", // macOS: WebDriver server runs inside the app (port 4445)
        startTimeout: 60_000,
        commandTimeout: 30_000,
        captureFrontendLogs: true,
        captureBackendLogs: true,
      },
    ],
  ],
  logLevel: "warn",
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  reporters: ["spec"],
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  // H-6 fix: every focus-sensitive command pays a ~5s `get_window_states` retry
  // (core.invoke is unavailable without the Phase-2 plugin). An explicit
  // switchWindow marks the session as user-switched, which makes
  // ensureActiveWindowFocus skip that check for the rest of the session.
  before: async () => {
    try {
      await (browser as unknown as { tauri: { switchWindow: (l: string) => Promise<void> } }).tauri.switchWindow(
        "main",
      );
    } catch {
      /* best effort — worst case we keep the slow path */
    }
  },
};
