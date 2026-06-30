# Design — auto-rename-tabs

## Context

Aurora tabs are `Group`s; `TabStrip.tsx`'s `tabTitle(g, home)` labels them by the active pane's
cwd last-segment (or `zsh`). The store already tracks each pane's command lifecycle as blocks
(`startBlock(command)` … `endBlock(code)`), and there's a BYOK Anthropic path — `claude_text(system,
prompt, model, max_tokens)` (key in the keychain, request from Rust) — plus a Haiku model id
(`claude-haiku-4-5-20251001`). This change layers a quick Haiku call on top to set a short tab name
from whatever is running in the tab's active pane, with a settings toggle.

Standing constraint: secrets never enter the webview (the call goes through Rust), and command/output
text is **data**, never executed — here it can only ever produce a sanitized tab label.

## Goals / Non-Goals

**Goals:**
- A glanceable tab label reflecting the running process (`vite dev`, `jest watch`, `psql`).
- Cheap and quiet: a fast Haiku call, only for long-running commands, debounced + cached, never on a
  quick `ls`.
- Off by a settings toggle; no call when disabled or unkeyed; fall back to the cwd label.
- Command/output treated as untrusted data; the label is sanitized and length-capped.

**Non-Goals:**
- Manual tab renaming UI (separate concern; this only sets the auto name).
- Distinct labels *per pane* — a split tab gets one combined label covering all its running panes.
- Non-Anthropic providers; renaming the workspace title.

## Decisions

### D1 · Trigger on a *long-running* command set, not every command
Watch the running command in **every pane of the active tab** (a stable key built from the commands).
If the set is still running after a short threshold (~1.5s), those are real processes worth labelling.
Quick commands end before the threshold and are ignored. A split tab is named from all its running
panes together; the key is derived from commands only, so output growth doesn't reset the debounce.
- *Alternatives:* rename on every command (rejected — noisy, costly, flickers on each `ls`); only on
  alt-screen/raw-mode TUIs (rejected — misses block-mode streamers like `vite`/`next dev`); name from
  the active pane only (rejected — a split tab running a server + a watcher should reflect both).

### D2 · A quick Haiku call, reusing the BYOK path
Call `claude_text` with the **Haiku** model (`claude-haiku-4-5-20251001`) and a small `max_tokens`
(~20). The system prompt asks for ONLY a 1–3 word label (no punctuation/quotes); the user message
carries the command line plus a short, truncated output snippet, framed as data.
- *Alternatives:* the user's suggestions model (rejected — Haiku is the point: fast + cheap); a local
  heuristic/regex map of commands→labels (rejected as the primary path — brittle across stacks; though
  a tiny built-in shortcut for obvious cases could skip the call later).

### D3 · One central, source-agnostic trigger
A single effect (in `App.tsx`) observes the active pane's running command and fires the debounced
rename. This covers commands typed by the user **and** those started by scripts (`runScript`) without
scattering hooks. The effect keys on the active pane id + its running block's command.
- *Alternatives:* hook in `keymap.ts runInShell` (rejected — misses script-started processes; scattered).

### D4 · Debounce + cache per (tab, command)
Debounce the call (~the threshold) and cache the resulting label by `(tabId, commandKey)` in memory, so
re-activating a tab or re-rendering doesn't re-summarize the same running process. A new distinct
command in the tab supersedes it.

### D5 · Sanitize the label; keep-last on idle
Trim to a single line, strip control chars, collapse whitespace, cap ~24 chars; an empty/garbage result
is discarded (keep the existing label). When the command ends and the shell returns to idle, **keep the
last meaningful name** rather than thrashing back to the cwd — calmer, and the next long-running command
replaces it.

### D6 · Settings toggle, default on; graceful degradation
`Settings.autoRenameTabs` (default `true`). When off, or when no Anthropic key is set, the trigger
no-ops and `tabTitle` uses the cwd fallback — identical to today.

## Risks / Trade-offs

- **Cost / latency** → Haiku + the long-running threshold + debounce + per-(tab,command) cache keep it
  to roughly one tiny call per distinct long-running process.
- **Prompt injection from command output** → output is framed as data and never executed; the worst case
  is a misleading tab label, further bounded by sanitisation + the length cap.
- **Flicker / churn** → threshold + cache + keep-last-on-idle avoid renaming on every quick command or
  flipping back to the cwd between commands.
- **Odd / wrong labels** → purely cosmetic; the toggle turns it off, and the cwd fallback always remains.

## Migration Plan

Additive. `Settings.autoRenameTabs` defaults `true` and merges over persisted settings (which spread over
`DEFAULT_SETTINGS`), so existing users get it on. `Group.name` is optional (undefined = cwd label); tab
runtime isn't persisted, so names are recomputed live. Rollback = remove the trigger effect + the toggle;
`tabTitle`'s fallback already covers a missing name.

## Open Questions

- Keep-last vs revert-to-cwd when a tab goes idle (this design keeps last; revisit if it feels stale).
- A built-in fast-path for obvious commands (`npm run dev` → `dev`) to skip the call entirely — possible
  follow-up to cut calls further.
- A manual rename / "lock this name" affordance so auto-rename won't override a user-chosen label.
