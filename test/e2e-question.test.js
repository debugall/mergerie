'use strict';
/* « QUESTION LIBRE » — la quatrième saveur de Dev IA.
 *
 * Ce qu'elle est : une question posée à l'IA sans dépôt ni dossier, et sa réponse gardée.
 * Ce qui la distingue des trois autres : elle n'a AUCUNE cible. C'est précisément ce qui
 * l'a fait exister (ni `task`, qui exige un `repo_id`, ni `local_task`, dont le statut
 * s'agrège depuis des dossiers), et c'est donc ce que ce fichier surveille en premier.
 *
 * Le formulaire est PARTAGÉ avec les trois autres saveurs. Une case, un sélecteur ou un envoi
 * qui ne serait pas adapté ici ne se verrait pas par l'API : les tests d'écran qui suivent ne
 * sont pas un supplément de confort, c'est le seul endroit où ce câblage-là est prouvé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

describe('Question libre', () => {
  let app;

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { await app.stop(); });

  /* ---------------------------------------------------------------- le moteur ---- */

  test('une question se pose, se lance, et sa réponse est gardée', async () => {
    const { body: q } = await app.api('POST', '/api/questions', {
      prompt: 'Quelle différence entre un mutex et un sémaphore ?', label: 'Concurrence',
    });
    assert.equal(q.status, 'new', 'créée sans être lancée : le geste reste à un clic');
    assert.equal(q.label, 'Concurrence');

    await app.api('POST', `/api/questions/${q.id}/run`);
    await waitForJobs(app.api);

    const apres = (await app.api('GET', '/api/questions')).body.find((x) => x.id === q.id);
    assert.equal(apres.status, 'done');
    assert.equal(apres.last_error, null);
    assert.ok(apres.finished_at, 'la date de fin sert au tri de la liste');

    const { body: md } = await app.api('GET', `/api/questions/${q.id}/md`);
    assert.ok(md.md && md.md.includes('Quelle différence entre un mutex'),
      'la réponse porte la question en tête : relire une réponse sans sa question n’apprend rien');
  });

  /* AUCUNE CIBLE, NULLE PART. C'est la raison d'être de cette saveur : si une question se
     mettait à exiger un dépôt, elle ne serait plus qu'une exploration mal nommée. */
  test('elle ne touche ni dépôt ni dossier', async () => {
    const { body: q } = await app.api('POST', '/api/questions', { prompt: 'Explique la CAP theorem.' });
    await app.api('POST', `/api/questions/${q.id}/run`);
    await waitForJobs(app.api);

    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM task').get().c, 0, 'aucune session de dépôt créée');
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM local_task').get().c, 0, 'aucune session hors dépôt créée');
    // Le job de la file ne réserve rien : deux questions peuvent tourner à côté de n'importe quoi.
    const jobs = require('../src/jobs');
    assert.equal(jobs.jobKeys({ kind: 'ask', taskId: q.id }).size, 0,
      'une question ne réserve aucun dépôt ni dossier — sinon elle bloquerait une review pour rien');
  });

  test('un prompt vide est refusé', async () => {
    assert.equal((await app.api('POST', '/api/questions', { prompt: '   ' })).status, 400);
  });

  /* UNE ÉTUDE SE MÈNE EN PLUSIEURS QUESTIONS. C'est la promesse de l'onglet : garder la trace.
     Chaque suivi écrase le fichier de réponse — sans archivage des passes, une étude en cinq
     questions ne garderait que la dernière réponse, c'est-à-dire perdrait ce qu'on lui demande. */
  test('les suivis s’enchaînent et chaque passe reste consultable', async () => {
    const { body: q } = await app.api('POST', '/api/questions', { prompt: 'Qu’est-ce qu’un quorum ?' });
    await app.api('POST', `/api/questions/${q.id}/run`);
    await waitForJobs(app.api);

    const rep = await app.api('POST', `/api/questions/${q.id}/followup`, { instruction: 'Et avec cinq nœuds ?' });
    assert.equal(rep.status, 200);
    await waitForJobs(app.api);

    const { body: p } = await app.api('GET', `/api/questions/${q.id}/passes`);
    assert.equal(p.passes.length, 2, 'la question initiale ET le suivi sont gardés');
    assert.deepEqual(p.passes.map((x) => x.kind), ['run', 'followup']);
    // On peut revenir sur la première : c'est tout l'intérêt d'en garder la trace.
    const { body: p1 } = await app.api('GET', `/api/questions/${q.id}/passes?n=1`);
    assert.match(p1.current.prompt, /quorum/i);
  });

  test('un suivi en attente s’enregistre, se relit et se supprime', async () => {
    const { body: q } = await app.api('POST', '/api/questions', { prompt: 'Question' });
    await app.api('PUT', `/api/questions/${q.id}/followup-draft`, { instruction: 'À creuser demain', auto: false });
    let courant = (await app.api('GET', `/api/questions/${q.id}`)).body.task;
    assert.equal(courant.followup_draft, 'À creuser demain');

    await app.api('PUT', `/api/questions/${q.id}/followup-draft`, { instruction: '' });
    courant = (await app.api('GET', `/api/questions/${q.id}`)).body.task;
    assert.equal(courant.followup_draft, null, 'effacer le texte EST la façon de supprimer le suivi');
  });

  /* Corriger une formulation ne doit pas faire perdre le fil : la session d'agent survit à
     l'édition, sinon la question suivante repartirait d'une page blanche. */
  test('éditer la question garde la session d’agent', async () => {
    const { body: q } = await app.api('POST', '/api/questions', { prompt: 'Version 1' });
    app.db.prepare("UPDATE question SET session_key='sess-1', session_backend='claude', session_cwd='/tmp/x' WHERE id=?").run(q.id);

    await app.api('PUT', `/api/questions/${q.id}`, { prompt: 'Version 2 corrigée', label: 'Étude' });
    const apres = (await app.api('GET', `/api/questions/${q.id}`)).body.task;
    assert.equal(apres.prompt, 'Version 2 corrigée');
    assert.equal(apres.label, 'Étude');
    assert.equal(apres.session_key, 'sess-1', 'la session d’agent survit à une correction de texte');
    assert.match(apres.resume_cmd, /--resume sess-1/, 'et la commande de reprise reste proposable');
  });

  test('ranger une question la retire de la vue sans la supprimer', async () => {
    const { body: q } = await app.api('POST', '/api/questions', { prompt: 'À ranger' });
    await app.api('POST', `/api/questions/${q.id}/hidden`, { hidden: true });
    const rangee = (await app.api('GET', '/api/questions')).body.find((x) => x.id === q.id);
    assert.equal(rangee.hidden, 1, 'rangée, mais toujours là');
  });

  test('supprimer une question efface aussi sa trace sur le disque', async () => {
    const { body: q } = await app.api('POST', '/api/questions', { prompt: 'Éphémère' });
    await app.api('POST', `/api/questions/${q.id}/run`);
    await waitForJobs(app.api);
    const { md_path: chemin } = app.db.prepare('SELECT md_path FROM question WHERE id = ?').get(q.id);
    assert.ok(chemin && fs.existsSync(chemin));

    await app.api('DELETE', `/api/questions/${q.id}`);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM question WHERE id = ?').get(q.id).c, 0);
    assert.equal(fs.existsSync(chemin), false, 'la réponse ne doit pas survivre à la question');
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM agent_pass WHERE scope='ask' AND task_id=?").get(q.id).c, 0,
      'ni ses passes : `question` n’a pas de clé étrangère vers `agent_pass`, le nettoyage est explicite');
  });

  /* ---------------------------------------------------------------- l'écran ---- */

  /* LE FORMULAIRE EST COMMUN AUX QUATRE SAVEURS. Vérifier par l'API prouve l'API : c'est ici,
     et seulement ici, qu'on voit si la modale s'adapte — et si son envoi part sur la bonne
     route. Une question créée par le formulaire du codage atterrirait dans `task`. */
  test('depuis l’écran : la modale s’adapte, et la question part sur sa propre route', async (t) => {
    if (!navigateurDispo().dispo) { t.skip(MSG_NAVIGATEUR); return; }
    const nav = await lancerNavigateur();
    const page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    try {
      await page.goto(app.base);
      await page.locator('[data-tab="task"]').click();
      await page.locator('#tab-task .subnav [data-kind="ask"]').click();
      await page.waitForSelector('#btnNewTask:not([hidden])');
      await page.locator('#btnNewTask').click();
      await page.waitForSelector('#taskModal:not([hidden])');
      /* Tout ce qui suppose du code doit avoir disparu : un sélecteur de dépôt sur cet écran
         ferait croire que la réponse portera dessus. */
      assert.equal(await page.locator('#taskReposWrap').isVisible(), false, 'pas de dépôts à choisir');
      assert.equal(await page.locator('#taskLocalWrap').isVisible(), false, 'pas de dossiers à choisir');
      assert.equal(await page.locator('#taskAskQuestionsRow').isVisible(), false,
        'la case « l’IA peut me poser des questions » n’a pas de cible sur laquelle hésiter');

      const avant = app.db.prepare('SELECT COUNT(*) c FROM question').get().c;
      await page.locator('#taskForm [name="prompt"]').fill('Posée depuis l’écran');
      await page.locator('#taskForm [name="label"]').fill('UI');
      await page.locator('#taskSubmit').click();
      await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });

      const cree = app.db.prepare('SELECT * FROM question ORDER BY id DESC LIMIT 1').get();
      assert.equal(app.db.prepare('SELECT COUNT(*) c FROM question').get().c, avant + 1);
      assert.equal(cree.prompt, 'Posée depuis l’écran');
      assert.equal(cree.label, 'UI', 'le libellé saisi doit arriver jusqu’à la base');

      await waitForJobs(app.api);
      await page.reload();
      await page.locator('[data-tab="task"]').click();
      await page.locator('#tab-task .subnav [data-kind="ask"]').click();
      await page.waitForSelector('#askList .card');
      const carte = page.locator(`#askList .card[data-ask="${cree.id}"]`);
      assert.ok(await carte.count(), 'la question apparaît dans SA liste');
      assert.ok((await carte.innerText()).includes('UI'), 'avec son libellé');
      assert.ok(await carte.locator('[data-qmd]').count(), 'et le bouton qui ouvre la réponse');
      assert.equal(erreurs.length, 0, `aucune erreur JS : ${erreurs.join(' | ')}`);
    } finally { await nav.close(); }
  });

  /* Le compteur du sous-onglet dit COMBIEN IL Y EN A — rangées comprises, comme les trois
     autres sous-onglets. C'est la pastille du MENU qui, elle, ne compte que ce qui attend
     d'être lancé ; les deux chiffres ne répondent pas à la même question. */
  test('depuis l’écran : le compteur du sous-onglet suit les questions', async (t) => {
    if (!navigateurDispo().dispo) { t.skip(MSG_NAVIGATEUR); return; }
    const nav = await lancerNavigateur();
    const page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    try {
      const total = app.db.prepare('SELECT COUNT(*) c FROM question').get().c;
      await page.goto(app.base);
      await page.locator('[data-tab="task"]').click();
      // Le compteur est rempli par le chargement des sessions : on l'attend, lui.
      await page.waitForFunction((n) => document.querySelector('#kindCountAsk').textContent.trim() === n, String(total));
      assert.equal((await page.locator('#kindCountAsk').textContent()).trim(), String(total));
      // …et la pastille du menu, elle, ne retient que les questions jamais lancées.
      const enAttente = app.db.prepare("SELECT COUNT(*) c FROM question WHERE status = 'new'").get().c;
      assert.ok(Number(await page.locator('#navCountTask').textContent()) >= enAttente,
        'une question jamais lancée doit peser dans la pastille « travail en attente »');
    } finally { await nav.close(); }
  });
});
