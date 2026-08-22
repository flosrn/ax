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
src/worker/launch.mjs      ax worker launch --issue <ref> | --name <nom>
                           (gardes hôte → contrat de config par repo + sondes injectées ;
                           provisionnement délégué à ax worktree setup. Décidé le 2026-08-22 :
                           on GARDE launch, et créer un worktree sans issue est le MÊME verbe
                           sans ticket (`--name <nom>`), pas un second fichier — la chaîne
                           claim → create → ax setup → agent EN DERNIER n'existe qu'une fois.
                           Contrainte : l'identité de requête doit rester INJECTIVE. `requestIdFor`
                           normalise à perte, donc deux noms distincts peuvent viser
                           `.worktrees/<request>` et dispatcher dans l'arbre d'un autre : refuser
                           un nom non canonique, avec le test de collision.)
src/worker/{ticket,hosts,brief,child}.mjs  ses quatre pièces séparables
src/triage/{index,dispatch,publish,draft}.mjs
                           ax triage dispatch|status|publish (cap par record↔pane vivant F-048,
                           F-030, l'enfant écrit un brouillon .scratch et ne mute rien, le parent
                           publie ; `publish` ne ferme jamais, `custom` non publiable)
src/worker/sweep.mjs       ax worker sweep          (ex-`reap` : appartenance déclarée par --under,
                           verdict par ÂGE DE LA RACINE, re-preuve entre TERM et KILL)
src/pr-gate.mjs            ax pr gate               (pur gh/git — seul verbe non gaté sur orca)
```

Gating : un seul prédicat injectable (binaire orca résoluble) traversé par l'aide ET le dispatch.
Gatés : les noms `worker`, `board` et `triage`. Le nom `worktree` reste visible partout. Aucun
`agentLine` pour les verbes gatés. Le test `SUBCOMMANDS` = registre compare
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
- [x] **6. `worker launch`** — fait le 2026-08-22. `ax worker launch --issue <ref>` : ticket →
      session dispatchée et vérifiée, en un geste. Ce que le port a surtout fait, c'est SUPPRIMER :
      le bash portait son propre provisionneur (découverte du script de setup par glob, relance,
      cross-check d'URL via une fonction shell dont la signature différait par repo — donc
      exactement un repo était vérifié). Plus rien de tout ça : `ax worktree setup` provisionne et
      écrit le fichier de contexte, `doctor` re-dérive et compare, l'URL servie vient de la sonde
      proxy qui lit déjà la config du projet. L'habitabilité n'est plus une deuxième
      implémentation qui peut contredire la première. 950 L de bash → 5 modules injectables :
      `ticket.mjs` (grammaire des refs, adaptateurs Linear/GitHub, corps vide = rien créé sauf
      `--task`, `--needs-ref` prouvé sur origin, la commande de lecture enseignée sans `--full`
      qui tronque), `hosts.mjs` (les sols distants : disque, balayage AVANT mesure, jeu
      irrécupérable du cgroup — jamais `memory.current`, qui compte le page cache —, sonde tracker
      par hôte, repo-id par segment de chemin), `brief.mjs` (marker et instruction sur UNE ligne,
      contrat mécanique que ax possède, addendum distant, brief opérateur verbatim), `child.mjs`
      (mandat d'advisor scopé au worktree + git-exclude par `--path-format=absolute`, identité git
      épinglée `--worktree` avec le tag `(babysit PR#N)` retiré), `launch.mjs` (le pipeline :
      placement, sélecteur prouvé VISIBLE par Orca avant tout dispatch, lignage posé puis RELU,
      STRANDED rejoué ici, vérification marker+curseur). Aucune constante projet dans `src/` : le
      contrat `launch` d'`ax.schema.json` ne porte AUCUN défaut — un sol mesuré pour une flotte,
      hérité par un repo qui ne l'a pas déclaré, c'est le même bug ailleurs ; ce qu'un projet ne
      déclare pas n'est pas mesuré et le rapport le dit. 82 tests neufs (5 suites), suite ax
      495/495, smoke live : ticket Linear réel lu, Run résolu depuis le registre de pairs, brief
      composé, argv de dispatch prédite depuis le MÊME tableau que le run réel (le bash retapait
      cette ligne à la main).
      Côté `~/.omp` : `cmd_launch` (943 L) + `orca-launch.test.ts` (1 208 L) supprimés ; le
      coordinator n'a plus que `checkpoint|triage|reap` ; `/launch` et `orca-sessions` appellent
      `ax worker launch`. ⚠ `record.py` garde ses 28 verbes alors que 24 sont morts : il disparaît
      ENTIER à l'étape 7, et le découper deux fois est du bruit. Le rouge unique de
      `orca-triage.test.ts` est toujours celui d'avant l'étape 5.
      Revue 3 lentilles (correctness, adversarial, testing) après le premier commit, 10 correctifs,
      chacun avec son test : **P0** un tableau argv ne protège de rien sur ssh — un target en `-`
      est une option LOCALE (ProxyCommand s'exécute ici) et tout ce qui suit le target est recollé
      par ssh en commande shell distante ; UNE frontière (grammaire de target fermée, `--`, chaque
      valeur quotée), parce que ces valeurs viennent d'un `ax.config.json` qu'une PR peut changer.
      Puis : `defaultExec` dupliqué (déjà perdu une fois dans un refactor) importé de `release.mjs` ;
      contrat, Run et brief opérateur résolus AVANT tout placement (exit 1 promet que rien n'a été
      créé) ; un arbre qui existe mais n'est pas provisionné répond 3 et se nomme ; un arbre
      réutilisé est prouvé habitable, pas supposé ; le parent relu doit être celui qu'on a posé ;
      le marker refuse un transcript voisin (match ancré, ambiguïté = null) ; `--needs-ref` en
      pattern refusé (`ls-remote` matche des motifs et répondrait 0 pour n'importe quel ref) ;
      balayage distant muet en dry-run ; sol dont le transport a échoué compté NON PROUVÉ.
      Suite ax 503/503.
- [x] **7. `ax triage` + `ax worker sweep`** — fait le 2026-08-22 (`110a662`, `dcf84fb`, `41dee7c`).
      `ax triage dispatch|status|publish`. Décision prise avant d'écrire : l'enfant ne mute plus
      rien — il écrit UN brouillon dans `.scratch/triage/<request>.md`, le parent relit, corrige,
      et publie à la fin d'une chaîne de PRD. Ce qui rend `publish` la seule surface qui touche le
      tracker : applique exactement ce que le brouillon nomme, tous les brouillons lus et rendus
      avant le premier `gh`, ne ferme JAMAIS une issue, `custom` non publiable par son nom.
      42 propositions du bash portées, 5 non verbatim et chacune dit pourquoi à son site : le
      contrat de labels quitte le spec de l'enfant pour `ax.config.json:triage.labels` (absent,
      illisible ou vide = refus — `gh label list` donne des noms sans groupes ni complétude) ;
      `brief` accepte un brouillon non publié ; le cap compte les records dont le pane est vivant
      (F-048) et non tous les panes d'Orca ; le dry-run lit la même source ; `custom` non publiable
      n'existait pas en bash. `release.mjs` NE bouge PAS : un brouillon non relu est la parole de
      l'enfant, et `--no-proof --dispatch <id>` est déjà le geste attesté pour un pane relu.
      Deux fail-open trouvés en écrivant les tests : cap non numérique (`> NaN` toujours faux) et
      record illisible lu comme zéro enfant — les deux refusent. `peerRun` extrait de `launch.mjs`
      dans `src/worker/peers.mjs` plutôt que dupliqué. 585 tests, smoke live sur les deux verbes.
      **`sweep` fait le 2026-08-22** (`dcf84fb`) : `ax worker sweep`, ex-`reap`, 18 tests.
      Le mot vient de `ax.schema.json` (`launch.hosts.<h>.sweep`), dont la clé pointait sur le
      bash — un mot pour un geste des deux côtés de la frontière ssh. Pas `clean` :
      `ax worktree clean` récupère des processus scopés par cwd, celui-ci est à l'échelle de
      l'hôte. Appartenance DÉCLARÉE (`--under`, absolu, sans segment non résolu, dans le home de
      l'appelant) et non supposée : aucune liste en dur, sur le précédent que `src/proc.mjs` écrit
      déjà à côté de son reaper. Cinq fail-open que le bash ne pouvait pas dire : `--max-age lots`
      (`$(( lots * 60 ))` = 0, plancher effondré, toute racine vivante éligible — validé
      lexicalement, `Number(' ')` vaut 0), le plancher d'environnement, un chemin qui revendique un
      home, le match par COMPOSANT, et le SIGKILL qui rejouait la liste d'origine (un pid libéré
      pendant les 4 s peut être donné au navigateur frais de l'étape suivante SOUS LE MÊME CHEMIN :
      l'instantané d'après est reclassé par le prédicat entier). Et un mensonge mesuré hérité du
      bash : son commentaire disait `etimes` vérifié sur macOS 26 — faux, `/bin/ps` y répond
      `keyword not found`, sort 1, et imprime quand même 162 KB ; la vérification passait par un
      `ps` du harness sur le PATH. Colonne portable : `etime`, parseur exporté et testé.
      **Prose basculée** : `orca-orchestrator` (cap + mode triage) et `orca-sessions` (inventaire)
      nomment `ax triage`/`ax board`, plus le bash.
      **Le coordinator est mort le 2026-08-22** (`41dee7c`), −3 339 lignes :
      `orca-coordinator.sh` (709), `record.py` (788) + `record.test.ts` (588) dont le seul
      appelant était ce script, `orca-triage.test.ts` (710), `orca-checkpoint.test.ts` (360),
      `orca-reap.test.ts` (134) et `orca-test-harness.ts` (50), qui ne portait que ces trois-là.
      La classe `scripts/coordinator/*.py` quitte `check-test-proof` (un motif pour un répertoire
      disparu est une affirmation fausse) et `orca-coordinator.sh` quitte la liste sanctionnée —
      1 exécutable restant, `merge-gate.sh`, jusqu'à l'étape 8.
      **L'ordre a été tenu, et il ne l'avait pas été le 2026-08-11.** `gapilabs/gapila` appelait
      `checkpoint` en production depuis son hook de création de worktree, et son
      `install-agent-tools.sh` nommait le script dans `EXPECTED` — dont le commentaire énonce la
      règle : « le retrait d'une entrée part AVANT que le fichier disparaisse en amont ».
      PR gapila #1999 (`eaad7f548`) atterrie d'abord : `ax board`, mêmes 5 flags, même contrat
      fail-open. La résolution y est **chemin épinglé d'abord, PATH en repli** — l'inverse de
      l'ordre évident, parce que `@flosrn/ax` est aussi une devDependency des projets d'ici, donc
      un hook qui hérite d'un environnement pnpm peut porter un `node_modules/.bin/ax` plus ancien.
      C'est aussi ce que `extensions/shared/ax.ts` fait déjà. Le test l'assure comme un ORDRE, pas
      comme deux `match` indépendants.
      **Un rouge trouvé en passant, antérieur** : le garde « jamais le nom nu » de
      `orca-model.test.ts` ne connaissait pas `axBin()`, ajouté à `registry.ts` à l'étape 2 le
      2026-08-21 — il échouait depuis, personne n'ayant lancé ce fichier dans cette portée.
      Accepté parce qu'il résout comme le coordinator le faisait, pas parce qu'il gênait.
      `ORCA_BROWSER_REAP_AGE_MIN` est mort avec le script (remplacé par `AX_SWEEP_MAX_AGE_MIN`) ;
      rien ne le posait dans un profil, vérifié. 434 tests OMP verts, 605 côté ax.
- [ ] **8. `ax worker launch --name` + `ax pr gate`** — **les deux verbes faits le 2026-08-22**
      (`7052902`, `a04fa7d`) ; la case reste ouverte parce que `merge-gate.sh` vit encore, et une
      étape n'est cochée ici que quand son legacy est supprimé.
      Pas de `worktree new` : créer un worktree sans ticket est le MÊME verbe sans ticket, donc la
      chaîne claim → create → ax setup → agent EN DERNIER n'existe qu'une fois, et l'anti-doublon
      avec elle. Exactement une identité : `--issue` ou `--name`, jamais les deux.
      Le nom EST l'id de requête, donc refusé plutôt que normalisé, par un motif ancré et non par un
      aller-retour dans `requestIdFor` — qui n'est ni injectif (`My Feature`, `my/feature`,
      `my@@feature` donnent tous `my-feature`, donc deux noms clé-raient un arbre) ni sûr sur les
      segments (`.` et `..` passent intacts, et `.worktrees/<request>` résout alors sur la base ou
      sur le répertoire au-dessus). La réutilisation d'arbre devient EXACTE pour un nom : la règle de
      préfixe est faite pour les tickets, et donnerait à `--name auth` l'arbre de `auth-refactor`.
      Sans ticket il faut `--task` ou `--brief` : `launch.entry` seul composerait `/entry <nom>` et
      rien d'autre. Et trois endroits mentaient — le brief disait « lis le ticket, il est canonique »
      et les mécaniques « tiens le ticket à jour, le coordinateur le lit » : `ticket: null` rend une
      forme différente, la puce est remplacée et non supprimée (l'enfant ne doit pas ouvrir un ticket
      pour combler le vide), `MECHANICS` reste identique octet pour octet, et la sonde tracker
      distante annonce son absence au lieu de sauter en silence. 617 tests.
      **`ax pr gate`** : les 7 sols du bash, dans l'ordre, et rien ne court-circuite (F-033 : deux
      sols ont tiré sur le même merge, et un gate qui s'arrête au premier apprend à réparer une
      chose et à revenir). Les fils de revue ne sont lus qu'APRÈS que la CI soit décidée — un fil
      vide lu avant ne vaut rien (F-031, #1847) ; l'obsolescence se lit par ancêtre et jamais par
      `mergeStateStatus` (F-033.2) ; atterri-par-contenu est consultatif et ne refuse jamais
      (F-033.1 : un squash fait répondre « pas mergé » à toute branche) ; les commits depuis
      l'ouverture sont un DÉTECTEUR qui refuse jusqu'à `--ack-body` (KTD9) ; le corps des fils
      n'est jamais reproduit dans le canal de décision (R11/KTD7).
      La déclaration quitte le fichier machine-wide clé par `owner/repo` pour
      `ax.config.json:prGate`, parce que le verbe tourne DANS le checkout dont il parle — donc
      `--repo` qui nomme un autre projet est un refus, ce qui tue ce fichier. `residualFindings`
      est déclaré pour la même raison (`docs/residual-review-findings` était la disposition d'un
      projet dans un outil). Codes : 0 passe, 1 refus, 2 usage, 3 impossible d'établir — le « 2
      réservé » du bash était mort. 683 tests (66 neufs), 6 mutations falsifiées, plus le garde du
      SHA 40-hex qui ne tuait aucun test : couvert maintenant sur la longueur, la casse et le trim.
      **Le smoke live a refusé la PR gapila #1999 que je venais de merger**, sur un fil de revue
      non résolu — un P2 correct de `chatgpt-codex-connector` : le repli `command -v ax` retombait
      sur `node_modules/.bin/ax`, la copie épinglée que le commentaire au-dessus dit d'éviter.
      Correctif prêt sur `fix/orca-ax-fallback-rejects-repo-pinned` (`18b225714`), non poussé.
      **RESTE, et c'est la même règle qu'à l'étape 7** : `merge-gate.sh` (624 L) +
      `merge-gate.test.ts` (749) + `merge-gate.json` ne meurent qu'APRÈS que gapila et ofmchat
      déclarent leur `prGate` dans leur propre `ax.config.json` — aucun des deux n'en a un
      aujourd'hui, et supprimer avant laisserait les deux repos sans gate du tout. Puis retirer
      `merge-gate.sh` de `check-orchestration-surface.sh` (dernier exécutable sanctionné) et
      basculer la prose qui le nomme.
- [ ] **9. Deux rôles** — décidé le 2026-08-22 : ils se séparent par le GENRE de travail, pas par
      le nombre d'enfants. Un rôle mène les sessions de triage (l'enfant écrit un brouillon, le
      parent publie), l'autre les sessions d'implémentation (l'enfant ouvre une PR, le parent
      merge). Fichiers anglais (`agent/agents/*.md`), prose française interdite dans ce qui est
      commité. `coordinator.md` EXISTE déjà (71 L, `autoloadSkills: orca-sessions`) : l'étape le
      réécrit, elle ne le crée pas. À lire d'abord, parce que rien de tout ça n'est dans ax :
      `skill://omp-internals` (ce qui est surchargeable et où), `skill://model-routing` (quel
      modèle sur quel rôle), `rule://orca-peer-messaging`, et le fait que `~/.omp` est un checkout
      git dont `agent/config.yml` (`task.disabledAgents`) et les en-têtes `agent/agents/*.md`
      (modèle, effort, outils, `autoloadSkills`, `disable-model-invocation`) décident du
      comportement. Un persona se dispatche avec `agent: <stem>`, sinon tout tourne sur le modèle
      `task` en silence. Les prompts restent des skills (`lfg`, `lfg-full`) : elles sont déjà
      découplées du bash, une seule ligne les relie (`lfg/SKILL.md:60`).
      Meurent : `orca-sessions` (562), `orca-orchestrator` (617),
      `check-orchestration-surface.sh` — et l'entrée `skills/orca-sessions/SKILL.md` de
      l'`EXPECTED` de gapila doit partir AVANT, même règle qu'au-dessus.
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
