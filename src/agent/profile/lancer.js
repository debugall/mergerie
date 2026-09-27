'use strict';
/* Lancer un agent : une `task` ordinaire, dans la file de jobs — et la mise à jour de la connaissance d’un agent de domaine, qui passe par le cartographe. Seul module du profil qui touche à `jobs/`.
   Extrait de agent/profile.js (réorganisation de src/ par couches) : les corps sont ceux d'origine, au mot près. */
const db = require('../../db');
const i18n = require('../../core/i18n');
const { t } = i18n;
const knowledge = require('../knowledge');
const tasks = require('../tasks');
const jobs = require('../../jobs');
const { exigerApprobation, lire, parCle, repos } = require('./modele');
const { materialize } = require('./prompt');

function lancer(agent, { mode = 'ask', question = '', repoIds = null, triggeredBy = 'manual', agentIdSur = null } = {}) {
  /* DES PERMISSIONS OU UN HORAIRE VENUS D'AILLEURS NE TOURNENT PAS AVANT D'AVOIR ÉTÉ VUS ICI.
     Une porte pour le lancement manuel, la planification et la mise à jour d'un agent de
     domaine — tous passent par ici. */
  exigerApprobation(agent);
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

/* METTRE À JOUR LA CONNAISSANCE d'un agent de domaine : c'est le cartographe qui tourne, au nom
   de l'agent (`agentIdSur`), après que `knowledge` a préparé le contexte de la mise à jour — ce
   qu'on savait, ce qu'on a vu de faux, les commits qui ont touché les chemins cités. Vivait dans
   knowledge.js, qui devait pour cela importer le profil qui l'importe : ici, le sens est unique. */
async function refreshKnowledge(agent, triggeredBy = 'manual') {
  const carto = parCle('cartographer');
  if (!carto) throw new Error(t('agents.err.no-cartographer'));
  await knowledge.preparerRefresh(agent);
  const repoIds = repos(agent.id).map((r) => r.repo_id);
  return lancer(carto, {
    mode: 'ask',
    question: agent.knowledge_prompt || agent.name,
    repoIds,
    triggeredBy,
    // La `task` porte l'agent de DOMAINE : c'est sur sa carte que la mise à jour doit apparaître.
    agentIdSur: agent.id,
  });
}

module.exports = {
  lancer, refreshKnowledge,
};
