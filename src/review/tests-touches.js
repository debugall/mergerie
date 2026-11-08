'use strict';
/* LES TESTS TOUCHÉS PAR UNE MERGE REQUEST — « 14 fichiers · 0 test » à côté du nombre de fichiers.
 *
 * « Elle passe les tests » ne dit pas si elle en apporte. Un fichier EST un test ou n'en est pas
 * un, selon des motifs de chemin : c'est un fait, calculé ici sur les listes de fichiers déjà
 * relevées pour les croisements (`mr_files`), sans aucun appel d'IA, sans lecture du contenu,
 * sans couverture estimée. Le badge compte des fichiers, c'est tout ce qu'il sait ; une merge
 * request de documentation n'a pas de test et c'est normal. Ce module n'importe rien de
 * `agent/` et un test le garde fermé.
 *
 * Trois nombres par merge request : code, tests, neutres (documentation, images, lockfiles,
 * outillage — ni d'un côté ni de l'autre). Les motifs se résolvent dépôt → groupe(s) → défaut
 * global → défauts livrés : un niveau rempli remplace celui du dessus. Rien n'est stocké : un
 * motif qui change change le badge sans attendre un relevé. */
const fs = require('fs');
const db = require('../db');
const glob = require('../core/glob');
const groupes = require('../data/groupes');
const croisements = require('./croisements');

const DEFAUT_TESTS = [
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**', '**/*Test.php',
  '**/*_test.go', '**/test_*.py', '**/*_spec.rb', '**/*Tests.cs', '**/*.feature', '**/cypress/**', '**/e2e/**',
];
const DEFAUT_NEUTRES = [
  '**/*.md', '**/docs/**', '**/*.lock', 'package-lock.json', 'composer.lock', 'yarn.lock', 'pnpm-lock.yaml',
  '**/*.png', '**/*.jpg', '**/*.svg', '**/*.gif', '**/.github/**', '**/.gitlab-ci.yml', '**/Dockerfile*',
  '**/docker-compose*.yml', 'config/**/*.json', '.vscode/**', '.idea/**',
];
const { MAX_MOTIFS, normaliserMotifs } = glob;
const SEUIL_DEFAUT = 3;
const CHEMINS_PAR_MR = 10;

/* ---------- Les réglages ---------- */
const actif = (cfg) => String((cfg && cfg.tests_touched_enabled) ?? '1') !== '0' && croisements.actif(cfg);
function seuil(cfg) {
  const n = parseInt(cfg && cfg.tests_touched_min_code, 10);
  return Number.isFinite(n) && n >= 0 ? n : SEUIL_DEFAUT;
}

/* ---------- Les motifs ---------- */
const lignes = (texte) => String(texte || '').split('\n').map((l) => l.trim()).filter(Boolean);

/* `normaliserMotifs` vit dans `core/glob.js` : la configuration (couche data) valide les listes
   avec la même règle que les routes des dépôts et des groupes. */

/* Les motifs qui valent pour un dépôt, liste par liste : le dépôt s'il en porte, sinon l'UNION de
   ses groupes qui en portent (et la source les nomme), sinon le réglage global, sinon les défauts
   livrés. `repoId` absent : global ou défauts. */
function motifsPour(cfg, repoId) {
  const repo = repoId ? db.prepare('SELECT id, test_patterns, neutral_patterns FROM repo WHERE id = ?').get(Number(repoId)) : null;
  const gs = repo ? groupes.groupesDuDepot(repo.id) : [];
  const resoudre = (champ, defaut) => {
    if (repo && lignes(repo[champ]).length) return { patterns: lignes(repo[champ]), source: { kind: 'repo', repo_id: repo.id } };
    const porteurs = gs.filter((g) => lignes(g[champ]).length);
    if (porteurs.length) {
      return {
        patterns: [...new Set(porteurs.flatMap((g) => lignes(g[champ])))],
        source: { kind: 'group', groups: porteurs.map((g) => ({ id: g.id, name: g.name })) },
      };
    }
    if (lignes(cfg && cfg[champ]).length) return { patterns: lignes(cfg[champ]), source: { kind: 'config' } };
    return { patterns: defaut, source: { kind: 'default' } };
  };
  const tests = resoudre('test_patterns', DEFAUT_TESTS);
  const neutres = resoudre('neutral_patterns', DEFAUT_NEUTRES);
  return { tests: tests.patterns, neutres: neutres.patterns, source: { tests: tests.source, neutres: neutres.source } };
}

/* ---------- La classification ---------- */
const cacheRegex = new Map();
function regexDe(motif) {
  if (!cacheRegex.has(motif)) {
    if (cacheRegex.size > 2000) cacheRegex.clear();
    let re = null;
    try { re = glob.globToRegex(motif); } catch { re = null; }
    cacheRegex.set(motif, re);
  }
  return cacheRegex.get(motif);
}
function compiler(motifs) {
  return (motifs || []).map(regexDe).filter(Boolean);
}
/* Un chemin est testé contre `tests` d'abord, puis `neutres` : le premier qui matche l'emporte
   (`docs/example.test.js` est un test). Le reste est du code. */
function classer(paths, motifs) {
  const reTests = compiler(motifs.tests);
  const reNeutres = compiler(motifs.neutres);
  const out = { code: 0, tests: 0, neutral: 0, testPaths: [] };
  for (const brut of paths || []) {
    const p = String(brut || '').replace(/^\.?\//, '');
    if (!p) continue;
    if (reTests.some((re) => re.test(p))) { out.tests += 1; out.testPaths.push(p); } else if (reNeutres.some((re) => re.test(p))) out.neutral += 1;
    else out.code += 1;
  }
  out.testPaths.sort();
  return out;
}

/* Le badge est INFORMATIF quand il y a des tests, VISIBLE quand il n'y en a pas — seulement à
   partir de N fichiers de code (une correction de deux lignes ne porte rien). Que des neutres :
   rien. */
const alerte = (cfg, c) => c.tests === 0 && c.code > 0 && c.code >= seuil(cfg);

/* Les chemins des merge requests ouvertes dont le relevé est FRAIS (tête actuelle, non refusé) :
   sans liste fraîche, pas de classification — jamais un faux « 0 test ». */
function cheminsFrais(mrIds = null) {
  const borne = Array.isArray(mrIds) && mrIds.length ? `AND mr.id IN (${mrIds.map(() => '?').join(',')})` : '';
  const par = new Map();
  for (const r of db.prepare(`SELECT mr.id, mr.repo_id, f.path, ff.head_sha, ff.fetched_at
      FROM mr JOIN mr_file_fetch ff ON ff.mr_id = mr.id AND ff.head_sha IS mr.current_sha AND ff.refused IS NULL
      LEFT JOIN mr_files f ON f.mr_id = mr.id
      WHERE COALESCE(mr.closed_seen, 0) = 0 ${borne}`).all(...(borne ? mrIds : []))) {
    if (!par.has(r.id)) par.set(r.id, { repo_id: r.repo_id, sha: r.head_sha, at: r.fetched_at, paths: [] });
    if (r.path) par.get(r.id).paths.push(r.path);
  }
  return par;
}

/* CE QUE LA CARTE AFFICHE, par merge request : les trois nombres, les tests touchés (triés, dix au
   plus et le total), l'alerte, d'où viennent les motifs, et le relevé. Absent = rien à dire. */
function pourCartes(cfg, { mrIds = null } = {}) {
  const out = {};
  if (!actif(cfg)) return out;
  const motifsParRepo = new Map();
  for (const [id, m] of cheminsFrais(mrIds)) {
    if (!motifsParRepo.has(m.repo_id)) motifsParRepo.set(m.repo_id, motifsPour(cfg, m.repo_id));
    const motifs = motifsParRepo.get(m.repo_id);
    const c = classer(m.paths, motifs);
    out[id] = {
      code: c.code, tests: c.tests, neutral: c.neutral,
      test_paths: c.testPaths.slice(0, CHEMINS_PAR_MR),
      alert: alerte(cfg, c),
      patterns: motifs.source,
      fetch: { sha: m.sha, at: m.at },
    };
  }
  return out;
}

/* LES MR SANS TEST POUR LE BRIEF : celles qui portent le badge accentué, les plus anciennes
   d'abord. `key` est ce qu'on écarte : CETTE merge request SUR CE SHA — un relevé sur un nouveau
   SHA la fait reparaître. */
function sansTest(cfg, limite = 8) {
  const cartes = pourCartes(cfg);
  const ids = Object.keys(cartes).filter((id) => cartes[id].alert).map(Number);
  if (!ids.length) return [];
  const out = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.gitlab_created_at, mr.repo_id, mr.status, repo.project
      FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id IN (${ids.map(() => '?').join(',')})
      ORDER BY mr.gitlab_created_at IS NULL, mr.gitlab_created_at, mr.id`).all(...ids)
    .map((m) => ({
      key: `${m.id}:${cartes[m.id].fetch.sha || ''}`, mr_id: m.id, iid: m.iid, title: m.title || '', author: m.author || '', status: m.status,
      project: m.project, repo_id: m.repo_id, code: cartes[m.id].code, created_at: m.gitlab_created_at,
    }));
  return limite > 0 ? out.slice(0, limite) : out;
}

/* LA LIGNE DE PROJET D'UNE SESSION DE CODAGE : le diff de la branche (`task_target.diff_path`, écrit
   à chaque passe) classé avec les motifs du dépôt — « 0 test modifié » avant que la merge request
   n'existe, quand un suivi « ajoute les tests » coûte le moins. Mémorisé par commit : l'écran se
   redessine toutes les secondes et demie. Rend `null` sans commit ou sans diff. */
const cacheCibles = new Map();
function pourCible(cfg, cible) {
  if (!actif(cfg) || !cible || !cible.commit_sha || !cible.diff_path || !cible.repo_id) return null;
  const motifs = motifsPour(cfg, cible.repo_id);
  const cle = [cible.id, cible.commit_sha, cible.diff_path, motifs.tests.join('|'), motifs.neutres.join('|')].join('\u0001');
  if (cacheCibles.has(cle)) return cacheCibles.get(cle);
  let diff = null;
  try { diff = fs.readFileSync(cible.diff_path, 'utf8'); } catch { return null; }
  const c = classer(croisements.cheminsDuDiff(diff), motifs);
  const r = { code: c.code, tests: c.tests, neutral: c.neutral };
  if (cacheCibles.size > 500) cacheCibles.clear();
  cacheCibles.set(cle, r);
  return r;
}

/* L'APERÇU D'UN RÉGLAGE : « sur les MR ouvertes de ce dépôt, ces motifs classent 41 fichiers en
   tests, 12 en neutres » — en mémoire sur `mr_files`, pour vérifier un motif sans attendre une
   merge request. Portée : un dépôt, les dépôts d'un groupe, ou tous. Un champ vide hérite,
   comme à l'affichage. */
function apercu(cfg, { repoId = null, groupId = null, test_patterns = null, neutral_patterns = null } = {}) {
  let repoIds = null;
  if (repoId) repoIds = [Number(repoId)];
  else if (groupId) repoIds = groupes.membres(groupId);
  const borne = repoIds ? `AND mr.repo_id IN (${repoIds.length ? repoIds.map(() => '?').join(',') : 'NULL'})` : '';
  const ids = db.prepare(`SELECT mr.id FROM mr WHERE COALESCE(mr.closed_seen, 0) = 0 ${borne}`).all(...(repoIds || [])).map((r) => r.id);
  const out = { mrs: 0, code: 0, tests: 0, neutral: 0 };
  if (!ids.length) return out;
  const motifsParRepo = new Map();
  for (const [, m] of cheminsFrais(ids)) {
    if (!motifsParRepo.has(m.repo_id)) {
      const base = motifsPour(cfg, m.repo_id);
      motifsParRepo.set(m.repo_id, {
        tests: lignes(test_patterns).length ? lignes(test_patterns) : base.tests,
        neutres: lignes(neutral_patterns).length ? lignes(neutral_patterns) : base.neutres,
      });
    }
    const c = classer(m.paths, motifsParRepo.get(m.repo_id));
    out.mrs += 1; out.code += c.code; out.tests += c.tests; out.neutral += c.neutral;
  }
  return out;
}

module.exports = {
  DEFAUT_TESTS, DEFAUT_NEUTRES, MAX_MOTIFS, SEUIL_DEFAUT, CHEMINS_PAR_MR,
  actif, seuil, normaliserMotifs, motifsPour, classer, alerte,
  pourCartes, sansTest, pourCible, apercu,
};
