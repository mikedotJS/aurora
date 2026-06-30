## ADDED Requirements

### Requirement: Command palette switches and creates workspaces
Aurora SHALL provide a command palette, opened with ⌘K (and from the rail and switcher create
affordances), that both switches to an existing workspace and creates a new one. As the user types,
the palette SHALL filter existing workspaces (by issue key, title, or branch) for switching, and SHALL
always offer a "create new workspace" region listing the available sources. ↑/↓ SHALL move the
selection, ↵ SHALL activate it (switch to a matched workspace, or create from a source with defaults),
⇥ SHALL open the scope form for the selected source, and Esc SHALL close the palette.

#### Scenario: Filter to switch
- **WHEN** the user opens the palette and types text matching an existing workspace's title
- **THEN** that workspace SHALL be listed and pressing ↵ on it SHALL switch to it without creating anything

#### Scenario: Create with defaults
- **WHEN** the user selects a create source and presses ↵
- **THEN** Aurora SHALL create the workspace using inherited defaults without first showing the scope form

#### Scenario: Edit scope before creating
- **WHEN** the user selects a create source and presses ⇥
- **THEN** the scope form SHALL open prefilled for that source, and no workspace SHALL be created until the user confirms

### Requirement: Non-Jira creation sources
The palette SHALL support creating a workspace from each of these sources without requiring the Jira
integration: a **new branch** off a base branch; a **plain-language description** (which proposes a
branch name and an optional kickoff, via Claude when a key is present, degrading to a slugified branch
otherwise); a **clone** of the current workspace (a new branch and worktree based on the current
branch, inheriting its preset/agent/scripts); and a **GitLab** issue or merge request resolved via the
existing `glab` integration. A **Jira** source tab SHALL be present but, until the Jira integration is
configured, SHALL show a "connect Jira" state rather than failing.

#### Scenario: New branch off base
- **WHEN** the user creates from "new branch" with branch `spike/edge-cache` and base `main`
- **THEN** a worktree SHALL be created with branch `spike/edge-cache` checked out from `main`, and a workspace registered for it

#### Scenario: Describe without an API key
- **WHEN** no Anthropic key is set and the user describes "add retry to the webhook sender" via the Describe source
- **THEN** Aurora SHALL still create a workspace with a slugified branch derived from the description, rather than blocking on Claude

#### Scenario: Clone the current workspace
- **WHEN** the user clones the active workspace on branch `proj-1423/fix-auth-redirect`
- **THEN** a new worktree SHALL be created on a new branch based on that branch, inheriting the source workspace's preset and agent

#### Scenario: Jira source before connection
- **WHEN** Jira is not connected and the user selects the Jira source
- **THEN** the palette/scope form SHALL show a "connect Jira" state and SHALL NOT error

### Requirement: Scope form previews and overrides
Before creation, the scope form SHALL let the user review and override: the source, the branch name
(prefilled and editable), the base branch (defaulting to the repo default), the preset
(`fix`/`feature`/`spike`), the AI scope (Claude·work / Claude·personal / Aider / None), an optional
on-open script chosen from the repo's existing scripts, a port offset, and a two-way Jira-sync toggle.
The form SHALL summarize how many fields differ from the inherited defaults and SHALL disable the Jira
sync toggle (with a hint) when Jira is not connected.

#### Scenario: Default branch name prefilled
- **WHEN** the scope form opens for an issue-backed source with key PROJ-1423 and title "fix auth redirect"
- **THEN** the branch field SHALL be prefilled with a default such as `proj-1423/fix-auth-redirect` and remain editable

#### Scenario: Override count reflects changes
- **WHEN** the user changes the base branch and the preset away from the inherited defaults
- **THEN** the footer SHALL report that 2 fields are overridden

#### Scenario: Sync toggle gated on Jira
- **WHEN** Jira is not connected
- **THEN** the two-way Jira sync toggle SHALL be disabled with an explanatory hint

### Requirement: Worktree-backed creation flow
Creating a workspace SHALL validate the branch name, add a git worktree in a directory **outside** the
repository's tracked tree, checking out the new (or existing) branch from the chosen base, then
register a workspace whose panes open in that worktree directory according to the preset's pane layout,
run the chosen on-open script if any, and make the new workspace active. If the worktree is created but
registration fails, Aurora SHALL attempt to remove the orphaned worktree. Branch/worktree errors (e.g.
a name that already exists, or git refusing) SHALL be surfaced in plain language in the form.

#### Scenario: Panes match the preset layout
- **WHEN** a workspace is created with a preset whose layout is a 2-pane split
- **THEN** the new workspace SHALL open with two panes whose working directory is the new worktree

#### Scenario: On-open script runs
- **WHEN** a workspace is created with an on-open script selected
- **THEN** that script SHALL run once the workspace's panes are ready

#### Scenario: Branch collision surfaced
- **WHEN** the user tries to create a new branch whose name already exists
- **THEN** creation SHALL fail with a plain-language message and SHALL NOT leave an orphaned worktree

#### Scenario: New workspace becomes active
- **WHEN** creation succeeds
- **THEN** the new workspace SHALL become the active workspace and appear in the rail under its repo group
