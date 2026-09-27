'use strict';
/* MENU « STATISTIQUES » — L'ÉCRAN SANS DONNÉES, ET QUAND QUELQUE CHOSE MANQUE.
 *
 * Le premier jour, tout est à zéro ; plus tard, la forge peut être injoignable. Dans les deux
 * cas l'écran doit DIRE ce qui se passe plutôt que d'afficher des cartes vides ou un squelette
 * qui tourne à l'infini :
 *   - installation neuve, aucune forge : chaque carte a sa phrase, les cartes sans objet
 *     (coût en tokens, délai de cycle, coût par agent) ne sont pas affichées ;
 *   - forge configurée sans dépôt suivi : « aucun commit », « aucun dépôt suivi » ;
 *   - forge en panne : le Top 5 et l'activité se déclarent indisponibles, le reste s'affiche ;
 *   - `/api/stats` injoignable : un bloc d'erreur avec « Réessayer », qui répare l'écran ;
 *   - la fenêtre « 12 mois » d'un dépôt sans activité, sa fermeture au fond, et son erreur.
 *
 * Les pannes de réseau sont simulées par `page.route` : c'est le FRONT qu'on éprouve ici, le
 * comportement de la route elle-même l'est déjà par `e2e-activity` et `e2e-api`.
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const seed = require('./helpers/stats-seed');

const { dispo } = navigateurDispo();

describe('Menu Statistiques — états vides et dégradés', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    // Pas de forge : seulement de quoi ne pas atterrir sur le brief du jour.
    await app.api('PUT', '/api/config', { brief_on_open: '0' });
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  async function allerStats() {
    await page.locator('nav button[data-tab="dashboard"]').click();
    await page.waitForSelector('#tab-dashboard.active #dashboard .dash-periode');
  }
  const carte = (titre) => page.locator('#dashboard .dash-card').filter({ has: page.locator('h3', { hasText: titre }) });
  const texte = async (loc) => (await loc.textContent()).replace(/\s+/g, ' ').trim();

  test('installation neuve : chaque carte dit qu’elle n’a rien, sans carte vide', async () => {
    await allerStats();
    await page.waitForFunction(() => /GitLab ou GitHub/.test((document.querySelector('#dashTop5') || {}).textContent || ''));
    await page.waitForFunction(() => /GitLab ou GitHub/.test((document.querySelector('#dashActivity') || {}).textContent || ''));

    const tuiles = await page.$$eval('#dashboard > .stat-row .stat-val', (v) => v.map((x) => x.textContent.trim()));
    assert.deepEqual(tuiles, ['0', '0', '0']);
    // Aucune tranche de note ne dessine de barre : toutes portent `is-zero`.
    assert.equal(await carte('Distribution des notes').locator('.hbar-fill:not(.is-zero)').count(), 0);
    assert.doesNotMatch(await texte(carte('Distribution des notes').locator('h3')), /moyenne/);
    assert.equal(await carte('Reviews par semaine').locator('.vbar-fill:not(.is-zero)').count(), 0);
    assert.equal(await carte('Note moyenne par semaine').locator('.vbar-empty').count(), 8, 'huit semaines sans review, dites comme telles');

    assert.equal(await texte(carte('Par projet').locator('tbody')), 'Aucune donnée');
    assert.equal(await carte('Par projet').locator('.stats-res-global').count(), 0, 'pas de taux global sans passe');
    const vides = {
      'Les sessions les plus coûteuses': 'Aucune session n’a encore été mesurée.',
      'Les reviews les plus coûteuses': 'Aucune review n’a encore été mesurée.',
      'Ce qu’on envoie contre ce qu’on reçoit': 'Aucun appel mesuré pour l’instant.',
      'Vérifications : taux de vert par dépôt': 'Pas encore assez de vérifications pour comparer les dépôts.',
      'Opérations Git': 'Aucune opération Git sur la période.',
      'Constats qui reviennent': 'Aucun constat ne revient encore sur trois merge requests d’un même dépôt.',
    };
    for (const [titre, phrase] of Object.entries(vides)) {
      assert.equal(await texte(carte(titre).locator('p.muted').last()), phrase, titre);
    }
    // Les cartes qui n'ont de sens qu'avec des données ne sont pas affichées du tout.
    for (const titre of ['Coût en tokens', 'Délai de cycle', 'Coût par agent']) {
      assert.equal(await carte(titre).count(), 0, `« ${titre} » absente`);
    }
    const dev = await page.$$eval('#dashboard .dash-card', (cs) => {
      const c = cs.find((x) => /Sessions de dev/.test(x.querySelector('h3').textContent));
      return [...c.querySelectorAll('.stat-val')].map((v) => v.textContent.trim());
    });
    assert.deepEqual(dev, ['0', '0', '0', '0']);
    assert.match(await texte(page.locator('#dashTop5')), /Connecte GitLab ou GitHub \(Réglages → Git\)/);
    assert.match(await texte(page.locator('#dashActivity')), /Connecte GitLab ou GitHub/);
  });

  test('forge configurée, aucun dépôt suivi : « aucun commit », « aucun dépôt suivi »', async () => {
    await app.configure();
    await page.locator('#dashRefresh').click();
    await page.waitForFunction(() => /Aucun commit récupéré/.test((document.querySelector('#dashTop5') || {}).textContent || ''));
    await page.waitForFunction(() => /Aucun dépôt suivi/.test((document.querySelector('#dashActivity') || {}).textContent || ''));
  });

  test('forge en panne : Top 5 et activité se déclarent indisponibles, le reste s’affiche', async () => {
    const repos = await seed.creerDepots(app, ['grp/calme']);
    app.state.commits['grp/calme'] = [];
    seed.insererMr(app.db, repos['grp/calme'], 1, { titre: 'Une MR à traiter', statut: 'to_review' });
    const panne = (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'forge en panne' }) });
    await page.route('**/api/dashboard/commits', panne);
    await page.route('**/api/dashboard/activity', panne);
    try {
      await page.locator('#dashRefresh').click();
      await page.waitForFunction(() => /indisponible/.test((document.querySelector('#dashTop5') || {}).textContent || ''));
      await page.waitForFunction(() => /indisponible/.test((document.querySelector('#dashActivity') || {}).textContent || ''));
      assert.match(await texte(page.locator('#dashTop5')), /Activité de la forge indisponible pour le moment/);
      // Le dernier commit du tableau ne reste pas sur « … » : il passe à « — ».
      await page.waitForFunction(() => {
        const td = document.querySelector('.dash-lastcommit[data-project="grp/calme"]');
        return td && td.textContent.trim() === '—';
      });
      // Le reste de l'écran, local, ne dépend pas de la forge.
      assert.equal((await page.locator('#dashboard > .stat-row .stat-val').first().textContent()).trim(), '1');
      assert.equal(await carte('Par projet').locator('[data-stat-projet="grp/calme"]').count(), 1);
    } finally {
      await page.unroute('**/api/dashboard/commits');
      await page.unroute('**/api/dashboard/activity');
    }
  });

  test('statistiques injoignables : un bloc d’erreur, et « Réessayer » répare l’écran', async () => {
    await page.route('**/api/stats?*', (route) => route.abort('connectionrefused'));
    try {
      await page.locator('#dashRefresh').click();
      await page.waitForSelector('#dashboard .errbox .errretry');
      assert.equal(await page.locator('#dashboard .dash-card').count(), 0, 'pas de cartes à moitié rendues');
    } finally {
      await page.unroute('**/api/stats?*');
    }
    await page.locator('#dashboard .errretry').click();
    await page.waitForSelector('#tab-dashboard.active #dashboard .dash-periode');
    assert.equal(await page.locator('#dashboard .errbox').count(), 0);
    assert.equal((await page.locator('#dashboard > .stat-row .stat-val').first().textContent()).trim(), '1');
  });

  test('la fenêtre 12 mois d’un dépôt sans activité le dit, et se ferme d’un clic au fond', async () => {
    await page.locator('#dashRefresh').click();
    await page.waitForSelector('#dashActivity [data-pab-detail]');
    // Un dépôt sans commit est endormi : il reste à l'écran, marqué.
    assert.equal(await page.locator('#dashActivity .pab.dort').count(), 1);
    await page.locator('#dashActivity [data-pab-detail]').first().click();
    await page.waitForSelector('#activityModal:not([hidden]) .ad-chart');
    assert.equal(await page.locator('#activityTitle').textContent(), 'grp/calme — 12 derniers mois');
    assert.equal(await page.locator('#activityModal .ad-bar.vide').count(), 12, 'douze mois vides');
    const faits = await texte(page.locator('#activityModal .ad-facts'));
    assert.equal(faits, 'aucune activité sur la période', 'ni « mois le plus actif », ni séparateur orphelin');
    assert.equal(await page.locator('#activityModal .stat-tile .stat-val').last().textContent(), '—', 'pas de contributeur');

    await page.locator('#activityModal').click({ position: { x: 5, y: 5 } });
    await page.locator('#activityModal').waitFor({ state: 'hidden' });
  });

  test('une erreur de la fenêtre 12 mois s’affiche dans la fenêtre, qui se referme', async () => {
    await page.route('**/api/dashboard/activity/*', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'pagination interrompue' }),
    }));
    try {
      await page.locator('#dashActivity [data-pab-detail]').first().click();
      await page.waitForSelector('#activityModal:not([hidden]) .errbox');
      assert.match(await texte(page.locator('#activityModal .errbox')), /pagination interrompue/);
    } finally {
      await page.unroute('**/api/dashboard/activity/*');
    }
    await page.locator('#activityClose').click();
    await page.locator('#activityModal').waitFor({ state: 'hidden' });
  });

  test('aucune exception JavaScript dans ces états', () => {
    assert.deepEqual(erreurs, []);
  });
});
