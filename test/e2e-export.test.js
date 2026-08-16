'use strict';
/* Export d'une réponse d'agent — HTML, Word, PDF.
 *
 * Deux niveaux, et les deux comptent : le .docx est un ZIP OOXML qu'on ouvre pour vérifier
 * qu'il est valide et qu'il porte bien le contenu (un fichier corrompu ne se voit qu'en
 * l'ouvrant dans Word) ; le bouton, lui, se teste dans un VRAI navigateur, en interceptant
 * le téléchargement — c'est la seule façon de savoir qu'un clic produit un fichier.
 *
 * Chromium vient de la dépendance de développement `playwright` ; la partie navigateur se
 * déclare ignorée s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, waitForJobs } = require('./helpers/app');
const { markdownToDocx } = require('../src/docx');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

// Lecture d'un .docx sans dépendance : `unzip -p` suffit à sortir une entrée du ZIP, et
// s'en servir prouve au passage que l'archive est lisible par un outil tiers.
const dansLeDocx = (fichier, entree) =>
  // `unzip` traite `[` et `]` comme un motif : `[Content_Types].xml` ne matcherait rien.
  execFileSync('unzip', ['-p', fichier, entree.replace(/([[\]*?])/g, '\\$1')], { maxBuffer: 8 * 1024 * 1024 }).toString();

describe('Export d’une réponse — le fichier Word', () => {
  const MD = [
    '# Ce que j’ai fait',
    '',
    'Un paragraphe avec **du gras**, *de l’italique* et `du code`.',
    '',
    '- première puce',
    '- seconde puce',
    '',
    '```js',
    'const a = 1 < 2 && b > "c";',
    '```',
    '',
    '| Fichier | Lignes |',
    '|---|---:|',
    '| `src/app.js` | 12 |',
    '',
    '> une citation',
  ].join('\n');

  let fichier;
  before(() => {
    fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-')), 'r.docx');
    fs.writeFileSync(fichier, markdownToDocx('Session « été » — résumé', MD));
  });

  test('c’est une archive OOXML valide, avec toutes ses parties', async () => {
    // `unzip -t` teste les CRC : un octet de travers et Word refuse d'ouvrir le fichier.
    const test = execFileSync('unzip', ['-t', fichier]).toString();
    assert.match(test, /No errors detected/i, test);
    for (const partie of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']) {
      assert.ok(dansLeDocx(fichier, partie).length > 0, `${partie} doit être présente`);
    }
  });

  test('le contenu du Markdown s’y retrouve, mise en forme comprise', async () => {
    const doc = dansLeDocx(fichier, 'word/document.xml');
    assert.match(doc, /Session « été » — résumé/, 'le titre ouvre le document');
    assert.match(doc, /Ce que j’ai fait/);
    assert.match(doc, /<w:pStyle w:val="Heading1"\/>/, 'un titre Markdown devient un vrai titre Word');
    assert.match(doc, /<w:b\/>[\s\S]{0,80}du gras/, 'le gras est porté par la mise en forme, pas par des astérisques');
    assert.ok(!doc.includes('**du gras**'), 'les astérisques ne doivent pas rester dans le texte');
    assert.match(doc, /<w:tbl>/, 'le tableau devient un tableau Word');
    assert.match(doc, /• /, 'les puces sont rendues');
    assert.match(doc, /MergerieQuote/, 'la citation a son style');
  });

  test('le code est échappé, pas interprété comme du XML', async () => {
    const doc = dansLeDocx(fichier, 'word/document.xml');
    // `<` et `&` bruts casseraient le XML : le fichier ne s'ouvrirait pas du tout.
    assert.match(doc, /const a = 1 &lt; 2 &amp;&amp; b &gt; &quot;c&quot;;/);
  });

  /* Un caractère de contrôle dans une sortie d'agent (échappements ANSI, séparateurs) rend
     le document « illisible » pour Word, sans autre explication. Il doit disparaître. */
  test('un caractère de contrôle ne rend pas le document illisible', () => {
    const f2 = path.join(path.dirname(fichier), 'ctrl.docx');
    fs.writeFileSync(f2, markdownToDocx('ctrl', 'avant\u0007\u0000 après'));
    assert.match(execFileSync('unzip', ['-t', f2]).toString(), /No errors detected/i);
    const doc = dansLeDocx(f2, 'word/document.xml');
    assert.match(doc, /avant après/, 'le texte reste, le caractère de contrôle part');
  });

  // Deux exports du même contenu donnent le même fichier : pas d'horodatage caché.
  test('l’export est reproductible', () => {
    assert.deepEqual(markdownToDocx('t', MD), markdownToDocx('t', MD));
  });
});

describe('Export d’une réponse — le bouton', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  let taskId;

  before(async () => {
    app = await startApp();
    await app.configure();
    // Une session hors dépôt : la plus rapide à mener jusqu'à une réponse d'agent.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-dir-'));
    taskId = (await app.api('POST', '/api/local-tasks', { prompt: 'Range les imports', dirs: [d] })).body.id;
    await app.api('POST', `/api/local-tasks/${taskId}/run`);
    await waitForJobs(app.api);

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await page.goto(app.base);
    await page.locator('[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="local"]').click();
    await page.waitForSelector('#localList .card');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  async function ouvrirReponse() {
    if (await page.locator('#taskMdView').isVisible()) await page.locator('#taskMdClose').click();
    await page.locator('#localList [data-lout], #localList [data-ldirout]').first().click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    await page.locator('#taskMdExport').click();
    await page.waitForSelector('#taskMdExportMenu:not([hidden])');
  }

  test('« Exporter → HTML » télécharge un document autonome', async () => {
    await ouvrirReponse();
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#taskMdExportMenu [data-export="html"]').click(),
    ]);
    assert.match(dl.suggestedFilename(), /\.html$/);
    const contenu = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(contenu, /^<!doctype html>/i);
    assert.match(contenu, /<style>/, 'les styles sont embarqués : le fichier doit se lire seul');
    assert.ok(!/<link |<script /i.test(contenu), 'aucune ressource externe, sinon le document dépend du réseau');
    assert.match(contenu, /PROJ_LOCAL_DRYRUN|<h1>/, 'le contenu de la réponse y est');
  });

  test('« Exporter → Word » télécharge un .docx que Word saura ouvrir', async () => {
    await ouvrirReponse();
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#taskMdExportMenu [data-export="docx"]').click(),
    ]);
    assert.match(dl.suggestedFilename(), /\.docx$/);
    const chemin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'r.docx');
    await dl.saveAs(chemin);
    assert.match(execFileSync('unzip', ['-t', chemin]).toString(), /No errors detected/i);
    assert.ok(dansLeDocx(chemin, 'word/document.xml').includes('<w:body>'));
  });

  /* Le PDF passe par la boîte d'impression du navigateur : rien à télécharger à vérifier,
     mais on peut contrôler ce qui la déclenche — l'iframe d'impression et son contenu. */
  test('« Exporter → PDF » prépare le document et appelle l’impression', async () => {
    await ouvrirReponse();
    await page.locator('#taskMdExportMenu [data-export="pdf"]').click();
    // On attend que l'iframe ait VRAIMENT chargé son document : son existence ne suffit pas.
    await page.waitForFunction(() => {
      const f = document.querySelector('iframe[aria-hidden="true"]');
      return !!(f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerHTML.length > 50);
    });
    const html = await page.evaluate(() =>
      document.querySelector('iframe[aria-hidden="true"]').contentDocument.documentElement.outerHTML);
    assert.match(html, /<style/, 'le document imprimé embarque ses styles');
    assert.match(html, /Mergerie/, '…et porte son en-tête');
    assert.ok(!/<script /i.test(html), 'rien d’exécutable dans un document destiné à l’impression');
    // Le message qui dit quoi faire de la boîte d'impression : sans lui, on cherche le fichier.
    await page.locator('#toasts .toast-msg', { hasText: 'PDF' }).first().waitFor({ state: 'visible' });
  });
});
