# Aurora — Project Context

## Product
Aurora — a real, Claude-powered terminal (Tauri desktop app). A Warp-style, command-blocks
terminal that runs the user's real shell on a PTY, segments output into blocks via shell
integration, and adds a React-owned smart prompt with ghost autocomplete, history, typo-fix,
and natural-language → Claude command suggestions. Real `glab` MR/notification surfaces,
per-repo scripts + onEnter hooks, BYOK Anthropic key in the OS keychain. The
`Aurora Terminal.dc.html` mockup is the authoritative visual + behavioral spec.

## Stack
| Concern | Choice |
|---|---|
| Shell / desktop | Tauri 2.x |
| Frontend | React 19 + Vite + TypeScript (strict) |
| State | Zustand (store mirrors the design state machine: tabs → panes → sessions) |
| PTY | `portable-pty` (Rust), one session per pane |
| Terminal fallback | `@xterm/xterm` + fit addon (interactive/full-screen programs only) |
| Blocks / cwd | OSC 133 (prompt/command/exit) + OSC 7 (cwd) shell integration |
| Claude | Rust `reqwest` → Anthropic API; default `claude-sonnet-4-6` (picker: Sonnet 4.6 / Opus 4.8 / Haiku 4.5) |
| Secrets | `keyring` crate (macOS Keychain) — never in the webview |
| GitLab | shell out to real `glab` (`mr list --output json`, `mr view`); graceful degrade if absent/unauthed |
| Git status / branch | `git` invoked in the pane cwd |
| Config (settings, scripts) | JSON under the Tauri app-config dir |
| Lint / PM | bun + ESLint flat config (`eslint.config.mjs`) |

## Layout
- `src/` — React app (components, blocks, sheets, modals, `state/`, `term/`, `ai/`, `integrations/`, `lib/`, `styles/`).
- `src-tauri/` — Rust backend (`pty.rs`, `shell_integration.rs`, `claude.rs`, `keychain.rs`, `glab.rs`, `git.rs`, `config.rs`), `assets/aurora-zsh-integration.zsh`, `tauri.conf.json`, `capabilities/`.
- `openspec/` — project context + change specs.

## Conventions
- **bun** for install/scripts; **TypeScript strict** (ES2022, Bundler resolution); **kebab-case** file names.
- **Secrets never enter the webview**: the Anthropic key lives in the OS keychain and all Claude calls go out from Rust.
- **Design tokens copied verbatim from the Aurora mockup** (oklch palette, Geist / Geist Mono, keyframes) into `styles/tokens.css` — plain/module CSS for bespoke chrome, **not** Tailwind, so the exact oklch values port faithfully.
- ESLint flat config (`eslint.config.mjs`); clean `bun run build` + `cargo build`.
