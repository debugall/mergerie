'use strict';
/* Ce qui PART VRAIMENT sur le réseau quand on commente un ticket.
 *
 * Le corps du commentaire était `textToAdf(t)` — `t`, la fonction de traduction — au lieu du
 * texte saisi : chaque commentaire posté sur Jira envoyait le CODE SOURCE d'une fonction.
 * Le mode démo ne passe pas par cette route, d'où l'absence de symptôme pendant des mois.
 * On ne teste donc pas la valeur de retour, on lit l'octet posté : c'est le seul endroit où
 * la faute était visible.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const jira = require('../src/jira.js');

function serveur(collecte) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        collecte.push({ url: req.url, method: req.method, body: data });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: '10001', created: '2026-09-07T09:00:00.000+0000' }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('Jira : le commentaire posté porte le texte saisi', () => {
  test('le corps ADF contient le texte, et rien du code de l’application', async () => {
    const recu = [];
    const s = await serveur(recu);
    const { port } = s.address();
    const cfg = {
      jira_url: `http://127.0.0.1:${port}`,
      jira_email: 'moi@example.test',
      jira_token: 'jeton',
    };
    const texte = 'Merge request !217 ouverte — relire le calcul de remise.';
    await jira.addComment(cfg, 'PROJ-1408', texte);
    s.close();

    assert.equal(recu.length, 1, 'un seul appel');
    assert.match(recu[0].url, /\/issue\/PROJ-1408\/comment$/);
    const envoye = JSON.parse(recu[0].body);
    const plat = JSON.stringify(envoye);
    assert.ok(plat.includes(texte), 'le texte saisi est bien dans le corps envoyé');
    // La signature de la faute : le corps portait du code, pas de la prose.
    assert.ok(!/function\s|=>|require\(/.test(plat), 'aucun code source ne part sur le réseau');
  });

  test('un commentaire vide est refusé avant tout appel réseau', async () => {
    const recu = [];
    const s = await serveur(recu);
    const { port } = s.address();
    const cfg = { jira_url: `http://127.0.0.1:${port}`, jira_email: 'a@b.c', jira_token: 'x' };
    await assert.rejects(() => jira.addComment(cfg, 'PROJ-1', '   '));
    s.close();
    assert.equal(recu.length, 0, 'rien n’est parti');
  });
});
