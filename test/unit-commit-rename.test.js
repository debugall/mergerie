'use strict';
/* RENOMMER LE DERNIER COMMIT QUAND LA RELANCE N'A RIEN À COMMITTER.
 *
 * Le geste : on lance une session, on voit passer un commit mal nommé, on remplit le champ
 * « message de commit » et on relance. L'IA constate que tout est déjà fait et ne commite rien —
 * le commit gardait donc son ancien message, et le champ qu'on venait de remplir ne servait à
 * rien. C'est ce trou-là que ce fichier surveille.
 *
 * Sur de VRAIS dépôts git : renommer un commit se joue à `--amend`, et ce qu'il faut prouver est
 * précisément ce qu'une simulation ne dirait pas — que le contenu du commit ne bouge pas, et
 * qu'un commit déjà poussé n'est pas réécrit. Le chemin est inatteignable en bout-en-bout : le
 * faux agent modifie un fichier à chaque passe, donc il y a toujours quelque chose à committer.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = require('../src/git');
const taskrunner = require('../src/taskrunner');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

// Un dépôt de travail avec un commit, et — au choix — un `origin` qui le porte déjà.
function depot({ pousse = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renomme-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  g(work, 'init', '-q', '-b', 'travail');
  fs.writeFileSync(path.join(work, 'a.txt'), 'contenu\n');
  g(work, 'add', '-A');
  g(work, 'commit', '-qm', 'message d’origine');
  if (pousse) {
    const bare = path.join(dir, 'origin.git');
    g(dir, 'init', '-q', '--bare', 'origin.git');
    g(work, 'remote', 'add', 'origin', bare);
    g(work, 'push', '-q', 'origin', 'travail');
  }
  return { dir, work };
}

describe('Renommer le dernier commit', () => {
  test('le message change, le contenu du commit ne bouge pas', async () => {
    const { work } = depot();
    const arbre = g(work, 'rev-parse', 'HEAD^{tree}');
    const sha = g(work, 'rev-parse', 'HEAD');

    assert.equal(await git.renommerDernierCommit(work, 'PROJ-12 compteur'), true);
    assert.equal(g(work, 'log', '--format=%s', '-1'), 'PROJ-12 compteur');
    assert.equal(g(work, 'rev-parse', 'HEAD^{tree}'), arbre, 'SEUL le message change');
    assert.notEqual(g(work, 'rev-parse', 'HEAD'), sha, 'le commit est bien réécrit');
    assert.equal(g(work, 'rev-list', '--count', 'HEAD'), '1', 'un renommage, pas un commit de plus');
  });

  /* Rejoué, ça ne doit RIEN faire : la relance d'une session au message déjà bon ne peut pas
     réécrire un commit à chaque fois — le sha changerait sans raison, à chaque passe. */
  test('rejoué sur le même message, il ne réécrit rien', async () => {
    const { work } = depot();
    await git.renommerDernierCommit(work, 'PROJ-12 compteur');
    const sha = g(work, 'rev-parse', 'HEAD');
    assert.equal(await git.renommerDernierCommit(work, 'PROJ-12 compteur'), false, 'rien à faire');
    assert.equal(g(work, 'rev-parse', 'HEAD'), sha, 'et le sha ne bouge pas');
  });

  test('une branche encore locale se renomme', async () => {
    const { work } = depot();
    const dits = [];
    assert.equal(await taskrunner.reappliquerMessage(work, 'travail', 'PROJ-12 compteur', (m) => dits.push(m)), 'renomme');
    assert.equal(g(work, 'log', '--format=%s', '-1'), 'PROJ-12 compteur');
    assert.ok(dits.some((m) => /message du dernier commit/.test(m)), 'le journal dit ce qui a été fait');
  });

  /* UN COMMIT DÉJÀ POUSSÉ NE SE RENOMME PAS. La forge l'a, une merge request peut le pointer,
     quelqu'un a pu le récupérer : réécrire cette histoire-là ne se fait pas dans le dos. Et
     surtout, ça se DIT — un refus silencieux relancerait la même question la fois d'après. */
  test('une branche déjà sur origin n’est pas réécrite, et ça se dit', async () => {
    const { work } = depot({ pousse: true });
    const sha = g(work, 'rev-parse', 'HEAD');
    const dits = [];
    assert.equal(await taskrunner.reappliquerMessage(work, 'travail', 'PROJ-12 compteur', (m) => dits.push(m)), 'publie');
    assert.equal(g(work, 'log', '--format=%s', '-1'), 'message d’origine');
    assert.equal(g(work, 'rev-parse', 'HEAD'), sha);
    assert.ok(dits.some((m) => /déjà sur origin/.test(m)), 'la raison est écrite dans le journal');
  });
});
