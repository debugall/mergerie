'use strict';
/* « OUVRIR LE CODE » : LE RAPPORT MÈNE AU CODE.
 *
 * Dans la visionneuse, chaque `fichier:ligne` du rapport qui désigne un fichier de la merge
 * request est un lien, et la puce du constat qui le porte aussi : un clic ouvre le fichier à
 * droite, le sélectionne dans l'arbre (dossiers dépliés) et centre la ligne. Un chemin inconnu
 * reste du texte. Le rapport est écrit ici à la main : la review tourne en dry-run, et ce
 * qu'elle cite varierait d'une passe à l'autre.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

const RAPPORT = `# Revue de code — !31 Ajoute b

## Points relevés
- **[major]** \`src/app.js:2\` — exporter b explicitement.
- **[minor]** \`migration.sql:1\` — pas d'index sur la nouvelle colonne.
- **[info]** \`README.md:1\` — mentionner b dans la doc.
- **[info]** \`inconnu.js:3\` — un fichier qui n'est pas dans la merge request.

## Note globale
**7/10**
`;

describe('Visionneuse — le rapport mène au code', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let mrId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 31, title: 'Ajoute b', state: 'opened', source_branch: depot.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/31',
      sha: depot.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: depot.mainSha, start_sha: depot.mainSha, head_sha: depot.branchSha },
    }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;
    await app.api('POST', `/api/mrs/${mrId}/review`);
    for (let i = 0; ; i += 1) {
      const d = (await app.api('GET', `/api/mrs/${mrId}`)).body;
      if (d.review && d.review.md) break;
      if (i > 600) throw new Error('la review ne se termine pas');
      await new Promise((r) => setTimeout(r, 100));
    }
    // Après `startApp()` : la base est celle du test.
    const db = require('../src/db');
    fs.writeFileSync(db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(mrId).md_path, RAPPORT);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const fichierOuvert = (chemin) => page.waitForFunction((c) => document.querySelector('#fileName').textContent === c
    && (document.querySelector('#treeList .tree-file.active') || {}).dataset?.path === c, chemin, { timeout: ATTENTE });

  test('un fichier:ligne du rapport ouvre le fichier, le sélectionne dans l’arbre et centre la ligne', async () => {
    await page.goto(app.base);
    await page.click('nav button[data-tab="review"]');
    await page.click('[data-seg="reviewed"]');
    await page.click(`#reportList .card[data-id="${mrId}"]`);
    await page.click('#aSplit');
    await page.waitForSelector('#splitView:not([hidden]) #splitMd .md-ref', { timeout: ATTENTE });

    const refs = await page.$$eval('#splitMd .md-ref', (els) => els.map((e) => [e.textContent, e.dataset.refPath, e.dataset.refLine]));
    assert.deepEqual(refs, [
      ['src/app.js:2', 'src/app.js', '2'],
      ['migration.sql:1', 'db/migration.sql', '1'],     // un suffixe qui ne désigne qu'un fichier
      ['README.md:1', 'README.md', '1'],
    ], 'un chemin hors de la merge request reste du texte');

    // Le dossier de la migration replié à la main : le clic le rouvre.
    await page.waitForSelector('#treeList details.tree-folder[data-dir="db"]');
    await page.locator('#treeList details.tree-folder[data-dir="db"]').evaluate((d) => { d.open = false; });

    // Un clic sur la PUCE du constat, hors du code, suffit.
    await page.locator('#splitMd li', { hasText: 'pas d\'index' }).click({ position: { x: 4, y: 4 } });
    await fichierOuvert('db/migration.sql');
    assert.equal(await page.locator('#treeList details.tree-folder[data-dir="db"]').evaluate((d) => d.open), true, 'son dossier est déplié');
    assert.equal(await page.locator('#treeList .tree-file.active').isVisible(), true);
    await page.waitForSelector('#fileContent .dl-row[data-new="1"]');

    await page.locator('#splitMd .md-ref', { hasText: 'src/app.js:2' }).click();
    await fichierOuvert('src/app.js');
    const visible = await page.locator('#fileContent .dl-row[data-new="2"]').evaluate((r) => {
      const a = r.getBoundingClientRect(); const b = document.querySelector('#fileContent').getBoundingClientRect();
      return a.top >= b.top && a.bottom <= b.bottom;
    });
    assert.equal(visible, true, 'la ligne citée est à l’écran');

    // Un fichier que la merge request ne modifie pas s'ouvre aussi, en entier.
    await page.locator('#splitMd .md-ref', { hasText: 'README.md:1' }).click();
    await fichierOuvert('README.md');
    await page.waitForSelector('#fileContent pre.code');
    assert.deepEqual(erreurs, []);
  });
});
