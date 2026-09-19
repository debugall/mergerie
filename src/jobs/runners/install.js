'use strict';
/* L’exécutant de l’installation du moteur de dictée.
   Extrait de jobs.js (refacto.md, étape 4) : les corps sont ceux d'origine, au mot près. */
const proc = require('../../core/proc');
const git = require('../../git/git');            // `run` : spawn générique, journal ligne à ligne, Stop câblé
const { DATA_DIR } = require('../../core/paths');
const { getConfig, updateConfig } = require('../../data/config');
const { t } = require('../../core/i18n');
const { enregistrer, logLine, setJob } = require('../file');

async function runInstallJob(jobId, payload) {
  setJob(jobId, { status: 'running', total: 1, done_count: 0, started_at: new Date().toISOString(), message: t('job.msg.starting') });
  const onLog = (msg) => { logLine(jobId, null, msg); setJob(jobId, { message: String(msg).slice(0, 180) }); };
  try {
    // eslint-disable-next-line global-require
    const dictation = require('../../integrations/dictation');
    // La dictée est SUSPENDUE le temps de l'installation : le binaire est en train d'être
    // remplacé sous les pieds du moteur qui tourne.
    dictation.arreterMoteur();
    const prep = dictation.scriptSansCR(dictation.commandeInstallation(payload));
    if (prep.normalise) onLog(t('log.dictation.crlf', { script: prep.origine }));
    const cmd = prep.cmd;
    const { stdout } = await git.run(cmd.programme, cmd.args, {
      env: dictation.envInstallation(DATA_DIR), onLog,
    });
    const res = dictation.lireResultatInstallation(stdout);
    if (!res) throw new Error(t('err.dictation.resultat'));
    const patch = dictation.reglagesDepuisResultat(res);
    updateConfig(patch, { installation: true });   // le chemin que l'installation vient de poser
    onLog(t('log.dictation.settings-filled', {
      modele: patch.dictation_model,
      backend: res.backend || 'CPU',
    }));
    setJob(jobId, { status: 'done', done_count: 1, finished_at: new Date().toISOString(), message: '' });
  } catch (e) {
    // Comme partout : un Stop demandé n'est pas une erreur.
    if (proc.isCancelled()) {
      logLine(jobId, null, `⏹ ${t('job.msg.stopped-by-user')}`);
      setJob(jobId, { status: 'stopped', finished_at: new Date().toISOString(), message: '' });
      return;
    }
    setJob(jobId, { status: 'error', finished_at: new Date().toISOString(), message: e.message });
  }
}

enregistrer('install', runInstallJob);

module.exports = {
  runInstallJob,
};
