'use strict';
/* Onglet Docker — logique PURE (le cœur : drift .env sur l'effectif vs l'attendu, masquage
   des secrets, badge par service, reconstruction de la commande run). Testée sans démon :
   les fonctions prennent des données déjà parsées. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-docker-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const docker = require('../src/docker');

describe('Docker — drift .env (effectif vs attendu)', () => {
  test('diff nominatif : ajoutée / modifiée, valeur visible', () => {
    const expected = { DB_POOL_SIZE: '25', FEATURE_X: 'true', UNCHANGED: 'a' };
    const effective = { DB_POOL_SIZE: '10', UNCHANGED: 'a' };
    const diffs = docker.diffEnv(expected, effective);
    const byName = Object.fromEntries(diffs.map((d) => [d.name, d]));
    assert.equal(byName.DB_POOL_SIZE.kind, 'modified');
    assert.equal(byName.DB_POOL_SIZE.from, '10');
    assert.equal(byName.DB_POOL_SIZE.to, '25');
    assert.equal(byName.FEATURE_X.kind, 'added');
    assert.equal(byName.FEATURE_X.to, 'true');
    assert.ok(!byName.UNCHANGED, 'une variable identique n’est pas un drift');
  });

  test('valeurs sensibles MASQUÉES : on dit « modifiée » sans montrer la valeur', () => {
    const diffs = docker.diffEnv({ STRIPE_SECRET_KEY: 'sk_live_new', API_TOKEN: 't2', DB_PASSWORD: 'p' }, { STRIPE_SECRET_KEY: 'sk_live_old', API_TOKEN: 't1' });
    for (const d of diffs) {
      assert.equal(d.masked, true, `${d.name} doit être masqué`);
      assert.equal(d.from, undefined);
      assert.equal(d.to, undefined);
    }
    assert.ok(docker.isSecretName('MY_PASSWORD'));
    assert.ok(docker.isSecretName('x_api_key'));
    assert.ok(!docker.isSecretName('DB_POOL_SIZE'));
  });

  test('environment compose accepté en objet OU en tableau', () => {
    assert.deepEqual(docker.serviceExpectedEnv({ environment: { A: '1', B: 2 } }), { A: '1', B: '2' });
    assert.deepEqual(docker.serviceExpectedEnv({ environment: ['A=1', 'B=x=y'] }), { A: '1', B: 'x=y' });
    assert.deepEqual(docker.serviceExpectedEnv({}), {});
  });

  test('badge par service : priorité absent > drift config > drift image > compose modifié > synchro', () => {
    assert.equal(docker.serviceBadge({ container: null }), 'missing');
    assert.equal(docker.serviceBadge({ container: { state: 'exited' } }), 'stopped');
    assert.equal(docker.serviceBadge({ container: { state: 'running' }, envDiffs: [{ name: 'X' }] }), 'drift-config');
    assert.equal(docker.serviceBadge({ container: { state: 'running' }, imgDrift: true }), 'drift-image');
    assert.equal(docker.serviceBadge({ container: { state: 'running' }, composeModified: true }), 'compose-modified');
    assert.equal(docker.serviceBadge({ container: { state: 'running' } }), 'synced');
  });

  test('drift image : la référence demandée ≠ celle du container', () => {
    assert.equal(docker.imageDrift('app:2.0', 'app:1.0'), true);
    assert.equal(docker.imageDrift('app:1.0', 'app:1.0'), false);
    assert.equal(docker.imageDrift(null, 'app:1.0'), false);
  });
});

describe('Docker — hors-compose', () => {
  test('parse des labels d’une ligne docker ps', () => {
    const l = docker.parseLabels('com.docker.compose.project=boutique,com.docker.compose.service=api');
    assert.equal(l['com.docker.compose.project'], 'boutique');
    assert.equal(l['com.docker.compose.service'], 'api');
    assert.deepEqual(docker.parseLabels(''), {});
  });

  test('reconstruction d’un docker run lisible depuis l’inspect (secrets masqués)', () => {
    const inspect = {
      Name: '/redis-scratch',
      Config: { Image: 'redis:7', Env: ['PATH=/usr/bin', 'REDIS_PASSWORD=hunter2', 'LOG_LEVEL=info'], Cmd: ['redis-server'] },
      __imageEnv: ['PATH=/usr/bin'], // hérité de l'image → écarté
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, PortBindings: { '6379/tcp': [{ HostIp: '0.0.0.0', HostPort: '6379' }] } },
      Mounts: [{ Type: 'volume', Name: 'redis-data', Destination: '/data' }],
    };
    const cmd = docker.reconstructRunCommand(inspect);
    assert.match(cmd, /docker run -d/);
    assert.match(cmd, /--name redis-scratch/);
    assert.match(cmd, /--restart unless-stopped/);
    assert.match(cmd, /-p 0\.0\.0\.0:6379:6379\/tcp/);
    assert.match(cmd, /-v redis-data:\/data/);
    assert.match(cmd, /-e LOG_LEVEL=info/);
    assert.match(cmd, /-e REDIS_PASSWORD=\*\*\*/, 'le secret est masqué');
    assert.doesNotMatch(cmd, /hunter2/);
    assert.doesNotMatch(cmd, /PATH=/, 'les vars héritées de l’image sont écartées');
    assert.match(cmd, /redis:7/);
  });
});

describe('Docker — Makefile', () => {
  test('parseMakefileTargets extrait les cibles + descriptions, ignore variables/motifs/.PHONY', () => {
    const mk = [
      'DOCKER := docker compose',           // variable → ignorée
      '.PHONY: up down',                     // ignorée
      '## Démarre la stack',                 // description de la ligne suivante
      'up:',
      '\t$(DOCKER) up -d',                   // recette (tab) → ignorée
      'test: lint ## Lance les tests',       // desc en ligne
      '%.o: %.c',                            // règle-motif → ignorée
      'clean:',
      'DB_URL=postgres://x',                 // affectation sans cible → ignorée
    ].join('\n');
    const targets = docker.parseMakefileTargets(mk);
    const byName = Object.fromEntries(targets.map((t) => [t.name, t.desc]));
    assert.deepEqual(Object.keys(byName).sort(), ['clean', 'test', 'up']);
    assert.equal(byName.up, 'Démarre la stack', 'description depuis la ligne ## précédente');
    assert.equal(byName.test, 'Lance les tests', 'description en fin de ligne');
    assert.equal(byName.clean, '', 'sans description');
    // La recette (lignes indentées par TAB) est capturée pour l'aperçu au survol.
    const up = targets.find((t) => t.name === 'up');
    assert.equal(up.recipe, '$(DOCKER) up -d', 'le contenu de la commande est extrait');
  });
});

describe('Docker — découverte compose', () => {
  test('explainDockerError : binaire absent ≠ « not found » dans la sortie d’une commande', () => {
    // Échec de spawn du binaire → « CLI introuvable ».
    assert.match(docker.explainDockerError('Error: spawn docker ENOENT'), /CLI introuvable/);
    assert.match(docker.explainDockerError('Error: spawn /usr/local/bin/docker ENOENT'), /CLI introuvable/);
    // Commande docker qui a TOURNÉ mais échoué (compose invalide, env_file absent, service inconnu)
    // → surtout PAS « CLI introuvable » : on montre l'erreur réelle.
    assert.doesNotMatch(docker.explainDockerError('env file /x/.env not found: stat /x/.env: no such file or directory'), /CLI introuvable/);
    assert.match(docker.explainDockerError('env file /x/.env not found'), /env file/);
    assert.doesNotMatch(docker.explainDockerError('service web: image not found'), /CLI introuvable/);
    assert.match(docker.explainDockerError('Cannot connect to the Docker daemon'), /démon/i);
  });

  test('anti flag-smuggling : refuse un service/id qui pourrait passer pour un flag, et sépare par --', () => {
    // Un nom commençant par « - » serait lu comme une option par docker : on le refuse.
    assert.throws(() => docker.composeArgs('/x', 'up', ['--force-recreate']), /invalide/);
    assert.throws(() => docker.composeArgs('/x', 'up', ['-v']), /invalide/);
    assert.equal(docker.validRef('a1b2c3d4'), true);
    assert.equal(docker.validRef('boutique-api-1'), true);
    assert.equal(docker.validRef('--rm'), false);
    assert.equal(docker.validRef('-v'), false);
    // Le `--` sépare les options des services positionnels.
    assert.deepEqual(docker.composeArgs('/x', 'up', ['api', 'db']), ['compose', 'up', '-d', '--', 'api', 'db']);
    assert.deepEqual(docker.composeArgs('/x', 'recreate', ['api']), ['compose', 'up', '-d', '--force-recreate', '--', 'api']);
    assert.deepEqual(docker.composeArgs('/x', 'up', []), ['compose', 'up', '-d'], 'pas de -- inutile sans service');
    assert.deepEqual(docker.composeArgs('/x', 'stop', ['api']), ['compose', 'stop', '--', 'api'], 'stop = arrêt sans suppression');
    // Build : reconstruit l'image PUIS recrée (up -d --build).
    assert.deepEqual(docker.composeArgs('/x', 'build', ['api']), ['compose', 'up', '-d', '--build', '--', 'api']);
    assert.deepEqual(docker.composeArgs('/x', 'build', []), ['compose', 'up', '-d', '--build']);
  });

  test('defaultProjectName : basename « sanitisé » comme Docker Compose (tri/rattachement rapide)', () => {
    assert.equal(docker.defaultProjectName('/home/moi/Mon Projet'), 'monprojet');
    assert.equal(docker.defaultProjectName('/srv/Boutique-API_2'), 'boutique-api_2');
    assert.equal(docker.defaultProjectName('/a/b/'), 'b');
  });

  test('healthSummary : compte le rouge (restarting/dead) et l’orange (unhealthy)', () => {
    const s = docker.healthSummary([
      { state: 'running', status: 'Up 3 hours' },
      { state: 'running', status: 'Up 3 hours (unhealthy)' },
      { state: 'running', status: 'Up 2 min (healthy)' },
      { state: 'restarting', status: 'Restarting (1) 5s ago' },
      { state: 'dead', status: 'Dead' },
      { state: 'exited', status: 'Exited (0)' },
    ]);
    assert.equal(s.error, 2, 'restarting + dead');
    assert.equal(s.unhealthy, 1, 'seulement le (unhealthy) — pas le (healthy)');
    // Un container restarting ET unhealthy compte comme erreur (rouge), pas deux fois.
    const s2 = docker.healthSummary([{ state: 'restarting', status: 'Restarting (unhealthy)' }]);
    assert.deepEqual(s2, { error: 1, unhealthy: 0 });
    assert.deepEqual(docker.healthSummary([]), { error: 0, unhealthy: 0 });
  });

  test('spawnLogs (onglet Logs) refuse un id piégé avant tout spawn', async () => {
    // Même garde-fou anti « flag smuggling » que composeArgs : un id/nom commençant par « - »
    // ne doit JAMAIS atteindre `docker logs` (il serait lu comme une option).
    await assert.rejects(() => docker.spawnLogs('--rm', 200), /invalide/);
    await assert.rejects(() => docker.spawnLogs('-f', 200), /invalide/);
    await assert.rejects(() => docker.spawnLogs('a; rm -rf /', 200), /invalide/);
  });

  test('composeFilesUnder trouve les fichiers compose à la racine et dans les sous-dossiers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-'));
    fs.mkdirSync(path.join(root, 'boutique'));
    fs.writeFileSync(path.join(root, 'boutique', 'compose.yaml'), 'services: {}');
    fs.mkdirSync(path.join(root, 'mono'));
    fs.writeFileSync(path.join(root, 'mono', 'docker-compose.yml'), 'services: {}');
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, '.hidden', 'compose.yaml'), 'services: {}'); // ignoré (caché)
    fs.mkdirSync(path.join(root, 'no-compose'));
    const hits = docker.composeFilesUnder(root).map((h) => h.file).sort();
    assert.deepEqual(hits, ['compose.yaml', 'docker-compose.yml']);
  });
});
