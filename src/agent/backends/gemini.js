'use strict';
/* Google Gemini CLI — ÉCRIT SANS LE BINAIRE SOUS LA MAIN (d'après la documentation du CLI, à
   confirmer contre un vrai `gemini`) : `gemini -p <prompt>` en non-interactif, le modèle par
   `-m`, et `--approval-mode` pour dire ce qui passe sans demander : `default` en lecture (un
   outil qui écrirait demanderait, et personne ne répond sous `-p` : refusé), `auto_edit` en
   écriture (les éditions passent, les commandes demandent). `--yolo`/`-y` est son mode large,
   retiré par `LARGES`. Pas de reprise de session câblée ici. */
const { sansModeLarge } = require('../modelarge');

module.exports = {
  id: 'gemini',
  label: 'Gemini CLI',
  version: /gemini/i,
  nom: /gemini/,
  runner: 'plain',
  resume: false,
  plan: false,
  envPrefixes: ['GEMINI_', 'GOOGLE_'],
  install: 'npm i -g @google/gemini-cli',
  modelFlag: '-m',
  promptArgs: (prompt) => ['-p', prompt],
  niveau(cap) { return cap.approvalMode ? 'declare' : 'allege'; },
  argv({ lecture, extra, cap }) {
    const args = cap.approvalMode ? ['--approval-mode', lecture ? 'default' : 'auto_edit'] : [];
    return {
      extra: sansModeLarge(extra), args, lecture, mode: lecture ? 'lecture' : 'declare',
      note: cap.approvalMode ? null : 'backend-non-restreint',
    };
  },
  resumeCommand() { return null; },
};
