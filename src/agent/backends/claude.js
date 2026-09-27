'use strict';
/* Claude Code : le backend de référence. Lecture seule par `--restricted`/`--permission-mode
   default`, écriture sous la sandbox `--settings` une fois prouvée, sessions reprenables par
   `--session-id`/`--resume`, flux d'événements `stream-json`. L'argv de permission vit dans
   `policy.js` (argvLecture/argvEcriture), prouvé par `unit-agentpolicy`. */
module.exports = {
  id: 'claude',
  label: 'Claude Code',
  version: /claude code/i,
  nom: /claude/,
  runner: 'stream',
  resume: true,
  plan: true,
  envPrefixes: ['ANTHROPIC_', 'CLAUDE_', 'AWS_', 'VERTEX_'],
  install: 'npm i -g @anthropic-ai/claude-code',
  /* L'option de modèle d'un profil, et le prompt : `-p` en non-interactif. */
  modelFlag: '--model',
  promptArgs: (prompt) => ['-p', prompt],
  /* `prouve` quand « Tester le sandbox » l'a vu bloquer ; `declare` sinon — le CLI sait se
     restreindre (`--restricted`, `--permission-mode default`), personne ne l'a prouvé ici. */
  niveau(cap, cfg) {
    if ((cfg.agent_write_mode || 'sandbox') === 'sandbox' && Number(cfg.agent_sandbox_verified) === 1 && cap.settings) return 'prouve';
    return 'declare';
  },
  resumeCommand({ bin, suffixe, handle, cd }) { return `${cd}${bin}${suffixe} --resume ${handle}`; },
};
