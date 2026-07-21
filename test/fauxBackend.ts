// Faithful real-filesystem double for src/lib/sys.ts, used via
// mock.module("../src/lib/sys", () => fauxBackend) in integration tests that
// need to catch bugs a PERMISSIVE JS double would hide (managed-server-
// lifecycle). test/mocks/tauri.ts's `write_text_file` default is
// `() => undefined` — it accepts ANY path, relative or absolute, in or out of
// root, which is exactly how the relative-path bug (see below) shipped past
// the existing unit tests.
//
// This double enforces the SAME CONTRACTS as the Rust commands it stands in
// for (src-tauri/src/sys.rs), backed by REAL node:fs against a REAL temp dir:
//
//   - write_text_file (sys.rs:153-168): `path` is the FULL target and MUST
//     resolve INSIDE `root`. The real command canonicalizes `root`, does
//     `create_dir_all(Path::new(path).parent())`, then containment-checks the
//     canonicalized parent against the canonicalized root.
//
//     A bare relative filename (the bug: `writeTextFile(root, "aurora.json",
//     …)`) is the case this must catch. In real Rust, `Path::new("aurora.json")
//     .parent()` is `Some("")` (not `None`), so `create_dir_all("")` fails
//     with ENOENT ("No such file or directory (os error 2)"). Node's
//     `path.dirname("aurora.json")` is `"."` instead, and `mkdirSync(".", …)`
//     is a silent no-op since `.` always exists — reproducing Rust's exact
//     failure via a naive `dirname()`+`mkdirSync()` port would therefore NOT
//     catch the bug. So this double checks `path.isAbsolute()` directly: a
//     relative `path` always rejects, matching the real-world outcome (ENOENT)
//     for the one shape that actually shipped (a bare relative filename).
//
//   - read_text_file (sys.rs:122-137): real read, truncated to `maxBytes`,
//     `null` on any error (mirrors sys.ts's `.catch(() => null)`).
//
//   - list_dir (sys.rs:101-116): real `readdirSync` -> `{name, is_dir}[]`,
//     `[]` on any error (so install-command lockfile detection is real).
//
// Everything else is an inert stub — not exercised by the real-fs
// integration test, provided only so the import graph resolves for any
// caller that references (but doesn't invoke) the wider sys.ts surface.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, sep } from "node:path";

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

/** Real write, enforcing the absolute-path + inside-root contract. Throws
 *  (like the Rust `Err`) instead of swallowing, same as the real sys.ts. */
export async function writeTextFile(root: string, path: string, content: string): Promise<void> {
  if (!isAbsolute(path)) {
    // Reproduces the real ENOENT a bare relative filename causes server-side.
    throw new Error("No such file or directory (os error 2)");
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (e) {
    throw new Error(`workspace root unavailable: ${String(e)}`);
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const parentReal = realpathSync(parent);
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new Error("refusing to write outside the workspace");
  }
  writeFileSync(path, content);
}

/** Real read, truncated to maxBytes (byte-boundary, not char-safe — good
 *  enough for ASCII config JSON, which is all this double needs to support).
 *  Returns null on ENOENT/any error, matching sys.ts's `.catch(() => null)`. */
export async function readTextFile(path: string, maxBytes = 8192): Promise<string | null> {
  try {
    const buf = readFileSync(path);
    const cap = Math.min(maxBytes, buf.length);
    let end = cap;
    // Back off to a UTF-8 char boundary — same rule as sys.rs:132-135.
    while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString("utf8");
  } catch {
    return null;
  }
}

/** Real directory listing. [] on any error (missing dir, not a dir, …). */
export async function listDir(path: string, includeHidden = false): Promise<DirEntry[]> {
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    return entries
      .filter((e) => includeHidden || !e.name.startsWith("."))
      .map((e) => ({ name: e.name, is_dir: e.isDirectory() }));
  } catch {
    return [];
  }
}

// ── Inert stubs (git/pty-adjacent — not exercised by this suite) ───────────

export function homeDir(): Promise<string> {
  return Promise.resolve("/Users/test");
}

export function gitBranch(_cwd: string): Promise<string | null> {
  return Promise.resolve(null);
}

export interface BranchList {
  current: string | null;
  branches: string[];
}

export function gitBranches(_cwd: string): Promise<BranchList> {
  return Promise.resolve({ current: null, branches: [] });
}

export type SwitchResult = { ok: true } | { ok: false; error: string };

export function gitSwitch(_cwd: string, _branch: string): Promise<SwitchResult> {
  return Promise.resolve({ ok: true });
}

export function gitRoot(_cwd: string): Promise<string | null> {
  return Promise.resolve(null);
}

export interface RepoInfo {
  root: string;
  main_root: string;
  name: string;
  default_branch: string;
  current_branch: string | null;
}

export function gitRepoInfo(_cwd: string): Promise<RepoInfo | null> {
  return Promise.resolve(null);
}

export interface StatusSummary {
  files: number;
  added: number;
  removed: number;
  conflicted: number;
}

export function gitStatusSummary(_dir: string, _base: string): Promise<StatusSummary | null> {
  return Promise.resolve(null);
}

export function readPackageField(_dir: string, _field: string): Promise<string | null> {
  return Promise.resolve(null);
}

export interface BranchValidator {
  regex: string;
  source: string;
}

export function detectBranchValidator(_dir: string): Promise<BranchValidator | null> {
  return Promise.resolve(null);
}

export interface ValidateResult {
  ok: boolean;
  message?: string | null;
  enforced: boolean;
}

export function validateBranchNameBackend(_dir: string, _name: string): Promise<ValidateResult> {
  return Promise.resolve({ ok: true, message: null, enforced: false });
}

export function pathResolve(path: string): Promise<string> {
  try {
    return Promise.resolve(realpathSync(path));
  } catch {
    return Promise.resolve(path);
  }
}

export function shortenCwd(cwd: string, home: string): string {
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

export function resolveCd(cwd: string, arg: string | undefined, home: string): string {
  if (!arg || arg === "~") return home;
  if (arg.startsWith("~/")) return home + arg.slice(1);
  if (arg.startsWith("/")) return arg.replace(/\/+$/, "") || "/";
  const base = cwd.split("/").filter(Boolean);
  for (const seg of arg.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") base.pop();
    else base.push(seg);
  }
  return "/" + base.join("/");
}
