## MODIFIED Requirements

### Requirement: Non-Jira creation sources
The palette SHALL support creating a workspace from each of these sources without requiring the Jira
integration: a **new branch** off a base branch; a **plain-language description** (which proposes a
branch name, via Claude when a key is present, degrading to a slugified branch otherwise); and a
**clone** of the current workspace (a new branch and worktree based on the current branch, inheriting
its preset/scripts). A **Jira** source tab SHALL be present but, until the Jira integration is
configured, SHALL show a "connect Jira" state rather than failing. There SHALL NOT be a GitLab create
source until one actually resolves a GitLab issue/MR via the `glab` integration — a label that only
slugifies text into a branch is not offered.

#### Scenario: New branch off base
- **WHEN** the user creates from "new branch" with branch `spike/edge-cache` and base `main`
- **THEN** a worktree SHALL be created with branch `spike/edge-cache` checked out from `main`, and a workspace registered for it

#### Scenario: Describe without an API key
- **WHEN** no Anthropic key is set and the user describes "add retry to the webhook sender" via the Describe source
- **THEN** Aurora SHALL still create a workspace with a slugified branch derived from the description, rather than blocking on Claude

#### Scenario: Clone the current workspace
- **WHEN** the user clones the active workspace on branch `proj-1423/fix-auth-redirect`
- **THEN** a new worktree SHALL be created on a new branch based on that branch, inheriting the source workspace's preset

#### Scenario: Jira source before connection
- **WHEN** Jira is not connected and the user selects the Jira source
- **THEN** the palette/scope form SHALL show a "connect Jira" state and SHALL NOT error

#### Scenario: No GitLab create source
- **WHEN** the create palette lists the available sources
- **THEN** it SHALL NOT offer a "GitLab issue or MR" create source

### Requirement: Scope form previews and overrides
Before creation, the scope form SHALL let the user review and override: the source, the branch name
(prefilled and editable), the base branch (defaulting to the repo default), the preset
(`fix`/`feature`/`spike`), an optional on-open script chosen from the repo's existing scripts, a port
offset, and a two-way Jira-sync toggle. The form SHALL summarize how many fields differ from the
inherited defaults and SHALL disable the Jira sync toggle (with a hint) when Jira is not connected.
The form SHALL NOT present an AI-scope / agent picker.

#### Scenario: Default branch name prefilled
- **WHEN** the scope form opens for an issue-backed source with key PROJ-1423 and title "fix auth redirect"
- **THEN** the branch field SHALL be prefilled with a default such as `proj-1423/fix-auth-redirect` and remain editable

#### Scenario: Override count reflects changes
- **WHEN** the user changes the base branch and the preset away from the inherited defaults
- **THEN** the footer SHALL report that 2 fields are overridden

#### Scenario: Sync toggle gated on Jira
- **WHEN** Jira is not connected
- **THEN** the two-way Jira sync toggle SHALL be disabled with an explanatory hint

#### Scenario: No AI-scope picker
- **WHEN** the scope form is open for any source
- **THEN** it SHALL NOT present an AI-scope / agent selection, and creation SHALL NOT seed a kickoff prompt
