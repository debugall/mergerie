'use strict';
/* RÉGLAGES → PLUGINS : la carte d'un plugin et son formulaire GÉNÉRÉ, dans un vrai navigateur.
 * — un plugin INACTIF n'affiche pas de formulaire (ses routes n'existent pas) : un texte dit qu'il apparaîtra à l'activation ;
 * — actif, le formulaire généré montre les champs, et CACHE ceux que le plugin marque `x-hidden` : un état qu'il garde
 *   lui-même ne s'affiche pas, et enregistrer le formulaire ne le renvoie donc pas (ne l'écrase pas) ;
 * — la carte se lit de haut en bas : le formulaire est SOUS les boutons, pas à leur droite. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startApp, afficherMenusOptionnels, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Réglages → Plugins — la carte et le formulaire généré', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const carte = '#pluginList [data-plugin="hidden-state"]';
  const ouvrirPlugins = async () => {
    await page.click('nav button[data-tab="admin"]');
    await page.click('#tab-admin .subnav [data-sub="plugins"]');
    await page.waitForSelector(carte, { timeout: ATTENTE });
  };

  before(async () => {
    app = await startApp({ plugins: [] });
    await app.configure();
    const inst = await app.api('POST', '/api/plugins/install', { path: path.join(__dirname, 'fixtures', 'plugins', 'hidden-state') });
    assert.equal(inst.status, 200, JSON.stringify(inst.body));
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1300, height: 950 } });
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
  });
  after(async () => { if (navigateur) await navigateur.close(); if (app) await app.stop(); });

  test('inactif : pas de formulaire, un texte qui dit quand il apparaîtra', async () => {
    await ouvrirPlugins();
    assert.equal(await page.locator(`${carte} [data-plugin-form]`).count(), 0);
    assert.equal(await page.locator(`${carte} .plugin-hint`).count(), 1);
  });

  test('actif : les champs visibles sont là, le champ `x-hidden` non — et l’enregistrement ne l’écrase pas', async () => {
    assert.equal((await app.api('POST', '/api/plugins/hidden-state/enable')).body.ok, true);
    await page.reload();
    await ouvrirPlugins();
    const form = `${carte} [data-plugin-form="hidden-state"]`;
    await page.waitForSelector(`${form} [name="visible"]`, { timeout: ATTENTE });
    assert.equal(await page.locator(`${form} [name="etat"]`).count(), 0, 'l’état caché ne s’affiche pas');
    await app.api('PUT', '/api/plugins/hidden-state/settings', { etat: 'modifie-par-le-plugin' });
    await page.fill(`${form} [name="visible"]`, 'bonjour');
    await page.click(`${form} button[type="submit"]`);
    await attendreServeur(async () => (await app.api('GET', '/api/plugins/hidden-state/settings')).body.visible === 'bonjour', 'enregistré côté serveur');
    assert.equal((await app.api('GET', '/api/plugins/hidden-state/settings')).body.etat, 'modifie-par-le-plugin', 'l’état caché n’a pas été renvoyé');
  });

  test('la carte se lit de haut en bas : le formulaire est sous les boutons', async () => {
    const boite = async (sel) => page.locator(sel).first().boundingBox();
    const actions = await boite(`${carte} .card-actions`);
    const formulaire = await boite(`${carte} .plugin-settings`);
    assert.ok(formulaire.y >= actions.y + actions.height - 1, 'le formulaire commence sous les boutons');
    assert.ok(formulaire.x <= actions.x + 5, 'et il est aligné à gauche, pas poussé à droite');
  });
});
