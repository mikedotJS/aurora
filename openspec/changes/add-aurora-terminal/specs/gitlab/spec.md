## ADDED Requirements

### Requirement: Merge-request bottom sheet from real glab
The terminal SHALL show a merge-request bottom sheet populated from real `glab mr list
--output json`, with one card per MR (pipeline status dot, draft flag, approvals, thread count,
branch, updated time). When `glab` is missing or unauthenticated, the sheet SHALL degrade
gracefully with a clear "connect glab" state rather than erroring.

#### Scenario: Listing real MRs
- **WHEN** the user opens the MR sheet in a repo where `glab` is authenticated
- **THEN** the sheet SHALL list the repository's real merge requests as cards with pipeline, draft, approvals, threads, branch, and updated time

#### Scenario: glab missing or unauthenticated
- **WHEN** the MR sheet is opened but `glab` is absent or not logged in
- **THEN** the sheet SHALL show a graceful "connect glab" state and SHALL NOT crash

### Requirement: MR keyboard navigation and open in browser
The MR sheet SHALL be keyboard navigable (↑/↓ to move the selection) and SHALL open the
selected MR in the browser on ↵.

#### Scenario: Open the selected MR
- **WHEN** the user moves the selection with ↑/↓ and presses ↵
- **THEN** the selected merge request SHALL open in the default browser

### Requirement: Status-bar MR count
The status bar SHALL show a live count of open merge requests for the current repo, and
activating it SHALL open the MR sheet.

#### Scenario: MR count opens the sheet
- **WHEN** the status bar shows "N MRs" and the user activates it
- **THEN** the MR bottom sheet SHALL open

### Requirement: Notifications feed
The terminal SHALL poll `glab` for pipeline and comment events on visited repos and present
them as a toast stack (at most 3 visible, auto-dismissing), a history sheet, and an unseen
badge, with controls to mute a source and to enable Do Not Disturb.

#### Scenario: A pipeline event raises a toast
- **WHEN** polling detects a new pipeline or comment event on a visited repo
- **THEN** a toast SHALL appear (stack capped at 3, auto-dismissing) and the event SHALL be added to the history sheet with an unseen badge

#### Scenario: Do Not Disturb suppresses toasts
- **WHEN** Do Not Disturb is enabled (or the event's source is muted)
- **THEN** no toast SHALL be shown, though the event SHALL still be recorded in the history sheet
