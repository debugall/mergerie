'use strict';
/* Ce qu’une session est pour la couche HTTP : la retrouver, ses cibles, ses dossiers, son libellé, son suivi, ses identifiants de session d’agent.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const localdirs = require('../../data/localdirs');
const localsession = require('../../data/localsession');
const garde = require('../../core/garde');
const i18n = require('../../core/i18n');
const { t } = i18n;
const git = require('../../git/git');
const agentsession = require('../../agent/session');
const agentpass = require('../../agent/pass');
const tasks = require('../../agent/tasks');
const agentprofile = require('../../agent/profile');
const path = require('path');
const { readFileSafe } = require('../http');
const { avecRangement, unitesAvecRetour } = require('./partage');
const { verifsParMrDuTour } = require('./verifications');

/* ---------- Tasks (tâches de dev pilotées par l'IA) ---------- */
function taskById(id) {
  return avecRangement('task', db.prepare(`SELECT task.*, repo.project AS project, repo.forge AS forge FROM task JOIN repo ON repo.id = task.repo_id WHERE task.id = ?`).get(id));
}
// Les projets d'une session, avec leur état d'exécution propre (commit, diff, MR…).
function taskTargets(taskId) {
  /* Les options du profil, s'il y en a un : la commande « Reprendre au terminal » doit
     reprendre LA MÊME session — sans son modèle ni son allowlist, ce serait une autre. */
  const optionsAgent = agentprofile.optionsFor(db.prepare('SELECT * FROM task WHERE id = ?').get(taskId));
  const poignees = localsession.carte('task_target');   // une requête, pas une par projet
  /* `has_review` : la merge request de ce projet porte-t-elle un rapport ? C'est ce qui décide
     de l'apparition du bouton « Reprendre le rapport de review » sur le formulaire de suivi.
     Un booléen, pas le rapport lui-même — la liste des sessions n'a pas à charrier le Markdown
     de chaque rapport à chaque rafraîchissement, c'est-à-dire toutes les secondes et demie.
     On accepte les DEUX rattachements, comme `effectiveMr` : la MR ouverte par l'application
     (`tt.mr_iid`) ou celle déjà connue sur la même branche. */
  const rows = db.prepare(`SELECT tt.*, repo.project AS project, repo.forge AS forge,
      mr.iid AS existing_mr_iid, mr.web_url AS existing_mr_url,
      mr.ticket_jira_key AS mr_ticket_key, mr.ticket_jira_status AS mr_ticket_status,
      mr.ticket_jira_category AS mr_ticket_category,
      (SELECT 1 FROM review r2 JOIN mr m2 ON m2.id = r2.mr_id
        WHERE m2.repo_id = tt.repo_id AND (m2.iid = tt.mr_iid OR m2.source_branch = tt.branch)
        LIMIT 1) AS has_review,
      (SELECT m3.id FROM mr m3
        WHERE m3.repo_id = tt.repo_id AND (m3.iid = tt.mr_iid OR m3.source_branch = tt.branch)
        LIMIT 1) AS mr_row_id
    FROM task_target tt
    JOIN repo ON repo.id = tt.repo_id
    LEFT JOIN mr ON mr.repo_id = tt.repo_id AND mr.source_branch = tt.branch
      AND (mr.closed_seen IS NULL OR mr.closed_seen = 0)
    WHERE tt.task_id = ? ORDER BY tt.id`).all(taskId);
  // `questions_json` (bloc <<<QUESTIONS>>>) exposé parsé pour le formulaire de réponses.
  // `resume_cmd` : commande à copier pour reprendre la session d'agent dans un terminal.
  /* `has_verify_fail` : la vérification la plus récente de la merge request de ce projet
     a-t-elle CASSÉ quelque chose, et par la faute de cette branche ? C'est ce qui décide de
     l'apparition du bouton « Reprendre le rapport de vérif » sur le formulaire de suivi.
     La table des dernières vérifications balaie trois cents lignes : la RECALCULER pour chaque
     session ferait N fois ce travail sur l'écran qui en liste vingt, et cet écran se redessine
     toutes les secondes et demie pendant un job. On la mémorise donc le temps d'une requête —
     `memo.verifs` est vidé à chaque entrée de route. */
  const parMr = rows.some((r) => r.mr_row_id) ? verifsParMrDuTour() : new Map();
  /* CE QUE LA MERGE REQUEST DE CE PROJET EST DEVENUE. Il fallait retourner dans Reviews pour
     savoir où en était ce que la session avait produit : la note, le verdict, et s'il y a des
     commentaires en attente d'envoi. Tout est déjà en base — une requête pour toute la liste,
     pas une par ligne, sur un écran qui se redessine toutes les secondes et demie. */
  const avecRetour = unitesAvecRetour('task', taskId);
  const notesParMr = {};
  const cmtParMr = {};
  if (rows.some((r) => r.mr_row_id)) {
    const ids = [...new Set(rows.map((r) => r.mr_row_id).filter(Boolean))];
    const trous = ids.map(() => '?').join(',');
    for (const rv of db.prepare(`SELECT mr_id, note_value FROM review_version rv
      WHERE mr_id IN (${trous}) AND version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all(...ids)) {
      notesParMr[rv.mr_id] = rv.note_value;
    }
    for (const c of db.prepare(`SELECT mr_id, COUNT(*) n FROM mr_comment_draft
      WHERE mr_id IN (${trous}) GROUP BY mr_id`).all(...ids)) cmtParMr[c.mr_id] = c.n;
  }
  return rows.map((r) => {
    let questions = null;
    try { questions = r.questions_json ? JSON.parse(r.questions_json) : null; } catch { questions = null; }
    const v = r.mr_row_id ? parMr.get(r.mr_row_id) : null;
    /* MÊME condition que la route qui rend le prompt : verdict rouge ET des tests imputables à
       ces branches. Un bouton qui répondrait « rien à reprendre » une fois cliqué ferait perdre
       un geste — et une base déjà rouge n'est pas de notre fait. */
    let imputables = [];
    try { imputables = v && v.imputable_json ? JSON.parse(v.imputable_json) : []; } catch { imputables = []; }
    const echec = !!(v && v.verdict === 'verified_fail' && imputables.length);
    /* LE HANDLE DE SESSION NE VIENT PLUS DE LA LIGNE : il ne vaut que dans le `~/.claude` de la
       machine qui l'a créée, donc il vit dans `local_session`. Recollé ICI, en tête, pour que
       tout ce qui suit — `resume_cmd` compris — lise la valeur recollée et non le vide laissé
       dans la table. */
    const ligne = localsession.resoudre('task_target', r, poignees);
    return {
      ...ligne, questions, has_verify_fail: echec ? 1 : 0,
      // Le bouton « Retour de l'IA » se décide sur les PASSES, qui voyagent — pas sur un chemin local.
      has_output: (avecRetour.has(r.id) || !!r.output_path) ? 1 : 0,
      /* MÊME HISTOIRE POUR LE DIFF DE LA BRANCHE. Le patch est rangé dans un fichier de CE
         poste ; la route, elle, sait déjà le refaire depuis le clone quand il manque. Ce qui
         dit qu'il y a quelque chose à montrer, c'est le COMMIT — et lui voyage. */
      has_diff: (!!r.diff_path || !!r.commit_sha) ? 1 : 0,
      mr_note: r.mr_row_id != null ? (notesParMr[r.mr_row_id] != null ? notesParMr[r.mr_row_id] : null) : null,
      mr_verdict: v ? v.verdict : null,
      mr_drafts: r.mr_row_id ? (cmtParMr[r.mr_row_id] || 0) : 0,
      /* B5 — L'ÉTAT DU TICKET, sur la ligne de projet. La ligne dit la note, le verdict et les
         brouillons ; elle taisait le ticket, alors que `taskTargets` joint déjà la merge
         request et que `mr.ticket_jira_*` est rempli à la découverte. « Le ticket est repassé
         en cours » change ce qu'on fait de la branche autant qu'un test rouge. */
      ticket_key: r.mr_ticket_key || null,
      ticket_status: r.mr_ticket_status || null,
      ticket_category: r.mr_ticket_category || null,
      resume_cmd: agentsession.resumeCommand(ligne.session_backend, ligne.session_key, ligne.session_cwd, optionsAgent),
    };
  });
}
// MR effectivement rattachée à un projet de session : celle créée par l'app, sinon
// une MR ouverte déjà connue sur la même branche.
function effectiveMr(tg) {
  if (!tg) return null;
  if (tg.mr_iid) return { iid: tg.mr_iid, fromApp: true };
  const found = db.prepare(`SELECT iid FROM mr
    WHERE repo_id = ? AND source_branch = ? AND (closed_seen IS NULL OR closed_seen = 0)
    LIMIT 1`).get(tg.repo_id, tg.branch);
  return found ? { iid: found.iid, fromApp: false } : null;
}
function targetById(taskId, targetId) {
  return localsession.resoudre('task_target', db.prepare(`SELECT tt.*, repo.project AS project, repo.forge AS forge
    FROM task_target tt JOIN repo ON repo.id = tt.repo_id
    WHERE tt.id = ? AND tt.task_id = ?`).get(targetId, taskId));
}
// Valide la liste des projets. En codage la branche de travail est obligatoire ;
// en exploration elle est facultative (défaut : branche par défaut du dépôt).
// Vérification et normalisation des projets d'une session — partagée avec les runs d'agent.
const normalizeTargets = tasks.normalizeTargets;
const insertTargets = tasks.insertTargets;
/* Un identifiant de session est passé TEL QUEL à l'agent : `--resume <id>` pour claude,
   `COPILOT_HOME=<chemin>` pour copilot. Il ne doit donc jamais pouvoir passer pour un flag,
   et pour claude il a une forme connue — autant refuser tout de suite plutôt que d'échouer
   au milieu d'un job, une fois les dépôts clonés. */
/* Applique une session fournie aux unités d'une session (projets ou dossiers). N'écrit QUE
   si la valeur change vraiment : rouvrir la modale pour corriger un prompt ne doit pas
   réécrire des handles corrects, ni effacer le `session_cwd` qui protège la reprise.
   Un champ VIDE ne signifie jamais « efface » — on ne perd pas une session d'un formulaire
   simplement soumis ; pour repartir à neuf, on change les unités, ce qui les recrée. */
function applySessionId(scope, key, taskId, sessionId, units) {
  if (!sessionId) return;
  const commun = units.length && units.every((u) => u.session_key && u.session_key === units[0].session_key)
    ? units[0].session_key : null;
  if (sessionId === commun) return;
  /* `session_cwd` reste NUL : on ignore d'où vient la session fournie, et le garde-fou « même
     dossier » ne doit pas refuser ce que l'utilisateur a explicitement demandé. */
  for (const u of units) {
    localsession.ecrire(scope, u.uid, { session_key: sessionId, session_backend: agentsession.backendName(), session_cwd: null });
  }
}
function normalizeSessionId(raw) {
  const id = String(raw || '').trim();
  if (!id) return null;
  if (id.startsWith('-')) throw new Error(t('err.session-id-invalide'));
  if (agentsession.backendName() === 'claude'
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(t('err.session-id-uuid-attendu'));
  }
  return id;
}
// Nom de branche sûr : pas de flag (pas de `-` en tête), pas de `..`, caractères limités.
// Empêche l'injection d'arguments dans les commandes git.
const assertValidBranch = tasks.assertValidBranch;
/* ---------- Les deux premières lignes de la réponse, et ce qu'elle a coûté ----------
   Une exploration, une question libre, un codage hors dépôt : on retrouvait sa réponse en
   ouvrant « Voir la réponse », carte par carte. Les deux premières lignes utiles suffisent à
   reconnaître laquelle on cherche. On lit le fichier déjà écrit sur le disque — aucun calcul,
   et on s'arrête aux premiers milliers de caractères : la liste n'a pas à charrier des
   rapports entiers à chaque rafraîchissement, c'est-à-dire toutes les secondes et demie. */
/* LE MARQUAGE NE SE LIT PAS SUR UNE CARTE. Le chapeau est du texte nu, posé dans une ligne de
   liste : les titres et les traits étaient déjà sautés, mais `**mutex**`, `` `verrou` `` et
   `[voir ici](url)` arrivaient tels quels — on lisait les étoiles avant le mot. On retire donc
   le marquage INLINE, sans rendre le Markdown : ce qui reste est la phrase, pas sa mise en
   forme. Volontairement conservateur — un astérisque isolé dans du texte reste un astérisque. */
function sansMarquage(l) {
  return String(l)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                 // image : rien à lire sur une carte
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')               // lien : on garde le libellé
    .replace(/(\*\*|__)(.+?)\1/g, '$2')                    // gras
    .replace(/(^|\W)([*_])(?!\s)(.+?)(?<!\s)\2(?=\W|$)/g, '$1$3') // italique
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')                  // code
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')                // puce ou numéro de liste
    .replace(/^\s*>\s?/, '')                                // citation
    .trim();
}
function chapeauReponse(mdPath) {
  const texte = mdPath ? readFileSafe(mdPath) : null;
  if (!texte) return '';
  const lignes = String(texte).slice(0, 4000).split('\n')
    // On saute les titres, les traits et le vide : ce qu'on veut, c'est la première PHRASE.
    .map((l) => sansMarquage(l))
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-=*_]{3,}$/.test(l));
  return lignes.slice(0, 2).join(' ').slice(0, 220);
}
/* Ce que la dernière passe a coûté : sa durée et ses tokens estimés. La durée vient du job qui
   l'a portée, les tokens de la ligne d'usage rattachée à la session. Deux `LEFT JOIN` pour
   toute la liste, pas une requête par carte. */
function coutParSession(kind) {
  const out = {};
  for (const r of db.prepare(`SELECT owner_id AS id, SUM(tokens_est) AS tokens, SUM(cost_usd) AS cost_usd,
    MAX(created_at) AS at FROM usage WHERE owner_kind = ? AND owner_id IS NOT NULL GROUP BY owner_id`).all(kind)) {
    out[r.id] = { tokens: r.tokens || 0, cost_usd: r.cost_usd, at: r.at };
  }
  return out;
}
function dureeParSession(kind) {
  const out = {};
  const cible = kind === 'ask' ? 'ask' : (kind === 'local' ? 'local' : 'task');
  for (const j of db.prepare(`SELECT target_id AS id, started_at, finished_at FROM job
    WHERE target_kind = ? AND finished_at IS NOT NULL AND target_id IS NOT NULL
    ORDER BY id DESC`).all(cible)) {
    if (out[j.id]) continue;                                  // on garde la PLUS RÉCENTE
    const d = Date.parse(j.finished_at) - Date.parse(j.started_at);
    out[j.id] = Number.isFinite(d) && d >= 0 ? d : null;
  }
  return out;
}
// Crée une session : `kind` = 'code' (l'IA modifie le code) ou 'explore' (lecture seule).
// `targets` = [{ repo_id, branch }] — une session peut porter sur plusieurs projets.
/* UN VÉRIFICATEUR NE SE LANCE PAS SANS CODE POUSSÉ : il travaille sur ce que la forge expose.
   Choisir un vérificateur implique donc l'auto-push, et retirer l'auto-push retire le
   vérificateur. L'écran le dit et coche la case ; le serveur le REFAIT — un client n'est pas
   un garde-fou, et l'API est appelable sans lui. */
/* Un libellé vide et un libellé absent sont la MÊME chose : NULL. Sans ça, une chaîne vide
   s'afficherait comme un titre — un titre invisible qui pousse le prompt d'un cran. */
const lireLibelle = (v) => (v == null ? null : (String(v).trim().slice(0, 120) || null));
/* Un suivi vide n'est pas un suivi : l'écran afficherait un bloc « suivi prêt » sans texte,
   avec un bouton « Envoyer » qui échouerait. Effacer le texte EST la façon de le supprimer. */
const lireSuivi = (v) => (v == null ? null : (String(v).trim() || null));
/* Enregistre le suivi en attente d'une session (codage / hors dépôt / exploration).
   Une seule table près : la colonne s'appelle pareil des deux côtés. */
/* `auto` : le suivi part-il de lui-même à la fin de la session ? Sans texte, la question ne se
   pose pas — un envoi automatique de rien n'existe pas, et laisser la case armée sur un suivi
   supprimé ferait partir le suivant sans qu'on l'ait demandé. */
function poserSuivi(table, id, valeur, auto) {
  const texte = lireSuivi(valeur);
  db.prepare(`UPDATE ${table} SET followup_draft = ?, followup_auto = ?, updated_at = ? WHERE id = ?`)
    .run(texte, (texte && auto) ? 1 : 0, new Date().toISOString(), id);
}
function lireVerifierSession(kind, autoPush, verifierId) {
  if (kind !== 'code' || !autoPush) return null;
  const id = Number(verifierId) || 0;
  if (!id) return null;
  return db.prepare('SELECT 1 FROM verifier WHERE id = ?').get(id) ? id : null;
}
/* ---------- Skills et sous-agents de fichier (lecture seule) ----------
   Le disque est la vérité : `.claude/skills/<nom>/SKILL.md` d'un dépôt cloné, et ceux du home.
   Rien n'est écrit, jamais — ni ici, ni ailleurs (spec agents §18). `repos` restreint le scan
   aux dépôts qui nous intéressent (les cibles d'une session) ; absent, tous les dépôts actifs. */
function reposPourScan(param) {
  const ids = String(param || '').split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) {
    return db.prepare(`SELECT * FROM repo WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }
  return db.prepare('SELECT * FROM repo WHERE enabled = 1 ORDER BY project').all();
}
/* Un projet de session n'a pas de numéro de MR : on le présente au dépôt fictif de démo
   sous la même forme qu'une merge request, pour réutiliser le même viewer. */
const demoMrDe = (tg) => ({
  iid: 0, project: tg.project, source_branch: tg.branch, target_branch: tg.base_branch || 'main',
});
/* Le patch de la passe, ou la raison de ne rien montrer. Une itération qui n'a rien changé au
   code (l'agent a posé des questions, ou a constaté que tout était déjà fait) n'ouvre pas une
   vue vide : elle le dit.
 *
 * LE PATCH NE VOYAGE PAS — ET N'A PAS BESOIN DE VOYAGER. C'est un fichier de la machine qui a
 * fait tourner l'agent, et l'envoyer dans le dépôt d'équipe y mettrait des centaines de
 * kilo-octets entièrement recalculables. Ce qui voyage, ce sont les deux BORNES : le commit
 * d'avant et celui d'après. Sur le poste du collègue, on redemande donc simplement le diff à
 * git — c'est le même travail que celui d'origine, sur le même clone, et le résultat est le
 * même à l'octet près. Il faut seulement que ces deux commits soient là : si la branche n'a
 * jamais été récupérée, on le DIT, avec le geste qui répare. */
async function diffDePasse(p, cwd = null) {
  const diff = agentpass.diffDe(p);
  if (diff) return diff;
  if (p.base_sha && p.head_sha && p.base_sha !== p.head_sha && cwd) {
    try {
      const recalcule = await git.diffRange(cwd, p.base_sha, p.head_sha);
      if (recalcule && recalcule.trim()) return recalcule;
    } catch { throw new Error(t('err.task.pass-diff-absent-du-clone')); }
  }
  throw new Error(t(p.head_sha && p.base_sha === p.head_sha ? 'err.task.pass-no-change' : 'err.task.pass-no-diff'));
}
/* Réconcilier : relire l'état réel des branches d'une session et réparer les projets dont le
   travail existe déjà (commit passé, échec survenu après). Aucun appel IA — contrairement à une
   relance, qui en coûterait un par dépôt pour refaire un travail déjà fait. */
/* Valide une liste d'ids de projets contre la session : un id étranger doit être refusé, pas
   ignoré en silence — sinon une faute de frappe fait tourner la session entière sans le dire. */
function normalizeTargetIds(taskId, raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const voulus = [...new Set(raw.map(Number).filter(Number.isInteger))];
  if (!voulus.length) return null;
  const connus = new Set(db.prepare('SELECT id FROM task_target WHERE task_id = ?').all(taskId).map((r) => r.id));
  const inconnus = voulus.filter((id) => !connus.has(id));
  if (inconnus.length) throw new Error(t('err.projet-introuvable-pour-cette-session-2'));
  return voulus;
}
/* ---- « Codage hors dépôt » : l'IA code dans des dossiers locaux, en place, sans git ---- */
// Dossiers d'une session hors dépôt + la commande de reprise de leur session d'agent.
function localDirsFor(taskId) {
  /* LE CHEMIN NE VIENT PLUS DE LA LIGNE. Il vivait ici en absolu — `/Users/amady/lin/monprojet`,
     qui ne désigne rien sur le Linux du collègue alors que la SESSION, elle, se partage. La
     ligne ne porte donc que l'empreinte, le libellé et le propriétaire ; le chemin est résolu
     ICI, dans la carte de ce poste. Absent, `path` vaut `null` : le dossier appartient à
     quelqu'un d'autre, la session se relit mais ne se relance pas. */
  const carteDirs = localdirs.carte();
  const poignees = localsession.carte('local_task_dir');
  const avecRetour = unitesAvecRetour('local', taskId);
  return db.prepare('SELECT * FROM local_task_dir WHERE task_id = ? ORDER BY id').all(taskId)
    .map((brute) => localsession.resoudre('local_task_dir', brute, poignees))
    .map((d) => ({
      ...d,
      has_output: (avecRetour.has(d.id) || !!d.output_path) ? 1 : 0,
      path: carteDirs.get(d.dir_hash) || null,
      // Sur la ligne RECOLLÉE à `local_session` : la ligne brute n'a plus la poignée.
      resume_cmd: agentsession.resumeCommand(d.session_backend, d.session_key, d.session_cwd),
      // Les questions posées par l'agent, prêtes à afficher. Illisibles → aucune, plutôt qu'un plantage.
      questions: d.questions_json ? (() => { try { return JSON.parse(d.questions_json); } catch { return null; } })() : null,
    }));
}
function localTaskById(id) {
  const lt = avecRangement('local_task', db.prepare('SELECT * FROM local_task WHERE id = ?').get(id));
  if (!lt) return null;
  lt.dirs = localDirsFor(id);
  return lt;
}
/* Un suivi ne part qu'une fois. On le retire AVANT de lancer — sinon deux clics rapides
   partent deux fois — et on le remet si le lancement échoue, pour ne pas perdre le texte
   sur une session qui tournait déjà. */
function envoyerSuivi(table, session, lancer) {
  const garde = session.followup_draft;
  if (garde) poserSuivi(table, session.id, null, 0);
  try { return lancer(); } catch (e) {
    if (garde) poserSuivi(table, session.id, garde, session.followup_auto);   // texte ET case
    throw e;
  }
}
/* Même geste pour une session hors dépôt. Sans cette route, la croix de l'encart d'erreur
   retirait la boîte de l'écran et l'erreur revenait au rafraîchissement suivant : un bouton
   qui a l'air de marcher est pire qu'un bouton absent. */
/* Relance CIBLÉE d'une session hors dépôt : un dossier précis, ou ceux qui ont échoué. Même
   contrat que `POST /api/tasks/:id/run` avec ses `targets` — les dossiers d'une session sont
   indépendants les uns des autres, et refaire les quatre qui ont réussi coûte quatre passes
   d'agent pour rien. Corps vide = toute la session, comme avant. */
function normalizeDirIds(taskId, brut) {
  if (!Array.isArray(brut) || !brut.length) return null;
  const connus = new Set(db.prepare('SELECT id FROM local_task_dir WHERE task_id = ?').all(taskId).map((d) => d.id));
  const ids = [...new Set(brut.map(Number).filter((n) => connus.has(n)))];
  if (!ids.length) throw new Error(t('err.local-dir-not-found'));
  return ids;
}

module.exports = {
  taskById, taskTargets, effectiveMr, targetById, normalizeTargets, insertTargets, applySessionId, normalizeSessionId, assertValidBranch, sansMarquage, chapeauReponse, coutParSession, dureeParSession, lireLibelle, lireSuivi, poserSuivi, lireVerifierSession, reposPourScan, demoMrDe, diffDePasse, normalizeTargetIds, localDirsFor, localTaskById, envoyerSuivi, normalizeDirIds,
};
