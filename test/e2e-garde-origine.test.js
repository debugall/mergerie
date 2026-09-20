'use strict';
/* LA PORTE — ce qui décide, avant toute route, si une requête a le droit d'entrer.
 *
 * Mergerie écoute sur 127.0.0.1 et se croyait donc à l'abri : seul l'utilisateur lui parle.
 * C'est faux dès qu'une page web est ouverte dans un autre onglet. Ce fichier éprouve les
 * portes qui manquaient — chacune par la requête qu'un attaquant enverrait, pas par l'intention :
 *
 *   — le REBINDING DNS : une page qui re-résout son nom vers 127.0.0.1 envoie `Host` et `Origin`
 *     à son propre nom. Le filtre d'origine les comparait l'un à l'autre, et les laissait passer ;
 *   — la LECTURE CROISÉE : une page d'un autre site qui interroge l'API ;
 *   — les GET À EFFET DE BORD, qui échappaient au filtre d'origine : la sauvegarde (la base avec
 *     ses jetons) et l'aperçu du dépôt de données (un `git ls-remote` vers l'adresse reçue) ;
 *   — la POLITIQUE DE CONTENU, vérifiée À L'ÉCRAN : une règle qui bloquerait Mermaid ou la
 *     dictée passerait tous les tests d'API et casserait l'outil ;
 *   — l'EXPOSITION au réseau, qui ne démarre plus sans jeton d'accès.
 *
 * `http.request` et non `fetch` : `Host` est un en-tête interdit pour `fetch`, qui refuse de le
 * poser — or c'est précisément lui qu'il faut forger.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { startApp, navigateurDispo, lancerNavigateur, attendreServeur } = require('./helpers/app');
const { manifeste, lireHtml } = require('./helpers/front');

const ROOT = path.join(__dirname, '..');
const ATTENTE = 20000;

/** Une requête brute : les en-têtes partent tels qu'on les écrit, `Host` compris. */
function brut(base, methode, chemin, { headers = {}, corps = null } = {}) {
  const u = new URL(base);
  return new Promise((ok, ko) => {
    const req = http.request({
      host: u.hostname, port: u.port, method: methode, path: chemin,
      headers: { ...(corps !== null ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let texte = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { texte += d; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, texte }));
    });
    req.on('error', ko);
    if (corps !== null) req.write(typeof corps === 'string' ? corps : JSON.stringify(corps));
    req.end();
  });
}

describe('La porte : Host, lecture croisée, en-têtes, politique de contenu', () => {
  let app;
  let port;
  before(async () => {
    app = await startApp();
    await app.configure();
    port = new URL(app.base).port;
  });
  after(async () => { if (app) await app.stop(); });

  test('un Host étranger est refusé (421), en lecture ET en écriture', async () => {
    /* La forme exacte d'une page rebindée : `Host` et `Origin` à SON nom, identiques. */
    const pirate = { host: `evil.example:${port}`, origin: `http://evil.example:${port}` };
    const lire = await brut(app.base, 'GET', '/api/config', { headers: pirate });
    assert.equal(lire.status, 421, 'la configuration ne se lit plus depuis un nom rebindé');
    assert.doesNotMatch(lire.texte, /access_token|gitlab_url/, 'et la réponse ne contient rien de la config');
    assert.match(lire.texte, /MERGERIE_ALLOWED_HOSTS/, 'le refus dit comment ouvrir un nom légitime');

    const ecrire = await brut(app.base, 'PUT', '/api/config', { headers: pirate, corps: { stale_mr_days: '9' } });
    assert.equal(ecrire.status, 421, 'et elle ne s’écrit pas non plus');
  });

  test('les noms légitimes passent : localhost, une IP, un nom déclaré', async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const r = await brut(app.base, 'GET', '/api/config', { headers: { host } });
      assert.equal(r.status, 200, `Host ${host} doit passer`);
    }
  });

  test('une page d’un autre site ne lit pas l’API, même en GET', async () => {
    const r = await brut(app.base, 'GET', '/api/config', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 403);
    // …un autre port de localhost est « same-site » : pas davantage.
    const voisin = await brut(app.base, 'GET', '/api/config', { headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(voisin.status, 403);
    // L'application elle-même, et un outil sans navigateur, passent.
    assert.equal((await brut(app.base, 'GET', '/api/config', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await brut(app.base, 'GET', '/api/config')).status, 200, 'curl n’envoie rien : il passe');
    // Ouvrir l'application depuis un lien doit marcher : la garde ne vise que l'API.
    const page = await brut(app.base, 'GET', '/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
    assert.equal(page.status, 200, 'suivre un lien vers Mergerie ouvre Mergerie');
  });

  test('la sauvegarde et l’aperçu ne sont plus des GET', async () => {
    assert.equal((await brut(app.base, 'GET', '/api/backup')).status, 404,
      'la base, jetons compris, ne se télécharge plus par un simple GET');
    const pirate = await brut(app.base, 'POST', '/api/backup', { headers: { origin: 'http://evil.example' }, corps: {} });
    assert.equal(pirate.status, 403, 'et le POST venu d’ailleurs est refusé par le filtre d’origine');
    const apercu = await brut(app.base, 'POST', '/api/data-sync/preview', { corps: { url: 'ext::sh -c touch% /tmp/mergerie-pwn' } });
    assert.equal(apercu.status, 400, 'une adresse `ext::` ne part jamais vers git');
    assert.match(JSON.parse(apercu.texte).error, /https|ssh/i, 'et le refus dit ce qui est admis');
  });

  test('toute réponse porte la politique de contenu, nosniff et no-referrer — et plus X-Powered-By', async () => {
    for (const chemin of ['/', '/api/config', '/' + manifeste().scripts[0]]) {
      const r = await brut(app.base, 'GET', chemin);
      assert.match(r.headers['content-security-policy'] || '', /script-src 'self'/, `${chemin} : CSP`);
      assert.match(r.headers['content-security-policy'] || '', /frame-ancestors 'none'/, `${chemin} : pas d’encadrement`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', `${chemin} : nosniff`);
      assert.equal(r.headers['referrer-policy'], 'no-referrer', `${chemin} : no-referrer`);
      assert.equal(r.headers['x-powered-by'], undefined, `${chemin} : la pile ne se présente plus`);
    }
    // …même un refus les porte : les en-têtes sont posés AVANT les gardes.
    const refus = await brut(app.base, 'GET', '/api/config', { headers: { host: 'evil.example' } });
    assert.match(refus.headers['content-security-policy'] || '', /script-src 'self'/);
  });

  test('un JSON illisible rend du JSON, pas une pile d’appels', async () => {
    const r = await brut(app.base, 'PUT', '/api/config', { corps: '{"pas du json' });
    assert.equal(r.status, 400);
    assert.match(r.headers['content-type'] || '', /json/);
    assert.doesNotMatch(r.texte, /at .*\.js:\d+|node_modules|\/Users\/|\/home\//, 'ni chemin ni pile dans la réponse');
  });

  test('la page d’index ne porte plus aucun script en ligne', () => {
    const html = lireHtml();
    const enLigne = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
    assert.equal(enLigne.length, 0, 'sous `script-src \'self\'`, un script en ligne ne s’exécuterait plus');
  });

  /* LA POLITIQUE À L'ÉCRAN. Une règle trop stricte passe tous les tests d'API et casse l'outil :
     Mermaid qui voudrait `eval`, un script en ligne oublié, une image en `data:`. On écoute les
     violations que le NAVIGATEUR signale, onglet par onglet, et on fait dessiner un diagramme. */
  test('sous la politique de contenu, l’écran se charge et Mermaid dessine', { skip: navigateurDispo().dispo ? false : 'chromium absent' }, async () => {
    await app.api('POST', '/api/notes', {
      title: 'Carte CSP', content: '# Carte\n\n```mermaid\ngraph TD\n  A[Front] --> B[API]\n```\n',
    });
    const navigateur = await lancerNavigateur();
    try {
      const page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
      await page.addInitScript(() => {
        window.__violations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__violations.push(`${e.violatedDirective} ← ${e.blockedURI || '(en ligne)'}`);
        });
      });
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e)));
      await page.goto(app.base);
      await page.waitForSelector('nav button[data-tab]');
      for (const onglet of ['review', 'task', 'agents', 'notes', 'jira', 'dashboard', 'admin']) {
        await page.locator(`nav button[data-tab="${onglet}"]`).click();
        await page.waitForFunction((o) => document.querySelector(`nav button[data-tab="${o}"]`).classList.contains('active'), onglet);
      }
      // Le diagramme : il faut qu'il DESSINE, pas seulement que la page se charge.
      await page.locator('nav button[data-tab="notes"]').click();
      await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
      await page.locator('#pageList .note-item', { hasText: 'Carte CSP' }).click();
      await page.waitForSelector('[data-mermaid-done] svg', { timeout: ATTENTE });

      const violations = await page.evaluate(() => window.__violations);
      assert.deepEqual(violations, [], `la politique de contenu ne bloque rien de légitime : ${violations.join(' | ')}`);
      assert.deepEqual(erreurs, []);
    } finally {
      await navigateur.close();
    }
  });
});

/* L'EXPOSITION AU RÉSEAU. Un processus à part : il faut un serveur lancé avec `HOST=0.0.0.0`,
   ce que le serveur en processus des autres tests n'est pas. */
describe('Exposé au réseau : pas de démarrage sans jeton, et le jeton exigé ensuite', () => {
  const portLibre = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
  function lancer(env) {
    const donnees = fs.mkdtempSync(path.join(os.tmpdir(), 'garde-expose-'));
    const e = { ...process.env, ...env, MERGERIE_DATA_DIR: donnees, COPILOT_DRY_RUN: '1' };
    delete e.MERGERIE_DEMO;
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    child.stdout.on('data', (d) => { sortie += d; }); child.stderr.on('data', (d) => { sortie += d; });
    return { child, sortie: () => sortie, donnees };
  }

  test('HOST=0.0.0.0 sans MERGERIE_ACCESS_TOKEN : le serveur refuse de démarrer, et dit quoi faire', async () => {
    const port = await portLibre();
    const { child, sortie } = lancer({ HOST: '0.0.0.0', PORT: String(port), MERGERIE_ACCESS_TOKEN: '' });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 1, 'un poste ouvert au réseau sans comptes ne démarre pas');
    assert.match(sortie(), /MERGERIE_ACCESS_TOKEN/, 'et le message nomme ce qu’il faut définir');
  });

  test('avec un jeton : rien sans lui, tout avec — par Bearer ou par la page d’accès', async () => {
    const port = await portLibre();
    const jeton = 'jeton-de-test-assez-long-pour-y-croire';
    const { child, sortie } = lancer({ HOST: '0.0.0.0', PORT: String(port), MERGERIE_ACCESS_TOKEN: jeton });
    const base = `http://127.0.0.1:${port}`;
    try {
      await attendreServeur(async () => (await brut(base, 'GET', '/acces').catch(() => null)) !== null, `démarrage\n${sortie()}`, ATTENTE);
      assert.equal((await brut(base, 'GET', '/api/config')).status, 401, 'sans jeton, l’API se tait');
      const racine = await brut(base, 'GET', '/');
      assert.equal(racine.status, 303, 'l’écran renvoie à la page d’accès');
      assert.equal(racine.headers.location, '/acces');
      assert.equal((await brut(base, 'GET', '/api/config', { headers: { authorization: `Bearer ${jeton}` } })).status, 200,
        'un script qui présente le jeton passe');
      assert.equal((await brut(base, 'GET', '/api/config', { headers: { authorization: 'Bearer faux' } })).status, 401);

      const mauvais = await brut(base, 'POST', '/acces', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, corps: 'jeton=faux' });
      assert.equal(mauvais.status, 401);
      const bon = await brut(base, 'POST', '/acces', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, corps: `jeton=${encodeURIComponent(jeton)}` });
      assert.equal(bon.status, 303, 'le bon jeton ouvre l’écran');
      const cookie = String(bon.headers['set-cookie'] || '');
      assert.match(cookie, /HttpOnly/, 'aucun script ne lit le cookie');
      assert.match(cookie, /SameSite=Strict/, 'aucun autre site ne le fait voyager');
      const avecCookie = await brut(base, 'GET', '/api/config', { headers: { cookie: cookie.split(';')[0] } });
      assert.equal(avecCookie.status, 200, 'et le cookie posé suffit ensuite');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  });
});
