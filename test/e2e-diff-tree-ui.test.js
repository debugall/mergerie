'use strict';
/* L'ARBRE DE L'EXPLORATEUR DE CODE GARDE CE QU'ON A OUVERT.
 *
 * L'arbre est reconstruit à chaque clic sur un fichier — il faut bien y déplacer la ligne
 * active. Tant que l'état déplié/replié se recalculait à partir de la seule règle par défaut
 * (« ouvert si le dossier porte un changement »), un dossier ouvert à la main se refermait au
 * moment précis où on ouvrait l'un de ses fichiers : on cliquait, et l'arbre se dérobait.
 *
 * Ça ne se voit que dans un navigateur, sur un dossier SANS changement — les autres sont
 * ouverts par défaut et masquent le défaut.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs, git } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Explorateur de code — l’arbre ne se referme pas sous les doigts', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  const ouvert = (dir) => page.locator(`#treeList details.tree-folder[data-dir="${dir}"]`).evaluate((d) => d.open);

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'arbre-')));
    /* Un dossier que la MR NE TOUCHE PAS : c'est le seul cas qui expose le défaut, puisqu'un
       dossier porteur d'un changement est déplié d'office à chaque rendu. Il est donc posé sur
       `main` PUIS ramené dans la branche : présent dans l'arbre, absent du diff. */
    git(repo.work, ['checkout', 'main']);
    fs.mkdirSync(path.join(repo.work, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'docs/notes.md'), '# notes\n\nrien de spécial\n');
    git(repo.work, ['add', '-A']);
    git(repo.work, ['commit', '-m', 'docs: notes']);
    git(repo.work, ['push', 'origin', 'main']);
    const baseSha = git(repo.work, ['rev-parse', 'HEAD']).trim();
    git(repo.work, ['checkout', repo.branch]);
    git(repo.work, ['merge', 'main', '-m', 'merge main']);
    git(repo.work, ['push', 'origin', repo.branch]);
    const sha = git(repo.work, ['rev-parse', 'HEAD']).trim();
    git(repo.work, ['checkout', 'main']);

    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Ajoute b', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
      sha, created_at: new Date().toISOString(), author: { name: 'A' },
      diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: sha },
    }];
    // Seul `src/app.js` est déclaré modifié : `docs/` reste un dossier sans changement.
    app.state.changes['grp/app!7'] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    const mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 7);
    await app.api('POST', `/api/mrs/${mr.id}/review`, {});
    await waitForJobs(app.api);

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
    await page.locator('[data-seg="reviewed"]').click();
    await page.waitForSelector('#reportList .card');
    await page.locator('#reportList .card').first().click();
    await page.locator('#reportDetail button').filter({ hasText: /Ouvrir le code/i }).first().click();
    await page.waitForSelector('#splitView:not([hidden]) #fileContent .dl-row');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('les trois panneaux se masquent chacun, le code aussi, et le dernier reste', async () => {
    const corps = page.locator('#splitView .code-body');
    const largeur = async (sel) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().width);
    const rapportAvant = await largeur('#reportPane');
    // Masquer le code : le rapport gagne en largeur, le fichier disparaît.
    await page.locator('#codeToggle').click();
    await page.waitForSelector('#splitView .code-body.no-code');
    assert.equal(await page.locator('#filePane').isVisible(), false);
    assert.ok(await largeur('#reportPane') > rapportAvant, 'le rapport prend la place du code');
    assert.ok(await page.locator('#codeToggle').evaluate((b) => b.classList.contains('off')));
    // Masquer aussi l'arbre : le rapport seul, toute la largeur.
    await page.locator('#treeToggle').click();
    await page.waitForSelector('#splitView .code-body.no-code.no-tree');
    assert.equal(await page.locator('#treePane').isVisible(), false);
    // Le dernier panneau refuse de partir : le rapport reste, le bouton ne bascule pas.
    await page.locator('#reportToggle').click();
    assert.equal(await corps.evaluate((el) => el.classList.contains('no-report')), false);
    assert.equal(await page.locator('#reportPane').isVisible(), true);
    // Retour : tout se réaffiche.
    await page.locator('#treeToggle').click();
    await page.locator('#codeToggle').click();
    await page.waitForSelector('#splitView .code-body:not(.no-code):not(.no-tree)');
    assert.equal(await page.locator('#filePane').isVisible(), true);
  });

  test('un dossier ouvert à la main le reste quand on clique un de ses fichiers', async () => {
    await page.waitForSelector('#treeList details.tree-folder[data-dir="docs"]');
    assert.equal(await ouvert('docs'), false, 'sans changement, il est replié au départ — c’est la règle voulue');

    await page.locator('#treeList details.tree-folder[data-dir="docs"] > summary').click();
    assert.equal(await ouvert('docs'), true);

    await page.locator('#treeList .tree-file[data-path="docs/notes.md"]').click();
    await page.waitForFunction(() => document.querySelector('#fileName').textContent.includes('docs/notes.md'));
    assert.equal(await ouvert('docs'), true,
      'on vient d’ouvrir un fichier DE ce dossier : le refermer au même instant dérobe l’arbre');

    // Et il tient au fichier suivant, ailleurs dans l'arbre.
    await page.locator('#treeList .tree-file[data-path="src/app.js"]').click();
    await page.waitForFunction(() => document.querySelector('#fileName').textContent.includes('src/app.js'));
    assert.equal(await ouvert('docs'), true, 'la mémoire vaut pour tous les rendus, pas seulement le premier');
  });

  test('un dossier replié à la main le reste aussi', async () => {
    assert.equal(await ouvert('src'), true, 'il porte le changement : déplié par défaut');
    await page.locator('#treeList details.tree-folder[data-dir="src"] > summary').click();
    assert.equal(await ouvert('src'), false);

    await page.locator('#treeList .tree-file[data-path="docs/notes.md"]').click();
    await page.waitForFunction(() => document.querySelector('#fileName').textContent.includes('docs/notes.md'));
    assert.equal(await ouvert('src'), false,
      'la règle par défaut ne doit pas revenir rouvrir ce qu’on a délibérément fermé');
  });

  /* La mémoire est rangée dans l'état du viewer : elle ne doit pas suivre d'une MR à l'autre,
     où les mêmes noms de dossiers ne parlent pas du même code. */
  test('elle ne survit pas à l’ouverture d’un autre diff', async () => {
    await page.locator('#splitClose').click();
    await page.locator('#reportList .card').first().click();
    await page.locator('#reportDetail button').filter({ hasText: /Ouvrir le code/i }).first().click();
    await page.waitForSelector('#splitView:not([hidden]) #fileContent .dl-row');
    assert.equal(await ouvert('src'), true, 'on repart de la règle par défaut, pas de l’humeur d’une session précédente');
    assert.equal(await ouvert('docs'), false);
  });
});
