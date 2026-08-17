'use strict';
/* VÉRIFIER UNE BRANCHE, SANS MERGE REQUEST.
 *
 * Le cas : au retour de congés, plusieurs merge requests ont été mergées. La question n'est
 * plus « qu'est-ce que cette branche casse ? » mais « est-ce que `develop` est encore vert ? ».
 *
 * C'est le MÊME objet avec une cible différente — aucune colonne de plus : une cible porte déjà
 * `repo_id`, `branch`, `head_sha` et un `mr_id` qui peut être nul. Ce fichier surveille les
 * trois choses qui changent de SENS, et qui sont toutes déduites de cette absence de MR :
 *
 *   1. le double run causal s'éteint — sur une branche d'intégration, la branche EST la base ;
 *   2. plus rien n'est « cassé par cette branche » : ce qui est rouge est rouge ;
 *   3. le brief du matin doit dire « dépôt · branche », faute de numéro de MR à afficher.
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

describe('Vérification d’une branche', () => {
  let app; let repoId; let bin; let distant; let git;

  before(async () => {
    app = await startApp();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-bin-'));
    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-depot-'));
    git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
    git(distant, 'init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'base');
    git(distant, 'checkout', '-q', '-b', 'develop');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'develop\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'develop');
    git(distant, 'checkout', '-q', 'main');
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: distant })).body.id;
  });
  after(async () => { await app.stop(); });

  const script = (nom, corps) => {
    const p = path.join(bin, `${nom}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
    return p;
  };

  async function poser(nom, corps, champs = {}) {
    const r = await app.api('POST', '/api/verifiers', {
      name: nom, kind: 'commands', commands: [script(nom, corps)], timeout_s: 60,
      /* run_base RESTE ACTIF : tout l'intérêt est de prouver qu'il s'éteint pour une branche
         SANS qu'on ait à toucher au vérificateur, qui doit continuer son double run sur les MR. */
      run_base: 1,
      repos: [{ repo_id: repoId, mode: 'worktree' }],
      ...champs,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }

  async function attendre(id) {
    for (let i = 0; i < 600; i += 1) {
      const { body } = await app.api('GET', `/api/verifications/${id}`);
      if (body.status === 'done' || body.status === 'error') {
        /* La vérification est close, mais le JOB qui la porte peut ne pas l'être — et c'est lui
           qui tient le verrou « une seule vérification à la fois par dépôt ». Sans cette
           attente, le test suivant se fait refuser son lancement. */
        for (let j = 0; j < 600; j += 1) {
          const { body: st } = await app.api('GET', '/api/status');
          if (!st.running && !st.queued) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return body;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('la vérification ne se termine pas');
  }

  test('la branche est vérifiée, et le run base ne part PAS', async () => {
    const v = await poser('vert', 'exit 0');
    const r = await app.api('POST', '/api/verify/branches', {
      verifier_id: v.id, targets: [{ repo_id: repoId, branch: 'develop' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = await attendre(r.body.verification.id);

    assert.equal(d.verdict, 'verified_pass');
    assert.equal(d.base_run, null,
      'la branche EST la base : lancer le run base ferait tourner la batterie deux fois pour rien');
    assert.equal(d.targets[0].mr_id, null, 'aucune merge request : c’est ce qui distingue ce run');
    assert.equal(d.targets[0].branch, 'develop');
    assert.match(d.targets[0].head_sha, /^[0-9a-f]{40}$/,
      'le verdict est attaché à des COMMITS, pas à un nom de branche qui bougera');
  });

  test('rouge : les tests cassés sont nommés, sans être imputés à personne', async () => {
    const v = await poser('rouge', "printf 'TAP version 13\\nnot ok 1 - integ › panier\\n1..1\\n'\nexit 1");
    const r = await app.api('POST', '/api/verify/branches', {
      verifier_id: v.id, targets: [{ repo_id: repoId, branch: 'develop' }],
    });
    const d = await attendre(r.body.verification.id);
    assert.equal(d.verdict, 'verified_fail');
    assert.deepEqual(d.imputable.map((f) => f.test), ['integ › panier']);

    /* Le TEXTE compte : « cassé par cette branche » accuserait un auteur qui n'existe pas —
       personne n'a poussé cette branche, c'est l'état du code qui est rouge. */
    const { body: c } = await app.api('GET', `/api/verifications/${d.id}/comment`);
    assert.match(c.body, /✗ 1 test\(s\) cassé\(s\)$/m);
    assert.doesNotMatch(c.body, /par cette branche/);
    assert.deepEqual(c.mrs, [], 'il n’y a aucune merge request où publier');
  });

  test('une branche inconnue est refusée, avec son nom', async () => {
    const v = await poser('inconnue', 'exit 0');
    const r = await app.api('POST', '/api/verify/branches', {
      verifier_id: v.id, targets: [{ repo_id: repoId, branch: 'pas-de-branche' }],
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /pas-de-branche/);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM verification').get().c > 0, true);
  });

  test('sans branche, on refuse plutôt que de deviner', async () => {
    const v = await poser('sans', 'exit 0');
    assert.equal((await app.api('POST', '/api/verify/branches', {
      verifier_id: v.id, targets: [{ repo_id: repoId, branch: '   ' }],
    })).status, 400);
  });

  /* LE BRIEF DU MATIN. C'est là que le rouge d'une branche doit atterrir — il n'y a pas de
     carte de merge request pour le porter. Le piège : le brief compose sa ligne à partir de la
     MR, et sans variante « dépôt · branche » elle sort vide. */
  test('un rouge de branche remonte dans le brief, avec son dépôt et sa branche', async () => {
    const v = await poser('brief', 'exit 1');
    const r = await app.api('POST', '/api/verify/branches', {
      verifier_id: v.id, targets: [{ repo_id: repoId, branch: 'develop' }],
    });
    await attendre(r.body.verification.id);

    const { body: brief } = await app.api('GET', '/api/brief');
    const ligne = (brief.verifications || []).find((x) => x.verifier_name === 'brief');
    assert.ok(ligne, 'la vérification de branche en échec est dans le brief');
    assert.equal(ligne.targets[0].iid, null, 'aucun numéro de MR à afficher…');
    assert.equal(ligne.targets[0].project, 'grp/app', '…donc c’est le dépôt qui identifie la ligne');
    assert.equal(ligne.targets[0].branch, 'develop', '…avec la branche, sinon on ne sait pas laquelle est rouge');
  });

  /* DEPUIS L'ÉCRAN. Le sélecteur de branche est un `combo` : son chargeur reçoit l'ancêtre
     portant `data-row` — et sans cet attribut il reçoit `null`, ce qui se voit à l'ouverture de
     la liste, jamais avant. Le bug est parti en production une fois ; il ne repartira pas. */
  test('depuis l’écran : la liste des branches s’ouvre, se filtre, et lance la vérification', async (t) => {
    if (!navigateurDispo().dispo) { t.skip(MSG_NAVIGATEUR); return; }
    app.state.branches['grp/app'] = [
      { name: 'main', default: true, protected: false, merged: false, commit: { id: git(distant, 'rev-parse', 'main') } },
      { name: 'develop', default: false, protected: false, merged: false, commit: { id: git(distant, 'rev-parse', 'develop') } },
    ];
    const v = await poser('ui', 'exit 0');
    const nav = await lancerNavigateur();
    const page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    try {
      await page.goto(app.base);
      await page.locator('[data-tab="admin"]').click();
      await page.waitForLoadState('networkidle');
      await page.locator('#tab-admin .subnav [data-sub="verifiers"]').click();
      await page.waitForSelector('#verifierList .card');
      await page.locator(`#verifierList .card[data-id="${v.id}"] [data-vbranch]`).click();
      await page.waitForSelector('#branchVerifyModal:not([hidden])');

      // La branche par défaut du dépôt est proposée d'emblée : c'est elle, dans la plupart des cas.
      const champ = page.locator('#branchVerifyRows .cb-search').first();
      assert.equal(await champ.inputValue(), 'main');

      await champ.click();
      await page.waitForSelector('.combo-options:not([hidden]) .combo-opt');
      const options = await page.locator('.combo-options:not([hidden]) .combo-opt').allTextContents();
      assert.ok(options.some((o) => o.includes('develop')), `la liste des branches s’ouvre : ${options.join(', ')}`);

      // …et elle SE FILTRE : un dépôt actif en aligne des centaines.
      await champ.fill('deve');
      await page.waitForTimeout(300);
      const filtrees = await page.locator('.combo-options:not([hidden]) .combo-opt').allTextContents();
      assert.ok(filtrees.length && filtrees.every((o) => o.includes('deve')), `filtre : ${filtrees.join(', ')}`);
      await page.locator('.combo-options:not([hidden]) .combo-opt').first().click();

      const avant = app.db.prepare('SELECT COUNT(*) c FROM verification').get().c;
      await page.locator('#branchVerifyGo').click();
      await page.waitForSelector('#branchVerifyModal[hidden]', { state: 'attached' });
      assert.equal(app.db.prepare('SELECT COUNT(*) c FROM verification').get().c, avant + 1,
        'le clic lance bien une vérification');
      const cible = JSON.parse(app.db.prepare('SELECT targets_json t FROM verification ORDER BY id DESC LIMIT 1').get().t)[0];
      assert.equal(cible.branch, 'develop', 'c’est la branche CHOISIE qui part, pas celle proposée');
      assert.equal(cible.mr_id, null);
      assert.equal(erreurs.length, 0, `aucune erreur JS : ${erreurs.join(' | ')}`);
      // La vérification lancée tient le verrou du dépôt : on la laisse finir, sinon c'est le
      // test suivant qui se fait refuser son lancement.
      await attendre(app.db.prepare('SELECT id FROM verification ORDER BY id DESC LIMIT 1').get().id);
    } finally { await nav.close(); }
  });

  /* Le même vérificateur doit continuer à faire son double run causal sur une merge request :
     l'extinction ne vaut que pour CETTE vérification-là, et elle est déduite des cibles. */
  test('sur une merge request, le même vérificateur relance bien sa base', async () => {
    const head = git(distant, 'rev-parse', 'develop');
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    app.state.mrs['grp/app'] = [{
      iid: 9, title: 'X', state: 'opened', source_branch: 'develop', target_branch: 'main',
      web_url: 'http://x/9', sha: head, created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    const mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 9).id;

    const v = await poser('mr-avec-base', 'exit 0');
    const r = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(r.body.verification.id);
    assert.ok(d.base_run, 'sur une MR, le double run causal reste actif');
  });
});
