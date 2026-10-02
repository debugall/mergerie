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
