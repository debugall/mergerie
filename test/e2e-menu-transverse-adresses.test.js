'use strict';
/* TRANSVERSE — LES ADRESSES DES OBJETS (`#/reviews/…`, `#/sessions/…`, `#/notes/…`).
 *
 * Déjà éprouvés ailleurs : chaque saveur de `#/sessions/<saveur>/<id>` chargée depuis l'URL
 * (e2e-menu-devia-liste), `#/notes/<id>` au chargement (e2e-qol-4e-passe), et l'adresse ÉCRITE
 * quand on ouvre un rapport, une session ou une page depuis un écran (menus Reviews, Notes,
 * Statistiques, Agents).
 *
 * Ici, le routage lui-même, au navigateur :
 *   - `#/reviews/<id>` AU CHARGEMENT, pour une MR reviewée puis pour une MR traitée (le bon stade) ;
 *   - l'ancienne forme `#/sessions/<id>` (sans saveur) ;
 *   - ce qui ne mène nulle part — objet disparu, route inconnue, `#/jira/…` qui n'existe pas —
 *     ne casse rien et n'emmène nulle part ;
 *   - un lien collé dans l'application ouverte (`hashchange`) ;
 *   - Précédent / Suivant du navigateur entre deux rapports et une page ;
 *   - changer d'onglet oublie l'adresse, et le rechargement suivant ne ramène pas à l'objet ;
 *   - un clic pendant un routage encore en vol gagne ;
 *   - le lien l'emporte sur la restauration du dernier onglet, et sur le brief du matin.
 *
 * Chaque scénario de chargement ouvre un CONTEXTE neuf (stockage vierge, ou préparé avant le
 * premier script) : c'est la situation de quelqu'un qui clique un lien reçu.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const seed = require('./helpers/stats-seed');

const { dispo } = navigateurDispo();

describe('Transverse — les adresses des objets et l’historique du navigateur', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let donnees; let pageNote;
  const contextes = [];
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    donnees = await seed.semerTout(app);
    pageNote = (await app.api('POST', '/api/notes', { title: 'Page adressée', content: '# ici' })).body;
    navigateur = await lancerNavigateur();
  });

  after(async () => {
    for (const c of contextes) await c.close().catch(() => {});
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Une page dans un contexte NEUF. `stockage` est posé avant le premier script de la page —
     une seule fois : un rechargement garde ce que l'application a écrit depuis. */
  async function nouvellePage({ onglet = null, briefVu = true } = {}) {
    const contexte = await navigateur.newContext({ viewport: { width: 1500, height: 1000 } });
    contextes.push(contexte);
    await contexte.addInitScript(({ o, vu }) => {
      try {
        if (sessionStorage.getItem('__pose')) return;
        sessionStorage.setItem('__pose', '1');
        if (o) localStorage.setItem('aidevtools_tab', o);
        if (vu) localStorage.setItem('mergerie_brief_seen', new Date().toDateString());
      } catch { /* stockage refusé */ }
    }, { o: onglet, vu: briefVu });
    const page = await contexte.newPage();
    page.on('pageerror', (e) => erreurs.push(e.message));
    return page;
  }
  const hash = (page) => page.evaluate(() => window.location.hash);
  const actif = async (page, onglet) => page.locator(`#tab-${onglet}`).evaluate((el) => el.classList.contains('active'));
  // Le rapport de cette MR est à l'écran (son titre est dans le détail, et l'adresse le désigne).
  async function rapportOuvert(page, mrId, titre) {
    await page.waitForFunction((h) => window.location.hash === h, `#/reviews/${mrId}`);
    await page.waitForFunction((t) => (document.querySelector('#reportDetail') || {}).textContent?.includes(t), titre);
  }

  /* ------------------------------------------------------ au chargement ---- */

  test('#/reviews/<id> d’une MR reviewée ouvre Reviews → Reviewées sur son rapport', async () => {
    const page = await nouvellePage();
    await page.goto(`${app.base}/#/reviews/${donnees.mr.a2}`);
    await rapportOuvert(page, donnees.mr.a2, 'Alpha mal notée');
    await page.waitForSelector('#tab-review.active .segmented [data-seg="reviewed"].active');
    await page.waitForSelector(`#reportList .card.active[data-id="${donnees.mr.a2}"]`);
  });

  test('#/reviews/<id> d’une MR traitée ouvre le stade « Traitées »', async () => {
    const page = await nouvellePage();
    await page.goto(`${app.base}/#/reviews/${donnees.mr.a3}`);
    await rapportOuvert(page, donnees.mr.a3, 'Alpha traitée');
    await page.waitForSelector('#tab-review.active .segmented [data-seg="done"].active');
  });

  test('l’ancienne forme #/sessions/<id> (sans saveur) ouvre la session de codage', async () => {
    const page = await nouvellePage();
    await page.goto(`${app.base}/#/sessions/${donnees.t.code}`);
    await page.waitForSelector('#tab-task.active .subnav [data-kind="code"].active');
    await page.waitForSelector(`#tab-task.active #taskList .task-row[data-task="${donnees.t.code}"]`);
    // L'adresse est réécrite sous sa forme complète : c'est elle qu'on copiera ensuite.
    await page.waitForFunction((h) => window.location.hash === h, `#/sessions/code/${donnees.t.code}`);
  });

  test('un objet disparu (#/reviews/999999) ne mène nulle part et ne casse rien', async () => {
    const page = await nouvellePage();
    const avant = erreurs.length;
    await page.goto(`${app.base}/#/reviews/999999`);
    await page.waitForSelector('#tab-review.active');
    // La liste des reviewées est arrivée : le routage a eu sa réponse, et s'est arrêté là.
    await page.waitForSelector('#reportList .card[data-id]');
    assert.equal(await page.locator('#reportList .card.active').count(), 0, 'aucun rapport n’est ouvert');
    assert.equal(erreurs.length, avant, 'aucune erreur JavaScript');
  });

  for (const route of ['#/inconnu/12', '#/jira/PROJ-1', '#/reviews/', '#/sessions/code/abc']) {
    test(`une adresse sans objet (${route}) laisse l’application ouvrir son écran habituel`, async () => {
      const page = await nouvellePage({ onglet: 'dashboard' });
      const avant = erreurs.length;
      await page.goto(`${app.base}/${route}`);
      await page.waitForSelector('#tab-dashboard.active');
      await page.waitForSelector('#dashboard [data-rec-rule], #dashboard .card', { state: 'attached' });
      assert.equal(erreurs.length, avant, 'aucune erreur JavaScript');
    });
  }

  /* --------------------------------------------------- application ouverte ---- */

  test('un lien collé dans l’application ouverte (hashchange) ouvre l’objet', async () => {
    const page = await nouvellePage({ onglet: 'dashboard' });
    await page.goto(app.base);
    await page.waitForSelector('#tab-dashboard.active');
    await page.evaluate((id) => { window.location.hash = `#/notes/${id}`; }, pageNote.id);
    await page.waitForSelector('#tab-notes.active #notesSubPages:not([hidden])');
    await page.waitForFunction((t) => (document.querySelector('#pageTitle') || {}).value === t, 'Page adressée');
  });

  test('Précédent et Suivant parcourent les rapports et la page ouverts', async () => {
    const page = await nouvellePage();
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    await page.locator('.segmented [data-seg="reviewed"]').click();
    await page.locator(`#reportList .card[data-id="${donnees.mr.a2}"]`).click();
    await rapportOuvert(page, donnees.mr.a2, 'Alpha mal notée');
    await page.locator(`#reportList .card[data-id="${donnees.mr.b1}"]`).click();
    await rapportOuvert(page, donnees.mr.b1, 'Beta bien notée');
    await page.evaluate((id) => { window.location.hash = `#/notes/${id}`; }, pageNote.id);
    await page.waitForFunction((t) => (document.querySelector('#pageTitle') || {}).value === t, 'Page adressée');

    await page.goBack();
    await page.waitForSelector('#tab-review.active');
    await rapportOuvert(page, donnees.mr.b1, 'Beta bien notée');
    await page.goBack();
    await rapportOuvert(page, donnees.mr.a2, 'Alpha mal notée');
    await page.goForward();
    await rapportOuvert(page, donnees.mr.b1, 'Beta bien notée');
    await page.goForward();
    await page.waitForSelector('#tab-notes.active');
    await page.waitForFunction((h) => window.location.hash === h, `#/notes/${pageNote.id}`);
  });

  test('changer d’onglet oublie l’adresse ; le rechargement rouvre l’onglet, pas l’objet', async () => {
    const page = await nouvellePage();
    await page.goto(`${app.base}/#/reviews/${donnees.mr.a2}`);
    await rapportOuvert(page, donnees.mr.a2, 'Alpha mal notée');
    await page.locator('nav button[data-tab="dashboard"]').click();
    await page.waitForSelector('#tab-dashboard.active');
    assert.equal(await hash(page), '', 'l’adresse de l’objet est quittée avec lui');
    await page.reload();
    await page.waitForSelector('#tab-dashboard.active');
    assert.equal(await hash(page), '');
    assert.equal(await actif(page, 'review'), false);
  });

  test('un clic pendant un routage encore en vol gagne sur le routage', async () => {
    const page = await nouvellePage();
    // On RETIENT la liste des reviewées : le routage attend dessus tant qu'on ne la libère pas.
    let liberer;
    const retenue = new Promise((r) => { liberer = r; });
    let vue = false;
    await page.route(/\/api\/mrs\?status=reviewed/, async (route) => { vue = true; await retenue; await route.continue(); });
    const rapports = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === `/api/mrs/${donnees.mr.a2}`) rapports.push(r.url()); });

    await page.goto(`${app.base}/#/reviews/${donnees.mr.a2}`);
    await page.waitForSelector('#tab-review.active');
    await attendreServeur(async () => vue, 'le routage attend la liste');
    await page.locator('nav button[data-tab="notes"]').click();       // l'utilisateur reprend la main
    await page.waitForSelector('#tab-notes.active');
    liberer();
    // La liste arrive et se dessine : le routage a eu sa réponse, et doit s'être abstenu.
    await page.waitForSelector('#reportList .card[data-id]', { state: 'attached' });
    await page.evaluate(() => fetch('/api/status').then((r) => r.text()));
    assert.equal(await actif(page, 'notes'), true, 'on reste là où l’on a cliqué');
    assert.equal(await hash(page), '', 'aucune adresse posée après coup');
    assert.deepEqual(rapports, [], 'le rapport n’a même pas été demandé');
    await page.unroute(/\/api\/mrs\?status=reviewed/);
  });

  /* ------------------------------------------------ le lien contre l'accueil ---- */

  /* BUG : `restoreTab()` (public/app.js, « Init ») met en file l'ouverture du DERNIER onglet
     (`queueMicrotask(atterrir)`) ; `ouvrirDepuisAdresse()` part avant, pose `enRoutage`, et le
     clic de restauration — qui ne s'annonce pas comme un geste de l'utilisateur — passe donc
     sans annuler le routage mais en CHANGEANT d'onglet. Le rapport s'ouvre dans l'onglet
     Reviews… masqué derrière celui de la dernière visite. Le commentaire promet l'inverse :
     « une adresse collée l'emporte sur le dernier onglet ». */
  test('le lien l’emporte sur la restauration du dernier onglet', async () => {
    const page = await nouvellePage({ onglet: 'dashboard' });
    await page.goto(`${app.base}/#/reviews/${donnees.mr.a2}`);
    await rapportOuvert(page, donnees.mr.a2, 'Alpha mal notée');
    assert.equal(await actif(page, 'review'), true, 'on voit le rapport du lien, pas les statistiques de la veille');
  });

  /* Même course, par l'autre chemin : à la première ouverture du jour, le brief est posé APRÈS la
     réponse de /api/config, donc après le départ du routage — et il gagne. */
  test('le lien l’emporte sur le brief du matin à la première ouverture du jour', async () => {
    await app.api('PUT', '/api/config', { brief_on_open: '1' });
    try {
      const page = await nouvellePage({ briefVu: false });
      await page.goto(`${app.base}/#/reviews/${donnees.mr.a2}`);
      await rapportOuvert(page, donnees.mr.a2, 'Alpha mal notée');
      // Le brief a été décidé (il est marqué vu) : l'écran ne bougera plus.
      await page.waitForFunction(() => localStorage.getItem('mergerie_brief_seen') === new Date().toDateString());
      await page.evaluate(() => fetch('/api/status').then((r) => r.text()));
      assert.equal(await actif(page, 'review'), true, 'on voit le rapport du lien, pas le brief');
    } finally {
      await app.api('PUT', '/api/config', { brief_on_open: '0' });
    }
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
