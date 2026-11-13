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
    // Les sous-modules du quotidien — jamais `foreach`, et une adresse seulement en https ou ssh.
    'submodule update --init --recursive', 'submodule sync --recursive', 'submodule status', 'submodule',
    'submodule --quiet update --remote', 'submodule add https://gitlab.test/g/lib.git libs/lib',
    'submodule set-url libs/lib git@gitlab.test:g/lib.git', 'submodule deinit -f libs/lib', 'submodule summary',
    'fetch --recurse-submodules', 'checkout --recurse-submodules main',
    'submodule add -b main --name lib https://gitlab.test/g/lib.git libs/lib', 'submodule add --name=lib -- git@gitlab.test:g/lib.git',
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
    'submodule foreach git pull', 'submodule --quiet foreach ls', 'submodule add ext::sh x', 'submodule add file:///tmp/r x',
    'submodule set-url libs/lib http://h/x', 'submodule update --reference /tmp/r', 'submodule absorbgitdirs',
    'submodule update --rec', 'fetch --recu=x',
    // Une option à valeur ne décale pas l'adresse lue : le dépôt réel reste vérifié.
    'submodule add --name https://ok.test/x file:///tmp/r libs', 'submodule add --name https://ok.test/x -- file:///tmp/r libs',
    'submodule add https://ok.test/x file:///tmp/r', 'submodule add https://ok.test/x libs trop', 'submodule set-url libs/lib',
    'submodule set-url https://ok.test/x libs/lib',
  ];
  for (const c of CONTOURNEMENTS) {
    test(`refusée : git ${c}`, () => assert.throws(() => verifierArgs(args(c))));
  }
});
