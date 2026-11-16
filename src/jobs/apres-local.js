'use strict';
/* Ce qui suit une session hors dépôt qui a commité et poussé : la merge request, puis la convergence.
   Le dossier de l'utilisateur n'est pas un dépôt ENREGISTRÉ — il n'a ni forge ni identifiant dans la table
   `repo`. On le retrouve par son remote `origin` (lu dans `.git/config`, comme le fait l'onglet Liens) :
   la MR et la convergence ne se font que si ce remote est un dépôt que Mergerie connaît. Sinon on le dit
   sur la ligne du dossier (`git_note`) au lieu de deviner — la branche, elle, est déjà poussée.

   La convergence travaille sur le CLONE de Mergerie, à partir de la branche poussée : elle ne touche pas
   au dossier de l'utilisateur, qui reste en retard d'autant de commits (un `git pull` les rapporte). */
const db = require('../db');
const forge = require('../forge');
const localdirs = require('../data/localdirs');
const { getConfig } = require('../data/config');
const { origineDuDossier } = require('../git/origine-dossier');
const verifyLib = require('../verify/verify');
const converge = require('../review/converge');
const discover = require('../notes/discover');
const taskrunner = require('../session/taskrunner');
const localcoder = require('../session/localcoder');
const localgit = require('../session/localgit');
const { t } = require('../core/i18n');

const maintenant = () => new Date().toISOString();
const noter = (id, patch) => {
  const cols = Object.keys(patch);
  db.prepare(`UPDATE local_task_dir SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @u WHERE id = @id`)
    .run({ ...patch, u: maintenant(), id });
};

/** Le dépôt enregistré qui correspond au remote d'un dossier, ou `{ code }` si on ne peut pas dire. */
function depotDuDossier(dirHash) {
  const chemin = localdirs.cheminDe(dirHash);
  const remote = chemin ? origineDuDossier(chemin) : null;
  if (!remote) return { code: 'no-origin' };
  const repo = db.prepare('SELECT * FROM repo').all().find((r) => verifyLib.memeDepot(r.url, remote));
  return repo ? { repo } : { code: 'no-repo' };
}

async function ouvrirMr(task, d, repo, onLog) {
  const cfg = getConfig();
  const client = forge.clientFor(repo);
  const liste = await client.listBranches(cfg, repo.project);
  const defaut = (liste && liste.default) || 'main';
  // La branche d'où le dossier est parti, si la forge la connaît ; sinon la branche par défaut du dépôt.
  const cible = d.base_branch && (liste.branches || []).includes(d.base_branch) ? d.base_branch : defaut;
  const titre = taskrunner.commitMessageFor(task);
  onLog(t('log.converge.mr-create', { branch: d.branch, target: cible }));
  const created = await client.createMergeRequest(cfg, repo.project, { source_branch: d.branch, target_branch: cible, title: titre });
  onLog(t('log.converge.mr-created', { iid: created.iid }));
  noter(d.id, { mr_iid: created.iid, mr_url: created.web_url || null });
  return created.iid;
}

/**
 * Pour chaque dossier poussé : ouvre la MR (si demandée et pas déjà ouverte), puis converge (si demandé).
 * Une erreur sur un dossier est consignée sur SA ligne et n'arrête pas les autres.
 * `converger` (seuil, passes) = « Converger » depuis la carte : MR et convergence sans les cases.
 */
async function publier(taskId, onLog = () => {}, converger = null) {
  const task = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!task || !task.branch || !(task.create_mr || converger)) return;
  const dossiers = db.prepare("SELECT * FROM local_task_dir WHERE task_id = ? AND git_status = 'pushed' ORDER BY id").all(taskId);
  for (const d of dossiers) {
    onLog(`──────── ${d.dir_label || '?'} · ${d.branch} ────────`);
    try {
      const { repo, code } = depotDuDossier(d.dir_hash);
      if (!repo) {
        onLog(t(`log.local.mr-skipped-${code}`, { label: d.dir_label || '?' }));
        noter(d.id, { git_note: code });
        continue;
      }
      noter(d.id, { repo_id: repo.id });
      const iid = d.mr_iid || await ouvrirMr(task, d, repo, onLog);
      noter(d.id, { git_note: null });
      // L'objet complet de l'API (SHA à jour) entre dans la table `mr` : c'est ce que la convergence relit.
      const apiMr = await forge.clientFor(repo).getMergeRequest(getConfig(), repo.project, iid);
      const mrId = await discover.upsertMrFromApi(repo.id, apiMr);
      if (converger || task.converge_after) await converge.convergeRun(mrId, converger || {}, onLog);
    } catch (e) {
      onLog(`⚠ ${d.dir_label || '?'} : ${e.message}`);
      noter(d.id, { git_note: `mr-error: ${String(e.message).split('\n')[0].slice(0, 200)}` });
    }
  }
}

/**
 * « Converger » depuis la carte, avant la boucle : ce qui n'a pas encore été codé l'est (et poussé),
 * ce qui a été codé sans être poussé — auto-push décoché, ou branche ajoutée après coup — est
 * commité sur la branche de la session et poussé. Les dossiers en attente d'une réponse restent là.
 */
async function preparerConvergence(taskId, onLog = () => {}) {
  const task = db.prepare('SELECT * FROM local_task WHERE id = ?').get(taskId);
  if (!task || !task.branch) throw new Error(t('err.local.converge-needs-branch'));
  const aCoder = db.prepare("SELECT id FROM local_task_dir WHERE task_id = ? AND status IN ('new', 'error')").all(taskId).map((d) => d.id);
  if (aCoder.length) await localcoder.runLocal(taskId, onLog, { dirIds: aCoder, pousser: true });
  db.prepare("UPDATE local_task SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?").run(maintenant(), taskId);
  const aPousser = db.prepare(`SELECT * FROM local_task_dir WHERE task_id = ? AND status = 'done'
    AND COALESCE(git_status, '') <> 'pushed' ORDER BY id`).all(taskId);
  for (const d of aPousser) {
    const chemin = localdirs.cheminDe(d.dir_hash);
    if (!chemin) { onLog(`⚠ ${t('err.local-dir-other-machine', { label: d.dir_label || '?', owner: d.owner || '?' })}`); continue; }
    try {
      const g = await localgit.preparer(chemin, task.branch, onLog);
      const r = await localgit.enregistrer(chemin, { branch: task.branch, message: taskrunner.commitMessageFor(task), push: true, sales: g.sales }, onLog);
      noter(d.id, { branch: task.branch, base_branch: g.base || d.base_branch || null, commit_sha: r.sha,
        git_status: r.pushed ? 'pushed' : (r.committed ? 'committed' : 'unchanged'), git_note: null });
    } catch (e) {
      onLog(`⚠ ${d.dir_label || '?'} : ${e.message}`);
      noter(d.id, { git_note: `mr-error: ${String(e.message).split('\n')[0].slice(0, 200)}` });
    }
  }
}

module.exports = { publier, depotDuDossier, preparerConvergence };
