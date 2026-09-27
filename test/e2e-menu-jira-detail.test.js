'use strict';
/* MENU « JIRA » → « MES TICKETS » — LE TICKET OUVERT (`#jiraDetail`), BOUTON PAR BOUTON.
 *
 * Ce que le panneau de droite rend (en-tête, puces, métadonnées, epic, description, pièces
 * jointes, tickets liés, commentaires) et ce que chaque commande y déclenche : copier la clé,
 * l'aperçu d'une image et le téléchargement d'un fichier, poster un commentaire (vide refusé,
 * brouillon qui survit au rechargement, Ctrl+Entrée), changer l'état (confirmation, annulation,
 * pastille du menu), « Surveiller », « Ajouter aux todos », « Faire coder l'IA » (modale remplie,
 * captures du ticket proposées, dépôt retenu par projet Jira), et la section « Dans Mergerie »
 * (merge requests, sessions, notes qui citent le ticket, « Vérifier ensemble »).
 *
 * Chaque écriture est relue là où elle atterrit : dans le faux Jira (`app.state.calls`,
 * `app.state.jiraIssues`) ou dans l'API de Mergerie.
 *
 * Déjà prouvés ailleurs, dans un navigateur : le rendu des tableaux et blocs de code d'une
 * description et les tickets liés côté « Surveillés » (`e2e-jira-watch-ui`), « Enquêter »
 * (`e2e-jira-investigate`), « Récupérer » un ticket dans la modale de session
 * (`e2e-menu-devia-modale`).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

const MOI = { accountId: 'me-test', displayName: 'Testeur courant' };
const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
const adf = (texte) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: texte }] }] });

describe('Menu Jira — le ticket ouvert', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];
  const ids = {};

  const appelsJira = (motif, methode = null) => app.state.calls
    .filter((c) => motif.test(c.path) && (!methode || c.method === methode));

  async function ouvrirJira() {
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('aidevtools_jira') || k === 'aidevtools_tab') localStorage.removeItem(k);
    });
    await page.reload();
    await page.locator('nav button[data-tab="jira"]').click();
    await page.waitForSelector('#jiraList .jira-item');
    await page.waitForSelector('#jiraDetail .jira-detail-inner');
  }
  // Ouvre un ticket par sa carte : n'est prêt que quand SON titre est affiché.
  async function ouvrirTicket(cle, titre) {
    await page.locator(`#jiraList [data-jira="${cle}"]`).click();
    await page.waitForFunction(([k, t]) => document.querySelector('#jiraDetail .jira-key-copy')?.textContent === k
      && (document.querySelector('#jiraDetail .jira-title')?.textContent || '').includes(t), [cle, titre]);
  }
  const TITRE = 'Refondre le tunnel de paiement';

  before(async () => {
    app = await startApp();
    const commun = { assignee: MOI, project: { key: 'PROJ', name: 'Boutique' }, updated: '2026-09-10T10:00:00.000+0000' };
    app.state.jiraIssues['PROJ-10'] = {
      key: 'PROJ-10',
      fields: {
        ...commun,
        summary: TITRE, status: etat('À faire', 'new'), issuetype: { name: 'Story' }, priority: { name: 'Highest' },
        reporter: { accountId: 'claire', displayName: 'Claire Martin' },
        created: '2026-09-01T08:00:00.000+0000', duedate: '2026-10-15',
        labels: ['paiement', 'front'], components: [{ name: 'Checkout' }], fixVersions: [{ name: '2.4.0' }],
        parent: { key: 'PROJ-100', fields: { summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
        description: adf('Le tunnel doit tenir en trois étapes.'),
        attachment: [
          { id: '501', filename: 'maquette.png', mimeType: 'image/png', size: 2048 },
          { id: '502', filename: 'journal.txt', mimeType: 'text/plain', size: 12 },
        ],
        issuelinks: [
          { id: '1', type: { name: 'Blocks', inward: 'est bloqué par', outward: 'bloque' },
            inwardIssue: { key: 'PROJ-11', fields: { summary: 'Mettre à jour le SDK de paiement', status: etat('À faire', 'new'), issuetype: { name: 'Tâche' } } } },
          { id: '2', type: { name: 'Relates', inward: 'est lié à', outward: 'est lié à' },
            outwardIssue: { key: 'GONE-1', fields: { summary: 'Ticket supprimé depuis', status: etat('À faire', 'new'), issuetype: { name: 'Tâche' } } } },
        ],
      },
      comments: [{ author: { displayName: 'Claire Martin' }, created: '2026-09-02T09:00:00.000+0000', body: adf('Je relis la maquette demain.') }],
    };
    app.state.jiraIssues['PROJ-11'] = {
      key: 'PROJ-11',
      fields: { ...commun, summary: 'Mettre à jour le SDK de paiement', status: etat('À faire', 'new'), issuetype: { name: 'Tâche' } },
    };
    /* Deux merge requests portant la clé, dans deux dépôts : l'une par sa branche, l'autre par
       son titre — c'est ce qui fait apparaître « Vérifier ensemble ». */
    const mr = (iid, titre, branche) => ({
      iid, title: titre, state: 'opened', source_branch: branche, target_branch: 'main',
      web_url: `https://gitlab.test/mr/${iid}`, sha: 'a'.repeat(40), created_at: '2026-09-05T10:00:00.000Z',
      author: { name: 'Alice' }, diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40) },
    });
    app.state.mrs['grp/app'] = [mr(31, 'Tunnel en trois étapes', 'feature/PROJ-10-tunnel')];
    app.state.mrs['grp/api'] = [mr(32, 'PROJ-10 : SDK de paiement', 'feat/sdk')];
    app.state.changes['grp/app!31'] = [{ new_path: 'src/app.js' }];
    app.state.changes['grp/api!32'] = [{ new_path: 'src/api.js' }];

    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    ids.repoApp = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' })).body.id;
    ids.repoApi = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/api', project: 'grp/api' })).body.id;
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) ids[m.iid] = m.id;
    ids.page = (await app.api('POST', '/api/notes', { title: 'Réunion paiement', content: 'On attend PROJ-10 avant la mise en production.' })).body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(String(t)); }, readText: async () => window.__copies.at(-1) || '' },
      });
    });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('l’en-tête, les puces et les métadonnées du ticket', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    const d = page.locator('#jiraDetail');
    assert.match(await d.locator('.jira-dhead .jira-status').textContent(), /À faire/);
    const puces = await d.locator('.jira-chips .jira-chip').allInnerTexts();
    assert.deepEqual(puces.map((p) => p.replace(/\s+/g, ' ')), ['Story', 'Priorité : Highest', 'Assigné à : Testeur courant']);
    const meta = (await d.locator('.jira-meta').innerText()).replace(/\s+/g, ' ');
    for (const attendu of ['Claire Martin', 'PROJ — Boutique', 'paiement', 'front', 'Checkout', '2.4.0', 'Facturation 2026']) {
      assert.ok(meta.includes(attendu), `« ${attendu} » dans les détails : ${meta}`);
    }
    assert.match(await d.locator('.jira-epic-link').getAttribute('href'), /\/browse\/PROJ-100$/, 'l’epic mène à Jira');
    assert.match(await d.locator('a.jira-open').getAttribute('href'), /\/browse\/PROJ-10$/);
    assert.match(await d.locator('.jira-card.md-body').first().innerText(), /trois étapes/);
  });

  test('copier la clé d’un clic', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.locator('#jiraDetail .jira-key-copy').click();
    await page.waitForFunction(() => window.__copies.at(-1) === 'PROJ-10');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Copié : PROJ-10/.test(t.textContent)));
  });

  test('pièces jointes : une image s’agrandit, un fichier se télécharge par le proxy', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    assert.match(await page.locator('#jiraDetail .jira-section h4', { hasText: 'pièces jointes' }).textContent(), /2 pièces jointes/);

    await page.locator('#jiraDetail .jira-img[data-jname="maquette.png"]').click();
    await page.locator('#jiraLightbox').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#jiraLightboxName').textContent(), 'maquette.png');
    assert.equal(await page.locator('#jiraLightboxOpen').getAttribute('href'), '/api/jira/attachment/501');
    // Clic sur le fond : l'aperçu se ferme.
    await page.locator('#jiraLightbox').click({ position: { x: 5, y: 5 } });
    await page.locator('#jiraLightbox').waitFor({ state: 'hidden' });

    const fichier = page.locator('#jiraDetail a.jira-attach', { hasText: 'journal.txt' });
    assert.equal(await fichier.getAttribute('download'), 'journal.txt');
    const href = await fichier.getAttribute('href');
    const rep = await page.evaluate(async (u) => {
      const r = await fetch(u);
      return { texte: await r.text(), dispo: r.headers.get('content-disposition') };
    }, href);
    assert.equal(rep.texte, 'contenu-502', 'le contenu vient de Jira, par le serveur');
    assert.match(rep.dispo, /^attachment/, 'un fichier non image se télécharge, il ne s’affiche pas');
  });

  test('un ticket lié s’ouvre dans la même colonne ; un ticket introuvable le dit', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    const groupes = await page.locator('#jiraDetail .jira-rel-rel').allTextContents();
    assert.deepEqual(groupes.map((g) => g.trim()), ['est bloqué par', 'est lié à']);
    await page.locator('#jiraDetail .jira-rel-key', { hasText: 'PROJ-11' }).click();
    await page.waitForFunction(() => /SDK de paiement/.test(document.querySelector('#jiraDetail .jira-title')?.textContent || ''));
    assert.equal(await page.locator('#jiraSubMine').isVisible(), true, 'on reste dans « Mes tickets »');

    await ouvrirTicket('PROJ-10', TITRE);
    await page.locator('#jiraDetail .jira-rel-key', { hasText: 'GONE-1' }).click();
    await page.waitForFunction(() => /Jira 404/.test(document.querySelector("#jiraDetail").textContent) && !document.querySelector("#jiraDetail .jira-detail-inner"));
  });

  test('les commentaires : lus, vide refusé, posté jusqu’à Jira', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    const c = page.locator('#jiraDetail .jira-comment').first();
    assert.equal((await c.locator('.jira-avatar').textContent()).trim(), 'CM', 'les initiales de l’auteur');
    assert.match(await c.innerText(), /Claire Martin[\s\S]*Je relis la maquette demain/);

    const postes = () => appelsJira(/\/issue\/PROJ-10\/comment/, 'POST').length;
    const avant = postes();
    await page.locator('#jiraDetail .jira-comment-form button[type="submit"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast.err')].some((t) => /commentaire est vide/.test(t.textContent)));
    assert.equal(postes(), avant, 'rien ne part pour un commentaire vide');

    await page.locator('#jiraDetail .jira-comment-input').fill('Déployé en recette.');
    await page.locator('#jiraDetail .jira-comment-form button[type="submit"]').click();
    await attendreServeur(async () => postes() === avant + 1, 'le commentaire arrive dans Jira');
    const envoye = JSON.stringify(appelsJira(/\/issue\/PROJ-10\/comment/, 'POST').at(-1).body);
    assert.match(envoye, /"type":"doc"/, 'converti en ADF, le format que Jira exige');
    assert.match(envoye, /Déployé en recette\./);
    await page.waitForFunction(() => /2 commentaires/.test(document.querySelector('#jiraDetail').textContent));
    assert.match(await page.locator('#jiraDetail').innerText(), /Nouveau commentaire/, 'le commentaire rendu par Jira s’ajoute au fil');
  });

  test('le brouillon de commentaire survit au rechargement, Ctrl+Entrée l’envoie puis l’efface', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.locator('#jiraDetail .jira-comment-input').fill('Brouillon à ne pas perdre');
    await page.waitForFunction(() => localStorage.getItem('aidevtools_brouillon_jira:PROJ-10') === 'Brouillon à ne pas perdre');

    await page.reload();
    await page.waitForSelector('#jiraList .jira-item');
    await ouvrirTicket('PROJ-10', TITRE);
    assert.equal(await page.locator('#jiraDetail .jira-comment-input').inputValue(), 'Brouillon à ne pas perdre');

    const avant = appelsJira(/\/issue\/PROJ-10\/comment/, 'POST').length;
    await page.locator('#jiraDetail .jira-comment-input').press('ControlOrMeta+Enter');
    await attendreServeur(async () => appelsJira(/\/issue\/PROJ-10\/comment/, 'POST').length === avant + 1, 'Ctrl+Entrée envoie');
    assert.match(JSON.stringify(appelsJira(/\/issue\/PROJ-10\/comment/, 'POST').at(-1).body), /Brouillon à ne pas perdre/);
    await page.waitForFunction(() => localStorage.getItem('aidevtools_brouillon_jira:PROJ-10') === null);
  });

  test('changer l’état : confirmé, appliqué dans Jira, et la pastille du menu suit', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    const transitions = () => appelsJira(/\/issue\/PROJ-10\/transitions/, 'POST').length;
    const avant = transitions();
    assert.equal(await page.locator('#navCountJira').isHidden(), true, 'aucun ticket en cours au départ');

    // Annuler : rien ne part, et le sélecteur revient à son invite.
    await page.locator('#jiraDetail select.jira-transition').selectOption('21');
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    assert.match(await page.locator('#confirmTitle').textContent(), /PROJ-10/);
    assert.match(await page.locator('#confirmText').textContent(), /« En cours »/, 'la confirmation nomme l’état visé');
    await page.locator('#confirmCancel').click();
    await page.locator('#confirmModal').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#jiraDetail select.jira-transition').inputValue(), '');
    assert.equal(transitions(), avant, 'annuler n’écrit rien chez Jira');

    await page.locator('#jiraDetail select.jira-transition').selectOption('21');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => app.state.jiraIssues['PROJ-10'].fields.status.name === 'En cours', 'Jira a changé l’état');
    await page.waitForFunction(() => /En cours/.test(document.querySelector('#jiraDetail .jira-dhead .jira-status')?.textContent || ''));
    await page.waitForFunction(() => /En cours/.test(document.querySelector('#jiraList [data-jira="PROJ-10"] .jira-status')?.textContent || ''));
    await page.waitForFunction(() => { const b = document.querySelector('#navCountJira'); return b && !b.hidden && b.textContent === '1'; });

    app.state.jiraIssues['PROJ-10'].fields.status = etat('À faire', 'new');
  });

  test('« Surveiller » depuis le ticket, puis ne plus surveiller', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    const suivis = async () => (await app.api('GET', '/api/jira/watch')).body.watched.map((w) => w.key);
    await page.locator('#jiraDetail [data-jirawatch="PROJ-10"]').click();
    await attendreServeur(async () => (await suivis()).includes('PROJ-10'), 'le ticket est surveillé');
    await page.waitForFunction(() => document.querySelector('#jiraDetail [data-jirawatch="PROJ-10"]')?.classList.contains('active'));
    assert.match(await page.locator('#jiraDetail [data-jirawatch="PROJ-10"]').textContent(), /Surveillé/);
    await page.waitForFunction(() => document.querySelector('#jiraWatchCount')?.textContent === '1');

    await page.locator('#jiraDetail [data-jirawatch="PROJ-10"]').click();
    await attendreServeur(async () => !(await suivis()).includes('PROJ-10'), 'le ticket n’est plus surveillé');
    await page.waitForFunction(() => !document.querySelector('#jiraDetail [data-jirawatch="PROJ-10"]')?.classList.contains('active'));
  });

  test('« Ajouter aux todos » reprend le titre, la priorité et l’échéance du ticket', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.locator('#jiraDetail [data-add-todo="ticket"]').click();
    await page.locator('#captureModal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#captureTitle').inputValue(), `Suivre PROJ-10 — ${TITRE}`);
    assert.equal(await page.locator('#capturePriority').inputValue(), 'high', '« Highest » devient une todo haute');
    assert.match(await page.locator('#captureDue').inputValue(), /^2026-10-15T09:00/, 'l’échéance du ticket, à 9 h');
    await page.locator('#captureOk').click();
    await page.locator('#captureModal').waitFor({ state: 'hidden' });

    let todo;
    await attendreServeur(async () => {
      todo = (await app.api('GET', '/api/todos')).body.todos.find((x) => x.link_kind === 'ticket' && x.link_ref === 'PROJ-10');
      return !!todo;
    }, 'la todo liée au ticket existe');
    assert.equal(todo.priority, 'high');
    assert.ok(todo.due_at, 'avec son échéance');
    // Le bouton bascule : un second clic ne créerait pas de doublon.
    await page.waitForSelector('#jiraDetail [data-see-todo]');
  });

  test('« Faire coder l’IA » prépare la session depuis le ticket, et retient le dépôt', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.locator('#jiraDetail [data-jiracode="PROJ-10"]').click();
    await page.locator('#taskModal').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /PROJ-10/.test(document.querySelector('#taskPrompt').value));
    assert.equal(await page.locator('#taskModalTitle').textContent(), 'Faire coder l\'IA — PROJ-10');
    const prompt = await page.locator('#taskPrompt').inputValue();
    assert.match(prompt, /Contexte du ticket Jira PROJ-10/);
    assert.match(prompt, /trois étapes/, 'la description part avec la demande');
    assert.equal(await page.locator('#taskForm [name="commit_message"]').inputValue(), `PROJ-10 ${TITRE}`);
    assert.match(await page.locator('#targetRows .target-row .t-branch').first().inputValue(), /^feature\/PROJ-10-refondre/);
    assert.equal(await page.locator('#taskJiraKey').inputValue(), 'PROJ-10', 'la clé est reprise dans le champ Jira');

    // Choisir le dépôt, créer sans lancer.
    await page.locator('#targetRows .target-row .t-repo-search').first().click();
    await page.locator('#targetRows .combo-options:not([hidden]) .combo-opt[data-r]', { hasText: 'grp/app' }).first().click();
    await page.waitForFunction(() => document.querySelector('#targetRows .t-repo-search').value === 'grp/app');
    const max = () => app.db.prepare('SELECT MAX(id) m FROM task').get().m || 0;
    const avant = max();
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => max() > avant, 'la session est créée');
    ids.tache = max();
    const { body } = await app.api('GET', `/api/tasks/${ids.tache}`);
    assert.equal(body.task.status, 'new', 'préparée, pas lancée');
    assert.match(body.task.prompt, /Contexte du ticket Jira PROJ-10/);
    assert.match(body.task.targets[0].branch, /^feature\/PROJ-10-/);
    assert.equal(body.task.targets[0].repo_id, ids.repoApp);

    // Le dépôt choisi pour un ticket PROJ est proposé au suivant du même projet.
    await ouvrirTicket('PROJ-11', 'SDK de paiement');
    await page.locator('#jiraDetail [data-jiracode="PROJ-11"]').click();
    await page.locator('#taskModal').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /PROJ-11/.test(document.querySelector('#taskModalTitle').textContent)
      && document.querySelector('#targetRows .t-repo-search')?.value === 'grp/app');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  });

  /* B10 — les captures d'un ticket proposées en cases à cocher dans la modale. L'écran lit
     `attachments` dans la réponse de POST /api/jira/fetch ; la route les recopie depuis
     `jira.fetchIssue`… qui ne demande à Jira que `summary,description` et ne renvoie aucune
     pièce jointe. Hors mode démo, la liste est donc toujours vide. */
  test('« Faire coder l’IA » propose les captures du ticket', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.locator('#jiraDetail [data-jiracode="PROJ-10"]').click();
    await page.locator('#taskModal').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /PROJ-10/.test(document.querySelector('#taskPrompt').value));
    try {
      assert.equal(await page.locator('#taskJiraPieces').isVisible(), true, 'l’image du ticket est proposée');
      assert.deepEqual(await page.locator('#taskJiraPieces .jira-piece').allInnerTexts().then((l) => l.map((x) => x.trim())), ['maquette.png']);
      assert.equal(await page.locator('#taskJiraPieces [data-jira-piece="0"]').isChecked(), true, 'cochée d’office');
    } finally {
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    }
  });

  test('« Dans Mergerie » : merge requests, session et note qui citent le ticket', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.waitForSelector('#jiraMergerie:not([hidden]) [data-jira-mr]');
    const box = page.locator('#jiraMergerie');
    const mrs = await box.locator('[data-jira-mr]').allInnerTexts();
    assert.equal(mrs.length, 2, mrs.join(' | '));
    assert.ok(mrs.some((m) => /!31/.test(m)) && mrs.some((m) => /!32/.test(m)));
    if (ids.tache) assert.equal(await box.locator(`[data-jira-task="${ids.tache}"]`).count(), 1, 'la session née du ticket');
    assert.match(await box.locator(`[data-cite-page="${ids.page}"]`).textContent(), /Réunion paiement/);
    assert.match(await box.locator('[data-jira-lot]').textContent(), /Vérifier les 2 merge requests ensemble/);
    assert.equal(await page.locator('#jiraDetail').innerText().then((t) => /!31/.test(t)), true);

    // La note s'ouvre là où elle vit.
    await box.locator(`[data-cite-page="${ids.page}"]`).click();
    await page.waitForFunction(() => document.querySelector('#pageTitle')?.value === 'Réunion paiement');
    assert.equal(await page.locator('#tab-notes').isVisible(), true);

    // La merge request ouvre son rapport dans Reviews.
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.locator(`#jiraMergerie [data-jira-mr="${ids[31]}"]`).click();
    await page.locator('#tab-review').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /!31/.test(document.querySelector('#reportDetail')?.textContent || ''));

    // La session mène à Dev IA.
    if (ids.tache) {
      await ouvrirJira();
      await ouvrirTicket('PROJ-10', TITRE);
      await page.locator(`#jiraMergerie [data-jira-task="${ids.tache}"]`).click();
      await page.locator('#tab-task').waitFor({ state: 'visible' });
    }
  });

  test('« Vérifier ensemble » crée le lot nommé par la clé', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.waitForSelector('#jiraMergerie [data-jira-lot]');
    await page.locator('#jiraMergerie [data-jira-lot]').click();
    let lot;
    await attendreServeur(async () => {
      lot = (await app.api('GET', '/api/lots')).body.find((l) => l.name === 'PROJ-10');
      return !!lot;
    }, 'le lot existe');
    const membres = (lot.members || lot.mrs || []).map((m) => (typeof m === 'object' ? m.ref_id : m)).sort();
    assert.deepEqual(membres, [ids[31], ids[32]].sort());
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Lot « PROJ-10 » créé/.test(t.textContent)));
    // Aucun vérificateur ne couvre ces dépôts : l'écran le dit au lieu de ne rien faire.
    await page.waitForFunction(() => [...document.querySelectorAll('.toast.err')].some((t) => /Aucun vérificateur/.test(t.textContent)));
  });

  /* « J'ai poussé, voici la MR » : le composer du commentaire propose d'insérer la référence
     et le lien des merge requests qui portent la clé. L'écran lit `issue.mergerie.mrs`… que
     la route du détail ne renvoie jamais : les boutons n'apparaissent sur aucun ticket. */
  test('le composer propose d’insérer le lien des merge requests du ticket', async () => {
    await ouvrirJira();
    await ouvrirTicket('PROJ-10', TITRE);
    await page.waitForSelector('#jiraMergerie:not([hidden]) [data-jira-mr]');   // les MR sont bien connues
    await page.waitForSelector('#jiraDetail [data-jira-insert]', { timeout: 5000 });
    await page.locator('#jiraDetail .jira-comment-input').fill('Parti en recette, voir');
    await page.locator('#jiraDetail [data-jira-insert]', { hasText: '!31' }).click();
    assert.match(await page.locator('#jiraDetail .jira-comment-input').inputValue(), /^Parti en recette, voir !31 https:\/\/gitlab\.test\/mr\/31$/);
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
