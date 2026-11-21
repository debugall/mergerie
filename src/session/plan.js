'use strict';
/* LE PLAN D'UN LOT DE TICKETS, CÔTÉ SESSION — enregistrer les entrées, composer le prompt, créer
 * l'exploration qui le produit, ranger ce que l'agent a rendu, garder ce qui a été publié.
 *
 * Comme une précision technique (`spec.js`), un plan est produit par une session d'EXPLORATION
 * ordinaire : lecture seule, plusieurs dépôts, file de jobs, journal, questions au développeur,
 * suivi, coût. Ce module compose la question, et relit la réponse pour en extraire les blocs
 * (`integrations/jiraplan.js`). Rien ici ne lance de job : la route s'en charge.
 *
 * LE PROMPT SE PRÉPARE, PUIS SE LANCE. Préparer lit Jira et Confluence et compose le texte ; on le
 * relit, on le retouche, et c'est CE texte qui part — tel quel. Une retouche n'est jamais écrasée
 * en silence : repréparer un prompt modifié à la main exige de le demander (`force`). */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { t } = require('../core/i18n');
const { DATA_DIR, TASKS_DIR, ensureDir } = require('../core/paths');
const { ulid } = require('../core/ulid');
const { getConfig } = require('../data/config');
const jiraplan = require('../integrations/jiraplan');
const confluence = require('../integrations/confluence');
const tasks = require('../agent/tasks');

const now = () => new Date().toISOString();
const jsonOu = (s, def) => { try { const v = JSON.parse(s); return v == null ? def : v; } catch { return def; } };
const lireMd = (p) => { try { return p ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };

const planById = (id) => db.prepare('SELECT * FROM jira_plan WHERE id = ?').get(Number(id)) || null;
const planDeTache = (taskId) => db.prepare('SELECT * FROM jira_plan WHERE task_id = ?').get(Number(taskId)) || null;
const versions = (planId) => db.prepare('SELECT * FROM jira_plan_version WHERE plan_id = ? ORDER BY version').all(Number(planId));
const versionCourante = (planId) => db.prepare('SELECT * FROM jira_plan_version WHERE plan_id = ? ORDER BY version DESC LIMIT 1').get(Number(planId)) || null;
const posts = (planId) => db.prepare('SELECT * FROM jira_plan_post WHERE plan_id = ?').all(Number(planId));

function erreur(cle, p = {}, { status = 400, code = null } = {}) {
  const e = new Error(t(cle, p));
  e.status = status;
  if (code) e.code = code;
  return e;
}

function poser(id, champs) {
  const cles = Object.keys(champs);
  if (!cles.length) return;
  db.prepare(`UPDATE jira_plan SET ${cles.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...champs, updated_at: now(), id: Number(id) });
}

/* LES ENTRÉES, validées. Les dépôts doivent exister et leurs branches être des noms de branche ;
   une page Confluence d'une autre origine que celle configurée est refusée ICI (les identifiants ne
   partent que vers le Jira ou le Confluence configurés) — sauf en démo, où rien n'est lu. */
function lireEntrees(e, { verifierOrigine = true } = {}) {
  const cles = jiraplan.normaliserCles(e.ticket_keys);
  if (cles.length > jiraplan.MAX_TICKETS) throw erreur('err.plan.too-many', { max: jiraplan.MAX_TICKETS });
  const repos = [...new Set((e.repo_ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of repos) if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(id)) throw erreur('err.depot-introuvable');
  const branches = {};
  for (const id of repos) {
    const b = String(((e.repo_branches || {})[id]) || '').trim();
    if (b) branches[id] = tasks.assertValidBranch(b);
  }
  const urls = [...new Set((e.confluence_urls || []).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, confluence.MAX_PAGES);
  const hors = verifierOrigine ? urls.filter((u) => !confluence.urlAdmise(getConfig(), u)) : [];
  if (hors.length) throw erreur('err.spec.page-host', { url: hors[0] });
  const epic = String(e.epic_key || '').trim().toUpperCase();
  return {
    label: String(e.label || '').trim().slice(0, 120) || (epic || cles[0] || t('jira.plan.untitled')),
    epic_key: jiraplan.CLE.test(epic) ? epic : null,
    ticket_keys_json: JSON.stringify(cles),
    confluence_json: JSON.stringify(urls),
    repo_ids_json: JSON.stringify(repos),
    branches_json: JSON.stringify(branches),
    complement: String(e.complement || '').trim().slice(0, 8000),
    include_comments: e.include_comments ? 1 : 0,
    ask_questions: e.ask_questions === false || e.ask_questions === 0 ? 0 : 1,
  };
}

function creer(entrees, opts) {
  const c = lireEntrees(entrees, opts);
  const d = now();
  const info = db.prepare(`INSERT INTO jira_plan (uid, label, epic_key, ticket_keys_json, confluence_json, repo_ids_json, branches_json,
      complement, include_comments, ask_questions, status, inputs_at, created_at, updated_at)
    VALUES (@uid, @label, @epic_key, @ticket_keys_json, @confluence_json, @repo_ids_json, @branches_json,
      @complement, @include_comments, @ask_questions, 'draft', @d, @d, @d)`).run({ ...c, uid: ulid(), d });
  return planById(info.lastInsertRowid);
}

/* Modifier les entrées. Un prompt NON retouché devient périmé et s'efface — il sera recomposé ; un
   prompt retouché reste, et l'écran dit qu'il ne reflète plus les entrées. */
function modifier(id, entrees, opts) {
  const p = planById(id);
  if (!p) throw erreur('err.plan.not-found', {}, { status: 404 });
  const c = lireEntrees(entrees, opts);
  const change = ['ticket_keys_json', 'confluence_json', 'repo_ids_json', 'branches_json', 'complement', 'include_comments', 'ask_questions', 'epic_key']
    .some((k) => String(c[k] == null ? '' : c[k]) !== String(p[k] == null ? '' : p[k]));
  poser(p.id, { ...c, ...(change ? { inputs_at: now() } : {}), ...(change && !p.prompt_edited ? { prompt: null, prompt_at: null } : {}) });
  return planById(p.id);
}

/* PRÉPARER : lire Jira et Confluence, composer le prompt. `force` : écraser une retouche. `lire`
   remplace la lecture (démo : les tickets du décor, aucune page). */
async function preparer(p, { cfg = getConfig(), force = false, lire = null } = {}) {
  if (p.prompt_edited && p.prompt && !force) throw erreur('err.plan.prompt-edited', {}, { status: 409, code: 'PLAN_PROMPT_EDITED' });
  const keys = jsonOu(p.ticket_keys_json, []);
  if (!keys.length) throw erreur('err.plan.no-ticket');
  if (!jsonOu(p.repo_ids_json, []).length) throw erreur('err.plan.no-repo');
  const urls = jsonOu(p.confluence_json, []);
  const ctx = lire
    ? await lire({ keys, confluenceUrls: urls, includeComments: !!p.include_comments })
    : await jiraplan.assembler(cfg, { keys, confluenceUrls: urls, includeComments: !!p.include_comments });
  if (!ctx.tickets.length) throw erreur('err.plan.no-ticket-read', { keys: keys.join(', ') });
  const nonce = jiraplan.nonceRun();
  const prompt = jiraplan.composerPrompt({ tickets: ctx.tickets, manquants: ctx.manquants, pages: ctx.pages, complement: p.complement, nonce });
  poser(p.id, {
    prompt, prompt_edited: 0, prompt_at: now(), nonce,
    tickets_json: JSON.stringify(ctx.tickets.map(jiraplan.photoTicket)),
    pages_json: JSON.stringify((ctx.pages || []).map(jiraplan.photoPage)),
    missing_json: JSON.stringify(ctx.manquants || []),
  });
  return planById(p.id);
}

function modifierPrompt(id, prompt) {
  const p = planById(id);
  if (!p) throw erreur('err.plan.not-found', {}, { status: 404 });
  const texte = String(prompt || '').trim();
  if (!texte) throw erreur('err.plan.prompt-empty');
  poser(p.id, { prompt: texte, prompt_edited: 1, prompt_at: now() });
  return planById(p.id);
}

const occupee = (p) => {
  const tache = p.task_id ? db.prepare('SELECT status FROM task WHERE id = ?').get(p.task_id) : null;
  return !!tache && ['running', 'needs_input'].includes(tache.status);
};

/* Les pièces du plan, RECOPIÉES dans la session : l'exploration les lit sur sa propre portée
   (`task`), et le plan garde les siennes pour la relance suivante. */
function copierPieces(planId, taskId) {
  const dir = ensureDir(path.join(TASKS_DIR, String(taskId)));
  const ins = db.prepare('INSERT INTO piece_jointe (scope, owner_id, path, name, mime, followup, created_at) VALUES (?,?,?,?,?,0,?)');
  let n = db.prepare("SELECT COUNT(*) c FROM piece_jointe WHERE scope = 'task' AND owner_id = ?").get(taskId).c;
  for (const pj of db.prepare("SELECT * FROM piece_jointe WHERE scope = 'plan' AND owner_id = ? ORDER BY id").all(planId)) {
    n += 1;
    const cible = path.join(dir, `pj_${n}${path.extname(pj.path)}`);
    try { fs.copyFileSync(pj.path, cible); } catch { continue; }
    ins.run('task', taskId, cible, pj.name, pj.mime, now());
  }
}

/* LANCER : une exploration neuve, avec LE prompt tel qu'il est (retouché ou non). Rend la tâche ;
   la route programme le job. */
function creerSession(p) {
  if (!p.prompt || !p.nonce) throw erreur('err.plan.not-prepared');
  if (occupee(p)) throw erreur('err.plan.busy');
  const repoIds = jsonOu(p.repo_ids_json, []);
  if (!repoIds.length) throw erreur('err.plan.no-repo');
  const branches = jsonOu(p.branches_json, {});
  const targets = tasks.normalizeTargets(repoIds.map((repo_id) => ({ repo_id, branch: branches[repo_id] || '' })), 'explore');
  const taskId = tasks.creerTask({
    kind: 'explore', prompt: p.prompt, targets, askQuestions: !!p.ask_questions,
    label: t('jira.plan.task-label', { label: p.label }).slice(0, 120),
  });
  copierPieces(p.id, taskId);
  poser(p.id, { task_id: taskId, status: 'running', last_error: null, pending_instruction: null });
  return db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
}

/** Le texte d'un suivi pour la session du plan ; la route lance le job. */
function instructionSuivi(p, instruction) {
  const v = versionCourante(p.id);
  if (!v) throw erreur('err.plan.no-result');
  if (!String(instruction || '').trim()) throw erreur('err.spec.instruction-required');
  if (!p.task_id || !db.prepare('SELECT 1 FROM task WHERE id = ?').get(p.task_id)) throw erreur('err.spec.no-session');
  if (occupee(p)) throw erreur('err.plan.busy');
  return jiraplan.composerSuivi({ markdown: lireMd(v.md_path), instruction, nonce: p.nonce });
}

/* RELIRE JIRA ET CONFLUENCE, sans tout recommencer : les tickets du plan relus (une recherche par
   tranche de cent, leurs commentaires si le plan les inclut) et ses pages Confluence (un appel
   chacune), comparés aux photos gardées. Rien n'a bougé : on le dit, sans appel à l'IA. Sinon, le texte d'un suivi pour la session du plan, qui
   rendra une nouvelle version. La photo est rafraîchie dans les deux cas ; le prompt de lancement,
   lui, ne reflète plus Jira — l'écran le dira périmé s'il a changé. `lire` : la démo. */
async function relireJira(p, { cfg = getConfig(), lire = null } = {}) {
  const v = versionCourante(p.id);
  if (!v) throw erreur('err.plan.no-result');
  if (occupee(p)) throw erreur('err.plan.busy');
  if (!lire && (!p.task_id || !db.prepare('SELECT 1 FROM task WHERE id = ?').get(p.task_id))) throw erreur('err.spec.no-session');
  const keys = jsonOu(p.ticket_keys_json, []);
  const urls = jsonOu(p.confluence_json, []);
  const ctx = lire
    ? await lire({ keys, confluenceUrls: urls, includeComments: !!p.include_comments })
    : await jiraplan.assembler(cfg, { keys, confluenceUrls: urls, includeComments: !!p.include_comments });
  if (!ctx.tickets.length) throw erreur('err.plan.no-ticket-read', { keys: keys.join(', ') });
  const photos = ctx.tickets.map(jiraplan.photoTicket);
  const pages = (ctx.pages || []).map(jiraplan.photoPage);
  const changements = [
    ...jiraplan.changementsJira(jsonOu(p.tickets_json, []), photos, ctx.manquants || []),
    ...jiraplan.changementsConfluence(jsonOu(p.pages_json, []), pages),
  ];
  poser(p.id, {
    tickets_json: JSON.stringify(photos), missing_json: JSON.stringify(ctx.manquants || []),
    // En démo, rien n'est lu dans Confluence : la photo des pages reste celle de la préparation.
    ...(lire ? {} : { pages_json: JSON.stringify(pages) }),
    ...(changements.length ? { inputs_at: now() } : {}),
  });
  if (!changements.length) return { changements, plan: planById(p.id) };
  return {
    changements,
    plan: planById(p.id),
    resume: jiraplan.texteChangements(changements),
    texte: jiraplan.composerRelecture({ markdown: lireMd(v.md_path), changements, tickets: ctx.tickets, pages: ctx.pages || [], nonce: p.nonce }),
  };
}

const clesDuPlan = (p) => [...new Set([...jsonOu(p.ticket_keys_json, []), ...jsonOu(p.tickets_json, []).map((x) => x.key)])];
/** Ce que l'ordre peut citer : un ticket déjà terminé à la préparation n'y a pas sa place. */
const clesAOrdonner = (p) => jiraplan.clesAOrdonner(jsonOu(p.tickets_json, []), clesDuPlan(p));

/* Range une version : le document Markdown sur disque, le résultat structuré en base. */
function ajouterVersion(p, resultat, origin, instruction = null) {
  const derniere = versionCourante(p.id);
  const version = derniere ? derniere.version + 1 : 1;
  const md = jiraplan.markdownDe({ label: p.label, resultat, tickets: jsonOu(p.tickets_json, []), date: now().slice(0, 10) });
  const dossier = ensureDir(path.join(DATA_DIR, 'plans', p.uid));
  const mdPath = path.join(dossier, `v${version}-${Date.now()}.md`);
  fs.writeFileSync(mdPath, md, 'utf8');
  db.prepare(`INSERT INTO jira_plan_version (plan_id, version, origin, md_path, result_json, instruction, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, version, origin, mdPath, JSON.stringify(resultat), instruction ? String(instruction).slice(0, 2000) : null, now());
  return versionCourante(p.id);
}

/* APRÈS LA SESSION, quel que soit son état : en attente de réponses, en erreur, ou finie — et alors
   on relit le Markdown BRUT pour en extraire les blocs. Pas d'ordre exploitable : le plan est en
   erreur, mais le texte reste lisible dans la session. */
function apresRun(task, onLog = () => {}) {
  const p = planDeTache(task.id);
  if (!p) return null;
  if (task.status === 'needs_input' || task.status === 'planned') { poser(p.id, { status: 'needs_input' }); return p; }
  if (task.status === 'running' || task.status === 'new') return p;
  if (task.status !== 'done') { poser(p.id, { status: 'error', last_error: String(task.last_error || task.status).slice(0, 500) }); return p; }
  const resultat = jiraplan.extraire(lireMd(task.md_path), p.nonce, clesAOrdonner(p));
  if (!resultat) {
    poser(p.id, { status: 'error', last_error: t('jira.plan.no-block'), pending_instruction: null });
    onLog(t('jira.plan.log.no-block', { label: p.label }));
    return planById(p.id);
  }
  const avait = versionCourante(p.id);
  ajouterVersion(p, resultat, avait ? (p.pending_origin || 'followup') : 'ai', avait ? p.pending_instruction : null);
  poser(p.id, { status: 'done', last_error: null, pending_instruction: null, pending_origin: null });
  onLog(t('jira.plan.log.done', { label: p.label }));
  return planById(p.id);
}

function marquerErreur(taskId, message) {
  const p = planDeTache(taskId);
  if (p) poser(p.id, { status: 'error', last_error: String(message || '').slice(0, 500) });
}

/* LE TEXTE À PUBLIER pour un ticket : la ligne repère, puis le complément de la version courante. */
function texteAPublier(p, key, marker) {
  const v = versionCourante(p.id);
  if (!v) throw erreur('err.plan.no-result');
  const md = (jsonOu(v.result_json, {}).complements || {})[key];
  if (!md) throw erreur('err.plan.no-complement', { key });
  return { version: v.version, text: jiraplan.corpsCommentaire({ marker, label: p.label, uid: p.uid, version: v.version, markdown: md }) };
}
function postDe(planId, key) {
  return db.prepare('SELECT * FROM jira_plan_post WHERE plan_id = ? AND ticket_key = ?').get(Number(planId), key) || null;
}
function noterPost(planId, key, { commentId, version, text }) {
  db.prepare(`INSERT INTO jira_plan_post (plan_id, ticket_key, comment_id, posted_version, posted_text, posted_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(plan_id, ticket_key) DO UPDATE SET comment_id = excluded.comment_id, posted_version = excluded.posted_version,
      posted_text = excluded.posted_text, posted_at = excluded.posted_at`)
    .run(Number(planId), key, commentId || null, version, text, now());
}

function supprimer(id) {
  const p = planById(id);
  if (!p) throw erreur('err.plan.not-found', {}, { status: 404 });
  for (const v of versions(p.id)) { try { fs.rmSync(v.md_path, { force: true }); } catch { /* déjà parti */ } }
  require('../agent/pieces').removeOwner('plan', p.id);
  db.prepare('DELETE FROM jira_plan_post WHERE plan_id = ?').run(p.id);
  db.prepare('DELETE FROM jira_plan_version WHERE plan_id = ?').run(p.id);
  db.prepare('DELETE FROM jira_plan WHERE id = ?').run(p.id);
}

/* LES QUESTIONS EN ATTENTE de la session : une exploration les pose sur chaque cible, on rend la
   première — y répondre répond pour toute la session. */
function questionsEnAttente(taskId) {
  if (!taskId) return null;
  const tg = db.prepare("SELECT id, questions_json FROM task_target WHERE task_id = ? AND status = 'needs_input' AND questions_json IS NOT NULL ORDER BY id LIMIT 1").get(taskId);
  if (!tg) return null;
  const qs = jsonOu(tg.questions_json, null);
  return Array.isArray(qs) && qs.length ? { task_id: taskId, target_id: tg.id, questions: qs } : null;
}

/** Ce que l'écran montre d'un plan : les entrées, le prompt, l'état, le résultat courant, les versions, les publications. */
function vue(p, { complet = true } = {}) {
  if (!p) return null;
  const vs = versions(p.id);
  const courante = vs.length ? vs[vs.length - 1] : null;
  const tache = p.task_id ? db.prepare('SELECT id, status, last_error FROM task WHERE id = ?').get(p.task_id) : null;
  const cles = jsonOu(p.ticket_keys_json, []);
  const base = {
    id: p.id, uid: p.uid, label: p.label, epic_key: p.epic_key, ticket_keys: cles,
    /* Répondu aux questions, la session repart : le plan TOURNE de nouveau, même si son état ne
       sera réécrit qu'à la fin de la passe (`apresRun`). */
    status: p.status === 'needs_input' && tache && tache.status === 'running' ? 'running' : p.status,
    last_error: p.last_error || null, task_id: p.task_id, task_status: tache ? tache.status : null,
    version: courante ? courante.version : 0, created_at: p.created_at, updated_at: p.updated_at,
  };
  if (!complet) return base;
  const resultat = courante ? jsonOu(courante.result_json, null) : null;
  const publies = {};
  for (const x of posts(p.id)) {
    const md = resultat && resultat.complements ? resultat.complements[x.ticket_key] : null;
    const actuel = md ? jiraplan.corpsCommentaire({ marker: '', label: p.label, uid: p.uid, version: x.posted_version, markdown: md }) : null;
    publies[x.ticket_key] = {
      comment_id: x.comment_id, posted_version: x.posted_version, posted_at: x.posted_at,
      // Le complément a-t-il changé depuis ce qui est parti ? On compare les corps, pas la ligne repère.
      changed: !!(md && x.posted_text && !String(x.posted_text).trim().endsWith(String(md).trim())),
      outdated: !!(courante && x.posted_version != null && courante.version > x.posted_version && actuel !== null),
    };
  }
  const nbPages = jsonOu(p.confluence_json, []).length;
  return {
    ...base,
    confluence_urls: jsonOu(p.confluence_json, []),
    repo_ids: jsonOu(p.repo_ids_json, []),
    repo_branches: jsonOu(p.branches_json, {}),
    complement: p.complement || '',
    include_comments: !!p.include_comments,
    ask_questions: !!p.ask_questions,
    prompt: p.prompt || '',
    prompt_edited: !!p.prompt_edited,
    prompt_at: p.prompt_at,
    prompt_stale: !!(p.prompt && p.inputs_at && p.prompt_at && p.inputs_at > p.prompt_at),
    budget: jiraplan.budget({ nTickets: cles.length, nPages: nbPages, includeComments: !!p.include_comments }),
    tickets: jsonOu(p.tickets_json, []),
    pages: jsonOu(p.pages_json, []),
    missing: jsonOu(p.missing_json, []),
    questions: p.status === 'needs_input' ? questionsEnAttente(p.task_id) : null,
    result: resultat,
    markdown: courante ? lireMd(courante.md_path) : '',
    versions: vs.map((v) => ({ version: v.version, origin: v.origin, instruction: v.instruction, created_at: v.created_at })),
    posts: publies,
  };
}

/** Une version passée, pour la relire. */
function vueVersion(p, n) {
  const v = db.prepare('SELECT * FROM jira_plan_version WHERE plan_id = ? AND version = ?').get(p.id, Number(n));
  if (!v) throw erreur('err.plan.no-result', {}, { status: 404 });
  return { version: v.version, origin: v.origin, instruction: v.instruction, created_at: v.created_at, result: jsonOu(v.result_json, null), markdown: lireMd(v.md_path) };
}

const lister = () => db.prepare('SELECT * FROM jira_plan ORDER BY updated_at DESC').all().map((p) => vue(p, { complet: false }));

module.exports = {
  planById, planDeTache, versions, versionCourante, poser, creer, modifier, preparer, modifierPrompt, creerSession, instructionSuivi, relireJira,
  ajouterVersion, apresRun, marquerErreur, texteAPublier, postDe, noterPost, supprimer, vue, vueVersion, lister, lireMd, clesAOrdonner,
};
