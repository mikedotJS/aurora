// Workspace-level helpers: the status-dot state machine (git-only) and
// persistence of the workspace list.

import type { Workspace, WsStatus, Repo } from "../state/store";

/**
 * The single status a workspace's dot reflects: git-only.
 * Attention on a failed pipeline or a merge conflict, else idle.
 */
export function statusOf(w: Workspace): WsStatus {
  if (w.pipeline === "failed" || (w.diff != null && w.diff.conflicted > 0)) return "attention";
  return "idle";
}

export function dotColor(status: WsStatus): string {
  return status === "attention" ? "var(--err)" : "var(--faint)";
}

export function dotPulses(_status: WsStatus): boolean {
  return false;
}

/** A short status line for a rail card, derived from git state only. */
export function statusLine(w: Workspace): { text: string; color: string } {
  const s = statusOf(w);
  if (s === "attention")
    return { text: w.pipeline === "failed" ? "✕ pipeline failed" : "merge conflict", color: dotColor(s) };
  const files = w.diff?.files ?? 0;
  if (files > 0) return { text: `${files} uncommitted`, color: "var(--dim)" };
  return { text: w.repoId == null ? "manual branch" : "idle", color: "var(--faint)" };
}

// ---- Persistence (metadata only; panes/PTYs are re-created on activation) ----

export interface PersistedWs {
  id: string;
  /** Optional at read time: legacy records predate this field and are treated
   *  as "workspace" by `rehydrate`. Always written for records saved by this
   *  version of the app (see `savePersisted`). */
  kind?: "home" | "workspace";
  repoId: string | null;
  title: string;
  issueKey: string | null;
  branch: string | null;
  baseBranch: string;
  dir: string;
  preset: string | null;
  jiraStatus: string | null;
  jiraUrl: string | null;
  jiraSync: boolean;
  env: Record<string, string>;
  createdAt: number;
  lastActive: number;
  // Note: older persisted data may contain an `archived` field (always false, never set).
  // It is silently ignored here — no migration needed.
}

const KEY = "aurora.workspaces";

export function loadPersisted(): { workspaces: PersistedWs[]; activeWs: string | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { workspaces: [], activeWs: null };
    const parsed = JSON.parse(raw);
    return {
      workspaces: Array.isArray(parsed?.workspaces) ? parsed.workspaces : [],
      activeWs: typeof parsed?.activeWs === "string" ? parsed.activeWs : null,
    };
  } catch {
    return { workspaces: [], activeWs: null };
  }
}

export function savePersisted(workspaces: Workspace[], activeWs: string | null): void {
  try {
    const ws: PersistedWs[] = workspaces.map((w) => ({
      id: w.id,
      kind: w.kind,
      repoId: w.repoId,
      title: w.title,
      issueKey: w.issueKey,
      branch: w.branch,
      baseBranch: w.baseBranch,
      dir: w.dir,
      preset: w.preset,
      jiraStatus: w.jiraStatus,
      jiraUrl: w.jiraUrl,
      jiraSync: w.jiraSync,
      env: w.env,
      createdAt: w.createdAt,
      lastActive: w.lastActive,
    }));
    localStorage.setItem(KEY, JSON.stringify({ workspaces: ws, activeWs }));
  } catch {
    /* ignore */
  }
}

// ---- Repo list (so repos added by folder survive a restart even with no
// workspaces yet; merged with the boot repo + workspace-derived repos). ----

const REPOS_KEY = "aurora.repos";

export function loadRepos(): Repo[] {
  try {
    const raw = localStorage.getItem(REPOS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Repo => r && typeof r.id === "string" && typeof r.root === "string" && typeof r.name === "string",
    );
  } catch {
    return [];
  }
}

export function saveRepos(repos: Repo[]): void {
  try {
    localStorage.setItem(REPOS_KEY, JSON.stringify(repos));
  } catch {
    /* ignore */
  }
}
