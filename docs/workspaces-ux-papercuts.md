# Workspaces + Repos — inventaire des couacs UX

> Source : passe `ux-qa` (classe « contexte implicite ») du 2026-06-30.
> Référence versionnée. À relancer après chaque amend du flow (`docs/workspaces-ux.mmd`).
> Voir aussi `.claude/agents/ux-qa.md` (la grille) et `docs/workspaces-flow.mmd` (l'as-is).

## Verdict

**Hors de contrôle.** Le flow repose sur des valeurs qu'il n'affiche jamais et des cibles qu'il devine en silence : dans quel repo une création atterrit, quel port un serveur a obtenu, si le script d'ouverture a même tourné. La pire occurrence — **la cible explicite que tu choisis (le "+" d'un repo) est détruite à ta première frappe** (`store.ts:746` reconstruit `command` sans `repoId`), et aucun autre endroit de la palette ne re-affiche la cible. Tu vises, l'app oublie, et ne te dit jamais où ça a tiré.

## Promise scorecard

- **Isolation port zéro-config livrée ?** **Non.** Un offset est alloué (`create.ts:20-31`) et exporté en `$AURORA_PORT_OFFSET` (`Terminal.tsx:199`, `pty.rs:83-89`), mais (a) rien ne le lit sauf si l'utilisateur l'écrit à la main dans un script, (b) le **chemin rapide ne lance aucun script** — quick-create omet `scriptName` (`WorkspaceCommand.tsx:164-200`), donc ⌘K → texte → ↵ démarre **zéro** serveur, et (c) le port/offset choisi n'est **affiché nulle part** (`WorkspaceRail.tsx:483-549`).
- **Décisions sur le happy path (form) :** source → branch → base → preset → agent → on-open script → jira toggle → Create = **7+ choix**, l'inverse de « un seul geste ». Le chemin rapide est 1 geste mais saute en silence script/base/preset/agent.
- **Knobs morts :** **5** persistés et lus par aucune logique — `autoPortOffset`, `isolation`, `closeAction`, `confirmDelete`, `pruneWorktreeOnMerge`.
- **Teardown :** **Non.** `archiveWorkspace` existe (`store.ts:695`) mais sans appelant UI ; `worktreeRemove` seulement au rollback (`create.ts:143`) ; `pty.kill` seulement à l'unmount du Terminal et tue le shell, pas son groupe de process (`pty.rs:194-200`).

## Punch list (par sévérité)

1. **[IMPL · Critique] ⌘K crée dans le mauvais repo.** Le "+" d'un repo passe `repoId` (`WorkspaceRail.tsx:423`) mais `setCommandQuery` reconstruit `{ query, sel: 0 }` sans `...s.command` → `repoId` perdu à la 1re frappe (`store.ts:746`), fallback silencieux sur le repo actif ou `repos[0]` (`WorkspaceCommand.tsx:67-75`).
2. **[DESIGN · Critique] Promesse zéro-config non tenue sur le chemin rapide.** Quick-create sans `scriptName` (`WorkspaceCommand.tsx:175,195`) → le script de dev ne tourne jamais ; seul le form (7 décisions) le lance (`WorkspaceScopeForm.tsx:178`).
3. **[IMPL · Critique] Le port/offset alloué est invisible.** Central au produit, montré nulle part. `create.ts:121`, absent de `WorkspaceRail.tsx:483-549`.
4. **[DESIGN · Critique] Aucun teardown.** Cartes = switch/changes seulement (`WorkspaceRail.tsx:54-163`). `archiveWorkspace` non câblé, worktrees jamais retirés, groupes de process jamais tués (`pty.rs:194-200`).
5. **[IMPL · Haut] Cinq knobs morts dans les réglages repo.** `WorkspaceSettings.tsx:284,300,333,336,348`.
6. **[IMPL · Haut] « Démarrer l'agent » tape un texte jamais envoyé.** `autoStart` + agent construit un kickoff (`WorkspaceScopeForm.tsx:151-161`) que `runCreate` se contente de `setInput` (`create.ts:161`), jamais soumis à Claude.
7. **[IMPL · Haut] Le switch de branche met à jour le pane mais pas le workspace.** `setBranch(paneId,…)` (`BranchSwitcher.tsx:111`) ; `setWsBranch` sans appelant → carte/contexte périmés.
8. **[DESIGN · Moyen] ⌘1–9 = deux choses.** Rail visible → onglet (`keymap.ts:304`) ; switcher ouvert → workspace (`WorkspaceSwitcher.tsx:84`).
9. **[IMPL · Moyen] Le filtre du rail promet « create », ne fait rien sur Entrée.** `WorkspaceRail.tsx:369-386`.
10. **[DESIGN · Moyen] « a GitLab issue or MR » = un form branche vide.** `WorkspaceCommand.tsx:144-145`, aucun fetch GitLab.
11. **[IMPL · Moyen] ⌘W no-op silencieux sur le dernier onglet.** `store.ts:786-795`, `keymap.ts:294-302`.

## Inventaire papercuts (classe contexte implicite — exhaustif)

| # | Motif | Surface | Vécu utilisateur | file:line | Visible ? | Modifiable ? |
|---|-------|---------|------------------|-----------|-----------|--------------|
| 1 | Cible implicite | ⌘K repo de création | Cible "+" perdue à la 1re frappe ; création dans le repo actif/premier | `store.ts:746` → `WorkspaceCommand.tsx:67-75` | Non | Non (sauf ⇥ form) |
| 2 | Chemins divergents | Où la création est ciblée | Rail "+" passe `repoId` ; switcher "+" et ⌘K non → toujours repo actif | `WorkspaceRail.tsx:423` vs `WorkspaceSwitcher.tsx:247` / `keymap.ts:282` | Non | Non |
| 3 | État invisible | Port/offset alloué | Jamais montré après création | `create.ts:121` ; absent `WorkspaceRail.tsx:483-549` | Non | n/a |
| 4 | Défaut silencieux | Script d'ouverture (quick) | Quick-create omet `scriptName` → pas de serveur, pas d'avis | `WorkspaceCommand.tsx:175,195` | Non | Non |
| 5 | Défaut silencieux | Base branch (quick) | `defaults.baseBranch ‖ defaultBranch` choisi sans affichage | `WorkspaceCommand.tsx:191` | Non | Non (quick) |
| 6 | Défaut silencieux | Preset (quick) | `"feature" ‖ premier` choisi sans affichage | `WorkspaceCommand.tsx:154-157,183` | Non | Non (quick) |
| 7 | Défaut silencieux | Agent (quick) | `defaultAgent()` attaché sans affichage | `WorkspaceCommand.tsx:193` | Non | Non (quick) |
| 8 | Échec muet | Kickoff / autostart agent | Contexte issue tapé dans le prompt, jamais envoyé à Claude | `create.ts:161` ; `WorkspaceScopeForm.tsx:151-161` | Moitié | Manuel |
| 9 | État invisible | Agent attaché | `agent:"claude"` = badge ; rien ne le spawn/l'utilise | `WorkspaceScopeForm.tsx:315-344` | Non | n/a |
| 10 | État invisible | Branche du workspace après switch | `setBranch` met à jour le pane ; `setWsBranch` jamais appelé → carte périmée | `BranchSwitcher.tsx:111` | Non | n/a |
| 11 | Knob mort | Toggle auto port offsets | Sans effet (`allocOffset` lit le preset, pas ce flag) | `WorkspaceSettings.tsx:284` vs `create.ts:20-31,119` | Oui | Oui (inerte) |
| 12 | Knob mort | Mode isolation | Sélection persistée, consommée par rien | `WorkspaceSettings.tsx:300-326` | Oui | Oui (inerte) |
| 13 | Knob mort | Action à la fermeture | archive/delete persisté, aucun teardown ne le lit | `WorkspaceSettings.tsx:336-347` | Oui | Oui (inerte) |
| 14 | Knob mort | Confirmer avant suppression | Aucun chemin de suppression à confirmer | `WorkspaceSettings.tsx:348-350` | Oui | Oui (inerte) |
| 15 | Knob mort | Prune worktree au merge | Aucune logique merge/prune ne le lit | `WorkspaceSettings.tsx:333-335` | Oui | Oui (inerte) |
| 16 | Échec muet | Pas de teardown UI | Création OK ; rien ne le supprime/stoppe in-app | `WorkspaceRail.tsx:54-163` ; `store.ts:695` | Aucun contrôle | Non |
| 17 | Échec muet | Accumulation worktrees | `.aurora-worktrees` grossit indéfiniment | `worktreeRemove` seulement `create.ts:143` | Non | Non |
| 18 | Échec muet | Dev servers orphelins | Fermer un pane tue le shell, pas son groupe de process | `pty.rs:194-200` ; `Terminal.tsx:310` | Non | Non |
| 19 | Focus ambigu | ⌘1–9 | Onglet vs workspace selon un focus caché | `keymap.ts:304` vs `WorkspaceSwitcher.tsx:84` | Non | n/a |
| 20 | Échec muet | Filtre rail « create » | Entrée ne fait rien ; placeholder implique create | `WorkspaceRail.tsx:369-386` | Trompeur | Non |
| 21 | Chemin divergent | Source « GitLab issue or MR » | Ouvre un form branche, aucun fetch GitLab | `WorkspaceCommand.tsx:144-145` | Non | n/a |
| 22 | No-op silencieux | ⌘W dernier onglet | Rien ne se passe, aucun feedback | `keymap.ts:294-302` ; `store.ts:786-795` | Non | n/a |
| 23 | Cible implicite | pane de `scripts`/`run`/script d'ouverture | Tourne dans le pane actif du groupe actif — implicite | `ScriptsSheet.tsx:33-37` ; `create.ts:153-154` | Faible (dot focus) | Via focus |
| 24 | Cible implicite | ⌘V coller | Colle toujours sur `activePane`, peu importe le focus visuel | `keymap.ts:256`, `pasteClipboard` 18-36 | Non | Via focus |
| 25 | Focus ambigu | Après `switchWorkspace` | activeWs change mais aucun pane focus ; pas de move visible | `store.ts:685-693` ; `WorkspaceRail.tsx:69` | Faible | n/a |
| 26 | Focus ambigu | Après `mergeTabs` (drag-drop) | Actif saute au 1er pane mergé, split forcé "h" | `store.ts:824-840` | Non | n/a |
| 27 | Focus ambigu | TabStrip × close | `closeTab` ne `focusRoot` pas (contrairement à ⌘W) | `TabStrip.tsx:163-166` | Non | n/a |
| 28 | Défaut silencieux | Commande d'install | Déduite du lockfile, lancée sans annoncer laquelle | `create.ts:39-47,160` | Partiel (bloc) | Non |
| 29 | Défaut silencieux | Base port → PORT | `PORT=base+offset` injecté seulement si basePort>0, jamais montré | `create.ts:122` | Non | Réglages |
| 30 | Scope ambigu | Repo cible du setup `scripts` | Édite `pane.repoRoot ‖ cwd` du pane actif | `ScriptsSetupModal.tsx:47` | En-tête modal | Via focus |
| 31 | Échec muet | Kickoff `describe` (sans agent) | Texte seedé dans le prompt, jamais lancé si agent=none | `WorkspaceCommand.tsx:143` ; `create.ts:161` | Moitié | Manuel |

## À couper

1. **Les cinq knobs morts** lifecycle/isolation/port (`WorkspaceSettings.tsx:284,300,333,336,348`).
2. **La divergence quick-create vs form** — un seul chemin, défauts visibles (#4–7).
3. **La source « GitLab issue or MR » et le « or create » du filtre rail** (#20, #21).

## Plus petit coup à fort levier

**Rendre la cible persistante et visible.** `setCommandQuery` (`store.ts:746`) : étaler `...s.command` pour ne pas perdre `repoId`, puis afficher le repo cible comme chip persistant dans la palette. Une ligne + un chip → le pire moment (« créer dans le mauvais repo sans le savoir ») devient une cible épinglée, visible, correcte.
