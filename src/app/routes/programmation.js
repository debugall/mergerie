'use strict';
/* Lancer plus tard : la date d'un lancement de session, posée ou retirée depuis la carte ou la
   modale. La date d'un SUIVI passe par `followup-draft`, avec le texte qu'elle accompagne.
   Le tick lui-même vit dans `jobs/programmation.js` ; la route `tick` le déclenche à la demande
   pour les tests — attendre la minute serait un pari sur l'horloge. */
const { app } = require('../app');
const { t } = require('../../core/i18n');
const jobs = require('../../jobs');
const { wrap } = require('../http');
const { localTaskById, taskById } = require('../lib/sessions');

/* `at` : une date ISO (ou ce que `new Date` sait lire), à venir ; vide ou `null` = annuler. */
app.put('/api/tasks/:id/schedule', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const at = jobs.programmation.programmer('task', tache.uid, 'run', req.body && req.body.at);
  res.json({ ok: true, scheduled_at: at });
}));
app.put('/api/local-tasks/:id/schedule', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const at = jobs.programmation.programmer('local_task', lt.uid, 'run', req.body && req.body.at);
  res.json({ ok: true, scheduled_at: at });
}));
// Ce qui est programmé sur ce poste, et un tick à la demande (tests).
app.get('/api/schedule', wrap((req, res) => {
  res.json({ items: jobs.programmation.lister() });
}));
app.post('/api/schedule/tick', wrap((req, res) => {
  const journal = [];
  const lances = jobs.programmation.tick(new Date(), (m) => journal.push(m));
  res.json({ started: lances.length, log: journal });
}));
