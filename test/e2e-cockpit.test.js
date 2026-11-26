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
