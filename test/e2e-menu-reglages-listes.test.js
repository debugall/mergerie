'use strict';
/* MENU « RÉGLAGES » — LES LISTES QU'ON Y TIENT, DANS UN VRAI NAVIGATEUR.
 *
 * Ce que les sous-onglets gèrent ligne par ligne, hors du formulaire global :
 *   - Dépôts : l'ajout par URL (chemin déduit, URL absurde refusée sous le champ), la recherche
 *     qui masque, la modification en ligne, « Suivi » et « Récupérer les MR », la fiche, le
 *     re-clonage, la suppression confirmée, l'ajout en masse depuis GitLab ET depuis GitHub ;
 *   - Répertoires locaux : ajout (le décompte des projets git) et suppression ;
 *   - Règles de review : ajout (portée par dépôt comprise), filtre, modification en ligne,
 *     activation, duplication, suppression différée et son « Annuler » ;
 *   - Git : la palette de commandes (ajouter, modifier, annuler, supprimer) ;
 *   - Jenkins : les jobs liés aux dépôts (le combo PROPOSE les jobs réels de Jenkins).
 *
 * Chaque geste est jugé sur son EFFET côté serveur, relu par l'API — jamais sur un libellé.
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
  afficherMenusOptionnels,
} = require('./helpers/app');
const mockJenkins = require('./helpers/mock-jenkins');

const { dispo } = navigateurDispo();

describe('Menu Réglages — dépôts, répertoires, règles, palette git, jobs liés', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let jenkins; let reel;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    assert.equal((await app.configure()).status, 200);
    assert.equal((await app.configureGithub()).status, 200);
    // Ce que les deux forges proposeront à l'ajout en masse.
    app.state.projects = [
      { id: 11, path_with_namespace: 'grp/masse-a', name_with_namespace: 'grp / masse-a', http_url_to_repo: 'https://gitlab.test/grp/masse-a.git', ssh_url_to_repo: 'git@gitlab.test:grp/masse-a.git' },
      { id: 12, path_with_namespace: 'grp/masse-b', name_with_namespace: 'grp / masse-b', http_url_to_repo: 'https://gitlab.test/grp/masse-b.git', ssh_url_to_repo: 'git@gitlab.test:grp/masse-b.git' },
      { id: 13, path_with_namespace: 'autre/outil', name_with_namespace: 'autre / outil', http_url_to_repo: 'https://gitlab.test/autre/outil.git', ssh_url_to_repo: 'git@gitlab.test:autre/outil.git' },
    ];
    app.ghState.repos = [
      { id: 21, full_name: 'org/masse-gh', clone_url: 'https://github.com/org/masse-gh.git', ssh_url: 'git@github.com:org/masse-gh.git', default_branch: 'main' },
    ];
    // Un vrai dépôt : c'est lui qu'on re-clone.
    reel = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-reel-')));
    assert.equal((await app.api('POST', '/api/repos', { project: 'grp/reel', url: reel.url })).status, 200);

    // Un Jenkins qui connaît un job, avec le paramètre qui reçoit la branche.
    jenkins = await mockJenkins.start();
    mockJenkins.reset();
    mockJenkins.state.jobs = [{ name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
      { name: 'api-build', color: 'blue', buildable: true, lastBuild: {
        number: 3, timestamp: 1000,
        actions: [{ causes: [{ userName: 'Alice' }] }, { parameters: [{ name: 'BRANCHE', value: 'main', _class: 'hudson.model.StringParameterValue' }] }],
      } },
    ] }];
    assert.equal((await app.api('PUT', '/api/config', {
      jenkins_url: jenkins.url, jenkins_user: mockJenkins.state.user, jenkins_token: mockJenkins.state.token,
    })).status, 200);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (jenkins) await jenkins.close();
    if (app) await app.stop();
  });

  const ouvrir = async (sub) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
  };
  const confirmer = async () => {
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
  };
  const renoncer = async () => {
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
  };
  const depots = async () => (await app.api('GET', '/api/repos')).body;
  const depot = async (projet) => (await depots()).find((r) => r.project === projet);
  const ligne = (id) => page.locator(`#repoList .repo-row[data-repo="${id}"]`);

  /* ---------------------------------------------------------------- Dépôts ---- */

  test('ajouter par l’URL : une URL absurde est refusée sous le champ, une vraie déduit le chemin', async () => {
    await ouvrir('repos');
    await page.waitForSelector('#repoList .repo-row');
    const avant = (await depots()).length;
    await page.locator('#repoForm [name="url"]').fill('toto');
    await page.locator('#repoForm button[type="submit"]').click();
    await page.waitForSelector('#repoForm .field-error');
    assert.equal((await depots()).length, avant, 'rien n’est créé sur une URL qui n’en est pas une');

    await page.locator('#repoForm [name="url"]').fill('https://gitlab.test/grp/sous/projet-url.git');
    await page.locator('#repoForm [name="branch_pattern"]').fill('PROJ-');
    await page.locator('#repoForm button[type="submit"]').click();
    await attendreServeur(async () => Boolean(await depot('grp/sous/projet-url')), 'le dépôt ajouté par son URL');
    const d = await depot('grp/sous/projet-url');
    assert.equal(d.branch_pattern, 'PROJ-');
    assert.equal(d.forge, 'gitlab');
    await page.waitForSelector(`#repoList .repo-row[data-repo="${d.id}"]`);
    assert.equal(await page.locator('#repoForm [name="url"]').inputValue(), '', 'le formulaire se vide une fois le dépôt ajouté');
  });

  test('la recherche masque les dépôts sans en retirer, et dit quand rien ne correspond', async () => {
    const total = (await depots()).length;
    await page.locator('#repoSearch').fill('projet-url');
    await page.waitForFunction(() => [...document.querySelectorAll('#repoList .repo-row')].filter((r) => !r.hidden).length === 1);
    await page.locator('#repoSearch').fill('rien-de-tel');
    await page.waitForSelector('#repoSearchNone:not([hidden])');
    await page.locator('#repoSearch').fill('');
    await page.waitForFunction((n) => [...document.querySelectorAll('#repoList .repo-row')].filter((r) => !r.hidden).length === n, total);
    assert.equal(await page.locator('#repoSearchNone').isHidden(), true);
    assert.equal((await depots()).length, total, 'filtrer n’a rien retiré');
  });

  test('« Modifier » : URL, chemin et motif s’enregistrent ; « Annuler » ne touche à rien', async () => {
    const d = await depot('grp/sous/projet-url');
    await ligne(d.id).locator('[data-edit]').click();
    await ligne(d.id).locator('.repo-edit [data-f="branch_pattern"]').fill('rien-du-tout');
    await ligne(d.id).locator(`[data-cancel="${d.id}"]`).click();
    await page.waitForFunction((id) => document.querySelector(`#repoList .repo-row[data-repo="${id}"] .repo-edit`).hidden, d.id);
    assert.equal((await depot('grp/sous/projet-url')).branch_pattern, 'PROJ-', 'annuler n’envoie rien');

    await ligne(d.id).locator('[data-edit]').click();
    await ligne(d.id).locator('.repo-edit [data-f="url"]').fill('https://gitlab.test/grp/renomme.git');
    await ligne(d.id).locator('.repo-edit [data-f="project"]').fill('grp/renomme');
    await ligne(d.id).locator('.repo-edit [data-f="branch_pattern"]').fill('feature/');
    await ligne(d.id).locator(`[data-save="${d.id}"]`).click();
    await attendreServeur(async () => Boolean(await depot('grp/renomme')), 'le dépôt modifié');
    const m = await depot('grp/renomme');
    assert.equal(m.id, d.id, 'c’est le même dépôt, pas un nouveau');
    assert.equal(m.url, 'https://gitlab.test/grp/renomme.git');
    assert.equal(m.branch_pattern, 'feature/');
    await page.waitForFunction((id) => /grp\/renomme/.test(document.querySelector(`#repoList .repo-row[data-repo="${id}"] .title`).textContent), d.id);
  });

  test('« Suivi » et « Récupérer les MR » s’enregistrent, et se relisent après rechargement', async () => {
    const d = await depot('grp/renomme');
    await ligne(d.id).locator(`[data-toggle="${d.id}"]`).click();
    await attendreServeur(async () => !(await depot('grp/renomme')).enabled, 'le dépôt n’est plus suivi');
    await ligne(d.id).locator(`[data-fetch="${d.id}"]`).click();
    await attendreServeur(async () => !(await depot('grp/renomme')).fetch_mrs, 'la récupération des MR est coupée');
    await page.reload();
    await ouvrir('repos');
    await page.waitForSelector(`#repoList .repo-row[data-repo="${d.id}"]`);
    assert.equal(await ligne(d.id).locator(`[data-toggle="${d.id}"]`).isChecked(), false);
    assert.equal(await ligne(d.id).locator(`[data-fetch="${d.id}"]`).isChecked(), false);
    // …et dans l'autre sens.
    await ligne(d.id).locator(`[data-toggle="${d.id}"]`).click();
    await ligne(d.id).locator(`[data-fetch="${d.id}"]`).click();
    await attendreServeur(async () => { const r = await depot('grp/renomme'); return Boolean(r.enabled && r.fetch_mrs); },
      'le dépôt est de nouveau suivi et récupéré');
  });

  test('la fiche d’un dépôt liste ce qui lui est rattaché, et chaque entrée mène à son écran', async () => {
    const d = await depot('grp/reel');
    assert.equal((await app.api('POST', '/api/verifiers', {
      name: 'fiche-verif', kind: 'commands', commands: ['npm test'], repos: [{ repo_id: d.id, mode: 'worktree' }],
    })).status, 200);
    assert.equal((await app.api('POST', '/api/rules', { branch_match: 'X-', label: 'fiche-regle', content: 'Vérifier X', repo_id: d.id })).status, 200);
    await ouvrir('repos');
    await ligne(d.id).locator(`[data-sheet="${d.id}"]`).click();
    await page.waitForFunction((id) => /fiche-verif/.test(document.querySelector(`#repoList .repo-row[data-repo="${id}"] .repo-sheet`).textContent)
      && /fiche-regle/.test(document.querySelector(`#repoList .repo-row[data-repo="${id}"] .repo-sheet`).textContent), d.id);
    // La porte de la règle ouvre le sous-onglet des règles.
    await ligne(d.id).locator('[data-sheet-rule]').click();
    await page.waitForSelector('#sub-rules.active');
    await ouvrir('repos');
    await page.waitForSelector(`#repoList .repo-row[data-repo="${d.id}"]`);
    await ligne(d.id).locator(`[data-sheet="${d.id}"]`).click();
    await page.waitForFunction((id) => !document.querySelector(`#repoList .repo-row[data-repo="${id}"] .repo-sheet`).hidden, d.id);
    await ligne(d.id).locator('[data-sheet-verifier]').click();
    await page.waitForSelector('#sub-verifiers.active');
  });

  test('« Re-cloner » demande confirmation, puis le clone existe vraiment', async () => {
    const d = await depot('grp/reel');
    assert.equal(d.clone_state, 'absent', 'le décor part sans clone');
    await ouvrir('repos');
    await page.waitForSelector(`#repoList .repo-row[data-repo="${d.id}"]`);
    await ligne(d.id).locator(`[data-reclone="${d.id}"]`).click();
    await renoncer();
    assert.equal((await depot('grp/reel')).clone_state, 'absent', 'renoncer ne clone rien');
    await ligne(d.id).locator(`[data-reclone="${d.id}"]`).click();
    await confirmer();
    /* « présent » = `.git` existe, ce que `git clone` pose AVANT d'extraire les fichiers : sur un
       runner chargé, l'état arrive avant le README. On attend l'effet, le fichier lui-même. */
    await attendreServeur(async () => (await depot('grp/reel')).clone_state === 'present', 'le clone est posé', 60000);
    const cloneDir = (await depot('grp/reel')).clone_dir;
    await attendreServeur(() => fs.existsSync(path.join(cloneDir, 'README.md')), 'le clone porte les fichiers du dépôt', 60000);
    await page.waitForSelector(`#repoList .repo-row[data-repo="${d.id}"] .repo-clone-present`);
  });

  test('supprimer un dépôt demande confirmation ; renoncer le garde, confirmer le retire', async () => {
    const d = await depot('grp/renomme');
    await ligne(d.id).locator(`[data-del="${d.id}"]`).click();
    await renoncer();
    assert.ok(await depot('grp/renomme'), 'toujours là');
    await ligne(d.id).locator(`[data-del="${d.id}"]`).click();
    await confirmer();
    await attendreServeur(async () => !(await depot('grp/renomme')), 'le dépôt est supprimé');
    await page.waitForSelector(`#repoList .repo-row[data-repo="${d.id}"]`, { state: 'detached' });
  });

  test('ajout en masse depuis GitLab : filtre, tout cocher, tout décocher, motif — puis « déjà suivi »', async () => {
    await ouvrir('repos');
    await page.locator('#btnBrowseProjects').click();
    await page.waitForSelector('#bulkModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#bulkList input[data-proj]').length === 3);
    assert.equal(await page.locator('#bulkAdd').isDisabled(), true, 'rien de coché : rien à ajouter');
    // Le filtre ne garde que « grp/… » ; « Tout cocher » ne coche que ce qu'on voit.
    await page.locator('#bulkSearch').fill('grp/');
    await page.waitForFunction(() => document.querySelectorAll('#bulkList input[data-proj]').length === 2);
    await page.locator('#bulkAll').click();
    await page.waitForFunction(() => /2/.test(document.querySelector('#bulkCount').textContent));
    await page.locator('#bulkNone').click();
    await page.waitForFunction(() => document.querySelector('#bulkAdd').disabled);
    await page.locator('#bulkList input[data-proj="grp/masse-a"]').click();
    await page.locator('#bulkList input[data-proj="grp/masse-b"]').click();
    await page.locator('#bulkPattern').fill('JIRA-');
    await page.locator('#bulkAdd').click();
    await page.waitForSelector('#bulkModal', { state: 'hidden' });
    await attendreServeur(async () => Boolean((await depot('grp/masse-a')) && (await depot('grp/masse-b'))), 'les deux dépôts cochés');
    assert.equal((await depot('grp/masse-a')).branch_pattern, 'JIRA-');
    assert.equal((await depot('grp/masse-a')).url, 'https://gitlab.test/grp/masse-a.git');
    assert.equal(await depot('autre/outil'), undefined, 'ce qui n’était pas coché n’est pas ajouté');

    // Rouvert : ce qui est suivi est coché ET verrouillé.
    await page.locator('#btnBrowseProjects').click();
    await page.waitForSelector('#bulkList input[data-proj="grp/masse-a"]');
    assert.equal(await page.locator('#bulkList input[data-proj="grp/masse-a"]').isDisabled(), true);
    assert.equal(await page.locator('#bulkList input[data-proj="autre/outil"]').isDisabled(), false);
    await page.locator('#bulkCancel').click();
    await page.waitForSelector('#bulkModal', { state: 'hidden' });
  });

  test('ajout en masse depuis GitHub : le dépôt arrive avec sa forge', async () => {
    await page.locator('#btnBrowseGithub').click();
    await page.waitForSelector('#bulkList input[data-proj="org/masse-gh"]');
    await page.locator('#bulkList input[data-proj="org/masse-gh"]').click();
    await page.locator('#bulkAdd').click();
    await page.waitForSelector('#bulkModal', { state: 'hidden' });
    await attendreServeur(async () => Boolean(await depot('org/masse-gh')), 'le dépôt GitHub');
    assert.equal((await depot('org/masse-gh')).forge, 'github');
  });

  /* ------------------------------------------------------ Répertoires locaux ---- */

  test('un répertoire local s’ajoute avec son décompte de projets git, et se supprime', async () => {
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-locale-'));
    fs.mkdirSync(path.join(racine, 'projet-git'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path.join(racine, 'projet-git') });
    fs.mkdirSync(path.join(racine, 'dossier-simple'));
    await ouvrir('repos');
    await page.locator('#localRootForm [name="path"]').fill(racine);
    await page.locator('#localRootForm [name="label"]').fill('Mes projets');
    await page.locator('#localRootForm button[type="submit"]').click();
    const racines = async () => (await app.api('GET', '/api/local-roots')).body;
    await attendreServeur(async () => (await racines()).some((r) => r.path === racine), 'le répertoire est déclaré');
    const r = (await racines()).find((x) => x.path === racine);
    assert.equal(r.label, 'Mes projets');
    assert.equal(r.git_count, 1);
    assert.equal(r.count, 2);
    await page.waitForFunction(() => /projet-git/.test(document.querySelector('#localRootList').textContent)
      && /Mes projets/.test(document.querySelector('#localRootList').textContent));

    await page.locator(`#localRootList [data-rootdel="${r.id}"]`).click();
    await confirmer();
    await attendreServeur(async () => !(await racines()).some((x) => x.id === r.id), 'le répertoire est retiré');
    await page.waitForSelector(`#localRootList [data-rootdel="${r.id}"]`, { state: 'detached' });
  });

  /* ------------------------------------------------------------- Règles ---- */

  const regles = async () => (await app.api('GET', '/api/rules')).body;
  const regle = async (label) => (await regles()).find((r) => r.label === label);
  const carte = (id) => page.locator(`#ruleList .repo-row[data-rule="${id}"]`);

  test('une règle s’ajoute depuis le formulaire, limitée au dépôt choisi dans la liste', async () => {
    await ouvrir('rules');
    await page.waitForSelector('#ruleRepoBox [data-repo-combo]');
    await page.locator('#ruleForm [name="branch_match"]').fill('PAY-');
    await page.locator('#ruleForm [name="path_match"]').fill('**/migrations/**');
    // Le dépôt se CHOISIT dans une liste qui se filtre.
    await page.locator('#ruleRepoBox [data-repo-combo]').click();
    await page.locator('#ruleRepoBox [data-repo-combo]').fill('masse-b');
    await page.locator('#ruleRepoBox .combo-opt[data-r]').first().waitFor();
    await page.locator('#ruleRepoBox .combo-opt[data-r]').first().dispatchEvent('mousedown');
    await page.locator('#ruleForm [name="label"]').fill('paiement');
    await page.locator('#ruleForm [name="content"]').fill('Vérifier que la migration est réversible.');
    await page.locator('#ruleForm button[type="submit"]').click();
    await attendreServeur(async () => Boolean(await regle('paiement')), 'la règle est créée');
    const r = await regle('paiement');
    assert.equal(r.branch_match, 'PAY-');
    assert.equal(r.path_match, '**/migrations/**');
    assert.equal(r.content, 'Vérifier que la migration est réversible.');
    assert.equal(r.repo_id, (await depot('grp/masse-b')).id, 'la portée choisie est enregistrée');
    await page.waitForFunction((id) => {
      const c = document.querySelector(`#ruleList .repo-row[data-rule="${id}"]`);
      return !!c && /grp\/masse-b/.test(c.textContent);
    }, r.id);
    assert.equal(await page.locator('#ruleForm [name="content"]').inputValue(), '', 'le formulaire se vide');
  });

  /* L'AIDE DIT « VIDE, LA RÈGLE VAUT POUR TOUS LES DÉPÔTS » (settings.rule.tip.repo). Mais le
     combo est rendu avec `defaultFirst` (le défaut de `repoComboHtml`) : il arrive PRÉ-REMPLI
     avec le premier dépôt, et n'offre aucune option « tous les dépôts ». Une règle ajoutée sans
     toucher au champ est donc silencieusement limitée à un dépôt au hasard de l'ordre — et il
     n'existe aucun moyen, à l'écran, d'en ajouter une qui vaille pour tous. */
  test('une règle ajoutée sans choisir de dépôt vaut pour tous les dépôts', async () => {
    await ouvrir('rules');
    await page.waitForSelector('#ruleRepoBox [data-repo-combo]');
    await page.locator('#ruleForm [name="branch_match"]').fill('GLOBAL-');
    await page.locator('#ruleForm [name="label"]').fill('globale');
    await page.locator('#ruleForm [name="content"]').fill('Vaut partout.');
    await page.locator('#ruleForm button[type="submit"]').click();
    await attendreServeur(async () => Boolean(await regle('globale')), 'la règle est créée');
    assert.equal((await regle('globale')).repo_id, null, 'le champ était « vide » à l’écran : la règle doit valoir pour tous');
  });

  test('le filtre des règles masque sans rien retirer, et dit quand rien ne correspond', async () => {
    await ouvrir('rules');
    await page.waitForSelector('#ruleList .repo-row');
    const n = await page.locator('#ruleList .repo-row').count();
    await page.locator('#ruleSearch').fill('migrations');
    await page.waitForFunction(() => [...document.querySelectorAll('#ruleList .repo-row')].filter((c) => !c.hidden).length === 1);
    await page.locator('#ruleSearch').fill('zzz-aucune');
    await page.waitForSelector('#ruleNoMatch:not([hidden])');
    await page.locator('#ruleSearch').fill('');
    await page.waitForFunction((t) => [...document.querySelectorAll('#ruleList .repo-row')].filter((c) => !c.hidden).length === t, n);
    assert.equal((await regles()).length, n, 'filtrer n’a rien supprimé');
  });

  test('une règle se modifie en ligne, se désactive, et se relit ainsi', async () => {
    const r = await regle('paiement');
    await carte(r.id).locator('[data-f="branch_match"]').fill('PAY2-');
    await carte(r.id).locator('[data-f="label"]').fill('paiement v2');
    await carte(r.id).locator('textarea[data-f="content"]').fill('Vérifier aussi les index.');
    await carte(r.id).locator(`[data-rsave="${r.id}"]`).click();
    await attendreServeur(async () => Boolean(await regle('paiement v2')), 'la règle modifiée');
    const m = await regle('paiement v2');
    assert.equal(m.branch_match, 'PAY2-');
    assert.equal(m.content, 'Vérifier aussi les index.');
    assert.equal(m.repo_id, r.repo_id, 'modifier le texte ne retire pas la portée');

    await page.waitForSelector(`#ruleList .repo-row[data-rule="${r.id}"] [data-rtoggle]`);
    await carte(r.id).locator(`[data-rtoggle="${r.id}"]`).click();
    await attendreServeur(async () => !(await regle('paiement v2')).enabled, 'la règle est désactivée');
    await page.reload();
    await ouvrir('rules');
    await page.waitForSelector(`#ruleList .repo-row[data-rule="${r.id}"]`);
    assert.equal(await carte(r.id).locator(`[data-rtoggle="${r.id}"]`).isChecked(), false);
    assert.equal(await carte(r.id).locator('[data-f="label"]').inputValue(), 'paiement v2');
  });

  test('dupliquer crée une copie ; supprimer attend six secondes, et « Annuler » garde la règle', async () => {
    const r = await regle('paiement v2');
    const avant = (await regles()).length;
    await carte(r.id).locator(`[data-rcopy="${r.id}"]`).click();
    await attendreServeur(async () => (await regles()).length === avant + 1, 'la copie est créée');
    const copie = (await regles()).find((x) => x.id !== r.id && x.content === 'Vérifier aussi les index.');
    assert.ok(copie, 'la copie reprend le contenu');
    assert.notEqual(copie.label, r.label, 'la copie se nomme autrement que l’original');
    assert.equal(copie.repo_id, r.repo_id, 'et garde la portée');

    // L'original : supprimé puis rattrapé par « Annuler ».
    await page.waitForSelector(`#ruleList .repo-row[data-rule="${copie.id}"]`);
    await carte(r.id).locator(`[data-rdel="${r.id}"]`).click();
    await confirmer();
    await page.waitForFunction((id) => document.querySelector(`#ruleList .repo-row[data-rule="${id}"]`).hidden, r.id);
    await page.locator('.toast .toast-btn').last().click();
    await page.waitForFunction((id) => !document.querySelector(`#ruleList .repo-row[data-rule="${id}"]`).hidden, r.id);
    // La copie : supprimée pour de bon. Quand elle a disparu du serveur, le délai de l'original
    // (lancé AVANT) est écoulé lui aussi : s'il avait dû partir, il serait parti.
    await carte(copie.id).locator(`[data-rdel="${copie.id}"]`).click();
    await confirmer();
    await attendreServeur(async () => !(await regles()).some((x) => x.id === copie.id), 'la copie est supprimée', 30000);
    assert.ok((await regles()).some((x) => x.id === r.id), '« Annuler » a gardé l’original');
  });

  /* ---------------------------------------------------- Palette git (Git) ---- */

  test('la palette git : ajouter (le « git » de tête est ôté), refuser le vide, modifier, annuler, supprimer', async () => {
    const cmds = async () => (await app.api('GET', '/api/git-commands')).body;
    await ouvrir('gitcfg');
    await page.waitForSelector('#gitCmdList');
    const avant = (await cmds()).length;
    // Vide : refusé, rien ne part.
    await page.locator('#gitCmdForm button[type="submit"]').click();
    await page.waitForSelector('.toast.err');
    assert.equal((await cmds()).length, avant);

    await page.locator('#gitCmdLabel').fill('Tout récupérer');
    await page.locator('#gitCmdCommand').fill('git fetch --all --prune');
    await page.locator('#gitCmdForm button[type="submit"]').click();
    await attendreServeur(async () => (await cmds()).some((c) => c.label === 'Tout récupérer'), 'la commande ajoutée');
    const c = (await cmds()).find((x) => x.label === 'Tout récupérer');
    assert.equal(c.command, 'fetch --all --prune', 'le « git » de tête est ôté');
    await page.waitForSelector(`#gitCmdList [data-gcedit="${c.id}"]`);

    // Modifier, puis annuler : le formulaire revient à l'ajout sans rien envoyer.
    await page.locator(`#gitCmdList [data-gcedit="${c.id}"]`).click();
    assert.equal(await page.locator('#gitCmdLabel').inputValue(), 'Tout récupérer');
    await page.waitForSelector('#gitCmdCancel:not([hidden])');
    await page.locator('#gitCmdCancel').click();
    assert.equal(await page.locator('#gitCmdLabel').inputValue(), '');
    assert.equal(await page.locator('#gitCmdCancel').isHidden(), true);

    await page.locator(`#gitCmdList [data-gcedit="${c.id}"]`).click();
    await page.locator('#gitCmdCommand').fill('fetch --tags');
    await page.locator('#gitCmdForm button[type="submit"]').click();
    await attendreServeur(async () => (await cmds()).find((x) => x.id === c.id).command === 'fetch --tags', 'la commande modifiée');
    assert.equal((await cmds()).length, avant + 1, 'modifier n’a pas créé de doublon');

    await page.waitForFunction(() => /fetch --tags/.test(document.querySelector('#gitCmdList').textContent));
    await page.locator(`#gitCmdList [data-gcdel="${c.id}"]`).click();
    await confirmer();
    await attendreServeur(async () => !(await cmds()).some((x) => x.id === c.id), 'la commande supprimée');
  });

  /* ------------------------------------------------- Jobs liés (Jenkins) ---- */

  test('un job Jenkins se lie à un dépôt en le CHOISISSANT, avec son paramètre, et se délie', async () => {
    const liens = async () => (await app.api('GET', '/api/jenkins/links')).body.links || [];
    const cible = await depot('grp/reel');
    await ouvrir('jenkinscfg');
    await page.waitForSelector('#jenkinsLinkRepo [data-repo-combo]');
    await page.locator('#jenkinsLinkRepo [data-repo-combo]').click();
    await page.locator('#jenkinsLinkRepo [data-repo-combo]').fill('grp/reel');
    await page.locator('#jenkinsLinkRepo .combo-opt[data-r]').first().waitFor();
    await page.locator('#jenkinsLinkRepo .combo-opt[data-r]').first().dispatchEvent('mousedown');
    await page.waitForFunction((id) => document.querySelector('#jenkinsLinkRepo .jl-repo').value === String(id), cible.id);

    // Le job est PROPOSÉ par Jenkins, pas retapé.
    await page.locator('#jenkinsLinkJobBox [data-combo]').click();
    await page.locator('#jenkinsLinkJobBox .combo-opt[data-v]').first().waitFor();
    const job = await page.locator('#jenkinsLinkJobBox .combo-opt[data-v]').first().getAttribute('data-v');
    assert.match(job, /api-build/);
    await page.locator('#jenkinsLinkJobBox .combo-opt[data-v]').first().dispatchEvent('mousedown');
    // …et le paramètre, parmi ceux de son dernier lancement.
    await page.locator('#jenkinsLinkParamBox [data-combo]').click();
    await page.locator('#jenkinsLinkParamBox .combo-opt[data-v="BRANCHE"]').waitFor();
    await page.locator('#jenkinsLinkParamBox .combo-opt[data-v="BRANCHE"]').dispatchEvent('mousedown');
    await page.locator('#jenkinsLinkForm button[type="submit"]').click();

    await attendreServeur(async () => (await liens()).some((l) => l.job_path === job), 'le lien est enregistré');
    const l = (await liens()).find((x) => x.job_path === job);
    assert.equal(l.repo_id, cible.id);
    assert.equal(l.param, 'BRANCHE');
    await page.waitForSelector(`#jenkinsLinkList [data-jl-del="${l.id}"]`);
    await page.locator(`#jenkinsLinkList [data-jl-del="${l.id}"]`).click();
    await attendreServeur(async () => !(await liens()).some((x) => x.id === l.id), 'le lien est retiré');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
