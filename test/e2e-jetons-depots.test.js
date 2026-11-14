'use strict';
/* MENU « DEV IA » — LES JETONS « &&dépôt » DE LA DEMANDE.
 *
 * Choisir ses dépôts dans la modale, c'est un combo par ligne ; on les nomme dans la demande
 * au fil de la frappe. Couvert ici, dans un vrai navigateur : quatre lettres au moins ; un seul
 * dépôt correspond → la ligne se pose toute seule ; plusieurs → le menu, et Entrée tranche ;
 * `&&nom&branche` (ou `@`) pose la branche ; effacer le jeton retire la ligne, sauf branche
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

  test('&&nom&branche pose la branche, « @ » aussi ; effacer un jeton retire sa ligne, sauf branche écrite à la main', async () => {
    const prompt = page.locator('#taskPrompt');
    await prompt.fill('Corriger le cache &&core&hotfix/cache et &&tarif-legacy@release/1.9');
    const attendu = [['grp/alpha-app', ''], ['grp/api-core', 'hotfix/cache'], ['grp/tarif-legacy', 'release/1.9']];
    try {
      await page.waitForFunction((a) => {
        const l = [...document.querySelectorAll('#targetRows .target-row')].map((r) => [r.querySelector('.t-repo-search').value, r.querySelector('.t-branch').value]);
        return JSON.stringify(l) === a;
      }, JSON.stringify(attendu), { timeout: 10000 });
    } catch { assert.deepEqual(await lignes(), attendu); }
    // Une branche écrite à la main sur la ligne du jeton : la ligne reste quand le jeton part.
    await page.locator('#targetRows .target-row').nth(2).locator('.t-branch').fill('mine/legacy');
    await prompt.fill('Corriger le cache &&core&hotfix/cache');
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
    await prompt.fill('Corriger le cache &&core&hotfix/cache des paniers.');
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
    await page.locator('#taskPrompt').fill('&&core&hotfix/x');
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
    await page.locator('#taskPrompt').fill('Lire le module de TVA &&tarification&release/2.0');
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

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
