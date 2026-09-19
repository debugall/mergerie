'use strict';
/* File d'attente : voir ce qui attend, et doubler la file. */
/* ---------- File d'attente : voir ce qui attend, et doubler la file ----------
   Le bandeau annonçait « +3 en attente » sans dire QUOI. On peut maintenant ouvrir la
   liste et lancer un job précis à côté de celui en cours — à condition qu'il ne touche
   pas les mêmes dépôts, ce que le serveur vérifie et refuse le cas échéant. */
let logQueueOpen = false;

/* Le journal d'activité nomme CE QU'IL LISTE. Cinq saveurs manquaient — vérification,
   installation de la dictée, question libre, question sur une revue, réconciliation — et
   s'affichaient sous leur nom technique (`verify`, `install`, `ask`…) au milieu de libellés
   en clair : le filtre par type devenait illisible et rien n'expliquait ces mots. */
const JOB_KIND_LABEL = {
  review: 'job.kind.review', rereview: 'job.kind.rereview', modify: 'job.kind.modify',
  explain: 'job.kind.explain', task: 'job.kind.task', local: 'job.kind.local',
  gitops: 'job.kind.gitops', docker: 'job.kind.docker',
  converge: 'job.kind.converge', 'converge-session': 'job.kind.converge',
  verify: 'job.kind.verify', install: 'job.kind.install', ask: 'job.kind.ask',
  'ask-review': 'job.kind.ask-review', reconcile: 'job.kind.reconcile',
};
const jobKindLabel = (k) => (JOB_KIND_LABEL[k] ? tr(JOB_KIND_LABEL[k]) : k);

