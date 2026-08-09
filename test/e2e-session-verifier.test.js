'use strict';
/* Le vérificateur d'une session de dev IA — le contrat de l'API.
 *
 * Un vérificateur ne peut pas travailler sur du code qui n'est pas poussé : il lit ce que la
 * forge expose. Choisir un vérificateur implique donc l'auto-push, et retirer l'auto-push retire
 * le vérificateur. L'écran le fait ; le SERVEUR le refait — un client n'est pas un garde-fou, et
 * l'API est appelable sans lui.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('session : le vérificateur et l’auto-push sont liés', () => {
  let app;
  let repoId;
  let verifierId;

  before(async () => {
    app = await startApp();
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.demo/grp/app' })).body.id;
    verifierId = (await app.api('POST', '/api/verifiers', {
      name: 'integ', kind: 'script', command: '/bin/true', timeout_s: 60,
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    })).body.id;
  });
  after(async () => { if (app) await app.stop(); });

  const creer = (body) => app.api('POST', '/api/tasks', {
    kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'feat/v' }], ...body,
  });

  test('sans auto-push, le vérificateur est refusé', async () => {
    const r = await creer({ auto_push: false, verifier_id: verifierId });
    assert.equal(r.body.verifier_id, null,
      'accepter le couple donnerait une session qui ne peut pas se vérifier, et on ne le verrait qu’à la fin');
  });

  test('avec auto-push, il est retenu', async () => {
    const r = await creer({ auto_push: true, verifier_id: verifierId });
    assert.equal(r.body.verifier_id, verifierId);
  });

  test('retirer l’auto-push retire le vérificateur', async () => {
    const t = (await creer({ auto_push: true, verifier_id: verifierId })).body;
    const maj = await app.api('PUT', `/api/tasks/${t.id}`, { auto_push: false });
    assert.equal(maj.body.verifier_id, null);
  });

  test('un vérificateur inconnu est ignoré, pas fatal', async () => {
    const r = await creer({ auto_push: true, verifier_id: 99999 });
    assert.equal(r.status, 200);
    assert.equal(r.body.verifier_id, null);
  });

  // Une exploration ne produit pas de code : il n'y a rien à vérifier.
  test('une exploration ne porte pas de vérificateur', async () => {
    const r = await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'q', targets: [{ repo_id: repoId, branch: 'main' }],
      auto_push: true, verifier_id: verifierId,
    });
    assert.equal(r.body.verifier_id, null);
  });
});
