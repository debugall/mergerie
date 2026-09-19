'use strict';
/* Les sessions hors dépôt : un dossier local à la place d’une branche, avec leurs passes, leurs diffs et leurs suivis.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const { etat: etatLocal, pref: prefLocale } = require('../../data/localstate');
const localdirs = require('../../data/localdirs');
const localsession = require('../../data/localsession');
const identite = require('../../core/identite');
const i18n = require('../../core/i18n');
const { t } = i18n;
const notes = require('../../notes/notes');
const jobs = require('../../jobs');
const agentsession = require('../../agent/session');
const agentpass = require('../../agent/pass');
const localsnapshot = require('../../session/localsnapshot');
const localcoder = require('../../session/localcoder');
const pieces = require('../../agent/pieces');
const path = require('path');
const fs = require('fs');
const { readFileSafe, wrap } = require('../http');
const { auteurs, basculerPartage, exigerProprietaire, passesPayload, rangement } = require('../lib/partage');
const { piecesExposees, savePiecesEtImages } = require('../lib/pieces');
const { applySessionId, chapeauReponse, coutParSession, diffDePasse, dureeParSession, envoyerSuivi, lireLibelle, localDirsFor, localTaskById, normalizeDirIds, normalizeSessionId, poserSuivi } = require('../lib/sessions');
const { viewerFile, viewerFileDiff, viewerPayload } = require('../lib/visionneuse');

app.get('/api/local-tasks', wrap((req, res) => {
  // Même tri que les sessions de codage : d'abord ce qui tourne, puis ce qui vient de finir.
  const list = db.prepare(`SELECT * FROM local_task
    ORDER BY (status = 'running') DESC, COALESCE(finished_at, created_at) DESC, id DESC`).all();
  const couts = coutParSession('local');
  const durees = dureeParSession('local');
  const range = rangement('local_task');
  /* « PAR QUI » — lu de git, sans colonne. C'est ce qui décide si la carte propose « supprimer »
     ou seulement « ranger » : la session d'un collègue ne se retire pas du dépôt. */
  const parQui = auteurs('local_task', list);
  for (const lt of list) {
    lt.author = parQui.get(lt.id) || null;
    lt.hidden = range.get(lt.uid) === '1' ? 1 : 0;
    lt.dirs = localDirsFor(lt.id);
    /* Hors dépôt, la réponse vit PAR DOSSIER : on prend celle du premier qui en a une — la
       carte porte un chapeau, pas un rapport, et l'ouvrir donne toujours le détail complet. */
    const avecReponse = (lt.dirs || []).find((d) => d.output_path);
    lt.answer_head = avecReponse ? chapeauReponse(avecReponse.output_path) : '';
    lt.tokens_est = (couts[lt.id] || {}).tokens || null;
    lt.cost_usd = (couts[lt.id] || {}).cost_usd ?? null;
    lt.duration_ms = durees[lt.id] != null ? durees[lt.id] : null;
    lt.todo_waiting = !!db.prepare(`SELECT 1 FROM todo
      WHERE auto_kind = 'local_question' AND auto_ref = ? AND status = 'open' AND archived_at IS NULL`)
      .get(String(lt.id));
  }
  res.json(list);
}));
app.post('/api/local-tasks', wrap((req, res) => {
  const { prompt, dirs, images, session_id, label, ask_questions } = req.body || {};
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const sessionId = normalizeSessionId(session_id);
  const list = (Array.isArray(dirs) ? dirs : []).map((d) => String(d || '').trim()).filter(Boolean);
  if (!list.length) throw new Error(t('err.local-dirs-required'));
  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO local_task (prompt, label, ask_questions, shared, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'new', ?, ?)`)
    .run(prompt.trim(), lireLibelle(label), ask_questions ? 1 : 0,
      req.body && req.body.shared ? 1 : 0, now, now).lastInsertRowid;
  // Même principe que pour les sessions sur dépôt : la session fournie est rangée comme
  // si la première passe l'avait créée, `localcoder` la reprend alors sans rien savoir.
  /* `path` reste à la chaîne vide : la colonne est `NOT NULL` depuis l'origine, et elle est
     GELÉE — le chemin vit désormais dans `local_dir_map`, sur le poste qui le connaît. */
  const ins = db.prepare(`INSERT INTO local_task_dir (task_id, path, dir_hash, dir_label, owner, status, updated_at)
    VALUES (?, '', ?, ?, ?, 'new', ?)`);
  const moi = identite.nom() || null;
  for (const p of [...new Set(list)]) {
    const { dir_hash: h, dir_label: lbl } = localdirs.declarer(p);
    const rowid = ins.run(id, h, lbl, moi, now).lastInsertRowid;
    /* Le handle fourni à la création est rangé comme si la première passe l'avait produit :
       `localcoder` le reprend alors sans rien savoir. Il vit dans `local_session` — il ne vaut
       que sur cette machine. */
    if (sessionId) {
      const uid = db.prepare('SELECT uid FROM local_task_dir WHERE id = ?').get(rowid).uid;
      localsession.ecrire('local_task_dir', uid, { session_key: sessionId, session_backend: agentsession.backendName() });
    }
  }
  savePiecesEtImages('local', id, req.body || {}); // captures et documents (facultatif)
  res.json(localTaskById(id));
}));
// Détail d'une session hors dépôt (édition) — pendant de GET /api/tasks/:id.
app.get('/api/local-tasks/:id', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  res.json({ task: lt, images: piecesExposees('local', lt.id) });
}));
/* Édition d'une session hors dépôt — même contrat que PUT /api/tasks/:id.
   Les dossiers ne sont RECRÉÉS que si leur composition change : sinon on perdrait avec eux
   le statut de chaque dossier, le retour de l'agent et surtout le handle de session — une
   correction de faute de frappe dans le prompt repartirait de zéro. */
app.put('/api/local-tasks/:id', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const { prompt, dirs, images, session_id, label, ask_questions } = req.body || {};
  const sessionId = normalizeSessionId(session_id);
  if (Array.isArray(dirs) && dirs.length) {
    const list = [...new Set(dirs.map((d) => String(d || '').trim()).filter(Boolean))];
    if (!list.length) throw new Error(t('err.local-dirs-required'));
    if (list.join('|') !== lt.dirs.map((d) => d.path).join('|')) {
      const now = new Date().toISOString();
      db.prepare('DELETE FROM local_task_dir WHERE task_id = ?').run(lt.id);
      const ins = db.prepare(`INSERT INTO local_task_dir (task_id, path, dir_hash, dir_label, owner, status, updated_at)
        VALUES (?, '', ?, ?, ?, 'new', ?)`);
      const moi = identite.nom() || null;
      for (const p of list) {
        const { dir_hash: h, dir_label: lbl } = localdirs.declarer(p);
        ins.run(lt.id, h, lbl, moi, now);
      }
    }
  }
  if (prompt != null && !String(prompt).trim()) throw new Error(t('err.prompt-requis'));
  db.prepare('UPDATE local_task SET prompt = ?, label = ?, ask_questions = ?, updated_at = ? WHERE id = ?')
    .run(prompt != null ? String(prompt).trim() : lt.prompt,
      label === undefined ? lt.label : lireLibelle(label),
      // Absent du body → on garde la valeur actuelle, comme pour les sessions sur dépôt.
      ask_questions == null ? lt.ask_questions : (ask_questions ? 1 : 0),
      new Date().toISOString(), lt.id);
  savePiecesEtImages('local', lt.id, req.body || {});
  applySessionId('local_task_dir', 'task_id', lt.id, sessionId, localDirsFor(lt.id));
  res.json(localTaskById(lt.id));
}));
app.post('/api/local-tasks/:id/run', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const dirIds = normalizeDirIds(lt.id, req.body && req.body.dirs);
  res.json(jobs.startLocalJob(lt.id, dirIds ? { dirIds } : {}));
}));
// Demande de correction : nouvelle passe de l'IA sur les mêmes dossiers, en REPRENANT
// la session de chacun (l'IA garde le contexte du travail qu'elle vient de produire).
/* Réponses aux questions de l'agent, hors dépôt. Même contrat que la route des sessions sur
   dépôt — mais les questions vivent sur le DOSSIER, qui a sa propre session d'agent : on ne
   reprend que celui-là, les autres dossiers n'ont rien demandé. */
app.post('/api/local-tasks/:id/dirs/:did/answer', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const d = (lt.dirs || []).find((x) => x.id === Number(req.params.did));
  if (!d) throw new Error(t('err.local-dir-not-found'));
  if (d.status !== 'needs_input') throw new Error(t('err.session-pas-en-attente'));

  /* RÉPONDU AILLEURS — voir la route jumelle des sessions de dépôt. Ici, rien à inspecter :
     l'agent travaille EN PLACE, il n'y a ni branche ni commit à interroger. Le dossier est donc
     rendu à l'état « fait », et ce qu'il contient est ce que le terminal en a fait. */
  if (req.body && req.body.elsewhere) {
    db.prepare("UPDATE local_task_dir SET questions_json = NULL, status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), d.id);
    const attendent = db.prepare("SELECT COUNT(*) c FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'")
      .get(lt.id).c;
    if (!attendent) notes.fermerTodoAuto('local_question', lt.id);
    localcoder.syncStatus(lt.id);   // le statut de la session suit celui de ses dossiers
    return res.json({ ok: true, task: localTaskById(lt.id) });
  }

  let qs = [];
  try { qs = d.questions_json ? JSON.parse(d.questions_json) : []; } catch { qs = []; }
  const answers = (req.body && req.body.answers) || {};
  let filled = 0;
  qs = qs.map((q) => {
    const a = answers[q.id];
    if (a != null && String(a).trim()) { filled += 1; return { ...q, answer: String(a).trim(), answeredAt: new Date().toISOString() }; }
    return q;
  });
  if (!filled) throw new Error(t('err.reponses-manquantes'));
  // On quitte `needs_input` DÈS l'envoi : sinon un rechargement ré-affiche un formulaire déjà rempli.
  db.prepare("UPDATE local_task_dir SET questions_json = ?, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(qs), new Date().toISOString(), d.id);
  /* La todo ne se referme que si plus AUCUN dossier n'attend : sur une session à cinq
     dossiers, répondre au premier ne solde pas le travail. */
  const encore = db.prepare("SELECT COUNT(*) c FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'")
    .get(lt.id).c;
  if (!encore) notes.fermerTodoAuto('local_question', lt.id);
  res.json(jobs.startLocalJob(lt.id, { answersDirId: d.id }));
}));
app.post('/api/local-tasks/:id/followup', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim() || lt.followup_draft || '';
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  // Même geste que sur une session de dépôt : une capture peut accompagner la demande.
  const imageIds = savePiecesEtImages('local', lt.id, req.body || {}, { followup: 1 });
  res.json(envoyerSuivi('local_task', lt, () => jobs.startLocalJob(lt.id,
    { instruction, ...(imageIds.length ? { imageIds } : {}) })));
}));
// Suivi en attente d'une session hors dépôt — même contrat que POST /tasks/:id/followup-draft.
app.put('/api/local-tasks/:id/followup-draft', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  poserSuivi('local_task', lt.id, req.body && req.body.instruction, req.body && req.body.auto);
  const apres = localTaskById(lt.id);
  res.json({ ok: true, followup_draft: apres.followup_draft, followup_auto: apres.followup_auto });
}));
// Historique des itérations d'un dossier hors dépôt (même forme que côté session).
app.get('/api/local-tasks/:id/dirs/:did/passes', wrap((req, res) => {
  const d = localdirs.resoudre(db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?')
    .get(Number(req.params.did), Number(req.params.id)));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  res.json(passesPayload('local', d.id, Number(req.params.id), req.query.n, d.path, d.output_path));
}));
/* LE DIFF D'UNE ITÉRATION HORS DÉPÔT. Mêmes trois routes, même viewer, même forme que côté
   dépôt : seule la provenance du patch change. Ici il n'y a ni branche ni commit dans le
   dossier de l'utilisateur — les deux bornes sont des commits du dépôt de SUIVI, qui vit dans
   le dossier de travail de Mergerie (`localsnapshot`), et c'est lui qu'on interroge. */
function dossierLocalOu404(taskId, dirId) {
  const d = localdirs.resoudre(db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?').get(Number(dirId), Number(taskId)));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  return d;
}
function ctxPasseLocale(taskId, d, p) {
  const gitdir = localsnapshot.dossierSuivi(Number(taskId), d.id);
  if (!fs.existsSync(gitdir)) throw new Error(t('err.task.pass-no-diff'));
  return { cwd: gitdir, ref: p.head_sha, target: p.base_sha, shaRange: true };
}
function passeLocaleDe(taskId, d, n) {
  const p = agentpass.get('local', Number(taskId), d.id, Number(n));
  if (!p) throw new Error(t('err.task.pass-not-found'));
  return p;
}
app.get('/api/local-tasks/:id/dirs/:did/passes/:n/diffview', wrap(async (req, res) => {
  const d = dossierLocalOu404(req.params.id, req.params.did);
  const p = passeLocaleDe(req.params.id, d, req.params.n);
  /* Hors dépôt : le dossier EST le dépôt quand il en est un. `ctxPasseLocale` sait où il vit. */
  const diff = await diffDePasse(p, ctxPasseLocale(req.params.id, d, p).cwd);
  res.json({
    ...(await viewerPayload(ctxPasseLocale(req.params.id, d, p), { diff, source: d.path })),
    project: d.path, branch: '',
    pass: { n: p.n, kind: p.kind, titre: p.titre || '', prompt: p.prompt || '' },
  });
}));
app.get('/api/local-tasks/:id/dirs/:did/passes/:n/file', wrap(async (req, res) => {
  const d = dossierLocalOu404(req.params.id, req.params.did);
  const p = passeLocaleDe(req.params.id, d, req.params.n);
  res.json(await viewerFile(ctxPasseLocale(req.params.id, d, p), String(req.query.path || '')));
}));
app.get('/api/local-tasks/:id/dirs/:did/passes/:n/filediff', wrap(async (req, res) => {
  const d = dossierLocalOu404(req.params.id, req.params.did);
  const p = passeLocaleDe(req.params.id, d, req.params.n);
  res.json(await viewerFileDiff(ctxPasseLocale(req.params.id, d, p), String(req.query.path || '')));
}));
// Retour de l'agent pour UN dossier (ce qu'il dit avoir fait).
app.get('/api/local-tasks/:id/dirs/:did/output', wrap((req, res) => {
  const d = localdirs.resoudre(db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?')
    .get(Number(req.params.did), Number(req.params.id)));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  res.json({ output: d.output_path ? readFileSafe(d.output_path) : null, path: d.path });
}));
app.delete('/api/local-tasks/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const aSupprimer = localTaskById(id);
  if (aSupprimer) exigerProprietaire('local_task', aSupprimer);
  agentpass.removeTask('local', id);                     // pas de FK : nettoyage explicite
  pieces.removeOwner('local', id);
  db.prepare('DELETE FROM local_task WHERE id = ?').run(id); // cascade sur dirs + images
  try { fs.rmSync(path.join(TASKS_DIR, 'local', String(id)), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));
// Ranger / ressortir une session hors dépôt — pendant de POST /tasks/:id/hidden.
app.post('/api/local-tasks/:id/share', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const shared = basculerPartage('local_task', 'local', lt, req.body && req.body.shared);
  res.json({ ok: true, shared, task: localTaskById(lt.id) });
}));
app.post('/api/local-tasks/:id/hidden', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  prefLocale.ecrire('local_task', lt.uid, 'hidden', hidden ? '1' : null);
  db.prepare('UPDATE local_task SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), lt.id);
  res.json({ ok: true, hidden });
}));
app.post('/api/local-tasks/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE local_task SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
