'use strict';
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
          container: null, // service défini mais pas démarré
          envDiffs: [], imgDrift: false, composeModified: false, badge: 'missing',
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
  ];
}

// Résumé santé (démo) calculé sur les mêmes containers, pour le badge de menu.
function summary() {
  const cs = containers();
  let error = 0; let unhealthy = 0;
  for (const c of cs) {
    const st = c.state.toLowerCase(); const status = c.status.toLowerCase();
    if (st === 'restarting' || st === 'dead') error += 1;
    else if (status.includes('(unhealthy)')) unhealthy += 1;
  }
  return { error, unhealthy, total: cs.length, running: cs.filter((c) => c.running).length };
}

// Flux SSE SIMULÉ : émet des lignes fictives en boucle jusqu'à déconnexion du client. Sert à
// rendre l'onglet Logs consultable en démo (comme les autres écrans Docker). Séquence FIXE
// (pas de Date/random) pour rester déterministe. `res` = réponse SSE déjà ouverte.
function streamLogs(ids, res) {
  const list = (ids && ids.length ? ids : ['demo_api']);
  const samples = [
    'INFO  GET /api/products 200 12ms',
    'DEBUG cache lookup key=user:42 miss',
    'INFO  GET /health 200 1ms',
    'WARN  slow query 812ms SELECT * FROM orders',
    'INFO  connected to postgres db:5432',
    'ERROR upstream timeout after 3000ms retry=1',
    'INFO  POST /api/cart 201 24ms',
    'DEBUG worker heartbeat ok queue=3',
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
