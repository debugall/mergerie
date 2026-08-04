'use strict';
/* Sorties RÉELLES des frameworks de test répandus.
 *
 * Reconnaître un format sur un exemple qu'on a écrit soi-même ne prouve rien : chaque outil a
 * ses libertés — mocha n'écrit pas de bloc YAML, vitest annote ses lignes de `# time=…` et les
 * ferme par une accolade, PHPUnit met tout dans le texte de `<failure>` là où Surefire le met
 * dans un attribut, pytest indente son contexte. Ce fichier fige ces différences.
 *
 * Les extraits ci-dessous reprennent la forme produite par chaque outil, jusqu'aux détails qui
 * ont cassé l'analyseur pendant l'écriture : entités XML dans les messages, guillemets simples,
 * `classname` identique au `name`, tests sautés.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/verify');

/* ------------------------------------------------------------------ TAP */

describe('formats : TAP tel que l’écrivent les runners', () => {
  test('node --test — sous-tests imbriqués, bloc YAML, plan de premier niveau', () => {
    const sortie = [
      'TAP version 13',
      '# Subtest: panier',
      '    # Subtest: calcule le total',
      '    ok 1 - calcule le total',
      '    # Subtest: applique la remise',
      '    not ok 2 - applique la remise',
      '      ---',
      "      location: '/app/test/panier.test.js:14:3'",
      '      failureType: \'testCodeFailure\'',
      '      error: |-',
      '        Expected values to be strictly equal:',
      '        41 !== 42',
      '      code: \'ERR_ASSERTION\'',
      '      ...',
      '    1..2',
      'not ok 1 - panier',
      '1..1',
      '# tests 2',
      '# fail 1',
    ].join('\n');

    const r = v.parserTap(sortie);
    assert.deepEqual(r.tests.map((t) => t.test), ['panier › applique la remise'],
      'la suite parente résume son sous-test : la compter la doublerait');
    assert.match(r.tests[0].message, /Expected values to be strictly equal/);
    assert.equal(r.total, 2);
    assert.equal(r.complet, true, 'le plan de premier niveau confirme qu’on a tout lu');
  });

  test('mocha --reporter tap — pas de « - », pas de bloc YAML, détail simplement indenté', () => {
    const sortie = [
      '1..3',
      'ok 1 panier calcule le total',
      'not ok 2 panier applique la remise',
      '  AssertionError: expected 41 to equal 42',
      '      at Context.<anonymous> (test/panier.js:12:34)',
      '      at processImmediate (node:internal/timers:478:21)',
      'ok 3 panier gère le vide # SKIP pas encore écrit',
      '# tests 3',
      '# pass 2',
      '# fail 1',
    ].join('\n');

    const r = v.parserTap(sortie);
    assert.deepEqual(r.tests.map((t) => t.test), ['panier applique la remise'],
      'le séparateur « - » est optionnel : mocha ne l’écrit pas');
    assert.match(r.tests[0].message, /expected 41 to equal 42/,
      'sans bloc YAML, les lignes indentées font le détail');
    assert.match(r.tests[0].log_excerpt, /test\/panier\.js:12:34/);
    assert.equal(r.total, 2, 'le test sauté ne compte pas comme exécuté');
  });

  test('vitest --reporter=tap — annotations « # time= » et accolades de bloc', () => {
    const sortie = [
      'TAP version 13',
      '1..1',
      'not ok 1 - panier.test.ts # time=48.21ms {',
      '    1..2',
      '    ok 1 - calcule le total # time=1.02ms',
      '    not ok 2 - applique la remise # time=3.44ms',
      '        ---',
      '        error:',
      '            name: "AssertionError"',
      '            message: "expected 41 to be 42"',
      '        ...',
      '}',
    ].join('\n');

    const r = v.parserTap(sortie);
    /* Le nom ne doit contenir NI la durée NI l'accolade : elles changent à chaque run, et un
       nom instable casserait l'appariement base/tête — donc le verdict causal. */
    assert.deepEqual(r.tests.map((t) => t.test), ['panier.test.ts › applique la remise']);
    assert.ok(!/time=/.test(r.tests[0].test));
    assert.match(r.tests[0].log_excerpt, /expected 41 to be 42/);
  });

  test('pytest-tap — un test par ligne, nommage module@test', () => {
    const sortie = [
      'TAP version 13',
      '1..3',
      'ok 1 - tests.test_panier@test_total',
      'not ok 2 - tests.test_panier@test_remise',
      'ok 3 - tests.test_panier@test_futur # SKIP pas encore implémenté',
    ].join('\n');

    const r = v.parserTap(sortie);
    assert.deepEqual(r.tests.map((t) => t.test), ['tests.test_panier@test_remise']);
    assert.equal(r.complet, true);
  });

  test('« Bail out! » : la suite s’est interrompue, ce n’est pas zéro échec', () => {
    const r = v.parserTap('TAP version 13\nok 1 - a\nBail out! base de données injoignable\n');
    assert.equal(r.bailOut, 'base de données injoignable');
  });

  test('une sortie tronquée est reconnue comme partielle, pas comme exhaustive', () => {
    // On coupe le début, comme le fait la conservation des derniers 64 ko de journal.
    const r = v.parserTap('    ok 297 - un test\nok 42 - une suite\n1..50\n');
    assert.equal(r.complet, false, 'le plan annonce 50 entrées de premier niveau, on en a lu 1');
  });

  test('un log ordinaire n’est jamais pris pour du TAP', () => {
    for (const bruit of [
      'npm WARN deprecated\nBuild ok\nDone in 4.2s',
      'ok\nok\nok',
      '[INFO] BUILD SUCCESS\n[INFO] Total time: 3.4 s',
      'installing… ok 1 package added',
    ]) {
      assert.equal(v.parserTap(bruit), null, `« ${bruit.split('\n')[0]} » n’est pas du TAP`);
    }
  });
});

/* ------------------------------------------------------------------ JUnit XML */

describe('formats : JUnit XML tel que l’écrivent les frameworks', () => {
  test('PHPUnit --log-junit — le message vit dans le TEXTE, pas dans un attribut', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="PanierTest" file="/app/tests/PanierTest.php" tests="3" assertions="3" errors="0" failures="1" skipped="1" time="0.012345">
    <testcase name="testTotal" class="PanierTest" classname="PanierTest" file="/app/tests/PanierTest.php" line="12" assertions="1" time="0.004"/>
    <testcase name="testRemise" class="PanierTest" classname="PanierTest" file="/app/tests/PanierTest.php" line="20" assertions="1" time="0.005">
      <failure type="PHPUnit\\Framework\\ExpectationFailedException">PanierTest::testRemise
Failed asserting that 41 matches expected 42.

/app/tests/PanierTest.php:22</failure>
    </testcase>
    <testcase name="testFutur" class="PanierTest" classname="PanierTest" time="0.000">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

    const r = v.parserJUnit(xml);
    assert.equal(r.total, 3);
    assert.deepEqual(r.tests.map((t) => t.test), ['PanierTest › testRemise'],
      'le test sauté n’est ni un succès ni un échec');
    assert.equal(r.tests[0].message, 'PanierTest::testRemise',
      'sans attribut `message`, la première ligne du texte en tient lieu');
    assert.match(r.tests[0].log_excerpt, /Failed asserting that 41 matches expected 42/);
  });

  test('jest-junit — classname et name identiques, échec sans attribut', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="2" failures="1" errors="0" time="1.234">
  <testsuite name="panier" errors="0" failures="1" skipped="0" timestamp="2026-08-02T10:00:00" time="1.2" tests="2">
    <testcase classname="panier applique la remise" name="panier applique la remise" time="0.9">
      <failure>Error: expect(received).toBe(expected) // Object.is equality

Expected: 42
Received: 41

    at Object.&lt;anonymous&gt; (/app/panier.test.js:12:20)</failure>
    </testcase>
    <testcase classname="panier calcule le total" name="panier calcule le total" time="0.3"/>
  </testsuite>
</testsuites>`;

    const r = v.parserJUnit(xml);
    assert.equal(r.total, 2);
    assert.equal(r.tests.length, 1);
    assert.match(r.tests[0].message, /expect\(received\)\.toBe\(expected\)/);
    assert.match(r.tests[0].log_excerpt, /at Object\.<anonymous>/,
      'les entités XML sont décodées : « &lt; » redevient « < »');
  });

  test('Maven Surefire / JUnit 5 — message en attribut, avec entités XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.PanierTest" time="0.35" tests="2" errors="0" skipped="0" failures="1">
  <testcase name="calculeLeTotal()" classname="com.acme.PanierTest" time="0.01"/>
  <testcase name="appliqueLaRemise()" classname="com.acme.PanierTest" time="0.02">
    <failure message="expected: &lt;42&gt; but was: &lt;41&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;42&gt; but was: &lt;41&gt;
	at com.acme.PanierTest.appliqueLaRemise(PanierTest.java:24)</failure>
  </testcase>
</testsuite>`;

    const r = v.parserJUnit(xml);
    assert.deepEqual(r.tests.map((t) => t.test), ['com.acme.PanierTest › appliqueLaRemise()']);
    assert.equal(r.tests[0].message, 'expected: <42> but was: <41>');
  });

  test('pytest --junitxml — contexte indenté et test sauté avec message', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.052" timestamp="2026-08-02T10:00:00" hostname="poste">
<testcase classname="tests.test_panier" name="test_total" time="0.001"/>
<testcase classname="tests.test_panier" name="test_remise" time="0.002"><failure message="assert 41 == 42">def test_remise():
&gt;       assert panier.total() == 42
E       assert 41 == 42

tests/test_panier.py:12: AssertionError</failure></testcase>
<testcase classname="tests.test_panier" name="test_futur" time="0.000"><skipped type="pytest.skip" message="pas encore">/app/tests/test_panier.py:20: pas encore</skipped></testcase>
</testsuite></testsuites>`;

    const r = v.parserJUnit(xml);
    assert.equal(r.total, 3);
    assert.deepEqual(r.tests.map((t) => t.test), ['tests.test_panier › test_remise']);
    assert.equal(r.tests[0].message, 'assert 41 == 42');
    assert.match(r.tests[0].log_excerpt, /> {7}assert panier\.total\(\) == 42/,
      '« &gt; » redevient « > » : c’est le repère de pytest sur la ligne fautive');
  });

  test('go-junit-report — <error> compte comme un échec', () => {
    const xml = `<testsuites>
  <testsuite tests="2" failures="1" errors="0" name="acme/panier" time="0.004">
    <testcase classname="acme/panier" name="TestTotal" time="0.000"/>
    <testcase classname="acme/panier" name="TestRemise" time="0.000">
      <failure message="Failed" type="">panier_test.go:14: attendu 42, reçu 41</failure>
    </testcase>
  </testsuite>
</testsuites>`;

    const r = v.parserJUnit(xml);
    assert.deepEqual(r.tests.map((t) => t.test), ['acme/panier › TestRemise']);
    assert.match(r.tests[0].log_excerpt, /panier_test\.go:14/);
  });

  test('attributs en guillemets simples, et XML qui n’a rien à voir', () => {
    const simples = "<testsuite><testcase classname='a.B' name='c'><error message='boum'>trace</error></testcase></testsuite>";
    assert.deepEqual(v.parserJUnit(simples).tests.map((t) => t.test), ['a.B › c']);

    // On ne devine pas : un XML étranger rend `null`, et l'appelant retombe sur la commande.
    assert.equal(v.parserJUnit('<coverage lines="80"><file path="a.js"/></coverage>'), null);
    assert.equal(v.parserJUnit('pas du xml du tout'), null);
    assert.equal(v.parserJUnit(''), null);
  });

  test('une suite entièrement verte donne zéro échec, pas « aucun format reconnu »', () => {
    const xml = '<testsuite tests="2"><testcase classname="a" name="x"/><testcase classname="a" name="y"/></testsuite>';
    const r = v.parserJUnit(xml);
    assert.equal(r.total, 2);
    assert.deepEqual(r.tests, [], 'reconnu ET vert : c’est ce qui permet de détecter une incohérence');
  });
});
