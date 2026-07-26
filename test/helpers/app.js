'use strict';
/* Harnais de bout en bout : dossier de données jetable, faux GitLab/Jira, serveur
   Express lancé EN PROCESSUS sur un port libre.

   Deux règles importantes :
   - l'environnement (MERGERIE_DATA_DIR, COPILOT_DRY_RUN, PORT) doit être posé AVANT le
     premier `require('../../src/...')`, car paths.js lit MERGERIE_DATA_DIR au chargement ;
   - le vrai binaire copilot n'est jamais appelé (dry-run) : les rapports produits
     sont les rapports mock déterministes de copilot.js. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const mock = require('./mock-gitlab');
const mockGh = require('./mock-github');

const ROOT = path.resolve(__dirname, '..', '..');

function prepareEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-e2e-'));
  process.env.MERGERIE_DATA_DIR = dataDir;
  process.env.COPILOT_DRY_RUN = '1';
  process.env.PORT = '0';             // port libre attribué par l'OS
  delete process.env.HOST;            // écoute 127.0.0.1 : les tests s'y connectent en dur
  delete process.env.GIT_CLONE_SSH;
  // Identité git explicite : les commits des sessions de dev ne doivent pas dépendre
  // d'une configuration globale présente sur la machine (absente en CI).
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  return dataDir;
}

// Démarre l'application. À appeler une fois par fichier de test.
async function startApp() {
  const dataDir = prepareEnv();
  const gitlab = await mock.start();
  const github = await mockGh.start();
  // eslint-disable-next-line global-require
  const server = require('../../src/server');
  if (!server.server.listening) {
    await new Promise((resolve) => server.server.once('listening', resolve));
  }
  const base = `http://127.0.0.1:${server.server.address().port}`;

  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* réponse non-JSON (fichier, 404 vide) */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  // Configure l'app pour parler au faux GitLab (et au faux Jira si demandé).
  async function configure(extra = {}) {
    return api('PUT', '/api/config', {
      gitlab_url: gitlab.url,
      access_token: mock.state.token,
      clone_path: path.join(dataDir, 'clones'),
      ...extra,
    });
  }

  // Connexion GitHub (faux serveur) — à appeler en plus de configure() pour les
  // dépôts GitHub. Les deux forges peuvent être configurées en même temps.
  async function configureGithub(extra = {}) {
    return api('PUT', '/api/config', {
      github_url: github.url,
      github_token: mockGh.state.token,
      clone_path: path.join(dataDir, 'clones'),
      ...extra,
    });
  }

  return {
    base, api, configure, configureGithub, dataDir,
    gitlabUrl: gitlab.url, githubUrl: github.url,
    state: mock.state, ghState: mockGh.state,
    async stop() {
      await server.close();
      await gitlab.close();
      await github.close();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/* ---------- Dépôts git réels (locaux) ----------
   Les endpoints diff / arborescence / fichier et les sessions de dev exécutent de
   VRAIES commandes git. On leur donne donc de vrais dépôts : un dépôt nu sert
   d'« origin », cloné par l'application comme n'importe quel dépôt distant. */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

/* Crée un dépôt nu contenant `main` et une branche de travail qui modifie un
   fichier. Renvoie l'URL (chemin) du dépôt nu et les SHA des deux têtes. */
function makeRemoteRepo(dir, { branch = 'feature/PROJ-42-ajout', mainFile = 'src/app.js' } = {}) {
  const bare = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  git(bare, ['init', '--bare', '--initial-branch=main', '.']);
  git(work, ['init', '--initial-branch=main', '.']);
  git(work, ['remote', 'add', 'origin', bare]);
  fs.mkdirSync(path.join(work, path.dirname(mainFile)), { recursive: true });
  fs.writeFileSync(path.join(work, mainFile), 'const a = 1;\nmodule.exports = { a };\n');
  fs.writeFileSync(path.join(work, 'README.md'), '# projet de test\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'init']);
  git(work, ['push', '-u', 'origin', 'main']);
  const mainSha = git(work, ['rev-parse', 'HEAD']).trim();

  git(work, ['checkout', '-b', branch]);
  fs.writeFileSync(path.join(work, mainFile), 'const a = 1;\nconst b = 2;\nmodule.exports = { a, b };\n');
  fs.mkdirSync(path.join(work, 'db'), { recursive: true });
  fs.writeFileSync(path.join(work, 'db/migration.sql'), 'ALTER TABLE t ADD COLUMN c INT;\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'feat: ajoute b']);
  git(work, ['push', '-u', 'origin', branch]);
  const branchSha = git(work, ['rev-parse', 'HEAD']).trim();
  git(work, ['checkout', 'main']);

  return { url: bare, bare, work, branch, mainSha, branchSha };
}

// Ajoute un commit sur la branche de travail (2e passe de review : le code a bougé).
// `remove` supprime des fichiers dans le même commit — c'est ce qui fait sortir un
// fichier du diff, et donc ce qui exerce le suivi de résolution.
function pushChange(repo, file, content, message = 'fix: correction', remove = []) {
  git(repo.work, ['checkout', repo.branch]);
  for (const r of remove) fs.rmSync(path.join(repo.work, r), { force: true });
  fs.writeFileSync(path.join(repo.work, file), content);
  git(repo.work, ['add', '-A']);
  git(repo.work, ['commit', '-m', message]);
  git(repo.work, ['push', 'origin', repo.branch]);
  const sha = git(repo.work, ['rev-parse', 'HEAD']).trim();
  git(repo.work, ['checkout', 'main']);
  return sha;
}

// Attend qu'un job de fond se termine (les jobs sont asynchrones et sérialisés).
async function waitForJobs(api, { timeout = 60000 } = {}) {
  const start = Date.now();
  for (;;) {
    const { body } = await api('GET', '/api/jobs/current');
    if (body && !body.running && !body.queued) return body.job;
    if (Date.now() - start > timeout) throw new Error(`job toujours en cours après ${timeout} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

module.exports = { startApp, makeRemoteRepo, pushChange, waitForJobs, git, ROOT };
