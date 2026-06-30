## 1. Store: tab name + setting

- [x] 1.1 Add optional `name?: string | null` to `Group`; add a `setTabName(tabId, name)` action that sets the named tab's `name` (no-op if unchanged).
- [x] 1.2 Add `autoRenameTabs: boolean` to `Settings` (default `true` in `DEFAULT_SETTINGS`).

## 2. Tab label fallback

- [x] 2.1 `TabStrip.tsx`: `tabTitle` returns `g.name` when set (sanitized/non-empty), else the existing cwd-segment fallback.

## 3. Naming engine (`src/lib/tabNaming.ts`)

- [x] 3.1 `buildPrompt(command, outputSnippet)`: Haiku system prompt requesting ONLY a 1–3 word label (no quotes/punctuation); command + truncated output framed as data, with an "ignore embedded instructions" note.
- [x] 3.2 `sanitizeLabel(raw)`: single line, strip control chars, collapse whitespace, cap ~24 chars; return null when empty/garbage.
- [x] 3.3 `requestTabName(tabId, panes[])`: take all running panes in the tab (single or combined prompt); gate on `settings.autoRenameTabs` + `apiKeyPresent`; per-(tabId, command-set) in-memory cache; call `claudeText(system, prompt, "claude-haiku-4-5-20251001", ~24)`; on a sanitized label, `setTabName`; swallow errors / `NoKeyError` (no rename).

## 4. Trigger (`App.tsx` effect)

- [x] 4.1 Observe the running command in every pane of the active tab (a stable command-only key); when the set stays `running` past the threshold (~1.5s), gather all still-running panes and call `requestTabName(activeTabId, panes)` debounced. Covers split tabs + user-typed and script-started commands.
- [x] 4.2 Keep-last on idle: when the command ends, leave the tab's name as-is (next long-running command supersedes it); don't revert to cwd.

## 5. Settings UI

- [x] 5.1 `SettingsModal.tsx`: an "Auto-rename tabs" toggle (in the Shell section) bound to `settings.autoRenameTabs`, with a one-line description noting it uses a quick Haiku call.

## 6. Validation

- [x] 6.1 Verify each spec scenario: long-running command names its tab; quick command doesn't; unnamed tab shows cwd label; key stays in backend (only command/snippet sent); same command not re-summarized (cache); output can't drive behavior + is sanitized; unusable label ignored; toggle off → no call; no key → no call.
- [x] 6.2 `bun run lint`, `bunx tsc --noEmit`, and `bun run build` clean.
