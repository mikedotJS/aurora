## ADDED Requirements

### Requirement: React-owned prompt with ghost autocomplete
The input line SHALL be a React component (the shell's own prompt suppressed), and SHALL offer
a ghost (inline) autocomplete suggestion drawn from the pane's **real** command history, the
filesystem (readdir of the cwd), and subcommand tables. Tab or → SHALL accept the ghost.

#### Scenario: Ghost suggestion from history and filesystem
- **WHEN** the user types a prefix that matches a recent command or a path in the cwd
- **THEN** a dimmed ghost completion SHALL appear inline, and pressing Tab or → SHALL accept it

### Requirement: Command history navigation
The prompt SHALL let the user walk the pane's command history with ↑ and ↓.

#### Scenario: Recall a previous command
- **WHEN** the user presses ↑ in an empty prompt
- **THEN** the most recent command SHALL fill the input, and further ↑/↓ SHALL move through history

### Requirement: Typo-fix suggestion
When the typed command looks like a typo of a known command, the prompt SHALL surface a
correction card the user can accept to replace the input.

#### Scenario: Mistyped command offers a fix
- **WHEN** the user types a near-miss command such as `gti status`
- **THEN** a fix card SHALL suggest the corrected command (e.g. `git status`), and accepting it SHALL replace the input

### Requirement: Explicit natural-language to Claude command suggestion
The prompt SHALL turn natural-language input into a Claude command suggestion only when the user
explicitly asks — a line beginning with `?`, or pressing ⌘↵ on the current line — so ordinary
commands always run unhijacked. On an explicit ask it SHALL call Rust `claude_suggest(nl, cwd)`
and render an Aurora suggestion card with a command and a short note. ↵ SHALL run the suggested
command in the PTY, ⇥ SHALL move it into the input for editing, and esc SHALL dismiss it.

#### Scenario: Plain language yields a runnable command
- **WHEN** the user types `? undo my last commit` (or presses ⌘↵ on "undo my last commit") with a key configured
- **THEN** a suggestion card SHALL show a real Claude-suggested command, and ↵ SHALL run it in the pane's shell

#### Scenario: Ordinary commands are never intercepted
- **WHEN** the user runs a normal command that is not prefixed with `?` (e.g. `docker compose up`)
- **THEN** it SHALL execute in the shell directly and SHALL NOT be sent to Claude

#### Scenario: Editing or dismissing a suggestion
- **WHEN** a suggestion card is shown
- **THEN** ⇥ SHALL place the suggested command into the input for editing, and esc SHALL dismiss the card without running anything

### Requirement: Locked state when no API key
When no Anthropic key is configured, the Claude suggestion path SHALL be locked and SHALL route
the user to key entry rather than calling the API or failing silently.

#### Scenario: Suggestion attempted without a key
- **WHEN** the user makes an explicit Claude ask with no key configured
- **THEN** the prompt SHALL show a locked state that routes to the BYOK key-entry flow
