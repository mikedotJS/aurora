## Why

The release that introduces the **Workspaces** suite (per-repo worktree workspaces, run/stop dev
servers, Jira & GitLab integration, isolated ports) is a large shift in what Aurora is. A user who
updates from a pre-workspaces build — or who installs fresh and lands on the new empty state — gets no
signal that this capability exists or why it matters. There is currently **no first-run onboarding
surface at all** in the app: `App.tsx` boots straight into either a workspace or the `EmptyState`, and
the only persisted first-run-ish signals are per-feature (`aurora.settings`, `aurora.scripts`,
`aurora.repoconfig`) — none of them onboarding.

We want a **one-time "Introducing Workspaces" dialog** shown on startup: seen exactly once by
**everyone** (updaters and fresh installs alike), dismissed by a single **"Got it"** action that
persists a "seen" flag so it never returns.

This change scopes **only** the mechanism and the component **contract**. The final copy and visual
treatment are a **designer** surface (a designer picks this up after) — this proposal fixes *where* that
content lives and *how* it is gated, not the words.

## What Changes

- **New one-time intro dialog.** On startup, once boot has completed (`initialized === true`), if the
  persisted "intro seen" flag is absent/false, Aurora shows a modal **"Introducing Workspaces"** dialog
  over the app content. It is informational: 2-3 value props of workspaces + a sober visual, in Aurora's
  visual language.
- **Single dismissal that persists.** The dialog has **one** primary CTA, **"Got it"**, which sets the
  "seen" flag, persists it, and closes the dialog. **Esc** is equivalent to "Got it" (also persists).
  The backdrop is **not** a dismissal target — the one-time message must not be burned by a stray click.
  After dismissal the user lands on whatever was underneath: the `EmptyState` (fresh install) or their
  restored workspace (updater).
- **Persisted "seen" flag rides the existing settings pipeline.** A new boolean
  `introSeen: boolean` is added to the `Settings` type (default `false` in `DEFAULT_SETTINGS`). It is
  loaded, defaulted, and applied through the **existing** boot path (`App.tsx` reads `aurora.settings`,
  merges over defaults, hands it to `store.init`, which sets it atomically with `initialized`). A new
  store action `dismissIntro()` sets `introSeen = true` and persists via the existing `aurora.settings`
  write. No new localStorage key, no new boot loader, no new `init` parameter.
- **Boolean flag, no version gating.** A fresh install (no stored settings) and an updater from a
  pre-workspaces build (stored settings without the key) both default to `introSeen = false`, so both
  see the dialog exactly once. Version-based gating is explicitly rejected (see `design.md`).
- **Keyboard: Esc closes the intro even with no active pane.** A guard is added to `keymap.ts` **above**
  the `if (!pane) return` bail (first-run has no workspace/pane), mirroring the existing
  `settingsOpen` / `scriptsSetupOpen` overlay guards. While the intro is open it captures keys (nothing
  else — ⌘K etc. — fires), keeping it modal.
- **New component `WorkspacesIntro.tsx`.** Reuses the `SettingsModal` overlay/backdrop/panel chrome
  (tokens, `popIn`/`fadeIn`, dark theme, green accent) and exposes a **stable content contract** — a
  clearly-marked content block (title + value-prop list + optional visual) the **designer** edits without
  touching the gating logic.

Non-goals:
- **No per-version "what's new" system.** This is a single boolean one-time gate for *this* release's
  workspaces intro, not a recurring changelog/onboarding framework.
- **No new dependency, no redesign** of the visual language (dark theme, green accents, monospace,
  existing `tokens.css`). Inline styles + `global.css` classes, as today.
- **No change to boot order, the empty state, the responsive rail behavior, or the recent
  black-screen crash fix.** The dialog is a purely additive overlay gated on an existing signal.
- **No security surface** (a local, non-secret UI flag only).

## Capabilities

### New Capabilities
- `workspaces-intro-dialog`: Aurora shows a one-time, modal **"Introducing Workspaces"** dialog on the
  first startup where a persisted "seen" flag is absent — seen once by every user (updaters and fresh
  installs), dismissed by a single **"Got it"** action (Esc-equivalent) that persists the flag so it
  never returns, rendered over the app content once boot has completed, with content structured as a
  designer-owned surface, reusing the existing modal chrome and visual language with no new dependency.

### Modified Capabilities
<!-- None. As with empty-startup-state and responsive-ui-layout, there is no promoted baseline spec for
     app startup / onboarding under openspec/specs/ (only merge-request-search lives there). This
     behavior is captured as a new additive capability rather than a delta to a non-existent baseline. -->

## Impact

- **`src/state/store.ts`** — add `introSeen: boolean` to the `Settings` interface (~33-41) and
  `introSeen: false` to `DEFAULT_SETTINGS` (~49-56); add a `dismissIntro()` action (near
  `openSettings`/`closeSettings`, ~1167) that persists `introSeen = true` to `aurora.settings`. `init`
  (~629-679) needs **no change**: it already sets `settings` atomically with `initialized`, so the flag
  is known the instant the app becomes ready (no flash-of-intro for returning users).
- **`src/App.tsx`** — read `const introSeen = useStore((s) => s.settings.introSeen)` and render
  `<WorkspacesIntro />` in the overlay stack (with the other modals, ~273-279), gated on `!introSeen`.
  The existing gate `if (!ready) return null` (236) already guarantees `initialized` before this renders.
  No change to the boot effect (settings already loads + flows into `init`).
- **`src/lib/keymap.ts`** — add an overlay guard (`if (!s.settings.introSeen) { if Escape → preventDefault
  + dismissIntro; return; }`) placed with the other overlay guards (~209-242), i.e. **above** the
  app-level ⌘ block and the `if (!pane) return` bail (256), so Esc works with no active pane and the
  intro is keyboard-modal.
- **`src/components/WorkspacesIntro.tsx`** (new) — the dialog. Reuses `SettingsModal`'s overlay pattern;
  single "Got it" CTA → `dismissIntro()`; content in a marked, designer-owned block; tokens-only styling;
  `role="dialog"` + `aria-modal` + labelled title + focus the CTA on mount. **Designer refines copy +
  visual.**
- **Reuses (no change):** `SettingsModal` chrome as the visual reference; `applyTheme` (harmless
  idempotent re-apply if `dismissIntro` delegates to `setSetting`); `tokens.css` `popIn`/`fadeIn`.
- **`__tests__/`** — new `WorkspacesIntro.cov.test.tsx` (render + "Got it" persists + closes), store test
  for `dismissIntro` (sets flag + writes `aurora.settings`), and a `keymap` case (Esc dismisses the intro
  with no active pane; other keys are swallowed while open). Runs under the existing preload
  (`test/setup.ts`, happy-dom + Tauri mocks) via `bun test/cov.ts`.
