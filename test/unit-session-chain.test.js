'use strict';
/* LA CHAÎNE DE SESSION D'UN PROJET, D'UN SUIVI À L'AUTRE.
 *
 * Le défaut, vu à l'usage : deux « Demander une correction » d'affilée sur le MÊME projet d'une
 * session multi-dépôts, et l'agent ne se souvenait pas du premier suivi en faisant le second.
 *
 * La cause n'est pas dans le choix des projets, elle est dans l'identifiant de session :
 * `claude --resume <id>` ne poursuit pas l'échange sous le même identifiant, il en ouvre un
 * NOUVEAU qui porte tout ce qui précède. On ne gardait que celui de la création — chaque suivi
 * repartait donc de l'état initial, et le précédent était perdu.
 *
 * Ici on ne fait pas tourner d'agent : on remplace la couche de session par un décor qui rend
 * un identifiant différent à chaque reprise (comme le vrai), et on regarde CE QUE L'APPLICATION
 * GARDE entre deux passes. C'est là que le défaut vivait.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

describe('Reprise de session : le handle suit les passes', () => {
  let app; let taskrunner; let agentsession; let copilot;
  let repoA; let repoB; let idA; let idB;
  const appels = [];          // ce qu'on a demandé à l'agent, passe après passe

  before(async () => {
    app = await startApp();
    await app.configure();
    repoA = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remoteA-')));
    repoB = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remoteB-')));
    idA = (await app.api('POST', '/api/repos', { url: repoA.url, project: 'grp/a' })).body.id;
    idB = (await app.api('POST', '/api/repos', { url: repoB.url, project: 'grp/b' })).body.id;

    // eslint-disable-next-line global-require
    taskrunner = require('../src/taskrunner');
    // eslint-disable-next-line global-require
    agentsession = require('../src/agentsession');
    // eslint-disable-next-line global-require
    copilot = require('../src/copilot');

    /* LE DÉCOR. `claude --resume X` rend un identifiant NEUF : on le simule, sinon le test
       passerait aussi avec l'ancien comportement — c'est précisément ce qui distinguait les
       deux. Le reste (git, commit) tourne pour de vrai. */
    let n = 0;
    agentsession.backendName = () => 'claude';
    agentsession.runInSession = async ({ key, handle, resume, cwd }) => {
      n += 1;
      appels.push({ key, handle: handle || null, resume: !!resume });
      // L'agent est censé MODIFIER le code : sans quoi la passe échoue « rien à committer ».
      fs.appendFileSync(path.join(cwd, 'PASSE.md'), `passe ${n}\n`, 'utf8');
      return { text: `passe ${n}`, sessionId: `sess-${n}`, handle: `sess-${n}`, backend: 'claude' };
    };
    copilot.isDryRun = () => false;      // sans quoi le chemin « session » n'est jamais pris
  });
  after(async () => { await app.stop(); });

  const cible = (taskId, repoId) => (app.db
    .prepare('SELECT * FROM task_target WHERE task_id = ? AND repo_id = ?').get(taskId, repoId));

  test('deux suivis d’affilée sur UN projet s’enchaînent dans la même conversation', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un endpoint /health',
      targets: [
        { repo_id: idA, branch: 'feat/health-a', base_branch: 'main' },
        { repo_id: idB, branch: 'feat/health-b', base_branch: 'main' },
      ],
    });
    const tache = app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id);
    await taskrunner.runTask(tache, () => {});

    const a1 = cible(t.id, idA).session_key;
    const b1 = cible(t.id, idB).session_key;
    assert.ok(a1 && b1 && a1 !== b1, 'chaque projet a SA session');

    // 1er suivi, sur le projet A seulement.
    appels.length = 0;
    await taskrunner.runTaskFollowup(tache, 'Ajoute aussi la version', () => {}, { targetIds: [cible(t.id, idA).id] });
    assert.equal(appels.length, 1, 'un seul projet a retravaillé');
    assert.deepEqual(appels[0], { key: `task-${t.id}-target-${cible(t.id, idA).id}`, handle: a1, resume: true },
      'le 1er suivi REPREND la session du run');
    const a2 = cible(t.id, idA).session_key;
    assert.notEqual(a2, a1, 'l’agent a rendu un identifiant neuf : c’est LUI qu’on garde');

    // 2e suivi, même projet : il doit repartir du 1er suivi, pas du run initial.
    appels.length = 0;
    await taskrunner.runTaskFollowup(tache, 'Et un test', () => {}, { targetIds: [cible(t.id, idA).id] });
    assert.deepEqual(appels[0], { key: `task-${t.id}-target-${cible(t.id, idA).id}`, handle: a2, resume: true },
      'le 2e suivi reprend la session du 1er — sans ça, la correction précédente est oubliée');

    // Le projet B n'a pas bougé : son handle est resté celui de son propre run.
    assert.equal(cible(t.id, idB).session_key, b1, 'un suivi ciblé ne touche pas la session des autres');
  });

  /* La commande « Reprendre au terminal » copie ce handle : elle doit mener à la conversation
     TELLE QU'ELLE EST, pas à son état d'il y a trois suivis. */
  test('la commande de reprise pointe la dernière passe', async () => {
    const tg = app.db.prepare('SELECT * FROM task_target WHERE repo_id = ? ORDER BY id DESC LIMIT 1').get(idA);
    const { body } = await app.api('GET', `/api/tasks/${tg.task_id}`);
    const vue = body.task.targets.find((x) => x.id === tg.id);
    assert.match(vue.resume_cmd || '', new RegExp(`--resume ${tg.session_key}`),
      'la commande copiée reprend l’identifiant courant');
  });
});
