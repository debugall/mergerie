'use strict';
/* Données Jenkins STATIQUES pour le mode démo (MERGERIE_DEMO=1), sur le modèle de demo-docker.
   L'onglet Jenkins interroge un vrai serveur en direct ; hors-ligne il serait vide. Ici une
   installation fictive mais crédible : des dossiers, un job en cours, un rouge, un instable,
   un désactivé, et un job paramétré — c'est-à-dire chaque cas que l'écran doit savoir rendre.

   Lancer en démo ne lance rien : la réponse dit « mis en file », et la liste ne bouge pas. */

const isDemo = () => process.env.MERGERIE_DEMO === '1';

/* MINUIT NE DOIT PAS VIDER LA DÉMO. Les exécutions sont datées en relatif : passé minuit, la
   plus récente tombait « hier », et la pastille du menu — qui compte les jobs du JOUR — se
   masquait. Un enregistrement commencé à 23 h 50 et fini à 0 h 10 montrait alors deux écrans
   différents pour la même phrase. On borne donc la plus récente au jour courant : elle reste
   dans le passé (une minute au moins), mais du bon côté de minuit. Les précédentes gardent
   leur écart réel, et retomber la veille au soir est exactement ce qu'on attend d'elles. */
function decalageJour() {
  const minuit = new Date(); minuit.setHours(0, 0, 0, 0);
  const plusRecente = Date.now() - 4 * 60000;   // le job le plus frais du jeu : `age: 4`
  const voulu = Math.min(Math.max(plusRecente, minuit.getTime() + 60000), Date.now() - 60000);
  return voulu - plusRecente;
}
const ms = (min) => Date.now() - min * 60000 + decalageJour();

/* Chaque ligne montre un cas que l'écran doit savoir rendre : un lancement humain et un
   lancement automatique, une branche et un tag, un job jamais lancé (sans date ni auteur). */
const JOBS_BRUTS = [
  { path: 'boutique/api-build', name: 'api-build', statut: 'succes', enCours: false, buildable: true, age: 18, by: { user: 'Alice' }, ref: 'main', lastParams: [{ name: 'ENV', value: 'recette' }, { name: 'VERSION', value: '1.5.0' }] },
  { path: 'boutique/api-deploy-prod', name: 'api-deploy-prod', statut: 'succes', enCours: false, buildable: true, age: 240, by: { user: 'Moi Même' }, ref: 'v1.5.0', lastParams: [{ name: 'VERSION', value: '1.5.0' }, { name: 'ENV', value: 'préprod' }, { name: 'MIGRATIONS', value: 'true' }] },
  { path: 'boutique/front-build', name: 'front-build', statut: 'echec', enCours: false, buildable: true, age: 52, by: { trigger: 'scm' }, ref: 'feature/panier-remise', lastParams: [{ name: 'ENV', value: 'dev' }, { name: 'VERSION', value: '2.0.0' }, { name: 'MINIFIER', value: 'false' }] },
  { path: 'boutique/front-e2e', name: 'front-e2e', statut: 'instable', enCours: false, buildable: true, age: 95, by: { trigger: 'upstream' }, ref: 'main' },
  { path: 'batch/nightly-import', name: 'nightly-import', statut: 'succes', enCours: true, buildable: true, age: 4, by: { trigger: 'timer' }, ref: 'main', lastParams: [{ name: 'ENV', value: 'prod' }, { name: 'LOT', value: '500' }] },
  { path: 'batch/purge-archives', name: 'purge-archives', statut: 'jamais', enCours: false, buildable: true, age: null, by: null, ref: null },
  { path: 'outils/release', name: 'release', statut: 'succes', enCours: false, buildable: true, age: 1500, by: { user: 'Bruno' }, ref: 'v2.0.1', lastParams: [{ name: 'BRANCHE', value: 'main' }] },
  { path: 'outils/vieux-pipeline', name: 'vieux-pipeline', statut: 'desactive', enCours: false, buildable: false, age: 40000, by: { user: 'Alice' }, ref: 'main' },
];

/* CONSTRUIT À CHAQUE APPEL, jamais au chargement du module : les dates sont relatives à
   maintenant, et un serveur de démo laissé ouvert depuis la veille servait sinon des « jobs du
   jour » datant d'avant-hier. */
const construireJobs = () => JOBS_BRUTS.map((j, i) => ({
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
/* PLUS DE DIX EXÉCUTIONS, et « prod » n'apparaît qu'en tête et tout au fond : la fiche n'en
   charge que dix, et filtrer sur la prod doit donc aller chercher plus loin. Une démo qui
   tiendrait en cinq exécutions ne montrerait jamais ce que fait ce filtre. */
const PROFOND = 14;
const envDe = (i) => (i === PROFOND - 1 ? 'prod' : ENVS[i % ENVS.length]);
function builds(job) {
  if (job.statut === 'jamais' || job.statut === 'desactive') return [];
  const suite = [job.statut, 'succes', 'succes', 'echec', 'succes',
    ...Array.from({ length: PROFOND - 5 }, (_, i) => (i % 4 === 3 ? 'echec' : 'succes'))];
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
      ? [{ name: 'VERSION', value: `1.5.${i}` }, { name: 'ENVIRONNEMENT', value: envDe(i) }, { name: 'MIGRATIONS', value: i ? 'false' : 'true' }]
      : [],
    // Un secret dans le lot : « relancer » ne peut pas le renvoyer, et l'écran doit le dire.
    paramsCaches: params ? 1 : 0,
  }));
}

const lister = () => construireJobs().map((j) => ({ ...j, params: (PARAMS[j.path] || []).length, lastParamsCaches: PARAMS[j.path] ? 1 : 0 }));

function detail(chemin, profondeur) {
  const job = construireJobs().find((j) => j.path === chemin);
  if (!job) throw new Error(`Jenkins : job « ${chemin} » introuvable (404).`);
  // La démo tronque comme le vrai client, sinon le filtrage profond n'aurait rien à démontrer.
  const voulu = Number(profondeur);
  const n = Number.isFinite(voulu) && voulu >= 1 ? Math.min(200, Math.round(voulu)) : 10;
  return {
    ...job,
    depth: n,
    description: job.statut === 'echec' ? 'Compilation du front et publication de l’image.' : '',
    parameters: PARAMS[chemin] || [],
    builds: builds(job).slice(0, n),
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
  tester: () => ({ ok: true, user: 'Démo', jobs: construireJobs().length }),
};
