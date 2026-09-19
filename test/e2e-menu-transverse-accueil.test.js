'use strict';
/* TRANSVERSE — L'ACCUEIL, LES ÉTATS VIDES, LE BANDEAU ET LES NOTIFICATIONS, LA LANGUE.
 *
 * Déjà éprouvés ailleurs : la première minute sans rien de configuré et le bouton « go-config »
 * de l'assistant (e2e-premier-lancement), l'atterrissage sur le brief une fois par jour
 * (e2e-notes-ui), « clear-search » et « seg-reviewed » (e2e-menu-reviews-file),
 * « clear-note-filter » (e2e-menu-reviews-rapports), la permission et le bouton « Tester » des
 * notifications (e2e-menu-reglages-outils), le changement de langue qui recharge l'écran et part
 * au serveur (idem), le repli de la barre latérale (e2e-links-ui), la mise de côté d'une
 * fenêtre (e2e-modal).
 *
 * Ici, au navigateur :
 *   - l'assistant de démarrage APRÈS l'étape 1 : « Ajouter un dépôt » mène au champ, « Chercher
 *     les MR » ramène la file ; puis les autres portes des états vides — « Voir toutes » (filtre
 *     d'auteur), « À traiter » depuis des Reviewées vides, « Chercher » depuis une file à jour ;
 *   - le badge dry-run ;
 *   - le bandeau du bas : mode silencieux, live / stats, masquer / réafficher — et que chacun
 *     survit au rechargement ;
 *   - LES NOTIFICATIONS BUREAU POUR DE VRAI : muet, une fin de file ne notifie pas ; parlant,
 *     elle notifie, et cliquer la notification mène aux Reviewées ;
 *   - le chrono de l'en-tête : démarrer, mettre en pause, survivre au rechargement, remettre à zéro ;
 *   - l'anglais appliqué PARTOUT où l'écran se fabrique en JavaScript (barre, palette et ses
 *     résultats calculés par le serveur, feuille des raccourcis, bandeau, messages).
 *
 * L'API `Notification` est remplacée AVANT le chargement par une doublure qui garde les
 * notifications créées (et leur `onclick`) : un Chromium sans écran n'en affiche aucune.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Transverse — accueil, états vides, bandeau, notifications, langue', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let contexte; let page; let repo; let repoId;
  const erreurs = [];

  const mrDe = (iid, titre) => ({
    iid, title: titre, state: 'opened', source_branch: repo.branch, target_branch: 'main',
    web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`, sha: repo.branchSha,
    author: { name: 'Alice', username: 'alice' },
    diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
  });
  const mrs = async () => (await app.api('GET', '/api/mrs')).body;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [mrDe(61, 'First merge request')];
    app.state.changes['grp/app!61'] = [{ new_path: 'src/app.js' }];
    // Étape 1 franchie (forge connectée), rien d'autre : c'est là que commence ce fichier.
    await app.configure();

    navigateur = await lancerNavigateur();
    contexte = await navigateur.newContext({ viewport: { width: 1500, height: 1000 } });
    await contexte.addInitScript(() => {
      window.__notifs = [];
      class Doublure {
        constructor(titre, options) { this.titre = titre; this.corps = (options && options.body) || ''; window.__notifs.push(this); }
        close() { this.fermee = true; }
        static get permission() { return 'granted'; }
        static async requestPermission() { return 'granted'; }
      }
      window.Notification = Doublure;
    });
    page = await contexte.newPage();
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  async function recharger() {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="review"]');
  }
  async function auCalme() {
    await page.evaluate(() => {
      document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; });
      if (document.activeElement) document.activeElement.blur();
    });
  }
  async function reviews(seg = 'to_review') {
    await auCalme();
    await page.locator('nav button[data-tab="review"]').click();
    await page.locator(`.segmented [data-seg="${seg}"]`).click();
    await page.waitForSelector(`.segmented [data-seg="${seg}"].active`);
  }

  /* ------------------------------------------------- l'assistant de démarrage ---- */

  test('étape 1 cochée : « Ajouter un dépôt » mène à Réglages → Dépôts, curseur dans l’URL', async () => {
    await recharger();
    await reviews();
    await page.waitForSelector('#toReviewList .steps');
    await page.waitForSelector('#toReviewList .step.done');
    assert.equal(await page.locator('#toReviewList .step.done').count(), 1, 'seule la connexion est faite');
    await page.locator('#toReviewList [data-empty-act="go-repos"]').click();
    await page.waitForSelector('#tab-admin.active #sub-repos.active');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#repoForm [name="url"]'));
  });

  test('étape 3 : « Chercher les MR » de l’assistant ramène la file, et l’assistant s’efface', async () => {
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await recharger();
    await reviews();
    await page.waitForSelector('#toReviewList [data-empty-act="discover"]');
    assert.equal(await page.locator('#toReviewList .step.done').count(), 2);
    await page.locator('#toReviewList [data-empty-act="discover"]').click();
    await attendreServeur(async () => (await mrs()).some((m) => m.iid === 61), '!61 découverte');
    await page.waitForSelector('#toReviewList .card[data-id]');
    assert.equal(await page.locator('#toReviewList .steps').count(), 0, 'l’assistant a fini son travail');
    await waitForJobs(app.api);
  });

  /* ------------------------------------------------------- les autres portes ---- */

  test('filtre « de moi » sans résultat : « Toutes » le retire et rend la file', async () => {
    await recharger();                       // `/api/me` n'est lu qu'au chargement
    await reviews();
    await page.waitForSelector('#mrAuteurFiltre:not([hidden]) [data-mr-auteur="moi"]');
    await page.locator('#mrAuteurFiltre [data-mr-auteur="moi"]').click();
    await page.waitForSelector('#toReviewList [data-empty-act="clear-auteur"]');
    await page.locator('#toReviewList [data-empty-act="clear-auteur"]').click();
    await page.waitForSelector('#toReviewList .card[data-id]');
    await page.waitForSelector('#mrAuteurFiltre [data-mr-auteur="tous"].active');
    await page.waitForFunction(() => localStorage.getItem('aidevtools_mr_auteur') === 'tous');
  });

  test('Reviewées vides : « À traiter » ramène à la file', async () => {
    await reviews('reviewed');
    await page.waitForSelector('#reportList [data-empty-act="seg-to-review"]');
    await page.locator('#reportList [data-empty-act="seg-to-review"]').click();
    await page.waitForSelector('.segmented [data-seg="to_review"].active');
    await page.waitForSelector('#toReviewList .card[data-id]');
  });

  test('file à jour : « Chercher les nouvelles MR » de l’état vide ramène la suivante', async () => {
    const id61 = (await mrs()).find((m) => m.iid === 61).id;
    await app.api('POST', `/api/mrs/${id61}/done`);
    app.state.mrs['grp/app'].push(mrDe(62, 'Second merge request'));
    app.state.changes['grp/app!62'] = [{ new_path: 'src/app.js' }];
    await reviews('reviewed');
    await reviews('to_review');
    await page.waitForSelector('#toReviewList [data-empty-act="discover"]');
    assert.equal(await page.locator('#toReviewList .steps').count(), 0, 'c’est l’état « tout est traité », pas l’assistant');
    await page.locator('#toReviewList [data-empty-act="discover"]').click();
    await page.waitForFunction(() => /Second merge request/.test(document.querySelector('#toReviewList').textContent));
    await waitForJobs(app.api);
  });

  /* ------------------------------------------------------------- l'en-tête ---- */

  test('le badge dry-run est affiché, et dit ce qu’il signifie', async () => {
    await page.waitForSelector('#dryBadge:not([hidden])');
    assert.match(await page.locator('#dryBadge').getAttribute('title'), /simulés|IA/);
  });

  test('le chrono démarre, se met en pause, survit au rechargement et se remet à zéro', async () => {
    await page.waitForSelector('#chrono.idle');
    assert.equal(await page.locator('#chronoTime').textContent(), '00:00');
    await page.locator('#chronoStart').click();
    await page.waitForSelector('#chrono.running');
    await page.waitForFunction(() => document.querySelector('#chronoTime').textContent !== '00:00', null, { timeout: 10000 });
    await page.locator('#chronoPause').click();
    await page.waitForSelector('#chronoStart:not([hidden])');
    const fige = await page.locator('#chronoTime').textContent();
    assert.notEqual(fige, '00:00');
    await recharger();
    await page.waitForFunction((t) => document.querySelector('#chronoTime').textContent === t, fige);
    assert.equal(await page.locator('#chrono').evaluate((el) => el.classList.contains('running')), false, 'en pause, il le reste');
    await page.locator('#chronoReset').click();
    await page.waitForSelector('#chrono.idle');
    assert.equal(await page.locator('#chronoTime').textContent(), '00:00');
  });

  /* ------------------------------------------------------ le bandeau du bas ---- */

  test('« live / stats » bascule d’un clic, libellé et bulle compris', async () => {
    await page.waitForFunction(() => document.querySelector('#footerMode').textContent === 'live');
    await page.locator('#footerMode').click();
    await page.waitForFunction(() => document.querySelector('#footerMode').textContent === 'stats');
    assert.match(await page.locator('#footerMode').getAttribute('title'), /Mode stats/);
    await page.waitForFunction(() => localStorage.getItem('aidevtools_footer_mode') === 'stats');
  });

  /* BUG : le bandeau pose son mode retenu (`setMode`, public/app.js, « Bascule live / stats »)
     AVANT que `language()` n'applique les traductions statiques (`I18Nrt.applyStaticI18n()`,
     plus bas dans le même fichier). Le bouton porte `data-i18n="context.btn.live"` : son libellé
     est réécrit en « live » et sa bulle en « Mode d'affichage du bandeau » — alors que le
     bandeau est en mode stats. Le bouton ment, et le premier clic « vers stats » ramène en live. */
  test('le mode « stats » survit au rechargement, et le bouton le dit', async () => {
    try {
      await recharger();
      await page.waitForFunction(() => localStorage.getItem('aidevtools_footer_mode') === 'stats');
      // Le libellé est écrit une fois au chargement (script synchrone) : il ne bougera plus.
      await page.waitForSelector('#footerMode');
      assert.equal(await page.locator('#footerMode').textContent(), 'stats', 'le bouton dit le mode dans lequel est le bandeau');
    } finally {
      await page.evaluate(() => localStorage.setItem('aidevtools_footer_mode', 'live'));
      await recharger();
    }
  });

  test('masquer le bandeau laisse un bouton pour le rendre ; l’état survit au rechargement', async () => {
    await page.locator('#footerHide').click();
    await page.waitForSelector('#footer', { state: 'hidden' });
    await page.waitForSelector('#footerShow:not([hidden])');
    await recharger();
    await page.waitForSelector('#footerShow:not([hidden])');
    assert.ok(await page.locator('#footer').evaluate((el) => el.hidden));
    await page.locator('#footerShow').click();
    await page.waitForSelector('#footer:not([hidden])');
    await page.waitForSelector('#footerShow', { state: 'hidden' });
  });

  test('le mode silencieux se bascule d’un clic, le dit, et survit au rechargement', async () => {
    await page.locator('#footerMute').click();
    await page.waitForSelector('#footerMute.on');
    await page.waitForSelector('#toasts .toast:has-text("Notifications coupées")');
    assert.equal(await page.locator('#footerMute use').getAttribute('href'), '#i-bell-off');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('mergerie_notif') || '{}').muted === true);
    await recharger();
    await page.waitForSelector('#footerMute.on');
  });

  /* ------------------------------------------------------ les notifications ---- */

  // Lance une review de cette MR et attend que la PAGE ait relevé l'événement de fin de file.
  async function reviewerEtAttendreLeRelevé(iid) {
    const id = (await mrs()).find((m) => m.iid === iid).id;
    await app.api('POST', `/api/mrs/${id}/reopen`);
    const releve = page.waitForResponse(async (r) => {
      if (!/\/api\/notifications\?after=/.test(r.url())) return false;
      try { return ((await r.json()).events || []).some((e) => e.type === 'queue_done'); } catch { return false; }
    }, { timeout: 60000 });
    const r = await app.api('POST', '/api/jobs/review', { mr_ids: [id] });
    assert.ok(r.status < 300, r.text);
    await waitForJobs(app.api);
    await releve;
    // Un aller-retour de plus : le traitement de la réponse relevée est fini.
    await page.evaluate(() => fetch('/api/status').then((x) => x.text()));
  }

  test('muet : une fin de file ne crée AUCUNE notification bureau', async () => {
    await page.waitForSelector('#footerMute.on');
    await page.evaluate(() => { window.__notifs.length = 0; });
    await reviewerEtAttendreLeRelevé(62);
    assert.deepEqual(await page.evaluate(() => window.__notifs.map((n) => n.titre)), []);
  });

  test('parlant : la fin de file notifie, et cliquer la notification ouvre les Reviewées', async () => {
    await page.locator('#footerMute').click();
    await page.waitForSelector('#footerMute:not(.on)');
    await page.evaluate(() => { window.__notifs.length = 0; });
    await page.locator('nav button[data-tab="dashboard"]').click();
    await reviewerEtAttendreLeRelevé(61);
    await page.waitForFunction(() => window.__notifs.some((n) => n.titre === 'File de reviews terminée'));
    await page.evaluate(() => window.__notifs.find((n) => n.titre === 'File de reviews terminée').onclick());
    await page.waitForSelector('#tab-review.active .segmented [data-seg="reviewed"].active');
    assert.ok(await page.evaluate(() => window.__notifs.find((n) => n.titre === 'File de reviews terminée').fermee),
      'la notification se referme une fois suivie');
  });

  /* ---------------------------------------------------------------- la langue ---- */

  test('en anglais, ce que le JavaScript fabrique est en anglais aussi', async () => {
    await app.api('POST', '/api/verifiers', {
      name: 'unit tests', kind: 'commands', commands: ['true'], repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    await auCalme();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="config"]').click();
    await Promise.all([page.waitForEvent('load'), page.locator('#langSelect').selectOption('en')]);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.waitForSelector('nav button[data-tab="review"]');
    try {
      // La barre et l'en-tête.
      assert.equal((await page.locator('nav button[data-tab="admin"]').textContent()).trim(), 'Settings');
      assert.equal((await page.locator('nav button[data-tab="task"] [data-i18n]').textContent()).trim(), 'AI Dev');
      assert.match(await page.locator('#paletteTrigger').textContent(), /Search a link/);

      // La palette : actions du client ET résultats libellés par le serveur.
      await page.locator('#paletteTrigger').click();
      // Deux sections ici (des MR, aucune session) : la réponse du serveur est arrivée.
      await page.waitForFunction(() => document.querySelectorAll('#paletteList .palette-head').length === 2);
      assert.deepEqual(await page.locator('#paletteList .palette-head').allTextContents(), ['Actions', 'Recent merge requests']);
      await page.locator('#paletteInput').fill('unit tests');
      await page.waitForFunction(() => [...document.querySelectorAll('#paletteList .palette-label')].some((l) => /^Verify with/.test(l.textContent)));
      await page.locator('#paletteInput').fill('settings');
      await page.waitForFunction(() => [...document.querySelectorAll('#paletteList .palette-label')].some((l) => l.textContent === 'Go to settings'));
      await page.keyboard.press('Escape');
      await page.waitForSelector('#paletteModal', { state: 'hidden' });

      // La feuille des raccourcis, composée au rendu (le curseur est resté dans la palette).
      await auCalme();
      await page.keyboard.press('?');
      await page.waitForSelector('#shortcutsModal:not([hidden])');
      const aide = await page.locator('#shortcutsModal').innerText();
      assert.match(aide, /Keyboard shortcuts/);
      assert.match(aide, /Command palette/);
      assert.doesNotMatch(aide, /Palette de commandes|Changer d'onglet|Cette aide/, 'aucune ligne restée en français');
      await page.keyboard.press('Escape');

      // Le bandeau, et un message.
      assert.match(await page.locator('#footerMute').getAttribute('title'), /Mute desktop notifications/);
      await page.locator('#footerMute').click();
      await page.waitForSelector('#toasts .toast:has-text("Notifications muted")');
      await page.locator('#footerMute').click();
      await page.waitForSelector('#footerMute:not(.on)');

      // Les cartes et leurs étiquettes.
      await page.locator('nav button[data-tab="review"]').click();
      await page.locator('.segmented [data-seg="reviewed"]').click();
      await page.waitForSelector('#reportList .card[data-id]');
      const carte = await page.locator('#reportList .card[data-id]').first().innerText();
      assert.doesNotMatch(carte, /Reviewée|Traitée|À traiter/, `étiquettes en anglais : ${carte}`);
    } finally {
      await auCalme();
      await page.locator('nav button[data-tab="admin"]').click();
      await page.locator('#tab-admin .subnav [data-sub="config"]').click();
      await Promise.all([page.waitForEvent('load'), page.locator('#langSelect').selectOption('fr')]);
      await page.waitForFunction(() => document.documentElement.lang === 'fr');
    }
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
