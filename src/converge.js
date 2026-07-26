'use strict';
/* « Converger » — la boucle de qualité autonome.
   Machine à états qui ORCHESTRE des briques existantes :
     review → (si note < seuil) correction IA sur la branche (commit + push) →
     re-review INCRÉMENTALE du delta → …jusqu'au seuil, à la régression, ou au plafond.

   Garde-fous v1 : seuil atteint / note qui baisse ou stagne / plafond de passes.
   JAMAIS d'auto-merge : la boucle PRÉPARE, l'humain valide et merge. Toute la trace
   (notes par passe, commits, findings) reste visible via review_version + git. */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const git = require('./git');
const copilot = require('./copilot');
const notify = require('./notify');
const proc = require('./proc');
const forge = require('./forge');
const taskrunner = require('./taskrunner');
const discover = require('./discover');
const agentsession = require('./agentsession');
const questions = require('./questions');
const { getConfig } = require('./config');
const { reviewMr } = require('./reviewer');

function latestVersion(mrId) {
  return db.prepare('SELECT * FROM review_version WHERE mr_id = ? ORDER BY version DESC LIMIT 1').get(mrId);
}
// note_value est une fraction [0,1] ; la note /10 = note_value * 10.
function note10Of(v) { return v && v.note_value != null ? Math.round(v.note_value * 1000) / 100 : null; }

// Réglages par défaut (surchargeables au lancement), bornés comme dans config.js.
function convergeDefaults() {
  const cfg = getConfig();
  const th = parseFloat(String(cfg.converge_threshold).replace(',', '.'));
  const mp = parseInt(cfg.converge_max_passes, 10);
  return {
    threshold: Number.isFinite(th) ? Math.min(10, Math.max(1, th)) : 8,
    maxPasses: Number.isFinite(mp) ? Math.min(10, Math.max(1, mp)) : 3,
  };
}

// Applique les corrections du rapport au code de la branche, commite et POUSSE.
// Renvoie `{ sha }` (null si rien changé) ou `{ needsInput, questions }` si l'IA a posé des
// questions (converge depuis une session avec l'option activée). `ctx` = { task, targetId } :
// quand fourni, la correction REPREND la même session que le dev (continuité) et peut poser
// des questions ; sans lui (convergence depuis une MR), comportement historique one-shot.
async function applyFixAndPush(repo, mr, reviewMd, message, onLog, ctx = {}) {
  const cfg = getConfig();
  const cwd = await git.ensureRepo(cfg, repo, onLog);
  await git.ensureCleanWorktree(cwd, onLog);
  onLog(`alignement sur origin/${mr.source_branch}`);
  await git.createBranchFrom(cwd, mr.source_branch, `origin/${mr.source_branch}`, onLog);

  const ask = !!(ctx.task && ctx.task.ask_questions);
  let prompt =
    `Voici une revue de code de la branche ${mr.source_branch}. Applique directement dans les fichiers `
    + `les corrections et suggestions PERTINENTES de cette revue (concentre-toi sur les vrais problèmes : `
    + `bugs, sécurité, robustesse, correction fonctionnelle ; ignore le purement cosmétique ou ambigu).\n\n`
    + `=== RAPPORT DE REVUE ===\n${reviewMd}`;
  if (ask) prompt += questions.QUESTIONS_INSTRUCTION;

  onLog(`correction IA (${copilot.isDryRun() ? 'dry-run' : 'copilot'})`);
  let agentText = '';
  if (copilot.isDryRun()) {
    // dry-run : on produit un vrai changement pour que le commit ait de la matière.
    fs.appendFileSync(path.join(cwd, 'PROJ_CONVERGE_DRYRUN.md'), `\n## ${message}\n`, 'utf8');
  } else if (ctx.targetId && agentsession.backendName() !== 'unknown') {
    // Continuité : reprend la MÊME session que le dev (clé task-…-target-…).
    const tg = db.prepare('SELECT session_key, session_cwd FROM task_target WHERE id = ?').get(ctx.targetId) || {};
    const key = `task-${ctx.task.id}-target-${ctx.targetId}`;
    let doResume = !!tg.session_key;
    if (doResume && tg.session_cwd && path.resolve(tg.session_cwd) !== path.resolve(cwd)) doResume = false;
    let r; let created = !doResume;
    try { r = await agentsession.runInSession({ key, handle: doResume ? tg.session_key : null, prompt, cwd, resume: doResume, onLog }); }
    catch (e) { if (!doResume) throw e; onLog('⚠ reprise de session impossible → session neuve'); r = await agentsession.runInSession({ key, prompt, cwd, resume: false, onLog }); created = true; }
    agentText = r.text || '';
    copilot.recordUsage('task', prompt, agentText);
    taskrunner.saveAgentOutput(ctx.task.id, ctx.targetId, agentText); // retour de l'agent, consultable
    if (created) db.prepare('UPDATE task_target SET session_key = ?, session_backend = ?, session_cwd = ?, updated_at = ? WHERE id = ?').run(r.handle, r.backend, cwd, new Date().toISOString(), ctx.targetId);
  } else {
    await copilot.runPrompt(prompt, cwd, { kind: 'task' }, onLog);
  }

  if (ask) {
    const qs = questions.parseQuestions(agentText);
    if (qs && qs.length) return { needsInput: true, questions: qs };
  }

  const committed = await git.commitAll(cwd, message, onLog);
  if (!committed) return { sha: null };
  const sha = await git.headSha(cwd);
  onLog(`push origin ${mr.source_branch}`);
  await git.pushBranch(cwd, mr.source_branch, onLog, git.secretsOf(cfg));
  return { sha };
}

// Message-résumé (français, informatif — l'UI localise à partir du `status`).
function summaryFor(status, { best, passes, threshold }) {
  const n = best.note == null ? '—' : `${best.note}/10`;
  switch (status) {
    case 'converged': return `convergé : ${n} en ${passes} passe(s) (seuil ${threshold})`;
    case 'capped': return `plafond atteint (${passes} passes) — meilleure note ${n}`;
    case 'regressed': return `arrêt : la note a baissé ou stagné — meilleure ${n}`;
    case 'no_change': return `arrêt : la correction IA n'a rien changé`;
    case 'stopped': return `arrêté par l'utilisateur — meilleure note ${n}`;
    default: return status;
  }
}

// Boucle de convergence complète pour une MR. Renvoie l'état final.
async function convergeRun(mrId, opts, onLog = () => {}, ctx = {}) {
  let mr = db.prepare('SELECT * FROM mr WHERE id = ?').get(mrId);
  if (!mr) throw new Error('MR introuvable');
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id);
  if (!repo) throw new Error('Dépôt introuvable');

  const { threshold, maxPasses } = { ...convergeDefaults(), ...opts };
  const runId = db.prepare(`INSERT INTO convergence_run (mr_id, status, threshold, max_passes, passes_done, started_at)
    VALUES (?, 'running', ?, ?, 0, ?)`).run(mrId, threshold, maxPasses, new Date().toISOString()).lastInsertRowid;

  const setRun = (patch) => {
    const cols = Object.keys(patch);
    db.prepare(`UPDATE convergence_run SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...patch, id: runId });
  };

  try {
    // Point de départ : une note À JOUR. Si aucune review, ou MR périmée (branche
    // bougée depuis la dernière review), on (re)review d'abord.
    let v = latestVersion(mrId);
    const stale = mr.reviewed_sha && mr.current_sha && mr.reviewed_sha !== mr.current_sha;
    if (!v || stale) {
      onLog(v ? 'MR périmée → re-review avant de converger' : 'aucune review → review initiale');
      await reviewMr(repo, mr, onLog, { incremental: !!v });
      mr = db.prepare('SELECT * FROM mr WHERE id = ?').get(mrId);
      v = latestVersion(mrId);
    }

    let note = note10Of(v);
    let best = { note, version: v ? v.version : null };
    setRun({ start_note: note, best_note: note, best_version: best.version });
    onLog(`note de départ : ${note == null ? '—' : `${note}/10`} · seuil ${threshold}/10 · plafond ${maxPasses} passes`);

    let passes = 0;
    let status = 'running';
    for (;;) {
      if (note != null && note >= threshold) { status = 'converged'; break; }
      if (passes >= maxPasses) { status = 'capped'; break; }
      if (proc.isCancelled()) { status = 'stopped'; break; }

      // 1) Correction IA à partir du rapport courant → commit + push.
      const cur = latestVersion(mrId);
      const reviewMd = cur && cur.md_path && fs.existsSync(cur.md_path) ? fs.readFileSync(cur.md_path, 'utf8') : '';
      onLog(`──── passe ${passes + 1}/${maxPasses} : correction ────`);
      const message = `${mr.source_branch}: convergence passe ${passes + 1} (review !${mr.iid})`;
      const fix = await applyFixAndPush(repo, mr, reviewMd, message, onLog, ctx);
      // L'IA a posé des questions pendant la correction → on met la BOUCLE en attente :
      // la cible passe `needs_input` (questions stockées), l'utilisateur répond (formulaire de
      // session) puis relance Converger, qui reprend la même session.
      if (fix.needsInput) {
        if (ctx.targetId) taskrunner.setTarget(ctx.targetId, { questions_json: JSON.stringify(fix.questions), status: 'needs_input', last_error: null });
        setRun({ status: 'needs_input', passes_done: passes, message: 'en attente de réponses — l’IA a posé des questions', finished_at: new Date().toISOString() });
        onLog('⏸ l’IA a posé des questions pendant la correction — convergence en attente de tes réponses');
        return { runId, status: 'needs_input', note: best.note, passes };
      }
      const newSha = fix.sha;
      if (!newSha) { status = 'no_change'; break; }
      passes += 1;
      db.prepare('UPDATE mr SET current_sha = ?, updated_at = ? WHERE id = ?')
        .run(newSha, new Date().toISOString(), mrId);
      setRun({ passes_done: passes });

      // 2) Re-review INCRÉMENTALE du delta (reviewed_sha..newSha).
      mr = db.prepare('SELECT * FROM mr WHERE id = ?').get(mrId);
      onLog(`──── passe ${passes} : re-review incrémentale ────`);
      await reviewMr(repo, mr, onLog, { incremental: true });
      mr = db.prepare('SELECT * FROM mr WHERE id = ?').get(mrId);

      const nv = latestVersion(mrId);
      const newNote = note10Of(nv);
      onLog(`note après passe ${passes} : ${newNote == null ? '—' : `${newNote}/10`}`);
      if (newNote == null) { status = 'error'; setRun({ message: 'note illisible après re-review' }); break; }
      if (best.note == null || newNote > best.note) best = { note: newNote, version: nv.version };
      setRun({ best_note: best.note, best_version: best.version });

      if (newNote >= threshold) { note = newNote; status = 'converged'; break; }
      if (note != null && newNote <= note) { note = newNote; status = 'regressed'; break; } // baisse/stagnation
      note = newNote;
    }

    const message = summaryFor(status, { best, passes, threshold });
    setRun({ status, passes_done: passes, message, finished_at: new Date().toISOString() });
    onLog(`✅ convergence : ${status} — ${message}`);
    notify.push('converge_done', { mr_id: mrId, iid: mr.iid, status, note10: best.note, passes });
    return { runId, status, note: best.note, passes };
  } catch (e) {
    setRun({ status: 'error', message: String(e.message).slice(0, 300), finished_at: new Date().toISOString() });
    throw e;
  }
}

// Dernière run de convergence d'une MR (pour le panneau).
function latestRun(mrId) {
  return db.prepare('SELECT * FROM convergence_run WHERE mr_id = ? ORDER BY id DESC LIMIT 1').get(mrId);
}

/* ---------- Converger depuis une session de dev IA (du prompt à la MR convergée) ----------
   Amorce : dev IA → commit → push → crée la MR → upsert ciblé en base → délègue à
   convergeRun. Idempotent : une étape déjà faite (code committé, MR ouverte) est sautée. */
function reloadTarget(id) {
  return db.prepare('SELECT tt.*, repo.project, repo.forge FROM task_target tt JOIN repo ON repo.id = tt.repo_id WHERE tt.id = ?').get(id);
}

async function bootstrapMrForTarget(task, tg, onLog) {
  const cfg = getConfig();
  tg = reloadTarget(tg.id);

  // 1) DEV si pas encore codé (session neuve). Une session déjà exécutée n'est PAS recodée.
  if (tg.status === 'new' || !tg.commit_sha) {
    // Prompt et message VIENNENT de taskrunner : session « normale » et session
    // « convergée » doivent coder à l'identique, aujourd'hui comme après refonte.
    const message = taskrunner.commitMessageFor(task);
    const promptText = taskrunner.buildCodePrompt(task);
    onLog(`── dev IA sur ${tg.project} ──`);
    const res = await taskrunner.execOnTarget(task, tg, { promptText, message, allowCreate: true, onLog, forcePush: true });
    // L'IA a posé des questions (option activée) : on met la convergence EN ATTENTE ici même,
    // avant de créer la MR. L'utilisateur répond (formulaire de session) puis relance Converger.
    if (res && res.needsInput) { onLog('⏸ l’IA a posé des questions — convergence en attente de tes réponses'); return { needsInput: true }; }
    tg = reloadTarget(tg.id);
  }
  // 2) s'assurer que la branche est poussée (session codée mais pas encore poussée)
  if (tg.status !== 'pushed') { await taskrunner.pushTarget(task.id, tg.id, onLog); tg = reloadTarget(tg.id); }

  // 3) créer la MR si elle n'existe pas encore (cible = branche de départ de la session).
  // Même repli que l'endpoint /targets/:tid/mr (server.effectiveMr) : une MR ouverte à
  // la main sur GitLab puis ramassée par discoverAll existe en table `mr` SANS que
  // task_target.mr_iid soit posé. Sans ce repli, on retenterait une création → 409.
  let iid = tg.mr_iid;
  if (iid) {
    onLog(`MR !${iid} déjà ouverte → convergence directe`);
  } else {
    const known = db.prepare(`SELECT iid, web_url, target_branch FROM mr
      WHERE repo_id = ? AND source_branch = ? AND (closed_seen IS NULL OR closed_seen = 0)
      LIMIT 1`).get(tg.repo_id, tg.branch);
    if (known) {
      iid = known.iid;
      db.prepare('UPDATE task_target SET mr_iid = ?, mr_url = ?, mr_target = ?, updated_at = ? WHERE id = ?')
        .run(iid, known.web_url || null, known.target_branch || tg.mr_target || null, new Date().toISOString(), tg.id);
      onLog(`MR !${iid} déjà ouverte sur GitLab → rattachée puis convergée`);
    }
  }
  if (!iid) {
    let target = tg.base_branch;
    if (!target) { const b = await forge.clientFor(tg).listBranches(cfg, tg.project); target = (b && b.default) || 'main'; }
    const title = (task.commit_message && task.commit_message.trim()) || tg.branch;
    onLog(`création de la MR ${tg.branch} → ${target}`);
    const created = await forge.clientFor(tg).createMergeRequest(cfg, tg.project, { source_branch: tg.branch, target_branch: target, title });
    iid = created.iid;
    db.prepare('UPDATE task_target SET mr_iid = ?, mr_url = ?, mr_target = ?, mr_merged = 0, updated_at = ? WHERE id = ?')
      .run(iid, created.web_url, target, new Date().toISOString(), tg.id);
    onLog(`MR !${iid} créée`);
  }

  // 4) upsert CIBLÉ de la MR dans la table `mr` (objet API complet → SHA à jour)
  const apiMr = await forge.clientFor(tg).getMergeRequest(cfg, tg.project, iid);
  return discover.upsertMrFromApi(tg.repo_id, apiMr);
}

/* Après convergence, la branche porte N commits de plus que le dev initial : on remet
   à jour le SHA et le patch du projet, sinon l'action « Diff » de la session montre le
   travail d'AVANT corrections. Best-effort ABSOLU : un échec ici ne doit pas transformer
   une convergence réussie en projet « en erreur ». */
async function refreshTargetDiff(tg, mrId, onLog) {
  const mr = db.prepare('SELECT current_sha FROM mr WHERE id = ?').get(mrId);
  const patch = { status: 'pushed', last_error: null }; // branche poussée, MR ouverte
  if (mr && mr.current_sha) patch.commit_sha = mr.current_sha;
  try {
    const cur = reloadTarget(tg.id);
    if (cur && cur.diff_path) {
      const cfg = getConfig();
      const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(cur.repo_id);
      const cwd = git.cloneDirFor(cfg, repo);
      const base = cur.base_branch || await git.defaultBranch(cwd);
      await git.ensureCleanWorktree(cwd, () => {});
      await git.createBranchFrom(cwd, cur.branch, `origin/${cur.branch}`, () => {});
      fs.writeFileSync(cur.diff_path, await git.branchDiff(cwd, base), 'utf8');
      patch.commit_sha = await git.headSha(cwd);
    }
  } catch (e) {
    onLog(`(diff du projet non rafraîchi : ${e.message})`);
  }
  taskrunner.setTarget(tg.id, patch);
}

// Converge une session de dev : chaque projet (MULTI) est traité EN SÉRIE. Un projet en
// échec n'interrompt pas les suivants — son erreur est consignée sur SA ligne.
async function convergeSession(taskId, opts, onLog = () => {}) {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  if (!task) throw new Error('Session introuvable');
  if (task.kind !== 'code') throw new Error('La convergence ne s’applique qu’aux sessions de codage');
  // targetsOf : jointure `repo` (sans elle, tg.project serait undefined dans les logs
  // et les résultats) et ordre stable par tt.id — le « en série » doit être déterministe.
  const targets = taskrunner.targetsOf(taskId);
  if (!targets.length) throw new Error('Aucun projet dans cette session');
  db.prepare("UPDATE task SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);

  const results = [];
  for (const tg of targets) {
    if (proc.isCancelled()) break;
    onLog(`════════ ${tg.project} · ${tg.branch} ════════`);
    taskrunner.setTarget(tg.id, { status: 'running', last_error: null });
    try {
      const boot = await bootstrapMrForTarget(task, tg, onLog);
      // needs_input : l'IA a posé des questions pendant le dev → la cible est déjà passée en
      // `needs_input` (par execOnTarget). On ne converge pas : on attend les réponses.
      if (boot && boot.needsInput) { results.push({ project: tg.project, status: 'needs_input' }); continue; }
      const mrId = boot;
      const r = await convergeRun(mrId, opts, onLog, { task, targetId: tg.id });
      if (r && r.status === 'needs_input') { results.push({ project: tg.project, mrId, status: 'needs_input' }); continue; }
      await refreshTargetDiff(tg, mrId, onLog);
      results.push({ project: tg.project, mrId, status: r.status, note: r.note, passes: r.passes });
    } catch (e) {
      taskrunner.setTarget(tg.id, { status: 'error', last_error: String(e.message) });
      onLog(`⚠ ${tg.project} : ${e.message}`);
      results.push({ project: tg.project, status: 'error', error: e.message });
    }
  }
  taskrunner.syncTaskStatus(taskId);
  // `converged` = réellement au seuil. `capped` / `regressed` / `no_change` sont des
  // arrêts légitimes mais PAS des succès : les compter comme tels afficherait
  // « 2/2 projet(s) » alors qu'aucune MR n'a atteint le seuil.
  const converged = results.filter((r) => r.status === 'converged').length;
  const failed = results.filter((r) => r.status === 'error').length;
  onLog(`convergence de session : ${converged}/${targets.length} projet(s) au seuil, ${failed} en échec`);
  // Un échec total, ou un arrêt utilisateur, ne doit PAS ressortir en job « ✅ terminé » :
  // on relance pour que jobs.js pose 'error' / 'stopped' (cf. runCodeTask).
  if (proc.isCancelled()) throw new Error('Arrêté par l’utilisateur');
  if (failed && failed === results.length) {
    throw new Error(results[0].error || 'Aucun projet n’a pu converger');
  }
  return results;
}

module.exports = { convergeRun, convergeSession, latestRun, convergeDefaults };
