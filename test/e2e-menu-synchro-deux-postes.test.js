'use strict';
/* MENU « RÉGLAGES » → DONNÉES PARTAGÉES — DEUX POSTES, POUR DE VRAI.
 *
 * Ce poste (serveur du test + navigateur) et celui de Claire (une SECONDE instance de Mergerie,
 * processus enfant avec sa base, son port et son identité git — `helpers/synchro-collegue`)
 * partagent un vrai dépôt nu. Claire écrit par son API et synchronise avec son propre code ;
 * ce poste est piloté par l'ÉCRAN. Rien n'est écrit à la main dans le dépôt : ce qui y arrive
 * est ce que le store produit, et ce qui en revient passe par la vraie hydratation.
 *
 * Ce que les fichiers voisins ne faisaient pas : `unit-datasync` joue deux postes sans écran,
 * `e2e-data-sync` et `e2e-menu-reglages-partage` un seul poste (et un conflit posé en base).
 * Ici, depuis l'écran :
 *   — REJOINDRE un dépôt déjà pourvu : l'aperçu dit « rejoindre », ce que Claire a partagé
 *     s'affiche (sa note dans Notes, sa règle « par Claire » dans Réglages), et ce que ce poste
 *     avait part chez elle ;
 *   — recevoir une note, une modification, des écritures croisées sans conflit ;
 *   — une suppression, dans les deux sens ;
 *   — un VRAI conflit (la même note modifiée des deux côtés) : le pied de page le signale, la
 *     version de Claire s'affiche, et chacun des deux choix se tranche à l'écran — « reprendre
 *     la mienne » repart chez Claire, « garder la leur » n'envoie rien ;
 *   — la synchro AUTOMATIQUE : une note de Claire arrive sans un clic, à la cadence réglée.
 *
 * La cadence reste à 600 s jusqu'aux deux derniers tests : chaque effet vient du geste qu'on
 * vient de faire, pas d'une boucle passée au mauvais moment. Un seul `startApp()`. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');
const { lancerCollegue } = require('./helpers/synchro-collegue');

const { dispo } = navigateurDispo();

describe('Données partagées · deux postes, un dépôt, l’écran de ce poste', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let racine; let nu; let claire;
  const erreurs = [];

  const gitNu = (...args) => execFileSync('git', ['-C', nu, ...args], { encoding: 'utf8' });
  const fichiers = () => gitNu('ls-tree', '-r', '--name-only', 'main').split('\n').filter((f) => f.trim());
  const contenuNu = (f) => gitNu('show', `main:${f}`);
  const etat = async () => (await app.api('GET', '/api/data-sync')).body;

  // Une page de notes par son titre, CONTENU COMPRIS (la liste ne le porte pas), chez qui l'on veut.
  const noteChez = async (api, titre) => {
    const liste = (await api('GET', '/api/notes')).body;
    const p = (liste.pages || []).find((x) => x.title === titre);
    return p ? (await api('GET', `/api/notes/${p.id}`)).body : null;
  };
  const ici = (titre) => noteChez(app.api, titre);
  const chezClaire = (titre) => noteChez(claire.api, titre);
  const notePartagee = async (api, titre, contenu) => {
    const { body } = await api('POST', '/api/notes', { title: titre, content: contenu });
    await api('PUT', `/api/notes/${body.id}`, { shared: 1 });
    return body.id;
  };

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'deux-postes-'));
    nu = path.join(racine, 'donnees.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });

    // Claire a monté le dépôt d'équipe AVANT nous, et y a déjà mis une note et une règle.
    claire = await lancerCollegue({ nom: 'Claire', racine });
    await claire.rattacher(nu);
    await notePartagee(claire.api, 'Note de Claire', '# Écrite chez Claire\n');
    const regle = await claire.api('POST', '/api/rules', {
      branch_match: 'feature/*', label: 'Migrations', content: 'Vérifie que chaque migration a son retour arrière.',
    });
    assert.equal(regle.status, 200, regle.text);
    await claire.synchroniser();

    // Ce poste, lui, a déjà son propre travail quand il rejoint.
    await app.configure();
    await notePartagee(app.api, 'Note du poste', '# Écrite ici avant de rejoindre\n');

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (claire) await claire.stop();
    if (app) await app.stop();
  });

  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  const ouvrirPartage = async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="datasync"]').click();
    await page.waitForSelector('#sub-datasync.active');
    await page.waitForFunction(() => document.querySelector('#dataSyncState').textContent.trim() !== '');
    await page.waitForLoadState('networkidle');
  };
  const champ = (nom) => page.locator(`#sub-datasync [form="configForm"][name="${nom}"]`);

  // « Synchroniser maintenant », à l'écran, et on attend la RÉPONSE du serveur.
  const synchroniser = async () => {
    await ouvrirPartage();
    const [rep] = await Promise.all([
      page.waitForResponse((r) => /\/api\/data-sync\/now$/.test(r.url()) && r.request().method() === 'POST', { timeout: 60000 }),
      page.locator('#btnDataNow').click(),
    ]);
    assert.equal(rep.status(), 200);
    await page.waitForFunction(() => !document.querySelector('#btnDataNow').disabled);
  };

  /* Notes → Pages, liste relue depuis le serveur : on recharge la page, la liste se charge à
     l'arrivée sur le sous-onglet — ce qui vient d'être hydraté y est, par construction. */
  const allerPages = async () => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="notes"]');
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    await page.waitForSelector('#notesSubPages:not([hidden])');
    await page.waitForFunction(() => !/Chargement/.test(document.querySelector('#pageList').textContent));
  };
  const listeContient = (titre) => page.waitForSelector(`#pageList .note-item:has-text("${titre}")`);
  const listeNeContientPas = (titre) => page.waitForFunction((t) => {
    const l = document.querySelector('#pageList');
    return l && l.textContent.trim() !== '' && !l.textContent.includes(t);
  }, titre);
  /* Ouvre une page et attend l'éditeur redessiné POUR ELLE (cf. e2e-menu-notes-pages : juste
     après le clic, l'éditeur affiché est encore l'ancien). Rend le contenu affiché. */
  const lireDansLEditeur = async (titre) => {
    await page.evaluate(() => { const e = document.querySelector('#pageTitle'); if (e) e.dataset.ancien = '1'; });
    await page.locator('#pageList .note-item', { hasText: titre }).first().click();
    await page.waitForFunction((t) => {
      const el = document.querySelector('#pageTitle');
      return el && !el.dataset.ancien && el.value === t && document.querySelector('#pageContent');
    }, titre);
    return page.locator('#pageContent').inputValue();
  };

  test('rejoindre depuis l’écran : l’aperçu dit « rejoindre », et ce que Claire a partagé s’affiche ici', async () => {
    await ouvrirPartage();
    await champ('data_repo_url').fill(nu);
    await champ('data_repo_branch').fill('main');
    await champ('data_sync_seconds').fill('600');
    await page.locator('#btnDataAttach').click();
    await page.waitForSelector('#confirmModal:not([hidden]) .apercu-tete-rejoint');
    // Ce qui part : la note de ce poste est comptée, une famille par ligne.
    assert.match(await page.locator('#confirmBody .apercu-col-part').innerText(), /\d+/);
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => { const e = await etat(); return e.configure && e.clone; }, 'ce poste est rattaché');
    await page.waitForFunction(() => document.querySelector('#dataSyncInfo').textContent.trim() !== ''
      && !document.querySelector('#btnDataAttach').disabled);

    // La note de Claire est une ligne ici, lisible dans Notes.
    await attendreServeur(async () => Boolean(await ici('Note de Claire')), 'la note de Claire est arrivée');
    await allerPages();
    await listeContient('Note de Claire');
    assert.match(await lireDansLEditeur('Note de Claire'), /Écrite chez Claire/);

    /* SA RÈGLE DIT QUI L'A POSÉE — le nom vient de git (le commit de Claire), aucune colonne. */
    await fermerModales();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="rules"]').click();
    await page.waitForSelector('#sub-rules.active');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-rule] .field-note')]
      .some((n) => /par Claire/.test(n.textContent)));
  });

  test('ce que ce poste avait avant de rejoindre part chez Claire', async () => {
    await synchroniser();
    await attendreServeur(async () => fichiers().includes('notes/note-du-poste.md'), 'la note du poste est dans le dépôt');
    await claire.synchroniser();
    const chezElle = await chezClaire('Note du poste');
    assert.ok(chezElle, 'la note de ce poste est une ligne chez Claire');
    assert.match(chezElle.content, /Écrite ici avant de rejoindre/);
    // Et l'auteur du commit est bien l'identité git de CE poste, pas celle de Claire.
    const auteur = gitNu('log', '-1', '--format=%an', '--', 'notes/note-du-poste.md').trim();
    assert.equal(auteur, 'Test');
  });

  test('une note écrite ensuite chez Claire arrive par « Synchroniser maintenant », et se lit dans Notes', async () => {
    await notePartagee(claire.api, 'Compte rendu de Claire', '# Daily\n\n- la recette passe demain\n');
    await claire.synchroniser();
    assert.equal(await ici('Compte rendu de Claire'), null, 'rien n’arrive tant que ce poste n’a pas synchronisé');
    await synchroniser();
    await allerPages();
    await listeContient('Compte rendu de Claire');
    assert.match(await lireDansLEditeur('Compte rendu de Claire'), /la recette passe demain/);
  });

  test('chacun écrit de son côté, en même temps : les deux travaux se rejoignent, sans conflit', async () => {
    await notePartagee(claire.api, 'Écrite par Claire', 'de son côté');
    await claire.synchroniser();
    // Ce poste écrit AVANT d'avoir reçu celle de Claire : son push devra se reposer sur le sien.
    await notePartagee(app.api, 'Écrite ici', 'de mon côté');
    await synchroniser();
    const f = fichiers();
    assert.ok(f.includes('notes/ecrite-par-claire.md') && f.includes('notes/ecrite-ici.md'), 'les deux sont dans le dépôt');
    assert.ok(await ici('Écrite par Claire'), 'celle de Claire est arrivée ici');
    await claire.synchroniser();
    assert.ok(await chezClaire('Écrite ici'), 'la mienne est arrivée chez Claire');
    assert.deepEqual((await etat()).conflits, [], 'deux fichiers différents : aucun conflit');
    assert.equal((await etat()).enAvance, 0);
  });

  test('une note que Claire modifie arrive modifiée ici', async () => {
    const sienne = await chezClaire('Note du poste');
    await claire.api('PUT', `/api/notes/${sienne.id}`, { content: '# Écrite ici, complétée par Claire\n' });
    await claire.synchroniser();
    await synchroniser();
    await allerPages();
    await listeContient('Note du poste');
    assert.match(await lireDansLEditeur('Note du poste'), /complétée par Claire/);
  });

  test('une suppression se propage dans les deux sens', async () => {
    // Claire supprime la sienne → elle disparaît de l'écran ici.
    const sienne = await chezClaire('Écrite par Claire');
    assert.equal((await claire.api('DELETE', `/api/notes/${sienne.id}`)).status, 200);
    await claire.synchroniser();
    assert.ok(!fichiers().includes('notes/ecrite-par-claire.md'));
    await synchroniser();
    await attendreServeur(async () => (await ici('Écrite par Claire')) === null, 'la note supprimée par Claire disparaît ici');
    await allerPages();
    await listeNeContientPas('Écrite par Claire');

    // Ce poste supprime la sienne DEPUIS L'ÉCRAN → elle disparaît chez Claire.
    await listeContient('Écrite ici');
    await lireDansLEditeur('Écrite ici');
    const mienne = await ici('Écrite ici');
    await page.locator('#pageDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await app.api('GET', `/api/notes/${mienne.id}`)).status === 404,
      'la page est supprimée ici au bout du délai d’annulation', 30000);
    await synchroniser();
    assert.ok(!fichiers().includes('notes/ecrite-ici.md'), 'le fichier a quitté le dépôt');
    await claire.synchroniser();
    assert.equal(await chezClaire('Écrite ici'), null, 'et la ligne a quitté la base de Claire');
  });

  /* LE VRAI CONFLIT : la même note, modifiée des deux côtés depuis le même commit. Le distant
     gagne — jamais de marqueur, jamais de rebase en plan — et la version écrasée est GARDÉE. */
  const provoquerConflit = async (titre, laSienne, laMienne) => {
    const chezElle = await chezClaire(titre);
    await claire.api('PUT', `/api/notes/${chezElle.id}`, { content: laSienne });
    await claire.synchroniser();
    const mienne = await ici(titre);
    await app.api('PUT', `/api/notes/${mienne.id}`, { content: laMienne });
    await synchroniser();
    await attendreServeur(async () => (await etat()).conflits.some((c) => c.fichier === 'notes/duel.md'),
      'le conflit est gardé');
  };

  test('préparation : une note « Duel » partagée, connue des deux postes', async () => {
    await notePartagee(app.api, 'Duel', 'version de départ');
    await synchroniser();
    await claire.synchroniser();
    assert.ok(await chezClaire('Duel'));
  });

  test('la même note modifiée des deux côtés : le pied de page le signale, « reprendre la mienne » repart chez Claire', async () => {
    await provoquerConflit('Duel', 'la version de Claire', 'ma version à moi');
    // Le distant a gagné : c'est la version de Claire qu'on lit ici…
    assert.equal((await ici('Duel')).content, 'la version de Claire');
    assert.match(contenuNu('notes/duel.md'), /la version de Claire/, 'aucun marqueur de conflit dans le dépôt');
    assert.doesNotMatch(contenuNu('notes/duel.md'), /<<<<<<<|>>>>>>>/);

    // …et le pied de page le dit, et mène au sous-onglet.
    await page.reload();
    await page.waitForSelector('#footerSync[data-etat="conflit"]');
    await page.locator('#footerSync').click();
    await page.waitForSelector('#sub-datasync.active');
    const carte = page.locator('#dataSyncConflicts .partage-conflit[data-file="notes/duel.md"]');
    await carte.waitFor();
    assert.match(await carte.locator('.partage-conflit-mienne').textContent(), /ma version à moi/, 'on LIT sa version avant de choisir');
    assert.equal(await page.locator('#dataSyncConflicts .partage-conflit').count(), 1,
      'un conflit par OBJET : le .md et son .json jumeau ne font qu’une page');

    await carte.locator('[data-keep="mine"]').click();
    await attendreServeur(async () => (await etat()).conflits.length === 0, 'le conflit est tranché');
    await page.waitForSelector('#dataSyncConflicts .partage-conflit', { state: 'detached' });
    assert.equal((await ici('Duel')).content, 'ma version à moi', 'sa version redevient la ligne ici');

    await synchroniser();
    assert.match(contenuNu('notes/duel.md'), /ma version à moi/, 'et elle repart dans le dépôt');
    await claire.synchroniser();
    assert.equal((await chezClaire('Duel')).content, 'ma version à moi', 'jusque chez Claire');
    await allerPages();
    assert.equal(await lireDansLEditeur('Duel'), 'ma version à moi');
  });

  test('second conflit : « garder la leur » oublie ma version, et rien ne repart', async () => {
    await provoquerConflit('Duel', 'Claire, deuxième version', 'moi, deuxième version');
    const avant = gitNu('rev-parse', 'main').trim();
    await ouvrirPartage();
    const carte = page.locator('#dataSyncConflicts .partage-conflit[data-file="notes/duel.md"]');
    await carte.waitFor();
    assert.match(await carte.locator('.partage-conflit-mienne').textContent(), /moi, deuxième version/);
    await carte.locator('[data-keep="theirs"]').click();
    await attendreServeur(async () => (await etat()).conflits.length === 0, 'le conflit est oublié');
    await page.waitForSelector('#dataSyncConflicts .partage-conflit', { state: 'detached' });

    await synchroniser();
    assert.equal(gitNu('rev-parse', 'main').trim(), avant, '« garder la leur » n’envoie rien');
    assert.equal((await ici('Duel')).content, 'Claire, deuxième version');
    await claire.synchroniser();
    assert.equal((await chezClaire('Duel')).content, 'Claire, deuxième version');
    await page.reload();
    await page.waitForSelector('#footerSync[data-etat="ok"]');
  });

  test('changer la cadence depuis l’écran s’applique sans redémarrer', async () => {
    await ouvrirPartage();
    await champ('data_sync_seconds').fill('10');
    await page.locator('#sub-datasync button[type="submit"][form="configForm"]').click();
    await attendreServeur(async () => String((await app.api('GET', '/api/config')).body.data_sync_seconds) === '10',
      'la cadence est enregistrée');
    const e = await etat();
    assert.equal(e.cadence, 10);
    assert.ok(Date.parse(e.prochain) - Date.now() <= 15000,
      `la prochaine synchro doit tomber dans la nouvelle cadence, pas dans l’ancienne : ${e.prochain}`);
    // …et l'effet : une note de Claire arrive sans un clic.
    await notePartagee(claire.api, 'Sans redémarrer', 'x');
    await claire.synchroniser();
    await attendreServeur(async () => Boolean(await ici('Sans redémarrer')), 'la note arrive à la nouvelle cadence', 45000);
  });

  test('synchro automatique : rattaché à 10 s, une note de Claire arrive sans un clic, et s’affiche', async () => {
    // Le rattachement relance la boucle à la cadence du formulaire.
    await ouvrirPartage();
    await champ('data_sync_seconds').fill('10');
    await page.locator('#btnDataAttach').click();
    await page.waitForSelector('#confirmModal:not([hidden]) .apercu-tete-rejoint');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => {
      const e = await etat();
      return e.cadence === 10 && e.prochain && Date.parse(e.prochain) - Date.now() <= 15000;
    }, 'la boucle bat à 10 s');
    await page.waitForFunction(() => !document.querySelector('#btnDataAttach').disabled);

    await notePartagee(claire.api, 'Arrivée toute seule', '# sans un clic\n');
    await claire.synchroniser();
    // AUCUN clic à partir d'ici : c'est la boucle du serveur qui doit la ramener.
    await attendreServeur(async () => Boolean(await ici('Arrivée toute seule')), 'la note arrive par la boucle', 60000);
    await allerPages();
    await listeContient('Arrivée toute seule');

    // Et dans l'autre sens : ce qu'on écrit ici part tout seul.
    await notePartagee(app.api, 'Partie toute seule', 'sans un clic non plus');
    await attendreServeur(async () => fichiers().includes('notes/partie-toute-seule.md'), 'la note part par la boucle', 60000);
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
