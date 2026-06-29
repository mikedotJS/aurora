## Why

The MR sheet lists every open merge request for the repo with no way to narrow the list — on an active repo this is dozens of entries the user must scroll. The two things a developer reaches for most are "find that one MR" (search) and "what are *my* MRs" (filter to ones I authored), and neither is possible today.

## What Changes

- Add a **search field** to the MR sheet that filters the cached list as you type, matching against title, branch, author, and `!iid`.
- Add a **"mine" filter toggle** that restricts the list to merge requests authored by the current GitLab user.
- Resolve and cache the current GitLab username so "mine" can be evaluated client-side against the already-cached MR list (no extra fetch per toggle). Add a `glab_current_user` Tauri command backed by `glab api user`, degrading gracefully (toggle disabled) when glab is missing/unauthed.
- Keep keyboard-first interaction: search field is auto-focused, ↑↓ moves the selection through the *filtered* list, ↵ opens the selected MR, a shortcut toggles "mine", and esc closes.

## Capabilities

### New Capabilities
- `merge-request-search`: searching and filtering the merge-request sheet (text search across MR fields, "mine" filter by current GitLab user, and how the filtered list drives selection/keyboard nav).

### Modified Capabilities
<!-- No existing capability specs in openspec/specs/; this is additive UI behavior. -->

## Impact

- **Frontend**: `src/components/MrSheet.tsx` (search input, mine toggle, filter logic, keyboard handling against the filtered list). `src/state/store.ts` (cache the current GitLab username; optionally persist the "mine" toggle preference). `src/lib/notifications.ts` or a small helper to fetch the current user once.
- **Backend (Rust)**: `src-tauri/src/glab.rs` — new `glab_current_user` command (`glab api user` → `{ username }`), registered in the Tauri command handler.
- **Dependencies / APIs**: relies on the existing `glab` CLI; no new packages. Existing `glab_mr_list` cache (`store.repoMrs`) is reused unchanged.
