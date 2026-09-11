'use strict';
/* LES HORAIRES, DE BOUT EN BOUT.
 *
 * Un horaire fait partir un agent sans que personne soit là : c'est la seule chose de cette
 * fonctionnalité qui dépense sans qu'on ait cliqué. Trois garanties comptent, et le test les
 * prend dans cet ordre : le créneau passé part ; un second tick ne le refait pas ; le brief du
 * matin dit ce qui s'est passé pendant la nuit.
 *
 * Le tick est déclenché par une route dédiée : attendre soixante secondes serait un pari sur
 * l'horloge d'une machine chargée, et un test qui dort n'est pas un test. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-home-'));

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, makeRemoteRepo, waitForJobs, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();

// Un créneau déjà passé aujourd'hui : « il y a une heure », arrondi à la minute.
function creneauPasse() {
  const d = new Date(Date.now() - 3600 * 1000);
  return `daily ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('Agents : horaires', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let agentId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure({ agent_auto_max: 10 });
    const depot = makeRemoteRepo(app.dataDir);
    const repoId = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' })).body.id;
    const r = await app.api('POST', '/api/agents', {
      name: 'Veilleur', kind: 'explore', scope_kind: 'repos',
      prompt_template: 'Fais le tour de {repos}. {question}',
      max_turns: 20, schedule: creneauPasse(),
      repos: [{ repo_id: repoId, role: 'readonly' }],
    });
    assert.equal(r.status, 201, r.text);
    agentId = r.body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Ces trois tests assertent sur l'EFFET (combien de runs existent) et non sur ce que rend
     l'appel : le serveur porte AUSSI son tic d'une minute, et sur une machine chargée il peut
     très bien avoir fait le travail avant nous. Ce qui compte n'est pas qui a appuyé, c'est
     qu'un créneau passé parte UNE fois et une seule. */
  const runs = async () => (await app.api('GET', `/api/tasks?agent_id=${agentId}`)).body;

  test('un créneau passé et jamais honoré déclenche un run, marqué « horaire »', async () => {
    await app.api('POST', '/api/agents/tick');
    await attendreServeur(async () => (await runs()).length === 1, 'le run planifié existe');
    await waitForJobs(app.api, { timeout: 120000 });
    const [r] = await runs();
    assert.equal(r.triggered_by, 'schedule');
    assert.equal(r.agent_name, 'Veilleur');
    assert.equal(r.auto_push, 0, 'un agent ne pousse jamais de lui-même, horaire compris');
  });

  test('un second tick n’en crée pas un autre — le tic tourne toutes les minutes', async () => {
    await app.api('POST', '/api/agents/tick');
    await app.api('POST', '/api/agents/tick');
    assert.equal((await runs()).length, 1);
  });

  test('le plafond quotidien empêche le suivant, et l’heure de tir est écrite quand même', async () => {
    // Le plafond est la seule borne de ce qui peut se déclencher tout seul dans la journée.
    await app.api('PUT', '/api/config', { agent_auto_max: 1 });
    const autre = await app.api('POST', '/api/agents', {
      name: 'Guetteur de secours', kind: 'explore', max_turns: 20, schedule: creneauPasse(),
    });
    assert.equal(autre.status, 201, autre.text);
    await app.api('POST', '/api/agents/tick');
    assert.equal((await app.api('GET', `/api/tasks?agent_id=${autre.body.id}`)).body.length, 0,
      'le plafond atteint : le second agent ne part pas');
    /* Sans l'écriture de l'heure de tir, il serait « dû » à chaque minute jusqu'à minuit et le
       journal se remplirait de refus. */
    assert.ok((await app.api('GET', `/api/agents/${autre.body.id}`)).body.schedule_fired_at);
    await app.api('PUT', '/api/config', { agent_auto_max: 10 });
  });

  test('le brief du matin liste ce que les agents ont produit', async () => {
    const b = (await app.api('GET', '/api/brief')).body;
    assert.ok(Array.isArray(b.agents), 'le brief doit porter une section agents');
    assert.ok(b.agents.some((x) => x.name === 'Veilleur'), JSON.stringify(b.agents));
  });

  test('l’horaire se lit et s’écrit dans l’éditeur, en toutes lettres', async () => {
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#agentList .agent-card').length > 0);
    await page.locator('#agentList .agent-card', { hasText: 'Veilleur' }).first().locator('.btn-agent-edit').click();
    await page.waitForSelector('#agentModal:not([hidden])');
    await page.evaluate(() => { document.querySelectorAll('#agentForm details').forEach((d) => { d.open = true; }); });
    assert.equal(await page.locator('#agentScheduleKind').inputValue(), 'daily');
    await page.locator('#agentScheduleKind').selectOption('weekly');
    await page.waitForFunction(() => !document.querySelector('#agentScheduleDow').hidden);
    await page.locator('#agentScheduleDow').selectOption('mon');
    await page.locator('#agentScheduleTime').fill('07:00');
    await page.locator('#agentSave').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    assert.equal((await app.api('GET', `/api/agents/${agentId}`)).body.schedule, 'weekly mon 07:00');
  });

  test('un horaire sans borne de tours est refusé, avec sa phrase', async () => {
    const r = await app.api('POST', '/api/agents', { name: 'Sans borne', schedule: 'daily 07:00' });
    assert.equal(r.status, 400);
    assert.ok(r.body.errors.includes('agents.err.schedule-needs-max-turns'));
    assert.ok(!/^agents\./.test(r.body.error), r.body.error);
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
