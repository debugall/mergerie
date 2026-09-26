'use strict';
/* LES BACKENDS D'AGENT, DERRIÈRE UNE SEULE PORTE (ameliorations_proposal.md, §3).
 *
 * Deux CLI étaient câblés en dur ; un troisième était « unknown », refusé ou lancé sans
 * politique. Le registre `agent/backends/` dit pour chacun comment se borne sa lecture et son
 * écriture, s'il reprend une session, et son NIVEAU de garantie — et la sonde ne bloque plus
 * personne. On éprouve ici, contre de faux binaires dont `--version` et `--help` disent ce
 * qu'on veut : la détection (réponse, nom, choix explicite), l'argv de codex et gemini écrit
 * d'après leur documentation, le générique, les niveaux, et le drapeau de modèle d'un profil. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backends-'));
const pol = require('../src/agent/policy');
const backends = require('../src/agent/backends');
const agentargs = require('../src/agent/args');
const { updateConfig } = require('../src/data/config');

const skip = process.platform === 'win32' ? 'faux binaire sh' : false;
const faux = (nom, version, aide = '') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `faux-${nom}-`));
  const bin = path.join(d, nom);
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' "${version}"; exit 0; fi\ncat <<'X'\n${aide}\nX\n`, { mode: 0o755 });
  return bin;
};

describe('backends : la détection', { skip }, () => {
  beforeEach(() => { pol.oublierBackend(); pol.oublierCapacites(); delete process.env.AGENT_BACKEND; updateConfig({ agent_backend: 'auto' }); });
  after(() => { delete process.env.AGENT_BACKEND; });

  test('--version l’emporte sur le nom : un wrapper neutre qui répond « codex » est codex', () => {
    assert.equal(pol.backendDe(faux('runPrompt', 'codex-cli 0.50.0')), 'codex');
    pol.oublierBackend();
    assert.equal(pol.backendDe(faux('lanceur', 'Gemini CLI 0.9.1')), 'gemini');
  });
  test('un --version muet : le nom du binaire, sinon unknown', () => {
    assert.equal(pol.backendDe(faux('gemini-cli', '')), 'gemini');
    pol.oublierBackend();
    assert.equal(pol.backendDe(faux('mon-agent', '')), 'unknown');
  });
  test('le choix explicite des Réglages (puis AGENT_BACKEND) l’emporte sur tout', () => {
    const bin = faux('claude', 'Claude Code 2.1');
    updateConfig({ agent_backend: 'codex' });
    assert.equal(pol.backendDe(bin), 'codex', 'agent_backend=codex : c’est codex, quoi que réponde le binaire');
    pol.oublierBackend();
    updateConfig({ agent_backend: 'auto' });
    process.env.AGENT_BACKEND = 'gemini';
    assert.equal(pol.backendDe(bin), 'gemini');
    pol.oublierBackend();
    process.env.AGENT_BACKEND = 'n-importe-quoi';
    assert.equal(pol.backendDe(bin), 'claude', 'une valeur inconnue est ignorée : la détection reprend');
  });
  test('un réglage agent_backend hors liste retombe sur auto', () => {
    const c = updateConfig({ agent_backend: 'plop' });
    assert.equal(c.agent_backend, 'auto');
  });
});

describe('backends : codex, gemini et le générique — argv d’après leur documentation', { skip }, () => {
  beforeEach(() => { pol.oublierBackend(); pol.oublierCapacites(); });

  test('codex : lecture = sandbox read-only, écriture = workspace-write + full-auto, mode large retiré', () => {
    const bin = faux('codex', 'codex-cli 0.50', '--sandbox <mode>\n--full-auto\n--skip-git-repo-check\n-C, --cd <dir>');
    const l = pol.argvPermissions({ backend: 'codex', bin, extra: ['--dangerously-bypass-approvals-and-sandbox', '-v'], kind: 'review', cwd: '/tmp/x' });
    assert.deepEqual(l.extra, ['-v'], 'le mode large de codex est retiré, le reste passe');
    assert.deepEqual(l.args, ['--sandbox', 'read-only', '--skip-git-repo-check', '-C', '/tmp/x']);
    assert.equal(l.lecture, true);
    const e = pol.argvPermissions({ backend: 'codex', bin, extra: [], kind: 'code', cwd: '/tmp/x' });
    assert.deepEqual(e.args, ['--sandbox', 'workspace-write', '--skip-git-repo-check', '--full-auto', '-C', '/tmp/x']);
    assert.equal(e.lecture, false);
    assert.deepEqual(backends.pour('codex').promptArgs('salut'), ['exec', 'salut'], 'le prompt est positionnel, après `exec`');
    assert.equal(pol.sortieSurStdout('review', bin), true, 'en lecture, codex ne peut pas écrire son fichier : la réponse tient lieu');
  });
  test('gemini : approval-mode default en lecture, auto_edit en écriture, --yolo/-y retirés', () => {
    const bin = faux('gemini', 'Gemini CLI 0.9', '--approval-mode <mode>\n-y, --yolo');
    const l = pol.argvPermissions({ backend: 'gemini', bin, extra: ['-y', '--yolo', '--debug'], kind: 'explore' });
    assert.deepEqual(l.extra, ['--debug']);
    assert.deepEqual(l.args, ['--approval-mode', 'default']);
    const e = pol.argvPermissions({ backend: 'gemini', bin, extra: ['--approval-mode', 'yolo'], kind: 'code' });
    assert.deepEqual(e.extra, [], 'un --approval-mode venu de AGENT_ARGS est retiré : c’est la politique qui le pose');
    assert.deepEqual(e.args, ['--approval-mode', 'auto_edit']);
  });
  test('un CLI sans rien : lancé tel quel, note « non restreint », niveau allégé — jamais refusé', () => {
    const bin = faux('mon-agent', '');
    const r = pol.argvPermissions({ backend: 'unknown', bin, extra: ['--yolo', '--x'], kind: 'review' });
    assert.deepEqual(r.extra, ['--x']);
    assert.deepEqual(r.args, []);
    assert.equal(r.note, 'backend-non-restreint');
    assert.equal(r.mode, 'allege');
    assert.equal(pol.niveauDe(bin), 'allege');
  });
  test('le drapeau de modèle d’un profil suit le backend : --model chez copilot, -m chez codex et gemini', () => {
    assert.deepEqual(agentargs.argsFor('copilot', { model: 'gpt-5' }).args, ['--model', 'gpt-5']);
    assert.deepEqual(agentargs.argsFor('codex', { model: 'o4-mini', maxTurns: 3 }).args, ['-m', 'o4-mini']);
    assert.deepEqual(agentargs.argsFor('gemini', { model: 'gemini-2.5-pro' }).args, ['-m', 'gemini-2.5-pro']);
    assert.ok(agentargs.argsFor('codex', { maxTurns: 3 }).ignored.includes('--max-turns'), 'ce qui est propre à claude est dit ignoré');
  });
});

describe('backends : le niveau de garantie', { skip }, () => {
  beforeEach(() => { pol.oublierBackend(); pol.oublierCapacites(); updateConfig({ agent_write_mode: 'sandbox' }); });
  test('claude : déclaré tant que le sandbox n’est pas prouvé, prouvé ensuite', () => {
    const bin = faux('claude', 'Claude Code 2.1', '--restricted\n--settings <json>');
    const db = require('../src/db');
    db.prepare('UPDATE local_config SET agent_sandbox_verified = 0 WHERE id = 1').run();
    assert.equal(pol.niveauDe(bin), 'declare');
    db.prepare('UPDATE local_config SET agent_sandbox_verified = 1 WHERE id = 1').run();
    assert.equal(pol.niveauDe(bin), 'prouve');
    db.prepare('UPDATE local_config SET agent_sandbox_verified = 0 WHERE id = 1').run();
  });
  test('copilot : déclaré avec --deny-tool, allégé sans', () => {
    assert.equal(pol.niveauDe(faux('copilot', 'GitHub Copilot CLI 1.0', '--deny-tool <t>')), 'declare');
    pol.oublierBackend(); pol.oublierCapacites();
    assert.equal(pol.niveauDe(faux('copilot', 'GitHub Copilot CLI 1.0', '')), 'allege');
  });
  test('codex et gemini : déclarés par leur sandbox / approval-mode natifs, jamais prouvés', () => {
    assert.equal(pol.niveauDe(faux('codex', 'codex-cli 0.5', '--sandbox <m>')), 'declare');
    pol.oublierBackend(); pol.oublierCapacites();
    assert.equal(pol.niveauDe(faux('gemini', 'Gemini CLI 0.9', '--approval-mode <m>')), 'declare');
    assert.equal(backends.pour('codex').resume, false, 'pas de reprise câblée : chaque passe repart à froid');
  });
  test('l’environnement d’un backend porte ses propres variables, pas celles des autres', () => {
    const src = { PATH: '/bin', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', MERGERIE_ACCESS_TOKEN: 'x' };
    const codex = pol.envAgent('codex', src);
    assert.equal(codex.OPENAI_API_KEY, 'o'); assert.equal(codex.ANTHROPIC_API_KEY, undefined); assert.equal(codex.MERGERIE_ACCESS_TOKEN, undefined);
    const gemini = pol.envAgent('gemini', src);
    assert.equal(gemini.GEMINI_API_KEY, 'g'); assert.equal(gemini.OPENAI_API_KEY, undefined);
    const inconnu = pol.envAgent('unknown', src);
    assert.equal(inconnu.OPENAI_API_KEY, 'o'); assert.equal(inconnu.ANTHROPIC_API_KEY, 'a', 'un CLI inconnu reçoit les variables de tous les fournisseurs, jamais celles de Mergerie');
    assert.equal(inconnu.MERGERIE_ACCESS_TOKEN, undefined);
  });
});
