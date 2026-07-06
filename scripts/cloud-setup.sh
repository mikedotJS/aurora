#!/usr/bin/env bash
set -euo pipefail

# Aurora — setup script for Claude Code on the web (cloud environment).
#
# Runs once when the cloud VM (headless Ubuntu) is provisioned, before Claude
# starts working. Verified locally: `bun install` + `bun run typecheck` pass.
#
# The VM has NO display, so it CANNOT run the real Tauri window or the wdio e2e
# suite. It CAN run everything that matters day to day:
#   • bun run typecheck        (tsc --noEmit)
#   • bun run lint             (eslint src)
#   • bun test                 (unit/component tests, happy-dom — no display)
#
# Network: works under the "Trusted" profile IF the base image already ships
# Bun. If the `bun.sh` install below fails, switch the environment to "Custom"
# and allowlist:  bun.sh
# (and, for the optional Rust block: sh.rustup.rs static.rust-lang.org
#  crates.io index.crates.io)

# --- Bun (install if missing) ---
# Aurora is developed against Bun 1.3.x (see bun-types ^1.3.14). Older Bun (e.g.
# 1.2.x) makes the test harness fail spuriously: `useStore.setState is not a
# function`, `setInterval/clearInterval is not a function` — Bun's mock/fake-timer
# API changed. So on the (ephemeral) VM we always pull the latest stable Bun.
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun upgrade || true   # guarantee >= 1.3.x even if the base image ships an old Bun
# Persist PATH for Claude's shell sessions
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.bashrc"

# --- JS/TS dependencies ---
bun install

# --- OPTIONAL: Rust + Tauri Linux deps (uncomment only to work on src-tauri/) ---
# Heavy: adds the Rust toolchain + Tauri's Linux system libs to every cold start.
# Enables `cd src-tauri && cargo check` (compile-check only; no GUI, no bundle).
#
# sudo apt-get update && sudo apt-get install -y \
#   libwebkit2gtk-4.1-dev build-essential curl wget file \
#   libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libgtk-3-dev
# if ! command -v cargo >/dev/null 2>&1; then
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
#   . "$HOME/.cargo/env"
# fi
