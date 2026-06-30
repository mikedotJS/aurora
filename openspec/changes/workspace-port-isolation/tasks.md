# Tasks — workspace-port-isolation (recommended mechanism: Option A)

> Mechanism is pending user sign-off. These tasks cover **Option A** (port-aware generation + offset +
> display, basePort dropped). If the user also wants Option B, add a separate phase.

## 0. Supersede the old change

- [x] 0.1 Removed `openspec/changes/workspace-port-injection` (was un-applied, 0/10; basePort/single-PORT
      framing rejected and superseded by this change). No remaining references found.

## 1. Drop the base-port knob (`src/lib/repoConfig.ts`)

- [ ] 1.1 Remove `defaults.basePort` from the `RepoConfig.defaults` type and from `defaultRepoConfig`.
- [ ] 1.2 Bump `CONFIG_VERSION`; in `migrate`, strip `basePort` from `defaults` (via the existing legacy-
      intersection pattern) while preserving every other field losslessly. Keep the migration idempotent.
- [ ] 1.3 Remove the "Base port" field from `src/components/WorkspaceSettings.tsx` if present.

## 2. Stop deriving PORT from basePort (`src/lib/create.ts`)

- [ ] 2.1 Remove the `basePort` read and the `basePort > 0 && env.PORT == null` `PORT` injection (~lines
      213–216). Keep building `env` with `AURORA_PORT_OFFSET = String(offset)` and the preset env merge.
- [ ] 2.2 Leave `allocOffset` unchanged (already lowest-unused-multiple-of-10 over live workspaces). Add a
      short comment noting the offset is the sole port primitive (no base port).

## 3. Port-aware AI script generation (`src/lib/aiScripts.ts`)

- [ ] 3.1 Extend `SYSTEM_PROMPT`: for any dev/serve task, bind a per-workspace port by adding
      `$AURORA_PORT_OFFSET` to the command's own real default port — e.g.
      `next dev --port $((3000 + AURORA_PORT_OFFSET))`, `nx serve <app> --port $((4200 + AURORA_PORT_OFFSET))`,
      `vite --port $((5173 + AURORA_PORT_OFFSET))`. State that `$AURORA_PORT_OFFSET` is provided per
      workspace; a `$PORT`-honoring server MAY rely on `$PORT` instead; **each server in a multi-server repo
      binds its own default + offset**; keep commands non-destructive.
- [ ] 3.2 Confirm the gathered repo signals surface monorepo/runner hints so the model picks the right serve
      form and default port. Add `nx.json` (and, where cheap, `project.json` discovery) to the manifest
      allowlist in `gatherRepoSignals` if missing.
- [ ] 3.3 Verify `parseScripts` accepts commands containing `$((…))` and `--port` unchanged (no sanitizer
      strips them); add a parse test fixture with an offset-bearing command.

## 4. Surface the allocated port (`src/components/WorkspaceRail.tsx`)

- [ ] 4.1 `WorkspaceContextBar`: relax the early return so it renders for a workspace that has a port offset
      even with no `issueKey`/`preset`. Render the offset (e.g. `+10`, `+0` shown as `default`).
- [ ] 4.2 When concrete ports are derivable, show them: parse the workspace's scripts for
      `$((<base> + AURORA_PORT_OFFSET))`, compute `<base> + offset`, and render labeled chips
      (e.g. `api :3343 · web :4210`). Where no base is known, show the offset alone — never fabricate a port.
- [ ] 4.3 `WorkspaceCard`: add a compact offset chip on the status-line row (alongside diff/jira), styled to
      match. Hand the exact chip visuals to the **designer** (frontend-design) — keep this task to wiring +
      a placeholder style.
- [ ] 4.4 Read the offset from `ws.env.AURORA_PORT_OFFSET` (already persisted); guard malformed/absent values
      (treat as no chip).

## 5. Validation

- [ ] 5.1 Verify each spec scenario: two live workspaces get distinct offsets; a deleted slot is reusable but
      never duplicated among live workspaces; a preset's fixed offset is honored; `AURORA_PORT_OFFSET` is
      exported into the shell; a generated `nx serve` binds `$((4200 + AURORA_PORT_OFFSET))`; a multi-server
      repo's generated scripts give each server its own default+offset; a `$PORT`-honoring server may use
      `$PORT`; hand-written scripts are untouched; the context bar shows the port for a plain workspace; no
      `basePort` setting exists and no `PORT` is auto-injected.
- [ ] 5.2 `bun run lint`, `bunx tsc --noEmit`, and `bun run build` clean.
