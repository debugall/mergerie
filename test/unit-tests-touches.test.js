'use strict';
/* LES TESTS TOUCHÉS SONT UN FAIT CALCULÉ PAR MOTIFS DE CHEMIN — un fichier est un test ou n'en est
 * pas un — sur les listes de fichiers des croisements, sans IA, sans couverture.
 *
 * Ce que ce fichier prouve, sur une base temporaire et sans serveur : la classification par défaut
 * (code / tests / neutres, tests d'abord) ; le badge accentué à partir du seuil, rien en dessous,
 * rien quand tout est neutre ; rien sans liste fraîche ni sur une liste refusée ; la résolution
 * dépôt → groupes (union) → global → défauts ; un glob invalide refusé avec sa ligne ; la ligne de
 * projet d'une session ; les MR sans test du brief ; l'aperçu ; et le module fermé à l'agent. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lireSource } = require('./helpers/sources');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-touches-'));

describe('Tests touchés par une merge request', () => {
  let db; let tt; let c;
  const cfg = { mr_files_enabled: '1', tests_touched_enabled: '1', tests_touched_min_code: '3', test_patterns: '', neutral_patterns: '' };
  let repoId;
  const mrs = {};
  const now = new Date().toISOString();
  const mr = (iid, paths, { sha, created } = {}) => {
    const r = db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, updated_at, gitlab_created_at, closed_seen)
      VALUES (?, ?, ?, ?, 'main', ?, 'to_review', ?, ?, 0)`).run(repoId, iid, `MR ${iid}`, `feature/${iid}`, sha || `sha${iid}`, now, created || `2026-11-0${iid}T10:00:00.000Z`);
    mrs[iid] = Number(r.lastInsertRowid);
    c.poserFichiers(mrs[iid], sha || `sha${iid}`, paths);
    return mrs[iid];
  };
  const carte = (iid, conf = cfg) => tt.pourCartes(conf, { mrIds: [mrs[iid]] })[mrs[iid]];
  const defauts = () => ({ tests: tt.DEFAUT_TESTS, neutres: tt.DEFAUT_NEUTRES });

  before(() => {
    db = require('../src/db');
    tt = require('../src/review/tests-touches');
    c = require('../src/review/croisements');
    repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/app', 'https://gitlab.test/grp/app.git', 1, 'gitlab')").run().lastInsertRowid);
  });

  test('src/a.js, src/a.test.js, README.md avec les défauts → code 1, tests 1, neutres 1 ; tests avant neutres', () => {
    const r = tt.classer(['src/a.js', 'src/a.test.js', 'README.md'], defauts());
    assert.deepEqual(r, { code: 1, tests: 1, neutral: 1, testPaths: ['src/a.test.js'] });
    assert.equal(tt.classer(['docs/example.test.js'], defauts()).tests, 1, 'un chemin qui matche tests ET neutres est un test');
    const r2 = tt.classer(['tests/unit/x.py', 'a_test.go', 'FooTest.php', 'cypress/e2e/y.cy.js', 'package-lock.json', 'config/app.json', 'src/app.json', 'img/logo.png'], defauts());
    assert.equal(r2.tests, 4); assert.equal(r2.neutral, 3); assert.equal(r2.code, 1, 'src/app.json est du code : seul config/**/*.json est neutre');
  });

  test('trois fichiers de code sans test → badge accentué ; deux → rien ; seuil à 0 → dès un fichier ; que des neutres → rien', () => {
    mr(1, ['src/a.js', 'src/b.js', 'src/c.js', 'README.md']);
    mr(2, ['src/a.js', 'src/b.js']);
    mr(3, ['README.md', 'docs/x.md']);
    mr(4, ['src/a.js', 'src/b.js', 'src/c.js', 'src/a.test.js', 'src/b.spec.ts']);
    assert.equal(carte(1).alert, true); assert.equal(carte(1).code, 3); assert.equal(carte(1).neutral, 1);
    assert.equal(carte(2).alert, false, 'sous le seuil, rien d’accentué');
    assert.equal(carte(2, { ...cfg, tests_touched_min_code: '0' }).alert, true, 'seuil à 0 : dès un fichier');
    assert.equal(carte(3).alert, false); assert.equal(carte(3).code, 0, 'que des neutres : rien à signaler');
    assert.equal(carte(4).alert, false); assert.equal(carte(4).tests, 2); assert.deepEqual(carte(4).test_paths, ['src/a.test.js', 'src/b.spec.ts']);
    assert.deepEqual(carte(4).patterns, { tests: { kind: 'default' }, neutres: { kind: 'default' } });
    assert.equal(carte(4).fetch.sha, 'sha4');
  });

  test('liste périmée ou refusée → aucune classification ; interrupteurs décochés → rien', () => {
    db.prepare("UPDATE mr SET current_sha = 'sha1-bis' WHERE id = ?").run(mrs[1]);
    assert.equal(carte(1), undefined, 'le relevé ne parle plus de la tête : jamais un faux « 0 test »');
    db.prepare("UPDATE mr SET current_sha = 'sha1' WHERE id = ?").run(mrs[1]);
    assert.ok(carte(1));
    c.poserFichiers(mrs[1], 'sha1', [], { refused: 'too-many-files' });
    assert.equal(carte(1), undefined, 'liste refusée : rien');
    c.poserFichiers(mrs[1], 'sha1', ['src/a.js', 'src/b.js', 'src/c.js', 'README.md']);
    assert.equal(carte(1, { ...cfg, tests_touched_enabled: '0' }), undefined);
    assert.equal(carte(1, { ...cfg, mr_files_enabled: '0' }), undefined, 'sans relevé des fichiers, pas de badge');
  });

  test('résolution des motifs : dépôt → groupes (union, nommés) → global → défauts', () => {
    assert.equal(tt.motifsPour(cfg, repoId).source.tests.kind, 'default');
    const avecGlobal = { ...cfg, test_patterns: 'src/c.js' };
    assert.deepEqual(tt.motifsPour(avecGlobal, repoId).tests, ['src/c.js']);
    assert.equal(tt.motifsPour(avecGlobal, repoId).source.tests.kind, 'config');
    assert.equal(carte(1, avecGlobal).tests, 1, 'le global s’applique');
    const g1 = Number(db.prepare("INSERT INTO repo_group (name, test_patterns, created_at) VALUES ('paiement', 'src/a.js', ?)").run(now).lastInsertRowid);
    const g2 = Number(db.prepare("INSERT INTO repo_group (name, test_patterns, created_at) VALUES ('legacy', 'src/b.js', ?)").run(now).lastInsertRowid);
    db.prepare('INSERT INTO repo_group_member (group_id, repo_id) VALUES (?, ?), (?, ?)').run(g1, repoId, g2, repoId);
    const m = tt.motifsPour(avecGlobal, repoId);
    assert.deepEqual(m.tests, ['src/a.js', 'src/b.js'], 'deux groupes aux motifs différents : l’union');
    assert.deepEqual(m.source.tests, { kind: 'group', groups: [{ id: g1, name: 'paiement' }, { id: g2, name: 'legacy' }] });
    assert.equal(m.source.neutres.kind, 'default', 'les neutres, eux, retombent sur les défauts');
    assert.equal(carte(1, avecGlobal).tests, 2);
    db.prepare("UPDATE repo SET test_patterns = '**/*.js' WHERE id = ?").run(repoId);
    const r = tt.motifsPour(avecGlobal, repoId);
    assert.deepEqual(r.tests, ['**/*.js']); assert.deepEqual(r.source.tests, { kind: 'repo', repo_id: repoId });
    assert.equal(carte(1, avecGlobal).tests, 3, 'le dépôt remplace groupes et global');
    db.prepare("UPDATE repo SET test_patterns = '' WHERE id = ?").run(repoId);
    db.prepare('DELETE FROM repo_group').run();
  });

  test('un glob invalide est refusé à l’enregistrement, avec sa ligne ; plus de 100 lignes aussi', () => {
    assert.equal(tt.normaliserMotifs('\n  **/*.spec.js \n\n**/e2e/**\n'), '**/*.spec.js\n**/e2e/**');
    assert.throws(() => tt.normaliserMotifs('**/*.spec.js\n**/*.{js,ts}'), /ligne 2|line 2/);
    assert.throws(() => tt.normaliserMotifs('a b'), /ligne 1|line 1/);
    assert.throws(() => tt.normaliserMotifs('!x'), /ligne 1|line 1/);
    assert.throws(() => tt.normaliserMotifs(Array.from({ length: 101 }, (x, i) => `p${i}.js`).join('\n')), /100/);
  });

  test('la ligne de projet d’une session : diff avec un test → 1, sans → 0, avant le commit → rien', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
    const avec = path.join(dir, 'avec.patch');
    fs.writeFileSync(avec, 'diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\ndiff --git a/test/x.test.js b/test/x.test.js\n+++ b/test/x.test.js\n');
    const sans = path.join(dir, 'sans.patch');
    fs.writeFileSync(sans, 'diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\ndiff --git a/README.md b/README.md\n');
    assert.deepEqual(tt.pourCible(cfg, { id: 1, repo_id: repoId, commit_sha: 'c1', diff_path: avec }), { code: 1, tests: 1, neutral: 0 });
    assert.deepEqual(tt.pourCible(cfg, { id: 2, repo_id: repoId, commit_sha: 'c2', diff_path: sans }), { code: 1, tests: 0, neutral: 1 });
    assert.equal(tt.pourCible(cfg, { id: 3, repo_id: repoId, commit_sha: null, diff_path: sans }), null, 'avant le commit, rien');
    assert.equal(tt.pourCible({ ...cfg, tests_touched_enabled: '0' }, { id: 1, repo_id: repoId, commit_sha: 'c1', diff_path: avec }), null);
  });

  test('un sous-module remonté n’est pas du code : neutre dans le diff d’une session comme dans la liste d’une MR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
    const sub = path.join(dir, 'sub.patch');
    // Le diff que git écrit pour un gitlink : mode 160000, corps « Subproject commit ».
    fs.writeFileSync(sub, 'diff --git a/libs/logger b/libs/logger\nindex a1b2c3d..f192ea3 160000\n--- a/libs/logger\n+++ b/libs/logger\n@@ -1 +1 @@\n-Subproject commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n+Subproject commit f192ea3de667d6aa79301448cbd78eb744a63d48\n');
    assert.deepEqual(c.sousModulesDuDiff(fs.readFileSync(sub, 'utf8')), ['libs/logger']);
    assert.deepEqual(tt.pourCible(cfg, { id: 9, repo_id: repoId, commit_sha: 'c9', diff_path: sub }), { code: 0, tests: 0, neutral: 1 }, 'rien à dire : pas de « 0 test modifié »');
    // Côté merge request : la liste relevée nomme les gitlinks ; quatre fichiers de code + le sous-module → 4, pas 5.
    mr(7, ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'libs/logger'], { sha: 'sha7' });
    c.poserFichiers(mrs[7], 'sha7', ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'libs/logger'], { gitlinks: ['libs/logger'] });
    assert.deepEqual([carte(7).code, carte(7).tests, carte(7).neutral, carte(7).alert], [4, 0, 1, true]);
    // `git diff --raw` dit les modes : le sous-module en 160000, un renommage sur deux chemins.
    assert.deepEqual(c.cheminsRaw(':100644 100644 abc def M\tsrc/x.js\n:160000 160000 abc def M\tlibs/logger\n:100644 100644 abc def R100\ta.js\tb.js\n'),
      { paths: ['src/x.js', 'libs/logger', 'a.js', 'b.js'], gitlinks: ['libs/logger'] });
    // Cette merge request n'appartient qu'à ce test : les suivants comptent les leurs.
    db.prepare('DELETE FROM mr WHERE id = ?').run(mrs[7]); delete mrs[7];
  });

  test('les MR sans test du brief : les plus anciennes d’abord, plafonnées, écartables sur un SHA', () => {
    mr(5, ['a.js', 'b.js', 'c.js'], { created: '2026-10-01T10:00:00.000Z' });
    const l = tt.sansTest(cfg, 0);
    assert.deepEqual(l.map((m) => m.iid), [5, 1], 'les plus anciennes d’abord ; !2 (sous le seuil), !3 (neutres) et !4 (avec tests) absentes');
    assert.equal(l[0].key, `${mrs[5]}:sha5`); assert.equal(l[0].code, 3);
    assert.equal(tt.sansTest(cfg, 1).length, 1);
  });

  test('l’aperçu classe les MR ouvertes du dépôt avec des motifs proposés, vides = hérités', () => {
    const a = tt.apercu(cfg, { repoId });
    assert.equal(a.mrs, 5); assert.equal(a.tests, 2); assert.equal(a.neutral, 3);
    const b = tt.apercu(cfg, { repoId, test_patterns: '**/*.js\n**/*.ts' });
    assert.equal(b.code, 0, 'tout .js et .ts devient un test — la liste proposée REMPLACE les défauts');
    assert.equal(tt.apercu(cfg, { repoId: 999 }).mrs, 0);
  });

  test('le module n’importe aucun module d’agent', () => {
    const src = lireSource('review/tests-touches');
    assert.ok(!/require\(['"][^'"]*\/(agent|ai)[/'"]/.test(src), 'aucun require vers agent/ ou ai*');
    assert.ok(!/require\(['"]\.\.\/(review\/reviewer|session|jobs|app)/.test(src));
  });
});
