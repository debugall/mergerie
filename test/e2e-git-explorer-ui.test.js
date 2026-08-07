'use strict';
/* Explorateur de branches — ce que l'écran DIT pendant qu'il travaille.
 *
 * Analyser un dépôt le clone : cela peut durer une minute. Les blocs de résultat naissent
 * repliés, si bien que le squelette placé dans leur corps ne se voyait pas — on cliquait
 * « Analyser » et plus rien ne bougeait. Deux choses se testent donc ici, et seulement dans
 * un vrai navigateur : l'ÉTAT annoncé par chaque bloc pendant l'analyse, et le CHEVRON qui
 * dit si un bloc est replié ou déplié (un `summary` en `display: flex` perd le marqueur
 * natif du navigateur — c'est ainsi qu'il avait disparu).
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Git · Explorateur de branches', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    // Deux dépôts : l'analyse est séquentielle, on veut voir lequel travaille et lequel attend.
    for (const nom of ['grp/un', 'grp/deux']) {
      const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
      await app.api('POST', '/api/repos', { url: depot.url, project: nom });
    }
    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
    await page.locator('nav button[data-tab="git"]').click();
    await page.locator('#tab-git .subnav [data-gsub="explore"]').click();
    await page.waitForSelector('#gitExploreRepoBox .git-multi-pick');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  async function lancerAnalyse({ ralenti = 0 } = {}) {
    await page.evaluate((ms) => {
      $$('#gitExploreRepoBox .git-multi-pick').forEach((c) => { c.checked = true; });
      if (!ms) return;
      // On rallonge l'appel pour observer l'état intermédiaire — c'est le cas réel d'un clone long.
      const vrai = window.fetch;
      window.fetch = async (u, o) => {
        if (String(u).includes('/git/branches')) await new Promise((r) => setTimeout(r, ms));
        return vrai(u, o);
      };
    }, ralenti);
    await page.locator('#gitExploreGo').click();
  }

  /* Le cœur de la demande : pendant l'analyse, l'écran doit dire ce qui se passe — et sur
     plusieurs dépôts, LEQUEL travaille, puisqu'ils sont traités l'un après l'autre. */
  test('pendant l’analyse, chaque dépôt annonce son état et le bouton tourne', async () => {
    await lancerAnalyse({ ralenti: 2500 });

    await page.waitForSelector('.git-ex-project .spin');
    const etats = await page.locator('.git-ex-project').evaluateAll(
      (els) => els.map((e) => ({
        texte: e.querySelector('.git-ex-proj-info').textContent.trim(),
        spinner: !!e.querySelector('.spin'),
      })),
    );
    assert.equal(etats.length, 2);
    assert.ok(etats[0].spinner, 'le dépôt en cours porte un indicateur d’activité');
    assert.ok(etats[0].texte.length > 0, '…et le dit en toutes lettres');
    assert.ok(!etats[1].spinner, 'celui qui attend ne prétend pas travailler');
    assert.notEqual(etats[1].texte, etats[0].texte, 'en attente ≠ en cours : on sait lequel tourne');

    // Le bouton lui-même montre qu'il travaille, et ne se reclique pas.
    assert.equal(await page.locator('#gitExploreGo').getAttribute('data-busy'), '1');
    assert.equal(await page.locator('#gitExploreGo').isDisabled(), true);

    // À la fin : plus d'indicateur, et chaque bloc annonce son compte de branches.
    await page.waitForFunction(() => !document.querySelector('.git-ex-project .spin'), null, { timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('#gitExploreGo').hasAttribute('data-busy'));
    const finaux = await page.locator('.git-ex-proj-info').evaluateAll((els) => els.map((e) => e.textContent));
    assert.ok(finaux.every((t) => /\d/.test(t)), `chaque bloc rend son compte, vu : ${JSON.stringify(finaux)}`);
  });

  /* Le bloc est repliable : encore faut-il que ça se VOIE. `display: flex` sur le `summary`
     supprime le marqueur natif du navigateur — le chevron est donc dessiné à la main. */
  test('le bloc porte un chevron, qui pivote quand on le déplie', async () => {
    await page.waitForSelector('.git-ex-project');
    const bloc = page.locator('.git-ex-project').first();
    assert.equal(await bloc.evaluate((e) => e.open), false, 'les blocs naissent repliés');

    const chevron = (el) => {
      const cs = getComputedStyle(el.querySelector('summary'), '::before');
      return { contenu: cs.content, bord: cs.borderLeftWidth, transforme: cs.transform };
    };
    const replie = await bloc.evaluate(chevron);
    assert.notEqual(replie.contenu, 'none', 'un chevron est bien dessiné');
    assert.notEqual(replie.bord, '0px', '…et il a une taille visible');

    await bloc.locator('summary').click();
    await page.waitForFunction(() => document.querySelector('.git-ex-project').open);
    const ouvert = await bloc.evaluate(chevron);
    assert.notEqual(ouvert.transforme, replie.transforme,
      'déplié, le chevron pivote : c’est ce qui distingue les deux états d’un coup d’œil');
  });

  /* Une erreur dans un bloc replié serait invisible : le bloc s'ouvre pour la montrer. */
  test('un dépôt en erreur ouvre son bloc au lieu de rester muet', async () => {
    await page.reload();
    await page.locator('nav button[data-tab="git"]').click();
    await page.locator('#tab-git .subnav [data-gsub="explore"]').click();
    await page.waitForSelector('#gitExploreRepoBox .git-multi-pick');
    await page.evaluate(() => {
      const vrai = window.fetch;
      window.fetch = async (u, o) => (String(u).includes('/git/branches')
        ? new Response(JSON.stringify({ error: 'dépôt injoignable' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        : vrai(u, o));
    });
    await lancerAnalyse();
    await page.waitForSelector('.git-ex-project[open]');
    assert.match(await page.locator('.git-ex-project').first().innerText(), /injoignable/,
      'la raison est sous les yeux, pas enfermée dans un bloc fermé');
  });
});
