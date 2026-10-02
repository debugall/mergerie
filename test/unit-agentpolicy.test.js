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
updateConfig({ agent_mode: 'secure' });   // ce que ce fichier éprouve n'existe qu'en mode sécurisé (le défaut est yolo)

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

  /* Revue de add-secure-layer-2 : la commande approuvée entre EXACTE, jamais en `prog:*` — sinon
     approuver « npm test » autoriserait aussi « npm publish » ou « node -e "…" » selon le
     programme, un shell complet en mode allowlist. */
  test('les commandes des vérificateurs APPROUVÉS entrent dans la liste blanche, EXACTES', () => {
    const now = new Date().toISOString();
    const vid = db.prepare("INSERT INTO verifier (name, command, timeout_s, run_base, comment_on_forge, created_at) VALUES ('t', '', 60, 0, 0, ?)").run(now).lastInsertRowid;
    db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(vid, 'npm test');
    approbation.approuverVerificateur(vid);
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code' });
    const outils = r.args[r.args.indexOf('--allowedTools') + 1];
    assert.match(outils, /Bash\(npm test\)/, outils);
    assert.equal(/Bash\(npm:\*\)/.test(outils), false, 'un programme entier autorisé, pas juste sa commande, serait trop large');
  });

  test('un interpréteur approuvé (node, bash…) n’ouvre que SA commande, jamais tout le programme', () => {
    const now = new Date().toISOString();
    const vid = db.prepare("INSERT INTO verifier (name, command, timeout_s, run_base, comment_on_forge, created_at) VALUES ('t2', '', 60, 0, 0, ?)").run(now).lastInsertRowid;
    db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(vid, 'node scripts/test.js');
    approbation.approuverVerificateur(vid);
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code' });
    const outils = r.args[r.args.indexOf('--allowedTools') + 1];
    assert.match(outils, /Bash\(node scripts\/test\.js\)/, outils);
    assert.equal(/Bash\(node:\*\)/.test(outils), false, '« node -e » ne doit pas être ouvert par la commande approuvée');
  });

  test('agent_write_allow ajoute des commandes explicites à la liste blanche', () => {
    updateConfig({ agent_write_allow: 'make, Bash(mvn:*)' });
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code' });
    const outils = r.args[r.args.indexOf('--allowedTools') + 1];
    assert.match(outils, /Bash\(make\)/);
    assert.match(outils, /Bash\(mvn:\*\)/);
  });

  /* Revue de add-secure-layer-2 : les nonces de protocole (`protocol.nonceAgentRun`,
     `taskrunner.nonceQuestionsTache`) sont un HMAC gardé par ce secret — un agent qui le lirait
     pourrait forger n'importe quel bloc `<<<AGENT…>>>` pour n'importe quel id. */
  test('le secret des nonces de protocole est fermé à l’agent, comme le jeton local', () => {
    const protocolesecret = require('../src/core/protocolesecret');
    for (const kind of ['review', 'code']) {
      const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind });
      const interdits = r.args[r.args.indexOf('--disallowedTools') + 1];
      assert.match(interdits, /Read\(\/\/[^)]*protocol-secret\)/, `${kind} : ${interdits}`);
    }
    db.prepare("UPDATE local_config SET agent_sandbox_verified = 1 WHERE id = 1").run();
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: [], kind: 'code', cwd: '/le/dossier' });
    const cfg = JSON.parse(r.args[r.args.indexOf('--settings') + 1]);
    assert.ok(cfg.sandbox.filesystem.denyRead.includes(protocolesecret.FICHIER));
  });

  test('le nonce d’un agent n’est pas un simple hachage de son id : sans le secret, on ne le retrouve pas', () => {
    const protocol = require('../src/agent/protocol');
    const crypto = require('node:crypto');
    const naif = crypto.createHash('sha256').update('protocol-agent-1').digest('hex').slice(0, 12);
    assert.notEqual(protocol.nonceAgentRun(1), naif, 'un hachage sans secret se précalculerait pour tout id plausible');
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
    const r = pol.argvPermissions({ backend: 'copilot', bin: '/inexistant/copilot', extra: ['--verbose'], kind: 'code' });
    assert.deepEqual(r.extra, ['--verbose']);
    assert.equal(r.note, 'copilot-ecriture-non-restreinte');
  });

  test('écriture, avec --deny-tool connu : git push/curl/wget retirés', () => {
    const avecDenyTool = fauxAide('copilot', '--deny-tool <t>\n--allow-tool <t>');
    const r = pol.argvPermissions({ backend: 'copilot', bin: avecDenyTool, extra: ['--verbose'], kind: 'code' });
    assert.deepEqual(r.extra, ['--verbose']);
    assert.ok(r.args.includes('shell(git push*)'), r.args.join(' '));
  });

  /* SANS `--allow-tool`, COPILOT NE LANCE RIEN EN `-p` : « aucune approbation possible en mode non
     interactif ». Une session d'écriture ne pouvait ni écrire un fichier ni faire `git rebase` —
     la mise à jour d'une branche par l'IA échouait là où Claude recevait sa liste blanche. */
  test('écriture, avec --allow-tool connu : la même liste blanche que Claude, dans la grammaire de Copilot', () => {
    const avecAllowTool = fauxAide('copilot', '--deny-tool <t>\n--allow-tool <t>');
    const r = pol.argvPermissions({ backend: 'copilot', bin: avecAllowTool, extra: [], kind: 'code' });
    const admis = r.args.filter((a, i) => r.args[i - 1] === '--allow-tool');
    assert.ok(admis.includes('write'), 'les fichiers');
    for (const c of ['status', 'diff', 'add', 'commit', 'checkout', 'rebase', 'merge']) assert.ok(admis.includes(`shell(git ${c}*)`), `git ${c}`);
    assert.ok(!admis.some((a) => /push|curl|wget|remote|config/.test(a)), 'ce qui fuit n’est jamais admis');
    assert.ok(r.args.includes('shell(git push*)'), 'et reste refusé explicitement');
    // Sans --allow-tool dans l'aide, rien n'est ajouté : on ne promet pas un drapeau que le binaire ignore.
    const sansAllow = fauxAide('copilot', '--deny-tool <t>');
    assert.ok(!pol.argvPermissions({ backend: 'copilot', bin: sansAllow, extra: [], kind: 'code' }).args.includes('--allow-tool'));
  });

  test('la liste blanche de Claude admet aussi git rebase et git merge (mise à jour d’une branche)', () => {
    const l = pol.allowlistEcriture();
    assert.ok(l.includes('Bash(git rebase:*)') && l.includes('Bash(git merge:*)'), l.join(' '));
    assert.ok(!l.some((x) => /git push|git remote|git config/.test(x)));
  });

  /* La sonde ne bloque plus aucun CLI : une lecture sur un Copilot sans `--deny-tool` part au
     niveau « allégé », dite telle au journal — le contrôle d'intégrité après coup fait foi. Le
     mode large de COPILOT_ARGS, lui, reste retiré. */
  test('lecture, sans --deny-tool connu : niveau allégé, dit au journal — jamais refusée, jamais large', () => {
    const r = pol.argvPermissions({ backend: 'copilot', bin: '/inexistant/copilot', extra: ['--verbose', '--allow-all-tools'], kind: 'review' });
    assert.deepEqual(r.extra, ['--verbose']);
    assert.equal(r.note, 'copilot-lecture-non-restreinte');
    assert.equal(r.mode, 'allege');
    assert.equal(r.lecture, true);
  });

  test('lecture, avec --deny-tool connu : write et shell refusés, pas d’exception', () => {
    const avecDenyTool = fauxAide('copilot', '--deny-tool <t>\n--allow-tool <t>');
    const r = pol.argvPermissions({ backend: 'copilot', bin: avecDenyTool, extra: [], kind: 'review' });
    assert.deepEqual(r.args, ['--deny-tool', 'write', '--deny-tool', 'shell(*)']);
    assert.equal(r.note, null);
  });

  /* Le prompt et le lanceur doivent dire la même chose. Avec `--deny-tool write`, une
     exploration ne peut pas écrire son fichier : la consigne demande alors la réponse finale —
     comme pour claude, codex et gemini. La mise à jour de connaissance d'un agent de domaine
     sur Copilot recevait « écris UNIQUEMENT dans le fichier » et un lanceur qui refusait chaque
     écriture : réponse vide, et le journal pris pour la connaissance. */
  test('lecture : la réponse tient lieu de fichier dès que --deny-tool borne l’écriture, pas avant', () => {
    pol.oublierBackend();
    const avecDenyTool = fauxAide('copilot', '--deny-tool <t>\n--allow-tool <t>');
    assert.equal(pol.backendDe(avecDenyTool), 'copilot');
    assert.equal(pol.sortieSurStdout('explore', avecDenyTool), true, 'write refusé : rien à écrire, la réponse tient lieu');
    assert.equal(pol.sortieSurStdout('code', avecDenyTool), false, 'un codage écrit toujours');
    pol.oublierBackend(); pol.oublierCapacites();
    const sansDenyTool = fauxAide('copilot', '--verbose');
    assert.equal(pol.sortieSurStdout('explore', sansDenyTool), false, 'sans --deny-tool le fichier reste possible : l’agent l’écrit comme avant');
    pol.oublierBackend();
  });

  /* plan_secure.md, lot A, S4 : `--allow-all-tools` est l'équivalent Copilot du mode large —
     `LARGES` le connaît nommément. COPILOT_ARGS ne doit pas pouvoir le rouvrir alors que
     policy.js le ferme partout ailleurs. */
  test('--allow-all-tools dans COPILOT_ARGS est retiré, en lecture comme en écriture', () => {
    const ecriture = pol.argvPermissions({ backend: 'copilot', bin: '/inexistant/copilot', extra: ['--allow-all-tools'], kind: 'code' });
    assert.deepEqual(ecriture.extra, []);
    const lecture = pol.argvPermissions({ backend: 'copilot', bin: '/inexistant/copilot', extra: ['--allow-all-tools'], kind: 'review' });
    assert.deepEqual(lecture.extra, []);
  });
});

/* SÉCURISÉ OU YOLO (ameliorations_proposal.md, §5). En yolo — le DÉFAUT d'une installation —
   l'argv est rendu tel quel, toutes saveurs et tous backends : le mode large de AGENT_ARGS
   passe, aucun `--disallowedTools`, aucune sandbox, aucune liste blanche. L'environnement, lui,
   reste en liste blanche : c'est une limite du serveur, pas de l'agent. */
describe('agentpolicy : le mode yolo rend tout, le mode sécurisé retire — et yolo est le défaut', { skip: process.platform === 'win32' ? 'faux binaire sh' : false }, () => {
  beforeEach(() => pol.oublierCapacites());
  test('yolo : AGENT_ARGS intact, aucune option ajoutée, en lecture comme en écriture, sur chaque backend', () => {
    updateConfig({ agent_mode: 'yolo' });
    try {
      for (const backend of ['claude', 'copilot', 'codex', 'unknown']) {
        for (const kind of ['review', 'explore', 'code', 'local']) {
          const r = pol.argvPermissions({ backend, bin: COMPLET, extra: YOLO, kind, addDirs: ['/lie'] });
          assert.deepEqual(r.extra, YOLO, `${backend}/${kind} : les arguments passent tels quels`);
          assert.deepEqual(r.args, ['--add-dir', '/lie'], `${backend}/${kind} : rien d'ajouté hormis les dossiers liés`);
          assert.equal(r.mode, 'yolo');
          assert.equal(r.lecture, kind === 'review' || kind === 'explore');
        }
      }
      assert.equal(pol.sortieSurStdout('review', COMPLET), false, 'en yolo, l’agent écrit son fichier comme avant');
      assert.equal(pol.niveauDe(COMPLET), 'yolo');
      assert.equal(pol.modeSecurise(), false);
      const env = pol.envAgent('claude', { PATH: '/bin', MERGERIE_ACCESS_TOKEN: 'x', ANTHROPIC_API_KEY: 'a' });
      assert.equal(env.MERGERIE_ACCESS_TOKEN, undefined, 'l’environnement reste en liste blanche : limite du serveur, pas de l’agent');
    } finally { updateConfig({ agent_mode: 'secure' }); }
  });
  test('sécurisé : le mode large est retiré (le comportement de tout ce fichier)', () => {
    const r = pol.argvPermissions({ backend: 'claude', bin: COMPLET, extra: YOLO, kind: 'review' });
    assert.equal([...r.extra, ...r.args].includes('--dangerously-skip-permissions'), false);
    assert.equal(pol.modeSecurise(), true);
  });
  test('une valeur illisible retombe sur yolo — c’est le sens du réglage', () => {
    assert.equal(updateConfig({ agent_mode: 'plop' }).agent_mode, 'yolo');
    updateConfig({ agent_mode: 'secure' });
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
