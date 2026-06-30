## ADDED Requirements

### Requirement: BYO Jira Cloud connection with token in the keychain
Aurora SHALL let the user connect a Jira Cloud account by providing a site URL, an email, and an API
token, validating the credentials before saving. The API token SHALL be stored in the OS keychain and
SHALL NOT be written to the config file or exposed to the webview; only the site and email (and a
per-repo default project key) SHALL be persisted in config. Aurora SHALL allow disconnecting (clearing
the token).

#### Scenario: Connect validates credentials
- **WHEN** the user enters a Jira site, email, and API token and confirms
- **THEN** Aurora SHALL validate them against Jira (the current-user endpoint) and only mark Jira connected on success

#### Scenario: Token never leaves the keychain
- **WHEN** Jira is connected
- **THEN** the API token SHALL be stored in the OS keychain and SHALL NOT appear in any persisted config file or be sent to the webview

#### Scenario: Disconnect clears the token
- **WHEN** the user disconnects Jira
- **THEN** the token SHALL be removed from the keychain and Jira SHALL report as not connected

### Requirement: Issue search and detail for the create flow
When connected, Aurora SHALL search Jira issues for the create palette — supporting a direct issue key,
free-text search, and a default "my sprint" query (issues assigned to the current user in open
sprints) — and SHALL fetch an issue's detail (summary, type, status, assignee, component(s), fix
version, sprint, description/acceptance criteria, and recent comments). When Jira is not connected,
these SHALL report a not-connected state rather than erroring.

#### Scenario: Search my sprint
- **WHEN** Jira is connected and the user opens the palette's Jira source with no query
- **THEN** Aurora SHALL list the current user's open-sprint issues, most-recently-updated first

#### Scenario: Direct key lookup
- **WHEN** the user types an issue key like PROJ-1423 in the Jira source
- **THEN** Aurora SHALL resolve that issue directly and show its summary and status

#### Scenario: Not connected degrades
- **WHEN** Jira is not connected and the Jira source is opened
- **THEN** Aurora SHALL show a connect-Jira state and SHALL NOT throw an error

### Requirement: Create a workspace from a Jira issue
When connected, selecting a Jira issue in the create flow SHALL derive a workspace plan — branch name
(from the configured branch-naming rule applied to the issue), base branch, preset (auto-selected from
the issue type), and agent — and on creation SHALL load the issue's context (summary, acceptance
criteria, and recent comments) into the workspace's Claude agent. The created workspace SHALL record
the issue key, status, and URL for display in the rail and context bar.

#### Scenario: Derived plan from issue
- **WHEN** the user selects a Bug issue PROJ-1423 "Login redirect drops the return URL"
- **THEN** the plan SHALL show a derived branch, a base, the `fix`-type preset auto-selected for Bugs, an agent, and that ticket context will go to Claude

#### Scenario: Context loaded into the agent
- **WHEN** a workspace is created from a Jira issue with a Claude agent
- **THEN** the issue's summary, acceptance criteria, and recent comments SHALL be provided to the agent as context

#### Scenario: Issue metadata on the card
- **WHEN** a workspace was created from PROJ-1423
- **THEN** its rail card and context bar SHALL show the issue key and current Jira status

### Requirement: Two-way Jira sync
When a workspace has two-way sync enabled, Aurora SHALL transition the issue to In Progress on
workspace creation, post the merge-request link to the issue when an MR for the branch is opened, and
transition the issue toward Done when that MR merges. Transitions SHALL be resolved by status name
against the issue's available transitions, SHALL be idempotent (not repeated), and SHALL be
best-effort — a Jira failure SHALL NOT block git or MR work. The done/in-progress status names SHALL be
configurable per repo.

#### Scenario: Move to In Progress on create
- **WHEN** a workspace with sync enabled is created from an issue in "To Do"
- **THEN** Aurora SHALL transition that issue to "In Progress"

#### Scenario: Post MR link on open
- **WHEN** a merge request is opened for a synced workspace's branch
- **THEN** Aurora SHALL add the MR's link to the issue exactly once

#### Scenario: Transition to Done on merge
- **WHEN** a synced workspace's merge request merges
- **THEN** Aurora SHALL transition the issue toward its Done status

#### Scenario: Jira failure does not block work
- **WHEN** sync is enabled but Jira is unreachable at create time
- **THEN** workspace creation SHALL still succeed and the sync action SHALL be reported as failed without blocking

### Requirement: Issue metadata feeds presets and branch naming
The issue type and component returned by the Jira integration SHALL be available to the preset
auto-select (issue type → preset) and to the branch-naming engine (`{type}` and component-derived
groups). When Jira is unconfigured, these inputs SHALL simply be absent and the non-Jira creation
sources SHALL continue to work.

#### Scenario: Component drives branch group
- **WHEN** an issue's component is "API" and the branch rule includes an app/component group
- **THEN** that group SHALL be populated from the issue's component
