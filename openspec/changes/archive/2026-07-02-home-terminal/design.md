## Context

Aurora's state (`src/state/store.ts`) is a Zustand store where **everything terminal-related is
workspace-relative and id-based**:

- Selectors resolve through the active workspace: `activeWorkspace(s) = s.workspaces.find(w => w.id === s.activeWs)`,
  then `activeGroup` = `w.tabs[w.active]`, then `activePane` = `g.panes[g.active]` (L530–540).
- Every tab-strip mutation goes through `patchActiveWs(workspaces, activeWs, …)`; every pane mutation through
  `patchPane(workspaces, paneId, …)` (L558–574). PTY spawn reads `pane.cwd` + `workspace.env`
  (`Terminal.tsx` L198–202) and routes background PTYs via `findPane`/`workspaceOfPane` across **all**
  workspaces (L541–550).
- The server-tab lifecycle, `PaneArea` (renders mounted workspaces' panes), and `TabStrip` all key off this
  same `Workspace` shape.
- Persistence (`src/lib/workspace.ts`) serializes each workspace to `PersistedWs` and restores via `rehydrate`.

Since `empty-startup-state`, `init` (L636–685) synthesizes **no** lane on a contextless boot: `workspaces = []`,
`activeWs = null`, and `App.tsx` (L269–277) renders `<EmptyState/>` when `!hasActiveWs`. A repo boot still opens
that repo's lane. The store already carries `activeWs: string | null`, `initialized: boolean`, and
`removeWorkspace`'s `length <= 1` guard.

The product decision (fixed with the user): a permanent **Home terminal** that is *not* a workspace and *not* a
repo conceptually, always present, non-deletable, and active on a contextless boot so the app never opens
blank. Its surfacing is a **top-level TitleBar entry** — decoupled from the Workspaces rail entirely and always
visible even when the rail is collapsed (*revised*: initially planned as a pinned entry above the rail's groups;
moved to the TitleBar per user decision — "it shouldn't even be in the WorkspaceRail", the Home terminal must be
fully decorrelated from the repo/workspace zone).

## Goals / Non-Goals

**Goals:**
- A singleton Home terminal rooted at `~` that reuses the terminal engine with zero engine changes.
- Home is always present, non-deletable, and active on a contextless boot.
- Home is excluded from the rail's repo groups and the `local` bucket entirely; it surfaces as a top-level
  entry in the TitleBar, decoupled from the rail and visible even when the rail is collapsed.
- Home is reachable via a dedicated keyboard shortcut (`⌘0`) for quick, discoverable access from any state.
- Home persists identity + tab metadata; its PTYs re-spawn on activation like any workspace.
- No new Rust, no new dependency, no git/worktree/servers/scripts surface for Home.

**Non-Goals:**
- Multiple Home terminals, renaming Home, or closing Home.
- Any change to PTY/shell-integration/`src-tauri`.
- Any redesign of the visual language (designer owns the TitleBar entry's + rail-onboarding's final look).
- Keeping the central `EmptyState` pane. It becomes unreachable (Home is always active) and is **removed**, not
  kept as a fallback — see D5.

## Decisions

### D1 — Model Home as a `Workspace` with `kind: "home"`, NOT a separate store entity

**Chosen:** add `kind: "home" | "workspace"` to `Workspace`. Home is a normal `Workspace` value with
`repoId: null`, `dir: home`, `branch: null`, `baseBranch: ""`, and `kind: "home"`. The "not a workspace / not a
repo" requirement is enforced **only** at the UI layer (the rail excludes `kind: "home"` from its groups and the
`local` bucket, and Home is surfaced *outside* the rail as a top-level TitleBar entry) and the **eligibility**
layer (delete/adopt guards). The engine treats it like any workspace.

**Rejected alternative:** a separate `homeTerminal` field on the store with its own `tabs`/`active`/panes.

**Rationale (why reuse wins):** the pane/PTY/tab engine is *entirely* workspace-relative and reached through
`s.workspaces` + `activeWs`. A separate entity would force one of:
1. **Fork every selector and mutator** — `activeGroup`/`activePane` (must branch: is the active thing the Home
   terminal or a workspace?), `patchActiveWs`, `patchPane`, `findPane`, `workspaceOfPane`, `allRepoRoots`, the
   server-tab lifecycle, and `PaneArea`/`TabStrip` (which iterate `s.workspaces`). This is a broad, bug-prone
   surface (the tab strip, split logic, focus, and PTY routing would all need a second code path).
2. **Or make the engine iterate `[...workspaces, homeTerminal]`** everywhere — which is *exactly* a `kind`
   discriminator, but implicit and scattered instead of one typed field.

The cost of `kind` is small and localized: a handful of `.filter(w => w.kind !== "home")` at the rail grouping
and eligibility guards, plus one persisted field. The conceptual "Home is not a workspace" separation is a
**UI/product** concern, and UI is exactly where we enforce it — the runtime reuse of the engine is the whole
point. This trade-off (technical reuse vs. conceptual purity) is explicitly accepted: purity lives in the view,
reuse lives in the engine.

### D2 — `init` guarantees Home and activates it on a contextless boot

`init` becomes: rehydrate restored → **ensure Home** (reuse restored `kind: "home"`, else synthesize and
`unshift`) → keep the existing repo-boot-lane logic → resolve `activeWs`:

```
activeWs =
  (boot.activeWs && workspaces.some(w => w.id === boot.activeWs)) ? boot.activeWs
  : bootWs?.id                 // repo boot context wins when present
  : homeWs.id                  // contextless boot lands on Home (was: null)
```

So: repo boot → repo lane active, Home present but unfocused. Contextless boot → Home active. Restored session
with a valid persisted `activeWs` → that one wins (could be Home or a workspace). The empty state (`activeWs =
null`) is no longer produced by `init`.

Home is `unshift`ed **before** any repo boot lane so it sits first in `workspaces`, but UI ordering is not
driven by array position: the rail derives its own grouping (which excludes Home), and Home is surfaced
separately as a top-level TitleBar entry. So array order is not load-bearing for the UI — it only matters that
Home is findable and stable.

### D3 — Non-deletable via `kind` guards in BOTH the store and teardown

`removeWorkspace` returns `{}` when the target `kind === "home"` (in addition to `length <= 1`).
`deleteWorkspace` (`lib/teardown.ts`) early-returns a refusal for `kind === "home"` *before* the length/worktree
checks. The Home surface itself exposes no trash affordance (the TitleBar entry has none; Home never renders as
a rail `WorkspaceCard` at all, and the card's delete guard stays as belt-and-suspenders). Three layers so no
single omission can delete Home.

Because Home is now always present, `removeWorkspace`'s `length <= 1` guard also means the *last non-Home*
workspace can't strand the app — Home is always there.

### D4 — Persistence: add `kind` to `PersistedWs`, tolerate legacy records

`savePersisted` writes `kind`; `rehydrate`/`loadPersisted` default a missing `kind` to `"workspace"` (legacy
records predate the field). `init`'s "ensure Home" step means that even if a persisted Home record is somehow
absent or dropped, a fresh Home is synthesized — the invariant "Home always exists" holds regardless of stored
state. PTYs never persist (same as all workspaces), so restored Home comes back as a fresh `~` terminal.

### D5 — Delete the central `EmptyState` pane; onboarding lives in the rail

**Chosen:** remove `src/components/EmptyState.tsx`, its import in `App.tsx` (L15), and the `hasActiveWs`-gated
branch (`App.tsx:269-277`). The content column renders the active terminal unconditionally. The
"add repository / create workspace" onboarding moves into `WorkspaceRail`'s existing empty region
(`WorkspaceRail.tsx:543-555`), shown when there are no non-Home workspaces (`groups.length === 0`, which already
excludes Home from grouping per D1). (Home itself is not in the rail — it lives in the TitleBar — so the rail's
empty region reads purely as repo/workspace onboarding.)

**Why delete rather than keep as a fallback:** since `init` guarantees Home and makes it active on a
contextless boot (D2), `activeWs` is never `null` after boot and `hasActiveWs` is always true — the
`<EmptyState/>` branch is **strictly unreachable**. Dead onboarding code in the pane area is misleading: a
future reader would assume the app can land there, and it would drift out of sync with the real onboarding
surface (the rail). This **revises** the earlier "we don't delete EmptyState" position, which was correct only
while `empty-startup-state`'s contextless boot could still resolve to `activeWs = null`; Home removes that
possibility. `activeWs: string | null` and `initialized` (from `empty-startup-state`) stay — they are used for
mid-session states and boot sequencing, independent of the pane surface.

**Rail-onboarding placement (product decision):** onboarding is a **rail** responsibility. The rail already has
the pieces — an empty-state message (L543-555) and an add-repository control in the footer (`onAddRepo`, ~L590+)
— so this is a small consolidation, not new UI machinery. It reads naturally: with no repos/workspaces, the rail
says "you have no repos/workspaces yet — add a repository." The user still has a live terminal (Home, reachable
from the TitleBar) meanwhile, so the app is never blank and never blocks on onboarding. Final visual treatment is a **designer** surface; the
spec fixes the contract (rail owns onboarding; primary Add repository, secondary Create workspace when repos
exist), not the pixels.

### D6 — Surface Home as a top-level TitleBar entry, not a rail entry; add `⌘0` to jump to it

**Chosen (user decision):** the Home terminal is surfaced as a **top-level entry in the TitleBar** — placed on
the left, after the traffic-light window controls, set apart by a hairline divider — and is **always visible,
even when the rail is collapsed**. Its visible label is **`~`** (a descriptive `aria-label`/`title` is kept for
accessibility; the `title` also advertises the shortcut). A dedicated keymap shortcut **`⌘0`** jumps to the Home
terminal from anywhere.

**Rejected alternative (the initial plan):** rendering Home as a **pinned entry inside the `WorkspaceRail`,
above the repo/`local` groups**. This is what proposal.md and the first draft of this design described.

**Rationale:** the user's requirement is that the Home terminal be *fully decorrelated* from the repo/workspace
zone — "it shouldn't even be in the WorkspaceRail". A pinned rail entry still visually and structurally ties Home
to the rail (it would ride the rail's collapse/expand state and sit amid workspace grouping). Lifting it into the
TitleBar makes Home a persistent front door that is orthogonal to the whole repo/workspace surface: reachable
whether or not the rail is open, and never confused with a workspace. `⌘0` (a `⌘` binding handled in
`keymap.ts`'s pane-independent `⌘` block, alongside `⌘,`/`⌘K`/`⌘B`) gives it fast, discoverable keyboard access
regardless of pane focus; the TitleBar button's `title` announces the shortcut. This does **not** touch the
engine reuse (D1), the boot/activation logic (D2), the non-deletable guards (D3), or the `EmptyState`
removal/rail-onboarding decision (D5) — Home is still a `kind: "home"` workspace resolved through `activeWs`; only
its *surfacing* moved from the rail to the TitleBar.

## Risks / Trade-offs

- **[Conceptual leak: Home is technically a `Workspace`]** → Mitigated by enforcing exclusion at the rail
  (groups + `local` bucket filtered on `kind`) and by the delete/adopt guards. Any future code that iterates
  `s.workspaces` and assumes "each is a real workspace" must consider Home; the `kind` field makes that
  explicit and greppable. Add a task to grep for `s.workspaces`/`.repoId`-assuming call sites and confirm each
  tolerates a `kind: "home"` member (they already do, since Home is `repoId: null` and every repo/worktree
  guard short-circuits on that).
- **[Duplicate Home on restore]** → `init` must reuse the restored `kind: "home"` workspace by matching on
  `kind`, not by id/dir, and must synthesize only when none is found. Covered by a test (restored Home is
  reused, not duplicated).
- **[Regression: Zustand fresh-ref selector crash]** → The known black-screen bug is a `useStore` selector that
  returns a **new** `[]`/`{}` each render, causing an infinite render loop (see memory: "Aurora Zustand
  selector crash"). Any new selector added for Home (e.g. "the Home workspace", "is Home active") MUST return a
  stable reference: select the raw `s.workspaces`/`s.activeWs` (stable refs) and derive Home with `.find`
  **outside** the selector or via a primitive/`useMemo`, OR select a primitive (`s.activeWs`, an id). Never
  `useStore(s => s.workspaces.find(...) ?? SOME_NEW_OBJECT)` that fabricates a fresh object. Explicit
  non-regression task in `tasks.md`.
- **[`empty-startup-state`'s central pane now unreachable]** → Accepted and intended. Per D5 the `EmptyState`
  component and its `App.tsx` branch are **deleted** (not kept), and its onboarding moves to the rail. The
  store shape it introduced (`activeWs: string | null`, `initialized`) **stays** — still used for boot
  sequencing and mid-session states. Reconcile on logic: this change removes the empty *pane* and makes Home
  the boot outcome; it does not touch the `activeWs`/`initialized` state contract.
- **[Servers/scripts/MR/Jira accidentally offered on Home]** → All key off `repoId`/worktree and already
  short-circuit on `repoId: null` (verified: `servers.ts` L149 `if (!ws.repoId) return`, `teardown.ts` L33
  `if (w.repoId != null)`, rail trash guard L60 `if (!ws.repoId || ws.dir === ws.repoId)`). Home keeps
  `repoId: null`; the `kind` guard adds an explicit block on any adopt-repo path so Home can't become a repo
  lane.

## Migration Plan

- Purely additive to persisted data (`kind` optional, defaults to `"workspace"`). No migration; legacy records
  load unchanged and a fresh Home is ensured by `init`.
- Rollback: revert the change; persisted `kind` fields are simply ignored by the older code (they were never
  read there), and the older `init` reverts to its prior empty-state boot.

## Open Questions

- **~~Home's display name/wordmark~~ — RESOLVED (user).** The visible label is **`~` alone** — no "Home"
  wordmark, no "shell" text. A descriptive `aria-label`/`title` (e.g. "Home terminal — always-on shell in ~") is
  kept for accessibility and discoverability, and the `title` advertises the `⌘0` shortcut. The remaining visual
  treatment of the TitleBar entry (glyph styling, hairline separator, active indicator) is still a **designer**
  surface; the spec fixes the contract (top-level TitleBar entry, decoupled from the rail, visible when the rail
  is collapsed, shows active state, no trash), not the pixels.
- **~~Does the collapsed-rail `WorkspaceSwitcher` need a distinct Home affordance~~ — MOOT.** Home was moved out
  of the rail entirely and now lives as a top-level TitleBar entry, always visible regardless of the rail's
  collapsed/expanded state. There is therefore no collapsed-rail Home-affordance question to answer: Home is
  reachable from the TitleBar (and via `⌘0`) independently of the rail. (The `WorkspaceSwitcher` still shows the
  active pill as before; it simply no longer carries any Home responsibility.)
- **Rail onboarding visual treatment** — the exact copy and layout of the rail's empty state (add repository /
  create workspace), shown when there are no repos/workspaces — **designer** decides. The spec fixes the contract
  (rail owns onboarding; Add repository primary, Create workspace secondary when repos exist), not the pixels.
