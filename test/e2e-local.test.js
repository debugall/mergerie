'use strict';
/* « Codage hors dépôt » : l'IA réalise le prompt DANS des dossiers locaux arbitraires,
   en place, sans git. Aucun dépôt/branche/commit. En dry-run, le runner écrit un marqueur
   PROJ_LOCAL_DRYRUN.md dans chaque dossier — c'est ce qu'on vérifie (le dossier a bien été
   traité), plus les statuts par dossier et l'agrégat. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, waitForJobs } = require('./helpers/app');

describe('Codage hors dépôt (dossiers locaux)', () => {
  let app;
  const mkdir = () => fs.mkdtempSync(path.join(app.dataDir, 'ldir-'));

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { await app.stop(); });

  test('code dans chaque dossier, sans git, et marque « done »', async () => {
    const a = mkdir();
    const b = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'Migre les imports vers ESM', dirs: [a, b] })).body;
    assert.equal(created.dirs.length, 2);
    assert.equal(created.status, 'new');

    const job = await app.api('POST', `/api/local-tasks/${created.id}/run`);
    assert.equal(job.body.kind, 'local');
    await waitForJobs(app.api);

    const lt = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id);
    assert.equal(lt.status, 'done');
    assert.ok(lt.dirs.every((d) => d.status === 'done'), 'chaque dossier traité');
    // l'IA (dry-run) a bien opéré DANS chaque dossier
    assert.ok(fs.existsSync(path.join(a, 'PROJ_LOCAL_DRYRUN.md')));
    assert.ok(fs.existsSync(path.join(b, 'PROJ_LOCAL_DRYRUN.md')));
    // aucun dépôt git créé (pas de .git)
    assert.ok(!fs.existsSync(path.join(a, '.git')), 'aucun git : codage en place');
  });

  test('un dossier introuvable est en erreur, les autres réussissent', async () => {
    const good = mkdir();
    const bad = path.join(app.dataDir, 'nexiste-pas-xyz');
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'X', dirs: [good, bad] })).body;
    await app.api('POST', `/api/local-tasks/${created.id}/run`);
    await waitForJobs(app.api);

    const lt = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id);
    const byPath = Object.fromEntries(lt.dirs.map((d) => [d.path, d.status]));
    assert.equal(byPath[good], 'done');
    assert.equal(byPath[bad], 'error', 'dossier introuvable → erreur');
    assert.equal(lt.status, 'done', 'succès partiel : pas « error » global');
  });

  test('doublons dédupliqués, dossiers vides refusés', async () => {
    const d = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'Y', dirs: [d, d, '  '] })).body;
    assert.equal(created.dirs.length, 1, 'chemins dédupliqués, vides ignorés');

    const res = await app.api('POST', '/api/local-tasks', { prompt: 'Z', dirs: ['', '   '] });
    assert.equal(res.status, 400, 'aucun dossier valide → 400');

    const noPrompt = await app.api('POST', '/api/local-tasks', { prompt: ' ', dirs: [d] });
    assert.equal(noPrompt.status, 400, 'prompt requis');
  });

  test('captures jointes : stockées sur disque et rattachées à la session', async () => {
    const d = mkdir();
    // PNG 1×1 transparent (data URL) — enrichit le prompt.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'Corrige selon la capture', dirs: [d], images: [png] })).body;
    // le fichier image est écrit sous data/tasks/local/<id>/
    const imgFile = path.join(app.dataDir, 'tasks', 'local', String(created.id), 'img_1.png');
    assert.ok(fs.existsSync(imgFile), 'la capture est stockée sur disque');

    await app.api('POST', `/api/local-tasks/${created.id}/run`);
    await waitForJobs(app.api);
    const lt = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id);
    assert.equal(lt.status, 'done', 'la session tourne avec une image jointe');

    // la suppression efface aussi les fichiers image.
    await app.api('DELETE', `/api/local-tasks/${created.id}`);
    assert.ok(!fs.existsSync(imgFile), 'images supprimées avec la session');
  });

  test('« Retour de l’IA » : le retour de l’agent est consultable par dossier', async () => {
    const a = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'Ajoute un README', dirs: [a] })).body;
    await app.api('POST', `/api/local-tasks/${created.id}/run`);
    await waitForJobs(app.api);

    const lt = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id);
    const dir = lt.dirs[0];
    assert.ok(dir.output_path, 'le retour de l’agent est référencé sur le dossier');

    const out = await app.api('GET', `/api/local-tasks/${created.id}/dirs/${dir.id}/output`);
    assert.equal(out.status, 200);
    assert.equal(out.body.path, a, 'le dossier concerné est rappelé');
    assert.match(out.body.output, /dry-run/i, 'ce que l’agent dit avoir fait');

    // Un dossier d'une AUTRE session n'est pas lisible via cet id de session.
    const other = (await app.api('POST', '/api/local-tasks', { prompt: 'Z', dirs: [mkdir()] })).body;
    const cross = await app.api('GET', `/api/local-tasks/${other.id}/dirs/${dir.id}/output`);
    assert.equal(cross.status, 400, 'un dossier ne se lit que via SA session');
  });

  test('« Demander une correction » : nouvelle passe sur les mêmes dossiers', async () => {
    const a = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'Première passe', dirs: [a] })).body;
    await app.api('POST', `/api/local-tasks/${created.id}/run`);
    await waitForJobs(app.api);
    const marker = path.join(a, 'PROJ_LOCAL_DRYRUN.md');
    const firstPass = fs.readFileSync(marker, 'utf8');

    const vide = await app.api('POST', `/api/local-tasks/${created.id}/followup`, { instruction: '  ' });
    assert.equal(vide.status, 400, 'une demande vide est refusée');

    const job = await app.api('POST', `/api/local-tasks/${created.id}/followup`, { instruction: 'Corrige le titre' });
    assert.equal(job.body.kind, 'local', 'même file de jobs que la passe initiale');
    await waitForJobs(app.api);

    // L'IA est repassée sur le MÊME dossier (le marqueur dry-run s'est allongé).
    assert.ok(fs.readFileSync(marker, 'utf8').length > firstPass.length, 'seconde passe exécutée');
    const lt = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id);
    assert.equal(lt.status, 'done');
    assert.equal(lt.dirs[0].status, 'done');
    const out = await app.api('GET', `/api/local-tasks/${created.id}/dirs/${lt.dirs[0].id}/output`);
    assert.match(out.body.output, /[Ss]uivi/, 'le retour reflète la passe de suivi');

    // Les DEUX itérations sont conservées, chacune avec le prompt qui lui correspond.
    const hist = await app.api('GET', `/api/local-tasks/${created.id}/dirs/${lt.dirs[0].id}/passes`);
    assert.equal(hist.body.passes.length, 2);
    assert.deepEqual(hist.body.passes.map((p) => p.kind), ['run', 'followup']);
    assert.equal(hist.body.current.n, 2);
    assert.match(hist.body.current.prompt, /Corrige le titre/, 'le prompt de correction est conservé');
    const first = await app.api('GET', `/api/local-tasks/${created.id}/dirs/${lt.dirs[0].id}/passes?n=1`);
    assert.match(first.body.current.prompt, /Première passe/, 'la 1re passe garde le prompt initial');
    assert.ok(!/Corrige le titre/.test(first.body.current.prompt));
  });

  test('suppression d’une session', async () => {
    const d = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'W', dirs: [d] })).body;
    assert.ok((await app.api('GET', '/api/local-tasks')).body.some((x) => x.id === created.id));
    const del = await app.api('DELETE', `/api/local-tasks/${created.id}`);
    assert.equal(del.body.ok, true);
    assert.ok(!(await app.api('GET', '/api/local-tasks')).body.some((x) => x.id === created.id), 'session supprimée');
  });
});
