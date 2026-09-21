'use strict';
/* L’historique des passes d’agent, les pièces jointes d’une session, et le partage d’une session entre collègues.
   Tranche de l'ancien db.js (réorganisation de src/ par couches), jouée à sa place dans l'ordre de `index.js` :
   un ALTER y suit toujours le CREATE qu'il retouche, comme avant. */
const db = require('../connexion');

/* HISTORIQUE DES PASSES d'agent — une ligne par itération, pour une session sur dépôt
   comme pour un codage hors dépôt. Même esprit que `review_version` : chaque passe écrit
   son propre fichier (`output-v<N>.md`) au lieu d'écraser le précédent, et la colonne
   `output_path` de l'unité continue de pointer la DERNIÈRE — le reste de l'app n'a rien
   à changer. On garde le PROMPT réellement envoyé : sans lui, relire un retour d'IA
   trois itérations plus tard ne dit pas à quoi il répondait.

   Une seule table pour les deux familles (`scope`), plutôt que deux tables jumelles :
   le serveur et l'interface n'ont ainsi qu'une implémentation. Contrepartie assumée :
   pas de clé étrangère possible (deux tables parentes), donc les suppressions de session
   nettoient explicitement cette table. */
db.exec(`CREATE TABLE IF NOT EXISTS agent_pass (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,          -- 'task' (session sur dépôt) | 'local' (hors dépôt)
  task_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,     -- task_target.id | local_task_dir.id
  n INTEGER NOT NULL,           -- numéro de passe, par unité
  kind TEXT,                    -- run | followup | answer | converge-fix
  prompt TEXT,                  -- ce qui a RÉELLEMENT été envoyé à l'agent
  output_path TEXT,             -- retour de l'agent pour cette passe
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_agent_pass_unit ON agent_pass(scope, task_id, unit_id, n)');

/* REPÉRER UNE ITÉRATION PARMI VINGT. Le numéro et la date ne disent rien de ce qui s'y est
   joué : on marque donc les quelques passes qui comptent (`favori`) et on leur donne un nom
   (`titre`). Ni l'un ni l'autre ne part à l'agent — c'est du rangement, écrit pour l'humain
   qui parcourt la colonne. Migrations APRÈS le `CREATE TABLE` : plus haut, l'ALTER échoue sur
   une table absente et le `catch` l'avale sans un mot. */
try { db.exec('ALTER TABLE agent_pass ADD COLUMN favori INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE agent_pass ADD COLUMN titre TEXT'); } catch { /* déjà présente */ }
/* COÛT RÉEL D'UNE PASSE, en dollars, quand le backend le donne (`result.total_cost_usd` du
   flux `claude`). L'estimation en tokens reste : elle couvre les backends qui ne disent rien.
   Nulle sur toute passe antérieure, et sur tout backend muet — l'affichage doit le supporter. */
try { db.exec('ALTER TABLE agent_pass ADD COLUMN cost_usd REAL'); } catch { /* déjà présente */ }
/* TOKENS D'UNE PASSE, comme `usage.tokens_est` : le même comptage (prompt envoyé + retour de
   l'agent), mais par ITÉRATION plutôt que pour toute la session — la colonne « Retour de l'IA »
   affichait un coût en dollars par passe alors que le dollar n'est jamais garanti (backend
   muet) ; le nombre de tokens, lui, se calcule toujours. Nul sur toute passe antérieure à
   cette mesure — l'affichage doit le supporter. */
try { db.exec('ALTER TABLE agent_pass ADD COLUMN tokens_est INTEGER'); } catch { /* déjà présente */ }
/* LE DIFF D'UNE SEULE ITÉRATION. Relire une session de codage revenait à relire TOUT le diff
   de la branche à chaque suivi : la correction de trois lignes qu'on vient de demander se
   cherchait au milieu de deux cents. On retient donc les deux bornes de la passe — le HEAD
   avant qu'elle ne commence, celui qu'elle laisse — et le patch qui les sépare. Nulles sur
   toute passe antérieure, sur une passe qui n'a rien commité (l'agent a posé des questions) et
   sur tout le hors-dépôt, qui n'a pas de git : l'affichage doit le supporter.
   `head_sha` sans `diff_path` n'est pas une anomalie : c'est une itération qui n'a rien changé
   au code, et le dire vaut mieux qu'ouvrir une vue vide. */
try { db.exec('ALTER TABLE agent_pass ADD COLUMN base_sha TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE agent_pass ADD COLUMN head_sha TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE agent_pass ADD COLUMN diff_path TEXT'); } catch { /* déjà présente */ }
/* APRÈS la création de la table, et pas avant : un `ALTER` posé plus haut dans ce fichier
   échoue sur une table qui n'existe pas encore, et le `catch` l'avale sans un mot. La colonne
   n'apparaît alors que sur les bases où la table préexistait — le genre de différence qui ne
   se voit qu'en production. */
try { db.exec('ALTER TABLE local_task ADD COLUMN label TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN followup_draft TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN followup_auto INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* UNE SESSION EST UN PROCESSUS, PAS UN PRODUIT — et elle se partage donc UNE PAR UNE.
 *
 * Ce qu'une session porte, c'est la façon dont quelqu'un a travaillé : le prompt tel qu'il l'a
 * tapé, ses trois relances, la question qu'il n'osait poser à personne, la capture collée qui
 * montre un autre onglet, et le coût en dollars de chaque essai. Le RÉSULTAT, lui, est déjà
 * partagé par un autre canal — la branche et la merge request sur la forge, la carte du code,
 * la page de notes qu'un agent a produite. Partager le processus en bloc, c'est publier le
 * brouillon avec le livre.
 * Même mécanique que les pages de notes, et pas une seconde : une colonne `shared`, `DEFAULT 0`,
 * et le registre qui décide ligne par ligne. Les sessions déjà écrites deviennent donc privées,
 * et leurs fichiers SORTENT du dépôt au premier démarrage (repère `sessions_unshared_swept`).
 * Migrations APRÈS les `CREATE TABLE` correspondants. */
try { db.exec('ALTER TABLE task ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE local_task ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE question ADD COLUMN shared INTEGER NOT NULL DEFAULT 0'); } catch { /* déjà présente */ }

/* LES PIÈCES JOINTES D'UNE SESSION — captures ET documents, une seule table.
 *
 * Une capture d'écran et un PDF de spécification sont la même chose pour l'agent : un fichier
 * à ouvrir. Les tenir dans deux familles de tables aurait fait deux enregistrements, deux
 * lectures, deux blocs de prompt et quatre saveurs à recâbler à chaque fois — pour une
 * distinction qui ne compte qu'à l'affichage (vignette ou nom de fichier).
 *
 * `scope` distingue les familles, comme `agent_pass` : 'task' (codage sur dépôt et
 * exploration), 'local' (hors dépôt), 'ask' (question libre). Pas de clé étrangère possible —
 * trois tables parentes — donc le ménage est explicite à la suppression.
 *
 * `name` est le nom D'ORIGINE, montré à l'écran et donné à l'agent ; le fichier sur disque, lui,
 * porte un nom fabriqué : un nom venu de l'extérieur n'a rien à faire dans un chemin. */
db.exec(`CREATE TABLE IF NOT EXISTS piece_jointe (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  followup INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_piece_jointe_owner ON piece_jointe(scope, owner_id)');

/* Reprise des captures déjà en base. Les deux anciennes tables sont recopiées puis RETIRÉES :
   laisser une table morte derrière soi, c'est garantir qu'un jour quelqu'un l'interrogera et
   lira un état d'il y a six mois. Les fichiers sur disque, eux, ne bougent pas — seule la ligne
   change de table. Idempotent : la table disparue, la reprise ne se pose plus. */
for (const [ancienne, scope] of [['task_image', 'task'], ['local_task_image', 'local']]) {
  try {
    const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(ancienne);
    if (!existe) continue;
    /* `followup` est arrivée en cours de route : une base plus ancienne ne l'a pas, et le
       SELECT échouerait dessus. On lit les colonnes réellement présentes plutôt que d'ajouter
       une colonne à une table qu'on s'apprête à supprimer. */
    const colonnes = db.prepare(`PRAGMA table_info(${ancienne})`).all().map((c) => c.name);
    const suivi = colonnes.includes('followup') ? 'followup' : '0';
    db.exec(`INSERT INTO piece_jointe (scope, owner_id, path, name, mime, followup, created_at)
      SELECT '${scope}', task_id, path, path, NULL, ${suivi}, NULL FROM ${ancienne}`);
    db.exec(`DROP TABLE ${ancienne}`);
    /* Le nom affiché est le nom de FICHIER, pas le chemin : ces captures-là n'en avaient pas
       d'autre (elles étaient collées, sans nom d'origine), et montrer `/Users/…/img_3.png`
       dans une puce de formulaire n'apprend rien. */
    const majNom = db.prepare('UPDATE piece_jointe SET name = ? WHERE id = ?');
    for (const l of db.prepare("SELECT id, name FROM piece_jointe WHERE scope = ? AND name LIKE '%/%'").all(scope)) {
      majNom.run(l.name.split('/').filter(Boolean).pop() || l.name, l.id);
    }
  } catch { /* reprise best-effort : une capture perdue ne doit pas empêcher l'app de démarrer */ }
}

/* « Répertoires locaux » : un dossier de la machine contenant un sous-dossier par
   projet git déjà cloné à la main (~/dev). Sert à l'onglet Git → Navigation et au
   choix du dossier de travail du codage hors dépôt. On ne stocke QUE la racine :
   la liste des projets se relit du disque à chaque fois, sinon un projet cloné ou
   supprimé entre deux ouvertures d'écran n'existerait que dans la base. */
