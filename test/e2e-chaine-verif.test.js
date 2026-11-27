'use strict';
/* LA CHAÎNE DE VALIDATION D'UNE SESSION DE CODAGE (`jobs/chaine-verif.js`).
 *
 * Sur de vrais dépôts, une vraie session (agent de test) qui pousse sa branche, et de vrais scripts :
 *   1. chaque vérificateur tourne sur la BASE puis sur la BRANCHE, l'un après l'autre ; un rouge se
 *      retente une fois ;
 *   2. un vérificateur qui ne couvre pas le dépôt de la session (celui du dépôt de tests) tourne quand
 *      même : le dépôt de la session est mis sur la base, puis sur la branche, dans le clone local ;
 *   3. base rouge deux fois : ce vérificateur s'arrête (« À toi », todo), les suivants continuent ;
 *      « Relancer » ne rejoue que lui ;
 *   4. un correctif poussé rejoue la BRANCHE de chaque vérificateur, pas la base ;
 *   5. un même vérificateur ne tourne jamais deux fois en même temps (clé de file) ;
 *   6. la fenêtre de session compose la chaîne dans l'ordre, la carte la montre.
 * Le côté est lu par le script dans le clone local : sur le SHA de main, c'est la base. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Chaîne de validation d’une session', () => {
  let app; let repo; let tests; let autre; let autreId; let repoId; let testsId; let bin; let cloneApp; let vTests; let vApp;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    tests = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'tests-')), { branch: 'feature/scenarios' });
    // Le skill de diagnostic du dépôt de tests, sur sa branche par défaut.
    fs.mkdirSync(path.join(tests.work, '.claude/skills/diag-verif'), { recursive: true });
    fs.writeFileSync(path.join(tests.work, '.claude/skills/diag-verif/SKILL.md'),
      '---\nname: diag-verif\ndescription: Diagnostiquer un scénario rouge\n---\nMÉTHODE MAISON : relancer le scénario seul, puis lire ses captures.\n');
    // Un skill de scénarios dont la méthode fait répondre « déjà couvert » à l'agent de test.
    fs.mkdirSync(path.join(tests.work, '.claude/skills/scen-couvert'), { recursive: true });
    fs.writeFileSync(path.join(tests.work, '.claude/skills/scen-couvert/SKILL.md'),
      '---\nname: scen-couvert\ndescription: Scénarios\n---\nCherche d’abord un scénario existant. DRYRUN_COUVERT\n');
    execFileSync('git', ['add', '-A'], { cwd: tests.work });
    execFileSync('git', ['commit', '-qm', 'skill'], { cwd: tests.work });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: tests.work });
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    testsId = (await app.api('POST', '/api/repos', { url: tests.url, project: 'grp/tests' })).body.id;
    // Un autre dépôt hors de la session : avec lui, le dépôt de tests ne se déduit plus.
    autre = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'autre-')));
    autreId = (await app.api('POST', '/api/repos', { url: autre.url, project: 'grp/autre' })).body.id;
    // Le clone LOCAL du dépôt de l'application : c'est là que le vérificateur du dépôt de tests le lit.
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'chaine-racine-'));
    cloneApp = path.join(racine, 'app');
    execFileSync('git', ['clone', '-q', repo.url, cloneApp], { stdio: 'pipe' });
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine })).status, 200);

    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'chaine-bin-'));
    /* Un script par vérificateur : il note le côté (base si le clone local est sur main), et échoue
       autant de fois que son fichier `fail-<nom>-<côté>` le demande. */
    const script = (nom, lireSha) => {
      const p = path.join(bin, `${nom}.sh`);
      fs.writeFileSync(p, `#!/bin/sh
if [ -n "$MERGERIE_SCENARIO" ]; then
  if [ -f "$MERGERIE_SCENARIO" ]; then etat=present; else etat=absent; fi
  echo "$MERGERIE_SCENARIO $etat" >> '${bin}/trace-${nom}-scen'
  f='${bin}/fail-${nom}-scen'
  n=$(cat "$f" 2>/dev/null || echo 0)
  if [ "$n" -gt 0 ]; then echo $((n-1)) > "$f"; exit 1; fi
  exit 0
fi
cur=$(${lireSha})
if [ "$cur" = "${repo.mainSha}" ]; then cote=base; else cote=head; fi
echo "$cote $cur" >> '${bin}/trace-${nom}'
f='${bin}/fail-${nom}-'$cote
n=$(cat "$f" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n-1)) > "$f"; cat '${bin}/cause' 2>/dev/null; exit 1; fi
exit 0
`, { mode: 0o755 });
      return p;
    };
    const creerV = async (nom, cmd, repos) => {
      const r = await app.api('POST', '/api/verifiers', {
        name: nom, kind: 'commands', commands: [cmd], timeout_s: 60, run_base: 0,
        repos: repos.map((id) => ({ repo_id: id, mode: 'worktree' })),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.id;
    };
    // Celui du dépôt de tests : il ne couvre PAS l'application, il la lit dans le clone local.
    vTests = await creerV('scenarios', script('scenarios', `git -C '${cloneApp}' rev-parse HEAD`), [testsId]);
    // Celui de l'application : il la couvre, et tourne dans son worktree.
    vApp = await creerV('unitaires', script('unitaires', 'git rev-parse HEAD'), [repoId]);
  });
  after(async () => { if (app) await app.stop(); });

  const cotes = (nom) => { try { return fs.readFileSync(path.join(bin, `trace-${nom}`), 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')[0]); } catch { return []; } };
  const echouer = (nom, cote, n) => fs.writeFileSync(path.join(bin, `fail-${nom}-${cote}`), String(n));
  const vider = () => { for (const f of fs.readdirSync(bin)) if (/^(trace|fail)-/.test(f)) fs.unlinkSync(path.join(bin, f)); };
  const chaine = async (id) => (await app.api('GET', `/api/tasks/${id}/chaine`)).body;
  async function finie(id) {
    await attendreServeur(async () => {
      const c = await chaine(id);
      return c && c.status !== 'running';
    }, 'la chaîne s’arrête', 120000);
    await waitForJobs(app.api);
    return chaine(id);
  }
  async function session(branche, ids) {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: `chaîne ${branche}`, auto_push: true, verify_chain: ids,
      targets: [{ repo_id: repoId, branch: branche }],
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.verify_chain, JSON.stringify(ids), 'la chaîne est retenue, dans l’ordre');
    await app.api('POST', `/api/tasks/${t.body.id}/run`);
    return t.body.id;
  }

  test('base puis branche, un vérificateur après l’autre ; un rouge se retente une fois ; le dépôt non couvert est mis sur la bonne ref', async () => {
    vider();
    echouer('scenarios', 'base', 1);
    const id = await session('ai/chaine-ok', [vTests, vApp]);
    const c = await finie(id);
    assert.equal(c.status, 'passed', JSON.stringify(c));
    assert.deepEqual(cotes('scenarios'), ['base', 'base', 'head'], 'base rouge, retentée verte, puis la branche');
    assert.deepEqual(cotes('unitaires'), ['base', 'head']);
    const ids = (await app.api('GET', `/api/tasks/${id}/chaine`)).body.steps.map((s) => [s.base.etat, s.head.etat]);
    assert.deepEqual(ids, [['pass', 'pass'], ['pass', 'pass']]);
    // L'ordre : tout le premier vérificateur passe avant le second.
    const lignes = app.db.prepare('SELECT verifier_id FROM verification WHERE chaine_id IS NOT NULL ORDER BY id').all().map((v) => v.verifier_id);
    assert.deepEqual(lignes, [vTests, vTests, vTests, vApp, vApp]);
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cloneApp }).toString().trim(), 'main', 'le clone local est remis');
  });

  test('base rouge deux fois : ce vérificateur attend, le suivant continue ; « Relancer » ne rejoue que lui', async () => {
    vider();
    echouer('scenarios', 'base', 2);
    const id = await session('ai/chaine-base', [vTests, vApp]);
    let c = await finie(id);
    assert.equal(c.status, 'attention');
    assert.equal(c.steps[0].base.etat, 'broken');
    assert.equal(c.steps[0].head.etat, 'waiting', 'la branche ne part pas sur une base cassée');
    assert.deepEqual([c.steps[1].base.etat, c.steps[1].head.etat], ['pass', 'pass'], 'le suivant ne dépend pas de lui');
    assert.ok(app.db.prepare("SELECT 1 FROM todo WHERE auto_kind = 'chaine_verif' AND auto_ref = ? AND status = 'open'").get(String(id)), 'une todo « À toi »');

    vider();   // la base est « corrigée »
    const r = await app.api('POST', `/api/tasks/${id}/chaine/relancer`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    c = await finie(id);
    assert.equal(c.status, 'passed');
    assert.deepEqual(cotes('scenarios'), ['base', 'head'], 'seul le vérificateur cassé repart');
    assert.deepEqual(cotes('unitaires'), [], 'le vert reste vert');
    assert.equal(app.db.prepare("SELECT 1 FROM todo WHERE auto_kind = 'chaine_verif' AND auto_ref = ? AND status = 'open'").get(String(id)), undefined, 'la todo est fermée');
  });

  test('un correctif poussé à la main rejoue la branche de chacun, pas la base', async () => {
    vider();
    const id = await session('ai/chaine-main', [vTests, vApp]);
    assert.equal((await finie(id)).status, 'passed');
    vider();
    await app.api('POST', `/api/tasks/${id}/followup`, { instruction: 'Renomme la variable' });
    await waitForJobs(app.api);
    const c = await finie(id);
    assert.equal(c.status, 'passed', JSON.stringify(c));
    assert.deepEqual(cotes('scenarios'), ['head'], 'la branche du vérificateur déjà vert est rejouée');
    assert.deepEqual(cotes('unitaires'), ['head'], 'la base, elle, ne repart pas');
  });

  /* ---------------- étape 2 : le diagnostic par la session de la feature ---------------- */

  const passes = (id) => app.db.prepare("SELECT prompt, output_path FROM agent_pass WHERE scope = 'task' AND task_id = ? ORDER BY id").all(id);

  test('branche rouge deux fois : la session diagnostique (cause branche), corrige, et la chaîne rejoue la branche', async () => {
    vider();
    echouer('scenarios', 'head', 2);
    const id = await session('ai/chaine-diag', [vTests, vApp]);
    const c = await finie(id);
    assert.equal(c.status, 'passed', JSON.stringify(c));
    assert.deepEqual(cotes('scenarios'), ['base', 'head', 'head', 'head'], 'rouge deux fois, puis vert sur le correctif');
    assert.deepEqual(cotes('unitaires'), ['base', 'head'], 'la chaîne a attendu le diagnostic, puis a continué');
    assert.equal(c.steps[0].diag.cause, 'branche');
    assert.equal(c.steps[0].diag.rounds, 1);
    const diag = passes(id).find((p) => /<<<DIAGNOSTIC /.test(p.prompt));
    assert.ok(diag, 'la session a reçu la consigne de diagnostic, en suivi');
    assert.match(diag.prompt, /scenarios/);
    assert.match(diag.prompt, /grp\/tests/, 'elle nomme le dépôt de tests');
    assert.ok(app.db.prepare('SELECT 1 FROM task_context_repo WHERE task_id = ? AND repo_id = ?').get(id, testsId),
      'le dépôt de tests est monté en lecture seule');
  });

  test('cause « environnement » : rien n’est touché, la chaîne s’arrête sur « À toi » avec le diagnostic, sans nouveau tour', async () => {
    vider();
    echouer('unitaires', 'head', 9);
    fs.writeFileSync(path.join(bin, 'cause'), 'DRYRUN_CAUSE=environnement');
    const id = await session('ai/chaine-env', [vApp]);
    const c = await finie(id);
    fs.unlinkSync(path.join(bin, 'cause'));
    assert.equal(c.status, 'attention');
    assert.equal(c.steps[0].head.etat, 'broken');
    assert.equal(c.steps[0].diag.cause, 'environnement');
    assert.match(c.steps[0].diag.preuve, /simulé/);
    assert.deepEqual(cotes('unitaires'), ['base', 'head', 'head'], 'pas de correctif : la branche ne repart pas');
    assert.equal(passes(id).filter((p) => /<<<DIAGNOSTIC /.test(p.prompt)).length, 1, 'un seul diagnostic sur ces commits');
    assert.ok(app.db.prepare("SELECT 1 FROM todo WHERE auto_kind = 'chaine_verif' AND auto_ref = ? AND status = 'open'").get(String(id)));
  });

  test('deux tours de diagnostic au plus, puis « À toi »', async () => {
    vider();
    echouer('unitaires', 'head', 99);
    const id = await session('ai/chaine-cap', [vApp]);
    const c = await finie(id);
    assert.equal(c.status, 'attention', JSON.stringify(c));
    assert.equal(c.steps[0].diag.rounds, 2);
    assert.deepEqual(cotes('unitaires'), ['base', 'head', 'head', 'head', 'head', 'head', 'head'], 'deux rouges par commit, trois commits');
    assert.equal(passes(id).filter((p) => /<<<DIAGNOSTIC /.test(p.prompt)).length, 2);
  });

  test('le skill de diagnostic du dépôt de tests est suivi : son texte est dans la consigne', async () => {
    vider();
    echouer('unitaires', 'head', 2);
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'chaîne skill', auto_push: true, verify_chain: [vApp],
      verify_chain_skill: { name: 'diag-verif', repo_id: testsId }, targets: [{ repo_id: repoId, branch: 'ai/chaine-skill' }],
    });
    assert.equal(JSON.parse(t.body.verify_chain_skill).name, 'diag-verif');
    await app.api('POST', `/api/tasks/${t.body.id}/run`);
    const c = await finie(t.body.id);
    assert.equal(c.status, 'passed', JSON.stringify(c));
    const diag = passes(t.body.id).find((p) => /<<<DIAGNOSTIC /.test(p.prompt));
    assert.match(diag.prompt, /MÉTHODE MAISON : relancer le scénario seul/, 'le corps du SKILL.md est recopié');
    const sans = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', auto_push: true, verify_chain: [vApp], verify_chain_skill: { name: '../x', repo_id: testsId }, targets: [{ repo_id: repoId, branch: 'ai/z' }],
    });
    assert.equal(sans.body.verify_chain_skill, null, 'un nom de skill qui sortirait du dossier est refusé');
  });

  test('une chaîne jamais partie (code poussé, puis arrêt) : « Continuer » la démarre et elle va au bout', async () => {
    vider();
    const id = await session('ai/chaine-demarrer', [vApp]);
    await finie(id);
    // Comme si la session s'était arrêtée avant de lancer sa chaîne.
    app.db.prepare('DELETE FROM verif_chaine WHERE task_id = ?').run(id);
    const ligne = async () => Object.values((await app.api('GET', '/api/cockpit')).body).flat().find((l) => l && l.task_id === id);
    const avant = await ligne();
    assert.deepEqual(avant.workflow.continuer, { action: 'chaine' });
    assert.equal((await app.api('POST', `/api/tasks/${id}/chaine/relancer`)).status, 200);
    const c = await finie(id);
    assert.equal(c.status, 'passed', JSON.stringify(c));
    assert.equal((await ligne()).workflow.continuer, null);
  });

  /* ---------------- étape 3 : le scénario de couverture ---------------- */

  const scenTrace = () => { try { return fs.readFileSync(path.join(bin, 'trace-scenarios-scen'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  async function sessionScen(branche, scenario) {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: `scénario ${branche}`, auto_push: true, verify_chain: [vTests, vApp], verify_chain_scenario: scenario,
      targets: [{ repo_id: repoId, branch: branche }],
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    await app.api('POST', `/api/tasks/${t.body.id}/run`);
    return t.body.id;
  }

  test('tout vert : la session écrit un scénario, Mergerie le pousse dans le dépôt de tests et le lance seul — validée', async () => {
    vider();
    const id = await sessionScen('ai/chaine-scen', { verifier_id: vTests });
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c));
    const fichier = `scenarios/nouveau-${id}.sh`;
    assert.deepEqual(c.scenario.fichiers, [fichier]);
    assert.equal(c.scenario.branche, 'ai/chaine-scen');
    assert.deepEqual(scenTrace(), [`${fichier} present`], 'le vérificateur reçoit le chemin, et le fichier est dans son dépôt de tests');
    const pousse = execFileSync('git', ['show', `ai/chaine-scen:${fichier}`], { cwd: tests.bare }).toString();
    assert.match(pousse, /scénario dry-run de la session/, 'écrit sur une branche du même nom, dans le dépôt de tests');
    assert.deepEqual(cotes('scenarios'), ['base', 'head'], 'le lancement du scénario ne se confond pas avec la chaîne');
    // La frise du cockpit : la chaîne verte, puis le test écrit, poussé et lancé dans le dépôt de tests — validée.
    const ligne = Object.values((await app.api('GET', '/api/cockpit')).body).flat().find((l) => l && l.task_id === id);
    const fin = ligne.workflow.etapes.slice(-4);
    assert.deepEqual(fin.map((e) => `${e.cle}:${e.etat}`), ['scen-ecrire:fait', 'scen-pousser:fait', 'scen-lancer:fait', 'validee:fait']);
    assert.equal(fin[0].projet, 'grp/tests');
    assert.equal(ligne.workflow.courante, null, 'plus rien ne tourne');
  });

  test('déjà couvert (skill de scénarios) : rien n’est écrit, la tâche est validée avec la raison', async () => {
    vider();
    const id = await sessionScen('ai/chaine-couvert', { verifier_id: vTests, skill: { name: 'scen-couvert', repo_id: testsId } });
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c));
    assert.equal(c.scenario.couvert.par, 'scenarios/existant.sh');
    assert.match(c.scenario.couvert.raison, /déjà couvert/);
    assert.deepEqual(scenTrace(), [], 'aucun scénario lancé');
    const p = app.db.prepare("SELECT prompt FROM agent_pass WHERE task_id = ? AND prompt LIKE '%<<<SCENARIO %' ORDER BY id DESC").get(id);
    assert.match(p.prompt, /Cherche d’abord un scénario existant/, 'le texte du skill est dans la consigne');
  });

  test('scénario rouge deux fois : la session le corrige, il repasse vert — validée après une correction', async () => {
    vider();
    echouer('scenarios', 'scen', 2);
    const id = await sessionScen('ai/chaine-scen-rouge', { verifier_id: vTests });
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c));
    assert.equal(c.scenario.corrections, 1);
    assert.equal(scenTrace().length, 3, 'rouge, rouge, puis vert après la correction');
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM agent_pass WHERE task_id = ? AND prompt LIKE '%<<<SCENARIO %'").get(id).n, 2, 'écrire, puis corriger');
  });

  test('un chemin rendu par l’agent ne sort jamais du dépôt de tests', async () => {
    // eslint-disable-next-line global-require
    const { cheminSur } = require('../src/jobs/chaine-scenario');
    assert.equal(cheminSur('scenarios/a.sh'), 'scenarios/a.sh');
    assert.equal(cheminSur('./scenarios/a.sh'), 'scenarios/a.sh');
    for (const mauvais of ['../x.sh', '/etc/passwd', 'a/../../x', '.git/hooks/pre-commit', 'a/.git/config', '']) {
      assert.equal(cheminSur(mauvais), null, mauvais);
    }
  });

  /* LE DÉPÔT DE TESTS : réglé une fois pour tous les vérificateurs (Réglages → Vérificateurs). Sans réglage,
     il est déduit — et un vérificateur qui couvre plusieurs dépôts hors de la session n'en choisit aucun. */
  test('le dépôt de tests se règle, se relit, et un dépôt inconnu est refusé', async () => {
    const pose = await app.api('PUT', '/api/config', { test_repo: 'gitlab/grp/tests' });
    assert.equal(pose.status, 200, JSON.stringify(pose.body));
    assert.equal((await app.api('GET', '/api/config')).body.test_repo, 'gitlab/grp/tests');
    const inconnu = await app.api('PUT', '/api/config', { test_repo: 'gitlab/grp/nulle-part' });
    assert.equal(inconnu.status, 400);
    assert.match(inconnu.body.error, /nulle-part/);
    assert.equal((await app.api('GET', '/api/config')).body.test_repo, 'gitlab/grp/tests', 'le refus ne touche à rien');
    await app.api('PUT', '/api/config', { test_repo: '' });
    assert.equal((await app.api('GET', '/api/config')).body.test_repo, '');
  });

  test('sans réglage, plusieurs candidats : aucun choix au hasard ; réglé, c’est lui — couvert et hors de la session', async () => {
    // eslint-disable-next-line global-require
    const { depotTests } = require('../src/jobs/chaine-scenario');
    const couverture = (ids) => () => new Map(ids.map((id) => [id, {}]));
    const session = [{ repo_id: repoId }];
    assert.equal(depotTests(vTests, session, couverture([repoId, testsId])).repo.id, testsId, 'un seul candidat : déduit');
    const ambigu = depotTests(vTests, session, couverture([repoId, testsId, autreId]));
    assert.match(ambigu.erreur, /plusieurs dépôts/);
    assert.match(ambigu.erreur, /grp\/autre/);
    await app.api('PUT', '/api/config', { test_repo: 'gitlab/grp/tests' });
    try {
      assert.equal(depotTests(vTests, session, couverture([repoId, autreId, testsId])).repo.id, testsId, 'le réglage tranche');
      assert.match(depotTests(vTests, session, couverture([repoId, autreId])).erreur, /ne couvre pas le dépôt de tests/);
      assert.match(depotTests(vTests, [{ repo_id: testsId }], couverture([testsId])).erreur, /un des dépôts de la session/);
    } finally { await app.api('PUT', '/api/config', { test_repo: '' }); }
  });

  test('un vérificateur des scénarios qui couvre deux dépôts hors de la session écrit dans le dépôt de tests réglé', async () => {
    vider();
    const vMulti = (await app.api('POST', '/api/verifiers', {
      name: 'scenarios-multi', kind: 'commands', commands: [path.join(bin, 'scenarios.sh')], timeout_s: 60, run_base: 0,
      repos: [{ repo_id: autreId, mode: 'worktree' }, { repo_id: testsId, mode: 'worktree' }],
    })).body.id;
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'scénario multi', auto_push: true, verify_chain: [vApp], verify_chain_scenario: { verifier_id: vMulti },
      targets: [{ repo_id: repoId, branch: 'ai/chaine-multi' }],
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    await app.api('PUT', '/api/config', { test_repo: 'gitlab/grp/tests' });
    try {
      await app.api('POST', `/api/tasks/${t.body.id}/run`);
      const c = await finie(t.body.id);
      assert.equal(c.status, 'validated', JSON.stringify(c));
      const fichier = `scenarios/nouveau-${t.body.id}.sh`;
      assert.match(execFileSync('git', ['show', `ai/chaine-multi:${fichier}`], { cwd: tests.bare }).toString(), /scénario dry-run/,
        'écrit dans le dépôt de tests réglé');
      assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'ai/chaine-multi'], { cwd: autre.bare, stdio: 'pipe' }),
        'rien dans l’autre dépôt couvert');
    } finally { await app.api('PUT', '/api/config', { test_repo: '' }); }
  });

  test('un même vérificateur ne tourne jamais deux fois en même temps', async () => {
    // eslint-disable-next-line global-require
    const file = require('../src/jobs/file');
    const ligne = (verifierId, repo) => app.db.prepare(`INSERT INTO verification (verifier_id, verifier_name, status, targets_json, created_at)
      VALUES (?, 'x', 'done', ?, ?)`).run(verifierId, JSON.stringify([{ repo_id: repo }]), new Date().toISOString()).lastInsertRowid;
    const a = file.jobKeys({ kind: 'verify', verificationId: ligne(vTests, testsId) });
    const b = file.jobKeys({ kind: 'verify', verificationId: ligne(vTests, repoId) });
    const autre = file.jobKeys({ kind: 'verify', verificationId: ligne(vApp, 99) });
    assert.equal(file.keysClash(a, b), true, 'même vérificateur, dépôts différents : il attend');
    assert.equal(file.keysClash(a, autre), false, 'un autre vérificateur sur un autre dépôt tourne en même temps');
  });

  test('sans auto-push la chaîne tombe ; une exploration n’en a pas', async () => {
    const t = await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'p', auto_push: false, verify_chain: [vApp], targets: [{ repo_id: repoId, branch: 'ai/x' }] });
    assert.equal(t.body.verify_chain, null);
    const e = await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'q', auto_push: true, verify_chain: [vApp], targets: [{ repo_id: repoId, branch: 'main' }] });
    assert.equal(e.body.verify_chain, null);
    const avec = (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'p', auto_push: true, verify_chain: [vApp, 99999], targets: [{ repo_id: repoId, branch: 'ai/y' }] })).body;
    assert.equal(avec.verify_chain, JSON.stringify([vApp]), 'un vérificateur inconnu est ignoré');
    assert.equal((await app.api('PUT', `/api/tasks/${avec.id}`, { auto_push: false })).body.verify_chain, null, 'retirer l’auto-push retire la chaîne');
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('la fenêtre compose la chaîne dans l’ordre coché, l’édition la relit, la carte la montre', async () => {
      await page.locator('#btnNewTask').click();
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.locator(`#taskChaineList .task-chaine-pick[value="${vApp}"]`).waitFor();
      await page.fill('#taskChaineFiltre', 'unit');
      assert.equal(await page.locator(`#taskChaineList .task-chaine-row:has([value="${vTests}"])`).isHidden(), true, 'le filtre cache');
      await page.fill('#taskChaineFiltre', '');
      await page.locator(`#taskChaineList .task-chaine-pick[value="${vApp}"]`).check();
      await page.locator(`#taskChaineList .task-chaine-pick[value="${vTests}"]`).check();
      assert.match(await page.locator(`#taskChaineList .task-chaine-row:has([value="${vTests}"]) .task-chaine-rang`).textContent(), /2\./);
      assert.equal(await page.locator('#taskForm [name="auto_push"]').isChecked(), true, 'la chaîne coche l’auto-push');
      assert.equal(await page.locator('#taskVerifier').isHidden(), true, 'elle remplace « Vérifier après »');
      // Le skill de diagnostic : ceux du dépôt de tests, que couvre un vérificateur coché.
      await page.locator('#taskChaineSkillRow:not([hidden])').waitFor();
      await page.locator(`#taskChaineSkill option[value="${testsId}:diag-verif"]`).waitFor({ state: 'attached' });
      await page.selectOption('#taskChaineSkill', `${testsId}:diag-verif`);
      // Étape 3 : le scénario de couverture, son vérificateur (parmi les cochés) et son skill.
      await page.locator('#taskChaineScen').check();
      await page.locator('#taskChaineScenBox:not([hidden])').waitFor();
      await page.locator(`#taskChaineScenVerif option[value="${vTests}"]`).waitFor({ state: 'attached' });
      await page.selectOption('#taskChaineScenVerif', String(vTests));
      await page.selectOption('#taskChaineScenSkill', `${testsId}:scen-couvert`);
      await page.fill('#taskForm [name="prompt"]', 'session chaîne écran');
      const avant = (await app.api('GET', '/api/tasks')).body.length;
      await page.evaluate((id) => { renderTargetRows([{ repo_id: id, branch: 'ai/ecran' }]); }, repoId);
      await page.locator('#taskSubmit').click();
      await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.length === avant + 1, 'la session est créée');
      const cree = (await app.api('GET', '/api/tasks')).body.find((x) => x.prompt === 'session chaîne écran');
      assert.equal(cree.verify_chain, JSON.stringify([vApp, vTests]));
      assert.deepEqual(JSON.parse(cree.verify_chain_skill), { name: 'diag-verif', repo_id: testsId });
      assert.deepEqual(JSON.parse(cree.verify_chain_scenario), { verifier_id: vTests, skill: { name: 'scen-couvert', repo_id: testsId } });
      // L'édition relit la chaîne, dans son ordre.
      await page.waitForSelector('#taskModal', { state: 'hidden' });
      await page.evaluate((id) => openTaskEdit(id), cree.id);
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.locator(`#taskChaineList .task-chaine-pick[value="${vTests}"]:checked`).waitFor({ state: 'attached' });
      assert.match(await page.locator(`#taskChaineList .task-chaine-row:has([value="${vApp}"]) .task-chaine-rang`).textContent(), /1\./);
      assert.match(await page.locator(`#taskChaineList .task-chaine-row:has([value="${vTests}"]) .task-chaine-rang`).textContent(), /2\./);
      await page.waitForFunction((v) => document.querySelector('#taskChaineSkill').value === v, `${testsId}:diag-verif`);
      assert.equal(await page.locator('#taskChaineScen').isChecked(), true, 'l’édition relit le scénario');
      await page.waitForFunction((v) => document.querySelector('#taskChaineScenSkill').value === v, `${testsId}:scen-couvert`);
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal', { state: 'hidden' });
      assert.deepEqual(erreurs, []);
    });

    test('la carte montre la chaîne, vérificateur par vérificateur, et « Relancer » quand elle attend', async () => {
      // La session créée par la fenêtre a pu partir : sa chaîne doit être finie avant de truquer les scripts.
      await waitForJobs(app.api);
      for (const x of (await app.api('GET', '/api/tasks')).body) if (x.chaine) await finie(x.id);
      vider();
      echouer('unitaires', 'base', 2);
      const id = await session('ai/chaine-carte', [vApp]);
      await finie(id);
      /* Un rechargement de fond parti AVANT la fin de la chaîne peut finir après le nôtre et réécrire la
         carte d'avant : on recharge jusqu'à voir l'état que le serveur tient. */
      const carte = page.locator(`.task-chaine[data-chaine-task="${id}"]`);
      const voir = (sel) => attendreServeur(async () => {
        await page.evaluate(() => loadTasks());
        return (await page.locator(sel).count()) > 0;
      }, `la carte montre ${sel}`);
      await voir(`.task-chaine[data-chaine-task="${id}"] .task-chaine-cote.is-broken`);
      assert.match(await carte.textContent(), /unitaires/);
      vider();
      // La liste se redessine pendant les jobs (l'animation d'entrée rend le bouton « instable ») : clic direct.
      await carte.locator(`[data-chaine-relancer="${id}"]`).dispatchEvent('click');
      const c = await finie(id);
      assert.equal(c.status, 'passed');
      await voir(`.task-chaine.is-passed[data-chaine-task="${id}"]`);
      assert.deepEqual(erreurs, []);
    });

    test('la carte d’une tâche validée dit par quel scénario existant son code est couvert', async () => {
      vider();
      const t = (await app.api('POST', '/api/tasks', {
        kind: 'code', prompt: 'carte validée', auto_push: true, verify_chain: [vApp],
        verify_chain_scenario: { verifier_id: vTests, skill: { name: 'scen-couvert', repo_id: testsId } },
        targets: [{ repo_id: repoId, branch: 'ai/carte-validee' }],
      })).body;
      await app.api('POST', `/api/tasks/${t.id}/run`);
      assert.equal((await finie(t.id)).status, 'validated');
      await attendreServeur(async () => {
        await page.evaluate(() => loadTasks());
        return (await page.locator(`.task-chaine.is-validated[data-chaine-task="${t.id}"] .task-chaine-scenario`).count()) > 0;
      }, 'la carte montre la tâche validée');
      assert.match(await page.locator(`.task-chaine[data-chaine-task="${t.id}"] .task-chaine-scenario`).textContent(), /scenarios\/existant\.sh/);
      assert.deepEqual(erreurs, []);
    });

    test('la carte dit ce que le diagnostic a conclu, avec sa preuve', async () => {
      vider();
      echouer('unitaires', 'head', 9);
      fs.writeFileSync(path.join(bin, 'cause'), 'DRYRUN_CAUSE=instable');
      const id = await session('ai/chaine-carte-diag', [vApp]);
      await finie(id);
      fs.unlinkSync(path.join(bin, 'cause'));
      await attendreServeur(async () => {
        await page.evaluate(() => loadTasks());
        return (await page.locator(`.task-chaine[data-chaine-task="${id}"] .task-chaine-diag.is-instable`).count()) > 0;
      }, 'la carte montre le diagnostic');
      assert.match(await page.locator(`.task-chaine[data-chaine-task="${id}"] .task-chaine-preuve`).textContent(), /simulé/);
      assert.deepEqual(erreurs, []);
    });

    test('Réglages → Vérificateurs : le dépôt de tests se choisit dans une liste filtrable, s’enregistre et se relit', async () => {
      const ouvrir = async () => {
        await page.reload();
        await page.locator('nav button[data-tab="admin"]').click();
        await page.locator('#tab-admin .subnav [data-sub="verifiers"]').click();
        await page.waitForSelector('#sub-verifiers.active');
      };
      await ouvrir();
      const champ = page.locator('#testRepoBox .cb-search');
      await champ.click();
      await champ.fill('tests');
      await page.locator('#testRepoBox .combo-opt[data-v="gitlab/grp/tests"]').click();
      await page.locator('#sub-verifiers button[type="submit"][form="configForm"]').last().click();
      try {
        await attendreServeur(async () => (await app.api('GET', '/api/config')).body.test_repo === 'gitlab/grp/tests', 'le dépôt de tests est enregistré');
        await ouvrir();
        await page.waitForFunction(() => document.querySelector('#testRepoBox .cb-search').value === 'grp/tests');
      } finally { await app.api('PUT', '/api/config', { test_repo: '' }); }
      assert.deepEqual(erreurs, []);
    });
  });
});
