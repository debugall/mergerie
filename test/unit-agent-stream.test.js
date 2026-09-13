'use strict';
/* Ce que Mergerie sait LIRE du flux d'événements de `claude`, et ce qu'il lui ENVOIE.
 *
 * Deux questions se posaient à chaque run et n'avaient aucune réponse dans le journal :
 * « l'agent a-t-il vraiment utilisé le skill ? » et « qu'est-ce que ça a coûté ? ». Une
 * troisième arrive avec les sous-agents : « qui parle ? ». Le flux répond aux trois — encore
 * faut-il le prouver, et le mode dry-run le court-circuite. On rejoue donc un vrai flux
 * NDJSON avec un faux binaire, et on lit le journal produit.
 *
 * Un `startApp()` serait inutile ici : rien de tout cela ne passe par le serveur. */

const { test, describe, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creerFauxClaude } = require('./helpers/fake-claude');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stream-'));
const FLUX = [
  { type: 'system', subtype: 'init', session_id: 'sess-1' },
  { type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'Je commence.' }] } },
  { type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'revue-de-code' } }] } },
  { type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'chercheur', prompt: 'Cherche les notifications dans ce dépôt' } }] } },
  { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'Je regarde src/notify.js' }] } },
  { type: 'assistant', session_id: 'sess-1', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'notify' } }] } },
  { type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } }] } },
  {
    type: 'result', subtype: 'success', session_id: 'sess-1', result: 'Rapport final.',
    total_cost_usd: 0.4213, num_turns: 7,
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, { tool_name: 'Write' }],
  },
];
const faux = creerFauxClaude(tmp, { events: FLUX });

process.env.MERGERIE_DATA_DIR = tmp;
process.env.COPILOT_BIN = faux.bin;
delete process.env.COPILOT_ARGS;

// Après les variables d'environnement : copilot.js fige COPILOT_BIN au chargement.
// eslint-disable-next-line import/order
const agentsession = require('../src/agentsession');
// eslint-disable-next-line import/order
const agentpass = require('../src/agentpass');
// eslint-disable-next-line import/order
const copilot = require('../src/copilot');
// eslint-disable-next-line import/order
const db = require('../src/db');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

let journal = [];
let sortie = null;
const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));

before(async () => {
  assert.equal(agentsession.backendName(), 'claude', 'préalable : on emprunte bien le chemin claude');
  sortie = await agentsession.runInSession({
    key: 'test-stream', prompt: 'peu importe', cwd, resume: false,
    onLog: (l) => journal.push(l),
    options: {
      model: 'opus', appendSystemPrompt: 'Tu es l’enquêteur.', permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Grep'], maxTurns: 60,
      agents: { chercheur: { description: 'd', prompt: 'p' } },
    },
  });
});

describe('flux d’agent : ce qu’on envoie', () => {
  test('les options du profil sont sur la ligne de commande, avant --session-id', () => {
    const argv = faux.argv();
    const iModele = argv.indexOf('--model');
    const iSession = argv.indexOf('--session-id');
    assert.ok(iModele >= 0 && iSession > iModele, `attendu --model avant --session-id : ${argv.join(' ')}`);
    assert.equal(argv[iModele + 1], 'opus');
    assert.ok(argv.includes('--append-system-prompt'));
    assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Grep');
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '60');
    assert.ok(argv.includes('--agents'));
    // Ce que le CLI exige en -p, et que le profil ne doit pas déloger.
    assert.ok(argv.includes('--output-format') && argv.includes('--verbose') && argv.includes('-p'));
  });

  test('sans options, l’argv ne porte aucun argument de profil', async () => {
    const cwd2 = fs.mkdtempSync(path.join(tmp, 'work2-'));
    await agentsession.runInSession({ key: 'test-nu', prompt: 'x', cwd: cwd2, resume: false, onLog: () => {} });
    const argv = faux.argv();
    for (const a of ['--model', '--append-system-prompt', '--permission-mode', '--allowedTools',
      '--disallowedTools', '--max-turns', '--agents', '--add-dir']) {
      assert.ok(!argv.includes(a), `argument de profil inattendu : ${a}`);
    }
  });
});

describe('flux d’agent : ce qu’on lit', () => {
  test('un appel de skill est journalisé par son nom', () => {
    assert.ok(journal.includes('» skill revue-de-code'),
      `attendu « » skill revue-de-code », journal :\n${journal.join('\n')}`);
  });

  test('un appel de sous-agent dit lequel et sur quoi', () => {
    const l = journal.find((x) => x.startsWith('» sous-agent'));
    assert.ok(l, 'aucune ligne de sous-agent');
    assert.ok(l.includes('chercheur'));
    assert.ok(l.includes('Cherche les notifications'));
  });

  test('ce qui vient d’un sous-agent est indenté — on sait qui parle', () => {
    assert.ok(journal.includes('  Je regarde src/notify.js'), journal.join('\n'));
    assert.ok(journal.includes('  » Grep /notify/'), journal.join('\n'));
    // Et ce qui vient de l'agent principal ne l'est pas.
    assert.ok(journal.includes('Je commence.'));
    assert.ok(journal.includes('» Read src/app.js'));
  });

  test('les actions refusées par les permissions sont dites, avec la première nommée', () => {
    const l = journal.find((x) => /refus/i.test(x));
    assert.ok(l, `aucune ligne de refus :\n${journal.join('\n')}`);
    assert.ok(l.includes('2'), l);
    assert.ok(l.includes('Bash'), l);
  });

  test('le coût et les refus remontent avec le résultat', () => {
    assert.equal(sortie.text, 'Rapport final.');
    assert.equal(sortie.costUsd, 0.4213);
    assert.equal(sortie.denials.length, 2);
    assert.equal(sortie.handle, 'sess-1');
  });
});

describe('flux d’agent : où le coût est rangé', () => {
  test('une passe enregistre le coût annoncé', () => {
    agentpass.record('task', 4242, 1, { kind: 'run', prompt: 'p', text: 'sortie', costUsd: sortie.costUsd });
    const p = agentpass.get('task', 4242, 1, 1);
    assert.equal(p.cost_usd, 0.4213);
  });

  test('une passe sans coût annoncé le laisse nul, sans échouer', () => {
    // C'est le cas de tout backend muet : la colonne doit supporter l'absence.
    agentpass.record('task', 4243, 1, { kind: 'run', prompt: 'p', text: 'sortie' });
    assert.equal(agentpass.get('task', 4243, 1, 1).cost_usd, null);
  });

  test('la ligne d’usage porte le coût à côté de l’estimation en tokens', () => {
    copilot.recordUsage('task', 'prompt', 'sortie', null, { kind: 'task', id: 4242 }, sortie.costUsd);
    const u = db.prepare("SELECT tokens_est, cost_usd FROM usage WHERE owner_kind = 'task' AND owner_id = 4242").get();
    assert.equal(u.cost_usd, 0.4213);
    assert.ok(u.tokens_est > 0, 'l’estimation en tokens reste calculée');
  });

  test('la commande de reprise à copier porte les options du profil', () => {
    const cmd = agentsession.resumeCommand('claude', 'sess-1', '/tmp/x', { model: 'opus', maxTurns: 60 });
    assert.ok(cmd.includes('--model opus'), cmd);
    assert.ok(cmd.includes('--resume sess-1'), cmd);
    // Sans options, la commande reste celle d'avant.
    assert.ok(!agentsession.resumeCommand('claude', 'sess-1', '/tmp/x').includes('--model'));
  });
});
