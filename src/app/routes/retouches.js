'use strict';
/* Les retouches après merge : L'ARBITRAGE HUMAIN sur un lien (« Pas un correctif » / « Marquer comme
   correctif »), un fait enregistré avec son auteur, jamais un recalcul ; et les origines qu'une merge
   request mergée peut se voir rattacher à la main. Lecture et écriture de la base, zéro forge, zéro IA. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const retouches = require('../../review/retouches');
const identite = require('../../core/identite');
const { mrById, wrap } = require('../http');
const { t } = require('../../core/i18n');

/* Les liens d'une merge request, des deux côtés (`touched_by` pour A, `touches` pour B). */
app.get('/api/retouches/:id', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(retouches.pourCartes(getConfig(), { mrIds: [mr.id] })[mr.id] || { touched_by: [], touches: [], window: retouches.fenetre(getConfig()) });
}));

/* Les merge requests mergées que `:id` (B) a pu corriger, pour « Marquer comme correctif ». */
app.get('/api/retouches/:id/origines', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(retouches.originesPossibles(getConfig(), mr.id));
}));

/* Requalifier une paire : `:id` est l'ORIGINE (A) ; `fix_mr_id` ou `fix_commit_sha` désigne B ;
   `status` est `confirmed`, `dismissed` ou `auto` (défaire). Rend la paire relue. */
app.post('/api/retouches/:id/statut', wrap((req, res) => {
  const a = mrById(Number(req.params.id));
  if (!a) throw new Error(t('err.mr-introuvable'));
  const body = req.body || {};
  const paire = retouches.requalifier(getConfig(), {
    originId: a.id, fixMrId: Number(body.fix_mr_id) || 0, fixSha: String(body.fix_commit_sha || ''),
    status: String(body.status || ''), par: identite.nom() || '',
  });
  res.json({ ok: true, link: paire });
}));
