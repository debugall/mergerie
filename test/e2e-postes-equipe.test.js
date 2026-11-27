'use strict';
/* LES POSTES DE L'ÉQUIPE (Réglages → Données partagées), seuls survivants de la page « Équipe » retirée.
 *
 *   1. le calcul : une ligne par auteur du dépôt de données, sa dernière synchro, « silencieux » au-delà de N
 *      jours OUVRÉS (le week-end ne compte pas) ; sans dépôt attaché, rien ;
 *   2. la route `/api/data-sync/postes` suit le réglage `team_quiet_days` ; `/api/equipe` n'existe plus ;
 *   3. l'écran : la liste dans Réglages → Données partagées, une personne n'y est jamais un lien ; plus
 *      d'entrée « Équipe » dans le menu. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Postes de l’équipe (Réglages → Données partagées)', () => {
  let app; let postes; let etat;
  const NOW = new Date('2026-11-05T10:00:00Z');   // un jeudi

  before(async () => {
    app = await startApp();
    // eslint-disable-next-line global-require
    postes = require('../src/data/postes');
    // eslint-disable-next-line global-require
    etat = require('../src/data/localstate').etat;
  });
  after(async () => { if (app) await app.stop(); });

  test('sans dépôt de données attaché : rien', async () => {
    assert.deepEqual(postes.postes({ maintenant: NOW }), { attached: false, items: [] });
    assert.deepEqual((await app.api('GET', '/api/data-sync/postes')).body, { attached: false, items: [] });
  });

  test('attaché : Claire fraîche, Ali silencieux après trois jours ouvrés — le week-end ne compte pas', async () => {
    app.db.prepare("UPDATE local_config SET data_repo_url = 'https://gitlab.test/equipe/donnees.git' WHERE id = 1").run();
    etat.ecrire('author_last', 'Claire', 'at', new Date(NOW.getTime() - 10 * 60000).toISOString());
    etat.ecrire('author_last', 'Ali', 'at', '2026-10-31T16:00:00Z');
    const d = postes.postes({ maintenant: NOW, silencieuxJours: 2 });
    assert.equal(d.attached, true);
    assert.deepEqual(d.items.map((w) => [w.name, w.quiet]), [['Claire', false], ['Ali', true]], 'le plus récent d’abord');
    assert.deepEqual(Object.keys(d.items[0]).sort(), ['name', 'quiet', 'synced_at'], 'rien d’autre sur une personne');
    assert.equal(postes.joursOuvres('2026-10-31T16:00:00Z', NOW), 4, 'vendredi → jeudi : lun, mar, mer, jeu');
    assert.equal(postes.joursOuvres('2026-10-31T16:00:00Z', new Date('2026-11-02T09:00:00Z')), 1, 'vendredi soir → lundi matin');
    assert.equal(postes.postes({ maintenant: NOW, silencieuxJours: 4 }).items.find((w) => w.name === 'Ali').quiet, false);
  });

  test('la route suit le réglage « poste silencieux après N jours » ; la page d’équipe n’existe plus', async () => {
    await app.api('PUT', '/api/config', { team_quiet_days: '0' });
    const d = (await app.api('GET', '/api/data-sync/postes')).body;
    assert.equal(d.items.find((w) => w.name === 'Ali').quiet, true);
    await app.api('PUT', '/api/config', { team_quiet_days: '365' });
    assert.equal((await app.api('GET', '/api/data-sync/postes')).body.items.find((w) => w.name === 'Ali').quiet, false);
    await app.api('PUT', '/api/config', { team_quiet_days: '2' });
    assert.notEqual((await app.api('GET', '/api/equipe')).status, 200, '/api/equipe est retirée');
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1300, height: 900 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('plus d’entrée « Équipe » ; la liste des postes vit dans les réglages, sans lien sur une personne', async () => {
      await page.waitForSelector('nav button[data-tab]');
      assert.equal(await page.locator('nav button[data-tab="team"]').count(), 0, 'l’entrée de menu est retirée');
      await page.locator('nav button[data-tab="admin"]').click();
      await page.locator('#tab-admin .subnav [data-sub="datasync"]').click();
      await page.locator('#dataSyncPostes .datasync-poste').first().waitFor();
      const lignes = await page.locator('#dataSyncPostes .datasync-poste').allInnerTexts();
      assert.ok(lignes.some((t) => /^Claire/.test(t)), lignes.join(' | '));
      assert.ok(lignes.some((t) => /^Ali/.test(t)), lignes.join(' | '));
      assert.equal(await page.locator('#dataSyncPostes a[href]').count(), 0, 'une personne n’est pas un lien');
      assert.deepEqual(erreurs, []);
    });
  });
});
