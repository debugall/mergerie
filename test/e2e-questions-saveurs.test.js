'use strict';
/* « L'IA PEUT ME POSER DES QUESTIONS » — pour les trois saveurs de session.
 *
 * L'option n'existait qu'en codage sur dépôt. Une exploration hésite pourtant de la même
 * façon (« de quel des trois services parles-tu ? » vaut mieux qu'une synthèse à côté du
 * sujet), et le codage hors dépôt encore davantage : l'agent y travaille EN PLACE, sans
 * branche ni commit à relire — mieux vaut une question qu'un fichier réécrit sur une
 * hypothèse que personne n'a validée.
 *
 * Ce fichier suit la boucle ENTIÈRE pour les deux saveurs ajoutées : la case est enregistrée
 * et relue, l'agent s'arrête, la session attend, les questions sont exposées, on répond, et le
 * travail reprend. Une case cochée qui ne changerait rien serait pire que pas de case.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

describe('Questions de l’agent : exploration et hors dépôt', () => {
  let app; let repoId;

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'q-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
  });
  after(async () => { await app.stop(); });

  /* ---------------------------------------------------------------- exploration ---- */

  test('une exploration s’arrête sur ses questions, puis reprend et répond', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Comment fonctionne la facturation ?', ask_questions: true,
      targets: [{ repo_id: repoId, branch: 'main' }],
    });
    assert.equal(t.ask_questions, 1, 'l’option est acceptée en exploration, pas seulement en codage');

    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);

    let task = (await app.api('GET', `/api/tasks/${t.id}`)).body.task;
    assert.equal(task.status, 'needs_input', 'la session attend, elle n’est ni finie ni en erreur');
    const tg = task.targets[0];
    /* LÀ OÙ L'AGENT ÉCRIT. Le prompt d'exploration lui demande de tout mettre dans le fichier
       de réponse et de ne rien dupliquer sur la sortie standard : c'est donc dans ce FICHIER
       qu'il pose ses questions. Ne relire que la sortie standard laissait l'exploration se
       terminer « normalement », le bloc <<<QUESTIONS>>> brut en guise de réponse et aucun
       formulaire à l'écran — le défaut se voyait à l'écran, pas dans les tests. */
    assert.equal(tg.questions.length, 2, 'les questions sont exposées à l’écran');

    /* Le point qui compte : RIEN n'a été archivé. Une exploration qui s'arrête pour demander
       n'a pas de synthèse — enregistrer un fichier vide le ferait passer pour une réponse. */
    assert.equal((await app.api('GET', `/api/tasks/${t.id}/md`)).body.md, null,
      'aucune réponse n’est enregistrée tant que la question tient');

    // La todo posée par l'outil : la file est libre, plus rien ne repartira tout seul.
    const todos = (await app.api('GET', '/api/todos')).body.todos;
    assert.ok(todos.some((x) => x.auto_kind === 'session_question' && x.auto_ref === String(t.id)),
      'une todo rappelle qu’une session attend');

    // On répond → l'exploration repart dans la MÊME session et produit sa synthèse.
    const rep = await app.api('POST', `/api/tasks/${t.id}/targets/${tg.id}/answer`, {
      answers: { q1: 'decorator', q2: 'Oui, via une migration idempotente' },
    });
    assert.equal(rep.status, 200);
    await waitForJobs(app.api);

    task = (await app.api('GET', `/api/tasks/${t.id}`)).body.task;
    assert.equal(task.status, 'done', 'après réponses, l’exploration va au bout');
    const md = (await app.api('GET', `/api/tasks/${t.id}/md`)).body.md;
    assert.ok(md, 'et la synthèse existe');
    // Et la réponse est une RÉPONSE : jamais le protocole rendu tel quel, comme un texte à lire.
    assert.ok(!md.includes('<<<QUESTIONS'), 'le bloc de protocole ne doit pas se retrouver dans la réponse');
  });

  test('sans la case, une exploration ne pose rien et répond du premier coup', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Et le module de paiement ?',
      targets: [{ repo_id: repoId, branch: 'main' }],
    });
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    assert.equal((await app.api('GET', `/api/tasks/${t.id}`)).body.task.status, 'done');
  });

  /* ---------------------------------------------------------------- hors dépôt ---- */

  test('une session hors dépôt s’arrête sur ses questions, puis reprend', async () => {
    const dossier = fs.mkdtempSync(path.join(app.dataDir, 'hd-'));
    const { body: lt } = await app.api('POST', '/api/local-tasks', {
      prompt: 'Migre les imports vers ESM', dirs: [dossier], ask_questions: true,
    });
    assert.equal(lt.ask_questions, 1, 'la saveur hors dépôt a son PROPRE enregistrement : il doit prendre');

    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);

    const lire = async () => (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id);
    let courant = await lire();
    assert.equal(courant.status, 'needs_input', 'la session entière attend, pas seulement le dossier');
    assert.equal(courant.dirs[0].status, 'needs_input');
    assert.equal(courant.dirs[0].questions.length, 2, 'les questions sont exposées, prêtes à afficher');

    /* RIEN N'A ÉTÉ MODIFIÉ. L'agent s'est arrêté avant d'agir : le marqueur du dry-run ne doit
       pas être là — sinon « il a posé une question » et « il a codé quand même » cohabitent. */
    assert.equal(fs.existsSync(path.join(dossier, 'PROJ_LOCAL_DRYRUN.md')), false,
      'aucun fichier touché tant que la question tient');

    // La todo hors dépôt porte SON propre genre : deux tables, deux jeux d'identifiants.
    const todos = (await app.api('GET', '/api/todos')).body.todos;
    assert.ok(todos.some((x) => x.auto_kind === 'local_question' && x.auto_ref === String(lt.id)),
      'la todo d’une session hors dépôt ne se confond pas avec celle d’une session de dépôt');

    // Réponses vides → refus explicite, comme sur dépôt.
    assert.equal((await app.api('POST', `/api/local-tasks/${lt.id}/dirs/${courant.dirs[0].id}/answer`,
      { answers: {} })).status, 400);

    const rep = await app.api('POST', `/api/local-tasks/${lt.id}/dirs/${courant.dirs[0].id}/answer`, {
      answers: { q1: 'decorator', q2: 'Non' },
    });
    assert.equal(rep.status, 200);
    await waitForJobs(app.api);

    courant = await lire();
    assert.equal(courant.status, 'done', 'après réponses, le dossier est traité');
    assert.equal(courant.dirs[0].status, 'done');
    assert.equal(fs.existsSync(path.join(dossier, 'PROJ_LOCAL_DRYRUN.md')), true,
      'et cette fois le travail a bien eu lieu');

    const apres = (await app.api('GET', '/api/todos?status=done')).body.todos;
    assert.ok(apres.some((x) => x.auto_kind === 'local_question' && x.auto_ref === String(lt.id)),
      'répondre referme la todo');
  });

  /* UN SEUL DOSSIER REPART. Les autres n'ont rien demandé : les refaire travailler coûterait
     une passe d'agent par dossier, à chaque réponse. */
  test('répondre ne relance que le dossier qui attendait', async () => {
    const a = fs.mkdtempSync(path.join(app.dataDir, 'hd-a-'));
    const b = fs.mkdtempSync(path.join(app.dataDir, 'hd-b-'));
    const { body: lt } = await app.api('POST', '/api/local-tasks', {
      prompt: 'Range les imports', dirs: [a, b], ask_questions: true,
    });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);

    const lire = async () => (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id);
    const dirs = (await lire()).dirs;
    assert.deepEqual(dirs.map((d) => d.status), ['needs_input', 'needs_input']);

    await app.api('POST', `/api/local-tasks/${lt.id}/dirs/${dirs[0].id}/answer`, { answers: { q1: 'x', q2: 'y' } });
    await waitForJobs(app.api);

    const apres = (await lire()).dirs;
    assert.equal(apres[0].status, 'done', 'celui qui a reçu sa réponse a repris');
    assert.equal(apres[1].status, 'needs_input', '…et l’autre attend toujours la sienne');
    assert.equal((await lire()).status, 'needs_input', 'la session reste en attente tant qu’un dossier attend');
  });

  /* LA CASE EST DANS LE FORMULAIRE, et le formulaire a trois saveurs. Vérifier par l'API
     prouve l'API — jamais l'écran : le hors dépôt a son propre `submit` et sa propre relecture,
     et c'est exactement là que la case peut s'afficher, s'accepter, et n'être jamais envoyée. */
  test('la case est visible et enregistrée depuis l’écran, pour les trois saveurs', async (t) => {
    /* Le module `playwright` peut être là sans les navigateurs : on contrôle l'EXÉCUTABLE.
       Sans lui, ce test se passe (il n'a rien à prouver ici) au lieu d'échouer sur une stack. */
    if (!navigateurDispo().dispo) { t.skip(MSG_NAVIGATEUR); return; }
    const nav = await lancerNavigateur();
    const page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    try {
      await page.goto(app.base);
      const dossier = fs.mkdtempSync(path.join(app.dataDir, 'ui-'));
      await app.api('POST', '/api/local-roots', { path: path.dirname(dossier) });

      await page.locator('[data-tab="task"]').click();
      for (const kind of ['code', 'local', 'explore']) {
        await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
        await page.waitForSelector('#btnNewTask:not([hidden])');
        await page.locator('#btnNewTask').click();
        await page.waitForSelector('#taskModal:not([hidden])');
        assert.equal(await page.locator('#taskForm [name="ask_questions"]').isVisible(), true,
          `la case doit être proposée en « ${kind} » — elle ne vaut pas que pour le codage sur dépôt`);
        await page.locator('#taskCancel, #taskModal .modal-actions .btn').first().click();
        // La modale est refermée : la rouvrir avant qu'elle ne le soit ne rouvrirait rien.
        await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
      }

      /* Le vrai piège : le hors dépôt a son PROPRE envoi. On coche, on enregistre, et on
         regarde ce que la BASE a retenu — pas ce que l'écran affiche. */
      await page.locator('#tab-task .subnav [data-kind="local"]').click();
      await page.waitForSelector('#btnNewTask:not([hidden])');
      await page.locator('#btnNewTask').click();
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.locator('#taskForm [name="prompt"]').fill('Range les imports');
      await page.locator('#taskForm [name="ask_questions"]').check();
      await page.locator('#taskLocalDirRows .cb-search').first().fill(path.basename(dossier));
      await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
      await page.locator('.combo-options:not([hidden]) .combo-opt[data-v]').first().click();
      await page.locator('#taskSubmitOnly').click();
      await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });

      const cree = app.db.prepare('SELECT ask_questions FROM local_task ORDER BY id DESC LIMIT 1').get();
      assert.equal(cree.ask_questions, 1, 'la case cochée à l’écran doit arriver jusqu’à la base');
    } finally { await nav.close(); }
  });

  test('sans la case, une session hors dépôt code directement', async () => {
    const dossier = fs.mkdtempSync(path.join(app.dataDir, 'hd-sans-'));
    const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt: 'Nettoie', dirs: [dossier] });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);
    const courant = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id);
    assert.equal(courant.status, 'done');
    assert.equal(fs.existsSync(path.join(dossier, 'PROJ_LOCAL_DRYRUN.md')), true);
  });
});
