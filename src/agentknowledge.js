'use strict';
/* La CONNAISSANCE d'un agent de domaine (spec agents §8.8).
 *
 * « Où est-ce qu'on gère les notifications, chez nous ? » se demandait au senior, ou
 * s'explorait à neuf à chaque fois. Un agent de domaine porte la réponse : un document
 * Markdown écrit une fois par le cartographe, à structure imposée, VERSIONNÉ et daté par le
 * SHA de chaque dépôt au moment où il a été écrit.
 *
 * Ce SHA est le cœur du dispositif : il permet de dire, SANS IA et pour rien, que la carte a
 * vieilli — `git log <sha>..origin/<défaut> -- <chemins cités>` compte les commits qui ont
 * touché ce qu'elle décrit. Le reste (les écarts remontés par les runs, la mise à jour
 * validée) se greffe dessus.
 *
 * Deux garanties tenues par le CODE et non par le prompt, parce qu'un prompt s'oublie :
 *   — un chemin cité est VÉRIFIÉ sous le clone, sinon il est marqué « non vérifié » ;
 *   — la section « Notes de l'équipe » est recopiée d'une version à l'autre.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const git = require('./git');
const notes = require('./notes');
const protocol = require('./protocol');
const glob = require('./glob');   // B7 : un chemin de carte peut porter une étoile
const { getConfig } = require('./config');
const { agentsDir } = require('./paths');
const i18n = require('../public/i18n-runtime.js');
const { t } = i18n;

const MAX_INDEX = 4000;
const jsonOu = (txt, repli) => { try { const v = JSON.parse(txt); return v == null ? repli : v; } catch { return repli; } };

/* ---------- Lecture ---------- */

const versionActive = (agentId) => db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ? AND status = 'active'").get(agentId);
const versionEnAttente = (agentId) => db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ? AND status = 'pending' ORDER BY version DESC").get(agentId);

function lireFichier(v) {
  if (!v || !v.md_path) return '';
  try { return fs.existsSync(v.md_path) ? fs.readFileSync(v.md_path, 'utf8') : ''; } catch { return ''; }
}
function contenuActif(agent) { return lireFichier(versionActive(agent.id)); }

function versions(agentId) {
  return db.prepare('SELECT * FROM agent_knowledge WHERE agent_id = ? ORDER BY version DESC').all(agentId)
    .map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      created_at: v.created_at,
      activated_at: v.activated_at,
      task_id: v.task_id,
      diff_summary: v.diff_summary,
      unverified: jsonOu(v.repos_json, []).reduce((n, r) => n + ((r.unverified || []).length), 0),
      gaps: jsonOu(v.gaps_json, []).length,
      repos: jsonOu(v.repos_json, []),
    }));
}

function versionDe(agentId, numero) {
  const v = db.prepare('SELECT * FROM agent_knowledge WHERE agent_id = ? AND version = ?').get(agentId, Number(numero));
  if (!v) return null;
  return { ...versions(agentId).find((x) => x.version === v.version), content: lireFichier(v) };
}

/* ---------- L'en-tête <<<AGENT>>> ---------- */

/* Le cartographe commence sa réponse par un bloc qui NOMME ce qu'il a trouvé. Sans lui, il
   faudrait déduire le périmètre en relisant le Markdown — et une phrase reformulée changerait
   silencieusement les dépôts de l'agent créé. */
function parseHeader(text) {
  const { block, rest } = protocol.extraire(text, 'AGENT');
  if (!block) return null;
  const out = { name: '', repos: [], paths: [], rest };
  for (const brut of String(block).split('\n')) {
    const l = brut.trim();
    if (!l) continue;
    const m = l.match(/^(name|repo|path)\s*:\s*(.*)$/i);
    if (!m) continue;
    const cle = m[1].toLowerCase();
    const val = m[2].trim();
    if (cle === 'name') { out.name = val.slice(0, 80); continue; }
    const champs = val.split('|').map((x) => x.trim());
    if (cle === 'repo' && champs[0]) out.repos.push({ project: champs[0], role: champs[1] || '' });
    if (cle === 'path' && champs[0] && champs[1]) out.paths.push({ project: champs[0], path: champs[1] });
  }
  return out;
}

/* ---------- Vérifier les chemins ---------- */

/* Un chemin « plausible » est le principal poison d'une carte : il fait perdre plus de temps
   qu'une carte absente, parce qu'on lui fait confiance. On les OUVRE donc, un par un, sous le
   clone — et jamais ailleurs : un `..` ou un chemin absolu sortiraient du dépôt, et ne sont
   pas des chemins du sujet mais des chemins de la machine. */
function verifierChemins(cfg, paths) {
  const verified = [];
  const unverified = [];
  const clones = new Map();
  for (const p of paths || []) {
    const brut = String((p && p.path) || '').trim();
    const projet = String((p && p.project) || '').trim();
    if (!brut || !projet) { if (brut) unverified.push({ project: projet, path: brut }); continue; }
    const norm = path.posix.normalize(brut.replace(/\\/g, '/'));
    if (norm.startsWith('/') || norm.split('/').includes('..')) { unverified.push({ project: projet, path: brut }); continue; }
    if (!clones.has(projet)) {
      const repo = db.prepare('SELECT * FROM repo WHERE project = ?').get(projet);
      let dir = null;
      try { dir = repo ? git.cloneDirFor(cfg, repo) : null; } catch { dir = null; }
      clones.set(projet, dir && fs.existsSync(dir) ? dir : null);
    }
    const dir = clones.get(projet);
    if (dir && fs.existsSync(path.join(dir, norm))) verified.push({ project: projet, path: norm });
    else unverified.push({ project: projet, path: norm });
  }
  return { verified, unverified };
}

/* Le Markdown affiché porte la marque : un chemin non vérifié est suivi de « (non vérifié) ».
   La marque est posée par le CODE, sur le texte de l'agent — c'est ce qui la rend fiable. */
function marquerNonVerifies(md, unverified) {
  let s = String(md || '');
  for (const u of unverified) {
    const p = u.path;
    if (!p) continue;
    const re = new RegExp(`(\`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`)(?! ?\\*\\()`, 'g');
    s = s.replace(re, `$1 ${t('agents.knowledge.unverified-mark')}`);
  }
  return s;
}

/* ---------- Sections ---------- */

const RE_NOTES = /^##\s+(Notes de l['’]équipe|Team notes)\s*$/im;

// Extrait une section de titre `## …` jusqu'au prochain `## `.
function section(md, re) {
  const s = String(md || '');
  const lignes = s.split('\n');
  const i = lignes.findIndex((l) => re.test(l));
  if (i === -1) return null;
  let j = i + 1;
  while (j < lignes.length && !/^##\s+/.test(lignes[j])) j += 1;
  return { debut: i, fin: j, texte: lignes.slice(i, j).join('\n') };
}

/* La section « Notes de l'équipe » survit aux mises à jour. Le prompt le demande ; le code le
   GARANTIT — un agent qui reformule ou oublie effacerait ce que l'équipe a écrit à la main,
   c'est-à-dire la seule partie du document qu'aucune cartographie ne saurait reproduire. */
function conserverNotes(nouveau, ancien) {
  const src = section(ancien, RE_NOTES);
  if (!src || !src.texte.trim()) return nouveau;
  const cible = section(nouveau, RE_NOTES);
  const lignes = String(nouveau || '').split('\n');
  if (!cible) return `${nouveau.trimEnd()}\n\n${src.texte.trim()}\n`;
  return [...lignes.slice(0, cible.debut), src.texte.trim(), ...lignes.slice(cible.fin)].join('\n');
}

/* ---------- Écrire une version ---------- */

function ecrireVersion(agentId, { contenu, reposJson, taskId, diffSummary, gapsJson, status }) {
  const dernier = db.prepare('SELECT MAX(version) v FROM agent_knowledge WHERE agent_id = ?').get(agentId);
  const n = ((dernier && dernier.v) || 0) + 1;
  const mdPath = path.join(agentsDir(agentId), `knowledge-v${n}.md`);
  fs.writeFileSync(mdPath, contenu, 'utf8');
  const now = new Date().toISOString();
  const poser = db.transaction(() => {
    if (status === 'active') {
      db.prepare("UPDATE agent_knowledge SET status = 'superseded' WHERE agent_id = ? AND status = 'active'").run(agentId);
    }
    db.prepare(`INSERT INTO agent_knowledge (agent_id, version, md_path, repos_json, task_id, diff_summary, gaps_json, status, created_at, activated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(agentId, n, mdPath, JSON.stringify(reposJson || []), taskId || null,
      diffSummary || null, JSON.stringify(gapsJson || []), status, now, status === 'active' ? now : null);
  });
  poser();
  return db.prepare('SELECT * FROM agent_knowledge WHERE agent_id = ? AND version = ?').get(agentId, n);
}

/* L'état de chaque dépôt au moment où la carte a été écrite : SHA + chemins cités. C'est CE
   SHA qui rend l'âge calculable plus tard, sans IA et pour rien. */
async function reposJsonDe(cfg, repos, verified, unverified) {
  const out = [];
  for (const r of repos) {
    const repo = db.prepare('SELECT * FROM repo WHERE project = ?').get(r.project);
    let sha = null;
    try {
      const dir = repo ? git.cloneDirFor(cfg, repo) : null;
      if (dir && fs.existsSync(dir)) sha = await git.headSha(dir);
    } catch { sha = null; }
    out.push({
      repo_id: repo ? repo.id : null,
      project: r.project,
      role: r.role || '',
      sha,
      paths: verified.filter((x) => x.project === r.project).map((x) => x.path),
      unverified: unverified.filter((x) => x.project === r.project).map((x) => x.path),
    });
  }
  return out;
}

/* ---------- Créer ou mettre à jour ---------- */

/* `ingest` est appelé après un run du cartographe. Deux cas, distingués par ce que porte la
   `task` : sans agent de domaine, c'est une CRÉATION ; avec, c'est une mise à jour, qui
   n'entre jamais en service sans un clic (décision 6). */
async function ingest(task, agentCarto, texte, onLog = () => {}) {
  const cfg = getConfig();
  const tete = parseHeader(texte);
  if (!tete || !tete.name) {
    onLog(t('agents.err.no-agent-header'));
    return null;
  }
  // eslint-disable-next-line global-require
  const agentprofile = require('./agentprofile');
  const majDe = task.agent_id && task.agent_id !== agentCarto.id ? agentprofile.lire(task.agent_id) : null;

  const connus = [];
  for (const r of tete.repos) {
    const repo = db.prepare('SELECT * FROM repo WHERE project = ?').get(r.project);
    if (!repo) { onLog(t('agents.log.unknown-project', { project: r.project })); continue; }
    connus.push({ ...r, repo_id: repo.id });
  }
  // Chaque dépôt cité est rafraîchi avant qu'on vérifie ses chemins : vérifier sur un clone
  // d'il y a trois semaines marquerait « non vérifié » un fichier qui existe.
  for (const r of connus) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(r.repo_id);
    try { await git.ensureRepo(cfg, repo, () => {}); } catch { /* dépôt injoignable : on vérifie sur ce qu'on a */ }
  }
  const { verified, unverified } = verifierChemins(cfg, tete.paths.filter((p) => connus.some((r) => r.project === p.project)));
  let contenu = marquerNonVerifies(tete.rest, unverified);
  const reposJson = await reposJsonDe(cfg, connus, verified, unverified);

  if (majDe) {
    const ancien = contenuActif(majDe);
    contenu = conserverNotes(contenu, ancien);
    const v = ecrireVersion(majDe.id, {
      contenu,
      reposJson,
      taskId: task.id,
      diffSummary: diffSummary(ancien, contenu, reposJson, jsonOu((versionActive(majDe.id) || {}).repos_json, [])),
      gapsJson: [],
      status: 'pending',
    });
    onLog(t('agents.log.knowledge-pending', { name: majDe.name, version: v.version }));
    return { agent_id: majDe.id, version: v.version, status: 'pending' };
  }

  const nom = nomLibre(tete.name.trim());
  const cree = agentprofile.creer({
    name: nom,
    description: t('agents.knowledge.created-desc', { subject: task.prompt ? '' : '' }).trim() || '',
    kind: 'explore',
    scope_kind: 'repos',
    system_prompt: '',
    prompt_template: '{question}',
    // LE SUJET, pas le prompt composé : c'est lui qu'on relancera à chaque mise à jour.
    knowledge_prompt: task.agent_question || nom,
    max_turns: 60,
    output_kind: 'report',
    repos: connus.map((r) => ({ repo_id: r.repo_id, branch: '', role: 'readonly' })),
  });
  const v = ecrireVersion(cree.id, { contenu, reposJson, taskId: task.id, gapsJson: [], status: 'active' });
  onLog(t('agents.log.agent-created', { name: cree.name, version: v.version }));
  return { agent_id: cree.id, version: v.version, status: 'active' };
}

function nomLibre(base) {
  let n = String(base || '').slice(0, 80) || 'Agent';
  if (!db.prepare('SELECT 1 FROM agent WHERE name = ?').get(n)) return n;
  for (let i = 2; i < 100; i += 1) {
    n = `${String(base).slice(0, 74)} (${i})`;
    if (!db.prepare('SELECT 1 FROM agent WHERE name = ?').get(n)) return n;
  }
  return `${String(base).slice(0, 70)} ${Date.now()}`;
}

/* ---------- Diff mécanique ---------- */

/* Un résumé CALCULÉ, pas raconté : dépôts entrés et sortis, chemins apparus et disparus. Le
   paragraphe que le cartographe écrit lui-même s'ajoute derrière ; il commente, il ne prouve. */
function diffSummary(ancienMd, nouveauMd, reposNouveaux, reposAnciens) {
  const projets = (l) => new Set((l || []).map((r) => r.project));
  const chemins = (l) => new Set((l || []).flatMap((r) => (r.paths || []).map((p) => `${r.project}/${p}`)));
  const av = projets(reposAnciens); const ap = projets(reposNouveaux);
  const cav = chemins(reposAnciens); const cap = chemins(reposNouveaux);
  const plus = [...ap].filter((x) => !av.has(x));
  const moins = [...av].filter((x) => !ap.has(x));
  const cplus = [...cap].filter((x) => !cav.has(x));
  const cmoins = [...cav].filter((x) => !cap.has(x));
  const lignes = [];
  if (plus.length) lignes.push(t('agents.diff.repos-added', { list: plus.join(', ') }));
  if (moins.length) lignes.push(t('agents.diff.repos-removed', { list: moins.join(', ') }));
  if (cplus.length) lignes.push(t('agents.diff.paths-added', { n: cplus.length, count: cplus.length }));
  if (cmoins.length) lignes.push(t('agents.diff.paths-removed', { n: cmoins.length, count: cmoins.length }));
  const ecrit = section(nouveauMd, /^##\s+(Ce qui a changé|What changed)\s*$/im);
  if (ecrit) lignes.push(ecrit.texte.split('\n').slice(1).join('\n').trim());
  if (!lignes.length) lignes.push(t('agents.diff.nothing'));
  return lignes.filter(Boolean).join('\n');
}

/* ---------- Activer, éditer, écarts ---------- */

function activer(agent, version) {
  const v = db.prepare('SELECT * FROM agent_knowledge WHERE agent_id = ? AND version = ?').get(agent.id, Number(version));
  if (!v) return { error: 'agents.err.version-not-found' };
  if (v.status !== 'pending') return { error: 'agents.err.not-pending' };
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE agent_knowledge SET status = 'superseded' WHERE agent_id = ? AND status = 'active'").run(agent.id);
    db.prepare("UPDATE agent_knowledge SET status = 'active', activated_at = ? WHERE id = ?").run(now, v.id);
  })();
  return { ok: true, version: v.version };
}

/* Une édition à la main entre en service TOUT DE SUITE (décision 6) : c'est un humain qui a
   écrit, il n'y a personne d'autre à qui la faire relire. `task_id` reste nul — cette version
   ne vient d'aucun run. */
function editer(agent, contenu) {
  const active = versionActive(agent.id);
  const v = ecrireVersion(agent.id, {
    contenu: String(contenu || ''),
    reposJson: jsonOu((active || {}).repos_json, []),
    taskId: null,
    gapsJson: jsonOu((active || {}).gaps_json, []),
    status: 'active',
  });
  return { version: v.version };
}

// Les écarts s'accumulent sur la version ACTIVE : c'est elle qu'ils décrivent.
function addGaps(agent, task, gaps) {
  const v = versionActive(agent.id);
  if (!v) return;
  const liste = jsonOu(v.gaps_json, []);
  const at = new Date().toISOString();
  for (const g of gaps) liste.push({ task_id: task.id, project: g.project, path: g.path, note: g.note, at });
  db.prepare('UPDATE agent_knowledge SET gaps_json = ? WHERE id = ?').run(JSON.stringify(liste.slice(-200)), v.id);
}

/* ---------- B7 : quelles cartes une merge request touche ---------- */

/* La carte d'un agent de domaine cite des CHEMINS, dépôt par dépôt ; une merge request stocke
   les chemins de son diff (`mr.changed_paths`, alimenté par la découverte). Les deux se
   croisent depuis toujours sans que personne ne fasse le produit — alors que c'est exactement
   la question qu'on se pose en ouvrant une merge request inconnue : « est-ce que ça touche un
   domaine dont on a une carte ? ».

   LE CROISEMENT SE FAIT PAR PRÉFIXE, pas par glob. Une carte cite `src/notifications/` ou
   `src/notify.js` — ce qu'on écrit quand on décrit un domaine — et non un motif d'extension ; traiter
   ces chemins comme des motifs ferait qu'un dossier ne matcherait aucun fichier dedans, c'est-
   à-dire rien. Un chemin qui contient une étoile est quand même passé au glob : quelqu'un
   finira par en écrire un, et l'ignorer silencieusement serait pire.

   L'INDEX EST CONSTRUIT UNE FOIS pour toute une liste de merge requests : une requête par
   carte × trente cartes de liste ferait quatre-vingt-dix lectures pour un badge. */
function indexCartes() {
  const out = [];
  for (const a of db.prepare(`SELECT a.id, a.name FROM agent a
      JOIN agent_knowledge k ON k.agent_id = a.id AND k.status = 'active' ORDER BY a.name`).all()) {
    const v = versionActive(a.id);
    for (const r of jsonOu((v || {}).repos_json, [])) {
      const chemins = (r.paths || []).map((x) => String(x || '').replace(/^\.?\//, '').replace(/\/+$/, '')).filter(Boolean);
      if (!chemins.length) continue;
      out.push({ agent_id: a.id, name: a.name, repo_id: r.repo_id || null, project: r.project || '', paths: chemins });
    }
  }
  return out;
}

function toucheCarte(carte, chemins) {
  return (chemins || []).some((brut) => {
    const p = String(brut || '').replace(/^\.?\//, '');
    return carte.paths.some((c) => (c.includes('*')
      ? glob.pathMatches(c, p)
      : (p === c || p.startsWith(`${c}/`))));
  });
}

/* Les cartes touchées par UNE merge request. `changed` est la colonne telle qu'elle est
   stockée (des chemins séparés par des retours à la ligne) ; `null` tant que la découverte
   n'a pas encore lu le diff — on ne dit alors rien, plutôt que « aucune carte ». */
function cartesTouchees(index, repoId, changed) {
  if (!changed) return [];
  const chemins = String(changed).split('\n').filter(Boolean);
  const vues = new Set();
  const out = [];
  for (const c of index) {
    if (c.repo_id && repoId && c.repo_id !== repoId) continue;
    if (vues.has(c.agent_id) || !toucheCarte(c, chemins)) continue;
    vues.add(c.agent_id);
    out.push({ agent_id: c.agent_id, name: c.name });
  }
  return out;
}

/* ---------- L'âge, sans IA ---------- */

const cacheAge = new Map();   // agent_id → { at, valeur }

async function age(agent) {
  const cache = cacheAge.get(agent.id);
  if (cache && Date.now() - cache.at < 3600000) return cache.valeur;
  const cfg = getConfig();
  const v = versionActive(agent.id);
  const out = [];
  for (const r of jsonOu((v || {}).repos_json, [])) {
    const repo = r.repo_id ? db.prepare('SELECT * FROM repo WHERE id = ?').get(r.repo_id) : null;
    if (!repo || !r.sha) { out.push({ project: r.project, commits: null, last_at: null }); continue; }
    try {
      const dir = await git.ensureRepo(cfg, repo, () => {});
      const defaut = await git.defaultBranch(dir);
      const args = ['log', '--format=%H %cI', `${r.sha}..origin/${defaut}`];
      // Chemins vides = tout le dépôt : une carte qui ne cite aucun chemin vieillit quand même.
      if ((r.paths || []).length) args.push('--', ...r.paths);
      const sortie = await git.run('git', args, { cwd: dir });
      const lignes = String((sortie && sortie.stdout) || sortie || '').trim().split('\n').filter(Boolean);
      out.push({ project: r.project, commits: lignes.length, last_at: lignes.length ? lignes[0].split(' ')[1] : null });
    } catch { out.push({ project: r.project, commits: null, last_at: null }); }
  }
  cacheAge.set(agent.id, { at: Date.now(), valeur: out });
  return out;
}
function viderCacheAge(agentId) { if (agentId) cacheAge.delete(agentId); else cacheAge.clear(); }

/* ---------- Mise à jour ---------- */

/* Relancer le cartographe avec le MÊME sujet, plus tout ce qu'on a appris depuis : la carte
   précédente, les écarts constatés, et les commits qui ont touché ses chemins. « Regarde
   d'abord là » — c'est la différence entre vérifier et recommencer. */
async function refresh(agent, triggeredBy = 'manual') {
  // eslint-disable-next-line global-require
  const agentprofile = require('./agentprofile');
  const carto = agentprofile.parCle('cartographer');
  if (!carto) throw new Error(t('agents.err.no-cartographer'));
  const v = versionActive(agent.id);
  contexteRefresh.set(agent.id, {
    precedent: lireFichier(v),
    gaps: jsonOu((v || {}).gaps_json, []),
    commits: await commitsDepuis(agent),
  });
  const repoIds = agentprofile.repos(agent.id).map((r) => r.repo_id);
  return agentprofile.lancer(carto, {
    mode: 'ask',
    question: agent.knowledge_prompt || agent.name,
    repoIds,
    triggeredBy,
    // La `task` porte l'agent de DOMAINE : c'est sur sa carte que la mise à jour doit apparaître.
    agentIdSur: agent.id,
  });
}

/* Le contexte d'une mise à jour, entre `refresh` (qui le calcule) et l'exécutant (qui écrit
   les fichiers, une fois les clones prêts). En mémoire : il ne survit pas à un redémarrage,
   et c'est très bien — un run interrompu se relance. */
const contexteRefresh = new Map();
/* CONSOMMÉ à la lecture : une mise à jour l'utilise une fois. Le garder ferait recevoir les
   fichiers de rafraîchissement à la question suivante posée au même agent, qui n'a rien
   demandé — et « regarde d'abord là » n'aurait plus de sens. */
function prendreContexteRefresh(agentId) {
  const c = contexteRefresh.get(agentId);
  if (c) contexteRefresh.delete(agentId);
  return c || null;
}

async function commitsDepuis(agent) {
  const cfg = getConfig();
  const v = versionActive(agent.id);
  const out = [];
  for (const r of jsonOu((v || {}).repos_json, [])) {
    const repo = r.repo_id ? db.prepare('SELECT * FROM repo WHERE id = ?').get(r.repo_id) : null;
    if (!repo || !r.sha) continue;
    try {
      const dir = await git.ensureRepo(cfg, repo, () => {});
      const defaut = await git.defaultBranch(dir);
      const args = ['log', '--format=%h %s (%an, %cs)', `${r.sha}..origin/${defaut}`];
      if ((r.paths || []).length) args.push('--', ...r.paths);
      const sortie = await git.run('git', args, { cwd: dir });
      const lignes = String((sortie && sortie.stdout) || sortie || '').trim().split('\n').filter(Boolean);
      if (lignes.length) out.push({ project: r.project, lines: lignes.slice(0, 200) });
    } catch { /* dépôt injoignable : la mise à jour se fera sans sa liste */ }
  }
  return out;
}

/* ---------- L'index dans le prompt système ---------- */

/* Le document complet part en fichier ; le prompt système n'en porte que l'INDEX — de quoi
   savoir où chercher sans relire quatre pages à chaque tour. Plafonné : au-delà, ce n'est plus
   un index, c'est le document, et le sujet était trop large (§7, décision 7). */
function indexFor(agent) {
  const md = contenuActif(agent);
  if (!md) return '';
  const lignes = [`# ${agent.name}`];
  const per = section(md, /^##\s+(Périmètre|Scope)\s*$/im);
  if (per) {
    const phrase = per.texte.split('\n').slice(1).map((x) => x.trim()).filter(Boolean)[0];
    if (phrase) lignes.push(phrase);
  }
  const v = versionActive(agent.id);
  for (const r of jsonOu((v || {}).repos_json, [])) {
    const cinq = (r.paths || []).slice(0, 5).map((p) => `\`${p}\``).join(', ');
    lignes.push(`- ${r.project}${r.role ? ` — ${r.role}` : ''}${cinq ? ` : ${cinq}` : ''}`);
  }
  const s = lignes.join('\n');
  return s.length > MAX_INDEX ? `${s.slice(0, MAX_INDEX - 2)} …` : s;
}

// La connaissance, copiée dans une page de notes — même règle que le documentaliste : créée
// une fois, mise à jour ensuite, jamais dupliquée.
function publierDansNotes(agent) {
  const msgs = { titreVide: t('err.notes.title-required'), inconnue: t('err.notes.unknown') };
  const titre = `${agent.name} — ${t('agents.knowledge.note-suffix')}`;
  const contenu = contenuActif(agent);
  const existante = notes.listerPages(titre).find((p) => p.title === titre);
  if (existante) { notes.majPage(existante.id, { content: contenu }, msgs); return { page_id: existante.id }; }
  const cree = notes.creerPage({ title: titre, content: contenu }, msgs);
  return { page_id: cree.id };
}

module.exports = {
  ingest, parseHeader, verifierChemins, age, viderCacheAge, refresh, activer, editer, addGaps,
  indexCartes, cartesTouchees, toucheCarte,
  indexFor, diffSummary, publierDansNotes, contenuActif, versions, versionDe, versionActive,
  versionEnAttente, conserverNotes, prendreContexteRefresh, marquerNonVerifies, section,
};
