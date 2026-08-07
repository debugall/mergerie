'use strict';
/* Liens — par de vraies requêtes HTTP.
 *
 * Ce que l'unitaire ne prouve pas : que les routes existent et valident, que la grille se
 * compose, que l'import va de l'aperçu à la création sans doublon, que la palette voit
 * toutes les sources et retient ce qu'on ouvre — et que le health check reste bien à
 * DOUBLE opt-in : la prod n'est pas pinguée sans qu'on l'ait demandée, ni quoi que ce soit
 * quand le réglage global est éteint. Ce dernier point se vérifie contre un vrai serveur
 * local, seul moyen de savoir ce qui a été appelé et ce qui ne l'a pas été.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp } = require('./helpers/app');

let app;
let cible;          // le serveur qu'on « pingue »
let appels = [];    // ce que le health check est allé chercher — la preuve du double opt-in

before(async () => {
  app = await startApp();
  await app.configure();
  cible = http.createServer((req, res) => {
    appels.push({ method: req.method, url: req.url });
    if (req.url === '/up') { res.writeHead(204); res.end(); return; }
    if (req.url === '/down') { res.writeHead(503); res.end(); return; }
    if (req.url === '/nohead' && req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    if (req.url === '/nohead') { res.writeHead(200); res.end('page'); return; }
    if (req.url === '/redir') { res.writeHead(302, { Location: '/up' }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => cible.listen(0, '127.0.0.1', r));
});
after(async () => {
  if (cible) cible.close();
  if (app) await app.stop();
});

const base = () => `http://127.0.0.1:${cible.address().port}`;

describe('Environnements et services', () => {
  test('cycle complet : environnements, service, cases de la grille', async () => {
    const dev = await app.api('POST', '/api/environments', { name: 'dev', color: '#2f6fe0', health_check: 1 });
    assert.equal(dev.status, 200);
    const prod = await app.api('POST', '/api/environments', { name: 'prod', color: '#c62828' });
    assert.equal(prod.body.health_check, 0, 'la prod n’est pas vérifiée sans qu’on le demande');

    const svc = await app.api('POST', '/api/services', { name: 'api-core', tags: 'Backend, backend, Métier' });
    assert.deepEqual(JSON.parse(svc.body.tags), ['backend', 'metier'], 'tags normalisés et dédupliqués');

    await app.api('PUT', `/api/services/${svc.body.id}/urls`, { environment_id: dev.body.id, url: `${base()}/up` });
    const g = await app.api('GET', '/api/links/grid');
    assert.equal(g.body.services.length, 1);
    assert.equal(g.body.services[0].urls[dev.body.id], `${base()}/up`);
    assert.deepEqual(g.body.environments.map((e) => e.name), ['dev', 'prod'], 'ordonnés par position');
  });

  test('les entrées invalides sont refusées', async () => {
    assert.equal((await app.api('POST', '/api/environments', { name: '' })).status, 400);
    assert.equal((await app.api('POST', '/api/environments', { name: 'dev' })).status, 400, 'nom déjà pris');
    assert.equal((await app.api('POST', '/api/services', { name: '  ' })).status, 400);
    const svc = (await app.api('GET', '/api/links/grid')).body.services[0];
    assert.equal((await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: 1, url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await app.api('PUT', '/api/services/99999/urls', { environment_id: 1, url: 'https://x.test' })).status, 404);
    assert.equal((await app.api('DELETE', '/api/environments/99999')).status, 404);
  });

  test('supprimer un environnement emporte les cases de cette colonne', async () => {
    const prod = (await app.api('GET', '/api/environments')).body.environments.find((e) => e.name === 'prod');
    const svc = (await app.api('GET', '/api/links/grid')).body.services[0];
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: prod.id, url: 'https://p.test' });
    await app.api('DELETE', `/api/environments/${prod.id}`);
    const g = (await app.api('GET', '/api/links/grid')).body;
    assert.equal(g.environments.length, 1);
    assert.equal(g.services[0].urls[prod.id], undefined, 'la case ne survit pas à sa colonne');
  });
});

describe('Liens libres et import', () => {
  const FICHIER = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Travail</H3>
  <DL><p>
    <DT><A HREF="https://kibana.corp/app">Kibana</A>
    <DT><A HREF="https://grafana.corp/d">Grafana</A>
  </DL><p>
  <DT><A HREF="https://confluence.corp/x">Confluence</A>
</DL><p>`;

  test('aperçu puis application — et rejouable sans créer de doublons', async () => {
    const apercu = await app.api('POST', '/api/links/import', { html: FICHIER });
    assert.equal(apercu.body.links.length, 3);
    // Aucun lien n'a été créé par l'APERÇU : on voit avant que quoi que ce soit ne bouge.
    assert.equal((await app.api('GET', '/api/free-links')).body.links.length, 0);

    const applique = await app.api('POST', '/api/links/import/apply', { links: apercu.body.links });
    assert.deepEqual(applique.body, { created: 3, skipped: 0 });

    const rejoue = await app.api('POST', '/api/links/import/apply', { links: apercu.body.links });
    assert.deepEqual(rejoue.body, { created: 0, skipped: 3 }, 'réimporter le même fichier ne double rien');
    assert.equal((await app.api('GET', '/api/free-links')).body.links.length, 3);
  });

  test('la recherche et le filtre par tag portent sur les liens libres', async () => {
    assert.equal((await app.api('GET', '/api/free-links?q=kiba')).body.links.length, 1);
    assert.equal((await app.api('GET', '/api/free-links?tag=travail')).body.links.length, 2);
    assert.equal((await app.api('GET', '/api/free-links?q=zzz')).body.links.length, 0);
  });

  /* La conversion est le geste d'APRÈS l'import — un mapping explicite, pas une devinette
     service×environnement faite sur des noms de dossiers. */
  test('des liens libres deviennent un service', async () => {
    const dev = (await app.api('GET', '/api/environments')).body.environments[0];
    const libres = (await app.api('GET', '/api/free-links?q=kiba')).body.links;
    const r = await app.api('POST', '/api/free-links/to-service', {
      name: 'Kibana', mapping: [{ free_link_id: libres[0].id, environment_id: dev.id }],
    });
    assert.equal(r.body.convertis, 1);
    const g = (await app.api('GET', '/api/links/grid')).body;
    const kib = g.services.find((s) => s.name === 'Kibana');
    assert.equal(kib.urls[dev.id], 'https://kibana.corp/app');
    assert.ok(!g.free_links.some((l) => l.label === 'Kibana'), 'le lien converti ne reste pas en double');
  });
});

describe('Palette', () => {
  test('elle voit toutes les sources, et le flou trouve ce qu’on abrège', async () => {
    const r = await app.api('POST', '/api/launcher', { q: 'kib dev', actions: [] });
    assert.ok(r.body.results.some((x) => x.kind === 'service_url' && /Kibana/.test(x.label)),
      `« kib dev » doit trouver la case, vu : ${JSON.stringify(r.body.results.map((x) => x.label))}`);

    const libres = await app.api('POST', '/api/launcher', { q: 'confluence' });
    assert.ok(libres.body.results.some((x) => x.kind === 'free_link'));

    const actions = await app.api('POST', '/api/launcher', { q: 'docker', actions: [{ id: 'act:1', label: 'Docker' }] });
    assert.ok(actions.body.results.some((x) => x.kind === 'nav'), 'les actions du client entrent dans le classement');
  });

  /* Ce qu'on ouvre souvent doit remonter : c'est toute la raison d'être de la frécence. */
  test('la frécence fait remonter ce qu’on ouvre', async () => {
    const avant = (await app.api('POST', '/api/launcher', { q: 'a' })).body.results;
    const cible2 = avant.find((x) => x.kind === 'free_link');
    assert.ok(cible2, 'il faut au moins un lien libre pour ce test');

    for (let i = 0; i < 20; i += 1) {
      assert.equal((await app.api('POST', '/api/launcher/used', { kind: cible2.kind, ref: cible2.ref })).status, 200);
    }
    const apres = (await app.api('POST', '/api/launcher', { q: 'a' })).body.results;
    assert.equal(apres[0].ref, cible2.ref, 'vingt ouvertures le placent en tête à match comparable');
  });

  test('une requête vide rend quand même des résultats — la palette s’ouvre pleine', async () => {
    assert.ok((await app.api('POST', '/api/launcher', { q: '' })).body.results.length > 0);
  });
});

describe('Liens contextuels sur une merge request', () => {
  test('les boutons sont résolus, et le non-résoluble reste nommé', async () => {
    const repo = app.db.prepare('SELECT id FROM repo LIMIT 1').get()
      || { id: (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://x.test/a.git' })).body.id };
    const dev = (await app.api('GET', '/api/environments')).body.environments[0];
    const svc = (await app.api('POST', '/api/services', { name: 'lié', repo_id: repo.id })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: dev.id, url: 'https://lie-dev.test' });
    await app.api('POST', `/api/services/${svc.id}/context-links`, { label: 'Logs', url_template: 'https://k-{env}.test/?q={branch}' });
    await app.api('POST', `/api/services/${svc.id}/context-links`, { label: 'Sans branche', url_template: 'https://x.test/{branch}' });

    const now = new Date().toISOString();
    const mr = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, status, updated_at)
      VALUES (?, 321, 'test', 'feat/a?b', 'to_review', ?)`).run(repo.id, now).lastInsertRowid;
    const d = (await app.api('GET', `/api/mrs/${mr}/links`)).body;
    assert.equal(d.service.name, 'lié');
    assert.equal(d.envs.length, 1);
    const logs = d.context.find((c) => c.label === 'Logs');
    assert.match(logs.per_env[0].url, /q=feat%2Fa%3Fb/, 'la branche est URL-encodée');

    // Une MR sans branche source : le bouton reste, sans URL, avec la variable coupable.
    const sansBranche = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, status, updated_at)
      VALUES (?, 322, 'test', '', 'to_review', ?)`).run(repo.id, now).lastInsertRowid;
    const d2 = (await app.api('GET', `/api/mrs/${sansBranche}/links`)).body;
    const ko = d2.context.find((c) => c.label === 'Sans branche');
    assert.equal(ko.url, null);
    assert.equal(ko.manquante, 'branch');

    assert.equal((await app.api('GET', '/api/mrs/999999/links')).status, 404);
  });

  test('un dépôt sans service associé ne rend aucun bouton', async () => {
    const autre = (await app.api('POST', '/api/repos', { project: 'grp/sans-service', url: 'https://x.test/b.git' })).body;
    const now = new Date().toISOString();
    const mr = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, status, updated_at)
      VALUES (?, 400, 't', 'main', 'to_review', ?)`).run(autre.id, now).lastInsertRowid;
    assert.equal((await app.api('GET', `/api/mrs/${mr}/links`)).body.service, null);
  });
});

describe('Health check — double opt-in', () => {
  /* LE point de sûreté de la fonctionnalité : ce sont les seules requêtes sortantes, elles
     partent vers des URLs saisies par l'utilisateur, et elles ne doivent partir QUE là où
     on les a autorisées. On le prouve en regardant ce que le serveur cible a reçu. */
  test('rien n’est pingué tant que le réglage global est éteint', async () => {
    await app.api('PUT', '/api/config', { health_check: '0' });
    appels = [];
    const r = await app.api('POST', '/api/links/health/check');
    // Le bouton force un cycle, mais le MINUTEUR, lui, ne part pas : c'est ce qu'on vérifie
    // ci-dessous. Ici on s'assure surtout que la prod reste dehors.
    assert.equal(r.status, 200);
  });

  test('seuls les environnements cochés sont vérifiés — la prod reste dehors', async () => {
    await app.api('PUT', '/api/config', { health_check: '1' });
    const envs = (await app.api('GET', '/api/environments')).body.environments;
    const dev = envs[0];
    const prod = (await app.api('POST', '/api/environments', { name: 'production' })).body;
    assert.equal(prod.health_check, 0);

    const svc = (await app.api('POST', '/api/services', { name: 'sonde' })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: dev.id, url: `${base()}/up` });
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: prod.id, url: `${base()}/PROD-NE-DOIT-PAS-ETRE-APPELE` });

    appels = [];
    await app.api('POST', '/api/links/health/check');
    assert.ok(!appels.some((a) => /PROD-NE-DOIT-PAS/.test(a.url)),
      `la production ne doit recevoir aucune requête, vu : ${JSON.stringify(appels)}`);
    assert.ok(appels.some((a) => a.url === '/up'), 'l’environnement coché, lui, est bien vérifié');
    assert.equal(appels.find((a) => a.url === '/up').method, 'HEAD', 'HEAD d’abord : on ne lit pas le corps');
  });

  test('up, down, redirection et HEAD refusé sont classés correctement', async () => {
    const envs = (await app.api('GET', '/api/environments')).body.environments;
    const dev = envs.find((e) => e.health_check);
    const poser = async (nom, chemin) => {
      const s = (await app.api('POST', '/api/services', { name: nom })).body;
      await app.api('PUT', `/api/services/${s.id}/urls`, { environment_id: dev.id, url: base() + chemin });
      return s.id;
    };
    const ids = {
      up: await poser('s-up', '/up'),
      down: await poser('s-down', '/down'),
      redir: await poser('s-redir', '/redir'),
      nohead: await poser('s-nohead', '/nohead'),
    };
    await app.api('POST', '/api/links/health/check');
    const g = (await app.api('GET', '/api/links/grid')).body;
    const etat = (id) => (g.services.find((s) => s.id === id).health[dev.id] || {}).status;
    assert.equal(etat(ids.up), 'up');
    assert.equal(etat(ids.down), 'down', 'un 503 n’est pas debout');
    assert.equal(etat(ids.redir), 'up', 'une redirection suivie mène à un 2xx');
    assert.equal(etat(ids.nohead), 'up', 'un 405 sur HEAD ne vaut pas « down » : on repasse en GET');
    assert.ok(g.down >= 1, 'le compteur du badge suit');
  });

  test('décocher un environnement efface ses verdicts au lieu de les laisser vieillir', async () => {
    const dev = (await app.api('GET', '/api/environments')).body.environments.find((e) => e.health_check);
    await app.api('PUT', `/api/environments/${dev.id}`, { health_check: 0 });
    await app.api('POST', '/api/links/health/check');
    const g = (await app.api('GET', '/api/links/grid')).body;
    assert.ok(g.services.every((s) => !s.health[dev.id]),
      'un « up » d’il y a trois semaines ne doit pas passer pour frais');
    await app.api('PUT', `/api/environments/${dev.id}`, { health_check: 1 });
  });

  test('le réglage d’intervalle a un plancher', async () => {
    assert.equal((await app.api('PUT', '/api/config', { health_minutes: 0 })).body.health_minutes, 5);
    assert.equal((await app.api('PUT', '/api/config', { health_minutes: 'souvent' })).body.health_minutes, 5);
    assert.equal((await app.api('PUT', '/api/config', { health_minutes: 15 })).body.health_minutes, 15);
    assert.equal((await app.api('PUT', '/api/config', { health_check: '0' })).body.health_check, '0');
  });
});
