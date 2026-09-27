'use strict';
/* UN FAUX `docker`, POUR LES TESTS DU MENU DOCKER.
 *
 * Docker peut manquer sur la machine qui lance les tests (et il manque en CI) ; il ne faut
 * de toute façon JAMAIS lancer un vrai `docker compose down` depuis un test. Le serveur choisit
 * son binaire via `DOCKER_BIN` (src/docker.js, `binCandidates`) : on lui en donne un faux.
 *
 * Ce fichier a deux rôles :
 *   - `require`-é par un test : `installerFauxDocker(etat)` écrit l'état (JSON) et un petit
 *     script exécutable qui relance CE fichier avec Node, puis pose `DOCKER_BIN` — à faire
 *     AVANT `startApp()`, car le serveur mémorise le binaire au premier appel ;
 *   - exécuté par le serveur (`node fake-docker.js <args docker>`) : il répond comme le CLI,
 *     en JSON, depuis l'état, et le MODIFIE pour les actions (up, stop, down, rm, run…).
 *     Chaque appel est noté dans un journal : le test juge l'effet sur l'état et les
 *     arguments reçus, jamais un libellé à l'écran.
 *
 * Aucun module de `src/` n'est chargé ici : ce helper peut être requis en tête de fichier. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------------------------------------- côté test ---- */

function installerFauxDocker(etatInitial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faux-docker-'));
  const fichierEtat = path.join(dir, 'etat.json');
  const fichierJournal = path.join(dir, 'appels.ndjson');
  const bin = path.join(dir, 'docker');
  fs.writeFileSync(fichierEtat, JSON.stringify(etatInitial, null, 2));
  fs.writeFileSync(fichierJournal, '');
  // Un script shell plutôt que le .js lui-même : le bit exécutable d'un fichier suivi par git
  // ne survit pas à toutes les copies, celui d'un fichier écrit à l'exécution, si.
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${__filename}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  process.env.DOCKER_BIN = bin;
  process.env.FAUX_DOCKER_ETAT = fichierEtat;
  process.env.FAUX_DOCKER_JOURNAL = fichierJournal;

  const lire = () => JSON.parse(fs.readFileSync(fichierEtat, 'utf8'));
  return {
    dir, bin,
    lire,
    ecrire(etat) { ecrireAtomique(fichierEtat, etat); },
    modifier(fn) { const e = lire(); fn(e); ecrireAtomique(fichierEtat, e); },
    // Les appels reçus, dans l'ordre : [{ args, cwd }].
    appels() {
      return fs.readFileSync(fichierJournal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    viderJournal() { fs.writeFileSync(fichierJournal, ''); },
    conteneur(nom) { return lire().containers.find((c) => c.name === nom) || null; },
    // Les `docker logs -f` lancés et encore vivants.
    fluxVivants() {
      let pids = [];
      try { pids = fs.readFileSync(path.join(dir, 'flux-logs.pids'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
      return pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    },
    nettoyer() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

function ecrireAtomique(fichier, etat) {
  const tmp = `${fichier}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(etat, null, 2));
  fs.renameSync(tmp, fichier);
}

/* Un conteneur de l'état. `project`/`service` absents = hors-compose.
   `created` : date de création (ISO) ; un compose modifié APRÈS elle donne « compose modifié ». */
function conteneur({
  id, name, image, state = 'running', status, project = null, service = null, env = [],
  created = new Date(Date.now() + 3600000).toISOString(), startedAt = new Date(Date.now() - 2 * 3600000).toISOString(),
  health = null, exitCode = 0, oom = false, restarts = 0, ports = '', cmd = [], restart = 'no',
  portBindings = {}, mounts = [],
}) {
  return {
    id, name, image, state, project, service, env, created, startedAt, health, exitCode, oom, restarts,
    ports, cmd, restart, portBindings, mounts,
    status: status || (state === 'running' ? `Up 2 hours${health ? ` (${health})` : ''}` : state === 'exited' ? `Exited (${exitCode}) 5 minutes ago` : state),
  };
}

/* ---------------------------------------------------------- le scénario ----
   Deux projets compose sous une racine locale, et deux conteneurs hors-compose. Chaque service
   est là pour UN état que l'écran doit distinguer :
     boutique/web          en cours, synchro, publie 8080
     boutique/api          en cours, drift config (une valeur visible, un jeton masqué, un ajout), 4 redémarrages
     boutique/worker       en cours, drift image (compose : 2.0, conteneur : 1.0)
     boutique/db           sorti en erreur (code 1)
     boutique/cache        aucun conteneur (non créé)
     monitoring/grafana    en cours, unhealthy, créé AVANT la dernière écriture du compose → « compose modifié »
     monitoring/prometheus redémarre en boucle
     monitoring/alertmanager créé, jamais démarré
     redis-seul            hors-compose, en cours, un mot de passe en variable, une variable héritée de l'image
     vieux-job             hors-compose, arrêté proprement (code 0) */
const PROJETS = {
  boutique: {
    name: 'boutique',
    services: {
      web: { image: 'nginx:1.27', environment: { APP_ENV: 'dev' }, ports: ['8080:80'] },
      api: { image: 'api:3.1', environment: { DB_POOL_SIZE: '25', API_TOKEN: 'jeton-neuf', FEATURE_X: 'true', LOG_LEVEL: 'info' }, ports: ['3000:3000'] },
      worker: { image: 'worker:2.0', environment: {} },
      db: { image: 'postgres:16', environment: { POSTGRES_DB: 'boutique' } },
      cache: { image: 'redis:7', environment: {} },
    },
  },
  monitoring: {
    name: 'monitoring',
    services: {
      grafana: { image: 'grafana:11', environment: {}, ports: ['3001:3000'] },
      prometheus: { image: 'prom:2.5', environment: {} },
      alertmanager: { image: 'alertmanager:0.27', environment: {} },
    },
  },
};

function scenarioDocker() {
  const b = { project: 'boutique' };
  const m = { project: 'monitoring' };
  return {
    version: '99.0.0-faux',
    projects: JSON.parse(JSON.stringify(PROJETS)),
    containers: [
      conteneur({ ...b, id: 'c0web', service: 'web', name: 'boutique-web-1', image: 'nginx:1.27', env: ['APP_ENV=dev', 'PATH=/usr/bin'] }),
      conteneur({ ...b, id: 'c0api', service: 'api', name: 'boutique-api-1', image: 'api:3.1', restarts: 4, env: ['DB_POOL_SIZE=10', 'API_TOKEN=jeton-vieux', 'LOG_LEVEL=info'] }),
      conteneur({ ...b, id: 'c0worker', service: 'worker', name: 'boutique-worker-1', image: 'worker:1.0' }),
      conteneur({ ...b, id: 'c0db', service: 'db', name: 'boutique-db-1', image: 'postgres:16', state: 'exited', exitCode: 1, env: ['POSTGRES_DB=boutique'] }),
      conteneur({ ...m, id: 'c0grafana', service: 'grafana', name: 'monitoring-grafana-1', image: 'grafana:11', health: 'unhealthy', created: '2020-01-01T00:00:00.000Z' }),
      conteneur({ ...m, id: 'c0prom', service: 'prometheus', name: 'monitoring-prometheus-1', image: 'prom:2.5', state: 'restarting', status: 'Restarting (1) 3 seconds ago', exitCode: 1 }),
      conteneur({ ...m, id: 'c0alert', service: 'alertmanager', name: 'monitoring-alertmanager-1', image: 'alertmanager:0.27', state: 'created', status: 'Created' }),
      conteneur({
        id: 'c0redis', name: 'redis-seul', image: 'redis:7', restart: 'unless-stopped',
        env: ['REDIS_PASSWORD=motdepasse-tres-secret', 'PATH=/usr/local/bin', 'MODE=standalone'],
        portBindings: { '6379/tcp': [{ HostIp: '', HostPort: '6379' }] }, ports: '0.0.0.0:6379->6379/tcp',
        cmd: ['redis-server', '--appendonly', 'yes'],
      }),
      conteneur({ id: 'c0job', name: 'vieux-job', image: 'busybox:1', state: 'exited', exitCode: 0 }),
    ],
    images: { 'redis:7': ['PATH=/usr/local/bin'] },
    logs: {},
  };
}

/* Les fichiers compose (et le Makefile de boutique) sous `racine`. Leur CONTENU n'est pas lu :
   le faux `docker compose config` répond depuis l'état, par nom de dossier. Ils doivent
   seulement EXISTER — c'est le scan du disque qui fait apparaître un projet. */
const MAKEFILE = [
  '.PHONY: migrate seed casse',
  '## Applique les migrations',
  'migrate:',
  '\techo migrate > .fait-migrate',
  'seed: ## Injecte les données de démo',
  '\techo seed > .fait-seed',
  'casse: ## Échoue exprès',
  '\texit 3',
  '',
].join('\n');

function ecrireProjetsCompose(racine, { makefile = true } = {}) {
  for (const nom of Object.keys(PROJETS)) {
    const d = path.join(racine, nom);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'compose.yaml'), `name: ${nom}\nservices: {}\n`);
  }
  if (makefile) fs.writeFileSync(path.join(racine, 'boutique', 'Makefile'), MAKEFILE);
  return { boutique: path.join(racine, 'boutique'), monitoring: path.join(racine, 'monitoring') };
}

module.exports = { installerFauxDocker, conteneur, scenarioDocker, ecrireProjetsCompose };

/* ------------------------------------------------------------- côté CLI ---- */

if (require.main === module) {
  cli(process.argv.slice(2));
}

function cli(args) {
  const fichierEtat = process.env.FAUX_DOCKER_ETAT;
  const journal = process.env.FAUX_DOCKER_JOURNAL;
  if (journal) {
    try { fs.appendFileSync(journal, `${JSON.stringify({ args, cwd: path.basename(process.cwd()) })}\n`); } catch { /* journal best-effort */ }
  }
  const sortir = (code, out = '', err = '') => {
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    process.exitCode = code;
  };
  if (args[0] === '--version') { sortir(0, 'Docker version 99.0.0-faux, build test\n'); return; }
  let etat;
  try { etat = JSON.parse(fs.readFileSync(fichierEtat, 'utf8')); } catch (e) { sortir(1, '', `faux docker : état illisible (${e.message})\n`); return; }
  const sauver = () => ecrireAtomique(fichierEtat, etat);
  if (etat.daemonDown) {
    sortir(1, '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
    return;
  }
  const parId = (ref) => etat.containers.find((c) => c.id === ref || c.id.startsWith(ref) || c.name === ref);
  const echec = (etat.echecs || {})[args.slice(0, 2).join(' ')];
  if (echec) { sortir(1, '', `${echec}\n`); return; }

  const [cmd, ...reste] = args;
  if (cmd === 'version') { sortir(0, `${etat.version || '99.0.0-faux'}\n`); return; }

  if (cmd === 'ps') {
    const lignes = etat.containers.map((c) => JSON.stringify({
      ID: c.id, Names: c.name, State: c.state, Status: c.status, Image: c.image, CreatedAt: c.created, Ports: c.ports || '',
      Labels: [c.project && `com.docker.compose.project=${c.project}`, c.service && `com.docker.compose.service=${c.service}`].filter(Boolean).join(','),
    }));
    sortir(0, lignes.length ? `${lignes.join('\n')}\n` : '');
    return;
  }

  if (cmd === 'inspect') {
    const refs = reste.slice(reste.indexOf('--') + 1);
    if (reste[0] === '--format') {
      sortir(0, refs.map((r) => parId(r)).filter(Boolean).map((c) => `${c.id}${'0'.repeat(52)} ${c.oom ? 'true' : 'false'}`).join('\n') + '\n');
      return;
    }
    const c = parId(refs[0]);
    if (!c) { sortir(1, '[]\n', `Error: No such object: ${refs[0]}\n`); return; }
    sortir(0, JSON.stringify([inspectDe(c)]));
    return;
  }

  if (cmd === 'image' && reste[0] === 'inspect') {
    const img = reste[reste.length - 1];
    sortir(0, JSON.stringify((etat.images || {})[img] || []));
    return;
  }

  if (cmd === 'logs') {
    const i = reste.indexOf('--tail');
    const n = i >= 0 ? Number(reste[i + 1]) : 1e9;
    const c = parId(reste[reste.length - 1]);
    const lignes = (c && (etat.logs || {})[c.name]) || [];
    const vues = n > 0 ? lignes.slice(-n) : [];
    for (const l of vues) {
      if (l.startsWith('ERR ')) process.stderr.write(`${l}\n`); else process.stdout.write(`${l}\n`);
    }
    // `-f` : le flux reste ouvert jusqu'à ce que le serveur le tue (plafond de sécurité).
    // Le pid de chaque flux est noté : le test vérifie que le serveur le tue à la fermeture.
    try { fs.appendFileSync(path.join(path.dirname(fichierEtat), 'flux-logs.pids'), `${process.pid}\n`); } catch { /* best-effort */ }
    // Un conteneur listé dans `logsTermines` a fini : son flux se ferme de lui-même.
    if (reste.includes('-f') && !(c && (etat.logsTermines || []).includes(c.name))) setTimeout(() => {}, 120000);
    return;
  }

  if (cmd === 'stop' || cmd === 'rm') {
    const c = parId(reste[reste.length - 1]);
    if (!c) { sortir(1, '', `Error: No such container: ${reste[reste.length - 1]}\n`); return; }
    if (cmd === 'stop') { arreter(c); } else { etat.containers = etat.containers.filter((x) => x !== c); }
    sauver();
    sortir(0, `${c.name}\n`);
    return;
  }

  if (cmd === 'run') {
    const c = conteneurDepuisRun(reste);
    if (etat.containers.some((x) => x.name === c.name)) {
      sortir(1, '', `docker: Error response from daemon: Conflict. The container name "/${c.name}" is already in use.\n`);
      return;
    }
    etat.containers.push(c);
    sauver();
    sortir(0, `${c.id}\n`);
    return;
  }

  if (cmd === 'compose') {
    const projetCle = path.basename(process.cwd());
    const def = (etat.projects || {})[projetCle];
    if (!def) { sortir(1, '', 'no configuration file provided: not found\n'); return; }
    const [sous, ...opts] = reste;
    if (sous === 'config') { sortir(0, JSON.stringify({ name: def.name, services: def.services })); return; }
    const k = opts.indexOf('--');
    const cibles = k >= 0 ? opts.slice(k + 1) : Object.keys(def.services);
    const de = (svc) => etat.containers.find((c) => c.project === def.name && c.service === svc);
    if (sous === 'down') {
      etat.containers = etat.containers.filter((c) => c.project !== def.name);
    } else if (sous === 'stop') {
      for (const s of cibles) { const c = de(s); if (c) arreter(c); }
    } else if (sous === 'restart') {
      for (const s of cibles) { const c = de(s); if (c) { demarrer(c); c.restarts += 1; } }
    } else if (sous === 'pull') {
      process.stdout.write(`Pulling ${cibles.join(', ')}\n`);
    } else if (sous === 'up') {
      for (const s of cibles) {
        const svc = def.services[s];
        if (!svc) { sortir(1, '', `no such service: ${s}\n`); return; }
        let c = de(s);
        if (!c) {
          c = conteneur({ id: `c${Math.random().toString(16).slice(2, 14)}`, name: `${def.name}-${s}-1`, image: svc.image, project: def.name, service: s });
          etat.containers.push(c);
        }
        c.image = svc.image;
        c.env = Object.entries(svc.environment || {}).map(([a, b]) => `${a}=${b}`);
        c.created = new Date(Date.now() + 3600000).toISOString();
        demarrer(c);
      }
    } else { sortir(1, '', `faux docker : compose ${sous} non simulé\n`); return; }
    sauver();
    sortir(0, `compose ${sous} ok\n`);
    return;
  }

  sortir(1, '', `faux docker : commande non simulée : ${args.join(' ')}\n`);
}

function arreter(c) { c.state = 'exited'; c.exitCode = 0; c.health = null; c.status = 'Exited (0) 1 second ago'; }
function demarrer(c) { c.state = 'running'; c.exitCode = 0; c.status = 'Up 1 second'; c.startedAt = new Date().toISOString(); }

function inspectDe(c) {
  return {
    Id: `${c.id}${'0'.repeat(52)}`,
    Name: `/${c.name}`,
    Created: c.created,
    RestartCount: c.restarts,
    Config: { Env: c.env, Image: c.image, Cmd: c.cmd && c.cmd.length ? c.cmd : null },
    HostConfig: { RestartPolicy: { Name: c.restart || 'no' }, PortBindings: c.portBindings || {} },
    Mounts: c.mounts || [],
    State: {
      Status: c.state, ExitCode: c.exitCode, OOMKilled: !!c.oom, StartedAt: c.startedAt,
      ...(c.health ? { Health: { Status: c.health } } : {}),
    },
  };
}

// `run -d --name N --restart R -p H:C -v S:D -e K=V image [cmd…]` → un conteneur hors-compose.
function conteneurDepuisRun(a) {
  const c = { env: [], portBindings: {}, mounts: [], cmd: [] };
  let i = 0;
  while (i < a.length) {
    const x = a[i];
    if (x === '-d') { i += 1; continue; }
    if (x === '--name') { c.name = a[i + 1]; i += 2; continue; }
    if (x === '--restart') { c.restart = a[i + 1]; i += 2; continue; }
    if (x === '-e') { c.env.push(a[i + 1]); i += 2; continue; }
    if (x === '-p') {
      const m = String(a[i + 1]).match(/^(?:(.*):)?(\d+):(\d+\/\w+)$/) || [];
      if (m[3]) c.portBindings[m[3]] = [{ HostIp: '', HostPort: m[2] }];
      i += 2; continue;
    }
    if (x === '-v') { const [s, d] = String(a[i + 1]).split(':'); c.mounts.push({ Type: 'bind', Source: s, Destination: d, RW: true }); i += 2; continue; }
    break;
  }
  c.image = a[i];
  c.cmd = a.slice(i + 1);
  return conteneur({
    id: `r${Math.random().toString(16).slice(2, 14)}`, name: c.name || `restaure-${Date.now()}`, image: c.image,
    env: c.env, cmd: c.cmd, restart: c.restart || 'no', portBindings: c.portBindings, mounts: c.mounts,
  });
}
