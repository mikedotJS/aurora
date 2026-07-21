## ADDED Requirements

### Requirement: Committed typed repo config file `aurora.json`
The system SHALL persist a repo's scripts configuration in a committed file named `aurora.json` at
the repo root, encoded as JSON parseable by the platform's native `JSON.parse` (no third-party
parser). The file SHALL declare a typed model with an explicit `kind` for each script:
`scripts.setup`, `scripts.run.<id>`, and `scripts.archive`, plus `scripts.run_mode` of
`"concurrent"` or `"nonconcurrent"`. The file SHALL be read and written through the existing
filesystem commands and SHALL be safe to commit and share across a team.

#### Scenario: A repo config round-trips through the committed file
- **WHEN** a repo has an `aurora.json` declaring `scripts.setup`, one or more `scripts.run.<id>`, and `scripts.archive`
- **THEN** the system SHALL load that typed model on repo open, and writing an edited model back SHALL produce valid JSON at the repo root that reloads to the same model

#### Scenario: Config parses without any added dependency
- **WHEN** the system reads `aurora.json`
- **THEN** it SHALL parse the file using the platform-native JSON parser and SHALL NOT require a TOML or other third-party parser dependency

#### Scenario: A run script declares its identity, default, and menu presentation
- **WHEN** `scripts.run` contains multiple named entries and exactly one has `default: true`
- **THEN** each entry SHALL carry its `command`, `args`, and optional `cwd`/`icon`/`hide`, and the `default` entry SHALL be the one run by a bare Run action

### Requirement: Typed script model with explicit kind
The system SHALL represent every configured script with an explicit `kind` of `setup`, `run`, or
`archive`, replacing the untyped `Script`/`RepoScripts` model and the separate `Preset` scripts.
A `run` script SHALL be classified as a managed dev server by its declared `kind`, NOT inferred from
a text/regex scan of its command.

#### Scenario: A run server is identified by kind, not by command text
- **WHEN** a script has `kind: "run"` whose command contains no recognizable port flag
- **THEN** the system SHALL still treat it as a managed run server (spawnable, probeable, badgeable)

#### Scenario: setup and archive are singletons
- **WHEN** a config declares `scripts.setup` and `scripts.archive`
- **THEN** each SHALL be a single script (not a named collection) with `kind` `setup` and `archive` respectively

### Requirement: Migration from legacy localStorage models
The system SHALL offer to migrate legacy localStorage config into a committed `aurora.json` when a repo is opened that has legacy `userScripts` (scripts + `onEnter`) or `Preset` (`runOnOpen`/`env`/`envFiles`/`portOffset`) data but no committed `aurora.json`. The legacy `onEnter` hook SHALL map to `scripts.setup`; legacy port/run scripts SHALL map to `scripts.run.<id>`. Migration SHALL be lossless with respect to command text and SHALL NOT silently discard a configured script.

#### Scenario: onEnter migrates to setup
- **WHEN** a repo has a legacy `onEnter` command and no `aurora.json`
- **THEN** the offered migration SHALL place that command as `scripts.setup`

#### Scenario: Legacy run scripts migrate to named run entries
- **WHEN** a repo has legacy scripts marked as servers and no `aurora.json`
- **THEN** the offered migration SHALL create a `scripts.run.<id>` entry per server script, preserving each command

#### Scenario: An existing committed config is not overwritten by migration
- **WHEN** a repo already has an `aurora.json`
- **THEN** the system SHALL NOT run the legacy migration and SHALL NOT overwrite the committed file
