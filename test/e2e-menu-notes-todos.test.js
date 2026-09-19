'use strict';
/* MENU NOTES → TODOS, dans un VRAI navigateur.
 *
 * Ce que les fichiers existants ne pilotaient pas par l'écran : les listes vides des trois
 * filtres, la barre d'ajout (bouton, Entrée, champ vide) et la syntaxe courte qu'elle annonce,
 * la capture détaillée (priorité, échéances rapides, note, priorité retenue, Échap), l'édition
 * d'une todo ouverte, les reports « +1 h » / « Demain 9 h » dans la liste, rouvrir une todo
 * faite, le tiroir des archivées, la suppression (annulée puis confirmée), le glisser-déposer,
 * `j`/`k` et `/` au clavier, « Faire faire cette todo » (modale de session pré-remplie), les
 * liens d'une todo vers ce qu'elle suit (MR, ticket, vérification, build, branche, conteneur),
 * et le partage d'une todo quand on travaille à plusieurs.
 *
 * Déjà couvert ailleurs par l'écran : la capture « n » depuis un autre onglet, cocher, les
 * flèches de réordonnancement, les pastilles du menu, éditer une todo FAITE, le lien dans une
 * note (e2e-notes-ui) ; la syntaxe de la capture « n » (e2e-ameliorations) ; le filtre retenu
 * et « demain 9 h » dans la capture (e2e-ameliorations-2).
 *
 * Un seul `startApp()` ; rien de `src/` n'est chargé en tête de fichier. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();


describe('Menu Notes · Todos', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];
  let repoId; let mrId; let verifId;

  const todos = async (status = 'open') => (await app.api('GET', `/api/todos?status=${status}`)).body.todos || [];
  const todoParTitre = async (t, status = 'all') => (await todos(status)).find((x) => x.title === t);
  const creer = async (body) => {
    const r = await app.api('POST', '/api/todos', body);
    assert.equal(r.status, 200, r.text);
    return r.body;
  };
  /* Nettoie les todos entre deux tests : chaque test part d'une liste connue. Les identifiants
     sont RÉUTILISÉS après un DELETE : l'écran garde en mémoire les todos ouvertes de la page
     précédente, on recharge donc la page pour qu'aucune ne porte l'id d'une todo effacée. */
  const viderTodos = async () => {
    app.db.prepare('DELETE FROM todo').run();
    await page.reload();
  };

  before(async () => {
    app = await startApp();
    app.state.mrs['grp/app'] = [{
      iid: 214, title: 'PROJ-42 ajoute le panier', state: 'opened',
      source_branch: 'feature/PROJ-42', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/214',
      sha: 'abc123', created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'abc123' },
    }];
    // Un ticket à MOI, que l'onglet Jira sélectionne d'office en arrivant ; celui de la todo, lui, ne l'est pas.
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
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app.git', project: 'grp/app' });
    await app.api('POST', '/api/discover');
    mrId = app.db.prepare('SELECT id FROM mr WHERE iid = 214').get().id;
    repoId = app.db.prepare("SELECT id FROM repo WHERE project = 'grp/app'").get().id;
    verifId = app.db.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, finished_at, created_at)
      VALUES ('Tests d’intégration', 'done', 'verified_fail', ?, datetime('now'), datetime('now'))`)
      .run(JSON.stringify([{ mr_id: mrId, repo_id: repoId, branch: 'feature/PROJ-42' }])).lastInsertRowid;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    // Les liens de todo mènent à Git, Jenkins et Docker : trois menus repliés par défaut.
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  // Notes → Todos, sur le filtre demandé, la liste RECHARGÉE depuis le serveur.
  const allerTodos = async (filtre = 'open') => {
    await fermerModales();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.waitForSelector('#notesSubTodos:not([hidden])');
    await page.locator(`#tab-notes [data-tfilter="${filtre}"]`).click();
    await page.waitForFunction((f) => document.querySelector(`#tab-notes [data-tfilter="${f}"]`).classList.contains('active'), filtre);
  };
  const ligne = (titre) => page.locator('#todoList .todo-row', { hasText: titre });
  const attendreLignes = (n) => page.waitForFunction((k) => document.querySelectorAll('#todoList .todo-row').length === k, n);

  test('les trois filtres vides disent chacun ce qu’ils rangent', async () => {
    await viderTodos();
    await allerTodos('open');
    await page.waitForFunction(() => /Aucune todo/.test(document.querySelector('#todoList').textContent)
      && /appuie sur « n »/.test(document.querySelector('#todoList').textContent));
    await allerTodos('done');
    await page.waitForFunction(() => /Rien de fait ces derniers jours/.test(document.querySelector('#todoList').textContent));
    await allerTodos('archived');
    await page.waitForFunction(() => /Le tiroir est vide/.test(document.querySelector('#todoList').textContent));
    await allerTodos('open');
  });

  test('la barre d’ajout crée au bouton et à Entrée, se vide, et le compte suit', async () => {
    await viderTodos();
    await allerTodos('open');
    await page.locator('#todoQuickAdd').fill('Relire la PR du cache');
    await page.locator('#todoQuickBtn').click();
    await attendreServeur(async () => Boolean(await todoParTitre('Relire la PR du cache', 'open')), 'créée au bouton');
    await page.waitForFunction(() => document.querySelector('#todoQuickAdd').value === '');

    await page.locator('#todoQuickAdd').fill('Préparer la démo');
    await page.locator('#todoQuickAdd').press('Enter');
    await attendreServeur(async () => Boolean(await todoParTitre('Préparer la démo', 'open')), 'créée à Entrée');
    await attendreLignes(2);
    assert.equal(await page.locator('#todoInfo').innerText(), '2 todos');
    await page.waitForFunction(() => document.querySelector('#notesTodoCount').textContent === '2' && !document.querySelector('#notesTodoCount').hidden);
    const creee = await todoParTitre('Préparer la démo', 'open');
    assert.equal(creee.priority, 'normal');
    assert.equal(creee.due_at, null);

    // Un champ vide ne crée rien.
    await page.locator('#todoQuickAdd').fill('   ');
    await page.locator('#todoQuickBtn').click();
    await page.locator('#todoQuickAdd').press('Enter');
    assert.equal((await todos('open')).length, 2);
  });

  /* La barre d'ajout ANNONCE la syntaxe courte (« Astuce : !217 lie à une MR, PROJ-42 à un
     ticket, @demain pose l'échéance, !! la priorité haute ») et le CHANGELOG dit « the short
     syntax finally written under the add bar ». Mais `todoQuickAdd` (public/app.js) envoie le
     titre BRUT : seule la capture « n » passe par `lireCaptureCourte`. */
  test('la barre d’ajout comprend la syntaxe courte qu’elle affiche', async () => {
    await viderTodos();
    await allerTodos('open');
    assert.match(await page.locator('#notesSubTodos .todo-syntaxe').textContent(), /!!(<\/code>)? la priorité haute/);
    await page.locator('#todoQuickAdd').fill('Relancer la plateforme @demain !!');
    await page.locator('#todoQuickAdd').press('Enter');
    await attendreServeur(async () => (await todos('open')).length === 1, 'la todo est créée');
    const t = (await todos('open'))[0];
    assert.equal(t.title, 'Relancer la plateforme', 'la syntaxe sort du titre');
    assert.equal(t.priority, 'high');
    assert.ok(t.due_at, 'l’échéance est posée');
  });

  /* L'astuce est écrite avec des `<code>` dans la traduction, mais l'élément porte
     `data-i18n` (texte) et non `data-i18n-html` : le balisage s'affiche tel quel, « Astuce :
     <code>!217</code> lie à une MR… », au lieu de quatre extraits de code. */
  test('l’astuce de syntaxe s’affiche en code, pas en balises brutes', async () => {
    await allerTodos('open');
    const astuce = page.locator('#notesSubTodos .todo-syntaxe');
    assert.doesNotMatch(await astuce.innerText(), /<code>/, 'aucune balise visible');
    assert.equal(await astuce.locator('code').count(), 4, '!217, PROJ-42, @demain et !! en code');
  });

  test('la capture détaillée : priorité, échéances rapides, note — et la priorité est retenue', async () => {
    await viderTodos();
    await allerTodos('open');
    await page.locator('#todoQuickAdd').blur();
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])');
    assert.equal(await page.locator('#captureDetails').isHidden(), true, 'les détails sont repliés');
    await page.locator('#captureMore').click();
    await page.waitForSelector('#captureDetails:not([hidden])');
    assert.equal(await page.locator('#captureMore').innerText(), '− détails');

    await page.locator('#captureTitle').fill('Migrer les logs');
    await page.locator('#capturePriority').selectOption('high');
    await page.locator('[data-due-quick="lundi"]').click();
    const lundi = await page.locator('#captureDue').inputValue();
    assert.match(lundi, /T09:00$/);
    assert.equal(new Date(lundi).getDay(), 1, '« lundi 9 h » tombe un lundi');
    await page.locator('[data-due-quick="1h"]').click();
    const dansUneHeure = new Date(await page.locator('#captureDue').inputValue()).getTime();
    assert.ok(Math.abs(dansUneHeure - (Date.now() + 3600e3)) < 5 * 60e3, '« +1 h » vise dans une heure');
    await page.locator('[data-due-quick=""]').click();
    assert.equal(await page.locator('#captureDue').inputValue(), '', '« effacer » vide l’échéance');
    await page.locator('[data-due-quick="lundi"]').click();
    await page.locator('#captureNote').fill('voir avec l’équipe infra');
    await page.locator('#captureOk').click();
    await page.waitForSelector('#captureModal', { state: 'hidden' });

    await attendreServeur(async () => Boolean(await todoParTitre('Migrer les logs', 'open')), 'la todo est créée');
    const t = await todoParTitre('Migrer les logs', 'open');
    assert.equal(t.priority, 'high');
    assert.equal(t.note, 'voir avec l’équipe infra');
    assert.equal(new Date(t.due_at).getDay(), 1);
    assert.equal(new Date(t.due_at).getHours(), 9);
    await attendreLignes(1);
    assert.match(await ligne('Migrer les logs').innerText(), /Haute/);

    // La prochaine capture repart de la dernière priorité CHOISIE.
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])');
    assert.equal(await page.locator('#capturePriority').inputValue(), 'high');
    // Échap annule : rien n'est créé.
    await page.locator('#captureTitle').fill('ne sera pas créée');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#captureModal', { state: 'hidden' });
    assert.equal(await todoParTitre('ne sera pas créée'), undefined);
    // « Annuler » aussi. (Le focus quitte le champ masqué au rendu suivant : voir le test d'après.)
    await page.waitForFunction(() => !document.activeElement || document.activeElement.id !== 'captureTitle');
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])');
    await page.locator('#captureTitle').fill('toujours pas');
    await page.locator('#captureCancel').click();
    await page.waitForSelector('#captureModal', { state: 'hidden' });
    assert.equal(await todoParTitre('toujours pas'), undefined);
  });

  /* Échap masque la capture sans passer par « Annuler » : le focus reste un instant dans le
     champ masqué, jusqu'à ce que le navigateur l'en sorte au rendu suivant. On attend CET
     effet — la touche pressée dans la même milliseconde serait une lettre, pas un raccourci. */
  test('après Échap, « n » rouvre la capture', async () => {
    await allerTodos('open');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])');
    await page.locator('#captureTitle').fill('une idée');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#captureModal', { state: 'hidden' });
    await page.waitForFunction(() => !document.activeElement || document.activeElement.id !== 'captureTitle');
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])');
    assert.equal(await page.locator('#captureTitle').inputValue(), '', 'une capture neuve, pas la précédente');
    await page.locator('#captureCancel').click();
    await page.waitForSelector('#captureModal', { state: 'hidden' });
  });

  test('le crayon édite une todo ouverte : le formulaire s’ouvre déplié, sur ses valeurs', async () => {
    await viderTodos();
    await creer({ title: 'Écrire la doc du SDK', priority: 'low', note: 'section paiement' });
    await allerTodos('open');
    await attendreLignes(1);
    await ligne('Écrire la doc du SDK').locator('[data-todo-edit]').click();
    await page.waitForSelector('#captureModal:not([hidden])');
    assert.equal(await page.locator('#captureDetails').isHidden(), false, 'déplié : on vient changer un détail');
    assert.equal(await page.locator('#captureTitle').inputValue(), 'Écrire la doc du SDK');
    assert.equal(await page.locator('#capturePriority').inputValue(), 'low');
    assert.equal(await page.locator('#captureNote').inputValue(), 'section paiement');

    await page.locator('#captureTitle').fill('Écrire la doc du SDK v2');
    await page.locator('#capturePriority').selectOption('normal');
    await page.locator('[data-due-quick="demain"]').click();
    await page.locator('#captureOk').click();
    await page.waitForSelector('#captureModal', { state: 'hidden' });
    await attendreServeur(async () => Boolean(await todoParTitre('Écrire la doc du SDK v2', 'open')), 'modifiée côté serveur');
    const t = await todoParTitre('Écrire la doc du SDK v2', 'open');
    assert.equal(t.priority, 'normal');
    assert.equal(t.note, 'section paiement', 'la note est conservée');
    assert.ok(t.due_at);
    assert.equal((await todos('open')).length, 1, 'éditer ne crée pas de doublon');
  });

  test('« +1 h » et « Demain 9 h » repoussent l’échéance depuis la liste', async () => {
    await viderTodos();
    const t = await creer({ title: 'Rappeler le support', due_at: new Date(Date.now() - 2 * 3600e3).toISOString() });
    await allerTodos('open');
    await attendreLignes(1);
    assert.match(await ligne('Rappeler le support').innerText(), /échu|en retard/);
    await ligne('Rappeler le support').locator('[data-snooze="hour"]').click();
    await attendreServeur(async () => {
      const x = await todoParTitre('Rappeler le support', 'open');
      return x && new Date(x.due_at).getTime() > Date.now() + 50 * 60e3;
    }, '+1 h : l’échéance est dans une heure');
    await page.waitForFunction(() => /aujourd’hui|demain/.test((document.querySelector('#todoList .todo-row') || {}).textContent));

    await ligne('Rappeler le support').locator('[data-snooze="tomorrow"]').click();
    await attendreServeur(async () => {
      const x = await todoParTitre('Rappeler le support', 'open');
      const d = new Date(x.due_at);
      const demain = new Date(); demain.setDate(demain.getDate() + 1);
      return d.getHours() === 9 && d.getDate() === demain.getDate();
    }, 'demain 9 h');
    await page.waitForFunction(() => /demain 09:00|demain 9/.test((document.querySelector('#todoList .todo-row') || {}).textContent));
    assert.equal(t.id, (await todoParTitre('Rappeler le support', 'open')).id);
  });

  test('décocher une todo faite la rouvre, et elle quitte la vue « Faites »', async () => {
    await viderTodos();
    const t = await creer({ title: 'Mettre à jour Node' });
    await app.api('PUT', `/api/todos/${t.id}`, { status: 'done' });
    await allerTodos('done');
    await attendreLignes(1);
    assert.equal(await ligne('Mettre à jour Node').locator('.todo-check').isChecked(), true);
    assert.match(await ligne('Mettre à jour Node').getAttribute('class'), /\bdone\b/);
    // `click()` et non `uncheck()` : la ligne disparaît de « Faites » au succès.
    await ligne('Mettre à jour Node').locator('.todo-check').click();
    await attendreServeur(async () => (await todoParTitre('Mettre à jour Node', 'open') || {}).status === 'open', 'rouverte');
    await attendreLignes(0);
    await allerTodos('open');
    await ligne('Mettre à jour Node').waitFor();
  });

  test('le tiroir des archivées montre sa date, et ne se réordonne pas', async () => {
    await viderTodos();
    const t = await creer({ title: 'Vieux ménage' });
    app.db.prepare("UPDATE todo SET status = 'done', done_at = datetime('now', '-10 days'), archived_at = ? WHERE id = ?")
      .run(new Date().toISOString(), t.id);
    await allerTodos('archived');
    await attendreLignes(1);
    assert.match(await ligne('Vieux ménage').innerText(), /archivée le/);
    assert.equal(await page.locator('#todoList [data-todo-up], #todoList .todo-grip').count(), 0);
    assert.equal(await page.locator('#todoList [data-todo-code]').count(), 0, 'une todo close ne se fait pas faire');
    await allerTodos('open');
  });

  test('supprimer : « Annuler » garde la todo, « Supprimer » l’efface', async () => {
    await viderTodos();
    await creer({ title: 'À jeter' });
    await allerTodos('open');
    await attendreLignes(1);
    await ligne('À jeter').locator('[data-todo-del]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /Cocher « fait » la garde/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.ok(await todoParTitre('À jeter', 'open'));

    await ligne('À jeter').locator('[data-todo-del]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => !(await todoParTitre('À jeter')), 'supprimée côté serveur');
    await attendreLignes(0);
  });

  test('glisser-déposer réordonne, et l’ordre est enregistré', async () => {
    await viderTodos();
    await creer({ title: 'alpha' });
    await creer({ title: 'beta' });
    await creer({ title: 'gamma' });
    await allerTodos('open');
    await attendreLignes(3);
    const ordre = async () => (await todos('open')).map((x) => x.title);
    const avant = await ordre();
    const dernier = avant[2];
    // On lâche le dernier sur le HAUT de la première ligne : il passe devant.
    await ligne(dernier).dragTo(page.locator('#todoList .todo-row').first(), { targetPosition: { x: 40, y: 3 } });
    await attendreServeur(async () => (await ordre())[0] === dernier, 'le nouvel ordre est enregistré');
    await page.waitForFunction((t) => (document.querySelector('#todoList .todo-row .brief-item-title') || { textContent: '' }).textContent.trim() === t, dernier);
  });

  test('au clavier : « / » va dans la barre d’ajout, « j » et « k » parcourent la liste', async () => {
    await allerTodos('open');
    await attendreLignes(3);
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').focus();
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'todoQuickAdd');
    await page.evaluate(() => document.activeElement.blur());
    const focalisee = () => page.evaluate(() => [...document.querySelectorAll('#todoList .todo-row')].findIndex((r) => r.classList.contains('focused')));
    await page.keyboard.press('j');
    assert.equal(await focalisee(), 0);
    await page.keyboard.press('j');
    assert.equal(await focalisee(), 1);
    await page.keyboard.press('k');
    assert.equal(await focalisee(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await focalisee(), -1);
  });

  test('« Faire faire cette todo » ouvre une session pré-remplie, sur le dépôt lié', async () => {
    await viderTodos();
    await creer({ title: 'Corriger le cache Redis', note: 'les clés expirent trop tôt', link_kind: 'repo', link_ref: String(repoId) });
    await allerTodos('open');
    await attendreLignes(1);
    await ligne('Corriger le cache Redis').locator('[data-todo-code]').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.equal(await page.locator('#tab-task').isVisible(), true, 'on arrive dans Dev IA');
    assert.equal(await page.locator('#taskPrompt').inputValue(), 'Corriger le cache Redis\n\nles clés expirent trop tôt');
    assert.equal(await page.locator('#taskForm [name="label"]').inputValue(), 'Corriger le cache Redis');
    await page.waitForFunction((id) => [...document.querySelectorAll('#targetRows .target-row .t-repo')].some((s) => Number(s.value) === id), repoId);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM task').get().c, 0, 'rien n’est lancé');
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  });

  test('une todo liée à une MR mène à son rapport, et dit où en est la MR', async () => {
    await viderTodos();
    await creer({ title: 'Suivre le panier', link_kind: 'mr', link_ref: String(mrId) });
    await allerTodos('open');
    await attendreLignes(1);
    const lien = ligne('Suivre le panier').locator(`.note-link[data-note-mr="${mrId}"]`);
    assert.match(await lien.innerText(), /MR !214/);
    assert.match(await ligne('Suivre le panier').innerText(), /ouverte il y a/);
    await lien.click();
    await page.waitForSelector('#tab-review.active');
    await page.waitForFunction((id) => window.location.hash === `#/reviews/${id}`, mrId);
  });

  /* L'onglet Jira charge « mes tickets » à l'arrivée, et ce chargement se termine en
     sélectionnant le premier de la liste — ou en écrivant « Aucun ticket ne t'est affecté ».
     Le lien, lui, a déjà demandé SON ticket : celui des deux qui répond le dernier gagne. Pour
     un ticket qui n'est pas dans « mes tickets » (le cas courant d'un ticket suivi), c'est
     presque toujours la liste. On attend donc la fin du chargement, puis on lit le détail. */
  test('une todo liée à un ticket mène à son détail Jira', async () => {
    await viderTodos();
    await creer({ title: 'Débloquer le tunnel', link_kind: 'ticket', link_ref: 'PROJ-720' });
    await allerTodos('open');
    await attendreLignes(1);
    /* L'ordre réaliste : une recherche JQL (« mes tickets ») répond après la lecture d'UN
       ticket. On retient donc la liste jusqu'à ce que le détail soit arrivé — sans cela, le
       résultat dépendrait de la vitesse de la machine. */
    let detailArrive;
    const detail = new Promise((r) => { detailArrive = r; });
    const surReponse = (rep) => { if (rep.url().includes('/api/jira/issue/PROJ-720')) detailArrive(); };
    page.on('response', surReponse);
    await page.route('**/api/jira/tickets**', async (route) => { await detail; await route.continue(); });
    await ligne('Débloquer le tunnel').locator('.note-link[data-note-ticket="PROJ-720"]').click();
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

  test('une todo liée à une vérification ouvre son rapport', async () => {
    await viderTodos();
    await creer({ title: 'Réparer l’intégration', link_kind: 'verification', link_ref: String(verifId) });
    await allerTodos('open');
    await attendreLignes(1);
    await ligne('Réparer l’intégration').locator(`[data-vreport="${verifId}"]`).click();
    await page.waitForSelector('#verifyModal:not([hidden])');
    await page.waitForFunction(() => !/chargement/i.test((document.querySelector('#verifyReport') || {}).textContent));
    await page.locator('#verifyModal').evaluate((m) => { m.hidden = true; });
  });

  test('une todo liée à une branche ouvre l’explorateur Git sur son dépôt', async () => {
    await viderTodos();
    await creer({ title: 'Nettoyer la branche', link_kind: 'branch', link_ref: `${repoId}:feature/PROJ-42` });
    await allerTodos('open');
    await attendreLignes(1);
    const lien = ligne('Nettoyer la branche').locator('[data-todo-branch]');
    assert.match(await lien.innerText(), /feature\/PROJ-42/);
    await lien.click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForSelector('#gsub-explore.active');
    await page.locator('.toast', { hasText: 'feature/PROJ-42' }).first().waitFor();
  });

  test('une todo liée à un build mène à Jenkins, une liée à un conteneur mène à Docker', async () => {
    await viderTodos();
    await creer({ title: 'Relancer le déploiement', link_kind: 'build', link_ref: 'equipe/deploy#42' });
    await creer({ title: 'Redémarrer l’API', link_kind: 'container', link_ref: 'api-core' });
    await allerTodos('open');
    await attendreLignes(2);
    const build = ligne('Relancer le déploiement').locator('[data-todo-build]');
    assert.match(await build.innerText(), /equipe\/deploy/);
    await build.click();
    await page.waitForSelector('#tab-jenkins.active');
    // La fiche du job s'ouvre, sur le chemin porté par la todo (sans le numéro de build).
    await page.waitForSelector('#jenkinsModal:not([hidden])');
    assert.equal(await page.locator('#jenkinsModalTitle').innerText(), 'equipe/deploy');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#jenkinsModal', { state: 'hidden' });

    await allerTodos('open');
    await attendreLignes(2);
    const conteneur = ligne('Redémarrer l’API').locator('[data-todo-container="api-core"]');
    assert.match(await conteneur.innerText(), /api-core/);
    await conteneur.click();
    await page.waitForSelector('#tab-docker.active');
  });

  /* LE BOUTON « PARTAGER » D'UNE TODO DÉPEND DE `partageEtMoi`, que seul `partageActif()`
     remplit — appelé par Dev IA, l'éditeur de pages, la modale de session… mais PAS par
     `loadTodos`. Qui ouvre l'application et va droit à Notes → Todos ne voit donc jamais le
     bouton, alors qu'un dépôt d'équipe est configuré. */
  test('à plusieurs, le bouton « partager » est là dès la première visite des todos', async () => {
    await viderTodos();
    const r = await app.api('PUT', '/api/config', { data_repo_url: 'https://gitlab.test/equipe/donnees.git' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await app.api('GET', '/api/whoami')).body.partage, true);
    await creer({ title: 'Préparer la rétro' });
    await page.reload();
    await allerTodos('open');
    await attendreLignes(1);
    // Le rendu est synchrone : la ligne affichée porte déjà (ou jamais) son bouton.
    assert.equal(await ligne('Préparer la rétro').locator('[data-todo-share]').count(), 1);
  });

  test('à plusieurs, une todo se partage et cesse de l’être ; une todo automatique jamais', async () => {
    await viderTodos();
    const r = await app.api('PUT', '/api/config', { data_repo_url: 'https://gitlab.test/equipe/donnees.git' });
    assert.equal(r.status, 200, r.text);
    await creer({ title: 'Préparer la rétro' });
    const auto = await creer({ title: 'Question d’un agent' });
    app.db.prepare("UPDATE todo SET auto_kind = 'agent', auto_ref = 'x' WHERE id = ?").run(auto.id);
    await page.reload();
    /* Passage par Dev IA d'abord : c'est lui qui lit « y a-t-il une équipe ? » (voir le test
       précédent, qui montre que les todos seules ne le font pas). */
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector('#tab-task.active');
    await allerTodos('open');
    await attendreLignes(2);
    const bouton = () => ligne('Préparer la rétro').locator('[data-todo-share]');
    await bouton().waitFor();
    assert.equal(await ligne('Question d’un agent').locator('[data-todo-share]').count(), 0,
      'une todo automatique ne propose pas de partir');
    await bouton().click();
    await attendreServeur(async () => (await todoParTitre('Préparer la rétro', 'open')).shared === 1, 'partagée');
    await ligne('Préparer la rétro').locator('.note-partagee').waitFor();
    await page.waitForFunction(() => {
      const b = document.querySelector('#todoList [data-todo-share]');
      return b && b.dataset.on === '1';
    });
    await bouton().click();
    await attendreServeur(async () => (await todoParTitre('Préparer la rétro', 'open')).shared === 0, 'redevenue personnelle');
    await page.waitForFunction(() => !document.querySelector('#todoList .note-partagee'));
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
