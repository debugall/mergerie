'use strict';
/* Menu déroulant d'un combo (liste avec recherche), dans un VRAI navigateur.
 *
 * Le sujet est entièrement géométrique : où le menu se pose, et qui le découpe. Ça ne se
 * teste pas autrement qu'en mesurant des rectangles à l'écran. Le cas qui a motivé ces
 * tests : « choisir un projet local » dans le formulaire d'un vérificateur, dont le menu
 * s'ouvrait à 186 px SOUS le bloc, parce que le contournement d'alors rendait l'overflow
 * du conteneur visible — ce qui remet aussi son défilement à zéro.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp } = require('./helpers/app');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Combo — le menu ne se fait ni rogner ni détacher', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  const NB_DEPOTS = 14; // assez pour que la liste des dépôts défile

  before(async () => {
    app = await startApp();
    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-clones-')) });
    for (let i = 0; i < NB_DEPOTS; i++) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `cb-r${i}-`));
      git(d, 'init', '-q', '-b', 'main');
      git(d, 'config', 'user.email', 'test@example.com'); git(d, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(d, 'a.txt'), 'x\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
      await app.api('POST', '/api/repos', { project: `groupe/projet-numero-${i}`, url: d });
    }
    // Une racine locale : c'est elle qui peuple le combo « choisir un projet local ».
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-racine-'));
    for (const nom of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      const d = path.join(racine, nom); fs.mkdirSync(d);
      git(d, 'init', '-q', '-b', 'main');
      git(d, 'config', 'user.email', 'test@example.com'); git(d, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(d, 'a.txt'), 'x\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
    }
    await app.api('POST', '/api/local-roots', { path: racine, label: 'mes projets' });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Ouvre le formulaire du vérificateur sur la Nième ligne de dépôt, en mode « in place ».
  async function ouvrirCombo(indexLigne) {
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav button', { hasText: 'Vérificateurs' }).click();
    // Le formulaire s'ouvre à la demande : sans ce clic, ses lignes existent dans le DOM
    // mais restent invisibles, et rien ne peut être cliqué.
    if (await page.locator('#btnNewVerifier').isVisible()) await page.locator('#btnNewVerifier').click();
    await page.waitForSelector('#verifierRepoBox .vr-row');
    const ligne = page.locator('#verifierRepoBox .vr-row').nth(indexLigne);
    if (!(await ligne.locator('.vr-pick').isChecked())) await ligne.locator('.vr-pick').check();
    await ligne.locator('.vr-mode').selectOption('in_place');
    await page.waitForTimeout(200);
    // Défiler la liste jusqu'en bas : c'est là que le menu manquait de place.
    await page.evaluate(() => { const l = document.querySelector('#verifierRepoBox .vr-list'); l.scrollTop = l.scrollHeight; });
    await page.waitForTimeout(200);
    return ligne;
  }

  const geometrie = () => page.evaluate(() => {
    const r = (e) => (e ? e.getBoundingClientRect() : null);
    const liste = document.querySelector('#verifierRepoBox .vr-list');
    const menu = [...document.querySelectorAll('.combo-options')].find((o) => !o.hidden);
    const champ = document.activeElement;
    const m = r(menu);
    const c = r(champ);
    return {
      menu: m && { top: Math.round(m.top), bas: Math.round(m.bottom), gauche: Math.round(m.left) },
      champ: c && { top: Math.round(c.top), bas: Math.round(c.bottom), gauche: Math.round(c.left) },
      scrollListe: Math.round(liste.scrollTop),
      overflowListe: getComputedStyle(liste).overflowY,
      fenetre: window.innerHeight,
      // Ce qui est réellement au sommet du premier choix : s'il n'est pas dans le menu,
      // c'est qu'un autre élément le recouvre et qu'on ne pourra pas cliquer.
      dessus: (() => {
        if (!m) return null;
        const el = document.elementFromPoint(Math.round(m.left + 20), Math.round(m.top + 12));
        return el && el.closest('.combo-options') ? 'menu' : (el ? el.className || el.tagName : 'rien');
      })(),
    };
  });

  test('le menu reste accroché à son champ, sans être rogné par la liste qui défile', async () => {
    const ligne = await ouvrirCombo(NB_DEPOTS - 2);
    const avant = await geometrie();
    await ligne.locator('.vr-local-combo .cb-search').click();
    await page.waitForTimeout(600);
    const g = await geometrie();

    assert.ok(g.menu, 'le menu est ouvert');
    // Collé au champ : l'écart d'avant était de 186 px, le menu flottait sous le bloc.
    assert.ok(Math.abs(g.menu.top - g.champ.bas) <= 6,
      `le menu doit suivre le champ (champ bas ${g.champ.bas}, menu haut ${g.menu.top})`);
    assert.ok(Math.abs(g.menu.gauche - g.champ.gauche) <= 2, 'et rester aligné à gauche sur lui');
    // Entièrement dans la fenêtre : un menu qui déborde par le bas est inatteignable.
    assert.ok(g.menu.top >= 0 && g.menu.bas <= g.fenetre,
      `le menu doit tenir dans la fenêtre (${g.menu.top}→${g.menu.bas} pour ${g.fenetre})`);
    assert.equal(g.dessus, 'menu', 'et rien ne doit le recouvrir');

    /* Le défilement du conteneur ne doit pas repartir de zéro : c'était l'effet de bord de
       l'ancien remède (passer l'overflow à `visible` réinitialise `scrollTop`), et la ligne
       sur laquelle on travaillait disparaissait de l'écran. */
    assert.equal(g.overflowListe, 'auto', 'la liste garde son propre défilement');
    assert.ok(g.scrollListe > 0, `la liste ne doit pas sauter en haut (avant ${avant.scrollListe}, après ${g.scrollListe})`);
  });

  test('sans place en dessous, le menu s’ouvre au-dessus du champ', async () => {
    await page.setViewportSize({ width: 1400, height: 560 });
    const ligne = await ouvrirCombo(NB_DEPOTS - 2);
    // On amène le champ tout en bas de la fenêtre.
    await ligne.locator('.vr-local-combo .cb-search').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -220));
    await page.waitForTimeout(200);
    await ligne.locator('.vr-local-combo .cb-search').click();
    await page.waitForTimeout(600);
    const g = await geometrie();

    assert.ok(g.menu, 'le menu est ouvert');
    assert.ok(g.menu.top >= 0 && g.menu.bas <= g.fenetre,
      `le menu tient dans la fenêtre (${g.menu.top}→${g.menu.bas} pour ${g.fenetre})`);
    if (g.champ.bas > g.fenetre - 160) {
      assert.ok(g.menu.bas <= g.champ.top + 6,
        `pas la place en dessous : le menu doit s’ouvrir AU-DESSUS (menu bas ${g.menu.bas}, champ haut ${g.champ.top})`);
    }
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  /* Le même combo vit dans une MODALE, dont le corps défile aussi — et une modale a son
     propre plan d'empilement. Un menu qui passerait dessous serait visible mais pas
     cliquable, ce qui est pire qu'invisible. */
  test('dans une modale, le menu passe au-dessus et reste cliquable', async () => {
    await page.locator('[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="local"]').click();
    await page.waitForTimeout(300);
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForSelector('#taskLocalDirRows .cb-search');

    await page.locator('#taskLocalDirRows .cb-search').first().click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
    const g = await geometrie();
    assert.ok(g.menu, 'le menu est ouvert');
    assert.ok(Math.abs(g.menu.top - g.champ.bas) <= 6, 'accroché au champ');
    assert.equal(g.dessus, 'menu', 'rien ne le recouvre — la modale ne doit pas passer devant');

    // Et le choix aboutit vraiment.
    const choix = page.locator('.combo-options:not([hidden]) .combo-opt[data-v]').first();
    const valeur = await choix.getAttribute('data-v');
    await choix.click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#taskLocalDirRows .cb-search').first().inputValue(), valeur);
    assert.equal(await page.locator('#taskModal').isVisible(), true, 'et la modale ne s’est pas fermée en route');
    await page.locator('#taskCancel').click();
  });

  test('choisir dans le menu remplit bien le champ de chemin', async () => {
    const ligne = await ouvrirCombo(NB_DEPOTS - 2);
    await ligne.locator('.vr-local-combo .cb-search').click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
    const choix = page.locator('.combo-options:not([hidden]) .combo-opt[data-v]').first();
    const chemin = await choix.getAttribute('data-v');
    await choix.click();
    await page.waitForTimeout(300);
    assert.equal(await ligne.locator('.vr-workdir').inputValue(), chemin,
      'le clic sur une option doit rester possible — c’est ce qu’un menu recouvert empêche');
  });
});
