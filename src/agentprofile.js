'use strict';
/* Du PROFIL au lancement (spec agents §8.5 et §8.6).
 *
 * Un agent Mergerie est un profil de session : ce qu'on met autour d'un lancement du CLI.
 * Ce module fait trois choses et rien d'autre —
 *   1. le CRUD des profils, avec sa validation (`valider`, refus à la sauvegarde) ;
 *   2. la traduction d'un profil en OPTIONS de lancement (`optionsFor`) et en DEMANDE
 *      (`composer`), lues par les exécutants juste avant `runInSession` ;
 *   3. ce qu'on fait de la SORTIE une fois le run réussi (`apresRun`).
 *
 * Ce qu'il ne fait pas : orchestrer. L'intelligence reste dans le CLI ; un run d'agent est une
 * `task` ordinaire, et tout ce qui la suit (file de jobs, questions, passes, coût) existe déjà.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const agentargs = require('./agentargs');
const agentdefaults = require('./agentdefaults');
const agentinput = require('./agentinput');
const protocol = require('./protocol');
const skillscan = require('./skillscan');
const questions = require('./questions');
const notes = require('./notes');
const git = require('./git');
const { getConfig } = require('./config');
const { avecConsignes } = require('./prompts');
const i18n = require('../public/i18n-runtime.js');
const { t } = i18n;

const jsonOu = (txt, repli) => { try { const v = JSON.parse(txt); return v == null ? repli : v; } catch { return repli; } };

/* Les allowlists par défaut. Une exploration LIT — et lit l'histoire du dépôt, ce qui demande
   `git log`/`show`/`blame` mais rien qui écrive. Un codage a besoin d'écrire, et de la panoplie
   habituelle. Elles ne s'appliquent que si le profil n'en donne pas : le sien fait toujours foi. */
const OUTILS_DEFAUT = {
  explore: ['Read', 'Glob', 'Grep', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git blame *)'],
  code: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)', 'Bash(npm *)', 'Bash(ls *)'],
};

/* ---------- Lecture ---------- */

function repos(agentId) {
  return db.prepare(`SELECT ar.repo_id, ar.branch, ar.role, repo.project
    FROM agent_repo ar JOIN repo ON repo.id = ar.repo_id
    WHERE ar.agent_id = ? ORDER BY repo.project`).all(agentId);
}

function decorer(a) {
  if (!a) return null;
  const k = db.prepare(`SELECT id, version, status, created_at, repos_json, gaps_json FROM agent_knowledge
    WHERE agent_id = ? AND status = 'active'`).get(a.id);
  const enAttente = db.prepare(`SELECT version FROM agent_knowledge
    WHERE agent_id = ? AND status = 'pending' ORDER BY version DESC`).get(a.id);
  const dernier = db.prepare(`SELECT id AS task_id, status, finished_at FROM task
    WHERE agent_id = ? ORDER BY id DESC`).get(a.id);
  const cout = dernier ? db.prepare(`SELECT SUM(cost_usd) c FROM usage
    WHERE owner_kind = 'task' AND owner_id = ?`).get(dernier.task_id) : null;
  return {
    ...a,
    repos: repos(a.id),
    is_domain: a.knowledge_prompt != null,
    last_run: dernier ? { ...dernier, cost_usd: (cout && cout.c) || null } : null,
    run_count: db.prepare('SELECT COUNT(*) n FROM task WHERE agent_id = ?').get(a.id).n,
    knowledge: k ? {
      id: k.id,
      version: k.version,
      status: k.status,
      created_at: k.created_at,
      unverified: jsonOu(k.repos_json, []).reduce((n, r) => n + ((r.unverified || []).length), 0),
      gaps: jsonOu(k.gaps_json, []).length,
      pending_version: enAttente ? enAttente.version : null,
    } : (enAttente ? { pending_version: enAttente.version } : null),
  };
}

function lister() {
  return db.prepare('SELECT * FROM agent ORDER BY name').all().map(decorer);
}
function lire(id) {
  return decorer(db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0));
}
function parCle(builtinKey) {
  return decorer(db.prepare('SELECT * FROM agent WHERE builtin_key = ?').get(builtinKey));
}

/* ---------- Validation ---------- */

const COLONNES = ['name', 'description', 'kind', 'scope_kind', 'system_prompt', 'prompt_template',
  'model', 'permission_mode', 'allowed_tools_json', 'disallowed_tools_json', 'max_turns',
  'skills_json', 'subagents_json', 'output_kind', 'output_ref', 'knowledge_prompt', 'schedule',
  'defaults_json'];

function valider(body, id = null) {
  const errs = [];
  const nom = String((body && body.name) || '').trim();
  if (!nom) errs.push('agents.err.name-required');
  else {
    const autre = db.prepare('SELECT id FROM agent WHERE name = ?').get(nom);
    if (autre && autre.id !== Number(id)) errs.push('agents.err.name-taken');
  }
  if (body.kind != null && !['explore', 'code'].includes(body.kind)) errs.push('agents.err.kind');
  if (body.scope_kind != null && !['repos', 'all_repos'].includes(body.scope_kind)) errs.push('agents.err.scope');
  if (body.output_kind != null && !['report', 'note_page', 'agent'].includes(body.output_kind)) errs.push('agents.err.output-kind');
  /* UN SEUL NIVEAU (décision 9). Un agent de domaine qui créerait des agents ouvrirait une
     hiérarchie que rien ne borne, et dont personne ne saurait plus qui a écrit quoi. */
  if (body.output_kind === 'agent' && String(body.knowledge_prompt || '').trim()) {
    errs.push('agents.err.domain-cannot-create');
  }
  /* Un horaire sans borne de tours est un agent qui peut partir seul, la nuit, sans limite de
     travail. La borne est la seule chose qui rende l'automatique acceptable. */
  if (String(body.schedule || '').trim() && !(Number(body.max_turns) > 0)) {
    errs.push('agents.err.schedule-needs-max-turns');
  }
  if (String(body.schedule || '').trim()) {
    // eslint-disable-next-line global-require
    const agentschedule = require('./agentschedule');
    if (!agentschedule.parse(body.schedule)) errs.push('agents.err.schedule-syntax');
  }
  /* `subagents_json` arrive tantôt en OBJET (formulaire du front), tantôt en TEXTE (relecture
     d'une ligne de base). Ne traiter que le second laissait passer sans un mot un sous-agent
     incomplet venu du formulaire — précisément le cas que la validation existe pour attraper. */
  const sous = (body.subagents_json && typeof body.subagents_json === 'object')
    ? body.subagents_json : jsonOu(body.subagents_json, {});
  errs.push(...agentargs.validate({
    model: body.model,
    permissionMode: body.permission_mode,
    maxTurns: body.max_turns,
    agents: sous,
  }));
  return [...new Set(errs)];
}

/* ---------- Écriture ---------- */

function ecrireRepos(agentId, liste) {
  db.prepare('DELETE FROM agent_repo WHERE agent_id = ?').run(agentId);
  const ins = db.prepare('INSERT OR IGNORE INTO agent_repo (agent_id, repo_id, branch, role) VALUES (?,?,?,?)');
  for (const r of liste || []) {
    const rid = Number(r && r.repo_id);
    if (!rid) continue;
    ins.run(agentId, rid, String((r && r.branch) || '').trim(), r && r.role === 'target' ? 'target' : 'readonly');
  }
}

function valeursDe(body, base = {}) {
  const v = { ...base };
  for (const c of COLONNES) if (body[c] !== undefined) v[c] = body[c];
  v.name = String(v.name || '').trim().slice(0, 120);
  v.description = String(v.description || '');
  v.kind = v.kind === 'code' ? 'code' : 'explore';
  v.scope_kind = v.scope_kind === 'repos' ? 'repos' : 'all_repos';
  v.system_prompt = String(v.system_prompt || '');
  v.prompt_template = String(v.prompt_template || '');
  v.model = String(v.model || '').trim();
  v.permission_mode = String(v.permission_mode || '').trim();
  for (const c of ['allowed_tools_json', 'disallowed_tools_json', 'skills_json']) {
    v[c] = JSON.stringify(Array.isArray(v[c]) ? v[c] : jsonOu(v[c], []));
  }
  v.subagents_json = JSON.stringify(typeof v.subagents_json === 'object' && v.subagents_json
    ? v.subagents_json : jsonOu(v.subagents_json, {}));
  v.defaults_json = JSON.stringify(typeof v.defaults_json === 'object' && v.defaults_json
    ? v.defaults_json : jsonOu(v.defaults_json, {}));
  v.max_turns = Number(v.max_turns) > 0 ? Math.round(Number(v.max_turns)) : null;
  v.output_kind = ['report', 'note_page', 'agent'].includes(v.output_kind) ? v.output_kind : 'report';
  v.output_ref = v.output_ref ? String(v.output_ref) : null;
  v.knowledge_prompt = String(v.knowledge_prompt || '').trim() || null;
  v.schedule = String(v.schedule || '').trim() || null;
  return v;
}

function creer(body) {
  const v = valeursDe(body, {});
  const now = new Date().toISOString();
  const cols = [...COLONNES, 'builtin_key', 'created_at', 'updated_at'];
  const info = db.prepare(`INSERT INTO agent (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
    .run({ ...v, builtin_key: body.builtin_key || null, created_at: now, updated_at: now });
  ecrireRepos(info.lastInsertRowid, body.repos);
  return lire(info.lastInsertRowid);
}

function modifier(id, patch) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a) return null;
  const v = valeursDe(patch, a);
  db.prepare(`UPDATE agent SET ${COLONNES.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...v, id: a.id, updated_at: new Date().toISOString() });
  if (patch.repos !== undefined) ecrireRepos(a.id, patch.repos);
  return lire(a.id);
}

function supprimer(id) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a) return false;
  /* Les `task` gardent `agent_name` : la session reste lisible et la carte continue de dire
     qui l'a produite. C'est `ON DELETE SET NULL` sur `agent_id` qui s'en charge. */
  db.prepare('DELETE FROM agent WHERE id = ?').run(a.id);
  // Pas de cascade sur le DISQUE : les versions de connaissance s'effacent explicitement.
  // eslint-disable-next-line global-require
  const { AGENTS_DIR } = require('./paths');
  try { fs.rmSync(path.join(AGENTS_DIR, String(a.id)), { recursive: true, force: true }); } catch { /* best-effort */ }
  return true;
}

// Un nom libre à partir d'un nom pris : « X (copie) », « X (copie 2) »…
function nomLibre(base) {
  let n = base.slice(0, 110);
  if (!db.prepare('SELECT 1 FROM agent WHERE name = ?').get(n)) return n;
  for (let i = 2; i < 100; i += 1) {
    n = `${base.slice(0, 105)} (${i})`;
    if (!db.prepare('SELECT 1 FROM agent WHERE name = ?').get(n)) return n;
  }
  return `${base.slice(0, 100)} ${Date.now()}`;
}

function dupliquer(id) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a) return null;
  /* Une copie est un agent NEUF : ni `builtin_key` (sinon deux agents se disputeraient le
     bouton « Restaurer »), ni connaissance (elle est datée par SHA et appartient à l'original). */
  const copie = creer({
    ...a,
    name: nomLibre(`${a.name} ${t('agents.copy-suffix')}`),
    builtin_key: null,
    repos: repos(a.id),
  });
  return copie;
}

/* ---------- Agents livrés ---------- */

function seedBuiltins() {
  const lang = (getConfig().language === 'en') ? 'en' : 'fr';
  for (const cle of agentdefaults.CLES) {
    if (db.prepare('SELECT 1 FROM agent WHERE builtin_key = ?').get(cle)) continue;
    const d = agentdefaults.ligneDefaut(cle, lang);
    if (!d) continue;
    /* Ne JAMAIS réécrire une ligne existante : le rôle a pu être affiné au fil des runs, et
       un semis au démarrage qui écrase est une perte silencieuse à chaque redémarrage. */
    creer({ ...d, name: nomLibre(d.name), builtin_key: cle, repos: [] });
  }
}

function restaurer(id) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id) || 0);
  if (!a || !a.builtin_key) return null;
  const lang = (getConfig().language === 'en') ? 'en' : 'fr';
  const d = agentdefaults.ligneDefaut(a.builtin_key, lang);
  if (!d) return null;
  // Le nom aussi revient au défaut — sauf s'il est pris par un AUTRE agent.
  const pris = db.prepare('SELECT id FROM agent WHERE name = ?').get(d.name);
  return modifier(a.id, { ...d, name: (pris && pris.id !== a.id) ? a.name : d.name });
}

/* ---------- Du profil aux options de lancement ---------- */

function cheminsLecture(agent) {
  const cfg = getConfig();
  const out = [];
  for (const r of repos(agent.id)) {
    if (r.role !== 'readonly') continue;
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(r.repo_id);
    if (!repo) continue;
    try { const d = git.cloneDirFor(cfg, repo); if (fs.existsSync(d)) out.push(d); } catch { /* non cloné */ }
  }
  return out;
}

function optionsFor(task) {
  if (!task || !task.agent_id) return {};
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
  if (!a) return {};
  const allowed = jsonOu(a.allowed_tools_json, []);
  return {
    model: a.model,
    appendSystemPrompt: systemPromptFor(task, a),
    // Vide = `acceptEdits` : `default` poserait une question à laquelle stdin, fermé, ne
    // répond jamais — c'est pourquoi la sauvegarde le refuse.
    permissionMode: a.permission_mode || 'acceptEdits',
    allowedTools: allowed.length ? allowed : OUTILS_DEFAUT[a.kind] || OUTILS_DEFAUT.explore,
    disallowedTools: jsonOu(a.disallowed_tools_json, []),
    maxTurns: a.max_turns,
    agents: jsonOu(a.subagents_json, {}),
    /* `--add-dir` n'a de sens qu'en CODAGE : le cwd est alors UN clone, et les dépôts en
       lecture seule sont ailleurs. En exploration le cwd est la racine des clones — tout est
       déjà visible, et les répéter ne ferait qu'allonger l'argv. */
    addDirs: a.kind === 'code' ? cheminsLecture(a) : [],
  };
}

/* L'en-tête fabriqué du prompt système (§9.6). Il s'AJOUTE à celui du CLI : le CLAUDE.md du
   dépôt, ses skills et ses conventions restent chargés. */
function systemPromptFor(task, agent) {
  const lignes = [
    t('agents.sys.header', { name: agent.name, lang: i18n.getLang() }),
  ];
  const cibles = db.prepare(`SELECT repo.project FROM task_target tt JOIN repo ON repo.id = tt.repo_id
    WHERE tt.task_id = ? ORDER BY repo.project`).all(task.id);
  if (cibles.length) {
    lignes.push(t('agents.sys.repos'));
    for (const c of cibles) lignes.push(`- ${c.project}`);
  }
  if (agent.system_prompt) lignes.push('', agent.system_prompt);
  if (agent.knowledge_prompt) {
    // eslint-disable-next-line global-require
    const idx = require('./agentknowledge').indexFor(agent);
    if (idx) lignes.push('', idx);
  }
  return lignes.join('\n');
}

/* ---------- La demande (§8.6) ---------- */

function composer(agent, { question, targets, kind, entrees }) {
  const cfg = getConfig();
  const morceaux = [];

  // 1. les skills cochés sur le profil.
  const ligne = skillscan.ligneSkills(jsonOu(agent.skills_json, []), {
    repos: (targets || []).map((x) => db.prepare('SELECT * FROM repo WHERE id = ?').get(x.repo_id)).filter(Boolean),
    cfg,
  });
  if (ligne) morceaux.push(ligne);

  // 2. le gabarit, avec ses substitutions. Sans `{question}`, le texte saisi est ajouté après :
  //    un gabarit qui oublie le marqueur ne doit pas faire disparaître la demande.
  const projets = (targets || []).map((x) => {
    const r = db.prepare('SELECT project FROM repo WHERE id = ?').get(x.repo_id);
    return `- ${r ? r.project : `#${x.repo_id}`}`;
  }).join('\n');
  const q = String(question || '').trim();
  const gabarit = String(agent.prompt_template || '');
  if (gabarit.trim()) {
    const rendu = gabarit
      .replace(/\{repos\}/g, projets)
      .replace(/\{today\}/g, new Date().toISOString().slice(0, 10))
      .replace(/\{question\}/g, q);
    morceaux.push(gabarit.includes('{question}') || !q ? rendu : `${rendu}\n\n${q}`);
  } else if (q) morceaux.push(q);

  // 3. les fichiers que Mergerie a écrits pour lui.
  const fichiers = (entrees || []).filter(Boolean);
  if (fichiers.length) {
    morceaux.push([t('agents.prompt.inputs'), ...fichiers.map((f) => `- \`${f.path}\` — ${f.role}`)].join('\n'));
    if (agent.knowledge_prompt) morceaux.push(t('agents.prompt.read-knowledge-first'));
  }

  // 4. les sous-agents dont il dispose, nommés.
  const sous = jsonOu(agent.subagents_json, {});
  const noms = Object.keys(sous);
  if (noms.length) {
    morceaux.push([t('agents.prompt.subagents'), ...noms.map((n) => `- \`${n}\` : ${sous[n].description || ''}`)].join('\n'));
  }

  // 5. les consignes permanentes des réglages, comme toute session.
  let prompt = avecConsignes(morceaux.join('\n\n'), cfg.ai_extra_instructions);

  // 6. les protocoles, dans l'ordre.
  if (agent.builtin_key === 'investigator') prompt += PROTO_REPO();
  if (agent.builtin_key === 'cartographer') prompt += PROTO_AGENT();
  if (agent.knowledge_prompt) prompt += PROTO_STALE();
  return { prompt, kind: kind || agent.kind };
}

/* Les textes de protocole. Écrits ici plutôt que dans le gabarit : ce sont des contrats de
   MACHINE, et un utilisateur qui affine son gabarit ne doit pas pouvoir les casser sans le
   savoir — le bouton « Corriger sur X » disparaîtrait sans un mot. */
const PROTO_REPO = () => `\n\n---\n${t('agents.proto.repo')}\n\n<<<REPO\n<projet> | <chemin> | <ligne>\nREPO>>>\n`;
const PROTO_AGENT = () => `\n\n---\n${t('agents.proto.agent')}\n\n<<<AGENT\nname: <nom>\nrepo: <projet> | <rôle>\npath: <projet> | <chemin>\nAGENT>>>\n`;
const PROTO_STALE = () => `\n\n---\n${t('agents.proto.stale')}\n\n<<<STALE\n<projet> | <chemin> | <ce qui ne colle plus>\nSTALE>>>\n`;

/* ---------- Matérialiser et lancer ---------- */

function ciblesDe(agent, { mode, repoIds }) {
  if (agent.scope_kind === 'all_repos') {
    return db.prepare('SELECT id FROM repo WHERE enabled = 1 ORDER BY project').all()
      .map((r) => ({ repo_id: r.id, branch: null, base_branch: null }));
  }
  /* `agent.repos` s'il est fourni sur l'objet : c'est ce qui permet de restreindre un run à
     un sous-ensemble SANS modifier le profil — un cartographe lancé sur trois dépôts ne doit
     pas devenir un cartographe à trois dépôts. */
  const perimetre = Array.isArray(agent.repos) ? agent.repos : repos(agent.id);
  const gardes = mode === 'code' && Array.isArray(repoIds) && repoIds.length
    ? perimetre.filter((r) => repoIds.map(Number).includes(r.repo_id))
    : perimetre;
  return gardes.map((r) => ({ repo_id: r.repo_id, branch: r.branch || null, base_branch: null }));
}

function materialize(agent, { mode = 'ask', question = '', repoIds = null } = {}) {
  const defauts = jsonOu(agent.defaults_json, {});
  const targets = ciblesDe(agent, { mode, repoIds });
  const kind = mode === 'code' ? 'code' : 'explore';
  const { prompt } = composer(agent, { question, targets, kind });
  return {
    kind,
    targets,
    prompt,
    label: agent.name,
    ask_questions: defauts.ask_questions ? 1 : 0,
    notify_jira: defauts.notify_jira ? 1 : 0,
    verifier_id: defauts.verifier_id || null,
    // RÈGLE 1 : un agent ne pousse jamais de lui-même. Aucun profil ne peut l'activer.
    auto_push: 0,
  };
}

function lancer(agent, { mode = 'ask', question = '', repoIds = null, triggeredBy = 'manual', agentIdSur = null } = {}) {
  // eslint-disable-next-line global-require
  const tasks = require('./tasks');
  // eslint-disable-next-line global-require
  const jobs = require('./jobs');
  const m = materialize(agent, { mode, question, repoIds });
  if (!m.targets.length) throw new Error(t('agents.err.no-repo'));
  const porteur = agentIdSur ? lire(agentIdSur) : agent;
  const taskId = tasks.creerTask({
    kind: m.kind,
    prompt: m.prompt,
    branch: m.targets[0].branch || '',
    commitMessage: null,
    autoPush: 0,
    askQuestions: m.ask_questions,
    verifierId: m.verifier_id,
    label: m.label,
    notifyJira: m.notify_jira,
    reviewAfter: 0,
    targets: m.targets,
    sessionId: null,
    /* La `task` porte l'agent AU NOM DUQUEL elle tourne. Pour une mise à jour de connaissance,
       c'est l'agent de domaine — pas le cartographe qui l'exécute : c'est sur SA carte que la
       mise à jour doit apparaître. */
    agentId: porteur.id,
    agentName: porteur.name,
    triggeredBy,
    // La demande TELLE QU'ELLE A ÉTÉ TAPÉE : c'est elle qui titre le rapport, nomme la carte
    // et devient le sujet d'un agent de domaine — jamais le prompt composé.
    agentQuestion: String(question || '').trim() || null,
  });
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  const job = jobs.startTaskJob(taskId, 'run');
  return { task, job };
}

/* ---------- Ce qu'on fait de la sortie ---------- */

async function apresRun(task, onLog = () => {}) {
  if (!task || !task.agent_id) return;
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
  if (!a) return;
  let texte = '';
  try { if (task.md_path && fs.existsSync(task.md_path)) texte = fs.readFileSync(task.md_path, 'utf8'); }
  catch { texte = ''; }

  if (a.output_kind === 'agent') {
    // eslint-disable-next-line global-require
    return require('./agentknowledge').ingest(task, a, texte, onLog);
  }
  /* UNE MISE À JOUR DE CONNAISSANCE porte l'agent de DOMAINE (c'est sur sa carte qu'elle doit
     apparaître), mais c'est le cartographe qui l'a exécutée — et lui seul émet `<<<AGENT>>>`.
     La présence de ce bloc sur un agent de domaine est donc le signal fiable : un agent de
     domaine, lui, n'émet jamais ce bloc (il n'a que `<<<STALE>>>`). */
  if (a.knowledge_prompt && protocol.extraire(texte, 'AGENT').block) {
    const carto = parCle('cartographer');
    // eslint-disable-next-line global-require
    if (carto) return require('./agentknowledge').ingest(task, carto, texte, onLog);
  }
  if (a.output_kind === 'note_page') return versPageDeNotes(a, task, texte, onLog);

  /* Sortie « rapport » : rien à ranger, sauf les ÉCARTS qu'un agent de domaine a constatés
     dans sa propre connaissance. Il ne la corrige pas lui-même — il la signale, et la
     correction reste un geste. */
  if (a.knowledge_prompt) {
    const { block } = protocol.extraire(texte, 'STALE');
    if (block) {
      // eslint-disable-next-line global-require
      const gaps = protocol.lignes(block).map((c) => ({ project: c[0] || '', path: c[1] || '', note: c[2] || '' }));
      if (gaps.length) require('./agentknowledge').addGaps(a, task, gaps);
      onLog(t('agents.log.gaps', { n: gaps.length, count: gaps.length }));
    }
  }
  return null;
}

/* Sortie « page de notes » : créée au premier run, MISE À JOUR ensuite. Jamais dupliquée —
   sinon la carte des services existerait en douze exemplaires au bout de trois mois, et
   aucun ne serait « la » page. Le run garde son propre md : la page en est une copie. */
function versPageDeNotes(agent, task, texte, onLog) {
  const contenu = `${t('agents.note.header', { name: agent.name, date: new Date().toLocaleString(i18n.currentLocale()) })}\n\n${protocol.nettoyer(texte)}`;
  const msgs = { titreVide: t('err.notes.title-required'), inconnue: t('err.notes.unknown') };
  const id = Number(agent.output_ref) || 0;
  const page = id && notes.lirePage ? notes.lirePage(id) : null;
  if (id && page) {
    notes.majPage(id, { content: contenu }, msgs);
    onLog(t('agents.log.note-updated', { title: page.title }));
    return { page_id: id };
  }
  const cree = notes.creerPage({ title: `${agent.name} — ${t('agents.note.title-suffix')}`, content: contenu }, msgs);
  db.prepare('UPDATE agent SET output_ref = ?, updated_at = ? WHERE id = ?')
    .run(String(cree.id), new Date().toISOString(), agent.id);
  onLog(t('agents.log.note-created', { title: cree.title }));
  return { page_id: cree.id };
}

/* Les fichiers d'entrée à écrire avant un run (appelé par les exécutants, qui savent où est
   la racine des clones). Rend la liste { path, role } que `composer` annonce à l'agent. */
function ecrireEntrees(task, root, cibles) {
  if (!task || !task.agent_id) return [];
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
  if (!a) return [];
  const out = [];
  /* `recent.md` dès que plusieurs dépôts sont en jeu : c'est là que « ce qui vient d'être
     mergé » a une valeur qu'aucun clone ne porte. */
  if (a.scope_kind === 'all_repos' || (cibles || []).length >= 2) {
    const p = agentinput.ecrireRecent(root, cibles);
    if (p) out.push({ path: p, role: t('agents.input.role-recent') });
  }
  if (a.knowledge_prompt) {
    // eslint-disable-next-line global-require
    const ak = require('./agentknowledge');
    /* UNE MISE À JOUR reçoit trois fichiers de plus : ce qu'on savait, ce qu'on a vu de faux,
       et les commits qui ont touché les chemins cités. « Regarde d'abord là » — c'est la
       différence entre vérifier une carte et la refaire. */
    const ctx = ak.prendreContexteRefresh(a.id);
    if (ctx) {
      const [prec, gaps, commits] = agentinput.ecrireRefresh(root, ctx);
      if (prec) out.push({ path: prec, role: t('agents.input.role-previous') });
      out.push({ path: gaps, role: t('agents.input.role-gaps') });
      out.push({ path: commits, role: t('agents.input.role-commits') });
    } else {
      const p = agentinput.ecrireKnowledge(root, ak.contenuActif(a));
      if (p) out.push({ path: p, role: t('agents.input.role-knowledge') });
    }
  }
  return out;
}

/* Le bloc « voici ce que je t'ai écrit », ajouté à la demande AU MOMENT du lancement : les
   fichiers d'entrée n'existent qu'une fois les clones à jour, ils ne peuvent donc pas être
   dans le prompt stocké. */
function blocEntrees(task, entrees) {
  if (!task || !task.agent_id || !entrees || !entrees.length) return '';
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id);
  if (!a) return '';
  const lignes = [t('agents.prompt.inputs'), ...entrees.map((f) => `- \`${f.path}\` — ${f.role}`)];
  if (a.knowledge_prompt) lignes.push(t('agents.prompt.read-knowledge-first'));
  return `\n\n${lignes.join('\n')}`;
}

// Aperçu de l'argv, pour l'éditeur : ce que le profil produira réellement.
function previewFor(agent, backend) {
  const allowed = jsonOu(agent.allowed_tools_json, []);
  return agentargs.previewFor(backend, {
    model: agent.model,
    appendSystemPrompt: agent.system_prompt ? t('agents.preview.system') : '',
    permissionMode: agent.permission_mode || 'acceptEdits',
    allowedTools: allowed.length ? allowed : OUTILS_DEFAUT[agent.kind] || OUTILS_DEFAUT.explore,
    disallowedTools: jsonOu(agent.disallowed_tools_json, []),
    maxTurns: agent.max_turns,
    agents: jsonOu(agent.subagents_json, {}),
  });
}

module.exports = {
  lister, lire, parCle, creer, modifier, supprimer, dupliquer, restaurer, seedBuiltins,
  valider, optionsFor, systemPromptFor, composer, materialize, lancer, apresRun,
  ecrireEntrees, blocEntrees, previewFor, repos, OUTILS_DEFAUT, jsonOu,
};
