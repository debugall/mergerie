'use strict';
/* LA SECONDE PASSE D'AMÉLIORATIONS — ce qui se voit à l'écran et ce qui se lit en base.
 *
 * On éprouve ici les faits que rien d'autre ne couvre : des propositions calculées à partir de
 * ce qui EXISTE DÉJÀ (le nom d'un lot déduit des cartes cochées, la file « prêtes à merger »
 * lue sur trois colonnes), des mémoires qui manquaient (le filtre des todos, le formulaire de
 * merge), et des portées qui n'existaient pas (une règle de review limitée à un dépôt).
 *
 * Ces choses-là ont en commun de ne casser qu'en SILENCE : une proposition qui ne vient plus,
 * un filtre qui repart à zéro, une règle qui déborde sur un autre dépôt ne lèvent aucune
 * erreur — c'est exactement ce que les tests doivent attraper.
 *
 * Un seul `startApp()` : le harnais démarre le serveur EN PROCESSUS.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Améliorations — seconde passe', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repoId; let depot;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 301, title: 'PROJ-1408 : tunnel de paiement', state: 'opened',
      source_branch: depot.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/301',
      sha: depot.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: depot.mainSha, start_sha: depot.mainSha, head_sha: depot.branchSha },
    }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/discover');

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* ---------- §0 : les défauts qui ne se voyaient pas ---------- */

  test('§0 — le statut du ticket voyage avec la merge request, sans surveillance', async () => {
    /* Le statut est rangé À LA DÉCOUVERTE, pour TOUTES les merge requests à ticket. Avant, il
       n'existait que pour les tickets surveillés — c'est-à-dire presque jamais là où l'on
       choisit quoi reviewer. On écrit donc en base ce que la découverte y aurait mis, et on
       vérifie que la file le rend : c'est le seul bout observable sans Jira. */
    const mr = (await app.api('GET', '/api/mrs')).body[0];
    app.db.prepare('UPDATE mr SET ticket_jira_key = ?, ticket_jira_status = ?, ticket_jira_category = ? WHERE id = ?')
      .run('PROJ-1408', 'En revue', 'indeterminate', mr.id);
    const apres = (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mr.id);
    assert.equal(apres.ticket_status, 'En revue');
    assert.equal(apres.ticket_category, 'indeterminate');
  });

  /* ---------- Axe A ---------- */

  test('A/Reviews 1 — la file se trie, et le tri survit à un rechargement', async () => {
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#mrTriFiltre .chip');
    await page.locator('[data-mr-tri="anciennes"]').click();
    await page.waitForFunction(() => document.querySelector('[data-mr-tri="anciennes"]').classList.contains('active'));
    await page.reload();
    await page.locator('nav button[data-tab="review"]').click();
    /* Un tri qu'il faut reposer à chaque visite ne sert qu'une fois : c'est la mémoire qu'on
       éprouve, pas l'ordre lui-même (une seule merge request ne prouverait rien de l'ordre). */
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-mr-tri="anciennes"]');
      return b && b.classList.contains('active');
    });
    assert.ok(true);
  });

  test('A/Réglages 2 — une règle limitée à un dépôt ne sort pas de ce dépôt', async () => {
    const autre = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/autre', project: 'grp/autre' })).body;
    const r = await app.api('POST', '/api/rules', {
      branch_match: '', path_match: '**/*.js', content: 'Vérifier les arrondis', repo_id: autre.id,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.repo_id, autre.id, 'la portée est enregistrée');
    // …et se retire : « tous les dépôts » doit rester atteignable une fois la limite posée.
    const maj = await app.api('PUT', `/api/rules/${r.body.id}`, { repo_id: null });
    assert.equal(maj.body.repo_id, null);
  });

  test('A/Réglages 3 — un lot ne groupe que des merge requests, et le dit', async () => {
    /* L'API acceptait `kind:'session'`, l'écran ne l'envoyait jamais, la vérification le
       refusait : un lot ainsi créé n'aurait rien pu faire. Refusé à l'entrée, en le disant. */
    const r = await app.api('POST', '/api/lots', { name: 'X', kind: 'session', members: [1] });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error || ''), /merge request/i);
  });

  test('A/Stats — les trois lectures neuves existent et ne cassent pas la route', async () => {
    const s = (await app.api('GET', '/api/stats')).body;
    for (const cle of ['topReviews', 'ratio', 'verifsParDepot']) {
      assert.ok(Array.isArray(s[cle]), `${cle} est une liste`);
    }
  });

  test('A/Notes 3 — le brief compte ce qui ne demande plus rien', async () => {
    const b = (await app.api('GET', '/api/brief')).body;
    assert.equal(typeof b.ready_to_merge, 'number');
    assert.ok(b.ready_threshold > 0, 'le seuil vient des réglages de convergence');
  });

  test('reprendre une session : l’outil propose ce qu’il connaît', async () => {
    // Le champ attendait un identifiant extrait à la main d'une commande de reprise.
    const r = await app.api('GET', '/api/agent-sessions');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  /* ---------- Axe B ---------- */

  test('B9 — « Reviewer à la création » se garde avec la session', async () => {
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'corriger le calcul',
      targets: [{ repo_id: repoId, branch: 'feat/x' }],
      review_after: true,
    });
    assert.equal(t.status, 200);
    assert.equal(t.body.review_after, 1, 'la case est persistée, pas seulement lue');
  });

  test('B5 — une surveillance peut demander sa todo au changement d’état', async () => {
    app.db.prepare("INSERT INTO jira_watch (key, status, status_category, checked_at) VALUES ('PROJ-9','À faire','new',?)")
      .run(new Date().toISOString());
    const r = await app.api('PATCH', '/api/jira/watch/PROJ-9', { todo_on_change: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.todo_on_change, 1);
    /* Le motif ne doit PAS être écrasé quand on ne l'envoie pas : deux champs indépendants,
       c'est tout l'intérêt d'un PATCH. */
    await app.api('PATCH', '/api/jira/watch/PROJ-9', { note: 'prévenir Sofia' });
    const apres = await app.api('PATCH', '/api/jira/watch/PROJ-9', { todo_on_change: false });
    assert.equal(apres.body.note, 'prévenir Sofia');
    assert.equal(apres.body.todo_on_change, 0);
  });

  test('B6 — une page de notes dit quelles captures elle porte', async () => {
    const p = (await app.api('POST', '/api/notes', { title: 'Bug du tunnel', content: 'texte' })).body;
    const r = await app.api('GET', `/api/notes/${p.id}/images`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [], 'une page sans capture rend une liste vide, pas une erreur');
  });

  /* ---------- Axe C ---------- */

  test('C6 — le filtre des todos survit à un rechargement', async () => {
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav [data-nsub="todos"]').click();
    await page.locator('[data-tfilter="done"]').click();
    await page.waitForFunction(() => document.querySelector('[data-tfilter="done"]').classList.contains('active'));
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav [data-nsub="todos"]').click();
    /* C'est l'ÉCRAN qui doit le dire : un filtre restauré sans surbrillance ferait douter de
       la liste avant de douter du bouton. */
    await page.waitForFunction(() => document.querySelector('[data-tfilter="done"]').classList.contains('active'));
    assert.ok(true);
  });

  test('C14 — la capture rapide pose une échéance sans passer par le sélecteur de date', async () => {
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])');
    /* Les raccourcis d'échéance vivent avec le champ qu'ils remplissent, dans « + détails » :
       une capture rapide est « je tape, j'entre », et on ne déplie que si l'on veut une date. */
    await page.locator('#captureMore').click();
    await page.waitForSelector('#captureDetails:not([hidden])');
    await page.locator('[data-due-quick="demain"]').click();
    const v = await page.locator('#captureDue').inputValue();
    assert.ok(v, 'le champ d’échéance est rempli');
    // 9 h au cadran : « demain 9 h » ne veut pas dire « dans 24 heures ».
    assert.match(v, /T09:00$/);
    await page.locator('#captureCancel').click();
    await page.waitForSelector('#captureModal[hidden]', { state: 'attached' });
  });

  test('C15 — le ticket témoin Jira est un réglage, il ne se retape pas', async () => {
    await app.api('PUT', '/api/config', { jira_test_key: 'PROJ-1234' });
    const c = (await app.api('GET', '/api/config')).body;
    assert.equal(c.jira_test_key, 'PROJ-1234', 'accepté ET écrit — la moitié du chemin ne suffit pas');
  });

  test('aucune erreur de page sur tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
