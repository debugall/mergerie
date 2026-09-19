'use strict';
/* La découverte des MR et la file de jobs : lancer, arrêter, relancer, lire le journal.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const i18n = require('../../core/i18n');
const { t } = i18n;
const jobs = require('../../jobs');
const fs = require('fs');
const { wrap } = require('../http');
const { decouvrir } = require('../lib/decouverte');

app.post('/api/discover', wrap(async (req, res) => {
  res.json(await decouvrir());
}));
app.post('/api/jobs/review', wrap((req, res) => {
  /* A14 — UN SOUS-ENSEMBLE, quand l'écran en désigne un. Sans corps, c'est toute la file (le
     comportement d'origine) ; avec `mr_ids`, ce que l'écran affichait ou avait coché — une
     recherche et un filtre d'auteur ne se rejouent pas en SQL, c'est donc le client qui les
     nomme. Borné, et filtré sur ce qui est RÉELLEMENT à reviewer : une liste envoyée par un
     client ne décide pas de l'état des merge requests. */
  const bruts = Array.isArray(req.body && req.body.mr_ids) ? req.body.mr_ids.slice(0, 200) : null;
  let ids = null;
  if (bruts) {
    const aTraiter = new Set(db.prepare("SELECT id FROM mr WHERE status = 'to_review'").all().map((r) => r.id));
    ids = bruts.map(Number).filter((id) => aTraiter.has(id));
    if (!ids.length) throw new Error(t('err.review.none-selected'));
  }
  const job = jobs.startJob('review', ids);
  res.json(job);
}));
app.get('/api/jobs/current', wrap((req, res) => {
  res.json({ job: jobs.currentJob(), running: jobs.isRunning(), queued: jobs.queueCount() });
}));
// Sans id : tout arrêter (bouton du panneau). Avec un id : n'arrêter que ce job-là.
app.post('/api/jobs/stop', wrap((req, res) => {
  res.json(jobs.stopJob(req.body && req.body.job_id));
}));
app.post('/api/jobs/:id/stop', wrap((req, res) => {
  res.json(jobs.stopJob(Number(req.params.id)));
}));
/* Ce qui tourne et ce qui attend. Les jobs en attente portent leurs `keys` (dépôts et
   dossiers touchés) et les `conflicts` avec ce qui tourne : l'écran peut ainsi dire
   POURQUOI un job ne peut pas démarrer tout de suite, au lieu de griser un bouton. */
/* Journal d'activité : ce qu'on a lancé, et ce qui s'est terminé pendant qu'on regardait
   ailleurs. Les notifications ne répondent pas à cette question — elles ne vivent qu'en mémoire
   et le front saute délibérément l'historique au chargement, donc tout ce qui s'est produit
   onglet fermé est perdu. La table `job`, elle, persiste.
   `after` = dernier job vu par ce navigateur : ce qui est plus récent est « nouveau ». */
app.get('/api/jobs/history', wrap((req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
  const after = Number(req.query.after) || 0;
  /* Trié sur l'activité la PLUS RÉCENTE, pas sur l'identifiant. Un id croît à la mise en file :
     un job queué tôt mais terminé tard passerait au-dessus d'un job queué après et fini avant,
     ce qui se lit comme un désordre puisque la colonne affichée est l'heure de FIN. Depuis que
     plusieurs jobs tournent de front, le cas est courant. Un job non terminé est classé sur son
     démarrage — c'est bien l'activité en cours, donc en tête. */
  const rows = db.prepare(`SELECT id, kind, status, total, done_count, message, started_at, finished_at,
    target_kind, target_id, current_mr_id, retry FROM job
    ORDER BY COALESCE(finished_at, started_at) DESC, id DESC LIMIT ?`).all(limit);

  /* Le libellé de l'objet est résolu ICI : le front n'a en mémoire que les listes qu'il affiche,
     et un job peut porter sur une session masquée ou une MR d'un autre stade. */
  const labelMr = db.prepare('SELECT mr.iid, mr.title, repo.project FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?');
  const labelTask = db.prepare('SELECT prompt, kind FROM task WHERE id = ?');
  const labelLocal = db.prepare('SELECT prompt FROM local_task WHERE id = ?');
  const labelVerif = db.prepare('SELECT verifier_name, targets_json FROM verification WHERE id = ?');
  const court = (v) => String(v || '').split('\n')[0].slice(0, 70);

  const out = rows.map((j) => {
    let label = null; let href = null;
    const mrId = j.target_kind === 'mr' ? j.target_id : (j.target_kind ? null : j.current_mr_id);
    if (mrId) {
      const m = labelMr.get(mrId);
      if (m) { label = `!${m.iid} — ${court(m.title)}`; href = { kind: 'mr', id: mrId }; }
    } else if (j.target_kind === 'task') {
      const t2 = labelTask.get(j.target_id);
      if (t2) { label = court(t2.prompt); href = { kind: t2.kind === 'explore' ? 'explore' : 'task', id: j.target_id }; }
    } else if (j.target_kind === 'local') {
      const l = labelLocal.get(j.target_id);
      if (l) { label = court(l.prompt); href = { kind: 'local', id: j.target_id }; }
    } else if (j.target_kind === 'verification') {
      /* Une vérification porte sur une ou plusieurs MR : le libellé les nomme, et le lien
         mène à la première — c'est la destination utile, et elle existe déjà côté front. */
      const v = labelVerif.get(j.target_id);
      if (v) {
        let cibles = [];
        try { cibles = JSON.parse(v.targets_json || '[]'); } catch { cibles = []; }
        const mrs = cibles.map((c) => labelMr.get(c.mr_id)).filter(Boolean);
        label = court(`${v.verifier_name} — ${mrs.map((m) => `${m.project} !${m.iid}`).join(', ')}`);
        const premier = cibles.find((c) => c.mr_id);
        if (premier) href = { kind: 'mr', id: premier.mr_id };
      }
    }
    /* A40 — LA RAISON D'UN ÉCHEC, et s'il se rejoue. `message` était renvoyé et jamais rendu :
       l'historique disait « erreur » sans dire laquelle, et il fallait ouvrir le journal
       ligne à ligne. `can_retry` évite d'afficher un bouton qui répondrait 400. */
    // `retry` sert à `canRetry` (sans lui, jamais de bouton « Relancer ») ; la spec n'a pas à sortir.
    const { retry, ...ligne } = j;
    return { ...ligne, label, href, can_retry: jobs.canRetry(j) };
  });
  // `latest` = plus grand id vu, pas le premier de la liste : l'ordre d'affichage n'est plus
  // celui des ids, et un curseur pris sur la tête raterait un job plus récent classé plus bas.
  const latest = rows.reduce((m, r) => Math.max(m, r.id), 0);
  res.json({ jobs: out, latest });
}));
app.get('/api/jobs/queue', wrap((req, res) => {
  res.json({
    running: jobs.runningJobs(), queued: jobs.queuedJobs(),
    parallelBusy: jobs.parallelBusy(), maxRunning: jobs.MAX_RUNNING,
  });
}));
// Rejoue un job qui s'est arrêté ou a échoué, sur le même objet.
app.post('/api/jobs/:id/retry', wrap((req, res) => {
  res.json({ ok: true, job: jobs.retryJob(Number(req.params.id)) });
}));
// Sort un job de la file et le lance EN PARALLÈLE de celui en cours (refus si conflit).
app.post('/api/jobs/:id/start-now', wrap((req, res) => {
  res.json({ ok: true, job: jobs.startNow(Number(req.params.id)) });
}));
// Charge utile commune aux deux routes de log : le job, ses compteurs, ses lignes.
function jobLogPayload(job, after) {
  const lines = db.prepare(
    'SELECT id, mr_id, text, ts FROM job_log WHERE job_id = ? AND id > ? ORDER BY id LIMIT 3000',
  ).all(job.id, after);
  return {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    running: jobs.isRunning(),
    // Les autres jobs EN COURS : le panneau en tire ses onglets sans requête de plus.
    running_ids: jobs.runningJobs().map((j) => j.id),
    queued: jobs.queueCount(),
    message: job.message,
    total: job.total,
    done_count: job.done_count,
    // Horodatages du job : le front en tire le temps écoulé. Il les calcule à partir de la
    // date SERVEUR plutôt que de compter les secondes depuis l'ouverture de la page — sinon
    // un onglet ouvert en cours de route afficherait un temps faux.
    started_at: job.started_at,
    finished_at: job.finished_at,
    // Le serveur décide de ce qui est rejouable — le front n'a pas à connaître la liste.
    can_retry: jobs.canRetry(job),
    /* POURQUOI CE JOB-LÀ NE SE REJOUE PAS. Les opérations git sont volontairement exclues du
       « Relancer » : rejouer « supprimer ces douze branches » depuis un bandeau, sans repasser
       par l'aperçu, est exactement ce qu'il ne faut pas permettre. Le choix était assumé dans
       le code et muet à l'écran — le bouton disparaissait, sans un mot. */
    no_retry_reason: (job && !jobs.canRetry(job) && ['stopped', 'error', 'interrupted'].includes(job.status)
      && ['gitops', 'docker', 'verify', 'install'].includes(job.kind))
      ? t(`job.no-retry.${job.kind}`) : null,
    /* CE QUE LE JOB A PRODUIT, pour que le bandeau puisse y mener. Un job qui se terminait
       s'effaçait tout seul six secondes plus tard sans laisser de lien vers son résultat : il
       ne restait qu'une pastille de onze pixels dans le pied de page. */
    target_kind: job.target_kind || null,
    target_id: job.target_id || null,
    lines,
  };
}
// Log incrémental du job courant (poll temps réel côté UI).
/* `expect` = le job que le client CROIT courant. Le job courant peut changer sous ses pieds
   (le principal se termine, un job parallèle devient le plus récent en cours) : si l'id ne
   correspond plus, son curseur ne vaut rien et on renvoie depuis le début, sinon il
   manquerait toutes les lignes déjà produites par ce job-là. */
app.get('/api/jobs/current/log', wrap((req, res) => {
  const job = jobs.currentJob();
  if (!job) return res.json({ job_id: null, lines: [], running: false });
  const expect = Number(req.query.expect || 0);
  const after = expect && expect === job.id ? Number(req.query.after || 0) : 0;
  res.json(jobLogPayload(job, after));
}));
// Log d'un job PRÉCIS — l'onglet du job lancé en parallèle s'en sert.
app.get('/api/jobs/:id/log', wrap((req, res) => {
  const job = db.prepare('SELECT * FROM job WHERE id = ?').get(Number(req.params.id));
  if (!job) throw new Error(t('err.job-introuvable'));
  res.json(jobLogPayload(job, Number(req.query.after || 0)));
}));
// Réinitialise : supprime tous les rapports (fichiers + lignes review),
// remet toutes les MR en 'to_review', vide le journal des jobs. Conserve repos/config.
app.post('/api/reports/reset', wrap((req, res) => {
  if (jobs.isRunning()) throw new Error(t('err.un-job-est-en-cours'));
  try {
    fs.rmSync(REVIEWS_DIR, { recursive: true, force: true });
    fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  } catch { /* dossier absent : rien à faire */ }
  const del = db.prepare('DELETE FROM review').run();
  db.prepare("UPDATE mr SET status = 'to_review', reviewed_sha = NULL, last_error = NULL, updated_at = ?")
    .run(new Date().toISOString());
  db.prepare('DELETE FROM job_log').run();
  db.prepare('DELETE FROM job').run();
  res.json({ ok: true, deleted: del.changes });
}));
