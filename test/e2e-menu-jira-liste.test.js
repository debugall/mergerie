'use strict';
/* MENU « JIRA » → « MES TICKETS » — LA LISTE ET SES FILTRES, DANS UN NAVIGATEUR.
 *
 * Ce que la colonne de gauche montre et ce que chaque contrôle y change : l'état « Jira non
 * connecté » et son bouton vers les Réglages, la panne Jira et « Rafraîchir », la liste par
 * défaut (mes tickets, le premier ouvert d'office), la recherche (clé, titre, epic), « Inclure
 * les terminés », les filtres Assignés / Statuts / Sprints / Filtres par champ (cocher, chercher
 * sans décocher, tout cocher / tout décocher), et le pied de carte « ce qui est déjà engagé ».
 *
 * Le faux Jira est celui de `helpers/mock-gitlab` ; ce qu'on relit côté serveur, c'est la JQL
 * que l'application lui a RÉELLEMENT envoyée : les assignés, projets, sprints et statuts masqués
 * sont appliqués PAR Jira, pas par l'écran — un filtre qui ne changerait que l'affichage
 * passerait sinon pour bon.
 *
 * Déjà prouvés ailleurs, dans un navigateur : le détail d'un ticket (`e2e-menu-jira-detail`),
 * le sous-onglet « Surveillés » (`e2e-jira-watch-ui`, `e2e-menu-jira-surveilles`), « Enquêter »
 * (`e2e-jira-investigate`), masquer le menu (`e2e-nav-prefs`).
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

const MOI = { accountId: 'me-test', displayName: 'Testeur courant' };
const BOB = { accountId: 'bob-1', displayName: 'Bob Leclerc' };
const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
const sprint = (id, nom, state, startDate) => ({ id, name: nom, state, startDate });

describe('Menu Jira — Mes tickets : liste et filtres', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  /* La DERNIÈRE recherche de tickets envoyée à Jira (pas la découverte des assignés, qui
     passe par la même route). C'est elle qui dit ce que l'écran a demandé. */
  const recherches = () => app.state.calls
    .filter((c) => /^\/rest\/api\/3\/search/.test(c.path))
    .map((c) => new URL(c.path, 'http://x').searchParams.get('jql') || '')
    .filter((j) => !/IS NOT EMPTY/.test(j) && !/In Progress/.test(j) && !/^key IN/i.test(j));
  const derniereJql = () => recherches().at(-1) || '';
  const attendreJql = (pred, quoi) => attendreServeur(async () => pred(derniereJql()), quoi);

  const clesAffichees = () => page.$$eval('#jiraList .jira-item', (n) => n.map((x) => x.dataset.jira));
  const attendreCles = (attendu) => page.waitForFunction(
    (a) => JSON.stringify([...document.querySelectorAll('#jiraList .jira-item')].map((x) => x.dataset.jira).sort()) === JSON.stringify(a),
    [...attendu].sort(),
  );

  /* Onglet rouvert à neuf : préférences de filtres du navigateur effacées, puis un seul
     chargement — l'onglet mémorisé est oublié, sinon le rechargement rouvrirait Jira et le
     clic en lancerait un second en parallèle. */
  async function ouvrirJira({ attendreDetail = true } = {}) {
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('aidevtools_jira') || k === 'aidevtools_tab') localStorage.removeItem(k);
      }
    });
    await page.reload();
    await page.locator('nav button[data-tab="jira"]').click();
    if (attendreDetail) {
      await page.waitForSelector('#jiraList .jira-item');
      await page.waitForSelector('#jiraDetail .jira-detail-inner');
    }
  }
  const ouvrirMenu = async (id) => {
    await page.locator(`#${id} > summary`).click();
    await page.waitForFunction((i) => document.getElementById(i).open, id);
  };
  // Rouvre le menu s'il s'est refermé : garde-fou, la croix d'un critère le laisse ouvert.
  const menuOuvert = async (id) => {
    await page.waitForSelector(`#${id}:not([hidden])`);
    if (!(await page.evaluate((i) => document.getElementById(i).open, id))) await ouvrirMenu(id);
  };

  before(async () => {
    app = await startApp();
    app.state.jiraFields = [
      { id: 'summary', name: 'Résumé' },
      { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
    ];
    app.state.jiraProjectStatuses.PROJ = [{ id: '1', name: 'Tâche', statuses: [
      { name: 'À faire', statusCategory: { key: 'new' } },
      { name: 'En revue', statusCategory: { key: 'indeterminate' } },
      { name: 'Recette', statusCategory: { key: 'indeterminate' } },
    ] }];
    const ticket = (key, f) => { app.state.jiraIssues[key] = { key, fields: { issuetype: { name: 'Tâche' }, updated: '2026-09-10T10:00:00.000+0000', ...f } }; };
    ticket('PROJ-1', {
      summary: 'Corriger le calcul de la TVA', status: etat('À faire', 'new'), issuetype: { name: 'Bug' },
      priority: { name: 'High' }, assignee: MOI, project: { key: 'PROJ', name: 'Boutique' }, labels: ['facturation'],
      parent: { key: 'PROJ-100', fields: { summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
      customfield_10020: [sprint(11, 'Sprint 11', 'active', '2026-09-01T00:00:00.000Z')],
    });
    ticket('PROJ-2', {
      summary: 'Ajouter l’export CSV', status: etat('En revue', 'indeterminate'), priority: { name: 'Medium' },
      assignee: MOI, project: { key: 'PROJ', name: 'Boutique' },
      customfield_10020: [sprint(10, 'Sprint 10', 'closed', '2026-08-15T00:00:00.000Z')],
    });
    ticket('OPS-3', {
      summary: 'Renouveler le certificat', status: etat('À faire', 'new'), assignee: MOI, project: { key: 'OPS', name: 'Exploitation' },
    });
    ticket('PROJ-4', {
      summary: 'Revoir le cache des prix', status: etat('À faire', 'new'), assignee: BOB, project: { key: 'PROJ', name: 'Boutique' },
    });
    // Sans Jira d'abord : c'est l'état « non connecté » qui s'éprouve en premier.
    await app.configure({ jira_watch_minutes: '0' });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('Jira non connecté : un état vide qui mène aux réglages Jira', async () => {
    await ouvrirJira({ attendreDetail: false });
    await page.waitForSelector('#jiraList [data-empty-act="go-jira-config"]');
    assert.match(await page.locator('#jiraList').innerText(), /Connecte Jira/);
    assert.equal(await page.locator('#jiraAssigneeFilter').isHidden(), true, 'aucun filtre sans connexion');
    await page.locator('#jiraList [data-empty-act="go-jira-config"]').click();
    await page.locator('#sub-jiracfg').waitFor({ state: 'visible' });
    assert.equal(await page.locator('nav button[data-tab="admin"]').getAttribute('class').then((c) => /active/.test(c)), true,
      'le bouton ouvre les Réglages…');
    assert.equal(await page.locator('#sub-jiracfg [name="jira_url"]').isVisible(), true, '…sur la connexion Jira');

    // Connexion posée pour la suite du fichier.
    const r = await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    assert.equal(r.status, 200);
  });

  test('une panne Jira s’affiche avec son message, et « Rafraîchir » relance', async () => {
    app.state.jiraFail = { status: 503, body: { errorMessages: ['Maintenance planifiée de Jira'] } };
    await ouvrirJira({ attendreDetail: false });
    await page.waitForFunction(() => /Maintenance planifiée/.test(document.querySelector('#jiraError').textContent));
    assert.equal(await page.locator('#jiraList .jira-item').count(), 0);

    app.state.jiraFail = null;
    await page.locator('#jiraRefresh').click();
    await page.waitForSelector('#jiraList .jira-item');
    await page.waitForFunction(() => document.querySelector('#jiraError').textContent.trim() === '');
  });

  /* Le champ « sprint » et les statuts du workflow sont cherchés une fois puis MÉMORISÉS côté
     serveur — y compris quand la recherche a échoué. Une panne passagère au premier chargement
     de l'onglet fige donc « pas de champ sprint » et « aucun statut de workflow » jusqu'au
     prochain enregistrement des réglages ou redémarrage : le filtre Sprints disparaît alors
     que Jira répond de nouveau. */
  test('après une panne passagère, le filtre Sprints revient au rafraîchissement', async () => {
    try {
      await ouvrirJira();
      await page.locator('#jiraRefresh').click();
      await page.waitForSelector('#jiraList .jira-item');
      await page.waitForSelector('#jiraSprintFilter:not([hidden])', { timeout: 5000 });
    } finally {
      // Réenregistrer la configuration vide les deux caches : la suite du fichier en dépend.
      await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    }
  });

  test('par défaut : mes tickets non terminés, le premier ouvert à droite', async () => {
    await ouvrirJira();
    await attendreCles(['PROJ-1', 'PROJ-2', 'OPS-3']);
    const jql = derniereJql();
    assert.match(jql, /assignee IN \("me-test"\)/, 'moi seul, par défaut');
    assert.match(jql, /statusCategory != Done/, 'les terminés sont écartés par Jira');
    assert.ok(!(await clesAffichees()).includes('PROJ-4'), 'le ticket de Bob n’est pas dans « mes tickets »');
    assert.match(await page.locator('#jiraInfo').textContent(), /3 tickets/);

    // Le premier ticket est ouvert d'office, et sa carte se distingue.
    const premier = (await clesAffichees())[0];
    await page.waitForFunction((k) => document.querySelector('#jiraDetail .jira-key-copy')?.textContent === k, premier);
    assert.deepEqual(await page.$$eval('#jiraList .jira-item.active', (n) => n.map((x) => x.dataset.jira)), [premier]);

    // L'epic se lit sur la carte, sans ouvrir le ticket.
    assert.match(await page.locator('#jiraList [data-jira="PROJ-1"] .jira-item-epic').innerText(), /PROJ-100\s+Facturation 2026/);
  });

  test('cliquer un ticket l’ouvre à droite et le marque dans la liste', async () => {
    await ouvrirJira();
    await page.locator('#jiraList [data-jira="OPS-3"]').click();
    await page.waitForFunction(() => /Renouveler le certificat/.test(document.querySelector('#jiraDetail .jira-title')?.textContent || ''));
    await page.waitForFunction(() => document.querySelector('#jiraList .jira-item.active')?.dataset.jira === 'OPS-3');
  });

  test('la recherche filtre par clé, titre et epic — sans rappeler Jira', async () => {
    await ouvrirJira();
    const avant = recherches().length;
    await page.locator('#jiraSearch').fill('tva');
    await attendreCles(['PROJ-1']);
    assert.match(await page.locator('#jiraInfo').textContent(), /1 ticket/);
    await page.locator('#jiraSearch').fill('ops-3');
    await attendreCles(['OPS-3']);
    await page.locator('#jiraSearch').fill('facturation 2026');
    await attendreCles(['PROJ-1']);
    await page.locator('#jiraSearch').fill('introuvable');
    await page.waitForFunction(() => /Aucun ticket ne correspond/.test(document.querySelector('#jiraList').textContent));
    await page.locator('#jiraSearch').fill('');
    await attendreCles(['PROJ-1', 'PROJ-2', 'OPS-3']);
    assert.equal(recherches().length, avant, 'chercher dans la liste ne coûte aucun appel Jira');
  });

  test('« Inclure les terminés » change la requête et se retient au rechargement', async () => {
    await ouvrirJira();
    await page.locator('#jiraIncludeDone').click();
    await attendreJql((j) => !/statusCategory != Done/.test(j), 'la requête inclut les terminés');
    assert.equal(await page.evaluate(() => localStorage.getItem('aidevtools_jira_done')), '1');

    await page.reload();
    await page.waitForSelector('#jiraList .jira-item');
    assert.equal(await page.locator('#jiraIncludeDone').isChecked(), true, 'le choix survit au rechargement');
    await page.locator('#jiraIncludeDone').click();
    await attendreJql((j) => /statusCategory != Done/.test(j), 'les terminés sont de nouveau écartés');
  });

  test('Assignés : cocher Bob ajoute ses tickets, la recherche masque sans décocher, tout / rien', async () => {
    await ouvrirJira();
    await page.waitForSelector('#jiraAssigneeFilter:not([hidden])');
    await ouvrirMenu('jiraAssigneeFilter');
    const lignes = await page.locator('#jiraAssigneeFilterBody .jira-sf-item').allInnerTexts();
    assert.match(lignes[0], /Testeur courant.*moi/, '« moi » en tête, et nommé comme tel');
    assert.ok(lignes.some((l) => /Bob Leclerc/.test(l)));
    assert.equal(await page.locator('#jiraAssigneeFilterBody input[value="me-test"]').isChecked(), true);
    assert.equal(await page.locator('#jiraAssigneeFilterBody input[value="bob-1"]').isChecked(), false);
    assert.equal((await page.locator('#jiraAssigneeFilterCount').textContent()).trim(), '1/2');

    // Chercher une personne masque les autres lignes… sans rien décocher.
    await page.locator('#jiraAssigneeSearch').fill('bob');
    await page.waitForFunction(() => document.querySelector('#jiraAssigneeFilterBody input[value="me-test"]').closest('label').hidden);
    assert.equal(await page.locator('#jiraAssigneeFilterBody input[value="me-test"]').isChecked(), true,
      'masquer une ligne ne la décoche pas');

    await page.locator('#jiraAssigneeFilterBody input[value="bob-1"]').click();
    await attendreJql((j) => /assignee IN \("me-test", "bob-1"\)|assignee IN \("bob-1", "me-test"\)/.test(j), 'les deux assignés partent dans la JQL');
    await attendreCles(['PROJ-1', 'PROJ-2', 'OPS-3', 'PROJ-4']);
    assert.equal((await page.locator('#jiraAssigneeFilterCount').textContent()).trim(), '2/2');
    await page.locator('#jiraAssigneeSearch').fill('');

    // Tout décocher = aucune contrainte d'assigné (et non « moi » en douce).
    await page.locator('[data-jsfnone="assignee"]').click();
    await attendreJql((j) => !/assignee IN/.test(j), 'plus aucune clause d’assigné');
    assert.equal(await page.locator('#jiraAssigneeFilterBody input:checked').count(), 0);
    // Tout cocher : chacun des deux.
    await page.locator('[data-jsfall="assignee"]').click();
    await attendreJql((j) => /assignee IN \(.*me-test.*\)/.test(j) && /bob-1/.test(j), 'tout le monde est coché');
    assert.equal(await page.locator('#jiraAssigneeFilterBody input:checked').count(), 2);
  });

  test('Statuts : décocher masque et exclut côté Jira ; un statut du workflow sans ticket est proposé', async () => {
    await ouvrirJira();
    await page.waitForSelector('#jiraStatusFilter:not([hidden])');
    // « Recette » ne porte aucun ticket : il vient du workflow du projet.
    await page.waitForSelector('#jiraStatusFilterBody input[value="Recette"]', { state: 'attached' });
    await ouvrirMenu('jiraStatusFilter');
    assert.equal((await page.locator('#jiraStatusFilterCount').textContent()).trim(), '3/3');

    await page.locator('#jiraStatusFilterBody input[value="En revue"]').click();
    await attendreCles(['PROJ-1', 'OPS-3']);
    await attendreJql((j) => /status NOT IN \("En revue"\)/.test(j), 'le statut décoché est exclu par Jira');
    assert.equal((await page.locator('#jiraStatusFilterCount').textContent()).trim(), '2/3');

    // La recherche de statut masque sans décocher.
    await page.locator('#jiraStatusSearch').fill('recet');
    await page.waitForFunction(() => document.querySelector('#jiraStatusFilterBody input[value="À faire"]').closest('label').hidden);
    assert.equal(await page.locator('#jiraStatusFilterBody input[value="À faire"]').isChecked(), true);
    await page.locator('#jiraStatusSearch').fill('');

    await page.locator('[data-jsfnone="status"]').click();
    await page.waitForFunction(() => /Aucun ticket ne correspond/.test(document.querySelector('#jiraList').textContent));
    assert.equal(await page.locator('#jiraStatusFilterBody input:checked').count(), 0);

    await page.locator('[data-jsfall="status"]').click();
    await attendreCles(['PROJ-1', 'PROJ-2', 'OPS-3']);
    await attendreJql((j) => !/status NOT IN/.test(j), 'plus aucun statut exclu');
  });

  test('Sprints : le sprint en cours en tête, choisir un sprint le demande à Jira', async () => {
    await ouvrirJira();
    await page.waitForSelector('#jiraSprintFilter:not([hidden])');
    await ouvrirMenu('jiraSprintFilter');
    const lignes = await page.locator('#jiraSprintFilterBody .jira-sf-item').allInnerTexts();
    assert.match(lignes[0], /Sprint 11\s+en cours/, 'le sprint actif d’abord');
    assert.match(lignes[1], /Sprint 10/);

    await page.locator('#jiraSprintFilterBody input[value="10"]').click();
    await attendreJql((j) => /sprint IN \(10\)/.test(j), 'le sprint part dans la JQL');
    await attendreCles(['PROJ-2']);
    // Le sprint 11 reste proposé : sans cela, impossible d'en cocher un second.
    await page.waitForSelector('#jiraSprintFilterBody input[value="11"]', { state: 'attached' });
    assert.match(await page.locator('#jiraSprintFilterCount').textContent(), /1\/2/);

    await page.locator('#jiraSprintSearch').fill('11');
    await page.waitForFunction(() => document.querySelector('#jiraSprintFilterBody input[value="10"]').closest('label').hidden);
    assert.equal(await page.locator('#jiraSprintFilterBody input[value="10"]').isChecked(), true, 'masqué, pas décoché');
    await page.locator('#jiraSprintSearch').fill('');

    await page.locator('[data-jsfnone="sprint"]').click();
    await attendreJql((j) => !/sprint IN/.test(j), 'plus de contrainte de sprint');
    await attendreCles(['PROJ-1', 'PROJ-2', 'OPS-3']);
  });

  test('Filtres par champ : choisir le champ, cocher une valeur, chercher, retirer', async () => {
    await ouvrirJira();
    await page.waitForSelector('#jiraFieldFilter:not([hidden])');
    await ouvrirMenu('jiraFieldFilter');
    const choisirChamp = async (cle) => {
      await page.locator('#jiraFieldFilterPick .cb-search').click();
      await page.locator(`#jiraFieldFilterPick .combo-opt[data-v="${cle}"]`).click();
      await page.waitForSelector(`#jiraFieldFilterBody [data-ffcrit="${cle}"]`);
    };
    await choisirChamp('type');
    assert.equal(await clesAffichees().then((c) => c.length), 3, 'un critère sans valeur cochée ne filtre rien');
    await page.locator('#jiraFieldFilterBody input[data-ffval="type"][value="Bug"]').click();
    await attendreCles(['PROJ-1']);
    assert.match(await page.locator('#jiraFieldFilterCount').textContent(), /1 valeur/);

    await page.locator('#jiraFieldFilterBody [data-ffsearch="type"]').fill('tâc');
    await page.waitForFunction(() => document.querySelector('#jiraFieldFilterBody input[value="Bug"]').closest('label').hidden);
    assert.equal(await page.locator('#jiraFieldFilterBody input[value="Bug"]').isChecked(), true, 'masqué, pas décoché');

    await page.locator('#jiraFieldFilterBody [data-ffdel="type"]').click();
    await attendreCles(['PROJ-1', 'PROJ-2', 'OPS-3']);
    assert.equal(await page.locator('#jiraFieldFilterBody [data-ffcrit]').count(), 0);

    // Le projet, lui, est appliqué PAR Jira.
    await menuOuvert('jiraFieldFilter');
    await choisirChamp('project');
    await page.locator('#jiraFieldFilterBody input[data-ffval="project"][value="OPS"]').click();
    await attendreJql((j) => /project IN \("OPS"\)/.test(j), 'le projet part dans la JQL');
    await attendreCles(['OPS-3']);
    await menuOuvert('jiraFieldFilter');
    await page.locator('#jiraFieldFilterBody [data-ffdel="project"]').click();
    await attendreJql((j) => !/project IN/.test(j), 'plus de contrainte de projet');
    await attendreCles(['PROJ-1', 'PROJ-2', 'OPS-3']);
  });

  /* La croix d'un critère est DANS le menu : cliquer dessus n'est pas « cliquer ailleurs ».
     Or le critère est redessiné avant que l'écouteur global ne voie le clic — la cible n'est
     plus dans le document, `details.contains(cible)` est faux, et le menu se ferme : retirer
     deux critères oblige à rouvrir le menu entre les deux. */
  test('retirer un critère laisse le menu des filtres ouvert', async () => {
    await ouvrirJira();
    await ouvrirMenu('jiraFieldFilter');
    await page.locator('#jiraFieldFilterPick .cb-search').click();
    await page.locator('#jiraFieldFilterPick .combo-opt[data-v="type"]').click();
    await page.waitForSelector('#jiraFieldFilterBody [data-ffcrit="type"]');
    await page.locator('#jiraFieldFilterBody [data-ffdel="type"]').click();
    await page.waitForFunction(() => !document.querySelector('#jiraFieldFilterBody [data-ffcrit]'));
    assert.equal(await page.evaluate(() => document.getElementById('jiraFieldFilter').open), true,
      'le menu reste ouvert : on n’a pas cliqué ailleurs');
  });

  test('un menu de filtre ouvert se referme au clic ailleurs', async () => {
    await ouvrirJira();
    await page.waitForSelector('#jiraStatusFilter:not([hidden])');
    await ouvrirMenu('jiraStatusFilter');
    await page.locator('#jiraInfo').click();
    await page.waitForFunction(() => !document.getElementById('jiraStatusFilter').open);
  });

  test('le pied de carte dit ce qui est déjà engagé côté code', async () => {
    const repoId = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' })).body.id;
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Écrire l’export', targets: [{ repo_id: repoId, branch: 'feature/PROJ-2-export', base_branch: 'main' }],
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    await ouvrirJira();
    await page.waitForFunction(() => {
      const e = document.querySelector('#jiraList [data-eng-key="PROJ-2"]');
      return e && !e.hidden && /1 session/.test(e.textContent);
    });
    assert.equal(await page.locator('#jiraList [data-eng-key="OPS-3"]').isHidden(), true,
      'un ticket sans engagement n’affiche rien');
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
