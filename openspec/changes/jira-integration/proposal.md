## Why

The mockup makes Jira the primary seed for work: the ⌘K palette searches "my sprint", a selected
issue previews the branch/preset/agent Aurora will create, the issue's title + acceptance criteria +
comments are loaded into Claude as context, and a **two-way sync** moves the issue to In Progress on
create and posts the MR link / transitions on open and merge. The foundation deliberately ships the
Jira **source tab inert** ("connect Jira") and the sync toggle disabled. This change makes Jira real:
a BYO Jira Cloud connection (site URL + email + API token, token in the OS keychain, like the
Anthropic key), the issue search/detail used by the create flow, and the transition/link-posting used
by sync — all degrading gracefully when Jira isn't configured.

## What Changes

- **Connection**: store a Jira Cloud connection — `site` (`https://acme.atlassian.net`), `email`, and
  an **API token in the OS keychain** (never the webview). A "Connect Jira" flow in Workspaces settings
  validates the credentials (`/myself`) and records the site + default project key per repo.
- **Issue search & detail** (Rust): `jira_search(jql|text)` for the palette ("my sprint" =
  assignee = currentUser() AND sprint in openSprints()), and `jira_issue(key)` returning summary, type,
  status, assignee, component(s), fix version, sprint, acceptance criteria, and recent comments.
- **Create-from-Jira**: the palette's Jira source becomes live — pick an issue, see the derived plan
  (branch from the configured naming rule, preset auto-selected from issue type, agent, "context →
  Claude"), create the workspace, and load the issue context into the workspace's Claude agent.
- **Two-way sync** (when enabled per workspace/preset): on create → transition the issue to In
  Progress; on MR open → post the MR link as an issue comment / remote link; on MR merge → transition
  toward Done. Transitions are resolved by name against the issue's available transitions.
- **Issue types feed presets**: `workspace-config`'s preset "auto-select for issue type" and the
  branch-naming `{type}`/component groups read real issue metadata from here.

## Capabilities

### New Capabilities
- `jira`: a BYO Jira Cloud connection (token in the keychain), issue search + detail for the create
  flow, and two-way issue sync (transition on create/merge, post MR link on open), with graceful
  degradation when unconfigured.

### Modified Capabilities
<!-- Activates the inert Jira source/sync from `workspace-create` and the Integrations + issue-type
     surfaces in `workspace-config`. Captured as new requirements; those changes are not yet baseline
     specs under openspec/specs/. -->

## Impact

- **Frontend (`src/`)**: `lib/jira.ts` (search/detail/transition wrappers + connection state);
  `components/JiraConnect.tsx` (connect flow in Workspaces settings); the create palette's Jira source
  and the scope form's Jira-sync toggle become live; the workspace context bar shows the issue + status
  chip; loading issue context into the Claude agent on create.
- **Backend (`src-tauri/`)**: new `jira.rs` — `jira_set_token`/`jira_token_present`/`jira_clear_token`
  (keychain, mirroring `claude.rs`), `jira_validate(site,email)`, `jira_search(site,email,query)`,
  `jira_issue(site,email,key)`, `jira_transition(site,email,key,toName)`,
  `jira_add_remote_link(site,email,key,url,title)` — HTTPS via `reqwest` with Basic auth
  (`email:token`); registered in `lib.rs`.
- **Sync wiring**: hook MR open/merge detection (from the existing `glab` MR state) to fire the
  transition/link-post when a workspace has sync enabled.
- **Config**: per-repo Jira `site` + default project key persisted with `RepoConfig`
  (`workspace-config`); the token in the keychain.
- **Depends on**: `workspaces-core`, `workspace-create` (and surfaces in `workspace-config`).
- **Status**: PROPOSED in this pass; implemented after the foundation lands.
