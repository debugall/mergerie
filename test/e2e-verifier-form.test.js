'use strict';
/* Le formulaire de vérificateur s'ouvre à la demande, dans un VRAI navigateur.
 *
 * Ce qui se joue ici est une question d'écran : déployé en permanence, le formulaire —
 * champs, liste de commandes, tableau des dépôts couverts — repoussait hors de vue la liste
 * des vérificateurs, qui est pourtant ce qu'on vient consulter. Le vérifier demande de
 * regarder ce qui est visible, pas ce que le code croit afficher.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit } = require('./helpers/app');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Réglages → Vérificateurs : le formulaire s’ouvre à la demande', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-clones-')) });
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-repo-'));
    git(d, 'init', '-q', '-b', 'main');
    poserIdentiteGit(d);
    fs.writeFileSync(path.join(d, 'a.txt'), 'x\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
    const repoId = (await app.api('POST', '/api/repos', { project: 'groupe/api-core', url: d })).body.id;
    await app.api('POST', '/api/verifiers', {
      name: 'tests unitaires', kind: 'commands', commands: ['npm ci', 'npm test'],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Rechargement à chaque fois : un test qui laisse le formulaire ouvert ne doit pas décider
  // de l'état du suivant. C'est aussi ce que fait l'utilisateur qui arrive sur l'écran.
  async function ouvrirOnglet() {
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav button', { hasText: 'Vérificateurs' }).click();
    await page.waitForSelector('#verifierList .card');
  }

  const visible = async () => ({
    form: await page.locator('#verifierForm').isVisible(),
    ajouter: await page.locator('#btnNewVerifier').isVisible(),
  });

  test('à l’arrivée, on voit la liste et pas le formulaire', async () => {
    await ouvrirOnglet();
    const v = await visible();
    assert.equal(v.form, false, 'le formulaire est fermé');
    assert.equal(v.ajouter, true, '…et le bouton qui l’ouvre est là');
    // La liste doit être atteignable sans défiler : c'était tout le problème.
    const carte = await page.locator('#verifierList .card').first().boundingBox();
    assert.ok(carte.y < 900, `le premier vérificateur doit être visible d’emblée (y=${Math.round(carte.y)})`);
  });

  /* Le formulaire s'ouvre et se referme par un rendu : on attend cet ÉTAT-LÀ. Un délai fixe
     tient en local et lâche sur un runner à deux cœurs — et l'échec accuse alors le bouton. */
  const attendreForm = (ouvert) => page.waitForFunction(
    (o) => {
      const f = document.querySelector('#verifierForm');
      return !!f && (f.offsetParent !== null) === o;
    }, ouvert,
  );

  test('« Ajouter » ouvre un formulaire vierge, « Annuler » le referme', async () => {
    await ouvrirOnglet();
    await page.locator('#btnNewVerifier').click();
    await attendreForm(true);
    let v = await visible();
    assert.equal(v.form, true);
    assert.equal(v.ajouter, false, 'le bouton d’ouverture s’efface : un seul formulaire à la fois');
    assert.equal(await page.locator('#verifierForm input[name=name]').inputValue(), '', 'formulaire vierge');
    assert.equal(await page.locator('#verifierForm input[name=id]').inputValue(), '', 'aucun id : c’est une création');

    /* On amène le bouton AU MILIEU de l'écran avant de cliquer, comme le ferait quelqu'un.
       `scrollIntoViewIfNeeded` ne suffit pas : un bouton posé dans les trente derniers pixels
       est « visible » pour le navigateur, mais recouvert par le bandeau fixe du bas — le clic
       part alors dans le vide. Le test cliquait juste au-dessus du bandeau par chance. */
    await page.locator('#btnVerifierCancel').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.locator('#btnVerifierCancel').click();
    await attendreForm(false);
    v = await visible();
    assert.equal(v.form, false, 'refermé');
    assert.equal(v.ajouter, true);
  });

  test('« Modifier » ouvre le formulaire déjà rempli', async () => {
    await ouvrirOnglet();
    await page.locator('#verifierList [data-vedit]').first().click();
    await attendreForm(true);
    assert.equal((await visible()).form, true, 'modifier doit ouvrir le formulaire, sinon le clic ne fait rien de visible');
    assert.equal(await page.locator('#verifierForm input[name=name]').inputValue(), 'tests unitaires');
    assert.equal(await page.locator('#verifierForm input[name=id]').inputValue(), '1');
    // Les commandes du vérificateur sont là, pas seulement son nom.
    assert.deepEqual(await page.$$eval('#verifierCommandList .vc-cmd', (i) => i.map((x) => x.value)), ['npm ci', 'npm test']);
  });

  /* DUPLIQUER : le geste de qui doit couvrir dix dépôts avec la même commande à un détail près.
     Sans lui, on retape tout — ou, pire, on modifie l'existant en croyant en créer un autre. Ce
     qui compte ici tient en deux points : le formulaire est rempli comme pour une modification,
     et il n'a PAS d'identifiant — enregistrer crée, il n'écrase pas l'original. */
  test('« Dupliquer » ouvre un formulaire pré-rempli qui CRÉE au lieu d’écraser', async () => {
    await ouvrirOnglet();
    const avant = await page.locator('#verifierList .card').count();
    await page.locator('#verifierList [data-vcopy]').first().click();
    await attendreForm(true);

    assert.equal((await visible()).form, true);
    assert.equal(await page.locator('#verifierForm input[name=id]').inputValue(), '',
      'aucun identifiant : enregistrer ne doit pas écraser le vérificateur d’origine');
    assert.deepEqual(await page.$$eval('#verifierCommandList .vc-cmd', (i) => i.map((x) => x.value)),
      ['npm ci', 'npm test'], 'les commandes sont reprises, pas seulement le nom');
    assert.equal(await page.locator('#verifierRepoBox .vr-pick').first().isChecked(), true,
      'et les dépôts couverts aussi — c’est la moitié du travail qu’on veut éviter de refaire');

    /* Le nom ne peut pas être recopié tel quel : ils sont uniques, et l'enregistrement
       échouerait après coup, une fois tout ajusté. */
    const nom = await page.locator('#verifierForm input[name=name]').inputValue();
    assert.equal(nom, 'tests unitaires (copie)');

    await page.locator('#verifierForm button[type=submit]').click();
    // L'enregistrement recharge la liste : on attend la carte de plus, pas huit dixièmes.
    await page.waitForFunction((n) => document.querySelectorAll('#verifierList .card').length === n, avant + 1);
    assert.equal(await page.locator('#verifierList .card').count(), avant + 1, 'un vérificateur de PLUS');
    const noms = await page.$$eval('#verifierList .card .title', (cs) => cs.map((c) => c.textContent));
    assert.ok(noms.includes('tests unitaires'), 'l’original est intact');
    assert.ok(noms.includes('tests unitaires (copie)'), '…et la copie existe');

    // Dupliquer une deuxième fois ne rebutera pas sur le nom déjà pris.
    await page.locator('#verifierList [data-vcopy]').first().click();
    await page.waitForFunction(() => document.querySelector('#verifierForm input[name=name]').value.includes('copie 2'));
    assert.equal(await page.locator('#verifierForm input[name=name]').inputValue(), 'tests unitaires (copie 2)');
    await page.locator('#btnVerifierCancel').click();
  });

  test('enregistrer referme le formulaire et rafraîchit la liste', async () => {
    await ouvrirOnglet();
    await page.locator('#btnNewVerifier').click();
    await page.locator('#verifierForm input[name=name]').fill('lint');
    await page.locator('#btnAddCommand').click();
    await page.locator('#verifierCommandList .vc-cmd').first().fill('npm run lint');
    await page.locator('#verifierRepoBox .vr-pick').first().check();
    await page.locator('#verifierForm button[type=submit]').click();
    await attendreForm(false);

    assert.equal((await visible()).form, false, 'le travail est fini : le formulaire se referme');
    assert.equal((await visible()).ajouter, true);
    const noms = await page.$$eval('#verifierList .card', (cs) => cs.map((c) => c.textContent));
    assert.ok(noms.some((t) => t.includes('lint')), 'le nouveau vérificateur apparaît dans la liste');

    // Et le formulaire rouvert repart vierge, sans traîner la saisie précédente.
    await page.locator('#btnNewVerifier').click();
    await attendreForm(true);
    assert.equal(await page.locator('#verifierForm input[name=name]').inputValue(), '');
    // Une ligne, vide : la liste de commandes en propose toujours une, sinon il n'y aurait
    // rien à remplir. Ce qui compte est qu'elle ne porte plus la saisie précédente.
    assert.deepEqual(await page.$$eval('#verifierCommandList .vc-cmd', (i) => i.map((x) => x.value)), ['']);
  });
});
