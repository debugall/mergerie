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
  afficherMenusOptionnels, waitForJobs,
} = require('./helpers/app');
/* On importe le module PUR, jamais `src/gitmerge` : celui-ci require `src/db`, qui OUVRE la
   base au chargement — et à cet instant le harnais n'a pas encore posé `MERGERIE_DATA_DIR`.
   Un tel import écrit dans la base RÉELLE de l'utilisateur. C'est arrivé ; d'où `src/conflits`. */
const conflits = require('../src/git/conflits');

const { dispo } = navigateurDispo();

/* « DEMANDER À L'IA » DEMANDE CONFIRMATION avant de partir (l'appel envoie le contenu des
   fichiers en conflit à l'agent) : cliquer le bouton, puis valider la modale, comme pour
   pousser — jamais un clic direct. */
async function demanderIaEtConfirmer(page) {
  await page.locator('#mergeAiPropose').click();
  await page.locator('#confirmModal:not([hidden])').waitFor();
  await page.locator('#confirmOk').click();
}

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

  /* UN CHOIX PEUT PORTER SON PROPRE TEXTE, pas seulement désigner un côté — c'est ce qui
     permet à une proposition de l'IA (ou une correction posée sur CE conflit précis) de
     remplacer le bloc sans passer par « ours »/« theirs »/« deux ». */
  test('un choix peut porter son propre texte, pour une proposition acceptée', () => {
    const m = conflits.decouper(AVEC);
    assert.equal(conflits.recoller(m, [{ texte: 'fusion proposée par l’IA' }]), 'debut\nfusion proposée par l’IA\nfin');
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

  /** Comme `scenarioConflit`, mais avec DEUX conflits bien séparés dans le MÊME fichier —
      assez de lignes stables entre les deux pour que git les garde en deux morceaux distincts
      plutôt que de les fondre en un seul. */
  function scenarioMulti(suffixe) {
    const src = `feature/${suffixe}`;
    const base = Array.from({ length: 13 }, (_, i) => `ligne ${i + 1}`);
    g(work, 'checkout', '-q', 'main'); g(work, 'fetch', '-q', 'origin'); g(work, 'reset', '-q', '--hard', 'origin/main');
    fs.writeFileSync(path.join(work, 'multi.txt'), `${base.join('\n')}\n`);
    g(work, 'add', '-A'); g(work, 'commit', '-qm', `base multi ${suffixe}`); g(work, 'push', '-q', 'origin', 'main');

    g(work, 'checkout', '-q', '-b', src);
    const surSrc = [...base];
    surSrc[1] = 'deux — venue de la source'; surSrc[11] = 'douze — venue de la source';
    fs.writeFileSync(path.join(work, 'multi.txt'), `${surSrc.join('\n')}\n`);
    g(work, 'add', '-A'); g(work, 'commit', '-qm', `travail multi ${suffixe}`); g(work, 'push', '-q', '-u', 'origin', src);

    g(work, 'checkout', '-q', 'main');
    const surMain = [...base];
    surMain[1] = 'deux — venue de la cible'; surMain[11] = 'douze — venue de la cible';
    fs.writeFileSync(path.join(work, 'multi.txt'), `${surMain.join('\n')}\n`);
    g(work, 'add', '-A'); g(work, 'commit', '-qm', `main avance multi ${suffixe}`); g(work, 'push', '-q', 'origin', 'main');
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
    const clone = require('../src/git/git').cloneDirFor(cfg, repo);
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

  /* QUELLE VERSION EST LA PLUS RÉCENTE ? Rien ne le disait : les deux blocs d'un conflit se
     lisaient à l'aveugle. `HEAD` (la destination, sur laquelle le worktree est basé) et
     `MERGE_HEAD` (la source) sont datées séparément, avec des dates de commit choisies à la
     main pour ne dépendre d'aucun minutage réel. */
  test('la date de la dernière modification de chaque côté est donnée avec le fichier', async () => {
    const src = `feature/dates`;
    const commit = (cwd, quand, message) => execFileSync('git', ['commit', '-qm', message], {
      cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: quand, GIT_COMMITTER_DATE: quand },
    });
    g(work, 'checkout', '-q', 'main'); g(work, 'fetch', '-q', 'origin'); g(work, 'reset', '-q', '--hard', 'origin/main');
    g(work, 'checkout', '-q', '-b', src);
    fs.writeFileSync(path.join(work, 'a.txt'), `ligne 1\nvenue de ${src}\nligne 3\n`);
    g(work, 'add', '-A'); commit(work, '2026-01-01T10:00:00', `travail ${src}`);
    g(work, 'push', '-q', '-u', 'origin', src);
    g(work, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(work, 'a.txt'), 'ligne 1\nvenue de main dates\nligne 3\n');
    g(work, 'add', '-A'); commit(work, '2026-06-01T10:00:00', 'main avance dates');
    g(work, 'push', '-q', 'origin', 'main');

    const { body } = await demarrer(src);
    const f = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    assert.match(f.body.dates.ours, /^2026-06-01T10:00:00/, 'HEAD porte la destination, la plus récente ici');
    assert.match(f.body.dates.theirs, /^2026-01-01T10:00:00/, 'MERGE_HEAD porte la source, plus ancienne ici');
    await solder(body.id);
  });

  /* DEMANDER À L'IA : une proposition par conflit, EN JOB DE FOND, jamais appliquée toute
     seule — il faut encore choisir « ia » pour ce conflit précis, exactement comme pour
     « ours »/« theirs »/« deux ». En dry-run (décor de test), le mock déterministe de
     `copilot.js` propose la version « theirs » de chaque conflit : ce n'est pas ce qui compte
     ici, seulement que le format délimité fasse l'aller-retour jusqu'à l'écran et jusqu'au
     fichier final. */
  test('« Demander à l’IA » propose une résolution, à choisir conflit par conflit', async () => {
    const src = scenarioConflit('ia');
    const { body } = await demarrer(src);

    const avant = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    assert.equal(avant.body.propositions, null, 'rien tant que rien n’a été demandé');

    const job = await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    assert.equal(job.status, 200, JSON.stringify(job.body));
    await waitForJobs(app.api);

    const apres = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    assert.equal(apres.body.propositions.length, 1, 'une proposition pour l’unique conflit');
    assert.match(apres.body.propositions[0].texte, new RegExp(`venue de ${src}`), 'le mock propose « theirs »');
    assert.match(apres.body.propositions[0].raison, /raison \(dry-run\)/, 'chaque proposition porte aussi sa raison');

    // La choisir, comme « ours »/« theirs »/« deux » — un choix parmi d'autres, pas un geste à part.
    const r = await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['ia'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'ready');
    const c = await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: r.body.message });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await app.api('POST', `/api/git/merges/${body.id}/push`, {});
    assert.equal(execFileSync('git', ['show', 'main:a.txt'], { cwd: bare }).toString(),
      `ligne 1\nvenue de ${src}\nligne 3\n`, 'le texte parti sur la destination est celui de la proposition acceptée');
  });

  /* UNE PROPOSITION MANQUANTE (jamais demandée, ou l'agent a ignoré ce conflit précis) retombe
     sur « ours » — le repli le moins surprenant, jamais une erreur serveur. */
  test('choisir « ia » sans proposition retombe sur « ours »', async () => {
    const src = scenarioConflit('ia-absente');
    const { body } = await demarrer(src);
    const r = await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['ia'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: r.body.message });
    await app.api('POST', `/api/git/merges/${body.id}/push`, {});
    assert.equal(execFileSync('git', ['show', 'main:a.txt'], { cwd: bare }).toString(),
      'ligne 1\nvenue de main ia-absente\nligne 3\n', 'la destination, comme un « ours » ordinaire');
  });

  /* PLUSIEURS CONFLITS DANS UN MÊME FICHIER : une proposition par conflit, numérotée dans
     l'ORDRE d'apparition — et choisie indépendamment (un « ia » pour le premier n'entraîne
     pas les autres). */
  test('plusieurs conflits dans un même fichier : une proposition par conflit, choisie indépendamment', async () => {
    const src = scenarioMulti('multi');
    const { body } = await demarrer(src);
    const avant = await app.api('GET', `/api/git/merges/${body.id}/file?path=multi.txt`);
    assert.equal(avant.body.morceaux.filter((m) => m.type === 'conflit').length, 2,
      'les deux modifications restent deux conflits distincts');

    await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    await waitForJobs(app.api);
    const apres = await app.api('GET', `/api/git/merges/${body.id}/file?path=multi.txt`);
    assert.equal(apres.body.propositions.length, 2);
    assert.match(apres.body.propositions[0].texte, /deux — venue de la source/, 'la proposition n°1 porte le premier conflit');
    assert.match(apres.body.propositions[1].texte, /douze — venue de la source/, 'la proposition n°2 porte le second');
    assert.match(apres.body.propositions[0].raison, /raison \(dry-run\) du conflit 1\.1/, 'sa raison porte le même i.j que le texte');
    assert.match(apres.body.propositions[1].raison, /raison \(dry-run\) du conflit 1\.2/, 'et le second conflit a la sienne, distincte');

    // Choix MÉLANGÉS : la proposition de l'IA pour le premier conflit, « theirs » pour le second.
    const r = await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'multi.txt', choices: ['ia', 'theirs'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: r.body.message });
    await app.api('POST', `/api/git/merges/${body.id}/push`, {});
    const final = execFileSync('git', ['show', 'main:multi.txt'], { cwd: bare }).toString().split('\n');
    assert.equal(final[1], 'deux — venue de la source', 'premier conflit : la proposition acceptée');
    assert.equal(final[11], 'douze — venue de la source', 'second conflit : « theirs », un choix indépendant du premier');
  });

  /* UNE PROPOSITION MANQUANTE POUR UN SEUL CONFLIT PARMI PLUSIEURS (l'agent a répondu pour
     l'un, pas pour l'autre) ne doit ni planter l'écran ni bloquer la résolution du reste :
     seul CE conflit-là retombe sur « ours ». On simule la réponse partielle directement en
     base — le mock de test, lui, répond toujours pour tous les conflits ; c'est un vrai agent
     qui peut en sauter un. */
  test('une proposition manquante pour un conflit parmi plusieurs retombe sur « ours », pour lui seul', async () => {
    const src = scenarioMulti('partiel');
    const { body } = await demarrer(src);
    await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    await waitForJobs(app.api);

    const ligne = app.db.prepare('SELECT ai_json FROM git_merge WHERE id = ?').get(body.id);
    const toutes = JSON.parse(ligne.ai_json);
    toutes['multi.txt'][1] = null;    // l'agent a « oublié » le second conflit
    app.db.prepare('UPDATE git_merge SET ai_json = ? WHERE id = ?').run(JSON.stringify(toutes), body.id);

    // Le fichier revient sans planter, et le dit : `null`, pas une chaîne vide qui laisserait
    // croire à une proposition « vide » plutôt qu'absente.
    const relu = await app.api('GET', `/api/git/merges/${body.id}/file?path=multi.txt`);
    assert.notEqual(relu.body.propositions[0], null, 'le premier conflit garde sa proposition');
    assert.equal(relu.body.propositions[1], null, 'le second n’en a plus');

    const r = await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'multi.txt', choices: ['ia', 'ia'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: r.body.message });
    await app.api('POST', `/api/git/merges/${body.id}/push`, {});
    const final = execFileSync('git', ['show', 'main:multi.txt'], { cwd: bare }).toString().split('\n');
    assert.equal(final[1], 'deux — venue de la source', 'la proposition existante s’applique');
    assert.equal(final[11], 'douze — venue de la cible', '« ia » sans proposition retombe sur « ours », jamais une erreur');
  });

  /* UN BLOC `R` ABSENT N'EST PAS UNE PANNE : le texte proposé reste utilisable même sans raison
     à montrer — c'est ce qu'un vrai agent produit s'il n'a pas suivi le format demandé pour le
     second bloc. On simule ce cas directement en base, comme pour la proposition manquante. */
  test('une proposition sans raison reste utilisable : elle s’applique, simplement rien à montrer', async () => {
    const src = scenarioConflit('sans-raison');
    const { body } = await demarrer(src);
    await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    await waitForJobs(app.api);

    const ligne = app.db.prepare('SELECT ai_json FROM git_merge WHERE id = ?').get(body.id);
    const toutes = JSON.parse(ligne.ai_json);
    toutes['a.txt'][0].raison = null;    // l'agent n'a rendu que le bloc F, pas le bloc R
    app.db.prepare('UPDATE git_merge SET ai_json = ? WHERE id = ?').run(JSON.stringify(toutes), body.id);

    const relu = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    assert.notEqual(relu.body.propositions[0].texte, null, 'le texte reste là');
    assert.equal(relu.body.propositions[0].raison, null, 'la raison, elle, est absente');

    const r = await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['ia'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await app.api('POST', `/api/git/merges/${body.id}/commit`, { message: r.body.message });
    await app.api('POST', `/api/git/merges/${body.id}/push`, {});
    assert.equal(execFileSync('git', ['show', 'main:a.txt'], { cwd: bare }).toString(),
      `ligne 1\nvenue de ${src}\nligne 3\n`, 'une raison absente n’empêche pas d’accepter la proposition');
  });

  /* UN SEUL APPEL, TOUS LES FICHIERS. « Demander à l'IA » ne se fait PAS fichier par fichier :
     un seul appel résout tous les fichiers encore en conflit du merge — c'est tout le sens de
     la vue globale (voir `session/mergeai.js`). */
  test('une seule demande couvre tous les fichiers en conflit du merge, pas un à la fois', async () => {
    const src = 'feature/deuxfichiers';
    g(work, 'checkout', '-q', 'main'); g(work, 'fetch', '-q', 'origin'); g(work, 'reset', '-q', '--hard', 'origin/main');
    g(work, 'checkout', '-q', '-b', src);
    fs.writeFileSync(path.join(work, 'a.txt'), `ligne 1\nvenue de ${src} sur a\nligne 3\n`);
    fs.writeFileSync(path.join(work, 'b2.txt'), `ligne 1\nvenue de ${src} sur b2\nligne 3\n`);
    g(work, 'add', '-A'); g(work, 'commit', '-qm', 'travail deux fichiers'); g(work, 'push', '-q', '-u', 'origin', src);
    g(work, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(work, 'a.txt'), 'ligne 1\nvenue de main sur a\nligne 3\n');
    fs.writeFileSync(path.join(work, 'b2.txt'), 'ligne 1\nvenue de main sur b2\nligne 3\n');
    g(work, 'add', '-A'); g(work, 'commit', '-qm', 'main avance deux fichiers'); g(work, 'push', '-q', 'origin', 'main');

    const { body } = await demarrer(src);
    assert.deepEqual(body.conflits.sort(), ['a.txt', 'b2.txt']);

    // UN SEUL appel — aucun chemin dans le corps de la requête, il n'y a pas de fichier à désigner.
    const job = await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    assert.equal(job.status, 200, JSON.stringify(job.body));
    await waitForJobs(app.api);

    const fA = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    const fB = await app.api('GET', `/api/git/merges/${body.id}/file?path=b2.txt`);
    assert.equal(fA.body.propositions.length, 1, 'a.txt a reçu sa proposition');
    assert.equal(fB.body.propositions.length, 1, 'b2.txt AUSSI, dans le même appel');
    assert.match(fA.body.propositions[0].texte, /venue de feature\/deuxfichiers sur a/);
    assert.match(fB.body.propositions[0].texte, /venue de feature\/deuxfichiers sur b2/);
    await solder(body.id);
  });

  test('redemander une proposition la remplace, elle ne s’ajoute pas à la précédente', async () => {
    const src = scenarioConflit('reask');
    const { body } = await demarrer(src);
    await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    await waitForJobs(app.api);
    await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    await waitForJobs(app.api);
    const relu = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    assert.equal(relu.body.propositions.length, 1, 'toujours une seule proposition pour l’unique conflit — jamais deux');
    await solder(body.id);
  });

  /* UN MERGE SANS CONFLIT RESTANT (tout a déjà été résolu) ne coûte aucun appel inutile —
     `proposer()` s'arrête avant même de solliciter l'agent dès que `etat.conflits` est vide —
     et ne fait pas échouer le job pour autant : rien à proposer n'est pas une panne. */
  test('demander une proposition quand plus rien n’est en conflit ne fait rien, sans erreur', async () => {
    const src = scenarioConflit('sanscflt');
    const { body } = await demarrer(src);
    await app.api('POST', `/api/git/merges/${body.id}/resolve`, { path: 'a.txt', choices: ['ours'] });
    const job = await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, {});
    assert.equal(job.status, 200, JSON.stringify(job.body));
    await waitForJobs(app.api);
    const log = await app.api('GET', `/api/jobs/${job.body.id}/log`);
    assert.equal(log.body.status, 'done', 'aucun conflit restant n’est pas une panne, juste rien à proposer');
    await solder(body.id);
  });

  /* L'APPEL NE PREND PLUS DE CHEMIN DU TOUT — un effet de bord bienvenu de la vue globale :
     l'ancienne route acceptait un `path` choisi par le navigateur, ce qui ouvrait la porte à
     une tentative de traversée (`../../../etc/passwd`) que `contenu()` devait refuser à la
     main. Un `path` envoyé quand même (un client ancien, par exemple) est simplement ignoré :
     la liste des fichiers à traiter vient TOUJOURS de `git`, jamais du corps de la requête. */
  test('un `path` envoyé dans le corps de la requête est ignoré : la liste vient de git', async () => {
    const src = scenarioConflit('securite');
    const { body } = await demarrer(src);
    const job = await app.api('POST', `/api/git/merges/${body.id}/ai-propose`, { path: '../../../etc/passwd' });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    await waitForJobs(app.api);
    const log = await app.api('GET', `/api/jobs/${job.body.id}/log`);
    assert.equal(log.body.status, 'done', 'le `path` fourni n’a aucun effet : le vrai conflit (a.txt) est traité normalement');
    const f = await app.api('GET', `/api/git/merges/${body.id}/file?path=a.txt`);
    assert.equal(f.body.propositions.length, 1);
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
      await afficherMenusOptionnels(page);
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

    test('la date de chaque version apparaît à côté de sa branche, avec l’heure', async () => {
      // La valeur exacte est mesurée côté API ; ici, qu'elle arrive bien jusqu'à l'écran —
      // et que ce soit bien une DATE ET UNE HEURE, pas seulement le jour : deux commits du
      // même jour, sans heure, se distingueraient uniquement à leur ordre dans la liste.
      const dates = await page.locator('.cf-hunk .cf-date').allTextContents();
      assert.equal(dates.length, 2, 'une date à côté de chaque branche');
      for (const texte of dates) assert.match(texte, /\d{1,2}:\d{2}/, `l’heure doit être visible : « ${texte} »`);
    });

    /* « DEMANDER À L'IA » : une proposition de plus, à côté de « ours » et « theirs » — jamais
       appliquée toute seule. En dry-run, le mock déterministe de `copilot.js` propose la
       version de la source. */
    test('« Demander à l’IA » ajoute une troisième version, à choisir comme les deux autres', async () => {
      assert.equal(await page.locator('.cf-hunk .cf-ia').count(), 0, 'rien tant que rien n’a été demandé');
      await demanderIaEtConfirmer(page);
      await page.waitForSelector('#mergeAiStatus');
      await page.locator('.cf-hunk .cf-ia').first().waitFor({ timeout: 20000 });
      await page.waitForSelector('#mergeAiPropose');   // l’indicateur a laissé la place au bouton
      assert.match(await page.locator('.cf-hunk .cf-ia pre').innerText(), /venue de feature\/ui/);

      await page.locator('.cf-hunk .cf-ia [data-keep="ia"]').click();
      await page.waitForSelector('.cf-hunk .cf-ia.cf-keep');
      assert.equal(await page.locator('.cf-hunk .cf-ours.cf-keep, .cf-hunk .cf-theirs.cf-keep').count(), 0,
        'les deux autres versions ne doivent plus paraître retenues');
    });

    /* « VOIR LA RAISON » : repliée par défaut — trois colonnes ET une justification dépliée
       d'office noierait l'écran — et son texte n'apparaît qu'après le clic. */
    test('« Voir la raison » affiche, puis masque, le pourquoi de la proposition', async () => {
      assert.equal(await page.locator('.cf-hunk .cf-ia [data-reason]').count(), 1,
        'un bouton par proposition qui porte une raison');
      assert.equal(await page.locator('.cf-hunk .cf-reason').count(), 0, 'repliée par défaut');

      await page.locator('.cf-hunk .cf-ia [data-reason]').click();
      await page.locator('.cf-hunk .cf-reason').waitFor();
      assert.match(await page.locator('.cf-hunk .cf-reason').innerText(), /raison \(dry-run\)/, 'la raison du mock apparaît');
      // Le choix « ia » fait juste avant survit à l'ouverture de la raison — deux états séparés.
      assert.equal(await page.locator('.cf-hunk .cf-ia.cf-keep').count(), 1);

      await page.locator('.cf-hunk .cf-ia [data-reason]').click();
      await page.waitForSelector('.cf-hunk .cf-reason', { state: 'hidden' });
    });

    test('« Garder les deux » nomme les branches, dans l’ordre où elles s’appliquent', async () => {
      const bouton = page.locator('.cf-both button');
      assert.match(await bouton.innerText(), /main.*feature\/ui/s, 'la cible avant la source, comme le fait recoller()');
      assert.match(await bouton.getAttribute('title'), /main.*feature\/ui/s, 'et l’explication complète au survol');
    });

    /* LE BOUTON PLEIN ÉCRAN : le fichier ENTIER de chaque côté, plus le résultat des choix
       actuels — plutôt que trois lignes de contexte à la fois. Choisir un passage y reste
       possible, et se répercute dans la vue normale une fois refermé. */
    test('le bouton plein écran montre les deux versions entières et le résultat au milieu', async () => {
      await page.locator('#mergeFullOpen').click();
      await page.locator('#mergeFullView:not([hidden])').waitFor();
      assert.match(await page.locator('#mergeFullOurs').innerText(), /venue de main ui/, 'la destination, en entier');
      assert.match(await page.locator('#mergeFullTheirs').innerText(), /venue de feature\/ui/, 'la source, en entier');

      // Choisir la version de la source, à droite : le résultat au milieu suit.
      await page.locator('#mergeFullTheirs .mf-hunk').first().click();
      await page.waitForFunction(() => /venue de feature\/ui/.test(document.querySelector('#mergeFullResult').textContent));

      await page.locator('#mergeFullClose').click();
      await page.waitForSelector('#mergeFullView', { state: 'hidden' });
      // Le choix fait en plein écran s’est répercuté dans la vue normale.
      await page.locator('.cf-theirs.cf-keep').waitFor();
    });

    /* UN SEUL CONFLIT : la navigation se montre quand même, et cliquer y « navigue » bel et
       bien — même s'il n'y a nulle part ailleurs à aller, ça recentre et remarque le conflit,
       plutôt que d'être un bouton désactivé qui ne fait rien au clic. */
    test('un seul conflit dans le fichier : le bouton reste là, et cliquer navigue vers lui', async () => {
      await page.locator('#mergeFullOpen').click();
      await page.locator('#mergeFullView:not([hidden])').waitFor();
      assert.equal(await page.locator('#mergeFullNav:not([hidden])').count(), 1, 'la navigation se montre même à un seul conflit');
      assert.match(await page.locator('#mergeFullNavCount').innerText(), /1\s*\/\s*1/);
      // Marqué dès l'ouverture — c'est le seul conflit du fichier, forcément le courant.
      assert.notEqual(await page.locator('[data-h="0"].mf-nav-cible').count(), 0, 'le seul conflit est déjà le conflit courant');

      // Cliquer « suivant » n'a nulle part ailleurs où aller, mais reste actif : ça recentre
      // et remarque le même conflit plutôt que de rester un bouton mort.
      await page.locator('#mergeFullNext').click();
      await page.waitForFunction(() => {
        const el = document.querySelector('#mergeFullOurs [data-h="0"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top <= window.innerHeight;
      });
      assert.match(await page.locator('#mergeFullNavCount').innerText(), /1\s*\/\s*1/, 'toujours 1/1 : il n’y a que lui');

      await page.locator('#mergeFullClose').click();
      await page.waitForSelector('#mergeFullView', { state: 'hidden' });
    });

    /* LA QUATRIÈME COLONNE, en plein écran : la proposition de l'IA (déjà demandée dans un test
       précédent) et sa raison, dépliable comme dans la vue normale — et cliquer la proposition
       la choisit, exactement comme un passage à gauche ou à droite. */
    test('la vue plein écran montre aussi la proposition de l’IA, et sa raison', async () => {
      await page.locator('#mergeFullOpen').click();
      await page.locator('#mergeFullView:not([hidden])').waitFor();
      assert.equal(await page.locator('#mergeFullIa:not([hidden])').count(), 1, 'une quatrième colonne apparaît');
      assert.equal(await page.locator('#mergeFullToggles [data-toggle-col]').count(), 4, 'un bouton par colonne, IA comprise');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.merge-full-body'))
        .gridTemplateColumns.split(' ').length === 4, null, { timeout: 5000 });
      assert.match(await page.locator('#mergeFullIa').innerText(), /venue de feature\/ui/, 'la proposition, en entier');
      // Repli de ligne, pas de défilement horizontal : le `<pre>` de la proposition n'est pas un
      // `.mf-hunk` comme les trois autres colonnes, il lui faut donc sa propre règle de repli.
      assert.equal(await page.locator('#mergeFullIa .mf-ia pre').evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-wrap');

      await page.locator('#mergeFullIa [data-reason]').click();
      await page.locator('#mergeFullIa .mf-reason').waitFor();
      assert.match(await page.locator('#mergeFullIa .mf-reason').innerText(), /raison \(dry-run\)/, 'la même raison qu’à l’écran normal');

      // La choisir ici la reflète dans la vue normale, comme pour « ours »/« theirs ».
      await page.locator('#mergeFullIa .mf-ia').first().click();
      await page.waitForFunction(() => /venue de feature\/ui/.test(document.querySelector('#mergeFullResult').textContent));

      // Masquer cette colonne rend sa largeur aux trois autres.
      await page.locator('#mergeFullToggles [data-toggle-col="ia"]').click();
      await page.waitForSelector('#mergeFullIa', { state: 'hidden' });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.merge-full-body'))
        .gridTemplateColumns.split(' ').length === 3, null, { timeout: 5000 });
      // … et la redemander la fait revenir.
      await page.locator('#mergeFullToggles [data-toggle-col="ia"]').click();
      await page.waitForSelector('#mergeFullIa:not([hidden])');

      await page.locator('#mergeFullClose').click();
      await page.waitForSelector('#mergeFullView', { state: 'hidden' });
      await page.locator('.cf-hunk .cf-ia.cf-keep').waitFor();
    });

    /* MASQUER LA DERNIÈRE COLONNE VISIBLE EST REFUSÉ : sans elle, la vue serait vide et les
       boutons pour en rouvrir une resteraient hors d'atteinte de nulle part. */
    test('masquer les quatre colonnes n’est pas possible : au moins une reste', async () => {
      await page.locator('#mergeFullOpen').click();
      await page.locator('#mergeFullView:not([hidden])').waitFor();
      for (const cle of ['ours', 'theirs', 'ia']) await page.locator(`#mergeFullToggles [data-toggle-col="${cle}"]`).click();
      await page.waitForSelector('#mergeFullOurs', { state: 'hidden' });
      // Trois masquées, une seule reste : la tenter quand même ne doit rien changer.
      await page.locator('#mergeFullToggles [data-toggle-col="result"]').click();
      assert.equal(await page.locator('#mergeFullResult:not([hidden])').count(), 1, 'la dernière colonne visible résiste');

      // On rouvre tout pour ne pas laisser cet état aux tests suivants.
      for (const cle of ['ours', 'theirs', 'ia']) await page.locator(`#mergeFullToggles [data-toggle-col="${cle}"]`).click();
      await page.waitForSelector('#mergeFullOurs:not([hidden])');
      await page.locator('#mergeFullClose').click();
      await page.waitForSelector('#mergeFullView', { state: 'hidden' });
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

  /* « DEMANDER À L'IA », CAS LIMITES : changer de fichier avant la fin d'une demande, et un
     échec de la demande elle-même. Un merge à DEUX fichiers en conflit, pour pouvoir en garder
     un ouvert pendant que l'autre travaille encore. */
  describe('« Demander à l’IA » — cas limites à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; let mergeId;
    const erreurs = [];

    before(async () => {
      const src = scenarioConflit('ia-ecran');
      // Un second fichier en conflit, dans le MÊME merge que celui de `scenarioConflit`.
      g(work, 'checkout', '-q', src);
      fs.writeFileSync(path.join(work, 'b3.txt'), `ligne 1\nvenue de ${src} sur b3\nligne 3\n`);
      g(work, 'add', '-A'); g(work, 'commit', '-qm', 'second fichier'); g(work, 'push', '-q', 'origin', src);
      g(work, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(work, 'b3.txt'), 'ligne 1\nvenue de main sur b3\nligne 3\n');
      g(work, 'add', '-A'); g(work, 'commit', '-qm', 'main avance b3'); g(work, 'push', '-q', 'origin', 'main');

      mergeId = (await demarrer(src)).body.id;
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await afficherMenusOptionnels(page);
      await page.goto(app.base);
      await page.locator('nav button[data-tab="git"]').click();
      await page.locator('#tab-git .subnav [data-gsub="merge"]').click();
      await page.locator(`[data-mopen="${mergeId}"]`).click();
      await page.locator('#mergeWork .cf-hunk').first().waitFor({ timeout: 20000 });
    });
    // Sans ceci, le merge reste « en conflit » en base : un describe ajouté après celui-ci ne
    // pourrait plus en démarrer un seul sur le même dépôt (`err.merge.already-running`).
    after(async () => { if (navigateur) await navigateur.close(); await solder(mergeId); });

    /* UN SEUL BOUTON, POUR TOUT LE MERGE. Il n'y a plus de bouton par fichier : celui qui
       lance la demande couvre a.txt ET b3.txt en un seul appel, et se transforme en indicateur
       « l'IA réfléchit… » PARTOUT dans l'écran pendant ce temps — y compris si on change de
       fichier en cours de route. */
    test('un seul bouton pour tout le merge : changer de fichier pendant la demande n’interrompt rien', async () => {
      await page.waitForFunction(() => document.querySelector('#mergePane .mp-head code')?.textContent === 'a.txt');
      await demanderIaEtConfirmer(page);
      await page.waitForSelector('#mergeAiStatus');
      assert.equal(await page.locator('#mergeAiPropose').count(), 0, 'le bouton devient un indicateur pendant la demande');

      // On change de fichier PENDANT que la demande (globale, pas « pour a.txt ») tourne encore.
      await page.locator('[data-mfile="b3.txt"]').click();
      await page.waitForFunction(() => document.querySelector('#mergePane .mp-head code')?.textContent === 'b3.txt');
      assert.equal(await page.locator('#mergeAiStatus').count(), 1,
        'l’indicateur reste affiché : la demande couvre tout le merge, y compris le fichier qu’on regarde maintenant');

      // Elle finit par aboutir pour LES DEUX fichiers, y compris celui ouvert EN DERNIER.
      await attendreServeur(async () => {
        const f = await app.api('GET', `/api/git/merges/${mergeId}/file?path=b3.txt`);
        return Array.isArray(f.body.propositions) && f.body.propositions.length === 1;
      }, 'la proposition de b3.txt finit par arriver côté serveur');
      await page.locator('.cf-hunk .cf-ia').first().waitFor();
      assert.equal(await page.locator('#mergeAiPropose').count(), 1, 'le bouton redevient disponible une fois la demande terminée');

      // a.txt, qu'on ne regardait plus, a aussi reçu la sienne — sans avoir eu à la redemander.
      await page.locator('[data-mfile="a.txt"]').click();
      await page.waitForFunction(() => document.querySelector('#mergePane .mp-head code')?.textContent === 'a.txt');
      await page.locator('.cf-hunk .cf-ia').first().waitFor();
    });

    test('un échec de la demande à l’IA se signale, et le bouton redevient disponible', async () => {
      await page.route('**/api/git/merges/*/ai-propose', (route) => route.fulfill({
        status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'panne simulée' }),
      }));
      try {
        await demanderIaEtConfirmer(page);
        // Un toast de succès du test précédent peut encore traîner (il se retire tout seul après
        // 3,5 s) : chercher LE toast qui porte « panne simulée », pas « le dernier arrivé »,
        // évite de lire celui d'avant si les deux coexistent un instant.
        await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-msg')]
          .some((el) => /panne simulée/.test(el.textContent)));
        await page.waitForSelector('#mergeAiPropose', { state: 'visible' });
        assert.equal(await page.locator('#mergeAiStatus').count(), 0, 'l’indicateur ne reste pas affiché après un échec');
      } finally {
        await page.unroute('**/api/git/merges/*/ai-propose').catch(() => {});
      }
    });

    test('aucune erreur JavaScript pendant ce parcours', () => {
      assert.deepEqual(erreurs, []);
    });
  });

  /* NAVIGUER SANS SCROLLER, EN PLEIN ÉCRAN : sur un fichier à plusieurs conflits, trouver le
     suivant à la main coûte plus cher que le clic. Un fichier à DEUX conflits bien séparés
     (`scenarioMulti`) suffit à couvrir les deux bornes : au premier, « précédent » est
     inutilisable ; au dernier, « suivant » l'est. */
  describe('Naviguer au conflit suivant/précédent en plein écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;

    before(async () => {
      const src = scenarioMulti('nav');
      const mergeId = (await demarrer(src)).body.id;
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
      await afficherMenusOptionnels(page);
      await page.goto(app.base);
      await page.locator('nav button[data-tab="git"]').click();
      await page.locator('#tab-git .subnav [data-gsub="merge"]').click();
      await page.locator(`[data-mopen="${mergeId}"]`).click();
      await page.locator('#mergeWork .cf-hunk').first().waitFor({ timeout: 20000 });
      await page.locator('#mergeFullOpen').click();
      await page.locator('#mergeFullView:not([hidden])').waitFor();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('au premier conflit, le compteur affiche 1/2', async () => {
      assert.equal(await page.locator('#mergeFullNav:not([hidden])').count(), 1, 'deux conflits : la navigation se montre');
      assert.match(await page.locator('#mergeFullNavCount').innerText(), /1\s*\/\s*2/);
    });

    /* CLIQUER « PRÉCÉDENT » AU PREMIER CONFLIT NE LE DÉSACTIVE PAS : le bouton reste cliquable,
       et cliquer réaffirme juste le conflit courant (recentré, remarqué) plutôt que de rester
       sans effet — le même principe qu'à un seul conflit. */
    test('« précédent » au premier conflit reste cliquable, et réaffirme le même conflit', async () => {
      await page.locator('#mergeFullPrev').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-h="0"].mf-nav-cible').length > 0);
      assert.match(await page.locator('#mergeFullNavCount').innerText(), /1\s*\/\s*2/, 'toujours le premier, pas de débordement');
    });

    test('« suivant » avance au conflit suivant, et le marque', async () => {
      assert.equal(await page.locator('[data-h="1"].mf-nav-cible').count(), 0, 'pas encore le conflit visé');
      await page.locator('#mergeFullNext').click();
      await page.waitForFunction(() => document.querySelector('#mergeFullNavCount')?.textContent.includes('2'));
      assert.notEqual(await page.locator('[data-h="1"].mf-nav-cible').count(), 0, 'le second conflit se marque comme visé');
      // Il est bien amené dans la partie visible de l'écran, pas seulement marqué.
      await page.waitForFunction(() => {
        const el = document.querySelector('#mergeFullOurs [data-h="1"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.top <= window.innerHeight;
      });
    });

    test('au dernier conflit, « suivant » reste cliquable mais ne dépasse pas', async () => {
      await page.locator('#mergeFullNext').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-h="1"].mf-nav-cible').length > 0);
      assert.match(await page.locator('#mergeFullNavCount').innerText(), /2\s*\/\s*2/, 'toujours le dernier, pas de débordement');
    });

    test('« précédent » ramène en arrière depuis le dernier conflit', async () => {
      await page.locator('#mergeFullPrev').click();
      await page.waitForFunction(() => document.querySelector('#mergeFullNavCount')?.textContent.includes('1'));
      assert.notEqual(await page.locator('[data-h="0"].mf-nav-cible').count(), 0, 'de retour sur le premier');
    });

    test('rouvrir la vue plein écran repart du premier conflit', async () => {
      await page.locator('#mergeFullNext').click();
      await page.waitForFunction(() => document.querySelector('#mergeFullNavCount')?.textContent.includes('2'));
      await page.locator('#mergeFullClose').click();
      await page.waitForSelector('#mergeFullView', { state: 'hidden' });

      await page.locator('#mergeFullOpen').click();
      await page.locator('#mergeFullView:not([hidden])').waitFor();
      assert.match(await page.locator('#mergeFullNavCount').innerText(), /1\s*\/\s*2/);
      await page.locator('#mergeFullClose').click();
      await page.waitForSelector('#mergeFullView', { state: 'hidden' });
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
      /* SANS `MERGERIE_DATA_DIR` — et c'est tout sauf un détail. Le semis sème dans cette
         variable quand elle est posée (c'est ainsi que `mergerie demo` sème dans
         `~/.mergerie/demo`), et il COMMENCE par effacer le dossier visé. Héritée d'un
         `startApp()` plus haut dans ce fichier, elle faisait semer dans le dossier de données
         du test — qui était donc effacé — pendant que `data-demo/` restait vide et que les
         trois assertions ci-dessous échouaient. Invisible sur une machine de développement,
         où `data-demo/` existe déjà et où le semis ne tourne jamais ; systématique en CI, où
         le dossier est ignoré par git et n'arrive donc pas dans l'archive. */
      const env = { ...process.env };
      delete env.MERGERIE_DATA_DIR;
      execFileSync('node', [path.resolve(__dirname, '..', 'scripts', 'demo-seed.js')], { stdio: 'pipe', env });
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
    const demoGit = require('../src/demo/git');
    const vraies = demoGit.refs('groupe/tarification', 'branch', bareDemo);
    assert.deepEqual(vraies.refs.map((r) => r.name).sort(), ['feature/remise-fidelite', 'main']);
    assert.equal(vraies.default, 'main');
    // Un dépôt fictif, lui, garde le jeu inventé : son URL ne mène à aucun dossier.
    const fictif = demoGit.refs('groupe/api-core', 'branch', 'https://gitlab.demo/groupe/api-core.git');
    assert.ok(fictif.refs.length > 1);
    assert.ok(!fictif.refs.some((r) => r.name === 'feature/remise-fidelite'));
  });
});
