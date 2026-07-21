// Add a repository to the rail by picking a folder. Opens the native folder
// dialog, resolves the git repo that contains it (using the canonical main
// worktree root so all worktrees share one group), and registers it in the
// store. No-op when the dialog is cancelled.

import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../state/store";
import { gitRepoInfo } from "./sys";
import { checkMigrationOffer } from "./auroraConfigStore";

export type AddRepoResult =
  | { ok: true; root: string; name: string }
  | { ok: false; error: string }
  | { cancelled: true };

/** Open the native folder picker, or null when cancelled. */
export async function pickFolder(title = "Add a repository"): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

/** Pick a folder and register the git repo it lives in. */
export async function addRepoFromFolder(): Promise<AddRepoResult> {
  const dir = await pickFolder();
  if (!dir) return { cancelled: true };
  const info = await gitRepoInfo(dir);
  if (!info) return { ok: false, error: "That folder isn't inside a git repository." };
  // main_root is the canonical key (a worktree resolves to its primary repo).
  const root = info.main_root || info.root;
  useStore.getState().addRepo({ root, name: info.name, defaultBranch: info.default_branch });
  // Repo-open migration offer (managed-server-lifecycle task 6.2). Fire-and-forget.
  void checkMigrationOffer(root);
  return { ok: true, root, name: info.name };
}
