'use strict';
/* LES TESTS ÉCRITS À LA FIN DE LA CHAÎNE DE VALIDATION (`jobs/chaine-scenario.js`, étape 3 de `jobs/chaine-verif.js`).
 *
 * Sur de vrais dépôts : l'application (zone Session) et un dépôt de tests séparé (zone Tests), suivi par le faux
 * GitLab. Le vérificateur des tests couvre le CLONE LOCAL de l'utilisateur « en place » : il joue le dossier `tests/`
 * et devient rouge si un fichier `ROUGE-…` y est. L'agent est le dry-run : il écrit dans la zone que le scénario
 * attendu demande (`DRYRUN_TESTS=…`, `DRYRUN_ROUGE=…`, `DRYRUN_COUVERT…`).
 *
 *   1. la consigne : son format, ses sources, ses fuites — elle n'est lue qu'à l'étape tests ;
 *   2. l'écriture : zone Tests (une passe dans un worktree de Mergerie, branche poussée, merge request en
 *      brouillon, prête une fois vert ; le clone de l'utilisateur jamais touché), zone Session (commit poussé
 *      dans la MR), les deux, deux dépôts de tests, aucun dépôt de tests réglé, forge non configurée ou branche
 *      étrangère (« À toi », rien poussé), push ou MR refusés (« À toi », « Relancer » repart), JSON invalide, « déjà couvert » contrôlé, test existant modifié, skills listés sans être
 *      recopiés ;
 *   3. le rejeu : tous les vérificateurs, côté branche, jamais la base ; rouge → correction → rejeu ; rouge
 *      après deux corrections → « À toi », la MR reste en brouillon ; du code touché à cette étape, dit ; deux
 *      sessions en parallèle — chacune sa branche et sa MR, leurs tests sur le dépôt de tests l'un après l'autre,
 *      une vérification lancée à la main refusée pendant ce temps, ou qui fait attendre la chaîne ; arrêt et redémarrage en cours d'étape ;
 *   4. l'écran : la fenêtre, la carte, la frise. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, poserIdentiteGit, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

describe('Les tests écrits à la fin de la chaîne', () => {
  let app; let appR; let testsR; let repoId; let testsId; let cloneTests; let cloneApp; let bin; let vTests; let vApp; let vLint; let vTestsBis; let tests2R; let vTests2;

  before(async () => {
    app = await startApp();
    await app.configure();
    appR = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    testsR = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'tests-')));
    // Le dépôt de tests : un test existant, et un skill pour écrire les siens (son corps ne doit jamais être recopié).
    fs.mkdirSync(path.join(testsR.work, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(testsR.work, 'tests/existant.test.sh'), '#!/bin/sh\nexit 0\n');
    fs.mkdirSync(path.join(testsR.work, '.claude/skills/ecrire-tests'), { recursive: true });
    fs.writeFileSync(path.join(testsR.work, '.claude/skills/ecrire-tests/SKILL.md'),
      '---\nname: ecrire-tests\ndescription: Écrire un test e2e\n---\nCORPS-DU-SKILL-JAMAIS-RECOPIE\n');
    g(testsR.work, 'add', '-A'); g(testsR.work, 'commit', '-qm', 'tests'); g(testsR.work, 'push', '-q', 'origin', 'main');
    repoId = (await app.api('POST', '/api/repos', { url: appR.url, project: 'grp/app' })).body.id;
    testsId = (await app.api('POST', '/api/repos', { url: testsR.url, project: 'grp/tests' })).body.id;
    // Les clones LOCAUX de l'utilisateur : l'application (lue en position) et le dépôt de tests (couvert en place).
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-racine-'));
    cloneApp = path.join(racine, 'app');
    cloneTests = path.join(racine, 'tests');
    execFileSync('git', ['clone', '-q', appR.url, cloneApp], { stdio: 'pipe' });
    execFileSync('git', ['clone', '-q', testsR.url, cloneTests], { stdio: 'pipe' });
    poserIdentiteGit(cloneTests);
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine })).status, 200);
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-bin-'));
    /* Le vérificateur joue `tests/` : rouge si un `ROUGE-…` y est. Il note sa branche, son commit et ce qu'il voit, et
       l'heure de son début et de sa fin (`pas-<nom>`) ; `bloque-<nom>` le retient tant que le fichier existe,
       `fail-<nom>` le fait échouer N fois, `failhead-<nom>` seulement côté branche (le commit de la session porte
       PROJ_TASK_DRYRUN.md). */
    const script = (nom) => {
      const p = path.join(bin, `${nom}.sh`);
      fs.writeFileSync(p, `#!/bin/sh
echo "debut $(node -e 'process.stdout.write(String(Date.now()))')" >> '${bin}/pas-${nom}'
i=0; while [ -f '${bin}/bloque-${nom}' ] && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done
liste=$(ls tests 2>/dev/null | tr '\\n' ' ')
echo "$(git rev-parse --abbrev-ref HEAD) $(git rev-parse --short HEAD) | $liste" >> '${bin}/trace-${nom}'
echo "fin $(node -e 'process.stdout.write(String(Date.now()))')" >> '${bin}/pas-${nom}'
f='${bin}/fail-${nom}'; n=$(cat "$f" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n-1)) > "$f"; exit 1; fi
if [ -f PROJ_TASK_DRYRUN.md ]; then f='${bin}/failhead-${nom}'; n=$(cat "$f" 2>/dev/null || echo 0)
  if [ "$n" -gt 0 ]; then echo $((n-1)) > "$f"; echo 'DRYRUN_CAUSE=branche'; exit 1; fi; fi
if echo "$liste" | grep -q ROUGE; then echo "test rouge : $liste"; exit 1; fi
exit 0
`, { mode: 0o755 });
      return p;
    };
    const creerV = async (nom, repos) => {
      const r = await app.api('POST', '/api/verifiers', { name: nom, kind: 'commands', commands: [script(nom)], timeout_s: 180, run_base: 0, repos });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.id;
    };
    vTests = await creerV('tests-e2e', [{ repo_id: testsId, mode: 'in_place', workdir: cloneTests, checkout_allowed: true }]);
    vApp = await creerV('unitaires', [{ repo_id: repoId, mode: 'worktree' }]);
    vLint = await creerV('lint', [{ repo_id: repoId, mode: 'worktree' }]);
    // Hors de toute chaîne : un autre vérificateur du dépôt de tests, lancé à la main.
    vTestsBis = await creerV('tests-bis', [{ repo_id: testsId, mode: 'worktree' }]);
    // Un second dépôt de tests, surcharge d'un vérificateur qui n'est que dans les chaînes qui le demandent.
    tests2R = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'tests2-')));
    const tests2Id = (await app.api('POST', '/api/repos', { url: tests2R.url, project: 'grp/tests2' })).body.id;
    vTests2 = await creerV('tests-deux', [{ repo_id: tests2Id, mode: 'worktree' }]);
    assert.equal((await app.api('PUT', `/api/verifiers/${vTests2}`, { test_repo: 'gitlab/grp/tests2' })).status, 200);
    await app.api('PUT', '/api/config', { test_repo: 'gitlab/grp/tests' });
  });
  after(async () => { if (app) await app.stop(); });

  const trace = (nom) => { try { return fs.readFileSync(path.join(bin, `trace-${nom}`), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const vider = () => { for (const f of fs.readdirSync(bin)) if (/^(trace|fail|failhead|bloque|pas)-/.test(f)) fs.unlinkSync(path.join(bin, f)); };
  const chaine = async (id) => (await app.api('GET', `/api/tasks/${id}/chaine`)).body;
  async function finie(id) {
    await attendreServeur(async () => { const c = await chaine(id); return c && !['running'].includes(c.status); }, 'la chaîne s’arrête', 180000);
    await waitForJobs(app.api);
    await attendreServeur(async () => { const c = await chaine(id); return c && c.status !== 'running'; }, 'la chaîne reste arrêtée', 180000);
    return chaine(id);
  }
  async function session(branche, attendu, { chain = [vTests, vApp, vLint], source = 'saisi' } = {}) {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: `tests ${branche}`, auto_push: true, verify_chain: chain,
      verify_chain_scenario: { actif: true, attendu, attendu_source: source }, targets: [{ repo_id: repoId, branch: branche }],
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    await app.api('POST', `/api/tasks/${t.body.id}/run`);
    return t.body.id;
  }
  const passes = (id, motif) => app.db.prepare('SELECT prompt FROM agent_pass WHERE task_id = ? ORDER BY id').all(id).map((p) => p.prompt || '').filter((p) => !motif || motif.test(p));
  const ESCRIRE = /test: écrire les tests/;
  // Ce que les passes du dépôt de tests ont rendu, dans l'ordre : la consigne envoyée, le texte, le commit, la MR.
  const sorties = (id) => {
    const dir = path.join(app.dataDir, 'tasks', String(id), 'tests-pass');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
  };
  const worktree = (id) => path.join(app.dataDir, 'scenario-tests', `task-${id}`, 'grp-tests');
  const distante = (branche) => g(testsR.bare, 'branch', '--list', branche);
  const mrsTests = () => (app.state.mrs['grp/tests'] || []);
  const mrDe = (branche) => mrsTests().find((m) => m.source_branch === branche);
  const depotTests = (c) => c.scenario.depots.find((x) => x.zone === 'tests');
  // Les lancements de la chaîne créés depuis un instant : le rejeu de l'étape tests.
  const lancementsDepuis = (id, at) => app.db.prepare(`SELECT v.* FROM verification v JOIN verif_chaine c ON c.id = v.chaine_id
    WHERE c.task_id = ? AND v.created_at >= ? ORDER BY v.id`).all(id, at);
  const debutEtape = (id) => (app.db.prepare('SELECT created_at FROM agent_pass WHERE task_id = ? AND prompt LIKE ? ORDER BY id LIMIT 1').get(id, '%test: écrire les tests%') || {}).created_at;
  const etapesCockpit = async (id) => Object.values((await app.api('GET', '/api/cockpit')).body).flat().find((l) => l && l.task_id === id).workflow.etapes;

  /* ---------------- lot 1 : la consigne ---------------- */

  test('le format : le scénario attendu, sa source ; l’ancien format se lit comme coché sans consigne', () => {
    // eslint-disable-next-line global-require
    const { normaliserScenario } = require('../src/jobs/chaine-scenario');
    assert.equal(normaliserScenario({ actif: true, attendu: '  un parcours\r\nsur deux lignes  ', attendu_source: 'jira' }),
      JSON.stringify({ actif: true, attendu: 'un parcours\nsur deux lignes', attendu_source: 'jira' }));
    assert.equal(normaliserScenario({ actif: true, attendu: 'x', attendu_source: 'nimporte' }), JSON.stringify({ actif: true, attendu: 'x', attendu_source: 'saisi' }));
    assert.equal(normaliserScenario({ verifier_id: vTests, skill: { name: 'a', repo_id: testsId } }), JSON.stringify({ actif: true, attendu: null, attendu_source: null }));
    assert.equal(normaliserScenario(JSON.stringify({ verifier_id: 999 })), JSON.stringify({ actif: true, attendu: null, attendu_source: null }));
    assert.equal(JSON.parse(normaliserScenario({ actif: true, attendu: 'a'.repeat(5000) })).attendu.length, 4000);
    for (const vide of [null, '', false, { actif: false }]) assert.equal(normaliserScenario(vide), null);
  });

  test('le ticket : `&&?` du commentaire #tech l’emporte, entier ; ni `&&?` ni `&&>` ne restent dans aucun contexte', () => {
    // eslint-disable-next-line global-require
    const jira = require('../src/integrations/jira');
    const issue = {
      summary: 'Devis',
      descriptionMd: 'Contexte.\n&&? SENTINELLE-DESCRIPTION\n&&> demande de la description',
      techMd: 'Note.\n&&? SENTINELLE-TECH ligne 1\n&&? ligne 2\n&&> demande du tech',
    };
    const d = jira.demandeTicket(issue);
    assert.equal(d.attendu, 'SENTINELLE-TECH ligne 1\nligne 2');
    assert.equal(d.demande, 'demande du tech');
    assert.doesNotMatch(d.context, /SENTINELLE|&&\?|&&>|demande de/);
    assert.match(d.context, /Contexte\.[\s\S]*Note\./);
    // Le contexte d'une review ou d'une convergence passe par la même fonction : rien n'y reste non plus.
    assert.doesNotMatch(jira.issueToContext(issue), /SENTINELLE|&&\?|&&>/);
    assert.equal(jira.demandeTicket({ summary: 's', descriptionMd: '&&? seule la description', techMd: '' }).attendu, 'seule la description');
    // La demande envoyée à l'agent : une ligne `&&?` part entière.
    // eslint-disable-next-line global-require
    const JETONSRT = require('../public/runtime/jetons-runtime.js');
    assert.equal(JETONSRT.retirerJetonsDepots('Fais-le\n&&? SENTINELLE\nfin'), 'Fais-le\n\nfin');
  });

  test('un modèle récurrent enregistré avec un scénario attendu ne le garde pas', async () => {
    const r = await app.api('POST', '/api/recurrences', {
      kind: 'code', prompt: 'Chaque matin', label: 'Récurrent', auto_push: true, schedule: 'daily 06:00',
      verify_chain: [vApp], verify_chain_scenario: { actif: true, attendu: 'SENTINELLE-RECURRENCE' },
      targets: [{ repo_id: repoId, branch: 'ai/recurrent-{date}', base_branch: 'main' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const payload = app.db.prepare('SELECT payload_json FROM recurrence WHERE id = ?').get(r.body.id).payload_json;
    assert.doesNotMatch(payload, /SENTINELLE-RECURRENCE/);
    await app.api('DELETE', `/api/recurrences/${r.body.id}`);
  });

  /* ---------------- lot 2 et 3 : écrire, rejouer, corriger ---------------- */

  test('zone Tests : une passe dans un worktree de Mergerie, branche poussée, MR en brouillon ; trois vérificateurs rejoués côté branche ; vert → MR prête ; le clone de l’utilisateur jamais sur la branche', async () => {
    vider();
    const origine = g(testsR.bare, 'rev-parse', 'main');
    const id = await session('ai/ct-tests', 'DRYRUN_TESTS=tests SENTINELLE-ATTENDU-1');
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    assert.equal(c.scenario.final, 'vert');
    // La branche est sur la forge, au-dessus de la branche par défaut, avec le test ; le worktree est celui de Mergerie.
    assert.equal(distante('ai/ct-tests').trim(), 'ai/ct-tests');
    assert.equal(g(testsR.bare, 'rev-parse', 'ai/ct-tests~1'), origine, 'la branche part de la branche par défaut');
    assert.match(g(testsR.bare, 'show', '--name-only', '--format=', 'ai/ct-tests'), new RegExp(`tests/scenario-${id}\\.test\\.sh`));
    assert.equal(g(worktree(id), 'rev-parse', '--abbrev-ref', 'HEAD'), 'ai/ct-tests');
    // Le clone de l'utilisateur : revenu sur main, propre, sans branche de la session.
    assert.equal(g(cloneTests, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(g(cloneTests, 'status', '--porcelain'), '');
    assert.doesNotMatch(g(cloneTests, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), /ai\/ct-tests/);
    // La MR : ouverte en brouillon vers main, prête une fois le rejeu vert.
    const mr = mrDe('ai/ct-tests');
    assert.ok(mr, 'une MR dans le dépôt de tests');
    assert.equal(mr.target_branch, 'main');
    await attendreServeur(async () => depotTests(await chaine(id)).mr_pret === true, 'la MR passe prête');
    assert.equal(mr.draft, false);
    assert.doesNotMatch(mr.title, /^Draft:/);
    assert.match(mr.title, new RegExp(`#${id}`));
    const d = depotTests(await chaine(id));
    assert.deepEqual([d.ajoutes, d.branche, d.mr_iid, d.mr_url], [[`tests/scenario-${id}.test.sh`], 'ai/ct-tests', mr.iid, mr.web_url]);
    // Le rejeu : un lancement par vérificateur, rattaché à la chaîne, côté branche — jamais la base.
    const rejeu = lancementsDepuis(id, debutEtape(id));
    assert.deepEqual(rejeu.map((v) => v.verifier_id).sort(), [vTests, vApp, vLint].sort(), 'trois lancements');
    assert.ok(rejeu.every((v) => !JSON.parse(v.targets_json).some((x) => x.base_sha)), 'aucun côté base');
    const sha = g(testsR.bare, 'rev-parse', '--short', 'ai/ct-tests');
    assert.ok(trace('tests-e2e').some((l) => l.includes(` ${sha} |`) && l.includes(`scenario-${id}`)), 'le vérificateur a vu le test, au commit poussé');
    assert.deepEqual(c.scenario.rejeu.map((r) => r.etat), ['pass', 'pass', 'pass']);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM todo WHERE auto_kind = 'scen_push'").get().n, 0, 'plus de todo de push');
    // La passe de la session : le scénario attendu, ses dépôts, et l'annonce de la passe du dépôt de tests.
    const consigne = passes(id, ESCRIRE)[0];
    assert.ok(consigne, 'une passe d’écriture de la session');
    assert.match(consigne, /SENTINELLE-ATTENDU-1/);
    assert.match(consigne, /dépôts de tests séparés \(grp\/tests\)/);
    assert.ok(!consigne.includes(worktree(id)), 'la session n’écrit pas dans le dépôt de tests');
    // La passe du dépôt de tests : son worktree, le scénario, les skills nommés — jamais leur corps —, le changement de la session.
    const [s1] = sorties(id);
    assert.ok(s1 && s1.prompt, 'une passe du dépôt de tests');
    assert.ok(s1.prompt.includes(`- grp/tests : ${worktree(id)} (tests)`));
    assert.match(s1.prompt, /SENTINELLE-ATTENDU-1/);
    assert.match(s1.prompt, /ecrire-tests \(grp\/tests\) : Écrire un test e2e — .*\.claude\/skills\/ecrire-tests\/SKILL\.md/);
    assert.doesNotMatch(s1.prompt, /CORPS-DU-SKILL-JAMAIS-RECOPIE/);
    assert.match(s1.prompt, /<<<DONNEE [0-9a-f]+ Le changement de la session \(diff depuis sa base\)>>>[\s\S]*grp\/app · ai\/ct-tests[\s\S]*PROJ_TASK_DRYRUN\.md/);
    assert.deepEqual([s1.pousse, s1.erreur], [true, null]);
    // Aucune autre passe ne l'a vue : ni le codage, ni rien d'autre.
    assert.deepEqual(passes(id).filter((p) => !ESCRIRE.test(p) && /SENTINELLE-ATTENDU-1/.test(p)), []);
    // La frise : écrire (la zone Tests, avec sa MR), un rejeu par vérificateur, et « MR de tests prête » sur l'arrivée.
    const e = await etapesCockpit(id);
    assert.deepEqual(e.filter((x) => x.cle === 'scen-ecrire').map((x) => [x.zone, x.projet, x.compte.ajoutes, x.mr && x.mr.pret]), [['tests', 'grp/tests', 1, true]]);
    assert.deepEqual(e.filter((x) => x.cle === 'scen-rejouer').map((x) => `${x.nom}:${x.etat}`), ['tests-e2e:fait', 'unitaires:fait', 'lint:fait']);
    assert.equal(e.at(-1).mr_tests, 'prete');
    // Le retour de l'agent du dépôt de tests se relit dans la vue de diff.
    assert.match((await app.api('GET', `/api/tasks/${id}/chaine/tests/${testsId}/output`)).body.output, /Tests écrits \(dry-run\)/);
  });

  test('zone Session : le commit de tests part dans la branche de la session, la MR se met à jour — aucune nouvelle MR ; un dépôt de tests réglé qui est un dépôt de la session y est traité', async () => {
    vider();
    await app.api('PUT', '/api/config', { test_repo: 'gitlab/grp/app' });
    try {
      const mrsAvant = Object.values(app.state.mrs || {}).flat().length;
      const id = await session('ai/ct-session', 'DRYRUN_TESTS=session', { chain: [vApp, vLint] });
      const c = await finie(id);
      assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
      assert.match(g(appR.bare, 'show', '--name-only', '--format=%s', 'ai/ct-session'), new RegExp(`tests/scenario-${id}\\.test\\.sh`), 'poussé sur la branche de la session');
      assert.equal(Object.values(app.state.mrs || {}).flat().length, mrsAvant, 'aucune nouvelle MR');
      assert.deepEqual(c.scenario.depots.map((d) => d.zone), ['session']);
      assert.deepEqual(sorties(id), [], 'pas de passe de dépôt de tests');
      // Sans réglage du tout, l'étape tourne de même, en zone Session.
      // eslint-disable-next-line global-require
      const { apercuDepots } = require('../src/jobs/chaine-scenario');
      assert.deepEqual(apercuDepots([vApp], [repoId]).depots, []);
    } finally { await app.api('PUT', '/api/config', { test_repo: 'gitlab/grp/tests' }); }
  });

  test('les deux zones : chaque passe écrit dans son dossier, chaque dépôt suit sa règle', async () => {
    vider();
    const id = await session('ai/ct-deux', 'DRYRUN_TESTS=deux');
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    assert.deepEqual(c.scenario.depots.map((d) => d.zone).sort(), ['session', 'tests']);
    assert.match(g(appR.bare, 'show', '--name-only', '--format=', 'ai/ct-deux'), /tests\/scenario-/);
    assert.match(g(testsR.bare, 'show', '--name-only', '--format=', 'ai/ct-deux'), /tests\/scenario-/);
    assert.ok(mrDe('ai/ct-deux'), 'la MR du dépôt de tests');
  });

  test('une branche du même nom sur la forge du dépôt de tests, que la session n’a pas créée : « À toi », rien poussé ni ouvert', async () => {
    vider();
    g(testsR.work, 'push', '-q', 'origin', 'main:refs/heads/ai/ct-etrangere');
    const avant = g(testsR.bare, 'rev-parse', 'ai/ct-etrangere');
    const id = await session('ai/ct-etrangere', 'DRYRUN_TESTS=tests');
    const c = await finie(id);
    assert.equal(c.status, 'attention');
    assert.match(c.scenario.erreur, /ai\/ct-etrangere[\s\S]*grp\/tests/);
    assert.equal(g(testsR.bare, 'rev-parse', 'ai/ct-etrangere'), avant, 'la branche de quelqu’un d’autre n’a pas bougé');
    assert.equal(mrDe('ai/ct-etrangere'), undefined);
  });

  test('un dépôt de tests dont la forge n’est pas configurée : la fenêtre le dit, l’étape s’arrête avant d’écrire', async () => {
    const gh = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'gh-')));
    const ghId = (await app.api('POST', '/api/repos', { url: gh.url, project: 'gh/tests', forge: 'github' })).body.id;
    const v = (await app.api('POST', '/api/verifiers', { name: 'gh-e2e', kind: 'commands', commands: ['true'], run_base: 0,
      repos: [{ repo_id: ghId, mode: 'worktree' }], test_repo: 'github/gh/tests' })).body.id;
    // eslint-disable-next-line global-require
    const scen = require('../src/jobs/chaine-scenario');
    assert.deepEqual(scen.apercuDepots([v], [repoId]).depots.map((d) => [d.project, d.forge, d.forge_ok]), [['gh/tests', 'github', false]]);
    assert.deepEqual(scen.apercuDepots([vTests], [repoId]).depots.map((d) => [d.project, d.forge_ok]), [['grp/tests', true]]);
    const t = (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'forge', auto_push: true, verify_chain: [v],
      verify_chain_scenario: { actif: true }, targets: [{ repo_id: repoId, branch: 'ai/ct-forge' }] })).body;
    const r = await scen.preparer(app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id), {});
    assert.equal(r.cause, 'forge');
    assert.match(r.erreur, /gh\/tests[\s\S]*GitHub/);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'scenario-tests', `task-${t.id}`)), false, 'aucun worktree');
  });

  test('un JSON invalide : pas de rejeu, la session est reprise avec l’erreur — une correction, puis vert', async () => {
    vider();
    const id = await session('ai/ct-json', 'DRYRUN_TESTS=json-invalide', { chain: [vApp] });
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    assert.equal(c.scenario.corrections, 1);
    const correction = passes(id, /fix: tests rouges/)[0];
    assert.match(correction, /data-.*\.json/, 'la correction reçoit l’erreur d’analyse');
    // Le seul rejeu est celui d'après la correction : il a vu le JSON réparé.
    assert.ok(trace('unitaires').filter((l) => l.includes('data-')).length >= 1);
    assert.equal(lancementsDepuis(id, debutEtape(id)).length, 1, 'un seul rejeu, après la correction');
  });

  test('« déjà couvert » : le test cité est trouvé sur disque, rien ne change, pas de rejeu ni de MR — validée', async () => {
    vider();
    const id = await session('ai/ct-couvert', 'DRYRUN_COUVERT');
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    assert.equal(c.scenario.final, 'couvert');
    assert.deepEqual(c.scenario.couvert.par, [{ project: 'grp/tests', chemin: 'tests/existant.test.sh' }]);
    assert.match(c.scenario.couvert.raison, /déjà couvert/);
    assert.equal(lancementsDepuis(id, debutEtape(id)).length, 0, 'aucun rejeu');
    assert.equal(distante('ai/ct-couvert'), '', 'rien poussé');
    assert.equal(mrDe('ai/ct-couvert'), undefined, 'aucune MR');
    const e = await etapesCockpit(id);
    assert.deepEqual(e.filter((x) => x.cle === 'scen-rejouer').map((x) => x.etat), ['saute', 'saute', 'saute']);
  });

  test('« déjà couvert » d’un test absent : reprise une fois, puis « À toi » ; un chemin qui sort du dépôt est refusé', async () => {
    vider();
    let id = await session('ai/ct-absent', 'DRYRUN_COUVERT_ABSENT');
    let c = await finie(id);
    assert.equal(c.status, 'attention');
    assert.equal(c.scenario.corrections, 1);
    assert.match(passes(id, /fix: tests rouges/)[0], /absent-.*n’existe pas/);
    id = await session('ai/ct-sortie', 'DRYRUN_COUVERT_CHEMIN=../x');
    c = await finie(id);
    assert.equal(c.status, 'attention');
    assert.match(passes(id, /fix: tests rouges/)[0], /« grp\/tests:\.\.\/x »|«\s*\.\.\/x\s*»/);
    // eslint-disable-next-line global-require
    const { cheminSur } = require('../src/jobs/chaine-scenario');
    for (const mauvais of ['../x', '/etc/passwd', 'a/../../x', '.git/config', '']) assert.equal(cheminSur(mauvais), null, mauvais);
    assert.equal(cheminSur('./tests/a.sh'), 'tests/a.sh');
  });

  test('un test existant modifié : compté dans « modifiés », classé test', async () => {
    vider();
    const id = await session('ai/ct-modifie', 'DRYRUN_TESTS=modifie-existant');
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    const d = c.scenario.depots.find((x) => x.zone === 'tests');
    assert.deepEqual([d.modifies, d.tests], [['tests/existant.test.sh'], ['tests/existant.test.sh']]);
  });

  test('un vérificateur rouge deux fois : les autres tournent quand même ; une correction ; les trois rejoués', async () => {
    vider();
    const id = await session('ai/ct-rouge', 'DRYRUN_TESTS=session DRYRUN_ROUGE=1');
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    assert.equal(c.scenario.corrections, 1);
    const rejeu = lancementsDepuis(id, debutEtape(id));
    const par = (vid) => rejeu.filter((v) => v.verifier_id === vid).length;
    // unitaires et lint jouent le `tests/` de l'application : rouge, rouge, puis vert ; tests-e2e (le dépôt de tests),
    // vert avant comme après — il a tourné malgré les rouges de ceux d'avant lui.
    assert.deepEqual([par(vApp), par(vTests), par(vLint)], [3, 2, 3], JSON.stringify(rejeu.map((v) => [v.verifier_id, v.verdict])));
    const correction = passes(id, /fix: tests rouges/)[0];
    assert.match(correction, /Vérificateur rouge : unitaires[\s\S]*Vérificateur rouge : lint/);
    assert.match(correction, /<<<DONNEE [0-9a-f]+ fin du journal du vérificateur>>>[\s\S]*test rouge/, `le journal, sous nonFiable :\n${correction.slice(-4000)}`);
    assert.deepEqual(c.scenario.code_modifie, [], 'que des tests');
  });

  test('rouge après deux corrections : « À toi », la MR reste en brouillon, les commits sont sur la branche poussée ; « Relancer » reprend le worktree', async () => {
    vider();
    const id = await session('ai/ct-toujours', 'DRYRUN_TESTS=tests DRYRUN_ROUGE=toujours');
    const c = await finie(id);
    assert.equal(c.status, 'attention');
    assert.equal(c.scenario.corrections, 2);
    assert.equal(c.scenario.cause, 'rouge');
    assert.match(c.scenario.erreur, /tests-e2e/);
    assert.equal(Number(g(testsR.bare, 'rev-list', '--count', 'main..ai/ct-toujours')), 3, 'écriture, puis deux corrections, toutes poussées');
    const mr = mrDe('ai/ct-toujours');
    assert.equal(mrsTests().filter((m) => m.source_branch === 'ai/ct-toujours').length, 1, 'une seule MR, mise à jour par les push');
    assert.equal(mr.draft, true);
    assert.equal(depotTests(c).mr_pret, false);
    // La correction de la passe du dépôt de tests reçoit les échecs, sous nonFiable.
    assert.match(sorties(id)[1].prompt, /^fix: tests rouges[\s\S]*Vérificateur rouge : tests-e2e[\s\S]*<<<DONNEE [0-9a-f]+ fin du journal du vérificateur>>>[\s\S]*test rouge/);
    assert.equal(g(cloneTests, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    // « Relancer » reprend le worktree et la branche (que la session a créée) : toujours rouge, sans erreur de branche.
    assert.equal((await app.api('POST', `/api/tasks/${id}/chaine/relancer`)).status, 200);
    const apres = await finie(id);
    assert.equal(apres.scenario.erreur ? apres.scenario.cause : 'ok', 'rouge', 'toujours rouge, mais repris sans erreur de branche');
    assert.equal(mrsTests().filter((m) => m.source_branch === 'ai/ct-toujours').length, 1);
  });

  test('une correction qui touche du code de la session : « code modifié à l’étape tests », jamais écrasé', async () => {
    vider();
    const id = await session('ai/ct-code', 'DRYRUN_TESTS=session DRYRUN_ROUGE=1 DRYRUN_FIX=code');
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    assert.equal(c.scenario.code_modifie.length, 1);
    assert.deepEqual(c.scenario.code_modifie[0].fichiers, ['PROJ_TASK_DRYRUN.md']);
    assert.match(c.scenario.code_modifie[0].sha, /^[0-9a-f]{40}$/);
  });

  test('le diagnostic d’une branche cassée ne voit jamais le scénario attendu', async () => {
    vider();
    fs.writeFileSync(path.join(bin, 'failhead-lint'), '2');
    const id = await session('ai/ct-diag', 'DRYRUN_TESTS=session SENTINELLE-DIAG', { chain: [vLint] });
    const c = await finie(id);
    const diag = passes(id, /<<<DIAGNOSTIC /);
    assert.ok(diag.length >= 1, `un diagnostic (${c.status})`);
    assert.ok(diag.every((p) => !/SENTINELLE-DIAG/.test(p)));
    assert.equal(passes(id, /SENTINELLE-DIAG/).length, passes(id, ESCRIRE).length, 'seules les passes de l’étape tests la portent');
  });

  test('un scénario attendu venu du ticket est donné sous nonFiable', async () => {
    vider();
    const id = await session('ai/ct-jira', 'DRYRUN_TESTS=session SENTINELLE-JIRA', { chain: [vApp], source: 'jira' });
    await finie(id);
    assert.match(passes(id, ESCRIRE)[0], /<<<DONNEE [0-9a-f]+ Scénario attendu par l’utilisateur>>>\nDRYRUN_TESTS=session SENTINELLE-JIRA/);
  });

  test('deux sessions en parallèle : chacune sa branche et sa MR ; leurs tests sur le dépôt de tests passent l’un après l’autre, une vérification à la main refusée pendant ce temps ; aucune ne voit les fichiers de l’autre', async () => {
    vider();
    const t0 = new Date().toISOString();
    fs.writeFileSync(path.join(bin, 'bloque-tests-e2e'), '1');
    const s1 = await session('ai/ct-s1', 'DRYRUN_TESTS=tests');
    const s2 = await session('ai/ct-s2', 'DRYRUN_TESTS=tests');
    // Un vérificateur du dépôt de tests tourne (retenu) : le suivant attend, et le dit.
    await attendreServeur(async () => !!app.db.prepare("SELECT 1 FROM job WHERE kind = 'verify' AND status = 'queued' AND message LIKE '%les tests de grp/tests tournent déjà (tests-e2e, session #%'").get(),
      'une vérification du dépôt de tests attend la première', 120000);
    // Une vérification lancée à la main sur ce dépôt, par un autre vérificateur, pendant ce temps : refusée tout de suite.
    const main = await app.api('POST', '/api/verify/branches', { verifier_id: vTestsBis, targets: [{ repo_id: testsId, branch: 'main' }] });
    assert.equal(main.status, 400);
    assert.match(main.body.error, /déjà en file pour ce dépôt/);
    fs.unlinkSync(path.join(bin, 'bloque-tests-e2e'));
    const [c1, c2] = [await finie(s1), await finie(s2)];
    assert.equal(c1.status, 'validated', JSON.stringify(c1.scenario)); assert.equal(c2.status, 'validated', JSON.stringify(c2.scenario));
    await waitForJobs(app.api);
    // Chacune sa branche et sa MR ; aucune branche ne porte le test de l'autre.
    assert.ok(mrDe('ai/ct-s1') && mrDe('ai/ct-s2') && mrDe('ai/ct-s1').iid !== mrDe('ai/ct-s2').iid);
    assert.doesNotMatch(g(testsR.bare, 'ls-tree', '-r', '--name-only', 'ai/ct-s2'), new RegExp(`scenario-${s1}\\.`));
    assert.doesNotMatch(g(testsR.bare, 'ls-tree', '-r', '--name-only', 'ai/ct-s1'), new RegExp(`scenario-${s2}\\.`));
    assert.ok(trace('tests-e2e').every((l) => !(l.includes(`scenario-${s1}.`) && l.includes(`scenario-${s2}.`))), trace('tests-e2e').join('\n'));
    // Les exécutions sur le dépôt de tests ne se chevauchent jamais : chaque vérification qui le couvre part après la fin de la précédente.
    const runs = app.db.prepare('SELECT id, targets_json, started_at, finished_at FROM verification WHERE started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY started_at').all()
      .filter((v) => JSON.parse(v.targets_json || '[]').some((x) => x.repo_id === testsId) && v.started_at >= t0);
    assert.ok(runs.length >= 4, `les vérifications du dépôt de tests des deux sessions (${runs.length})`);
    for (let i = 1; i < runs.length; i += 1) assert.ok(runs[i].started_at >= runs[i - 1].finished_at, `chevauchement : #${runs[i - 1].id} et #${runs[i].id}`);
    // Vu du vérificateur lui-même : chaque exécution commence après la fin de la précédente.
    const pas = fs.readFileSync(path.join(bin, 'pas-tests-e2e'), 'utf8').trim().split('\n').map((l) => l.split(' '));
    assert.ok(pas.length >= 8, pas.join('\n'));
    pas.forEach(([quoi], i) => assert.equal(quoi, i % 2 ? 'fin' : 'debut', `deux exécutions en même temps :\n${pas.join('\n')}`));
  });

  test('la MR porte « commit de tests non relu » tant qu’aucune review ne couvre le SHA du commit de tests', async () => {
    const now = new Date().toISOString();
    const mrId = app.db.prepare("INSERT INTO mr (repo_id, iid, title, status, reviewed_sha) VALUES (?, 77, 'tests', 'reviewed', 'ancien')").run(repoId).lastInsertRowid;
    const t = app.db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at) VALUES (?, 'code', 'mr', 'ai/mr', 'pushed', ?, ?)").run(repoId, now, now).lastInsertRowid;
    app.db.prepare('INSERT INTO verif_chaine (task_id, steps_json, scenario_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t, '[]', JSON.stringify({ final: 'vert', depots: [{ zone: 'session', repo_id: repoId, mr_iid: 77, sha_depart: 'a1', sha_final: 'b2b2b2b2b2' }] }), 'validated', now, now);
    const lire = async () => (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId);
    assert.equal((await lire()).tests_non_relus, 'b2b2b2b2b2');
    app.db.prepare("UPDATE mr SET reviewed_sha = 'b2b2b2b2b2' WHERE id = ?").run(mrId);
    assert.equal((await lire()).tests_non_relus, null, 'relu : plus rien à dire');
    app.db.prepare('DELETE FROM verif_chaine WHERE task_id = ?').run(t);
    app.db.prepare('DELETE FROM mr WHERE id = ?').run(mrId);
  });

  test('arrêt de la passe par l’utilisateur : l’étape est conclue sans rien constater, le worktree reste pour la reprise', async () => {
    // eslint-disable-next-line global-require
    const scen = require('../src/jobs/chaine-scenario');
    // eslint-disable-next-line global-require
    const cv = require('../src/jobs/chaine-verif');
    const t = (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'arrêt', auto_push: true, verify_chain: [vTests],
      verify_chain_scenario: { actif: true }, targets: [{ repo_id: repoId, branch: 'ai/ct-arret' }] })).body;
    const tache = app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id);
    const p = await scen.preparer(tache, {});
    assert.ok(p.depots, JSON.stringify(p));
    assert.equal(g(worktree(t.id), 'rev-parse', '--abbrev-ref', 'HEAD'), 'ai/ct-arret');
    assert.equal(g(cloneTests, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'le clone de l’utilisateur n’a pas bougé');
    app.db.prepare('INSERT INTO verif_chaine (task_id, steps_json, scenario_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t.id, '[]', JSON.stringify({ prepare: true, ecrit: true, depots: p.depots, en_cours: { quoi: 'ecrire', at: new Date().toISOString(), avant: {}, tests_avant: {}, sorties: {} } }), 'running', new Date().toISOString(), new Date().toISOString());
    await cv.apresArret(t.id);
    const c = await chaine(t.id);
    assert.equal(c.scenario.cause, 'interrompu');
    assert.ok(fs.existsSync(worktree(t.id)));
    // La session supprimée emporte ses worktrees ; la branche dans le clone de Mergerie n'est plus prise.
    assert.equal((await app.api('DELETE', `/api/tasks/${t.id}`)).status, 200);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'scenario-tests', `task-${t.id}`)), false);
  });

  test('redémarrage en cours de passe : « À toi », cause redémarrage ; une étape sans passe en cours n’est pas touchée', async () => {
    // eslint-disable-next-line global-require
    const cv = require('../src/jobs/chaine-verif');
    const now = new Date().toISOString();
    const etape = (scenario) => {
      const t = app.db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, created_at, updated_at) VALUES (?, 'code', 'redémarrage', 'ai/ct-redem', 'pushed', ?, ?)").run(repoId, now, now).lastInsertRowid;
      app.db.prepare('INSERT INTO verif_chaine (task_id, steps_json, scenario_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(t, '[]', JSON.stringify(scenario), 'running', now, now);
      return t;
    };
    const coupee = etape({ prepare: true, ecrit: true, depots: [], en_cours: { quoi: 'ecrire', at: now, avant: {}, tests_avant: {}, sorties: {} } });
    const calme = etape({ prepare: true, ecrit: true, depots: [], a_rejouer: true });
    cv.reprendreApresRedemarrage();
    const c = await chaine(coupee);
    assert.deepEqual([c.status, c.scenario.cause, c.scenario.en_cours], ['attention', 'redemarrage', null]);
    assert.equal((await chaine(calme)).status, 'running');
  });

  test('un push refusé par le dépôt de tests : « À toi » avec la raison, rien d’ouvert ; « Relancer » repousse, rejoue et valide', async () => {
    vider();
    const hook = path.join(testsR.bare, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read a b ref; do case "$ref" in refs/heads/ai/ct-refuse) echo "branche refusée" >&2; exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
    let id;
    try {
      id = await session('ai/ct-refuse', 'DRYRUN_TESTS=tests', { chain: [vTests] });
      const c = await finie(id);
      assert.equal(c.status, 'attention');
      assert.equal(c.scenario.cause, 'push');
      assert.match(c.scenario.erreur, /^grp\/tests : /);
      assert.equal(distante('ai/ct-refuse'), '', 'rien sur la forge');
      assert.equal(mrDe('ai/ct-refuse'), undefined, 'aucune MR');
    } finally { fs.unlinkSync(hook); }
    const debut = new Date().toISOString();
    assert.equal((await app.api('POST', `/api/tasks/${id}/chaine/relancer`)).status, 200);
    const apres = await finie(id);
    assert.equal(apres.status, 'validated', JSON.stringify(apres.scenario));
    assert.ok(mrDe('ai/ct-refuse'), 'la MR s’ouvre au second push');
    assert.match(g(testsR.bare, 'ls-tree', '-r', '--name-only', 'ai/ct-refuse'), new RegExp(`scenario-${id}\\.`));
    assert.equal(lancementsDepuis(id, debut).length, 1, 'le commit poussé est rejoué');
  });

  test('une MR que la forge refuse d’ouvrir : « À toi », la branche est poussée ; « Relancer » l’ouvre', async () => {
    vider();
    app.state.fail['grp%2Ftests/merge_requests'] = { status: 500, body: { message: 'forge indisponible' } };
    let id;
    try {
      id = await session('ai/ct-sans-mr', 'DRYRUN_TESTS=tests', { chain: [vTests] });
      const c = await finie(id);
      assert.deepEqual([c.status, c.scenario.cause], ['attention', 'push']);
      assert.equal(distante('ai/ct-sans-mr').trim(), 'ai/ct-sans-mr', 'la branche, elle, est partie');
    } finally { delete app.state.fail['grp%2Ftests/merge_requests']; }
    assert.equal((await app.api('POST', `/api/tasks/${id}/chaine/relancer`)).status, 200);
    assert.equal((await finie(id)).status, 'validated');
    assert.equal(mrsTests().filter((m) => m.source_branch === 'ai/ct-sans-mr').length, 1);
  });

  test('deux dépôts de tests dans une session : une passe et une MR chacun, chacun rejoué sur sa branche', async () => {
    vider();
    const id = await session('ai/ct-deux-depots', 'DRYRUN_TESTS=tests', { chain: [vTests, vTests2, vApp] });
    const c = await finie(id);
    assert.equal(c.status, 'validated', JSON.stringify(c.scenario));
    assert.deepEqual(c.scenario.depots.filter((d) => d.zone === 'tests').map((d) => d.project).sort(), ['grp/tests', 'grp/tests2']);
    assert.equal(sorties(id).length, 2, 'une passe par dépôt de tests');
    assert.match(g(testsR.bare, 'ls-tree', '-r', '--name-only', 'ai/ct-deux-depots'), new RegExp(`scenario-${id}\\.`));
    assert.match(g(tests2R.bare, 'ls-tree', '-r', '--name-only', 'ai/ct-deux-depots'), new RegExp(`scenario-${id}\\.`));
    assert.ok(mrDe('ai/ct-deux-depots'));
    assert.ok((app.state.mrs['grp/tests2'] || []).some((m) => m.source_branch === 'ai/ct-deux-depots'));
    await attendreServeur(async () => (await chaine(id)).scenario.depots.filter((d) => d.zone === 'tests').every((d) => d.mr_pret), 'les deux MR passent prêtes');
    // Chaque passe ne voit que son dépôt.
    for (const sortie of sorties(id)) assert.equal((sortie.prompt.match(/^- grp\/tests2? : .* \(tests\)$/gm) || []).length, 1, sortie.prompt.slice(0, 2000));
  });

  test('une vérification lancée à la main tient le dépôt de tests : la chaîne attend, et dit laquelle', async () => {
    vider();
    fs.writeFileSync(path.join(bin, 'bloque-tests-bis'), '1');
    let id;
    try {
      const main = await app.api('POST', '/api/verify/branches', { verifier_id: vTestsBis, targets: [{ repo_id: testsId, branch: 'main' }] });
      assert.equal(main.status, 200, JSON.stringify(main.body));
      await attendreServeur(async () => !!app.db.prepare('SELECT 1 FROM verification WHERE id = ? AND started_at IS NOT NULL').get(main.body.verification.id), 'la vérification à la main tourne');
      id = await session('ai/ct-main', 'DRYRUN_TESTS=tests', { chain: [vTests] });
      await attendreServeur(async () => !!app.db.prepare("SELECT 1 FROM job WHERE kind = 'verify' AND status = 'queued' AND message = 'en attente : les tests de grp/tests tournent déjà (tests-bis)'").get(),
        'la chaîne attend la vérification à la main', 120000);
    } finally { fs.unlinkSync(path.join(bin, 'bloque-tests-bis')); }
    assert.equal((await finie(id)).status, 'validated');
  });

  test('la forge refuse de passer la MR prête : elle reste en brouillon, la carte le dit', async () => {
    vider();
    const iid = app.state.nextIid;
    app.state.fail[`grp%2Ftests/merge_requests/${iid}`] = { status: 500, body: { message: 'refus' } };
    try {
      const id = await session('ai/ct-refus', 'DRYRUN_TESTS=tests', { chain: [vTests] });
      assert.equal((await finie(id)).status, 'validated');
      await attendreServeur(async () => !!depotTests(await chaine(id)).mr_erreur, 'le refus est noté');
      const d = depotTests(await chaine(id));
      assert.deepEqual([d.mr_iid, d.mr_pret], [iid, false]);
      assert.equal(mrDe('ai/ct-refus').draft, true);
      assert.equal((await etapesCockpit(id)).at(-1).mr_tests, 'brouillon');
    } finally { delete app.state.fail[`grp%2Ftests/merge_requests/${iid}`]; }
  });

  /* ---------------- l'écran ---------------- */

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

    test('la fenêtre : la case, le scénario attendu et les dépôts de tests retenus ; l’édition le relit, figé une fois l’étape démarrée', async () => {
      await page.locator('#btnNewTask').click();
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.evaluate((id) => { renderTargetRows([{ repo_id: id, branch: 'ai/ct-ecran' }]); }, repoId);
      await page.locator(`#taskChaineList .task-chaine-pick[value="${vTests}"]`).waitFor();
      await page.locator(`#taskChaineList .task-chaine-pick[value="${vTests}"]`).click();
      await page.locator('#taskChaineScenRow:not([hidden])').waitFor();
      assert.equal(await page.locator('#taskChaineScenVerif').count(), 0, 'plus de choix de vérificateur des scénarios');
      await page.locator('#taskChaineScen').click();
      await page.locator('#taskChaineScenBox:not([hidden])').waitFor();
      await page.waitForFunction(() => /grp\/tests → une branche et une merge request en brouillon/.test(document.querySelector('#taskChaineScenInfo').textContent));
      // Un vérificateur dont le dépôt de tests est sur une forge non configurée : la ligne le dit avant même de créer la session.
      const gh = app.db.prepare("SELECT id FROM verifier WHERE name = 'gh-e2e'").get();
      if (gh) {
        await page.locator(`#taskChaineList .task-chaine-pick[value="${gh.id}"]`).click();
        await page.waitForFunction(() => /gh\/tests → forge non configurée : l’étape tests s’arrêtera/.test(document.querySelector('#taskChaineScenInfo').textContent));
        await page.locator(`#taskChaineList .task-chaine-pick[value="${gh.id}"]`).click();
        await page.waitForFunction(() => !/gh\/tests/.test(document.querySelector('#taskChaineScenInfo').textContent));
      }
      await page.fill('#taskChaineScenAttendu', 'Un devis à 3 échéances');
      await page.fill('#taskForm [name="prompt"]', 'session tests écran');
      const avant = (await app.api('GET', '/api/tasks')).body.length;
      await page.locator('#taskSubmitOnly').click();
      await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.length === avant + 1, 'la session est créée');
      const cree = (await app.api('GET', '/api/tasks')).body.find((x) => x.prompt === 'session tests écran');
      assert.deepEqual(JSON.parse(cree.verify_chain_scenario), { actif: true, attendu: 'Un devis à 3 échéances', attendu_source: 'saisi' });
      await page.waitForSelector('#taskModal', { state: 'hidden' });
      await page.evaluate((id) => openTaskEdit(id), cree.id);
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#taskChaineScenAttendu').value === 'Un devis à 3 échéances');
      assert.equal(await page.locator('#taskChaineScenAttendu').evaluate((z) => z.readOnly), false);
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal', { state: 'hidden' });
      // Une session dont l'étape a démarré : le scénario attendu se lit, ne se modifie plus.
      const demarree = (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'étape démarrée', auto_push: true, verify_chain: [vTests],
        verify_chain_scenario: { actif: true, attendu: 'figé' }, targets: [{ repo_id: repoId, branch: 'ai/ct-figee' }] })).body.id;
      app.db.prepare('INSERT INTO verif_chaine (task_id, steps_json, scenario_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(demarree, '[]', JSON.stringify({ ecrit: true, depots: [] }), 'attention', new Date().toISOString(), new Date().toISOString());
      // Figé aussi côté serveur : une édition n'y touche plus.
      await app.api('PUT', `/api/tasks/${demarree}`, { prompt: 'étape démarrée', verify_chain: [vTests], verify_chain_scenario: { actif: true, attendu: 'changé' } });
      assert.equal(JSON.parse(app.db.prepare('SELECT verify_chain_scenario FROM task WHERE id = ?').get(demarree).verify_chain_scenario).attendu, 'figé');
      await page.evaluate((id) => loadTasks().then(() => openTaskEdit(id)), demarree);
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#taskChaineScenAttendu').readOnly === true);
      assert.equal(await page.locator('#taskChaineScenVerrou').isHidden(), false);
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal', { state: 'hidden' });
      assert.deepEqual(erreurs, []);
    });

    test('la carte : un bloc par dépôt touché, la MR du dépôt de tests, « Demandé / Écrit », un test existant modifié, du code touché ; le diff s’ouvre', async () => {
      vider();
      const id = await session('ai/ct-carte', 'DRYRUN_TESTS=modifie-existant');
      assert.equal((await finie(id)).status, 'validated');
      await attendreServeur(async () => depotTests(await chaine(id)).mr_pret === true, 'la MR passe prête');
      const mr = mrDe('ai/ct-carte');
      await page.locator('#tab-task .subnav [data-kind="code"]').click();
      const bloc = page.locator(`.task-chaine[data-chaine-task="${id}"] .task-chaine-scenario`);
      await attendreServeur(async () => { await page.evaluate(() => loadTasks()); return (await bloc.count()) > 0; }, 'la carte montre les tests');
      const depot = bloc.locator(`.task-tests-depot[data-tests-depot="${testsId}"]`);
      await attendreServeur(async () => { await page.evaluate(() => loadTasks()); return /prête/.test(await depot.textContent()); }, 'la carte dit la MR prête');
      assert.match(await depot.textContent(), new RegExp(`dépôt de tests[\\s\\S]*grp/tests[\\s\\S]*1 modifié[\\s\\S]*ai/ct-carte[\\s\\S]*!${mr.iid}[\\s\\S]*prête`));
      assert.equal(await depot.locator(`a[href="${mr.web_url}"]`).count(), 1);
      assert.match(await bloc.textContent(), /tests écrits et verts/);
      await bloc.locator('summary').click();
      assert.match(await bloc.locator('.task-tests-demande').textContent(), /Demandé[\s\S]*DRYRUN_TESTS=modifie-existant[\s\S]*Écrit[\s\S]*grp\/tests:tests\/existant\.test\.sh/);
      // « test existant modifié » ouvre le diff de ce fichier.
      await depot.locator('.task-tests-alerte').click();
      await page.locator('#splitView:not([hidden])').waitFor();
      await page.waitForFunction(() => /existant\.test\.sh/.test(document.querySelector('#fileName').textContent));
      await page.evaluate(() => { document.querySelector('#splitView').hidden = true; });
      // La grille de la chaîne : la colonne « avec les tests ».
      assert.equal(await page.locator(`.task-chaine[data-chaine-task="${id}"] .task-chaine-cote.is-pass`, { hasText: 'avec les tests' }).count(), 3);
      // Du code touché à l'étape tests : l'étiquette ambre, avec le SHA court.
      const code = app.db.prepare("SELECT task_id FROM verif_chaine WHERE scenario_json LIKE '%\"code_modifie\":[{%' ORDER BY id DESC LIMIT 1").get();
      if (code) {
        await page.evaluate(() => loadTasks());
        assert.match(await page.locator(`.task-chaine[data-chaine-task="${code.task_id}"] .task-chaine-scenario`).textContent(), /code modifié à l’étape tests · grp\/app [0-9a-f]{8}/);
      }
      // La frise de la carte : la phase Tests, avec la MR, et l'arrivée « MR de tests prête ».
      const frise = page.locator(`#taskList .task-row[data-task="${id}"] .frise`);
      assert.match(await frise.locator('.frise-phase.ph-scenario').textContent(), /grp\/tests · 1 modifié/);
      assert.match(await frise.locator('.frise-phase.is-terminus').textContent(), /MR de tests prête/);
      assert.match(await frise.locator('.frise-grille-tete').textContent(), /tests/);
      // Une MR que la forge a refusé de passer prête : la carte le dit, le bloc garde « brouillon ».
      const refus = app.db.prepare("SELECT id FROM task WHERE prompt = 'tests ai/ct-refus'").get();
      if (refus) {
        const bloc2 = page.locator(`.task-chaine[data-chaine-task="${refus.id}"] .task-tests-depot[data-tests-depot="${testsId}"]`);
        await attendreServeur(async () => { await page.evaluate(() => loadTasks()); return (await bloc2.count()) > 0; }, 'la carte de la MR refusée');
        assert.match(await bloc2.textContent(), /brouillon[\s\S]*MR restée en brouillon/);
        assert.match(await bloc2.locator('.tag.stale').getAttribute('title'), /refus/, 'la raison de la forge, au survol');
      }
      assert.deepEqual(erreurs, []);
    });
  });
});
