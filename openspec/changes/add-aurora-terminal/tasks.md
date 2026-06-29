## 0. Phase 0 — Scaffold & specs

- [x] 0.1 `bun create tauri-app aurora --template react-ts`; commit the base Tauri + React + Vite + TS layout.
- [x] 0.2 `openspec init`; author `openspec/project.md` and the `add-aurora-terminal` change (proposal / design / tasks / specs).
- [x] 0.3 `src/styles/{tokens.css,global.css}` — design tokens (oklch palette), Geist / Geist Mono fonts, keyframes copied verbatim from the mockup.
- [x] 0.4 ESLint flat config (`eslint.config.mjs`) + `tsconfig` strict (ES2022, Bundler); `README`.
- [ ] 0.5 Verify `bun tauri dev` opens a native window.

## 1. Phase 1 — Real PTY core

- [x] 1.1 `src-tauri/src/pty.rs` — spawn `$SHELL` on a `portable-pty` session; per-session registry; read/write/resize; stream output as Tauri events.
- [x] 1.2 `src-tauri/src/lib.rs` — register PTY Tauri commands; `src-tauri/Cargo.toml` deps; `tauri.conf.json` + `capabilities/default.json`.
- [x] 1.3 `src/term/pty.ts` — frontend PTY client (spawn/write/resize, subscribe to output).
- [x] 1.4 Render one pane via a themed xterm to prove a real shell runs.
- [ ] 1.5 Verify `ls` / `cd` / `git status` run for real in the pane.

## 2. Phase 2 — Aurora chrome

- [x] 2.1 `src/App.tsx`, `src/main.tsx`, `src/components/TitleBar.tsx` — window chrome + connected/BYOK dot.
- [x] 2.2 `src/state/{store,sessions}.ts` — Zustand store mirroring tabs → panes → sessions. (Sessions folded into `store.ts`.)
- [x] 2.3 `src/components/TabStrip.tsx` — new/close/select tabs + drag-to-merge into split groups.
- [x] 2.4 `src/components/{PaneGrid,Pane}.tsx` — split ≤4 (2×2 grid), ⌥-arrow focus, ⌘D/⌘⇧D, ⌘W close pane→tab.
- [x] 2.5 `src/lib/{keys,keymap}.ts` — global keymap (⌘T/⌘W, ⌘D/⌘⇧D, ⌘1-9, ⌃Tab, ⌥-arrows). (`keys` → `keychain.ts`.)
- [x] 2.6 Status bar — live cwd (OSC 7) + git branch + tab counter.
- [x] 2.7 `src/components/modals/SettingsModal.tsx` + `src/lib/settings.ts` — accent/font re-theme, persisted. (Settings live in `store.ts` → localStorage.)

## 3. Phase 3 — Blocks + smart prompt + Claude

- [x] 3.1 zsh integration — suppressed prompt + OSC 133 (preexec/precmd) + OSC 7, injected via a post-spawn init line in `Terminal.tsx` (rather than a separate ZDOTDIR file).
- [x] 3.2 `src/lib/ansi.ts` + the parser in `Terminal.tsx` — parse OSC 133/7 → block segmentation + cwd; ANSI (SGR/256/truecolor) → themed spans. (Gotcha fixed: normalize PTY `\r\n`.)
- [x] 3.3 `src/components/Pane.tsx` `BlockView` — command-header + ANSI output + non-zero exit-code block renderers in one scroll flow with the live prompt.
- [x] 3.4 `src/components/PromptInput.tsx` — React-owned prompt: ghost autocomplete (real history + readdir cwd + subcommand tables), ↑/↓ history, typo-fix card. (Folded into `Pane.tsx` + `lib/commands.ts`.)
- [x] 3.5 `src-tauri/src/{claude,keychain}.rs` — Anthropic `reqwest` client; key stored/read via `keyring`; `claude auth|status|logout`. (Combined in `claude.rs`.)
- [x] 3.6 `src/ai/suggest.ts` — NL → `claude_suggest(nl, cwd, recent)` suggestion card (↵ runs / ⇥ edits / esc dismisses); locked state + key-entry flow when no key.
- [x] 3.7 Interactive-program fallback — alt-screen (DECSET 1049) detection flips the pane into raw mode so xterm takes input; resumes the Aurora prompt on exit. (Same always-mounted xterm rather than a separate `XtermView`.)

## 4. Phase 4 — Integrations

- [x] 4.1 `src-tauri/src/glab.rs` — real `glab mr list --output json`; graceful degrade if absent/unauthed.
- [x] 4.2 `src/components/MrSheet.tsx` — MR bottom sheet (cached via the poller, force-refresh on open), ↑↓/↵ open in browser, author/draft/branch/updated fields; live "N MRs" in the status bar. (Pipeline/approvals/threads need a richer glab backend — future.)
- [ ] 4.3 `src-tauri/src/config.rs` + `src/integrations/scripts.ts` — per-repo scripts persisted to config; `run <name>`.
- [x] 4.4 `src/components/ScriptsSheet.tsx` + `src/components/ScriptsSetupModal.tsx` — edit name/desc/commands/dir + split toggle + onEnter select; split layout runs each task in its own pane (waits for each pane's shell to be ready).
- [x] 4.5 onEnter hooks — fire once on entering a repo root (or any dir with scripts).
- [x] 4.6 Notifications — `src/lib/notifications.ts` polls visited GitLab repos' MRs (new / updated / ready) → `NotifStack.tsx` toast stack (≤3, auto-dismiss) + `NotifSheet.tsx` history + status-bar unseen badge + mute/DND.

## 5. Phase 5 — Polish & verify

- [x] 5.1 Keyboard-map parity with the mockup; animations, scrollbars, welcome/empty states; transparent xterm overlay; ⌃C/⌃D forwarded.
- [x] 5.2 Clean `bun run build` + `cargo build --release` with no errors; ESLint passes; `openspec validate --strict` passes.
- [ ] 5.3 End-to-end manual checklist (see Verification).

## 6. Verification

- [x] 6.1 `bun tauri dev` launches the native window; a real shell session runs in a pane. (Verified with the user.)
- [x] 6.2 Real commands — `ls` etc. — render as Aurora blocks; cwd updates. (Verified: `ls` output renders in-block. Branch indicator still to confirm.)
- [ ] 6.3 Tabs/panes — ⌘T/⌘W, ⌘D/⌘⇧D (2×2 grid), ⌥-arrows, drag a tab onto another to merge into a split.
- [ ] 6.4 Smart prompt — ghost autocomplete + ↑/↓ history; a typo (e.g. `gti status`) shows a fix card.
- [ ] 6.5 Claude — `claude auth` stores the key in the keychain; plain language (e.g. "undo my last commit") yields a real suggestion card; ↵ runs it; `claude status` shows live.
- [ ] 6.6 GitLab (if `glab` authed) — `glab mr list` and the status-bar "N MRs" open the real MR sheet.
- [ ] 6.7 Settings — change accent/font/model → applies + persists across relaunch.
- [ ] 6.8 Interactive — run `vim` → xterm fallback engages; quit → blocks resume.
- [ ] 6.9 Clean `bun run build` and `cargo build` (release) with no errors; ESLint passes.
