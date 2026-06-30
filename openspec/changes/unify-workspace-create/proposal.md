<!-- UNIFY — movement #2 of 4 in the Workspaces recovery roadmap (docs/workspaces-reprise-roadmap.md).
     Depends on CUT (cut-dead-workspace-surface) being applied: the agent/kickoff concept is gone
     and MUST NOT be reintroduced. BUILD-teardown / BUILD-port-isolation are separate, later changes.
     Guard principles (docs/workspaces-ux.mmd 1-3): target always visible & pinned · every default
     shown · one single creation path. -->

## Why

After CUT, the create flow still violates the three guard principles it is meant to honour:

- **The explicit target you pick is destroyed on the first keystroke.** The rail's repo "+"
  (`WorkspaceRail.tsx:396`) and the empty-card "+" (`:401`) pass an explicit `repoId` into
  `openCommand(repoId)` (`store.ts:708`). But `setCommandQuery` rebuilds the command object as
  `{ query, sel: 0 }` **without** `...s.command` (`store.ts:710`), so `repoId` is dropped the moment
  you type one character. `WorkspaceCommand` then silently falls back to the active workspace's repo,
  else `repos[0]` (`WorkspaceCommand.tsx:66-74`). You aim at one repo; the app forgets and fires at
  another, and never tells you where it fired. (Principle #1.)

- **The target is invisible in the palette list.** The resolved target repo is shown only inside the
  scope-form header (`WorkspaceScopeForm.tsx:211`), never in the palette's switch/create list. The
  switcher "+" (`WorkspaceSwitcher.tsx:247`) and ⌘K (`keymap.ts:282`) pass no `repoId` at all, so with
  more than one repo the target is guessed in silence. (Principle #1.)

- **Quick-create and the scope form are two divergent spec builders.** There are two places that build a
  `CreateSpec`: `WorkspaceCommand.quickCreate` assembles inline specs for `branch` (`:181-192`) and
  `clone` (`:162-173`); `WorkspaceScopeForm.create` assembles the full spec (`:150-168`). The quick
  path **omits `scriptName` entirely** — so ⌘K → text → ↵ runs the dependency install but **no on-open
  script, i.e. no dev server** — and it also drops the preset's `env`, `portOffset`, and `baseOverride`
  resolution that the form applies via `presetCreateFields` (`presets.ts:64-75`). Same intent, two code
  paths, different results. (Principles #2 and #3.)

- **The quick path's defaults are hidden.** On ↵, base branch, preset, and on-open script are chosen for
  the user and shown nowhere before creation (`WorkspaceCommand.tsx:178-196`). (Principle #2.)

## What Changes

- **Pin the target and make it survive typing.** Spread `...s.command` in `setCommandQuery`
  (`store.ts:710`) so an explicitly-targeted `repoId` is no longer lost on the first keystroke. (One
  line, highest leverage.)
- **Show the target as a persistent, changeable chip in the palette.** Add a target chip to the palette
  header (`WorkspaceCommand.tsx:269-282`) that always displays the **resolved** target repo (explicit
  `command.repoId`, else the active workspace's repo). When more than one repo exists, the chip opens a
  small repo menu; picking a repo pins it via a new `setCommandRepo` store action that preserves the
  current `query`/`sel`. When there is **no usable context** (more than one repo and no active
  workspace), the chip shows an unselected "Choose repo" state and the create rows are blocked until a
  repo is picked — the target is chosen explicitly, never guessed.
- **Collapse to one spec builder.** Extract a single `buildCreateSpec(...)` in `lib/create.ts` that
  assembles a complete `CreateSpec` from explicit inputs, resolving the base branch
  (`baseOverride ?? cfg.defaults.baseBranch ?? repo.defaultBranch`), the on-open script
  (`?? preset.runOnOpen`), and the preset fields (`paneCount`/`split`/`env`/`portOffset` via
  `presetCreateFields`). Both `WorkspaceScopeForm.create` and `WorkspaceCommand.quickCreate` build their
  spec through it. The quick path therefore **always applies the preset and always runs the on-open
  script**, identically to the form. The form keeps its own Jira detail-fetch / transition side effects.
- **Make the quick path's defaults visible.** Under each instant-create source row (`branch`, `clone`)
  in the palette (`WorkspaceCommand.tsx:337-350`), show the resolved `base · preset · on-open script`
  (or "on-open: none") that ↵ will use — computed from the same resolution as the builder.

### Key decisions

- **One gesture stays; one builder is enforced.** ⌘K → ↵ still creates instantly (no forced form) — the
  product promise is "un seul geste". The honest end-state is not "make ↵ open the form" but "make ↵ and
  the form produce the **same** workspace setup". We enforce that by routing both through one
  `buildCreateSpec`, not by adding a "case-by-case" parity patch that can drift again. The spec asserts
  observable **equivalence** (same base/preset/env/offset/script for the same inputs) and that the
  on-open script always runs; the single-builder refactor is the implementation that guarantees it.
- **The chip shows the resolved target, the pick pins it.** The chip never invents a repo: it renders
  the same target the create would use, so visibility and behaviour can't disagree. Picking writes
  `command.repoId` (preserving the typed query), so the explicit choice is sticky for the rest of the
  session in that palette. `openCommand` is **not** reused for re-targeting (it resets `query`/`sel`).
- **Global entries keep a null initial target.** ⌘K and the switcher "+" legitimately have no single
  repo context; they keep passing no `repoId`. The chip — not a guessed default baked into the entry
  point — is what makes their resolved target visible and changeable. Minimal, coherent across all four
  entries (rail "+", empty card, switcher "+", ⌘K).
- **Running the on-open script on quick-create is intended.** The whole point of UNIFY is "on lance
  toujours le script d'ouverture". The install command already runs on every create; adding the
  preset's configured on-open script is consistent and is the explicit product decision.

### Non-goals (explicitly NOT in this change)

- No teardown / process-group kill, no real `AURORA_PORT_OFFSET` consumption or port display — **BUILD**
  (`workspace-port-injection` and a later teardown change).
- No reintroduction of the agent / kickoff concept (removed in CUT) — it stays gone.
- No change to the scope form's existing fields (base / preset / on-open script are already visible and
  editable there); UNIFY only closes the gap on the quick path and the target chip.
- No new GitLab create source, no Jira write-back changes, no container isolation — **DEFER**.
- No Rust / backend changes; secrets stay in the keychain, never in the webview.

## Capabilities

### Modified Capabilities
<!-- The `workspace-create` capability is defined by the not-yet-archived change `workspace-create` and
     already modified by `cut-dead-workspace-surface` (no baseline under openspec/specs/ yet). The deltas
     here express UNIFY as one MODIFIED + new ADDED requirements against that capability, to be applied
     when archived in dependency order (workspace-create → cut-dead-workspace-surface → unify). -->
- `workspace-create`: the create-with-defaults path now targets the pinned repo, applies the full preset
  (env / portOffset), and runs the on-open script; the quick and scope-form paths are observably
  equivalent; the target repo is a visible, pinned, changeable chip; the quick path's chosen defaults
  are shown before creation.

## Impact

- **Frontend (`src/`)**:
  - `state/store.ts` — fix `setCommandQuery` to spread `...s.command` (`:710`); add a `setCommandRepo`
    action (interface near `:287`, impl near `:710`) that sets `command.repoId` while preserving
    `query`/`sel`.
  - `lib/create.ts` — add `buildCreateSpec(input): CreateSpec` (assembly + base/script/preset
    resolution); no change to `runCreate`'s behaviour.
  - `components/WorkspaceCommand.tsx` — render the target chip + repo menu in the header; route both
    `quickCreate` specs through `buildCreateSpec`; show the resolved defaults under the instant-create
    source rows; block create when target is unset with multiple repos.
  - `components/WorkspaceScopeForm.tsx` — build its `CreateSpec` via `buildCreateSpec` (keep the Jira
    fetch/transition side effects around it).
- **Backend (`src-tauri/`)**: none.
- **Persisted data**: none (the `command` palette state is ephemeral; `repoId` is already on the type at
  `store.ts:243`).
- **Depends on**: `cut-dead-workspace-surface` (agent/kickoff removed), `workspace-create`,
  `workspace-config` (presets/defaults it resolves).
- **Hands off to**: BUILD — teardown (process-group kill + worktree removal) and real port-offset
  consumption + port display.
