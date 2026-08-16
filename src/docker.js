'use strict';
/* Onglet Docker — deux sources, un même écran (comme Codage/Exploration en Dev IA) :
 *   - COMPOSE   : les répertoires locaux (Réglages → Dépôts) sont scannés pour les fichiers
 *                 compose ; chaque fichier = un « projet compose » avec ses services.
 *   - HORS-COMPOSE : `docker ps -a` ; les containers sans label com.docker.compose.project
 *                    sont des orphelins de compose.
 *
 * Le cœur : le DRIFT .env, comparé sur l'EFFECTIF vs l'ATTENDU (jamais des hashes) :
 *   - attendu  : `docker compose config --format json` (Compose résout ${VAR}, env_file,
 *                overrides — on ne parse JAMAIS les .env à la main) ;
 *   - effectif : `docker inspect` du container (.Config.Env, image, ports, mounts) ;
 *   - diff → badge NOMINATIF par service (variables ajoutées/modifiées/supprimées, listées).
 *
 * Exécution : on shelle le CLI `docker` (comme git et l'agent), `--format json` partout.
 * Aucune lib cliente, zéro dépendance. */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('./git'); // spawn générique { stdout, stderr }, redaction incluse
const { pMap } = require('./pmap');

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

// ---- CLI ----
// Le binaire `docker` peut être ABSENT du PATH du SERVEUR alors qu'il marche dans le shell
// interactif (serveur lancé via GUI/systemd/PATH réduit ; Docker Desktop range le CLI hors
// des chemins par défaut). On tente donc : DOCKER_BIN explicite → `docker` (PATH) → emplacements
// absolus usuels (Mac/WSL/Linux). Le repli n'est essayé que si `docker` échoue en ENOENT.
let _resolvedBin = null;
function absCandidates() {
  return [
    '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker', '/bin/docker',
    process.env.HOME && path.join(process.env.HOME, '.docker/bin/docker'),
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ].filter(Boolean);
}
// Candidats de binaire, dans l'ordre : DOCKER_BIN (nettoyé) → `docker` du PATH → emplacements usuels.
function binCandidates() {
  const list = [];
  const explicit = String(process.env.DOCKER_BIN || '').trim().replace(/^["']|["']$/g, '');
  if (explicit) list.push(explicit);
  list.push('docker');
  for (const p of absCandidates()) if (!list.includes(p)) list.push(p);
  return list;
}
// Résout le binaire en TESTANT `<bin> --version` (n'a pas besoin du démon). Un ENOENT = binaire
// absent → candidat suivant ; toute autre issue (existe) fige le choix. Mémoïsé.
async function resolveBin() {
  if (_resolvedBin) return { bin: _resolvedBin, tried: [_resolvedBin] };
  const tried = [];
  for (const cand of binCandidates()) {
    tried.push(cand);
    try { await run(cand, ['--version']); _resolvedBin = cand; return { bin: cand, tried }; }
    catch (e) { if (!/ENOENT/i.test(String(e && e.message))) { _resolvedBin = cand; return { bin: cand, tried }; } }
  }
  return { bin: null, tried };
}
async function docker(args, opts = {}) {
  const { bin, tried } = await resolveBin();
  if (!bin) { const err = new Error('DOCKER_BINARY_NOT_FOUND'); err.tried = tried; throw err; }
  return run(bin, args, opts);
}

// Erreur démon injoignable → message ACTIONNABLE (l'erreur n°1 en WSL / Docker Desktop éteint),
// dans l'esprit des messages certificat/token.
function explainDockerError(msg) {
  const m = String(msg || '');
  // Binaire docker introuvable — UNIQUEMENT l'échec de spawn du binaire lui-même. Un simple
  // « not found » dans la SORTIE d'une commande docker qui a bien tourné (fichier compose
  // invalide, env_file absent, service inconnu…) ne doit PAS être confondu avec ça.
  if (/spawn\b[^\n]*\bENOENT\b|(?:^|[\s:])command not found/i.test(m)) {
    return 'Docker CLI introuvable dans le PATH du SERVEUR (il peut marcher dans ton shell mais pas dans le process Node). '
      + 'Solutions : lance le serveur depuis un shell où `docker` est dispo, ou pointe le binaire via DOCKER_BIN=/chemin/vers/docker dans le .env (ex. `which docker`).';
  }
  if (/Cannot connect to the Docker daemon|daemon.*not running|pipe.*docker_engine|\/var\/run\/docker\.sock|is the docker daemon running/i.test(m)) {
    return 'Le démon Docker n’est pas joignable. Démarre Docker Desktop (ou `sudo service docker start` sous WSL) puis réessaie.';
  }
  if (/permission denied/i.test(m)) {
    return 'Accès refusé au démon Docker. Ajoute ton utilisateur au groupe `docker` (puis relance la session), ou lance le serveur avec les droits requis.';
  }
  return m.slice(0, 300);
}

async function status() {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
    return { ok: true, version: stdout.trim(), bin: _resolvedBin };
  } catch (e) {
    const dockerBin = String(process.env.DOCKER_BIN || '').trim() || null;
    if (e && e.message === 'DOCKER_BINARY_NOT_FOUND') {
      return {
        ok: false, bin: null, dockerBin, tried: e.tried || [],
        error: `Aucun binaire docker exécutable trouvé. Essayés : ${(e.tried || []).join(', ')}. `
          + `DOCKER_BIN vu par le serveur = ${dockerBin || '(non défini — .env pas chargé ? serveur pas redémarré ?)'}. `
          + `Corrige DOCKER_BIN avec le résultat de \`which docker\` puis REDÉMARRE le serveur.`,
      };
    }
    // Le binaire existe mais l'appel a échoué (le plus souvent : démon éteint).
    return { ok: false, bin: _resolvedBin, dockerBin, error: explainDockerError(e.message) };
  }
}

// ---- Parsing / logique PURE (testable sans démon) ----

// Une variable dont le NOM est sensible : on signale le changement sans jamais montrer la
// valeur (comme le token GitLab masqué dans les logs).
function isSecretName(name) {
  return /(pass(word|wd)?|secret|token|api[_-]?key|_key$|^key$|credential|private)/i.test(String(name || ''));
}

// ["K=V", "A=b=c"] → { K:'V', A:'b=c' }.
function envArrayToMap(arr) {
  const out = {};
  for (const line of arr || []) {
    const s = String(line);
    const i = s.indexOf('=');
    if (i === -1) { out[s] = ''; continue; }
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

// L'`environment` d'un service compose peut être un objet {K:V} ou un tableau ["K=V"].
function serviceExpectedEnv(service) {
  const env = service && service.environment;
  if (Array.isArray(env)) return envArrayToMap(env);
  if (env && typeof env === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(env)) out[k] = v == null ? '' : String(v);
    return out;
  }
  return {};
}

/* Diff attendu → effectif. On ignore les variables héritées de l'IMAGE (présentes dans
   l'effectif mais jamais déclarées par compose) : elles ne sont pas un « drift » de config,
   elles font partie de l'image. On ne signale donc que ce que compose PILOTE. */
function diffEnv(expected, effective) {
  const diffs = [];
  for (const [name, want] of Object.entries(expected)) {
    const has = Object.prototype.hasOwnProperty.call(effective, name);
    const masked = isSecretName(name);
    if (!has) {
      diffs.push({ name, kind: 'added', masked, ...(masked ? {} : { to: String(want) }) });
    } else if (String(effective[name]) !== String(want)) {
      diffs.push({ name, kind: 'modified', masked, ...(masked ? {} : { from: String(effective[name]), to: String(want) }) });
    }
  }
  // « supprimée » = pilotée par le container mais retirée de compose. On la détecte via les
  // variables que compose déclarait au démarrage (labels) — à défaut, non calculable de façon
  // fiable (l'effectif contient les vars d'image), donc on s'appuie sur l'attendu courant.
  return diffs;
}

// L'image a-t-elle bougé : le tag/référence demandé par compose ≠ celui du container.
function imageDrift(composeImage, containerImage) {
  if (!composeImage || !containerImage) return false;
  return String(composeImage) !== String(containerImage);
}

/* Badge d'un service. Ordre de priorité : absent > drift config > drift image > compose modifié
   > synchro. `createdAt`/`composeMtime` en ms. */
function serviceBadge({ container, envDiffs, imgDrift, composeModified }) {
  if (!container) return 'missing';
  if (container.state && container.state !== 'running') return 'stopped';
  if (envDiffs && envDiffs.length) return 'drift-config';
  if (imgDrift) return 'drift-image';
  if (composeModified) return 'compose-modified';
  return 'synced';
}

/* Traduit un `docker inspect` (objet) en commande `docker run` LISIBLE — le filet de
   restauration des containers hors-compose : sans définition déclarative, ce JSON est la
   seule trace pour régénérer un run équivalent (esprit des suppressions de branches restaurables). */
function reconstructRunCommand(inspect) {
  if (!inspect) return '';
  const cfg = inspect.Config || {};
  const host = inspect.HostConfig || {};
  const name = String(inspect.Name || '').replace(/^\//, '');
  const parts = ['docker run -d'];
  if (name) parts.push(`--name ${name}`);
  if (host.RestartPolicy && host.RestartPolicy.Name && host.RestartPolicy.Name !== 'no') {
    parts.push(`--restart ${host.RestartPolicy.Name}`);
  }
  // Ports publiés.
  const pb = (host.PortBindings) || {};
  for (const [containerPort, binds] of Object.entries(pb)) {
    for (const b of (binds || [])) {
      const hostPart = [b.HostIp, b.HostPort].filter(Boolean).join(':');
      parts.push(`-p ${hostPart ? `${hostPart}:` : ''}${containerPort}`);
    }
  }
  // Volumes / bind-mounts.
  for (const m of (inspect.Mounts || [])) {
    if (m.Type === 'bind') parts.push(`-v ${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
    else if (m.Type === 'volume' && m.Name) parts.push(`-v ${m.Name}:${m.Destination}`);
  }
  // Variables d'environnement EXPLICITES : on écarte celles qui viennent de l'image (mêmes
  // clés/valeurs que l'image), et on masque les valeurs sensibles.
  const imgEnv = envArrayToMap((inspect.__imageEnv) || []);
  for (const line of (cfg.Env || [])) {
    const i = String(line).indexOf('=');
    const k = i === -1 ? line : line.slice(0, i);
    const v = i === -1 ? '' : line.slice(i + 1);
    if (Object.prototype.hasOwnProperty.call(imgEnv, k) && imgEnv[k] === v) continue; // hérité de l'image
    parts.push(isSecretName(k) ? `-e ${k}=***` : `-e ${k}=${/\s/.test(v) ? `"${v}"` : v}`);
  }
  parts.push(cfg.Image || (inspect.Image || 'image'));
  // Commande explicite (si différente de l'entrypoint par défaut de l'image).
  if (Array.isArray(cfg.Cmd) && cfg.Cmd.length) parts.push(cfg.Cmd.join(' '));
  return parts.join(' \\\n  ');
}

// Labels d'une ligne `docker ps --format json` : "k1=v1,k2=v2" → { k1:'v1', ... }.
function parseLabels(str) {
  const out = {};
  for (const kv of String(str || '').split(',')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i === -1) out[kv] = ''; else out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// ---- Découverte ----

// Répertoires locaux déclarés (Réglages → Dépôts) : on y cherche des fichiers compose, à la
// racine ET dans les sous-dossiers directs (un dépôt = un dossier).
function composeFilesUnder(rootPath) {
  const found = [];
  const check = (dir) => {
    for (const f of COMPOSE_FILES) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).isFile()) { found.push({ dir, file: f, path: p }); return; } } catch { /* absent */ }
    }
  };
  check(rootPath);
  let entries = [];
  try { entries = fs.readdirSync(rootPath, { withFileTypes: true }); } catch { /* illisible */ }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) check(path.join(rootPath, e.name));
  }
  return found;
}

async function composeConfig(dir) {
  const { stdout } = await docker(['compose', 'config', '--format', 'json'], { cwd: dir });
  return JSON.parse(stdout);
}

// ---- Makefile à côté du compose : lister/rechercher/exécuter ses commandes ----
const MAKEFILE_NAMES = ['Makefile', 'makefile', 'GNUmakefile'];
const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // pas de « - » en tête (anti flag-smuggling)

function makefileIn(dir) {
  for (const n of MAKEFILE_NAMES) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* absent */ }
  }
  return null;
}

/* Extrait les CIBLES (commandes) d'un Makefile, avec leur description quand elle suit la
   convention répandue `cible: ## description` (ou une ligne `## description` juste avant).
   On ignore les affectations de variables (`VAR :=`), les règles-motif (`%.o:`), `.PHONY`… */
function parseMakefileTargets(content) {
  const targets = []; const seen = new Set();
  let pendingDesc = ''; let current = null;
  for (const raw of String(content || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    // Recette : lignes indentées par TABULATION sous la cible → son « contenu ».
    if (current && /^\t/.test(line)) { current.recipe.push(line.replace(/^\t/, '')); continue; }
    const dc = line.match(/^\s*##\s?(.*)$/); // ligne de description autonome
    if (dc) { pendingDesc = dc[1].trim(); current = null; continue; }
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*)\s*:(?!=)/); // cible: (mais pas VAR:=)
    if (m) {
      const name = m[1];
      if (name !== '.PHONY') {
        if (!seen.has(name)) {
          const inline = line.match(/##\s?(.*)$/);
          const desc = inline ? inline[1].trim() : pendingDesc;
          const t = { name, desc, recipe: [] };
          seen.add(name); targets.push(t); current = t;
        } else { current = targets.find((x) => x.name === name) || null; }
      } else { current = null; }
      pendingDesc = '';
      continue;
    }
    if (line.trim() && !/^\s*#/.test(line)) current = null; // ligne « normale » → fin de recette
    pendingDesc = '';
  }
  for (const t of targets) t.recipe = t.recipe.join('\n'); // recette en texte
  return targets;
}

function makefileFor(dir) {
  const p = makefileIn(dir);
  if (!p) return null;
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch { return null; }
  return { path: p, file: path.basename(p), targets: parseMakefileTargets(content) };
}

async function runMake(dir, target, onLog) {
  if (!SAFE_TARGET.test(String(target || ''))) throw new Error(`Cible make invalide : ${target}`);
  // On n'exécute QUE des cibles réellement présentes dans le Makefile (liste blanche).
  const mk = makefileFor(dir);
  if (!mk || !mk.targets.some((t) => t.name === target)) throw new Error(`Cible make introuvable : ${target}`);
  await run('make', [target], { cwd: dir, onLog });
  return { ok: true };
}

async function psAll() {
  const { stdout } = await docker(['ps', '-a', '--format', 'json']);
  // Docker sort UN objet JSON par ligne (NDJSON).
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function inspect(id) {
  if (!validRef(id)) throw new Error(`Identifiant de container invalide : ${id}`);
  const { stdout } = await docker(['inspect', '--', id]); // `--` : id jamais lu comme un flag
  const arr = JSON.parse(stdout);
  return Array.isArray(arr) ? arr[0] : arr;
}

// Liste plate de TOUS les containers (démarrés ou non), pour l'onglet Logs : on tail par ID
// (stable, sûr) mais on affiche le nom lisible. Triés : en cours d'abord, puis par nom.
async function listContainers() {
  const rows = await psAll();
  return rows.map((r) => {
    const labels = parseLabels(r.Labels);
    const name = String(r.Names || '').split(',')[0].trim() || r.ID;
    const state = String(r.State || '');
    return {
      id: r.ID,
      name,
      state,
      status: String(r.Status || ''),
      image: String(r.Image || ''),
      project: labels['com.docker.compose.project'] || null,
      service: labels['com.docker.compose.service'] || null,
      running: state === 'running',
    };
  }).sort((a, b) => (a.running === b.running ? a.name.localeCompare(b.name) : (a.running ? -1 : 1)));
}

/* Compteurs de santé pour le badge de l'onglet Docker. Trois familles, comptées
   séparément (le badge décide ensuite quoi additionner et de quelle couleur) :
     error     restarting (crash-loop) ou dead — cassé
     exited    arrêté proprement — pas cassé, mais pas là non plus
     unhealthy healthcheck KO, lu dans le Status « Up … (unhealthy) »
   Un container ne compte QUE dans la première famille qui le prend : restarting ET
   unhealthy reste une erreur, pas deux lignes. Pur → testable sans démon. */
/* Code de sortie d'un container arrêté, lu dans son Status (« Exited (137) 2 hours ago »).
   `null` quand on ne sait pas — Docker ne le fournit pas toujours sous cette forme. */
function exitCodeOf(status) {
  const m = /exited\s*\((\d+)\)/i.exec(String(status || ''));
  return m ? Number(m[1]) : null;
}

function healthSummary(containers) {
  let error = 0; let exited = 0; let crashed = 0; let unhealthy = 0;
  for (const c of containers || []) {
    const state = String(c.state || '').toLowerCase();
    const status = String(c.status || '').toLowerCase();
    if (state === 'restarting' || state === 'dead') error += 1;
    // `exited` reste un compteur À PART de `error` : un container arrêté n'est pas cassé,
    // et confondre les deux effacerait la différence entre « je l'ai arrêté » et
    // « il redémarre en boucle ». C'est le badge qui décide quoi additionner.
    else if (state === 'exited') {
      exited += 1;
      /* Un arrêt PROPRE (code 0) n'est pas une anomalie : c'est le plus souvent « je l'ai
         arrêté moi-même », ou un job qui a fini son travail. Le compter en rouge, c'est une
         alarme qui sonne tous les jours — et une alarme qui sonne toujours n'est plus lue.
         Seule une sortie en erreur rejoint le rouge ; un code inconnu reste hors alarme,
         parce qu'on ne crie pas au loup sur une supposition. */
      if (exitCodeOf(c.status) > 0) crashed += 1;
    } else if (status.includes('(unhealthy)') || /\bunhealthy\b/.test(status)) unhealthy += 1;
  }
  return { error, exited, crashed, unhealthy };
}

// Résumé santé de TOUS les containers (compose + hors-compose), pour le badge de menu.
async function summary() {
  const containers = await listContainers();
  return {
    ...healthSummary(containers),
    total: containers.length,
    running: containers.filter((c) => c.running).length,
  };
}

// Tail LIVE des logs d'un container : renvoie le process `docker logs -f`. L'appelant câble
// stdout/stderr (beaucoup d'apps loguent sur stderr) vers le flux SSE et le TUE à la
// déconnexion du client. `--tail N` borne l'historique initial ; `--` protège l'id.
async function spawnLogs(id, tail) {
  if (!validRef(id)) throw new Error(`Identifiant de container invalide : ${id}`);
  const n = Math.min(Math.max(parseInt(tail, 10) || 0, 0), 10000);
  const { bin, tried } = await resolveBin();
  if (!bin) { const err = new Error('DOCKER_BINARY_NOT_FOUND'); err.tried = tried; throw err; }
  return spawn(bin, ['logs', '-f', '--tail', String(n), '--', id]);
}

async function imageEnv(image) {
  if (!image || /^-/.test(String(image))) return []; // pas de référence d'image en flag
  try {
    const { stdout } = await docker(['image', 'inspect', '--format', '{{json .Config.Env}}', '--', image]);
    return JSON.parse(stdout) || [];
  } catch { return []; }
}

/* Un projet compose : services + drift par service. `rootLabel` sert d'affichage. */
/* `pMap` vit maintenant dans son propre module : l'activité des dépôts en a le même besoin
   (borner les appels à la forge), et deux copies d'un ordonnanceur finissent par diverger. */

// Nom de projet compose PAR DÉFAUT (quand le compose ne le fixe pas) = basename du dossier
// « sanitisé » comme le fait Docker Compose. Sert au tri/rattachement RAPIDE (liste), sans
// lancer `docker compose config`.
function defaultProjectName(dir) {
  return path.basename(String(dir || '')).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

async function composeProject({ dir, file, path: composePath, rootLabel }, sharedPs) {
  let cfg;
  try { cfg = await composeConfig(dir); }
  catch (e) { return { dir, file, path: composePath, rootLabel, error: explainDockerError(e.message), services: [], makefile: makefileFor(dir) }; }
  const projectName = cfg.name || path.basename(dir);
  const composeMtime = (() => { try { return fs.statSync(composePath).mtimeMs; } catch { return 0; } })();

  // `docker ps -a` PARTAGÉ quand on traite plusieurs projets (sinon un appel par projet).
  const ps = sharedPs || await psAll().catch(() => []);
  const byService = new Map();
  for (const c of ps) {
    const labels = parseLabels(c.Labels);
    if (labels['com.docker.compose.project'] === projectName) byService.set(labels['com.docker.compose.service'], c);
  }

  // Les `docker inspect` des services d'un projet en PARALLÈLE (au lieu d'un par un).
  const services = await Promise.all(Object.entries(cfg.services || {}).map(async ([svcName, svc]) => {
    const psRow = byService.get(svcName);
    let container = null; let envDiffs = []; let imgDrift = false; let composeModified = false;
    if (psRow) {
      const det = await inspect(psRow.ID).catch(() => null);
      const state = (psRow.State || (det && det.State && det.State.Status) || '').toLowerCase();
      const effective = det ? envArrayToMap(det.Config && det.Config.Env) : {};
      envDiffs = diffEnv(serviceExpectedEnv(svc), effective);
      imgDrift = imageDrift(svc.image, det && det.Config && det.Config.Image);
      const createdMs = det && det.Created ? Date.parse(det.Created) : 0;
      composeModified = composeMtime > 0 && createdMs > 0 && composeMtime > createdMs;
      const health = det && det.State && det.State.Health ? det.State.Health.Status : null; // healthy/unhealthy/starting
      /* `exitCode` vient de l'inspect, pas du texte du Status : c'est un entier, donc fiable,
         et c'est lui qui distingue « je l'ai arrêté » (0) d'un plantage. */
      const exitCode = det && det.State && det.State.ExitCode != null ? Number(det.State.ExitCode) : null;
      container = { id: psRow.ID, name: (psRow.Names || '').split(',')[0], state, health, exitCode, image: det && det.Config && det.Config.Image, created: det && det.Created };
    }
    const badge = serviceBadge({ container, envDiffs, imgDrift, composeModified });
    return { name: svcName, image: svc.image || null, container, envDiffs, imgDrift, composeModified, badge };
  }));
  return { name: projectName, dir, file, path: composePath, rootLabel, error: null, services, makefile: makefileFor(dir) };
}

// Tous les projets compose. UN SEUL `docker ps -a` partagé + projets calculés en parallèle borné.
async function composeProjects(roots) {
  const hits = [];
  for (const root of roots || []) {
    for (const hit of composeFilesUnder(root.path)) hits.push({ ...hit, rootLabel: root.label || root.path });
  }
  const ps = await psAll().catch(() => []);
  return pMap(hits, 6, (hit) => composeProject(hit, ps));
}

// LISTE LÉGÈRE des fichiers compose pour l'affichage PROGRESSIF : un scan de dossiers + UN
// `docker ps -a` (aucun `compose config`/`inspect`). Donne un nom provisoire (basename), le
// nombre de containers et la date du plus récent → tri « activité récente d'abord » côté serveur.
async function composeFileList(roots) {
  const hits = [];
  for (const root of roots || []) {
    for (const hit of composeFilesUnder(root.path)) hits.push({ ...hit, rootLabel: root.label || root.path });
  }
  const ps = await psAll().catch(() => []);
  const byProj = new Map();
  for (const c of ps) {
    const p = parseLabels(c.Labels)['com.docker.compose.project'];
    if (!p) continue;
    if (!byProj.has(p)) byProj.set(p, []);
    byProj.get(p).push(c);
  }
  const ms = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : 0; };
  return hits.map((h) => {
    const name = defaultProjectName(h.dir);
    const cs = byProj.get(name) || [];
    return { name, dir: h.dir, file: h.file, path: h.path, rootLabel: h.rootLabel, count: cs.length, recent: cs.reduce((m, c) => Math.max(m, ms(c.CreatedAt)), 0) };
  }).sort((a, b) => b.recent - a.recent);
}

// UN projet compose, à la demande (affichage progressif). Valide que (dir, file) est bien un
// fichier compose CONNU sous les racines déclarées — le client ne peut pas faire inspecter un
// dossier arbitraire.
async function composeOne(roots, dir, file) {
  let hit = null;
  for (const root of roots || []) {
    for (const h of composeFilesUnder(root.path)) {
      if (h.dir === dir && h.file === file) { hit = { ...h, rootLabel: root.label || root.path }; break; }
    }
    if (hit) break;
  }
  if (!hit) throw new Error('Fichier compose inconnu.');
  return composeProject(hit);
}

// Containers hors-compose : ceux sans label com.docker.compose.project.
async function orphans() {
  const ps = await psAll();
  return ps
    .filter((c) => !parseLabels(c.Labels)['com.docker.compose.project'])
    .map((c) => ({
      id: c.ID,
      name: (c.Names || '').split(',')[0],
      image: c.Image,
      state: (c.State || '').toLowerCase(),
      status: c.Status,
      ports: c.Ports || '',
      created: c.CreatedAt,
    }));
}

// Id/nom de container ou de service SÛR : jamais commençant par « - » (sinon `docker` le lit
// comme un flag — « argv flag smuggling »). On refuse ici plutôt que de laisser une valeur du
// client se transformer en option de commande.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function validRef(s) { return SAFE_REF.test(String(s || '')); }
function assertServices(services) {
  const svc = (Array.isArray(services) ? services : []).filter(Boolean);
  for (const s of svc) if (!validRef(s)) throw new Error(`Nom de service invalide : ${s}`);
  return svc;
}

// ---- Actions (exécutées via la file de jobs, log streamé) ----
// `--` sépare TOUJOURS les options des noms de service positionnels (défense flag-smuggling).
function composeArgs(dir, action, services) {
  const svc = assertServices(services);
  const tail = svc.length ? ['--', ...svc] : [];
  switch (action) {
    case 'up': return ['compose', 'up', '-d', ...tail];
    case 'restart': return ['compose', 'restart', ...tail];
    case 'stop': return ['compose', 'stop', ...tail]; // arrête sans supprimer (≠ down)
    case 'pull': return ['compose', 'pull', ...tail];
    // L'action qui DÉCOULE du badge de drift : recrée seulement les services visés.
    case 'recreate': return ['compose', 'up', '-d', '--force-recreate', ...tail];
    // Build : reconstruit l'image PUIS recrée le container (applique un changement de Dockerfile).
    case 'build': return ['compose', 'up', '-d', '--build', ...tail];
    default: throw new Error(`Action compose inconnue : ${action}`);
  }
}

async function runCompose(dir, action, services, onLog) {
  const args = composeArgs(dir, action, services);
  await docker(args, { cwd: dir, onLog });
  return { ok: true };
}

/* Aperçu d'un `down` : ce qui sera ARRÊTÉ, sans jamais toucher aux volumes (pas de -v par
   défaut — un volume, c'est des données). On ne fait que LISTER. */
async function previewDown(dir) {
  let cfg;
  try { cfg = await composeConfig(dir); } catch (e) { throw new Error(explainDockerError(e.message)); }
  const projectName = cfg.name || path.basename(dir);
  const ps = await psAll().catch(() => []);
  const containers = ps
    .filter((c) => parseLabels(c.Labels)['com.docker.compose.project'] === projectName)
    .map((c) => ({ name: (c.Names || '').split(',')[0], service: parseLabels(c.Labels)['com.docker.compose.service'], state: (c.State || '').toLowerCase() }));
  return { project: projectName, containers, volumes_preserved: true };
}

async function runDown(dir, onLog) {
  // JAMAIS `-v` : on n'efface pas les volumes.
  await docker(['compose', 'down'], { cwd: dir, onLog });
  return { ok: true };
}

// Arrêt d'un container hors-compose (sans le supprimer).
async function stopContainer(id, onLog) {
  if (!validRef(id)) throw new Error(`Identifiant de container invalide : ${id}`);
  await docker(['stop', '--', id], { onLog });
  return { ok: true };
}

// Suppression d'un container hors-compose (l'inspect a déjà été sauvegardé côté serveur).
async function removeContainer(id, onLog) {
  if (!validRef(id)) throw new Error(`Identifiant de container invalide : ${id}`);
  await docker(['rm', '-f', '--', id], { onLog }); // `--` : id jamais lu comme un flag
  return { ok: true };
}

module.exports = {
  status, explainDockerError,
  composeProjects, composeFileList, composeOne, orphans, previewDown, runCompose, runDown, stopContainer, removeContainer, composeArgs,
  inspect, imageEnv, reconstructRunCommand, makefileFor, runMake, listContainers, spawnLogs, summary,
  // pur (tests) :
  isSecretName, exitCodeOf, envArrayToMap, serviceExpectedEnv, diffEnv, imageDrift, serviceBadge, parseLabels, composeFilesUnder, parseMakefileTargets, validRef, healthSummary, defaultProjectName, COMPOSE_FILES,
};
