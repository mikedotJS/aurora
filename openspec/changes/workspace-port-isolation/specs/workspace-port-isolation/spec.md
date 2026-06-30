## ADDED Requirements

### Requirement: Collision-free per-workspace port offset
When a workspace is created with an automatic offset, the system SHALL allocate the lowest unused multiple
of the step (10) among the repo's **live** workspaces, so no two live workspaces in a repo share an offset.
Deleting a workspace SHALL free its offset for reuse. A preset's explicit numeric offset SHALL be used as
given. The resolved offset SHALL be exported as `AURORA_PORT_OFFSET` into the workspace's pane shell.

#### Scenario: Two live workspaces get distinct offsets
- **WHEN** two workspaces are created in the same repo with automatic offsets
- **THEN** they SHALL receive different offsets (e.g. 0 and 10), each exported as `AURORA_PORT_OFFSET`

#### Scenario: A freed slot is reused, not duplicated
- **WHEN** a workspace holding an offset is deleted and a new workspace is created with an automatic offset
- **THEN** the new workspace MAY reuse the freed offset, but SHALL NOT take an offset still held by a live workspace

#### Scenario: Fixed offset is honored
- **WHEN** a preset specifies a fixed numeric offset
- **THEN** that exact offset SHALL be used for the workspace and exported as `AURORA_PORT_OFFSET`

### Requirement: No base port and no automatic PORT injection
The system SHALL NOT provide a per-repo base-port setting and SHALL NOT automatically derive or inject a
`PORT` environment variable from a base port. The offset (`AURORA_PORT_OFFSET`) SHALL be the only port
primitive the system exports. An explicit `PORT` set on a preset SHALL be passed through unchanged.

#### Scenario: No base-port setting exists
- **WHEN** a user opens a repo's settings
- **THEN** there SHALL be no base-port field, and no `PORT` SHALL be injected into a new workspace's shell by the system

#### Scenario: A preset's explicit PORT is preserved
- **WHEN** a preset's env sets `PORT`
- **THEN** the workspace shell SHALL export that exact `PORT`, and the system SHALL NOT overwrite or remove it

### Requirement: AI-generated dev/serve scripts bind a per-workspace port
When the AI script generator proposes a task that starts a dev/serve command, the generated command SHALL
bind a per-workspace port by adding `$AURORA_PORT_OFFSET` to that command's own real default port — so it
isolates per workspace without a base port and without relying on `$PORT`. When a repo runs multiple servers,
each generated server command SHALL bind its own default port plus the offset, so the servers do not collide
with each other. For a server that honors `$PORT`, the command MAY instead rely on `$PORT`. This SHALL apply
only when script generation runs (it SHALL NOT rewrite hand-written scripts), and the generated command SHALL
remain subject to the existing validation and SHALL never be auto-run.

#### Scenario: An Nx serve script binds an offset port
- **WHEN** the generator proposes a script that runs `nx serve <app>` (default port 4200)
- **THEN** the generated command SHALL bind a per-workspace port via the offset (e.g. `nx serve <app> --port $((4200 + AURORA_PORT_OFFSET))`)

#### Scenario: Multiple servers each get a distinct offset port
- **WHEN** the generator proposes scripts for two servers whose defaults are 3333 (api) and 4200 (web)
- **THEN** each generated command SHALL bind its own default plus the offset (e.g. `--port $((3333 + AURORA_PORT_OFFSET))` and `--port $((4200 + AURORA_PORT_OFFSET))`), so the two servers do not collide

#### Scenario: A $PORT-honoring server may rely on the env
- **WHEN** the generator proposes a script for a server that honors `$PORT` (e.g. `next dev`)
- **THEN** the generated command MAY rely on `$PORT` instead of an explicit offset expression

#### Scenario: Hand-written scripts are untouched
- **WHEN** a user has hand-written scripts and does not run generation
- **THEN** no command SHALL be rewritten by this feature

### Requirement: The allocated port is surfaced in the workspace UI
The system SHALL surface a workspace's allocated port offset in the UI, visible regardless of whether the
workspace has an issue key or a preset. When the concrete ports can be derived (e.g. from the workspace's
generated scripts or an explicit `PORT`), the system SHALL show those concrete ports; otherwise it SHALL show
the offset alone and SHALL NOT fabricate a port number.

#### Scenario: A plain workspace shows its port info
- **WHEN** a workspace has no issue key and no preset but has an allocated offset
- **THEN** the workspace UI SHALL still display its port offset

#### Scenario: Concrete ports shown when derivable
- **WHEN** a workspace's generated scripts bind ports via `$((<base> + AURORA_PORT_OFFSET))`
- **THEN** the UI MAY display the concrete derived ports (e.g. `api :3343 · web :4210`) for that workspace

#### Scenario: Offset only when no base is known
- **WHEN** no base port can be derived for a workspace
- **THEN** the UI SHALL show the offset alone and SHALL NOT display a fabricated port number

### Requirement: Port values are stable for the life of the workspace
The allocated `AURORA_PORT_OFFSET` SHALL be fixed at workspace creation and SHALL persist across relaunches
and pane respawns. The offset expressions embedded in generated scripts SHALL keep producing the same ports
for a given workspace.

#### Scenario: Offset survives relaunch
- **WHEN** a workspace is relaunched
- **THEN** the same `AURORA_PORT_OFFSET` SHALL be exported into its shell

#### Scenario: A generated server keeps its port across relaunch
- **WHEN** a workspace runs a generated dev/serve script before and after a relaunch
- **THEN** the server SHALL bind the same per-workspace port both times
