'use strict';
/* HORS DÉPÔT : CE QUE L'AGENT REÇOIT QUAND ON RÉPOND À SES QUESTIONS.
 *
 * Le flux « l'agent demande → on répond → il continue » est déjà couvert au niveau des états
 * (`e2e-questions-saveurs`), mais en dry-run : aucune session d'agent n'est ouverte, et la
 * reprise n'est donc jamais exercée. Or c'est là que « continuer » se joue vraiment.
 *
 * Le prompt de reprise ne contient QUE les réponses — il ne réexplique pas la tâche, exprès :
 * la réexpliquer ferait recommencer au lieu de continuer. Cela n'a de sens que si l'agent
 * RETROUVE sa conversation : sans le handle gardé à la passe qui a posé la question, il
 * repartirait d'une session neuve et lirait « voici les réponses à tes questions » sans avoir
 * jamais rien demandé ni su ce qu'il devait faire.
 *
 * On remplace donc la couche de session par un décor (comme `unit-session-chain`) et on regarde
 * ce que l'application demande à l'agent, passe après passe.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, waitForJobs } = require('./helpers/app');

describe('Hors dépôt : la reprise après réponses', () => {
  let app; let agentsession; let copilot; let questions;
  const appels = [];                     // ce qui a été demandé à l'agent, passe après passe

  before(async () => {
    app = await startApp();
    await app.configure();
    // eslint-disable-next-line global-require
    agentsession = require('../src/agentsession');
    // eslint-disable-next-line global-require
    copilot = require('../src/copilot');
    // eslint-disable-next-line global-require
    questions = require('../src/questions');

    /* Passe 1 : l'agent POSE ses questions et s'arrête. Passe 2 et suivantes : il travaille.
       Comme le vrai `claude --resume`, chaque reprise rend un identifiant NEUF. */
    let n = 0;
    agentsession.backendName = () => 'claude';
    agentsession.runInSession = async ({ key, handle, resume, cwd, prompt }) => {
      n += 1;
      appels.push({ key, handle: handle || null, resume: !!resume, cwd, prompt });
      const texte = n === 1 ? questions.DRYRUN_QUESTIONS : `travail de la passe ${n}`;
      return { text: texte, sessionId: `sess-${n}`, handle: `sess-${n}`, backend: 'claude' };
    };
    copilot.isDryRun = () => false;      // sans quoi le chemin « session » n'est jamais pris
  });
  after(async () => { await app.stop(); });

  test('répondre reprend LA conversation de l’agent, avec les réponses pour seul prompt', async () => {
    const dossier = fs.mkdtempSync(path.join(app.dataDir, 'hd-rep-'));
    const { body: lt } = await app.api('POST', '/api/local-tasks', {
      prompt: 'Migre les imports vers ESM', dirs: [dossier], ask_questions: true,
    });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);

    const dir = () => app.db.prepare('SELECT * FROM local_task_dir WHERE task_id = ?').get(lt.id);
    assert.equal(dir().status, 'needs_input', 'l’agent s’est arrêté sur ses questions');
    assert.equal(appels.length, 1);
    assert.equal(appels[0].resume, false, 'la première passe ouvre la conversation');
    assert.match(appels[0].prompt, /Migre les imports vers ESM/, '…et lui explique la tâche');

    /* LE POINT CRITIQUE. S'arrêter pour demander n'est pas un échec : le fil de la conversation
       doit être gardé, sinon il n'y a plus rien à reprendre une fois la réponse donnée. */
    assert.equal(dir().session_key, 'sess-1', 'le handle est gardé MALGRÉ l’arrêt sur question');

    await app.api('POST', `/api/local-tasks/${lt.id}/dirs/${dir().id}/answer`, {
      answers: { q1: 'decorator', q2: 'Non, pas de migration' },
    });
    await waitForJobs(app.api);

    assert.equal(appels.length, 2, 'répondre fait retravailler le dossier, une fois');
    const rep = appels[1];
    assert.equal(rep.resume, true, 'on REPREND, on ne recommence pas');
    assert.equal(rep.handle, 'sess-1', '…la conversation où la question a été posée');
    assert.equal(rep.key, appels[0].key, 'même dossier, même clé de session');
    assert.equal(rep.cwd, dossier, 'et toujours dans le dossier de l’utilisateur');

    // Le prompt porte les questions ET les réponses, appariées : « decorator » seul ne veut rien dire.
    assert.match(rep.prompt, /Où placer la logique de retry \? → decorator/);
    assert.match(rep.prompt, /Faut-il migrer les données existantes \? → Non, pas de migration/);
    assert.match(rep.prompt, /Poursuis la tâche/, 'la consigne est de CONTINUER');
    assert.doesNotMatch(rep.prompt, /Migre les imports vers ESM/,
      'réexpliquer la tâche ferait recommencer : c’est la conversation qui la porte');

    assert.equal(dir().status, 'done', 'le travail repris va jusqu’au bout');
    assert.equal(dir().session_key, 'sess-2',
      'la reprise a rendu un identifiant neuf : c’est LUI qu’on garde pour la suite');
    assert.equal((await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === lt.id).status, 'done',
      'et la session entière suit son dossier');

    // Ce que l'écran montre après coup : la passe de réponse est une passe à part entière.
    const passes = (await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${dir().id}/passes`)).body;
    assert.ok(Array.isArray(passes.passes) && passes.passes.length >= 2, 'les deux passes sont relisibles');
    assert.equal(passes.passes[passes.passes.length - 1].kind, 'answer',
      'la dernière passe est identifiée comme la reprise après réponses');

    /* ET LA SUITE. Un suivi envoyé après coup doit repartir de la conversation TELLE QU'ELLE EST
       — réponses comprises —, pas de celle d'avant la question. */
    await app.api('POST', `/api/local-tasks/${lt.id}/followup`, { instruction: 'Ajoute un test' });
    await waitForJobs(app.api);
    assert.equal(appels.length, 3);
    assert.equal(appels[2].handle, 'sess-2', 'le suivi reprend la conversation qui contient les réponses');
  });
});
