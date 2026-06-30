## 1. Branch naming + validation (`src/lib/branchName.ts`)

- [x] 1.1 Add `slugify(s)` (lowercase, non-alphanumeric→`-`, collapse/trim, cap 40).
- [x] 1.2 Add `buildBranchName({ issueKey?, title })` → `key/slug` or `slug`.
- [x] 1.3 Add `validateBranchName(name)` → `{ ok } | { ok:false, error }` (no spaces/`..`/leading `-`/control chars).

## 2. Creation orchestration (`src/lib/create.ts` + store)

- [x] 2.1 Add store `command` UI state (`{ open, query, sel } | null`) and actions `openCommand`/`closeCommand`/`setCommandQuery`/`moveCommand`.
- [x] 2.2 Add store `createWorkspace(spec, dir)`: push a `Workspace` (status from agent), set `tabs` to the preset layout (1/2-split/2×2 panes in one group), each pane `cwd = dir`, mark active, persist.
- [x] 2.3 `lib/create.ts` `runCreate(spec)`: validate → compute sibling worktree dir (`<root>/../.aurora-worktrees/<repo>/<slug>`, unique) → `worktreeAdd` → `createWorkspace` → run on-open script → optional kickoff prefill. Rollback `worktreeRemove(force)` on registration failure; humanize git errors.
- [x] 2.4 Inject `AURORA_PORT_OFFSET` into the workspace's spawned shells (pty env or zsh export).

## 3. Sources

- [x] 3.1 New branch: branch text + base picker → spec.
- [x] 3.2 Describe: free text → `claudeSuggest` JSON `{branch,title,kickoff?}`; degrade to slugified branch when no key.
- [x] 3.3 Clone: new branch `<current>-copy` based on current branch; inherit preset/agent/scripts.
- [x] 3.4 GitLab: reuse `glab_mr_list` (and add issue search if needed) → resolve title + source branch.
- [x] 3.5 Jira: render an inert "connect Jira" state (wired by `jira-integration`).

## 4. UI

- [x] 4.1 `components/WorkspaceCommand.tsx`: centered palette; switch matches + create sources; ↑↓/↵/⇥/Esc; reuse popover styling.
- [x] 4.2 `components/WorkspaceScopeForm.tsx`: source tabs, resolved chip, branch input, base dropdown, preset segmented, AI-scope buttons, scripts dropdown, port-offset field, Jira-sync toggle (gated), override-count footer, Cancel/Create.
- [x] 4.3 Wire the rail "+ New workspace" and switcher create entry to `openCommand`.

## 5. Keymap

- [x] 5.1 `lib/keymap.ts`: bind ⌘K → `openCommand` (and route palette/form keys when open, like the other overlays).

## 6. Validation

- [ ] 6.1 Manually verify each spec scenario: filter-to-switch; create-with-defaults; ⇥-edit-scope; new branch; describe without key; clone; GitLab resolve; Jira inert; prefilled branch; override count; gated sync; preset pane layout; on-open script; branch collision surfaced + no orphan; new workspace active.
- [x] 6.2 `bun run lint`, `bun run build`, `cargo build` clean.
