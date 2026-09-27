'use strict';
/* MENU « NOTES » APRÈS UNE SYNCHRONISATION — todos et pages d'une collègue, sous mes yeux.
 *
 * Claire (seconde instance de Mergerie, processus enfant — `helpers/synchro-collegue`) crée,
 * coche, renomme et supprime des todos PARTAGÉES, écrit et modifie des pages PARTAGÉES, et
 * synchronise. Ce poste synchronise par le témoin du pied de page, sans quitter l'écran. On
 * regarde alors :
 *   — la liste des todos et les deux pastilles du menu Notes (`#navTodoUrgent`, `#navCountNotes`) ;
 *   — la liste des pages, et surtout une page OUVERTE dans l'éditeur : suit-elle, et surtout
 *     que devient ce que je tape ? Une page restée sur la version d'avant, c'est une page dont
 *     la prochaine autosauvegarde réécrit tout le contenu — donc efface ce que Claire a écrit.
 *
 * Forme des tests : `helpers/synchro-ecran` (effet borné, témoin rechargé dur, puis jugement).
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const {
  monterEquipe, synchroniserDepuisLePied, exigerQueLEcranSuive,
} = require('./helpers/synchro-ecran');

const { dispo } = navigateurDispo();


describe('Notes · l’écran suit les todos et les pages de la collègue, après une synchro', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let claire;
  const erreurs = [];

  // ---- côté serveur
  const todosIci = async () => (await app.api('GET', '/api/todos?status=all')).body.todos || [];
  const todoIci = async (titre) => (await todosIci()).find((t) => t.title === titre);
  const pageIci = async (titre) => {
    const p = ((await app.api('GET', '/api/notes')).body.pages || []).find((x) => x.title === titre);
    return p ? (await app.api('GET', `/api/notes/${p.id}`)).body : null;
  };
  const todoClaire = async (titre, extra = {}) => {
    const r = await claire.api('POST', '/api/todos', { title: titre, shared: 1, ...extra });
    assert.equal(r.status, 200, r.text);
    return r.body.id;
  };
  const majTodoClaire = async (idc, patch) => {
    const r = await claire.api('PUT', `/api/todos/${idc}`, patch);
    assert.equal(r.status, 200, r.text);
  };
  const pageClaire = async (titre, contenu) => {
    const r = await claire.api('POST', '/api/notes', { title: titre, content: contenu });
    assert.equal(r.status, 200, r.text);
    const s = await claire.api('PUT', `/api/notes/${r.body.id}`, { shared: 1 });
    assert.equal(s.status, 200, s.text);
    return r.body.id;
  };
  const majPageClaire = async (idc, patch) => {
    const r = await claire.api('PUT', `/api/notes/${idc}`, patch);
    assert.equal(r.status, 200, r.text);
  };
  // Claire pousse, puis ce poste synchronise depuis l'écran et la base locale doit suivre.
  async function echanger(arrive, quoi) {
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    await attendreServeur(arrive, quoi);
  }

  // ---- côté écran
  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  const allerTodos = async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await page.waitForSelector('#notesSubTodos:not([hidden])');
    await page.locator('#tab-notes [data-tfilter="open"]').click();
    await page.waitForFunction(() => document.querySelector('#tab-notes [data-tfilter="open"]').classList.contains('active'));
  };
  const allerPages = async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    await page.waitForSelector('#notesSubPages:not([hidden])');
  };
  const recharger = async (aller) => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="notes"]');
    await aller();
  };
  const ligneTodo = (titre) => [...document.querySelectorAll('#todoList .todo-row')].find((r) => r.textContent.includes(titre));
  // Ouvre une page et attend l'éditeur redessiné POUR ELLE (juste après le clic, c'est l'ancien).
  const ouvrirPage = async (titre) => {
    await page.evaluate(() => { const e = document.querySelector('#pageTitle'); if (e) e.dataset.ancien = '1'; });
    await page.locator('#pageList .note-item', { hasText: titre }).first().click();
    await page.waitForFunction((t) => {
      const el = document.querySelector('#pageTitle');
      return el && !el.dataset.ancien && el.value === t && document.querySelector('#pageContent');
    }, titre);
  };

  // Le curseur à la fin du texte, comme un clic en bas de page — sans raccourci propre à l'OS.
  const curseurALaFin = () => page.evaluate(() => {
    const el = document.querySelector('#pageContent');
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });

  before(async () => {
    app = await startApp();
    await app.configure();
    ({ collegue: claire } = await monterEquipe(app));

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    // L'éditeur ET l'aperçu : on tape dans les pages ouvertes.
    await page.addInitScript(() => { try { localStorage.setItem('aidevtools_note_panes', 'both'); } catch { /* stockage refusé */ } });
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="notes"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (claire) await claire.stop();
    if (app) await app.stop();
  });

  /* ------------------------------------------------------------------ todos ---- */

  test('une todo partagée de Claire arrive dans la base par le témoin du pied de page', async () => {
    await allerTodos();
    await todoClaire('Préparer la recette');
    await claire.synchroniser();
    assert.equal(await todoIci('Préparer la recette'), undefined, 'rien avant la synchro de ce poste');
    await synchroniserDepuisLePied(page);
    const t = await todoIci('Préparer la recette');
    assert.ok(t && t.status === 'open', 'la todo de Claire est une ligne ici');
    await recharger(allerTodos);
    await page.waitForFunction(ligneTodo, 'Préparer la recette');
    assert.deepEqual(erreurs, []);
  });

  test('Todos ouvertes : une NOUVELLE todo de Claire apparaît dans la liste', async () => {
    await recharger(allerTodos);
    await page.waitForFunction(ligneTodo, 'Préparer la recette');
    await todoClaire('Relancer le client');
    await echanger(async () => Boolean(await todoIci('Relancer le client')), 'la nouvelle todo est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (t) => Boolean([...document.querySelectorAll('#todoList .todo-row')].find((r) => r.textContent.includes(t))),
      arg: 'Relancer le client',
      temoin: () => recharger(allerTodos),
      bug: 'la todo de Claire n’apparaît pas dans la liste ouverte',
    });
  });

  test('Claire COCHE une todo : elle quitte « à faire » sous mes yeux', async () => {
    await recharger(allerTodos);
    await page.waitForFunction(ligneTodo, 'Relancer le client');
    const idc = ((await claire.api('GET', '/api/todos?status=all')).body.todos || []).find((t) => t.title === 'Relancer le client').id;
    await majTodoClaire(idc, { status: 'done' });
    await echanger(async () => (await todoIci('Relancer le client')).status === 'done', 'la todo cochée est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (t) => !([...document.querySelectorAll('#todoList .todo-row')].find((r) => r.textContent.includes(t))),
      arg: 'Relancer le client',
      temoin: () => recharger(allerTodos),
      bug: 'la todo cochée par Claire reste dans « à faire »',
    });
  });

  test('Claire RENOMME une todo : le nouveau titre s’affiche', async () => {
    await recharger(allerTodos);
    await page.waitForFunction(ligneTodo, 'Préparer la recette');
    const idc = ((await claire.api('GET', '/api/todos?status=all')).body.todos || []).find((t) => t.title === 'Préparer la recette').id;
    await majTodoClaire(idc, { title: 'Préparer la recette de jeudi' });
    await echanger(async () => Boolean(await todoIci('Préparer la recette de jeudi')), 'le nouveau titre est arrivé');
    await exigerQueLEcranSuive(page, {
      predicat: (t) => Boolean([...document.querySelectorAll('#todoList .todo-row')].find((r) => r.textContent.includes(t))),
      arg: 'Préparer la recette de jeudi',
      temoin: () => recharger(allerTodos),
      bug: 'la ligne garde l’ancien titre',
    });
  });

  test('Claire SUPPRIME une todo : elle disparaît de ma liste', async () => {
    const idc = await todoClaire('Todo éphémère');
    await echanger(async () => Boolean(await todoIci('Todo éphémère')), 'la todo éphémère est arrivée');
    await recharger(allerTodos);
    await page.waitForFunction(ligneTodo, 'Todo éphémère');
    const r = await claire.api('DELETE', `/api/todos/${idc}`);
    assert.equal(r.status, 200, r.text);
    await echanger(async () => !(await todoIci('Todo éphémère')), 'la suppression est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (t) => {
        const l = document.querySelector('#todoList');
        return Boolean(l) && !([...l.querySelectorAll('.todo-row')].find((x) => x.textContent.includes(t)));
      },
      arg: 'Todo éphémère',
      temoin: () => recharger(allerTodos),
      bug: 'la todo supprimée par Claire reste affichée (et cliquable) chez moi',
    });
  });

  /* LES PASTILLES DU MENU NOTES — le seul endroit du fichier où un rafraîchissement existe, par
     accident : `pollReminders` (toutes les 60 s) relit les todos ouvertes pour faire passer une
     échéance au rouge, et remet les pastilles à jour au passage. Elles finissent donc par suivre,
     mais une minute plus tard — pas « sous mes yeux ». Les deux tests ci-dessous le mesurent. */
  const pastilles = () => ({
    rouge: (document.querySelector('#navTodoUrgent').hidden ? '0' : document.querySelector('#navTodoUrgent').textContent.trim()),
    bleu: (document.querySelector('#navCountNotes').hidden ? '0' : document.querySelector('#navCountNotes').textContent.trim()),
  });

  test('pastilles du menu Notes : une todo URGENTE de Claire passe au rouge aussitôt la synchro faite', async () => {
    await recharger(allerTodos);
    const avant = await page.evaluate(pastilles);
    await todoClaire('Incident prod à suivre', { priority: 'high' });
    await echanger(async () => Boolean(await todoIci('Incident prod à suivre')), 'la todo urgente est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (n) => {
        const r = document.querySelector('#navTodoUrgent');
        return !r.hidden && r.textContent.trim() === String(n);
      },
      arg: Number(avant.rouge) + 1,
      temoin: () => recharger(allerTodos),
      bug: 'la pastille rouge ne bouge qu’au sondage des rappels (public/app.js pollReminders, 60 s), pas après la synchro',
    });
  });

  test('pastilles du menu Notes : elles finissent par suivre, sans recharger, au sondage des rappels (≤ 60 s)', async () => {
    /* Le filet qui existe : on ne recharge pas, on attend le battement de `pollReminders`. */
    await recharger(allerTodos);
    const avant = await page.evaluate(pastilles);
    await todoClaire('Mettre à jour la doc', {});
    await echanger(async () => Boolean(await todoIci('Mettre à jour la doc')), 'la todo est arrivée');
    await page.waitForFunction((n) => {
      const b = document.querySelector('#navCountNotes');
      return !b.hidden && b.textContent.trim() === String(n);
    }, Number(avant.bleu) + 1, { timeout: 80000 });
  });

  /* ------------------------------------------------------------------ pages ---- */

  test('Pages : une NOUVELLE page de Claire apparaît dans la liste', async () => {
    await recharger(allerPages);
    await pageClaire('Procédure de mise en prod', '# MEP\n\n1. geler la branche\n');
    await echanger(async () => Boolean(await pageIci('Procédure de mise en prod')), 'la page est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (t) => [...document.querySelectorAll('#pageList .note-item')].some((n) => n.textContent.includes(t)),
      arg: 'Procédure de mise en prod',
      temoin: () => recharger(allerPages),
      bug: 'la page de Claire n’apparaît pas dans la liste des pages',
    });
  });

  test('Pages : une page OUVERTE que Claire modifie montre sa version (je n’ai rien tapé)', async () => {
    await recharger(allerPages);
    await ouvrirPage('Procédure de mise en prod');
    assert.match(await page.locator('#pageContent').inputValue(), /geler la branche/);
    const idc = ((await claire.api('GET', '/api/notes')).body.pages || []).find((p) => p.title === 'Procédure de mise en prod').id;
    await majPageClaire(idc, { content: '# MEP\n\n1. geler la branche\n2. prévenir le support\n' });
    await echanger(async () => /prévenir le support/.test((await pageIci('Procédure de mise en prod')).content), 'la modification est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: () => /prévenir le support/.test((document.querySelector('#pageContent') || {}).value || ''),
      temoin: async () => { await recharger(allerPages); await ouvrirPage('Procédure de mise en prod'); },
      bug: 'l’éditeur garde la version d’avant la synchro',
    });
  });

  /* LA CONSÉQUENCE, ET C'EST ELLE QUI COÛTE. L'éditeur resté sur la version d'avant renvoie, à
     la frappe suivante, TOUT son contenu (`planifier` → `viderPageSave`, PUT du texte complet) :
     ce que Claire a ajouté est effacé chez moi, puis chez elle au tour suivant — sans conflit,
     sans message, puisque c'est une écriture ordinaire et plus récente. */
  /* L'éditeur resté sur l'ancienne version ne réécrit plus en silence : il envoie la date de ce
     qu'il a sous les yeux, le serveur refuse (409 PAGE_MODIFIEE), et un bandeau nomme l'auteur et
     laisse choisir. Tant qu'on n'a pas choisi, rien n'est écrasé — ni sa version, ni la mienne. */
  test('Pages : taper dans une page que Claire vient de modifier ouvre un conflit, et les deux choix tiennent parole', async () => {
    await recharger(allerPages);
    await ouvrirPage('Procédure de mise en prod');
    const idc = ((await claire.api('GET', '/api/notes')).body.pages || []).find((p) => p.title === 'Procédure de mise en prod').id;
    await majPageClaire(idc, { content: '# MEP\n\n1. geler la branche\n2. prévenir le support\n3. vérifier les sauvegardes\n' });
    await echanger(async () => /vérifier les sauvegardes/.test((await pageIci('Procédure de mise en prod')).content), 'la modification est arrivée');
    await page.waitForFunction(() => /vérifier les sauvegardes/.test(document.querySelector('#pageContent').value));
    /* L'éditeur PÉRIMÉ — celui qui n'aurait pas vu passer la synchro : il enverra une date que le
       serveur n'a plus. C'est le cas qui écrasait sa version en silence. */
    await page.evaluate(() => { NOTES.page.updated_at = '2000-01-01T00:00:00.000Z'; });
    await curseurALaFin();
    await page.keyboard.type('\nNote : fenêtre le mardi');
    // Le serveur refuse : le bandeau nomme Claire, et SA version est intacte.
    await page.locator('#pageConflict').waitFor();
    assert.match(await page.locator('#pageConflict').innerText(), /Claire/);
    assert.match((await pageIci('Procédure de mise en prod')).content, /vérifier les sauvegardes/, 'rien n’a écrasé sa version');
    // « Garder la mienne » : ma version part, en connaissance de cause.
    await page.locator('#pageConflict [data-conflit="mine"]').click();
    await attendreServeur(async () => /fenêtre le mardi/.test((await pageIci('Procédure de mise en prod')).content), 'ma version est enregistrée');
    await page.locator('#pageConflict').waitFor({ state: 'detached' });
    /* Les deux postes se remettent d'accord avant la suite : sans ça, la prochaine modification
       de Claire partirait de SA version d'avant, et la synchro suivante serait un vrai conflit
       de fichier — un autre sujet que celui de ce test. */
    await synchroniserDepuisLePied(page);
    await claire.synchroniser();
    await attendreServeur(async () => /fenêtre le mardi/.test(((await claire.api('GET', `/api/notes/${idc}`)).body || {}).content || ''), 'Claire a reçu ma version');
  });

  test('Pages : dans un conflit, « Prendre sa version » jette ma frappe et montre la sienne', async () => {
    await recharger(allerPages);
    await ouvrirPage('Procédure de mise en prod');
    const idc = ((await claire.api('GET', '/api/notes')).body.pages || []).find((p) => p.title === 'Procédure de mise en prod').id;
    await majPageClaire(idc, { content: '# MEP\n\nversion de Claire\n' });
    await echanger(async () => /version de Claire/.test((await pageIci('Procédure de mise en prod')).content), 'sa version est arrivée');
    // L'écran suit d'abord (plus rien ne le rechargera ensuite)…
    await page.waitForFunction(() => /version de Claire/.test(document.querySelector('#pageContent').value));
    /* …puis on le rend PÉRIMÉ à coup sûr : l'éditeur enverra une date que le serveur n'a plus,
       exactement comme s'il n'avait pas vu passer la version de Claire. */
    await page.evaluate(() => { NOTES.page.updated_at = '2000-01-01T00:00:00.000Z'; });
    await curseurALaFin();
    await page.keyboard.type('\nbrouillon à jeter');
    await page.locator('#pageConflict').waitFor();
    await page.locator('#pageConflict [data-conflit="theirs"]').click();
    await page.locator('#pageConflict').waitFor({ state: 'detached' });
    await page.waitForFunction(() => /version de Claire/.test(document.querySelector('#pageContent').value)
      && !/brouillon à jeter/.test(document.querySelector('#pageContent').value));
    assert.doesNotMatch((await pageIci('Procédure de mise en prod')).content, /brouillon à jeter/);
  });

  test('Pages : ma frappe dans une page ouverte survit à une synchro qui ne la touche pas', async () => {
    /* Le cas qui doit marcher, et marche : une synchro qui apporte AUTRE CHOSE ne réécrit ni
       ne recharge l'éditeur ouvert — ce que je tape reste là, et part. */
    await recharger(allerPages);
    await ouvrirPage('Procédure de mise en prod');
    await curseurALaFin();
    await page.keyboard.type('\nÀ relire avant vendredi');
    await attendreServeur(async () => /À relire avant vendredi/.test((await pageIci('Procédure de mise en prod')).content), 'ma frappe est enregistrée');
    await pageClaire('Astreinte', 'Semaine 38 : Claire');
    await echanger(async () => Boolean(await pageIci('Astreinte')), 'l’autre page est arrivée');
    assert.match(await page.locator('#pageContent').inputValue(), /À relire avant vendredi/, 'l’éditeur garde ma frappe');
    // Le clic sur le témoin a pris le focus : on revient dans la page, comme on le ferait.
    await curseurALaFin();
    await page.keyboard.type(' (fait)');
    await attendreServeur(async () => /avant vendredi \(fait\)/.test((await pageIci('Procédure de mise en prod')).content), 'la suite de ma frappe part aussi');
  });

  test('Pages : Claire SUPPRIME la page que j’ai ouverte — elle quitte la liste et l’éditeur le dit', async () => {
    const idc = await pageClaire('Brouillon de Claire', 'à jeter');
    await echanger(async () => Boolean(await pageIci('Brouillon de Claire')), 'la page est arrivée');
    await recharger(allerPages);
    await ouvrirPage('Brouillon de Claire');
    const r = await claire.api('DELETE', `/api/notes/${idc}`);
    assert.equal(r.status, 200, r.text);
    await echanger(async () => !(await pageIci('Brouillon de Claire')), 'la suppression est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (t) => {
        const liste = document.querySelector('#pageList');
        const titre = document.querySelector('#pageTitle');
        return Boolean(liste) && ![...liste.querySelectorAll('.note-item')].some((n) => n.textContent.includes(t))
          && !(titre && titre.value === t);
      },
      arg: 'Brouillon de Claire',
      temoin: () => recharger(allerPages),
      bug: 'la page supprimée par Claire reste dans la liste ET ouverte dans l’éditeur — la frappe suivante y écrit dans le vide',
    });
  });
});
