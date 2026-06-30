<!-- PROPOSED. Implement after the foundation (workspaces-core, workspace-create, workspace-changes) lands. -->

## 1. Per-repo config store

- [x] 1.1 `lib/repoConfig.ts`: `RepoConfig` type (presets, defaults, lifecycle, aiAccounts) + load/save keyed by repo root (persist like `aurora.scripts`).
- [x] 1.2 Seed the built-in `fix`/`feature`/`spike` presets on first open of a repo's settings.
- [x] 1.3 `lib/presets.ts`: preset CRUD + the "active preset for issue type" lookup consumed by the scope form.

## 2. Backend: package.json + validator (`src-tauri/src/repoconfig.rs`)

- [x] 2.1 `read_package_field(dir, field)` (dot-path lookup in package.json).
- [x] 2.2 `detect_branch_validator(dir) -> Option<{regex,source}>` (validate-branch-name in package.json / husky / commitlint / rc file).
- [x] 2.3 `validate_branch_name(dir, name) -> {ok,message?}` (run real validator if present, else regex test). Register in `lib.rs`.

## 3. Branch-naming engine (`lib/branchNaming.ts`)

- [x] 3.1 `BranchNamingConfig` union + `applyTemplate(template, issue)` (tokens, slugify, lowercase, dash, 40-cap, drop-unknown).
- [x] 3.2 `parseRegexToGroups(regex)` → ordered enum/free groups; guided composer.
- [x] 3.3 `resolveBranchName(cfg, issue, dir)` covering all four sources; AI mode chains `validate_branch_name` with retry; returns `{name,preview,valid,explanation?}`.
- [x] 3.4 Replace `workspace-create`'s `lib/branchName.ts` usage with `resolveBranchName` (keep the simple builder as fallback).

## 4. UI

- [x] 4.1 `components/WorkspaceSettings.tsx`: Integrations / AI accounts / Presets / New-workspace defaults / Lifecycle sections (Frame 5).
- [x] 4.2 `components/PresetEditor.tsx`: full preset form (Frame 6) with delete/cancel/save.
- [x] 4.3 Branch-naming editor (Frames 7–10): source selector, manual token composer + live preview, package.json-bound read-only view, validator-inferred guided composer, AI-instruction box with reasoning/✓✕ preview and the chain-validator toggle.
- [x] 4.4 Bind the create scope form's preset + branch fields to `lib/presets.ts` / `resolveBranchName`.

## 5. Validation

- [ ] 5.1 Manually verify every spec scenario across both capabilities (template resolution + unknown-token drop; package.json bind + re-read; validator inference enum-pickers + pass/flag; AI retry + reasoning/result; authoritative pre-create validation block; settings persistence; preset stamp + issue-type auto-select + delete; defaults applied; auto port offset; unimplemented isolation marked; lifecycle confirm + prune).
- [x] 5.2 `bun run lint`, `bun run build`, `cargo build` clean.
