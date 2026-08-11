'use strict';
/* Données Jenkins STATIQUES pour le mode démo (MERGERIE_DEMO=1), sur le modèle de demo-docker.
   L'onglet Jenkins interroge un vrai serveur en direct ; hors-ligne il serait vide. Ici une
   installation fictive mais crédible : des dossiers, un job en cours, un rouge, un instable,
   un désactivé, et un job paramétré — c'est-à-dire chaque cas que l'écran doit savoir rendre.

   Lancer en démo ne lance rien : la réponse dit « mis en file », et la liste ne bouge pas. */

const isDemo = () => process.env.MERGERIE_DEMO === '1';
const ms = (min) => Date.now() - min * 60000;

/* Chaque ligne montre un cas que l'écran doit savoir rendre : un lancement humain et un
   lancement automatique, une branche et un tag, un job jamais lancé (sans date ni auteur). */
const JOBS = [
  { path: 'boutique/api-build', name: 'api-build', statut: 'succes', enCours: false, buildable: true, age: 18, by: { user: 'Alice' }, ref: 'main' },
  { path: 'boutique/api-deploy-prod', name: 'api-deploy-prod', statut: 'succes', enCours: false, buildable: true, age: 240, by: { user: 'Moi Même' }, ref: 'v1.5.0', lastParams: [{ name: 'VERSION', value: '1.5.0' }, { name: 'ENVIRONNEMENT', value: 'préprod' }, { name: 'MIGRATIONS', value: 'true' }] },
  { path: 'boutique/front-build', name: 'front-build', statut: 'echec', enCours: false, buildable: true, age: 52, by: { trigger: 'scm' }, ref: 'feature/panier-remise' },
  { path: 'boutique/front-e2e', name: 'front-e2e', statut: 'instable', enCours: false, buildable: true, age: 95, by: { trigger: 'upstream' }, ref: 'main' },
  { path: 'batch/nightly-import', name: 'nightly-import', statut: 'succes', enCours: true, buildable: true, age: 4, by: { trigger: 'timer' }, ref: 'main' },
  { path: 'batch/purge-archives', name: 'purge-archives', statut: 'jamais', enCours: false, buildable: true, age: null, by: null, ref: null },
  { path: 'outils/release', name: 'release', statut: 'succes', enCours: false, buildable: true, age: 1500, by: { user: 'Bruno' }, ref: 'v2.0.1', lastParams: [{ name: 'BRANCHE', value: 'main' }] },
  { path: 'outils/vieux-pipeline', name: 'vieux-pipeline', statut: 'desactive', enCours: false, buildable: false, age: 40000, by: { user: 'Alice' }, ref: 'main' },
].map((j, i) => ({
  ...j,
  folder: j.path.slice(0, j.path.lastIndexOf('/')),
  last: j.age == null ? null : ms(j.age),
  lastNumber: j.age == null ? null : 42 - i,
  url: `https://jenkins.demo/job/${j.path.split('/').join('/job/')}/`,
}))
  // Trié comme le vrai client : du dernier lancement au plus ancien, jamais lancés à la fin.
  .sort((a, b) => (a.last && b.last ? b.last - a.last : (a.last || b.last) ? (a.last ? -1 : 1) : 0));

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

/* Chaque exécution porte SES paramètres : c'est ce que la fiche montre à droite, et une
   démo où toutes les exécutions se ressemblent ne montrerait pas à quoi ça sert. */
const ENVS = ['prod', 'préprod', 'recette', 'préprod', 'recette'];
function builds(job) {
  if (job.statut === 'jamais' || job.statut === 'desactive') return [];
  const suite = [job.statut, 'succes', 'succes', 'echec', 'succes'];
  const params = PARAMS[job.path];
  return suite.map((s, i) => ({
    number: 42 - i,
    result: (i === 0 && job.enCours) ? null : (RESULTATS[s] || 'SUCCESS'),
    building: i === 0 && job.enCours,
    timestamp: ms(37 * (i + 1)),
    duration: (i === 0 && job.enCours) ? 0 : 95000 + i * 12000,
    url: `${job.url}${42 - i}/`,
    by: i % 2 ? { trigger: 'timer' } : (job.by || { user: 'Alice' }),
    ref: job.ref || 'main',
    params: params
      ? [{ name: 'VERSION', value: `1.5.${i}` }, { name: 'ENVIRONNEMENT', value: ENVS[i] }, { name: 'MIGRATIONS', value: i ? 'false' : 'true' }]
      : [],
  }));
}

const lister = () => JOBS.map((j) => ({ ...j, params: (PARAMS[j.path] || []).length }));

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
