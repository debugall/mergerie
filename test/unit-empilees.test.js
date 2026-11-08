'use strict';
/* LES MERGE REQUESTS EMPILÉES SONT UN FAIT CALCULÉ EN SQL — l'ensemble des commits de A inclus dans
 * celui de B, même dépôt, même cible — sans aucun appel d'IA, sans jugement.
 *
 * Ce que ce fichier prouve, sur une base temporaire et sans serveur : A ⊂ B donne « contient » d'un
 * côté et « contenue dans » de l'autre, toujours ensemble ; des commits identiques font des jumelles,
 * pas une inclusion ; deux cibles différentes ne donnent rien, et une MR qui vise la branche d'une
 * autre est « basée sur » ; une chaîne se lit par maillon, la plus profonde d'abord ; une MR mergée
 * cesse d'être contenue tout de suite et laisse une ligne d'historique sept jours ; un SHA de tête ou
 * une cible qui bouge invalide la liste ; 501 commits sont refusés, une liste tronquée aussi ; le
 * plafond est celui des fichiers, partagé ; un clone qui porte les deux branches épargne la forge ; le
 * diff propre ; la ligne de la modale ; la phrase de fait ; et le module n'importe rien de l'agent. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { lireSource } = require('./helpers/sources');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'empilees-'));

describe('Merge requests empilées', () => {
  let db; let e; let c; let forge; let git;
  const cfg = { mr_files_enabled: '1', mr_commits_enabled: '1', mr_files_max: '20', clone_path: path.join(process.env.MERGERIE_DATA_DIR, 'clones') };
  let repoId;
  const mrs = {};
  const now = new Date().toISOString();
  const mr = (iid, { target = 'main', sha, source } = {}) => {
    const r = db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, updated_at, gitlab_created_at, closed_seen)
      VALUES (?, ?, ?, ?, ?, ?, 'to_review', ?, ?, 0)`).run(repoId, iid, `MR ${iid}`, source || `feature/${iid}`, target, sha || `sha${iid}`, now, `2026-11-${String(iid).padStart(2, '0')}T10:00:00.000Z`);
    mrs[iid] = Number(r.lastInsertRowid);
    return mrs[iid];
  };
  const commits = (iid, shas, extra = {}) => e.poserCommits(mrs[iid], { sha: `sha${iid}`, target: 'main', shas, source: 'forge', ...extra });
  const carte = (iid) => e.pourCartes(cfg, { mrIds: [mrs[iid]] })[mrs[iid]];
  const iids = (l) => (l || []).map((x) => x.iid);

  before(() => {
    db = require('../src/db');
    e = require('../src/review/empilees');
    c = require('../src/review/croisements');
    forge = require('../src/forge');
    git = require('../src/git/git');
    repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/app', 'https://gitlab.test/grp/app.git', 1, 'gitlab')").run().lastInsertRowid);
  });

  test('A = {c1,c2}, B = {c1,c2,c3} → B contient A, A contenue dans B, shared = 2, extra = 1 — toujours ensemble', () => {
    mr(1); mr(2); mr(3);
    commits(1, ['c1', 'c2']);
    commits(2, ['c1', 'c2', 'c3']);
    commits(3, ['d1']);
    const incl = e.inclusions();
    assert.deepEqual(incl, [{ inner: mrs[1], outer: mrs[2], shared: 2, extra: 1 }]);
    assert.deepEqual(iids(carte(2).contains), [1]);
    assert.equal(carte(2).contains[0].shared, 2);
    assert.equal(carte(2).contains[0].extra, 1);
    assert.deepEqual(iids(carte(1).containedIn), [2], 'symétrie : si B contient A, A dit contenue dans B');
    assert.deepEqual(carte(1).contains, []);
    assert.deepEqual(carte(2).twins, []);
    assert.equal(carte(3).fetch.count, 1, 'une MR relevée sans relation porte quand même son relevé');
    assert.deepEqual(iids(carte(3).contains), []);
    assert.deepEqual(e.pourCartes({ ...cfg, mr_commits_enabled: '0' }), {}, 'décoché : aucun badge');
    assert.deepEqual(e.pourCartes({ ...cfg, mr_files_enabled: '0' }), {}, 'sans relevé des fichiers : aucun badge non plus');
  });

  test('A = B = {c1,c2} → jumelles, pas d’inclusion', () => {
    mr(4); mr(5);
    commits(4, ['j1', 'j2']); commits(5, ['j1', 'j2']);
    assert.ok(!e.inclusions().some((r) => [mrs[4], mrs[5]].includes(r.inner)), 'aucune inclusion entre jumelles');
    assert.deepEqual(iids(carte(4).twins), [5]);
    assert.deepEqual(iids(carte(5).twins), [4]);
    assert.equal(carte(4).twins[0].shared, 2);
    mr(6); mr(7); commits(6, []); commits(7, []);
    assert.deepEqual(carte(6).twins, [], 'deux listes vides ne sont pas jumelles');
  });

  test('cibles différentes → rien ; B cible la branche de A → basée sur', () => {
    mr(8, { target: 'release/4.2' });
    commits(8, ['c1', 'c2', 'c3', 'c4'], { target: 'release/4.2' });
    assert.ok(!e.inclusions().some((r) => r.outer === mrs[8]), 'une MR vers release/4.2 ne contient pas une MR vers main');
    mr(9, { target: 'feature/1' });
    commits(9, ['x1'], { target: 'feature/1' });
    assert.equal(carte(9).basedOn.iid, 1);
    assert.equal(carte(9).basedOn.title, 'MR 1');
    assert.deepEqual(carte(9).contains, []);
  });

  test('chaîne C ⊃ B ⊃ A → C contient 2 MR, la plus profonde d’abord', () => {
    mr(10); commits(10, ['c1', 'c2', 'c3', 'c4', 'c5']);
    assert.deepEqual(iids(carte(10).contains), [1, 2], 'A (2 commits) avant B (3 commits)');
    assert.deepEqual(iids(carte(2).containedIn), [10]);
    assert.deepEqual(iids(carte(1).containedIn).sort((a, b) => a - b), [2, 10]);
    assert.deepEqual(iids(carte(2).contains), [1]);
  });

  test('A mergée → plus contenue au même instant ; une ligne d’historique sept jours, puis purgée', () => {
    db.prepare("UPDATE mr SET closed_seen = 1, merged_at = ? WHERE id = ?").run(now, mrs[1]);
    assert.deepEqual(carte(2).contains, [], 'le badge disparaît sans attendre');
    assert.equal(e.archiverFermees({ now }), 2, 'deux contenantes (B et C) gardent la trace');
    assert.deepEqual(iids(carte(2).history), [1]);
    assert.equal(carte(2).history[0].merged_at, now);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mr_commits WHERE mr_id = ?').get(mrs[1]).n, 0, 'la liste de la mergée est purgée');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mr_commit_fetch WHERE mr_id = ?').get(mrs[1]).n, 0);
    assert.equal(e.archiverFermees({ now }), 0, 'idempotent');
    const dans8j = new Date(Date.parse(now) + 8 * 24 * 3600 * 1000).toISOString();
    e.archiverFermees({ now: dans8j });
    assert.deepEqual(carte(2).history, [], 'sept jours plus tard, plus rien');
    // Pour la suite : !1 revient telle qu'elle était.
    db.prepare('UPDATE mr SET closed_seen = 0, merged_at = NULL WHERE id = ?').run(mrs[1]);
    commits(1, ['c1', 'c2']);
    assert.deepEqual(iids(carte(2).contains), [1]);
  });

  test('SHA de tête ou cible changés → liste invalidée, pas de badge jusqu’au relevé suivant', () => {
    db.prepare("UPDATE mr SET current_sha = 'sha2-bis' WHERE id = ?").run(mrs[2]);
    assert.deepEqual(carte(2).contains, []);
    assert.deepEqual(iids(carte(1).containedIn), [10], 'et !1 ne se dit plus contenue dans !2');
    assert.equal(carte(2).fetch.fresh, false);
    commits(2, ['c1', 'c2', 'c3'], { sha: 'sha2-bis' });
    assert.deepEqual(iids(carte(2).contains), [1]);
    db.prepare("UPDATE mr SET target_branch = 'release/4.2' WHERE id = ?").run(mrs[2]);
    assert.deepEqual(carte(2).contains, [], 'la cible a changé : la liste parle d’une autre base');
    db.prepare("UPDATE mr SET target_branch = 'main' WHERE id = ?").run(mrs[2]);
  });

  test('501 commits → too-many-commits, rien ; liste tronquée → truncated, rien', async () => {
    mr(11); mr(12);
    const original = forge.gitlab.listMrCommits;
    forge.gitlab.listMrCommits = async (cfg2, project, iid) => (iid === 11
      ? { shas: Array.from({ length: 501 }, (x, i) => `t${i}`), truncated: false }
      : { shas: Array.from({ length: 250 }, (x, i) => `u${i}`), truncated: true });
    try {
      const repo = { id: repoId, project: 'grp/app', forge: 'gitlab' };
      const r11 = await e.releverEtPoser(cfg, repo, db.prepare('SELECT * FROM mr WHERE id = ?').get(mrs[11]));
      assert.equal(r11.refused, 'too-many-commits');
      const r12 = await e.releverEtPoser(cfg, repo, db.prepare('SELECT * FROM mr WHERE id = ?').get(mrs[12]));
      assert.equal(r12.refused, 'truncated');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM mr_commits WHERE mr_id IN (?, ?)').get(mrs[11], mrs[12]).n, 0, 'rien de stocké');
      assert.equal(e.releves([mrs[11]])[mrs[11]].refused, 'too-many-commits');
      assert.equal(e.releves([mrs[12]])[mrs[12]].count, null);
      assert.ok(!e.inclusions().some((r) => r.outer === mrs[11] || r.inner === mrs[11]), 'jamais une inclusion sur une liste refusée');
    } finally { forge.gitlab.listMrCommits = original; }
  });

  test('plafond partagé : mr_files_max = 2 et cinq MR sans relevé → deux relevées pour fichiers ET commits, trois attendent', async () => {
    db.exec('DELETE FROM mr_files; DELETE FROM mr_file_fetch; DELETE FROM mr_commits; DELETE FROM mr_commit_fetch; DELETE FROM mr_contained_history');
    db.prepare('DELETE FROM mr WHERE iid NOT IN (1, 2, 3, 4, 5)').run();
    db.prepare("UPDATE mr SET updated_at = ? WHERE iid = 5").run('2026-11-07T12:00:00.000Z');
    db.prepare("UPDATE mr SET updated_at = ? WHERE iid = 4").run('2026-11-07T11:00:00.000Z');
    db.prepare("UPDATE mr SET updated_at = ? WHERE iid IN (1, 2, 3)").run('2026-11-01T10:00:00.000Z');
    const fichiers = []; const commitsAppeles = [];
    const o1 = forge.gitlab.listMrChanges; const o2 = forge.gitlab.listMrCommits;
    forge.gitlab.listMrChanges = async (cfg2, project, iid) => { fichiers.push(iid); return { paths: [`src/${iid}.js`], files: 1, additions: 1, deletions: 0 }; };
    forge.gitlab.listMrCommits = async (cfg2, project, iid) => { commitsAppeles.push(iid); return { shas: [`k${iid}`], truncated: false }; };
    const journal = [];
    try {
      const r1 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r1.releves, 2); assert.equal(r1.commits.releves, 2); assert.equal(r1.restants, 3);
      assert.deepEqual(fichiers, [5, 4]); assert.deepEqual(commitsAppeles, [5, 4], 'les mêmes deux, dans le même tour');
      const r2 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r2.releves, 2); assert.equal(r2.commits.releves, 2); assert.equal(r2.restants, 1);
      const r3 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r3.releves, 1); assert.equal(r3.commits.releves, 1); assert.equal(r3.restants, 0);
      const r4 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r4.releves + r4.commits.releves, 0, 'tout est relevé : plus aucun appel');
      assert.equal(fichiers.length, 5); assert.equal(commitsAppeles.length, 5);
      // Une liste de commits qui manque seule (relevé antérieur à cette version) prend une place du plafond, sans relire les fichiers.
      db.prepare('DELETE FROM mr_commit_fetch WHERE mr_id = ?').run(mrs[3]);
      const r5 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r5.releves, 0); assert.equal(r5.commits.releves, 1);
      assert.equal(fichiers.length, 5, 'les fichiers de !3 n’ont pas été relus');
      // Réglage décoché : aucun appel de commits de plus.
      db.prepare('DELETE FROM mr_commit_fetch').run();
      const r6 = await c.releverTour({ ...cfg, mr_files_max: '2', mr_commits_enabled: '0' }, { onLog: (m) => journal.push(m) });
      assert.equal(r6.commits.releves, 0); assert.equal(commitsAppeles.length, 6);
    } finally { forge.gitlab.listMrChanges = o1; forge.gitlab.listMrCommits = o2; }
  });

  test('clone présent avec les deux branches à leur tête → aucun appel forge pour les commits', async () => {
    const repo = { id: repoId, project: 'grp/app', forge: 'gitlab' };
    const cwd = git.cloneDirFor(cfg, repo);
    fs.mkdirSync(cwd, { recursive: true });
    const g = (...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
    g('init', '-q', '--initial-branch=main', '.');
    fs.writeFileSync(path.join(cwd, 'a.txt'), '1'); g('add', '-A'); g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'feature/clone');
    fs.writeFileSync(path.join(cwd, 'a.txt'), '2'); g('add', '-A'); g('commit', '-qm', 'un');
    const un = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(cwd, 'a.txt'), '3'); g('add', '-A'); g('commit', '-qm', 'deux');
    const deux = g('rev-parse', 'HEAD');
    g('update-ref', 'refs/remotes/origin/main', base);
    g('update-ref', 'refs/remotes/origin/feature/clone', deux);
    mr(20, { sha: deux, source: 'feature/clone' });
    const original = forge.gitlab.listMrCommits;
    forge.gitlab.listMrCommits = async () => { throw new Error('la forge ne doit pas être appelée'); };
    try {
      const r = await e.releverEtPoser(cfg, repo, db.prepare('SELECT * FROM mr WHERE id = ?').get(mrs[20]));
      assert.equal(r.source, 'clone'); assert.equal(r.count, 2);
      assert.deepEqual(db.prepare('SELECT sha FROM mr_commits WHERE mr_id = ? ORDER BY position').all(mrs[20]).map((x) => x.sha), [un, deux], 'du plus ancien au plus récent');
      // Tête différente dans le clone : on ne conclut rien du clone, la forge prend le relais.
      db.prepare("UPDATE mr SET current_sha = 'ailleurs' WHERE id = ?").run(mrs[20]);
      await assert.rejects(() => e.releverEtPoser(cfg, repo, db.prepare('SELECT * FROM mr WHERE id = ?').get(mrs[20])), /la forge/);
    } finally { forge.gitlab.listMrCommits = original; }
  });

  test('le diff propre : les fichiers de B qu’aucune contenue ne touche ; non calculé sans listes fraîches', () => {
    db.exec('DELETE FROM mr_commits; DELETE FROM mr_commit_fetch');
    commits(1, ['c1', 'c2']); commits(2, ['c1', 'c2', 'c3'], { sha: 'sha2-bis' });
    c.poserFichiers(mrs[1], 'sha1', ['src/a.js', 'src/b.js']);
    c.poserFichiers(mrs[2], 'sha2-bis', ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
    assert.deepEqual(e.diffPropre(cfg, mrs[2]), { computed: true, count: 2, paths: ['src/c.js', 'src/d.js'] });
    assert.equal(e.diffPropre(cfg, mrs[1]).computed, false, 'A ne contient rien : pas de diff propre');
    c.poserFichiers(mrs[1], 'vieux-sha', ['src/a.js']);
    assert.equal(e.diffPropre(cfg, mrs[2]).computed, false, 'la liste de A n’est pas à jour : diff propre non calculé');
    assert.equal(e.diffPropre({ ...cfg, mr_commits_enabled: '0' }, mrs[2]).computed, false);
  });

  test('la modale de session, la phrase de fait, la purge, et le module n’importe aucun module d’agent', () => {
    c.poserFichiers(mrs[1], 'sha1', ['src/a.js', 'src/b.js']);
    assert.equal(e.pourBranche(cfg, { repoId, branch: 'feature/1' }).iid, 1);
    assert.equal(e.pourBranche(cfg, { repoId, branch: 'feature/inconnue' }), null);
    assert.equal(e.pourBranche({ ...cfg, mr_commits_enabled: '0' }, { repoId, branch: 'feature/1' }), null);
    const faits = e.phrasesDeFait(cfg, mrs[2]);
    assert.equal(faits.length, 1);
    assert.match(faits[0], /!1 /);
    assert.match(faits[0], /2 commits/);
    assert.match(faits[0], /2 (fichiers|files)/);
    assert.deepEqual(e.phrasesDeFait(cfg, mrs[1]), [], 'une MR contenue ne reçoit rien : c’est la contenante qui relit deux fois');
    assert.ok(e.purger([mrs[2]]) >= 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mr_commits WHERE mr_id = ?').get(mrs[2]).n, 0);
    const src = lireSource('review/empilees');
    assert.ok(!/require\(['"][^'"]*\/(agent|ai)[/'"]/.test(src), 'aucun require vers agent/ ou ai*');
    assert.ok(!/require\(['"]\.\.\/(review\/reviewer|session|jobs|app)/.test(src), 'rien non plus vers la review IA, les sessions ou la file');
  });
});
