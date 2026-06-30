# Workspaces + Repos — audit de superfluité (scope-cut)

> Source : passe `ux-qa` (scope-cut) du 2026-06-30. Companion de `docs/workspaces-ux-papercuts.md`.
> **Override produit** : `auto-rename tabs` (#8) et `génération IA de scripts` (#7) sont **gardés (KEEP)** — décision du 2026-06-30, contre la reco initiale "Defer".

## Verdict bloat

La feature embarque une surface de config *enterprise* (presets, modes d'isolation, politique de cycle de vie, multi-comptes IA, Jira 2-way, génération IA, auto-rename) autour d'un cœur qui ne tient pas encore sa promesse : **l'offset de port est exporté mais consommé par rien, le chemin rapide ne lance aucun serveur, et il n'y a pas de teardown.** L'item le plus nocif : **la couche agent IA qui ne lance rien** — un badge, une machine d'états "claude bosse…/a besoin de toi", un picker "AI scope", et un kickoff tapé dans le prompt mais jamais soumis.

## Cut list (classée par confusion + surface retirée)

| # | Item | Classe | Evidence `file:line` | Pourquoi superflu maintenant | Reco |
|---|------|--------|----------------------|------------------------------|------|
| 1 | Couche agent IA : `AgentBadge`, états agent, picker "AI scope", "Start agent on ticket", `kickoff` | COSMÉTIQUE | `agentBusy`/`needsInput` sans producteur (`store.ts:727-731`) ; branche agent de `statusOf` inatteignable `workspace.ts:11-17` ; badge `WorkspaceRail.tsx:28-52,117` ; AI scope `WorkspaceScopeForm.tsx:314-344` ; kickoff `setInput` only `create.ts:161` | Aucun agent n'est jamais lancé. Badge + états + kickoff promettent un comportement qui ne se déclenche jamais. | **Hide-until-wired** — agent en no-op, retirer badge/états/kickoff jusqu'à un vrai spawn |
| 2 | Section Lifecycle — `closeAction`, `pruneWorktreeOnMerge`, `confirmDelete` | MORT | écrits `WorkspaceSettings.tsx:331-350` ; lus par aucune logique | Aucun teardown à gater (`worktreeRemove` seulement au rollback `create.ts:143`). | **Cut** jusqu'au teardown |
| 3 | Contrôle Isolation (`worktree` / `worktree+env` / `container`) | MORT (+ container PRÉMATURÉ) | `WorkspaceSettings.tsx:300-326` ; type `repoConfig.ts:13` | `create.ts` fait toujours worktree+env ; rien ne lit `defaults.isolation`. | **Cut** le contrôle ; **Defer** container |
| 4 | Toggle "Auto port offsets" | MORT | `WorkspaceSettings.tsx:284-286` ; `repoConfig.ts:46,87` | `allocOffset` alloue toujours `create.ts:20-31,119` ; flag jamais lu. Sur le cœur même → max de confusion. | **Cut** (ou le câbler) |
| 5 | Pool multi-comptes IA — picker "Default AI account", `AiConnections`, OpenAI | MORT (+ PRÉMATURÉ) | picker `WorkspaceSettings.tsx:237-246` ; `aiDefaultId` jamais lu pour un appel `Connections.tsx:204` ; pool `Connections.tsx:176-287` | Tous les appels IA utilisent la clé terminal unique ; `aiDefaultId` ne sélectionne rien. | **Defer** — garder la clé terminal épinglée |
| 6 | Source GitLab à la création | COSMÉTIQUE | row `WorkspaceCommand.tsx:22` ; type `create.ts:49` | Aucun fetch issue/MR — slugifie juste la query en branche. Le label ment. | **Cut** (ou relabel) |
| 7 | Génération IA de scripts ("✨ generate" + review) | PRÉMATURÉ → **KEEP (override produit)** | `aiScripts.ts` ; `ScriptsSetupModal.tsx:54-96,270-292` | Hors du chemin direct vers l'isolation, mais **gardé** par décision produit. | **Keep** |
| 8 | Auto-rename tabs (Haiku) | PRÉMATURÉ → **KEEP (override produit)** | `tabNaming.ts` ; setting `store.ts:39,54` | Polish, mais **gardé** par décision produit. | **Keep** |
| 9 | Jira 2-way (transition à la création + lien/transition au merge) + pickers de statut | PRÉMATURÉ | `WorkspaceScopeForm.tsx:363-388` ; `notifications.ts:73-92` ; `WorkspaceSettings.tsx:219-233` | Marche, mais write-back lourd avant que l'isolation/teardown soient solides. | **Defer** le write-back ; garder Jira en source read-only |
| 10 | Chemins de création redondants — quick vs form ; rail "+" / carte / switcher "+" / ⌘K | REDONDANT | quick saute `scriptName` `WorkspaceCommand.tsx:160-203` vs form `WorkspaceScopeForm.tsx:174` ; entrées `WorkspaceRail.tsx:423,428`, `WorkspaceSwitcher.tsx:245` | Deux routes qui **divergent sur un axe porteur** (le quick ne lance pas de serveur). Viole le principe #3. | **Unify** — un chemin qui lance toujours le script |
| 11 | Largeur des presets — auto-select par type d'issue, `baseOverride`, `portOffset` par preset, éditeur d'env | PRÉMATURÉ | `PresetEditor.tsx` ; `presetForIssueType` `presets.ts:60-64` ; presets vides au départ `repoConfig.ts:83,106` | CRUD complet livré avec zéro preset ; la plupart des champs dupliquent le form. | **Defer** la plupart ; garder layout + script minimal |
| 12 | Input "Filter or create…" du rail | COSMÉTIQUE | placeholder `WorkspaceRail.tsx:374` ; handler `setWsFilter` only `:371` | Dit "or create" mais ne fait que filtrer. | **Hide-until-wired** — relabel "Filter…" |
| 13 | Actions store mortes `renameWorkspace`, `setWsBranch` | MORT | impls `store.ts:707,714` ; sans appelant | Mutations sans UI. | **Cut** |

(`showRailOnLaunch` paraissait mort mais est lu `App.tsx:121` — **Keep**.)

## Cœur minimal à garder

Le plus petit set qui livre *"ouvrir le workspace d'un repo → run un script → chaque serveur isole son port → teardown propre"* :

1. **Repos** — add-folder + lanes du rail.
2. **Un seul chemin de création** — ⌘K → `branch`/`describe` → `runCreate` : validate → `worktreeAdd` → install → **lance toujours le script d'ouverture**.
3. **Isolation port réelle** (la pièce manquante) — consommer `AURORA_PORT_OFFSET` / injecter un `PORT` par défaut, **et afficher le port sur la carte**.
4. **Switch** — les autres continuent.
5. **Teardown de 1re classe** — la seule chose à *construire* : supprimer = `worktreeRemove` (existe) + kill du groupe de process (`pty_kill` existe mais pas appelé à la fermeture).
6. **Scripts par repo** — `ScriptsSetupModal` manuel + `basePort` (le seul knob câblé).

**Gardés en plus (décision produit)** : auto-rename tabs, génération IA de scripts.
