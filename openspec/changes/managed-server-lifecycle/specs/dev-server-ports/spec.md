## ADDED Requirements

### Requirement: Absolute per-workspace port contract
The system SHALL export `AURORA_PORT` into a workspace's run scripts, equal to the first port of a
range of 10 ports reserved for that workspace. Run scripts SHALL be able to bind their port directly
as `$AURORA_PORT` (no arithmetic). The system SHALL also export the workspace-context variables
`AURORA_WORKSPACE_NAME`, `AURORA_WORKSPACE_PATH`, `AURORA_ROOT_PATH`, `AURORA_DEFAULT_BRANCH`, and
`AURORA_IS_LOCAL`.

#### Scenario: A run script binds the absolute port
- **WHEN** a run script runs `dev -p $AURORA_PORT` in a workspace whose reserved range starts at 3010
- **THEN** the server SHALL bind port 3010, with no offset arithmetic in the command

#### Scenario: Workspace-context env is present
- **WHEN** a run script starts in a workspace
- **THEN** `AURORA_WORKSPACE_NAME`, `AURORA_WORKSPACE_PATH`, `AURORA_ROOT_PATH`, `AURORA_DEFAULT_BRANCH`, and `AURORA_IS_LOCAL` SHALL be set in its environment

### Requirement: Back-compatible offset export
During migration the system SHALL continue to export `AURORA_PORT_OFFSET` alongside `AURORA_PORT`,
such that `AURORA_PORT` equals a fixed base (`AURORA_PORT_BASE`, default 3000) plus
`AURORA_PORT_OFFSET`. A legacy script using `$((3000 + AURORA_PORT_OFFSET))` SHALL therefore resolve
to the same value as `$AURORA_PORT`.

#### Scenario: Legacy arithmetic still isolates
- **WHEN** an unmigrated script uses `$((3000 + AURORA_PORT_OFFSET))` in a workspace whose reserved range starts at 3020
- **THEN** it SHALL resolve to 3020, identical to `$AURORA_PORT`

### Requirement: Cross-repo port allocation, reservation, and reclamation
The system SHALL allocate a workspace's 10-port range as the lowest free range among ALL live
workspaces across ALL repos (not limited to the same repo), reserve it against Aurora's bookkeeping,
and reclaim it when the workspace is archived or torn down so it can be reused. Two live workspaces
SHALL NOT be allocated overlapping ranges.

#### Scenario: Two workspaces in different repos get distinct ranges
- **WHEN** two workspaces in two different repos are created with automatic allocation
- **THEN** they SHALL receive non-overlapping 10-port ranges

#### Scenario: A reclaimed range is reusable
- **WHEN** a workspace holding a range is archived/torn down and a new workspace is created
- **THEN** the freed range MAY be reused, but SHALL NOT be assigned while still held by a live workspace

### Requirement: Port-probing truth
After a managed run script starts, the system SHALL probe the actually-listening TCP port(s) owned
by that server's process group (via a macOS port-inspection tool such as `lsof`), and the server's
"up/down" badge SHALL reflect a real bound listening port — not a PTY/OSC heuristic. The system
SHALL surface the actual bound port number.

#### Scenario: Up reflects a bound port
- **WHEN** a managed run script has begun listening on a TCP port
- **THEN** the system SHALL badge it "up" only because a listening port owned by its process group was observed, and SHALL display that port number

#### Scenario: Not-yet-listening is not "up"
- **WHEN** a managed run script's process is alive but has not yet bound any port
- **THEN** the system SHALL NOT badge it "up" on process-liveness alone

### Requirement: Port collision detection
The system SHALL detect and loudly surface a collision when a managed server binds a port outside its
workspace's reserved range, or when two live workspaces' managed servers bind the same port. On Stop,
the system SHALL verify the reserved port(s) are freed and escalate to SIGKILL for any survivor
holding a port.

#### Scenario: Out-of-range bind is flagged
- **WHEN** a managed server binds a port outside its workspace's reserved 10-port range (e.g. a hardcoded `-p 3000`)
- **THEN** the system SHALL surface a collision indication (loud badge + notification), not a normal "up" badge

#### Scenario: Two workspaces on the same port is flagged
- **WHEN** two live workspaces' managed servers are observed bound to the same port
- **THEN** the system SHALL surface a collision for the conflicting servers

#### Scenario: Stop confirms the port is freed
- **WHEN** a managed server is stopped
- **THEN** the system SHALL verify its bound port is no longer listening, escalating to SIGKILL of its process group if a survivor still holds it

### Requirement: Generated dev scripts bind the absolute port
When the AI script generator proposes a run/dev command, the generated command SHALL bind the port as
`$AURORA_PORT` (absolute), not via offset arithmetic. This SHALL apply only when generation runs and
SHALL NOT rewrite hand-written scripts.

#### Scenario: Generator emits the absolute port form
- **WHEN** the generator proposes a dev server command
- **THEN** the generated command SHALL bind its port as `$AURORA_PORT` (e.g. `-p $AURORA_PORT`), not `$((<default> + AURORA_PORT_OFFSET))`
