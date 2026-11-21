'use strict';
/* MENU JIRA → PLANS — ordonnancer un lot de tickets, à l'écran.
 *
 * Le trajet : une epic charge ses tickets (un filtre masque sans décocher), une clé s'ajoute à la
 * main, le budget de la préparation est dit avant ; « Préparer le prompt » lit Jira en UNE recherche
 * et montre le texte, qu'on retouche — et c'est CE texte qui part (prouvé sur la session créée) ;
 * l'IA pose ses questions, on y répond sur l'écran du plan, elle reprend ; l'ordre arrive avec le
 * libellé et l'état VENUS DE JIRA, un ticket à créer à sa place ; publier montre le texte exact et
 * le publie tel quel, republier met à jour le MÊME commentaire ; un suivi fait une v2, la v1 se
 * relit sans se publier ; repréparer un prompt retouché demande confirmation ; l'export sort en
 * Markdown, Word et PDF. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const MOI = { accountId: 'me-test', displayName: 'Testeur courant' };
const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
const adf = (texte) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: texte }] }] });

describe('Menu Jira — Plans : ordonnancer un lot de tickets', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let idRepo;
  const erreurs = [];
  const appels = (motif, methode = null) => app.state.calls.filter((c) => motif.test(c.path) && (!methode || c.method === methode));
  const planDb = () => app.db.prepare('SELECT * FROM jira_plan ORDER BY id DESC LIMIT 1').get();
  const vue = async () => (await app.api('GET', `/api/jira/plans/${planDb().id}`)).body;
  const attendrePlan = (cond, quoi, ms = 90000) => attendreServeur(async () => cond(await vue()), quoi, ms);

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'planui-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } }];
    const commun = { assignee: MOI, project: { key: 'PROJ', name: 'Boutique' }, updated: '2026-09-10T10:00:00.000+0000', issuetype: { name: 'Story' } };
    const epic = { key: 'PROJ-200', fields: { summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
    app.state.jiraIssues['PROJ-200'] = { key: 'PROJ-200', fields: { ...commun, status: etat('À faire', 'new'), summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
    app.state.jiraIssues['PROJ-20'] = { key: 'PROJ-20', fields: { ...commun, status: etat('En cours', 'indeterminate'), summary: 'Paiement en trois fois', parent: epic, description: adf('Le client peut payer en trois fois.') }, comments: [] };
    app.state.jiraIssues['PROJ-21'] = { key: 'PROJ-21', fields: { ...commun, status: etat('À faire', 'new'), summary: 'Avoir sur facture', parent: epic, description: adf('Émettre un avoir.') }, comments: [] };
    app.state.jiraIssues['PROJ-23'] = { key: 'PROJ-23', fields: { ...commun, status: etat('Livré', 'done'), summary: 'Grille tarifaire', parent: epic, description: adf('Livrée en septembre.') }, comments: [] };
    app.state.jiraIssues['PROJ-22'] = { key: 'PROJ-22', fields: { ...commun, status: etat('À faire', 'new'), summary: 'Export comptable', description: adf('Exporter les écritures.') }, comments: [] };
    app.state.confluencePages['4242'] = { title: 'Règles TVA', storage: '<p>Le taux <strong>réduit</strong>.</p>' };
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    idRepo = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    // Un dépôt classé AVANT lui (« aaa/… ») : une fois « grp/app » coché, il doit passer derrière.
    const autre = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'planui-autre-')));
    await app.api('POST', '/api/repos', { url: autre.url, project: 'aaa/outils' });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    // Le presse-papiers d'un navigateur sans tête refuse l'écriture : on retient ce qui y part.
    await page.evaluate(() => {
      window.__copie = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (x) => { window.__copie.push(x); } } });
    });
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('une epic charge ses tickets, une clé s’ajoute, le filtre masque sans décocher, le budget est dit', async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="jira"]').click();
    await page.locator('#tab-jira .subnav [data-jsub="plan"]').click();
    await page.waitForSelector('#jiraSubPlan:not([hidden]) #jiraPlanMain .empty-state, #jiraSubPlan:not([hidden]) #jiraPlanMain .empty');
    await page.locator('#jiraPlanNew').click();
    await page.waitForSelector('#jiraPlanForm');
    await page.locator('#jiraPlanLabel').fill('Facturation T4');
    await page.locator('#jiraPlanEpic').fill('PROJ-200');
    await page.locator('[data-plan-epic-load]').click();
    await page.waitForSelector('[data-plan-ticket="PROJ-21"]');
    assert.equal(await page.locator('[data-plan-ticket]:checked').count(), 3, 'les enfants de l’epic, cochés — le terminé aussi');
    await page.locator('#jiraPlanKeys').fill('proj-22');
    await page.locator('[data-plan-keys-add]').click();
    await page.waitForSelector('[data-plan-ticket="PROJ-22"]:checked');

    await page.locator('[data-plan-filtre-tickets]').fill('avoir');
    assert.equal(await page.locator('#jiraPlanTickets .jira-plan-ticket:visible').count(), 1);
    await page.locator('[data-plan-filtre-tickets]').fill('');
    assert.equal(await page.locator('[data-plan-ticket]:checked').count(), 4, 'masquer n’a rien décoché');

    assert.match(await page.locator('#jiraPlanBudget').textContent(), /1 appel\(s\) Jira, 0 page\(s\)/);
    await page.locator('#jiraPlanComments').check();
    await page.waitForFunction(() => /5 appel\(s\) Jira/.test(document.querySelector('#jiraPlanBudget').textContent));
    await page.locator('#jiraPlanComments').uncheck();
    await page.waitForFunction(() => /1 appel\(s\) Jira/.test(document.querySelector('#jiraPlanBudget').textContent));

    await page.locator('#jiraPlanPageUrl').fill(`${app.gitlabUrl}/wiki/spaces/DEV/pages/4242/Regles-TVA`);
    await page.locator('[data-plan-page-add]').click();
    await page.waitForSelector('#jiraPlanForm .jira-spec-url');
    await page.locator(`[data-plan-repo="${idRepo}"]`).check();
    await page.locator('#jiraPlanComplement').fill('Le service billing porte la TVA.');
    const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-')), 'contrat.md');
    fs.writeFileSync(fichier, '# Contrat\nLes avoirs passent par billing.\n');
    await page.locator('[data-plan-files]').setInputFiles(fichier);
    await page.waitForFunction(() => /contrat\.md/.test(document.querySelector('#jiraPlanForm').textContent));
  });

  test('« Préparer le prompt » lit Jira en une recherche et montre le texte composé', async () => {
    const avant = appels(/\/rest\/api\/3\/search/).length;
    await page.locator('#jiraPlanPrepare').click();
    await page.waitForSelector('#jiraPlanPrompt');
    // Préparer mène à l'onglet du prompt : le formulaire s'efface, le texte est en haut, sans défiler.
    assert.equal(await page.locator('[data-plan-step="prompt"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#jiraPlanForm').isVisible(), false);
    assert.ok((await page.locator('#jiraPlanPrompt').boundingBox()).y < 400, 'le prompt est en haut de l’écran');
    const prompt = await page.locator('#jiraPlanPrompt').inputValue();
    assert.match(prompt, /PROJ-20 — Paiement en trois fois/);
    assert.match(prompt, /PROJ-22 — Export comptable/);
    assert.match(prompt, /Règles TVA/, 'la page Confluence est dans le prompt');
    assert.match(prompt, /Le service billing porte la TVA\./, 'le complément aussi');
    assert.match(prompt, /<<<ORDRE [0-9a-f]+/, 'le format de réponse, au nonce du plan');
    assert.match(prompt, /<<<FONCTIONNEL [0-9a-f]+/, 'la spécification fonctionnelle est demandée');
    assert.match(prompt, /Déjà TERMINÉS : PROJ-23\./, 'le terminé est dit à l’IA');
    assert.match(prompt, /Déjà EN COURS : PROJ-20\./, 'l’en-cours aussi');
    assert.equal(appels(/\/rest\/api\/3\/search/).length - avant, 1, 'une seule recherche pour les quatre tickets');
    assert.equal(appels(/\/rest\/api\/3\/issue\/PROJ-2\d\/comment/).length, 0, 'pas de commentaires : la case est décochée');
    const p = planDb();
    assert.deepEqual(JSON.parse(p.ticket_keys_json), ['PROJ-20', 'PROJ-21', 'PROJ-23', 'PROJ-22']);
    assert.equal(p.prompt_edited, 0);
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM piece_jointe WHERE scope = 'plan' AND owner_id = ?").get(p.id).c, 1, 'la pièce est rangée sur le plan');
  });

  test('le prompt retouché est CELUI qui part ; l’IA pose ses questions, on répond sur le plan, elle reprend', async () => {
    const champ = page.locator('#jiraPlanPrompt');
    await champ.fill(`${await champ.inputValue()}\n\nCONSIGNE-RETOUCHEE-42`);
    await page.locator('[data-plan-run]').click();
    await attendreServeur(async () => { const p = planDb(); return p.task_id && p.prompt_edited === 1; }, 'la session est créée avec le prompt retouché');
    const tache = app.db.prepare('SELECT * FROM task WHERE id = ?').get(planDb().task_id);
    assert.match(tache.prompt, /CONSIGNE-RETOUCHEE-42/, 'la session reçoit le texte de l’écran, tel quel');
    assert.equal(tache.kind, 'explore');
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM piece_jointe WHERE scope = 'task' AND owner_id = ?").get(tache.id).c, 1, 'la pièce suit dans la session');

    // Questions (dry-run, première passe) : le formulaire s'affiche SUR le plan.
    await page.waitForSelector('#jiraPlanResult .questions-box [data-qsubmit]', { timeout: 90000 });
    for (const item of await page.locator('#jiraPlanResult .q-item').all()) {
      if (await item.locator('.q-free').count()) await item.locator('.q-free').fill('Oui, billing.');
      else await item.locator('input[type="radio"]').first().check();
    }
    await page.locator('#jiraPlanResult [data-qsubmit]').click();
    await attendrePlan((v) => v.status === 'done' && v.version === 1, 'le plan est produit après les réponses');
    await page.waitForSelector('#jiraPlanResult .jira-plan-order tbody tr', { timeout: 30000 });
  });

  test('l’ordre : numéro, libellé et état venus de Jira, le ticket à créer à sa place, rien d’oublié', async () => {
    const lignes = page.locator('#jiraPlanResult .jira-plan-order tbody tr');
    assert.equal(await lignes.count(), 4, 'trois tickets et un ticket à créer');
    assert.match(await lignes.nth(0).innerText(), /^1\s+PROJ-22\s*↗?\s+Export comptable\s+À faire/);
    assert.match(await lignes.nth(1).innerText(), /NOUVEAU-1[\s\S]*à créer/);
    assert.match(await lignes.nth(3).innerText(), /PROJ-20[\s\S]*Paiement en trois fois[\s\S]*En cours/);
    assert.equal(await page.locator('#jiraPlanResult .jira-spec-hint.is-warn').count(), 0, 'aucun ticket non placé');
    assert.equal(await page.locator('#jiraPlanResult [data-plan-order="PROJ-23"]').count(), 0, 'le terminé n’est pas dans l’ordre');
    assert.match(await page.locator('#jiraPlanResult .jira-plan-done').textContent(), /Déjà terminés, hors de l’ordre : PROJ-23 \(Livré\)/);
    // La spécification fonctionnelle, rendue, sous l'ordre.
    assert.match(await page.locator('#jiraPlanResult .jira-plan-fonctionnel').innerText(), /Règles de gestion[\s\S]*RG-1/);
    // Le ticket à créer se copie.
    await page.locator('#jiraPlanResult [data-plan-copy="NOUVEAU-1"]').click();
    await page.waitForFunction(() => (window.__copie || []).some((x) => /Préparer la migration du schéma/.test(x)));
  });

  test('publier : le texte exact, publié tel quel ; republier met à jour le même commentaire', async () => {
    await page.locator('#jiraPlanResult [data-plan-post="PROJ-20"]').click();
    await page.waitForSelector('#jiraPlanPostModal:not([hidden])');
    const texte = await page.locator('#jiraPlanPostText').textContent();
    assert.match(texte, /Complément de plan — Mergerie — Facturation T4 · v1 · plan [0-9a-z]{6}/, 'la ligne repère');
    assert.match(texte, /À préciser pour PROJ-20/);
    await page.locator('#jiraPlanPostOk').click();
    await page.waitForSelector('#jiraPlanPostModal', { state: 'hidden' });
    await attendreServeur(async () => appels(/\/rest\/api\/3\/issue\/PROJ-20\/comment$/, 'POST').length === 1, 'le commentaire est publié');
    const corps = JSON.stringify(appels(/\/rest\/api\/3\/issue\/PROJ-20\/comment$/, 'POST')[0].body);
    assert.match(corps, /À préciser pour PROJ-20/, 'le texte de l’aperçu, tel quel');
    await page.waitForFunction(() => /publié \(v1\)/.test(document.querySelector('#jiraPlanResult [data-plan-compl="PROJ-20"]').textContent));

    await page.locator('#jiraPlanResult [data-plan-post="PROJ-20"]').click();
    await page.waitForSelector('#jiraPlanPostModal:not([hidden])');
    assert.match(await page.locator('#jiraPlanPostNote').textContent(), /remplacera le commentaire déjà publié/);
    await page.locator('#jiraPlanPostOk').click();
    await attendreServeur(async () => appels(/\/rest\/api\/3\/issue\/PROJ-20\/comment\/\d+$/, 'PUT').length === 1, 'le commentaire est mis à jour');
    /* La réponse REDESSINE le résultat (la modale se ferme dans le même tour) : on l'attend, sinon le
       test suivant taperait son suivi dans un champ que ce rendu remplace. */
    await page.waitForSelector('#jiraPlanPostModal', { state: 'hidden' });
    assert.equal(appels(/\/rest\/api\/3\/issue\/PROJ-20\/comment$/, 'POST').length, 1, 'aucun second commentaire');
  });

  test('un suivi fait une v2 ; la v1 se relit, sans se publier', async () => {
    await page.locator('#jiraPlanFollowup').fill('Place PROJ-20 en premier.');
    await page.locator('#jiraPlanResult [data-plan-followup]').click();
    await attendrePlan((v) => v.status === 'done' && v.version === 2, 'la v2 est produite');
    await page.waitForSelector('#jiraPlanVersion');
    const v2 = app.db.prepare('SELECT * FROM jira_plan_version WHERE plan_id = ? AND version = 2').get(planDb().id);
    assert.equal(v2.origin, 'followup');
    assert.equal(v2.instruction, 'Place PROJ-20 en premier.');
    await page.locator('#jiraPlanVersion').selectOption('1');
    await page.waitForFunction(() => /version 1/.test(document.querySelector('#jiraPlanResult').textContent));
    assert.equal(await page.locator('#jiraPlanResult [data-plan-post]').count(), 0, 'une version passée ne se publie pas');
    await page.locator('#jiraPlanVersion').selectOption('2');
    await page.waitForSelector('#jiraPlanResult [data-plan-post="PROJ-20"]');
    assert.equal(await page.locator('[data-plan-step="result"]').getAttribute('aria-selected'), 'true', 'lancer mène au résultat');
  });

  test('rouvrir un plan analysé montre son résultat d’emblée ; les onglets ramènent aux entrées et au prompt', async () => {
    // Le panneau d'avant était déjà sur le résultat : on attend la vue RELUE du serveur, puis l'ordre affiché en haut.
    await Promise.all([
      page.waitForResponse((r) => new RegExp(`/api/jira/plans/${planDb().id}$`).test(r.url()) && r.request().method() === 'GET'),
      page.locator(`[data-plan-open="${planDb().id}"]`).click(),
    ]);
    await page.waitForFunction(() => {
      const ordre = document.querySelector('#jiraPlanResult .jira-plan-order');
      const r = ordre && ordre.getBoundingClientRect();
      return document.querySelector('[data-plan-step="result"]')?.getAttribute('aria-selected') === 'true' && r && r.height > 0 && r.top < 500;
    }, null, { timeout: 15000 });
    assert.equal(await page.locator('#jiraPlanForm').isVisible(), false);
    assert.equal(await page.locator('#jiraPlanPrompt').isVisible(), false);
    await page.locator('[data-plan-step="inputs"]').click();
    await page.waitForSelector('#jiraPlanForm', { state: 'visible' });
    assert.equal(await page.locator('#jiraPlanLabel').inputValue(), 'Facturation T4');
    assert.deepEqual(await page.locator('#jiraPlanRepos .jira-spec-repo').evaluateAll((l) => l.map((x) => x.textContent.trim().split(/\s+/)[0])),
      ['grp/app', 'aaa/outils'], 'le dépôt coché est en tête, devant celui que l’ordre alphabétique plaçait avant');
    await page.locator('[data-plan-step="prompt"]').click();
    await page.waitForSelector('#jiraPlanPrompt', { state: 'visible' });
    assert.match(await page.locator('#jiraPlanPrompt').inputValue(), /CONSIGNE-RETOUCHEE-42/);
    await page.locator('[data-plan-step="result"]').click();
    await page.waitForSelector('#jiraPlanResult [data-plan-refresh]', { state: 'visible' });
  });

  test('relire Jira et Confluence : rien n’a changé, pas d’IA ; un ticket livré, une description et une page revues font une v3', async () => {
    const relire = async () => {
      const [rep] = await Promise.all([
        page.waitForResponse((r) => /\/api\/jira\/plans\/\d+\/refresh$/.test(r.url()) && r.request().method() === 'POST'),
        page.locator('#jiraPlanResult [data-plan-refresh]').click(),
      ]);
      return rep.json();
    };
    assert.match(await page.locator('#jiraPlanResult [data-plan-refresh]').textContent(), /Relire Jira et Confluence/, 'le plan a une page');
    const recherches = appels(/\/rest\/api\/3\/search/).length;
    const lectures = appels(/\/wiki\/api\/v2\/pages\/4242/).length;
    const rien = await relire();
    assert.deepEqual(rien.changes, [], 'Jira n’a pas bougé');
    assert.equal(appels(/\/rest\/api\/3\/search/).length - recherches, 1, 'une recherche, pas de commentaires');
    assert.equal(appels(/\/wiki\/api\/v2\/pages\/4242/).length - lectures, 1, 'la page est relue');
    assert.equal((await vue()).version, 2, 'aucune version, aucune passe de l’IA');

    app.state.jiraIssues['PROJ-21'].fields.status = etat('Livré', 'done');
    app.state.jiraIssues['PROJ-22'].fields.description = adf('Exporter les écritures au format FEC.');
    app.state.confluencePages['4242'] = { title: 'Règles TVA', storage: '<p>Le taux <strong>intermédiaire</strong> s’applique aussi.</p>' };
    const maj = await relire();
    assert.deepEqual(maj.changes.map((c) => `${c.key}:${c.kind}`).sort(), ['PROJ-21:status', 'PROJ-22:content', 'Règles TVA:page-content']);
    await attendrePlan((v) => v.status === 'done' && v.version === 3, 'la v3 est produite');
    const v3 = app.db.prepare('SELECT * FROM jira_plan_version WHERE plan_id = ? AND version = 3').get(planDb().id);
    assert.equal(v3.origin, 'jira');
    assert.match(v3.instruction, /PROJ-21 : état « À faire » → « Livré »/);
    const suivi = app.db.prepare("SELECT prompt FROM agent_pass WHERE scope = 'task' AND task_id = ? ORDER BY id DESC LIMIT 1").get(planDb().task_id).prompt;
    assert.match(suivi, /format FEC/, 'l’IA lit le ticket tel qu’il est maintenant');
    assert.match(suivi, /taux \*\*intermédiaire\*\*/, 'et la page telle qu’elle est maintenant');
    assert.match(suivi, /Déjà TERMINÉS : PROJ-21, PROJ-23\./);
    // L'ordre suit : le ticket livré en sort, les changements sont dits, le prompt de lancement est périmé.
    await page.waitForSelector('#jiraPlanResult .jira-plan-changes');
    assert.equal(await page.locator('#jiraPlanResult [data-plan-order="PROJ-21"]').count(), 0);
    assert.match(await page.locator('#jiraPlanResult .jira-plan-done').textContent(), /PROJ-21 \(Livré\)/);
    assert.match(await page.locator('#jiraPlanResult .jira-plan-changes').textContent(), /PROJ-22 : description ou commentaires modifiés/);
    assert.ok((await vue()).prompt_stale, 'le prompt de lancement ne reflète plus Jira');
  });

  test('repréparer un prompt retouché demande confirmation ; refuser le garde', async () => {
    await page.locator('[data-plan-step="inputs"]').click();
    await page.locator('#jiraPlanPrepare').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.match(planDb().prompt, /CONSIGNE-RETOUCHEE-42/, 'la retouche est intacte');
    assert.equal(planDb().prompt_edited, 1);
  });

  test('exporter : Markdown et Word se téléchargent, le PDF passe par l’impression', async () => {
    await page.locator('[data-plan-step="result"]').click();
    const [md] = await Promise.all([page.waitForEvent('download'), page.locator('[data-plan-export="md"]').click()]);
    /* SANS LOCALE UTF-8 (un conteneur `node:22` nu, la recette de rejeu de la CI), Chromium ne sait pas
       écrire un nom non ASCII — « — » ici, un accent ailleurs — et le remplace par « download » : c'est
       l'environnement, pas l'export (vérifié : même page, `LANG=C.UTF-8`, le nom est le bon). */
    if (md.suggestedFilename() !== 'download') assert.equal(md.suggestedFilename(), 'Plan — Facturation T4.md');
    const cheminMd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'p.md');
    await md.saveAs(cheminMd);
    const contenu = fs.readFileSync(cheminMd, 'utf8');
    assert.match(contenu, /^# Plan — Facturation T4/);
    assert.match(contenu, /\| # \| Ticket \| Libellé \| État \| Pourquoi à cette place \|/);
    assert.match(contenu, /Export comptable/);
    assert.match(contenu, /## Spécification fonctionnelle\n\n### Objectif et périmètre/, 'la spécification part avec l’export');
    const [docx] = await Promise.all([page.waitForEvent('download'), page.locator('[data-plan-export="docx"]').click()]);
    // Même réserve de locale pour le nom ; le contenu, lui, se vérifie partout : un .docx est un ZIP.
    if (docx.suggestedFilename() !== 'download') assert.match(docx.suggestedFilename(), /\.docx$/);
    const cheminDocx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'p.docx');
    await docx.saveAs(cheminDocx);
    assert.equal(fs.readFileSync(cheminDocx).subarray(0, 2).toString(), 'PK');
    await page.locator('[data-plan-export="pdf"]').click();
    await page.waitForFunction(() => {
      const f = document.querySelector('iframe[aria-hidden="true"]');
      return !!(f && f.contentDocument && /Ordre de réalisation/.test(f.contentDocument.body ? f.contentDocument.body.innerHTML : ''));
    });
    assert.equal(erreurs.length, 0, `aucune erreur JS : ${erreurs.join(' | ')}`);
  });
});
