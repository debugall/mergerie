'use strict';
/* Jira → Surveillés : lire le ticket sans quitter Mergerie.
 *
 * Le détail est le MÊME panneau que sous « Mes tickets », avec les mêmes actions. Ce qui se
 * teste ici n'est donc pas son contenu — déjà couvert — mais qu'il s'affiche au bon endroit,
 * qu'il ne perturbe pas les contrôles de la carte (retirer, modifier la raison), et que les
 * actions du détail rechargent le panneau où l'on est, pas l'autre.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
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

describe('Jira · Surveillés — le ticket s’ouvre à droite', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
    for (const [cle, titre] of [['WATCH-1', 'Migrer les logs'], ['WATCH-2', 'Refondre le panier']]) {
      app.state.jiraIssues[cle] = {
        key: cle,
        fields: {
          summary: titre,
          status: etat('À faire', 'new'),
          description: `Description de ${cle} — ce que le ticket demande.`,
          issuetype: { name: 'Tâche' },
        },
      };
    }
    // Le faux Jira est servi par le même serveur mock que GitLab (cf. helpers/app).
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira' });
    await app.api('POST', '/api/jira/watch', { key: 'WATCH-1', note: 'bloque la facturation' });
    await app.api('POST', '/api/jira/watch', { key: 'WATCH-2' });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  async function ouvrirSurveilles() {
    await page.reload();
    await page.locator('[data-tab="jira"]').click();
    await page.locator('#tab-jira .subnav [data-jsub="watch"]').click();
    await page.waitForSelector('#jiraWatchList .jira-item');
  }

  test('sélectionner un ticket affiche son contenu à droite', async () => {
    await ouvrirSurveilles();
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'rien n’est affiché tant qu’on n’a rien choisi');

    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    const detail = await page.locator('#jiraWatchDetail').textContent();
    assert.match(detail, /WATCH-1/);
    assert.match(detail, /Migrer les logs/);
    assert.match(detail, /ce que le ticket demande/, 'la description est là, pas seulement le titre');

    // La carte choisie se distingue : sans repère, on ne sait plus ce qu'on lit.
    const actives = await page.$$eval('#jiraWatchList .jira-item.active', (n) => n.map((x) => x.dataset.jirawatchopen));
    assert.deepEqual(actives, ['WATCH-1']);
  });

  test('choisir un autre ticket remplace le contenu affiché', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    await page.locator('#jiraWatchList .jira-item').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#jiraWatchDetail').textContent.includes('WATCH-2'));
    const detail = await page.locator('#jiraWatchDetail').textContent();
    assert.match(detail, /Refondre le panier/);
    assert.ok(!detail.includes('Migrer les logs'), 'le ticket précédent ne doit pas rester affiché');
    const actives = await page.$$eval('#jiraWatchList .jira-item.active', (n) => n.map((x) => x.dataset.jirawatchopen));
    assert.deepEqual(actives, ['WATCH-2'], 'un seul ticket sélectionné à la fois');
  });

  /* La carte porte ses propres contrôles. Cliquer dessus ne doit pas se transformer en
     sélection : ouvrir le formulaire de raison chargerait alors le ticket par surprise. */
  test('les contrôles de la carte gardent leur effet', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList [data-jiranote]').first().click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#jiraWatchList .jira-note-form:not([hidden])').count(), 1,
      'le crayon ouvre bien le champ de raison');
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'et ne charge pas le ticket au passage');

    /* Le champ lui-même est DANS la carte : cliquer dedans pour corriger sa raison ne doit
       pas déclencher le chargement du ticket. C'est ce que l'exclusion des contrôles protège. */
    await page.locator('#jiraWatchList .jira-note-input').first().click();
    await page.keyboard.type(' (précisé)');
    await page.waitForTimeout(300);
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'écrire dans la raison n’ouvre pas le ticket');
    assert.equal(await page.locator('#jiraWatchList .jira-item.active').count(), 0,
      '…et ne sélectionne rien');
  });

  test('retirer le ticket affiché vide le panneau de droite', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    await page.locator('#jiraWatchList [data-jiraunwatch]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#jiraWatchList .jira-item').length === 1);
    assert.equal((await page.locator('#jiraWatchDetail').textContent()).trim(), '',
      'garder à l’écran le détail d’un ticket qu’on ne suit plus n’aurait pas de sens');
  });

  async function poserTicketTechnique(description) {
    app.state.jiraIssues['WATCH-3'] = {
      key: 'WATCH-3',
      fields: {
        summary: 'Gabarits de notification',
        status: { name: 'À faire', statusCategory: { key: 'new' } },
        issuetype: { name: 'Tâche' },
        description,
      },
    };
    await app.api('DELETE', '/api/jira/watch/WATCH-3');
    await app.api('POST', '/api/jira/watch', { key: 'WATCH-3' });
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList .jira-item', { hasText: 'Gabarits' }).click();
  }

  /* La raison de surveiller tient rarement sur une ligne — « bloque la migration de la
     facturation — prévenir Sofia dès que c'est en revue » dépassait déjà du champ. Elle se
     saisit donc dans un `textarea`, ce qui change les touches : Entrée y passe à la ligne,
     Ctrl/Cmd + Entrée enregistre. Et ce qu'on écrit sur deux lignes doit se RELIRE sur deux
     lignes : les écraser à l'affichage rendrait le champ trompeur. */
  test('la raison se saisit sur plusieurs lignes, et se relit telle quelle', async () => {
    await ouvrirSurveilles();
    for (const sel of ['#jiraWatchNote', '#jiraWatchList .jira-note-input']) {
      assert.equal(await page.locator(sel).first().evaluate((e) => e.tagName), 'TEXTAREA',
        `${sel} : un champ d’une ligne tronquait la raison dès la première phrase utile`);
    }
    // Le champ de la carte occupe toute sa largeur : les boutons sont passés dessous.
    await page.locator('#jiraWatchList [data-jiranote]').first().click();
    await page.waitForSelector('#jiraWatchList .jira-note-form:not([hidden])');
    const geo = await page.locator('#jiraWatchList .jira-note-input').first().evaluate((e) => ({
      champ: e.getBoundingClientRect().width,
      carte: e.closest('.jira-item').getBoundingClientRect().width,
      lignes: e.getBoundingClientRect().height,
    }));
    assert.ok(geo.champ > geo.carte * 0.8, `le champ prend la carte, vu ${Math.round(geo.champ)}/${Math.round(geo.carte)} px`);
    assert.ok(geo.lignes > 40, 'et plus d’une ligne de haut');

    const champ = page.locator('#jiraWatchList .jira-note-input').first();
    await champ.fill('');
    await champ.type('première raison');
    await champ.press('Enter');            // sur un textarea, Entrée passe à la ligne…
    await champ.type('seconde ligne');
    assert.match(await champ.inputValue(), /première raison\nseconde ligne/,
      'Entrée ne doit pas valider : c’est pour cela qu’on a agrandi le champ');

    await champ.press('ControlOrMeta+Enter');   // …et c'est Ctrl/Cmd + Entrée qui enregistre
    await page.waitForSelector('#jiraWatchList .jira-note-form[hidden]', { state: 'attached' });

    const enBase = (await app.api('GET', '/api/jira/watch')).body.watched.find((w) => w.note);
    assert.match(enBase.note, /première raison\nseconde ligne/, 'le saut de ligne arrive jusqu’au serveur');
    assert.match(await page.locator('#jiraWatchList .jira-watch-note').first().evaluate(
      (e) => getComputedStyle(e).whiteSpace,
    ), /pre-line|pre-wrap/, 'et il est respecté à l’affichage');
  });

  test('Échap referme le champ sans rien enregistrer', async () => {
    await ouvrirSurveilles();
    const avant = (await app.api('GET', '/api/jira/watch')).body.watched.map((w) => w.note || '');
    await page.locator('#jiraWatchList [data-jiranote]').first().click();
    const champ = page.locator('#jiraWatchList .jira-note-input').first();
    await champ.fill('saisie abandonnée');
    await champ.press('Escape');
    await page.waitForSelector('#jiraWatchList .jira-note-form[hidden]', { state: 'attached' });
    assert.deepEqual((await app.api('GET', '/api/jira/watch')).body.watched.map((w) => w.note || ''), avant,
      'annuler doit vraiment annuler');
  });

  /* Le rendu d'un ticket TECHNIQUE, bout en bout : ADF Jira → Markdown → HTML. Jira met
     volontiers un gabarit JSON dans une cellule de tableau ; aplati en cellules, le code
     arrivait sur une seule ligne, indentations écrasées par le repli HTML et incopiable.
     On vérifie ici ce que l'utilisateur VOIT, pas seulement le Markdown intermédiaire. */
  test('un gabarit de code dans un tableau Jira s’affiche en bloc, lignes et indentations gardées', async () => {
    const JSON_GABARIT = '{\n    "partner": "LIN",\n    "version": 8\n}';
    await poserTicketTechnique({
      type: 'doc',
      version: 1,
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'NP15_Suppression_IN' }] }] },
        { type: 'tableCell', content: [{ type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: JSON_GABARIT }] }] },
      ] }] }],
    });
    await page.waitForSelector('#jiraWatchDetail pre');

    const bloc = page.locator('#jiraWatchDetail pre').first();
    assert.equal((await bloc.textContent()).trim(), JSON_GABARIT,
      'le contenu du bloc est celui de Jira, retours à la ligne compris');
    assert.match(await page.locator('#jiraWatchDetail').innerText(), /NP15_Suppression_IN/,
      'l’étiquette de la cellule voisine n’est pas perdue');

    /* Un bloc de code doit se DISTINGUER du texte et garder son propre ascenseur : sans
       fond ni `overflow-x`, une ligne longue débordait de la carte. */
    const style = await bloc.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { fond: cs.backgroundColor, overflow: cs.overflowX, blanc: cs.whiteSpace };
    });
    assert.notEqual(style.fond, 'rgba(0, 0, 0, 0)', 'le bloc a un fond, comme dans un rapport de review');
    assert.equal(style.overflow, 'auto');
    assert.match(style.blanc, /^pre/, 'les espaces ne sont pas repliés');

    // Et la carte ne déborde pas horizontalement, même sur une ligne à rallonge.
    const deborde = await page.locator('#jiraWatchDetail').evaluate((el) => {
      const p = el.querySelector('pre');
      p.textContent = 'x'.repeat(600);
      return { bloc: p.scrollWidth > p.clientWidth, carte: el.scrollWidth > el.clientWidth };
    });
    assert.equal(deborde.bloc, true, 'la ligne longue défile DANS le bloc');
    assert.equal(deborde.carte, false, '…et ne pousse pas le panneau');
  });

  /* Un `|` dans une cellule ouvrirait une colonne de plus : il est échappé à la source, et
     le rendu doit savoir le relire — sinon la ligne se décale d'une case. */
  test('un tableau Jira ordinaire garde ses colonnes, « | » compris', async () => {
    const cell = (t) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
    const head = (t) => ({ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
    await poserTicketTechnique({
      type: 'doc',
      version: 1,
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [head('Champ'), head('Valeur')] },
        { type: 'tableRow', content: [cell('mode'), cell('strict | souple')] },
      ] }],
    });
    await page.waitForSelector('#jiraWatchDetail table');
    const lignes = await page.locator('#jiraWatchDetail table tbody tr').evaluateAll(
      (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)),
    );
    assert.deepEqual(lignes, [['mode', 'strict | souple']],
      'deux colonnes, et le pipe rendu à la cellule au lieu d’en ouvrir une troisième');
  });

  /* Markdown exige une ligne d'en-tête ; un tableau Jira, non. Faute d'en-tête on en émet
     un VIDE plutôt que de promouvoir la première ligne de données — et l'affichage le masque,
     sinon l'écran porterait une bande grise sans le moindre libellé. */
  test('un tableau Jira sans en-tête garde toutes ses lignes, et n’affiche pas de bande vide', async () => {
    const cell = (t) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
    await poserTicketTechnique({
      type: 'doc',
      version: 1,
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [cell('TVA'), cell('20%')] },
        { type: 'tableRow', content: [cell('Frais'), cell('0€')] },
      ] }],
    });
    await page.waitForSelector('#jiraWatchDetail table');
    const vu = await page.locator('#jiraWatchDetail table').evaluate((t) => ({
      lignes: [...t.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent)),
      enTete: getComputedStyle(t.querySelector('thead')).display,
    }));
    assert.deepEqual(vu.lignes, [['TVA', '20%'], ['Frais', '0€']],
      'les DEUX lignes sont là : aucune n’a été promue en titre');
    assert.equal(vu.enTete, 'none', 'l’en-tête vide est masqué, pas affiché en bande grise');
  });

  /* Un tableau clé/valeur met son en-tête en première COLONNE. Markdown n'a pas de `th` en
     colonne : la clé est mise en gras, et la paire est conservée. */
  test('un tableau clé/valeur garde ses paires, clés en gras', async () => {
    const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    await poserTicketTechnique({
      type: 'doc',
      version: 1,
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [p('Partenaire')] }, { type: 'tableCell', content: [p('LIN')] }] },
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [p('Version')] }, { type: 'tableCell', content: [p('8')] }] },
      ] }],
    });
    await page.waitForSelector('#jiraWatchDetail table');
    const vu = await page.locator('#jiraWatchDetail table').evaluate((t) => ({
      lignes: [...t.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.textContent)),
      cles: [...t.querySelectorAll('tbody tr td:first-child strong')].map((e) => e.textContent),
    }));
    assert.deepEqual(vu.lignes, [['Partenaire', 'LIN'], ['Version', '8']],
      'la première paire n’est plus sacrifiée à l’en-tête');
    assert.deepEqual(vu.cles, ['Partenaire', 'Version']);
  });

  /* Les deux sous-onglets ont chacun leur sélection : revenir sur « Mes tickets » ne doit pas
     hériter du ticket qu'on lisait dans « Surveillés », ni l'inverse. */
  test('les deux panneaux gardent leur propre sélection', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchList .jira-item').first().click();
    await page.waitForSelector('#jiraWatchDetail .jira-detail-inner');
    const cote = await page.locator('#jiraWatchDetail').textContent();

    await page.locator('#tab-jira .subnav [data-jsub="mine"]').click();
    await page.waitForTimeout(400);
    await page.locator('#tab-jira .subnav [data-jsub="watch"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#jiraWatchDetail').textContent(), cote,
      'le ticket lu dans « Surveillés » est toujours là au retour');
  });
});
