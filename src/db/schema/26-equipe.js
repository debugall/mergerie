'use strict';
/* LA PAGE D'ÉQUIPE « NOTRE MATIN » — aucune table nouvelle : tout ce qu'elle montre est déjà dans la base,
   hydraté par le dépôt de données partagé (`src/notes/equipe.js`). Un réglage d'équipe (Réglages →
   Données partagées) : au-delà de combien de jours OUVRÉS sans commit dans le dépôt un poste est dit
   « silencieux » (2). Le seuil de décision est celui du brief (`converge_threshold`).
   `team_takeover_days` a réglé la section « Reprises », retirée de la page avec son réglage : la colonne
   est RETIRÉE ci-dessous (comme `health_check` dans la tranche 12) — une base neuve ne l'a jamais, une
   base qui l'avait la perd, et le registre des réglages partagés n'a plus à la classer. */
const db = require('../connexion');

try { db.exec('ALTER TABLE config ADD COLUMN team_quiet_days INTEGER DEFAULT 2'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config DROP COLUMN team_takeover_days'); } catch { /* jamais ajoutée, ou déjà retirée */ }
