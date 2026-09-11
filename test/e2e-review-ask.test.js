'use strict';
/* POSER UNE QUESTION SUR UNE REVUE, SANS LA RÉÉCRIRE.
 *
 * « Demander une modification » régénère le rapport et en fait une version de plus : demander
 * un éclaircissement coûtait donc le rapport qu'on était en train de lire, et la note pouvait
 * bouger au passage. D'où ce geste séparé — et d'où ce que ce fichier surveille.
 *
 * La promesse tient en une comparaison : après une question, le rapport, sa note et le nombre
 * de versions sont EXACTEMENT ceux d'avant. La prouver sans prouver qu'une réponse a bien été
 * produite ne prouverait rien — une route qui ne ferait rien du tout passerait le test. Les
 * deux moitiés sont donc vérifiées ensemble, et le contraste avec « Demander une modification »
 * (qui, lui, ajoute bien une version) montre que la différence est réelle.
 *
 * Un seul `startApp()` : les deux `describe` partagent l'app et le navigateur.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, poserIdentiteGit, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Questions sur une revue', () => {
  let app; let mrId; let distant; let iid = 0;
  const QUESTION = 'Pourquoi le premier constat est-il bloquant ?';

  /* Une merge request DÉJÀ REVIEWÉE : c'est le point de départ de toute question. On la
     fabrique comme les autres tests de review — une branche sur un vrai dépôt, la découverte,
     puis une review en dry-run — plutôt que d'écrire une ligne `review` à la main : c'est le
     rapport sur le disque qui part dans le prompt, et un faux rapport ne prouverait rien. */
  async function mrReviewee() {
    iid += 1;
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', `feature/q${iid}`);
    fs.writeFileSync(path.join(distant, `f${iid}.js`), `const a = ${iid};\nmodule.exports = { a };\n`);
    git('add', '-A'); git('commit', '-qm', `ajout ${iid}`);
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    app.state.mrs['grp/app'] = [{
      iid, title: `Sujet ${iid}`, state: 'opened', source_branch: `feature/q${iid}`,
      target_branch: 'main', web_url: `http://x/${iid}`, sha: head,
      created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    const id = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === iid).id;
    await app.api('POST', `/api/mrs/${id}/review`);
    await waitForJobs(app.api);
    return id;
  }

  // L'état du rapport, tel qu'il ne doit pas changer.
  async function etatRapport() {
    const d = (await app.api('GET', `/api/mrs/${mrId}`)).body;
    const versions = (await app.api('GET', `/api/mrs/${mrId}/versions`)).body;
    return {
      md: (d.review || {}).md || '',
      versions: versions.map((v) => [v.version, v.kind, v.note10]),
    };
  }
  const echanges = async (n) => (await app.api('GET', `/api/mrs/${mrId}/passes${n ? `?n=${n}` : ''}`)).body;

  before(async () => {
    app = await startApp();
    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-depot-'));
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    git('init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    await app.configure();
    await app.api('POST', '/api/repos', { project: 'grp/app', url: distant });
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    mrId = await mrReviewee();
  });
  after(async () => { if (app) await app.stop(); });

  test('une question produit une réponse, et RIEN d’autre ne bouge', async () => {
    const avant = await etatRapport();
    assert.ok(avant.md.trim(), 'le rapport de départ existe');

    const r = await app.api('POST', `/api/mrs/${mrId}/ask`, { question: QUESTION });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'ask-review');
    await waitForJobs(app.api);

    const d = await echanges();
    assert.deepEqual(d.passes.map((p) => p.kind), ['question']);
    assert.equal(d.passes[0].prompt, QUESTION, 'la question est gardée telle qu’elle a été posée');
    assert.ok((d.current.output || '').trim(), 'une réponse a bien été produite');

    assert.deepEqual(await etatRapport(), avant, 'le rapport, sa note et ses versions sont intacts');
  });

  test('une question vide est refusée, avec une phrase', async () => {
    const r = await app.api('POST', `/api/mrs/${mrId}/ask`, { question: '   ' });
    assert.equal(r.status, 400);
    assert.ok(!/^err\./.test(r.body.error), `clé brute renvoyée : ${r.body.error}`);
  });

  test('les questions s’empilent, la plus récente ne remplace pas la précédente', async () => {
    await app.api('POST', `/api/mrs/${mrId}/ask`, { question: 'Et sur l’autre appelant ?' });
    await waitForJobs(app.api);
    const d = await echanges();
    assert.equal(d.passes.length, 2);
    assert.deepEqual(d.passes.map((p) => p.n), [1, 2]);
    // Chacune se relit avec SA réponse : c'est ce qui fait un fil, et pas un presse-papier.
    const premiere = await echanges(1);
    assert.equal(premiere.current.prompt, QUESTION);
    assert.ok((premiere.current.output || '').trim());
  });

  /* LE CONTRASTE. Sans lui, on ne saurait pas si « rien n'a bougé » vient de la fonctionnalité
     ou d'un pipeline qui ne fait rien : une demande de MODIFICATION, elle, ajoute une version. */
  test('une demande de modification, elle, ajoute bien une version', async () => {
    const avant = await etatRapport();
    await app.api('POST', `/api/mrs/${mrId}/modify`, { instruction: 'Sois plus concis.' });
    await waitForJobs(app.api);
    const apres = await etatRapport();
    assert.equal(apres.versions.length, avant.versions.length + 1);
    assert.equal(apres.versions[0][1], 'modify');
  });

  /* Supprimer le rapport emporte les questions : elles le citent, et les relire sans lui ne
     dirait plus rien de ce qui avait été demandé. */
  test('supprimer le rapport emporte ses échanges', async () => {
    assert.ok((await echanges()).passes.length >= 1);
    await app.api('POST', `/api/mrs/${mrId}/delete-review`);
    assert.deepEqual((await echanges()).passes, []);
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; let mr2;
    const erreurs = [];

    before(async () => {
      // La MR du bloc précédent a perdu son rapport : on en reviewe une autre pour l'écran.
      mr2 = await mrReviewee();
      await app.api('POST', `/api/mrs/${mr2}/ask`, { question: 'Le point 1 vaut-il pour les deux appelants ?' });
      await waitForJobs(app.api);

      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="review"]').click();
      await page.locator('.segmented [data-seg="reviewed"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#reportList .card').length > 0);
      await page.locator(`#reportList .card[data-id="${mr2}"]`).click();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('les échanges sont affichés sous le rapport, question et réponse ensemble', async () => {
      await page.waitForSelector('#askHistory .ask-entry');
      assert.match(await page.locator('#askHistory .ask-q').first().textContent(), /les deux appelants/);
      assert.ok((await page.locator('#askHistory .ask-a').first().textContent()).trim().length > 10,
        'la réponse est là, pas seulement la question');
    });

    test('poser une question depuis l’écran ne touche pas au rapport affiché', async () => {
      const avant = await page.locator('#mdView').textContent();
      await page.locator('#askInput').fill('Et la couverture de test sur ce chemin ?');
      await page.locator('#btnAsk').click();
      /* On attend l'EFFET, pas l'horloge : la réponse arrive par un job de fond, et l'écran
         pose d'abord l'attente. Le fil compte deux échanges une fois la réponse là. */
      await page.waitForFunction(() => document.querySelectorAll('#askHistory .ask-entry').length >= 2);
      await page.waitForFunction(
        () => [...document.querySelectorAll('#askHistory .ask-a')].every((e) => e.textContent.trim().length > 10),
        null, { timeout: 30000 },
      );
      assert.equal(await page.locator('#mdView').textContent(), avant, 'le rapport à l’écran n’a pas changé');
    });

    test('aucune erreur JavaScript pendant tout ce parcours', () => {
      assert.deepEqual(erreurs, []);
    });
  });
});
