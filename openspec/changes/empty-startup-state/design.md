# Design — empty-startup-state

## Audit: where "≥1 workspace always exists" is assumed (file:line)

Read against HEAD `5403921` + working tree. Line numbers are indicative (an in-flight edit is touching
`store.ts` `init`); the logic, not the lines, is load-bearing.

| # | Location | Current behavior | Empty-state impact |
|---|---|---|---|
| 1 | `store.ts` `init` (~624-662) | `bootDir = boot.repo ? boot.repo.root : home`; if no ws matches `bootDir`, `newWorkspace(...)` + `workspaces.unshift(bootWs)`; for no-repo → a manual home lane `{repoId:null, dir:home}`. `activeWs` falls back to `bootWs.id`. | **Root cause.** Must not synthesize a lane when `boot.repo == null` and nothing restored. |
| 2 | `store.ts` state (246, 598) | `activeWs: string`, initial `""`. | Must become `string \| null`. |
| 3 | `lib/workspace.ts` `savePersisted` (70) | param `activeWs: string`. `loadPersisted` (56-68) already returns `string \| null` and round-trips `null`. | Widen the save param to `string \| null`. |
| 4 | `store.ts` selectors (519-529) | `activeWorkspace/activeGroup/activePane` return `\| undefined`. | Already defensive — no change. |
| 5 | `store.ts` `removeWorkspace` (712) + `teardown.ts` `deleteWorkspace` (22) | both guard `length <= 1`. Trash shows only on worktree-backed non-last cards (`WorkspaceRail.tsx` 72-75). | Keep guards; empty is unreachable post-startup (see Non-goal). |
| 6 | `store.ts` `createWorkspace` (664-678) | sets `activeWs: ws.id`. `addRepo` (694-700) only appends to `repos[]`. | `createWorkspace` is the exit; `addRepo` alone does **not** exit empty (by design). |
| 7 | `App.tsx` `ready` (39) + gate (234) | `ready = workspaces.length > 0`; `if (!ready) return null`. | **Blocker.** Empty boot would render blank forever. Switch to an `initialized` flag. |
| 8 | `App.tsx` render (255-263) | always renders bars + `TabStrip` + `PaneArea`; effects (138-169) guard on `apId/wsId/wsDir`. | Swap the center stack for the empty state when no active ws. |
| 9 | `TabStrip.tsx` (18-19) | `activeWorkspace(s)?.tabs ?? []`, `?.active ?? 0`. | Renders an empty strip with dead `+`/`⊟`; gate it out in empty state. |
| 10 | `TitleBar.tsx` (15) | `activeWorkspace(s)?.branch ?? null` → "zsh". | Safe. `WorkspaceSwitcher` shown when rail collapsed. |
| 11 | `StatusBar.tsx` (11-14) | all coalesced; shows "~" + generic hints. | Safe (kept). |
| 12 | `WorkspaceRail.tsx` (536-548, 583-604) | `groups.length === 0` → "no workspaces yet"; bottom "Add repository" → `addRepoFromFolder`. `WorkspaceContextBar` (626) `if (!ws) return null`. | Safe; already a decent rail affordance. |
| 13 | `WorkspaceSwitcher.tsx` (34-37, 245-247) | `active ? … : "no workspace"`; "New workspace" → `openCommand()`. | Safe. |
| 14 | `WorkspaceCommand.tsx` (71-82) | `repo` falls back to `repos[0]`; `noContext = repos.length>1 && !active && !targetRepoId`. | Already handles no active ws. With 0 repos it cannot create (expected — Add repo first). |
| 15 | `keymap.ts` (203-204) | `const pane = activePane(s); if (!pane) return;` | **All** shortcuts (⌘K/⌘T/⌘B/⌘,…) no-op in empty state. See Risk R1. |
| 16 | `scripts.ts` (162-167); `ScriptsSheet` (15), `MrSheet` (29), `ScriptsSetupModal` (43) | `activeGroup`/`activePane` reads. | Panels/modals aren't reachable in empty state; already undefined-tolerant reads. Low risk. |

**Verdict:** the selector layer is already null-tolerant. The only hard blockers are (1) `init` synthesizing
a lane and (7) the `ready` proxy. Everything else is either already safe or a cosmetic gate.

## `init` — target logic (reason on logic, not line numbers)

```
workspaces = boot.restored.map(rehydrate)

bootWs = undefined
if (boot.repo) {                                   // a repo launch is a real context
  bootDir = boot.repo.root
  bootWs = workspaces.find(w => w.dir === bootDir) // reuse a restored ws at the repo root
  if (!bootWs) { bootWs = newWorkspace({ repoId: boot.repo.root, ... }); workspaces.unshift(bootWs) }
}
// boot.repo == null  → never synthesize a home/manual lane

activeWs =
    (boot.activeWs && workspaces.some(w => w.id === boot.activeWs)) ? boot.activeWs
  : bootWs ? bootWs.id
  : workspaces.length ? workspaces[0].id            // restored, no repo launch, stale activeWs
  : null                                            // 0 repo context + 0 restored → EMPTY

for (w of workspaces) w.mounted = (w.id === activeWs)   // activeWs null → nothing mounted
set({ ..., workspaces, activeWs, initialized: true })
savePersisted(workspaces, activeWs)
```

Only behavioral delta: the manual home lane is gone. Repo launches, restored sessions, and the reuse of a
restored ws at the repo root are unchanged.

## Empty-state surface (contract; designer owns the visuals)

- **When:** the content column (right of the rail) shows the empty state whenever there is no active
  workspace (`activeWorkspace(state) === undefined` / `activeWs == null`). It replaces
  `WorkspaceContextBar + TabStrip + PaneArea` for that render; `TitleBar`, `WorkspaceRail`, and
  `StatusBar` still render (all already null-safe).
- **What it must expose:**
  - a title / wordmark and a one-line invitation to add a repository;
  - a **primary action "Add repository"** that runs `addRepoFromFolder()` with the same busy/error
    handling the rail uses (`addBusy`, `addError`);
  - **when `repos.length > 0`**, a **secondary action "Create a workspace"** that runs `openCommand()`.
- **Styling:** tokens only (`--fg`, `--dim`, `--faint`, `--ac`, `--acd`, `--page`, `--line`, `--mono`,
  `--sans`), dark theme + green accents, inline styles + `global.css` classes per convention. No new
  dependency. Hand to the **designer** (`/frontend-design`) for the final treatment.
- **Exit:** Add repository registers the repo in the rail (does not itself create a workspace) → the user
  creates the first workspace via the rail's "+ New workspace in <repo>", the empty-state "Create a
  workspace", or the palette → `createWorkspace` sets `activeWs` → the empty state disappears. No new
  create path.

## `initialized` flag

`App`'s readiness must mean "boot ran", not "≥1 workspace". Add `initialized: boolean` (default `false`),
set `true` at the end of `init`; `ready = useStore(s => s.initialized)`. This is the minimal correct
separator — there is no existing signal that distinguishes "pre-init empty" from "post-init empty" (that
is exactly why the old `workspaces.length` proxy breaks).

## Decisions & alternatives rejected

- **`initialized` flag** vs. reusing `workspaces.length` (rejected — the broken proxy) or an `activeWs`
  sentinel (rejected — implicit).
- **`activeWs: string | null`** vs. keeping `""` as "none" (rejected — `null` is explicit and already what
  `loadPersisted` returns; `w.id === activeWs` stays correct with `null`).
- **`init` never synthesizes a manual lane** vs. the in-flight fix's "keep a lane when `length === 0`"
  (this change supersedes it) and vs. always creating a lane (the current bug).
- **Reuse `addRepoFromFolder` + `openCommand`** for the empty-state actions vs. a new store action
  (rejected — unnecessary; only `initialized` is new).
- **Do NOT support "return to empty" by closing the last workspace (v1 non-goal).** Justification:
  (a) it is not reachable in the current UI — `removeWorkspace`/`deleteWorkspace` both guard `length <= 1`
  and the trash is hidden on the last card and blocked for the main checkout / manual lanes;
  (b) enabling it broadens scope (relax two guards, set `activeWs = null` after removal, decide the
  worktree's disposition) with no user demand; (c) the feature is specifically about *startup*. Keeping the
  guards means the **only** route into the empty state is an empty boot — one code path to reason about.

## Risks

- **R1 — ⌘K dead in empty state.** `keymap.ts` bails when there is no active pane, so ⌘K/⌘T/⌘B, etc. are
  no-ops with zero workspaces. Creating the first workspace must therefore go through an on-screen CTA
  (rail "Add repository"/"New workspace", or the empty-state actions). Acceptable for v1; a later change
  could let ⌘K open the palette without a pane. Documented, not fixed here.
- **R2 — reconciling with the in-flight `store.ts` `init` edit.** The implementer must integrate on logic:
  replace the "`length === 0` keeps a lane" fallback with the empty resolution above. Do not anchor to
  line numbers.
- **R3 — a consumer that dereferences `activeWorkspace`/`activePane` assuming non-`undefined` after init.**
  The audit found none (all optional-chain or early-return). Regression tasks re-verify the reachable
  surfaces and the panel/modal reads.
- **R4 — persistence of the empty state.** `savePersisted([], null)` must write and reload cleanly to
  `{ workspaces: [], activeWs: null }`; the code already round-trips `null`. Covered by a test.
