# PORT — le système d'orchestration Orca entre dans ax

Document de chantier, supprimé quand la dernière case est cochée. La cartographie complète
(inventaires, incidents, mesures live) vit dans `.scratch/2026-08-21-cartographie-orchestration.md`
sur la machine de travail ; ce fichier porte ce qu'une session fraîche doit savoir pour reprendre.

## Ce qu'on remplace

`~/.omp/agent/scripts/orca-coordinator.sh` (2 552 L, 8 sous-commandes) + `coordinator/record.py`
(940 L) + `orca-stall-watch.sh` (435 L) + `merge-gate.sh` (624 L) + deux skills de prose
(`orca-sessions` 558 L, `orca-orchestrator` 605 L). Ça marche, c'est payé par ~30 incidents datés,
et c'est illisible : mêmes règles écrites 2-5 fois, nommage par plomberie, ~800 lignes de gardes
ad hoc par hôte. Les extensions OMP (`orca-peer`, `orca-report`, `orca-checkpoint`, `orca-model`)
RESTENT dans `~/.omp` — elles sont in-process par nature — et s'amincissent en appelant ax.

## La surface cible

```
src/orca-bin.mjs           résolution binaire (ORCA_CLI_COMMAND → orca-dev → orca-ide → orca)
                           + runner JSON injectable (stderr jamais perdu — F-004), timeout borné
src/redact.mjs             rédaction des jetons (dcap_…) — partagé, jamais copié par verbe
src/worker/record.mjs      store write-ahead : claim O_EXCL, phases, verdicts, replay (ex-record.py)
src/worker/start.mjs       ax worker start (--resume/--replace/--show), arme le stall-watch
src/worker/gate.mjs        ax worker gate           (0 sûr / 1 vivant / 2 duplicate / 3 cannot)
src/worker/tail.mjs        ax worker tail           (vivant-contenu / vivant-silencieux / cannot)
src/worker/ls.mjs          ax worker ls             (panes vivants, jamais worker-list — F-048)
src/worker/release.mjs     ax worker release        (preuve d'atterrissage, jamais le mot de
                           l'enfant ; close write-ahead sous <store>/release/)
src/worker/pane.mjs        LE lecteur de `terminal read` + `terminal list` (F-041/F-028)
src/worker/transcript.mjs  ax worker transcript     (redacted par défaut, jamais de bypass capability)
src/worker/stall.mjs       watcher détaché fail-open (fichier séparé du fail-closed — ADR 0025)
src/worker/launch.mjs      ax worker launch --issue (gardes hôte → config par repo + probes injectées)
src/board.mjs              ax board                 (écrivain UNIQUE du board, statut monotone)
src/triage.mjs             ax triage                (cap par pane, F-030, sorties .scratch, le parent publie)
src/pr-gate.mjs            ax pr gate               (pur gh/git — seul verbe non gaté sur orca)
src/worktree/new.mjs       ax worktree new <nom> [--agent] [--prompt] [--brief] [--model] [--issue]
                           (claim → create → ax setup → agent EN DERNIER ; read-back parentWorktreeId)
```

Gating : un seul prédicat injectable (binaire orca résoluble) traversé par l'aide ET le dispatch.
Gatés : les noms `worker`, `board`, `triage`, et le VERBE `worktree new` (le nom `worktree` reste
visible partout). Aucun `agentLine` pour les verbes gatés. Le test `SUBCOMMANDS` = registre compare
les tables complètes, gating appliqué après.

## Ordre — chaque étape : tests d'abord, parité prouvée, legacy supprimé, commit

- [x] **0. Install** — fait le 2026-08-21 : Mac `~/.local/bin/ax → ~/Code/flosrn/ax/bin/ax.mjs` ;
      VPS clone `/home/orca/Code/flosrn/ax` + lien `/home/orca/.local/bin/ax` (node v22.22.1).
      Vérifié depuis `/tmp` sur les deux hôtes. Le pin `versions.yml` + convergence (git pull VPS)
      arrivent au plus tard à l'étape 2 (prérequis de la bascule des extensions).
- [x] **1. Socle** — fait le 2026-08-21 : `src/orca-bin.mjs` (résolution + gate 2 niveaux
      `orcaAvailable`/`runtimeReady` + runner injectable, exit codes = données, stderr jamais perdu),
      `src/redact.mjs`, `src/worker/record.mjs` (vocabulaire JSON compatible record.py — les records
      de l'ère bash se rejouent). 26 tests portés de `coordinator/record.test.ts` : claim atomique +
      symlink refusé, write-ahead, mismatch ≠ failed, replay ≠ run frais, USABLE = conjonction,
      stale-claim à double preuve, lectures par clé nommée (F-028), F-004 adapté.
- [x] **2. `ax board`** — fait le 2026-08-21 (verbe `5bc87a2`, parité fixture `344d3cd`, bascule
      ~/.omp `80df6ec`). Verbe : fail-open, sonde runtimeReady, verrou par worktree (verrou non
      acquis = skip annoncé, jamais d'écriture sans l'invariant), monotonie ici seulement,
      --if-empty fail-closed, cap 160. Première entrée gatée du registre (visibleCommands,
      prédicat injectable, aide + dispatch). Vérifié LIVE sur les deux hôtes. Écrivains basculés :
      `orca-checkpoint.ts` et `orca-peer/registry.ts:report()` spawnnent `ax board` via
      `shared/ax.ts` (50/50 tests bun). ⚠ `cmd_checkpoint` du coordinator reste VIVANT :
      `gapilabs/gapila` l'appelle depuis son hook de création de worktree
      (orca-checkpoint.test.ts:4) — il meurt avec la migration de ce hook vers
      `ax board --if-empty` (édit client-repo, à séquencer). Chemin basculé prouvé LIVE au niveau
      du spawn (résolution shared/ax.ts → /Users/flo/.local/bin/ax → board écrit et relu) ; la
      plomberie hook→writeCheckpoint est inchangée et épinglée par les 50 tests. Les sessions OMP
      déjà ouvertes gardent l'ancien chemin jusqu'à leur redémarrage.
- [x] **3. Lecteurs** — fait le 2026-08-21, par 4 subagents en parallèle sur le gabarit board +
      câblage parent (nom `worker` gaté, dispatcher, égalité SUBCOMMANDS=registre). `tail` (F-041 :
      jamais --lines ; queue rédigée), `gate` (4 verdicts ; F-001/F-003 ; « connue sans dispatch »
      = 0), `ls` (F-048 : compté par pane vivant ; INCONNU quand hostScope omet des hôtes — jamais
      MORT ; liste tronquée = 3), `transcript` (résolution chemin|dispatch|request → sessions ;
      ambiguïté = refus listant les candidats ; rédaction au niveau des émetteurs, pas de bypass).
      61 tests neufs, suite 291/291. Smoke live des 4 verbes contre l'Orca réel (95 records,
      pane vivant, gate de la sonde, transcript de la sonde résolu par dispatch id).
      `tail`/`gate` du coordinator supprimés avec `dispatch` à l'étape 4.
- [x] **4. `worker start` + `stall`** — fait le 2026-08-22. `start` porte les quatre modes
      (frais/`--resume`/`--replace`/`--show`) : claim O_EXCL, argv + identité écrits avant
      `task-create`/`worker-start`, replay byte-for-byte par le binaire ENREGISTRÉ, sortie 4
      STRANDED sur mutation inconnue, run enregistré passé au gate, verrou exclusif sur replace,
      takeover étranger seulement si TOUTES les phases prouvent un refus fermé sans ressource,
      options d'identité refusées dans le passthrough, task-update confirmé `ready` (F-003).
      `stall` est un processus détaché fail-open séparé (ADR 0025) : pid claim, seuil 45 min,
      émission du curseur (jamais `--lines`), receipt `failed` ≠ processus mort si le pane répond,
      card distante avec baseline + grammaire checkpoint exacte + découverte tardive, retry borné,
      durée de vie et nombres env finis, log best-effort. Records/diagnostics bruts restent sur
      disque ; toute émission rédige `dcap_…`. 71 tests nets, suite ax 362/362 ; smoke réel en
      sous-processus (callers de Runs différents et reclaimers d'un refus étranger → une seule
      paire d'identités ; watcher détaché armé → settle → pid nettoyé). Revue 8 lenses +
      adversarial Codex indépendant, puis 2 relectures finales : stale takeover, races replace/
      pidfile, record rewrite atomique et receipts malformés corrigés.
      Côté `~/.omp` : blocs `dispatch`/`gate`/`tail` + 5 fichiers legacy supprimés ; `launch` et
      `triage` appellent `ax worker start --orca <résolu>` (148 tests ciblés verts).
      ⚠ `record.py` reste jusqu'à l'étape 7 : `launch`, `release` et `triage` consomment encore
      ses verbes non-dispatch (`ticket`, `classify`, `active-count`, etc.). Le supprimer ici,
      comme l'esquisse le prévoyait, cassait ces trois surfaces vivantes ; il meurt avec leur
      dernier port, pas avant.
- [x] **5. `worker release`** — fait le 2026-08-22. Rapport par défaut, `--close` seul mute.
      Preuve d'atterrissage par artefact : PR MERGÉE (implémentation) ou commentaire postérieur
      au dispatch (triage/brief) ; PR ouverte, commits sans PR, diff vide, silence et la parole
      de l'enfant ne sont jamais des preuves. Liveness = deux échantillons de curseur (un seul
      sleep pour tout le lot) ; un pane qui bouge est BUSY même sous `--no-proof`. Chaque cause
      non offerte porte son nom et sa réparation — le fourre-tout « 80 with no pane to close »
      n'existe plus. Trois causes mesurées que bash lisait faux (Orca 1.4.185, 218 workers,
      5 panes vivants) : le handle est sur `agentTerminalHandle` (217/218) et non seulement dans
      `resource.terminalHandle` (132/218) — d'où les 86 « no terminal recorded » ; `terminalState`
      a six valeurs (`release_pending` et `release_unknown` sont deux rangées à poursuivre, pas
      « déjà relâché ») ; un pane distant refuse `worker-release` (`federation_unsupported`,
      2026-08-14) et se ferme par `terminal close --environment`. Le close est write-ahead comme
      un dispatch (F-001) : argv + identité `--retry-request` sur disque AVANT l'appel, sous
      `<store>/release/` pour que `ax worker ls` n'y voie pas un dispatch mort-né ; claim perdu =
      on rejoue le record de l'autre, jamais une seconde identité ; un `release_unknown`
      enregistré est rejoué (le verdict seul dirait « déjà relâché » — il faut son exit).
      Panes F-048 (vivants ici, absents de `worker-list`) réintégrés au balayage. Extraction
      payée par cette étape : `src/worker/pane.mjs`, LE lecteur de `terminal read` + de
      `terminal list` (tail, start, stall en avaient trois copies, release aurait été la
      quatrième ; `gate` et `stall` y sont passés aussi, `terminalInventory` sorti de `ls.mjs`).
      Revue 6 lentilles (correctness, adversarial, reliability, testing, security, reuse) :
      7 routes de close injustifié fermées, chacune avec son test qui échoue sans le correctif.
      La preuve est liée au dépôt qui possède le pane (un même slug fusionné dans un AUTRE repo
      fermait une session vivante sous `--all`/`--dispatch`) ; chemins canonisés
      (`/scope/../ailleurs` passait le préfixe) ; PR liée à SON head ref (la première ligne
      était crue) ; un `gh` en échec est une ignorance, jamais « pas de PR » ; `gh repo view`
      muet et store illisible = exit 3, plus un rapport propre ; provenance stricte (requête
      nommée == nom de fichier, phase `worker-start` seule, deux records pour un dispatch =
      ambigu) ; commentaire daté sur le `beganAt` de la phase, plus sur le `createdAt` du claim ;
      un record de release rejoué doit d'abord PROUVER qu'il décrit cette release (sinon son
      argv choisissait le programme ET le dispatch) ; le receipt doit nommer ce dispatch.
      Deux formes corrigées par le smoke live, pas par la revue : `latestCursor` est une CHAÎNE
      décimale (1.4.185) — la règle « entier » rendait tous les panes illisibles — et le refus
      du gate sur hôtes omis répondait 3 pour tout relaunch ordinaire ici (155 panes sur 218
      absents à cause d'un runtime périmé), donc il annonce au lieu de bloquer.
      54 tests neufs, suite ax 413/413, smoke réel : rapport scopé et machine-wide contre
      l'Orca vivant (218 workers → 1 `release_unknown` nommé avec sa réparation), forme de
      receipt mesurée sur une répétition idempotente (`already_released · none ·
      archive=captured`, exit 0), et les 4 verbes recâblés revérifiés vivants.
      ⚠ Pas de `--close` prouvé LIVE : aucune ligne fermable n'existait sur cette machine et en
      fabriquer une coûtait un vrai agent. Le chemin de mutation est tenu par le receipt mesuré
      + les tests (record sur disque AU MOMENT de l'appel, rejeu argv byte-for-byte).
      Côté `~/.omp` : `cmd_release` (296 L) + `orca-close-sessions.test.ts` supprimés, 5 verbes
      de `record.py` devenus orphelins retirés (`classify`, `request-of`, `epoch`, `merged-pr`,
      `release-receipt`) avec leurs tests, prose `orca-orchestrator` basculée sur `ax worker
      release`. ⚠ `orca-triage.test.ts` a UN rouge préexistant (contrat de labels du template de
      triage), vérifié présent à HEAD avant cette étape : il appartient à l'étape 7.
- [ ] **6. `worker launch`** — la restructuration : gardes gapicore/Portless/ofmchat → contrat de
      config par repo + probes. Cas de `orca-launch.test.ts`. Meurt : `launch` du coordinator.
- [ ] **7. `ax triage`** — cas de `orca-triage.test.ts`. Meurt : le coordinator ENTIER.
- [ ] **8. `ax worktree new` + `ax pr gate`** — parallélisables avec 6-7. Meurt : `merge-gate.sh`.
- [ ] **9. Rôles** — `~/.omp/agent/agents/{coordinateur,orchestrateur}.md`, minces, appellent ax.
      Meurent : `orca-sessions`, `orca-orchestrator`, `check-orchestration-surface.sh`.
- [ ] **10. Ce fichier est supprimé.**

## Les invariants qui ne se renégocient pas (chacun payé, date en source)

1. Ne muter que par replay exact d'une requête enregistrée AVANT émission ; record manquant ou
   ambigu = cannot-establish, jamais permission (F-001, 2×2 agents le 2026-08-09).
2. `orca worktree create`/`terminal create` n'ont PAS de `--retry-request` : un worktree se crée
   AVANT le dispatch, jamais dedans ; pour `worktree new`, le claim local est la seule protection
   et elle est bornée à UN hôte — dit dans l'aide.
3. Exit codes par verbe, jamais un alphabet partagé (ADR 0003).
4. stderr et diagnostics jamais perdus : le runner retourne {status, stdout, stderr}, un JSON
   invalide est une erreur nommée portant le texte brut (F-004, adapté — les pipes bash n'existent
   plus en node).
5. Liveness = mouvement du curseur en LIGNES ; `--lines` annihile le tail (F-041) ; un spinner
   sur place ne compte pas.
6. Preuve d'atterrissage avant fermeture : PR MERGÉE ou commentaire postérieur au dispatch —
   jamais PR ouverte, jamais diff vide, jamais ancestry après squash, jamais le mot de l'enfant.
7. Compter par pane vivant, jamais `worker-list` après un `--inject` (F-048).
8. Brief = fichier ; le fil porte un pointeur ; marker et instruction sur UNE ligne
   `[omp model=@alias] <instruction>` ; texte libre jamais sur argv.
9. Lectures par clé nommée ; refuser plutôt que zéro silencieux (F-028) ; un garde qui saute
   l'annonce.
10. Board : le statut avance seul, `in-review` au report, `completed` réservé à l'archive.
11. Rédaction par défaut de tout texte d'enfant ré-affiché (`dcap_…`) ; aucun bypass capability.
12. F-027 : chaque test porté prouve la MÊME proposition que l'incident d'origine — la suite
    existante est le cahier des charges, pas une inspiration.

## Flux de messages (mesuré le 2026-08-21, sonde probe-msgflow-20260821)

Préambule Orca injecté `role:user` (contrat CLI + spec verbatim, marker inclus) → l'enfant rapporte
par `orca orchestration send --dispatch-capability dcap_… --type worker_done` → le parent le reçoit
en peer-message via SON receiver (`orca-peer`) → le parent répond par `peer_reply`. Trois mécanismes,
un par direction. Le marker `@smol` a été appliqué (`model_change role=default`, opus→sonnet).
