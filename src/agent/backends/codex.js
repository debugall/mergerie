'use strict';
/* OpenAI Codex CLI — ÉCRIT SANS LE BINAIRE SOUS LA MAIN (d'après la documentation du CLI, à
   confirmer contre un vrai `codex`) : `codex exec <prompt>` en non-interactif, une sandbox
   NATIVE (`--sandbox read-only` pour lire, `--sandbox workspace-write` + `--full-auto` pour
   écrire), le modèle par `-m`. Pas de reprise de session câblée ici (`codex exec resume` est
   récent et pas prouvé) : chaque passe repart à froid, comme le repli one-shot des autres.
   Le mode large de codex (`--dangerously-bypass-approvals-and-sandbox`) est dans `LARGES`
   (policy.js) : il est retiré comme les autres. Tant qu'aucun run réel n'a tourné ici, les
   Réglages le disent « non vérifié ». */
const { sansModeLarge } = require('../modelarge');

module.exports = {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  version: /codex/i,
  nom: /codex/,
  runner: 'plain',
  resume: false,
  plan: false,
  envPrefixes: ['OPENAI_', 'CODEX_'],
  install: 'npm i -g @openai/codex',
  modelFlag: '-m',
  /* `exec` prend le prompt en argument positionnel — après les options, d'où l'ordre. */
  promptArgs: (prompt) => ['exec', prompt],
  /* La sandbox native est DÉCLARÉE par le CLI, jamais prouvée par la sonde de Mergerie (qui ne
     connaît que `--settings` de claude) : `declare`. */
  niveau(cap) { return cap.sandboxOpt ? 'declare' : 'allege'; },
  argv({ lecture, extra, cap, cwd }) {
    const base = cap.sandboxOpt ? ['--sandbox', lecture ? 'read-only' : 'workspace-write'] : [];
    if (cap.skipGitRepoCheck) base.push('--skip-git-repo-check');
    if (!lecture && cap.fullAuto) base.push('--full-auto');
    if (cwd && cap.cdOpt) base.push('-C', String(cwd));
    return {
      extra: sansModeLarge(extra), args: base, lecture, mode: lecture ? 'lecture' : 'declare',
      note: cap.sandboxOpt ? null : 'backend-non-restreint',
    };
  },
  resumeCommand() { return null; },
};
