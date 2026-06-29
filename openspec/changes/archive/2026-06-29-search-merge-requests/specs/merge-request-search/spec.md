## ADDED Requirements

### Requirement: Search the merge-request list
The MR sheet SHALL provide a text search field that filters the displayed merge requests as the user types, using a case-insensitive substring match against each merge request's title, source branch, author username, and `iid` (matched both as a bare number and with a leading `!`). Search SHALL filter the already-cached list client-side without issuing a new request per keystroke. The search field SHALL be auto-focused when the sheet opens, and its text SHALL reset each time the sheet is opened.

#### Scenario: Filtering by title substring
- **WHEN** the user types text into the search field that appears in a merge request's title
- **THEN** the list shows only merge requests whose title, branch, author, or iid contains that text (case-insensitive), and hides the rest

#### Scenario: Searching by MR number
- **WHEN** the user types `!42` or `42` into the search field
- **THEN** the merge request with iid 42 is shown

#### Scenario: No matches
- **WHEN** the search text matches no merge request
- **THEN** the sheet shows an empty-state message and pressing ↵ does nothing

#### Scenario: Search resets on reopen
- **WHEN** the user closes the sheet after typing search text and opens it again
- **THEN** the search field is empty and auto-focused, and the full cached list is shown

### Requirement: Filter to the current user's merge requests
The MR sheet SHALL provide a "mine" toggle that, when enabled, restricts the list to merge requests whose author equals the current GitLab user. The current user SHALL be resolved once via a `glab_current_user` backend command (backed by `glab api user`) and cached for the session. The "mine" filter SHALL compose with the search field (both conditions apply together). The toggle SHALL default to off when the sheet first opens.

#### Scenario: Enabling the mine filter
- **WHEN** the current GitLab user is known and the user enables the "mine" toggle
- **THEN** the list shows only merge requests whose author equals the current user's username

#### Scenario: Mine composes with search
- **WHEN** the "mine" toggle is enabled and the user also types search text
- **THEN** the list shows only the user's own merge requests that also match the search text

#### Scenario: Current user cannot be resolved
- **WHEN** glab is missing or unauthenticated so the current user is unknown
- **THEN** the "mine" toggle is shown disabled and forced off, and the search field still filters the cached list

### Requirement: Keyboard navigation operates on the filtered list
Selection and keyboard interaction in the MR sheet SHALL operate on the filtered list (after search and "mine" are applied). The selection index SHALL be clamped into the filtered list's bounds whenever the filter changes so it never points past the end. ↑/↓ SHALL move the selection within the filtered list, ↵ SHALL open the selected merge request in the browser, a shortcut SHALL toggle the "mine" filter, and esc SHALL close the sheet. Typing in the search field SHALL not be intercepted by navigation shortcuts.

#### Scenario: Arrows move within filtered results
- **WHEN** a filter is active and the user presses ↓ then ↑
- **THEN** the selection moves down then up within the filtered list only, never selecting a hidden merge request

#### Scenario: Selection clamped when the filter shrinks the list
- **WHEN** the selected index is beyond the end of the list after the filter narrows the results
- **THEN** the selection is clamped to the last visible merge request (or none when the list is empty)

#### Scenario: Opening the selected merge request
- **WHEN** the user presses ↵ with a merge request selected in the filtered list
- **THEN** that merge request opens in the browser

#### Scenario: Typing does not trigger navigation
- **WHEN** the search field is focused and the user types characters
- **THEN** the characters are entered into the search field and do not move the selection or close the sheet
