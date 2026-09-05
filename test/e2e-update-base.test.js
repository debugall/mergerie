'use strict';
/* METTRE LA BRANCHE DE TRAVAIL À JOUR AVEC LA BRANCHE DE DÉPART.
 *
 * Le cas : la session a produit sa branche et sa merge request, la branche de départ a avancé,
 * et la forge affiche des conflits. On rejoue nos commits par-dessus la branche de départ à
 * jour — un `rebase`, pas un `merge` : l'historique de la branche de départ est CONSERVÉ tel
 * quel, nos changements repassent au-dessus.
 *
 * Ce fichier vérifie surtout ce qui doit être VRAI D'UN DÉPÔT GIT à la fin, pas ce que dit
 * l'écran : c'est un outil qui réécrit des branches. Quatre invariants :
 *
 *   1. l'historique de la branche de départ est intact, et nos commits sont AU-DESSUS ;
 *   2. rien n'est poussé — le rebase réécrit, et réécrire chez les autres se décide ;
 *   3. quand les conflits ne peuvent pas être tranchés, la branche est remise EXACTEMENT
 *      comme elle était : un rebase laissé en plan bloquerait le clone pour tout le reste ;
 *   4. une branche déjà à jour ne se fait pas rejouer pour rien.
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

const { dispo } = navigateurDispo();

describe('Rattraper la branche de départ', () => {
  let app; let repoId; let distant; let navigateur; let page;
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();

  before(async () => {
    app = await startApp();
    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-'));
    git(distant, 'init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'ligne 1\n');
    fs.writeFileSync(path.join(distant, 'b.txt'), 'intact\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'base');
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: distant })).body.id;
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    await app.stop();
  });

  /** Une session dont la branche existe côté distant, comme après un run + push.
      `conflits` reproduit ce que la découverte aura relevé sur la forge : 1 = la merge request
      est en conflit (le seul cas où le bouton s'affiche), 0 = non, null = pas encore su. */
  async function sessionPoussee(branche, { fichier = 'b.txt', contenu = 'travail de la session\n', conflits = 1 } = {}) {
    git(distant, 'checkout', '-q', 'main');
    git(distant, 'checkout', '-q', '-b', branche);
    fs.writeFileSync(path.join(distant, fichier), contenu);
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', `travail sur ${branche}`);
    git(distant, 'checkout', '-q', 'main');
    const id = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: branche }],
    })).body.id;
    app.db.prepare("UPDATE task_target SET status = 'pushed', base_branch = 'main', mr_conflicts = ? WHERE task_id = ?")
      .run(conflits, id);
    app.db.prepare("UPDATE task SET status = 'pushed' WHERE id = ?").run(id);
    const tg = app.db.prepare('SELECT id FROM task_target WHERE task_id = ?').get(id);
    return { taskId: id, targetId: tg.id };
  }

  /** Fait avancer `main` côté distant. */
  function mainAvance(fichier, contenu, message) {
    git(distant, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(distant, fichier), contenu);
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', message);
    return git(distant, 'rev-parse', 'HEAD');
  }

  async function lancer(taskId, targetId) {
    const r = await app.api('POST', `/api/tasks/${taskId}/targets/${targetId}/update-base`);
    for (let i = 0; i < 900; i += 1) {
      const { body: st } = await app.api('GET', '/api/status');
      if (!st.running && !st.queued) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    return r;
  }
  const cible = (id) => app.db.prepare('SELECT * FROM task_target WHERE id = ?').get(id);
  const nbJobsTask = () => app.db.prepare("SELECT COUNT(*) n FROM job WHERE kind = 'task'").get().n;
  const clone = () => {
    const repo = app.db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId);
    return require('../src/git').cloneDirFor(app.db.prepare('SELECT * FROM config WHERE id = 1').get(), repo);
  };

  test('les commits de la session repassent AU-DESSUS de la branche de départ', async () => {
    // `b.txt` d'un côté, `c.txt` de l'autre : aucun conflit, le rebase doit passer seul.
    const { taskId, targetId } = await sessionPoussee('feature/rebase-simple');
    const shaMain = mainAvance('c.txt', 'nouveauté de main\n', 'main avance');
    const r = await lancer(taskId, targetId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(cible(targetId).last_error, null, 'le rebase doit aboutir');

    const cwd = clone();
    const journal = git(cwd, 'log', '--format=%H %s', 'feature/rebase-simple');
    const lignes = journal.split('\n');
    assert.match(lignes[0], /travail sur feature\/rebase-simple/, 'notre commit est en tête');
    assert.ok(journal.includes(shaMain), 'et l’historique de main est conservé, tel quel, en dessous');
    // Le contenu apporté par main est bien là, à côté du nôtre.
    assert.equal(fs.readFileSync(path.join(cwd, 'c.txt'), 'utf8'), 'nouveauté de main\n');
    assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'travail de la session\n');
  });

  test('rien n’est poussé : la branche revient « à pousser »', async () => {
    const { taskId, targetId } = await sessionPoussee('feature/rebase-nopush');
    mainAvance('d.txt', 'encore\n', 'main avance encore');
    const avant = git(distant, 'rev-parse', 'feature/rebase-nopush');
    await lancer(taskId, targetId);
    const tg = cible(targetId);
    assert.equal(tg.status, 'committed', 'le bouton « Pousser » doit reprendre la main');
    assert.match(tg.push_command, /--force-with-lease/, 'réécrire une branche poussée demande un push forcé');
    assert.equal(git(distant, 'rev-parse', 'feature/rebase-nopush'), avant,
      'la branche DISTANTE ne doit pas avoir bougé — réécrire chez les autres se décide');
  });

  test('déjà à jour : on le dit, on ne rejoue rien', async () => {
    const { taskId, targetId } = await sessionPoussee('feature/rebase-ajour');
    const cwdAvant = clone();
    await lancer(taskId, targetId);
    const r2 = await lancer(taskId, targetId);   // deux fois : la seconde n'a rien à faire
    assert.equal(r2.status, 200);
    assert.equal(cible(targetId).last_error, null);
    assert.ok(fs.existsSync(cwdAvant), 'le clone reste utilisable');
  });

  test('conflit insoluble : la branche est remise EXACTEMENT comme elle était', async () => {
    /* Sans agent (dry-run), personne ne peut trancher. Ce qui compte alors n'est pas le message
       d'erreur mais l'état laissé derrière : un rebase en plan bloquerait ce clone pour tout le
       reste — plus un seul checkout ne passerait. */
    const { taskId, targetId } = await sessionPoussee('feature/rebase-conflit', { fichier: 'a.txt', contenu: 'version session\n' });
    mainAvance('a.txt', 'version main\n', 'main touche le même fichier');
    await lancer(taskId, targetId);

    const tg = cible(targetId);
    assert.ok(tg.last_error, 'l’échec doit se voir sur la ligne du projet');
    assert.match(tg.last_error, /conflit|conflict/i);

    const cwd = clone();
    const gitDir = path.join(cwd, '.git');
    assert.ok(!fs.existsSync(path.join(gitDir, 'rebase-merge')) && !fs.existsSync(path.join(gitDir, 'rebase-apply')),
      'aucun rebase ne doit rester en cours');
    // La preuve que le clone est utilisable : un checkout passe encore.
    git(cwd, 'checkout', '-q', 'feature/rebase-conflit');
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/rebase-conflit');
  });

  test('un projet qui n’a pas encore tourné ne propose pas le rattrapage', async () => {
    const id = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'feature/jamais-lancee' }],
    })).body.id;
    const tg = app.db.prepare('SELECT id FROM task_target WHERE task_id = ?').get(id);
    const r = await app.api('POST', `/api/tasks/${id}/targets/${tg.id}/update-base`);
    assert.equal(r.status, 400, 'il n’y a pas de branche à rattraper');
  });

  /* --------------------------------------------------------------- l'écran ---- */

  /* Une route qui répond ne prouve pas qu'un bouton l'appelle. Et celui-ci réécrit une branche :
     s'il partait sur un clic isolé, on l'apprendrait sur une vraie merge request. */
  describe('le bouton', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let taskId; let targetId;

    before(async () => {
      ({ taskId, targetId } = await sessionPoussee('feature/rebase-ui'));
      mainAvance('e.txt', 'ui\n', 'main avance pour l’écran');
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
      await page.waitForSelector(`#taskList .card[data-task="${taskId}"]`, { state: 'visible' });
    });

    test('il est là, il nomme la branche de départ, et il DEMANDE avant de réécrire', async () => {
      const b = page.locator(`#taskList [data-tgrebase="${targetId}"]`);
      await b.waitFor();
      assert.match(await b.innerText(), /main/, 'le bouton nomme la branche qu’on rattrape');
      await b.click();
      await page.locator('#confirmModal:not([hidden])').waitFor();
      assert.match(await page.locator('#confirmText').innerText(), /RÉÉCRIT|forcé/,
        'la confirmation doit dire que l’historique est réécrit');
      const jobsAvant = nbJobsTask();
      await page.locator('#confirmCancel').click();
      await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'detached' });
      /* Prouver qu'il ne s'est RIEN passé demande de laisser sa chance à ce qui aurait pu se
         passer : on surveille la file pendant trois secondes. Un bouton qui lancerait malgré
         l'annulation créerait sa ligne de job dans la milliseconde. */
      for (let i = 0; i < 30; i += 1) {
        assert.equal(nbJobsTask(), jobsAvant, 'annuler ne doit rien avoir lancé');
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(cible(targetId).commit_sha, null);
    });

    test('confirmer lance vraiment le rattrapage', async () => {
      await page.locator(`#taskList [data-tgrebase="${targetId}"]`).click();
      await page.locator('#confirmModal:not([hidden])').waitFor();
      await page.locator('#confirmOk').click();
      // L'effet côté serveur, pas le libellé : le projet doit repasser « commité », rebasé.
      for (let i = 0; i < 900; i += 1) {
        const { body: st } = await app.api('GET', '/api/status');
        if (!st.running && !st.queued) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const tg = cible(targetId);
      assert.equal(tg.status, 'committed');
      assert.equal(tg.last_error, null, JSON.stringify(tg.last_error));
    });
  });

  /* ------------------------------------------- quand le bouton s'affiche ---- */

  /* IL NE S'AFFICHE QUE SI LA MERGE REQUEST EST EN CONFLIT. Un bouton qui réécrit une branche
     n'a pas à être proposé en permanence : la plupart du temps il n'y a rien à rattraper, et
     le proposer quand même invite à rebaser pour rien. */
  describe('l’affichage suit la forge', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    const boutonPour = async (targetId) => {
      await page.reload();
      await page.locator('nav button[data-tab="task"]').click();
      await page.waitForSelector(`#taskList [data-tgpush], #taskList [data-tgrebase], #taskList .card`, { state: 'visible' });
      return page.locator(`#taskList [data-tgrebase="${targetId}"]`).count();
    };

    test('pas de conflit : pas de bouton', async () => {
      const { targetId } = await sessionPoussee('feature/sans-conflit', { conflits: 0 });
      assert.equal(await boutonPour(targetId), 0);
    });

    test('conflit inconnu (la forge n’a pas tranché) : pas de bouton non plus', async () => {
      // GitHub calcule `mergeable` en différé. On s'abstient plutôt que de deviner.
      const { targetId } = await sessionPoussee('feature/conflit-inconnu', { conflits: null });
      assert.equal(await boutonPour(targetId), 0);
    });

    test('conflit avéré : le bouton apparaît', async () => {
      const { targetId } = await sessionPoussee('feature/avec-conflit', { conflits: 1 });
      assert.equal(await boutonPour(targetId), 1);
    });
  });

  /* -------------------------------------- ce que la découverte relève ---- */

  test('la découverte lit le conflit sur la forge, sans appel d’API de plus', async () => {
    /* L'appel `getMergeRequest` est DÉJÀ fait par la découverte pour savoir si la MR est
       mergée : on lit la réponse au passage. C'est ce qui rend le bouton gratuit. */
    const { taskId } = await sessionPoussee('feature/decouverte', { conflits: null });
    const tg = app.db.prepare('SELECT * FROM task_target WHERE task_id = ?').get(taskId);
    app.db.prepare('UPDATE task_target SET mr_iid = 77 WHERE id = ?').run(tg.id);
    app.state.mrs['grp/app'] = [{
      iid: 77, title: 'X', state: 'opened', source_branch: 'feature/decouverte',
      target_branch: 'main', web_url: 'http://x/77', sha: 'abc',
      created_at: new Date().toISOString(), author: { name: 'A' },
      has_conflicts: true,
    }];
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    const appels = app.state.calls.length;
    await app.api('POST', '/api/discover');
    assert.equal(app.db.prepare('SELECT mr_conflicts c FROM task_target WHERE id = ?').get(tg.id).c, 1);

    // Et l'inverse se relit aussi : une MR redevenue mergeable éteint le bouton.
    app.state.mrs['grp/app'][0].has_conflicts = false;
    await app.api('POST', '/api/discover');
    assert.equal(app.db.prepare('SELECT mr_conflicts c FROM task_target WHERE id = ?').get(tg.id).c, 0);
    assert.ok(app.state.calls.length > appels, 'la découverte a bien interrogé la forge');
  });
});
