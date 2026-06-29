// Polls visited GitLab repos for merge-request changes and raises Aurora
// notifications. Also caches each repo's MR list (for the MR sheet + status-bar
// count). Degrades silently when glab is missing or a repo isn't on GitLab.

import { invoke } from "@tauri-apps/api/core";
import { useStore, type GitlabMr } from "../state/store";

type Snap = Map<number, { updated: string; draft: boolean }>;

const snapshots = new Map<string, Snap>();
const notGitlab = new Set<string>();
let timer: number | null = null;

const AC = "oklch(0.83 0.115 184)";
const INFO = "oklch(0.72 0.1 255)";

function visitedRoots(): string[] {
  const roots = new Set<string>();
  for (const g of useStore.getState().tabs) for (const p of g.panes) if (p.repoRoot) roots.add(p.repoRoot);
  return [...roots];
}

async function pollRepo(root: string) {
  if (notGitlab.has(root)) return;
  let mrs: GitlabMr[];
  try {
    mrs = await invoke<GitlabMr[]>("glab_mr_list", { cwd: root });
  } catch {
    notGitlab.add(root); // glab missing / not authed / not a GitLab repo
    return;
  }
  const st = useStore.getState();
  st.setRepoMrs(root, mrs);

  const repo = root.split("/").filter(Boolean).pop() || root;
  const prev = snapshots.get(root);
  const next: Snap = new Map();
  for (const mr of mrs) next.set(mr.iid, { updated: mr.updated, draft: mr.draft });
  snapshots.set(root, next);

  if (!prev || !st.settings.notifyMr) return; // first poll seeds only
  for (const mr of mrs) {
    const p = prev.get(mr.iid);
    if (!p) {
      st.notify({ color: AC, icon: "⇋", headline: `New MR !${mr.iid}`, sub: mr.title, repo, url: mr.web_url });
    } else if (p.draft && !mr.draft) {
      st.notify({ color: AC, icon: "✓", headline: `MR !${mr.iid} ready for review`, sub: mr.title, repo, url: mr.web_url });
    } else if (p.updated !== mr.updated) {
      st.notify({ color: INFO, icon: "↻", headline: `MR !${mr.iid} updated`, sub: mr.title, repo, url: mr.web_url });
    }
  }
}

async function pollAll() {
  for (const root of visitedRoots()) await pollRepo(root);
}

export function startNotificationPoller() {
  if (timer != null) return;
  void pollAll();
  timer = window.setInterval(() => void pollAll(), 30000);
}

/** Force-refresh a repo's MR cache (used when opening the MR sheet). */
export function refreshRepoMrs(root: string): Promise<void> {
  notGitlab.delete(root);
  return pollRepo(root);
}

// Resolve the authenticated glab username for a repo (for the MR sheet's "mine"
// filter). The host — and thus the username — is per-repo, so we cache by root.
// Null when glab is missing / not authed for that host (toggle disabled).
const userByRoot = new Map<string, string | null>();

export async function ensureGlabUser(root: string | null): Promise<void> {
  const st = useStore.getState();
  if (!root) {
    st.setGlabUser(null);
    return;
  }
  if (userByRoot.has(root)) {
    st.setGlabUser(userByRoot.get(root) ?? null);
    return;
  }
  try {
    const user = await invoke<string>("glab_current_user", { cwd: root });
    userByRoot.set(root, user);
    st.setGlabUser(user);
  } catch {
    userByRoot.set(root, null); // glab missing / not authed for this host
    st.setGlabUser(null);
  }
}
