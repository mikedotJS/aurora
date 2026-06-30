## MODIFIED Requirements

### Requirement: Per-repo workspace settings panel
Aurora SHALL provide a Workspaces settings panel scoped to a repository, with sections for
Integrations (Jira project + GitLab repo, and a default two-way-sync toggle), AI accounts & harnesses,
Presets, and New-workspace defaults. There SHALL be no Lifecycle section while no teardown reads it.
Changes SHALL persist per repo (keyed by repo root) and SHALL take effect for subsequently created
workspaces.

#### Scenario: Settings persist per repo
- **WHEN** the user sets the default base branch to `develop` for repo `aurora` and reopens settings
- **THEN** `develop` SHALL still be shown as the default base branch for `aurora`

#### Scenario: New-workspace defaults applied on create
- **WHEN** the repo's default base branch is `develop` and the user creates a workspace without overriding the base
- **THEN** the new workspace's base branch SHALL be `develop`

### Requirement: Configurable presets
The settings panel SHALL let the user create, edit, and delete presets. Presets start empty for a
new repo — no built-ins are seeded. The user defines their own. A preset SHALL define: name, the
Jira issue types it auto-selects for, the pane layout (1 / 2-split / 2×2), an on-open script,
environment variables, a base-branch override, a port offset (auto or fixed), and a two-way
Jira-sync default. A preset SHALL NOT define an AI scope or a "start the agent on the ticket" flag.

On config migration (v4 → v5), all existing presets SHALL be preserved losslessly — they are NOT
re-seeded, filtered, or replaced. Only the dead per-preset fields (`agent`, `autoStart`) are stripped.

#### Scenario: User-defined preset stamps onto new workspaces
- **WHEN** the user creates a preset with a 2×2 pane layout and creates a workspace with that preset
- **THEN** the new workspace SHALL open with a 2×2 pane layout

#### Scenario: Issue-type auto-selects a preset
- **WHEN** a preset is configured to auto-select for Jira issue type "Bug" and a workspace is created from a Bug issue
- **THEN** that preset SHALL be pre-selected in the scope form

#### Scenario: Delete a preset
- **WHEN** the user deletes a custom preset
- **THEN** it SHALL no longer appear in the scope form's preset options

## REMOVED Requirements

### Requirement: New-workspace defaults and isolation
**Reason**: The auto-port-offset toggle and the isolation-mode control are dead — port offsets are
always allocated regardless of the flag, isolation is always worktree+env, and neither setting is read
by any logic. Container isolation is deferred.
**Migration**: Replaced by the reduced "New-workspace defaults" requirement (below). `defaults.autoPortOffset`
and `defaults.isolation` are dropped from `RepoConfig`; the config migration (`CONFIG_VERSION` → 5)
strips them from stored configs.

### Requirement: Lifecycle controls
**Reason**: `closeAction`, `pruneWorktreeOnMerge`, and `confirmDelete` are persisted but read by no
logic — there is no teardown or merge/prune path to gate. Keeping them promises behavior that never
happens.
**Migration**: The whole `repoConfig.lifecycle` object is dropped from `RepoConfig`; the config
migration (`CONFIG_VERSION` → 5) strips it from stored configs. Reintroduce when first-class teardown
ships (BUILD phase of the recovery roadmap).

## ADDED Requirements

### Requirement: New-workspace defaults
The settings panel SHALL configure new-workspace defaults limited to knobs that are actually wired:
the branch-naming source, the default base branch, the base port for per-workspace `PORT`
(`basePort`, 0 = off), and whether the rail shows on launch. It SHALL NOT present an auto-port-offset
toggle, an isolation-mode control, or any lifecycle control, because none of those are consumed.

#### Scenario: Default base branch applied
- **WHEN** the repo's default base branch is `develop` and a workspace is created without overriding the base
- **THEN** the new workspace's base branch SHALL be `develop`

#### Scenario: Base port injects PORT
- **WHEN** `basePort` is set to `4200` and a workspace is created with port offset `10`
- **THEN** the workspace's panes SHALL receive `PORT=4210` (base + offset)

#### Scenario: No dead knobs shown
- **WHEN** the New-workspace defaults section is rendered
- **THEN** it SHALL NOT present an auto-port-offset toggle, an isolation-mode control, or lifecycle controls
