// Shared e2e harness: fixture git repos + app-state seeding via localStorage.
//
// The app under test runs with the isolated identifier com.aurora.e2e, so its
// WKWebView localStorage starts empty and never touches the real Aurora state.
// "Add repository" opens a native macOS dialog (not WebDriver-automatable), so
// repos are seeded directly into localStorage["aurora.repos"] instead.

import { browser, $ } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Fixture repos ---------------------------------------------------------

export interface FixtureRepo {
  root: string;
  name: string;
  cleanup: () => void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Create a throwaway git repo in /tmp with an initial commit on `main`. */
export function makeFixtureRepo(
  name: string,
  opts: { packageJson?: Record<string, unknown>; extraFiles?: Record<string, string> } = {},
): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), `aurora-e2e-${name}-`));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  git(root, "config", "user.email", "e2e@aurora.test");
  git(root, "config", "user.name", "Aurora E2E");
  const pkg = opts.packageJson ?? { name, version: "1.0.0", scripts: { dev: "echo dev" } };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) {
    writeFileSync(join(root, rel), body);
  }
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial commit");
  return {
    root,
    name,
    cleanup: () => {
      // Worktrees created by the app live under <parent>/.aurora-worktrees — remove both.
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

// ---- App state seeding -----------------------------------------------------

export interface SeedOptions {
  /** Repos for localStorage["aurora.repos"]. */
  repos?: Array<{ id: string; root: string; name: string; defaultBranch: string }>;
  /** Pre-existing workspaces for localStorage["aurora.workspaces"]. */
  workspaces?: { workspaces: unknown[]; activeWs: string | null };
  /** settings.introSeen — defaults to true so the intro dialog stays out of the way. */
  introSeen?: boolean;
  /** settings.tutorialSeen — defaults to true so the WorkspaceTour coach-marks
   *  stay out of the way (it mounts whenever introSeen && !tutorialSeen — see
   *  App.tsx — and its keyboard guard swallows everything but Esc/←/→/Space,
   *  which breaks every dispatchKey()-driven spec that isn't testing the tour
   *  itself). A spec exercising the tour sets this to `false` explicitly. */
  tutorialSeen?: boolean;
  /** Raw extra keys (e.g. "aurora.repoconfig"). */
  extra?: Record<string, unknown>;
}

/** Wipe app localStorage, seed the given state, and reload the frontend. */
export async function seedAppState(opts: SeedOptions = {}): Promise<void> {
  await browser.execute(
    (repos, workspaces, introSeen, tutorialSeen, extra) => {
      localStorage.clear();
      localStorage.setItem("aurora.settings", JSON.stringify({ introSeen, tutorialSeen }));
      if (repos) localStorage.setItem("aurora.repos", JSON.stringify(repos));
      if (workspaces) localStorage.setItem("aurora.workspaces", JSON.stringify(workspaces));
      for (const [k, v] of Object.entries(extra ?? {})) {
        localStorage.setItem(k, JSON.stringify(v));
      }
    },
    opts.repos ?? null,
    opts.workspaces ?? null,
    opts.introSeen ?? true,
    opts.tutorialSeen ?? true,
    opts.extra ?? {},
  );
  await reloadFrontend();
}

/** Full wipe → true first-run state (intro dialog will show). */
export async function resetToFirstRun(): Promise<void> {
  await browser.execute(() => localStorage.clear());
  await reloadFrontend();
}

/**
 * Reload the webview without a WebDriver `refresh` navigation — the embedded
 * driver session does not survive `browser.refresh()` on tauri:// URLs.
 * Marks the current document, fires location.reload(), then waits for a new
 * document (marker gone) that has rendered.
 *
 * H-13: every reload fully remounts the React tree, which lazily re-mounts
 * a pane for the permanent Home workspace (and any other `mounted: true`
 * workspace) — each mount calls the real `pty_spawn` Tauri command
 * (src/term/pty.ts:85), spawning a brand-new OS shell process on the Rust
 * side. A page reload is NOT an app relaunch: the Tauri/Rust backend process
 * persists across it, so PTYs spawned by earlier reloads in the same wdio
 * session are never torn down — they accumulate for the lifetime of the
 * spawned `aurora` process. Specs that reload several times per test (every
 * `seedAppState()` call reloads) build up more live PTYs as the run
 * progresses, and later reloads/renders in the same run measurably slow
 * down under that accumulated load — the root cause of the bare mocha
 * `Error: Timeout` (no assertion text, no crash) seen post-merge on
 * `reloadFrontend()`-adjacent waits. The fix here is defensive on the test
 * side (higher budget + a cheap boot-completion poll), not a Rust-side PTY
 * cleanup — see .context/e2e-anomalies.md H-13 for the full evidence chain.
 */
export async function reloadFrontend(): Promise<void> {
  await browser.execute(() => {
    (window as unknown as Record<string, unknown>).__e2e_stale = true;
    setTimeout(() => location.reload(), 20);
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        () => !(window as unknown as Record<string, unknown>).__e2e_stale && document.querySelector("#root") !== null,
      ),
    { timeout: 45_000, timeoutMsg: "frontend did not reload" },
  );
  await waitForAppReady();
  // Boot completion: wait for the store's own post-init persisted write (it
  // always contains a kind:"home" entry, see store.ts:685-696) rather than
  // just "#root has children" — under H-13 load, #root can render its first
  // paint before the async init()/rehydrate pipeline has actually finished
  // writing workspaces back to localStorage.
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const raw = localStorage.getItem("aurora.workspaces");
        if (!raw) return false;
        try {
          const parsed = JSON.parse(raw) as { workspaces?: Array<{ kind?: string }> };
          return Array.isArray(parsed.workspaces) && parsed.workspaces.some((w) => w.kind === "home");
        } catch {
          return false;
        }
      }),
    { timeout: 45_000, timeoutMsg: "boot did not complete — no kind:\"home\" workspace persisted" },
  );
}

export async function waitForAppReady(): Promise<void> {
  const root = $("#root");
  await root.waitForExist({ timeout: 20_000 });
  await browser.waitUntil(async () => (await root.$$("*").length) > 0, {
    timeout: 20_000,
    timeoutMsg: "#root stayed empty — app did not render",
  });
}

/** Dismiss the "Introducing Workspaces" dialog if present. */
export async function dismissIntroIfPresent(): Promise<void> {
  const gotIt = $("button=Got it");
  if (await gotIt.isExisting()) {
    await gotIt.click();
    await gotIt.waitForExist({ reverse: true, timeout: 5_000 });
  }
}

/** Read a localStorage key from the app (parsed JSON, or null). */
export async function readAppStorage<T>(key: string): Promise<T | null> {
  return browser.execute((k) => {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as unknown) : null;
  }, key) as Promise<T | null>;
}

/** Send a keyboard chord like ["Meta", "k"]. */
export async function chord(...keys: string[]): Promise<void> {
  await browser.keys(keys);
}

/**
 * Dispatch a synthetic `keydown` on `window` from inside the webview, instead
 * of `browser.keys()` (H-5): `browser.keys()` simulates real OS-level input,
 * which requires the app window to hold actual OS focus. In this harness the
 * embedded WebDriver's window-focus channel (`get_window_states`, backing
 * `ensureActiveWindowFocus`) never resolves (`Tauri core.invoke not available
 * after 5s timeout` — logged every ~6s, harmless to app behavior but means
 * wdio never confirms/sets OS focus), so `browser.keys()` chords are silently
 * dropped — Aurora's `window.addEventListener("keydown", handleKeyDown)`
 * (src/App.tsx:144) never fires. Dispatching the event directly in-page reaches
 * the same listener without depending on OS focus at all.
 */
export async function dispatchKey(
  key: string,
  opts: { meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
): Promise<void> {
  await browser.execute(
    (k, metaKey, shiftKey, altKey, ctrlKey) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, metaKey, shiftKey, altKey, ctrlKey, bubbles: true, cancelable: true }),
      );
    },
    key,
    opts.meta ?? false,
    opts.shift ?? false,
    opts.alt ?? false,
    opts.ctrl ?? false,
  );
}

/** A ⌘-chord via dispatchKey, e.g. dispatchMetaKey("k") for ⌘K. */
export async function dispatchMetaKey(key: string): Promise<void> {
  await dispatchKey(key, { meta: true });
}

/**
 * Like dispatchKey, but dispatched FROM a specific element rather than
 * `window` — needed for React onKeyDown handlers bound directly to an input
 * (e.g. the ⌘K palette's own Enter/Tab/Escape handling in WorkspaceCommand.tsx),
 * since React's synthetic event system still respects the event's target/bubble
 * path even though it delegates listening to the root.
 */
export async function dispatchKeyOn(
  selector: string,
  key: string,
  opts: { meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
): Promise<void> {
  await browser.execute(
    (sel, k, metaKey, shiftKey, altKey, ctrlKey) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`dispatchKeyOn: no element for selector ${sel}`);
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, metaKey, shiftKey, altKey, ctrlKey, bubbles: true, cancelable: true }),
      );
    },
    selector,
    key,
    opts.meta ?? false,
    opts.shift ?? false,
    opts.alt ?? false,
    opts.ctrl ?? false,
  );
}

/**
 * Click an element by dispatching a synthetic `MouseEvent("click")` in-page,
 * instead of wdio's `element.click()` (H-5d). `element.click()` goes through
 * wdio's `elementClick` command, which is in `@wdio/tauri-service`'s
 * `focusCommands` list — every call first awaits `ensureActiveWindowFocus()`,
 * which itself awaits the broken `get_window_states` invoke (see H-5) and can
 * stall or misbehave under load, occasionally swallowing the click entirely
 * (observed: a real "Create workspace" submit never reached React's onClick,
 * so the workspace was never created and the dialog never closed — a
 * synthetic dispatch on the same element completed successfully in a fraction
 * of the time). Prefer this for any click that gates a subsequent wait.
 */
export async function clickText(tag: string, text: string): Promise<void> {
  const ok = await browser.execute(
    (t, txt) => {
      // Substring match, not exact equality — buttons commonly prefix their
      // label with an aria-hidden glyph span (e.g. "⇋Add repository"), which
      // folds into textContent even though it's not part of the visible label.
      const el = Array.from(document.querySelectorAll(t)).find((e) => e.textContent?.includes(txt)) as HTMLElement | undefined;
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    },
    tag,
    text,
  );
  if (!ok) throw new Error(`clickText: no <${tag}> containing text "${text}"`);
}

/**
 * Type into a React-controlled `<input>` reliably (H-5 continued): wdio's
 * `element.setValue()` sets the DOM `.value` via a path React 19's input value
 * tracking (`_valueTracker`) recognizes as "already seen," so the subsequent
 * `input` event is treated as a no-op duplicate and `onChange` never fires —
 * the component's state (e.g. WorkspaceCommand's `query`) silently stays "".
 * Symptom: the DOM shows the typed text, but nothing driven by React state
 * (filtered lists, form defaults, quick-create) reflects it.
 * Fix: set `.value` via the native `HTMLInputElement` setter (bypassing
 * React's patched setter) and reset `_valueTracker`'s cached value first, so
 * React's change detection sees a real diff when `input` fires.
 */
export async function typeInReactInput(selector: string, text: string): Promise<void> {
  await browser.execute(
    (sel, val) => {
      const el = document.querySelector(sel) as (HTMLInputElement | HTMLTextAreaElement) & {
        _valueTracker?: { setValue: (v: string) => void };
      };
      if (!el) throw new Error(`typeInReactInput: no element for selector ${sel}`);
      const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
      el._valueTracker?.setValue("");
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    text,
  );
}

// The embedded WebDriver server does not support wdio's `*=text` wildcard-XPath
// selectors — assert text presence via the DOM directly instead.
//
// Case-insensitive + textContent-based (not innerText): innerText is
// text-transform-aware, so a CSS `text-transform: uppercase` header (e.g.
// ChangesView's "Staged"/"Changes ·" section labels, Pane.tsx's "running"
// banner) renders as "STAGED"/"RUNNING" in innerText even though the source
// text is mixed/lowercase — see A-1 and H-9 in .context/e2e-anomalies.md.
// textContent returns the verbatim, untransformed text, and comparing
// case-insensitively means callers no longer need to guess/match the
// CSS-rendered case.

export async function bodyHasText(text: string): Promise<boolean> {
  return browser.execute(
    (t) => document.body.textContent!.toLowerCase().includes(t.toLowerCase()),
    text,
  );
}

export async function waitForText(text: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(async () => bodyHasText(text), {
    timeout,
    timeoutMsg: `text not found in body: "${text}"`,
  });
}

export async function expectNoText(text: string): Promise<void> {
  if (await bodyHasText(text)) throw new Error(`unexpected text present: "${text}"`);
}

/**
 * Type text into Aurora's own prompt (NOT a real `<input>` — `Pane.tsx` renders
 * `pane.input` as plain text and `keymap.ts`'s `window` `keydown` listener
 * builds it up one `KeyboardEvent.key.length === 1` char at a time, same as any
 * other single-char key branch — see `handleKeyDown`'s final `if (k.length ===
 * 1 && !e.altKey)` case). So typing here means dispatching one synthetic
 * `keydown` per character, not `typeInReactInput` (H-5b, which is for real DOM
 * inputs) and not `browser.keys()` (H-5, dropped — no reliable OS focus in this
 * harness).
 *
 * H-6 caveat: dispatching each char via a SEPARATE `dispatchKey()`/
 * `browser.execute()` round trip pays the ~5-6s `beforeCommand`/
 * `get_window_states` tax PER CHARACTER (a 9-char command would cost
 * 45-55s just to type) — dispatches the whole string's keydown events in
 * ONE `browser.execute()` call instead, paying that tax once regardless of
 * string length.
 */
export async function typeInPane(text: string): Promise<void> {
  await browser.execute((s) => {
    for (const ch of s) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    }
  }, text);
}
