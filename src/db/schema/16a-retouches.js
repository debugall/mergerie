'use strict';
/* LES RETOUCHES — « combien de défauts passent malgré un rapport au vert » (voir PLAN.md, « Retouches »).
 *
 * Une merge request B, mergée APRÈS A sur la même branche cible et dans une fenêtre de N jours, a
 * RÉÉCRIT du code que A avait introduit : un fait de git (`git blame` sur les lignes que B retire),
 * jamais un verdict de l'outil. `mr_fix_link` porte ce fait, une ligne par (A, B, signal) :
 *   `kind`     revert (B annule A) · rewrites (B réécrit N lignes de A) · reference (B cite A, indice
 *              seul) · manual (un humain a posé le lien)
 *   `lines`, `files`, `days` (délai entre les deux merges), `large` (réécriture large : exclue du
 *              chiffre), `detail` (les plages réécrites par fichier et les signaux, JSON — de quoi
 *              vérifier à la main avec `git blame -L`), `bug` (ce qui QUALIFIE la retouche, JSON :
 *              revert, ticket Bug, commit `fix:`, confirmation humaine — vide = retouche non tranchée)
 *   `fix_mr_id` = 0 et `fix_commit_sha` renseigné : un commit direct sur la cible, hotfix sans MR —
 *              le cas le plus grave, il ne disparaît pas parce qu'il n'a pas de carte.
 *   `status`, `status_by`, `status_at` : L'ARBITRAGE HUMAIN (`auto` · `confirmed` · `dismissed`),
 *              la seule part qui voyage dans le dépôt de données partagé ; un tour suivant ne les
 *              réécrit jamais, le reste se recalcule.
 * `mr_fix_scan` retient ce qui a déjà été analysé : une MR mergée par son SHA de merge (une fois,
 * jamais deux), une branche cible par sa dernière pointe lue (les commits directs).
 *
 * AVANT `17-store`, et c'est voulu : `mr_fix_link` est une liste FILLE de `mr` dans le registre des
 * familles, et la tranche du store pose sur chaque liste fille les déclencheurs qui marquent le
 * parent à réécrire — sur une table qui doit déjà exister. D'où ce `16a`, entre le slug et le store. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS mr_fix_link (
  origin_mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  fix_mr_id INTEGER NOT NULL DEFAULT 0,
  fix_commit_sha TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  days REAL,
  large INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  bug TEXT,
  computed_at TEXT,
  head_sha_b TEXT,
  status TEXT NOT NULL DEFAULT 'auto',
  status_by TEXT,
  status_at TEXT,
  PRIMARY KEY (origin_mr_id, fix_mr_id, fix_commit_sha, kind)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mr_fix_link_fix ON mr_fix_link (fix_mr_id, origin_mr_id)');

db.exec(`CREATE TABLE IF NOT EXISTS mr_fix_scan (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT,
  scanned_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (kind, ref)
)`);

/* Quatre réglages d'équipe (Réglages → Merge Request → Découverte) : l'interrupteur, la fenêtre en
   jours, le minimum de lignes réécrites pour un lien, le plafond de MR analysées par tour (0 = sans
   limite). Booléen en texte, comme `mr_files_enabled`. */
try { db.exec("ALTER TABLE config ADD COLUMN fix_links_enabled TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN fix_window_days INTEGER DEFAULT 30'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN fix_min_lines INTEGER DEFAULT 3'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN fix_links_max INTEGER DEFAULT 10'); } catch { /* déjà présente */ }

/* Le TYPE du ticket Jira d'une MR (Bug, Story…) et les tickets qu'il LIE (JSON, clés), rangés à la
   découverte avec son statut — zéro appel de plus, l'issue est déjà lue en entier. C'est ce qui
   qualifie une retouche : « ticket Bug lié à celui de A ». */
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_type TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE mr ADD COLUMN ticket_jira_links TEXT'); } catch { /* déjà présente */ }
