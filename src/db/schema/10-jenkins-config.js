'use strict';
/* Les jobs Jenkins liés à un dépôt, le souvenir des tests de connexion, la ligne de configuration et ses valeurs par défaut, la palette git.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');
const { PROMPTS, ANCIENS_PROMPTS, ANCIEN_PROMPT_REVIEW_COURT } = require('../../core/prompts');
const { DEFAULT_CLONE_DIR } = require('../../core/paths');

/* ---------- B8 : quel job Jenkins déploie quel dépôt ----------
   « La QA veut !217 en recette » : on ouvrait Jenkins, on cherchait `api-deploy-recette` dans
   deux cents jobs, on recopiait la branche sans faute de frappe. Le lien dépôt ↔ job se
   déclare une fois — comme service ↔ dépôt dans Liens — et la carte d'une merge request
   VÉRIFIÉE VERTE propose alors le job, la branche pré-remplie. `param` : le nom du paramètre
   Jenkins qui reçoit la branche (souvent `BRANCH`, parfois `VERSION`) ; vide, on ne
   pré-remplit rien et la fiche s'ouvre telle quelle. */
db.exec(`CREATE TABLE IF NOT EXISTS repo_jenkins (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  job_path TEXT NOT NULL,
  param TEXT,
  UNIQUE(repo_id, job_path)
)`);

/* Cocher une todo liée quand sa merge request est mergée. Coché par défaut : la todo perd sa
   raison d'être au merge, et la cocher soi-même après coup est le geste qu'on oublie. */
try { db.exec("ALTER TABLE config ADD COLUMN todo_close_on_merge TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
/* Au-delà de combien de jours une MR reviewée et toujours ouverte est « dormante ». Cinq
   jours : au-dessous, on signalerait la MR d'avant-hier, qu'on n'a pas oubliée. */
try { db.exec('ALTER TABLE config ADD COLUMN stale_mr_days INTEGER DEFAULT 5'); } catch { /* déjà présente */ }

/* Consignes permanentes ajoutées à toutes les sessions de codage (dépôt et hors dépôt). */
try { db.exec('ALTER TABLE config ADD COLUMN ai_extra_instructions TEXT'); } catch { /* déjà présente */ }

/* LE GABARIT DE CORRECTION, qui applique un rapport de revue au code. Il vivait en dur et en
   français, recopié à l'identique dans « Faire corriger par l'IA » et dans chaque passe de
   Converger : ni traduit, ni éditable, et deux copies vouées à diverger. Vide = le défaut de
   la langue courante s'applique (`src/prompts.js`), comme pour les trois autres gabarits. */
try { db.exec("ALTER TABLE config ADD COLUMN prompt_fix TEXT DEFAULT ''"); } catch { /* déjà présente */ }

/* A38 — QUAND CHAQUE CONNEXION A ÉTÉ TESTÉE POUR LA DERNIÈRE FOIS, et avec quel résultat. Le
   bouton « Tester » répondait à l'écran et n'en gardait rien : au retour dans les réglages, les
   quatre connexions étaient muettes — « GitLab marche-t-il encore ? » se rejouait à chaque
   fois. Une ligne par service, écrite par le test lui-même ; rien n'est sondé en fond, c'est le
   souvenir d'un geste, pas une surveillance. */
db.exec(`CREATE TABLE IF NOT EXISTS conn_test (
  service TEXT PRIMARY KEY,            -- gitlab | github | jira | jenkins
  ok INTEGER NOT NULL,
  detail TEXT,                         -- ce que le service a répondu (compte, login, nb de jobs)
  tested_at TEXT NOT NULL
)`);

/* LE SKILL DE REVIEW N'A PLUS DE CHAMP : il s'écrit dans le gabarit de prompt, là où l'on
   choisit déjà tout le reste de ce qu'on demande à l'IA. Les gabarits enregistrés portent
   encore `{skill}`, un trou qui ne serait plus rempli par personne — il partirait tel quel à
   l'agent. On y recopie donc une bonne fois le skill configuré (`git-review` à défaut). La
   valeur choisie n'est pas perdue, elle change simplement de place ; et un gabarit resté au
   défaut redevient exactement le défaut, donc suit encore les changements de langue.

   Rejouable sans dommage : après le premier passage il n'y a plus de `{skill}` à remplacer.
   Placée APRÈS le `CREATE TABLE config`, sans quoi elle échouerait sur une base neuve. */
db.exec(`UPDATE config SET
  prompt_review  = REPLACE(prompt_review,  '{skill}', COALESCE(NULLIF(TRIM(review_skill), ''), 'git-review')),
  prompt_explain = REPLACE(prompt_explain, '{skill}', COALESCE(NULLIF(TRIM(review_skill), ''), 'git-review')),
  prompt_modify  = REPLACE(prompt_modify,  '{skill}', COALESCE(NULLIF(TRIM(review_skill), ''), 'git-review'))
  WHERE prompt_review LIKE '%{skill}%' OR prompt_explain LIKE '%{skill}%' OR prompt_modify LIKE '%{skill}%'`);

/* LE GABARIT LIVRÉ N'INVOQUE PLUS DE SKILL. Celui qui installe Mergerie n'a pas `git-review`,
   et sa première review demandait pourtant à l'agent de s'en servir. Les installations
   existantes portent encore cet ancien texte : on le remplace par le nouveau défaut de la MÊME
   langue, mais UNIQUEMENT s'il est resté rigoureusement identique — un gabarit modifié, ne
   serait-ce que d'un caractère, appartient à son auteur et n'est pas touché.

   Sans cela il resterait tel quel pour toujours : ne correspondant plus à aucun défaut connu,
   il serait tenu pour personnalisé et ne suivrait même plus les changements de langue.

   Rejouable : après le premier passage, plus aucune ligne ne correspond.
   Placée APRÈS le `CREATE TABLE config`, comme la précédente. */
for (const lang of ['fr', 'en']) {
  db.prepare('UPDATE config SET prompt_review = ? WHERE prompt_review = ?')
    .run(PROMPTS[lang].prompt_review, ANCIENS_PROMPTS[lang].prompt_review);
}

/* LE GABARIT DE REVIEW EST DEVENU UN GABARIT STRUCTURÉ (sévérités, note calibrée, checklist de
   merge), remplaçant l'ancien défaut court (une phrase). Même garde-fou que ci-dessus : on ne
   remplace que le gabarit resté RIGOUREUSEMENT IDENTIQUE à l'ancien défaut, dans SA langue.
   Rejouable : après le premier passage, plus aucune ligne ne correspond. */
for (const lang of ['fr', 'en']) {
  db.prepare('UPDATE config SET prompt_review = ? WHERE prompt_review = ?')
    .run(PROMPTS[lang].prompt_review, ANCIEN_PROMPT_REVIEW_COURT[lang]);
}

const DEFAULT_PROMPT_REVIEW = PROMPTS.fr.prompt_review;
const DEFAULT_PROMPT_EXPLAIN = PROMPTS.fr.prompt_explain;
const DEFAULT_PROMPT_MODIFY = PROMPTS.fr.prompt_modify;

const hasConfig = db.prepare('SELECT 1 FROM config WHERE id = 1').get();
if (!hasConfig) {
  db.prepare(`INSERT INTO config
    (id, gitlab_url, access_token, clone_path, prompt_review, prompt_explain, prompt_modify, review_skill)
    VALUES (1, '', '', ?, ?, ?, ?, 'git-review')`)
    .run(DEFAULT_CLONE_DIR, DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY);
}

// Palette de commandes git (onglet « Commandes Git »), gérée dans Réglages → Git.
// `command` = arguments git figés (ex. « fetch --all --prune »), sans le mot « git ».
db.exec(`CREATE TABLE IF NOT EXISTS git_command (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT
)`);
// Amorçage UNE SEULE FOIS (drapeau en config) : quelques commandes usuelles. Supprimer
// toutes les entrées ne les réintroduit donc pas — c'est un choix de l'utilisateur.
try { db.exec("ALTER TABLE config ADD COLUMN git_commands_seeded INTEGER DEFAULT 0"); } catch { /* déjà présente */ }
/* Review automatique à l'arrivée d'une merge request, et son plafond par tour de découverte.
   Décochée par défaut, et plafonnée même une fois cochée : chaque review est un appel IA
   facturé, et la PREMIÈRE découverte d'une installation neuve ramène toutes les MR ouvertes
   du parc d'un coup. Un lundi matin ne doit pas se solder par trente appels non demandés. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_review_new TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN review_auto_max INTEGER DEFAULT 5'); } catch { /* déjà présente */ }
/* Re-review automatique quand le rapport se périme (la branche a avancé depuis la review).
   Séparée de la précédente et décochée elle aussi : reviewer à l'arrivée et suivre une branche
   qui bouge sont deux dépenses différentes, et la seconde se répète à chaque poussée. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_rereview_stale TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
/* QUI EXÉCUTE LES POLITIQUES AUTOMATIQUES. Réglage d'ÉQUIPE, comme les cases qu'il commande :
   sans lui, deux postes allumés reviewaient deux fois la même merge request — deux appels d'IA,
   deux facturations, deux commentaires sur la forge. Vide = personne n'agit (en mode partagé) ;
   en mono-poste, il est ignoré et tout se comporte comme avant. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_runner TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Publication automatique du rapport de review sur la merge request. DÉCOCHÉ PAR DÉFAUT,
   contrairement à `review_explain` : écrire chez les autres est une décision, et une
   installation neuve ne doit surprendre personne au premier lancement de review. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_post_review TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
/* Filtre de cette publication : n'envoyer que les rapports qui contiennent au moins un
   constat « blocker ». Décoché par défaut — la publication automatique existante ne doit pas
   se mettre à taire des rapports du seul fait d'une migration. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_post_blocking_only TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
/* CE QUI PART AUTOMATIQUEMENT : le rapport, ou son LIEN dans le dépôt de données de l'équipe.
   Décochée par défaut — une migration ne doit pas changer ce que les merge requests reçoivent
   déjà. Sans dépôt de données, la case n'a pas de sens et l'écran ne la montre pas. */
try { db.exec("ALTER TABLE config ADD COLUMN auto_post_review_link TEXT DEFAULT '0'"); } catch { /* déjà présente */ }
/* LE GABARIT DU COMMENTAIRE qui porte le lien. VIDE = le message livré, qui suit la langue de
   l'interface ; rempli, c'est celui de l'équipe, mot pour mot. On ne sème donc rien ici : un
   défaut recopié en base serait figé dans la langue du jour de l'installation, et cesserait de
   suivre la langue comme le reste des textes. */
try { db.exec("ALTER TABLE config ADD COLUMN review_link_template TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* L'amorçage des commandes git a déménagé À LA FIN de ce fichier : son drapeau
   (`git_commands_seeded`) est devenu une donnée de POSTE, et il faut donc que `local_config`
   existe et soit remplie avant de le lire. Lu ici, il aurait valu 0 sur une installation qui
   a déjà ses commandes, et les cinq entrées seraient revenues en double à chaque démarrage. */

/* Nettoyage de tables et colonnes qui ne servent plus. Elles ne visent que les bases DÉJÀ EN
   SERVICE — une base neuve ne les crée simplement pas. La donnée qu'elles portaient était
   dérivée, rien à conserver. Idempotents comme les migrations voisines : la seconde exécution
   ne trouve plus rien et ne dit rien. */
try { db.exec('DROP TABLE IF EXISTS health_status'); } catch { /* déjà partie */ }
try { db.exec('ALTER TABLE environment DROP COLUMN health_check'); } catch { /* déjà retirée */ }

module.exports = { DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY };
