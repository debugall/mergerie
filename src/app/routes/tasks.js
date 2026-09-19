'use strict';
/* Une session de codage : la créer, la modifier, la partager, la ranger, la lancer, la faire converger, voir le diff de chaque cible.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('../../core/paths');
const { etat: etatLocal, pref: prefLocale } = require('../../data/localstate');
const garde = require('../../core/garde');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const jobs = require('../../jobs');
const git = require('../../git/git');
const demoDiff = require('../../demo/diff');
const agentpass = require('../../agent/pass');
const pieces = require('../../agent/pieces');
const skillscan = require('../../agent/skillscan');
const tasks = require('../../agent/tasks');
const agentprofile = require('../../agent/profile');
const path = require('path');
const fs = require('fs');
const { gardeConfigAgent, parseConvergeOpts, readFileSafe, wrap } = require('../http');
const { basculerPartage, exigerProprietaire, passesPayload } = require('../lib/partage');
const { savePiecesEtImages } = require('../lib/pieces');
const { applySessionId, demoMrDe, insertTargets, lireLibelle, lireVerifierSession, normalizeSessionId, normalizeTargetIds, normalizeTargets, reposPourScan, targetById, taskById, taskTargets } = require('../lib/sessions');
const { targetCloneCtx, viewerFile, viewerFileDiff, viewerPayload } = require('../lib/visionneuse');

app.post('/api/tasks', wrap((req, res) => {
  const { kind, prompt, commit_message, auto_push, images, targets, ask_questions, session_id, verifier_id, label } = req.body || {};
  const k = kind === 'explore' ? 'explore' : 'code';
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const sessionId = normalizeSessionId(session_id);
  const list = normalizeTargets(targets, k);
  const now = new Date().toISOString();
  /* « L'IA peut poser des questions » : opt-in, en codage COMME en exploration. Une exploration
     hésite de la même façon — « de quel des trois services parles-tu ? » vaut mieux qu'une
     synthèse à côté du sujet. Le codage hors dépôt a sa propre table, et sa propre route. */
  const ask = ask_questions ? 1 : 0;
  /* LES SKILLS COCHÉS OUVRENT LA DEMANDE. `/mon-skill` est ce que le CLI attend pour en
     invoquer un ; le nom seul, pour ceux qui refusent le `/`. La ligne est écrite DANS le
     prompt (et non gardée à part) : c'est elle que l'agent lit, et c'est elle qu'on relit
     en rouvrant la session pour comprendre ce qui a été demandé. */
  const enTeteSkills = skillscan.ligneSkills(req.body && req.body.skills, {
    repos: reposPourScan(list.map((x) => x.repo_id).join(',')), cfg: getConfig(),
  });
  const promptFinal = (enTeteSkills ? `${enTeteSkills}\n\n` : '') + prompt.trim();
  /* UN RUN D'AGENT EST UNE SESSION : la route accepte `agent_id`, recopie le nom du profil et
     compose sa demande. `auto_push` est alors forcé à 0 — un agent ne pousse jamais de
     lui-même (spec agents, règle 1), quoi qu'ait coché le formulaire. */
  const profil = req.body && req.body.agent_id ? agentprofile.lire(Number(req.body.agent_id)) : null;
  /* A18 — LE BROUILLON D'UN PROFIL QU'ON ESSAIE. « Essai » n'ouvrait qu'une session pré-remplie
     du gabarit : modèle, outils, sous-agents et prompt système restaient à quai, donc on
     essayait tout sauf ce qu'on venait de régler. Le brouillon voyage avec la session et sert
     d'options ; aucun agent n'est créé — essayer ne doit rien laisser derrière. On VALIDE ici
     ce qui échouerait au lancement, comme à la sauvegarde d'un vrai profil. */
  const brouillon = (!profil && req.body && req.body.agent_draft) ? agentprofile.brouillonValide(req.body.agent_draft) : null;
  const compose = profil ? agentprofile.composer(profil, { question: promptFinal, targets: list, kind: k }) : null;
  const taskId = tasks.creerTask({
    kind: k,
    prompt: compose ? compose.prompt : promptFinal,
    // `task.branch` est un héritage mono-projet (la vérité est dans task_target) et
    // la colonne est NOT NULL : en exploration la branche est facultative, on y range
    // donc '' plutôt que NULL — sinon la création échoue sur une erreur SQL brute.
    branch: list[0].branch || '',
    commitMessage: (commit_message || '').trim() || null,
    autoPush: profil ? 0 : (auto_push ? 1 : 0),
    askQuestions: ask,
    verifierId: lireVerifierSession(k, profil ? 0 : auto_push, verifier_id),
    label: lireLibelle(label) || (profil ? profil.name : null),
    // B5 : décoché par défaut — écrire chez les autres se décide, session par session.
    notifyJira: req.body && req.body.notify_jira ? 1 : 0,
    // B9 : idem — une review coûte un appel IA, elle se demande.
    reviewAfter: req.body && req.body.review_after ? 1 : 0,
    targets: list,
    sessionId,
    agentId: profil ? profil.id : null,
    agentName: profil ? profil.name : (brouillon ? brouillon.name : null),
    triggeredBy: 'manual',
    agentQuestion: profil ? promptFinal : null,
    agentDraft: brouillon,
    // Partager cette session-là : décoché par défaut, et la case n'apparaît qu'en mode partagé.
    shared: req.body && req.body.shared ? 1 : 0,
  });
  savePiecesEtImages('task', taskId, req.body || {});
  res.json({ ...taskById(taskId), targets: taskTargets(taskId) });
}));
app.put('/api/tasks/:id', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const { prompt, commit_message, auto_push, images, targets, ask_questions, session_id, verifier_id, label } = req.body || {};
  const sessionId = normalizeSessionId(session_id);
  if (Array.isArray(targets) && targets.length) {
    const list = normalizeTargets(targets, tache.kind);
    /* On ne recrée les cibles que si la COMPOSITION change : sinon on perdrait leur état
       d'exécution (commit, diff, MR, handle de session).

       La comparaison ne porte donc que sur ce que l'utilisateur a CHOISI. Pour une
       exploration, `base_branch` n'est pas un choix : c'est la branche que le run a
       RÉSOLUE et réécrite sur chaque cible. Elle la faisait donc différer du formulaire —
       qui n'en envoie aucune — et rouvrir une exploration terminée pour l'enregistrer sans
       rien changer remettait tous ses dépôts « à exécuter », sous une session « terminée ».
       `|| ''` sur la branche pour la même raison : `null` et `''` désignent ici la même
       absence de choix, mais ne s'écrivent pas pareil dans une clé. */
    const key = (x) => [x.repo_id, x.branch || '', tache.kind === 'explore' ? '' : (x.base_branch || '')].join(':');
    const cur = taskTargets(tache.id).map(key).join('|');
    if (cur !== list.map(key).join('|')) {
      db.prepare('DELETE FROM task_target WHERE task_id = ?').run(tache.id);
      insertTargets(tache.id, list);
    }
  }
  db.prepare('UPDATE task SET prompt = ?, commit_message = ?, auto_push = ?, ask_questions = ?, verifier_id = ?, label = ?, notify_jira = ?, review_after = ?, updated_at = ? WHERE id = ?').run(
    prompt != null ? String(prompt).trim() : tache.prompt,
    commit_message != null ? (String(commit_message).trim() || null) : tache.commit_message,
    auto_push == null ? tache.auto_push : (auto_push ? 1 : 0),
    // Absent du body → on garde la valeur actuelle (codage et exploration l'acceptent).
    ask_questions == null ? tache.ask_questions : (ask_questions ? 1 : 0),
    /* La règle s'applique à la valeur EXISTANTE autant qu'à celle qu'on envoie : décocher
       l'auto-push sans renvoyer le champ laissait sinon un vérificateur qui ne pourrait plus
       tourner, et on ne s'en apercevrait qu'à la fin de la session. */
    lireVerifierSession(tache.kind, auto_push == null ? tache.auto_push : auto_push,
      verifier_id === undefined ? tache.verifier_id : verifier_id),
    label === undefined ? tache.label : lireLibelle(label),
    // Absent du body → on garde la valeur actuelle, comme les autres cases de la modale.
    (req.body && req.body.notify_jira) === undefined ? tache.notify_jira : (req.body.notify_jira ? 1 : 0),
    (req.body && req.body.review_after) === undefined ? tache.review_after : (req.body.review_after ? 1 : 0),
    new Date().toISOString(), tache.id,
  );
  savePiecesEtImages('task', tache.id, req.body || {});
  // Après une éventuelle recréation des cibles : celles-ci repartent sans handle.
  applySessionId('task_target', 'task_id', tache.id, sessionId, taskTargets(tache.id));
  res.json({ ...taskById(tache.id), targets: taskTargets(tache.id) });
}));
app.delete('/api/tasks/:id', wrap((req, res) => {
  /* LA SESSION D'UN COLLÈGUE NE SE SUPPRIME PAS : la supprimer ici retirerait son fichier du
     dépôt, et la ligne disparaîtrait chez son auteur au `pull` suivant. On la range. */
  const aSupprimer = taskById(Number(req.params.id));
  if (aSupprimer) exigerProprietaire('task', aSupprimer);
  db.prepare('DELETE FROM task_target WHERE task_id = ?').run(Number(req.params.id));
  agentpass.removeTask('task', Number(req.params.id));   // pas de FK : nettoyage explicite
  pieces.removeOwner('task', Number(req.params.id));     // idem pour les pièces jointes
  db.prepare('DELETE FROM task WHERE id = ?').run(Number(req.params.id));
  try { fs.rmSync(path.join(TASKS_DIR, String(Number(req.params.id))), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));
/* Ranger / ressortir une session. Volontairement séparé de PUT /tasks/:id : c'est un geste
   de rangement, qui doit rester possible sur une session en cours d'exécution — le PUT, lui,
   refuse d'éditer une session lancée. */
/* Partager CETTE session-là, ou cesser de la partager. Volontairement à côté de `/hidden` : ce
   sont les deux gestes qu'on fait sur une session sans y toucher — l'un est pour soi, l'autre
   pour l'équipe. */
app.post('/api/tasks/:id/share', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const shared = basculerPartage('task', 'task', t2, req.body && req.body.shared);
  res.json({ ok: true, shared, task: taskById(t2.id) });
}));
app.post('/api/tasks/:id/hidden', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  prefLocale.ecrire('task', t2.uid, 'hidden', hidden ? '1' : null);
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), t2.id);
  res.json({ ok: true, hidden });
}));
/* MÊME HISTOIRE QUE POUR UNE REVIEW, ET MÊME REMÈDE (cf. `diffDeLaMr`). `target.diff_path` est
 * un fichier de la machine qui a fait tourner l'agent : le poste qui REÇOIT la session ne l'a
 * pas, et il ouvrait « Voir le diff » sur du vide.
 *
 * Un repli existait pourtant — `branchDiff` — mais il comparait `origin/<base>...HEAD`, et HEAD
 * c'est la branche sur laquelle le clone se trouve, pas celle de la session. Sur le poste
 * d'origine il ne servait jamais (le fichier est là) ; ailleurs, il répondait le diff d'un
 * travail sans rapport, ou rien. On vise donc le COMMIT de la session — celui-là même que
 * l'arbre affiche à côté, pour que les deux parlent de la même version.
 */
async function diffDeLaCible(tg, cwdConnu = null) {
  const garde = tg.diff_path ? readFileSafe(tg.diff_path) : null;
  if (garde) return garde;
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  if (!repo && !cwdConnu) return null;
  try {
    let cwd = cwdConnu || git.cloneDirFor(getConfig(), repo);
    const base = `origin/${tg.base_branch || 'main'}`;
    const vise = async () => (tg.commit_sha && await git.refExists(cwd, tg.commit_sha)
      ? tg.commit_sha
      : (tg.branch && await git.refExists(cwd, `origin/${tg.branch}`) ? `origin/${tg.branch}` : null));
    let ref = await vise();
    /* LE CLONE PEUT ÊTRE EN RETARD : la branche de la session a été poussée après le dernier
       fetch de ce poste. On ne va chercher qu'à ce moment-là. */
    if (repo && (!ref || !await git.refExists(cwd, base))) {
      cwd = await git.ensureRepo(getConfig(), repo, () => {});
      ref = await vise();
    }
    if (!ref || !await git.refExists(cwd, base)) return null;
    return await git.diffTroisPoints(cwd, base, ref);
  } catch { return null; }
}
// Diff d'UN projet de la session.
app.get('/api/tasks/:id/targets/:tid/diff', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json({ diff: await diffDeLaCible(tg), project: tg.project, branch: tg.branch });
}));
/* Viewer plein écran d'un projet de session : MÊMES trois routes que pour une MR
   (`viewerPayload` / `viewerFile` / `viewerFileDiff`), donc le front réutilise le
   même composant en changeant seulement la base d'URL. */
app.get('/api/tasks/:id/targets/:tid/diffview', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (demoDiff.isDemo()) {
    res.json({ ...demoDiff.viewFor(demoMrDe(tg)), project: tg.project, branch: tg.branch });
    return;
  }
  const ctx = targetCloneCtx(tg);
  /* Le diff produit par la session est stocké ; s'il manque — session ancienne, ou session
     REÇUE de l'équipe —, on le recalcule entre la branche de départ et le commit de la
     session, qui est justement la référence que `ctx` affiche. */
  const diff = await diffDeLaCible(tg, ctx.cwd);
  res.json({
    ...(await viewerPayload(ctx, { diff: diff || '', source: tg.branch })),
    project: tg.project, branch: tg.branch,
  });
}));
app.get('/api/tasks/:id/targets/:tid/file', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileFor(demoMrDe(tg), String(req.query.path || ''))); return; }
  res.json(await viewerFile(targetCloneCtx(tg), String(req.query.path || '')));
}));
app.get('/api/tasks/:id/targets/:tid/filediff', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileDiffFor(demoMrDe(tg), String(req.query.path || ''))); return; }
  res.json(await viewerFileDiff(targetCloneCtx(tg), String(req.query.path || '')));
}));
/* Historique des ITÉRATIONS d'un projet de session : une entrée par passe, avec le
   prompt réellement envoyé et le retour de l'agent. `?n=` renvoie une passe précise. */
app.get('/api/tasks/:id/targets/:tid/passes', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json(passesPayload('task', tg.id, Number(req.params.id), req.query.n, `${tg.project} — ${tg.branch}`, tg.output_path));
}));
app.post('/api/tasks/:id/reconcile', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  if (t2.kind !== 'code') throw new Error(t('err.reconcile-code-only'));
  res.json(jobs.startReconcileJob(t2.id));
}));
/* `targets` (facultatif) restreint la passe à certains projets de la session. Sans lui, toute
   la session part — comportement d'origine. Sert au bouton « Lancer » de chaque projet et à
   « relancer les projets en échec ». */
app.post('/api/tasks/:id/run', wrap(async (req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const targetIds = normalizeTargetIds(tache.id, req.body && req.body.targets);
  if (tache.kind === 'code') {
    for (const tg of db.prepare('SELECT * FROM task_target WHERE task_id = ?').all(tache.id)) {
      if (targetIds && !targetIds.includes(tg.id)) continue;
      await gardeConfigAgent(db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id), tg.branch, tg.base_branch, req.body);
    }
  }
  // Lancer à la main annule le lancement programmé : la session ne doit pas partir deux fois.
  jobs.programmation.programmer('task', tache.uid, 'run', null);
  res.json(jobs.startTaskJob(tache.id, 'run', targetIds ? { targetIds } : {}));
}));
// « Converger » une session de dev : du prompt à la/les MR convergée(s). L'IA code,
// pousse, crée la MR, puis lance la boucle de convergence (par projet, en série).
app.post('/api/tasks/:id/converge', wrap((req, res) => {
  const task = taskById(Number(req.params.id));
  if (!task) throw new Error(t('err.session-introuvable'));
  if (task.kind !== 'code') throw new Error(t('err.converge-session-code-only'));
  res.json(jobs.startConvergeSessionJob(task.id, parseConvergeOpts(req.body)));
}));
