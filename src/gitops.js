'use strict';
/* Opérations Git multi-dépôts (onglet Git).

   Deux temps, toujours : on PRÉVISUALISE, puis on EXÉCUTE. L'aperçu détecte à
   l'avance ce qui échouerait (ref absente, déjà existante, protégée) au lieu de
   le découvrir au milieu d'une série de dépôts.

   Les écritures passent par l'API GitLab et non par le clone : atomiques, sans
   état local à synchroniser, et une ref protégée est refusée proprement.

   Pour les suppressions, un `git fetch` PRÉALABLE est fait dans le clone local.
   Ce n'est pas une précaution de confort : c'est ce qui rend la restauration
   réellement possible. Le serveur GitLab finit par passer son ramasse-miettes sur
   les objets devenus inatteignables ; une fois passé, seuls les objets présents
   dans un clone permettent encore de reconstituer la branche. */

const db = require('./db');
const forge = require('./forge');
const git = require('./git');
const demoGit = require('./demo-git');
const { getConfig } = require('./config');
const { t } = require('../public/i18n-runtime.js');

const ACTIONS = ['new_branch', 'delete_branch', 'create_tag', 'delete_tag'];
const isDestructive = (a) => a === 'delete_branch' || a === 'delete_tag';
const touchesTags = (a) => a === 'create_tag' || a === 'delete_tag';

function repoById(id) {
  return db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(id));
}

/* Un nom de ref valide côté git. On refuse ici plutôt que de laisser l'API
   renvoyer une erreur obscure sur le dixième dépôt. */
function validRefName(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  if (s.length > 200) return false;
  if (/[~^:?*\[\]\\ ]/.test(s)) return false;      // caractères interdits par git
  if (s.startsWith('/') || s.endsWith('/')) return false;
  if (s.startsWith('-') || s.endsWith('.')) return false;
  if (s.includes('..') || s.includes('//') || s.includes('@{')) return false;
  if (s.endsWith('.lock')) return false;
  return true;
}

/* Le nom de la ref à créer peut être donné DEUX fois :
   - une seule fois pour tout le lot (`name`), le cas courant ;
   - ou par projet (`targets[i].name`), quand la convention de nommage diffère d'un
     dépôt à l'autre — un tag `v2.3.0` ici, `api-2026.07` là.
   Le nom du projet gagne quand il est renseigné ; sinon on retombe sur le nom global. */
function nameFor(tg, name) {
  const own = String((tg && tg.name) || '').trim();
  return own || String(name || '').trim();
}

/* Ce que l'aperçu affiche comme commandes.

   ⚠ Distinction importante, et c'est pour ça que les deux champs sont séparés :
   - `real`  : les commandes git RÉELLEMENT exécutées. Il n'y en a qu'une, le fetch
                de sécurité qui précède les suppressions.
   - `equiv` : l'ÉQUIVALENT git de l'écriture, donné pour comprendre ce qui va se
                passer. Il n'est pas exécuté : l'écriture passe par l'API GitLab
                (atomique, et une ref protégée y est refusée proprement).
   Présenter `equiv` comme exécuté serait faux, d'où l'étiquetage distinct côté
   interface. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}
function commandsFor(action, row, name, message) {
  const real = [];
  const gh = forge.forgeOf(row) === 'github';
  // Chemin d'API affiché : celui de la forge du dépôt (information, pas exécution).
  const base = gh ? `/repos/${row.project}/git/refs` : `/projects/${encodeURIComponent(row.project)}/repository/`;
  const api = { path: base, method: 'POST' };
  let equiv = '';
  if (action === 'new_branch') {
    equiv = `git push origin ${row.ref}:refs/heads/${name}`;
    if (!gh) api.path += 'branches';
    api.method = 'POST';
  } else if (action === 'create_tag') {
    equiv = message && message.trim()
      ? `git tag -a ${name} ${row.ref} -m ${shellQuote(message.trim())} && git push origin refs/tags/${name}`
      : `git push origin ${row.ref}:refs/tags/${name}`;
    if (!gh) api.path += 'tags';
    api.method = 'POST';
  } else if (action === 'delete_branch') {
    real.push('git fetch --prune --tags origin');      // filet de sécurité, réel
    equiv = `git push origin --delete ${row.ref}`;
    api.path += gh ? `/heads/${row.ref}` : `branches/${encodeURIComponent(row.ref)}`;
    api.method = 'DELETE';
  } else if (action === 'delete_tag') {
    real.push('git fetch --prune --tags origin');
    equiv = `git push origin --delete refs/tags/${row.ref}`;
    api.path += gh ? `/tags/${row.ref}` : `tags/${encodeURIComponent(row.ref)}`;
    api.method = 'DELETE';
  }
  return { real, equiv, api: `${api.method} ${api.path}` };
}

/* Aperçu : une ligne par (projet, ref). Ne modifie RIEN. */
async function preview({ action, targets, name, message }) {
  if (!ACTIONS.includes(action)) throw new Error(t('err.git.unknown-action'));
  const cfg = getConfig();
  const creating = action === 'new_branch' || action === 'create_tag';
  if (!Array.isArray(targets) || !targets.length) throw new Error(t('err.git.no-target'));
  // Chaque ligne est validée avec LE nom qui la concerne, et l'erreur DIT lequel :
  // avec dix lignes et dix champs, « nom de ref invalide » sans le projet fautif
  // laisse l'utilisateur relire ses dix saisies.
  if (creating) {
    for (const tg of targets) {
      const nm = nameFor(tg, name);
      if (validRefName(nm)) continue;
      const r = repoById(tg.repo_id);
      throw new Error(t('err.git.invalid-name-for', { project: (r && r.project) || tg.repo_id, name: nm }));
    }
  }

  /* Les listings d'un dépôt sont mémoïsés POUR CET APPEL : depuis qu'un nom peut
     être donné par projet, le même dépôt sur plusieurs lignes (trois tags de
     composants d'un monorepo) est un cas normal — sans cache il paierait quatre
     listings paginés complets par ligne, pour des données identiques.
     On mémoïse la PROMESSE : deux lignes du même dépôt partagent l'appel en vol. */
  const listsCache = new Map();
  const listsFor = (repo) => {
    const project = repo.project;
    const api = forge.clientFor(repo);
    // En démo : mêmes formes de données que gitlab.js, mais fictives → toute la logique
    // d'états et de commandes ci-dessous s'applique telle quelle, hors-ligne.
    if (!listsCache.has(project)) {
      listsCache.set(project, demoGit.isDemo()
        ? Promise.resolve(demoGit.listsFor(project))
        : Promise.all([
          api.listBranchesFull(cfg, project),
          touchesTags(action) ? api.listTags(cfg, project) : Promise.resolve([]),
          api.listProtectedBranches(cfg, project),
          touchesTags(action) ? api.listProtectedTags(cfg, project) : Promise.resolve([]),
        ]));
    }
    return listsCache.get(project);
  };

  /* Ce que le lot s'apprête à créer, `projet|nom`. L'existence est vérifiée contre
     le dépôt DISTANT, qui ignore évidemment les lignes précédentes du lot : sans
     cette mémoire, deux lignes portant le même nom passeraient toutes deux au vert
     et la seconde échouerait à l'écriture — exactement ce que l'aperçu doit éviter. */
  const planned = new Set();

  const rows = [];
  for (const tg of targets) {
    const repo = repoById(tg.repo_id);
    if (!repo) continue;
    const line = { repo_id: repo.id, project: repo.project, forge: forge.forgeOf(repo) };
    try {
      const [branches, tags, protBranches, protTags] = await listsFor(repo);
      const defBranch = (branches.find((b) => b.default) || {}).name || null;

      if (creating) {
        // On crée : la ref choisie est la SOURCE, `nm` est ce qu'on fabrique.
        const nm = nameFor(tg, name);
        const src = branches.find((b) => b.name === tg.ref);
        const exists = action === 'new_branch'
          ? branches.some((b) => b.name === nm)
          : tags.some((x) => x.name === nm);
        if (!src) { rows.push({ ...line, ref: tg.ref, target: nm, state: 'missing_source' }); continue; }
        if (exists) { rows.push({ ...line, ref: tg.ref, target: nm, sha: src.sha, state: 'exists' }); continue; }
        // Le doublon se juge en DERNIER : une ligne déjà bloquée n'écrira rien, elle
        // ne « réserve » donc pas le nom pour les suivantes.
        const dupKey = `${repo.project}|${nm}`;
        if (planned.has(dupKey)) { rows.push({ ...line, ref: tg.ref, target: nm, sha: src.sha, state: 'duplicate' }); continue; }
        planned.add(dupKey);
        rows.push({ ...line, ref: tg.ref, target: nm, sha: src.sha, state: 'ok' });
      } else {
        // On supprime : chaque ref sélectionnée est une ligne à part entière.
        const wanted = Array.isArray(tg.refs) ? tg.refs : (tg.ref ? [tg.ref] : []);
        if (!wanted.length) { rows.push({ ...line, ref: null, state: 'nothing_selected' }); continue; }
        for (const rname of wanted) {
          const base = { ...line, ref: rname };
          if (action === 'delete_branch') {
            const b = branches.find((x) => x.name === rname);
            if (!b) { rows.push({ ...base, state: 'missing' }); continue; }
            if (b.default || rname === defBranch) { rows.push({ ...base, sha: b.sha, state: 'is_default' }); continue; }
            if (b.protected || protBranches.includes(rname)) { rows.push({ ...base, sha: b.sha, state: 'protected' }); continue; }
            rows.push({ ...base, sha: b.sha, committed_date: b.committed_date, author: b.author, merged: b.merged, state: 'ok' });
          } else {
            const tg2 = tags.find((x) => x.name === rname);
            if (!tg2) { rows.push({ ...base, state: 'missing' }); continue; }
            if (protTags.includes(rname)) { rows.push({ ...base, sha: tg2.sha, state: 'protected' }); continue; }
            rows.push({ ...base, sha: tg2.sha, tag_sha: tg2.target, annotated: tg2.annotated, committed_date: tg2.committed_date, state: 'ok' });
          }
        }
      }
    } catch (e) {
      rows.push({ ...line, ref: tg.ref || null, state: 'error', error: e.message });
    }
  }
  // Les commandes ne sont calculées que pour les lignes qui vont réellement
  // s'exécuter : en afficher sur une ligne bloquée laisserait croire qu'elle passe.
  for (const r of rows) if (r.state === 'ok') r.cmd = commandsFor(action, r, r.target, message);

  return {
    // `name` reste le nom global (vide si chaque projet a le sien) : le nom
    // réellement appliqué à une ligne est toujours `row.target`.
    action, name: creating ? (nameFor({}, name) || null) : null, message: message || '', rows,
    counts: {
      ok: rows.filter((r) => r.state === 'ok').length,
      skipped: rows.filter((r) => r.state === 'exists').length,
      blocked: rows.filter((r) => ['protected', 'is_default', 'missing', 'missing_source', 'error', 'nothing_selected', 'duplicate'].includes(r.state)).length,
    },
  };
}

/* Exécution. Un échec sur un dépôt N'INTERROMPT PAS les autres — même sémantique
   que les sessions de codage multi-projets. */
async function execute({ action, targets, name, message }, onLog = () => {}) {
  const pv = await preview({ action, targets, name, message });
  const cfg = getConfig();
  const creating = action === 'new_branch' || action === 'create_tag';
  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = () => new Date().toISOString();
  const results = [];

  const todo = pv.rows.filter((r) => r.state === 'ok');
  if (!todo.length) { onLog(t('git.log.nothing-to-do')); return { batchId, results: pv.rows }; }

  for (const row of todo) {
    const repo = repoById(row.repo_id);
    let fetched = 0;
    try {
      /* Filet de sécurité AVANT toute suppression : on rapatrie les objets dans
         le clone local. C'est lui qui permettra la restauration même après le
         passage du ramasse-miettes côté serveur. */
      if (isDestructive(action)) {
        onLog(t('git.log.securing', { project: row.project }));
        await git.ensureRepo(cfg, repo, onLog);
        const cwd = git.cloneDirFor(cfg, repo);
        await git.run('git', ['fetch', '--prune', '--tags', 'origin'], { cwd, onLog });
        fetched = 1;
      }

      // `row.target` porte le nom propre à CETTE ligne (global ou par projet).
      const api = forge.clientFor(repo);
      if (action === 'new_branch') await api.createBranch(cfg, row.project, row.target, row.ref);
      else if (action === 'create_tag') await api.createTag(cfg, row.project, row.target, row.ref, message);
      else if (action === 'delete_branch') await api.deleteBranch(cfg, row.project, row.ref);
      else if (action === 'delete_tag') await api.deleteTag(cfg, row.project, row.ref);

      db.prepare(`INSERT INTO git_op
        (batch_id, created_at, action, repo_id, project, ref_name, ref_sha, tag_sha, tag_message, source_ref, status, fetched)
        VALUES (?,?,?,?,?,?,?,?,?,?,'done',?)`)
        .run(batchId, now(), action, row.repo_id, row.project,
          creating ? row.target : row.ref,
          row.sha || null, row.tag_sha || null, message || null,
          creating ? row.ref : null, fetched);
      results.push({ ...row, state: 'done' });
      onLog(t('git.log.done', { project: row.project, ref: creating ? row.target : row.ref }));
    } catch (e) {
      db.prepare(`INSERT INTO git_op
        (batch_id, created_at, action, repo_id, project, ref_name, ref_sha, status, error, fetched)
        VALUES (?,?,?,?,?,?,?,'error',?,?)`)
        .run(batchId, now(), action, row.repo_id, row.project, creating ? row.target : row.ref, row.sha || null, e.message, fetched);
      results.push({ ...row, state: 'error', error: e.message });
      onLog(t('git.log.failed', { project: row.project, error: e.message }));
    }
  }
  // Les lignes non exécutées gardent leur état d'aperçu (existe déjà, protégée…).
  // On identifie les lignes par RÉFÉRENCE et non par un couple (dépôt, ref) : depuis
  // qu'un nom se donne par projet, deux lignes peuvent partager dépôt, ref source ET
  // nom (l'une « ok », l'autre « en double »), et toute clé composée les confondrait.
  const executed = new Set(todo);
  for (const r of pv.rows) if (!executed.has(r)) results.push(r);
  return { batchId, results };
}

/* Restauration d'une suppression. Deux chemins, du plus fiable au moins fiable :
   1. le clone local a encore les objets → on les repousse, ça marche toujours ;
   2. sinon, on tente l'API : elle ne réussit que si le serveur n'a pas encore
      ramassé les objets. On ne le promet donc jamais, on l'essaie. */
async function restore(opId, onLog = () => {}) {
  const op = db.prepare('SELECT * FROM git_op WHERE id = ?').get(Number(opId));
  if (!op) throw new Error(t('err.git.op-not-found'));
  if (!isDestructive(op.action)) throw new Error(t('err.git.not-restorable'));
  if (op.restored_at) throw new Error(t('err.git.already-restored'));
  if (!op.ref_sha) throw new Error(t('err.git.no-sha'));

  const cfg = getConfig();
  const repo = repoById(op.repo_id);
  const isTag = op.action === 'delete_tag';
  const refPath = isTag ? `refs/tags/${op.ref_name}` : `refs/heads/${op.ref_name}`;

  let ok = false; let via = '';
  if (repo) {
    try {
      // `origin` porte déjà les identifiants (posés par ensureRepo au clonage) :
      // inutile de reconstruire une URL authentifiée, et rien à masquer dans le log.
      await git.ensureRepo(cfg, repo, onLog);
      const cwd = git.cloneDirFor(cfg, repo);
      await git.run('git', [...git.gitTlsArgs(), 'push', 'origin', `${op.ref_sha}:${refPath}`],
        { cwd, onLog, redactSecrets: git.secretsOf(cfg) });
      ok = true; via = 'clone';
    } catch (e) { onLog(t('git.log.restore-local-failed', { error: e.message })); }
  }
  if (!ok) {
    // Repli : l'API accepte un SHA comme point de départ, mais seulement tant que
    // l'objet existe encore côté serveur.
    const api = forge.clientFor(repo);
    if (isTag) await api.createTag(cfg, op.project, op.ref_name, op.ref_sha, op.tag_message || '');
    else await api.createBranch(cfg, op.project, op.ref_name, op.ref_sha);
    ok = true; via = 'api';
  }
  db.prepare('UPDATE git_op SET restored_at = ? WHERE id = ?').run(new Date().toISOString(), op.id);
  return { restored: true, via, ref: op.ref_name, project: op.project };
}

module.exports = { ACTIONS, preview, execute, restore, isDestructive, validRefName };
