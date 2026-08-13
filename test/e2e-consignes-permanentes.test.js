'use strict';
/* LES CONSIGNES PERMANENTES : ce qu'on redit à chaque session sans vouloir le retaper.
 *
 * Le champ vit dans *Réglages → AI sessions* et s'ajoute au prompt de TOUTES les sessions de
 * codage — dans un dépôt comme hors dépôt, au premier lancement comme à chaque suivi. Un
 * réglage qui ne s'appliquerait qu'au premier run serait pire que pas de réglage : on croit la
 * consigne posée, et elle disparaît à la deuxième passe sans que rien ne le dise.
 *
 * Le test lit le prompt RÉELLEMENT envoyé à l'agent — celui que l'application archive passe par
 * passe — et non ce qu'elle prétend avoir construit.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

const CONSIGNE = 'Commente en français et lance `npm run check` avant de committer.';

describe('Consignes permanentes ajoutées à toutes les sessions', () => {
  let app; let repoId;

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'cp-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } }];
    await app.configure({ ai_extra_instructions: CONSIGNE });
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
  });
  after(async () => { await app.stop(); });

  /* Le champ doit franchir les TROIS listes blanches (formulaire, `ALLOWED`, `UPDATE`) : un
     réglage accepté mais jamais écrit répond 200, affiche « enregistré », et ne sert à rien. */
  test('le champ est bien enregistré, et relu tel quel', async () => {
    assert.equal((await app.api('GET', '/api/config')).body.ai_extra_instructions, CONSIGNE);
  });

  test('une session de dépôt les reçoit au run ET au suivi', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      prompt: 'Ajoute un endpoint /health', targets: [{ repo_id: repoId, branch: 'feat/cp' }],
    });
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    const tgId = (await app.api('GET', `/api/tasks/${t.id}`)).body.task.targets[0].id;

    const passe = async (n) => (await app.api('GET', `/api/tasks/${t.id}/targets/${tgId}/passes?n=${n}`)).body.current;
    const p1 = await passe(1);
    assert.match(p1.prompt, /Ajoute un endpoint \/health/, 'la tâche reste ce qu’on demande d’abord');
    assert.match(p1.prompt, /Commente en français/, '…et la consigne permanente suit');
    assert.ok(p1.prompt.indexOf('Ajoute un endpoint') < p1.prompt.indexOf('Commente en français'),
      'la consigne vient APRÈS la tâche : quoi faire d’abord, comment ensuite');

    /* LA DEUXIÈME PASSE EST CELLE QU'ON OUBLIE. Un suivi sans les consignes, c'est la règle
       qui saute au moment où l'agent recode — sans que rien ne le signale. */
    await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'Renomme la variable' });
    await waitForJobs(app.api);
    const p2 = await passe(2);
    assert.match(p2.prompt, /Renomme la variable/);
    assert.match(p2.prompt, /Commente en français/, 'le suivi porte les mêmes consignes que le run');
  });

  /* « Hors dépôt » change l'endroit où l'IA travaille, pas la façon dont on veut qu'elle
     travaille. Ce chemin a son propre prompt : le prouver par l'API des sessions de dépôt ne
     prouverait rien ici. */
  test('une session hors dépôt les reçoit aussi, au run et au suivi', async () => {
    const dossier = fs.mkdtempSync(path.join(app.dataDir, 'hors-'));
    const { body: lt } = await app.api('POST', '/api/local-tasks', { prompt: 'Migre les imports', dirs: [dossier] });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);
    await app.api('POST', `/api/local-tasks/${lt.id}/followup`, { instruction: 'Et les tests' });
    await waitForJobs(app.api);

    const dirId = (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id).dirs[0].id;
    const hist = await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${dirId}/passes`);
    assert.deepEqual(hist.body.passes.map((p) => p.kind), ['run', 'followup']);
    for (const n of [1, 2]) {
      const p = (await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${dirId}/passes?n=${n}`)).body.current;
      assert.match(p.prompt, /Commente en français/, `passe ${n} hors dépôt`);
    }
  });

  /* CHAMP VIDE = RIEN D'AJOUTÉ. Un prompt qui se terminerait par un en-tête « Consignes
     permanentes : » suivi du vide demanderait à l'agent d'obéir à rien. */
  test('vidé, plus rien n’est ajouté au prompt', async () => {
    await app.api('PUT', '/api/config', { ai_extra_instructions: '   ' });
    const { body: t } = await app.api('POST', '/api/tasks', {
      prompt: 'Ajoute un cache', targets: [{ repo_id: repoId, branch: 'feat/cp2' }],
    });
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    const tgId = (await app.api('GET', `/api/tasks/${t.id}`)).body.task.targets[0].id;
    const p = (await app.api('GET', `/api/tasks/${t.id}/targets/${tgId}/passes?n=1`)).body.current;
    assert.match(p.prompt, /Ajoute un cache/);
    assert.doesNotMatch(p.prompt, /Consignes permanentes/, 'pas d’en-tête sans consigne dessous');
  });
});
