'use strict';
/* Précision technique d'un ticket Jira : créer et lancer l'analyse, relire la proposition, la
   faire ajuster (suivi), la corriger à la main, la poster en commentaire — et la même chose pour
   les tickets d'une epic, en lot. HTTP et rien d'autre : la mécanique vit dans
   `session/spec.js` et `integrations/jiraspec.js`. */
const { app } = require('../app');
const db = require('../../db');
const { getConfig } = require('../../data/config');
const { t } = require('../../core/i18n');
const jira = require('../../integrations/jira');
const jiraspec = require('../../integrations/jiraspec');
const confluence = require('../../integrations/confluence');
const spec = require('../../session/spec');
const jobs = require('../../jobs');
const demoDocker = require('../../demo/docker');
const demoJira = require('../../demo/jira');
const { wrap } = require('../http');
const { savePiecesEtImages } = require('../lib/pieces');

const MAX_LOT = 30;
const specOu404 = (id) => {
  const s = spec.specById(Number(id));
  if (!s) throw new Error(t('err.spec.not-found'));
  return s;
};
const reposDe = (s) => {
  let ids = []; try { ids = JSON.parse(s.repo_ids_json || '[]'); } catch { ids = []; }
  return ids.length ? db.prepare(`SELECT id, project, forge FROM repo WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
};
const vueComplete = (s) => ({ ...spec.vue(s), repos: reposDe(s) });
const marker = (cfg) => String(cfg.spec_marker || '').trim() || t('jira.spec.marker');

/* EN DÉMO, PAS DE SESSION : la forge fictive ne se clone pas. La proposition est celle du
   dry-run, rangée sur-le-champ — l'écran montre la chaîne entière, et c'est tout ce qu'une démo
   doit faire. */
function analyserEnDemo(s) {
  const nonce = jiraspec.nonceRun();
  const ticket = demoJira.issue(s.ticket_key);
  spec.poser(s.id, { nonce, status: 'running', ticket_snapshot: jiraspec.snapshotDe(ticket), epic_key: ticket.epic ? ticket.epic.key : s.epic_key });
  const md = jiraspec.extraireSpec(jiraspec.sortieDryRun(nonce, s.ticket_key), nonce);
  const avait = spec.versionCourante(s.id);
  spec.ajouterVersion(s, md, avait ? 'followup' : 'ai');
  spec.poser(s.id, { status: 'proposed', last_error: null });
  return spec.specById(s.id);
}

/* Lance (ou relance) l'analyse d'une spec : contexte relu, session créée, job programmé. */
async function lancer(s, body = {}, { enfantsConnus = null } = {}) {
  if (demoDocker.isDemo()) return { spec: analyserEnDemo(s), job: null };
  const { task } = await spec.preparerAnalyse(s, { cfg: getConfig(), enfantsConnus });
  const imageIds = savePiecesEtImages('task', task.id, body || {});
  const job = jobs.startTaskJob(task.id, 'run', imageIds.length ? { imageIds } : {});
  return { spec: spec.specById(s.id), job };
}

/* Les pastilles de la liste : l'état de la spec de chaque ticket, en un appel. */
app.get('/api/jira/specs', wrap((req, res) => {
  const cles = String(req.query.keys || '').split(',').map((x) => jiraspec.normaliserCle(x)).filter(Boolean).slice(0, 100);
  const out = {};
  for (const cle of cles) {
    const s = spec.specByKey(cle);
    if (!s) continue;
    const v = spec.versionCourante(s.id);
    out[cle] = { id: s.id, status: s.status, stale: !!s.stale, version: v ? v.version : 0, posted_version: s.posted_version, unposted: !!(v && (s.posted_version == null || v.version > s.posted_version)) };
  }
  res.json({ specs: out });
}));

/* Les tickets d'une epic, pour cocher ceux à préciser. */
app.get('/api/jira/spec/epic/:key/children', wrap(async (req, res) => {
  const cle = jiraspec.normaliserCle(req.params.key);
  if (!jiraspec.cleValide(cle)) throw new Error(t('err.jira.invalid-key'));
  const enfants = demoDocker.isDemo()
    ? demoJira.tickets([], true).filter((i) => i.epic && i.epic.key === cle).map((i) => ({ key: i.key, summary: i.summary, status: i.status, statusCategory: i.statusCategory, type: i.type, isSubtask: false }))
    : (await jira.epicChildren(getConfig(), cle)).map((e) => ({ key: e.key, summary: e.summary, status: e.status, statusCategory: e.statusCategory, type: e.type, isSubtask: e.isSubtask }));
  const existantes = {};
  for (const e of enfants) { const s = spec.specByKey(e.key); if (s) existantes[e.key] = { id: s.id, status: s.status }; }
  res.json({ epic: cle, children: enfants, specs: existantes, max: MAX_LOT });
}));

/* UN LOT : une spec et une session par ticket coché. Les specs sont créées tout de suite (l'écran
   les voit « à lancer »), la réponse part aussitôt, et la PRÉPARATION — relire chaque ticket, les
   pages Confluence, créer la session — se fait en arrière-plan, trois tickets de front : trente
   tickets, c'est des dizaines d'appels réseau, trop pour une requête HTTP. L'epic est lue UNE fois
   pour tout le lot. Le statut du lot dit où il en est : running → done (ou partial si un ticket
   n'a pas pu partir), et chaque spec porte sa propre erreur. */
const LOT_PARALLELE = 3;
async function traiterLot(batchId, specIds, { epicKey, cfg }) {
  let enfantsConnus = null;
  if (!demoDocker.isDemo()) {
    try { enfantsConnus = { epicKey, enfants: await jira.epicChildren(cfg, epicKey) }; } catch { enfantsConnus = null; }
  }
  const file = specIds.slice();
  let erreurs = 0;
  const un = async () => {
    for (;;) {
      const id = file.shift();
      if (!id) return;
      const s = spec.specById(id);
      if (!s) continue;
      try { await lancer(s, {}, { enfantsConnus }); }
      catch (e) { erreurs += 1; spec.poser(s.id, { status: 'error', last_error: String(e.message || e).slice(0, 500) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOT_PARALLELE, specIds.length) }, un));
  db.prepare('UPDATE ticket_spec_batch SET status = ?, updated_at = ? WHERE id = ?').run(erreurs ? 'partial' : 'done', new Date().toISOString(), batchId);
}
app.post('/api/jira/spec/epic', wrap((req, res) => {
  const b = req.body || {};
  const epicKey = jiraspec.normaliserCle(b.epic_key);
  if (!jiraspec.cleValide(epicKey)) throw new Error(t('err.jira.invalid-key'));
  const cles = [...new Set((b.keys || []).map((k) => jiraspec.normaliserCle(k)).filter((k) => jiraspec.cleValide(k) && k !== epicKey))].slice(0, MAX_LOT);
  if (!cles.length) throw new Error(t('err.spec.no-ticket'));
  const now = new Date().toISOString();
  const batchId = db.prepare('INSERT INTO ticket_spec_batch (epic_key, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run(epicKey, 'running', now, now).lastInsertRowid;
  const creees = []; const erreurs = [];
  for (const cle of cles) {
    try {
      /* Une session qui tourne encore n'est pas doublée : le ticket est écarté du lot, et dit —
         AVANT de réécrire ses choix, sinon la spec recevrait les dépôts et le `batch_id` du lot
         pendant que sa session en cours travaille sur les anciens. */
      const existante = spec.specByKey(cle);
      const tache = existante && existante.task_id ? db.prepare('SELECT status FROM task WHERE id = ?').get(existante.task_id) : null;
      if (tache && ['running', 'needs_input'].includes(tache.status)) throw new Error(t('err.spec.session-busy'));
      const s = spec.creerOuReprendre({
        ticketKey: cle, repoIds: b.repo_ids, complement: b.complement, confluenceUrls: b.confluence_urls, detail: b.detail,
        includeEpic: b.include_epic, askQuestions: b.ask_questions, epicKey, batchId, verifierOrigine: !demoDocker.isDemo(),
      });
      creees.push(s.id);
    } catch (e) { erreurs.push({ key: cle, error: e.message }); }
  }
  if (!creees.length) db.prepare('UPDATE ticket_spec_batch SET status = ?, updated_at = ? WHERE id = ?').run('partial', now, batchId);
  else setImmediate(() => { traiterLot(batchId, creees, { epicKey, cfg: getConfig() }).catch(() => { /* chaque spec porte déjà son erreur */ }); });
  res.json({ batch_id: batchId, epic_key: epicKey, queued: creees.length, errors: erreurs });
}));

app.get('/api/jira/spec/batch/:id', wrap((req, res) => {
  const b = db.prepare('SELECT * FROM ticket_spec_batch WHERE id = ?').get(Number(req.params.id));
  if (!b) throw new Error(t('err.spec.not-found'));
  const specs = db.prepare('SELECT * FROM ticket_spec WHERE batch_id = ? ORDER BY id').all(b.id).map(vueComplete);
  res.json({ batch: b, specs });
}));

/* La spec d'un ticket, telle que l'écran la montre. */
app.get('/api/jira/spec/:key', wrap((req, res) => {
  const cle = jiraspec.normaliserCle(req.params.key);
  if (!jiraspec.cleValide(cle)) throw new Error(t('err.jira.invalid-key'));
  const s = spec.specByKey(cle);
  res.json({ spec: s ? vueComplete(s) : null, confluence_configured: demoDocker.isDemo() || confluence.isConfigured(getConfig()) });
}));

/* Créer (ou reprendre) la spec d'un ticket et lancer son analyse. */
app.post('/api/jira/spec', wrap(async (req, res) => {
  const b = req.body || {};
  const s = spec.creerOuReprendre({
    ticketKey: b.key, repoIds: b.repo_ids, complement: b.complement, confluenceUrls: b.confluence_urls, detail: b.detail,
    includeEpic: b.include_epic, askQuestions: b.ask_questions, epicKey: b.epic_key, verifierOrigine: !demoDocker.isDemo(),
  });
  const r = await lancer(s, b);
  res.json({ spec: vueComplete(r.spec), job: r.job });
}));

/* Relancer l'analyse : le contexte est relu (le ticket a pu changer), la session est neuve, les
   versions et le commentaire posté restent. */
app.post('/api/jira/spec/:id/rerun', wrap(async (req, res) => {
  const s = specOu404(req.params.id);
  const b = req.body || {};
  // Une session qui tourne (ou attend des réponses) n'est pas doublée : la première perdrait sa spec.
  const enCours = s.task_id ? db.prepare('SELECT status FROM task WHERE id = ?').get(s.task_id) : null;
  if (enCours && ['running', 'needs_input'].includes(enCours.status)) throw new Error(t('err.spec.session-busy'));
  if (b.repo_ids || b.complement != null || b.confluence_urls || b.detail || b.include_epic != null || b.ask_questions != null) {
    spec.creerOuReprendre({
      ticketKey: s.ticket_key, repoIds: b.repo_ids || JSON.parse(s.repo_ids_json || '[]'), complement: b.complement != null ? b.complement : s.complement,
      confluenceUrls: b.confluence_urls || JSON.parse(s.confluence_json || '[]').map((p) => p.url), detail: b.detail || s.detail,
      includeEpic: b.include_epic != null ? b.include_epic : s.include_epic, askQuestions: b.ask_questions != null ? b.ask_questions : s.ask_questions,
      epicKey: s.epic_key, batchId: s.batch_id, verifierOrigine: !demoDocker.isDemo(),
    });
  }
  const r = await lancer(spec.specById(s.id), b);
  res.json({ spec: vueComplete(r.spec), job: r.job });
}));

/* Un suivi : l'agent reprend SA session, relit sa proposition, et la réécrit en entier. */
app.post('/api/jira/spec/:id/followup', wrap((req, res) => {
  const s = specOu404(req.params.id);
  const instruction = String((req.body || {}).instruction || '').trim();
  if (!instruction) throw new Error(t('err.spec.instruction-required'));
  if (!spec.versionCourante(s.id)) throw new Error(t('err.spec.no-proposal'));
  if (demoDocker.isDemo()) {
    const v = spec.versionCourante(s.id);
    spec.ajouterVersion(s, `${spec.lireMd(v.md_path).trim()}\n\n_${t('jira.spec.demo-followup', { instruction })}_`, 'followup', instruction);
    spec.poser(s.id, { status: 'proposed' });
    res.json({ spec: vueComplete(spec.specById(s.id)), job: null });
    return;
  }
  const tache = s.task_id ? db.prepare('SELECT * FROM task WHERE id = ?').get(s.task_id) : null;
  if (!tache) throw new Error(t('err.spec.no-session'));
  if (['running', 'needs_input'].includes(tache.status)) throw new Error(t('err.spec.session-busy'));
  const texte = spec.instructionSuivi(s, instruction);
  const imageIds = savePiecesEtImages('task', tache.id, req.body || {}, { followup: 1 });
  const job = jobs.startTaskJob(tache.id, 'followup', { instruction: texte, ...(imageIds.length ? { imageIds } : {}) });
  // La version qui sortira portera ce qu'on a demandé : gardé jusqu'à ce qu'`apresRun` l'écrive sur elle.
  spec.poser(s.id, { status: 'running', last_error: null, pending_instruction: instruction.slice(0, 2000) });
  res.json({ spec: vueComplete(spec.specById(s.id)), job, instruction });
}));

/* Corriger la proposition à la main : une version de plus, origine « edit », l'IA n'est pas rappelée. */
app.put('/api/jira/spec/:id', wrap((req, res) => {
  const s = specOu404(req.params.id);
  const md = String((req.body || {}).markdown || '').trim();
  if (!md) throw new Error(t('err.spec.empty'));
  spec.ajouterVersion(s, md, 'edit');
  spec.poser(s.id, { status: 'edited', last_error: null });
  res.json({ spec: vueComplete(spec.specById(s.id)) });
}));

app.delete('/api/jira/spec/:id', wrap((req, res) => {
  const s = specOu404(req.params.id);
  db.prepare('DELETE FROM ticket_spec WHERE id = ?').run(s.id);
  res.json({ ok: true });
}));

/* POSTER : un seul commentaire par spec, mis à jour à chaque nouvelle version. Ce qui le
   garantit est l'id mémorisé ; la ligne repère sert à RETROUVER le commentaire quand l'id manque
   (spec refaite, autre poste) parmi ceux de ce compte. Quand Jira refuse la mise à jour —
   commentaire d'un collègue, droit retiré — on ne crée rien en silence : 409, et l'écran propose
   de poster une nouvelle version sous son nom (`force_new`). Supprimé entre-temps : on recrée,
   et on le dit. */
app.post('/api/jira/spec/:id/post', wrap(async (req, res) => {
  const s = specOu404(req.params.id);
  const v = spec.versionCourante(s.id);
  if (!v) throw new Error(t('err.spec.no-proposal'));
  const cfg = getConfig();
  const rep = marker(cfg);
  const texte = jiraspec.corpsCommentaire(rep, v.version, spec.lireMd(v.md_path));
  const forceNew = !!(req.body && req.body.force_new);
  if (demoDocker.isDemo()) {
    const id = s.comment_id && !forceNew ? s.comment_id : String(Date.now());
    spec.poser(s.id, { comment_id: id, posted_version: v.version, status: 'posted' });
    res.json({ comment: { id, author: t('jira.demo.me'), created: new Date().toISOString(), bodyMd: texte }, spec: vueComplete(spec.specById(s.id)), updated: id === s.comment_id, recreated: false });
    return;
  }
  let commentId = forceNew ? null : s.comment_id;
  if (!commentId && !forceNew) {
    try {
      // Les plus récents d'abord : sur un ticket très commenté, le sien est rarement parmi les cent premiers.
      const [coms, moi] = await Promise.all([jira.listComments(cfg, s.ticket_key), jira.myself(cfg).catch(() => null)]);
      const c = jiraspec.commentaireRepere(coms, rep, moi ? moi.accountId : null);
      if (c) commentId = c.id;
    } catch { /* la recherche est un confort : on créera */ }
  }
  let resultat = null; let recreated = false;
  if (commentId) {
    try { resultat = await jira.updateComment(cfg, s.ticket_key, commentId, texte, { markdown: true }); }
    catch (e) {
      if (e.code === 'JIRA_COMMENT_GONE') recreated = true;
      else if (e.code === 'JIRA_DENIED') { res.status(409).json({ error: t('err.spec.comment-denied'), code: 'SPEC_COMMENT_DENIED', comment_id: commentId }); return; }
      else throw e;
    }
  }
  if (!resultat) resultat = await jira.addComment(cfg, s.ticket_key, texte, { markdown: true });
  spec.poser(s.id, { comment_id: resultat.id || commentId || null, posted_version: v.version, status: 'posted' });
  res.json({ comment: resultat, spec: vueComplete(spec.specById(s.id)), updated: !!(commentId && !recreated), recreated });
}));

/* Une session depuis la spec : les cibles sont ses dépôts, la consigne est la proposition —
   la boucle ticket → spec → session → MR. Le modal Dev IA se pré-remplit avec ce que rend cette
   route ; rien n'est créé ici. */
app.get('/api/jira/spec/:id/prefill', wrap((req, res) => {
  const s = specOu404(req.params.id);
  const v = spec.versionCourante(s.id);
  if (!v) throw new Error(t('err.spec.no-proposal'));
  const md = spec.lireMd(v.md_path).trim();
  res.json({
    key: s.ticket_key,
    repos: reposDe(s),
    prompt: t('jira.spec.prefill', { key: s.ticket_key }) + '\n\n' + md,
    branch_hint: `feat/${s.ticket_key}-`,
  });
}));
