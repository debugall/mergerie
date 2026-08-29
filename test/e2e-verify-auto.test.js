'use strict';
/* VÉRIFICATEURS AUTOMATIQUES : la batterie part toute seule sur une nouvelle merge request.
 *
 * Le geste manquant n'était pas la vérification — elle existe et fonctionne — mais son
 * DÉCLENCHEMENT : il fallait cliquer, donc y penser, donc avoir vu passer la MR. Une case sur
 * le vérificateur, et la découverte s'en charge.
 *
 * Ce que ce fichier surveille tient en trois points, et ce sont les trois qui coûtent cher :
 * seule une MR NOUVELLE déclenche (sinon chaque synchronisation relance la batterie sur tout
 * le monde), le PLAFOND tient (quinze MR un lundi matin sature la machine pour une heure), et
 * ce qu'il écarte se DIT (un plafond silencieux se lit comme « tout a été vérifié »).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit } = require('./helpers/app');

// Un dépôt git réel : la vérification monte de vrais worktrees sur de vrais commits.
function depot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-remote-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  poserIdentiteGit(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  g('checkout', '-q', '-b', 'feature/x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'tête\n');
  g('add', '-A'); g('commit', '-qm', 'tête');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  g('checkout', '-q', 'main');
  return { dir, head };
}

describe('Vérificateurs automatiques sur les nouvelles MR', () => {
  let app; let repoId; let d; let script;

  const mrApi = (iid) => ({
    iid, title: `MR ${iid}`, state: 'opened', source_branch: 'feature/x', target_branch: 'main',
    web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`,
    sha: d.head, created_at: new Date().toISOString(), author: { name: 'A' },
  });
  const verifications = () => app.db.prepare('SELECT * FROM verification ORDER BY id').all();

  before(async () => {
    app = await startApp();
    d = depot();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-bin-'));
    script = path.join(bin, 'v.sh');
    fs.writeFileSync(script, '#!/bin/sh\ncat > /dev/null\necho \'{"version":1,"status":"pass"}\'\n');
    fs.chmodSync(script, 0o755);

    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'auto-clones-')) });
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: d.dir }];
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: d.dir })).body.id;
  });
  /* ON VIDE LA FILE AVANT DE COUPER. Ces tests mettent de vraies vérifications en attente :
     arrêter le serveur pendant qu'elles montent des worktrees laisse des processus git
     derrière, et le fichier de test ne rend jamais la main. Borné : si ça ne se vide pas, on
     coupe quand même — un test qui traîne vaut mieux qu'une suite bloquée. */
  after(async () => {
    for (let i = 0; i < 200; i += 1) {
      const { body } = await app.api('GET', '/api/status');
      if (!body.running && !body.queued) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await app.stop();
  });

  const poserVerificateur = (nom, auto) => app.api('POST', '/api/verifiers', {
    name: nom, kind: 'commands', commands: [script], timeout_s: 60, run_base: false, auto_on_mr: auto ? 1 : 0,
    repos: [{ repo_id: repoId, mode: 'worktree' }],
  });

  /* La case doit franchir l'aller-retour complet : envoyée, écrite, relue. Un réglage accepté
     mais jamais rendu s'affiche décoché au rechargement, et le premier « Enregistrer » l'efface. */
  test('la case « automatique » s’enregistre et se relit', async () => {
    const { body: v } = await poserVerificateur('auto-1', true);
    assert.equal(v.auto_on_mr, 1);
    const relu = (await app.api('GET', '/api/verifiers')).body.find((x) => x.id === v.id);
    assert.equal(relu.auto_on_mr, 1, 'la liste rend l’option — c’est elle que l’écran affiche');

    const { body: modifie } = await app.api('PUT', `/api/verifiers/${v.id}`, { auto_on_mr: 0 });
    assert.equal(modifie.auto_on_mr, 0, 'et elle se décoche');
    await app.api('PUT', `/api/verifiers/${v.id}`, { auto_on_mr: 1 });
  });

  test('une MR nouvelle déclenche le vérificateur qui couvre son dépôt', async () => {
    app.state.mrs['grp/app'] = [mrApi(10)];
    const { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.created, 1);
    assert.equal(r.auto_verify.lancees, 1, 'la découverte dit ce qu’elle a lancé');

    const v = verifications();
    assert.equal(v.length, 1, 'une vérification est en file');
    const cibles = JSON.parse(v[0].targets_json);
    assert.equal(cibles[0].repo_id, repoId);
    assert.ok(cibles[0].mr_id, 'elle porte bien la MR découverte');
  });

  /* LE POINT QUI COÛTE LE PLUS CHER SI ON SE TROMPE. Une MR déjà connue est revue à chaque
     découverte : la relancer à chaque fois ferait tourner la batterie sur tout le monde en
     permanence, sans que personne ne comprenne pourquoi la machine rame. */
  test('la même MR redécouverte ne relance rien', async () => {
    const avant = verifications().length;
    const { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.created, 0, 'rien de neuf');
    assert.equal(r.auto_verify.lancees, 0);
    assert.equal(verifications().length, avant, 'aucune vérification de plus');
  });

  test('un vérificateur non coché ne part pas tout seul', async () => {
    await poserVerificateur('manuel', false);
    const avant = verifications().length;
    app.state.mrs['grp/app'] = [mrApi(10), mrApi(11)];
    const { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.auto_verify.lancees, 1, 'seul l’automatique part — le manuel attend son clic');
    assert.equal(verifications().length, avant + 1);
  });

  /* LE PLAFOND, ET CE QU'IL DIT. Quinze batteries fonctionnelles saturent la machine pour une
     heure ; mais un plafond qui se tait se lit comme « tout a été vérifié ». */
  test('au-delà du plafond, rien ne part de plus — et la découverte le dit', async () => {
    const avant = verifications().length;
    app.state.mrs['grp/app'] = Array.from({ length: 12 }, (_, i) => mrApi(100 + i));
    const { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.created, 12, 'les douze MR sont bien enregistrées : le plafond ne porte que sur les vérifications');

    assert.equal(r.auto_verify.lancees, 5, 'cinq au maximum par tour de découverte');
    assert.equal(r.auto_verify.plafonnees, 7, '…et les sept autres sont comptées, pas oubliées');
    assert.equal(verifications().length, avant + 5);
  });

  /* LE PLAFOND SE RÈGLE. Cinq est un défaut, pas une vérité : il dépend de la machine et de la
     durée des suites. Et `0` doit vouloir dire « sans limite » — sinon il se lirait comme
     « aucune vérification », ce qui est exactement l'inverse. */
  test('le plafond vient des réglages, et 0 signifie « sans limite »', async () => {
    await app.api('PUT', '/api/config', { verif_auto_max: 2 });
    let avant = verifications().length;
    app.state.mrs['grp/app'] = Array.from({ length: 6 }, (_, i) => mrApi(300 + i));
    let { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.auto_verify.lancees, 2, 'le réglage prime sur le défaut');
    assert.equal(r.auto_verify.plafonnees, 4);
    assert.equal(verifications().length, avant + 2);

    await app.api('PUT', '/api/config', { verif_auto_max: 0 });
    avant = verifications().length;
    app.state.mrs['grp/app'] = Array.from({ length: 6 }, (_, i) => mrApi(400 + i));
    ({ body: r } = await app.api('POST', '/api/discover'));
    assert.equal(r.auto_verify.plafonnees, 0, '0 = aucune limite, rien n’est écarté');
    assert.equal(verifications().length, avant + 6);

    await app.api('PUT', '/api/config', { verif_auto_max: 5 });   // on rend l'état aux suivants
  });

  /* RELANCER QUAND LE VERDICT SE PÉRIME. Un vert rendu sur des commits qui ne sont plus les
     derniers ne vaut rien. Mais c'est un appétit DIFFÉRENT de « vérifier à l'arrivée » : sur
     une branche qui bouge dix fois par jour, ça fait dix batteries. D'où deux cases. */
  test('une MR qui reçoit de nouveaux commits relance le vérificateur qui le demande', async () => {
    await app.api('POST', '/api/verifiers', {
      name: 'sur-peremption', kind: 'commands', commands: [script], run_base: false,
      auto_on_stale: 1, repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    // Une MR NOUVELLE ne le concerne pas : il n'a que la case « périmée ».
    app.state.mrs['grp/app'] = [mrApi(700)];
    let { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.auto_verify_stale.lancees, 0, 'à l’arrivée, ce vérificateur-là ne bouge pas');

    // Même SHA : rien ne se périme, donc rien ne repart.
    ({ body: r } = await app.api('POST', '/api/discover'));
    assert.equal(r.auto_verify_stale.lancees, 0, 'une MR qui ne bouge pas ne relance rien');

    // Le SHA change : le verdict rendu ne vaut plus rien, la vérification repart.
    const avant = verifications().length;
    app.state.mrs['grp/app'] = [{ ...mrApi(700), sha: 'ffffffffffffffffffffffffffffffffffffffff' }];
    ({ body: r } = await app.api('POST', '/api/discover'));
    assert.equal(r.auto_verify_stale.lancees, 1, 'le SHA a bougé : on revérifie');
    assert.equal(verifications().length, avant + 1);
  });

  /* UN VÉRIFICATEUR NE PART QUE SUR LES DÉPÔTS QU'IL COUVRE. Déclarer un dépôt, c'est dire
     « je sais le tester » : lancer une batterie sur un dépôt qu'elle ne connaît pas produirait
     un rouge qui ne veut rien dire, et le pire moment pour le découvrir est en automatique. */
  test('une MR d’un dépôt non couvert ne déclenche rien', async () => {
    const autre = depot();
    app.state.projects.push({ id: 2, path_with_namespace: 'grp/autre', http_url_to_repo: autre.dir });
    await app.api('POST', '/api/repos', { project: 'grp/autre', url: autre.dir });
    app.state.mrs['grp/autre'] = [{
      iid: 900, title: 'Ailleurs', state: 'opened', source_branch: 'feature/x', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/autre/-/merge_requests/900',
      sha: autre.head, created_at: new Date().toISOString(), author: { name: 'B' },
    }];
    // Le vérificateur automatique existant ne couvre que `grp/app`.
    await app.api('PUT', `/api/verifiers/${(await app.api('GET', '/api/verifiers')).body[0].id}`, { auto_on_mr: 1 });
    app.state.mrs['grp/app'] = [];

    const avant = verifications().length;
    const { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.created, 1, 'la MR de l’autre dépôt est bien découverte');
    assert.equal(r.auto_verify.lancees, 0, '…mais aucune batterie ne part sur un dépôt non couvert');
    assert.equal(verifications().length, avant);
  });

  /* LA ROUTE DE LA MODALE. Depuis que des vérificateurs partent tout seuls, une MR peut en
     avoir plusieurs : le badge n'en montre qu'un. La liste doit donc rendre UN bloc par
     vérificateur — et le plus récent de chacun, pas trois passages du même. */
  test('la MR expose le résultat de CHAQUE vérificateur, le plus récent de chacun', async () => {
    const mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 10);
    const cible = JSON.stringify([{ repo_id: repoId, mr_id: mr.id, head_sha: d.head, branch: 'feature/x', mode: 'worktree' }]);
    const ins = app.db.prepare(`INSERT INTO verification
      (verifier_id, verifier_name, status, verdict, targets_json, head_run_json, created_at)
      VALUES (?, ?, 'done', ?, ?, ?, ?)`);
    const run = JSON.stringify({ status: 'pass', commands: [{ command: 'npm test', code: 0, duration_ms: 12, output_tail: 'ok' }] });
    // Les identifiants viennent de vrais vérificateurs : la table porte une clé étrangère.
    const idA = (await poserVerificateur('batterie A', false)).body.id;
    const idB = (await poserVerificateur('batterie B', false)).body.id;
    ins.run(idA, 'batterie A', 'verified_pass', cible, run, 'now');
    ins.run(idB, 'batterie B', 'verified_fail', cible, run, 'now');
    ins.run(idA, 'batterie A', 'verified_fail', cible, run, 'now');   // passage PLUS RÉCENT de A

    const { body: liste } = await app.api('GET', `/api/mrs/${mr.id}/verifications`);
    const noms = liste.map((v) => v.verifier_name);
    assert.equal(new Set(noms).size, noms.length, 'un seul bloc par vérificateur');
    const a = liste.find((v) => v.verifier_name === 'batterie A');
    assert.equal(a.verdict, 'verified_fail', 'et c’est le passage le plus RÉCENT qui est rendu');
    assert.ok(a.head_run.commands.length, 'les commandes et leurs sorties voyagent avec — c’est ce que la modale affiche');
  });

  test('une MR sans vérification rend une liste vide plutôt qu’une erreur', async () => {
    // Choisie sur les FAITS : une MR qu'aucune vérification ne cite. L'ordre des tests
    // précédents ne décide donc pas de celle-ci.
    const citees = new Set();
    for (const v of verifications()) {
      try { for (const c of JSON.parse(v.targets_json || '[]')) citees.add(c.mr_id); } catch { /* illisible */ }
    }
    const vierge = (await app.api('GET', '/api/mrs')).body.find((m) => !citees.has(m.id));
    assert.ok(vierge, 'le décor doit comporter au moins une MR jamais vérifiée');
    const { status, body } = await app.api('GET', `/api/mrs/${vierge.id}/verifications`);
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });

  /* Sans vérificateur automatique, la découverte doit se comporter EXACTEMENT comme avant :
     c'est le chemin le plus emprunté de l'outil, une régression y coûterait cher. */
  test('sans aucun vérificateur automatique, la découverte ne change pas', async () => {
    for (const v of (await app.api('GET', '/api/verifiers')).body) {
      await app.api('PUT', `/api/verifiers/${v.id}`, { auto_on_mr: 0 });
    }
    const avant = verifications().length;
    app.state.mrs['grp/app'] = [mrApi(200)];
    const { body: r } = await app.api('POST', '/api/discover');
    assert.equal(r.created, 1);
    assert.deepEqual(r.auto_verify, { lancees: 0, ignorees: 0, plafonnees: 0 });
    assert.equal(verifications().length, avant, 'aucune vérification créée');
  });
});
