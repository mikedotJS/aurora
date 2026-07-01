# Design — workspaces-intro-dialog

Read against HEAD `73adf46` (clean working tree). Line numbers are indicative — reason on the logic.

## Audit: integration points (file:line, verified by reading)

| # | Location | Current behavior | Intro-dialog relevance |
|---|---|---|---|
| 1 | `App.tsx` boot effect (71-131) | loads `aurora.settings` (76-77: `settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }`), then `useStore.getState().init(home, settings, present, boot)` (104). `aurora.scripts` / connections / `aurora.repoconfig` are loaded **after** `init` via dedicated setters (113, 119-121). | The settings object already round-trips localStorage → `init`. Adding `introSeen` to `Settings` means the flag flows through this path with **zero new boot wiring**. |
| 2 | `App.tsx` render gate (40, 236) | `ready = s.initialized`; `if (!ready) return null`. | The intro renders only past this gate, so `initialized` is always true when it mounts — no "boot not finished" flash. |
| 3 | `App.tsx` content column (257-269) | `hasActiveWs ? (WorkspaceContextBar + TabStrip + PaneArea) : <EmptyState />`. | Untouched. The intro is an **absolute overlay over the whole root**, so it covers EmptyState *or* a workspace; on dismiss the user sees whatever is underneath. No coordination code needed. |
| 4 | `App.tsx` overlay stack (272-279) | `{panel === "mr" && …}`, `{settingsOpen && <SettingsModal />}`, `{commandOpen && <WorkspaceCommand />}`, … all siblings inside `#aurora-root`. | Mount point: add `{!introSeen && <WorkspacesIntro />}` here, last, top-most z-order. |
| 5 | `store.ts` `Settings` (33-41) + `DEFAULT_SETTINGS` (49-56) | 6 user-facing prefs (model, accent, fontSize, ghost, notifyMr, autoRenameTabs). | Add `introSeen: boolean` + default `false`. Semantic note below (not a user-facing pref). |
| 6 | `store.ts` `init` (629-679) | `set({ home, settings, apiKeyPresent, repos, workspaces, activeWs, initialized: true })` (677) — **settings and `initialized` set atomically**; then `savePersisted` (678). | No change. Because `settings` (carrying `introSeen`) is set in the **same** `set()` as `initialized`, `store.settings.introSeen` is authoritative the instant `ready` flips true. This is why the flag-in-settings approach is flash-safe. |
| 7 | `store.ts` `setSetting` (1155-1165) | writes `aurora.settings` + `applyTheme(accent, fontSize)`. | `dismissIntro()` can delegate here (`setSetting("introSeen", true)`), reusing the persist path; the `applyTheme` re-apply is idempotent/harmless. |
| 8 | `store.ts` `openSettings`/`closeSettings` (1167-1168) | trivial `set({ settingsOpen })`. | Model for `dismissIntro()` placement + shape. |
| 9 | `keymap.ts` overlay guards (204-242) | form-field bail (204-205); then a stack of `if (s.scriptsSetupOpen)` / `if (s.settingsOpen)` / `if (s.command)` / `if (s.panel)` / find-guard — each handles `Escape` (preventDefault + close) and `return`s. **All above** the app-level ⌘ block (249-253) and `const pane = activePane(s); if (!pane) return` (255-256). | Add an intro guard here (first, since it's the top-most modal). Because it's above `if (!pane) return`, Esc works at first-run when there is **no pane**. While open it `return`s on every key → keyboard-modal (⌘K etc. can't fire). |
| 10 | `SettingsModal.tsx` (133-200) | overlay `position:absolute; inset:0; zIndex:60; flex center; padding`; backdrop `<div onClick={close} inset:0 background:color-mix(black 55%) fadeIn>`; panel `var(--win)` + `1px solid var(--line)` + radius 14 + shadow + `popIn`; header with `×` close. | The chrome to **reuse**. Intro differs in two deliberate ways: **backdrop is not a dismissal target**, and z-index sits above every existing overlay. |
| 11 | z-index landscape (grep) | SettingsModal 60; WorkspaceSettings 70; WorkspaceCommand 80 (repo menu 89/90). None open at first-run. | Intro uses **z-index 100** — unambiguously the top layer, above any toast/overlay that could co-exist. |
| 12 | `test/setup.ts` + `bunfig.toml` + `test/cov.ts` | preload registers happy-dom + writable `localStorage` + Tauri/xterm mocks; isolated per-file runner. Modal test template: `SettingsModal.cov.test.tsx` (`useStore.setState` in `beforeEach`, `render`/`fireEvent`/`screen`). | Feature tests slot in unchanged: component render + dismiss, store `dismissIntro`, keymap Esc. |

**Verdict:** the only production files that change are `store.ts` (2 field additions + 1 action),
`App.tsx` (1 selector + 1 conditional mount), `keymap.ts` (1 guard), and the new `WorkspacesIntro.tsx`.
The boot path, empty state, responsive rail, and crash fix are untouched.

## Key decisions

### D1 — Flag storage: field in `aurora.settings` (chosen) vs. dedicated `aurora.introSeen` key

**Chosen: `introSeen: boolean` on the `Settings` type**, persisted via the existing `aurora.settings`
write.

Reasons:
1. **Smallest change.** The settings object is already loaded in the boot effect (`App.tsx` 76-77) and
   handed to `init`. No new localStorage read, no new `init` param, no new top-level store field.
2. **Flash-safe by construction.** `init` sets `settings` **and** `initialized` in the same `set()`
   (line 677). So the moment `ready` flips true, `store.settings.introSeen` is already correct. A
   returning user (flag = true) never sees a one-frame flash of the dialog.
3. **Reuses the persist path.** `dismissIntro()` delegates to the existing `setSetting` write to
   `aurora.settings`.

**Rejected: dedicated `aurora.introSeen` key + top-level store field.** It is *semantically* cleaner
(`Settings` would stay "user-facing prefs only"; matches the separate-key precedent of `aurora.scripts` /
`aurora.repoconfig` and the top-level `initialized` flag). But to be equally **flash-safe** it must be
passed **into** `init` (a new parameter) so it lands atomically with `initialized`; loading it via a
post-`init` setter (the way scripts/connections are, after an `await`) opens a window where
`initialized === true` but the flag still holds its store default → a **flash of the intro** for users
who already dismissed it. That extra `init`-signature plumbing to avoid the flash makes it strictly more
code than the settings-field approach for no behavioral gain.

**Accepted cost of the chosen approach:** `introSeen` is onboarding state, not a user-configurable
preference, so it lives in `Settings` without a `SettingsModal` row — a minor semantic smell. Mitigated
with a clear code comment (`// onboarding: one-time intro-seen flag; persisted with settings, not
user-facing`).

### D2 — Boolean flag, not version gating

A single boolean satisfies the requirement ("seen once by everyone, never again"). Version gating
(store the last-seen app version, show when it changes) is **rejected**: it is a "what's new" framework
we don't need, it requires threading the app version into the webview, and this release only needs one
intro. Explicitly out of scope (see Non-goals).

### D3 — Dismissal model: single "Got it", Esc-equivalent, backdrop inert

- **"Got it"** is the one deliberate CTA → `dismissIntro()` (persist + close).
- **Esc = "Got it".** Consistent with every other overlay in `keymap.ts` (all close on Esc). Since the
  only exit persists, Esc also persists — there is intentionally no "peek then re-show". This is
  acceptable because the dialog is purely informational (nothing to cancel).
- **Backdrop click does NOT dismiss** (unlike `SettingsModal`). A one-time, never-repeated message
  should not be permanently consumed by a stray click on the scrim. Only the explicit CTA and Esc
  dismiss.

### D4 — Render position & modality

The dialog mounts in `App.tsx`'s overlay stack, **after** the render gate (`if (!ready) return null`),
as an absolute overlay (`inset:0`) at **z-index 100**, above `EmptyState` and any conceivable co-existing
overlay/toast. While open, the `keymap.ts` guard swallows all keys, so the app is keyboard-modal behind
it. Focus moves to the "Got it" button on mount (`role="dialog"` + `aria-modal="true"` +
`aria-labelledby` on the title). Note: Aurora runs in WKWebView — visual/focus behavior must be
confirmed in the **real app**, not only jsdom/happy-dom (per project memory on UI verification).

### D5 — Content is a designer surface

`WorkspacesIntro.tsx` isolates its content in one clearly-commented block near the top of the file — a
title string, a small array of value props (`{ title, desc }`, seeded with the four candidate props:
isolated per-ticket/branch worktrees, run/stop dev servers, Jira & GitLab integration, isolated ports),
and an optional visual slot. The **gating/dismissal logic is stable**; the designer edits copy/visual +
picks the final 2-3 props without touching it. This proposal does **not** fix final copy.

## Risks

- **R1 — localStorage wiped ⇒ intro re-shows.** If a user clears app storage (or moves to a new machine),
  `introSeen` resets to `false` and the dialog shows again. Accepted: identical to *all* Aurora persisted
  state (settings/scripts/repoconfig also reset); persisting to the keychain or a Tauri config file for a
  cosmetic one-time dialog is over-engineering.
- **R2 — Flash-of-intro for returning users.** Mitigated by the settings-field approach (D1): the flag is
  set atomically with `initialized` in `init`, so it is authoritative the instant the app renders. The
  rejected dedicated-key-via-post-init-setter approach would have this bug.
- **R3 — Mount order vs. empty state / other overlays.** Mitigated by z-index 100 and mounting last in
  the overlay stack (D4). At genuine first-run no other modal is open anyway.
- **R4 — Esc consumes the intro.** By design (D3). Documented so it isn't mistaken for a bug: Esc and
  "Got it" are the same action and both persist.
- **R5 — `dismissIntro` via `setSetting` re-applies the theme.** Idempotent and harmless (D1/§7). If a
  reviewer prefers zero side effects, `dismissIntro` may instead write `aurora.settings` directly without
  `applyTheme`; noted as an implementation choice in `tasks.md`.
