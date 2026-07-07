// Orchestrates workspace creation: validate → add a git worktree (outside the
// repo's tracked tree) → register the workspace → open preset panes → run the
// on-open script. Used by the create palette + scope form.

import { useStore } from "../state/store";
import { worktreeAdd, worktreeRemove } from "./worktree";
import { validateBranchName, slugify } from "./branchName";
import { validateBranchNameBackend, listDir } from "./sys";
import { runScript, runCommand } from "./scripts";
import { getRepoConfig, type Preset } from "./repoConfig";
import { presetCreateFields } from "./presets";
import { materializeEnvFiles, type EnvFileSpec } from "./envFiles";

const PORT_STEP = 10;

/**
 * The port offset for a new workspace. A fixed preset offset is used as-is; an
 * `auto`/absent offset gets the lowest unused multiple of the step among the
 * repo's live workspaces — so two live workspaces never share a slot.
 */
function allocOffset(repoRoot: string, presetOffset: "auto" | number | undefined): number {
  if (typeof presetOffset === "number") return presetOffset;
  const used = new Set<number>();
  for (const w of useStore.getState().workspaces) {
    if (w.repoId !== repoRoot) continue;
    const n = parseInt(w.env?.AURORA_PORT_OFFSET ?? "", 10);
    if (!Number.isNaN(n)) used.add(n);
  }
  let off = 0;
  while (used.has(off)) off += PORT_STEP;
  return off;
}

/**
 * The dependency-install command for a freshly-created worktree, inferred from
 * the repo's lockfile (a new git worktree has no `node_modules` — they're
 * gitignored and not carried over). Returns null for repos we don't recognize as
 * a JS project, so non-JS worktrees get no install step.
 */
async function installCommand(root: string): Promise<string | null> {
  const names = new Set((await listDir(root, true)).map((e) => e.name));
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun install";
  if (names.has("pnpm-lock.yaml")) return "pnpm install";
  if (names.has("yarn.lock")) return "yarn install";
  if (names.has("package-lock.json")) return "npm install";
  if (names.has("package.json")) return "npm install"; // JS project, no lockfile
  return null;
}

export type CreateSource = "branch" | "describe" | "clone" | "jira";

export interface CreateSpec {
  repoRoot: string;
  repoName: string;
  source: CreateSource;
  issueKey?: string | null;
  title: string;
  branch: string;
  baseBranch: string;
  /** false when checking out an existing branch rather than creating one. */
  newBranch: boolean;
  preset: string | null;
  scriptName?: string | null;
  paneCount?: number;
  split?: "h" | "v";
  /** Jira metadata recorded on the workspace (set by the Jira create source). */
  jiraStatus?: string | null;
  jiraUrl?: string | null;
  jiraSync?: boolean;
  /** Preset env vars exported into the workspace's panes. */
  env?: Record<string, string>;
  /** "auto" → a distinct per-workspace offset; number → fixed. Exposed as $AURORA_PORT_OFFSET. */
  portOffset?: "auto" | number;
  /** Per-workspace env files written into the fresh worktree on create (see lib/envFiles.ts). */
  envFiles?: EnvFileSpec[];
}

export type CreateResult = { ok: true; wsId: string } | { ok: false; error: string };

/** Sibling worktree dir, never inside the repo's tracked tree. */
function worktreeDir(repoRoot: string, repoName: string, branch: string): string {
  // Parent of the repo root; fall back to "/" (never the repo itself, which would
  // place the worktree inside the tracked tree).
  const parent = repoRoot.replace(/\/[^/]+\/?$/, "") || "/";
  const leaf = slugify(branch.replace(/\//g, "-")) || "ws";
  return `${parent.replace(/\/$/, "")}/.aurora-worktrees/${repoName}/${leaf}`;
}

function humanize(raw: string, branch: string): string {
  const r = raw.toLowerCase();
  if (r.includes("already exists") || r.includes("already used by worktree"))
    return `“${branch}” already exists — pick a different branch name.`;
  if (r.includes("not a valid object name") || r.includes("invalid reference"))
    return "The base branch doesn't exist.";
  const first = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return (first ?? "Couldn't create the workspace.").replace(/^(error|fatal|git):\s*/i, "");
}

export interface BuildCreateSpecInput {
  repo: { root: string; name: string; defaultBranch: string };
  source: CreateSource;
  /** The resolved preset object (not just its name). Null when none. */
  preset?: Preset | null;
  branch: string;
  title: string;
  /**
   * Explicit base branch (e.g. user's selection in the scope form, or the
   * source branch for a clone). When absent, falls back to:
   * preset.baseOverride → cfg.defaults.baseBranch → repo.defaultBranch.
   */
  baseBranch?: string | null;
  /**
   * Explicit on-open script name.
   * - `undefined` (not passed) → use preset.runOnOpen as default.
   * - `""` or `null` → user explicitly chose "none".
   */
  scriptName?: string | null;
  newBranch: boolean;
  issueKey?: string | null;
  jiraStatus?: string | null;
  jiraUrl?: string | null;
  jiraSync?: boolean;
}

export interface ResolveCreateDefaultsInput {
  repo: { root: string; defaultBranch: string };
  preset?: Preset | null;
  /**
   * Explicit base branch (wins over preset.baseOverride and config defaults).
   * Absent/null → falls through the same chain as buildCreateSpec.
   */
  baseBranch?: string | null;
  /**
   * Explicit script name (undefined → preset fallback; ""/"" or null → none).
   */
  scriptName?: string | null;
}

export interface CreateDefaults {
  base: string;
  presetName: string | null;
  scriptName: string | null;
}

/**
 * Resolves the base branch, preset name, and on-open script for a new workspace.
 * Shared by buildCreateSpec and the display helpers in WorkspaceCommand so the
 * displayed defaults and the actual created spec can never drift.
 */
export function resolveCreateDefaults(input: ResolveCreateDefaultsInput): CreateDefaults {
  const cfg = getRepoConfig(input.repo.root);
  const fields = input.preset ? presetCreateFields(input.preset) : null;
  const base =
    input.baseBranch ??
    fields?.baseOverride ??
    cfg.defaults.baseBranch ??
    input.repo.defaultBranch;
  // undefined → use preset default; null/"" → user explicitly chose none.
  const scriptName =
    input.scriptName !== undefined ? (input.scriptName || null) : (fields?.scriptName ?? null);
  return { base, presetName: input.preset?.name ?? null, scriptName };
}

/**
 * Assemble a complete CreateSpec from explicit inputs, resolving defaults from
 * the preset and repo config. Both the quick-create path and the scope form
 * must build their spec through this function so both paths are observably
 * equivalent for the same inputs.
 */
export function buildCreateSpec(input: BuildCreateSpecInput): CreateSpec {
  const fields = input.preset ? presetCreateFields(input.preset) : null;
  const { base: baseBranch, scriptName } = resolveCreateDefaults(input);

  return {
    repoRoot: input.repo.root,
    repoName: input.repo.name,
    source: input.source,
    issueKey: input.issueKey ?? null,
    title: input.title,
    branch: input.branch,
    baseBranch,
    newBranch: input.newBranch,
    preset: input.preset?.name ?? null,
    scriptName,
    paneCount: fields?.paneCount ?? 1,
    split: fields?.split,
    jiraStatus: input.jiraStatus ?? null,
    jiraUrl: input.jiraUrl ?? null,
    jiraSync: input.jiraSync ?? false,
    env: fields?.env ?? {},
    portOffset: fields?.portOffset ?? "auto",
    envFiles: fields?.envFiles ?? [],
  };
}

// Serialize creates per repoRoot. allocOffset picks a collision-free
// AURORA_PORT_OFFSET by scanning the store's live workspaces, but the picked
// offset isn't registered until createWorkspace — and an await
// (materializeEnvFiles) sits between the read and that registration. Two
// overlapping creates for the same repo would otherwise both read a stale
// used-offset set and allocate the same offset, silently defeating port
// isolation. A per-repo promise chain makes allocOffset→createWorkspace
// effectively atomic; distinct repos still run concurrently.
const createChains = new Map<string, Promise<unknown>>();

export function runCreate(spec: CreateSpec): Promise<CreateResult> {
  const prev = createChains.get(spec.repoRoot) ?? Promise.resolve();
  const next = prev.then(
    () => runCreateInner(spec),
    () => runCreateInner(spec),
  );
  // Store an error-swallowing tail so one failed create never wedges the chain.
  createChains.set(spec.repoRoot, next.catch(() => {}));
  return next;
}

async function runCreateInner(spec: CreateSpec): Promise<CreateResult> {
  // Local sanity first (cheap), then the repo's authoritative validate-branch-name
  // rule when present — so a workspace can never be created on a name that would
  // fail the repo's pre-push hook. Passes through when no validator is configured.
  const check = validateBranchName(spec.branch);
  if (!check.ok) return { ok: false, error: check.error };
  const authoritative = await validateBranchNameBackend(spec.repoRoot, spec.branch);
  if (!authoritative.ok)
    return { ok: false, error: authoritative.message ?? "That branch name fails the repo's naming rule." };

  const dir = worktreeDir(spec.repoRoot, spec.repoName, spec.branch);
  const res = await worktreeAdd(spec.repoRoot, dir, spec.branch, spec.baseBranch, spec.newBranch);
  if (!res.ok) return { ok: false, error: humanize(res.error, spec.branch) };

  // Resolve the workspace env: preset env + a collision-free port offset exposed
  // to the panes as $AURORA_PORT_OFFSET. The offset is the sole port primitive —
  // no base port, no automatic PORT injection. Generated scripts bind their own
  // default+offset per server (e.g. `vite --port $((5173 + AURORA_PORT_OFFSET))`).
  // $AURORA_WORKSPACE_NAME (the worktree dir leaf) is also exported for
  // namespacing (Docker compose project, DB names) — parity with Conductor's
  // CONDUCTOR_WORKSPACE_NAME.
  const offset = allocOffset(spec.repoRoot, spec.portOffset);
  const workspaceName = dir.split("/").filter(Boolean).pop() ?? spec.branch;
  const env: Record<string, string> = {
    ...(spec.env ?? {}),
    AURORA_PORT_OFFSET: String(offset),
    AURORA_WORKSPACE_NAME: workspaceName,
  };

  // Materialize any per-workspace env files into the fresh worktree BEFORE panes
  // spawn / scripts run, so a service that reads its port from a file (not a
  // `$((BASE + AURORA_PORT_OFFSET))` command) starts on the allocated port.
  // Best-effort: a write failure is surfaced but never aborts the workspace.
  if (spec.envFiles?.length) {
    const results = await materializeEnvFiles(dir, spec.envFiles, { offset, workspace: workspaceName });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      useStore.getState().notify({
        color: "var(--warn)",
        icon: "⚠",
        headline: `${failed.length} env file${failed.length > 1 ? "s" : ""} not written`,
        sub: failed.map((f) => `${f.path}: ${f.error}`).join(" · "),
        repo: spec.repoRoot,
      });
    }
  }

  let wsId: string;
  try {
    wsId = useStore.getState().createWorkspace({
      repoId: spec.repoRoot,
      title: spec.title || spec.branch,
      dir,
      branch: spec.branch,
      baseBranch: spec.baseBranch,
      issueKey: spec.issueKey ?? null,
      preset: spec.preset,
      paneCount: spec.paneCount ?? 1,
      split: spec.split,
      jiraStatus: spec.jiraStatus ?? null,
      jiraUrl: spec.jiraUrl ?? null,
      jiraSync: spec.jiraSync ?? false,
      env,
    });
  } catch (e) {
    await worktreeRemove(spec.repoRoot, dir, true);
    return { ok: false, error: String(e) };
  }

  // Install dependencies into the fresh worktree (it has no node_modules), then
  // run the on-open script once the new workspace's panes exist.
  const install = await installCommand(spec.repoRoot);
  const st = useStore.getState();
  const w = st.workspaces.find((x) => x.id === wsId);
  const g = w?.tabs[w.active];
  const pane = g?.panes[g.active];
  if (pane) {
    if (spec.scriptName) {
      // Chain install before the script so they run as one ordered block.
      runScript(pane.id, spec.scriptName, { lookupRoot: spec.repoRoot, execBase: dir, prelude: install ?? undefined });
    } else {
      if (install) runCommand(pane.id, install);
    }
  }
  return { ok: true, wsId };
}
