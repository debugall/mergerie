'use strict';
/* Les répertoires locaux, les sauvegardes Docker, les versions d’une review et ses constats, le flux, les opérations git restaurables.
   Tranche de l'ancien db.js (refacto.md, étape 3), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS local_root (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT
)`);

// Onglet Docker : avant tout `docker rm` d'un container HORS-COMPOSE, on sauvegarde son
// `docker inspect` complet ici — filet de restauration (sans définition déclarative, ce JSON
// est la seule trace pour régénérer un `docker run` équivalent). Esprit des branches restaurables.
db.exec(`CREATE TABLE IF NOT EXISTS docker_backup (
  id INTEGER PRIMARY KEY,
  container_id TEXT,
  name TEXT,
  image TEXT,
  inspect_json TEXT NOT NULL,
  run_command TEXT,
  created_at TEXT
)`);

// Migration : les tâches mono-projet existantes deviennent une tâche à un seul target.
// Idempotent (on ne migre que les tâches qui n'ont encore aucun target).
try {
  const orphans = db.prepare(`SELECT t.* FROM task t
    WHERE NOT EXISTS (SELECT 1 FROM task_target tt WHERE tt.task_id = t.id)`).all();
  if (orphans.length) {
    const ins = db.prepare(`INSERT INTO task_target
      (task_id, repo_id, branch, base_branch, status, commit_sha, diff_path, push_command,
       mr_iid, mr_url, mr_target, mr_merged, last_error, updated_at)
      VALUES (@task_id, @repo_id, @branch, @base_branch, @status, @commit_sha, @diff_path, @push_command,
              @mr_iid, @mr_url, @mr_target, @mr_merged, @last_error, @updated_at)`);
    const run = db.transaction((rows) => {
      for (const t of rows) {
        ins.run({
          task_id: t.id, repo_id: t.repo_id, branch: t.branch, base_branch: t.base_branch,
          status: t.status || 'new', commit_sha: t.commit_sha, diff_path: t.diff_path,
          push_command: t.push_command, mr_iid: t.mr_iid, mr_url: t.mr_url,
          mr_target: t.mr_target, mr_merged: t.mr_merged || 0, last_error: t.last_error,
          updated_at: t.updated_at,
        });
      }
    });
    run(orphans);
    console.log(`[migration] ${orphans.length} tâche(s) mono-projet converties en task_target`);
  }
} catch (e) { console.error('[migration] task_target :', e.message); }

// Historique des reviews : chaque passe produit une VERSION conservée, au lieu
// d'écraser la précédente. Permet de relire une review antérieure, et ouvre la voie
// au suivi de résolution (quels constats persistent d'une passe à l'autre).
db.exec(`CREATE TABLE IF NOT EXISTS review_version (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  md_path TEXT,
  explanation_path TEXT,
  note_value REAL,
  reviewed_sha TEXT,
  kind TEXT DEFAULT 'review',
  created_at TEXT
)`);
// Migration : demande de modification à l'origine d'une version de rapport (kind='modify').
// Sans elle, l'historique des régénérations ne dit pas CE QUI avait été demandé.
try { db.exec('ALTER TABLE review_version ADD COLUMN instruction TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_review_version_mr ON review_version(mr_id, version)');

/* Suivi de résolution entre deux passes de review (ideas.md « Suivi de résolution »).
   Chaque passe émet des CONSTATS structurés (fichier, ligne, sévérité, titre). Le
   `fingerprint` — hash(fichier + titre normalisé), SANS la ligne (elle bouge) —
   donne une identité stable pour apparier un constat d'une passe à l'autre.
   Une ligne par (version, constat). Le `status` raconte l'histoire du constat À
   CETTE passe :
     - new         : apparu à cette passe
     - persistent  : déjà présent à la passe précédente, toujours là
     - resolved    : présent avant, disparu ICI, ET la ligne a changé (vérifié git)
     - disappeared : présent avant, disparu ICI, mais code inchangé → NON vérifié
   resolved/disappeared portent le fichier/titre de l'ANCIEN constat (celui qui a
   disparu), rattachés à la version courante pour que « les constats de la v3 »
   racontent tout le delta en une requête. */
db.exec(`CREATE TABLE IF NOT EXISTS finding (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  severity TEXT,
  title TEXT,
  status TEXT NOT NULL,
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_finding_mr_version ON finding(mr_id, version)');

// Agrégats du delta, portés par la version : lecture directe pour le bandeau du
// rapport et le taux de résolution des statistiques, sans recompter les constats.
for (const col of ['n_new', 'n_persistent', 'n_resolved', 'n_disappeared']) {
  try { db.exec(`ALTER TABLE review_version ADD COLUMN ${col} INTEGER`); } catch { /* déjà présente */ }
}

// Migration : les reviews existantes deviennent leur propre version 1, en pointant
// les fichiers déjà sur disque. Idempotent (seules les MR sans version sont traitées).
try {
  const orphans = db.prepare(`SELECT r.* FROM review r
    WHERE NOT EXISTS (SELECT 1 FROM review_version v WHERE v.mr_id = r.mr_id)`).all();
  if (orphans.length) {
    const ins = db.prepare(`INSERT INTO review_version
      (mr_id, version, md_path, explanation_path, note_value, reviewed_sha, kind, created_at)
      VALUES (?, 1, ?, ?, ?, ?, 'review', ?)`);
    const run = db.transaction((rows) => {
      for (const r of rows) {
        const sha = db.prepare('SELECT reviewed_sha FROM mr WHERE id = ?').get(r.mr_id);
        ins.run(r.mr_id, r.md_path, r.explanation_path, r.note_value,
          sha ? sha.reviewed_sha : null, r.created_at || r.updated_at);
      }
    });
    run(orphans);
    console.log(`[migration] ${orphans.length} review(s) existantes historisées en version 1`);
  }
} catch (e) { console.error('[migration] review_version :', e.message); }

// Journal d'événements « frais » pour le footer (MR arrivée / mergée, par auteur).
db.exec(`CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY,
  type TEXT,
  mr_iid INTEGER,
  project TEXT,
  author TEXT,
  title TEXT,
  at TEXT
)`);
// Flag : MR ouverte connue qui a disparu de GitLab (mergée/fermée) déjà signalée.
try { db.exec('ALTER TABLE mr ADD COLUMN closed_seen INTEGER DEFAULT 0'); } catch { /* déjà présente */ }

/* Journal des opérations Git multi-dépôts (onglet Git).
   Sert à deux choses : l'historique consultable, et surtout la RESTAURATION.
   Une suppression de branche n'efface pas les commits, elle efface un pointeur :
   en gardant le SHA on peut le reposer. On stocke aussi tag_sha séparément car,
   pour un tag annoté, l'objet tag et le commit ont deux SHA distincts — restaurer
   avec le seul SHA de commit perdrait le message du tag. */
db.exec(`CREATE TABLE IF NOT EXISTS git_op (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  repo_id INTEGER,
  project TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  ref_sha TEXT,
  tag_sha TEXT,
  tag_message TEXT,
  source_ref TEXT,
  status TEXT NOT NULL,
  error TEXT,
  fetched INTEGER DEFAULT 0,
  restored_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_git_op_batch ON git_op(batch_id)');

// Ligne de config unique (id=1). Les gabarits de prompt par défaut vivent dans
// prompts.js, qui les tient dans les deux langues (i18n.md lot 5).
const { PROMPTS, ANCIENS_PROMPTS } = require('../../core/prompts');
// Convergence (« Converger ») : réglages par défaut (surchargeables au lancement).
// Seuil cible en /10, plafond de passes de correction.
try { db.exec("ALTER TABLE config ADD COLUMN converge_threshold TEXT DEFAULT '8'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN converge_max_passes TEXT DEFAULT '3'"); } catch { /* déjà présente */ }

// Une RUN de convergence rattachée à une MR : la machine à états qui enchaîne
// review → correction IA (commit + push) → re-review incrémentale, jusqu'au seuil,
// à la régression, ou au plafond de passes. L'historique fin (notes par passe) vit
// déjà dans review_version ; cette table porte l'état global de la boucle.
/* A26 — DÉTECTER LES TESTS INSTABLES, sans rien demander à personne. Un test rouge à un run
   et vert au suivant SANS QUE LE CODE AIT BOUGÉ n'est pas un test qui casse : c'est un test
   qui ment, et il coûte plus cher qu'un échec franc — on relance, on hausse les épaules, et le
   jour où il dit vrai on ne le croit plus.

   Ce qu'il faut pour le savoir tient en trois colonnes : le CODE testé (`targets_key` : les
   couples dépôt:sha triés — deux runs sur le même code sont comparables, sur des codes
   différents ils ne le sont pas), et le nom des tests ROUGES de ce run. Une ligne à `test`
   NULL marque le run lui-même : sans elle, un run tout vert ne laisserait aucune trace et on
   ne saurait pas qu'un test rouge ailleurs a été vert ici.

   Seuls les runs qui NOMMENT leurs tests (TAP, JUnit) y entrent : sans noms, il n'y a rien à
   apparier. Purgée par la rétention, comme les autres traces. */
db.exec(`CREATE TABLE IF NOT EXISTS verify_run_test (
  id INTEGER PRIMARY KEY,
  verification_id INTEGER NOT NULL REFERENCES verification(id) ON DELETE CASCADE,
  verifier_id INTEGER,
  targets_key TEXT NOT NULL,
  test TEXT,
  created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_verify_run_test ON verify_run_test(verifier_id, targets_key)');
