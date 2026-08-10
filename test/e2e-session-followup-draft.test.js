'use strict';
/* LE SUIVI EN ATTENTE d'une session de dev IA.
 *
 * On lit le travail de l'agent pendant qu'il travaille, et la remarque vient là. On l'écrit
 * donc tout de suite, elle attend, on la corrige tant qu'elle n'est pas partie — et c'est un
 * geste explicite qui l'envoie. Le point dur du contrat est le NÉGATIF : une session qui se
 * termine ne doit rien envoyer d'elle-même, sans quoi on découvrirait un agent reparti sur
 * une consigne écrite vingt minutes plus tôt, sur du code qui a changé depuis.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, waitForJobs } = require('./helpers/app');

describe('session : le suivi en attente', () => {
  let app;
  let repoId;
  const mkdir = () => fs.mkdtempSync(path.join(app.dataDir, 'sdir-'));
  const lire = async (id) => (await app.api('GET', '/api/local-tasks')).body.find((x) => x.id === id);

  before(async () => {
    app = await startApp();
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.demo/grp/app' })).body.id;
  });
  after(async () => { await app.stop(); });

  const creerLocale = async (prompt = 'Première passe') => {
    const dir = mkdir();
    const lt = (await app.api('POST', '/api/local-tasks', { prompt, dirs: [dir] })).body;
    return { id: lt.id, dir };
  };

  test('un suivi s’enregistre, se relit et se corrige tant qu’il n’est pas parti', async () => {
    const { id } = await creerLocale();
    const pose = await app.api('PUT', `/api/local-tasks/${id}/followup-draft`, { instruction: '  Pense aux tests  ' });
    assert.equal(pose.status, 200);
    assert.equal(pose.body.followup_draft, 'Pense aux tests', 'les espaces de saisie ne font pas partie du texte');
    assert.equal((await lire(id)).followup_draft, 'Pense aux tests', 'la liste le rappelle : sinon on oublie qu’on en a un');

    await app.api('PUT', `/api/local-tasks/${id}/followup-draft`, { instruction: 'Pense aux tests ET au README' });
    assert.equal((await lire(id)).followup_draft, 'Pense aux tests ET au README', 'un suivi se corrige, il ne s’empile pas');
  });

  test('un texte vide EST la suppression', async () => {
    const { id } = await creerLocale();
    await app.api('PUT', `/api/local-tasks/${id}/followup-draft`, { instruction: 'à jeter' });
    await app.api('PUT', `/api/local-tasks/${id}/followup-draft`, { instruction: '   ' });
    assert.equal((await lire(id)).followup_draft, null,
      'un suivi vide afficherait un bloc « suivi prêt » sans texte, avec un bouton d’envoi qui échoue');
  });

  /* LE TEST QUI COMPTE : la session va au bout, et le suivi est toujours là, intact. */
  test('une session qui se termine n’envoie pas le suivi', async () => {
    const { id } = await creerLocale();
    await app.api('PUT', `/api/local-tasks/${id}/followup-draft`, { instruction: 'NEPARSPASTOUTSEUL' });
    await app.api('POST', `/api/local-tasks/${id}/run`);
    await waitForJobs(app.api);

    const lt = await lire(id);
    assert.equal(lt.status, 'done', 'la session est bien allée au bout');
    assert.equal(lt.followup_draft, 'NEPARSPASTOUTSEUL', 'le suivi attend toujours qu’on l’envoie');
    /* Le témoin est la LISTE DES PASSES, pas le marqueur dry-run : une passe de suivi
       repasserait dans le même dossier sans forcément y écrire le texte, et le test
       passerait alors qu'un agent serait bel et bien reparti tout seul. */
    const hist = await app.api('GET', `/api/local-tasks/${id}/dirs/${lt.dirs[0].id}/passes`);
    assert.deepEqual(hist.body.passes.map((p) => p.kind), ['run'], 'une seule passe : personne n’a envoyé le suivi');
  });

  test('l’envoi manuel part sans rien retaper, et ne part qu’une fois', async () => {
    const { id, dir } = await creerLocale();
    await app.api('POST', `/api/local-tasks/${id}/run`);
    await waitForJobs(app.api);
    await app.api('PUT', `/api/local-tasks/${id}/followup-draft`, { instruction: 'Corrige le titre' });

    // Corps vide : le serveur reprend le suivi enregistré — l'écran n'a pas à le renvoyer.
    const job = await app.api('POST', `/api/local-tasks/${id}/followup`, {});
    assert.equal(job.status, 200);
    await waitForJobs(app.api);

    const lt = await lire(id);
    assert.equal(lt.followup_draft, null, 'parti = consommé, sinon on le renverrait sans le vouloir');
    const dossier = lt.dirs[0];
    const hist = await app.api('GET', `/api/local-tasks/${id}/dirs/${dossier.id}/passes`);
    assert.deepEqual(hist.body.passes.map((p) => p.kind), ['run', 'followup'], 'une seconde passe a bien eu lieu');
    assert.match(hist.body.current.prompt, /Corrige le titre/, 'c’est le texte enregistré qui est parti');
    assert.ok(fs.existsSync(path.join(dir, 'PROJ_LOCAL_DRYRUN.md')));

    // Rien en attente, rien à envoyer : on refuse plutôt que de relancer l'agent à vide.
    const encore = await app.api('POST', `/api/local-tasks/${id}/followup`, {});
    assert.equal(encore.status, 400, 'un suivi ne part qu’une fois');
  });

  test('une demande explicite reste prioritaire et consomme le suivi en attente', async () => {
    const { id } = await creerLocale();
    await app.api('POST', `/api/local-tasks/${id}/run`);
    await waitForJobs(app.api);
    await app.api('PUT', `/api/local-tasks/${id}/followup-draft`, { instruction: 'ancienne remarque' });

    /* L'écran pré-remplit le formulaire AVEC le suivi : ce qu'on lance depuis ce formulaire est
       ce suivi, éventuellement retouché. Le laisser en attente le ferait repartir une 2e fois. */
    await app.api('POST', `/api/local-tasks/${id}/followup`, { instruction: 'remarque retouchée' });
    await waitForJobs(app.api);
    const lt = await lire(id);
    assert.equal(lt.followup_draft, null);
    const hist = await app.api('GET', `/api/local-tasks/${id}/dirs/${lt.dirs[0].id}/passes`);
    assert.match(hist.body.current.prompt, /remarque retouchée/);
    assert.ok(!/ancienne remarque/.test(hist.body.current.prompt), 'c’est bien le texte du formulaire qui part');
  });

  test('une session de dépôt a le même contrat, sur sa propre route', async () => {
    const t = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'p', targets: [{ repo_id: repoId, branch: 'feat/v' }],
    })).body;
    assert.equal(t.followup_draft, null, 'une session naît sans suivi en attente');

    await app.api('PUT', `/api/tasks/${t.id}/followup-draft`, { instruction: 'et la doc ?' });
    const liste = (await app.api('GET', '/api/tasks')).body.find((x) => x.id === t.id);
    assert.equal(liste.followup_draft, 'et la doc ?', 'la liste des sessions le porte, comme hors dépôt');

    const fiche = await app.api('GET', `/api/tasks/${t.id}`);
    assert.equal(fiche.body.task.followup_draft, 'et la doc ?');
  });

  test('une session inconnue ne se laisse pas annoter', async () => {
    const r = await app.api('PUT', '/api/tasks/99999/followup-draft', { instruction: 'x' });
    assert.equal(r.status, 400);
    const l = await app.api('PUT', '/api/local-tasks/99999/followup-draft', { instruction: 'x' });
    assert.equal(l.status, 400);
  });
});
