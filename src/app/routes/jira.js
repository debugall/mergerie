'use strict';
/* Jira : tickets, statuts, commentaires, transitions, pièces jointes, tickets surveillés, badge du menu, liens de contexte d’une MR — et prévenir Jira quand une session ouvre sa MR.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { etat: etatLocal, pref: prefLocale } = require('../../data/localstate');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const jira = require('../../integrations/jira');
const notes = require('../../notes/notes');
const links = require('../../notes/links');
const demoDocker = require('../../demo/docker');
const demoJira = require('../../demo/jira');
const pieces = require('../../agent/pieces');
const tasks = require('../../agent/tasks');
const { servirFichierNonFiable } = require('../fichiers');
const { mrById, wrap } = require('../http');
const { exigerJetonFrais, noterTest } = require('../lib/connexions');
const { checkJiraWatch, engagementsSurTicket, lireJiraBadge, lireNote, marquerVu, prevenirJira, refreshJiraBadge, sprintFieldId, statutsParProjet, watchRows } = require('../lib/jira');
const { targetById } = require('../lib/sessions');

// Test de la connexion Jira : récupère un ticket témoin pour valider URL/email/token.
app.post('/api/jira/test', wrap(async (req, res) => {
  const cfg = getConfig();
  // Le front peut renvoyer le masque : on teste alors avec le token déjà en base.
  const test = { ...cfg };
  if (req.body && req.body.jira_url) exigerJetonFrais(req.body.jira_url, cfg.jira_url, req.body.jira_token, cfg.jira_token);
  if (req.body && req.body.jira_url) test.jira_url = req.body.jira_url;
  if (req.body && req.body.jira_email) test.jira_email = req.body.jira_email;
  if (req.body && req.body.jira_token && req.body.jira_token !== '***') test.jira_token = req.body.jira_token;
  if (!jira.isConfigured(test)) throw new Error(t('err.jira.not-configured'));
  const key = String((req.body && req.body.key) || '').trim();
  if (!key) throw new Error(t('err.jira.test-key-required'));
  try {
    const issue = await jira.fetchIssue(test, key);
    noterTest('jira', true, issue.key);
    res.json({ ok: true, key: issue.key, summary: issue.summary });
  } catch (e) { noterTest('jira', false, e.message); throw e; }
}));
// Onglet Jira → filtre par assigné : « moi » + les personnes ayant des tickets assignés récents
// (pour cocher qui afficher). `not-configured` renvoie { configured:false } (pas une 400).
app.get('/api/jira/assignees', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ configured: true, ...demoJira.assignees() });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, me: null, people: [] });
  res.json({ configured: true, ...(await jira.listAssignees(cfg)) });
}));
app.get('/api/jira/statuses', wrap(async (req, res) => {
  const cles = [...new Set(String(req.query.projects || '').split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 20);
  if (demoDocker.isDemo()) return res.json({ configured: true, statuses: demoJira.projectStatuses(cles) });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, statuses: [] });
  const par = new Map();
  for (const cle of cles) {
    if (!statutsParProjet.has(cle)) {
      /* Un projet inaccessible ne doit pas priver le filtre des statuts des autres. L'échec
         n'est PAS mémorisé : une panne passagère aurait vidé ce filtre jusqu'au redémarrage. */
      try { statutsParProjet.set(cle, await jira.projectStatuses(cfg, cle)); }
      catch { /* on retentera au prochain chargement */ }
    }
    for (const st of statutsParProjet.get(cle) || []) if (!par.has(st.name)) par.set(st.name, st);
  }
  res.json({ configured: true, statuses: [...par.values()] });
}));
app.get('/api/jira/tickets', wrap(async (req, res) => {
  const accountIds = String(req.query.assignees || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Statuts décochés : exclus par Jira, pour ne pas trier un extrait déjà plafonné.
  const hideStatuses = String(req.query.hideStatuses || '').split('\u001f').map((x) => x.trim()).filter(Boolean);
  // Sprints choisis : mêmes règles que les projets — la contrainte part dans la requête.
  const sprints = String(req.query.sprints || '').split(',').map((x) => x.trim()).filter(Boolean);
  // Projets choisis dans le filtre : appliqués par Jira, pas après coup (cf. searchByAssignees).
  const projects = String(req.query.projects || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (demoDocker.isDemo()) return res.json({ configured: true, ...demoJira.tickets(accountIds, req.query.includeDone === '1', projects, sprints, hideStatuses) });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, issues: [], total: 0 });
  res.json({ configured: true, ...(await jira.searchByAssignees(cfg, {
    accountIds, includeDone: req.query.includeDone === '1', projects, sprints, hideStatuses,
    sprintField: await sprintFieldId(cfg),
  })) });
}));
// Détail d'un ticket Jira : métadonnées + description + commentaires + pièces jointes.
app.get('/api/jira/issue/:key', wrap(async (req, res) => {
  const key = String(req.params.key || '').trim();
  /* Les merge requests qui portent ce ticket : la zone de commentaire propose d'en insérer le
     lien. L'écran les lisait ici sans que la route les ait jamais servies. */
  const mergerie = {
    mrs: engagementsSurTicket(key).mrs.filter((m) => !m.closed && m.web_url)
      .map((m) => ({ iid: m.iid, url: m.web_url })),
  };
  if (demoDocker.isDemo()) return res.json({ issue: { ...demoJira.issue(key), mergerie } });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  res.json({ issue: { ...(await jira.issueDetail(cfg, key)), mergerie } });
}));
// Poster un commentaire sur un ticket Jira.
app.post('/api/jira/issue/:key/comment', wrap(async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) throw new Error(t('err.jira.comment-empty'));
  if (demoDocker.isDemo()) return res.json({ comment: { author: 'Toi (démo)', created: new Date().toISOString(), bodyMd: text } });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  res.json({ comment: await jira.addComment(cfg, String(req.params.key || '').trim(), text) });
}));
// Changer l'ÉTAT d'un ticket : applique une transition Jira (les transitions possibles sont
// dans le détail du ticket).
app.post('/api/jira/issue/:key/transition', wrap(async (req, res) => {
  if (demoDocker.isDemo()) {
    return res.json({ ...demoJira.applyTransition(String(req.params.key || '').trim(), (req.body && req.body.transitionId) || ''), demo: true });
  }
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const id = String((req.body && req.body.transitionId) || '');
  const r = await jira.transitionIssue(cfg, String(req.params.key || '').trim(), id);
  /* Le compteur du menu vient d'un cache rafraîchi par le timer : après un changement d'état
     fait DEPUIS l'outil, on sait qu'il est périmé. On le recalcule avant de répondre, pour que
     la relecture qui suit côté client tombe déjà sur la bonne valeur. Best-effort : une
     transition réussie ne doit pas être signalée en échec parce que le recomptage a raté. */
  try { await refreshJiraBadge(); } catch { /* compteur : jamais bloquant */ }
  res.json(r);
}));
// Téléchargement PROXY d'une pièce jointe Jira (le lien direct exigerait l'auth Basic dans le
// navigateur) : le serveur récupère le fichier avec le token et le renvoie tel quel.
app.get('/api/jira/attachment/:id', wrap(async (req, res) => {
  let file;
  if (demoDocker.isDemo()) file = demoJira.attachmentFile(req.params.id);
  else {
    const cfg = getConfig();
    if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
    file = await jira.downloadAttachment(cfg, req.params.id);
  }
  // Une image `image/svg+xml` peut porter du <script> : elle part en `attachment` (servirFichierNonFiable).
  servirFichierNonFiable(res, { buffer: file.buffer, nom: file.filename, mime: file.mimeType });
}));
// Récupère un ticket Jira par son numéro et renvoie son contexte prêt à injecter
// (titre + description en Markdown). Utilisé pour enrichir une session de dev.
app.post('/api/jira/fetch', wrap(async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  if (!key) throw new Error(t('err.jira.test-key-required'));
  // En démo, comme les autres routes Jira : le contexte vient du jeu fictif, sinon
  // « Faire coder l'IA » et « Récupérer » seraient les seuls boutons Jira inertes.
  /* B10 : les PIÈCES JOINTES viennent avec le contexte. La modale de session les propose en
     cases à cocher ; elles ne sont téléchargées qu'à la création, et seulement si on coche. */
  const pieces = (liste) => (liste || []).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType }));
  if (demoDocker.isDemo()) {
    const d = demoJira.issue(key);
    const body = [`# ${d.summary}`, '', d.descriptionMd || ''].join('\n');
    return res.json({ key: d.key, summary: d.summary, context: body, attachments: pieces(d.attachments) });
  }
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const issue = await jira.fetchIssue(cfg, key);
  res.json({
    key: issue.key, summary: issue.summary, context: jira.issueToContext(issue),
    attachments: pieces(issue.attachments),
  });
}));
app.get('/api/jira/watch', wrap((req, res) => {
  const cfg = getConfig();
  const demo = demoDocker.isDemo();
  // L'URL est construite ici, où la configuration Jira est connue — comme pour les tickets.
  const lien = (key) => (demo ? demoJira.issueUrl(key) : (jira.isConfigured(cfg) ? jira.issueUrl(cfg, key) : null));
  res.json({
    configured: demo || jira.isConfigured(cfg),
    watched: watchRows().map((r) => ({ ...r, url: lien(r.key) })),
  });
}));
app.post('/api/jira/watch', wrap(async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  if (!jira.cleValide(key)) throw new Error(t('err.jira.watch-key-invalid'));
  if (db.prepare('SELECT 1 FROM jira_watch WHERE key = ?').get(key)) throw new Error(t('err.jira.watch-exists'));
  const now = new Date().toISOString();
  // État de départ : celui du ticket maintenant. C'est ce qui évite la fausse notification.
  let meta = null;
  if (demoDocker.isDemo()) { const d = demoJira.issue(key); meta = d && { summary: d.summary, status: d.status, statusCategory: d.statusCategory }; }
  else {
    const cfg = getConfig();
    if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
    meta = (await jira.statusOfKeys(cfg, [key]))[0] || null;
    if (!meta) throw new Error(t('err.jira.watch-not-found', { key }));
  }
  db.prepare(`INSERT INTO jira_watch (key, summary, status, status_category, added_at, note)
              VALUES (?,?,?,?,?,?)`)
    .run(key, meta.summary || '', meta.status || '', meta.statusCategory || '', now,
      lireNote(req.body && req.body.note));
  marquerVu(key);
  res.json(watchRows().find((r) => r.key === key));
}));
/* La raison de surveiller change avec le temps — le ticket avance, on suit autre chose. Elle
   se corrige donc sans retirer puis ré-ajouter le ticket, ce qui perdrait sa date d'ajout et
   son dernier état connu (et déclencherait une fausse notification au passage suivant). */
app.patch('/api/jira/watch/:key', wrap((req, res) => {
  const key = String(req.params.key || '').trim().toUpperCase();
  const ligne = db.prepare('SELECT 1 FROM jira_watch WHERE key = ?').get(key);
  if (!ligne) throw new Error(t('err.jira.watch-unknown', { key }));
  /* Deux champs indépendants : on peut changer le motif sans toucher à la case, et
     inversement. `undefined` = « ne touche pas », comme partout ailleurs dans les PATCH. */
  if ((req.body || {}).note !== undefined) {
    db.prepare('UPDATE jira_watch SET note = ? WHERE key = ?').run(lireNote(req.body.note), key);
  }
  if ((req.body || {}).todo_on_change !== undefined) {
    db.prepare('UPDATE jira_watch SET todo_on_change = ? WHERE key = ?').run(req.body.todo_on_change ? 1 : 0, key);
  }
  res.json(watchRows().find((r) => r.key === key));
}));
app.delete('/api/jira/watch/:key', wrap((req, res) => {
  const cle = String(req.params.key || '').trim().toUpperCase();
  db.prepare('DELETE FROM jira_watch WHERE key = ?').run(cle);
  /* Ménage EXPLICITE : `local_state` n'a pas de clé étrangère (quatre parents possibles), donc
     rien ne cascade. Une ligne orpheline reviendrait hanter le ticket s'il était re-surveillé. */
  etatLocal.oublier('jira_watch', cle);
  res.json({ ok: true });
}));
app.get('/api/jira/issues/:key/mergerie', wrap((req, res) => {
  /* B4 — et les notes qui citent la clé. Même mécanique que sur le rapport de review : le
     lien existait de la note vers le ticket, jamais du ticket vers la note. */
  res.json({ ...engagementsSurTicket(req.params.key), citations: notes.citations({ ticket: req.params.key }) });
}));
/* Le même relevé, en RACCOURCI, pour toute une liste de tickets : « !218 · 7,9 » ou « session
   en cours » en pied de carte, pour voir en parcourant ses tickets lesquels ont déjà avancé
   côté code. Un appel pour la liste entière, jamais un par carte. */
app.get('/api/jira/engagements', wrap((req, res) => {
  const cles = String(req.query.keys || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 60);
  const out = {};
  for (const cle of cles) {
    const d = engagementsSurTicket(cle);
    const enCours = d.tasks.filter((x) => ['running', 'needs_input'].includes(x.status)).length;
    if (!d.mrs.length && !d.tasks.length) continue;
    out[cle.toUpperCase()] = {
      mr: d.mrs[0] ? { iid: d.mrs[0].iid, note: d.mrs[0].note, closed: d.mrs[0].closed } : null,
      mrs: d.mrs.length, tasks: d.tasks.length, running: enCours,
    };
  }
  res.json({ engagements: out });
}));
app.post('/api/jira/watch/check', wrap(async (req, res) => { res.json(await checkJiraWatch()); }));
// Compteur « en cours qui me sont affectés » : valeur en cache, jamais un appel Jira ici.
app.get('/api/jira/badge', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ configured: true, inProgress: demoJira.inProgressMine(), error: null });
  res.json({ configured: jira.isConfigured(getConfig()), ...lireJiraBadge() });
}));
// Rafraîchir le contexte Jira d'une MR à la demande (bonus des champs séparés :
// ne touche jamais au contexte manuel).
// Projets liés d'une MR : remplace l'ensemble des liens (comme le save du contexte).
// Liens PAR DÉFAUT d'un dépôt : remplace l'ensemble. Utilisés pour pré-remplir
// automatiquement les projets liés des futures MR de ce dépôt.
app.post('/api/repos/:id/links', wrap((req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.params.id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];
  const del = db.prepare('DELETE FROM repo_link WHERE repo_id = ?');
  const ins = db.prepare('INSERT INTO repo_link (repo_id, linked_repo_id, branch) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(repo.id);
    for (const l of links) {
      const lid = Number(l.repo_id);
      if (!lid || lid === repo.id) continue; // ignore vide + auto-lien
      if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(lid)) continue;
      ins.run(repo.id, lid, String(l.branch || '').trim() || null);
    }
  });
  tx();
  res.json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM repo_link WHERE repo_id = ?').get(repo.id).c });
}));
app.post('/api/mrs/:id/links', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];
  const del = db.prepare('DELETE FROM mr_link WHERE mr_id = ?');
  const ins = db.prepare('INSERT INTO mr_link (mr_id, repo_id, branch) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(mr.id);
    for (const l of links) {
      const repoId = Number(l.repo_id);
      if (!repoId || repoId === mr.repo_id) continue; // ignore vide + auto-lien
      if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) continue;
      ins.run(mr.id, repoId, String(l.branch || '').trim() || null);
    }
  });
  tx();
  res.json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM mr_link WHERE mr_id = ?').get(mr.id).c });
}));
app.post('/api/mrs/:id/jira-refresh', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const key = jira.ticketKey(mr.title, mr.source_branch);
  if (!key) throw new Error(t('err.jira.no-key'));
  const now = new Date().toISOString();
  try {
    const issue = await jira.fetchIssue(cfg, key);
    const text = jira.issueToContext(issue);
    db.prepare('UPDATE mr SET ticket_jira_text = ?, ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = NULL WHERE id = ?')
      .run(text || null, issue.key, now, mr.id);
    res.json({ ok: true, key: issue.key, text });
  } catch (e) {
    db.prepare('UPDATE mr SET ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = ? WHERE id = ?')
      .run(key, now, String(e.message).slice(0, 300), mr.id);
    throw e;   // remonte l'erreur au front pour l'afficher
  }
}));
/* B2 — MERGER FERME LA BOUCLE JIRA. « Prévenir Jira » n'existait qu'à la CRÉATION de la merge
   request : une fois mergée, on ouvrait Jira, on cherchait le ticket, on le passait à l'état
   suivant, on collait le lien. Trois fois par jour. Le geste est le même que pour une session
   — même commentaire, même transition lue chez Jira et jamais devinée — mais la source est une
   merge request, pas un projet de session. */
app.post('/api/mrs/:id/notify-jira', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const repo = db.prepare('SELECT project FROM repo WHERE id = ?').get(mr.repo_id) || {};
  res.json(await prevenirJira({
    branch: mr.ticket_jira_key || mr.source_branch || '',
    project: repo.project || '',
    mr_iid: mr.iid,
    mr_url: mr.web_url || '',
  }));
}));
app.post('/api/tasks/:id/targets/:tid/notify-jira', wrap(async (req, res) => {
  const cible = targetById(Number(req.params.id), Number(req.params.tid));
  if (!cible) throw new Error(t('err.session-introuvable'));
  res.json(await prevenirJira(cible));
}));
app.get('/api/tasks/:id/targets/:tid/links', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw Object.assign(new Error(t('err.links.unknown')), { status: 404 });
  res.json(links.liensDeMr({ repo_id: tg.repo_id, source_branch: tg.branch, iid: tg.mr_iid || null }));
}));
/* ET SUR UN TICKET JIRA. Le dépôt n'y est pas écrit : on le déduit de ce qui est déjà
   engagé — la merge request qui porte la clé, sinon la session de codage. Rien de deviné :
   sans engagement, il n'y a pas de boutons, et c'est exact. */
app.get('/api/jira/issues/:key/links', wrap((req, res) => {
  const d = engagementsSurTicket(req.params.key);
  const mr = d.mrs[0] ? mrById(d.mrs[0].id) : null;
  if (mr) { res.json(links.liensDeMr(mr)); return; }
  const tache = d.tasks[0]
    ? db.prepare(`SELECT tt.repo_id, tt.branch, tt.mr_iid FROM task_target tt
      WHERE tt.task_id = ? ORDER BY tt.id LIMIT 1`).get(d.tasks[0].id)
    : null;
  if (!tache) { res.json({ service: null, envs: [], context: [] }); return; }
  res.json(links.liensDeMr({ repo_id: tache.repo_id, source_branch: tache.branch, iid: tache.mr_iid || null }));
}));
