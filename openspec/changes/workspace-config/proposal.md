## Why

The foundation (`workspaces-core` + `workspace-create`) ships with **built-in** presets
(`fix`/`feature`/`spike`) and a single hard-coded branch-name pattern (`{key}/{slug}`). The mockup's
Frames 5–10 make both of these **configurable per repo**, so a team's conventions are encoded once
and stamped onto every new workspace: a **Workspaces settings** panel (integrations, AI accounts &
harnesses, presets, new-workspace defaults, lifecycle), a **Preset editor** (define agent, auto-start,
pane layout, on-open script, env vars, base override, port-offset, Jira sync), and — the subtle part —
**branch naming with four modes**: a custom token template, a pattern bound to `package.json`, a rule
**inferred from an existing `validate-branch-name`/husky validator**, and an **AI instruction** that
lets Claude name branches with the output still checked against the validator. The point of the
validator-aware modes is that a workspace's branch can never fail the repo's pre-push hook.

## What Changes

- **Workspaces settings panel** (Frame 5): per-repo configuration —
  - **Integrations**: Jira (project key, connection) and GitLab (repo URL, connection); a
    "two-way sync by default" toggle. (Jira connection itself is `jira-integration`; this surfaces it.)
  - **AI accounts & harnesses**: list Claude·work / Claude·personal accounts and Aider-style harnesses,
    mark a default, add/remove.
  - **Presets**: list/add/edit/delete presets.
  - **New-workspace defaults**: branch-naming source, default base branch, auto port offsets,
    isolation (worktree / worktree+env / container), show-rail-on-launch.
  - **Lifecycle**: prune worktree on merge, close action (archive/delete), confirm-before-delete.
- **Preset editor** (Frame 6): name, auto-select issue types, AI scope, start-agent-on-ticket, pane
  layout (1 / 2-split / 2×2), run-on-open script, environment variables, base override, port offset,
  two-way Jira sync. Saved presets replace the built-ins used by `workspace-create`.
- **Branch-naming engine** (Frames 7–10) with four sources:
  - **Manual template**: tokens `{key} {type} {slug} {assignee} {sprint} {yy-mm}` with a live preview;
    rules — lowercase, spaces→`-`, slug trimmed to 40, unknown tokens dropped.
  - **package.json-bound**: read a pattern from a configured field (e.g. `aurora.branchPattern`),
    shown as read-only and re-read when the file changes.
  - **validate-branch-name-inferred**: detect an existing `validate-branch-name` regex (package.json /
    husky / commitlint), parse it into ordered groups (enums → pickers, free → slug), and generate
    names guaranteed to pass it.
  - **AI instruction**: a plain-English rule Claude applies per issue; output is **chained through the
    validator** and Claude retries until it passes.

## Capabilities

### New Capabilities
- `workspace-presets`: the Workspaces settings panel (integrations surface, AI accounts/harnesses,
  presets list, new-workspace defaults, lifecycle) and the preset editor; persisted per repo and
  consumed by `workspace-create`.
- `branch-naming`: the four-mode branch-naming engine (manual template, package.json-bound,
  validate-branch-name-inferred, AI instruction) with live preview and validator-chained generation.

### Modified Capabilities
<!-- Supersedes the built-in presets and the minimal `lib/branchName.ts` from `workspace-create`:
     `workspace-create`'s scope form reads presets and the configured branch-naming source from here.
     Captured as new requirements; `workspace-create` is not yet a baseline spec under openspec/specs/. -->

## Impact

- **Frontend (`src/`)**: new `components/WorkspaceSettings.tsx` (panel) and `components/PresetEditor.tsx`;
  `lib/presets.ts` (per-repo preset CRUD + persistence) and `lib/branchNaming.ts` (the four-mode
  engine, replacing the built-in `lib/branchName.ts`); the create scope form binds to these.
- **Backend (`src-tauri/`)**: `git.rs`/new `repoconfig.rs` to read `package.json` fields and detect a
  `validate-branch-name`/husky regex; a `validate_branch_name(dir, name)` command that runs the repo's
  actual validator when present; reuse `claude_suggest` for the AI-instruction mode (validator-checked).
- **Config**: per-repo settings (presets, defaults, lifecycle, branch-naming source) persisted under
  the app-config dir keyed by repo root; package.json-bound patterns live in the repo (team-shared).
- **Depends on**: `workspaces-core`, `workspace-create`. **Relates to**: `jira-integration` (the
  Integrations section surfaces Jira's connection; issue-type→preset auto-select uses Jira issue types).
- **Status**: PROPOSED in this pass; implemented after the foundation lands.
