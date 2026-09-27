'use strict';
/* MENU GIT — « NAVIGATION » ET « COMMANDES GIT », SUR DE VRAIS DÉPÔTS LOCAUX, DANS UN VRAI
 * NAVIGATEUR.
 *
 * e2e-navigate éprouve les routes (checkout, git-run, palette). Ici on passe par l'écran, et
 * la vérité se lit SUR LE DISQUE : la branche réellement sortie, les fichiers modifiés
 * toujours là, la branche réellement supprimée par une commande confirmée.
 *   - Navigation : répertoire, projets (seuls les dépôts git), branche actuelle, branches
 *     distantes, lignes ajoutées/retirées, refus d'une ligne incomplète, bilan, modifications
 *     conservées, mémoire des projets, changement de répertoire ;
 *   - Trouver une ref → « Positionner mes projets dessus » ;
 *   - Commandes : palette, liste des projets (recherche qui masque sans décocher, compteur,
 *     « tout sélectionner »), aperçu, exécution, confirmation d'une commande destructive,
 *     mémoire de la commande et des projets.
 *
 * Un seul `startApp()`, un seul navigateur ; les tests s'enchaînent dans l'ordre. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, git, attendreServeur, navigateurDispo, lancerNavigateur,
  MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const BRANCHE = 'feature/PROJ-42-ajout';

describe('Menu Git : Navigation et Commandes Git', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  let racine; let racine2; let idRacine; let idRacine2;
  const erreurs = [];
  const tete = (nom) => git(path.join(racine, nom), ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const brancheExiste = (nom, b) => {
    try { git(path.join(racine, nom), ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return true; } catch { return false; }
  };

  before(async () => {
    app = await startApp();
    await app.configure();
    racine = path.join(app.dataDir, 'mes-projets');
    racine2 = path.join(app.dataDir, 'autres-projets');
    fs.mkdirSync(racine, { recursive: true });
    fs.mkdirSync(racine2, { recursive: true });
    const distants = {};
    for (const nom of ['api-core', 'webapp-front']) {
      distants[nom] = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, `rem-${nom}-`)), { branch: BRANCHE });
      git(racine, ['clone', distants[nom].bare, nom]);
    }
    fs.mkdirSync(path.join(racine, 'notes'));   // un dossier ordinaire : jamais proposé
    const solo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'rem-solo-')), { branch: BRANCHE });
    git(racine2, ['clone', solo.bare, 'solo']);

    idRacine = (await app.api('POST', '/api/local-roots', { path: racine, label: 'principal' })).body.id;
    idRacine2 = (await app.api('POST', '/api/local-roots', { path: racine2, label: 'secondaire' })).body.id;
    assert.ok(idRacine && idRacine2);

    // Deux dépôts suivis, pour « Trouver une ref » (qui interroge la forge).
    for (const nom of ['api-core', 'webapp-front']) {
      const d = distants[nom];
      app.state.branches[`grp/${nom}`] = [
        { name: 'main', default: true, protected: false, merged: false, commit: { id: d.mainSha, committed_date: '2026-08-01T10:00:00Z' } },
        { name: BRANCHE, default: false, protected: false, merged: false, commit: { id: d.branchSha, committed_date: '2026-08-02T10:00:00Z' } },
      ];
      app.state.tags[`grp/${nom}`] = [];
      await app.api('POST', '/api/repos', { url: d.bare, project: `grp/${nom}` });
    }
    // La palette vient de Réglages → Git : on la pose par l'API.
    for (const [label, command] of [['Statut court', 'status --short --branch'], ['Tout récupérer', 'fetch --all --prune']]) {
      assert.equal((await app.api('POST', '/api/git-commands', { label, command })).status, 200);
    }

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* ---------------------------------------------------------------- outils ---- */

  async function allerGit(sub) {
    await page.evaluate(() => {
      for (const s of ['#gitExploreRepoBox', '#navTargetRows']) { const e = document.querySelector(s); if (e) e.innerHTML = ''; }
    });
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForFunction(() => document.querySelector('#gitExploreRepoBox .git-multi-pick')
      && document.querySelector('#navTargetRows .nav-row'));
    await page.locator(`#tab-git .subnav [data-gsub="${sub}"]`).click();
    await page.waitForSelector(`#gsub-${sub}.active`);
  }

  async function fermerMenus() {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForFunction(() => [...document.querySelectorAll('.combo-options')].every((b) => b.hidden));
  }
  /** Ouvre un combo et rend le texte de ses options (« chargement… » attendu jusqu'au bout). */
  async function optionsDe(champ) {
    await fermerMenus();
    await champ.click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
    const opts = await page.locator('.combo-options:not([hidden]) .combo-opt[data-v]').evaluateAll((els) => els.map((e) => e.dataset.l));
    await fermerMenus();
    return opts;
  }
  async function choisir(champ, texte) {
    await fermerMenus();
    await champ.click();
    const opt = page.locator('.combo-options:not([hidden]) .combo-opt[data-v]', { hasText: texte }).first();
    await opt.waitFor();
    await opt.click();
  }
  const ligne = (i) => page.locator(`#navTargetRows .nav-row[data-row="${i}"]`);
  async function choisirProjet(i, nom) {
    await choisir(ligne(i).locator('[data-combo="nav-project"]'), nom);
    await page.waitForFunction(([idx, n]) => document.querySelector(`#navTargetRows .nav-row[data-row="${idx}"] .nav-project`).value === n, [i, nom]);
  }
  async function choisirBranche(i, b) {
    await choisir(ligne(i).locator('[data-combo="nav-branch"]'), b);
    await page.waitForFunction(([idx, v]) => document.querySelector(`#navTargetRows .nav-row[data-row="${idx}"] .nav-branch`).value === v, [i, b]);
  }
  async function toast(motif) {
    await page.waitForFunction((src) => [...document.querySelectorAll('#toasts .toast')]
      .some((t) => new RegExp(src).test(t.textContent)), motif.source);
  }
  async function sePositionner() {
    await page.evaluate(() => { document.querySelector('#navResultBox').innerHTML = ''; });
    await page.locator('#navGo').click();
    await page.waitForSelector('#navResultBox:not([hidden]) .git-pv-counts');
    return page.locator('#navResultBox').innerText();
  }

  /* ------------------------------------------------------------ Navigation ---- */

  test('le répertoire est proposé, et seuls ses dépôts git le sont comme projets', async () => {
    await allerGit('navigate');
    assert.match(await page.locator('#navRootBox .cb-search').inputValue(), /principal — .*mes-projets/);
    const racines = await optionsDe(page.locator('#navRootBox [data-combo="nav-root"]'));
    assert.equal(racines.length, 2, racines.join(' | '));
    assert.deepEqual((await optionsDe(ligne(0).locator('[data-combo="nav-project"]'))).sort(), ['api-core', 'webapp-front'],
      'le dossier « notes », sans .git, n’est pas proposé');
  });

  test('choisir un projet affiche sa branche actuelle, et la liste de ses branches distantes', async () => {
    await choisirProjet(0, 'api-core');
    await page.waitForFunction(() => /actuelle : main/.test(document.querySelector('#navTargetRows .nav-row .nav-current').textContent));
    assert.deepEqual((await optionsDe(ligne(0).locator('[data-combo="nav-branch"]'))).sort(), [BRANCHE, 'main'].sort());
  });

  test('une ligne sans branche est refusée avant tout checkout', async () => {
    await page.locator('#navGo').click();
    await toast(/Choisis une branche pour chaque projet/);
    assert.equal(await page.locator('#navResultBox').isVisible(), false);
    assert.equal(tete('api-core'), 'main');
  });

  test('se positionner : lignes ajoutées et retirées, bilan par projet, et le disque suit', async () => {
    await choisirBranche(0, BRANCHE);
    await page.locator('#navAddTarget').click();
    await ligne(1).waitFor();
    await page.locator('#navAddTarget').click();
    await ligne(2).waitFor();
    await page.locator('#navTargetRows [data-navrm="2"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#navTargetRows .nav-row').length === 2);
    await choisirProjet(1, 'webapp-front');
    await choisirBranche(1, 'main');

    const bilan = await sePositionner();
    assert.match(bilan, /api-core[\s\S]*positionné/);
    assert.match(bilan, /depuis main|main/);
    assert.match(bilan, /webapp-front[\s\S]*déjà sur cette branche/);
    assert.match(bilan, /2 positionné\(s\) · 0 avec modifications conservées · 0 en échec/);
    await toast(/Positionnement terminé : 2 réussi\(s\), 0 en échec/);
    assert.equal(tete('api-core'), BRANCHE, 'la branche est réellement sortie');
    assert.equal(tete('webapp-front'), 'main');
    // La ligne dit la nouvelle branche actuelle, sans recharger.
    await page.waitForFunction((b) => document.querySelector('#navTargetRows .nav-row[data-row="0"] .nav-current').textContent.includes(b), BRANCHE);
  });

  test('des modifications en cours : le checkout est fait, rien n’est jeté, les fichiers sont listés', async () => {
    const dir = path.join(racine, 'webapp-front');
    fs.writeFileSync(path.join(dir, 'README.md'), '# modifié en local\n');
    await choisirBranche(1, BRANCHE);
    const bilan = await sePositionner();
    assert.match(bilan, /webapp-front[\s\S]*positionné, modifications conservées/);
    const fichiers = page.locator('#navResultBox details.nav-files');
    assert.match(await fichiers.locator('summary').innerText(), /1/);
    assert.match(await fichiers.evaluate((d) => d.textContent), /README\.md/);
    assert.equal(tete('webapp-front'), BRANCHE);
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /modifié en local/, 'la modification a voyagé');
  });

  test('les projets choisis sont retenus au rechargement (pas les branches)', async () => {
    await page.reload();
    await allerGit('navigate');
    await page.waitForFunction(() => document.querySelectorAll('#navTargetRows .nav-row').length === 2);
    const projets = await page.locator('#navTargetRows .nav-project').evaluateAll((els) => els.map((e) => e.value));
    assert.deepEqual(projets, ['api-core', 'webapp-front']);
    const branches = await page.locator('#navTargetRows .nav-branch').evaluateAll((els) => els.map((e) => e.value));
    assert.deepEqual(branches, ['', ''], 'la branche se choisit à chaque fois');
  });

  test('Trouver une ref → « Positionner mes projets dessus » pré-remplit Navigation, et on y va', async () => {
    await page.locator('#tab-git .subnav [data-gsub="findref"]').click();
    await page.locator('#findRefName').fill('main');
    await page.locator('#findRefType').selectOption('branch');
    await page.locator('#findRefGo').click();
    await page.waitForSelector('#findRefToNav');
    assert.match(await page.locator('#findRefInfo').innerText(), /2 dépôt\(s\) sur 2 ont « main »/);
    await page.locator('#findRefToNav').click();
    await page.waitForSelector('#gsub-navigate.active');
    await toast(/Navigation ouverte sur « main »/);
    await page.waitForFunction(() => [...document.querySelectorAll('#navTargetRows .nav-branch')].every((h) => h.value === 'main'));
    const bilan = await sePositionner();
    assert.match(bilan, /0 en échec/);
    assert.equal(tete('api-core'), 'main');
    assert.equal(tete('webapp-front'), 'main');
  });

  test('changer de répertoire repart d’une ligne vide, avec ses propres projets', async () => {
    await choisir(page.locator('#navRootBox [data-combo="nav-root"]'), 'secondaire');
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#navTargetRows .nav-row');
      return rows.length === 1 && rows[0].querySelector('.nav-project').value === '';
    });
    assert.deepEqual(await optionsDe(ligne(0).locator('[data-combo="nav-project"]')), ['solo']);
    await choisir(page.locator('#navRootBox [data-combo="nav-root"]'), 'principal');
    await page.waitForFunction(() => document.querySelectorAll('#navTargetRows .nav-row').length === 1);
  });

  /* -------------------------------------------------------------- Commandes ---- */

  describe('Commandes Git', () => {
    const projet = (nom) => page.locator(`#cmdProjectBox .cmd-plist input[value="${nom}"]`);

    test('la palette vient des réglages, et choisir une entrée remplit la commande', async () => {
      await page.locator('#tab-git .subnav [data-gsub="commands"]').click();
      await page.waitForSelector('#cmdProjectBox .cmd-pitem');
      assert.match(await page.locator('#cmdRootBox .cb-search').inputValue(), /principal/);
      const entrees = await page.locator('#cmdPalette option').allTextContents();
      assert.ok(entrees.includes('Statut court — git status --short --branch'), entrees.join(' | '));
      await page.locator('#cmdPalette').selectOption('fetch --all --prune');
      assert.equal(await page.locator('#cmdInput').inputValue(), 'fetch --all --prune');
    });

    test('sans projet, ou sans commande : l’aperçu refuse', async () => {
      await page.locator('#cmdPreview').click();
      await toast(/Sélectionne au moins un projet/);
      assert.equal(await page.locator('#cmdPreviewBox').isVisible(), false);
      await projet('api-core').check();
      await page.locator('#cmdInput').fill('');
      await page.locator('#cmdPreview').click();
      await toast(/Commande git vide/);
      assert.equal(await page.locator('#cmdPreviewBox').isVisible(), false);
    });

    test('seuls les dépôts git sont listés ; la recherche masque sans décocher ; le compteur suit', async () => {
      const noms = await page.locator('#cmdProjectBox .cmd-pname').allTextContents();
      assert.deepEqual(noms.sort(), ['api-core', 'webapp-front']);
      await page.waitForFunction(() => /1 projet sélectionné/.test(document.querySelector('#cmdPickCount').textContent));
      await page.locator('#cmdProjectBox .cmd-search').fill('webapp');
      await page.waitForFunction(() => document.querySelector('#cmdProjectBox .cmd-plist input[value="api-core"]').closest('.cmd-pitem').hidden);
      assert.equal(await projet('api-core').isChecked(), true, 'masqué, api-core reste coché');
      await projet('webapp-front').check();
      await page.waitForFunction(() => /2 projets sélectionnés/.test(document.querySelector('#cmdPickCount').textContent));
      await page.locator('#cmdProjectBox .cmd-search').fill('');
      await page.waitForFunction(() => !document.querySelector('#cmdProjectBox .cmd-pitem[hidden]'));
      // Décocher repasse le compteur, et la case « tout » devient indéterminée.
      await projet('webapp-front').uncheck();
      await page.waitForFunction(() => /1 projet sélectionné/.test(document.querySelector('#cmdPickCount').textContent)
        && document.querySelector('#cmdSelAll').indeterminate);
    });

    test('« Tout sélectionner » coche tous les projets', async () => {
      const avant = erreurs.length;
      await page.locator('#cmdSelAll').click();
      /* L'effet attendu, ou l'erreur qui l'empêche : on n'attend pas l'horloge. */
      await attendreServeur(async () => erreurs.length > avant
        || (await page.locator('#cmdProjectBox .cmd-plist input:checked').count()) === 2, 'tout est coché', 10000);
      const nouvelles = erreurs.splice(avant);   // l'erreur de ce défaut connu ne pollue pas le bilan final
      assert.deepEqual(nouvelles, [], 'aucune erreur JavaScript');
      assert.equal(await page.locator('#cmdProjectBox .cmd-plist input:checked').count(), 2);
      await page.waitForFunction(() => /2 projets sélectionnés/.test(document.querySelector('#cmdPickCount').textContent));
    });

    test('aperçu, annuler, puis exécuter : la sortie de chaque projet s’affiche', async () => {
      // Quel que soit l'état laissé par le test précédent : les deux projets cochés, un par un.
      for (const nom of ['api-core', 'webapp-front']) await projet(nom).check();
      await page.waitForFunction(() => /2 projets sélectionnés/.test(document.querySelector('#cmdPickCount').textContent));
      await page.locator('#cmdPalette').selectOption('status --short --branch');
      await page.locator('#cmdPreview').click();
      await page.waitForSelector('#cmdPreviewBox:not([hidden]) #cmdRun');
      const apercu = await page.locator('#cmdPreviewBox').innerText();
      assert.match(apercu, /git status --short --branch/);
      assert.deepEqual((await page.locator('#cmdPreviewBox .cmd-preview-list li').allTextContents()).sort(), ['api-core', 'webapp-front']);
      await page.locator('#cmdCancel').click();
      await page.waitForSelector('#cmdPreviewBox', { state: 'hidden' });

      await page.locator('#cmdPreview').click();
      await page.locator('#cmdRun').click();
      await page.waitForSelector('#cmdResultBox:not([hidden]) .cmd-res');
      assert.equal(await page.locator('#cmdPreviewBox').isVisible(), false);
      assert.equal(await page.locator('#cmdResultBox .cmd-res.ok').count(), 2);
      const sortie = await page.locator('#cmdResultBox').innerText();
      assert.match(sortie, /2 ok · 0 en échec/);
      assert.match(sortie, /## main/, 'la vraie sortie de git, projet par projet');
      await toast(/Terminé : 2 ok, 0 en échec/);
    });

    test('une commande destructive se confirme — refuser n’exécute rien, accepter supprime pour de bon', async () => {
      for (const nom of ['api-core', 'webapp-front']) git(path.join(racine, nom), ['branch', 'zz-jetable']);
      await page.locator('#cmdInput').fill('branch -D zz-jetable');
      await page.locator('#cmdPreview').click();
      await page.locator('#cmdRun').click();
      await page.waitForSelector('#confirmModal:not([hidden])');
      assert.match(await page.locator('#confirmTitle').innerText(), /Commande destructive/);
      assert.equal(await page.locator('#confirmDetail').innerText(), 'git branch -D zz-jetable');
      await page.locator('#confirmCancel').click();
      await page.waitForSelector('#confirmModal', { state: 'hidden' });
      assert.ok(brancheExiste('api-core', 'zz-jetable') && brancheExiste('webapp-front', 'zz-jetable'), 'rien n’a été exécuté');

      await page.evaluate(() => { document.querySelector('#cmdResultBox').innerHTML = ''; });
      await page.locator('#cmdRun').click();
      await page.waitForSelector('#confirmModal:not([hidden])');
      await page.locator('#confirmOk').click();
      await page.waitForSelector('#cmdResultBox:not([hidden]) .cmd-res');
      assert.match(await page.locator('#cmdResultBox').innerText(), /2 ok · 0 en échec/);
      assert.ok(!brancheExiste('api-core', 'zz-jetable') && !brancheExiste('webapp-front', 'zz-jetable'),
        'la branche est supprimée dans les deux dépôts');
    });

    test('la dernière commande et les projets cochés sont retenus au rechargement', async () => {
      await page.reload();
      await allerGit('commands');
      await page.waitForSelector('#cmdProjectBox .cmd-pitem');
      await page.waitForFunction(() => document.querySelectorAll('#cmdProjectBox .cmd-plist input:checked').length === 2);
      assert.equal(await page.locator('#cmdInput').inputValue(), 'branch -D zz-jetable');
      assert.match(await page.locator('#cmdPickCount').innerText(), /2 projets sélectionnés/);
    });
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
