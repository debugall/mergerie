'use strict';
/* Le reste d’une merge request : résumé, commits périmés, versions et constats, question sur un rapport, publication, discussions.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const notes = require('../../notes/notes');
const jobs = require('../../jobs');
const reviewer = require('../../review/reviewer');
const forge = require('../../forge');
const demoDocker = require('../../demo/docker');
const demoComments = require('../../demo/comments');
const agentpass = require('../../agent/pass');
const path = require('path');
const fs = require('fs');
const { mrById, readFileSafe, wrap } = require('../http');
const { forgeIdentite, forgeUsername } = require('../lib/forge-identite');
const { passesPayload } = require('../lib/partage');
const { targetById } = require('../lib/sessions');
const { dernieresVerificationsParMr } = require('../lib/verifications');

// Historique des reviews d'une MR : chaque passe est conservée.
/* DE COMBIEN UNE REVIEW EST-ELLE PÉRIMÉE ? Le badge disait « périmé » sans dire l'ampleur :
   trois lignes ou un refactoring, on ne relance pas pour la même raison. La réponse coûte un
   appel à la forge : on ne la demande donc QU'AU SURVOL du badge, jamais pour la liste
   entière. Une comparaison impossible (branche réécrite, force-push) n'est pas une erreur —
   c'est « on ne sait pas », et le badge reste ce qu'il était. */
/* ---------- Le résumé d'une merge request, pour une bulle ----------
   Un autolien `!214` dans une note ou une todo ne disait que son numéro : on cliquait, on
   changeait d'écran, on lisait, on revenait. Quatre faits suffisent — titre, note, verdict,
   état — et ils tiennent dans une bulle. Route à part et minuscule : le détail complet
   (`/api/mrs/:id`) charrie le rapport entier, ce qui n'a pas sa place au survol. */
app.get('/api/mrs/:id/resume', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const v = db.prepare(`SELECT note_value FROM review_version WHERE mr_id = ?
    ORDER BY version DESC LIMIT 1`).get(mr.id);
  const verif = dernieresVerificationsParMr().get(mr.id);
  res.json({
    iid: mr.iid, title: mr.title, project: mr.project, status: mr.status,
    closed: !!mr.closed_seen, author: mr.author || '',
    note: v ? v.note_value : null, verdict: verif ? verif.verdict : null,
    created_at: mr.gitlab_created_at || null,
  });
}));
app.get('/api/mrs/:id/stale-commits', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (!mr.reviewed_sha || !mr.current_sha || mr.reviewed_sha === mr.current_sha) {
    res.json({ known: true, count: 0, commits: [] });
    return;
  }
  try {
    const commits = await forge.clientFor(mr).commitsSince(getConfig(), mr.project, mr.reviewed_sha, mr.current_sha);
    res.json({ known: true, count: commits.length, commits: commits.slice(0, 10) });
  } catch { res.json({ known: false, count: 0, commits: [] }); }
}));
app.get('/api/mrs/:id/versions', wrap((req, res) => {
  const rows = db.prepare(`SELECT version, note_value, reviewed_sha, kind, created_at, instruction,
    n_new, n_persistent, n_resolved, n_disappeared
    FROM review_version WHERE mr_id = ? ORDER BY version DESC`).all(Number(req.params.id));
  res.json(rows.map((v) => ({
    version: v.version,
    note10: v.note_value == null ? null : Math.round(v.note_value * 100) / 10,
    sha: v.reviewed_sha ? String(v.reviewed_sha).slice(0, 8) : null,
    kind: v.kind,
    created_at: v.created_at,
    instruction: v.instruction || null,   // demande à l'origine d'une régénération
    // Delta de résolution (renseigné dès la 2e passe) pour le bandeau du rapport.
    resolution: v.n_resolved == null ? null
      : { resolved: v.n_resolved, persistent: v.n_persistent, new: v.n_new, disappeared: v.n_disappeared },
  })));
}));
// Constats structurés d'une version (par défaut la dernière), avec leur statut.
// Alimente la liste détaillée sous le bandeau du rapport.
app.get('/api/mrs/:id/findings', wrap((req, res) => {
  const id = Number(req.params.id);
  const version = req.query.v
    ? Number(req.query.v)
    : (db.prepare('SELECT MAX(version) v FROM finding WHERE mr_id = ?').get(id) || {}).v;
  if (!version) return res.json({ version: null, findings: [] });
  const rows = db.prepare(`SELECT fingerprint, file, line, severity, title, status
    FROM finding WHERE mr_id = ? AND version = ?
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'persistent' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
             CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END,
             file`).all(id, version);
  /* DEPUIS QUAND CE CONSTAT EST-IL LÀ ? « Persistant » dit qu'il était déjà à la passe
     précédente ; il ne dit pas qu'il traîne depuis la première. Le `fingerprint` est stable
     d'une passe à l'autre — la donnée était là, personne ne la lisait. Une requête pour toute
     la liste, pas une par constat. */
  const depuis = {};
  for (const r of db.prepare('SELECT fingerprint, MIN(version) v FROM finding WHERE mr_id = ? GROUP BY fingerprint').all(id)) {
    depuis[r.fingerprint] = r.v;
  }
  res.json({
    version,
    findings: rows.map((r) => ({ ...r, since: depuis[r.fingerprint] || version })),
  });
}));
// Contenu d'une version précise (pour relire une review antérieure).
app.get('/api/mrs/:id/versions/:v', wrap((req, res) => {
  const v = db.prepare('SELECT * FROM review_version WHERE mr_id = ? AND version = ?')
    .get(Number(req.params.id), Number(req.params.v));
  if (!v) throw new Error(t('err.version-introuvable'));
  res.json({
    version: v.version,
    md: readFileSafe(v.md_path),
    explanation: readFileSafe(v.explanation_path),
    note10: v.note_value == null ? null : Math.round(v.note_value * 100) / 10,
    created_at: v.created_at,
  });
}));
app.post('/api/mrs/:id/modify', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim();
  if (!instruction) throw new Error(t('err.instruction-requise'));
  // même pipeline que la review (job de fond + log en direct + sortie fichier)
  const job = jobs.startJob('modify', [mr.id], { instruction });
  res.json(job);
}));
/* POSER UNE QUESTION SUR LE RAPPORT, sans le réécrire.
 *
 * « Demander une modification » (au-dessus) régénère le rapport et en fait une version de plus :
 * demander un éclaircissement coûtait donc le rapport qu'on lisait, et la note pouvait bouger au
 * passage. Une question ne produit ni version, ni note, ni fichier de rapport — juste un échange
 * de plus dans l'historique. Ce n'est pas une promesse faite au prompt : `askReview` n'écrit
 * nulle part ailleurs. */
app.post('/api/mrs/:id/ask', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const question = (req.body && req.body.question || '').trim();
  if (!question) throw new Error(t('err.question-requise'));
  const job = jobs.startJob('ask-review', [mr.id], { question });
  res.json(job);
}));
/* Les questions posées sur cette revue, et leurs réponses — même forme, même écran et même
   recherche que les itérations d'une session : `passesPayload` ne connaît que des scopes. */
app.get('/api/mrs/:id/passes', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(passesPayload('review', 0, mr.id, req.query.n, `!${mr.iid} — ${mr.title || ''}`.trim(), null));
}));
app.post('/api/mrs/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE mr SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
app.post('/api/mrs/:id/done', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  db.prepare(`UPDATE mr SET status = 'done', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));
app.post('/api/mrs/:id/reopen', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT 1 FROM review WHERE mr_id = ?').get(mr.id);
  db.prepare(`UPDATE mr SET status = ?, updated_at = ? WHERE id = ?`)
    .run(rev ? 'reviewed' : 'to_review', new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));
// Supprime le rapport d'une MR (fichiers + ligne en base) et la remet « à reviewer ».
app.post('/api/mrs/:id/delete-review', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(mr.id);
  if (rev) {
    for (const p of [rev.md_path, rev.explanation_path, rev.diff_path]) {
      try { if (p && fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
    }
    db.prepare('DELETE FROM review WHERE mr_id = ?').run(mr.id);
  }
  /* Les questions posées SUR ce rapport partent avec lui : elles le citent, et les relire sans
     lui ne dirait plus rien de ce qui a été demandé. Pas de clé étrangère (plusieurs tables
     parentes selon le scope), donc le ménage est explicite — comme pour les sessions. */
  agentpass.removeTask('review', mr.id);
  try { fs.rmSync(path.join(TASKS_DIR, 'review', String(mr.id)), { recursive: true, force: true }); } catch { /* rien */ }
  db.prepare("UPDATE mr SET status = 'to_review', reviewed_sha = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));
app.post('/api/mrs/:id/comment', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.commentaire-vide'));
  if (demoDocker.isDemo()) return res.json({ ok: true, note_id: demoComments.post(mr.id, body, null).notes[0].id });
  const cfg = getConfig();
  const note = await forge.clientFor(mr).postMrNote(cfg, mr.project, mr.iid, body);
  db.prepare('INSERT INTO comment_log (mr_id, body, gitlab_note_id, sent_at) VALUES (?,?,?,?)')
    .run(mr.id, body, note && note.id, new Date().toISOString());
  res.json({ ok: true, note_id: note && note.id });
}));
/* PUBLIER LE RAPPORT DE REVIEW sur la merge request, à la demande.
 *
 * Le corps n'est PAS reçu du navigateur : la route relit le rapport sur le disque, par la
 * même fonction que la publication automatique (`reviewer.publierRapport`). Accepter un texte
 * du client ouvrirait la porte à publier autre chose que le rapport, sous son nom. */
/* CE QUE LA FORGE DIT DE CETTE MERGE REQUEST, MAINTENANT.
 *
 * Interrogée à l'ouverture de la modale de merge : on est à un clic d'une action irréversible
 * et visible de toute l'équipe. « Elle est en conflit » doit se lire AVANT, pas dans le message
 * d'erreur qui suivra le refus. Un appel d'API à ce moment-là est largement payé.
 *
 * Ce qu'on apprend est ÉCRIT : la merge request le garde, et les projets de session qui
 * pointent la même branche aussi — leur bouton « Mettre à jour avec … » apparaît donc sans
 * attendre la prochaine découverte. */
async function etatFusion(mr) {
  const reponse = (c) => ({
    has_conflicts: c === null || c === undefined ? null : !!c,
    target_branch: mr.target_branch,
  });
  // En démo, la forge n'existe pas : on rend ce qui est en base plutôt qu'une erreur.
  if (demoDocker.isDemo()) return reponse(mr.has_conflicts);
  const m = await forge.clientFor(mr).getMergeRequest(getConfig(), mr.project, mr.iid);
  const c = m && m.has_conflicts === true ? 1 : (m && m.has_conflicts === false ? 0 : null);
  db.prepare('UPDATE mr SET has_conflicts = ? WHERE id = ?').run(c, mr.id);
  db.prepare('UPDATE task_target SET mr_conflicts = ? WHERE repo_id = ? AND branch = ?')
    .run(c, mr.repo_id, mr.source_branch);
  return { ...reponse(c), target_branch: (m && m.target_branch) || mr.target_branch };
}
app.get('/api/mrs/:id/merge-check', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(await etatFusion(mr));
}));
/* Même question, posée depuis un projet de session — c'est le seul chemin où l'on peut aussi
   proposer le rattrapage, puisqu'il faut une session pour rejouer la branche. */
app.get('/api/tasks/:id/targets/:tid/merge-check', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const iid = tg.mr_iid || tg.existing_mr_iid;
  const mr = iid && db.prepare(`SELECT mr.*, repo.project AS project, repo.forge AS forge
    FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.repo_id = ? AND mr.iid = ?`).get(tg.repo_id, iid);
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const etat = await etatFusion(mr);
  /* Le rattrapage n'est proposé que s'il y a de quoi le faire : une branche de travail, une
     branche de départ, et un projet dont le travail est posé. */
  return res.json({
    ...etat,
    base_branch: tg.base_branch || mr.target_branch,
    branch: tg.branch,
    rebasable: !!tg.branch && ['committed', 'pushed', 'error'].includes(tg.status),
  });
}));
app.post('/api/mrs/:id/publish-review', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ ok: true, ...(await reviewer.publierRapport(mr, getConfig())) });
}));
/* PUBLIER LE LIEN DU RAPPORT, quand l'équipe a un dépôt de données. Comme ci-dessus, rien du
   corps n'est reçu du navigateur : l'adresse est CALCULÉE à partir du fichier que la ligne
   occupe dans le dépôt, sinon la route serait un moyen de poster n'importe quel lien sous le
   nom de l'utilisateur. */
app.post('/api/mrs/:id/publish-review-link', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ ok: true, ...(await reviewer.publierLienRapport(mr, getConfig())) });
}));
/* QUI SUIS-JE, SUR CHAQUE FORGE. Sert au filtre « mes merge requests / les autres » : un tech
   lead trie d'abord ce que les AUTRES attendent de lui. Route à part et appelée une fois au
   démarrage — jamais depuis `/status`, qui est sondé toutes les deux secondes. Un échec n'est
   pas une erreur : la réponse est vide, et le filtre ne s'affiche simplement pas. */
app.get('/api/me', wrap(async (req, res) => {
  const cfg = getConfig();
  const out = {};
  if (cfg.gitlab_url && cfg.access_token) out.gitlab = await forgeIdentite('gitlab');
  if (cfg.github_token) out.github = await forgeIdentite('github');
  for (const k of Object.keys(out)) delete out[k].at;
  res.json(out);
}));
// Liste les discussions (commentaires) de la MR : inline (avec position) + générales.
app.get('/api/mrs/:id/discussions', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const [discs, me] = demoDocker.isDemo()
    ? [demoComments.list(mr.id), demoComments.ME]
    : await Promise.all([
      forge.clientFor(mr).listMrDiscussions(getConfig(), mr.project, mr.iid),
      forgeUsername(mr),
    ]);
  const simplified = discs.map((d) => ({
    id: d.id,
    notes: (d.notes || []).filter((n) => !n.system).map((n) => ({
      id: n.id,
      author: (n.author && (n.author.name || n.author.username)) || '',
      // Modifiable si le compte du jeton est l'auteur. On compare sur le `username`
      // (identifiant) et jamais sur le nom affiché, qui n'est pas unique.
      editable: !!(me && n.author && n.author.username === me),
      body: n.body,
      created_at: n.created_at,
      resolved: !!n.resolved,
      position: n.position ? {
        new_path: n.position.new_path, old_path: n.position.old_path,
        new_line: n.position.new_line, old_line: n.position.old_line,
      } : null,
    })),
  })).filter((d) => d.notes.length);
  res.json({ discussions: simplified });
}));
/* Modifie un commentaire déjà posté. `inline` dit s'il s'agit d'un commentaire de ligne :
   GitHub range les deux familles sous des ressources différentes (GitLab n'en a qu'une).
   Les droits ne sont pas re-vérifiés ici : c'est la forge qui les détient, et elle refuse
   la modification du commentaire d'un autre. Le bouton, lui, n'apparaît que sur les miens. */
app.put('/api/mrs/:id/notes/:noteId', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.commentaire-vide'));
  if (demoDocker.isDemo()) {
    const n = demoComments.update(mr.id, req.params.noteId, body);
    return res.json({ ok: true, id: n.id, body: n.body });
  }
  const note = await forge.clientFor(mr).updateNote(
    getConfig(), mr.project, mr.iid, req.params.noteId, body, { inline: !!(req.body && req.body.inline) },
  );
  res.json({ ok: true, id: note && note.id, body: (note && note.body) || body });
}));
// Répond à une discussion existante.
app.post('/api/mrs/:id/discussions/:discussionId/reply', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.reponse-vide'));
  if (demoDocker.isDemo()) return res.json({ ok: true, id: demoComments.reply(mr.id, req.params.discussionId, body).id });
  const note = await forge.clientFor(mr).replyToDiscussion(getConfig(), mr.project, mr.iid, req.params.discussionId, body);
  res.json({ ok: true, id: note && note.id });
}));
// Commentaire inline sur une ligne précise d'un fichier de la MR.
app.post('/api/mrs/:id/discussion', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { body, old_path, new_path, old_line, new_line } = req.body || {};
  if (!(body || '').trim()) throw new Error(t('err.commentaire-vide-2'));
  if (!new_path && !old_path) throw new Error(t('err.fichier-requis'));
  if (demoDocker.isDemo()) {
    const d = demoComments.post(mr.id, body.trim(), { new_path, old_path, new_line, old_line });
    return res.json({ ok: true, id: d.id });
  }
  const cfg = getConfig();
  const full = await forge.clientFor(mr).getMergeRequest(cfg, mr.project, mr.iid);
  const dr = full && full.diff_refs;
  if (!dr || !dr.head_sha) throw new Error(t('err.references-de-diff-introuvables-la'));
  const position = {
    base_sha: dr.base_sha, start_sha: dr.start_sha, head_sha: dr.head_sha,
    position_type: 'text',
    old_path: old_path || new_path, new_path: new_path || old_path,
  };
  if (new_line != null && new_line !== '') position.new_line = Number(new_line);
  if (old_line != null && old_line !== '') position.old_line = Number(old_line);
  const disc = await forge.clientFor(mr).postMrDiscussion(cfg, mr.project, mr.iid, body.trim(), position);
  res.json({ ok: true, id: disc && disc.id });
}));
