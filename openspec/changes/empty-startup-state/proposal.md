## Why

On launch, `store.ts` `init` **always** materializes a workspace. When Aurora starts outside a git
repo with nothing restored, it builds a manual "home lane"
(`{ repoId: null, branch: null, dir: home, title: baseName(home) }`) and `unshift`es it, so the user
is dropped into a throwaway terminal rooted at their home directory. That default is noise: it isn't a
real workspace, it clutters the rail's `local` group, and it hides the fact that the right first action
is **add a repository**. The app should instead present a clear **empty state** and create **zero**
workspaces until the user asks for one.

This also removes a load-bearing hack: `App.tsx` uses `workspaces.length > 0` as its proxy for
"boot finished" (`if (!ready) return null`). The moment a legitimately-empty boot is allowed, that proxy
renders the app permanently blank. We need an explicit "initialized" signal.

## What Changes

- **No default workspace on an empty startup.** When `init` runs with **no repo context**
  (`boot.repo == null`) **and no restored workspaces**, the store settles on `workspaces = []` and
  `activeWs = null`. The manual home lane is **never** created. **BREAKING** (behavioral): a fresh,
  outside-a-repo launch no longer opens a home terminal.
- **`init` only creates a boot lane when launched inside a repo.** `boot.repo != null` still opens
  (or reuses) that repo's workspace — a repo launch is a real context. No manual/home lane is ever
  synthesized.
- **Restored workspaces are preserved as-is**, with no extra default lane added alongside them. This
  **supersedes** the concurrent `init` guard whose fallback still "keeps a lane when
  `workspaces.length === 0`" — that branch is replaced by the empty state.
- **`activeWs` becomes `string | null`** (runtime + persisted). `savePersisted`'s `activeWs` parameter
  widens to `string | null`; `loadPersisted` already returns `string | null` and round-trips `null`.
- **New store flag `initialized: boolean`** (default `false`, set `true` at the end of `init`).
  `App.tsx`'s readiness gate switches from `workspaces.length > 0` to `initialized`.
- **New empty-state surface.** When no workspace is active, the content column (right of the rail)
  renders a centered empty state instead of `WorkspaceContextBar + TabStrip + PaneArea`. It invites the
  user to **Add repository** (reusing the existing `addRepoFromFolder` flow) and — when repos already
  exist — to **Create a workspace** (reusing `openCommand()`). This is a UI surface; the **designer**
  owns its final visual treatment.
- **Exit from empty is via existing flows only.** `createWorkspace` already sets `activeWs`, and the
  command palette already tolerates "no active workspace" (`WorkspaceCommand` falls back to `repos[0]`
  / forces an explicit repo pick). No new create logic is introduced.

Non-goals:
- **No "return to empty by closing the last workspace."** `removeWorkspace` and `deleteWorkspace` keep
  their `length <= 1` guard; the trash affordance stays hidden on the last / non-worktree card. The only
  route to the empty state is an empty startup. (Rationale in `design.md`.)
- **No new dependency, no new create/switch logic, no redesign** of the visual language (dark theme,
  green accents, monospace, existing `tokens.css`). Inline styles + `global.css` classes, as today.
- **No security surface** (no auth/data/payment involved).

## Capabilities

### New Capabilities
- `empty-startup-state`: Aurora boots to a first-class **empty state** (zero workspaces, `activeWs = null`)
  when there is no repo context and nothing restored, never synthesizing a default home workspace; the
  app still renders (via an explicit `initialized` signal), presents an add-a-repository invitation, and
  exits the empty state through the existing add-repo / create-workspace flows.

### Modified Capabilities
<!-- None. No promoted baseline spec exists for the startup / workspace-bootstrap behavior under
     openspec/specs/ (only merge-request-search lives there). As with the responsive-ui-layout change,
     this behavior is captured as a new additive capability rather than a delta to a non-existent
     baseline. -->

## Impact

- **`src/state/store.ts`** — `init`: drop the unconditional `bootWs`; only create a repo boot lane when
  `boot.repo != null`; resolve `activeWs` to a valid restored id, else the boot lane, else the first
  restored workspace, else `null`. `StoreState.activeWs: string` → `string | null`; add
  `initialized: boolean`; set it in `init`. **Reconcile with the in-flight `init` edit on `store.ts`** —
  this change replaces that fix's "keep a lane when `length === 0`" fallback (reason on logic, not line
  numbers).
- **`src/lib/workspace.ts`** — `savePersisted(workspaces, activeWs: string | null)` (widen the param
  type). No format change; `null` already round-trips through `loadPersisted`.
- **`src/App.tsx`** — `ready = s.initialized` (was `s.workspaces.length > 0`); in the content column,
  render the new empty state when there is no active workspace, else the existing
  `WorkspaceContextBar + TabStrip + PaneArea`.
- **`src/components/EmptyState.tsx`** (new) — the centered empty-state panel; primary "Add repository",
  optional "Create a workspace"; tokens-based styling. **Designer refines.**
- **Reuses (no change):** `addRepoFromFolder` (`lib/repo.ts`), `openCommand` / `createWorkspace`
  (`store.ts`), `WorkspaceRail` (already shows "no workspaces yet" + Add repository), `WorkspaceSwitcher`
  (already renders "no workspace"), `WorkspaceCommand` (already handles no active workspace).
- **Verified already null-safe (no change, guarded by regression tasks):** `activeWorkspace` /
  `activeGroup` / `activePane` selectors (return `undefined`), `TitleBar`, `StatusBar`, `TabStrip`,
  `WorkspaceContextBar`, `PaneArea`, `keymap.ts` (bails on no active pane).
- **`__tests__/`** — new store-init tests (`bun:test`) for the empty / repo-launch / restored cases and
  the preserved close-guard.
