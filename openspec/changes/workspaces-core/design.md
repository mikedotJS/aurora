# Design — workspaces-core

## D1 · State model: Workspace above tabs/panes

The existing store is `{ tabs: Group[], active }` where `Group = { panes: PaneState[], active, split }`.
We insert a durable layer **above** it. The current per-tab/per-pane logic (keymap, blocks, ghost,
completion, history) is large and correct — we keep `Group`/`PaneState` **unchanged** and re-home
the tab list under the active workspace.

```ts
type WsStatus = "agent-working" | "needs-you" | "alt-harness" | "attention" | "idle";
type AgentKind = "claude-work" | "claude-personal" | "aider" | "none";

interface Repo {
  id: string;          // stable: the main worktree's absolute path
  name: string;        // basename of the repo root ("aurora")
  root: string;        // main worktree path
  defaultBranch: string;
}

interface Workspace {
  id: string;          // uuid-ish (seq + boot nonce); stable across restarts
  repoId: string | null;   // null = manual/scratch workspace not in a repo
  title: string;       // "fix auth redirect" (issue summary, branch, or folder name)
  issueKey: string | null; // "PROJ-1423" when issue-backed (set by workspace-create/jira)
  branch: string | null;
  baseBranch: string;  // diff/target base ("main")
  dir: string;         // worktree directory (== main root for the initial workspace)
  agent: AgentKind;    // "none" for a manual lane
  agentBusy: boolean;  // agent currently editing (drives "agent-working")
  needsInput: boolean; // agent paused / review requested (drives "needs-you")
  preset: string | null;
  diff: { files: number; added: number; removed: number } | null;
  mr: { iid: number; state: "draft" | "open" | "merged"; url: string } | null;
  pipeline: "passed" | "failed" | "running" | null;
  // owned terminal layout (was the top-level tabs/active)
  tabs: Group[];
  active: number;
  createdAt: number;
  lastActive: number;
  archived: boolean;
}
```

`StoreState` changes: remove top-level `tabs`/`active`; add `repos: Repo[]`, `workspaces: Workspace[]`,
`activeWs: string` (workspace id), `railCollapsed: boolean`, `wsFilter: string`. Everything else
(settings, panels, notifs, key state) is unchanged.

### Selectors & the patch helper
- `activeWorkspace(s) = s.workspaces.find(w => w.id === s.activeWs)`.
- `activeGroup(s)` / `activePane(s)` read through the active workspace's `tabs`/`active` (same return
  types as today, so components and keymap that call them keep working).
- `patchPane(...)` today maps over `s.tabs`. We add `patchActiveWs(workspaces, activeWs, fn)` that
  applies `fn(ws.tabs) -> {tabs, active}` to the active workspace and returns the new `workspaces`.
  The existing pane actions (`setInput`, `splitPane`, `startBlock`, …) switch from
  `set(s => ({ tabs: patchPane(s.tabs, …) }))` to
  `set(s => ({ workspaces: patchActiveWs(s.workspaces, s.activeWs, t => ({ tabs: patchPane(t, …) })) }))`.
  This is mechanical and contained to `store.ts`.

### Tab actions stay, scoped to the active workspace
`newTab`/`closeTab`/`selectTab`/`cycleTab`/`splitPane`/`closePane`/`focusPane`/`cyclePane`/`mergeTabs`
now operate on the active workspace's `tabs`. `⌘1–9` still selects **tabs within the workspace**
(unchanged) — workspace jumps use the **switcher** (its own ⌘1–9 only while the switcher dropdown is
open, to avoid clashing). Closing the **last** tab of a workspace does **not** delete the workspace;
it leaves one fresh pane (a workspace is durable).

## D2 · Boot & the initial workspace

`init(home, settings, key)` today creates one `Group` at `home`. New boot:
1. Resolve `git_repo_info(home)`. If in a repo → create `Repo{root,name,defaultBranch}` and one
   `Workspace` for the **current checkout** (`dir = root`, `branch = current`, `baseBranch = default`).
   Else → a **manual** workspace (`repoId = null`, `dir = home`, `agent = "none"`).
2. Load persisted workspaces (see D5) and merge: any persisted workspace whose `dir` still exists is
   restored (panes empty until activated); the boot workspace is added/kept active.

PTYs are **not** spawned for inactive workspaces. `PaneArea` spawns the active workspace's panes on
activation (it already lazily spawns per-pane). Switching workspaces just changes `activeWs`; the
previous workspace's PTYs keep running in the background (so an agent keeps working).

## D3 · Worktree backend (`src-tauri/src/git.rs`)

All shell out to `git`, run in the repo root, PATH-augmented like `glab.rs`.

- `git_repo_info(cwd) -> { root, name, default_branch, current_branch } | null` —
  `rev-parse --show-toplevel`, basename, `symbolic-ref refs/remotes/origin/HEAD` (fallback `main`),
  `branch --show-current`.
- `worktree_list(root) -> [{ path, branch, head }]` — `git worktree list --porcelain`.
- `worktree_add(root, dir, branch, base) -> {path,branch}` — `git worktree add -b <branch> <dir> <base>`
  (or `git worktree add <dir> <branch>` when the branch already exists). Used by `workspace-create`;
  exposed here so the command surface lands with the model.
- `worktree_remove(root, dir, force) -> ()` — `git worktree remove [--force] <dir>`.
- `git_status_summary(dir, base) -> { files, added, removed, conflicted }` —
  `git diff --shortstat <base>...HEAD` plus `git status --porcelain` for working-tree changes and
  conflict (`UU`/`AA`) detection. Powers rail diff counts + the status bar counter.

Conflicted > 0 ⇒ candidate for `attention`. Pipeline state is read from `glab` later
(`workspace-config`/`jira`); the foundation leaves `pipeline = null`.

## D4 · Status-dot state machine (`lib/workspace.ts`)

`statusOf(ws): WsStatus` — agent state wins when an agent is attached:
```
if ws.agent !== "none":
  if ws.agentBusy && ws.agent.startsWith("claude") -> "agent-working"  (cyan, pulse)
  if ws.agentBusy && ws.agent === "aider"          -> "alt-harness"    (magenta, pulse)
  if ws.needsInput                                  -> "needs-you"      (amber)
git fallback:
  if ws.pipeline === "failed" || ws.diff?.conflicted -> "attention"    (red)
  else                                               -> "idle"         (faint; clean OR uncommitted)
```
Colors map to existing tokens: cyan `--ac`, amber `--warn`, magenta `--alt`, red `--err`, faint
`--faint`. Pulse reuses the `@keyframes pulse` already in `global.css`/tokens. The legend (Frame 4)
is a small static reference rendered in workspace settings (full settings UI is `workspace-config`;
the foundation ships the legend inline in the switcher footer / rail empty-state to document meaning).

## D5 · Persistence

`aurora.workspaces` in `localStorage` (same approach as `aurora.settings`/`aurora.scripts`): an array
of `Workspace` minus runtime-only fields (`tabs` panes' PTY ids, `agentBusy`, `needsInput`). On
launch we restore metadata and stale-prune any workspace whose `dir` no longer exists. Writing is
debounced on workspace add/remove/rename/branch-change (not on every keystroke). `repos` is derived
from the restored workspaces' `repoId`s plus the boot repo.

## D6 · UI surfaces

- `WorkspaceRail.tsx` — fixed 256px left column inside the window body (left of the main terminal
  column), shown when `!railCollapsed`. Repo group headers (collapsible), workspace cards, filter
  input, "+ New workspace" (opens the create palette from `workspace-create`; until that lands, the
  button is present but inert/announces "coming soon" — wired in change 2). Clicking a card →
  `switchWorkspace(id)`. Clicking a card's ±diff counts → opens Changes (wired by `workspace-changes`;
  inert until then).
- `WorkspaceSwitcher.tsx` — the title-bar pill + dropdown for when the rail is collapsed; reuses the
  rail's data and the BranchSwitcher popover styling/keyboarding (filter, ↑↓, ↵, ⌘1–9).
- `App.tsx` body becomes `flex`: `<WorkspaceRail/>` + the existing `TitleBar/TabStrip/PaneArea/StatusBar`
  column. The context bar renders above `TabStrip` when the active workspace has issue/agent/preset meta.
- `StatusBar` gains a change counter (`⊟ N changed +A −R`) from the active workspace's `diff`,
  clickable (opens Changes — wired in change 3) with a ⌘G hint.

## D7 · What this change does NOT do (handed to later changes)

- Creating workspaces (palette + scope form + actual `worktree_add`) → `workspace-create`.
- The diff/Changes view → `workspace-changes`.
- Editable presets, branch-naming rules, the full settings panel, lifecycle prune/archive → `workspace-config`.
- Real agent attach/auto-start and Jira issue/status/transition → `jira-integration` + `workspace-create`.
  The model carries `agent`/`issueKey`/`jiraStatus` fields so later changes only populate them.
