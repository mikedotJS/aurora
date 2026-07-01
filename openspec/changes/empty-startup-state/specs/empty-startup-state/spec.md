## ADDED Requirements

### Requirement: No default workspace is created on an empty startup
The system SHALL create zero workspaces and set the active workspace to none (`activeWs = null`) when
Aurora initializes with no repo context (the boot has no resolved repo) and no restored workspaces. The
system SHALL NOT synthesize a default "home" / manual lane rooted at the user's home directory.

#### Scenario: Fresh launch outside a repo with nothing restored
- **WHEN** `init` runs with no boot repo and an empty restored list
- **THEN** the store SHALL hold `workspaces = []` and `activeWs = null`, and no home lane SHALL exist

#### Scenario: The empty state persists across a relaunch
- **WHEN** the app has settled into the empty state and then boots again with still no repo context and
  nothing restored
- **THEN** it SHALL come back to `workspaces = []` and `activeWs = null` rather than materializing a
  default workspace

### Requirement: Launching inside a repository still opens that repository's workspace
When the boot resolves a repo context, the system SHALL open a workspace for that repo — reusing a
restored workspace already rooted at the repo's directory, otherwise creating one — and SHALL make it
active when no valid restored active workspace applies. A repo launch SHALL NOT land in the empty state.

#### Scenario: First launch inside a repo
- **WHEN** `init` runs with a boot repo and no restored workspace at that repo's root
- **THEN** the system SHALL create one workspace bound to that repo and set it active

#### Scenario: Relaunch inside a repo that already has a restored workspace at its root
- **WHEN** `init` runs with a boot repo and a restored workspace whose directory equals the repo root
- **THEN** the system SHALL reuse that restored workspace rather than create a duplicate

### Requirement: Restored workspaces are preserved without adding a default lane
When the boot has restored workspaces, the system SHALL keep exactly those workspaces and SHALL NOT add an
extra default lane alongside them. The active workspace SHALL be the persisted active workspace when it is
still present, otherwise the first restored workspace.

#### Scenario: Restored workspaces, launched outside any repo
- **WHEN** `init` runs with no boot repo and one or more restored workspaces
- **THEN** the resulting workspace set SHALL equal the restored set (no home lane added) and the active
  workspace SHALL be the persisted active one if present, else the first restored workspace

### Requirement: The app renders even when no workspace is active
The application SHALL distinguish "boot has not finished" from "boot finished with no workspace" using an
explicit initialized signal, and SHALL render its chrome once boot has finished even when there is no
active workspace. The application SHALL NOT gate rendering on the number of workspaces.

#### Scenario: Boot completes with zero workspaces
- **WHEN** `init` has completed and there are no workspaces
- **THEN** the app SHALL render its chrome (title bar, rail, status bar) instead of a blank screen

#### Scenario: Before boot completes
- **WHEN** `init` has not yet run
- **THEN** the app SHALL treat itself as not-ready and SHALL NOT attempt to render an active workspace

### Requirement: An empty-state surface invites the user to add a repository
When there is no active workspace, the content area SHALL show an empty-state surface — in place of the
workspace context bar, tab strip, and pane grid — that offers a primary action to **add a repository**.
When one or more repositories are already known, the surface SHALL also offer a secondary action to
**create a workspace**. The surface SHALL use the existing visual language (dark theme, green accents,
monospace, existing tokens) and SHALL NOT introduce a new dependency.

#### Scenario: Empty state with no repositories
- **WHEN** the app is in the empty state and no repositories are registered
- **THEN** the content area SHALL show the empty-state surface with an "Add repository" action and SHALL
  NOT render a tab strip or panes

#### Scenario: Empty state with repositories already added
- **WHEN** the app is in the empty state and at least one repository is registered
- **THEN** the empty-state surface SHALL additionally offer a "Create a workspace" action

#### Scenario: Add repository from the empty state
- **WHEN** the user triggers "Add repository" from the empty-state surface and picks a git repository
- **THEN** the repository SHALL be registered and appear in the rail, so the user can create its first
  workspace

### Requirement: Creating a workspace exits the empty state
When a workspace is created while the app is in the empty state, the system SHALL make that workspace the
active workspace and SHALL leave the empty state, rendering that workspace's tabs and panes.

#### Scenario: First workspace created from the empty state
- **WHEN** the app is in the empty state and the user creates a workspace (via the rail, the empty-state
  action, or the command palette)
- **THEN** the new workspace SHALL become active and the content area SHALL replace the empty-state
  surface with that workspace's tab strip and panes

### Requirement: Closing workspaces never drops to the empty state after startup
The system SHALL refuse to remove the last remaining workspace, so the empty state is reachable only from
an empty startup and never by closing workspaces during a session.

#### Scenario: Attempt to remove the last workspace
- **WHEN** exactly one workspace exists and a removal is requested
- **THEN** the system SHALL keep that workspace and SHALL NOT transition to the empty state
