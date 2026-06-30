## Why

Today Aurora's top-level structure is ephemeral: `tabs: Group[]` (each a split of PTY panes) that
vanish on quit. The `Aurora Workspaces.dc.html` mockup introduces a **durable** organizing concept
on top of the terminal: a **Workspace** — a per-branch home, grouped by repo, that remembers its
branch, its panes, its agent, its diff against a base branch, and its review/issue state. Several
workspaces coexist (Claude editing PROJ-1423 while Aider works PROJ-2087), each in its own checkout,
each switchable from a left **rail** or a collapsed tab-strip switcher. This change builds that
foundation: the data model, the persisted workspace list, the rail + switcher UI, the status-dot
semantics, and the git-worktree backend that gives each workspace true isolation.

## What Changes

- **State model**: introduce `Workspace` (durable, per-branch, repo-grouped) as the layer **above**
  the existing tabs/panes. The current `tabs`/`active` become **per-workspace** (a workspace owns
  its tab strip of pane groups). Add `repos` (grouping by git repo) and `activeWs`.
- **Worktree isolation**: each workspace is backed by a **git worktree** directory, so multiple
  workspaces hold different branches checked out at once. New Rust commands: `worktree_add`,
  `worktree_list`, `worktree_remove`, plus `git_status_summary` (changed-file count + ±lines vs a
  base) and `git_repo_info` (repo name, default branch, current branch).
- **Workspace rail** (left): repo group headers with counts, workspace cards (status dot, issue
  key + title, agent badge, branch, agent/git status text, ±diff counts, review chip), a
  filter/create input (⌘K), a collapse toggle, and a "+ New workspace" affordance.
- **Switcher** (rail collapsed): a title-bar workspace pill that opens a grouped dropdown with
  ⌘1–⌘9 jumps, mirroring the rail.
- **Status dot**: a single dot per workspace — **agent state when an agent is attached** (working /
  needs-you / alt-harness), otherwise **git state** (attention on conflict/failed-pipeline, else
  idle). A manual workspace never looks "broken" for lacking an agent.
- **Workspace context bar** (top of the main column): branch · seeded-from · agent · preset · scope.
- **Persistence**: the workspace list + per-repo metadata persist (JSON under the app-config dir),
  restored on launch; panes/PTYs are re-created lazily on first activation.

## Capabilities

### New Capabilities
- `workspaces`: the durable Workspace model (repo-grouped, worktree-backed, per-branch), the
  workspace rail and collapsed-rail switcher, the status-dot state machine, the workspace context
  bar, and persistence/restore of the workspace list.

### Modified Capabilities
<!-- `terminal-core` (tabs/panes) is part of the in-progress `add-aurora-terminal` change and is not
     yet a baseline spec under openspec/specs/, so the tabs→per-workspace move is captured as a
     requirement inside this new `workspaces` spec rather than as a delta. -->

## Impact

- **Frontend (`src/`)**: `state/store.ts` gains the `Workspace`/`Repo` model and re-homes
  `tabs`/`active` under the active workspace (selectors `activeWs`, `activeGroup`, `activePane`
  updated to read through it). New `components/WorkspaceRail.tsx` and `components/WorkspaceSwitcher.tsx`;
  `TitleBar`/`App` gain the rail + pill; `StatusBar` shows the live change counter. `lib/sys.ts` +
  `lib/worktree.ts` wrap the new Tauri commands; `lib/workspace.ts` holds status-dot derivation and
  persistence.
- **Backend (`src-tauri/`)**: new `git.rs` (worktree add/list/remove, status summary, repo info)
  registered in `lib.rs`; `git_branch`/`git_root`/`git_switch` stay in `sys.rs`.
- **No breaking changes for the user**: on launch Aurora wraps the boot cwd in an initial workspace
  (the repo's existing checkout, or a manual/scratch workspace outside a repo), so the terminal
  behaves as before while gaining the rail.
- **Depends on**: nothing. **Depended on by**: `workspace-create`, `workspace-changes`,
  `workspace-config`, `jira-integration`.
