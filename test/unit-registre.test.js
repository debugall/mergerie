'use strict';
/* LE CONTRÔLE AU REGISTRE : LE REGISTRE A RÉPONDU, OU IL N'A PAS RÉPONDU, ET L'OUTIL DIT LEQUEL.
 *
 * Ce que ce fichier prouve, sur une base temporaire, contre de FAUX registres locaux (`helpers/mock-registres`)
 * et sans serveur Mergerie : npm 200 d'il y a 400 j → `known`, d'il y a 3 j → `recent`, 404 → `unknown`,
 * délai → `unreachable · timeout` ; un cas par écosystème (Packagist p2, PyPI releases, crates.io avec son
 * User-Agent, RubyGems versions, proxy Go list + info et 410, Maven `numFound = 0`, NuGet gzip) ; la
 * normalisation PyPI (`Py_YAML`, `py.yaml`, `py-yaml` → une entrée) ; les paquets privés par motif et
 * par `.npmrc` du clone → aucun appel ; le plafond (2 → deux appels, trois `skipped · cap`, rattrapés) ;
 * le cache (trois MR, un appel ; `unknown` revérifié après 24 h, `known` après 7 j, pas avant) ; réglage
 * décoché → zéro requête sur un tour complet et le panneau dit « désactivé » ; le proxy de l'environnement
 * (`HTTP_PROXY` suivi, `NO_PROXY` respecté) ; la ligne de projet d'une session (plafond 10) ; le journal
 * du tour ; et le module fermé à `agent/`. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lireSource } = require('./helpers/sources');
const registres = require('./helpers/mock-registres');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'registre-'));
const FIX = path.join(__dirname, 'fixtures', 'manifests');
const fixture = (nom) => fs.readFileSync(path.join(FIX, nom), 'utf8');

describe('Contrôle au registre des dépendances ajoutées', () => {
  let db; let rg; let dp; let c; let httpreq;
  let faux; let cfg; let repoId;
  const now = new Date().toISOString();
  /* Le délai de 5 s du vrai contrôle serait long pour un test : la même requête, bornée à 300 ms. */
  const requete = (u, o) => httpreq.request(u, { ...o, timeoutMs: 300 });
  const aj = (parser, name, extra = {}) => ({ repo_id: repoId, parser, name, group: null, ...extra });
  const hits = (motif) => faux.state.hits.filter((h) => motif.test(h.path));

  before(async () => {
    db = require('../src/db');
    rg = require('../src/review/registre');
    dp = require('../src/review/dependances');
    c = require('../src/review/croisements');
    httpreq = require('../src/core/httpreq');
    faux = await registres.start();
    repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/app', 'https://gitlab.test/grp/app.git', 1, 'gitlab')").run().lastInsertRowid);
    cfg = { mr_files_enabled: '1', deps_enabled: '1', registry_enabled: '1', registry_urls: faux.urls, registry_max: '30', registry_recent_days: '30', private_patterns: '', clone_path: path.join(process.env.MERGERIE_DATA_DIR, 'clones') };
  });
  after(async () => { if (faux) await faux.stop(); });

  test('npm : 400 jours → known ; 3 jours → recent ; 404 → unknown ; délai → unreachable · timeout — jamais « inconnu » sans 404', async () => {
    const k = await rg.interroger('npm', 'express', faux.base, { requete });
    assert.equal(k.status, 'known'); assert.ok(k.first_published); assert.equal(k.appels, 1);
    const r = await rg.interroger('npm', 'fastjson2', faux.base, { requete });
    assert.equal(r.status, 'recent');
    const u = await rg.interroger('npm', 'left-pad', faux.base, { requete });
    assert.deepEqual([u.status, u.reason], ['unknown', '404']);
    const scope = await rg.interroger('npm', '@acme/ui', faux.base, { requete });
    assert.equal(scope.status, 'unknown');
    assert.match(hits(/acme/)[0].path, /^\/@acme%2Fui$/, 'le scope est encodé %2F');
    const t = await rg.interroger('npm', 'x', `${faux.base}/hang`, { requete });
    assert.deepEqual([t.status, t.reason], ['unreachable', 'timeout']);
    const h = await rg.interroger('npm', 'x', `${faux.base}/casse`, { requete });
    assert.deepEqual([h.status, h.reason], ['unreachable', 'http-503'], 'un 503 n’est pas « inconnu »');
    const rd = await rg.interroger('npm', 'x', `${faux.base}/redirige`, { requete });
    assert.deepEqual([rd.status, rd.reason], ['unreachable', 'redirect'], 'une redirection hors de l’hôte n’est pas suivie');
    assert.equal(hits(/invalid/).length, 0);
  });

  test('un cas par écosystème : Packagist, PyPI, crates.io (User-Agent), RubyGems, Go (list + info, 410), Maven (numFound 0), NuGet (gzip)', async () => {
    const comp = await rg.interroger('composer', 'guzzlehttp/guzzle', faux.base, { requete });
    assert.equal(comp.status, 'known'); assert.equal(comp.first_published.slice(0, 4), '2019', 'le plus ancien `time`, dev-master ignoré');
    assert.equal((await rg.interroger('composer', 'acme/inconnu', faux.base, { requete })).status, 'unknown');
    const py = await rg.interroger('pypi', 'pyyaml', faux.base, { requete });
    assert.equal(py.first_published.slice(0, 4), '2018');
    assert.equal((await rg.interroger('pypi', 'inexistant', faux.base, { requete })).status, 'unknown');
    const cr = await rg.interroger('crates', 'serde', faux.base, { requete });
    assert.equal(cr.first_published.slice(0, 4), '2015');
    assert.match(hits(/crates\/serde/)[0].headers['user-agent'], /^mergerie\/\d+\.\d+\.\d+ \(\+https:\/\/mergerie\.dev\)$/, 'le User-Agent obligatoire de crates.io');
    assert.ok(!hits(/crates\/serde/)[0].headers.cookie && !hits(/crates\/serde/)[0].headers.authorization, 'rien d’autre que le User-Agent');
    const gem = await rg.interroger('rubygems', 'rails', faux.base, { requete });
    assert.equal(gem.first_published.slice(0, 4), '2013');
    assert.equal((await rg.interroger('rubygems', 'nope', faux.base, { requete })).status, 'unknown');
    const go = await rg.interroger('go', 'github.com/Acme/Lib', faux.base, { requete });
    assert.equal(go.first_published.slice(0, 4), '2019', 'le Time de la plus ancienne version (v1.0.0, pas v1.10.0)');
    assert.equal(go.appels, 2);
    assert.match(hits(/!acme\/!lib\/@v\/list/)[0].path, /github\.com\/!acme\/!lib/, 'les majuscules du module sont échappées');
    assert.equal((await rg.interroger('go', 'example.com/parti', faux.base, { requete })).status, 'unknown', '410 Gone vaut inconnu');
    assert.equal((await rg.interroger('go', 'example.com/sanstag', faux.base, { requete })).status, 'recent', 'sans tag : @latest et son Time');
    const mv = await rg.interroger('maven', 'org.apache.commons:commons-lang3', faux.base, { requete });
    assert.equal(mv.first_published.slice(0, 4), '2017');
    assert.equal((await rg.interroger('maven', 'org.acme:inconnu', faux.base, { requete })).status, 'unknown', 'numFound = 0 vaut inconnu');
    const ng = await rg.interroger('nuget', 'Newtonsoft.Json', faux.base, { requete });
    assert.equal(ng.first_published.slice(0, 4), '2016', 'le gzip est décompressé');
    assert.match(hits(/registration5/)[0].path, /\/newtonsoft\.json\//, 'l’identifiant en minuscules');
    assert.equal((await rg.interroger('nuget', 'nope', faux.base, { requete })).status, 'unknown');
  });

  test('PyPI : Py_YAML, py.yaml et py-yaml sont une seule entrée de cache ; npm garde le nom tel quel', async () => {
    assert.equal(rg.normaliser('pypi', 'Py_YAML'), 'py-yaml');
    assert.equal(rg.normaliser('pypi', 'py.yaml'), 'py-yaml');
    assert.equal(rg.normaliser('npm', '@Acme/UI'), '@Acme/UI');
    assert.equal(rg.normaliser('nuget', 'Newtonsoft.Json'), 'newtonsoft.json');
    faux.reset();
    await rg.controlerTour(cfg, [aj('requirements.txt', 'Py_YAML'), aj('pyproject.toml', 'py.yaml'), aj('requirements.txt', 'py-yaml')], { requete });
    assert.equal(hits(/\/pypi\//).length, 1, 'un seul appel pour les trois graphies');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registry_lookup WHERE ecosystem = 'pypi' AND name = 'py-yaml'").get().n, 1);
    assert.equal(rg.etatDe('pypi', 'PY.yaml').status, 'known');
  });

  test('privés : un motif `@docaposte/*` → skipped · private-pattern ; un `.npmrc` du clone avec `@docaposte:registry=` → private-config — aucun appel', async () => {
    faux.reset();
    const prive = { ...cfg, private_patterns: '@docaposte/*\nvendor-interne/*' };
    await rg.controlerTour(prive, [aj('package.json', '@docaposte/ui'), aj('composer.json', 'vendor-interne/outil')], { requete });
    assert.equal(faux.state.hits.length, 0, 'un nom privé ne part jamais');
    const e = rg.pourDependances(prive, repoId, [{ parser: 'package.json', name: '@docaposte/ui' }]);
    assert.deepEqual([e[0].status, e[0].reason, e[0].source], ['skipped', 'private-pattern', { kind: 'config' }]);
    // Le clone : un .npmrc qui route le scope @corp vers un registre privé.
    const git = require('../src/git/git');
    const cwd = git.cloneDirFor(cfg, { id: repoId, project: 'grp/app', forge: 'gitlab', url: 'https://gitlab.test/grp/app.git' });
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.npmrc'), '@corp:registry=https://npm.corp.example/\nsave-exact=true\n');
    fs.writeFileSync(path.join(cwd, 'go.env'), 'GOPRIVATE=git.corp.example/*,corp.example.com/go/...\n');
    await rg.controlerTour(cfg, [aj('package.json', '@corp/ui'), aj('go.mod', 'corp.example.com/go/lib'), aj('package.json', 'express')], { requete });
    assert.deepEqual(faux.state.hits.map((h) => h.path), ['/express'], 'seul le paquet public part');
    const f = rg.pourDependances(cfg, repoId, [{ parser: 'package.json', name: '@corp/ui' }, { parser: 'go.mod', name: 'corp.example.com/go/lib' }, { parser: 'package.json', name: 'express' }]);
    assert.deepEqual(f.map((x) => [x.status, x.reason, x.source]), [['skipped', 'private-config', '.npmrc'], ['skipped', 'private-config', 'go.env'], ['known', null, undefined]]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('plafond 2, cinq ajoutées → deux appels et trois skipped · cap, rattrapées aux tours suivants', async () => {
    faux.reset();
    const cinq = ['pk1', 'pk2', 'pk3', 'pk4', 'pk5'].map((n) => aj('package.json', n));
    const journal = [];
    let b = await rg.controlerTour({ ...cfg, registry_max: '2' }, cinq, { requete, onLog: (m) => journal.push(m) });
    assert.deepEqual([b.controles, b.plafonnes, faux.state.hits.length], [2, 3, 2]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registry_lookup WHERE status = 'skipped' AND reason = 'cap'").get().n, 3);
    assert.deepEqual(rg.pourDependances(cfg, repoId, [{ parser: 'package.json', name: 'pk5' }]).map((x) => [x.status, x.reason]), [['skipped', 'cap']]);
    assert.match(journal[0], /Registre : 2 appel\(s\) \(npm 2\) vers 127\.0\.0\.1 — 0 inconnu\(s\), 0 récent\(s\), 0 injoignable\(s\), 3 au-delà du plafond \(2\)/);
    b = await rg.controlerTour({ ...cfg, registry_max: '2' }, cinq, { requete });
    assert.deepEqual([b.controles, b.plafonnes], [2, 1], 'le tour suivant reprend là où il s’est arrêté');
    b = await rg.controlerTour({ ...cfg, registry_max: '2' }, cinq, { requete });
    assert.deepEqual([b.controles, b.plafonnes], [1, 0]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM registry_lookup WHERE status = 'skipped'").get().n, 0);
    b = await rg.controlerTour({ ...cfg, registry_max: '0' }, ['q1', 'q2', 'q3'].map((n) => aj('package.json', n)), { requete });
    assert.equal(b.controles, 3, '0 = sans limite');
  });

  test('cache : la même dépendance ajoutée par trois MR → un appel ; unknown revérifié après 24 h, known après 7 j, pas avant', async () => {
    faux.reset();
    const t0 = Date.now();
    await rg.controlerTour(cfg, [aj('package.json', 'left-pad'), aj('package.json', 'left-pad'), aj('package.json', 'left-pad'), aj('package.json', 'lodash')], { requete, now: t0 });
    assert.equal(hits(/left-pad|lodash/).length, 2);
    faux.reset();
    await rg.controlerTour(cfg, [aj('package.json', 'left-pad'), aj('package.json', 'lodash')], { requete, now: t0 + 23 * 3600 * 1000 });
    assert.equal(faux.state.hits.length, 0, 'avant 24 h, rien ne repart');
    await rg.controlerTour(cfg, [aj('package.json', 'left-pad'), aj('package.json', 'lodash')], { requete, now: t0 + 25 * 3600 * 1000 });
    assert.deepEqual(faux.state.hits.map((h) => h.path), ['/left-pad'], 'après 24 h, l’inconnu seul est revérifié — un paquet peut être publié entre-temps');
    faux.reset();
    await rg.controlerTour(cfg, [aj('package.json', 'lodash')], { requete, now: t0 + 6 * 86400000 });
    assert.equal(faux.state.hits.length, 0, 'un connu tient sept jours');
    await rg.controlerTour(cfg, [aj('package.json', 'lodash')], { requete, now: t0 + 8 * 86400000 });
    assert.deepEqual(faux.state.hits.map((h) => h.path), ['/lodash']);
    // Le seuil « récent » s'applique à la lecture : le même cache, un autre N.
    rg.poser('npm', 'jeune', { status: 'known', first_published: new Date(t0 - 10 * 86400000).toISOString(), now: new Date(t0).toISOString() });
    assert.equal(rg.pourDependances({ ...cfg, registry_recent_days: '30' }, repoId, [{ parser: 'package.json', name: 'jeune' }], { now: t0 })[0].status, 'recent');
    assert.equal(rg.pourDependances({ ...cfg, registry_recent_days: '5' }, repoId, [{ parser: 'package.json', name: 'jeune' }], { now: t0 })[0].status, 'known');
  });

  test('réglage décoché : zéro requête sortante sur un tour complet, et la carte dit « désactivé » ; coché, elle compte les inconnues', async () => {
    faux.reset();
    db.prepare('DELETE FROM registry_lookup').run();
    // Une MR ouverte relevée, dont le package.json fait entrer left-pad (inconnu) et vitest.
    const mrId = Number(db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, closed_seen, updated_at)
      VALUES (?, 1, 'MR 1', 'feature/1', 'main', 'sha1', 'to_review', 0, ?)`).run(repoId, now).lastInsertRowid);
    c.poserFichiers(mrId, 'sha1', ['package.json', 'src/a.js'], { source: 'forge', now });
    dp.poserManifestes(mrId, 'sha1', [{ path: 'package.json', diff: fixture('package-json-added.diff') }], { now });
    const off = { ...cfg, registry_enabled: '0' };
    const bilan = await c.releverTour(off, { onLog: () => {} });
    assert.equal(bilan.registry, null);
    assert.equal(faux.state.hits.length, 0, 'décoché : rien ne sort, pas même une lecture');
    let carte = dp.pourCartes(off)[mrId];
    assert.deepEqual([carte.added, carte.unknown, carte.recent, carte.registry], [2, 0, 0, { enabled: false }]);
    assert.equal(carte.manifests[0].added[0].registry, undefined, 'aucune colonne registre sur les lignes');
    // Coché : le tour contrôle les deux ajoutées (left-pad 404, vitest connu), la carte dit « 1 inconnue ».
    const journal = [];
    db.prepare('UPDATE config SET registry_enabled = ?, deps_enabled = ?, mr_files_enabled = ? WHERE id = 1').run('1', '1', '1');
    db.prepare('UPDATE local_config SET registry_urls = ? WHERE id = 1').run(faux.urls);
    const b2 = await rg.controlerTour(cfg, dp.ajouteesOuvertes(cfg), { requete, onLog: (m) => journal.push(m) });
    assert.deepEqual([b2.controles, b2.inconnus], [2, 1]);
    assert.match(journal[0], /Registre : 2 appel\(s\) \(npm 2\) vers 127\.0\.0\.1 — 1 inconnu\(s\)/);
    carte = dp.pourCartes(cfg)[mrId];
    assert.deepEqual([carte.added, carte.unknown, carte.recent], [2, 1, 0]);
    assert.equal(carte.registry.enabled, true);
    assert.deepEqual(Object.keys(carte.registry.contacted), ['npm']);
    assert.deepEqual(carte.registry.private, { kind: 'config' });
    const lignes = carte.manifests[0].added.map((e) => [e.name, e.registry.status, e.registry.label]);
    assert.deepEqual(lignes, [['left-pad', 'unknown', 'npm'], ['vitest', 'known', 'npm']]);
    assert.deepEqual(dp.ajoutantDesDependances(cfg).map((m) => [m.iid, m.added, m.unknown, m.recent]), [[1, 2, 1, 0]], 'le brief porte le complément');
    // Le relevé de découverte le fait de lui-même, après les manifestes.
    rg.poser('npm', 'left-pad', { status: 'skipped', reason: 'cap' });
    const b3 = await c.releverTour(cfg, { onLog: () => {} });
    assert.equal(b3.registry.controles, 1, 'le tour de découverte reprend le nom en attente');
  });

  test('proxy : HTTP_PROXY renseigné → la requête passe par le proxy ; NO_PROXY l’écarte ; ALL_PROXY et les minuscules sont lus', async () => {
    const proxy = await registres.startProxy();
    const env = { ...process.env };
    try {
      assert.equal(httpreq.proxyDepuisEnv('http://registry.npmjs.org/x', { HTTP_PROXY: 'http://p:3128' }), 'http://p:3128');
      assert.equal(httpreq.proxyDepuisEnv('https://registry.npmjs.org/x', { HTTP_PROXY: 'http://p:3128' }), null, 'HTTP_PROXY ne vaut pas pour https');
      assert.equal(httpreq.proxyDepuisEnv('https://registry.npmjs.org/x', { https_proxy: 'http://p:3128' }), 'http://p:3128');
      assert.equal(httpreq.proxyDepuisEnv('https://pypi.org/x', { ALL_PROXY: 'http://p:3128', NO_PROXY: '.org' }), null);
      assert.equal(httpreq.proxyDepuisEnv('https://pypi.org/x', { ALL_PROXY: 'http://p:3128', no_proxy: 'localhost,127.0.0.1' }), 'http://p:3128');
      assert.equal(httpreq.proxyDepuisEnv('https://pypi.org/x', { HTTPS_PROXY: 'http://p:3128', NO_PROXY: '*' }), null);
      assert.equal(httpreq.proxyDepuisEnv('http://127.0.0.1:9/x', { HTTP_PROXY: 'http://p:3128', NO_PROXY: '127.0.0.1:8' }), 'http://p:3128', 'un port qui ne correspond pas ne compte pas');
      process.env.HTTP_PROXY = proxy.url; process.env.HTTPS_PROXY = proxy.url; delete process.env.NO_PROXY; delete process.env.no_proxy;
      faux.reset();
      const r = await rg.interroger('npm', 'via-proxy', faux.base, { requete });
      assert.equal(r.status, 'known');
      assert.equal(proxy.state.hits.length, 1, 'passée par le proxy');
      assert.equal(proxy.state.hits[0].url, `${faux.base}/via-proxy`, 'l’URL absolue, comme l’attend un proxy HTTP');
      assert.equal(hits(/via-proxy/).length, 1, 'le proxy l’a relayée au registre');
      process.env.NO_PROXY = '127.0.0.1';
      await rg.interroger('npm', 'direct', faux.base, { requete });
      assert.equal(proxy.state.hits.length, 1, 'NO_PROXY : en direct');
      assert.equal(hits(/\/direct$/).length, 1);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
      await proxy.stop();
    }
  });

  test('session de codage : la ligne de projet compte « 1 inconnue » une fois le contrôle d’arrière-plan passé ; dix noms au plus par session', async () => {
    db.prepare('UPDATE local_config SET registry_urls = ? WHERE id = 1').run(faux.urls);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cible-'));
    const avec = path.join(dir, 'avec.patch');
    fs.writeFileSync(avec, fixture('package-json-added.diff'));
    rg.poser('npm', 'left-pad', { status: 'skipped', reason: 'cap' });
    db.prepare("DELETE FROM registry_lookup WHERE name = 'vitest'").run();
    faux.reset();
    const cible = { id: 77, repo_id: repoId, commit_sha: 'c1', diff_path: avec };
    const avant = dp.pourCible(cfg, cible);
    assert.deepEqual([avant.added, avant.unknown], [2, 0], 'au premier rendu, le cache ne sait rien encore');
    for (let i = 0; i < 100 && faux.state.hits.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 100 && !(rg.etatDe('npm', 'left-pad').status === 'unknown' && rg.etatDe('npm', 'vitest')); i += 1) await new Promise((r) => setTimeout(r, 50));
    const apres = dp.pourCible(cfg, cible);
    assert.deepEqual([apres.added, apres.unknown, apres.recent], [2, 1, 0], 'le rendu suivant montre « 1 inconnue »');
    assert.equal(dp.pourCible({ ...cfg, registry_enabled: '0' }, cible).unknown, 0);
    assert.equal(rg.PLAFOND_SESSION, 10);
    faux.reset();
    const douze = Array.from({ length: 12 }, (x, i) => aj('package.json', `s${i}`));
    const b = await rg.controlerTour(cfg, douze, { requete, max: rg.PLAFOND_SESSION });
    assert.deepEqual([b.controles, b.plafonnes, faux.state.hits.length], [10, 2, 10]);
  });

  test('le module n’importe aucun module d’agent ni de forge ; la purge des entrées périmées ; la validation des URL', () => {
    const src = lireSource('review/registre');
    assert.ok(!/require\(['"][^'"]*\/(agent|ai|forge)[/'"]/.test(src), 'aucun require vers agent/, ai* ou forge/');
    assert.ok(!/fetch\(|console\.log/.test(src));
    const { normaliserUrls, urlsDepuis } = require('../src/core/registres');
    assert.equal(normaliserUrls('npm=https://npm.corp.example/\n pypi = '), 'npm=https://npm.corp.example\npypi=');
    assert.throws(() => normaliserUrls('bidule=https://x'), /écosystème inconnu/);
    assert.throws(() => normaliserUrls('npm=ftp://x'), /http\(s\)/);
    assert.throws(() => normaliserUrls('n’importe quoi'), /ligne 1/);
    assert.deepEqual(rg.pourDependances({ ...cfg, registry_urls: 'pypi=' }, repoId, [{ parser: 'requirements.txt', name: 'requests' }]).map((x) => [x.status, x.reason]), [['skipped', 'no-registry']]);
    assert.equal(urlsDepuis('').npm, 'https://registry.npmjs.org');
    assert.deepEqual(rg.pourDependances(cfg, repoId, [{ parser: 'pom.xml', name: 'junit' }]).map((x) => [x.status, x.reason]), [['skipped', 'no-group']], 'Maven sans groupId : non contrôlé, jamais inventé');
    rg.poser('npm', 'vieux', { status: 'known', now: new Date(Date.now() - 100 * 86400000).toISOString() });
    assert.ok(rg.purgerPerimees() >= 1);
    assert.equal(rg.etatDe('npm', 'vieux'), null);
  });
});
