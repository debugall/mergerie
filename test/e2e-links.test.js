'use strict';
/* Liens — par de vraies requêtes HTTP.
 *
 * Ce que l'unitaire ne prouve pas : que les routes existent et valident, que la grille se
 * compose, que l'import va de l'aperçu à la création sans doublon, que la palette voit
 * toutes les sources et retient ce qu'on ouvre — et que les adresses de la grille ne sont
 * jamais appelées par l'application. Ce dernier point se vérifie contre un vrai serveur local :
 * c'est le seul moyen de savoir ce qui a été appelé, et ici la bonne réponse est « rien ».
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp } = require('./helpers/app');

let app;
let cible;          // un serveur qui ne doit JAMAIS rien recevoir
let appels = [];    // ce qu'il a reçu — reste vide, c'est tout l'intérêt

before(async () => {
  app = await startApp();
  await app.configure();
  cible = http.createServer((req, res) => {
    appels.push({ method: req.method, url: req.url });
    res.writeHead(204); res.end();
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
    const dev = await app.api('POST', '/api/environments', { name: 'dev', color: '#2f6fe0' });
    assert.equal(dev.status, 200);
    await app.api('POST', '/api/environments', { name: 'prod', color: '#c62828' });

    const svc = await app.api('POST', '/api/services', { name: 'api-core', tags: 'Backend, backend, Métier' });
    assert.deepEqual(JSON.parse(svc.body.tags), ['backend', 'metier'], 'tags normalisés et dédupliqués');

    await app.api('PUT', `/api/services/${svc.body.id}/urls`, { environment_id: dev.body.id, url: `${base()}/up` });
    const g = await app.api('GET', '/api/links/grid');
    assert.equal(g.body.services.length, 1);
    assert.deepEqual(g.body.services[0].urls[dev.body.id].map((u) => u.url), [`${base()}/up`]);
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
    assert.deepEqual(kib.urls[dev.id].map((u) => u.url), ['https://kibana.corp/app']);
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

/* Les adresses de la grille sont ouvertes PAR L'UTILISATEUR, d'un clic. L'application, elle,
   ne s'y connecte jamais : ce sont des adresses internes, saisies à la main, et un outil local
   qui sortirait seul vers elles demanderait une confiance dont il n'a pas besoin.

   Un test qui n'attend rien paraît creux ; celui-ci vaut pour ce qu'il empêche. On pose une
   adresse pointant vers un serveur à nous, on exerce tout ce qui touche aux liens, et on
   vérifie qu'il n'a rien reçu. */
/* L'IMPORT CONSTRUIT LA GRILLE. Un arbre de favoris encode souvent la même chose que cet
   onglet ; l'aplatir en liens libres était strictement moins bon que ce que fait le navigateur. */
describe('import : la grille proposée puis construite', () => {
  const ARBRE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Barre de favoris</H3>
  <DL><p>
    <DT><H3>app</H3>
    <DL><p>
      <DT><H3>dev</H3><DL><p>
        <DT><A HREF="https://bo-dev.demo.invalid/">bo dev</A>
        <DT><A HREF="https://api-dev.demo.invalid/">api</A>
      </DL><p>
      <DT><H3>pprod</H3><DL><p>
        <DT><A HREF="https://bo-pprod.demo.invalid/">bo pprod</A>
        <DT><A HREF="https://api-pprod.demo.invalid/">api</A>
      </DL><p>
      <DT><H3>preprod</H3><DL><p>
        <DT><A HREF="https://bo-preprod.demo.invalid/">bo preprod</A>
      </DL><p>
      <DT><H3>prod</H3><DL><p>
        <DT><A HREF="https://bo-prod.demo.invalid/">bo prod</A>
        <DT><A HREF="https://api-prod.demo.invalid/">api</A>
      </DL><p>
    </DL><p>
    <DT><H3>doc</H3><DL><p>
      <DT><A HREF="https://confluence.demo.invalid/x">Confluence</A>
    </DL><p>
  </DL><p>
</DL><p>`;

  test('l’aperçu PROPOSE une grille sans rien créer', async () => {
    // Le décor est partagé avec les tests précédents : on compare à l'état d'AVANT, pas à zéro.
    const avant = (await app.api('GET', '/api/links/grid')).body.services.length;
    const r = await app.api('POST', '/api/links/import', { html: ARBRE });
    assert.equal(r.status, 200);
    const p = r.body.proposal;
    /* TROIS colonnes et non quatre : `pprod` et `preprod` sont le même environnement écrit de
       deux façons, et deux colonnes jumelles à moitié remplies seraient pires que rien. */
    assert.equal(p.environments.length, 3, `vu : ${p.environments}`);
    assert.equal(p.environments[0], 'dev', 'et dans l’ordre de la chaîne de déploiement');
    assert.equal(p.environments[2], 'prod');
    assert.match(p.environments[1], /^(p|pre)prod$/, 'les deux orthographes n’ont donné qu’une colonne');
    assert.deepEqual(p.services.map((s) => s.name).sort(), ['api', 'bo']);
    // Rien n'a bougé : c'est un APERÇU.
    assert.equal((await app.api('GET', '/api/links/grid')).body.services.length, avant);
  });

  test('appliquée, elle crée colonnes, lignes et adresses — et reste rejouable', async () => {
    /* On repart d'une grille vide : ce test observe ce que l'IMPORT construit, pas ce que les
       tests précédents ont laissé. Les liens libres aussi, pour compter juste. */
    for (const s of (await app.api('GET', '/api/links/grid')).body.services) await app.api('DELETE', `/api/services/${s.id}`);
    for (const e of (await app.api('GET', '/api/environments')).body.environments) await app.api('DELETE', `/api/environments/${e.id}`);
    await app.api('DELETE', '/api/free-links');
    const p = (await app.api('POST', '/api/links/import', { html: ARBRE })).body.proposal;
    const libres = (await app.api('POST', '/api/links/import', { html: ARBRE })).body.links
      .filter((l) => !p.folders.includes(l.folder.replace(/^Barre de favoris\//, '')));

    const r = await app.api('POST', '/api/links/import/apply', { links: libres, grid: p });
    assert.equal(r.body.services_created, 2);
    assert.ok(r.body.urls_created >= 7);

    const g = (await app.api('GET', '/api/links/grid')).body;
    assert.deepEqual(g.services.map((s) => s.name).sort(), ['api', 'bo']);
    assert.equal(g.environments.length, 3);
    assert.equal(g.free_links.length, 1, 'le dossier « doc » n’a pas d’environnement : il reste libre');
    assert.equal(g.free_links[0].folder, 'doc', 'et il garde son chemin');

    // Rejoué : rien n'est doublé, ni en grille ni en liens libres.
    const rejeu = await app.api('POST', '/api/links/import/apply', { links: libres, grid: p });
    assert.equal(rejeu.body.urls_created, 0);
    assert.equal(rejeu.body.services_created, 0);
    const g2 = (await app.api('GET', '/api/links/grid')).body;
    assert.equal(g2.services.length, 2);
    assert.equal(g2.free_links.length, 1);
  });

  test('refuser la grille importe tout à plat, comme avant', async () => {
    for (const s of (await app.api('GET', '/api/links/grid')).body.services) await app.api('DELETE', `/api/services/${s.id}`);
    await app.api('DELETE', '/api/free-links');
    const d = (await app.api('POST', '/api/links/import', { html: ARBRE })).body;
    const r = await app.api('POST', '/api/links/import/apply', { links: d.links });
    assert.equal(r.body.created, 8);
    assert.equal(r.body.services_created, undefined, 'sans grille demandée, pas de compteur de grille');
    assert.equal((await app.api('GET', '/api/links/grid')).body.services.length, 0);
  });
});

/* FUSIONNER DES LIGNES PROPOSÉES. La détection lit des noms de dossiers ; elle ne sait pas que
   deux d'entre eux désignent le même service. C'est une transformation du côté du client, mais le
   serveur doit l'accepter telle quelle — d'où ce test sur la forme envoyée. */
describe('import : réunir plusieurs lignes en un service', () => {
  test('des cases venues de deux lignes se rejoignent dans le même service', async () => {
    for (const s2 of (await app.api('GET', '/api/links/grid')).body.services) await app.api('DELETE', `/api/services/${s2.id}`);
    for (const e of (await app.api('GET', '/api/environments')).body.environments) await app.api('DELETE', `/api/environments/${e.id}`);

    const grid = {
      environments: ['dev', 'prod'],
      services: [{
        name: 'Kibana',
        cells: [
          { env: 'prod', links: [{ label: 'keycloak', url: 'https://k1.demo.invalid' }, { label: 'purge', url: 'https://k2.demo.invalid' }] },
          { env: 'dev', links: [{ label: 'tout', url: 'https://k3.demo.invalid' }] },
        ],
      }],
    };
    const r = await app.api('POST', '/api/links/import/apply', { links: [], grid });
    assert.equal(r.body.services_created, 1);
    assert.equal(r.body.urls_created, 3);

    const g = (await app.api('GET', '/api/links/grid')).body;
    const svc = g.services.find((x) => x.name === 'Kibana');
    const prod = g.environments.find((e) => e.name === 'prod');
    assert.deepEqual(svc.urls[prod.id].map((u) => u.label), ['keycloak', 'purge'],
      'les deux lignes réunies tiennent dans la même case, chacune avec son nom');
  });
});

describe('vider les liens libres', () => {
  test('la route efface tout et rend le compte, sans toucher à la grille', async () => {
    await app.api('POST', '/api/free-links', { label: 'A', url: 'https://a.demo.invalid' });
    await app.api('POST', '/api/free-links', { label: 'B', url: 'https://b.demo.invalid' });
    const avant = (await app.api('GET', '/api/links/grid')).body;
    assert.ok(avant.free_links.length >= 2);

    const r = await app.api('DELETE', '/api/free-links');
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, avant.free_links.length);

    const apres = (await app.api('GET', '/api/links/grid')).body;
    assert.equal(apres.free_links.length, 0);
    assert.equal(apres.services.length, avant.services.length, 'les services sont intacts');
  });
});

describe('les adresses de la grille ne sont jamais appelées par l’application', () => {
  test('poser des URLs, tout consulter, et le serveur cible ne reçoit rien', async () => {
    const env = (await app.api('GET', '/api/environments')).body.environments[0];
    const svc = (await app.api('POST', '/api/services', { name: 'jamais-appele' })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: env.id, url: `${base()}/surtout-pas` });

    appels = [];
    await app.api('GET', '/api/links/grid');
    await app.api('POST', '/api/launcher', { q: 'jamais', actions: [] });
    await app.api('GET', '/api/environments');
    // Une seconde de battement : un minuteur oublié se manifesterait là.
    await new Promise((r) => { setTimeout(r, 1000); });

    assert.deepEqual(appels, [], `aucune requête ne doit partir, vu : ${JSON.stringify(appels)}`);
  });
});
