'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { getConfig } = require('./config');
const { TASKS_DIR, ensureDir } = require('./paths');
const git = require('./git');
const copilot = require('./copilot');
const agentsession = require('./agentsession');
const questions = require('./questions');
const agentpass = require('./agentpass');
const { t } = require('../public/i18n-runtime.js');

const WORK_REL = 'ai-dev-tools-internal';

// En dry-run, quand une session autorise les questions, l'agent « simule » un bloc
// QUESTIONS au 1er passage : ça exerce tout le flux ask → needs_input → reprise sans agent.
const DRYRUN_QUESTIONS = `Analyse préalable effectuée.
<<<QUESTIONS
[
  {"id":"q1","question":"Où placer la logique de retry ?","context":"Deux conventions coexistent dans le dépôt.","options":[{"value":"decorator","label":"Décorateur (comme OrderService)"},{"value":"middleware","label":"Middleware HTTP (comme PaymentClient)"}]},
  {"id":"q2","question":"Faut-il migrer les données existantes ?","context":"La colonne change de type.","options":null}
]
QUESTIONS>>>`;

function safeParseQuestions(json) { try { return JSON.parse(json) || []; } catch { return []; } }

function taskDir(taskId) {
  return ensureDir(path.join(TASKS_DIR, String(taskId)));
}

// Écrit le dernier message de l'agent d'un projet dans un fichier et le référence sur la
// cible. Best-effort : ne doit jamais faire échouer la session pour un souci d'écriture.
/* Retour de l'agent pour UNE passe. On enregistre l'itération complète (prompt envoyé +
   retour) dans l'historique, et `output_path` continue de pointer la plus récente. */
function saveAgentOutput(taskId, targetId, text, meta = {}) {
  const { outPath } = agentpass.record('task', taskId, targetId, {
    kind: meta.kind || 'run', prompt: meta.prompt, text,
  });
  if (outPath) setTarget(targetId, { output_path: outPath });
}

// Les projets d'une session. Une session « codage » les traite l'un après l'autre ;
// une session « exploration » les regarde tous ensemble.
function targetsOf(taskId) {
  return db.prepare(`SELECT tt.*, repo.project AS project, repo.url AS url, repo.forge AS forge
    FROM task_target tt JOIN repo ON repo.id = tt.repo_id
    WHERE tt.task_id = ? ORDER BY tt.id`).all(taskId);
}

function setTarget(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE task_target SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`;
  db.prepare(sql).run({ ...fields, id, updated_at: new Date().toISOString() });
}

// Statut global d'une session = agrégat de ses projets (le plus « en retard » gagne,
// une erreur quelque part rend la session en erreur).
function syncTaskStatus(taskId) {
  const st = db.prepare('SELECT status FROM task_target WHERE task_id = ?').all(taskId).map((r) => r.status);
  let status = 'new';
  if (st.length) {
    if (st.includes('error')) status = 'error';
    // needs_input = ATTENTE (ni succès ni échec) : prioritaire dès qu'aucune erreur, pour
    // que la session s'affiche « en attente de tes réponses » et n'entre dans aucun compteur d'échec.
    else if (st.includes('needs_input')) status = 'needs_input';
    else if (st.every((s) => s === 'pushed')) status = 'pushed';
    else if (st.every((s) => s === 'pushed' || s === 'committed')) status = 'committed';
    else if (st.some((s) => s === 'pushed' || s === 'committed')) status = 'committed';
  }
  db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), taskId);
}

// Bloc « captures » : les images de la tâche sont copiées dans le cwd de l'agent.
function attachImages(task, cwd, onLog) {
  ensureDir(path.join(cwd, WORK_REL));
  const images = db.prepare('SELECT * FROM task_image WHERE task_id = ? ORDER BY id').all(task.id);
  let imgBlock = '';
  images.forEach((im, i) => {
    if (!fs.existsSync(im.path)) return;
    const ext = path.extname(im.path) || '.png';
    const rel = `${WORK_REL}/img_${i + 1}${ext}`;
    try { fs.copyFileSync(im.path, path.join(cwd, rel)); imgBlock += `\n- capture jointe : \`${rel}\``; } catch { /* ignore */ }
  });
  if (imgBlock) { imgBlock = `\n\nDes captures d'écran sont fournies (ouvre-les) :${imgBlock}`; onLog(`${images.length} capture(s) jointe(s)`); }
  return imgBlock;
}

/* ================= CODAGE ================= */

/* Prompt de dev et message de commit d'une session : UNE seule définition, partagée
   par la session « normale » (runTask) et la session « convergée » (converge.js).
   Le jour où on affine ce prompt — c'est le cœur produit — les deux chemins suivent. */
function buildCodePrompt(task) {
  const base = 'Réalise la tâche de développement suivante dans ce dépôt. '
    + `Modifie directement les fichiers nécessaires.\n\n${task.prompt}`;
  // Option « l'IA peut poser des questions » : on ajoute la consigne du bloc <<<QUESTIONS>>>.
  return task && task.ask_questions ? base + questions.QUESTIONS_INSTRUCTION : base;
}
function commitMessageFor(task) {
  return (task.commit_message && task.commit_message.trim())
    || (task.prompt.split('\n')[0] || '').slice(0, 72);
}

// Exécute le prompt sur UN projet : place la branche, laisse l'IA modifier, commite.
// La branche de base n'est pas saisie : c'est la branche par défaut du dépôt.
async function execOnTarget(task, tg, { promptText, message, allowCreate, onLog, forcePush, resume, passKind }) {
  // On REPREND la session dès qu'un handle existe pour cette cible : la continuité vaut pour
  // le run initial, « Demander une correction » (followup), une relance, la reprise après
  // questions et les passes de convergence. Le 1er passage la crée.
  let doResume = !!(resume || tg.session_key);
  const cfg = getConfig();
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));

  const cwd = await git.ensureRepo(cfg, repo, onLog);
  // Un vestige de session interrompue rendrait le checkout ci-dessous impossible.
  await git.ensureCleanWorktree(cwd, onLog);
  const base = tg.base_branch || await git.defaultBranch(cwd);

  const hasRemote = await git.refExists(cwd, `origin/${tg.branch}`);
  const hasLocal = await git.refExists(cwd, `refs/heads/${tg.branch}`);
  if (hasRemote) {
    onLog(`branche ${tg.branch} existe sur le remote → alignement sur origin/${tg.branch}`);
    await git.createBranchFrom(cwd, tg.branch, `origin/${tg.branch}`, onLog);
  } else if (hasLocal) {
    onLog(`branche ${tg.branch} existe en local → réutilisation`);
    await git.checkoutBranch(cwd, tg.branch, onLog);
  } else if (allowCreate) {
    onLog(`création de la branche ${tg.branch} depuis ${base}`);
    await git.createBranchFrom(cwd, tg.branch, `origin/${base}`, onLog);
  } else {
    throw new Error(t('err.branch-missing-run-first', { branch: tg.branch }));
  }

  const imgBlock = attachImages(task, cwd, onLog);

  onLog(`exécution (${copilot.isDryRun() ? 'dry-run' : 'IA'})`);
  let agentText = '';
  if (copilot.isDryRun()) {
    if (task.ask_questions && !doResume) {
      onLog('$ (DRY-RUN — l’agent pose des questions)');
      agentText = DRYRUN_QUESTIONS; // simule le bloc <<<QUESTIONS>>> au 1er passage
    } else {
      onLog('$ (DRY-RUN — aucune vraie modification)');
      fs.appendFileSync(path.join(cwd, 'PROJ_TASK_DRYRUN.md'), `\n## ${message}\n${promptText.slice(0, 200)}\n`, 'utf8');
      // Retour d'agent simulé, pour que « Retour de l'IA » soit consultable en dry-run/démo.
      agentText = `# Retour de l'IA (dry-run)\n\nJ'ai traité la demande « ${message} » dans ce projet.\n\n> Simulation dry-run : aucune vraie modification. Configure l'agent et relance pour un vrai retour.`;
    }
  } else if (agentsession.backendName() !== 'unknown') {
    // Session reprenable : 1re passe = création, reprise = --resume / --continue. Le cwd fait
    // partie de l'identité de session : on refuse une reprise depuis un autre cwd (§4.4).
    const key = `task-${task.id}-target-${tg.id}`;
    if (doResume && tg.session_cwd && path.resolve(tg.session_cwd) !== path.resolve(cwd)) {
      onLog(`⚠ cwd de session différent → reprise refusée, repli sur une session neuve`);
      doResume = false;
    }
    let r; let created = !doResume; // création = 1re passe OU repli après échec de reprise
    try {
      r = await agentsession.runInSession({ key, handle: doResume ? tg.session_key : null, prompt: promptText + imgBlock, cwd, resume: doResume, onLog });
    } catch (e) {
      if (!doResume) throw e;
      // Fallback (§4.5) : reprise impossible → session neuve avec contexte réinjecté.
      onLog(`⚠ reprise impossible (${String(e.message).split('\n')[0]}) → session neuve, contexte réinjecté`);
      r = await agentsession.runInSession({ key, prompt: `${buildCodePrompt(task)}\n\n${promptText}${imgBlock}`, cwd, resume: false, onLog });
      created = true;
    }
    agentText = r.text || '';
    copilot.recordUsage('task', promptText + imgBlock, agentText); // le run en session compte aussi
    if (created) setTarget(tg.id, { session_key: r.handle, session_backend: r.backend, session_cwd: cwd });
  } else {
    // Backend non reconnu (ni claude ni copilot) : pas de reprise possible, appel one-shot.
    agentText = (await copilot.runPrompt(promptText + imgBlock, cwd, { kind: 'task' }, onLog)) || '';
  }

  // Retour de l'agent (ce qu'il dit avoir fait), consultable en fin de session — comme la
  // réponse d'une exploration. Vide en dry-run (pas de vrai retour).
  saveAgentOutput(task.id, tg.id, agentText, { kind: passKind || 'run', prompt: promptText + imgBlock });

  // L'agent a-t-il posé des questions ? Si oui → session en ATTENTE, sans commit (il s'est
  // arrêté avant d'implémenter). Un bloc malformé/absent est ignoré (parseQuestions → null).
  if (task.ask_questions) {
    const qs = questions.parseQuestions(agentText);
    if (qs && qs.length) {
      setTarget(tg.id, { questions_json: JSON.stringify(qs), status: 'needs_input', last_error: null });
      onLog(`⏸ ${qs.length} question(s) posée(s) — session en attente de tes réponses`);
      return { needsInput: true };
    }
  }

  onLog(`commit : ${message}`);
  const committed = await git.commitAll(cwd, message, onLog);
  if (!committed) {
    // Aucun fichier modifié : le plus souvent l'IA a répondu/demandé une précision au lieu de
    // coder (prompt incomplet). On REMONTE sa réponse pour que l'erreur soit parlante, et on
    // suggère « L'IA peut me poser des questions » pour un vrai aller-retour structuré.
    const said = String(agentText || '').trim();
    throw new Error(said
      ? t('err.no-change-agent-said', { said: said.slice(0, 500) })
      : t('err.aucun-changement-produit-rien-a'));
  }
  const sha = await git.headSha(cwd);

  const diff = await git.branchDiff(cwd, base);
  const dpath = path.join(ensureDir(path.join(taskDir(task.id), String(tg.id))), 'diff.patch');
  fs.writeFileSync(dpath, diff, 'utf8');

  const pushCommand = `git push -u origin ${tg.branch}`;
  setTarget(tg.id, {
    base_branch: base, commit_sha: sha, diff_path: dpath, push_command: pushCommand,
    last_error: null, status: 'committed', questions_json: null, // questions soldées
  });

  if (task.auto_push || forcePush) {
    onLog(`push : ${pushCommand}`);
    await git.pushBranch(cwd, tg.branch, onLog, git.secretsOf(cfg));
    setTarget(tg.id, { status: 'pushed' });
    onLog('✅ branche poussée');
  } else {
    onLog('✅ commit prêt — en attente de validation du push');
  }
}

// Session de codage : chaque projet est traité l'un après l'autre. Un projet en échec
// n'interrompt pas les suivants — son erreur est consignée sur SA ligne.
async function runCodeTask(task, { promptText, message, allowCreate, onLog, passKind }) {
  const targets = targetsOf(task.id);
  if (!targets.length) throw new Error(t('err.aucun-projet-selectionne-pour-cette'));
  let ok = 0; let waiting = 0; const fails = [];
  for (const tg of targets) {
    onLog(`──────── ${tg.project} · ${tg.branch} ────────`);
    setTarget(tg.id, { status: 'running', last_error: null });
    try {
      const r = await execOnTarget(task, tg, { promptText, message, allowCreate, onLog, passKind });
      if (r && r.needsInput) waiting += 1; else ok += 1;
    } catch (e) {
      setTarget(tg.id, { status: 'error', last_error: e.message });
      fails.push({ project: tg.project, error: e.message });
      onLog(`⚠ ${tg.project} : ${e.message}`);
    }
  }
  syncTaskStatus(task.id);
  onLog(`${ok}/${targets.length} projet(s) traité(s)${waiting ? `, ${waiting} en attente de réponses` : ''}`);
  if (!ok && !waiting) {
    // Tout a échoué : on remonte la VRAIE raison plutôt qu'un « voir le détail ». Un seul
    // projet → son erreur directement ; plusieurs → la liste, projet par projet.
    if (fails.length === 1) throw new Error(fails[0].error);
    if (fails.length) throw new Error(`${t('err.aucun-projet-n-a-pu')}\n\n${fails.map((f) => `— ${f.project} :\n${f.error}`).join('\n\n')}`);
    throw new Error(t('err.aucun-projet-n-a-pu'));
  }
}

/* ================= EXPLORATION (lecture seule) ================= */

// Prépare chaque dépôt sur la branche demandée, puis pose UNE question à l'agent avec
// pour cwd la RACINE des clones : il voit ainsi tous les projets et produit une seule
// synthèse. Les worktrees sont remis à zéro ensuite : aucune modification ne subsiste.
async function runExploration(task, { question, previous, onLog }) {
  const cfg = getConfig();
  const targets = targetsOf(task.id);
  if (!targets.length) throw new Error(t('err.aucun-projet-selectionne-pour-cette-2'));

  const root = path.resolve(cfg.clone_path);
  const dirs = [];
  for (const tg of targets) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
    if (!repo) { setTarget(tg.id, { status: 'error', last_error: 'Dépôt introuvable.' }); continue; }
    onLog(`──────── ${tg.project} · ${tg.branch || '(branche par défaut)'} ────────`);
    setTarget(tg.id, { status: 'running', last_error: null });
    try {
      const cwd = await git.ensureRepo(cfg, repo, onLog);
      await git.ensureCleanWorktree(cwd, onLog);
      const branch = tg.branch || await git.defaultBranch(cwd);
      if (await git.refExists(cwd, `origin/${branch}`)) {
        await git.createBranchFrom(cwd, branch, `origin/${branch}`, onLog);
      } else if (await git.refExists(cwd, `refs/heads/${branch}`)) {
        await git.checkoutBranch(cwd, branch, onLog);
      } else {
        throw new Error(t('err.branch-missing-on-project', { branch, project: tg.project }));
      }
      dirs.push({ dir: path.relative(root, cwd) || path.basename(cwd), project: tg.project, branch, cwd });
      setTarget(tg.id, { base_branch: branch, status: 'done', last_error: null });
    } catch (e) {
      setTarget(tg.id, { status: 'error', last_error: e.message });
      onLog(`⚠ ${tg.project} : ${e.message}`);
    }
  }
  if (!dirs.length) throw new Error(t('err.aucun-depot-n-a-pu'));

  const outRel = `${WORK_REL}/exploration.md`;
  const outAbs = path.join(root, outRel);
  ensureDir(path.join(root, WORK_REL));
  try { fs.rmSync(outAbs, { force: true }); } catch { /* pas de fichier précédent */ }

  const imgBlock = attachImages(task, root, onLog);
  const listing = dirs.map((d) => `- \`${d.dir}/\` → projet **${d.project}**, branche \`${d.branch}\``).join('\n');

  /* Une exploration tourne dans une SESSION reprenable, comme un codage : la question de
     suivi reprend la session au lieu de recoller la réponse précédente dans le prompt.
     L'agent garde ainsi ce qu'il a lu et compris, pas seulement ce qu'il a écrit — sa
     synthèse est un résumé, pas son raisonnement.
     Le handle est celui déjà enregistré sur les cibles (créé au premier run, ou fourni à la
     création), toutes les cibles d'une exploration partageant la MÊME session : le cwd est
     la racine des clones, pas un dépôt en particulier. */
  const sessionable = !copilot.isDryRun() && agentsession.backendName() !== 'unknown';
  const known = targets.find((tg) => tg.session_key) || {};
  let doResume = sessionable && !!known.session_key;
  if (doResume && known.session_cwd && path.resolve(known.session_cwd) !== path.resolve(root)) {
    onLog('⚠ cwd de session différent → reprise refusée, session neuve');
    doResume = false;
  }
  /* La réponse précédente n'est réinjectée que HORS session : elle n'a plus lieu d'être
     quand l'agent s'en souvient, et en dry-run ou sur un backend non reprenable elle reste
     le seul fil de continuité. */
  const prev = (previous && !doResume)
    ? `\n\nTu as déjà produit la réponse suivante :\n"""\n${previous}\n"""\nPrends-la en compte et complète-la selon la nouvelle demande.`
    : '';

  const prompt =
    `Tu explores ${dirs.length} dépôt(s) de code, chacun dans un sous-dossier du répertoire courant :\n${listing}\n\n`
    + `QUESTION : ${question}\n\n`
    + `Explore librement le code de ces dépôts (lecture de fichiers, recherche) pour y répondre.\n`
    + `IMPORTANT : c'est une exploration en LECTURE SEULE — ne modifie, ne crée et ne supprime AUCUN fichier `
    + `dans les dépôts, et ne fais aucun commit.${prev}${imgBlock}\n\n`
    + `Rédige UNE SEULE réponse de synthèse, transversale aux dépôts, en Markdown (français), `
    + `et écris-la UNIQUEMENT dans le fichier \`${outRel}\` (chemin relatif au répertoire courant). `
    + `Ne duplique pas ce contenu sur la sortie standard.`;

  onLog(`exploration (${copilot.isDryRun() ? 'dry-run' : 'IA'}) sur ${dirs.length} dépôt(s)`);
  let stdout = '';
  try {
    if (sessionable) {
      const key = `explore-${task.id}`;
      let created = !doResume;
      let r;
      try {
        r = await agentsession.runInSession({ key, handle: doResume ? known.session_key : null, prompt, cwd: root, resume: doResume, onLog });
      } catch (e) {
        if (!doResume) throw e;
        // Même repli que pour un codage : la session est perdue, pas l'exploration. On
        // réinjecte la réponse précédente, seul contexte dont dispose une session neuve.
        onLog(`⚠ reprise impossible (${String(e.message).split('\n')[0]}) → session neuve, contexte réinjecté`);
        const withPrev = previous
          ? `${prompt}\n\nTu avais déjà produit la réponse suivante :\n"""\n${previous}\n"""`
          : prompt;
        r = await agentsession.runInSession({ key, prompt: withPrev, cwd: root, resume: false, onLog });
        created = true;
      }
      stdout = r.text || '';
      copilot.recordUsage('explore', prompt, stdout);
      // Les cibles d'une exploration partagent la session : toutes portent le même handle.
      if (created) for (const tg of targets) setTarget(tg.id, { session_key: r.handle, session_backend: r.backend, session_cwd: root });
    } else {
      stdout = await copilot.runPrompt(prompt, root, { kind: 'explore' }, onLog);
    }
  } finally {
    // garantie lecture seule : quoi qu'il arrive, on annule toute modification
    for (const d of dirs) {
      await git.resetWorktree(d.cwd, () => {});
    }
    onLog('dépôts remis à zéro (exploration en lecture seule)');
  }

  let content = '';
  if (fs.existsSync(outAbs)) content = fs.readFileSync(outAbs, 'utf8').trim();
  if (content) {
    onLog(`réponse lue depuis ${outRel} (${content.length} octets)`);
    copilot.addOutputToLastUsage(content);
  } else {
    onLog(`(fichier ${outRel} vide/absent → repli sur la sortie standard)`);
    content = (stdout || '').trim() || '_(aucune réponse produite)_';
  }

  const mdPath = path.join(taskDir(task.id), 'exploration.md');
  const header = `# ${question}\n\n> Exploration du ${new Date().toLocaleString('fr-FR')} · ${dirs.map((d) => `${d.project} (\`${d.branch}\`)`).join(' · ')}\n\n---\n\n`;
  fs.writeFileSync(mdPath, header + content, 'utf8');
  /* Chaque question de suivi ÉCRASE `exploration.md`. On archive donc la passe : la
     question posée et la réponse obtenue restent consultables ensuite. `unit_id = 0`
     marque une passe de NIVEAU SESSION — une exploration produit une seule réponse
     transversale aux dépôts, pas une par projet. */
  agentpass.record('task', task.id, 0, { kind: previous ? 'followup' : 'run', prompt: question, text: content });
  db.prepare('UPDATE task SET md_path = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ?')
    .run(mdPath, 'done', new Date().toISOString(), task.id);
  onLog('✅ réponse enregistrée');
  return { mdPath };
}

/* ================= Points d'entrée ================= */

async function runTask(task, onLog = () => {}) {
  if (task.kind === 'explore') {
    return runExploration(task, { question: task.prompt, previous: null, onLog });
  }
  return runCodeTask(task, {
    promptText: buildCodePrompt(task), message: commitMessageFor(task), allowCreate: true, onLog,
  });
}

async function runTaskFollowup(task, instruction, onLog = () => {}) {
  const instr = String(instruction || '').trim();
  if (!instr) throw new Error(t('err.demande-de-suivi-vide'));

  if (task.kind === 'explore') {
    const previous = task.md_path && fs.existsSync(task.md_path) ? fs.readFileSync(task.md_path, 'utf8') : '';
    return runExploration(task, { question: instr, previous, onLog });
  }
  const message = instr.split('\n')[0].slice(0, 72);
  const promptText =
    'Tu travailles sur une branche existante de ce projet ; le travail précédent est déjà '
    + `committé. Applique la demande de suivi ci-dessous en modifiant directement les fichiers.\n\n`
    + `Demande de suivi : ${instr}`;
  return runCodeTask(task, { promptText, message, allowCreate: false, onLog, passKind: 'followup' });
}

// Reprise après réponses de l'utilisateur (ask → stop → resume). Cible UN projet précis :
// la cible qui avait posé des questions, avec ses réponses déjà enregistrées côté serveur.
async function runTaskAnswer(task, targetId, onLog = () => {}) {
  const tg = targetsOf(task.id).find((x) => x.id === Number(targetId));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session-2'));
  const qs = tg.questions_json ? safeParseQuestions(tg.questions_json) : [];
  if (!qs.some((q) => q && q.answer != null && String(q.answer).trim())) {
    throw new Error(t('err.reponses-manquantes'));
  }
  onLog(`──────── ${tg.project} · ${tg.branch} (reprise après réponses) ────────`);
  setTarget(tg.id, { status: 'running', last_error: null });
  const promptText = questions.buildAnswerInstruction(qs);
  try {
    const res = await execOnTarget(task, tg, {
      promptText, message: 'Réponses aux questions de l’agent', allowCreate: false, onLog, resume: true, passKind: 'answer',
    });
    syncTaskStatus(task.id);
    return res; // { needsInput } si l'agent re-pose des questions
  } catch (e) {
    // La reprise a échoué : on marque le projet en erreur (au lieu de le laisser « running »
    // indéfiniment) et on remonte la vraie raison — le formulaire ne réapparaît pas.
    setTarget(tg.id, { status: 'error', last_error: e.message });
    syncTaskStatus(task.id);
    throw e;
  }
}

// Pousse UN projet d'une session (validation manuelle du push).
async function pushTarget(taskId, targetId, onLog = () => {}) {
  const cfg = getConfig();
  const tg = db.prepare(`SELECT tt.*, repo.project, repo.forge FROM task_target tt
    JOIN repo ON repo.id = tt.repo_id WHERE tt.id = ? AND tt.task_id = ?`).get(targetId, taskId);
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session-2'));
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  const cwd = git.cloneDirFor(cfg, repo);
  onLog(`push ${tg.project} : git push -u origin ${tg.branch}`);
  await git.pushBranch(cwd, tg.branch, onLog, git.secretsOf(cfg));
  setTarget(tg.id, { status: 'pushed' });
  syncTaskStatus(taskId);
  onLog('✅ branche poussée');
}

module.exports = {
  runTask, runTaskFollowup, runTaskAnswer, pushTarget, targetsOf, setTarget, syncTaskStatus,
  execOnTarget, buildCodePrompt, commitMessageFor, saveAgentOutput,
};
