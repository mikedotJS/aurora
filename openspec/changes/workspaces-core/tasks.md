## 1. Backend: git worktree + status (`src-tauri/src/git.rs`)

- [x] 1.1 Create `git.rs`; add `git_repo_info(cwd) -> Option<RepoInfo{root,name,default_branch,current_branch}>` (rev-parse toplevel, basename, origin/HEAD symbolic-ref with `main` fallback, branch --show-current).
- [x] 1.2 Add `worktree_list(root) -> Vec<Worktree{path,branch,head}>` parsing `git worktree list --porcelain`.
- [x] 1.3 Add `worktree_add(root, dir, branch, base, new_branch: bool)` and `worktree_remove(root, dir, force)`.
- [x] 1.4 Add `git_status_summary(dir, base) -> Summary{files,added,removed,conflicted}` from `git diff --shortstat <base>...HEAD` + `git status --porcelain`.
- [x] 1.5 Register all new commands in `src-tauri/src/lib.rs`; PATH-augment like `glab.rs`. `cargo build` clean.

## 2. Frontend bridges (`src/lib/`)

- [x] 2.1 `lib/sys.ts`: add `gitRepoInfo`, `gitStatusSummary` wrappers (graceful `.catch` fallbacks), with TS types.
- [x] 2.2 `lib/worktree.ts`: add `worktreeList`, `worktreeAdd`, `worktreeRemove` wrappers.
- [x] 2.3 `lib/workspace.ts`: `statusOf(ws): WsStatus` (D4 state machine), `dotColor(status)`, and persistence helpers `loadWorkspaces()`/`saveWorkspaces(list)` against `localStorage["aurora.workspaces"]`.

## 3. State: Workspace model (`src/state/store.ts`)

- [x] 3.1 Add `Repo`, `Workspace`, `WsStatus`, `AgentKind` types and a `newWorkspace(repo, dir, branch, base)` factory; keep `Group`/`PaneState` unchanged.
- [x] 3.2 Replace top-level `tabs`/`active` with `repos: Repo[]`, `workspaces: Workspace[]`, `activeWs: string`, `railCollapsed: boolean`, `wsFilter: string`.
- [x] 3.3 Add `patchActiveWs(workspaces, activeWs, fn)`; rewrite `activeGroup`/`activePane` to read through the active workspace; migrate every pane/tab action to operate on the active workspace's `tabs`/`active`.
- [x] 3.4 Add workspace actions: `switchWorkspace(id)`, `setRailCollapsed(v)`, `setWsFilter(q)`, `setWsDiff(id, diff)`, `renameWorkspace(id, title)`, `setWsBranch(id, branch)`, `setWsAgentBusy(id, v)`, `setWsNeedsInput(id, v)`, `archiveWorkspace(id)`. Persist on the structural ones.
- [x] 3.5 Rewrite `init` per D2: resolve repo info, build the initial workspace, merge restored workspaces, set `activeWs`.

## 4. UI: rail, switcher, context bar, status counter

- [x] 4.1 `components/WorkspaceRail.tsx`: repo groups (collapsible) + workspace cards (status dot, issue key+title, agent badge, branch, status line, ±diff), filter input, collapse toggle, "+ New workspace" (inert placeholder until `workspace-create`). Reuse `tokens.css`.
- [x] 4.2 `components/WorkspaceSwitcher.tsx`: title-bar pill + grouped dropdown (filter, ↑↓, ↵, ⌘1–9, status dots), reusing BranchSwitcher popover styling/keyboarding.
- [x] 4.3 `App.tsx`: make the window body a row with `<WorkspaceRail/>` (when `!railCollapsed`) beside the terminal column; render a context bar above `TabStrip` when the active workspace has issue/agent/preset meta.
- [x] 4.4 `TitleBar.tsx`: show the workspace pill/switcher when the rail is collapsed.
- [x] 4.5 `StatusBar.tsx`: add the `⊟ N changed +A −R` counter from the active workspace's diff (click → Changes, inert until `workspace-changes`; ⌘G hint).
- [x] 4.6 Effect: when the active workspace changes (or its cwd/branch), refresh `git_status_summary` and store it via `setWsDiff`.

## 5. Keymap

- [x] 5.1 `lib/keymap.ts`: keep ⌘1–9 selecting **tabs within the workspace**; add a rail toggle (e.g. ⌘B) and confirm ⌃Tab still cycles tabs. Switcher ⌘1–9 only applies while its dropdown is open.

## 6. Validation

- [ ] 6.1 Manually verify: boot-in-repo initial workspace; boot-outside-repo manual lane; tab/pane operations scoped to active workspace; closing last tab keeps the workspace; switch preserves background processes; rail grouping + filter + collapse; switcher keyboarding; status-dot mapping (idle/attention/agent); persistence across relaunch + stale prune.
- [x] 6.2 `bun run lint`, `bun run build`, and `cargo build` all clean.
