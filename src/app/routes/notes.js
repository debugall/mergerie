'use strict';
/* Les notes, les todos, les rappels et le brief du matin.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const store = require('../../data/store');
const datasync = require('../../data/datasync');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const jira = require('../../integrations/jira');
const notes = require('../../notes/notes');
const brief = require('../../notes/brief');
const demoDocker = require('../../demo/docker');
const veille = require('../../integrations/veille');
const path = require('path');
const fs = require('fs');
const { servirFichierNonFiable } = require('../fichiers');
const { wrap } = require('../http');
const { auteurDeLigne, auteurs, exigerProprietaire } = require('../lib/partage');
const { decodeDataUrlImage } = require('../lib/pieces');
const { dernieresVerificationsParMr } = require('../lib/verifications');

/* ---------- Notes, todos, rappels et brief (plan_add_notes.md) --------------
   Tout est local : rien ne part vers l'agent ni vers une forge. Les messages d'erreur
   traversent `t()` comme partout ailleurs — ils s'affichent tels quels dans l'interface. */

// Les libellés d'erreur passés à src/notes.js. Regroupés parce que les mêmes servent à la
// création et à l'édition : les dupliquer aux deux endroits les ferait diverger.
const msgNotes = () => ({
  titreVide: t('err.notes.title-required'),
  inconnue: t('err.notes.unknown'),
  prioriteInvalide: t('err.notes.priority-invalid'),
  statutInvalide: t('err.notes.status-invalid'),
  dateInvalide: t('err.notes.due-invalid'),
  lienInvalide: t('err.notes.link-invalid'),
  tropProfond: t('err.notes.parent-too-deep'),
  soiMeme: t('err.notes.parent-self'),
});
/* QUI A PARTAGÉ. L'auteur d'un objet partagé est celui qui a commité son fichier (git le sait,
   voir `auteurs`) : on le sert pour les pages et les todos comme pour les sessions, sur la ligne
   COMPLÈTE — la liste des pages ne porte pas le slug qui nomme le fichier. */
function auteursPartages(table, lignes, relire) {
  const partagees = lignes.filter((x) => x.shared);
  if (!partagees.length) return new Map();
  return auteurs(table, partagees.map((x) => relire(x.id)).filter(Boolean));
}
app.get('/api/notes', wrap((req, res) => {
  const pages = notes.listerPages(req.query.q);
  const parQui = auteursPartages('note_page', pages, notes.lirePage);
  res.json({ pages: pages.map((p) => ({ ...p, author: parQui.get(p.id) || null })) });
}));
app.post('/api/notes', wrap((req, res) => {
  res.json(notes.creerPage(req.body || {}, msgNotes()));
}));
/* B4 — LE SENS INVERSE DE L'AUTOLIEN : qui, dans les notes, parle de cet objet. Une note
   mène à la merge request depuis toujours ; la merge request ignorait qu'on avait écrit trois
   paragraphes sur elle. La règle de « citer » est celle du rendu, pas un second `LIKE` qui
   dériverait (cf. `notes.citations`). */
/* L'HISTOIRE D'UNE PAGE — ce que git rend gratuitement.
 *
 * Une page de notes est un fichier du dépôt de données : son historique existe déjà, avec son
 * auteur et sa date, sans qu'on ait eu à tenir une table de versions. On le montre, et c'est
 * tout ce que cette route fait. Sans dépôt de données, elle rend une liste vide plutôt qu'une
 * erreur : l'écran affiche alors « pas d'historique ici », ce qui est la vérité.
 *
 * Déclarée AVANT `/api/notes/:id` — Express prendrait sinon « citations » ou « history » pour
 * un identifiant, comme le rappelle la route voisine. */
app.get('/api/notes/:id/history', wrap(async (req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  const fichier = `notes/${page.slug}.md`;
  const sha = String(req.query.sha || '').trim();
  if (sha) return res.json({ sha, diff: await datasync.diffDe(fichier, sha) });
  res.json({ file: fichier, commits: await datasync.historique(fichier) });
}));
app.get('/api/notes/citations', wrap((req, res) => {
  const mr = req.query.mr ? Number(req.query.mr) : null;
  const ticket = String(req.query.ticket || '').trim();
  if (!mr && !ticket) throw new Error(t('err.citations-sans-cible'));
  res.json({ pages: notes.citations({ mr, ticket }) });
}));
/* Déclarée AVANT `/api/notes/:id` : Express prendrait sinon « citations » pour un identifiant
   de page, et la route ne répondrait jamais. */

app.get('/api/notes/:id', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  /* Ses sous-pages, et le titre de son parent si c'en est une : l'écran a besoin des deux
     pour se situer, et un second aller-retour par page ouverte se verrait à la frappe. */
  const parent = page.parent_id ? notes.lirePage(page.parent_id) : null;
  res.json({
    ...page, children: notes.sousPages(page.id), parent_title: parent ? parent.title : null,
    author: page.shared ? auteurDeLigne('note_page', page) : null,
  });
}));
/* NE PLUS PARTAGER OU SUPPRIMER UNE PAGE, UNE TODO PARTAGÉES : l'auteur seul, comme pour les
   sessions. Ces deux gestes retirent le fichier du dépôt, donc de chez tout le monde — depuis le
   poste d'un collègue, c'était effacer son travail. Le modifier reste permis : c'est un wiki. */
function exigerAuteurSiRetrait(table, row, body) {
  if (!row || !row.shared) return;
  if (body === null || ('shared' in body && !body.shared)) exigerProprietaire(table, row);
}
app.put('/api/notes/:id', wrap((req, res) => {
  const { base_updated_at: base, ...corps } = req.body || {};
  const avant = notes.lirePage(req.params.id);
  exigerAuteurSiRetrait('note_page', avant, corps);
  /* LA PAGE A-T-ELLE CHANGÉ DEPUIS QUE L'ÉDITEUR L'A CHARGÉE ? Une synchro a pu apporter la
     version d'un collègue pendant qu'on écrivait : l'autosauvegarde l'écrasait alors en
     silence. L'éditeur envoie la date de ce qu'il a sous les yeux ; différente, on refuse et on
     rend la version actuelle — c'est à la personne de choisir, pas à l'ordre des requêtes. */
  if (base && avant && String(avant.updated_at) !== String(base)) {
    throw Object.assign(new Error(t('err.notes.changed')), {
      status: 409, code: 'PAGE_MODIFIEE',
      extra: { page: avant, author: auteurDeLigne('note_page', avant) },
    });
  }
  res.json(notes.majPage(req.params.id, corps, msgNotes()));
}));
app.delete('/api/notes/:id', wrap((req, res) => {
  exigerAuteurSiRetrait('note_page', notes.lirePage(req.params.id), null);
  // Les lignes partent en cascade ; les FICHIERS, eux, resteraient sur le disque.
  const dossier = path.join(NOTES_DIR, String(Number(req.params.id) || 0));
  const out = notes.supprimerPage(req.params.id, msgNotes());
  try { fs.rmSync(dossier, { recursive: true, force: true }); } catch { /* déjà parti */ }
  res.json(out);
}));
/* CAPTURES D'UNE PAGE DE NOTES. Le fichier sur disque, un lien Markdown dans la page : coller
   une image en base64 dans le contenu gonflerait la ligne de plusieurs mégaoctets, renvoyés en
   entier à chaque sauvegarde automatique — donc à peu près toutes les secondes pendant qu'on
   écrit. Le rendu n'accepte d'ailleurs QUE cette forme d'URL, comme pour les pièces jointes
   Jira : une image dont l'adresse vient du texte de l'utilisateur ne s'affiche pas. */
app.post('/api/notes/:id/images', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  const { ext, buf } = decodeDataUrlImage((req.body && req.body.image) || '');
  const dir = ensureDir(path.join(NOTES_DIR, String(page.id)));
  const n = db.prepare('SELECT COUNT(*) c FROM note_image WHERE page_id = ?').get(page.id).c + 1;
  const file = path.join(dir, `img_${n}.${ext}`);
  fs.writeFileSync(file, buf);
  const id = db.prepare('INSERT INTO note_image (page_id, path, created_at) VALUES (?,?,?)')
    .run(page.id, file, new Date().toISOString()).lastInsertRowid;
  /* Une capture vit dans le fichier de SA PAGE — elle ne change qu'avec elle, et un conflit sur
     une image est un conflit sur la page. On réécrit donc la page, ce qui recopie aussi le
     binaire dans le dépôt de données. */
  store.rafraichir('note_page', page.id);
  res.json({ id, url: `/api/notes/${page.id}/images/${id}` });
}));
const TYPE_IMAGE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/* B6 — LA LISTE DES CAPTURES D'UNE PAGE. Elles étaient servies une par une (l'aperçu les
   demande par identifiant), mais rien ne disait CE QU'UNE PAGE PORTE : impossible, donc, de
   proposer de les joindre à une session. Une requête, pas d'appel externe. */
app.get('/api/notes/:id/images', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  res.json(db.prepare('SELECT id, path, created_at FROM note_image WHERE page_id = ? ORDER BY id').all(page.id)
    .map((im) => ({ id: im.id, name: path.basename(im.path), created_at: im.created_at })));
}));
app.get('/api/notes/:id/images/:imgId', wrap((req, res) => {
  const im = db.prepare('SELECT * FROM note_image WHERE id = ? AND page_id = ?')
    .get(Number(req.params.imgId), Number(req.params.id));
  if (!im || !fs.existsSync(im.path)) throw Object.assign(new Error(t('err.notes.image-unknown')), { status: 404 });
  res.setHeader('Cache-Control', 'private, max-age=86400');   // le contenu d'une capture ne change pas
  servirFichierNonFiable(res, { chemin: im.path, mime: TYPE_IMAGE[path.extname(im.path).slice(1).toLowerCase()] });
}));
/* Export d'une page en Markdown. Le nom du fichier est SLUGIFIÉ depuis le titre : un titre
   porte des espaces, des accents et parfois un `/` — `Content-Disposition` n'est pas
   l'endroit où découvrir qu'un nom de page contenait une traversée de chemin. */
app.get('/api/notes/:id/export', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${notes.slugifier(page.title)}.md"`);
  res.send(`# ${page.title}\n\n${page.content || ''}\n`);
}));
/* CE QUE LA MERGE REQUEST LIÉE EST DEVENUE. « Suivre !201 » restait dans la liste des mois
   après le merge : on ouvrait Reviews pour vérifier, puis on revenait cocher. La todo porte
   donc l'état de sa merge request — note, verdict, âge, et si elle est fermée. Une requête
   pour toute la liste : ces lignes se redessinent à chaque ouverture de l'onglet. */
function etatMrDesTodos(todos) {
  const ids = [...new Set(todos.filter((x) => x.link_kind === 'mr').map((x) => Number(x.link_ref)).filter(Boolean))];
  if (!ids.length) return {};
  const trous = ids.map(() => '?').join(',');
  const out = {};
  for (const m of db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.status, mr.closed_seen, mr.gitlab_created_at,
      repo.project FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id IN (${trous})`).all(...ids)) {
    out[m.id] = { iid: m.iid, title: m.title, status: m.status, closed: !!m.closed_seen, project: m.project, created_at: m.gitlab_created_at };
  }
  for (const rv of db.prepare(`SELECT mr_id, note_value FROM review_version rv WHERE mr_id IN (${trous})
    AND version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all(...ids)) {
    if (out[rv.mr_id]) out[rv.mr_id].note = rv.note_value;
  }
  const verifs = dernieresVerificationsParMr();
  for (const id of ids) { const v = verifs.get(id); if (out[id] && v) out[id].verdict = v.verdict; }
  return out;
}
/* A/Notes 1 — CE QUE LE TICKET LIÉ EST DEVENU. Une todo « Suivre PROJ-720 » était muette là
   où sa sœur liée à une merge request dit tout : on rouvrait Jira pour savoir si elle avait
   encore une raison d'exister. Deux sources, aucune requête réseau — l'état des tickets
   surveillés, et celui rangé à la découverte sur les merge requests qui portent la clé. */
function etatTicketDesTodos(todos) {
  const cles = [...new Set(todos.filter((x) => x.link_kind === 'ticket')
    .map((x) => String(x.link_ref || '').toUpperCase()).filter(Boolean))];
  if (!cles.length) return {};
  const out = {};
  const trous = cles.map(() => '?').join(',');
  for (const w of db.prepare(`SELECT key, status, status_category FROM jira_watch WHERE UPPER(key) IN (${trous})`).all(...cles)) {
    out[String(w.key).toUpperCase()] = { status: w.status, category: w.status_category, watched: true };
  }
  for (const m of db.prepare(`SELECT mr.iid, mr.status, mr.closed_seen, mr.ticket_jira_key,
      mr.ticket_jira_status, mr.ticket_jira_category, repo.project
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE UPPER(COALESCE(mr.ticket_jira_key, '')) IN (${trous})
    ORDER BY mr.id DESC`).all(...cles)) {
    const k = String(m.ticket_jira_key).toUpperCase();
    const acc = out[k] || (out[k] = { status: null, category: null, watched: false });
    // Le statut du ticket surveillé PRIME : il est rafraîchi, celui de la découverte non.
    if (!acc.status) { acc.status = m.ticket_jira_status; acc.category = m.ticket_jira_category; }
    acc.mrs = acc.mrs || [];
    if (acc.mrs.length < 3) acc.mrs.push({ iid: m.iid, project: m.project, closed: !!m.closed_seen });
  }
  return out;
}
app.get('/api/todos', wrap((req, res) => {
  const todos = notes.listerTodos(req.query.status);
  const etats = etatMrDesTodos(todos);
  const tickets = etatTicketDesTodos(todos);
  const parQui = auteursPartages('todo', todos, (id) => todos.find((x) => x.id === id));
  res.json({
    todos: todos.map((x) => ({
      ...x,
      author: parQui.get(x.id) || null,
      mr: x.link_kind === 'mr' ? (etats[Number(x.link_ref)] || null) : null,
      ticket: x.link_kind === 'ticket' ? (tickets[String(x.link_ref || '').toUpperCase()] || null) : null,
    })),
  });
}));
app.post('/api/todos', wrap((req, res) => {
  res.json(notes.creerTodo(req.body || {}, msgNotes()));
}));
/* Réordonner la liste « à faire » : l'écran envoie l'ordre complet de ce qu'il affiche. */
app.post('/api/todos/reorder', wrap((req, res) => {
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || !ids.length) throw new Error(t('err.ordre-vide'));
  res.json({ ok: true, n: notes.reordonnerTodos(ids) });
}));
/* Édition, cocher/décocher ET snooze passent par la même route : ce sont les mêmes colonnes.
   `snooze` est traduit ici en `due_at` plutôt que côté client — « demain 9 h » doit vouloir
   dire la même chose que le rappel l'ait posé le navigateur ou le serveur. */
app.put('/api/todos/:id', wrap((req, res) => {
  const body = { ...(req.body || {}) };
  if (body.snooze) {
    const quand = notes.calculerSnooze(body.snooze);
    if (!quand) throw new Error(t('err.notes.snooze-invalid'));
    body.due_at = quand;
    delete body.snooze;
  }
  exigerAuteurSiRetrait('todo', db.prepare('SELECT * FROM todo WHERE id = ?').get(Number(req.params.id) || 0), body);
  res.json(notes.majTodo(req.params.id, body, msgNotes()));
}));
app.delete('/api/todos/:id', wrap((req, res) => {
  exigerAuteurSiRetrait('todo', db.prepare('SELECT * FROM todo WHERE id = ?').get(Number(req.params.id) || 0), null);
  res.json(notes.supprimerTodo(req.params.id, msgNotes()));
}));
// Ce qui est dû et pas encore annoncé. Le client notifie puis confirme (route ci-dessous).
app.get('/api/todos/reminders/due', wrap((req, res) => {
  res.json({ due: notes.rappelsDus() });
}));
/* Confirmation d'AFFICHAGE, envoyée par le client après la notification. Marquer à la
   lecture aurait été plus simple, mais aurait consommé l'unique occasion de prévenir quand
   la notification échoue (permission refusée, onglet fermé entre-temps). */
app.post('/api/todos/:id/reminded', wrap((req, res) => {
  res.json(notes.marquerNotifie(req.params.id, msgNotes()));
}));
/* Ce dont le RENDU a besoin pour transformer `!214` en lien : une table de résolution
   iid → dépôts, pas la liste des MR. Un même numéro pouvant exister sur plusieurs dépôts,
   on rend tous les candidats et le front décide (lien direct ou recherche pré-remplie). */
app.get('/api/notes-index', wrap((req, res) => {
  res.json({ mrs: notes.indexAutolink(), jira: demoDocker.isDemo() || jira.isConfigured(getConfig()) });
}));
app.get('/api/brief', wrap((req, res) => {
  const cfgB = getConfig();
  const d = brief.construire({
    staleDays: cfgB.stale_mr_days,
    seuilPret: cfgB.converge_threshold,
    // Ce que la veille a vu au dernier tour : le brief n'appelle jamais Docker lui-même.
    dockerDown: demoDocker.isDemo() ? demoDocker.briefTombes() : veille.dockerTombes(),
  });
  /* Les lignes de todo du brief sont les MÊMES que celles de la liste : elles portent donc le
     même état de merge request. Enrichi ici et pas dans `brief.js`, qui compose le brief et
     n'a pas à connaître les rapports de review. */
  const etats = etatMrDesTodos([...(d.reminders || []), ...(d.todos || [])]);
  const poser = (x) => ({ ...x, mr: x.link_kind === 'mr' ? (etats[Number(x.link_ref)] || null) : null });
  res.json({ ...d, reminders: (d.reminders || []).map(poser), todos: (d.todos || []).map(poser) });
}));
/* Écarter une ligne du brief. On garde l'objet ÉCARTÉ, pas le sujet : cette vérification-ci,
   cette MR-là. Le `kind` est validé contre la liste du brief — une clé inventée resterait
   sinon dans la table sans rien masquer, et personne ne saurait pourquoi. */
app.post('/api/brief/hidden', wrap((req, res) => {
  const kind = String((req.body && req.body.kind) || '');
  const ref = String((req.body && req.body.ref) || '').trim();
  if (!brief.ECARTABLES.includes(kind) || !ref) throw new Error(t('err.brief-ecart-invalide'));
  db.prepare('INSERT OR IGNORE INTO brief_hidden (kind, ref, at) VALUES (?, ?, ?)')
    .run(kind, ref, new Date().toISOString());
  res.json({ ok: true });
}));
// Tout réafficher : le geste inverse, en un bouton. Rien n'a été supprimé, il n'y a rien à
// reconstruire — c'est pour ça qu'écarter peut rester sans confirmation.
app.delete('/api/brief/hidden', wrap((req, res) => {
  const n = db.prepare('DELETE FROM brief_hidden').run().changes;
  res.json({ ok: true, restored: n });
}));
