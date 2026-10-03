'use strict';
/* TEAMS NOTIFY INSTALLÉ COMME UN TIERS : copié dans `<dataDir>/plugins/`, il se charge dans un WORKER, désactivé
 * d'office — et doit faire la même chose : recevoir un événement, lancer le script par `ctx.exec` (RPC), écrire son
 * profil dans `ctx.dataDir`, répondre sur ses routes. C'est l'épreuve de `exec` et de `storage` à travers la
 * frontière du worker, que le plugin embarqué ne passe jamais. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-sans-embarques-teams-'));
process.env.MERGERIE_BUILTIN_PLUGINS_DIR = VIDE;

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { copierAvecFaux, attendre, LIEN, SUCCES } = require('../plugins/jenkins-teams-notify/test/helpers');

describe('Jenkins Teams Notify installé comme un tiers — dans un worker', () => {
  let app; let faux; let events;
  before(async () => {
    app = await startApp();
    faux = copierAvecFaux();
    fs.cpSync(faux.dir, path.join(app.dataDir, 'plugins', 'jenkins-teams-notify'), { recursive: true });
    // Le faux observé est celui de la copie CHARGÉE par le serveur.
    const charge = path.join(app.dataDir, 'plugins', 'jenkins-teams-notify');
    const lire = (nom) => { try { return fs.readFileSync(path.join(charge, 'bin', nom), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    faux = { dir: charge, appels: () => lire('calls.jsonl'), mode: (m) => fs.writeFileSync(path.join(charge, 'bin', 'mode.json'), JSON.stringify(m)) };
    faux.mode({ code: 0 });
    events = require('../src/core/events'); // eslint-disable-line global-require
  });
  after(async () => {
    if (app) await app.stop();
    fs.rmSync(VIDE, { recursive: true, force: true });
    delete process.env.MERGERIE_BUILTIN_PLUGINS_DIR;
  });

  test('découvert désactivé, activé dans un worker', async () => {
    const r = await app.api('POST', '/api/plugins/rescan');
    const f = r.body.plugins.find((p) => p.name === 'jenkins-teams-notify');
    assert.deepEqual([f.builtin, f.origin, f.enabled, f.state], [false, 'user', false, 'inactive']);
    const on = await app.api('POST', '/api/plugins/jenkins-teams-notify/enable');
    assert.equal(on.body.ok, true, on.body.error || '');
  });

  test('un événement Jenkins du cœur → le worker lance le script par ctx.exec, avec le profil dans le dossier privé', async () => {
    assert.equal((await app.api('PUT', '/api/plugins/jenkins-teams-notify/settings', { team_link: LIEN })).status, 200);
    await events.emit('jenkins.job.finished', SUCCES);
    await attendre(() => faux.appels().length === 1, 'le script a été lancé depuis le worker');
    const argv = faux.appels()[0].argv;
    assert.match(argv.find((a) => a.startsWith('--message=')), /boutique\/deploy #12 réussi en 1 min 23 s/);
    assert.equal(argv.find((a) => a.startsWith('--profile-dir=')).slice(14), path.join(app.dataDir, 'plugin-data', 'jenkins-teams-notify', 'profile'));
    await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/log')).body.rows.length === 1, 'une ligne au journal');
    assert.equal((await app.api('GET', '/api/plugins/jenkins-teams-notify/log')).body.rows[0].status, 'ok');
  });

  test('code 2 depuis le worker : « connexion requise » persiste, et le script n’est plus rappelé', async () => {
    faux.mode({ code: 2 });
    await events.emit('jenkins.job.started', { path: 'a/b', since: 1, parameters: {}, url: 'u', startedBy: 's' });
    await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body.state === 'connexion-requise', 'état posé');
    assert.equal(faux.appels().length, 2);
    await events.emit('jenkins.job.finished', SUCCES);
    await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/log')).body.rows.some((r) => r.status === 'ignoree'), 'ignoré');
    assert.equal(faux.appels().length, 2, 'pas de nouvel appel');
    assert.equal(app.db.prepare("SELECT value FROM plugin_setting WHERE plugin = 'jenkins-teams-notify' AND key = 'session_state'").get().value, '"connexion-requise"', 'l’état survit : un redémarrage le retrouverait');
  });

  test('le test manuel depuis le worker rétablit les envois', async () => {
    faux.mode({ code: 0 });
    assert.equal((await app.api('POST', '/api/plugins/jenkins-teams-notify/test')).body.accepted, true);
    await attendre(async () => (await app.api('GET', '/api/plugins/jenkins-teams-notify/status')).body.state === 'ok', 'session ok');
  });
});
