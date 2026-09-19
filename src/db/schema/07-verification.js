'use strict';
/* La vérification objective : vérificateurs, commandes, dépôts, lots, vérifications, convergence.
   Tranche de l'ancien db.js (refacto.md, étape 3), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* ---------- Vérification objective (plan_add_verify.md) ----------
   Un verdict de tests produit HORS du circuit IA : l'orchestrateur appelle un script de
   l'utilisateur, jamais l'agent. Le verdict est un FAIT attaché à des SHAs — il se périme
   si la branche avance — et il n'est jamais bloquant : il informe, l'humain merge. */
db.exec(`CREATE TABLE IF NOT EXISTS verifier (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,               -- toujours '' : les commandes vivent dans verifier_command
  timeout_s INTEGER NOT NULL DEFAULT 900,
  run_base INTEGER NOT NULL DEFAULT 1, -- double run causal : la base était-elle déjà rouge ?
  comment_on_forge INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`);
/* `kind` vaut désormais TOUJOURS 'commands' : une liste de commandes rejouée dans chaque dépôt
   visé, le verdict venant des CODES DE SORTIE.

   La colonne SURVIT à la disparition de l'autre famille ('script' : un exécutable s'engageant
   sur un contrat JSON, retirée en 2.0). Les lignes héritées gardent donc leur valeur : elles
   restent visibles dans les réglages, marquées comme telles, et le serveur REFUSE de les
   lancer. Supprimer la colonne aurait effacé la distinction — et avec elle la seule chose qui
   permet d'expliquer à quelqu'un pourquoi son vérificateur ne part plus.
   Le DÉFAUT reste 'script' : il ne s'applique qu'aux lignes créées avant cette migration, et
   le changer réécrirait leur histoire. Toute création passe par le serveur, qui impose
   'commands'. */
try { db.exec("ALTER TABLE verifier ADD COLUMN kind TEXT NOT NULL DEFAULT 'script'"); } catch { /* déjà présente */ }
/* « Automatique » : ce vérificateur part sur toute NOUVELLE merge request des dépôts qu'il
   couvre. Sur le vérificateur et non sur chaque ligne de couverture — automatique ici et
   manuel là est un besoin qu'on n'a pas, et la colonne se déplacera sans casser les données
   le jour où il apparaît. Défaut 0 : rien ne se met à tourner tout seul sans qu'on le demande. */
try { db.exec('ALTER TABLE verifier ADD COLUMN auto_on_mr INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
/* « Relancer quand le verdict se périme » : la MR a reçu de nouveaux commits, le vert obtenu
   sur l'ancien SHA ne vaut plus rien. Séparé de `auto_on_mr` — vérifier une MR à son arrivée et
   la revérifier à chaque poussée sont deux appétits différents : la seconde multiplie la charge
   par le nombre de commits, et c'est un choix qui doit s'assumer ligne par ligne. */
try { db.exec('ALTER TABLE verifier ADD COLUMN auto_on_stale INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
/* Le gabarit du commentaire publié sur la merge request. Vide = le gabarit par défaut, qui vit
   dans `verify.js` — on ne le recopie PAS en base : un défaut recopié se fige, et l'améliorer
   n'atteindrait plus personne. */
try { db.exec("ALTER TABLE verifier ADD COLUMN comment_template TEXT DEFAULT ''"); } catch { /* déjà présente */ }
/* Les personnes à prévenir quand ça casse — du texte libre repris tel quel dans le commentaire
   (`@amady @bruno`, ou `@mon-groupe`, plus robuste qu'une liste qui bouge). C'est la FORGE qui
   résout les mentions et envoie les mails ; Mergerie ne fait que les écrire. Un identifiant
   numérique ne marche pas : GitLab résout le handle, pas l'id. */
try { db.exec("ALTER TABLE verifier ADD COLUMN mentions TEXT DEFAULT ''"); } catch { /* déjà présente */ }
// Ajoutées à l'environnement minimal. Sans elles, un `npm` installé par nvm reste introuvable
// quand Mergerie est lancé par un service plutôt que depuis un terminal.
try { db.exec('ALTER TABLE verifier ADD COLUMN env_json TEXT'); } catch { /* déjà présente */ }
/* LES NOMS SONT D'ÉQUIPE, LES VALEURS NON. Une variable de commande de test est le lieu naturel
   d'un `DATABASE_URL` ou d'un `NPM_TOKEN`, et la liste noire du registre ne regarde que le NOM DE
   COLONNE — `env_json` n'y ressemble pas, donc rien ne l'arrêtait. Le vérificateur reste un
   produit d'équipe : on partage les NOMS qu'il attend, pour que le collègue sache quoi
   renseigner, et les valeurs vivent dans `local_state` sur le poste qui les a saisies.
   `env_json` est donc VIDÉE puis GELÉE, comme les jetons de `config`. */
try { db.exec('ALTER TABLE verifier ADD COLUMN env_keys TEXT'); } catch { /* déjà présente */ }
// Rapport JUnit produit par les commandes (chemin RELATIF au dépôt testé) : donne les noms
// des tests là où la sortie ne les livre pas, et sans subir la troncature du journal.
try { db.exec('ALTER TABLE verifier ADD COLUMN report_path TEXT'); } catch { /* déjà présente */ }
// Interpréter le TAP trouvé dans la sortie. Activé par défaut ; l'interrupteur existe pour
// le jour où une sortie exotique déclenche la détection à tort.
try { db.exec('ALTER TABLE verifier ADD COLUMN parse_tap INTEGER NOT NULL DEFAULT 1'); } catch { /* déjà présente */ }

/* Les commandes d'un vérificateur 'commands', DANS L'ORDRE. Une table plutôt qu'une colonne
   JSON : l'ordre est porteur de sens (`npm ci` avant `npm test`) et l'interface les édite
   une par une. */
db.exec(`CREATE TABLE IF NOT EXISTS verifier_command (
  verifier_id INTEGER NOT NULL REFERENCES verifier(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  command TEXT NOT NULL,
  PRIMARY KEY (verifier_id, position)
)`);

/* Couverture DÉCLARATIVE : quels dépôts ce vérificateur sait tester, et comment. Déclarer
   n'est pas exécuter — un dépôt couvert hors du lot ne sert qu'à consigner le contexte. */
db.exec(`CREATE TABLE IF NOT EXISTS verifier_repo (
  verifier_id INTEGER NOT NULL REFERENCES verifier(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('worktree','in_place')),
  workdir TEXT,                        -- requis en in_place (chemin absolu de l'utilisateur)
  checkout_allowed INTEGER NOT NULL DEFAULT 0,  -- consentement explicite : on va y faire un checkout
  PRIMARY KEY (verifier_id, repo_id)
)`);

// Un lot = des MR (ou des sessions) vérifiées ensemble, parce qu'elles ne valent qu'ensemble.
db.exec(`CREATE TABLE IF NOT EXISTS lot (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mr','session')),
  created_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS lot_member (
  lot_id INTEGER NOT NULL REFERENCES lot(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mr','task')),
  ref_id INTEGER NOT NULL,
  PRIMARY KEY (lot_id, kind, ref_id)
)`);

/* Un rapport de vérification est une ARCHIVE : il dit ce qui a été testé, quand, et avec quel
   verdict. Supprimer le vérificateur ou le lot ne doit donc ni effacer les verdicts déjà
   rendus, ni — pire — être refusé à cause d'eux. Les noms sont recopiés à la création et les
   clés étrangères se détachent. */
db.exec(`CREATE TABLE IF NOT EXISTS verification (
  id INTEGER PRIMARY KEY,
  verifier_id INTEGER REFERENCES verifier(id) ON DELETE SET NULL,
  verifier_name TEXT NOT NULL DEFAULT '',
  lot_id INTEGER REFERENCES lot(id) ON DELETE SET NULL,  -- NULL = MR seule (lot implicite)
  lot_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  verdict TEXT CHECK (verdict IN ('verified_pass','verified_fail','broken_base','verify_error')),
  targets_json TEXT NOT NULL,          -- [{repo_id, mr_id, head_sha, base_sha, branch, mode}]
  context_json TEXT,                   -- dépôts couverts hors lot : sha/branche/dirty constatés
  base_run_json TEXT,
  head_run_json TEXT,
  imputable_json TEXT,                 -- failed(head) − failed(base)
  log_excerpt TEXT,
  started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_verification_lot ON verification(lot_id, id)');
/* Échec de restauration d'un répertoire « in place » : signalé de façon PERSISTANTE, jamais
   noyé dans un journal. Le dépôt de l'utilisateur est resté sur un commit détaché. */
try { db.exec('ALTER TABLE verification ADD COLUMN restore_error TEXT'); } catch { /* déjà présente */ }
/* Partie TOUTE SEULE (découverte), sans que personne ne l'ait lancée : ses commandes tournent
   alors avec un `HOME` jetable — ni `~/.ssh`, ni `~/.npmrc`, ni `~/.aws` à portée du code de la
   branche. Locale : un poste qui relit l'archive n'a rien à en faire. */
try { db.exec('ALTER TABLE verification ADD COLUMN automatic INTEGER DEFAULT 0'); } catch { /* déjà présente */ }
/* Ce qui a été PUBLIÉ, et quand. Sans cette trace, l'écran repropose « Publier » comme si de
   rien n'était et on poste deux fois le même verdict sur la merge request de quelqu'un. */
try { db.exec('ALTER TABLE verification ADD COLUMN comment_posted_at TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE verification ADD COLUMN comment_targets TEXT'); } catch { /* déjà présente */ }

/* Bases créées avant que le rapport ne devienne une archive : la table portait des clés
   étrangères bloquantes vers `verifier` et `lot`. SQLite ne sait pas modifier une contrainte,
   il faut rebâtir — en recopiant au passage les noms depuis les lignes encore présentes. */
if (!db.prepare('PRAGMA table_info(verification)').all().some((c) => c.name === 'verifier_name')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE verification_new (
    id INTEGER PRIMARY KEY,
    verifier_id INTEGER REFERENCES verifier(id) ON DELETE SET NULL,
    verifier_name TEXT NOT NULL DEFAULT '',
    lot_id INTEGER REFERENCES lot(id) ON DELETE SET NULL,
    lot_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
    verdict TEXT CHECK (verdict IN ('verified_pass','verified_fail','broken_base','verify_error')),
    targets_json TEXT NOT NULL,
    context_json TEXT,
    base_run_json TEXT,
    head_run_json TEXT,
    imputable_json TEXT,
    log_excerpt TEXT,
    started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
    restore_error TEXT
  );
  INSERT INTO verification_new
    SELECT id, verifier_id,
      COALESCE((SELECT name FROM verifier WHERE verifier.id = verification.verifier_id), ''),
      lot_id, (SELECT name FROM lot WHERE lot.id = verification.lot_id),
      status, verdict, targets_json, context_json, base_run_json, head_run_json,
      imputable_json, log_excerpt, started_at, finished_at, created_at, restore_error
    FROM verification;
  DROP TABLE verification;
  ALTER TABLE verification_new RENAME TO verification;
  CREATE INDEX IF NOT EXISTS idx_verification_lot ON verification(lot_id, id);`);
  db.pragma('foreign_keys = ON');
}

/* Le run BASE était mis en cache par jeu de SHAs. Supprimé : le cache pariait sur un
   environnement inchangé — ce que Mergerie ne peut pas vérifier —, et le pari se payait des
   deux côtés (un rouge corrigé hors git restait collé, un vert périmé faisait accuser la
   branche à tort). La table ne contenait que ce cache : rien à conserver. */
try { db.exec('DROP TABLE IF EXISTS verification_run_cache'); } catch { /* déjà absente */ }

db.exec(`CREATE TABLE IF NOT EXISTS convergence_run (
  id INTEGER PRIMARY KEY,
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  status TEXT NOT NULL,            -- running | converged | capped | regressed | no_change | error | stopped
  threshold REAL NOT NULL,         -- cible en /10
  max_passes INTEGER NOT NULL,
  passes_done INTEGER DEFAULT 0,   -- nombre de corrections appliquées
  start_note REAL,                 -- note /10 de départ
  best_note REAL,                  -- meilleure note /10 atteinte
  best_version INTEGER,            -- version review_version correspondante
  message TEXT,
  started_at TEXT,
  finished_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_convergence_run_mr ON convergence_run(mr_id)');
