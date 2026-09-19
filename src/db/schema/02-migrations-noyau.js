'use strict';
/* Ce que les versions suivantes ont ajouté aux tables du noyau : la forge, les dates de la MR, le ticket, les colonnes de session, les liens de MR et de dépôt, Jira et Jenkins dans la config.
   Tranche de l'ancien db.js (refacto.md, étape 3), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

try { db.exec("ALTER TABLE repo ADD COLUMN forge TEXT DEFAULT 'gitlab'"); } catch { /* déjà présente */ }
/* Migration : récupération des MR, dépôt par dépôt. Distincte de `enabled`, qui retire le
   dépôt de PARTOUT (git, sessions, recherche de ref). Ici on garde le dépôt utilisable et on
   cesse seulement de ramener ses MR. Par défaut à 1 : les dépôts existants ne changent pas
   de comportement. */
try { db.exec('ALTER TABLE repo ADD COLUMN fetch_mrs INTEGER DEFAULT 1'); } catch { /* déjà présente */ }
// Migration : connexion GitHub (URL vide = github.com ; sinon GitHub Enterprise).
try { db.exec("ALTER TABLE config ADD COLUMN github_url TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN github_token TEXT DEFAULT ''"); } catch { /* déjà présente */ }
// Migration : colonne d'erreur persistée par MR (texte complet, non tronqué).
try { db.exec('ALTER TABLE mr ADD COLUMN last_error TEXT'); } catch { /* déjà présente */ }
/* De QUOI un job s'occupe-t-il. La table ne portait que `current_mr_id` : rien ne reliait un job
   à la session de codage qu'il exécutait, donc impossible de dire après coup « ce job-là, c'était
   la session sur api-core ». C'est ce qui rend le journal d'activité lisible. */
try { db.exec('ALTER TABLE job ADD COLUMN target_kind TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE job ADD COLUMN target_id INTEGER'); } catch { /* déjà présente */ }
// Migration : date de création de la MR côté GitLab (pour le tri).
try { db.exec('ALTER TABLE mr ADD COLUMN gitlab_created_at TEXT'); } catch { /* déjà présente */ }
/* QUAND LA MERGE REQUEST A ÉTÉ MERGÉE — la date de la FORGE, pas celle où ce poste s'en est
   aperçu. Le délai de cycle se mesurait entre l'ouverture et une ligne du journal d'activité,
   écrite par la découverte au moment où elle cessait de voir la MR ouverte : une approximation
   qui n'existe que sur la machine qui regardait ce jour-là. À plusieurs, elle ne veut plus rien
   dire — et sur un poste qui vient de rejoindre, elle n'existe pas du tout, donc le graphique
   restait vide. La forge, elle, connaît l'instant exact et le même pour tout le monde. */
try { db.exec('ALTER TABLE mr ADD COLUMN merged_at TEXT'); } catch { /* déjà présente */ }
// Migration : auteur de la MR.
try { db.exec('ALTER TABLE mr ADD COLUMN author TEXT'); } catch { /* déjà présente */ }
// Migration : chemin du diff sauvegardé (pour la vue rapport + diff).
try { db.exec('ALTER TABLE review ADD COLUMN diff_path TEXT'); } catch { /* déjà présente */ }
// Migration : note globale numérique (0..1) pour le dashboard.
try { db.exec('ALTER TABLE review ADD COLUMN note_value REAL'); } catch { /* déjà présente */ }
/* Migration : quand le rapport a été publié en commentaire sur la merge request. Une trace,
   pas un drapeau : le bouton « Publier » doit pouvoir dire ce qui est DÉJÀ parti chez les
   autres, sinon on republie le même rapport en croyant que le premier envoi a échoué. */
try { db.exec('ALTER TABLE review ADD COLUMN comment_posted_at TEXT'); } catch { /* déjà présente */ }
// Migration : contexte du ticket (texte + capture) fourni par le relecteur.
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_text TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_image TEXT'); } catch { /* déjà présente */ }
// Migration : contexte Jira récupéré automatiquement (distinct du contexte manuel
// ci-dessus, pour ne jamais l'écraser — les deux sont concaténés à la review).
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_text TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_key TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_at TEXT'); } catch { /* déjà présente */ }
// Session d'agent de la review (continuité : « Relancer la review » reprend la même session).
try { db.exec('ALTER TABLE mr ADD COLUMN review_session_key TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN review_session_backend TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN review_session_cwd TEXT'); } catch { /* déjà présente */ }
/* La forge refuse-t-elle de fusionner cette merge request ? 1 / 0 / NULL (pas encore su).
   Relevé au moment où l'on ouvre la modale de merge : on est alors à un clic d'une action
   irréversible, un appel d'API pour le dire avant vaut mieux qu'un refus après. */
try { db.exec('ALTER TABLE mr ADD COLUMN has_conflicts INTEGER'); } catch { /* déjà présente */ }
/* BROUILLON (« Draft »/« WIP ») et REVIEWERS DEMANDÉS, relevés à la découverte. Les deux
   viennent de la liste déjà parcourue — on les jetait. Un brouillon n'est pas prêt à être
   relu : la review automatique lui dépensait un appel IA, et rien à l'écran ne disait
   pourquoi ce rapport semblait porter sur du travail inachevé. `reviewers` est stocké en
   texte séparé par des virgules : on ne cherche jamais dedans, on ne fait que l'afficher et
   dire « on m'a demandé de la relire ». */
/* CE QUE LA MERGE REQUEST DIT D'ELLE-MÊME. Sans Jira configuré, l'IA ne connaissait que le
   diff : elle jugeait du code sans savoir ce qu'il prétendait faire, et relevait comme des
   manques des choix assumés, écrits dans la description. Bornée à 4 000 caractères à
   l'écriture — au-delà, c'est le diff qu'on ampute. */
try { db.exec("ALTER TABLE mr ADD COLUMN description TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN is_draft INTEGER'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE mr ADD COLUMN reviewers TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* L'IDENTIFIANT DE L'AUTEUR et L'ORIGINE (fork), relevés à la découverte : la vérification
   automatique n'exécute pas le code d'un fork, et reconnaît « mes » merge requests par
   l'identifiant, pas par le nom affiché qu'on change en deux clics. Locaux : la forge fait foi. */
try { db.exec("ALTER TABLE mr ADD COLUMN author_username TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN is_fork INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_error TEXT'); } catch { /* déjà présente */ }
/* LE STATUT DU TICKET, POUR TOUTES LES MR — pas seulement celles dont le ticket est surveillé.
   La découverte lit déjà l'issue en entier pour en tirer le contexte : ranger son statut à côté
   ne coûte aucun appel, et fait apparaître « ticket en revue » là où on choisit quoi reviewer. */
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_status TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_category TEXT'); } catch { /* déjà présente */ }
// Migration : chemins des fichiers modifiés par la MR (pour le badge « risque » et
// les règles par chemin), un par ligne. Rempli au discover / à la review.
try { db.exec('ALTER TABLE mr ADD COLUMN changed_paths TEXT'); } catch { /* déjà présente */ }
/* La TAILLE du changement, relevée avec les chemins (même appel) : « 12 fichiers · +340 −80 »
   sur la carte, c'est ce qui décide par quoi commencer sans ouvrir trois merge requests. */
try { db.exec('ALTER TABLE mr ADD COLUMN changed_files INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN changed_additions INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN changed_deletions INTEGER'); } catch { /* déjà présente */ }
/* Options de merge choisies à la création de la MR. GitLab les applique nativement dès
   la création ; GitHub ne sait pas les exprimer là (ce sont des décisions de merge), on
   les mémorise donc ici pour pré-cocher — et appliquer — la modale de merge. */
try { db.exec('ALTER TABLE mr ADD COLUMN squash INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN remove_source_branch INTEGER'); } catch { /* déjà présente */ }
// Migration : règles de review par CHEMIN de fichier (glob) — plus précis que la
// branche. Une règle peut avoir branch_match et/ou path_match. label = badge court.
try { db.exec('ALTER TABLE review_rule ADD COLUMN path_match TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE review_rule ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
/* A/Réglages 2 — UNE RÈGLE PEUT NE VALOIR QUE POUR UN DÉPÔT. Sans cette colonne, la seule
   façon de limiter la portée d'une règle était de deviner un `path_match` que seul ce dépôt
   satisferait — ce qui n'est pas toujours possible, et jamais lisible. NULL = tous les dépôts,
   c'est-à-dire le comportement d'avant : les règles existantes ne changent pas de portée. */
try { db.exec('ALTER TABLE review_rule ADD COLUMN repo_id INTEGER'); } catch { /* déjà présente */ }
// Projets liés à une MR : l'IA analyse l'impact des changements sur ces dépôts
// (lecture seule) lors de la review. Un lien = un dépôt connu + une branche.
db.exec(`CREATE TABLE IF NOT EXISTS mr_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL,
  branch TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mr_link_mr ON mr_link(mr_id)');
// Liens par DÉFAUT au niveau dépôt : `quand on review repo_id, lier linked_repo_id`.
// Copiés dans mr_link à la découverte d'une nouvelle MR de repo_id (zéro clic).
db.exec(`CREATE TABLE IF NOT EXISTS repo_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  linked_repo_id INTEGER NOT NULL,
  branch TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_repo_link_repo ON repo_link(repo_id)');
// Migration : URL de base Jira (configurable dans l'admin).
try { db.exec("ALTER TABLE config ADD COLUMN jira_url TEXT DEFAULT ''"); } catch { /* déjà présente */ }
// Migration : identifiants Jira Cloud (email + jeton d'API) pour le fetch automatique.
try { db.exec("ALTER TABLE config ADD COLUMN jira_email TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN jira_token TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Migration : connexion Jenkins (URL + utilisateur + jeton d'API). Jenkins authentifie en
   Basic `utilisateur:jeton` — le jeton seul ne suffit pas, d'où les deux champs. */
try { db.exec("ALTER TABLE config ADD COLUMN jenkins_url TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN jenkins_user TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN jenkins_token TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Cadence de rafraîchissement de l'onglet Jenkins, en minutes (0 = jamais). En base et non en
   localStorage, comme celle des MR et celle de Jira : c'est un réglage de l'OUTIL, et il doit
   valoir quel que soit le navigateur d'où on le regarde. */
try { db.exec('ALTER TABLE config ADD COLUMN jenkins_refresh_minutes INTEGER DEFAULT 1'); } catch { /* déjà présente */ }
/* Plafond de vérifications automatiques par tour de découverte. Un lundi matin en ramène
   quinze : quinze batteries fonctionnelles saturent la machine et bloquent la file partagée
   avec les reviews. Le bon chiffre dépend de la machine et de la durée des suites — il se règle
   donc, au lieu d'être une constante que seul le code connaît. 0 = aucune limite (assumé). */
try { db.exec('ALTER TABLE config ADD COLUMN verif_auto_max INTEGER DEFAULT 5'); } catch { /* déjà présente */ }
/* De QUI la vérification automatique exécute le code sans un clic : 'mine' (défaut) ou 'all'.
   « Tout le monde » était le défaut implicite du mono-poste — celui qui ouvre une MR sur un
   projet suivi faisait tourner ses commandes sur ce poste. */
try { db.exec("ALTER TABLE config ADD COLUMN verif_auto_authors TEXT DEFAULT 'mine'"); } catch { /* déjà présente */ }
// Migration : message de commit personnalisable des tâches.
/* LE VÉRIFICATEUR D'UNE SESSION, facultatif. Rattaché à la session et non au lancement :
   relancer la même session doit revérifier de la même façon, sans qu'on ait à s'en souvenir.
   `SET NULL` — supprimer un vérificateur ne doit pas emporter les sessions qui s'en servaient. */
try { db.exec('ALTER TABLE task ADD COLUMN verifier_id INTEGER REFERENCES verifier(id) ON DELETE SET NULL'); } catch { /* déjà présente */ }
/* UN LIBELLÉ, FACULTATIF. Une liste de sessions se lit par son prompt — trois lignes repliées
   dont les premiers mots se ressemblent souvent d'une session à l'autre. Un titre court écrit
   par qui la lance dit en un coup d'œil ce qu'elle fait ; vide, on retombe sur le prompt. */
try { db.exec('ALTER TABLE task ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
/* UN SUIVI EN ATTENTE. On lit le travail de l'IA pendant qu'elle travaille, et la remarque
   vient là — pas vingt minutes plus tard quand la session est finie et qu'on est passé à
   autre chose. On l'écrit donc quand elle vient, elle attend ici, et c'est un geste explicite
   qui l'envoie : rien dans `jobs.js` ni `taskrunner.js` ne lit cette colonne, une session ne
   doit jamais repartir toute seule sur un texte écrit une heure plus tôt. */
try { db.exec('ALTER TABLE task ADD COLUMN followup_draft TEXT'); } catch { /* déjà présente */ }
/* … sauf si on demande explicitement le contraire. Coché, le suivi part de lui-même à la fin de
   la session. Le défaut reste 0 : un envoi automatique doit être un choix, jamais un oubli. */
try { db.exec('ALTER TABLE task ADD COLUMN followup_auto INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN commit_message TEXT'); } catch { /* déjà présente */ }
// Migration : MR créée depuis une tâche.
try { db.exec('ALTER TABLE task ADD COLUMN mr_iid INTEGER'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN mr_url TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN mr_target TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN mr_merged INTEGER'); } catch { /* déjà présente */ }
// Migration : langue de l'interface. En base et non seulement en localStorage,
// car les messages d'erreur du serveur sont affichés à l'utilisateur (i18n.md §2.1).
try { db.exec("ALTER TABLE config ADD COLUMN language TEXT DEFAULT 'fr'"); } catch { /* déjà présente */ }
// Migration : rafraîchissement automatique des MR (minutes, 0 = désactivé).
try { db.exec('ALTER TABLE config ADD COLUMN auto_refresh_minutes INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
// Migration : cadence de vérification des tickets Jira surveillés (0 = désactivée).
try { db.exec('ALTER TABLE config ADD COLUMN jira_watch_minutes INTEGER DEFAULT 5'); } catch { /* déjà présente */ }
/* Rétention de l'historique, en JOURS (0 = illimité). `job_log`, `job` et `feed` accumulent
   sans jamais se vider ; sur une instance utilisée tous les jours, ce sont elles qui finissent
   par peser. 90 jours par défaut : assez long pour relire le journal d'un job d'il y a deux
   mois, assez court pour que la base ne double pas chaque année. Voir `retention.js` pour ce
   qui n'est PAS purgé, et pourquoi. */
try { db.exec('ALTER TABLE config ADD COLUMN retention_days INTEGER DEFAULT 90'); } catch { /* déjà présente */ }
/* Tickets Jira surveillés. `status` est le DERNIER état connu : c'est lui qu'on compare au
   prochain passage pour décider s'il y a eu changement. Un ticket ajouté part donc avec
   l'état courant, sinon la première vérification notifierait un faux changement. */
