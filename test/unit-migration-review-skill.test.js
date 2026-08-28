'use strict';
/* Migration : le « skill de review » quitte son champ pour entrer dans le gabarit.
 *
 * Le réglage a disparu de l'écran — le nom du skill s'écrit désormais dans le gabarit de
 * prompt, là où l'on choisit déjà tout le reste de ce qu'on demande à l'IA. Restent les bases
 * existantes, dont les gabarits portent un `{skill}` que plus personne ne remplirait : il
 * partirait tel quel à l'agent, qui lirait « Utilise le skill {skill} ». Ce que la migration
 * doit garantir tient en deux points — plus aucun `{skill}` nulle part, et la valeur choisie
 * n'est pas perdue mais recopiée à sa nouvelle place.
 *
 * `db.js` est un singleton branché sur `MERGERIE_DATA_DIR` au chargement : la migration se
 * joue donc dans un processus fils, seul moyen de choisir le répertoire de données.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.resolve(__dirname, '..');
const { PROMPTS, ANCIENS_PROMPTS } = require('../src/prompts');

// La table `config` telle qu'elle était, avec le champ et les gabarits à trous.
const ANCIEN = `
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  gitlab_url TEXT DEFAULT '', access_token TEXT DEFAULT '', clone_path TEXT DEFAULT '',
  prompt_review TEXT DEFAULT '', prompt_explain TEXT DEFAULT '', prompt_modify TEXT DEFAULT '',
  review_skill TEXT DEFAULT 'git-review');`;

function migrer(dir) {
  const lire = `
    const db = require('./src/db');
    process.stdout.write('@@' + JSON.stringify(db.prepare('SELECT * FROM config WHERE id = 1').get()));`;
  const sortie = execFileSync(process.execPath, ['-e', lire], {
    cwd: RACINE, stdio: 'pipe', env: { ...process.env, MERGERIE_DATA_DIR: dir },
  }).toString();
  return JSON.parse(sortie.slice(sortie.indexOf('@@') + 2));
}

function semer(prompts, skill) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-skill-'));
  const code = `
    const db = require('better-sqlite3')(${JSON.stringify(path.join(dir, 'reviewer.db'))});
    db.exec(${JSON.stringify(ANCIEN)});
    db.prepare('INSERT INTO config (id, prompt_review, prompt_explain, prompt_modify, review_skill) VALUES (1,?,?,?,?)')
      .run(${JSON.stringify(prompts.review)}, ${JSON.stringify(prompts.explain)},
           ${JSON.stringify(prompts.modify)}, ${JSON.stringify(skill)});`;
  execFileSync(process.execPath, ['-e', code], { cwd: RACINE, stdio: 'pipe' });
  return dir;
}

describe('Migration : le skill de review passe dans le gabarit', () => {
  /* LE CAS DE PRESQUE TOUT LE MONDE : gabarit jamais touché, skill jamais changé. Le gabarit
     doit redevenir EXACTEMENT le défaut, sinon il serait considéré comme personnalisé et
     cesserait de suivre les changements de langue. */
  test('un gabarit au défaut redevient le défaut du jour', () => {
    const dir = semer({
      review: 'Utilise le skill {skill} pour faire la revue de code UNIQUEMENT des changements '
        + 'de la branche {source} par rapport à {target} (le diff est dans le fichier {diff_file}). '
        + 'Ne parse pas tout le dépôt, concentre-toi sur ces changements. '
        + 'Produis un rapport de revue clair en Markdown (français) : problèmes, risques, '
        + "suggestions concrètes avec fichier et ligne quand c'est possible, et une note globale.",
      explain: 'peu importe', modify: 'peu importe',
    }, 'git-review');

    const cfg = migrer(dir);
    assert.equal(cfg.prompt_review, PROMPTS.fr.prompt_review,
      'le gabarit migré est le défaut au caractère près — sinon il passerait pour personnalisé');
    assert.doesNotMatch(cfg.prompt_review, /\{skill\}/);
  });

  /* LE CAS QUI COMPTE VRAIMENT : un skill maison. Le supprimer sans le recopier reviendrait à
     changer en silence ce qu'on demande à l'IA — et personne ne s'en apercevrait avant de lire
     un rapport qui ne ressemble plus à rien. */
  test('un skill personnalisé n’est pas perdu : il est recopié dans les trois gabarits', () => {
    const dir = semer({
      review: 'Utilise le skill {skill} sur {source}.',
      explain: 'Explique avec {skill} le diff {diff_file}.',
      modify: 'Corrige avec {skill} : {instruction}',
    }, 'review-maison');

    const cfg = migrer(dir);
    assert.equal(cfg.prompt_review, 'Utilise le skill review-maison sur {source}.');
    assert.equal(cfg.prompt_explain, 'Explique avec review-maison le diff {diff_file}.');
    assert.equal(cfg.prompt_modify, 'Corrige avec review-maison : {instruction}');
    for (const champ of ['prompt_review', 'prompt_explain', 'prompt_modify']) {
      assert.doesNotMatch(cfg[champ], /\{skill\}/, `${champ} ne garde aucun trou à remplir`);
    }
  });

  /* Un champ vidé à la main ne doit pas produire « Utilise le skill  » : le défaut historique
     reprend la main. Et les autres trous du gabarit — eux bien vivants — sont intacts. */
  test('un champ vide retombe sur git-review, et les autres placeholders survivent', () => {
    const dir = semer({ review: 'skill={skill} src={source} dst={target}', explain: '', modify: '' }, '   ');
    const cfg = migrer(dir);
    assert.equal(cfg.prompt_review, 'skill=git-review src={source} dst={target}');
  });

  /* Rejouer la migration ne doit rien abîmer : elle tourne à CHAQUE démarrage. */
  test('rejouée, elle ne touche plus à rien', () => {
    const dir = semer({ review: 'Utilise le skill {skill}.', explain: '', modify: '' }, 'maison');
    assert.equal(migrer(dir).prompt_review, 'Utilise le skill maison.');
    assert.equal(migrer(dir).prompt_review, 'Utilise le skill maison.',
      'le deuxième démarrage laisse le gabarit tel quel');
  });

  /* UNE BASE NEUVE, le cas qu'on ne teste jamais et qui casse en production : les gabarits
     livrés ne doivent porter aucun trou orphelin. */
  test('sur une base neuve, aucun gabarit ne porte de {skill}', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-skill-neuve-'));
    const cfg = migrer(dir);
    for (const champ of ['prompt_review', 'prompt_explain', 'prompt_modify']) {
      assert.doesNotMatch(cfg[champ], /\{skill\}/, champ);
    }
    assert.doesNotMatch(cfg.prompt_review, /git-review/,
      'le gabarit livré n’invoque AUCUN skill : celui qui installe l’outil ne l’a pas');
  });

  /* LE GABARIT LIVRÉ N'INVOQUE PLUS DE SKILL — et les installations existantes non plus.
     Celui qui installe Mergerie n'a pas `git-review` : sa première review demandait à l'agent
     de se servir d'un skill inexistant, sans que rien ne l'explique dans le rapport. */
  for (const lang of ['fr', 'en']) {
    test(`(${lang}) l’ancien gabarit livré est remplacé par le nouveau, dans SA langue`, () => {
      const dir = semer({ review: ANCIENS_PROMPTS[lang].prompt_review, explain: '', modify: '' }, 'git-review');
      const cfg = migrer(dir);
      assert.equal(cfg.prompt_review, PROMPTS[lang].prompt_review,
        'un gabarit jamais touché suit l’application : sinon il garderait le skill pour toujours');
      assert.doesNotMatch(cfg.prompt_review, /git-review/);
    });
  }

  /* Et il s'arrête là. Un gabarit que quelqu'un a écrit lui appartient — même s'il nomme
     `git-review`, précisément parce qu'il a peut-être ce skill, lui. */
  test('un gabarit personnalisé qui nomme git-review n’est pas touché', () => {
    const perso = `${ANCIENS_PROMPTS.fr.prompt_review} Et sois bref.`;
    const dir = semer({ review: perso, explain: '', modify: '' }, 'git-review');
    assert.equal(migrer(dir).prompt_review, perso, 'un caractère de différence suffit à le protéger');
  });

  /* Rejouée à chaque démarrage : le deuxième passage ne doit plus rien trouver à faire. */
  test('rejouée, la sortie du skill ne touche plus à rien', () => {
    const dir = semer({ review: ANCIENS_PROMPTS.fr.prompt_review, explain: '', modify: '' }, 'git-review');
    assert.equal(migrer(dir).prompt_review, PROMPTS.fr.prompt_review);
    assert.equal(migrer(dir).prompt_review, PROMPTS.fr.prompt_review);
  });
});
