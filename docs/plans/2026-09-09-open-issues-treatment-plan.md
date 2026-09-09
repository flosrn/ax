# Traiter les 17 issues ouvertes sans confondre correctif et clôture

Created: 2026-09-09

## Décision

- Prévoir **4 clôtures** : #173 résolue ; #215, #217 et #229 sans correction AX supplémentaire sur le périmètre rapporté.
- Garder **7 réparations** : #185, #212, #220, #221, #223, #227, #231.
- Garder **2 validations en usage réel** : #232, #233, déjà corrigées dans le paquet mais pas encore observées selon leur critère de clôture.
- Garder **4 dossiers distincts** : #174 et #206 pour la preuve d'accès/Completion ; #219 pour une investigation non résolue ; #218 pour une décision produit.

Ce plan autorise une lecture du traitement proposé, pas son exécution. Aucune clôture, modification de code, mise à jour de consommateur, opération SSH ou mutation de worker n'a été faite pour cet audit.

## Base de preuve et limites

- Code AX examiné : `1730d20`, CLI locale exécutée : `0.24.5`.
- Les 17 bodies et leurs commentaires ont été examinés ; les verdicts antérieurs ne sont pas tenus pour vrais sans confrontation au code actuel.
- Cinq analyses indépendantes ont couvert sûreté, lifecycle, messagerie, publication et Specs. Leur restitution structurée a échoué dans le harness ; les résultats ont été récupérés par messages des mêmes analystes, sans recommencer les analyses.
- La lecture actuelle de `node bin/ax.mjs frontier --spec 174` établit **13 satisfaits, 3 inachevés, 0 lecture impossible** : #206, Runtime verification et Required work resolved restent bloqués.
- Les membres #175–180, #188–195 et les findings #204/#205/#207 sont actuellement CLOSED. Leur fermeture seule ne prouve pas toutes les observations d'une Spec.
- Manifestes et paquets installés lus : gapila `0.24.3`, ofmchat `0.24.3`, chatnow_bot `0.24.2`. Cela ne prouve pas la version du bundle déjà chargé dans une session.
- Aucun test n'a été exécuté pendant cette analyse. Les cas de tests cités sont de la couverture inspectée, pas des résultats nouvellement observés. Les incidents mesurés dans les issues n'ont pas été rejoués pour confirmer les reporters.
- Le refus SSH historique de #206 n'a pas été retesté. La déclaration `orca@vps` existe toujours ; l'état actuel de son accès reste à établir lors du traitement autorisé.

## Examen une par une

Les numéros renvoient aux [issues de flosrn/ax](https://github.com/flosrn/ax/issues).

| Issue | Verdict actuel | Preuve et reste à traiter |
|---|---|---|
| [#173](https://github.com/flosrn/ax/issues/173) — joints d'autorisation | **Clôture proposée : résolue** | Six corrections #175–180 livrées via #181/#186/#187/#184/#182/#183 : pagination threads/check-runs, Git sur SHA validé, Release par job/Pass, provenance, lecture bornée du Report. Couverture actuelle dans `src/pr-grounds.mjs`, `src/worker/release.mjs`, `src/triage/publication.mjs`, `src/triage/provenance.mjs`, `omp/peer/completion.ts`. Le commentaire de fin de Wave donne aussi la vérification intégrée. #185 est explicitement hors de ses six assignments ; #174 est une Spec sœur, pas une raison de garder #173 ouverte. |
| [#174](https://github.com/flosrn/ax/issues/174) — Completion | **Garder : preuve de mandat incomplète** | Implémentation et findings de code livrés. Le reçu actuel de Completion reste bloqué par #206 et deux observations. Ne pas confondre publication npm, tests locaux, fermeture de Wave et satisfaction du mandat. |
| [#185](https://github.com/flosrn/ax/issues/185) — fermeture opérateur sans archive Release | **Réparation nécessaire** | `src/worker/release.mjs:1327–1355` laisse encore le cas « pane partie » avec une investigation de processus, sans fin utile pour l'exit exact `operator_close`. Orca peut retenir `identity_unproven`, archive null. Choisir une disposition retained explicite qui nomme les preuves encore lisibles ; une archive n'est annoncée que si le runtime l'établit. |
| [#206](https://github.com/flosrn/ax/issues/206) — accès au Report distant | **Garder : accès à établir** | `ax.config.json:20–24` déclare toujours `orca@vps`. `omp/peer/remote.ts:295–308` restitue l'échec de transport ; il ne remplace pas l'identité. L'échec historique ne prouve pas que l'accès échoue encore aujourd'hui, mais aucune preuve actuelle de réussite ne permet la clôture. Bloque #174. |
| [#212](https://github.com/flosrn/ax/issues/212) — absence prise pour vide | **Réparation nécessaire, sûreté** | `src/worker/record.mjs:1132–1196` conserve une preuve de non-mutation plus faible dans `staleClaim` que dans `heldNoMutation`. Le consommateur dangereux est le chemin de claim perdu dans `src/worker/start.mjs:921–947` : déplacement du record puis création d'une nouvelle identité. Ce n'est pas le chemin `--replace` lui-même. Une absence ne doit pas autoriser ce nouveau départ. |
| [#215](https://github.com/flosrn/ax/issues/215) — transcript limité à la prose | **Clôture proposée : comportement prévu** | `omp/peer/transcript.ts:86–105` lit les messages assistant contenant du texte, pas toutes les activités. Les 210 records existaient. `worker transcript` et `worker tail` donnaient les autres observations ; le blocage réel était la demande interactive de credential. Ne pas fermer comme « modal corrigée » : cette politique appartient à OMP. |
| [#217](https://github.com/flosrn/ax/issues/217) — surfaces absentes après merge | **Clôture proposée : comportement prévu** | `src/worker/landed.mjs:36–42,365–376` dit NOT READ si le SHA n'est pas local, et nomme `git fetch origin`. Les tests de landed/dispatch conservent ce contrat et la poursuite du dispatch. Le reporter a appliqué le fetch. Un fetch automatique serait une amélioration distincte, pas une correction déjà promise. |
| [#218](https://github.com/flosrn/ax/issues/218) — fusion partielle sans clôture | **Garder : fonctionnalité à décider** | Les grounds `keywordGround` et `ticketGround` de `src/pr-grounds.mjs` refusent un ticket lié sans clôture, en détecteur comme en merge. Le refus est volontaire ; le besoin de fusion partielle tracée reste réel. Le commentaire conseillant « retirer Closes puis obtenir PASS » doit être corrigé. Ne pas prétendre que ce chemin existe. |
| [#219](https://github.com/flosrn/ax/issues/219) — communication entre siblings | **Garder : investigation non résolue** | La réouverture explicite du 6 septembre invalide l'ancien verdict refused. Les probes ultérieurs ont réussi dans les deux directions ; ils ne réfutent pas l'incident antérieur. Pas de sortie brute initiale permettant d'en établir la cause. Ne pas assimiler arbitrairement ce dossier à #220 ou #231. |
| [#220](https://github.com/flosrn/ax/issues/220) — parent absent ou inventaire illisible | **Réparation nécessaire, partiellement couverte** | #234 (`4a3735a`, 0.24.3) permet de livrer au Run enregistré même sans pane. Mais `omp/peer/orca.ts` et `address.ts` rabattent encore l'inventaire illisible sur une liste vide. `lineage.ts:174–204` peut donc annoncer aucune session sans record, ou une queue sans avoir établi l'absence de lecteur. La livraison améliorée ne résout pas la vérité du diagnostic. |
| [#221](https://github.com/flosrn/ax/issues/221) — session restaurée sous nouveau handle | **Réparation nécessaire, sûreté** | `src/worker/gate.mjs`, `pane.mjs` et `slots.mjs` comptent par handles connus. Une incarnation restaurée échappe à cette identité. La readoption Orca de #160 exige handle/incarnation exacts et ne couvre pas un dispatch succeeded sous nouveau handle. Une preuve de pane morte n'établit pas l'exclusivité du worktree. |
| [#223](https://github.com/flosrn/ax/issues/223) — globals Supabase avant le verbe | **Réparation nécessaire, sûreté** | `src/worktree/supabase.mjs:446–493` classe encore `args[0]/args[1]`. `--debug db reset` peut éviter la promotion. `src/supabase-guard.mjs` ne normalise que workdir ; #222 n'a pas réparé ce parseur général. |
| [#227](https://github.com/flosrn/ax/issues/227) — CI release-please | **Réparation nécessaire** | Le Test [34303568653](https://github.com/flosrn/ax/actions/runs/34303568653), sur `f893666` (release 0.24.5), est `failure`, avec zéro job et zéro check-run. D'autres runs sont `action_required` : ne pas confondre les deux ni inventer une cause commune. `scripts/deploy.mjs:425` merge directement ; sa sélection du workflow Release après merge ne déclenche pas Test avant. |
| [#229](https://github.com/flosrn/ax/issues/229) — rôle et CLI de versions différentes | **Clôture proposée : réparation d'installation connue** | `--spec` et le rôle qui le nomme ont été livrés ensemble par `20bd93d`, en 0.24.0. Le cas rapporté utilisait CLI 0.21.1 et un rôle plus récent dans un dépôt non pinné. Le reporter a ensuite pinné. Ne pas revendiquer une impossibilité universelle de décalage : une session déjà chargée ne change pas de bundle quand le paquet est mis à jour. |
| [#231](https://github.com/flosrn/ax/issues/231) — reply entre Runs | **Réparation AX nécessaire, frontière établie** | Orca `src/main/runtime/rpc/methods/orchestration-routing.ts:51–80` refuse la cible dont le Run diffère du dispatch actif du caller. Aucun argument manquant n'autorise ce franchissement. `omp/peer/index.ts:562–622` envoie directement, sans le relais que `send.ts` offre déjà à peer_send. #234 ne couvre pas ce chemin. |
| [#232](https://github.com/flosrn/ax/issues/232) — artefacts requis dans scratch | **Corrigée, observation encore requise** | La règle générique du Brief est livrée par `492ad5e`, dans 0.24.4. Le commentaire exige une Wave équipée de ce Brief ne laissant pas d'artefacts requis non classés. Aucun des trois consommateurs lus ne porte encore 0.24.4. Le refus de classification par filename reste correct. |
| [#233](https://github.com/flosrn/ax/issues/233) — panes auxiliaires du dispatch | **Corrigée, observation encore requise** | La branche descriptive est livrée par `32bc449`, dans 0.24.4 : title, agent, last output dans le KEEP. L'autre branche reste non justifiable sans attribution runtime ; un shell humain peut avoir les mêmes signaux. Le commentaire de clôture attend l'observation en Wave du KEEP devenu directement exploitable. |

## Traitement groupé

### Lot A — Assainir le registre, sans code

**Issues : #173, #215, #217, #229.** Prévoir quatre commentaires de clôture, puis quatre fermetures explicites :

- #173, raison completed : six obligations livrées et vérifiées ; #185 reste séparée.
- #215, raison not_planned : aucune perte de transcript ; garder les deux commandes appropriées et la limite OMP du modal.
- #217, raison not_planned : NOT READ et fetch explicite sont le contrat retenu ; aucune autorisation de changer landed.
- #229, raison completed pour la remédiation d'installation rapportée : versions mélangées, flag/role livrés ensemble, pin appliqué. Ce n'est pas une correction du CLI sur une même release.

Corriger aussi le conseil faux de #218, sans fermer ce dossier. Au prochain passage documentaire lié à #174, retirer l'affirmation périmée de `docs/adr/0003-orchestrate-spec-completion-not-a-fixed-ticket-list.md:106–111` disant #192/#195 encore en vol. Ne pas transformer ces corrections de registre en une nouvelle Wave de triage.

### Lot B — Empêcher une mutation sur preuve insuffisante

**Priorité haute : #212, #221, #223. Même axe de sûreté, pas une PR géante.**

1. **#212 — preuve positive avant nouvelle identité.** Aligner le droit au fresh start sur les preuves établies de non-mutation. Les conteneurs absents/null/malformés restent inconnus ; les listes explicitement vides et refus pré-écriture prouvés gardent leur traitement. Préserver le record et la récupération exacte. Fichiers : `src/worker/record.mjs`, `src/worker/start.mjs`, `tests/worker-record.test.mjs`, `tests/worker-start.test.mjs`. Preuve à obtenir : le cas silencieux déjà mesuré ne déplace plus le record et ne crée plus de nouvelle identité ; le refus pré-écriture positif conserve sa reprise légitime.
2. **#221 — exclusivité face à la restauration.** AX doit refuser une nouvelle identité quand des panes actives incompatibles rendent l'exclusivité inconnue ; ce refus n'attribue pas la pane à un dispatch par son nom. Couvrir gate, replace et capacity. Avant d'affirmer une réparation complète, établir avec Orca ce qui empêche une restauration après le contrôle et avant/après le nouveau départ. Un précontrôle AX seul ne ferme pas cette course. Fichiers AX : `src/worker/pane.mjs`, `gate.mjs`, `slots.mjs`, `start.mjs` ; suites `tests/worker-pane.test.mjs`, `worker-gate.test.mjs`, `worker-start.test.mjs`, `worker-slots.test.mjs`. Scénarios : restauration seule ; restauration plus remplaçant ; inventaire inconnu ; pane étrangère non attribuable ; restauration pendant la transition. Toute mutation nécessaire dans le fork attend son mandat propre ; ne jamais réécrire opportunément les vieux handles.
3. **#223 — classification sémantique des arguments.** Reconnaître les globals et leur arité avant de décider local/remote/lecture ; garder les arguments transmis au CLI et le confinement workdir de #222. Une entrée non classifiable est refusée, pas classée automatiquement mutante puis exécutée après promotion. Fichiers : `src/worktree/supabase.mjs`, `src/supabase-guard.mjs`, `src/worktree/doctor.mjs` ; suites `tests/supabase.test.mjs`, `tests/supabase-guard.test.mjs`. Scénarios : `--debug db reset`, option à valeur, global intercalé, terminateur `--`, option inconnue, help sans effet, exceptions remote correctement parsées et `db pull` restant local.

#223 est indépendante des deux autres. #212 et #221 touchent `start.mjs` : un seul propriétaire de cette mutation partagée, intégration séquencée. Chaque correction commence par le contre-exemple rouge au niveau du verbe, selon les règles du dépôt.

### Lot C — Réparer les deux chemins de messagerie, sans ouvrir l'autorité

**Issues : #220 et #231 ; #219 conserve son propre verdict.**

- **#220** : porter la distinction inventaire complet/vide/illisible jusqu'à la recherche du parent et au reporting. Un Run enregistré reste une adresse utilisable même quand la présence d'un lecteur n'est pas établie ; ne pas appeler cela une réception ni une absence certaine. Sans adresse attribuée, nommer l'incapacité exacte. Fichiers : `omp/peer/orca.ts`, `address.ts`, `lineage.ts`, `report.ts`, `omp/report/index.ts` ; suites `omp/peer/lineage.test.ts`, `omp/peer/addressing.test.ts`, `omp/report/index.test.ts`. Scénarios : inventaire illisible avec et sans record ; vrai vide ; pane du mauvais Run ; lecteur exact ; récupération du même inventaire. Préserver la queue de #234.
- **#231** : faire partager au reply le transport de send, avec destination exclusivement dérivée de la route reçue. En cas de `dispatch_run_mismatch`, relayer par le parent vérifié ; garder le thread et l'adresse de retour jusqu'au destinataire final, y compris lors du repost du parent. Préserver les environnements distants et la barrière interdisant à un sender seulement nommé par record d'emprunter l'autorité du parent. Fichiers : `omp/peer/index.ts`, `send.ts`, `receive.ts` ; suites existantes `omp/peer/addressing.test.ts`, `receive.test.ts`, `reply-args.test.ts`. Scénarios : reply direct, reply relayé, réponse à cette réponse, parent en queue, parent introuvable, route absente, relay non autorisé. Vérifier les échanges observables, pas seulement l'argv du premier hop.
- **#219** : réutiliser les mesures existantes et confronter tout refus attribué retrouvé aux chemins ci-dessus. Ne pas créer de messages de travail artificiels aux sessions vivantes. Si une nouvelle preuve rattache l'incident à #220 ou #231, proposer une clôture duplicate avec le lien causal ; sinon garder needs-info avec la pièce manquante précise : sortie du refus initial et contexte de route/version. Aucune clôture « les probes passent donc il n'y avait pas de problème ».

#220 peut modifier les formes utilisées par #231 : arrêter d'abord le contrat de résultat de parent lookup, puis intégrer le transport. Un même propriétaire intègre `lineage/send/receive` ; les preuves des deux issues restent séparées.

### Lot D — Rendre la publication dépendante d'un Test du bon head

**Issue : #227. Indépendante des réparations AX.**

- Automatiser l'exécution existante `workflow_dispatch` de Test sur la branche release-please avant le merge ; ne pas ajouter un credential PAT/App ni supprimer `pnpm test` des checks requis par défaut.
- Capturer le head attendu, identifier le run déclenché, exiger son bon workflow, sa bonne ref, son head SHA et le check nommé réussi. Un workflow vert sur main ou sur un ancien head ne suffit pas.
- `ref` de workflow_dispatch est documenté comme branche/tag, pas comme SHA brut : déclencher sur la branche, vérifier le SHA exécuté, puis lier le merge au même SHA. Si la branche bouge, ne pas merger sous la preuve précédente.
- Refuser proprement absence de run/check, timeout, failure, approval required et head changé. Ne pas appeler les runs zéro-job `action_required` quand REST dit `failure`. La cause précise de ces failures reste à isoler ; l'automatisation du chemin documenté résout le prérequis de publication sans inventer leur cause.
- Fichiers : `scripts/deploy.mjs`, `.github/workflows/test.yml`, couverture mainteneur existante à localiser avant implémentation. Preuve finale sur une vraie PR release-please autorisée : Test nommé vert sur son head avant merge ; Release du merge puis paquet publié restent des observations séparées. Un scénario injecté défend le refus de merge si le head change.

### Lot E — Finir les lifecycles et observer les corrections déjà livrées

**Issues : #185, #232, #233.**

- **#185** : commencer par la solution prévue dans l'issue et la moins risquée : une fin retained explicite pour un worker dont l'exit exact par opérateur est établi, avec le moyen d'accéder à l'historique encore disponible. L'existence d'une archive native indépendante doit être prouvée et nommée comme telle, jamais assimilée à une archive Release. Ne pas créer une nouvelle opération Orca si une disposition AX honnête suffit. Tester exit exact/operator_close, panne d'inventaire, identité non prouvée et archive réellement établie dans `tests/worker-release.test.mjs`. Ne tuer ni rouvrir un processus pour faire passer le cas.
- **#232 et #233** : une seule observation de Wave pertinente, à un point calme autorisé, sur un consommateur équipé d'au moins 0.24.4 et une session nouvellement chargée. Vérifier séparément : artefacts requis livrés avec la PR et aucun résidu non classé de ce type ; KEEP nommant les panes effectivement présentes et permettant une décision sans lecture manuelle additionnelle. Ne pas conclure succès si la Wave ne produit aucun artefact requis ou aucun KEEP.
- Pin installé et bundle chargé sont deux preuves. Ne pas modifier un consommateur sale ni échanger sa dépendance sous un worker actif. Les vieux worktrees déjà briefés ne sont pas une preuve d'échec de la nouvelle instruction.
- Clore #232/#233 avec la Wave, la version chargée et l'observation concrète. Ne pas ajouter d'allowlist de filenames ni de fermeture automatique basée sur title/agentIdentity.

### Lot F — Lever le blocage d'accès, puis terminer la Spec

**Dépendance stricte : #206 → observations #174 → clôture #174.**

1. À l'exécution autorisée, établir le résultat de la vraie récupération par le chemin déclaré, sans substituer root. Un pull de l'adaptateur VPS via une autre identité ne constitue pas cette preuve.
2. Si l'accès fonctionne déjà, consigner le Report récupéré depuis l'hôte/provenance attendus, avec confinement et borne, puis fermer #206. Si le refus persiste, demander le choix d'accès ou la révision explicite du mandat ; ne modifier aucune clé ni identité implicitement.
3. Sur #174, remplacer les deux observations Blocked par des Observed seulement après satisfaction réelle. Relire `ax frontier --spec 174` ; clore la Spec lorsque son reçu ne comporte plus de travail/observation inachevé.
4. #185 et #212 restent hors du mandat original ; ne pas les introduire rétroactivement comme des blocages de #174. Les autres réparations de ce plan ne deviennent pas automatiquement des findings nécessaires de cette Spec.

### Lot G — Décider la fusion partielle, sans contourner le Gate

**Issue : #218.**

Recommandation immédiate : garder l'issue comme proposition de fonctionnalité, corriger son conseil erroné, et utiliser le recut explicite via le spec flow pour les Tickets qui doivent séparer mécanisme et démonstration.

Si une fusion partielle de première classe est voulue, décider une Spec bornée avant de coder : autorité qui déclare le partiel, identité de la livraison, maintien des bloqueurs, interdiction de mots de clôture dans tous les canaux, preuve au SHA, record de merge et reprise du reliquat. Pas un simple flag de contournement. Si ce besoin est rejeté explicitement, fermer #218 comme not_planned ; aujourd'hui aucun fait ne le rend obsolète.

## Ordre d'exécution recommandé

1. Lot A : quatre clôtures et correction des notes trompeuses.
2. Priorité sûreté : B/#212 et B/#223 indépendamment ; B/#221 avec son jalon de propriété/runtime, sans attendre pour sécuriser #212.
3. En parallèle des propriétaires distincts : C messagerie et D publication. D doit être terminé avant la publication groupée qui s'appuie sur son nouveau contrat.
4. E/#185 peut avancer séparément. Regrouper ensuite la validation #232/#233 sur une seule Wave représentative, sans en fabriquer une pour vider le tracker.
5. F accès/Completion reste indépendant du code : le seul éventuel choix humain est celui de l'identité ou du mandat si l'accès déclaré échoue toujours.
6. G produit ne bloque aucun correctif de sûreté ni de livraison.

Regrouper la coordination et la publication, pas les preuves : chaque issue conserve sa condition de clôture et chaque PR cohérente son risque propre. Pas de nouvelle issue par défaut, pas de deuxième passe de triage sur les mesures déjà établies.

## Condition de fin du traitement

Chaque issue est soit fermée avec une preuve ou un refus de périmètre précis, soit gardée avec une action, un propriétaire et un blocage nommé. Le nombre d'issues ouvertes n'est pas le critère de réussite. Les quatre clôtures proposées ramèneraient immédiatement 17 à 13 ; aucune réduction supplémentaire n'est annoncée avant les observations correspondantes.

## Sources externes qui changent la décision

- [GitHub — déclencher un workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) : les événements PR issus de GITHUB_TOKEN peuvent créer un run nécessitant approbation ; workflow_dispatch reste une exception permettant un run.
- [GitHub REST — workflow_dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) : ref est une branche ou un tag ; vérifier le head exécuté est donc nécessaire.
- [Supabase CLI](https://supabase.com/docs/reference/cli/introduction) : globals et arité servant au classement des commandes, à confirmer contre la version supportée lors de l'implémentation.
- Orca : checkout du fork lu, `src/main/runtime/rpc/methods/orchestration-routing.ts` ; aucun code de l'application installée extrait, aucun changement de la frontière d'autorité proposé pour #231.
