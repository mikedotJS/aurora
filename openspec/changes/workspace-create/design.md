# Design — workspace-create

## D1 · Command palette (`WorkspaceCommand.tsx`)

A centered overlay (like a spotlight), opened by ⌘K / rail "+ New" / switcher create. It is a single
control that does **two jobs** keyed off the query:

- **Switch mode** (default): the query filters existing workspaces (issue key / title / branch),
  grouped by repo, exactly like the rail. ↵ on a match switches to it.
- **Create mode**: a persistent "Create new workspace" region under the matches lists the **sources**.
  Selecting a source (or pressing ↵ when the query matches no workspace) routes to that source's
  resolve step. A source can be created with defaults (↵) or opened in the scope form first (⇥).

State lives in the store: `command: { open: boolean; query: string; sel: number } | null`. Keyboard:
↑/↓ move `sel` across the flattened list (workspaces then sources), ↵ activate, ⇥ open scope form for
the selected source, Esc close. Reuses BranchSwitcher's popover keyboarding patterns.

### Sources
| Source | Resolve | Seeds |
|---|---|---|
| **New branch** | type a branch name (or accept the default) | branch, base=repo default, title=branch leaf |
| **Describe** | free text → `claude_suggest` proposes `{branch, title, kickoff}` | branch+title from Claude; optional kickoff prompt to run the agent |
| **Clone** | pick/confirm | new branch = `<current>-copy`, base = current workspace's branch; copies preset/agent/scripts |
| **GitLab** | `glab` issue/MR search in the repo | title from issue/MR; branch from MR source-branch or built from issue |
| **Jira** | (inert until `jira-integration`) | shows "Connect Jira in settings" |

The Describe source uses the existing `claude_suggest` Rust path with a prompt that asks for a JSON
`{branch, title, kickoff?}`; if no key is set, it degrades to a plain "new branch" with a slugified
branch from the description.

## D2 · Scope form (`WorkspaceScopeForm.tsx`)

Renders the resolved source as a chip plus editable fields, mirroring Frame 3:

- **Source picker** tabs (Jira / GitLab / Branch / Describe / Clone) — switching re-runs resolve.
- **Branch** — text input, prefilled from `buildBranchName(...)` (D3), editable.
- **Base branch** — dropdown from `worktree`/`git_branches` of the repo, default = repo default.
- **Preset** — segmented `fix | feature | spike` (built-in defaults; `workspace-config` makes these
  editable + adds custom presets). The preset seeds pane layout, default agent, and a default script.
- **AI scope** — `✦ Claude·work | ✦ Claude·personal | ⛭ Aider | ○ None`. Maps to `Workspace.agent`.
- **Scripts** — dropdown of the repo's existing scripts (`scriptsForRoot`), or none.
- **Port offset** — number; default auto-assigned as `+10 × (count of open workspaces in this repo)`
  to avoid dev-server clashes. Exposed to the workspace as `AURORA_PORT_OFFSET` in its panes' env
  (see D5) — actual port remapping is the user's script's job; Aurora just provides the offset.
- **Two-way Jira sync** — toggle; disabled with a hint when Jira isn't connected.
- **Footer** — "Inherits `<repo>` · overrides N fields" where N counts fields differing from the
  preset/repo defaults; Cancel / Create workspace.

A `CreateSpec` object is assembled: `{ repoId, source, issueKey?, title, branch, baseBranch, preset,
agent, scriptName?, portOffset, jiraSync, kickoff? }`.

## D3 · Built-in branch naming (`lib/branchName.ts`)

Until `workspace-config` ships the configurable engine, a minimal builder:
- `slugify(s)` — lowercase, non-alphanumeric → `-`, collapse/trim dashes, cap 40 chars.
- `buildBranchName({ issueKey?, title })` — `issueKey ? `${key.toLowerCase()}/${slugify(title)}` :
  slugify(title)`.
- `validateBranchName(name)` — local sanity only (no spaces/`..`/leading-`-`/control chars), since
  the repo-validator integration is part of `workspace-config`. Returns `{ ok } | { ok:false, error }`.

## D4 · Creation orchestration (`lib/create.ts`, store `createWorkspace`)

1. Validate the branch name; surface inline errors in the form.
2. Compute the worktree dir: `<repoRoot>/../.aurora-worktrees/<repoName>/<branch-slug>` (sibling dir,
   never inside the repo, so it isn't itself tracked). Ensure uniqueness.
3. `worktree_add(root, dir, branch, base, new_branch=true)` (for Clone/existing-branch sources,
   `new_branch=false` when the branch already exists). On failure, surface the git error humanized
   (reuse `humanizeGitError`).
4. `store.createWorkspace(spec, dir)` — push a `Workspace` (status from agent; `agentBusy=false`),
   set its `tabs` to the preset's layout (1 / 2-split / 2×2 → that many panes in one group), set each
   pane's `cwd = dir`, mark it active.
5. `PaneArea` lazily spawns the panes' PTYs (existing behavior) at `dir`.
6. If a script was chosen, run it (`runScript`) once panes are ready.
7. If `kickoff` (Describe) or the preset's auto-start is set and agent is Claude, type the kickoff
   into the first pane / call the agent path. (Full agent auto-start is refined in `jira-integration`;
   here it at most pre-fills the first pane's input with the kickoff command.)
8. `jiraSync` is recorded on the workspace but only acted upon once `jira-integration` lands.

Rollback: if `worktree_add` succeeds but registration fails, attempt `worktree_remove(force)`.

## D5 · Port offset & env

The chosen `portOffset` is stored on the workspace and injected as `AURORA_PORT_OFFSET=<n>` into the
spawned shells (extend the pty spawn env, or `export` it via the zsh integration). Scripts/dev servers
that read it can offset their ports; Aurora does not itself rebind ports.

## D6 · Out of scope (later changes)
- Real Jira issue search, context loading, and two-way transition/MR-link posting → `jira-integration`.
- Configurable presets, the four branch-naming modes, and validate-branch-name pre-checks → `workspace-config`.
- The Changes view opened after creation → `workspace-changes`.
