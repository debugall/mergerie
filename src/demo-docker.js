'use strict';
const { healthSummary } = require('./docker');
/* Données Docker STATIQUES pour le mode démo (MERGERIE_DEMO=1), sur le modèle de demo-git.js.
   L'onglet Docker interroge un vrai démon en direct ; hors-ligne il serait vide. Ici un jeu
   fictif cohérent : deux projets compose (dont un service en DRIFT config avec son diff de
   variables visible, valeurs sensibles masquées) + un container hors-compose. */

const iso = (days) => new Date(Date.now() - days * 86400000).toISOString();
const isDemo = () => process.env.MERGERIE_DEMO === '1';

function status() { return { ok: true, version: '27.1.1 (démo)' }; }

function composeProjects() {
  return [
    {
      name: 'boutique',
      dir: '/home/moi/dev/boutique', file: 'compose.yaml', path: '/home/moi/dev/boutique/compose.yaml',
      rootLabel: 'Mes dépôts', error: null,
      makefile: { file: 'Makefile', path: '/home/moi/dev/boutique/Makefile', targets: [
        { name: 'up', desc: 'Démarre la stack en arrière-plan', recipe: 'docker compose up -d\ndocker compose ps' },
        { name: 'logs', desc: 'Suit les logs de tous les services', recipe: 'docker compose logs -f --tail=100' },
        { name: 'migrate', desc: 'Applique les migrations de base de données', recipe: 'docker compose exec api npm run db:migrate' },
        { name: 'seed', desc: 'Injecte des données de démonstration', recipe: 'docker compose exec api npm run db:seed -- --env=demo' },
        { name: 'test', desc: 'Lance la suite de tests', recipe: 'docker compose exec api npm test' },
        { name: 'lint', desc: '', recipe: 'docker compose exec api npm run lint' },
        { name: 'clean', desc: 'Nettoie les artefacts de build', recipe: 'rm -rf dist node_modules/.cache\ndocker compose down --remove-orphans' },
      ] },
      services: [
        {
          name: 'api', image: 'registry.demo/boutique-api:1.5.0',
          container: { id: 'a1b2c3', name: 'boutique-api-1', state: 'running', image: 'registry.demo/boutique-api:1.4.2', created: iso(6) },
          // Drift config : compose a changé depuis la création du container.
          envDiffs: [
            { name: 'DB_POOL_SIZE', kind: 'modified', masked: false, from: '10', to: '25' },
            { name: 'FEATURE_CHECKOUT_V2', kind: 'added', masked: false, to: 'true' },
            { name: 'STRIPE_SECRET_KEY', kind: 'modified', masked: true },
          ],
          imgDrift: true, composeModified: true, badge: 'drift-config',
        },
        {
          name: 'db', image: 'postgres:16',
          container: { id: 'd4e5f6', name: 'boutique-db-1', state: 'running', health: 'healthy', image: 'postgres:16', created: iso(6) },
          envDiffs: [], imgDrift: false, composeModified: false, badge: 'synced',
        },
        {
          name: 'cache', image: 'redis:7',
          // Crash-loop : container en restarting (illustre le filtre « En restarting »).
          container: { id: 'cc1122', name: 'boutique-cache-1', state: 'restarting', image: 'redis:7', created: iso(1) },
          envDiffs: [], imgDrift: false, composeModified: false, badge: 'synced',
        },
      ],
    },
    {
      name: 'monitoring',
      dir: '/home/moi/dev/monitoring', file: 'docker-compose.yml', path: '/home/moi/dev/monitoring/docker-compose.yml',
      rootLabel: 'Mes dépôts', error: null,
      services: [
        {
          name: 'grafana', image: 'grafana/grafana:11.1.0',
          // Healthcheck KO (illustre le filtre « Unhealthy ») + drift image.
          container: { id: '778899', name: 'monitoring-grafana-1', state: 'running', health: 'unhealthy', image: 'grafana/grafana:10.4.0', created: iso(30) },
          envDiffs: [], imgDrift: true, composeModified: false, badge: 'drift-image',
        },
        {
          name: 'prometheus', image: 'prom/prometheus:v2.53.0',
          container: null, // service défini mais JAMAIS créé (filtre « Non démarrés »)
          envDiffs: [], imgDrift: false, composeModified: false, badge: 'missing',
        },
        {
          name: 'alertmanager', image: 'prom/alertmanager:v0.27.0',
          // Arrêté après avoir tourné (filtre « Arrêtés (exited) »).
          container: { id: 'ab77aa', name: 'monitoring-alertmanager-1', state: 'exited', exitCode: 0, image: 'prom/alertmanager:v0.27.0', created: iso(12) },
          envDiffs: [], imgDrift: false, composeModified: false, badge: 'stopped',
        },
        {
          name: 'ingest', image: 'registry.demo/ingest:2.1.0',
          // Sorti EN ERREUR (filtre « Sortis en erreur ») : c'est le seul arrêté qui alerte.
          container: { id: 'in44cc', name: 'monitoring-ingest-1', state: 'exited', exitCode: 137, image: 'registry.demo/ingest:2.1.0', created: iso(4) },
          envDiffs: [], imgDrift: false, composeModified: false, badge: 'stopped',
        },
        {
          name: 'loki', image: 'grafana/loki:3.0.0',
          // Créé mais jamais démarré — souvent un échec au démarrage (filtre « Créés, jamais démarrés »).
          container: { id: 'lo9911', name: 'monitoring-loki-1', state: 'created', image: 'grafana/loki:3.0.0', created: iso(2) },
          envDiffs: [], imgDrift: false, composeModified: false, badge: 'stopped',
        },
      ],
    },
  ];
}

// Liste légère (affichage progressif) dérivée des projets de démo.
function composeList() {
  return composeProjects().map((p, i) => ({
    name: p.name, dir: p.dir, file: p.file, path: p.path, rootLabel: p.rootLabel,
    count: (p.services || []).filter((s) => s.container).length, recent: 1000 - i,
  }));
}

function orphans() {
  return [
    { id: 'ff0011', name: 'redis-scratch', image: 'redis:7', state: 'running', status: 'Up 3 days', ports: '0.0.0.0:6379->6379/tcp', created: iso(3) },
    { id: 'aa2233', name: 'pgadmin-temp', image: 'dpage/pgadmin4:8', state: 'exited', status: 'Exited (0) 2 days ago', ports: '', created: iso(9) },
  ];
}

// Exemple de commande reconstituée (bouton « Reconstituer la commande ») pour un orphelin.
function reconstituteDemo(id) {
  const known = {
    ff0011: 'docker run -d \\\n  --name redis-scratch \\\n  --restart unless-stopped \\\n  -p 0.0.0.0:6379:6379/tcp \\\n  -v redis-data:/data \\\n  redis:7',
    aa2233: 'docker run -d \\\n  --name pgadmin-temp \\\n  -p 5050:80/tcp \\\n  -e PGADMIN_DEFAULT_EMAIL=admin@demo \\\n  -e PGADMIN_DEFAULT_PASSWORD=*** \\\n  dpage/pgadmin4:8',
  };
  return { command: known[id] || 'docker run -d <image>' };
}

function previewDown(name) {
  return { project: name || 'boutique', containers: [
    { name: 'boutique-api-1', service: 'api', state: 'running' },
    { name: 'boutique-db-1', service: 'db', state: 'running' },
  ], volumes_preserved: true };
}

// Containers pour l'onglet Logs (démo) : quelques services représentatifs — dont un UNHEALTHY
// et un RESTARTING pour illustrer les badges de santé du menu.
function containers() {
  return [
    { id: 'demo_web', name: 'boutique-web-1', state: 'running', status: 'Up 3 hours', image: 'nginx:1.27', project: 'boutique', service: 'web', running: true },
    { id: 'demo_api', name: 'boutique-api-1', state: 'running', status: 'Up 3 hours (unhealthy)', image: 'node:20', project: 'boutique', service: 'api', running: true },
    { id: 'demo_db', name: 'boutique-db-1', state: 'running', status: 'Up 3 hours (healthy)', image: 'postgres:16', project: 'boutique', service: 'db', running: true },
    { id: 'demo_cache', name: 'boutique-cache-1', state: 'restarting', status: 'Restarting (1) 5 seconds ago', image: 'redis:7', project: 'boutique', service: 'cache', running: false },
    { id: 'demo_worker', name: 'labo-worker', state: 'exited', status: 'Exited (0) 1 hour ago', image: 'python:3.12', project: null, service: null, running: false },
  /* Sorti EN ERREUR : c'est le seul « exited » qui doit rejoindre le badge rouge. Sans lui, la
     démo ne montrerait pas la différence entre un arrêt volontaire et un plantage. */
  { id: 'demo_crash', name: 'labo-importeur', state: 'exited', status: 'Exited (137) 20 minutes ago', image: 'node:22', project: null, service: null, running: false },
  { id: 'in44cc', name: 'monitoring-ingest-1', state: 'exited', status: 'Exited (137) 4 hours ago', image: 'registry.demo/ingest:2.1.0', project: 'monitoring', service: 'ingest', running: false },
    { id: 'ab77aa', name: 'monitoring-alertmanager-1', state: 'exited', status: 'Exited (0) 12 hours ago', image: 'prom/alertmanager:v0.27.0', project: 'monitoring', service: 'alertmanager', running: false },
    { id: 'lo9911', name: 'monitoring-loki-1', state: 'created', status: 'Created', image: 'grafana/loki:3.0.0', project: 'monitoring', service: 'loki', running: false },
  ];
}

/* Résumé santé (démo) : on délègue au MÊME calcul que le mode réel. Il était réimplémenté ici,
   donc les deux divergeaient dès qu'on affinait la règle — la démo aurait continué de compter
   un arrêt propre comme une anomalie. */
function summary() {
  const cs = containers();
  return { ...healthSummary(cs), total: cs.length, running: cs.filter((c) => c.running).length };
}

// Flux SSE SIMULÉ : émet des lignes fictives en boucle jusqu'à déconnexion du client. Sert à
// rendre l'onglet Logs consultable en démo (comme les autres écrans Docker). Séquence FIXE
// (pas de Date/random) pour rester déterministe. `res` = réponse SSE déjà ouverte.
function streamLogs(ids, res) {
  const list = (ids && ids.length ? ids : ['demo_api']);
  /* Les échantillons portent des COULEURS, comme une vraie application dans un container.
     Elles partent BRUTES, comme dans le flux réel : c'est ce qui rend la case « afficher
     les couleurs » démontrable — sans elles, la démo montrerait un écran plus sage que la vie. */
  const C = (code, s2) => `\u001b[${code}m${s2}\u001b[39m`;
  const samples = [
    `${C(37, 'INFO ')} GET /api/products ${C(32, '200')} 12ms`,
    `${C(34, 'DEBUG')} cache lookup key=user:42 miss`,
    `${C(37, 'INFO ')} GET /health ${C(32, '200')} 1ms`,
    `${C(33, 'WARN ')} slow query 812ms SELECT * FROM orders`,
    `${C(37, 'INFO ')} connected to postgres db:5432`,
    `${C(31, 'ERROR')} upstream timeout after 3000ms retry=1`,
    `${C(37, 'INFO ')} POST /api/cart ${C(32, '201')} 24ms`,
    `${C(34, 'DEBUG')} worker heartbeat ok queue=3`,
  ];
  let i = 0;
  const timer = setInterval(() => {
    const c = list[i % list.length];
    const m = samples[i % samples.length];
    try { res.write(`data: ${JSON.stringify({ c, m })}\n\n`); } catch { clearInterval(timer); }
    i += 1;
  }, 650);
  res.on('close', () => clearInterval(timer));
}

module.exports = { isDemo, status, composeProjects, composeList, orphans, reconstituteDemo, previewDown, containers, streamLogs, summary };
