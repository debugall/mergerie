'use strict';
/* Vérification objective — logique pure (plan_add_verify.md §14).
 *
 * Ce qui est testé ici décide de ce que l'utilisateur croit : un verdict vert à tort vaut
 * pire que pas de verdict du tout. D'où l'insistance sur les cas dégradés — sortie illisible,
 * réponse énorme, base déjà rouge — plutôt que sur le chemin nominal.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-verif-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/verify');

const run = (status, failed = [], extra = {}) => ({ version: 1, status, failed, ...extra });
const sortie = (obj, avant = '') => `${avant}${JSON.stringify(obj)}\n`;

describe('verify : contrat du script', () => {
  test('la réponse est la DERNIÈRE ligne JSON, le bruit avant est ignoré', () => {
    const brut = ['> jest', 'PASS src/a.test.js', '{"pas":"un verdict"}',
      JSON.stringify(run('pass', [], { total: 218, duration_ms: 42000 }))].join('\n');
    const r = v.validerReponse(brut);
    assert.equal(r.ok, true);
    assert.equal(r.run.status, 'pass');
    assert.equal(r.run.total, 218);
    assert.equal(r.run.duration_ms, 42000);
  });

  test('une sortie sans JSON ne conclut PAS : on refuse, on n’invente pas', () => {
    for (const brut of ['', 'tout va bien', 'FAIL 3 tests', '{cassé']) {
      const r = v.validerReponse(brut);
      assert.equal(r.ok, false, JSON.stringify(brut));
      assert.match(r.erreur, /JSON/);
    }
  });

  test('version et status hors contrat sont refusés, avec la valeur reçue dans le message', () => {
    assert.match(v.validerReponse(sortie({ version: 2, status: 'pass' })).erreur, /version attendue 1.*2/);
    assert.match(v.validerReponse(sortie(run('vert'))).erreur, /pass\|fail\|error.*"vert"/);
    assert.match(v.validerReponse(sortie({ version: 1, status: 'fail', failed: 'trois' })).erreur, /liste/);
  });

  test('une réponse énorme est refusée avant d’être analysée', () => {
    const r = v.validerReponse(`${'x'.repeat(v.MAX_REPONSE + 1)}\n`);
    assert.equal(r.ok, false);
    assert.match(r.erreur, /volumineuse/);
  });

  test('le nombre d’échecs est borné, et le fait de tronquer est signalé', () => {
    const trop = Array.from({ length: 80 }, (_, i) => ({ test: `t${i}`, message: 'm' }));
    const r = v.validerReponse(sortie(run('fail', trop)));
    assert.equal(r.run.failed.length, v.MAX_FAILED);
    assert.equal(r.run.failed_tronque, true, 'l’utilisateur doit savoir qu’il ne voit pas tout');
  });

  test('un extrait de log démesuré est coupé, pas refusé', () => {
    const r = v.validerReponse(sortie(run('fail', [{ test: 'a', log_excerpt: 'x'.repeat(9000) }])));
    assert.equal(r.ok, true);
    assert.ok(r.run.failed[0].log_excerpt.length <= 4 * 1024 + 1);
    assert.equal(r.run.failed_tronque, false, 'un seul échec : rien n’a été omis de la liste');
  });

  test('un échec sans nom de test est écarté : il ne pourrait pas être imputé', () => {
    const r = v.validerReponse(sortie(run('fail', [{ message: 'sans nom' }, { test: 'ok', message: 'm' }])));
    assert.deepEqual(r.run.failed.map((f) => f.test), ['ok']);
  });

  test('« fail » sans détail est accepté : un rouge sans liste vaut mieux qu’un refus', () => {
    const r = v.validerReponse(sortie({ version: 1, status: 'fail' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.run.failed, []);
  });
});

describe('verify : composition du verdict', () => {
  const t = (base, head) => v.composerVerdict(base, head).verdict;

  test('les six lignes du tableau des verdicts', () => {
    assert.equal(t(run('pass'), run('pass')), 'verified_pass');
    assert.equal(t(run('pass'), run('fail', [{ test: 'a' }])), 'verified_fail');
    assert.equal(t(run('fail', [{ test: 'a' }]), run('pass')), 'broken_base');
    // base rouge ET tête rouge : tout dépend de savoir si la tête a cassé QUELQUE CHOSE DE PLUS.
    assert.equal(t(run('fail', [{ test: 'a' }]), run('fail', [{ test: 'a' }])), 'broken_base');
    assert.equal(t(run('fail', [{ test: 'a' }]), run('fail', [{ test: 'a' }, { test: 'b' }])), 'verified_fail');
    assert.equal(t(null, run('pass')), 'verified_pass');
    assert.equal(t(null, run('fail', [{ test: 'a' }])), 'verified_fail');
  });

  test('sans run base, le verdict est signalé NON causal', () => {
    assert.equal(v.composerVerdict(null, run('fail', [{ test: 'a' }])).causal, false,
      'on sait que la branche est rouge, pas qu’elle l’a rendue rouge');
    assert.equal(v.composerVerdict(run('pass'), run('pass')).causal, true);
  });

  test('une erreur d’un côté ou de l’autre ne conclut jamais au vert', () => {
    assert.equal(t(run('pass'), run('error')), 'verify_error');
    assert.equal(t(run('error'), run('pass')), 'verify_error');
    assert.equal(t(run('pass'), null), 'verify_error');
  });

  test('l’imputable est le delta, pas la liste entière', () => {
    const base = run('fail', [{ test: 'a' }, { test: 'b' }]);
    const head = run('fail', [{ test: 'a' }, { test: 'c' }]);
    assert.deepEqual(v.deltaImputable(base, head).map((f) => f.test), ['c']);
    assert.deepEqual(v.composerVerdict(base, head).imputable.map((f) => f.test), ['c']);
    // Base verte : tout ce qui est rouge est imputable à la branche.
    assert.deepEqual(v.composerVerdict(run('pass'), head).imputable.map((f) => f.test), ['a', 'c']);
  });
});

describe('verify : péremption et cache', () => {
  const cibles = [{ mr_id: 1, head_sha: 'aaa' }, { mr_id: 2, head_sha: 'bbb' }];

  test('un verdict se périme dès qu’UNE des branches a avancé', () => {
    assert.equal(v.estPerime(cibles, { 1: 'aaa', 2: 'bbb' }), false);
    assert.equal(v.estPerime(cibles, { 1: 'aaa', 2: 'ccc' }), true);
    // SHA courant inconnu : on ne périme pas sur une absence d'information.
    assert.equal(v.estPerime(cibles, { 1: 'aaa' }), false);
  });

  test('l’empreinte d’un run ne dépend pas de l’ordre des dépôts', () => {
    const jeu = [{ repo_id: 1, sha: 'x' }, { repo_id: 2, sha: 'y' }];
    const V = { id: 3, command: '/bin/integ', timeout_s: 900 };
    const a = v.hashRunSet(V, jeu);
    assert.equal(a, v.hashRunSet(V, [...jeu].reverse()), 'sinon le cache raterait un run pourtant identique');
    assert.notEqual(a, v.hashRunSet(V, [{ repo_id: 1, sha: 'x' }, { repo_id: 2, sha: 'z' }]));
    assert.notEqual(a, v.hashRunSet({ ...V, id: 4 }, jeu),
      'deux vérificateurs différents ne partagent pas un résultat');
    /* Les deux pièges du cache, et ils rendent tous deux un verdict FAUX en silence :
       un identifiant recyclé après suppression, et une commande modifiée sous le même id. */
    assert.notEqual(a, v.hashRunSet({ ...V, command: '/bin/integ-v2' }, jeu),
      'changer la commande doit invalider le résultat mis en cache');
    assert.notEqual(a, v.hashRunSet({ ...V, timeout_s: 60 }, jeu),
      'un timeout plus court peut changer l’issue du run');
  });
});

describe('verify : identité d’un dépôt (garde-fou du mode in place)', () => {
  test('SSH et HTTPS désignent le même dépôt', () => {
    assert.ok(v.memeDepot('git@gitlab.com:grp/app.git', 'https://gitlab.com/grp/app'));
    assert.ok(v.memeDepot('https://user@gitlab.com/grp/app.git', 'git@gitlab.com:grp/app'));
    assert.ok(v.memeDepot('ssh://git@gitlab.com/grp/app.git', 'https://gitlab.com/grp/app/'));
  });

  test('deux dépôts distincts ne sont jamais confondus', () => {
    assert.ok(!v.memeDepot('git@gitlab.com:grp/app.git', 'git@gitlab.com:grp/autre.git'));
    assert.ok(!v.memeDepot('git@gitlab.com:grp/app.git', 'git@github.com:grp/app.git'));
    // Une URL vide ne « correspond » à rien : sans ça, un remote absent autoriserait le checkout.
    assert.ok(!v.memeDepot('', ''));
    assert.ok(!v.memeDepot('', 'git@gitlab.com:grp/app.git'));
  });
});
