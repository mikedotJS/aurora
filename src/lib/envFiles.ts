// Per-workspace env-file materialization (Conductor-style `.env.local`).
//
// Aurora's sole port primitive is $AURORA_PORT_OFFSET, expanded by the shell in a
// script's command (`vite --port $((5173 + AURORA_PORT_OFFSET))`). That only
// reaches a service whose *start command* Aurora controls. A service that reads
// its port from a file it loads itself (Next.js `.env.development`, a Fastify
// `process.env.PORT`, a docker-compose file) never sees the offset — so two live
// worktrees collide on that service's port.
//
// This module closes that gap the way Conductor does: on worktree create, write a
// small per-workspace env file (e.g. `apps/api/.env.local`) with the workspace's
// concrete derived values baked in. No change to the service's start command.
//
// A spec's `content` is a template with three substitutions (everything else is
// left verbatim, so an unrelated `${FOO}` is never blanked):
//   ${port:BASE}  → BASE + offset        e.g. ${port:3000} with offset 10 → 3010
//   ${offset}     → the raw offset        e.g. 10
//   ${workspace}  → the workspace name    e.g. feat-welcomer  (for COMPOSE_PROJECT_NAME, DB names)
//
// Example spec for the ClubMed api gap:
//   { path: "apps/api/.env.local",
//     content: "PORT=${port:3000}\n" }
//   { path: "apps/welcomer/.env.local",
//     content: "NEXT_PUBLIC_API_URL=http://localhost:${port:3000}/api\nCOMPOSE_PROJECT_NAME=odyssey-${workspace}\n" }

import { writeTextFile } from "./sys";

/** One env file to materialize into a fresh workspace. */
export interface EnvFileSpec {
  /** Path relative to the workspace dir, e.g. "apps/api/.env.local". */
  path: string;
  /** Template content; supports ${port:BASE}, ${offset}, ${workspace}. */
  content: string;
}

/** The concrete per-workspace values a template renders against. */
export interface EnvContext {
  /** The workspace's allocated AURORA_PORT_OFFSET. */
  offset: number;
  /** Filesystem-safe workspace name (== worktree dir leaf), for namespacing. */
  workspace: string;
}

// Matches ${port:3000} — the base port to which the offset is added.
const PORT_RE = /\$\{port:(\d+)\}/g;

/**
 * Expand an env-file template against a workspace context. Pure — no I/O — so the
 * substitution rules are unit-testable in isolation. Unknown `${...}` tokens are
 * left untouched (fail-safe: never silently blank a value the user didn't mean
 * for us to own).
 */
export function renderEnvContent(template: string, ctx: EnvContext): string {
  return template
    .replace(PORT_RE, (_m, base: string) => String(parseInt(base, 10) + ctx.offset))
    .split("${offset}")
    .join(String(ctx.offset))
    .split("${workspace}")
    .join(ctx.workspace);
}

/**
 * Resolve a workspace-relative env-file path under `dir`, or null when the path
 * would escape the workspace (absolute, or containing a `..` segment). The guard
 * keeps a malformed/hostile spec from writing outside the freshly-created
 * worktree. Pure + testable.
 */
export function resolveEnvPath(dir: string, rel: string): string | null {
  const clean = rel.trim().replace(/^\.\//, "");
  if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) return null;
  return `${dir.replace(/\/$/, "")}/${clean}`;
}

/** Outcome of materializing one spec — surfaced so the caller can report skips/failures. */
export interface EnvFileResult {
  path: string;
  ok: boolean;
  /** Present when ok === false. */
  error?: string;
}

/**
 * Render + write every spec into `dir`. Best-effort and independent: one bad spec
 * (unwritable path, escape attempt) doesn't block the others, and the returned
 * results let the create flow notify on any failures without aborting the
 * workspace. Empty/blank paths are skipped silently.
 */
export async function materializeEnvFiles(
  dir: string,
  specs: EnvFileSpec[],
  ctx: EnvContext,
): Promise<EnvFileResult[]> {
  const targets = specs.filter((s) => s.path.trim());
  return Promise.all(
    targets.map(async (s): Promise<EnvFileResult> => {
      const abs = resolveEnvPath(dir, s.path);
      if (!abs) return { path: s.path, ok: false, error: "path escapes the workspace" };
      try {
        await writeTextFile(abs, renderEnvContent(s.content, ctx));
        return { path: s.path, ok: true };
      } catch (e) {
        return { path: s.path, ok: false, error: String(e) };
      }
    }),
  );
}
