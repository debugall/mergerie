'use strict';
/* MENU GIT — « MERGE » DE BOUT EN BOUT DEPUIS L'ÉCRAN, ET CE QUE « COMPARER » RETIENT.
 *
 * e2e-git-merge reprend un merge démarré par l'API et le mène jusqu'au push. Ici, tout part de
 * l'écran, et chaque geste se vérifie côté serveur (état du merge, commit, dépôt distant) :
 *   - préparer un merge en choisissant dépôt, source et cible dans les combos à recherche ;
 *   - plusieurs fichiers en conflit : passer de l'un à l'autre, résoudre l'un en écrivant
 *     soi-même, l'autre en gardant les deux versions ;
 *   - commiter avec son propre message, puis relire le diff du commit ;
 *   - abandonner depuis la liste des merges en cours, et depuis l'écran de travail ;
 *   - deux histoires sans ancêtre commun : l'explication, puis l'option explicite ;
 *   - le rappel de la merge request qu'un merge rattrape ;
 *   - la mémoire du formulaire, et le changement de dépôt qui vide les branches ;
 *   - Comparer : même ref des deux côtés refusée, et les deux côtés retenus au rechargement.
 *
 * Un seul `startApp()`, un seul navigateur ; les tests s'enchaînent dans l'ordre. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, git, poserIdentiteGit, attendreServeur, navigateurDispo, lancerNavigateur,
  MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Git : Merge depuis l’écran, et la mémoire de Comparer', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  let bare; let work; let idApp; let idAutre;
  const erreurs = [];

  /** Déclare à la forge simulée les branches du dépôt nu : les combos les lisent là. */
  function publierBranches() {
    const noms = git(bare, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']).trim().split('\n');
    app.state.branches['grp/app'] = noms.map((l) => {
      const [name, sha] = l.split(' ');
      return { name, default: name === 'main', protected: false, merged: false, commit: { id: sha, committed_date: '2026-08-01T10:00:00Z' } };
    });
  }

  /** Une branche qui modifie `fichiers` pendant que main les modifie aussi : un conflit par fichier. */
  function scenarioConflit(src, fichiers) {
    git(work, ['checkout', '-q', 'main']);
    git(work, ['fetch', '-q', 'origin']);
    git(work, ['reset', '-q', '--hard', 'origin/main']);
    git(work, ['checkout', '-q', '-b', src]);
    for (const f of fichiers) fs.writeFileSync(path.join(work, f), `début\nvenue de ${src}\nfin\n`);
    git(work, ['add', '-A']); git(work, ['commit', '-qm', `travail ${src}`]);
    git(work, ['push', '-q', '-u', 'origin', src]);
    git(work, ['checkout', '-q', 'main']);
    for (const f of fichiers) fs.writeFileSync(path.join(work, f), `début\nvenue de main pour ${src}\nfin\n`);
    git(work, ['add', '-A']); git(work, ['commit', '-qm', `main avance (${src})`]);
    git(work, ['push', '-q', 'origin', 'main']);
    publierBranches();
  }

  const merges = async () => (await app.api('GET', '/api/git/merges')).body;

  before(async () => {
    app = await startApp();
    await app.configure();
    const base = fs.mkdtempSync(path.join(app.dataDir, 'merge-'));
    bare = path.join(base, 'origin.git'); work = path.join(base, 'work');
    fs.mkdirSync(bare); fs.mkdirSync(work);
    git(bare, ['init', '-q', '--bare', '--initial-branch=main', '.']);
    git(work, ['init', '-q', '--initial-branch=main', '.']);
    poserIdentiteGit(work);
    git(work, ['remote', 'add', 'origin', bare]);
    for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(work, f), 'début\ncommune\nfin\n');
    git(work, ['add', '-A']); git(work, ['commit', '-qm', 'base']); git(work, ['push', '-q', '-u', 'origin', 'main']);
    scenarioConflit('feature/double', ['a.txt', 'b.txt']);
    app.state.tags['grp/app'] = [];
    idApp = (await app.api('POST', '/api/repos', { project: 'grp/app', url: bare })).body.id;

    const autre = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'autre-')), { branch: 'feature/ailleurs' });
    app.state.branches['grp/autre'] = [
      { name: 'main', default: true, protected: false, merged: false, commit: { id: autre.mainSha } },
      { name: 'feature/ailleurs', default: false, protected: false, merged: false, commit: { id: autre.branchSha } },
    ];
    app.state.tags['grp/autre'] = [];
    idAutre = (await app.api('POST', '/api/repos', { project: 'grp/autre', url: autre.bare })).body.id;
    assert.ok(idApp && idAutre);

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
    await page.evaluate(() => { const e = document.querySelector('#gitExploreRepoBox'); if (e) e.innerHTML = ''; });
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForFunction(() => document.querySelector('#gitExploreRepoBox .git-multi-pick'));
    await page.locator(`#tab-git .subnav [data-gsub="${sub}"]`).click();
    await page.waitForSelector(`#gsub-${sub}.active`);
  }
  async function fermerMenus() {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForFunction(() => [...document.querySelectorAll('.combo-options')].every((b) => b.hidden));
  }
  async function choisir(champ, texte) {
    await fermerMenus();
    await champ.click();
    const opt = page.locator('.combo-options:not([hidden]) .combo-opt[data-v], .combo-options:not([hidden]) .combo-opt[data-r]', { hasText: texte }).first();
    await opt.waitFor();
    await opt.click();
  }
  const m = (sel) => page.locator(`#gsub-merge ${sel}`);
  async function formulaire(depot, source, cible) {
    await choisir(m('#mergeRepoBox [data-repo-combo]'), depot);
    await choisir(m('[data-combo="merge-source"]'), source);
    await choisir(m('[data-combo="merge-target"]'), cible);
    await page.waitForFunction(([s, c]) => document.querySelector('#gsub-merge .merge-source').value === s
      && document.querySelector('#gsub-merge .merge-target').value === c, [source, cible]);
  }
  async function toast(motif) {
    await page.waitForFunction((src) => [...document.querySelectorAll('#toasts .toast')]
      .some((t) => new RegExp(src).test(t.textContent)), motif.source);
  }
  async function confirmer(ok = true) {
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator(ok ? '#confirmOk' : '#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
  }

  /* ----------------------------------------------------------------- Merge ---- */

  let mergeId;

  test('préparer un merge depuis l’écran : les conflits de chaque fichier apparaissent', async () => {
    await allerGit('merge');
    await formulaire('grp/app', 'feature/double', 'main');
    await m('#mergeStart').click();
    await page.waitForSelector('#mergeWork:not([hidden]) .cf-hunk', { timeout: 60000 });
    const liste = await merges();
    assert.equal(liste.length, 1);
    mergeId = liste[0].id;
    assert.equal(liste[0].status, 'conflict');
    assert.equal(liste[0].source_branch, 'feature/double');
    const tete = await page.locator('#mergeWork .merge-head').innerText();
    assert.match(tete, /grp\/app — feature\/double → main/);
    assert.match(tete, /2 fichiers en conflit/);
    assert.deepEqual((await page.locator('#mergeWork [data-mfile]').evaluateAll((els) => els.map((e) => e.dataset.mfile))).sort(), ['a.txt', 'b.txt']);
    // Le merge en cours est aussi listé, pour le reprendre plus tard.
    assert.match(await page.locator('#mergeRunning').innerText(), /feature\/double[\s\S]*conflits à résoudre/);
  });

  test('passer d’un fichier à l’autre, et en résoudre un en écrivant soi-même', async () => {
    await page.locator('#mergeWork [data-mfile="b.txt"]').click();
    await page.waitForFunction(() => document.querySelector('#mergePane .mp-head code').textContent === 'b.txt');
    assert.equal(await page.locator('#mergeWork .mf-item.active').getAttribute('data-mfile'), 'b.txt');
    await page.locator('#mergePane [data-medit="1"]').click();
    await page.locator('#mergeEditor').fill('début\nécrit à la main\nfin\n');
    await page.locator('#mergeResolveText').click();
    // Le fichier suivant s'ouvre de lui-même ; le serveur n'a plus que a.txt en conflit.
    await page.waitForFunction(() => document.querySelector('#mergePane .mp-head code')?.textContent === 'a.txt');
    const etat = (await app.api('GET', `/api/git/merges/${mergeId}`)).body;
    assert.deepEqual(etat.conflits, ['a.txt']);
    assert.match(await page.locator('#mergeWork .merge-head').innerText(), /1 fichier en conflit/);
  });

  test('« Garder les deux » puis marquer résolu : le merge est prêt à commiter', async () => {
    await page.locator('#mergePane [data-keep="deux"]').click();
    await page.waitForSelector('#mergePane .cf-both .btn-primary');
    assert.equal(await page.locator('#mergePane .cf-side.cf-keep').count(), 2, 'les deux côtés sont gardés');
    await page.locator('#mergeResolveChoices').click();
    await toast(/Tous les conflits sont résolus/);
    await page.waitForSelector('#mergeCommit');
    const etat = (await app.api('GET', `/api/git/merges/${mergeId}`)).body;
    assert.equal(etat.status, 'ready');
    assert.deepEqual(etat.conflits, []);
  });

  test('commiter avec son propre message, puis relire le diff du commit', async () => {
    await page.locator('#mergeCommit').click();
    await page.waitForSelector('#mergeCommitModal:not([hidden])');
    assert.match(await page.locator('#mergeCommitIntro').innerText(), /feature\/double[\s\S]*main/);
    await page.locator('#mergeCommitMsg').fill('Merge manuel de feature/double');
    await page.locator('#mergeCommitGo').click();
    await page.waitForSelector('#mergeCommitModal', { state: 'hidden' });
    await page.waitForSelector('#mergePush');
    const etat = (await app.api('GET', `/api/git/merges/${mergeId}`)).body;
    assert.equal(etat.status, 'committed');
    assert.ok(etat.commit_sha);
    const diff = (await app.api('GET', `/api/git/merges/${mergeId}/diff`)).body;
    assert.equal(diff.sujet, 'Merge manuel de feature/double', 'c’est le message saisi qui est commité');
    assert.match(diff.diff, /écrit à la main/);
    // Le SHA du commit est à l'écran, copiable.
    assert.equal(await page.locator('#mergeWork .merge-head .git-sha-copy').getAttribute('data-copy-txt'), etat.commit_sha);
    // Rien n'est parti tant qu'on n'a pas poussé : pas de bouton « abandonner » sur un commit, mais pas de push non plus.
    assert.equal(await page.locator('#mergeAbandon').count(), 0);

    await page.locator(`#mergeRunning [data-merge-diff="${mergeId}"]`).click();
    await page.waitForSelector('#compareFileModal:not([hidden])');
    assert.match(await page.locator('#compareFilePath').innerText(), new RegExp(`${etat.commit_sha.slice(0, 8)}[\\s\\S]*Merge manuel`));
    assert.match(await page.locator('#compareFileBody').innerText(), /écrit à la main/);
    await page.locator('#compareFileClose').click();
    await page.waitForSelector('#compareFileModal', { state: 'hidden' });
  });

  test('abandonner depuis la liste : refuser ne change rien, accepter ne laisse rien et ne pousse rien', async () => {
    const avant = git(bare, ['rev-parse', 'main']).trim();
    await page.locator(`#mergeRunning [data-mdrop="${mergeId}"]`).click();
    await confirmer(false);
    assert.equal((await merges()).length, 1, 'refusé : le merge est toujours là');
    await page.locator(`#mergeRunning [data-mdrop="${mergeId}"]`).click();
    await confirmer(true);
    await attendreServeur(async () => (await merges()).length === 0, 'le merge est abandonné');
    await page.waitForSelector('#mergeWork', { state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('#mergeRunning .merge-run-row'));
    assert.equal(git(bare, ['rev-parse', 'main']).trim(), avant, 'la destination n’a pas bougé');
  });

  test('abandonner depuis l’écran de travail', async () => {
    scenarioConflit('feature/abandon', ['a.txt']);
    // Les branches d'un dépôt sont gardées en cache par l'écran : une branche poussée d'ailleurs
    // n'apparaît qu'au rechargement, comme pour l'utilisateur.
    await page.reload();
    await allerGit('merge');
    await formulaire('grp/app', 'feature/abandon', 'main');
    await m('#mergeStart').click();
    await page.waitForSelector('#mergeWork:not([hidden]) #mergeAbandon', { timeout: 60000 });
    assert.equal((await merges()).length, 1);
    await page.locator('#mergeAbandon').click();
    await confirmer(true);
    await attendreServeur(async () => (await merges()).length === 0, 'le merge est abandonné');
    await page.waitForSelector('#mergeWork', { state: 'hidden' });
  });

  test('deux histoires sans ancêtre commun : l’écran explique, puis fusionne sur demande explicite', async () => {
    git(work, ['checkout', '-q', '--orphan', 'venue-dailleurs']);
    git(work, ['rm', '-rq', '--cached', '.']);
    for (const f of ['a.txt', 'b.txt']) fs.rmSync(path.join(work, f), { force: true });
    fs.writeFileSync(path.join(work, 'autre.txt'), 'un projet sans rapport\n');
    git(work, ['add', '-A']); git(work, ['commit', '-qm', 'racine indépendante']);
    git(work, ['push', '-q', '-u', 'origin', 'venue-dailleurs']);
    git(work, ['checkout', '-q', '-f', 'main']);
    publierBranches();
    await page.reload();
    await allerGit('merge');

    await formulaire('grp/app', 'venue-dailleurs', 'main');
    await m('#mergeStart').click();
    await page.waitForSelector('#mergeUnrelated:not([hidden])', { timeout: 60000 });
    const texte = await page.locator('#mergeUnrelated .mu-text').innerText();
    assert.match(texte, /ancêtre commun/);
    assert.doesNotMatch(texte, /fatal:/, 'pas la sortie brute de git');
    assert.equal((await merges()).length, 0, 'rien n’a été préparé');

    await page.locator('#mergeUnrelatedGo').click();
    await page.waitForSelector('#mergeUnrelated', { state: 'hidden', timeout: 60000 });
    await attendreServeur(async () => (await merges()).some((x) => x.source_branch === 'venue-dailleurs'), 'le merge est préparé');
    for (const x of await merges()) await app.api('DELETE', `/api/git/merges/${x.id}`);
  });

  /* A31 — rattraper `main` DANS la branche d'une MR ouverte : la CIBLE du merge est la SOURCE
     de la MR. La liste des merges en cours fait cette jointure (`gitmerge.enCours`). */
  let rattrapage; let mrId;
  test('un merge qui rattrape une merge request la rappelle dans la liste, et y mène', async () => {
    scenarioConflit('feature/rattrapage', ['b.txt']);
    mrId = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, web_url)
      VALUES (?, 77, 'Rattraper main', 'feature/rattrapage', 'main', 'to_review', 'https://gitlab.test/grp/app/-/merge_requests/77')`).run(idApp).lastInsertRowid;
    const r = await app.api('POST', '/api/git/merges', { repo_id: idApp, source: 'main', target: 'feature/rattrapage' });
    assert.equal(r.status, 200, r.text);
    rattrapage = r.body.id;
    // L'écran relit la liste en rouvrant le sous-onglet.
    await page.locator('#tab-git .subnav [data-gsub="actions"]').click();
    await page.locator('#tab-git .subnav [data-gsub="merge"]').click();
    const puce = page.locator(`#mergeRunning [data-merge-mr="${mrId}"]`);
    await puce.waitFor();
    assert.equal(await puce.innerText(), '!77');
    assert.equal(await puce.getAttribute('title'), 'Rattraper main');
    await puce.click();
    await page.waitForSelector('#tab-review.active');
  });

  test('…et l’écran de travail du même merge la rappelle aussi', async () => {
    try {
      await allerGit('merge');
      await page.locator(`#mergeRunning [data-mopen="${rattrapage}"]`).click();
      await page.waitForFunction(() => /main[\s\S]*→[\s\S]*feature\/rattrapage/.test(document.querySelector('#mergeWork .merge-head')?.textContent || ''));
      const etat = (await app.api('GET', `/api/git/merges/${rattrapage}`)).body;
      assert.equal(etat.mr && etat.mr.iid, 77, 'l’état du merge porte la MR qu’il rattrape');
      assert.match(await page.locator('#mergeWork .merge-head').innerText(), /!77[\s\S]*Rattraper main/);
    } finally {
      await app.api('DELETE', `/api/git/merges/${rattrapage}`);
    }
  });

  test('le formulaire retient le dernier merge lancé ; changer de dépôt vide les deux branches', async () => {
    await page.reload();
    await allerGit('merge');
    await page.waitForFunction(() => document.querySelector('#gsub-merge .merge-source').value === 'venue-dailleurs');
    assert.equal(await m('#mergeRepoBox .rc-search').inputValue(), 'grp/app');
    assert.equal(await m('[data-combo="merge-source"]').inputValue(), 'venue-dailleurs');
    assert.equal(await m('[data-combo="merge-target"]').inputValue(), 'main');

    await choisir(m('#mergeRepoBox [data-repo-combo]'), 'grp/autre');
    await page.waitForFunction(() => document.querySelector('#gsub-merge .merge-source').value === ''
      && document.querySelector('#gsub-merge .merge-target').value === '');
    // Les listes proposent désormais les branches de CE dépôt.
    await fermerMenus();
    await m('[data-combo="merge-source"]').click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
    const opts = await page.locator('.combo-options:not([hidden]) .combo-opt[data-v]').evaluateAll((els) => els.map((e) => e.dataset.v));
    assert.deepEqual(opts.sort(), ['feature/ailleurs', 'main']);
    await fermerMenus();
  });

  /* --------------------------------------------------------------- Comparer ---- */

  describe('Comparer', () => {
    const cote = (c) => page.locator(`.compare-cote[data-cote="${c}"]`);
    const choisirCote = async (c, depot, ref) => {
      await choisir(cote(c).locator('[data-repo-combo]'), depot);
      await choisir(cote(c).locator('.cb-search'), ref);
    };

    test('la même ref des deux côtés est refusée sans appeler le serveur', async () => {
      await page.locator('#tab-git .subnav [data-gsub="compare"]').click();
      await page.waitForSelector('#compareCotes .compare-cote[data-cote="b"]');
      const appels = [];
      const suivre = (req) => { if (req.url().includes('/api/git/compare')) appels.push(req.url()); };
      page.on('request', suivre);
      try {
        await choisirCote('a', 'grp/app', 'main');
        await choisirCote('b', 'grp/app', 'main');
        await page.locator('#btnCompare').click();
        await toast(/Les deux côtés désignent la même ref/);
      } finally { page.off('request', suivre); }
      assert.deepEqual(appels, []);
    });

    test('les deux côtés comparés sont retenus au rechargement', async () => {
      await choisirCote('b', 'grp/app', 'feature/double');
      await page.locator('#btnCompare').click();
      await page.waitForSelector('#compareResult .compare-grid', { timeout: 60000 });
      assert.match(await page.locator('#compareResult').innerText(), /grp\/app · main[\s\S]*grp\/app · feature\/double/);

      await page.reload();
      await allerGit('compare');
      await page.waitForSelector('#compareCotes .compare-cote[data-cote="b"]');
      assert.equal(await cote('a').locator('.rc-search').inputValue(), 'grp/app');
      assert.equal(await cote('a').locator('.cmp-branch-a').inputValue(), 'branch:main');
      assert.equal(await cote('b').locator('.cmp-branch-b').inputValue(), 'branch:feature/double');
      assert.equal(await cote('b').locator('.cb-search').inputValue(), 'feature/double', 'le libellé revient avec la valeur');
    });
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
