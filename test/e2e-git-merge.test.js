'use strict';
/* MERGER UNE BRANCHE DANS UNE AUTRE (onglet Git → Merge).
 *
 * Cette fonctionnalité écrit dans de vrais dépôts et pousse sur de vraies branches. Ce qui se
 * teste ici n'est donc pas « l'écran affiche quelque chose » mais ce qui doit être VRAI D'UN
 * DÉPÔT GIT à la fin :
 *
 *   1. le clone partagé n'est JAMAIS laissé à moitié fusionné — tout se passe dans un worktree
 *      à part, sinon la première review venue trouverait un dépôt inutilisable ;
 *   2. ce qui part sur la destination est exactement ce que l'utilisateur a choisi, conflit par
 *      conflit ;
 *   3. rien ne part sans les deux gestes demandés : commiter, puis pousser ;
 *   4. abandonner ne laisse rien derrière — ni worktree, ni branche, ni commit.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, poserIdentiteGit, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');
/* On importe le module PUR, jamais `src/gitmerge` : celui-ci require `src/db`, qui OUVRE la
   base au chargement — et à cet instant le harnais n'a pas encore posé `MERGERIE_DATA_DIR`.
   Un tel import écrit dans la base RÉELLE de l'utilisateur. C'est arrivé ; d'où `src/conflits`. */
const conflits = require('../src/conflits');

const { dispo } = navigateurDispo();

/* ------------------------------------------------- les marqueurs, sans dépôt ---- */

describe('Découper un fichier en conflit', () => {
  const AVEC = ['debut', '<<<<<<< HEAD', 'de main', '=======', 'de la feature', '>>>>>>> feature/x', 'fin'].join('\n');

  test('les deux versions sont séparées, le reste ressort intact', () => {
    const m = conflits.decouper(AVEC);
    assert.deepEqual(m.map((x) => x.type), ['stable', 'conflit', 'stable']);
    assert.deepEqual(m[1].ours, ['de main'], 'ours = la branche de destination, celle qu’on avait');
    assert.deepEqual(m[1].theirs, ['de la feature']);
    assert.deepEqual(m[0].lignes, ['debut']);
    assert.deepEqual(m[2].lignes, ['fin']);
  });

  test('le style diff3 est lu aussi, et sa base est conservée', () => {
    // Un dépôt réglé en `merge.conflictStyle=diff3` ajoute un quatrième marqueur. Ne pas le
    // reconnaître ferait passer la version d'origine pour une partie de « ours ».
    const m = conflits.decouper(['<<<<<<< HEAD', 'a', '||||||| base', 'o', '=======', 'b', '>>>>>>> x'].join('\n'));
    assert.deepEqual(m[0].ours, ['a']);
    assert.deepEqual(m[0].base, ['o']);
    assert.deepEqual(m[0].theirs, ['b']);
  });

  test('recoller rend EXACTEMENT ce qu’on a choisi', () => {
    const m = conflits.decouper(AVEC);
    assert.equal(conflits.recoller(m, ['ours']), 'debut\nde main\nfin');
    assert.equal(conflits.recoller(m, ['theirs']), 'debut\nde la feature\nfin');
    assert.equal(conflits.recoller(m, ['deux']), 'debut\nde main\nde la feature\nfin');
    assert.equal(conflits.recoller(m, []), 'debut\nde main\nfin', 'sans choix, on garde la destination');
  });

  test('un fichier sans conflit se recolle à l’identique', () => {
    const texte = 'une\ndeux\ntrois';
    assert.equal(conflits.recoller(conflits.decouper(texte), []), texte);
  });

  test('un marqueur jamais refermé ne fait pas perdre la fin du fichier', () => {
    /* Un fichier abîmé à la main ne doit pas se retrouver tronqué : on rend tout, l'écran
       bascule alors en édition libre. */
    const abime = ['a', '<<<<<<< HEAD', 'b', '=======', 'c', 'd'].join('\n');
    assert.equal(conflits.recoller(conflits.decouper(abime), []), abime);
  });
});

/* --------------------------------------------------------------- le parcours ---- */

describe('Git · Merge de branche à branche', () => {
  let app; let repoId; let bare; let work;
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

  before(async () => {
    app = await startApp();
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
    bare = path.join(racine, 'origin.git'); work = path.join(racine, 'work');
    fs.mkdirSync(bare); fs.mkdirSync(work);
    g(bare, 'init', '-q', '--bare', '-b', 'main', '.');
    g(work, 'init', '-q', '-b', 'main', '.'); poserIdentiteGit(work);
    g(work, 'remote', 'add', 'origin', bare);
    fs.writeFileSync(path.join(work, 'a.txt'), 'ligne 1\ncommune\nligne 3\n');
    g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', '-u', 'origin', 'main');
    await app.configure();
    const cree = await app.api('POST', '/api/repos', { project: 'grp/app', url: bare });
    assert.equal(cree.status, 200, `le décor doit partir d'une base vierge : ${JSON.stringify(cree.body)}`);
    repoId = cree.body.id;
  });
  after(async () => { await app.stop(); });

  /** Deux branches qui se marchent dessus sur `a.txt`, plus un ajout sans conflit. */
  function scenarioConflit(suffixe) {
    const src = `feature/${suffixe}`;
    /* On se recale sur la forge AVANT de repartir : un test précédent a pu y pousser un merge,
       et un `work` en retard ferait échouer le push du scénario suivant — l'échec accuserait
       alors la fonctionnalité au lieu du décor. */
    g(work, 'checkout', '-q', 'main');
    g(work, 'fetch', '-q', 'origin');
    g(work, 'reset', '-q', '--hard', 'origin/main');
    g(work, 'checkout', '-q', '-b', src);
    fs.writeFileSync(path.join(work, 'a.txt'), `ligne 1\nvenue de ${src}\nligne 3\n`);
    fs.writeFileSync(path.join(work, `neuf-${suffixe}.txt`), 'ajout sans conflit\n');
    g(work, 'add', '-A'); g(work, 'commit', '-qm', `travail ${src}`); g(work, 'push', '-q', '-u', 'origin', src);
    g(work, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(work, 'a.txt'), `ligne 1\nvenue de main ${suffixe}\nligne 3\n`);
    g(work, 'add', '-A'); g(work, 'commit', '-qm', `main avance ${suffixe}`); g(work, 'push', '-q', 'origin', 'main');
    return src;
  }
  const demarrer = (source, target = 'main') =>
    app.api('POST', '/api/git/merges', { repo_id: repoId, source, target });
  const solder = async (id) => { await app.api('DELETE', `/api/git/merges/${id}`); };

  test('le clone PARTAGÉ n’est jamais laissé à moitié fusionné', async () => {
    /* C'est l'invariant qui protège tout le reste de l'application : une review, une session ou
       une vérification qui tomberait sur un clone en plein merge échouerait sans comprendre. */
    const src = scenarioConflit('clone');
    const { body } = await demarrer(src);
    assert.equal(body.status, 'conflict');

    const cfg = app.db.prepare('SELECT * FROM config WHERE id = 1').get();
    const repo = app.db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId);
    const clone = require('../src/git').cloneDirFor(cfg, repo);
    assert.equal(fs.existsSync(path.join(clone, '.git', 'MERGE_HEAD')), false,
      'le merge doit vivre dans SON worktree, pas dans le clone');
    assert.equal(g(clone, 'status', '--porcelain'), '', 'et le clone doit rester propre');
    await solder(body.id);
  });

  test('les conflits sont listés, et les deux versions séparées', async () => {
    const src = scenarioConflit('deux');
    const { body } = await demarrer(src);
    assert.deepEqual(body.conflits, ['a.txt'], 'seul le fichier vraiment en conflit');
    const f = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    const conflits = f.body.morceaux.filter((m) => m.type === 'conflit');
    assert.equal(conflits.length, 1);
    assert.deepEqual(conflits[0].ours, ['venue de main deux']);
    assert.deepEqual(conflits[0].theirs, [`venue de ${src}`]);
    await solder(body.id);
  });

  test('ce qui part est ce qu’on a choisi, conflit par conflit', async () => {
    const src = scenarioConflit('choix');
    const { body } = await demarrer(src);
    const r = await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['theirs'] });
    assert.equal(r.body.status, 'ready');
    assert.deepEqual(r.body.conflits, []);
    const c = await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: r.body.message });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await app.api('POST', `/api/git/merges/${body.id}/push`, {});

    const surLaForge = execFileSync('git', ['show', 'main:a.txt'], { cwd: bare }).toString();
    assert.equal(surLaForge, `ligne 1\nvenue de ${src}\nligne 3\n`, 'la version choisie, et elle seule');
    assert.match(g(bare, 'log', '--format=%s', '-1', 'main'), /^Merge branch/);
    // Le fichier ajouté par la branche, lui, arrive sans qu'on ait rien eu à faire.
    assert.ok(g(bare, 'ls-tree', '--name-only', 'main').includes('neuf-choix.txt'));
  });

  test('le message est pré-rempli, et lisible', async () => {
    /* En détaché, git propose « into HEAD », qui ne dit rien à personne : on écrit la formule
       qu'un auteur attend. */
    const src = scenarioConflit('msg');
    const { body } = await demarrer(src);
    const r = await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['ours'] });
    assert.match(r.body.message, new RegExp(`^Merge branch '${src}' into main`));
    assert.doesNotMatch(r.body.message, /HEAD/);
    await solder(body.id);
  });

  test('éditer à la main l’emporte sur les boutons', async () => {
    const src = scenarioConflit('edit');
    const { body } = await demarrer(src);
    await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', content: 'ce que j’ai écrit\n' });
    const r = await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: 'fusion à la main' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await app.api('POST', `/api/git/merges/${body.id}/push`, {});
    assert.equal(execFileSync('git', ['show', 'main:a.txt'], { cwd: bare }).toString(), 'ce que j’ai écrit\n');
  });

  /* ------------------------------------------------------------ les refus ---- */

  test('rien ne part sans les deux gestes : commiter, puis pousser', async () => {
    const src = scenarioConflit('gestes');
    const { body } = await demarrer(src);
    const avant = g(bare, 'rev-parse', 'main');

    const refus = await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: 'x' });
    assert.equal(refus.status, 400, 'commiter avec un conflit non résolu doit être refusé');
    /* Et le refus doit être LE NÔTRE. Sans le garde-fou, git refuse aussi — mais avec sa sortie
       brute (« Committing is not possible because you have unmerged files »), qui n'apprend
       rien à qui n'a pas la main dans un terminal. */
    assert.match(refus.body.error, /conflit|conflict/i);
    assert.doesNotMatch(refus.body.error, /unmerged/i, 'pas la sortie brute de git');
    assert.equal((await app.api('POST', `/api/git/merges/${body.id}/push`, {})).status, 400,
      'pousser avant de commiter aussi');
    await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['ours'] });
    assert.equal((await app.api('POST', `/api/git/merges/${body.id}/push`, {})).status, 400,
      'résolu ne veut pas dire commité');
    assert.equal(g(bare, 'rev-parse', 'main'), avant, 'la destination n’a pas bougé d’un pouce');
    await solder(body.id);
  });

  test('un message vide est refusé', async () => {
    const src = scenarioConflit('vide');
    const { body } = await demarrer(src);
    await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['ours'] });
    assert.equal((await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: '   ' })).status, 400);
    await solder(body.id);
  });

  test('on ne résout que des fichiers RÉELLEMENT en conflit', async () => {
    /* Le chemin vient du navigateur : accepter n'importe lequel laisserait écrire où l'on veut
       sur le disque depuis une page web. */
    const src = scenarioConflit('chemin');
    const { body } = await demarrer(src);
    for (const mauvais of ['../../evade.txt', 'neuf-chemin.txt', '/etc/passwd']) {
      assert.equal((await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: mauvais, content: 'x' })).status,
        400, `${mauvais} ne doit pas être accepté`);
    }
    assert.equal((await app.api('GET', `/api/git/merges/${body.id}/file?path=${encodeURIComponent('../../../etc/passwd')}`)).status, 400);
    await solder(body.id);
  });

  test('deux merges à la fois sur le même dépôt : refusé, et on dit lequel bloque', async () => {
    const src = scenarioConflit('un');
    const { body } = await demarrer(src);
    const second = await demarrer(scenarioConflit('deuxieme'));
    assert.equal(second.status, 400);
    assert.match(second.body.error, new RegExp(src.replace('/', '\\/')), 'le message doit nommer le merge en cours');
    await solder(body.id);
  });

  test('une branche déjà fusionnée, une branche inconnue, la même des deux côtés : refusés', async () => {
    assert.equal((await demarrer('main', 'main')).status, 400);
    assert.equal((await demarrer('feature/nexiste-pas')).status, 400);
    // `main` contient déjà tout `main` : il n'y a rien à fusionner.
    const src = scenarioConflit('dejafait');
    const m = await demarrer(src);
    await app.api('POST', `/api/git/merges/${m.body.id}/resolve`, { path: 'a.txt', choices: ['ours'] });
    await app.api('POST', `/api/git/merges/${m.body.id}/commit`, { message: 'fusion' });
    await app.api('POST', `/api/git/merges/${m.body.id}/push`, {});
    const encore = await demarrer(src);
    assert.equal(encore.status, 400, 'refuser plutôt que de créer un merge vide');
  });

  test('abandonner ne laisse rien derrière', async () => {
    const src = scenarioConflit('abandon');
    const { body } = await demarrer(src);
    const dir = body.dir;
    assert.ok(fs.existsSync(dir));
    const avant = g(bare, 'rev-parse', 'main');
    await solder(body.id);
    assert.equal(fs.existsSync(dir), false, 'le worktree part avec la demande');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM git_merge WHERE id = ?').get(body.id).n, 0,
      'la demande disparaît de la base, elle aussi');
    assert.equal(g(bare, 'rev-parse', 'main'), avant, 'et la destination n’a pas bougé');
  });


  test('deux branches sans ancêtre commun : on explique au lieu de laisser git jurer', async () => {
    /* Cas RÉEL, remonté à l'usage : « fatal: refusing to merge unrelated histories ». Git a
       raison de refuser — fusionner deux histoires étrangères juxtapose deux projets. Ce qui
       n'allait pas, c'est que l'utilisateur recevait la sortie brute de git, qui ne dit ni
       pourquoi ni quoi faire. */
    g(work, 'checkout', '-q', 'main');
    g(work, 'fetch', '-q', 'origin');
    g(work, 'reset', '-q', '--hard', 'origin/main');
    g(work, 'checkout', '-q', '--orphan', 'venue-dailleurs');
    fs.writeFileSync(path.join(work, 'autre.txt'), 'un projet sans rapport\n');
    g(work, 'add', '-A'); g(work, 'commit', '-qm', 'racine indépendante');
    g(work, 'push', '-q', '-u', 'origin', 'venue-dailleurs');
    g(work, 'checkout', '-q', 'main');

    const refus = await demarrer('venue-dailleurs');
    assert.equal(refus.status, 400);
    assert.equal(refus.body.code, 'UNRELATED', 'l’écran doit pouvoir RECONNAÎTRE ce refus');
    assert.match(refus.body.error, /ancêtre commun|common ancestor/i, 'et la raison doit être en clair');
    assert.doesNotMatch(refus.body.error, /fatal:/, 'pas la sortie brute de git');

    // Demandé explicitement, le merge se fait.
    const force = await app.api('POST', '/api/git/merges', {
      repo_id: repoId, source: 'venue-dailleurs', target: 'main', allow_unrelated: true,
    });
    assert.equal(force.status, 200, JSON.stringify(force.body));
    assert.ok(['ready', 'conflict'].includes(force.body.status));
    await solder(force.body.id);
  });

  /* --------------------------------------------------------------- l'écran ---- */

  describe('l’écran de résolution', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; let mergeId;

    before(async () => {
      const src = scenarioConflit('ui');
      mergeId = (await demarrer(src)).body.id;
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
      await page.goto(app.base);
      await page.locator('nav button[data-tab="git"]').click();
      await page.locator('#tab-git .subnav [data-gsub="merge"]').click();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('les trois choix se cherchent : un dépôt actif a des centaines de branches', async () => {
      // `npm run check` refuse déjà une liste de refs sans recherche ; on le vérifie à l'écran.
      for (const cls of ['merge-source', 'merge-target']) {
        assert.equal(await page.locator(`#gsub-merge [data-combo="${cls}"]`).count(), 1,
          `${cls} doit être un combo avec recherche`);
      }
      assert.equal(await page.locator('#gsub-merge .repo-combo [data-repo-combo]').count(), 1);
    });

    test('le merge en cours se reprend, et montre les DEUX versions face à face', async () => {
      await page.locator(`[data-mopen="${mergeId}"]`).click();
      await page.locator('#mergeWork .cf-hunk').first().waitFor({ timeout: 20000 });
      const texte = await page.locator('#mergeWork').innerText();
      assert.match(texte, /venue de main ui/, 'la version de la destination');
      assert.match(texte, /venue de feature\/ui/, 'et celle qu’on fusionne');
      assert.match(texte, /a\.txt/, 'le fichier concerné est nommé');
      assert.equal(await page.locator('.cf-hunk [data-keep="ours"]').count(), 1);
      assert.equal(await page.locator('.cf-hunk [data-keep="theirs"]').count(), 1);
      assert.equal(await page.locator('.cf-hunk [data-keep="deux"]').count(), 1);
    });

    test('choisir une version se VOIT, sans relire les boutons', async () => {
      await page.locator('.cf-hunk [data-keep="theirs"]').click();
      await page.locator('.cf-theirs.cf-keep').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.cf-ours.cf-keep').count(), 0,
        'la version écartée ne doit pas rester colorée comme celle qu’on garde');
    });

    test('« Écrire moi-même » part du résultat des choix', async () => {
      await page.locator('[data-medit="1"]').click();
      const zone = page.locator('#mergeEditor');
      await zone.waitFor();
      const v = await zone.inputValue();
      assert.match(v, /venue de feature\/ui/, 'le choix précédent est déjà appliqué');
      assert.doesNotMatch(v, /<{7}/, 'et surtout : plus aucun marqueur à déchiffrer');
      await page.locator('[data-medit="0"]').click();
      await page.locator('.cf-hunk').first().waitFor();
    });

    test('marquer résolu, commiter avec un message pré-rempli, puis pousser', async () => {
      await page.locator('#mergeResolveChoices').click();
      await page.locator('#mergeCommit').waitFor({ timeout: 20000 });

      await page.locator('#mergeCommit').click();
      await page.locator('#mergeCommitModal:not([hidden])').waitFor();
      assert.match(await page.locator('#mergeCommitMsg').inputValue(), /^Merge branch 'feature\/ui' into main/,
        'le message arrive rempli : on le relit, on ne le rédige pas');
      await page.locator('#mergeCommitGo').click();
      await page.locator('#mergePush').waitFor({ timeout: 20000 });
      const avant = g(bare, 'rev-parse', 'main');
      await page.locator('#mergePush').click();
      // Pousser sur la branche de toute l'équipe se confirme.
      await page.locator('#confirmModal:not([hidden])').waitFor();
      await page.locator('#confirmOk').click();
      await attendreServeur(async () => (await app.api('GET', `/api/git/merges/${mergeId}`)).body.status === 'pushed',
        'le merge est poussé', 30000);
      assert.notEqual(g(bare, 'rev-parse', 'main'), avant,
        `le merge est arrivé sur la destination — journal : ${g(bare, 'log', '--oneline', '-3', 'main')}`);
      assert.equal(execFileSync('git', ['show', 'main:a.txt'], { cwd: bare }).toString(),
        'ligne 1\nvenue de feature/ui\nligne 3\n', 'et c’est bien ce qui était choisi à l’écran');
    });
  });
});

/* ------------------------------------------------- le décor de la démo ---- */

/* LE DÉPÔT RÉEL DU MODE DÉMO. Tous les autres pointent vers `gitlab.demo`, qui n'existe pas :
 * sans celui-ci, l'onglet Git → Merge est inutilisable en `npm run demo`, c'est-à-dire
 * invisible pour qui découvre l'outil. Ce test protège les trois propriétés dont l'écran
 * dépend : le dépôt existe, ses deux branches se marchent dessus, et l'application voit ses
 * VRAIES refs — lui en servir d'inventées ferait choisir une branche qui n'existe pas, et le
 * merge, qui clone pour de bon, échouerait après le choix. */
describe('Le dépôt local du décor de démo', () => {
  const DEMO = path.resolve(__dirname, '..', 'data-demo');
  const bareDemo = path.join(DEMO, 'depots', 'tarification.git');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  let seme = false;

  before(() => {
    /* Le semis efface `data-demo/` : on ne le lance QUE s'il n'a pas déjà tourné, pour ne pas
       détruire un décor que quelqu'un est en train de filmer. */
    if (!fs.existsSync(bareDemo)) {
      execFileSync('node', [path.resolve(__dirname, '..', 'scripts', 'demo-seed.js')], { stdio: 'pipe' });
      seme = true;
    }
    void seme;
  });

  test('le dépôt existe vraiment, avec ses deux branches', () => {
    assert.ok(fs.existsSync(bareDemo), 'sans dépôt joignable, l’onglet Merge est mort en démo');
    const branches = g(bareDemo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
    assert.deepEqual(branches.sort(), ['feature/remise-fidelite', 'main']);
  });

  test('les deux branches touchent la MÊME ligne — sinon il n’y a rien à résoudre', () => {
    const surMain = g(bareDemo, 'show', 'main:tarification.js');
    const surBranche = g(bareDemo, 'show', 'feature/remise-fidelite:tarification.js');
    assert.match(surMain, /REMISE_FIDELITE = 0\.07/);
    assert.match(surBranche, /REMISE_FIDELITE = 0\.10/);
    // Et un ancêtre commun : c'est un conflit, pas deux projets étrangers.
    assert.ok(g(bareDemo, 'merge-base', 'main', 'feature/remise-fidelite'));
  });

  test('en démo, ce dépôt rend ses VRAIES refs, les autres gardent les leurs', () => {
    const demoGit = require('../src/demo-git');
    const vraies = demoGit.refs('groupe/tarification', 'branch', bareDemo);
    assert.deepEqual(vraies.refs.map((r) => r.name).sort(), ['feature/remise-fidelite', 'main']);
    assert.equal(vraies.default, 'main');
    // Un dépôt fictif, lui, garde le jeu inventé : son URL ne mène à aucun dossier.
    const fictif = demoGit.refs('groupe/api-core', 'branch', 'https://gitlab.demo/groupe/api-core.git');
    assert.ok(fictif.refs.length > 1);
    assert.ok(!fictif.refs.some((r) => r.name === 'feature/remise-fidelite'));
  });
});
