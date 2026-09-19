'use strict';
/* Ce qui se passe quand une session finit : le suivi automatique, la question devenue todo, la vérification qui s’enchaîne.
   Extrait de jobs.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const path = require('node:path');
const db = require('../db');
const notes = require('../notes/notes');
const { t } = require('../core/i18n');
const { verifyBloquePar } = require('./file');
const { startAskJob, startLocalJob, startTaskJob, startVerifyJob } = require('./ordonnanceur');

// Exécute un job de type "task" (run / followup / push) avec log en direct.
/* UNE VÉRIFICATION, UNE FOIS, À LA FIN. Le vérificateur d'une session se déclenche tout seul —
   c'est tout l'intérêt : on lance la session le matin et on trouve un verdict, pas une case à
   cocher de plus.

   Trois refus délibérés, tous silencieux pour la session mais DITS dans son journal :

   — SANS COMMIT POUSSÉ, rien à vérifier. Un vérificateur travaille sur du code accessible depuis
     la forge ; c'est la raison pour laquelle choisir un vérificateur coche l'auto-push.
   — SI LE VÉRIFICATEUR NE COUVRE PAS TOUS LES DÉPÔTS de la session, on ne lance pas. Un vert
     partiel ne dit rien de la moitié du lot — pire qu'une absence de verdict.
   — UN ÉCHEC ICI NE FAIT PAS ÉCHOUER LA SESSION. Le code est écrit et poussé ; annoncer la
     session en erreur parce que la vérification n'a pas pu démarrer serait mentir sur ce qui
     s'est passé. */
/* La DÉCISION est séparée du lancement : elle se raconte (« pourquoi ça n'est pas parti ») et
   s'éprouve sans monter d'environnement ni lancer le moindre process. */
function preparerVerificationApres(task) {
  if (!task || !task.verifier_id) return { raison: null };
  const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(task.verifier_id);
  if (!verifier) return { raison: 'le vérificateur choisi n’existe plus' };

  const cibles = [];
  for (const tg of db.prepare('SELECT * FROM task_target WHERE task_id = ? ORDER BY id').all(task.id)) {
    if (!tg.commit_sha) continue;                       // rien n'a été produit pour ce projet
    if (cibles.some((c) => c.repo_id === tg.repo_id)) continue;   // un dépôt, une cible
    const mr = tg.mr_iid
      ? db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, tg.mr_iid)
      : null;
    cibles.push({
      repo_id: tg.repo_id, mr_id: mr ? mr.id : null, head_sha: tg.commit_sha,
      base_sha: `origin/${tg.base_branch || 'main'}`, branch: tg.branch, mode: 'worktree',
    });
  }
  if (!cibles.length) return { raison: 'rien de poussé' };

  const par = new Map(db.prepare('SELECT * FROM verifier_repo WHERE verifier_id = ?')
    .all(verifier.id).map((r) => [r.repo_id, r]));
  if (!cibles.every((c) => par.has(c.repo_id))) {
    return { raison: `« ${verifier.name} » ne couvre pas tous les dépôts de la session` };
  }
  if (verifyBloquePar(cibles.map((c) => c.repo_id))) {
    return { raison: 'une autre vérification tourne déjà sur ces dépôts' };
  }
  // Le mode de chaque cible est déclaré par le vérificateur, dépôt par dépôt.
  return {
    verifier,
    cibles: cibles.map((c) => {
      const l = par.get(c.repo_id);
      return { ...c, mode: (l && l.mode) || 'worktree', workdir: (l && l.workdir) || null };
    }),
  };
}
/* UNE SESSION QUI ATTEND UNE RÉPONSE POSE SA TODO. L'agent s'arrête, la file se libère, et
   plus rien ne repartira tant que personne n'aura répondu — sauf qu'on est passé à autre chose
   et que la notification est fermée depuis longtemps. La todo, elle, reste sous les yeux dans
   l'onglet Notes et dans le brief du matin.

   Une todo par SESSION, pas par projet : cinq questions sur cinq dépôts d'une même session sont
   un seul geste à poser dans sa journée, et cinq lignes identiques ne diraient rien de plus. */
/* La même todo, pour une session hors dépôt. Le `kind` DIFFÈRE de celui des sessions sur
   dépôt : les deux tables ont leurs propres identifiants, et `session_question:3` désignerait
   sinon deux sessions différentes — celle qu'on referme ne serait pas celle qui attend. */
function todoQuestionLocal(taskId) {
  const tache = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!tache) return;
  const dossiers = db.prepare("SELECT path FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'")
    .all(taskId).map((d) => d.path);
  if (!dossiers.length) return;
  const quoi = (tache.label || tache.prompt || '').split('\n')[0].slice(0, 80);
  try {
    notes.todoAuto('local_question', taskId,
      `Répondre à l'IA — session hors dépôt #${taskId}${quoi ? ` : ${quoi}` : ''}`,
      `L'agent attend une réponse sur : ${dossiers.join(', ')}.`);
  } catch { /* une todo qu'on n'a pas pu poser ne doit pas faire échouer la session */ }
}
function todoQuestion(taskId) {
  const tache = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  if (!tache) return;
  const cibles = db.prepare(`SELECT r.project FROM task_target tt JOIN repo r ON r.id = tt.repo_id
    WHERE tt.task_id = ? AND tt.status = 'needs_input'`).all(taskId).map((x) => x.project);
  if (!cibles.length) return;
  const quoi = (tache.label || tache.prompt || '').split('\n')[0].slice(0, 80);
  try {
    notes.todoAuto('session_question', taskId,
      `Répondre à l'IA — session #${taskId}${quoi ? ` : ${quoi}` : ''}`,
      `L'agent attend une réponse sur : ${cibles.join(', ')}.`);
  } catch { /* une todo qu'on n'a pas pu poser ne doit pas faire échouer la session */ }
}
/* LE SUIVI AUTOMATIQUE — le seul endroit du code qui envoie un suivi sans qu'on ait cliqué.
   Par défaut un suivi attend un geste ; coché à l'écran, il part de lui-même dès que la session
   a fini de travailler.

   On le RETIRE avant de lancer, et on décoche. Sans ça, la passe de suivi se termine à son tour,
   retrouve le même texte armé, et la session repart en boucle jusqu'à épuisement du budget IA —
   c'est arrivé en test, en quelques secondes. Il part donc UNE fois ; en réécrire un est un
   geste conscient. Rien non plus après un échec : l'appelant ne passe ici que sur une fin
   normale, on n'enchaîne pas une consigne sur une session qui vient de casser. */
const TABLE_SCOPE = { local: 'local_task', ask: 'question', task: 'task' };
/* Le suivi en attente, envoyé sans clic. `exigerCase` : ne part que si la case « automatiquement »
   est cochée — c'est la fin de session. Une DATE programmée (`programmation.js`) passe outre :
   la date est l'armement, la case n'a plus à l'être. */
function envoyerSuiviEnAttente(scope, id, onLog, { exigerCase = true } = {}) {
  const table = TABLE_SCOPE[scope] || 'task';
  const s = db.prepare(`SELECT followup_draft d, followup_auto a FROM ${table} WHERE id = ?`).get(id);
  if (!s || !s.d || (exigerCase && !s.a)) return null;
  db.prepare(`UPDATE ${table} SET followup_draft = NULL, followup_auto = 0, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
  onLog(t('log.job.followup-sent', { texte: String(s.d).split('\n')[0].slice(0, 120) }));
  if (scope === 'local') return startLocalJob(id, { instruction: s.d });
  if (scope === 'ask') return startAskJob(id, { instruction: s.d });
  return startTaskJob(id, 'followup', { instruction: s.d, autoSuivi: true });
}
const suiviAutomatique = (scope, id, onLog) => envoyerSuiviEnAttente(scope, id, onLog, { exigerCase: true });
async function verifierApresSession(task, onLog) {
  if (!task || !task.verifier_id) return null;
  try {
    const d = preparerVerificationApres(task);
    if (!d.verifier) { onLog(t('log.job.verify-skipped', { raison: d.raison })); return null; }
    const info = db.prepare(`INSERT INTO verification
      (verifier_id, verifier_name, lot_id, lot_name, status, targets_json, created_at)
      VALUES (?, ?, NULL, NULL, 'queued', ?, ?)`)
      .run(d.verifier.id, d.verifier.name, JSON.stringify(d.cibles), new Date().toISOString());
    startVerifyJob(info.lastInsertRowid);
    onLog(t('log.job.verify-started', { name: d.verifier.name, n: d.cibles.length, count: d.cibles.length }));
    return info.lastInsertRowid;
  } catch (e) {
    onLog(t('log.job.verify-skipped', { raison: e.message }));
    return null;
  }
}

module.exports = {
  preparerVerificationApres, todoQuestionLocal, todoQuestion, TABLE_SCOPE, suiviAutomatique, envoyerSuiviEnAttente, verifierApresSession,
};
