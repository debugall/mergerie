'use strict';
/* CE QUI GROSSIT SANS LIMITE FINIT PAR PESER : les merge requests fermées depuis longtemps
 * s'allègent — le rapport reste, le reste part —, les clones inactifs se compactent, un clone peut
 * se faire sans les blobs, et une jauge dit ce que tout ça pèse.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeRemoteRepo, git } = require('./helpers/app');

describe('Rétention · merge requests fermées, gc des clones, clone sans blobs, jauge', () => {
  let app; let repoId; let retention; let remote;
  const JOUR = 86400000;

  before(async () => {
    app = await startApp();
    remote = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'ret-')));
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: remote.url, project: 'grp/app' })).body.id;
    retention = require('../src/session/retention');
  });
  after(async () => { await app.stop(); });

  const ecrire = (p, txt) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); return p; };
  function mrFermee(iid, { jours, statut = 'done' }) {
    const quand = new Date(Date.now() - jours * JOUR).toISOString();
    const id = app.db.prepare("INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at, merged_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(repoId, iid, `MR ${iid}`, `f/${iid}`, 'main', statut, quand, statut === 'done' ? quand : null).lastInsertRowid;
    const dir = path.join(app.dataDir, 'reviews', 'grp-app', String(iid));
    const v1 = ecrire(path.join(dir, 'rapport-v1.md'), '# v1'); const v2 = ecrire(path.join(dir, 'rapport-v2.md'), '# v2');
    const diff = ecrire(path.join(dir, 'diff.patch'), 'diff');
    app.db.prepare('INSERT INTO review (mr_id, md_path, diff_path, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, v2, diff, quand, quand);
    app.db.prepare('INSERT INTO review_version (mr_id, version, md_path, created_at) VALUES (?,1,?,?)').run(id, v1, quand);
    app.db.prepare('INSERT INTO review_version (mr_id, version, md_path, created_at) VALUES (?,2,?,?)').run(id, v2, quand);
    const q = ecrire(path.join(app.dataDir, 'tasks', 'review', String(id), '0', 'output-v1.md'), 'réponse');
    app.db.prepare("INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at) VALUES ('review',?,0,1,'question','q',?,?)").run(id, q, quand);
    return { id, v1, v2, diff, q };
  }

  test('une MR fermée depuis plus de N jours garde son dernier rapport et perd le reste ; une récente ne bouge pas', async () => {
    const vieille = mrFermee(201, { jours: 200 });
    const recente = mrFermee(202, { jours: 10 });
    const ouverte = mrFermee(203, { jours: 400, statut: 'reviewed' });
    assert.equal(retention.purgerMrs(0), null, '0 = jamais');
    const r = retention.purgerMrs(180);
    assert.equal(r.mrs, 1, 'seule la vieille MR fermée est allégée');
    assert.equal(r.versions, 1);
    assert.ok(fs.existsSync(vieille.v2), 'le dernier rapport reste');
    assert.ok(!fs.existsSync(vieille.v1), 'la version précédente est partie');
    assert.ok(!fs.existsSync(vieille.diff), 'le diff stocké est parti');
    assert.ok(!fs.existsSync(vieille.q), 'les questions posées sur le rapport sont parties');
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM review_version WHERE mr_id = ?').get(vieille.id).c, 1);
    assert.equal(app.db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(vieille.id).diff_path, null);
    assert.ok(app.db.prepare('SELECT 1 FROM mr WHERE id = ?').get(vieille.id), 'la ligne de la MR reste : le brief la compte');
    for (const m of [recente, ouverte]) {
      assert.ok(fs.existsSync(m.v1) && fs.existsSync(m.diff) && fs.existsSync(m.q), 'rien ne bouge sur une MR récente ou ouverte');
    }
    assert.equal(retention.purgerMrs(180).mrs, 0, 'idempotent');
  });

  test('git gc des clones inactifs : seulement sans fetch depuis 30 jours, et pas deux fois de suite', async () => {
    const gitLib = require('../src/git/git');
    const { getConfig } = require('../src/data/config');
    const clone = await gitLib.ensureRepo(getConfig(), app.db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId), () => {});
    assert.equal(await retention.gcClones(), 0, 'un clone qui vient d’être fetché est actif');
    const vieux = Date.now() - 40 * JOUR;
    const fetchHead = path.join(clone, '.git', 'FETCH_HEAD');
    if (!fs.existsSync(fetchHead)) fs.writeFileSync(fetchHead, '');
    fs.utimesSync(fetchHead, vieux / 1000, vieux / 1000);
    assert.equal(await retention.gcClones(), 1, 'inactif : compacté');
    assert.ok(fs.existsSync(path.join(clone, '.git', 'mergerie-gc')), 'le marqueur est posé');
    assert.equal(await retention.gcClones(), 0, 'déjà compacté : on attend');
  });

  test('la jauge et « nettoyer maintenant »', async () => {
    const d = (await app.api('GET', '/api/stats/disk?force=1')).body;
    assert.ok(d.total > 0);
    assert.deepEqual(d.categories.map((c) => c.key), ['base', 'clones', 'reviews', 'sessions', 'worktrees', 'tickets', 'notes', 'shared', 'tmp']);
    const clones = d.categories.find((c) => c.key === 'clones');
    assert.ok(clones.octets > 0 && clones.fichiers > 0, 'le clone pèse quelque chose');
    const r = await app.api('POST', '/api/retention/run');
    assert.equal(r.status, 200);
    assert.ok(r.body.bilan && 'mrs' in r.body.bilan && 'gc' in r.body.bilan);
  });

  test('cloner sans les blobs : un réglage de ce poste, appliqué aux clones à venir', async () => {
    assert.equal(String((await app.api('GET', '/api/config')).body.clone_blobless), '0', 'décoché par défaut');
    assert.equal((await app.api('GET', '/api/config')).body.scopes.clone_blobless, 'poste');
    await app.api('PUT', '/api/config', { clone_blobless: 1, mr_retention_days: 10 });
    const c = (await app.api('GET', '/api/config')).body;
    assert.equal(String(c.clone_blobless), '1');
    assert.equal(c.mr_retention_days, 30, 'plancher : 30 jours');
    const r2 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'ret2-')));
    const id2 = (await app.api('POST', '/api/repos', { url: r2.url, project: 'grp/lib' })).body.id;
    const gitLib = require('../src/git/git');
    const { getConfig } = require('../src/data/config');
    const dir = await gitLib.ensureRepo(getConfig(), app.db.prepare('SELECT * FROM repo WHERE id = ?').get(id2), () => {});
    const filtre = git(dir, ['config', '--get', 'remote.origin.partialclonefilter']).trim();
    assert.equal(filtre, 'blob:none', 'le clone est partiel');
    await app.api('PUT', '/api/config', { clone_blobless: 0 });
  });
});
