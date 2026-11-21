'use strict';
/* Le plan d'un lot de tickets (Jira → Plans) : enregistrer les entrées, préparer le prompt, le
   retoucher, lancer l'exploration, faire ajuster (suivi), publier le complément d'un ticket en
   commentaire — en mettant à jour le même au lieu d'en empiler —, exporter. HTTP et rien d'autre :
   la mécanique vit dans `session/plan.js` et `integrations/jiraplan.js`. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const { t } = require('../../core/i18n');
const jira = require('../../integrations/jira');
const jiraplan = require('../../integrations/jiraplan');
const confluence = require('../../integrations/confluence');
const plan = require('../../session/plan');
const jobs = require('../../jobs');
const demoMode = require('../../demo/mode');
const demoJira = require('../../demo/jira');
const { wrap } = require('../http');
const { savePiecesEtImages, piecesExposees } = require('../lib/pieces');

const planOu404 = (id) => {
  const p = plan.planById(Number(id));
  if (!p) throw Object.assign(new Error(t('err.plan.not-found')), { status: 404 });
  return p;
};
const marker = () => t('jira.plan.marker');
const vueComplete = (p) => ({
  ...plan.vue(p), pieces: piecesExposees('plan', p.id),
  confluence_configured: demoMode.isDemo() || confluence.isConfigured(getConfig()),
});
const opts = () => ({ verifierOrigine: !demoMode.isDemo() });

/* EN DÉMO, NI JIRA NI SESSION : les tickets viennent du décor, et le résultat est celui du dry-run,
   rangé sur-le-champ — l'écran montre la chaîne entière, c'est tout ce qu'une démo doit faire. */
async function lireEnDemo({ keys }) {
  const connus = new Set(demoJira.tickets([], true).issues.map((i) => i.key));
  const tickets = keys.filter((k) => connus.has(k)).map((k) => demoJira.issue(k));
  return { tickets, manquants: keys.filter((k) => !connus.has(k)), pages: [] };
}
function produireEnDemo(p, origin, instruction = null) {
  const brut = jiraplan.sortieDryRun(p.nonce, plan.clesAOrdonner(p));
  const resultat = jiraplan.extraire(brut, p.nonce, plan.clesAOrdonner(p));
  plan.ajouterVersion(p, resultat, origin, instruction);
  plan.poser(p.id, { status: 'done', last_error: null, pending_instruction: null });
  return plan.planById(p.id);
}

app.get('/api/jira/plans', wrap((req, res) => {
  res.json({ items: plan.lister() });
}));
app.post('/api/jira/plans', wrap((req, res) => {
  const p = plan.creer(req.body || {}, opts());
  savePiecesEtImages('plan', p.id, req.body || {});
  res.json(vueComplete(p));
}));
app.get('/api/jira/plans/:id', wrap((req, res) => {
  res.json(vueComplete(planOu404(req.params.id)));
}));
app.put('/api/jira/plans/:id', wrap((req, res) => {
  const p = plan.modifier(planOu404(req.params.id).id, req.body || {}, opts());
  savePiecesEtImages('plan', p.id, req.body || {});
  res.json(vueComplete(plan.planById(p.id)));
}));
app.delete('/api/jira/plans/:id', wrap((req, res) => {
  plan.supprimer(planOu404(req.params.id).id);
  res.json({ ok: true });
}));

/* PRÉPARER LE PROMPT : Jira et Confluence relus, le texte composé. Un prompt retouché à la main
   n'est remplacé que sur demande (`force`) — sinon 409, et l'écran pose la question. */
app.post('/api/jira/plans/:id/prepare', wrap(async (req, res) => {
  const p = planOu404(req.params.id);
  const force = !!(req.body && req.body.force);
  const prepare = await plan.preparer(p, { cfg: getConfig(), force, lire: demoMode.isDemo() ? lireEnDemo : null });
  res.json(vueComplete(prepare));
}));
app.put('/api/jira/plans/:id/prompt', wrap((req, res) => {
  res.json(vueComplete(plan.modifierPrompt(planOu404(req.params.id).id, (req.body || {}).prompt)));
}));

/* LANCER : une exploration neuve avec LE prompt tel qu'il est, en arrière-plan dans le journal. */
app.post('/api/jira/plans/:id/run', wrap((req, res) => {
  const p = planOu404(req.params.id);
  if (demoMode.isDemo()) {
    if (!p.prompt || !p.nonce) throw new Error(t('err.plan.not-prepared'));
    res.json({ ...vueComplete(produireEnDemo(p, 'ai')), job: null });
    return;
  }
  const task = plan.creerSession(p);
  const job = jobs.startTaskJob(task.id, 'run', {});
  res.json({ ...vueComplete(plan.planById(p.id)), job });
}));

/* UN SUIVI : l'agent reprend SA session, relit le plan courant, et le réécrit en entier. */
app.post('/api/jira/plans/:id/followup', wrap((req, res) => {
  const p = planOu404(req.params.id);
  const instruction = String((req.body || {}).instruction || '').trim();
  const texte = demoMode.isDemo() ? null : plan.instructionSuivi(p, instruction);
  if (demoMode.isDemo()) {
    if (!instruction) throw new Error(t('err.spec.instruction-required'));
    res.json({ ...vueComplete(produireEnDemo(p, 'followup', instruction)), job: null });
    return;
  }
  /* La version qui sortira portera ce qu'on a demandé : gardé jusqu'à ce qu'`apresRun` l'écrive sur elle.
     Posé AVANT le job : une passe rapide finirait sinon avant, et son « fini » serait écrasé par « en cours ». */
  plan.poser(p.id, { status: 'running', last_error: null, pending_instruction: instruction.slice(0, 2000), pending_origin: 'followup' });
  const job = jobs.startTaskJob(p.task_id, 'followup', { instruction: texte });
  res.json({ ...vueComplete(plan.planById(p.id)), job });
}));

/* RELIRE JIRA ET CONFLUENCE : les tickets et les pages relus, comparés aux photos du plan. Rien n'a
   changé : aucune passe de l'IA. Sinon, un suivi dans la session du plan, avec les changements — une
   version d'origine `jira`. */
app.post('/api/jira/plans/:id/refresh', wrap(async (req, res) => {
  const p = planOu404(req.params.id);
  const r = await plan.relireJira(p, { cfg: getConfig(), lire: demoMode.isDemo() ? lireEnDemo : null });
  if (!r.changements.length) { res.json({ ...vueComplete(r.plan), changes: [], job: null }); return; }
  if (demoMode.isDemo()) {
    res.json({ ...vueComplete(produireEnDemo(r.plan, 'jira', r.resume)), changes: r.changements, job: null });
    return;
  }
  // Posé AVANT le job, comme un suivi : une passe rapide finirait sinon avant, et serait recouverte.
  plan.poser(p.id, { status: 'running', last_error: null, pending_instruction: r.resume.slice(0, 2000), pending_origin: 'jira' });
  const job = jobs.startTaskJob(p.task_id, 'followup', { instruction: r.texte });
  res.json({ ...vueComplete(plan.planById(p.id)), changes: r.changements, job });
}));

app.get('/api/jira/plans/:id/versions/:n', wrap((req, res) => {
  res.json(plan.vueVersion(planOu404(req.params.id), req.params.n));
}));

/* L'APERÇU DE CE QUI PARTIRA : le texte exact, et s'il mettra à jour un commentaire déjà publié. */
app.get('/api/jira/plans/:id/post/:key', wrap((req, res) => {
  const p = planOu404(req.params.id);
  const key = String(req.params.key || '').toUpperCase();
  const { version, text } = plan.texteAPublier(p, key, marker());
  const deja = plan.postDe(p.id, key);
  res.json({ key, version, text, update: !!(deja && deja.comment_id), posted_version: deja ? deja.posted_version : null });
}));

/* PUBLIER, tel que l'aperçu l'a montré : `version` est celle de l'aperçu — si le plan a changé
   entre-temps, on refuse plutôt que de publier un texte que personne n'a relu. Republier met à jour
   le commentaire de CE plan sur ce ticket (id mémorisé, ou retrouvé par sa ligne repère). */
app.post('/api/jira/plans/:id/post/:key', wrap(async (req, res) => {
  const p = planOu404(req.params.id);
  const key = String(req.params.key || '').toUpperCase();
  const { version, text } = plan.texteAPublier(p, key, marker());
  if (Number((req.body || {}).version) !== version) throw Object.assign(new Error(t('err.plan.post-changed')), { status: 409 });
  const deja = plan.postDe(p.id, key);
  if (demoMode.isDemo()) {
    const id = deja && deja.comment_id ? deja.comment_id : String(Date.now());
    plan.noterPost(p.id, key, { commentId: id, version, text });
    res.json({ ...vueComplete(plan.planById(p.id)), updated: !!(deja && deja.comment_id) });
    return;
  }
  const cfg = getConfig();
  let commentId = deja ? deja.comment_id : null;
  if (!commentId) {
    try {
      const [coms, moi] = await Promise.all([jira.listComments(cfg, key), jira.myself(cfg).catch(() => null)]);
      const c = jiraplan.commentaireRepere(coms, p.uid, moi ? moi.accountId : null);
      if (c) commentId = c.id;
    } catch { /* la recherche est un confort : on créera */ }
  }
  let resultat = null;
  let recreated = false;
  if (commentId) {
    try { resultat = await jira.updateComment(cfg, key, commentId, text, { markdown: true }); }
    catch (e) {
      if (e.code === 'JIRA_COMMENT_GONE') recreated = true;
      else if (e.code === 'JIRA_DENIED') throw Object.assign(new Error(t('err.spec.comment-denied')), { status: 409 });
      else throw e;
    }
  }
  if (!resultat) resultat = await jira.addComment(cfg, key, text, { markdown: true });
  plan.noterPost(p.id, key, { commentId: resultat.id || commentId || null, version, text });
  res.json({ ...vueComplete(plan.planById(p.id)), updated: !!(commentId && !recreated), recreated });
}));

/* LE PLAN EN MARKDOWN, version courante — la base des trois exports (md, docx, pdf). */
app.get('/api/jira/plans/:id/export.md', wrap((req, res) => {
  const p = planOu404(req.params.id);
  const v = plan.versionCourante(p.id);
  if (!v) throw new Error(t('err.plan.no-result'));
  // Le titre voyage à part : chaque export le pose lui-même (en-tête du document, nom du fichier).
  res.json({ title: t('jira.plan.doc.title', { label: p.label }), markdown: plan.lireMd(v.md_path).replace(/^# [^\n]*\n+/, '') });
}));
