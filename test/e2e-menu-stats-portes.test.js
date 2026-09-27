'use strict';
/* MENU « STATISTIQUES » — CHAQUE NOMBRE EST UNE PORTE.
 *
 * Un tableau qui décrit sans donner de chemin fait relire des chiffres qu'on ne peut pas
 * suivre. L'écran en ouvre donc sept :
 *   - « En attente » et « Pire » d'un projet → Reviews, au bon stade, filtré sur ce projet ;
 *   - une ligne des sessions les plus chères → la carte de CETTE session, dans la bonne saveur
 *     (codage, hors dépôt, question libre… et exploration) ;
 *   - un agent du « coût par agent » → Dev IA filtré sur ses sessions ;
 *   - une review la plus chère → son rapport ;
 *   - « En faire une règle » → le formulaire de règle PRÉ-REMPLI, rien d'enregistré sans clic.
 *
 * On vérifie à chaque fois l'EFFET : l'adresse posée (`#/sessions/…`, `#/reviews/…`), les cartes
 * réellement listées, et côté serveur ce qui a été (ou non) enregistré.
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');
const seed = require('./helpers/stats-seed');

const { dispo } = navigateurDispo();

describe('Menu Statistiques — les portes', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  let donnees; let agent;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    // Un agent qui CODE : ses runs semés sont des sessions de codage (`stats-seed`, kind « code »).
    const cree = await app.api('POST', '/api/agents', { name: 'Agent des portes', kind: 'code' });
    assert.equal(cree.status, 201, cree.text);
    agent = cree.body;
    donnees = await seed.semerTout(app, { agent });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Retour sur Statistiques, rendu COMPLET (la dernière carte est celle des constats).
  async function allerStats() {
    await page.locator('nav button[data-tab="dashboard"]').click();
    await page.waitForSelector('#tab-dashboard.active #dashboard [data-rec-rule]');
  }
  const regles = async () => {
    const b = (await app.api('GET', '/api/rules')).body;
    return Array.isArray(b) ? b : (b.rules || b.regles || []);
  };
  const hash = () => page.evaluate(() => window.location.hash);

  test('« En attente » ouvre Reviews → À traiter, filtré sur ce projet', async () => {
    await allerStats();
    await page.locator('#dashboard [data-stat-projet="grp/alpha"][data-stat-seg="to_review"]').click();
    await page.waitForSelector('#tab-review.active');
    await page.waitForFunction(() => document.querySelector('.segmented [data-seg="to_review"]').classList.contains('active'));
    assert.equal(await page.locator('#searchReview').inputValue(), 'grp/alpha', 'le filtre se voit, et s’enlève');
    // Seule la MR à traiter d'alpha reste : celle de beta est masquée par la recherche.
    await page.waitForFunction((attendu) => {
      const vus = [...document.querySelectorAll('#toReviewList .card[data-id]')].map((c) => Number(c.dataset.id));
      return JSON.stringify(vus) === JSON.stringify(attendu);
    }, [donnees.mr.a1]);
  });

  test('« Pire » ouvre Reviews → Reviewées, filtré sur ce projet', async () => {
    await allerStats();
    await page.locator('#dashboard [data-stat-projet="grp/beta"][data-stat-seg="reviewed"]').click();
    await page.waitForFunction(() => document.querySelector('.segmented [data-seg="reviewed"]').classList.contains('active'));
    assert.equal(await page.locator('#searchReview').inputValue(), 'grp/beta');
    await page.waitForFunction((attendu) => {
      const vus = [...document.querySelectorAll('#reportList .card[data-id]')].map((c) => Number(c.dataset.id));
      return JSON.stringify(vus) === JSON.stringify(attendu);
    }, [donnees.mr.b1]);
    // On ne laisse pas le filtre à la porte suivante.
    await page.locator('#searchReview').fill('');
  });

  test('une session de codage parmi les plus chères ouvre SA carte', async () => {
    await allerStats();
    await page.locator(`#dashboard [data-go-session="${donnees.t.code}"][data-go-kind="code"]`).click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((h) => window.location.hash === h, `#/sessions/code/${donnees.t.code}`);
    assert.equal(await page.locator(`#taskList .task-row[data-task="${donnees.t.code}"]`).count(), 1);
    assert.equal(await page.locator('#tab-task .subnav [data-kind="code"]').getAttribute('class'), 'active');
  });

  test('une session hors dépôt ouvre sa carte dans « Hors dépôt »', async () => {
    await allerStats();
    await page.locator(`#dashboard [data-go-session="${donnees.local}"][data-go-kind="local"]`).click();
    await page.waitForFunction((h) => window.location.hash === h, `#/sessions/local/${donnees.local}`);
    assert.equal(await page.locator(`#localList .card[data-local="${donnees.local}"]`).isVisible(), true);
  });

  test('une question libre ouvre sa carte dans « Questions »', async () => {
    await allerStats();
    await page.locator(`#dashboard [data-go-session="${donnees.question}"][data-go-kind="ask"]`).click();
    await page.waitForFunction((h) => window.location.hash === h, `#/sessions/ask/${donnees.question}`);
    assert.equal(await page.locator(`#askList .card[data-ask="${donnees.question}"]`).isVisible(), true);
  });

  /* Une EXPLORATION enregistre sa dépense sous `owner_kind = 'task'`, comme une session de
     codage (src/taskrunner.js, `recordUsage('explore', …, { kind: 'task' })`). Le classement
     transmet donc `data-go-kind="code"` : la porte ouvre « Codage », où l'exploration n'est
     pas, et `ouvrirSession` rend la main sans rien dire — on atterrit sur une liste où la
     session cliquée est introuvable. */
  test('une exploration parmi les plus chères ouvre sa carte dans « Exploration »', async () => {
    await allerStats();
    await page.locator(`#dashboard [data-go-session="${donnees.t.explore}"]`).click();
    await page.waitForSelector('#tab-task.active');
    const attendu = `#/sessions/explore/${donnees.t.explore}`;
    try {
      await page.waitForFunction((h) => window.location.hash === h, attendu, { timeout: 5000 });
    } catch {
      const saveur = await page.evaluate(() => (document.querySelector('#tab-task .subnav [data-kind].active') || {}).dataset);
      assert.fail(`adresse ${attendu} attendue, vu « ${await hash()} » sur le sous-onglet « ${saveur && saveur.kind} »`);
    }
    assert.equal(await page.locator(`#taskList .task-row[data-task="${donnees.t.explore}"]`).isVisible(), true);
  });

  test('un agent du « coût par agent » ouvre Dev IA filtré sur ses sessions', async () => {
    await allerStats();
    await page.locator('#dashboard [data-go-agent="Agent des portes"]').click();
    await page.waitForSelector('#tab-task.active');
    // Le filtre se VOIT : le combo porte le nom de l'agent, et sa valeur est son identifiant.
    await page.waitForFunction((a) => {
      const champ = document.querySelector('#taskAgentFilterBox [data-combo="taskAgentFilterVal"]');
      const val = document.querySelector('#taskAgentFilterBox .taskAgentFilterVal');
      return champ && val && champ.value === a.name && val.value === String(a.id);
    }, { name: agent.name, id: agent.id });
    // …et la liste ne montre que ses deux runs.
    await page.waitForFunction((ids) => {
      const vus = [...document.querySelectorAll('#taskList .task-row[data-task]')]
        .filter((r) => r.offsetParent !== null).map((r) => Number(r.dataset.task)).sort((x, y) => x - y);
      return JSON.stringify(vus) === JSON.stringify(ids);
    }, [donnees.t.agent1, donnees.t.agent2].sort((x, y) => x - y));
  });

  test('une review parmi les plus chères ouvre son rapport', async () => {
    await allerStats();
    await page.locator(`#dashboard [data-stat-mr="${donnees.mr.a2}"]`).click();
    await page.waitForSelector('#tab-review.active');
    await page.waitForFunction((h) => window.location.hash === h, `#/reviews/${donnees.mr.a2}`);
    await page.waitForFunction(() => /Alpha mal notée/.test((document.querySelector('#reportDetail') || {}).textContent || ''));
  });

  /* « En faire une règle » PRÉ-REMPLIT et s'arrête là : un `path_match` déduit de deux fichiers
     est une proposition. Rien n'existe côté serveur tant qu'on n'a pas cliqué « Ajouter ». */
  test('« En faire une règle » pré-remplit le formulaire, sans rien enregistrer', async () => {
    const avant = (await regles()).length;
    await allerStats();
    await page.locator('#dashboard [data-rec-rule]').first().click();
    await page.waitForSelector('#tab-admin.active #sub-rules.active');
    const f = page.locator('#ruleForm');
    await page.waitForFunction(() => document.querySelector('#ruleForm [name="path_match"]').value === 'src/checkout/**');
    // Le titre retenu est l'un des deux libellés rencontrés (normalisés en un seul constat).
    const contenu = await f.locator('[name="content"]').inputValue();
    assert.match(contenu, /^[Ll]e numéro de carte est loggé\.?$/);
    assert.equal(await f.locator('[name="label"]').inputValue(), contenu.slice(0, 60));
    assert.equal(await f.locator('[name="branch_match"]').inputValue(), '', 'le formulaire est remis à zéro');
    assert.equal((await regles()).length, avant, 'rien n’est enregistré sans clic');

    // Le clic, lui, enregistre exactement ce qui était proposé.
    await f.locator('button[type="submit"]').click();
    await attendreServeur(async () => (await regles()).length === avant + 1, 'la règle est enregistrée');
    const r = (await regles()).slice(-1)[0];
    assert.equal(r.path_match, 'src/checkout/**');
    assert.equal(r.content, contenu);
  });

  /* UN CONSTAT CROSS-DÉPÔT PRÉ-REMPLIT UNE RÈGLE GLOBALE : sans fichiers communs entre deux
     dépôts différents, aucun `path_match` ne se déduit, et aucun dépôt n'est présélectionné —
     la règle vaut donc pour tous, comme le dit son aide. */
  test('« En faire une règle » depuis un constat cross-dépôt pré-remplit une règle globale, sans chemin', async () => {
    seed.insererConstat(app.db, donnees.mr.a1, 'Le mot de passe est en clair', 'src/auth/login.js');
    seed.insererConstat(app.db, donnees.mr.a4, 'le mot de passe est en clair.', 'src/auth/session.js');
    seed.insererConstat(app.db, donnees.mr.b2, 'Le mot de passe est en clair', 'src/auth/login.js');
    const avant = (await regles()).length;
    await allerStats();
    await page.locator('#dashRefresh').click();

    const carteCross = page.locator('#dashboard .dash-card')
      .filter({ has: page.locator('h3', { hasText: 'Les mêmes constats, sur plusieurs dépôts' }) });
    await carteCross.locator('[data-rec-rule]').waitFor();
    await carteCross.locator('[data-rec-rule]').click();
    await page.waitForSelector('#tab-admin.active #sub-rules.active');
    const f = page.locator('#ruleForm');
    await page.waitForFunction(() => document.querySelector('#ruleForm [name="content"]').value !== '');

    const contenu = await f.locator('[name="content"]').inputValue();
    assert.match(contenu, /^[Ll]e mot de passe est en clair\.?$/);
    assert.equal(await f.locator('[name="path_match"]').inputValue(), '**',
      'deux dépôts n’ont pas de préfixe de dossier commun : le déclencheur proposé est « tout fichier »');
    assert.equal(await page.locator('#ruleRepoBox .rule-repo').inputValue(), '',
      'aucun dépôt présélectionné : la règle proposée vaut pour tous');

    await f.locator('button[type="submit"]').click();
    await attendreServeur(async () => (await regles()).length === avant + 1, 'la règle globale est enregistrée');
    const r = (await regles()).slice(-1)[0];
    assert.equal(r.path_match, '**');
    assert.equal(r.repo_id, null);
    assert.equal(r.content, contenu);
  });

  test('aucune exception JavaScript pendant les navigations', () => {
    assert.deepEqual(erreurs, []);
  });
});
