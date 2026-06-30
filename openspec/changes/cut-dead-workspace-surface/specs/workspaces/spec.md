## MODIFIED Requirements

### Requirement: Durable workspace model above tabs and panes
Aurora SHALL represent each open line of work as a durable **Workspace** that owns a terminal layout
(its tabs of split panes) and carries per-branch metadata: an owning repo (or none, for a manual
lane), a title, an optional issue key, a branch, a base branch, a worktree directory, a preset, a diff
summary, an optional merge request, and a status. The existing tabs/panes structure SHALL become
**per-workspace** rather than top-level, so switching workspaces switches the entire tab layout. A
workspace SHALL persist across switches and across app restarts. The model SHALL NOT carry an agent
kind, an "agent busy" flag, or a "needs input" flag — no agent is spawned, so no agent state is
modeled until a real spawn is built.

#### Scenario: Tabs and panes belong to the active workspace
- **WHEN** the user creates a new tab or split pane
- **THEN** the tab/pane SHALL be added to the **active workspace's** layout, and SHALL not appear when another workspace is active

#### Scenario: Closing the last tab keeps the workspace
- **WHEN** the active workspace has a single tab with a single pane and the user closes it
- **THEN** the workspace SHALL remain and SHALL retain one fresh pane, rather than the workspace being destroyed

#### Scenario: No agent state on the model
- **WHEN** a workspace is created or restored from persistence
- **THEN** it SHALL NOT expose an agent kind, an "agent busy" flag, or a "needs input" flag

### Requirement: Workspace rail grouped by repo
Aurora SHALL provide a left **rail** listing all non-archived workspaces grouped under collapsible
repo headers (each showing the repo name and a workspace count). Each workspace card SHALL display a
status dot, the issue key (when present) and title, the branch, a short status line, and the diff
counts (added in the accent/dim color, removed in the error color). The card SHALL NOT display an
agent badge. The rail SHALL include a **filter** input whose placeholder reads "Filter…" and which
only filters the list (it does not create), a collapse control, and a "+ New workspace" affordance.
Clicking a workspace card SHALL make it the active workspace.

#### Scenario: Rail groups workspaces by repo
- **WHEN** two workspaces belong to repo `aurora` and one belongs to `billing-svc`
- **THEN** the rail SHALL show an `aurora` group with count 2 and a `billing-svc` group with count 1, each listing its workspaces

#### Scenario: Click a card to switch
- **WHEN** the user clicks a workspace card that is not active
- **THEN** that workspace SHALL become active and its tab layout SHALL replace the previous workspace's in the main column

#### Scenario: Filter the rail
- **WHEN** the user types text into the rail filter
- **THEN** only workspaces whose issue key, title, or branch match SHALL remain visible

#### Scenario: Card shows no agent badge
- **WHEN** a workspace card is rendered
- **THEN** it SHALL NOT show an agent badge or agent label

### Requirement: Workspace context bar
When the active workspace carries issue or preset metadata, Aurora SHALL render a context bar above
the tab strip summarizing it (branch, what it was seeded from, and the active preset). For a plain
manual workspace with no such metadata, the context bar SHALL be omitted. The context bar SHALL NOT
display an agent or agent scope.

#### Scenario: Context bar shows seed and preset
- **WHEN** the active workspace was seeded from issue PROJ-1423 with the `feature` preset
- **THEN** the context bar SHALL display the branch, "seeded from PROJ-1423", and the preset, and SHALL NOT display an agent

#### Scenario: Plain manual workspace omits the bar
- **WHEN** the active workspace has no issue key and no preset
- **THEN** the context bar SHALL be omitted

## REMOVED Requirements

### Requirement: Status dot reflects agent state, falling back to git
**Reason**: The agent-driven states (agent-working / needs-you) are unreachable — `agentBusy` /
`needsInput` are never set by any producer, so the dot only ever showed git state in practice. The
agent concept is removed in this change.
**Migration**: Replaced by "Status dot reflects git state" (below). `agentBusy` / `needsInput` and the
`alt-harness` state are removed from the model; `WsStatus` is reduced to `attention | idle`.

## ADDED Requirements

### Requirement: Status dot reflects git state
Each workspace SHALL show a single status dot reflecting git state only: **attention** (red) when the
worktree has a merge conflict or a failed pipeline, otherwise **idle** (faint). A workspace SHALL NOT
appear as an error merely for being a manual lane or for lacking an agent. The status line SHALL read
"manual branch" for a repo-less manual lane with a clean tree, and "idle" for a repo-backed workspace
with a clean tree.

#### Scenario: Manual lane is never "broken"
- **WHEN** a manual workspace (no repo) has uncommitted but non-conflicting changes
- **THEN** its status dot SHALL be idle (faint), not an attention/error color

#### Scenario: Conflict raises attention
- **WHEN** a workspace has a merge conflict in its worktree
- **THEN** its status dot SHALL be attention (red)

#### Scenario: Failed pipeline raises attention
- **WHEN** a workspace's pipeline state is "failed"
- **THEN** its status dot SHALL be attention (red)
