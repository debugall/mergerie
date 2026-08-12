'use strict';
/* L'onglet Notes dans un VRAI navigateur.
 *
 * Trois comportements ne se prouvent que là : l'ATTERRISSAGE sur le brief à la première
 * ouverture de la journée (et son unicité — c'est la partie facile à casser), la CAPTURE
 * RAPIDE au clavier depuis n'importe quel onglet, et l'AUTOLINK qui doit rendre `!214`
 * cliquable et mener à la bonne merge request. Le reste passe par l'API et vit dans
 * `e2e-notes.test.js`.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Onglet Notes', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;
  let mrId;

  before(async () => {
    app = await startApp();
    app.state.mrs['grp/app'] = [{
      iid: 214, title: 'PROJ-42 ajoute le panier', state: 'opened',
      source_branch: 'feature/PROJ-42', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/214',
      sha: 'abc123', created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'abc123' },
    }];
    /* L'atterrissage est le sujet du premier test : on le laisse ACTIF, contrairement au
       défaut du harnais (qui l'éteint pour ne pas dérouter les autres tests d'interface). */
    await app.configure({ brief_on_open: '1' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app.git', project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = app.db.prepare('SELECT id FROM mr WHERE iid = 214').get().id;

    await app.api('POST', '/api/notes', { title: 'Points du daily' });
    const page1 = app.db.prepare('SELECT id FROM note_page LIMIT 1').get().id;
    await app.api('PUT', `/api/notes/${page1}`, { content: 'reparler de !214 avant jeudi' });
    await app.api('POST', '/api/todos', { title: 'Relancer la plateforme', priority: 'high' });

    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1440, height: 900 } });
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Un profil neuf n'a jamais « déjà vu » le brief du jour : la première ouverture doit donc
     atterrir sur Notes → Aujourd'hui, même si le dernier onglet consulté était un autre. */
  test('à la première ouverture du jour, l’application s’ouvre sur le brief', async () => {
    await page.goto(app.base);
    await page.evaluate(() => {
      localStorage.setItem('aidevtools_tab', 'git');
      localStorage.removeItem('mergerie_brief_seen');   // le premier chargement l'a déjà posée
    });
    await page.reload();
    await page.waitForSelector('#briefBox .brief-head');
    assert.equal(await page.locator('#tab-notes').isVisible(), true);
    assert.equal(await page.locator('#notesSubToday').isVisible(), true, 'et sur « Aujourd’hui »');
    assert.match(await page.locator('.brief-date').innerText(), /\d{4}/, 'la date longue ouvre le brief');
  });

  /* LE piège : sans mémoire du jour, chaque rechargement ramènerait sur le brief celui qui
     est en train de lire un rapport. On rejoue donc le geste réel — quitter le brief pour
     travailler ailleurs, puis recharger. */
  test('mais une seule fois par jour : on ne se fait plus ramener au brief', async () => {
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.reload();
    await page.waitForSelector('#tab-git.active');
    assert.equal(await page.locator('#tab-notes').isVisible(), false, 'le brief ne revient pas');
  });

  /* Et le réglage doit vraiment débrayer : on remet la date à zéro, mais l'option à '0'. */
  test('le réglage éteint l’atterrissage', async () => {
    await app.api('PUT', '/api/config', { brief_on_open: '0' });
    await page.evaluate(() => localStorage.removeItem('mergerie_brief_seen'));
    await page.reload();
    await page.waitForSelector('#tab-git.active');
    assert.equal(await page.locator('#tab-notes').isVisible(), false);
    await app.api('PUT', '/api/config', { brief_on_open: '1' });
  });

  /* La capture doit coûter deux secondes DEPUIS N'IMPORTE OÙ : c'est ce qui la rend
     préférable à un post-it. On la déclenche donc depuis un autre onglet. */
  test('la touche « n » capture une todo sans quitter l’onglet courant', async () => {
    await page.locator('nav button[data-tab="review"]').click();
    await page.waitForSelector('#tab-review.active');
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])');
    await page.locator('#captureTitle').fill('Vérifier le quota Redis');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#captureModal', { state: 'hidden' });

    // Aucune navigation : on était en train de faire autre chose.
    assert.equal(await page.locator('#tab-review').isVisible(), true, 'on reste où l’on était');
    const todos = (await app.api('GET', '/api/todos?status=open')).body.todos;
    assert.ok(todos.some((t) => t.title === 'Vérifier le quota Redis'), 'la todo existe côté serveur');
  });

  test('la touche est ignorée quand on est en train d’écrire', async () => {
    await page.locator('#searchReview').fill('');
    await page.locator('#searchReview').press('n');
    assert.equal(await page.locator('#captureModal').isHidden(), true,
      'un « n » tapé dans une recherche est une lettre, pas un raccourci');
    assert.equal(await page.locator('#searchReview').inputValue(), 'n');
    await page.locator('#searchReview').fill('');
  });

  test('cocher une todo depuis le brief la fait disparaître de la liste des ouvertes', async () => {
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.waitForSelector('#todoList .todo-row');
    const avant = await page.locator('#todoList .todo-row').count();
    await page.locator('#todoList .todo-check').first().check();
    await page.waitForFunction((n) => document.querySelectorAll('#todoList .todo-row').length === n - 1, avant);
    assert.equal(await page.locator('#todoList .todo-row').count(), avant - 1);

    // Elle n'est pas perdue pour autant : le filtre « Faites » la retrouve, barrée.
    await page.locator('#tab-notes [data-tfilter="done"]').click();
    await page.waitForSelector('#todoList .todo-row.done');
    assert.ok(await page.locator('#todoList .todo-row.done').count() >= 1);
    await page.locator('#tab-notes [data-tfilter="open"]').click();
  });

  /* Les deux pastilles du menu. Le rouge ne compte PAS que la priorité haute : une todo
     normale dont l'échéance est dépassée réclame autant, et c'est justement le retard qu'on
     vient d'oublier. Leur somme reste le nombre de todos à faire. */
  test('le menu porte le compte des todos, urgentes en rouge et le reste en bleu', async () => {
    for (const t of (await app.api('GET', '/api/todos?status=all')).body.todos) {
      await app.api('DELETE', `/api/todos/${t.id}`);
    }
    const hier = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await app.api('POST', '/api/todos', { title: 'haute sans date', priority: 'high' });
    await app.api('POST', '/api/todos', { title: 'normale en retard', due_at: hier });
    await app.api('POST', '/api/todos', { title: 'normale sans date' });
    await app.api('POST', '/api/todos', { title: 'basse', priority: 'low' });
    // Une todo FAITE ne compte nulle part : le badge annonce du travail en attente.
    const faite = await app.api('POST', '/api/todos', { title: 'déjà réglée', priority: 'high' });
    await app.api('PUT', `/api/todos/${faite.body.id}`, { status: 'done' });

    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#navTodoUrgent').hidden);
    assert.equal(await page.locator('#navTodoUrgent').innerText(), '2',
      'la haute ET la retardataire — pas seulement la priorité');
    assert.equal(await page.locator('#navCountNotes').innerText(), '2', 'la normale et la basse');
    assert.match(await page.locator('#navTodoUrgent').getAttribute('data-tip'),
      /retard.*priorité haute/, 'la bulle dit de quoi le chiffre est fait');

    /* Cocher doit faire redescendre le compte SANS attendre le poll : un badge qui ne
       redescend pas cesse d'être regardé. */
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.waitForSelector('#todoList .todo-row');
    await page.locator('#todoList .todo-row', { hasText: 'normale en retard' }).locator('.todo-check').check();
    await page.waitForFunction(() => document.querySelector('#navTodoUrgent').textContent === '1');
    assert.match(await page.locator('#navTodoUrgent').getAttribute('data-tip'), /priorité haute/);
    assert.doesNotMatch(await page.locator('#navTodoUrgent').getAttribute('data-tip'), /retard/,
      'la bulle ne garde pas une ligne devenue fausse');

    // Et quand il ne reste rien : les pastilles disparaissent au lieu d'afficher « 0 ».
    for (const t of (await app.api('GET', '/api/todos?status=open')).body.todos) {
      await app.api('PUT', `/api/todos/${t.id}`, { status: 'done' });
    }
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#navTodoUrgent').hidden
      && document.querySelector('#navCountNotes').hidden);
  });

  /* L'autolink n'a d'intérêt que s'il MÈNE quelque part : on clique la référence rendue et
     on vérifie qu'on arrive sur le rapport de la bonne merge request. */
  test('« !214 » dans une page devient un lien qui ouvre la merge request', async () => {
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    await page.waitForSelector('#pageList .note-item');
    await page.locator('#pageList .note-item').first().click();
    await page.waitForSelector('#pagePreview .note-link');

    const lien = page.locator('#pagePreview .note-link').first();
    assert.equal(await lien.innerText(), '!214');
    assert.equal(await lien.getAttribute('data-note-mr'), String(mrId),
      'un seul dépôt porte ce numéro : le lien vise directement la MR');
    await lien.click();
    await page.waitForSelector('#tab-review.active');
    assert.equal(await page.locator('#tab-review').isVisible(), true);
  });

  /* LE bug de perte de données. Le minuteur d'autosauvegarde relisait le DOM au moment de
     tirer : corriger un mot puis cliquer la page suivante dans la seconde écrivait le
     contenu de la NOUVELLE page dans l'ANCIENNE, sans trace pour la récupérer. */
  test('taper puis changer de page n’écrit pas le contenu de l’une dans l’autre', async () => {
    const a = (await app.api('POST', '/api/notes', { title: 'Page A' })).body;
    const b = (await app.api('POST', '/api/notes', { title: 'Page B' })).body;
    await app.api('PUT', `/api/notes/${b.id}`, { content: 'contenu propre à B' });

    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    const ligneA = page.locator('#pageList .note-item', { hasText: 'Page A' });
    await ligneA.waitFor();
    await ligneA.click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.id === id, a.id);

    // On tape dans A, puis on passe à B AVANT que la seconde d'autosauvegarde soit écoulée.
    await page.locator('#pageContent').fill('ce que j’ai écrit dans A');
    // L'indicateur confirme que la frappe est bien prise en compte, sans regarder le dedans.
    await page.waitForFunction(() => $('#pageSaved').textContent !== '');
    await page.locator('#pageList .note-item', { hasText: 'Page B' }).click();
    await page.waitForFunction(() => document.querySelector('#pageContent').value.includes('B'));
    await page.waitForTimeout(1500);   // largement au-delà du délai d'autosauvegarde

    const relueA = (await app.api('GET', `/api/notes/${a.id}`)).body;
    const relueB = (await app.api('GET', `/api/notes/${b.id}`)).body;
    assert.equal(relueA.title, 'Page A', 'le titre de B n’a pas été écrit dans A');
    assert.equal(relueA.content, 'ce que j’ai écrit dans A',
      'la frappe de A est enregistrée — la quitter ne doit ni la perdre ni la remplacer');
    assert.equal(relueB.content, 'contenu propre à B', 'et B n’a pas bougé');
  });

  /* Le crayon est rendu sous « Faites » et « Archivées » aussi. Ne chercher la todo que
     parmi les OUVERTES ouvrait une modale vide — et valider écrasait alors priorité, note
     et échéance par les valeurs par défaut du formulaire. */
  test('éditer une todo déjà faite ouvre ses vraies valeurs, pas un formulaire vide', async () => {
    const t = (await app.api('POST', '/api/todos', {
      title: 'réglée mais à relire', priority: 'high', note: 'contexte à conserver',
    })).body;
    await app.api('PUT', `/api/todos/${t.id}`, { status: 'done' });

    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.locator('#tab-notes [data-tfilter="done"]').click();
    const ligne = page.locator('#todoList .todo-row', { hasText: 'réglée mais à relire' });
    await ligne.waitFor();
    await ligne.locator('[data-todo-edit]').click();
    await page.waitForSelector('#captureModal:not([hidden])');

    assert.equal(await page.locator('#captureTitle').inputValue(), 'réglée mais à relire');
    assert.equal(await page.locator('#capturePriority').inputValue(), 'high', 'la priorité est là');
    assert.equal(await page.locator('#captureNote').inputValue(), 'contexte à conserver');

    // Et valider ne doit rien effacer de ce qu'on n'a pas touché.
    await page.locator('#captureTitle').fill('réglée, titre corrigé');
    await page.locator('#captureOk').click();
    await page.waitForSelector('#captureModal[hidden]', { state: 'attached' });
    const relue = (await app.api('GET', '/api/todos?status=done')).body.todos.find((x) => x.id === t.id);
    assert.equal(relue.title, 'réglée, titre corrigé');
    assert.equal(relue.priority, 'high', 'la priorité n’a pas été remise à « normale »');
    assert.equal(relue.note, 'contexte à conserver', 'la note n’a pas été effacée');
    await page.locator('#tab-notes [data-tfilter="open"]').click();
  });

  /* Une note de todo est l'endroit où l'on colle une adresse sans la relire : elle doit
     être cliquable, et ne mener QUE là où un lien a le droit de mener. */
  test('un lien collé dans la note d’une todo est cliquable', async () => {
    const t = (await app.api('POST', '/api/todos', {
      title: 'suivre la doc du PSP',
      note: 'barème ici https://psp.test/tarifs?v=2&plan=pro — et javascript:alert(1) ne doit rien ouvrir',
    })).body;

    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.locator('#tab-notes [data-tfilter="open"]').click();
    const ligne = page.locator('#todoList .todo-row', { hasText: 'suivre la doc du PSP' });
    await ligne.waitFor();

    const liens = await ligne.locator('.todo-note a').evaluateAll((els) => els.map((e) => ({
      href: e.getAttribute('href'), cible: e.getAttribute('target'), rel: e.getAttribute('rel'),
    })));
    assert.equal(liens.length, 1, 'seule l’adresse http(s) devient un lien');
    assert.equal(liens[0].href, 'https://psp.test/tarifs?v=2&plan=pro',
      'l’URL est rendue entière, paramètres compris');
    assert.equal(liens[0].cible, '_blank');
    assert.match(liens[0].rel, /noopener/);
    assert.match(await ligne.locator('.todo-note').innerText(), /javascript:alert\(1\)/,
      'le protocole dangereux reste du texte, visible tel quel');

    await app.api('DELETE', `/api/todos/${t.id}`);
  });

  /* Le rendu échappe AVANT d'autolinker : rien de ce qu'on écrit dans une note ne peut
     devenir du balisage. C'est la garantie que la section Sécurité du guide annonce. */
  test('une note ne peut pas injecter de HTML', async () => {
    const p = (await app.api('POST', '/api/notes', { title: 'Essai' })).body;
    await app.api('PUT', `/api/notes/${p.id}`, { content: '<img src=x onerror="window.__xss=1"> et !214' });
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    const ligne = page.locator('#pageList .note-item', { hasText: 'Essai' });
    await ligne.waitFor();
    await ligne.click();
    await page.waitForFunction(() => /<img src=x/.test(document.querySelector('#pagePreview').innerText));
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'aucun script exécuté');
    assert.equal(await page.locator('#pagePreview img').count(), 0, 'aucune balise reconstituée');
    assert.match(await page.locator('#pagePreview').innerText(), /<img src=x/, 'le texte s’affiche tel quel');
    assert.equal(await page.locator('#pagePreview .note-link').count(), 1, '…et l’autolink fonctionne quand même');
  });

  /* Les chiffres du clavier DOIVENT suivre la barre, dans l'ordre où elle est affichée.
     C'est exactement ce qui se désynchronise à un réordonnancement : le raccourci lisait
     autrefois une liste recopiée à côté du HTML, et un décalage n'aurait rien signalé —
     « 3 » aurait ouvert un autre onglet que le troisième, en silence. */
  test('les chiffres ouvrent les onglets dans l’ordre de la barre', async () => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab]');
    const barre = await page.locator('nav button[data-tab]').evaluateAll(
      (els) => els.map((e) => e.dataset.tab),
    );
    assert.equal(barre.length, 10);
    assert.deepEqual(barre, ['review', 'task', 'notes', 'jira', 'git', 'docker', 'jenkins', 'links', 'dashboard', 'admin'],
      'le cœur · ce que j’ai à faire · ma machine, son intégration et ses liens · le méta');

    for (let i = 0; i < barre.length; i += 1) {
      await page.locator('body').click();          // le focus quitte tout champ de saisie
      // Faute de touche « 10 », le dixième onglet est sur « 0 » — la convention des navigateurs.
      await page.keyboard.press(i === 9 ? '0' : String(i + 1));
      await page.waitForSelector(`#tab-${barre[i]}.active`);
      assert.equal(await page.locator(`#tab-${barre[i]}`).isVisible(), true,
        `la touche ${i === 9 ? '0' : i + 1} doit ouvrir le ${i + 1}ᵉ onglet de la barre (${barre[i]})`);
    }

    // Et la feuille d'aide annonce la plage réelle, pas un « 1 – 8 » recopié une fois de plus.
    await page.keyboard.press('?');
    await page.waitForSelector('#shortcutsModal:not([hidden])');
    assert.match(await page.locator('#shortcutsList').innerText(), /1 – 9, 0/,
      'la plage annoncée suit le nombre réel d’onglets, touche « 0 » comprise');
    await page.locator('#shortcutsClose').click();
  });

  /* ÉCARTER une ligne du brief, à la souris. La croix vit DANS une ligne cliquable — celle
     d'une MR ouvre son rapport : si l'ordre des gestes est mal câblé, écarter ouvre en même
     temps le rapport de ce qu'on vient de vouloir ne plus voir. Ça ne se prouve qu'au clic. */
  test('la croix écarte la ligne sans ouvrir ce qu’elle porte', async () => {
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
    await page.waitForSelector('#briefBox .brief-item [data-brief-hide^="mr:"]');

    const ligne = page.locator('#briefBox .brief-item').filter({ has: page.locator('[data-brief-hide^="mr:"]') }).first();
    const titre = await ligne.locator('.brief-item-title').textContent();
    await ligne.locator('[data-brief-hide]').click();

    await page.waitForSelector('#briefRestore');
    assert.equal(await page.locator('#splitView').isHidden(), true,
      'écarter n’ouvre rien : la croix est dans une ligne cliquable, elle doit passer avant');
    assert.ok(!(await page.locator('#briefBox').textContent()).includes(titre.trim()),
      'la ligne écartée disparaît sans recharger la page');

    // Et le pied de brief la ramène : rien n'a été supprimé.
    await page.locator('#briefRestore').click();
    await page.waitForFunction((t) => document.querySelector('#briefBox').textContent.includes(t), titre.trim());
    assert.equal(await page.locator('#briefRestore').count(), 0, 'plus rien de caché, plus de pied');
  });

  /* RÉORDONNER À LA MAIN. Deux gestes pour le même résultat, et c'est délibéré : le
     glisser-déposer pour la souris, deux flèches pour le clavier et le tactile — où « glisser »
     n'est ni annonçable ni fiable. On éprouve les flèches, qui sont le chemin garanti. */
  test('les flèches réordonnent la liste, et l’ordre survit au rechargement', async () => {
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    // On pose nos propres todos : la liste laissée par les tests précédents peut être vide.
    for (const t of ['zzz-une', 'zzz-deux']) await page.evaluate(async (titre) => {
      await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: titre }) });
    }, t);
    await page.evaluate(() => window.loadTodos());
    await page.waitForFunction(() => /zzz-deux/.test(document.querySelector('#todoList .todo-row').textContent));

    const titres = () => page.locator('#todoList .brief-item-title').allTextContents();
    const avant = await titres();
    assert.equal(avant[0], 'zzz-deux', 'une todo neuve arrive en tête, là où on vient de la taper');

    await page.locator('#todoList .todo-row [data-todo-down]').first().click();
    await page.waitForFunction((t) => document.querySelectorAll('#todoList .brief-item-title')[1].textContent === t, 'zzz-deux');
    assert.deepEqual((await titres()).slice(0, 2), ['zzz-une', 'zzz-deux']);

    // L'ordre est ENREGISTRÉ, pas seulement déplacé à l'écran.
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.waitForSelector('#todoList .todo-row');
    assert.deepEqual((await titres()).slice(0, 2), ['zzz-une', 'zzz-deux'],
      'un ordre qui ne survit pas au rechargement n’est pas un ordre');

    // La première ligne ne peut pas monter, la dernière ne peut pas descendre.
    assert.equal(await page.locator('#todoList .todo-row [data-todo-up]').first().isDisabled(), true);
    assert.equal(await page.locator('#todoList .todo-row [data-todo-down]').last().isDisabled(), true);
  });

  /* Les faites et les archivées ont un ordre chronologique qui leur est propre : les arranger
     à la main n'aurait aucun sens, et les poignées y seraient un piège. */
  test('la vue « faites » ne se réordonne pas', async () => {
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.waitForSelector('#todoList .todo-row');
    await page.locator('#todoList .todo-check').first().check();
    await page.waitForTimeout(200);
    await page.locator('.todo-filter [data-tfilter="done"]').click();
    await page.waitForSelector('#todoList .todo-row');
    assert.equal(await page.locator('#todoList [data-todo-up]').count(), 0);
    assert.equal(await page.locator('#todoList .todo-grip').count(), 0);
    await page.locator('.todo-filter [data-tfilter="open"]').click();
  });

  /* Les deux thèmes existent : une couleur codée en dur se voit ici, pas à la relecture. */
  test('les deux thèmes restent lisibles', async () => {
    await app.api('POST', '/api/todos', { title: 'à regarder dans les deux thèmes', priority: 'high' });
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
      await page.waitForSelector('#todoList .todo-row');
      const couleurs = await page.locator('#todoList .todo-row').first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { fond: cs.backgroundColor, texte: getComputedStyle(el.querySelector('.brief-item-title')).color };
      });
      assert.notEqual(couleurs.fond, couleurs.texte, `thème ${theme} : le texte ne se confond pas avec le fond`);
      assert.doesNotMatch(couleurs.texte, /rgba?\(0, 0, 0, 0\)/, `thème ${theme} : le texte a une couleur`);
    }
  });
});
