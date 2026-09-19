'use strict';
/* L’onglet Git : la palette de commandes, l’exécution multi-dépôts, l’explorateur de branches, les branches de MR mergées, les opérations restaurables, et ce qu’une branche sait dire de son auteur.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const gitops = require('../../git/gitops');
const gitgraph = require('../../git/gitgraph');
const jobs = require('../../jobs');
const forge = require('../../forge');
const git = require('../../git/git');
const demoGit = require('../../demo/git');
const demoDocker = require('../../demo/docker');
const aisession = require('../../agent/aisession');
const localrepos = require('../../git/localrepos');
const { wrap } = require('../http');
const { cacheExplorateur, crypto, nommerBranches, refUrl } = require('../lib/branches');
const { rememberMergeOpts } = require('../lib/merge');

/* ---------- Commandes Git (palette + exécution multi-projets) ---------- */
const DEMO_GIT_COMMANDS = [
  { id: 1, label: 'Récupérer tout (fetch)', command: 'fetch --all --prune', sort_order: 0 },
  { id: 2, label: 'Statut court', command: 'status --short --branch', sort_order: 1 },
  { id: 3, label: 'Tirer (fast-forward only)', command: 'pull --ff-only', sort_order: 2 },
  { id: 4, label: '10 derniers commits', command: 'log --oneline -10', sort_order: 3 },
];
// Palette (Réglages → Git) : CRUD. Le `command` = arguments git figés (sans le mot « git »).
app.get('/api/git-commands', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json(DEMO_GIT_COMMANDS);
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command ORDER BY sort_order, id').all());
}));
app.post('/api/git-commands', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  const label = String((req.body && req.body.label) || '').trim();
  const command = String((req.body && req.body.command) || '').trim();
  if (!label || !command) throw new Error(t('err.gitcmd.label-command-required'));
  // Le même filtre qu'à l'exécution : une entrée de palette refusée ne s'enregistre pas.
  localrepos.assertSafeGitArgs(localrepos.parseGitArgs(command));
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM git_command').get().m;
  const info = db.prepare('INSERT INTO git_command (label, command, sort_order, created_at) VALUES (?, ?, ?, ?)')
    .run(label, command, max + 1, new Date().toISOString());
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command WHERE id = ?').get(info.lastInsertRowid));
}));
app.put('/api/git-commands/:id', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  const cur = db.prepare('SELECT * FROM git_command WHERE id = ?').get(Number(req.params.id));
  if (!cur) throw new Error(t('err.gitcmd.unknown'));
  const label = String((req.body && req.body.label) != null ? req.body.label : cur.label).trim();
  const command = String((req.body && req.body.command) != null ? req.body.command : cur.command).trim();
  if (!label || !command) throw new Error(t('err.gitcmd.label-command-required'));
  localrepos.assertSafeGitArgs(localrepos.parseGitArgs(command));
  db.prepare('UPDATE git_command SET label = ?, command = ? WHERE id = ?').run(label, command, cur.id);
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command WHERE id = ?').get(cur.id));
}));
app.delete('/api/git-commands/:id', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  db.prepare('DELETE FROM git_command WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
// Exécute la commande git à la racine de chaque projet local sélectionné → bilan par projet.
app.post('/api/git-run', wrap(async (req, res) => {
  const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
  const command = String((req.body && req.body.command) || '');
  res.json(await localrepos.runCommand(targets, command));
}));
// Aperçu : ne modifie rien, sert de confirmation.
/* ---------- B7 : les branches des merge requests mergées ----------
   Fin de sprint, trente branches mortes dans quatre dépôts : on les supprimait une à une dans
   l'interface de la forge, ou on les laissait pourrir. Elles sont TOUTES connues ici — une
   merge request vue fermée porte sa branche source. On rend la liste, groupée par dépôt ;
   l'écran la charge dans le lot de suppression, et c'est l'APERÇU habituel qui dit, branche
   par branche, si elle existe encore, si elle est protégée et si c'est sûr. Rien n'est
   supprimé sans passer par là. */
app.get('/api/git/merged-branches', wrap((req, res) => {
  const rows = db.prepare(`SELECT mr.repo_id, repo.project, mr.source_branch AS branch,
      COUNT(*) AS n, MAX(mr.iid) AS iid
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE mr.closed_seen = 1 AND mr.source_branch IS NOT NULL AND mr.source_branch != ''
      AND repo.enabled = 1
      /* Une branche encore portée par une merge request OUVERTE n'est pas morte : deux merge
         requests ont pu se succéder sur la même branche. */
      AND NOT EXISTS (SELECT 1 FROM mr m2 WHERE m2.repo_id = mr.repo_id
        AND m2.source_branch = mr.source_branch AND (m2.closed_seen IS NULL OR m2.closed_seen = 0))
    GROUP BY mr.repo_id, mr.source_branch
    ORDER BY repo.project, mr.source_branch`).all();
  const parDepot = new Map();
  for (const r of rows) {
    if (!parDepot.has(r.repo_id)) parDepot.set(r.repo_id, { repo_id: r.repo_id, project: r.project, refs: [] });
    parDepot.get(r.repo_id).refs.push({ name: r.branch, iid: r.iid });
  }
  res.json({ total: rows.length, repos: [...parDepot.values()] });
}));
app.post('/api/git/preview', wrap(async (req, res) => {
  res.json(await gitops.preview(req.body || {}));
}));
// Exécution : passe par la file de jobs, car le fetch de sécurité qui précède
// chaque suppression peut être long (clonage initial d'un gros dépôt).
app.post('/api/git/execute', wrap(async (req, res) => {
  // En démo, les écritures sont purement décoratives : on ne touche à rien (pas de job).
  if (demoGit.isDemo()) return res.json({ demo: true });
  res.json(jobs.startGitJob(req.body || {}));
}));
// Historique, avec ce qu'il faut pour proposer la restauration.
app.get('/api/git/ops', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM git_op ORDER BY id DESC LIMIT 200').all();
  res.json(rows.map((o) => ({
    ...o,
    restorable: gitops.isDestructive(o.action) && o.status === 'done' && !!o.ref_sha && !o.restored_at,
  })));
}));
app.post('/api/git/ops/:id/restore', wrap(async (req, res) => {
  res.json(jobs.startGitJob({ restoreOpId: Number(req.params.id) }));
}));
app.get('/api/git/branches', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  if (demoGit.isDemo()) return res.json(demoGit.branches(repo.project, repo.id));
  const cfg = getConfig();
  const [branches, mrs, tags] = await Promise.all([
    forge.clientFor(repo).listBranchesFull(cfg, repo.project),
    forge.clientFor(repo).listAllMRs(cfg, repo.project).catch(() => []),
    forge.clientFor(repo).listTags(cfg, repo.project).catch(() => []),
  ]);
  const defaultBranch = (branches.find((b) => b.default) || {}).name || 'main';
  await git.ensureRepo(cfg, repo, () => {});
  const cwd = git.cloneDirFor(cfg, repo);
  await gitgraph.fetchRepo(cwd, () => {});
  /* A33 — L'ANALYSE EST MISE EN CACHE, PAR ÉTAT DU DÉPÔT. Elle est quadratique en processus
     git (`merge-base` de chaque branche contre chaque candidate) : sur un dépôt à deux cents
     branches, rouvrir l'explorateur coûtait des dizaines de secondes pour un résultat
     IDENTIQUE — rien n'a bougé entre deux clics. La clé est l'empreinte des sommets : dès
     qu'une branche avance, apparaît ou disparaît, elle change et l'analyse repart. Un cache
     daté aurait menti dans l'autre sens (périmé alors que rien n'a changé, ou l'inverse). */
  const empreinte = crypto.createHash('sha1')
    .update(branches.map((b) => `${b.name}:${b.sha}`).sort().join('\n'))
    .digest('hex');
  let rows = cacheExplorateur.get(repo.id);
  if (!rows || rows.empreinte !== empreinte) {
    rows = { empreinte, lignes: await gitgraph.analyzeBranches(cwd, { branches, defaultBranch, mrs }) };
    cacheExplorateur.set(repo.id, rows);
  }
  rows = rows.lignes.map((r) => ({ ...r }));   // copie : `nommerBranches` annote, sans polluer le cache
  // Tags triés par date de création décroissante. GitLab n'expose pas de date de
  // création de tag distincte : on trie sur committed_date (date du commit pointé),
  // le meilleur proxy disponible — exact pour un tag léger, très proche pour un annoté.
  const tagsSorted = tags.slice().sort((a, b) => (Date.parse(b.committed_date || 0) || 0) - (Date.parse(a.committed_date || 0) || 0));
  // Branche(s) portant chaque tag (commit contenu). Local, best-effort ; borné pour
  // ne pas transformer un dépôt à millier de tags en millier de « git branch --contains ».
  await Promise.all(tagsSorted.slice(0, 200).map(async (tg) => {
    tg.branches = await git.branchesForCommit(cwd, tg.sha, defaultBranch);
  }));
  nommerBranches(repo.id, rows);
  res.json({ project: repo.project, repo_id: repo.id, forge: forge.forgeOf(repo), default: defaultBranch, branches: rows, tags: tagsSorted });
}));
// Auteur PRÉCIS d'un tag, à la demande (l'API GitLab n'expose pas le tagger d'un tag
// annoté). Lu dans le clone local via git ; le clone est déjà présent quand on est
// dans l'explorateur, on le (re)fetch au besoin.
app.get('/api/git/tag-author', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const tag = String(req.query.tag || '').trim();
  if (!tag || /[\s\x00-\x1f~^:?*[\\]/.test(tag)) throw new Error(t('err.tag-invalide'));
  if (demoGit.isDemo()) return res.json(demoGit.tagAuthor(repo.project, tag));
  const cwd = await git.ensureRepo(getConfig(), repo, () => {});
  res.json(await git.tagAuthor(cwd, tag));
}));
app.get('/api/git/find-ref', wrap(async (req, res) => {
  const cfg = getConfig();
  const name = String(req.query.name || '').trim();
  if (!name) throw new Error(t('err.ref-name-required'));
  const type = ['branch', 'tag'].includes(req.query.type) ? req.query.type : 'both';
  const kinds = type === 'both' ? ['branch', 'tag'] : [type];
  if (demoGit.isDemo()) return res.json(demoGit.findRef(name, type, db.prepare('SELECT id, project FROM repo WHERE enabled = 1').all()));
  if (!forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) throw new Error(t('err.aucune-forge-configuree'));
  const repos = db.prepare('SELECT * FROM repo WHERE enabled = 1').all();
  const results = await Promise.all(repos.map(async (r) => {
    const matches = [];
    let error = null;
    for (const kind of kinds) {
      try {
        const ref = await forge.clientFor(r).getRef(cfg, r.project, kind, name);
        if (ref) matches.push({
          kind,
          sha: (ref.commit && (ref.commit.short_id || String(ref.commit.id).slice(0, 8))) || '',
          fullSha: (ref.commit && ref.commit.id) || '',
          date: (ref.commit && ref.commit.committed_date) || null,
          author: (ref.commit && ref.commit.author_name) || '',
          url: forge.refUrl(cfg, r, kind, name),
        });
      } catch (e) { error = String(e.message).slice(0, 200); }
    }
    // Pour un tag trouvé, on renseigne aussi la (les) branche(s) qui le portent — via le
    // clone local, comme dans l'explorateur. Best-effort : ne bloque jamais le résultat.
    const tagMatch = matches.find((m) => m.kind === 'tag');
    if (tagMatch && tagMatch.fullSha) {
      try {
        const cwd = await git.ensureRepo(cfg, r, () => {});
        tagMatch.branches = await git.branchesForCommitDetailed(cwd, tagMatch.fullSha);
      } catch { /* clone injoignable : on garde le tag sans sa branche */ }
    }
    matches.forEach((m) => { delete m.fullSha; });
    return { project: r.project, repo_id: r.id, matches, error };
  }));
  res.json({ name, type, repos: results });
}));
// Banc d'essai « reprise de session IA » (Réglages → AI sessions). Enchaîne deux passes
// dans la même session d'agent pour vérifier que la reprise conserve le contexte. Appel
// direct (hors file de jobs) : c'est un diagnostic manuel, lancé à la demande.
app.post('/api/ai-sessions/test', wrap(async (req, res) => {
  const logs = [];
  const result = await aisession.runSessionTest((m) => logs.push(m));
  res.json({ ...result, logs });
}));
// Création d'une MR depuis l'explorateur : générique (pas liée à une session).
// La même mécanique que Dev IA — titre + création via l'API GitLab — mais entre
// une branche et sa branche source (déduite dans l'explorateur), pas un task_target.
app.post('/api/git/mr', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.body && req.body.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const source = String(req.body.source || '').trim();
  const target = String(req.body.target || '').trim();
  const title = String(req.body.title || '').trim() || source;
  if (!source || !target) throw new Error(t('err.git.mr-missing-refs'));
  if (source === target) throw new Error(t('err.git.mr-same-ref'));
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const mr = await forge.clientFor(repo).createMergeRequest(getConfig(), repo.project, {
    source_branch: source, target_branch: target, title, squash, removeSourceBranch,
  });
  rememberMergeOpts(repo.id, mr.iid, squash, removeSourceBranch);
  res.json({ iid: mr.iid, url: mr.web_url });
}));
// La langue est posée avant la première requête : les messages d’erreur du serveur
// sont de l’interface, ils doivent sortir dans la bonne langue dès le démarrage.
i18n.setLang(getConfig().language);
/* CE QUE L'ARRÊT PRÉCÉDENT A COUPÉ EN PLEIN VOL. Les jobs ont été marqués `interrupted` au
   chargement de la base ; les sessions et vérifications qu'ils portaient, elles, seraient
   restées « en cours » à jamais — sans bouton pour repartir ni pour arrêter. On le fait ici,
   après `setLang`, pour que la raison inscrite sur la carte sorte dans la bonne langue. */
{
  const repris = db.reconcilierTravauxCoupes(t('err.interrompu-par-arret'));
  const total = repris.sessions + repris.horsDepot + repris.verifications;
  if (total) {
    console.log(t('log.start.reconciled', {
      sessions: repris.sessions, horsDepot: repris.horsDepot, verifications: repris.verifications,
    }));
  }
}
