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
  /** Raw extra keys (e.g. "aurora.repoconfig"). */
  extra?: Record<string, unknown>;
}

/** Wipe app localStorage, seed the given state, and reload the frontend. */
export async function seedAppState(opts: SeedOptions = {}): Promise<void> {
  await browser.execute(
    (repos, workspaces, introSeen, extra) => {
      localStorage.clear();
      localStorage.setItem("aurora.settings", JSON.stringify({ introSeen }));
      if (repos) localStorage.setItem("aurora.repos", JSON.stringify(repos));
      if (workspaces) localStorage.setItem("aurora.workspaces", JSON.stringify(workspaces));
      for (const [k, v] of Object.entries(extra ?? {})) {
        localStorage.setItem(k, JSON.stringify(v));
      }
    },
    opts.repos ?? null,
    opts.workspaces ?? null,
    opts.introSeen ?? true,
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
    { timeout: 20_000, timeoutMsg: "frontend did not reload" },
  );
  await waitForAppReady();
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

// The embedded WebDriver server does not support wdio's `*=text` wildcard-XPath
// selectors — assert text presence via the DOM directly instead.

export async function bodyHasText(text: string): Promise<boolean> {
  return browser.execute((t) => document.body.innerText.includes(t), text);
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
