'use strict';
/* Une session hors dépôt EXPORTÉE EN SCRIPT BASH, et ce script EXÉCUTÉ. Ce qui se vérifie est ce
   qu'il fait vraiment d'un dépôt git — la branche, le commit, ce que le dépôt distant reçoit, la
   merge request demandée à la forge (le faux GitLab des tests) —, et que l'agent reçoit le même
   prompt que celui que la session lui aurait envoyé. L'agent est un faux binaire qui écrit un
   fichier et note ce qu'on lui a passé. Le script ne doit pas nommer l'outil qui l'a produit. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { startApp, makeRemoteRepo } = require('./helpers/app');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('Codage hors dépôt : export en script bash', () => {
  let app; let depot; let agent; let journal; let localcoder;
  const PROMPT = "Range les imports\nAvec une 'apostrophe', un $HOME et un `backtick`\n__PROMPT__";

  const exporter = async (id) => {
    const r = await fetch(`${app.base}/api/local-tasks/${id}/script`, { headers: { Authorization: `Bearer ${app.localToken}` } });
    return { status: r.status, disposition: r.headers.get('content-disposition') || '', texte: await r.text() };
  };
  /* Asynchrone, jamais `spawnSync` : le faux GitLab tourne dans CE processus, et une boucle
     d'événements gelée ne répondrait pas au `curl` du script — qui attendrait pour toujours. */
  const lancer = (fichier, env = {}) => new Promise((resolve) => {
    const p = spawn('bash', [fichier], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_BIN: agent, ...env },
    });
    let stderr = '';
    p.stdout.resume();
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stderr }));
  });

  before(async () => {
    app = await startApp(); await app.configure();
    localcoder = require('../src/session/localcoder');
    const racine = path.join(app.dataDir, 'script'); fs.mkdirSync(racine, { recursive: true });
    depot = makeRemoteRepo(racine);
    // Le remote LU dit la forge et le projet ; le push part dans le dépôt nu local.
    git(depot.work, ['remote', 'set-url', 'origin', `${app.gitlabUrl}/grp/local-script.git`]);
    git(depot.work, ['remote', 'set-url', '--push', 'origin', depot.bare]);
    journal = path.join(app.dataDir, 'agent.log');
    agent = path.join(app.dataDir, 'faux-agent.sh');
    fs.writeFileSync(agent, `#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf '%s' "$last" > '${journal}'\necho fait > AGENT_DONE.md\n`);
    fs.chmodSync(agent, 0o755);
  });
  after(async () => { await app.stop(); });

  test('le script se télécharge, nomme ni l’outil ni ses données, et met dossiers et demande en tête', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: PROMPT, label: 'Rangement des imports', dirs: [depot.work] })).body;
    const { status, disposition, texte } = await exporter(lt.id);
    assert.equal(status, 200);
    assert.match(disposition, /attachment; filename="rangement-des-imports\.sh"/);
    assert.ok(texte.startsWith('#!/usr/bin/env bash\n'));
    assert.doesNotMatch(texte, /mergerie/i, 'le script ne nomme pas l’outil');
    assert.doesNotMatch(texte, /reviewer\.db/, 'ni les règles qui ne protègent que ses données');
    const premiere = (motif) => texte.indexOf(motif);
    assert.ok(premiere('FOLDERS=(') > 0 && premiere('FOLDERS=(') < premiere('PROMPT <<'), 'les dossiers d’abord');
    assert.ok(premiere('PROMPT <<') < premiere('BRANCH='), 'puis la demande');
    assert.ok(premiere('BRANCH=') < premiere('json_str()'), 'le code vient après tout ce qui se modifie');
    assert.ok(texte.includes(`  '${depot.work}'\n`));
    assert.equal(spawnSync('bash', ['-n', '-c', texte]).status, 0, 'syntaxe bash valide');
  });

  test('exécuté : l’agent reçoit le même prompt, puis branche, commit, push et merge request', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: PROMPT, label: 'Rangement des imports', dirs: [depot.work] })).body;
    const fichier = path.join(app.dataDir, 'session.sh');
    fs.writeFileSync(fichier, (await exporter(lt.id)).texte);
    // Du travail de l'utilisateur, déjà là : il reste en place et hors du commit.
    fs.writeFileSync(path.join(depot.work, '.env'), 'SECRET=1\n');

    const r = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(journal, 'utf8'), localcoder.promptPremierePasse(PROMPT), 'le prompt de la session, au caractère près');
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ai/rangement-des-imports');
    assert.equal(git(depot.work, ['log', '-1', '--format=%s']), 'Range les imports');
    const commites = git(depot.work, ['show', '--name-only', '--format=', 'HEAD']).split('\n');
    assert.deepEqual(commites, ['AGENT_DONE.md'], 'ce que l’agent a écrit, et rien d’autre');
    assert.equal(fs.readFileSync(path.join(depot.work, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(git(depot.bare, ['rev-parse', 'refs/heads/ai/rangement-des-imports']), git(depot.work, ['rev-parse', 'HEAD']));
    const mr = (app.state.mrs['grp/local-script'] || []).find((m) => m.source_branch === 'ai/rangement-des-imports');
    assert.ok(mr, 'la merge request est ouverte sur la forge');
    assert.equal(mr.target_branch, 'main', 'vers la branche d’où le dossier est parti');
    assert.equal(mr.title, 'Range les imports');
    assert.match(r.stderr, new RegExp(`/grp/local-script/-/merge_requests/${mr.iid}`));

    // Relancé : rien de neuf à commiter, la MR existe déjà — ce n'est pas un échec.
    const encore = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.equal(encore.status, 0, encore.stderr);
    fs.rmSync(path.join(depot.work, '.env'));
    git(depot.work, ['checkout', '-q', 'main']);
  });

  test('la demande et les dossiers modifiés en tête du script sont ceux qui partent', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Ancienne demande', label: 'Modifiable', branch: 'feature/edite', dirs: [depot.work] })).body;
    const texte = (await exporter(lt.id)).texte
      .replace("Ancienne demande\n__PROMPT__", 'Nouvelle demande, écrite à la main\n__PROMPT__')
      .replace(`  '${depot.work}'\n`, `  '${depot.work}'\n  '/nulle/part'\n`);
    const fichier = path.join(app.dataDir, 'edite.sh');
    fs.writeFileSync(fichier, texte);
    const r = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.notEqual(r.status, 0, 'un dossier introuvable fait échouer le script…');
    assert.match(r.stderr, /\/nulle\/part/);
    assert.equal(git(depot.bare, ['rev-parse', 'refs/heads/feature/edite']), git(depot.work, ['rev-parse', 'HEAD']), '…sans arrêter les autres');
    assert.equal(fs.readFileSync(journal, 'utf8'), localcoder.promptPremierePasse('Nouvelle demande, écrite à la main'));
    git(depot.work, ['checkout', '-q', 'main']);
  });
});
