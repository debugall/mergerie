'use strict';
/* Activité des projets sur six mois (onglet Statistiques).
 *
 * Ce qui compte ici n'est pas d'afficher un chiffre, c'est de n'afficher que les dépôts
 * SUIVIS, de ne pas repayer la forge pour des mois déjà clos, et de ne pas laisser un
 * dépôt injoignable vider tout l'écran. Le mock compte les appels reçus : c'est la seule
 * façon de vérifier qu'un cache sert vraiment.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');

let chromium = null;
let dispoNavigateur = false;
try {
  ({ chromium } = require('playwright'));
  dispoNavigateur = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent : la partie graphique se déclare ignorée */ }

// `heure` distincte à dessein : deux commits du MÊME jour à des heures différentes doivent
// compter pour UNE journée d'activité — c'est ce qui rend la mesure insensible au squash.
const mois = (recul, heure = 9) => {
  const n = new Date();
  const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - recul, 15, heure));
  return d.toISOString();
};

describe('Statistiques — activité des projets sur 6 mois', () => {
  let app;
  let suivi;
  let nonSuivi;
  let desactive;

  before(async () => {
    app = await startApp();
    await app.configure();
    suivi = (await app.api('POST', '/api/repos', { project: 'grp/actif', url: 'https://gitlab.test/grp/actif.git' })).body.id;
    nonSuivi = (await app.api('POST', '/api/repos', { project: 'grp/sans-mr', url: 'https://gitlab.test/grp/sans-mr.git' })).body.id;
    desactive = (await app.api('POST', '/api/repos', { project: 'grp/eteint', url: 'https://gitlab.test/grp/eteint.git' })).body.id;
    await app.api('PUT', `/api/repos/${nonSuivi}`, { url: 'https://gitlab.test/grp/sans-mr.git', enabled: 1, fetch_mrs: 0 });
    await app.api('PUT', `/api/repos/${desactive}`, { url: 'https://gitlab.test/grp/eteint.git', enabled: 0, fetch_mrs: 1 });

    // Des commits étalés : deux ce mois-ci, un il y a trois mois, deux auteurs distincts.
    app.state.commits['grp/actif'] = [
      { id: 'a1', committed_date: mois(0, 9), author_email: 'alice@example.com' },
      { id: 'a2', committed_date: mois(0, 17), author_email: 'bob@example.com' },
      { id: 'a3', committed_date: mois(3, 11), author_email: 'alice@example.com' },
    ];
    app.state.commits['grp/sans-mr'] = [{ id: 'z1', committed_date: mois(0), author_email: 'x@example.com' }];
  });

  after(async () => { await app.stop(); });

  const appelsPour = (projet) => app.state.calls
    .filter((c) => c.path.includes('/repository/commits') && c.path.includes(encodeURIComponent(projet))).length;

  test('seuls les dépôts SUIVIS sont comptés — ni éteints, ni sans récupération de MR', async () => {
    const { status, body } = await app.api('GET', '/api/dashboard/activity');
    assert.equal(status, 200);
    assert.equal(body.configured, true);
    assert.equal(body.months.length, 6, 'six mois, du plus ancien au plus récent');
    assert.deepEqual(body.projects.map((p) => p.project), ['grp/actif'],
      'un dépôt qu’on ne suit plus n’a pas à figurer dans une vue d’activité');
    assert.equal(appelsPour('grp/sans-mr'), 0, 'et ne doit coûter aucun appel à la forge');
    assert.equal(appelsPour('grp/eteint'), 0);
  });

  test('les commits sont répartis par mois, avec les contributeurs distincts', async () => {
    const p = (await app.api('GET', '/api/dashboard/activity')).body.projects[0];
    assert.equal(p.total, 3);
    assert.equal(p.counts[p.counts.length - 1], 2, 'deux commits ce mois-ci');
    assert.equal(p.counts[p.counts.length - 4], 1, 'un commit il y a trois mois');
    assert.equal(p.authors[p.authors.length - 1], 2, 'deux personnes distinctes ce mois-ci');
    assert.equal(p.contributeurs, 2, 'le mois le plus fourni fait référence');
    /* Les JOURS actifs portent la barre : deux commits le MÊME jour font une seule journée
       travaillée. C'est ce qui rend la mesure insensible au squash. */
    assert.equal(p.days[p.days.length - 1], 1, 'deux commits le même jour = un jour actif');
    assert.equal(p.days[p.days.length - 4], 1);
    assert.equal(p.totalDays, 2, 'deux journées d’activité sur les six mois');
  });

  /* Un mois CLOS ne change plus : le repayer à chaque ouverture de l'onglet coûterait des
     centaines de requêtes paginées pour un résultat connu. Seul le mois courant se rafraîchit,
     et pas plus d'une fois par demi-heure. */
  test('les mois déjà connus ne sont pas redemandés à la forge', async () => {
    await app.api('GET', '/api/dashboard/activity');
    const avant = appelsPour('grp/actif');
    await app.api('GET', '/api/dashboard/activity');
    assert.equal(appelsPour('grp/actif'), avant, 'deux visites de suite : aucun appel de plus');

    /* …mais une nouvelle activité du mois courant doit finir par se voir. On périme le cache
       du mois en cours comme le ferait le temps qui passe. */
    const dernier = (await app.api('GET', '/api/dashboard/activity')).body.months.slice(-1)[0];
    app.db.prepare("UPDATE commit_activity SET fetched_at = '2000-01-01T00:00:00.000Z' WHERE month = ?").run(dernier);
    app.state.commits['grp/actif'].push({ id: 'a4', committed_date: mois(0, 20), author_email: 'carol@example.com' });

    const apres = (await app.api('GET', '/api/dashboard/activity')).body.projects[0];
    assert.ok(appelsPour('grp/actif') > avant, 'le mois courant, lui, est bien redemandé');
    assert.equal(apres.counts[apres.counts.length - 1], 3, 'le nouveau commit apparaît');
    assert.equal(apres.authors[apres.authors.length - 1], 3);
  });

  test('un dépôt injoignable est signalé sur sa ligne, sans vider l’écran', async () => {
    const casse = (await app.api('POST', '/api/repos', { project: 'grp/casse', url: 'https://gitlab.test/grp/casse.git' })).body.id;
    app.state.fail['/projects/grp%2Fcasse/repository/commits'] = { status: 500, body: { message: 'dépôt inaccessible' } };
    const { body } = await app.api('GET', '/api/dashboard/activity');
    const ligne = body.projects.find((p) => p.project === 'grp/casse');
    assert.ok(ligne, 'le dépôt reste listé');
    assert.ok(ligne.erreur, 'avec la raison, plutôt qu’un zéro qui passerait pour un fait');
    assert.ok(body.projects.some((p) => p.project === 'grp/actif' && p.total > 0), 'les autres sont intacts');
    delete app.state.fail['/projects/grp%2Fcasse/repository/commits'];
    await app.api('DELETE', `/api/repos/${casse}`);
  });

  /* Le graphe lui-même : une barre par projet, hauteur = activité. C'est le format qui rend
     vingt dépôts lisibles d'un coup — une liste de vingt lignes ne l'est pas — et les dépôts
     endormis doivent y RESTER visibles, tout en bas de l'échelle, pas être masqués. */
  test('le graphe montre une barre par projet, endormis compris', { skip: dispoNavigateur ? false : 'chromium absent' }, async () => {
    // Vingt dépôts, dont six sans rien depuis deux mois.
    const mois = (await app.api('GET', '/api/dashboard/activity')).body.months;
    const ins = app.db.prepare(`INSERT OR REPLACE INTO commit_activity (repo_id, month, commits, authors, active_days, partiel, fetched_at)
                                VALUES (?,?,?,?,?,0,?)`);
    for (let i = 0; i < 20; i += 1) {
      const nom = `groupe/projet-${String(i).padStart(2, '0')}`;
      const id = (await app.api('POST', '/api/repos', { project: nom, url: `https://gitlab.test/${nom}.git` })).body.id;
      const dort = i >= 14;
      mois.forEach((m, k) => {
        const n = dort && k >= 4 ? 0 : (20 - i) + k;
        ins.run(id, m, n, 2, Math.min(20, n), new Date().toISOString());
      });
    }

    const nav = await chromium.launch();
    try {
      const page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
      await page.goto(app.base);
      await page.locator('[data-tab="dashboard"]').click();
      await page.waitForSelector('#dashActivity .pab');

      const barres = await page.locator('#dashActivity .pab').count();
      assert.ok(barres >= 20, `une barre par dépôt suivi (vu ${barres})`);
      assert.equal(await page.locator('#dashActivity .pab.dort').count(), 6,
        'les endormis sont marqués — et présents, pas masqués');

      // Chaque barre porte le nom de son projet en dessous.
      const noms = await page.$$eval('#dashActivity .pab-name', (n) => n.map((x) => x.textContent.trim()));
      assert.equal(noms.length, barres, 'chaque barre a son nom');
      assert.ok(noms.every((x) => x.length > 0));
      assert.ok(noms.includes('projet-00'), 'le nom court est affiché');
      const complet = await page.locator('#dashActivity .pab-name').first().getAttribute('title');
      assert.match(complet, /groupe\/projet-/, '…et le chemin complet reste au survol');

      // Le tout tient sans défilement vertical : c'est l'intérêt du format.
      const h = await page.locator('#dashActivity .pab-chart').evaluate((e) => e.getBoundingClientRect().height);
      assert.ok(h <= 260, `le graphe doit rester compact (vu ${Math.round(h)} px)`);
    } finally { await nav.close(); }
  });

  /* Le détail d'un projet : douze mois au lieu de six. C'est ce qui sépare « calme depuis
     deux mois » de « éteint depuis un an » — la vue d'ensemble ne peut pas les distinguer. */
  test('le détail d’un projet couvre 12 mois et nomme ses repères', async () => {
    const { status, body } = await app.api('GET', `/api/dashboard/activity/${suivi}`);
    assert.equal(status, 200);
    assert.equal(body.project, 'grp/actif');
    assert.equal(body.months.length, 12, 'douze mois, pas six');
    assert.equal(body.days.length, 12);
    assert.ok(body.totalDays >= 2);
    assert.ok(body.meilleurMois, 'le mois le plus actif est nommé, pas à chercher à l’œil');
    assert.ok(body.dernierActif, '…et la dernière activité aussi');
    assert.equal((await app.api('GET', '/api/dashboard/activity/999999')).status, 400,
      'un dépôt inconnu répond une erreur lisible');
  });

  test('la modale s’ouvre au clic sur le nom sous une barre', { skip: dispoNavigateur ? false : 'chromium absent' }, async () => {
    const nav = await chromium.launch();
    try {
      const page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
      await page.goto(app.base);
      await page.locator('[data-tab="dashboard"]').click();
      await page.waitForSelector('#dashActivity .pab');
      assert.equal(await page.locator('#activityModal').isHidden(), true, 'fermée tant qu’on ne demande rien');

      await page.locator('#dashActivity [data-pab-detail]').first().click();
      await page.waitForSelector('#activityModal:not([hidden]) .ad-chart');
      assert.equal(await page.locator('#activityModal .ad-col').count(), 12, 'une colonne par mois sur douze');
      const titre = await page.locator('#activityTitle').textContent();
      assert.match(titre, /grp\/|groupe\//, 'le titre nomme le projet');
      assert.equal(await page.locator('#activityModal .stat-tile').count(), 3, 'jours, commits, contributeurs');

      await page.locator('#activityClose').click();
      await page.waitForTimeout(200);
      assert.equal(await page.locator('#activityModal').isHidden(), true, 'et elle se referme');
    } finally { await nav.close(); }
  });

  test('sans forge configurée, on le dit au lieu d’afficher un écran vide', async () => {
    await app.api('PUT', '/api/config', { gitlab_url: '', access_token: '', github_url: '', github_token: '' });
    const { body } = await app.api('GET', '/api/dashboard/activity');
    assert.equal(body.configured, false);
    assert.deepEqual(body.projects, []);
    assert.equal(body.months.length, 6, 'les mois restent, pour que l’écran garde sa forme');
    await app.configure();
  });
});
