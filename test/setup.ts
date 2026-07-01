// Bun test preload: register a DOM, polyfill what happy-dom lacks, and wire the
// Tauri + xterm + theme module mocks globally so individual test files don't
// have to repeat the boilerplate. Referenced from bunfig.toml [test].preload.
//
// The STORE is intentionally NOT mocked here — it is the system under test for
// many suites. Tests import the real store and reset its state as needed.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import * as t from "./mocks/tauri";
import { XTerm, FitAddon } from "./mocks/xterm";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}

// happy-dom installs these as readonly globals, but several existing pure-logic
// suites reassign them (localStorage shim, fake timers). Re-declare them writable
// so those files keep working under the shared preload. A file that doesn't
// reassign just uses happy-dom's real implementation.
for (const key of [
  "localStorage",
  "sessionStorage",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
]) {
  try {
    const cur = (globalThis as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, { value: cur, writable: true, configurable: true });
  } catch {
    /* non-configurable — leave as-is */
  }
}

// --- polyfills happy-dom doesn't ship / ships incompletely ---
if (!("ResizeObserver" in globalThis)) {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
// happy-dom already provides window.matchMedia (with add/removeEventListener).
// A test that needs a specific match result mocks it per-file.

// --- module mocks (process-global, exactly what we want for these externals) ---
mock.module("@tauri-apps/api/core", () => ({ invoke: t.invoke }));
mock.module("@tauri-apps/api/event", () => ({ listen: t.listen }));
mock.module("@tauri-apps/api/window", () => ({ getCurrentWindow: t.getCurrentWindow }));
mock.module("@tauri-apps/plugin-clipboard-manager", () => ({ readText: t.readText, writeText: t.writeText }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: t.openUrl, openPath: t.openPath, revealItemInDir: t.revealItemInDir }));
mock.module("@tauri-apps/plugin-updater", () => ({ check: t.check }));
mock.module("@tauri-apps/plugin-process", () => ({ relaunch: t.relaunch, exit: t.exit }));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: t.open, save: t.save, ask: t.ask, confirm: t.confirm, message: t.message }));
mock.module("@xterm/xterm", () => ({ Terminal: XTerm }));
mock.module("@xterm/addon-fit", () => ({ FitAddon }));
