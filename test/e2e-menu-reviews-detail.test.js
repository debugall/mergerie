'use strict';
/* MENU « REVIEWS » — LE RAPPORT OUVERT (`#reportDetail`), BOUTON PAR BOUTON.
 *
 * Ce que le panneau de droite rend, et ce que chaque commande y déclenche : l'onglet
 * « Explication » et sa génération à la demande, « Copier », les versions et leur sélecteur,
 * « Demander une modification », les constats (pastilles de gravité, « masquer les résolus »,
 * « pourquoi ? », « corriger ceci », « en brouillons »), le menu « ⋯ » (contexte, converger,
 * vérifier, relancer, relancer sur le delta, todo, supprimer), le badge « périmé », « Faire
 * corriger », « Merger », les commentaires de la forge, les todos et les notes qui citent la MR,
 * et « voir tous les échanges ».
 *
 * Déjà prouvés ailleurs, dans un navigateur, et donc pas rejoués ici : « Marquer traitée » /
 * « Rouvrir » et la place des actions (`e2e-reports-ui`), « Publier le rapport »
 * (`e2e-review-publish-ui`), « Publier le lien » (`e2e-data-sync`), poser une question
 * (`e2e-review-ask`), un constat qui mène à sa ligne (`e2e-ameliorations`), la vue plein écran
 * « Ouvrir le code » (`e2e-diff-tree-ui`, `e2e-inline-comment-ui`).
 *
 * L'effet de chaque geste est relu côté serveur ; le presse-papiers est remplacé par un relevé
 * en mémoire (aucune permission de navigateur à accorder).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, pushChange, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Reviews — le rapport ouvert', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repo;
  const id = {};
  const erreurs = [];

  async function auRepos() {
    await attendreServeur(async () => {
      const { body } = await app.api('GET', '/api/status');
      return body && !body.running && !body.queued;
    }, 'plus aucun job en cours', 60000);
  }
  const versions = async (iid) => (await app.api('GET', `/api/mrs/${id[iid]}/versions`)).body;
  const detail = async (iid) => (await app.api('GET', `/api/mrs/${id[iid]}`)).body;

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [21, 22].map((iid) => ({
      iid, title: iid === 21 ? 'Ajoute la colonne c' : 'Renomme le module', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`,
      sha: repo.branchSha, created_at: `2026-03-${iid}T10:00:00.000Z`, author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }));
    for (const iid of [21, 22]) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }, { new_path: 'db/migration.sql' }];
    // Un fil général déjà présent sur la forge : c'est ce que la boîte « Commentaires » relit.
    app.state.discussions['grp/app!21'] = [{
      id: 'disc-general', notes: [{ id: 650, body: 'Déjà relu par l’équipe produit.', system: false,
        author: { name: 'Claire', username: 'claire' }, position: null }],
    }];
    await app.configure();
    const repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/verifiers', {
      name: 'tests unitaires', kind: 'commands', commands: ['true'], repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;
    // « Review seule » : sans explication, pour que l'onglet propose de la générer.
    for (const iid of [21, 22]) {
      await app.api('POST', `/api/mrs/${id[iid]}/review`, { explain: false });
      await waitForJobs(app.api);
    }
    await auRepos();

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(String(t)); }, readText: async () => window.__copies.at(-1) || '' },
      });
    });
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    await page.locator('[data-seg="reviewed"]').click();
    await page.waitForSelector(`#reportList .card[data-id="${id[21]}"]`);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Ouvre (ou rouvre) le rapport d'une MR par un clic sur sa carte — un clic explicite rend
     toujours. `pret` : une condition que SEUL le rendu attendu satisfait. */
  async function ouvrir(iid, pret = null) {
    await page.locator(`#reportList .card[data-id="${id[iid]}"]`).click();
    await page.waitForFunction((n) => {
      const t = document.querySelector('#reportDetail .title');
      return t && t.textContent.includes(`!${n}`) && document.querySelector('#aMore');
    }, iid);
    if (pret) await page.waitForFunction(pret);
  }
  async function menu() {
    await page.locator('#aMore').click();
    await page.waitForSelector('#reportDetail .split-menu:not([hidden])');
  }
  // La forge annonce la nouvelle tête de branche : c'est ce qui rend un rapport « périmé ».
  function avancerBranche(sha) {
    app.state.mrs['grp/app'].forEach((m) => { m.sha = sha; m.diff_refs = { ...m.diff_refs, head_sha: sha }; });
  }
  const derniereCopie = () => page.evaluate(() => window.__copies.at(-1) || '');
  async function fermerModaleSession() {
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  }

  /* ------------------------------------------------------------ lecture ---- */

  test('ouvrir un rapport : en-tête, commit relu, rapport rendu et adresse propre', async () => {
    await ouvrir(21);
    assert.match(await page.locator('#mdView').textContent(), /Rapport de revue \(mock\)/);
    const codes = await page.$$eval('#reportDetail .meta code', (cs) => cs.map((c) => c.textContent.trim()));
    assert.ok(codes.includes(repo.branchSha.slice(0, 8)), `le SHA relu est affiché — vu : ${JSON.stringify(codes)}`);
    assert.match(page.url(), new RegExp(`#/reviews/${id[21]}$`));
  });

  test('onglet « Explication » : absente, elle se génère à la demande', async () => {
    await page.locator('#reportDetail .tabbar [data-view="explanation"]').click();
    await page.waitForSelector('#genExplain');
    await page.locator('#genExplain').click();
    await attendreServeur(async () => /Explication/.test((await detail(21)).review.explanation || ''),
      'l’explication est enregistrée');
    await auRepos();
    await ouvrir(21);
    await page.locator('#reportDetail .tabbar [data-view="explanation"]').click();
    await page.waitForFunction(() => /Explication \(mock\)/.test(document.querySelector('#mdView').textContent));
  });

  test('« Copier » copie le Markdown de l’onglet affiché', async () => {
    await page.locator('#mdCopy').click();
    await page.waitForFunction(() => /^# Explication/.test(window.__copies.at(-1) || ''));
    await page.locator('#reportDetail .tabbar [data-view="review"]').click();
    await page.locator('#mdCopy').click();
    await page.waitForFunction(() => /^# Rapport de revue/.test(window.__copies.at(-1) || ''));
    assert.match(await derniereCopie(), /## Note globale/, 'le Markdown brut, pas le texte rendu');
  });

  /* ----------------------------------------------------------- constats ---- */

  test('les pastilles de gravité masquent puis rendent leurs constats', async () => {
    await page.waitForSelector('#findingsChips:not([hidden]) [data-f-sev-chip="blocker"]');
    const bloquant = page.locator('#findingsList .finding[data-sev="blocker"]');
    assert.equal(await bloquant.isVisible(), true);
    await page.locator('[data-f-sev-chip="blocker"]').click();
    await bloquant.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#findingsList .finding[data-sev="major"]').isVisible(), true, 'les autres restent');
    await page.locator('[data-f-sev-chip="blocker"]').click();
    await bloquant.waitFor({ state: 'visible' });
  });

  test('« pourquoi ce constat ? » prépare la question, sans l’envoyer', async () => {
    // Le diff range ses fichiers par ordre alphabétique : le bloquant simulé est db/migration.sql.
    await page.locator('#findingsList .finding[data-sev="blocker"] [data-f-ask]').click();
    await page.waitForFunction(() => /Point de revue sur db\/migration\.sql/.test(document.querySelector('#askInput').value));
    const { body } = await app.api('GET', `/api/mrs/${id[21]}/passes`);
    assert.equal((body.passes || []).filter((p) => p.id).length, 0, 'aucune question n’est partie');
    await page.locator('#askInput').fill('');
  });

  test('« corriger ceci » ouvre une session de codage sur CE constat', async () => {
    await page.locator('#findingsList .finding[data-sev="major"] [data-f-fix]').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    const prompt = await page.locator('#taskForm [name="prompt"]').inputValue();
    assert.match(prompt, /Point de revue sur src\/app\.js/);
    assert.doesNotMatch(prompt, /Point de revue sur db\/migration\.sql/, 'un seul constat, pas le rapport entier');
    await fermerModaleSession();
  });

  test('« en brouillons » pose les constats en remarques inline non envoyées', async () => {
    /* Le geste RÉÉCRIT le rapport (le badge « brouillons » de l'en-tête doit suivre). On marque
       l'écran d'avant, et l'on attend un écran qui ne porte plus la marque : sans quoi le test
       suivant taperait dans un champ que ce rendu tardif remplacerait — et sa saisie partirait
       avec lui. */
    await page.evaluate(() => { document.querySelector('#aMore').dataset.ecranPrecedent = '1'; });
    await page.locator('#findingsChips [data-f-drafts="all"]').click();
    await attendreServeur(async () => (await app.api('GET', `/api/mrs/${id[21]}/comment-drafts`)).body.drafts.length > 0,
      'les constats sont devenus des brouillons');
    await page.waitForFunction(() => {
      const b = document.querySelector('#aMore');
      const fente = document.querySelector('#reportDetail [data-drafts-slot]');
      return b && !b.dataset.ecranPrecedent && fente && fente.textContent.trim() !== '';
    });
    assert.equal(app.state.calls.filter((c) => c.method === 'POST' && /\/discussions$/.test(c.path)).length, 0,
      'rien n’est parti vers la forge');
  });

  /* ---------------------------------------------------- versions et passes ---- */

  test('« Demander une modification » produit une v2, rappelée dans l’historique des demandes', async () => {
    await page.locator('#modifyInput').fill('Insiste sur la migration SQL');
    await page.locator('#btnModify').click();
    await attendreServeur(async () => (await versions(21)).some((v) => v.kind === 'modify'), 'la version « modify » existe');
    await auRepos();
    await page.waitForFunction(() => document.querySelector('#modifyInput').value === '', null);
    await ouvrir(21, () => !document.querySelector('#modifyHistory').hidden);
    assert.match(await page.locator('#modifyHistory').textContent(), /Insiste sur la migration SQL/);
  });

  test('le sélecteur de versions relit une version antérieure et le signale', async () => {
    await page.waitForSelector('#mdVersion:not([hidden])');
    assert.equal(await page.locator('#mdVersion option').count(), 2);
    await page.selectOption('#mdVersion', '1');
    await page.waitForSelector('#mdVersionNote:not([hidden])');
    assert.match(await page.locator('#mdVersionNote').textContent(), /version 1 sur 2/);
    await page.selectOption('#mdVersion', '2');
    await page.waitForSelector('#mdVersionNote', { state: 'hidden' });
  });

  test('⋯ → « Relancer la review » ajoute une passe complète', async () => {
    await menu();
    await page.locator('#aRe').click();
    await attendreServeur(async () => (await versions(21)).length === 3, 'une v3 existe');
    await auRepos();
  });

  test('une branche qui bouge rend le rapport « périmé » ; ⋯ → « sur le delta » relit et marque le résolu', async () => {
    // La correction supprime le fichier de la migration : son constat doit se lire « résolu ».
    avancerBranche(pushChange(repo, 'src/app.js', 'const a = 1;\nconst b = 3;\nmodule.exports = { a, b };\n', 'fix: b', ['db/migration.sql']));
    await app.api('POST', '/api/discover');
    await attendreServeur(async () => (await detail(21)).stale === true, 'le rapport est périmé');

    await ouvrir(21, () => !!document.querySelector('#aStaleRe'));
    await menu();
    await page.locator('#aReInc').click();
    await attendreServeur(async () => (await versions(21)).length === 4, 'une v4 existe');
    await auRepos();
    assert.equal((await detail(21)).stale, false, 'le rapport porte de nouveau sur la tête de branche');

    await ouvrir(21, () => !document.querySelector('#aStaleRe') && !!document.querySelector('#masquerResolus'));
    const resolu = page.locator('#findingsList .finding[data-status="resolved"]');
    assert.equal(await resolu.first().isVisible(), true);
    await page.locator('#masquerResolus').click();
    await resolu.first().waitFor({ state: 'hidden' });
    await page.locator('#masquerResolus').click();
    await resolu.first().waitFor({ state: 'visible' });
  });

  test('le badge « périmé » lance lui-même la relecture du delta', async () => {
    avancerBranche(pushChange(repo, 'src/app.js', 'const a = 1;\nconst b = 4;\nmodule.exports = { a, b };\n', 'fix: b encore'));
    await app.api('POST', '/api/discover');
    await attendreServeur(async () => (await detail(21)).stale === true, 'le rapport est de nouveau périmé');
    await ouvrir(21, () => !!document.querySelector('#aStaleRe'));
    await page.locator('#aStaleRe').click();
    await attendreServeur(async () => (await versions(21)).length === 5, 'une v5 existe');
    await auRepos();
    assert.equal((await detail(21)).stale, false);
  });

  /* ------------------------------------------------------------ le menu ⋯ ---- */

  test('⋯ → « Contexte » ouvre la modale du contexte de cette MR, « Annuler » la ferme', async () => {
    await ouvrir(21);
    await menu();
    await page.locator('#aTicket').click();
    await page.waitForSelector('#ticketModal:not([hidden])');
    assert.match(await page.locator('#ticketMrTitle').textContent(), /!21/);
    await page.locator('#ticketCancel').click();
    await page.waitForSelector('#ticketModal', { state: 'hidden' });
  });

  test('⋯ → « Converger » ouvre la modale pré-remplie des réglages, « Annuler » ne lance rien', async () => {
    await menu();
    await page.locator('#aConverge').click();
    await page.waitForSelector('#convergeModal:not([hidden])');
    assert.equal(await page.locator('#convThreshold').inputValue(), '8');
    assert.equal(await page.locator('#convPasses').inputValue(), '3');
    assert.match(await page.locator('#convergeModalWhat').textContent(), /!21/);
    await page.locator('#convCancel').click();
    await page.waitForSelector('#convergeModal', { state: 'hidden' });
    const { body } = await app.api('GET', '/api/jobs/current');
    assert.ok(!body.running && !body.queued, 'aucune convergence n’est partie');
  });

  test('⋯ → « Vérifier » lance la vérification de la MR ouverte', async () => {
    await menu();
    await page.locator('#aVerify').click();
    await page.waitForSelector('#verifyPickModal:not([hidden])');
    await page.locator('#verifyPickGo').click();
    await attendreServeur(async () => (await app.api('GET', `/api/verifications?mr_id=${id[21]}`)).body.verifications.length > 0,
      'une vérification porte sur !21');
    await auRepos();
  });

  test('⋯ → « Ajouter une todo » crée une todo liée ; le rapport la montre, et la cocher la clôt', async () => {
    await ouvrir(21);
    await menu();
    await page.locator('#reportDetail [data-add-todo="mr"]').click();
    await page.waitForSelector('#captureModal:not([hidden])');
    assert.match(await page.locator('#captureTitle').inputValue(), /!21/);
    await page.locator('#captureOk').click();
    let todo = null;
    await attendreServeur(async () => {
      todo = (await app.api('GET', '/api/todos')).body.todos.find((x) => x.link_kind === 'mr' && String(x.link_ref) === String(id[21]));
      return !!todo;
    }, 'la todo liée à !21 existe');

    await ouvrir(21, () => !!document.querySelector('#reportDetail .report-todos'));
    await page.locator(`#reportDetail .report-todos [data-todo-check="${todo.id}"]`).click();
    await attendreServeur(async () => (await app.api('GET', '/api/todos?status=done')).body.todos.some((x) => x.id === todo.id),
      'la todo est faite');
  });

  test('une note qui cite la MR apparaît dans le rapport, et y mène', async () => {
    const pageNote = (await app.api('POST', '/api/notes', { title: 'Réunion du lundi', content: 'On a parlé de !21 : la migration doit attendre la release.' })).body;
    assert.ok(pageNote && pageNote.id, JSON.stringify(pageNote));
    await ouvrir(21, () => !!document.querySelector('#reportDetail .report-cites'));
    assert.match(await page.locator('#reportDetail .report-cites').textContent(), /Réunion du lundi/);
    await page.locator(`#reportDetail [data-cite-page="${pageNote.id}"]`).click();
    await page.waitForSelector('#tab-notes.active');
    await page.waitForFunction((pid) => window.location.hash === `#/notes/${pid}`, pageNote.id);
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#tab-review.active');
  });

  test('« voir tous les échanges » ouvre la vue des itérations de la revue', async () => {
    await app.api('POST', `/api/mrs/${id[21]}/ask`, { question: 'Pourquoi la colonne c ?' });
    await waitForJobs(app.api);
    await auRepos();
    await ouvrir(21, () => !!document.querySelector('#askSeeAll'));
    await page.locator('#askSeeAll').click();
    await page.waitForSelector('#taskMdView:not([hidden])');
    assert.match(await page.locator('#taskMdTitle').textContent(), /!21/);
    await page.locator('#taskMdClose').click();
    await page.waitForSelector('#taskMdView', { state: 'hidden' });
  });

  /* ------------------------------------------------ actions principales ---- */

  test('« Faire corriger le code par l’IA » ouvre une session pré-remplie du rapport', async () => {
    await ouvrir(21);
    await page.locator('#aFix').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.match(await page.locator('#taskModalTitle').textContent(), /!21/);
    assert.match(await page.locator('#taskForm [name="prompt"]').inputValue(), /Rapport de revue/);
    await fermerModaleSession();
  });

  test('les commentaires de la forge se lisent, et « Commenter » en poste un', async () => {
    await page.waitForFunction(() => /Déjà relu par l’équipe produit/.test(document.querySelector('#mrComments').textContent));
    await page.locator('#commentInput').fill('Merci, je relis la migration demain.');
    await page.locator('#btnComment').click();
    await attendreServeur(async () => app.state.calls.some((c) => c.method === 'POST'
      && /merge_requests\/21\/notes$/.test(c.path) && c.body && c.body.body === 'Merci, je relis la migration demain.'),
    'la forge a reçu le commentaire');
    await page.waitForFunction(() => document.querySelector('#commentInput').value === '');
    assert.ok((await detail(21)).comments.some((c) => /je relis la migration/.test(c.body)), 'et il est journalisé');
  });

  test('« Merger » : « Annuler » ne touche pas la forge, la confirmation merge et le rapport le montre', async () => {
    await ouvrir(22);
    await page.locator('#aMerge').click();
    await page.waitForSelector('#mergeModal:not([hidden])');
    assert.match(await page.locator('#mergeModalIntro').textContent(), /!22/);
    await page.locator('#mergeCancel').click();
    await page.waitForSelector('#mergeModal', { state: 'hidden' });
    const merge22 = () => app.state.calls.some((c) => c.method === 'PUT' && /merge_requests\/22\/merge/.test(c.path));
    assert.equal(merge22(), false, 'rien n’est parti');

    await page.locator('#aMerge').click();
    await page.waitForSelector('#mergeModal:not([hidden])');
    await page.locator('#mergeGo').click();
    await attendreServeur(async () => (await detail(22)).mr.closed_seen === 1, '!22 est mergée');
    assert.equal(merge22(), true);
    await page.waitForFunction(() => !document.querySelector('#aMerge') && !!document.querySelector('#reportDetail .tag.merged'));
  });

  test('⋯ → « Supprimer le rapport » demande confirmation, puis renvoie la MR dans la file', async () => {
    await menu();
    await page.locator('#aDelReport').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => {
      const d = await detail(22);
      return !d.review && d.mr.status === 'to_review';
    }, 'le rapport de !22 est supprimé');
    await page.waitForFunction((n) => !document.querySelector(`#reportList .card[data-id="${n}"]`), id[22]);
    assert.equal(await page.locator('#aMore').count(), 0, 'le panneau revient au résumé');
  });

  test('aucune erreur de page sur tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
