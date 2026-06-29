## Context

The Aurora mockup is a **command-blocks** terminal with a *separate React-owned input line*
(the Warp model): output is grouped into cards (command + output + exit code), and the prompt is
a rich React component, not the shell's own line editor. A raw passthrough xterm therefore does
not fit the design. We need a real shell underneath (real PTY, real `glab`, real Anthropic API)
while preserving the blocks UX and the exact look of the mockup. The design — local copy of
`Aurora Terminal.dc.html` — is the authoritative visual + behavioral spec.

## Goals
- A native window where a **real shell session** runs per pane (`ls`/`cd`/`git`/`npm` work for real).
- Faithful Aurora chrome: tabs (drag-to-merge), split panes (≤4, 2×2), live cwd + git branch.
- Output rendered as **Aurora blocks**; interactive/full-screen programs still work.
- A React smart prompt: ghost autocomplete, history, typo-fix, and **NL → Claude** suggestions.
- Secrets and network calls stay in Rust; the Anthropic key lives in the OS keychain.

## Non-Goals
- The Landing / Docs marketing pages (separate, optional later port).
- Windows/Linux shell-integration parity beyond zsh in this pass.
- A full multiplexer (session persistence/detach, remote panes) — single app-local sessions only.

## Decisions

**1. Blocks model, not raw xterm — with xterm as the interactive fallback.** The PTY stream is
segmented into command/output/exit blocks using shell-integration markers, and Aurora's React
prompt draws the input (the shell's own prompt is suppressed). *Rationale:* the design is
fundamentally card-based with a separate input line; only this gives the Warp UX (per-block
copy/rerun, exit-code chips, structured `ls`/MR/AI cards). *Trade-off:* we must handle programs
that take over the screen. When a pane enters the alternate screen (DECSET 1049) we mount
**`@xterm/xterm`** bound to the same PTY for raw interaction, then unmount and resume blocks on
exit — so vim/top/less/ssh work without forcing the whole terminal onto xterm.

**2. PTY via `portable-pty` (Rust), one session per pane.** Rust spawns `$SHELL` on a real PTY
and streams read/write/resize to the webview over Tauri events/channels; a session registry maps
pane → PTY. *Rationale:* a genuine PTY (not a pipe) gives real job control, signals, and TTY
semantics; `portable-pty` is cross-platform and battle-tested. *Trade-off:* byte streaming +
backpressure + resize coordination across the IPC boundary is more work than an in-webview
emulator, but it is the only way the shell behaves like a real terminal.

**3. OSC 133 + OSC 7 shell integration to segment blocks + track cwd.** A custom
`ZDOTDIR`/rc sources `aurora-zsh-integration.zsh`, which emits **OSC 133** prompt/command/exit
markers and **OSC 7** cwd on every prompt. `term/osc.ts` parses these to cut the stream into
blocks (with exit codes) and to keep each pane's cwd live (status bar + ghost autocomplete +
onEnter hooks). *Rationale:* OSC 133/7 are the standard, shell-native way to do this (same as
Warp/iTerm2/VS Code); no fragile prompt scraping. *Trade-off:* requires injecting integration at
session start and degrades on shells/setups without it — acceptable since zsh is the target.

**4. React-owned prompt, not the shell line editor.** Input is a React component
(`PromptInput`); we keep the shell in a quiescent state and send the final command line to the
PTY on submit. *Rationale:* ghost autocomplete, history UI, typo-fix and the Claude suggestion
card need rich DOM and app state the shell's ZLE can't provide. *Trade-off:* we forgo some
native line-editing niceties (custom ZLE widgets) and must route control keys deliberately; the
xterm fallback covers anything that truly needs raw input.

**5. Secrets in the OS keychain; Claude calls from Rust.** The Anthropic key is stored via the
`keyring` crate (macOS Keychain) and never touches localStorage/JS; `claude_suggest(nl, cwd,
recent)` runs in Rust via `reqwest`. *Rationale:* a desktop app must not leak a user's key into
the webview surface; keeping the network in Rust also centralizes model IDs/headers. *Trade-off:*
every Claude/MR/secret operation is a Tauri command round-trip rather than a direct fetch — worth
it for the security boundary.

**6. CSS-variable tokens, not Tailwind.** The design's exact oklch palette, Geist/Geist Mono
fonts, and keyframes are copied verbatim into `styles/tokens.css`; bespoke chrome uses plain/
module CSS. *Rationale:* the mockup's precise oklch values and animations port more faithfully as
raw tokens than through a utility framework; accent re-theming is just swapping CSS variables.
*Trade-off:* less utility ergonomics, but pixel/behavior fidelity to the mockup is the priority.

## Risks / Trade-offs

- **Shell-integration coverage** → blocks depend on OSC 133/7; non-zsh or stripped environments
  degrade to coarser segmentation. Mitigated by targeting zsh and falling back gracefully.
- **Alt-screen detection edge cases** → mis-detecting alternate-screen entry/exit could strand a
  pane in the wrong renderer. Mitigated by toggling on DECSET 1049 and resuming blocks on exit.
- **`glab` absent/unauthed** → MR and notification surfaces must degrade, not crash; the UI shows
  a clear "connect glab" state instead of errors.
- **No API key** → the smart prompt's Claude path is locked and routes to key entry rather than
  failing silently.
- **IPC throughput** → high-volume output (e.g. `yarn`/`cargo` logs) must stream without UI jank;
  batched events + virtualized scrollback mitigate this.

## Migration Plan

Greenfield — no data migration. Phased rollout mirrors the implementation phases (see `tasks.md`):

- **Phase 0** — scaffold the Tauri app, tokens, lint/tsconfig; `bun tauri dev` opens a window.
- **Phase 1** — real PTY core (`pty.rs` + `term/pty.ts`); a real shell runs in a pane.
- **Phase 2** — Aurora chrome (title bar, tabs, panes, keymap, status bar, settings shell).
- **Phase 3** — blocks + smart prompt + Claude (shell integration, block renderers, BYOK, xterm
  fallback). This pass's headline deliverable is Phases 0–3.
- **Phase 4** — integrations (`glab` MR sheet, scripts + onEnter hooks, notifications polling).
- **Phase 5** — polish + end-to-end verification; clean `bun run build` + `cargo build`.

Rollback is trivial pre-release (nothing shipped); each phase is independently runnable.
