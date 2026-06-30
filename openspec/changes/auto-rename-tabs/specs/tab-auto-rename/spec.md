## ADDED Requirements

### Requirement: Auto-name a tab from its long-running command(s)
When auto-rename is enabled and an Anthropic key is set, the system SHALL set a tab's name from the
command(s) running in its panes once they have been running past a short threshold (so quick commands
are not labelled), using a quick Haiku call. A tab MAY be split across several panes; the label SHALL
cover all of the tab's running panes together (e.g. "dev + tests"), not only the active pane. The tab's
displayed label SHALL prefer this name and otherwise fall back to the current cwd-based label.

#### Scenario: A long-running process names its tab
- **WHEN** a command keeps running in a tab's pane past the threshold (e.g. a dev server)
- **THEN** the system SHALL request a short label for it and set the tab's name to that label

#### Scenario: A split tab is named from all its panes
- **WHEN** a tab has multiple panes each running a long-running command (e.g. a dev server and a test watcher)
- **THEN** the rename request SHALL include all of the tab's running panes and the resulting label SHALL summarize them together

#### Scenario: Quick commands do not rename the tab
- **WHEN** a command finishes before the threshold (e.g. `ls`, `cd`)
- **THEN** no rename request SHALL be made and the tab's label SHALL be unchanged

#### Scenario: Fallback label when unnamed
- **WHEN** a tab has no auto-set name
- **THEN** the tab SHALL display its cwd-based label, exactly as before this feature

### Requirement: Quick, cheap, BYO-key call
The rename SHALL use the Haiku model via the keychain-backed Rust call path; the key SHALL NOT be exposed
to the webview. Requests SHALL be debounced and the resulting label cached per (tab, command) so the same
running command is not summarized more than once.

#### Scenario: Key stays in the backend
- **WHEN** the rename calls the model
- **THEN** the request SHALL be issued from the backend with the keychain-stored key, sending only the
  command and a short output snippet

#### Scenario: Same command is not re-summarized
- **WHEN** the same command is already labelled for a tab and the tab is revisited or re-rendered
- **THEN** the cached label SHALL be reused and no new model call SHALL be made

### Requirement: Untrusted input and sanitized output
The command line and any output snippet sent to the model SHALL be treated as data, not instructions, and
truncated. The returned label SHALL be sanitized to a single short line (control characters stripped,
whitespace collapsed, length-capped); a empty or unusable result SHALL leave the tab's current label
unchanged. No command SHALL be executed as part of naming.

#### Scenario: Output cannot drive behavior
- **WHEN** a running command's output contains text resembling instructions
- **THEN** it SHALL only ever be used to produce a sanitized label, and SHALL NOT cause any command to run

#### Scenario: Unusable label is ignored
- **WHEN** the model returns an empty or garbage label
- **THEN** the tab's existing label SHALL be kept

### Requirement: Disable via settings, degrade without a key
A settings toggle SHALL control auto-rename, defaulting to enabled. When the toggle is off, or when no
Anthropic key is configured, no rename request SHALL be made and tabs SHALL use the cwd-based label.

#### Scenario: Disabled in settings
- **WHEN** the auto-rename toggle is off
- **THEN** no model call SHALL be made and tab labels SHALL remain the cwd-based labels

#### Scenario: No key configured
- **WHEN** auto-rename is enabled but no Anthropic key is set
- **THEN** no model call SHALL be made and tab labels SHALL remain the cwd-based labels
