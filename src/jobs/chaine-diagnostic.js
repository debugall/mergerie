'use strict';
/* LE DIAGNOSTIC D'UNE BRANCHE QUI CASSE UN VÉRIFICATEUR DE LA CHAÎNE (`chaine-verif.js`, étape 2).

   Rouge deux fois sur la branche, un vérificateur ne s'arrête plus tout de suite sur « À toi » : la
   SESSION QUI A ÉCRIT LE CODE est reprise — elle sait ce qu'elle a fait et pourquoi —, avec le dépôt de
   tests monté en lecture seule à côté (un projet lié de la session), l'échec et son journal. Elle suit
   le skill choisi pour la chaîne (`task.verify_chain_skill`, un `SKILL.md` du dépôt de tests, dont le
   texte est recopié dans la consigne : l'agent ne charge pas forcément les skills d'un dossier ajouté),
   ou, sans skill, une consigne intégrée qui lui fait lire directement le dépôt de tests. Elle rend un
   bloc `<<<DIAGNOSTIC>>>` : la cause (`branche` | `base` | `environnement` | `instable`) et sa preuve.

   — `branche` : elle a corrigé, commité, poussé ; la signature de la branche change, la chaîne rejoue
     la branche de chaque vérificateur (`chaine-verif.js`).
   — autre chose, ou pas de bloc : elle ne touche à rien, et la chaîne s'arrête sur « À toi » avec le
     diagnostic à lire sur la carte.
   Au plus MAX_DIAG tours par vérificateur : au-delà, c'est à l'utilisateur. */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const git = require('../git/git');
const skillscan = require('../agent/skillscan');
const protocol = require('../agent/protocol');
const protocolesecret = require('../core/protocolesecret');
const { nonFiable } = require('../core/nonfiable');
const { getConfig } = require('../data/config');
const { t } = require('../core/i18n');
const { startTaskJob, jobEnCoursPour } = require('./ordonnanceur');

const MAX_DIAG = 2;
const CAUSES = ['branche', 'base', 'environnement', 'instable'];
const lire = (j, defaut) => { try { return JSON.parse(j); } catch { return defaut; } };

/* Le nonce du bloc : stable pour une session (la consigne peut être relue d'une passe à l'autre),
   dérivé par HMAC — une donnée lue par l'agent ne peut pas fabriquer le bloc de CE run. */
const nonceDiag = (taskId) => protocolesecret.hmac(`chaine-diag-${taskId}`, 12);

/* Le skill choisi : `{ name, repo_id }`, un nom de skill sûr (il finit dans un chemin) et un dépôt connu. */
function normaliserSkill(valeur) {
  const v = typeof valeur === 'string' ? lire(valeur, null) : valeur;
  if (!v || typeof v !== 'object') return null;
  const name = String(v.name || '').trim();
  const repoId = Number(v.repo_id) || 0;
  if (!/^[\w.-]{1,100}$/.test(name) || !repoId || !db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) return null;
  return JSON.stringify({ name, repo_id: repoId });
}

/* Un tour de plus est permis : sous le plafond, et pas déjà fait sur CES commits (une cause « base »
   ou « environnement » ne change pas en redemandant). */
function peutDiagnostiquer(step, sig) {
  const d = step.diag || {};
  if (d.en_cours) return false;
  if ((d.rounds || 0) >= MAX_DIAG) return false;
  return !(d.dernier && d.dernier.sig === sig);
}

/* Le texte du skill, sans son en-tête : lu dans le clone du dépôt de tests. */
function texteSkill(skill) {
  if (!skill) return null;
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(skill.repo_id);
  if (!repo) return null;
  try {
    const f = path.join(git.cloneDirFor(getConfig(), repo), '.claude', 'skills', skill.name, 'SKILL.md');
    return { project: repo.project, corps: skillscan.lireFrontmatter(fs.readFileSync(f, 'utf8')).corps.trim() };
  } catch { return null; }
}

/* Ce qui a échoué : les tests nommés par le vérificateur et la fin de son journal — des DONNÉES (un
   journal peut contenir n'importe quoi), balisées comme telles. */
function echecDe(verificationId) {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(verificationId);
  if (!v) return '';
  const run = lire(v.head_run_json, {}) || {};
  const tests = (run.failed || []).slice(0, 20).map((f) => [`- ${f.test || '?'}`, f.message ? `  ${f.message}` : '',
    f.log_excerpt ? `  ${String(f.log_excerpt).split('\n').slice(0, 12).join('\n  ')}` : ''].filter(Boolean).join('\n'));
  return [
    nonFiable(t('task.chaine.diag.data-tests'), tests.join('\n')),
    nonFiable(t('task.chaine.diag.data-log'), String(v.log_excerpt || '').slice(-6000)),
  ].filter(Boolean).join('\n\n');
}

function consigne(task, step, verificationId, depotsTests) {
  const nonce = nonceDiag(task.id);
  const skill = texteSkill(lire(task.verify_chain_skill, null));
  const tests = depotsTests.map((r) => r.project).join(', ') || '—';
  const methode = skill
    ? t('task.chaine.diag.with-skill', { project: skill.project }) + `\n\n${skill.corps}`
    : t('task.chaine.diag.without-skill', { tests });
  return [
    // Première ligne : elle devient le sujet du commit si la session corrige.
    t('task.chaine.diag.subject', { name: step.verifier_name }),
    '',
    t('task.chaine.diag.intro', { name: step.verifier_name, tests }),
    '',
    methode,
    '',
    echecDe(verificationId) || t('task.chaine.diag.no-detail'),
    '',
    t('task.chaine.diag.steps'),
    '',
    t('task.chaine.diag.block', { nonce }),
    `<<<DIAGNOSTIC ${nonce}`,
    'cause: branche | base | environnement | instable',
    `preuve: ${t('task.chaine.diag.proof-ph')}`,
    `DIAGNOSTIC ${nonce}>>>`,
  ].join('\n');
}

/* Lancer le diagnostic d'une étape : le dépôt de tests (les dépôts du vérificateur hors de la session)
   devient un projet lié en lecture seule, puis la session reçoit la consigne en suivi, sur ses projets
   qui ont du code. Rend le `diag` à écrire sur l'étape. */
function lancer(task, step, verificationId, sig, { couverts, projets }) {
  const depotsTests = [...couverts.keys()].filter((id) => !projets.some((p) => p.repo_id === id))
    .map((id) => db.prepare('SELECT id, project FROM repo WHERE id = ?').get(id)).filter(Boolean);
  for (const r of depotsTests) {
    if (!db.prepare('SELECT 1 FROM task_context_repo WHERE task_id = ? AND repo_id = ?').get(task.id, r.id)) {
      db.prepare('INSERT INTO task_context_repo (task_id, repo_id, branch) VALUES (?, ?, NULL)').run(task.id, r.id);
    }
  }
  const cibles = db.prepare('SELECT id FROM task_target WHERE task_id = ? AND commit_sha IS NOT NULL').all(task.id).map((x) => x.id);
  const at = new Date().toISOString();
  // Un vérificateur qui ne couvre que les dépôts de la session : ses scénarios sont là, on les nomme.
  const nommes = depotsTests.length ? depotsTests
    : [...couverts.keys()].map((id) => db.prepare('SELECT id, project FROM repo WHERE id = ?').get(id)).filter(Boolean);
  startTaskJob(task.id, 'followup', { instruction: consigne(task, step, verificationId, nommes), targetIds: cibles });
  const d = step.diag || {};
  return { ...d, rounds: (d.rounds || 0) + 1, en_cours: { sig, at, verification_id: verificationId } };
}

/* Le diagnostic est-il encore en route ? La session tourne ou attend son tour. */
const enRoute = (taskId) => !!jobEnCoursPour(taskId);

/* Ce que la session a rendu : le bloc de la DERNIÈRE passe de chacun de ses projets, depuis le
   lancement du diagnostic. Pas de bloc (session en erreur, agent qui a oublié) : cause inconnue. */
function conclure(taskId, diag) {
  const nonce = nonceDiag(taskId);
  const passes = db.prepare(`SELECT output_path FROM agent_pass WHERE scope = 'task' AND task_id = ? AND created_at >= ?
    ORDER BY created_at DESC, id DESC`).all(taskId, diag.en_cours.at);
  for (const p of passes) {
    let texte = '';
    try { texte = p.output_path ? fs.readFileSync(p.output_path, 'utf8') : ''; } catch { texte = ''; }
    const { block } = protocol.extraire(texte, 'DIAGNOSTIC', nonce);
    if (!block) continue;
    const champ = (nom) => ((block.match(new RegExp(`^\\s*${nom}\\s*:\\s*(.+)$`, 'mi')) || [])[1] || '').trim();
    const brut = champ('cause').toLowerCase();
    const cause = CAUSES.find((c) => brut.startsWith(c)) || 'inconnu';
    return { cause, preuve: champ('preuve').slice(0, 1000), sig: diag.en_cours.sig, at: new Date().toISOString() };
  }
  return { cause: 'inconnu', preuve: '', sig: diag.en_cours.sig, at: new Date().toISOString() };
}

module.exports = { MAX_DIAG, normaliserSkill, peutDiagnostiquer, lancer, enRoute, conclure, nonceDiag };
