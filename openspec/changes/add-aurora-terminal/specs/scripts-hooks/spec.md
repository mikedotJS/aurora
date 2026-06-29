## ADDED Requirements

### Requirement: Per-repo scripts persisted to config
The terminal SHALL let the user define named scripts scoped to a repo, persisted as JSON in the
app-config dir, and run one with `run <name>`.

#### Scenario: Run a saved script by name
- **WHEN** the user types `run <name>` for a script defined in the current repo
- **THEN** the script's commands SHALL execute in the pane's shell

#### Scenario: Scripts persist across relaunch
- **WHEN** the user defines a script and relaunches Aurora in the same repo
- **THEN** the script SHALL still be available to `run`

### Requirement: Scripts sheet and setup modal
The terminal SHALL provide a scripts sheet listing the current repo's scripts and a setup modal
to create/edit a script's name, description, commands, working directory, and a split-layout
toggle.

#### Scenario: Edit a script in the setup modal
- **WHEN** the user opens a script in the setup modal and changes its name, description, commands, or directory
- **THEN** the changes SHALL be saved to config and reflected in the scripts sheet

### Requirement: Split-layout script runs
When a script has the split toggle enabled, running it SHALL lay out its tasks across panes,
running each task in its own pane.

#### Scenario: A split script opens one pane per task
- **WHEN** the user runs a split-enabled script with multiple tasks
- **THEN** the tab SHALL split into panes and each task SHALL run in its own pane

### Requirement: onEnter hooks on repo entry
The terminal SHALL support an onEnter hook that fires once when a pane changes directory into a
repository root, running the configured script for that repo.

#### Scenario: Entering a repo fires its onEnter hook once
- **WHEN** a pane `cd`s into a repo root that has an onEnter script configured
- **THEN** that script SHALL run exactly once for that entry, and SHALL NOT re-fire while the pane stays within the repo
