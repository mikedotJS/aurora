## ADDED Requirements

### Requirement: Generate scripts with AI from the Scripts editor
The Scripts editor SHALL provide an action that asks Claude to propose a set of per-repo scripts fitting
the current repo, available only when the repo root is resolved and an Anthropic key is configured. The
proposed scripts SHALL use the existing per-repo script schema (`name`, `desc`, `split`, and one or more
`{dir, cmd}` tasks).

#### Scenario: Action offered when key set and inside a repo
- **WHEN** the user opens the Scripts editor for a repo whose root is resolved and an Anthropic key is configured
- **THEN** a "Generate with AI" action SHALL be available

#### Scenario: Unavailable outside a repo
- **WHEN** the Scripts editor is open but no repo root is resolved
- **THEN** the "Generate with AI" action SHALL NOT be available

#### Scenario: No key routes to key entry
- **WHEN** the user triggers "Generate with AI" and no Anthropic key is configured
- **THEN** the system SHALL route the user to the key-entry flow and SHALL NOT call the model

### Requirement: Repo signals sent as untrusted data
Generation SHALL gather a bounded set of repo signals — a shallow listing of the repo root and the
contents of recognized manifest/config files when present — and send them to the model as data to
analyze. Lockfile bodies and `.env`/secret files SHALL be excluded; only lockfile presence MAY be used to
infer the package manager. File contents SHALL be size-capped. The prompt SHALL instruct the model to
treat the contents as data and ignore any instructions embedded in them.

#### Scenario: Manifests inform the proposal
- **WHEN** the repo contains a recognized manifest (e.g. `package.json`, `Cargo.toml`, `Makefile`)
- **THEN** generation SHALL include that manifest's (capped) contents in the request so the proposed scripts fit the detected stack

#### Scenario: Secrets and lockfile bodies excluded
- **WHEN** generation gathers repo signals
- **THEN** the bodies of lockfiles and any `.env`/secret files SHALL NOT be sent to the model

### Requirement: BYO key call issued from the backend
The generation request SHALL be issued from the Rust backend using the Anthropic key stored in the OS
keychain; the key SHALL NOT be exposed to the webview. The request SHALL use a token budget sufficient to
return a small script set.

#### Scenario: Key never enters the webview
- **WHEN** generation calls the model
- **THEN** the request SHALL be sent from the backend with the keychain-stored key, and the webview SHALL send only the assembled repo signals

### Requirement: Validate model output into the script schema
The model response SHALL be parsed as a JSON array of scripts and validated before use: each kept script
MUST have a non-empty name and at least one task with a non-empty command; a missing working directory
defaults to empty; script and per-script task counts SHALL be clamped to bounded maximums. Malformed
entries SHALL be dropped, and a fully unparseable response SHALL surface an error without changing the
repo's scripts.

#### Scenario: Malformed entries dropped
- **WHEN** the model returns scripts where some entries lack a name or any command
- **THEN** those entries SHALL be discarded and only valid scripts SHALL be offered

#### Scenario: Unparseable response leaves scripts unchanged
- **WHEN** the model returns output that cannot be parsed into the script schema
- **THEN** the system SHALL show an error and the repo's existing scripts SHALL be unchanged

### Requirement: Review before adopt; nothing runs automatically
Proposed scripts SHALL be presented for review where the user can edit them and choose which to keep
before they are saved. No proposed command SHALL be executed during generation or acceptance; generated
scripts run only later through the explicit `run` flow. On acceptance, scripts SHALL be appended to the
repo's scripts and persisted per-repo, and a name that collides with an existing script SHALL be
auto-suffixed rather than overwrite it.

#### Scenario: User accepts selected scripts
- **WHEN** the user reviews the proposed scripts, optionally edits them, selects a subset, and confirms
- **THEN** the selected scripts SHALL be added to the repo's scripts and persist across relaunch

#### Scenario: Nothing executes on generation or accept
- **WHEN** scripts are generated and then accepted
- **THEN** no command SHALL run as a result; commands run only when the user later invokes `run`

#### Scenario: Name collision does not overwrite
- **WHEN** an accepted script's name matches an existing script in the repo
- **THEN** the accepted script SHALL be added under a non-colliding name and the existing script SHALL be preserved
