'use strict';
/* Jenkins : voir et lancer des jobs, tester la connexion, lier un job à un dépôt. Rien n’est sondé : l’écran demande, on demande à Jenkins.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const i18n = require('../../core/i18n');
const { t } = i18n;
const links = require('../../notes/links');
const jobs = require('../../jobs');
const demoJenkins = require('../../demo/jenkins');
const jenkins = require('../../integrations/jenkins');
const veille = require('../../integrations/veille');
const path = require('path');
const { wrap } = require('../http');
const { exigerJetonFrais, jenkinsCfg, noterTest } = require('../lib/connexions');

app.get('/api/jenkins/jobs', wrap(async (req, res) => {
  if (demoJenkins.isDemo()) return res.json({ configured: true, jobs: demoJenkins.lister() });
  const cfg = jenkinsCfg();
  if (!jenkins.isConfigured(cfg)) return res.json({ configured: false, jobs: [] });
  res.json({ configured: true, jobs: await jenkins.lister(cfg) });
}));
app.get('/api/jenkins/job', wrap(async (req, res) => {
  const chemin = String(req.query.path || '').trim();
  if (!chemin) throw new Error(t('err.jenkins-chemin-requis'));
  if (demoJenkins.isDemo()) return res.json(demoJenkins.detail(chemin, req.query.builds));
  // `builds` : profondeur d'historique demandée par l'écran (bornée côté client Jenkins).
  res.json(await jenkins.detail(jenkinsCfg(), chemin, req.query.builds));
}));
/* Lancer : le seul geste qui ÉCRIT chez Jenkins, donc un POST explicite. Les paramètres
   arrivent tels que l'écran les a lus du job — on ne les invente pas, et un job sans
   paramètre part sans corps. */
app.post('/api/jenkins/build', wrap(async (req, res) => {
  const chemin = String((req.body && req.body.path) || '').trim();
  if (!chemin) throw new Error(t('err.jenkins-chemin-requis'));
  const params = (req.body && req.body.parameters) || {};
  if (demoJenkins.isDemo()) return res.json(demoJenkins.lancer(chemin, params));
  const r = await jenkins.lancer(jenkinsCfg(), chemin, params);
  /* B15 — ET ON NOTE QU'ON L'ATTEND. La fin de build était guettée par le NAVIGATEUR, donc
     seulement tant que l'onglet Jenkins restait ouvert — alors qu'on lance un build justement
     pour aller faire autre chose. `since` est le numéro du dernier build connu de l'écran au
     moment du clic ; sans lui (appel direct à l'API), on le demande à Jenkins, parce qu'une
     attente qui part de zéro prendrait le build PRÉCÉDENT pour le nôtre. */
  let since = Number(req.body && req.body.since);
  if (!Number.isFinite(since)) {
    try { since = ((await jenkins.detail(jenkinsCfg(), chemin, 1)).builds[0] || {}).number || 0; }
    catch { since = 0; }
  }
  veille.attendreJenkins(chemin, since);
  res.json(r);
}));
app.get('/api/jenkins/console', wrap(async (req, res) => {
  const chemin = String(req.query.path || '').trim();
  if (!chemin) throw new Error(t('err.jenkins-chemin-requis'));
  if (demoJenkins.isDemo()) return res.json(demoJenkins.console());
  res.json(await jenkins.console(jenkinsCfg(), chemin, req.query.build));
}));
app.post('/api/jenkins/test', wrap(async (req, res) => {
  if (demoJenkins.isDemo()) return res.json(demoJenkins.tester());
  const test = { ...jenkinsCfg() };
  const b = req.body || {};
  if (b.jenkins_url) exigerJetonFrais(b.jenkins_url, test.jenkins_url, b.jenkins_token, test.jenkins_token);
  if (b.jenkins_url) test.jenkins_url = b.jenkins_url;
  if (b.jenkins_user) test.jenkins_user = b.jenkins_user;
  if (b.jenkins_token && b.jenkins_token !== '***') test.jenkins_token = b.jenkins_token;
  if (!jenkins.isConfigured(test)) throw new Error(t('err.jenkins-non-configure'));
  try {
    const r = await jenkins.tester(test);
    noterTest('jenkins', true, `${r.user || ''} · ${r.jobs || 0}`);
    res.json(r);
  } catch (e) { noterTest('jenkins', false, e.message); throw e; }
}));
/* ---------- B8 : les jobs Jenkins liés à un dépôt ----------
   Déclaré une fois dans Réglages → Jenkins, comme service ↔ dépôt dans Liens. Rien n'est
   lancé ici : ces routes ne font que tenir la liste. */
/* B10 — LES LIENS D'UN BUILD. Un job lié à un dépôt vient de déployer avec `ENV=préprod` :
   la question suivante est « est-ce bien parti ? », et elle demandait d'aller dans Liens,
   chercher le dépôt, cliquer la case. On rend ici, pour un dépôt donné, les adresses de son
   service par environnement — la même résolution que sur une merge request, sans `{branch}`
   à substituer puisqu'un build n'en porte pas forcément. */
app.get('/api/jenkins/build-links', wrap((req, res) => {
  const chemin = String(req.query.path || '').trim();
  if (!chemin) return res.json({ envs: [] });
  const lien = db.prepare('SELECT repo_id FROM repo_jenkins WHERE job_path = ? LIMIT 1').get(chemin);
  if (!lien) return res.json({ envs: [] });
  const d = links.liensDeMr({ repo_id: lien.repo_id });
  res.json({ envs: d.envs || [] });
}));
app.get('/api/jenkins/links', wrap((req, res) => {
  res.json({
    links: db.prepare(`SELECT rj.*, repo.project FROM repo_jenkins rj
      JOIN repo ON repo.id = rj.repo_id ORDER BY repo.project, rj.job_path`).all(),
  });
}));
app.post('/api/jenkins/links', wrap((req, res) => {
  const repoId = Number((req.body && req.body.repo_id) || 0);
  const job = String((req.body && req.body.job_path) || '').trim();
  if (!repoId || !db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) throw new Error(t('err.depot-introuvable'));
  if (!job) throw new Error(t('err.jenkins.job-required'));
  db.prepare('INSERT OR REPLACE INTO repo_jenkins (repo_id, job_path, param) VALUES (?,?,?)')
    .run(repoId, job, String((req.body && req.body.param) || '').trim() || null);
  res.json({ ok: true });
}));
app.delete('/api/jenkins/links/:id', wrap((req, res) => {
  db.prepare('DELETE FROM repo_jenkins WHERE id = ?').run(Number(req.params.id) || 0);
  res.json({ ok: true });
}));
