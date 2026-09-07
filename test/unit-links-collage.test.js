'use strict';
/* Coller une adresse, réordonner, et le nom qu'une case affiche.
 *
 * Trois règles que seule la logique pure peut prouver dans tous leurs cas :
 *
 * — CE QUE L'ÉCRAN AFFICHE d'une adresse sans nom. Elle a besoin du nom de la colonne ET de
 *   celui de la ligne, et une version côté navigateur en ferait deux à tenir d'accord.
 * — CE QU'ON PROPOSE au collage. La promesse est « rien n'est deviné en silence » : ce qui se
 *   teste ici, ce n'est pas que la proposition soit juste, c'est qu'elle ne DÉCIDE rien —
 *   une adresse dont l'hôte ne cite aucun environnement connu tombe en lien libre, jamais
 *   dans une colonne « probable ».
 * — L'ORDRE COMPLET posé d'un coup, et ce qu'il advient de ce que le client n'a pas cité.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isole la base : ces modules chargent db.js (donc paths.js) au require.
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'links-collage-'));

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const links = require('../src/links');
const db = require('../src/db');

const MSGS = {
  nomVide: 'NOM-VIDE', nomPris: 'NOM-PRIS', labelVide: 'LABEL-VIDE',
  urlInvalide: 'URL-INVALIDE', templateVide: 'TEMPLATE-VIDE',
  variableInconnue: (n, l) => `VARIABLE:${n}:${l.join(',')}`,
  tropDeTags: 'TROP-TAGS', inconnu: 'INCONNU', envInconnu: 'ENV-INCONNU', tropGros: 'TROP-GROS',
};

const vider = () => {
  db.exec('DELETE FROM service_url; DELETE FROM context_link; DELETE FROM service; DELETE FROM environment; DELETE FROM free_link; DELETE FROM launcher_usage;');
};
const env = (nom) => links.creerEnvironnement({ name: nom }, MSGS);
const svc = (nom, extra = {}) => links.creerService({ name: nom, ...extra }, MSGS);

describe('le nom qu’une case affiche à défaut de libellé', () => {
  test('le dernier segment du chemin gagne — c’est lui qui distingue l’adresse', () => {
    assert.equal(links.nomDepuisUrl('https://api-preprod.demo.invalid/health', { env: 'preprod', service: 'api-core' }), 'health');
    assert.equal(links.nomDepuisUrl('https://grafana-dev.demo.invalid/d/home', { env: 'dev', service: 'Grafana' }), 'home');
    // Un segment encodé se relit : `%20` dans une URL n'a pas à s'afficher tel quel.
    assert.equal(links.nomDepuisUrl('https://x.invalid/erreurs%205xx'), 'erreurs 5xx');
  });

  test('sans chemin, l’hôte perd ce que la ligne et la colonne disent déjà', () => {
    // `api-preprod` ne dit QUE « api-core » et « preprod », déjà écrits à côté.
    assert.equal(links.nomDepuisUrl('https://api-preprod.demo.invalid/', { env: 'preprod', service: 'api-core' }), 'demo.invalid');
    // Un mot en plus dans le premier segment compte : on garde l'hôte entier.
    assert.equal(links.nomDepuisUrl('https://admin-api-preprod.demo.invalid/', { env: 'preprod', service: 'api-core' }), 'admin-api-preprod.demo.invalid');
  });

  test('un hôte d’un seul segment reste tel quel, et une URL illisible ne rend rien', () => {
    assert.equal(links.nomDepuisUrl('http://localhost:3000/'), 'localhost');
    assert.equal(links.nomDepuisUrl('pas une url'), '');
  });

  test('le nom d’un lien libre est celui du SITE, pas celui de la page', () => {
    // Un lien libre se retrouve par « Confluence », pas par « runbook » : à l'inverse d'une
    // case, où le service est déjà dit par la ligne.
    assert.equal(links.nomDeSite('https://confluence.corp.invalid/runbook'), 'confluence');
    // Sauf quand l'hôte ne dit rien d'utile : mieux vaut le chemin que « 127 ».
    assert.equal(links.nomDeSite('http://127.0.0.1:8080/admin'), 'admin');
  });

  test('la grille rend ce nom, calculé côté serveur', () => {
    vider();
    const e = env('preprod');
    const s = svc('api-core');
    links.poserUrl(s.id, { environment_id: e.id, urls: [{ url: 'https://api-preprod.demo.invalid/health' }] }, MSGS);
    const ligne = links.grille().services.find((x) => x.id === s.id);
    assert.equal(ligne.urls[e.id][0].display, 'health');
    // Une adresse NOMMÉE n'a pas de `display` : son libellé prime, et le calculer serait du bruit.
    links.poserUrl(s.id, { environment_id: e.id, urls: [{ label: 'santé', url: 'https://api-preprod.demo.invalid/health' }] }, MSGS);
    assert.equal(links.grille().services.find((x) => x.id === s.id).urls[e.id][0].display, '');
  });
});

describe('coller une adresse : on propose, on ne décide pas', () => {
  beforeEach(() => { vider(); });

  test('l’hôte qui cite un environnement ET un service connus range dans la case', () => {
    const dev = env('dev');
    const kib = svc('Kibana');
    const [item] = links.analyserCollage('https://kibana-dev.corp.invalid/app/logs?q=checkout');
    assert.equal(item.target, 'cell');
    assert.equal(item.environment_id, dev.id);
    assert.equal(item.service_id, kib.id);
    assert.equal(item.label, 'logs');
  });

  test('un environnement connu sans service PROPOSE un nom de service, tiré de l’hôte', () => {
    const dev = env('dev');
    const [item] = links.analyserCollage('https://grafana-dev.corp.invalid/d/home');
    assert.equal(item.target, 'cell');
    assert.equal(item.environment_id, dev.id);
    assert.equal(item.service_id, null);
    // Débarrassé du nom de l'environnement : « grafana », pas « grafana-dev ».
    assert.equal(item.service_name, 'grafana');
  });

  test('aucun environnement reconnu ⇒ LIEN LIBRE, jamais une colonne « probable »', () => {
    env('dev');
    svc('Confluence');
    const [item] = links.analyserCollage('https://confluence.corp.invalid/runbook');
    assert.equal(item.target, 'free', 'le service est connu, mais rien ne dit OÙ le poser');
    assert.equal(item.label, 'confluence');
    assert.deepEqual(item.tags, ['confluence']);
  });

  test('le service se reconnaît aussi par le nom de son dépôt', () => {
    const dev = env('dev');
    const repo = db.prepare("INSERT INTO repo (project, url, created_at) VALUES ('groupe/facturation', 'https://git.invalid/groupe/facturation', ?)")
      .run(new Date().toISOString()).lastInsertRowid;
    const s = svc('Compta', { repo_id: repo });
    const [item] = links.analyserCollage('https://facturation-dev.corp.invalid/etat');
    assert.equal(item.service_id, s.id);
    assert.equal(item.environment_id, dev.id);
  });

  test('`localhost` vaut « local » quand la colonne existe, et pas autrement', () => {
    const local = env('local');
    assert.equal(links.analyserCollage('http://localhost:3000/admin')[0].environment_id, local.id);
    vider();
    env('dev');
    assert.equal(links.analyserCollage('http://localhost:3000/admin')[0].target, 'free');
  });

  test('un segment d’hôte n’est pas un fragment : « api » ne se retrouve pas dans « rapid »', () => {
    env('dev');
    const api = svc('api');
    assert.equal(links.analyserCollage('https://rapid-dev.corp.invalid/x')[0].service_id, null);
    assert.equal(links.analyserCollage('https://api-dev.corp.invalid/x')[0].service_id, api.id);
  });

  test('une ligne sans adresse http(s) est signalée, pas silencieusement ignorée', () => {
    const items = links.analyserCollage('ceci n’est pas une url\nhttps://x.corp.invalid/a');
    assert.equal(items.length, 2);
    assert.equal(items[0].invalid, true);
    assert.equal(items[1].invalid, undefined);
  });
});

describe('appliquer un collage', () => {
  beforeEach(() => { vider(); });

  test('l’adresse S’AJOUTE à la case, elle ne la remplace pas', () => {
    const e = env('dev');
    const s = svc('Kibana');
    links.poserUrl(s.id, { environment_id: e.id, urls: [{ label: 'déjà', url: 'https://k.invalid/1' }] }, MSGS);
    links.appliquerCollage({ items: [{ target: 'cell', url: 'https://k.invalid/2', label: 'neuve', service_id: s.id, environment_id: e.id }] }, MSGS);
    const liste = links.grille().services.find((x) => x.id === s.id).urls[e.id];
    assert.deepEqual(liste.map((u) => u.label), ['déjà', 'neuve']);
  });

  test('le service et l’environnement manquants se créent au passage', () => {
    const r = links.appliquerCollage({ items: [
      { target: 'cell', url: 'https://k.invalid/1', label: 'a', service_name: 'Kibana', environment_name: 'preprod' },
      // Le MÊME nouveau service cité deux fois n'en fait qu'un : sinon le second échouerait
      // sur un nom déjà pris, et le collage entier partirait avec lui.
      { target: 'cell', url: 'https://k.invalid/2', label: 'b', service_name: 'Kibana', environment_name: 'preprod' },
    ] }, MSGS);
    assert.equal(r.cells, 2);
    assert.equal(r.services_created, 1);
    assert.equal(r.envs_created, 1);
    const g = links.grille();
    assert.equal(g.services.length, 1);
    assert.equal(g.environments.length, 1);
    assert.equal(Object.values(g.services[0].urls)[0].length, 2);
  });

  test('un lien libre garde son tag, et son nom se déduit à défaut', () => {
    links.appliquerCollage({ items: [{ target: 'free', url: 'https://confluence.invalid/x', tags: 'doc' }] }, MSGS);
    const [l] = links.grille().free_links;
    assert.equal(l.label, 'confluence');
    assert.deepEqual(l.tags, ['doc']);
  });

  test('TOUT OU RIEN : une URL invalide au milieu ne laisse pas la moitié posée', () => {
    const e = env('dev');
    const s = svc('Kibana');
    assert.throws(() => links.appliquerCollage({ items: [
      { target: 'cell', url: 'https://k.invalid/1', service_id: s.id, environment_id: e.id },
      { target: 'cell', url: 'javascript:alert(1)', service_id: s.id, environment_id: e.id },
    ] }, MSGS), /URL-INVALIDE/);
    assert.equal(links.grille().services[0].urls[e.id], undefined, 'la première non plus n’est pas passée');
  });
});

describe('réordonner : l’ordre complet, en un appel', () => {
  beforeEach(() => { vider(); });

  test('les colonnes prennent l’ordre demandé', () => {
    const a = env('local'); const b = env('dev'); const c = env('preprod');
    links.reordonnerEnvironnements([c.id, a.id, b.id]);
    assert.deepEqual(links.listerEnvironnements().map((e) => e.name), ['preprod', 'local', 'dev']);
  });

  test('ce que le client n’a pas cité reste DERRIÈRE, et rien ne disparaît', () => {
    // Le cas réel : on glisse une colonne alors qu'une autre est masquée à l'écran.
    const a = env('local'); const b = env('dev'); const c = env('preprod');
    links.reordonnerEnvironnements([c.id, a.id]);
    assert.deepEqual(links.listerEnvironnements().map((e) => e.name), ['preprod', 'local', 'dev']);
    assert.equal(links.listerEnvironnements().length, 3);
    // Un identifiant inconnu est ignoré plutôt que de casser l'ordre.
    links.reordonnerEnvironnements([9999, b.id]);
    assert.deepEqual(links.listerEnvironnements().map((e) => e.name), ['dev', 'preprod', 'local']);
  });

  test('les lignes gardent l’ordre posé, et les épinglés restent en tête', () => {
    const z = svc('zeta'); const a = svc('alpha');
    // Sans rien poser, l'alphabétique tient : une grille neuve ne change pas d'aspect.
    assert.deepEqual(links.grille().services.map((s) => s.name), ['alpha', 'zeta']);
    links.reordonnerServices([z.id, a.id]);
    assert.deepEqual(links.grille().services.map((s) => s.name), ['zeta', 'alpha']);
    links.majService(a.id, { pinned: 1 }, MSGS);
    assert.deepEqual(links.grille().services.map((s) => s.name), ['alpha', 'zeta'], 'épinglé = en tête, quel que soit l’ordre');
  });
});

describe('la frécence voyage jusqu’aux boutons d’une merge request', () => {
  test('chaque adresse porte son identifiant : la référence a TROIS segments', () => {
    vider();
    const e = env('dev');
    const repo = db.prepare("INSERT INTO repo (project, url, created_at) VALUES ('groupe/api', 'https://git.invalid/groupe/api', ?)")
      .run(new Date().toISOString()).lastInsertRowid;
    const s = svc('api', { repo_id: repo });
    links.poserUrl(s.id, { environment_id: e.id, urls: [{ label: 'santé', url: 'https://api.invalid/health' }] }, MSGS);
    const d = links.liensDeMr({ repo_id: repo, source_branch: 'feat/x', iid: 12 });
    assert.equal(d.envs.length, 1);
    assert.ok(d.envs[0].id, 'l’identifiant de l’adresse est rendu — sans lui, l’ouverture n’est comptée nulle part');
  });

  test('les liens libres se classent par frécence, l’alphabétique départageant', () => {
    vider();
    const vieux = links.creerFreeLink({ label: 'B — martelé en mars', url: 'https://b.invalid' }, MSGS);
    const recent = links.creerFreeLink({ label: 'C — ouvert ce matin', url: 'https://c.invalid' }, MSGS);
    links.creerFreeLink({ label: 'A — jamais ouvert', url: 'https://a.invalid' }, MSGS);
    const ins = db.prepare('INSERT INTO launcher_usage (kind, ref, uses, last_used_at) VALUES (?,?,?,?)');
    const ilYA = (jours) => new Date(Date.now() - jours * 86400000).toISOString();
    ins.run('free_link', String(vieux.id), 90, ilYA(60));
    ins.run('free_link', String(recent.id), 8, ilYA(0));
    assert.deepEqual(links.listerFreeLinks().map((l) => l.label[0]), ['C', 'B', 'A'],
      'un compteur brut aurait gardé « B » en tête six mois durant');
  });
});
