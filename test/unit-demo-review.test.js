'use strict';
/* Review SIMULÉE du mode démo — logique PURE (aucun clone, aucun agent, aucun réseau).
 *
 * Ce que ces tests protègent : en démo la forge n'existe pas, donc « Reviewer » ne peut pas
 * passer par un clone ni par un modèle. Le rapport rendu doit néanmoins avoir EXACTEMENT la
 * forme qu'attend la chaîne réelle — `splitFindings` pour le bloc de constats, `extractNote`
 * pour la note — sinon la démo affiche un rapport sans constat et sans note, et c'est
 * précisément sur la note qu'on filtre dans l'écran des reviews.
 *
 * Ils protègent aussi la promesse que le module s'est donnée : les constats citent des lignes
 * qui existent DANS LE DIFF AFFICHÉ. Des numéros qui ne mènent nulle part apprendraient au
 * lecteur de la démo à se méfier de ce qu'il voit.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-demo-review-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const demoReview = require('../src/demo/review');
const demoDiff = require('../src/demo/diff');
const resolution = require('../src/git/resolution');
const { extractNote } = require('../src/note');

const MR = {
  iid: 218, project: 'groupe/orders-service', title: 'Paiement 3× : éligibilité > 100 €',
  source_branch: 'feat/PROJ-1408-paiement-3x', target_branch: 'main',
};
const BORNES = { START: resolution.START, END: resolution.END };
const rapport = (mr = MR) => demoReview.rapport(mr, demoDiff.diffPour(mr), BORNES);

/** Les lignes réellement modifiées par le diff, fichier par fichier — la vérité de référence. */
function lignesDuDiff(diff) {
  const out = new Map();
  let fichier = null;
  for (const l of diff.split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(l);
    if (f) { fichier = f[1]; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(l);
    if (h && fichier) {
      const debut = Number(h[1]);
      const long = h[2] === undefined ? 1 : Number(h[2]);
      if (!out.has(fichier)) out.set(fichier, []);
      out.get(fichier).push([debut, debut + long]);
    }
  }
  return out;
}

describe('demo-review — le rapport que la démo rend à la place d’un modèle', () => {
  test('isDemo suit la variable d’environnement', () => {
    const avant = process.env.MERGERIE_DEMO;
    process.env.MERGERIE_DEMO = '1';
    assert.equal(demoReview.isDemo(), true);
    delete process.env.MERGERIE_DEMO;
    assert.equal(demoReview.isDemo(), false);
    if (avant !== undefined) process.env.MERGERIE_DEMO = avant;
  });

  test('le rapport dit qu’il est simulé', () => {
    // Sans cette phrase, un rapport de démo peut passer pour le travail d'un vrai modèle.
    assert.match(rapport(), /Mode démo — analyse simulée/);
  });

  test('le bloc de constats se relit par la chaîne réelle, pas par une lecture ad hoc', () => {
    const { markdown, block } = resolution.splitFindings(rapport());
    const constats = resolution.parseFindings(block);
    assert.ok(constats.length > 0, 'un rapport sans constat ne remplirait jamais l’onglet');
    for (const c of constats) {
      assert.ok(resolution.SEVERITIES.includes(c.severity), `sévérité hors barème : ${c.severity}`);
      assert.ok(c.file && c.title, 'un constat porte toujours un fichier et un titre');
      assert.equal(typeof c.line, 'number');
    }
    // Le markdown rendu au lecteur ne doit plus contenir les bornes techniques.
    assert.doesNotMatch(markdown, new RegExp(resolution.START));
    assert.doesNotMatch(markdown, new RegExp(resolution.END));
  });

  test('la note est extraite par extractNote — c’est elle qui alimente le filtre de l’écran', () => {
    const { markdown } = resolution.splitFindings(rapport());
    const note = extractNote(markdown);
    assert.ok(note, 'sans note, la merge request tombe dans « sans note » et sort des filtres');
    assert.ok(note.value > 0 && note.value <= 1, `valeur hors bornes : ${note.value}`);
  });

  test('chaque constat pointe une ligne qui existe dans le diff affiché', () => {
    const diff = demoDiff.diffPour(MR);
    const attendu = lignesDuDiff(diff);
    const constats = resolution.parseFindings(resolution.splitFindings(
      demoReview.rapport(MR, diff, BORNES)).block);
    for (const c of constats) {
      const plages = attendu.get(c.file);
      assert.ok(plages, `constat sur \`${c.file}\`, absent du diff`);
      assert.ok(plages.some(([a, b]) => c.line >= a && c.line <= b),
        `\`${c.file}\`:${c.line} tombe hors des blocs modifiés`);
    }
  });
});

describe('demo-review — le contexte saisi par le relecteur', () => {
  const CONSIGNE = 'Règle métier : le paiement fractionné n’est proposé qu’au-dessus de 100 €.\n'
    + 'Piège connu : l’arrondi des trois échéances.';

  test('sans contexte, le rapport n’invente pas de section', () => {
    assert.doesNotMatch(rapport(), /contexte fourni par le relecteur/i);
  });

  test('avec contexte, le rapport le reprend — c’est ce qui prouve qu’il voyage avec le diff', () => {
    const md = rapport({ ...MR, ticket_text: CONSIGNE });
    assert.match(md, /## Le contexte fourni par le relecteur/);
    for (const ligne of CONSIGNE.split('\n')) assert.ok(md.includes(ligne), `ligne perdue : ${ligne}`);
  });

  test('le premier constat rend compte de la consigne, en restant un constat lisible', () => {
    const md = rapport({ ...MR, ticket_text: CONSIGNE });
    const [premier] = resolution.parseFindings(resolution.splitFindings(md).block);
    assert.match(premier.title, /contexte du relecteur/i);
    assert.ok(premier.line, 'le constat reste situé, comme les autres');
  });

  test('une consigne très longue est coupée sur un mot, jamais au milieu', () => {
    const longue = `${'onze lettres '.repeat(20)}fin`;
    const md = rapport({ ...MR, ticket_text: longue });
    const [premier] = resolution.parseFindings(resolution.splitFindings(md).block);
    const extrait = premier.title.replace(/^contexte du relecteur : /i, '').replace(/…$/, '');
    assert.ok(premier.title.endsWith('…'), 'la coupe doit se voir');
    assert.ok(longue.startsWith(extrait), 'l’extrait doit être un préfixe exact de la consigne');
    assert.ok(/\S$/.test(extrait) && longue[extrait.length].match(/\s/),
      'la coupe tombe sur une frontière de mot');
  });

  test('un contexte vide ou blanc est traité comme absent', () => {
    for (const vide of ['', '   \n  \n']) {
      assert.doesNotMatch(rapport({ ...MR, ticket_text: vide }), /contexte fourni par le relecteur/i);
    }
  });
});

describe('demo-review — l’explication', () => {
  test('elle se donne pour simulée et cite les fichiers du diff', () => {
    const diff = demoDiff.diffPour(MR);
    const md = demoReview.explication(MR, diff);
    assert.match(md, /explication simulée/i);
    const fichiers = [...new Set((diff.match(/^\+\+\+ b\/(.+)$/gm) || [])
      .map((l) => l.replace('+++ b/', '')))];
    for (const f of fichiers) assert.ok(md.includes(f), `fichier absent de l’explication : ${f}`);
  });

  test('elle ne porte AUCUN bloc de constats — c’est un autre onglet', () => {
    // Un bloc ici ferait remonter des constats depuis l'explication, en doublon de la review.
    assert.doesNotMatch(demoReview.explication(MR, demoDiff.diffPour(MR)),
      new RegExp(resolution.START));
  });
});

/* La démo tourne aussi en anglais, et c'est elle qui fournit la capture de la page d'accueil :
   le rapport était écrit en français en dur, donc l'accueil anglais illustrait « Reviews » avec
   « Revue — Paiement 3× », « Points d'attention », « Note globale ». Ces tests tiennent les deux
   bouts : plus une phrase française quand la langue est l'anglais, et la note reste lisible par
   `extractNote` alors que le séparateur décimal et le titre de section ont changé. */
describe('demo-review — le rapport suit la langue de l’interface', () => {
  const i18n = require('../public/i18n-runtime.js');
  const enAnglais = (fn) => {
    const avant = i18n.getLang();
    i18n.setLang('en');
    try { return fn(); } finally { i18n.setLang(avant); }
  };
  /* Des phrases entières, pas des mots : « constant » ou « test » existent dans les deux
     langues, et un marqueur trop court rendrait le test vert pour de mauvaises raisons. */
  const MARQUEURS_FR = [
    /Mode démo/, /analyse simulée/, /Points d’attention/, /Note globale/, /Ce qui est bien/,
    /Ce que fait la merge request/, /La branche/, /fichier\(s\)/, /explication simulée/,
    /Réponse simulée/, /Le rapport de revue n’a pas bougé/,
  ];

  test('en anglais, aucune phrase française ne subsiste', () => {
    const diff = demoDiff.diffPour(MR);
    const tout = enAnglais(() => [
      demoReview.rapport({ ...MR, ticket_text: 'Business rule: above 100 EUR only.' }, diff, BORNES),
      demoReview.explication(MR, diff),
      demoReview.reponseQuestion(MR, diff, 'why is this blocking'),
    ].join('\n'));
    for (const re of MARQUEURS_FR) assert.doesNotMatch(tout, re, `français résiduel : ${re}`);
    assert.match(tout, /Demo mode — simulated analysis/);
  });

  test('aucun paramètre {…} ne reste à remplacer, dans l’une ou l’autre langue', () => {
    // Une clé dont le nom de paramètre a divergé laisse « {branch} » en clair dans le rapport.
    const diff = demoDiff.diffPour(MR);
    const documents = (mr) => [
      demoReview.rapport(mr, diff, BORNES),
      demoReview.explication(mr, diff),
      demoReview.reponseQuestion(mr, diff, 'une question'),
    ];
    const mr = { ...MR, ticket_text: 'Une consigne.' };
    for (const md of [...documents(mr), ...enAnglais(() => documents(mr))]) {
      assert.doesNotMatch(md, /\{[a-zA-Z]+\}/, 'un paramètre de traduction n’a pas été remplacé');
    }
  });

  test('en anglais la note reste extraite, malgré le point décimal et « Overall score »', () => {
    // extractNote cherche « note globale » OU « overall score/rating/grade » : changer le titre
    // sans vérifier ce point ferait tomber toute la démo anglaise dans « sans note ».
    const note = enAnglais(() => {
      const { markdown } = resolution.splitFindings(rapport());
      assert.match(markdown, /## Overall score/);
      assert.match(markdown, /\*\*\d+\.\d+\/10\*\*/, 'la note anglaise s’écrit avec un point');
      return extractNote(markdown);
    });
    assert.ok(note, 'sans note, la merge request sort des filtres de l’écran des reviews');
    assert.ok(note.value > 0 && note.value <= 1, `valeur hors bornes : ${note.value}`);
  });

  test('en anglais le bloc de constats se relit toujours par la chaîne réelle', () => {
    const constats = enAnglais(() => resolution.parseFindings(resolution.splitFindings(rapport()).block));
    assert.ok(constats.length > 0);
    for (const c of constats) {
      assert.ok(resolution.SEVERITIES.includes(c.severity), `sévérité hors barème : ${c.severity}`);
      assert.ok(c.file && c.title, 'un constat porte toujours un fichier et un titre');
    }
  });

  test('le bandeau « analyse simulée » tient sur UNE citation, pas deux', () => {
    // Coupé en deux lignes, le rendu Markdown en faisait deux blocs cités l'un sous l'autre.
    for (const md of [rapport(), enAnglais(() => rapport())]) {
      const cites = md.split('\n').filter((l) => l.startsWith('> '));
      assert.equal(cites.length, 1, 'le bandeau doit tenir sur une seule ligne citée');
    }
  });
});
