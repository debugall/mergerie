'use strict';
/* LES GROUPES DE DÉPÔTS, À L'ÉCRAN (ameliorations_proposal.md, §4.5).
 *
 * Réglages → Dépôts : créer un groupe dans le formulaire (nom, membres cochés derrière un filtre
 * qui masque sans décocher), le voir dans la liste et en pastille sur chaque ligne de dépôt ;
 * Git → Actions : la pastille du groupe ajoute une ligne par membre ; la modale de session :
 * pareil ; le formulaire d'un vérificateur propose la couverture par groupe. Un seul `startApp()`,
 * un seul navigateur. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Groupes de dépôts — l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; const ids = {};
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    for (const nom of ['api', 'web', 'legacy']) {
      const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, `remote-${nom}-`)));
      ids[nom] = (await app.api('POST', '/api/repos', { project: `acme/${nom}`, url: r.url })).body.id;
    }
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1100 } });
    await afficherMenusOptionnels(page);
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirDepots = async () => {
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="repos"]').click();
    await page.waitForSelector('#sub-repos.active');
    await page.waitForSelector(`#repoList .repo-row[data-repo="${ids.api}"]`);
  };

  test('créer un groupe : le filtre masque sans décocher, la liste et les lignes de dépôt le montrent', async () => {
    await ouvrirDepots();
    await page.locator('#btnNewGroup').click();
    await page.waitForSelector('#groupForm:not([hidden])');
    await page.locator('#groupForm [name="name"]').fill('backend');
    await page.locator(`#groupRepoList [data-repo="${ids.api}"] .gr-pick`).check();
    await page.locator('#groupRepoFilter').fill('web');
    await page.waitForFunction((id) => document.querySelector(`#groupRepoList [data-repo="${id}"]`).hidden, ids.api);
    assert.equal(await page.locator(`#groupRepoList [data-repo="${ids.api}"] .gr-pick`).isChecked(), true, 'filtrer ne décoche pas');
    await page.locator(`#groupRepoList [data-repo="${ids.web}"] .gr-pick`).check();
    await page.locator('#groupForm button[type="submit"]').click();
    await attendreServeur(async () => (await app.api('GET', '/api/repo-groups')).body.length === 1, 'le groupe est créé');
    const g = (await app.api('GET', '/api/repo-groups')).body[0];
    assert.equal(g.name, 'backend');
    assert.deepEqual(g.repos.map((r) => r.project).sort(), ['acme/api', 'acme/web']);
    await page.waitForSelector('#groupList .groupe-row');
    await page.waitForSelector(`#repoList .repo-row[data-repo="${ids.api}"] .groupe-tag`);
    assert.equal(await page.locator(`#repoList .repo-row[data-repo="${ids.legacy}"] .groupe-tag`).count(), 0, 'legacy n’en est pas');
  });

  test('Git → Actions : la pastille du groupe ajoute une ligne par membre, une fois', async () => {
    await page.locator('nav button[data-tab="git"]').click();
    await page.locator('#tab-git .subnav [data-gsub="actions"]').click();
    await page.waitForSelector('#gitGroupChips [data-groupe-chip]');
    await page.locator('#gitGroupChips [data-groupe-chip]').click();
    await page.waitForFunction(() => document.querySelectorAll('#gitTargetRows .target-row').length === 2);
    const depots = await page.$$eval('#gitTargetRows .target-row .git-repo', (els) => els.map((e) => Number(e.value)).sort());
    assert.deepEqual(depots, [ids.api, ids.web].sort());
    await page.locator('#gitGroupChips [data-groupe-chip]').click();
    await page.waitForSelector('#toasts .toast');
    assert.equal(await page.locator('#gitTargetRows .target-row').count(), 2, 'déjà là : rien n’est ajouté deux fois');
  });

  test('la modale de session : la pastille remplit les projets du groupe', async () => {
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskGroupChips [data-groupe-chip]');
    await page.locator('#taskGroupChips [data-groupe-chip]').click();
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);
    const depots = await page.$$eval('#targetRows .target-row .t-repo', (els) => els.map((e) => Number(e.value)).sort());
    assert.deepEqual(depots, [ids.api, ids.web].sort());
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  });

  test('le formulaire d’un vérificateur propose la couverture par groupe', async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="verifiers"]').click();
    await page.waitForSelector('#sub-verifiers.active');
    await page.locator('#btnNewVerifier').click();
    await page.waitForSelector('#verifierGroupBox .vg-pick');
    await page.locator('#verifierForm [name="name"]').fill('integ');
    await page.locator('#verifierCommandList .vc-cmd').first().fill('true');
    await page.locator('#verifierGroupBox .vg-pick').check();
    await page.locator('#verifierForm button[type="submit"]').click();
    await attendreServeur(async () => (await app.api('GET', '/api/verifiers')).body.some((v) => v.name === 'integ'), 'le vérificateur est créé');
    const v = (await app.api('GET', '/api/verifiers')).body.find((x) => x.name === 'integ');
    assert.deepEqual(v.groups.map((g) => g.name), ['backend']);
    assert.equal(v.covered.length, 2, 'les deux membres, par le groupe');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
