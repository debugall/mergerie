'use strict';
/* PRÉVENIR JIRA QUAND UNE MERGE REQUEST EST MERGÉE (Réglages → Jira).
 *
 * Le ticket est lu par ceux qui ne regardent jamais la forge : « c'est livré ? ». Opt-in d'équipe,
 * décoché par défaut ; le texte vient du gabarit (`jira_merge_template`, {url} obligatoire) ou du
 * message livré ; UN commentaire par merge request, quel que soit le chemin qui a vu le merge —
 * « Mettre à jour depuis la forge » puis la découverte n'écrivent pas deux fois ; et UN commentaire
 * par TICKET : la deuxième merge request du même ticket RÉÉCRIT le commentaire avec la liste, au lieu
 * d'en empiler un autre — sauf si Jira ne le laisse plus modifier (403 : il n'est plus le nôtre), où
 * un nouveau commentaire reprend la liste et devient celui qu'on suit. Rien pour une fermeture sans
 * merge, rien sans clé de ticket, rien quand la case est décochée.
 * Faux GitLab et faux Jira : on juge ce que Jira a REÇU, et ce que la base porte. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs, attendreServeur } = require('./helpers/app');

describe('Réglages → Jira : prévenir Jira à la fusion', () => {
  let app; let repo;
  const mr = (iid, branche, titre, extra = {}) => ({
    iid, title: titre, state: 'opened', source_branch: branche, target_branch: 'main',
    web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`, sha: repo.branchSha,
    created_at: new Date().toISOString(), author: { name: 'Alice' },
    diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha }, ...extra,
  });
  const ticket = (key) => { app.state.jiraIssues[key] = { key, fields: { summary: key, status: { name: 'En cours' } }, comments: [] }; };
  const commentaires = (key) => ((app.state.jiraIssues[key] || {}).comments || []).map((c) => JSON.stringify(c.body));
  const idDe = async (iid) => (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === iid).id;
  const merger = (iid) => { const m = app.state.mrs['grp/app'].find((x) => x.iid === iid); m.state = 'merged'; m.merged_at = '2026-05-01T10:00:00.000Z'; };

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    for (const k of ['PROJ-42', 'PROJ-43', 'PROJ-44', 'PROJ-45', 'PROJ-46']) ticket(k);
    app.state.mrs['grp/app'] = [
      mr(7, 'feature/PROJ-42-ajout', 'Ajout du paiement'),
      mr(8, 'chore/nettoyage', 'Nettoyage'),             // aucune clé, ni branche ni titre
      mr(9, 'fix/PROJ-43-typo', 'Typo'),                 // sera fermée SANS merge
      mr(10, 'feat/PROJ-44-export', 'Export CSV'),       // mergée, mais la case décochée
      mr(11, 'feat/PROJ-45-stats', 'Stats'),             // mergée avec le message livré
      mr(12, 'feat/PROJ-46-brief', 'Brief'),             // vue mergée par la DÉCOUVERTE
    ];
    await app.configure({
      jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt',
      jira_notify_merge: 1, jira_merge_template: '[{key}] MR !{iid} « {title} » ({branch} → {target}) mergée : {url}',
    });
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
  });
  after(async () => { await app.stop(); });

  test('un gabarit sans {url} est refusé, la valeur valide est conservée', async () => {
    const r = await app.api('PUT', '/api/config', { jira_merge_template: 'Mergée !' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /\{url\}/);
    assert.match((await app.api('GET', '/api/config')).body.jira_merge_template, /^\[\{key\}\]/);
    assert.equal(String((await app.api('GET', '/api/config')).body.jira_notify_merge), '1');
  });

  test('« Mettre à jour depuis la forge » sur une MR mergée : le ticket reçoit le commentaire du gabarit, une seule fois', async () => {
    const id = await idDe(7);
    assert.deepEqual(commentaires('PROJ-42'), [], 'rien tant qu’elle est ouverte');
    merger(7);
    const r = await app.api('POST', `/api/mrs/${id}/refresh`);
    assert.equal(r.body.etat, 'merged');
    await attendreServeur(() => commentaires('PROJ-42').length === 1, 'le commentaire arrive sur le ticket');
    const corps = commentaires('PROJ-42')[0];
    assert.match(corps, /\[PROJ-42\] MR !7 « Ajout du paiement » \(feature\/PROJ-42-ajout → main\) mergée : /);
    assert.match(corps, /merge_requests\/7/);
    const ligne = app.db.prepare('SELECT jira_merge_notified_at FROM mr WHERE id = ?').get(id);
    assert.ok(ligne.jira_merge_notified_at, 'la base retient que le ticket a été prévenu');
    // Revu une seconde fois (bouton, puis découverte) : pas de second commentaire.
    await app.api('POST', `/api/mrs/${id}/refresh`);
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
    assert.equal(commentaires('PROJ-42').length, 1, 'un commentaire par merge request');
  });

  test('sans clé de ticket : rien, et sans erreur', async () => {
    const id = await idDe(8);
    merger(8);
    const r = await app.api('POST', `/api/mrs/${id}/refresh`);
    assert.equal(r.status, 200);
    assert.equal(r.body.etat, 'merged');
    assert.equal(app.db.prepare('SELECT jira_merge_notified_at FROM mr WHERE id = ?').get(id).jira_merge_notified_at, null);
  });

  test('fermée sans merge : le ticket n’apprend rien', async () => {
    const id = await idDe(9);
    const m = app.state.mrs['grp/app'].find((x) => x.iid === 9); m.state = 'closed';
    const r = await app.api('POST', `/api/mrs/${id}/refresh`);
    assert.equal(r.body.etat, 'closed');
    await waitForJobs(app.api);
    assert.deepEqual(commentaires('PROJ-43'), []);
  });

  test('case décochée : une MR mergée ne commente pas', async () => {
    await app.api('PUT', '/api/config', { jira_notify_merge: 0 });
    const id = await idDe(10);
    merger(10);
    assert.equal((await app.api('POST', `/api/mrs/${id}/refresh`)).body.etat, 'merged');
    await waitForJobs(app.api);
    assert.deepEqual(commentaires('PROJ-44'), []);
    assert.equal(app.db.prepare('SELECT jira_merge_notified_at FROM mr WHERE id = ?').get(id).jira_merge_notified_at, null);
    await app.api('PUT', '/api/config', { jira_notify_merge: 1 });
  });

  test('gabarit vide : le message livré, avec le numéro et le lien', async () => {
    await app.api('PUT', '/api/config', { jira_merge_template: '' });
    const id = await idDe(11);
    merger(11);
    await app.api('POST', `/api/mrs/${id}/refresh`);
    await attendreServeur(() => commentaires('PROJ-45').length === 1, 'le commentaire livré arrive');
    assert.match(commentaires('PROJ-45')[0], /!11/);
    assert.match(commentaires('PROJ-45')[0], /merge_requests\/11/);
  });

  test('la découverte qui voit une MR disparaître mergée prévient aussi', async () => {
    merger(12);
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
    await attendreServeur(() => commentaires('PROJ-46').length === 1, 'la découverte a prévenu le ticket');
    assert.match(commentaires('PROJ-46')[0], /!12/);
  });

  test('une deuxième merge request du même ticket RÉÉCRIT le commentaire, avec les deux', async () => {
    await app.api('PUT', '/api/config', { jira_merge_template: '[{key}] MR !{iid} « {title} » mergée : {url}' });
    app.state.mrs['grp/app'].push(mr(13, 'feature/PROJ-42-suite', 'Suite du paiement'));
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
    const id = await idDe(13);
    merger(13);
    await app.api('POST', `/api/mrs/${id}/refresh`);
    await attendreServeur(() => /!13/.test(commentaires('PROJ-42')[0] || ''), 'le commentaire du ticket est réécrit');
    assert.equal(commentaires('PROJ-42').length, 1, 'toujours UN commentaire sur le ticket');
    const corps = commentaires('PROJ-42')[0];
    assert.match(corps, /\[PROJ-42\] MR !7 « Ajout du paiement » mergée : [\s\S]*\[PROJ-42\] MR !13 « Suite du paiement » mergée : /, 'la liste complète, dans l’ordre des fusions');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM mr WHERE jira_merge_key = ?').get('PROJ-42').n, 2);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM jira_merge_comment WHERE cle = ?').get('PROJ-42').n, 1);
  });

  test('le commentaire n’est plus modifiable (403) : un nouveau reprend la liste, et c’est lui qu’on suit ensuite', async () => {
    app.state.mrs['grp/app'].push(mr(14, 'feature/PROJ-42-fin', 'Fin du paiement'), mr(15, 'feature/PROJ-42-doc', 'Doc du paiement'));
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
    const ancien = app.db.prepare('SELECT comment_id FROM jira_merge_comment WHERE cle = ?').get('PROJ-42').comment_id;
    app.state.jiraCommentDenied = true;
    merger(14);
    await app.api('POST', `/api/mrs/${await idDe(14)}/refresh`);
    await attendreServeur(() => commentaires('PROJ-42').length === 2, 'un second commentaire, faute de pouvoir réécrire le premier');
    assert.match(commentaires('PROJ-42')[1], /!7[\s\S]*!13[\s\S]*!14/, 'il reprend toute la liste');
    const nouveau = app.db.prepare('SELECT comment_id FROM jira_merge_comment WHERE cle = ?').get('PROJ-42').comment_id;
    assert.notEqual(nouveau, ancien, 'c’est le nouveau qu’on suit');
    app.state.jiraCommentDenied = false;
    merger(15);
    await app.api('POST', `/api/mrs/${await idDe(15)}/refresh`);
    await attendreServeur(() => /!15/.test(commentaires('PROJ-42')[1] || ''), 'la fusion suivante réécrit le nouveau');
    assert.equal(commentaires('PROJ-42').length, 2);
    assert.doesNotMatch(commentaires('PROJ-42')[0], /!15/, 'l’ancien n’est plus touché');
  });
});
