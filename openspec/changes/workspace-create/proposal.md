## Why

`workspaces-core` gives Aurora durable, worktree-backed workspaces and a rail to switch between them,
but the only workspace that exists is the boot one — there's no way to **create** a new line of work.
The mockup's Frames 2–3 make creation the centerpiece: a **⌘K palette** that both switches workspaces
and creates one from a source (a Jira issue, a GitLab issue/MR, a new branch, a plain-language
description, or a clone of the current workspace), and a **scope form** that previews exactly what
Aurora will make (branch, base, preset, agent, scripts, port offset, two-way Jira sync) while
inheriting repo defaults and overriding only what you change. This change wires creation end-to-end
on top of git worktrees, for every source that does not require the Jira integration.

## What Changes

- **⌘K palette** (`WorkspaceCommand`): a single overlay that **filters existing workspaces to switch**
  and, when the query doesn't match, offers to **create** from a source. ↵ creates with defaults, ⇥
  opens the scope form first, ↑/↓ navigate, Esc closes. Opens from ⌘K, the rail "+ New workspace", and
  the switcher's create entry.
- **Sources** (this change): **New branch** off a base; **Describe** (plain-language → Claude proposes
  a branch name + an optional kickoff prompt); **Clone** (fork the current workspace's branch into a
  new worktree); **GitLab issue/MR** (via the existing `glab`) → seeds title + branch. The **Jira**
  source tab is present but, until `jira-integration` lands, shows a "connect Jira" state.
- **Scope form** (`WorkspaceScopeForm`): source picker; resolved-source chip; editable branch (default
  from the repo's branch-naming default — a simple built-in until `workspace-config`); base-branch
  picker (defaults to repo default); preset selector (built-in `fix`/`feature`/`spike`); AI-scope
  selector (Claude·work / Claude·personal / Aider / None); scripts picker (from existing per-repo
  scripts); port-offset field; two-way Jira-sync toggle (disabled until Jira is connected). Footer
  reports "Inherits <repo> · overrides N fields".
- **Creation**: validate the branch name, `worktree_add` a new directory + branch off the base,
  register a `Workspace` (status seeded from the chosen agent), open panes per the preset's layout,
  run the chosen on-open script, optionally kick off the agent with seed context, and switch to it.

## Capabilities

### New Capabilities
- `workspace-create`: the ⌘K command palette (switch + create), the create scope form, the
  non-Jira creation sources (new branch / describe / clone / GitLab), and the worktree-backed
  creation flow that registers and activates the new workspace.

### Modified Capabilities
<!-- Extends the `workspaces` capability (workspaces-core) by adding the creation entry points and
     populating the model's branch/agent/preset/issue fields. Captured here as new requirements; the
     `workspaces` baseline is introduced by workspaces-core, not yet archived to openspec/specs/. -->

## Impact

- **Frontend (`src/`)**: new `components/WorkspaceCommand.tsx` (palette) and
  `components/WorkspaceScopeForm.tsx`; `lib/keymap.ts` gains the ⌘K binding; `lib/branchName.ts` with
  a built-in default branch-name builder (`{key}/{slug}` / slugify) — superseded by `workspace-config`;
  `lib/create.ts` orchestrates validate → worktree_add → register → panes → script → kickoff; store
  gains `createWorkspace(spec)` and command-palette UI state.
- **Backend (`src-tauri/`)**: reuses `worktree_add`/`worktree_remove`/`git_repo_info` from
  `workspaces-core`; reuses `glab` for the GitLab source; reuses `claude_suggest` for the Describe
  source's branch-name/kickoff proposal. No new Rust commands strictly required.
- **Depends on**: `workspaces-core`. **Soft-depends on**: `jira-integration` (Jira source/sync — the
  tab and toggle are present but inert until that change), `workspace-config` (richer presets +
  branch naming — built-in defaults are used until then).
