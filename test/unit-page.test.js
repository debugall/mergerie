'use strict';
/* LA PAGE ASSEMBLÉE PAR MORCEAUX (`src/core/page.js`) — l'unique exception au « pas de build »
 * du front. Ce module n'importe rien de `src/` (ni `paths.js`, ni la base) : il se charge ici
 * sans `MERGERIE_DATA_DIR`, sur une coquille et des morceaux écrits dans un dossier temporaire.
 * Le vrai `index.html` a son test dans `e2e-api` (« / et /index.html rendent la page assemblée »). */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assemblerPage, poserFragments, morceaux } = require('../src/core/page');

describe('page : assembler la coquille et ses morceaux', () => {
  let dir; let index;
  const ecrire = (rel, texte) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, texte);
  };
  const toucher = (rel) => {
    /* Une écriture dans la même milliseconde garde le même mtime : on recule celui du fichier
       d'une seconde avant, pour que l'écriture suivante se distingue à coup sûr. */
    const f = path.join(dir, rel);
    const avant = new Date(Date.now() - 2000);
    fs.utimesSync(f, avant, avant);
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-page-'));
    index = path.join(dir, 'index.html');
    ecrire('index.html', '<body>\n<!--@include html/a.html-->\n<main>\n    <!--@include html/ecrans/b.html-->\n</main>\n</body>\n');
    ecrire('html/a.html', '<div id="a">A</div>\n');
    ecrire('html/ecrans/b.html', '    <section id="b">B</section>\n');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('chaque marqueur est suivi du morceau, verbatim, et reste en place comme commentaire', () => {
    const page = assemblerPage(index);
    assert.equal(page, [
      '<body>',
      '<!--@include html/a.html-->',
      '<div id="a">A</div>',
      '<main>',
      '    <!--@include html/ecrans/b.html-->',
      '    <section id="b">B</section>',
      '</main>',
      '</body>',
      '',
    ].join('\n'));
    assert.deepEqual(morceaux(index), [{ rel: 'html/a.html', ligne: 2 }, { rel: 'html/ecrans/b.html', ligne: 4 }]);
  });

  test('un morceau modifié est servi sans redémarrage ; inchangé, la page vient de la mémoire', () => {
    const avant = assemblerPage(index);
    assert.equal(assemblerPage(index), avant, 'même page tant que rien ne change');
    toucher('html/a.html');
    ecrire('html/a.html', '<div id="a">A2</div>\n');
    assert.match(assemblerPage(index), /A2/, 'le morceau relu');
    toucher('index.html');
    ecrire('index.html', '<body>\n<!--@include html/a.html-->\n</body>\n');
    assert.doesNotMatch(assemblerPage(index), /id="b"/, 'la coquille relue : le second morceau n’est plus inclus');
  });

  test('un morceau absent, imbriqué ou hors de public/ est une erreur nommée', () => {
    toucher('index.html');
    ecrire('index.html', '<!--@include html/absent.html-->\n');
    assert.throws(() => assemblerPage(index), /absent\.html.*n'existe pas/);
    toucher('index.html');
    ecrire('index.html', '<!--@include ../index.html-->\n');
    assert.throws(() => assemblerPage(index), /relatif sous public/);
    toucher('index.html');
    ecrire('index.html', '<!--@include html/a.html-->\n');
    toucher('html/a.html');
    ecrire('html/a.html', '<!--@include html/ecrans/b.html-->\n');
    assert.throws(() => assemblerPage(index), /un seul niveau/);
  });
});

/* LES POSITIONS NOMMÉES DES ONGLETS DE PLUGINS. `before:git` se pose contre un bouton de la coquille ; une ancre que la coquille n'a pas — l'onglet d'un autre
   plugin, ou d'un plugin absent — ne doit jamais faire DISPARAÎTRE l'onglet qui la vise (c'est ce qu'un plugin posé « avant Liens » est devenu le jour où
   Liens a quitté le cœur). */
describe('page : les ancres d’onglets de plugins', () => {
  const coquille = [
    '<nav>', '<button data-tab="git">Git</button>', '<!--@plugins:nav-->', '<button data-tab="dashboard">Stats</button>', '</nav>',
  ].join('\n');
  const bouton = (id) => `<button data-tab="${id}" data-plugin-tab="${id}">${id}</button>`;
  const ordre = (html) => [...html.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]);

  test('une ancre de la coquille place le bouton avant ou après elle', () => {
    const html = poserFragments(coquille, { nav: bouton('x'), navPositions: { 'before:dashboard': bouton('av'), 'after:git': bouton('ap') } });
    assert.deepEqual(ordre(html), ['git', 'ap', 'x', 'av', 'dashboard']);
  });

  test('une ancre qui est l’onglet d’un autre plugin se résout contre lui', () => {
    const html = poserFragments(coquille, { nav: bouton('liens'), navPositions: { 'before:liens': bouton('docker'), 'after:liens': bouton('jenkins') } });
    assert.deepEqual(ordre(html), ['git', 'docker', 'liens', 'jenkins', 'dashboard']);
  });

  test('une ancre introuvable (plugin absent) ne fait pas disparaître l’onglet : il va en fin de liste', () => {
    const html = poserFragments(coquille, { nav: bouton('x'), navPositions: { 'before:liens': bouton('docker') } });
    assert.deepEqual(ordre(html), ['git', 'x', 'docker', 'dashboard']);
    assert.deepEqual(ordre(poserFragments(coquille, { nav: '', navPositions: { 'before:liens': bouton('docker') } })), ['git', 'docker', 'dashboard']);
  });
});
