'use strict';
/* L’exécutant des actions Docker.
   Extrait de jobs.js (refacto.md, étape 4) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const proc = require('../../core/proc');
const docker = require('../../integrations/docker');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

async function runDockerJob(jobId, payload) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    if (payload.op === 'compose') {
      if (payload.action === 'down') await docker.runDown(payload.dir, onLog);
      else await docker.runCompose(payload.dir, payload.action, payload.services, onLog);
    } else if (payload.op === 'compose-bulk') {
      // Action groupée : un projet après l'autre ; un échec n'interrompt pas les suivants.
      const groups = payload.groups || [];
      setJob(jobId, { total: groups.length });
      const fails = [];
      let done = 0;
      for (const g of groups) {
        onLog(`──────── ${g.dir} · ${g.services.join(', ')} ────────`);
        try { await docker.runCompose(g.dir, payload.action, g.services, onLog); }
        catch (e) { fails.push(g.dir); onLog(`⚠ ${docker.explainDockerError(e.message)}`); }
        done += 1; setJob(jobId, { done_count: done });
      }
      if (fails.length) throw new Error(t('err.job.group-failed', { n: fails.length, total: groups.length, liste: fails.join(', ') }));
    } else if (payload.op === 'orphan-remove') {
      await docker.removeContainer(payload.id, onLog);
    } else if (payload.op === 'orphan-stop') {
      await docker.stopContainer(payload.id, onLog);
    } else if (payload.op === 'orphan-restore') {
      /* A/Docker 1 — la sauvegarde était ÉCRITE avant chaque suppression et n'était relue par
         aucun écran : un container hors-compose supprimé par erreur était perdu, alors que de
         quoi le refaire dormait en base. */
      await docker.restoreContainer(payload.inspect, onLog);
    } else if (payload.op === 'make') {
      /* On NOTE la cible avant de la lancer et on complète à la fin : « ai-je déjà passé les
         migrations ce matin ? » se lit alors sous le bouton, sans relire un journal. Un échec
         est noté comme tel — savoir que ça a tourné ne dit pas que ça a marché. */
      const debut = new Date().toISOString();
      db.prepare(`INSERT INTO make_run (dir, target, started_at, finished_at, ok) VALUES (?,?,?,NULL,NULL)
        ON CONFLICT(dir, target) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, ok = NULL`)
        .run(payload.dir, payload.target, debut);
      try {
        await docker.runMake(payload.dir, payload.target, onLog);
        db.prepare('UPDATE make_run SET finished_at = ?, ok = 1 WHERE dir = ? AND target = ?')
          .run(new Date().toISOString(), payload.dir, payload.target);
      } catch (e) {
        db.prepare('UPDATE make_run SET finished_at = ?, ok = 0 WHERE dir = ? AND target = ?')
          .run(new Date().toISOString(), payload.dir, payload.target);
        throw e;
      }
    }
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
  } catch (e) {
    // Comme pour les opérations git : un Stop demandé n'est pas une erreur.
    if (proc.isCancelled()) {
      logLine(jobId, null, `⏹ ${t('job.msg.stopped-by-user')}`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: docker.explainDockerError(e.message) });
  }
}

enregistrer('docker', runDockerJob);

module.exports = {
  runDockerJob,
};
