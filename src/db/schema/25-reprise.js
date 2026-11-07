'use strict';
/* REPRENDRE LA SESSION D'UN COLLÈGUE SUR CE POSTE — la filiation d'une reprise.
 *
 * Une session reçue du dépôt de données partagé se LIT : le handle d'agent, le clone et les
 * suivis sont sur l'autre poste. « Reprendre sur ce poste » crée une session NEUVE, à moi, qui
 * repart de la branche telle qu'elle est sur la forge et dont l'agent reçoit tout l'historique
 * de la session d'origine, tel quel, suivi de ma consigne. Deux colonnes disent d'où elle vient :
 * l'uid de la session d'origine et celui de la cible reprise. Elles voyagent dans `session.json`
 * (`resumed_from`, `resumed_target`) pour que la carte d'origine, chez tout le monde, affiche
 * « reprise par … » — un lien calculé à l'affichage, jamais écrit sur la session d'origine, qui
 * reste intouchée. Des uid, rien de sensible. */
const db = require('../connexion');

try { db.exec('ALTER TABLE task ADD COLUMN resumed_from_uid TEXT'); } catch { /* déjà présente */ }
try { db.exec('ALTER TABLE task ADD COLUMN resumed_target_uid TEXT'); } catch { /* déjà présente */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_task_resumed_from ON task(resumed_from_uid)');
