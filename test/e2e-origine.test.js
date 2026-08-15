'use strict';
/* D'OÙ VIENT CETTE REQUÊTE ?
 *
 * Mergerie n'écoute que sur la boucle locale — et ça ne protège de rien : c'est le navigateur
 * de l'utilisateur qui émet, et n'importe quelle page ouverte dans un autre onglet peut lui
 * faire poster ici. Un `<form method="POST">` part sans préflight, et les routes qui ne lisent
 * pas leur corps s'exécutent telles quelles : effacer tous les rapports, publier des
 * commentaires en attente sur une vraie merge request, lancer un agent sur des dossiers.
 *
 * Ce fichier vérifie la seule chose qui compte : une requête qui ÉCRIT en annonçant une autre
 * origine ne s'exécute pas — et on le prouve en regardant l'ÉTAT, pas le code de retour. Un
 * 403 qui aurait quand même effacé la base ne vaudrait rien.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('Origine des requêtes', () => {
  let app;

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { await app.stop(); });

  // `app.api` n'envoie pas d'`Origin` : on descend d'un cran pour en poser un à la main.
  const poster = (chemin, origine, methode = 'POST') => fetch(`${app.base}${chemin}`, {
    method: methode,
    headers: origine ? { Origin: origine, 'Content-Type': 'application/x-www-form-urlencoded' } : {},
  });

  /* LE SCÉNARIO RÉEL : un formulaire auto-soumis depuis une page tierce. `Content-Type`
     de formulaire, aucun préflight — le navigateur envoie, la route s'exécutait. */
  test('une page tierce ne peut pas effacer les rapports', async () => {
    app.db.prepare("INSERT INTO repo (id, project, url, enabled, created_at) VALUES (1, 'grp/app', 'x', 1, 'now')").run();
    app.db.prepare(`INSERT INTO mr (id, repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (1, 1, 42, 'MR', 'feat/x', 'main', 'reviewed', 'now')`).run();
    app.db.prepare("INSERT INTO review (mr_id, md_path, created_at, updated_at) VALUES (1, '/tmp/x.md', 'now', 'now')").run();

    const r = await poster('/api/reports/reset', 'https://evil.example');
    assert.equal(r.status, 403, 'la requête est refusée');
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM review').get().c, 1,
      'et SURTOUT : le rapport est toujours là — un 403 qui aurait quand même effacé ne vaudrait rien');
    assert.equal(app.db.prepare('SELECT status FROM mr WHERE id = 1').get().status, 'reviewed',
      'la merge request n’a pas été remise en file');
  });

  test('le refus dit ce qui s’est passé, sans jargon', async () => {
    const r = await poster('/api/reports/reset', 'https://evil.example');
    const { error } = await r.json();
    assert.match(error, /autre origine|other origin/i);
    assert.match(error, /onglet|tab/i, 'la phrase doit nommer le coupable probable : un autre onglet');
  });

  /* CE QUI DOIT CONTINUER DE PASSER. Une règle d'origine trop stricte casse plus qu'elle ne
     protège : l'application elle-même, et tout ce qui n'est pas un navigateur. */
  test('l’application elle-même passe, et les outils sans origine aussi', async () => {
    const chez = await poster('/api/reports/reset', app.base);
    assert.equal(chez.status, 200, 'l’origine de l’application est la sienne');

    // `curl`, un script maison, l'onglet « Commandes » : aucun `Origin`. Les refuser
    // casserait des usages légitimes sans rien empêcher — un navigateur en envoie toujours un.
    const sans = await poster('/api/reports/reset', null);
    assert.equal(sans.status, 200);
  });

  test('les lectures ne sont pas concernées', async () => {
    const r = await fetch(`${app.base}/api/status`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 200, 'un GET ne change rien, et la réponse reste illisible pour la page tierce');
  });

  // Une origine illisible n'est pas une absence d'origine : c'est une origine, et elle n'est
  // pas la nôtre. Le doute profite à la base, pas à l'appelant.
  test('une origine illisible est refusée', async () => {
    const r = await poster('/api/reports/reset', 'pas-une-url');
    assert.equal(r.status, 403);
  });

  test('la règle vaut aussi pour PUT et DELETE', async () => {
    for (const m of ['PUT', 'DELETE']) {
      const r = await poster('/api/repos/1', 'https://evil.example', m);
      assert.equal(r.status, 403, `${m} doit être refusé comme POST`);
    }
    assert.ok(app.db.prepare('SELECT 1 FROM repo WHERE id = 1').get(), 'le dépôt est toujours là');
  });
});
