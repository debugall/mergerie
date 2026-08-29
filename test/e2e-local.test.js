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

  /* RELANCE CIBLÉE. Les dossiers d'une session sont indépendants : refaire ceux qui ont réussi
     pour rattraper le seul qui a cassé coûte une passe d'agent par dossier, pour rien. */
  test('on relance un seul dossier — les autres ne retravaillent pas', async () => {
    const a = mkdir(); const b = mkdir();
    const marqueur = (d) => path.join(d, 'PROJ_LOCAL_DRYRUN.md');
    const taille = (d) => { try { return fs.statSync(marqueur(d)).size; } catch { return 0; } };

    const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt: 'Range les imports', dirs: [a, b] });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);
    const avant = { a: taille(a), b: taille(b) };
    assert.ok(avant.a > 0 && avant.b > 0, 'les deux dossiers ont été traités au premier tour');

    const dirs = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id).dirs;
    const r = await app.api('POST', `/api/local-tasks/${lt.id}/run`, { dirs: [dirs[0].id] });
    assert.equal(r.status, 200);
    await waitForJobs(app.api);

    assert.ok(taille(a) > avant.a, 'le dossier visé a bien retravaillé');
    assert.equal(taille(b), avant.b, 'l’autre n’a pas bougé — c’est tout l’intérêt');
  });

  test('un dossier inconnu est refusé plutôt qu’ignoré en silence', async () => {
    const d = mkdir();
    const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt: 'x', dirs: [d] });
    const r = await app.api('POST', `/api/local-tasks/${lt.id}/run`, { dirs: [999999] });
    assert.equal(r.status, 400, 'viser un dossier qui n’existe pas ne doit pas relancer TOUTE la session');
  });

  /* L'ERREUR S'EFFACE VRAIMENT. La croix de l'encart retirait la boîte de l'écran sans rien
     enregistrer : l'erreur revenait au rafraîchissement suivant, et le bouton avait l'air de
     marcher — ce qui est pire qu'un bouton absent. */
  test('effacer l’erreur d’une session hors dépôt l’efface en base', async () => {
    const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt: 'x', dirs: ['/n/existe/pas'] });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);
    const lire = async () => (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id);
    assert.ok((await lire()).last_error, 'la session est en erreur');

    assert.equal((await app.api('POST', `/api/local-tasks/${lt.id}/clear-error`)).status, 200);
    assert.equal((await lire()).last_error, null, 'et l’erreur ne revient pas au rechargement');
  });

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
    /* Le fichier est écrit sous data/tasks/local/<id>/ — on lit son chemin en base plutôt que
       de le deviner : le nommage est un détail d'implémentation, l'existence n'en est pas un. */
    const imgFile = app.db.prepare("SELECT path FROM piece_jointe WHERE scope = 'local' AND owner_id = ?").get(created.id).path;
    assert.ok(fs.existsSync(imgFile), 'la capture est stockée sur disque');
    assert.match(imgFile, new RegExp(`tasks/local/${created.id}/`), 'rangée avec la session');

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
    /* La LISTE porte les prompts, pas seulement la passe courante : la colonne de gauche montre
       chaque itération par la demande qui l'a produite, et sa recherche cherche là-dedans. */
    assert.match(hist.body.passes[0].prompt, /Première passe/);
    assert.match(hist.body.passes[1].prompt, /Corrige le titre/);
    assert.match(hist.body.current.prompt, /Corrige le titre/, 'le prompt de correction est conservé');
    const first = await app.api('GET', `/api/local-tasks/${created.id}/dirs/${lt.dirs[0].id}/passes?n=1`);
    assert.match(first.body.current.prompt, /Première passe/, 'la 1re passe garde le prompt initial');
    assert.ok(!/Corrige le titre/.test(first.body.current.prompt));
  });

  /* Éditer une session. Le point qui compte n'est pas le PUT lui-même, c'est ce qu'il NE
     détruit pas : corriger une faute dans le prompt ne doit pas faire repartir de zéro les
     dossiers déjà traités (statut, retour de l'agent, handle de session). */
  test('édition : le prompt change, les dossiers inchangés gardent leur état', async () => {
    const a = mkdir(); const b = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'version 1', dirs: [a, b] })).body;
    await app.api('POST', `/api/local-tasks/${created.id}/run`);
    await waitForJobs(app.api);
    const avant = (await app.api('GET', `/api/local-tasks/${created.id}`)).body.task;
    assert.equal(avant.dirs.length, 2);
    assert.ok(avant.dirs.every((d) => d.status === 'done' && d.output_path), 'les dossiers ont tourné');

    // Même composition → les lignes de dossier sont PRÉSERVÉES.
    const maj = await app.api('PUT', `/api/local-tasks/${created.id}`, { prompt: 'version 2', dirs: [a, b] });
    assert.equal(maj.status, 200);
    assert.equal(maj.body.prompt, 'version 2');
    assert.deepEqual(maj.body.dirs.map((d) => [d.id, d.status, !!d.output_path]),
      avant.dirs.map((d) => [d.id, d.status, !!d.output_path]), 'rien n’a été recréé');

    // Composition modifiée → on repart à neuf sur les dossiers (c'est une autre session de travail).
    const c = mkdir();
    const change = await app.api('PUT', `/api/local-tasks/${created.id}`, { dirs: [a, c] });
    assert.deepEqual(change.body.dirs.map((d) => d.path), [a, c]);
    assert.ok(change.body.dirs.every((d) => d.status === 'new' && !d.output_path));
    assert.equal(change.body.prompt, 'version 2', 'un PUT sans prompt ne l’efface pas');

    assert.equal((await app.api('PUT', `/api/local-tasks/${created.id}`, { prompt: '  ' })).status, 400);
    assert.equal((await app.api('PUT', '/api/local-tasks/999999', { prompt: 'x' })).status, 400);
  });

  /* La session à reprendre se choisit AUSSI en édition — c'est le seul moyen de la changer
     après coup. Les trois cas qui comptent : inchangée, remplacée, et surtout VIDÉE, qui
     ne doit rien effacer (un formulaire simplement soumis ne fait pas perdre un handle). */
  test('édition : la session fournie se change, un champ vide n’efface rien', async () => {
    const { backendName } = require('../src/agentsession');
    const id1 = backendName() === 'claude' ? '6ba7b810-9dad-11d1-80b4-00c04fd430c8' : '/home/moi/.copilot-sessions/a';
    const id2 = backendName() === 'claude' ? '11111111-2222-3333-4444-555555555555' : '/home/moi/.copilot-sessions/b';
    const d = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'p', dirs: [d], session_id: id1 })).body;
    const keys = async () => (await app.api('GET', `/api/local-tasks/${created.id}`)).body.task.dirs.map((x) => x.session_key);

    await app.api('PUT', `/api/local-tasks/${created.id}`, { prompt: 'p2', dirs: [d], session_id: id1 });
    assert.deepEqual(await keys(), [id1], 'renvoyer la même valeur ne change rien');

    await app.api('PUT', `/api/local-tasks/${created.id}`, { dirs: [d], session_id: id2 });
    assert.deepEqual(await keys(), [id2], 'une autre valeur remplace la session');

    await app.api('PUT', `/api/local-tasks/${created.id}`, { prompt: 'p3', dirs: [d], session_id: '' });
    assert.deepEqual(await keys(), [id2], 'un champ vide ne perd pas la session');
  });

  /* Créer sans lancer : la session existe en statut « new » et attend son déclenchement.
     Le POST de création ne lançait rien, mais l'écran enchaînait toujours sur /run — c'est
     donc le statut au repos qui doit rester vérifiable. */
  test('créée sans être lancée : statut « new », rien n’a tourné', async () => {
    const d = mkdir();
    fs.writeFileSync(path.join(d, 'a.txt'), 'inchangé', 'utf8');
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'plus tard', dirs: [d] })).body;
    assert.equal(created.status, 'new');
    assert.equal(created.dirs[0].status, 'new');
    assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'inchangé', 'aucun traitement n’a eu lieu');

    // …et le lancement différé fonctionne comme un lancement immédiat.
    await app.api('POST', `/api/local-tasks/${created.id}/run`);
    await waitForJobs(app.api);
    const apres = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id);
    assert.equal(apres.status, 'done');
  });

  /* Même ordre que les sessions de codage : ce qui vient de finir de tourner en tête. Sans
     ça, une session hors dépôt exécutée il y a une minute se retrouve sous une session plus
     récemment CRÉÉE mais jamais lancée. */
  test('les sessions hors dépôt les plus récemment exécutées passent devant', async () => {
    const creer = async (nom) => (await app.api('POST', '/api/local-tasks', { prompt: nom, dirs: [mkdir()] })).body.id;
    const a = await creer('ordre-a');
    const b = await creer('ordre-b');

    await app.api('POST', `/api/local-tasks/${b}/run`);
    await waitForJobs(app.api);
    await app.api('POST', `/api/local-tasks/${a}/run`);
    await waitForJobs(app.api);

    const rang = async () => (await app.api('GET', '/api/local-tasks')).body.map((x) => x.id);
    let ordre = await rang();
    assert.ok(ordre.indexOf(a) < ordre.indexOf(b), `dernier exécuté en tête (vu ${ordre.join(',')})`);

    // Corriger le prompt ne remonte pas la session : seule une exécution compte.
    await app.api('PUT', `/api/local-tasks/${b}`, { prompt: 'ordre-b corrigé' });
    ordre = await rang();
    assert.ok(ordre.indexOf(a) < ordre.indexOf(b), 'une simple modification ne change pas l’ordre');
  });

  // Pendant hors dépôt de la reprise de session : l'identifiant se range sur chaque dossier.
  test('session existante fournie : rangée sur chaque dossier', async () => {
    const { backendName } = require('../src/agentsession');
    const id = backendName() === 'claude'
      ? '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
      : '/home/moi/.mergerie/agent-sessions/deja-la';
    const a = mkdir(); const b = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'continue', dirs: [a, b], session_id: id })).body;
    const rows = app.db.prepare('SELECT session_key, session_backend, session_cwd FROM local_task_dir WHERE task_id = ?').all(created.id);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.session_key, id);
      assert.equal(r.session_backend, backendName());
      assert.equal(r.session_cwd, null);
    }
    assert.equal((await app.api('POST', '/api/local-tasks', { prompt: 'p', dirs: [mkdir()], session_id: '-x' })).status, 400);
  });

  // Pendant hors dépôt du rangement des sessions sur dépôt : même geste, autre table.
  test('ranger une session hors dépôt : le drapeau fait l’aller-retour, les dossiers restent', async () => {
    const d = mkdir();
    const created = (await app.api('POST', '/api/local-tasks', { prompt: 'Range-moi', dirs: [d] })).body;
    assert.equal(created.hidden, 0);

    assert.equal((await app.api('POST', `/api/local-tasks/${created.id}/hidden`, { hidden: true })).body.hidden, 1);
    const range = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id);
    assert.equal(range.hidden, 1);
    assert.deepEqual(range.dirs.map((x) => x.path), created.dirs.map((x) => x.path), 'les dossiers sont intacts');

    assert.equal((await app.api('POST', `/api/local-tasks/${created.id}/hidden`, { hidden: false })).body.hidden, 0);
    assert.equal((await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === created.id).hidden, 0);

    assert.equal((await app.api('POST', '/api/local-tasks/999999/hidden', { hidden: true })).status, 400);
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
