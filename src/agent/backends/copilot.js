'use strict';
/* GitHub Copilot CLI : se restreint par `--deny-tool` quand il le connaît (lecture : `write` et
   `shell(*)` refusés ; écriture : push/curl/wget/nc/ssh/scp refusés), sessions par un
   `COPILOT_HOME` isolé + `--continue`. Sans `--deny-tool`, le CLI ne sait pas se restreindre :
   niveau `allege`, et le journal le dit. L'argv vit dans `policy.js` (argvCopilot). */
module.exports = {
  id: 'copilot',
  label: 'GitHub Copilot CLI',
  version: /github copilot/i,
  nom: /copilot/,
  runner: 'plain',
  resume: true,
  plan: false,
  envPrefixes: ['COPILOT_', 'GH_', 'GITHUB_'],
  install: 'npm i -g @github/copilot',
  modelFlag: '--model',
  promptArgs: (prompt) => ['-p', prompt],
  niveau(cap) { return cap.denyTool ? 'declare' : 'allege'; },
  resumeCommand({ bin, suffixe, handle, cd, shQuote }) { return `${cd}COPILOT_HOME=${shQuote(handle)} ${bin}${suffixe} --continue`; },
};
