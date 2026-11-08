'use strict';
/* LES CROISEMENTS DE MERGE REQUESTS SONT UN FAIT CALCULÉ EN SQL — deux MR ouvertes du même dépôt
 * qui modifient le même fichier — sans aucun appel d'IA, sans jugement.
 *
 * Ce que ce fichier prouve, sur une base temporaire et sans serveur : un fichier commun fait un
 * croisement symétrique ; deux cibles différentes n'en font pas, sauf réglage ; une MR mergée
 * cesse de croiser tout de suite ; un SHA qui bouge invalide la liste jusqu'au relevé suivant ;
 * un renommage compte pour deux chemins ; une liste de plus de 5 000 fichiers est refusée et
 * dite ; le plafond par tour prend les plus actives d'abord et nomme le reste ; les paires du
 * brief sortent les plus anciennes d'abord ; et le module de calcul n'importe rien de l'agent. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lireSource } = require('./helpers/sources');

/* La base est OUVERTE DANS `before()`, après avoir posé le dossier de données : un `require` de
   `src/` en tête de fichier lirait `MERGERIE_DATA_DIR` avant qu'il ne soit posé. */
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'croisements-'));

describe('Croisements de merge requests', () => {
  let db; let c; let forge; let git;
  const cfg = { mr_files_enabled: '1', mr_files_max: '20', mr_files_cross_targets: '0', clone_path: path.join(process.env.MERGERIE_DATA_DIR, 'clones') };
  let repoId;
  const mrs = {};
  const now = new Date().toISOString();
  const mr = (iid, { target = 'main', created, sha } = {}) => {
    const r = db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, updated_at, gitlab_created_at, closed_seen)
      VALUES (?, ?, ?, ?, ?, ?, 'to_review', ?, ?, 0)`).run(repoId, iid, `MR ${iid}`, `feature/${iid}`, target, sha || `sha${iid}`, now, created || `2026-11-0${iid}T10:00:00.000Z`);
    mrs[iid] = Number(r.lastInsertRowid);
    return mrs[iid];
  };
  const croise = (iid) => [...(c.croisements(cfg).get(mrs[iid]) || new Map()).entries()].map(([other, paths]) => ({ other, paths }));

  before(() => {
    db = require('../src/db');
    c = require('../src/review/croisements');
    forge = require('../src/forge');
    git = require('../src/git/git');
    repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/app', 'https://gitlab.test/grp/app.git', 1, 'gitlab')").run().lastInsertRowid);
  });

  test('deux MR ouvertes, un fichier commun → un croisement, symétrique, shared = 1', () => {
    mr(1); mr(2); mr(3);
    c.poserFichiers(mrs[1], 'sha1', ['src/tva.js', 'src/a.js']);
    c.poserFichiers(mrs[2], 'sha2', ['src/tva.js', 'src/b.js']);
    c.poserFichiers(mrs[3], 'sha3', ['README.md']);
    assert.deepEqual(croise(1), [{ other: mrs[2], paths: ['src/tva.js'] }]);
    assert.deepEqual(croise(2), [{ other: mrs[1], paths: ['src/tva.js'] }]);
    assert.deepEqual(croise(3), [], 'rien en commun : aucun croisement');
    const cartes = c.pourCartes(cfg);
    assert.equal(cartes[mrs[1]].overlaps[0].shared, 1);
    assert.equal(cartes[mrs[1]].overlaps[0].iid, 2);
    assert.equal(cartes[mrs[1]].fetch.sha, 'sha1');
    assert.ok(cartes[mrs[3]], 'une MR relevée sans croisement porte quand même son relevé');
    assert.deepEqual(cartes[mrs[3]].overlaps, []);
  });

  test('interrupteur décoché : aucun croisement affiché', () => {
    assert.equal(c.croisements({ ...cfg, mr_files_enabled: '0' }).size, 0);
    assert.deepEqual(c.pourCartes({ ...cfg, mr_files_enabled: '0' }), {});
  });

  test('même fichier, branches cibles différentes → rien ; réglage coché → un croisement', () => {
    mr(4, { target: 'release/4.2' });
    c.poserFichiers(mrs[4], 'sha4', ['src/tva.js']);
    assert.deepEqual(croise(4), [], 'une MR vers release/4.2 ne se merge pas sur celles vers main');
    assert.equal(croise(1).length, 1, 'et !1 ne croise toujours que !2');
    const large = { ...cfg, mr_files_cross_targets: '1' };
    const de4 = c.croisements(large).get(mrs[4]);
    assert.deepEqual([...de4.keys()].sort(), [mrs[1], mrs[2]].sort());
    db.prepare('DELETE FROM mr WHERE id = ?').run(mrs[4]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mr_files WHERE mr_id = ?').get(mrs[4]).n, 0, 'la cascade emporte ses fichiers');
  });

  test('une des deux MR mergée → le croisement disparaît tout de suite, sans attendre la purge', () => {
    db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(mrs[2]);
    assert.deepEqual(croise(1), []);
    db.prepare('UPDATE mr SET closed_seen = 0 WHERE id = ?').run(mrs[2]);
    assert.equal(croise(1).length, 1);
  });

  test('SHA de tête changé → la liste est invalidée, le badge disparaît, puis revient au relevé suivant', () => {
    db.prepare("UPDATE mr SET current_sha = 'sha2-bis' WHERE id = ?").run(mrs[2]);
    assert.deepEqual(croise(1), [], 'la liste de !2 parle d’un autre commit : on ne conclut rien');
    assert.equal(c.pourCartes(cfg)[mrs[2]].fetch.fresh, false);
    c.poserFichiers(mrs[2], 'sha2-bis', ['src/tva.js']);
    assert.equal(croise(1).length, 1);
  });

  test('un renommage a.js → b.js : les deux chemins sont présents', () => {
    assert.deepEqual(c.cheminsNameStatus('M\tsrc/x.js\nR100\ta.js\tb.js\nA\tn.js\n'), ['src/x.js', 'a.js', 'b.js', 'n.js']);
    assert.deepEqual(c.cheminsDuDiff('diff --git a/a.js b/b.js\nsimilarity index 90%\n+++ b/b.js\ndiff --git a/k.js b/k.js\n'), ['a.js', 'b.js', 'k.js']);
  });

  test('le plafond par tour prend les plus récemment actives d’abord, nomme le reste, et refuse au-delà de 5 000 fichiers', async () => {
    db.prepare('DELETE FROM mr_files').run(); db.prepare('DELETE FROM mr_file_fetch').run();
    mr(5); mr(6);
    db.prepare("UPDATE mr SET updated_at = ? WHERE iid = 5").run('2026-11-07T12:00:00.000Z');
    db.prepare("UPDATE mr SET updated_at = ? WHERE iid = 6").run('2026-11-07T11:00:00.000Z');
    db.prepare("UPDATE mr SET updated_at = ? WHERE iid IN (1, 2, 3)").run('2026-11-01T10:00:00.000Z');
    const appels = [];
    const original = forge.gitlab.listMrChanges;
    forge.gitlab.listMrChanges = async (cfg2, project, iid) => {
      appels.push(iid);
      if (iid === 6) return { paths: Array.from({ length: 5001 }, (x, i) => `vendor/f${i}.js`), files: 5001, additions: 0, deletions: 0 };
      return { paths: [`src/${iid}.js`, 'src/tva.js'], files: 2, additions: 1, deletions: 1 };
    };
    const journal = [];
    try {
      const r1 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.deepEqual(appels, [5, 6], 'les deux plus actives d’abord');
      assert.equal(r1.releves, 1); assert.equal(r1.refuses, 1); assert.equal(r1.restants, 3);
      assert.ok(journal.some((l) => /plafond atteint \(2\) : 3 liste/.test(l)), journal.join('\n'));
      assert.ok(journal.some((l) => /!6 .*5001 fichiers, liste non relevée/.test(l)), journal.join('\n'));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM mr_files WHERE mr_id = ?').get(mrs[6]).n, 0, 'rien de stocké pour la liste refusée');
      assert.equal(c.releves([mrs[6]])[mrs[6]].refused, 'too-many-files');
      assert.equal(db.prepare('SELECT changed_paths FROM mr WHERE id = ?').get(mrs[5]).changed_paths, 'src/5.js\nsrc/tva.js', 'les chemins du badge « risque » viennent du même relevé');
      const r2 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r2.releves, 2); assert.equal(r2.restants, 1);
      const r3 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r3.releves, 1); assert.equal(r3.restants, 0);
      const r4 = await c.releverTour({ ...cfg, mr_files_max: '2' }, { onLog: (m) => journal.push(m) });
      assert.equal(r4.releves + r4.refuses, 0, 'tout est relevé : plus aucun appel, la liste refusée n’est pas retentée sur le même SHA');
      assert.equal(appels.length, 5);
      // !5 croise !1, !2 et !3 : tous touchent src/tva.js désormais.
      assert.equal(croise(5).length, 3);
    } finally { forge.gitlab.listMrChanges = original; }
  });

  test('les paires du brief : une ligne par paire, les plus anciennes d’abord, plafonnées', () => {
    const toutes = c.paires(cfg, 0);
    assert.ok(toutes.length >= 3);
    for (const p of toutes) assert.ok(p.a_id < p.b_id, 'une paire, pas deux lignes symétriques');
    const dates = toutes.map((p) => p.since);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(c.paires(cfg, 2).length, 2);
    assert.equal(toutes[0].shared, 1);
    assert.equal(toutes[0].project, 'grp/app');
  });

  test('la modale de session : les MR ouvertes du dépôt, celles de la branche, et un chemin cité dans le prompt', () => {
    const clone = git.cloneDirFor(cfg, { project: 'grp/app', forge: 'gitlab' });
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'src', 'tva.js'), '');
    const d = c.pourSession(cfg, { repoId, branch: 'feature/1', texte: 'Refactorer src/tva.js et le dossier src/ sans toucher README.md ni ../secret' });
    assert.equal(d.open, 5);
    assert.equal(d.mr.iid, 1);
    assert.ok(d.overlaps.length >= 1, 'la MR de la branche croise');
    assert.deepEqual(d.paths.map((p) => p.path), ['src/tva.js', 'src/'], 'un chemin existant dans le clone, un dossier, et rien pour ce qui n’existe pas');
    assert.ok(d.paths[0].mrs.length >= 3);
    assert.equal(c.pourSession(cfg, { repoId: 999 }), null);
  });

  test('la purge emporte les listes, et le module de calcul n’importe aucun module d’agent', () => {
    assert.ok(c.purger([mrs[1]]) >= 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mr_files WHERE mr_id = ?').get(mrs[1]).n, 0);
    const src = lireSource('review/croisements');
    assert.ok(!/require\(['"][^'"]*\/(agent|ai)[/'"]/.test(src), 'aucun require vers agent/ ou ai*');
    assert.ok(!/require\(['"]\.\.\/(review\/reviewer|session|jobs|app)/.test(src), 'rien non plus vers la review IA, les sessions ou la file');
  });
});
