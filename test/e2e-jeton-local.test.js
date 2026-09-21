'use strict';
/* L'API N'APPARTIENT QU'AU NAVIGATEUR DE L'UTILISATEUR (plan_secure.md, lot B, S1).
 *
 * `e2e-origine.test.js` prouve qu'une PAGE tierce ne peut pas écrire ici. Ce fichier prouve
 * l'autre moitié : un PROCESSUS du poste — sans navigateur, sans `Origin`, sans `Sec-Fetch-Site`
 * — ne le peut pas non plus, sauf à porter le jeton de session local. Et qu'une adresse de
 * service qui change n'emporte pas le jeton de forge stocké vers elle.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers/app');

describe('Le jeton de session local', () => {
  let app;

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { await app.stop(); });

  test('sans cookie ni Bearer, /api est fermée — comme le ferait un processus quelconque du poste', async () => {
    const r = await fetch(`${app.base}/api/config`);
    assert.equal(r.status, 401);
    const { error, code } = await r.json();
    assert.match(error, /jeton|token/i);
    // Le front distingue « pas de jeton du tout » (recharger ne suffirait pas) d'un jeton
    // périmé par un redémarrage du serveur — même code ici, le cas qui compte est testé plus bas.
    assert.equal(code, 'JETON_LOCAL');
  });

  test('un Bearer faux est refusé comme une absence', async () => {
    const r = await fetch(`${app.base}/api/config`, { headers: { Authorization: 'Bearer pas-le-bon' } });
    assert.equal(r.status, 401);
  });

  /* Express route SANS tenir compte de la casse (pas de `case sensitive routing`) : `GET
     /API/config` atteint la même route que `/api/config`. Une garde sensible à la casse la
     laisserait passer sans jeton — exactement le processus sans navigateur que ce jeton ferme. */
  test('la casse de l’URL ne contourne pas la garde', async () => {
    const r = await fetch(`${app.base}/API/config`);
    assert.equal(r.status, 401);
  });

  test('avec le jeton écrit sur disque au démarrage, /api répond', async () => {
    const r = await fetch(`${app.base}/api/config`, { headers: { Authorization: `Bearer ${app.localToken}` } });
    assert.equal(r.status, 200);
  });

  test('GET / pose le cookie du jeton local', async () => {
    const r = await fetch(`${app.base}/`, { redirect: 'manual' });
    const cookies = r.headers.get('set-cookie') || '';
    assert.match(cookies, /mergerie_local=/);
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /SameSite=Strict/i);
  });

  test('ce cookie, seul, suffit pour /api — sans Bearer', async () => {
    const page = await fetch(`${app.base}/`, { redirect: 'manual' });
    const cookieHeader = (page.headers.get('set-cookie') || '').split(';')[0];
    const r = await fetch(`${app.base}/api/config`, { headers: { Cookie: cookieHeader } });
    assert.equal(r.status, 200);
  });

  test('le fichier du jeton est privé (0600)', () => {
    const st = fs.statSync(path.join(app.dataDir, 'local-token'));
    assert.equal(st.mode & 0o777, 0o600);
  });

  test('changer gitlab_url sans jeton frais vide le jeton stocké', async () => {
    const avant = await app.api('GET', '/api/config');
    assert.equal(avant.body.access_token, '***', 'le décor a bien un jeton configuré');

    const r = await app.api('PUT', '/api/config', { gitlab_url: 'https://gitlab-evil.example' });
    assert.equal(r.status, 200);
    assert.equal(r.body.access_token, '', 'plus rien à masquer : le jeton a été vidé');
    assert.equal(app.db.prepare('SELECT access_token AS a FROM local_config WHERE id = 1').get().a, '');

    await app.configure(); // on rend le décor tel qu'on l'a trouvé, pour les tests suivants
  });

  test('un jeton FRAIS envoyé dans la même requête n’est jamais effacé', async () => {
    const r = await app.api('PUT', '/api/config', {
      gitlab_url: 'https://gitlab-autre.example', access_token: 'glpat-frais',
    });
    assert.equal(r.status, 200);
    assert.equal(app.db.prepare('SELECT access_token AS a FROM local_config WHERE id = 1').get().a, 'glpat-frais');
    await app.configure();
  });

  test('un chemin différent sur la MÊME origine n’invalide rien', async () => {
    const r = await app.api('PUT', '/api/config', { gitlab_url: `${app.gitlabUrl}/sous-chemin` });
    assert.equal(r.status, 200);
    assert.equal(app.db.prepare('SELECT access_token AS a FROM local_config WHERE id = 1').get().a, app.state.token,
      'même origine : le jeton reste');
    await app.configure();
  });
});
