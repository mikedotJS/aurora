## ADDED Requirements

### Requirement: Per-repo workspace settings panel
Aurora SHALL provide a Workspaces settings panel scoped to a repository, with sections for
Integrations (Jira project + GitLab repo, and a default two-way-sync toggle), AI accounts & harnesses,
Presets, New-workspace defaults, and Lifecycle. Changes SHALL persist per repo (keyed by repo root) and
SHALL take effect for subsequently created workspaces.

#### Scenario: Settings persist per repo
- **WHEN** the user sets the default base branch to `develop` for repo `aurora` and reopens settings
- **THEN** `develop` SHALL still be shown as the default base branch for `aurora`

#### Scenario: New-workspace defaults applied on create
- **WHEN** the repo's default base branch is `develop` and the user creates a workspace without overriding the base
- **THEN** the new workspace's base branch SHALL be `develop`

### Requirement: AI accounts and harnesses
The settings panel SHALL list configured AI accounts/harnesses (e.g. Claude·work, Claude·personal, and
Aider-style harnesses), allow marking one as the default, and allow adding or removing them. Secret
credentials SHALL be stored in the OS keychain (not in the config file); the panel SHALL show only
non-secret identifiers (kind, scope, a key hint, default flag).

#### Scenario: Set a default account
- **WHEN** the user marks Claude·personal as the default account
- **THEN** newly created workspaces whose preset does not override the agent SHALL default to Claude·personal

#### Scenario: Secrets stay in the keychain
- **WHEN** an AI account is added with an API key
- **THEN** the key SHALL be stored in the OS keychain and SHALL NOT appear in the persisted config file

### Requirement: Configurable presets replace the built-ins
The settings panel SHALL let the user create, edit, and delete presets, and these SHALL replace the
built-in `fix`/`feature`/`spike` presets used by workspace creation. On first opening a repo's settings,
the built-ins SHALL be seeded as editable presets. A preset SHALL define: name, the Jira issue types it
auto-selects for, the AI scope, whether to start the agent on the ticket, the pane layout (1 / 2-split /
2×2), an on-open script, environment variables, a base-branch override, a port offset (auto or fixed),
and a two-way Jira-sync default.

#### Scenario: Edited preset stamps onto new workspaces
- **WHEN** the user edits the `feature` preset to use a 2×2 pane layout and creates a workspace with that preset
- **THEN** the new workspace SHALL open with a 2×2 pane layout

#### Scenario: Issue-type auto-selects a preset
- **WHEN** a preset is configured to auto-select for Jira issue type "Bug" and a workspace is created from a Bug issue
- **THEN** that preset SHALL be pre-selected in the scope form

#### Scenario: Delete a preset
- **WHEN** the user deletes a custom preset
- **THEN** it SHALL no longer appear in the scope form's preset options

### Requirement: New-workspace defaults and isolation
The settings panel SHALL configure new-workspace defaults: the branch-naming source, the default base
branch, whether port offsets are auto-assigned, the isolation mode (worktree / worktree+env /
container), and whether the rail shows on launch. Isolation modes not yet implemented SHALL be
selectable but clearly marked as unavailable rather than silently doing nothing.

#### Scenario: Auto port offsets
- **WHEN** auto port offsets are enabled and a second workspace is created in a repo
- **THEN** that workspace SHALL receive a non-zero port offset distinct from the first

#### Scenario: Unimplemented isolation marked
- **WHEN** the user selects the "container" isolation mode while only worktree isolation is implemented
- **THEN** the panel SHALL indicate it is not yet available rather than appearing to apply it

### Requirement: Lifecycle controls
The settings panel SHALL configure workspace lifecycle: pruning a workspace's worktree (and branch)
when its merge request merges, the action taken when closing a workspace (archive or delete), and
whether to confirm before deleting (especially with uncommitted changes).

#### Scenario: Confirm before deleting dirty workspace
- **WHEN** confirm-before-delete is on and the user closes a workspace with uncommitted changes
- **THEN** Aurora SHALL warn about the uncommitted changes before deleting

#### Scenario: Prune on merge
- **WHEN** prune-on-merge is enabled and a workspace's MR merges
- **THEN** Aurora SHALL offer to remove that workspace's worktree and branch
