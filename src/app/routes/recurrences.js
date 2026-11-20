'use strict';
/* Les sessions récurrentes (Dev IA → Récurrentes) : un modèle, son horaire, ses gestes. Le moteur
   — créer une session neuve à chaque échéance, sauter, garder les N dernières — vit dans
   `jobs/recurrences.js` ; la route `tick` le déclenche à la demande pour les tests. */
const { app } = require('../app');
const { t } = require('../../core/i18n');
const jobs = require('../../jobs');
const horaire = require('../../agent/horaire');
const { wrap } = require('../http');
const { champsDeSession } = require('../lib/sessions');

const recurrences = () => jobs.recurrences;

/* LE CORPS D'UN MODÈLE = celui d'une session (`POST /api/tasks`) + son horaire. Il se valide comme
   une session — même fonction —, à deux détails près : ce qui ne vaut que pour UNE session (une
   session d'agent à reprendre, un profil d'agent, un brouillon) est ignoré, et la branche de
   codage porte `{date}`, qu'on remplace par le jour le temps de la valider. */
function lireModele(body) {
  const b = body || {};
  if (b.kind !== 'code' && b.kind !== 'explore') throw new Error(t('err.recur.saveur'));
  const jour = recurrences().jourLocal();
  const origines = Array.isArray(b.targets) ? b.targets : [];
  const pourValider = {
    ...b,
    session_id: '', agent_id: undefined, agent_draft: undefined, force_push: false,
    targets: origines.map((x) => ({ ...x, branch: recurrences().brancheDuJour(recurrences().gabaritBranche(x && x.branch), jour) })),
  };
  if (b.kind === 'explore') pourValider.targets = origines;
  const champs = champsDeSession(pourValider);
  champs.targets = champs.targets.map((x, i) => ({ ...x, branch: b.kind === 'code' ? (origines[i] || {}).branch : x.branch }));
  return {
    label: b.label, kind: b.kind, spec: b.schedule, champs,
    skipUnchanged: !!b.skip_unchanged, keepLast: b.keep_last,
  };
}

app.get('/api/recurrences', wrap((req, res) => {
  res.json({ items: recurrences().lister() });
}));
/* La phrase et la prochaine échéance d'un horaire, pendant qu'on le compose : c'est le serveur
   qui lancera, c'est donc lui qui dit quand. */
app.get('/api/recurrences/preview', wrap((req, res) => {
  const spec = horaire.parse(req.query.schedule);
  if (!spec) throw new Error(t('err.recur.horaire'));
  const prochaine = horaire.creneauSuivant(spec, new Date());
  res.json({ spec: horaire.canonique(spec), said: horaire.phrase(req.query.schedule), next_at: prochaine ? prochaine.toISOString() : null });
}));
app.post('/api/recurrences', wrap(async (req, res) => {
  const r = recurrences().creer(lireModele(req.body));
  let lancee = null;
  if (req.body && req.body.run_now) lancee = await recurrences().declencher(r, { manuel: true });
  res.json({ ...recurrences().vue(recurrences().parId(r.id)), started: lancee ? lancee.taskId : null });
}));
app.put('/api/recurrences/:id', wrap((req, res) => {
  const r = recurrences().parId(req.params.id);
  if (!r) throw Object.assign(new Error(t('err.recur.introuvable')), { status: 404 });
  res.json(recurrences().vue(recurrences().modifier(r.id, lireModele({ ...req.body, kind: r.kind }))));
}));
app.delete('/api/recurrences/:id', wrap((req, res) => {
  recurrences().supprimer(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/recurrences/:id/pause', wrap((req, res) => {
  res.json(recurrences().vue(recurrences().mettreEnPause(req.params.id, !!(req.body && req.body.paused))));
}));
// « ▶ Maintenant » : une session de plus, hors horaire — le créneau suivant reste ce qu'il était.
app.post('/api/recurrences/:id/run', wrap(async (req, res) => {
  const r = recurrences().parId(req.params.id);
  if (!r) throw Object.assign(new Error(t('err.recur.introuvable')), { status: 404 });
  const d = await recurrences().declencher(r, { manuel: true });
  res.json({ ok: true, task_id: d.taskId });
}));
app.post('/api/recurrences/tick', wrap(async (req, res) => {
  const journal = [];
  const faits = await recurrences().tick(new Date(), (m) => journal.push(m));
  res.json({ done: faits, log: journal });
}));
