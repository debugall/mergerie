'use strict';
/* File d'attente : voir ce qui attend, et doubler la file. */
/* ---------- File d'attente : voir ce qui attend, et doubler la file ----------
   Le bandeau annonçait « +3 en attente » sans dire QUOI. On peut maintenant ouvrir la
   liste et lancer un job précis à côté de celui en cours — à condition qu'il ne touche
   pas les mêmes dépôts, ce que le serveur vérifie et refuse le cas échéant. */
let logQueueOpen = false;

/* Le journal d'activité nomme CE QU'IL LISTE. Quatre saveurs manquaient — vérification,
   question libre, question sur une revue, réconciliation — et s'affichaient sous leur nom
   technique (`verify`, `ask`…) au milieu de libellés en clair : le filtre par type devenait
   illisible et rien n'expliquait ces mots. */
const JOB_KIND_LABEL = {
  review: 'job.kind.review', rereview: 'job.kind.rereview', modify: 'job.kind.modify',
  explain: 'job.kind.explain', task: 'job.kind.task', local: 'job.kind.local',
  gitops: 'job.kind.gitops',
  converge: 'job.kind.converge', 'converge-session': 'job.kind.converge',
  verify: 'job.kind.verify', ask: 'job.kind.ask',
  'ask-review': 'job.kind.ask-review', reconcile: 'job.kind.reconcile',
};
/* Un job de PLUGIN a pour genre `plugin:<nom>` : on le nomme comme le plugin se nomme (« Docker »). */
const jobKindLabel = (k) => {
  if (JOB_KIND_LABEL[k]) return tr(JOB_KIND_LABEL[k]);
  const m = /^plugin:(.+)$/.exec(String(k));
  return m ? ((PLUGINS_META[m[1]] && PLUGINS_META[m[1]].displayName) || m[1]) : k;
};

