// Legacy → aurora.json migration (managed-server-lifecycle, task 6.1/6.4).
//
// Maps the two legacy untyped models — `RepoScripts` (localStorage
// `aurora.scripts`, per-repo `Script[]` + an `onEnter` hook name) and, for
// context, `Preset` (localStorage `aurora.repoconfig`) — into the typed
// `AuroraConfig`. Preset env/portOffset/envFiles are UNCHANGED by this
// migration (they aren't scripts — they keep flowing through create.ts's
// existing preset → workspace.env path); only the *scripts* move.
//
// New scripts model ("1 command → 1 pane, 1 run script → multiple commands"):
// the legacy `onEnter` script auto-ran on repo entry — in practice it launched
// the dev servers, so it becomes the Run Script's command list (`scripts.run`,
// an ORDERED ARRAY — one `RunCommand` per task when `onEnter` was a `split`
// script, else a single `&&`-chained command). EVERY OTHER legacy script was
// an on-demand, user-triggered script, so it becomes a `custom` entry — not
// `run` (Run/⌘R would otherwise auto-launch scripts the user never asked to
// auto-launch) and not `setup` (there's no install-inference to shadow
// anymore; `setup` stays null and is left for the user to fill in explicitly).
// With no `onEnter` match, `run` stays empty and every legacy script lands in
// `custom` — the user promotes one into the Run list later from the scripts
// editor.
//
// Pure function: takes plain data in, returns a plain `AuroraConfig` out — no
// store/Tauri reads, so it's trivially testable and never writes anything
// itself (writing to disk is an explicit, user-accepted action — see
// lib/auroraConfigStore.ts `acceptAuroraMigration`).

import { slugify } from "./branchName";
import { defaultAuroraConfig, type AuroraConfig, type RunCommand, type CustomScript } from "./auroraConfig";
import type { RepoScripts, Script, ScriptTask } from "../state/store";

/** `cd <dir> && <cmd>` per task (dir relative, matches the legacy `taskCmd`
 *  convention minus the absolute root — the new model's cwd IS the workspace
 *  root, so a bare relative `cd` still lands in the same place). Empty tasks
 *  are dropped (mirrors `runScript`'s `tasks.filter(t => t.cmd.trim())`). */
function taskChain(tasks: ScriptTask[]): string {
  return tasks
    .filter((t) => t.cmd.trim())
    .map((t) => (t.dir ? `cd ${t.dir} && ${t.cmd}` : t.cmd))
    .join(" && ");
}

/** Unique-ify an id against everything already taken, suffixing `-2`, `-3`, … */
function uniqueId(base: string, taken: Set<string>): string {
  const safe = base || "script";
  let id = safe;
  for (let n = 2; taken.has(id); n++) id = `${safe}-${n}`;
  taken.add(id);
  return id;
}

/**
 * One legacy/AI-generated `Script` → one or more `RunCommand`s for the Run
 * Script's ordered list. A `split` script with ≥2 non-empty tasks fans out
 * into ONE `RunCommand` per task (they ran as concurrent sibling panes —
 * separate managed processes is the faithful shape in the new model, but
 * `script.name` doesn't cleanly cover >1 resulting entry so it's dropped —
 * each falls back to a slug of its own command, see `runCommandLabel`);
 * everything else collapses to a single `&&`-chained command carrying the
 * script's original name (so the migrated entry stays identifiable).
 */
export function scriptToRunCommands(script: Script): RunCommand[] {
  const nonEmpty = script.tasks.filter((t) => t.cmd.trim());
  if (script.split && nonEmpty.length > 1) {
    return nonEmpty.map((t) => ({ command: t.dir ? `cd ${t.dir} && ${t.cmd}` : t.cmd }));
  }
  const command = taskChain(script.tasks);
  if (!command) return [];
  const entry: RunCommand = { command };
  if (script.name.trim()) entry.name = script.name.trim();
  return [entry];
}

/**
 * One legacy/AI-generated `Script` → one or more `custom.<id>` entries. Same
 * split-fan-out rule as `scriptToRunCommands`, but each task becomes its own
 * named, on-demand entry (numbered-suffix ids) rather than a `RunCommand` —
 * `custom` has no concurrent-launch semantics, so a split script's tasks stay
 * independently triggerable, not implicitly grouped.
 *
 * Exported (task 5.4): the primary scripts editor (`ScriptsSetupModal.tsx`)
 * reuses this to fold AI-generated scripts directly into an `aurora.json`
 * draft's Custom Scripts — AI proposals are named/described, the same shape
 * `custom` entries are — rather than adopting them into the legacy
 * `userScripts` store first.
 */
export function scriptToCustomEntries(script: Script, taken: Set<string>): Array<[string, CustomScript]> {
  const base = slugify(script.name);
  const nonEmpty = script.tasks.filter((t) => t.cmd.trim());
  if (script.split && nonEmpty.length > 1) {
    return nonEmpty.map((t, i) => {
      const id = uniqueId(`${base}-${i + 1}`, taken);
      const command = t.dir ? `cd ${t.dir} && ${t.cmd}` : t.cmd;
      return [id, { command }] as [string, CustomScript];
    });
  }
  const command = taskChain(script.tasks);
  if (!command) return [];
  const id = uniqueId(base, taken);
  return [[id, { command }]];
}

/**
 * Build an `AuroraConfig` from a repo's legacy scripts. Returns `null` when
 * there is nothing to migrate (no scripts at all) — callers fall through to
 * `defaultAuroraConfig()` via `resolveConfigSource`.
 */
export function repoScriptsToAuroraConfig(rs: RepoScripts | undefined): AuroraConfig | null {
  if (!rs || rs.scripts.length === 0) return null;

  const taken = new Set<string>();
  const run: RunCommand[] = [];
  const custom: Record<string, CustomScript> = {};

  for (const script of rs.scripts) {
    const isOnEnter = !!rs.onEnter && script.name === rs.onEnter;
    if (isOnEnter) {
      run.push(...scriptToRunCommands(script));
    } else {
      for (const [id, entry] of scriptToCustomEntries(script, taken)) custom[id] = entry;
    }
  }

  if (run.length === 0 && Object.keys(custom).length === 0) return null;

  const config = defaultAuroraConfig();
  config.scripts.run = run;
  config.scripts.custom = custom;
  return config;
}
