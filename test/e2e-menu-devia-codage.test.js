'use strict';
/* MENU « DEV IA » — LES GESTES D'UNE CARTE DE CODAGE, dans un VRAI navigateur.
 *
 * L'agent est simulé (dry-run) mais les dépôts sont de vrais dépôts git : lancer une session
 * commite pour de bon, pousser pousse, et la merge request part sur la fausse forge. Chaque
 * clic est donc jugé à son EFFET côté serveur — statut des projets, passes d'agent, jobs mis en
 * file, appels reçus par la forge ou Jira —, jamais au seul texte de l'écran.
 *
 * Couvert : lancer, retour de l'IA, diff, lancer UN projet, corriger UN projet, suivi (ouvrir,
 * annuler, enregistrer, supprimer), tout pousser, ouvrir toutes les MR, pousser un projet, ouvrir
 * UNE MR (titre modifiable), prévenir Jira, reviewer la MR, converger, relancer ce qui a échoué,
 * réconcilier, ranger une session entièrement mergée, et « j'ai répondu au terminal ».
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const jenkins = require('./helpers/mock-jenkins');

const { dispo } = navigateurDispo();

describe('Menu Dev IA — les gestes d’une session de codage', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app;
  let nav;
  let page;
  let srvJenkins;
  const erreurs = [];
  let repoApp;
  let repoLib;
  const ids = {};

  const carte = (id) => `#taskList .card[data-task="${id}"]`;
  const aller = async () => {
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.waitForFunction(() => document.querySelector('#tab-task .subnav [data-kind="code"]').classList.contains('active'));
  };
  const recharger = () => page.evaluate(() => loadTasks());
  const tr = (cle, p) => page.evaluate(([k, x]) => tr(k, x), [cle, p || {}]);
  const session = async (id) => (await app.api('GET', `/api/tasks/${id}`)).body.task;
  const cible = async (id, repoId) => (await session(id)).targets.find((x) => x.repo_id === repoId);
  const jobs = (kind) => app.db.prepare(`SELECT COUNT(*) c FROM job${kind ? ' WHERE kind = ?' : ''}`).get(...(kind ? [kind] : [])).c;
  const passes = (unitId) => app.db.prepare("SELECT COUNT(*) c FROM agent_pass WHERE scope = 'task' AND unit_id = ?").get(unitId).c;
  const confirmer = async () => {
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
  };
  // La ligne d'un projet, repérée par son nom — la carte peut se redessiner entre deux gestes.
  const ligne = (id, projet) => page.locator(`${carte(id)} .target-line`, { hasText: projet });
  // Les projets d'une session à plusieurs dépôts sont repliés par défaut : on les déplie une fois.
  const deplier = async (id) => {
    await page.waitForSelector(`${carte(id)} [data-tfold]`);
    if ((await page.locator(`${carte(id)} [data-tfold]`).getAttribute('aria-expanded')) !== 'true') {
      await page.locator(`${carte(id)} [data-tfold]`).click();
      await page.waitForSelector(`${carte(id)} [data-tfold][aria-expanded="true"]`);
    }
  };

  before(async () => {
    app = await startApp();
    const r1 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    const r2 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'lib-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r1.mainSha } }];
    app.state.branches['grp/lib'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r2.mainSha } }];
    app.state.projects = [
      { id: 1, path_with_namespace: 'grp/app', http_url_to_repo: r1.url },
      { id: 2, path_with_namespace: 'grp/lib', http_url_to_repo: r2.url },
    ];
    app.state.jiraIssues['PROJ-7'] = {
      key: 'PROJ-7',
      fields: { summary: 'Cache du panier', status: { name: 'À faire', statusCategory: { key: 'new' } }, description: 'x', issuetype: { name: 'Tâche' } },
    };
    /* Un job Jenkins ROUGE sur la branche de la session : sa console doit pouvoir entrer dans un
       suivi, sans copier-coller. */
    srvJenkins = await jenkins.start();
    jenkins.reset();
    jenkins.state.jobs = [{
      name: 'ci-app', color: 'red', buildable: true,
      lastBuild: {
        number: 42, timestamp: Date.now(),
        actions: [{ causes: [{ userName: 'moi' }] }, { lastBuiltRevision: { branch: [{ name: 'refs/remotes/origin/feat/PROJ-7-cache' }] } }],
      },
    }];
    jenkins.state.details['/job/ci-app'] = { name: 'ci-app', color: 'red', builds: [] };
    jenkins.state.console['/job/ci-app/42'] = 'npm test\nError: Module not found: ./cache\nFinished: FAILURE';
    await app.configure({
      jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira',
      jenkins_url: srvJenkins.url, jenkins_user: jenkins.state.user, jenkins_token: jenkins.state.token,
    });
    repoApp = (await app.api('POST', '/api/repos', { url: r1.url, project: 'grp/app' })).body.id;
    repoLib = (await app.api('POST', '/api/repos', { url: r2.url, project: 'grp/lib' })).body.id;

    ids.multi = (await app.api('POST', '/api/tasks', {
      kind: 'code', label: 'Cache multi-dépôts', prompt: 'Ajouter un cache',
      targets: [
        { repo_id: repoApp, branch: 'feat/PROJ-7-cache', base_branch: 'main' },
        { repo_id: repoLib, branch: 'feat/PROJ-7-cache', base_branch: 'main' },
      ],
    })).body.id;
    ids.solo = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Travail sur un seul dépôt', commit_message: 'feat: travail solo',
      targets: [{ repo_id: repoApp, branch: 'feat/solo', base_branch: 'main' }],
    })).body.id;
    ids.question = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajouter un retry', ask_questions: true,
      targets: [{ repo_id: repoLib, branch: 'feat/retry', base_branch: 'main' }],
    })).body.id;

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await aller();
    await page.waitForSelector(carte(ids.multi));
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
    if (srvJenkins) await srvJenkins.close();
  });

  /* ------------------------------------------------------------ lancer, lire ---- */

  test('« Lancer » une session neuve la fait tourner sur ses deux dépôts', async () => {
    await page.locator(`${carte(ids.multi)} [data-trun]`).click();
    await attendreServeur(async () => (await session(ids.multi)).status !== 'new', 'la session est partie');
    await waitForJobs(app.api, { timeout: 120000 });
    const t = await session(ids.multi);
    assert.deepEqual(t.targets.map((x) => x.status), ['committed', 'committed']);
    await recharger();
    await deplier(ids.multi);
    await ligne(ids.multi, 'grp/app').locator('[data-tgdiff]').waitFor();
  });

  test('« Retour de l’IA » d’un projet ouvre la vue des passes, et se referme', async () => {
    await ligne(ids.multi, 'grp/app').locator('[data-tgout]').click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#taskMdBody').textContent.trim().length > 0);
    await page.locator('#taskMdClose').click();
    await page.waitForSelector('#taskMdView[hidden]', { state: 'attached' });
  });

  test('« Diff » d’un projet ouvre le diff plein écran de SA branche', async () => {
    await ligne(ids.multi, 'grp/lib').locator('[data-tgdiff]').click();
    await page.waitForSelector('#splitView:not([hidden])');
    assert.equal((await page.locator('#splitTitle').textContent()).trim(), 'grp/lib — feat/PROJ-7-cache');
    await page.waitForFunction(() => document.querySelectorAll('#splitView .tree-file, #splitView [data-path]').length > 0);
    await page.locator('#splitClose').click();
    await page.waitForSelector('#splitView[hidden]', { state: 'attached' });
  });

  /* ------------------------------------------------------------ un projet à la fois ---- */

  test('« Lancer » UN projet demande confirmation, et ne refait que lui', async () => {
    const tgLib = await cible(ids.multi, repoLib);
    const tgApp = await cible(ids.multi, repoApp);
    const [avantLib, avantApp] = [passes(tgLib.id), passes(tgApp.id)];
    await ligne(ids.multi, 'grp/lib').locator('[data-tgrun]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.equal((await page.locator('#confirmText').textContent()).trim(), await tr('confirm.rerun-target'));
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => passes(tgLib.id) > avantLib, 'le projet relancé a une passe de plus');
    await waitForJobs(app.api, { timeout: 120000 });
    assert.equal(passes(tgApp.id), avantApp, 'l’autre projet n’a pas été retouché');
  });

  test('« Corriger » UN projet envoie la remarque à lui seul', async () => {
    await recharger();
    await deplier(ids.multi);
    const tgApp = await cible(ids.multi, repoApp);
    const tgLib = await cible(ids.multi, repoLib);
    const [avantApp, avantLib] = [passes(tgApp.id), passes(tgLib.id)];
    await ligne(ids.multi, 'grp/app').locator('[data-tgfollow]').click();
    const form = page.locator(`#taskList .followup[data-followform="tg${tgApp.id}"]`);
    await form.waitFor({ state: 'visible' });
    await form.locator('.followup-text').fill('Renomme la variable du cache');
    await form.locator(`[data-followsubmit][data-followtarget="${tgApp.id}"]`).click();
    await attendreServeur(async () => passes(tgApp.id) > avantApp, 'le projet visé a reçu la correction');
    await waitForJobs(app.api, { timeout: 120000 });
    assert.equal(passes(tgLib.id), avantLib, 'l’autre projet n’a rien reçu');
    const derniere = app.db.prepare("SELECT kind, prompt FROM agent_pass WHERE scope = 'task' AND unit_id = ? ORDER BY n DESC LIMIT 1").get(tgApp.id);
    assert.equal(derniere.kind, 'followup');
    assert.match(derniere.prompt, /Renomme la variable du cache/);
  });

  /* B3 — LA CONSOLE JENKINS ENTRE DANS LE SUIVI DU PROJET. Le build de la branche est rouge :
     le bouton remplit la remarque avec les dernières lignes de la console, et le dit. */
  test('le build Jenkins rouge de la branche remplit le suivi du projet avec sa console', async () => {
    await page.reload();
    await aller();
    await deplier(ids.multi);
    await ligne(ids.multi, 'grp/app').locator('[data-ci-job]').waitFor();
    assert.match(await ligne(ids.multi, 'grp/app').locator('[data-ci-job]').textContent(), /CI #42/);
    const tgApp = await cible(ids.multi, repoApp);
    await ligne(ids.multi, 'grp/app').locator('[data-tgfollow]').click();
    const form = page.locator(`#taskList .followup[data-followform="tg${tgApp.id}"]`);
    await form.waitFor({ state: 'visible' });
    await form.locator('[data-followci]').click();
    await page.waitForFunction((cle) => /Module not found/.test(
      document.querySelector(`#taskList .followup[data-followform="${cle}"] .followup-text`).value,
    ), `tg${tgApp.id}`);
    const texte = await form.locator('.followup-text').inputValue();
    assert.match(texte, /ci-app/, 'le prompt dit d’où vient le texte');
    assert.match(texte, /42/);
    await form.locator(`[data-followcancel="tg${tgApp.id}"]`).click();
    await form.waitFor({ state: 'hidden' });
  });

  /* ------------------------------------------------------------ suivi de session ---- */

  test('le formulaire de suivi s’ouvre et « Annuler » le referme', async () => {
    await recharger();
    await page.locator(`${carte(ids.multi)} [data-tfollow]`).click();
    const form = page.locator(`#taskList .followup[data-followform="${ids.multi}"]`);
    await form.waitFor({ state: 'visible' });
    await form.locator(`[data-followcancel="${ids.multi}"]`).click();
    await form.waitFor({ state: 'hidden' });
  });

  test('un suivi enregistré se supprime depuis la carte', async () => {
    await page.locator(`${carte(ids.multi)} [data-tfollow]`).click();
    const form = page.locator(`#taskList .followup[data-followform="${ids.multi}"]`);
    await form.locator('.followup-text').fill('À envoyer plus tard');
    await form.locator(`[data-followsave="${ids.multi}"]`).click();
    await attendreServeur(async () => (await session(ids.multi)).followup_draft === 'À envoyer plus tard', 'le suivi est enregistré');
    await page.locator(`${carte(ids.multi)} [data-followdrop="${ids.multi}"]`).click();
    await attendreServeur(async () => (await session(ids.multi)).followup_draft == null, 'le suivi est supprimé');
    await page.waitForSelector(`${carte(ids.multi)} .followup-draft`, { state: 'detached' });
  });

  /* ------------------------------------------------------------ pousser, MR ---- */

  test('« Tout pousser » demande confirmation, puis pousse les deux branches', async () => {
    await recharger();
    await page.locator(`${carte(ids.multi)} [data-tpushall]`).click();
    await confirmer();
    await attendreServeur(async () => (await session(ids.multi)).targets.every((x) => x.status === 'pushed'),
      'les deux projets sont poussés', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
  });

  test('« Ouvrir les MR » crée une merge request par projet, sans demander de titre', async () => {
    await recharger();
    await page.locator(`${carte(ids.multi)} [data-tmrall]`).click();
    await page.waitForSelector('#mrModal:not([hidden])');
    assert.equal(await page.locator('#mrTitle').isVisible(), false, 'en lot, chaque MR prend le titre de la session');
    await page.locator('#mrGo').click();
    await page.waitForSelector('#mrModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => (await session(ids.multi)).targets.every((x) => x.mr_iid), 'les deux MR sont créées');
    assert.equal((app.state.mrs['grp/app'] || []).length, 1);
    assert.equal((app.state.mrs['grp/lib'] || []).length, 1);
  });

  test('« Prévenir Jira » nomme le ticket, puis commente chez Jira', async () => {
    await recharger();
    await deplier(ids.multi);
    await ligne(ids.multi, 'grp/app').locator('[data-tgjira]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').textContent(), /PROJ-7/, 'la confirmation dit QUEL ticket');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => app.state.calls.some((c) => c.method === 'POST' && /\/issue\/PROJ-7\/comment/.test(c.path)),
      'Jira a reçu le commentaire');
  });

  test('« Reviewer » la MR que la session vient d’ouvrir lance SA review', async () => {
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api, { timeout: 60000 });
    await recharger();
    await deplier(ids.multi);
    const bouton = ligne(ids.multi, 'grp/app').locator('[data-tgreview]');
    await bouton.waitFor();
    const mrId = Number(await bouton.getAttribute('data-tgreview'));
    const avant = jobs('review');
    await bouton.click();
    await attendreServeur(async () => jobs('review') > avant, 'une review est mise en file');
    const job = app.db.prepare("SELECT * FROM job WHERE kind = 'review' ORDER BY id DESC LIMIT 1").get();
    assert.ok(job, 'le job de review existe');
    assert.ok(mrId > 0);
    await waitForJobs(app.api, { timeout: 120000 });
  });

  test('« Converger » ouvre sa fenêtre et lance la convergence de la session', async () => {
    await recharger();
    await page.locator(`${carte(ids.multi)} [data-tconverge]`).click();
    await page.waitForSelector('#convergeModal:not([hidden])');
    assert.equal((await page.locator('#convergeModalTitle').textContent()).trim(), await tr('converge.modal.title-task'));
    assert.equal(await page.locator('#convSessionNote').isVisible(), true, 'depuis une session, l’IA code AUSSI avant de converger');
    await page.locator('#convThreshold').fill('7');
    await page.locator('#convStart').click();
    await attendreServeur(async () => !!app.db.prepare("SELECT 1 FROM job WHERE kind = 'converge-session' AND target_id = ?").get(ids.multi),
      'la convergence est en file pour cette session');
    const stop = await app.api('POST', '/api/jobs/stop');
    assert.ok([200, 409].includes(stop.status), `arrêt : ${stop.status}`);
    await waitForJobs(app.api, { timeout: 120000 });
  });

  /* ------------------------------------------------------------ après un échec ---- */

  const casser = () => {
    app.db.prepare("UPDATE task_target SET status = 'error', last_error = 'push refusé' WHERE task_id = ?").run(ids.multi);
    app.db.prepare("UPDATE task SET status = 'error', last_error = 'push refusé' WHERE id = ?").run(ids.multi);
  };

  test('« Relancer les échecs » relance les projets en erreur et solde leurs erreurs', async () => {
    casser();
    await recharger();
    const avant = jobs();
    await page.locator(`${carte(ids.multi)} [data-trunfailed]`).click();
    await attendreServeur(async () => jobs() > avant, 'la relance est en file');
    await attendreServeur(async () => (await session(ids.multi)).targets.every((x) => !x.last_error), 'les erreurs sont soldées');
    await waitForJobs(app.api, { timeout: 120000 });
  });

  test('« Réconcilier » relit les branches et rétablit les projets sans appeler l’IA', async () => {
    await waitForJobs(app.api, { timeout: 120000 });
    casser();
    await recharger();
    const [a, b] = (await session(ids.multi)).targets.map((x) => passes(x.id));
    await page.locator(`${carte(ids.multi)} [data-treconcile]`).click();
    await attendreServeur(async () => (await session(ids.multi)).targets.every((x) => ['committed', 'pushed'].includes(x.status)),
      'les projets sont rétablis', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    assert.deepEqual((await session(ids.multi)).targets.map((x) => passes(x.id)), [a, b], 'aucune passe d’agent de plus');
  });

  /* L'IA qui s'arrête pour demander « je continue sur les lots C/D/E ? » sans passer par le
     bloc de questions structuré n'a RIEN commité : `execOnTarget` le traite comme un échec
     (aucun fichier changé) et le projet finit en erreur — mais la session d'agent, elle,
     reste vivante. `resume_cmd` (dérivé du handle local) le dit : c'est lui qui doit décider
     si « Envoyer un suivi » apparaît, pas le seul statut. */
  test('un projet en erreur qui a une session d’agent vivante garde son suivi accessible', async () => {
    // eslint-disable-next-line import/order
    const localsession = require('../src/data/localsession');
    const id = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoApp, branch: 'feature/pause-ia' }],
    })).body.id;
    const tg = (await session(id)).targets[0];
    const { uid } = app.db.prepare('SELECT uid FROM task_target WHERE id = ?').get(tg.id);
    localsession.ecrire('task_target', uid, { session_key: 'sess-pause', session_backend: 'claude', session_cwd: '/tmp/pause' });
    app.db.prepare("UPDATE task_target SET status = 'error', last_error = ? WHERE id = ?").run(
      'L’IA n’a modifié aucun fichier — elle a répondu au lieu de coder :\n\n« Je m’arrête là, dis-moi si je continue sur les lots C/D/E. »',
      tg.id,
    );
    app.db.prepare("UPDATE task SET status = 'error' WHERE id = ?").run(id);
    await recharger();
    await page.locator(`${carte(id)} [data-tfollow]`).waitFor();
  });

  test('un projet en erreur SANS session à reprendre n’affiche pas le suivi', async () => {
    const id = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoApp, branch: 'feature/echec-sec' }],
    })).body.id;
    const tg = (await session(id)).targets[0];
    app.db.prepare("UPDATE task_target SET status = 'error', last_error = 'Dépôt introuvable.' WHERE id = ?").run(tg.id);
    app.db.prepare("UPDATE task SET status = 'error' WHERE id = ?").run(id);
    await recharger();
    await page.locator(carte(id)).waitFor();
    assert.equal(await page.locator(`${carte(id)} [data-tfollow]`).count(), 0);
  });

  test('une session entièrement mergée propose de se ranger', async () => {
    app.db.prepare('UPDATE task_target SET mr_merged = 1 WHERE task_id = ?').run(ids.multi);
    await recharger();
    const ranger = page.locator(`${carte(ids.multi)} .ta-work [data-hide]`);
    await ranger.waitFor();
    await ranger.click();
    await attendreServeur(async () => (await session(ids.multi)).hidden === 1, 'la session est rangée');
    await page.waitForSelector(carte(ids.multi), { state: 'detached' });
    await app.api('POST', `/api/tasks/${ids.multi}/hidden`, { hidden: false });
  });

  /* ------------------------------------------------------------ un seul projet ---- */

  test('session à un projet : pousser (sans forcer), puis ouvrir la MR avec son propre titre', async () => {
    await app.api('POST', `/api/tasks/${ids.solo}/run`);
    await waitForJobs(app.api, { timeout: 120000 });
    await recharger();
    const l = ligne(ids.solo, 'grp/app');
    await l.locator('[data-tgpush]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.equal(await page.locator('#confirmCheck').isChecked(), false, 'le forçage est une décision, jamais coché d’office');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await cible(ids.solo, repoApp)).status === 'pushed', 'la branche est poussée', 60000);
    await waitForJobs(app.api, { timeout: 60000 });

    await recharger();
    await ligne(ids.solo, 'grp/app').locator('[data-tgmr]').click();
    await page.waitForSelector('#mrModal:not([hidden])');
    assert.equal(await page.locator('#mrTitle').inputValue(), 'feat: travail solo', 'le message de commit propose le titre');
    await page.locator('#mrTitle').fill('Travail solo, relu');
    await page.locator('#mrGo').click();
    await attendreServeur(async () => !!(await cible(ids.solo, repoApp)).mr_iid, 'la MR est créée');
    const mr = (app.state.mrs['grp/app'] || []).find((x) => x.source_branch === 'feat/solo');
    assert.equal(mr.title, 'Travail solo, relu');
    await page.waitForSelector(`${carte(ids.solo)} .target-line a[href*="merge_requests"]`);
  });

  /* ------------------------------------------------------------ questions de l'agent ---- */

  test('« J’ai répondu au terminal » demande confirmation, puis relit la branche sans relancer l’agent', async () => {
    await app.api('POST', `/api/tasks/${ids.question}/run`);
    await waitForJobs(app.api, { timeout: 120000 });
    assert.equal((await session(ids.question)).targets[0].status, 'needs_input');
    const tgId = (await session(ids.question)).targets[0].id;
    const avant = passes(tgId);
    await recharger();
    await page.locator(`${carte(ids.question)} [data-qelsewhere]`).click();
    await confirmer();
    await attendreServeur(async () => (await session(ids.question)).targets[0].status !== 'needs_input', 'le projet n’attend plus');
    await waitForJobs(app.api, { timeout: 60000 });
    assert.equal(passes(tgId), avant, 'aucune passe d’agent : on a répondu ailleurs');
    assert.equal((await session(ids.question)).targets[0].questions, null);
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
