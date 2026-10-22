'use strict';
/* LE RATTRAPAGE D'UNE PÉRIODE — « qu'est-ce qui s'est passé pendant mon absence ? ».
 *
 * Une `periode` est une fenêtre de dates construite depuis la forge et le clone : les merge
 * requests mergées, fermées, arrivées ou actives dedans, les pushs directs sur les branches
 * surveillées, les tags, et ce que les collègues ont fait dans Mergerie (base partagée). Chaque
 * ligne porte `seen_at` : l'écran est une liste qu'on vide, et l'état survit au recalcul.
 *
 * LES DEUX TABLES SONT DE POSTE (famille L du registre) : une période est MON rattrapage, bornée
 * par MES dates ; ses faits se recalculent depuis la forge ; et « vu » est personnel. Une seule
 * mécanique, donc : `seen_at` sur la ligne, pas une préférence à côté.
 *
 * La rétention des journaux (`retention_days`) emporte les périodes avec elle ; la cascade
 * emporte les items. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS periode (
  id INTEGER PRIMARY KEY,
  depuis TEXT NOT NULL,
  jusqua TEXT NOT NULL,
  built_at TEXT,
  partiel INTEGER NOT NULL DEFAULT 0,
  repo_ids TEXT,                         -- JSON : les dépôts demandés (vide = tous les dépôts actifs)
  job_id INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS periode_item (
  id INTEGER PRIMARY KEY,
  periode_id INTEGER NOT NULL REFERENCES periode(id) ON DELETE CASCADE,
  repo_id INTEGER,
  kind TEXT NOT NULL,                    -- push | mr_merged | mr_closed | mr_new | mr_active | tag | branch_gone | team
  ref TEXT NOT NULL,                     -- iid, sha de tête du push, nom du tag, uid de l'objet partagé…
  author TEXT,
  title TEXT,
  at TEXT,
  extra TEXT,                            -- JSON : commits du push, +/−, branche, étiquettes, raison « non vérifié »…
  mr_id INTEGER,
  seen_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_periode_item_periode ON periode_item(periode_id, kind)');
/* Ce que chaque dépôt n'a pas pu livrer en entier (forge injoignable, passe 3 plafonnée…) :
   affiché sur sa section, jamais caché. JSON `{ repo_id: [raisons] }`. */
try { db.exec('ALTER TABLE periode ADD COLUMN partiel_detail TEXT'); } catch { /* déjà présente */ }
/* Le résumé IA de la période (option, jamais par défaut) : du Markdown écrit par un agent,
   rendu comme un rapport, non fiable. `resume_at` date l'appel. */
try { db.exec('ALTER TABLE periode ADD COLUMN resume TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE periode ADD COLUMN resume_at TEXT'); } catch { /* déjà présente */ }
/* LES FENÊTRES DE DATES que le rattrapage lit dans les tables des autres (« fait par l'équipe »,
   « fait par Mergerie ») et le dédoublonnage du journal `feed` que la découverte exécute par
   MR classée : sans index, des parcours complets, répétés. Placés ici — la dernière tranche —
   donc APRÈS chaque `CREATE TABLE` concerné. `note_page` a un index, mais il commence par
   `pinned` : inutilisable pour une borne sur `updated_at` seule. */
db.exec('CREATE INDEX IF NOT EXISTS idx_feed_mr ON feed(type, project, mr_iid)');
db.exec('CREATE INDEX IF NOT EXISTS idx_task_created ON task(created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_todo_updated ON todo(updated_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_note_page_updated ON note_page(updated_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_verification_created ON verification(created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_review_version_created ON review_version(created_at)');
