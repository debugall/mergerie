'use strict';
/* LA FILE DE JOBS, vue de l'extérieur : `require('../jobs')` rend la même interface que l'ancien
   jobs.js d'une seule pièce. Dedans, trois modules et un exécutant par sorte de job
   (refacto.md, étape 4) :
   — `file.js` : l'état de la file, le journal, les clés de conflit, le registre des exécutants ;
   — `ordonnanceur.js` : lancer, promouvoir, arrêter, rejouer, et les `start…Job` ;
   — `apres-session.js` : ce qui s'enchaîne quand une session finit ;
   — `runners/<sorte>.js` : l'exécutant d'une sorte de job, inscrit dans le registre au chargement.
   Charger les exécutants ICI est ce qui les inscrit : un exécutant absent de cette liste ne
   tournerait jamais, et `startJob` échouerait sur « RUNNERS[kind] is not a function ». */
const { exigerDossierCompose, startVerifyJob, startJob, startTaskJob, startGitJob, startDockerJob, startInstallJob, startConvergeJob, startConvergeSessionJob, startLocalJob, startAskJob, startReconcileJob, startNow, stopJob, isRunning, retryJob } = require('./ordonnanceur');
const { verifyBloquePar, currentJob, activeJob, runningJobs, queuedJobs, queueCount, parallelBusy, runningCount, MAX_RUNNING, jobKeys, keysClash, canRetry, jobTargets, runningTargets } = require('./file');
const { preparerVerificationApres } = require('./apres-session');
require('./runners/review');
require('./runners/task');
require('./runners/converge');
require('./runners/converge-session');
require('./runners/local');
require('./runners/ask');
require('./runners/gitops');
require('./runners/install');
require('./runners/docker');
require('./runners/reconcile');
require('./runners/verify');

module.exports = { exigerDossierCompose,
  startVerifyJob, verifyBloquePar, preparerVerificationApres,
  startJob, startTaskJob, startGitJob, startDockerJob, startInstallJob, startConvergeJob, startConvergeSessionJob,
  startLocalJob, startAskJob, startReconcileJob, startNow, stopJob, currentJob, activeJob, runningJobs, queuedJobs, isRunning,
  queueCount, parallelBusy, runningCount, MAX_RUNNING, jobKeys, keysClash, retryJob, canRetry,
  jobTargets, runningTargets,
};
