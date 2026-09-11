'use strict';
/* Les options d'un profil d'agent deviennent des arguments de ligne de commande — et rien
   d'autre ne change.
 *
 * Le test qui compte vraiment est le premier : SANS options, l'argv doit être byte-identique
 * à celui d'avant les agents. Toutes les sessions existantes passent par ce chemin ; une
 * option ajoutée « par défaut » les changerait toutes en silence. */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const agentargs = require('../src/agentargs');

describe('agentargs : options → argv', () => {
  test('sans options, aucun argument — l’argv d’une session ordinaire ne bouge pas', () => {
    assert.deepEqual(agentargs.argsFor('claude', undefined), { args: [], ignored: [] });
    assert.deepEqual(agentargs.argsFor('claude', {}), { args: [], ignored: [] });
    assert.deepEqual(agentargs.argsFor('claude', { model: '', allowedTools: [], agents: {} }).args, []);
  });

  test('claude : toutes les options, dans l’ordre annoncé', () => {
    const { args, ignored } = agentargs.argsFor('claude', {
      model: 'opus',
      appendSystemPrompt: 'Tu es l’enquêteur.',
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Grep', 'Bash(git log *)'],
      disallowedTools: ['Write'],
      maxTurns: 60,
      agents: { chercheur: { description: 'd', prompt: 'p', tools: ['Read'], model: 'inherit' } },
      addDirs: ['/a', '/b'],
    });
    assert.deepEqual(ignored, []);
    assert.deepEqual(args, [
      '--model', 'opus',
      '--append-system-prompt', 'Tu es l’enquêteur.',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Grep,Bash(git log *)',
      '--disallowedTools', 'Write',
      '--max-turns', '60',
      '--agents', '{"chercheur":{"description":"d","prompt":"p","tools":["Read"]}}',
      '--add-dir', '/a',
      '--add-dir', '/b',
    ]);
  });

  test('« model: inherit » d’un sous-agent ne part pas sur la ligne de commande', () => {
    // C'est le défaut du CLI : le passer allonge un argv déjà long sans rien changer.
    const { args } = agentargs.argsFor('claude', { agents: { a: { description: 'd', prompt: 'p', model: 'inherit' } } });
    assert.ok(!args.join(' ').includes('inherit'));
    const { args: args2 } = agentargs.argsFor('claude', { agents: { a: { description: 'd', prompt: 'p', model: 'opus' } } });
    assert.ok(args2.join(' ').includes('"model":"opus"'));
  });

  test('jamais --system-prompt : seul --append-system-prompt existe', () => {
    // Remplacer le prompt système effacerait le CLAUDE.md du dépôt et ses skills.
    const { args } = agentargs.argsFor('claude', { appendSystemPrompt: 'x' });
    assert.ok(args.includes('--append-system-prompt'));
    assert.ok(!args.includes('--system-prompt'));
  });

  test('copilot : le modèle seul passe, le reste est annoncé comme ignoré', () => {
    const { args, ignored } = agentargs.argsFor('copilot', {
      model: 'gpt-5', appendSystemPrompt: 'x', permissionMode: 'acceptEdits',
      allowedTools: ['Read'], disallowedTools: ['Write'], maxTurns: 10,
      agents: { a: { description: 'd', prompt: 'p' } }, addDirs: ['/a'],
    });
    assert.deepEqual(args, ['--model', 'gpt-5']);
    assert.deepEqual(ignored.sort(), ['--add-dir', '--agents', '--allowedTools', '--append-system-prompt',
      '--disallowedTools', '--max-turns', '--permission-mode'].sort());
  });

  test('previewFor rend une ligne lisible et cite ce qui contient des espaces', () => {
    const s = agentargs.previewFor('claude', { model: 'opus', appendSystemPrompt: 'deux mots' });
    assert.equal(s, '--model opus --append-system-prompt "deux mots"');
  });
});

describe('agentargs : ce que la sauvegarde refuse', () => {
  test('« default » est refusé — l’entrée standard de l’agent est fermée', () => {
    assert.deepEqual(agentargs.validate({ permissionMode: 'default' }), ['agents.err.permission-default']);
  });

  test('un mode inconnu est refusé, les modes admis passent', () => {
    assert.deepEqual(agentargs.validate({ permissionMode: 'yolo' }), ['agents.err.permission-unknown']);
    for (const m of ['acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
      assert.deepEqual(agentargs.validate({ permissionMode: m }), [], m);
    }
    assert.deepEqual(agentargs.validate({ permissionMode: '' }), [], 'vide = acceptEdits, décidé ailleurs');
  });

  test('un nombre de tours non entier positif est refusé', () => {
    assert.deepEqual(agentargs.validate({ maxTurns: 0 }), ['agents.err.max-turns']);
    assert.deepEqual(agentargs.validate({ maxTurns: -3 }), ['agents.err.max-turns']);
    assert.deepEqual(agentargs.validate({ maxTurns: '12abc' }), ['agents.err.max-turns']);
    assert.deepEqual(agentargs.validate({ maxTurns: 12 }), []);
    assert.deepEqual(agentargs.validate({ maxTurns: null }), [], 'pas de borne = pas d’erreur');
  });

  test('un sous-agent sans prompt ou sans description est refusé', () => {
    assert.deepEqual(agentargs.validate({ agents: { a: { description: 'd' } } }), ['agents.err.subagent-incomplete']);
    assert.deepEqual(agentargs.validate({ agents: { a: { prompt: 'p' } } }), ['agents.err.subagent-incomplete']);
    assert.deepEqual(agentargs.validate({ agents: { a: { description: 'd', prompt: 'p' } } }), []);
  });

  test('un modèle de sous-agent hors barème est refusé', () => {
    assert.deepEqual(agentargs.validate({ agents: { a: { description: 'd', prompt: 'p', model: 'gpt-4' } } }),
      ['agents.err.subagent-model']);
  });

  test('toutes les clés d’erreur existent au dictionnaire, dans les deux langues', () => {
    // Sinon l'écran afficherait la clé brute à la place de la phrase.
    const dict = require('../public/i18n.js');
    const toutes = [
      ...agentargs.validate({ permissionMode: 'default' }),
      ...agentargs.validate({ permissionMode: 'yolo' }),
      ...agentargs.validate({ maxTurns: 0 }),
      ...agentargs.validate({ agents: [] }),
      ...agentargs.validate({ agents: { a: {} } }),
      ...agentargs.validate({ agents: { a: { description: 'd', prompt: 'p', model: 'x' } } }),
    ];
    assert.ok(toutes.length >= 6);
    for (const k of toutes) {
      assert.ok(dict.fr[k], `clé fr manquante : ${k}`);
      assert.ok(dict.en[k], `clé en manquante : ${k}`);
    }
  });
});
