'use strict';
/* Deux gestes de l'onglet Dev IA qu'aucun test ne touchait :

   - la croix de l'encart d'erreur d'une QUESTION LIBRE (`questions/:id/clear-error`) — la même
     croix est prouvée pour les sessions sur dépôt et hors dépôt, pas pour la quatrième saveur ;
   - le diff d'UN fichier dans une itération HORS DÉPÔT (`passes/:n/filediff`) — le viewer
     l'appelle quand on clique un fichier de l'arbre ; le diff complet de la passe était prouvé,
     pas celui-là. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, waitForJobs } = require('./helpers/app');

describe('Couverture — question libre et itération hors dépôt', () => {
  let app;

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { await app.stop(); });

  const question = async (id) => (await app.api('GET', '/api/questions')).body.find((x) => x.id === id);

  /* L'ERREUR S'EFFACE VRAIMENT, comme pour les autres saveurs : une question en erreur redevient
     « à lancer » ; une question terminée qui porte une erreur tardive reste terminée. */
  test('effacer l’erreur d’une question l’efface en base et la rend relançable', async () => {
    const { body: q } = await app.api('POST', '/api/questions', { prompt: 'Pourquoi le ciel est bleu ?' });
    app.db.prepare("UPDATE question SET status = 'error', last_error = 'agent indisponible' WHERE id = ?").run(q.id);
    assert.equal((await question(q.id)).status, 'error', 'préalable : la question est en erreur');

    const r = await app.api('POST', `/api/questions/${q.id}/clear-error`);
    assert.equal(r.status, 200, r.text);
    const apres = await question(q.id);
    assert.equal(apres.last_error, null, 'l’erreur ne revient pas au rechargement');
    assert.equal(apres.status, 'new', 'une question en erreur redevient à lancer');

    // Terminée mais avec une erreur tardive : l'erreur part, l'état reste.
    const { body: q2 } = await app.api('POST', '/api/questions', { prompt: 'Et la mer ?' });
    app.db.prepare("UPDATE question SET status = 'done', last_error = 'échec d’après-coup' WHERE id = ?").run(q2.id);
    assert.equal((await app.api('POST', `/api/questions/${q2.id}/clear-error`)).status, 200);
    const apres2 = await question(q2.id);
    assert.equal(apres2.last_error, null);
    assert.equal(apres2.status, 'done', 'on n’efface pas une réponse en effaçant son erreur');

    assert.ok((await app.api('POST', '/api/questions/99999/clear-error')).status >= 400, 'question inconnue : refusée');
  });

  describe('diff d’un fichier dans une itération hors dépôt', () => {
    let localId; let dirId; let dossier;

    before(async () => {
      dossier = fs.mkdtempSync(path.join(app.dataDir, 'hd-'));
      fs.writeFileSync(path.join(dossier, 'index.js'), 'const a = 1;\n');
      const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'range les imports', dirs: [dossier] })).body;
      localId = lt.id;
      await app.api('POST', `/api/local-tasks/${localId}/run`);
      await waitForJobs(app.api);
      dirId = (await app.api('GET', `/api/local-tasks/${localId}`)).body.task.dirs[0].id;
      await app.api('POST', `/api/local-tasks/${localId}/followup`, { instruction: 'Ajoute un test' });
      await waitForJobs(app.api);
    });

    const filediff = (n, p) => app.api('GET', `/api/local-tasks/${localId}/dirs/${dirId}/passes/${n}/filediff?path=${encodeURIComponent(p)}`);

    test('le diff du fichier touché par le suivi ne porte que ce que le suivi a écrit', async () => {
      const r = await filediff(2, 'PROJ_LOCAL_DRYRUN.md');
      assert.equal(r.status, 200, r.text);
      assert.match(r.body.diff, /^diff --git a\/PROJ_LOCAL_DRYRUN\.md b\/PROJ_LOCAL_DRYRUN\.md/m);
      const ajouts = r.body.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
      const retraits = r.body.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
      assert.ok(ajouts.length > 0, 'le suivi a écrit dans ce fichier');
      assert.deepEqual(retraits, [], 'le suivi n’a rien retiré : le diff est celui de l’itération, pas un cumul');
      // Ce que le fichier porte AU BOUT vaut deux passages ; le diff n'en montre qu'un.
      const trace = fs.readFileSync(path.join(dossier, 'PROJ_LOCAL_DRYRUN.md'), 'utf8');
      assert.equal(trace.split('## ').length - 1, 2, 'préalable : les deux passes ont écrit');
      assert.equal(ajouts.filter((l) => l.startsWith('+## ')).length, 1, 'un seul titre ajouté : celui du suivi');
    });

    test('un fichier que le suivi n’a pas touché a un diff vide, et un fichier hors arbre est refusé', async () => {
      const intact = await filediff(2, 'index.js');
      assert.equal(intact.status, 200, intact.text);
      assert.equal(intact.body.diff, '', 'présent dans l’arbre, mais inchangé par cette itération');

      assert.ok((await filediff(2, 'nexiste-pas.js')).status >= 400, 'un chemin hors arborescence est refusé');
      assert.ok((await filediff(2, '')).status >= 400, 'le chemin est obligatoire');
      assert.ok((await filediff(9, 'index.js')).status >= 400, 'une passe inconnue est refusée');
    });
  });
});
