<!-- CUT only. Each task is a removal/relabel verifiable by grep + typecheck/lint/build.
     Order: lib/types first (so the tree stays compiling), then components, then config migration,
     then verification. Implementer: keep `bun run build` green after each numbered section. -->

## 1. Remove the agent concept — store + state machine

- [x] 1.1 `state/store.ts`: delete the `AgentKind` type (`:152`) and its export; delete `agent`,
  `agentBusy`, `needsInput` from the `Workspace` interface (`:184-186`).
- [x] 1.2 `state/store.ts`: trim `WsStatus` (`:150`) to `"attention" | "idle"`.
- [x] 1.3 `state/store.ts`: stop setting `agent`/`agentBusy`/`needsInput` in `createWorkspace`
  (`:455-457`) and `rehydrate` (`:484-486`); drop `agent` from the `createWorkspace` opts type.
- [x] 1.4 `state/store.ts`: delete the `setWsAgentBusy` / `setWsNeedsInput` actions — interface
  (`:288-289`) and impl (`:727-731`).
- [x] 1.5 `lib/workspace.ts`: rewrite `statusOf` to git-only (attention on `pipeline === "failed"` or
  `diff.conflicted > 0`, else idle); drop the agent branch (`:11-15`). Simplify `dotColor` /
  `dotPulses` to the two remaining states (no pulse).
- [x] 1.6 `lib/workspace.ts`: rewrite `statusLine` — drop the "claude working…" / "needs your input"
  cases; the clean-tree line keys off `w.repoId == null` → "manual branch" else "idle" (`:38-47`).
- [x] 1.7 `lib/workspace.ts`: remove `agent` from `PersistedWs` (`:59`) and from `savePersisted`'s
  mapping (`:98`); remove the now-unused `AgentKind` import (`:4`).
- [x] 1.8 Verify: `grep -rn "agentBusy\|needsInput\|AgentKind\|w.agent\|\.agent\b" src` returns no live
  references outside removed lines; `bun run build` (tsc) is green.

## 2. Remove the agent concept — presets + create flow

- [x] 2.1 `lib/repoConfig.ts`: drop `agent` (`:21`) and `autoStart` (`:23`) from the `Preset` interface.
- [x] 2.2 `lib/presets.ts`: remove `defaultAgent()` (`:66-70`); drop `agent` + `autoStart` from
  `freshPreset()` (`:23-24`) and from `presetCreateFields()` (`:76,83`); remove the `AgentKind` import.
- [x] 2.3 `lib/create.ts`: drop `"gitlab"` from `CreateSource` (`:49`) — see §4 — and drop `agent`
  (`:61`) and `kickoff` (`:66`) from `CreateSpec`; stop passing `agent` to `createWorkspace` (`:132`).
- [x] 2.4 `lib/create.ts`: in `runCreate`, remove the `st.setInput(pane.id, spec.kickoff)` seeding
  (`:161`) so the no-script branch only runs the install command (`:159-162`).
- [x] 2.5 Verify: `grep -rn "kickoff\|autoStart\|defaultAgent" src` returns nothing; `bun run build` green.

## 3. Remove the agent concept — UI surfaces

- [x] 3.1 `components/WorkspaceRail.tsx`: delete the `AGENT_BADGE` const + `AgentBadge` component
  (`:28-52`) and its use in the card (`:117`); remove the `AgentKind` import (`:6`).
- [x] 3.2 `components/WorkspaceRail.tsx`: in the context bar (`~:483-549`), change the null-gate from
  `!ws.issueKey && ws.agent === "none" && !ws.preset` (`:487`) to `!ws.issueKey && !ws.preset`, and
  remove the `agentLabel` (`:489`) and its render.
- [x] 3.3 `components/WorkspaceScopeForm.tsx`: delete the `AGENTS` const (`:14-17`), the `agent` state
  (`:73`), and the entire "AI scope" picker block (`:314-344`); remove the `autoStart`/`kickoff`
  building in `create()` (`:151-152,160`) and the `agent` / `kickoff` fields from the `CreateSpec`
  it builds (`:173,178`); drop `kickoff` from `ScopeInitial` (`:32`); remove `defaultAgent` import.
- [x] 3.4 `components/WorkspaceCommand.tsx`: remove `agent`/`kickoff` from the quick-create specs
  (`:173,193`) and the `kickoff: text` in the describe `openForm` branch (`:143`); remove the
  `defaultAgent` import (`:11`).
- [x] 3.5 `components/WorkspaceSettings.tsx`: update the preset summary row that reads `p.agent`
  (`:259`) to drop the agent segment (show e.g. `paneLayout · issueTypes`).
- [x] 3.6 `components/PresetEditor.tsx`: remove the agent picker and the `autoStart` toggle (`~:162-164`)
  and any other `draft.agent` / `draft.autoStart` references.
- [x] 3.7 Verify: `grep -rn "AgentBadge\|AI scope\|defaultAgent" src` returns nothing; `bun run build` green.

## 4. Remove the GitLab create source

- [x] 4.1 `components/WorkspaceCommand.tsx`: remove the `{ key: "gitlab", ... }` row from `SOURCES`
  (`:22`) and the `else if (source === "gitlab")` branch in `openForm` (`:144-145`).
- [x] 4.2 `components/WorkspaceScopeForm.tsx`: remove `gitlab` from `SOURCE_LABEL` (`:19`).
- [x] 4.3 `lib/create.ts`: `CreateSource` no longer includes `"gitlab"` (done in 2.3) — confirm no other
  `=== "gitlab"` branch exists in `runCreate`.
- [x] 4.4 Verify: `grep -rn "gitlab" src/components/WorkspaceCommand.tsx src/lib/create.ts` shows no
  create-source references (glab MR/notif surfaces elsewhere are untouched); `bun run build` green.

## 5. Relabel the rail filter

- [x] 5.1 `components/WorkspaceRail.tsx`: change the filter input placeholder "Filter or create…" →
  "Filter…" (`:372`). (Handler stays filter-only; no create behavior is added.)

## 6. Remove the dead repo-config knobs + migration

- [x] 6.1 `components/WorkspaceSettings.tsx`: delete the Auto-port-offset row (`:284-286`), the Isolation
  row (`:300-326`), and the whole Lifecycle section — `Section title="Lifecycle"` + its 3 rows
  (`:331-350`).
- [x] 6.2 `components/WorkspaceSettings.tsx`: delete the now-unused `ISOLATIONS` const (`:25`), the
  `IsolationMode` import (`:14`), and the `setLifecycle` helper (`:159`).
- [x] 6.3 `lib/repoConfig.ts`: drop `defaults.autoPortOffset` (`:46`), `defaults.isolation` (`:47`), the
  whole `lifecycle` object from `RepoConfig` (`:57-61`), and the `IsolationMode` type (`:13`).
- [x] 6.4 `lib/repoConfig.ts`: remove those fields from `defaultRepoConfig` (`:87-88,94-98`).
- [x] 6.5 `lib/repoConfig.ts`: bump `CONFIG_VERSION` 4 → 5 (`:36`); extend `migrate()` (`:122-142`) to
  delete `defaults.autoPortOffset`, `defaults.isolation`, the `lifecycle` key, and `agent`/`autoStart`
  from each preset, on configs whose `version !== 5`. Keep it idempotent via the version gate.
- [x] 6.6 Verify: `grep -rn "autoPortOffset\|IsolationMode\|\.isolation\|pruneWorktreeOnMerge\|closeAction\|cfg.lifecycle\|setLifecycle" src` returns nothing live; `bun run build` green.

## 7. Remove the callerless store actions

- [x] 7.1 `state/store.ts`: delete `renameWorkspace` — interface (`:284`) and impl (`:707-712`).
- [x] 7.2 `state/store.ts`: delete `setWsBranch` — interface (`:285`) and impl (`:714-719`).
- [x] 7.3 Verify: `grep -rn "renameWorkspace\|setWsBranch" src` returns nothing.

## 8. Verification

- [x] 8.1 `bun run build` (Vite + tsc strict) is green with no unused-symbol / unused-import errors.
- [x] 8.2 ESLint flat config clean: `bunx eslint .` (or the repo's lint script) reports no errors.
- [x] 8.3 Config migration smoke test: with a pre-existing `aurora.repoconfig` (v4) in localStorage that
  contains `lifecycle`, `defaults.isolation`, `defaults.autoPortOffset`, and a preset with
  `agent`/`autoStart`, launch the app — confirm it loads without error, the stored config is rewritten
  to `version: 5` with those keys gone, and `basePort` / `baseBranch` / `branchNaming` are preserved.
- [ ] 8.4 Manual UX check: rail shows no agent badge; cards' status dot reflects git only; the scope form
  has no AI-scope picker; the create palette lists no GitLab source; the rail filter reads "Filter…";
  Workspace settings show no Lifecycle / Isolation / Auto-port controls.
- [ ] 8.5 `openspec validate cut-dead-workspace-surface --strict` passes.
