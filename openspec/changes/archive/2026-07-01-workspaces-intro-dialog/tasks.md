# Tasks — workspaces-intro-dialog

Ordered so each phase typechecks on its own. Phase 1 adds the persisted flag + action, Phase 2 builds the
component, Phase 3 mounts it in `App.tsx`, Phase 4 wires the keyboard, Phase 5 tests, Phase 6 verifies.

**Designer note:** Phase 2 defines the dialog's *contract* and ships sober placeholder copy. The final
wording, the chosen 2-3 value props, and the visual/illustration are a **design** surface — hand
`WorkspacesIntro.tsx`'s marked content block to the **designer** (`/frontend-design`) after (or right
after) wiring. Keep to existing tokens; no new dependency.

**Verify-in-app note:** Aurora runs in WKWebView; happy-dom/jsdom cannot confirm real layout, focus, or
z-order (project memory). Phase 6 includes a real-app check, not only `bun test`.

## 1. Persisted flag + dismiss action (`src/state/store.ts`)

- [x] 1.1 Add `introSeen: boolean` to the `Settings` interface (~33-41). Add a one-line comment marking
      it as one-time onboarding state (persisted with settings, not a user-facing preference).
- [x] 1.2 Add `introSeen: false` to `DEFAULT_SETTINGS` (~49-56).
      **Verify:** a fresh install (no `aurora.settings`) → `init` receives `DEFAULT_SETTINGS` →
      `introSeen === false`; an updater whose stored `aurora.settings` lacks the key → the boot merge
      `{ ...DEFAULT_SETTINGS, ...parsed }` (`App.tsx` 76-77) leaves `introSeen === false`. Both show it.
- [x] 1.3 Declare `dismissIntro: () => void` in `StoreState` (near `openSettings`/`closeSettings` in the
      type block ~369-370) and implement it (near their reducers ~1167). It MUST set
      `settings.introSeen = true` **and** persist to `aurora.settings`. Recommended implementation:
      delegate to the existing settings-persist path, e.g. `dismissIntro: () => get().setSetting("introSeen", true)`
      (reuses the `localStorage.setItem("aurora.settings", …)` write; the `applyTheme` re-apply is a
      harmless no-op). A bespoke reducer that writes `aurora.settings` without `applyTheme` is an
      acceptable alternative (R5).
- [x] 1.4 Confirm `init` needs **no change**: it already sets `settings` and `initialized` in the same
      `set({...})` (line ~677), so `store.settings.introSeen` is authoritative the instant `ready` flips
      true (no flash for returning users). Note this in the diff; do not add an `init` parameter.
- [x] 1.5 Typecheck: `bun run build` (or `tsc`) — the new `Settings` field must not break any existing
      `DEFAULT_SETTINGS` spread or `setSetting` call site.

## 2. Dialog component (`src/components/WorkspacesIntro.tsx` — new)

- [x] 2.1 Create `WorkspacesIntro.tsx`. Reuse the `SettingsModal` overlay pattern: outer
      `position:absolute; inset:0; zIndex:100; display:flex; align/justify center; padding`, a backdrop
      `<div style={{ position:absolute; inset:0; background:"color-mix(in oklab, black 55%, transparent)"; animation:"fadeIn .16s ease" }} />`
      (**no** `onClick` dismissal — D3), and a panel (`var(--win)`, `1px solid var(--line)`, radius 14,
      shadow, `animation:"popIn .2s …"`). Tokens only; inline styles + `global.css` classes. No new import
      beyond React + `useStore`.
- [x] 2.2 Read `const dismissIntro = useStore((s) => s.dismissIntro)`. Render a **single** primary CTA
      button labeled **"Got it"** whose `onClick` calls `dismissIntro()`. Use the app's green accent for
      the primary button (`var(--ac)` / `var(--acd)`), matching the empty-state primary affordance.
- [x] 2.3 **Content contract (designer surface).** Near the top of the file, define a clearly-commented
      block the designer owns: a title string (placeholder e.g. `"Introducing Workspaces"`) and a small
      array of value props `{ title: string; desc: string }` seeded with sober placeholders drawn from
      the four candidates — isolated per-ticket/branch worktrees, run/stop dev servers, Jira & GitLab
      integration, isolated ports (designer trims to the final 2-3). Optionally a visual/illustration
      slot (placeholder, designer owns). The component renders this block; **the gating/dismiss logic
      does not depend on the copy**. Add a comment: `// DESIGNER: edit copy/visuals here — do not change
      the dismiss wiring below.`
- [x] 2.4 A11y: root `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the title
      element's `id`. On mount, move focus to the "Got it" button (ref + `useEffect`, mirroring how
      `App.tsx` focuses `#aurora-root`). Keyboard Esc is handled centrally in Phase 4 (keymap), so the
      component itself needs no key handler.

## 3. Conditional mount (`src/App.tsx`)

- [x] 3.1 Import `WorkspacesIntro`. Add `const introSeen = useStore((s) => s.settings.introSeen);`
      alongside the other overlay selectors (~42-47).
- [x] 3.2 In the overlay stack (with the other modals, ~273-279), add `{!introSeen && <WorkspacesIntro />}`
      as the **last** overlay (top-most). No need to also gate on `ready` — the earlier
      `if (!ready) return null` (236) guarantees `initialized` before any of this renders.
- [x] 3.3 Confirm no change to the boot effect (settings already loads at 76-77 and flows into `init` at
      104) and no change to the content column / `EmptyState` branch (257-269). The dialog overlays them.

## 4. Keyboard (`src/lib/keymap.ts`)

- [x] 4.1 Add an intro overlay guard among the existing overlay guards (after the form-field bail at
      204-205, ideally **first** since it is the top-most modal): 
      `if (!s.settings.introSeen) { if (k === "Escape") { e.preventDefault(); s.dismissIntro(); } return; }`.
      It MUST sit **above** the app-level ⌘ block (249-253) and the `if (!pane) return` bail (255-256) so
      Esc works at first-run when there is no active pane, and so no other shortcut fires while the intro
      is open (keyboard-modal).
- [x] 4.2 Confirm the guard returns for **every** key while the intro is open (not only Escape), so
      typing / ⌘K / ⌘, are inert behind the modal.

## 5. Tests (`__tests__/`, `bun:test`, runs under the existing `test/setup.ts` preload)

- [ ] 5.1 `__tests__/WorkspacesIntro.cov.test.tsx` (model on `SettingsModal.cov.test.tsx`): render with
      `useStore.setState({ settings: { ...DEFAULT_SETTINGS, introSeen: false } })`; assert the title,
      the value props, and the "Got it" button are present. Click "Got it"; assert
      `useStore.getState().settings.introSeen === true` and that `localStorage.getItem("aurora.settings")`
      parses to an object with `introSeen: true`. Assert the backdrop click does **not** dismiss (flag
      stays as-is after clicking the scrim).
- [ ] 5.2 Store test (in `store.cov.test.tsx` or a focused file): `dismissIntro()` sets
      `settings.introSeen = true` and writes `aurora.settings`. Also assert `init(...)` with a stored
      `aurora.settings` lacking the key defaults `introSeen` to `false` (updater path) and with no stored
      settings defaults it to `false` (fresh-install path).
- [ ] 5.3 Keymap test (in `keymap.cov.test.tsx`): with `settings.introSeen === false` and **no active
      pane/workspace**, dispatch `Escape` → `dismissIntro` ran (`introSeen === true`) and `preventDefault`
      was called. With the intro open, dispatch e.g. ⌘K → the command palette did **not** open (guard
      swallowed it). With `introSeen === true`, the guard is inert (Escape falls through to normal
      handling).
- [ ] 5.4 Run `bun test/cov.ts` (isolated per-file runner) — all new + existing suites green. Paste the
      pass/fail summary in the change.

## 6. Verify (build + real app)

- [x] 6.1 `bun run build` clean (TS strict) and ESLint clean.
- [ ] 6.2 Real-app check (WKWebView; not jsdom): (a) wipe/absent `aurora.introSeen`-equivalent — clear
      `aurora.settings` or set `introSeen:false` — launch → dialog appears over the empty state / a
      workspace; (b) click "Got it" → dialog closes, lands on empty state / workspace, `aurora.settings`
      now has `introSeen:true`; (c) relaunch → dialog does **not** reappear; (d) re-open path: Esc also
      dismisses + persists; backdrop click does not. Confirm focus lands on "Got it" and z-order is above
      all chrome.

## 7. Handoff

- [ ] 7.1 Hand `WorkspacesIntro.tsx`'s content block to the **designer** (`/frontend-design`) for final
      copy (2-3 value props), the sober visual, and the polish pass — keeping the Phase 2 contract and the
      dismiss wiring intact.
