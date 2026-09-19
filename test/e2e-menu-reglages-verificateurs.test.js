'use strict';
/* MENU « RÉGLAGES » → VÉRIFICATEURS — LE FORMULAIRE ENTIER, DANS UN VRAI NAVIGATEUR.
 *
 * `e2e-verifier-form` prouve que le formulaire s'ouvre, se ferme, se pré-remplit et se duplique.
 * Ici, CHAQUE champ qu'il porte : les commandes (ajout, ordre, suppression d'une ligne), les
 * commandes PROPOSÉES par les dépôts cochés, la couverture (recherche, mode « worktree » ou « in
 * place » avec le répertoire choisi parmi les répertoires locaux et « Tester le répertoire »), le
 * délai, les trois interrupteurs de lancement, le bloc de commentaire (mentions, gabarit, liste
 * des champs, aperçu, « repartir du gabarit par défaut »), et l'avancé (rapport JUnit,
 * environnement, TAP, base). Tout est relu par l'API, puis par « Modifier ».
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, git, ARGS_IDENTITE_GIT,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Réglages → Vérificateurs : chaque champ du formulaire', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const ids = {};
  let workdir;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    assert.equal((await app.configure()).status, 200);
    // « grp/front » déclare des scripts npm : ce sont eux que le formulaire doit proposer.
    const front = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-front-')));
    fs.writeFileSync(path.join(front.work, 'package.json'), JSON.stringify({ name: 'front', scripts: { test: 'node --test', lint: 'eslint .' } }));
    git(front.work, ['add', '-A']);
    git(front.work, ['commit', '-m', 'scripts']);
    git(front.work, ['push', 'origin', 'main']);
    const back = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-back-')));
    ids.front = (await app.api('POST', '/api/repos', { project: 'grp/front', url: front.url })).body.id;
    ids.back = (await app.api('POST', '/api/repos', { project: 'grp/back', url: back.url })).body.id;
    // Le clone de « front » : c'est dans le clone que les scripts se lisent.
    assert.equal((await app.api('POST', `/api/repos/${ids.front}/reclone`)).status, 200);
    // Un répertoire local qui porte un clone de « back » : la cible du mode in place.
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    workdir = path.join(racine, 'back-local');
    git(racine, [...ARGS_IDENTITE_GIT, 'clone', '-q', back.url, workdir]);
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine, label: 'Projets' })).status, 200);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1100 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const verificateurs = async () => (await app.api('GET', '/api/verifiers')).body;
  const verificateur = async (nom) => (await verificateurs()).find((v) => v.name === nom);
  const form = (sel) => page.locator(`#verifierForm ${sel}`);
  const commandes = () => page.$$eval('#verifierCommandList .vc-cmd', (els) => els.map((e) => e.value));
  const valeurEnv = (uid, cle) => (app.db.prepare(
    "SELECT value FROM local_state WHERE kind = 'verifier_env' AND ref = ? AND key = ?",
  ).get(uid, cle) || {}).value;
  const ligneDepot = (id) => page.locator(`#verifierRepoBox .vr-row[data-repo="${id}"]`);
  const formOuvert = (o) => page.waitForFunction((x) => {
    const f = document.querySelector('#verifierForm');
    return !!f && !f.hidden === x;
  }, o);

  const ouvrirOnglet = async () => {
    await page.reload();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="verifiers"]').click();
    await page.waitForSelector('#sub-verifiers.active');
    await page.waitForSelector('#verifierRepoBox .vr-row', { state: 'attached' });
  };
  const nouveau = async () => {
    await ouvrirOnglet();
    await page.locator('#btnNewVerifier').click();
    await formOuvert(true);
  };

  test('sans commande, puis sans dépôt : l’erreur se pose sous le champ, et rien ne part', async () => {
    await nouveau();
    await form('[name="name"]').fill('incomplet');
    await form('button[type="submit"]').click();
    await page.waitForSelector('#verifierForm .field-error');
    await page.locator('#verifierCommandList .vc-cmd').first().fill('npm test');
    await form('button[type="submit"]').click();
    await page.waitForFunction(() => /dépôt/i.test([...document.querySelectorAll('#verifierForm .field-error')].map((e) => e.textContent).join(' ')));
    assert.equal(await verificateur('incomplet'), undefined, 'rien n’est enregistré');
    await page.locator('#btnVerifierCancel').evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await page.locator('#btnVerifierCancel').click();
    await formOuvert(false);
  });

  test('cocher un dépôt propose ses commandes ; un clic les ajoute, décocher les retire', async () => {
    await nouveau();
    assert.equal(await page.locator('#verifierSuggestions').isHidden(), true, 'aucun dépôt coché : rien à proposer');
    await ligneDepot(ids.front).locator('.vr-pick').click();
    await page.waitForSelector('#verifierSuggestions:not([hidden]) [data-sugg="npm run test"]');
    const proposees = await page.$$eval('#verifierSuggestions [data-sugg]', (bs) => bs.map((b) => b.dataset.sugg));
    assert.deepEqual(proposees.sort(), ['npm ci', 'npm run lint', 'npm run test']);
    // La première ligne vide est remplie, puis on en ouvre une nouvelle — dans l'ordre du clic.
    await page.locator('#verifierSuggestions [data-sugg="npm ci"]').click();
    await page.locator('#verifierSuggestions [data-sugg="npm run test"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#verifierCommandList .vc-cmd')].map((e) => e.value).join('|') === 'npm ci|npm run test');
    // Une commande déjà dans la liste n'est plus proposée.
    await page.waitForFunction(() => !document.querySelector('#verifierSuggestions [data-sugg="npm ci"]'));
    await ligneDepot(ids.front).locator('.vr-pick').click();
    await page.waitForSelector('#verifierSuggestions', { state: 'hidden' });
    await page.locator('#btnVerifierCancel').click();
    await formOuvert(false);
  });

  test('tous les champs s’enregistrent depuis le formulaire, et « Modifier » les réaffiche', async () => {
    await nouveau();
    await form('[name="name"]').fill('intégration complète');

    // Les commandes : trois lignes, la troisième remontée d'un cran, la deuxième supprimée.
    await page.locator('#verifierCommandList .vc-cmd').first().fill('npm ci');
    await page.locator('#btnAddCommand').click();
    await page.locator('#verifierCommandList .vc-cmd').nth(1).fill('npm run build');
    await page.locator('#btnAddCommand').click();
    await page.locator('#verifierCommandList .vc-cmd').nth(2).fill('npm test');
    await page.locator('#verifierCommandList .vc-row').nth(2).locator('.vc-move[data-dir="-1"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#verifierCommandList .vc-cmd')].map((e) => e.value).join('|') === 'npm ci|npm test|npm run build');
    await page.locator('#verifierCommandList .vc-row').nth(2).locator('.vc-del').click();
    await page.waitForFunction(() => document.querySelectorAll('#verifierCommandList .vc-row').length === 2);
    assert.deepEqual(await commandes(), ['npm ci', 'npm test']);

    // La couverture : la recherche MASQUE sans décocher.
    await ligneDepot(ids.front).locator('.vr-pick').click();
    await page.locator('#verifierRepoBox .repo-multi-search').fill('back');
    await page.waitForFunction((id) => document.querySelector(`#verifierRepoBox .vr-row[data-repo="${id}"]`).hidden, ids.front);
    assert.equal(await ligneDepot(ids.front).locator('.vr-pick').isChecked(), true, 'masqué, toujours coché');
    await ligneDepot(ids.back).locator('.vr-pick').click();
    await page.locator('#verifierRepoBox .repo-multi-search').fill('');
    await page.waitForFunction((id) => !document.querySelector(`#verifierRepoBox .vr-row[data-repo="${id}"]`).hidden, ids.front);

    // « back » en place : le répertoire se CHOISIT parmi les répertoires locaux, puis se teste.
    await ligneDepot(ids.back).locator('.vr-mode').selectOption('in_place');
    await ligneDepot(ids.back).locator('.vr-local-combo .cb-search').click();
    await ligneDepot(ids.back).locator('.combo-opt[data-v]').first().waitFor();
    await ligneDepot(ids.back).locator('.combo-opt[data-v]').first().dispatchEvent('mousedown');
    await page.waitForFunction((id) => document.querySelector(`#verifierRepoBox .vr-row[data-repo="${id}"] .vr-workdir`).value !== '', ids.back);
    assert.equal(await ligneDepot(ids.back).locator('.vr-workdir').inputValue(), workdir);
    await ligneDepot(ids.back).locator('.vr-test').click();
    await page.waitForFunction((id) => document.querySelector(`#verifierRepoBox .vr-row[data-repo="${id}"] .vr-test-info`).classList.contains('ok'), ids.back);
    assert.match(await ligneDepot(ids.back).locator('.vr-test-info').textContent(), /main/, 'le test dit la branche du répertoire');
    await ligneDepot(ids.back).locator('.vr-allow').click();

    await form('[name="timeout_s"]').fill('120');
    await form('[name="auto_on_mr"]').click();
    await form('[name="auto_on_stale"]').click();

    // Le bloc de commentaire n'existe que si l'on publie.
    assert.equal(await page.locator('#verifierCommentBlock').isHidden(), true);
    await form('[name="comment_on_forge"]').click();
    await page.waitForSelector('#verifierCommentBlock:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#verifierCommentFields dt').length > 0);
    await form('[name="mentions"]').fill('@alice @equipe-qa');
    // « Repartir du gabarit par défaut » pose le texte du SERVEUR, pas une copie.
    const defaut = (await app.api('GET', '/api/verifiers/comment-template-default')).body.template;
    await page.locator('#btnCommentTemplateDefaut').click();
    await page.waitForFunction((d) => document.querySelector('#verifierForm [name="comment_template"]').value === d, defaut);
    const gabarit = `${defaut}\nSignalé par Mergerie.`;
    await form('[name="comment_template"]').fill(gabarit);
    // L'aperçu se compose avec le moteur réel, à l'ouverture.
    await page.locator('#verifierCommentPreview summary').click();
    await page.waitForFunction(() => /Signalé par Mergerie/.test(document.querySelector('#verifierCommentPreviewBody').textContent));

    await page.evaluate(() => document.querySelectorAll('#verifierForm details').forEach((d) => { d.open = true; }));
    await form('[name="report_path"]').fill('reports/junit.xml');
    await form('[name="env"]').fill('NODE_ENV=test');
    await form('[name="parse_tap"]').click();
    await form('[name="run_base"]').click();
    await form('button[type="submit"]').evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await form('button[type="submit"]').click();
    await formOuvert(false);

    await attendreServeur(async () => Boolean(await verificateur('intégration complète')), 'le vérificateur est créé');
    const v = await verificateur('intégration complète');
    assert.deepEqual(v.commands, ['npm ci', 'npm test']);
    assert.equal(v.timeout_s, 120);
    assert.equal(Boolean(v.auto_on_mr), true);
    assert.equal(Boolean(v.auto_on_stale), true);
    assert.equal(Boolean(v.comment_on_forge), true);
    assert.equal(v.mentions, '@alice @equipe-qa');
    assert.equal(v.comment_template, gabarit);
    assert.equal(v.report_path, 'reports/junit.xml');
    // Le NOM part avec le vérificateur, la VALEUR reste sur ce poste (local_state).
    assert.deepEqual(JSON.parse(v.env_keys), ['NODE_ENV']);
    assert.equal(valeurEnv(v.uid, 'NODE_ENV'), 'test');
    assert.equal(Boolean(v.parse_tap), false);
    assert.equal(Boolean(v.run_base), false);
    const couverture = Object.fromEntries(v.repos.map((r) => [r.repo_id, r]));
    assert.equal(couverture[ids.front].mode, 'worktree');
    assert.equal(couverture[ids.back].mode, 'in_place');
    assert.equal(couverture[ids.back].workdir, workdir);
    assert.equal(Boolean(couverture[ids.back].checkout_allowed), true);

    // « Modifier » rouvre le formulaire avec TOUT ce qui a été enregistré.
    await ouvrirOnglet();
    await page.locator(`#verifierList .card[data-id="${v.id}"] [data-vedit]`).click();
    await formOuvert(true);
    await page.evaluate(() => document.querySelectorAll('#verifierForm details').forEach((d) => { d.open = true; }));
    assert.deepEqual(await commandes(), ['npm ci', 'npm test']);
    assert.equal(await form('[name="timeout_s"]').inputValue(), '120');
    assert.equal(await form('[name="auto_on_mr"]').isChecked(), true);
    assert.equal(await form('[name="auto_on_stale"]').isChecked(), true);
    assert.equal(await form('[name="comment_on_forge"]').isChecked(), true);
    assert.equal(await page.locator('#verifierCommentBlock').isVisible(), true);
    assert.equal(await form('[name="mentions"]').inputValue(), '@alice @equipe-qa');
    assert.equal(await form('[name="comment_template"]').inputValue(), gabarit);
    assert.equal(await form('[name="report_path"]').inputValue(), 'reports/junit.xml');
    assert.equal(await form('[name="parse_tap"]').isChecked(), false);
    assert.equal(await form('[name="run_base"]').isChecked(), false);
    assert.equal(await ligneDepot(ids.front).locator('.vr-pick').isChecked(), true);
    assert.equal(await ligneDepot(ids.back).locator('.vr-mode').inputValue(), 'in_place');
    assert.equal(await ligneDepot(ids.back).locator('.vr-workdir').inputValue(), workdir);
    assert.equal(await ligneDepot(ids.back).locator('.vr-allow').isChecked(), true);

    // …et une modification écrase le même vérificateur, sans en créer un autre.
    await form('[name="timeout_s"]').fill('300');
    await form('[name="comment_on_forge"]').click();
    await page.waitForSelector('#verifierCommentBlock', { state: 'hidden' });
    await form('button[type="submit"]').evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await form('button[type="submit"]').click();
    await attendreServeur(async () => (await verificateur('intégration complète')).timeout_s === 300, 'la modification est enregistrée');
    assert.equal(Boolean((await verificateur('intégration complète')).comment_on_forge), false);
    assert.equal((await verificateurs()).filter((x) => x.name === 'intégration complète').length, 1);
  });

  /* « MODIFIER » VIDE L'ENVIRONNEMENT, ET L'ENREGISTREMENT L'EFFACE. Le formulaire se remplit
     depuis la LISTE (`GET /api/verifiers`), qui ne porte pas `env` — seul `verifierAvecRepos`
     (réponse de POST/PUT) le recompose. Le champ s'ouvre donc vide, et « Enregistrer » envoie
     `env: ''`, que le serveur lit comme « plus aucune variable » : la valeur de ce poste est
     perdue sans qu'on y ait touché. */
  test('« Modifier » réaffiche l’environnement, et ré-enregistrer ne l’efface pas', async () => {
    const cree = (await app.api('POST', '/api/verifiers', {
      name: 'avec env', kind: 'commands', commands: ['npm test'], env: 'API_URL=http://localhost:9000',
      repos: [{ repo_id: ids.front, mode: 'worktree' }],
    })).body;
    assert.equal(valeurEnv(cree.uid, 'API_URL'), 'http://localhost:9000', 'le décor porte sa variable');
    await ouvrirOnglet();
    await page.locator(`#verifierList .card[data-id="${cree.id}"] [data-vedit]`).click();
    await formOuvert(true);
    await page.evaluate(() => document.querySelectorAll('#verifierForm details').forEach((d) => { d.open = true; }));
    const affiche = await form('[name="env"]').inputValue();
    /* On enregistre SANS rien toucher : ce qui était en base doit y rester. Le formulaire ne se
       referme qu'une fois la réponse du PUT arrivée : c'est l'effet qu'on attend. */
    await form('button[type="submit"]').evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await form('button[type="submit"]').click();
    await formOuvert(false);
    assert.equal(affiche, 'API_URL=http://localhost:9000', 'le formulaire montre la variable enregistrée');
    assert.equal(valeurEnv(cree.uid, 'API_URL'), 'http://localhost:9000', 'enregistrer sans rien changer ne l’efface pas');
  });

  test('la carte dit ce que le formulaire a réglé, sans l’ouvrir', async () => {
    await ouvrirOnglet();
    const v = await verificateur('intégration complète');
    const texte = await page.locator(`#verifierList .card[data-id="${v.id}"]`).textContent();
    assert.match(texte, /npm ci/);
    assert.match(texte, /npm test/);
    assert.match(texte, /grp\/front/);
    assert.match(texte, /grp\/back/);
    assert.match(texte, /reports\/junit\.xml/);
  });

  test('supprimer : « Annuler » garde le vérificateur ; sinon il part au bout du délai', async () => {
    assert.equal((await app.api('POST', '/api/verifiers', {
      name: 'à jeter', kind: 'commands', commands: ['true'], repos: [{ repo_id: ids.front, mode: 'worktree' }],
    })).status, 200);
    await ouvrirOnglet();
    const garde = await verificateur('intégration complète');
    const jete = await verificateur('à jeter');
    await page.waitForSelector(`#verifierList .card[data-id="${jete.id}"]`);

    await page.locator(`#verifierList .card[data-id="${garde.id}"] [data-vdel]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction((id) => document.querySelector(`#verifierList .card[data-id="${id}"]`).hidden, garde.id);
    await page.locator('.toast .toast-btn').last().click();
    await page.waitForFunction((id) => !document.querySelector(`#verifierList .card[data-id="${id}"]`).hidden, garde.id);

    await page.locator(`#verifierList .card[data-id="${jete.id}"] [data-vdel]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    // Quand celui-ci a disparu du serveur, le délai de l'autre — lancé AVANT — est écoulé aussi.
    await attendreServeur(async () => !(await verificateur('à jeter')), 'le vérificateur est supprimé', 30000);
    assert.ok(await verificateur('intégration complète'), '« Annuler » l’a gardé');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
