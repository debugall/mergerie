'use strict';
/* Le dictionnaire assemblé pour Node — le pendant, côté serveur, de `_socle.js` suivi des balises
   du manifeste. `FAMILLES` dit dans quel fichier vit chaque préfixe de clé (`task.*` → sessions.js) :
   c'est le tableau que `npm run i18n:check` fait respecter ; `FICHIERS` est l'ordre de chargement.
   Les deux sont non énumérables : `Object.keys(I18N)` reste la liste des langues. */
const FAMILLES = {
  ui: 'transverse.js',
  nav: 'transverse.js',
  palette: 'transverse.js',
  toast: 'transverse.js',
  confirm: 'transverse.js',
  shortcuts: 'transverse.js',
  dock: 'transverse.js',
  context: 'transverse.js',
  notif: 'transverse.js',
  export: 'transverse.js',
  viewer: 'transverse.js',
  demo: 'transverse.js',
  err: 'erreurs.js',
  task: 'sessions.js',
  local: 'sessions.js',
  ask: 'sessions.js',
  converge: 'sessions.js',
  session: 'sessions.js',
  prompt: 'sessions.js',
  resume: 'sessions.js',
  share: 'sessions.js',
  explore: 'sessions.js',
  review: 'reviews.js',
  report: 'reviews.js',
  mr: 'reviews.js',
  cmt: 'reviews.js',
  merge: 'reviews.js',
  sev: 'reviews.js',
  resolution: 'reviews.js',
  approval: 'reviews.js',
  branch: 'reviews.js',
  preview: 'reviews.js',
  settings: 'reglages.js',
  datasync: 'reglages.js',
  repo: 'reglages.js',
  shared: 'reglages.js',
  onboard: 'reglages.js',
  rules: 'reglages.js',
  verify: 'verification.js',
  agents: 'agents.js',
  git: 'git.js',
  notes: 'notes.js',
  todo: 'notes.js',
  links: 'liens.js',
  docker: 'docker.js',
  jira: 'jira.js',
  jenkins: 'jenkins.js',
  stats: 'stats.js',
  job: 'jobs.js',
  log: 'jobs.js',
  footer: 'jobs.js',
  dictation: 'dictee.js',
};
const FICHIERS = ['transverse.js', 'erreurs.js', 'sessions.js', 'reviews.js', 'reglages.js', 'verification.js', 'agents.js', 'git.js', 'notes.js', 'liens.js', 'docker.js', 'jira.js', 'jenkins.js', 'stats.js', 'jobs.js', 'dictee.js'];
const I18N = { fr: {}, en: {} };
for (const f of FICHIERS) {
  const d = require(`./${f}`);
  for (const l of Object.keys(d)) Object.assign(I18N[l] || (I18N[l] = {}), d[l]);
}
Object.defineProperty(I18N, 'FAMILLES', { value: FAMILLES });
Object.defineProperty(I18N, 'FICHIERS', { value: FICHIERS });
module.exports = I18N;
