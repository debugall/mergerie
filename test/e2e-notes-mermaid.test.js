'use strict';
/* Les diagrammes Mermaid d'une page de notes, dans un VRAI navigateur.
 *
 * Rien ici ne se prouve sans navigateur : le rendu est fait par une bibliothèque de 5,4 Mo qui
 * fabrique du SVG à l'exécution. Ce que ces tests tiennent :
 *
 *   1. les trois formes que le documentaliste produit — `flowchart` (qui appelle qui),
 *      `erDiagram` (le schéma d'une base), `sequenceDiagram` — donnent bien un SVG ;
 *   2. un diagramme FAUTIF ne casse rien : sa source reste lisible, l'erreur est dite, et le
 *      reste de la page s'affiche. Une note est écrite à la main ou par un agent, la faute de
 *      frappe est le cas normal, pas l'exception ;
 *   3. une page SANS diagramme ne télécharge pas les 5,4 Mo. C'est toute la raison du
 *      chargement à la demande : si ce test tombe, la bibliothèque est redevenue un coût fixe
 *      pour tout le monde ;
 *   4. le thème change les couleurs du SVG, qui sont cuites au rendu — un diagramme sombre
 *      laissé sur fond clair est illisible.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

const FLOW = '```mermaid\nflowchart LR\n  api[api-core] -->|REST| bil[billing]\n```';
const ER = '```mermaid\nerDiagram\n  CLIENT ||--o{ COMMANDE : passe\n  CLIENT {\n    int id PK\n    string email\n  }\n```';
const SEQ = '```mermaid\nsequenceDiagram\n  api->>billing: POST /invoice\n  billing-->>api: 201\n```';

describe('Notes — les diagrammes Mermaid', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  let demoAgents;
  const vendorDemande = [];

  /* Ouvre une page de notes par son titre et attend que l'écran soit VRAIMENT sur elle :
     la liste se réaffiche après la création, et cliquer trop tôt ouvre la précédente. */
  async function ouvrir(titre, contenu) {
    const p = (await app.api('POST', '/api/notes', { title: titre })).body;
    await app.api('PUT', `/api/notes/${p.id}`, { content: contenu });
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    const ligne = page.locator('#pageList .note-item', { hasText: titre });
    await ligne.waitFor();
    await ligne.click();
    await page.waitForFunction((id) => typeof NOTES !== 'undefined' && NOTES.page && NOTES.page.id === id, p.id);
    return p.id;
  }

  before(async () => {
    app = await startApp();
    /* APRÈS startApp : `src/paths.js` lit MERGERIE_DATA_DIR au chargement, et un require en
       tête de fichier ferait travailler la base de l'instance réelle. */
    // eslint-disable-next-line global-require
    demoAgents = require('../src/demo-agents');
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/groupe/api-core.git', project: 'groupe/api-core' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/groupe/webapp-front.git', project: 'groupe/webapp-front' });
    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1440, height: 900 } });
    // C'est la preuve du chargement à la demande : on note CHAQUE demande du fichier vendoré.
    page.on('request', (r) => { if (r.url().includes('/vendor/mermaid')) vendorDemande.push(r.url()); });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('une page sans diagramme ne télécharge pas la bibliothèque', async () => {
    await ouvrir('Page sans schéma', '# Titre\n\nDu texte, et un bloc de code :\n\n```js\nconst a = 1;\n```');
    // On attend que le rendu ait bien eu lieu : sans cette attente, l'absence de requête ne
    // prouverait rien — elle dirait seulement qu'on a regardé trop tôt.
    await page.waitForSelector('#pagePreview h1');
    assert.equal(await page.locator('#pagePreview [data-mermaid]').count(), 0,
      'un bloc ```js n’est pas un diagramme');
    assert.equal(await page.locator('#pagePreview pre').count(), 1, 'il reste un bloc de code ordinaire');
    assert.deepEqual(vendorDemande, [], 'les 5,4 Mo ne doivent pas partir pour une page sans diagramme');
  });

  test('les trois formes du documentaliste donnent un SVG', async () => {
    await ouvrir('Carte des services', `## Qui appelle qui\n\n${FLOW}\n\n## Le schéma\n\n${ER}\n\n## Un appel\n\n${SEQ}`);
    await page.waitForFunction(() => document.querySelectorAll('#pagePreview .mermaid-svg svg').length === 3);

    /* On identifie chaque diagramme par CE QU'IL DIT, pas par la classe du <svg> : mermaid en
       pose une pour le flowchart et l'erDiagram, aucune pour le sequenceDiagram. Un libellé
       rendu prouve en plus que le diagramme a été COMPILÉ, pas seulement qu'un SVG existe. */
    const textes = await page.locator('#pagePreview .mermaid-svg').evaluateAll(
      (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')));
    assert.equal(textes.length, 3);
    assert.ok(textes.some((x) => /api-core/.test(x) && /billing/.test(x)), `pas de flowchart : ${textes.join(' | ')}`);
    assert.ok(textes.some((x) => /COMMANDE/.test(x) && /email/.test(x)), `pas d’erDiagram : ${textes.join(' | ')}`);
    assert.ok(textes.some((x) => /POST \/invoice/.test(x)), `pas de sequenceDiagram : ${textes.join(' | ')}`);

    // La source est gardée, mais cachée : c'est elle qui resservira au changement de thème.
    assert.equal(await page.locator('#pagePreview .mermaid-wrap pre').first().isVisible(), false);
    assert.equal(vendorDemande.length, 1, 'la bibliothèque n’est chargée qu’une fois pour la session');
  });

  test('un diagramme fautif garde sa source et n’emporte pas la page', async () => {
    await ouvrir('Page avec une faute', `# Le titre survit\n\n\`\`\`mermaid\nflowchart LR\n  A --> (((\n\`\`\`\n\nEt le texte après aussi.`);
    await page.waitForSelector('#pagePreview .mermaid-wrap.mermaid-ko');
    assert.equal(await page.locator('#pagePreview .mermaid-wrap pre').isVisible(), true,
      'la source doit rester lisible pour qu’on trouve la faute');
    assert.match(await page.locator('#pagePreview .mermaid-err').innerText(), /\S/, 'l’erreur est dite');
    assert.equal(await page.locator('#pagePreview .mermaid-svg').count(), 0);
    // Le reste de la page, lui, est intact — c'est le vrai enjeu.
    assert.equal(await page.locator('#pagePreview h1').innerText(), 'Le titre survit');
    assert.match(await page.locator('#pagePreview').innerText(), /Et le texte après aussi/);
  });

  test('changer de thème refait les diagrammes, dont les couleurs sont cuites dans le SVG', async () => {
    await ouvrir('Carte à deux thèmes', FLOW);
    /* Le thème est POSÉ, jamais supposé : le défaut est « auto », donc il suit celui du système
       — le thème clair de Playwright. Partir de là rendrait le passage au clair invisible. */
    const poser = async (valeur) => {
      await page.evaluate((v) => {
        const sel = document.querySelector('#themeSelect');
        sel.value = v;
        sel.dispatchEvent(new Event('change'));
      }, valeur);
      await page.waitForFunction((v) => document.documentElement.getAttribute('data-theme') === v, valeur);
    };
    const fondsDe = () => page.locator('#pagePreview .mermaid-svg svg').evaluate(
      (svg) => [...svg.querySelectorAll('rect')].map((r) => getComputedStyle(r).fill).join(' '));

    await poser('dark');
    await page.waitForSelector('#pagePreview .mermaid-svg svg');
    const sombre = await fondsDe();
    /* L'identifiant du SVG est unique par rendu : il dit sans ambiguïté que celui qu'on lit est
       le NOUVEAU, là où comparer les couleurs pourrait lire l'ancien encore en place. */
    const idAvant = await page.locator('#pagePreview .mermaid-svg svg').getAttribute('id');

    await poser('light');
    await page.waitForFunction((avant) => {
      const s = document.querySelector('#pagePreview .mermaid-svg svg');
      return s && s.id !== avant;
    }, idAvant);
    assert.notEqual(await fondsDe(), sombre, 'le diagramme doit repartir avec les couleurs du thème');
  });
  /* LE DÉCOR DOIT COMPILER. Le documentaliste dessine maintenant, et le mode démo rejoue ce
     qu'il écrirait : un diagramme fautif dans le décor, c'est la démo qui montre un cadre
     orange à la place du schéma, sur l'écran même qui vend la fonctionnalité. On prend donc sa
     sortie telle quelle et on la fait rendre par la page. */
  test('les diagrammes que produit le documentaliste en démo compilent tous', async () => {
    const md = demoAgents.rapport({ builtin_key: 'librarian', output_kind: 'note_page' }, [], '');
    const blocs = [...md.matchAll(/```mermaid\n[\s\S]*?```/g)].map((m) => m[0]);
    assert.ok(blocs.length >= 2, `le décor doit porter des diagrammes, il en a ${blocs.length}`);

    await ouvrir('Décor du documentaliste', blocs.join('\n\n'));
    await page.waitForFunction(
      (n) => document.querySelectorAll('#pagePreview .mermaid-svg svg').length === n, blocs.length);
    assert.equal(await page.locator('#pagePreview .mermaid-ko').count(), 0,
      'aucun diagramme du décor ne doit tomber en erreur');
  });

});
