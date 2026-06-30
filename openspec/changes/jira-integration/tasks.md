<!-- PROPOSED. Implement after the foundation (workspaces-core, workspace-create) lands. -->

## 1. Backend: keychain + REST client (`src-tauri/src/jira.rs`)

- [x] 1.1 Keychain commands `jira_set_token`/`jira_token_present`/`jira_clear_token` (service `aurora-jira`, mirroring `claude.rs`).
- [x] 1.2 `jira_validate(site,email)` → `GET /rest/api/3/myself` (Basic auth `email:token` from keychain).
- [x] 1.3 `jira_search(site,email,query)` → key / free-text / "my sprint" JQL; map to `JiraIssue`.
- [x] 1.4 `jira_issue(site,email,key)` → detail + comments (ADF description flattened to text).
- [x] 1.5 `jira_transition(site,email,key,toName)` (resolve transition id by target status name) and `jira_add_remote_link(site,email,key,url,title)` (fallback to comment).
- [x] 1.6 Register all in `lib.rs`; never log the token; `cargo build` clean.

## 2. Frontend bridges + connection state

- [x] 2.1 `lib/jira.ts`: wrappers + `jira` connection state in the store; `.catch` → not-connected.
- [x] 2.2 `components/JiraConnect.tsx`: connect/validate/disconnect flow inside Workspaces settings; persist `site`+`email`+ per-repo project key in `RepoConfig`.

## 3. Create-from-Jira (activate the inert source)

- [x] 3.1 Palette Jira source: debounced `jira_search`; render results + derived-plan expansion (branch via `resolveBranchName`, preset via issue type, agent, context note).
- [x] 3.2 On create: fetch `jira_issue`, compose context block (summary + acceptance criteria + comments), hand to the workspace's Claude agent; store `issueKey`/`jiraStatus`/`jiraUrl`.
- [x] 3.3 Context bar + rail chip show the issue key + Jira status.

## 4. Two-way sync

- [x] 4.1 Enable the scope/preset Jira-sync toggle; record per-workspace + per-repo done/in-progress status names.
- [x] 4.2 On create (sync on) → `jira_transition(key,"In Progress")`, best-effort + toast on failure.
- [x] 4.3 Hook MR state (from `glab_mr_list` polling): on open → `jira_add_remote_link` once; on merge → `jira_transition(key,"Done")`. Idempotent guards on the workspace.

## 5. Validation

- [ ] 5.1 Manually verify each spec scenario: connect validates + token only in keychain + disconnect; my-sprint search; direct key; not-connected degrade; derived plan; context loaded; issue metadata on card; transition on create; MR link posted once; transition on merge; Jira-down doesn't block; component feeds branch group.
- [x] 5.2 `bun run lint`, `bun run build`, `cargo build` clean.
