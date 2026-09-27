'use strict';
/* MENU GIT — LES SOUS-ONGLETS, « ACTIONS » ET « HISTORIQUE », DANS UN VRAI NAVIGATEUR.
 *
 * Les opérations multi-dépôts sont couvertes par l'API (e2e-git) ; ce fichier passe par
 * l'ÉCRAN, du choix du dépôt jusqu'à la ref réellement créée ou supprimée sur la forge :
 *   - les huit sous-onglets, et celui qu'on retrouve au rechargement ;
 *   - le formulaire qui change de forme selon l'action ;
 *   - créer une branche, un tag par projet avec son message, supprimer des branches cochées
 *     dans une liste filtrée (le filtre MASQUE, il ne décoche rien) — aperçu, confirmation,
 *     et l'état de la forge relu à la fin ;
 *   - « nom suivant », « depuis le presse-papiers », copie d'une commande ;
 *   - la mémoire de l'action et des dépôts, les branches de MR mergées (B7) ;
 *   - « Vérifier une branche » lancé depuis cet écran ;
 *   - l'historique : lots, filtre, « échecs seulement », restauration.
 *
 * Un seul `startApp()` : tous les tests partagent l'app, la forge simulée et le navigateur,
 * et s'enchaînent dans l'ordre (chacun part de l'état laissé par le précédent). */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, git, attendreServeur, navigateurDispo, lancerNavigateur,
  MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const BRANCHE = 'feature/PROJ-42-ajout';

describe('Menu Git : sous-onglets, Actions et Historique', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  let alpha; let beta; let idAlpha; let idBeta;
  const erreurs = [];

  const branche = (name, sha, extra = {}) => ({
    name, default: false, protected: false, merged: false,
    commit: { id: sha, committed_date: '2026-08-01T10:00:00Z', author_name: 'Alice' }, ...extra,
  });
  const nomsBranches = (projet) => (app.state.branches[projet] || []).map((b) => b.name);
  const ops = async () => (await app.api('GET', '/api/git/ops')).body;

  before(async () => {
    app = await startApp();
    await app.configure();
    alpha = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'alpha-')), { branch: BRANCHE });
    beta = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'beta-')), { branch: BRANCHE });
    /* Les refs proposées viennent de la FORGE (faux GitLab) ; le clone, lui, sert au fetch de
       sûreté qui précède une suppression. Les branches « old/* » n'existent que côté forge :
       c'est ce qu'on nettoie. */
    app.state.branches['grp/alpha'] = [
      branche('main', alpha.mainSha, { default: true, protected: true }),
      branche(BRANCHE, alpha.branchSha),
      branche('old/1', alpha.mainSha, { merged: true }),
      branche('old/2', alpha.mainSha, { merged: true }),
      branche('old/3', alpha.mainSha, { merged: true }),
    ];
    app.state.protectedBranches['grp/alpha'] = ['main'];
    app.state.branches['grp/beta'] = [
      branche('main', beta.mainSha, { default: true, protected: true }),
      branche(BRANCHE, beta.branchSha),
    ];
    app.state.protectedBranches['grp/beta'] = ['main'];
    app.state.tags['grp/alpha'] = [];
    app.state.tags['grp/beta'] = [];
    idAlpha = (await app.api('POST', '/api/repos', { url: alpha.url, project: 'grp/alpha' })).body.id;
    idBeta = (await app.api('POST', '/api/repos', { url: beta.url, project: 'grp/beta' })).body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    /* Le presse-papiers d'un Chromium sans tête ne se lit pas sans permission, et ce qu'on y
       écrit ne se relit pas : on le remplace par un double qui garde trace des deux sens. Posé
       à chaque chargement, il survit aux `reload()`. */
    await page.addInitScript(() => {
      window.__copies = [];
      window.__pressePapiers = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (t) => { window.__copies.push(t); },
          readText: async () => window.__pressePapiers,
        },
      });
    });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* ---------------------------------------------------------------- outils ---- */

  /** Ouvre le menu Git sur un sous-onglet, et attend que l'écran soit RECONSTRUIT : on vide
      d'abord ce que `loadGit` réécrit, pour ne pas prendre l'écran précédent pour le nouveau. */
  async function allerGit(sub) {
    await page.evaluate(() => {
      const r = document.querySelector('#gitTargetRows'); if (r) r.innerHTML = '';
      const e = document.querySelector('#gitExploreRepoBox'); if (e) e.innerHTML = '';
    });
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForFunction(() => document.querySelector('#gitExploreRepoBox .git-multi-pick'));
    await page.locator(`#tab-git .subnav [data-gsub="${sub}"]`).click();
    await page.waitForSelector(`#gsub-${sub}.active`);
  }

  /** Les lignes d'action sont remplies : une ref source (création) ou la liste à cocher (suppression). */
  async function lignesPretes(n = null) {
    await page.waitForFunction((attendu) => {
      const rows = [...document.querySelectorAll('#gitTargetRows .git-row')];
      if (!rows.length || (attendu != null && rows.length !== attendu)) return false;
      return rows.every((r) => {
        const h = r.querySelector('.git-ref');
        if (h) return !!h.value;
        // Suppression : la liste (ou « aucune ref », ou l'erreur) a remplacé « chargement… ».
        const box = r.querySelector('.git-refs');
        return !!box && box.textContent.trim() !== '' && !/^(chargement|loading)…$/.test(box.textContent.trim());
      });
    }, n);
  }

  async function fermerMenus() {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForFunction(() => [...document.querySelectorAll('.combo-options')].every((b) => b.hidden));
  }

  /** Choisit une option dans un combo à recherche (dépôt ou ref). */
  async function choisir(champ, texte) {
    await fermerMenus();
    await champ.click();
    const opt = page.locator('.combo-options:not([hidden]) .combo-opt', { hasText: texte }).first();
    await opt.waitFor();
    await opt.click();
  }

  const ligne = (i) => page.locator(`#gitTargetRows .git-row[data-row="${i}"]`);

  async function choisirDepot(i, projet) {
    await choisir(ligne(i).locator('[data-repo-combo]'), projet);
    await page.waitForFunction(([idx, p]) => {
      const r = document.querySelector(`#gitTargetRows .git-row[data-row="${idx}"]`);
      return r && r.querySelector('.rc-search').value === p;
    }, [i, projet]);
  }

  async function action(valeur) {
    await page.locator('#gitAction').selectOption(valeur);
    await lignesPretes();
  }

  async function dernierToast(motif) {
    await page.waitForFunction((src) => [...document.querySelectorAll('#toasts .toast')]
      .some((t) => new RegExp(src).test(t.textContent)), motif.source);
  }

  /* ---------------------------------------------------------------- tests ---- */

  test('les huit sous-onglets ouvrent chacun leur écran, et le dernier revient au rechargement', async () => {
    await allerGit('actions');
    const subs = await page.locator('#tab-git .subnav [data-gsub]').evaluateAll((els) => els.map((e) => e.dataset.gsub));
    assert.deepEqual(subs, ['actions', 'merge', 'navigate', 'commands', 'explore', 'compare', 'findref', 'history']);
    for (const s of subs) {
      await page.locator(`#tab-git .subnav [data-gsub="${s}"]`).click();
      await page.waitForSelector(`#gsub-${s}.active`);
      const actifs = await page.locator('#tab-git .subtab.active').evaluateAll((els) => els.map((e) => e.id));
      assert.deepEqual(actifs, [`gsub-${s}`], `un seul écran à la fois (${s})`);
      assert.equal(await page.locator(`#tab-git .subnav [data-gsub="${s}"].active`).count(), 1);
    }
    // On revient là où on était : « Historique », dernier ouvert.
    await page.reload();
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#gsub-history.active');
    assert.equal(await page.locator('#tab-git .subnav [data-gsub="history"].active').count(), 1);
  });

  test('le formulaire change de forme selon l’action', async () => {
    await allerGit('actions');
    await lignesPretes();
    // Créer une branche : un nom, pas de message, la bascule « même nom ».
    assert.equal(await page.locator('#gitNameField').isVisible(), true);
    assert.equal(await page.locator('#gitMsgField').isVisible(), false);
    assert.equal(await page.locator('#gitSameNameField').isVisible(), true);
    assert.match(await page.locator('#gitNameLabel').innerText(), /branche/i);

    await action('create_tag');
    assert.equal(await page.locator('#gitMsgField').isVisible(), true, 'un tag peut porter un message');
    assert.match(await page.locator('#gitNameLabel').innerText(), /tag/i);

    await action('delete_branch');
    assert.equal(await page.locator('#gitNameField').isVisible(), false, 'on ne nomme rien pour supprimer');
    assert.equal(await page.locator('#gitSameNameField').isVisible(), false);
    assert.equal(await ligne(0).locator('.git-refs .git-ref-list').count(), 1, 'une liste à cocher remplace le combo');
    // La branche par défaut, protégée, n'est même pas proposée — et c'est dit.
    const libelles = await ligne(0).locator('.git-ref-item code').allTextContents();
    assert.ok(!libelles.includes('main'), libelles.join(', '));
    assert.match(await ligne(0).locator('.git-ref-hidden').innerText(), /masquée/);

    await action('delete_tag');
    assert.match(await page.locator('#gitTargetsLabel').innerText(), /tag/i);

    await action('new_branch');
    assert.equal(await page.locator('#gitNameField').isVisible(), true);
  });

  test('créer une branche : aperçu, commande copiable, exécution, et la branche existe sur la forge', async () => {
    await choisirDepot(0, 'grp/alpha');
    await lignesPretes(1);
    assert.equal(await ligne(0).locator('[data-combo="git-ref"]').inputValue(), 'main', 'la branche par défaut est proposée');

    await page.locator('#gitRefName').fill('release/1.4');
    await page.locator('#gitPreview').click();
    await page.waitForSelector('#gitPreviewBox:not([hidden]) .git-preview');
    const apercu = await page.locator('#gitPreviewBox').innerText();
    assert.match(apercu, /grp\/alpha/);
    assert.match(apercu, /release\/1\.4/, 'le nom fabriqué est montré à côté de la source');
    assert.match(apercu, /sera exécutée/);
    assert.match(apercu, /1 à exécuter · 0 ignorées · 0 bloquées/);

    // La commande équivalente se COPIE entière, sans l'étiquette.
    const cmd = page.locator('#gitPreviewBox .git-cmd:not(.git-cmd-real):not(.git-cmd-api) .git-cmd-copy');
    const texteCmd = await cmd.getAttribute('data-copy-txt');
    assert.match(texteCmd, /git push origin main:refs\/heads\/release\/1\.4/);
    await cmd.click();
    await page.waitForFunction((t) => window.__copies.includes(t), texteCmd);
    await dernierToast(/Copié/);

    // Retoucher le nom APRÈS l'aperçu le périme : on ne confirme pas autre chose que ce qui part.
    await page.locator('#gitRefName').fill('release/1.4x');
    await page.waitForSelector('#gitPreviewBox', { state: 'hidden' });
    await page.locator('#gitRefName').fill('release/1.4');
    await page.locator('#gitPreview').click();
    await page.waitForSelector('#gitPreviewBox:not([hidden]) #gitRun');

    // « Annuler » referme l'aperçu sans rien lancer.
    await page.locator('#gitCancel').click();
    await page.waitForSelector('#gitPreviewBox', { state: 'hidden' });
    assert.equal((await ops()).length, 0, 'annuler n’a rien exécuté');

    await page.locator('#gitPreview').click();
    await page.waitForSelector('#gitPreviewBox:not([hidden]) #gitRun');
    await page.locator('#gitRun').click();
    await attendreServeur(() => nomsBranches('grp/alpha').includes('release/1.4'), 'la branche est créée sur la forge');
    await waitForJobs(app.api);
    await page.waitForSelector('#gitPreviewBox', { state: 'hidden' });
    const op = (await ops()).find((o) => o.ref_name === 'release/1.4');
    assert.equal(op.action, 'new_branch');
    assert.equal(op.status, 'done');
    assert.equal(op.source_ref, 'main', 'la source retenue est celle de la ligne');
  });

  test('l’action et les dépôts sont retenus, et le nom suivant est proposé', async () => {
    await page.reload();
    await allerGit('actions');
    await lignesPretes(1);
    assert.equal(await ligne(0).locator('.rc-search').inputValue(), 'grp/alpha', 'le dépôt de la dernière fois');
    assert.equal(await page.locator('#gitAction').inputValue(), 'new_branch');
    // `release/1.4` était le dernier nom : on propose `release/1.5`, sans le remplir d'office.
    await page.waitForSelector('#gitNameSuivant:not([hidden])');
    assert.equal(await page.locator('#gitNameSuivant').innerText(), 'release/1.5');
    assert.equal(await page.locator('#gitRefName').inputValue(), '');
    await page.locator('#gitNameSuivant').click();
    assert.equal(await page.locator('#gitRefName').inputValue(), 'release/1.5');
  });

  test('« Depuis le presse-papiers » prend la clé de ticket, et refuse un texte qui n’en a pas', async () => {
    await page.evaluate(() => { window.__pressePapiers = 'Voir PROJ-77 dans Jira, c’est urgent'; });
    await page.locator('#gitNameColler').click();
    await page.waitForFunction(() => document.querySelector('#gitRefName').value === 'feature/PROJ-77');

    await page.evaluate(() => { window.__pressePapiers = 'rien d’utile ici'; });
    await page.locator('#gitNameColler').click();
    await dernierToast(/Aucune clé de ticket/);
    assert.equal(await page.locator('#gitRefName').inputValue(), 'feature/PROJ-77', 'le champ n’est pas écrasé');
    await page.locator('#gitRefName').fill('');
  });

  test('un nom par projet : deux lignes, deux tags différents, avec leur message', async () => {
    await action('create_tag');
    await page.locator('#gitSameName').click();
    await page.waitForSelector('#gitTargetRows .git-row .git-name');
    assert.equal(await page.locator('#gitNameRow').isVisible(), false, 'plus de champ global');

    // Deux lignes (plus une ajoutée puis retirée : la croix enlève SA ligne).
    await page.locator('#gitAddTarget').click();
    await lignesPretes(2);
    await page.locator('#gitAddTarget').click();
    await lignesPretes(3);
    await page.locator('#gitTargetRows [data-gitrm="2"]').click();
    await lignesPretes(2);
    await choisirDepot(1, 'grp/beta');
    await lignesPretes(2);

    // Une ligne sans nom : l'aperçu refuse, et dit pourquoi.
    await ligne(0).locator('.git-name').fill('v2.0.0');
    await page.locator('#gitPreview').click();
    await dernierToast(/Renseigne un nom pour chaque projet/);
    assert.equal(await page.locator('#gitPreviewBox').isVisible(), false);

    await ligne(1).locator('.git-name').fill('beta-2026.09');
    await page.locator('#gitTagMsg').fill('Livraison de septembre');
    await page.locator('#gitPreview').click();
    await page.waitForSelector('#gitPreviewBox:not([hidden]) #gitRun');
    assert.deepEqual(await page.locator('#gitPreviewBox .git-pv-target').allTextContents(), ['v2.0.0', 'beta-2026.09']);

    await page.locator('#gitRun').click();
    await attendreServeur(() => (app.state.tags['grp/beta'] || []).some((t) => t.name === 'beta-2026.09'), 'les deux tags sont créés');
    await waitForJobs(app.api);
    const tagAlpha = app.state.tags['grp/alpha'].find((t) => t.name === 'v2.0.0');
    assert.ok(tagAlpha, 'chaque dépôt reçoit SON tag');
    assert.equal(tagAlpha.message, 'Livraison de septembre', 'le message fait un tag annoté');
    assert.ok(!app.state.tags['grp/beta'].some((t) => t.name === 'v2.0.0'), 'aucun nom ne déborde sur l’autre dépôt');

    await page.locator('#gitSameName').click();   // l'écran rendu tel qu'on l'a trouvé
    await page.waitForSelector('#gitNameRow:not([hidden])');
  });

  test('supprimer des branches : le filtre masque sans décocher, l’aperçu dit ce qui est sûr, la suppression se confirme', async () => {
    await action('delete_branch');
    await lignesPretes(2);
    await page.locator('#gitTargetRows [data-gitrm="1"]').click();   // on ne garde que grp/alpha
    await lignesPretes(1);
    const liste = ligne(0).locator('.git-refs');
    const caseDe = (nom) => liste.locator(`.git-ref-item input[value="${nom}"]`);

    await caseDe('old/1').click();
    await liste.locator('.git-ref-filter').fill('old/2');
    await page.waitForFunction(() => document.querySelector('.git-ref-item[data-name="old/1"]').hidden);
    assert.equal(await caseDe('old/1').isChecked(), true, 'masquée, la case reste cochée');
    await caseDe('old/2').click();
    await liste.locator('.git-ref-filter').fill('zzz');
    await page.waitForSelector('.git-ref-nomatch:not([hidden])');
    await liste.locator('.git-ref-filter').fill('');
    await page.waitForFunction(() => !document.querySelector('.git-ref-item[hidden]'));

    await page.locator('#gitPreview').click();
    await page.waitForSelector('#gitPreviewBox:not([hidden]) #gitRun');
    const apercu = await page.locator('#gitPreviewBox').innerText();
    assert.match(apercu, /old\/1/);
    assert.match(apercu, /old\/2/);
    assert.match(apercu, /2 à exécuter/);
    assert.equal(await page.locator('#gitPreviewBox .git-pv-safe').count(), 1, 'la copie de sûreté est annoncée');
    assert.match(await page.locator('#gitRun').getAttribute('class'), /btn-danger/);

    // Refuser la confirmation : rien ne part.
    await page.locator('#gitRun').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.ok(nomsBranches('grp/alpha').includes('old/1'));

    await page.locator('#gitRun').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(() => !nomsBranches('grp/alpha').includes('old/1') && !nomsBranches('grp/alpha').includes('old/2'),
      'les deux branches sont supprimées');
    await waitForJobs(app.api);
    const supp = (await ops()).filter((o) => o.action === 'delete_branch');
    assert.deepEqual(supp.map((o) => o.ref_name).sort(), ['old/1', 'old/2'],
      'une suppression par branche : le refus précédent n’a rien lancé');
    assert.ok(supp.every((o) => o.status === 'done' && o.restorable));
  });

  test('« Vérifier une branche » depuis Git : refus sans vérificateur, puis la modale sur la branche par défaut', async () => {
    await page.locator('#btnVerifyBranch').click();
    await dernierToast(/Aucun vérificateur ne couvre/);
    assert.equal(await page.locator('#branchVerifyModal').isVisible(), false);

    const script = path.join(app.dataDir, 'verif-ok.sh');
    fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const v = await app.api('POST', '/api/verifiers', {
      name: 'Tests unitaires', kind: 'commands', commands: [script], timeout_s: 60,
      repos: [{ repo_id: idAlpha, mode: 'worktree' }],
    });
    assert.equal(v.status, 200, v.text);

    await page.locator('#btnVerifyBranch').click();
    await page.waitForSelector('#branchVerifyModal:not([hidden])');
    assert.match(await page.locator('#branchVerifySelect').innerText(), /Tests unitaires/);
    await page.waitForFunction(() => document.querySelector('#branchVerifyRows .cb-search').value === 'main');
    assert.match(await page.locator('#branchVerifyRows').innerText(), /grp\/alpha/);
    await page.locator('#branchVerifyCancel').click();
    await page.waitForSelector('#branchVerifyModal', { state: 'hidden' });
  });

  test('B7 : les branches de merge requests mergées remplissent le lot et lancent l’aperçu', async () => {
    // Deux MR fermées sur old/3 et BRANCHE ; mais BRANCHE porte aussi une MR OUVERTE : elle vit encore.
    const ins = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, closed_seen)
      VALUES (?, ?, ?, ?, 'main', 'reviewed', ?)`);
    ins.run(idAlpha, 501, 'Vieille MR', 'old/3', 1);
    ins.run(idAlpha, 502, 'MR fermée', BRANCHE, 1);
    ins.run(idAlpha, 503, 'MR rouverte', BRANCHE, 0);
    assert.equal((await app.api('GET', '/api/git/merged-branches')).body.total, 1);

    await page.reload();
    await allerGit('actions');
    await page.waitForSelector('#gitMergedBar:not([hidden])');
    assert.match(await page.locator('#gitMergedFill').innerText(), /Supprimer la branche d’une merge request mergée/);
    await page.locator('#gitMergedFill').click();
    await page.waitForSelector('#gitPreviewBox:not([hidden]) #gitRun');
    assert.equal(await page.locator('#gitAction').inputValue(), 'delete_branch');
    const apercu = await page.locator('#gitPreviewBox').innerText();
    assert.match(apercu, /old\/3/);
    assert.doesNotMatch(apercu, /PROJ-42/, 'une branche encore portée par une MR ouverte n’est pas proposée');
    assert.match(apercu, /mergée dans/, 'la sûreté est dite, branche par branche');
    // Le lot est pré-rempli, pas exécuté.
    assert.ok(nomsBranches('grp/alpha').includes('old/3'));
    await page.locator('#gitCancel').click();
    await page.waitForSelector('#gitPreviewBox', { state: 'hidden' });
  });

  describe('Historique', () => {
    before(async () => {
      // Un échec, pour « Échecs seulement » : la forge refuse la suppression du tag.
      app.state.fail = { '/repository/tags/': { status: 403, body: { message: 'protected tag' } } };
      await app.api('POST', '/api/git/execute', { action: 'delete_tag', targets: [{ repo_id: idBeta, refs: ['beta-2026.09'] }] });
      await waitForJobs(app.api);
      app.state.fail = {};
      assert.equal((await ops())[0].status, 'error');
    });

    test('les opérations sont listées par geste, avec leur source et l’état du clone', async () => {
      await allerGit('history');
      await page.waitForSelector('#gitHistoryBox .git-op');
      // Quatre gestes : une branche, deux tags d'un coup, deux suppressions d'un coup, un échec.
      assert.equal(await page.locator('#gitHistoryBox .git-op').count(), 4);
      assert.equal(await page.locator('#gitHistoryBox .git-op-groupe').count(), 2);
      const texte = await page.locator('#gitHistoryBox').innerText();
      assert.match(texte, /2 opérations d’un même geste/);
      assert.match(texte, /release\/1\.4\s+depuis main/);
      assert.match(texte, /clone à jour avant l’opération/, 'la copie de sûreté est datée d’un fetch');
      assert.match(texte, /protected tag|403/, 'le texte de l’erreur est sous les yeux');
      assert.match(texte, /Livraison de septembre/, 'le message du tag');
    });

    test('le filtre et « Échecs seulement » masquent, sans rien retirer', async () => {
      await page.locator('#gitHistFilter').fill('beta-2026');
      await page.waitForFunction(() => document.querySelectorAll('#gitHistoryBox .git-op:not([hidden])').length === 2);
      await page.locator('#gitHistErrOnly').click();
      await page.waitForFunction(() => document.querySelectorAll('#gitHistoryBox .git-op:not([hidden])').length === 1);
      assert.match(await page.locator('#gitHistoryBox .git-op:not([hidden])').innerText(), /échec/);
      await page.locator('#gitHistFilter').fill('zzz-rien');
      await page.waitForSelector('#gitHistNoMatch:not([hidden])');
      await page.locator('#gitHistFilter').fill('');
      await page.locator('#gitHistErrOnly').click();
      await page.waitForFunction(() => document.querySelectorAll('#gitHistoryBox .git-op:not([hidden])').length === 4);
      assert.equal(await page.locator('#gitHistNoMatch').isVisible(), false);
      assert.equal(await page.locator('#gitHistoryBox .git-op').count(), 4, 'rien n’a été retiré');
    });

    test('restaurer une branche supprimée : confirmation, puis la branche revient sur le dépôt distant', async () => {
      const op = (await ops()).find((o) => o.action === 'delete_branch' && o.ref_name === 'old/1');
      await page.locator(`#gitHistoryBox [data-gitrestore="${op.id}"]`).click();
      await page.waitForSelector('#confirmModal:not([hidden])');
      await page.locator('#confirmOk').click();
      await attendreServeur(async () => Boolean((await ops()).find((o) => o.id === op.id).restored_at), 'la restauration est datée');
      await waitForJobs(app.api);
      /* La restauration repousse le SHA gardé dans le clone vers le dépôt distant : c'est LUI
         qui doit porter la branche de nouveau, au commit d'avant la suppression. */
      const distante = git(alpha.bare, ['ls-remote', '--heads', alpha.bare, 'old/1']).trim();
      assert.match(distante, new RegExp(`^${op.ref_sha}\\s+refs/heads/old/1$`), `ref distante : « ${distante} »`);
      const apres = (await ops()).find((o) => o.id === op.id);
      assert.equal(apres.restorable, false);
      // Rouvert, l'historique le dit, et ne propose plus de restaurer deux fois.
      await page.locator('#tab-git .subnav [data-gsub="actions"]').click();
      await page.locator('#tab-git .subnav [data-gsub="history"]').click();
      await page.waitForFunction((id) => !document.querySelector(`#gitHistoryBox [data-gitrestore="${id}"]`)
        && /restaurée/.test(document.querySelector('#gitHistoryBox').textContent), op.id);
    });
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
