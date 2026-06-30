# Design — jira-integration

## D1 · Connection & secrets

Mirror the Anthropic BYOK pattern (`claude.rs` + `keychain`): the Jira **API token** lives in the OS
keychain (`keyring` crate, service `aurora-jira`), never in the webview or config file. The non-secret
parts — `site` (`https://acme.atlassian.net`) and `email` — plus the per-repo default `projectKey`
persist in `RepoConfig` (from `workspace-config`) / `localStorage`. Connection state in the store:
`jira: { connected: boolean; site: string | null; email: string | null }`.

Backend keychain commands (parallel to `key_set`/`key_get`/`key_present`/`key_delete`):
`jira_set_token(token)`, `jira_token_present()`, `jira_clear_token()`. All API calls read the token
from the keychain in Rust; the frontend passes only `site` + `email`.

## D2 · REST client (`src-tauri/src/jira.rs`)

Jira Cloud REST v3 over HTTPS via `reqwest` (already used by `claude.rs`), Basic auth
`base64(email:token)`:
- `jira_validate(site, email) -> { accountId, displayName }` — `GET /rest/api/3/myself`. Used by the
  connect flow to confirm credentials.
- `jira_search(site, email, query) -> Vec<JiraIssue>` — `GET /rest/api/3/search?jql=…`. If `query`
  looks like a key (`[A-Z]+-\d+`) → fetch directly; if free text → JQL
  `summary ~ "<q>" OR key = "<q>"`; default ("my sprint") → `assignee = currentUser() AND sprint in
  openSprints() ORDER BY updated DESC`. Map fields to `JiraIssue`.
- `jira_issue(site, email, key) -> JiraIssueDetail` — `GET /rest/api/3/issue/<key>?fields=…` +
  comments; extract summary, type, status, assignee, components, fixVersions, sprint, the description
  (acceptance criteria — ADF flattened to text), and recent comments.
- `jira_transition(site, email, key, toName)` — `GET …/transitions` to resolve the transition id whose
  target status name matches `toName` (case-insensitive), then `POST …/transitions`.
- `jira_add_remote_link(site, email, key, url, title)` — `POST /rest/api/3/issue/<key>/remotelink`
  (preferred over a comment for MR links; fall back to a comment if remote links are disabled).

`JiraIssue { key, summary, issueType, status, assignee?, component?, fixVersion?, sprint? }`;
`JiraIssueDetail` extends it with `description` (text) and `comments: [{author, body, ts}]`.

Errors: missing token → `Err("jira-not-connected")` so the UI degrades; HTTP/4xx/5xx → trimmed
message. No token in logs.

## D3 · Create-from-Jira (activates `workspace-create`'s inert source)

- Palette Jira source: as the user types, debounce → `jira_search`. Render issues grouped under
  "Jira · my sprint" / search results, each with key, summary, status chip. Selecting one (Frame 2)
  expands the **derived plan**: branch (via `resolveBranchName` with the issue), base (repo default or
  inferred from fix version), preset (auto-selected from issue type via `workspace-config`), agent
  (repo default), and "context → Claude".
- On create: build the `CreateSpec` with `issueKey`, `title = summary`. After the worktree + panes
  exist, fetch `jira_issue(key)` and compose a **context block** (summary + acceptance criteria +
  recent comments) handed to the workspace's Claude agent — either as the kickoff prompt or written
  to a context file the agent reads. The workspace stores `issueKey`, `jiraStatus`, `jiraUrl` for the
  rail chip + context bar.

## D4 · Two-way sync

Gated by `workspace.jiraSync` (set from the preset/scope toggle, now enable-able). Triggers:
- **On create** (sync on): `jira_transition(key, "In Progress")` (best-effort; surfaces a toast on
  failure, never blocks creation).
- **On MR open**: detected when the workspace's branch gains an MR (from `glab_mr_list` polling already
  in the app) → `jira_add_remote_link(key, mr.web_url, mr.title)` once per MR.
- **On MR merge**: when the MR state becomes `merged` → `jira_transition(key, "Done")` (or the repo's
  configured done-status name).

Sync actions are idempotent (track what's been posted/transitioned on the workspace) and best-effort:
Jira being down never blocks git/MR work. Transition target names are configurable per repo (default
"In Progress"/"Done") since workflows vary.

## D5 · Issue types → presets & branch naming

`workspace-config` reads issue types and components from here: `jira_issue`/`jira_search` expose
`issueType` and `component`, which feed preset auto-select (issue type) and the validator/AI
branch-naming `{type}`/`<app>` groups. When Jira is unconfigured those inputs are simply absent and the
non-Jira sources still work.

## D6 · Graceful degradation & security
- Every Jira call short-circuits to a "not connected" state when no token is present; the foundation's
  inert UI is the fallback.
- Token only in the keychain; only `site`+`email` cross into the webview. Treat all issue text as data
  (it's rendered, not executed); when loading issue context into Claude, it's quoted as context, not
  as instructions to Aurora.

## D7 · Out of scope
- Jira Server/Data Center (only Cloud REST v3 here); OAuth 3LO (API-token Basic auth only);
  creating/editing issues from Aurora (read + transition + link only); sprint board management.
