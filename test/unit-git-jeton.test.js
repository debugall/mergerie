'use strict';
/* LE JETON DE LA FORGE HORS DE PORTÉE DE L'AGENT — et git qui n'exécute plus ce qu'on lui a glissé.
 *
 * Le jeton était écrit dans l'URL d'`origin`, donc dans `.git/config` de chaque clone : l'agent qui
 * y travaille le lisait d'un `git remote get-url origin`, les worktrees des vérificateurs aussi.
 * Et un hook ou un `core.fsmonitor` posé dans le clone s'exécutait ensuite, lancé par les commandes
 * git DE MERGERIE, avec tout son environnement.
 *
 * Tout est éprouvé contre un vrai dépôt servi en HTTP qui EXIGE le jeton (`helpers/git-http`) :
 * sans lui, le clone échoue — c'est ce qui prouve que le jeton passe bien, par un autre chemin.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'git-jeton-'));

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { serveurGitHttp } = require('./helpers/git-http');

const JETON = 'glpat-JETON-DE-TEST-0123456789';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('Le jeton ne s’écrit plus dans le clone, et git ne lance plus ce qu’on y a posé', () => {
  let serveur; let git; let config; let racine; let clone; let repo;

  before(async () => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-http-'));
    // Un dépôt nu `grp/app.git` avec un commit, servi en HTTP derrière le jeton.
    const nu = path.join(racine, 'grp', 'app.git');
    fs.mkdirSync(nu, { recursive: true });
    g(nu, 'init', '--bare', '--initial-branch=main');
    const travail = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-travail-'));
    g(travail, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(travail, 'a.txt'), 'un\n');
    g(travail, 'add', '-A');
    g(travail, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-qm', 'init');
    g(travail, 'push', '-q', nu, 'main');

    serveur = await serveurGitHttp({ racine, utilisateur: 'oauth2', jeton: JETON });
    config = require('../src/config');
    git = require('../src/git');
    config.updateConfig({
      gitlab_url: serveur.url, access_token: JETON,
      clone_path: path.join(process.env.MERGERIE_DATA_DIR, 'clones'),
    });
    repo = { project: 'grp/app', url: `${serveur.url}/grp/app.git`, forge: 'gitlab' };
    clone = await git.ensureRepo(config.getConfig(), repo);
  });
  after(async () => { if (serveur) await serveur.close(); });

  test('le clone réussit derrière un jeton, et le jeton n’est écrit nulle part dans le clone', () => {
    assert.ok(fs.existsSync(path.join(clone, 'a.txt')), 'le clone a bien eu lieu : le jeton est passé');
    const origine = g(clone, 'remote', 'get-url', 'origin');
    assert.doesNotMatch(origine, new RegExp(JETON), `origin est nue : ${origine}`);
    assert.doesNotMatch(fs.readFileSync(path.join(clone, '.git', 'config'), 'utf8'), new RegExp(JETON),
      'rien dans .git/config — là où l’agent le lisait');
    assert.ok(serveur.recus.some((h) => h && h.startsWith('Basic ')), 'le jeton est parti en en-tête HTTP');
  });

  test('un fetch suivant passe aussi, et un mauvais jeton est refusé — le jeton sert vraiment', async () => {
    await git.ensureRepo(config.getConfig(), repo);          // fetch : doit passer
    config.updateConfig({ access_token: 'faux-jeton' });
    await assert.rejects(git.ensureRepo(config.getConfig(), repo), 'sans le bon jeton, la forge refuse');
    config.updateConfig({ access_token: JETON });
  });

  test('un clone d’avant, dont origin portait le jeton, est nettoyé au démarrage', async () => {
    const sale = `${serveur.url.replace('http://', `http://oauth2:${JETON}@`)}/grp/app.git`;
    g(clone, 'remote', 'set-url', 'origin', sale);
    const n = await git.nettoyerOrigines(config.getConfig());
    assert.equal(n, 1);
    assert.doesNotMatch(g(clone, 'remote', 'get-url', 'origin'), new RegExp(JETON));
  });

  test('un hook posé dans le clone ne s’exécute pas quand Mergerie fait un checkout', async () => {
    const marque = path.join(os.tmpdir(), `hook-${process.pid}`);
    fs.rmSync(marque, { force: true });
    const hook = path.join(clone, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\necho "$GIT_CONFIG_VALUE_0" > ${marque}\n`, { mode: 0o755 });
    await git.run('git', ['checkout', '-q', '-B', 'essai-hook'], { cwd: clone });
    assert.equal(fs.existsSync(marque), false, 'le hook n’a pas tourné — et n’a donc pas lu le jeton dans l’environnement');
  });

  test('un core.fsmonitor écrit dans .git/config ne s’exécute pas non plus', async () => {
    const marque = path.join(os.tmpdir(), `fsmon-${process.pid}`);
    fs.rmSync(marque, { force: true });
    const script = path.join(os.tmpdir(), `fsmon-${process.pid}.sh`);
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marque}\n`, { mode: 0o755 });
    g(clone, 'config', 'core.fsmonitor', script);
    await git.run('git', ['status', '--short'], { cwd: clone });
    assert.equal(fs.existsSync(marque), false, 'le moniteur glissé dans la config n’a pas tourné');
    g(clone, 'config', '--unset', 'core.fsmonitor');
  });

  test('l’environnement de git est une liste blanche : pas de secret du .env', () => {
    process.env.COPILOT_GITHUB_TOKEN = 'ghp-NE-DOIT-PAS-PASSER';
    const env = git.envGit();
    assert.equal(env.COPILOT_GITHUB_TOKEN, undefined, 'un jeton du .env n’atteint pas git');
    assert.ok(env.PATH && env.HOME, 'ce dont git a besoin est là');
    delete process.env.COPILOT_GITHUB_TOKEN;
  });
});

/* « STOP » ARRÊTE AUSSI CE QUE LA COMMANDE A LANCÉ. Un `npm test` qui lance jest, un agent qui lance
   un serveur : tuer l'enfant direct laissait les petits-enfants tourner. On lance une fixture qui
   démarre un petit-fils puis attend, on annule, et on attend l'EFFET — le petit-fils mort. */
describe('Arrêter tue le groupe entier', { skip: process.platform === 'win32' ? 'groupes POSIX' : false }, () => {
  test('le petit-fils meurt avec la commande', async () => {
    const proc = require('../src/core/proc');
    const pidFichier = path.join(os.tmpdir(), `petit-fils-${process.pid}`);
    fs.rmSync(pidFichier, { force: true });
    const fixture = `const c = require('child_process').spawn('sleep', ['60'], { stdio: 'ignore' });
      require('fs').writeFileSync(${JSON.stringify(pidFichier)}, String(c.pid)); setInterval(() => {}, 1000);`;
    const { ctx } = proc.run(async () => {
      const child = spawn(process.execPath, ['-e', fixture], proc.options({ stdio: 'ignore' }));
      proc.setActive(child);
      await new Promise((r) => child.on('exit', r));
    });
    const debut = Date.now();
    while (!fs.existsSync(pidFichier) && Date.now() - debut < 10000) await new Promise((r) => setTimeout(r, 50));
    const petitFils = Number(fs.readFileSync(pidFichier, 'utf8'));
    assert.ok(petitFils > 0);

    proc.cancel(ctx);
    const vivant = () => { try { process.kill(petitFils, 0); return true; } catch { return false; } };
    const fin = Date.now() + 10000;
    while (vivant() && Date.now() < fin) await new Promise((r) => setTimeout(r, 50));
    assert.equal(vivant(), false, 'le petit-fils ne survit pas à « Stop »');
  });
});
