# Distributing Aurora (macOS)

Aurora ships as a **Developer ID–signed, notarized `.dmg`** for **Apple Silicon (arm64)**, with
**built-in auto-updates** via the Tauri updater. This is the direct-download model — no App Store.

## What's already wired

| Piece | Where | Notes |
|---|---|---|
| DMG + app bundle | `tauri.conf.json` → `bundle.targets: ["app","dmg"]` | |
| Code signing | `bundle.macOS.signingIdentity` | `Developer ID Application: Michaël, Bemard ROMAIN (D7F9KXB7PH)` — matches the cert CN **exactly** (see name note below) |
| Hardened runtime | `bundle.macOS.entitlements` → `src-tauri/entitlements.plist` | non-sandboxed; JIT keys for the webview |
| Min OS | `bundle.macOS.minimumSystemVersion: "11.0"` | Big Sur — first Apple-Silicon macOS |
| Updater (Rust) | `tauri-plugin-updater`, `tauri-plugin-process` in `lib.rs` | |
| Updater (JS) | `src/lib/updater.ts`, called on launch from `App.tsx` | downloads + installs + relaunches; surfaces a toast |
| Updater artifacts | `bundle.createUpdaterArtifacts: true` | emits `Aurora.app.tar.gz` + `.sig` |
| Updater pubkey | `plugins.updater.pubkey` | public half of the key below |
| Updater endpoint | `plugins.updater.endpoints[0]` | `github.com/mikedotjs/aurora` releases |

### The updater signing key

Generated locally, **not** in the repo:

- private: `~/.tauri/aurora-updater.key` (no password) — **keep secret, never commit**
- public:  `~/.tauri/aurora-updater.key.pub` (already embedded as `pubkey` in `tauri.conf.json`)

If you lose the private key, existing installs can't verify future updates — back it up.

## One-time setup before your first release

1. **Hosting is set to `github.com/mikedotjs/aurora`** in two matching places:
   - `tauri.conf.json` → `plugins.updater.endpoints[0]` → `…/mikedotjs/aurora/releases/latest/download/latest.json`
   - the release script's `DOWNLOAD_BASE` default → `…/mikedotjs/aurora/releases/download/v<version>`

   If you ever move hosts, change both. GitHub Releases is the easiest free host.

2. **Get notarization credentials** (one of):
   - **Apple ID + app-specific password** — create one at
     <https://appleid.apple.com> → *Sign-In and Security → App-Specific Passwords*. You'll use:
     `APPLE_ID`, `APPLE_PASSWORD` (the app-specific pw), `APPLE_TEAM_ID=D7F9KXB7PH`.
   - **App Store Connect API key** (better for CI) — create at
     <https://appstoreconnect.apple.com/access/integrations/api>. You'll use:
     `APPLE_API_ISSUER`, `APPLE_API_KEY` (the key ID), `APPLE_API_KEY_PATH` (the `.p8` file).
     Apple lets you download the `.p8` **once** — keep it somewhere stable like
     `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8` and back it up; if you lose it you
     must generate a new key.

## Cutting a release

```bash
# from the repo root
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
export APPLE_TEAM_ID="D7F9KXB7PH"
export DOWNLOAD_BASE="https://github.com/mikedotjs/aurora/releases/download/v0.1.0"

./scripts/release-mac.sh
```

The script signs the updater key into your env, runs
`tauri build --target aarch64-apple-darwin --bundles app,dmg` (which **signs and notarizes**
the `.app` when the Apple creds are present), then **notarizes and staples the `.dmg`** itself —
Tauri only staples the `.app`, so the script staples the disk image separately with `notarytool`
+ `stapler` so the download carries the ticket and opens cleanly even offline. Finally it writes
`latest.json`. Artifacts land in `src-tauri/target/aarch64-apple-darwin/release/bundle/`.

> First codesign of a session may pop a Keychain prompt — click **Always Allow** so the build
> doesn't stall. To pre-authorize non-interactively (e.g. CI):
> `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <login-pw> login.keychain-db`

### Publish

Upload to your release (the `DOWNLOAD_BASE`):

- **`Aurora_0.1.0_aarch64.dmg`** — what users download and drag to /Applications.
- **`Aurora.app.tar.gz`** — the updater payload. Its filename must match the `url` in `latest.json`.
- **`latest.json`** — the updater endpoint. For the GitHub `releases/latest/download/...` URL to keep
  working, attach `latest.json` to **every** release.

## How auto-update behaves

On launch Aurora hits the endpoint. If a newer signed build exists, it downloads + installs it in the
background, shows a toast, and relaunches. The `.sig` in `latest.json` is verified against the embedded
`pubkey` before anything is applied — an update signed with the wrong key is rejected.

## Shipping a new version

1. Bump `version` in **both** `src-tauri/tauri.conf.json` and `package.json` (and optionally
   `src-tauri/Cargo.toml`).
2. `export DOWNLOAD_BASE=".../v<new-version>"` and run `./scripts/release-mac.sh`.
3. Publish the three artifacts (including the regenerated `latest.json`).

## Name on the certificate

The Developer ID cert's Common Name reads **"Bemard"** (a typo of *Bernard*) because that's how the
name is stored in the Apple Developer account. `signingIdentity` must match the cert byte-for-byte, so
it stays as-is. To fix it: correct your name in Apple Developer → *Membership details*, re-generate the
Developer ID Application certificate, then update `signingIdentity` to the new CN. Purely cosmetic;
doesn't affect signing or notarization.

## If you skip notarization

A signed-but-not-notarized `.dmg` still installs, but users get a Gatekeeper warning. They can bypass
via **System Settings → Privacy & Security → "Open Anyway"**, or
`xattr -dr com.apple.quarantine /Applications/Aurora.app`. Notarizing avoids this entirely — recommended
for anything you distribute publicly.
