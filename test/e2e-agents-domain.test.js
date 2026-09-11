'use strict';
/* LES AGENTS DE DOMAINE, de la cartographie à la mise à jour validée.
 *
 * C'est le lot qui donne son sens à la fonctionnalité : « où est-ce qu'on gère les
 * notifications, chez nous ? » cesse d'être une question qu'on repose. Le parcours complet
 * tient en six gestes, et chacun peut casser seul :
 *   cartographier → l'agent existe avec ses dépôts et sa carte → lui demander → il signale un
 *   écart → mettre à jour → relire et valider.
 *
 * En dry-run, le décor de démo rend de VRAIS blocs de protocole : c'est le même parseur qui
 * les lit qu'en production, donc le mécanisme est réellement exercé. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-home-'));

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, makeRemoteRepo, waitForJobs, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Agents de domaine', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let idApi; let idFront;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    const d1 = makeRemoteRepo(path.join(app.dataDir, 'r1'));
    const d2 = makeRemoteRepo(path.join(app.dataDir, 'r2'));
    fs.mkdirSync(path.join(app.dataDir, 'r1'), { recursive: true });
    idApi = (await app.api('POST', '/api/repos', { url: d1.url, project: 'groupe/api-core' })).body.id;
    idFront = (await app.api('POST', '/api/repos', { url: d2.url, project: 'groupe/webapp-front' })).body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const allerAgents = async () => {
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#agentList .agent-card').length > 0);
  };
  const carteDomaine = () => page.locator('#agentList .agent-card', { hasText: 'Notification' }).first();

  test('« Nouvel agent de domaine » lance une cartographie', async () => {
    await allerAgents();
    await page.locator('#btnNewDomainAgent').click();
    await page.waitForSelector('#domainModal:not([hidden])');
    await page.locator('#domainSubject').fill('les notifications : émission, routage, types, config, tests');
    await page.locator('#domainStart').click();
    await page.waitForSelector('#domainModal', { state: 'hidden' });
    /* Le clic POSTE puis le job part : attendre la file tout de suite la trouve vide et rend
       la main avant que rien n'ait commencé. On attend l'EFFET — la session existe — puis sa fin. */
    await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.some((x) => /notification/i.test(x.prompt)),
      'la cartographie est partie');
    await waitForJobs(app.api, { timeout: 120000 });
    const t = (await app.api('GET', '/api/tasks')).body.find((x) => /notification/i.test(x.prompt));
    assert.ok(t, 'la session de cartographie doit exister');
    assert.equal(t.status, 'done', t.last_error || '');
  });

  test('l’agent de domaine existe, avec ses dépôts et sa connaissance en service', async () => {
    const a = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    assert.ok(a, 'aucun agent de domaine créé');
    assert.equal(a.scope_kind, 'repos');
    assert.deepEqual(a.repos.map((r) => r.project).sort(), ['groupe/api-core', 'groupe/webapp-front']);
    assert.equal(a.knowledge.version, 1);
    assert.equal(a.knowledge.status, 'active');
    assert.ok(a.knowledge_prompt.includes('notifications'), a.knowledge_prompt);
  });

  test('un chemin qui n’existe pas est compté et marqué « non vérifié »', async () => {
    // Un chemin plausible fait perdre plus de temps qu'une carte absente : on le dit.
    const a = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    assert.ok(a.knowledge.unverified >= 1, `attendu au moins un chemin non vérifié, vu ${a.knowledge.unverified}`);
    const v = (await app.api('GET', `/api/agents/${a.id}/knowledge/1`)).body;
    assert.match(v.content, /non vérifié/);
    await allerAgents();
    assert.match(await carteDomaine().innerText(), /non vérifié/);
  });

  test('« Coder » ouvre la session avec les dépôts de l’agent PRÉ-COCHÉS', async () => {
    await allerAgents();
    await carteDomaine().locator('.btn-agent-code').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length >= 2);
    const choisis = await page.$$eval('#targetRows .t-repo', (els) => els.map((e) => Number(e.value)));
    assert.deepEqual(choisis.sort(), [idApi, idFront].sort());
    assert.ok((await page.locator('#taskPrompt').inputValue()).length > 0, 'le gabarit remplit la demande');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  });

  test('« Demander » puis un <<<STALE>>> font monter le compteur d’écarts', async () => {
    const a = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    const avant = a.knowledge.gaps;
    const r = await app.api('POST', `/api/agents/${a.id}/run`, { mode: 'ask', question: 'Comment ajouter un type ?' });
    assert.equal(r.status, 200, r.text);
    await waitForJobs(app.api, { timeout: 120000 });
    const apres = (await app.api('GET', `/api/agents/${a.id}`)).body;
    assert.equal(apres.knowledge.gaps, avant + 1, 'l’écart constaté est enregistré');
    // …et l'agent ne corrige PAS sa propre carte : la version en service n'a pas changé.
    assert.equal(apres.knowledge.version, a.knowledge.version);
  });

  test('« Mettre à jour » produit une version EN ATTENTE, sans changer celle en service', async () => {
    await allerAgents();
    const a0 = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    const avant = (await app.api('GET', `/api/tasks?agent_id=${a0.id}`)).body.length;
    await carteDomaine().locator('.btn-agent-refresh').click();
    /* Le clic POSTE puis le job part : attendre la file tout de suite la trouve vide, et
       `waitForJobs` rend la main avant que quoi que ce soit ait commencé. On attend donc
       l'EFFET — un run de plus sur cet agent — avant d'attendre sa fin. */
    await attendreServeur(async () => (await app.api('GET', `/api/tasks?agent_id=${a0.id}`)).body.length > avant,
      'la mise à jour est partie');
    await waitForJobs(app.api, { timeout: 120000 });
    const a = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    assert.ok(a.knowledge.pending_version, 'aucune version en attente');
    assert.equal(a.knowledge.version, 1, 'l’agent continue de travailler sur l’ancienne');
    // La mise à jour est une session portée par l'agent de DOMAINE, pas par le cartographe.
    const runs = (await app.api('GET', `/api/tasks?agent_id=${a.id}`)).body;
    assert.ok(runs.length >= 2, 'la mise à jour apparaît sur la carte de l’agent');
  });

  test('« Relire et valider » : le diff s’affiche, et le bouton bascule la version', async () => {
    await allerAgents();
    await carteDomaine().locator('.btn-agent-review').click();
    await page.waitForSelector('#knowledgeModal:not([hidden])');
    await page.waitForSelector('#knowledgeDiff:not([hidden])');
    const diff = await page.locator('#knowledgeDiff').innerText();
    assert.ok(diff.length > 0, 'le diff doit être lisible avant de valider');
    await page.locator('#knowledgeValidate').click();
    await page.waitForFunction(() => document.querySelector('#knowledgeValidate').hidden);
    const a = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    assert.equal(a.knowledge.version, 2);
    assert.equal(a.knowledge.pending_version, null);
  });

  test('« Modifier » la connaissance crée une nouvelle version, active tout de suite', async () => {
    await page.locator('#knowledgeEditBtn').click();
    await page.waitForSelector('#knowledgeEdit:not([hidden])');
    await page.locator('#knowledgeEdit').fill('# À la main\n## Périmètre\nCe que j’ai écrit moi-même.\n');
    await page.locator('#knowledgeSave').click();
    await page.waitForFunction(() => /À la main/.test(document.querySelector('#knowledgeBody').textContent));
    const a = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    assert.equal(a.knowledge.version, 3);
    const v = (await app.api('GET', `/api/agents/${a.id}/knowledge/3`)).body;
    assert.equal(v.task_id, null, 'une édition à la main ne vient d’aucun run');
    assert.match(v.content, /Ce que j’ai écrit moi-même\./);
  });

  test('« Publier dans les notes » crée la page, et la met à jour sans la dupliquer', async () => {
    await page.locator('#knowledgePublish').click();
    await page.waitForFunction(() => !document.querySelector('#knowledgePublish').disabled);
    const pages1 = (await app.api('GET', '/api/notes')).body.pages;
    const p = pages1.filter((x) => /connaissance/i.test(x.title));
    assert.equal(p.length, 1, 'une seule page');
    await page.locator('#knowledgePublish').click();
    await page.waitForFunction(() => !document.querySelector('#knowledgePublish').disabled);
    const pages2 = (await app.api('GET', '/api/notes')).body.pages;
    assert.equal(pages2.filter((x) => /connaissance/i.test(x.title)).length, 1,
      'republier met à jour, jamais ne duplique');
    await page.locator('#knowledgeClose').click();
    await page.waitForSelector('#knowledgeModal', { state: 'hidden' });
  });

  test('l’âge de la carte est affiché, et il est calculé sans IA', async () => {
    const a = (await app.api('GET', '/api/agents')).body.find((x) => x.is_domain);
    const age = (await app.api('GET', `/api/agents/${a.id}/age`)).body;
    assert.ok(Array.isArray(age));
    assert.ok(age.every((x) => x.project), JSON.stringify(age));
    await allerAgents();
    await page.waitForFunction(() => {
      const el = document.querySelector('#agentList [data-agent-age]');
      return el && !/…$/.test(el.textContent);
    });
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
