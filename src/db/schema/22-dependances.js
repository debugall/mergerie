'use strict';
/* LES DÉPENDANCES AJOUTÉES PAR UNE MERGE REQUEST — « +2 dépendances » sur la carte, avant la review.
 *
 * La donnée existait et était jetée : les appels du relevé des fichiers (tranche 20) rapportent le
 * diff de chaque fichier, dont on ne gardait que les chemins. On garde désormais, dans le même
 * geste et sans un appel de plus, le diff des seuls MANIFESTES (`package.json`, `go.mod`,
 * `pom.xml`… — des motifs de chemin, réglables comme ceux des tests touchés) : `mr_manifest_diff`,
 * une ligne par manifeste touché, sur le SHA de tête. L'analyse (quelles lignes de dépendance
 * entrent, sortent, changent) se fait à l'affichage, jamais stockée (`src/review/dependances.js`).
 *
 * `mr_file_fetch.manifests` dit COMBIEN de manifestes le relevé a gardés — et surtout, NULL dit
 * qu'il ne les a pas cherchés (relevé antérieur à cette fonctionnalité, ou réglage décoché) : la
 * merge request n'affiche alors rien, jamais un faux « aucune dépendance », et le tour suivant la
 * reprend. `refused = 'too-large'` : un diff de manifeste de plus de 200 Ko n'est pas gardé.
 *
 * Famille C du registre (relu de la forge), purgé avec les listes de fichiers. */
const db = require('../connexion');

db.exec(`CREATE TABLE IF NOT EXISTS mr_manifest_diff (
  mr_id INTEGER NOT NULL REFERENCES mr(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  head_sha TEXT,
  diff TEXT,
  fetched_at TEXT NOT NULL,
  refused TEXT,
  PRIMARY KEY (mr_id, path)
)`);
try { db.exec('ALTER TABLE mr_file_fetch ADD COLUMN manifests INTEGER'); } catch { /* déjà présente */ }

/* Deux réglages d'équipe (Réglages → Merge Request → Découverte, sous les tests touchés) : l'interrupteur
   et les motifs de manifestes, un glob par ligne, vides = les défauts livrés. Les motifs se posent
   aussi sur un groupe (d'équipe) et sur un dépôt (de poste), avec la même résolution que les tests. */
try { db.exec("ALTER TABLE config ADD COLUMN deps_enabled TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN manifest_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo_group ADD COLUMN manifest_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo ADD COLUMN manifest_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
