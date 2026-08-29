'use strict';
/* LA NOTE GLOBALE EST UNE DONNÉE DE L'APPLICATION, PAS UNE COQUETTERIE DU RAPPORT.
 *
 * La liste des reviews colore, compte et FILTRE par note. Or la note n'existe que si l'IA a
 * pensé à en écrire une : elle est relue du rapport, jamais calculée. Un gabarit personnalisé
 * qui oublie de la demander — et il n'y a aucune raison qu'il y pense — produit donc des
 * rapports que le filtre laisse de côté, sans que rien ne le dise.
 *
 * On ne compte donc plus sur le gabarit : la consigne de note est ajoutée à L'EXÉCUTION, comme
 * les numéros de ligne et le bloc de constats. Et si malgré tout l'IA n'en met pas, le journal
 * du job le dit.
 *
 * Ici l'agent est remplacé par un décor : c'est le seul moyen de LIRE le prompt envoyé et de
 * choisir ce qu'il répond.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

describe('La note globale d’une review', () => {
  let app; let mrId; let copilot;
  const prompts = [];
  let reponse = '# Revue\n\nRien à signaler.\n\n## Note globale\n\n**8,4/10**\n';

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Ajout de b', state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!7'] = [{ new_path: 'src/app.js' }];
    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;

    // eslint-disable-next-line global-require
    copilot = require('../src/copilot');
    copilot.runPrompt = async (prompt) => { prompts.push(prompt); return reponse; };
  });
  after(async () => { await app.stop(); });

  const reviewer = async () => {
    prompts.length = 0;
    await app.api('POST', `/api/mrs/${mrId}/review`, {});
    await waitForJobs(app.api);
    return (await app.api('GET', '/api/jobs/current/log')).body.lines.map((l) => l.text);
  };
  const noteDeLaMr = async () => (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId).note;

  /* LE POINT PRINCIPAL : un gabarit qui ne parle pas de note du tout. C'est le cas de qui a
     réécrit le sien — et c'est exactement là que la liste se vidait en silence. */
  test('la consigne de note part même quand le gabarit n’en dit rien', async () => {
    await app.api('PUT', '/api/config', { prompt_review: 'Relis le diff {diff_file} et dis ce qui ne va pas.' });
    await reviewer();
    // Une passe complète envoie DEUX prompts : la revue, puis l'explication pédagogique.
    const revue = prompts.find((x) => /Relis le diff/.test(x));
    const explication = prompts.find((x) => /pédagogique/i.test(x));
    assert.ok(revue, 'le gabarit de l’utilisateur part bien, tel quel');
    assert.match(revue, /NOTE GLOBALE/, 'et la consigne de note s’y ajoute, quoi qu’il contienne');
    assert.match(revue, /Note globale : X\/10/, 'avec le FORMAT attendu : c’est lui qui sera relu');
    // Elle précède le bloc de constats, qui doit rester le dernier mot du fichier.
    assert.ok(revue.indexOf('NOTE GLOBALE') < revue.indexOf('constats structurés'),
      'la note se place avant le bloc de constats');
    /* L'explication n'est pas une revue : lui réclamer une note produirait un chiffre que
       personne ne lit et que la liste ne relira jamais. */
    assert.ok(explication && !/NOTE GLOBALE/.test(explication),
      'la consigne ne part pas avec l’explication pédagogique');
  });

  test('la note écrite par l’IA est relue et exposée', async () => {
    const note = await noteDeLaMr();
    assert.ok(note, 'la MR porte une note');
    assert.equal(note.raw, '8,4/10');
    assert.ok(Math.abs(note.value - 0.84) < 0.001, `valeur normalisée : ${note.value}`);
  });

  /* ET SI ELLE N'EN MET PAS QUAND MÊME. Le rapport existe, il est juste sans note : la carte
     affichera « — ». Ce qu'on refuse, c'est le silence — le journal du job doit le dire. */
  test('un rapport sans note est signalé dans le journal, pas passé sous silence', async () => {
    reponse = '# Revue\n\nDu texte, et aucune note nulle part.\n';
    const lignes = await reviewer();
    assert.equal(await noteDeLaMr(), null, 'aucune note : on n’en invente pas une');
    assert.ok(lignes.some((l) => /aucune note globale/i.test(l)),
      `le journal signale l’absence : ${JSON.stringify(lignes.slice(-4))}`);
    assert.ok(lignes.some((l) => /rapport enregistré/i.test(l)),
      'le rapport est enregistré malgré tout : une review sans note reste une review');
  });

  /* Une note en toutes lettres dans le rapport suffit — le format demandé est une aide, pas
     une serrure : `extractNote` sait lire les formes courantes. */
  test('une note écrite autrement est lue quand même', async () => {
    reponse = '# Revue\n\nDes remarques.\n\nNote globale : 6/10\n';
    await reviewer();
    const note = await noteDeLaMr();
    assert.equal(note && note.raw, '6/10');
  });
});
