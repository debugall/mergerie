'use strict';
/* CE QU'UN AGENT A LE DROIT DE FAIRE, SELON CE QU'ON LUI DEMANDE — la ligne de commande produite.
 *
 * `COPILOT_ARGS=--dangerously-skip-permissions` partait sur TOUS les lancements : une review, qui
 * lit la description d'une MR écrite par n'importe qui, tournait avec le droit de tout écrire et
 * tout lancer. Le lot A (plan_secure.md) retire le mode large aussi de l'ÉCRITURE : sandbox du
 * CLI (vérifié), à défaut liste blanche de commandes — jamais `--dangerously-skip-permissions`
 * sauf réglage explicite `agent_write_mode=large`. On éprouve ici l'argv que produit chaque
 * saveur, contre un faux binaire dont le `--help` annonce (ou non) chaque option — le vrai CLI a
 * été sondé à la main (cf. agent/policy.js).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
// `interditsDonnees`/`sandboxSettings`/`allowlistEcriture` lisent `paths`/`db` : jamais sans
// dossier de données isolé (CLAUDE.md).
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpolicy-'));
const pol = require('../src/agent/policy');
const { updateConfig } = require('../src/data/config');
const db = require('../src/db');
const approbation = require('../src/data/approbation');

const fauxAide = (nom, aide) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `faux-${nom}-`));
  const bin = path.join(d, nom);
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${nom === 'claude' ? 'Claude Code' : 'GitHub Copilot CLI'} 1.0"; exit 0; fi\ncat <<'X'\n${aide}\nX\n`, { mode: 0o755 });
  return bin;
};
// Un CLI qui connaît TOUT ce que policy.js sait sonder.
const COMPLET = fauxAide('claude', [
  '--restricted  Restricted mode', '--setting-sources <s>', '--strict-mcp-config', '--bare',
  '--permission-prompts <mode>', '--settings <json>',
].join('\n'));
const ANCIEN = fauxAide('claude', '--setting-sources <s>');
const YOLO = ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--verbose'];

describe('agentpolicy : les saveurs de lecture perdent le mode large', { skip: process.platform === 'win32' ? 'faux binaire sh' : false }, () => {
  beforeEach(() => pol.oublierCapacites());

  for (const kind of ['review', 'explain', 'question', 'modify', 'explore']) {
    test(`${kind} : ni skip-permissions ni bypass, et un mode restreint`, () => {
      const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: YOLO, kind });
      const argv = [...r.extra, ...r.args];
      assert.equal(argv.includes('--dangerously-skip-permissions'), false, argv.join(' '));
      assert.equal(argv.includes('bypassPermissions'), false, argv.join(' '));
      assert.ok(argv.includes('--restricted'), argv.join(' '));
      assert.ok(argv.includes('--verbose'), 'ce qui n’élargit rien reste');
      assert.equal(r.lecture, true);
      assert.equal(r.mode, 'lecture');
    });
  }

  for (const kind of ['ask', 'test']) {
    test(`${kind} : --bare quand le CLI le connaît — aucun réglage du dépôt`, () => {
      const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind });
      assert.ok(r.args.includes('--bare'), r.args.join(' '));
      assert.equal(r.mode, 'bare');
    });
  }

  test('un CLI sans --restricted : liste de lecture, écriture interdite, réglages du dépôt ignorés', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: ANCIEN, extra: YOLO, kind: 'review' });
    const a = r.args;
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'default');
    assert.match(a[a.indexOf('--allowedTools') + 1], /^Read,Glob,Grep,Bash\(git log:\*\)/);
    assert.match(a[a.indexOf('--disallowedTools') + 1], /Write.*Edit.*WebFetch/);
    assert.ok(a.includes('--setting-sources'), 'pas le .claude/ de l’auteur de la MR');
    assert.equal(r.extra.includes('--dangerously-skip-permissions'), false);
  });

  test('les projets liés d’une review restent lisibles (--add-dir)', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'review', addDirs: ['/clones/lib'] });
    assert.deepEqual(r.args.slice(-2), ['--add-dir', '/clones/lib']);
  });

  test('un profil de lecture RÉTRÉCIT la liste, il ne l’élargit jamais (S3)', () => {
    // Un profil qui ne demande que Read : la liste de lecture se réduit à Read.
    const r = pol.argvPermissions({ backend: 'claude', bin: ANCIEN, extra: [], kind: 'explore', allowedToolsProfil: ['Read'] });
    assert.equal(r.args[r.args.indexOf('--allowedTools') + 1], 'Read');
    // Un profil qui demande un outil hors de la liste de lecture (Bash tout court, jamais
    // accordé en lecture) : intersection vide → la liste de lecture reste intacte, jamais
    // élargie et jamais réduite à rien.
    const r2 = pol.argvPermissions({ backend: 'claude', bin: ANCIEN, extra: [], kind: 'explore', allowedToolsProfil: ['Bash'] });
    assert.match(r2.args[r2.args.indexOf('--allowedTools') + 1], /^Read,Glob,Grep/);
  });

  test('saveur inconnue : lecture, jamais écriture (fail-closed, point 8)', () => {
    assert.equal(pol.saveurDe('n-importe-quoi'), 'lecture');
    assert.equal(pol.saveurDe(undefined), 'lecture');
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: YOLO, kind: 'un-kind-jamais-vu' });
    assert.equal(r.lecture, true);
    assert.equal(r.args.includes('--dangerously-skip-permissions'), false);
  });
});

describe('agentpolicy : le backend se lit au binaire, pas seulement à son nom (S7)', () => {
  beforeEach(() => pol.oublierBackend());

  test('--version « Claude Code » l’emporte sur un nom neutre', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faux-wrapper-'));
    const bin = path.join(d, 'runPrompt');
    fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Claude Code 2.1.0"; exit 0; fi\n', { mode: 0o755 });
    assert.equal(pol.backendDe(bin), 'claude');
  });

  test('binaire absent ou --version muet : repli sur le nom, sinon unknown', () => {
    assert.equal(pol.backendDe('/chemin/inexistant/claude'), 'claude', 'repli sur le nom');
    assert.equal(pol.backendDe('/chemin/inexistant/mystere'), 'unknown');
  });
});

describe('agentpolicy : écriture — plus jamais de mode large sans réglage explicite (lot A)', () => {
  beforeEach(() => {
    pol.oublierCapacites();
    updateConfig({ agent_write_mode: 'sandbox', agent_write_allow: '', agent_sandbox_network_domains: '' });
    db.prepare("UPDATE local_config SET agent_sandbox_verified = 0, agent_sandbox_tested_at = '', agent_sandbox_detail = '' WHERE id = 1").run();
  });

  for (const kind of ['code', 'fix', 'converge', 'local', 'task', 'rebase']) {
    test(`${kind} : le mode large de COPILOT_ARGS est toujours retiré`, () => {
      const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: YOLO, kind });
      assert.equal(r.lecture, false);
      assert.equal(r.extra.includes('--dangerously-skip-permissions'), false, r.extra.join(' '));
      assert.equal([...r.extra, ...r.args].includes('bypassPermissions'), false);
      assert.ok(r.extra.includes('--verbose'), 'ce qui n’élargit rien reste');
    });
  }

  test('sandbox NON vérifié (défaut) : repli en liste blanche, jamais le mode large', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code' });
    assert.equal(r.mode, 'allowlist');
    assert.equal(r.sandboxDemandeNonVerifie, true);
    assert.ok(r.args.includes('acceptEdits'), r.args.join(' '));
    assert.equal(r.args.includes('--settings'), false);
    const outils = r.args[r.args.indexOf('--allowedTools') + 1];
    assert.match(outils, /\bRead\b/);
    assert.match(outils, /Bash\(git status:\*\)/);
    assert.equal(/Bash\(git push/.test(outils), false, 'push n’entre jamais dans la liste blanche');
  });

  test('sandbox VÉRIFIÉ : --settings sandboxé, réseau et système de fichiers bornés', () => {
    db.prepare("UPDATE local_config SET agent_sandbox_verified = 1 WHERE id = 1").run();
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code', cwd: '/le/dossier' });
    assert.equal(r.mode, 'sandbox');
    const brut = r.args[r.args.indexOf('--settings') + 1];
    const cfg = JSON.parse(brut);
    assert.equal(cfg.sandbox.enabled, true);
    assert.ok(cfg.sandbox.filesystem.allowWrite.includes('/le/dossier'));
    assert.match(cfg.sandbox.filesystem.denyRead.join('|'), /reviewer\.db|local-token/);
    assert.equal(cfg.sandbox.network.allowLocalBinding, false);
    assert.equal(r.args[r.args.indexOf('--allowedTools') + 1], 'Read,Edit,Write,MultiEdit,Glob,Grep,Bash');
  });

  test('agent_write_mode=large : mode large intact, réglage assumé — jamais le défaut', () => {
    updateConfig({ agent_write_mode: 'large' });
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: YOLO, kind: 'code' });
    assert.equal(r.mode, 'large');
    assert.deepEqual(r.extra, YOLO, 'le réglage assumé rend l’ancien comportement, tel quel');
  });

  test('agent_write_mode=allowlist explicite : liste blanche sans sandbox, sandboxDemandeNonVerifie faux', () => {
    updateConfig({ agent_write_mode: 'allowlist' });
    db.prepare("UPDATE local_config SET agent_sandbox_verified = 1 WHERE id = 1").run();
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code' });
    assert.equal(r.mode, 'allowlist');
    assert.equal(r.sandboxDemandeNonVerifie, false);
  });

  test('les commandes des vérificateurs APPROUVÉS entrent dans la liste blanche', () => {
    const now = new Date().toISOString();
    const vid = db.prepare("INSERT INTO verifier (name, command, timeout_s, run_base, comment_on_forge, created_at) VALUES ('t', '', 60, 0, 0, ?)").run(now).lastInsertRowid;
    db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(vid, 'npm test');
    approbation.approuverVerificateur(vid);
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code' });
    const outils = r.args[r.args.indexOf('--allowedTools') + 1];
    assert.match(outils, /Bash\(npm:\*\)/, outils);
  });

  test('agent_write_allow ajoute des commandes explicites à la liste blanche', () => {
    updateConfig({ agent_write_allow: 'make, Bash(mvn:*)' });
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code' });
    const outils = r.args[r.args.indexOf('--allowedTools') + 1];
    assert.match(outils, /Bash\(make\)/);
    assert.match(outils, /Bash\(mvn:\*\)/);
  });

  test('la base et le .env sont fermés aux outils de fichiers, dans toutes les saveurs', () => {
    for (const kind of ['review', 'code']) {
      const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind });
      const interdits = r.args[r.args.indexOf('--disallowedTools') + 1];
      assert.match(interdits, /Read\(\/\/[^)]*reviewer\.db\*\)/, `${kind} : ${interdits}`);
      assert.match(interdits, /Read\(\/\/[^)]*\.env\)/, kind);
      assert.match(interdits, /Read\(\/\/[^)]*local-token\)/, kind);
    }
  });

  test('un profil qui porte sa liste : le mode large est retiré, sans quoi la liste ne vaut rien', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: YOLO, kind: 'code', profil: true });
    assert.deepEqual(r.extra, ['--verbose']);
    assert.equal(r.mode, 'profil');
  });
});

describe('agentpolicy : copilot', () => {
  beforeEach(() => {
    pol.oublierCapacites();
    updateConfig({ agent_read_unrestricted: '0' });
  });

  test('écriture, sans --deny-tool connu : aucune restriction possible — et on le dit', () => {
    const r = pol.argvPermissions({ backend: 'copilot', bin: '/inexistant/copilot', extra: ['--yolo'], kind: 'code' });
    assert.deepEqual(r.extra, ['--yolo']);
    assert.equal(r.note, 'copilot-ecriture-non-restreinte');
  });

  test('écriture, avec --deny-tool connu : git push/curl/wget retirés', () => {
    const avecDenyTool = fauxAide('copilot', '--deny-tool <t>\n--allow-tool <t>');
    const r = pol.argvPermissions({ backend: 'copilot', bin: avecDenyTool, extra: ['--yolo'], kind: 'code' });
    assert.deepEqual(r.extra, ['--yolo']);
    assert.ok(r.args.includes('shell(git push*)'), r.args.join(' '));
  });

  test('lecture, sans --deny-tool connu : REFUSÉE, sauf agent_read_unrestricted=1', () => {
    assert.throws(() => pol.argvPermissions({ backend: 'copilot', bin: '/inexistant/copilot', extra: [], kind: 'review' }),
      /COPILOT_UNRESTRICTED|restrein/i);
    updateConfig({ agent_read_unrestricted: '1' });
    const r = pol.argvPermissions({ backend: 'copilot', bin: '/inexistant/copilot', extra: ['--yolo'], kind: 'review' });
    assert.deepEqual(r.extra, ['--yolo']);
    assert.equal(r.note, 'copilot-lecture-non-restreinte');
  });

  test('lecture, avec --deny-tool connu : write et shell refusés, pas d’exception', () => {
    const avecDenyTool = fauxAide('copilot', '--deny-tool <t>\n--allow-tool <t>');
    const r = pol.argvPermissions({ backend: 'copilot', bin: avecDenyTool, extra: [], kind: 'review' });
    assert.deepEqual(r.args, ['--deny-tool', 'write', '--deny-tool', 'shell(*)']);
    assert.equal(r.note, null);
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
