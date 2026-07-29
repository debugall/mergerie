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
  test('null si handle/cwd/backend manquant, et quoting des apostrophes', () => {
    assert.equal(agentsession.resumeCommand('claude', null, '/x'), null);
    assert.equal(agentsession.resumeCommand('claude', 'h', null), null);
    assert.equal(agentsession.resumeCommand('unknown', 'h', '/x'), null);
    assert.match(agentsession.resumeCommand('claude', 'id', "/a'b"), /'\\''/, 'apostrophe échappée pour le shell');
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
