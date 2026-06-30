## ADDED Requirements

### Requirement: Manual branch-name template with live preview
Aurora SHALL support a manual branch-naming template composed of tokens — at least `{key}`, `{type}`,
`{slug}`, `{assignee}`, `{sprint}`, and `{yy-mm}` — and SHALL show a live preview of the resulting
branch name for sample issues as the template is edited. Resolution SHALL lowercase the result, replace
spaces with dashes, trim the slug to a bounded length (40 characters), and drop unknown or
unresolvable tokens.

#### Scenario: Template resolves tokens
- **WHEN** the template is `{key}/{type}/{slug}` and the issue is PROJ-1423 (Bug) titled "Login redirect drops the return URL"
- **THEN** the preview SHALL show `proj-1423/bug/login-redirect-drops-the-return-url` (slug trimmed to 40 chars, lowercased, spaces dashed)

#### Scenario: Unknown token dropped
- **WHEN** the template contains a token that cannot be resolved for an issue
- **THEN** that token SHALL be omitted from the generated name rather than left literal

### Requirement: Branch naming bound to package.json
Aurora SHALL support reading the branch-naming pattern from a configured `package.json` field so the
pattern travels with the repo and is shared with the team. The bound pattern SHALL be shown read-only,
labeled as bound/synced, and SHALL be re-read when `package.json` changes.

#### Scenario: Pattern read from package.json
- **WHEN** `package.json` contains `"aurora.branchPattern": "{type}/{key}-{slug}"` and the bound source is selected
- **THEN** Aurora SHALL use that pattern and display it as synced from the file

#### Scenario: Re-read on change
- **WHEN** the bound `package.json` pattern is edited on disk
- **THEN** Aurora SHALL pick up the new pattern without manual reconfiguration

### Requirement: Branch naming inferred from an existing validator
Aurora SHALL detect an existing branch-name validator in the repo (a `validate-branch-name` regex in
`package.json`, a husky hook, or commitlint config), parse its pattern into ordered groups (enumerated
groups becoming pickers and free-text groups becoming slug fields), and generate branch names that are
**guaranteed to match** that regex. The composed name SHALL be validated before a workspace is created
so it cannot fail the repo's pre-push hook.

#### Scenario: Enum groups become pickers
- **WHEN** the detected regex requires `<type>/<app>/<key>-<slug>` with `type` ∈ {feat,fix,chore} and `app` from the issue component
- **THEN** Aurora SHALL offer `type` and `app` as pickers and compose e.g. `feat/api/GODY-456-add-webhook-retries`

#### Scenario: Generated name passes the validator
- **WHEN** a name is composed under the inferred rule
- **THEN** Aurora SHALL confirm it matches the validator (✓) and SHALL flag any non-matching candidate (✕) before creation

### Requirement: AI-instructed branch naming chained through the validator
Aurora SHALL support a plain-English branch-naming instruction that Claude applies per issue (e.g.
inferring `<app>` from the issue's component). When a validator is present, the AI output SHALL be
**chained through it**: the generated name is validated and, on failure, Claude is re-prompted with the
failure and retries until the name passes or a retry limit is reached. The preview SHALL show Claude's
reasoning and the validator result.

#### Scenario: AI output validated and retried
- **WHEN** the AI instruction is set, a validator exists, and Claude's first proposed name fails the validator
- **THEN** Aurora SHALL re-prompt Claude with the failure and retry until a name passes or the retry limit is hit

#### Scenario: Reasoning and result shown
- **WHEN** Claude proposes a branch name for an issue under an AI instruction
- **THEN** the preview SHALL show its reasoning and a ✓/✕ validator result for the proposed name

### Requirement: Authoritative validation before creation
When a repo has a real branch-name validator, Aurora SHALL run that validator on the chosen branch name
before creating the workspace, falling back to the parsed-regex test and then to a local sanity check.
Creation SHALL be blocked (with a clear message) when the name would fail the repo's validator.

#### Scenario: Creation blocked on validator failure
- **WHEN** the chosen branch name fails the repo's `validate-branch-name` validator
- **THEN** workspace creation SHALL be blocked with a message explaining the required format
