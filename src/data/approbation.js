'use strict';
/* CE QUI EXÉCUTE DU CODE NE S'EXÉCUTE PAS SUR LA SEULE FOI D'UN FICHIER VENU D'AILLEURS.
 *
 * Le dépôt de données est la frontière de confiance d'une équipe : tout ce qu'on y pousse arrive
 * chez chacun. Pour un rapport, une note, une règle, c'est le but. Pour ce qui DÉCIDE D'EXÉCUTER
 * — les commandes d'un vérificateur, les permissions et l'horaire d'un agent, les réglages qui
 * font tourner les reviews toutes seules —, un seul push suffisait à lancer du code sur le poste
 * de chaque membre, sans que personne ne l'ait vu passer.
 *
 * On approuve donc PAR CLASSE DE RISQUE, jamais par document : seule la classe A (ce qui exécute
 * sans le jugement d'un agent) demande un geste, et une fois par CHANGEMENT — quelques fois par
 * mois. Une porte franchie dix fois par jour est cliquée sans lire et ne protège plus rien.
 *
 * LE MÉCANISME. Pour chaque objet de la classe A, on garde sur CE poste l'empreinte de ce qui a
 * été approuvé — les commandes, les permissions, pas le nom ni la description. Tant que l'objet
 * courant a la même empreinte, il tourne. Arrivé différent par la synchro, il attend : le
 * lancement le refuse, l'écran montre ce qui a changé, un clic l'approuve.
 *   — Ce que l'utilisateur crée ou modifie LUI-MÊME est approuvé au passage : il vient de l'écrire.
 *   — L'approbation vit dans `local_state` : elle ne voyage pas, par construction. Approuver
 *     chez soi n'approuve rien chez les autres.
 */
const db = require('../db');
const { etat } = require('./localstate');

const KIND = 'approbation';

/* CE QUE L'ÉCRAN A MONTRÉ. L'approbation porte sur l'état qu'on a VU : la synchro tourne toutes les
   trente secondes, et un clic qui approuverait l'état courant approuverait peut-être une version
   arrivée entre l'affichage et le clic, jamais montrée. L'écran renvoie donc cette signature, et
   la route refuse si l'objet a changé depuis. */
const signature = (empreinte) => (empreinte == null ? null
  : require('node:crypto').createHash('sha256').update(String(empreinte)).digest('hex').slice(0, 16));

/* ---------------------------------------------------------------- vérificateurs */

/* CE QUI DÉCIDE DE CE QUI S'EXÉCUTE, ET QUAND : les commandes et leur ordre, la base relancée,
   les déclenchements automatiques, le mode (worktree ou dans le dossier de l'utilisateur).
   Pas le nom, le délai, le gabarit du commentaire : les changer ne lance rien de nouveau. */
function empreinteVerificateur(id) {
  const v = db.prepare('SELECT * FROM verifier WHERE id = ?').get(Number(id));
  if (!v) return null;
  const commands = db.prepare('SELECT command FROM verifier_command WHERE verifier_id = ? ORDER BY position')
    .all(v.id).map((c) => c.command);
  const repos = db.prepare('SELECT repo_id, mode FROM verifier_repo WHERE verifier_id = ? ORDER BY repo_id')
    .all(v.id).map((r) => [r.repo_id, r.mode || 'worktree']);
  return JSON.stringify({
    kind: v.kind || 'commands', command: v.command || '', commands,
    run_base: v.run_base ? 1 : 0, auto_on_mr: v.auto_on_mr ? 1 : 0, auto_on_stale: v.auto_on_stale ? 1 : 0,
    repos,
  });
}
const refVerificateur = (id) => {
  const v = db.prepare('SELECT uid FROM verifier WHERE id = ?').get(Number(id));
  return v && v.uid ? `verifier:${v.uid}` : null;
};

function verificateurApprouve(id) {
  const ref = refVerificateur(id);
  if (!ref) return false;
  return etat.lire(KIND, ref, 'empreinte') === empreinteVerificateur(id);
}
function approuverVerificateur(id) {
  const ref = refVerificateur(id);
  if (ref) etat.ecrire(KIND, ref, 'empreinte', empreinteVerificateur(id));
}
/** Ce qui était approuvé (pour montrer le changement), ou `null` si rien ne l'a jamais été. */
function verificateurApprouveAvant(id) {
  const ref = refVerificateur(id);
  const brut = ref ? etat.lire(KIND, ref, 'empreinte') : null;
  try { return brut ? JSON.parse(brut) : null; } catch { return null; }
}

/* ---------------------------------------------------------------- agents */

/* LES PERMISSIONS ET L'HORAIRE, pas les consignes. Le rôle et le gabarit de prompt alimentent un
   agent — c'est la classe B, qu'on ne soumet à aucune porte : la réponse à une consigne
   détournée est de rendre l'agent peu dangereux, pas de faire cliquer à chaque retouche. */
function empreinteAgent(id) {
  const a = db.prepare('SELECT * FROM agent WHERE id = ?').get(Number(id));
  if (!a) return null;
  return JSON.stringify({
    kind: a.kind || '', model: a.model || '', permission_mode: a.permission_mode || '',
    allowed_tools: a.allowed_tools_json || '', disallowed_tools: a.disallowed_tools_json || '',
    max_turns: a.max_turns == null ? null : Number(a.max_turns),
    skills: a.skills_json || '', subagents: a.subagents_json || '',
    schedule: a.schedule || '', runner: a.runner || '',
  });
}
const refAgent = (id) => {
  const a = db.prepare('SELECT uid FROM agent WHERE id = ?').get(Number(id));
  return a && a.uid ? `agent:${a.uid}` : null;
};
function agentApprouve(id) {
  const ref = refAgent(id);
  if (!ref) return false;
  return etat.lire(KIND, ref, 'empreinte') === empreinteAgent(id);
}
function approuverAgent(id) {
  const ref = refAgent(id);
  if (ref) etat.ecrire(KIND, ref, 'empreinte', empreinteAgent(id));
}
function agentApprouveAvant(id) {
  const ref = refAgent(id);
  const brut = ref ? etat.lire(KIND, ref, 'empreinte') : null;
  try { return brut ? JSON.parse(brut) : null; } catch { return null; }
}

/* ---------------------------------------------------------------- réglages d'automatisme */

/* Les trois réglages d'équipe qui font TOURNER quelque chose tout seul : la review à l'arrivée,
   la re-review d'un rapport périmé, et qui les exécute. La publication automatique n'en est pas :
   elle poste un commentaire, elle ne lance rien. */
const CHAMPS_AUTO = ['auto_review_new', 'auto_rereview_stale', 'auto_runner'];
function empreinteConfig(cfg) {
  const c = cfg || {};
  const e = Object.fromEntries(CHAMPS_AUTO.map((k) => [k, String(c[k] == null ? '' : c[k])]));
  /* « Vérifier le code de TOUS les auteurs » élargit ce qui s'exécute tout seul : il en est. Posé
     seulement quand il quitte son défaut — l'ajouter toujours aurait changé l'empreinte de
     chaque poste à la mise à jour, et tout remis « à approuver » sans que rien n'ait changé. */
  if (c.verif_auto_authors === 'all') e.verif_auto_authors = 'all';
  return JSON.stringify(e);
}
const configApprouvee = (cfg) => etat.lire(KIND, 'config', 'empreinte') === empreinteConfig(cfg);
const approuverConfig = (cfg) => etat.ecrire(KIND, 'config', 'empreinte', empreinteConfig(cfg));
function configApprouveeAvant() {
  const brut = etat.lire(KIND, 'config', 'empreinte');
  try { return brut ? JSON.parse(brut) : null; } catch { return null; }
}

/* ---------------------------------------------------------------- le premier démarrage */

/* CE QUI ÉTAIT LÀ AVANT CETTE VERSION EST APPROUVÉ, une fois. Sans ça, la montée de version
   bloquerait d'un coup tous les vérificateurs et tous les agents de l'utilisateur, les siens
   compris — et il approuverait tout d'un clic sans lire, ce qui est exactement ce qu'on veut
   éviter. Ce qui arrive ENSUITE par la synchro, en revanche, attend. Sur un poste neuf la base
   est vide : il n'y a rien à reprendre, et ce qui arrivera de l'équipe attendra. */
function reprendreLExistant(getConfig) {
  if (etat.lire(KIND, 'migration', 'v1')) return 0;
  let n = 0;
  for (const v of db.prepare('SELECT id FROM verifier').all()) { approuverVerificateur(v.id); n += 1; }
  for (const a of db.prepare('SELECT id FROM agent').all()) { approuverAgent(a.id); n += 1; }
  approuverConfig(getConfig());
  etat.ecrire(KIND, 'migration', 'v1', new Date().toISOString());
  return n;
}

/** Combien d'objets attendent une approbation sur ce poste — pour le dire sans qu'on les cherche. */
function enAttente(getConfig) {
  const verificateurs = db.prepare('SELECT id FROM verifier').all().filter((v) => !verificateurApprouve(v.id)).length;
  const agents = db.prepare('SELECT id FROM agent').all().filter((a) => !agentApprouve(a.id)).length;
  const config = configApprouvee(getConfig()) ? 0 : 1;
  return { verificateurs, agents, config, total: verificateurs + agents + config };
}

module.exports = {
  signature,
  empreinteVerificateur, verificateurApprouve, approuverVerificateur, verificateurApprouveAvant,
  empreinteAgent, agentApprouve, approuverAgent, agentApprouveAvant,
  CHAMPS_AUTO, empreinteConfig, configApprouvee, approuverConfig, configApprouveeAvant,
  reprendreLExistant, enAttente,
};
