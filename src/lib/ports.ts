// Pure port-isolation helpers — no Tauri, no store imports.
// Extracted from WorkspaceRail.tsx so tests can import them directly without
// triggering the component module graph (fixes mock-leak flakiness — H1).
//
// managed-server-lifecycle additions (task 3.2/3.6): the absolute `AURORA_PORT`
// base constant, and pure collision-detection over PROBED ports (the real
// bound-port truth from `server_probe`, not the text-scanner heuristics below —
// see design.md Decision 5). The text scanners (`portScripts`/`serverUnits`/
// `parseDerivedPorts`) are retired to a fallback-only role once the JS
// lifecycle rewrite (tasks.md phase 4) reads `kind: "run"` from `aurora.json`
// instead of regex-matching `$((N + AURORA_PORT_OFFSET))`; both still live here
// today so the current Run/Stop path keeps working unchanged.

/** Base port for the absolute `AURORA_PORT` contract. `AURORA_PORT =
 *  AURORA_PORT_BASE + AURORA_PORT_OFFSET`, so the legacy idiom
 *  `$((3000 + AURORA_PORT_OFFSET))` keeps resolving to exactly `AURORA_PORT` —
 *  migration to the absolute var is numerically lossless. */
export const AURORA_PORT_BASE = 3000;

/** Width of a workspace's reserved port range (`create.ts`'s `PORT_STEP`). */
export const AURORA_PORT_RANGE_WIDTH = 10;

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

// ── Collision detection over probed (real) ports (task 3.6) ────────────────

/** A workspace's allocated range + the ports its managed servers actually
 *  have bound, per `server_probe`. Structural shape only — no store import. */
export interface WorkspacePortState {
  wsId: string;
  /** This workspace's `AURORA_PORT_OFFSET`. */
  offset: number;
  /** Real bound ports (from `server_probe`), across all of this workspace's managed servers. */
  boundPorts: number[];
}

export type PortCollisionReason = "outside-range" | "shared-with-another-workspace";

export interface PortCollision {
  wsId: string;
  port: number;
  reason: PortCollisionReason;
  /** The other workspace sharing this port — only set for "shared-with-another-workspace". */
  sharedWith?: string;
}

/** Inclusive `[start, end]` port range a workspace's offset reserves. */
export function offsetRange(offset: number, base = AURORA_PORT_BASE, width = AURORA_PORT_RANGE_WIDTH): { start: number; end: number } {
  const start = base + offset;
  return { start, end: start + width - 1 };
}

/**
 * Detect collisions across a snapshot of live workspaces' probed ports:
 *   - a bound port outside the workspace's own reserved range → "outside-range"
 *   - a port bound by two DIFFERENT live workspaces → "shared-with-another-workspace"
 *     (reported symmetrically — once per workspace involved, per the spec's
 *     "surface loudly" requirement: each workspace's own badge must be able to
 *     show its own collision without cross-referencing the other's state).
 *
 * Pure — no store/Tauri reads; the caller assembles `WorkspacePortState[]` from
 * live workspace env + `server_probe` results.
 */
export function detectPortCollisions(
  workspaces: WorkspacePortState[],
  base = AURORA_PORT_BASE,
  width = AURORA_PORT_RANGE_WIDTH,
): PortCollision[] {
  const collisions: PortCollision[] = [];

  // Real bound-port ownership across all live workspaces — the sole source of
  // truth for a GENUINE collision. `server_probe` returns every LISTEN port
  // of a managed process's pgid, including perfectly normal aux/child
  // services outside the reserved window (Postgres 5432, a docker-compose
  // service, node's --inspect 9229, …) — a solo workspace bound to one of
  // those is not a conflict with anything, so "outside-range" must never be
  // flagged on its own (review finding #2: it used to fire a red toast on a
  // healthy `docker compose up`). It only becomes meaningful alongside an
  // actual second workspace fighting over the exact same port below.
  const byPort = new Map<number, Set<string>>();
  for (const ws of workspaces) {
    for (const port of ws.boundPorts) {
      const owners = byPort.get(port) ?? new Set<string>();
      owners.add(ws.wsId);
      byPort.set(port, owners);
    }
  }

  for (const ws of workspaces) {
    const { start, end } = offsetRange(ws.offset, base, width);
    for (const port of ws.boundPorts) {
      if ((byPort.get(port)?.size ?? 0) < 2) continue; // no other workspace contends this port — not a collision
      if (port < start || port > end) {
        collisions.push({ wsId: ws.wsId, port, reason: "outside-range" });
      }
    }
  }

  // Second pass for cross-workspace sharing: a port bound by >1 distinct
  // workspace. Grouped separately from the range check above so a port that's
  // BOTH out-of-range AND shared reports both reasons (two entries), not one
  // reason masking the other.
  for (const [port, owners] of byPort) {
    if (owners.size < 2) continue;
    for (const wsId of owners) {
      const other = [...owners].find((id) => id !== wsId);
      collisions.push({ wsId, port, reason: "shared-with-another-workspace", sharedWith: other });
    }
  }

  return collisions;
}

/** True when `wsId` has at least one collision in a `detectPortCollisions` result. */
export function hasCollision(collisions: PortCollision[], wsId: string): boolean {
  return collisions.some((c) => c.wsId === wsId);
}
