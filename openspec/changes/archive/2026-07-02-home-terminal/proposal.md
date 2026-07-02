## Why

Aurora's whole surface is built around **Workspaces** (repo-grouped, worktree-backed, per-branch). Since
`empty-startup-state` landed, a launch with no repo context and nothing restored settles on **zero
workspaces** and shows an empty state that invites the user to *add a repository*. That is correct for the
"I came here to work on repos" path, but it strands the simplest user: someone who just wants **a terminal**.
They should not have to create or adopt a Workspace, pick a repo, or manage a worktree just to get a shell in
their home directory.

We want a permanent, first-class **Home terminal** — a normal terminal that starts in `~`, is always present,
is never deletable, and is what the app opens to on a contextless boot. It is conceptually **not a workspace
and not a repo**: it does not appear in the workspace rail's repo groups nor in the `local` bucket. It is the
front door for a user who never touches Workspaces, and it guarantees the app never boots to a blank/empty
screen again.

## What Changes

- **New permanent "Home" terminal**, a singleton that behaves like a normal terminal rooted at the user's home
  directory (`~`). It has its own tab strip and panes (the full terminal engine), but **no repo, no branch, no
  worktree, no git, no servers**.
- **Modeled as a `Workspace` with a `kind: "home"` discriminator** (existing workspaces become
  `kind: "workspace"`). This reuses the entire pane/PTY/tab engine unchanged (`activeGroup`/`activePane`,
  `patchPane`, `patchActiveWs`, `PaneArea`, `TabStrip`, `switchWorkspace`, PTY spawn). The "not a
  workspace/not a repo" constraint is enforced at the **UI grouping** and **eligibility** layers, not by
  forking the engine. See `design.md` for the rejected "separate `homeTerminal` entity" alternative.
- **`init` always guarantees the Home terminal exists** and, on a contextless boot (no repo, and no valid
  restored active workspace), makes it **active** — so the app opens directly onto a live terminal instead of
  the empty state. When a repo boot context exists, the repo's workspace still wins as active; Home is present
  but not focused.
- **Surfacing (TitleBar, not the rail)**: the Home terminal is surfaced as a **top-level entry in the
  TitleBar** — placed after the traffic-light window controls, set apart by a hairline divider — and is
  **always visible, even when the rail is collapsed**. Its visible label is **`~`** (a descriptive
  `aria-label`/`title` is kept for accessibility). It is **excluded** from the rail entirely: neither in the
  repo groups nor in the `local` bucket (the rail groups only iterate `kind === "workspace"`). *Revised*:
  initially planned as a **pinned entry at the top of the rail**; moved to the TitleBar per the user's decision
  that Home must be fully decoupled from the repo/workspace zone ("it shouldn't even be in the WorkspaceRail").
  See design.md D6.
- **Keyboard access**: a dedicated shortcut **`⌘0`** jumps to the Home terminal from anywhere (a `⌘` binding
  handled in `keymap.ts`'s pane-independent block; the TitleBar button's `title` announces it).
- **Non-deletable / permanent**: no trash affordance on the Home entry; `removeWorkspace` / `deleteWorkspace`
  refuse to remove a `kind: "home"` workspace. It is not created from, and cannot be turned into, a repo
  workspace.
- **Persistence**: the Home terminal (its identity + tab layout metadata, like any workspace) persists and is
  restored across relaunches. As with all workspaces, **PTYs do not survive a relaunch** — panes re-spawn on
  activation; the Home terminal comes back as a fresh terminal in `~`. Its persisted `kind` lets `init`
  recognize and reuse it rather than duplicate it.
- **The central-pane empty state is removed; onboarding moves into the rail.** Because Home is always the
  active terminal (`activeWs` is never `null` after `init`), the central `EmptyState` pane
  (`App.tsx:269-277`, rendered when `!hasActiveWs`) is now **strictly unreachable**. We **delete** the
  `EmptyState` component, its import (`App.tsx:15`), and the `hasActiveWs`-gated branch — the content column
  always renders the active terminal (`WorkspaceContextBar + TabStrip + PaneArea`). Keeping dead, unreachable
  onboarding code would be misleading; see `design.md` D5 for why we delete rather than keep it as a fallback
  (this revises the earlier "we don't delete EmptyState" note, which held only while a contextless boot could
  still land there).
- **The "add a repository / create a workspace" onboarding is now the rail's empty state.** The `WorkspaceRail`
  already renders an empty-state message (`WorkspaceRail.tsx:543-555`, `"no workspaces yet"`) and an
  add-repository control in its footer (`onAddRepo`, ~L590+). This change turns that rail region — shown when
  there are **no non-Home workspaces / no repos** — into the real onboarding affordance: a primary **Add
  repository** action and, when repos already exist, a **Create a workspace** action. Onboarding is a **rail**
  responsibility, not a pane responsibility. (Home is not in the rail — it lives in the TitleBar — so this
  region reads purely as repo/workspace onboarding.)
- **BREAKING** (behavioral): a fresh, outside-a-repo launch opens the Home terminal (with the rail showing its
  add-a-repository onboarding) instead of a central "add a repository" empty pane.

Non-goals:
- **No change to the terminal engine, PTY, or shell integration.** Home reuses them verbatim. `src-tauri`
  already falls back to `$HOME` when `cwd` is empty; Home passes `dir = home` explicitly, so no Rust change.
- **No git/worktree/servers/scripts/MR/Jira surface for Home.** Every existing guard that keys off
  `repoId`/worktree already short-circuits for `repoId: null`; Home keeps `repoId: null` and additionally its
  `kind` blocks any repo-adoption path. No new guard logic beyond the `kind` checks.
- **No redesign of the visual language.** Inline styles + existing `tokens.css`/`global.css` classes, dark
  theme, green accents, monospace. The TitleBar entry's final visual treatment is a **designer** surface.
- **No multiple Home terminals, no renaming, no "close Home".** It is a singleton.
- **No security surface** (no auth/data/payment).

## Capabilities

### New Capabilities
- `home-terminal`: a permanent, singleton **Home terminal** — a repo-less, worktree-less terminal rooted at
  the user's home directory, modeled as a `kind: "home"` workspace so it reuses the pane/PTY/tab engine,
  surfaced as a top-level TitleBar entry (labelled `~`, outside the rail and its repo/`local` groups, visible
  even when the rail is collapsed, reachable via `⌘0`), non-deletable, persisted and restored across relaunches,
  and made active on a contextless boot so the app never opens to an empty state.

### Modified Capabilities
<!-- No promoted baseline spec exists under openspec/specs/ for startup/workspace-bootstrap or for the
     empty-startup behavior (only merge-request-search and workspaces-intro-dialog are promoted). The
     empty-startup-state change that this supersedes-at-boot is itself still an unarchived change, not a
     baseline. As with empty-startup-state and responsive-ui-layout, this behavior is captured as a new
     additive capability rather than a delta to a non-existent baseline. The interaction with
     empty-startup-state is documented in design.md and tasks.md (Reconcile-on-logic note). -->

## Impact

- **`src/state/store.ts`**
  - `Workspace` gains `kind: "home" | "workspace"` (default `"workspace"` for existing/created lanes).
  - `CreateWorkspaceOpts` / `newWorkspace` accept an optional `kind`; `rehydrate` reads persisted `kind`
    (defaulting missing/legacy values to `"workspace"`).
  - `init`: **always ensure a Home workspace exists** — reuse a restored `kind: "home"` one, else synthesize
    `newWorkspace({ kind: "home", repoId: null, title: "Home", dir: home, branch: null, baseBranch: "" })` and
    `unshift` it (kept at the top). Keep the existing repo-boot-lane logic. `activeWs` resolution: valid
    `boot.activeWs` → else the boot repo lane → else the Home workspace id (contextless boot now lands on
    Home, **not** `null`). The Home workspace is mounted when it is active.
  - `removeWorkspace`: refuse when the target `kind === "home"` (return `{}` / no-op), in addition to the
    existing `length <= 1` guard.
  - Home is excluded from any repo-derivation (`deriveRepos` already ignores `repoId: null`; confirm Home
    never contributes a repo).
- **`src/lib/workspace.ts`** — `PersistedWs` gains `kind`; `savePersisted` writes it; `loadPersisted`
  round-trips it (tolerating legacy records with no `kind`). No key/format break beyond an added optional
  field.
- **`src/lib/teardown.ts`** — `deleteWorkspace`: early-return refusal for `kind === "home"` (before the
  `length`/worktree checks), so the Home terminal can never be torn down. (Its `repoId: null` already skips
  the worktree path; the `kind` guard makes the refusal explicit and independent of workspace count.)
- **`src/components/TitleBar.tsx`** — render the **Home terminal entry** as a top-level TitleBar button,
  placed after the traffic-light window controls and set apart by a hairline divider. It shows `~` as its label
  (`aria-label`/`title` descriptive, `title` announces `⌘0`), reflects active state (`activeWs === homeWs.id`),
  and calls `switchWorkspace(homeWs.id)` on click. `homeWs` is derived from the already-subscribed `workspaces`
  array (stable ref — see Non-regression); it exposes **no trash affordance** and stays visible regardless of
  the rail's collapsed/expanded state.
- **`src/lib/keymap.ts`** — add **`⌘0`** in the pane-independent `⌘` block (alongside `⌘,`/`⌘K`/`⌘B`, above
  the active-pane bail): find the `kind === "home"` workspace and `switchWorkspace` to it, so Home is reachable
  from anywhere regardless of pane focus.
- **`src/components/WorkspaceRail.tsx`** — (a) **exclude** `kind: "home"` from both the per-repo groups and the
  `local` bucket (`shown`/`manual` filter on `kind !== "home"`) so Home never appears in the rail (it lives in
  the TitleBar instead — see above). (b) **Own the onboarding empty state**: the existing empty region
  (L543-555, currently just `"no workspaces yet"`) becomes the onboarding surface — primary **Add repository**
  (reusing `onAddRepo` / `addRepoFromFolder`, already in the footer ~L590+) and, when `repos.length > 0`, a
  secondary **Create a workspace** (`openCommand()`). Shown when there are no non-Home workspaces (i.e.
  `groups.length === 0`, which already excludes Home). Final visual treatment is a **designer** surface.
- **`src/components/WorkspaceCard.tsx`** (or wherever the trash affordance lives) — hide/disable delete for
  `kind: "home"` (belt-and-suspenders with the store/teardown guards).
- **`src/App.tsx`** — **remove** the central empty-state branch: delete the `EmptyState` import (L15), drop the
  `hasActiveWs`-gated `<EmptyState/>` (L269-277), and render the active terminal
  (`WorkspaceContextBar + TabStrip + PaneArea`) unconditionally in the content column (Home is always active).
  Drop the now-unused `hasActiveWs` selector (L42) if nothing else reads it.
- **`src/components/EmptyState.tsx`** — **deleted.** No consumer remains after the `App.tsx` edit; the
  onboarding it carried moves into `WorkspaceRail`.
- **`src-tauri/`** — **no change.** Home spawns PTYs with `cwd = home`; the `$HOME` fallback in `pty.rs` is
  not even exercised.
- **Reuses unchanged**: the full pane/PTY/tab engine (`activeGroup`/`activePane`/`patchPane`/`patchActiveWs`/
  `PaneArea`/`TabStrip`), `switchWorkspace`, `WorkspaceSwitcher` (reads `activeWorkspace`, which resolves to
  Home fine), `StatusBar`. (`TitleBar` gains the Home entry — see Impact above — so it is *not* unchanged.)
- **`__tests__/`** — store-init tests (`bun:test`) for: Home always exists; contextless boot activates Home
  (not `null`); repo boot keeps Home present but repo-active; restored Home is reused (not duplicated);
  `removeWorkspace`/`deleteWorkspace` refuse Home; rail grouping excludes Home from repo/`local` groups; the
  `⌘0` keymap binding switches to Home.
