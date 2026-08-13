'use strict';
/* CE QUI SE VOIT PENDANT QU'UNE VÉRIFICATION TOURNE.
 *
 * Cliquer « Vérifier » sur une merge request lance un JOB : la requête répond tout de suite, le
 * travail dure des minutes. Le `busy()` du clic retombait donc avant même que le run commence,
 * et plus rien à l'écran ne disait qu'une vérification était en cours — ni au retour sur
 * l'onglet, ni après un rechargement de la page.
 *
 * L'état vit côté serveur (`/api/status` → `targets`), c'est ce qui lui permet de survivre à un
 * re-rendu de la liste, à un changement d'onglet et à un F5. Ce test part donc de la charge
 * utile que le serveur renvoie et regarde ce que l'écran en fait — c'est exactement le trajet
 * que parcourt le rafraîchissement périodique.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Vérification : ce qui se voit pendant qu’elle tourne', { skip: dispo ? false : 'chromium absent' }, () => {
  let app; let navigateur; let page; let mrId;

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 100, title: 'Ajoute un endpoint /health', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/100',
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!100'] = [{ new_path: 'src/app.js' }];
    await app.configure();
    const repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;
    // Un vérificateur couvrant le dépôt : sans lui, le bouton naît désactivé.
    await app.api('POST', '/api/verifiers', {
      name: 'tests unitaires', kind: 'commands', commands: ['true'],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
    await page.waitForSelector('#toReviewList .card [data-verify]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // `marquerEnCours` est ce que le rafraîchissement périodique appelle avec la réponse du
  // serveur : on lui donne la même charge utile, sans attendre un vrai run de plusieurs minutes.
  const etat = (cibles) => page.evaluate((c) => {
    marquerEnCours(c); // eslint-disable-line no-undef
    const b = document.querySelector('#toReviewList [data-verify]');
    return {
      carte: !!document.querySelector('#toReviewList .card.running-now'),
      occupe: !!b.querySelector('.spin'),
      libelle: b.textContent.trim(),
      desactive: b.disabled,
      titre: b.title,
    };
  }, cibles);

  test('la carte se marque et le bouton tourne tant que le job dure', async () => {
    const avant = await etat(null);
    assert.deepEqual({ carte: avant.carte, occupe: avant.occupe }, { carte: false, occupe: false },
      'au repos, rien ne bouge');

    const pendant = await etat({ mrs: [mrId], tasks: [], locals: [], verifying: [mrId] });
    assert.equal(pendant.carte, true, 'la carte porte le repère « en cours », comme pour une review');
    assert.equal(pendant.occupe, true, 'et le bouton « Vérifier » tourne : c’est SA commande qui travaille');
    assert.match(pendant.libelle, /Vérification/, 'il le DIT : un rond qui tourne sans mot oblige à se rappeler sur quoi on a cliqué');
    assert.equal(pendant.desactive, true, 'un deuxième clic ne peut pas relancer la même vérification');
    assert.match(pendant.titre, /en cours|running/i, 'et l’infobulle le dit avec des mots');

    const apres = await etat({ mrs: [], tasks: [], locals: [], verifying: [] });
    assert.deepEqual({ carte: apres.carte, occupe: apres.occupe, desactive: apres.desactive },
      { carte: false, occupe: false, desactive: false }, 'tout est rendu quand le job se termine');
    assert.equal(apres.libelle, avant.libelle, '…y compris le libellé d’origine, à l’identique');
  });

  /* UNE REVIEW N'EST PAS UNE VÉRIFICATION. La carte se marque dans les deux cas — c'est la même
     question, « est-ce qu'on travaille dessus ? » —, mais faire tourner le bouton « Vérifier »
     pendant une review désignerait la mauvaise commande. */
  test('une review marque la carte sans faire tourner le bouton « Vérifier »', async () => {
    const pendant = await etat({ mrs: [mrId], tasks: [], locals: [], verifying: [] });
    assert.equal(pendant.carte, true);
    assert.equal(pendant.occupe, false, 'le bouton « Vérifier » ne prétend pas travailler');
    assert.equal(pendant.desactive, false);
    await etat(null);
  });
});
