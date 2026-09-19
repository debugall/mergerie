'use strict';
/* CE QU'UN AGENT A LE DROIT DE FAIRE, SELON CE QU'ON LUI DEMANDE — la ligne de commande produite.
 *
 * `COPILOT_ARGS=--dangerously-skip-permissions` partait sur TOUS les lancements : une review, qui
 * lit la description d'une MR écrite par n'importe qui, tournait avec le droit de tout écrire et
 * tout lancer. On éprouve ici l'argv que produit chaque saveur, contre un faux binaire dont le
 * `--help` annonce (ou non) `--restricted` — le vrai CLI a été sondé à la main (cf. agentpolicy.js).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
// `interditsDonnees` lit `paths` : jamais sans dossier de données isolé (CLAUDE.md).
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpolicy-'));
const pol = require('../src/agent/policy');

const faux = (aide) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faux-claude-'));
  const bin = path.join(d, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'X'\n${aide}\nX\n`, { mode: 0o755 });
  return bin;
};
const MODERNE = faux('  --restricted  Restricted mode\n  --setting-sources <s>\n  --strict-mcp-config');
const ANCIEN = faux('  --setting-sources <s>');
const YOLO = ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--verbose'];

describe('agentpolicy : les saveurs de lecture perdent le mode large', { skip: process.platform === 'win32' ? 'faux binaire sh' : false }, () => {
  beforeEach(() => pol.oublierCapacites());

  for (const kind of ['review', 'explain', 'question', 'modify', 'explore', 'ask', 'test']) {
    test(`${kind} : ni skip-permissions ni bypass, et un mode restreint`, () => {
      const r = pol.argvPermissions({ backend: 'claude', bin: MODERNE, extra: YOLO, kind });
      const argv = [...r.extra, ...r.args];
      assert.equal(argv.includes('--dangerously-skip-permissions'), false, argv.join(' '));
      assert.equal(argv.includes('bypassPermissions'), false, argv.join(' '));
      assert.ok(argv.includes('--restricted'), argv.join(' '));
      assert.ok(argv.includes('--verbose'), 'ce qui n’élargit rien reste');
      assert.equal(r.lecture, true);
    });
  }

  test('un CLI sans --restricted : liste de lecture, écriture interdite, réglages du dépôt ignorés', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: ANCIEN, extra: YOLO, kind: 'review' });
    const a = r.args;
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'default');
    assert.match(a[a.indexOf('--allowedTools') + 1], /^Read,Glob,Grep,Bash\(git log:\*\)/);
    assert.match(a[a.indexOf('--disallowedTools') + 1], /Write.*Edit.*WebFetch/);
    assert.deepEqual(a.slice(-2), ['--setting-sources', 'user'], 'pas le .claude/ de l’auteur de la MR');
    assert.equal(r.extra.includes('--dangerously-skip-permissions'), false);
  });

  test('les projets liés d’une review restent lisibles (--add-dir)', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: MODERNE, extra: [], kind: 'review', addDirs: ['/clones/lib'] });
    assert.deepEqual(r.args.slice(-2), ['--add-dir', '/clones/lib']);
  });
});

describe('agentpolicy : les saveurs d’écriture gardent le mode, perdent les chemins de fuite', () => {
  for (const kind of ['code', 'fix', 'converge', 'local', 'task', 'rebase', undefined]) {
    test(`${kind || '(inconnue)'} : le mode de l’utilisateur reste, la fuite est interdite`, () => {
      const r = pol.argvPermissions({ backend: 'claude', bin: MODERNE, extra: YOLO, kind });
      assert.deepEqual(r.extra, YOLO, 'un agent qui code doit pouvoir lancer les tests');
      const interdits = r.args[r.args.indexOf('--disallowedTools') + 1];
      for (const x of ['WebFetch', 'Bash(curl:*)', 'Bash(git push:*)', 'Bash(git remote:*)']) assert.ok(interdits.includes(x), x);
    });
  }

  test('la base et le .env sont fermés aux outils de fichiers, dans toutes les saveurs', () => {
    for (const kind of ['review', 'code']) {
      const r = pol.argvPermissions({ backend: 'claude', bin: MODERNE, extra: [], kind });
      const interdits = r.args[r.args.indexOf('--disallowedTools') + 1];
      assert.match(interdits, /Read\(\/\/[^)]*reviewer\.db\*\)/, `${kind} : ${interdits}`);
      assert.match(interdits, /Read\(\/\/[^)]*\.env\)/, kind);
    }
  });

  test('un profil qui porte sa liste : le mode large est retiré, sans quoi la liste ne vaut rien', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: MODERNE, extra: YOLO, kind: 'code', profil: true });
    assert.deepEqual(r.extra, ['--verbose']);
  });

  test('copilot : aucune restriction possible — et on le dit plutôt que de le laisser croire', () => {
    const r = pol.argvPermissions({ backend: 'copilot', bin: 'copilot', extra: ['--yolo'], kind: 'review' });
    assert.deepEqual(r.extra, ['--yolo']);
    assert.equal(r.note, 'copilot-lecture-non-restreinte');
  });
});

describe('agentpolicy : l’environnement de l’agent est une liste blanche', () => {
  const source = {
    PATH: '/bin', HOME: '/h', LANG: 'fr_FR.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://p', JAVA_HOME: '/jdk',
    ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_CODE_USE_BEDROCK: '1', GH_TOKEN: 'ghp', COPILOT_GITHUB_TOKEN: 'ghp2',
    GITLAB_TOKEN: 'glpat', JIRA_TOKEN: 'j', MERGERIE_ACCESS_TOKEN: 'm', DATABASE_URL: 'pg://', COPILOT_ARGS: '--yolo',
  };
  test('claude : ce qu’il lui faut, rien du .env de Mergerie', () => {
    const e = pol.envAgent('claude', source);
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'JAVA_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']) assert.ok(k in e, k);
    for (const k of ['GITLAB_TOKEN', 'JIRA_TOKEN', 'MERGERIE_ACCESS_TOKEN', 'DATABASE_URL', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN']) assert.equal(e[k], undefined, k);
  });
  test('copilot : son jeton GitHub, pas celui d’Anthropic', () => {
    const e = pol.envAgent('copilot', source);
    assert.equal(e.GH_TOKEN, 'ghp');
    assert.equal(e.COPILOT_GITHUB_TOKEN, 'ghp2');
    assert.equal(e.COPILOT_ARGS, undefined);
    assert.equal(e.ANTHROPIC_API_KEY, undefined);
  });
  test('MERGERIE_AGENT_ENV ajoute ce que l’utilisateur choisit de donner', () => {
    const e = pol.envAgent('claude', { ...source, MERGERIE_AGENT_ENV: 'DATABASE_URL' });
    assert.equal(e.DATABASE_URL, 'pg://');
  });
});
