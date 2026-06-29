## ADDED Requirements

### Requirement: Real shell session per pane
Each pane SHALL own an independent real shell session: Rust spawns the user's `$SHELL`
(default `zsh`) on a `portable-pty` PTY, and the webview streams input/output/resize to it.
Real commands SHALL execute for real, with each pane keeping its own cwd, git branch, and
history.

#### Scenario: A real command runs in a pane
- **WHEN** the user types `ls` (or `cd`, `git status`, `npm -v`) in a pane and presses ↵
- **THEN** the command SHALL run in that pane's real shell and its actual output SHALL be displayed

#### Scenario: Each pane is independent
- **WHEN** the user `cd`s into a directory in one pane
- **THEN** that pane's cwd SHALL change without affecting any other pane's cwd, branch, or history

### Requirement: Tab management
The terminal SHALL support tabs: create, close, and select tabs; jump to a tab by index with
⌘1-9; cycle tabs with ⌃Tab; and **drag one tab onto another to merge** them into a split group.

#### Scenario: Open and close a tab
- **WHEN** the user presses ⌘T then ⌘W
- **THEN** a new tab SHALL open with its own shell session, and ⌘W SHALL close the active pane (closing the last pane closes the tab)

#### Scenario: Select a tab by index
- **WHEN** the user presses ⌘3 with at least three tabs open
- **THEN** the third tab SHALL become active

#### Scenario: Drag-to-merge tabs into a split
- **WHEN** the user drags one tab and drops it onto another tab
- **THEN** the two SHALL merge into a single tab containing both sessions as split panes

### Requirement: Split panes
A tab SHALL support up to 4 panes arranged as a 2×2 grid: ⌘D splits the focused pane to the
right, ⌘⇧D splits it down, and ⌥-arrow keys move focus between panes.

#### Scenario: Split and focus panes
- **WHEN** the user presses ⌘D (split right) and then ⌘⇧D (split down)
- **THEN** the tab SHALL show the panes laid out in a 2×2 grid, capped at 4 panes

#### Scenario: Move focus with the keyboard
- **WHEN** the user presses an ⌥-arrow key
- **THEN** focus SHALL move to the adjacent pane in that direction

### Requirement: Live cwd and git branch in the status bar
The status bar SHALL show the focused pane's live cwd (from OSC 7) and current git branch
(from `git` run in that cwd), updating as the user navigates and as branches change.

#### Scenario: Status bar tracks navigation
- **WHEN** the focused pane changes directory into a git repository
- **THEN** the status bar SHALL update to show the new cwd and the repository's current branch

### Requirement: Interactive-program fallback to xterm
The terminal SHALL fall back to `@xterm/xterm` for full-screen/interactive programs: when a
pane enters the alternate screen (DECSET 1049) for a program such as vim, top, less, or ssh, it
SHALL mount xterm bound to the same PTY for raw interaction, then unmount it and resume the
blocks view when the program exits.

#### Scenario: Running vim engages the fallback
- **WHEN** the user runs `vim` in a pane
- **THEN** the pane SHALL switch to the xterm renderer on the same PTY for raw interaction

#### Scenario: Quitting resumes blocks
- **WHEN** the interactive program exits and leaves the alternate screen
- **THEN** the pane SHALL unmount xterm and resume rendering output as Aurora blocks
