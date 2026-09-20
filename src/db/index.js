'use strict';
/* LA BASE, PRÊTE À SERVIR. `require('../db')` rend la connexion SQLite, schéma créé et migrations
   jouées — comme l'ancien db.js d'une seule pièce, dont ceci est la table des matières.

   L'ORDRE EST LE SENS : chaque tranche de `schema/` est un morceau contigu de l'ancien fichier,
   jouée à la même place. Une migration lit ce que les tranches précédentes ont créé ; la
   réparation passe avant tout, la file d'export en dernier, et `npm run check` vérifie qu'un
   `ALTER` suit toujours le `CREATE` de sa table dans cet ordre. Une nouvelle table se crée dans la
   tranche de son domaine ; une colonne ajoutée à une table existante va dans la tranche qui a
   créé la table, ou dans une tranche ULTÉRIEURE — jamais avant. */
const db = require('./connexion');

require('./reparation');

const TRANCHES = [
  '01-noyau',
  '02-migrations-noyau',
  '03-jira-usage-make',
  '04-sessions',
  '05-passes-pieces',
  '06-depots-reviews-git',
  '07-verification',
  '08-liens',
  '09-notes',
  '10-jenkins-config',
  '11-dictee',
  '12-agents',
  '13-local-config',
  '14-identite',
  '15-local-state',
  '16-slug',
  '17-store',
  '18-sandbox',
];
for (const nom of TRANCHES) require(`./schema/${nom}`);
const { DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY } = require('./schema/10-jenkins-config');


// Au démarrage : tout job resté "running" a été coupé -> interrupted.
// Ce que ces jobs PORTAIENT (sessions, vérifications) est remis debout par
// `reconcilierTravauxCoupes`, appelée par le serveur une fois la langue posée.
db.prepare(`UPDATE job SET status = 'interrupted', finished_at = ?
            WHERE status IN ('running', 'queued')`).run(new Date().toISOString());

/* REMETTRE DEBOUT CE QUE L'ARRÊT A COUPÉ EN PLEIN VOL.
 *
 * Un job resté « running » n'existe plus : le processus est mort avec le serveur, et on vient
 * de le marquer `interrupted`. Mais le job n'était que le porteur — la SESSION, la tâche hors
 * dépôt ou la vérification qu'il faisait tourner, elles, restaient « running » pour toujours.
 * Or l'écran n'offre « Relancer » que sur `new`, `error`, `committed` ou `pushed` : une session
 * figée à « en cours » n'avait plus aucun bouton, ni pour repartir, ni pour s'arrêter — le job
 * à arrêter n'existait plus. L'outil se bloquait tout seul en s'arrêtant au mauvais moment.
 *
 * On les repose en `error`, avec la RAISON écrite noir sur blanc : « error » est un état d'où
 * l'on peut repartir, et le message évite de croire que l'IA a échoué alors que c'est le
 * serveur qui s'est arrêté. Ce qui avait déjà abouti n'est pas touché — les statuts par projet
 * (`committed`, `pushed`) portent le travail réellement fait.
 *
 * Appelée par le serveur APRÈS `i18n.setLang`, sinon le message sortirait toujours en français.
 * Renvoie ce qui a été repris, pour que le démarrage puisse le dire. */
function reconcilierTravauxCoupes(raison) {
  const maintenant = new Date().toISOString();
  const compte = { sessions: 0, projets: 0, horsDepot: 0, verifications: 0 };
  const maj = (sql, ...args) => { try { return db.prepare(sql).run(...args).changes; } catch { return 0; } };
  compte.sessions = maj(`UPDATE task SET status = 'error', last_error = ?, updated_at = ?
                         WHERE status = 'running'`, raison, maintenant);
  compte.projets = maj(`UPDATE task_target SET status = 'error', last_error = ?, updated_at = ?
                        WHERE status = 'running'`, raison, maintenant);
  compte.horsDepot = maj(`UPDATE local_task SET status = 'error', last_error = ?, updated_at = ?
                          WHERE status = 'running'`, raison, maintenant);
  /* Une vérification coupée n'a pas de verdict : `verify_error` est ce que pose déjà `jobs.js`
     quand son exécution échoue, et c'est lui qui rend la relance possible. */
  compte.verifications = maj(`UPDATE verification SET status = 'error', verdict = 'verify_error',
                              finished_at = ? WHERE status = 'running'`, maintenant);
  return compte;
}

/* UN NUMÉRO DE MERGE REQUEST EST UN ENTIER — et la base le garantit désormais à chaque
   démarrage. Les colonnes sont `INTEGER` mais pas `STRICT` : SQLite y acceptait un TEXTE, et un
   `iid` reçu par le dépôt partagé (`7<img onerror=…>`) finissait rendu tel quel à l'écran. L'import
   refuse maintenant ces documents ; ceci nettoie ce qu'une version d'avant aurait déjà accepté.
   `OR IGNORE` : deux lignes ramenées au même numéro violeraient l'unicité (dépôt, numéro) — la
   seconde garde alors sa valeur, et le rendu échappé la neutralise. */
for (const [table, col] of [['mr', 'iid'], ['task_target', 'mr_iid'], ['task_target', 'existing_mr_iid'], ['task', 'mr_iid']]) {
  try {
    db.exec(`UPDATE OR IGNORE ${table} SET ${col} = CAST(${col} AS INTEGER)
             WHERE ${col} IS NOT NULL AND typeof(${col}) <> 'integer'`);
  } catch { /* colonne absente d'une très vieille base : rien à normaliser */ }
}

module.exports = db;
module.exports.reconcilierTravauxCoupes = reconcilierTravauxCoupes;
module.exports.DEFAULTS = {
  DEFAULT_PROMPT_REVIEW, DEFAULT_PROMPT_EXPLAIN, DEFAULT_PROMPT_MODIFY,
};
