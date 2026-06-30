// Pure port-isolation helpers — no Tauri, no store imports.
// Extracted from WorkspaceRail.tsx so tests can import them directly without
// triggering the component module graph (fixes mock-leak flakiness — H1).

/** Minimal script shape needed for port extraction (structural subset of Script in store). */
export interface PortScript {
  name: string;
  /** Mirror of Script.split — honored by serverUnits to fan out concurrent panes. */
  split?: boolean;
  tasks: { dir: string; cmd: string }[];
}

/**
 * A single pane unit derived from port-scripts, honoring the `split` flag.
 *
 * - taskIndex null  → run all tasks chained with && in one pane (non-split path)
 * - taskIndex N     → run only task[N] in its own pane (split path, concurrent)
 */
export interface ServerUnit {
  name: string;
  taskIndex: number | null;
}

/**
 * Parse AURORA_PORT_OFFSET from a workspace env map.
 * Returns NaN when absent or malformed.
 */
export function readOffset(env: Record<string, string> | undefined): number {
  const raw = env?.AURORA_PORT_OFFSET;
  if (raw === undefined) return NaN;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Return the subset of scripts that are "port-scripts": at least one of their
 * tasks' commands matches the `$((N + AURORA_PORT_OFFSET))` pattern.
 *
 * A script that binds two ports appears **once** — it is one server (one pane).
 * Pure, no store/Tauri imports (keeps mock-leak safety).
 *
 * Exported for unit testing (workspace-run-servers).
 */
export function portScripts(scripts: PortScript[]): PortScript[] {
  const PORT_RE = /\$\(\((\d+)\s*\+\s*AURORA_PORT_OFFSET\)\)/;
  return scripts.filter((s) => s.tasks.some((t) => PORT_RE.test(t.cmd)));
}

/**
 * Expand port-scripts into server units, honoring the `split` flag — parity with runScript.
 *
 * - split script with ≥2 (non-empty) tasks → one unit per task (concurrent panes, no &&)
 * - non-split script, or split with exactly 1 non-empty task → one unit (tasks chained &&)
 *
 * The length of the returned array is the number of panes `runServers` will open.
 * Pure, no store/Tauri imports.
 *
 * Exported for unit testing (workspace-run-servers).
 */
export function serverUnits(scripts: PortScript[]): ServerUnit[] {
  const units: ServerUnit[] = [];
  for (const s of portScripts(scripts)) {
    const tasks = s.tasks.filter((t) => t.cmd.trim());
    if (s.split && tasks.length > 1) {
      for (let i = 0; i < tasks.length; i++) {
        units.push({ name: s.name, taskIndex: i });
      }
    } else {
      units.push({ name: s.name, taskIndex: null });
    }
  }
  return units;
}

/**
 * Scan script commands for `$((<base> + AURORA_PORT_OFFSET))` and return the
 * concrete port labels. Never fabricates a port — only reports what the scripts say.
 *
 * Exported for unit testing (Task 3.3 — workspace-port-isolation).
 */
export function parseDerivedPorts(
  scripts: PortScript[],
  offset: number,
): { label: string; port: number }[] {
  const PORT_RE = /\$\(\((\d+)\s*\+\s*AURORA_PORT_OFFSET\)\)/g;
  const seen = new Set<number>();
  const result: { label: string; port: number }[] = [];
  for (const script of scripts) {
    for (const task of script.tasks) {
      let m: RegExpExecArray | null;
      PORT_RE.lastIndex = 0;
      while ((m = PORT_RE.exec(task.cmd)) !== null) {
        const port = parseInt(m[1], 10) + offset;
        if (!seen.has(port)) {
          seen.add(port);
          result.push({ label: script.name, port });
        }
      }
    }
  }
  return result;
}
