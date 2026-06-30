<!-- CUT — movement #1 of 4 in the Workspaces recovery roadmap (docs/workspaces-reprise-roadmap.md).
     This change only REMOVES dead/cosmetic surface. UNIFY / BUILD-teardown / BUILD-port-isolation
     are separate, later changes. -->

## Why

The Workspaces feature ships an *enterprise* config surface around a core that does not yet keep its
promise. Several surfaces **promise behavior that never fires**:

- An **AI-agent activity layer** with no producer: a status-dot machine (`agentBusy` / `needsInput`)
  whose setters are never called (`store.ts:288-289,727-731`, read only by `statusOf` in
  `workspace.ts:11-17`), an **agent badge** on every card (`WorkspaceRail.tsx:28-52,117`), an
  **"AI scope" picker** in the scope form (`WorkspaceScopeForm.tsx:314-344`), an
  **autoStart → kickoff** that is typed into the prompt but never submitted (`create.ts:161`,
  `WorkspaceScopeForm.tsx:151-161`). No agent is ever spawned, so all of it is a promise-lie.
- **Dead repo-config knobs** persisted and read by no logic: the **Lifecycle** section
  (`closeAction` / `pruneWorktreeOnMerge` / `confirmDelete`, `WorkspaceSettings.tsx:331-350`), the
  **Isolation** control (`:300-326`), and the **Auto-port-offset** toggle (`:284-286`). Verified: no
  reader exists outside the settings UI and the config defaults.
- A **GitLab create source** whose label ("a GitLab issue or MR") lies — it runs no `glab` fetch, it
  just slugifies the query into a branch (`WorkspaceCommand.tsx:22,144-145`, `create.ts:49`).
- A rail filter input placeholder that says **"Filter or create…"** but only filters
  (`WorkspaceRail.tsx:372`).
- Two **store actions with no caller**: `renameWorkspace` and `setWsBranch`
  (`store.ts:284-285,707-719` — confirmed callerless by grep).

Cutting these removes roughly half the config UI and every promise the core can't keep, clarifying the
ground before UNIFY and BUILD.

## What Changes

- **Remove the AI-agent concept entirely** (no real spawn exists, so "no-op until wired" is just kept
  dead weight; the checkpoint decision is full removal):
  - Drop `AgentKind`, `Workspace.agent`, `Workspace.agentBusy`, `Workspace.needsInput`, and the
    `setWsAgentBusy` / `setWsNeedsInput` actions from the store + persistence.
  - Reduce the status-dot machine (`lib/workspace.ts`) to **git-only**: `WsStatus` becomes
    `"attention" | "idle"`; `statusOf` drops the agent branch; `statusLine` drops the
    "claude working…" / "needs your input" lines; the "manual branch" vs "idle" line keys off
    `repoId == null` instead of the agent.
  - Remove `AgentBadge` from the rail and the "claude / manual" agent label from the rail context bar.
  - Remove the "AI scope" picker (`AGENTS` const) from the scope form, and the `autoStart → kickoff`
    seeding; drop `CreateSpec.kickoff` and the `setInput(pane, kickoff)` seeding in `runCreate`.
  - Drop `agent` + `autoStart` from `Preset` (and the corresponding controls from `PresetEditor`) and
    from `presetCreateFields`; remove `defaultAgent()`.
- **Remove the dead repo-config knobs** with a **backward-compatible migration**:
  - Settings UI: delete the Lifecycle section, the Isolation row, and the Auto-port-offset toggle
    (plus the now-unused `ISOLATIONS` const and `setLifecycle` helper).
  - `repoConfig.ts`: drop `defaults.autoPortOffset`, `defaults.isolation`, the whole `lifecycle`
    object, the `IsolationMode` type; **bump `CONFIG_VERSION` 4 → 5** and extend `migrate()` to strip
    these keys (and preset `agent`/`autoStart`) from stored configs. Keep `basePort`, `baseBranch`,
    `branchNaming`, `showRailOnLaunch`, `jiraSyncDefault`, `aiDefaultId` (DEFER).
- **Remove the GitLab create source** (decision below): drop `"gitlab"` from `CreateSource`, the
  source row in `WorkspaceCommand`, the `gitlab` branch in `openForm`, and `SOURCE_LABEL.gitlab`.
- **Relabel** the rail filter placeholder "Filter or create…" → **"Filter…"**.
- **Remove** the callerless `renameWorkspace` and `setWsBranch` store actions (interface + impl).

### Key decisions

- **Agent: full removal, not no-op.** A no-op field still renders a "claude" label on cards and a dead
  kickoff — i.e. it still lies. Removing the concept is the smaller honest end-state. If/when a real
  spawn is built, the model is re-introduced deliberately (BUILD phase), not resurrected from a stub.
- **GitLab source: remove, not relabel.** A relabel ("a new branch from text") would just duplicate the
  existing **branch** and **describe** sources — pure redundancy. Removal is the smallest honest change
  and the `glab` MR / notification surfaces (KEEP) are untouched: this only removes a *create source*.
- **Config migration is lossless for kept fields.** Old stored JSON loads, `migrate()` strips the now-
  removed keys, sets `version: 5`, and re-persists. Reading old data never throws; no kept setting is
  lost.

### Non-goals (explicitly NOT in this change)

- The `setCommandQuery` repo-target bug (`store.ts:746` drops `repoId`) — that is the **UNIFY** change.
- Unifying the quick-create vs scope-form paths — **UNIFY**.
- Teardown / process-group kill, real port-offset consumption — **BUILD**.
- Container isolation, multi-account AI pool (`aiDefaultId` / `Connections`), Jira write-back, preset
  width/env editor — **DEFER** (left as-is). Note: the agent cut makes `aiDefaultId` fully inert (its
  only nominal effect was defaulting the workspace agent); the picker is left in place per DEFER and
  flagged for the multi-account work.
- KEEP and untouched: auto-rename tabs (`tabNaming.ts`), AI script generation (`aiScripts.ts`),
  `basePort`, Jira read-only source.

## Capabilities

### Modified Capabilities
<!-- These capabilities are defined by the not-yet-archived changes workspaces-core / workspace-create /
     workspace-config (no baseline under openspec/specs/ yet). The deltas here express the removals as
     MODIFIED / REMOVED / ADDED requirements against those capabilities, to be applied when archived in
     dependency order. -->
- `workspaces`: status dot reduced to git-only; agent kind / badge / activity state removed from the
  model, rail card, and context bar; rail filter relabeled.
- `workspace-create`: GitLab source removed; AI-scope picker and kickoff removed from the create flow.
- `workspace-presets`: Lifecycle controls removed; new-workspace defaults reduced to wired knobs
  (no auto-port toggle, no isolation control); preset definition loses AI-scope / start-agent fields.

## Impact

- **Frontend (`src/`)**:
  - `state/store.ts` — remove `AgentKind`, agent fields on `Workspace`, the two agent setters,
    `renameWorkspace`, `setWsBranch`; trim `WsStatus`; stop reading/writing `agent` in
    `createWorkspace` / `rehydrate`.
  - `lib/workspace.ts` — git-only status machine; `PersistedWs` drops `agent`.
  - `lib/repoConfig.ts` — drop dead fields + `IsolationMode`; `CONFIG_VERSION` 4 → 5 + migration.
  - `lib/presets.ts` — drop `agent` / `autoStart` / `defaultAgent`.
  - `lib/create.ts` — `CreateSource` drops `gitlab`; `CreateSpec` drops `agent` + `kickoff`; `runCreate`
    drops the kickoff seeding.
  - `components/WorkspaceRail.tsx` — remove `AgentBadge` + agent label + relabel filter.
  - `components/WorkspaceScopeForm.tsx` — remove AI-scope picker + kickoff building + `agent` state.
  - `components/WorkspaceCommand.tsx` — remove GitLab source row + agent fields in create specs.
  - `components/WorkspaceSettings.tsx` — remove Lifecycle / Isolation / Auto-port rows + unused consts.
  - `components/PresetEditor.tsx` — remove the agent + autoStart controls.
- **Backend (`src-tauri/`)**: none. No Rust touched; secrets/providers stay in Rust (unchanged).
- **Persisted data**: `aurora.repoconfig` migrated in place (v5); `aurora.workspaces` is forward/backward
  tolerant (the dropped `agent` key on stored workspaces is simply ignored on rehydrate).
- **Depends on**: `workspaces-core`, `workspace-create`, `workspace-config` (the capabilities it trims).
- **Hands off to**: UNIFY (next change) for the create-path merge + repo-target fix.
