'use strict';
/* L'HORAIRE À PLUSIEURS JOURS (`weekly mon,thu 07:00`) — ajouté pour les sessions récurrentes, lu
 * aussi par les agents. Ce qui doit tenir : la forme canonique (lundi d'abord, sans doublon),
 * le refus de ce qu'on ne sait pas lire, le dernier créneau PASSÉ (rattrapage) et le prochain
 * À VENIR (l'écran) sur une semaine à trous, et la phrase — « du lundi au vendredi ».
 * Le temps est passé explicitement : attendre un jeudi serait un pari sur le calendrier. */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'horaire-jours-'));
process.env.MERGERIE_DATA_DIR = tmp;
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// eslint-disable-next-line import/order
const horaire = require('../src/agent/horaire');

// Vendredi 20 novembre 2026, midi, heure locale.
const VENDREDI = new Date(2026, 10, 20, 12, 0, 0);

describe('Horaire hebdomadaire à plusieurs jours', () => {
  test('la forme canonique range les jours du lundi au dimanche, sans doublon', () => {
    assert.equal(horaire.canonique(horaire.parse('weekly thu,mon,thu 7:00')), 'weekly mon,thu 07:00');
    assert.equal(horaire.canonique(horaire.parse('weekly sun,sat 22:30')), 'weekly sat,sun 22:30');
    assert.equal(horaire.canonique(horaire.parse('weekly mon 07:00')), 'weekly mon 07:00', 'un seul jour : la forme d’avant');
  });

  test('ce qu’on ne sait pas lire est refusé, pas interprété', () => {
    for (const faux of ['weekly 07:00', 'weekly mon,,thu 07:00', 'weekly lun 07:00', 'weekly mon,thu 25:00', 'weekly mon thu 07:00']) {
      assert.equal(horaire.parse(faux), null, faux);
    }
  });

  test('le dernier créneau passé et le prochain à venir sautent les jours non cochés', () => {
    const s = horaire.parse('weekly mon,thu 07:00');
    assert.deepEqual(horaire.prochainCreneau(s, VENDREDI), new Date(2026, 10, 19, 7, 0, 0), 'jeudi matin, pas vendredi');
    assert.deepEqual(horaire.creneauSuivant(s, VENDREDI), new Date(2026, 10, 23, 7, 0, 0), 'lundi prochain');
    // Le jour même, avant l'heure : le créneau d'avant est jeudi ; après l'heure, c'est aujourd'hui.
    const jeudiTot = new Date(2026, 10, 19, 6, 0, 0);
    assert.deepEqual(horaire.prochainCreneau(s, jeudiTot), new Date(2026, 10, 16, 7, 0, 0));
    assert.deepEqual(horaire.creneauSuivant(s, jeudiTot), new Date(2026, 10, 19, 7, 0, 0));
  });

  test('la phrase : les jours nommés, et « du lundi au vendredi » pour les jours ouvrés', () => {
    assert.equal(horaire.phrase('weekly mon,thu 07:00'), 'chaque lundi et jeudi à 07:00');
    assert.equal(horaire.phrase('weekly mon,wed,fri 09:15'), 'chaque lundi, mercredi et vendredi à 09:15');
    assert.equal(horaire.phrase('weekly fri,thu,wed,tue,mon 07:00'), 'du lundi au vendredi à 07:00');
    assert.equal(horaire.phrase('weekly mon 07:00'), 'chaque lundi à 07:00');
  });
});
