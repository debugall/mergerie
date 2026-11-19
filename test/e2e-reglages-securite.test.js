'use strict';
/* RÉGLAGES → SÉCURITÉ : LE COFFRE DES JETONS ET LA 2FA.
 *
 * Activer chiffre les jetons du cœur ET les secrets des plugins par le mot de passe maître, et les
 * retire de la base en clair — jusque dans les octets du fichier. Verrouiller ferme l'application :
 * `GET /` sert la page de connexion, l'API répond 423. Le mot de passe (et le code TOTP, si la 2FA est
 * active) rouvre tout, les jetons intacts. Désactiver les remet en clair. Mot de passe oublié : la page
 * de connexion repart sans jetons, après « je confirme ». Tout passe par l'écran ; la base est relue
 * pour prouver ce qui est réellement écrit.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;
const MDP = 'cheval-correct-agrafe';
const MDP2 = 'batterie-agrafe-cheval';
const SECRET_PLUGIN = 'secret-du-plugin-hello-7c1f';

describe('Réglages → Sécurité : coffre des jetons et 2FA', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let db; let coffre; let jeton;
  const erreurs = [];

  before(async () => {
    app = await startApp({ plugins: ['hello'] });
    await app.configure();
    // Après `startApp()` : la base et le coffre sont ceux du test.
    db = require('../src/db');
    coffre = require('../src/data/coffre');
    jeton = db.prepare('SELECT access_token FROM local_config WHERE id = 1').get().access_token;
    assert.ok(jeton.length > 8, 'le faux GitLab a posé un jeton');
    db.prepare("INSERT INTO plugin_secret (plugin, key, value, updated_at) VALUES ('hello', 'token', ?, '')").run(SECRET_PLUGIN);
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirSecurite = async () => {
    await page.goto(app.base);
    await page.click('nav button[data-tab="admin"]');
    await page.click('#tab-admin .subnav [data-sub="security"]');
    await page.waitForSelector('#sub-security.active #secuEtat:not(:empty)', { timeout: ATTENTE });
  };
  const etat = async () => (await app.api('GET', '/api/coffre')).body;
  const attendreEtat = async (pred, quoi) => {
    for (let i = 0; i < 200; i += 1) { if (pred(await etat())) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`le coffre n'atteint pas : ${quoi}`);
  };
  const fichierContient = (texte) => ['reviewer.db', 'reviewer.db-wal']
    .some((f) => { try { return fs.readFileSync(path.join(app.dataDir, f)).includes(Buffer.from(texte)); } catch { return false; } });
  const codeMaintenant = (secret) => coffre.codeTotp(secret, Math.floor(Date.now() / 30000));
  const seConnecter = async (mdp, code) => {
    await page.fill('#coffreMdp', mdp);
    if (code) await page.fill('#coffreCode', code);
    await page.click('#coffreConnexion button[type="submit"]');
  };

  test('activer : mot de passe confirmé, jetons chiffrés, plus rien en clair dans le fichier', async () => {
    assert.equal(fichierContient(jeton), true, 'avant le coffre, le jeton est en clair dans la base');
    await ouvrirSecurite();
    assert.equal(await page.locator('#secuTotp').isDisabled(), true, 'la 2FA attend le coffre');
    await page.click('#secuActiver');
    await page.fill('#secuFormActiver [name="mdp"]', MDP);
    await page.fill('#secuFormActiver [name="confirmation"]', 'autre-chose-123');
    await page.click('#secuFormActiver button[type="submit"]');
    await page.waitForSelector('.toast', { hasText: 'ne correspondent pas', timeout: ATTENTE });
    assert.equal((await etat()).actif, false);

    await page.fill('#secuFormActiver [name="confirmation"]', MDP);
    await page.click('#secuFormActiver button[type="submit"]');
    await attendreEtat((e) => e.actif && !e.verrouille, 'actif');
    await page.waitForSelector('#secuDesactiver:not([hidden])');
    assert.equal(db.prepare('SELECT access_token FROM local_config WHERE id = 1').get().access_token, '');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plugin_secret').get().n, 0);
    assert.equal(fichierContient(jeton), false, 'ni la base ni son journal ne gardent le jeton');
    assert.equal(fichierContient(SECRET_PLUGIN), false, 'ni le secret du plugin');
    // L'application, elle, lit toujours ses jetons.
    assert.equal((await app.api('GET', '/api/config')).body.access_token, '***');
    assert.equal(coffre.magasinPlugins.get('hello', 'token'), SECRET_PLUGIN);
  });

  test('2FA : QR code, premier code, puis verrouiller ferme l’application jusqu’au mot de passe ET au code', async () => {
    await ouvrirSecurite();
    // La case ne se coche qu'une fois le premier code validé : on clique, puis on attend le QR code.
    await page.locator('#secuTotp').click();
    await page.waitForSelector('#secuFormTotp:not([hidden]) #secuQr svg', { timeout: ATTENTE });
    const secret = (await page.locator('#secuSecret').textContent()).replace(/\s/g, '');
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await page.fill('#secuFormTotp [name="code"]', '000000' === codeMaintenant(secret) ? '111111' : '000000');
    await page.click('#secuFormTotp button[type="submit"]');
    await page.waitForSelector('.toast', { hasText: 'Code incorrect', timeout: ATTENTE });
    await page.fill('#secuFormTotp [name="code"]', codeMaintenant(secret));
    await page.click('#secuFormTotp button[type="submit"]');
    await attendreEtat((e) => e.totp, '2FA active');

    await page.click('#secuVerrouiller');
    await page.waitForSelector('#coffreConnexion #coffreCode', { timeout: ATTENTE });
    const ferme = await app.api('GET', '/api/config');
    assert.equal(ferme.status, 423);
    assert.equal(ferme.body.code, 'COFFRE_VERROUILLE');
    assert.equal(coffre.magasinPlugins.get('hello', 'token'), '', 'verrouillé, un plugin ne lit rien');

    await seConnecter(MDP, '123456' === codeMaintenant(secret) ? '654321' : '123456');

    await page.waitForSelector('#coffreConnexion .err', { timeout: ATTENTE });
    assert.match(await page.locator('#coffreConnexion .err').textContent(), /incorrect/);
    await seConnecter(MDP, codeMaintenant(secret));
    await page.waitForSelector('nav button[data-tab="admin"]', { timeout: ATTENTE });
    // Les plugins, arrêtés au verrouillage, repartent au déverrouillage.
    for (let i = 0; ; i += 1) {
      const hello = (await app.api('GET', '/api/plugins')).body.plugins.find((p) => p.name === 'hello');
      if (hello && hello.active) break;
      if (i > 200) throw new Error('le plugin hello ne repart pas après le déverrouillage');
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await app.api('GET', '/api/config')).body.access_token, '***');
    assert.equal(coffre.magasinPlugins.get('hello', 'token'), SECRET_PLUGIN);
  });

  test('2FA désactivée par le mot de passe, puis changer le mot de passe maître', async () => {
    await ouvrirSecurite();
    await page.locator('#secuTotp').click();
    await page.fill('#secuFormTotpOff [name="mdp"]', MDP);
    await page.click('#secuFormTotpOff button[type="submit"]');
    await attendreEtat((e) => !e.totp, '2FA retirée');

    await page.click('#secuChanger');
    await page.fill('#secuFormMdp [name="ancien"]', 'pas-le-bon-mdp');
    await page.fill('#secuFormMdp [name="nouveau"]', MDP2);
    await page.fill('#secuFormMdp [name="confirmation"]', MDP2);
    await page.click('#secuFormMdp button[type="submit"]');
    await page.waitForSelector('.toast', { hasText: 'incorrect', timeout: ATTENTE });
    await page.fill('#secuFormMdp [name="ancien"]', MDP);
    await page.click('#secuFormMdp button[type="submit"]');
    await page.waitForSelector('#secuFormMdp[hidden]', { state: 'attached', timeout: ATTENTE });

    assert.equal((await app.api('POST', '/api/coffre/verrouiller')).status, 200);
    await page.goto(app.base);
    await page.waitForSelector('#coffreConnexion', { timeout: ATTENTE });
    assert.equal(await page.locator('#coffreCode').count(), 0, 'sans 2FA, pas de code demandé');
    await seConnecter(MDP);
    await page.waitForSelector('#coffreConnexion .err', { timeout: ATTENTE });
    await seConnecter(MDP2);
    await page.waitForSelector('nav button[data-tab="admin"]', { timeout: ATTENTE });
    assert.equal((await etat()).verrouille, false);
  });

  test('désactiver : les jetons redeviennent lisibles en clair, là où ils étaient', async () => {
    await ouvrirSecurite();
    await page.click('#secuDesactiver');
    await page.fill('#secuFormDesactiver [name="mdp"]', MDP2);
    await page.click('#secuFormDesactiver button[type="submit"]');
    await attendreEtat((e) => !e.actif, 'inactif');
    await page.waitForSelector('#secuActiver:not([hidden])');
    assert.equal(db.prepare('SELECT access_token FROM local_config WHERE id = 1').get().access_token, jeton);
    assert.equal(db.prepare("SELECT value FROM plugin_secret WHERE plugin = 'hello' AND key = 'token'").get().value, SECRET_PLUGIN);
  });

  test('mot de passe oublié : « je confirme » détruit les jetons et ouvre les réglages pour les ressaisir', async () => {
    assert.equal((await app.api('POST', '/api/coffre/activer', { mdp: MDP, confirmation: MDP })).status, 200);
    assert.equal((await app.api('POST', '/api/coffre/verrouiller')).status, 200);
    await page.goto(app.base);
    await page.waitForSelector('#coffreConnexion', { timeout: ATTENTE });
    await page.click('details summary');
    await page.fill('#coffrePhrase', 'oui');
    await page.click('#coffreReset button[type="submit"]');
    await page.waitForSelector('#coffreReset .err', { timeout: ATTENTE });
    assert.equal((await app.api('GET', '/api/coffre')).status, 423, 'toujours verrouillé : l’API reste fermée');

    await page.fill('#coffrePhrase', 'Je confirme');
    await page.click('#coffreReset button[type="submit"]');
    await page.waitForSelector('#sub-gitcfg.active', { timeout: ATTENTE });
    await page.waitForSelector('.toast', { hasText: 'ressaisis', timeout: ATTENTE });
    const e = await etat();
    assert.equal(e.actif, false);
    assert.equal((await app.api('GET', '/api/config')).body.access_token, '', 'les jetons sont à ressaisir');
    assert.equal(coffre.magasinPlugins.get('hello', 'token'), '');
    assert.equal(db.prepare('SELECT donnees FROM coffre WHERE id = 1').get().donnees, '');
  });

  test('le TOTP suit la RFC 6238 (vecteurs SHA-1, six chiffres)', () => {
    const secret = coffre.base32(Buffer.from('12345678901234567890'));
    assert.equal(coffre.codeTotp(secret, Math.floor(59 / 30)), '287082');
    assert.equal(coffre.codeTotp(secret, Math.floor(1111111109 / 30)), '081804');
    assert.equal(coffre.codeTotp(secret, Math.floor(2000000000 / 30)), '279037');
    assert.deepEqual(coffre.deBase32(secret), Buffer.from('12345678901234567890'));
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
