# Tasks — home-terminal

Ordered so each phase typechecks on its own. Phase 1 adds the `kind` discriminator to the model + persistence,
Phase 2 makes `init` ensure + activate Home, Phase 3 adds the non-deletable guards, Phase 4 does the surfacing
(Home as a top-level **TitleBar** entry excluded from the rail + `⌘0` shortcut, and the rail owns onboarding),
Phase 5 removes the central empty pane + re-verifies repo-assuming guards and the anti-crash selector rule,
Phase 6 tests, Phase 7 verifies build/lint + the real app.

**Surfacing note (revised):** Phase 4 was initially planned as a **pinned Home entry inside the rail** (above
the groups). Per user decision, Home was moved **out of the rail entirely** into a top-level **TitleBar** entry
(labelled `~`, visible even when the rail is collapsed), plus a `⌘0` shortcut. The rail now only *excludes* Home
from its groups; it no longer renders a Home entry. The tasks below are marked `[x]` reflecting the **TitleBar**
implementation as shipped and gate-verified. See design.md D6.

**Reconcile-on-logic note:** this builds on the just-landed `empty-startup-state` `init` (contextless boot →
`workspaces = []`, `activeWs = null`). This change **supersedes that at boot**: contextless boot now lands on the
Home terminal (`activeWs = homeWs.id`), not `null`. Because `activeWs` is now never `null` after `init`, the
central `EmptyState` pane is unreachable and is **deleted** (component + import + `App.tsx` branch); its
onboarding moves into the rail (design.md D5). The `activeWs: string | null` / `initialized` store shape from
`empty-startup-state` **stays**. Reconcile by logic, not line numbers.

**Designer note:** Phase 4 defines the TitleBar Home entry's *contract* (top-level TitleBar entry after the
window controls, separated by a hairline, visible even when the rail is collapsed, active state, no trash,
labelled `~`, reachable via `⌘0`) **and** the rail-onboarding contract (rail owns "add repo / create
workspace"). Their visual treatment (the `~` glyph styling, hairline, active indicator; onboarding copy/layout)
is a **designer** surface (`/frontend-design`). The collapsed-rail switcher question is now **moot** — Home lives
in the TitleBar and is always accessible regardless of the rail's state (design.md Open Questions). Keep to
existing tokens; no new dependency.

## 1. Model + persistence (`src/state/store.ts`, `src/lib/workspace.ts`)

- [x] 1.1 Add `kind: "home" | "workspace"` to `interface Workspace`. Existing/created lanes are
      `kind: "workspace"`.
- [x] 1.2 Add optional `kind?: "home" | "workspace"` to `CreateWorkspaceOpts`; in `newWorkspace`, set
      `kind: opts.kind ?? "workspace"`.
- [x] 1.3 In `rehydrate`, read `p.kind`, defaulting a missing/legacy value to `"workspace"`
      (`kind: p.kind ?? "workspace"`).
- [x] 1.4 In `src/lib/workspace.ts`: add `kind: "home" | "workspace"` to `PersistedWs`; write `w.kind` in
      `savePersisted`; in `loadPersisted`, tolerate legacy records (no `kind`) — the field is optional at read
      time and `rehydrate` defaults it. Confirm existing `savePersisted(...)` call sites still typecheck.

## 2. `init` ensures and activates Home (`src/state/store.ts`)

- [x] 2.1 After `const workspaces = boot.restored.map(rehydrate)`, **ensure Home**: `let homeWs =
      workspaces.find(w => w.kind === "home")`; if absent, `homeWs = newWorkspace({ kind: "home",
      repoId: null, title: "Home", dir: home, branch: null, baseBranch: "" })` and `workspaces.unshift(homeWs)`.
      Match on `kind === "home"`, never on id/dir, so a restored Home is reused (not duplicated).
- [x] 2.2 Keep the existing repo-boot-lane logic (`if (boot.repo) { … bootWs … }`) unchanged.
- [x] 2.3 Change `activeWs` resolution so a contextless boot lands on Home, not `null`:
      `boot.activeWs (must exist in workspaces) → else bootWs?.id → else homeWs.id`. The `?? null` empty-state
      branch is **removed** as the boot outcome (Home is always the floor).
- [x] 2.4 Keep the mount loop `for (const w of workspaces) w.mounted = w.id === activeWs;` — Home mounts when it
      is active.
- [x] 2.5 Keep `set({ …, initialized: true })` and `savePersisted(workspaces, activeWs)` (now Home is included
      and `activeWs` is never `null` at boot). Confirm `deriveRepos` does not derive a repo from Home
      (`repoId: null` is already ignored — verify by reading `deriveRepos`).

## 3. Non-deletable guards (`src/state/store.ts`, `src/lib/teardown.ts`)

- [x] 3.1 In `removeWorkspace`, before the existing `length <= 1` logic, refuse when the target is Home:
      find the workspace, and if `kind === "home"` `return {}` (no-op). Keep the `length <= 1` guard.
- [x] 3.2 In `deleteWorkspace` (`lib/teardown.ts`), early-return a refusal for `kind === "home"` **before** the
      length/worktree/PTY-kill steps (e.g. `{ ok: false, error: "the Home terminal cannot be removed" }`).
- [x] 3.3 Confirm no adopt-repo path can convert Home into a repo lane: read `adoptRepo` and guard it (or
      confirm it is never called for Home) so a `kind: "home"` workspace never gains a `repoId`. **Guarded**:
      `adoptRepo` is reachable from `App.tsx`'s cwd-change effect for ANY `repoId: null` workspace (including
      Home, which has `repoId: null` by design) — added an explicit `ws.kind === "home"` refusal in `adoptRepo`
      itself (this is a real gap the design flagged, not scope creep).

## 4. Surfacing: Home in the TitleBar (`⌘0`), excluded from the rail; rail owns onboarding (`src/components/TitleBar.tsx`, `src/lib/keymap.ts`, `src/components/WorkspaceRail.tsx`)

- [x] 4.1 Select the Home workspace with a **stable-ref** selector wherever it is needed (TitleBar, rail):
      derive it from the already-subscribed `workspaces` array (e.g. `const homeWs = workspaces.find(w => w.kind
      === "home")`) — do NOT add a new `useStore(s => s.workspaces.find(...))` selector that could return a fresh
      value pattern (see 5.5).
- [x] 4.2 Exclude Home from grouping: filter `shown` (and thus the per-repo groups and the `manual`/`local`
      bucket, `WorkspaceRail.tsx:415-429`) to `w.kind !== "home"`. Home must not appear in any repo group nor in
      `local`. `groups.length === 0` then means "no non-Home workspaces".
- [x] 4.3 Render the **Home entry as a top-level TitleBar button** (`src/components/TitleBar.tsx`), placed after
      the traffic-light window controls and set apart by a hairline divider, **always visible even when the rail
      is collapsed** (contract only — designer refines). Label is **`~`** with a descriptive `aria-label`/`title`
      (the `title` announces `⌘0`). It shows active state (`activeWs === homeWs.id`, via `aria-current`) and calls
      `switchWorkspace(homeWs.id)` on click. It exposes **no trash affordance**. *Revised*: initially planned as a
      pinned rail entry; moved to the TitleBar per user decision (design.md D6).
- [x] 4.3b Add the **`⌘0`** shortcut in `src/lib/keymap.ts`, in the pane-independent `⌘` block (alongside
      `⌘,`/`⌘K`/`⌘B`, above the active-pane bail so it works regardless of pane focus): find the
      `kind === "home"` workspace and `switchWorkspace` to it. **Done** — handler added; the TitleBar button's
      `title` advertises it.
- [x] 4.4 Hide/disable the trash/delete affordance for `ws.kind === "home"` wherever a card renders it
      (belt-and-suspenders with 3.1/3.2). Confirm the card does not subscribe to a selector returning a fresh
      array/object each render (see 5.5). Note: the inline `WorkspaceCard` lives in `WorkspaceRail.tsx` (no
      separate file) — guard added there; but since Home is now a **TitleBar** entry and is filtered out of the
      rail entirely (4.2), Home never renders through `WorkspaceCard` at all, so this is pure belt-and-suspenders.
- [x] 4.5 **Rail owns onboarding.** Turn the existing empty region (`WorkspaceRail.tsx:543-555`, currently just
      `"no workspaces yet"` / `"no workspace matches …"`, shown when `groups.length === 0`) into the onboarding
      surface: a primary **Add repository** action (reuse the footer's `onAddRepo` / `addRepoFromFolder` with its
      `addBusy`/`addError` handling, ~L590+) and, when `useStore(s => s.repos.length) > 0`, a secondary
      **Create a workspace** action (`openCommand()`). Keep the `q`/filter branch (`"no workspace matches …"`)
      when a filter is active — onboarding is for the truly-empty case, not the filtered-empty case. No central
      pane involved. (Selector for `repos.length` returns a primitive → safe per 5.5.) **Note**: the existing
      footer "Add repository" control was left as-is (primary action always visible in the footer, unchanged);
      the new onboarding block adds its own copy + the secondary "Create a workspace" action inline in the empty
      region, above the unchanged footer. See the reviewer/tester note below on the "Create a workspace" branch's
      reachability.
- [x] 4.6 Hand the TitleBar Home entry **and** the rail onboarding to the **designer** for visual refinement
      (the `~` glyph styling, hairline divider, active indicator; onboarding copy/layout). The collapsed-rail
      switcher question is **moot** — Home lives in the TitleBar, always accessible regardless of the rail's
      state (design.md Open Questions). Keep the Phase-4 contract intact; existing tokens only; no new dependency.
      **Handoff pending** — contract implemented with plain inline styles matching existing conventions; final
      visual pass not done here (designer surface, per instructions).

## 5. Remove the central empty pane + consumer regression review (`src/App.tsx`, then read-only)

- [x] 5.1 **Delete the central empty-state pane.** In `src/App.tsx`: remove the `EmptyState` import (L15), and
      replace the `hasActiveWs ? (context+tabs+panes) : <EmptyState/>` branch (L269-277) with the terminal
      column rendered unconditionally (`<WorkspaceContextBar/><TabStrip/><PaneArea/>`), since Home is always
      active. Drop the now-unused `hasActiveWs` selector (L42) if nothing else reads it (grep first). Then
      **delete `src/components/EmptyState.tsx`** and confirm no remaining import references it
      (`grep -rn EmptyState src`). TypeScript build must stay clean. Also removed the now-orphaned
      `__tests__/EmptyState.cov.test.tsx` and the dead `.aurora-empty` / `.aurora-empty__caret` /
      `.aurora-empty-secondary` CSS (kept `.aurora-empty-primary`, still consumed by `WorkspacesIntro.tsx`).
- [x] 5.2 Confirm repo-assuming guards short-circuit for Home (`repoId: null`): `servers.ts` `runServers`
      (`if (!ws.repoId) return`), `teardown.ts` (`if (w.repoId != null)` worktree path), `WorkspaceRail`/
      `WorkspaceCard` trash guard (`!ws.repoId || ws.dir === ws.repoId`), `create.ts`/`scripts.ts` repo reads.
      Confirm none throw or offer a repo action for Home. **Confirmed by reading** — no changes needed beyond
      the explicit `adoptRepo` guard (3.3).
- [x] 5.3 Confirm engine call sites that iterate `s.workspaces` tolerate a `kind: "home"` member:
      `activeWorkspace`/`activeGroup`/`activePane`, `patchPane`, `patchActiveWs`, `findPane`, `workspaceOfPane`,
      `allRepoRoots`, `PaneArea`, `TabStrip`. (All are repoId-agnostic; Home is a normal workspace to them —
      confirm by reading, no change expected.) **Confirmed by reading — no changes needed.**
- [x] 5.4 Confirm the mount/prune effects in `App.tsx` (the stale-restored-workspace prune, and the
      `wsDir`/`wsBase` effects reading `activeWorkspace(s)?.…`) still behave with Home always present and active;
      the prune must **never** remove the Home terminal (Home is not a restored orphan). Read to confirm.
      **Confirmed**: the prune operates on `persisted.workspaces` (the raw localStorage list) before `init` runs;
      Home is synthesized/reused inside `init` itself, entirely independent of the prune — updated
      `App.cov.test.tsx`'s prune test to assert Home survives alongside the pruned/kept lanes.
- [x] 5.5 **Anti-crash non-regression (known black-screen bug):** verify every selector added for Home returns a
      **stable reference** — no `useStore(s => …)` that fabricates a fresh `[]`/`{}`/object each render. Home is
      derived from the already-subscribed `workspaces` (stable) or from primitives (`s.activeWs`, `repos.length`,
      an id). Grep the touched components for new `useStore(` calls and confirm each returns a primitive or an
      existing ref. (This is the infinite-render-loop bug from the memory note — treat as a hard gate.)
      **Verified**: only two new `useStore(` calls added — `s.switchWorkspace` (stable action ref) and
      `s.repos.length > 0` (primitive boolean); `homeWs` itself is derived via plain `.find()` on the
      already-subscribed `workspaces` array, outside any selector.

## 6. Tests (`__tests__/`, `bun:test`)

- [x] 6.1 `init` — contextless boot: Home exists and is active (`activeWs === homeWs.id`, NOT `null`) — the
      empty-pane outcome no longer exists. (`store.cov.test.tsx`, `storeCommand.test.ts`)
- [x] 6.2 `init` — repo boot: Home exists but the repo lane is active; Home is present and not focused.
      (`store.cov.test.tsx`, `storeCommand.test.ts`)
- [x] 6.3 `init` — restored Home is reused, not duplicated (exactly one `kind: "home"` after init when a Home
      was persisted). (`store.cov.test.tsx`, `storeCommand.test.ts`)
- [x] 6.4 `init` — legacy persisted data with no `kind` loads without error, entries are `kind: "workspace"`,
      and a Home is ensured. (`store.cov.test.tsx`)
- [x] 6.5 `removeWorkspace(homeWs.id)` is a no-op (Home remains); `deleteWorkspace` refuses Home before any
      teardown. (`store.cov.test.tsx`, `teardown.test.ts`, `storeCommand.test.ts`)
- [x] 6.6 Rail grouping excludes Home from every repo group and from the `local` bucket (unit-test the grouping
      derivation with a Home + repo workspaces + a manual lane). Also assert the onboarding-empty case: with only
      Home present, `groups.length === 0` (so the rail shows the "add repository" onboarding, not a repo group).
      (`WorkspaceRail.cov.test.tsx`) **Note**: the spec's "Create a workspace offered once repositories exist"
      scenario (spec.md, Scenario) assumes a state — `repos.length > 0` AND `groups.length === 0` outside a
      filter — that is structurally unreachable given the existing "every known repo gets its own group" loop; a
      registered repo always renders its own (possibly empty) group, so onboarding's secondary action is only
      reachable in that filtered-to-nothing branch, which task 4.5 explicitly keeps on the "no workspace matches"
      message instead. Implemented per the literal task 4.5 condition (`groups.length === 0`); documented as a
      discrepancy for architect/reviewer sign-off rather than silently forcing a different condition.
- [x] 6.7 Follow the existing test-colocation convention used by `empty-startup-state` (real-store import must
      survive the full run — other files' `mock.module("../src/state/store", …)` leaks globally under raw
      `bun test`; the canonical runner is `bun test/cov.ts`, which isolates files). New store/rail/app tests were
      added to the existing colocated real-store files (`store.cov.test.tsx`, `storeCommand.test.ts`,
      `WorkspaceRail.cov.test.tsx`, `App.cov.test.tsx`) and the module-mocked `teardown.test.ts`; the TitleBar +
      `⌘0` tests live in `TitleBar.cov.test.tsx` / `keymap.cov.test.tsx`. Canonical `bun test/cov.ts` confirmed
      green (1530 pass / 0 fail).
- [x] 6.8 **TitleBar + `⌘0` surfacing tests.** (a) `TitleBar.cov.test.tsx`: the `~` Home button renders as a
      top-level entry when a Home terminal exists (independent of the rail), shows `~`, reflects active state
      (`aurora-titlebar-home--active`), switches to Home on click, and renders **no** `~` button when no Home
      exists. (b) `keymap.cov.test.tsx`: `⌘0` jumps to the Home terminal even with a different workspace active
      (resolves Home via `kind === "home"`). **Done** — both suites present and green under `bun test/cov.ts`.

## 7. Gates (build / lint / typecheck / real app)

- [x] 7.1 `bun run build` is clean (TypeScript strict — the new `kind` field must be exhaustively handled where
      the compiler flags it). **Verified**: `tsc && vite build` — clean.
- [x] 7.2 ESLint clean (`eslint.config.mjs`). **Verified**: `eslint src` — zero problems.
- [x] 7.3 Test suite green (new tests + existing suite) via the **canonical isolation runner** `bun test/cov.ts`
      (raw `bun test` mis-reports due to the documented global `mock.module` leak). **Verified**: 1530 pass /
      0 fail across 66 files, RESULT: GREEN (includes the new TitleBar `~` + `⌘0` tests).
- [x] 7.4 Confirm `cargo build` still clean (no Rust change expected — this is a guard, not new work).
      **Verified**: `git status --porcelain src-tauri/` empty (no Rust files touched); `cargo build` clean
      (321 crates compiled).
- [ ] 7.5 **Real-app check (WKWebView — cannot be confirmed by jsdom/tests):** launch the app; verify (a) a
      fresh contextless boot opens directly onto the Home terminal (no central empty pane, shell in `~`),
      (b) the Home `~` entry sits in the **TitleBar** (after the window controls, past a hairline), stays visible
      when the rail is collapsed, and is absent from the rail's repo/`local` groups, (c) with no repos/workspaces
      the rail shows the "add repository" onboarding while the Home terminal is still live in the content area,
      (d) Home has no trash affordance and cannot be removed, (e) switching Home ↔ a workspace (by click **and**
      via `⌘0`) shows each one's tabs/panes, (f) after relaunch Home returns as a fresh `~` terminal (not
      duplicated). Hand the visual pass to the **designer**. **NOT DONE by implementer** — explicitly out of
      scope per task instructions (static gates only; real-app WKWebView verification is the tester's job next).
