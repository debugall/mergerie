'use strict';
/* Une branche n’est pas anonyme : ce que la base sait dire d’elle (ticket, verdict, session, job Jenkins), et l’adresse d’une ref sur la forge.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const notes = require('../../notes/notes');
const jobs = require('../../jobs');
const jenkins = require('../../integrations/jenkins');
const path = require('path');

/* Explorateur de branches. Exige un clone local : l'analyse du graphe
   (ahead/behind, merge-base) a besoin de l'historique, que l'API ne donne pas. */
/* Une entrée par dépôt, en mémoire du processus : l'analyse d'un dépôt pèse quelques dizaines
   de kilo-octets, et un redémarrage la refait — c'est un cache, pas un état. */
const crypto = require('node:crypto');
const cacheExplorateur = new Map();
/* ---------- Une branche n'est pas anonyme ----------
   Le graphe des branches disait « ahead 3, behind 12 » et rien de ce qu'elles PORTENT. Ce que
   Mergerie sait d'elles est en base : la note de la review de sa merge request, et la session
   de codage qui l'a créée (une branche `ai/…` vient de quelque part). Le graphe devient alors
   un plan de travail. Deux requêtes pour tout le dépôt, jamais une par branche. */
function nommerBranches(repoId, rows) {
  if (!rows || !rows.length) return;
  const notes = {};
  for (const r of db.prepare(`SELECT mr.source_branch AS br, rv.note_value AS note FROM mr
    JOIN review_version rv ON rv.mr_id = mr.id
    WHERE mr.repo_id = ? AND rv.version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = mr.id)`).all(repoId)) {
    notes[r.br] = r.note;
  }
  const sessions = {};
  /* `kind` part avec la session : l'écran doit ouvrir la SAVEUR qui la contient (codage,
     exploration…), sinon le clic atterrit sur le sous-onglet consulté la dernière fois — là où
     la session n'est pas. */
  for (const r of db.prepare(`SELECT tt.branch AS br, task.id, task.label, task.prompt, task.status, task.kind
    FROM task_target tt JOIN task ON task.id = tt.task_id
    WHERE tt.repo_id = ? AND tt.branch IS NOT NULL ORDER BY task.id DESC`).all(repoId)) {
    if (!sessions[r.br]) sessions[r.br] = { id: r.id, label: r.label || String(r.prompt || '').slice(0, 60), status: r.status, kind: r.kind || 'code' };
  }
  /* TOP 15 — TOUT CE QUE LA BASE SAIT D'UNE BRANCHE. Le graphe disait « ahead 3, behind 12 » et
     rien de ce que la branche PORTE : le titre de sa merge request est chargé puis jeté par
     `gitgraph`, son ticket Jira est en base, le dernier verdict de vérification aussi (dans
     `targets_json`), et le dernier build Jenkins est à une jointure. Chacune de ces données
     transforme une ligne de graphe en ligne de travail — et aucune ne coûte un appel de plus.
     Trois requêtes pour tout le dépôt, jamais une par branche. */
  const mrs = {};
  for (const r of db.prepare(`SELECT source_branch AS br, iid, title, web_url, status, closed_seen,
      ticket_jira_key, ticket_jira_status, has_conflicts, is_draft
    FROM mr WHERE repo_id = ? ORDER BY id DESC`).all(repoId)) {
    if (!mrs[r.br]) mrs[r.br] = r;
  }
  /* Le dernier verdict par branche : les cibles d'une vérification vivent en JSON, on relit
     donc du plus récent au plus ancien et on retient le premier vu — même geste que le brief. */
  const verdicts = {};
  for (const v of db.prepare(`SELECT verdict, targets_json, finished_at FROM verification
    WHERE status = 'done' ORDER BY id DESC LIMIT 300`).all()) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { continue; }
    for (const c of cibles) {
      if (Number(c.repo_id) !== Number(repoId) || !c.branch) continue;
      if (!verdicts[c.branch]) verdicts[c.branch] = { verdict: v.verdict, at: v.finished_at };
    }
  }
  /* …et le job Jenkins du dépôt (TOP 15, dernier tiers). Une branche se déploie par le même job
     que les merge requests du dépôt ; le bouton existait sur une merge request VERTE et nulle part
     pour une branche qui n'en a pas encore — or c'est exactement le cas d'une branche qu'on veut
     déployer en recette avant de la proposer. Une requête pour tout le dépôt. */
  const jobs = db.prepare('SELECT job_path, param FROM repo_jenkins WHERE repo_id = ? ORDER BY job_path LIMIT 3').all(repoId);
  for (const b of rows) {
    if (notes[b.name] != null) b.mr_note = notes[b.name];
    if (sessions[b.name]) b.session = sessions[b.name];
    if (jobs.length && !b.default) b.jenkins = jobs.map((j) => ({ path: j.job_path, param: j.param || '' }));
    const mr = mrs[b.name];
    if (mr) {
      b.mr = {
        iid: mr.iid, title: mr.title || '', url: mr.web_url || '',
        status: mr.status, merged: !!mr.closed_seen,
        conflicts: mr.has_conflicts === 1, draft: !!mr.is_draft,
      };
      if (mr.ticket_jira_key) b.ticket = { key: mr.ticket_jira_key, status: mr.ticket_jira_status || '' };
    }
    if (verdicts[b.name]) b.verification = verdicts[b.name];
  }
}
// Recherche d'une ref (tag ou branche, saisie libre) À TRAVERS tous les dépôts actifs.
// Renvoie, par dépôt, les correspondances trouvées (avec commit + lien GitLab). Live et
// best-effort : un dépôt injoignable est marqué `error`, pas confondu avec « absente ».
function refUrl(cfg, project, kind, name) {
  const base = String(cfg.gitlab_url || '').replace(/\/+$/, '');
  const seg = kind === 'tag' ? '-/tags/' : '-/tree/';
  return `${base}/${project}/${seg}${encodeURIComponent(name)}`;
}

module.exports = {
  crypto, cacheExplorateur, nommerBranches, refUrl,
};
