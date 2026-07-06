# Aurora Workspaces — release checklist

> Source of truth for cutting a release. Pairs with `DISTRIBUTION.md` (the *how* of
> signing/notarization/updater) and `docs/workspaces-reprise-roadmap.md` (the product
> bar). There is **no CI** — every gate below is run manually before a tag is cut.

## A. Product readiness — the promise holds

The promise: *open a repo's workspace → run a script → each server isolates its port
(zero knob) → clean teardown* (`docs/workspaces-reprise-roadmap.md`).

- [ ] Re-run the `ux-qa` agent against `docs/workspaces-flow.mmd`; verdict is **ship**,
      not "hors de contrôle". (Grid: `.claude/agents/ux-qa.md`.)
- [ ] **CUT** — no dead knobs surfaced in workspace settings (`autoPortOffset`,
      `isolation`, `closeAction`, `confirmDelete`, `pruneWorktreeOnMerge`).
- [ ] **UNIFY** — one creation path; the targeted repo (rail "+") is not lost on the
      first keystroke (the old `store.ts:746` bug).
- [ ] **BUILD · port** — the allocated `$AURORA_PORT_OFFSET` is *shown* on the card +
      context bar, not just exported.
- [ ] **BUILD · teardown** — deleting a workspace removes the worktree **and** kills the
      server process group (not just the shell); no worktree / dev-server accumulation.
- [ ] The 5 guard principles hold (target visible · every default shown & editable ·
      single create path · state rendered · reversible teardown / zero dead knob).

## B. Quality gates (manual — no CI)

Run from the repo root. All must be green.

- [ ] `bun install`
- [ ] `bun run typecheck` — `tsc --noEmit`, clean
- [ ] `bun run lint` — `eslint src`, clean
- [ ] `bun run test` — isolation runner (`test/cov.ts`); **1705 pass / 0 fail**
- [ ] `bun run test:e2e` — wdio/Tauri suite. **Requires a display** — cannot run on the
      headless cloud VM; run locally or on a machine with a GUI.

> The cloud VM (Claude Code on the web) can run A-gates and the first four B-gates only.
> The e2e suite and the entire section D–G (build/sign/notarize) need a macOS box.

## C. Version & metadata

- [ ] Pick the version. Bump it in **all three** files together (currently all `0.2.0`):
      `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- [ ] `DOWNLOAD_BASE` will resolve to `…/releases/download/v<version>` — matches the tag.
- [ ] Write release notes (no `CHANGELOG.md` exists yet — create if desired).

## D. Signing / notarization / updater prerequisites (macOS)

- [ ] Updater private key present & backed up: `~/.tauri/aurora-updater.key`
      (never committed; public half already embedded as `pubkey` in `tauri.conf.json`).
- [ ] Developer ID cert installed; CN is exactly
      `Developer ID Application: Michaël, Bemard ROMAIN (D7F9KXB7PH)`
      (the "Bemard" typo is intentional — must match the cert byte-for-byte).
- [ ] Notarization creds exported — either
      `APPLE_ID` + `APPLE_PASSWORD` (app-specific) + `APPLE_TEAM_ID=D7F9KXB7PH`,
      or the App Store Connect API trio `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`.
- [ ] Updater endpoint in `tauri.conf.json` → `plugins.updater.endpoints[0]` points at
      `…/mikedotjs/aurora/releases/latest/download/latest.json`.

## E. Build (macOS, Apple Silicon)

- [ ] `./scripts/release-mac.sh` — signs + notarizes the `.app`, notarizes + staples the
      `.dmg`, writes `latest.json`. (arm64 only; min macOS 11.)
- [ ] Three artifacts land in `src-tauri/target/aarch64-apple-darwin/release/bundle/`:
      `dmg/Aurora_<v>_aarch64.dmg`, `macos/Aurora.app.tar.gz` (+ `.sig`), `latest.json`.

## F. Publish (GitHub Releases)

- [ ] Create tag/release `v<version>` on `mikedotjs/aurora`.
- [ ] Upload all **three** artifacts. `Aurora.app.tar.gz`'s name must match the `url` in
      `latest.json`, and `latest.json` must be attached to **every** release (else the
      `releases/latest/download/...` endpoint 404s).

## G. Post-release verification

- [ ] `.dmg` opens cleanly on a fresh Mac — no Gatekeeper warning (notarization OK, even
      offline).
- [ ] Auto-update: a prior-version install detects the new build, downloads, installs,
      relaunches, shows the toast; the `.sig` verifies against the embedded `pubkey`.
- [ ] Smoke-test the Workspaces happy path on the published build.
