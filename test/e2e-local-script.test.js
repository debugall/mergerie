'use strict';
/* Une session hors dépôt EXPORTÉE EN SCRIPT BASH, et ce script EXÉCUTÉ. Ce qui se vérifie est ce
   qu'il fait vraiment d'un dépôt git — la branche, le commit, ce que le dépôt distant reçoit, la
   merge request demandée à la forge (le faux GitLab des tests) —, et que l'agent reçoit le même
   prompt que celui que la session lui aurait envoyé. L'agent est un faux binaire qui écrit un
   fichier et note ce qu'on lui a passé. Le script ne doit pas nommer l'outil qui l'a produit. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { startApp, makeRemoteRepo } = require('./helpers/app');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('Codage hors dépôt : export en script bash', () => {
  let app; let depot; let agent; let journal; let localcoder;
  const PROMPT = "Range les imports\nAvec une 'apostrophe', un $HOME et un `backtick`\n__PROMPT__";

  const exporter = async (id, query = '') => {
    const r = await fetch(`${app.base}/api/local-tasks/${id}/script${query}`, { headers: { Authorization: `Bearer ${app.localToken}` } });
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

  // Les dossiers s'écrivent à partir de leur parent commun, WORKSPACE_DIR.
  const ligneDossier = () => `  "$WORKSPACE_DIR"/'${path.basename(depot.work)}'\n`;

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
    assert.ok(texte.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n\n'), 'pas de commentaire sur la session ni la date d’export');
    assert.doesNotMatch(texte, /mergerie/i, 'le script ne nomme pas l’outil');
    assert.doesNotMatch(texte, /reviewer\.db/, 'ni les règles qui ne protègent que ses données');
    const premiere = (motif) => texte.indexOf(motif);
    assert.ok(premiere('FOLDERS=(') > 0 && premiere('FOLDERS=(') < premiere('PROMPT <<'), 'les dossiers d’abord');
    assert.ok(premiere('FOLDERS=(') < premiere('AGENT_BIN=') && premiere('AGENT_PROMPT_FORM=(') < premiere('PROMPT <<'), 'puis la commande de l’agent et ses arguments');
    assert.ok(premiere('PROMPT <<') < premiere('BRANCH='), 'puis la demande');
    assert.ok(premiere('BRANCH=') < premiere("MR_TITLE='Range les imports'\n"), 'le titre de la MR, à éditer en tête avec le reste de git');
    assert.ok(premiere('MR_TITLE=') < premiere('json_str()'));
    assert.ok(premiere('BRANCH=') < premiere('json_str()'), 'le code vient après tout ce qui se modifie');
    assert.ok(texte.includes(`\nWORKSPACE_DIR=\${WORKSPACE_DIR:-'${path.dirname(depot.work)}'}\n`), 'le dossier parent en variable, surchargeable');
    assert.ok(premiere('WORKSPACE_DIR=') < premiere('FOLDERS=('));
    assert.ok(texte.includes(ligneDossier()), 'chaque dossier à partir de lui');
    assert.ok(!texte.includes(`'${depot.work}'`), 'aucun chemin de dossier en dur');
    assert.ok(premiere('load_env "$ENV_FILE"') < premiere('WORKSPACE_DIR='), 'le .env est lu avant');
    assert.equal(spawnSync('bash', ['-n', '-c', texte]).status, 0, 'syntaxe bash valide');
  });

  test('exécuté : l’agent reçoit le même prompt, puis branche, commit, push et merge request', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: PROMPT, label: 'Rangement des imports', dirs: [depot.work] })).body;
    const fichier = path.join(app.dataDir, 'session.sh');
    fs.writeFileSync(fichier, (await exporter(lt.id)).texte);
    // Du travail de l'utilisateur en cours sur un fichier suivi : le script s'arrête avant de rien toucher, et le dit.
    fs.writeFileSync(path.join(depot.work, 'suivi.txt'), 'v1\n');
    git(depot.work, ['add', 'suivi.txt']); git(depot.work, ['commit', '-q', '-m', 'suivi.txt']);
    fs.writeFileSync(path.join(depot.work, 'suivi.txt'), 'v2 en cours\n');
    fs.writeFileSync(journal, '');
    const sale = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.notEqual(sale.status, 0, 'un dossier modifié arrête tout');
    assert.match(sale.stderr, /suivi\.txt/, 'en listant ce qui est en cours');
    assert.equal(fs.readFileSync(journal, 'utf8'), '', 'avant l’agent');
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'et avant la branche');
    assert.equal(fs.readFileSync(path.join(depot.work, 'suivi.txt'), 'utf8'), 'v2 en cours\n');
    git(depot.work, ['checkout', '-q', '--', 'suivi.txt']);
    // Un fichier jamais commité ne bloque pas — et ne part pas dans le commit. Ni un fichier ignoré,
    // ni un fichier commité par le passé que .gitignore nomme depuis : modifié, il reste en place, hors du commit.
    fs.writeFileSync(path.join(depot.work, 'brouillon.md'), 'notes à moi\n');
    fs.writeFileSync(path.join(depot.work, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(depot.work, 'local.conf'), 'v1\n');
    git(depot.work, ['add', 'local.conf']); git(depot.work, ['commit', '-q', '-m', 'local.conf']);
    fs.appendFileSync(path.join(depot.work, '.git', 'info', 'exclude'), '.env\nlocal.conf\n');
    fs.writeFileSync(path.join(depot.work, 'local.conf'), 'v2, réglage du poste\n');

    const r = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(journal, 'utf8'), localcoder.promptPremierePasse(PROMPT), 'le prompt de la session, au caractère près');
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'le dossier revient sur sa branche d’origine');
    assert.match(r.stderr, /↩ retour sur main/);
    assert.equal(git(depot.work, ['log', '-1', '--format=%s', 'ai/rangement-des-imports']), 'Range les imports');
    const commites = git(depot.work, ['show', '--name-only', '--format=', 'ai/rangement-des-imports']).split('\n');
    assert.deepEqual(commites, ['AGENT_DONE.md'], 'ce que l’agent a écrit, et rien d’autre');
    assert.equal(fs.readFileSync(path.join(depot.work, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(fs.readFileSync(path.join(depot.work, 'brouillon.md'), 'utf8'), 'notes à moi\n', 'le fichier jamais commité reste là');
    assert.equal(git(depot.work, ['status', '--porcelain', '--', 'brouillon.md']), '?? brouillon.md', 'toujours non suivi');
    assert.equal(fs.readFileSync(path.join(depot.work, 'local.conf'), 'utf8'), 'v2, réglage du poste\n');
    assert.equal(git(depot.bare, ['rev-parse', 'refs/heads/ai/rangement-des-imports']), git(depot.work, ['rev-parse', 'ai/rangement-des-imports']));
    const mr = (app.state.mrs['grp/local-script'] || []).find((m) => m.source_branch === 'ai/rangement-des-imports');
    assert.ok(mr, 'la merge request est ouverte sur la forge');
    assert.equal(mr.target_branch, 'main', 'vers la branche d’où le dossier est parti');
    assert.equal(mr.title, 'Range les imports');
    assert.match(r.stderr, new RegExp(`/grp/local-script/-/merge_requests/${mr.iid}`));

    // Relancé : rien de neuf à commiter, la MR existe déjà — ce n'est pas un échec.
    const encore = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.equal(encore.status, 0, encore.stderr);
    fs.rmSync(path.join(depot.work, '.env'));
    fs.rmSync(path.join(depot.work, 'brouillon.md'));
    git(depot.work, ['checkout', '-q', '--', 'local.conf']);
    fs.writeFileSync(path.join(depot.work, '.git', 'info', 'exclude'), '');
    git(depot.work, ['checkout', '-q', 'main']);
  });

  test('la demande et les dossiers modifiés en tête du script sont ceux qui partent', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Ancienne demande', label: 'Modifiable', branch: 'feature/edite', dirs: [depot.work] })).body;
    const texte = (await exporter(lt.id)).texte
      .replace("Ancienne demande\n__PROMPT__", 'Nouvelle demande, écrite à la main\n__PROMPT__')
      .replace(ligneDossier(), `${ligneDossier()}  '/nulle/part'\n`)
      .replace(/^MR_TITLE=.*$/m, "MR_TITLE='Titre de MR écrit à la main'");
    const fichier = path.join(app.dataDir, 'edite.sh');
    fs.writeFileSync(fichier, texte);
    const r = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.notEqual(r.status, 0, 'un dossier introuvable fait échouer le script…');
    assert.match(r.stderr, /\/nulle\/part/);
    assert.equal(git(depot.bare, ['rev-parse', 'refs/heads/feature/edite']), git(depot.work, ['rev-parse', 'feature/edite']), '…sans arrêter les autres');
    assert.equal(fs.readFileSync(journal, 'utf8'), localcoder.promptPremierePasse('Nouvelle demande, écrite à la main'));
    const mr = (app.state.mrs['grp/local-script'] || []).find((m) => m.source_branch === 'feature/edite');
    assert.equal(mr && mr.title, 'Titre de MR écrit à la main', 'la MR porte le titre édité en tête du script');
    git(depot.work, ['checkout', '-q', 'main']);
  });
  test('la branche de départ et la branche à créer, renommées en tête du script', async () => {
    // Une branche de départ qui n'est pas celle où se trouve le dossier, avec son propre commit.
    git(depot.work, ['checkout', '-q', '-b', 'socle']);
    fs.writeFileSync(path.join(depot.work, 'SOCLE.md'), 'socle\n');
    git(depot.work, ['add', 'SOCLE.md']); git(depot.work, ['commit', '-q', '-m', 'socle']);
    const socle = git(depot.work, ['rev-parse', 'HEAD']);
    git(depot.work, ['checkout', '-q', 'main']);

    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Depuis le socle', label: 'Depart', dirs: [depot.work] })).body;
    const texte = (await exporter(lt.id)).texte;
    assert.match(texte, /^BASE_BRANCH=''$/m, 'jamais lancée : la branche courante de chaque dossier');
    assert.ok(texte.indexOf('BASE_BRANCH=') < texte.indexOf('\nBRANCH='), 'avant la branche à créer');
    // Déjà lancée depuis l'application : la branche de départ qu'elle a relevée est reprise.
    require('../src/db').prepare("UPDATE local_task_dir SET base_branch = 'socle' WHERE task_id = ?").run(lt.id);
    assert.match((await exporter(lt.id)).texte, /^BASE_BRANCH='socle'$/m);
    const fichier = path.join(app.dataDir, 'depart.sh');
    fs.writeFileSync(fichier, texte.replace(/^BASE_BRANCH=.*$/m, "BASE_BRANCH='socle'").replace(/^BRANCH=.*$/m, "BRANCH='feature/renommee'"));
    const r = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'revenu sur main, pas sur la branche de départ');
    assert.equal(git(depot.work, ['rev-parse', 'feature/renommee~1']), socle, 'partie de la branche de départ, pas de main');
    const mr = (app.state.mrs['grp/local-script'] || []).find((m) => m.source_branch === 'feature/renommee');
    assert.equal(mr && mr.target_branch, 'socle', 'la merge request vise la branche de départ');

    git(depot.work, ['checkout', '-q', 'main']);
    fs.writeFileSync(fichier, texte.replace(/^BASE_BRANCH=.*$/m, "BASE_BRANCH='inexistante'").replace(/^BRANCH=.*$/m, "BRANCH='feature/orpheline'"));
    const ko = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.notEqual(ko.status, 0, 'une branche de départ introuvable arrête le dossier');
    assert.match(ko.stderr, /inexistante/);
    assert.equal(git(depot.work, ['branch', '--list', 'feature/orpheline']), '', 'sans créer la branche');

    // Un échec APRÈS le passage sur la branche de travail : le dossier revient quand même sur la sienne.
    fs.writeFileSync(fichier, texte.replace(/^BRANCH=.*$/m, "BRANCH='feature/agent-en-echec'"));
    const echec = await lancer(fichier, { GITLAB_TOKEN: app.state.token, AGENT_BIN: 'false' });
    assert.notEqual(echec.status, 0);
    assert.equal(git(depot.work, ['branch', '--list', 'feature/agent-en-echec']).replace(/^[* ]+/, ''), 'feature/agent-en-echec', 'la branche a bien été prise…');
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', '…puis quittée');
    git(depot.work, ['checkout', '-q', 'main']);
  });

  test('un ticket Jira en tête du script simple : son contenu devant la demande, comme une session ouverte depuis le ticket', async () => {
    app.state.jiraIssues['PROJ-78'] = { key: 'PROJ-78', fields: {
      summary: 'Trier les imports', description: 'Par ordre alphabétique.',
      comment: { comments: [{ id: '1', body: '#tech utiliser eslint-plugin-import' }] },
    } };
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Fais-le', label: 'Avec ticket simple', dirs: [depot.work] })).body;
    const texte = (await exporter(lt.id)).texte;
    assert.match(texte, /^JIRA_TICKET=''$/m, 'facultatif : vide par défaut');
    const fichier = path.join(app.dataDir, 'ticket-simple.sh');
    fs.writeFileSync(fichier, texte.replace(/^JIRA_TICKET=.*$/m, "JIRA_TICKET='PROJ-78'").replace(/^JIRA_URL=.*$/m, `JIRA_URL='${app.gitlabUrl}'`)
      .replace(/^JIRA_EMAIL=.*$/m, "JIRA_EMAIL='moi@exemple.fr'").replace(/^PUSH=1$/m, 'PUSH=0').replace(/^CREATE_MR=1$/m, 'CREATE_MR=0'));
    const r = await lancer(fichier, { JIRA_TOKEN: 'jeton-jira' });
    assert.equal(r.status, 0, r.stderr);
    const ticket = '# Trier les imports\n\nPar ordre alphabétique.\n\n## Précision technique (commentaire #tech)\n\nutiliser eslint-plugin-import';
    assert.equal(fs.readFileSync(journal, 'utf8'), localcoder.promptPremierePasse(`Contexte du ticket Jira PROJ-78 :\n\n${ticket}\n\n---\n\nFais-le`),
      'le prompt qu’aurait reçu une session ouverte depuis ce ticket, au caractère près');
    git(depot.work, ['checkout', '-q', 'main']);
  });

  test('sans commit, les modifications restent en place ; sans retour, le dossier reste sur la branche de travail', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Sans commit', label: 'Brouillon', dirs: [depot.work] })).body;
    const texte = (await exporter(lt.id)).texte;
    assert.match(texte, /^COMMIT=1$/m); assert.match(texte, /^RESTORE_BRANCH=1$/m);
    const avant = (app.state.mrs['grp/local-script'] || []).length;
    const fichier = path.join(app.dataDir, 'sans-commit.sh');

    fs.writeFileSync(fichier, texte.replace(/^COMMIT=1$/m, 'COMMIT=0'));
    const r = await lancer(fichier, {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ai/brouillon', 'reste sur la branche de travail, malgré RESTORE_BRANCH=1');
    assert.equal(git(depot.work, ['rev-parse', 'HEAD']), git(depot.work, ['rev-parse', 'main']), 'aucun commit');
    assert.equal(git(depot.work, ['status', '--porcelain']), '?? AGENT_DONE.md', 'le travail de l’agent, non commité');
    assert.equal(git(depot.bare, ['branch', '--list', 'ai/brouillon']), '', 'rien de poussé');
    assert.equal((app.state.mrs['grp/local-script'] || []).length, avant, 'ni merge request — ni jeton demandé');
    fs.rmSync(path.join(depot.work, 'AGENT_DONE.md'));
    git(depot.work, ['checkout', '-q', 'main']);

    fs.writeFileSync(fichier, texte.replace(/^RESTORE_BRANCH=1$/m, 'RESTORE_BRANCH=0').replace(/^PUSH=1$/m, 'PUSH=0').replace(/^CREATE_MR=1$/m, 'CREATE_MR=0'));
    const sansRetour = await lancer(fichier, {});
    assert.equal(sansRetour.status, 0, sansRetour.stderr);
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'ai/brouillon', 'RESTORE_BRANCH=0 : le dossier reste sur la branche de travail');
    assert.equal(git(depot.work, ['log', '-1', '--format=%s']), 'Sans commit', 'avec le commit');
    git(depot.work, ['checkout', '-q', 'main']);
  });

  /* Aucun chemin de la machine qui exporte : le parent des dossiers est WORKSPACE_DIR, le dossier
     temporaire du bac à sable celui de la machine qui lance. Un .env à côté du script les fixe,
     l'environnement l'emporte sur lui, et ce qu'il porte n'est pas transmis à l'agent. */
  test('WORKSPACE_DIR et TMPDIR : surchargés par le .env, l’environnement l’emporte, l’agent ne reçoit pas les jetons', async () => {
    /* Le bac à sable (et son dossier temporaire) n'existe qu'en mode sécurisé, sur un poste dont le
       sandbox est vérifié, avec un claude qui connaît `--settings` : un faux qui l'annonce. */
    const faux = path.join(app.dataDir, 'faux-claude', 'claude');
    fs.mkdirSync(path.dirname(faux), { recursive: true });
    fs.writeFileSync(faux, '#!/bin/sh\necho "--settings --permission-prompts"\n'); fs.chmodSync(faux, 0o755);
    const avant = (await app.api('GET', '/api/config')).body;
    const db = require('../src/db');
    await app.api('PUT', '/api/config', { agent_bin: faux, agent_backend: 'claude' });
    db.prepare('UPDATE local_config SET agent_sandbox_verified = 1 WHERE id = 1').run();
    let texte;
    try {
      const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Demande env', label: 'Avec env', branch: 'feature/avec-env', dirs: [depot.work] })).body;
      texte = (await exporter(lt.id, '?yolo=0')).texte;
    } finally {
      db.prepare('UPDATE local_config SET agent_sandbox_verified = 0 WHERE id = 1').run();
      await app.api('PUT', '/api/config', { agent_bin: avant.agent_bin || '', agent_backend: avant.agent_backend || '' });
    }
    const options = texte.match(/^AGENT_ARGS=\(.*\)$/m)[0];
    assert.ok(options.includes('@TMPDIR@'), 'le dossier temporaire du bac à sable, posé au lancement');
    assert.ok(!options.includes(os.tmpdir()), 'pas celui de la machine qui exporte');

    const dossier = fs.mkdtempSync(path.join(app.dataDir, 'avec-env-'));
    const fichier = path.join(dossier, 'avec-env.sh');
    fs.writeFileSync(fichier, texte.replace(/^PUSH=1$/m, 'PUSH=0').replace(/^CREATE_MR=1$/m, 'CREATE_MR=0'));
    const traces = path.join(app.dataDir, 'avec-env-traces'); fs.mkdirSync(traces, { recursive: true });
    const espion = path.join(dossier, 'agent-espion.sh');
    fs.writeFileSync(espion, `#!/bin/sh\nprintf '%s\\n' "$@" > '${traces}/args'\nenv > '${traces}/env'\necho fait > AGENT_DONE.md\n`);
    fs.chmodSync(espion, 0o755);
    fs.writeFileSync(path.join(dossier, '.env'), [
      '# le .env du poste',
      'WORKSPACE_DIR=/nulle/part',
      '  export TMPDIR=/tmp/tmp-du-env/',
      "GITLAB_TOKEN='jeton-du-env'",
      'pas une affectation',
    ].join('\n'));

    let r = await lancer(fichier, { AGENT_BIN: espion });
    assert.notEqual(r.status, 0, 'le .env a déplacé les dossiers');
    assert.ok(r.stderr.includes(`/nulle/part/${path.basename(depot.work)}`), r.stderr);

    r = await lancer(fichier, { AGENT_BIN: espion, WORKSPACE_DIR: path.dirname(depot.work) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(depot.work, ['log', '-1', '--format=%s', 'feature/avec-env']), 'Demande env', 'l’environnement l’emporte sur le .env');
    const args = fs.readFileSync(path.join(traces, 'args'), 'utf8');
    assert.ok(args.includes('"/tmp/tmp-du-env"'), 'le TMPDIR du .env dans le bac à sable, sans « / » final');
    assert.ok(args.includes(`"${depot.work}"`) || args.includes(`"${fs.realpathSync(depot.work)}"`), 'le dossier de travail aussi');
    assert.ok(!args.includes('@TMPDIR@') && !args.includes('@FOLDER@'));
    const env = fs.readFileSync(path.join(traces, 'env'), 'utf8');
    assert.doesNotMatch(env, /jeton-du-env|^WORKSPACE_DIR=\/nulle/m, 'ce que porte le .env reste au script');
    assert.match(env, /^TMPDIR=\/tmp\/tmp-du-env\/$/m, 'sauf TMPDIR, que le bac à sable suit');
    git(depot.work, ['checkout', '-q', 'main']);
  });

  test('modèle vierge : demande, branches, message et titre vides, et le script refuse de partir sans eux', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Demande de la session', label: 'Gabarit', branch: 'feature/gabarit', dirs: [depot.work] })).body;
    const { disposition, texte } = await exporter(lt.id, '?blank=1');
    assert.match(disposition, /filename="gabarit-vierge\.sh"/);
    for (const nom of ['BASE_BRANCH', 'BRANCH', 'COMMIT_MESSAGE', 'MR_TITLE']) assert.match(texte, new RegExp(`^${nom}=''$`, 'm'), `${nom} vide`);
    assert.match(texte, /PROMPT <<'__PROMPT__' \|\| true\n\n__PROMPT__\n/, 'la demande vide');
    assert.doesNotMatch(texte, /Demande de la session/);
    assert.ok(texte.includes(ligneDossier()), 'les dossiers de la session, eux, restent');
    assert.ok(texte.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n'), 'ni session, ni date, ni note de modèle en tête');
    assert.equal(spawnSync('bash', ['-n', '-c', texte]).status, 0);
    const conv = await exporter(lt.id, '?converge=1&blank=1');
    assert.match(conv.disposition, /filename="gabarit-converge-vierge\.sh"/);
    assert.match(conv.texte, /^CONVERGE=1$/m); assert.match(conv.texte, /^COMMIT_MESSAGE=''$/m);

    const fichier = path.join(app.dataDir, 'vierge.sh');
    fs.writeFileSync(fichier, texte);
    fs.writeFileSync(journal, '');
    const vide = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.notEqual(vide.status, 0, 'rien de renseigné : arrêt');
    assert.match(vide.stderr, /à renseigner en tête du script : PROMPT COMMIT_MESSAGE MR_TITLE\n/, 'en nommant chaque variable manquante — pas les branches, qui peuvent rester vides');
    assert.equal(fs.readFileSync(journal, 'utf8'), '', 'avant l’agent');
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'et avant la branche');

    fs.writeFileSync(fichier, texte.replace(/^COMMIT_MESSAGE=.*$/m, "COMMIT_MESSAGE='Un message'"));
    const partiel = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.notEqual(partiel.status, 0);
    assert.match(partiel.stderr, /à renseigner en tête du script : PROMPT MR_TITLE\n/, 'seulement ce qui manque encore');

    fs.writeFileSync(fichier, texte
      .replace("true\n\n__PROMPT__", 'true\nFais le gabarit\n__PROMPT__')
      .replace(/^BASE_BRANCH=.*$/m, "BASE_BRANCH='main'").replace(/^BRANCH=.*$/m, "BRANCH='feature/remplie'")
      .replace(/^COMMIT_MESSAGE=.*$/m, "COMMIT_MESSAGE='BI-57 Affichage \"Simple utilisateur\"'")
      .replace(/^MR_TITLE=.*$/m, "MR_TITLE='BI-57 Titre de la MR'"));
    const r = await lancer(fichier, { GITLAB_TOKEN: app.state.token });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(journal, 'utf8'), localcoder.promptPremierePasse('Fais le gabarit'));
    assert.equal(git(depot.work, ['log', '-1', '--format=%s', 'feature/remplie']), 'BI-57 Affichage "Simple utilisateur"', 'le message de commit renseigné');
    const mr = (app.state.mrs['grp/local-script'] || []).find((m) => m.source_branch === 'feature/remplie');
    assert.equal(mr && mr.title, 'BI-57 Titre de la MR');
    assert.equal(mr.target_branch, 'main');
    git(depot.work, ['checkout', '-q', 'main']);
  });

  test('un agent qui ne change rien : ni push ni merge request des commits de la base', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Rien à faire', label: 'Rien', branch: 'feature/rien', dirs: [depot.work] })).body;
    const fichier = path.join(app.dataDir, 'rien.sh');
    fs.writeFileSync(fichier, (await exporter(lt.id)).texte);
    // La base a un commit local que origin n'a pas encore : une MR l'aurait embarqué sous son titre.
    fs.writeFileSync(path.join(depot.work, 'LOCAL.md'), 'pas encore poussé\n');
    git(depot.work, ['add', 'LOCAL.md']); git(depot.work, ['commit', '-q', '-m', 'Commit local de la base']);
    const avant = (app.state.mrs['grp/local-script'] || []).length;
    const r = await lancer(fichier, { AGENT_BIN: 'true', GITLAB_TOKEN: app.state.token });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Aucun commit sur feature\/rien par rapport à main/);
    assert.equal(git(depot.bare, ['branch', '--list', 'feature/rien']), '', 'rien de poussé');
    assert.equal((app.state.mrs['grp/local-script'] || []).length, avant, 'pas de merge request');
    assert.equal(git(depot.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });

  test('un agent qui commite lui-même : ses commits repliés en un seul, sous le message du script', async () => {
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Commite toi-même', label: 'Autocommit', branch: 'feature/autocommit', dirs: [depot.work] })).body;
    const fichier = path.join(app.dataDir, 'autocommit.sh');
    fs.writeFileSync(fichier, (await exporter(lt.id)).texte.replace(/^COMMIT_MESSAGE=.*$/m, "COMMIT_MESSAGE='BI-57 Le message choisi'"));
    const commiteur = path.join(app.dataDir, 'agent-commiteur.sh');
    fs.writeFileSync(commiteur, '#!/bin/sh\necho un > UN.md && git add UN.md && git commit -q -m "Message de l agent 1"\necho deux > DEUX.md && git add DEUX.md && git commit -q -m "Message de l agent 2"\necho trois > TROIS.md\n');
    fs.chmodSync(commiteur, 0o755);
    const r = await lancer(fichier, { AGENT_BIN: commiteur, GITLAB_TOKEN: app.state.token });
    assert.equal(r.status, 0, r.stderr);
    const base = git(depot.work, ['merge-base', 'main', 'feature/autocommit']);
    assert.equal(git(depot.work, ['log', '--format=%s', `${base}..feature/autocommit`]), 'BI-57 Le message choisi', 'un seul commit, au message du script');
    assert.deepEqual(git(depot.work, ['show', '--name-only', '--format=', 'feature/autocommit']).split('\n').sort(), ['DEUX.md', 'TROIS.md', 'UN.md']);
    assert.equal(git(depot.bare, ['log', '-1', '--format=%s', 'feature/autocommit']), 'BI-57 Le message choisi', 'c’est lui qui est poussé');
    git(depot.work, ['checkout', '-q', 'main']);
  });

  /* AVEC CONVERGENCE. Le faux agent distingue la relecture (consigne « LECTURE SEULE ») du codage :
     relu, il rend un rapport dont la note est la suivante de SCORES (« - » = pas de note) ;
     appelé pour coder ou corriger, il ajoute une ligne (sauf NOFIX=1, qui ne laisse que le codage). Chaque prompt reçu est gardé, numéroté. */
  describe('avec la boucle de convergence', () => {
    let agentConv; let prompts;
    const recus = () => fs.readdirSync(prompts).filter((f) => f.endsWith('.txt')).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .map((f) => fs.readFileSync(path.join(prompts, f), 'utf8'));
    const exporterConv = async (id) => {
      const r = await fetch(`${app.base}/api/local-tasks/${id}/script?converge=1`, { headers: { Authorization: `Bearer ${app.localToken}` } });
      return { status: r.status, disposition: r.headers.get('content-disposition') || '', texte: await r.text() };
    };
    const preparer = async (label, retouche = (x) => x) => {
      fs.rmSync(prompts, { recursive: true, force: true }); fs.mkdirSync(prompts);
      const lt = (await app.api('POST', '/api/local-tasks', { prompt: `Tâche ${label}`, label, dirs: [depot.work] })).body;
      const fichier = path.join(app.dataDir, `${label}.sh`);
      fs.writeFileSync(fichier, retouche((await exporterConv(lt.id)).texte));
      return fichier;
    };
    const finir = () => {
      fs.rmSync(path.join(depot.work, '.git', 'converge'), { recursive: true, force: true });
      git(depot.work, ['checkout', '-q', 'main']);
    };
    const sansForge = (x) => x.replace(/^PUSH=1$/m, 'PUSH=0').replace(/^CREATE_MR=1$/m, 'CREATE_MR=0');

    before(() => {
      prompts = path.join(app.dataDir, 'prompts-conv');
      agentConv = path.join(app.dataDir, 'faux-agent-conv.sh');
      fs.writeFileSync(agentConv, `#!/bin/sh
for a in "$@"; do last="$a"; done
d='${prompts}'
n=$(ls "$d" | wc -l | tr -d ' ')
printf '%s' "$last" > "$d/$n.txt"
case "$last" in
  *"LECTURE SEULE"*)
    i=$(cat "$d/.reviews" 2>/dev/null || echo 0)
    echo $((i + 1)) > "$d/.reviews"
    s=$(printf '%s' "$SCORES" | cut -d'|' -f$((i + 1)))
    printf '# Revue %s\\n\\nUn défaut & un {source} à corriger dans AGENT_DONE.md.\\n\\n' "$i"
    [ "$s" = - ] || printf '**Note globale : %s/10**\\n' "$s" ;;
  *) [ "$NOFIX" = 1 ] && [ -f "$d/.coded" ] || echo "passe $n" >> AGENT_DONE.md; touch "$d/.coded" ;;
esac
`);
      fs.chmodSync(agentConv, 0o755);
    });

    test('le script se télécharge en « -converge.sh », seuil, plafond et consignes en tête', async () => {
      const lt = (await app.api('POST', '/api/local-tasks', { prompt: PROMPT, label: 'Rangement des imports', dirs: [depot.work] })).body;
      const { status, disposition, texte } = await exporterConv(lt.id);
      assert.equal(status, 200);
      assert.match(disposition, /filename="rangement-des-imports-converge\.sh"/);
      assert.doesNotMatch(texte, /mergerie/i, 'le script ne nomme pas l’outil');
      assert.match(texte, /^CONVERGE=1$/m);
      assert.match(texte, /^THRESHOLD=8$/m, 'le seuil des réglages');
      assert.match(texte, /^MAX_PASSES=3$/m);
      const premiere = (motif) => texte.indexOf(motif);
      for (const m of ['THRESHOLD=', 'REVIEW_PROMPT <<', 'FIX_PROMPT <<', 'REVIEW_ARGS=(']) assert.ok(premiere(m) > 0 && premiere(m) < premiere('json_str()'), `${m} en tête`);
      assert.ok(texte.includes('@REPORT@'), 'la place du rapport dans la consigne de correction');
      assert.equal(spawnSync('bash', ['-n', '-c', texte]).status, 0, 'syntaxe bash valide');
      // Le script simple, lui, n'a rien de la boucle.
      assert.doesNotMatch((await exporter(lt.id)).texte, /CONVERGE=|converge_folder/);
    });

    test('5 → 7 → 9 : deux corrections commitées et poussées, la MR ouverte, convergé au seuil', async () => {
      const fichier = await preparer('Convergence nominale');
      const r = await lancer(fichier, { GITLAB_TOKEN: app.state.token, AGENT_BIN: agentConv, SCORES: '5|7|9' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /Convergé : 9\/10 après 2 correction\(s\)/);
      const branche = 'ai/convergence-nominale';
      assert.equal(git(depot.work, ['rev-list', '--count', `main..${branche}`]), '3', 'la première passe et deux corrections');
      assert.equal(git(depot.bare, ['rev-parse', `refs/heads/${branche}`]), git(depot.work, ['rev-parse', branche]), 'chaque correction est poussée');
      assert.ok((app.state.mrs['grp/local-script'] || []).some((m) => m.source_branch === branche), 'la MR est ouverte');
      const p = recus();
      assert.equal(p.length, 6, 'codage, relecture, correction, relecture, correction, relecture');
      assert.match(p[1], /LECTURE SEULE/);
      assert.match(p[1], /Ce que cette merge request annonce faire/, 'l’intention : le titre de la MR');
      assert.match(p[1], /<<<DONNEE [0-9a-f]{16} titre de la MR>>>\nTâche Convergence nominale\n<<<FIN DONNEE/);
      assert.match(p[1], /\.git\/converge\/diff\.patch/, 'le diff est nommé');
      assert.match(p[2], /=== RAPPORT DE REVUE ===/, 'la consigne de correction des réglages');
      assert.match(p[2], /Note globale : 5\/10/, 'avec le rapport à corriger');
      assert.ok(p[2].includes('Un défaut & un {source} à corriger'), 'le rapport tel quel : ni « & » ni variable remplacés (bash 5.2 compris)');
      assert.match(p[2], /<<<DONNEE [0-9a-f]{16} rapport de revue>>>/, 'balisé comme une donnée');
      assert.match(p[3], /<<<DONNEE [0-9a-f]{16} rapport précédent>>>[\s\S]*Note globale : 5\/10/, 'la relecture suivante voit le rapport d’avant');
      const travail = path.join(depot.work, '.git', 'converge');
      const executions = fs.readdirSync(travail).filter((f) => f.startsWith('ai-convergence-nominale-'));
      assert.equal(executions.length, 1, 'un dossier par exécution, nommé par la branche et la date');
      const rapports = path.join(travail, executions[0]);
      assert.deepEqual(fs.readdirSync(rapports).sort(), ['review-0.md', 'review-1.md', 'review-2.md']);
      for (const n of [0, 1, 2]) assert.ok(r.stderr.includes(`Rapport : ${fs.realpathSync(path.join(rapports, `review-${n}.md`))}`), `le chemin du rapport ${n} affiché`);
      assert.match(r.stderr, /review-0\.md — 5\/10\n\s+review-1\.md — 7\/10\n\s+review-2\.md — 9\/10/, 'le récapitulatif des notes');
      assert.match(fs.readFileSync(path.join(travail, 'diff.patch'), 'utf8'), /\+passe/, 'le diff complet depuis la base, corrections comprises');
      assert.equal(git(depot.work, ['status', '--porcelain']), '', 'rien de la boucle ne traîne dans le dossier');
      finir();
    });

    test('un ticket Jira en tête : son contenu et son commentaire #tech au codage et dans chaque relecture, pas dans les corrections', async () => {
      app.state.jiraIssues['PROJ-77'] = { key: 'PROJ-77', fields: {
        summary: 'Exporter les factures',
        description: 'Le PO veut un export \u00e9tendu.\nAvec un \\ et des "guillemets".',
        comment: { comments: [
          { id: '1', body: 'Reproduit en préprod' },
          { id: '2', body: '  #Tech : passer par le service Facturation' },
          { id: '3', body: '#tech second, ignoré' },
        ] },
      } };
      const avecTicket = (cle, marqueur = null) => (x) => {
        let y = sansForge(x).replace(/^JIRA_TICKET=.*$/m, `JIRA_TICKET='${cle}'`)
          .replace(/^JIRA_URL=.*$/m, `JIRA_URL='${app.gitlabUrl}'`).replace(/^JIRA_EMAIL=.*$/m, "JIRA_EMAIL='moi@exemple.fr'");
        if (marqueur !== null) y = y.replace(/^JIRA_TECH_MARKER=.*$/m, `JIRA_TECH_MARKER='${marqueur}'`);
        return y;
      };

      let fichier = await preparer('Avec ticket', avecTicket('PROJ-77'));
      assert.match(fs.readFileSync(fichier, 'utf8'), /^JIRA_TECH_MARKER='#tech'$/m, 'le marqueur des réglages, en tête');
      let r = await lancer(fichier, { AGENT_BIN: agentConv, SCORES: '5|9', JIRA_TOKEN: 'jeton-jira' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /Ticket PROJ-77 lu/);
      assert.equal(app.state.jiraAuth, `Basic ${Buffer.from('moi@exemple.fr:jeton-jira').toString('base64')}`, 'e-mail et jeton, en Basic');
      let p = recus();
      assert.match(p[0], /Contexte du ticket Jira PROJ-77 :\n\n# Exporter les factures[\s\S]*passer par le service Facturation\n\n---\n\nTâche Avec ticket/, 'le codage reçoit le ticket, devant la demande');
      for (const relecture of [p[1], p[3]]) {
        assert.match(relecture, /Contexte du ticket PROJ-77/);
        assert.match(relecture, /<<<DONNEE [0-9a-f]{16} ticket Jira PROJ-77>>>\n# Exporter les factures\n\nLe PO veut un export étendu\.\nAvec un \\ et des "guillemets"\./, 'balisé comme une donnée, JSON décodé');
        assert.match(relecture, /## Précision technique \(commentaire #tech\)\n\npasser par le service Facturation\n<<<FIN DONNEE/, 'le premier commentaire #tech, sans son marqueur');
        assert.doesNotMatch(relecture, /Reproduit en préprod|second, ignoré/, 'et lui seul');
      }
      assert.doesNotMatch(p[2], /Exporter les factures/, 'ni la correction');
      finir();

      // Un autre marqueur, réglé en tête : le commentaire #tech n'est plus repris.
      fichier = await preparer('Autre marqueur', avecTicket('PROJ-77', '#archi'));
      r = await lancer(fichier, { AGENT_BIN: agentConv, SCORES: '9', JIRA_TOKEN: 'jeton-jira' });
      assert.equal(r.status, 0, r.stderr);
      p = recus();
      assert.match(p[1], /# Exporter les factures/);
      assert.doesNotMatch(p[1], /Précision technique|Facturation/);
      finir();
    });

    test('un ticket illisible ou sans jeton ne bloque pas : la relecture se fait sans lui', async () => {
      const fichier = await preparer('Ticket introuvable', (x) => sansForge(x).replace(/^JIRA_TICKET=.*$/m, "JIRA_TICKET='PROJ-404'")
        .replace(/^JIRA_URL=.*$/m, `JIRA_URL='${app.gitlabUrl}'`).replace(/^JIRA_EMAIL=.*$/m, "JIRA_EMAIL='moi@exemple.fr'"));
      let r = await lancer(fichier, { AGENT_BIN: agentConv, SCORES: '9', JIRA_TOKEN: 'jeton-jira' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /Ticket PROJ-404 illisible \(HTTP 404\) : on continue sans le ticket/);
      assert.doesNotMatch(recus()[0], /Contexte du ticket/, 'le codage part sans le ticket');
      assert.match(r.stderr, /Convergé : 9\/10/);
      assert.doesNotMatch(recus()[1], /ticket Jira/);
      finir();

      // Sans jeton dans l'environnement ni terminal pour le demander : un avertissement, pas un arrêt.
      fs.rmSync(prompts, { recursive: true, force: true }); fs.mkdirSync(prompts);
      r = await lancer(fichier, { AGENT_BIN: agentConv, SCORES: '9' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /Pas de jeton Jira/);
      assert.match(r.stderr, /Convergé : 9\/10/);
      finir();
    });

    test('une note qui baisse arrête la boucle ; sans forge, rien n’est poussé', async () => {
      const fichier = await preparer('Convergence en baisse', sansForge);
      const r = await lancer(fichier, { AGENT_BIN: agentConv, SCORES: '6|5' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /la note a baissé ou stagné \(5\/10 après 6\/10\)/);
      assert.equal(git(depot.work, ['rev-list', '--count', 'main..ai/convergence-en-baisse']), '2');
      assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/ai/convergence-en-baisse'], { cwd: depot.bare }).status, 1, 'PUSH=0 : rien n’est poussé');
      finir();
    });

    test('le plafond, une note absente, une correction sans effet : chacun arrête la boucle', async () => {
      let r = await lancer(await preparer('Convergence plafond', (x) => sansForge(x).replace(/^MAX_PASSES=3$/m, 'MAX_PASSES=1')), { AGENT_BIN: agentConv, SCORES: '4|5' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /plafond de 1 correction\(s\) atteint — note 5\/10/);
      finir();
      r = await lancer(await preparer('Convergence sans note', sansForge), { AGENT_BIN: agentConv, SCORES: '-' });
      assert.match(r.stderr, /ne porte pas de note lisible/);
      assert.equal(recus().length, 2, 'aucune correction sans note');
      finir();
      r = await lancer(await preparer('Convergence sans effet', sansForge), { AGENT_BIN: agentConv, SCORES: '3|9', NOFIX: '1' });
      assert.match(r.stderr, /la correction n’a rien modifié/);
      finir();
    });

    test('REPORTS_DIR : les rapports ailleurs, un dossier par exécution, jamais écrasés ; la consigne de relecture modifiée est celle envoyée', async () => {
      const ailleurs = path.join(app.dataDir, 'rapports-ailleurs');
      const retouche = (x) => sansForge(x).replace(/^REPORTS_DIR=''$/m, `REPORTS_DIR='${ailleurs}'`)
        .replace(/(REVIEW_PROMPT <<'__REVIEW__'[^\n]*\n)/, '$1Consigne maison : regarde les migrations.\n');
      const fichier = await preparer('Rapports ailleurs', retouche);
      const texte = fs.readFileSync(fichier, 'utf8');
      assert.ok(texte.indexOf('REVIEW_PROMPT <<') < texte.indexOf('BASE_BRANCH='), 'la consigne de relecture juste sous la demande');
      for (const scores of ['5|9', '9']) {
        const r = await lancer(fichier, { AGENT_BIN: agentConv, SCORES: scores });
        assert.equal(r.status, 0, r.stderr);
        git(depot.work, ['checkout', '-q', 'main']);
        git(depot.work, ['branch', '-q', '-D', 'ai/rapports-ailleurs']);
        fs.rmSync(path.join(prompts, '.reviews'), { force: true });
      }
      assert.match(recus()[1], /Consigne maison : regarde les migrations\./);
      const base = path.join(ailleurs, path.basename(depot.work));
      const executions = fs.readdirSync(base).sort();
      assert.equal(executions.length, 2, 'la seconde exécution n’écrase pas la première');
      assert.deepEqual(executions.map((e) => fs.readdirSync(path.join(base, e)).sort()), [['review-0.md', 'review-1.md'], ['review-0.md']]);
      assert.equal(git(depot.work, ['status', '--porcelain']), '');
      finir();
    });

    test('le seuil modifié en tête est celui qui arrête', async () => {
      const r = await lancer(await preparer('Convergence seuil', (x) => sansForge(x).replace(/^THRESHOLD=8$/m, 'THRESHOLD=6,5')), { AGENT_BIN: agentConv, SCORES: '6.5' });
      assert.match(r.stderr, /Convergé : 6\.5\/10 après 0 correction\(s\)/);
      finir();
    });
  });
});
