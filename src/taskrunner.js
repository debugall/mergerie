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
const { avecConsignes } = require('./prompts');
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
  if (imgBlock) { imgBlock = `\n\nDes captures d'écran sont fournies (ouvre-les) :${imgBlock}`; onLog(t('log.task.images', { n: images.length, count: images.length })); }
  return imgBlock;
}

/* ---------- Réconcilier l'état affiché avec l'état réel des branches ----------
   Un projet peut échouer APRÈS son commit (push refusé, réseau coupé) : le travail existe dans
   le clone, mais la cible reste « erreur », donc sans diff, sans bouton Pousser ni Créer la MR.
   Relancer la session le réparerait — au prix d'un appel IA par dépôt, pour du travail déjà fait.
   Ici on ne fait que REGARDER : la branche a-t-elle des commits d'avance sur sa base ? Si oui, on
   rétablit l'état qui aurait dû être écrit. Aucun appel IA, et rien n'est maquillé : une branche
   réellement vide reste en erreur. */
async function reconcileTargets(task, onLog = () => {}) {
  const cfg = getConfig();
  const cibles = targetsOf(task.id).filter((tg) => tg.status === 'error');
  if (!cibles.length) { onLog(t('log.task.reconcile-none')); return { repaired: 0, checked: 0 }; }
  let repaired = 0;
  for (const tg of cibles) {
    onLog(`──────── ${tg.project} · ${tg.branch} ────────`);
    try {
      const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
      if (!repo) { onLog(t('log.task.repo-missing')); continue; }
      const cwd = await git.ensureRepo(cfg, repo, onLog);
      await git.ensureCleanWorktree(cwd, onLog);
      const base = tg.base_branch || await git.defaultBranch(cwd);

      /* On ne réaligne JAMAIS sur origin ici : le cas le plus fréquent est justement un commit
         local que le push n'a pas emporté. Se caler sur la branche distante le détruirait. */
      if (await git.refExists(cwd, `refs/heads/${tg.branch}`)) await git.checkoutBranch(cwd, tg.branch, onLog);
      else if (await git.refExists(cwd, `origin/${tg.branch}`)) await git.createBranchFrom(cwd, tg.branch, `origin/${tg.branch}`, onLog);
      else { onLog(t('log.task.branch-nowhere')); continue; }

      const avance = await git.aheadOf(cwd, base);
      if (!avance) { onLog(t('log.task.no-ahead', { base })); continue; }

      const sha = await git.headSha(cwd);
      const diff = await git.branchDiff(cwd, base);
      const dpath = path.join(ensureDir(path.join(taskDir(task.id), String(tg.id))), 'diff.patch');
      fs.writeFileSync(dpath, diff, 'utf8');
      const pousse = await git.isPushed(cwd, tg.branch);
      setTarget(tg.id, {
        base_branch: base, commit_sha: sha, diff_path: dpath,
        push_command: `git push -u origin ${tg.branch}`,
        last_error: null, status: pousse ? 'pushed' : 'committed',
      });
      repaired += 1;
      onLog(t(pousse ? 'log.task.reconcile-pushed' : 'log.task.reconcile-ready', { n: avance, count: avance, base }));
    } catch (e) {
      onLog(t('log.task.project-error', { project: tg.project, message: e.message })); // un projet illisible n'empêche pas les autres
    }
  }
  syncTaskStatus(task.id);
  onLog(t('log.task.reconciled', { done: repaired, total: cibles.length }));
  return { repaired, checked: cibles.length };
}

/* LE MESSAGE RENSEIGNÉ APRÈS COUP DOIT QUAND MÊME S'APPLIQUER. Le geste courant : on lance une
   session, on voit passer un commit mal nommé, on remplit le champ « message de commit » et on
   relance. L'IA constate alors que tout est déjà fait et ne commite RIEN — le commit gardait
   donc son ancien message, et le champ qu'on venait de remplir ne servait à rien. On renomme
   donc le dernier commit, sans toucher à ce qu'il contient.

   SAUF S'IL EST DÉJÀ PARTI : renommer un commit poussé, c'est réécrire une histoire que la
   forge — et peut-être une merge request, et peut-être un collègue — a déjà. On le dit alors,
   plutôt que de le faire en silence ou de se taire ; le geste appartient à qui le lit. */
async function reappliquerMessage(cwd, branch, message, onLog = () => {}) {
  if (await git.refExists(cwd, `origin/${branch}`)) {
    onLog(t('log.task.msg-published', { branch }));
    return 'publie';
  }
  if (!await git.renommerDernierCommit(cwd, message, onLog)) return 'inchange';
  onLog(t('log.task.msg-updated', { message }));
  return 'renomme';
}

/* ================= CODAGE ================= */

/* Prompt de dev et message de commit d'une session : UNE seule définition, partagée
   par la session « normale » (runTask) et la session « convergée » (converge.js).
   Le jour où on affine ce prompt — c'est le cœur produit — les deux chemins suivent. */
function buildCodePrompt(task) {
  const base = avecConsignes('Réalise la tâche de développement suivante dans ce dépôt. '
    + `Modifie directement les fichiers nécessaires.\n\n${task.prompt}`, consignesPermanentes());
  // Option « l'IA peut poser des questions » : on ajoute la consigne du bloc <<<QUESTIONS>>>.
  return task && task.ask_questions ? base + questions.QUESTIONS_INSTRUCTION : base;
}

/* Relues à CHAQUE prompt et non mises en cache : on les change en réglages parce qu'on vient de
   voir ce qui manquait, et la session suivante doit en tenir compte sans redémarrer l'outil. */
const consignesPermanentes = () => getConfig().ai_extra_instructions;
/* LE CHAMP « MESSAGE DE COMMIT » VAUT POUR TOUTE LA SESSION. Renseigné, il est la règle : le
   premier run, un suivi, la reprise après questions et les passes de convergence commitent tous
   sous ce message. C'est la demande de qui préfixe ses commits — une clé de ticket, une
   convention d'équipe : un suivi qui repartirait sur sa propre première ligne casserait la règle
   au moment précis où l'on ne relit pas, et le commit fautif est déjà poussé.

   Laissé vide, chaque geste garde son défaut, qui dit ce qu'il vient de faire (`defaut`) ou, à
   défaut de défaut, la première ligne du prompt. */
function commitMessageFor(task, defaut) {
  const choisi = task && task.commit_message && task.commit_message.trim();
  if (choisi) return choisi;
  if (defaut) return defaut;
  return (((task && task.prompt) || '').split('\n')[0] || '').slice(0, 72);
}

// Exécute le prompt sur UN projet : place la branche, laisse l'IA modifier, commite.
// La branche de base n'est pas saisie : c'est la branche par défaut du dépôt.
/* `promptRepli` : ce qu'on envoie quand la session à reprendre s'avère introuvable et qu'il
   faut repartir de zéro. Ce n'est PAS toujours `promptText` : une demande de suivi (« applique
   cette correction ») ne se comprend pas sans la tâche d'origine, que la session perdue
   portait. Le défaut réinjecte donc ce contexte — mais un premier run le contient déjà, et le
   lui ajouter enverrait deux fois la même consigne, prompt de la tâche compris. */
async function execOnTarget(task, tg, { promptText, promptRepli, message, allowCreate, onLog, forcePush, resume, passKind }) {
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
  /* ON NE SE RÉALIGNE PAS SUR ORIGIN QUAND LE LOCAL PORTE DU TRAVAIL. Sans auto-push — le
     défaut —, un suivi commite sans pousser : la branche locale est alors le SEUL endroit où
     ce commit existe. Repartir de `origin/<branche>` le supprimait, et le journal disait
     « alignement ». Le suivi suivant recodait sur une branche amputée, et la branche poussée
     ensuite ne portait plus la première correction.

     Divergence des deux côtés (quelqu'un a poussé pendant ce temps) : on garde quand même le
     local. Le push refusera en fast-forward — un échec qui se voit et se répare —, là où
     l'écrasement, lui, ne se voit jamais. `reconcileTargets` applique déjà cette règle. */
  const nonPousses = hasLocal && hasRemote ? await git.nonPousses(cwd, tg.branch) : 0;
  if (hasLocal && (!hasRemote || nonPousses)) {
    onLog(nonPousses
      ? t('log.task.branch-keep', { branch: tg.branch, n: nonPousses, count: nonPousses })
      : t('log.task.branch-local', { branch: tg.branch }));
    await git.checkoutBranch(cwd, tg.branch, onLog);
  } else if (hasRemote) {
    onLog(t('log.task.branch-remote', { branch: tg.branch }));
    await git.createBranchFrom(cwd, tg.branch, `origin/${tg.branch}`, onLog);
  } else if (allowCreate) {
    onLog(t('log.task.branch-create', { branch: tg.branch, base }));
    await git.createBranchFrom(cwd, tg.branch, `origin/${base}`, onLog);
  } else {
    throw new Error(t('err.branch-missing-run-first', { branch: tg.branch }));
  }

  const imgBlock = attachImages(task, cwd, onLog);

  onLog(t('log.task.run', { mode: copilot.isDryRun() ? 'dry-run' : t('log.mode.ai') }));
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
      onLog(t('log.task.cwd-mismatch'));
      doResume = false;
    }
    let r; let created = !doResume; // création = 1re passe OU repli après échec de reprise
    let note = null;
    try {
      r = await agentsession.runInSession({ key, handle: doResume ? tg.session_key : null, prompt: promptText + imgBlock, cwd, resume: doResume, onLog });
    } catch (e) {
      if (!doResume) throw e;
      // Fallback (§4.5) : reprise impossible → session neuve avec contexte réinjecté.
      const raison = String(e.message).split('\n')[0];
      onLog(t('log.task.resume-failed', { raison }));
      /* On CONSIGNE le repli. Cas le plus courant : une session d'agent appartient au
         répertoire où elle a été créée, or Mergerie travaille dans son propre clone — un
         identifiant venu d'ailleurs (ton dépôt à toi, une session Claude Code) n'y existe
         pas. Sans cette note, l'écran affiche après coup un identifiant que l'utilisateur
         n'a jamais saisi, sans rien dire de la substitution. */
      note = `${tg.session_key} : ${raison}`;
      const complet = promptRepli != null ? promptRepli : `${buildCodePrompt(task)}\n\n${promptText}`;
      r = await agentsession.runInSession({ key, prompt: complet + imgBlock, cwd, resume: false, onLog });
      created = true;
    }
    agentText = r.text || '';
    copilot.recordUsage('task', promptText + imgBlock, agentText); // le run en session compte aussi
    // La note est posée AVEC le nouveau handle, et effacée dès qu'une reprise réussit.
    if (created) setTarget(tg.id, { session_key: r.handle, session_backend: r.backend, session_cwd: cwd, session_note: note });
    else if (tg.session_note) setTarget(tg.id, { session_note: null });
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
      onLog(t('log.task.questions', { n: qs.length, count: qs.length }));
      return { needsInput: true };
    }
  }

  onLog(`commit : ${message}`);
  const committed = await git.commitAll(cwd, message, onLog);
  if (!committed) {
    /* « Rien à committer » recouvre deux situations opposées, et les confondre coûtait cher :
       la branche peut DÉJÀ porter le travail. C'est le cas d'une relance après un échec
       survenu APRÈS le commit (un push refusé, par exemple) : l'IA repasse, constate que tout
       est fait, ne touche à rien — et la session repartait en erreur, sans diff ni bouton
       « Créer la MR », alors que le code est là et prêt. On regarde donc l'état réel de la
       branche avant de conclure. */
    const dejaFait = await git.aheadOf(cwd, base);
    if (!dejaFait) {
      // Branche vide : là, l'IA a bien répondu au lieu de coder (prompt incomplet). On REMONTE
      // sa réponse pour que l'erreur soit parlante.
      const said = String(agentText || '').trim();
      throw new Error(said
        ? t('err.no-change-agent-said', { said: said.slice(0, 500) })
        : t('err.aucun-changement-produit-rien-a'));
    }
    onLog(t('log.task.already-done', { n: dejaFait, count: dejaFait, base }));
    await reappliquerMessage(cwd, tg.branch, message, onLog);
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
    onLog(t('log.task.pushed'));
  } else {
    onLog(t('log.task.commit-ready'));
  }
}

// Session de codage : chaque projet est traité l'un après l'autre. Un projet en échec
// n'interrompt pas les suivants — son erreur est consignée sur SA ligne.
async function runCodeTask(task, { promptText, promptRepli, message, allowCreate, onLog, passKind, targetIds }) {
  /* `targetIds` restreint la passe à certains projets. Une session multi-dépôts se relançait
     forcément EN ENTIER : sur dix dépôts dont six ont réussi, cela coûtait six appels IA pour
     refaire un travail bon, et faisait repasser l'agent sur du code qu'on ne voulait plus voir
     toucher. Vide ou absent = tous les projets, comportement d'origine. */
  const tous = targetsOf(task.id);
  const voulus = Array.isArray(targetIds) && targetIds.length ? targetIds.map(Number) : null;
  const targets = voulus ? tous.filter((tg) => voulus.includes(tg.id)) : tous;
  if (!tous.length) throw new Error(t('err.aucun-projet-selectionne-pour-cette'));
  if (!targets.length) throw new Error(t('err.projet-introuvable-pour-cette-session-2'));
  let ok = 0; let waiting = 0; const fails = [];
  for (const tg of targets) {
    onLog(`──────── ${tg.project} · ${tg.branch} ────────`);
    setTarget(tg.id, { status: 'running', last_error: null });
    try {
      const r = await execOnTarget(task, tg, { promptText, promptRepli, message, allowCreate, onLog, passKind });
      if (r && r.needsInput) waiting += 1; else ok += 1;
    } catch (e) {
      setTarget(tg.id, { status: 'error', last_error: e.message });
      fails.push({ project: tg.project, error: e.message });
      onLog(t('log.task.project-error', { project: tg.project, message: e.message }));
    }
  }
  syncTaskStatus(task.id);
  const portee = voulus ? t('log.task.scope', { n: tous.length }) : '';
  onLog(t('log.task.done', {
    ok, total: targets.length, portee, attente: waiting ? t('log.task.waiting', { n: waiting }) : '',
  }));
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
    onLog(`──────── ${tg.project} · ${tg.branch || t('log.task.default-branch')} ────────`);
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
      onLog(t('log.task.project-error', { project: tg.project, message: e.message }));
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
    onLog(t('log.explore.cwd-mismatch'));
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

  onLog(t('log.explore.run', { mode: copilot.isDryRun() ? 'dry-run' : t('log.mode.ai'), n: dirs.length, count: dirs.length }));
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
        onLog(t('log.task.resume-failed', { raison: String(e.message).split('\n')[0] }));
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
    onLog(t('log.explore.reset'));
  }

  let content = '';
  if (fs.existsSync(outAbs)) content = fs.readFileSync(outAbs, 'utf8').trim();
  if (content) {
    onLog(t('log.explore.answer-read', { path: outRel, n: content.length }));
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
  onLog(t('log.explore.answer-saved'));
  return { mdPath };
}

/* ================= Points d'entrée ================= */

async function runTask(task, onLog = () => {}, opts = {}) {
  if (task.kind === 'explore') {
    return runExploration(task, { question: task.prompt, previous: null, onLog });
  }
  return runCodeTask(task, {
    // Premier run : le prompt porte déjà toute la tâche, il n'y a rien à réinjecter par-dessus.
    promptText: buildCodePrompt(task), promptRepli: buildCodePrompt(task),
    message: commitMessageFor(task), allowCreate: true, onLog,
    targetIds: opts.targetIds,
  });
}

// `targetIds` : correction limitée à certains projets d'une session multi-dépôts. Une
// remarque porte presque toujours sur UN dépôt ; la passer à tous refait du travail bon.
async function runTaskFollowup(task, instruction, onLog = () => {}, { targetIds } = {}) {
  const instr = String(instruction || '').trim();
  if (!instr) throw new Error(t('err.demande-de-suivi-vide'));

  if (task.kind === 'explore') {
    const previous = task.md_path && fs.existsSync(task.md_path) ? fs.readFileSync(task.md_path, 'utf8') : '';
    return runExploration(task, { question: instr, previous, onLog });
  }
  const message = commitMessageFor(task, instr.split('\n')[0].slice(0, 72));
  const promptText = avecConsignes(
    'Tu travailles sur une branche existante de ce projet ; le travail précédent est déjà '
    + `committé. Applique la demande de suivi ci-dessous en modifiant directement les fichiers.\n\n`
    + `Demande de suivi : ${instr}`, consignesPermanentes());
  return runCodeTask(task, { promptText, message, allowCreate: false, onLog, passKind: 'followup', targetIds });
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
  onLog(`──────── ${tg.project} · ${tg.branch} (${t('log.task.after-answers')}) ────────`);
  setTarget(tg.id, { status: 'running', last_error: null });
  const promptText = avecConsignes(questions.buildAnswerInstruction(qs), consignesPermanentes());
  try {
    const res = await execOnTarget(task, tg, {
      promptText, message: commitMessageFor(task, t('log.task.answers-commit')),
      allowCreate: false, onLog, resume: true, passKind: 'answer',
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
  onLog(t('log.task.pushed'));
}

/* Pousse PLUSIEURS projets d'une session en un seul job. Un projet en échec n'interrompt pas
   les autres — c'est la règle de tout ce qui est multi-dépôts ici : sur dix branches, une
   permission refusée sur la troisième ne doit pas laisser les sept dernières non poussées. */
async function pushTargets(task, targetIds, onLog = () => {}) {
  const voulus = new Set((targetIds || []).map(Number));
  const cibles = targetsOf(task.id).filter((tg) => voulus.has(tg.id));
  if (!cibles.length) throw new Error(t('err.projet-introuvable-pour-cette-session-2'));
  let ok = 0; const echecs = [];
  for (const tg of cibles) {
    onLog(`──────── ${tg.project} · ${tg.branch} ────────`);
    try { await pushTarget(task.id, tg.id, onLog); ok += 1; }
    catch (e) {
      setTarget(tg.id, { last_error: e.message });
      echecs.push(tg.project);
      onLog(t('log.task.project-error', { project: tg.project, message: e.message }));
    }
  }
  syncTaskStatus(task.id);
  onLog(t('log.task.pushed-n', { ok, total: cibles.length, echecs: echecs.length ? t('log.task.push-failed', { liste: echecs.join(', ') }) : '' }));
  return { pushed: ok, failed: echecs.length };
}

module.exports = {
  reconcileTargets, pushTargets,
  runTask, runTaskFollowup, runTaskAnswer, pushTarget, targetsOf, setTarget, syncTaskStatus,
  execOnTarget, buildCodePrompt, commitMessageFor, saveAgentOutput, reappliquerMessage,
};
