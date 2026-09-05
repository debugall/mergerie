'use strict';
/* REPRENDRE LE RAPPORT DE REVIEW DANS UN SUIVI.
 *
 * Le trajet naturel après une review : la merge request a un rapport, on veut que l'IA en
 * traite les constats. Le bouton du rapport (« Faire corriger le code par l'IA ») ouvre pour
 * cela une NOUVELLE session ; depuis la session qui a produit la branche, c'est un SUIVI qu'on
 * veut — l'agent reprend son propre fil au lieu de redécouvrir le code.
 *
 * Trois choses se prouvent ici :
 *   1. le prompt est bâti sur le rapport RÉELLEMENT enregistré, pas sur un texte du navigateur ;
 *   2. le bouton n'apparaît QUE s'il y a un rapport — un bouton qui répond « aucun rapport »
 *      une fois cliqué fait perdre un geste et n'apprend rien ;
 *   3. il ne détruit pas ce qui est écrit sans demander : le champ garde un brouillon
 *      enregistré, parfois rédigé plusieurs jours plus tôt.
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

describe('Suivi pré-rempli avec le rapport de review', () => {
  let app; let repoId; let distant; let navigateur; let page;
  let avecRapport; let sansRapport; let branche;

  before(async () => {
    app = await startApp();
    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-'));
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    git('init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    branche = 'feature/PROJ-1-refonte';
    git('checkout', '-q', '-b', branche);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'tete\n');
    git('add', '-A'); git('commit', '-qm', 'tete');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');

    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: distant })).body.id;
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    app.state.mrs['grp/app'] = [{
      iid: 42, title: 'Refonte', state: 'opened', source_branch: branche, target_branch: 'main',
      web_url: 'http://x/42', sha: head, created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    const mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 42).id;

    // Un VRAI rapport, produit par la vraie review (COPILOT_DRY_RUN).
    await app.api('POST', `/api/mrs/${mrId}/review`);
    for (let i = 0; i < 900; i += 1) {
      const { body: st } = await app.api('GET', '/api/status');
      if (!st.running && !st.queued) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // La session dont sort la branche : c'est elle qui doit proposer le bouton.
    avecRapport = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'refonte', targets: [{ repo_id: repoId, branch: branche }],
    })).body.id;
    // Et une autre, sur une branche qui n'a pas de merge request reviewée.
    sansRapport = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'autre chose', targets: [{ repo_id: repoId, branch: 'feature/PROJ-2-autre' }],
    })).body.id;
    /* « Envoyer un suivi » n'apparaît que sur une session dont le travail est commité ou poussé
       — c'est l'état où l'on se trouve quand la merge request existe et a été reviewée. On y
       met donc les deux sessions, sans quoi il n'y a même pas de formulaire à remplir. */
    app.db.prepare("UPDATE task_target SET status = 'pushed' WHERE task_id IN (?, ?)")
      .run(avecRapport, sansRapport);
    app.db.prepare("UPDATE task SET status = 'pushed' WHERE id IN (?, ?)")
      .run(avecRapport, sansRapport);

    if (dispo) {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(app.base);
    }
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const rapportSurDisque = () => fs.readFileSync(
    app.db.prepare(`SELECT review.md_path FROM review JOIN mr ON mr.id = review.mr_id
      WHERE mr.iid = 42`).get().md_path, 'utf8').trim();

  /* ----------------------------------------------------------- le serveur ---- */

  test('la session sait qu’un de ses projets a un rapport', async () => {
    const { body } = await app.api('GET', '/api/tasks');
    const avec = body.find((t) => t.id === avecRapport);
    const sans = body.find((t) => t.id === sansRapport);
    assert.ok(avec.targets[0].has_review, 'le bouton doit pouvoir apparaître');
    assert.ok(!sans.targets[0].has_review, 'et rester absent quand il n’y a rien à reprendre');
  });

  test('le prompt est bâti sur le rapport ENREGISTRÉ, et nomme la branche', async () => {
    const { status, body } = await app.api('GET', `/api/tasks/${avecRapport}/review-prompt`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.prompt.includes(rapportSurDisque()),
      'le rapport doit y figurer intégralement — c’est lui que l’IA doit traiter');
    assert.ok(body.prompt.includes(branche), 'la branche situe la demande');
    assert.deepEqual(body.projets, [{ project: 'grp/app', iid: 42 }]);
  });

  test('sans rapport, la route refuse — elle ne rend pas un prompt vide', async () => {
    const { status } = await app.api('GET', `/api/tasks/${sansRapport}/review-prompt`);
    assert.equal(status, 400);
  });

  test('restreindre à un projet ne rend que le sien', async () => {
    const { body: liste } = await app.api('GET', '/api/tasks');
    const cible = liste.find((t) => t.id === avecRapport).targets[0];
    const { body } = await app.api('GET', `/api/tasks/${avecRapport}/review-prompt?target_id=${cible.id}`);
    assert.deepEqual(body.projets, [{ project: 'grp/app', iid: 42 }]);
    const { status } = await app.api('GET', `/api/tasks/${avecRapport}/review-prompt?target_id=999999`);
    assert.equal(status, 400, 'un projet sans rapport ne rend rien, même dans une session qui en a un');
  });

  /* ------------------------------------------------------------- l'écran ---- */

  describe('dans le navigateur', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    const form = () => page.locator(`.followup[data-followform="${avecRapport}"]`);

    test('le bouton n’est là que sur la session qui a un rapport', async () => {
      await page.locator('nav button[data-tab="task"]').click();
      await page.waitForSelector(`#taskList .card[data-task="${avecRapport}"]`, { state: 'visible' });
      await page.locator(`#taskList .card[data-task="${avecRapport}"] [data-tfollow]`).first().click();
      await form().waitFor();
      assert.equal(await form().locator('[data-followreview]').count(), 1);

      await page.locator(`#taskList .card[data-task="${sansRapport}"] [data-tfollow]`).first().click();
      const autre = page.locator(`.followup[data-followform="${sansRapport}"]`);
      await autre.waitFor();
      assert.equal(await autre.locator('[data-followreview]').count(), 0,
        'un bouton qui répondrait « aucun rapport » ferait perdre un geste');
    });

    test('il remplit le champ avec le prompt du rapport', async () => {
      const champ = form().locator('.followup-text');
      await champ.fill('');
      await form().locator('[data-followreview]').click();
      await page.waitForFunction(
        (id) => (document.querySelector(`.followup[data-followform="${id}"] .followup-text`).value || '').length > 50,
        avecRapport, { timeout: 20000 },
      );
      const v = await champ.inputValue();
      assert.ok(v.includes(rapportSurDisque()), 'c’est bien le rapport qui atterrit dans le champ');
    });

    test('il DEMANDE avant d’écraser ce qui est déjà écrit', async () => {
      const champ = form().locator('.followup-text');
      await champ.fill('mon brouillon de la semaine dernière');
      await form().locator('[data-followreview]').click();
      await page.locator('#confirmModal:not([hidden])').waitFor({ timeout: 15000 });
      await page.locator('#confirmCancel').click();
      await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'detached' });
      assert.equal(await champ.inputValue(), 'mon brouillon de la semaine dernière',
        'annuler doit laisser le brouillon exactement où il était');
    });

    test('et remplace bien quand on confirme', async () => {
      const champ = form().locator('.followup-text');
      await form().locator('[data-followreview]').click();
      await page.locator('#confirmModal:not([hidden])').waitFor({ timeout: 15000 });
      await page.locator('#confirmOk').click();
      await page.waitForFunction(
        (id) => (document.querySelector(`.followup[data-followform="${id}"] .followup-text`).value || '').includes('RAPPORT DE REVUE'),
        avecRapport, { timeout: 20000 },
      );
      assert.ok((await champ.inputValue()).includes(rapportSurDisque()));
    });
  });
});
