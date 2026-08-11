'use strict';
/* Données Jenkins STATIQUES pour le mode démo (MERGERIE_DEMO=1), sur le modèle de demo-docker.
   L'onglet Jenkins interroge un vrai serveur en direct ; hors-ligne il serait vide. Ici une
   installation fictive mais crédible : des dossiers, un job en cours, un rouge, un instable,
   un désactivé, et un job paramétré — c'est-à-dire chaque cas que l'écran doit savoir rendre.

   Lancer en démo ne lance rien : la réponse dit « mis en file », et la liste ne bouge pas. */

const isDemo = () => process.env.MERGERIE_DEMO === '1';
const ms = (min) => Date.now() - min * 60000;

const JOBS = [
  { path: 'boutique/api-build', name: 'api-build', statut: 'succes', enCours: false, buildable: true },
  { path: 'boutique/api-deploy-prod', name: 'api-deploy-prod', statut: 'succes', enCours: false, buildable: true },
  { path: 'boutique/front-build', name: 'front-build', statut: 'echec', enCours: false, buildable: true },
  { path: 'boutique/front-e2e', name: 'front-e2e', statut: 'instable', enCours: false, buildable: true },
  { path: 'batch/nightly-import', name: 'nightly-import', statut: 'succes', enCours: true, buildable: true },
  { path: 'batch/purge-archives', name: 'purge-archives', statut: 'jamais', enCours: false, buildable: true },
  { path: 'outils/release', name: 'release', statut: 'succes', enCours: false, buildable: true },
  { path: 'outils/vieux-pipeline', name: 'vieux-pipeline', statut: 'desactive', enCours: false, buildable: false },
].map((j) => ({ ...j, url: `https://jenkins.demo/job/${j.path.split('/').join('/job/')}/` }));

// Le job paramétré est celui qu'on montre : c'est le cas où lancer demande une décision.
const PARAMS = {
  'boutique/api-deploy-prod': [
    { name: 'VERSION', type: 'StringParameterDefinition', description: 'Tag à déployer', choices: null, value: '1.5.0' },
    { name: 'ENVIRONNEMENT', type: 'ChoiceParameterDefinition', description: '', choices: ['recette', 'préprod', 'prod'], value: 'recette' },
    { name: 'MIGRATIONS', type: 'BooleanParameterDefinition', description: 'Jouer les migrations de base', choices: null, value: true },
  ],
  'outils/release': [
    { name: 'BRANCHE', type: 'StringParameterDefinition', description: '', choices: null, value: 'main' },
  ],
};

const RESULTATS = { succes: 'SUCCESS', echec: 'FAILURE', instable: 'UNSTABLE', annule: 'ABORTED' };

function builds(job) {
  if (job.statut === 'jamais' || job.statut === 'desactive') return [];
  const suite = [job.statut, 'succes', 'succes', 'echec', 'succes'];
  return suite.map((s, i) => ({
    number: 42 - i,
    result: (i === 0 && job.enCours) ? null : (RESULTATS[s] || 'SUCCESS'),
    building: i === 0 && job.enCours,
    timestamp: ms(37 * (i + 1)),
    duration: (i === 0 && job.enCours) ? 0 : 95000 + i * 12000,
    url: `${job.url}${42 - i}/`,
  }));
}

const lister = () => JOBS.map((j) => ({ ...j }));

function detail(chemin) {
  const job = JOBS.find((j) => j.path === chemin);
  if (!job) throw new Error(`Jenkins : job « ${chemin} » introuvable (404).`);
  return {
    ...job,
    description: job.statut === 'echec' ? 'Compilation du front et publication de l’image.' : '',
    parameters: PARAMS[chemin] || [],
    builds: builds(job),
  };
}

const LOG = [
  'Started by user Démo',
  'Running on agent-linux-02 in /var/jenkins/workspace/front-build',
  '[Pipeline] stage (Build)',
  '+ npm ci',
  'added 812 packages in 14s',
  '+ npm run build',
  'ERROR: le build a échoué : Module not found: ./panier/remise',
  'Finished: FAILURE',
].join('\n');

module.exports = {
  isDemo,
  lister,
  detail,
  console: () => ({ text: LOG, truncated: false }),
  lancer: () => ({ queued: true, location: 'https://jenkins.demo/queue/item/1201/' }),
  tester: () => ({ ok: true, user: 'Démo', jobs: JOBS.length }),
};
