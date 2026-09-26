'use strict';
/* LE PARALLÉLISME AUTOMATIQUE DE LA FILE. Ce qui n'entre en conflit avec rien démarre ; ce qui
 * partage une clé attend son tour, dans l'ordre ; un job lancé à la main passe devant un
 * automatique. Sur la règle nue : des entrées posées dans la file, aucun job lancé.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-file-parallele-'));
process.env.COPILOT_DRY_RUN = '1';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const file = require('../src/jobs/file');
const ordo = require('../src/jobs/ordonnanceur');

const gitops = (jobId, repoId, opts = {}) => ({ jobId, kind: 'gitops', payload: { targets: [{ repo_id: repoId }] }, opts });
const docker = (jobId, opts = {}) => ({ jobId, kind: 'docker', payload: {}, opts });

describe('File de jobs · parallélisme automatique', () => {
  after(() => { file.queue.splice(0); file.active.clear(); });

  test('rien ne tourne : la tête de file part', () => {
    file.queue.splice(0, file.queue.length, gitops(1, 1), gitops(2, 2));
    assert.equal(ordo.prochainLancable(), 0);
  });

  test('la tête est bloquée par un job en cours : un job indépendant la double, un job sur le même dépôt attend', () => {
    file.active.clear();
    file.active.set(99, { entry: gitops(99, 1), ctx: {}, lane: 'main' });
    file.queue.splice(0, file.queue.length, gitops(1, 1), gitops(2, 1), docker(3));
    assert.equal(ordo.prochainLancable(), 2, 'le job Docker ne touche aucun dépôt');
    file.queue.splice(0, file.queue.length, gitops(1, 1), gitops(2, 1));
    assert.equal(ordo.prochainLancable(), -1, 'les deux attendent le dépôt 1');
    file.queue.splice(0, file.queue.length, gitops(1, 1), gitops(2, 2), gitops(3, 2));
    assert.equal(ordo.prochainLancable(), 1, 'le dépôt 2 est libre : le premier qui le touche part');
    file.active.clear();
  });

  test('l’ordre est gardé entre deux jobs qui se touchent, même sans rien en cours', () => {
    file.queue.splice(0, file.queue.length, gitops(1, 1), gitops(2, 1));
    assert.equal(ordo.prochainLancable(), 0);
  });

  test('un job à la main passe devant un automatique, même sur le même dépôt', () => {
    file.queue.splice(0, file.queue.length, gitops(1, 1, { auto: true }), gitops(2, 1));
    assert.equal(ordo.prochainLancable(), 1, 'le job manuel devance la review automatique');
    file.queue.splice(0, file.queue.length, gitops(1, 1), gitops(2, 1, { auto: true }));
    assert.equal(ordo.prochainLancable(), 0, 'un automatique ne double jamais un manuel');
  });

  test('un périmètre inconnu bloque tout derrière lui et attend tout ce qui tourne', () => {
    file.queue.splice(0, file.queue.length, { jobId: 1, kind: 'gitops', payload: { restoreOpId: 5 }, opts: {} }, docker(2));
    assert.equal(ordo.prochainLancable(), 0, 'rien ne tourne : il part');
    file.active.set(99, { entry: docker(99), ctx: {}, lane: 'main' });
    assert.equal(ordo.prochainLancable(), -1, 'il attend le job en cours, et le Docker derrière lui attend aussi');
    file.active.clear();
  });

  test('attendreFin rend la main quand le job a quitté la file et les actifs', async () => {
    // Le minuteur d'`attendreFin` est `unref` (il ne retient pas le serveur à l'arrêt) : ici, on tient la boucle.
    const tenir = setInterval(() => {}, 10);
    after(() => clearInterval(tenir));
    file.queue.splice(0, file.queue.length, docker(7));
    const p = ordo.attendreFin(7, { timeoutMs: 2000, pasMs: 10 });
    setTimeout(() => file.queue.splice(0), 30);
    assert.equal(await p, true);
    assert.equal(await ordo.attendreFin(8, { timeoutMs: 50, pasMs: 10 }), true, 'un job inconnu est « fini »');
    file.active.set(9, { entry: docker(9), ctx: {}, lane: 'main' });
    assert.equal(await ordo.attendreFin(9, { timeoutMs: 60, pasMs: 10 }), false, 'délai dépassé : false, jamais une exception');
    file.active.clear();
  });

  test('jobEnCoursPour retrouve le job d’une session, actif ou en file', () => {
    file.queue.splice(0, file.queue.length, { jobId: 3, kind: 'task', taskId: 12, action: 'run', opts: {} });
    assert.deepEqual(ordo.jobEnCoursPour(12) && [ordo.jobEnCoursPour(12).jobId, ordo.jobEnCoursPour(12).enFile], [3, true]);
    file.active.set(4, { entry: { jobId: 4, kind: 'task', taskId: 13, action: 'run', opts: {} }, ctx: {}, lane: 'main' });
    assert.equal(ordo.jobEnCoursPour(13).enFile, false);
    assert.equal(ordo.jobEnCoursPour(14), null);
    file.queue.splice(0); file.active.clear();
  });
});
