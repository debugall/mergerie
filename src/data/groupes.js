'use strict';
/* LES GROUPES DE DÉPÔTS — ce que le reste du code demande d'eux (ameliorations_proposal.md, §4.5).
 *
 * Un groupe est une unité de CONFIGURATION (règles, vérificateurs, gabarits, consignes) et une
 * unité d'ACTION (une session, une action Git, un lot sur « ces vingt-là »). Deux questions
 * suffisent au reste du code : « quels dépôts ? » et « quel réglage vaut pour ce dépôt ? ».
 *
 * RÉSOLUTION : global → groupe(s) → dépôt. Un dépôt peut être dans plusieurs groupes ; le
 * premier groupe (par id, l'ordre de création) qui porte une valeur non vide gagne, et la fiche
 * du dépôt dit d'où vient chaque valeur. Aucun réglage par dépôt n'existe encore : « dépôt »
 * est le dernier cran, réservé. */
const db = require('../db');

const CHAMPS_HERITES = ['prompt_review', 'prompt_modify', 'prompt_fix', 'ai_extra_instructions'];

function lister() {
  const groupes = db.prepare('SELECT * FROM repo_group ORDER BY name').all();
  const membres = db.prepare(`SELECT m.group_id, r.id AS repo_id, r.project, r.forge FROM repo_group_member m
    JOIN repo r ON r.id = m.repo_id ORDER BY r.project`).all();
  const par = new Map();
  for (const m of membres) (par.get(m.group_id) || par.set(m.group_id, []).get(m.group_id)).push(m);
  return groupes.map((g) => ({ ...g, repos: par.get(g.id) || [] }));
}
const parId = (id) => db.prepare('SELECT * FROM repo_group WHERE id = ?').get(Number(id));

/** Les identifiants des dépôts d'un groupe. */
function membres(groupId) {
  return db.prepare('SELECT repo_id FROM repo_group_member WHERE group_id = ? ORDER BY repo_id').all(Number(groupId)).map((r) => r.repo_id);
}
/** Les groupes d'un dépôt, dans l'ordre de résolution (le plus ancien d'abord). */
function groupesDuDepot(repoId) {
  return db.prepare(`SELECT g.* FROM repo_group g JOIN repo_group_member m ON m.group_id = g.id
    WHERE m.repo_id = ? ORDER BY g.id`).all(Number(repoId));
}
/** Un dépôt appartient-il à ce groupe ? */
const appartient = (repoId, groupId) => !!db.prepare('SELECT 1 FROM repo_group_member WHERE group_id = ? AND repo_id = ?').get(Number(groupId), Number(repoId));

/** La configuration EFFECTIVE pour un dépôt : `cfg` avec, par-dessus, ce que ses groupes portent
 *  de non vide — champ par champ, premier groupe gagnant. `origines` dit d'où vient chaque champ. */
function configPourDepot(cfg, repoId) {
  const out = { ...cfg };
  const origines = {};
  if (!repoId) return { config: out, origines };
  for (const g of groupesDuDepot(repoId)) {
    for (const champ of CHAMPS_HERITES) {
      if (origines[champ]) continue;
      const v = String(g[champ] == null ? '' : g[champ]).trim();
      if (v) { out[champ] = v; origines[champ] = { group_id: g.id, name: g.name }; }
    }
  }
  return { config: out, origines };
}
/** Les consignes permanentes pour un dépôt (celles du groupe, sinon les globales). */
const consignesPour = (cfg, repoId) => configPourDepot(cfg, repoId).config.ai_extra_instructions;

/** La couverture EFFECTIVE d'un vérificateur : ses dépôts directs (avec leur mode) plus tous les
 *  dépôts de ses groupes, en worktree. Une ligne directe l'emporte sur le groupe (elle peut dire
 *  « in place »). Rend une Map repo_id → { repo_id, mode, workdir, checkout_allowed, via }. */
function couvertureVerifier(verifierId) {
  const out = new Map();
  for (const l of db.prepare('SELECT * FROM verifier_repo WHERE verifier_id = ?').all(Number(verifierId))) {
    out.set(l.repo_id, { ...l, via: 'direct' });
  }
  for (const g of db.prepare('SELECT group_id FROM verifier_group WHERE verifier_id = ?').all(Number(verifierId))) {
    for (const repoId of membres(g.group_id)) {
      if (!out.has(repoId)) out.set(repoId, { verifier_id: Number(verifierId), repo_id: repoId, mode: 'worktree', workdir: null, checkout_allowed: 0, via: 'group', group_id: g.group_id });
    }
  }
  return out;
}
const couvre = (verifierId, repoId) => couvertureVerifier(verifierId).has(Number(repoId));

/** Une règle de review vaut-elle pour ce dépôt ? Sans limite : partout. Limitée à un dépôt OU à
 *  un groupe : si l'un des deux matche. */
function regleVautPour(regle, repoId) {
  const parDepot = regle.repo_id ? Number(regle.repo_id) === Number(repoId) : null;
  const parGroupe = regle.group_id ? appartient(repoId, regle.group_id) : null;
  if (parDepot === null && parGroupe === null) return true;
  return !!(parDepot || parGroupe);
}

module.exports = {
  CHAMPS_HERITES, lister, parId, membres, groupesDuDepot, appartient, configPourDepot, consignesPour,
  couvertureVerifier, couvre, regleVautPour,
};
