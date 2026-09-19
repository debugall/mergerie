'use strict';
/* MENU GIT — « EXPLORATEUR DE BRANCHES » ET « TROUVER UNE REF », DANS UN VRAI NAVIGATEUR.
 *
 * e2e-git-explorer-ui éprouve ce que l'écran dit PENDANT l'analyse (états, chevron, erreur) ;
 * e2e-git couvre les routes. Ici, les gestes qui partent d'une ligne de l'explorateur, jusqu'à
 * leur effet côté serveur :
 *   - la recherche de dépôts et le filtre de branches (ils MASQUENT, ne décochent rien) ;
 *   - cocher des branches → « Supprimer la sélection » ouvre Actions sur l'aperçu ;
 *   - « Créer la MR » (la MR existe sur la forge), l'auteur d'un tag lu à la demande ;
 *   - « Vérifier », « Coder dessus », « Ajouter aux todos » depuis la ligne ;
 *   - la mémoire des dépôts cochés ;
 *   - Trouver une ref : tag, branche, rien, dépôt inaccessible, auteur, mémoire.
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

describe('Menu Git : Explorateur de branches et Trouver une ref', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  let alpha; let beta; let idAlpha; let idBeta;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    alpha = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'alpha-')), { branch: BRANCHE });
    beta = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'beta-')), { branch: BRANCHE });
    // Un tag ANNOTÉ sur main : son auteur (le tagger) ne se lit que dans le clone.
    git(alpha.work, ['tag', '-a', 'v1.0.0', '-m', 'Première livraison']);
    git(alpha.work, ['push', 'origin', '--tags']);
    const br = (name, sha, extra = {}) => ({
      name, default: false, protected: false, merged: false,
      commit: { id: sha, committed_date: '2026-08-01T10:00:00Z', author_name: 'Alice' }, ...extra,
    });
    for (const [projet, d] of [['grp/alpha', alpha], ['grp/beta', beta]]) {
      app.state.branches[projet] = [br('main', d.mainSha, { default: true, protected: true }), br(BRANCHE, d.branchSha)];
      app.state.protectedBranches[projet] = ['main'];
      app.state.mrs[projet] = [];
    }
    app.state.tags['grp/alpha'] = [{ name: 'v1.0.0', target: 'tagobj', message: 'Première livraison',
      commit: { id: alpha.mainSha, committed_date: '2026-08-01T10:00:00Z', author_name: 'Alice' } }];
    app.state.tags['grp/beta'] = [];
    idAlpha = (await app.api('POST', '/api/repos', { url: alpha.url, project: 'grp/alpha' })).body.id;
    idBeta = (await app.api('POST', '/api/repos', { url: beta.url, project: 'grp/beta' })).body.id;
    // Un vérificateur qui couvre grp/alpha : « Vérifier cette branche » a de quoi s'ouvrir.
    const script = path.join(app.dataDir, 'verif-ok.sh');
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const v = await app.api('POST', '/api/verifiers', {
      name: 'Tests unitaires', kind: 'commands', commands: [script], timeout_s: 60,
      repos: [{ repo_id: idAlpha, mode: 'worktree' }],
    });
    assert.equal(v.status, 200, v.text);

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

  /** Ouvre Git sur un sous-onglet ; la liste des dépôts de l'explorateur est vidée d'abord,
      pour attendre celle que `loadGit` réécrit et non celle d'avant. */
  async function allerGit(sub) {
    await page.evaluate(() => { const e = document.querySelector('#gitExploreRepoBox'); if (e) e.innerHTML = ''; });
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForFunction(() => document.querySelector('#gitExploreRepoBox .git-multi-pick'));
    await page.locator(`#tab-git .subnav [data-gsub="${sub}"]`).click();
    await page.waitForSelector(`#gsub-${sub}.active`);
  }
  const caseDepot = (id) => page.locator(`#gitExploreRepoBox .git-multi-pick[value="${id}"]`);
  const bloc = () => page.locator(`.git-ex-project[data-repo="${idAlpha}"]`);

  async function toast(motif) {
    await page.waitForFunction((src) => [...document.querySelectorAll('#toasts .toast')]
      .some((t) => new RegExp(src).test(t.textContent)), motif.source);
  }

  /** Analyse grp/alpha seul et déplie son bloc. */
  async function analyserAlpha() {
    await page.evaluate(() => document.querySelectorAll('#gitExploreRepoBox .git-multi-pick:checked').forEach((c) => { c.checked = false; }));
    await caseDepot(idAlpha).check();
    await page.evaluate(() => { document.querySelector('#gitExploreBox').innerHTML = ''; });
    await page.locator('#gitExploreGo').click();
    await bloc().locator('.git-explorer').waitFor({ state: 'attached', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('#gitExploreGo').hasAttribute('data-busy'));
    await bloc().locator('summary').click();
    await page.waitForFunction((id) => document.querySelector(`.git-ex-project[data-repo="${id}"]`).open, idAlpha);
  }

  test('Analyser sans dépôt coché est refusé, en le disant', async () => {
    await allerGit('explore');
    assert.equal(await page.locator('#gitExploreRepoBox .git-multi-pick:checked').count(), 0, 'rien de coché d’office');
    await page.locator('#gitExploreGo').click();
    await toast(/Sélectionne au moins un dépôt à analyser/);
    assert.equal(await page.locator('#gitExploreBox .git-ex-project').count(), 0);
  });

  test('la recherche de dépôts masque, sans décocher', async () => {
    await caseDepot(idAlpha).check();
    await page.locator('#gitExploreRepoBox .repo-multi-search').fill('beta');
    await page.waitForFunction((id) => document.querySelector(`#gitExploreRepoBox .git-multi-pick[value="${id}"]`)
      .closest('.repo-multi-item').hidden, idAlpha);
    assert.equal(await caseDepot(idAlpha).isChecked(), true, 'masqué, grp/alpha reste coché');
    assert.equal(await caseDepot(idBeta).isVisible(), true);
    await page.locator('#gitExploreRepoBox .repo-multi-search').fill('');
    await page.waitForFunction(() => !document.querySelector('#gitExploreRepoBox .repo-multi-item[hidden]'));
  });

  test('l’analyse rend les branches (défaut, avance) et les tags du dépôt', async () => {
    await analyserAlpha();
    assert.match(await bloc().locator('.git-ex-proj-info').innerText(), /2/);
    const lignes = await bloc().locator('.git-explorer tbody tr').allInnerTexts();
    assert.equal(lignes.length, 2);
    const defaut = lignes.find((l) => /main/.test(l) && !/PROJ-42/.test(l));
    assert.match(defaut, /défaut/i, 'la branche par défaut est marquée');
    const travail = lignes.find((l) => /PROJ-42/.test(l));
    assert.match(travail, /↑1/, 'la branche de travail a un commit d’avance');
    // La branche par défaut ne se coche pas : on ne la supprime pas depuis ici.
    assert.equal(await bloc().locator('.git-ex-pick').count(), 1);
    const tags = await bloc().locator('.git-tags').innerText();
    assert.match(tags, /v1\.0\.0/);
    assert.match(tags, /annoté/i);
    assert.match(tags, /Première livraison/);
  });

  test('le filtre de branches masque les lignes, et dit quand rien ne correspond', async () => {
    const filtre = bloc().locator('.git-ex-filter');
    await filtre.fill('PROJ');
    await page.waitForFunction((id) => [...document.querySelectorAll(`.git-ex-project[data-repo="${id}"] .git-explorer tbody tr`)]
      .filter((tr) => !tr.hidden).length === 1, idAlpha);
    await filtre.fill('zzz');
    await bloc().locator('.git-ex-nomatch:not([hidden])').waitFor();
    await filtre.fill('');
    await page.waitForFunction((id) => ![...document.querySelectorAll(`.git-ex-project[data-repo="${id}"] .git-explorer tbody tr`)]
      .some((tr) => tr.hidden), idAlpha);
    assert.equal(await bloc().locator('.git-ex-nomatch').isVisible(), false);
  });

  test('l’auteur d’un tag annoté se lit à la demande', async () => {
    await bloc().locator('[data-tagauthor="v1.0.0"]').click();
    await bloc().locator('.git-tags .git-tagger').waitFor();
    const auteur = await bloc().locator('.git-tags .git-tagger').innerText();
    assert.match(auteur, /Test/, 'le tagger du clone, pas l’auteur du commit que dit l’API');
    assert.match(auteur, /tagger/);
  });

  test('« Créer la MR » : la modale part de la branche vers sa source, et la MR existe sur la forge', async () => {
    const bouton = bloc().locator(`[data-gitmr="${BRANCHE}"]`);
    assert.equal(await bouton.getAttribute('data-target'), 'main');
    await bouton.click();
    await page.waitForSelector('#mrModal:not([hidden])');
    assert.match(await page.locator('#mrModalIntro').innerText(), /PROJ-42-ajout[\s\S]*main/);
    assert.equal(await page.locator('#mrTitle').inputValue(), BRANCHE, 'le titre part du nom de la branche');
    await page.locator('#mrTitle').fill('Ajout de b, depuis l’explorateur');
    await page.locator('#mrGo').click();
    await page.waitForSelector('#mrModal', { state: 'hidden' });
    await attendreServeur(() => (app.state.mrs['grp/alpha'] || []).some((m) => m.title === 'Ajout de b, depuis l’explorateur'),
      'la MR est créée sur la forge');
    const mr = app.state.mrs['grp/alpha'].find((m) => m.title === 'Ajout de b, depuis l’explorateur');
    assert.equal(mr.source_branch, BRANCHE);
    assert.equal(mr.target_branch, 'main');
    // Le bouton devient le lien vers la MR : on ne la recrée pas d'un second clic.
    await bloc().locator(`a.btn:has-text("!${mr.iid}")`).waitFor();
    assert.equal(await bloc().locator(`[data-gitmr="${BRANCHE}"]`).count(), 0);
  });

  test('cocher une branche puis « Supprimer la sélection » ouvre Actions sur l’aperçu, sans rien supprimer', async () => {
    const suppr = bloc().locator('.git-ex-delete');
    assert.equal(await suppr.isDisabled(), true, 'rien de coché, rien à supprimer');
    await bloc().locator(`.git-ex-pick[value="${BRANCHE}"]`).check();
    await page.waitForFunction((id) => !document.querySelector(`.git-ex-project[data-repo="${id}"] .git-ex-delete`).disabled, idAlpha);
    assert.match(await bloc().locator('.git-ex-count').innerText(), /1 branche sélectionnée/);
    await suppr.click();
    await page.waitForSelector('#gsub-actions.active');
    await page.waitForSelector('#gitPreviewBox:not([hidden]) #gitRun');
    assert.equal(await page.locator('#gitAction').inputValue(), 'delete_branch');
    const apercu = await page.locator('#gitPreviewBox').innerText();
    assert.match(apercu, /grp\/alpha/);
    assert.match(apercu, /PROJ-42-ajout/);
    assert.match(apercu, /1 à exécuter/);
    // La sûreté est dite ligne par ligne : ni mergée, ni portée par une MR connue en base.
    assert.match(apercu, /non mergée/);
    assert.ok(app.state.branches['grp/alpha'].some((b) => b.name === BRANCHE), 'l’aperçu ne supprime rien');
    await page.locator('#gitCancel').click();
    await page.waitForSelector('#gitPreviewBox', { state: 'hidden' });
  });

  test('« Vérifier cette branche » ouvre la vérification sur CETTE branche', async () => {
    await page.locator('#tab-git .subnav [data-gsub="explore"]').click();
    await bloc().locator(`[data-gitverif="${BRANCHE}"]`).click();
    await page.waitForSelector('#branchVerifyModal:not([hidden])');
    await page.waitForFunction((b) => document.querySelector('#branchVerifyRows .cb-search').value === b, BRANCHE);
    assert.match(await page.locator('#branchVerifySelect').innerText(), /Tests unitaires/);
    await page.locator('#branchVerifyCancel').click();
    await page.waitForSelector('#branchVerifyModal', { state: 'hidden' });
  });

  test('« Ajouter aux todos » crée une todo liée à la branche', async () => {
    await bloc().locator('[data-add-todo="branch"]').click();
    await page.waitForSelector('#captureModal:not([hidden])');
    assert.equal(await page.locator('#captureTitle').inputValue(), `Branche ${BRANCHE}`);
    await page.locator('#captureOk').click();
    await page.waitForSelector('#captureModal', { state: 'hidden' });
    const trouver = async () => ((await app.api('GET', '/api/todos')).body.todos || [])
      .find((t) => t.link_kind === 'branch' && t.link_ref === `${idAlpha}:${BRANCHE}`);
    await attendreServeur(async () => Boolean(await trouver()), 'la todo est créée');
    assert.equal((await trouver()).title, `Branche ${BRANCHE}`);
  });

  test('« Coder sur cette branche » ouvre une session de codage sur le dépôt et la branche', async () => {
    await bloc().locator(`[data-gitcode="${BRANCHE}"]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(([id, b]) => {
      const row = document.querySelector('#targetRows .target-row');
      return row && row.querySelector('.t-repo').value === String(id) && row.querySelector('.t-branch').value === b;
    }, [idAlpha, BRANCHE]);
    assert.equal(await page.locator('#tab-task.active').count(), 1, 'on est passé sur Dev IA');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  });

  test('les dépôts cochés sont retenus au rechargement', async () => {
    await page.reload();
    await allerGit('explore');
    assert.equal(await caseDepot(idAlpha).isChecked(), true);
    assert.equal(await caseDepot(idBeta).isChecked(), false);
  });

  describe('Trouver une ref', () => {
    const chercher = async (nom, type) => {
      await page.evaluate(() => { document.querySelector('#findRefBox').innerHTML = ''; });
      await page.locator('#findRefName').fill(nom);
      await page.locator('#findRefType').selectOption(type);
      await page.locator('#findRefGo').click();
      await page.waitForFunction(() => {
        const b = document.querySelector('#findRefBox');
        return b.textContent.trim() && !b.querySelector('.skeleton, .sk-line');
      });
    };

    test('un tag : le dépôt qui l’a, ses branches, et son auteur à la demande', async () => {
      await allerGit('findref');
      await chercher('v1.0.0', 'tag');
      assert.match(await page.locator('#findRefInfo').innerText(), /1 dépôt\(s\) sur 2 ont « v1\.0\.0 »/);
      const lignes = page.locator('#findRefBox tbody tr');
      assert.equal(await lignes.count(), 1);
      const texte = await lignes.first().innerText();
      assert.match(texte, /grp\/alpha/);
      assert.match(texte, /tag/);
      assert.match(await lignes.first().locator('.findref-branches').innerText(), /main/, 'la branche qui porte le tag');
      assert.equal(await page.locator('#findRefToNav').count(), 0, 'un tag ne se « positionne » pas');
      await lignes.first().locator('[data-findref-author]').click();
      await page.locator('#findRefBox .git-tagger').waitFor();
      assert.match(await page.locator('#findRefBox .git-tagger').innerText(), /Test/);
    });

    test('une branche : tous les dépôts qui la portent, et le pont vers Navigation', async () => {
      await chercher(BRANCHE, 'branch');
      assert.match(await page.locator('#findRefInfo').innerText(), /2 dépôt\(s\) sur 2/);
      assert.equal(await page.locator('#findRefBox tbody tr').count(), 2);
      assert.equal(await page.locator('#findRefToNav').count(), 1);
    });

    test('une ref inconnue : un vide qui le dit ; un dépôt injoignable : nommé', async () => {
      await chercher('zzz-nulle-part', 'both');
      assert.match(await page.locator('#findRefBox').innerText(), /Aucun dépôt avec « zzz-nulle-part »/);

      app.state.fail = { 'grp%2Fbeta/repository': { status: 500, body: { message: 'panne' } } };
      try {
        await chercher('v1.0.0', 'both');
      } finally { app.state.fail = {}; }
      assert.match(await page.locator('#findRefBox').innerText(), /1 dépôt inaccessible\s*:\s*grp\/beta/);
    });

    test('la dernière recherche est retenue au rechargement', async () => {
      await page.reload();
      await allerGit('findref');
      assert.equal(await page.locator('#findRefName').inputValue(), 'v1.0.0');
      assert.equal(await page.locator('#findRefType').inputValue(), 'both');
    });
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
