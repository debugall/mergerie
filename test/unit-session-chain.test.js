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
  const prompts = [];         // …et le TEXTE envoyé, gardé à part (les `deepEqual` ci-dessous)

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
    agentsession.runInSession = async ({ key, handle, resume, cwd, prompt }) => {
      n += 1;
      appels.push({ key, handle: handle || null, resume: !!resume });
      prompts.push(String(prompt || ''));
      // L'agent est censé MODIFIER le code : sans quoi la passe échoue « rien à committer ».
      fs.appendFileSync(path.join(cwd, 'PASSE.md'), `passe ${n}\n`, 'utf8');
      return { text: `passe ${n}`, sessionId: `sess-${n}`, handle: `sess-${n}`, backend: 'claude' };
    };
    copilot.isDryRun = () => false;      // sans quoi le chemin « session » n'est jamais pris
  });
  after(async () => { await app.stop(); });

  /* LE HANDLE A QUITTÉ LA LIGNE. Il ne vaut que dans le `~/.claude` de cette machine : il vit
     donc dans `local_session`, rangé sous l'`uid` du projet. On le recolle ici, comme le fait
     l'application — sans quoi ce test éprouverait le stockage plutôt que l'enchaînement. */
  const cible = (taskId, repoId) => {
    // eslint-disable-next-line global-require
    const localsession = require('../src/data/localsession');
    return localsession.resoudre('task_target', app.db
      .prepare('SELECT * FROM task_target WHERE task_id = ? AND repo_id = ?').get(taskId, repoId));
  };

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

  /* LE SUIVI ENVOYÉ DEPUIS LE POSTE QUI A REÇU LA SESSION.
     Le handle ne voyage pas : il ne vaut que dans le `~/.claude` de la machine qui l'a ouvert.
     Chez le collègue, la session est là, l'agent est neuf — et il ne recevait que « applique
     cette correction », sans la tâche d'origine ni rien de ce qui s'est dit avant. On efface
     donc le handle, ce qui EST la situation du collègue : la ligne existe, le handle non. */
  test('un suivi sans session à reprendre réinjecte la tâche et les échanges précédents', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un endpoint /metrics',
      targets: [{ repo_id: idA, branch: 'feat/metrics', base_branch: 'main' }],
    });
    const tache = app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id);
    await taskrunner.runTask(tache, () => {});
    // Un premier suivi : il faut une conversation AVANT de vérifier qu'on la reprend.
    await taskrunner.runTaskFollowup(tache, 'Renomme le compteur en total', () => {});
    const retourPrecedent = prompts.length;

    // eslint-disable-next-line global-require
    const localsession = require('../src/data/localsession');
    const tg = cible(t.id, idA);
    localsession.oublier('task_target', tg.uid);
    assert.equal(cible(t.id, idA).session_key, null, 'le décor doit être celui du collègue');

    appels.length = 0;
    await taskrunner.runTaskFollowup(tache, 'Ajoute un test du compteur', () => {});
    assert.equal(appels[0].resume, false, 'il n’y a rien à reprendre, et c’est le cas qu’on éprouve');

    const envoye = prompts[prompts.length - 1];
    assert.match(envoye, /Ajoute un endpoint \/metrics/,
      'la tâche d’origine : sans elle, « applique cette correction » ne veut rien dire');
    assert.match(envoye, /Renomme le compteur en total/,
      'et ce qui a déjà été demandé — c’est la conversation qu’on reprend');
    assert.match(envoye, new RegExp(`passe ${retourPrecedent}`),
      'et ce que l’agent avait répondu, pas seulement ce qu’on lui avait demandé');
    assert.match(envoye, /Ajoute un test du compteur/, 'la demande du jour reste, évidemment');
  });

  /* ET LE CAS SYMÉTRIQUE, LE PLUS TRAÎTRE : ma session locale est reprenable, mais le collègue
     a itéré de son côté et sa passe m'est arrivée par la synchro. L'agent d'ici ne l'a jamais
     vue : il repart de l'état où IL avait laissé les choses, alors que la branche porte déjà le
     travail de l'autre — et rien à l'écran ne le signale. On ne réinjecte QUE ce qui manque :
     lui rejouer sa propre conversation le ferait douter de ce qu'il a déjà fait. */
  test('une itération venue d’ailleurs rattrape la session locale, sans rejouer la sienne', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un endpoint /ready',
      targets: [{ repo_id: idA, branch: 'feat/ready', base_branch: 'main' }],
    });
    const tache = app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id);
    await taskrunner.runTask(tache, () => {});
    const monRetour = `passe ${prompts.length}`;      // ce que MON agent vient de répondre
    const tg = cible(t.id, idA);
    assert.ok(cible(t.id, idA).session_key, 'ma session à moi est bien reprenable');

    /* LE COLLÈGUE ITÈRE, et sa passe arrive par la synchro : une ligne `agent_pass` de plus,
       dont le retour a été écrit sur le disque à l'hydratation. C'est exactement ce que fait
       `fromFile` — on le reproduit ici plutôt que de monter deux instances. */
    const sien = path.join(app.dataDir, 'passe-du-collegue.md');
    fs.writeFileSync(sien, 'J’ai ajouté le cache Redis et corrigé le timeout.', 'utf8');
    const n = app.db.prepare('SELECT MAX(n) v FROM agent_pass WHERE scope = ? AND task_id = ? AND unit_id = ?')
      .get('task', t.id, tg.id).v + 1;
    app.db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
      VALUES ('task', ?, ?, ?, 'followup', ?, ?, ?)`)
      .run(t.id, tg.id, n, 'Mets un cache sur /ready', sien, new Date().toISOString());

    appels.length = 0;
    await taskrunner.runTaskFollowup(tache, 'Documente le cache', () => {});
    assert.equal(appels[0].resume, true, 'ma session locale est toujours reprise : c’est bien elle qu’on prolonge');

    const envoye = prompts[prompts.length - 1];
    assert.match(envoye, /Mets un cache sur \/ready/, 'ce que le collègue a demandé');
    assert.match(envoye, /cache Redis/, 'et ce que son agent a répondu — sinon le mien code à l’aveugle');
    assert.doesNotMatch(envoye, new RegExp(monRetour),
      'mais PAS ma propre conversation : l’agent s’en souvient, la rejouer le ferait douter');
    assert.match(envoye, /Documente le cache/, 'et la demande du jour');
  });

  /* ET POUR LES SESSIONS QUI EXISTAIENT DÉJÀ. Le repère ne se pose qu'à la première itération
     locale : une session commencée avant cette mécanique n'en a aucun, et la passe d'un
     collègue arrivée entre-temps lui serait antérieure — donc invisible pour toujours. On
     reconnaît alors une passe venue d'ailleurs à son FICHIER, celui qu'écrit l'hydratation. */
  test('une session d’avant le repère rattrape quand même ce qui vient du dépôt', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un endpoint /live',
      targets: [{ repo_id: idA, branch: 'feat/live', base_branch: 'main' }],
    });
    const tache = app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id);
    await taskrunner.runTask(tache, () => {});
    const tg = cible(t.id, idA);

    // eslint-disable-next-line global-require
    const localstate = require('../src/data/localstate');
    localstate.etat.ecrire('session', tg.uid, 'derniere_passe', null);   // session d'avant
    assert.equal(localstate.etat.lire('session', tg.uid, 'derniere_passe'), null);

    /* La passe du collègue, telle que l'hydratation la pose : sous `tasks/passes/<session>/`,
       nommée par l'uid. C'est cette forme-là qui la distingue d'une passe produite ici. */
    const dossier = path.join(app.dataDir, 'tasks', 'passes', tache.uid || 'x');
    fs.mkdirSync(dossier, { recursive: true });
    const sien = path.join(dossier, 'pass-01JZZZCOLLEGUE.md');
    fs.writeFileSync(sien, 'J’ai basculé la sonde sur le port 9000.', 'utf8');
    const n = app.db.prepare('SELECT MAX(n) v FROM agent_pass WHERE scope = ? AND task_id = ? AND unit_id = ?')
      .get('task', t.id, tg.id).v + 1;
    app.db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
      VALUES ('task', ?, ?, ?, 'followup', ?, ?, ?)`)
      .run(t.id, tg.id, n, 'Bascule la sonde sur 9000', sien, new Date().toISOString());

    appels.length = 0;
    await taskrunner.runTaskFollowup(tache, 'Ajoute le port au README', () => {});
    assert.equal(appels[0].resume, true, 'la session locale est toujours reprise');
    const envoye = prompts[prompts.length - 1];
    assert.match(envoye, /Bascule la sonde sur 9000/, 'la demande du collègue est rattrapée');
    assert.match(envoye, /port 9000/, 'et ce que son agent a répondu');
  });

  /* La commande « Reprendre au terminal » copie ce handle : elle doit mener à la conversation
     TELLE QU'ELLE EST, pas à son état d'il y a trois suivis. */
  test('la commande de reprise pointe la dernière passe', async () => {
    // eslint-disable-next-line global-require
    const tg = require('../src/data/localsession').resoudre('task_target',
      app.db.prepare('SELECT * FROM task_target WHERE repo_id = ? ORDER BY id DESC LIMIT 1').get(idA));
    const { body } = await app.api('GET', `/api/tasks/${tg.task_id}`);
    const vue = body.task.targets.find((x) => x.id === tg.id);
    assert.match(vue.resume_cmd || '', new RegExp(`--resume ${tg.session_key}`),
      'la commande copiée reprend l’identifiant courant');
  });
});
