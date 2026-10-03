'use strict';
/* LE BUS D'ÉVÉNEMENTS : la file, le délai, l'isolation des erreurs, la version du payload.
 *
 * Ce qu'on prouve : un handler qui lève ou qui ne répond jamais n'empêche ni l'émetteur de
 * continuer ni les autres abonnés d'être appelés ; les handlers tournent l'un après l'autre,
 * dans l'ordre ; le payload qui circule est un objet simple, qui porte sa version. Sans ça, un
 * plugin tiers en panne ferait tomber une session de codage. */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const events = require('../src/core/events');

describe('Bus d’événements', () => {
  beforeEach(() => { events.reset(); events.configurer({ log: () => {} }); });

  test('les handlers tournent en file, dans l’ordre d’abonnement', async () => {
    const trace = [];
    events.on('x.y', async () => { trace.push('a1'); await new Promise((r) => setTimeout(r, 20)); trace.push('a2'); }, { proprietaire: 'a' });
    events.on('x.y', () => { trace.push('b'); }, { proprietaire: 'b' });
    const r = await events.emit('x.y', { n: 1 });
    assert.deepEqual(trace, ['a1', 'a2', 'b'], 'b ne part qu’une fois a terminé');
    assert.equal(r.delivered, 2);
    assert.deepEqual(r.errors, []);
  });

  test('un handler qui lève est journalisé et n’affecte ni l’émetteur ni les autres', async () => {
    const journal = [];
    events.configurer({ log: (m) => journal.push(m) });
    let vu = 0;
    events.on('session.finished', () => { throw new Error('boum'); }, { proprietaire: 'plugin-casse' });
    events.on('session.finished', () => { vu += 1; }, { proprietaire: 'plugin-sain' });
    const r = await events.emit('session.finished', { kind: 'task', id: 1, action: 'run', status: 'done' });
    assert.equal(vu, 1);
    assert.deepEqual(r.errors, [{ owner: 'plugin-casse', error: 'boum' }]);
    assert.match(journal[0], /session\.finished → plugin-casse : boum/);
  });

  test('un handler qui ne répond pas est abandonné après le délai', async () => {
    events.configurer({ delai: 50 });
    events.on('lent', () => new Promise(() => {}), { proprietaire: 'bloque' });
    let apres = false;
    events.on('lent', () => { apres = true; }, { proprietaire: 'suivant' });
    const debut = Date.now();
    const r = await events.emit('lent');
    assert.ok(Date.now() - debut < 2000, 'on n’attend pas indéfiniment');
    assert.equal(apres, true, 'le suivant est quand même appelé');
    assert.match(r.errors[0].error, /délai de 50 ms/);
  });

  test('le payload porte sa version et ne transporte rien d’opaque', async () => {
    let recu;
    events.on('verify.finished', (p) => { recu = p; });
    const fn = () => {};
    const r = await events.emit('verify.finished', { verification_id: 3, verdict: 'verified_pass', fn, nested: { d: new Date(0) } });
    assert.equal(recu.version, 1, 'la version du contrat');
    assert.equal(recu.verification_id, 3);
    assert.equal('fn' in recu, false, 'une fonction ne traverse pas');
    assert.equal(typeof recu.nested.d, 'string', 'une date devient une chaîne : ce qui passe par JSON, rien d’autre');
    assert.deepEqual(r.payload, recu);
    const inconnu = await events.emit('tiers.quelconque', { a: 1 });
    assert.equal(inconnu.payload.version, 1, 'un événement hors contrat part en version 1');
  });

  test('offAll retire tous les abonnements d’un propriétaire — la désactivation d’un plugin', async () => {
    let n = 0;
    events.on('a', () => { n += 1; }, { proprietaire: 'p' });
    events.on('b', () => { n += 1; }, { proprietaire: 'p' });
    events.on('a', () => { n += 10; }, { proprietaire: 'q' });
    assert.deepEqual(events.ecoutesPar('p'), ['a', 'b']);
    assert.equal(events.offAll('p'), 2);
    await events.emit('a'); await events.emit('b');
    assert.equal(n, 10, 'seul q reste');
    assert.deepEqual(events.listeners('a'), ['q']);
  });

  test('on() rend la fonction de désabonnement, et refuse un abonnement sans handler', async () => {
    let n = 0;
    const off = events.on('c', () => { n += 1; });
    await events.emit('c');
    off();
    await events.emit('c');
    assert.equal(n, 1);
    assert.throws(() => events.on('c', null), /handler requis/);
    assert.throws(() => events.on('', () => {}), /nom d’événement requis/);
  });

  test('chaque événement du contrat porte une version entière et un payload décrit', () => {
    for (const [nom, e] of Object.entries(events.EVENTS)) {
      assert.ok(Number.isInteger(e.version) && e.version >= 1, `${nom} : version`);
      assert.equal(typeof e.payload, 'object', `${nom} : payload`);
      assert.ok(e.when && e.source, `${nom} : when + source`);
    }
  });
});
