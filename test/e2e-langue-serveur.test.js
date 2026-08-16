'use strict';
/* CE QUE L'OUTIL PRODUIT SUIT LA LANGUE, PAS SEULEMENT CE QU'IL AFFICHE.
 *
 * L'interface était traduite depuis longtemps (2200 clés × 2 langues) ; le SERVEUR, lui,
 * parlait français quoi qu'il arrive. Un utilisateur anglophone avait donc des écrans anglais
 * et, dès qu'il lançait quelque chose, un journal de job et des messages d'erreur en français —
 * c'est-à-dire précisément au moment où il a besoin de comprendre.
 *
 * Ce fichier vérifie les deux bouts de la chaîne : le journal d'un job réel, et l'erreur d'une
 * route. Sur des sorties RÉELLES, pas sur le dictionnaire — une clé traduite qu'on n'appelle
 * pas ne traduit rien.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

describe('Le serveur parle la langue choisie', () => {
  let app; let repoId;

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'lang-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
  });
  after(async () => { await app.stop(); });

  // Le journal complet d'une session de codage, lignes concaténées.
  async function journalDUneSession(branche) {
    const { body: t } = await app.api('POST', '/api/tasks', {
      prompt: 'Ajoute un endpoint /health', targets: [{ repo_id: repoId, branch: branche }],
    });
    /* On borne la lecture aux lignes de CE job : le test précédent a tourné en français, et
       relire tout le journal ferait échouer celui-ci sur les phrases du voisin. */
    const depuis = app.db.prepare('SELECT COALESCE(MAX(id), 0) m FROM job_log').get().m;
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    return app.db.prepare('SELECT text FROM job_log WHERE id > ? ORDER BY id').all(depuis)
      .map((l) => l.text).join('\n');
  }

  test('en français, le journal d’un job est en français', async () => {
    await app.api('PUT', '/api/config', { language: 'fr' });
    const journal = await journalDUneSession('feat/fr');
    assert.match(journal, /création de la branche|exécution/, 'les lignes de journal sont traduites');
    assert.match(journal, /branche poussée|commit prêt/);
  });

  /* LE CŒUR DU TEST. Même geste, langue anglaise : plus un mot de français dans ce que
     l'outil vient d'écrire. On cherche les mots eux-mêmes, pas une clé. */
  test('en anglais, le même job est en anglais — sans un mot de français', async () => {
    await app.api('PUT', '/api/config', { language: 'en' });
    const journal = await journalDUneSession('feat/en');
    assert.match(journal, /creating branch|run \(/, 'le journal est passé à l’anglais');
    /* La règle générale plutôt qu'une liste de phrases : PLUS UN SEUL accent dans ce que
       l'outil vient d'écrire. Une liste ne protège que les phrases qu'on a pensé à y mettre —
       et c'est toujours celle qu'on a oubliée qui reste en français. Le décor est choisi pour
       n'apporter aucun accent de son côté (prompt et branche sans accent, git parle anglais). */
    const fautives = journal.split('\n').filter((l) => /[àâäçéèêëîïôöùûüÀÂÄÇÉÈÊËÎÏÔÖÙÛÜœ]/.test(l));
    assert.deepEqual(fautives, [], 'aucune ligne ne doit rester en français');
  });

  /* Les erreurs comptent double : c'est ce qu'on lit quand on ne comprend pas ce qui se passe.
     Une session de suivi sans branche produit une erreur qui vient du serveur. */
  test('les messages d’erreur suivent aussi la langue', async () => {
    await app.api('PUT', '/api/config', { language: 'en' });
    const { body: t } = await app.api('POST', '/api/tasks', {
      prompt: 'peu importe', targets: [{ repo_id: repoId, branch: 'jamais/creee' }],
    });
    await app.api('POST', `/api/tasks/${t.id}/followup`, { instruction: 'continue' });
    await waitForJobs(app.api);
    const erreur = (await app.api('GET', `/api/tasks/${t.id}`)).body.task.last_error || '';
    assert.ok(erreur, 'la session est en erreur');
    assert.doesNotMatch(erreur, /[àâçéèêëîïôùû]/,
      `l’erreur ne doit plus contenir de français : ${erreur.slice(0, 120)}`);

    await app.api('PUT', '/api/config', { language: 'fr' });   // on rend le décor
  });
});
