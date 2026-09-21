'use strict';
/* La question libre : une session sans dépôt, gardée, étiquetée, reprise.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const { etat: etatLocal, pref: prefLocale } = require('../../data/localstate');
const localsession = require('../../data/localsession');
const i18n = require('../../core/i18n');
const { t } = i18n;
const jobs = require('../../jobs');
const agentsession = require('../../agent/session');
const agentpass = require('../../agent/pass');
const pieces = require('../../agent/pieces');
const path = require('path');
const fs = require('fs');
const { readFileSafe, wrap } = require('../http');
const { auteurs, avecRangement, basculerPartage, exigerProprietaire, passesPayload, rangement } = require('../lib/partage');
const { piecesExposees, savePiecesEtImages } = require('../lib/pieces');
const { chapeauReponse, coutParSession, dureeParSession, envoyerSuivi, lireLibelle, poserSuivi } = require('../lib/sessions');

/* ---------- Question libre ----------
   Une question posée à l'IA sans dépôt ni dossier, et sa réponse gardée. Mêmes gestes que les
   trois autres saveurs (lancer, suivre, ranger, supprimer), mais aucune cible : pas de route
   par projet ni par dossier, et rien à restreindre au lancement. */
/* `resume_cmd` : la commande à copier pour reprendre l'échange dans un terminal, comme pour
   les trois autres saveurs. Calculée à la lecture — elle dépend du binaire configuré, pas
   d'un état stocké. */
const questionById = (id) => {
  const q = localsession.resoudre('question',
    avecRangement('question', db.prepare('SELECT * FROM question WHERE id = ?').get(Number(id))));
  return q ? { ...q, resume_cmd: agentsession.resumeCommand(q.session_backend, q.session_key, q.session_cwd) } : q;
};
const exigerQuestion = (id) => {
  const q = questionById(id);
  if (!q) throw new Error(t('err.question-introuvable'));
  return q;
};
app.get('/api/questions', wrap((req, res) => {
  // Même tri que les autres listes de sessions : ce qui tourne, puis ce qui vient de finir.
  const rows = db.prepare(`SELECT * FROM question
    ORDER BY (status = 'running') DESC, COALESCE(finished_at, created_at) DESC, id DESC`).all();
  const couts = coutParSession('ask');
  const durees = dureeParSession('ask');
  const range = rangement('question');
  const poignees = localsession.carte('question');
  const parQui = auteurs('question', rows);
  const passes = agentpass.countsFor('ask');
  res.json(rows.map((brute) => {
    /* La poignée de session vit dans `local_session` : la commande de reprise se calcule sur
       la ligne RECOLLÉE, jamais sur la ligne brute — où elle n'est plus, et où elle rendait
       toujours null. */
    const q = localsession.resoudre('question', avecRangement('question', brute, range), poignees);
    return {
      author: parQui.get(q.id) || null,
      ...q,
      answer_head: chapeauReponse(q.md_path),
      tokens_est: (couts[q.id] || {}).tokens || null,
      cost_usd: (couts[q.id] || {}).cost_usd ?? null,
      duration_ms: durees[q.id] != null ? durees[q.id] : null,
      passes_count: passes[q.id] || 0,
      resume_cmd: agentsession.resumeCommand(q.session_backend, q.session_key, q.session_cwd),
    };
  }));
}));
app.post('/api/questions', wrap((req, res) => {
  const { prompt, label } = req.body || {};
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO question (prompt, label, shared, status, created_at, updated_at)
    VALUES (?, ?, ?, 'new', ?, ?)`)
    .run(String(prompt).trim(), lireLibelle(label), req.body && req.body.shared ? 1 : 0, now, now).lastInsertRowid;
  savePiecesEtImages('ask', id, req.body || {});
  res.json(questionById(id));
}));
app.get('/api/questions/:id', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  res.json({ task: q, images: piecesExposees('ask', q.id) });
}));
/* Édition : le prompt et le libellé. La SESSION D'AGENT est volontairement conservée —
   corriger une faute de frappe dans sa question ne doit pas faire perdre le fil de l'échange
   déjà engagé avec l'agent. */
app.put('/api/questions/:id', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const { prompt, label } = req.body || {};
  if (prompt != null && !String(prompt).trim()) throw new Error(t('err.prompt-requis'));
  db.prepare('UPDATE question SET prompt = ?, label = ?, updated_at = ? WHERE id = ?')
    .run(prompt != null ? String(prompt).trim() : q.prompt,
      label === undefined ? q.label : lireLibelle(label),
      new Date().toISOString(), q.id);
  savePiecesEtImages('ask', q.id, req.body || {});
  res.json(questionById(q.id));
}));
app.post('/api/questions/:id/run', wrap((req, res) => {
  res.json(jobs.startAskJob(exigerQuestion(req.params.id).id));
}));
// Question de suivi : elle REPREND la session de l'agent, qui garde le fil de l'échange.
app.post('/api/questions/:id/followup', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const instruction = (req.body && req.body.instruction || '').trim() || q.followup_draft || '';
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  // Comme les autres saveurs : une pièce peut accompagner la demande de suivi.
  const imageIds = savePiecesEtImages('ask', q.id, req.body || {}, { followup: 1 });
  res.json(envoyerSuivi('question', q, () => jobs.startAskJob(q.id,
    { instruction, ...(imageIds.length ? { imageIds } : {}) })));
}));
// Suivi en attente — même contrat que pour les autres saveurs.
app.put('/api/questions/:id/followup-draft', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  poserSuivi('question', q.id, req.body && req.body.instruction, req.body && req.body.auto);
  const apres = questionById(q.id);
  res.json({ ok: true, followup_draft: apres.followup_draft, followup_auto: apres.followup_auto });
}));
// La réponse, en Markdown — même forme que celle d'une exploration (visualiseur commun).
app.get('/api/questions/:id/md', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  res.json({ md: q.md_path ? readFileSafe(q.md_path) : null, prompt: q.prompt, created_at: q.created_at });
}));
// L'historique des passes : une étude menée en cinq questions garde ses cinq réponses.
app.get('/api/questions/:id/passes', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  res.json(passesPayload('ask', 0, q.id, req.query.n, null, q.md_path));
}));
app.post('/api/questions/:id/share', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const shared = basculerPartage('question', 'ask', q, req.body && req.body.shared);
  res.json({ ok: true, shared, question: exigerQuestion(q.id) });
}));
app.post('/api/questions/:id/hidden', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  prefLocale.ecrire('question', q.uid, 'hidden', hidden ? '1' : null);
  db.prepare('UPDATE question SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), q.id);
  res.json({ ok: true, hidden });
}));
app.post('/api/questions/:id/clear-error', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  db.prepare("UPDATE question SET last_error = NULL, status = CASE WHEN status = 'error' THEN 'new' ELSE status END, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), q.id);
  res.json({ ok: true });
}));
app.delete('/api/questions/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  exigerProprietaire('question', exigerQuestion(id));
  agentpass.removeTask('ask', id);                       // pas de FK : nettoyage explicite
  pieces.removeOwner('ask', id);
  db.prepare('DELETE FROM question WHERE id = ?').run(id);
  try { fs.rmSync(path.join(TASKS_DIR, 'ask', String(id)), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));
