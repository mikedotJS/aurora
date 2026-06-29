## Context

The MR sheet (`src/components/MrSheet.tsx`) renders `store.repoMrs[repoRoot]` — the merge-request list cached by the 30s poller in `src/lib/notifications.ts` and force-refreshed on open. Each `GitlabMr` already carries `{ iid, title, branch, draft, author, web_url, updated }`, where `author` is the GitLab **username**. The sheet supports ↑↓/↵/esc against the full list; there is no search input and no notion of "the current user."

To filter by "mine" we need the authenticated user's username. The backend (`src-tauri/src/glab.rs`) shells out to `glab` and currently exposes only `glab_mr_list`. `glab api user` returns the authenticated user as JSON including `username`, which is the same field already stored as `author`, so equality matching is exact.

This is small and UI-local, but it adds one new Tauri command and a cross-process call, which is why it gets a design note.

## Goals / Non-Goals

**Goals:**
- Type-to-search the cached MR list, matching title, branch, author, and `!iid`.
- A "mine" toggle that shows only MRs authored by the current GitLab user.
- Filtering is instant and client-side — it reuses the existing cache, no fetch per keystroke or per toggle.
- Keyboard-first: search auto-focused, ↑↓/↵ operate on the filtered list, a shortcut toggles "mine", esc closes.
- Graceful degradation when glab can't resolve a user (toggle disabled, search still works).

**Non-Goals:**
- Server-side / `glab`-side filtering (e.g. `glab mr list --author=@me`) — we filter the cache locally.
- Filtering by assignee, reviewer, label, or MR state beyond the already-open list.
- Fuzzy/ranked search — a simple case-insensitive substring match is sufficient.
- Persisting search text across opens (it resets each open); persisting the "mine" preference is optional (see Decisions).

## Decisions

### 1. Filter client-side against the cached list, not via glab flags
The poller already caches the full open-MR list and the sheet force-refreshes on open. Filtering in React keeps search/toggle instant and avoids spawning a `glab` process per keystroke. **Alternative considered:** re-run `glab mr list --search=… --author=@me` on each change — rejected for latency, process churn, and because it would bypass the cache the status-bar count and notifications already depend on.

### 2. Resolve the current user via a new `glab_current_user` command, fetched once and cached in the store
Add `glab_current_user() -> Result<String, String>` in `glab.rs` running `glab api user` and reading `.username`. Mirror `glab_mr_list`'s error contract: `Err("glab-not-found")` when the CLI is absent, trimmed stderr otherwise. The frontend fetches it once (lazily, e.g. on first MR-sheet open or alongside poller start), stores it as `store.glabUser: string | null`, and reuses it. **Alternative considered:** parse `glab auth status` text — rejected as brittle vs. structured `glab api user` JSON. **Alternative considered:** derive "mine" from git config email — rejected because MR `author` is a GitLab username, not an email.

### 3. "mine" compares `mr.author === glabUser`
`author` and `glab api user`'s `username` are the same GitLab field, so exact case-sensitive equality is correct and cheap. If `glabUser` is null (glab unavailable), the toggle is rendered disabled and forced off so the list never silently empties.

### 4. Search matches title, branch, author, and `!iid` (case-insensitive substring)
Covers the realistic ways a user recalls an MR. The `iid` is matched both as a bare number and with a leading `!` so typing `!42` or `42` works. Search and the "mine" toggle compose (AND).

### 5. Selection is clamped to the filtered list
`sel` indexes the filtered array. On every change to search text or the toggle, clamp `sel` into `[0, filtered.length-1]` (or 0 when empty) so ↑↓/↵ never point past the end. ↵ on an empty filtered list is a no-op.

### 6. Toggle preference persistence (optional)
Persisting the "mine" toggle in settings is a nice-to-have. Default: start each open with "mine" **off**. If trivially supported by the existing settings store, persist it; otherwise leave session-local. Search text always resets on open.

## Risks / Trade-offs

- **Username mismatch (author shown but "mine" finds nothing)** → Both come from the same GitLab `username` field, so they match by construction; the disabled-when-null rule prevents an empty list looking like a bug.
- **Auto-focusing the search input steals keystrokes from existing ↑↓/↵ handling** → Handle arrows/enter/esc from within the input (or a keydown bound while the input is focused) rather than the window-level listener, so navigation keeps working while typing.
- **Extra `glab` process for the user lookup** → Fetched once and cached for the session, not per open; negligible.
- **glab unavailable** → Search still filters the (possibly empty) cached list; "mine" toggle is disabled. No regression to the current degrade-gracefully behavior.
