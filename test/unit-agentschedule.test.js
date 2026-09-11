'use strict';
/* LES HORAIRES D'AGENT.
 *
 * Un horaire fait partir un agent sans que personne soit là. Trois choses doivent être exactes,
 * et aucune ne se voit à l'écran :
 *   — la grammaire, qui refuse ce qu'elle ne sait pas faire plutôt que de l'interpréter ;
 *   — le CRÉNEAU, calculé sur le passé (« le rendez-vous de ce matin a-t-il été honoré ? »),
 *     ce qui fait qu'un serveur éteint à 7:00 rattrape son run à 9:00 au lieu de le perdre ;
 *   — le plafond quotidien, qui est la seule borne de ce qui peut se déclencher tout seul.
 * Le test manipule le TEMPS explicitement : attendre la minute serait un pari sur l'horloge. */

const { test, describe, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsched-'));
process.env.MERGERIE_DATA_DIR = tmp;
process.env.MERGERIE_CLAUDE_HOME = path.join(tmp, 'home');

// eslint-disable-next-line import/order
const db = require('../src/db');
// eslint-disable-next-line import/order
const agentschedule = require('../src/agentschedule');
// eslint-disable-next-line import/order
const agentprofile = require('../src/agentprofile');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

let repoId;
before(() => {
  repoId = db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/api','https://x/a.git',1,'gitlab')").run().lastInsertRowid;
});

describe('agentschedule : la grammaire', () => {
  test('les trois formes sont reconnues et rendues canoniques', () => {
    assert.deepEqual(agentschedule.parse('daily 07:00'), { kind: 'daily', hh: 7, mm: 0 });
    assert.deepEqual(agentschedule.parse('weekly mon 09:30'), { kind: 'weekly', dow: 1, hh: 9, mm: 30 });
    assert.deepEqual(agentschedule.parse('monthly 15 23:59'), { kind: 'monthly', dom: 15, hh: 23, mm: 59 });
    assert.equal(agentschedule.canonique(agentschedule.parse('DAILY 7:05')), 'daily 07:05');
    assert.equal(agentschedule.canonique(agentschedule.parse('weekly SUN 08:00')), 'weekly sun 08:00');
  });

  test('ce qui n’est pas de cette grammaire est REFUSÉ, pas interprété', () => {
    for (const mauvais of ['', '* * * * *', 'daily 25:00', 'daily 07:60', 'weekly funday 07:00',
      'monthly 0 07:00', 'monthly 29 07:00', 'hourly 07:00', 'daily', 'daily 7']) {
      assert.equal(agentschedule.parse(mauvais), null, mauvais);
    }
  });

  test('le mensuel s’arrête à 28 — un « monthly 31 » sauterait février', () => {
    // Un horaire qui saute un mois sur deux sans rien dire est pire que pas d'horaire.
    assert.ok(agentschedule.parse('monthly 28 07:00'));
    assert.equal(agentschedule.parse('monthly 31 07:00'), null);
  });

  test('la phrase affichée est traduite, jamais la forme brute', () => {
    assert.match(agentschedule.phrase('daily 07:00'), /07:00/);
    assert.match(agentschedule.phrase('weekly mon 07:00'), /lundi|Monday/);
    assert.equal(agentschedule.phrase('n’importe quoi'), '');
  });
});

describe('agentschedule : le dernier créneau', () => {
  const creneau = (spec, iso) => agentschedule.prochainCreneau(agentschedule.parse(spec), new Date(iso));

  test('quotidien : celui d’aujourd’hui s’il est passé, celui d’hier sinon', () => {
    assert.equal(creneau('daily 07:00', '2026-03-10T09:00:00').toISOString().slice(0, 16),
      new Date('2026-03-10T07:00:00').toISOString().slice(0, 16));
    assert.equal(creneau('daily 07:00', '2026-03-10T06:59:00').toISOString().slice(0, 10),
      new Date('2026-03-09T07:00:00').toISOString().slice(0, 10));
  });

  test('juste après minuit, le créneau du soir est celui de la VEILLE', () => {
    // Sinon un agent programmé à 23:00 repartirait à 00:05 : deux runs dans la nuit.
    const c = creneau('daily 23:00', '2026-03-10T00:05:00');
    assert.equal(c.getDate(), 9);
    assert.equal(c.getHours(), 23);
  });

  test('hebdomadaire : le dernier jour dit, jamais un autre', () => {
    // Le 10 mars 2026 est un mardi.
    const c = creneau('weekly mon 07:00', '2026-03-10T12:00:00');
    assert.equal(c.getDay(), 1, 'un lundi');
    assert.equal(c.getDate(), 9);
  });

  test('mensuel : recule au mois précédent quand le jour n’est pas encore venu', () => {
    const c = creneau('monthly 20 07:00', '2026-03-10T12:00:00');
    assert.equal(c.getMonth(), 1, 'février');
    assert.equal(c.getDate(), 20);
    const c2 = creneau('monthly 5 07:00', '2026-03-10T12:00:00');
    assert.equal(c2.getMonth(), 2, 'mars');
  });

  test('un changement d’ANNÉE ne casse pas le recul mensuel', () => {
    const c = creneau('monthly 20 07:00', '2026-01-10T12:00:00');
    assert.equal(c.getFullYear(), 2025);
    assert.equal(c.getMonth(), 11, 'décembre');
  });
});

describe('agentschedule : qui est dû', () => {
  let a;
  before(() => {
    a = agentprofile.creer({
      name: 'Planifié', kind: 'explore', scope_kind: 'repos', prompt_template: '{question}',
      max_turns: 40, schedule: 'daily 07:00', repos: [{ repo_id: repoId, role: 'readonly' }],
    });
  });

  const maintenant = new Date('2026-03-10T09:00:00');

  test('jamais tiré : il est dû', () => {
    db.prepare('UPDATE agent SET schedule_fired_at = NULL WHERE id = ?').run(a.id);
    const dus = agentschedule.dus(maintenant);
    assert.equal(dus.length, 1);
    assert.equal(dus[0].agent.id, a.id);
  });

  test('tiré AVANT le créneau : toujours dû', () => {
    db.prepare('UPDATE agent SET schedule_fired_at = ? WHERE id = ?')
      .run(new Date('2026-03-09T07:00:00').toISOString(), a.id);
    assert.equal(agentschedule.dus(maintenant).length, 1);
  });

  test('tiré APRÈS le créneau : plus dû — un tick par minute n’en fait pas soixante runs', () => {
    db.prepare('UPDATE agent SET schedule_fired_at = ? WHERE id = ?')
      .run(new Date('2026-03-10T07:00:00').toISOString(), a.id);
    assert.equal(agentschedule.dus(maintenant).length, 0);
  });

  test('un horaire SANS borne de tours n’est jamais dû', () => {
    // La sauvegarde le refuse ; une base héritée pourrait en porter un.
    db.prepare('UPDATE agent SET schedule_fired_at = NULL, max_turns = NULL WHERE id = ?').run(a.id);
    assert.equal(agentschedule.dus(maintenant).length, 0);
    db.prepare('UPDATE agent SET max_turns = 40 WHERE id = ?').run(a.id);
  });

  test('un horaire illisible n’est jamais dû non plus', () => {
    db.prepare("UPDATE agent SET schedule = 'toutes les lunes', schedule_fired_at = NULL WHERE id = ?").run(a.id);
    assert.equal(agentschedule.dus(maintenant).length, 0);
    db.prepare("UPDATE agent SET schedule = 'daily 07:00' WHERE id = ?").run(a.id);
  });
});

describe('agentschedule : le tick et son plafond', () => {
  const maintenant = new Date('2026-03-10T09:00:00');
  let a;
  before(() => {
    db.prepare('DELETE FROM task').run();
    db.prepare("UPDATE config SET agent_auto_max = 2 WHERE id = 1").run();
    a = db.prepare("SELECT * FROM agent WHERE name = 'Planifié'").get();
    db.prepare('UPDATE agent SET schedule_fired_at = NULL WHERE id = ?').run(a.id);
  });

  test('un tick lance l’agent dû, et le second n’en relance pas un autre', () => {
    const journal = [];
    const lances = agentschedule.tick(maintenant, (m) => journal.push(m));
    assert.equal(lances.length, 1);
    const runs = db.prepare("SELECT * FROM task WHERE triggered_by = 'schedule'").all();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].agent_id, a.id);
    assert.equal(runs[0].auto_push, 0, 'un agent ne pousse jamais de lui-même');
    // Le second tick, à la même minute : rien de plus.
    agentschedule.tick(maintenant, () => {});
    assert.equal(db.prepare("SELECT COUNT(*) n FROM task WHERE triggered_by = 'schedule'").get().n, 1);
  });

  test('le plafond atteint saute le run, l’écrit au journal, et n’essaie pas soixante fois', () => {
    // Sans l'écriture de l'heure de tir, l'agent serait « dû » à chaque minute jusqu'à minuit.
    db.prepare("UPDATE config SET agent_auto_max = 1 WHERE id = 1").run();
    db.prepare('UPDATE agent SET schedule_fired_at = NULL WHERE id = ?').run(a.id);
    const journal = [];
    const lances = agentschedule.tick(maintenant, (m) => journal.push(m));
    assert.equal(lances.length, 0);
    assert.ok(journal.some((l) => /1/.test(l) && /Planifié/.test(l)), journal.join(' | '));
    assert.ok(db.prepare('SELECT schedule_fired_at s FROM agent WHERE id = ?').get(a.id).s,
      'l’heure de tir est écrite quand même : sinon on réessaie chaque minute');
  });

  test('un plafond à 0 signifie « sans limite »', () => {
    db.prepare("UPDATE config SET agent_auto_max = 0 WHERE id = 1").run();
    db.prepare('UPDATE agent SET schedule_fired_at = NULL WHERE id = ?').run(a.id);
    assert.equal(agentschedule.tick(maintenant, () => {}).length, 1);
  });

  test('le compteur du jour ne compte que les runs déclenchés par un HORAIRE', () => {
    const avant = agentschedule.lancesAujourdhui(new Date());
    db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, status, triggered_by, created_at, updated_at)
      VALUES (?, 'explore', 'à la main', '', NULL, 'new', 'manual', ?, ?)`)
      .run(1, new Date().toISOString(), new Date().toISOString());
    assert.equal(agentschedule.lancesAujourdhui(new Date()), avant, 'un run manuel ne compte pas');
  });
});
