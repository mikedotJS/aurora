# Design — workspace-port-isolation

## Context

`create.ts` resolves a port offset per new workspace and bakes `AURORA_PORT_OFFSET=<n>` into the workspace
`env`, which `pty_spawn` (Rust) exports into the pane's shell. `allocOffset` **already** returns the lowest
unused multiple of the step (10) among the repo's live workspaces (a preset's fixed numeric offset is used
verbatim). There is no `archived` concept anymore — deleting a workspace removes it from the store, which
frees its offset slot automatically. The only current consumer of the offset is an opt-in
`PORT = basePort + offset` injection gated on a per-repo `basePort` (default 0 = off) — the knob this change
removes. The AI generator (`ai-generate-repo-scripts`) currently emits scripts with **no** port awareness.

The product promise is per-server, base-free isolation. A single `PORT` cannot express N servers; OS-level
interception is not viable on notarized macOS (see proposal Options C–E). So the engine is **generated
commands that each bind their own `default + $AURORA_PORT_OFFSET`**, and the offset is **displayed**.

## Goals / Non-Goals

**Goals**
- Two live workspaces never collide: each holds a distinct offset (already true; now specified).
- A generated dev/serve script is collision-free across workspaces **and across multiple servers in one
  workspace**, with no base port and no `$PORT` reliance.
- The allocated offset (and concrete derived ports where known) is **visible** in the UI for every
  workspace, not just issue/preset-seeded ones.
- No base-port knob anywhere.

**Non-Goals**
- Rewriting hand-written scripts, or any OS-level bind interception.
- Base-free `PORT` auto-injection for the mono-server case (Option B — deferred).
- Configurable step size (stays 10); remapping ports of existing workspaces; runtime port reassignment.

## Decisions

### D1 · Drop `basePort`; the offset is the only primitive
Remove `defaults.basePort` from `RepoConfig` and the `basePort`-gated `PORT` injection in `create.ts`.
`AURORA_PORT_OFFSET` is always exported; nothing derives a `PORT` automatically. Rationale: the knob was
rejected, and the single `PORT` it produced can't isolate multiple servers. `CONFIG_VERSION` bumps; the
migration strips `basePort` while preserving every other field (same lossless pattern as the v5 migration).
- *Alternatives:* keep `basePort` as opt-in (rejected — the knob is the thing being removed); auto-detect a
  base and inject `PORT` (Option B — deferred, still single-server).

### D2 · Collision-free allocation, formalized (no code change)
Spec the existing `allocOffset` behavior: for an `auto` offset, pick the smallest multiple of 10 not held by
any **live** workspace in the repo (parsed from each workspace's `env.AURORA_PORT_OFFSET`, malformed values
ignored); a preset's fixed numeric offset is used as-is. Deleting a workspace frees its slot. This is
already implemented (`create.ts:20-31`); the requirement locks the contract so a future refactor can't
regress it.

### D3 · Port-aware AI script generation (base-free, the multi-server engine)
Extend the `ai-generate-repo-scripts` `SYSTEM_PROMPT`: when a task starts a dev/serve command, bind a
per-workspace port by **adding `$AURORA_PORT_OFFSET` to that command's own real default port** — e.g.
`next dev --port $((3000 + AURORA_PORT_OFFSET))`, `nx serve api --port $((3333 + AURORA_PORT_OFFSET))`,
`vite --port $((5173 + AURORA_PORT_OFFSET))`. The model infers each command's default from the manifests
already in the repo signals (`package.json`, `nx.json`, `project.json`, vite config, …). Multiple servers
each name their own base, so one workspace running N servers gets N distinct, collision-free ports. For a
server that honors `$PORT`, the command may rely on `$PORT` instead. Prompt-only; the output is still parsed
through the existing validator (`parseScripts`) and never auto-run.
- *Why generation and not a deterministic rewriter:* a run-time regex rewrite would have to descend through
  `npm run dev` → package.json → underlying tool, know each tool's port flag, and split `concurrently`/
  `turbo`/`&&` orchestrators — brittle and surprising. The model reads the manifests once and emits explicit
  commands the user can see and edit.
- *Shell support:* scripts are sent to a real shell via the PTY (`scripts.ts` → `pty.write`), so `$((…))`
  arithmetic expansion and `$AURORA_PORT_OFFSET` (exported by `pty_spawn`) both work as written.

### D4 · Surface the allocated port in the UI (must-have under any mechanism)
The offset is currently invisible. Always show it. Two surfaces:
- **`WorkspaceContextBar`** (above the tab strip) — the primary "where's my server" home. Today it
  early-returns unless `issueKey || preset`; relax that so a plain workspace still renders the port. Show
  the offset (e.g. `+10`) and, **when derivable**, the concrete ports.
- **`WorkspaceCard`** (rail) — a compact offset chip on the status line.

**What can be shown honestly:** the offset is always known. Concrete `:port` numbers require a known base,
available from (a) the workspace's generated scripts — parse `$((<base> + AURORA_PORT_OFFSET))` to recover
`<base>` and render `<base>+offset`, labeled by script/task; or (b) a future injected `PORT`. Where no base
is known, show the offset alone (truthful) rather than inventing a number. Offset 0 (the first workspace)
means "default ports, no shift" — display the offset chip as `+0`/`default` so the convention is visible.
- *Open:* exact chip styling and whether to parse scripts for concrete ports in v1 or ship offset-only
  first — a **designer** hand-off (frontend-design).

### D5 · Values stay baked at create time
`AURORA_PORT_OFFSET` is computed once and persisted in the workspace `env` (restored + re-exported on
relaunch/respawn). Generated scripts embed their `$((…))` expression literally, so a running server's port
is stable across relaunches. Nothing retro-edits existing workspaces.

## Risks / Trade-offs

- **Not zero-config for hand-written scripts.** Stated plainly in the proposal: the engine is *generated*
  scripts; hand-written ones add one token (`$((<base> + AURORA_PORT_OFFSET))`). This is the honest ceiling
  on notarized macOS.
- **Model infers the wrong default port** → a still-distinct but unexpected port; the command is visible and
  editable, and the user adopts before anything runs.
- **Band overlap** — step 10 gives each workspace a 10-port band; a workspace running >10 servers (or a tool
  grabbing >10 sub-ports) could overlap a neighbor. Documented; revisit the step if it bites.
- **Display can only show concrete ports when a base is known** — otherwise it shows the offset only. We do
  not fabricate a port number we can't derive.

## Migration Plan

Additive + one removal. `CONFIG_VERSION` bumps; the migration strips `defaults.basePort` and preserves all
other fields (lossless, idempotent via the version gate). `create.ts` stops reading `basePort` and stops
injecting `PORT`; existing workspaces keep whatever `env` they already have (no `PORT` is removed from a
live workspace — it simply isn't added to new ones). The generator prompt change only affects newly
generated scripts. Rollback = restore the `basePort` field + injection and revert the prompt.

## Open Questions

- Ship Option B (base-free `PORT` auto-inject for mono-server) as a convenience, or stay offset-only?
- Display v1: offset chip only, or also parse generated scripts to show concrete `:port`s? (designer call)

## Inter-spec note

This change **supersedes the `basePort` field** that was retained in `cut-dead-workspace-surface`
(which stripped other dead knobs but left `basePort` in `RepoConfig.defaults` and in the migration).
`workspace-port-isolation` completes the removal: `defaults.basePort` is stripped from the type and
from `CONFIG_VERSION` v6 migration in `src/lib/repoConfig.ts`. The `workspace-port-injection` change
(which relied on `basePort`) has been removed from `openspec/changes/` and was never applied.
