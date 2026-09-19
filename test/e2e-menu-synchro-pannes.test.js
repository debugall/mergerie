'use strict';
/* MENU « RÉGLAGES » → DONNÉES PARTAGÉES — QUAND LE DÉPÔT NE RÉPOND PAS COMME PRÉVU.
 *
 * `e2e-data-sync` et `e2e-menu-reglages-partage` éprouvent la synchro qui MARCHE. Ici, tout ce
 * qui peut mal tourner entre ce poste et le dépôt d'équipe, vu depuis l'écran :
 *   — les adresses qu'on refuse AVANT d'appeler git (vide, http:// en clair, ext::, un tiret en
 *     tête, un chemin relatif) — et rien n'est enregistré ;
 *   — une clé SSH refusée, une machine injoignable : l'état et le pied de page disent POURQUOI,
 *     les écritures restent commitées ici (↑1), et tout part dès que l'accès revient ;
 *   — la course « un collègue a poussé entre mon fetch et mon push » : le push refusé est rejoué,
 *     et les deux travaux arrivent des deux côtés ;
 *   — une branche protégée qui refuse TOUT push : l'écran doit le dire ;
 *   — détacher (vider l'adresse), puis se rattacher : rien ne part entre-temps, tout part après.
 *
 * LE TRANSPORT EST RÉEL. L'adresse est `git@equipe.test:donnees.git` ; un faux `ssh` (posé dans
 * `GIT_SSH_COMMAND`) la mène à un dépôt nu local, et un interrupteur sur le disque le fait
 * répondre « Permission denied (publickey) » ou « Connection refused » — les messages que git
 * rend vraiment. L'application n'est ni simulée ni contournée : c'est git qui échoue.
 *
 * La cadence est à 600 s : aucun tour automatique ne passe pendant le fichier, chaque effet vient
 * du geste qu'on vient de faire. Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');
const {
  fauxSsh, crochetCourse, crochetRefus, retirerCrochet, pousserNoteCollegue,
} = require('./helpers/synchro-git');

const { dispo } = navigateurDispo();
const ADRESSE = 'git@equipe.test:donnees.git';

describe('Menu Réglages → Données partagées : pannes, refus et reprise', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let racine; let nu; let ssh;
  const erreurs = [];
  let ancienSsh;

  const gitNu = (...args) => execFileSync('git', ['-C', nu, ...args], { encoding: 'utf8' });
  const fichiers = () => {
    try { return gitNu('ls-tree', '-r', '--name-only', 'main').split('\n').filter((f) => f.trim()); } catch { return []; }
  };
  const etat = async () => (await app.api('GET', '/api/data-sync')).body;
  const creerNotePartagee = async (titre) => {
    const { body } = await app.api('POST', '/api/notes', { title: titre, content: `# ${titre}` });
    await app.api('PUT', `/api/notes/${body.id}`, { shared: 1 });
    return body.id;
  };

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'pannes-'));
    nu = path.join(racine, 'donnees.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
    ssh = fauxSsh(racine, nu);
    /* Le serveur tourne DANS ce processus : ses `git` héritent de cet environnement. */
    ancienSsh = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = ssh.commande;
    await app.configure();

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (ancienSsh === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = ancienSsh;
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Le sous-onglet, avec son état CHARGÉ : `#dataSyncState` se remplit d'une réponse
     asynchrone, et c'est elle qu'on vient lire. */
  const ouvrir = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="datasync"]').click();
    await page.waitForSelector('#sub-datasync.active');
    await page.waitForFunction(() => document.querySelector('#dataSyncState').textContent.trim() !== '');
    await page.waitForLoadState('networkidle');
  };
  const champ = (nom) => page.locator(`#sub-datasync [form="configForm"][name="${nom}"]`);
  // Un toast NEUF : on retire les anciens avant le geste, sinon on lirait celui d'avant.
  const oublierToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const toastErreur = (re) => page.locator('.toast.err', { hasText: re }).first().waitFor({ state: 'visible' });

  /* Le pied de page se relit toutes les quinze secondes : plutôt que d'attendre le battement,
     on recharge — il se relit au chargement, et c'est l'état SERVEUR qu'on veut voir. */
  const piedApresRechargement = async (etatAttendu) => {
    await page.reload();
    await page.waitForSelector(`#footerSync:not([hidden])[data-etat="${etatAttendu}"]`);
  };

  /* « Synchroniser maintenant » cliqué, et sa RÉPONSE attendue — puis l'état redessiné. */
  const synchroniserDepuisLEcran = async () => {
    await ouvrir();
    const [rep] = await Promise.all([
      page.waitForResponse((r) => /\/api\/data-sync\/now$/.test(r.url()) && r.request().method() === 'POST', { timeout: 60000 }),
      page.locator('#btnDataNow').click(),
    ]);
    await page.waitForFunction(() => !document.querySelector('#btnDataNow').disabled);
    return rep;
  };

  test('les adresses qu’on ne joint pas sont refusées à l’écran, avant git — et rien n’est enregistré', async () => {
    await ouvrir();
    // Vide : le bouton le dit sans rien demander au serveur.
    await champ('data_repo_url').fill('');
    await oublierToasts();
    await page.locator('#btnDataAttach').click();
    await toastErreur(/Renseignez l.URL du dépôt de données/);

    for (const adresse of [
      'http://gitlab.interne/equipe/donnees.git',   // en clair : le jeton passerait en clair
      'ext::sh -c touch% /tmp/mergerie-ext',         // une COMMANDE, pas une adresse
      '--upload-pack=touch /tmp/mergerie-option',     // une OPTION de git
      'donnees.git',                                  // relatif : relatif à quoi ?
    ]) {
      await champ('data_repo_url').fill(adresse);
      await oublierToasts();
      await page.locator('#btnDataAttach').click();
      await toastErreur(/Adresse refusée/);
      assert.equal(await page.locator('#confirmModal:not([hidden])').count(), 0,
        `aucun récapitulatif pour une adresse refusée (${adresse})`);

      // …et « Enregistrer seulement » ne la range pas davantage.
      await oublierToasts();
      await page.locator('#sub-datasync button[type="submit"][form="configForm"]').click();
      await toastErreur(/Adresse refusée/);
      assert.equal((await app.api('GET', '/api/config')).body.data_repo_url || '', '',
        `l’adresse refusée n’est pas en base (${adresse})`);
    }
    assert.ok(!fs.existsSync('/tmp/mergerie-ext') && !fs.existsSync('/tmp/mergerie-option'),
      'aucune des commandes glissées dans l’adresse n’a tourné');
    assert.equal((await etat()).configure, false);
    assert.equal(await page.locator('#footerSync').isHidden(), true, 'toujours mono-poste : le pied de page se tait');
  });

  test('rattacher par SSH (git@…) initialise le dépôt, et le pied de page passe au vert', async () => {
    await creerNotePartagee('Avant le rattachement');
    await ouvrir();
    await champ('data_repo_url').fill(ADRESSE);
    await champ('data_repo_branch').fill('main');
    await champ('data_sync_seconds').fill('600');
    await page.locator('#btnDataAttach').click();
    await page.waitForSelector('#confirmModal:not([hidden]) .apercu-tete-init');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => Boolean((await etat()).dernierPush), 'le premier envoi par SSH');
    assert.equal((await etat()).erreur, null);
    assert.ok(fichiers().includes('notes/avant-le-rattachement.md'), 'la note est dans le dépôt nu, arrivée par le transport SSH');
    await piedApresRechargement('ok');
  });

  test('clé SSH refusée : l’écran dit pourquoi, l’écriture reste commitée ici, et part au retour de l’accès', async () => {
    await creerNotePartagee('Écrite sans accès');
    ssh.mode('refus');
    try {
      await synchroniserDepuisLEcran();
      await page.waitForFunction(() => /Permission denied \(publickey\)/.test(document.querySelector('#dataSyncState').textContent));
      const texte = await page.locator('#dataSyncState').textContent();
      assert.match(texte, /↑1/, `le commit attend ici, il n’est pas perdu : ${texte}`);
      assert.ok(!fichiers().includes('notes/ecrite-sans-acces.md'), 'rien n’est parti');
      await piedApresRechargement('horsligne');
    } finally { ssh.mode('ok'); }

    // L'accès revient : un clic sur le témoin du pied de page relance un tour.
    await page.locator('#footerSync').click();
    await attendreServeur(async () => fichiers().includes('notes/ecrite-sans-acces.md'), 'la note part au retour de l’accès');
    await attendreServeur(async () => (await etat()).erreur === null, 'l’erreur est oubliée');
    await piedApresRechargement('ok');
    assert.match(await page.locator('#footerSyncTxt').textContent(), /↑0 ↓0/);
  });

  test('machine injoignable : même chose, avec le message du réseau', async () => {
    ssh.mode('injoignable');
    try {
      await synchroniserDepuisLEcran();
      await page.waitForFunction(() => /Connection refused/.test(document.querySelector('#dataSyncState').textContent));
      await piedApresRechargement('horsligne');
    } finally { ssh.mode('ok'); }
    await synchroniserDepuisLEcran();
    await page.waitForFunction(() => !/hors ligne|Connection refused/.test(document.querySelector('#dataSyncState').textContent));
    await piedApresRechargement('ok');
  });

  test('un collègue pousse entre mon fetch et mon push : le refus est rejoué, et les deux travaux arrivent', async () => {
    /* Le commit de Claire est DÉJÀ dans le dépôt nu, sous une autre branche ; le crochet le fait
       passer sur `main` au moment exact où notre push arrive, et refuse notre push. */
    const chezClaire = path.join(racine, 'claire');
    pousserNoteCollegue({ nu, dossier: chezClaire, slug: 'course-de-claire', titre: 'Course de Claire',
      contenu: '# Poussée pendant la mienne\n', ref: 'collegue' });
    const course = crochetCourse(nu, 'refs/heads/collegue');
    try {
      await creerNotePartagee('Course de moi');
      await synchroniserDepuisLEcran();
      await attendreServeur(async () => {
        const f = fichiers();
        return f.includes('notes/course-de-moi.md') && f.includes('notes/course-de-claire.md');
      }, 'les deux notes sont sur main', 30000);
    } finally { retirerCrochet(nu); }
    assert.equal(course.jouee(), true, 'la course a bien eu lieu : le premier push a été refusé');
    assert.equal((await etat()).erreur, null, 'un push refusé puis rejoué n’est pas une panne');
    const auteurs = gitNu('log', '--format=%an', 'main').split('\n');
    assert.ok(auteurs.includes('Claire') && auteurs.includes('Test'), `les deux signatures sont dans l’historique : ${auteurs}`);

    // …et la note de Claire, reçue au passage, s'affiche dans Notes.
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    await page.waitForSelector('#pageList .note-item:has-text("Course de Claire")');
  });

  test('une branche protégée refuse tout push : l’écran le dit au lieu d’afficher « à jour »', async () => {
    crochetRefus(nu);
    try {
      await creerNotePartagee('Refusée par la forge');
      const pullAvant = (await etat()).dernierPull;
      await synchroniserDepuisLEcran();
      await attendreServeur(async () => (await etat()).dernierPull !== pullAvant, 'le tour est allé au bout');
      assert.ok(!fichiers().includes('notes/refusee-par-la-forge.md'), 'la forge a bien refusé le push');
      const e = await etat();
      assert.equal(e.enAvance, 1, 'le commit attend ici');
      assert.ok(e.erreur, `le refus doit se lire dans l’état, pas « à jour » : ${JSON.stringify(e)}`);
      await piedApresRechargement('horsligne');
    } finally {
      retirerCrochet(nu);
      // On repart propre pour la suite : le commit en attente part maintenant que la forge accepte.
      await app.api('POST', '/api/data-sync/now');
      await attendreServeur(async () => fichiers().includes('notes/refusee-par-la-forge.md'), 'la note part une fois le refus levé');
    }
  });

  test('détacher : vider l’adresse repasse en mono-poste — le pied de page se tait et plus rien ne part', async () => {
    await ouvrir();
    await champ('data_repo_url').fill('');
    await page.locator('#sub-datasync button[type="submit"][form="configForm"]').click();
    await attendreServeur(async () => ((await app.api('GET', '/api/config')).body.data_repo_url || '') === '', 'l’adresse est vidée en base');
    await page.waitForFunction(() => /mono-poste/.test(document.querySelector('#dataSyncState').textContent));
    await page.reload();
    await page.waitForSelector('nav button[data-tab="admin"]');
    await page.waitForFunction(() => document.querySelector('#footerSync').hidden);

    const avant = gitNu('rev-parse', 'main').trim();
    await creerNotePartagee('Pendant le détachement');
    await synchroniserDepuisLEcran();
    assert.equal(gitNu('rev-parse', 'main').trim(), avant, 'détaché, ce poste n’envoie plus rien');
    assert.ok(!fichiers().includes('notes/pendant-le-detachement.md'));
  });

  test('se rattacher de nouveau : l’aperçu dit « rejoindre », et ce qui a été écrit entre-temps part', async () => {
    await ouvrir();
    await champ('data_repo_url').fill(ADRESSE);
    await page.locator('#btnDataAttach').click();
    await page.waitForSelector('#confirmModal:not([hidden]) .apercu-tete-rejoint');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await etat()).configure === true, 'rattaché');
    await page.waitForFunction(() => !document.querySelector('#btnDataAttach').disabled);
    await synchroniserDepuisLEcran();
    await attendreServeur(async () => fichiers().includes('notes/pendant-le-detachement.md'), 'la note écrite détachée est partie');
    // Rien de ce qui était déjà là n'a été perdu en route.
    for (const f of ['notes/avant-le-rattachement.md', 'notes/course-de-claire.md', 'notes/course-de-moi.md']) {
      assert.ok(fichiers().includes(f), `${f} est toujours dans le dépôt`);
    }
    await piedApresRechargement('ok');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
