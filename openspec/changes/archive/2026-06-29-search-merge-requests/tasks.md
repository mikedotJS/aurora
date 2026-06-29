## 1. Backend — current GitLab user

- [x] 1.1 Add `glab_current_user() -> Result<String, String>` to `src-tauri/src/glab.rs`: resolve `glab` via `crate::sys::resolve_bin`, run `glab api user` with the user's real PATH, parse JSON and return `.username`; mirror the error contract (`Err("glab-not-found")` when absent, trimmed stderr on failure).
- [x] 1.2 Register `glab_current_user` in the Tauri `invoke_handler` (alongside `glab_mr_list`) in `src-tauri/src/lib.rs`/`main.rs`.
- [x] 1.3 `cargo build` clean.

## 2. State — cache the current user

- [x] 2.1 Add `glabUser: string | null` to the store in `src/state/store.ts` with a setter (default `null`).
- [x] 2.2 Add a helper (e.g. in `src/lib/notifications.ts`) that fetches `glab_current_user` once, caches the result in the store, and swallows errors (leaves `glabUser` null). Call it lazily on first MR-sheet open or alongside `startNotificationPoller`.

## 3. MR sheet — search field

- [x] 3.1 Add a search text input to the header of `src/components/MrSheet.tsx`, styled with existing tokens; auto-focus it on open and reset its value each open.
- [x] 3.2 Compute a `filtered` list: case-insensitive substring match of the query against `title`, `branch`, `author`, and `iid` (match bare number and `!`-prefixed).
- [x] 3.3 Render the empty-state when `filtered` is empty (distinct copy from the "no MRs / glab not installed" case).

## 4. MR sheet — "mine" toggle

- [x] 4.1 Add a "mine" toggle control to the sheet header; default off; render disabled when `glabUser` is null.
- [x] 4.2 When enabled, additionally filter `filtered` to `mr.author === glabUser` (composes with search via AND).
- [x] 4.3 Add a keyboard shortcut to toggle "mine" (and reflect the active state visually).

## 5. Keyboard navigation against the filtered list

- [x] 5.1 Point `sel` at the `filtered` array; clamp `sel` into `[0, filtered.length-1]` (or 0 when empty) on every change to query/toggle.
- [x] 5.2 Handle ↑/↓/↵/esc so they operate on `filtered` while the search input is focused (input-scoped handler) so typing isn't hijacked by navigation; ↵ on empty list is a no-op.

## 6. Verify

- [x] 6.1 `bun run lint` and `bun run typecheck` clean; `bun run build` clean.
- [x] 6.2 Manual check in the running app: search by title/branch/author/`!iid`, toggle "mine" (with and without glab authed), confirm ↑↓/↵/esc operate on the filtered list and the toggle disables gracefully when glab is unavailable.
