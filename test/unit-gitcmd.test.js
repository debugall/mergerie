'use strict';
/* LA PALETTE GIT : CE QUI PASSE, ET LES CONTOURNEMENTS QUI NE PASSENT PLUS.
 *
 * L'ancienne garde était une liste noire ; chaque ligne du tableau ci-dessous la franchissait —
 * exécution par un alias, une option courte, une abréviation, une sous-commande qui lance un
 * programme ; lecture ou écriture hors du dépôt ; secrets du trousseau. La palette par défaut,
 * elle, doit rester entièrement acceptée : une garde qui casse l'usage normal est retirée.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { verifierArgs } = require('../src/git/gitpalette');

const args = (s) => s.split(/\s+/).filter(Boolean);

describe('Palette git : liste blanche', () => {
  const ADMISES = [
    // La palette amorcée et celle de la démo — toujours acceptées.
    'fetch --all --prune', 'status --short --branch', 'pull --ff-only', 'remote prune origin', 'log --oneline -10',
    // Le quotidien.
    'log main..feature', 'push -u origin HEAD', 'cherry-pick -x abc123', 'remote add amont https://gitlab.test/g/p.git',
    'remote set-url origin git@gitlab.test:g/p.git', 'clean -fdx', 'stash pop', 'diff HEAD~1 -- src/a.js',
    'rebase origin/main', 'reset --hard origin/main', 'tag -l', 'branch -vv',
  ];
  for (const c of ADMISES) test(`admise : git ${c}`, () => assert.equal(verifierArgs(args(c)), true));

  const CONTOURNEMENTS = [
    'config alias.z !ls', 'z', '-c core.sshCommand=x status', 'fetch --upload-pa=evil', 'push --receive-pack=x',
    'fetch --exec=x', 'rebase -x sh', 'rebase -ix sh', 'rebase -i HEAD~2', 'bisect run sh', 'submodule foreach ls',
    'filter-branch', 'mergetool', 'daemon', 'send-email x', 'credential fill', 'log --output=/tmp/x',
    'archive -o /tmp/x HEAD', 'worktree add /x', 'diff --no-index /etc/passwd x', 'difftool -x sh', 'grep -O ls',
    'clone -u x y', 'fetch ext::sh', 'show --textconv HEAD', 'diff --ext-diff', 'checkout -- ../../x',
    'log --pathspec-from-file=/etc/passwd', 'remote add x file:///tmp/r', 'remote set-url origin http://h/x',
    'status --git-dir=/tmp/x', 'log -C /tmp',
  ];
  for (const c of CONTOURNEMENTS) {
    test(`refusée : git ${c}`, () => assert.throws(() => verifierArgs(args(c))));
  }
});
