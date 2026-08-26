'use strict';
/* PIÈCES JOINTES : CAPTURES *ET* DOCUMENTS, DANS LES QUATRE SAVEURS.
 *
 * « Voici le devis du client, implémente les règles de remise » : un PDF, un tableur ou un
 * .txt disent en un fichier ce qu'un prompt met vingt lignes à décrire — et on les a sous la
 * main au moment où on écrit la demande.
 *
 * Pour l'agent, une capture d'écran et un PDF sont la même chose : un fichier à ouvrir. D'où
 * une seule table, un seul bloc de prompt, et ce fichier de tests qui vérifie les quatre
 * saveurs — codage, exploration, hors dépôt, question libre — parce que chacune a sa route,
 * et qu'en éprouver une et supposer les autres est exactement ce qui laisse un fichier se
 * perdre en silence.
 *
 * Ce qui se joue :
 *   1. le fichier arrive sur DISQUE et son NOM D'ORIGINE arrive dans le prompt — `pj_2.pdf` ne
 *      dit rien à l'agent, « devis-client.pdf » le renseigne ;
 *   2. le nom donné par le navigateur ne devient JAMAIS un chemin ;
 *   3. ce qu'on refuse est refusé AVANT d'enregistrer quoi que ce soit.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 devis').toString('base64')}`;
const TXT = `data:text/plain;base64,${Buffer.from('règle de remise : 10% dès 3 articles').toString('base64')}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Pièces jointes des sessions', () => {
  let app; let repoId;

  before(async () => {
    app = await startApp();
    await app.configure();
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    repoId = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' })).body.id;
  });
  after(async () => { await app.stop(); });

  const pieces = (scope, id) => app.db
    .prepare('SELECT * FROM piece_jointe WHERE scope = ? AND owner_id = ? ORDER BY id').all(scope, id);

  test('codage : le document est écrit sur disque et NOMMÉ dans le prompt', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Applique les règles de remise du devis',
      files: [{ name: 'devis-client.pdf', data: PDF }, { name: 'regles.txt', data: TXT }],
      targets: [{ repo_id: repoId, branch: 'feat/remise', base_branch: 'main' }],
    });
    const pj = pieces('task', t.id);
    assert.equal(pj.length, 2);
    assert.deepEqual(pj.map((p) => p.name), ['devis-client.pdf', 'regles.txt']);
    for (const p of pj) {
      assert.ok(fs.existsSync(p.path), `${p.name} est sur disque`);
      /* Le nom du navigateur ne devient JAMAIS un chemin : le fichier porte un nom fabriqué,
         et seule la ligne en base garde le nom d'origine. */
      assert.match(path.basename(p.path), /^pj_\d+\.(pdf|txt)$/);
    }

    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    const tg = (await app.api('GET', `/api/tasks/${t.id}`)).body.task.targets[0];
    const { body } = await app.api('GET', `/api/tasks/${t.id}/targets/${tg.id}/passes`);
    assert.match(body.current.prompt, /pièces jointes sont fournies/);
    assert.match(body.current.prompt, /devis-client\.pdf/, 'l’agent lit le NOM d’origine, pas « pj_1 »');
    assert.match(body.current.prompt, /regles\.txt/);
  });

  test('exploration : même geste, même route', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Où est appliquée la remise ?',
      files: [{ name: 'specs.md', data: TXT }],
      targets: [{ repo_id: repoId, branch: 'main' }],
    });
    assert.equal(pieces('task', t.id).length, 1);
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    const { body: log } = await app.api('GET', '/api/jobs/current/log');
    assert.ok(log.lines.some((l) => /1 capture jointe/.test(l.text)),
      'le journal atteste la pièce — une exploration archive sa question, pas son prompt');
  });

  test('hors dépôt : la pièce voyage par chemin absolu, sans rien copier chez l’utilisateur', async () => {
    const dossier = fs.mkdtempSync(path.join(app.dataDir, 'hd-'));
    const { body: lt } = await app.api('POST', '/api/local-tasks', {
      prompt: 'Range selon le tableau', dirs: [dossier],
      files: [{ name: 'tableau.csv', data: TXT }],
    });
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);

    const pj = pieces('local', lt.id)[0];
    assert.equal(pj.name, 'tableau.csv');
    const dir = (await app.api('GET', `/api/local-tasks/${lt.id}`)).body.task.dirs[0];
    const { body } = await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${dir.id}/passes`);
    assert.match(body.current.prompt, new RegExp(pj.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'le prompt donne le chemin absolu : l’agent travaille EN PLACE, on ne dépose rien chez lui');
    assert.ok(!fs.existsSync(path.join(dossier, 'tableau.csv')), 'rien n’a été copié dans le dossier de travail');
  });

  test('question libre : elle aussi peut s’appuyer sur un document', async () => {
    const { body: q } = await app.api('POST', '/api/questions', {
      prompt: 'Ce contrat est-il compatible avec notre licence ?',
      files: [{ name: 'contrat.pdf', data: PDF }],
    });
    assert.equal(pieces('ask', q.id).length, 1);
    await app.api('POST', `/api/questions/${q.id}/run`);
    await waitForJobs(app.api);
    const { body } = await app.api('GET', `/api/questions/${q.id}/passes`);
    // La réponse est archivée, pas le prompt : on lit la pièce là où elle est arrivée.
    const pj = pieces('ask', q.id)[0];
    assert.ok(fs.existsSync(pj.path));
    assert.match(pj.path, new RegExp(`tasks/ask/${q.id}/`), 'rangée avec la question');
    assert.ok(body.current, 'la question a bien produit une passe');
  });

  test('un suivi porte SA pièce, et pas celle du suivi d’avant', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ajoute un export',
      files: [{ name: 'gabarit.csv', data: TXT }],
      targets: [{ repo_id: repoId, branch: 'feat/export', base_branch: 'main' }],
    });
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);

    await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'Vois le retour', files: [{ name: 'retour-1.pdf', data: PDF }] });
    await waitForJobs(app.api);
    await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'Et celui-ci', files: [{ name: 'retour-2.pdf', data: PDF }] });
    await waitForJobs(app.api);

    const tg = (await app.api('GET', `/api/tasks/${t.id}`)).body.task.targets[0];
    const { body } = await app.api('GET', `/api/tasks/${t.id}/targets/${tg.id}/passes`);
    const p2 = body.current.prompt;
    assert.match(p2, /gabarit\.csv/, 'la pièce de la consigne initiale reste');
    assert.match(p2, /retour-2\.pdf/, 'celle du suivi en cours arrive');
    assert.ok(!/retour-1\.pdf/.test(p2), 'celle du suivi précédent ne repart pas : elle illustrait autre chose');
  });

  test('ce qui est refusé l’est avant d’écrire quoi que ce soit', async () => {
    const trop = `data:application/pdf;base64,${Buffer.alloc(11 * 1024 * 1024).toString('base64')}`;
    const cas = [
      { name: 'script.sh', data: TXT },                    // type hors liste
      { name: 'sans-extension', data: TXT },
      { name: 'gros.pdf', data: trop },                    // au-delà du plafond
      { name: 'vide.pdf', data: 'pas une data url' },
    ];
    for (const f of cas) {
      const r = await app.api('POST', '/api/tasks', {
        kind: 'code', prompt: 'x', files: [f],
        targets: [{ repo_id: repoId, branch: 'feat/refus', base_branch: 'main' }],
      });
      assert.equal(r.status, 400, `${f.name} doit être refusé`);
      assert.ok(r.body.error, 'et la raison est dite');
    }
  });

  /* Supprimer la session emporte ses pièces — fichiers compris. Sans cela, le dossier de
     données enfle de documents que plus rien ne référence. */
  test('supprimer la session efface ses pièces et leurs fichiers', async () => {
    const { body: t } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'à jeter', files: [{ name: 'note.txt', data: TXT }],
      targets: [{ repo_id: repoId, branch: 'feat/jeter', base_branch: 'main' }],
    });
    const chemin = pieces('task', t.id)[0].path;
    assert.ok(fs.existsSync(chemin));
    await app.api('DELETE', `/api/tasks/${t.id}`);
    assert.equal(pieces('task', t.id).length, 0);
    assert.ok(!fs.existsSync(chemin));
  });
});
