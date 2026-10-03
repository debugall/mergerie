'use strict';
/* LE CHARGEUR, SUR UN VRAI SERVEUR : installer, activer À CHAUD, désactiver, réactiver — et
 * tout ce qu'un plugin tiers hostile tente, refusé un par un sans que Mergerie cesse de répondre.
 *
 * Les fixtures sont des plugins TIERS (copiés dans `<dataDir>/plugins/`) : ils tournent donc
 * dans un worker, le chemin que prend n'importe quel plugin installé par un utilisateur. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers/app');

const FIXTURES = path.join(__dirname, 'fixtures', 'plugins');

function copier(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copier(s, d); else fs.copyFileSync(s, d);
  }
}

describe('Plugins — chargeur et isolation', () => {
  let app;
  const page = async () => (await app.api('GET', '/')).text;
  const liste = async () => (await app.api('GET', '/api/plugins')).body.plugins;
  const de = async (nom) => (await liste()).find((p) => p.name === nom);

  before(async () => {
    app = await startApp();
    await app.configure();
    for (const nom of fs.readdirSync(FIXTURES)) copier(path.join(FIXTURES, nom), path.join(app.dataDir, 'plugins', nom));
  });
  after(async () => { if (app) await app.stop(); });

  test('rescanner découvre les plugins déposés ; un tiers est DÉSACTIVÉ d’office, un apiVersion inconnu est incompatible', async () => {
    const r = await app.api('POST', '/api/plugins/rescan');
    assert.equal(r.status, 200);
    const noms = r.body.plugins.map((p) => p.name).sort();
    for (const n of ['hello-fixture', 'hostile', 'bad-api', 'throws', 'loops', 'needs-other']) assert.ok(noms.includes(n), n);
    const hello = await de('hello-fixture');
    assert.deepEqual([hello.enabled, hello.active, hello.state, hello.builtin], [false, false, 'inactive', false]);
    assert.deepEqual(hello.permissions.slice(0, 3), ['events', 'settings', 'secrets']);
    const bad = await de('bad-api');
    assert.equal(bad.state, 'incompatible');
    assert.match(bad.error, /apiVersion « 99 » non supportée/);
    assert.equal((await app.api('POST', '/api/plugins/bad-api/enable')).body.ok, false, 'jamais chargé');
    assert.equal((await app.api('GET', '/api/plugins/hello-fixture/ping')).status, 404, 'inactif : aucune route ne répond');
    assert.ok(!(await page()).includes('data-tab="hello"'), 'inactif : pas d’onglet');
  });

  test('activer à chaud : routes, onglet, bundle, dictionnaire, réglages — puis désactiver retire tout et garde les données', async () => {
    const on = await app.api('POST', '/api/plugins/hello-fixture/enable');
    assert.equal(on.status, 200);
    assert.equal(on.body.ok, true, on.body.error || '');
    const ping = await app.api('GET', '/api/plugins/hello-fixture/ping?q=2');
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { pong: true, greeting: 'bonjour', q: '2', lang: 'fr' });
    assert.equal((await app.api('GET', '/api/plugins/hello-fixture/boom')).status, 418, 'le statut de l’erreur du plugin traverse le worker');
    const html = await page();
    assert.ok(html.includes('data-tab="hello"') && html.includes('id="tab-hello"'), 'l’onglet et son panneau sont dans la page');
    assert.ok(html.includes('/plugins/hello-fixture/bundle.js') && html.includes('/plugins/hello-fixture/ui/hello.css'), 'le bundle et la feuille sont dans le manifeste');
    assert.ok(html.includes('data-sub="hellocfg"'), 'le sous-onglet de réglages est dans la page');
    const bundle = await app.api('GET', '/plugins/hello-fixture/bundle.js');
    assert.equal(bundle.status, 200);
    assert.match(bundle.text, /^\(function \(mergerie\) \{\n'use strict';\nconst \{ \$, /, 'le bundle enveloppe les scripts avec le kit en portée');
    assert.match(bundle.text, /HELLO_FIXTURE_CHARGE/);
    const meta = JSON.parse((html.match(/<script type="application\/json" id="mergeriePlugins">([\s\S]*?)<\/script>/) || [])[1]);
    assert.equal(meta.plugins['hello-fixture'].tabs[0].searchField, '#helloSearch');
    assert.equal(meta.plugins['hello-fixture'].actions[0].id, 'hello-say');
    // Réglages : lus masqués, écrits validés.
    await app.api('PUT', '/api/plugins/hello-fixture/settings', { greeting: 'yo', token: 'tok', url: 'https://ci.example.com' });
    const s = await app.api('GET', '/api/plugins/hello-fixture/settings');
    assert.deepEqual(s.body, { greeting: 'yo', url: 'https://ci.example.com', every: 5, token: '***' });
    assert.equal((await app.api('PUT', '/api/plugins/hello-fixture/settings', { inconnu: 1 })).status, 400);
    assert.equal((await app.api('GET', '/api/plugins/hello-fixture/ping')).body.greeting, 'yo', 'le plugin relit ses réglages');
    // Données, événements, services.
    assert.equal((await app.api('POST', '/api/plugins/hello-fixture/notes', { texte: 'persistante' })).body.id, 1);
    assert.deepEqual((await app.api('GET', '/api/plugins/hello-fixture/service')).body, { echo: { a: 1 }, greeting: 'yo' });
    const fiche = await de('hello-fixture');
    assert.deepEqual([fiche.state, fiche.active], ['active', true]);
    assert.ok(fiche.events.listens.includes('session.finished'), 'les abonnements réels sont listés');
    assert.equal(fiche.ui.tabs[0], 'hello');

    const off = await app.api('POST', '/api/plugins/hello-fixture/disable');
    assert.equal(off.status, 200);
    assert.equal((await app.api('GET', '/api/plugins/hello-fixture/ping')).status, 404, 'plus aucune route');
    assert.equal((await app.api('GET', '/plugins/hello-fixture/bundle.js')).status, 404);
    const html2 = await page();
    assert.ok(!html2.includes('data-tab="hello"') && !html2.includes('/plugins/hello-fixture/bundle.js'), 'onglet et bundle retirés sans redémarrage');
    assert.deepEqual([(await de('hello-fixture')).active, (await de('hello-fixture')).enabled], [false, false]);
    assert.equal(app.db.prepare("SELECT COUNT(*) c FROM plugin_hello_fixture_note").get().c, 1, 'la table du plugin est intacte');
    assert.equal(app.db.prepare("SELECT value FROM plugin_setting WHERE plugin = 'hello-fixture' AND key = 'greeting'").get().value, '"yo"', 'ses réglages aussi');

    // Réactiver, sans redémarrage : l'historique est là.
    assert.equal((await app.api('POST', '/api/plugins/hello-fixture/enable')).body.ok, true);
    assert.deepEqual((await app.api('GET', '/api/plugins/hello-fixture/notes')).body.notes, [{ id: 1, texte: 'persistante' }]);
    assert.equal((await app.api('GET', '/api/plugins/hello-fixture/ping')).body.greeting, 'yo');
  });

  test('les événements du cœur atteignent un plugin dans son worker, et le crash d’un handler n’atteint pas le cœur', async () => {
    const events = require('../src/core/events');
    const r = await events.emit('session.finished', { kind: 'task', id: 42, action: 'run', status: 'done' });
    assert.equal(r.delivered >= 1, true);
    const seen = (await app.api('GET', '/api/plugins/hello-fixture/seen')).body.seen;
    assert.equal(seen.find((p) => p.id === 42).version, 1);
    assert.equal((await app.api('GET', '/api/plugins/hello-fixture/seen')).body.token, true, 'le secret est en base');
  });

  test('un plugin hostile : chaque geste interdit est refusé avec son message, le serveur répond toujours', async () => {
    assert.equal((await app.api('POST', '/api/plugins/hostile/enable')).body.ok, true, 'il s’active : ses tentatives échouent une à une, pas lui');
    const refus = (await app.api('GET', '/api/plugins/hostile/refus')).body;
    assert.match(refus['table-hors-prefixe'], /« local_config » n'appartient pas au plugin/);
    assert.match(refus['table-autre-plugin'], /n'appartient pas au plugin/);
    assert.match(refus['sqlite-master'], /n'appartient pas au plugin/);
    assert.match(refus.attach, /ATTACH n'est pas permis/);
    assert.match(refus['route-hors-prefixe'], /ne monte rien hors de \/api\/plugins\/hostile\//);
    assert.match(refus['require-src'], /refusé — un plugin n'importe rien de src\//);
    assert.match(refus['primitive-non-declaree'], /Cannot read properties of undefined/, 'events n’est pas sur le ctx : la permission n’est pas déclarée');
    assert.match(refus['secrets-non-declares'], /Cannot read properties of undefined/);
    assert.match(refus['ui-non-declaree'], /Cannot read properties of undefined/);
    assert.match(refus['reglage-inconnu'], /réglage inconnu/);
    assert.match(refus['ctx-gele'], /not extensible/, 'le ctx est gelé : rien ne s’y ajoute');
    assert.equal((await app.api('GET', '/api/status')).status, 200, 'Mergerie répond');
    assert.equal((await app.api('GET', '/api/config')).body.access_token, '***', 'et ses secrets sont toujours là');
  });

  test('un plugin qui lève au activate() est « en erreur » avec le message ; un qui boucle est tué ; une dépendance absente se dit', async () => {
    const t = await app.api('POST', '/api/plugins/throws/enable');
    assert.equal(t.body.ok, false);
    assert.match(t.body.error, /je refuse de démarrer/);
    assert.equal((await de('throws')).state, 'error');
    const l = await app.api('POST', '/api/plugins/loops/enable');
    assert.equal(l.body.ok, false);
    assert.match(l.body.error, /n'a pas répondu en 10 s/);
    assert.equal((await app.api('GET', '/api/status')).status, 200, 'le serveur a survécu à la boucle infinie');
    const n = await app.api('POST', '/api/plugins/needs-other/enable');
    assert.equal(n.body.ok, false);
    assert.match(n.body.error, /dépend de absent-plugin \(inactif\)/);
    assert.deepEqual((await de('needs-other')).missing, ['absent-plugin']);
  });

  test('deux plugins dont les préfixes se chevauchent : le garde SQL les départage, et désinstaller l’un n’emporte JAMAIS les tables de l’autre', async () => {
    for (const nom of ['shares-prefix', 'shares-prefix-child']) {
      assert.equal((await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, nom) })).status, 200, nom);
      assert.equal((await app.api('POST', `/api/plugins/${nom}/enable`)).body.ok, true, nom);
    }
    const existe = (t) => !!app.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    assert.ok(existe('plugin_shares_prefix_own') && existe('plugin_shares_prefix_child_t'));
    // Le parent ne peut pas toucher à la table de l'enfant, et ne la voit pas dans tables().
    const peek = (await app.api('GET', '/api/plugins/shares-prefix/peek')).body;
    assert.match(peek.refus, /appartient à un autre plugin/);
    assert.deepEqual(peek.tables, ['plugin_shares_prefix_own']);
    assert.deepEqual((await app.api('GET', '/api/plugins/shares-prefix-child/own')).body.tables, ['plugin_shares_prefix_child_t']);
    // Désinstaller le parent AVEC ses données : la table de l'enfant reste.
    await app.api('POST', '/api/plugins/shares-prefix/disable');
    assert.equal((await app.api('POST', '/api/plugins/shares-prefix/uninstall', { deleteData: true })).status, 200);
    assert.equal(existe('plugin_shares_prefix_own'), false, 'ses tables sont parties');
    assert.equal(existe('plugin_shares_prefix_child_t'), true, 'celles de l’enfant sont intactes');
    assert.equal((await app.api('GET', '/api/plugins/shares-prefix-child/own')).body.tables.length, 1);
  });

  test('le routeur d’un plugin est mis en cache tant qu’il reste actif — et refait à chaque réactivation (ses handlers sont ceux du nouveau ctx)', async () => {
    const { routeurDe } = require('../src/app/routes/plugins'); // eslint-disable-line global-require
    const avant = routeurDe('shares-prefix-child');
    assert.ok(avant);
    assert.equal(routeurDe('shares-prefix-child'), avant, 'même routeur d’une requête à l’autre');
    await app.api('GET', '/api/plugins/shares-prefix-child/own');
    assert.equal(routeurDe('shares-prefix-child'), avant, 'et après une requête');
    await app.api('POST', '/api/plugins/shares-prefix-child/disable');
    assert.equal(routeurDe('shares-prefix-child'), null, 'inactif : pas de routeur');
    await app.api('POST', '/api/plugins/shares-prefix-child/enable');
    const apres = routeurDe('shares-prefix-child');
    assert.notEqual(apres, avant, 'réactivé : un routeur neuf, pas celui des handlers périmés');
    assert.equal((await app.api('GET', '/api/plugins/shares-prefix-child/own')).status, 200);
    await app.api('POST', '/api/plugins/shares-prefix-child/disable');
    await app.api('POST', '/api/plugins/shares-prefix-child/uninstall', { deleteData: true });
  });

  test('ctx.exec depuis un worker : sans shell, le message arrive intact, l’environnement demandé est transmis — et lui seul', async () => {
    process.env.RUNS_EXEC_SECRET = 'ne-doit-pas-fuiter';
    try {
      assert.equal((await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, 'runs-exec') })).status, 200);
      assert.equal((await app.api('POST', '/api/plugins/runs-exec/enable')).body.ok, true);
      const r = await app.api('GET', '/api/plugins/runs-exec/run');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.code, 0);
      assert.deepEqual(r.body.out.argv, ['--message=a; touch PWN | $(touch PWN2) `id` "q"'], 'un seul argument, métacaractères intacts');
      assert.equal(r.body.out.x, 'transmis', 'l’option env de ctx.exec traverse le worker');
      assert.equal(r.body.out.secret, null, 'l’environnement du serveur ne fuit pas vers le script');
      assert.ok(!fs.existsSync(path.join(process.cwd(), 'PWN')) && !fs.existsSync(path.join(process.cwd(), 'PWN2')), 'rien n’a été exécuté');
    } finally { delete process.env.RUNS_EXEC_SECRET; }
  });

  test('ctx.dataDir : un dossier privé HORS du code du plugin, dans le worker aussi, qui suit « supprimer aussi ses données »', async () => {
    const inst = await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, 'stores-files') });
    assert.equal(inst.status, 200, JSON.stringify(inst.body));
    assert.equal((await app.api('POST', '/api/plugins/stores-files/enable')).body.ok, true);
    const prive = path.join(app.dataDir, 'plugin-data', 'stores-files');
    const dir = (await app.api('GET', '/api/plugins/stores-files/dir')).body.dir;
    assert.equal(dir, prive, 'le dossier privé, pas le dossier du code (plugins/<nom>)');
    assert.notEqual(dir, path.join(app.dataDir, 'plugins', 'stores-files'));
    assert.equal(fs.readFileSync(path.join(prive, 'marque.txt'), 'utf8'), 'ici', 'écrit depuis le worker');
    await app.api('POST', '/api/plugins/stores-files/disable');
    assert.equal(fs.existsSync(prive), true, 'désactiver ne touche pas aux données');
    // Désinstaller en GARDANT les données : le code part, le dossier privé reste — c'est le choix de la personne.
    assert.equal((await app.api('POST', '/api/plugins/stores-files/uninstall', { deleteData: false })).status, 200);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'plugins', 'stores-files')), false);
    assert.equal(fs.existsSync(prive), true, 'données gardées');
    // Réinstaller (mise à jour du code) retrouve le profil ; désinstaller en SUPPRIMANT les données l'efface.
    await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, 'stores-files') });
    assert.equal((await app.api('POST', '/api/plugins/stores-files/uninstall', { deleteData: true })).status, 200);
    assert.equal(fs.existsSync(prive), false, 'données supprimées avec le plugin');
  });

  test('désinstaller : avec ou sans ses données ; un embarqué ne se désinstalle pas ; un nom invalide est refusé', async () => {
    await app.api('POST', '/api/plugins/hostile/disable');
    const u = await app.api('POST', '/api/plugins/hostile/uninstall', { deleteData: false });
    assert.deepEqual([u.status, u.body.dataKept], [200, true]);
    assert.equal(await de('hostile'), undefined);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'plugins', 'hostile')), false);
    assert.equal((await app.api('POST', '/api/plugins/Bad%20Name/enable')).status, 400);
    assert.equal((await app.api('POST', '/api/plugins/inconnu/enable')).status, 404);
    // Installer depuis un dossier : le manifeste est vérifié AVANT la copie.
    const inst = await app.api('POST', '/api/plugins/install', { path: path.join(FIXTURES, 'hostile') });
    assert.equal(inst.status, 200);
    assert.equal((await de('hostile')).enabled, false, 'installé désactivé');
    const mauvais = await app.api('POST', '/api/plugins/install', { path: __dirname });
    assert.equal(mauvais.status, 400);
    assert.match(mauvais.body.error, /plugin\.json absent/);
  });
});
