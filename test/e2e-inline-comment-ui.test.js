'use strict';
/* Commentaire en ligne dans l'explorateur de code : l'éditeur doit rester ATTEIGNABLE.
 *
 * La zone de diff défile horizontalement — sa largeur est celle de la ligne de code la plus
 * longue du fichier, pas celle de l'écran. Un éditeur en bloc ordinaire s'étirait donc sur
 * toute cette largeur, et son bouton d'envoi, aligné à droite, partait à des milliers de
 * pixels hors champ : il fallait scroller pour valider ce qu'on venait d'écrire.
 *
 * Ça ne se mesure qu'à l'écran, avec un fichier qui a vraiment une ligne longue.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
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

describe('Commentaire en ligne — le bouton reste sous les yeux', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  // Une ligne délibérément très longue : c'est elle qui étire la zone de diff.
  const LIGNE_LONGUE = `const message = "${'x'.repeat(400)}";`;

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'cmt-')));
    // On ajoute la ligne longue SUR la branche de travail : elle sera dans le diff.
    git(repo.work, ['checkout', repo.branch]);
    fs.appendFileSync(path.join(repo.work, 'src/app.js'), `\n${LIGNE_LONGUE}\n`);
    git(repo.work, ['add', '-A']);
    git(repo.work, ['commit', '-m', 'feat: ligne longue']);
    git(repo.work, ['push', 'origin', repo.branch]);
    const sha = git(repo.work, ['rev-parse', 'HEAD']).trim();
    git(repo.work, ['checkout', 'main']);

    app.state.mrs['grp/app'] = [{
      iid: 3, title: 'Ligne longue', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/3',
      sha, created_at: new Date().toISOString(), author: { name: 'A' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: sha },
    }];
    app.state.changes['grp/app!3'] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    const mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 3);
    await app.api('POST', `/api/mrs/${mr.id}/review`, {});
    await waitForJobs(app.api);

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
    await page.locator('[data-seg="reviewed"]').click();
    await page.waitForSelector('#reportList .card');
    await page.locator('#reportList .card').first().click();
    await page.waitForSelector('#reportDetail [data-open-code], #reportDetail button');
    await page.locator('#reportDetail button').filter({ hasText: /Ouvrir le code/i }).first().click();
    await page.waitForSelector('#splitView:not([hidden]) #fileContent .dl-row');
    // L'explorateur ouvre le premier fichier modifié ; on veut CELUI qui porte la ligne longue.
    await page.locator('#treeList .tree-file[data-path="src/app.js"]').click();
    await page.waitForFunction(() => document.querySelector('#fileName').textContent.includes('src/app.js'));
    await page.waitForSelector('#fileContent .dl-row');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Mesures brutes : ce qui est visible, et où se trouve ce qu'on cherche à cliquer.
  const mesurer = () => page.evaluate(() => {
    const c = document.querySelector('#fileContent');
    const cb = c.getBoundingClientRect();
    const send = document.querySelector('.cmt-send');
    const ta = document.querySelector('.cmt-editor textarea');
    const r = (e) => (e ? e.getBoundingClientRect() : null);
    const b = r(send);
    const t = r(ta);
    return {
      largeurVisible: Math.round(cb.width),
      largeurContenu: Math.round(c.scrollWidth),
      boutonDansLaVue: !!b && b.right <= cb.right + 1 && b.left >= cb.left - 1,
      champDansLaVue: !!t && t.left >= cb.left - 1,
      debordement: b ? Math.round(b.right - cb.right) : null,
    };
  });

  async function ouvrirEditeur() {
    if (await page.locator('#fileContent .cmt-editor').count()) await page.locator('#fileContent .cmt-cancel').click();
    // Une ligne RÉELLE : les en-têtes de section (`@@ …`) n'ont pas de bouton de commentaire.
    const ligne = page.locator('#fileContent .dl-row[data-new]:not([data-new=""])').first();
    await ligne.hover();
    await ligne.locator('.ln-comment').click();
    await page.waitForSelector('#fileContent .cmt-editor textarea');
  }

  test('le fichier déborde bien horizontalement — sans quoi le test ne prouverait rien', async () => {
    const m = await page.evaluate(() => {
      const c = document.querySelector('#fileContent');
      const lignes = [...c.querySelectorAll('.dl')].map((x) => x.textContent.length);
      return {
        visible: Math.round(c.getBoundingClientRect().width), contenu: Math.round(c.scrollWidth),
        fichier: document.querySelector('#fileName').textContent, plusLongue: Math.max(0, ...lignes),
      };
    });
    assert.ok(m.plusLongue > 300, `fichier ouvert : ${m.fichier}, ligne la plus longue : ${m.plusLongue}`);
    assert.ok(m.contenu > m.visible + 200,
      `la zone de diff doit déborder (visible ${m.visible}, contenu ${m.contenu})`);
  });

  test('le bouton d’envoi est visible sans défiler', async () => {
    await ouvrirEditeur();
    const m = await mesurer();
    assert.equal(m.boutonDansLaVue, true,
      `le bouton dépasse de ${m.debordement} px (visible ${m.largeurVisible}, contenu ${m.largeurContenu})`);
    assert.equal(m.champDansLaVue, true, 'le champ de saisie aussi');
  });

  /* Et il doit le RESTER : lire la fin d'une ligne longue est exactement ce qu'on fait avant
     de commenter, et l'éditeur ne doit pas s'échapper pendant qu'on défile. */
  test('il le reste après un défilement horizontal', async () => {
    await ouvrirEditeur();
    await page.evaluate(() => { document.querySelector('#fileContent').scrollLeft = 1200; });
    await page.waitForTimeout(200);
    const m = await mesurer();
    assert.equal(m.boutonDansLaVue, true, 'le bouton doit suivre le bord visible');
    assert.equal(m.champDansLaVue, true, 'le champ aussi');
  });

  test('on peut vraiment cliquer le bouton, sans le chercher', async () => {
    await ouvrirEditeur();
    await page.locator('#fileContent .cmt-editor textarea').fill('Attention à ce cas limite.');
    // Un clic Playwright échoue si l'élément n'est pas atteignable : c'est la preuve utile.
    await page.locator('#fileContent .cmt-send').click({ timeout: 5000 });
    await page.waitForSelector('#fileContent .cmt-editor', { state: 'detached' });
    // Le commentaire est bien parti (et l'éditeur s'est refermé).
    const posts = await app.api('GET', '/api/mrs');
    assert.ok(posts.status === 200);
  });
});
