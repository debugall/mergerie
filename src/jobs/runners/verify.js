'use strict';
/* L’exécutant d’une vérification objective.
   Extrait de jobs.js (refacto.md, étape 4) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const notify = require('../../core/notify');
const verifyrun = require('../../verify/verifyrun');
const { getConfig, updateConfig } = require('../../data/config');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

async function runVerifyJob(jobId, verificationId) {
  /* Comme tout job qui démarre : sans ce passage en `running`, la ligne reste « en file »
     pendant toute l'exécution — le panneau de log, le compteur de la file et l'état du
     favicon annoncent alors une attente là où une suite de tests est en train de tourner. */
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  logLine(jobId, null, t('log.job.verify-start', { id: verificationId }));
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    const verdict = await verifyrun.executerVerification(verificationId, getConfig(), onLog);
    /* Commentaire sur la forge : opt-in par vérificateur (§5.6). Il ne peut pas remettre le
       verdict en cause — une forge injoignable ne transforme pas un résultat acquis en échec,
       d'où le `catch` qui se contente de le dire dans le journal. Mais il a lieu AVANT que le
       job ne se déclare fini : « terminé » doit vouloir dire que tout est fait. */
    try { await verifyrun.commenterSurForge(verificationId, getConfig(), onLog); }
    catch (e) { logLine(jobId, null, `commentaire sur la forge impossible : ${e.message}`); }
    /* B10 — et le ticket, quand l'option est cochée. Même prudence : Jira injoignable ne
       transforme pas un verdict acquis en échec de job. */
    try { await verifyrun.commenterSurJira(verificationId, getConfig(), onLog); }
    catch (e) { logLine(jobId, null, `commentaire Jira impossible : ${e.message}`); }
    // B12 — le verdict laisse une trace qui survit à la notification : une todo par MR.
    try { verifyrun.todosDuVerdict(verificationId, verdict); }
    catch (e) { logLine(jobId, null, `todo de verdict impossible : ${e.message}`); }
    // Un verdict rouge n'est PAS une erreur de job : le job a parfaitement fait son travail.
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
    logLine(jobId, null, t('log.job.verify-end', { verdict }));
    notify.push('verify_done', { verification_id: verificationId, verdict });
  } catch (e) {
    logLine(jobId, null, t('log.job.verify-error', { message: e.message }));
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
    db.prepare("UPDATE verification SET status = 'error', verdict = 'verify_error', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), verificationId);
    notify.push('verify_done', { verification_id: verificationId, verdict: 'verify_error' });
  }
}

enregistrer('verify', runVerifyJob);

module.exports = {
  runVerifyJob,
};
