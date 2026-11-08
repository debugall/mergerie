'use strict';
/* LES TESTS TOUCHÉS PAR UNE MERGE REQUEST — « 14 fichiers · 0 test » sur la carte, avant la review.
 *
 * Aucune donnée relevée de plus : la classification se calcule à l'affichage sur `mr_files`
 * (tranche 20), par des MOTIFS de chemin. Un fichier est un test, ou neutre (documentation,
 * images, lockfiles, outillage), ou du code — le reste. Les motifs se résolvent dépôt → groupe(s)
 * → défaut global (`config`), un niveau rempli remplaçant celui du dessus ; vides, les défauts
 * livrés (`src/review/tests-touches.js`) valent. Un motif qui change doit changer le badge sans
 * attendre un relevé : c'est pourquoi rien n'est stocké.
 *
 * Les colonnes de `repo_group` et de `config` sont d'équipe (registre) ; celles de `repo` suivent
 * la ligne du dépôt, qui est de CE poste. */
const db = require('../connexion');

try { db.exec("ALTER TABLE config ADD COLUMN tests_touched_enabled TEXT DEFAULT '1'"); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN tests_touched_min_code INTEGER DEFAULT 3'); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN test_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE config ADD COLUMN neutral_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo_group ADD COLUMN test_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo_group ADD COLUMN neutral_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo ADD COLUMN test_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
try { db.exec("ALTER TABLE repo ADD COLUMN neutral_patterns TEXT DEFAULT ''"); } catch { /* déjà présente */ }
