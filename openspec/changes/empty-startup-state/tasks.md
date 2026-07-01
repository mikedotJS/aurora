# Tasks — empty-startup-state

Ordered so each phase typechecks on its own. Phase 1 widens the state shape, Phase 2 rewrites the `init`
bootstrap, Phase 3 fixes the render gate, Phase 4 adds the empty-state surface, Phase 5 re-verifies the
consumers the audit flagged, Phase 6 tests, Phase 7 verifies build/lint + the real app.

**Concurrency note:** an in-flight edit is touching `store.ts` `init`. Reconcile on **logic**, not line
numbers — this change **replaces** that fix's "keep a lane when `workspaces.length === 0`" fallback with
the empty resolution in `design.md`. Do not hard-code line offsets.

**Designer note:** Phase 4 defines the empty-state surface's *contract*. Its visual treatment is a design
surface — hand `EmptyState.tsx` to the **designer** (`/frontend-design`) for the final look before or
right after wiring it. Keep to existing tokens; no new dependency.

## 1. State shape (`src/state/store.ts`, `src/lib/workspace.ts`)

- [x] 1.1 In `StoreState`, change `activeWs: string` → `activeWs: string | null`. Keep the initial store
      value as-is for pre-init (`""` or `null`, either is falsy); it is superseded by `init`.
      (Implemented as `null`, not `""` — cleaner given the type is now nullable.)
- [x] 1.2 Add `initialized: boolean` to `StoreState` with initial value `false`.
- [x] 1.3 In `src/lib/workspace.ts`, widen `savePersisted(workspaces: Workspace[], activeWs: string | null)`.
      No format change — confirm `null` serializes and that `loadPersisted` still returns
      `{ workspaces: [], activeWs: null }` when nothing is stored. Typecheck the store's existing
      `savePersisted(...)` call sites compile with the widened type.

## 2. `init` bootstrap (`src/state/store.ts`)

- [x] 2.1 Remove the unconditional `bootDir`/`bootWs` synthesis. Compute `bootWs` **only when
      `boot.repo != null`**: reuse `workspaces.find(w => w.dir === boot.repo.root)`, else
      `newWorkspace({ repoId: boot.repo.root, title: boot.repo.currentBranch ?? boot.repo.name, dir:
      boot.repo.root, branch: boot.repo.currentBranch ?? boot.repo.defaultBranch, baseBranch:
      boot.repo.defaultBranch })` and `unshift`. Never synthesize a home/manual lane.
- [x] 2.2 Resolve `activeWs` as: valid `boot.activeWs` (must exist in `workspaces`) → else `bootWs?.id` →
      else `workspaces[0]?.id` (restored, no repo launch) → else `null`.
- [x] 2.3 Keep the mount loop (`w.mounted = w.id === activeWs`); confirm it is a safe no-op-marking when
      `activeWs === null` (all workspaces, if any, unmounted).
- [x] 2.4 Set `initialized: true` in the `set({...})` call. Call `savePersisted(workspaces, activeWs)`
      with the possibly-`null` `activeWs`.
- [x] 2.5 Confirm `createWorkspace` still sets `activeWs: ws.id` (exit path) and that `addRepo` remains a
      repo-list-only mutation (does **not** create a workspace) — no change expected; note it in the diff.
      (Confirmed by reading both reducers — neither needed a code change.)

## 3. Render gate (`src/App.tsx`)

- [x] 3.1 Replace `const ready = useStore((s) => s.workspaces.length > 0)` with
      `const ready = useStore((s) => s.initialized)`. Keep `if (!ready) return null`.
- [x] 3.2 In the content column, branch on whether a workspace is active. Add
      `const hasActiveWs = useStore((s) => activeWorkspace(s) !== undefined)` (or reuse `wsId`), and
      render `<EmptyState />` in place of `<WorkspaceContextBar /> <TabStrip /> <PaneArea />` when there
      is no active workspace. `TitleBar`, `WorkspaceRail`, `StatusBar` stay unconditional.
- [x] 3.3 Verify the existing effects tolerate the empty state: `apId/apCwd` (46-47), `wsId/wsDir/wsBase`
      (48-50, 164-169) all resolve to falsy/undefined and their guards already early-return.

## 4. Empty-state surface (`src/components/EmptyState.tsx` — new)

- [x] 4.1 Create `EmptyState.tsx`: a centered panel filling the content area. Use tokens only
      (`--fg`, `--dim`, `--faint`, `--ac`, `--acd`, `--page`, `--line`, `--mono`, `--sans`); inline
      styles + `global.css` classes per convention. No new dependency.
- [x] 4.2 Primary action "Add repository": call `addRepoFromFolder()` from `lib/repo.ts`, replicating the
      rail's local `addBusy`/`addError` handling (busy label + inline error on `{ ok: false }`).
- [x] 4.3 Secondary action "Create a workspace", shown only when `useStore(s => s.repos.length) > 0`:
      call `useStore.getState().openCommand()` (no repoId → palette picks `repos[0]` or forces a pick).
- [x] 4.4 Copy: a title/wordmark + a one-line invitation to add a repository (e.g. "No workspace open —
      add a repository to get started"). Final wording/visuals are the designer's call.
- [ ] 4.5 Hand `EmptyState.tsx` to the **designer** for visual refinement (dark theme, green accents,
      monospace); keep the contract from Phase 4 intact. (Component is functional and sober per the
      brief; visual pass is the designer's follow-up, not done here.)

## 5. Consumer regression review (read-only verification, no behavior change expected)

- [x] 5.1 Confirm `activeWorkspace`/`activeGroup`/`activePane` selectors still return `undefined` cleanly
      and that `TabStrip` (`?? []`, `?? 0`), `TitleBar` (`?? null`), `StatusBar` (coalesced),
      `WorkspaceContextBar` (`if (!ws) return null`), and `PaneArea` (filters `mounted`) render without
      throwing when there is no active workspace. (Read all five files directly to confirm.)
- [x] 5.2 Confirm `WorkspaceSwitcher` (title bar, when rail collapsed) renders "no workspace" and its
      "New workspace" → `openCommand()` still works with `activeWs === null`. (Read the file: `active ?
      … : "no workspace"`, bottom row calls `openCommand()` unconditionally.)
- [x] 5.3 Confirm `WorkspaceCommand` create flow works with no active workspace (falls back to `repos[0]`
      or forces an explicit repo pick when `repos.length > 1`); with `0` repos it correctly offers no
      create target. (Read the file: `repo = repos[0]` when nothing else matches; `repos[0]` is
      `undefined` at 0 repos, so `branchDisplayDefaults`/`cloneDisplayDefaults` are `null` — no target.)
- [x] 5.4 Spot-check `ScriptsSheet` / `MrSheet` / `ScriptsSetupModal` `activePane(s)` reads are
      undefined-tolerant (these panels are unreachable in the empty state, but must not crash if opened).
      (Only `ScriptsSheet` reads `activePane`; it's `pane ? … : null`-guarded throughout. `MrSheet` /
      `ScriptsSetupModal` don't read active-pane state at all.)
- [x] 5.5 Note R1 in the change: with no active pane, `keymap.ts` bails, so ⌘K etc. are no-ops in the
      empty state — creating the first workspace is via on-screen CTAs. No fix here; just confirm the CTAs
      cover it. (Confirmed: EmptyState's own "Add repository"/"Create a workspace" plus the rail's own
      controls are the on-screen paths.)

## 6. Tests (`__tests__/`, `bun:test`)

- [x] 6.1 (Deviation from the literal task, per explicit direction from the implementation brief: kept
      the boot-lane tests co-located in `__tests__/storeCommand.test.ts` instead of a new
      `storeInit.test.ts` — that file is the one whose real-store import survives the full-suite run,
      since other files' `mock.module("../src/state/store", …)` leaks globally across `bun test`. A
      separate file would silently import the mock and lose `init`.) Mocks
      (`@tauri-apps/*`, `@xterm/*`, `../src/lib/theme`) and the `localStorage` shim were already present
      there; reused as-is.
- [x] 6.2 Test: empty startup — `init(home, settings, false, { repo: null, restored: [], activeWs: null })`
      ⇒ `workspaces.length === 0`, `activeWs === null`, `initialized === true`.
- [x] 6.3 Test: repo launch — `init` with a `boot.repo` and empty `restored` ⇒ one workspace bound to the
      repo and `activeWs === thatWs.id`. (Pre-existing test, updated to also assert `initialized === true`.)
- [x] 6.4 Test: restored, no repo launch — `init` with `boot.repo: null` and a non-empty `restored` ⇒
      `workspaces` equals the restored set (no extra lane), `activeWs` is the valid `boot.activeWs` else
      the first restored id. (Two pre-existing tests already covered this; left intact.)
- [x] 6.5 Test: `removeWorkspace` refuses the last workspace (state stays length 1, never empty) — guards
      the non-goal.
- [x] 6.6 Test: `createWorkspace` from an empty store sets `activeWs` to the new id (exit path).

## 7. Verify

- [x] 7.1 `bun run typecheck` (`tsc --noEmit`) and `bun run lint` (`eslint src`) are both clean — see the
      implementer's report for pasted output.
- [x] 7.2 `bun test` — all boot-lane/empty-state tests pass (157/158). The one remaining failure
      (`__tests__/zzz_srcload.test.ts`, a `relaunch` export mismatch from mock leakage of
      `@tauri-apps/plugin-process`) is pre-existing: reproduced identically on the last commit before any
      of this change's edits. Out of scope per "don't touch test/ infra"; flagged for the tester/debugger.
- [x] 7.3 `bun run build` (`tsc && vite build`) is clean.
- [ ] 7.4 Manual (real app — WKWebView; jsdom/Blink can't confirm layout): not run in this session (no
      app-launch tooling available here). Flagged for the tester to run via `/run` or `/verify`.
