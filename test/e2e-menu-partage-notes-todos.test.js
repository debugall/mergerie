'use strict';
/* PARTAGE, OBJET PAR OBJET — LES PAGES DE NOTES ET LES TODOS.
 *
 * Les deux seuls objets du menu Notes qui se partagent LIGNE PAR LIGNE, et qui partent donc sur
 * un geste. Déjà éprouvé ailleurs : la case d'une page qui part puis se retire (`e2e-data-sync`),
 * le bouton d'une todo qui pose et retire son drapeau (`e2e-menu-notes-todos`, contre une adresse
 * de dépôt fictive — rien n'y part vraiment). Ce fichier éprouve, dans un VRAI dépôt :
 *   - une todo partagée depuis l'écran arrive dans `todos/<uid>.json`, la cocher « faite » y
 *     écrit son nouvel état, et « ne plus partager » l'en retire ;
 *   - une sous-page partagée entraîne sa page mère, et départager la mère retire ses sous-pages —
 *     le toast le dit, et le dépôt le prouve ;
 *   - la page et la todo d'une collègue, arrivées par la synchro, se lisent à l'écran comme
 *     partagées ; une page à moi corrigée par elle montre SA version ;
 *   - CE QUI RESTE À TRANCHER : départager depuis ce poste la page ou la todo d'une collègue
 *     l'efface du dépôt, donc chez tout le monde (tests marqués `todo`, voir plus bas).
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const {
  creerDepotNu, fichiersDuDepot, contenuDuDepot, collegue, synchroniserJusqua, uidDe,
} = require('./helpers/partage');

const { dispo } = navigateurDispo();

describe('Partage — pages de notes et todos', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let racine; let nu; let claire;
  const erreurs = [];

  const dansLeDepot = (f) => fichiersDuDepot(nu).includes(f);
  const todos = async () => (await app.api('GET', '/api/todos?status=all')).body.todos || [];
  const todoParTitre = async (t) => (await todos()).find((x) => x.title === t);
  const pages = async () => (await app.api('GET', '/api/notes')).body.pages || [];
  const pageParTitre = async (t) => (await pages()).find((x) => x.title === t);
  const uidTodo = (id) => app.db.prepare('SELECT uid FROM todo WHERE id = ?').get(id).uid;

  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
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
  const allerPages = async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    await page.waitForSelector('#notesSubPages:not([hidden])');
  };
  /* Ouvre une page et attend l'éditeur REDESSINÉ pour elle (l'ancien porte la marque), puis la
     case « partager », qui n'apparaît qu'une fois l'état d'équipe lu. */
  const ouvrirPage = async (titre) => {
    await page.evaluate(() => { const e = document.querySelector('#pageTitle'); if (e) e.dataset.ancien = '1'; });
    await page.locator('#pageList .note-item', { hasText: titre }).first().click();
    await page.waitForFunction((t) => {
      const el = document.querySelector('#pageTitle');
      return el && !el.dataset.ancien && el.value === t;
    }, titre);
    await page.waitForSelector('#pageShare:not([hidden])');
  };
  // Les pages arrivées par la synchro ne sont dans la liste qu'après un rechargement.
  const rechargerPages = async (titre) => {
    await page.reload();
    await allerPages();
    await page.locator('#pageList .note-item', { hasText: titre }).first().waitFor();
  };

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'partage-notes-'));
    nu = creerDepotNu(racine);
    claire = collegue(racine, nu, 'Claire');
    await app.configure({ data_sync_seconds: '600' });
    const r = await app.api('POST', '/api/data-sync/attach', { url: nu });
    assert.equal(r.status, 200, r.text);
    await attendreServeur(async () => Boolean((await app.api('GET', '/api/data-sync')).body.dernierPush), 'le premier envoi');

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="notes"]');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  /* ------------------------------------------------------------ todos ---- */

  test('une todo partagée depuis l’écran arrive dans le dépôt ; « faite » y écrit son état ; départagée elle en sort', async () => {
    const creee = (await app.api('POST', '/api/todos', { title: 'Relire le lot paiement avant vendredi' })).body;
    const fichier = `todos/${uidTodo(creee.id)}.json`;
    await app.api('POST', '/api/data-sync/now');
    assert.equal(dansLeDepot(fichier), false, 'une todo est personnelle par défaut');

    await page.reload();
    await allerTodos('open');
    const bouton = () => ligne('Relire le lot paiement').locator('[data-todo-share]');
    await bouton().waitFor();
    await bouton().click();
    await attendreServeur(async () => (await todoParTitre('Relire le lot paiement avant vendredi')).shared === 1, 'la todo est partagée');
    await ligne('Relire le lot paiement').locator('.note-partagee').waitFor();
    // Qui l'a partagée se lit sur la ligne : moi.
    await page.waitForFunction(() => [...document.querySelectorAll('#todoList .todo-row')]
      .some((r) => /Relire le lot paiement/.test(r.textContent) && /partagé par moi/.test((r.querySelector('.auteur-partage') || {}).textContent || '')));
    await synchroniserJusqua(app, async () => dansLeDepot(fichier), 'la todo est dans le dépôt');
    assert.equal(JSON.parse(contenuDuDepot(nu, fichier)).status, 'open');

    // La cocher « faite » : c'est son ÉTAT qui part — l'équipe voit qu'elle est faite.
    await ligne('Relire le lot paiement').locator('[data-todo-check]').click();
    await attendreServeur(async () => (await todoParTitre('Relire le lot paiement avant vendredi')).status === 'done', 'la todo est faite');
    await synchroniserJusqua(app, async () => JSON.parse(contenuDuDepot(nu, fichier)).status === 'done', 'l’état « faite » est dans le dépôt');

    await allerTodos('done');
    await bouton().waitFor();
    await page.waitForFunction(() => {
      const b = document.querySelector('#todoList [data-todo-share]');
      return b && b.dataset.on === '1';
    });
    await bouton().click();
    await attendreServeur(async () => (await todoParTitre('Relire le lot paiement avant vendredi')).shared === 0, 'redevenue personnelle');
    await synchroniserJusqua(app, async () => !dansLeDepot(fichier), 'la todo a quitté le dépôt');
    assert.ok(await todoParTitre('Relire le lot paiement avant vendredi'), 'elle reste chez moi');
  });

  test('une todo automatique ne part jamais, même marquée partagée en base', async () => {
    const auto = (await app.api('POST', '/api/todos', { title: 'Question posée par un agent' })).body;
    app.db.prepare("UPDATE todo SET auto_kind = 'agent', auto_ref = 'x', shared = 1 WHERE id = ?").run(auto.id);
    // Une écriture ordinaire la remet dans la file d'écoulement.
    await app.api('PUT', `/api/todos/${auto.id}`, { note: 'réécrite' });
    await app.api('POST', '/api/data-sync/now');
    assert.equal(dansLeDepot(`todos/${uidTodo(auto.id)}.json`), false);
    await page.reload();
    await allerTodos('open');
    await ligne('Question posée par un agent').waitFor();
    assert.equal(await ligne('Question posée par un agent').locator('[data-todo-share]').count(), 0);
  });

  /* ------------------------------------------------------------ pages ---- */

  test('partager une sous-page entraîne sa mère ; départager la mère retire ses sous-pages', async () => {
    const mere = (await app.api('POST', '/api/notes', { title: 'Architecture', content: '# Vue d’ensemble' })).body;
    const fille = (await app.api('POST', '/api/notes', { title: 'Cache Redis', content: 'TTL 5 min', parent_id: mere.id })).body;
    assert.ok(fille.id && fille.parent_id === mere.id, JSON.stringify(fille));

    // La sous-page est pliée sous sa mère : on déplie, comme on le ferait.
    await rechargerPages('Architecture');
    await page.locator(`#pageList .note-fold[data-fold="${mere.id}"]`).click();
    await page.locator('#pageList .note-item', { hasText: 'Cache Redis' }).first().waitFor();
    await ouvrirPage('Cache Redis');
    assert.equal(await page.locator('#pageShareBox').isChecked(), false);
    await page.locator('#pageShareBox').click();
    await attendreServeur(async () => (await pageParTitre('Cache Redis')).shared === 1
      && (await pageParTitre('Architecture')).shared === 1, 'la sous-page ET sa mère sont partagées');
    // Le toast le dit : une case qui en coche une autre en silence est une case qu'on n'ose plus toucher.
    await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-msg')].some((t) => /Architecture/.test(t.textContent)));
    await synchroniserJusqua(app, async () => dansLeDepot('notes/cache-redis.md') && dansLeDepot('notes/architecture.md'),
      'les deux pages sont dans le dépôt');
    assert.equal(JSON.parse(contenuDuDepot(nu, 'notes/cache-redis.json')).parent, 'architecture',
      'la sous-page désigne sa mère par son slug');

    // La colonne le montre aussi : la mère porte désormais le pictogramme du partage.
    await page.locator('#pageList .note-item', { hasText: 'Architecture' }).locator('.note-partagee').waitFor();
    await ouvrirPage('Architecture');
    await page.waitForFunction(() => document.querySelector('#pageShareBox').checked);
    await page.locator('#pageShareBox').click();
    await attendreServeur(async () => (await pageParTitre('Cache Redis')).shared === 0
      && (await pageParTitre('Architecture')).shared === 0, 'la mère et sa sous-page ne sont plus partagées');
    await synchroniserJusqua(app, async () => !dansLeDepot('notes/cache-redis.md') && !dansLeDepot('notes/architecture.md'),
      'les deux pages ont quitté le dépôt');
  });

  /* ------------------------------------------------------------ ce que publie une collègue ---- */

  let pageMienne;
  test('préparation : Claire publie une page et une todo, et corrige une page à moi', async () => {
    pageMienne = (await app.api('POST', '/api/notes', { title: 'Procédure de mise en prod', content: '1. taguer' })).body;
    await app.api('PUT', `/api/notes/${pageMienne.id}`, { shared: 1 });
    await synchroniserJusqua(app, async () => dansLeDepot('notes/procedure-de-mise-en-prod.md'), 'ma page est dans le dépôt');

    const maintenant = new Date().toISOString();
    const ut = uidDe('CLTODO01');
    const up = uidDe('CLPAGE01');
    claire.publier('notes de Claire', ({ ecrire }) => {
      ecrire(`todos/${ut}.json`, {
        created_at: maintenant, priority: 'high', status: 'open', title: 'Todo de Claire : rotation des clés',
        uid: ut, updated_at: maintenant,
      });
      ecrire('notes/runbook-incident.json', {
        created_at: maintenant, images: [], pinned: 0, slug: 'runbook-incident', title: 'Runbook incident',
        uid: up, updated_at: maintenant,
      });
      ecrire('notes/runbook-incident.md', '# Runbook\n\nD’abord, prévenir l’astreinte.\n');
      ecrire('notes/procedure-de-mise-en-prod.md', '1. taguer\n2. prévenir le support (ajout de Claire)\n');
    });
    await synchroniserJusqua(app, async () => Boolean(await todoParTitre('Todo de Claire : rotation des clés'))
      && Boolean(await pageParTitre('Runbook incident'))
      && /ajout de Claire/.test((await app.api('GET', `/api/notes/${pageMienne.id}`)).body.content || ''),
    'la todo, la page et la correction de Claire sont arrivées');
  });

  test('la todo de Claire se lit partagée, avec son bouton allumé', async () => {
    await page.reload();
    await allerTodos('open');
    const l = ligne('Todo de Claire : rotation des clés');
    await l.waitFor();
    await l.locator('.note-partagee').waitFor();
    await l.locator('.auteur-partage', { hasText: 'partagé par Claire' }).waitFor();
    assert.equal(await l.locator('[data-todo-share]').getAttribute('data-on'), '1');
    assert.equal((await todoParTitre('Todo de Claire : rotation des clés')).priority, 'high', 'le contenu est le sien');
  });

  test('la page de Claire se lit partagée, avec son contenu ; ma page montre sa correction', async () => {
    await rechargerPages('Runbook incident');
    assert.equal(await page.locator('#pageList .note-item', { hasText: 'Runbook incident' }).locator('.note-partagee').count(), 1);
    await page.locator('#pageList .note-item', { hasText: 'Runbook incident' }).locator('.auteur-partage', { hasText: 'partagé par Claire' }).waitFor();
    await ouvrirPage('Runbook incident');
    assert.equal(await page.locator('#pageShareBox').isChecked(), true, 'elle vient du dépôt : elle y est partagée');
    assert.match(await page.locator('#pageContent').inputValue(), /prévenir l’astreinte/);
    await page.locator('#pageShare .auteur-partage', { hasText: 'partagé par Claire' }).waitFor();

    await ouvrirPage('Procédure de mise en prod');
    assert.match(await page.locator('#pageContent').inputValue(), /ajout de Claire/, 'la version de Claire a remplacé la mienne');
    /* Corrigée par Claire, elle reste MA page partagée : « partagé par » nomme qui l'a partagée,
       pas la dernière à y avoir écrit. */
    await page.locator('#pageShare .auteur-partage', { hasText: 'partagé par moi' }).waitFor();
  });

  /* ------------------------------------------------------------ à trancher ---- */

  /* LA RÈGLE DES SESSIONS NE VAUT PAS ICI. Pour une session, « seul l'auteur bascule ou supprime
     ce qui est partagé » (`exigerProprietaire`, src/server.js) : départager la session d'un
     collègue répond 403, parce que retirer le fichier du dépôt l'effacerait chez tout le monde.
     La page et la todo d'une collègue, elles, offrent la case et le bouton, et le serveur
     accepte : le fichier QUITTE le dépôt — la ligne disparaîtra chez Claire à son prochain
     `pull`. Le commentaire de `note_page.fromFile` (src/store-registry.js) nomme exactement ce
     danger (« le poste qui reçoit effacerait chez tout le monde la page qu'on vient de lui
     envoyer ») ; il n'est gardé qu'à l'arrivée, pas au geste. */
  test('départager la page d’une collègue ne l’efface pas du dépôt', async () => {
    await rechargerPages('Runbook incident');
    await ouvrirPage('Runbook incident');
    await page.locator('#pageShareBox').click();
    await attendreServeur(async () => (await pageParTitre('Runbook incident')).shared === 0
      || (await page.locator('#toasts .toast.err').count()) > 0, 'le geste a abouti, ou a été refusé à l’écran');
    await app.api('POST', '/api/data-sync/now');
    assert.ok(dansLeDepot('notes/runbook-incident.md'), 'la page de Claire doit rester dans le dépôt');
  });

  test('départager la todo d’une collègue ne l’efface pas du dépôt', async () => {
    const t = await todoParTitre('Todo de Claire : rotation des clés');
    const fichier = `todos/${t.uid}.json`;
    await page.reload();
    await allerTodos('open');
    const l = ligne('Todo de Claire : rotation des clés');
    await l.locator('[data-todo-share]').waitFor();
    await l.locator('[data-todo-share]').click();
    await attendreServeur(async () => (await todoParTitre('Todo de Claire : rotation des clés')).shared === 0
      || (await page.locator('#toasts .toast.err').count()) > 0, 'le geste a abouti, ou a été refusé à l’écran');
    await app.api('POST', '/api/data-sync/now');
    assert.ok(dansLeDepot(fichier), 'la todo de Claire doit rester dans le dépôt');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
