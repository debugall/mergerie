'use strict';
/* LA SPEC D'UN TICKET, CÔTÉ SESSION — créer la ligne, lancer l'exploration qui la produit,
 * ranger ce que l'agent a rendu.
 *
 * Une spec est produite par une session d'EXPLORATION ordinaire (`task.kind = 'explore'`,
 * lecture seule, un ou plusieurs dépôts) : elle hérite tel quel des questions au développeur,
 * du suivi, des pièces jointes, du coût et du journal. Ce module ne fait que composer la
 * question posée à cette session, et relire sa réponse pour en extraire le bloc `<<<SPEC>>>`.
 * Rien ici ne lance un job : c'est la route qui programme la session, comme pour toute autre.
 *
 * Les versions s'empilent comme celles d'une review (IA, suivi, édition à la main), chacune
 * dans son fichier sous `specs/<clé>/` ; la ligne `ticket_spec` ne porte que l'état. */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { t } = require('../core/i18n');
const { DATA_DIR, ensureDir } = require('../core/paths');
const { getConfig } = require('../data/config');
const jiraspec = require('../integrations/jiraspec');
const tasks = require('../agent/tasks');

const STATUTS = ['new', 'running', 'needs_input', 'proposed', 'edited', 'posted', 'stale', 'error'];
const now = () => new Date().toISOString();

const specById = (id) => db.prepare('SELECT * FROM ticket_spec WHERE id = ?').get(Number(id)) || null;
const specByKey = (key) => db.prepare('SELECT * FROM ticket_spec WHERE ticket_key = ?').get(jiraspec.normaliserCle(key)) || null;
const specDeTache = (taskId) => db.prepare('SELECT * FROM ticket_spec WHERE task_id = ?').get(Number(taskId)) || null;
const versions = (specId) => db.prepare('SELECT * FROM ticket_spec_version WHERE spec_id = ? ORDER BY version').all(Number(specId));
const versionCourante = (specId) => db.prepare('SELECT * FROM ticket_spec_version WHERE spec_id = ? ORDER BY version DESC LIMIT 1').get(Number(specId)) || null;

const lireMd = (p) => { try { return p ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };
const jsonOu = (s, def) => { try { const v = JSON.parse(s); return v == null ? def : v; } catch { return def; } };

function poser(id, champs) {
  const cles = Object.keys(champs);
  if (!cles.length) return;
  db.prepare(`UPDATE ticket_spec SET ${cles.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...champs, updated_at: now(), id: Number(id) });
}

/* Crée la spec d'un ticket, ou REPREND celle qui existe : une seule par ticket, c'est l'identité.
   Les choix (dépôts, pages, complément, détail) sont réécrits ; l'id du commentaire posté et
   les versions restent — c'est ce qui fait qu'une relance met à jour le même commentaire. */
function creerOuReprendre({ ticketKey, repoIds, complement, confluenceUrls, detail, includeEpic, askQuestions, epicKey, batchId }) {
  const cle = jiraspec.normaliserCle(ticketKey);
  if (!jiraspec.cleValide(cle)) throw new Error(t('err.jira.invalid-key'));
  const repos = [...new Set((repoIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!repos.length) throw new Error(t('err.spec.repo-required'));
  for (const id of repos) if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(id)) throw new Error(t('err.depot-introuvable'));
  const urls = [...new Set((confluenceUrls || []).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 5);
  const champs = {
    repo_ids_json: JSON.stringify(repos),
    complement: String(complement || '').trim().slice(0, 4000),
    confluence_json: JSON.stringify(urls.map((url) => ({ url }))),
    detail: detail === 'detaille' ? 'detaille' : 'synthese',
    include_epic: includeEpic === false || includeEpic === 0 || includeEpic === '0' ? 0 : 1,
    ask_questions: askQuestions === false || askQuestions === 0 || askQuestions === '0' ? 0 : 1,
    epic_key: epicKey ? jiraspec.normaliserCle(epicKey) : null,
    batch_id: batchId || null,
  };
  const existante = specByKey(cle);
  if (existante) { poser(existante.id, champs); return specById(existante.id); }
  const info = db.prepare(`INSERT INTO ticket_spec (ticket_key, epic_key, batch_id, repo_ids_json, complement, confluence_json, detail,
      include_epic, ask_questions, status, created_at, updated_at)
    VALUES (@ticket_key, @epic_key, @batch_id, @repo_ids_json, @complement, @confluence_json, @detail, @include_epic, @ask_questions, 'new', @now, @now)`)
    .run({ ...champs, ticket_key: cle, now: now() });
  return specById(info.lastInsertRowid);
}

/* Prépare la session d'exploration d'une spec : lit le contexte (Jira, Confluence), compose la
   question, crée la tâche. Rend la tâche ; la route la programme. Le contexte est relu à chaque
   lancement — rien de Jira ni de Confluence n'est gardé entre deux analyses. */
async function preparerAnalyse(spec, { cfg = getConfig() } = {}) {
  const urls = jsonOu(spec.confluence_json, []).map((p) => (typeof p === 'string' ? p : p && p.url)).filter(Boolean);
  const ctx = await jiraspec.assembler(cfg, { ticketKey: spec.ticket_key, includeEpic: !!spec.include_epic, confluenceUrls: urls });
  const nonce = jiraspec.nonceRun();
  const question = jiraspec.composerQuestion({
    ticket: ctx.ticket, epic: ctx.epic, enfants: ctx.enfants, epicErreur: ctx.epicErreur, pages: ctx.pages,
    complement: spec.complement, detail: spec.detail, nonce, consignesEquipe: cfg.spec_team_instructions,
  });
  const repoIds = jsonOu(spec.repo_ids_json, []);
  const targets = tasks.normalizeTargets(repoIds.map((repo_id) => ({ repo_id })), 'explore');
  const taskId = tasks.creerTask({
    kind: 'explore', prompt: question, targets, askQuestions: !!spec.ask_questions,
    label: t('jira.spec.task-label', { key: spec.ticket_key, title: String(ctx.ticket.summary || '').slice(0, 80) }),
  });
  /* La photo du ticket et des pages : ce qui sera comparé plus tard pour dire « à revoir », et
     ce que l'écran affiche (titre, taille, erreur de lecture) sans relire Confluence. */
  poser(spec.id, {
    task_id: taskId, nonce, status: 'running', last_error: null,
    epic_key: ctx.epic && ctx.epic.key ? ctx.epic.key : spec.epic_key,
    ticket_snapshot: jiraspec.snapshotDe(ctx.ticket),
    confluence_json: JSON.stringify(ctx.pages.map((p) => ({ url: p.url, title: p.title, chars: p.chars, truncated: p.truncated, fetched_at: p.fetched_at, error: p.error }))),
  });
  return { task: db.prepare('SELECT * FROM task WHERE id = ?').get(taskId), spec: specById(spec.id), ticket: ctx.ticket };
}

/** Le texte d'un suivi, pour la session d'exploration de la spec. */
function instructionSuivi(spec, instruction) {
  const v = versionCourante(spec.id);
  return jiraspec.composerSuivi({
    ticketKey: spec.ticket_key, version: v ? v.version : 0, markdown: v ? lireMd(v.md_path) : '',
    instruction, nonce: spec.nonce,
  });
}

/* Range une nouvelle version : le fichier d'abord, la ligne ensuite. `origin` dit d'où elle
   vient — l'IA, un suivi, une édition à la main — et `instruction` ce qu'on avait demandé. */
function ajouterVersion(spec, markdown, origin, instruction = null) {
  const derniere = versionCourante(spec.id);
  const version = derniere ? derniere.version + 1 : 1;
  const dossier = ensureDir(path.join(DATA_DIR, 'specs', spec.ticket_key.replace(/[^A-Z0-9-]/g, '_')));
  const mdPath = path.join(dossier, `v${version}-${Date.now()}.md`);
  fs.writeFileSync(mdPath, String(markdown || '').trim() + '\n', 'utf8');
  db.prepare(`INSERT INTO ticket_spec_version (spec_id, ticket_key, version, origin, md_path, instruction, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(spec.id, spec.ticket_key, version, origin, mdPath, instruction ? String(instruction).slice(0, 2000) : null, now());
  return versionCourante(spec.id);
}

/* APRÈS LA SESSION. Appelé par le runner pour toute tâche qui porte une spec, quel que soit
   l'état final : en attente de réponses, en erreur, ou finie — et alors on relit le Markdown
   BRUT (le bloc est un canal de service, l'API nettoyée ne le rend pas) pour en extraire la
   proposition. Pas de bloc : la spec est en erreur, mais le texte reste lisible dans Dev IA. */
function apresRun(task, onLog = () => {}) {
  const spec = specDeTache(task.id);
  if (!spec) return null;
  if (task.status === 'needs_input' || task.status === 'planned') { poser(spec.id, { status: 'needs_input' }); return spec; }
  if (task.status === 'running' || task.status === 'new') return spec;
  if (task.status !== 'done') { poser(spec.id, { status: 'error', last_error: String(task.last_error || task.status).slice(0, 500) }); return spec; }
  const brut = lireMd(task.md_path);
  const md = jiraspec.extraireSpec(brut, spec.nonce);
  if (!md) {
    poser(spec.id, { status: 'error', last_error: t('jira.spec.no-block') });
    onLog(t('jira.spec.log.no-block', { key: spec.ticket_key }));
    return specById(spec.id);
  }
  const avait = versionCourante(spec.id);
  ajouterVersion(spec, md, avait ? 'followup' : 'ai', null);
  poser(spec.id, { status: 'proposed', last_error: null });
  onLog(t('jira.spec.log.proposed', { key: spec.ticket_key }));
  return specById(spec.id);
}

/** La session a échoué avant même de finir : la spec le dit. */
function marquerErreur(taskId, message) {
  const spec = specDeTache(taskId);
  if (spec) poser(spec.id, { status: 'error', last_error: String(message || '').slice(0, 500) });
}

/** Vue complète pour l'écran : la ligne, ses versions, le texte courant. */
function vue(spec) {
  if (!spec) return null;
  const vs = versions(spec.id);
  const courante = vs.length ? vs[vs.length - 1] : null;
  const tache = spec.task_id ? db.prepare('SELECT id, status, last_error, md_path FROM task WHERE id = ?').get(spec.task_id) : null;
  return {
    id: spec.id, uid: spec.uid, ticket_key: spec.ticket_key, epic_key: spec.epic_key, batch_id: spec.batch_id,
    task_id: spec.task_id, task_status: tache ? tache.status : null,
    repo_ids: jsonOu(spec.repo_ids_json, []),
    complement: spec.complement || '',
    confluence: jsonOu(spec.confluence_json, []),
    detail: spec.detail || 'synthese',
    include_epic: !!spec.include_epic,
    ask_questions: !!spec.ask_questions,
    status: spec.status, last_error: spec.last_error || null,
    comment_id: spec.comment_id || null, posted_version: spec.posted_version,
    unposted: !!(courante && (spec.posted_version == null || courante.version > spec.posted_version)),
    version: courante ? courante.version : 0,
    markdown: courante ? lireMd(courante.md_path) : '',
    versions: vs.map((v) => ({ id: v.id, version: v.version, origin: v.origin, instruction: v.instruction, created_at: v.created_at })),
    created_at: spec.created_at, updated_at: spec.updated_at,
  };
}

module.exports = {
  STATUTS, specById, specByKey, specDeTache, versions, versionCourante, poser, creerOuReprendre, preparerAnalyse,
  instructionSuivi, ajouterVersion, apresRun, marquerErreur, vue, lireMd,
};
