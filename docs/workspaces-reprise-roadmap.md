# Workspaces — feuille de route de reprise de contrôle

> Décision du 2026-06-30, issue du diagramme produit (`docs/workspaces-ux.mmd`), des papercuts (`docs/workspaces-ux-papercuts.md`) et de l'audit de superfluité (`docs/workspaces-superfluity-audit.md`).
> **But** : moins de surface, un cœur qui tient sa promesse. Promesse = *ouvrir le workspace d'un repo → run un script → chaque serveur isole son port (1 ou 10), zéro knob → teardown propre.*

## Les 4 mouvements

### 1. CUT (retirer maintenant — surface morte ou trompeuse)
- **Couche agent IA** : badge, états "claude bosse…/a besoin de toi", picker "AI scope", kickoff non envoyé → no-op jusqu'à un vrai spawn.
- **Knobs morts** : section Lifecycle (closeAction, pruneWorktreeOnMerge, confirmDelete), contrôle Isolation, toggle Auto-port.
- **Source GitLab** (label sans fetch) et **"or create"** du filtre rail (relabel "Filter…").
- **Actions mortes** : `renameWorkspace`, `setWsBranch`.
- _Gain_ : ~la moitié de l'UI de config disparaît, et les promesses-mensonges aussi.

### 2. UNIFY (un seul chemin)
- **Une seule création** : quick et form fusionnés → on lance **toujours** le script d'ouverture (fin de la divergence #10 / principe #3).
- **Une cible visible & épinglée** : le repo (et le pane) ciblés sont affichés et ne se perdent pas à la frappe (fix `store.ts:746`, chip persistant dans la palette).

### 3. KEEP (garder)
- Repos + lanes · switch (les autres continuent) · scripts par repo (manuels) · `basePort`.
- **auto-rename tabs** (décision produit).
- **génération IA de scripts** (décision produit).

### 4. DEFER (plus tard, après que le cœur tient)
- Multi-comptes IA (garder la clé terminal unique).
- Jira 2-way / write-back (garder Jira en **source read-only** d'issues).
- Largeur des presets (garder layout + script minimal).
- Container isolation.

### 5. BUILD (le cœur manquant — à construire)
- **Isolation port réelle** : consommer `AURORA_PORT_OFFSET` / injecter un `PORT` utilisable par défaut, sans config — et **afficher le port choisi** sur la carte + barre de contexte.
- **Teardown de 1re classe** : supprimer un workspace = `worktreeRemove` (existe) + **kill du groupe de process** (`pty_kill` existe mais n'est pas appelé à la fermeture). Sans ça : worktrees + dev servers s'accumulent (la chauffe).

## Ordre suggéré

1. **CUT** d'abord — c'est cheap, ça réduit la surface et le bruit, et ça clarifie le terrain.
2. **UNIFY** — un chemin de création, cible visible (inclut le one-liner `store.ts:746`, plus petit coup à fort levier).
3. **BUILD teardown** — supprime le pire piège (accumulation + orphelins).
4. **BUILD isolation port** — la promesse-titre ; demande un design à part (auto-détection du port de dev vs injection `PORT`).

## Principes de garde (juge de paix)

1. Cible toujours visible & épinglée.
2. Tout défaut affiché & modifiable.
3. Un seul chemin de création.
4. État rendu visible (port, branche, serveurs).
5. Teardown réversible de 1re classe + zéro knob mort.

> Relancer l'agent `ux-qa` après chaque amend pour vérifier qu'on ne recrée pas de couacs.
