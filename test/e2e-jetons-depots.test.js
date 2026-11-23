'use strict';
/* MENU « DEV IA » — LES JETONS « &&dépôt » DE LA DEMANDE.
 *
 * Choisir ses dépôts dans la modale, c'est un combo par ligne ; on les nomme dans la demande
 * au fil de la frappe. Couvert ici, dans un vrai navigateur : quatre lettres au moins ; un seul
 * dépôt correspond → la ligne se pose toute seule ; plusieurs → le menu, et Entrée tranche ;
 * `&&nom:branche` pose la branche, `&&*:branche` la pose sur toutes les lignes (le jeton
 * d'un dépôt passe devant, la retirer rend la proposition) ; effacer le jeton retire la ligne, sauf branche
 * écrite à la main ; la branche de travail ne se propose pas depuis la demande ; la soumission envoie
 * la demande SANS les jetons — en codage ET en exploration (la modale est une, ses envois sont
 * deux) ; une demande faite de jetons seuls est refusée sous le champ. Un seul `startApp()`. */

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Dev IA — les jetons &&dépôt de la demande', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page;
  const erreurs = [];
  const ids = {};
  const PROJETS = ['grp/alpha-app', 'grp/tarification', 'grp/tarif-legacy', 'grp/api-core'];

  const ouvrir = async (kind) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`).classList.contains('active'), kind);
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForSelector('#targetRows .target-row .t-repo-search');
  };
  const fermer = async () => {
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  };
  // Les dépôts des lignes, dans l'ordre, et la branche de chacune.
  const lignes = () => page.$$eval('#targetRows .target-row', (rows) => rows.map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-branch').value]));
  const attendreLigne = (projet) => page.waitForFunction((p) => [...document.querySelectorAll('#targetRows .target-row .t-repo-search')].some((i) => i.value === p), projet);
  const attendreSansLigne = (projet) => page.waitForFunction((p) => ![...document.querySelectorAll('#targetRows .target-row .t-repo-search')].some((i) => i.value === p), projet);
  const compte = () => app.db.prepare('SELECT COUNT(*) c FROM task').get().c;
  const derniere = async () => {
    const t = app.db.prepare('SELECT id FROM task ORDER BY id DESC LIMIT 1').get();
    return (await app.api('GET', `/api/tasks/${t.id}`)).body.task;
  };

  before(async () => {
    app = await startApp();
    for (const p of PROJETS) {
      const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, `${p.split('/')[1]}-`)));
      ids[p] = (await app.api('POST', '/api/repos', { url: r.url, project: p })).body.id;
    }
    /* Deux tickets du faux Jira. PROJ-5 nomme ses dépôts dans la description ET dans le
       commentaire « #tech » (en code, comme on l'écrit pour que l'éditeur n'y touche pas) : la
       branche du commentaire passe devant celle de la description ; un nom ambigu et un nom
       inconnu ne posent rien et se disent. PROJ-6 sert au bouton « Récupérer ». */
    const texte = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
    const adf = (...noeuds) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: noeuds }] });
    app.state.jiraIssues['PROJ-5'] = {
      key: 'PROJ-5',
      fields: {
        summary: 'TVA des paniers', status: { name: 'À faire', statusCategory: { key: 'new' } }, issuetype: { name: 'Story' },
        description: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [texte('Le calcul vit dans &&tarification:feature/old-tva, l’affichage dans &&core et peut-être &&tarif.')] },
          { type: 'paragraph', content: [texte('&&> Consigne de la description, écartée')] },
        ] },
        comment: { comments: [{ author: { displayName: 'Alex' }, created: '2026-09-02T09:00:00.000+0000',
          body: { type: 'doc', version: 1, content: [
            { type: 'paragraph', content: [texte('#tech Corriger dans '), texte('&&tarification:hotfix/tva', [{ type: 'code' }]), texte(' et &&inconnu-x.')] },
            { type: 'paragraph', content: [texte('&&> Aligner la TVA des paniers')] },
            { type: 'paragraph', content: [texte('&&> - arrondi sur la dernière ligne')] },
          ] } }] },
      },
    };
    app.state.jiraIssues['PROJ-6'] = {
      key: 'PROJ-6',
      fields: {
        summary: 'Accueil', status: { name: 'À faire', statusCategory: { key: 'new' } }, issuetype: { name: 'Story' },
        description: { type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [texte('Page d’accueil : &&alpha-app:feature/accueil<main.')] },
          { type: 'paragraph', content: [texte('&&> Refaire la page d’accueil')] },
        ] },
        comment: { comments: [] },
      },
    };
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  test('un nom unique de quatre lettres pose sa ligne ; trois lettres ne font rien ; la demande ne propose pas de branche', async () => {
    await ouvrir('code');
    const avant = await lignes();
    assert.equal(avant.length, 1, 'la ligne proposée d’office');
    assert.equal(avant[0][0], 'grp/alpha-app');
    const prompt = page.locator('#taskPrompt');
    // « cor » : trois lettres, et « core » : quatre — le second pose la ligne, pas le premier.
    await prompt.fill('Corriger le cache &&cor puis &&core');
    await attendreLigne('grp/api-core');
    const apres = await lignes();
    assert.deepEqual(apres.map((l) => l[0]), ['grp/alpha-app', 'grp/api-core'], 'une ligne ajoutée, la première gardée');
    // La demande ne propose AUCUNE branche de travail : les champs restent à écrire (le libellé, lui, en propose une).
    assert.deepEqual(apres.map((l) => l[1]), ['', '']);
    await page.locator('#taskForm [name="label"]').fill('Cache');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row .t-branch')].every((c) => c.value === 'ai/cache'));
    // Un libellé effacé ne retire pas la proposition (elle reste, comme avant) : on vide les champs à la main
    // pour la suite — un champ vidé volontairement le reste.
    await page.locator('#taskForm [name="label"]').fill('');
    for (let i = 0; i < 2; i += 1) await page.locator('#targetRows .target-row').nth(i).locator('.t-branch').fill('');
    assert.deepEqual((await lignes()).map((l) => l[1]), ['', '']);
  });

  test('un nom qui hésite entre deux dépôts ouvre le menu, n’ajoute rien, et Entrée tranche', async () => {
    const prompt = page.locator('#taskPrompt');
    await prompt.fill('Corriger le cache &&core et &&tarif');
    await page.waitForSelector('.ac-menu:not([hidden]) .combo-opt');
    const options = await page.$$eval('.ac-menu:not([hidden]) .combo-opt', (os) => os.map((o) => o.textContent.trim()));
    assert.deepEqual(options, ['&&grp/tarification', '&&grp/tarif-legacy']);
    assert.deepEqual((await lignes()).map((l) => l[0]), ['grp/alpha-app', 'grp/api-core'], 'rien n’est ajouté sur un jeton flou');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#taskPrompt').value === 'Corriger le cache &&core et &&grp/tarif-legacy ');
    await attendreLigne('grp/tarif-legacy');
    assert.deepEqual((await lignes()).map((l) => l[0]), ['grp/alpha-app', 'grp/api-core', 'grp/tarif-legacy']);
  });

  test('&&nom:branche pose la branche ; effacer un jeton retire sa ligne, sauf branche écrite à la main', async () => {
    const prompt = page.locator('#taskPrompt');
    await prompt.fill('Corriger le cache &&core:hotfix/cache et &&tarif-legacy:release/1.9');
    const attendu = [['grp/alpha-app', ''], ['grp/api-core', 'hotfix/cache'], ['grp/tarif-legacy', 'release/1.9']];
    try {
      await page.waitForFunction((a) => {
        const l = [...document.querySelectorAll('#targetRows .target-row')].map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-branch').value]);
        return JSON.stringify(l) === a;
      }, JSON.stringify(attendu), { timeout: 10000 });
    } catch { assert.deepEqual(await lignes(), attendu); }
    // Une branche écrite à la main sur la ligne du jeton : la ligne reste quand le jeton part.
    await page.locator('#targetRows .target-row').nth(2).locator('.t-branch').fill('mine/legacy');
    await prompt.fill('Corriger le cache &&core:hotfix/cache');
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 3 && document.querySelector('#taskPrompt').value.endsWith('cache'));
    // …et une ligne dont la branche vient du jeton part avec lui.
    await prompt.fill('Corriger le cache');
    await attendreSansLigne('grp/api-core');
    assert.deepEqual((await lignes()).map((l) => l[0]), ['grp/alpha-app', 'grp/tarif-legacy']);
    assert.equal((await lignes())[1][1], 'mine/legacy');
  });

  test('codage : la demande part sans ses jetons, avec les dépôts et branches qu’ils ont posés', async () => {
    const avant = compte();
    const prompt = page.locator('#taskPrompt');
    await prompt.fill('Corriger le cache &&core:hotfix/cache des paniers.');
    await attendreLigne('grp/api-core');
    // La première ligne (alpha-app, proposée d'office) est retirée à la main : la session vise ce que les jetons ont dit.
    await page.locator('#targetRows .target-row').nth(0).locator('[data-rmrow]').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => compte() === avant + 1, 'la session est créée');
    const t = await derniere();
    assert.equal(t.kind, 'code');
    assert.equal(t.prompt, 'Corriger le cache des paniers.', 'le jeton est retiré, l’espace double aussi');
    assert.deepEqual(t.targets.map((x) => [x.repo_id, x.branch]).sort((a, b) => a[0] - b[0]),
      [[ids['grp/tarif-legacy'], 'mine/legacy'], [ids['grp/api-core'], 'hotfix/cache']].sort((a, b) => a[0] - b[0]));
  });

  /* Le dernier projet ne part pas avec son jeton — et surtout il reste TEL QUEL : remplacé par une
     ligne neuve, sa branche repartait vide. */
  test('effacer le seul jeton garde la dernière ligne, branche comprise, et la demande ne la réécrit plus', async () => {
    await ouvrir('code');
    await page.locator('#taskPrompt').fill('&&core:hotfix/x');
    // La modale repropose les projets de la dernière session (api-core en est) : on attend la BRANCHE
    // du jeton, seule preuve qu'il a été lu, pas la simple présence du dépôt.
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')]
      .some((r) => r.querySelector('.t-repo-search').value === 'grp/api-core' && r.querySelector('.t-branch').value === 'hotfix/x'));
    for (let avant = (await lignes()).length; avant > 1; avant -= 1) {
      const i = (await lignes()).findIndex((l) => l[0] !== 'grp/api-core');
      await page.locator('#targetRows .target-row').nth(i).locator('[data-rmrow]').click();
      await page.waitForFunction((n) => document.querySelectorAll('#targetRows .target-row').length === n, avant - 1);
    }
    await page.locator('#taskPrompt').fill('');
    await page.locator('#taskPrompt').fill('Nouvelle demande sans jeton');
    // L'effet attendu est une ABSENCE de changement : on attend que la proposition de branche ait eu
    // sa chance (le libellé, lui, la déclenche à coup sûr), puis on relit la ligne.
    await page.locator('#taskForm [name="label"]').fill('Libellé');
    await page.waitForFunction(() => document.querySelector('#taskForm [name="label"]').value === 'Libellé');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    assert.deepEqual(await lignes(), [['grp/api-core', 'hotfix/x']]);
    await fermer();
  });

  test('&&*:branche pose la même branche sur toutes les lignes, le jeton d’un dépôt passe devant, l’effacer rend la proposition', async () => {
    const avant = compte();
    await ouvrir('code');
    await page.locator('#taskForm [name="label"]').fill('Tva');
    const prompt = page.locator('#taskPrompt');
    await prompt.fill('Aligner la TVA &&core &&tarification:hotfix/tva &&*:feature/tva-2026');
    const branches = () => page.$$eval('#targetRows .target-row', (rows) => rows.map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-branch').value]));
    await page.waitForFunction(() => {
      const l = [...document.querySelectorAll('#targetRows .target-row')].map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-branch').value]);
      return l.length >= 2 && l.some((x) => x[0] === 'grp/api-core' && x[1] === 'feature/tva-2026')
        && l.some((x) => x[0] === 'grp/tarification' && x[1] === 'hotfix/tva')
        && l.every((x) => x[0] === 'grp/tarification' || x[1] === 'feature/tva-2026');
    });
    // Une ligne ajoutée au « + » APRÈS le jeton reçoit la globale aussi (compte pris AVANT le clic).
    const nAvant = (await branches()).length;
    await page.locator('#addTarget').click();
    await page.waitForFunction((n) => document.querySelectorAll('#targetRows .target-row').length === n, nAvant + 1);
    assert.equal((await branches()).at(-1)[1], 'feature/tva-2026', 'la ligne neuve porte la branche globale');
    // La ligne neuve répète le premier dépôt : retirée avant l'envoi, deux lignes sur un même dépôt sont refusées.
    await page.locator('#targetRows .target-row').nth(nAvant).locator('[data-rmrow]').click();
    await page.waitForFunction((n) => document.querySelectorAll('#targetRows .target-row').length === n, nAvant);
    // Le jeton d'un dépôt passe devant la globale, et une modification de la globale suit partout.
    await prompt.fill('Aligner la TVA &&core &&tarification:hotfix/tva &&*:feature/tva-2027');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')]
      .every((r) => r.querySelector('.t-branch').value === (r.querySelector('.t-repo-search').value === 'grp/tarification' ? 'hotfix/tva' : 'feature/tva-2027')));
    // La soumission envoie les branches posées et un prompt sans AUCUN jeton.
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => compte() === avant + 1, 'la session est créée');
    const t = await derniere();
    assert.equal(t.prompt, 'Aligner la TVA');
    const parDepot = Object.fromEntries(t.targets.map((x) => [x.repo_id, x.branch]));
    assert.equal(parDepot[ids['grp/tarification']], 'hotfix/tva');
    assert.equal(parDepot[ids['grp/api-core']], 'feature/tva-2027');
    assert.ok(Object.values(parDepot).every((b) => b === 'hotfix/tva' || b === 'feature/tva-2027'));
    // Retirer `&&*…` rend aux lignes leur proposition — ici celle du libellé.
    await ouvrir('code');
    await page.locator('#taskForm [name="label"]').fill('Tva');
    await prompt.fill('Aligner la TVA &&core &&*:feature/tva-2026');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')].length
      && [...document.querySelectorAll('#targetRows .target-row')].every((r) => r.querySelector('.t-branch').value === 'feature/tva-2026'));
    await prompt.fill('Aligner la TVA &&core');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')].every((r) => r.querySelector('.t-branch').value === 'ai/tva'));
    await fermer();
  });

  test('une demande faite de jetons seuls est refusée sous le champ, rien n’est créé', async () => {
    const avant = compte();
    await ouvrir('code');
    await page.locator('#taskPrompt').fill('&&core');
    await attendreLigne('grp/api-core');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskPrompt-err.field-error');
    assert.match(await page.locator('#taskPrompt-err').textContent(), /jetons de dépôt|repository tokens/);
    assert.equal(await page.locator('#taskModal').isHidden(), false);
    assert.equal(compte(), avant);
    await fermer();
  });

  test('exploration : même convention, même retrait, la branche à lire posée par le jeton', async () => {
    const avant = compte();
    await ouvrir('explore');
    await page.locator('#taskPrompt').fill('Lire le module de TVA &&tarification:release/2.0');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')]
      .some((r) => r.querySelector('.t-repo-search').value === 'grp/tarification' && r.querySelector('.t-branch').value === 'release/2.0'));
    await page.locator('#targetRows .target-row').nth(0).locator('[data-rmrow]').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 1);
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => compte() === avant + 1, 'l’exploration est créée');
    const t = await derniere();
    assert.equal(t.kind, 'explore');
    assert.equal(t.prompt, 'Lire le module de TVA');
    assert.deepEqual(t.targets.map((x) => [x.repo_id, x.branch]), [[ids['grp/tarification'], 'release/2.0']]);
  });

  test('depuis un ticket Jira : les dépôts de la description et du « #tech » posent les lignes, sans rien choisir', async () => {
    const avant = compte();
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.evaluate(() => window.openTaskForJira('PROJ-5'));
    await page.waitForSelector('#taskModal:not([hidden])');
    // La branche du « #tech » (hotfix/tva) passe devant celle de la description ; &&core prend celle du ticket.
    await page.waitForFunction(() => {
      const l = [...document.querySelectorAll('#targetRows .target-row')].map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-branch').value]);
      return l.length === 2 && l[0][0] === 'grp/tarification' && l[0][1] === 'hotfix/tva'
        && l[1][0] === 'grp/api-core' && /^feature\/PROJ-5-tva/.test(l[1][1]);
    });
    // Ce qui n'a rien posé se dit sous les lignes : l'ambigu avec ses candidats, l'inconnu.
    await page.waitForSelector('#taskJetonsNote:not([hidden])');
    const note = await page.locator('#taskJetonsNote').textContent();
    assert.match(note, /&&tarif : 2 dépôts correspondent \(grp\/tarification, grp\/tarif-legacy\)|&&tarif: 2 repositories/);
    assert.match(note, /&&inconnu-x/);
    /* La demande du « #tech » (`&&> …`) suit le séparateur, sans préfixe ; celle de la description
       est écartée, et aucune ligne `&&>` ne reste dans le contexte. */
    const pre = await page.locator('#taskPrompt').inputValue();
    assert.ok(pre.endsWith('---\n\nAligner la TVA des paniers\n- arrondi sur la dernière ligne\n'), pre);
    assert.doesNotMatch(pre, /&&>|Consigne de la description/);
    await page.locator('#taskPrompt').press('End');
    await page.locator('#taskPrompt').pressSequentially('Garder l’arrondi.');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => compte() === avant + 1, 'la session est créée');
    const t = await derniere();
    assert.doesNotMatch(t.prompt, /&&/, 'les jetons du ticket ne partent pas à l’agent');
    assert.doesNotMatch(t.prompt, /``/, 'ni le code en ligne qu’ils laissaient vide');
    assert.match(t.prompt, /Corriger dans/);
    assert.match(t.prompt, /Aligner la TVA des paniers\n- arrondi sur la dernière ligne\nGarder l’arrondi\.$/);
    const parDepot = Object.fromEntries(t.targets.map((x) => [x.repo_id, x.branch]));
    assert.equal(parDepot[ids['grp/tarification']], 'hotfix/tva');
    assert.match(parDepot[ids['grp/api-core']], /^feature\/PROJ-5-tva/);
    assert.equal(t.targets.length, 2);
  });

  test('« Récupérer » un ticket dans la modale pose aussi les dépôts qu’il nomme, branche de départ comprise', async () => {
    await ouvrir('code');
    await page.waitForSelector('#taskJiraRow:not([hidden])');
    await page.locator('#taskJiraKey').fill('PROJ-6');
    await page.locator('#taskJiraFetch').click();
    await page.waitForFunction(() => /PROJ-6/.test(document.querySelector('#taskPrompt').value));
    assert.ok((await page.locator('#taskPrompt').inputValue()).endsWith('---\n\nRefaire la page d’accueil\n'), 'la demande du ticket remplit la suite');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')]
      .some((r) => r.querySelector('.t-repo-search').value === 'grp/alpha-app' && r.querySelector('.t-branch').value === 'feature/accueil'
        && r.querySelector('.t-base').value === 'main'));
    assert.equal(await page.locator('#taskJetonsNote').isHidden(), true, 'rien à signaler : le jeton a posé sa ligne');
    await fermer();
  });

  test('hors dépôt : la demande &&> du ticket remplit aussi la suite', async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.evaluate(() => window.openLocalTaskForJira('PROJ-6'));
    await page.waitForFunction(() => /PROJ-6/.test(document.querySelector('#taskPrompt').value));
    const v = await page.locator('#taskPrompt').inputValue();
    assert.ok(v.endsWith('---\n\nRefaire la page d’accueil\n'), v);
    assert.doesNotMatch(v, /&&>/);
    await fermer();
  });

  test('la branche de départ : &&nom:branche<depart pour un dépôt, &&*<depart pour tous, et elle part avec la session', async () => {
    const avant = compte();
    await ouvrir('code');
    const prompt = page.locator('#taskPrompt');
    const bases = () => page.$$eval('#targetRows .target-row', (rows) => rows.map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-branch').value, r.querySelector('.t-base').value]));
    await prompt.fill('Aligner la TVA &&core:hotfix/tva<main &&tarification<release/1 ');
    await page.waitForFunction(() => {
      const l = [...document.querySelectorAll('#targetRows .target-row')].map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-base').value]);
      return l.some((x) => x[0] === 'grp/api-core' && x[1] === 'main') && l.some((x) => x[0] === 'grp/tarification' && x[1] === 'release/1');
    });
    // `&&nom<depart` ne pose aucune branche de travail ; `&&*<depart` donne son départ à chaque ligne sans départ de jeton.
    assert.equal((await bases()).find((l) => l[0] === 'grp/tarification')[1], '');
    await prompt.fill('Aligner la TVA &&core:hotfix/tva<main &&tarification:feature/tva &&*<release/2 ');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')]
      .every((r) => r.querySelector('.t-base').value === (r.querySelector('.t-repo-search').value === 'grp/api-core' ? 'main' : 'release/2')));
    // Garder les seules lignes des jetons, puis envoyer : chaque départ part avec sa ligne.
    for (;;) {
      const i = (await bases()).findIndex((l) => l[0] !== 'grp/api-core' && l[0] !== 'grp/tarification');
      if (i < 0) break;
      const n = (await bases()).length;
      await page.locator('#targetRows .target-row').nth(i).locator('[data-rmrow]').click();
      await page.waitForFunction((k) => document.querySelectorAll('#targetRows .target-row').length === k, n - 1);
    }
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => compte() === avant + 1, 'la session est créée');
    const t = await derniere();
    assert.equal(t.prompt, 'Aligner la TVA');
    const parDepot = Object.fromEntries(t.targets.map((x) => [x.repo_id, [x.branch, x.base_branch]]));
    assert.deepEqual(parDepot[ids['grp/api-core']], ['hotfix/tva', 'main']);
    assert.deepEqual(parDepot[ids['grp/tarification']], ['feature/tva', 'release/2']);
  });

  test('effacer le départ du jeton rend au champ sa proposition', async () => {
    await ouvrir('code');
    const prompt = page.locator('#taskPrompt');
    await prompt.fill('Corriger &&tarif-legacy:fix/x<release/9 ');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')]
      .some((r) => r.querySelector('.t-repo-search').value === 'grp/tarif-legacy' && r.querySelector('.t-base').value === 'release/9'));
    await prompt.fill('Corriger &&tarif-legacy:fix/x ');
    await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .target-row')]
      .some((r) => r.querySelector('.t-repo-search').value === 'grp/tarif-legacy' && r.querySelector('.t-branch').value === 'fix/x' && r.querySelector('.t-base').value !== 'release/9'));
    await fermer();
  });

  test('la bulle ⓘ de « Projets et branches » donne la syntaxe des jetons', async () => {
    await ouvrir('code');
    await page.locator('#taskJetonsTip').hover();
    await page.waitForSelector('#tip.on');
    const bulle = await page.locator('#tip').textContent();
    for (const motif of ['&&nom:branche<départ', '&&nom<départ', '&&*:branche<départ', '#tech']) {
      assert.ok(bulle.includes(motif), `la bulle cite ${motif}`);
    }
    assert.equal(await page.locator('#tip').evaluate((el) => el.classList.contains('tip-code')), true, 'en police à chasse fixe');
    await page.mouse.move(0, 0);
    await fermer();
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
