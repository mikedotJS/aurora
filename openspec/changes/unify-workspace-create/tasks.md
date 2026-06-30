<!-- UNIFY. file:line refs are the current (post-CUT) tree. Order: fix the target bug + chip first
     (cheap, highest leverage), then collapse to one spec builder, then surface the quick-path defaults,
     then validate. Keep `bun run build` green after each numbered section. -->

## 1. Pin the target & make it survive typing

- [ ] 1.1 `state/store.ts`: in `setCommandQuery` (`:710`), spread `...s.command` so `repoId` (and any
  future field) survives a keystroke — `command: s.command ? { ...s.command, query: q, sel: 0 } : s.command`.
- [ ] 1.2 `state/store.ts`: add a `setCommandRepo(repoId: string | null)` action — interface near the
  other command actions (`:285-289`) and impl near `:710` — that sets `command.repoId` while preserving
  the current `query`/`sel` (`s.command ? { command: { ...s.command, repoId } } : {}`). Do **not** reuse
  `openCommand` for re-targeting (it resets `query`/`sel`).
- [ ] 1.3 Verify: open the rail repo "+" (`WorkspaceRail.tsx:396`) or empty-card "+" (`:401`), type a
  character, and confirm the resolved target in `WorkspaceCommand.tsx:66-74` stays the picked repo (no
  fallback to the active repo). `bun run build` green.

## 2. Show the target as a persistent, changeable chip

- [ ] 2.1 `components/WorkspaceCommand.tsx`: render a **target chip** in the palette header
  (`:269-282`, next to the input) showing the resolved `repo.name` (the `repo` already computed at
  `:67-74`). The chip reflects the effective target whether it came from an explicit `command.repoId`
  or the active-workspace fallback.
- [ ] 2.2 `components/WorkspaceCommand.tsx`: when `repos.length > 1`, make the chip open a small repo
  menu listing `repos`; selecting one calls `setCommandRepo(id)` to pin it. When `repos.length <= 1`,
  render the chip non-interactive.
- [ ] 2.3 `components/WorkspaceCommand.tsx`: when `repos.length > 1` **and** there is no active workspace
  (no usable default context), the chip shows an unselected "Choose repo" state and the create source
  rows are blocked (no instant create, no form open) until a repo is picked — the target is chosen
  explicitly, never guessed. (Keep the existing `!repo` empty-state copy for the zero-repo case,
  `:285-289`.)
- [ ] 2.4 Verify: from the switcher "+" (`WorkspaceSwitcher.tsx:247`) and ⌘K (`keymap.ts:282`) — both
  pass no `repoId` — the chip shows the resolved target and lets you change it; from the rail "+" it
  shows the pinned repo. `bun run build` green.

## 3. Collapse to one spec builder (kill the quick/form divergence)

- [ ] 3.1 `lib/create.ts`: add `buildCreateSpec(input): CreateSpec` that assembles a **complete**
  `CreateSpec`, resolving: base branch (`input.baseBranch ?? preset?.baseOverride ?? cfg.defaults.baseBranch ?? repo.defaultBranch`),
  on-open script (`input.scriptName ?? preset?.runOnOpen ?? null`), and the preset fields
  (`paneCount`/`split`/`env`/`portOffset`) via `presetCreateFields` (`presets.ts:64-75`). Inputs:
  `{ repo, source, preset, branch, title, baseBranch?, scriptName?, newBranch, issueKey?, jiraStatus?, jiraUrl?, jiraSync? }`.
  No agent / kickoff fields (removed in CUT).
- [ ] 3.2 `components/WorkspaceScopeForm.tsx`: replace the inline `CreateSpec` assembly in `create()`
  (`:150-168`) with a `buildCreateSpec({...})` call built from the form's editable state (branch, base,
  preset `selected`, `scriptName`, jira fields). Keep the surrounding Jira detail-fetch (`:142-148`) and
  the post-create transition (`:177-183`).
- [ ] 3.3 `components/WorkspaceCommand.tsx`: replace **both** inline `runCreate({...})` specs in
  `quickCreate` — `clone` (`:162-173`) and `branch` (`:181-192`) — with `buildCreateSpec({...})` so the
  quick path always carries `scriptName`, `env`, `portOffset`, and the resolved base. For `clone`, the
  preset is the active workspace's preset object; for `branch`, the repo's default preset
  (`defaultPreset`, `:150-154`).
- [ ] 3.4 Verify: ⌘K → type a branch name → ↵ creates a workspace whose on-open script runs (dev server
  starts) and whose `env.AURORA_PORT_OFFSET` / preset `env` match what the scope form produces for the
  same preset; `grep -n "runCreate(" src/components/WorkspaceCommand.tsx` shows specs built only via
  `buildCreateSpec` (no remaining inline literal). `bun run build` green.

## 4. Surface the quick path's defaults

- [ ] 4.1 `components/WorkspaceCommand.tsx`: under each **instant-create** source row (`branch`,
  `clone`) in the sources list (`:337-350`), show the resolved `base · preset · on-open: <name|none>`
  that ↵ will use — computed from the same resolution as `buildCreateSpec` (e.g. a small helper that
  returns the resolved base/preset/script for a source without creating).
- [ ] 4.2 Verify: before pressing ↵ on `branch`/`clone`, the base branch, preset, and on-open script are
  all visible in the palette.

## 5. Validation

- [ ] 5.1 `bun run build` (Vite + tsc strict) green; no unused-symbol / unused-import errors.
- [ ] 5.2 ESLint clean: `bunx eslint .` reports no errors.
- [ ] 5.3 Manual UX check (principles 1-3): the rail "+" target survives typing; the palette shows a
  target chip that is changeable with >1 repo and forces an explicit pick when there's no context;
  ⌘K → ↵ on a branch starts the dev server (on-open script runs); the quick rows show base/preset/script
  before ↵.
- [ ] 5.4 `openspec validate unify-workspace-create --strict` passes.
