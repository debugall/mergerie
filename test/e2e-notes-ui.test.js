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
const { startApp, afficherMenusOptionnels } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

/* Attend qu'une condition côté SERVEUR devienne vraie. Un délai fixe est un pari sur la
   vitesse de la machine : il tient en local et lâche sur un runner à deux cœurs. */
async function attendreServeur(cond, quoi, ms = 15000) {
  const fin = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > fin) throw new Error(`délai dépassé : ${quoi}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
    await afficherMenusOptionnels(page);
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
    /* `click()` et non `check()` : cocher fait DISPARAÎTRE la ligne (la liste « à faire » se
       recharge sans elle). `check()`, lui, relit la case après le clic pour confirmer qu'elle
       est cochée — sur une machine lente, le re-rendu passe avant cette relecture, la case
       n'existe plus, et Playwright attend une ligne partie jusqu'au bout de son délai. Le
       défaut n'était pas dans l'application : c'est l'effet qu'on veut vérifier, et il est
       vérifié juste en dessous. */
    await page.locator('#todoList .todo-check').first().click();
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
    // Cocher retire la ligne de « à faire » : on clique, puis on vérifie l'EFFET (cf. plus haut).
    const enRetard = page.locator('#todoList .todo-row', { hasText: 'normale en retard' });
    await enRetard.locator('.todo-check').click();
    await enRetard.waitFor({ state: 'detached' });
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
    /* On attend que la sauvegarde en attente ait VRAIMENT tiré — c'est tout l'objet du test :
       elle doit écrire dans A, pas dans B. Interroger la base bat un délai « largement
       suffisant », qui ne l'est plus sur une machine chargée. */
    await attendreServeur(async () => {
      const p2 = (await app.api('GET', `/api/notes/${a.id}`)).body;
      return /écrit dans A/.test(p2.content || '');
    }, 'la page A a reçu sa sauvegarde');

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
    assert.equal(barre.length, 11);
    assert.deepEqual(barre, ['review', 'task', 'agents', 'notes', 'jira', 'git', 'docker', 'jenkins', 'links', 'dashboard', 'admin'],
      'le cœur · ce que j’ai à faire · ma machine, son intégration et ses liens · le méta');

    /* Les neuf premiers sur leur chiffre ; le DERNIER sur « 0 », faute de touche « 10 » — et
       c'est bien le dernier, pas le dixième : sinon un onglet ajouté retirerait en silence
       son raccourci à Réglages, qui ferme la barre. Les onglets du milieu au-delà du neuvième
       n'ont pas de chiffre, et la feuille d'aide annonce « 1 – 9, 0 ». */
    const avecTouche = [...barre.slice(0, 9).map((tab, i) => [String(i + 1), tab]), ['0', barre[barre.length - 1]]];
    for (const [touche, tab] of avecTouche) {
      /* LE FOCUS QUITTE TOUT CHAMP — mais PAS en cliquant `body` : Playwright clique le CENTRE
         de l'élément, et le centre de la page est la zone de texte de la note ouverte. On
         focalisait donc le champ qu'on voulait quitter, et les chiffres s'écrivaient dedans au
         lieu d'ouvrir les onglets. Depuis que les objets ont une adresse (`#/notes/4`), un
         rechargement rouvre la page et ce centre-là est toujours une zone de texte. */
      await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
      await page.keyboard.press(touche);
      await page.waitForSelector(`#tab-${tab}.active`);
      assert.equal(await page.locator(`#tab-${tab}`).isVisible(), true,
        `la touche ${touche} doit ouvrir l’onglet ${tab}`);
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

  /* LA PRIORITÉ PASSE DEVANT. On ne réordonne donc qu'à l'intérieur d'un groupe : emmener une
     todo dans un autre groupe la ferait revenir aussitôt, et un geste qui n'aboutit pas est
     pire que pas de geste — les flèches s'éteignent aux frontières. */
  test('une haute reste en tête, et les flèches ne traversent pas les priorités', async () => {
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.evaluate(async () => {
      await fetch('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'zzz-haute', priority: 'high' }) });
    });
    await page.evaluate(() => window.loadTodos());
    await page.waitForFunction(() => /zzz-haute/.test(document.querySelector('#todoList .todo-row').textContent));

    const premiere = page.locator('#todoList .todo-row').first();
    assert.equal(await premiere.getAttribute('data-prio'), 'high',
      'placée en dernier ou non, une haute reste en tête : la priorité dit ce qui presse');
    assert.equal(await premiere.locator('[data-todo-down]').isDisabled(), true,
      'seule de son groupe : elle n’a nulle part où descendre');

    // La première du groupe suivant ne peut pas remonter dans le groupe des hautes.
    const suivante = page.locator('#todoList .todo-row').nth(1);
    assert.equal(await suivante.locator('[data-todo-up]').isDisabled(), true);
  });

  /* Les faites et les archivées ont un ordre chronologique qui leur est propre : les arranger
     à la main n'aurait aucun sens, et les poignées y seraient un piège. */
  test('la vue « faites » ne se réordonne pas', async () => {
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.waitForSelector('#todoList .todo-row');
    const ouvertes = await page.locator('#todoList .todo-row').count();
    await page.locator('#todoList .todo-check').first().click();
    // Attendre l'effet plutôt qu'un délai : sur une machine lente, 200 ms ne suffisent pas.
    await page.waitForFunction((n) => document.querySelectorAll('#todoList .todo-row').length === n - 1, ouvertes);
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

  /* LIRE ET ÉCRIRE NE SE FONT PAS EN MÊME TEMPS. Deux demi-colonnes coupaient les deux : un
     tableau de doc débordait de l'aperçu, une ligne de Markdown revenait à la ligne au milieu
     d'un lien. Le défaut est la LECTURE — on relit ses notes bien plus souvent qu'on ne les
     écrit — sauf sur une page vide, qui n'a rien à montrer. */
  test('les colonnes se choisissent : rendu seul par défaut, Markdown seul, ou les deux', async () => {
    const p = (await app.api('POST', '/api/notes', { title: 'Page à lire' })).body;
    await app.api('PUT', `/api/notes/${p.id}`, { content: '# Titre\n\nDu texte déjà écrit.' });

    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    const ligne = page.locator('#pageList .note-item', { hasText: 'Page à lire' });
    await ligne.waitFor();
    await ligne.click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.id === id, p.id);

    const visible = async (sel) => page.locator(sel).isVisible();
    assert.equal(await visible('#pagePreview'), true, 'une page écrite s’ouvre sur son rendu');
    assert.equal(await visible('#pageContent'), false, 'l’éditeur est masqué par défaut');
    // …et le rendu prend toute la largeur, pas la moitié qu'il occupait à deux colonnes.
    const largeurRendu = await page.locator('#pagePreview').evaluate((e) => e.getBoundingClientRect().width);
    const largeurBloc = await page.locator('.note-panes').evaluate((e) => e.getBoundingClientRect().width);
    assert.ok(largeurRendu > largeurBloc * 0.9, `le rendu n’occupe pas les deux colonnes : ${largeurRendu} / ${largeurBloc}`);

    await page.locator('.note-panes-pick [data-panes="editor"]').click();
    assert.equal(await visible('#pageContent'), true);
    assert.equal(await visible('#pagePreview'), false, 'le rendu se masque à son tour');
    const largeurEditeur = await page.locator('#pageContent').evaluate((e) => e.getBoundingClientRect().width);
    assert.ok(largeurEditeur > largeurBloc * 0.9, `l’éditeur n’occupe pas les deux colonnes : ${largeurEditeur}`);

    await page.locator('.note-panes-pick [data-panes="both"]').click();
    assert.equal(await visible('#pageContent'), true);
    assert.equal(await visible('#pagePreview'), true);

    /* LE CHOIX SURVIT AU CHANGEMENT DE PAGE. Le re-choisir à chaque page en ferait un réglage
       qu'on subit plutôt qu'un réglage qu'on pose. */
    const q = (await app.api('POST', '/api/notes', { title: 'Une autre' })).body;
    await app.api('PUT', `/api/notes/${q.id}`, { content: 'du contenu' });
    await page.locator('#pageSearch').fill('Une autre');
    const l2 = page.locator('#pageList .note-item', { hasText: 'Une autre' });
    await l2.waitFor();
    await l2.click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.id === id, q.id);
    assert.equal(await visible('#pageContent'), true, 'le choix des colonnes est retenu');
    await page.locator('.note-panes-pick [data-panes="preview"]').click();
    await page.locator('#pageSearch').fill('');
  });

  /* UNE PAGE VIDE N'A RIEN À MONTRER : servir un aperçu blanc à qui vient de créer une page
     est un cul-de-sac — rien à lire, et pas de champ où écrire. */
  test('une page neuve s’ouvre sur le Markdown, même quand le réglage dit « rendu »', async () => {
    const vide = (await app.api('POST', '/api/notes', { title: 'Toute neuve' })).body;
    await page.locator('#pageSearch').fill('Toute neuve');
    const l = page.locator('#pageList .note-item', { hasText: 'Toute neuve' });
    await l.waitFor();
    await l.click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.id === id, vide.id);
    assert.equal(await page.locator('#pageContent').isVisible(), true);
    await page.locator('#pageSearch').fill('');
  });

  /* LES SOUS-PAGES. Une documentation tient rarement en une page ; listée à plat, entre deux
     pages sans rapport, une sous-page perd ce qui fait sa valeur — on ne sait plus de quoi
     elle est le détail. */
  test('une sous-page se crée depuis sa page, s’affiche décalée sous elle, et mène à son parent', async () => {
    const racine = (await app.api('POST', '/api/notes', { title: 'Carte des services' })).body;
    await app.api('PUT', `/api/notes/${racine.id}`, { content: 'le texte général' });
    await page.locator('#pageSearch').fill('Carte des services');
    const l = page.locator('#pageList .note-item', { hasText: 'Carte des services' });
    await l.waitFor();
    await l.click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.id === id, racine.id);

    await page.locator('#pageNewSub').click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.parent_id === id, racine.id);
    // Une sous-page ne peut pas en contenir : le bouton n'est même pas proposé.
    assert.equal(await page.locator('#pageNewSub').count(), 0, 'le geste est refusé AVANT le serveur');
    await page.locator('#pageTitle').fill('groupe/api-core');
    await attendreServeur(async () => (await app.api('GET', '/api/notes')).body.pages
      .some((x) => x.title === 'groupe/api-core'), 'le titre de la sous-page est enregistré');

    /* LA SOUS-PAGE OUVERTE RESTE VISIBLE : son parent se déplie tout seul, sinon la page
       active serait absente de la colonne où on vient de la choisir. */
    await page.locator('#pageSearch').fill('');
    await page.waitForSelector(`#pageList [data-fold="${racine.id}"]`);
    assert.equal(await page.locator('#pageList .note-item.note-sub').count(), 1,
      'la sous-page ouverte a disparu de la colonne');

    /* …et le pli REVIENT dès qu'on s'en va. Une colonne où chaque page générale déroule ses
       huit sous-pages ne se lit plus : on vient d'abord y chercher une page, pas un détail. */
    await page.locator('#pageList .note-item', { hasText: 'Carte des services' }).first().click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.id === id, racine.id);
    assert.equal(await page.locator('#pageList .note-item.note-sub').count(), 0,
      'les sous-pages sont dépliées d’office');
    // …et le repli ne les rend pas invisibles : le nombre est sur la page générale.
    const ligneRacine = page.locator('#pageList .note-row', { hasText: 'Carte des services' }).first();
    assert.equal(await ligneRacine.locator('.note-item-count').innerText(), '1');

    await page.locator(`#pageList [data-fold="${racine.id}"]`).click();
    await page.waitForSelector('#pageList .note-item.note-sub');
    const sub = page.locator('#pageList .note-item.note-sub', { hasText: 'groupe/api-core' });
    assert.equal(await sub.count(), 1, 'la sous-page est décalée sous son parent');
    // Et le pli se referme.
    await page.locator(`#pageList [data-fold="${racine.id}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#pageList .note-item.note-sub').length === 0);
    await page.locator(`#pageList [data-fold="${racine.id}"]`).click();
    await page.waitForSelector('#pageList .note-item.note-sub');
    /* LE DÉCALAGE SE MESURE. Une sous-page n'a pas de dépliant : sans décalage explicite son
       titre retombait À GAUCHE de celui de son parent — l'indentation valait zéro, et rien à
       l'écran ne disait le rattachement. C'est un chiffre, donc c'est vérifiable. */
    const x = await page.evaluate(() => {
      const par = document.querySelector('#pageList .note-row:not(.note-sub) .note-item-title');
      const sub = document.querySelector('#pageList .note-row.note-sub .note-item-title');
      return { parent: par.getBoundingClientRect().left, sous: sub.getBoundingClientRect().left };
    });
    assert.ok(x.sous - x.parent >= 12, `la sous-page n’est pas décalée : ${x.sous - x.parent}px`);

    /* …SANS déborder de la colonne. `width: 100%` plus une marge dépasse, quel que soit le
       `box-sizing` : la colonne ouvrait un défilement horizontal et rognait les titres des
       pages voisines — un décalage de 14 pixels qui abîme tout l'écran. */
    const deborde = await page.locator('#pageList').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(deborde, false, 'la colonne des pages défile horizontalement');

    // Elle dit de quoi elle est le détail, et le lien y ramène.
    await sub.click();
    await page.waitForFunction(() => NOTES.page && NOTES.page.parent_id);
    assert.match(await page.locator('.note-parent').innerText(), /Carte des services/);
    await page.locator('.note-parent .lien-page').click();
    await page.waitForFunction((id) => NOTES.page && NOTES.page.id === id, racine.id);
    assert.match(await page.locator('.note-children').innerText(), /groupe\/api-core/,
      'et la page générale annonce ce qu’elle chapeaute');
  });
});
