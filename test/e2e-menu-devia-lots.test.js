'use strict';
/* MENU « DEV IA » — LE PANNEAU « LOTS À VÉRIFIER ENSEMBLE », dans un VRAI navigateur.
 *
 * Un lot regroupe des merge requests de dépôts différents qui ne valent que réunies. Il se
 * compose depuis Reviews ; ce panneau-ci, sous le codage, en montre la liste et porte deux
 * gestes : VÉRIFIER le lot (choix du vérificateur, puis un seul run pour toutes ses MR) et le
 * SUPPRIMER. Le moteur est éprouvé par `e2e-lot.test.js` ; ici, c'est le câblage de l'écran —
 * et en particulier le lancement depuis Dev IA, où les listes de Reviews ne sont pas chargées
 * (c'est pour cela que les dépôts du lot voyagent avec le bouton).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, poserIdentiteGit, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

// Un dépôt avec une branche `feature/x` : de quoi faire une MR vérifiable.
function depot(nom) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `menu-devia-lot-${nom}-`));
  git(d, 'init', '-q', '-b', 'main');
  poserIdentiteGit(d);
  fs.writeFileSync(path.join(d, 'a.txt'), 'base\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  git(d, 'checkout', '-q', '-b', 'feature/x');
  fs.writeFileSync(path.join(d, 'a.txt'), 'tête\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'tête');
  const sha = git(d, 'rev-parse', 'HEAD');
  git(d, 'checkout', '-q', 'main');
  return { dir: d, sha };
}

describe('Menu Dev IA — les lots à vérifier ensemble', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app;
  let nav;
  let page;
  const erreurs = [];
  const repos = {};
  const mrs = {};
  const dossiers = [];
  let verifA;
  let verifB;
  let lot;
  let lotOrphelin;

  const aller = async () => {
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.waitForSelector('#lotPanel:not([hidden])');
  };
  const recharger = () => page.evaluate(() => loadTasks());
  const tr = (cle, p) => page.evaluate(([k, x]) => tr(k, x), [cle, p || {}]);
  const carte = (id) => `#lotList .card[data-id="${id}"]`;
  const verifs = () => app.db.prepare('SELECT * FROM verification ORDER BY id').all();

  before(async () => {
    app = await startApp();
    await app.configure({ clone_path: fs.mkdtempSync(path.join(app.dataDir, 'clones-')) });
    app.state.projects = [];
    for (const nom of ['app', 'lib', 'seul']) {
      const d = depot(nom);
      dossiers.push(d.dir);
      const projet = `grp/${nom}`;
      repos[nom] = { ...d, id: (await app.api('POST', '/api/repos', { project: projet, url: d.dir })).body.id };
      app.state.projects.push({ id: app.state.projects.length + 1, path_with_namespace: projet, http_url_to_repo: d.dir });
      app.state.mrs[projet] = [{
        iid: app.state.projects.length, title: `MR ${nom}`, state: 'opened',
        source_branch: 'feature/x', target_branch: 'main',
        web_url: `https://gitlab.test/${projet}/-/merge_requests/1`,
        sha: d.sha, created_at: new Date().toISOString(), author: { name: 'A' },
      }];
    }
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api, { timeout: 60000 });
    for (const m of (await app.api('GET', '/api/mrs')).body) mrs[m.project.split('/')[1]] = m;

    // Deux vérificateurs couvrent le lot : il faut donc CHOISIR — et le choix se retient.
    const script = path.join(app.dataDir, 'vert.sh');
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const couvrant = (name) => app.api('POST', '/api/verifiers', {
      name, kind: 'commands', run_base: false, commands: [script],
      repos: [{ repo_id: repos.app.id, mode: 'worktree' }, { repo_id: repos.lib.id, mode: 'worktree' }],
    });
    verifA = (await couvrant('integ-a')).body;
    verifB = (await couvrant('integ-b')).body;

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
    for (const d of dossiers) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('sans lot, le panneau le dit — il ne se tait pas', async () => {
    await aller();
    await page.waitForSelector('#lotList .empty');
    assert.match(await page.locator('#lotList .empty').textContent(), new RegExp(await tr('verify.lots.empty.title')));
  });

  test('un lot apparaît avec son nom et ses merge requests', async () => {
    lot = (await app.api('POST', '/api/lots', { name: 'sortie 2.4', members: [mrs.app.id, mrs.lib.id] })).body;
    await recharger();
    await page.waitForSelector(carte(lot.id));
    assert.equal((await page.locator(`${carte(lot.id)} .title`).textContent()).trim(), 'sortie 2.4');
    const membres = await page.$$eval(`${carte(lot.id)} .meta .tag`, (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(membres.sort(), [`grp/app !${mrs.app.iid}`, `grp/lib !${mrs.lib.iid}`].sort());
  });

  test('« Vérifier le lot » : annuler le choix du vérificateur ne lance rien', async () => {
    const avant = verifs().length;
    await page.locator(`${carte(lot.id)} [data-lotverify]`).click();
    await page.waitForSelector('#verifyPickModal:not([hidden])');
    await page.locator('#verifyPickCancel').click();
    await page.waitForSelector('#verifyPickModal[hidden]', { state: 'attached' });
    assert.equal(verifs().length, avant);
  });

  test('« Vérifier le lot » : le vérificateur choisi teste les deux MR en un seul run', async () => {
    const avant = verifs().length;
    await page.locator(`${carte(lot.id)} [data-lotverify]`).click();
    await page.waitForSelector('#verifyPickModal:not([hidden])');
    const options = await page.$$eval('#verifyPickList input[name="verifyPick"]', (els) => els.map((e) => Number(e.value)));
    assert.deepEqual(options.sort(), [verifA.id, verifB.id].sort(), 'seuls les vérificateurs qui couvrent TOUT le lot');
    // Le détail suit la sélection : ce qui va tourner se lit AVANT de lancer.
    await page.locator(`#verifyPickList input[value="${verifB.id}"]`).check();
    await page.waitForFunction(() => /vert\.sh/.test(document.querySelector('#verifyPickDetail').textContent));
    await page.locator('#verifyPickGo').click();
    await page.waitForSelector('#verifyPickModal[hidden]', { state: 'attached' });

    await attendreServeur(async () => verifs().length > avant, 'une vérification est créée');
    const v = verifs().pop();
    assert.equal(v.lot_id, lot.id, 'la vérification est celle DU LOT');
    assert.equal(v.verifier_id, verifB.id, 'avec le vérificateur choisi');
    await attendreServeur(async () => ['done', 'error'].includes((await app.api('GET', `/api/verifications/${v.id}`)).body.status),
      'la vérification se termine', 60000);
    await waitForJobs(app.api, { timeout: 60000 });
    const d = (await app.api('GET', `/api/verifications/${v.id}`)).body;
    assert.equal(d.verdict, 'verified_pass');
    assert.deepEqual(d.targets.map((c) => c.repo_id).sort(), [repos.app.id, repos.lib.id].sort());

    // Le verdict revient sur la carte du lot.
    await recharger();
    await page.waitForFunction((s) => document.querySelector(`${s} .card-tags`).textContent.trim().length > 0, carte(lot.id));
  });

  test('le vérificateur d’un lot se retient : la fois suivante, il est présélectionné', async () => {
    await page.locator(`${carte(lot.id)} [data-lotverify]`).click();
    await page.waitForSelector('#verifyPickModal:not([hidden])');
    assert.equal(await page.locator('#verifyPickList input:checked').getAttribute('value'), String(verifB.id));
    await page.locator('#verifyPickCancel').click();
    await page.waitForSelector('#verifyPickModal[hidden]', { state: 'attached' });
  });

  test('un lot qu’aucun vérificateur ne couvre le dit, sans ouvrir de choix vide', async () => {
    lotOrphelin = (await app.api('POST', '/api/lots', { name: 'orphelin', members: [mrs.app.id, mrs.seul.id] })).body;
    await recharger();
    await page.waitForSelector(carte(lotOrphelin.id));
    const avant = verifs().length;
    await page.locator(`${carte(lotOrphelin.id)} [data-lotverify]`).click();
    const attendu = await tr('err.verify.no-verifier');
    await page.waitForFunction((m) => [...document.querySelectorAll('.toast.err')].some((t) => t.textContent.includes(m)), attendu);
    assert.equal(await page.locator('#verifyPickModal').isHidden(), true);
    assert.equal(verifs().length, avant);
  });

  test('supprimer un lot demande confirmation, puis le retire — ses rapports restent', async () => {
    const rapport = verifs().find((v) => v.lot_id === lot.id);
    await page.locator(`${carte(lot.id)} [data-lotdel]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').textContent(), /sortie 2\.4/, 'la confirmation nomme le lot');
    await page.locator('#confirmCancel').click();
    assert.ok((await app.api('GET', '/api/lots')).body.some((l) => l.id === lot.id), 'annuler ne supprime rien');

    await page.locator(`${carte(lot.id)} [data-lotdel]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => !(await app.api('GET', '/api/lots')).body.some((l) => l.id === lot.id), 'le lot est supprimé');
    await page.waitForSelector(carte(lot.id), { state: 'detached' });
    assert.equal((await app.api('GET', `/api/verifications/${rapport.id}`)).status, 200, 'le rapport rendu survit au lot');
  });

  test('le panneau des lots n’existe que sous le codage', async () => {
    for (const kind of ['local', 'explore', 'ask']) {
      await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
      await page.waitForSelector('#lotPanel', { state: 'hidden' });
    }
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.waitForSelector('#lotPanel', { state: 'visible' });
    await page.waitForSelector(carte(lotOrphelin.id));
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
