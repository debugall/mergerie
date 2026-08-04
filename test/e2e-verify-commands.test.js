'use strict';
/* Vérificateur « commandes » — parcours réel (plan_add_verify.md §4 bis).
 *
 * Pas de contrat JSON ici : l'utilisateur donne une liste de commandes, et le verdict vient
 * des CODES DE SORTIE. Tout ce que ce fichier vérifie tourne autour d'une seule promesse :
 * ce qu'on affiche est ce qui s'est réellement passé — les noms de tests quand la sortie les
 * porte, et rien d'inventé quand elle ne les porte pas.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp } = require('./helpers/app');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

describe('Vérification objective — vérificateur « commandes »', () => {
  let app;
  let repoId;
  let repo2Id;
  let repo3Id;
  let mrId;
  let mrVoisinId;
  let mrTiersId;
  let bin;
  let distant;

  before(async () => {
    app = await startApp();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-bin-'));

    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-remote-'));
    git(distant, 'init', '-q', '-b', 'main');
    git(distant, 'config', 'user.email', 'test@example.com');
    git(distant, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'base');
    git(distant, 'checkout', '-q', '-b', 'feature/x');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'tête\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'tête');
    const headSha = git(distant, 'rev-parse', 'HEAD');
    git(distant, 'checkout', '-q', 'main');

    // Un second dépôt, seulement pour prouver qu'un vérificateur « commandes » le refuse.
    const autre = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-remote2-'));
    git(autre, 'init', '-q', '-b', 'main');
    git(autre, 'config', 'user.email', 'test@example.com');
    git(autre, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(autre, 'b.txt'), 'b\n');
    git(autre, 'add', '-A'); git(autre, 'commit', '-qm', 'b');
    git(autre, 'checkout', '-q', '-b', 'feature/y');
    fs.writeFileSync(path.join(autre, 'b.txt'), 'b modifié\n');
    git(autre, 'add', '-A'); git(autre, 'commit', '-qm', 'y');
    const headAutre = git(autre, 'rev-parse', 'HEAD');
    git(autre, 'checkout', '-q', 'main');

    /* Un TROISIÈME dépôt, sans le moindre rapport avec les deux autres : c'est lui qui prouve
       qu'un run d'intégration bloque même là où il n'y a aucun dépôt en commun. */
    const tiers = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-remote3-'));
    git(tiers, 'init', '-q', '-b', 'main');
    git(tiers, 'config', 'user.email', 'test@example.com');
    git(tiers, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(tiers, 'c.txt'), 'c\n');
    git(tiers, 'add', '-A'); git(tiers, 'commit', '-qm', 'c');
    git(tiers, 'checkout', '-q', '-b', 'feature/z');
    fs.writeFileSync(path.join(tiers, 'c.txt'), 'c modifié\n');
    git(tiers, 'add', '-A'); git(tiers, 'commit', '-qm', 'z');
    const headTiers = git(tiers, 'rev-parse', 'HEAD');
    git(tiers, 'checkout', '-q', 'main');

    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-clones-')) });
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: distant })).body.id;
    repo2Id = (await app.api('POST', '/api/repos', { project: 'grp/lib', url: autre })).body.id;
    repo3Id = (await app.api('POST', '/api/repos', { project: 'grp/tiers', url: tiers })).body.id;
    app.state.projects = [
      { id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant },
      { id: 2, path_with_namespace: 'grp/lib', http_url_to_repo: autre },
      { id: 3, path_with_namespace: 'grp/tiers', http_url_to_repo: tiers },
    ];
    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Changement', state: 'opened',
      source_branch: 'feature/x', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
      sha: headSha, created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    app.state.mrs['grp/lib'] = [{
      iid: 8, title: 'Changement voisin', state: 'opened',
      source_branch: 'feature/y', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/lib/-/merge_requests/8',
      sha: headAutre, created_at: new Date().toISOString(), author: { name: 'B' },
    }];
    app.state.mrs['grp/tiers'] = [{
      iid: 9, title: 'Changement tiers', state: 'opened',
      source_branch: 'feature/z', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/tiers/-/merge_requests/9',
      sha: headTiers, created_at: new Date().toISOString(), author: { name: 'C' },
    }];
    await app.api('POST', '/api/discover');
    const toutes = (await app.api('GET', '/api/mrs')).body;
    mrId = toutes.find((m) => m.iid === 7).id;
    mrVoisinId = toutes.find((m) => m.iid === 8).id;
    mrTiersId = toutes.find((m) => m.iid === 9).id;
  });

  after(async () => { await app.stop(); });

  /* Les « commandes » de test sont de vrais exécutables : on veut exercer le VRAI chemin
     (spawn sans shell, code de sortie, sortie capturée), pas une simulation. */
  const outil = (nom, corps) => {
    const p = path.join(bin, nom);
    fs.writeFileSync(p, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
    return p;
  };

  async function poser(commands, opts = {}) {
    const r = await app.api('POST', '/api/verifiers', {
      name: opts.nom || `cmd-${commands.length}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'commands', commands, timeout_s: opts.timeout_s || 60,
      run_base: opts.run_base !== false,
      report_path: opts.report_path, env: opts.env, parse_tap: opts.parse_tap,
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }

  async function attendre(id) {
    let detail = null;
    for (let i = 0; i < 400 && !detail; i++) {
      const { body } = await app.api('GET', `/api/verifications/${id}`);
      if (body.status === 'done' || body.status === 'error') detail = body;
      else await new Promise((r) => setTimeout(r, 50));
    }
    if (!detail) throw new Error('la vérification ne se termine pas');
    for (let i = 0; i < 400; i++) {
      const { body } = await app.api('GET', '/api/status');
      if (!body.running && !body.queued) return detail;
      await new Promise((r) => setTimeout(r, 50));
    }
    return detail;
  }

  const lancer = async (v) => attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);

  test('configuration : une commande shell est refusée, plusieurs dépôts sont acceptés', async () => {
    /* Il n'y a pas de shell : « && » deviendrait un argument de npm et l'échec serait
       incompréhensible. On le dit à l'enregistrement, pas au bout de dix minutes de run. */
    const shell = await app.api('POST', '/api/verifiers', {
      name: 'avec-shell', kind: 'commands', commands: ['npm ci && npm test'],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.equal(shell.status, 400);
    assert.match(shell.body.error, /shell/);

    for (const mauvaise of ['npm test | tee out', 'npm test > out.txt', 'echo $HOME', 'npm test `id`']) {
      const r = await app.api('POST', '/api/verifiers', {
        name: `x-${mauvaise}`, kind: 'commands', commands: [mauvaise],
        repos: [{ repo_id: repoId, mode: 'worktree' }],
      });
      assert.equal(r.status, 400, `« ${mauvaise} » aurait dû être refusée`);
    }

    const vide = await app.api('POST', '/api/verifiers', {
      name: 'sans-commande', kind: 'commands', commands: [],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.equal(vide.status, 400);

    // Plusieurs dépôts sont acceptés : la liste sera rejouée dans chacun.
    const deux = await app.api('POST', '/api/verifiers', {
      name: 'deux-depots', kind: 'commands', commands: ['/bin/true'],
      repos: [{ repo_id: repoId, mode: 'worktree' }, { repo_id: repo2Id, mode: 'worktree' }],
    });
    assert.equal(deux.status, 200);
    assert.equal(deux.body.repos.length, 2);
    await app.api('DELETE', `/api/verifiers/${deux.body.id}`);

    // Les guillemets, eux, sont bien découpés — sans shell.
    const ok = await app.api('POST', '/api/verifiers', {
      name: 'guillemets', kind: 'commands', commands: ['npm test -- --grep "mon test"'],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.commands, ['npm test -- --grep "mon test"']);
    await app.api('DELETE', `/api/verifiers/${ok.body.id}`);
  });

  /* L'ordre est porteur de sens — `npm ci` avant `npm test` — donc il se relit tel qu'il a
     été enregistré, et se corrige sans tout retaper. */
  test('l’ordre des commandes est conservé, et modifiable', async () => {
    const v = (await app.api('POST', '/api/verifiers', {
      name: 'ordre', kind: 'commands', commands: ['/bin/echo un', '/bin/echo deux', '/bin/echo trois'],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    })).body;
    assert.deepEqual(v.commands, ['/bin/echo un', '/bin/echo deux', '/bin/echo trois']);

    // Relecture indépendante : l'ordre vient de la base, pas de la réponse de création.
    const relu = (await app.api('GET', '/api/verifiers')).body.find((x) => x.id === v.id);
    assert.deepEqual(relu.commands, ['/bin/echo un', '/bin/echo deux', '/bin/echo trois']);

    const maj = await app.api('PUT', `/api/verifiers/${v.id}`, {
      commands: ['/bin/echo trois', '/bin/echo un', '/bin/echo deux'],
    });
    assert.equal(maj.status, 200);
    assert.deepEqual(maj.body.commands, ['/bin/echo trois', '/bin/echo un', '/bin/echo deux'],
      'réordonner remplace les positions, il n’en reste pas d’anciennes');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('tout passe : verified_pass, avec le détail commande par commande', async () => {
    const v = await poser([`${outil('prep.sh', 'echo préparation ok')} `.trim(), `${outil('ok.sh', 'echo tout va bien')}`],
      { nom: 'cmd-vert', run_base: false });
    const d = await lancer(v);
    assert.equal(d.verdict, 'verified_pass');
    assert.equal(d.head_run.commands.length, 2, 'les deux commandes ont tourné');
    assert.ok(d.head_run.commands.every((c) => c.code === 0));
    assert.match(d.head_run.commands[1].output_tail, /tout va bien/, 'la sortie est conservée');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('la première commande en échec arrête la suite', async () => {
    const temoin = path.join(bin, 'temoin.txt');
    if (fs.existsSync(temoin)) fs.unlinkSync(temoin);
    const v = await poser([
      outil('rate.sh', 'echo installation impossible >&2\nexit 3'),
      outil('jamais.sh', `echo je-ne-devrais-pas-tourner > ${temoin}`),
    ], { nom: 'cmd-arret', run_base: false });

    const d = await lancer(v);
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.head_run.commands.length, 1, 'on n’enchaîne pas après un échec');
    assert.equal(d.head_run.commands[0].code, 3);
    assert.equal(fs.existsSync(temoin), false, 'la commande suivante n’a pas été lancée du tout');

    // Sans nom de test, c'est la COMMANDE qui est imputée — et le rapport le dit.
    assert.equal(d.head_run.detail_source, 'command');
    assert.equal(d.imputable.length, 1);
    assert.match(d.imputable[0].test, /rate\.sh/);
    assert.match(d.imputable[0].message, /code de sortie 3/);
    assert.match(d.imputable[0].log_excerpt, /installation impossible/, 'la sortie d’erreur est jointe');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* La dégradation la plus importante : sans nom de test, la clé du delta est la commande.
     Base rouge ET tête rouge sur la même commande ⇒ rien de NOUVEAU ⇒ « base rouge », pas
     une accusation de la branche. C'est exactement ce qu'on veut conserver. */
  test('une commande déjà rouge sur la base n’est pas imputée à la branche', async () => {
    const v = await poser([outil('toujours-rouge.sh', 'echo ça casse depuis longtemps\nexit 1')],
      { nom: 'cmd-base-rouge' });
    const d = await lancer(v);
    assert.equal(d.verdict, 'broken_base');
    assert.deepEqual(d.imputable, []);
    assert.equal(d.base_run.status, 'fail', 'le run base a bien eu lieu');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('TAP dans la sortie : les tests cassés sont nommés, sans rien déclarer', async () => {
    const tap = [
      'TAP version 13',
      '# Subtest: panier',
      '    ok 1 - total',
      '    not ok 2 - remise',
      '      ---',
      '      error: |-',
      '        attendu 42, reçu 41',
      '      ...',
      '    ok 3 - a venir # SKIP',
      '    1..3',
      'not ok 1 - panier',
      '1..1',
    ].map((l) => `echo '${l}'`).join('\n');
    const v = await poser([outil('tap.sh', `${tap}\nexit 1`)], { nom: 'cmd-tap', run_base: false });

    const d = await lancer(v);
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.head_run.detail_source, 'tap', 'le TAP est reconnu sans aucun réglage');
    assert.deepEqual(d.imputable.map((f) => f.test), ['panier › remise'],
      'la suite parente ne double pas son sous-test, et le SKIP ne compte pas');
    assert.match(d.imputable[0].message, /attendu 42, reçu 41/);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('l’interprétation du TAP peut être désactivée', async () => {
    const v = await poser([outil('tap2.sh', "echo 'TAP version 13'\necho 'not ok 1 - x'\necho '1..1'\nexit 1")],
      { nom: 'cmd-tap-off', run_base: false, parse_tap: 0 });
    const d = await lancer(v);
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.head_run.detail_source, 'command', 'on retombe sur la commande, comme demandé');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('rapport JUnit déclaré : il prime sur la sortie et survit à la troncature', async () => {
    const xml = '<testsuite tests="2"><testcase classname="panier" name="total"/>'
      + '<testcase classname="panier" name="remise"><failure message="assert 41 == 42">detail</failure></testcase></testsuite>';
    const v = await poser([outil('junit.sh', `cat > rapport.xml <<'XML'\n${xml}\nXML\nexit 1`)],
      { nom: 'cmd-junit', run_base: false, report_path: 'rapport.xml' });

    const d = await lancer(v);
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.head_run.detail_source, 'junit');
    assert.deepEqual(d.imputable.map((f) => f.test), ['panier › remise']);
    assert.match(d.imputable[0].message, /assert 41 == 42/);
    assert.equal(d.head_run.total, 2, 'le nombre de tests vient du rapport');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('un chemin de rapport qui sort du dépôt est refusé à l’enregistrement', async () => {
    for (const rp of ['../evade.xml', '/etc/passwd']) {
      const r = await app.api('POST', '/api/verifiers', {
        name: `evasion-${rp}`, kind: 'commands', commands: ['/bin/true'], report_path: rp,
        repos: [{ repo_id: repoId, mode: 'worktree' }],
      });
      assert.equal(r.status, 400, `« ${rp} » aurait dû être refusé`);
    }
  });

  test('une commande introuvable donne une erreur, jamais un vert', async () => {
    const v = await poser(['programme-qui-nexiste-pas-du-tout'], { nom: 'cmd-absent', run_base: false });
    const d = await lancer(v);
    assert.equal(d.verdict, 'verify_error');
    assert.match(d.log_excerpt || '', /programme-qui-nexiste-pas-du-tout/);
    // Le message oriente vers la vraie cause : le PATH du serveur.
    assert.match(d.log_excerpt || '', /PATH|environnement/);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('les variables déclarées atteignent les commandes, et rien d’autre', async () => {
    const v = await poser([outil('env.sh', 'echo "vu=$MA_VAR token=${GITLAB_TOKEN:-absent} verify=$MERGERIE_VERIFY"')],
      { nom: 'cmd-env', run_base: false, env: 'MA_VAR=bonjour\n# un commentaire\n' });
    const d = await lancer(v);
    assert.equal(d.verdict, 'verified_pass');
    const sortie = d.head_run.commands[0].output_tail;
    assert.match(sortie, /vu=bonjour/, 'la variable déclarée est transmise');
    assert.match(sortie, /token=absent/, 'aucun jeton ne fuit dans l’environnement');
    assert.match(sortie, /verify=1/);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('une commande qui ne rend jamais la main est arrêtée', async () => {
    const v = await poser([outil('bloque.sh', 'sleep 60')], { nom: 'cmd-bloque', run_base: false, timeout_s: 10 });
    const d = await lancer(v);
    assert.equal(d.verdict, 'verify_error');
    assert.match(d.log_excerpt || '', /délai dépassé/);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Sans nom de test, ce qui reste de plus parlant est la comparaison des deux sorties :
     ce qui apparaît à la tête et pas sur la base est, en pratique, l'échec introduit. */
  test('ce qui est NOUVEAU par rapport à la base est isolé dans le rapport', async () => {
    const v = await poser([outil('diff.sh', 'echo ligne commune\ntest -f a.txt && grep -q tête a.txt && echo REGRESSION-ICI\nexit 1')],
      { nom: 'cmd-diff' });
    const d = await lancer(v);
    assert.equal(d.verdict, 'broken_base', 'la commande échoue des deux côtés');
    assert.ok(Array.isArray(d.head_run.new_lines), 'le rapport porte les lignes nouvelles');
    assert.ok(d.head_run.new_lines.some((l) => l.includes('REGRESSION-ICI')),
      'la ligne absente de la base est isolée');
    assert.ok(!d.head_run.new_lines.some((l) => l.includes('ligne commune')),
      'ce qui était déjà là n’est pas signalé');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('un vert avec des tests rouges dans la sortie est signalé comme incohérent', async () => {
    const v = await poser([outil('menteur.sh', "echo 'TAP version 13'\necho 'not ok 1 - x'\necho '1..1'\nexit 0")],
      { nom: 'cmd-incoherent', run_base: false });
    const d = await lancer(v);
    // Le code de sortie fait foi : le verdict est vert…
    assert.equal(d.verdict, 'verified_pass');
    // …mais on ne masque pas la contradiction, qui trahit presque toujours un vrai défaut.
    assert.equal(d.head_run.incoherence, true);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Couvrir plusieurs dépôts avec une liste de commandes : elle est rejouée dans CHACUN.
     C'est le cas des projets qui partagent la même façon de se tester — sans quoi il faudrait
     un vérificateur identique par dépôt. */
  test('la même liste est jouée dans chaque dépôt visé, et le verdict est le ET', async () => {
    /* La commande écrit le nom du dépôt lu dans son répertoire courant : c'est la preuve
       qu'elle a bien tourné là-bas, et pas deux fois au même endroit. */
    const trace = path.join(bin, 'trace.txt');
    fs.writeFileSync(trace, '');
    const marque = outil('marque.sh', `basename "$(pwd)" >> ${trace}\nls b.txt >/dev/null 2>&1 && exit 1\nexit 0`);

    const v = (await app.api('POST', '/api/verifiers', {
      name: 'multi-cmd', kind: 'commands', commands: [marque], run_base: false,
      repos: [{ repo_id: repoId, mode: 'worktree' }, { repo_id: repo2Id, mode: 'worktree' }],
    })).body;

    const lance = await app.api('POST', '/api/verify/mrs', { mr_ids: [mrId, mrVoisinId] });
    assert.equal(lance.status, 200, JSON.stringify(lance.body));
    const d = await attendre(lance.body.verification.id);

    // Deux répertoires distincts ont été visités : la liste n'a pas tourné deux fois au même endroit.
    const visites = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean);
    assert.equal(visites.length, 2);
    assert.equal(new Set(visites).size, 2, 'chaque dépôt a son propre répertoire de run');

    assert.equal(d.head_run.commands.length, 2, 'une exécution par dépôt');
    assert.deepEqual([...new Set(d.head_run.commands.map((c) => c.repo))].sort(), ['grp/app', 'grp/lib']);

    /* `grp/lib` contient b.txt, donc sa commande sort en 1 : le verdict est le ET, et
       l'échec NOMME le dépôt — sans quoi deux dépôts échouant sur `npm test` seraient
       indiscernables, et le delta base/tête les confondrait. */
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.imputable.length, 1);
    assert.match(d.imputable[0].test, /^grp\/lib › /);
    assert.equal(d.head_run.commands.find((c) => c.repo === 'grp/app').code, 0,
      'le dépôt sain reste vert dans le détail');

    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* La couverture DÉCLARÉE n'est pas ce qui est exécuté. Lancer sur une seule merge request
     ne doit toucher QUE son dépôt — même si le vérificateur en couvre d'autres. Déclarer dit
     « je sais tester ça » ; ce sont les cibles de la vérification qui disent « teste ça ». */
  test('lancé sur une seule MR, il ne touche que le dépôt de cette MR', async () => {
    const trace = path.join(bin, 'trace-solo.txt');
    fs.writeFileSync(trace, '');
    const marque = outil('marque-solo.sh', `basename "$(pwd)" >> ${trace}\nexit 0`);

    const v = (await app.api('POST', '/api/verifiers', {
      name: 'couvre-deux', kind: 'commands', commands: [marque], run_base: false,
      repos: [{ repo_id: repoId, mode: 'worktree' }, { repo_id: repo2Id, mode: 'worktree' }],
    })).body;
    assert.equal(v.repos.length, 2, 'le vérificateur couvre bien deux dépôts');

    // …mais on ne le lance que sur la MR du premier.
    const d = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);
    assert.equal(d.verdict, 'verified_pass');

    assert.equal(d.targets.length, 1, 'une seule cible : la MR lancée');
    assert.equal(d.targets[0].repo_id, repoId);
    assert.equal(d.head_run.commands.length, 1, 'la commande n’a tourné qu’une fois');

    const visites = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean);
    assert.equal(visites.length, 1, 'un seul répertoire visité — le dépôt voisin n’a pas été préparé');

    /* Et le nom de l'échec n'est pas préfixé du dépôt : il n'y a pas d'ambiguïté à lever
       quand un seul est testé, et un préfixe ici casserait l'appariement avec un run où le
       même vérificateur aurait été lancé seul. */
    assert.equal(d.head_run.commands[0].repo, 'grp/app');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Un dépôt qui casse n'empêche pas de tester les suivants : ils sont indépendants, et
     savoir que deux dépôts cassent plutôt qu'un seul vaut mieux que de s'arrêter au premier. */
  test('un dépôt en échec n’empêche pas les autres d’être testés', async () => {
    const v = (await app.api('POST', '/api/verifiers', {
      name: 'multi-rouge', kind: 'commands', run_base: false,
      commands: [outil('rouge-partout.sh', 'echo raté >&2\nexit 2')],
      repos: [{ repo_id: repoId, mode: 'worktree' }, { repo_id: repo2Id, mode: 'worktree' }],
    })).body;

    const d = await attendre((await app.api('POST', '/api/verify/mrs', { mr_ids: [mrId, mrVoisinId] })).body.verification.id);
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.head_run.commands.length, 2, 'les DEUX dépôts ont été testés');
    assert.equal(d.imputable.length, 2, 'les deux échecs sont rapportés, pas seulement le premier');
    assert.deepEqual(d.imputable.map((f) => f.test.split(' › ')[0]).sort(), ['grp/app', 'grp/lib']);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Le verrou porte sur les DÉPÔTS, pas sur l'application entière. Refuser globalement
     renverrait l'utilisateur à son écran alors que tous les autres jobs de Mergerie attendent
     simplement leur tour — et deux dépôts distincts ne peuvent de toute façon pas se gêner,
     la file étant séquentielle et réservant déjà les dépôts de chaque run. */
  test('une vérification sur un AUTRE dépôt part en file, elle n’est pas refusée', async () => {
    const lent = await poser([outil('lent.sh', 'sleep 4')], { nom: 'cmd-lent', run_base: false, timeout_s: 30 });
    const voisin = (await app.api('POST', '/api/verifiers', {
      name: 'cmd-voisin', kind: 'commands', commands: [outil('vite.sh', 'exit 0')], run_base: false,
      repos: [{ repo_id: repo2Id, mode: 'worktree' }],
    })).body;

    const premier = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: lent.id });
    assert.equal(premier.status, 200);

    // Même dépôt pendant que ça tourne : c'est un doublon, refusé avec sa raison.
    const doublon = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: lent.id });
    assert.equal(doublon.status, 400);
    assert.match(doublon.body.error, /déjà en file/);

    // Autre dépôt : accepté, et mis en file comme n'importe quel job.
    const autre = await app.api('POST', `/api/mrs/${mrVoisinId}/verify`, { verifier_id: voisin.id });
    assert.equal(autre.status, 200, JSON.stringify(autre.body));

    const d1 = await attendre(premier.body.verification.id);
    const d2 = await attendre(autre.body.verification.id);
    assert.equal(d1.verdict, 'verified_pass');
    assert.equal(d2.verdict, 'verified_pass', 'la seconde a bien tourné, pas seulement été acceptée');

    await app.api('DELETE', `/api/verifiers/${lent.id}`);
    await app.api('DELETE', `/api/verifiers/${voisin.id}`);
  });

  /* L'autre moitié de la règle : un run MULTI-DÉPÔTS est un run d'intégration. Il monte un
     environnement complet — containers, ports, bases — et deux en parallèle se marcheraient
     dessus quels que soient les dépôts. Celui-là bloque donc tout le monde. */
  test('une vérification multi-dépôts bloque même un dépôt sans rapport', async () => {
    const script = path.join(bin, 'integ-lent.sh');
    fs.writeFileSync(script, '#!/bin/sh\ncat >/dev/null\nsleep 4\nprintf \'{"version":1,"status":"pass"}\\n\'\n', { mode: 0o755 });
    const integ = (await app.api('POST', '/api/verifiers', {
      name: 'integ-multi', kind: 'script', command: script, run_base: false, timeout_s: 30,
      repos: [{ repo_id: repoId, mode: 'worktree' }, { repo_id: repo2Id, mode: 'worktree' }],
    })).body;
    const solo = (await app.api('POST', '/api/verifiers', {
      name: 'cmd-tiers', kind: 'commands', commands: [`${bin}/vite.sh`], run_base: false,
      repos: [{ repo_id: repo3Id, mode: 'worktree' }],
    })).body;

    const lot = await app.api('POST', '/api/verify/mrs', { mr_ids: [mrId, mrVoisinId] });
    assert.equal(lot.status, 200, JSON.stringify(lot.body));

    // Aucun dépôt en commun, et pourtant refusé — avec la raison, qui n'est pas la même.
    const tiers = await app.api('POST', `/api/mrs/${mrTiersId}/verify`, { verifier_id: solo.id });
    assert.equal(tiers.status, 400);
    assert.match(tiers.body.error, /multi-dépôts/);

    await attendre(lot.body.verification.id);

    // Une fois l'intégration finie, le tiers passe sans rien demander.
    const apres = await app.api('POST', `/api/mrs/${mrTiersId}/verify`, { verifier_id: solo.id });
    assert.equal(apres.status, 200);
    await attendre(apres.body.verification.id);

    await app.api('DELETE', `/api/verifiers/${integ.id}`);
    await app.api('DELETE', `/api/verifiers/${solo.id}`);
  });

  test('modifier la liste des commandes invalide le run base mis en cache', async () => {
    const marqueur = path.join(bin, 'compte.txt');
    fs.writeFileSync(marqueur, '');
    const cmd = outil('compte.sh', `echo x >> ${marqueur}\nexit 0`);
    // Une ligne écrite par exécution : le fichier COMPTE les runs réellement lancés.
    const runs = () => fs.readFileSync(marqueur, 'utf8').split('\n').filter(Boolean).length;

    const v = await poser([cmd], { nom: 'cmd-cache' });
    await lancer(v);
    assert.equal(runs(), 2, 'premier passage : la base ET la tête sont lancées');

    // Même vérificateur, mêmes SHAs : le run base doit être repris du cache.
    await lancer(v);
    assert.equal(runs(), 3, 'seule la tête est rejouée, la base vient du cache');

    // On change la liste : le résultat mémorisé ne vaut plus rien.
    const maj = await app.api('PUT', `/api/verifiers/${v.id}`, { commands: [cmd, outil('deux.sh', 'exit 0')] });
    assert.equal(maj.status, 200);
    await lancer(maj.body);
    assert.equal(runs(), 5, 'base ET tête sont rejouées après modification de la liste');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });
});
