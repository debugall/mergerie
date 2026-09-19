'use strict';
/* Les merge requests : la liste, une fiche, le ticket, la review et ses relances, le diff et la visionneuse, la convergence.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const { extractNote } = require('../../review/note');
const localsession = require('../../data/localsession');
const datasync = require('../../data/datasync');
const { nonFiable } = require('../../core/nonfiable');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const jira = require('../../integrations/jira');
const glob = require('../../core/glob');
const notes = require('../../notes/notes');
const links = require('../../notes/links');
const jobs = require('../../jobs');
const reviewer = require('../../review/reviewer');
const prompts = require('../../core/prompts');
const converge = require('../../review/converge');
const git = require('../../git/git');
const demoDiff = require('../../demo/diff');
const agentsession = require('../../agent/session');
const agentknowledge = require('../../agent/knowledge');
const path = require('path');
const fs = require('fs');
const { servirFichierNonFiable } = require('../fichiers');
const { gardeConfigAgent, mrById, parseConvergeOpts, readFileSafe, ticketUrl, wrap } = require('../http');
const { auteurs } = require('../lib/partage');
const { assertValidBranch, insertTargets } = require('../lib/sessions');
const { dernieresVerificationsParMr, detailVerification, resumeVerification } = require('../lib/verifications');
const { changedFilesFromDiff, diffDeLaMr, mrCloneCtx, viewerFile, viewerFileDiff, viewerPayload } = require('../lib/visionneuse');

// Vérifier maintenant : le même code que le minuteur, donc ce que le bouton montre est
// exactement ce que fait la surveillance.

/* ---------- MRs ---------- */
app.get('/api/mrs', wrap((req, res) => {
  const { status } = req.query;
  let rows;
  // tri par date de création de la MR (GitLab), décroissante ; NULL en dernier
  const order = 'ORDER BY mr.gitlab_created_at IS NULL, mr.gitlab_created_at DESC, mr.iid DESC';
  if (status) {
    rows = db.prepare(`
      SELECT mr.*, repo.project AS project, repo.forge AS forge FROM mr JOIN repo ON repo.id = mr.repo_id
      WHERE mr.status = ? ${order}`).all(status);
  } else {
    rows = db.prepare(`
      SELECT mr.*, repo.project AS project, repo.forge AS forge FROM mr JOIN repo ON repo.id = mr.repo_id
      ${order}`).all();
  }
  /* CE QUE LE BADGE DE NOTE DIRA AU SURVOL. Le sélecteur de version porte déjà ces chiffres,
     mais il faut ouvrir le rapport pour les lire : « v3 · 07/08 · 1 résolu · 1 persistant » se
     décide avant d'ouvrir. Une seule requête pour toute la liste — la dernière version de
     chaque merge request —, pas une par carte. */
  const derniereVersion = {};
  const versions = db.prepare(`SELECT rv.* FROM review_version rv
    WHERE rv.version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all();
  /* « PAR QUI » sur la carte d'une merge request : c'est l'auteur de sa DERNIÈRE passe de review
     qu'on veut, pas celui de la merge request — la question est « qui l'a reviewée ? ». Lu du
     cache alimenté par git, sans aucune colonne à tenir. */
  const parQui = auteurs('review_version', versions);
  for (const v of versions) {
    derniereVersion[v.mr_id] = {
      version: v.version, at: v.created_at, author: parQui.get(v.id) || null,
      n_new: v.n_new, n_persistent: v.n_persistent, n_resolved: v.n_resolved, n_disappeared: v.n_disappeared,
    };
  }
  /* COMBIEN DE BLOQUANTS, ET DE MAJEURS. Le détail disait « 1 résolu · 1 persistant » — le
     nombre, jamais la GRAVITÉ, alors que la sévérité est stockée par constat et déjà comptée
     pour décider de la publication automatique. Une note de 7,2 avec un bloquant et une note de
     7,2 sans aucun ne se traitent pas pareil, et c'est ce qui doit décider par quoi commencer.
     Une requête pour toute la liste, sur la dernière version de chaque merge request. */
  /* TOP 1 — LES BROUILLONS DE COMMENTAIRES, PARTOUT OÙ LA MERGE REQUEST APPARAÎT.
     C'est la perte de travail la plus silencieuse de l'outil : on écrit trois remarques inline
     dans le viewer, on referme pour aller voir autre chose, et elles restent là — personne ne
     les envoie, personne ne les voit, et la merge request se merge sans elles. Le compte
     existait déjà pour la ligne de projet d'une session ; il manquait sur la carte, dans
     l'en-tête du rapport et dans le brief du matin. Une requête pour toute la liste. */
  const brouillons = {};
  for (const c of db.prepare('SELECT mr_id, COUNT(*) n, MIN(created_at) AS depuis FROM mr_comment_draft GROUP BY mr_id').all()) {
    brouillons[c.mr_id] = { n: c.n, depuis: c.depuis };
  }

  const severites = {};
  for (const f of db.prepare(`SELECT f.mr_id, f.severity, COUNT(*) n FROM finding f
    WHERE f.version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = f.mr_id)
      AND f.status != 'resolved'
    GROUP BY f.mr_id, f.severity`).all()) {
    const e = severites[f.mr_id] || (severites[f.mr_id] = { blocker: 0, major: 0, minor: 0, info: 0 });
    if (e[f.severity] != null) e[f.severity] = f.n;
  }
  // marque celles qui ont un rapport + extrait la note globale du rapport
  const reviews = db.prepare('SELECT mr_id, md_path FROM review').all();
  const hasReview = new Set();
  const noteByMr = {};
  for (const rv of reviews) {
    hasReview.add(rv.mr_id);
    noteByMr[rv.mr_id] = extractNote(readFileSafe(rv.md_path));
  }
  const cfg = getConfig();
  // Badge « risque » : sans IA, juste sur les chemins du diff × les règles par chemin.
  // Chargées une fois pour toute la liste.
  const pathRules = db.prepare("SELECT id, path_match, label FROM review_rule WHERE enabled = 1 AND path_match IS NOT NULL AND path_match != ''").all();
  /* B7 — LES CARTES DE DOMAINE TOUCHÉES. Même mécanique que le badge « risque » : le produit
     des chemins du diff par ceux que les cartes citent, calculé sans IA et sans réseau. L'index
     est construit UNE fois pour toute la liste. */
  const indexCartes = agentknowledge.indexCartes();
  const riskOf = (changed) => {
    if (!changed || !pathRules.length) return [];
    const paths = String(changed).split('\n').filter(Boolean);
    return pathRules
      .filter((rule) => glob.matchingPaths(rule.path_match, paths).length > 0)
      .map((rule) => ({ label: rule.label || rule.path_match, path_match: rule.path_match }));
  };
  /* Les tickets SURVEILLÉS, avec leur état : la seule information Jira que le serveur possède
     hors ligne. Une requête pour toute la liste. */
  /* Les lots de chaque merge request, en une requête : la liste en affiche onze, et une
     requête par carte ferait onze allers-retours pour une information de contexte. */
  const lotsParMr = {};
  for (const l of db.prepare(`SELECT lm.ref_id AS mr_id, lot.id, lot.name FROM lot_member lm
    JOIN lot ON lot.id = lm.lot_id WHERE lm.kind = 'mr'`).all()) {
    (lotsParMr[l.mr_id] = lotsParMr[l.mr_id] || []).push({ id: l.id, name: l.name });
  }
  const etatsTickets = {};
  for (const w of db.prepare('SELECT key, status, status_category FROM jira_watch').all()) {
    etatsTickets[String(w.key).toUpperCase()] = { status: w.status, cat: w.status_category };
  }
  /* B8 — les jobs Jenkins déclarés pour chaque dépôt. Une requête pour toute la liste ; le
     bouton n'apparaît que sur une merge request VÉRIFIÉE VERTE, ce que l'écran décide. */
  const jobsParDepot = {};
  for (const l of db.prepare('SELECT repo_id, job_path, param FROM repo_jenkins').all()) {
    (jobsParDepot[l.repo_id] = jobsParDepot[l.repo_id] || []).push({ path: l.job_path, param: l.param });
  }
  const verifs = dernieresVerificationsParMr();
  /* Un dépôt qu'aucun vérificateur ne couvre : le bouton « Vérifier » sera GRISÉ, avec la raison
     en info-bulle. Proposer un bouton qui répond « impossible » une fois cliqué fait perdre un
     geste et n'apprend rien de plus. */
  const couverts = new Set(db.prepare('SELECT DISTINCT repo_id FROM verifier_repo').all().map((r) => r.repo_id));
  res.json(rows.map((r) => {
    const key = jira.ticketKey(r.title, r.source_branch);
    return {
      ...r,
      verification: verifs.has(r.id) ? resumeVerification(detailVerification(verifs.get(r.id))) : null,
      verifiable: couverts.has(r.repo_id),
      has_review: hasReview.has(r.id),
      note: noteByMr[r.id] || null,
      note_detail: derniereVersion[r.id] || null,
      // Les constats NON RÉSOLUS de la dernière version, par gravité. `null` = pas de rapport.
      severites: severites[r.id] || null,
      // Les remarques écrites et jamais envoyées : le travail le plus facile à perdre.
      drafts: brouillons[r.id] || null,
      /* B3 — L'ÉTAT DU TICKET, quand on le connaît. Vendredi la QA passe PROJ-1408 en « En
         revue » ; la merge request attend depuis trois jours au milieu de onze cartes et
         personne ne fait le lien. On ne SONDE pas Jira pour autant : on lit ce que la
         surveillance des tickets a déjà relevé — c'est la seule liste connue hors ligne. */
      jenkins_jobs: jobsParDepot[r.repo_id] || [],
      /* EN CONFLIT : la forge l'a dit, on l'a écrit — et personne ne le relisait entre deux
         ouvertures de la modale de merge. Une MR en conflit ne se merge pas : le savoir en
         lisant la file évite de l'ouvrir pour l'apprendre. */
      has_conflicts: r.has_conflicts == null ? null : !!r.has_conflicts,
      /* A/Réglages 3 — À QUELS LOTS CETTE MERGE REQUEST APPARTIENT. On la vérifie « ensemble »
         avec quatre autres, puis trois jours plus tard on ouvre sa carte et rien ne dit
         qu'elle ne tient pas seule. Une requête pour toute la liste, pas une par carte. */
      lots: lotsParMr[r.id] || [],
      /* DEUX SOURCES, DANS CET ORDRE. La surveillance d'un ticket est RAFRAÎCHIE (elle
         interroge Jira à intervalle) : elle prime. Le statut rangé à la découverte, lui,
         couvre TOUTES les MR à ticket — la grande majorité, qu'on ne surveille pas — au prix
         d'être plus ancien. Sans lui, « ticket en revue » n'existait que pour les watchés,
         c'est-à-dire presque jamais là où on choisit quoi reviewer. */
      /* LA CLÉ DU TICKET, CALCULÉE ICI ET NULLE PART AILLEURS. L'écran la redéduisait avec sa
         propre expression régulière — qui ne suivait pas la même règle que `jira.ticketKey`
         (crochets du titre d'abord, branche ensuite) : un titre citant deux clés donnait une
         réponse côté serveur et une autre à l'écran. Une règle, un endroit. */
      ticket_key: r.ticket_jira_key || jira.ticketKey(r.title, r.source_branch) || '',
      ticket_status: (etatsTickets[String(r.ticket_jira_key || jira.ticketKey(r.title, r.source_branch) || '').toUpperCase()] || {}).status
        || r.ticket_jira_status || null,
      ticket_category: (etatsTickets[String(r.ticket_jira_key || jira.ticketKey(r.title, r.source_branch) || '').toUpperCase()] || {}).cat
        || r.ticket_jira_category || null,
      /* TAILLE ET FRAÎCHEUR : de quoi choisir par quoi commencer sans ouvrir la carte. Le
         nombre de fichiers se déduit des chemins quand le relevé date d'avant la mesure. */
      size: {
        files: r.changed_files != null ? r.changed_files
          : (r.changed_paths ? String(r.changed_paths).split('\n').filter(Boolean).length : null),
        additions: r.changed_additions != null ? r.changed_additions : null,
        deletions: r.changed_deletions != null ? r.changed_deletions : null,
      },
      has_ticket: !!(r.ticket_text || r.ticket_image || r.ticket_jira_text),
      ticket_key: key,
      ticket_url: ticketUrl(cfg, key),
      risk: riskOf(r.changed_paths),
      cards: agentknowledge.cartesTouchees(indexCartes, r.repo_id, r.changed_paths),
      stale: r.reviewed_sha && r.reviewed_sha !== r.current_sha,
    };
  }));
}));
/* Retrouve la session de codage qui a produit une branche. Le lien n'est pas stocké en dur :
   il se reconstitue par (dépôt, branche). En cas d'ambiguïté — plusieurs sessions sur la même
   branche — on prend la PLUS RÉCENTE, et seulement si elle a bien une session d'agent. */
function originSessionKey(mr) {
  const row = db.prepare(`SELECT ls.session_key FROM task_target tt
    JOIN task t ON t.id = tt.task_id
    JOIN local_session ls ON ls.scope = 'task_target' AND ls.ref = tt.uid
    WHERE tt.repo_id = ? AND tt.branch = ? AND ls.session_key IS NOT NULL AND t.kind = 'code'
    ORDER BY tt.id DESC LIMIT 1`).get(mr.repo_id, mr.source_branch);
  return (row && row.session_key) || null;
}
/* B2 — LA SESSION QUI A PRODUIT CETTE BRANCHE. Le sens session → merge request existait
   partout (note, verdict, brouillons sur la ligne de projet) ; l'inverse n'était calculé que
   pour pré-remplir un champ caché. Après « Faire corriger », on ne voyait donc pas, depuis le
   rapport, que la correction tournait — on découvrait la MR « périmée » un quart d'heure plus
   tard. La jointure (dépôt, branche) est celle qu'utilise déjà l'explorateur de branches. */
function originTask(mr) {
  const row = db.prepare(`SELECT t.id, t.label, t.prompt, t.status, t.kind FROM task_target tt
    JOIN task t ON t.id = tt.task_id
    WHERE tt.repo_id = ? AND tt.branch = ? ORDER BY tt.id DESC LIMIT 1`).get(mr.repo_id, mr.source_branch);
  if (!row) return null;
  return {
    id: row.id, status: row.status, kind: row.kind || 'code',
    label: row.label || String(row.prompt || '').slice(0, 60),
  };
}
app.get('/api/mrs/:id', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(mr.id);
  const comments = db.prepare('SELECT * FROM comment_log WHERE mr_id = ? ORDER BY id DESC').all(mr.id);
  const tkey = jira.ticketKey(mr.title, mr.source_branch);
  res.json({
    mr,
    /* B3 — LES TODOS OUVERTES DE CETTE MERGE REQUEST. Le rapport proposait d'en AJOUTER une
       sans montrer celles qui existent : on en recréait une deuxième, identique, deux jours
       plus tard. La jointure inverse est déjà écrite pour l'onglet Notes. */
    todos: db.prepare(`SELECT id, title, priority, due_at FROM todo
      WHERE link_kind = 'mr' AND link_ref = ? AND status = 'open'
      ORDER BY COALESCE(due_at, '9999'), id`).all(String(mr.id)),
    /* TOP 1 — les remarques écrites et jamais envoyées, dans l'en-tête du rapport aussi : c'est
       là qu'on décide de merger, et c'est le dernier moment où l'oubli est rattrapable. */
    drafts: (() => {
      const c = db.prepare('SELECT COUNT(*) n, MIN(created_at) AS depuis FROM mr_comment_draft WHERE mr_id = ?').get(mr.id);
      return c && c.n ? { n: c.n, depuis: c.depuis } : null;
    })(),
    /* B4 — LES NOTES QUI PARLENT DE CETTE MERGE REQUEST. L'autolien menait des notes vers
       elle ; l'inverse n'existait pas, et « on en avait parlé, où ? » se terminait en
       recherche plein texte à la main. Servi avec le rapport plutôt qu'en appel à part : le
       coût est un `LIKE` borné sur des notes locales, et un appel de plus par ouverture de
       rapport serait cher payé pour trois lignes. */
    citations: notes.citations({ mr: mr.iid }),
    // B7 — les cartes de domaine que ce diff touche (même calcul que la liste).
    cards: agentknowledge.cartesTouchees(agentknowledge.indexCartes(), mr.repo_id, mr.changed_paths),
    ticket_key: tkey,
    ticket_url: ticketUrl(getConfig(), tkey),
    // Commande pour reprendre la session d'agent de la review dans un terminal.
    resume_cmd: (() => {
      /* Le handle de la session de REVIEW a quitté la ligne `mr` : il ne vaut que dans le
         `~/.claude` de cette machine, alors que l'état de relecture de la MR, lui, se partage. */
      const h = localsession.lire('mr', mr.uid);
      return agentsession.resumeCommand(h.session_backend, h.session_key, h.session_cwd);
    })(),
    /* Session de CODAGE dont cette MR est issue, s'il y en a une. Sert à pré-remplir le champ
       « identifiant de session » quand on demande une correction : l'IA reprend alors le fil de
       son propre travail au lieu de redécouvrir le code. Simple proposition — le champ reste
       modifiable et effaçable, parce que la jointure (dépôt + branche source) n'est pas une
       preuve : une branche peut avoir été reprise à la main, ou par quelqu'un d'autre. */
    origin_session: originSessionKey(mr),
    origin_task: originTask(mr),
    /* CE QUE CETTE REVIEW A COÛTÉ. Les statistiques donnaient une MOYENNE par merge request,
       faute de propriétaire sur les usages de review : « ma review a-t-elle coûté cher ? »
       n'avait pas de réponse. Elle en a une maintenant, à l'endroit où on la lit. */
    tokens_est: (db.prepare(`SELECT SUM(tokens_est) n FROM usage
      WHERE owner_kind = 'mr' AND owner_id = ?`).get(mr.id) || {}).n || null,
    verification: (() => {
      const v = dernieresVerificationsParMr().get(mr.id);
      return v ? resumeVerification(detailVerification(v)) : null;
    })(),
    // Un vérificateur couvre-t-il ce dépôt ? Le bouton n'apparaît que si oui.
    verifiable: !!db.prepare('SELECT 1 FROM verifier_repo WHERE repo_id = ?').get(mr.repo_id),
    /* L'équipe partage-t-elle un dépôt de données ? Alors le rapport y a une adresse, et on
       peut publier ce LIEN sur la merge request plutôt que six cents lignes. Sans dépôt, le
       bouton n'aurait nulle part où pointer : il n'existe pas. */
    data_repo: datasync.estConfigure(),
    review: rev ? {
      md: readFileSafe(rev.md_path),
      explanation: readFileSafe(rev.explanation_path),
      updated_at: rev.updated_at,
      // Ce qui est DÉJÀ parti sur la merge request : le bouton « Publier » le dit, pour
      // qu'on ne poste pas deux fois le même rapport en croyant au premier échec.
      comment_posted_at: rev.comment_posted_at || null,
      /* Et pour le LIEN, la même chose — lue dans les commentaires déjà enregistrés, qui
         voyagent : le bouton dit donc aussi ce qu'un COLLÈGUE a déjà publié. */
      link_posted_at: (reviewer.lienDejaPublie(mr.id) || {}).at || null,
    } : null,
    comments,
    ticket: {
      text: mr.ticket_text || '',
      has_image: !!(mr.ticket_image && fs.existsSync(mr.ticket_image)),
      jira_text: mr.ticket_jira_text || '',
      // Clé stockée (après un fetch) ou, à défaut, déduite du titre/branche — pour
      // qu'une MR jamais fetchée sache tout de même qu'un ticket est récupérable.
      jira_key: mr.ticket_jira_key || jira.ticketKey(mr.title, mr.source_branch) || '',
      jira_at: mr.ticket_jira_at || '',
      jira_error: mr.ticket_jira_error || '',
      jira_configured: jira.isConfigured(getConfig()),
    },
    convergence: converge.latestRun(mr.id), // dernière boucle « Converger » (panneau)
    links: db.prepare(`SELECT ml.repo_id, ml.branch, repo.project, repo.forge FROM mr_link ml JOIN repo ON repo.id = ml.repo_id WHERE ml.mr_id = ?`).all(mr.id),
    repo_links: db.prepare(`SELECT rl.linked_repo_id AS repo_id, rl.branch, repo.project FROM repo_link rl JOIN repo ON repo.id = rl.linked_repo_id WHERE rl.repo_id = ?`).all(mr.repo_id),
    stale: mr.reviewed_sha && mr.reviewed_sha !== mr.current_sha,
  });
}));
// Enregistre le contexte du ticket (texte + capture facultative en data URL).
function saveTicketImage(mrId, dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error(t('err.image-invalide-data-url-image'));
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  ensureDir(TICKETS_DIR);
  for (const e of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    try { fs.rmSync(path.join(TICKETS_DIR, `${mrId}.${e}`), { force: true }); } catch { /* rien */ }
  }
  const file = path.join(TICKETS_DIR, `${mrId}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}
app.post('/api/mrs/:id/ticket', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { text, image, removeImage } = req.body || {};
  let imgPath = mr.ticket_image;
  if (removeImage && imgPath) { try { fs.rmSync(imgPath, { force: true }); } catch { /* rien */ } imgPath = null; }
  if (image) imgPath = saveTicketImage(mr.id, image);
  const texte = (text || '').trim();
  db.prepare('UPDATE mr SET ticket_text = ?, ticket_image = ?, updated_at = ? WHERE id = ?')
    .run(texte || null, imgPath, new Date().toISOString(), mr.id);
  res.json({ ok: true, has_text: !!texte, has_image: !!imgPath });
}));
app.get('/api/mrs/:id/ticket-image', (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr || !mr.ticket_image || !fs.existsSync(mr.ticket_image)) return res.status(404).end();
  return servirFichierNonFiable(res, { chemin: mr.ticket_image });
});
app.post('/api/mrs/:id/review', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  // explain absent → suit le réglage global ; présent → surcharge ponctuelle (true/false).
  const opts = {};
  if (req.body && req.body.explain != null) opts.explain = req.body.explain === true || req.body.explain === '1' || req.body.explain === 1;
  const job = jobs.startJob('review', [mr.id], opts);
  res.json(job);
}));
// Génère l'explication pédagogique à la demande pour une MR déjà reviewée (1 appel IA).
app.post('/api/mrs/:id/explain', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT id FROM review WHERE mr_id = ?').get(mr.id);
  if (!rev) throw new Error(t('err.explain-sans-review'));
  const job = jobs.startJob('explain', [mr.id]);
  res.json(job);
}));
app.get('/api/mrs/:id/diff', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ diff: await diffDeLaMr(mr) });
}));
/* Diff d'une MR AVANT review : permet de juger une MR sans dépenser un appel IA
   (« si elle est triviale, je la classe direct »). Calculé en direct depuis le
   clone — qu'on s'assure d'abord d'avoir (clone/fetch à la demande, d'où le coût
   possible sur un premier accès à un gros dépôt). Sert aussi à réchauffer le clone
   pour que les endpoints /file et /filediff du viewer fonctionnent ensuite. */
app.get('/api/mrs/:id/diffview', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  // En démo, aucun clone n'est possible (la forge n'existe pas) : dépôt fictif servi tel quel.
  if (demoDiff.isDemo()) { res.json(demoDiff.viewFor(mr)); return; }
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const cwd = await git.ensureRepo(cfg, repo, () => {});
  /* Si la review a déjà stocké le diff, on le réutilise ; sinon calcul en direct — et le clone
     vient d'être mis à jour, donc `diffDeLaMr` n'a rien à aller chercher. */
  const diff = await diffDeLaMr(mr, cwd)
    || await git.targetedDiff(cwd, mr.source_branch, mr.target_branch, () => {});
  /* LA MÊME VERSION QUE LE RAPPORT. Le diff servi ici est celui de la review ; l'arborescence
     doit donc être celle du commit REVIEWÉ, pas de la tête de branche — sinon, dès que la
     branche avance, l'écran mélange deux versions : un fichier listé d'après la tête, un
     contenu et des numéros de ligne venus du commit reviewé (routes `/file` et `/filediff`,
     qui visent `reviewed_sha`). Repli sur la tête si l'objet n'est plus là (force-push),
     comme le fait déjà `/tree`. */
  const vise = mr.reviewed_sha && await git.refExists(cwd, mr.reviewed_sha)
    ? mr.reviewed_sha : `origin/${mr.source_branch}`;
  const ctx = { cwd, ref: vise, target: mr.target_branch || 'main' };
  res.json(await viewerPayload(ctx, { diff, source: mr.source_branch }));
}));
// Arborescence du projet à la version reviewée + marquage des fichiers modifiés.
app.get('/api/mrs/:id/tree', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (demoDiff.isDemo()) { res.json(demoDiff.treeFor(mr)); return; }
  const { cwd, ref } = mrCloneCtx(mr);
  let files;
  try { files = await git.lsTree(cwd, ref); }
  catch { files = await git.lsTree(cwd, `origin/${mr.source_branch}`); }
  const changed = changedFilesFromDiff(await diffDeLaMr(mr, cwd));
  res.json({ ref, target: mr.target_branch, files: files.map((f) => ({ path: f, changed: changed.has(f) })) });
}));
// Contenu complet d'un fichier à la version reviewée (validé contre l'arborescence).
app.get('/api/mrs/:id/file', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileFor(mr, String(req.query.path || ''))); return; }
  res.json(await viewerFile(mrCloneCtx(mr), String(req.query.path || '')));
}));
// Diff d'un fichier à contexte complet (fichier entier + changements surlignés).
app.get('/api/mrs/:id/filediff', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileDiffFor(mr, String(req.query.path || ''))); return; }
  res.json(await viewerFileDiff(mrCloneCtx(mr), String(req.query.path || '')));
}));
app.post('/api/mrs/:id/rereview', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (mr.status === 'done') throw new Error(t('err.mr-marquee-done-re-review'));
  // incremental : ne reviewer que le delta depuis le dernier SHA reviewé (best-effort :
  // reviewMr retombe sur une review complète s'il n'y a pas de delta exploitable).
  const incremental = !!(req.body && (req.body.incremental === true || req.body.incremental === '1'));
  const job = jobs.startJob('rereview', [mr.id], { incremental });
  res.json(job);
}));
// « Converger » : boucle autonome review → correction IA (commit + push) → re-review
// incrémentale, jusqu'au seuil / à la régression / au plafond. JAMAIS de merge.
// seuil et plafond : réglage global par défaut, surchargeables au lancement.
app.post('/api/mrs/:id/converge', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (mr.status === 'done') throw new Error(t('err.mr-marquee-done-re-review'));
  await gardeConfigAgent(db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id), mr.source_branch, mr.target_branch, req.body);
  const job = jobs.startConvergeJob(mr.id, parseConvergeOpts(req.body));
  res.json(job);
}));
// « Corriger la review » : crée une Dev session qui applique les corrections de la
// review sur la branche de la MR, et la lance.
/* La consigne qui applique un rapport de revue au code : un seul texte pour « Faire corriger
   par l'IA » et pour chaque passe de Converger, pris dans les réglages et traduit comme les
   autres gabarits. Vide → le défaut de la langue courante. */
function promptCorrection(mr, reviewMd) {
  return reviewer.fillTemplate(prompts.gabarit('prompt_fix', getConfig()), {
    source: mr.source_branch, target: mr.target_branch || '', report: nonFiable('rapport de revue', reviewMd),
  });
}
app.post('/api/mrs/:id/fix-review', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  await gardeConfigAgent(db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id), mr.source_branch, mr.target_branch, req.body);
  const rev = db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(mr.id);
  const reviewMd = rev ? readFileSafe(rev.md_path) : null;
  if (!reviewMd) throw new Error(t('err.aucune-review-a-corriger-pour'));
  const branch = assertValidBranch(mr.source_branch);
  /* LE GABARIT, PAS UN TEXTE EN DUR. Cette consigne était recopiée ici ET dans `converge.js` :
     deux copies françaises, hors `prompts.js`, donc ni traduites ni éditables — et sûres de
     diverger le jour où l'une des deux serait retouchée. */
  const prompt = promptCorrection(mr, reviewMd);
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, commit_message, auto_push, status, created_at, updated_at)
    VALUES (?, 'code', ?, ?, ?, ?, 0, 'new', ?, ?)`).run(
    mr.repo_id, prompt, branch, mr.target_branch || null, `${branch}: corrections review !${mr.iid}`, now, now);
  const taskId = info.lastInsertRowid;
  // la session porte sur UN projet : la branche de la MR à corriger
  insertTargets(taskId, [{ repo_id: mr.repo_id, branch }]);
  jobs.startTaskJob(taskId, 'run');
  res.json({ ok: true, task_id: taskId });
}));
