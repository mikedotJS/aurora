# Aurora

A real, Claude-powered terminal — a Warp-style blocks terminal with the Aurora
design: real shell sessions on a PTY, tabs + split panes, a smart prompt with
ghost autocomplete, and natural-language → command suggestions from Claude.

## Stack

| Layer | Choice |
| --- | --- |
| Desktop shell | Tauri 2.x (frameless window, custom chrome) |
| Frontend | React 19 + Vite + TypeScript (strict, ES2022) |
| State | Zustand (tabs → panes → sessions) |
| Terminal | real PTY via `portable-pty` (Rust) + `@xterm/xterm` renderer |
| cwd tracking | OSC 7 (zsh integration) + optimistic `cd` |
| Claude | Anthropic API from Rust (`reqwest`); model picker |
| Secrets | macOS Keychain via the `keyring` crate (key never enters the webview) |
| GitLab | real `glab` CLI (`mr list --output json`) |
| Tooling | bun · ESLint (flat config) · OpenSpec |

## Layout

```
src/              React frontend
  components/      TitleBar, TabStrip, PaneGrid, Pane, Terminal, MrSheet, SettingsModal
  state/store.ts   Zustand store (groups → panes → sessions)
  term/pty.ts      PTY event bridge to Rust
  lib/             keymap, commands (ghost/typo/NL gate), theme, sys, keychain
  ai/suggest.ts    NL → Claude command
src-tauri/        Rust backend
  src/pty.rs       PTY sessions (spawn/write/resize/kill, output streaming)
  src/claude.rs    keychain + Anthropic `claude_suggest`
  src/glab.rs      GitLab merge requests
  src/sys.rs       list_dir / git_branch / home_dir
openspec/         spec-driven workflow (project.md, changes/, specs/)
```

## Develop

```bash
bun install
bun tauri dev        # launch the app (real shell)
bun run build        # typecheck + bundle the frontend
bun run lint         # eslint
cd src-tauri && cargo build
```

## How it works

Each pane spawns the user's `$SHELL` on a PTY. In normal mode the zsh prompt is
suppressed and Aurora's React prompt drives input: you type a command (with ghost
autocomplete + history), press ↵, and it's sent to the shell — output streams into
the xterm view. Plain-language input (e.g. *"undo my last commit"*) is sent to
Claude, which proposes a command you can run with ↵. Full-screen programs (vim,
top, less) flip the pane into raw mode so xterm takes over input, and back out on
exit.

Bring your own Anthropic key: run `claude auth` (or the title-bar **add key**),
and it's stored in the macOS Keychain. GitLab merge requests use your local
`glab` CLI.

Built from the **Aurora Terminal** Claude Design mockup; design tokens are ported
verbatim. See `openspec/` for the spec-driven change history.
