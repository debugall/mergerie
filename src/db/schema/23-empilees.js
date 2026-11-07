'use strict';
/* LES MERGE REQUESTS EMPILÉES — « contient !214 » / « contenue dans !219 » sur la carte.
 *
 * Une merge request en CONTIENT une autre quand l'ensemble des commits de la seconde (`cible..source`)
 * est inclus dans l'ensemble des commits de la première : on est reparti de la branche d'un collègue,
 * on a ajouté son travail, on a ouvert vers `main`. La forge montre un diff ordinaire ; rien ne dit
 * que 220 des 300 lignes sont déjà en revue ailleurs. C'est un fait de git, comparé en SQL, sans IA.
 *
 * La seule donnée nouvelle est la LISTE DES SHA de chaque merge request ouverte, relevée sur le SHA de
 * tête dans le même tour de découverte que les listes de fichiers (même plafond, pas de second
 * compteur) : `mr_commits`, une ligne par commit, `position` croissante du plus ancien au plus
 * récent ; `mr_commit_fetch`, qui distingue « relevée » de « jamais relevée » — exactement comme
 * `mr_file_fetch` — et porte le refus (`too-many-commits` au-delà de 500, `truncated` quand GitHub
 * coupe à 250 : une inclusion ne se calcule JAMAIS sur une liste partielle). Invalidée dès que le SHA
 * de tête OU la branche cible change. L'inclusion ne se stocke pas : elle se calcule à l'affichage
 * (`src/review/empilees.js`).
 *
 * `mr_contained_history` : quand la merge request contenue merge, son badge disparaît de la contenante
 * et le panneau garde `contenait !214 · mergée il y a 2 h` pendant sept jours — c'est l'explication
 * du retard qui vient d'apparaître. Famille C du registre, purgé avec les listes de fichiers. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS mr_commits (
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (mr_id, position)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mr_commits_sha ON mr_commits (sha, mr_id)');
db.exec(`CREATE TABLE IF NOT EXISTS mr_commit_fetch (
  mr_id INTEGER PRIMARY KEY REFERENCES mr(id) ON DELETE CASCADE,
  head_sha TEXT,
  target_branch TEXT,
  fetched_at TEXT NOT NULL,
  count INTEGER,
  source TEXT,
  refused TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS mr_contained_history (
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  other_mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  merged_at TEXT NOT NULL,
  PRIMARY KEY (mr_id, other_mr_id)
)`);

/* Un réglage d'équipe (Réglages → Merge Request → Découverte) : relever les commits des MR ouvertes.
   Décoché : aucun appel de plus, aucun badge. Le plafond est celui des listes de fichiers. */
try { db.exec("ALTER TABLE config ADD COLUMN mr_commits_enabled TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
