## ADDED Requirements

### Requirement: Reusable project-context engine
The system SHALL provide a reusable project-context engine that resolves the repo root for a working
directory and assembles a typed, bounded bundle of deterministic signals about the project, together
with a function that renders that bundle into a compact text block for prompt injection. The engine
SHALL be independent of the suggestion flow so other features can consume it, and it SHALL NOT execute
any project command to gather signals.

#### Scenario: Root resolved from the working directory
- **WHEN** the engine gathers context for a working directory inside a git repo
- **THEN** it SHALL resolve the repo root (the main worktree root when available) and assemble the bundle relative to that root

#### Scenario: Signals gathered without running project commands
- **WHEN** the engine gathers context
- **THEN** all signals SHALL be derived from reading files and git state only, and no build/dev/test command SHALL be executed

### Requirement: Detect the repo toolchain
The engine SHALL detect the package manager, the monorepo runner (if any), and whether the repo uses
workspaces, from the filesystem. The package manager SHALL be taken from the root `package.json`
`packageManager` field when present, otherwise inferred from lockfile presence. Detection SHALL read
lockfile presence and small config files only, never lockfile bodies or `.env`/secret files.

#### Scenario: packageManager field is authoritative
- **WHEN** the root `package.json` declares a `packageManager` field (e.g. `pnpm@9.0.0`)
- **THEN** the detected package manager SHALL be that one, taking precedence over lockfile inference

#### Scenario: Package manager from lockfile presence
- **WHEN** there is no `packageManager` field and exactly one recognized lockfile is present (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, or `package-lock.json`)
- **THEN** the detected package manager SHALL be the one that lockfile implies

#### Scenario: Runner and workspaces detected
- **WHEN** the repo root contains `nx.json` (or `turbo.json`, or `lerna.json`) and/or declares workspaces (a `workspaces` field or a `pnpm-workspace.yaml`)
- **THEN** the bundle SHALL record the corresponding runner (nx, turbo, or lerna) and that the repo uses workspaces

### Requirement: Surface real scripts and project targets
The engine SHALL collect real command names from the repo so the model does not invent them: the names
of the root `package.json` `scripts`, and — for a workspace/monorepo repo — the names and declared
targets of its projects, read from each project's `project.json` (its `name` and `targets` keys) or its
`package.json` `name`. These collections SHALL be capped in count.

#### Scenario: Root script names collected
- **WHEN** the root `package.json` defines a `scripts` object
- **THEN** the bundle SHALL include those script names (up to the cap) so suggestions reference real scripts

#### Scenario: Workspace project targets collected
- **WHEN** the repo is a workspace/monorepo and its packages declare `project.json` files
- **THEN** the bundle SHALL include each project's name and its declared target names (up to the caps), enumerated from those files without running the runner

### Requirement: Include current git state
The engine SHALL include the current git branch and the set of changed files (path and status) for the
repo, using the existing git bridges, with the changed-file list capped and accompanied by the total
count so a caller can indicate truncation.

#### Scenario: Branch and changed files reported
- **WHEN** the working directory is inside a git repo with local changes
- **THEN** the bundle SHALL include the current branch and a capped list of changed files with their status, plus the total changed-file count

### Requirement: Inject project context into the suggestion prompt
When a non-empty context is available, the explicit Claude command-suggestion request SHALL include the
rendered context block so the model's system prompt is made aware of the toolchain, real script/target
names, and git state. The injected guidance SHALL instruct the model to use the detected package manager
(and not a different one), to prefer the detected monorepo runner for project targets (including running
multiple targets through the runner rather than chaining separate `npm run` invocations), and to
reference only scripts and targets that appear in the context rather than inventing them. The injected
content SHALL be the deterministic detection result, preserving the existing untrusted-data posture.

#### Scenario: pnpm + nx repo yields a matching command with real names
- **WHEN** the user makes an explicit Claude ask in a repo detected as pnpm + nx with known projects
- **THEN** the suggestion request SHALL carry the project context, and the suggested command SHALL use pnpm and nx with real project/target names rather than plain `npm` with invented script names

#### Scenario: Multiple targets use the runner, not chained npm scripts
- **WHEN** the user asks to run two project targets in a repo with a detected monorepo runner
- **THEN** the injected guidance SHALL direct the model to use the runner (e.g. `nx run-many`) instead of chaining `npm run a & npm run b`

### Requirement: Bound the injected context within a token budget
The rendered context block SHALL stay within a bounded size: each signal SHALL be individually capped
and the assembled block SHALL respect an overall character budget, truncating with a marker when
content exceeds it, so that a large repository cannot cause the suggestion prompt to grow without bound.

#### Scenario: Large monorepo is truncated, not unbounded
- **WHEN** the repo has more scripts, projects, or changed files than the caps allow
- **THEN** the rendered block SHALL include only up to the caps / character budget and SHALL indicate that content was truncated

### Requirement: Graceful degradation and no untrusted bodies
The suggestion path SHALL degrade cleanly when signals are missing or detection fails, and SHALL never
send arbitrary file bodies or secrets. When no JS/TS project is detected, or the directory is not a git
repo, or detection fails, the request SHALL omit the corresponding signal (or all context) and behave as
it did before this change rather than failing. Terminal scrollback/output, and README/Makefile/CI file
bodies, SHALL NOT be included.

#### Scenario: Non-JS repo omits toolchain and command signals
- **WHEN** the user makes an explicit Claude ask in a repo with no lockfile and no `package.json` (e.g. a Rust or Go repo)
- **THEN** no toolchain, scripts, or projects section SHALL be added, and the suggestion SHALL be produced as before

#### Scenario: Non-git directory omits git state
- **WHEN** the working directory is not inside a git repo
- **THEN** the context SHALL omit the git branch and changed-files section and still assemble any available filesystem signals

#### Scenario: Detection failure degrades gracefully
- **WHEN** context gathering cannot complete (e.g. the root cannot be resolved or files cannot be read)
- **THEN** the suggestion request SHALL still be made without context rather than failing

#### Scenario: No untrusted file bodies or secrets sent
- **WHEN** the context is assembled
- **THEN** it SHALL contain only detection results and git-derived names, and SHALL NOT include lockfile bodies, `.env`/secret file contents, terminal output, or README/Makefile/CI bodies
