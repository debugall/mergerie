'use strict';
/* LES FORMULAIRES, APRÈS LA DEUXIÈME REVUE DESIGN.
 *
 * Cette revue-là ne parlait pas de couleurs : elle disait qu'un formulaire ne dit pas ce qu'il
 * fait. Chaque test ci-dessous fixe une de ses conclusions à un fait vérifiable à l'écran —
 * l'ordre des champs, le mot du bouton, l'endroit où l'erreur se pose, ce qui reste atteignable
 * au clavier. Ce sont des faits d'INTERFACE : ils tiennent dans un navigateur, pas dans l'API.
 *
 * Un seul `startApp()` : le harnais démarre le serveur EN PROCESSUS, un second appel dans le
 * même fichier attend un « listening » qui ne viendra jamais.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Formulaires — deuxième revue design', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repoId; let mrId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    app.state.mrs['groupe/api-core'] = [{
      iid: 42, title: 'Ajoute /health', state: 'opened',
      source_branch: 'feature/health', target_branch: 'main',
      web_url: 'https://gitlab.test/groupe/api-core/-/merge_requests/42',
      sha: 'aaaa', created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: 'bbbb', start_sha: 'bbbb', head_sha: 'aaaa' },
    }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/groupe/api-core.git', project: 'groupe/api-core' })).body.id;
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/groupe/webapp.git', project: 'groupe/webapp' });
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* ---------- La modale de session ---------- */

  /* Chaque test part d'un écran propre : une assertion qui casse ne doit pas laisser une modale
     ouverte au suivant, qui échouerait alors pour une autre raison que la sienne — et le
     diagnostic porterait sur le mauvais écran. */
  async function ecranPropre() {
    await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
  }

  async function ouvrirSession(kind = 'code') {
    await ecranPropre();
    await page.click('nav button[data-tab="task"]');
    await page.click(`#tab-task .subnav [data-kind="${kind}"]`);
    await page.click('#btnNewTask');
    await page.waitForSelector('#taskModal:not([hidden])', { timeout: ATTENTE });
  }
  async function fermerSession() {
    await page.click('#taskCancel');
    await page.waitForFunction(() => document.querySelector('#taskModal').hidden, null, { timeout: ATTENTE });
  }

  test('ce qu’on vient dire se lit en premier, et le curseur y est déjà', async () => {
    await ouvrirSession('code');
    /* Le pied de la modale (`.modal-actions`) vit dans le formulaire : on regarde les CHAMPS. */
    const ordre = await page.$$eval('#taskForm > *:not(.modal-actions)', (els) => els.filter((e) => !e.hidden)
      .map((e) => e.id || ((e.querySelector('textarea, input, select') || {}).name) || e.tagName));
    assert.equal(ordre[0], 'prompt', 'la tâche à réaliser ouvre le formulaire');
    assert.ok(ordre.indexOf('taskReposWrap') > 0, 'le bloc des projets vient APRÈS le prompt');
    assert.ok(ordre.indexOf('label') > ordre.indexOf('taskReposWrap'), 'le libellé suit les projets');
    assert.ok(ordre.indexOf('taskImages') > ordre.indexOf('codeOnlyFields'),
      'les pièces jointes passent après les décisions qui changent le résultat');
    assert.equal(ordre[ordre.length - 1], 'taskAdvanced', 'l’avancé ferme le formulaire');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'prompt');
    await fermerSession();
  });

  test('l’avancé groupe les trois champs qu’on ne touche pas, et reste déplié', async () => {
    await ouvrirSession('code');
    /* REGROUPÉS, PAS CACHÉS. Ils s'intercalaient entre le libellé et la décision de vérifier ;
       ils ferment maintenant le formulaire, sous un titre qui dit ce qu'ils sont — et le bloc
       s'ouvre déplié : ce qui compte est qu'ils ne coupent plus le parcours principal, pas
       qu'ils disparaissent. Le repli reste à la main de qui veut de l'air. */
    assert.equal(await page.locator('#taskAdvanced').evaluate((e) => e.open), true,
      'déplié par défaut : on doit voir ce qu’on peut régler sans avoir à le chercher');
    const dedans = await page.$$eval('#taskAdvanced input, #taskAdvanced textarea',
      (els) => els.map((e) => e.name).filter(Boolean));
    assert.deepEqual(dedans.sort(), ['ask_questions', 'commit_message', 'session_id']);
    assert.equal(await page.locator('#taskAdvanced [name="session_id"]').isVisible(), true,
      'et ils sont vraiment à l’écran, pas seulement dans le DOM');
    await fermerSession();
  });

  test('un verbe par effet : « Créer et lancer » lance, « Créer la session » non', async () => {
    await ouvrirSession('code');
    assert.deepEqual(await page.$$eval('#taskModal .modal-actions button',
      (els) => els.filter((e) => !e.hidden).map((e) => e.textContent.trim())),
    ['Annuler', 'Créer la session'], 'une session de codage se crée sans se lancer');
    await fermerSession();

    for (const kind of ['local', 'ask']) {
      await ouvrirSession(kind);
      assert.deepEqual(await page.$$eval('#taskModal .modal-actions button',
        (els) => els.filter((e) => !e.hidden).map((e) => e.textContent.trim())),
      ['Annuler', 'Créer sans lancer', 'Créer et lancer'],
      `${kind} : le même effet porte le même mot, quelle que soit la saveur`);
      await fermerSession();
    }
  });

  test('« Converger » quitte le pied et devient une case qui dit son seuil', async () => {
    await ouvrirSession('code');
    assert.equal(await page.locator('#taskConverge').count(), 0, 'plus de second bouton primaire');
    const libelle = await page.locator('#taskConvergeLbl').textContent();
    assert.match(libelle, /8\/10/, 'le seuil par défaut est annoncé');
    assert.match(libelle, /3 passes/, 'le plafond de passes aussi');
    assert.equal(await page.locator('#taskConvergeRow').evaluate((e) => e.hidden), false);
    await fermerSession();
  });

  test('les ⓘ ne sont plus des arrêts de tabulation, et leur bulle n’ouvre que sur eux', async () => {
    await ouvrirSession('code');
    assert.equal(await page.$$eval('#taskModal .hint',
      (els) => els.filter((e) => e.offsetParent !== null && e.tabIndex >= 0).length), 0,
    'seize arrêts pour huit champs : les ⓘ sortent du parcours');

    /* CLIQUER DANS UN CHAMP N'OUVRE RIEN. Une version montrait la bulle au focus du champ pour
       compenser les icônes sorties du parcours : elle s'affichait par-dessus le champ qu'on
       venait de cliquer, masquant ce qu'on allait y écrire. */
    await page.click('#taskForm textarea[name="prompt"]');
    assert.equal(await page.locator('#tip').evaluate((e) => e.classList.contains('on')), false,
      'la bulle ne s’ouvre pas sur un champ qu’on vient de cliquer');

    // …et le survol de l'ⓘ, lui, l'ouvre toujours.
    await page.locator('#taskForm label:has(textarea[name="prompt"]) .hint').hover();
    await page.waitForFunction(() => {
      const t = document.querySelector('#tip');
      return t && t.classList.contains('on') && t.textContent.trim().length > 0;
    }, null, { timeout: ATTENTE });
    await fermerSession();
  });

  /* ---------- Réglages → Merge Request ---------- */

  async function ouvrirReglages(sub) {
    await ecranPropre();
    await page.click('nav button[data-tab="admin"]');
    await page.click(`button[data-sub="${sub}"]`);
    await page.waitForFunction((s) => document.querySelector(`#sub-${s}`).classList.contains('active'),
      sub, { timeout: ATTENTE });
  }

  test('neuf réglages en vrac deviennent trois groupes titrés', async () => {
    await ouvrirReglages('mr');
    const ordre = await page.$$eval('#sub-mr > .form > *',
      (els) => els.map((e) => (e.tagName === 'H3' ? `# ${e.textContent}` : ((e.querySelector('input') || {}).name || e.tagName))));
    assert.deepEqual(ordre, [
      '# Review', 'review_explain', 'auto_post_review',
      '# Automatisation', 'auto_refresh_minutes', 'auto_review_new', 'review_auto_max', 'auto_rereview_stale',
      '# Convergence', 'converge_threshold', 'converge_max_passes',
    ], 'l’interrupteur et son plafond ne sont plus séparés par un autre réglage');
  });

  test('le plafond des reviews auto est indenté sous sa case, et éteint avec elle', async () => {
    await ouvrirReglages('mr');
    const lire = () => page.locator('#reviewAutoMaxRow').evaluate((e) => ({
      indente: e.classList.contains('sous-reglage'),
      eteint: e.classList.contains('is-off'),
      desactive: e.querySelector('input').disabled,
    }));
    const coche = await page.locator('#sub-mr input[name="auto_review_new"]').isChecked();
    if (coche) await page.click('#sub-mr input[name="auto_review_new"]');
    assert.deepEqual(await lire(), { indente: true, eteint: true, desactive: true },
      'un plafond sans automatisme ne veut rien dire');
    await page.click('#sub-mr input[name="auto_review_new"]');
    assert.deepEqual(await lire(), { indente: true, eteint: false, desactive: false });
  });

  test('le plafond des vérifications a rejoint son interrupteur, dans Vérificateurs', async () => {
    assert.equal(await page.locator('#sub-mr input[name="verif_auto_max"]').count(), 0,
      'il n’est plus dans Merge Request');
    await ouvrirReglages('verifiers');
    await page.waitForFunction(() => {
      const c = document.querySelector('#sub-verifiers input[name="verif_auto_max"]');
      return c && c.value !== '';
    }, null, { timeout: ATTENTE });
    assert.equal(await page.locator('#sub-verifiers input[name="verif_auto_max"]').inputValue(), '5',
      'et il affiche la valeur du serveur, pas un champ vide');
  });

  test('« modifications non enregistrées » suit d’un sous-onglet à l’autre, et s’efface à l’enregistrement', async () => {
    await ouvrirReglages('mr');
    await page.fill('#sub-mr input[name="converge_max_passes"]', '4');
    await page.waitForFunction(() => document.querySelector('#configInfoMr').textContent.includes('non enregistr'),
      null, { timeout: ATTENTE });
    await ouvrirReglages('jiracfg');
    assert.match(await page.locator('#configInfoJira').textContent(), /non enregistr/,
      'changer de sous-onglet ne fait pas disparaître l’avertissement');
    await ouvrirReglages('mr');
    assert.equal(await page.locator('#sub-mr input[name="converge_max_passes"]').inputValue(), '4',
      'et la valeur tapée n’est pas écrasée par le serveur au retour');
    await page.click('#sub-mr .form-actions button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#configInfoMr').textContent.includes('non enregistr'),
      null, { timeout: ATTENTE });
    const c = await app.api('GET', '/api/config');
    assert.equal(String(c.body.converge_max_passes), '4', 'et c’est bien parti au serveur');
  });

  /* ---------- Les formulaires de connexion ---------- */

  test('les quatre boutons « tester » ont la même garde à vide, sous le champ', async () => {
    await ouvrirReglages('gitcfg');
    await page.fill('[name="gitlab_url"]', '');
    await page.click('#btnTestGitlab');
    await page.waitForSelector('#sub-gitcfg .field-error', { timeout: ATTENTE });
    assert.match(await page.locator('#sub-gitcfg .field-error').first().textContent(), /URL GitLab/);
    assert.equal(await page.locator('.toast').count(), 0, 'une erreur de champ n’est pas un toast');

    await ouvrirReglages('jenkinscfg');
    await page.click('#btnTestJenkins');
    await page.waitForSelector('#sub-jenkinscfg .field-error', { timeout: ATTENTE });
    assert.equal(await page.locator('.toast').count(), 0);
  });

  test('Entrée enregistre, et le dit', async () => {
    /* Les champs de réglages vivent HORS de #configForm (attribut `form=`), et son bouton
       « Enregistrer » aussi : le navigateur ne trouvait alors aucun bouton par défaut, et la
       soumission implicite n'arrivait jamais. On tapait son jeton, on appuyait sur Entrée, et
       il ne se passait rien — ni enregistrement, ni message. */
    const marque = `${app.gitlabUrl}/sous-chemin`;
    await ouvrirReglages('gitcfg');
    await page.fill('[name="gitlab_url"]', marque);
    await page.press('[name="gitlab_url"]', 'Enter');
    await page.waitForFunction(() => /enregistr/i.test(document.querySelector('#configInfoGit').textContent),
      null, { timeout: ATTENTE });
    const c = await app.api('GET', '/api/config');
    assert.equal(c.body.gitlab_url, marque, 'la valeur est bien partie, pas seulement affichée');
    await app.configure();                 // on rend le décor tel qu'on l'a trouvé
  });

  test('les jetons refusent l’autocomplétion et les champs d’une connexion sont marqués', async () => {
    await ouvrirReglages('jiracfg');
    assert.deepEqual(await page.$$eval('[form="configForm"][type="password"]',
      (els) => els.map((e) => e.autocomplete)), ['off', 'off', 'off', 'off']);
    assert.deepEqual(await page.$$eval('#sub-jiracfg .req', (els) => els.map((e) => e.textContent)),
      ['URL Jira', 'Email Jira', 'Jeton d’API Jira'.replace('’', "'")]);
  });

  /* ---------- Un geste, un mot, une porte ---------- */

  test('le badge de verdict est un bouton, atteignable au clavier, qui annonce sa porte', async () => {
    /* Un verdict rendu, posé directement en base : ce test porte sur le BADGE, pas sur le
       moteur de vérification — que six autres fichiers éprouvent déjà de bout en bout. */
    const now = new Date().toISOString();
    app.db.prepare(`INSERT INTO verification
      (verifier_name, status, verdict, targets_json, head_run_json, created_at, finished_at)
      VALUES (?, 'done', 'verified_fail', ?, ?, ?, ?)`)
      .run('tests unitaires', JSON.stringify([{ repo_id: repoId, mr_id: mrId }]),
        JSON.stringify({ failed: ['t1'] }), now, now);

    await page.goto(app.base);
    /* Le dernier onglet visité est mémorisé dans le navigateur : un rechargement ne revient
       pas forcément sur Reviews. On y va. */
    await page.click('nav button[data-tab="review"]');
    await page.waitForSelector('#toReviewList .tag.verify[data-vreport]', { timeout: ATTENTE });
    const badge = page.locator('#toReviewList .tag.verify[data-vreport]').first();
    assert.equal(await badge.evaluate((e) => e.tagName), 'BUTTON',
      'un <span> cliquable n’existe pas pour le clavier');
    assert.ok(await badge.evaluate((e) => e.tabIndex >= 0), 'et il est dans le parcours de tabulation');
    assert.match(await badge.textContent(), /voir le rapport/,
      'le badge dit la porte qu’il ouvre, au lieu de la laisser deviner au survol');
    await badge.click();
    await page.waitForSelector('#verifyModal:not([hidden])', { timeout: ATTENTE });
    await page.evaluate(() => { document.querySelector('#verifyModal').hidden = true; });
  });

  test('un toast d’erreur meurt avec la modale qui l’a produit', async () => {
    /* Le chemin est celui de l'application : une session de codage sans branche de travail est
       refusée EN LIGNE ; ce qu'on veut ici, c'est un toast produit par un refus du serveur. */
    await ecranPropre();
    await page.click('nav button[data-tab="links"]');
    await page.click('#linkNewFree');
    await page.waitForSelector('#freeLinkModal:not([hidden])', { timeout: ATTENTE });
    await page.fill('#freeLabel', 'Tableau de bord');
    await page.fill('#freeUrl', 'pas-une-url');
    await page.click('#freeSave');
    await page.waitForSelector('.toast.err', { timeout: ATTENTE });
    await page.click('#freeCancel');
    await page.waitForFunction(() => document.querySelectorAll('.toast.err').length === 0,
      null, { timeout: ATTENTE });
  });

  /* ---------- L'annexe ---------- */

  test('le lien libre marque ses champs obligatoires et refuse sous le champ', async () => {
    await ecranPropre();
    await page.click('nav button[data-tab="links"]');
    await page.click('#linkNewFree');
    await page.waitForSelector('#freeLinkModal:not([hidden])', { timeout: ATTENTE });
    assert.equal(await page.locator('#freeTags').getAttribute('placeholder'), 'doc, astreinte');
    await page.click('#freeSave');
    await page.waitForSelector('#freeLinkModal .field-error', { timeout: ATTENTE });
    assert.match(await page.locator('#freeLinkModal .field-error').first().textContent(), /libellé/i);
    assert.equal(await page.locator('.toast').count(), 0);
    await page.click('#freeCancel');
  });

  test('la palette dit comment la rouvrir', async () => {
    assert.match(await page.locator('.palette-hint').textContent(), /⌘K|o/);
  });

  test('l’onglet Docker n’accuse rien avant d’avoir été ouvert', async () => {
    await ecranPropre();
    await page.goto(app.base);              // profil neuf : le drapeau « déjà vu » est vierge
    await page.waitForSelector('nav button[data-tab="docker"]', { timeout: ATTENTE });
    assert.equal(await page.locator('#dockerErrBadge').evaluate((e) => e.hidden), true);
    assert.equal(await page.locator('#dockerUnhealthyBadge').evaluate((e) => e.hidden), true);
  });

  test('le filtre de l’ajout en masse reçoit le focus', async () => {
    await ouvrirReglages('repos');
    await page.click('#btnBrowseProjects');
    await page.waitForSelector('#bulkModal:not([hidden])', { timeout: ATTENTE });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'bulkSearch');
    await page.evaluate(() => { document.querySelector('#bulkModal').hidden = true; });
  });

  test('aucune erreur de page pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
