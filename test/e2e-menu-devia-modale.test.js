'use strict';
/* MENU « DEV IA » — LA MODALE DE SESSION, dans ses quatre saveurs, dans un VRAI navigateur.
 *
 * Le formulaire est UNIQUE et ses envois sont QUATRE : sessions sur dépôt (codage, exploration),
 * hors dépôt, question libre. Chaque champ est donc éprouvé par le formulaire, puis relu par
 * l'API : un champ qui s'affiche, se coche, et n'arrive jamais en base ne se voit qu'ainsi.
 *
 * Couvert ici : ce que chaque saveur montre et cache, la création « sans lancer » et « créer et
 * lancer » (bouton et Ctrl+Entrée), « puis converger », les projets (ajout, retrait, dépôt,
 * branche de travail proposée, branche de départ), la branche déjà prise, la branche exigée, le
 * vérificateur et son lien avec l'auto-push, le ticket Jira, la session d'agent à reprendre,
 * skills et sous-agents, les pièces jointes, le hors dépôt (répertoire, projets), l'édition et
 * sa relecture, et les fermetures qui ne créent rien.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// AVANT `startApp` : le scan des skills lit cette variable au chargement de `paths.js`.
const fauxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-devia-home-'));
process.env.MERGERIE_CLAUDE_HOME = fauxHome;

// eslint-disable-next-line import/order
const { test, before, after, describe } = require('node:test');
// eslint-disable-next-line import/order
const assert = require('node:assert/strict');
// eslint-disable-next-line import/order
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const ecrire = (p, texte) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, texte, 'utf8'); };
// Une vraie image PNG 1×1 : la vignette doit pouvoir s'afficher.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('Menu Dev IA — la modale de session', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app;
  let nav;
  let page;
  const erreurs = [];
  let repoApp;
  let repoLib;
  let racine;
  let verif;
  let creee;          // la session de codage créée par le formulaire, éditée plus loin

  const aller = async (kind) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`)
      .classList.contains('active'), kind);
  };
  const ouvrir = async (kind) => {
    await aller(kind);
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    if (kind === 'code' || kind === 'explore') await page.waitForSelector('#targetRows .target-row .t-repo-search');
    if (kind === 'local') await page.waitForSelector('#taskLocalDirRows .cb-search');
  };
  const fermer = async () => {
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  };
  const tr = (cle, p) => page.evaluate(([k, x]) => tr(k, x), [cle, p || {}]);
  const jobs = () => app.db.prepare('SELECT COUNT(*) c FROM job').get().c;
  const derniere = (table) => app.db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`).get();
  const compte = (table) => app.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  /* CHOISIR DANS UN COMBO, ET S'ASSURER QUE LE CHOIX A PRIS. Le menu se referme 150 ms après la
     perte du focus : sur une machine chargée, le clic sur l'option peut arriver après — l'option
     n'est alors plus visible et le clic attend trente secondes un menu qui ne reviendra pas. On
     juge donc à l'EFFET (la valeur du champ) et on rouvre le menu tant qu'il n'est pas là. */
  const choisirDansCombo = async (ouvrirMenu, option, pris, essais = 5) => {
    for (let i = 1; i <= essais; i += 1) {
      await ouvrirMenu();
      try {
        await option().first().click({ timeout: 3000 });
        await page.waitForFunction(pris.fn, pris.arg, { timeout: 3000 });
        return;
      } catch (e) {
        if (i === essais) throw e;
        await page.locator('#taskModalTitle').click();   // referme le menu avant de réessayer
      }
    }
  };
  // Choisir un dépôt dans le combo de la i-ème ligne de projet.
  const choisirDepot = (i, projet) => choisirDansCombo(
    () => page.locator('#targetRows .target-row').nth(i).locator('.t-repo-search').click(),
    () => page.locator('#targetRows .combo-options:not([hidden]) .combo-opt[data-r]', { hasText: projet }),
    { fn: ([j, p]) => document.querySelectorAll('#targetRows .target-row')[j].querySelector('.t-repo-search').value === p, arg: [i, projet] },
  );
  const lignes = () => page.locator('#targetRows .target-row');
  // L'accordéon « Avancé » démarre replié : ce qu'il contient se remplit après l'avoir déplié.
  const deplierAvance = async () => {
    if (!await page.locator('#taskAdvanced').evaluate((e) => e.open)) await page.locator('#taskAdvanced > summary').click();
    await page.waitForSelector('#taskAdvanced [name="session_id"]', { state: 'visible' });
  };

  before(async () => {
    app = await startApp();
    const r1 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    const r2 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'lib-')));
    const branches = (sha) => [
      { name: 'main', default: true, protected: false, merged: false, commit: { id: sha } },
      { name: 'develop', default: false, protected: false, merged: false, commit: { id: sha } },
    ];
    app.state.branches['grp/app'] = branches(r1.mainSha);
    app.state.branches['grp/lib'] = branches(r2.mainSha);
    app.state.jiraIssues['PROJ-7'] = {
      key: 'PROJ-7',
      fields: { summary: 'Mettre les paniers en cache', status: { name: 'À faire', statusCategory: { key: 'new' } }, description: 'Le panier se recharge à chaque page.', issuetype: { name: 'Tâche' } },
    };
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira' });
    repoApp = (await app.api('POST', '/api/repos', { url: r1.url, project: 'grp/app' })).body.id;
    repoLib = (await app.api('POST', '/api/repos', { url: r2.url, project: 'grp/lib' })).body.id;

    // Un vérificateur qui ne couvre QUE grp/app : il se propose seul, jamais pour les deux.
    const script = path.join(app.dataDir, 'vert.sh');
    ecrire(script, '#!/bin/sh\nexit 0\n'); fs.chmodSync(script, 0o755);
    verif = (await app.api('POST', '/api/verifiers', {
      name: 'tests-app', kind: 'commands', commands: [script], repos: [{ repo_id: repoApp, mode: 'worktree' }],
    })).body;

    // Une session d'agent déjà connue de l'outil : elle se propose sous « reprendre une session ».
    await app.api('POST', '/api/tasks', {
      kind: 'code', label: 'Session d’hier', prompt: 'Travail d’hier', session_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      targets: [{ repo_id: repoApp, branch: 'ai/hier' }],
    });

    // Skills et sous-agents du disque : ceux du home, que la modale propose à cocher.
    ecrire(path.join(fauxHome, '.claude/skills/perso/SKILL.md'), '---\nname: perso\ndescription: Le mien.\n---\n');
    ecrire(path.join(fauxHome, '.claude/agents/chercheur.md'), '---\nname: chercheur\ndescription: Cherche dans un dépôt.\n---\n');
    ecrire(path.join(fauxHome, '.claude/agents/traducteur.md'), '---\nname: traducteur\ndescription: Traduit les messages.\n---\n');
    await app.api('POST', '/api/skills/rescan');

    racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    for (const d of ['scripts', 'outils', 'docs']) fs.mkdirSync(path.join(racine, d), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine, label: 'mes projets' });

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
    try { fs.rmSync(fauxHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /* ------------------------------------------------------------ ce que chaque saveur montre ---- */

  const ATTENDU = {
    //                  dépôts local  avert. codeOnly commit agent jira  avancé skills
    code: [true, false, false, true, true, true, true, true, true],
    explore: [true, false, false, false, false, true, true, true, true],
    local: [false, true, true, false, false, false, false, true, true],
    ask: [false, false, false, false, false, false, false, false, false],
  };
  const BLOCS = ['#taskReposWrap', '#taskLocalWrap', '#taskLocalWarn', '#codeOnlyFields', '#taskCommitRow',
    '#taskAgentRow', '#taskJiraRow', '#taskAdvanced', '#taskSkillsRow'];

  for (const [kind, attendu] of Object.entries(ATTENDU)) {
    test(`${kind} : la modale montre ce qui sert à cette saveur, et rien d’autre`, async () => {
      await ouvrir(kind);
      assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr(`task.kind.${kind}.title`));
      // Replié par défaut ; on le déplie pour juger de ce qu'il contient (absent en question libre).
      if (kind !== 'ask') {
        assert.equal(await page.locator('#taskAdvanced').evaluate((e) => e.open), false, `${kind} : l’avancé démarre replié`);
        await deplierAvance();
      }
      for (let i = 0; i < BLOCS.length; i += 1) {
        assert.equal(await page.locator(BLOCS[i]).isVisible(), attendu[i], `${kind} : ${BLOCS[i]} ${attendu[i] ? 'visible' : 'masqué'}`);
      }
      // La création propose les deux gestes : créer seulement, ou créer et lancer.
      assert.equal(await page.locator('#taskSubmitOnly').isVisible(), true);
      assert.equal((await page.locator('#taskSubmit').textContent()).trim(), await tr('task.btn.create-run'));
      if (kind === 'code') {
        for (const r of ['#taskConvergeRow', '#taskReviewAfterRow', '#taskNotifyJiraRow']) {
          assert.equal(await page.locator(r).isVisible(), true, `${r} en codage`);
        }
        assert.match(await page.locator('#taskConvergeLbl').textContent(), /8/, 'la case annonce le seuil réglé');
      }
      await fermer();
    });
  }

  /* ------------------------------------------------------------ codage : tout le formulaire ---- */

  test('codage : « créer sans lancer » — chaque champ arrive en base', async () => {
    const avantJobs = jobs();
    const avant = compte('task');
    await ouvrir('code');
    await page.locator('#taskPrompt').fill('Ajouter un cache sur le panier');
    await page.locator('#taskForm [name="label"]').fill('Ajout du cache');
    // La branche de travail se PROPOSE depuis le libellé tant qu'on n'y a pas touché.
    await page.waitForFunction(() => document.querySelector('#targetRows .target-row .t-branch').value === 'ai/ajout-du-cache');

    // Un second projet, puis un troisième qu'on retire : le formulaire suit.
    await page.locator('#addTarget').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);
    await choisirDepot(1, 'grp/lib');
    await lignes().nth(1).locator('.t-branch').fill('feat/cache-lib');
    await page.locator('#addTarget').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 3);
    await lignes().nth(2).locator('[data-rmrow]').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);

    // La branche de départ se CHOISIT dans les branches du dépôt (combo avec recherche).
    await choisirDansCombo(
      () => lignes().nth(0).locator('.t-base').click(),
      () => page.locator('#targetRows .combo-options:not([hidden]) .combo-opt[data-b="develop"]'),
      { fn: () => document.querySelector('#targetRows .target-row .t-base').value === 'develop' },
    );

    await deplierAvance();
    await page.locator('#taskForm [name="commit_message"]').fill('feat: cache du panier');
    for (const c of ['ask_questions', 'review_after', 'notify_jira', 'auto_push']) {
      await page.locator(`#taskForm [name="${c}"]`).check();
    }

    // Skills et sous-agents : le filtre MASQUE sans décocher.
    await page.waitForSelector('#taskSkills [data-skill$="|perso"]');
    await page.locator('#taskSkills [data-skill$="|perso"]').check();
    await page.locator('#taskSubagents [data-skill$="|chercheur"]').check();
    await page.locator('#taskSubagentFilter').fill('tradu');
    await page.waitForFunction(() => document.querySelector('#taskSubagents [data-skill$="|chercheur"]').closest('label').hidden);
    assert.equal(await page.locator('#taskSubagents [data-skill$="|traducteur"]').isVisible(), true);
    assert.equal(await page.locator('#taskSubagents [data-skill$="|chercheur"]').isChecked(), true,
      'filtrer ne doit jamais décocher ce qu’on ne voit plus');
    await page.locator('#taskSubagentFilter').fill('');

    // Deux pièces jointes, dont une qu'on retire avant d'envoyer.
    await page.locator('#taskFile').setInputFiles([
      { name: 'capture.png', mimeType: 'image/png', buffer: PNG },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('à ne pas joindre') },
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#taskPreviews .task-prev').length === 2);
    await page.locator('#taskPreviews .task-prev-doc [data-rmimg]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskPreviews .task-prev').length === 1);

    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => compte('task') === avant + 1, 'la session est créée');

    creee = derniere('task');
    const { body } = await app.api('GET', `/api/tasks/${creee.id}`);
    const t = body.task;
    assert.equal(t.kind, 'code');
    assert.equal(t.status, 'new', '« créer sans lancer » ne lance pas');
    assert.equal(t.label, 'Ajout du cache');
    assert.match(t.prompt, /^\/perso/, 'le skill coché ouvre la demande');
    assert.match(t.prompt, /Ajouter un cache sur le panier/);
    assert.equal(t.commit_message, 'feat: cache du panier');
    assert.equal(t.ask_questions, 1);
    assert.equal(t.review_after, 1);
    assert.equal(t.notify_jira, 1);
    assert.equal(t.auto_push, 1);
    assert.deepEqual(t.targets.map((x) => [x.repo_id, x.branch]), [[repoApp, 'ai/ajout-du-cache'], [repoLib, 'feat/cache-lib']]);
    assert.equal(t.targets[0].base_branch, 'develop', 'la branche de départ choisie dans le combo');
    assert.equal(body.images.length, 1, 'seule la pièce gardée est jointe');
    assert.equal(body.images[0].name, 'capture.png');
    assert.equal(jobs(), avantJobs, 'aucun job lancé');
    await page.waitForSelector(`#taskList .card[data-task="${creee.id}"]`);
  });

  /* LES MÊMES PROJETS QUE LA DERNIÈRE FOIS, et la même branche de départ par dépôt. */
  test('codage : la modale suivante repropose les mêmes projets et la même branche de départ', async () => {
    await ouvrir('code');
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);
    const repos = await page.$$eval('#targetRows .target-row .t-repo', (els) => els.map((e) => Number(e.value)));
    assert.deepEqual(repos, [repoApp, repoLib]);
    assert.equal(await lignes().nth(0).locator('.t-base').inputValue(), 'develop');
    await fermer();
  });

  test('codage : sans branche de travail, l’erreur s’affiche sous le champ et rien n’est créé', async () => {
    const avant = compte('task');
    await ouvrir('code');
    await page.locator('#taskPrompt').fill('Sans branche');
    await lignes().nth(0).locator('.t-branch').fill('');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#targetRows .field-error');
    assert.equal(await page.locator('#taskModal').isVisible(), true, 'la modale reste ouverte');
    assert.equal(compte('task'), avant);
    await fermer();
  });

  test('codage : une branche déjà prise est signalée, et un nom libre se propose en un clic', async () => {
    await ouvrir('code');
    const champ = lignes().nth(0).locator('.t-branch');
    await champ.fill('ai/ajout-du-cache');
    const libre = page.locator('#targetRows [data-branch-libre]').first();
    await libre.waitFor();
    assert.match(await page.locator('#targetRows .t-branch-note').first().textContent(), new RegExp(`#?${creee.id}|Ajout du cache`));
    await libre.click();
    await page.waitForFunction(() => document.querySelector('#targetRows .target-row .t-branch').value === 'ai/ajout-du-cache-2');
    await page.waitForSelector('#targetRows .t-branch-note', { state: 'detached' });
    await fermer();
  });

  /* ------------------------------------------------------------ vérificateur ---- */

  test('codage : le vérificateur ne se propose que s’il couvre tous les dépôts, et coche l’auto-push', async () => {
    await ouvrir('code');
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);
    // grp/app + grp/lib : le vérificateur n'en couvre qu'un, la liste dit pourquoi.
    await page.waitForSelector('#taskVerifierMissing:not([hidden])');
    assert.match(await page.locator('#taskVerifierMissing').textContent(), /tests-app/);
    assert.equal(await page.locator(`#taskVerifier option[value="${verif.id}"]`).count(), 0);

    // Le second projet passe sur grp/app : le vérificateur couvre tout, il devient proposable.
    await choisirDepot(1, 'grp/app');
    await page.waitForSelector(`#taskVerifier option[value="${verif.id}"]`, { state: 'attached' });
    assert.equal(await page.locator('#taskVerifierMissing').isHidden(), true);
    await page.locator('#taskForm [name="auto_push"]').uncheck();
    await page.locator('#taskVerifier').selectOption(String(verif.id));
    await page.waitForSelector('#taskVerifierNote:not([hidden])');
    assert.equal(await page.locator('#taskForm [name="auto_push"]').isChecked(), true, 'vérifier suppose du code poussé');

    // Décocher l'auto-push retire le vérificateur : la combinaison ne pourrait pas s'exécuter.
    await page.locator('#taskForm [name="auto_push"]').uncheck();
    await page.waitForFunction(() => document.querySelector('#taskVerifier').value === '');
    assert.equal(await page.locator('#taskVerifierNote').isHidden(), true);

    // Revenir sur un dépôt non couvert retire un vérificateur déjà choisi.
    await page.locator('#taskVerifier').selectOption(String(verif.id));
    await choisirDepot(1, 'grp/lib');
    await page.waitForFunction(() => document.querySelector('#taskVerifier').value === '');
    await page.waitForSelector('#taskVerifierMissing:not([hidden])');

    // Et il part bien avec la session.
    await choisirDepot(1, 'grp/app');
    await page.waitForSelector(`#taskVerifier option[value="${verif.id}"]`, { state: 'attached' });
    await page.locator('#taskVerifier').selectOption(String(verif.id));
    await lignes().nth(1).locator('[data-rmrow]').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 1);
    await page.locator('#taskPrompt').fill('Avec vérification');
    await lignes().nth(0).locator('.t-branch').fill('ai/avec-verif');
    const avant = compte('task');
    await page.locator('#taskSubmitOnly').click();
    await attendreServeur(async () => compte('task') === avant + 1, 'la session vérifiée est créée');
    const t = derniere('task');
    assert.equal(t.verifier_id, verif.id);
    assert.equal(t.auto_push, 1);
  });

  /* RETIRER UN PROJET CHANGE AUSSI LA LISTE. La liste n'était relue que sur l'événement `change`
     du combo de dépôt : la croix d'une ligne, comme « Ajouter un projet », redessinait les
     lignes SANS relire les vérificateurs. On retire le dépôt non couvert : `tests-app` couvre
     désormais la sélection, et la liste doit le proposer. */
  test('codage : retirer le projet non couvert rend le vérificateur proposable', async () => {
    await ouvrir('code');
    await page.locator('#addTarget').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);
    await choisirDepot(1, 'grp/lib');
    await page.waitForSelector('#taskVerifierMissing:not([hidden])');
    await lignes().nth(1).locator('[data-rmrow]').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 1);
    // Il ne reste que grp/app, que `tests-app` couvre : la liste doit le proposer.
    await page.waitForSelector(`#taskVerifier option[value="${verif.id}"]`, { state: 'attached', timeout: 5000 });
    assert.equal(await page.locator('#taskVerifierMissing').isHidden(), true);
  });

  test('codage : « compléter les vérificateurs » mène aux réglages en fermant la modale', async () => {
    await ouvrir('code');
    // Deux dépôts proposés ? On s'assure d'en avoir deux, dont un non couvert.
    if (await lignes().count() < 2) {
      await page.locator('#addTarget').click();
      await choisirDepot(1, 'grp/lib');
    }
    await page.waitForSelector('#taskVerifierMissing:not([hidden]) [data-go-verifiers]');
    await page.locator('#taskVerifierMissing [data-go-verifiers]').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#tab-admin').classList.contains('active'));
    await page.waitForFunction(() => document.querySelector('#sub-verifiers').classList.contains('active'));
  });

  /* ------------------------------------------------------------ Jira ---- */

  test('codage : « Récupérer » un ticket Jira remplit la demande, le libellé et le message de commit', async () => {
    await ouvrir('code');
    await page.locator('#taskPrompt').fill('Ma consigne à moi');
    await page.locator('#taskJiraKey').fill('proj-7');
    await page.locator('#taskJiraFetch').click();
    await page.waitForFunction(() => /PROJ-7/.test(document.querySelector('#taskJiraStatus').textContent));
    const prompt = await page.locator('#taskPrompt').inputValue();
    assert.match(prompt, /PROJ-7/);
    assert.match(prompt, /Le panier se recharge à chaque page/);
    assert.match(prompt, /Ma consigne à moi$/, 'ce qui était écrit est gardé, après le contexte');
    assert.equal(await page.locator('#taskForm [name="label"]').inputValue(), 'PROJ-7 Mettre les paniers en cache');
    assert.equal(await page.locator('#taskForm [name="commit_message"]').inputValue(), 'PROJ-7 Mettre les paniers en cache');
    await fermer();
  });

  /* ------------------------------------------------------------ session d'agent ---- */

  test('codage : une session d’agent connue se choisit, et la session créée la reprend', async () => {
    await ouvrir('code');
    await deplierAvance();
    const pick = page.locator('#taskSessionPick [data-sesskey="6ba7b810-9dad-11d1-80b4-00c04fd430c8"]');
    await pick.waitFor();
    await pick.click();
    assert.equal(await page.locator('#taskSessionId').inputValue(), '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    // Saisir dans le champ fait apparaître la mise en garde sur le répertoire de la session.
    await page.locator('#taskSessionId').fill('6ba7b810-9dad-11d1-80b4-00c04fd430c8 ');
    await page.waitForSelector('#taskSessionHint:not([hidden])');
    assert.equal((await page.locator('#taskSessionHint').textContent()).trim(), await tr('task.session-id.scope'));
    await page.locator('#taskSessionId').fill('6ba7b810-9dad-11d1-80b4-00c04fd430c8');

    await page.locator('#taskPrompt').fill('Reprendre la session d’hier');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await lignes().nth(0).locator('.t-branch').fill('ai/reprise');
    const avant = compte('task');
    await page.locator('#taskSubmitOnly').click();
    await attendreServeur(async () => compte('task') === avant + 1, 'la session reprise est créée');
    const t = (await app.api('GET', `/api/tasks/${derniere('task').id}`)).body.task;
    assert.equal(t.targets[0].session_key, '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
  });

  /* ------------------------------------------------------------ lancer ---- */

  test('codage : « Créer et lancer » crée ET lance la session', async () => {
    const avantJobs = jobs();
    await ouvrir('code');
    await page.locator('#taskPrompt').fill('Créer et lancer');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await lignes().nth(0).locator('.t-branch').fill('ai/creer-et-lancer');
    // La branche de départ retenue (develop) n'existe que sur la fausse forge : on part de main.
    await lignes().nth(0).locator('.t-base').fill('main');
    // UN seul vérificateur couvre le seul dépôt : il se choisit d'office, l'auto-push avec lui.
    await page.waitForFunction((v) => document.querySelector('#taskVerifier').value === String(v), verif.id);
    assert.equal(await page.locator('#taskForm [name="auto_push"]').isChecked(), true);
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => jobs() > avantJobs, 'un job est mis en file');
    await waitForJobs(app.api, { timeout: 120000 });
    const t = (await app.api('GET', `/api/tasks/${derniere('task').id}`)).body.task;
    assert.equal(t.prompt, 'Créer et lancer');
    assert.notEqual(t.status, 'new', 'la session a tourné');
    /* Un seul dépôt, un seul vérificateur qui le couvre : il s'est choisi tout seul, et avec lui
       l'auto-push. Le dry-run a donc commité, puis poussé. */
    assert.ok(['committed', 'pushed'].includes(t.targets[0].status),
      `le dry-run a commité sur la branche (${t.targets[0].status} ${t.targets[0].last_error || ''})`);
  });

  test('codage : Ctrl+Entrée depuis la demande soumet le formulaire', async () => {
    const avant = compte('task');
    await ouvrir('code');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await lignes().nth(0).locator('.t-branch').fill('ai/ctrl-entree');
    await page.locator('#taskPrompt').fill('Soumise au clavier');
    await page.locator('#taskPrompt').press('Control+Enter');
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => compte('task') === avant + 1, 'la session est créée au clavier');
    assert.equal(derniere('task').prompt, 'Soumise au clavier');
    await waitForJobs(app.api, { timeout: 120000 });
  });

  test('codage : « …puis converger » lance la convergence de la session', async () => {
    const avant = compte('task');
    await ouvrir('code');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await lignes().nth(0).locator('.t-branch').fill('ai/converger');
    await page.locator('#taskPrompt').fill('Coder puis converger');
    await page.locator('#taskForm [name="converge_after"]').check();
    await page.locator('#taskSubmit').click();
    await attendreServeur(async () => compte('task') === avant + 1, 'la session est créée');
    const id = derniere('task').id;
    await attendreServeur(async () => !!app.db.prepare("SELECT 1 FROM job WHERE kind = 'converge-session' AND target_id = ?").get(id),
      'la convergence est mise en file pour CETTE session');
    // Le job peut être déjà fini : 409 « rien à arrêter » est une réponse légitime.
    const stop = await app.api('POST', '/api/jobs/stop');
    assert.ok([200, 409].includes(stop.status), `arrêt : ${stop.status}`);
    await waitForJobs(app.api, { timeout: 120000 });
  });

  /* ------------------------------------------------------------ exploration ---- */

  test('exploration : la branche à lire se choisit dans le combo, la session arrive en base', async () => {
    const avant = compte('task');
    await ouvrir('explore');
    while (await lignes().count() > 1) await lignes().nth(1).locator('[data-rmrow]').click();
    await choisirDepot(0, 'grp/lib');
    await choisirDansCombo(
      () => lignes().nth(0).locator('.t-branch').click(),
      () => page.locator('#targetRows .combo-options:not([hidden]) .combo-opt[data-b="develop"]'),
      { fn: () => document.querySelector('#targetRows .target-row .t-branch').value === 'develop' },
    );
    await page.locator('#taskPrompt').fill('Comment le cache est-il invalidé ?');
    await page.locator('#taskForm [name="label"]').fill('Invalidation');
    await page.locator('#taskForm [name="ask_questions"]').check();
    await page.locator('#taskSubmitOnly').click();
    await attendreServeur(async () => compte('task') === avant + 1, 'l’exploration est créée');
    const t = (await app.api('GET', `/api/tasks/${derniere('task').id}`)).body.task;
    assert.equal(t.kind, 'explore');
    assert.equal(t.label, 'Invalidation');
    assert.equal(t.ask_questions, 1);
    assert.deepEqual(t.targets.map((x) => [x.repo_id, x.branch]), [[repoLib, 'develop']]);
    assert.ok(!t.commit_message, 'une exploration ne commite pas');
  });

  /* ------------------------------------------------------------ hors dépôt ---- */

  test('hors dépôt : sans projet choisi, rien n’est créé', async () => {
    const avant = compte('local_task');
    await ouvrir('local');
    await page.locator('#taskPrompt').fill('Nulle part');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForFunction((m) => [...document.querySelectorAll('.toast.err')].some((t) => t.textContent.includes(m)),
      await tr('local.dirs-required'));
    assert.equal(compte('local_task'), avant);
    await fermer();
  });

  test('hors dépôt : répertoire, projets ajoutés et retirés, pièces — tout arrive en base', async () => {
    const avant = compte('local_task');
    await ouvrir('local');
    assert.match(await page.locator('#localRootBox .cb-search').inputValue(), /^mes projets/, 'le répertoire unique est présélectionné');

    const choisirProjet = (i, nom) => choisirDansCombo(
      () => page.locator('#taskLocalDirRows .cb-search').nth(i).click(),
      () => page.locator('.combo-options:not([hidden]) .combo-opt[data-v]', { hasText: nom }),
      { fn: ([j, n]) => document.querySelectorAll('#taskLocalDirRows .cb-search')[j].value === n, arg: [i, nom] },
    );
    await choisirProjet(0, 'scripts');
    await page.locator('#taskLocalAddDir').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskLocalDirRows .local-dir-row').length === 2);
    await choisirProjet(1, 'outils');
    await page.locator('#taskLocalAddDir').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskLocalDirRows .local-dir-row').length === 3);
    await choisirProjet(2, 'docs');
    await page.locator('#taskLocalDirRows [data-rmdir="2"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskLocalDirRows .local-dir-row').length === 2);

    await page.locator('#taskPrompt').fill('Ranger les scripts et les outils');
    await page.locator('#taskForm [name="label"]').fill('Rangement');
    await page.locator('#taskForm [name="ask_questions"]').check();
    await page.locator('#taskFile').setInputFiles([{ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('le plan') }]);
    await page.waitForFunction(() => document.querySelectorAll('#taskPreviews .task-prev').length === 1);
    await page.locator('#taskSubmitOnly').click();
    await attendreServeur(async () => compte('local_task') === avant + 1, 'la session hors dépôt est créée');

    const id = derniere('local_task').id;
    const { body } = await app.api('GET', `/api/local-tasks/${id}`);
    assert.equal(body.task.status, 'new');
    assert.equal(body.task.label, 'Rangement');
    assert.equal(body.task.ask_questions, 1);
    assert.deepEqual(body.task.dirs.map((d) => d.path).sort(),
      [path.join(racine, 'outils'), path.join(racine, 'scripts')].sort(), 'le projet retiré n’est pas parti');
    assert.equal(body.images.length, 1);
  });

  test('hors dépôt : « Créer et lancer » code dans le dossier', async () => {
    const avant = compte('local_task');
    await ouvrir('local');
    await choisirDansCombo(
      () => page.locator('#taskLocalDirRows .cb-search').first().click(),
      () => page.locator('.combo-options:not([hidden]) .combo-opt[data-v]', { hasText: 'docs' }),
      { fn: () => document.querySelector('#taskLocalDirRows .cb-search').value === 'docs' },
    );
    await page.locator('#taskPrompt').fill('Écrire la doc');
    await page.locator('#taskSubmit').click();
    await attendreServeur(async () => compte('local_task') === avant + 1, 'la session hors dépôt est créée');
    const id = derniere('local_task').id;
    await attendreServeur(async () => (await app.api('GET', `/api/local-tasks/${id}`)).body.task.status === 'done',
      'la session hors dépôt a tourné', 60000);
    assert.ok(fs.existsSync(path.join(racine, 'docs', 'PROJ_LOCAL_DRYRUN.md')), 'l’agent (dry-run) a écrit dans le dossier');
  });

  /* ------------------------------------------------------------ question libre ---- */

  test('question libre : « créer sans lancer » crée la question sans la lancer', async () => {
    const avant = compte('question');
    await ouvrir('ask');
    await page.locator('#taskPrompt').fill('Qu’est-ce qu’un quorum ?');
    await page.locator('#taskFile').setInputFiles([{ name: 'spec.txt', mimeType: 'text/plain', buffer: Buffer.from('la spec') }]);
    await page.waitForFunction(() => document.querySelectorAll('#taskPreviews .task-prev').length === 1);
    await page.locator('#taskSubmitOnly').click();
    await attendreServeur(async () => compte('question') === avant + 1, 'la question est créée');
    const { body } = await app.api('GET', `/api/questions/${derniere('question').id}`);
    assert.equal(body.task.status, 'new');
    assert.equal(body.images.length, 1, 'une question libre joint des fichiers elle aussi');
  });

  /* ------------------------------------------------------------ édition ---- */

  test('codage : modifier une session relit chaque champ, et enregistre la correction', async () => {
    await aller('code');
    const carte = `#taskList .card[data-task="${creee.id}"]`;
    await page.waitForSelector(carte);
    await page.locator(`${carte} [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);

    assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr('task.edit.code-title'));
    assert.equal(await page.locator('#taskSubmitOnly').isVisible(), false, 'on modifie : rien à créer');
    assert.equal(await page.locator('#taskConvergeRow').isVisible(), false, 'converger se lance depuis la carte d’une session écrite');
    assert.equal(await page.locator('#taskForm [name="label"]').inputValue(), 'Ajout du cache');
    assert.equal(await page.locator('#taskForm [name="commit_message"]').inputValue(), 'feat: cache du panier');
    // Un message de commit relu se VOIT : l'avancé s'est déplié tout seul à l'édition.
    assert.equal(await page.locator('#taskAdvanced').evaluate((e) => e.open), true, 'l’avancé se déplie quand il porte une valeur');
    for (const c of ['ask_questions', 'review_after', 'notify_jira', 'auto_push']) {
      assert.equal(await page.locator(`#taskForm [name="${c}"]`).isChecked(), true, `${c} relu`);
    }
    assert.deepEqual(await page.$$eval('#targetRows .target-row .t-branch', (els) => els.map((e) => e.value)),
      ['ai/ajout-du-cache', 'feat/cache-lib']);
    // La pièce déjà jointe se VOIT, et se retire pour de bon (après confirmation).
    await page.waitForSelector('#taskPieces .task-prev');
    await page.locator('#taskPieces [data-rmpj]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => !document.querySelector('#taskPieces .task-prev'));
    assert.equal((await app.api('GET', `/api/tasks/${creee.id}`)).body.images.length, 0);

    await page.locator('#taskForm [name="commit_message"]').fill('feat: cache du panier (v2)');
    await page.locator('#taskForm [name="review_after"]').uncheck();
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => (await app.api('GET', `/api/tasks/${creee.id}`)).body.task.commit_message === 'feat: cache du panier (v2)',
      'la correction est enregistrée');
    const t = (await app.api('GET', `/api/tasks/${creee.id}`)).body.task;
    assert.equal(t.review_after, 0);
    assert.equal(t.status, 'new', 'modifier ne lance rien');
  });

  /* « AUCUN » VÉRIFICATEUR CHOISI EN ÉDITION DOIT LE RESTER. Sur un seul dépôt couvert par un
     seul vérificateur, celui-ci se choisit tout seul à l'INITIALISATION — pratique à la création,
     où un sélecteur vide ne se remarque pas. Mais rouvrir une session déjà écrite où « aucun » a
     été choisi et enregistré est aussi une initialisation du sélecteur : sans distinction, ce
     même réflexe effaçait le retrait délibéré à chaque réouverture. */
  test('codage : « aucun » vérificateur choisi en édition reste « aucun » à la réouverture', async () => {
    const avant = compte('task');
    const cree = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Solo', targets: [{ repo_id: repoApp, branch: 'ai/solo' }],
      auto_push: true, verifier_id: verif.id,
    })).body;
    assert.equal(cree.verifier_id, verif.id, 'le seul vérificateur qui couvre ce dépôt est accepté à la création');

    await aller('code');
    const carte = `#taskList .card[data-task="${cree.id}"]`;
    await page.waitForSelector(carte);
    await page.locator(`${carte} [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((v) => document.querySelector('#taskVerifier').value === String(v), verif.id);

    await page.locator('#taskVerifier').selectOption('');
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => (await app.api('GET', `/api/tasks/${cree.id}`)).body.task.verifier_id === null,
      '« aucun » est enregistré');

    await page.locator(`${carte} [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#taskVerifier option').length > 1);
    assert.equal(await page.locator('#taskVerifier').inputValue(), '',
      '« aucun », choisi et enregistré, ne doit pas revenir au seul vérificateur couvrant');
    await fermer();
    assert.equal(compte('task'), avant + 1);
  });

  test('hors dépôt : modifier relit le répertoire et les projets, et enregistre', async () => {
    const id = app.db.prepare("SELECT id FROM local_task WHERE label = 'Rangement'").get().id;
    await aller('local');
    const carte = `#localList .card[data-local="${id}"]`;
    await page.waitForSelector(carte);
    await page.locator(`${carte} [data-ledit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#taskLocalDirRows .local-dir-row').length === 2);
    assert.deepEqual((await page.$$eval('#taskLocalDirRows .cb-search', (els) => els.map((e) => e.value))).sort(), ['outils', 'scripts']);
    assert.equal(await page.locator('#taskForm [name="ask_questions"]').isChecked(), true);
    await page.locator('#taskLocalDirRows [data-rmdir="1"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskLocalDirRows .local-dir-row').length === 1);
    await page.locator('#taskPrompt').fill('Ranger seulement un dossier');
    await page.locator('#taskSubmit').click();
    await attendreServeur(async () => (await app.api('GET', `/api/local-tasks/${id}`)).body.task.prompt === 'Ranger seulement un dossier',
      'la session hors dépôt est modifiée');
    assert.equal((await app.api('GET', `/api/local-tasks/${id}`)).body.task.dirs.length, 1);
  });

  /* ------------------------------------------------------------ fermer ---- */

  test('Annuler, Échap et un clic au fond ferment la modale sans rien créer', async () => {
    const avant = compte('task');
    await ouvrir('code');
    await fermer();
    await ouvrir('code');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await ouvrir('code');
    // Clic au fond, formulaire intact : la modale se ferme (saisie, elle refuserait — cf. e2e-modal).
    await page.waitForFunction(() => !document.querySelector('#taskModal').dataset.saisi);
    await page.mouse.click(5, 5);
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    assert.equal(compte('task'), avant);
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
