'use strict';
/* LES CROISEMENTS DE MERGE REQUESTS — deux MR ouvertes du même dépôt qui modifient le même fichier.
 *
 * Mergerie parlait du conflit APRÈS coup : le badge « en conflit », les « N commits de retard ».
 * Rien ne disait, pendant que deux branches avançaient en parallèle, qu'elles allaient se
 * rencontrer. Un croisement est un FAIT : même dépôt, même fichier, MR ouvertes — calculé en SQL
 * et en git, sans aucun appel d'IA, sans jugement, sans note. L'outil montre ; l'humain décide
 * l'ordre des merges. Ce module n'importe rien de `agent/` et un test le garde fermé.
 *
 * Deux moments, bien séparés :
 *   — LE RELEVÉ, dans la découverte des MR (`releverTour`), jamais à l'affichage. La liste des
 *     fichiers d'une MR se lit, dans cet ordre : le diff déjà stocké pour une MR reviewée (aucun
 *     appel, s'il porte sur la tête actuelle), le clone local (aucun réseau), la forge (un appel
 *     par MR, plafonné par tour). Invalidée dès que le SHA de tête change, comme le badge « périmé ».
 *   — LE CALCUL, à l'affichage (`croisements`) : une jointure de `mr_files` sur lui-même, sans
 *     cache applicatif. Une MR sans relevé frais n'affiche rien — jamais « aucun croisement ».
 *
 * Deux MR qui ne visent pas la même branche cible ne se croisent pas (une MR vers `main` et une
 * vers `release/4.2` ne se mergeront pas l'une sur l'autre), sauf réglage contraire. Une liste de
 * plus de `MAX_FICHIERS` chemins n'est pas stockée : un croisement avec une migration massive
 * serait vrai de presque tout et n'apprendrait rien. */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const forge = require('../forge');
const git = require('../git/git');
const dependances = require('./dependances');
const empilees = require('./empilees');

const MAX_FICHIERS = 5000;
const PLAFOND_DEFAUT = 20;
const CHEMINS_PAR_MR = 10;   // au-delà, le panneau replie « et N autres »

const actif = (cfg) => String((cfg && cfg.mr_files_enabled) ?? '1') !== '0';
const entreCibles = (cfg) => String((cfg && cfg.mr_files_cross_targets) || '') === '1';
function plafond(cfg) {
  const n = parseInt(cfg && cfg.mr_files_max, 10);
  return Number.isFinite(n) && n >= 0 ? n : PLAFOND_DEFAUT;
}

/* ---------- Lire une liste de fichiers ---------- */

/* Les deux chemins de chaque en-tête `diff --git a/x b/y` : pour un renommage, l'ancien ET le
   nouveau comptent (une MR qui renomme `a.js` croise celle qui modifie `a.js`). */
function cheminsDuDiff(diff) {
  const out = new Set();
  for (const m of String(diff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    if (m[1] && m[1] !== '/dev/null') out.add(m[1]);
    if (m[2] && m[2] !== '/dev/null') out.add(m[2]);
  }
  return [...out];
}

/* `git diff --name-status` : `M\tchemin`, `R100\tancien\tnouveau`, `C\tancien\tnouveau`. */
function cheminsNameStatus(stdout) {
  const out = new Set();
  for (const ligne of String(stdout || '').split('\n')) {
    const parts = ligne.split('\t');
    if (parts.length < 2) continue;
    for (const p of parts.slice(1)) if (p) out.add(p);
  }
  return [...out];
}

/* 1. Le diff stocké par la review, s'il parle de la tête ACTUELLE. `manifeste` (prédicat sur un
   chemin, ou null) : les blocs des manifestes sont gardés au passage, pour les dépendances. */
function depuisLaReview(mr, manifeste = null) {
  if (!mr.reviewed_sha || !mr.current_sha || mr.reviewed_sha !== mr.current_sha) return null;
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  if (!rev || !rev.diff_path) return null;
  let diff;
  try { diff = fs.readFileSync(rev.diff_path, 'utf8'); } catch { return null; }
  if (!diff.trim()) return null;
  const paths = cheminsDuDiff(diff);
  return { paths, files: paths.length, additions: null, deletions: null, source: 'review', manifests: manifeste ? dependances.blocsManifestes(diff, manifeste) : [] };
}

/* 2. Le clone local, s'il porte la branche À SA TÊTE ACTUELLE — aucun fetch : la découverte ne
   doit pas devenir un `git fetch` par merge request. */
async function depuisLeClone(cfg, repo, mr, manifeste = null) {
  if (!mr.source_branch || !mr.target_branch || !mr.current_sha) return null;
  const cwd = git.cloneDirFor(cfg, repo);
  if (!fs.existsSync(path.join(cwd, '.git'))) return null;
  try {
    const { stdout: tete } = await git.run('git', ['rev-parse', '--verify', '--quiet', `origin/${mr.source_branch}^{commit}`], { cwd });
    if (String(tete).trim() !== mr.current_sha) return null;
    if (!await git.refExists(cwd, `origin/${mr.target_branch}`)) return null;
    const { stdout } = await git.run('git', ['diff', '--name-status', '--find-renames', `origin/${mr.target_branch}...origin/${mr.source_branch}`], { cwd, maxBuffer: 1024 * 1024 * 64 });
    const paths = cheminsNameStatus(stdout);
    // Les manifestes seulement : un second diff, borné à leurs chemins — toujours aucun réseau.
    let manifests = [];
    const mans = manifeste ? paths.filter(manifeste) : [];
    if (mans.length) {
      const { stdout: d } = await git.run('git', ['diff', '--find-renames', `origin/${mr.target_branch}...origin/${mr.source_branch}`, '--', ...mans], { cwd, maxBuffer: 1024 * 1024 * 64 });
      manifests = dependances.blocsManifestes(d, manifeste);
    }
    return { paths, files: paths.length, additions: null, deletions: null, source: 'clone', manifests };
  } catch { return null; }
}

/* 3. La forge — par `clientFor(repo)`, pour qu'une autre forge s'y branche sans toucher au calcul. */
async function depuisLaForge(cfg, repo, mr, manifeste = null) {
  const ch = await forge.clientFor(repo).listMrChanges(cfg, repo.project, mr.iid, { manifeste });
  return { paths: [...new Set(ch.paths || [])], files: ch.files, additions: ch.additions, deletions: ch.deletions, source: 'forge', manifests: ch.manifests || [] };
}

async function releverFichiers(cfg, repo, mr, { manifeste = null } = {}) {
  return depuisLaReview(mr, manifeste) || await depuisLeClone(cfg, repo, mr, manifeste) || depuisLaForge(cfg, repo, mr, manifeste);
}

/* ---------- Écrire ---------- */

const poserFichiers = db.transaction((mrId, sha, paths, { source = null, refused = null, now = new Date().toISOString() } = {}) => {
  db.prepare('DELETE FROM mr_files WHERE mr_id = ?').run(mrId);
  if (!refused) {
    const ins = db.prepare('INSERT OR IGNORE INTO mr_files (mr_id, path) VALUES (?, ?)');
    for (const p of paths) ins.run(mrId, p);
  }
  db.prepare(`INSERT INTO mr_file_fetch (mr_id, head_sha, fetched_at, files, source, refused) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(mr_id) DO UPDATE SET head_sha = excluded.head_sha, fetched_at = excluded.fetched_at,
      files = excluded.files, source = excluded.source, refused = excluded.refused`)
    .run(mrId, sha || null, now, paths.length, source, refused);
});

/* Relève et écrit, pour UNE merge request : la liste (`mr_files`), le relevé (`mr_file_fetch`) et
   les colonnes de la carte (`changed_paths`, taille) que le badge « risque » et les règles par
   chemin lisent déjà. Rend `{ source, files, refused }` ; jette si aucune source n'a répondu. */
async function releverEtPoser(cfg, repo, mr, { now = new Date().toISOString() } = {}) {
  /* Les dépendances : le diff des seuls manifestes, gardé dans le même geste — le prédicat filtre
     AVANT que la source ne jette le reste. Réglage décoché : pas cherché (NULL), rien affiché. */
  const depsActives = dependances.actif(cfg);
  const manifeste = depsActives ? dependances.predicat(dependances.motifsPour(cfg, repo.id).manifests) : null;
  const r = await releverFichiers(cfg, repo, mr, { manifeste });
  if (r.paths.length > MAX_FICHIERS) {
    poserFichiers(mr.id, mr.current_sha, [], { source: r.source, refused: 'too-many-files', now });
    dependances.poserManifestes(mr.id, mr.current_sha, null, { now });
    return { source: r.source, files: r.paths.length, refused: 'too-many-files' };
  }
  poserFichiers(mr.id, mr.current_sha, r.paths, { source: r.source, now });
  dependances.poserManifestes(mr.id, mr.current_sha, depsActives ? (r.manifests || []) : null, { now });
  db.prepare(`UPDATE mr SET changed_paths = ?, changed_files = COALESCE(?, changed_files),
      changed_additions = COALESCE(?, changed_additions), changed_deletions = COALESCE(?, changed_deletions) WHERE id = ?`)
    .run(r.paths.join('\n'), r.files ?? null, r.additions ?? null, r.deletions ?? null, mr.id);
  return { source: r.source, files: r.paths.length, refused: null };
}

/* LE TOUR DE RELEVÉ, dans la découverte. Les MR ouvertes des dépôts suivis dont la liste manque ou
   ne porte plus sur la tête actuelle, les plus récemment actives d'abord, PLAFONNÉES : le reste
   attend le tour suivant, et le journal le nomme — un plafond silencieux se lirait comme « tout
   est relevé ». Interrupteur décoché : on garde le comportement d'avant (les chemins d'une MR qui
   n'en a jamais eu, pour le badge « risque », 25 par tour), aucun appel de plus.
   Best-effort par MR : un fork dont le diff n'est pas lisible n'affiche rien, et le journal dit
   pourquoi. */
async function releverTour(cfg, { onLog = (m) => console.log(`[croisements] ${m}`) } = {}) {
  const enService = actif(cfg);
  const bilan = { releves: 0, restants: 0, refuses: 0, erreurs: 0, sources: {}, dependances: 0, commits: { releves: 0, refuses: 0, erreurs: 0 } };
  /* Un relevé frais qui n'a pas cherché les manifestes (antérieur aux dépendances, ou fait réglage
     décoché) est repris comme un SHA qui a bougé, sous le même plafond — et le journal le dit une fois.
     Une liste REFUSÉE ne l'est pas : on ne retente pas un relevé refusé sur le même SHA. */
  const pourDeps = enService && dependances.actif(cfg) ? 'OR (f.head_sha IS mr.current_sha AND f.refused IS NULL AND f.manifests IS NULL)' : '';
  /* LES COMMITS (MR empilées) : la même file, le même plafond — une MR relevée pour ses fichiers l'est
     pour ses commits dans le même tour ; une MR dont seule la liste de commits manque prend une place
     du plafond sans relire ses fichiers. */
  const commitsActifs = enService && empilees.actif(cfg);
  const pourCommits = commitsActifs ? `OR ${empilees.A_RELEVER('cf', 'mr')}` : '';
  const candidats = enService
    ? db.prepare(`SELECT mr.*, repo.project AS project, repo.forge AS forge, repo.url AS url,
          (f.mr_id IS NOT NULL AND f.head_sha IS mr.current_sha AND f.refused IS NULL AND f.manifests IS NULL) AS pour_deps,
          (f.mr_id IS NULL OR f.head_sha IS NOT mr.current_sha ${pourDeps}) AS pour_fichiers,
          ${commitsActifs ? empilees.A_RELEVER('cf', 'mr') : '0'} AS pour_commits
        FROM mr JOIN repo ON repo.id = mr.repo_id
        LEFT JOIN mr_file_fetch f ON f.mr_id = mr.id
        LEFT JOIN mr_commit_fetch cf ON cf.mr_id = mr.id
        WHERE COALESCE(mr.closed_seen, 0) = 0 AND repo.enabled = 1 AND COALESCE(repo.fetch_mrs, 1) = 1
          AND (f.mr_id IS NULL OR f.head_sha IS NOT mr.current_sha ${pourDeps} ${pourCommits})
        ORDER BY mr.updated_at DESC, mr.id DESC`).all()
    : db.prepare(`SELECT mr.*, repo.project AS project, repo.forge AS forge, repo.url AS url, 1 AS pour_fichiers, 0 AS pour_commits
        FROM mr JOIN repo ON repo.id = mr.repo_id
        WHERE mr.changed_paths IS NULL AND COALESCE(mr.closed_seen, 0) = 0
          AND repo.enabled = 1 AND COALESCE(repo.fetch_mrs, 1) = 1
        ORDER BY mr.updated_at DESC, mr.id DESC LIMIT 25`).all();
  const max = enService ? plafond(cfg) : 25;
  const pris = max > 0 ? candidats.slice(0, max) : candidats;
  bilan.restants = candidats.length - pris.length;
  bilan.dependances = candidats.filter((c) => c.pour_deps).length;
  if (bilan.dependances) onLog(`${bilan.dependances} MR à relever pour les dépendances`);
  for (const mr of pris) {
    const repo = { id: mr.repo_id, project: mr.project, forge: mr.forge, url: mr.url };
    if (mr.pour_fichiers) {
      try {
        const r = await releverEtPoser(cfg, repo, mr);
        bilan.sources[r.source] = (bilan.sources[r.source] || 0) + 1;
        if (r.refused) {
          bilan.refuses += 1;
          onLog(`!${mr.iid} (${mr.project}) : ${r.files} fichiers, liste non relevée — au-delà de ${MAX_FICHIERS}, un croisement ne dirait plus rien`);
        } else bilan.releves += 1;
      } catch (e) {
        bilan.erreurs += 1;
        onLog(`!${mr.iid} (${mr.project}) : fichiers non relevés${mr.is_fork ? ' (merge request venue d’un fork)' : ''} — ${e.message}`);
      }
    }
    if (mr.pour_commits) {
      try {
        const r = await empilees.releverEtPoser(cfg, repo, mr);
        if (r.refused) {
          bilan.commits.refuses += 1;
          onLog(`!${mr.iid} (${mr.project}) : ${r.count} commits, liste non relevée — ${r.refused === 'truncated' ? 'tronquée par la forge' : `au-delà de ${empilees.MAX_COMMITS}`}, une inclusion ne se calcule pas sur une liste partielle`);
        } else bilan.commits.releves += 1;
      } catch (e) {
        /* Une forge muette sur les commits ne prend pas une place du plafond à chaque tour : le refus
           est posé sur ce SHA, et le tour reprendra la liste quand la tête bougera. */
        bilan.commits.erreurs += 1;
        empilees.poserCommits(mr.id, { sha: mr.current_sha, target: mr.target_branch, refused: 'error' });
        onLog(`!${mr.iid} (${mr.project}) : commits non relevés — ${e.message}`);
      }
    }
  }
  if (bilan.restants) onLog(`plafond atteint (${max}) : ${bilan.restants} liste(s) de fichiers attendront le tour suivant`);
  // Les MR contenues qui ont fermé depuis : la trace « contenait !214 » pour sept jours, leurs listes purgées.
  if (commitsActifs) bilan.commits.archivees = empilees.archiverFermees();
  return bilan;
}

/* ---------- Calculer ---------- */

/* La condition de fraîcheur d'un relevé : il porte sur la tête ACTUELLE de la merge request. Un
   SHA qui a bougé invalide la liste — le badge disparaît jusqu'au relevé suivant. */
const FRAIS = (f, m) => `${f}.head_sha IS ${m}.current_sha AND ${f}.refused IS NULL`;

/* Toutes les paires (mr, autre, chemin) — symétriques : si A croise B, B croise A. Une requête,
   à l'affichage, sans cache. Rend `Map<mr_id, Map<other_id, paths[]>>`. */
function croisements(cfg, { mrIds = null } = {}) {
  const out = new Map();
  if (!actif(cfg)) return out;
  const cible = entreCibles(cfg) ? '' : 'AND ma.target_branch IS mb.target_branch';
  const borne = Array.isArray(mrIds) && mrIds.length ? `AND a.mr_id IN (${mrIds.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT a.mr_id AS mr, b.mr_id AS other, a.path AS path
    FROM mr_files a
    JOIN mr_files b ON b.path = a.path AND b.mr_id <> a.mr_id
    JOIN mr ma ON ma.id = a.mr_id
    JOIN mr mb ON mb.id = b.mr_id
    JOIN mr_file_fetch fa ON fa.mr_id = ma.id AND ${FRAIS('fa', 'ma')}
    JOIN mr_file_fetch fb ON fb.mr_id = mb.id AND ${FRAIS('fb', 'mb')}
    WHERE ma.repo_id = mb.repo_id
      AND COALESCE(ma.closed_seen, 0) = 0 AND COALESCE(mb.closed_seen, 0) = 0
      ${cible} ${borne}
    ORDER BY a.mr_id, b.mr_id, a.path`).all(...(borne ? mrIds : []));
  for (const r of rows) {
    if (!out.has(r.mr)) out.set(r.mr, new Map());
    const par = out.get(r.mr);
    if (!par.has(r.other)) par.set(r.other, []);
    par.get(r.other).push(r.path);
  }
  return out;
}

/* Le relevé de chaque merge request ouverte : sur quel SHA, quand, combien, refusé ou non — le
   pied du panneau et le « non relevé · trop de fichiers » du bouton ⋯ en vivent. */
function releves(mrIds = null) {
  const borne = Array.isArray(mrIds) && mrIds.length ? `WHERE f.mr_id IN (${mrIds.map(() => '?').join(',')})` : '';
  const out = {};
  for (const f of db.prepare(`SELECT f.*, mr.current_sha FROM mr_file_fetch f JOIN mr ON mr.id = f.mr_id ${borne}`).all(...(borne ? mrIds : []))) {
    out[f.mr_id] = { sha: f.head_sha, at: f.fetched_at, files: f.files, source: f.source, refused: f.refused, fresh: f.head_sha === f.current_sha };
  }
  return out;
}

/* CE QUE LA CARTE AFFICHE : par merge request, les MR croisées (numéro, titre, auteur, âge, note
   si un rapport existe), les chemins communs triés et repliés au-delà de dix, et le relevé. */
function pourCartes(cfg, { mrIds = null } = {}) {
  const out = {};
  if (!actif(cfg)) return out;
  const paires = croisements(cfg, { mrIds });
  const autres = new Set();
  for (const par of paires.values()) for (const id of par.keys()) autres.add(id);
  const fiche = {};
  if (autres.size) {
    const ids = [...autres];
    for (const m of db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.gitlab_created_at, mr.status, repo.project, rv.note_value
        FROM mr JOIN repo ON repo.id = mr.repo_id LEFT JOIN review rv ON rv.mr_id = mr.id
        WHERE mr.id IN (${ids.map(() => '?').join(',')})`).all(...ids)) fiche[m.id] = m;
  }
  const rel = releves(mrIds);
  for (const [id, par] of paires) {
    const overlaps = [...par.entries()].map(([other, paths]) => {
      const m = fiche[other] || {};
      const tries = [...paths].sort();
      return {
        id: other, iid: m.iid, title: m.title || '', author: m.author || '', created_at: m.gitlab_created_at || null,
        status: m.status || null, project: m.project || null,
        note: m.note_value != null ? Number(m.note_value) : null,
        shared: tries.length, paths: tries.slice(0, CHEMINS_PAR_MR),
      };
    }).sort((a, b) => b.shared - a.shared || String(a.created_at || '').localeCompare(String(b.created_at || '')));
    out[id] = { overlaps, fetch: rel[id] || null };
  }
  for (const id of Object.keys(rel)) if (!out[id]) out[id] = { overlaps: [], fetch: rel[id] };
  return out;
}

/* LES PAIRES POUR LE BRIEF : une ligne par paire (a < b), les plus anciennes d'abord — une paire
   existe depuis l'ouverture de la plus jeune de ses deux merge requests. `key` est ce qu'on
   écarte : une paire, pas un dépôt — une paire nouvelle reparaît. */
function paires(cfg, limite = 8) {
  const out = [];
  const paires0 = croisements(cfg);
  if (!paires0.size) return out;
  const ids = [...paires0.keys()];
  const fiche = {};
  for (const m of db.prepare(`SELECT mr.id, mr.iid, mr.gitlab_created_at, mr.repo_id, repo.project
      FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id IN (${ids.map(() => '?').join(',')})`).all(...ids)) fiche[m.id] = m;
  for (const [a, par] of paires0) {
    for (const [b, paths] of par) {
      if (!(a < b)) continue;
      const ma = fiche[a]; const mb = fiche[b];
      if (!ma || !mb) continue;
      const dates = [ma.gitlab_created_at, mb.gitlab_created_at].filter(Boolean).sort();
      out.push({
        key: `${a}-${b}`, a_id: a, b_id: b, a_iid: ma.iid, b_iid: mb.iid,
        repo_id: ma.repo_id, project: ma.project, shared: paths.length,
        since: dates.length ? dates[dates.length - 1] : null,
      });
    }
  }
  out.sort((x, y) => String(x.since || '9999').localeCompare(String(y.since || '9999')) || x.key.localeCompare(y.key));
  return limite > 0 ? out.slice(0, limite) : out;
}

/* ---------- La modale de session ---------- */

/* Un chemin ÉCRIT DANS LE PROMPT (`src/payment/`, `tva.js`) qui existe dans le clone : détection
   simple, sans deviner. Les candidats : un mot qui contient un `/` ou une extension. */
function cheminsCites(texte, cwd) {
  if (!texte || !cwd || !fs.existsSync(path.join(cwd, '.git'))) return [];
  const vus = new Set();
  const out = [];
  for (const brut of String(texte).match(/[\w.@-]+(?:\/[\w.@-]+)*\/?/g) || []) {
    const mot = brut.replace(/^[./]+|[.,;:!?)]+$/g, '').replace(/\/+$/, '');
    // Un mot nu (« src ») n'est pas un chemin ; « src/ », « src/tva.js » ou « tva.js » en sont.
    if (!mot || vus.has(mot) || mot.includes('..') || !(brut.endsWith('/') || mot.includes('/') || /\.[a-z0-9]{1,6}$/i.test(mot))) continue;
    vus.add(mot);
    const abs = path.resolve(cwd, mot);
    if (!abs.startsWith(cwd + path.sep)) continue;
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    out.push({ path: mot, dir: st.isDirectory() });
    if (out.length >= 5) break;
  }
  return out;
}

/* Sous le choix d'un dépôt : combien de MR ouvertes il porte ; les croisements de la MR dont la
   session repart (branche existante) ; et les MR ouvertes qui touchent un chemin cité dans le
   prompt. Information seulement : la session se lance quand même. */
function pourSession(cfg, { repoId, branch = '', texte = '' } = {}) {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(repoId));
  if (!repo) return null;
  const open = db.prepare('SELECT COUNT(*) n FROM mr WHERE repo_id = ? AND COALESCE(closed_seen, 0) = 0').get(repo.id).n;
  const out = { repo_id: repo.id, project: repo.project, open, mr: null, overlaps: [], paths: [] };
  if (!actif(cfg)) return out;
  if (branch) {
    const mr = db.prepare('SELECT id, iid FROM mr WHERE repo_id = ? AND source_branch = ? AND COALESCE(closed_seen, 0) = 0 ORDER BY id DESC LIMIT 1').get(repo.id, branch);
    if (mr) {
      out.mr = mr;
      out.overlaps = ((pourCartes(cfg, { mrIds: [mr.id] })[mr.id] || {}).overlaps || []).map((o) => ({ id: o.id, iid: o.iid, title: o.title, shared: o.shared }));
    }
  }
  const cites = cheminsCites(texte, git.cloneDirFor(cfg, repo));
  for (const c of cites) {
    const rows = db.prepare(`SELECT DISTINCT mr.id, mr.iid FROM mr_files f
        JOIN mr ON mr.id = f.mr_id JOIN mr_file_fetch ff ON ff.mr_id = mr.id AND ${FRAIS('ff', 'mr')}
        WHERE mr.repo_id = ? AND COALESCE(mr.closed_seen, 0) = 0 AND (f.path = ? OR f.path LIKE ?)
        ORDER BY mr.iid`).all(repo.id, c.path, c.dir ? `${c.path}/%` : c.path);
    if (rows.length) out.paths.push({ path: c.dir ? `${c.path}/` : c.path, mrs: rows });
  }
  return out;
}

/* ---------- Purger ---------- */
function purger(mrIds) {
  const ids = (Array.isArray(mrIds) ? mrIds : [mrIds]).map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  const q = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM mr_files WHERE mr_id IN (${q})`).run(...ids);
  dependances.purger(ids);
  empilees.purger(ids);
  return db.prepare(`DELETE FROM mr_file_fetch WHERE mr_id IN (${q})`).run(...ids).changes;
}

module.exports = {
  MAX_FICHIERS, CHEMINS_PAR_MR, actif, plafond, entreCibles,
  cheminsDuDiff, cheminsNameStatus, cheminsCites,
  releverFichiers, releverEtPoser, releverTour, poserFichiers,
  croisements, releves, pourCartes, paires, pourSession, purger,
};
