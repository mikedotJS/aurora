// Committed, typed repo config (`aurora.json`) — managed-server-lifecycle.
//
// Replaces (in intent — see design.md for the phased cutover) the two parallel
// untyped models: `Script`/`RepoScripts` (store.ts, localStorage `userScripts`)
// and `Preset` (repoConfig.ts, localStorage `aurora.repoconfig`). `aurora.json`
// lives at the repo root, committed and team-shareable.
//
// THE MODEL (corrected: "1 command → 1 pane, 1 run script → multiple
// commands"): three user-facing categories —
//   - Setup Script (`setup`): ONE script, auto-runs on workspace create.
//   - Run Script (`run`): ONE run script that is an ORDERED LIST of commands.
//     Each command becomes its OWN managed process, in its OWN split pane.
//     Run/⌘R launches every entry together (concurrent split panes) — there is
//     no "pick one" concept here anymore, and no per-entry run_mode: a flat
//     list is always concurrent.
//   - Custom Scripts (`custom`): MANY named, on-demand scripts, each run
//     individually (never auto-launched by Run/⌘R).
// Plus `archive` (teardown, runs once before a workspace is torn down).
//
// JSON — NOT TOML: `bun add`-ing a TOML parser breaks esbuild's code signature
// (memory: esbuild-codesign-after-bun-add), so this parses with native
// `JSON.parse`, zero new dependencies. Read/written through the existing
// `sys::read_text_file`/`sys::write_text_file` Tauri commands (`src/lib/sys.ts`
// → `src-tauri/src/lib.rs:44-45`) — no new Rust command for config IO.

import { readTextFile, writeTextFile } from "./sys";

export type ScriptKind = "setup" | "run" | "archive";

/** A single/repeatable command: either one shell command, or several run in
 *  sequence. `null` = not configured (setup/archive are optional). */
export type CommandSpec = string | string[] | null;

/** One entry in the Run Script's ordered command list. Each entry is spawned
 *  as its own managed process, in its own split pane — `name` labels that
 *  pane (defaults to a slug of `command` when unset); `cwd` is relative to
 *  the workspace root (workspace root itself when unset). */
export interface RunCommand {
  command: string;
  cwd?: string;
  name?: string;
}

/** One `scripts.custom` entry — a named, on-demand script triggered
 *  individually (never part of the Run/⌘R-all flow). */
export interface CustomScript {
  command: string;
  cwd?: string;
}

export interface AuroraConfig {
  version: 1;
  scripts: {
    /** Runs once after workspace create. Replaces the old auto-inferred
     *  `pnpm install` — put install here if you want it. */
    setup: CommandSpec;
    /** The Run Script: an ORDERED LIST of commands. Run/⌘R launches EVERY
     *  entry concurrently, each in its own split pane — not one-at-a-time,
     *  not a pick-one menu. */
    run: RunCommand[];
    /** Arbitrary named scripts triggered on demand (not auto, not part of
     *  Run) — each runs individually in a pane when the user asks for it. */
    custom: Record<string, CustomScript>;
    /** Runs once before workspace teardown. */
    archive: CommandSpec;
  };
}

export const AURORA_CONFIG_FILENAME = "aurora.json";

/** A fresh, empty config — the seed for a repo with no `aurora.json` yet. */
export function defaultAuroraConfig(): AuroraConfig {
  return { version: 1, scripts: { setup: null, run: [], custom: {}, archive: null } };
}

// ── Validation / repair (task 1.4) ──────────────────────────────────────────
//
// A malformed `aurora.json` (hand-edited, merge conflict markers, an old/future
// schema) must never crash Aurora. `parseAuroraConfig` always returns a usable
// `AuroraConfig` — invalid pieces are dropped/defaulted and reported in `error`
// (joined, human-readable) rather than thrown.

export interface ParseResult {
  /** false when any part of the input needed repairing/dropping. */
  ok: boolean;
  /** Always a fully-defaulted, usable config, even when `ok` is false. */
  config: AuroraConfig;
  /** Human-readable, semicolon-joined list of what was repaired/dropped; null when `ok`. */
  error: string | null;
}

function normalizeCommandField(value: unknown, errors: string[], path: string): CommandSpec {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  errors.push(`${path}: must be a string or string[] — ignored`);
  return null;
}

/** One `scripts.run[i]` entry. Never throws — a malformed element is dropped
 *  (reported via `errors`), siblings survive. */
function normalizeRunCommand(raw: unknown, index: number, errors: string[]): RunCommand | null {
  const prefix = `scripts.run[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${prefix}: must be an object — dropped`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== "string" || !r.command.trim()) {
    errors.push(`${prefix}: missing/invalid "command" — dropped`);
    return null;
  }
  const entry: RunCommand = { command: r.command };
  if (typeof r.cwd === "string" && r.cwd.trim()) entry.cwd = r.cwd;
  if (typeof r.name === "string" && r.name.trim()) entry.name = r.name;
  return entry;
}

/** Parse/repair `scripts.run`: an ORDERED ARRAY of `RunCommand`. Never throws
 *  — a malformed element is dropped and reported; siblings keep their
 *  position (order matters — it's the pane layout order). */
function normalizeRunArray(raw: unknown, errors: string[]): RunCommand[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`scripts.run must be an array of commands — ignored`);
    return [];
  }
  const out: RunCommand[] = [];
  raw.forEach((entry, i) => {
    const parsed = normalizeRunCommand(entry, i, errors);
    if (parsed) out.push(parsed);
  });
  return out;
}

/** One `scripts.custom.<id>` entry. Same never-throw/drop-and-report contract
 *  as `normalizeRunCommand`. */
function normalizeCustomScript(id: string, raw: unknown, errors: string[]): CustomScript | null {
  const prefix = `scripts.custom.${id}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${prefix}: must be an object — dropped`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== "string" || !r.command.trim()) {
    errors.push(`${prefix}: missing/invalid "command" — dropped`);
    return null;
  }
  const entry: CustomScript = { command: r.command };
  if (typeof r.cwd === "string" && r.cwd.trim()) entry.cwd = r.cwd;
  return entry;
}

/** Parse/repair `scripts.custom`: an object keyed by script id. Never throws
 *  — an entry that fails validation is dropped and reported; siblings survive. */
function normalizeCustomMap(raw: unknown, errors: string[]): Record<string, CustomScript> {
  const out: Record<string, CustomScript> = {};
  if (raw === undefined) return out;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`scripts.custom must be an object keyed by script id — ignored`);
    return out;
  }
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = normalizeCustomScript(id, entry, errors);
    if (parsed) out[id] = parsed;
  }
  return out;
}

function validateAuroraConfig(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, config: defaultAuroraConfig(), error: "aurora.json must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const scriptsRaw = obj.scripts;
  if (typeof scriptsRaw !== "object" || scriptsRaw === null || Array.isArray(scriptsRaw)) {
    return { ok: false, config: defaultAuroraConfig(), error: "aurora.json.scripts must be an object" };
  }
  const s = scriptsRaw as Record<string, unknown>;

  const setup = normalizeCommandField(s.setup, errors, "scripts.setup");
  const archive = normalizeCommandField(s.archive, errors, "scripts.archive");
  const run = normalizeRunArray(s.run, errors);
  const custom = normalizeCustomMap(s.custom, errors);

  const config: AuroraConfig = { version: 1, scripts: { setup, run, custom, archive } };
  return { ok: errors.length === 0, config, error: errors.length ? errors.join("; ") : null };
}

/** Parse `aurora.json` text. Never throws — a JSON syntax error is reported in
 *  `error` with a usable default config returned alongside it. */
export function parseAuroraConfig(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, config: defaultAuroraConfig(), error: `invalid JSON: ${String(e)}` };
  }
  return validateAuroraConfig(raw);
}

/** Serialize to the canonical on-disk form: 2-space indent, trailing newline
 *  (matches how committed JSON is conventionally formatted in this repo). Key
 *  order is stable (setup, run, custom, archive) because `config.scripts` is
 *  always constructed in that order (`defaultAuroraConfig`/`validateAuroraConfig`). */
export function serializeAuroraConfig(config: AuroraConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

/** A `CommandSpec` (string | string[] | null) as one shell line — `&&`-joins a
 *  string[] step chain (same convention as `scripts.ts`'s `taskCmd` chaining),
 *  passes a string through as-is, and `null`/an all-blank array become `null`
 *  (nothing to run). Used by `setup`/`archive` execution (create.ts/teardown.ts). */
export function commandSpecToShell(spec: CommandSpec | undefined): string | null {
  if (!spec) return null;
  if (typeof spec === "string") return spec.trim() ? spec : null;
  const joined = spec
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" && ");
  return joined || null;
}

// ── File IO (task 1.2) ──────────────────────────────────────────────────────

export interface LoadedAuroraConfig {
  /** null when no `aurora.json` exists at the repo root — NOT an error. */
  config: AuroraConfig | null;
  /** Non-null only when the file exists but needed repair (see `ParseResult`). */
  error: string | null;
}

/** 1 MiB cap — generous for a scripts config, well above the 8 KiB default
 *  (`readTextFile`'s default is sized for prompt/output snippets, not config). */
const MAX_CONFIG_BYTES = 1 << 20;

/** Read + parse the repo's `aurora.json`. Resolves `{config: null}` (not an
 *  error) when the file doesn't exist yet — the caller falls back to legacy
 *  localStorage config or the default per `resolveConfigSource`. */
export async function loadAuroraConfig(repoRoot: string): Promise<LoadedAuroraConfig> {
  const text = await readTextFile(`${repoRoot}/${AURORA_CONFIG_FILENAME}`, MAX_CONFIG_BYTES);
  if (text === null) return { config: null, error: null };
  const result = parseAuroraConfig(text);
  return { config: result.config, error: result.error };
}

/** Write a config to the repo's `aurora.json`, creating the file if absent.
 *  `write_text_file` treats its `path` arg as the full target (it must resolve
 *  INSIDE `root`), so pass the absolute `<repoRoot>/aurora.json` — mirroring
 *  `envFiles.ts`'s `writeTextFile(dir, abs, …)`. A bare relative filename here
 *  makes the Rust side's `Path::parent()` empty → `create_dir_all("")` → ENOENT
 *  ("No such file or directory (os error 2)"). */
export function saveAuroraConfig(repoRoot: string, config: AuroraConfig): Promise<void> {
  return writeTextFile(repoRoot, `${repoRoot}/${AURORA_CONFIG_FILENAME}`, serializeAuroraConfig(config));
}

// ── Load precedence (task 1.3) ──────────────────────────────────────────────
//
// Pure decision function — no store/Tauri reads — so it can't drift from
// whatever call site eventually threads `aurora.json` + migrated-legacy config
// through the store (JS lifecycle rewrite, out of scope for this slice; see
// tasks.md phase 4/6). A committed `aurora.json` always wins over anything
// derived from localStorage; the default config is the last resort.

export type ConfigSource = "committed" | "legacy" | "default";

export function resolveConfigSource(
  committed: AuroraConfig | null,
  legacy: AuroraConfig | null,
): { config: AuroraConfig; source: ConfigSource } {
  if (committed) return { config: committed, source: "committed" };
  if (legacy) return { config: legacy, source: "legacy" };
  return { config: defaultAuroraConfig(), source: "default" };
}
