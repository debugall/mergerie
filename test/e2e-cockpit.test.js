'use strict';
/* LE COCKPIT ET « LANCER MA JOURNÉE » (agent-autonome, étape 4).
 *
 *   1. « Lancer ma journée » crée et lance une session par ticket : ses dépôts et sa branche viennent des
 *      jetons du ticket, sa demande de ses lignes `&&>`, sa chaîne de validation de la session modèle ;
 *      un ticket qui ne nomme aucun dépôt revient avec sa raison ; un appel Jira par ticket ;
 *      préparer (Jira) puis créer (sans Jira) : enregistrer sans lancer, lancer plus tard, un par un ;
 *      supprimer un élément emporte les sessions de son ticket, jamais une session qui tourne ;
 *   2. « mes tickets » : ceux du compte, non terminés ;
 *   3. le cockpit range les sessions : à toi (question, chaîne arrêtée), en cours, terminé ;
 *   4. l'écran : le sous-onglet de Dev IA, la fenêtre de journée (mes tickets, modèle), les sections.
 * Faux GitLab, faux Jira, vrai dépôt, agent de test. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Cockpit et « Lancer ma journée »', () => {
  let app; let repo; let repoId; let vId; let modeleId; let bin;
  const texte = (t) => ({ type: 'text', text: t });
  const ticket = (key, summary, lignes, { assignee = 'me-test', commentaires = [] } = {}) => {
    app.state.jiraIssues[key] = {
      key,
      fields: {
        summary, status: { name: 'À faire', statusCategory: { key: 'new' } }, issuetype: { name: 'Story' },
        assignee: assignee ? { accountId: assignee, displayName: 'Moi' } : null,
        description: { type: 'doc', version: 1, content: lignes.map((l) => ({ type: 'paragraph', content: [texte(l)] })) },
        comment: { comments: commentaires.map((c) => ({ author: { displayName: c.auteur }, created: '2026-11-20T09:00:00.000+0000', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [texte(c.texte)] }] } })) },
      },
    };
  };

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jt', jira_watch_minutes: '0' });
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/paiement' })).body.id;
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-bin-'));
    const script = path.join(bin, 'v.sh');
    fs.writeFileSync(script, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    vId = (await app.api('POST', '/api/verifiers', {
      name: 'unitaires', kind: 'commands', commands: [script], timeout_s: 60, run_base: 0, repos: [{ repo_id: repoId, mode: 'worktree' }],
    })).body.id;
    // La session modèle : sa chaîne sera reprise par les sessions de la journée.
    modeleId = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'modèle', label: 'Modèle de chaîne', auto_push: true, verify_chain: [vId], targets: [{ repo_id: repoId, branch: 'ai/modele' }],
    })).body.id;
    ticket('PROJ-70', 'Remise fidélité', ['La remise vit dans &&paiement:ai/proj-70-remise.', '&&> Ajoute la remise fidélité au panier']);
    ticket('PROJ-71', 'Sans dépôt', ['Rien ne nomme le dépôt ici.'], { commentaires: [{ auteur: 'Léa', texte: 'Ça se passe dans le module paiement, côté remboursement.' }] });
    ticket('PROJ-72', 'Pas à moi', ['&&paiement'], { assignee: 'quelqu-un' });
    ticket('PROJ-74', 'À jeter', ['&&paiement:ai/proj-74']);
  });
  after(async () => { if (app) await app.stop(); });

  test('« Lancer ma journée » : une session par ticket, dépôt, branche et demande du ticket, chaîne du modèle', async () => {
    app.state.calls.length = 0;
    const r = await app.api('POST', '/api/cockpit/journee', { keys: ['PROJ-70', 'proj-71', 'pas une clé'], modele_id: modeleId });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.lancees.map((x) => x.key), ['PROJ-70']);
    assert.equal(r.body.ignores.length, 1);
    assert.equal(r.body.ignores[0].key, 'PROJ-71');
    assert.match(r.body.ignores[0].raison, /&&/);
    assert.equal(r.body.jira_calls, 2, 'un appel Jira par ticket');
    assert.equal(app.state.calls.filter((c) => c.path.startsWith('/rest/api/3/issue/')).length, 2);

    const id = r.body.lancees[0].task_id;
    const t = (await app.api('GET', `/api/tasks/${id}`)).body.task;
    assert.equal(t.targets.length, 1);
    assert.equal(t.targets[0].repo_id, repoId);
    assert.equal(t.targets[0].branch, 'ai/proj-70-remise', 'la branche du jeton');
    assert.match(t.prompt, /Ajoute la remise fidélité au panier/, 'la demande `&&>` du ticket');
    assert.doesNotMatch(t.prompt, /&&/, 'aucun jeton ne part chez l’agent');
    assert.match(t.label, /^PROJ-70 Remise fidélité/);
    assert.equal(t.verify_chain, JSON.stringify([vId]), 'la chaîne du modèle');
    assert.equal(t.auto_push, 1);
    await waitForJobs(app.api);
    await attendreServeur(async () => {
      const c = (await app.api('GET', `/api/tasks/${id}/chaine`)).body;
      return c && c.status === 'passed';
    }, 'la session a tourné et sa chaîne est verte', 60000);
  });

  test('préparer (un appel Jira par ticket), puis enregistrer sans lancer, avec le dépôt saisi : prête, lancée plus tard', async () => {
    app.state.calls.length = 0;
    const p = (await app.api('POST', '/api/cockpit/journee/preparer', { keys: ['PROJ-70', 'PROJ-71'] })).body;
    assert.equal(p.jira_calls, 2);
    assert.equal(app.state.calls.filter((c) => c.path.startsWith('/rest/api/3/issue/')).length, 2);
    const t70 = p.tickets.find((x) => x.key === 'PROJ-70');
    const t71 = p.tickets.find((x) => x.key === 'PROJ-71');
    assert.deepEqual(t70.targets.map((g) => [g.repo_id, g.branch]), [[repoId, 'ai/proj-70-remise']]);
    assert.equal(t70.manque, null);
    assert.deepEqual(t71.targets, [], 'rien deviné');
    assert.match(t71.manque, /&&/);
    assert.match(t71.branche_defaut, /^feature\/PROJ-71-sans-depot/);
    // Le ticket entier, pour choisir où ranger : description, commentaires — et le dépôt qu'ils citent sans jeton.
    assert.match(t71.ticket.description, /Rien ne nomme le dépôt ici/);
    assert.equal(t71.ticket.status, 'À faire');
    assert.deepEqual(t71.ticket.comments.map((c) => [c.author, c.bodyMd.trim()]), [['Léa', 'Ça se passe dans le module paiement, côté remboursement.']]);
    assert.deepEqual(t71.suggestions, [{ repo_id: repoId, project: 'grp/paiement' }], '« paiement » est cité');
    assert.deepEqual(t70.suggestions, [], 'un dépôt déjà posé par jeton n’est pas resuggéré');
    assert.equal(app.state.calls.length, 2, 'préparer ne crée rien d’autre');

    const sans = (await app.api('POST', '/api/cockpit/journee/creer', { sessions: [{ ...t71, targets: [] }], modele_id: modeleId, lancer: false })).body;
    assert.equal(sans.creees.length, 0);
    assert.match(sans.ignores[0].raison, /&&/);
    app.state.calls.length = 0;
    const r = (await app.api('POST', '/api/cockpit/journee/creer', {
      sessions: [{ ...t71, targets: [{ repo_id: repoId, branch: 'ai/proj-71-saisie', base_branch: '' }] }], modele_id: modeleId, lancer: false,
    })).body;
    assert.equal(app.state.calls.length, 0, 'créer ne coûte aucun appel Jira');
    const id = r.creees[0].task_id;
    assert.equal(r.creees[0].lancee, false);
    const t = (await app.api('GET', `/api/tasks/${id}`)).body.task;
    assert.equal(t.status, 'new', 'enregistrée, pas lancée');
    assert.equal(t.jira_key, 'PROJ-71');
    assert.equal(t.targets[0].branch, 'ai/proj-71-saisie');
    assert.equal(t.verify_chain, JSON.stringify([vId]));
    const d = (await app.api('GET', '/api/cockpit')).body;
    assert.ok(d.pret.some((l) => l.task_id === id && l.jira_key === 'PROJ-71'), 'dans « Prêt à lancer »');
    // Lancée plus tard, seule.
    assert.equal((await app.api('POST', `/api/tasks/${id}/run`, {})).status, 200);
    await waitForJobs(app.api);
    await attendreServeur(async () => ((await app.api('GET', `/api/tasks/${id}/chaine`)).body || {}).status === 'passed', 'lancée, sa chaîne aboutit', 60000);
    assert.ok(!(await app.api('GET', '/api/cockpit')).body.pret.some((l) => l.task_id === id));
  });

  test('supprimer un élément : la session et celles du même ticket, chaîne comprise ; jamais une session d’un autre ticket', async () => {
    const t = (await app.api('POST', '/api/cockpit/journee/preparer', { keys: ['PROJ-74'] })).body.tickets[0];
    const a = (await app.api('POST', '/api/cockpit/journee/creer', { sessions: [t], modele_id: modeleId, lancer: false })).body.creees[0].task_id;
    const b = (await app.api('POST', '/api/cockpit/journee/creer', { sessions: [t], modele_id: modeleId, lancer: false })).body.creees[0].task_id;
    const avant = 2;
    const d = (await app.api('GET', '/api/cockpit')).body;
    assert.equal(d.pret.find((l) => l.task_id === a).n_ticket, avant, 'la confirmation dira combien');
    const r = await app.api('POST', '/api/cockpit/supprimer', { task_id: a });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.supprimees.length, avant);
    assert.ok(r.body.supprimees.includes(b));
    assert.equal((await app.api('GET', `/api/tasks/${b}`)).status, 400, 'supprimée');
    assert.equal((await app.api('GET', '/api/tasks')).body.filter((x) => x.jira_key === 'PROJ-74').length, 0);
    assert.ok((await app.api('GET', '/api/tasks')).body.some((x) => x.jira_key === 'PROJ-70'), 'l’autre ticket reste');
  });

  test('« mes tickets » : ceux du compte, non terminés', async () => {
    const r = await app.api('GET', '/api/cockpit/mes-tickets');
    assert.equal(r.status, 200, r.text);
    const cles = r.body.tickets.map((x) => x.key);
    assert.ok(cles.includes('PROJ-70') && cles.includes('PROJ-71'));
    assert.ok(!cles.includes('PROJ-72'), 'pas un ticket affecté à quelqu’un d’autre');
  });

  test('le cockpit range : à toi (chaîne arrêtée), en cours, terminé', async () => {
    let d = (await app.api('GET', '/api/cockpit')).body;
    assert.ok(d.termine.some((l) => /PROJ-70/.test(l.label)), 'la session de la journée a abouti');
    assert.ok(d.modeles.some((m) => m.id === modeleId), 'le modèle est proposé');
    // Une chaîne arrêtée : le vérificateur casse la base.
    fs.writeFileSync(path.join(bin, 'v.sh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = await app.api('POST', '/api/cockpit/journee', { keys: ['PROJ-70'], modele_id: modeleId });
    const id = r.body.lancees[0].task_id;
    await waitForJobs(app.api);
    await attendreServeur(async () => ((await app.api('GET', `/api/tasks/${id}/chaine`)).body || {}).status === 'attention', 'la chaîne s’arrête', 60000);
    d = (await app.api('GET', '/api/cockpit')).body;
    const ligne = d.a_toi.find((l) => l.task_id === id);
    assert.ok(ligne, 'elle est « à toi »');
    assert.equal(ligne.quoi, 'chaine');
    assert.deepEqual(ligne.raisons, [{ quoi: 'base', nom: 'unitaires' }]);
    // La frise : codage et push faits, le vérificateur arrêté sur la base — l'étape courante —, le reste à venir.
    const wf = ligne.workflow;
    assert.deepEqual(wf.etapes.map((e) => [e.cle, e.cote || '', e.etat]), [
      ['code', '', 'fait'], ['push', '', 'fait'], ['verif', 'base', 'a_toi'], ['verif', 'head', 'a_venir'], ['validee', '', 'a_venir'],
    ]);
    assert.equal(wf.courante, 2, 'l’étape courante est la base cassée');
    assert.ok(wf.etapes[2].verification_id, 'elle mène à sa vérification');
    assert.deepEqual(wf.continuer, { action: 'chaine' }, 'arrêtée : « Continuer » relance la chaîne');
    const st = (await app.api('GET', '/api/status')).body;
    assert.equal(st.tasksAToi, d.a_toi.length, 'la pastille du menu compte les lignes « à toi »');
    fs.writeFileSync(path.join(bin, 'v.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });

  test('« Lancer ma journée » reprend « …puis converger » du modèle : la session créée converge', async () => {
    const modele = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'modèle convergent', label: 'Modèle qui converge', converge_after: true, targets: [{ repo_id: repoId, branch: 'ai/modele-conv' }],
    })).body;
    const d0 = (await app.api('GET', '/api/cockpit')).body;
    assert.ok(d0.modeles.find((m) => m.id === modele.id).converge, 'proposé comme modèle, avec sa convergence');
    const r = await app.api('POST', '/api/cockpit/journee/creer', {
      sessions: [{ key: 'PROJ-75', summary: 'Convergente', prompt: 'Code puis converge', targets: [{ repo_id: repoId, branch: 'ai/proj-75' }] }],
      modele_id: modele.id, lancer: false,
    });
    const id = r.body.creees[0].task_id;
    assert.equal(app.db.prepare('SELECT converge_after FROM task WHERE id = ?').get(id).converge_after, 1);
    const job = await app.api('POST', `/api/tasks/${id}/run`, {});
    assert.equal(job.body.kind, 'converge-session', '« Lancer » du cockpit converge');
    await waitForJobs(app.api);
    await app.api('DELETE', `/api/tasks/${id}`);
    await app.api('DELETE', `/api/tasks/${modele.id}`);
  });

  test('la frise d’une session prête à lancer montre tout ce qui va se passer : codage, push, chaîne, scénario, validée', async () => {
    const t = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'frise', auto_push: true, verify_chain: [vId], verify_chain_scenario: { verifier_id: vId },
      targets: [{ repo_id: repoId, branch: 'ai/frise' }],
    })).body;
    const d = (await app.api('GET', '/api/cockpit')).body;
    const l = d.pret.find((x) => x.task_id === t.id);
    assert.ok(l, 'prête à lancer');
    assert.deepEqual(l.workflow.etapes.map((e) => e.cle),
      ['code', 'push', 'verif', 'verif', 'scen-ecrire', 'scen-pousser', 'scen-lancer', 'validee']);
    assert.ok(l.workflow.etapes.every((e) => e.etat === 'a_venir'), 'rien n’a commencé');
    assert.equal(l.workflow.courante, null);
    await app.api('DELETE', `/api/tasks/${t.id}`);
  });

  test('la boucle de convergence dans la frise : review, puis correction et review par passe, la passe courante, les passes possibles', async () => {
    // eslint-disable-next-line global-require
    const { etapesConvergence } = require('../src/jobs/workflow');
    const resume = (etapes) => etapes.map((e) => `${e.cle}${e.n == null ? '' : e.n}:${e.etat}${e.si ? '?' : ''}`);
    // Deuxième passe : la correction 2 tourne ; la review 2 et la passe 3 n'auront lieu que si la note reste basse.
    assert.deepEqual(resume(etapesConvergence({ status: 'running', phase: 'fix', passes_done: 1, max_passes: 3, notes_json: '[5.2,6.8]' }, null, 3)),
      ['review0:fait', 'fix1:fait', 'review1:fait', 'fix2:en_cours', 'review2:a_venir', 'fix3:a_venir?', 'review3:a_venir?']);
    // La review de la deuxième passe tourne.
    assert.deepEqual(resume(etapesConvergence({ status: 'running', phase: 'review', passes_done: 2, max_passes: 3, notes_json: '[5.2,6.8]' }, null, 3)).slice(3, 5),
      ['fix2:fait', 'review2:en_cours']);
    // Finie au seuil après deux passes : rien d'autre, et la fin le dit.
    const fini = etapesConvergence({ status: 'converged', phase: null, passes_done: 2, max_passes: 3, notes_json: '[5.2,6.8,8.4]', best_note: 8.4 }, null, 3);
    assert.deepEqual(resume(fini), ['review0:fait', 'fix1:fait', 'review1:fait', 'fix2:fait', 'review2:fait', 'converge-fin:fait']);
    assert.equal(fini[4].note, 8.4);
    // Une question pendant la correction : à toi depuis qu'elle est posée ; la review de la passe suivra la
    // réponse, puis les passes restantes si la note reste basse.
    const question = etapesConvergence({ status: 'needs_input', phase: 'fix', passes_done: 0, max_passes: 3, threshold: 8, notes_json: '[4]', finished_at: '2026-11-27T09:00:00Z' }, null, 3);
    assert.deepEqual(resume(question), ['review0:fait', 'fix1:a_toi', 'review1:a_venir', 'fix2:a_venir?', 'review2:a_venir?', 'fix3:a_venir?', 'review3:a_venir?']);
    assert.equal(question[1].depuis, '2026-11-27T09:00:00Z');
    // Chaque étape porte la note visée et les passes permises ; l'étape qui tourne, l'heure de son début.
    const enCours = etapesConvergence({ status: 'running', phase: 'fix', passes_done: 1, max_passes: 4, threshold: 7.5, notes_json: '[5,6]', started_at: '2026-11-27T08:00:00Z', phase_at: '2026-11-27T08:40:00Z' }, null, 3);
    assert.ok(enCours.every((e) => e.seuil === 7.5 && e.max === 4));
    assert.deepEqual(enCours.filter((e) => e.depuis).map((e) => `${e.cle}${e.n}:${e.depuis}`), ['fix2:2026-11-27T08:40:00Z'], 'seule l’étape qui tourne a une heure');
    // Coupée pendant la review de la première passe (serveur arrêté) : cette étape porte l'échec, rien après.
    assert.deepEqual(resume(etapesConvergence({ status: 'stopped', phase: 'review', passes_done: 1, max_passes: 3, notes_json: '[5]' }, null, 3)),
      ['review0:fait', 'fix1:fait', 'review1:echec']);
    // Une session sans projet (ses dépôts ont disparu) : une frise vide, jamais une erreur qui viderait la liste.
    // eslint-disable-next-line global-require
    const { frise } = require('../src/jobs/workflow');
    for (const status of ['needs_input', 'error', 'pushed']) {
      assert.deepEqual(frise({ id: 999999, kind: 'code', status, created_at: '' }, {}).etapes, [], status);
    }
    // Pas encore de boucle (le job vient de partir) : la review, puis les passes possibles.
    assert.deepEqual(resume(etapesConvergence(null, null, 2)), ['review0:a_venir', 'fix1:a_venir?', 'review1:a_venir?', 'fix2:a_venir?', 'review2:a_venir?']);
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
      await page.locator('#tab-task .subnav [data-vue="cockpit"]').click();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('le sous-onglet de Dev IA montre les trois sections, la chaîne arrêtée « à toi », et sa session s’ouvre d’un clic', async () => {
      assert.equal(await page.locator('nav button[data-tab="cockpit"]').count(), 0, 'plus de menu à part');
      assert.equal(await page.locator('#taskList').isHidden(), true, 'le cockpit remplace la liste');
      await page.locator('#cockpitBox [data-cockpit-sec="a_toi"] .cockpit-item.is-chaine').first().waitFor();
      assert.match(await page.locator('#cockpitBox [data-cockpit-sec="a_toi"] .cockpit-pourquoi').first().textContent(), /base cassée/);
      // La frise par phases : la phase courante — la validation — mise en avant, son résumé dit l'étape qui attend.
      const ligneATOi = page.locator('#cockpitBox [data-cockpit-sec="a_toi"] .cockpit-item.is-chaine').first();
      const phase = ligneATOi.locator('.frise-phase.is-courante');
      await phase.waitFor();
      assert.match(await phase.getAttribute('class'), /is-a_toi/);
      assert.match(await phase.textContent(), /Validation[\s\S]*unitaires · base[\s\S]*à toi/);
      assert.deepEqual(await ligneATOi.locator('.frise-phase .frise-nom').allTextContents(), ['Code & push', 'Validation', 'Validée']);
      // Ses étapes sont repliées ; un clic sur l'en-tête de la phase les montre, l'étape courante en avant.
      const courante = ligneATOi.locator('.frise-etape.is-courante');
      assert.equal(await courante.isVisible(), false, 'repliées : le résumé suffit');
      await phase.locator('.frise-phase-tete').click();
      await courante.waitFor();
      assert.match(await courante.textContent(), /unitaires · base/);
      await phase.locator('.frise-phase-tete').click();
      await courante.waitFor({ state: 'hidden' });
      // « Continuer » au bout de la rangée des phases ; plus de ligne « Étape en cours » qui redirait la phase.
      assert.equal(await ligneATOi.locator('.frise-phases [data-frise-continuer]').count(), 1);
      assert.doesNotMatch(await ligneATOi.locator('.frise').textContent(), /Étape en cours/);
      assert.ok(await page.locator('#cockpitBox [data-cockpit-sec="a_toi"] .frise').first().locator('.frise-etape').count() >= 5, 'codage, push, base, branche, validée');
      await page.locator('#cockpitBox [data-cockpit-sec="termine"] .cockpit-item').first().waitFor();
      const id = await page.locator('#cockpitBox [data-cockpit-sec="a_toi"] [data-cockpit-open]').first().getAttribute('data-cockpit-open');
      await page.locator('#cockpitBox [data-cockpit-sec="a_toi"] [data-cockpit-open]').first().click();
      // La session s'ouvre dans « Codage », même si Codage était déjà la saveur choisie.
      await page.locator(`#taskList .task-row[data-task="${id}"]`).waitFor();
      assert.equal(await page.locator('#tab-task.vue-cockpit').count(), 0);
      assert.equal(await page.locator('#tab-task .subnav [data-kind="code"].active').count(), 1);
      assert.equal(await page.locator('#cockpitBox').isHidden(), true);
      // La pastille orange de Dev IA dit ce qui attend, et y mène.
      await page.locator('#navATOiTask:not([hidden])').waitFor();
      assert.match(await page.locator('#navATOiTask').getAttribute('aria-label'), /cockpit/);
      await page.locator('#navATOiTask').click();
      await page.locator('#tab-task.active.vue-cockpit #cockpitBox [data-cockpit-sec="a_toi"]').waitFor();
      await page.locator('#tab-task .subnav [data-kind="code"]').click();
      // Rouvrir Dev IA après un rechargement : la vue choisie est gardée.
      await page.locator('#tab-task .subnav [data-vue="cockpit"]').click();
      await page.goto(app.base);
      await page.locator('#tab-task.active.vue-cockpit #cockpitBox [data-cockpit-sec="a_toi"]').waitFor();
      assert.deepEqual(erreurs, []);
    });

    test('le rendu en pipeline : un nœud par phase, la note et sa courbe vers l’objectif, passe et durée, grille base / branche / diagnostic, MR, arrivée, une phase ouverte à la fois', async () => {
      const html = await page.evaluate(() => {
        const ilYa = (min) => new Date(Date.now() - min * 60000).toISOString();
        const v = (nom, cote, etat, id) => ({ cle: 'verif', cote, nom, etat, verification_id: id });
        const etapes = [
          { cle: 'code', etat: 'fait' }, { cle: 'push', etat: 'fait', mr_iid: 42, mr_url: 'https://gitlab.test/g/p/-/merge_requests/42' },
          { cle: 'review', n: 0, etat: 'fait', note: 5.1, seuil: 8, max: 3 }, { cle: 'fix', n: 1, etat: 'fait', seuil: 8, max: 3 },
          { cle: 'review', n: 1, etat: 'fait', note: 6.4, seuil: 8, max: 3 }, { cle: 'fix', n: 2, etat: 'fait', seuil: 8, max: 3 },
          { cle: 'review', n: 2, etat: 'fait', note: 7.2, seuil: 8, max: 3 }, { cle: 'fix', n: 3, etat: 'a_toi', seuil: 8, max: 3, depuis: ilYa(14) },
          { cle: 'review', n: 3, etat: 'a_venir', seuil: 8, max: 3 },
          v('unitaires', 'base', 'a_venir'), v('unitaires', 'head', 'a_venir'), v('front', 'base', 'a_venir'), v('front', 'head', 'a_venir'),
          { cle: 'validee', etat: 'a_venir' },
        ];
        const enAttente = friseHtml({ id: 9001, kind: 'code', workflow: { etapes, courante: 7, continuer: { action: 'repondre' } } });
        const valid = [
          { cle: 'code', etat: 'fait' }, { cle: 'push', etat: 'fait' },
          v('integ', 'base', 'fait', 11), v('integ', 'head', 'fait', 12),
          v('tests front', 'base', 'a_toi', 13), v('tests front', 'head', 'a_venir'),
          v('paiement', 'base', 'fait', 15), v('paiement', 'head', 'echec', 16), { cle: 'diag', nom: 'paiement', etat: 'a_toi', detail: 'environnement' },
          { cle: 'validee', etat: 'a_venir' },
        ];
        const enValidation = friseHtml({ id: 9002, kind: 'code', workflow: { etapes: valid, courante: 4, continuer: { action: 'chaine' } } });
        const box = document.createElement('div');
        box.id = 'friseEssai';
        box.innerHTML = enAttente + enValidation;
        document.body.appendChild(box);
        return true;
      });
      assert.ok(html);
      const a = page.locator('#friseEssai [data-frise="code-9001"]');
      // Un nœud par phase sur le rail : fait, à toi, puis les suivantes numérotées, et l'arrivée.
      assert.equal(await a.locator('.frise-phase .frise-noeud').count(), 4);
      assert.deepEqual(await a.locator('.frise-noeud-n').allTextContents(), ['3', '4']);
      const conv = a.locator('.frise-phase.ph-convergence');
      // La dernière note en grand, l'objectif, la courbe des notes ; la passe, le statut et depuis quand.
      assert.equal(await conv.locator('.frise-score').textContent(), '7,2');
      assert.match(await conv.textContent(), /objectif 8[\s\S]*passe 3\/3 · correction[\s\S]*à toi · depuis 1[45] min/);
      assert.equal(await conv.locator('svg.frise-courbe').getAttribute('aria-label'), '5,1 → 6,4 → 7,2 · objectif 8');
      assert.equal(await conv.locator('svg.frise-courbe polyline').count(), 1);
      // « Répondre » sous la phase arrêtée.
      assert.equal(await conv.locator('[data-frise-continuer][data-action="repondre"]').count(), 1);
      // Pas encore commencée, la validation nomme déjà ses vérificateurs, et le compte des verts.
      const val = a.locator('.frise-phase.ph-validation');
      assert.deepEqual(await val.locator('.frise-grille-l:not(.frise-grille-tete) .frise-grille-nom').allTextContents(), ['unitaires', 'front']);
      assert.equal(await val.locator('.frise-compte').textContent(), '0/2');
      // La MR en lien sur la phase Code ; « Validée » n'est qu'une arrivée ; plus de compteur d'étapes.
      assert.equal(await a.locator('.frise-mr').getAttribute('href'), 'https://gitlab.test/g/p/-/merge_requests/42');
      assert.equal(await a.locator('.frise-phase.is-terminus').count(), 1);
      assert.equal(await a.locator('.frise-avance').count(), 0);
      // Les étapes dépliées nomment la passe.
      await conv.locator('.frise-phase-tete').click();
      assert.deepEqual((await a.locator('.frise-etapes:not([hidden]) .frise-nom').allTextContents()).slice(0, 3), ['Review initiale', 'Passe 1 · correction', 'Passe 1 · review']);
      // Une seule phase ouverte par bande : ouvrir le code referme la convergence.
      await a.locator('.frise-phase', { hasText: 'Code & push' }).locator('.frise-phase-tete').click();
      assert.equal(await a.locator('.frise-etapes:not([hidden])').count(), 1);
      assert.equal(await a.locator('.frise-phase.is-ouverte .frise-nom').textContent(), 'Code & push');
      assert.equal(await conv.locator('.frise-phase-tete').getAttribute('aria-expanded'), 'false');

      // La grille : un en-tête base / branche / diag., une icône par case — l'état ne tient pas qu'à la couleur —,
      // un libellé lisible, et une case qui ouvre son rapport.
      const b = page.locator('#friseEssai [data-frise="code-9002"] .frise-grille');
      assert.match(await b.locator('.frise-grille-tete').textContent(), /base[\s\S]*branche[\s\S]*diag/);
      assert.equal(await b.locator('.frise-grille-l:not(.frise-grille-tete)').count(), 3);
      assert.equal(await b.locator('.frise-case:not(.is-vide) svg, .frise-case:not(.is-vide) .frise-point').count(), 7);
      assert.equal(await b.locator('.frise-case.is-echec').getAttribute('aria-label'), 'paiement — branche — en échec');
      assert.equal(await b.locator('.frise-case[data-chaine-verif="16"]').getAttribute('role'), 'button');
      const enCours = page.locator('#friseEssai [data-frise="code-9002"] .frise-phase.is-courante');
      assert.match(await enCours.textContent(), /tests front · base[\s\S]*à toi/);
      assert.equal(await enCours.locator('.frise-compte').getAttribute('aria-label'), '1/3 vérificateur vert');
      // Les animations partent de l'horloge commune : un rendu ne les fait pas repartir de zéro.
      await page.evaluate(() => friseHorloge());
      assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--frise-t')), /^-\d+(\.\d+)?s$/);
      await page.evaluate(() => document.getElementById('friseEssai').remove());
      assert.deepEqual(erreurs, []);
    });

    test('relu toutes les 3 s, le cockpit ne se réécrit pas quand rien ne change : une phase dépliée et le focus restent', async () => {
      await page.locator('#tab-task .subnav [data-vue="cockpit"]').click();
      const item = page.locator('#cockpitBox .cockpit-item').first();
      await item.waitFor();
      // Les mêmes données rendues une seconde fois, d'un trait (la minute de « depuis » ne peut pas tourner entre les deux).
      const garde = await page.evaluate(() => {
        document.querySelector('#cockpitBox .cockpit-item').dataset.marque = 'là';
        renderCockpit(cockpitDonnees);
        const memes = document.querySelector('#cockpitBox .cockpit-item').dataset.marque;
        renderCockpit({ ...cockpitDonnees, a_toi: [] });   // des données qui changent, elles, réécrivent
        return [memes, document.querySelector('#cockpitBox .cockpit-item').dataset.marque || null];
      });
      assert.deepEqual(garde, ['là', null]);
      await page.evaluate(() => renderCockpit(cockpitDonnees));
    });

    test('une session sur deux dépôts : une frise entière par dépôt, la validation rangée dans les dépôts que chaque vérificateur couvre', async () => {
      const autre = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'autre-')));
      const autreId = (await app.api('POST', '/api/repos', { url: autre.url, project: 'grp/catalogue' })).body.id;
      const t = (await app.api('POST', '/api/tasks', {
        kind: 'code', prompt: 'deux dépôts', label: 'Deux dépôts', auto_push: true, verify_chain: [vId],
        targets: [{ repo_id: repoId, branch: 'ai/deux' }, { repo_id: autreId, branch: 'ai/deux' }],
      })).body;
      // Le serveur range chaque étape de la chaîne : « unitaires » ne couvre que grp/paiement ; « validée », partout.
      const wf = (await app.api('GET', '/api/tasks')).body.find((x) => x.id === t.id).workflow;
      const lignes = [...new Set(wf.etapes.filter((e) => e.cible != null).map((e) => e.cible))];
      assert.equal(lignes.length, 2);
      assert.deepEqual(wf.etapes.filter((e) => e.cle === 'verif').map((e) => e.cibles), [[lignes[0]], [lignes[0]]]);
      assert.deepEqual(wf.etapes.find((e) => e.cle === 'validee').cibles, lignes);
      await page.locator('#tab-task .subnav [data-vue="cockpit"]').click();
      const ligne = page.locator(`#cockpitBox .cockpit-item[data-cockpit-task="${t.id}"]`);
      await ligne.locator('.frise-groupe').first().waitFor();
      // Plus de groupe « tous les dépôts » : chaque frise est entière.
      assert.deepEqual(await ligne.locator('.frise-groupe-nom').allTextContents(), ['grp/paiement', 'grp/catalogue']);
      assert.deepEqual((await ligne.locator('.frise-groupe').nth(0).locator('.frise-etape .frise-nom').allTextContents()).slice(0, 2), ['Codage', 'Push'], 'sans répéter le dépôt');
      assert.deepEqual(await ligne.locator('.frise-groupe').nth(0).locator('.frise-phase .frise-nom').allTextContents(), ['Code & push', 'Validation', 'Validée']);
      assert.match(await ligne.locator('.frise-groupe').nth(0).locator('.frise-grille').textContent(), /unitaires/);
      assert.deepEqual(await ligne.locator('.frise-groupe').nth(1).locator('.frise-phase .frise-nom').allTextContents(), ['Code & push', 'Validée'], 'aucun vérificateur ne couvre grp/catalogue');
      // Les cartes de Codage dessinent la même chose (la liste relue : la session vient d'être créée).
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
      await page.locator('#tab-task .subnav [data-kind="code"]').click();
      // Sur la carte, chaque dépôt porte sa frise entière sur sa ligne (« Replier les projets ») ; repliée, la carte
      // montre un aperçu d'une ligne par dépôt, qui s'efface quand les lignes se déplient.
      const carte = page.locator(`#taskList .task-row[data-task="${t.id}"]`);
      await carte.locator('.frise').first().waitFor({ state: 'attached' });
      assert.equal(await carte.locator('.targets .frise-cible').count(), 2, 'une frise par ligne de dépôt');
      assert.deepEqual(await carte.locator('.targets .frise-cible').nth(0).locator('.frise-phase .frise-nom').allTextContents(), ['Code & push', 'Validation', 'Validée']);
      assert.deepEqual(await carte.locator('.targets .frise-cible').nth(1).locator('.frise-etape .frise-nom').allTextContents(), ['Codage', 'Push', 'Validée']);
      assert.equal(await carte.locator('.targets .frise-groupe').count(), 0);
      assert.equal(await carte.locator(':scope > div > .frise .frise-groupe').count(), 0, 'plus de validation à part');
      const apercu = carte.locator(':scope > div > .frise .frise-apercu');
      await apercu.waitFor();
      assert.deepEqual(await apercu.locator('.frise-apercu-nom').allTextContents(), ['grp/paiement', 'grp/catalogue']);
      assert.equal(await apercu.locator('.frise-apercu-l').nth(0).locator('.frise-mini-p').count(), 3);
      await carte.locator('.targets-toggle').click();
      await apercu.waitFor({ state: 'hidden' });
      await carte.locator('.targets .frise-cible').first().waitFor();
      await app.api('DELETE', `/api/tasks/${t.id}`);
      assert.deepEqual(erreurs, []);
    });

    test('« Éditer » une session prête : la case « …puis converger » est là, se relit et s’enregistre', async () => {
      const t = (await app.api('POST', '/api/tasks', {
        kind: 'code', prompt: 'à éditer', label: 'Édition convergence', converge_after: true, targets: [{ repo_id: repoId, branch: 'ai/edit-conv' }],
      })).body;
      await page.locator('#tab-task .subnav [data-vue="cockpit"]').click();
      await page.locator(`#cockpitBox [data-cockpit-edit="${t.id}"]`).click();
      await page.waitForSelector('#taskModal:not([hidden])');
      const caseConv = page.locator('#taskConvergeRow [name="converge_after"]');
      await page.locator('#taskConvergeRow').waitFor();
      assert.equal(await caseConv.isChecked(), true, 'relue cochée');
      await page.locator('#taskConvergeRow').click();
      await page.locator('#taskSubmit').click();
      await attendreServeur(async () => app.db.prepare('SELECT converge_after FROM task WHERE id = ?').get(t.id).converge_after === 0, 'décochée, enregistrée');
      await page.waitForSelector('#taskModal', { state: 'hidden' });
      await app.api('DELETE', `/api/tasks/${t.id}`);
      assert.deepEqual(erreurs, []);
    });

    test('« Continuer » sur une chaîne arrêtée : la base réparée, le déroulé va au bout — validée', async () => {
      await page.locator('#tab-task .subnav [data-vue="cockpit"]').click();
      const ligne = page.locator('#cockpitBox [data-cockpit-sec="a_toi"] .cockpit-item.is-chaine').first();
      await ligne.waitFor();
      const id = Number(await ligne.getAttribute('data-cockpit-task'));
      // La base est réparée (le script repasse au vert) : « Continuer » fait repartir le déroulé.
      await page.locator(`#cockpitBox [data-frise-continuer="${id}"][data-action="chaine"]`).click();
      await attendreServeur(async () => {
        const l = Object.values((await app.api('GET', '/api/cockpit')).body).flat().find((x) => x && x.task_id === id);
        return l && l.workflow.etapes.at(-1).etat === 'fait';
      }, 'la chaîne va au bout', 60000);
      await page.locator(`#cockpitBox [data-cockpit-sec="termine"] .cockpit-item[data-cockpit-task="${id}"]`).waitFor();
      assert.equal(await page.locator(`#cockpitBox [data-frise-continuer="${id}"]`).count(), 0, 'plus rien à continuer');
      assert.deepEqual(erreurs, []);
    });

    test('« Lancer ma journée » : préparer, saisir le dépôt d’un ticket qui n’en nomme pas, enregistrer l’un, lancer l’autre — un par un', async () => {
      await page.locator('#cockpitJournee').click();
      await page.waitForSelector('#cockpitJourneeModal:not([hidden])');
      assert.equal(await page.locator('#cockpitPreparer').isDisabled(), true, 'rien à préparer sans ticket');
      assert.equal(await page.locator('#cockpitLancer').isHidden(), true, 'rien à lancer avant de préparer');
      await page.locator('#cockpitMesTickets').click();
      await page.locator('#cockpitTickets .cockpit-ticket-pick[value="PROJ-71"]').waitFor();
      await page.fill('#cockpitTicketsFiltre', 'fidélité');
      assert.equal(await page.locator('#cockpitTickets .cockpit-ticket:has([value="PROJ-71"])').isHidden(), true, 'le filtre cache');
      await page.fill('#cockpitTicketsFiltre', '');
      await page.locator('#cockpitTickets .cockpit-ticket-pick[value="PROJ-70"]').check();
      await page.locator('#cockpitTickets .cockpit-ticket-pick[value="PROJ-71"]').check();
      assert.match(await page.locator('#cockpitCout').textContent(), /2 .*Jira/);
      assert.notEqual(await page.locator('#cockpitModele').inputValue(), '', 'une session à chaîne est proposée');
      assert.equal(await page.locator(`#cockpitModele option[value="${modeleId}"]`).count(), 1);
      const avant = (await app.api('GET', '/api/tasks')).body.length;
      await page.locator('#cockpitPreparer').click();

      // PROJ-70 nomme son dépôt et sa branche ; PROJ-71 non : à saisir ici.
      const b70 = page.locator('#cockpitPrepares .cockpit-prep[data-key="PROJ-70"]');
      const b71 = page.locator('#cockpitPrepares .cockpit-prep[data-key="PROJ-71"]');
      await b71.locator('.cockpit-prep-manque').waitFor();
      assert.equal(await b70.locator('.cockpit-c-repo').inputValue(), String(repoId));
      assert.equal(await b70.locator('.cockpit-c-branch').inputValue(), 'ai/proj-70-remise');
      assert.equal((await app.api('GET', '/api/tasks')).body.length, avant, 'préparer ne crée rien');
      // Le ticket se lit dans son bloc : ouvert d'office quand il ne nomme aucun dépôt, replié sinon.
      assert.equal(await b71.locator('details.cockpit-ticket-voir').getAttribute('open'), '');
      assert.equal(await b70.locator('details.cockpit-ticket-voir').getAttribute('open'), null);
      assert.match(await b71.locator('.cockpit-ticket-corps').textContent(), /Rien ne nomme le dépôt ici[\s\S]*Léa[\s\S]*module paiement/);
      // Le dépôt cité : un clic remplit la ligne ; un second ne la double pas.
      await b71.locator(`[data-cockpit-suggere="${repoId}"]`).click();
      assert.equal(await b71.locator('.cockpit-c-repo').inputValue(), String(repoId));
      assert.equal(await b71.locator('[data-combo="cockpit-c-repo"]').inputValue(), 'grp/paiement');
      await b71.locator(`[data-cockpit-suggere="${repoId}"]`).click();
      assert.equal(await b71.locator('.cockpit-cible').count(), 1);
      // Le choix à la main reste possible : la liste des dépôts, avec recherche.
      await b71.locator('[data-combo="cockpit-c-repo"]').click();
      await b71.locator('[data-combo="cockpit-c-repo"]').fill('paie');
      await b71.locator(`.combo-opt[data-v="${repoId}"]`).click();
      assert.equal(await b71.locator('.cockpit-c-repo').inputValue(), String(repoId));
      await b71.locator('.cockpit-c-branch').fill('ai/proj-71-ecran');
      // Une branche de départ choisie se rend au défaut du dépôt (la forge de test ne liste aucune
      // branche : le choix précédent est posé tel que le combo le laisse).
      await b71.locator('.cockpit-c-base').evaluate((h) => { h.value = 'release/1.0'; h.dataset.label = 'release/1.0'; });
      await b71.locator('[data-combo="cockpit-c-base"]').click();
      const defaut = b71.locator('.combo:has([data-combo="cockpit-c-base"]) .combo-opt[data-v=""]');
      assert.match(await defaut.textContent(), /défaut du dépôt/);
      await defaut.click();
      assert.equal(await b71.locator('.cockpit-c-base').inputValue(), '', 'retour au défaut du dépôt');

      // Enregistrer PROJ-71 sans lancer : PROJ-70 garde ce qu'il montrait, rien d'autre ne part.
      await b71.locator('[data-cockpit-prep="enregistrer"]').click();
      await page.locator('#cockpitPrepares .cockpit-prep.is-fait[data-key="PROJ-71"]').waitFor();
      let t71;
      await attendreServeur(async () => {
        t71 = (await app.api('GET', '/api/tasks')).body.find((x) => x.jira_key === 'PROJ-71' && x.status === 'new');
        return !!t71;
      }, 'PROJ-71 enregistrée');
      assert.equal((await app.api('GET', `/api/tasks/${t71.id}`)).body.task.targets[0].branch, 'ai/proj-71-ecran');
      assert.ok(!(await app.api('GET', `/api/tasks/${t71.id}`)).body.task.targets[0].base_branch, 'aucune branche de départ imposée');
      assert.equal((await app.api('GET', '/api/tasks')).body.length, avant + 1, 'une seule session créée');
      assert.equal(await b70.locator('.cockpit-c-branch').inputValue(), 'ai/proj-70-remise', 'l’autre bloc n’a rien perdu');

      // Puis lancer PROJ-70, seul.
      await b70.locator('[data-cockpit-prep="lancer"]').click();
      await page.locator('#cockpitPrepares .cockpit-prep.is-fait[data-key="PROJ-70"]').waitFor();
      await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.length === avant + 2, 'PROJ-70 créée');
      assert.equal(((await app.api('GET', `/api/tasks/${t71.id}`)).body.task.status), 'new', 'PROJ-71 attend toujours');
      await page.locator('#cockpitAnnuler').click();

      // Dans le cockpit : « Prêt à lancer », Éditer ouvre la fenêtre de session.
      const ligne = () => page.locator(`#cockpitBox [data-cockpit-sec="pret"] [data-cockpit-task="${t71.id}"]`);
      await ligne().waitFor();
      await ligne().locator(`[data-cockpit-edit="${t71.id}"]`).click();
      await page.waitForSelector('#taskModal:not([hidden])');
      await page.waitForFunction(() => [...document.querySelectorAll('#targetRows .t-branch')].some((x) => x.value === 'ai/proj-71-ecran'));
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal', { state: 'hidden' });

      // Supprimer : la confirmation dit combien de sessions du ticket partent.
      const n = (await app.api('GET', '/api/tasks')).body.filter((x) => x.jira_key === 'PROJ-71').length;
      await ligne().locator(`[data-cockpit-del="${t71.id}"]`).click();
      await page.waitForSelector('#confirmModal:not([hidden])');
      assert.match(await page.locator('#confirmText').textContent(), new RegExp(`${n}.*PROJ-71|PROJ-71`));
      await page.locator('#confirmOk').click();
      await attendreServeur(async () => (await app.api('GET', `/api/tasks/${t71.id}`)).status === 400, 'supprimée');
      assert.equal((await app.api('GET', '/api/tasks')).body.filter((x) => x.jira_key === 'PROJ-71').length, 0);
      await ligne().waitFor({ state: 'detached' });
      await waitForJobs(app.api);
      assert.deepEqual(erreurs, []);
    });
  });
});
