## Why

Tabs are labeled by the last segment of their cwd (or `zsh`) — uninformative once a workspace has several tabs each running something different (a dev server, a test watcher, a REPL, an agent). A quick, cheap Haiku call can turn "what's running here" into a short, glanceable label (`vite dev`, `jest watch`, `psql`), so multi-tab workspaces are navigable at a glance instead of all reading `odyssey-frontend`.

## What Changes

- **Tabs gain an auto-set name**: `Group` gets an optional `name`; `tabTitle` prefers it and falls back to today's cwd-segment label, so nothing regresses when auto-naming is off or hasn't run.
- **Quick Haiku rename on a long-running command**: when a foreground command has been running in a tab's active pane past a short threshold (i.e. it's a real process, not a quick `ls`), Aurora makes a **fast Haiku call** (BYO key, from Rust) with the command line and a short output snippet, and sets the tab's name to a 1–3 word label.
- **Cheap + safe**: debounced and **cached per (tab, command)** so the same process isn't re-summarized; the returned label is sanitized (single line, control chars stripped, length-capped); the command/output are treated as untrusted **data**, and nothing is executed.
- **Settings toggle**: an "Auto-rename tabs" toggle (**default on**) disables the feature; when off — or when no Anthropic key is set — tabs keep the cwd label and no model call is made.
- **Uses Haiku specifically** (`claude-haiku-4-5-20251001`) for speed/cost, independent of the model chosen for command suggestions.

## Capabilities

### New Capabilities
- `tab-auto-rename`: derive a short tab label from the command running in the tab's active pane via a quick Haiku call (BYO key, via Rust), debounced + cached, sanitized, with a settings toggle (default on) and graceful degradation when disabled or unkeyed.

### Modified Capabilities
<!-- No existing baseline spec under openspec/specs/ owns tab labelling (it lives in the
     `workspaces-core` change). The new behaviour is captured as the new capability above;
     the tab-title fallback is additive and doesn't change existing requirements. -->

## Impact

- **Frontend (`src/`)**: `state/store.ts` — add `Group.name`, a `setTabName(tabId, name)` action, `Settings.autoRenameTabs` (+ `DEFAULT_SETTINGS`); `components/TabStrip.tsx` — `tabTitle` prefers `g.name`; new `lib/tabNaming.ts` — detect a long-running command in the active pane, debounce, call Haiku (`claude_text` with the Haiku model + small `max_tokens`), sanitize the label, `setTabName`, cache per (tab, command); a small effect (in `App.tsx`) observing the active pane's running block to trigger it; `components/SettingsModal.tsx` — the toggle.
- **Reuses**: the Anthropic BYOK path (`claude_text` + keychain) and the per-pane block/command state already tracked in the store. No backend change.
- **Depends on**: an Anthropic key for naming (degrades to the cwd label otherwise); the block/command lifecycle (`startBlock`/`endBlock`) to know what's running.
- **Out of scope**: a manual tab-rename UI; distinct names per pane in a split tab (the tab reflects its active pane); non-Anthropic providers.
