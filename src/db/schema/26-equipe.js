'use strict';
/* LA PAGE D'ÉQUIPE « NOTRE MATIN » — aucune table nouvelle : tout ce qu'elle montre est déjà dans la base,
   hydraté par le dépôt de données partagé (`src/notes/equipe.js`). Deux réglages d'équipe seulement
   (Réglages → Données partagées) : au-delà de combien de jours OUVRÉS sans commit dans le dépôt un
   poste est dit « silencieux » (2), et combien de jours une reprise terminée reste listée (7). Le seuil
   de décision est celui du brief (`converge_threshold`). */
const db = require('../connexion');

try { db.exec('ALTER TABLE config ADD COLUMN team_quiet_days INTEGER DEFAULT 2'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE config ADD COLUMN team_takeover_days INTEGER DEFAULT 7'); } catch { /* déjà présente */ }
