'use strict';
/* MENU « RÉGLAGES » → DONNÉES PARTAGÉES — LES BOUTONS APRÈS LE RATTACHEMENT.
 *
 * `e2e-data-sync` éprouve « Cloner / rattacher » à l'écran, et le reste (synchroniser,
 * ré-envoyer, trancher un conflit) par l'API. Ici, les trois gestes qui restent, depuis
 * l'écran :
 *   - « Synchroniser maintenant » : une note partagée écrite depuis arrive dans le dépôt NU ;
 *   - « Tout ré-envoyer » : montre d'abord ce qui partira, renoncer n'envoie rien, confirmer
 *     remet dans un dépôt vidé à la main ce que la base porte de partageable ;
 *   - les conflits gardés : le témoin du pied de page mène au sous-onglet, « garder la leur »
 *     oublie, « reprendre la mienne » repose SA version, qui repart au tour suivant.
 *
 * La cadence est poussée à son maximum (600 s) : aucun tour automatique ne doit passer pendant
 * le fichier, sinon ce qu'on attribue à un bouton aurait pu venir de la boucle.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Réglages → Données partagées : synchroniser, ré-envoyer, trancher', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let nu; let racine;
  const erreurs = [];

  const gitNu = (...args) => execFileSync('git', ['-C', nu, ...args], { encoding: 'utf8' });
  const fichiers = () => gitNu('ls-tree', '-r', '--name-only', 'main').split('\n').filter((f) => f.trim());
  const contenu = (f) => gitNu('show', `main:${f}`);

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'partage-'));
    nu = path.join(racine, 'donnees.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
    await app.configure({ data_repo_url: nu, data_repo_branch: 'main', data_sync_seconds: '600' });
    const r = await app.api('POST', '/api/data-sync/attach', { url: nu });
    assert.equal(r.status, 200, r.text);
    await attendreServeur(async () => Boolean((await app.api('GET', '/api/data-sync')).body.dernierPush), 'le premier envoi');

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrir = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="datasync"]').click();
    await page.waitForSelector('#sub-datasync.active');
    await page.waitForFunction(() => document.querySelector('#dataSyncState').textContent.trim() !== '');
  };

  test('l’état dit que ce poste est rattaché, sans parler de mono-poste', async () => {
    await ouvrir();
    const etat = await page.locator('#dataSyncState').textContent();
    assert.doesNotMatch(etat, /mono-poste/);
    assert.match(etat, /Test/, 'l’identité git qui signera les commits est nommée');
  });

  test('« Synchroniser maintenant » envoie la note partagée écrite depuis', async () => {
    const { body: note } = await app.api('POST', '/api/notes', { title: 'Écrite après', content: '# après' });
    await app.api('PUT', `/api/notes/${note.id}`, { shared: 1 });
    assert.ok(!fichiers().some((f) => /ecrite-apres/.test(f)), 'rien n’est parti tout seul');
    await ouvrir();
    await page.locator('#btnDataNow').click();
    await attendreServeur(async () => fichiers().some((f) => /notes\/ecrite-apres\.md$/.test(f)), 'la note est dans le dépôt nu');
    await page.waitForFunction(() => !document.querySelector('#btnDataNow').disabled);
  });

  test('« Tout ré-envoyer » montre ce qui part ; renoncer n’envoie rien, confirmer remet tout', async () => {
    // On vide le dépôt À LA MAIN, comme depuis la forge.
    const vide = path.join(racine, 'vidage');
    execFileSync('git', ['clone', '-q', nu, vide], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'checkout', '-q', '--orphan', 'neuve'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'rm', '-rfq', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', 'vidé'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'push', '-q', '-f', 'origin', 'neuve:main'], { stdio: 'ignore' });
    const utiles = () => fichiers().filter((f) => !/^\./.test(f));
    assert.deepEqual(utiles(), []);

    /* Une synchro ordinaire d'abord : c'est elle qui ramène le vidage dans le répertoire de
       travail, contre lequel l'aperçu compte. Elle ne remet rien — c'est tout le propos du bouton
       suivant. */
    await ouvrir();
    const pullAvant = (await app.api('GET', '/api/data-sync')).body.dernierPull;
    await page.locator('#btnDataNow').click();
    await attendreServeur(async () => (await app.api('GET', '/api/data-sync')).body.dernierPull !== pullAvant, 'le vidage est ramené');
    await page.waitForFunction(() => !document.querySelector('#btnDataNow').disabled);
    assert.deepEqual(utiles(), [], 'synchroniser ne remet rien');

    await page.locator('#btnDataReexport').click();
    await page.waitForSelector('#confirmModal:not([hidden]) .apercu');
    const ajoutes = Number(await page.locator('#confirmBody .apercu-chiffre b').first().textContent());
    assert.ok(ajoutes > 0, `le dépôt est vide : l’aperçu compte des fichiers à poser (${ajoutes})`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.deepEqual(utiles(), [], 'renoncer n’a rien envoyé');

    await page.locator('#btnDataReexport').click();
    await page.waitForSelector('#confirmModal:not([hidden]) .apercu');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => utiles().some((f) => /notes\/ecrite-apres\.md$/.test(f)), 'le dépôt est de nouveau pourvu', 30000);
    assert.ok(utiles().some((f) => /settings\.json$/.test(f)), 'les réglages d’équipe compris');
    await page.waitForFunction(() => document.querySelector('#dataSyncInfo').textContent.trim() !== ''
      && !document.querySelector('#btnDataReexport').hasAttribute('data-busy'));
  });

  test('un conflit gardé : le pied de page y mène, « garder la leur » l’oublie, « reprendre la mienne » la renvoie', async () => {
    /* Deux conflits comme la synchro les garde (`garderVersionEcrasee`) : la version écrasée, et
       l'heure. Les provoquer pour de vrai demande deux postes qui écrivent le même document ; ce
       qu'on éprouve ici est l'écran qui les tranche. */
    const garder = app.db.prepare(`INSERT INTO local_state (kind, ref, key, value, updated_at)
      VALUES ('conflict', ?, ?, ?, ?)`);
    const maintenant = new Date().toISOString();
    garder.run('notes/conflit-mienne.md', 'mine', '# Ma version, reprise', maintenant);
    garder.run('notes/conflit-mienne.md', 'at', maintenant, maintenant);
    garder.run('notes/conflit-leur.md', 'mine', '# Version abandonnée', maintenant);
    garder.run('notes/conflit-leur.md', 'at', maintenant, maintenant);

    // Le témoin du pied de page le dit, et y mène.
    await page.reload();
    await page.waitForSelector('#footerSync[data-etat="conflit"]');
    await page.locator('#footerSync').click();
    await page.waitForSelector('#sub-datasync.active');
    await page.waitForSelector('#dataSyncConflicts .partage-conflit[data-file="notes/conflit-leur.md"]');
    assert.equal(await page.locator('#dataSyncConflicts .partage-conflit').count(), 2);
    assert.match(await page.locator('#dataSyncConflicts .partage-conflit[data-file="notes/conflit-mienne.md"] .partage-conflit-mienne').textContent(),
      /Ma version, reprise/, 'on LIT sa version avant de choisir');

    const conflits = async () => ((await app.api('GET', '/api/data-sync')).body.conflits || []).map((c) => c.fichier);
    await page.locator('#dataSyncConflicts .partage-conflit[data-file="notes/conflit-leur.md"] [data-keep="theirs"]').click();
    await attendreServeur(async () => !(await conflits()).includes('notes/conflit-leur.md'), 'le conflit est oublié');
    await page.waitForSelector('#dataSyncConflicts .partage-conflit[data-file="notes/conflit-leur.md"]', { state: 'detached' });

    await page.locator('#dataSyncConflicts .partage-conflit[data-file="notes/conflit-mienne.md"] [data-keep="mine"]').click();
    await attendreServeur(async () => (await conflits()).length === 0, 'plus aucun conflit');
    await page.waitForSelector('#dataSyncConflicts .partage-conflit', { state: 'detached' });
    // Sa version est reposée : le tour suivant l'envoie.
    await page.locator('#btnDataNow').click();
    await attendreServeur(async () => fichiers().includes('notes/conflit-mienne.md'), 'la version reprise est dans le dépôt');
    assert.match(contenu('notes/conflit-mienne.md'), /Ma version, reprise/);
    assert.ok(!fichiers().includes('notes/conflit-leur.md'), '« garder la leur » ne renvoie rien');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
