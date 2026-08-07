'use strict';
/* Tests unitaires — réservés à la logique pure, difficile à provoquer de bout en
   bout : sortie IA malformée, ADF Jira biscornu, noms de refs limites, globs.
   Le reste du comportement est couvert par les parcours HTTP réels. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isole la base : ces modules chargent db.js (donc paths.js) au require.
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-unit-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const glob = require('../src/glob');
const { extractNote } = require('../src/note');
const resolution = require('../src/resolution');
const jira = require('../src/jira');
const gitlab = require('../src/gitlab');
const gitops = require('../src/gitops');
const { fillTemplate } = require('../src/reviewer');
const { promptsFor, isDefault, PROMPTS } = require('../src/prompts');
const i18n = require('../public/i18n-runtime.js');

describe('glob : règles de review par chemin', () => {
  test('l’étoile simple ne franchit pas les dossiers, un motif sans slash matche partout', () => {
    assert.equal(glob.pathMatches('*.sql', 'db/migrate/001.sql'), true);
    assert.equal(glob.pathMatches('*.sql', '001.sql'), true);
    assert.equal(glob.pathMatches('db/*.sql', 'db/001.sql'), true);
    assert.equal(glob.pathMatches('db/*.sql', 'db/migrate/001.sql'), false, '* ne traverse pas un slash');
    assert.equal(glob.pathMatches('db/**/*.sql', 'db/migrate/001.sql'), true);
    assert.equal(glob.pathMatches('src/?.js', 'src/a.js'), true);
    assert.equal(glob.pathMatches('src/?.js', 'src/ab.js'), false);
  });

  test('plusieurs motifs par champ, séparés par virgule ou espace', () => {
    assert.deepEqual(glob.splitPatterns(' *.sql,  src/**  \n *.env '), ['*.sql', 'src/**', '*.env']);
    assert.equal(glob.pathMatches('*.sql, *.env', '.env'), true);
    assert.deepEqual(
      glob.matchingPaths('*.sql', ['src/a.js', 'db/1.sql', './db/2.sql']),
      ['db/1.sql', './db/2.sql'],
      'le préfixe ./ est normalisé avant comparaison',
    );
    assert.deepEqual(glob.matchingPaths('', ['a.sql']), [], 'un champ vide ne matche rien');
  });

  test('les métacaractères d’expression régulière sont littéraux', () => {
    assert.equal(glob.pathMatches('src/a+b.js', 'src/a+b.js'), true);
    assert.equal(glob.pathMatches('src/a+b.js', 'src/aab.js'), false);
  });
});

describe('note : extraction de la note globale du rapport', () => {
  test('fraction sur une ligne mentionnant la note ou le score', () => {
    assert.deepEqual(extractNote('## Note globale\n7/10 — correct'), { raw: '7/10', value: 0.7 });
    assert.deepEqual(extractNote('Score : 15 / 20'), { raw: '15/20', value: 0.75 });
    assert.equal(extractNote('Note : 8,5/10').value, 0.85, 'la virgule décimale est acceptée');
  });

  test('repli sur une fraction à base classique, puis sur une note en lettre', () => {
    assert.deepEqual(extractNote('Le code obtient 4/5 sur ce point.'), { raw: '4/5', value: 0.8 });
    assert.deepEqual(extractNote('Note : B'), { raw: 'B', value: 0.8 });
    assert.equal(extractNote('note : b'), null, 'une minuscule isolée n’est pas une note (faux positif)');
  });

  test('la note retenue est celle qui CONCLUT le rapport, pas une note citée en cours de route', () => {
    // Régression : après « Relancer la review », le rapport rappelle souvent la note
    // précédente dans son résumé. En cherchant depuis le début, la liste restait
    // bloquée sur la note de la PREMIÈRE review.
    const rereview = [
      '# Revue de code — !42',
      '',
      '## Suivi de résolution',
      'La note précédente était de 5,8/10 ; les points bloquants ont été corrigés.',
      '',
      '## Note globale',
      '**8,4/10** — bon niveau, corrections mineures.',
    ].join('\n');
    assert.equal(extractNote(rereview).raw, '8,4/10', 'la note finale gagne sur celle citée plus haut');

    // Le libellé peut être un TITRE, la valeur venant à la ligne suivante.
    assert.equal(extractNote('## Note globale\n**7,2/10** — correct.').raw, '7,2/10');
    // …ou être porté par la même ligne.
    assert.equal(extractNote('Note globale : 6/10').raw, '6/10');
    // Sans libellé explicite, on prend quand même la DERNIÈRE fraction plausible.
    assert.equal(extractNote('Il reste 2/5 points ouverts.\n\nRésultat : 9/10.').raw, '9/10');
  });

  test('absence de note ou fraction incohérente', () => {
    assert.equal(extractNote(''), null);
    assert.equal(extractNote(null), null);
    assert.equal(extractNote('Rapport sans note chiffrée.'), null);
    assert.equal(extractNote('Note : 12/10'), null, 'un numérateur supérieur au dénominateur est ignoré');
    assert.equal(extractNote('Note : 3/0'), null);
  });
});

describe('resolution : constats structurés produits par l’IA', () => {
  const bloc = [
    '# Rapport',
    'Du texte.',
    '<<<FINDINGS',
    'severity | file | line | title',
    'blocker | src/a.js | 12 | Injection SQL possible',
    'major | src/b.js | 3 | Erreur non gérée',
    'inconnu | src/c.js | 7 | Sévérité hors barème',
    'minor | ai-dev-tools-internal/diff.patch | 1 | Constat interne',
    'blocker | src/a.js | 99 | injection sql POSSIBLE !',
    '--- | --- | --- | ---',
    'ligne malformée sans séparateur',
    'minor | src/d.js |  | Sans numéro de ligne',
    'FINDINGS>>>',
    'Suite du rapport.',
  ].join('\n');

  test('le bloc est retiré du rapport affiché', () => {
    const { markdown, block } = resolution.splitFindings(bloc);
    assert.ok(!markdown.includes('<<<FINDINGS'));
    assert.ok(markdown.startsWith('# Rapport'));
    assert.ok(markdown.endsWith('Suite du rapport.'));
    assert.ok(block.includes('Injection SQL possible'));

    const sansBloc = resolution.splitFindings('# Rapport seul');
    assert.deepEqual(sansBloc, { markdown: '# Rapport seul', block: '' });

    const nonFerme = resolution.splitFindings('# R\n<<<FINDINGS\nblocker | a | 1 | x');
    assert.equal(nonFerme.markdown, '# R', 'un bloc non fermé ne laisse rien fuiter dans le rapport');
    assert.ok(nonFerme.block.includes('blocker'));
  });

  test('le parseur tolère une sortie IA imparfaite', () => {
    const f = resolution.parseFindings(resolution.splitFindings(bloc).block);
    const titres = f.map((x) => x.title);
    assert.deepEqual(titres, ['Injection SQL possible', 'Erreur non gérée', 'Sévérité hors barème', 'Sans numéro de ligne']);
    assert.equal(f[0].severity, 'blocker');
    assert.equal(f[0].line, 12);
    assert.equal(f[2].severity, 'minor', 'une sévérité inconnue retombe sur minor');
    assert.equal(f[3].line, null);
    assert.ok(!titres.includes('Constat interne'), 'un constat ne pointe jamais le dossier interne de l’app');
    assert.equal(f.length, 4, 'en-tête, séparateur, ligne malformée et doublon sont écartés');
    assert.deepEqual(resolution.parseFindings(''), []);
  });

  test('l’empreinte identifie un constat sans dépendre de la ligne ni de la casse', () => {
    const a = resolution.fingerprint('src/a.js', 'Injection SQL possible');
    assert.equal(a, resolution.fingerprint('./src/a.js', 'injection  sql   possible !'));
    assert.notEqual(a, resolution.fingerprint('src/b.js', 'Injection SQL possible'));
    assert.equal(a.length, 16);
  });

  test('sans dépôt exploitable, un constat disparu n’est jamais compté « résolu »', async () => {
    const { rows, counts } = await resolution.diffFindings({
      cwd: process.env.MERGERIE_DATA_DIR,     // pas un dépôt git : la vérification échoue
      current: [{ fingerprint: 'f1', file: 'a.js', line: 1, severity: 'minor', title: 'A' }],
      previous: [
        { fingerprint: 'f1', file: 'a.js', line: 1, severity: 'minor', title: 'A' },
        { fingerprint: 'f2', file: 'b.js', line: 2, severity: 'major', title: 'B' },
      ],
      oldSha: 'deadbee', newSha: 'cafebab',
    });
    assert.deepEqual(counts, { n_new: 0, n_persistent: 1, n_resolved: 0, n_disappeared: 1 });
    assert.equal(rows.find((r) => r.fingerprint === 'f2').status, 'disappeared');
  });
});

describe('jira : clé de ticket et conversion ADF → Markdown', () => {
  test('la clé vient du titre entre crochets, sinon de la branche', () => {
    assert.equal(jira.ticketKey('Ajout [PROJ-21977] du calcul', 'feature/AUTRE-1'), 'PROJ-21977');
    assert.equal(jira.ticketKey('Ajout du calcul', 'feature/proj-42-calcul'), 'PROJ-42');
    assert.equal(jira.ticketKey('Rien', 'chore/menage'), null);
    assert.equal(jira.ticketKey(null, null), null);
  });

  test('isConfigured exige URL, email et jeton', () => {
    assert.equal(jira.isConfigured({ jira_url: 'u', jira_email: 'e', jira_token: 't' }), true);
    assert.equal(jira.isConfigured({ jira_url: 'u', jira_email: 'e' }), false);
    assert.equal(jira.isConfigured(null), false);
  });

  test('titres, listes, tableaux, code et marques', () => {
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Contexte' }] },
        { type: 'paragraph', content: [
          { type: 'text', text: 'gras', marks: [{ type: 'strong' }] },
          { type: 'text', text: ' et ' },
          { type: 'text', text: 'code', marks: [{ type: 'code' }] },
          { type: 'hardBreak' },
          { type: 'mention', attrs: { text: '@alice' } },
        ] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'un' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deux' }] }] },
        ] },
        { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const a = 1;' }] },
        { type: 'rule' },
        { type: 'table', content: [
          { type: 'tableRow', content: [
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Champ' }] }] },
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Valeur' }] }] },
          ] },
          { type: 'tableRow', content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'TVA' }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '20%' }] }] },
          ] },
        ] },
        { type: 'mediaSingle', content: [] },
      ],
    });
    assert.match(md, /## Contexte/);
    assert.match(md, /\*\*gras\*\* et `code`/);
    assert.match(md, /@alice/);
    assert.match(md, /- un\n- deux/);
    assert.match(md, /```js\nconst a = 1;\n```/);
    assert.match(md, /\| Champ \| Valeur \|/);
    assert.match(md, /\| TVA \| 20% \|/);
    assert.match(md, /_\(pièce jointe\)_/);
  });

  /* Le cas qui rendait un ticket technique illisible. Jira autorise n'importe quel bloc dans
     une cellule et s'en sert : une étiquette à gauche, un gabarit JSON à droite. Un tableau
     Markdown, lui, tient sur UNE ligne par cellule — le code s'y retrouvait aplati, ses
     indentations écrasées au rendu HTML, et incopiable. */
  test('un tableau dont une cellule porte du code est DÉPLIÉ, pas aplati', () => {
    const cell = (kids) => ({ type: 'tableCell', content: kids });
    const para = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [
          cell([para('NP15_Suppression_IN')]),
          cell([{ type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: '{\n    "partner": "LIN",\n    "version": 8\n}' }] }]),
        ] },
        { type: 'tableRow', content: [
          cell([para('NP15-1_Suppression_IN')]),
          cell([{ type: 'codeBlock', content: [{ type: 'text', text: '{\n    "version": 1\n}' }] }]),
        ] },
      ] }],
    });
    assert.doesNotMatch(md, /^\|/m, 'aucune ligne de tableau : le contenu ne tenait pas dedans');
    assert.match(md, /NP15_Suppression_IN\n\n```json\n\{\n {4}"partner": "LIN",/,
      'l’étiquette, puis le bloc de code avec ses indentations');
    assert.match(md, /\n---\n/, 'les lignes du tableau restent distinguables');
    assert.match(md, /"version": 1/, 'la seconde ligne est là aussi');
  });

  test('une cellule à plusieurs paragraphes est dépliée elle aussi', () => {
    const para = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', content: [para('un'), para('deux')] },
      ] }] }],
    });
    // Collés bout à bout, « un » et « deux » devenaient un seul mot illisible.
    assert.match(md, /un\n\ndeux/);
  });

  /* Un `|` dans une cellule ouvrirait une colonne de plus et décalerait toute la ligne :
     il est échappé à la source, et le rendu sait le lire (cf. `splitRow` dans app.js). */
  test('un tableau ordinaire reste un tableau, et le | d’une cellule est échappé', () => {
    const para = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    const head = (t) => ({ type: 'tableHeader', content: [para(t)] });
    const cell = (t) => ({ type: 'tableCell', content: [para(t)] });
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [head('Champ'), head('Valeur')] },
        { type: 'tableRow', content: [cell('mode'), cell('strict | souple')] },
      ] }],
    });
    assert.match(md, /\| Champ \| Valeur \|/);
    assert.match(md, /\| mode \| strict \\\| souple \|/);
    assert.equal(md.split('\n').length, 3, 'trois lignes : en-tête, séparateur, données');
  });

  /* Markdown n'a d'en-tête qu'en LIGNE, et en exige une. Promouvoir la première ligne sans
     vérifier déguisait donc en titre la première ligne de DONNÉES d'un tableau qui n'avait
     pas d'en-tête — une ligne perdue à chaque fois. */
  test('un tableau sans ligne d’en-tête ne sacrifie plus sa première ligne', () => {
    const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    const C = (t) => ({ type: 'tableCell', content: [p(t)] });
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [C('TVA'), C('20%')] },
        { type: 'tableRow', content: [C('Frais'), C('0€')] },
      ] }],
    });
    const lignes = md.split('\n');
    assert.equal(lignes[0], '|  |  |', 'un en-tête VIDE : Markdown en exige un, il ne ment sur rien');
    assert.equal(lignes[1], '| --- | --- |');
    assert.match(md, /\| TVA \| 20% \|/, 'la première ligne de données est toujours là');
    assert.match(md, /\| Frais \| 0€ \|/);
    assert.equal(lignes.length, 4, 'deux lignes de données, aucune promue en titre');
  });

  /* Un tableau clé/valeur met l'en-tête en première COLONNE : sa première ligne est donc
     mixte, et n'est pas un titre. La promouvoir sacrifiait une paire entière. */
  test('un en-tête de COLONNE n’est pas pris pour une ligne d’en-tête', () => {
    const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [p('Partenaire')] },
          { type: 'tableCell', content: [p('LIN')] },
        ] },
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [p('Version')] },
          { type: 'tableCell', content: [p('8')] },
        ] },
      ] }],
    });
    assert.match(md, /\| \*\*Partenaire\*\* \| LIN \|/,
      'la paire est gardée, et la clé mise en gras faute de `th` en colonne en Markdown');
    assert.match(md, /\| \*\*Version\*\* \| 8 \|/);
  });

  test('une vraie ligne d’en-tête reste une ligne d’en-tête', () => {
    const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
    const H = (t) => ({ type: 'tableHeader', content: [p(t)] });
    const C = (t) => ({ type: 'tableCell', content: [p(t)] });
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [{ type: 'table', content: [
        { type: 'tableRow', content: [H('Champ'), H('Valeur')] },
        { type: 'tableRow', content: [C('TVA'), C('20%')] },
      ] }],
    });
    assert.equal(md.split('\n')[0], '| Champ | Valeur |');
    // Et l'en-tête n'est pas mis en gras par-dessus : il est déjà un `th`.
    assert.doesNotMatch(md, /\*\*Champ\*\*/);
  });

  test('les marques d’une cellule survivent au rendu du tableau', () => {
    const md = jira.adfToMarkdown({
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'urgent', marks: [{ type: 'strong' }] }] }] },
      ] }] }],
    });
    assert.match(md, /\*\*urgent\*\*/, 'le gras était perdu quand on aplatissait les cellules');
  });

  test('les liens non http(s) sont neutralisés (contenu Jira = source externe)', () => {
    const doc = (href) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'clic', marks: [{ type: 'link', attrs: { href } }] }] }] });
    assert.equal(jira.adfToMarkdown(doc('https://ok.test/x')), '[clic](https://ok.test/x)');
    assert.equal(jira.adfToMarkdown(doc('javascript:alert(1)')), 'clic', 'le texte reste, l’URL dangereuse saute');
    assert.equal(jira.adfToMarkdown(doc('data:text/html,<script>')), 'clic');
  });

  test('les entrées dégradées ne font jamais échouer la conversion', () => {
    assert.equal(jira.adfToMarkdown(null), '');
    assert.equal(jira.adfToMarkdown('  déjà du texte  '), 'déjà du texte');
    // Nœud de bloc inconnu : on descend dans son contenu au lieu de le perdre.
    assert.equal(jira.adfToMarkdown({
      type: 'panelInconnu',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'gardé' }] }],
    }), 'gardé');
    assert.equal(jira.issueToContext({ summary: 'Titre', descriptionMd: 'Corps' }), '# Titre\n\nCorps');
    assert.equal(jira.issueToContext({ summary: '', descriptionMd: '' }), '');
  });
});

describe('gitlab : normalisation d’un identifiant de projet', () => {
  test('accepte URL https, SSH, chemin nu, .git et espaces', () => {
    assert.equal(gitlab.normalizeProject('https://gitlab.test/grp/sous/projet.git'), 'grp/sous/projet');
    assert.equal(gitlab.normalizeProject('git@gitlab.test:grp/projet.git'), 'grp/projet');
    assert.equal(gitlab.normalizeProject('  /grp/projet/  '), 'grp/projet');
    assert.equal(gitlab.normalizeProject(''), '');
    assert.equal(gitlab.encodeProject('grp/projet'), 'grp%2Fprojet');
  });
});

describe('gitops : validité d’un nom de ref', () => {
  test('refuse ce que git refuserait, mais plus tôt et plus clairement', () => {
    for (const bon of ['hotfix/1', 'release-1.0', 'feature/PROJ-42_x']) {
      assert.equal(gitops.validRefName(bon), true, bon);
    }
    for (const mauvais of ['', '  ', '-flag', 'a..b', 'a//b', '/a', 'a/', 'a.', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a@{b', 'a.lock', 'x'.repeat(201)]) {
      assert.equal(gitops.validRefName(mauvais), false, JSON.stringify(mauvais));
    }
  });

  test('seules les suppressions sont restaurables', () => {
    assert.equal(gitops.isDestructive('delete_branch'), true);
    assert.equal(gitops.isDestructive('delete_tag'), true);
    assert.equal(gitops.isDestructive('new_branch'), false);
  });
});

describe('prompts et gabarits', () => {
  test('fillTemplate remplace les variables connues et laisse les autres', () => {
    assert.equal(fillTemplate('skill={skill} src={source} ?={inconnu}', { skill: 'git-review', source: 'br' }),
      'skill=git-review src=br ?={inconnu}');
  });

  test('changer de langue n’écrase jamais un prompt personnalisé', () => {
    const auDefaut = { prompt_review: PROMPTS.fr.prompt_review, prompt_explain: '', prompt_modify: PROMPTS.en.prompt_modify };
    const patch = promptsFor('en', auDefaut);
    assert.equal(patch.prompt_review, PROMPTS.en.prompt_review);
    assert.equal(patch.prompt_explain, PROMPTS.en.prompt_explain, 'un gabarit vide est considéré « jamais renseigné »');
    assert.equal(patch.prompt_modify, undefined, 'déjà au défaut anglais : rien à faire');

    const personnalise = { prompt_review: 'Mon prompt à moi', prompt_explain: PROMPTS.fr.prompt_explain, prompt_modify: PROMPTS.fr.prompt_modify };
    assert.equal(promptsFor('en', personnalise).prompt_review, undefined, 'piège n°4 : le sur-mesure est intouchable');
    assert.equal(isDefault('prompt_review', 'Mon prompt à moi'), false);
    assert.deepEqual(promptsFor('kl', personnalise), {}, 'langue inconnue = aucun patch');
  });
});

describe('i18n : moteur de traduction partagé serveur / navigateur', () => {
  test('langue, repli et interpolation', () => {
    assert.equal(i18n.setLang('en'), 'en');
    assert.equal(i18n.setLang('kl'), 'fr', 'une langue inconnue retombe sur le français');
    assert.ok(i18n.langs().includes('en'));
    assert.equal(i18n.t('cle.totalement.inexistante'), 'cle.totalement.inexistante',
      'un trou de traduction se voit à l’écran plutôt que de disparaître');
    assert.equal(i18n.t('err.mr-already-open', { iid: 42 }).includes('42'), true);
  });

  test('l’avertissement « codage hors dépôt » distingue dépôt git et non-git', () => {
    // Garde-fou de copie : le dossier peut être un dépôt git OU PAS, et les deux cas
    // doivent être dits (git → annulation possible ; sinon → aucune annulation).
    i18n.setLang('fr');
    const fr = i18n.t('local.warn');
    assert.match(fr, /en place/i, 'modification en place');
    assert.match(fr, /d[ée]p[ôo]t git/i, 'cas dépôt git');
    assert.match(fr, /aucune annulation/i, 'cas non-git : pas d’annulation');
    i18n.setLang('en');
    const en = i18n.t('local.warn');
    assert.match(en, /git repositor/i);
    assert.match(en, /no undo/i);
  });
});

describe('questions : parsing du bloc <<<QUESTIONS>>> (ask → stop → resume)', () => {
  const questions = require('../src/questions');

  test('un bloc valide est extrait et normalisé', () => {
    const out = questions.parseQuestions(`bla bla
<<<QUESTIONS
[
  {"id":"q1","question":"Où mettre le retry ?","context":"deux conventions","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]},
  {"id":"q2","question":"Migrer ?","options":null}
]
QUESTIONS>>>
suite ignorée`);
    assert.equal(out.length, 2);
    assert.equal(out[0].options.length, 2);
    assert.equal(out[1].options, null, 'options null → réponse libre');
    assert.equal(out[0].answer, null);
  });

  test('bloc absent ou malformé → null (ne bloque pas la session)', () => {
    assert.equal(questions.parseQuestions('rien du tout'), null);
    assert.equal(questions.parseQuestions('<<<QUESTIONS\nceci n\'est pas du JSON\nQUESTIONS>>>'), null);
    assert.equal(questions.parseQuestions('<<<QUESTIONS\n[]\nQUESTIONS>>>'), null, 'liste vide → null');
    assert.equal(questions.parseQuestions('<<<QUESTIONS\n[{"context":"sans question"}]\nQUESTIONS>>>'), null, 'entrée sans question → écartée');
  });

  test('au-delà de 5 questions, on tronque', () => {
    const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, question: `Q${i}` })));
    const out = questions.parseQuestions(`<<<QUESTIONS\n${many}\nQUESTIONS>>>`);
    assert.equal(out.length, questions.MAX_QUESTIONS);
  });

  test('l’instruction de reprise reprend chaque question répondue', () => {
    const instr = questions.buildAnswerInstruction([
      { question: 'Où mettre le retry ?', answer: 'Décorateur' },
      { question: 'Migrer ?', answer: null }, // sans réponse → ignorée
    ]);
    assert.match(instr, /Où mettre le retry \? → Décorateur/);
    assert.doesNotMatch(instr, /Migrer/);
  });
});

describe('agentsession : commande de reprise de session', () => {
  const agentsession = require('../src/agentsession');
  test('claude → cd + --resume <uuid> ; copilot → COPILOT_HOME + --continue', () => {
    const claude = agentsession.resumeCommand('claude', 'uuid-123', '/home/moi/mon app');
    assert.match(claude, /^cd '\/home\/moi\/mon app' && /, 'cd vers le bon dossier (chemin cité)');
    assert.match(claude, / --resume uuid-123$/);
    const cop = agentsession.resumeCommand('copilot', '/data/agent-sessions/x', '/srv/app');
    assert.match(cop, /^cd '\/srv\/app' && /);
    assert.match(cop, /COPILOT_HOME='\/data\/agent-sessions\/x'/);
    assert.match(cop, / --continue$/);
  });
  test('null si handle/backend manquant, et quoting des apostrophes', () => {
    assert.equal(agentsession.resumeCommand('claude', null, '/x'), null);
    assert.equal(agentsession.resumeCommand('unknown', 'h', '/x'), null);
    assert.match(agentsession.resumeCommand('claude', 'id', "/a'b"), /'\\''/, 'apostrophe échappée pour le shell');
  });

  /* Sans cwd, la commande existe quand même — SANS `cd`. C'est le cas d'une session
     FOURNIE à la création : on sait la reprendre, on ignore d'où elle vient. Faire
     disparaître le bouton là serait le faire disparaître précisément quand on la cherche. */
  test('cwd inconnu : commande sans `cd`, pas d’absence de commande', () => {
    const claude = agentsession.resumeCommand('claude', 'uuid-123', null);
    assert.match(claude, /--resume uuid-123$/);
    assert.doesNotMatch(claude, /(^|\s)cd\s/);
    const cop = agentsession.resumeCommand('copilot', '/data/agent-sessions/x', '');
    assert.match(cop, /^COPILOT_HOME='\/data\/agent-sessions\/x'/);
    assert.match(cop, / --continue$/);
  });
});

/* Le CLI copilot emploie le mot « authentication » pour deux pannes très différentes.
   Envoyer quelqu'un faire /login alors que son proxy bloque api.github.com lui fait perdre
   des heures : ces cas réels sont figés ici pour que la distinction ne reparte pas. */
describe('agentsession : réseau vs authentification dans les erreurs copilot', () => {
  const { enrichCopilotError } = require('../src/agentsession');
  const bootstrap = { source: '/home/moi/.copilot', linked: ['config.json'] };
  const enrich = (m) => enrichCopilotError(new Error(m), bootstrap, '/data/agent-sessions/x').message;

  test('« token found but could not be validated » + fetch réseau → message RÉSEAU', () => {
    const m = enrich('Error: Authentication token found but could not be validated. '
      + 'Failed to fetch OAuth user login: network fetch failed: request failed: '
      + 'error sending request for url (https://api.github.com/copilot_internal/user)');
    assert.match(m, /échec réseau/);
    assert.doesNotMatch(m, /authentification introuvable dans le home isolé/);
    assert.match(m, /NO_PROXY/, 'la sortie doit dire quoi faire du proxy');
  });

  test('ECONNRESET / tunnel error → message RÉSEAU même sans le mot « authentication »', () => {
    const m = enrich('Error: Failed to load models\nError: error sending request for url '
      + '(https://api.business.githubcopilot.com/models): client error (Connect): tunnel error: '
      + 'io error establishing tunnel: Connection reset by peer (os error 104) [ECONNRESET]');
    assert.match(m, /échec réseau/);
    assert.doesNotMatch(m, /authentification introuvable dans le home isolé/);
  });

  test('« No authentication found » sans motif réseau → message AUTH inchangé', () => {
    const m = enrich("No authentication found. Run '/login' to authenticate.");
    assert.match(m, /authentification introuvable dans le home isolé/);
    assert.match(m, /COPILOT_HOME=\/data\/agent-sessions\/x/);
    assert.doesNotMatch(m, /échec réseau/);
  });

  test('erreur sans rapport → renvoyée telle quelle', () => {
    const e = new Error('spawn ENOEXEC');
    assert.equal(enrichCopilotError(e, bootstrap, '/x'), e, 'même objet Error, pas une copie');
  });
});

/* La liste des commandes git jugées destructives vit dans le front (public/app.js) : elle n'y
   est pas exportable, mais se laisse évaluer isolément. Un test vaut mieux qu'une relecture :
   trop large, elle fait confirmer un `git fetch` et on apprend à cliquer sans lire ; trop
   étroite, un `reset --hard` part sur trente dépôts sans un mot. */
describe('front : classement des commandes git destructives', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const from = src.indexOf('const GIT_DESTRUCTIVE');
  const to = src.indexOf('\n', src.indexOf('function gitCmdIsDestructive'));
  assert.ok(from > 0 && to > from, 'GIT_DESTRUCTIVE et gitCmdIsDestructive doivent rester ensemble dans app.js');
  // eslint-disable-next-line no-new-func
  const isDestructive = new Function(`${src.slice(from, to)}\nreturn gitCmdIsDestructive;`)();

  test('les commandes qui détruisent du travail non poussé sont reconnues', () => {
    for (const cmd of ['reset --hard origin/main', 'clean -fd', 'checkout -f main', 'push --force',
      'push origin --delete old', 'branch -D old', 'tag -d v1.2', 'stash drop', 'rebase main',
      'switch --discard-changes main', 'gc --prune=now', 'rm -r src', 'restore .']) {
      assert.ok(isDestructive(cmd), `« git ${cmd} » devrait demander confirmation`);
    }
  });

  test('les commandes de lecture ou de synchro courantes ne sont pas signalées', () => {
    for (const cmd of ['fetch --all --prune', 'status', 'log --oneline', 'remote -v', 'pull --rebase',
      'diff HEAD', 'branch -a', 'tag --list', 'stash list', 'describe --tags']) {
      assert.ok(!isDestructive(cmd), `« git ${cmd} » ne devrait pas demander confirmation`);
    }
  });
});

/* Filtre générique de l'onglet Jira : on choisit le champ, puis les valeurs. La sémantique
   (ET entre champs, OU dans un champ, critère vide = inactif) est ce qui décide de ce que
   l'utilisateur voit : se tromper ici cache des tickets sans rien dire. */
describe('front : filtre Jira par champ', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const from = src.indexOf('const JIRA_CHAMPS');
  const to = src.indexOf('\n}', src.indexOf('function jiraPasseFiltres')) + 2;
  assert.ok(from > 0 && to > from, 'JIRA_CHAMPS et jiraPasseFiltres doivent rester contigus dans app.js');
  // eslint-disable-next-line no-new-func
  const { passe, champs } = new Function(`${src.slice(from, to)}
    return { passe: jiraPasseFiltres, champs: JIRA_CHAMPS };`)();

  const bug = {
    key: 'A-1', type: 'Bug', priority: 'Haute', project: 'PROJ',
    epic: { key: 'E-1', summary: 'Tunnel' }, labels: ['régression', 'panier'],
    components: ['api'], fixVersions: ['2.4.0'],
    assignee: { name: 'Moi' }, reporter: { name: 'Support' },
  };
  const story = {
    key: 'A-2', type: 'Story', priority: 'Basse', project: 'PROJ',
    epic: { key: 'E-2', summary: 'Observabilité' }, labels: [],
    components: [], fixVersions: [],
    assignee: { name: 'Alex' }, reporter: { name: 'PO' },
  };
  const orphelin = { key: 'A-3', type: 'Tâche', project: 'AUTRE' };

  test('aucun filtre : tout passe', () => {
    for (const it of [bug, story, orphelin]) assert.ok(passe(it, {}));
  });

  test('un critère sans valeur cochée ne filtre RIEN', () => {
    // Sinon, ajouter un champ viderait la liste avant d'avoir coché quoi que ce soit.
    for (const it of [bug, story, orphelin]) assert.ok(passe(it, { epic: [], type: [] }));
  });

  test('OU à l’intérieur d’un champ', () => {
    assert.ok(passe(bug, { type: ['Bug', 'Story'] }));
    assert.ok(passe(story, { type: ['Bug', 'Story'] }));
    assert.ok(!passe(orphelin, { type: ['Bug', 'Story'] }));
  });

  test('ET entre les champs', () => {
    assert.ok(passe(bug, { type: ['Bug'], priority: ['Haute'] }));
    assert.ok(!passe(bug, { type: ['Bug'], priority: ['Basse'] }), 'les deux doivent être satisfaits');
  });

  test('un champ multi-valué correspond si UNE de ses valeurs est cochée', () => {
    assert.ok(passe(bug, { labels: ['panier'] }));
    assert.ok(passe(bug, { labels: ['inconnu', 'api', 'panier'] }));
    assert.ok(!passe(bug, { labels: ['inconnu'] }));
  });

  test('un ticket sans valeur pour un champ filtré est écarté', () => {
    assert.ok(!passe(story, { labels: ['panier'] }), 'aucune étiquette → ne correspond pas');
    assert.ok(!passe(orphelin, { epic: ['E-1'] }), 'aucun epic → ne correspond pas');
  });

  test('l’epic filtre sur sa CLÉ, pas sur son résumé', () => {
    assert.ok(passe(bug, { epic: ['E-1'] }));
    assert.ok(!passe(bug, { epic: ['Tunnel'] }), 'le résumé n’est qu’un libellé d’affichage');
  });

  test('chaque champ proposé sait extraire ses valeurs sans exploser sur un ticket vide', () => {
    for (const ch of champs) assert.deepEqual(ch.vals({}), [], `${ch.cle} sur un ticket vide`);
  });
});

describe('jira : repérage du champ sprint et lecture de ses valeurs', () => {
  test('repéré par son MARQUEUR de schéma, pas par son nom', () => {
    /* Le nom est localisé — « Itération » sur une instance française. Le marqueur, lui, est
       posé par Jira et ne dépend d'aucune langue : c'est le seul repère fiable. */
    assert.deepEqual(jira.detectSprintField([
      { id: 'customfield_10020', name: 'Itération', marqueur: 'com.pyxis.greenhopper.jira:gh-sprint' },
    ]), { id: 'customfield_10020', name: 'Itération' });
  });

  test('repli sur le nom quand le schéma n’est pas exposé, et rien sinon', () => {
    assert.deepEqual(jira.detectSprintField([{ id: 'customfield_1', name: 'Sprint', marqueur: '' }]),
      { id: 'customfield_1', name: 'Sprint' });
    assert.equal(jira.detectSprintField([{ id: 'customfield_1', name: 'Équipe', marqueur: '' }]), null);
    assert.equal(jira.detectSprintField([]), null);
  });

  test('les deux formes de valeur renvoyées par Jira sont lues', () => {
    assert.deepEqual(jira.sprintsDe([{ id: 42, name: 'Sprint 42', state: 'active' }]),
      [{ v: '42', l: 'Sprint 42', d: '', etat: 'active' }]);
    // Vieilles instances : une chaîne sérialisée plutôt qu'un objet.
    assert.deepEqual(jira.sprintsDe(['…Sprint@1[id=43,name=Sprint 43,state=CLOSED]']),
      [{ v: '43', l: 'Sprint 43', d: '', etat: 'closed' }]);
    assert.deepEqual(jira.sprintsDe(null), [], 'un ticket hors sprint n’a pas de valeur');
    assert.deepEqual(jira.sprintsDe(['sans identifiant']), [], 'une valeur illisible est écartée, pas devinée');
  });

  test('l’ÉTAT du sprint est extrait : « en cours » passe en tête, quelle que soit sa date', () => {
    assert.equal(jira.sprintsDe([{ id: 1, name: 'S', state: 'ACTIVE' }])[0].etat, 'active',
      'normalisé en minuscules : Jira écrit ACTIVE dans une forme, active dans l’autre');
    assert.equal(jira.sprintsDe(['x@1[id=2,name=S,state=CLOSED]'])[0].etat, 'closed');
    assert.equal(jira.sprintsDe([{ id: 3, name: 'S' }])[0].etat, '', 'état absent, pas deviné');
  });

  test('la DATE du sprint est extraite : c’est elle qui ordonne la liste', () => {
    // Objet : début, sinon fin.
    assert.equal(jira.sprintsDe([{ id: 1, name: 'S', startDate: '2026-07-20T08:00:00Z' }])[0].d,
      '2026-07-20T08:00:00Z');
    assert.equal(jira.sprintsDe([{ id: 1, name: 'S', endDate: '2026-08-01T08:00:00Z' }])[0].d,
      '2026-08-01T08:00:00Z', 'à défaut de début, la fin situe quand même le sprint');
    // Forme sérialisée, avec la date absente écrite « <null> ».
    assert.equal(jira.sprintsDe(['x@1[id=2,name=S,startDate=2026-06-01T09:00:00.000Z,endDate=x]'])[0].d,
      '2026-06-01T09:00:00.000Z');
    assert.equal(jira.sprintsDe(['x@1[id=3,name=S,startDate=<null>,endDate=<null>]'])[0].d, '',
      '« <null> » n’est pas une date : sans quoi le tri la placerait devant les vraies');
  });
});

/* Séquences ANSI dans les logs. Le cas qui a motivé ce nettoyage : une application dans un
   container colore sa sortie, `docker logs` la relaie telle quelle, et le panneau affichait
   « ␛[34mdebug␛[39m » — chaque ligne noyée sous ses propres octets d'échappement. */
describe('ansi : nettoyage des séquences d’échappement des logs', () => {
  const { stripAnsi, parseAnsi } = require('../public/ansi-runtime.js');
  const E = '\u001b';

  test('les couleurs SGR disparaissent, le texte reste intact', () => {
    assert.equal(stripAnsi(`${E}[34mdebug${E}[39m`), 'debug');
    // Ligne réelle observée : plusieurs segments colorés dans la même ligne.
    assert.equal(
      stripAnsi(`2026-07-30 18:30:23 | ${E}[37minfo${E}[39m ${E}[34m[getToken]${E}[39m - got token`),
      '2026-07-30 18:30:23 | info [getToken] - got token',
    );
    assert.equal(stripAnsi(`${E}[1m${E}[31mERREUR${E}[0m`), 'ERREUR');
  });

  test('les autres familles de séquences aussi (curseur, titre, hyperlien)', () => {
    assert.equal(stripAnsi(`${E}[2K${E}[1Gprogression`), 'progression');
    assert.equal(stripAnsi(`${E}]0;titre de fenêtre\u0007suite`), 'suite');
    assert.equal(stripAnsi(`${E}(Btexte`), 'texte');
  });

  test('les caractères de contrôle résiduels partent, sauf tabulation et saut de ligne', () => {
    assert.equal(stripAnsi('ligne\ravec retour chariot'), 'ligneavec retour chariot');
    assert.equal(stripAnsi('a\u0008b'), 'ab');
    assert.equal(stripAnsi('colonne\tcolonne'), 'colonne\tcolonne', 'la tabulation aligne, elle porte du sens');
    assert.equal(stripAnsi('deux\nlignes'), 'deux\nlignes');
  });


  /* Le rendu coloré, à la demande. Ce qu'il ne faut pas casser : les filtres portent
     TOUJOURS sur le texte nu, donc `parseAnsi` doit restituer exactement les mêmes
     caractères que `stripAnsi`, découpés autrement. */
  test('parseAnsi découpe en segments et restitue le même texte que stripAnsi', () => {
    const l = `${E}[34mdebug${E}[39m ok ${E}[1;31mERREUR${E}[0m fin`;
    const segs = parseAnsi(l);
    assert.deepEqual(segs.map((s) => s.text), ['debug', ' ok ', 'ERREUR', ' fin']);
    assert.equal(segs.map((s) => s.text).join(''), stripAnsi(l), 'aucun caractère perdu ni ajouté');
    assert.equal(segs[0].fg, 4);
    assert.deepEqual([segs[2].fg, segs[2].bold], [1, true], 'gras + rouge cumulés');
    assert.equal(segs[3].fg, null, 'ESC[0m remet tout à zéro');
  });

  test('parseAnsi : couleurs vives, et codes non gérés ignorés sans casse', () => {
    assert.deepEqual(parseAnsi(`${E}[91mvif${E}[39m`).map((s) => [s.fg, s.bright]), [[1, true]]);
    // 256 couleurs et RGB : leurs paramètres ne doivent pas être relus comme des codes.
    assert.deepEqual(parseAnsi(`${E}[38;5;208morange${E}[0m`).map((s) => s.text), ['orange']);
    assert.deepEqual(parseAnsi(`${E}[48;2;10;20;30mfond${E}[0m`).map((s) => [s.text, s.fg]), [['fond', null]]);
    // Fond seul : ignoré volontairement (contraste non maîtrisé sur deux thèmes).
    assert.deepEqual(parseAnsi(`${E}[41mrouge${E}[49m`).map((s) => s.fg), [null]);
    assert.deepEqual(parseAnsi(''), []);
  });

  test('parseAnsi borne le nombre de segments — une ligne pathologique existe', () => {
    const l = Array.from({ length: 200 }, (_, i) => `${E}[3${i % 8}mx`).join('');
    const segs = parseAnsi(l, 16);
    assert.ok(segs.length <= 17, 'plafond respecté (+1 pour le reste en texte nu)');
    assert.equal(segs.map((s) => s.text).join(''), 'x'.repeat(200), 'le texte reste complet');
  });

  test('une ligne sans séquence n’est pas touchée — accents compris', () => {
    const l = 'adp-api-verif 2026-07-30 | user vérifié, coût 12 € — ok';
    assert.equal(stripAnsi(l), l);
    assert.equal(stripAnsi(''), '');
    assert.equal(stripAnsi(null), '');
    assert.equal(stripAnsi(undefined), '');
  });
});

/* Le parallélisme repose entièrement sur cette règle : deux jobs qui partagent un dépôt ou
   un dossier ne peuvent pas tourner ensemble. S'y tromper ne donne pas un bug visible mais
   un clone git corrompu au milieu d'une review — d'où un test sur la règle nue. */
describe('jobs : conflit entre deux jobs (autorisation du parallèle)', () => {
  const { keysClash, MAX_RUNNING } = require('../src/jobs');

  test('le plafond de jobs simultanés est explicite', () => {
    // Ce n'est pas le code qui limite (tout passe à l'échelle) mais la machine : chaque job
    // lance un agent. La valeur est donc un choix, pas une contrainte — autant la figer.
    assert.equal(MAX_RUNNING, 3);
  });

  test('un dépôt ou un dossier en commun interdit le parallèle', () => {
    assert.equal(keysClash(['repo:1'], ['repo:1']), true);
    assert.equal(keysClash(['repo:1', 'repo:2'], ['repo:2', 'repo:3']), true);
    assert.equal(keysClash(['dir:/a'], ['dir:/a']), true);
  });

  test('des périmètres disjoints l’autorisent', () => {
    assert.equal(keysClash(['repo:1'], ['repo:2']), false);
    assert.equal(keysClash(['dir:/a'], ['dir:/b']), false);
    // Un job Docker ne touche aucun dépôt : il est parallélisable avec tout.
    assert.equal(keysClash([], ['repo:1', 'repo:2']), false);
    assert.equal(keysClash([], []), false);
  });

  test('un périmètre INCONNU refuse tout — prudence plutôt que corruption', () => {
    // `*` = job dont on ne sait pas déduire les cibles (restauration git, kind inattendu).
    assert.equal(keysClash(['*'], []), true);
    assert.equal(keysClash([], ['*']), true);
    assert.equal(keysClash(['*'], ['repo:9']), true);
  });
});

/* Les cibles d'un job pilotent un repère visuel posé sur la carte concernée. La règle qui
   compte est la retenue : un job de review porte sur un LOT de MR mais n'en traite qu'une à
   la fois, et marquer tout le lot ferait clignoter la moitié de la liste. */
describe('jobs : objets marqués « en cours »', () => {
  const { jobTargets } = require('../src/jobs');

  test('un lot de review ne désigne QUE la MR en cours de traitement', () => {
    const entry = { kind: 'review', rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    assert.deepEqual(jobTargets(entry, { current_mr_id: 2 }).mrs, [2]);
  });

  test('un lot dont le traitement n’a pas encore commencé ne marque rien', () => {
    const entry = { kind: 'review', rows: [{ id: 1 }, { id: 2 }] };
    assert.deepEqual(jobTargets(entry, { current_mr_id: null }).mrs, []);
    assert.deepEqual(jobTargets(entry, undefined).mrs, []);
  });

  test('chaque famille d’objet tombe dans son propre seau', () => {
    assert.deepEqual(jobTargets({ kind: 'local', taskId: 7 }), { mrs: [], tasks: [], locals: [7] });
    assert.deepEqual(jobTargets({ kind: 'task', taskId: 4 }), { mrs: [], tasks: [4], locals: [] });
    assert.deepEqual(jobTargets({ kind: 'converge-session', taskId: 5 }), { mrs: [], tasks: [5], locals: [] });
    assert.deepEqual(jobTargets({ kind: 'converge', mrId: 9 }), { mrs: [9], tasks: [], locals: [] });
  });

  test('un job sans cible identifiable ne marque rien plutôt que n’importe quoi', () => {
    assert.deepEqual(jobTargets({ kind: 'docker' }), { mrs: [], tasks: [], locals: [] });
    assert.deepEqual(jobTargets(null), { mrs: [], tasks: [], locals: [] });
  });
});

/* Le « delta depuis la dernière visite » ouvre le panneau de rapport. Sa valeur tient
   entièrement à ce qu'il TAIT : sans rien qui ait changé, il ne doit rien afficher — une
   ligne « 0 nouvelle MR » chaque matin est exactement ce qui rend un tableau de bord mort. */
describe('front : delta depuis la dernière visite', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const from = src.indexOf('const VISITE_GAP_MS');
  const to = src.indexOf('// La colonne de droite');
  assert.ok(from > 0 && to > from, 'le bloc du delta doit rester d’un seul tenant dans app.js');

  // `tr` est remplacé par un marqueur lisible : on teste la sélection des faits, pas la traduction.
  const build = (stock) => new Function('localStorage', 'tr', `${src.slice(from, to)}\nreturn { lignesDelta, memoriserVisite };`)(
    { getItem: (k) => (k in stock ? stock[k] : null), setItem: (k, v) => { stock[k] = v; } },
    (k, p) => `${k}:${p ? Object.values(p).join(',') : ''}`,
  );
  const JOUR = 86400000;
  const now = 1750000000000;
  const snap = (ids, ts) => ({ aidevtools_visite_reviewed: JSON.stringify({ ts, ids }) });

  test('sans visite précédente, aucune ligne — on n’invente pas un passé', () => {
    assert.deepEqual(build({}).lignesDelta('reviewed', [{ id: 1 }, { id: 2 }], now), []);
  });

  test('rien n’a bougé : rien ne s’affiche (jamais de « 0 nouvelle MR »)', () => {
    const { lignesDelta } = build(snap([1, 2], now - JOUR));
    assert.deepEqual(lignesDelta('reviewed', [{ id: 1 }, { id: 2 }], now), []);
  });

  test('une MR qui traîne ne suffit pas à ouvrir le panneau : ce n’est pas un changement', () => {
    // Sinon la même ligne s'affiche tous les matins, et le panneau cesse d'être lu.
    const { lignesDelta } = build(snap([1], now - JOUR));
    const rows = [{ id: 1, stale: true, gitlab_created_at: new Date(now - 40 * JOUR).toISOString() }];
    assert.deepEqual(lignesDelta('reviewed', rows, now), []);
  });

  test('les arrivées et les sorties sont comptées séparément', () => {
    const { lignesDelta } = build(snap([1, 2, 3], now - JOUR));
    const l = lignesDelta('reviewed', [{ id: 2 }, { id: 3 }, { id: 4 }], now);
    assert.equal(l[0], 'report.delta.since.yesterday:');   // en-tête daté
    assert.deepEqual(l.slice(1), ['report.delta.new:1', 'report.delta.gone:1']);
  });

  test('l’attente la plus ancienne compte parmi les faits, plafond à trois', () => {
    const { lignesDelta } = build(snap([1], now - 3 * JOUR));
    const rows = [
      { id: 2 },
      { id: 9, stale: true, gitlab_created_at: new Date(now - 4 * JOUR).toISOString() },
      { id: 8, stale: true, gitlab_created_at: new Date(now - 12 * JOUR).toISOString() },
    ];
    const l = lignesDelta('reviewed', rows, now);
    assert.equal(l[0], 'report.delta.since.days:3');
    assert.deepEqual(l.slice(1), ['report.delta.new:3', 'report.delta.gone:1', 'report.delta.wait:12']);
    assert.ok(l.length <= 4, 'en-tête + trois faits au maximum');
  });

  test('chaque stade a son propre instantané : changer de segment ne crée pas de faux delta', () => {
    const { lignesDelta } = build(snap([1, 2], now - JOUR));
    assert.deepEqual(lignesDelta('done', [{ id: 7 }], now), []);
  });

  test('dans la même session, la base de comparaison n’est pas réécrite', () => {
    // Sinon le delta fondrait à chaque re-rendu de la liste, sous les yeux de qui le lit.
    // Ce test-ci passe par l'horloge réelle : memoriserVisite compare à Date.now().
    const stock = snap([1, 2], Date.now() - 3600000); // il y a une heure
    const { memoriserVisite } = build(stock);
    memoriserVisite('reviewed', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.deepEqual(JSON.parse(stock.aidevtools_visite_reviewed).ids, [1, 2]);
  });
});
