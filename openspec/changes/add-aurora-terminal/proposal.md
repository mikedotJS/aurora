## Why

The Claude Design project *"Minimalist Claude-powered terminal app"* ships a polished mockup
(`Aurora Terminal.dc.html`) — a self-contained **simulator** of a Warp-style terminal: macOS
window chrome, draggable tabs, split panes, a smart input line (ghost autocomplete + history +
typo-fix + **natural-language → Claude command suggestions**), a **block/card-based scrollback**,
GitLab MR / notifications / scripts sheets, a settings modal, and a **BYOK Anthropic key** flow.
It looks and behaves like a real terminal but runs nothing.

We want to build it for real: a **Tauri desktop app** with a **real working terminal** (real
PTY/shell, real Anthropic API, real `glab`), the UI ported to React + Vite + TS (not the
dc-runtime), set up OpenSpec-driven. Outcome: a native terminal that looks and behaves like
Aurora but actually runs your shell and really talks to Claude.

## What Changes

- Scaffold a Tauri 2.x app (`src/` React + `src-tauri/` Rust) with design tokens, ESLint flat
  config, and TS strict.
- **Real PTY core**: spawn the user's `$SHELL` (default `zsh`) on a `portable-pty` session per
  pane; stream read/write/resize between Rust and the webview.
- **Aurora chrome**: title bar, draggable tabs (drag-to-merge into split groups), split-pane grid
  (≤4, 2×2), full keymap (⌘T/⌘W, ⌘D/⌘⇧D, ⌥-arrow focus, ⌘1-9, ⌃Tab), live status bar.
- **Blocks model**: inject `aurora-zsh-integration.zsh` (OSC 133/7) and parse the stream into
  command/output/exit-code blocks with live cwd; the shell prompt is suppressed and **Aurora's
  React prompt** draws the input. xterm.js mounts only as the interactive fallback for
  alternate-screen programs (vim/top/less/ssh).
- **Smart prompt**: ghost autocomplete from real history + filesystem, ↑/↓ history, typo-fix card,
  and NL → Claude command suggestions (Claude called from Rust; key from the OS keychain).
- **BYOK**: store the Anthropic key in the OS keychain via `claude auth`; `claude status|logout`.
- **Integrations**: real `glab` MR sheet + status-bar count; per-repo scripts (`run <name>`) +
  onEnter hooks; notifications polling with toast stack, history sheet, unseen badge, mute/DND.
- **Settings**: model picker (real IDs), accent re-theme, text size, ghost/suggest + notification
  toggles, DND — persisted to config.

## Capabilities

### New Capabilities
- `terminal-core`: real PTY shell session per pane, tabs, split panes, live cwd/branch status bar, and the xterm interactive fallback.
- `smart-prompt`: the React-owned input line — ghost autocomplete, command history, typo-fix, and NL → Claude command suggestions with a locked state when no key is set.
- `gitlab`: real `glab`-backed MR bottom sheet, status-bar MR count, and the notifications feed (toasts, history sheet, unseen badge, mute/DND).
- `scripts-hooks`: per-repo scripts persisted to config (`run <name>`, scripts sheet + setup modal) and onEnter hooks, including split-layout runs.
- `settings-byok`: the settings modal persisted to config and BYOK Anthropic key storage in the OS keychain (`claude auth|status|logout`).

## Impact

- **Code:** new Tauri project — Frontend `src/main.tsx`, `src/App.tsx`,
  `src/styles/{tokens,global}.css`,
  `src/components/{TitleBar,TabStrip,PaneGrid,Pane,Scrollback,PromptInput,XtermView,NotifStack}.tsx`,
  `src/components/blocks/*`, `src/components/sheets/{MrSheet,NotifSheet,ScriptsSheet}.tsx`,
  `src/components/modals/{SettingsModal,ScriptsSetupModal}.tsx`, `src/state/{store,sessions}.ts`,
  `src/term/{pty,osc,ansi}.ts`, `src/ai/suggest.ts`, `src/integrations/{glab,scripts}.ts`,
  `src/lib/{keys,settings,keymap}.ts`. Rust
  `src-tauri/src/{lib,pty,shell_integration,claude,keychain,glab,git,config}.rs`,
  `src-tauri/assets/aurora-zsh-integration.zsh`, `tauri.conf.json`, `capabilities/default.json`,
  `Cargo.toml`.
- **Config:** settings + per-repo scripts persisted as JSON under the Tauri app-config dir;
  Anthropic key in the OS keychain (`keyring` crate), never in the webview.
- **Out of scope:** the Aurora Landing / Docs marketing pages (optional later port);
  Windows/Linux shell-integration polish beyond zsh; a full terminal multiplexer.
