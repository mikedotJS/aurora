## ADDED Requirements

### Requirement: A permanent Home terminal always exists
The system SHALL always provide exactly one **Home terminal** — a singleton terminal rooted at the user's home
directory — regardless of how many repositories or workspaces exist. The Home terminal SHALL have no repository,
no branch, no worktree, and no git binding (`repoId` is none). The system SHALL NOT allow creating a second Home
terminal.

#### Scenario: Home exists on a fresh contextless boot
- **WHEN** `init` runs with no repo context and nothing restored
- **THEN** exactly one Home terminal SHALL exist, rooted at the user's home directory, with no repository or
  branch

#### Scenario: Home exists alongside repositories and workspaces
- **WHEN** repositories and workspaces are present (created or restored)
- **THEN** exactly one Home terminal SHALL still exist in addition to them, and no second Home terminal SHALL be
  created

#### Scenario: Restored Home is reused, not duplicated
- **WHEN** `init` runs and a Home terminal was persisted from a previous session
- **THEN** the system SHALL reuse that persisted Home terminal and SHALL NOT create an additional one

### Requirement: The Home terminal behaves like a normal terminal in the home directory
The Home terminal SHALL provide the full terminal experience — tabs, split panes, and PTY-backed shells — with
its panes opening in the user's home directory. It SHALL NOT expose repository-scoped surfaces (servers,
scripts, merge requests, Jira, worktree/diff), because it has no repository.

#### Scenario: Panes open in the home directory
- **WHEN** the user activates the Home terminal and its panes spawn shells
- **THEN** each shell SHALL start in the user's home directory

#### Scenario: No repository surfaces on Home
- **WHEN** the Home terminal is active
- **THEN** repository-scoped actions (run servers, per-repo scripts, merge-request/Jira surfaces, worktree
  operations) SHALL NOT be offered for it

### Requirement: The app opens onto the Home terminal on a contextless boot
When Aurora initializes with no repository context and no valid restored active workspace, the system SHALL make
the Home terminal the active terminal so the application opens directly onto a live terminal. There SHALL always
be an active terminal after initialization; the content area SHALL always render an active terminal's tabs and
panes and SHALL NOT render a central empty-state pane.

#### Scenario: Fresh launch outside any repository
- **WHEN** `init` runs with no repo context and nothing restored
- **THEN** the Home terminal SHALL be the active terminal and its panes SHALL be shown, and the content area
  SHALL NOT show a central empty-state pane

#### Scenario: The content area never shows a central empty state
- **WHEN** the application has initialized
- **THEN** there SHALL be an active terminal and the content area SHALL render that terminal's tabs and panes,
  never a central "add a repository" empty pane

#### Scenario: Relaunch with a stale or missing persisted active workspace
- **WHEN** `init` runs with no repo context and the persisted active workspace no longer exists
- **THEN** the system SHALL fall back to making the Home terminal active rather than leaving no active terminal

### Requirement: A repository boot context takes focus over Home
When the boot resolves a repository context, the system SHALL make that repository's workspace the active
terminal, while still ensuring the Home terminal exists (present but not focused).

#### Scenario: Launch inside a repository
- **WHEN** `init` runs with a resolved repo context and no overriding valid restored active workspace
- **THEN** the repository's workspace SHALL be active AND the Home terminal SHALL still exist but not be active

#### Scenario: Restored active workspace wins over Home
- **WHEN** `init` runs and the persisted active workspace still exists
- **THEN** that persisted workspace SHALL be active (it MAY be the Home terminal or a repository workspace)

### Requirement: The Home terminal is a top-level TitleBar entry, excluded from the rail's repo and local groups
The Home terminal SHALL be rendered as a top-level entry in the application TitleBar, decoupled from the
Workspaces rail, and SHALL remain visible regardless of whether the rail is collapsed. The Home terminal SHALL
NOT appear in the workspace rail — neither inside any repository group nor inside the `local` bucket used for
repo-less manual workspaces.

#### Scenario: Home is a top-level TitleBar entry
- **WHEN** the TitleBar renders and a Home terminal exists
- **THEN** the Home terminal SHALL appear as a distinct entry in the TitleBar, independent of the rail, and
  SHALL stay visible even when the rail is collapsed

#### Scenario: Home is not listed in the rail
- **WHEN** the rail groups workspaces by repository and into the `local` bucket
- **THEN** the Home terminal SHALL NOT appear in the rail, in any repository group, nor in the `local` bucket

#### Scenario: Switching to and from Home
- **WHEN** the user selects the Home terminal entry, then selects a workspace, then the Home entry again
- **THEN** the active terminal SHALL follow each selection, and each selection's tabs and panes SHALL be shown

### Requirement: The rail owns the add-a-repository onboarding
When no workspaces exist besides the Home terminal, the rail SHALL present the onboarding affordance below the
pinned Home entry: a primary action to **add a repository**, and — when at least one repository is already
registered — a secondary action to **create a workspace**. This onboarding SHALL live in the rail, not in the
content/pane area. Because the Home terminal is always present and active, the user SHALL always have a live
terminal while this onboarding is shown.

#### Scenario: Onboarding shown when there are no non-Home workspaces
- **WHEN** the Home terminal is the only terminal (no repository workspaces and no manual workspaces exist)
- **THEN** the rail SHALL show, below the pinned Home entry, an "Add repository" action; the content area SHALL
  still render the Home terminal (not an empty pane)

#### Scenario: Create-a-workspace offered once repositories exist
- **WHEN** the rail onboarding is shown and at least one repository is registered
- **THEN** the rail SHALL additionally offer a "Create a workspace" action

#### Scenario: Add repository from the rail onboarding
- **WHEN** the user triggers "Add repository" from the rail onboarding and picks a git repository
- **THEN** the repository SHALL be registered and appear in the rail so the user can create its first workspace

### Requirement: The Home terminal is permanent and cannot be removed
The system SHALL refuse any request to remove or delete the Home terminal, from any surface. The Home terminal
SHALL NOT expose a delete/trash affordance, and SHALL NOT be convertible into a repository workspace.

#### Scenario: Remove request targeting Home is refused
- **WHEN** a removal is requested for the Home terminal
- **THEN** the system SHALL keep the Home terminal and SHALL make no change

#### Scenario: Teardown targeting Home is refused
- **WHEN** a teardown/delete is requested for the Home terminal
- **THEN** the system SHALL refuse before performing any worktree or PTY teardown, and the Home terminal SHALL
  remain

#### Scenario: No trash affordance on Home
- **WHEN** the Home terminal's rail entry is shown
- **THEN** it SHALL NOT present a delete/trash control

### Requirement: The Home terminal persists and restores across relaunches
The system SHALL persist the Home terminal's identity and tab layout metadata and restore it on the next launch,
consistently with how workspaces persist. As with all terminals, PTYs SHALL NOT survive a relaunch; the Home
terminal SHALL come back as a fresh terminal rooted at the home directory. Persisted data lacking the Home
marker (from before this change) SHALL load without error, and the Home terminal SHALL still be ensured.

#### Scenario: Home survives a relaunch
- **WHEN** the app is relaunched
- **THEN** the same Home terminal SHALL be present (reused, not duplicated), rooted at the home directory, with
  freshly spawned shells

#### Scenario: Legacy persisted data without the Home marker
- **WHEN** `init` loads persisted data written before the Home terminal existed
- **THEN** it SHALL load without error, existing entries SHALL be treated as ordinary workspaces, and a Home
  terminal SHALL be ensured to exist
