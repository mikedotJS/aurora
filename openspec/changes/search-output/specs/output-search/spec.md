## ADDED Requirements

### Requirement: Open and close the find bar
Pressing ⌘F SHALL open a find bar for the active pane with its search field focused, and SHALL consume the keystroke so the webview's default find does not run. Pressing Esc while the find bar is open SHALL close it and clear all match highlighting. The find bar SHALL NOT be offered while a full-screen program owns the pane (xterm raw mode).

#### Scenario: Opening with ⌘F
- **WHEN** the user presses ⌘F in a pane
- **THEN** the find bar appears with its input focused and the webview's native find does not run

#### Scenario: Closing with Esc
- **WHEN** the find bar is open and the user presses Esc
- **THEN** the find bar closes and all match highlights are removed

### Requirement: Live search of the pane output
While the find bar is open, the system SHALL match the query against the active pane's command-block output as the user types, case-insensitively, and SHALL highlight every match in place while preserving the output's existing ANSI text styling. An empty query SHALL show no matches and no highlights.

#### Scenario: Highlighting matches as you type
- **WHEN** the user types a query that occurs in the output
- **THEN** every occurrence is highlighted in place and the surrounding text keeps its original colors

#### Scenario: No matches
- **WHEN** the query occurs nowhere in the output
- **THEN** no highlights are shown and the match counter reads zero (e.g. `0/0`)

#### Scenario: Empty query
- **WHEN** the find bar's query is empty
- **THEN** no matches are highlighted

### Requirement: Match count and navigation
The find bar SHALL display the current match position and total (e.g. `3/12`). The system SHALL designate one match as current, render it with a distinct active style, and scroll it into view. Pressing Enter or ↓ SHALL move to the next match and Shift-Enter or ↑ to the previous match, wrapping around at the ends. When the query changes, the current match SHALL reset to the first match.

#### Scenario: Counter reflects matches
- **WHEN** a query has matches
- **THEN** the find bar shows the current index and total, and the current match is styled distinctly from the others

#### Scenario: Next and previous with wrap-around
- **WHEN** the current match is the last one and the user presses Enter (next)
- **THEN** the selection wraps to the first match

#### Scenario: Current match scrolls into view
- **WHEN** the current match is outside the visible scroll area and becomes current
- **THEN** the pane scrolls so the current match is visible

#### Scenario: Query change resets to first match
- **WHEN** the user edits the query so the match set changes
- **THEN** the current match resets to the first match of the new set
