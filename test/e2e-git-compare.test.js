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
  function depot(nom, contenu, branches = {}, tags = {}) {
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
    for (const [tag, cible] of Object.entries(tags)) git(work, 'tag', tag, cible);
    if (Object.keys(tags).length) git(work, 'push', '-q', 'origin', '--tags');
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
      // Un vrai binaire : il ne se lit pas, il s'annonce.
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
    }, {
      legacy: {
        supprime: ['src/deep/nested/util.js'],
        // Plus gros que le plafond d'affichage (1 Mo) : la vue doit le dire, pas le charger.
        ajoute: { 'src/old.js': 'var x;\n', 'gros.bin': 'x'.repeat(1024 * 1024 + 10) },
      },
      /* Une BRANCHE nommée « v1 », pendant qu'un TAG du même nom pointe `main` : c'est le
         cas qui rend le genre indispensable — `origin/v1` ne dit pas lequel des deux. */
      v1: { ajoute: { 'sur-la-branche-v1.txt': 'branche\n' } },
    }, { 'v1.0': 'main', v1: 'main' });
    const b = depot('b', {
      'README.md': 'commun\n',
      'package.json': '{ "name": "front" }\n',
      'src/main.js': 'window.x = 1;\n',
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x09, 0x00]),
    });
    const gros = {};
    for (let i = 0; i < 2100; i += 1) gros[`f/${String(i).padStart(4, '0')}.txt`] = `${i}\n`;

    /* La liste des branches de l'écran vient de la FORGE, pas du clone : le combo interroge
       `/api/git/refs`, qui appelle GitLab. Le dépôt sur disque, lui, sert au calcul. */
    const branche = (nom, defaut = false) => ({ name: nom, default: defaut, protected: false, merged: false, commit: { id: '0'.repeat(40) } });
    app.state.branches['grp/api'] = [branche('main', true), branche('legacy'), branche('v1')];
    app.state.branches['grp/front'] = [branche('main', true)];
    // Les TAGS viennent de la même forge, par un autre appel : l'écran met les deux dans la même liste.
    app.state.tags['grp/api'] = [{ name: 'v1.0', commit: { id: '0'.repeat(40) } }];
    app.state.tags['grp/front'] = [];

    idA = (await app.api('POST', '/api/repos', { project: 'grp/api', url: a })).body.id;
    idB = (await app.api('POST', '/api/repos', { project: 'grp/front', url: b })).body.id;
    idGros = (await app.api('POST', '/api/repos', { project: 'grp/gros', url: depot('gros', gros) })).body.id;
  });
  after(async () => { await app.stop(); });

  const comparer = (qs) => app.api('GET', `/api/git/compare?${qs}`);
  /* Une ref se désigne par son nom ET son genre : une branche et un tag peuvent porter le même,
     et le serveur ne devine pas. Par défaut, une branche. */
  const paire = (ra, ba, rb, bb, ka = 'branch', kb = 'branch') => `repo_a=${ra}&ref_a=${ba}&kind_a=${ka}&repo_b=${rb}&ref_b=${bb}&kind_b=${kb}`;

  test('deux dépôts sans histoire commune : chaque fichier tombe dans un seul seau', async () => {
    const { status, body } = await comparer(paire(idA, 'main', idB, 'main'));
    assert.equal(status, 200, JSON.stringify(body));

    assert.deepEqual(body.only_a, ['src/deep/nested/util.js', 'src/index.js']);
    assert.deepEqual(body.only_b, ['src/main.js']);
    assert.deepEqual(body.differ, ['logo.png', 'package.json']);
    // README.md est identique : compté, jamais listé — c'est ce qui rend l'écran lisible.
    assert.equal(body.same, 1);
    for (const liste of [body.only_a, body.only_b, body.differ]) {
      assert.ok(!liste.includes('README.md'), 'un fichier identique ne doit apparaître nulle part');
    }
    assert.deepEqual(body.a, { project: 'grp/api', ref: 'main', kind: 'branch', files: 5 });
    assert.deepEqual(body.b, { project: 'grp/front', ref: 'main', kind: 'branch', files: 4 });
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
    assert.deepEqual(body.only_b, ['gros.bin', 'src/old.js']);
    assert.deepEqual(body.differ, []);
    assert.equal(body.same, 4);
  });

  /* Deux dépôts étrangers rendent des dizaines de milliers de lignes que personne ne lit. On
     borne — et on le DIT, sinon la liste coupée passe pour la liste entière. */
  test('au-delà du plafond, les listes sont coupées et la troncature est annoncée', async () => {
    const { body } = await comparer(paire(idGros, 'main', idB, 'main'));
    assert.equal(body.tronque, true);
    assert.equal(body.only_a.length, 2000);
    assert.equal(body.a.files, 2100);
    assert.deepEqual(body.only_b, ['README.md', 'logo.png', 'package.json', 'src/main.js']);
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
    const vide = await comparer(`repo_a=${idA}&ref_a=&repo_b=${idB}&ref_b=main`);
    assert.equal(vide.status, 400);
    assert.match(vide.body.error, /grp\/api/);
  });

  /* Comparer une version livrée à la suivante, c'est comparer deux TAGS. La ref est du même
     bois qu'une branche pour git — encore faut-il la chercher au bon endroit. */
  test('un tag se compare comme une branche', async () => {
    const { status, body } = await comparer(paire(idA, 'v1.0', idB, 'main', 'tag', 'branch'));
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.a, { project: 'grp/api', ref: 'v1.0', kind: 'tag', files: 5 });
    assert.deepEqual(body.only_b, ['src/main.js'], 'v1.0 pointe main : même résultat que main');
    assert.deepEqual(body.differ, ['logo.png', 'package.json']);
  });

  /* LE cas qui justifie de transporter le genre : `origin/v1` ne dit pas si on parle de la
     branche v1 ou du tag v1, et les deux ne montrent pas la même chose. */
  test('une branche et un tag homonymes ne sont pas confondus', async () => {
    const { body: cote } = await comparer(paire(idA, 'v1', idA, 'v1', 'tag', 'branch'));
    assert.equal(cote.a.kind, 'tag');
    assert.equal(cote.b.kind, 'branch');
    assert.deepEqual(cote.only_b, ['sur-la-branche-v1.txt'],
      'la branche porte un fichier que le tag, posé sur main, n’a pas');
    assert.deepEqual(cote.only_a, []);

    // Et le fichier ne se lit QUE du côté branche.
    const { body: f } = await fichier(idA, 'v1', idA, 'v1', 'sur-la-branche-v1.txt', 'tag', 'branch');
    assert.equal(f.a.exists, false);
    assert.equal(f.b.exists, true);
    assert.match(f.diff, /^\+branche$/m);
  });

  test('un tag inconnu est refusé, même si une branche porte ce nom', async () => {
    const { status, body } = await comparer(paire(idA, 'legacy', idB, 'main', 'tag', 'branch'));
    assert.equal(status, 400);
    assert.match(body.error, /legacy/);
  });

  /* LE CONTENU D'UN FICHIER, des deux côtés. C'est la question qui suit immédiatement « il est
     des deux côtés mais différent » : différent COMMENT ? Le diff est calculé par git entre deux
     blobs extraits, ce qui marche justement là où `git diff a..b` ne peut rien — sans ancêtre. */
  const fichier = (ra, ba, rb, bb, chemin, ka = 'branch', kb = 'branch') => app.api('GET', `/api/git/compare/file?${paire(ra, ba, rb, bb, ka, kb)}&path=${encodeURIComponent(chemin)}`);

  test('un fichier des deux côtés rend le diff de ses deux versions', async () => {
    const { status, body } = await fichier(idA, 'main', idB, 'main', 'package.json');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.path, 'package.json');
    assert.deepEqual(body.a, { project: 'grp/api', ref: 'main', kind: 'branch', exists: true, size: 18 });
    assert.equal(body.b.exists, true);
    assert.equal(body.identique, false);
    assert.match(body.diff, /^-\{ "name": "api" \}$/m, 'la version de GAUCHE part en retrait');
    assert.match(body.diff, /^\+\{ "name": "front" \}$/m, 'celle de DROITE en ajout');
    assert.equal(body.binaire, false);
    assert.equal(body.trop_gros, false);
  });

  test('un fichier identique le dit au lieu de rendre un diff vide', async () => {
    const { body } = await fichier(idA, 'main', idB, 'main', 'README.md');
    assert.equal(body.identique, true);
    assert.equal(body.diff.trim(), '');
    assert.equal(body.a.exists && body.b.exists, true);
  });

  /* Un fichier d'un seul côté se lit CONTRE LE VIDE : toutes ses lignes en retrait. C'est
     exactement ce qu'on veut voir — « voilà ce qui manque à droite », ligne par ligne. */
  test('un fichier absent d’un côté rend tout son contenu en retrait', async () => {
    const { body } = await fichier(idA, 'main', idB, 'main', 'src/index.js');
    assert.equal(body.a.exists, true);
    assert.equal(body.b.exists, false);
    assert.match(body.diff, /^-module\.exports = \{\};$/m);
    assert.ok(!/^\+/m.test(body.diff.replace(/^\+\+\+.*$/m, '')), 'rien n’est présenté comme ajouté');
    assert.equal(body.identique, false);
  });

  test('un binaire s’annonce au lieu de déverser ses octets', async () => {
    const { body } = await fichier(idA, 'main', idB, 'main', 'logo.png');
    assert.equal(body.binaire, true);
    assert.ok(!body.diff.includes('PNG'), 'le contenu n’est pas rendu');
  });

  test('au-delà du plafond, le fichier n’est pas chargé et l’écran le sait', async () => {
    const { body } = await fichier(idA, 'main', idA, 'legacy', 'gros.bin');
    assert.equal(body.trop_gros, true);
    assert.equal(body.diff, '');
    assert.ok(body.b.size > 1024 * 1024, 'la taille reste annoncée, elle, pour qu’on sache pourquoi');
  });

  test('un chemin absent des deux côtés, ou vide, est refusé', async () => {
    const nulle = await fichier(idA, 'main', idB, 'main', 'nulle/part.txt');
    assert.equal(nulle.status, 400);
    assert.match(nulle.body.error, /nulle\/part\.txt/);
    const vide = await fichier(idA, 'main', idB, 'main', '');
    assert.equal(vide.status, 400);
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

    /* Le libellé « Dépôt » et le libellé « Branche ou tag » n'ont pas la même longueur : posés
       à côté du champ, ils décalaient les deux listes l'une par rapport à l'autre et le bloc
       partait en dents de scie. Ils sont donc AU-DESSUS, et les champs prennent la largeur —
       un nom de projet ou de tag est long, le tronquer fait perdre ce qu'on cherchait. */
    test('les deux listes d’un côté sont alignées et prennent la largeur du bloc', async () => {
      const geo = await page.evaluate(() => ['a', 'b'].map((c) => {
        const bloc2 = document.querySelector(`.compare-cote[data-cote="${c}"]`);
        const combos = [...bloc2.querySelectorAll('.combo')].map((e) => e.getBoundingClientRect());
        return { bloc: bloc2.getBoundingClientRect().width, x: combos.map((r) => Math.round(r.x)), w: combos.map((r) => Math.round(r.width)) };
      }));
      for (const c of geo) {
        assert.equal(c.x[0], c.x[1], 'les deux listes commencent au même endroit');
        assert.equal(c.w[0], c.w[1], 'et font la même largeur');
        assert.ok(c.w[0] > c.bloc - 40, `la liste occupe le bloc (${c.w[0]} pour ${Math.round(c.bloc)})`);
      }
    });

    test('changer de dépôt vide la branche déjà choisie', async () => {
      await choisir('a', 'grp/api', 'legacy');
      // La valeur transporte le GENRE, pas seulement le nom : « branch:legacy ».
      assert.equal(await cote('a').locator('.cmp-branch-a').inputValue(), 'branch:legacy');
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
      assert.deepEqual(await compte('diff'), ['logo.png', 'package.json']);
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
      assert.equal(await page.locator('#compareResult .compare-list li').count(), 5);
      await page.locator('#compareFilter').fill('');
      await page.waitForFunction(() => !document.querySelector('#compareResult .compare-list li[hidden]'));
    });

    /* Changer de dépôt vide la branche (test précédent) : il reste alors un côté incomplet.
       L'écran doit le DIRE tout de suite, pas laisser partir une requête qui échouera. */
    /* Comparer deux versions livrées, c'est comparer deux TAGS : ils vivent donc dans la même
       liste que les branches, marqués comme tels — et le résultat le rappelle, parce qu'un tag
       et une branche peuvent porter le même nom. */
    test('la liste propose les tags à côté des branches', async () => {
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.waitForFunction(() => [...document.querySelectorAll('.combo-options')].every((b) => b.hidden));
      await cote('a').locator('.cb-search').click();
      await page.waitForSelector('.combo-options:not([hidden]) .combo-opt');
      const options = await page.locator('.combo-options:not([hidden]) .combo-opt').allTextContents();
      assert.ok(options.some((o) => /main/.test(o)), `les branches : ${options.join(' / ')}`);
      assert.ok(options.some((o) => /v1\.0.*tag/.test(o)), `le tag est marqué : ${options.join(' / ')}`);

      await page.locator('.combo-options:not([hidden]) .combo-opt', { hasText: 'v1.0' }).first().click();
      /* Le résultat précédent est encore à l'écran : on attend qu'il change, pas qu'il existe. */
      await page.locator('#btnCompare').click();
      await page.waitForFunction(() => /v1\.0/.test(document.querySelector('#compareResult').textContent));
      assert.match(await page.locator('#compareResult').innerText(), /grp\/api · v1\.0 \(tag\)/,
        'le genre est rappelé dans le résultat');

      // …et on revient sur main pour la suite.
      await choisir('a', 'grp/api', 'main');
      await page.locator('#btnCompare').click();
      await page.waitForFunction(() => !/v1\.0/.test(document.querySelector('#compareResult').textContent));
    });

    /* Cliquer un fichier est LE geste attendu après la comparaison : on vient de voir qu'il
       diffère, on veut voir en quoi. */
    test('cliquer un fichier ouvre ses différences', async () => {
      await page.locator('.compare-col[data-col="diff"] .cmp-file', { hasText: 'package.json' }).click();
      await page.waitForSelector('#compareFileModal:not([hidden])');

      assert.equal(await page.locator('#compareFilePath').textContent(), 'package.json');
      // Le rouge est le dépôt de GAUCHE : sans ce rappel, on lit le diff à l'envers.
      const cotes = await page.locator('#compareFileSides').innerText();
      assert.match(cotes, /-\s*grp\/api · main/);
      assert.match(cotes, /\+\s*grp\/front · main/);
      assert.equal(await page.locator('#compareFileBody .dl-row.del').count(), 1);
      assert.equal(await page.locator('#compareFileBody .dl-row.add').count(), 1);
      // Aucune merge request derrière : rien à commenter ligne à ligne.
      assert.equal(await page.locator('#compareFileBody .ln-comment:visible').count(), 0);

      await page.keyboard.press('Escape');
      await page.waitForSelector('#compareFileModal[hidden]', { state: 'attached' });
    });

    test('un fichier d’un seul côté s’ouvre aussi, et dit lequel', async () => {
      await page.locator('.compare-col[data-col="a"] .cmp-file', { hasText: 'src/index.js' }).click();
      await page.waitForSelector('#compareFileModal:not([hidden])');

      assert.match(await page.locator('#compareFileSides').innerText(), /grp\/front · main — absent/);
      assert.ok(await page.locator('#compareFileBody .dl-row.del').count() > 0);
      assert.equal(await page.locator('#compareFileBody .dl-row.add').count(), 0);
      await page.locator('#compareFileClose').click();
      assert.equal(await page.locator('#compareFileModal').isVisible(), false);
    });

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
