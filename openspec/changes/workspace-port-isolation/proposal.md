## Why

Aurora's promise: *open a repo's workspace, run a script, and every server the script launches isolates
itself by port — whether there's 1 or 10. No base-port, no knob to tune.* Today that promise is broken in
two ways:

1. **Nothing consumes the offset.** Each workspace already gets a collision-free `AURORA_PORT_OFFSET`
   (`create.ts` → `allocOffset`, exported into the pane shell by `pty_spawn`), but **no command reads it**.
   Two workspaces running the same `pnpm dev` still collide on the same port. The only built-in consumer is
   an **opt-in** `PORT = basePort + offset` injection gated on a per-repo `basePort` (off by default) — i.e.
   the user must set a knob *and* their server must honor `$PORT`.
2. **The allocated port is invisible.** The offset is baked into the workspace env but shown nowhere — no
   card chip, no context bar. Even when isolation works, the user can't tell which port their server is on.

This change reframes the feature around the actual promise and **drops the `basePort` knob** (explicitly
rejected) in favour of a base-free mechanism that scales to N servers, plus a systematic port display.

> **Supersedes `workspace-port-injection`** (0/10, never applied). That change was built around the
> `basePort` knob and a single `PORT` — both rejected here. Its one genuinely useful piece (collision-free
> allocation) is **already in the current code**, so it is formalized as a requirement here rather than
> re-implemented. The old change should be removed (see scope questions).

## What Changes

Recommended mechanism (**Option A** below): port-aware AI script generation on top of the always-present
collision-free offset, plus a mandatory port display. No base port anywhere.

- **Drop the `basePort` knob.** Remove `defaults.basePort` from `RepoConfig` and the `basePort`-gated
  `PORT` injection in `create.ts`. Bump `CONFIG_VERSION` and migrate the field out. Aurora no longer
  assumes or asks for a base port.
- **Keep + formalize collision-free allocation.** `allocOffset` already hands the lowest unused multiple of
  the step (10) among the repo's **live** workspaces (deleting a workspace frees its slot; a preset's fixed
  numeric offset is honored verbatim). This behavior is captured as a spec requirement — no code change.
- **Port-aware AI script generation (the multi-server engine).** Extend the `ai-generate-repo-scripts`
  system prompt so every dev/serve task binds a per-workspace port by **adding `$AURORA_PORT_OFFSET` to that
  command's own real default port** — e.g. `next dev --port $((3000 + AURORA_PORT_OFFSET))`,
  `nx serve api --port $((3333 + AURORA_PORT_OFFSET))`, `nx serve web --port $((4200 + AURORA_PORT_OFFSET))`.
  Because each command names its *own* base, a single workspace running N servers gets N distinct,
  collision-free ports with no base port and no `$PORT` reliance. Prompt-only; output stays validated and
  is never auto-run.
- **Systematic port display (the papercut).** Surface the workspace's allocated offset — and the concrete
  derived ports where they can be known — in the UI, regardless of whether the workspace has an issue or a
  preset. The context bar above the tab strip is the primary home; the rail card carries a compact chip.

## Options & tradeoffs

The hard truth up front: **a single `PORT` env var can only express one port, so it cannot isolate N
servers** (`api:3333` + `web:4200` simultaneously). Truly 100%-transparent multi-server isolation — where
the user edits *nothing* — is **not realistically achievable** on a notarized macOS app without `sudo`,
fighting SIP, or per-tool shims (see Options C–E). So the honest goal is: zero-config for **generated**
scripts, and a one-token convention (`$AURORA_PORT_OFFSET`) for hand-written ones. The collision-free
offset is the shared primitive under every option.

### Option A — Port-aware script generation + offset convention  ·  **RECOMMENDED**
The AI generator emits commands that bind `realDefault + $AURORA_PORT_OFFSET` per server. Each command
names its own base, so N servers in one workspace each get a distinct port. Hand-written scripts opt in by
writing `--port $((3000 + AURORA_PORT_OFFSET))` themselves.
- **Pros:** Genuinely solves **multi-server** (workspace offset 10 → `api:3343`, `web:4210`). No base port.
  Works for servers that ignore `$PORT` (Nx `serve`, Vite). The generated command is **visible and
  editable** — the user sees exactly what isolates the port. Builds on an existing, kept capability. Shell
  arithmetic `$((…))` already expands (scripts run in a real zsh/bash via the PTY).
- **Cons / honesty:** **Zero-config only for AI-generated (or adopted) scripts.** A script the user typed by
  hand isn't rewritten — they add the `$((…))` themselves (minimal cooperation, one token). The base port
  is inferred by the model from the repo's manifests; a wrong inference yields a wrong-but-still-distinct
  port the user can fix.

### Option B — Base-free `PORT` auto-injection for the mono-server case
Detect the repo's real default port from manifests at create time (Next→3000, etc.) and auto-export
`PORT = default + offset` — no `basePort` knob. A lone `next dev` then shifts per workspace with truly zero
config.
- **Pros:** Real zero-config for the **single** `$PORT`-honoring server — the most common toy case.
- **Cons / honesty:** This is the **rejected single-`PORT` approach** with the knob auto-detected away. It
  **cannot express two servers**, and it **does nothing** for servers that ignore `$PORT` (Vite, Nx `serve`,
  `ng serve`). Detection is per-app and unreliable in monorepos. It papers over the easy case while the
  hard case (multi-server) still needs Option A — so it adds a second, partial code path for little gain.
  **Recommendation: defer** (offer later as a convenience toggle if users ask), not in the recommended
  tasks.

### Option C — Transparent interception (shim / env preload)
Intercept the bind at the OS level so unmodified servers land on a shifted port.
- **C1 `DYLD_INSERT_LIBRARIES`** (macOS LD_PRELOAD analogue) to hook `bind()`/`listen()`: **rejected.** SIP
  strips `DYLD_*` for protected/hardened binaries, Node is often launched via wrappers, and it breaks under
  codesigning/notarization — which Aurora ships with. Fragile and security-sensitive; a non-starter.
- **C2 PATH shims** (a dir of `node`/`next`/`vite`/`nx` wrappers that inject `--port` before exec): less
  invasive but still needs a wrapper per tool, breaks on absolute-path invocation, drifts with versions,
  and **still can't pick ports for multi-server without parsing args** — i.e. it reinvents Option A's
  problem with worse ergonomics and silent surprise. **Rejected** as primary; not worth the maintenance.

### Option D/E — Reverse proxy / loopback-alias IP per workspace
Give each workspace its own loopback IP (`127.0.0.2`, …) or a routing proxy so two servers can both bind
`:3000` without colliding.
- **Rejected.** Creating a loopback alias needs `sudo` (per boot) — fatal for a "no knob" promise and a
  sandboxed app. Most dev servers bind `0.0.0.0`/`::` and ignore `HOST`, so they'd still collide. A proxy
  alone doesn't prevent the **bind** collision; on macOS there's no cheap per-process network namespace
  (Linux-only). Heavy infra for a single-user desktop terminal.

### Recommendation
**Option A is the only mechanism that honestly delivers the multi-server promise on notarized macOS without
`sudo`, SIP fights, or per-tool shims** — and it does so with commands the user can see and edit. Pair it
with the always-on collision-free offset (already in code) and the **mandatory port display** (a must under
*any* mechanism — the port is currently invisible). **Drop `basePort`.** Treat Option B as a deferred
convenience and Options C–E as rejected. The user arbitrates the mechanism before implementation.

## Capabilities

### New Capabilities
- `workspace-port-isolation`: allocate a collision-free per-workspace port offset, export it as
  `AURORA_PORT_OFFSET` into every workspace shell, have the AI script generator emit dev/serve commands that
  bind a per-workspace port off each command's own default (so N servers isolate with no base port), and
  surface the allocated offset / derived ports in the workspace UI. No per-repo base port.

### Modified Capabilities
<!-- Builds on `workspace-create` (the env handed to the worktree's PTY), `workspace-config` (the per-repo
     defaults the basePort field is removed from), and `ai-generate-repo-scripts` (the generator whose
     prompt gains the port rule). None of these has a baseline spec under openspec/specs/, so the behavior
     is captured as the new capability above; the env/UI additions are additive. -->

## Impact

- **Supersedes** `openspec/changes/workspace-port-injection` (un-applied; basePort/single-PORT framing
  rejected). Recommend removing that change so two changes don't both edit `create.ts` / `aiScripts.ts`.
- **Frontend (`src/`)**:
  - `lib/repoConfig.ts` — remove `defaults.basePort`; bump `CONFIG_VERSION`; migrate the field out
    (preserve everything else losslessly).
  - `lib/create.ts` — remove the `basePort` read and the `basePort`-gated `PORT` injection (lines ~213–216).
    Keep `allocOffset` and the `AURORA_PORT_OFFSET` export untouched (already correct).
  - `lib/aiScripts.ts` — extend `SYSTEM_PROMPT` with the port-binding rule for dev/serve tasks; ensure
    `nx.json`/`project.json` style hints reach the model so it picks the right serve form and default port.
  - `components/WorkspaceRail.tsx` — `WorkspaceContextBar`: show the offset / derived ports; relax the
    early-return so a plain workspace (no issue, no preset) still shows the port. `WorkspaceCard`: a compact
    offset chip on the status line.
  - `components/WorkspaceSettings.tsx` — remove the "Base port" field if present.
- **Reuses:** the per-workspace `env` already plumbed to `pty_spawn` (no Rust change); the existing
  `allocOffset` collision-free allocation; the `ai-generate-repo-scripts` generation + validation path;
  shell `$((…))` expansion in the PTY.
- **Out of scope:** Option B's base-free `PORT` auto-injection (deferred); any OS-level interception
  (Options C–E, rejected); changing the step size (stays 10); retro-fitting ports onto existing workspaces
  or rewriting hand-written scripts; killing/reassigning ports at runtime (this is purely env + generated
  command strings).
