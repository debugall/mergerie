'use strict';
/* LES AUTRES SOURCES D'UNE PÉRIODE — ce qui ne vient ni de la forge ni du clone :
 *   - ce que les collègues ont fait dans Mergerie (base partagée), par la DATE des lignes
 *     partagées ET par leur ARRIVÉE : le journal des fichiers hydratés par la synchro
 *     (`datasync.hydratesDepuis`), qui ne dépend d'aucune horloge que la mienne — un poste à
 *     l'heure fausse range sa review hors fenêtre, mais son fichier est bien entré ici depuis
 *     mon départ ;
 *   - ce que Mergerie a fait seul si le poste est resté allumé : les passes d'agents planifiés,
 *     les vérifications ;
 *   - les tickets Jira qui ont changé d'état ou m'ont été affectés (si Jira est configuré).
 * Chaque fonction rend des items de la forme de `periode.js` ; une erreur ne fait jamais échouer
 * l'ensemble — l'appelant note la raison et continue. */
const db = require('../db');
const datasync = require('../data/datasync');
const store = require('../data/store');
const identite = require('../core/identite');
const jira = require('../integrations/jira');

const MAX_FICHIERS_HYDRATES = 500;
const TABLES_EQUIPE = ['review_version', 'task', 'todo', 'note_page'];

/* ---------- Ce que l'équipe a fait dans Mergerie (base partagée) ---------- */

const auteursDe = (table, rows) => {
  const chemins = new Map();
  for (const r of rows) { const c = store.cheminSur(table, r); if (c) chemins.set(r.id, c); }
  const parFichier = datasync.auteursDe([...new Set(chemins.values())], { createur: table === 'note_page' || table === 'todo' });
  return new Map([...chemins].map(([id, c]) => [id, parFichier.get(c) || null]));
};

/* Une ligne de l'écran pour une ligne partagée. `null` quand la table n'en fait pas une. */
function ligneEquipe(table, r, auteur) {
  if (table === 'review_version') {
    const m = db.prepare('SELECT iid, title, repo_id, merged_at, current_sha, closed_seen FROM mr WHERE id = ?').get(r.mr_id) || {};
    return {
      repo_id: m.repo_id || null, kind: 'team', ref: `review:${r.uid || r.id}`, author: auteur, title: m.title || '', at: r.created_at, mr_id: r.mr_id,
      extra: { objet: 'review', iid: m.iid, note: r.note_value, version: r.version, mergee: !!m.merged_at, closed: !!m.closed_seen, a_bouge: !!(r.reviewed_sha && m.current_sha && r.reviewed_sha !== m.current_sha) },
    };
  }
  if (table === 'task') {
    const cibles = db.prepare('SELECT repo_id, branch, mr_iid, mr_merged FROM task_target WHERE task_id = ?').all(r.id);
    return {
      repo_id: cibles[0] ? cibles[0].repo_id : null, kind: 'team', ref: `task:${r.uid || r.id}`, author: auteur,
      title: r.label || String(r.prompt || '').slice(0, 120), at: r.created_at, mr_id: null,
      extra: { objet: 'task', task_id: r.id, task_kind: r.kind || 'code', iids: cibles.map((c) => c.mr_iid).filter(Boolean), merged: cibles.some((c) => c.mr_merged) },
    };
  }
  if (table === 'todo') return { repo_id: null, kind: 'team', ref: `todo:${r.uid || r.id}`, author: auteur, title: r.title || '', at: r.updated_at, mr_id: null, extra: { objet: 'todo', todo_id: r.id, status: r.status } };
  if (table === 'note_page') return { repo_id: null, kind: 'team', ref: `page:${r.slug || r.id}`, author: auteur, title: r.title || '', at: r.updated_at, mr_id: null, extra: { objet: 'page', page_id: r.id } };
  return null;
}

/* Les lignes partagées CRÉÉES OU MODIFIÉES DANS LA FENÊTRE PAR QUELQU'UN D'AUTRE, puis celles que la
   synchro a FAIT ENTRER depuis le début de la fenêtre, quelle que soit leur date. L'auteur est
   celui qui a commité le fichier dans le dépôt de données — git le sait, aucune colonne à tenir.
   Sans dépôt partagé, la section n'existe pas. */
function faitParLEquipe({ depuis, jusqua }) {
  if (!datasync.estConfigure()) return [];
  const moi = identite.nom() || '';
  const items = [];
  const parRef = new Map();
  const poser = (table, rows, arrive = null) => {
    const auteurs = auteursDe(table, rows);
    for (const r of rows) {
      const auteur = auteurs.get(r.id);
      if (!auteur || auteur === moi) continue;
      const it = ligneEquipe(table, r, auteur);
      if (!it) continue;
      if (parRef.has(it.ref)) { if (arrive) parRef.get(it.ref).extra.arrive = arrive; continue; }
      if (arrive) { it.extra.arrive = arrive; if (!it.at) it.at = arrive; }
      items.push(it); parRef.set(it.ref, it);
    }
  };
  // 1. Par la date.
  poser('review_version', db.prepare(`SELECT rv.* FROM review_version rv JOIN mr ON mr.id = rv.mr_id
    WHERE rv.created_at >= ? AND rv.created_at <= ? AND rv.kind = 'review' ORDER BY rv.created_at DESC LIMIT 200`).all(depuis, jusqua));
  poser('task', db.prepare('SELECT * FROM task WHERE created_at >= ? AND created_at <= ? AND shared = 1 ORDER BY created_at DESC LIMIT 100').all(depuis, jusqua));
  poser('todo', db.prepare('SELECT * FROM todo WHERE updated_at >= ? AND updated_at <= ? AND shared = 1 ORDER BY updated_at DESC LIMIT 100').all(depuis, jusqua));
  let pages = [];
  try { pages = db.prepare('SELECT * FROM note_page WHERE updated_at >= ? AND updated_at <= ? AND shared = 1 ORDER BY updated_at DESC LIMIT 100').all(depuis, jusqua); } catch { pages = []; }
  poser('note_page', pages);
  // 2. Par l'arrivée : ce que la synchro a appliqué depuis le début de la fenêtre.
  let lus = 0;
  for (const { at, files } of datasync.hydratesDepuis(depuis)) {
    const parTable = new Map();
    for (const relatif of files) {
      if (lus >= MAX_FICHIERS_HYDRATES) break;
      const table = store.tablePour(relatif);
      if (!TABLES_EQUIPE.includes(table)) continue;
      if (table === 'review_version' && !/\.json$/.test(relatif)) continue;   // le corps et son jumeau : un seul compte
      lus += 1;
      let doc = null;
      try { doc = store.lireDocument(table, relatif); } catch { doc = null; }
      if (!doc) continue;
      const row = doc.uid ? db.prepare(`SELECT * FROM ${table} WHERE uid = ?`).get(doc.uid)
        : (table === 'note_page' && doc.slug ? db.prepare('SELECT * FROM note_page WHERE slug = ?').get(doc.slug) : null);
      if (!row || (table === 'review_version' && row.kind !== 'review')) continue;
      if (!parTable.has(table)) parTable.set(table, []);
      parTable.get(table).push(row);
    }
    for (const [table, rows] of parTable) poser(table, rows, at);
  }
  return items;
}

/* ---------- Ce que Mergerie a fait seul ---------- */

/* Si le poste est resté allumé : les RUNS d'agents planifiés (une `task` portant `agent_id`,
   une ligne par agent) et les VÉRIFICATIONS lancées dans la fenêtre. */
function faitParMergerie({ depuis, jusqua }) {
  const items = [];
  const runs = db.prepare(`SELECT id, agent_id, agent_name, kind, status, created_at FROM task
    WHERE agent_id IS NOT NULL AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 500`).all(depuis, jusqua);
  const parAgent = new Map();
  for (const r of runs) {
    if (!parAgent.has(r.agent_id)) parAgent.set(r.agent_id, { name: r.agent_name || '', n: 0, erreurs: 0, dernier: r });
    const g = parAgent.get(r.agent_id);
    g.n += 1;
    if (r.status === 'error') g.erreurs += 1;
  }
  for (const [agentId, g] of parAgent) {
    const nom = g.name || (db.prepare('SELECT name FROM agent WHERE id = ?').get(agentId) || {}).name || `#${agentId}`;
    items.push({
      repo_id: null, kind: 'mergerie', ref: `agent:${agentId}`, author: '', title: nom, at: g.dernier.created_at, mr_id: null,
      extra: { objet: 'agent', agent_id: agentId, runs: g.n, erreurs: g.erreurs, task_id: g.dernier.id, task_kind: g.dernier.kind || 'explore' },
    });
  }
  const verifs = db.prepare(`SELECT id, verifier_name, lot_name, status, verdict, created_at, finished_at FROM verification
    WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 200`).all(depuis, jusqua);
  for (const v of verifs) {
    items.push({
      repo_id: null, kind: 'mergerie', ref: `verif:${v.id}`, author: '', title: `${v.verifier_name || ''}${v.lot_name ? ` · ${v.lot_name}` : ''}`,
      at: v.finished_at || v.created_at, mr_id: null,
      extra: { objet: 'verification', verification_id: v.id, verdict: v.verdict || null, status: v.status, rouge: v.verdict === 'verified_fail' || v.verdict === 'broken_base' },
    });
  }
  return items;
}

/* ---------- Jira ---------- */

/* Les tickets qui ont changé d'état ou m'ont été affectés pendant la fenêtre : les miens, les
   surveillés, et ceux des merge requests de la période (`cles`). Rien sans Jira configuré. */
async function ticketsJira({ depuis, jusqua, cfg, cles = [] }) {
  if (!jira.isConfigured(cfg)) return [];
  const surveilles = db.prepare('SELECT key FROM jira_watch').all().map((r) => r.key);
  const { changed, assigned } = await jira.changedDuring(cfg, { depuis, jusqua, keys: [...surveilles, ...cles] });
  const ligne = (i, objet) => ({
    repo_id: null, kind: 'jira', ref: i.key, author: (i.assignee && (i.assignee.name || i.assignee.displayName)) || '', title: i.summary || '',
    at: i.updated || null, mr_id: null,
    extra: { objet, status: i.status, category: i.statusCategory, url: i.url, type: i.type, project: i.projectKey, done: i.statusCategory === 'done' },
  });
  const items = [];
  const parCle = new Map();
  for (const i of assigned) { const it = ligne(i, 'assigned'); items.push(it); parCle.set(i.key, it); }
  for (const i of changed) {
    if (parCle.has(i.key)) { parCle.get(i.key).extra.status_changed = true; continue; }
    const it = ligne(i, 'status'); it.extra.status_changed = true; items.push(it); parCle.set(i.key, it);
  }
  return items;
}

module.exports = { faitParLEquipe, faitParMergerie, ticketsJira, ligneEquipe };
