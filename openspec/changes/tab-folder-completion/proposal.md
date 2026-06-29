## Why

Today the prompt only does something useful on **Tab** when a ghost suggestion already exists
(from history, a Claude suggestion, or a matched filesystem path). When there is no ghost — the
common case when starting a fresh `cd`/path argument — Tab does nothing, so users can't discover
or complete the folders that actually live in the current directory. Real terminals make Tab the
primary way to explore the filesystem; Aurora should too, independent of whether Claude or the
ghost engine had a suggestion to offer.

## What Changes

- Pressing **Tab** performs explicit filesystem completion on the path token under the cursor,
  **even when no ghost/Claude suggestion is present** — listing the matching folders in the
  relevant directory.
- Resolution rules:
  - **Exactly one match** → complete it inline (append the folder name + trailing `/`).
  - **Multiple matches** → show a selectable completion list of folders the user can navigate
    (↑/↓ + Tab/↵ to accept, Esc to dismiss); pressing Tab again with a common prefix completes
    that shared prefix.
  - **No match** → no-op (no list, no error).
- Completion is **folder-first**: directories are listed (with a trailing `/`); the design notes
  how/whether plain files are included.
- Path token resolution handles the cwd, an explicit relative/absolute prefix (e.g. `cd src/com`,
  `./`, `../`, `~/`), and ignores dotfiles unless the prefix itself starts with `.`.
- Precedence with the existing ghost autocomplete is made explicit: when a ghost is showing, Tab
  still accepts the ghost; when there is no ghost, Tab triggers folder completion.

## Capabilities

### New Capabilities
- `folder-completion`: Tab-triggered filesystem completion of the path token in the prompt —
  listing/selecting folders in the relevant directory, completing inline on a single match, and
  doing so independently of the ghost-autocomplete and Claude-suggestion paths.

### Modified Capabilities
<!-- The existing `smart-prompt` capability (Tab "accepts the ghost") is part of the in-progress
     `add-aurora-terminal` change and is not yet a baseline spec under openspec/specs/, so it is
     not modified via a delta here. The interaction (ghost-present vs. no-ghost) is captured as a
     requirement inside the new `folder-completion` spec instead. -->

## Impact

- **Frontend (`src/`)**: the React smart-prompt input — its `keydown`/Tab handling gains a
  folder-completion path and a completion-list UI surface; new prompt state for the candidate
  list and selection index.
- **Backend (`src-tauri/`)**: a Tauri command to read directory entries for a given base path
  (reusing the existing readdir capability already used to feed ghost autocomplete), returning
  folder names (and dir/file kind) for the prompt to filter.
- **No breaking changes**: existing ghost-accept behavior is preserved; folder completion only
  engages when Tab would otherwise have been a no-op.
