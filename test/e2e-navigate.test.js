'use strict';
/* Répertoires locaux + onglet Git → Navigation.

   Ici tout est VRAI : de vrais dépôts git clonés dans un répertoire de test, de vrais
   checkouts. C'est indispensable — ce que l'écran promet (« si tu as des modifications,
   le checkout est fait et on te les liste ») est un comportement de git, pas une
   simulation possible. Un mock dirait toujours oui.

   Le fil rouge des assertions : on ne vérifie pas seulement la réponse HTTP, mais
   l'état du dépôt SUR LE DISQUE — la branche réellement sortie et les fichiers modifiés
   toujours présents. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, git } = require('./helpers/app');

const BRANCH = 'feature/PROJ-42-ajout';

describe('Répertoires locaux et navigation (checkout multi-projets)', () => {
  let app;
  let root;          // le répertoire local déclaré : un sous-dossier par projet
  let rootId;
  const head = (name) => git(path.join(root, name), ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  before(async () => {
    app = await startApp();
    await app.configure();
    root = path.join(app.dataDir, 'mes-projets');
    fs.mkdirSync(root, { recursive: true });
    // Deux projets clonés « à la main », comme le ferait l'utilisateur : ce ne sont
    // PAS les clones de l'application (data/clones), et c'est tout l'enjeu.
    for (const name of ['api-core', 'webapp-front']) {
      const remote = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, `rem-${name}-`)), { branch: BRANCH });
      git(root, ['clone', remote.bare, name]);
    }
    // Un dossier ordinaire au milieu : le répertoire d'un vrai poste de dev n'est
    // jamais fait QUE de dépôts git.
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  });
  after(async () => { await app.stop(); });

  test('ajout d’un répertoire : chemin inexistant et doublon refusés', async () => {
    const bad = await app.api('POST', '/api/local-roots', { path: path.join(app.dataDir, 'nexiste-pas') });
    assert.equal(bad.status, 400, 'un chemin absent ne se déclare pas');

    const file = path.join(app.dataDir, 'un-fichier.txt');
    fs.writeFileSync(file, 'x');
    assert.equal((await app.api('POST', '/api/local-roots', { path: file })).status, 400, 'un fichier n’est pas un répertoire');

    const created = await app.api('POST', '/api/local-roots', { path: root, label: 'mes projets' });
    assert.equal(created.status, 200);
    rootId = created.body.id;

    assert.equal((await app.api('POST', '/api/local-roots', { path: root })).status, 400, 'pas deux fois le même répertoire');

    // Le décompte est ce qui dit d'un coup d'œil qu'on a désigné le bon niveau.
    const mine = (await app.api('GET', '/api/local-roots')).body.find((r) => r.id === rootId);
    assert.equal(mine.count, 3, '2 dépôts + 1 dossier ordinaire');
    assert.equal(mine.git_count, 2);
  });

  test('projets du répertoire : dépôts git repérés, branche courante et chemin exposés', async () => {
    const { body } = await app.api('GET', `/api/local-roots/${rootId}/projects`);
    const by = Object.fromEntries(body.projects.map((p) => [p.name, p]));
    assert.equal(by['api-core'].git, true);
    assert.equal(by['api-core'].branch, 'main', 'la branche courante est lue sans lancer git');
    // C'est ce `path` que le codage hors dépôt utilise comme dossier de travail :
    // le contrat de l'écran « répertoire + projet → chemin » tient à cette ligne.
    assert.equal(by['api-core'].path, path.join(root, 'api-core'));
    assert.equal(by.notes.git, false, 'un dossier sans .git est listé mais pas marqué git');
    assert.equal(by.notes.branch, null);
  });

  test('branches distantes d’un projet local', async () => {
    const { body } = await app.api('GET', `/api/local-projects/branches?root_id=${rootId}&name=api-core`);
    assert.deepEqual(body.branches.map((b) => b.name).sort(), [BRANCH, 'main']);
    assert.equal(body.current, 'main');
    assert.equal(body.fetch_error, null);
  });

  test('positionne chaque projet sur sa branche', async () => {
    const { body } = await app.api('POST', '/api/navigate/checkout', {
      targets: [
        { root_id: rootId, name: 'api-core', branch: BRANCH },
        { root_id: rootId, name: 'webapp-front', branch: 'main' },
      ],
    });
    const by = Object.fromEntries(body.results.map((r) => [r.project, r]));
    assert.equal(by['api-core'].state, 'done');
    assert.equal(by['api-core'].from, 'main', 'la branche de départ est rapportée');
    assert.equal(by['webapp-front'].state, 'already', 'déjà en place : dit tel quel, pas « positionné »');
    assert.equal(body.counts.done, 2);
    assert.equal(body.counts.failed, 0);
    // La vérité est sur le disque, pas dans la réponse.
    assert.equal(head('api-core'), BRANCH);
    assert.equal(head('webapp-front'), 'main');
  });

  test('un dépôt déjà modifié est quand même positionné, et les fichiers sont listés', async () => {
    const dir = path.join(root, 'api-core');
    fs.writeFileSync(path.join(dir, 'README.md'), '# modifié en local\n');   // suivi
    fs.writeFileSync(path.join(dir, 'brouillon.txt'), 'note\n');             // non suivi

    const { body } = await app.api('POST', '/api/navigate/checkout', {
      targets: [{ root_id: rootId, name: 'api-core', branch: 'main' }],
    });
    const r = body.results[0];
    assert.equal(r.state, 'done_dirty', 'le checkout est fait ET signalé comme « avec modifications »');
    assert.equal(body.counts.dirty, 1);
    assert.deepEqual(r.files.map((f) => f.file).sort(), ['README.md', 'brouillon.txt']);

    assert.equal(head('api-core'), 'main', 'la branche a bien changé');
    // Le point capital : rien n'a été jeté au passage.
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /modifié en local/);
    assert.ok(fs.existsSync(path.join(dir, 'brouillon.txt')));
  });

  test('branche inexistante : échec isolé, les autres projets passent quand même', async () => {
    const { body } = await app.api('POST', '/api/navigate/checkout', {
      targets: [
        { root_id: rootId, name: 'api-core', branch: 'ne-existe-pas' },
        { root_id: rootId, name: 'webapp-front', branch: BRANCH },
      ],
    });
    const by = Object.fromEntries(body.results.map((r) => [r.project, r]));
    assert.equal(by['api-core'].state, 'error');
    assert.ok(by['api-core'].error, 'la raison de l’échec est rapportée');
    assert.equal(by['webapp-front'].state, 'done', 'un échec n’interrompt pas la série');
    assert.equal(body.counts.failed, 1);
    assert.equal(head('api-core'), 'main', 'le dépôt en échec n’a pas bougé');
    assert.equal(head('webapp-front'), BRANCH);
  });

  test('sélection incomplète ou hors répertoire : refusée', async () => {
    // Un nom de projet ne peut pas sortir du répertoire déclaré.
    const trav = await app.api('GET', `/api/local-projects/branches?root_id=${rootId}&name=${encodeURIComponent('../mes-projets')}`);
    assert.equal(trav.status, 400, 'les séparateurs de chemin sont refusés dans un nom de projet');

    // Un nom de branche ne peut pas se transformer en option de la commande git.
    const flag = await app.api('POST', '/api/navigate/checkout', {
      targets: [{ root_id: rootId, name: 'api-core', branch: '--upload-pack=touch' }],
    });
    assert.equal(flag.body.results[0].state, 'error');

    // Branche vide, dossier sans git, aucune cible.
    const noBranch = await app.api('POST', '/api/navigate/checkout', { targets: [{ root_id: rootId, name: 'api-core', branch: '' }] });
    assert.equal(noBranch.body.results[0].state, 'error');
    const notGit = await app.api('POST', '/api/navigate/checkout', { targets: [{ root_id: rootId, name: 'notes', branch: 'main' }] });
    assert.equal(notGit.body.results[0].state, 'error');
    assert.equal((await app.api('POST', '/api/navigate/checkout', { targets: [] })).status, 400);
  });

  test('palette de commandes git : CRUD', async () => {
    const created = await app.api('POST', '/api/git-commands', { label: 'Fetch', command: 'fetch --all' });
    assert.equal(created.status, 200);
    assert.equal(created.body.command, 'fetch --all');
    const id = created.body.id;
    assert.equal((await app.api('POST', '/api/git-commands', { label: '', command: 'x' })).status, 400, 'nom requis');
    assert.ok((await app.api('GET', '/api/git-commands')).body.some((c) => c.id === id));
    const upd = await app.api('PUT', `/api/git-commands/${id}`, { label: 'Fetch tout', command: 'fetch --all --prune' });
    assert.equal(upd.body.label, 'Fetch tout');
    assert.equal((await app.api('DELETE', `/api/git-commands/${id}`)).body.ok, true);
    assert.ok(!(await app.api('GET', '/api/git-commands')).body.some((c) => c.id === id));
  });

  test('exécution d’une commande git à la racine de chaque projet (bilan par projet)', async () => {
    // VRAIE exécution : `git status --short --branch` sur deux dépôts.
    const { body } = await app.api('POST', '/api/git-run', {
      command: 'status --short --branch',
      targets: [{ root_id: rootId, name: 'api-core' }, { root_id: rootId, name: 'webapp-front' }],
    });
    assert.equal(body.command, 'git status --short --branch');
    assert.equal(body.results.length, 2);
    assert.ok(body.results.every((r) => r.ok), 'les deux status réussissent');
    assert.ok(/## /.test(body.results[0].output), 'la sortie contient la ligne de branche (## …)');
    assert.equal(body.counts.failed, 0);

    // Un dossier non-git = échec ISOLÉ, les autres passent quand même.
    const mixed = await app.api('POST', '/api/git-run', {
      command: 'status', targets: [{ root_id: rootId, name: 'notes' }, { root_id: rootId, name: 'api-core' }],
    });
    assert.equal(mixed.body.counts.ok, 1);
    assert.equal(mixed.body.counts.failed, 1);

    // Garde-fous : commande vide / aucun projet → 400.
    assert.equal((await app.api('POST', '/api/git-run', { command: '', targets: [{ root_id: rootId, name: 'api-core' }] })).status, 400);
    assert.equal((await app.api('POST', '/api/git-run', { command: 'status', targets: [] })).status, 400);
  });

  test('parseGitArgs : tokenise, tolère « git » de tête, refuse un guillemet ouvert', () => {
    const lr = require('../src/localrepos');
    assert.deepEqual(lr.parseGitArgs('fetch --all'), ['fetch', '--all']);
    assert.deepEqual(lr.parseGitArgs('git log --oneline -5'), ['log', '--oneline', '-5']);
    assert.deepEqual(lr.parseGitArgs('commit -m "hello world"'), ['commit', '-m', 'hello world']);
    assert.throws(() => lr.parseGitArgs('commit -m "oops'), /[Gg]uillemets/);
  });

  test('sécurité : les options git « exécution arbitraire » sont refusées (anti-RCE)', () => {
    const lr = require('../src/localrepos');
    // Normal : autorisé.
    assert.doesNotThrow(() => lr.assertSafeGitArgs(['fetch', '--all', '--prune']));
    assert.doesNotThrow(() => lr.assertSafeGitArgs(['log', '--oneline', '-10']));
    // RCE via config / pack / transport / redirection de dépôt : refusé.
    for (const bad of [
      ['-c', 'core.sshCommand=touch /tmp/pwned', 'status'],   // -c en tête → pas une sous-commande
      ['fetch', '--upload-pack=touch /tmp/pwned'],
      ['fetch', '--receive-pack=evil'],
      ['clone', 'ext::sh -c touch /tmp/pwned'],
      ['-C', '/etc', 'status'],                               // sortie du dossier ciblé
      ['status', '--git-dir=/somewhere'],
    ]) {
      assert.throws(() => lr.assertSafeGitArgs(bad), /sous-commande|autorisée|allowed|subcommand/, `doit refuser: ${bad.join(' ')}`);
    }
  });

  test('sécurité : /api/git-run rejette une commande piégée', async () => {
    const r = await app.api('POST', '/api/git-run', {
      command: '-c core.sshCommand=touch /tmp/pwned status',
      targets: [{ root_id: rootId, name: 'api-core' }],
    });
    assert.equal(r.status, 400, 'commande à option globale piégée → refusée');
    const r2 = await app.api('POST', '/api/git-run', {
      command: 'fetch --upload-pack=evil', targets: [{ root_id: rootId, name: 'api-core' }],
    });
    assert.equal(r2.status, 400, '--upload-pack → refusé');
  });

  test('retrait d’un répertoire : rien n’est supprimé sur le disque', async () => {
    assert.equal((await app.api('DELETE', `/api/local-roots/${rootId}`)).body.ok, true);
    assert.ok(!(await app.api('GET', '/api/local-roots')).body.some((r) => r.id === rootId));
    assert.ok(fs.existsSync(path.join(root, 'api-core')), 'les dépôts de l’utilisateur restent intacts');
    assert.equal((await app.api('GET', `/api/local-roots/${rootId}/projects`)).status, 400, 'répertoire retiré : plus de projets');
  });
});
