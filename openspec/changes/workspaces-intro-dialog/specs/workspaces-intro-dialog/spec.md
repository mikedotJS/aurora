## ADDED Requirements

### Requirement: The workspaces intro is shown once on the first startup where it is unseen
On startup, after boot has completed, the system SHALL show the "Introducing Workspaces" dialog when the
persisted "intro seen" flag is absent or false, and SHALL NOT show it when the flag is true. The system
SHALL NOT gate the dialog on the application version; a single persisted boolean SHALL determine whether
it has been seen.

#### Scenario: First startup with the flag unseen
- **WHEN** the app finishes booting and the persisted intro-seen flag is absent or false
- **THEN** the "Introducing Workspaces" dialog SHALL be shown over the app content

#### Scenario: A later startup after the intro was seen
- **WHEN** the app finishes booting and the persisted intro-seen flag is true
- **THEN** the dialog SHALL NOT be shown

### Requirement: Every user sees the intro once, regardless of how they arrived at this release
The system SHALL show the intro exactly once to both users updating from a build without the workspaces
feature and users installing fresh, by defaulting the intro-seen flag to false whenever it is not
present in persisted state.

#### Scenario: Fresh install with no persisted settings
- **WHEN** the app boots with no persisted settings at all
- **THEN** the intro-seen flag SHALL default to false and the dialog SHALL be shown

#### Scenario: Update from a build whose persisted settings predate this flag
- **WHEN** the app boots with persisted settings that do not contain the intro-seen flag
- **THEN** the flag SHALL default to false without discarding the other persisted settings, and the
  dialog SHALL be shown

### Requirement: A single "Got it" action dismisses the intro and persists that it was seen
The dialog SHALL present exactly one primary action labeled "Got it". Triggering it SHALL set the
intro-seen flag to true, persist that flag, and close the dialog. Once dismissed, the intro SHALL NOT be
shown again on subsequent startups.

#### Scenario: Dismissing via the primary action
- **WHEN** the user triggers the "Got it" action
- **THEN** the intro-seen flag SHALL become true, SHALL be persisted, and the dialog SHALL close

#### Scenario: The intro stays dismissed across a relaunch
- **WHEN** the user has dismissed the intro and then relaunches the app
- **THEN** the dialog SHALL NOT be shown

### Requirement: Pressing Escape dismisses the intro equivalently to "Got it", and the backdrop does not
While the dialog is open, pressing Escape SHALL be equivalent to the "Got it" action — it SHALL persist
the intro-seen flag and close the dialog. Clicking the dialog's backdrop SHALL NOT dismiss the dialog, so
the one-time message cannot be consumed by an accidental click.

#### Scenario: Escape dismisses and persists
- **WHEN** the dialog is open and the user presses Escape
- **THEN** the intro-seen flag SHALL be persisted as true and the dialog SHALL close

#### Scenario: Escape works with no active workspace or pane
- **WHEN** the dialog is open on a first startup that has no active workspace or pane and the user
  presses Escape
- **THEN** the dialog SHALL still dismiss and persist, rather than being ignored

#### Scenario: Clicking the backdrop does not dismiss
- **WHEN** the dialog is open and the user clicks the backdrop outside the dialog panel
- **THEN** the dialog SHALL remain open and the intro-seen flag SHALL remain unchanged

### Requirement: The intro renders over the app content only after boot has completed
The system SHALL render the dialog above the app content — over the empty state or over an active
workspace — and only after boot has completed. Before boot completes, the dialog SHALL NOT be rendered.
After the dialog is dismissed, the user SHALL be left on whatever content is underneath.

#### Scenario: Shown over the empty state on a fresh install
- **WHEN** the app boots with no repository context and nothing restored, and the intro is unseen
- **THEN** the dialog SHALL be shown above the empty-state surface

#### Scenario: Shown over a restored workspace for an updater
- **WHEN** the app boots into a restored or repo-launched workspace and the intro is unseen
- **THEN** the dialog SHALL be shown above that workspace's content

#### Scenario: Not rendered before boot completes
- **WHEN** boot has not yet completed
- **THEN** the dialog SHALL NOT be rendered

#### Scenario: Landing surface after dismissal
- **WHEN** the user dismisses the dialog
- **THEN** the content underneath (the empty state or the active workspace) SHALL be shown with no
  further onboarding overlay

### Requirement: The intro is keyboard-modal while open
While the dialog is open, the system SHALL capture keyboard input so that application shortcuts and
prompt input do not act on the content behind the dialog. Keyboard focus SHALL move to the "Got it"
action when the dialog opens.

#### Scenario: Application shortcuts do not fire behind the dialog
- **WHEN** the dialog is open and the user presses an application shortcut such as the command-palette
  shortcut
- **THEN** that shortcut SHALL NOT take effect while the dialog is open

#### Scenario: Focus is placed on the primary action
- **WHEN** the dialog opens
- **THEN** keyboard focus SHALL be on the "Got it" action

### Requirement: The intro content is a designer-owned surface with a stable contract
The dialog SHALL present a title, two to three value propositions describing the workspaces feature, and
the single "Got it" action, using the existing visual language (dark theme, green accents, monospace,
existing tokens) and introducing no new dependency. The final copy and visual treatment SHALL be a design
surface that can change without altering the dismissal behavior.

#### Scenario: The dialog presents structured onboarding content
- **WHEN** the dialog is shown
- **THEN** it SHALL display a title, two to three workspaces value propositions, and a single "Got it"
  action

#### Scenario: Copy changes do not affect dismissal
- **WHEN** the content copy or visual is edited
- **THEN** the "Got it" and Escape dismissal behavior SHALL remain unchanged
