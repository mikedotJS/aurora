## ADDED Requirements

### Requirement: Changes view as a pane view mode
Each pane SHALL support two view modes — **Terminal** (the scrollback and prompt) and **Changes** (the
diff viewer) — defaulting to Terminal. A control in the tab strip and the ⌥⌘D shortcut SHALL toggle the
active pane between the two modes. Switching to Changes SHALL NOT stop the pane's underlying shell
session, and switching back SHALL show its live output.

#### Scenario: Toggle a pane to Changes and back
- **WHEN** the active pane is in Terminal mode and the user presses ⌥⌘D
- **THEN** the pane SHALL show the Changes view, and pressing ⌥⌘D again SHALL return to the live terminal with its session intact

#### Scenario: Split shows terminal and diff together
- **WHEN** a workspace has two panes and only one is switched to Changes
- **THEN** that pane SHALL show the diff while the other continues to show the terminal

### Requirement: Changed-files list against the base branch
The Changes view SHALL list the workspace's changed files computed against its **base branch**,
grouped into **Staged** and **Changes (unstaged)** sections. Each row SHALL show the file's status
(added/modified/deleted/renamed), its path and directory, and its added/removed line counts. Selecting
a file SHALL show that file's diff in the diff pane. A summary SHALL report the total file count and
total ±lines.

#### Scenario: Files grouped by staged state
- **WHEN** one file is staged and two are modified but unstaged
- **THEN** the list SHALL show the staged file under "Staged" and the two others under "Changes", each with its status letter and ±counts

#### Scenario: Select a file to view its diff
- **WHEN** the user clicks a modified file in the list
- **THEN** the diff pane SHALL render that file's diff

#### Scenario: Summary reflects totals
- **WHEN** the workspace has 5 changed files totaling +97 −47 against its base
- **THEN** the Changes view SHALL display a summary of "5 files · +97 −47"

### Requirement: Unified and split diff rendering
The diff pane SHALL render a selected file in either a **unified** view (a single column with hunk
headers, old and new line numbers, and +/− line coloring) or a **split** view (two columns: the base
branch on the left and the working tree on the right, with removed lines tinted on the left, added
lines tinted on the right, blank padding where one side has no corresponding line, and line numbers per
side). A per-file toggle SHALL switch between Unified and Split, and the split columns SHALL scroll in
sync.

#### Scenario: Unified view colorizes changes
- **WHEN** a file with additions and removals is shown in Unified view
- **THEN** removed lines SHALL be tinted with the error color and added lines with the addition color, each with their line numbers and the hunk header shown

#### Scenario: Split view aligns base and working tree
- **WHEN** the user toggles a file to Split view
- **THEN** the base content SHALL appear on the left and the working-tree content on the right, with removed/added lines aligned and padded, and scrolling one column SHALL scroll the other

### Requirement: Stage, discard, and stage all
The Changes view SHALL let the user stage or unstage an individual file, discard an individual file's
changes, and stage all files. Discarding SHALL require confirmation because it is destructive. After
any stage/unstage/discard the changed-files list and counts SHALL refresh.

#### Scenario: Stage a single file
- **WHEN** the user stages an unstaged modified file
- **THEN** that file SHALL move to the Staged section and the lists SHALL refresh

#### Scenario: Discard confirms first
- **WHEN** the user discards a file's changes
- **THEN** Aurora SHALL ask for confirmation before reverting, and only on confirmation SHALL the file's working-tree changes be reverted

#### Scenario: Stage all
- **WHEN** the user clicks "Stage all"
- **THEN** all changed files SHALL be staged and the list SHALL show them under Staged

### Requirement: Open MR handoff
The Changes view SHALL provide an "Open MR" action for the workspace's branch that hands off to the
existing GitLab integration: if a merge request already exists for the branch it SHALL be opened,
otherwise one SHALL be created for the branch. The workspace's MR state SHALL be updated to reflect the
result. When GitLab/`glab` is unavailable, the action SHALL degrade gracefully rather than error.

#### Scenario: Open an existing MR
- **WHEN** the workspace's branch already has an open merge request and the user clicks "Open MR"
- **THEN** that merge request SHALL be opened and the workspace's MR state reflected

#### Scenario: Create when none exists
- **WHEN** no merge request exists for the branch and the user clicks "Open MR"
- **THEN** Aurora SHALL initiate creating one for the branch via the GitLab integration

### Requirement: Three entry points into Changes
Opening the Changes view SHALL be possible from three places, all targeting the relevant workspace's
active pane: clicking a workspace card's ±diff counts in the rail; the Terminal↔Changes view toggle in
the tab strip; and the status-bar change counter (and the ⌘G shortcut). Opening from the rail counts
SHALL first switch to that workspace.

#### Scenario: Open from the rail counts
- **WHEN** the user clicks the "+128 −34" counts on a non-active workspace's rail card
- **THEN** Aurora SHALL switch to that workspace and show its Changes view

#### Scenario: Open from the status bar
- **WHEN** the user clicks the status-bar change counter (or presses ⌘G) for the active workspace
- **THEN** the active pane SHALL switch to the Changes view
