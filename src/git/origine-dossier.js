'use strict';
/* L'URL du remote `origin` d'un dossier, lue dans `.git/config` — pas de processus, pas de réseau. C'est ce qui permet de dire QUEL dépôt tourne dans ce
   dossier, et donc de retrouver son service dans la grille des liens. Un worktree ou un sous-module écrit « gitdir: … » dans un FICHIER `.git`. Absent
   (pas un dépôt, pas de remote), on ne devine pas : `null`. */
const fs = require('node:fs');
const path = require('node:path');

function origineDuDossier(dir) {
  try {
    const gitDir = path.join(dir, '.git');
    const base = fs.statSync(gitDir).isDirectory() ? gitDir
      : path.resolve(dir, String(fs.readFileSync(gitDir, 'utf8')).replace(/^gitdir:\s*/, '').trim());
    const conf = String(fs.readFileSync(path.join(base, 'config'), 'utf8'));
    const bloc = conf.split(/\[remote /).find((b) => b.startsWith('"origin"'));
    if (!bloc) return null;
    const m = bloc.match(/^\s*url\s*=\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

module.exports = { origineDuDossier };
