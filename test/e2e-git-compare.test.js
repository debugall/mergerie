'use strict';
/* COMPARER DEUX DÉPÔTS, BRANCHE PAR BRANCHE.
 *
 * La question posée n'est pas celle d'un `git diff` : les deux dépôts n'ont AUCUNE histoire
 * commune — c'est même le cas d'usage, un service extrait dans son propre dépôt, un fork
 * parti vivre sa vie. `git diff a..b` exige un ancêtre ; ici on lit les deux ARBRES et on
 * compare des chemins et des hachages de contenu.
 *
 * Ce que ce fichier surveille, dans l'ordre où ça casse :
 *
 *   1. les trois seaux (à gauche seulement / différents / à droite seulement) et le compte des
 *      identiques — un fichier présent des deux côtés avec le même contenu ne doit apparaître
 *      dans AUCUNE liste, sinon l'écran noie le signal sous le bruit ;
 *   2. la récursion : `ls-tree` sans `-r` rendrait « src » au lieu de « src/deep/nested/x.js »,
 *      et deux dépôts distincts se ressembleraient soudain beaucoup ;
 *   3. la troncature ANNONCÉE — une liste coupée en silence se lit comme une liste complète ;
 *   4. l'écran lui-même : trois colonnes, un filtre qui porte sur les trois à la fois, et un
 *      changement de dépôt qui vide la branche (garder « develop » sur un dépôt qui ne l'a pas
 *      donne une erreur plusieurs secondes plus tard, au lancement).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, poserIdentiteGit, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo: navDispo } = navigateurDispo();

describe('Git · Comparer deux dépôts', () => {
  let app; let idA; let idB; let idGros;

  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

  /* Un dépôt nu poussé depuis un clone de travail : l'application lit `origin/<branche>`,
     pas le répertoire de travail. */
  function depot(nom, contenu, branches = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `cmp-${nom}-`));
    const nu = path.join(base, 'origin.git');
    const work = path.join(base, 'work');
    fs.mkdirSync(nu); fs.mkdirSync(work);
    git(base, 'init', '--bare', '-q', '--initial-branch=main', nu);
    git(work, 'init', '-q', '--initial-branch=main', '.');
    poserIdentiteGit(work);
    git(work, 'remote', 'add', 'origin', nu);
    const poser = (fichiers) => {
      for (const [f, texte] of Object.entries(fichiers)) {
        fs.mkdirSync(path.join(work, path.dirname(f)), { recursive: true });
        fs.writeFileSync(path.join(work, f), texte);
      }
    };
    poser(contenu);
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'init');
    git(work, 'push', '-q', '-u', 'origin', 'main');
    for (const [branche, changement] of Object.entries(branches)) {
      git(work, 'checkout', '-q', '-b', branche);
      for (const f of changement.supprime || []) git(work, 'rm', '-q', f);
      poser(changement.ajoute || {});
      git(work, 'add', '-A'); git(work, 'commit', '-qm', branche);
      git(work, 'push', '-q', '-u', 'origin', branche);
      git(work, 'checkout', '-q', 'main');
    }
    return nu;
  }

  before(async () => {
    app = await startApp();
    await app.configure();

    /* README.md est identique des deux côtés (même contenu → même hachage), package.json porte
       le même chemin et un contenu différent : les deux cas que l'écran doit distinguer. */
    const a = depot('a', {
      'README.md': 'commun\n',
      'package.json': '{ "name": "api" }\n',
      'src/index.js': 'module.exports = {};\n',
      'src/deep/nested/util.js': 'exports.u = 1;\n',
    }, { legacy: { supprime: ['src/deep/nested/util.js'], ajoute: { 'src/old.js': 'var x;\n' } } });
    const b = depot('b', {
      'README.md': 'commun\n',
      'package.json': '{ "name": "front" }\n',
      'src/main.js': 'window.x = 1;\n',
    });
    const gros = {};
    for (let i = 0; i < 2100; i += 1) gros[`f/${String(i).padStart(4, '0')}.txt`] = `${i}\n`;

    /* La liste des branches de l'écran vient de la FORGE, pas du clone : le combo interroge
       `/api/git/refs`, qui appelle GitLab. Le dépôt sur disque, lui, sert au calcul. */
    const branche = (nom, defaut = false) => ({ name: nom, default: defaut, protected: false, merged: false, commit: { id: '0'.repeat(40) } });
    app.state.branches['grp/api'] = [branche('main', true), branche('legacy')];
    app.state.branches['grp/front'] = [branche('main', true)];

    idA = (await app.api('POST', '/api/repos', { project: 'grp/api', url: a })).body.id;
    idB = (await app.api('POST', '/api/repos', { project: 'grp/front', url: b })).body.id;
    idGros = (await app.api('POST', '/api/repos', { project: 'grp/gros', url: depot('gros', gros) })).body.id;
  });
  after(async () => { await app.stop(); });

  const comparer = (qs) => app.api('GET', `/api/git/compare?${qs}`);
  const paire = (ra, ba, rb, bb) => `repo_a=${ra}&branch_a=${ba}&repo_b=${rb}&branch_b=${bb}`;

  test('deux dépôts sans histoire commune : chaque fichier tombe dans un seul seau', async () => {
    const { status, body } = await comparer(paire(idA, 'main', idB, 'main'));
    assert.equal(status, 200, JSON.stringify(body));

    assert.deepEqual(body.only_a, ['src/deep/nested/util.js', 'src/index.js']);
    assert.deepEqual(body.only_b, ['src/main.js']);
    assert.deepEqual(body.differ, ['package.json']);
    // README.md est identique : compté, jamais listé — c'est ce qui rend l'écran lisible.
    assert.equal(body.same, 1);
    for (const liste of [body.only_a, body.only_b, body.differ]) {
      assert.ok(!liste.includes('README.md'), 'un fichier identique ne doit apparaître nulle part');
    }
    assert.deepEqual(body.a, { project: 'grp/api', branch: 'main', files: 4 });
    assert.deepEqual(body.b, { project: 'grp/front', branch: 'main', files: 3 });
    assert.equal(body.tronque, false);
  });

  /* Sans `-r`, `ls-tree` rendrait l'entrée « src » et rien de ce qu'elle contient : les deux
     dépôts paraîtraient partager un « src » identique alors qu'ils n'ont pas un fichier commun. */
  test('les fichiers profonds sont listés par leur chemin complet', async () => {
    const { body } = await comparer(paire(idA, 'main', idB, 'main'));
    assert.ok(body.only_a.includes('src/deep/nested/util.js'));
    assert.ok(!body.only_a.includes('src'), 'aucun répertoire ne doit être rendu comme un fichier');
  });

  test('échanger les deux côtés miroite le résultat', async () => {
    const { body: d } = await comparer(paire(idA, 'main', idB, 'main'));
    const { body: i } = await comparer(paire(idB, 'main', idA, 'main'));
    assert.deepEqual(i.only_a, d.only_b);
    assert.deepEqual(i.only_b, d.only_a);
    assert.deepEqual(i.differ, d.differ);
    assert.equal(i.same, d.same);
  });

  test('le même dépôt sur deux branches est une comparaison valable', async () => {
    const { body } = await comparer(paire(idA, 'main', idA, 'legacy'));
    assert.deepEqual(body.only_a, ['src/deep/nested/util.js']);
    assert.deepEqual(body.only_b, ['src/old.js']);
    assert.deepEqual(body.differ, []);
    assert.equal(body.same, 3);
  });

  /* Deux dépôts étrangers rendent des dizaines de milliers de lignes que personne ne lit. On
     borne — et on le DIT, sinon la liste coupée passe pour la liste entière. */
  test('au-delà du plafond, les listes sont coupées et la troncature est annoncée', async () => {
    const { body } = await comparer(paire(idGros, 'main', idB, 'main'));
    assert.equal(body.tronque, true);
    assert.equal(body.only_a.length, 2000);
    assert.equal(body.a.files, 2100);
    assert.deepEqual(body.only_b, ['README.md', 'package.json', 'src/main.js']);
  });

  test('une branche inconnue est refusée en la nommant', async () => {
    const { status, body } = await comparer(paire(idA, 'main', idB, 'nexiste-pas'));
    assert.equal(status, 400);
    assert.match(body.error, /nexiste-pas/);
    assert.match(body.error, /grp\/front/);
  });

  test('un dépôt inconnu et une branche vide sont refusés', async () => {
    const inconnu = await comparer(paire(idA, 'main', 999999, 'main'));
    assert.equal(inconnu.status, 400);
    const vide = await comparer(`repo_a=${idA}&branch_a=&repo_b=${idB}&branch_b=main`);
    assert.equal(vide.status, 400);
    assert.match(vide.body.error, /grp\/api/);
  });

  /* L'ÉCRAN. Le reste prouve le calcul ; ici on prouve qu'on voit ce qui manque de chaque côté,
     et que le filtre cherche un FICHIER — donc dans les trois colonnes à la fois. */
  describe('l’écran', { skip: navDispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; const erreurs = [];

    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="git"]').click();
      await page.locator('#tab-git .subnav [data-gsub="compare"]').click();
      await page.waitForSelector('#compareCotes .compare-cote[data-cote="b"]');
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    const cote = (c) => page.locator(`.compare-cote[data-cote="${c}"]`);

    /* Un combo se ferme 150 ms APRÈS la perte du focus. En rafale, le menu encore ouvert du
       champ précédent répond à la place du bon, puis disparaît sous le clic. On repart donc
       toujours d'un écran où tous les menus sont fermés. */
    async function ouvrir(champ, texte) {
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForFunction(() => [...document.querySelectorAll('.combo-options')].every((b) => b.hidden));
      await champ.click();
      await page.waitForSelector('.combo-options:not([hidden]) .combo-opt');
      await page.locator('.combo-options:not([hidden]) .combo-opt', { hasText: texte }).first().click();
    }

    async function choisir(c, depotLibelle, branche) {
      await ouvrir(cote(c).locator('[data-repo-combo]'), depotLibelle);
      await ouvrir(cote(c).locator('.cb-search'), branche);
    }

    test('les quatre listes ont une recherche', async () => {
      // Un dépôt actif aligne des centaines de branches : sans champ de recherche, l'écran ment.
      assert.equal(await page.locator('#compareCotes .rc-search').count(), 2, 'dépôts');
      assert.equal(await page.locator('#compareCotes .cb-search').count(), 2, 'branches');
    });

    test('changer de dépôt vide la branche déjà choisie', async () => {
      await choisir('a', 'grp/api', 'legacy');
      assert.equal(await cote('a').locator('.cmp-branch-a').inputValue(), 'legacy');
      await ouvrir(cote('a').locator('[data-repo-combo]'), 'grp/front');
      assert.equal(await cote('a').locator('.cmp-branch-a').inputValue(), '',
        'une branche d’un autre dépôt ne doit pas survivre au changement');
    });

    test('trois colonnes montrent ce qui manque de chaque côté', async () => {
      await choisir('a', 'grp/api', 'main');
      await choisir('b', 'grp/front', 'main');
      await page.locator('#btnCompare').click();
      await page.waitForSelector('#compareResult .compare-grid');

      const compte = async (col) => (await page.locator(`.compare-col[data-col="${col}"] .compare-list li`).allTextContents());
      assert.deepEqual(await compte('a'), ['src/deep/nested/util.js', 'src/index.js']);
      assert.deepEqual(await compte('diff'), ['package.json']);
      assert.deepEqual(await compte('b'), ['src/main.js']);
      // Chaque colonne nomme le côté qu'elle décrit : sans cela, « à gauche » ne veut rien dire.
      const entete = await page.locator('#compareResult').innerText();
      assert.match(entete, /grp\/api · main/);
      assert.match(entete, /grp\/front · main/);
    });

    test('le filtre porte sur les trois colonnes et ne supprime aucune ligne', async () => {
      await page.locator('#compareFilter').fill('src/');
      await page.waitForFunction(() => !!document.querySelector('#compareResult .compare-list li[hidden]'));
      const visible = await page.locator('#compareResult .compare-list li:visible').allTextContents();
      assert.deepEqual(visible.sort(), ['src/deep/nested/util.js', 'src/index.js', 'src/main.js']);
      // La ligne écartée est masquée, pas retirée : vider le filtre la ramène.
      assert.equal(await page.locator('#compareResult .compare-list li').count(), 4);
      await page.locator('#compareFilter').fill('');
      await page.waitForFunction(() => !document.querySelector('#compareResult .compare-list li[hidden]'));
    });

    /* Changer de dépôt vide la branche (test précédent) : il reste alors un côté incomplet.
       L'écran doit le DIRE tout de suite, pas laisser partir une requête qui échouera. */
    test('l’écran refuse un côté incomplet sans appeler le serveur', async () => {
      const appels = [];
      page.on('request', (r) => { if (r.url().includes('/api/git/compare')) appels.push(r.url()); });
      await ouvrir(cote('b').locator('[data-repo-combo]'), 'grp/api');
      assert.equal(await cote('b').locator('.cmp-branch-b').inputValue(), '');

      await page.locator('#btnCompare').click();
      await page.locator('#toasts .toast').first().waitFor({ state: 'visible' });
      assert.equal(appels.length, 0, 'aucune comparaison ne doit partir avec un seul côté');
      assert.deepEqual(erreurs, []);
    });
  });
});
