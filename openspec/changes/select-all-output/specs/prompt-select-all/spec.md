## ADDED Requirements

### Requirement: ⌘A selects the prompt input
When a pane's prompt is active, pressing ⌘A SHALL select the entire current prompt input of that pane and SHALL NOT select the pane's output/scrollback or any other part of the app. ⌘A SHALL always suppress the webview's native Select All (the keystroke is consumed) regardless of whether the input is empty. ⌘A SHALL NOT select the masked text while entering the API key.

#### Scenario: Selecting the typed command
- **WHEN** the user has typed a command in the prompt and presses ⌘A
- **THEN** the whole input is marked selected and the pane's output/scrollback is not selected

#### Scenario: Native select-all is suppressed
- **WHEN** the user presses ⌘A with an empty prompt
- **THEN** nothing in the output is selected and the webview's native Select All does not run

#### Scenario: Key entry is not selectable via ⌘A
- **WHEN** the user is entering the API key and presses ⌘A
- **THEN** the masked key is not selected

### Requirement: Selected input behaves like a text field
While the prompt input is selected, editing keys SHALL act on the whole selection: a printable character SHALL replace the entire input with that character, Backspace or Delete SHALL clear the input, and ⌘C SHALL copy the input text to the clipboard. Any change to the input text SHALL collapse the selection.

#### Scenario: Typing replaces the selection
- **WHEN** the input is selected and the user types a character
- **THEN** the input becomes just that character and the selection is collapsed

#### Scenario: Delete clears the selection
- **WHEN** the input is selected and the user presses Backspace or Delete
- **THEN** the input becomes empty

#### Scenario: Copy the selected input
- **WHEN** the input is selected and the user presses ⌘C
- **THEN** the current input text is written to the clipboard

### Requirement: Selection navigation and rendering
While the input is selected, the prompt SHALL render the input text with a visible selection highlight and SHALL hide the blinking caret and ghost-autocomplete. Pressing an arrow key SHALL collapse the selection without otherwise navigating on that same press.

#### Scenario: Selection is visually highlighted
- **WHEN** the input is selected
- **THEN** the typed text is shown with a selection highlight and no blinking caret or ghost suggestion is shown

#### Scenario: Arrow collapses the selection
- **WHEN** the input is selected and the user presses an arrow key
- **THEN** the selection is collapsed and the input text is unchanged
