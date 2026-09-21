'use strict';
/* TRANSVERSE — LA COUCHE CLAVIER : LA FEUILLE « ? » ET LES RACCOURCIS GLOBAUX.
 *
 * Déjà éprouvés ailleurs, et donc pas rejoués ici : les chiffres dans l'ordre de la barre et la
 * plage « 1 – 9, 0 » (e2e-notes-ui), un menu masqué qui perd son chiffre (e2e-nav-prefs), « n »
 * la capture rapide (e2e-notes-ui, e2e-menu-notes-todos), « o » la palette (e2e-links-ui), « / »
 * dans Agents (e2e-qol-4e-passe) et dans les todos (e2e-menu-notes-todos), `j`/`k` sur les todos
 * et sur la grille des liens, les touches du viewer plein écran (e2e-diff-tree-ui).
 *
 * Ici, au navigateur, sur une file de merge requests RÉELLES (un dépôt nu, cloné par l'app) :
 *   - la feuille « ? » : ce qu'elle liste, la plage réelle quand seuls sept menus sont visibles,
 *     ses trois fermetures, et le bouton « ? » du bandeau qui l'ouvre aussi ;
 *   - les gardes : aucune touche globale quand une modale est ouverte, ni quand on écrit ;
 *   - « / » dans Dev IA et Réglages → Dépôts, et son repli sur Reviews depuis un onglet sans
 *     recherche ; « N » la nouvelle session ; « r » chercher les MR ; « l » le journal ;
 *   - le RAIL des cartes : `j`/`k`/Échap, `x` cocher, `c` contexte, `d` diff, `f` faire corriger,
 *     `v` vérifier, `m` classer (et son « Annuler »), Entrée reviewer ; Entrée sur un rapport ;
 *   - le chip de branche au clavier : Entrée copie le nom, ⇧+Entrée la commande de checkout.
 *
 * On vérifie à chaque fois l'EFFET — côté serveur quand il y en a un — jamais le seul fait que
 * la touche a été pressée. Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Transverse — la feuille des raccourcis et les touches globales', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repo;
  const id = {};
  const erreurs = [];

  const mrDe = (iid, titre) => ({
    iid, title: titre, state: 'opened', source_branch: repo.branch, target_branch: 'main',
    web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`, sha: repo.branchSha,
    author: { name: 'Alice' }, created_at: `2026-03-0${iid - 50}T10:00:00.000Z`,
    diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
  });
  const mr = async (iid) => (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === iid);

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [mrDe(51, 'Clavier un'), mrDe(52, 'Clavier deux'), mrDe(53, 'Clavier trois')];
    for (const iid of [51, 52, 53]) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }];
    await app.configure();
    const repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/verifiers', {
      name: 'tests clavier', kind: 'commands', commands: ['true'], repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    // Presse-papiers en mémoire : aucune permission de navigateur à accorder.
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(String(t)); }, readText: async () => window.__copies.at(-1) || '' },
      });
    });
    await page.goto(app.base);
    await page.waitForSelector('#toReviewList .card[data-id]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Aucune modale, aucune vue plein écran, aucun champ au focus : les touches globales écoutent.
  async function auCalme() {
    await page.evaluate(() => {
      document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; });
      const sv = document.querySelector('#splitView');
      if (sv && !sv.hidden) sv.hidden = true;
      if (document.activeElement) document.activeElement.blur();
    });
  }
  async function aller(onglet) {
    await auCalme();
    await page.locator(`nav button[data-tab="${onglet}"]`).click();
    await page.waitForSelector(`#tab-${onglet}.active`);
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  }
  // La file « À traiter » affiche exactement ces merge requests.
  async function file(iids) {
    await page.waitForFunction((attendus) => {
      const vus = [...document.querySelectorAll('#toReviewList .card[data-id]')].map((c) => Number(c.dataset.id)).sort((a, b) => a - b);
      return JSON.stringify(vus) === JSON.stringify([...attendus].sort((a, b) => a - b));
    }, iids.map((i) => id[i]));
  }
  const focalisee = () => page.evaluate(() => {
    const c = document.querySelector('.card.focused');
    return c ? Number(c.dataset.id) : null;
  });
  // Pose l'anneau sur la carte de cette MR, au clavier (`j` depuis le haut de la liste).
  async function viser(iid) {
    await page.keyboard.press('Escape');
    for (let i = 0; i < 10 && (await focalisee()) !== id[iid]; i += 1) await page.keyboard.press('j');
    assert.equal(await focalisee(), id[iid], `l’anneau est sur !${iid}`);
  }

  /* ------------------------------------------------------------ la feuille « ? » ---- */

  test('« ? » ouvre la feuille : toutes les touches, la plage réelle des chiffres, les pastilles', async () => {
    await aller('review');
    await page.keyboard.press('?');
    await page.waitForSelector('#shortcutsModal:not([hidden])');
    const touches = await page.locator('#shortcutsList .shortcut-row kbd').allTextContents();
    for (const k of ['Ctrl/Cmd + K', '/', 'j / k', 'Entrée', 'd', 'v', 'c', 'm', 'f', 'x', 'r', 'n', 'N', 'o', 'l', '?', 'Échap',
      'Ctrl/Cmd + Entrée', '⇧ + clic']) {
      assert.ok(touches.includes(k), `la touche « ${k} » est listée`);
    }
    // Sept menus visibles d'office (Git, Docker, Jenkins, Liens sont repliés) : « 1 – 7 ».
    const visibles = await page.locator('nav button[data-tab]:not([hidden])').count();
    assert.equal(visibles, 7);
    assert.ok(touches.includes('1 – 7'), `la plage suit la barre visible : ${touches.join(' | ')}`);
    assert.match(await page.locator('#shortcutsList .shortcut-titre').textContent(), /pastilles/i);
    await page.locator('#shortcutsClose').click();
    await page.waitForSelector('#shortcutsModal', { state: 'hidden' });
  });

  test('la feuille se ferme aussi par Échap et par un clic au fond ; le « ? » du bandeau l’ouvre', async () => {
    await auCalme();
    await page.locator('#footerHelp').click();
    await page.waitForSelector('#shortcutsModal:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#shortcutsModal', { state: 'hidden' });
    await page.keyboard.press('?');
    await page.waitForSelector('#shortcutsModal:not([hidden])');
    await page.locator('#shortcutsModal').click({ position: { x: 5, y: 5 } });
    await page.waitForSelector('#shortcutsModal', { state: 'hidden' });
  });

  /* ------------------------------------------------------------------- gardes ---- */

  test('une modale ouverte coupe les touches globales', async () => {
    await aller('review');
    await page.keyboard.press('?');
    await page.waitForSelector('#shortcutsModal:not([hidden])');
    await page.keyboard.press('2');
    await page.keyboard.press('N');
    assert.ok(await page.locator('#tab-review').evaluate((el) => el.classList.contains('active')), '« 2 » n’a pas changé d’onglet');
    assert.ok(await page.locator('#taskModal').evaluate((el) => el.hidden), '« N » n’a pas ouvert de session');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#shortcutsModal', { state: 'hidden' });
  });

  test('on écrit dans un champ : les lettres vont au champ, pas aux raccourcis', async () => {
    await aller('review');
    await page.locator('#searchReview').click();
    await page.keyboard.type('Nr2?');
    assert.equal(await page.locator('#searchReview').inputValue(), 'Nr2?');
    assert.ok(await page.locator('#taskModal').evaluate((el) => el.hidden));
    assert.ok(await page.locator('#shortcutsModal').evaluate((el) => el.hidden));
    assert.ok(await page.locator('#tab-review').evaluate((el) => el.classList.contains('active')));
    await page.locator('#searchReview').fill('');
    await file([51, 52, 53]);
  });

  /* ---------------------------------------------------------------- « / », N ---- */

  test('« / » dans Dev IA vise sa recherche, sans changer d’onglet', async () => {
    await aller('task');
    await page.waitForSelector('#taskSearch', { state: 'visible' });
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'taskSearch');
    assert.ok(await page.locator('#tab-task').evaluate((el) => el.classList.contains('active')));
  });

  test('« / » dans Réglages → Dépôts vise la recherche des dépôts', async () => {
    await aller('admin');
    await page.locator('#tab-admin .subnav [data-sub="repos"]').click();
    await page.waitForSelector('#repoSearch', { state: 'visible' });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('/');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'repoSearch');
  });

  test('« / » depuis un onglet sans recherche retombe sur celle de Reviews', async () => {
    await aller('dashboard');
    await page.keyboard.press('/');
    await page.waitForSelector('#tab-review.active');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'searchReview');
  });

  test('« N » ouvre une nouvelle session de codage depuis n’importe quel onglet', async () => {
    await aller('dashboard');
    await page.keyboard.press('N');
    await page.waitForSelector('#tab-task.active');
    await page.waitForSelector('#taskModal:not([hidden])');
    await auCalme();
  });

  /* ------------------------------------------------------------- le rail des cartes ---- */

  test('`j`/`k` déplacent l’anneau dans la file, Échap le retire', async () => {
    await aller('review');
    await file([51, 52, 53]);
    assert.equal(await focalisee(), null, 'aucun anneau avant la première touche');
    const ordre = await page.$$eval('#toReviewList .card[data-id]', (cs) => cs.map((c) => Number(c.dataset.id)));
    await page.keyboard.press('j');
    assert.equal(await focalisee(), ordre[0]);
    await page.keyboard.press('j');
    assert.equal(await focalisee(), ordre[1]);
    await page.keyboard.press('k');
    assert.equal(await focalisee(), ordre[0]);
    await page.keyboard.press('Escape');
    assert.equal(await focalisee(), null);
  });

  test('`x` coche la carte visée et montre la barre de sélection ; `x` de nouveau décoche', async () => {
    await aller('review');
    await file([51, 52, 53]);
    await viser(52);
    await page.keyboard.press('x');
    await page.waitForSelector('#mrBulkBar:not([hidden])');
    assert.ok(await page.locator(`#toReviewList .card[data-id="${id[52]}"] .mr-pick`).isChecked());
    await page.keyboard.press('x');
    await page.waitForSelector('#mrBulkBar', { state: 'hidden' });
  });

  test('`c` ouvre le contexte de la carte visée', async () => {
    await aller('review');
    await viser(51);
    await page.keyboard.press('c');
    await page.waitForSelector('#ticketModal:not([hidden])');
    assert.match(await page.locator('#ticketMrTitle').textContent(), /!51/);
    await auCalme();
  });

  test('`d` ouvre le diff de la carte visée ; Échap le referme', async () => {
    await aller('review');
    await viser(53);
    await page.keyboard.press('d');
    await page.waitForSelector('#splitView:not([hidden])');
    await page.waitForFunction(() => /!53/.test(document.querySelector('#splitTitle').textContent));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#splitView', { state: 'hidden' });
  });

  test('`f` ouvre « faire corriger » sur la branche de la carte visée', async () => {
    await aller('review');
    await viser(51);
    await page.keyboard.press('f');
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((b) => [...document.querySelectorAll('#taskModal input')].some((i) => i.value === b), repo.branch);
    await auCalme();
  });

  test('`v` propose le vérificateur pour la carte visée, et lancer crée la vérification', async () => {
    await aller('review');
    await viser(52);
    await page.keyboard.press('v');
    await page.waitForSelector('#verifyPickModal:not([hidden])');
    assert.match(await page.locator('#verifyPickWhat').textContent(), /!52/);
    await page.locator('#verifyPickGo').click();
    await attendreServeur(async () => {
      const b = (await app.api('GET', `/api/verifications?mr_id=${id[52]}`)).body;
      return (b.verifications || []).length > 0;
    }, 'une vérification existe pour !52');
    await waitForJobs(app.api);
  });

  test('`m` classe la carte visée ; « Annuler » du message la remet dans la file', async () => {
    await aller('review');
    await file([51, 52, 53]);
    await viser(53);
    await page.keyboard.press('m');
    await attendreServeur(async () => (await mr(53)).status === 'done', '!53 est classée');
    await file([51, 52]);
    const annuler = page.locator('#toasts .toast', { hasText: '!53' }).locator('.toast-btn');
    await annuler.click();
    await attendreServeur(async () => (await mr(53)).status === 'to_review', '!53 est revenue');
    await file([51, 52, 53]);
  });

  test('Entrée sur une carte visée de la file lance SA review', async () => {
    await aller('review');
    await file([51, 52, 53]);
    await viser(51);
    await page.keyboard.press('Enter');
    await attendreServeur(async () => (await mr(51)).status === 'reviewed', '!51 est reviewée', 60000);
    await waitForJobs(app.api);
    await file([52, 53]);
    assert.equal((await mr(52)).status, 'to_review', 'les autres ne sont pas parties');
  });

  /* BUG : `j`/`k` parcourent aussi `#reportList` (`listeCourante`), mais Entrée ne clique que
     le `.btn-primary` de la carte (public/app.js, `case 'Enter'` du gestionnaire global), et une
     carte de rapport n'en porte pas : on l'ouvre en cliquant la carte elle-même. La feuille
     « ? » promet « Action principale de la carte sélectionnée » — sur les stades « Reviewées »
     et « Traitées », Entrée ne fait rien. */
  test('Entrée sur un rapport visé l’ouvre, et l’adresse le désigne', async () => {
    await aller('review');
    await page.locator('.segmented [data-seg="reviewed"]').click();
    await page.waitForSelector(`#reportList .card[data-id="${id[51]}"]`);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('j');
    assert.equal(await focalisee(), id[51]);
    await page.keyboard.press('Enter');
    const ouvert = await page.waitForFunction((m) => window.location.hash === `#/reviews/${m}`, id[51], { timeout: 5000 })
      .then(() => true, () => false);
    assert.ok(ouvert, 'Entrée sur la carte de rapport visée n’a pas ouvert le rapport');
  });

  /* ------------------------------------------------------------------ r et l ---- */

  test('« r » sur Reviews cherche les nouvelles MR : celle arrivée entre-temps apparaît', async () => {
    app.state.mrs['grp/app'].push(mrDe(54, 'Clavier quatre, arrivée après'));
    app.state.changes['grp/app!54'] = [{ new_path: 'src/app.js' }];
    await aller('review');
    await page.locator('.segmented [data-seg="to_review"]').click();
    await file([52, 53]);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('r');
    await attendreServeur(async () => Boolean(await mr(54)), '!54 est découverte');
    id[54] = (await mr(54)).id;
    await page.waitForFunction(() => /Clavier quatre/.test(document.querySelector('#toReviewList').textContent));
    await waitForJobs(app.api);
  });

  test('« l » rouvre le journal masqué, puis plie et déplie son corps', async () => {
    await aller('review');
    /* Un job a tourné (la review de !51, la découverte) : le journal a quelque chose à montrer.
       Il a pu se replier tout seul après un succès ; sinon on le masque à la main. */
    if (await page.locator('#logPanel').isVisible()) await page.locator('#logHide').click();
    await page.waitForSelector('#logPanel', { state: 'hidden' });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('l');
    await page.waitForSelector('#logPanel:not([hidden])');
    const deplie = await page.locator('#logBox').evaluate((el) => !el.hidden);
    await page.keyboard.press('l');
    await page.waitForFunction((avant) => document.querySelector('#logBox').hidden === avant, deplie);
    await page.keyboard.press('l');
    await page.waitForFunction((avant) => document.querySelector('#logBox').hidden === !avant, deplie);
  });

  /* ------------------------------------------------------------ chip de branche ---- */

  test('le chip de branche au clavier : Entrée copie le nom, ⇧+Entrée la commande de checkout', async () => {
    await aller('review');
    await page.keyboard.press('Escape');                     // aucun anneau de carte
    /* La file se redessine quand un job ou une vérification change une carte : le chip qu'on a
       focalisé peut être REMPLACÉ avant la frappe, qui part alors sur `body`. On re-résout le
       chip et on refait le geste tant que l'EFFET (la copie) n'est pas là. */
    const copier = async (touche, attendu) => {
      await attendreServeur(async () => {
        await page.locator(`#toReviewList .card[data-id="${id[52]}"] .branch-chip`).first().focus();
        await page.keyboard.press(touche);
        return page.waitForFunction((a) => window.__copies.at(-1) === a, attendu, { timeout: 2000 }).then(() => true, () => false);
      }, `copie par ${touche}`);
    };
    await copier('Enter', repo.branch);
    await copier('Shift+Enter', `git fetch origin && git checkout ${repo.branch}`);
    assert.equal(await focalisee(), null, 'Entrée sur le chip ne lance pas le rail des cartes');
    assert.equal((await mr(52)).status, 'to_review', 'ni la review de la carte');
  });

  /* BUG : le gestionnaire du chip (public/app.js, `keydown` sur `[data-copy-branch]`) fait
     `stopPropagation()` — qui n'arrête PAS les autres écouteurs du même nœud `document`. Le
     rail des cartes, branché lui aussi sur `document`, voit donc la même Entrée : si une carte
     porte l'anneau, il clique son bouton principal. Copier le nom d'une branche lance alors la
     review d'une AUTRE merge request. */
  test('Entrée sur un chip ne déclenche pas l’action de la carte qui porte l’anneau', async () => {
    await aller('review');
    await file([52, 53, 54]);
    const reviews = [];
    const noter = (r) => { if (r.method() === 'POST' && /\/api\/mrs\/\d+\/review$/.test(new URL(r.url()).pathname)) reviews.push(r.url()); };
    page.on('request', noter);
    try {
      await viser(53);                               // l'anneau sur !53…
      await page.evaluate(() => { window.__copies.length = 0; });
      await attendreServeur(async () => {            // …et Entrée sur le chip de !52
        await page.locator(`#toReviewList .card[data-id="${id[52]}"] .branch-chip`).first().focus();
        await page.keyboard.press('Enter');
        return page.waitForFunction((a) => window.__copies.at(-1) === a, repo.branch, { timeout: 2000 }).then(() => true, () => false);
      }, 'la copie du nom');
      // Un aller-retour de plus : une requête partie pendant la frappe est forcément vue avant.
      await page.evaluate(() => fetch('/api/status').then((r) => r.text()));
      await waitForJobs(app.api);
      assert.deepEqual(reviews, [], 'aucune review n’est demandée par la frappe sur le chip');
      assert.equal((await mr(53)).status, 'to_review', '!53 n’a pas été reviewée');
    } finally {
      page.off('request', noter);
    }
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
