'use strict';
/* PUBLIER LE LIEN D'UNE MERGE REQUEST SUR SON TICKET JIRA — UN COMMENTAIRE PAR TICKET, JAMAIS DE STATUT.
 *
 * L'entrée « Publier le lien de la MR sur {key} » du menu ⋯ d'une carte poste le commentaire ; elle
 * disparaît une fois publié. Une autre MR du même ticket se publie aussi, et RÉÉCRIT ce même
 * commentaire avec les deux liens. Mergée ensuite (case « Prévenir Jira à la fusion » décochée), son
 * entrée passe « mergée » dans ce commentaire. La case de la modale de merge publie le lien sans
 * toucher au statut. Aucun appel aux transitions Jira, nulle part.
 * Vrai navigateur, faux GitLab et faux Jira : on juge ce que Jira a REÇU et ce que la base porte. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Publier le lien d’une MR sur son ticket Jira', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let repo; let navigateur; let page;
  const id = {};
  const erreurs = [];
  const mr = (iid, branche, titre) => ({
    iid, title: titre, state: 'opened', source_branch: branche, target_branch: 'main',
    web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`, sha: repo.branchSha,
    created_at: `2026-01-0${iid - 19}T10:00:00.000Z`, author: { name: 'Alice' },
    diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
  });
  const ticket = (key) => { app.state.jiraIssues[key] = { key, fields: { summary: key, status: { name: 'En cours' } }, comments: [] }; };
  const commentaires = (key) => ((app.state.jiraIssues[key] || {}).comments || []).map((c) => JSON.stringify(c.body));
  const transitions = () => app.state.calls.filter((c) => /\/transitions/.test(c.path));
  const carte = (iid) => page.locator(`#toReviewList .card[data-id="${id[iid]}"]`);
  const entreeLien = (iid) => carte(iid).locator(`[data-jira-link="${id[iid]}"]`);
  /* Un poll de fond peut redessiner la carte et refermer le menu : on rouvre et on retente. */
  async function menuCliquer(iid, selecteur) {
    for (let essai = 0; ; essai += 1) {
      await carte(iid).locator(`[data-more="${id[iid]}"]`).click();
      try { await carte(iid).locator(selecteur).click({ timeout: 2000 }); return; } catch (e) { if (essai >= 4) throw e; }
    }
  }

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    for (const k of ['PROJ-50', 'PROJ-51']) ticket(k);
    app.state.mrs['grp/app'] = [
      mr(20, 'feature/PROJ-50-api', 'API du paiement'),
      mr(21, 'feature/PROJ-50-ecran', 'Écran du paiement'),
      mr(22, 'fix/PROJ-51-typo', 'Typo'),
    ];
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt', jira_notify_merge: 0 });
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').click();
    await carte(20).waitFor();
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('⋯ → « Publier le lien de la MR sur PROJ-50 » : un commentaire, aucun statut, et l’entrée disparaît', async () => {
    await menuCliquer(20, `[data-jira-link="${id[20]}"]`);
    await attendreServeur(() => commentaires('PROJ-50').length === 1, 'le commentaire arrive sur le ticket');
    assert.match(commentaires('PROJ-50')[0], /!20/);
    assert.match(commentaires('PROJ-50')[0], /merge_requests\/20/);
    await entreeLien(20).waitFor({ state: 'detached' });
    assert.equal(await entreeLien(21).count(), 1, 'l’autre MR du ticket garde son entrée');
    assert.deepEqual(transitions(), [], 'le statut du ticket n’est ni lu ni changé');
  });

  test('une deuxième MR du même ticket se publie aussi : le MÊME commentaire porte les deux liens', async () => {
    await menuCliquer(21, `[data-jira-link="${id[21]}"]`);
    await attendreServeur(() => /!21/.test(commentaires('PROJ-50')[0] || ''), 'le commentaire est réécrit');
    assert.equal(commentaires('PROJ-50').length, 1, 'toujours un seul commentaire');
    assert.match(commentaires('PROJ-50')[0], /!20[\s\S]*!21/);
    await entreeLien(21).waitFor({ state: 'detached' });
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM jira_merge_comment WHERE cle = ?').get('PROJ-50').n, 1);
  });

  test('mergée ensuite, case de fusion décochée : son entrée passe « mergée » dans ce commentaire', async () => {
    const r = await app.api('POST', `/api/mrs/${id[20]}/merge`, {});
    assert.equal(r.body.merged, true, r.text);
    await attendreServeur(() => /mergée : !20|merged: !20/.test(commentaires('PROJ-50')[0] || ''), 'l’entrée de !20 dit « mergée »');
    assert.equal(commentaires('PROJ-50').length, 1);
    assert.match(commentaires('PROJ-50')[0], /ouverte : !21|opened: !21/, '!21, elle, est toujours ouverte');
    assert.deepEqual(transitions(), []);
  });

  test('la case Jira de la modale de merge publie le lien, sans toucher au statut', async () => {
    await menuCliquer(22, `[data-merge="${id[22]}"]`);
    await page.waitForSelector('#mergeModal:not([hidden])');
    await page.locator('#mergeJiraRow:not([hidden])').waitFor();
    assert.match(await page.locator('#mergeJiraLbl').textContent(), /PROJ-51/);
    assert.doesNotMatch(await page.locator('#mergeJiraLbl').textContent(), /état suivant|next state/);
    await page.locator('#mergeJira').check();
    await page.locator('#mergeGo').click();
    await attendreServeur(() => commentaires('PROJ-51').length === 1, 'le lien arrive sur PROJ-51');
    assert.match(commentaires('PROJ-51')[0], /!22/);
    assert.deepEqual(transitions(), [], 'aucune transition demandée');
    assert.ok((await app.api('GET', `/api/mrs/${id[22]}`)).body.mr.jira_merge_notified_at, 'la MR est marquée publiée');
    assert.deepEqual(erreurs, []);
  });
});
