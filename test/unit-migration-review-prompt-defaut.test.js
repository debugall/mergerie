'use strict';
/* Migration : le gabarit de review par défaut devient un gabarit structuré.
 *
 * L'ancien défaut (une phrase) est remplacé par un gabarit qui détaille la démarche attendue,
 * un format de rapport (sévérités, note calibrée) et une checklist de merge. Ce que la
 * migration doit garantir : une installation dont le gabarit est resté au défaut bascule sur
 * le nouveau, dans sa langue ; un gabarit personnalisé, ne serait-ce que d'un caractère, n'est
 * pas touché.
 *
 * Même mécanique que `unit-migration-review-skill.test.js` (le skill de review) : `db.js` est
 * un singleton branché sur `MERGERIE_DATA_DIR` au chargement, la migration se joue donc dans un
 * processus fils, seul moyen de choisir le répertoire de données.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.resolve(__dirname, '..');
const { PROMPTS, ANCIEN_PROMPT_REVIEW_COURT } = require('../src/core/prompts');

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

function semer(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-prompt-review-'));
  const code = `
    const db = require('better-sqlite3')(${JSON.stringify(path.join(dir, 'reviewer.db'))});
    db.exec(${JSON.stringify(ANCIEN)});
    db.prepare('INSERT INTO config (id, prompt_review, prompt_explain, prompt_modify) VALUES (1,?,?,?)')
      .run(${JSON.stringify(prompt)}, 'peu importe', 'peu importe');`;
  execFileSync(process.execPath, ['-e', code], { cwd: RACINE, stdio: 'pipe' });
  return dir;
}

describe('Migration : le gabarit de review par défaut devient structuré', () => {
  for (const lang of ['fr', 'en']) {
    test(`(${lang}) un gabarit jamais touché suit vers le nouveau défaut`, () => {
      const dir = semer(ANCIEN_PROMPT_REVIEW_COURT[lang]);
      const cfg = migrer(dir);
      assert.equal(cfg.prompt_review, PROMPTS[lang].prompt_review,
        'un gabarit resté au défaut doit devenir EXACTEMENT le nouveau défaut, au caractère près');
    });
  }

  test('un gabarit personnalisé n’est pas touché', () => {
    const perso = `${ANCIEN_PROMPT_REVIEW_COURT.fr} Et sois bref.`;
    const dir = semer(perso);
    assert.equal(migrer(dir).prompt_review, perso, 'un caractère de différence suffit à le protéger');
  });

  test('rejouée, elle ne touche plus à rien', () => {
    const dir = semer(ANCIEN_PROMPT_REVIEW_COURT.fr);
    assert.equal(migrer(dir).prompt_review, PROMPTS.fr.prompt_review);
    assert.equal(migrer(dir).prompt_review, PROMPTS.fr.prompt_review,
      'le deuxième démarrage laisse le gabarit tel quel');
  });

  test('sur une base neuve, le gabarit livré est le nouveau défaut structuré', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-prompt-review-neuve-'));
    const cfg = migrer(dir);
    assert.equal(cfg.prompt_review, PROMPTS.fr.prompt_review);
  });
});
