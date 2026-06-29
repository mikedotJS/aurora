## ADDED Requirements

### Requirement: Settings modal persisted to config
The terminal SHALL provide a settings modal — model picker (real model IDs), accent color
(re-themes the CSS-variable tokens), text size, ghost-autocomplete and suggest toggles,
notification toggles, and Do Not Disturb — with all settings persisted to config and applied
live.

#### Scenario: Changing a setting applies and persists
- **WHEN** the user changes the accent color, text size, or model in the settings modal
- **THEN** the change SHALL apply immediately and SHALL persist across relaunch

#### Scenario: Toggling prompt features
- **WHEN** the user disables the ghost-autocomplete or suggest toggle
- **THEN** the corresponding smart-prompt behavior SHALL stop until re-enabled

### Requirement: BYOK Anthropic key in the OS keychain
The user SHALL be able to enter an Anthropic API key via a masked key-entry mode (from `claude
auth`, the title-bar "add key" affordance, or settings); the key SHALL be stored in the OS
keychain via the `keyring` crate and SHALL never be written to the webview, localStorage, or
JS state.

#### Scenario: Storing a key
- **WHEN** the user enters a key via the masked key-entry mode
- **THEN** the key SHALL be saved to the OS keychain and SHALL NOT be exposed to the webview

#### Scenario: Connected indicator reflects key state
- **WHEN** a valid key is stored
- **THEN** the connected/BYOK dot SHALL reflect the connected state and the Claude suggestion path SHALL be unlocked

### Requirement: Claude auth CLI commands
The terminal SHALL provide `claude auth` (enter/replace the key), `claude status` (show whether
a key is configured), and `claude logout` (remove the key from the keychain).

#### Scenario: Checking and clearing auth
- **WHEN** the user runs `claude status` after configuring a key and then runs `claude logout`
- **THEN** `claude status` SHALL report the key as configured, and after `claude logout` the key SHALL be removed from the keychain
