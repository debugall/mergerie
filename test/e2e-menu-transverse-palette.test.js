'use strict';
/* TRANSVERSE — LA PALETTE DE COMMANDES (Ctrl/Cmd + K), DEPUIS L'ÉCRAN.
 *
 * Déjà éprouvés ailleurs, et donc pas rejoués ici : « !217 » tapé seul (e2e-ameliorations),
 * l'ancrage sous le champ de l'en-tête, les flèches sur un lien et la touche « o »
 * (e2e-links-ui), un menu masqué qui quitte la palette (e2e-nav-prefs), et côté API seulement
 * le `nav` d'un vérificateur, d'un job Jenkins et d'une commande git (e2e-liens-4e-passe).
 *
 * Ce fichier pilote le reste AU NAVIGATEUR :
 *   - le raccourci lui-même : Ctrl+K ouvre, referme, et fonctionne le curseur dans un champ ;
 *     le libellé du déclencheur suit la plateforme ;
 *   - la palette à vide : trois sections titrées, qui disparaissent dès qu'on tape ; « Rien ne
 *     correspond » ; les flèches ; Échap et le clic au fond ;
 *   - CHAQUE entrée d'action (aller à un onglet, un stade, un sous-onglet ; chercher les MR,
 *     tout reviewer, nouvelle session, nouvelle todo, nouvelle page, journal, raccourcis) —
 *     on vérifie l'EFFET, pas la fermeture de la palette ;
 *   - CHAQUE geste d'un résultat : une merge request (rapport + adresse), ⌘/Ctrl+Entrée (le
 *     diff), un ticket surveillé tapé seul, une page de notes, une todo, une session de codage
 *     et une exploration (la bonne saveur), un vérificateur (sa modale, présélectionné), un job
 *     Jenkins (sa fiche), une commande git (le champ rempli), un agent (la modale, l'agent posé).
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, afficherMenusOptionnels,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const seed = require('./helpers/stats-seed');
const mockJenkins = require('./helpers/mock-jenkins');

const { dispo } = navigateurDispo();

const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('Transverse — la palette de commandes', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let jenkins; let navigateur; let page; let repo; let repoId;
  const ids = {};
  const erreurs = [];

  before(async () => {
    app = await startApp();
    jenkins = await mockJenkins.start();
    mockJenkins.reset();
    mockJenkins.state.jobs = [{ name: 'app', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
      { name: 'deploy', color: 'blue', buildable: true },
    ] }];
    mockJenkins.state.details['/job/app/job/deploy'] = {
      name: 'deploy', color: 'blue', buildable: true, description: 'Déploie la boutique.', property: [],
      builds: [{ number: 3, result: 'SUCCESS', building: false, timestamp: 900, duration: 1000, url: '', actions: [] }],
    };

    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    const mr = (iid, titre) => ({
      iid, title: titre, state: 'opened', source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`, sha: repo.branchSha,
      author: { name: 'Alice' }, diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    });
    app.state.mrs['grp/app'] = [mr(41, 'Ajoute la remise fidélité')];
    app.state.changes['grp/app!41'] = [{ new_path: 'src/app.js' }];
    app.state.jiraIssues['PROJ-77'] = { key: 'PROJ-77', fields: { summary: 'Ticket surveillé de la palette', status: { name: 'À faire' } } };

    await app.configure({
      jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0',
      jenkins_url: jenkins.url, jenkins_user: mockJenkins.state.user, jenkins_token: mockJenkins.state.token,
      jenkins_refresh_minutes: '0',
    });
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/discover');
    await waitForJobs(app.api);
    ids.mr41 = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 41).id;

    // Une merge request DÉJÀ reviewée, rapport sur disque : ce que la palette doit ouvrir.
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'rapports-'));
    ids.mrRevue = seed.insererMr(app.db, repoId, 77, { titre: 'Refonte palette des remises', statut: 'reviewed' });
    seed.insererReview(app.db, dir, ids.mrRevue, 0.8);

    ids.page = (await app.api('POST', '/api/notes', { title: 'Compte rendu zanzibar', content: '# notes' })).body.id;
    ids.todo = (await app.api('POST', '/api/todos', { title: 'Relancer le fournisseur quetzal' })).body.id;
    ids.code = seed.insererTache(app.db, repoId, { prompt: 'Refondre le module de paiement', label: 'Session ornithorynque' });
    ids.explore = seed.insererTache(app.db, repoId, { prompt: 'Où est la TVA ?', label: 'Exploration wombat', kind: 'explore' });
    const verif = await app.api('POST', '/api/verifiers', {
      name: 'Tests palette', kind: 'commands', commands: ['true'], repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.ok(verif.status < 300, verif.text);
    ids.verif = verif.body.id;
    app.db.prepare('INSERT INTO repo_jenkins (repo_id, job_path) VALUES (?,?)').run(repoId, 'app/deploy');
    assert.equal((await app.api('POST', '/api/git-commands', { label: 'Statut maison okapi', command: 'status -s' })).status, 200);
    assert.equal((await app.api('POST', '/api/jira/watch', { key: 'PROJ-77' })).status < 300, true);
    const agent = await app.api('POST', '/api/agents', { name: 'Agent capybara', kind: 'explore' });
    assert.equal(agent.status, 201, agent.text);
    ids.agent = agent.body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    await page.waitForSelector('#toReviewList .card[data-id]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (jenkins) await jenkins.close();
    if (app) await app.stop();
  });

  /* Repart d'un écran sans modale ni vue plein écran : chaque test ouvre la palette depuis un
     état connu, sans dépendre de ce que le précédent a laissé ouvert. */
  async function remettre() {
    await page.evaluate(() => {
      document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; });
      const sv = document.querySelector('#splitView');
      if (sv && !sv.hidden) sv.hidden = true;
    });
  }
  async function ouvrir() {
    await remettre();
    await page.locator('#paletteTrigger').click();
    await page.waitForSelector('#paletteModal:not([hidden])');
  }
  // L'entrée dont le libellé est EXACTEMENT celui-là (la liste se recompose à chaque réponse).
  const entree = (libelle) => page.locator('#paletteList .palette-item')
    .filter({ has: page.locator('.palette-label', { hasText: new RegExp(`^${echapper(libelle)}$`) }) }).first();
  async function choisir(requete, libelle) {
    await ouvrir();
    await page.locator('#paletteInput').fill(requete);
    await entree(libelle).click();
    await page.waitForSelector('#paletteModal', { state: 'hidden' });
  }
  const actif = (onglet) => page.waitForSelector(`#tab-${onglet}.active`);
  async function aller(onglet) {
    await remettre();
    await page.locator(`nav button[data-tab="${onglet}"]`).click();
    await actif(onglet);
  }

  /* ------------------------------------------------------------ le raccourci ---- */

  test('Ctrl+K ouvre la palette, le curseur dans son champ ; Ctrl+K la referme', async () => {
    await remettre();
    await page.locator('body').click({ position: { x: 700, y: 5 } });
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#paletteModal:not([hidden])');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#paletteInput'));
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#paletteModal', { state: 'hidden' });
  });

  test('Ctrl+K fonctionne même le curseur dans un champ de texte', async () => {
    await remettre();
    await aller('review');
    await page.locator('#searchReview').click();
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#paletteModal:not([hidden])');
    assert.equal(await page.locator('#searchReview').inputValue(), '', 'la frappe n’a rien écrit dans le champ');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#paletteModal', { state: 'hidden' });
  });

  test('le déclencheur affiche le raccourci du clavier de la plateforme', async () => {
    const { mac, libelle } = await page.evaluate(() => ({
      mac: /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || ''),
      libelle: document.querySelector('#paletteKbd').textContent,
    }));
    assert.equal(libelle, mac ? '⌘ K' : 'Ctrl K');
  });

  /* --------------------------------------------------------- la palette à vide ---- */

  test('à vide : trois sections titrées (actions, MR, sessions) ; taper les efface', async () => {
    await ouvrir();
    await page.waitForFunction(() => document.querySelectorAll('#paletteList .palette-head').length === 3);
    const titres = await page.locator('#paletteList .palette-head').allTextContents();
    assert.deepEqual(titres, ['Actions', 'Merge requests récentes', 'Sessions récentes']);
    await page.locator('#paletteInput').fill('zanzibar');
    await page.waitForFunction(() => /Compte rendu zanzibar/.test(document.querySelector('#paletteList').textContent));
    assert.equal(await page.locator('#paletteList .palette-head').count(), 0, 'dès qu’on tape, le classement est par pertinence');
    // Chaque ligne dit ce qu'elle est.
    assert.match(await entree('Compte rendu zanzibar').locator('.palette-kind').textContent(), /Notes/);
  });

  test('une recherche sans résultat le dit', async () => {
    await ouvrir();
    await page.locator('#paletteInput').fill('xqzjwv-introuvable');
    await page.waitForSelector('#paletteList .palette-empty');
    assert.match(await page.locator('#paletteList .palette-empty').textContent(), /Rien ne correspond/);
  });

  test('les flèches déplacent la sélection, Entrée ouvre la ligne sélectionnée', async () => {
    await ouvrir();
    await page.locator('#paletteInput').fill('Notes —');
    await page.waitForFunction(() => document.querySelectorAll('#paletteList .palette-item').length >= 3
      && [...document.querySelectorAll('#paletteList .palette-label')].every((l) => /Notes —/.test(l.textContent)));
    const libelles = await page.locator('#paletteList .palette-label').allTextContents();
    assert.match(await page.locator('#paletteList .palette-item.active .palette-label').textContent(), new RegExp(echapper(libelles[0])));
    await page.locator('#paletteInput').press('ArrowDown');
    await page.locator('#paletteInput').press('ArrowDown');
    await page.locator('#paletteInput').press('ArrowUp');
    const choisie = await page.locator('#paletteList .palette-item.active .palette-label').textContent();
    assert.equal(choisie, libelles[1], 'deux fois bas, une fois haut : la deuxième ligne');
    await page.locator('#paletteInput').press('Enter');
    await page.waitForSelector('#paletteModal', { state: 'hidden' });
    const attendu = { 'Notes — brief du jour': '#notesSubToday', 'Notes — todos': '#notesSubTodos', 'Notes — pages': '#notesSubPages' }[choisie];
    assert.ok(attendu, `ligne inattendue : ${choisie}`);
    await page.waitForSelector(`${attendu}:not([hidden])`);
  });

  test('Échap et un clic au fond la referment sans rien ouvrir', async () => {
    await aller('review');
    await ouvrir();
    await page.locator('#paletteInput').press('Escape');
    await page.waitForSelector('#paletteModal', { state: 'hidden' });
    await ouvrir();
    await page.locator('#paletteModal').click({ position: { x: 5, y: 900 } });
    await page.waitForSelector('#paletteModal', { state: 'hidden' });
    assert.ok(await page.locator('#tab-review').evaluate((el) => el.classList.contains('active')), 'on est resté où l’on était');
  });

  /* ------------------------------------------------------- les entrées d'action ---- */

  const NAVIGATION = [
    ['Aller aux reviews', '#tab-review.active'],
    ['Reviews — à traiter', '#tab-review.active .segmented [data-seg="to_review"].active'],
    ['Reviews — reviewées', '#tab-review.active .segmented [data-seg="reviewed"].active'],
    ['Reviews — traitées', '#tab-review.active .segmented [data-seg="done"].active'],
    ['Aller à Dev IA', '#tab-task.active'],
    ['Notes — brief du jour', '#tab-notes.active #notesSubToday:not([hidden])'],
    ['Notes — todos', '#tab-notes.active #notesSubTodos:not([hidden])'],
    ['Notes — pages', '#tab-notes.active #notesSubPages:not([hidden])'],
    ['Aller à Jira', '#tab-jira.active'],
    ['Aller à Git', '#tab-git.active'],
    ['Aller à Docker', '#tab-docker.active'],
    ['Aller à Jenkins', '#tab-jenkins.active'],
    ['Aller aux statistiques', '#tab-dashboard.active'],
    ['Aller aux Agents', '#tab-agents.active'],
    ['Aller aux réglages', '#tab-admin.active'],
  ];
  for (const [libelle, effet] of NAVIGATION) {
    test(`« ${libelle} » mène au bon écran`, async () => {
      // On part d'un AUTRE onglet que la cible, sinon l'effet serait déjà là.
      const depart = /tab-admin/.test(effet) ? 'review' : 'admin';
      await aller(depart);
      await choisir(libelle, libelle);
      await page.waitForSelector(effet);
    });
  }

  test('« Chercher les nouvelles MR » interroge la forge : une MR arrivée entre-temps apparaît', async () => {
    app.state.mrs['grp/app'].push({
      iid: 42, title: 'Arrivée par la palette', state: 'opened', source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/42', sha: repo.branchSha, author: { name: 'Bob' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    });
    app.state.changes['grp/app!42'] = [{ new_path: 'src/app.js' }];
    await aller('admin');
    await choisir('Chercher les nouvelles', 'Chercher les nouvelles MR');
    await actif('review');
    await attendreServeur(async () => (await app.api('GET', '/api/mrs')).body.some((m) => m.iid === 42), 'la MR !42 est découverte');
    await page.waitForFunction(() => /Arrivée par la palette/.test(document.querySelector('#toReviewList').textContent));
    ids.mr42 = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 42).id;
    await waitForJobs(app.api);
  });

  test('« Nouvelle session de codage » ouvre la modale de session sur Dev IA', async () => {
    await choisir('Nouvelle session', 'Nouvelle session de codage');
    await actif('task');
    await page.waitForSelector('#taskModal:not([hidden])');
  });

  test('« Nouvelle todo » ouvre la capture rapide sans changer d’onglet', async () => {
    await aller('dashboard');
    await choisir('Nouvelle todo', 'Nouvelle todo');
    await page.waitForSelector('#captureModal:not([hidden])');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#captureTitle'));
    assert.ok(await page.locator('#tab-dashboard').evaluate((el) => el.classList.contains('active')));
  });

  test('« Nouvelle page de notes » crée une page et l’ouvre', async () => {
    const avant = (await app.api('GET', '/api/notes')).body;
    const nAvant = (Array.isArray(avant) ? avant : avant.pages).length;
    await choisir('Nouvelle page', 'Nouvelle page de notes');
    await attendreServeur(async () => {
      const b = (await app.api('GET', '/api/notes')).body;
      return (Array.isArray(b) ? b : b.pages).length === nAvant + 1;
    }, 'une page de plus');
    await page.waitForFunction(() => /^#\/notes\/\d+$/.test(window.location.hash));
    const id = Number((await page.evaluate(() => window.location.hash)).split('/').pop());
    assert.ok(!(Array.isArray(avant) ? avant : avant.pages).some((p) => p.id === id), 'c’est la NOUVELLE page qui est ouverte');
    await page.waitForSelector('#tab-notes.active #notesSubPages:not([hidden])');
  });

  test('« Afficher le journal » déplie le panneau des logs', async () => {
    await page.evaluate(() => { const p = document.querySelector('#logPanel'); if (p) p.hidden = true; });
    await choisir('Afficher le journal', 'Afficher le journal');
    await page.waitForSelector('#logPanel:not([hidden])');
  });

  test('« Voir les raccourcis clavier » ouvre la feuille des raccourcis', async () => {
    await choisir('raccourcis', 'Voir les raccourcis clavier');
    await page.waitForSelector('#shortcutsModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#shortcutsList .shortcut-row').length > 10);
  });

  /* ------------------------------------------------------- les gestes d'un résultat ---- */

  test('une merge request reviewée s’ouvre sur son rapport, et l’adresse la désigne', async () => {
    await aller('dashboard');
    await choisir('Refonte palette', '!77 — Refonte palette des remises');
    await actif('review');
    await page.waitForFunction((id) => window.location.hash === `#/reviews/${id}`, ids.mrRevue);
    await page.waitForFunction(() => /Revue/.test(document.querySelector('#reportDetail').textContent));
    await page.waitForSelector('.segmented [data-seg="reviewed"].active');
  });

  test('⌘/Ctrl+Entrée sur une merge request ouvre son DIFF, pas son rapport', async () => {
    await ouvrir();
    await page.locator('#paletteInput').fill('!41');
    await page.waitForFunction(() => [...document.querySelectorAll('#paletteList .palette-label')].some((l) => /^!41 — /.test(l.textContent)));
    await page.locator('#paletteInput').press('Control+Enter');
    await page.waitForSelector('#splitView:not([hidden])');
    await page.waitForFunction(() => /!41/.test(document.querySelector('#splitTitle').textContent));
    await page.waitForSelector('#splitView.preview-mode');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#splitView', { state: 'hidden' });
  });

  /* BUG : `ouvrirResultatPalette` (public/app.js, `if (n.ticket)`) appelle `selectJiraIssue`
     directement, pendant que `navTab('jira')` lance `loadJira` → `loadJiraTickets`. Quand la
     liste « Mes tickets » arrive, elle réécrit `#jiraDetail` (« Aucun ticket ne t’est
     affecté », ou le PREMIER ticket de la liste) par-dessus le ticket demandé. Le mécanisme
     prévu pour ce cas existe — `JIRA.cible`, que `loadJiraTickets` relit — mais la palette ne
     le pose pas. */
  test('un ticket surveillé tapé seul (« PROJ-77 ») s’ouvre directement dans Jira', async () => {
    await aller('dashboard');
    await ouvrir();
    await page.locator('#paletteInput').fill('PROJ-77');
    await page.waitForFunction(() => [...document.querySelectorAll('#paletteList .palette-label')].some((l) => /^PROJ-77 — /.test(l.textContent)));
    await page.locator('#paletteInput').press('Enter');
    await page.waitForSelector('#paletteModal', { state: 'hidden' });
    await actif('jira');
    /* La liste « Mes tickets » est arrivée (son compteur est écrit) ET le détail est peint :
       les deux réponses arrivent dans un ordre qui dépend de la machine, et un détail encore vide
       n'est pas « le rendu de la liste », c'est un rendu pas encore fait. Ce qu'on prouve : une
       fois les deux là, c'est bien le ticket demandé qui reste à l'écran. */
    await page.waitForFunction(() => /\d/.test(document.querySelector('#jiraInfo').textContent)
      && /Ticket surveillé de la palette/.test(document.querySelector('#jiraDetail').textContent));
    assert.match(await page.locator('#jiraDetail').textContent(), /Ticket surveillé de la palette/,
      'le détail montre le ticket demandé, pas le rendu de la liste arrivée après');
  });

  test('une page de notes s’ouvre, et l’adresse la désigne', async () => {
    await choisir('zanzibar', 'Compte rendu zanzibar');
    await page.waitForFunction((t) => (document.querySelector('#pageTitle') || {}).value === t, 'Compte rendu zanzibar');
    await page.waitForFunction((id) => window.location.hash === `#/notes/${id}`, ids.page);
  });

  test('une todo mène à la liste des todos, où elle est', async () => {
    await aller('review');
    await choisir('quetzal', 'Relancer le fournisseur quetzal');
    await page.waitForSelector('#tab-notes.active #notesSubTodos:not([hidden])');
    await page.waitForFunction(() => /Relancer le fournisseur quetzal/.test(document.querySelector('#todoList').textContent));
  });

  test('une session de codage ouvre Dev IA sur SA carte', async () => {
    await aller('review');
    await choisir('ornithorynque', 'Session ornithorynque');
    await actif('task');
    await page.waitForFunction((id) => window.location.hash === `#/sessions/code/${id}`, ids.code);
    await page.waitForSelector(`#taskList .task-row[data-task="${ids.code}"]`);
  });

  test('une exploration ouvre la saveur « Exploration », pas le sous-onglet d’avant', async () => {
    await aller('review');
    await choisir('wombat', 'Exploration wombat');
    await page.waitForFunction((id) => window.location.hash === `#/sessions/explore/${id}`, ids.explore);
    await page.waitForSelector('#tab-task .subnav [data-kind="explore"].active');
    await page.waitForSelector(`#taskList .task-row[data-task="${ids.explore}"]`);
  });

  test('un vérificateur ouvre « Vérifier une branche », présélectionné', async () => {
    await choisir('Tests palette', 'Vérifier avec « Tests palette »');
    await page.waitForSelector('#branchVerifyModal:not([hidden])');
    assert.equal(await page.locator('#branchVerifySelect').inputValue(), String(ids.verif));
  });

  test('un job Jenkins rattaché ouvre sa fiche', async () => {
    await choisir('app/deploy', 'Ouvrir le job app/deploy');
    await actif('jenkins');
    await page.waitForSelector('#jenkinsModal:not([hidden])');
    assert.equal(await page.locator('#jenkinsModalTitle').textContent(), 'app/deploy');
    await page.waitForFunction(() => /Déploie la boutique/.test(document.querySelector('#jenkinsModalDesc').textContent));
  });

  test('une commande git enregistrée ouvre Git → Commandes, champ rempli', async () => {
    await choisir('okapi', 'Commande git : Statut maison okapi');
    await actif('git');
    await page.waitForFunction(() => (document.querySelector('#cmdInput') || {}).value === 'status -s');
  });

  test('un agent ouvre la modale de session avec cet agent posé', async () => {
    await choisir('capybara', 'Demander à Agent capybara');
    await actif('agents');
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((id) => {
      const h = document.querySelector('#taskAgentBox .taskAgentVal');
      return h && h.value === String(id);
    }, ids.agent);
  });

  /* En dernier : il change le stade de toutes les merge requests à traiter. */
  test('« Reviewer toutes les MR en attente » lance la review de la file', async () => {
    await remettre();
    await choisir('Reviewer toutes', 'Reviewer toutes les MR en attente');
    await actif('review');
    await attendreServeur(async () => {
      const mrs = (await app.api('GET', '/api/mrs')).body;
      return [41, 42].every((iid) => (mrs.find((m) => m.iid === iid) || {}).status === 'reviewed');
    }, 'les deux MR de la file sont reviewées', 90000);
    await waitForJobs(app.api);
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
