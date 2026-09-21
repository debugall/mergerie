'use strict';
/* D’un profil à un lancement : les options du CLI (`optionsFor`), le prompt système, la demande composée avec la connaissance de l’agent, les cibles, et la matérialisation d’un run.
   Extrait de agent/profile.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../db');
const agentargs = require('../args');
const skillscan = require('../skillscan');
const git = require('../../git/git');
const { getConfig } = require('../../data/config');
const { avecConsignes } = require('../../core/prompts');
const i18n = require('../../core/i18n');
const { t } = i18n;
const knowledge = require('../knowledge');
const { OUTILS_DEFAUT, jsonOu, repos } = require('./modele');

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
  if (!task) return {};
  /* A18 — LE BROUILLON D'UN ESSAI vaut profil, le temps d'une session. Même fonction, même
     argv : un second chemin d'options finirait par ne plus essayer ce qu'on croit essayer. */
  const a = task.agent_id
    ? db.prepare('SELECT * FROM agent WHERE id = ?').get(task.agent_id)
    : (task.agent_draft_json ? { ...jsonOu(task.agent_draft_json, {}), id: null } : null);
  if (!a || (!task.agent_id && !task.agent_draft_json)) return {};
  const allowed = jsonOu(a.allowed_tools_json, []);
  return {
    model: a.model,
    appendSystemPrompt: systemPromptFor(task, a),
    /* Vide = `acceptEdits`, SEULEMENT POUR UN PROFIL DE CODAGE (plan_secure.md, lot A, S3) :
       un profil d'EXPLORATION ne pose jamais de mode ici — la branche lecture de
       `agentpolicy` s'applique toujours, quoi que porte ce champ. */
    permissionMode: a.kind === 'code' ? (a.permission_mode || 'acceptEdits') : (a.permission_mode || undefined),
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
    const idx = knowledge.indexFor(agent);
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
  if (agent.output_kind === 'note_page') prompt += PROTO_PAGES();
  return { prompt, kind: kind || agent.kind };
}
/* Les textes de protocole. Écrits ici plutôt que dans le gabarit : ce sont des contrats de
   MACHINE, et un utilisateur qui affine son gabarit ne doit pas pouvoir les casser sans le
   savoir — le bouton « Corriger sur X » disparaîtrait sans un mot. */
const PROTO_REPO = () => `\n\n---\n${t('agents.proto.repo')}\n\n<<<REPO\n<projet> | <chemin> | <ligne>\nREPO>>>\n`;
const PROTO_AGENT = () => `\n\n---\n${t('agents.proto.agent')}\n\n<<<AGENT\nname: <nom>\nrepo: <projet> | <rôle>\npath: <projet> | <chemin>\nAGENT>>>\n`;
const PROTO_STALE = () => `\n\n---\n${t('agents.proto.stale')}\n\n<<<STALE\n<projet> | <chemin> | <ce qui ne colle plus>\nSTALE>>>\n`;
/* La sortie « page de notes » peut se DÉCOUPER. Le texte hors bloc devient la page racine,
   chaque bloc une sous-page. Combien et comment, c'est l'agent qui en juge : lui seul sait
   si son sujet a trois points ou douze. */
const PROTO_PAGES = () => `\n\n---\n${t('agents.proto.pages')}\n\n<<<PAGE\ntitle: <titre de la sous-page>\n<son contenu en Markdown>\nPAGE>>>\n`;
/* ---------- Matérialiser et lancer ---------- */

function ciblesDe(agent, { repoIds }) {
  /* LES DÉPÔTS REÇUS RESTREIGNENT, TOUJOURS — quel que soit le périmètre du profil et quel
     que soit le mode. Ils ne l'élargissent jamais : ce qui n'est pas dans le périmètre, ou
     qui n'est plus actif, ne devient pas une cible parce qu'un appelant l'a nommé.
     La restriction ne valait qu'en mode « coder », et sautait complètement pour un profil
     « tous les dépôts ». Une mise à jour de connaissance est justement les deux à la fois :
     elle est exécutée par le CARTOGRAPHE (tous les dépôts, en lecture) pour un agent de
     domaine qui n'en couvre qu'un. Cocher un seul dépôt tenait donc pour la cartographie, et
     se perdait à chaque mise à jour — vingt dépôts clonés, lus et payés pour un sujet qui
     n'en concerne qu'un. */
  const vises = Array.isArray(repoIds) && repoIds.length ? repoIds.map(Number) : null;
  if (agent.scope_kind === 'all_repos') {
    return db.prepare('SELECT id FROM repo WHERE enabled = 1 ORDER BY project').all()
      .filter((r) => !vises || vises.includes(r.id))
      .map((r) => ({ repo_id: r.id, branch: null, base_branch: null }));
  }
  /* `agent.repos` s'il est fourni sur l'objet : c'est ce qui permet de restreindre un run à
     un sous-ensemble SANS modifier le profil — un cartographe lancé sur trois dépôts ne doit
     pas devenir un cartographe à trois dépôts. */
  const perimetre = Array.isArray(agent.repos) ? agent.repos : repos(agent.id);
  const gardes = vises ? perimetre.filter((r) => vises.includes(r.repo_id)) : perimetre;
  return gardes.map((r) => ({ repo_id: r.repo_id, branch: r.branch || null, base_branch: null }));
}
function materialize(agent, { mode = 'ask', question = '', repoIds = null } = {}) {
  const defauts = jsonOu(agent.defaults_json, {});
  const targets = ciblesDe(agent, { repoIds });
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
  cheminsLecture, optionsFor, systemPromptFor, composer, PROTO_REPO, PROTO_AGENT, PROTO_STALE, PROTO_PAGES, ciblesDe, materialize, previewFor,
};
