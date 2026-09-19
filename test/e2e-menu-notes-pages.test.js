'use strict';
/* MENU NOTES → PAGES, dans un VRAI navigateur.
 *
 * Ce que les fichiers existants ne pilotaient pas par l'écran : la colonne vide, « Nouvelle
 * page » et l'autosauvegarde relue côté serveur, la recherche (titre, contenu, aucun résultat),
 * épingler / désépingler, l'export Markdown, la suppression (annulée, rattrapée par « Annuler »,
 * puis réelle — et ses sous-pages avec elle), le pli des sous-pages, les liens parent ↔ enfants,
 * « Faire coder l'IA » (prompt ET captures en pièces jointes), les autoliens vers un ticket Jira
 * et vers une MR ambiguë, la bulle de résumé au survol, et le sous-onglet retenu au rechargement.
 *
 * Le reste des Pages (colonnes, sous-page créée depuis l'éditeur, image collée, Mermaid,
 * historique et partage) vit dans e2e-notes-ui, e2e-notes-image, e2e-notes-mermaid et
 * e2e-data-sync.
 *
 * Un seul `startApp()` ; rien de `src/` n'est chargé en tête de fichier. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');

const { dispo } = navigateurDispo();


// Une vraie image PNG 1×1 : le serveur vérifie la signature, pas seulement le préfixe.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Menu Notes · Pages', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];
  let mrUnique;

  const pages = async () => (await app.api('GET', '/api/notes')).body.pages || [];
  const pageParTitre = async (t) => (await pages()).find((p) => p.title === t);
  // La liste ne porte pas le contenu : on relit la page elle-même.
  const contenu = async (t) => {
    const p = await pageParTitre(t);
    return p ? ((await app.api('GET', `/api/notes/${p.id}`)).body.content || '') : '';
  };

  before(async () => {
    app = await startApp();
    const mr = (iid, titre, branche) => ({
      iid, title: titre, state: 'opened', source_branch: branche, target_branch: 'main',
      web_url: `https://gitlab.test/x/-/merge_requests/${iid}`, sha: `sha${iid}`,
      created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: `sha${iid}` },
    });
    // !214 n'existe que dans un dépôt ; !300 existe dans DEUX — le lien doit alors chercher.
    app.state.mrs['grp/app'] = [mr(214, 'PROJ-42 ajoute le panier', 'feature/PROJ-42'), mr(300, 'Refonte du cache', 'feature/cache')];
    app.state.mrs['grp/web'] = [mr(300, 'Thème sombre', 'feature/theme')];
    // Un ticket à MOI, que l'onglet Jira sélectionne d'office en arrivant ; celui cité par la page, lui, ne l'est pas.
    app.state.jiraIssues['MINE-1'] = {
      key: 'MINE-1',
      fields: {
        summary: 'Mon ticket du sprint', assignee: { accountId: 'me-test', displayName: 'Testeur courant' },
        status: { name: 'En cours', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Tâche' },
      },
    };
    app.state.jiraIssues['PROJ-720'] = {
      key: 'PROJ-720',
      fields: {
        summary: 'Le tunnel de paiement boucle',
        status: { name: 'À faire', statusCategory: { key: 'new' } },
        description: 'Le paiement en trois fois repart au début.',
        issuetype: { name: 'Bug' },
      },
    };
    // Le faux Jira est servi par le même serveur que le faux GitLab (cf. helpers/app).
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app.git', project: 'grp/app' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/web.git', project: 'grp/web' });
    await app.api('POST', '/api/discover');
    mrUnique = app.db.prepare('SELECT mr.id FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.iid = 214').get().id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Aller sur Notes → Pages, sans modale ouverte par-dessus.
  const allerPages = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    await page.waitForSelector('#notesSubPages:not([hidden])');
  };
  /* Ouvre une page par son titre et attend l'éditeur REDESSINÉ pour elle. Juste après le clic,
     l'éditeur affiché est encore l'ancien — et quand on rouvre la page déjà ouverte, il porte
     déjà le bon titre : attendre le titre ne suffit pas, ce qu'on taperait partirait dans un
     champ remplacé une milliseconde plus tard. On marque donc l'ancien éditeur, et on attend
     un `#pageTitle` qui n'a pas la marque. */
  const ouvrir = async (titre) => {
    await page.evaluate(() => { const e = document.querySelector('#pageTitle'); if (e) e.dataset.ancien = '1'; });
    await page.locator('#pageList .note-item', { hasText: titre }).first().click();
    await page.waitForFunction((t) => {
      const el = document.querySelector('#pageTitle');
      return el && !el.dataset.ancien && el.value === t;
    }, titre);
  };
  // Recharge la liste depuis le serveur (les pages créées par l'API n'y sont pas encore).
  const rechargerListe = async (q = '') => {
    await page.locator('#pageSearch').fill(q ? `${q} ` : ' ');
    await page.locator('#pageSearch').fill(q);
  };

  test('sans aucune page, la colonne le dit et l’éditeur invite à en créer une', async () => {
    await allerPages();
    await page.waitForFunction(() => /Aucune page/.test(document.querySelector('#pageList').textContent));
    assert.match(await page.locator('#pageEditor').innerText(), /Choisis une page à gauche, ou crée-en une/);
  });

  test('« Nouvelle page » crée, ouvre le Markdown, et la frappe s’enregistre toute seule', async () => {
    await allerPages();
    await page.locator('#pageNew').click();
    await page.waitForFunction(() => document.querySelector('#pageTitle') && (document.querySelector('#pageTitle') || {}).value === 'Nouvelle page');
    assert.equal(await page.locator('#pageContent').isVisible(), true, 'une page vide s’ouvre sur le Markdown');
    // Le titre est sélectionné : taper le remplace.
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'pageTitle');

    await page.keyboard.type('Compte rendu du daily');
    await page.locator('#pageContent').fill('# Points du jour\n\n- relire la **migration**\n');
    await attendreServeur(async () => /relire la \*\*migration\*\*/.test(await contenu('Compte rendu du daily')),
      'titre et contenu enregistrés par l’autosauvegarde');
    await page.waitForFunction(() => (document.querySelector('#pageSaved') || {}).textContent === 'Enregistré');
    await page.waitForFunction(() => /Compte rendu du daily/.test(document.querySelector('#pageList').textContent));

    // L'aperçu rend le Markdown.
    await page.locator('.note-panes-pick [data-panes="both"]').click();
    assert.equal(await page.locator('#pagePreview h1').innerText(), 'Points du jour');
    assert.equal(await page.locator('#pagePreview strong').innerText(), 'migration');
  });

  test('changer de sous-onglet avant l’autosauvegarde n’emporte pas la dernière frappe', async () => {
    await allerPages();
    await ouvrir('Compte rendu du daily');
    await page.locator('#pageContent').fill('# Points du jour\n\ndernière phrase tapée à la volée\n');
    // Aucune attente : on part aussitôt vers les todos, la sauvegarde en attente doit partir.
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await attendreServeur(async () => /à la volée/.test(await contenu('Compte rendu du daily')),
      'la frappe en attente est enregistrée en quittant');
  });

  test('la recherche trouve par le titre, par le contenu, et dit quand rien ne correspond', async () => {
    await app.api('POST', '/api/notes', { title: 'Architecture paiement', content: 'le service billing parle à ledger' });
    await app.api('POST', '/api/notes', { title: 'Courses', content: 'lait, pain' });
    await allerPages();
    await rechargerListe('');
    await page.waitForFunction(() => document.querySelectorAll('#pageList .note-item').length === 3);

    await page.locator('#pageSearch').fill('Architecture');
    await page.waitForFunction(() => document.querySelectorAll('#pageList .note-item').length === 1);
    assert.match(await page.locator('#pageList').innerText(), /Architecture paiement/);

    await page.locator('#pageSearch').fill('ledger');
    await page.waitForFunction(() => document.querySelectorAll('#pageList .note-item').length === 1
      && /Architecture paiement/.test(document.querySelector('#pageList').textContent));

    await page.locator('#pageSearch').fill('zzz-introuvable');
    await page.waitForFunction(() => /Aucune page ne correspond à « zzz-introuvable »/.test(document.querySelector('#pageList').textContent));

    await page.locator('#pageSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#pageList .note-item').length === 3);
  });

  test('épingler met la page en tête, désépingler la rend à sa place', async () => {
    await allerPages();
    await ouvrir('Courses');
    // « Courses » est la plus récente après la création de « Architecture » : on épingle l'ancienne.
    await ouvrir('Architecture paiement');
    await page.locator('#pagePin').click();
    await attendreServeur(async () => ((await pageParTitre('Architecture paiement')) || {}).pinned === 1, 'épinglée côté serveur');
    await page.waitForFunction(() => /Désépingler/.test((document.querySelector('#pagePin') || {}).textContent));
    await page.waitForFunction(() => /Architecture paiement/.test((document.querySelector('#pageList .note-item') || {}).textContent));
    assert.equal(await page.locator('#pageList .note-item').first().locator('use[href="#i-tag"]').count(), 1,
      'la page épinglée porte sa marque');

    await page.locator('#pagePin').click();
    await attendreServeur(async () => ((await pageParTitre('Architecture paiement')) || {}).pinned === 0, 'désépinglée côté serveur');
    await page.waitForFunction(() => /Épingler/.test((document.querySelector('#pagePin') || {}).textContent));
    assert.equal(await page.locator('#pageList .note-item', { hasText: 'Architecture paiement' }).locator('use[href="#i-tag"]').count(), 0);
  });

  test('« Exporter » télécharge la page en Markdown', async () => {
    await allerPages();
    await ouvrir('Architecture paiement');
    const [telechargement] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#pageExport').click(),
    ]);
    assert.match(telechargement.suggestedFilename(), /architecture-paiement.*\.md$/i);
    const contenu = fs.readFileSync(await telechargement.path(), 'utf8');
    assert.match(contenu, /Architecture paiement/);
    assert.match(contenu, /billing parle à ledger/);
  });

  test('supprimer : « Annuler » dans la confirmation garde la page', async () => {
    await allerPages();
    await ouvrir('Courses');
    await page.locator('#pageDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /Supprimer la page « Courses »/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.equal(await page.locator('#pageTitle').inputValue(), 'Courses', 'l’éditeur est toujours là');
    assert.ok(await pageParTitre('Courses'));
  });

  test('supprimer puis « Annuler » dans le bandeau rouvre la page, et elle existe toujours', async () => {
    await allerPages();
    await ouvrir('Courses');
    const id = (await pageParTitre('Courses')).id;
    await page.locator('#pageDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    // L'éditeur se vide tout de suite ; l'appel part six secondes plus tard.
    await page.waitForFunction(() => /Choisis une page/.test(document.querySelector('#pageEditor').textContent));
    const bandeau = page.locator('.toast', { hasText: 'Page supprimée' }).locator('.toast-btn');
    await bandeau.click();
    await page.waitForFunction(() => document.querySelector('#pageTitle') && (document.querySelector('#pageTitle') || {}).value === 'Courses');
    /* Le bandeau vivait six secondes : au-delà, la suppression serait partie. On attend donc
       un peu plus que ce délai avant de conclure qu'elle n'est PAS partie. */
    const fin = Date.now() + 7500;
    while (Date.now() < fin) {
      assert.equal((await app.api('GET', `/api/notes/${id}`)).status, 200, 'la page existe toujours');
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  test('supprimer pour de bon retire la page côté serveur', async () => {
    await allerPages();
    await ouvrir('Courses');
    const id = (await pageParTitre('Courses')).id;
    await page.locator('#pageDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await app.api('GET', `/api/notes/${id}`)).status === 404,
      'la page est supprimée au bout du délai d’annulation', 20000);
    await page.waitForFunction(() => !/Courses/.test(document.querySelector('#pageList').textContent));
  });

  test('les sous-pages : repliées par défaut, dépliées d’un clic, liées dans les deux sens', async () => {
    const parent = (await app.api('POST', '/api/notes', { title: 'Carte des domaines', content: 'vue d’ensemble' })).body;
    await app.api('POST', '/api/notes', { title: 'Domaine facturation', content: 'détail A', parent_id: parent.id });
    await app.api('POST', '/api/notes', { title: 'Domaine livraison', content: 'détail B', parent_id: parent.id });
    await allerPages();
    await rechargerListe('');
    const ligne = page.locator('#pageList .note-row', { hasText: 'Carte des domaines' }).first();
    await ligne.waitFor();
    const avant = await page.locator('#pageEditor').innerText();
    assert.equal(await ligne.locator('.note-fold').getAttribute('aria-expanded'), 'false');
    assert.equal(await ligne.locator('.note-item-count').innerText(), '2', 'le nombre de sous-pages repliées se lit');
    assert.equal(await page.locator('#pageList .note-item.note-sub').count(), 0);

    await ligne.locator('.note-fold').click();
    await page.waitForFunction(() => document.querySelectorAll('#pageList .note-item.note-sub').length === 2);
    assert.equal(await page.locator('#pageEditor').innerText(), avant, 'déplier n’ouvre pas la page');
    await page.locator('#pageList .note-row', { hasText: 'Carte des domaines' }).first().locator('.note-fold').click();
    await page.waitForFunction(() => document.querySelectorAll('#pageList .note-item.note-sub').length === 0);

    // La page générale nomme ses sous-pages, et y mène.
    await ouvrir('Carte des domaines');
    await page.waitForSelector('#pageEditor .note-children');
    assert.match(await page.locator('#pageEditor .note-children').innerText(), /2 sous-pages/);
    await page.locator('#pageEditor .note-children .lien-page', { hasText: 'Domaine livraison' }).click();
    await page.waitForFunction(() => (document.querySelector('#pageTitle') || {}).value === 'Domaine livraison');
    // …et la sous-page mène à son parent.
    assert.match(await page.locator('#pageEditor .note-parent').innerText(), /Sous-page de/);
    await page.locator('#pageEditor .note-parent .lien-page').click();
    await page.waitForFunction(() => (document.querySelector('#pageTitle') || {}).value === 'Carte des domaines');
  });

  test('supprimer une page générale prévient que ses sous-pages partent avec elle', async () => {
    await allerPages();
    await ouvrir('Carte des domaines');
    const ids = (await pages()).filter((p) => /Carte des domaines|Domaine /.test(p.title)).map((p) => p.id);
    assert.equal(ids.length, 3);
    await page.locator('#pageDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmDetail').innerText(), /Ses 2 sous-pages partent avec elle/);
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => {
      const st = await Promise.all(ids.map(async (id) => (await app.api('GET', `/api/notes/${id}`)).status));
      return st.every((s) => s === 404);
    }, 'la page et ses deux sous-pages sont supprimées', 20000);
  });

  test('« Faire coder l’IA » prépare une session : la page en prompt, ses captures en pièces jointes', async () => {
    const p = (await app.api('POST', '/api/notes', { title: 'Bug du tunnel', content: 'Le paiement en 3× repart au début.' })).body;
    const img = await app.api('POST', `/api/notes/${p.id}/images`, { image: PNG_1PX });
    assert.equal(img.status, 200, img.text);
    await app.api('PUT', `/api/notes/${p.id}`, { content: `Le paiement en 3× repart au début.\n\n![capture](${img.body.url})\n` });
    await allerPages();
    await rechargerListe('');
    await ouvrir('Bug du tunnel');
    await page.locator('#pageToCode').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.match(await page.locator('#taskModalTitle').innerText(), /Faire coder l’IA — Bug du tunnel/);
    const prompt = await page.locator('#taskPrompt').inputValue();
    assert.match(prompt, /Contexte — note « Bug du tunnel »/);
    assert.match(prompt, /repart au début/);
    await page.waitForSelector('#taskJiraPieces:not([hidden]) [data-note-piece]');
    assert.equal(await page.locator('#taskJiraPieces [data-note-piece]:checked').count(), 1,
      'la capture est proposée, cochée d’office');
    // Rien n'est lancé : c'est un formulaire à relire.
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM task').get().c, 0, 'aucune session créée à l’ouverture');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  });

  /* Même course que dans e2e-menu-notes-todos : le chargement de « mes tickets » se termine
     en réécrivant le détail. On attend la fin de ce chargement avant de lire. */
  test('un ticket cité dans une page mène à son détail Jira', async () => {
    await app.api('POST', '/api/notes', { title: 'Suivi Jira', content: 'bloqué par PROJ-720 depuis lundi' });
    await allerPages();
    await rechargerListe('');
    await ouvrir('Suivi Jira');
    const lien = page.locator('#pagePreview .note-link[data-note-ticket="PROJ-720"]');
    await lien.waitFor();
    /* L'ordre réaliste : une recherche JQL (« mes tickets ») répond après la lecture d'UN
       ticket. On retient donc la liste jusqu'à ce que le détail soit arrivé — sans cela, le
       résultat dépendrait de la vitesse de la machine. */
    let detailArrive;
    const detail = new Promise((r) => { detailArrive = r; });
    const surReponse = (rep) => { if (rep.url().includes('/api/jira/issue/PROJ-720')) detailArrive(); };
    page.on('response', surReponse);
    await page.route('**/api/jira/tickets**', async (route) => { await detail; await route.continue(); });
    await lien.click();
    await page.waitForSelector('#tab-jira.active');
    /* L'écran est posé : « mes tickets » est rendu (MINE-1 y figure) et le détail n'attend plus
       rien. Tant que la liste n'est pas là, le détail affiché n'est pas encore le dernier mot. */
    await page.waitForFunction(() => /MINE-1/.test(document.querySelector('#jiraList').textContent)
      && !document.querySelector('#jiraList .sk-wrap')
      && !document.querySelector('#jiraDetail .sk-wrap')
      && document.querySelector('#jiraDetail').textContent.trim() !== '');
    page.off('response', surReponse);
    await page.unroute('**/api/jira/tickets**');
    assert.match(await page.locator('#jiraDetail').innerText(), /Le tunnel de paiement boucle/,
      'le détail est celui du ticket cliqué');
  });

  test('survoler « !214 » affiche le résumé de la merge request', async () => {
    await app.api('POST', '/api/notes', { title: 'Survol', content: 'penser à !214 avant jeudi' });
    await allerPages();
    await rechargerListe('');
    await ouvrir('Survol');
    const lien = page.locator(`#pagePreview .note-link[data-note-mr="${mrUnique}"]`);
    await lien.waitFor();
    await lien.hover();
    await page.waitForFunction((id) => {
      const a = document.querySelector(`#pagePreview .note-link[data-note-mr="${id}"]`);
      return a && /PROJ-42 ajoute le panier/.test(a.dataset.tip || '');
    }, mrUnique);
    const tip = await lien.getAttribute('data-tip');
    assert.match(tip, /!214/);
    assert.match(tip, /grp\/app/);
  });

  test('« !300 » porté par deux dépôts mène à la recherche, pas à l’un des deux au hasard', async () => {
    await app.api('POST', '/api/notes', { title: 'Ambigu', content: 'voir !300 demain' });
    await allerPages();
    await rechargerListe('');
    await ouvrir('Ambigu');
    const lien = page.locator('#pagePreview .note-link-multi');
    await lien.waitFor();
    assert.match(await lien.getAttribute('title'), /grp\/app/);
    assert.match(await lien.getAttribute('title'), /grp\/web/);
    await lien.click();
    await page.waitForSelector('#tab-review.active');
    await page.waitForFunction(() => document.querySelector('#searchReview').value === '!300');
  });

  test('le sous-onglet Pages est retenu d’un rechargement à l’autre', async () => {
    await allerPages();
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#notesSubPages:not([hidden])');
    assert.equal(await page.locator('#notesSubToday').isHidden(), true);
    assert.equal(await page.locator('#tab-notes .subnav button[data-nsub="pages"]').getAttribute('class'), 'active');
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
