'use strict';
/* LE COCKPIT ET « LANCER MA JOURNÉE » (agent-autonome, étape 4).
 *
 *   1. « Lancer ma journée » crée et lance une session par ticket : ses dépôts et sa branche viennent des
 *      jetons du ticket, sa demande de ses lignes `&&>`, sa chaîne de validation de la session modèle ;
 *      un ticket qui ne nomme aucun dépôt revient avec sa raison ; un appel Jira par ticket ;
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
  const ticket = (key, summary, lignes, { assignee = 'me-test' } = {}) => {
    app.state.jiraIssues[key] = {
      key,
      fields: {
        summary, status: { name: 'À faire', statusCategory: { key: 'new' } }, issuetype: { name: 'Story' },
        assignee: assignee ? { accountId: assignee, displayName: 'Moi' } : null,
        description: { type: 'doc', version: 1, content: lignes.map((l) => ({ type: 'paragraph', content: [texte(l)] })) },
        comment: { comments: [] },
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
    ticket('PROJ-71', 'Sans dépôt', ['Rien ne nomme le dépôt ici.']);
    ticket('PROJ-72', 'Pas à moi', ['&&paiement'], { assignee: 'quelqu-un' });
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
    const st = (await app.api('GET', '/api/status')).body;
    assert.equal(st.tasksAToi, d.a_toi.length, 'la pastille du menu compte les lignes « à toi »');
    fs.writeFileSync(path.join(bin, 'v.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
      assert.equal(await page.locator('#cockpitBox [data-cockpit-sec="a_toi"] .task-chaine').count() > 0, true, 'la chaîne, comme sur la carte');
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

    test('« Lancer ma journée » : mes tickets cochés, le modèle, le coût annoncé, et le ticket sans dépôt à ouvrir à la main', async () => {
      await page.locator('#cockpitJournee').click();
      await page.waitForSelector('#cockpitJourneeModal:not([hidden])');
      assert.equal(await page.locator('#cockpitLancer').isDisabled(), true, 'rien à lancer sans ticket');
      await page.locator('#cockpitMesTickets').click();
      await page.locator('#cockpitTickets .cockpit-ticket-pick[value="PROJ-71"]').waitFor();
      await page.fill('#cockpitTicketsFiltre', 'fidélité');
      assert.equal(await page.locator('#cockpitTickets .cockpit-ticket:has([value="PROJ-71"])').isHidden(), true, 'le filtre cache');
      await page.fill('#cockpitTicketsFiltre', '');
      await page.locator('#cockpitTickets .cockpit-ticket-pick[value="PROJ-70"]').check();
      await page.locator('#cockpitTickets .cockpit-ticket-pick[value="PROJ-71"]').check();
      assert.match(await page.locator('#cockpitCout').textContent(), /2 .*Jira/);
      // La plus récente session qui a une chaîne (celles de la journée l'ont reprise) est proposée.
      assert.notEqual(await page.locator('#cockpitModele').inputValue(), '', 'une session à chaîne est proposée');
      assert.equal(await page.locator(`#cockpitModele option[value="${modeleId}"]`).count(), 1);
      const avant = (await app.api('GET', '/api/tasks')).body.length;
      await page.locator('#cockpitLancer').click();
      await page.locator('#cockpitResultat:not([hidden]) [data-cockpit-manuel="PROJ-71"]').waitFor();
      await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.length === avant + 1, 'une session créée');
      await page.locator('#cockpitResultat [data-cockpit-manuel="PROJ-71"]').click();
      await page.waitForSelector('#taskModal:not([hidden])');
      assert.match(await page.locator('#taskModalTitle').textContent(), /PROJ-71/, 'la fenêtre de session, préparée depuis le ticket');
      await page.locator('#taskCancel').click();
      await waitForJobs(app.api);
      assert.deepEqual(erreurs, []);
    });
  });
});
