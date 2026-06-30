## ADDED Requirements

### Requirement: Durable workspace model above tabs and panes
Aurora SHALL represent each open line of work as a durable **Workspace** that owns a terminal layout
(its tabs of split panes) and carries per-branch metadata: an owning repo (or none, for a manual
lane), a title, an optional issue key, a branch, a base branch, a worktree directory, an agent kind,
a preset, a diff summary, an optional merge request, and a status. The existing tabs/panes structure
SHALL become **per-workspace** rather than top-level, so switching workspaces switches the entire tab
layout. A workspace SHALL persist across switches and across app restarts.

#### Scenario: Tabs and panes belong to the active workspace
- **WHEN** the user creates a new tab or split pane
- **THEN** the tab/pane SHALL be added to the **active workspace's** layout, and SHALL not appear when another workspace is active

#### Scenario: Closing the last tab keeps the workspace
- **WHEN** the active workspace has a single tab with a single pane and the user closes it
- **THEN** the workspace SHALL remain and SHALL retain one fresh pane, rather than the workspace being destroyed

### Requirement: Initial workspace on launch
On launch Aurora SHALL wrap the boot working directory in an initial workspace so the terminal is
usable immediately. When the boot directory is inside a git repository, the initial workspace SHALL
adopt that repo (name, root, default branch) and the currently checked-out branch, with its
directory being the existing checkout. When the boot directory is not in a repository, the initial
workspace SHALL be a manual lane with no repo and no agent.

#### Scenario: Boot inside a repo
- **WHEN** Aurora launches with the working directory inside a git repo on branch `main`
- **THEN** the initial workspace SHALL show that repo's name as its group, `main` as its branch, and SHALL be the active workspace

#### Scenario: Boot outside a repo
- **WHEN** Aurora launches in a directory that is not a git repository
- **THEN** the initial workspace SHALL be a manual lane (no repo group, agent = none) and the terminal SHALL behave as before

### Requirement: Worktree-backed isolation
Each repo-backed workspace SHALL correspond to a git **worktree** directory, so that distinct
workspaces can hold distinct branches checked out simultaneously. Aurora SHALL expose backend
operations to add, list, and remove worktrees, to summarize a worktree's diff against a base branch
(changed-file count and added/removed line counts, and whether the tree has conflicts), and to read
a repository's identity (root, name, default branch, current branch). Switching the active workspace
SHALL NOT stop the previously active workspace's running processes.

#### Scenario: Two workspaces hold different branches at once
- **WHEN** two workspaces of the same repo are open on different branches
- **THEN** each SHALL operate in its own worktree directory and neither SHALL require switching the other's branch

#### Scenario: Background processes survive a switch
- **WHEN** a long-running command is executing in workspace A and the user switches to workspace B
- **THEN** the command in A SHALL keep running, and returning to A SHALL show its continued output

### Requirement: Workspace rail grouped by repo
Aurora SHALL provide a left **rail** listing all non-archived workspaces grouped under collapsible
repo headers (each showing the repo name and a workspace count). Each workspace card SHALL display a
status dot, the issue key (when present) and title, an agent badge, the branch, a short status line,
and the diff counts (added in the accent/dim color, removed in the error color). The rail SHALL
include a filter/create input (hinted ⌘K), a collapse control, and a "+ New workspace" affordance.
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

### Requirement: Collapsed-rail switcher
When the rail is collapsed, Aurora SHALL show a workspace pill in the title bar that, when activated,
opens a grouped dropdown of workspaces mirroring the rail (repos as sections, the active workspace
highlighted, ⌘1–⌘9 shortcuts on the first entries). The dropdown SHALL allow filtering and
keyboard navigation (↑/↓ to move, ↵ to switch, Esc to close) and SHALL offer creating a new workspace.

#### Scenario: Switch from the collapsed switcher
- **WHEN** the rail is collapsed and the user opens the pill dropdown and presses ↵ on a workspace
- **THEN** that workspace SHALL become active and the dropdown SHALL close

#### Scenario: Numeric jump
- **WHEN** the switcher dropdown is open and the user presses ⌘2
- **THEN** the second listed workspace SHALL become active

### Requirement: Status dot reflects agent state, falling back to git
Each workspace SHALL show a single status dot whose meaning is: **agent-working** (cyan, pulsing)
when a Claude/agent harness is actively editing; **alt-harness** (magenta, pulsing) when a non-Claude
harness such as Aider is active; **needs-you** (amber) when the agent is paused for input or a review
is requested; otherwise it SHALL reflect git state — **attention** (red) when the worktree has a
merge conflict or a failed pipeline, else **idle** (faint). A manual workspace with no agent SHALL
NOT appear as an error merely for lacking an agent; its dot SHALL reflect git state only.

#### Scenario: Manual lane is never "broken"
- **WHEN** a manual workspace has uncommitted but non-conflicting changes and no agent attached
- **THEN** its status dot SHALL be idle (faint), not an attention/error color

#### Scenario: Agent activity overrides git state
- **WHEN** a workspace has an attached Claude agent that is actively editing
- **THEN** its status dot SHALL be agent-working (cyan, pulsing) regardless of the underlying git state

#### Scenario: Conflict raises attention
- **WHEN** a workspace with no attached agent has a merge conflict in its worktree
- **THEN** its status dot SHALL be attention (red)

### Requirement: Workspace context bar
When the active workspace carries issue/agent/preset metadata, Aurora SHALL render a context bar
above the tab strip summarizing it (branch, what it was seeded from, the agent and its scope, and the
active preset). For a plain manual workspace with no such metadata, the context bar SHALL be omitted.

#### Scenario: Context bar shows seed and agent
- **WHEN** the active workspace was seeded from issue PROJ-1423 with the Claude·work agent and the `feature` preset
- **THEN** the context bar SHALL display the branch, "seeded from PROJ-1423", the agent, and the preset

### Requirement: Persisted workspace list
Aurora SHALL persist the workspace list and per-repo metadata and restore it on launch. On restore,
a workspace whose worktree directory no longer exists SHALL be pruned from the list rather than shown
as broken. Restored workspaces SHALL NOT spawn terminal sessions until they are activated.

#### Scenario: Workspaces restored on relaunch
- **WHEN** the user has three workspaces open and relaunches Aurora
- **THEN** the rail SHALL again show those three workspaces (whose directories still exist), with the previously active one selected

#### Scenario: Stale workspace pruned
- **WHEN** a persisted workspace's worktree directory has been deleted outside Aurora and the app relaunches
- **THEN** that workspace SHALL be omitted from the rail
