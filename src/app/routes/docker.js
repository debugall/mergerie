'use strict';
/* L’onglet Docker : projets compose, conteneurs orphelins, actions groupées, sauvegardes, cibles Makefile, journaux en direct.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const i18n = require('../../core/i18n');
const { t } = i18n;
const jobs = require('../../jobs');
const docker = require('../../integrations/docker');
const demoDocker = require('../../demo/docker');
const verifyLib = require('../../verify/verify');
const { StringDecoder } = require('node:string_decoder');
const localrepos = require('../../git/localrepos');
const { wrap } = require('../http');

/* ---------- Docker (onglet Docker) ----------
   Deux sources : projets COMPOSE (scan des répertoires locaux) et containers HORS-COMPOSE.
   Cœur : le drift .env, comparé sur l'effectif (docker inspect) vs l'attendu (docker compose
   config). Les actions passent par la file de jobs (log streamé). En démo : données statiques. */
app.get('/api/docker/status', wrap(async (req, res) => {
  res.json(demoDocker.isDemo() ? demoDocker.status() : await docker.status());
}));
app.get('/api/docker/compose', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ projects: demoDocker.composeProjects() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, projects: [] });
  res.json({ projects: await docker.composeProjects(localrepos.roots()) });
}));
// Affichage PROGRESSIF : d'abord la liste légère des fichiers compose (rapide), puis le détail
// de chacun à la demande (/compose/one) → les cartes s'affichent au fur et à mesure.
app.get('/api/docker/compose/list', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ files: demoDocker.composeList() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, files: [] });
  res.json({ files: await docker.composeFileList(localrepos.roots()) });
}));
app.get('/api/docker/compose/one', wrap(async (req, res) => {
  const dir = String(req.query.dir || '');
  const file = String(req.query.file || '');
  if (demoDocker.isDemo()) return res.json({ project: demoDocker.composeProjects().find((p) => p.dir === dir) || null });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, project: null });
  res.json({ project: await docker.composeOne(localrepos.roots(), dir, file) });
}));
app.get('/api/docker/orphans', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ orphans: demoDocker.orphans() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, orphans: [] });
  res.json({ orphans: await docker.orphans() });
}));
// Aperçu d'un `down` (rien n'est exécuté ; les volumes ne sont JAMAIS touchés).
app.post('/api/docker/compose/preview-down', wrap(async (req, res) => {
  const dir = String(req.body && req.body.dir || '');
  if (demoDocker.isDemo()) return res.json(demoDocker.previewDown(req.body && req.body.project));
  if (!dir) throw new Error(t('err.docker.dir-required'));
  jobs.exigerDossierCompose(dir);         // même garde que les actions : pas un dossier quelconque
  res.json(await docker.previewDown(dir));
}));
// Actions compose (up / restart / pull / recreate / down) → file de jobs, log streamé.
app.post('/api/docker/compose/action', wrap((req, res) => {
  const { dir, action, services } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!dir) throw new Error(t('err.docker.dir-required'));
  if (!['up', 'restart', 'stop', 'pull', 'recreate', 'build', 'down'].includes(action)) throw new Error(t('err.docker.unknown-action'));
  res.json(jobs.startDockerJob({ op: 'compose', dir, action, services: Array.isArray(services) ? services : [] }));
}));
/* ---------- B6 : l'état des services compose d'un répertoire ----------
   On lance la vérification « in place », elle meurt en trois secondes sur `ECONNREFUSED 5432`,
   on va dans Docker, on fait Up, on revient, on relance : quatre écrans pour un oubli. La
   fenêtre de confirmation dit donc l'état des services du projet compose que porte CE
   répertoire, au moment du clic. Un `docker ps` à la demande, jamais un sondage — et rien du
   tout si le répertoire ne porte pas de compose. */
app.get('/api/docker/dir-state', wrap(async (req, res) => {
  const dir = String(req.query.dir || '');
  if (!dir) { res.json({ found: false, services: [] }); return; }
  if (demoDocker.isDemo()) { res.json(demoDocker.dirState(dir)); return; }
  try {
    const roots = db.prepare('SELECT * FROM local_root').all();
    const projets = await docker.composeProjects(roots);
    const p = projets.find((x) => x.dir === dir);
    if (!p) { res.json({ found: false, services: [] }); return; }
    res.json({
      found: true, dir, project: p.name,
      services: (p.services || []).map((sv) => ({
        name: sv.name,
        state: sv.container ? (sv.container.state || 'unknown') : 'none',
      })),
    });
  } catch { res.json({ found: false, services: [] }); }
}));
/* La dernière exécution de chaque cible d'un répertoire : « migrate · il y a 40 min · ✓ ».
   Purement local, une ligne par cible, écrasée à chaque lancement. */
app.get('/api/docker/make/runs', wrap((req, res) => {
  const dir = String(req.query.dir || '');
  if (!dir) throw new Error(t('err.docker.dir-required'));
  const out = {};
  for (const r of db.prepare('SELECT * FROM make_run WHERE dir = ?').all(dir)) {
    out[r.target] = { started_at: r.started_at, finished_at: r.finished_at, ok: r.ok };
  }
  res.json({ runs: out });
}));
// Exécute une commande (cible) du Makefile situé à côté du compose → file de jobs, log streamé.
app.post('/api/docker/make/run', wrap((req, res) => {
  const { dir, target } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!dir) throw new Error(t('err.docker.dir-required'));
  if (!target) throw new Error(t('err.docker.target-required'));
  res.json(jobs.startDockerJob({ op: 'make', dir, target }));
}));
// Action groupée : UNE action (up/restart/stop/pull/recreate) appliquée aux services compose
// COCHÉS, groupés par répertoire de projet → un `docker compose` par projet, dans un seul job.
app.post('/api/docker/bulk-action', wrap((req, res) => {
  const { action, targets } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!['up', 'restart', 'stop', 'pull', 'recreate', 'build'].includes(action)) throw new Error(t('err.docker.unknown-action'));
  const list = Array.isArray(targets) ? targets.filter((x) => x && x.dir && x.service) : [];
  if (!list.length) throw new Error(t('err.docker.no-target'));
  const byDir = new Map();
  for (const x of list) { if (!byDir.has(x.dir)) byDir.set(x.dir, []); byDir.get(x.dir).push(String(x.service)); }
  const groups = [...byDir.entries()].map(([dir, services]) => ({ dir, services }));
  res.json(jobs.startDockerJob({ op: 'compose-bulk', action, groups }));
}));
// Commande `docker run` reconstituée depuis l'inspect d'un container hors-compose.
app.get('/api/docker/orphan/:id/reconstitute', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json(demoDocker.reconstituteDemo(id));
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  const det = await docker.inspect(id);
  det.__imageEnv = await docker.imageEnv(det && det.Config && det.Config.Image);
  res.json({ command: docker.reconstructRunCommand(det) });
}));
// Arrêt d'un container hors-compose (sans le supprimer).
app.post('/api/docker/orphan/:id/stop', wrap((req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  res.json(jobs.startDockerJob({ op: 'orphan-stop', id }));
}));
// Suppression d'un container hors-compose : on SAUVEGARDE d'abord son inspect (restauration),
// puis on supprime via la file de jobs.
app.post('/api/docker/orphan/:id/remove', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  const det = await docker.inspect(id);
  det.__imageEnv = await docker.imageEnv(det && det.Config && det.Config.Image);
  db.prepare('INSERT INTO docker_backup (container_id, name, image, inspect_json, run_command, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, String(det.Name || '').replace(/^\//, ''), det.Config && det.Config.Image, JSON.stringify(det), docker.reconstructRunCommand(det), new Date().toISOString());
  res.json(jobs.startDockerJob({ op: 'orphan-remove', id }));
}));
// Sauvegardes d'inspect (restauration des orphelins supprimés).
/* B8 — LA CASE « LOCAL » QUE LE COMPOSE CONNAÎT DÉJÀ. On ajoute `webapp-front` à la grille et
   on tape `localhost:3000` — que le projet compose affiché juste à côté sait déjà, puisqu'il
   publie ce port. On relie le dossier à son dépôt par le remote lu dans `.git/config`, le
   dépôt à son service dans la grille, et on rend l'adresse à poser. Rien n'est écrit sans
   clic : on PROPOSE, la grille reste la vérité. */
app.get('/api/docker/local-links', wrap((req, res) => {
  const dir = String(req.query.dir || '').trim();
  if (!dir) return res.json({ service: null, ports: [] });
  const g = docker.gitDuRepertoire(dir);
  if (!g || !g.remote) return res.json({ service: null, ports: [] });
  const depots = db.prepare('SELECT id, project, url FROM repo').all();
  const cible = depots.find((r) => verifyLib.memeDepot(r.url, g.remote));
  if (!cible) return res.json({ service: null, ports: [] });
  const service = db.prepare('SELECT id, name FROM service WHERE repo_id = ? ORDER BY id LIMIT 1').get(cible.id);
  if (!service) return res.json({ service: null, ports: [] });
  /* L'environnement « local » de la grille, s'il existe : c'est celui que le compose
     renseigne. Sans lui, il n'y a pas de case à remplir — et en créer un d'office
     réarrangerait la grille de quelqu'un sans qu'il l'ait demandé. */
  const env = db.prepare("SELECT id, name FROM environment WHERE LOWER(name) IN ('local','localhost') ORDER BY id LIMIT 1").get();
  const dejaLa = env ? db.prepare('SELECT COUNT(*) c FROM service_url WHERE service_id = ? AND environment_id = ?')
    .get(service.id, env.id).c : 0;
  res.json({
    service: { id: service.id, name: service.name, project: cible.project },
    environment: env || null,
    filled: !!dejaLa,
  });
}));
app.get('/api/docker/backups', wrap((req, res) => {
  res.json(db.prepare('SELECT id, container_id, name, image, run_command, created_at FROM docker_backup ORDER BY id DESC LIMIT 100').all());
}));
/* A/Docker 1 — RESTAURER. La sauvegarde était écrite avant chaque suppression et relue par
   personne. On rejoue l'inspect COMPLET (celui qui porte les vraies variables, pas la ligne
   affichée qui masque les secrets), via la file de jobs comme toute opération Docker. */
app.post('/api/docker/backups/:id/restore', wrap((req, res) => {
  const row = db.prepare('SELECT * FROM docker_backup WHERE id = ?').get(Number(req.params.id));
  if (!row) throw new Error(t('err.docker.backup-not-found'));
  if (demoDocker.isDemo()) return res.json({ demo: true });
  let inspect = null;
  try { inspect = JSON.parse(row.inspect_json || 'null'); } catch { inspect = null; }
  if (!inspect) throw new Error(t('err.docker.backup-unreadable'));
  res.json(jobs.startDockerJob({ op: 'orphan-restore', inspect }));
}));
/* La sauvegarde d'un container qu'on ne compte plus refaire : elle porte des variables
   d'environnement, elle ne doit pas s'accumuler sans qu'on puisse la retirer. */
app.delete('/api/docker/backups/:id', wrap((req, res) => {
  const n = db.prepare('DELETE FROM docker_backup WHERE id = ?').run(Number(req.params.id)).changes;
  if (!n) throw new Error(t('err.docker.backup-not-found'));
  res.json({ ok: true });
}));
// Résumé santé (badge de menu) : nb en erreur (restarting/dead) + nb unhealthy.
app.get('/api/docker/summary', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json(demoDocker.summary());
  const st = await docker.status();
  if (!st.ok) return res.json({ error: 0, unhealthy: 0, total: 0, running: 0, down: true });
  res.json(await docker.summary());
}));
// Liste plate des containers (pour choisir lesquels tailer dans l'onglet Logs).
app.get('/api/docker/containers', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ containers: demoDocker.containers() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, containers: [] }); // démon absent → liste vide, pas un 400
  res.json({ containers: await docker.listContainers() });
}));
// Tail LIVE (SSE) des logs de plusieurs containers. Le filtrage inclure/exclure est fait
// CÔTÉ CLIENT (dynamique, sans relancer le flux). On spawn un `docker logs -f` par container
// et on les TUE dès que le client se déconnecte (fermeture d'onglet, Stop, changement de vue).
/* UN PLAFOND GLOBAL DE FLUX. Chaque flux lance jusqu'à douze `docker logs -f` ; sans plafond,
   des onglets oubliés — ou une page qui les ouvrirait en boucle — empilaient des processus
   jusqu'à épuiser la machine. Quatre flux, c'est deux fois l'usage réel. */
const FLUX_DOCKER_MAX = 4;
let fluxDockerOuverts = 0;
app.get('/api/docker/logs/stream', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const tail = req.query.tail;
  if (!ids.length) { res.status(400).end('no containers'); return; }
  if (fluxDockerOuverts >= FLUX_DOCKER_MAX) {
    res.status(429).json({ error: t('err.docker.too-many-streams', { n: FLUX_DOCKER_MAX }) });
    return;
  }
  fluxDockerOuverts += 1;
  let compte = true;
  req.on('close', () => { if (compte) { compte = false; fluxDockerOuverts -= 1; } });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // pas de buffering proxy : les lignes arrivent en direct
  });
  res.write(': ok\n\n');

  if (demoDocker.isDemo()) { demoDocker.streamLogs(ids, res); return; }

  const children = [];
  let closed = false;
  let hb = null;
  const send = (obj) => { if (!closed) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* socket fermé */ } } };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* déjà mort */ } }
  };
  req.on('close', cleanup);
  hb = setInterval(() => { if (closed) return; try { res.write(': hb\n\n'); } catch { cleanup(); } }, 20000);

  ids.forEach(async (id) => {
    try {
      const child = await docker.spawnLogs(id, tail);
      if (closed) { try { child.kill('SIGKILL'); } catch { /* course : client déjà parti */ } return; }
      children.push(child);
      /* Un StringDecoder par flux, et non `String(chunk)` : un caractère UTF-8 multi-octets
         à cheval sur deux chunks serait sinon décodé en deux moitiés invalides, et chaque
         accent tombant sur une frontière deviendrait un « ￰ ». Le decoder garde l'octet
         orphelin pour le chunk suivant. */
      const dec = { o: new StringDecoder('utf8'), e: new StringDecoder('utf8') };
      const buf = { o: '', e: '' };
      const pump = (chunk, which) => {
        const parts = (buf[which] + dec[which].write(chunk)).split('\n');
        buf[which] = parts.pop();
        /* La ligne part BRUTE, séquences de couleur comprises : c'est le client qui décide
           d'afficher du texte nu (par défaut) ou des couleurs, sans relancer le flux.
           Nettoyer ici interdirait la case à cocher. */
        for (const line of parts) send({ c: id, m: line });
      };
      child.stdout.on('data', (d) => pump(d, 'o'));
      child.stderr.on('data', (d) => pump(d, 'e'));
      child.on('error', (e) => send({ c: id, sys: 'error', m: e.message }));
      child.on('close', () => send({ c: id, sys: 'closed' }));
    } catch (e) {
      send({ c: id, sys: 'error', m: docker.explainDockerError ? docker.explainDockerError(e.message) : e.message });
    }
  });
});
