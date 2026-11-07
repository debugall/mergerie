'use strict';
/* REPRENDRE LA SESSION D'UN COLLÈGUE SUR CE POSTE.
 *
 * Sur la carte d'une session de codage partagée par un collègue, un geste — « Reprendre sur ce
 * poste » — crée une session à moi, sur mon clone et mon abonnement, qui repart de la branche
 * telle qu'elle est sur la forge et dont l'agent reçoit, comme premier message, TOUT L'HISTORIQUE
 * de la session d'origine, tel quel, suivi de ma consigne.
 *
 * Règle produit : L'AGENT REÇOIT L'HISTOIRE, PAS UN RÉSUMÉ. Le premier message est assemblé
 * mécaniquement (`assembler`, fonction pure, sans IA) à partir de ce que le dépôt de données porte
 * déjà — prompt, passes avec leur prompt réellement envoyé et leur retour, questions et réponses,
 * dernier rapport de review et dernière vérification liés à la branche — dans l'ordre, et il est
 * visible en entier avant le lancement. Rien ne touche la session d'origine ; aucun handle d'agent
 * n'est réutilisé (il n'existe que sur l'autre machine, et ne voyage pas). */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const git = require('../git/git');
const forge = require('../forge');
const agentpass = require('../agent/pass');
const tasks = require('../agent/tasks');
const { TASKS_DIR, ensureDir } = require('../core/paths');

const MAX_LIGNES_DIFF = 20000;
const SEUIL_TOKENS = 150000;
const estimerTokens = (texte) => Math.ceil(String(texte || '').length / 4);

const GENRES = {
  run: 'exécution', followup: 'suivi', answer: 'réponse', 'converge-fix': 'correction de convergence',
  plan: 'plan', 'plan-revise': 'plan révisé', 'plan-approve': 'approbation du plan',
};
const court = (sha) => (sha ? String(sha).slice(0, 7) : '?');
const jour = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : null);
const ilYA = (iso, now) => {
  const t0 = Date.parse(iso);
  if (!Number.isFinite(t0)) return '';
  const j = Math.max(0, Math.floor((now - t0) / 86400000));
  return j === 0 ? 'aujourd’hui' : `il y a ${j} j`;
};
const bloc = (titre, corps) => `=== ${titre} ===\n${String(corps == null ? '' : corps).trim() || '(vide)'}\n`;

/* Un diff au-delà de 20 000 lignes n'entre pas tel quel : les fichiers, pas les lignes, et on le dit. */
function borneDiff(diff) {
  const lignes = String(diff || '').split('\n');
  if (lignes.length <= MAX_LIGNES_DIFF) return { texte: String(diff || ''), tronque: false, lignes: lignes.length };
  const fichiers = [];
  for (const m of String(diff).matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) fichiers.push(m[2] !== '/dev/null' ? m[2] : m[1]);
  return {
    texte: `Diff de ${lignes.length} lignes, au-delà de ${MAX_LIGNES_DIFF} : seuls les fichiers sont listés, les lignes sont omises.\n${fichiers.map((f) => `- ${f}`).join('\n')}`,
    tronque: true, lignes: lignes.length, fichiers,
  };
}

/* LE PREMIER MESSAGE, assemblé mécaniquement. Déterministe pour des données égales (dates en jours,
   jamais en minutes) : l'encart de la modale et la première passe montrent le même texte.
   `passes` : `[{ n, kind, prompt, output }]` dans l'ordre ; `passesIncluses` : les N dernières,
   null = toutes. `questions` : `[{ question, context, answer }]`. `review` : `{ iid, version, note, texte }`.
   `verification` : `{ iid, verdict, texte }`. `diff` : le diff de la branche reprise, ou null. */
function assembler(d, { now = Date.now() } = {}) {
  const {
    auteur, origineId, project, branch, dernierCommit, dernierePasse, teteForge, ecart, running, derniereSynchro,
    prompt, passes = [], questions = [], review = null, verification = null, diff = null, reponse = null, consigne = '', passesIncluses = null,
  } = d;
  const out = [];
  out.push(`Reprise de la session de ${auteur || 'un collègue'} (#${origineId}) — ${project}, branche ${branch}.`);
  const passeTxt = dernierePasse ? ` (passe ${dernierePasse.n}, ${ilYA(dernierePasse.at, now)}${jour(dernierePasse.at) ? ` — ${jour(dernierePasse.at)}` : ''})` : '';
  out.push(`Dernier commit connu par la session : ${dernierCommit ? court(dernierCommit) : 'aucun'}${passeTxt}. Tête sur la forge : ${teteForge ? court(teteForge) : 'inconnue'}.`);
  if (ecart) out.push(`La forge est ${ecart} commit${ecart > 1 ? 's' : ''} plus loin que la dernière passe connue.`);
  if (running) out.push(`La session d'origine était marquée en cours à la dernière synchronisation${derniereSynchro ? ` (${ilYA(derniereSynchro, now)})` : ''}.`);
  const gardees = passesIncluses != null && passesIncluses >= 0 && passesIncluses < passes.length ? passes.slice(passes.length - passesIncluses) : passes;
  const omises = passes.length - gardees.length;
  if (omises > 0) out.push(`${omises} passe${omises > 1 ? 's' : ''} antérieure${omises > 1 ? 's' : ''} non incluse${omises > 1 ? 's' : ''}.`);
  out.push('');
  out.push(bloc("Prompt d'origine", prompt));
  for (const p of gardees) {
    out.push(`=== Passe ${p.n} · ${GENRES[p.kind] || p.kind || 'exécution'} ===\n${String(p.prompt || '').trim() || '(prompt non conservé)'}\n--- retour ---\n${String(p.output || '').trim() || '(aucun retour conservé)'}\n`);
  }
  if (questions.length) {
    out.push(bloc('Questions posées et réponses', questions.map((q) => `Q : ${String(q.question || '').trim()}${q.context ? `\n   (${String(q.context).trim()})` : ''}\nR : ${q.answer != null && String(q.answer).trim() ? String(q.answer).trim() : '(sans réponse)'}`).join('\n\n')));
  }
  if (review) out.push(bloc(`Dernier rapport de review lié (!${review.iid}, v${review.version}${review.note != null ? `, ${String(review.note).replace('.', ',')}/10` : ''})`, review.texte));
  if (verification) out.push(bloc(`Dernière vérification liée (!${verification.iid}${verification.verdict ? `, ${verification.verdict}` : ''})`, verification.texte));
  if (diff != null) out.push(bloc('Diff de la branche reprise', borneDiff(diff).texte));
  if (reponse != null && String(reponse).trim()) out.push(bloc('Réponse à la question en attente', reponse));
  out.push(bloc('Consigne de reprise', consigne));
  return out.join('\n');
}

/* ---------- Ce que la base locale sait de la session d'origine ---------- */

const lire = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };

/* Les passes d'une cible, avec leur retour en texte. Une session d'avant l'historique des passes
   n'a que `output_path` : il devient une passe unique, prompt non conservé. */
function passesDe(task, tg) {
  const liste = agentpass.list('task', task.id, tg.id).map((p) => ({ n: p.n, kind: p.kind, prompt: p.prompt, output: lire(p.output_path), at: p.created_at }));
  if (!liste.length && tg.output_path) liste.push({ n: 1, kind: 'run', prompt: '', output: lire(tg.output_path), at: tg.updated_at });
  return liste;
}
const questionsDe = (tg) => { try { return tg.questions_json ? JSON.parse(tg.questions_json) || [] : []; } catch { return []; } };

/* La merge request dont la branche source est celle reprise, son dernier rapport et sa dernière vérification. */
function mrDe(tg) {
  return db.prepare('SELECT * FROM mr WHERE repo_id = ? AND (source_branch = ? OR (? IS NOT NULL AND iid = ?)) ORDER BY id DESC LIMIT 1')
    .get(tg.repo_id, tg.branch, tg.mr_iid == null ? null : tg.mr_iid, tg.mr_iid == null ? null : tg.mr_iid) || null;
}
function reviewDe(mr) {
  if (!mr) return null;
  const v = db.prepare('SELECT * FROM review_version WHERE mr_id = ? ORDER BY version DESC, id DESC LIMIT 1').get(mr.id);
  if (!v) return null;
  const texte = lire(v.md_path);
  return texte ? { iid: mr.iid, version: v.version, note: v.note_value, texte } : null;
}
function verificationDe(mr, tg) {
  const rows = db.prepare("SELECT * FROM verification WHERE status = 'done' ORDER BY id DESC LIMIT 200").all();
  for (const v of rows) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json) || []; } catch { cibles = []; }
    const touche = cibles.some((c) => Number(c.repo_id) === Number(tg.repo_id) && ((mr && Number(c.mr_id) === Number(mr.id)) || c.branch === tg.branch));
    if (!touche) continue;
    const parts = [v.verdict ? `Verdict : ${v.verdict}` : null, v.imputable_json ? `Tests imputables : ${v.imputable_json}` : null, v.log_excerpt ? `Extrait :\n${v.log_excerpt}` : null].filter(Boolean);
    return { iid: mr ? mr.iid : '?', verdict: v.verdict, texte: parts.join('\n') };
  }
  return null;
}

/* ---------- Éligibilité et état de la forge ---------- */

/* Le bouton, ou son motif d'absence — sans réseau, sur ce que la base sait : la session est une
   session de CODAGE reçue d'un collègue (`auteur` ≠ moi), la cible a une branche poussée (ou une MR),
   non mergée. La branche est VÉRIFIÉE sur la forge à l'ouverture de la modale, jamais inventée. */
function eligibilite(task, tg, { auteur = null, moi = null } = {}) {
  if (!task || task.kind !== 'code') return { ok: false, reason: 'kind' };
  if (!auteur || (moi && auteur === moi)) return { ok: false, reason: 'mine' };
  if (!tg || !tg.branch) return { ok: false, reason: 'no-branch' };
  if (tg.mr_merged) return { ok: false, reason: 'merged', iid: tg.mr_iid || tg.existing_mr_iid || null };
  const poussee = tg.status === 'pushed' || tg.mr_iid != null || tg.existing_mr_iid != null || !!tg.push_command;
  if (!poussee) return { ok: false, reason: 'unpushed' };
  return { ok: true, needs_input: tg.status === 'needs_input' };
}

/* La tête de la branche sur la forge, et l'écart avec le dernier commit connu de la session (compté
   dans le clone après un fetch de la branche ; best-effort, null si le clone ne peut pas le dire). */
async function etatForge(cfg, repo, tg, onLog = () => {}) {
  // La démo n'a pas de forge : la tête connue par la session vaut tête de la forge, sans réseau.
  if (process.env.MERGERIE_DEMO === '1') return { absent: false, sha: tg.commit_sha || null, ecart: null, date: null };
  const ref = await forge.clientFor(repo).getRef(cfg, repo.project, 'branch', tg.branch);
  if (!ref || !ref.commit) return { absent: true, sha: null, ecart: null, date: null };
  const sha = ref.commit.id;
  let ecart = null;
  if (tg.commit_sha && sha !== tg.commit_sha) {
    try {
      const cwd = await git.ensureRepo(cfg, repo, onLog);
      await git.fetchRefs(cwd, [`+refs/heads/${tg.branch}:refs/remotes/origin/${tg.branch}`], onLog);
      const { stdout } = await git.run('git', ['rev-list', '--count', `${tg.commit_sha}..${sha}`], { cwd });
      ecart = parseInt(String(stdout).trim(), 10);
      if (!Number.isFinite(ecart)) ecart = null;
    } catch { ecart = null; }
  }
  return { absent: false, sha, ecart, date: ref.commit.committed_date || null };
}

/* Le diff de la branche reprise, relu sur place dans le clone (`base...branche`), ou null. */
async function diffDe(cfg, repo, tg, onLog = () => {}) {
  try {
    const cwd = await git.ensureRepo(cfg, repo, onLog);
    const base = tg.base_branch || await git.defaultBranch(cwd);
    await git.fetchRefs(cwd, [`+refs/heads/${tg.branch}:refs/remotes/origin/${tg.branch}`, `+refs/heads/${base}:refs/remotes/origin/${base}`], onLog);
    const { stdout } = await git.run('git', ['diff', `origin/${base}...origin/${tg.branch}`], { cwd, maxBuffer: 1024 * 1024 * 64 });
    return String(stdout || '');
  } catch { return null; }
}

/* ---------- L'aperçu et la création ---------- */

/* Les données de l'assemblage pour UNE cible, telles que la base les porte — sans réseau. */
function donnees(task, tg, { auteur, teteForge = null, ecart = null, derniereSynchro = null }) {
  const passes = passesDe(task, tg);
  const derniere = passes.length ? passes[passes.length - 1] : null;
  const mr = mrDe(tg);
  return {
    auteur, origineId: task.id, project: tg.project, branch: tg.branch, dernierCommit: tg.commit_sha || null,
    dernierePasse: derniere ? { n: derniere.n, at: derniere.at } : null,
    teteForge, ecart, running: task.status === 'running', derniereSynchro,
    prompt: task.prompt, passes, questions: questionsDe(tg), review: reviewDe(mr), verification: verificationDe(mr, tg),
  };
}

/* L'aperçu de la modale : le texte complet, les tokens estimés, le nombre de passes, et l'état de
   la forge. `options` : `{ consigne, reponse, passesIncluses, diff }`. */
async function apercu(cfg, task, tg, repo, { auteur, derniereSynchro = null } = {}, options = {}, onLog = () => {}) {
  const forgeEtat = await etatForge(cfg, repo, tg, onLog);
  const base = donnees(task, tg, { auteur, teteForge: forgeEtat.sha, ecart: forgeEtat.ecart, derniereSynchro });
  const diff = options.diff ? await diffDe(cfg, repo, tg, onLog) : null;
  const texte = assembler({ ...base, diff, reponse: options.reponse || null, consigne: options.consigne || '', passesIncluses: options.passesIncluses ?? null });
  return {
    texte, tokens: estimerTokens(texte), seuil: SEUIL_TOKENS, passes: base.passes.length, questions: base.questions.length,
    review: !!base.review, verification: !!base.verification,
    forge: forgeEtat, diff_lignes: diff != null ? borneDiff(diff).lignes : null,
  };
}

const fichierMessage = (taskId) => path.join(ensureDir(path.join(TASKS_DIR, String(taskId))), 'reprise.md');
const fichierBilan = (taskId) => path.join(ensureDir(path.join(TASKS_DIR, String(taskId))), 'reprise.json');

/* LA SESSION DE REPRISE : neuve, à moi, mes réglages (jamais ceux du collègue — ils ne voyagent
   pas), sur une nouvelle branche posée sur la tête de la branche reprise. Le premier message est
   écrit sur le disque (`reprise.md`) : c'est lui que la première passe envoie, tel quel. Rend l'id. */
async function creer(cfg, task, tg, repo, { auteur, consigne, reponse = null, passesIncluses = null, diff = false, branch, label = null, cli = {}, defauts = {} }, onLog = () => {}) {
  if (!String(consigne || '').trim()) throw new Error('consigne requise');
  const forgeEtat = await etatForge(cfg, repo, tg, onLog);
  if (forgeEtat.absent) throw new Error(`branche ${tg.branch} absente de la forge`);
  const base = donnees(task, tg, { auteur, teteForge: forgeEtat.sha, ecart: forgeEtat.ecart });
  const diffTexte = diff ? await diffDe(cfg, repo, tg, onLog) : null;
  const texte = assembler({ ...base, diff: diffTexte, reponse, consigne, passesIncluses });
  const nouvelle = tasks.assertValidBranch(branch || `${tg.branch}-reprise`);
  const id = tasks.creerTask({
    kind: 'code', prompt: String(consigne).trim(), branch: nouvelle, label,
    autoPush: defauts.autoPush ? 1 : 0, askQuestions: defauts.askQuestions ? 1 : 0, notifyJira: defauts.notifyJira ? 1 : 0, reviewAfter: 0,
    targets: [{ repo_id: tg.repo_id, branch: nouvelle, base_branch: tg.branch }], contextRepos: [],
    triggeredBy: 'manual', shared: 0, planFirst: 0, cliId: cli.cliId || null, cliName: cli.cliName || null,
    resumedFromUid: task.uid, resumedTargetUid: tg.uid,
  });
  fs.writeFileSync(fichierMessage(id), texte, 'utf8');
  const incluses = passesIncluses != null && passesIncluses < base.passes.length ? passesIncluses : base.passes.length;
  fs.writeFileSync(fichierBilan(id), JSON.stringify({
    origine_id: task.id, origine_uid: task.uid, auteur, branch: tg.branch, sha: forgeEtat.sha, passes: incluses, tokens: estimerTokens(texte),
  }), 'utf8');
  return id;
}

/* Ce que la première passe envoie à la place du prompt : le premier message, s'il existe. */
function premierMessage(taskId) {
  const p = path.join(TASKS_DIR, String(taskId), 'reprise.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function bilan(taskId) {
  try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, String(taskId), 'reprise.json'), 'utf8')); } catch { return null; }
}

/* ---------- La filiation, à l'affichage ---------- */

/* Les reprises d'une liste de sessions : `Map<uid d'origine, [{ id, uid, target_uid, created_at }]>`,
   les plus récentes d'abord — calculé, jamais stocké sur la session d'origine. */
function reprisesDe(uids) {
  const out = new Map();
  if (!uids.length) return out;
  for (const r of db.prepare(`SELECT id, uid, resumed_from_uid, resumed_target_uid, created_at, status FROM task
      WHERE resumed_from_uid IN (${uids.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC`).all(...uids)) {
    if (!out.has(r.resumed_from_uid)) out.set(r.resumed_from_uid, []);
    out.get(r.resumed_from_uid).push({ id: r.id, uid: r.uid, target_uid: r.resumed_target_uid, created_at: r.created_at, status: r.status });
  }
  return out;
}
/* La session d'origine d'une reprise, si elle est connue ici. */
function origineDe(task) {
  if (!task || !task.resumed_from_uid) return null;
  const o = db.prepare('SELECT id, uid, label, prompt, status FROM task WHERE uid = ?').get(task.resumed_from_uid);
  return o ? { id: o.id, uid: o.uid, label: o.label || null, prompt: o.prompt, status: o.status, target_uid: task.resumed_target_uid || null } : { id: null, uid: task.resumed_from_uid, target_uid: task.resumed_target_uid || null };
}

module.exports = {
  MAX_LIGNES_DIFF, SEUIL_TOKENS, GENRES,
  assembler, borneDiff, estimerTokens, eligibilite, etatForge, diffDe, donnees, apercu, creer, premierMessage, bilan, reprisesDe, origineDe,
  passesDe, questionsDe,
};
