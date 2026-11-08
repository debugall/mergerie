'use strict';
/* LE QUOTA D'APPELS DE JIRA : ce que fait `request` quand Jira répond 429 — attendre le délai
   demandé puis rejouer, et renoncer avec une erreur claire au bout de quelques essais ; et la
   borne de requêtes en vol, pour que deux écrans qui paginent ne fassent pas une rafale.
   Contre un faux Jira en HTTP, sans base ni navigateur. */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jira = require('../src/integrations/jira.js');

describe('request : 429 et Retry-After', () => {
  const serveurs = [];
  after(() => serveurs.forEach((s) => s.close()));
  function fauxJira(repondre) {
    const appels = [];
    const srv = http.createServer((req, res) => { appels.push({ path: req.url, at: Date.now() }); repondre(req, res, appels.length); });
    serveurs.push(srv);
    return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ cfg: { jira_url: `http://127.0.0.1:${srv.address().port}`, jira_email: 'a@b', jira_token: 't' }, appels })));
  }
  const json = (res, code, corps, entetes = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...entetes }); res.end(JSON.stringify(corps)); };

  test('un 429 avec Retry-After est rejoué après le délai, et l’appel aboutit', async () => {
    const { cfg, appels } = await fauxJira((req, res, n) => (n === 1 ? json(res, 429, {}, { 'retry-after': '1' }) : json(res, 200, { ok: true })));
    const r = await jira.jiraGet(cfg, '/rest/api/3/myself');
    assert.deepEqual(r, { ok: true });
    assert.equal(appels.length, 2);
    assert.ok(appels[1].at - appels[0].at >= 900, `attendu ~1 s entre les deux appels, vu ${appels[1].at - appels[0].at} ms`);
  });
  test('un 503 avec Retry-After est traité pareil ; un 503 sans en-tête est une erreur ordinaire', async () => {
    const a = await fauxJira((req, res, n) => (n === 1 ? json(res, 503, {}, { 'retry-after': '0' }) : json(res, 200, { ok: 1 })));
    assert.deepEqual(await jira.jiraGet(a.cfg, '/x'), { ok: 1 });
    const b = await fauxJira((req, res) => json(res, 503, { errorMessages: ['Maintenance'] }));
    await assert.rejects(() => jira.jiraGet(b.cfg, '/x'), /Jira 503/);
    assert.equal(b.appels.length, 1, 'pas de rejeu sans Retry-After');
  });
  test('au bout de trois rejeux encore en 429 : une erreur qui dit le quota, avec le délai annoncé', async () => {
    const { cfg, appels } = await fauxJira((req, res) => json(res, 429, {}, { 'retry-after': '0' }));
    await assert.rejects(() => jira.jiraGet(cfg, '/x'), (e) => e.code === 'JIRA_RATE_LIMITED' && /limite les appels|rate-limiting/.test(e.message));
    assert.equal(appels.length, 4, 'l’appel initial et trois rejeux');
  });
  test('au plus quatre requêtes en vol : la cinquième attend qu’une place se libère', async () => {
    let enCours = 0; let pic = 0;
    const { cfg } = await fauxJira((req, res) => {
      enCours += 1; pic = Math.max(pic, enCours);
      setTimeout(() => { enCours -= 1; json(res, 200, { ok: true }); }, 150);
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => jira.jiraGet(cfg, `/x/${i}`)));
    assert.equal(pic, 4);
  });
});
