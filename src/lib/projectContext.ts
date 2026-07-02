// Reusable project-context engine: assembles a bounded, deterministic bundle of
// repo signals (toolchain, real script/project names, git state) from the
// filesystem/git bridges, and renders it into a compact text block for prompt
// injection. Independent of any single caller — the explicit Claude
// command-suggestion flow (`lib/keymap.ts`) is the first consumer, but nothing
// here is suggestion-specific.
//
// Never runs a project command (no `nx`, no package manager) — every signal is
// read deterministically from JSON files / directory listings / git state.
// Never reads lockfile bodies, `.env`/secret files, terminal output, or
// README/Makefile/CI files — only file *presence* and parsed JSON/YAML keys.

import { gitRepoInfo, listDir, readTextFile } from "./sys";
import { gitChangedFiles } from "./git";
import { LOCKFILES } from "./aiScripts";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type Runner = "nx" | "turbo" | "lerna";

export interface ProjectContext {
  root: string;
  cwd: string;
  git?: {
    branch: string | null;
    changedFiles: { path: string; status: string }[];
    /** Total changed-file count (may exceed `changedFiles.length` when capped). */
    changedCount: number;
  };
  toolchain?: {
    packageManager?: PackageManager;
    /** True when the manager was picked by tie-break (multiple lockfiles, no `packageManager` field). */
    packageManagerAmbiguous?: boolean;
    runner?: Runner;
    workspaces: boolean;
  };
  /** Root `package.json` script names — real names, capped. */
  scripts?: string[];
  /** Workspace projects (nx/turbo/lerna or plain workspaces) — real names + targets, capped. */
  projects?: { name: string; targets: string[] }[];
}

// ---- Budgets (keep the injected prompt small and bounded) -----------------

const PACKAGE_JSON_MAX_BYTES = 32768;
const PROJECT_JSON_MAX_BYTES = 4096;
const WORKSPACE_YAML_MAX_BYTES = 4096;

const MAX_SCRIPTS = 40;
const MAX_PROJECTS = 30;
const MAX_TARGETS_PER_PROJECT = 12;
const MAX_CHANGED_FILES = 20;

/** Overall character budget for the rendered block (~1000 tokens). */
const CONTEXT_CHAR_BUDGET = 4000;
const TRUNCATION_MARKER = "\n…[project context truncated]";

// Only the JS/TS-relevant lockfiles from `aiScripts.ts`'s map (it also covers
// Cargo/Poetry/Go, which aren't package managers we suggest commands for here).
const JS_LOCKFILE_PM: Partial<Record<string, PackageManager>> = Object.fromEntries(
  Object.entries(LOCKFILES).filter((e): e is [string, PackageManager] =>
    e[1] === "pnpm" || e[1] === "npm" || e[1] === "yarn" || e[1] === "bun",
  ),
);

// Tie-break order when multiple lockfiles are present and no `packageManager` field exists.
const PM_TIEBREAK: PackageManager[] = ["pnpm", "yarn", "bun", "npm"];

// ---- Toolchain detection ----------------------------------------------------

function detectPackageManager(
  pkg: Record<string, unknown> | null,
  presentLockfiles: string[],
): { pm?: PackageManager; ambiguous?: boolean } {
  const field = typeof pkg?.packageManager === "string" ? (pkg.packageManager as string) : "";
  const declared = field.split("@")[0].trim().toLowerCase();
  if (declared === "pnpm" || declared === "npm" || declared === "yarn" || declared === "bun") {
    return { pm: declared };
  }

  const managers = [...new Set(presentLockfiles.map((f) => JS_LOCKFILE_PM[f]).filter((m): m is PackageManager => !!m))];
  if (managers.length === 0) return {};
  if (managers.length === 1) return { pm: managers[0] };
  // Ambiguous: multiple lockfiles, no authoritative field — pick by precedence
  // and let `formatProjectContext` surface the ambiguity rather than guess silently.
  const picked = PM_TIEBREAK.find((pm) => managers.includes(pm));
  return { pm: picked, ambiguous: true };
}

function detectRunner(hasFile: (name: string) => boolean): Runner | undefined {
  if (hasFile("nx.json")) return "nx";
  if (hasFile("turbo.json")) return "turbo";
  if (hasFile("lerna.json")) return "lerna";
  return undefined;
}

/** Minimal parser for pnpm-workspace.yaml's `packages:` list — no YAML dependency needed. */
function parsePnpmWorkspaceGlobs(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^packages:\s*$/.test(line.trim())) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
    if (item) {
      globs.push(item[1].trim());
      continue;
    }
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) inPackages = false; // dedented to a new top-level key
  }
  return globs;
}

function workspaceGlobsFromPackageJson(pkg: Record<string, unknown> | null): string[] {
  const w = pkg?.workspaces;
  if (Array.isArray(w)) return w.filter((x): x is string => typeof x === "string");
  if (w && typeof w === "object" && Array.isArray((w as { packages?: unknown }).packages)) {
    return (w as { packages: unknown[] }).packages.filter((x): x is string => typeof x === "string");
  }
  return [];
}

// ---- Workspace project enumeration -----------------------------------------

/** Read a project's real name + declared targets from `project.json`, falling
 *  back to `package.json`'s `name` (no targets). Returns null when neither is
 *  a recognizable project manifest, so unrelated subdirectories are skipped. */
async function readProjectInfo(dir: string, fallbackName: string): Promise<{ name: string; targets: string[] } | null> {
  try {
    const body = await readTextFile(`${dir}/project.json`, PROJECT_JSON_MAX_BYTES);
    if (body) {
      const json = JSON.parse(body) as { name?: unknown; targets?: unknown };
      const name = typeof json.name === "string" && json.name ? json.name : fallbackName;
      const targets =
        json.targets && typeof json.targets === "object"
          ? Object.keys(json.targets as Record<string, unknown>).slice(0, MAX_TARGETS_PER_PROJECT)
          : [];
      return { name, targets };
    }
  } catch {
    // fall through to package.json
  }
  try {
    const body = await readTextFile(`${dir}/package.json`, PROJECT_JSON_MAX_BYTES);
    if (body) {
      const json = JSON.parse(body) as { name?: unknown };
      const name = typeof json.name === "string" && json.name ? json.name : fallbackName;
      return { name, targets: [] };
    }
  } catch {
    // ignore
  }
  return null;
}

/** Expand `prefix/*`-shaped workspace globs (the common `apps/*`, `packages/*`,
 *  `libs/*` form) with one `listDir` per distinct prefix, then read each
 *  candidate's project manifest. More exotic glob shapes are skipped. */
async function collectProjects(root: string, globs: string[]): Promise<{ name: string; targets: string[] }[]> {
  const prefixes = new Set<string>();
  for (const g of globs) {
    const m = g.match(/^(.+)\/\*$/);
    if (m) prefixes.add(m[1].replace(/\/+$/, ""));
  }

  const results: { name: string; targets: string[] }[] = [];
  for (const prefix of prefixes) {
    if (results.length >= MAX_PROJECTS) break;
    // `listDir` already resolves to `[]` on error — no try/catch needed here.
    const subEntries = await listDir(`${root}/${prefix}`, false);
    for (const e of subEntries) {
      if (results.length >= MAX_PROJECTS) break;
      if (!e.is_dir) continue;
      const proj = await readProjectInfo(`${root}/${prefix}/${e.name}`, e.name);
      if (proj) results.push(proj);
    }
  }
  return results;
}

// ---- Main entry point -------------------------------------------------------

/**
 * Best-effort assembly of a {@link ProjectContext} for `cwd`. Every signal is
 * independently optional and this function NEVER throws — detection failures
 * simply omit the corresponding signal (or the whole bundle beyond
 * `root`/`cwd`) so callers can always fall back to context-free behavior.
 */
export async function gatherProjectContext(cwd: string): Promise<ProjectContext> {
  let root = cwd;
  let branch: string | null = null;
  let isGitRepo = false;

  try {
    const repo = await gitRepoInfo(cwd);
    if (repo) {
      root = repo.main_root || repo.root || cwd;
      branch = repo.current_branch;
      isGitRepo = true;
    }
  } catch {
    // not a git repo (or detection failed) — root stays cwd, no git section
  }

  const ctx: ProjectContext = { root, cwd };

  if (isGitRepo) {
    try {
      const changed = await gitChangedFiles(root);
      ctx.git = {
        branch,
        changedFiles: changed.slice(0, MAX_CHANGED_FILES).map((f) => ({ path: f.path, status: f.status })),
        changedCount: changed.length,
      };
    } catch {
      // omit git section
    }
  }

  let pkg: Record<string, unknown> | null = null;
  try {
    const body = await readTextFile(`${root}/package.json`, PACKAGE_JSON_MAX_BYTES);
    if (body) pkg = JSON.parse(body) as Record<string, unknown>;
  } catch {
    pkg = null;
  }

  // `listDir` already resolves to `[]` on error — no try/catch needed here.
  const entries = await listDir(root, true);
  const names = new Set(entries.map((e) => e.name));
  const hasFile = (name: string) => names.has(name);

  const presentLockfiles = Object.keys(JS_LOCKFILE_PM).filter(hasFile);
  const { pm, ambiguous } = detectPackageManager(pkg, presentLockfiles);
  const runner = detectRunner(hasFile);

  const hasPnpmWorkspaceFile = hasFile("pnpm-workspace.yaml");
  let pnpmGlobs: string[] = [];
  if (hasPnpmWorkspaceFile) {
    try {
      const text = await readTextFile(`${root}/pnpm-workspace.yaml`, WORKSPACE_YAML_MAX_BYTES);
      if (text) pnpmGlobs = parsePnpmWorkspaceGlobs(text);
    } catch {
      // workspaces flag still set below from file presence
    }
  }
  const globs = [...new Set([...workspaceGlobsFromPackageJson(pkg), ...pnpmGlobs])];
  const hasWorkspaces = globs.length > 0 || hasPnpmWorkspaceFile;

  if (pm || runner || hasWorkspaces) {
    ctx.toolchain = { packageManager: pm, packageManagerAmbiguous: ambiguous, runner, workspaces: hasWorkspaces };
  }

  if (pkg?.scripts && typeof pkg.scripts === "object") {
    const scriptNames = Object.keys(pkg.scripts as Record<string, unknown>).sort();
    if (scriptNames.length) ctx.scripts = scriptNames.slice(0, MAX_SCRIPTS);
  }

  if (hasWorkspaces || runner) {
    try {
      const projects = await collectProjects(root, globs);
      if (projects.length) ctx.projects = projects;
    } catch {
      // omit projects
    }
  }

  return ctx;
}

// ---- Rendering ---------------------------------------------------------------

/**
 * Render a {@link ProjectContext} into a compact, labelled text block bounded
 * by an overall character budget (individual signals are already capped by
 * {@link gatherProjectContext}). Returns `""` when there is nothing useful to
 * inject, so callers can skip adding an empty section.
 */
export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = [];

  if (ctx.toolchain) {
    const t = ctx.toolchain;
    const parts: string[] = [];
    if (t.packageManager) {
      parts.push(
        t.packageManagerAmbiguous
          ? `package manager: ${t.packageManager} (ambiguous — multiple lockfiles present and no "packageManager" field; picked by precedence pnpm > yarn > bun > npm)`
          : `package manager: ${t.packageManager}`,
      );
    }
    if (t.runner) parts.push(`runner: ${t.runner}`);
    parts.push(`workspaces: ${t.workspaces ? "yes" : "no"}`);
    lines.push(`Toolchain: ${parts.join(", ")}`);
  }

  if (ctx.scripts?.length) {
    lines.push(`Scripts: ${ctx.scripts.join(", ")}`);
  }

  if (ctx.projects?.length) {
    const projLines = ctx.projects.map((p) => (p.targets.length ? `${p.name}: ${p.targets.join(", ")}` : p.name));
    lines.push(`Projects:\n  ${projLines.join("\n  ")}`);
  }

  if (ctx.git?.branch) {
    lines.push(`Branch: ${ctx.git.branch}`);
  }
  if (ctx.git && ctx.git.changedCount > 0) {
    const shown = ctx.git.changedFiles.map((f) => `${f.status} ${f.path}`).join(", ");
    const more = ctx.git.changedCount - ctx.git.changedFiles.length;
    lines.push(`Changed files: ${shown}${more > 0 ? ` (+${more} more)` : ""}`);
  }

  if (!lines.length) return "";

  let out = lines.join("\n");
  if (out.length > CONTEXT_CHAR_BUDGET) {
    out = out.slice(0, CONTEXT_CHAR_BUDGET) + TRUNCATION_MARKER;
  }
  return out;
}
