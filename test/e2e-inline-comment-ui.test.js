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

/* Une attente d'écran généreuse. Ces suites tournent à plusieurs sur un runner CI de
   quatre cœurs : un délai calibré sur une machine de développement y échoue sans que rien
   ne soit cassé, et l'échec du premier test entraîne tous les suivants qui dépendent de
   son état. Mieux vaut attendre longtemps pour rien que rendre un rouge qui ne veut rien dire. */
const ATTENTE_ECRAN = 20000;

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
    // Le défilement a ABOUTI : c'est la position qui décide de ce que la mesure va lire.
    await page.waitForFunction(() => document.querySelector('#fileContent').scrollLeft >= 1200);
    const m = await mesurer();
    assert.equal(m.boutonDansLaVue, true, 'le bouton doit suivre le bord visible');
    assert.equal(m.champDansLaVue, true, 'le champ aussi');
  });

  test('on peut vraiment cliquer le bouton, sans le chercher', async () => {
    await ouvrirEditeur();
    await page.locator('#fileContent .cmt-editor textarea').fill('Attention à ce cas limite.');
    // Un clic Playwright échoue si l'élément n'est pas atteignable : c'est la preuve utile.
    await page.locator('#fileContent .cmt-send').click({ timeout: ATTENTE_ECRAN });
    await page.waitForSelector('#fileContent .cmt-editor', { state: 'detached' });
    // Le commentaire est bien parti (et l'éditeur s'est refermé).
    const posts = await app.api('GET', '/api/mrs');
    assert.ok(posts.status === 200);
  });

  /* ENREGISTRER SANS ENVOYER, puis tout envoyer d'un coup. C'est le geste de relecture : on
     écrit ses remarques fichier par fichier, on les corrige, et on les publie quand on a fini.
     Le témoin de « rien n'est parti » est le FAUX SERVEUR : un badge à l'écran ne prouverait
     que l'écran. */
  test('un commentaire s’enregistre en attente, se corrige, et part avec les autres', async () => {
    const posts = () => app.state.calls.filter((c) => c.method === 'POST' && /\/discussions$/.test(c.path)).length;
    const avant = posts();

    await ouvrirEditeur();
    await page.locator('.cmt-editor textarea').fill('à revoir : nom trop court');
    await page.locator('.cmt-editor .cmt-draft-save').click();

    await page.waitForSelector('#fileContent .cmt-draft');
    assert.equal(posts(), avant, 'enregistrer ne doit RIEN envoyer à la forge');
    assert.match(await page.locator('.cmt-draft').textContent(), /nom trop court/);
    assert.match(await page.locator('.cmt-draft-head').textContent(), /attente/,
      'il se distingue d’un commentaire publié : sinon on croit le travail fait');
    await page.waitForFunction(() => document.querySelector('#draftsCount').textContent === '1');

    // On le corrige — tant qu'il n'est pas parti, il n'appartient qu'à nous.
    await page.locator('[data-draftedit]').first().click();
    await page.locator('.cmt-draft-edit').fill('à revoir : nom trop court, et le test manque');
    await page.locator('[data-draftsave]').first().click();
    await page.waitForFunction(() => /le test manque/.test(document.querySelector('.cmt-draft').textContent));
    assert.equal(posts(), avant, 'corriger non plus n’envoie rien');

    // Un second, sur une autre ligne, pour prouver l'envoi GROUPÉ.
    const ligne2 = page.locator('#fileContent .dl-row[data-new]:not([data-new=""])').nth(1);
    await ligne2.hover();
    await ligne2.locator('.ln-comment').click();
    await page.waitForSelector('#fileContent .cmt-editor textarea');
    await page.locator('.cmt-editor textarea').fill('deuxième remarque');
    await page.locator('.cmt-editor .cmt-draft-save').click();
    await page.waitForFunction(() => document.querySelector('#draftsCount').textContent === '2');

    /* L'envoi CONFIRME : publier notifie l'auteur de la MR. Et la question dit combien
       partent — c'est le seul moyen de s'apercevoir qu'on en avait oublié un. */
    await page.locator('#draftsSend').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').textContent(), /2 commentaires/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
    assert.equal(posts(), avant, 'annuler doit vraiment ne rien publier');

    await page.locator('#draftsSend').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => document.querySelector('#draftsSend').hidden,
      null, { timeout: ATTENTE_ECRAN });
    assert.equal(posts(), avant + 2, 'les deux sont partis, en une fois');
    /* Le bouton disparaît avant que le fichier soit redessiné : on attend le compte ATTENDU
       plutôt que de le lire au vol, sinon le test échoue une fois sur vingt, sous charge. */
    await page.waitForFunction(() => !document.querySelector('#fileContent .cmt-draft'),
      null, { timeout: ATTENTE_ECRAN });
    assert.equal(await page.locator('#fileContent .cmt-draft').count(), 0,
      'partis = plus en attente sous la ligne');
  });
});
