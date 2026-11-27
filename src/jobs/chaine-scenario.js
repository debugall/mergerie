'use strict';
/* LE SCÉNARIO DE COUVERTURE DE LA CHAÎNE DE VALIDATION (`chaine-verif.js`, étape 3).

   Toute la chaîne est verte sur la branche : la SESSION QUI A ÉCRIT LE CODE est reprise, le dépôt de tests
   monté en lecture seule à côté, pour dire si son code est DÉJÀ couvert par un scénario existant — et lequel,
   pourquoi —, ou pour en écrire un, dans les conventions du dépôt de tests, en suivant le skill de scénarios
   choisi (un `SKILL.md` du dépôt de tests, recopié) ou, sans skill, une consigne intégrée. Elle ne touche pas
   au dépôt de tests : elle REND les fichiers dans des blocs `<<<SCENARIO>>>`, et c'est Mergerie qui les écrit
   sur une branche du même nom que la sienne, dans le dépôt de tests, commite et pousse.

   Puis le vérificateur des scénarios tourne, le dépôt de tests sur cette branche et la session sur la sienne,
   avec `MERGERIE_SCENARIO` = les chemins écrits : ses commandes lancent ce scénario seul (vide, elles lancent
   tout). Deux essais, comme un côté de la chaîne. Vert : la tâche est VALIDÉE. Rouge deux fois : la session
   est reprise pour corriger — le scénario (de nouveaux blocs) ou son code (un commit, et la chaîne rejoue
   alors la branche de chacun avant le scénario) —, au plus MAX_CORRECTIONS fois, puis « À toi ». */
const fs = require('node:fs');
const os = require('node:os');
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

const MAX_CORRECTIONS = 2;
const MAX_FICHIERS = 10;
const MAX_OCTETS = 200 * 1024;
const lire = (j, defaut) => { try { return JSON.parse(j); } catch { return defaut; } };
const nonceScen = (taskId) => protocolesecret.hmac(`chaine-scen-${taskId}`, 12);

/* La configuration : `{ verifier_id, skill: { name, repo_id } | null }` — un vérificateur connu ; le skill,
   un nom sûr (il finit dans un chemin) d'un dépôt connu. */
function normaliserScenario(valeur) {
  const v = typeof valeur === 'string' ? lire(valeur, null) : valeur;
  if (!v || typeof v !== 'object') return null;
  const verifierId = Number(v.verifier_id) || 0;
  if (!verifierId || !db.prepare('SELECT 1 FROM verifier WHERE id = ?').get(verifierId)) return null;
  let skill = null;
  const s = v.skill;
  if (s && /^[\w.-]{1,100}$/.test(String(s.name || '')) && db.prepare('SELECT 1 FROM repo WHERE id = ?').get(Number(s.repo_id) || 0)) {
    skill = { name: String(s.name), repo_id: Number(s.repo_id) };
  }
  return JSON.stringify({ verifier_id: verifierId, skill });
}

/* Le dépôt de tests : celui des réglages (Réglages → Vérificateurs, commun à tous les vérificateurs), que le
   vérificateur des scénarios doit couvrir hors des dépôts de la session. Sans réglage, déduit — le seul dépôt
   qu'il couvre hors de la session ; plusieurs, on ne choisit pas au hasard. Rend `{ repo }` ou `{ erreur }`. */
function depotTests(verifierId, projets, couvertureVerifier) {
  const couverts = couvertureVerifier(verifierId);
  const nomVerif = (db.prepare('SELECT name FROM verifier WHERE id = ?').get(verifierId) || {}).name || `#${verifierId}`;
  const ref = String(getConfig().test_repo || '').trim();
  if (ref) {
    const i = ref.indexOf('/');
    const repo = i > 0 ? db.prepare("SELECT * FROM repo WHERE COALESCE(forge, 'gitlab') = ? AND project = ?").get(ref.slice(0, i), ref.slice(i + 1)) : null;
    if (!repo) return { erreur: t('task.chaine.scen.test-repo-unknown', { repo: ref }) };
    if (projets.some((p) => p.repo_id === repo.id)) return { erreur: t('task.chaine.scen.test-repo-in-session', { repo: repo.project }) };
    if (!couverts.has(repo.id)) return { erreur: t('task.chaine.scen.test-repo-not-covered', { name: nomVerif, repo: repo.project }) };
    return { repo };
  }
  const candidats = [...couverts.keys()].filter((id) => !projets.some((p) => p.repo_id === id))
    .map((id) => db.prepare('SELECT * FROM repo WHERE id = ?').get(id)).filter(Boolean);
  if (!candidats.length) return { erreur: t('task.chaine.scen.no-test-repo') };
  if (candidats.length > 1) return { erreur: t('task.chaine.scen.test-repo-ambiguous', { name: nomVerif, repos: candidats.map((r) => r.project).join(', ') }) };
  return { repo: candidats[0] };
}

/* Un chemin rendu par l'agent : relatif, dans le dépôt de tests, hors de `.git`. Tout le reste est refusé —
   c'est Mergerie qui écrit, pas l'agent. */
function cheminSur(brut) {
  const c = String(brut || '').trim().replace(/^\.\/+/, '');
  if (!c || c.length > 300 || path.isAbsolute(c) || /[\0\n]/.test(c)) return null;
  const n = path.posix.normalize(c);
  if (n.startsWith('..') || n.split('/').some((x) => x === '..' || x === '.git')) return null;
  return n;
}

function texteSkill(skill) {
  if (!skill) return null;
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(skill.repo_id);
  if (!repo) return null;
  try {
    const f = path.join(git.cloneDirFor(getConfig(), repo), '.claude', 'skills', skill.name, 'SKILL.md');
    return { project: repo.project, corps: skillscan.lireFrontmatter(fs.readFileSync(f, 'utf8')).corps.trim() };
  } catch { return null; }
}

function blocsAttendus(nonce) {
  return [
    t('task.chaine.scen.blocks'),
    '',
    `<<<COUVERT ${nonce}`,
    `par: ${t('task.chaine.scen.by-ph')}`,
    `raison: ${t('task.chaine.scen.why-ph')}`,
    `COUVERT ${nonce}>>>`,
    '',
    `<<<SCENARIO ${nonce}`,
    `chemin: ${t('task.chaine.scen.path-ph')}`,
    '---',
    t('task.chaine.scen.content-ph'),
    `SCENARIO ${nonce}>>>`,
  ].join('\n');
}

function consigneEcrire(task, cfg, tests) {
  const skill = texteSkill(cfg.skill);
  return [
    t('task.chaine.scen.subject'),
    '',
    t('task.chaine.scen.intro', { tests: tests.project }),
    '',
    skill ? `${t('task.chaine.scen.with-skill', { project: skill.project })}\n\n${skill.corps}` : t('task.chaine.scen.without-skill', { tests: tests.project }),
    '',
    t('task.chaine.scen.rules'),
    '',
    blocsAttendus(nonceScen(task.id)),
  ].join('\n');
}

function consigneCorriger(task, scen, verificationId) {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(verificationId) || {};
  const run = lire(v.head_run_json, {}) || {};
  const tests = (run.failed || []).slice(0, 20).map((f) => `- ${f.test || '?'}${f.message ? `\n  ${f.message}` : ''}`).join('\n');
  return [
    t('task.chaine.scen.fix-subject'),
    '',
    t('task.chaine.scen.fix-intro', { files: (scen.fichiers || []).join(', ') }),
    '',
    nonFiable(t('task.chaine.diag.data-tests'), tests),
    nonFiable(t('task.chaine.diag.data-log'), String(v.log_excerpt || '').slice(-6000)),
    '',
    t('task.chaine.scen.fix-rules'),
    '',
    blocsAttendus(nonceScen(task.id)),
  ].filter((x) => x !== null).join('\n');
}

/* La session reçoit la consigne en suivi : le dépôt de tests est un projet lié (lecture seule). */
function lancerAgent(task, scen, { cfg, tests, quoi, verificationId, sig }) {
  if (!db.prepare('SELECT 1 FROM task_context_repo WHERE task_id = ? AND repo_id = ?').get(task.id, tests.id)) {
    db.prepare('INSERT INTO task_context_repo (task_id, repo_id, branch) VALUES (?, ?, NULL)').run(task.id, tests.id);
  }
  const cibles = db.prepare('SELECT id FROM task_target WHERE task_id = ? AND commit_sha IS NOT NULL').all(task.id).map((x) => x.id);
  const instruction = quoi === 'ecrire' ? consigneEcrire(task, cfg, tests) : consigneCorriger(task, scen, verificationId);
  const at = new Date().toISOString();
  startTaskJob(task.id, 'followup', { instruction, targetIds: cibles });
  return {
    ...scen,
    corrections: (scen.corrections || 0) + (quoi === 'corriger' ? 1 : 0),
    en_cours: { quoi, at, sig },
    erreur: null,
  };
}

const enRoute = (taskId) => !!jobEnCoursPour(taskId);

/* Les blocs de la dernière passe qui en porte, depuis le lancement. */
function blocsRendus(taskId, depuis) {
  const nonce = nonceScen(taskId);
  const passes = db.prepare(`SELECT output_path FROM agent_pass WHERE scope = 'task' AND task_id = ? AND created_at >= ?
    ORDER BY created_at DESC, id DESC`).all(taskId, depuis);
  for (const p of passes) {
    let texte = '';
    try { texte = p.output_path ? fs.readFileSync(p.output_path, 'utf8') : ''; } catch { texte = ''; }
    const couvert = protocol.extraire(texte, 'COUVERT', nonce).block;
    const scenarios = protocol.extraireTous(texte, 'SCENARIO', nonce).blocks;
    if (couvert || scenarios.length) return { couvert, scenarios };
  }
  return { couvert: null, scenarios: [] };
}
const champ = (bloc, nom) => ((String(bloc).match(new RegExp(`^\\s*${nom}\\s*:\\s*(.+)$`, 'mi')) || [])[1] || '').trim();
function fichiersDe(blocs) {
  const out = [];
  for (const b of blocs.slice(0, MAX_FICHIERS)) {
    const i = b.indexOf('\n---');
    if (i < 0) continue;
    const chemin = cheminSur(champ(b.slice(0, i), 'chemin'));
    const contenu = b.slice(b.indexOf('\n', i + 1) + 1).replace(/\s+$/, '') + '\n';
    if (chemin && contenu.length <= MAX_OCTETS && !out.some((f) => f.chemin === chemin)) out.push({ chemin, contenu });
  }
  return out;
}

/* Écrire les fichiers sur la branche du dépôt de tests, dans un worktree jetable du clone de Mergerie, puis
   commit et push. Appelé depuis la fin de la passe de la session : son job tient la clé du dépôt de tests
   (un projet lié), personne d'autre ne touche à ce clone pendant ce temps. */
async function ecrireDansDepot(tests, branche, fichiers, message, onLog) {
  const cfg = getConfig();
  const clone = await git.ensureRepo(cfg, tests, onLog);
  const depart = (await git.refExists(clone, `origin/${branche}`)) ? `origin/${branche}` : 'origin/HEAD';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-scenario-'));
  try {
    await git.run('git', ['worktree', 'add', '-B', branche, dir, depart], { cwd: clone });
    for (const f of fichiers) {
      const cible = path.join(dir, f.chemin);
      fs.mkdirSync(path.dirname(cible), { recursive: true });
      fs.writeFileSync(cible, f.contenu, 'utf8');
    }
    await git.commitAll(dir, message, onLog);
    await git.pushBranch(dir, branche, onLog, git.secretsOf(cfg));
    return await git.headSha(dir);
  } finally {
    try { await git.run('git', ['worktree', 'remove', '--force', dir], { cwd: clone }); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}

/* Ce que la session a rendu. `ecrire` : écrit et poussé (dans le job de la session) ; sans `ecrire` (la
   session n'a pas fini normalement), aucune écriture : une erreur, à relancer. */
async function conclure(task, scen, { tests, ecrire = true, onLog = () => {} }) {
  const { couvert, scenarios } = blocsRendus(task.id, scen.en_cours.at);
  const base = { ...scen, en_cours: null };
  if (couvert && !scenarios.length) {
    return { ...base, couvert: { par: champ(couvert, 'par').slice(0, 300), raison: champ(couvert, 'raison').slice(0, 1000) } };
  }
  const fichiers = fichiersDe(scenarios);
  if (!fichiers.length) {
    // Une correction peut ne porter que sur le code : elle a commité, la chaîne rejouera tout.
    if (scen.en_cours.quoi === 'corriger' && scen.fichiers) return base;
    return { ...base, erreur: t('task.chaine.scen.none') };
  }
  if (!ecrire || !tests) return { ...base, erreur: t('task.chaine.scen.interrupted') };
  const branche = (db.prepare('SELECT branch FROM task_target WHERE task_id = ? AND branch IS NOT NULL ORDER BY id LIMIT 1').get(task.id) || {}).branch;
  try {
    const sha = await ecrireDansDepot(tests, branche, fichiers, t('task.chaine.scen.commit', { id: task.id }), onLog);
    onLog(t('log.chaine.scenario-written', { n: fichiers.length, count: fichiers.length, project: tests.project, branch: branche }));
    return { ...base, couvert: null, fichiers: fichiers.map((f) => f.chemin), branche, sha, depuis: (scen.runs || []).length };
  } catch (e) {
    return { ...base, erreur: t('task.chaine.scen.write-failed', { message: String(e.message).split('\n')[0] }) };
  }
}

module.exports = { MAX_CORRECTIONS, normaliserScenario, depotTests, lancerAgent, enRoute, conclure, nonceScen, cheminSur };
