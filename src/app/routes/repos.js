'use strict';
/* Les dépôts suivis et les répertoires locaux : ajouter, modifier, re-cloner, supprimer, parcourir GitLab et GitHub pour en ajouter en masse.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const links = require('../../notes/links');
const forge = require('../../forge');
const git = require('../../git/git');
const jenkins = require('../../integrations/jenkins');
const localrepos = require('../../git/localrepos');
const path = require('path');
const fs = require('fs');
const { repoById, wrap } = require('../http');
const { exigerJetonFrais, noterTest } = require('../lib/connexions');

/* ---------- Repos (admin) ---------- */
app.get('/api/repos', wrap((req, res) => {
  /* L'ÉTAT DE CHAQUE DÉPÔT, sur sa propre ligne. « Pourquoi cette review échoue ? » commence
     presque toujours par « le clone est-il là, et à jour ? » : le nombre de merge requests
     ouvertes, la date de la dernière découverte, et l'état du clone (présent, absent,
     modifié) répondent avant d'ouvrir un terminal. Tout est LOCAL — un `statSync` et une
     requête —, jamais un appel à la forge : cette liste s'ouvre à chaque visite. */
  const cfg = getConfig();
  const ouvertes = {};
  for (const r of db.prepare(`SELECT repo_id AS id, COUNT(*) n, MAX(updated_at) AS at FROM mr
    WHERE (closed_seen IS NULL OR closed_seen = 0) GROUP BY repo_id`).all()) {
    ouvertes[r.id] = r;
  }
  res.json(db.prepare('SELECT * FROM repo ORDER BY id').all().map((repo) => {
    const dir = git.cloneDirFor(cfg, repo);
    let clone = 'absent';
    try {
      if (fs.statSync(path.join(dir, '.git')).isDirectory() || fs.statSync(path.join(dir, '.git')).isFile()) clone = 'present';
    } catch { clone = 'absent'; }
    const o = ouvertes[repo.id] || {};
    return { ...repo, open_mrs: o.n || 0, last_seen_at: o.at || null, clone_state: clone, clone_dir: dir };
  }));
}));
/* B17 — LA FICHE D'UN DÉPÔT. La ligne des réglages dit son URL, ses merge requests ouvertes
   et l'état de son clone — c'est-à-dire ce qui le concerne LUI, jamais ce qui est ACCROCHÉ à
   lui. Or c'est là qu'on se pose la question : « qu'est-ce qui casse si je retire ce dépôt ? »,
   « quel vérificateur le teste, déjà ? », « pourquoi ses reviews reçoivent-elles cette
   règle ? ». Six réponses, six jointures qui existaient toutes, et aucune page pour les lire
   ensemble.

   Une seule requête HTTP, à la DEMANDE (le panneau se déplie) : la liste des dépôts s'ouvre à
   chaque visite des réglages, elle n'a pas à payer six requêtes par ligne pour un panneau que
   personne n'a ouvert. */
app.get('/api/repos/:id/sheet', wrap((req, res) => {
  const id = Number(req.params.id);
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  res.json({
    verifiers: db.prepare(`SELECT v.id, v.name, vr.mode FROM verifier_repo vr
      JOIN verifier v ON v.id = vr.verifier_id WHERE vr.repo_id = ? ORDER BY v.name`).all(id),
    jenkins: db.prepare('SELECT id, job_path, param FROM repo_jenkins WHERE repo_id = ? ORDER BY job_path').all(id),
    /* Les règles LIMITÉES à ce dépôt. Celles qui valent partout ne sont pas « rattachées » :
       les lister ici ferait croire qu'elles disparaîtraient avec lui. */
    rules: db.prepare(`SELECT id, label, branch_match, path_match, enabled FROM review_rule
      WHERE repo_id = ? ORDER BY id`).all(id),
    services: db.prepare('SELECT id, name FROM service WHERE repo_id = ? ORDER BY name').all(id),
    // Les projets liés PAR DÉFAUT : ce qui sera joint au contexte des futures merge requests.
    links: db.prepare(`SELECT l.linked_repo_id AS id, l.branch, r.project FROM repo_link l
      JOIN repo r ON r.id = l.linked_repo_id WHERE l.repo_id = ? ORDER BY r.project`).all(id),
    agents: db.prepare(`SELECT a.id, a.name, ar.role FROM agent_repo ar
      JOIN agent a ON a.id = ar.agent_id WHERE ar.repo_id = ? ORDER BY a.name`).all(id),
  });
}));
/* RE-CLONER. Le premier réflexe quand une review échoue sur un clone abîmé : on le supprimait
   à la main dans un terminal. Le geste est DESTRUCTEUR pour ce qui n'a pas été poussé — d'où
   la confirmation côté écran, et le fait qu'on ne touche qu'au répertoire de clonage calculé,
   jamais à un chemin fourni par l'appelant. */
app.post('/api/repos/:id/reclone', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.params.id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const dir = git.cloneDirFor(cfg, repo);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* déjà absent */ }
  await git.ensureRepo(cfg, repo, () => {});
  res.json({ ok: true, dir });
}));
/* CE QUI RESSEMBLE À UNE URL DE DÉPÔT. Le serveur acceptait n'importe quelle chaîne : « toto »
   devenait un dépôt suivi, et l'erreur ne se voyait qu'au premier clonage — après une découverte
   qui ne rapportait rien. Le front valide déjà ; le serveur ne s'y fie pas (l'API est appelable
   directement, et un `POST` malformé ne doit pas polluer la liste). */
/* Un chemin ABSOLU est une source de clonage parfaitement valide — `git clone /srv/depots/x.git`
   marche, c'est ce que fait le décor de démo, et c'est ce que font les tests. La première
   version de cette garde ne connaissait que http(s) et ssh : elle refusait un dépôt local. */
const RE_URL_DEPOT = /^(https?:\/\/\S+|file:\/\/\S+|\/\S+|(ssh:\/\/)?[\w.-]+@[\w.-]+[:/]\S+)$/i;
app.post('/api/repos', wrap((req, res) => {
  const { url, branch_pattern } = req.body || {};
  if (!url) throw new Error(t('err.l-url-du-depot-est'));
  if (!RE_URL_DEPOT.test(String(url).trim())) throw new Error(t('err.repo-url-invalide'));
  // Forge du dépôt : explicite, sinon déduite de l'URL (github.com → github).
  const forgeName = req.body.forge ? forge.normalizeForge(req.body.forge)
    : (/github/i.test(String(url)) ? 'github' : 'gitlab');
  // project optionnel : déduit de l'URL si non fourni, avec le normalizer de la forge
  const project = (req.body.project || '').trim() || forge.clientFor({ forge: forgeName }).normalizeProject(url);
  if (!project) throw new Error(t('err.impossible-de-deduire-le-chemin'));
  // pattern vide autorisé = toutes les MR (on ne force plus 'PROJ-')
  const pattern = (branch_pattern ?? '').trim();
  const dup = db.prepare('SELECT id FROM repo WHERE project = ? AND COALESCE(forge, ?) = ?').get(project, 'gitlab', forgeName);
  if (dup) throw new Error(t('err.repo-already-added', { project, forge: forge.label(forgeName) }));
  const info = db.prepare(`INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge)
    VALUES (?, ?, ?, 1, ?, ?)`).run(project, url.trim(), pattern, new Date().toISOString(), forgeName);
  res.json(repoById(info.lastInsertRowid));
}));
app.put('/api/repos/:id', wrap((req, res) => {
  const cur = repoById(Number(req.params.id));
  if (!cur) throw new Error(t('err.repo-introuvable'));
  const { url, branch_pattern, enabled, fetch_mrs } = req.body || {};
  const nextUrl = url != null ? String(url).trim() : cur.url;
  // project : fourni explicitement, sinon déduit de l'URL, sinon inchangé
  let project = (req.body.project || '').trim();
  if (!project) project = url != null ? forge.clientFor(cur).normalizeProject(nextUrl) : cur.project;
  // pattern : vide autorisé (= toutes les MR)
  const pattern = branch_pattern != null ? String(branch_pattern).trim() : cur.branch_pattern;
  db.prepare(`UPDATE repo SET project = ?, url = ?, branch_pattern = ?, enabled = ?, fetch_mrs = ? WHERE id = ?`)
    .run(project || cur.project, nextUrl, pattern,
         enabled == null ? cur.enabled : (enabled ? 1 : 0),
         // absent du corps = inchangé ; NULL d'avant migration = activé, la valeur par défaut
         fetch_mrs == null ? (cur.fetch_mrs == null ? 1 : cur.fetch_mrs) : (fetch_mrs ? 1 : 0),
         cur.id);
  res.json(repoById(cur.id));
}));
app.delete('/api/repos/:id', wrap((req, res) => {
  db.prepare('DELETE FROM repo WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
/* ---------- Répertoires locaux (Réglages → Dépôts) ----------
   Un répertoire local = une racine contenant un sous-dossier par projet git. La
   liste des projets n'est jamais mise en base : elle se relit du disque, sinon un
   dépôt cloné entre deux visites resterait invisible et un dépôt supprimé
   continuerait d'être proposé. */
app.get('/api/local-roots', wrap((req, res) => {
  // Le nombre de projets accompagne chaque racine : c'est ce qui dit d'un coup d'œil
  // que le chemin saisi désigne bien le dossier attendu (et non son parent).
  res.json(localrepos.roots().map((r) => {
    try {
      const list = localrepos.projects(r.id);
      // On renvoie AUSSI la liste (nom, git, branche courante) : l'écran des réglages
      // affiche les projets trouvés sous chaque répertoire, pas seulement leur nombre.
      return {
        ...r,
        count: list.length,
        git_count: list.filter((p) => p.git).length,
        projects: list.map((p) => ({ name: p.name, git: p.git, branch: p.branch })),
        error: null,
      };
    } catch (e) { return { ...r, count: 0, git_count: 0, projects: [], error: e.message }; }
  }));
}));
app.post('/api/local-roots', wrap((req, res) => {
  const { path: p, label } = req.body || {};
  res.json(localrepos.addRoot(p, label));
}));
app.delete('/api/local-roots/:id', wrap((req, res) => {
  res.json(localrepos.removeRoot(Number(req.params.id)));
}));
// Projets d'un répertoire : sous-dossiers directs, avec leur branche courante.
app.get('/api/local-roots/:id/projects', wrap((req, res) => {
  res.json({ root_id: Number(req.params.id), projects: localrepos.projects(Number(req.params.id)) });
}));
// Branches DISTANTES d'un projet local (fetch préalable) + branche courante.
app.get('/api/local-projects/branches', wrap(async (req, res) => {
  res.json(await localrepos.branches(Number(req.query.root_id), req.query.name, { fetch: req.query.fetch !== '0' }));
}));
/* Positionne chaque projet sur sa branche. Appel SYNCHRONE (hors file de jobs) :
   le résultat est un bilan par projet — quel dépôt est passé, lequel a échoué, quels
   fichiers étaient déjà modifiés — et c'est ce bilan que l'écran affiche. Le faire
   passer par un job obligerait à le reconstituer depuis un journal de texte. */
app.post('/api/navigate/checkout', wrap(async (req, res) => {
  const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
  res.json(await localrepos.checkout(targets));
}));
// Liste les projets GitLab accessibles, en marquant ceux déjà ajoutés.
app.get('/api/gitlab/projects', wrap(async (req, res) => {
  const cfg = getConfig();
  const projects = await forge.gitlab.listAccessibleProjects(cfg);
  const existing = new Set(db.prepare('SELECT project FROM repo').all().map((r) => r.project));
  res.json(projects.map((p) => ({ ...p, already: existing.has(p.project) })));
}));
/* TEST DE LA CONNEXION GITLAB, SUR LES VALEURS DU FORMULAIRE — comme le fait déjà
   `/github/test`. La version précédente lisait la configuration ENREGISTRÉE : au premier
   lancement, on saisissait l'URL et le jeton, on cliquait « Tester la connexion », et on se
   faisait répondre « Token GitLab non configuré » par une application qui avait la valeur sous
   les yeux. Deux boutons jumeaux ne peuvent pas avoir deux comportements.
   Le masque `***` signifie « champ non touché » : on teste alors avec le jeton en base. */
app.post('/api/gitlab/test', wrap(async (req, res) => {
  const cfg = getConfig();
  const test = { ...cfg };
  if (req.body && req.body.gitlab_url != null) exigerJetonFrais(req.body.gitlab_url, cfg.gitlab_url, req.body.access_token, cfg.access_token);
  if (req.body && req.body.gitlab_url != null) test.gitlab_url = req.body.gitlab_url;
  if (req.body && req.body.access_token && req.body.access_token !== '***') test.access_token = req.body.access_token;
  if (!forge.isConfigured(test, 'gitlab')) throw new Error(t('err.gitlab-test-incomplet'));
  try {
    const projects = await forge.gitlab.listAccessibleProjects(test);
    noterTest('gitlab', true, String(projects.length));
    res.json({ ok: true, count: projects.length });
  } catch (e) { noterTest('gitlab', false, e.message); throw e; }
}));
// Liste les branches d'un dépôt (pour choisir la branche de base d'une tâche).
app.get('/api/gitlab/branches', wrap(async (req, res) => {
  const repo = repoById(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const r = await forge.clientFor(repo).listBranches(getConfig(), repo.project);
  res.json(r);
}));
// Liste les dépôts GitHub accessibles, en marquant ceux déjà ajoutés.
app.get('/api/github/projects', wrap(async (req, res) => {
  const cfg = getConfig();
  const projects = await forge.github.listAccessibleProjects(cfg);
  const existing = new Set(db.prepare("SELECT project FROM repo WHERE forge = 'github'").all().map((r) => r.project));
  res.json(projects.map((p) => ({ ...p, already: existing.has(p.project) })));
}));
// Test de la connexion GitHub : renvoie le compte associé au token.
// Le front peut renvoyer le masque : on teste alors avec le token déjà en base.
app.post('/api/github/test', wrap(async (req, res) => {
  const cfg = getConfig();
  const test = { ...cfg };
  if (req.body && req.body.github_url != null) exigerJetonFrais(req.body.github_url, cfg.github_url, req.body.github_token, cfg.github_token, 'https://github.com');   // l'hôte WEB, défaut de `github.webBase`
  if (req.body && req.body.github_url != null) test.github_url = req.body.github_url;
  if (req.body && req.body.github_token && req.body.github_token !== '***') test.github_token = req.body.github_token;
  if (!forge.github.isConfigured(test)) throw new Error(t('err.token-github-non-configure'));
  try {
    const r = await forge.github.testConnection(test);
    noterTest('github', true, r.login || '');
    res.json({ ok: true, ...r });
  } catch (e) { noterTest('github', false, e.message); throw e; }
}));
// Ajout en masse de dépôts sélectionnés (ignore les doublons).
app.post('/api/repos/bulk', wrap((req, res) => {
  const { projects, branch_pattern } = req.body || {};
  if (!Array.isArray(projects) || !projects.length) throw new Error(t('err.aucun-projet-selectionne'));
  // `forge` absent = gitlab : le contrat de l'API ne change pas pour l'existant.
  const forgeName = forge.normalizeForge(req.body && req.body.forge);
  const api = forge.clientFor({ forge: forgeName });
  const pattern = (branch_pattern ?? '').trim();
  const now = new Date().toISOString();
  // Unicité par COUPLE (forge, projet) : « acme/web » peut exister sur les deux forges.
  const key = (f, p) => `${f}:${p}`;
  const existing = new Set(db.prepare('SELECT project, forge FROM repo').all()
    .map((r) => key(forge.forgeOf(r), r.project)));
  const ins = db.prepare('INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge) VALUES (?,?,?,1,?,?)');
  let added = 0; let skipped = 0;
  const tx = db.transaction((list) => {
    for (const p of list) {
      const proj = api.normalizeProject(p.project || p.url);
      if (!proj || existing.has(key(forgeName, proj))) { skipped += 1; continue; }
      ins.run(proj, String(p.url || '').trim(), pattern, now, forgeName);
      existing.add(key(forgeName, proj)); added += 1;
    }
  });
  tx(projects);
  res.json({ added, skipped });
}));
