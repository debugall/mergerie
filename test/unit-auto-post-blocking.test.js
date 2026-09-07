'use strict';
/* LA RÈGLE QUI DÉCIDE SI LE RAPPORT PART CHEZ LES AUTRES.
 *
 * `publicationAutoRequise` est la seule porte de la publication automatique : elle est courte,
 * elle est isolée, et ce qu'elle laisse passer est lu par des collègues sur leur merge request.
 * Les tests de bout en bout (`e2e-review-publish`) prouvent le câblage — le réglage sauvegardé,
 * la review qui publie ou non, la trace en base. Ils ne peuvent pas tout couvrir : en dry-run,
 * le PREMIER constat d'une passe est toujours un « blocker », si bien qu'un rapport portant des
 * constats mais AUCUN bloquant — le cas qui motive tout le réglage — y est inatteignable.
 * Il se teste ici, table de vérité en main.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* `src/reviewer` tire `src/db` avec lui, qui OUVRE une base dès le chargement : sans ce dossier
   posé AVANT le require, le test écrirait dans la base réelle de l'utilisateur. */
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-post-'));
const { publicationAutoRequise } = require('../src/reviewer');

const f = (severity) => ({ severity, file: 'src/a.js', line: 1, title: 'x' });

describe('Publication automatique : la règle', () => {
  test('publication automatique éteinte : rien ne part, filtre ou pas', () => {
    for (const filtre of ['0', '1']) {
      assert.equal(publicationAutoRequise({ auto_post_review: '0', auto_post_blocking_only: filtre }, [f('blocker')]), false);
    }
    // Réglage absent (base tout juste migrée, config partielle) = éteint.
    assert.equal(publicationAutoRequise({}, [f('blocker')]), false);
  });

  test('sans le filtre, tout rapport part — y compris un rapport sans le moindre constat', () => {
    const cfg = { auto_post_review: '1', auto_post_blocking_only: '0' };
    assert.equal(publicationAutoRequise(cfg, [f('blocker')]), true);
    assert.equal(publicationAutoRequise(cfg, [f('info')]), true);
    assert.equal(publicationAutoRequise(cfg, []), true);
    // Filtre absent (base migrée, jamais enregistré) : comportement d'avant le réglage.
    assert.equal(publicationAutoRequise({ auto_post_review: '1' }, [f('minor')]), true);
  });

  test('avec le filtre, seul un constat « blocker » ouvre la porte', () => {
    const cfg = { auto_post_review: '1', auto_post_blocking_only: '1' };
    assert.equal(publicationAutoRequise(cfg, [f('blocker')]), true);
    assert.equal(publicationAutoRequise(cfg, [f('minor'), f('info'), f('blocker')]), true,
      'un seul bloquant suffit, où qu’il soit dans la liste');
  });

  test('avec le filtre, un rapport chargé mais sans bloquant ne part pas', () => {
    const cfg = { auto_post_review: '1', auto_post_blocking_only: '1' };
    /* LE CAS QUI JUSTIFIE LE RÉGLAGE : douze remarques, aucune qui empêche de merger.
       « major » n'est pas « blocker » — c'est tout l'intérêt d'avoir quatre sévérités. */
    assert.equal(publicationAutoRequise(cfg, [f('major'), f('major'), f('minor'), f('info')]), false);
    assert.equal(publicationAutoRequise(cfg, [f('major')]), false);
    assert.equal(publicationAutoRequise(cfg, [f('info')]), false);
  });

  test('aucun constat n’est pas un constat bloquant', () => {
    const cfg = { auto_post_review: '1', auto_post_blocking_only: '1' };
    assert.equal(publicationAutoRequise(cfg, []), false);
    /* Une passe dont le bloc de constats manque arrive au même endroit qu'une passe propre :
       on ne dérange personne sur la foi d'un rapport qu'on n'a pas su lire. Le journal du job
       le dit — « 0 constat » se distingue à l'œil de « rien de bloquant ». */
    assert.equal(publicationAutoRequise(cfg, null), false);
    assert.equal(publicationAutoRequise(cfg, undefined), false);
  });

  test('une sévérité inconnue ne vaut pas « bloquant »', () => {
    const cfg = { auto_post_review: '1', auto_post_blocking_only: '1' };
    // Le doute profite au silence, comme pour le réglage lui-même.
    assert.equal(publicationAutoRequise(cfg, [f('BLOCKER'), f('critique'), f(null), {}]), false);
  });
});
