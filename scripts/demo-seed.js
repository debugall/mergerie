#!/usr/bin/env node
'use strict';
/* Sème une base de démonstration réaliste dans `data-demo/`, pour `npm run demo`.
   But : qu'un visiteur du dépôt voie l'outil VIVANT en 30 s, sans GitLab ni token.

   Isolé de la vraie base : on force MERGERIE_DATA_DIR=data-demo AVANT de charger db/paths,
   et on efface le dossier à chaque exécution (démo repeatable, jamais de résidu). */

const path = require('path');
const fs = require('fs');

const DEMO_DIR = path.resolve(__dirname, '..', 'data-demo');
process.env.MERGERIE_DATA_DIR = DEMO_DIR;
fs.rmSync(DEMO_DIR, { recursive: true, force: true }); // repart d'une base propre

const db = require('../src/db');
const { REVIEWS_DIR, TASKS_DIR, ensureDir, slugify, initDirs } = require('../src/paths');
initDirs();

const day = 86400000;
const iso = (daysAgo, h = 10) => new Date(Date.now() - daysAgo * day + h * 3600000 - 30 * day).toISOString();
// (les dates s'étalent sur ~8 semaines pour peupler courbes hebdo et tendances)
const at = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();

const AUTHORS = ['amady', 'lina', 'karim', 'sofia', 'noah'];
// La démo mélange les deux forges : les badges GitLab/GitHub sont ainsi visibles
// sans aucune configuration, comme dans une installation réelle multi-forge.
/* `fetch_mrs: 0` sur un dépôt : la démo doit MONTRER qu'on peut cesser de ramener les MR
   d'un dépôt sans le désactiver. Ses MR déjà semées restent dans la file — c'est exactement
   le comportement réel, et c'est ce qui rend la case compréhensible. */
const PROJECTS = [
  { project: 'groupe/api-core', url: 'https://gitlab.demo/groupe/api-core.git', forge: 'gitlab' },
  { project: 'groupe/webapp-front', url: 'https://gitlab.demo/groupe/webapp-front.git', forge: 'gitlab' },
  { project: 'groupe/batch-jobs', url: 'https://gitlab.demo/groupe/batch-jobs.git', forge: 'gitlab' },
  { project: 'acme/design-system', url: 'https://github.com/acme/design-system.git', forge: 'github', fetch_mrs: 0 },
];

// ---------- config : GitLab factice, pas de token (démo hors-ligne) ----------
db.prepare(`UPDATE config SET gitlab_url = ?, access_token = '', jira_url = ?, review_skill = 'git-review' WHERE id = 1`)
  .run('https://gitlab.demo', 'https://jira.demo');

// ---------- dépôts ----------
const repoIds = {};
for (const p of PROJECTS) {
  const info = db.prepare('INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge, fetch_mrs) VALUES (?, ?, \'\', 1, ?, ?, ?)')
    .run(p.project, p.url, at(60), p.forge || 'gitlab', p.fetch_mrs == null ? 1 : p.fetch_mrs);
  repoIds[p.project] = info.lastInsertRowid;
}

// ---------- règle par chemin (fait apparaître le badge « risque ») ----------
db.prepare('INSERT INTO review_rule (branch_match, path_match, label, content, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
  .run('', '**/migrations/**, *.sql', 'migrations', 'Vérifier la réversibilité de la migration et le risque de lock sur les grosses tables.', at(50));
db.prepare('INSERT INTO review_rule (branch_match, path_match, label, content, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
  .run('hotfix', '', '', 'Branche hotfix : vérifier qu\'un test de non-régression couvre le correctif.', at(50));

// ---------- rapport Markdown réaliste ----------
function reviewMd(mr, note, findings) {
  return `# Revue de code — !${mr.iid} ${mr.title}

> Branche \`${mr.source_branch}\` → \`${mr.target_branch}\` · projet \`${mr.project}\`

## Résumé
Cette MR ${mr.summary}. Les changements sont dans l'ensemble cohérents ; quelques points de vigilance ci-dessous.

## Points relevés
${findings.map((f) => `- **[${f.severity}]** \`${f.file}:${f.line}\` — ${f.title}.`).join('\n')}

## Ce qui est bien
- Le découpage des commits est clair et le périmètre reste maîtrisé.
- La logique métier est lisible et les cas limites principaux sont couverts.

## Note globale
**${note}/10** — ${note >= 8 ? 'bon niveau, corrections mineures' : note >= 6 ? 'correct, quelques points à traiter' : 'à revoir avant merge'}.
`;
}
function explainMd(mr) {
  return `# Explication — !${mr.iid}

Cette merge request ${mr.summary}. Concrètement, elle touche ${mr.changed.length} fichier(s) et
s'inscrit dans le flux ${mr.target_branch}. Pour un relecteur pressé : concentre-toi sur les fichiers
listés dans le rapport de revue, c'est là que se situent les points de vigilance.
`;
}

const SEVERITIES = ['blocker', 'major', 'minor', 'info'];
function fp(file, title) {
  // même empreinte que resolution.js (hash sha1 tronqué) — évite d'importer le module
  return require('crypto').createHash('sha1').update(`${file}\n${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`).digest('hex').slice(0, 16);
}

// ---------- MR fictives ----------
const MRS = [
  { project: 'groupe/api-core', title: 'Ajout endpoint /health et readiness probe', branch: 'feat/PROJ-812-health', status: 'to_review', changed: ['src/routes/health.js', 'src/app.js'], summary: 'ajoute une sonde de santé et de disponibilité' },
  { project: 'groupe/api-core', title: 'Migration : index sur orders(created_at)', branch: 'feat/PROJ-833-order-index', status: 'to_review', changed: ['db/migrations/041_orders_index.sql', 'src/dao/orders.js'], summary: 'ajoute un index pour accélérer les requêtes de commandes' },
  { project: 'groupe/webapp-front', title: 'Refonte du formulaire de connexion', branch: 'feat/PROJ-790-login', status: 'to_review', changed: ['src/pages/Login.jsx', 'src/api/auth.js', 'src/styles/login.css'], summary: 'refond l\'écran de connexion et sa validation' },
  { project: 'groupe/batch-jobs', title: 'Hotfix : timeout export nocturne', branch: 'hotfix/export-timeout', status: 'to_review', changed: ['jobs/nightlyExport.js'], summary: 'corrige un timeout sur l\'export de nuit' },
  { project: 'groupe/webapp-front', title: 'Ajout du dark mode', branch: 'feat/PROJ-701-dark', status: 'to_review', changed: ['src/theme.js', 'src/components/Toggle.jsx'], summary: 'introduit un thème sombre configurable' },
  { project: 'acme/design-system', title: 'Tokens de couleur : passage en HSL', branch: 'feat/DS-118-hsl-tokens', status: 'to_review', changed: ['src/tokens/color.ts', 'docs/theming.md'], summary: 'convertit les tokens de couleur en HSL' },
];
// MR déjà reviewées / traitées, réparties dans le temps pour les stats
const REVIEWED = [
  { project: 'groupe/api-core', title: 'Validation stricte des payloads webhooks', branch: 'feat/PROJ-640-webhook', daysAgo: 3, note: 8.4, status: 'reviewed', changed: ['src/webhooks/validate.js'], summary: 'renforce la validation des webhooks entrants' },
  { project: 'groupe/api-core', title: 'Cache Redis sur le catalogue', branch: 'feat/PROJ-655-cache', daysAgo: 6, note: 7.1, status: 'reviewed', changed: ['src/services/catalog.js', 'src/cache/redis.js'], summary: 'met en cache le catalogue produit' },
  { project: 'groupe/webapp-front', title: 'Pagination de la liste clients', branch: 'feat/PROJ-620-pagination', daysAgo: 9, note: 6.2, status: 'reviewed', changed: ['src/pages/Clients.jsx'], summary: 'ajoute la pagination côté liste clients' },
  { project: 'groupe/batch-jobs', title: 'Parallélisation de l\'import CSV', branch: 'feat/PROJ-590-import', daysAgo: 13, note: 5.5, status: 'done', changed: ['jobs/importCsv.js', 'db/migrations/038_import_state.sql'], summary: 'parallélise l\'import de gros fichiers CSV' },
  { project: 'groupe/api-core', title: 'Rate limiting par clé d\'API', branch: 'feat/PROJ-560-ratelimit', daysAgo: 17, note: 7.8, status: 'done', changed: ['src/middleware/rateLimit.js'], summary: 'limite le débit par clé d\'API' },
  { project: 'groupe/webapp-front', title: 'Accessibilité : labels et focus', branch: 'feat/PROJ-540-a11y', daysAgo: 22, note: 8.9, status: 'done', changed: ['src/components/Form.jsx', 'src/components/Modal.jsx'], summary: 'améliore l\'accessibilité des formulaires' },
  { project: 'groupe/batch-jobs', title: 'Reprise sur erreur de l\'export', branch: 'feat/PROJ-500-retry', daysAgo: 27, note: 6.8, status: 'done', changed: ['jobs/export.js'], summary: 'ajoute une reprise sur erreur à l\'export' },
  { project: 'acme/design-system', title: 'Composant Tooltip accessible', branch: 'feat/DS-102-tooltip', daysAgo: 11, note: 8.1, status: 'reviewed', changed: ['src/components/Tooltip.tsx'], summary: 'ajoute un tooltip accessible au clavier' },
];

let iid = 200;
function insertMr(m, extra = {}) {
  iid += 1;
  const sha = require('crypto').randomBytes(20).toString('hex');
  const info = db.prepare(`INSERT INTO mr
    (repo_id, iid, title, source_branch, target_branch, web_url, current_sha, reviewed_sha, status, updated_at, gitlab_created_at, author, changed_paths)
    VALUES (@repo_id, @iid, @title, @source_branch, @target_branch, @web_url, @current_sha, @reviewed_sha, @status, @updated_at, @gitlab_created_at, @author, @changed_paths)`)
    .run({
      repo_id: repoIds[m.project], iid, title: m.title,
      source_branch: m.branch, target_branch: extra.target || 'main',
      web_url: (PROJECTS.find((p) => p.project === m.project) || {}).forge === 'github'
        ? `https://github.com/${m.project}/pull/${iid}`
        : `https://gitlab.demo/${m.project}/-/merge_requests/${iid}`,
      current_sha: sha, reviewed_sha: extra.reviewed_sha || null,
      status: m.status, updated_at: extra.date || at(1),
      gitlab_created_at: extra.date || at(2),
      author: AUTHORS[iid % AUTHORS.length], changed_paths: (m.changed || []).join('\n'),
    });
  return { id: info.lastInsertRowid, iid, sha, source_branch: m.branch, target_branch: extra.target || 'main', ...m };
}

// MR à traiter
const mrsAtraiter = MRS.map((m) => insertMr(m, { date: at(1 + (MRS.indexOf(m) % 4)) }));

// MR reviewées/traitées + rapports sur disque + versions + constats
for (const m of REVIEWED) {
  const mr = insertMr(m, { date: iso(m.daysAgo), reviewed_sha: 'r' + require('crypto').randomBytes(8).toString('hex') });
  const dir = ensureDir(path.join(REVIEWS_DIR, slugify(m.project), String(mr.iid)));
  const findings = (m.changed || []).slice(0, 3).map((file, i) => ({
    file, line: (i + 1) * 12, severity: SEVERITIES[i % SEVERITIES.length],
    title: ['gérer le cas nul', 'ajouter un test', 'extraire la constante magique', 'documenter le contrat'][i % 4],
  }));
  const md = reviewMd(mr, m.note, findings);
  const mdPath = path.join(dir, 'review-v1.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  const explPath = path.join(dir, 'explanation-v1.md');
  fs.writeFileSync(explPath, explainMd(mr), 'utf8');
  const diffPath = path.join(dir, 'diff.patch');
  fs.writeFileSync(diffPath, (m.changed || []).map((f) => `diff --git a/${f} b/${f}\n+++ b/${f}\n+// changement démo\n`).join('\n'), 'utf8');
  const noteVal = m.note / 10;
  db.prepare('INSERT INTO review (mr_id, md_path, explanation_path, diff_path, note_value, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(mr.id, mdPath, explPath, diffPath, noteVal, iso(m.daysAgo), iso(m.daysAgo));
  db.prepare('INSERT INTO review_version (mr_id, version, md_path, explanation_path, note_value, reviewed_sha, kind, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(mr.id, 1, mdPath, explPath, noteVal, mr.sha, 'review', iso(m.daysAgo));
  // constats de la v1 (tous « new » à la 1re passe)
  const now = iso(m.daysAgo);
  for (const f of findings) {
    db.prepare('INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(mr.id, 1, fp(f.file, f.title), f.file, f.line, f.severity, f.title, 'new', now);
  }
}

// ---- une MR à DEUX passes pour montrer le suivi de résolution + tendance de note ----
{
  const base = { project: 'groupe/api-core', title: 'Sécurisation de l\'upload de fichiers', branch: 'feat/PROJ-700-upload', status: 'reviewed', changed: ['src/upload/handler.js', 'src/upload/scan.js'], summary: 'durcit la validation des fichiers uploadés' };
  const mr = insertMr(base, { date: iso(2), reviewed_sha: 'r' + require('crypto').randomBytes(8).toString('hex') });
  const dir = ensureDir(path.join(REVIEWS_DIR, slugify(base.project), String(mr.iid)));
  // v1 (il y a 5 j, note 6.4) : 3 constats
  const v1f = [
    { file: 'src/upload/handler.js', line: 22, severity: 'blocker', title: 'valider le type MIME réel' },
    { file: 'src/upload/handler.js', line: 40, severity: 'major', title: 'limiter la taille du fichier' },
    { file: 'src/upload/scan.js', line: 8, severity: 'minor', title: 'journaliser le résultat du scan' },
  ];
  const v1md = path.join(dir, 'review-v1.md'); fs.writeFileSync(v1md, reviewMd(mr, 6.4, v1f), 'utf8');
  db.prepare('INSERT INTO review_version (mr_id, version, md_path, note_value, reviewed_sha, kind, created_at, n_new, n_persistent, n_resolved, n_disappeared) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(mr.id, 1, v1md, 0.64, 'sha_v1', 'review', iso(5), 3, 0, 0, 0);
  for (const f of v1f) db.prepare('INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(mr.id, 1, fp(f.file, f.title), f.file, f.line, f.severity, f.title, 'new', iso(5));
  // v2 (il y a 2 j, note 8.1) : 1 persiste, 2 résolus
  const v2f = [{ file: 'src/upload/handler.js', line: 40, severity: 'major', title: 'limiter la taille du fichier' }];
  const v2md = path.join(dir, 'review-v2.md'); fs.writeFileSync(v2md, reviewMd(mr, 8.1, v2f), 'utf8');
  const explPath = path.join(dir, 'explanation-v1.md'); fs.writeFileSync(explPath, explainMd(mr), 'utf8');
  const diffPath = path.join(dir, 'diff.patch'); fs.writeFileSync(diffPath, 'diff --git a/src/upload/handler.js b/src/upload/handler.js\n+++ b/src/upload/handler.js\n+// démo\n', 'utf8');
  db.prepare('INSERT INTO review_version (mr_id, version, md_path, explanation_path, note_value, reviewed_sha, kind, created_at, n_new, n_persistent, n_resolved, n_disappeared) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(mr.id, 2, v2md, explPath, 0.81, 'sha_v2', 'review', iso(2), 0, 1, 2, 0);
  db.prepare('INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(mr.id, 2, fp('src/upload/handler.js', 'limiter la taille du fichier'), 'src/upload/handler.js', 40, 'major', 'limiter la taille du fichier', 'persistent', iso(2));
  db.prepare('INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(mr.id, 2, fp('src/upload/handler.js', 'valider le type MIME réel'), 'src/upload/handler.js', 22, 'blocker', 'valider le type MIME réel', 'resolved', iso(2));
  db.prepare('INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(mr.id, 2, fp('src/upload/scan.js', 'journaliser le résultat du scan'), 'src/upload/scan.js', 8, 'minor', 'journaliser le résultat du scan', 'resolved', iso(2));
  db.prepare('INSERT INTO review (mr_id, md_path, explanation_path, diff_path, note_value, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(mr.id, v2md, explPath, diffPath, 0.81, iso(2), iso(2));
}

// ---- une MR CONVERGÉE (« Converger ») : 3 passes autonomes 5,8 → 7,1 → 8,4 ----
// Vitrine de la feature phare : le sélecteur de versions égrène la progression et le
// panneau de run affiche « convergé ». reviewed_sha = tête courante → MR non périmée.
{
  const rnd8 = () => require('crypto').randomBytes(8).toString('hex');
  const base = { project: 'groupe/webapp-front', title: 'Refonte du tunnel de paiement', branch: 'feat/PROJ-720-checkout', status: 'reviewed', changed: ['src/checkout/cart.js', 'src/checkout/payment.js', 'src/checkout/validation.js'], summary: 'refond le panier et sécurise le tunnel de paiement' };
  const headSha = 'c' + rnd8() + rnd8();
  const mr = insertMr(base, { date: iso(1), reviewed_sha: headSha });
  db.prepare('UPDATE mr SET current_sha = ? WHERE id = ?').run(headSha, mr.id); // non périmée : reviewed == current
  const dir = ensureDir(path.join(REVIEWS_DIR, slugify(base.project), String(mr.iid)));

  // Chaque passe résout des constats → la note monte. (severity, fichier, ligne, titre)
  const v1f = [
    { file: 'src/checkout/payment.js', line: 31, severity: 'blocker', title: 'ne pas journaliser le numéro de carte' },
    { file: 'src/checkout/payment.js', line: 58, severity: 'major', title: 'gérer l’échec réseau du PSP' },
    { file: 'src/checkout/cart.js', line: 44, severity: 'major', title: 'recalculer le total côté serveur' },
    { file: 'src/checkout/validation.js', line: 12, severity: 'minor', title: 'valider la devise' },
  ];
  const v2f = [
    { file: 'src/checkout/payment.js', line: 58, severity: 'major', title: 'gérer l’échec réseau du PSP' },
    { file: 'src/checkout/cart.js', line: 44, severity: 'major', title: 'recalculer le total côté serveur' },
  ];
  const v3f = [
    { file: 'src/checkout/cart.js', line: 44, severity: 'minor', title: 'recalculer le total côté serveur' },
  ];
  const writeVer = (v, note, findings, daysAgo, agg) => {
    const md = path.join(dir, `review-v${v}.md`); fs.writeFileSync(md, reviewMd(mr, note, findings), 'utf8');
    db.prepare('INSERT INTO review_version (mr_id, version, md_path, note_value, reviewed_sha, kind, created_at, n_new, n_persistent, n_resolved, n_disappeared) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(mr.id, v, md, note / 10, `sha_c${v}`, 'review', iso(daysAgo), agg.n, agg.p, agg.r, 0);
    return md;
  };
  const addFindings = (v, list, status, daysAgo) => {
    for (const f of list) db.prepare('INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(mr.id, v, fp(f.file, f.title), f.file, f.line, f.severity, f.title, status, iso(daysAgo));
  };
  writeVer(1, 5.8, v1f, 1.4, { n: 4, p: 0, r: 0 });
  addFindings(1, v1f, 'new', 1.4);
  writeVer(2, 7.1, v2f, 1.2, { n: 0, p: 2, r: 2 });
  addFindings(2, v2f, 'persistent', 1.2);
  addFindings(2, [v1f[0], v1f[3]], 'resolved', 1.2); // le blocker carte + la devise, corrigés
  const v3md = writeVer(3, 8.4, v3f, 1.0, { n: 0, p: 1, r: 1 });
  addFindings(3, v3f, 'persistent', 1.0);
  addFindings(3, [v2f[0]], 'resolved', 1.0); // l’échec PSP, corrigé
  const explPath = path.join(dir, 'explanation-v1.md'); fs.writeFileSync(explPath, explainMd(mr), 'utf8');
  const diffPath = path.join(dir, 'diff.patch'); fs.writeFileSync(diffPath, 'diff --git a/src/checkout/cart.js b/src/checkout/cart.js\n+++ b/src/checkout/cart.js\n+// démo\n', 'utf8');
  // la table `review` pointe la dernière version (v3, 8,4)
  db.prepare('INSERT INTO review (mr_id, md_path, explanation_path, diff_path, note_value, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(mr.id, v3md, explPath, diffPath, 0.84, iso(1), iso(1));

  // la RUN de convergence : partie de 5,8, convergée à 8,4 (≥ 8) en 2 passes de correction.
  db.prepare(`INSERT INTO convergence_run (mr_id, status, threshold, max_passes, passes_done, start_note, best_note, best_version, message, started_at, finished_at)
    VALUES (?, 'converged', 8, 3, 2, 5.8, 8.4, 3, ?, ?, ?)`)
    .run(mr.id, 'convergé : 8.4/10 en 2 passe(s) (seuil 8)', iso(1.5), iso(1));

  // Vitrine « Converger DEPUIS une session » : la session de dev qui a produit CETTE MR
  // (du prompt → code → push → MR → convergée). Dans Dev IA, la carte pointe la MR convergée.
  const mrUrl = `https://gitlab.demo/${base.project}/-/merge_requests/${mr.iid}`;
  const ct = db.prepare('INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, auto_push, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)')
    .run(repoIds[base.project], 'Refonds le tunnel de paiement : sécurise la saisie carte (pas de log du numéro), recalcule le total côté serveur, gère l’échec réseau du PSP, valide la devise. Ajoute des tests.', base.branch, 'main', 'pushed', 'code', iso(1.6), iso(1));
  db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, commit_sha, mr_iid, mr_url, mr_merged, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?)')
    .run(ct.lastInsertRowid, repoIds[base.project], base.branch, 'main', 'pushed', headSha, mr.iid, mrUrl, iso(1));
}

// ---------- consommation de tokens (dashboard coût + tendance hebdo) ----------
const KINDS = [['review', 5200], ['explain', 1500], ['task', 9000], ['explore', 3200], ['modify', 2600]];
for (let d = 55; d >= 0; d -= 2) {
  for (const [kind, base] of KINDS) {
    if ((d + kind.length) % 3 === 0) continue; // un peu de creux
    const tok = base + ((d * 37) % 1800);
    db.prepare('INSERT INTO usage (kind, prompt_chars, output_chars, tokens_est, created_at) VALUES (?,?,?,?,?)')
      .run(kind, tok * 3, tok, tok, iso(d));
  }
}

// ---------- feed (footer vivant) ----------
db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)').run('mr_opened', 201, 'groupe/api-core', 'lina', 'Ajout endpoint /health', at(0.1));
db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)').run('mr_merged', 190, 'groupe/webapp-front', 'sofia', 'Accessibilité : labels et focus', at(0.5));
db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)').run('mr_opened', 203, 'groupe/webapp-front', 'karim', 'Refonte connexion', at(1));

// ---------- sessions Dev IA ----------
// task.branch / base_branch sont NOT NULL (schéma mono-projet historique) : on les
// renseigne même si l'état réel vit désormais dans task_target.
const t1 = db.prepare('INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(repoIds['groupe/api-core'], 'Ajouter un endpoint /metrics au format Prometheus', 'ai/metrics-endpoint', 'main', 'pushed', 'code', at(4), at(4));
db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, mr_iid, mr_url, mr_merged, session_key, session_backend, session_cwd, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(t1.lastInsertRowid, repoIds['groupe/api-core'], 'ai/metrics-endpoint', 'main', 'pushed', 250, 'https://gitlab.demo/groupe/api-core/-/merge_requests/250', 1,
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'claude', '/home/moi/clones/groupe-api-core', at(4));
const t2 = db.prepare('INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, created_at, updated_at, md_path) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(repoIds['groupe/batch-jobs'], 'Comment est gérée la reprise sur erreur dans les jobs ?', '', '', 'done', 'explore', at(6), at(6), path.join(TASKS_DIR, 'demo-explore.md'));
/* Cible explicite : sans elle, c'est le backfill de `db.js` qui en crée une au démarrage —
   donc sans session, et la carte n'aurait pas son « Reprendre au terminal ». Une exploration
   tourne dans UNE session pour tous ses dépôts, dont le répertoire de travail est la RACINE
   des clones et non un dépôt : c'est pourquoi la commande vit au niveau de la session. */
db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, session_key, session_backend, session_cwd, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(t2.lastInsertRowid, repoIds['groupe/batch-jobs'], '', '', 'done',
    '3f2a9c14-7b0e-4d55-9c31-8ae61f0c2b47', 'claude', '/home/moi/clones', at(6));
/* Une exploration MULTI-DÉPÔTS : c'est le cas où la liste de projets se replie, et il
   n'existait aucun exemple à l'écran. Une question transverse est d'ailleurs l'usage le plus
   naturel de l'exploration — on cherche rarement dans un seul dépôt. */
const t2b = db.prepare('INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, created_at, updated_at, md_path) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(repoIds['groupe/api-core'], 'Où est vérifié le jeton d’authentification, et le contrat est-il le même partout ?', '', '', 'done', 'explore', at(3), at(3), path.join(TASKS_DIR, 'demo-explore-multi.md'));
for (const projet of ['groupe/api-core', 'groupe/webapp-front', 'groupe/batch-jobs']) {
  db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, session_key, session_backend, session_cwd, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(t2b.lastInsertRowid, repoIds[projet], '', '', 'done',
      '9d41b2ee-3c07-42a8-9f10-5b2c7e8d0a13', 'claude', '/home/moi/clones', at(3));
}

ensureDir(TASKS_DIR);
fs.writeFileSync(path.join(TASKS_DIR, 'demo-explore-multi.md'), '# Vérification du jeton — synthèse\n\nTrois implémentations coexistent : un middleware Express dans `api-core`, un intercepteur côté `webapp-front`, et une vérification maison dans `batch-jobs` qui n’applique pas la même tolérance d’horloge…\n', 'utf8');
fs.writeFileSync(path.join(TASKS_DIR, 'demo-explore.md'), '# Reprise sur erreur — synthèse\n\nLes jobs utilisent un état persistant en base et rejouent les lots échoués au prochain passage…\n', 'utf8');

// Session « l'IA pose une question » (ask → stop → resume) EN ATTENTE : montre le formulaire
// de réponses sur la carte. La session s'est arrêtée pour demander une décision structurante.
const t3 = db.prepare('INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, ask_questions, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)')
  .run(repoIds['groupe/webapp-front'], 'Ajoute un mécanisme de retry sur les appels au PSP de paiement, avec back-off exponentiel.', 'ai/psp-retry', 'main', 'needs_input', 'code', at(0.3), at(0.3));
db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, questions_json, updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(t3.lastInsertRowid, repoIds['groupe/webapp-front'], 'ai/psp-retry', 'main', 'needs_input', JSON.stringify([
    { id: 'q1', question: 'Où placer la logique de retry ?', context: 'Le dépôt a deux conventions : un décorateur dans src/shared, ou un middleware HTTP.', options: [
      { value: 'decorator', label: 'Décorateur (cohérent avec OrderService)' },
      { value: 'middleware', label: 'Middleware HTTP (cohérent avec PaymentClient)' },
    ], answer: null },
    { id: 'q2', question: 'Combien de tentatives au maximum avant d’abandonner ?', context: 'Aucune valeur n’est imposée par le code existant.', options: null, answer: null },
  ]), at(0.3));

/* Session MULTI-DÉPÔTS partiellement en échec : le cas où « relancer » en bloc coûte cher.
   Deux projets sont passés, deux ont échoué — on voit donc le bouton « Lancer » par projet, le
   raccourci « Relancer les projets en échec », et « Vérifier l'état des branches ». C'est
   exactement la situation qui a motivé ces trois ajouts. */
const t5 = db.prepare('INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, auto_push, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)')
  .run(repoIds['groupe/api-core'], 'Ajoute un timeout de 30 s sur tous les appels HTTP sortants, et un log structuré en cas de dépassement.',
    'feature/http-timeout', 'main', 'error', 'code', 'push refusé : la branche distante a divergé', at(0.6), at(0.6));
const MULTI = [
  ['groupe/api-core', 'committed', null],
  ['groupe/webapp-front', 'error', 'push refusé : la branche distante a divergé'],
  ['groupe/batch-jobs', 'error', 'L’IA n’a modifié aucun fichier — elle a répondu au lieu de coder :\n\n« Je ne trouve aucun appel HTTP sortant dans ce dépôt. »'],
  ['acme/design-system', 'pushed', null],
];
for (const [projet, statut, err] of MULTI) {
  db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, commit_sha, last_error, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    t5.lastInsertRowid, repoIds[projet], 'feature/http-timeout', 'main', statut,
    statut === 'error' ? null : 'c0ffee1', err, at(0.6),
  );
}

/* Session RANGÉE + prompt LONG : les deux nouveautés de la liste réunies sur une seule fiche.
   Elle n'apparaît qu'en cochant « afficher les sessions masquées », et son prompt dépasse
   trois lignes, donc « Voir plus » s'y affiche. */
const t4 = db.prepare('INSERT INTO task (repo_id, prompt, branch, base_branch, status, kind, hidden, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)')
  .run(repoIds['groupe/api-core'], [
    'Migre la couche de persistance des commandes vers le nouveau schéma : la table `orders` doit',
    'porter `currency` et `tax_rate` au lieu du montant TTC pré-calculé, et le total doit être',
    'recalculé côté serveur à chaque lecture. Prévois une migration réversible, un backfill des',
    'lignes existantes à partir du taux en vigueur à la date de la commande, et des tests couvrant',
    'les commandes multi-devises ainsi que celles créées avant le changement de taux de 2025.',
    'Ne touche pas au format de l’API publique : la réponse doit rester identique octet pour octet.',
    'Documente la migration dans `docs/migrations/` en expliquant pourquoi le total n’est plus stocké,',
    'et ajoute une note dans le CHANGELOG. Si tu rencontres des commandes dont la devise est absente,',
    'ne devine pas : arrête-toi et remonte la liste des identifiants concernés plutôt que d’appliquer',
    'une valeur par défaut qui serait fausse pour une partie du parc. Enfin, vérifie que les rapports',
    'comptables mensuels donnent exactement les mêmes totaux avant et après migration sur les douze',
    'derniers mois — c’est le seul contrôle qui prouve que le backfill est correct.',
  ].join(' '), 'ai/orders-schema', 'main', 'pushed', 'code', at(9), at(9));
db.prepare('INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, mr_iid, mr_url, mr_merged, updated_at) VALUES (?,?,?,?,?,?,?,1,?)')
  .run(t4.lastInsertRowid, repoIds['groupe/api-core'], 'ai/orders-schema', 'main', 'pushed', 244,
    'https://gitlab.demo/groupe/api-core/-/merge_requests/244', at(9));

// ---------- codage hors dépôt (« Codage personnalisé ») ----------
// Session de codage IA dans des dossiers locaux, SANS git : remplit l'onglet dédié.
// (Une réussie sur deux dossiers, une en erreur, pour montrer les deux états agrégés.)
const lt1 = db.prepare('INSERT INTO local_task (prompt, status, created_at, updated_at) VALUES (?,?,?,?)')
  .run('Ajoute un logger structuré (niveau + timestamp ISO), remplace les console.log de ces utilitaires et écris un test pour chacun.', 'done', at(2), at(2));
// Chaque dossier porte le RETOUR DE L'IA (fichier sur disque, comme en vrai) : le bouton
// « Retour de l'IA » et « Demander une correction » sont donc démontrables sans agent.
const LOCAL_OUT = {
  '/home/moi/dev/backup-tool': `## Ce que j'ai fait\n\n- Ajouté \`src/logger.js\` : niveau (\`debug\`/\`info\`/\`warn\`/\`error\`) + timestamp ISO.\n- Remplacé les 14 \`console.log\` de \`backup.js\` et \`restore.js\`.\n- Ajouté \`test/logger.test.js\` (4 cas : format, niveaux, filtrage, sortie stderr).\n\n## Points d'attention\n\n- \`restore.js\` écrivait sur \`stdout\` des données consommées par un script appelant : j'ai gardé \`stdout\` pour celles-là et routé les logs vers \`stderr\`.\n`,
  '/home/moi/dev/csv-cleaner': `## Ce que j'ai fait\n\n- Ajouté le même \`src/logger.js\` (copie locale, ce dossier n'est pas un paquet partagé).\n- Remplacé les 6 \`console.log\` de \`clean.js\`.\n- Ajouté \`test/logger.test.js\`.\n\n## Question\n\nLes deux outils dupliquent maintenant le logger. Si tu veux, je peux extraire un petit paquet commun — dis-moi où le placer.\n`,
};
for (const p of Object.keys(LOCAL_OUT)) {
  const info = db.prepare('INSERT INTO local_task_dir (task_id, path, status, updated_at) VALUES (?,?,?,?)')
    .run(lt1.lastInsertRowid, p, 'done', at(2));
  const dir = ensureDir(path.join(TASKS_DIR, 'local', String(lt1.lastInsertRowid), String(info.lastInsertRowid)));
  const out = path.join(dir, 'output.md');
  fs.writeFileSync(out, LOCAL_OUT[p], 'utf8');
  db.prepare('UPDATE local_task_dir SET output_path = ?, session_key = ?, session_backend = ? WHERE id = ?')
    .run(out, `demo-local-${info.lastInsertRowid}`, 'claude', info.lastInsertRowid);
}
/* Codage hors dépôt CRÉÉ MAIS PAS LANCÉ (« Créer sans lancer ») : la carte porte alors un
   bouton « Lancer », et le badge du menu compte le travail en attente. Sans cet exemple,
   rien à l'écran ne montre qu'on peut préparer un traitement pour plus tard. */
const lt0 = db.prepare('INSERT INTO local_task (prompt, status, created_at, updated_at) VALUES (?,?,?,?)')
  .run('Passe ces scripts en ES modules et remplace les require() restants.', 'new', at(0.4), at(0.4));
db.prepare('INSERT INTO local_task_dir (task_id, path, status, updated_at) VALUES (?,?,?,?)')
  .run(lt0.lastInsertRowid, '/home/moi/dev/scripts', 'new', at(0.4));

const lt2 = db.prepare('INSERT INTO local_task (prompt, status, last_error, created_at, updated_at) VALUES (?,?,?,?,?)')
  .run('Convertis ce petit script Python en module réutilisable avec des tests pytest.', 'error', 'Le dossier n’a pas pu être traité (agent indisponible en démo).', at(1.2), at(1.2));
db.prepare('INSERT INTO local_task_dir (task_id, path, status, last_error, updated_at) VALUES (?,?,?,?,?)')
  .run(lt2.lastInsertRowid, '/home/moi/dev/legacy-report', 'error', 'agent indisponible', at(1.2));

// ---------- commentaires (comment_log : mr_id, body, sent_at) ----------
const someMr = db.prepare("SELECT id FROM mr WHERE status IN ('reviewed','done') LIMIT 1").get();
if (someMr) {
  db.prepare('INSERT INTO comment_log (mr_id, body, sent_at) VALUES (?, ?, ?)').run(someMr.id, 'Merci, LGTM après le point 2.', at(3));
  db.prepare('INSERT INTO comment_log (mr_id, body, sent_at) VALUES (?, ?, ?)').run(someMr.id, 'Bien vu pour la validation MIME.', at(2));
}

/* ---------- tickets Jira surveillés ----------
   Un ticket qui n'est PAS affecté à « moi » : c'est le cas d'usage réel de la surveillance —
   suivre un ticket tenu par quelqu'un d'autre parce qu'il débloque le sien.

   L'état semé (« À faire ») est VOLONTAIREMENT en retard sur celui du jeu Jira fictif
   (« En revue ») : à la première vérification, la démo détecte donc un vrai changement et
   affiche « dernier changement … ». Montrer la fonctionnalité vaut mieux que la décrire. */
db.prepare(`INSERT OR IGNORE INTO jira_watch (key, summary, status, status_category, added_at, checked_at, note)
            VALUES (?,?,?,?,?,?,?)`)
  .run('PROJ-1390', 'Migrer les logs vers le nouveau format JSON', 'À faire', 'new', at(4), at(0.2),
    'bloque la migration de la facturation — prévenir Sofia dès que c’est en revue');

/* ---------- vérification objective (plan_add_verify.md §12) ----------
   L'histoire qu'on montre est celle qui donne son sens à la fonctionnalité : deux merge
   requests de dépôts différents qui ne valent qu'ensemble, un premier verdict ROUGE avec les
   tests nommés, puis un second VERT après correction. Un écran vide n'aurait rien dit. */
const verifierId = db.prepare(`INSERT INTO verifier (name, command, timeout_s, run_base, comment_on_forge, created_at)
  VALUES (?,?,?,?,?,?)`).run('integ (démo)', '/usr/local/bin/integ-demo.sh', 900, 1, 0, at(20)).lastInsertRowid;
for (const projet of ['groupe/api-core', 'groupe/webapp-front']) {
  db.prepare("INSERT INTO verifier_repo (verifier_id, repo_id, mode, workdir, checkout_allowed) VALUES (?,?,'worktree',NULL,0)")
    .run(verifierId, repoIds[projet]);
}

/* Le second genre de vérificateur, celui qui ne demande rien à écrire : une liste de
   commandes sur UN dépôt. Sa présence rend la modale de confirmation représentative — on y
   choisit entre les deux familles, ce qui est le geste réel. */
const cmdId = db.prepare(`INSERT INTO verifier
  (name, kind, command, timeout_s, run_base, comment_on_forge, parse_tap, created_at)
  VALUES (?,?,'',?,?,?,1,?)`).run('tests front (démo)', 'commands', 600, 1, 0, at(18)).lastInsertRowid;
/* Deux dépôts pour ce vérificateur : la même liste est rejouée dans chacun. C'est le cas
   des projets qui se testent de la même façon, et ça se voit dans la modale. */
for (const projet of ['groupe/webapp-front', 'groupe/batch-jobs']) {
  db.prepare("INSERT INTO verifier_repo (verifier_id, repo_id, mode, workdir, checkout_allowed) VALUES (?,?,'worktree',NULL,0)")
    .run(cmdId, repoIds[projet]);
}
['npm ci', 'npm test'].forEach((c, i) => {
  db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?,?,?)').run(cmdId, i, c);
});

const lotId = db.prepare('INSERT INTO lot (name, kind, created_at) VALUES (?,?,?)')
  .run('Connexion + endpoint santé', 'mr', at(2)).lastInsertRowid;
const membresLot = [
  mrsAtraiter.find((m) => m.project === 'groupe/api-core'),
  mrsAtraiter.find((m) => m.project === 'groupe/webapp-front'),
];
for (const m of membresLot) {
  db.prepare("INSERT INTO lot_member (lot_id, kind, ref_id) VALUES (?, 'mr', ?)").run(lotId, m.id);
}

const ciblesLot = membresLot.map((m) => ({
  repo_id: repoIds[m.project], mr_id: m.id, head_sha: m.sha,
  base_sha: 'b' + require('crypto').randomBytes(19).toString('hex'),
  branch: m.source_branch, mode: 'worktree',
}));
const semerVerification = (quand, verdict, imputable, head) => db.prepare(`INSERT INTO verification
  (verifier_id, verifier_name, lot_id, lot_name, status, verdict, targets_json, base_run_json,
   head_run_json, imputable_json, started_at, finished_at, created_at)
  VALUES (?,?,?,?,'done',?,?,?,?,?,?,?,?)`).run(
  verifierId, 'integ (démo)', lotId, 'Connexion + endpoint santé', verdict,
  JSON.stringify(ciblesLot),
  JSON.stringify({ version: 1, status: 'pass', total: 218 }),
  JSON.stringify(head), JSON.stringify(imputable), quand, quand, quand);

/* D'abord l'échec, avec des messages qu'on pourrait vraiment lire dans une suite de tests…  */
semerVerification(at(1.4), 'verified_fail', [
  { test: 'connexion › jeton expiré', message: 'attendu 401, reçu 500', log_excerpt: 'AuthController.login\n  TypeError: cannot read property "exp" of undefined' },
  { test: 'santé › readiness quand la base est absente', message: 'attendu « degraded », reçu « ok »' },
], { version: 1, status: 'fail', total: 218, duration_ms: 96000, failed: [
  { test: 'connexion › jeton expiré', message: 'attendu 401, reçu 500' },
  { test: 'santé › readiness quand la base est absente', message: 'attendu « degraded », reçu « ok »' },
] });
// …puis le vert qui suit la correction : c'est cette séquence qui rend la fonctionnalité lisible.
semerVerification(at(0.3), 'verified_pass', [], { version: 1, status: 'pass', total: 218, duration_ms: 91000 });

/* Un verdict ROUGE encore d'actualité, sur une MR hors du lot et avec le vérificateur
   « commandes » : c'est lui qui montre le déroulé commande par commande et le bouton
   « Corriger ». Le lot, lui, raconte l'histoire échec → correction → vert, et finit donc au
   vert : sans cette troisième vérification, aucun écran ne montrerait un rouge courant. */
const mrRouge = mrsAtraiter.find((m) => m.project === 'groupe/batch-jobs');
const echecsCmd = [
  { test: 'export › reprend après une coupure réseau', message: 'attendu 3 tentatives, reçu 1',
    log_excerpt: 'nightlyExport.js:88\n  AssertionError [ERR_ASSERTION]: 1 !== 3' },
];
db.prepare(`INSERT INTO verification
  (verifier_id, verifier_name, lot_id, lot_name, status, verdict, targets_json, base_run_json,
   head_run_json, imputable_json, started_at, finished_at, created_at)
  VALUES (?,?,NULL,NULL,'done','verified_fail',?,?,?,?,?,?,?)`).run(
  cmdId, 'tests front (démo)',
  JSON.stringify([{ repo_id: repoIds['groupe/batch-jobs'], mr_id: mrRouge.id, head_sha: mrRouge.sha,
    base_sha: 'b' + require('crypto').randomBytes(19).toString('hex'),
    branch: mrRouge.source_branch, mode: 'worktree' }]),
  JSON.stringify({ version: 1, status: 'pass', total: 96,
    commands: [{ command: 'npm ci', code: 0, duration_ms: 39000, output_tail: 'ajout de 384 paquets en 39 s' },
      { command: 'npm test', code: 0, duration_ms: 51000, output_tail: '# pass 96\n# fail 0' }] }),
  JSON.stringify({ version: 1, status: 'fail', total: 96, duration_ms: 94000,
    failed: echecsCmd, detail_source: 'tap', detail_partiel: false, incoherence: false,
    commands: [{ command: 'npm ci', code: 0, duration_ms: 40000, output_tail: 'ajout de 384 paquets en 40 s' },
      { command: 'npm test', code: 1, duration_ms: 54000,
        output_tail: 'TAP version 13\nok 1 - export › écrit le fichier\nnot ok 2 - export › reprend après une coupure réseau\n# fail 1' }] }),
  JSON.stringify(echecsCmd), at(0.15), at(0.15), at(0.15));

const counts = {
  repos: db.prepare('SELECT COUNT(*) c FROM repo').get().c,
  mrs: db.prepare('SELECT COUNT(*) c FROM mr').get().c,
  reviews: db.prepare('SELECT COUNT(*) c FROM review').get().c,
  findings: db.prepare('SELECT COUNT(*) c FROM finding').get().c,
  usage: db.prepare('SELECT COUNT(*) c FROM usage').get().c,
  tasks: db.prepare('SELECT COUNT(*) c FROM task').get().c,
  convergences: db.prepare('SELECT COUNT(*) c FROM convergence_run').get().c,
  localTasks: db.prepare('SELECT COUNT(*) c FROM local_task').get().c,
  jiraWatch: db.prepare('SELECT COUNT(*) c FROM jira_watch').get().c,
  verifications: db.prepare('SELECT COUNT(*) c FROM verification').get().c,
};
console.log('Base de démo semée dans data-demo/ :', JSON.stringify(counts));
