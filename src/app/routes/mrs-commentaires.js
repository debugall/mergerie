'use strict';
/* Les commentaires inline en attente d’une merge request, leur envoi, et le merge lui-même.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const notify = require('../../core/notify');
const notes = require('../../notes/notes');
const forge = require('../../forge');
const demoJenkins = require('../../demo/jenkins');
const diffnum = require('../../git/diffnum');   // A7 : sur quelles lignes un commentaire peut s'accrocher
const demoComments = require('../../demo/comments');
const path = require('path');
const { mrById, readFileSafe, wrap } = require('../http');
const { mergeOptsFor } = require('../lib/merge');

/* ---------- Commentaires inline EN ATTENTE ----------------------------------
   On relit une MR fichier par fichier et on écrit ses remarques au fil de la lecture. Les
   envoyer une par une bombarde l'auteur de notifications et fige des remarques qu'on aurait
   retirées trois fichiers plus loin. Ils vivent donc en local, modifiables, jusqu'à un envoi
   explicite — et le geste direct (POST /discussion) reste inchangé pour qui le préfère. */

const brouillonsDe = (mrId) => db.prepare('SELECT * FROM mr_comment_draft WHERE mr_id = ? ORDER BY id').all(mrId);
const lireLigne = (v) => (v == null || v === '' ? null : Number(v));
app.get('/api/mrs/:id/comment-drafts', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ drafts: brouillonsDe(mr.id) });
}));
app.post('/api/mrs/:id/comment-drafts', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { body, old_path, new_path, old_line, new_line } = req.body || {};
  if (!(body || '').trim()) throw new Error(t('err.commentaire-vide-2'));
  if (!new_path && !old_path) throw new Error(t('err.fichier-requis'));
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO mr_comment_draft
    (mr_id, old_path, new_path, old_line, new_line, body, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(mr.id, old_path || null, new_path || null,
    lireLigne(old_line), lireLigne(new_line), String(body).trim(), now, now);
  res.json(db.prepare('SELECT * FROM mr_comment_draft WHERE id = ?').get(info.lastInsertRowid));
}));
/* A7 — LES CONSTATS EN BROUILLONS, D'UN GESTE. Poser huit constats en commentaires demandait
   huit ouvertures du viewer : chercher le fichier, descendre à la ligne, cliquer « + », recopier
   le constat. Le rapport les porte déjà avec leur fichier et leur ligne — c'est exactement ce
   qu'un brouillon inline demande.

   TROIS RÈGLES, et chacune évite d'écrire une bêtise chez quelqu'un :
     — seuls les constats qui portent un FICHIER ET UNE LIGNE deviennent des brouillons ; un
       constat sans position n'a pas d'endroit où s'accrocher, et le poser en tête du fichier
       serait le poser au hasard. Le compte des laissés-pour-compte est rendu ;
     — les RÉSOLUS sont exclus : commenter ce qui vient d'être corrigé serait du bruit ;
     — un brouillon EXISTE DÉJÀ au même endroit avec le même texte → on ne le double pas.
       Cliquer deux fois est le geste le plus naturel du monde.

   Rien n'est envoyé : ce sont des brouillons, qu'on relit et qu'on envoie groupés comme les
   autres. */
/* TOUT SUPPRIMER. Une remarque dont on ne veut plus, ou que la forge refuse (une position
   qu'elle ne reconnaît pas), reste dans le lot et le bloque : l'envoi groupé repart en échec à
   chaque fois, et se débarrasser des brouillons demandait de rouvrir chaque fichier pour les
   retirer un par un. Déclarée AVANT la route à identifiant, comme ailleurs dans ce fichier :
   une collection et un élément ne doivent jamais se disputer la même URL.

   Le nombre supprimé est RENDU — l'écran s'en sert pour demander confirmation avant, et pour
   dire ce qui s'est passé après ; un « c'est fait » sans chiffre laisse douter. */
app.delete('/api/mrs/:id/comment-drafts', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const n = db.prepare('DELETE FROM mr_comment_draft WHERE mr_id = ?').run(mr.id).changes;
  res.json({ deleted: n });
}));
app.post('/api/mrs/:id/comment-drafts/from-findings', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const version = (db.prepare('SELECT MAX(version) v FROM finding WHERE mr_id = ?').get(mr.id) || {}).v;
  if (!version) throw new Error(t('err.findings.none'));
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  const bloquantsSeuls = !!(req.body && req.body.blocking_only);
  const rows = db.prepare(`SELECT file, line, severity, title FROM finding
    WHERE mr_id = ? AND version = ? AND COALESCE(status, '') <> 'resolved'
    ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, file, line`)
    .all(mr.id, version)
    .filter((f) => !bloquantsSeuls || f.severity === 'blocker');

  /* UN COMMENTAIRE NE S'ACCROCHE PAS N'IMPORTE OÙ. Un constat cite une ligne de la version
     finale du fichier — c'est ce que l'IA reçoit —, et l'IA a parfaitement le droit de parler
     d'une ligne qu'elle n'a pas vue changer (« cette fonction est maintenant appelée avec
     null »). Mais une remarque inline se pose SUR LE DIFF : hors des hunks, la forge refuse la
     position, et l'écran affiche en attendant une remarque collée à une ligne que personne n'a
     touchée. On croise donc chaque constat avec le diff de LA VERSION REVIEWÉE (celle dont les
     constats viennent) et on ne pose que ce qui peut l'être — le reste est compté et annoncé.

     Ligne de contexte : `old_line` ET `new_line`, sinon GitLab refuse la position. C'est la
     raison d'être de la carte plutôt que d'un simple ensemble de numéros. */
  const patch = rev && rev.diff_path ? readFileSafe(rev.diff_path) : null;
  if (!patch) throw new Error(t('err.findings.no-diff'));
  const ancrables = diffnum.lignesAncrables(patch);

  const existants = new Set(brouillonsDe(mr.id).map((d) => `${d.new_path}\u0000${d.new_line}\u0000${d.body}`));
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO mr_comment_draft
    (mr_id, old_path, new_path, old_line, new_line, body, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  let crees = 0; let sansPosition = 0; let doublons = 0; let horsDiff = 0;
  for (const f of rows) {
    if (!f.file || !f.line) { sansPosition += 1; continue; }
    const ancre = (ancrables.get(f.file) || new Map()).get(Number(f.line));
    if (!ancre) { horsDiff += 1; continue; }
    const corps = t('report.finding.draft-body', { severity: t(`sev.${f.severity || 'minor'}`), title: f.title || '' });
    if (existants.has(`${f.file}\u0000${f.line}\u0000${corps}`)) { doublons += 1; continue; }
    // `old_path` est requis par la forge dès qu'on donne `old_line` : c'est le même fichier.
    ins.run(mr.id, ancre.old_line == null ? null : f.file, f.file, ancre.old_line, f.line, corps, now, now);
    crees += 1;
  }
  res.json({
    created: crees,
    skipped_no_position: sansPosition,
    skipped_outside_diff: horsDiff,
    skipped_existing: doublons,
    total: rows.length,
  });
}));
app.put('/api/mrs/:id/comment-drafts/:did', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const corps = ((req.body && req.body.body) || '').trim();
  if (!corps) throw new Error(t('err.commentaire-vide-2'));
  const info = db.prepare('UPDATE mr_comment_draft SET body = ?, updated_at = ? WHERE id = ? AND mr_id = ?')
    .run(corps, new Date().toISOString(), Number(req.params.did), mr.id);
  if (!info.changes) throw new Error(t('err.brouillon-introuvable'));
  res.json(db.prepare('SELECT * FROM mr_comment_draft WHERE id = ?').get(Number(req.params.did)));
}));
app.delete('/api/mrs/:id/comment-drafts/:did', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  db.prepare('DELETE FROM mr_comment_draft WHERE id = ? AND mr_id = ?').run(Number(req.params.did), mr.id);
  res.json({ ok: true });
}));
/* L'ENVOI. Les références de diff sont résolues UNE fois pour tout le lot : elles sont les
   mêmes pour tous, et les redemander à chaque commentaire ferait autant d'allers-retours que
   de remarques. Chaque brouillon parti est supprimé AUSSITÔT — si le dixième échoue, les neuf
   premiers ne doivent pas repartir au prochain essai. Ce qui échoue RESTE, avec sa raison. */
app.post('/api/mrs/:id/comment-drafts/send', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const liste = brouillonsDe(mr.id);
  if (!liste.length) throw new Error(t('err.aucun-brouillon'));
  const supprimer = db.prepare('DELETE FROM mr_comment_draft WHERE id = ?');

  if (demoJenkins.isDemo()) {
    for (const d of liste) {
      demoComments.post(mr.id, d.body, { new_path: d.new_path, old_path: d.old_path, new_line: d.new_line, old_line: d.old_line });
      supprimer.run(d.id);
    }
    return res.json({ sent: liste.length, failed: [] });
  }

  const cfg = getConfig();
  const client = forge.clientFor(mr);
  const full = await client.getMergeRequest(cfg, mr.project, mr.iid);
  const dr = full && full.diff_refs;
  if (!dr || !dr.head_sha) throw new Error(t('err.references-de-diff-introuvables-la'));

  const failed = [];
  let sent = 0;
  for (const d of liste) {
    const position = {
      base_sha: dr.base_sha, start_sha: dr.start_sha, head_sha: dr.head_sha,
      position_type: 'text',
      old_path: d.old_path || d.new_path, new_path: d.new_path || d.old_path,
    };
    if (d.new_line != null) position.new_line = Number(d.new_line);
    if (d.old_line != null) position.old_line = Number(d.old_line);
    try {
      const note = await client.postMrDiscussion(cfg, mr.project, mr.iid, d.body, position);
      /* PARTI = PRODUIT. Le brouillon reste à celui qui l'écrit, mais une fois posté le
         commentaire est sur la merge request : il rejoint le journal, qui lui est d'équipe —
         c'est ce qui permet de relire ce qui a été dit sans rouvrir la forge. */
      db.prepare('INSERT INTO comment_log (mr_id, body, gitlab_note_id, sent_at) VALUES (?,?,?,?)')
        .run(mr.id, d.body, (note && (note.id || (note.notes && note.notes[0] && note.notes[0].id))) || null,
          new Date().toISOString());
      supprimer.run(d.id);
      sent += 1;
    } catch (e) {
      failed.push({ id: d.id, path: d.new_path || d.old_path, error: (e && e.message) || String(e) });
    }
  }
  res.json({ sent, failed });
}));
app.post('/api/mrs/:id/merge', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const opts = mergeOptsFor(mr, req.body);
  const merged = await forge.clientFor(mr).mergeMergeRequest(getConfig(), mr.project, mr.iid, opts);
  const isMerged = merged && merged.state === 'merged';
  if (isMerged) {
    const now = new Date().toISOString();
    // événement frais pour le footer + flag pour que discover ne re-signale pas
    db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
      .run('mr_merged', mr.iid, mr.project, mr.author || '', mr.title || '', now);
    db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(mr.id);
    // si cette MR vient d'une Dev session, la tâche doit aussi passer « mergée »
    db.prepare('UPDATE task_target SET mr_merged = 1, updated_at = ? WHERE repo_id = ? AND mr_iid = ?')
      .run(now, mr.repo_id, mr.iid);
    /* TOP 14 — et l'événement, comme pour une MR mergée par quelqu'un d'autre. `closed_seen`
       vient d'être posé, donc la découverte ne le signalera jamais : sans cette ligne, le SEUL
       merge qui ne produit aucun fait est celui qu'on a fait soi-même — et c'est celui qui clôt
       une attente (l'onglet peut être ailleurs, le merge peut prendre quelques secondes). */
    notify.push('mr_merged', { mr_id: mr.id, iid: mr.iid, project: mr.project, title: mr.title || '', mine: true });
  }
  res.json({ ok: true, merged: isMerged, state: merged && merged.state });
}));
