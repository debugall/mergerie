'use strict';
/* GIT → VÉRIFICATEUR : des préparations (dépôts sur une ref, vérificateurs en séquence) et leurs
 * lancements.
 *
 * Ce qui se prouve ici, sur de vrais dépôts et de vraies commandes :
 *   1. les vérificateurs tournent L'UN APRÈS L'AUTRE, chacun sur les refs choisies ;
 *   2. un vérificateur qui ne couvre pas tout le lot trouve les AUTRES dépôts sur leur ref, dans le
 *      clone local de l'utilisateur, le temps de son run — puis ce clone est remis où il était ;
 *   3. un rouge arrête la suite : les étapes restantes sont « non lancées », et chacune se lance seule ;
 *   4. l'écran compose une préparation, la lance, et montre les verdicts.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, poserIdentiteGit, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

/* Un dépôt « distant » : main, plus une branche qui porte un commit de plus. */
function depot(prefixe, branche) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${prefixe}-`));
  git(d, 'init', '-q', '-b', 'main');
  poserIdentiteGit(d);
  fs.writeFileSync(path.join(d, 'f.txt'), 'main\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'main');
  git(d, 'checkout', '-q', '-b', branche);
  fs.writeFileSync(path.join(d, 'f.txt'), `${branche}\n`);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', branche);
  const sha = git(d, 'rev-parse', 'HEAD');
  git(d, 'checkout', '-q', 'main');
  return { dir: d, sha };
}

describe('Git → Vérificateur', () => {
  let app; let bin; let A; let B; let aId; let bId; let cloneB; let trace;

  before(async () => {
    app = await startApp();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-bin-'));
    A = depot('pv-a', 'develop');
    B = depot('pv-b', 'feature/b');
    await app.configure();
    aId = (await app.api('POST', '/api/repos', { project: 'grp/a', url: A.dir })).body.id;
    bId = (await app.api('POST', '/api/repos', { project: 'grp/b', url: B.dir })).body.id;
    // Le clone LOCAL de B, dans un répertoire local déclaré : c'est là que B sera mis sur sa ref.
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-racine-'));
    cloneB = path.join(racine, 'b');
    execFileSync('git', ['clone', '-q', B.dir, cloneB], { stdio: 'pipe' });
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine })).status, 200);
    trace = path.join(bin, 'trace');
  });
  after(async () => { await app.stop(); });

  const script = (nom, corps) => {
    const p = path.join(bin, `${nom}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
    return p;
  };
  async function verificateur(nom, corps, repoIds) {
    const r = await app.api('POST', '/api/verifiers', {
      name: nom, kind: 'commands', commands: [script(nom, corps)], timeout_s: 60, run_base: 0,
      repos: repoIds.map((id) => ({ repo_id: id, mode: 'worktree' })),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  /* Jusqu'à ce que le dernier lancement n'ait plus rien en file, en cours ou en attente — puis que
     la file de jobs soit vide : c'est elle qui tient le verrou des vérifications. */
  async function attendreFin(planId) {
    for (let i = 0; i < 1200; i += 1) {
      const plan = (await app.api('GET', '/api/verif-plans')).body.find((p) => p.id === planId);
      const run = plan.runs[0];
      if (run && !run.steps.some((s) => ['queued', 'running', 'pending'].includes(s.etat))) {
        for (let j = 0; j < 600; j += 1) {
          const { body: st } = await app.api('GET', '/api/status');
          if (!st.running && !st.queued) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return (await app.api('GET', '/api/verif-plans')).body.find((p) => p.id === planId);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('le lancement ne se termine pas');
  }

  test('en séquence, et un dépôt non couvert est mis sur sa ref dans le clone local, puis remis', async () => {
    // V1 ne couvre que A : pendant son run, il lit où est le clone local de B.
    const v1 = await verificateur('pv-v1', `git -C '${cloneB}' rev-parse HEAD > '${trace}'`, [aId]);
    const v2 = await verificateur('pv-v2', `date +%s%N >> '${trace}.v2'`, [aId, bId]);
    const cree = await app.api('POST', '/api/verif-plans', {
      name: 'Recette A + B',
      targets: [{ repo_id: aId, branch: 'develop' }, { repo_id: bId, branch: 'feature/b' }],
      verifier_ids: [v1.id, v2.id],
    });
    assert.equal(cree.status, 200, JSON.stringify(cree.body));
    assert.deepEqual(cree.body.verifiers.map((v) => v.name), ['pv-v1', 'pv-v2']);
    assert.equal(cree.body.name, 'Recette A + B');

    const lance = await app.api('POST', `/api/verif-plans/${cree.body.id}/run`);
    assert.equal(lance.status, 200, JSON.stringify(lance.body));
    assert.equal(lance.body.runs[0].steps[1].etat, 'pending', 'le second attend la fin du premier');

    const plan = await attendreFin(cree.body.id);
    const [e1, e2] = plan.runs[0].steps;
    assert.equal(e1.verification.verdict, 'verified_pass');
    assert.equal(e2.verification.verdict, 'verified_pass', 'le second est parti après le premier, vert');
    assert.ok(e2.verification.id > e1.verification.id);
    assert.equal(fs.readFileSync(trace, 'utf8').trim(), B.sha, 'pendant le run de V1, le clone local de B était sur feature/b');
    assert.equal(git(cloneB, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'puis remis sur sa branche');

    const d1 = (await app.api('GET', `/api/verifications/${e1.verification.id}`)).body;
    assert.deepEqual(d1.targets.map((c) => [c.repo_id, c.branch, c.head_sha]), [[aId, 'develop', A.sha]], 'V1 vérifie A, sur develop');
    assert.match(d1.log_excerpt || '', /grp\/b \(non couvert par ce vérificateur\)/);
    assert.equal(d1.restore_error, null);
    const d2 = (await app.api('GET', `/api/verifications/${e2.verification.id}`)).body;
    assert.deepEqual(d2.targets.map((c) => c.head_sha).sort(), [A.sha, B.sha].sort(), 'V2 couvre les deux : chacun sur sa ref');
  });

  test('un rouge arrête la suite ; une étape non lancée se lance seule', async () => {
    const rouge = await verificateur('pv-rouge', 'exit 1', [aId]);
    const apres = await verificateur('pv-apres', 'exit 0', [aId]);
    const plan = (await app.api('POST', '/api/verif-plans', {
      name: 'Rouge puis vert', targets: [{ repo_id: aId, branch: 'develop' }], verifier_ids: [rouge.id, apres.id],
    })).body;
    await app.api('POST', `/api/verif-plans/${plan.id}/run`);
    let fin = await attendreFin(plan.id);
    assert.equal(fin.runs[0].steps[0].verification.verdict, 'verified_fail');
    assert.equal(fin.runs[0].steps[1].etat, 'not_run', 'la suite s’arrête au rouge');
    assert.equal(fin.runs[0].steps[1].verification, null);

    const seule = await app.api('POST', `/api/verif-plan-runs/${fin.runs[0].id}/steps/1/run`);
    assert.equal(seule.status, 200, JSON.stringify(seule.body));
    fin = await attendreFin(plan.id);
    assert.equal(fin.runs.length, 1, 'la même exécution, pas un nouveau lancement');
    assert.equal(fin.runs[0].steps[1].verification.verdict, 'verified_pass');
    // Une étape déjà rendue ne se relance pas à la main : c'est « Lancer » qui refait la séquence.
    assert.equal((await app.api('POST', `/api/verif-plan-runs/${fin.runs[0].id}/steps/1/run`)).status, 400);

    // Relancer : un second lancement, le premier passe à l'historique.
    await app.api('POST', `/api/verif-plans/${plan.id}/run`);
    fin = await attendreFin(plan.id);
    assert.equal(fin.runs.length, 2);
    assert.equal(fin.runs[1].steps[1].verification.verdict, 'verified_pass', 'l’historique garde le lancement précédent');
  });

  test('une préparation se refuse sans dépôt, sans vérificateur, ou avec un vérificateur qui n’en couvre aucun', async () => {
    const seulB = await verificateur('pv-seul-b', 'exit 0', [bId]);
    const tente = (corps) => app.api('POST', '/api/verif-plans', { name: 'refusée', ...corps });
    const sansNom = await tente({ name: '  ', targets: [{ repo_id: bId, branch: 'main' }], verifier_ids: [seulB.id] });
    assert.equal(sansNom.status, 400, 'un nom est exigé');
    assert.match(sansNom.body.error, /nom/);
    assert.equal((await tente({ targets: [], verifier_ids: [seulB.id] })).status, 400);
    assert.equal((await tente({ targets: [{ repo_id: aId, branch: 'develop' }], verifier_ids: [] })).status, 400);
    const r = await tente({ targets: [{ repo_id: aId, branch: 'develop' }], verifier_ids: [seulB.id] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /pv-seul-b/);
    assert.equal((await tente({ targets: [{ repo_id: aId, branch: '--upload-pack=x' }], verifier_ids: [seulB.id] })).status, 400, 'une ref qui serait une option');
  });

  test('le nom se change, et la liste est rangée par nom', async () => {
    const v = await verificateur('pv-nom', 'exit 0', [aId]);
    const corps = { targets: [{ repo_id: aId, branch: 'develop' }], verifier_ids: [v.id] };
    const p = (await app.api('POST', '/api/verif-plans', { ...corps, name: 'zz provisoire' })).body;
    const renomme = await app.api('PUT', `/api/verif-plans/${p.id}`, { ...corps, name: 'Aaa nocturne' });
    assert.equal(renomme.status, 200, JSON.stringify(renomme.body));
    assert.equal(renomme.body.name, 'Aaa nocturne');
    const noms = (await app.api('GET', '/api/verif-plans')).body.map((x) => x.name);
    assert.deepEqual(noms, [...noms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
    assert.equal(noms[0], 'Aaa nocturne');
  });

  test('un dépôt non couvert sans clone local arrête le run en le disant', async () => {
    const c = depot('pv-c', 'dev');
    const cId = (await app.api('POST', '/api/repos', { project: 'grp/c', url: c.dir })).body.id;
    const v = await verificateur('pv-sans-clone', 'exit 0', [aId]);
    const plan = (await app.api('POST', '/api/verif-plans', {
      name: 'Sans clone', targets: [{ repo_id: aId, branch: 'develop' }, { repo_id: cId, branch: 'dev' }], verifier_ids: [v.id],
    })).body;
    await app.api('POST', `/api/verif-plans/${plan.id}/run`);
    const fin = await attendreFin(plan.id);
    assert.equal(fin.runs[0].steps[0].verification.verdict, 'verify_error');
    const d = (await app.api('GET', `/api/verifications/${fin.runs[0].steps[0].verification.id}`)).body;
    assert.match(d.log_excerpt || '', /grp\/c n'a pas de clone/);
  });

  test('depuis l’écran : préparer, lancer, voir les verdicts', async (t) => {
    if (!navigateurDispo().dispo) { t.skip(MSG_NAVIGATEUR); return; }
    app.state.branches['grp/a'] = [
      { name: 'main', default: true, protected: false, merged: false, commit: { id: git(A.dir, 'rev-parse', 'main') } },
      { name: 'develop', default: false, protected: false, merged: false, commit: { id: A.sha } },
    ];
    const v = await verificateur('pv-ecran', 'exit 0', [aId]);
    const nav = await lancerNavigateur();
    const page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    try {
      await afficherMenusOptionnels(page);   // Git est un menu optionnel : masqué d'office
      await page.goto(app.base);
      await page.locator('nav button[data-tab="git"]').click();
      await page.locator('#tab-git .subnav [data-gsub="verif"]').click();
      // Des cartes des tests précédents, ou l'état vide si le test tourne seul.
      await page.waitForSelector('#planVerifList .pv-card, #planVerifList .empty');
      const avant = await page.locator('#planVerifList .pv-card').count();

      await page.locator('#planVerifNew').click();
      await page.waitForSelector('#planVerifModal:not([hidden]) .pv-repo-row');
      await page.locator('#planVerifName').fill('Recette écran');
      // Le filtre masque sans décocher ; on coche grp/a, sa branche par défaut arrive d'elle-même.
      await page.locator('#planVerifRepos .pv-search').fill('grp/a');
      assert.equal(await page.locator('#planVerifRepos .pv-repo-row[data-repo="' + bId + '"]').isHidden(), true);
      const ligne = page.locator(`#planVerifRepos .pv-repo-row[data-repo="${aId}"]`);
      await ligne.locator('.pv-pick').click();
      await page.waitForFunction((id) => (document.querySelector(`#planVerifRepos .pv-repo-row[data-repo="${id}"] .cb-search`) || {}).value === 'main', aId);
      // La branche se choisit dans le sélecteur à recherche.
      await ligne.locator('.cb-search').fill('dev');
      await page.locator('.combo-options:not([hidden]) .combo-opt', { hasText: 'develop' }).first().click();
      // Le vérificateur qui ne couvre que grp/b est grisé ; celui de l'écran se coche, rang 1.
      const ligneV = page.locator('#planVerifVerifiers .pv-verif-row', { hasText: 'pv-ecran' });
      await ligneV.locator('.pv-vpick').click();
      await page.waitForFunction(() => [...document.querySelectorAll('#planVerifVerifiers .pv-verif-row')]
        .some((l) => l.textContent.includes('pv-ecran') && l.querySelector('.pv-rang').textContent === '1.'));
      assert.equal(await page.locator('#planVerifVerifiers .pv-verif-row', { hasText: 'pv-seul-b' }).locator('.pv-vpick').isDisabled(), true);
      await page.locator('#planVerifSave').click();
      await page.waitForFunction((n) => document.querySelectorAll('#planVerifList .pv-card').length === n + 1, avant);

      const plan = (await app.api('GET', '/api/verif-plans')).body.find((x) => x.name === 'Recette écran');
      assert.deepEqual(plan.targets.map((c) => [c.repo_id, c.branch]), [[aId, 'develop']]);
      assert.deepEqual(plan.verifiers.map((x) => x.id), [v.id]);

      const carte = page.locator(`#planVerifList .pv-card[data-plan="${plan.id}"]`);
      assert.equal((await carte.locator('.pv-name').textContent()).trim(), 'Recette écran', 'la carte porte le nom');
      // Modifier rouvre la modale sur ce nom.
      await carte.locator('[data-pvedit]').click();
      await page.waitForFunction(() => document.querySelector('#planVerifName').value === 'Recette écran');
      await page.locator('#planVerifCancel').click();
      await carte.locator('[data-pvrun]').click();
      // Le verdict arrive sur la carte, sans recharger : l'écran relit tant que ça tourne.
      await carte.locator('.pv-step .tag.verify.ok').waitFor();
      assert.equal(erreurs.length, 0, `aucune erreur JS : ${erreurs.join(' | ')}`);
    } finally { await nav.close(); }
  });
});
