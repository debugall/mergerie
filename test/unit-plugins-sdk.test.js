'use strict';
/* LE SDK DE TEST ET LE CTX, SANS MERGERIE : `createTestContext` rend le même ctx que le serveur,
 * sur une base en mémoire. Ce qu'on prouve ici vaut donc pour le serveur — et c'est ce qu'un
 * auteur de plugin tiers exécutera chez lui.
 *
 * Les gardes : une table hors préfixe est refusée, une route hors préfixe aussi, un réglage
 * hors schéma aussi, un événement non déclaré aussi ; un secret se masque et s'efface quand
 * l'adresse à laquelle il est lié change d'origine ; les migrations ne se rejouent jamais. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sdk = require('../sdk');

const FIXTURE = path.join(__dirname, 'fixtures', 'plugins', 'hello-fixture');

describe('SDK — préfixes de tables qui se chevauchent', () => {
  const dbp = require('../sdk/lib/dbplugin');
  const manifeste = (nom) => ({ name: nom, version: '1.0.0', apiVersion: '1', displayName: nom, description: '', main: 'index.js', permissions: ['db'] });
  test('une table appartient au plugin dont le préfixe est le PLUS LONG parmi les plugins connus', () => {
    const noms = ['jenkins', 'jenkins-teams-notify', 'ab', 'a'];
    assert.equal(dbp.proprietaire('plugin_jenkins_link', noms), 'jenkins');
    assert.equal(dbp.proprietaire('plugin_jenkins_teams_notify_log', noms), 'jenkins-teams-notify');
    assert.equal(dbp.proprietaire('plugin_ab_x', noms), 'ab');
    assert.equal(dbp.proprietaire('plugin_a_x', noms), 'a');
    assert.equal(dbp.proprietaire('plugin_inconnu_x', noms), null);
    assert.equal(dbp.proprietaire('repo', noms), null);
  });
  test('un upsert `ON CONFLICT … DO UPDATE SET` n’est pas lu comme une mise à jour de la table « set » ; une vraie autre table reste refusée', () => {
    const upsert = 'INSERT INTO plugin_x_t (a, b) VALUES (?, ?) ON CONFLICT(a) DO UPDATE SET b = excluded.b';
    assert.deepEqual(dbp.tablesDe(upsert), ['plugin_x_t']);
    assert.throws(() => dbp.verifier('plugin_x_', 'INSERT INTO plugin_x_t (a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = (SELECT 1 FROM repo)'), /repo/);
  });
  test('le garde refuse au plugin « court » la table du plugin « long » CONNU — et rien d’autre ne change', () => {
    const t = sdk.createTestContext({ manifest: manifeste('jenkins'), otherPlugins: ['jenkins-teams-notify'] });
    t.db.exec('CREATE TABLE plugin_jenkins_link (id INTEGER)');
    t.db.exec('CREATE TABLE plugin_jenkins_teams_notify_log (id INTEGER)');
    assert.doesNotThrow(() => t.ctx.db.prepare('SELECT * FROM plugin_jenkins_link'));
    for (const sql of ['SELECT * FROM plugin_jenkins_teams_notify_log', 'DROP TABLE plugin_jenkins_teams_notify_log', 'DELETE FROM plugin_jenkins_teams_notify_log']) {
      assert.throws(() => t.ctx.db.prepare(sql), /appartient à un autre plugin/, sql);
    }
    assert.throws(() => t.ctx.db.exec('DROP TABLE plugin_jenkins_teams_notify_log'), /autre plugin/);
    assert.throws(() => t.ctx.db.classify('plugin_jenkins_teams_notify_log', 'L'), /n'appartient pas/);
    assert.deepEqual(t.ctx.db.tables(), ['plugin_jenkins_link'], 'et tables() ne la liste pas');
    t.close();
  });
  test('le plugin « long » garde ses tables ; sans voisin connu, rien ne change (le SDK de test seul ne connaît personne)', () => {
    const long = sdk.createTestContext({ manifest: manifeste('jenkins-teams-notify'), otherPlugins: ['jenkins'] });
    long.db.exec('CREATE TABLE plugin_jenkins_teams_notify_log (id INTEGER)');
    assert.doesNotThrow(() => long.ctx.db.prepare('SELECT * FROM plugin_jenkins_teams_notify_log'));
    assert.deepEqual(long.ctx.db.tables(), ['plugin_jenkins_teams_notify_log']);
    long.close();
    const seul = sdk.createTestContext({ manifest: manifeste('jenkins') });
    seul.db.exec('CREATE TABLE plugin_jenkins_teams_notify_log (id INTEGER)');
    assert.doesNotThrow(() => seul.ctx.db.prepare('SELECT * FROM plugin_jenkins_teams_notify_log'), 'inconnu du SDK : traité comme sa propre table');
    seul.close();
  });
  test('tables() n’emploie pas LIKE : le « _ » du préfixe n’est pas un joker', () => {
    const t = sdk.createTestContext({ manifest: manifeste('jenkins') });
    t.db.exec('CREATE TABLE plugin_jenkinsX_t (id INTEGER)');   // « plugin_jenkins_% » l'attraperait : « _ » = n'importe quel caractère
    t.db.exec('CREATE TABLE plugin_jenkins_t (id INTEGER)');
    assert.deepEqual(t.ctx.db.tables(), ['plugin_jenkins_t']);
    t.close();
  });
});

describe('SDK — ctx.exec : l’environnement ne contourne pas la liste blanche', () => {
  const fs = require('node:fs'); const os = require('node:os');
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-env-')), 's.js');
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify({ d: process.env.DISPLAY || null, p: process.env.PATH_PLUGIN || null }))");
  const ctx = () => sdk.createTestContext({ manifest: { name: 'p', version: '1.0.0', apiVersion: '1', displayName: 'P', description: '', main: 'index.js', permissions: ['exec'] } });
  const lancer = (t, env) => t.ctx.exec(process.execPath, [script], { allowlist: [script], timeoutMs: 15000, env });
  test('PATH, LD_PRELOAD, DYLD_*, NODE_OPTIONS, GIT_*, SHELL, BASH_ENV… sont refusés, quelle que soit la casse', async () => {
    const t = ctx();
    for (const k of ['PATH', 'path', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_COUNT', 'SHELL', 'BASH_ENV', 'ENV', 'IFS']) {
      await assert.rejects(() => lancer(t, { [k]: 'x' }), /variable d'environnement .* refusée/, k);
    }
    t.close();
  });
  test('les variables d’un outil passent : DISPLAY, PLAYWRIGHT_BROWSERS_PATH, NODE_PATH, et celles du plugin', async () => {
    const t = ctx();
    const r = await lancer(t, { DISPLAY: ':9', PLAYWRIGHT_BROWSERS_PATH: '/x', NODE_PATH: '/y', PATH_PLUGIN: 'ok' });
    assert.deepEqual(JSON.parse(r.stdout), { d: ':9', p: 'ok' });
    t.close();
  });
});

describe('SDK — ctx.dataDir (permission storage)', () => {
  const manifeste = (permissions) => ({ name: 'p', version: '1.0.0', apiVersion: '1', displayName: 'P', description: '', main: 'index.js', permissions });
  test('avec « storage » : un dossier existant et privé ; sans, la primitive n’existe pas', () => {
    const fs = require('node:fs');
    const avec = sdk.createTestContext({ manifest: manifeste(['storage']) });
    assert.equal(typeof avec.ctx.dataDir, 'string');
    assert.ok(fs.statSync(avec.ctx.dataDir).isDirectory(), 'le dossier est créé');
    fs.writeFileSync(path.join(avec.ctx.dataDir, 'x'), 'y');
    avec.close();
    const sans = sdk.createTestContext({ manifest: manifeste(['settings']) });
    assert.equal(sans.ctx.dataDir, undefined);
    sans.close();
  });
  test('le contrat la décrit : permission, primitive, et l’option env de ctx.exec', () => {
    const c = require('../sdk/contract');
    assert.ok(c.PERMISSIONS.storage);
    assert.equal(c.CTX.dataDir.permission, 'storage');
    assert.match(c.CTX.exec.signature, /env\?: Record<string, string>/);
  });
});

describe('SDK — createTestContext', () => {
  test('le ctx ne porte QUE les primitives des permissions déclarées, et il est gelé', () => {
    const t = sdk.createTestContext({ manifest: { name: 'p', version: '1.0.0', apiVersion: '1', displayName: 'P', description: '', main: 'index.js', permissions: ['settings', 'http'] } });
    const prims = sdk.primitivesDe(t.ctx);
    assert.ok(prims.includes('settings.get') && prims.includes('http.router'), 'ce qui est déclaré est là');
    assert.ok(!prims.includes('db.prepare') && !prims.includes('events.on') && !prims.includes('exec'), 'ce qui ne l’est pas n’existe pas');
    assert.ok(prims.includes('log') && prims.includes('i18n.register'), 'log et i18n sont toujours là');
    assert.throws(() => { t.ctx.autre = 1; }, /object is not extensible|Cannot add property/);
    t.close();
  });

  test('settingsSchema : défauts, conversion, bornes, refus de l’inconnu ; secrets masqués et liés à l’adresse', () => {
    const t = sdk.createTestContext({ dir: FIXTURE });
    const { ctx } = t;
    assert.deepEqual(ctx.settings.get(), { greeting: 'bonjour', url: '', every: 5 }, 'les défauts du schéma, sans les secrets');
    ctx.settings.set({ greeting: '  salut  ', every: '99', url: 'https://ci.example.com/' });
    assert.deepEqual(ctx.settings.get(), { greeting: 'salut', url: 'https://ci.example.com', every: 60 }, 'trim, borne haute, slash final retiré');
    assert.throws(() => ctx.settings.set({ inconnu: 1 }), /réglage inconnu : inconnu/);
    assert.throws(() => ctx.settings.set({ url: 'ftp://x' }), /adresse http\(s\) attendue/);
    ctx.settings.set({ token: 'secret-1' });
    assert.equal(ctx.secrets.get('token'), 'secret-1');
    assert.equal(ctx.settings.get('token'), undefined, 'un secret ne ressort jamais par settings.get');
    ctx.settings.set({ token: '***' });
    assert.equal(ctx.secrets.get('token'), 'secret-1', '*** = inchangé');
    ctx.settings.set({ url: 'https://ci.example.com/jenkins' });
    assert.equal(ctx.secrets.get('token'), 'secret-1', 'même origine : le jeton reste');
    ctx.settings.set({ url: 'https://autre.example.com' });
    assert.equal(ctx.secrets.has('token'), false, 'autre origine sans jeton refourni : effacé — il ne part pas ailleurs');
    assert.equal(ctx.secrets.freshRequired('https://b.example.com', 'https://a.example.com', '***', 'x'), true);
    assert.equal(ctx.secrets.freshRequired('https://a.example.com/x', 'https://a.example.com', '***', 'x'), false);
    let vu = null;
    ctx.settings.onChange((s) => { vu = s; });
    ctx.settings.set({ greeting: 'hey' });
    assert.equal(vu.greeting, 'hey', 'onChange est prévenu');
    t.close();
  });

  test('ctx.db : le préfixe est la frontière, les migrations vont en avant seulement', () => {
    const t = sdk.createTestContext({ dir: FIXTURE });
    const { ctx } = t;
    t.db.exec("CREATE TABLE local_config (id INTEGER, access_token TEXT); INSERT INTO local_config VALUES (1, 'glpat-SECRET')");
    assert.throws(() => ctx.db.prepare('SELECT access_token FROM local_config').get(), /n'appartient pas au plugin/);
    assert.throws(() => ctx.db.prepare('SELECT * FROM plugin_other_t').all(), /n'appartient pas au plugin/);
    assert.throws(() => ctx.db.prepare('SELECT name FROM sqlite_master').all(), /n'appartient pas au plugin/);
    assert.throws(() => ctx.db.exec("ATTACH DATABASE ':memory:' AS x"), /ATTACH n'est pas permis/);
    assert.throws(() => ctx.db.prepare('SELECT * FROM plugin_hello_fixture_a a JOIN repo r ON r.id = a.id').all(), /« repo » n'appartient pas/);
    assert.throws(() => ctx.db.classify('repo', 'L'), /n'appartient pas/);
    assert.throws(() => ctx.db.classify('plugin_hello_fixture_x', 'P'), /L ou C/);
    const migrations = [
      { version: 1, up: 'CREATE TABLE plugin_hello_fixture_note (id INTEGER PRIMARY KEY, texte TEXT)' },
      { version: 2, up: (db) => db.exec("INSERT INTO plugin_hello_fixture_note (texte) VALUES ('v2')") },
    ];
    assert.equal(ctx.db.migrate(migrations), 2);
    assert.equal(ctx.db.migrate(migrations), 0, 'rejouer ne fait rien');
    assert.equal(ctx.db.migrate([...migrations, { version: 3, up: "INSERT INTO plugin_hello_fixture_note (texte) VALUES ('v3')" }]), 1, 'seule la nouvelle passe');
    assert.deepEqual(ctx.db.prepare('SELECT texte FROM plugin_hello_fixture_note ORDER BY id').all().map((r) => r.texte), ['v2', 'v3']);
    assert.deepEqual(ctx.db.tables(), ['plugin_hello_fixture_note']);
    // Alias et CTE : des noms qui ne sont pas des tables.
    assert.equal(ctx.db.prepare('WITH derniers AS (SELECT * FROM plugin_hello_fixture_note) SELECT COUNT(*) c FROM derniers d').get().c, 2);
    t.close();
  });

  test('le routeur : routes sous le préfixe, requête simple, erreurs avec statut', async () => {
    const t = await sdk.activatePlugin(FIXTURE, { env: { HELLO_FIXTURE_X: 'oui' } });
    assert.throws(() => t.ctx.http.router.get('/api/config', () => ({})), /ne monte rien hors de/);
    assert.throws(() => t.ctx.http.router.get('ping', () => ({})), /commençant par « \/ »/);
    const ping = await t.http.call('GET', '/ping?q=1');
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { pong: true, greeting: 'bonjour', q: '1', lang: 'fr' });
    const boom = await t.http.call('GET', '/boom');
    assert.deepEqual([boom.status, boom.body.error], [418, 'boom demandé']);
    assert.equal((await t.http.call('GET', '/nulle-part')).status, 404);
    const cree = await t.http.call('POST', '/notes', { body: { texte: 'a' } });
    assert.equal(cree.body.id, 1);
    assert.deepEqual((await t.http.call('GET', '/notes')).body.notes, [{ id: 1, texte: 'a' }]);
    const seen = await t.http.call('GET', '/seen');
    assert.equal(seen.body.env, 'oui', 'ctx.env lit les variables préfixées par le nom du plugin');
    assert.throws(() => t.ctx.env.get('PATH'), /seules les variables HELLO_FIXTURE_\*/);
    await t.deactivate();
  });

  test('événements, tâches, notifications, services, démo, déclarations d’écran', async () => {
    const t = await sdk.activatePlugin(FIXTURE, { repos: [{ id: 7, project: 'g/p' }] });
    await t.emit('session.finished', { kind: 'task', id: 3, action: 'run', status: 'done' });
    await t.emit('repo.deleted', { id: 7, project: 'g/p' });
    let seen = (await t.http.call('GET', '/seen')).body.seen;
    assert.equal(seen[0].id, 3); assert.equal(seen[0].version, 1); assert.deepEqual(seen[1], { removed: 7 });
    assert.equal(await t.tick(), 1, 'une tâche jouée à la main');
    assert.equal((await t.http.call('GET', '/seen')).body.ticks, 1);
    await assert.rejects(t.ctx.events.emit('autre.evenement', {}), /non déclaré dans plugin\.json/);
    let recu = null;
    t.bus.on('hello-fixture.pinged', (p) => { recu = p; });
    await t.http.call('POST', '/ring');
    assert.equal(recu.n, 1, 'un événement du plugin circule sur le bus');
    assert.deepEqual(t.notifications.map((n) => n.type), ['hello_rang']);
    assert.throws(() => t.ctx.notify.push('inconnu', {}), /genre non déclaré/);
    assert.deepEqual((await t.http.call('GET', '/service')).body, { echo: { a: 1 }, greeting: 'bonjour' });
    assert.equal((await t.http.call('GET', '/repos')).body.repos, 1);
    assert.equal(await t.seed(), 1);
    assert.equal((await t.http.call('GET', '/notes')).body.notes.length, 1, 'la seed de démo a écrit');
    const ui = t.ui();
    assert.deepEqual(ui.tabs.map((x) => x.id), ['hello']);
    assert.deepEqual(ui.settingsTabs.map((x) => x.id), ['hellocfg']);
    assert.deepEqual(ui.actions.map((x) => `${x.target}:${x.id}`), ['mr:hello-say']);
    assert.deepEqual(ui.notifKinds.map((x) => x.type), ['hello_rang']);
    assert.equal(t.i18n.t('hello-fixture.tab'), 'Hello', 'le dictionnaire du plugin est enregistré');
    const palette = await t.registre.palette('hello');
    assert.equal(palette[0].nav.plugin, 'hello-fixture');
    assert.throws(() => t.ctx.ui.registerAction({ id: 'x', target: 'nulle-part', label: 'x' }), /target hors de/);
    assert.throws(() => t.ctx.schedule(10, () => {}), /≥ 1000 ms/);
    await t.deactivate();
    assert.equal(t.bus.ecoutesPar('hello-fixture').length, 0, 'la désactivation retire les abonnements');
  });

  test('le manifeste : ce qui est refusé, et pourquoi', () => {
    const bon = { name: 'ok-plugin', version: '1.0.0', apiVersion: '1', displayName: 'Ok', description: 'd', main: 'index.js' };
    assert.deepEqual(sdk.validateManifest(bon), []);
    assert.match(sdk.validateManifest({ ...bon, name: 'Pas_Kebab' }).join(' '), /kebab-case/);
    assert.match(sdk.validateManifest({ ...bon, version: '1.0' }).join(' '), /semver/);
    assert.match(sdk.validateManifest({ ...bon, apiVersion: '99' }).join(' '), /apiVersion « 99 » non supportée/);
    assert.match(sdk.validateManifest({ ...bon, permissions: ['root'] }).join(' '), /permission inconnue : root/);
    assert.match(sdk.validateManifest({ ...bon, events: { emits: ['autre.x'] } }).join(' '), /préfixé par « ok-plugin\. »/);
    assert.match(sdk.validateManifest({ ...bon, main: '../x.js' }).join(' '), /chemin relatif/);
    assert.match(sdk.validateManifest({ ...bon, settingsSchema: { type: 'object', properties: { x: { type: 'array' } } } }).join(' '), /type string \| number/);
    assert.ok(sdk.readManifest(FIXTURE).ok);
  });
});

describe('SDK — jobs, flux de processus, répertoires locaux', () => {
  const m = (permissions) => ({ name: 'tj', version: '1.0.0', apiVersion: '1', displayName: 'tj', description: 'x', main: 'index.js', permissions });
  const SCRIPT = path.join(__dirname, 'fixtures', 'plugins', 'runs-jobs', 'lines.js');

  test('ctx.jobs : le runner reçoit un job (journal, progression, exec) ; une exception met le job en erreur', async () => {
    const t = sdk.createTestContext({ manifest: m(['jobs', 'exec']) });
    t.ctx.jobs.register('copie', async (job, payload) => {
      job.message('début'); job.progress(1, 2);
      const r = await job.exec(process.execPath, [SCRIPT], { allowlist: [SCRIPT] });
      if (payload.fail) throw new Error('boum');
      return r;
    });
    const ok = t.ctx.jobs.start('copie', { fail: false }, { label: 'Copie' });
    assert.equal(ok.status, 'queued');
    const fini = await t.jobs.wait(ok.id);
    assert.deepEqual([fini.status, fini.progress], ['done', { done: 1, total: 2 }]);
    assert.deepEqual([...fini.logs].sort(), ['deux', 'trois', 'un'], 'stdout et stderr arrivent dans un ordre qu’aucun des deux ne garantit');
    const ko = await t.jobs.wait(t.ctx.jobs.start('copie', { fail: true }).id);
    assert.deepEqual([ko.status, ko.error], ['error', 'boum']);
    assert.throws(() => t.ctx.jobs.start('inconnu'), /non inscrit/);
    assert.throws(() => t.ctx.jobs.register('Mauvais Nom', () => {}), /kebab-case/);
  });

  test('ctx.execStream : les lignes arrivent au fil de l’eau, close() arrête le processus, les gardes de exec s’appliquent', async () => {
    const t = sdk.createTestContext({ manifest: m(['exec']) });
    const lignes = [];
    let fin = null;
    const h = t.ctx.execStream(process.execPath, [SCRIPT, '--wait'], { allowlist: [SCRIPT] }, (f, l) => lignes.push(`${f}:${l}`), (r) => { fin = r; });
    for (let i = 0; i < 100 && lignes.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([...lignes].sort(), ['stderr:deux', 'stdout:trois', 'stdout:un']);
    h.close();
    for (let i = 0; i < 100 && !fin; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fin && fin.code !== 0, 'tué : code non nul');
    let refus = null;
    t.ctx.execStream(process.execPath, ['--eval', 'x'], { allowlist: ['x'] }, () => {}, (r) => { refus = r; });
    for (let i = 0; i < 50 && !refus; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(refus.error, /drapeau refusé|hors liste blanche/);
    assert.throws(() => t.ctx.execStream(process.execPath, [], { allowlist: ['x'] }), /onLine/);
  });

  test('ctx.repos.localRoots : les répertoires locaux, et rien sans la permission repos', () => {
    const t = sdk.createTestContext({ manifest: m(['repos']), localRoots: [{ path: '/tmp/a', label: 'A' }, { path: '/tmp/b' }] });
    assert.deepEqual(t.ctx.repos.localRoots().map((r) => [r.path, r.label]), [['/tmp/a', 'A'], ['/tmp/b', '']]);
    assert.equal(sdk.createTestContext({ manifest: m([]) }).ctx.repos, undefined);
  });
});
