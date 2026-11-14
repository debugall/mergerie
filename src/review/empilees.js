'use strict';
/* LES MERGE REQUESTS EMPILÉES — « contient !214 » sur l'une, « contenue dans !219 » sur l'autre.
 *
 * On repart de la branche d'un collègue ou d'un agent, on ajoute son travail, on ouvre vers `main` :
 * la forge affiche une merge request ordinaire, avec le diff des deux. Rien ne dit que 220 des 300
 * lignes sont déjà en revue ailleurs, ni que la seconde changera de taille le jour où la première
 * merge. Une merge request EN CONTIENT une autre quand l'ensemble des commits de la seconde
 * (`cible..source`) est inclus dans l'ensemble des commits de la première : un fait de git, comparé
 * en SQL, sans aucun appel d'IA. Rien n'est jugé, rien n'est bloqué, aucune note ne bouge : l'outil
 * montre que l'ordre de merge est imposé, l'humain merge dans cet ordre — ou non. C'est la suite
 * des croisements : deux MR qui se croisent, on choisit l'ordre ; l'une contient l'autre, l'ordre est
 * déjà choisi. Ce module n'importe rien de `agent/`, un test le garde fermé.
 *
 * Deux moments, comme pour les croisements :
 *   — LE RELEVÉ, dans la découverte (`croisements.releverTour`, même plafond que les listes de
 *     fichiers — une MR relevée pour ses fichiers l'est pour ses commits dans le même tour) : le
 *     clone local s'il porte les deux branches (aucun réseau), sinon la forge (un appel par MR,
 *     pages comprises). Invalidé dès que le SHA de tête ou la branche cible change.
 *   — LE CALCUL, à l'affichage : une requête sur `mr_commits`, sans cache. Pas de liste fraîche, liste
 *     refusée ou tronquée → rien, jamais un faux « indépendante ».
 *
 * Trois relations, toutes des faits entre MR ouvertes du même dépôt : CONTIENT (les commits de A
 * forment un sous-ensemble strict de ceux de B, même cible), JUMELLES (commits identiques), BASÉE SUR
 * (la cible de B est la branche source de A — la forge le montre déjà, on le reprend au même endroit). */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const forge = require('../forge');
const git = require('../git/git');
const { t } = require('../core/i18n');

const MAX_COMMITS = 500;      // au-delà, la liste n'est pas stockée : une telle branche en contient forcément d'autres
const HISTORIQUE_JOURS = 7;   // « contenait !214 · mergée il y a 2 h » reste visible une semaine
const CHEMINS_PAR_PANNEAU = 10;

const actif = (cfg) => String((cfg && cfg.mr_commits_enabled) ?? '1') !== '0' && String((cfg && cfg.mr_files_enabled) ?? '1') !== '0';

/* ---------- Relever ---------- */

/* 1. Le clone local, s'il porte la branche source À SA TÊTE ACTUELLE et la branche cible — aucun fetch,
   aucun réseau. Le SHA de la cible est celui que le clone connaît : s'il est en retard sur la forge,
   la liste compte quelques commits de trop, et l'inclusion ne sera pas conclue — jamais conclue à tort. */
async function depuisLeClone(cfg, repo, mr) {
  if (!mr.source_branch || !mr.target_branch || !mr.current_sha) return null;
  const cwd = git.cloneDirFor(cfg, repo);
  if (!fs.existsSync(path.join(cwd, '.git'))) return null;
  try {
    const { stdout: tete } = await git.run('git', ['rev-parse', '--verify', '--quiet', `origin/${mr.source_branch}^{commit}`], { cwd });
    if (String(tete).trim() !== mr.current_sha) return null;
    if (!await git.refExists(cwd, `origin/${mr.target_branch}`)) return null;
    const shas = await git.revList(cwd, `origin/${mr.target_branch}..origin/${mr.source_branch}`, { max: MAX_COMMITS + 1 });
    return { shas, source: 'clone', truncated: false };
  } catch { return null; }
}

/* 2. La forge — par `clientFor(repo)`. GitLab pagine à 100 ; GitHub coupe à 250 et le dit (`truncated`). */
async function depuisLaForge(cfg, repo, mr) {
  const r = await forge.clientFor(repo).listMrCommits(cfg, repo.project, mr.iid);
  return { shas: r.shas || [], source: 'forge', truncated: !!r.truncated };
}

async function releverCommits(cfg, repo, mr) {
  return await depuisLeClone(cfg, repo, mr) || depuisLaForge(cfg, repo, mr);
}

/* ---------- Écrire ---------- */

const poserCommits = db.transaction((mrId, { sha = null, target = null, shas = [], source = null, refused = null, now = new Date().toISOString() } = {}) => {
  db.prepare('DELETE FROM mr_commits WHERE mr_id = ?').run(mrId);
  if (!refused) {
    const ins = db.prepare('INSERT INTO mr_commits (mr_id, sha, position) VALUES (?, ?, ?)');
    shas.forEach((s, i) => ins.run(mrId, s, i));
  }
  db.prepare(`INSERT INTO mr_commit_fetch (mr_id, head_sha, target_branch, fetched_at, count, source, refused) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mr_id) DO UPDATE SET head_sha = excluded.head_sha, target_branch = excluded.target_branch, fetched_at = excluded.fetched_at,
      count = excluded.count, source = excluded.source, refused = excluded.refused`)
    .run(mrId, sha, target, now, refused ? null : shas.length, source, refused);
});

/* Relève et écrit, pour UNE merge request. Rend `{ source, count, refused }` ; jette si aucune source
   n'a répondu. Au-delà de `MAX_COMMITS`, ou tronquée par la forge : rien de stocké, le refus l'est. */
async function releverEtPoser(cfg, repo, mr, { now = new Date().toISOString() } = {}) {
  const r = await releverCommits(cfg, repo, mr);
  const base = { sha: mr.current_sha, target: mr.target_branch, source: r.source, now };
  if (r.shas.length > MAX_COMMITS) {
    poserCommits(mr.id, { ...base, refused: 'too-many-commits' });
    return { source: r.source, count: r.shas.length, refused: 'too-many-commits' };
  }
  if (r.truncated) {
    poserCommits(mr.id, { ...base, refused: 'truncated' });
    return { source: r.source, count: r.shas.length, refused: 'truncated' };
  }
  poserCommits(mr.id, { ...base, shas: r.shas });
  return { source: r.source, count: r.shas.length, refused: null };
}

/* La condition SQL « cette merge request a une liste à relever » — manquante, ou qui ne parle plus de
   la tête actuelle ni de la cible actuelle. Une liste REFUSÉE sur le même SHA n'est pas retentée. */
const A_RELEVER = (cf, mr) => `(${cf}.mr_id IS NULL OR ${cf}.head_sha IS NOT ${mr}.current_sha OR ${cf}.target_branch IS NOT ${mr}.target_branch)`;

/* ---------- L'historique ---------- */

/* Quand une merge request CONTENUE ferme (mergée ou close), son badge disparaît de la contenante au
   même instant — les deux doivent être ouvertes. On garde la trace, `contenait !214 · mergée il y a
   2 h`, pendant sept jours : c'est l'explication des « N commits de retard » qui viennent d'apparaître
   si elle a été mergée par squash ou rebase. Puis la liste de commits de la fermée est purgée — elle
   ne servira plus à rien. Appelé à chaque tour de découverte, idempotent. */
function archiverFermees({ now = new Date().toISOString(), garderMergeesJours = 0 } = {}) {
  const fermees = db.prepare(`SELECT mr.id, mr.merged_at FROM mr JOIN mr_commit_fetch f ON f.mr_id = mr.id
    WHERE COALESCE(mr.closed_seen, 0) = 1 OR mr.merged_at IS NOT NULL`).all();
  let n = 0;
  if (fermees.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO mr_contained_history (mr_id, other_mr_id, merged_at) VALUES (?, ?, ?)');
    /* LES COMMITS D'UNE MR MERGÉE RESTENT `garderMergeesJours` (la fenêtre des retouches plus une
       marge) : c'est par eux qu'un `blame` reconnaît une ligne d'une MR mergée sans squash. Une MR
       fermée sans merge est purgée tout de suite, comme avant ; 0 = tout de suite pour toutes. */
    const limite = new Date(Date.parse(now) - garderMergeesJours * 24 * 3600 * 1000).toISOString();
    const ecrire = db.transaction(() => {
      for (const f of fermees) {
        for (const r of inclusions({ innerId: f.id, ouvertes: false })) { ins.run(r.outer, r.inner, f.merged_at || now); n += 1; }
        if (garderMergeesJours > 0 && f.merged_at && f.merged_at > limite) continue;
        db.prepare('DELETE FROM mr_commits WHERE mr_id = ?').run(f.id);
        db.prepare('DELETE FROM mr_commit_fetch WHERE mr_id = ?').run(f.id);
      }
    });
    ecrire();
  }
  const limite = new Date(Date.parse(now) - HISTORIQUE_JOURS * 24 * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM mr_contained_history WHERE merged_at < ?').run(limite);
  return n;
}

/* ---------- Calculer ---------- */

const FRAIS = (f, m) => `${f}.head_sha IS ${m}.current_sha AND ${f}.target_branch IS ${m}.target_branch AND ${f}.refused IS NULL`;
const OUVERTE = (m) => `COALESCE(${m}.closed_seen, 0) = 0`;

/* A contenue dans B : tous les commits de A sont dans B, et B en a d'autres (`strict`), ou exactement
   les mêmes (`jumelles`). Même dépôt, même cible, les deux listes fraîches. `innerId` borne A ;
   `ouvertes: false` ne demande pas que A soit ouverte (l'archivage d'une MR qui vient de fermer).
   Rend `[{ inner, outer, shared, extra }]`. */
function inclusions({ mrIds = null, innerId = null, ouvertes = true, jumelles = false } = {}) {
  const params = [];
  let borne = '';
  if (Array.isArray(mrIds) && mrIds.length) { borne += ` AND (fa.mr_id IN (${mrIds.map(() => '?').join(',')}) OR fb.mr_id IN (${mrIds.map(() => '?').join(',')}))`; params.push(...mrIds, ...mrIds); }
  if (innerId) { borne += ' AND fa.mr_id = ?'; params.push(innerId); }
  const etatA = ouvertes ? `AND ${OUVERTE('ma')}` : '';
  const fraisA = ouvertes ? FRAIS('fa', 'ma') : 'fa.refused IS NULL';
  const taille = jumelles ? 'fb.count = fa.count AND fa.mr_id < fb.mr_id' : 'fb.count > fa.count';
  return db.prepare(`SELECT fa.mr_id AS inner, fb.mr_id AS outer, fa.count AS shared, fb.count - fa.count AS extra
    FROM mr_commit_fetch fa
    JOIN mr_commit_fetch fb ON fb.mr_id <> fa.mr_id
    JOIN mr ma ON ma.id = fa.mr_id JOIN mr mb ON mb.id = fb.mr_id
    WHERE ma.repo_id = mb.repo_id ${etatA} AND ${OUVERTE('mb')}
      AND ma.target_branch IS mb.target_branch
      AND ${fraisA} AND ${FRAIS('fb', 'mb')}
      AND fa.count > 0 AND ${taille} ${borne}
      AND fa.count = (SELECT COUNT(*) FROM mr_commits a JOIN mr_commits b ON b.sha = a.sha AND b.mr_id = fb.mr_id WHERE a.mr_id = fa.mr_id)`).all(...params);
}

/* B vise la branche source de A : « basée sur !A ». Sans regarder les commits — la forge le montre
   déjà dans le titre de la cible, on le reprend sur la carte. Rend `[{ inner: A, outer: B }]`. */
function baseesSur({ mrIds = null } = {}) {
  const borne = Array.isArray(mrIds) && mrIds.length ? `AND (ma.id IN (${mrIds.map(() => '?').join(',')}) OR mb.id IN (${mrIds.map(() => '?').join(',')}))` : '';
  return db.prepare(`SELECT ma.id AS inner, mb.id AS outer FROM mr ma JOIN mr mb ON mb.repo_id = ma.repo_id AND mb.id <> ma.id
    WHERE ${OUVERTE('ma')} AND ${OUVERTE('mb')} AND ma.source_branch IS NOT NULL AND ma.source_branch <> ''
      AND mb.target_branch = ma.source_branch ${borne}`).all(...(borne ? [...mrIds, ...mrIds] : []));
}

/* Le relevé de chaque merge request : sur quel SHA, quand, combien, refusé ou non. */
function releves(mrIds = null) {
  const borne = Array.isArray(mrIds) && mrIds.length ? `WHERE f.mr_id IN (${mrIds.map(() => '?').join(',')})` : '';
  const out = {};
  for (const f of db.prepare(`SELECT f.*, mr.current_sha FROM mr_commit_fetch f JOIN mr ON mr.id = f.mr_id ${borne}`).all(...(borne ? mrIds : []))) {
    out[f.mr_id] = { sha: f.head_sha, at: f.fetched_at, count: f.count, source: f.source, refused: f.refused, fresh: f.head_sha === f.current_sha };
  }
  return out;
}

function fiches(ids) {
  const out = {};
  if (!ids.length) return out;
  for (const m of db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.gitlab_created_at, mr.status, mr.merged_at, mr.closed_seen, mr.web_url, repo.project, rv.note_value,
      (SELECT COUNT(*) FROM mr_files f WHERE f.mr_id = mr.id) AS files
      FROM mr JOIN repo ON repo.id = mr.repo_id LEFT JOIN review rv ON rv.mr_id = mr.id
      WHERE mr.id IN (${ids.map(() => '?').join(',')})`).all(...ids)) out[m.id] = m;
  return out;
}

const ligne = (m, extra = {}) => ({
  id: m.id, iid: m.iid, title: m.title || '', author: m.author || '', created_at: m.gitlab_created_at || null,
  status: m.status || null, project: m.project || null, note: m.note_value != null ? Number(m.note_value) : null,
  files: m.files || 0, ...extra,
});

/* CE QUE LA CARTE AFFICHE, par merge request : `contains` (les MR qu'elle contient, la plus profonde —
   la moins de commits — d'abord), `containedIn`, `basedOn`, `twins`, `history` (les contenues mergées
   depuis moins de sept jours) et `fetch`. Une entrée n'existe que s'il y a quelque chose à dire ou un
   relevé à montrer. Le diff propre (B − A) se calcule à l'ouverture du panneau (`diffPropre`), pas ici. */
function pourCartes(cfg, { mrIds = null } = {}) {
  const out = {};
  if (!actif(cfg)) return out;
  const incl = inclusions({ mrIds });
  const jum = inclusions({ mrIds, jumelles: true });
  const bases = baseesSur({ mrIds });
  const borne = Array.isArray(mrIds) && mrIds.length ? `WHERE h.mr_id IN (${mrIds.map(() => '?').join(',')})` : '';
  const hist = db.prepare(`SELECT h.* FROM mr_contained_history h ${borne}`).all(...(borne ? mrIds : []));
  const ids = new Set();
  for (const r of [...incl, ...jum, ...bases]) { ids.add(r.inner); ids.add(r.outer); }
  for (const h of hist) ids.add(h.other_mr_id);
  const fiche = fiches([...ids]);
  const garde = (id) => Array.isArray(mrIds) && mrIds.length ? mrIds.includes(id) : true;
  const entree = (id) => { if (!out[id]) out[id] = { contains: [], containedIn: [], basedOn: null, twins: [], history: [], fetch: null }; return out[id]; };
  for (const r of incl) {
    if (garde(r.outer) && fiche[r.inner]) entree(r.outer).contains.push(ligne(fiche[r.inner], { shared: r.shared, extra: r.extra }));
    if (garde(r.inner) && fiche[r.outer]) entree(r.inner).containedIn.push(ligne(fiche[r.outer], { shared: r.shared, extra: r.extra }));
  }
  for (const r of jum) {
    if (garde(r.outer) && fiche[r.inner]) entree(r.outer).twins.push(ligne(fiche[r.inner], { shared: r.shared }));
    if (garde(r.inner) && fiche[r.outer]) entree(r.inner).twins.push(ligne(fiche[r.outer], { shared: r.shared }));
  }
  for (const r of bases) if (garde(r.outer) && fiche[r.inner] && !entree(r.outer).basedOn) entree(r.outer).basedOn = ligne(fiche[r.inner]);
  for (const h of hist) if (garde(h.mr_id) && fiche[h.other_mr_id]) entree(h.mr_id).history.push(ligne(fiche[h.other_mr_id], { merged_at: h.merged_at }));
  const parProfondeur = (a, b) => a.shared - b.shared || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  for (const e of Object.values(out)) {
    e.contains.sort(parProfondeur);
    e.containedIn.sort((a, b) => b.shared - a.shared || a.extra - b.extra);   // la plus proche (le moins de commits en plus) d'abord
    e.history.sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)));
  }
  const rel = releves(mrIds);
  for (const [id, f] of Object.entries(rel)) if (out[id]) out[id].fetch = f; else out[id] = { contains: [], containedIn: [], basedOn: null, twins: [], history: [], fetch: f };
  return out;
}

/* LE DIFF PROPRE de B : les fichiers que B touche et qu'aucune des MR qu'elle contient ne touche — ce
   que le reviewer doit lire ici et pas là-bas. Sur `mr_files`, à l'ouverture du panneau. Si la liste de
   l'une des deux n'est pas à jour : `computed: false`, « diff propre non calculé ». */
function diffPropre(cfg, outerId) {
  const vide = { computed: false, count: 0, paths: [] };
  if (!actif(cfg)) return vide;
  const contenues = inclusions({ mrIds: [outerId] }).filter((r) => r.outer === Number(outerId)).map((r) => r.inner);
  if (!contenues.length) return vide;
  const frais = (id) => db.prepare(`SELECT 1 FROM mr_file_fetch f JOIN mr ON mr.id = f.mr_id WHERE f.mr_id = ? AND f.head_sha IS mr.current_sha AND f.refused IS NULL`).get(id);
  if (!frais(outerId) || contenues.some((id) => !frais(id))) return vide;
  const q = contenues.map(() => '?').join(',');
  const paths = db.prepare(`SELECT path FROM mr_files WHERE mr_id = ? AND path NOT IN (SELECT path FROM mr_files WHERE mr_id IN (${q})) ORDER BY path`)
    .all(outerId, ...contenues).map((r) => r.path);
  return { computed: true, count: paths.length, paths: paths.slice(0, CHEMINS_PAR_PANNEAU) };
}

/* ---------- La modale de session ---------- */

/* La session repart de la branche d'une merge request ouverte : la branche créée la contiendra. On le
   sait avant de commencer. Rend `{ id, iid, status }` ou null. */
function pourBranche(cfg, { repoId, branch = '' } = {}) {
  if (!actif(cfg) || !branch) return null;
  return db.prepare(`SELECT id, iid, status FROM mr WHERE repo_id = ? AND source_branch = ? AND ${OUVERTE('mr')} ORDER BY id DESC LIMIT 1`).get(Number(repoId), String(branch)) || null;
}

/* ---------- La review ---------- */

/* LA PHRASE DE FAIT du contexte de review — le seul endroit où l'information entre dans un prompt :
   « Cette merge request contient !214 (ouverte, à traiter) : 12 commits et 9 fichiers sont déjà soumis
   là-bas. » Une phrase par merge request contenue ; rien sinon. Un fait, pas une consigne. */
function phrasesDeFait(cfg, mrId) {
  const e = pourCartes(cfg, { mrIds: [Number(mrId)] })[Number(mrId)];
  if (!e || !e.contains.length) return [];
  return e.contains.map((c) => t('review.stack.fact', { iid: c.iid, status: t(`mr.status.${String(c.status || 'to_review').replace('_', '-')}`), commits: c.shared, files: c.files }));
}

/* ---------- Purger ---------- */
function purger(mrIds) {
  const ids = (Array.isArray(mrIds) ? mrIds : [mrIds]).map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  const q = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM mr_commits WHERE mr_id IN (${q})`).run(...ids);
  db.prepare(`DELETE FROM mr_contained_history WHERE mr_id IN (${q}) OR other_mr_id IN (${q})`).run(...ids, ...ids);
  return db.prepare(`DELETE FROM mr_commit_fetch WHERE mr_id IN (${q})`).run(...ids).changes;
}

module.exports = {
  MAX_COMMITS, HISTORIQUE_JOURS, CHEMINS_PAR_PANNEAU, actif, A_RELEVER,
  releverCommits, releverEtPoser, poserCommits, archiverFermees,
  inclusions, baseesSur, releves, pourCartes, diffPropre, pourBranche, phrasesDeFait, purger,
};
