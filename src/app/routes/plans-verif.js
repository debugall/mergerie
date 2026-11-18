'use strict';
/* Git → Vérificateur : les préparations de vérification (dépôts sur une ref, vérificateurs en
   séquence), leurs lancements, et l'étape « non lancée » qu'on lance seule. La logique vit dans
   `jobs/plan-verif.js` ; ici, le HTTP et la mise en forme des étapes pour l'écran. */
const { app } = require('../app');
const db = require('../../db');
const { planVerif } = require('../../jobs');
const { wrap } = require('../http');
const { detailVerification, resumeVerification } = require('../lib/verifications');

/* Les lancements montrés : le dernier en entier, les précédents en historique — borné, une
   préparation relancée chaque matin n'a pas à renvoyer un an de verdicts à chaque rafraîchissement. */
const HISTORIQUE = 20;

function vueRun(run) {
  return {
    id: run.id, created_at: run.created_at,
    steps: planVerif.etatEtapes(run).map((s) => {
      const v = s.verification_id ? db.prepare('SELECT * FROM verification WHERE id = ?').get(s.verification_id) : null;
      return {
        verifier_id: s.verifier_id, verifier_name: s.verifier_name, etat: s.etat, erreur: s.erreur || null,
        verification: v ? resumeVerification(detailVerification(v)) : null,
      };
    }),
  };
}

function vuePlan(p) {
  const runs = planVerif.lancementsDe(p.id).slice(0, HISTORIQUE);
  return {
    id: p.id, name: p.name, created_at: p.created_at, updated_at: p.updated_at,
    targets: p.targets.map((c) => ({ ...c, project: (db.prepare('SELECT project FROM repo WHERE id = ?').get(c.repo_id) || {}).project || `#${c.repo_id}` })),
    verifiers: p.verifier_ids.map((id) => ({ id, name: (db.prepare('SELECT name FROM verifier WHERE id = ?').get(id) || {}).name || null })),
    running: !!runs[0] && planVerif.runActif(runs[0]),
    runs: runs.map(vueRun),
  };
}

app.get('/api/verif-plans', wrap((req, res) => {
  res.json(planVerif.plans().map(vuePlan));
}));
app.post('/api/verif-plans', wrap((req, res) => {
  res.json(vuePlan(planVerif.creerPlan(req.body)));
}));
app.put('/api/verif-plans/:id', wrap((req, res) => {
  res.json(vuePlan(planVerif.modifierPlan(req.params.id, req.body)));
}));
app.delete('/api/verif-plans/:id', wrap((req, res) => {
  planVerif.supprimerPlan(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/verif-plans/:id/run', wrap(async (req, res) => {
  await planVerif.lancerPlan(req.params.id);
  res.json(vuePlan(planVerif.planParId(req.params.id)));
}));
app.post('/api/verif-plan-runs/:id/steps/:index/run', wrap(async (req, res) => {
  const run = await planVerif.lancerEtapeSeule(req.params.id, req.params.index);
  res.json(vuePlan(planVerif.planParId(run.plan_id)));
}));
