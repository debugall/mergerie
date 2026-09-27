'use strict';
/* Un CLI que Mergerie ne connaît pas (`unknown`) : lancé tel quel, `<bin> [args] -p <prompt>`,
   sans mode lecture seule à lui demander — niveau `allege`. Il n'est plus refusé : le contrôle
   d'intégrité après coup (`git/integrite.js`) dit si la lecture a écrit, et le journal annonce
   le niveau avant le premier appel. Ce qui reste fermé, comme pour tous : le mode large de
   `AGENT_ARGS`, la base, le `.env`, le jeton local, l'environnement hors liste blanche. */
const { sansModeLarge } = require('../modelarge');

module.exports = {
  id: 'unknown',
  label: 'CLI non reconnu',
  version: /$^/,
  nom: /$^/,
  runner: 'plain',
  resume: false,
  plan: false,
  envPrefixes: [],
  install: '',
  modelFlag: '--model',
  promptArgs: (prompt) => ['-p', prompt],
  niveau() { return 'allege'; },
  argv({ lecture, extra }) {
    return { extra: sansModeLarge(extra), args: [], lecture, mode: 'allege', note: 'backend-non-restreint' };
  },
  resumeCommand() { return null; },
};
