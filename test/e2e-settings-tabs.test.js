'use strict';
/* L'ORDRE DES SOUS-ONGLETS DE RÉGLAGES, et l'onglet sur lequel on atterrit.
 *
 * L'ordre historique racontait celui dans lequel les fonctionnalités avaient été écrites : la
 * barre s'ouvrait sur « Règles de review spécifiques », dont le contenu ne s'applique à rien
 * tant qu'aucun dépôt n'est suivi et qu'aucun jeton n'est saisi. L'ordre suit désormais le
 * parcours — connecter, choisir le code, régler la review, régler l'outil, les intégrations
 * optionnelles, le banc d'essai —, et la première ouverture tombe sur la connexion Git.
 *
 * Ce que ce fichier protège n'est pas une esthétique : c'est qu'une installation neuve arrive
 * devant le champ sans lequel rien ne marche, et qu'on retrouve ensuite là où l'on s'était
 * arrêté.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* navigateur absent */ }

describe('Réglages : ordre des sous-onglets', { skip: chromium ? false : 'playwright absent' }, () => {
  let app; let navigateur; let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const actif = () => page.locator('#tab-admin .subnav button.active').getAttribute('data-sub');

  /* PREMIÈRE OUVERTURE = INSTALLATION NEUVE. Atterrir sur les règles de review revenait à
     proposer d'affiner ce qu'on n'a pas encore branché. */
  test('sans rien de mémorisé, on atterrit sur la connexion Git', async () => {
    await page.evaluate(() => localStorage.removeItem('aidevtools_admin_sub'));
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    assert.equal(await actif(), 'gitcfg');
    assert.equal(await page.locator('#sub-gitcfg').isVisible(), true, 'et c’est son panneau qui est ouvert');
    assert.equal(await page.locator('#sub-rules').isVisible(), false);
  });

  /* L'ORDRE SUIT LE PARCOURS : connecter → choisir le code → régler la review → régler l'outil
     → les intégrations optionnelles → le banc d'essai. Un onglet qu'on remonte « parce qu'on y
     va souvent » casse cette lecture ; le test la fige pour qu'elle soit un choix, pas un
     accident de plus. */
  test('la barre est rangée dans l’ordre du parcours', async () => {
    const ordre = await page.locator('#tab-admin .subnav [data-sub]')
      .evaluateAll((els) => els.map((e) => e.dataset.sub));
    assert.deepEqual(ordre, ['gitcfg', 'repos', 'mr', 'rules', 'verifiers',
      'notif', 'config', 'jiracfg', 'jenkinscfg', 'aisession']);
  });

  /* On revient dans Réglages pour finir ce qu'on y faisait : le dernier onglet consulté gagne
     sur le repli. Il est mémorisé par son NOM, donc réordonner la barre ne déplace personne. */
  test('le dernier sous-onglet consulté est retrouvé au rechargement', async () => {
    await page.locator('#tab-admin .subnav [data-sub="jenkinscfg"]').click();
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    assert.equal(await actif(), 'jenkinscfg');
  });

  /* Un nom mémorisé qui n'existe plus (un onglet supprimé depuis) ne doit pas laisser l'écran
     vide : on retombe sur le même repli que la première fois. */
  test('un sous-onglet mémorisé qui n’existe plus retombe sur Git', async () => {
    await page.evaluate(() => localStorage.setItem('aidevtools_admin_sub', 'onglet-disparu'));
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    assert.equal(await actif(), 'gitcfg');
  });
});
