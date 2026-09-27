'use strict';
/* CE QU'UN DÉPÔT SAIT DÉJÀ LANCER, ET LE HOME D'UN RUN.
 *
 * Les suggestions de commandes lisent le clone sur disque, sans rien exécuter, pour tous les
 * écosystèmes — et la variante « dans le conteneur » quand un compose est là. Chaque suggestion est
 * une ligne exacte. Et « HOME jetable » sur un run lancé à la main : choisi au clic, mémorisé sur le
 * vérificateur, relu par le run.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeRemoteRepo, waitForJobs, attendreServeur } = require('./helpers/app');

describe('Vérificateurs · suggestions de commandes et HOME jetable', () => {
  let app; let repoId; let clone;

  before(async () => {
    app = await startApp();
    const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'sugg-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r.mainSha } }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: r.url, project: 'grp/app' })).body.id;
    // Le clone, comme l'outil le ferait à la première review : c'est LUI que les suggestions lisent.
    const git = require('../src/git/git');
    const { getConfig } = require('../src/data/config');
    clone = await git.ensureRepo(getConfig(), app.db.prepare('SELECT * FROM repo WHERE id = ?').get(repoId), () => {});
  });
  after(async () => { await app.stop(); });

  const ecrire = (nom, texte) => { fs.mkdirSync(path.dirname(path.join(clone, nom)), { recursive: true }); fs.writeFileSync(path.join(clone, nom), texte); };
  const suggestions = async () => (await app.api('GET', `/api/verifiers/command-suggestions?repo_ids=${repoId}`)).body.suggestions.map((s) => s.command);

  test('un dépôt nu ne propose rien ; chaque écosystème déclaré propose ses lignes exactes', async () => {
    assert.deepEqual(await suggestions(), []);
    ecrire('package.json', JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
    ecrire('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    ecrire('go.mod', 'module example.com/app\n');
    ecrire('Cargo.toml', '[package]\nname = "app"\n');
    ecrire('pyproject.toml', '[project]\nname = "app"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[tool.ruff]\nline-length = 100\n');
    ecrire('requirements.txt', 'flask\n');
    ecrire('tox.ini', '[tox]\nenvlist = py312\n');
    ecrire('pom.xml', '<project/>'); ecrire('mvnw', '#!/bin/sh\n');
    ecrire('build.gradle.kts', 'plugins {}'); ecrire('gradlew', '#!/bin/sh\n');
    ecrire('App.csproj', '<Project/>');
    ecrire('composer.json', JSON.stringify({ scripts: { cs: 'phpcs' } })); ecrire('phpunit.xml.dist', '<phpunit/>');
    ecrire('Makefile', 'test: ## Lance les tests\n\t@echo ok\n');
    const s = await suggestions();
    for (const attendu of [
      'pnpm install --frozen-lockfile', 'pnpm run test', 'pnpm run lint',
      'composer install --no-interaction', 'composer run cs', 'vendor/bin/phpunit',
      'pip install -r requirements.txt', 'pytest', 'tox', 'ruff check .',
      'go build ./...', 'go vet ./...', 'go test ./...',
      'cargo build', 'cargo test', 'cargo clippy',
      './mvnw -B test', './mvnw -B verify', './gradlew test', './gradlew check',
      'dotnet build', 'dotnet test', 'make test',
    ]) assert.ok(s.includes(attendu), `« ${attendu} » proposé (${s.join(' | ')})`);
    assert.ok(!s.includes('npm ci'), 'le lockfile pnpm écarte npm');
    assert.ok(!s.some((c) => c.startsWith('docker compose')), 'pas de compose : pas de variante conteneur');
  });

  test('un compose dans le clone : la variante « dans le conteneur » de chaque commande de test, sur le premier service', async () => {
    ecrire('compose.yaml', 'name: app\nservices:\n  api:\n    image: node:22\n  db:\n    image: postgres:16\nvolumes:\n  data: {}\n');
    const brut = (await app.api('GET', `/api/verifiers/command-suggestions?repo_ids=${repoId}`)).body.suggestions;
    const s = brut.map((x) => x.command);
    assert.ok(s.includes('docker compose up -d --wait'));
    assert.ok(s.includes('docker compose run --rm api pnpm run test'), s.filter((c) => c.startsWith('docker')).join(' | '));
    assert.ok(s.includes('docker compose run --rm api pytest'));
    assert.ok(s.includes('docker compose run --rm api go test ./...'));
    assert.ok(s.includes('docker compose run --rm api ./mvnw -B test'));
    assert.ok(!s.includes('docker compose run --rm api pnpm install --frozen-lockfile'), 'l’installation n’a pas de variante : ce n’est pas un test');
    const variante = brut.find((x) => x.command === 'docker compose run --rm api pytest');
    assert.match(variante.desc, /api, db/, 'la suggestion dit les autres services');
    assert.equal(variante.source, 'compose');
  });

  test('« HOME jetable » : réglé sur le vérificateur, choisi au clic, mémorisé, et relu par le run', async () => {
    const v = (await app.api('POST', '/api/verifiers', { name: 'echo', commands: ['true'], repos: [{ repo_id: repoId, mode: 'worktree' }] })).body;
    assert.equal(v.isolated_home, 0, 'défaut : le vrai HOME sur un run manuel');
    assert.equal((await app.api('PUT', `/api/verifiers/${v.id}`, { isolated_home: 1 })).body.isolated_home, 1);
    // Un run de branche, avec la case DÉCOCHÉE au clic : le run garde le HOME, et le vérificateur s'en souvient.
    const r1 = await app.api('POST', '/api/verify/branches', { verifier_id: v.id, targets: [{ repo_id: repoId, branch: 'main' }], isolated_home: false });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.verification.isolated_home, 0);
    assert.equal((await app.api('GET', '/api/verifiers')).body.find((x) => x.id === v.id).isolated_home, 0, 'le choix au clic est mémorisé sur le vérificateur');
    await waitForJobs(app.api);
    await attendreServeur(async () => (await app.api('GET', `/api/verifications/${r1.body.verification.id}`)).body.status === 'done', 'run fini');
    const log1 = app.db.prepare('SELECT log_excerpt FROM verification WHERE id = ?').get(r1.body.verification.id).log_excerpt || '';
    assert.match(log1, /voient ton HOME|see your HOME/, 'le journal dit que ce run voit le HOME');
    // Case COCHÉE : HOME jetable, et mémorisé.
    const r2 = await app.api('POST', '/api/verify/branches', { verifier_id: v.id, targets: [{ repo_id: repoId, branch: 'main' }], isolated_home: true });
    assert.equal(r2.body.verification.isolated_home, 1);
    assert.equal((await app.api('GET', '/api/verifiers')).body.find((x) => x.id === v.id).isolated_home, 1);
    await waitForJobs(app.api);
    await attendreServeur(async () => (await app.api('GET', `/api/verifications/${r2.body.verification.id}`)).body.status === 'done', 'run fini');
    const log2 = app.db.prepare('SELECT log_excerpt FROM verification WHERE id = ?').get(r2.body.verification.id).log_excerpt || '';
    assert.match(log2, /HOME jetable demandé|throwaway HOME requested/);
    // Sans le champ : le réglage du vérificateur fait foi.
    const r3 = await app.api('POST', '/api/verify/branches', { verifier_id: v.id, targets: [{ repo_id: repoId, branch: 'main' }] });
    assert.equal(r3.body.verification.isolated_home, 1);
    await waitForJobs(app.api);
  });
});
