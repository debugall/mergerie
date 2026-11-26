'use strict';
/* LA CHAÎNE DE VALIDATION D'UNE SESSION DE CODAGE. Des vérificateurs dans un ordre (`task.verify_chain`),
   chacun lancé sur la BASE de la session, puis — vert — sur sa BRANCHE de travail, l'un après l'autre.

   — DEUX ESSAIS PAR CÔTÉ. Un rouge (ou une erreur) relance le même vérificateur, du même côté, une fois.
     Rouge deux fois sur la base : la base est cassée, ce vérificateur s'arrête là et attend l'utilisateur
     (« À toi »), les suivants continuent — ils ne dépendent pas de lui. Rouge deux fois sur la branche :
     la branche casse ce vérificateur, même arrêt.
   — UNE RELANCE NE REJOUE QUE CE QUI N'EST PAS VERT. « Relancer » oublie les échecs des côtés cassés ;
     un côté vert reste vert. Sauf la BRANCHE quand un correctif a été poussé : un vert ne vaut que pour
     les commits qu'il a vus (`sig`, les SHA des projets de la session au lancement), un nouveau commit
     rejoue la branche de chaque vérificateur — un correctif peut casser autre chose.
   — LE VÉRIFICATEUR N'A PAS À COUVRIR LES DÉPÔTS DE LA SESSION. Il tourne sur ses dépôts à lui (le dépôt
     de tests, typiquement) ; les dépôts de la session qu'il ne couvre pas sont mis sur la base ou sur la
     branche, selon le côté, dans le clone LOCAL de l'utilisateur le temps du run (`positions`, comme les
     préparations de Git → Vérificateur), puis remis.
   — UN VÉRIFICATEUR NE TOURNE JAMAIS DEUX FOIS EN MÊME TEMPS : sa vérification réserve `verifier:<id>`
     dans la file (`jobKeys`) — lancé ailleurs, il attend son tour.

   L'état de chaque côté se DÉDUIT des verdicts de ses vérifications : un serveur coupé au milieu ne
   laisse rien « en cours » pour toujours. Seuls sont stockés, par côté, les lancements (`runs`) et le
   point à partir duquel on compte les échecs (`depuis`, avancé par « Relancer »). */
const db = require('../db');
const notify = require('../core/notify');
const notes = require('../notes/notes');
const groupes = require('../data/groupes');
const { t } = require('../core/i18n');
const { appliquerModes, creerVerification } = require('./verifications');
const { cloneLocalDe } = require('./plan-verif');
const diagnostic = require('./chaine-diagnostic');
const scenarioMod = require('./chaine-scenario');

const ESSAIS = 2;
const COTES = ['base', 'head'];
const ACTIVE = new Set(['queued', 'running']);
const maintenant = () => new Date().toISOString();
const lire = (j, defaut) => { try { return JSON.parse(j); } catch { return defaut; } };

/* Les vérificateurs choisis pour une session, dans l'ordre, sans doublon ni inconnu. */
function idsChaine(task) {
  const ids = lire(task && task.verify_chain, []);
  return Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Boolean))] : [];
}
function normaliserChaine(valeur) {
  if (valeur == null || valeur === '') return null;
  const ids = (Array.isArray(valeur) ? valeur : lire(valeur, [])).map(Number).filter(Boolean);
  const connus = [...new Set(ids)].filter((id) => db.prepare('SELECT 1 FROM verifier WHERE id = ?').get(id));
  return connus.length ? JSON.stringify(connus) : null;
}

function chaineDe(taskId) {
  const c = db.prepare('SELECT * FROM verif_chaine WHERE task_id = ?').get(Number(taskId));
  return c ? { ...c, steps: lire(c.steps_json, []), scenario: lire(c.scenario_json, null) } : null;
}
const ecrireScenario = (id, scen) => db.prepare('UPDATE verif_chaine SET scenario_json = ?, updated_at = ? WHERE id = ?')
  .run(scen ? JSON.stringify(scen) : null, maintenant(), id);
// Le scénario de couverture choisi pour la session (étape 3), ou rien.
const configScenario = (task) => lire(task && task.verify_chain_scenario, null);
const ecrire = (id, steps, status) => db.prepare('UPDATE verif_chaine SET steps_json = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?')
  .run(JSON.stringify(steps), status || null, maintenant(), id);

/* Les projets de la session qui ont du code poussé : la branche, sa base, et le commit produit. */
function projets(taskId) {
  return db.prepare(`SELECT tt.repo_id, tt.branch, tt.base_branch, tt.commit_sha FROM task_target tt
    WHERE tt.task_id = ? AND tt.commit_sha IS NOT NULL AND tt.branch IS NOT NULL ORDER BY tt.id`).all(Number(taskId))
    .filter((p, i, tous) => tous.findIndex((x) => x.repo_id === p.repo_id) === i);
}
/* Ce que la branche « est » en ce moment : les commits de ses projets. Un vert de branche ne vaut que
   pour cette signature. */
const signature = (taskId) => projets(taskId).map((p) => `${p.repo_id}:${p.commit_sha}`).join(',');

/* ---------- L'état d'un côté, déduit ---------- */

function verifs(ids) {
  if (!ids.length) return new Map();
  return new Map(db.prepare(`SELECT id, status, verdict FROM verification WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids).map((v) => [v.id, v]));
}
/* `etat` : 'todo' (à lancer) | 'queued' | 'running' | 'pass' | 'broken' (rouge ESSAIS fois) ;
   `essai` : le rang du prochain lancement (ou de celui en cours), à partir de 1. */
function etatCote(cote, quoi, sig, parId) {
  const runs = (cote.runs || []).slice(cote.depuis || 0).filter((r) => quoi === 'base' || r.sig === sig);
  const dernier = runs[runs.length - 1];
  const v = dernier ? parId.get(dernier.verification_id) : null;
  if (v && ACTIVE.has(v.status)) return { etat: v.status, essai: runs.length, verification_id: v.id };
  if (v && v.verdict === 'verified_pass') return { etat: 'pass', essai: runs.length, verification_id: v.id };
  // Un rouge, une erreur, une base cassée : un échec. Une vérification disparue ne compte pas.
  const echecs = runs.filter((r) => { const x = parId.get(r.verification_id); return x && !ACTIVE.has(x.status); }).length;
  if (echecs >= ESSAIS) return { etat: 'broken', essai: echecs, verification_id: v ? v.id : null };
  return { etat: 'todo', essai: echecs + 1, verification_id: v ? v.id : null, verdict: v ? v.verdict : null };
}
function etat(chaine) {
  const sig = signature(chaine.task_id);
  const parId = verifs(chaine.steps.flatMap((s) => COTES.flatMap((c) => ((s[c] || {}).runs || []).map((r) => r.verification_id))));
  return chaine.steps.map((s) => {
    const base = etatCote(s.base || {}, 'base', sig, parId);
    const head = base.etat === 'pass' ? etatCote(s.head || {}, 'head', sig, parId) : { etat: 'waiting', essai: 0 };
    return { verifier_id: s.verifier_id, verifier_name: s.verifier_name, base, head };
  });
}

/* ---------- Lancer un côté ---------- */

/* Les cibles d'un côté : les dépôts que le vérificateur couvre — ceux de la session sur la base ou la
   branche, les siens (dépôt de tests) sur leur branche par défaut — et les positions : les dépôts de la
   session qu'il ne couvre pas, mis sur la même ref dans le clone local. */
async function preparerCote(verifier, taskId, quoi, { refTests = null } = {}) {
  const couverts = groupes.couvertureVerifier(verifier.id);
  const siens = projets(taskId);
  if (!siens.length) throw new Error(t('err.chaine.nothing-pushed'));
  const refDe = (p) => (quoi === 'base' ? (p.base_branch || 'HEAD') : p.branch);
  const cibles = [];
  for (const p of siens.filter((x) => couverts.has(x.repo_id))) {
    // La branche : le commit même que la signature décrit — le vert dira ce qu'il a vu.
    const ref = quoi === 'base' ? `origin/${refDe(p)}` : p.commit_sha;
    cibles.push({ repo_id: p.repo_id, mr_id: null, head_sha: ref, base_sha: null, branch: refDe(p), tag: null, mode: 'worktree' });
  }
  for (const repoId of couverts.keys()) {
    if (siens.some((p) => p.repo_id === repoId)) continue;
    if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) continue;
    // Le dépôt de tests : sa branche par défaut, ou celle du scénario écrit pour cette session.
    cibles.push({ repo_id: repoId, mr_id: null, head_sha: `origin/${refTests || 'HEAD'}`, base_sha: null, branch: refTests || 'HEAD', tag: null, mode: 'worktree' });
  }
  if (!cibles.length) throw new Error(t('err.plan.verifier-covers-none', { name: verifier.name }));
  const positions = [];
  for (const p of siens.filter((x) => !couverts.has(x.repo_id))) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(p.repo_id);
    if (!repo) continue;
    positions.push({ repo_id: repo.id, project: repo.project, branch: refDe(p), tag: null, workdir: await cloneLocalDe(repo) });
  }
  return { cibles: appliquerModes(verifier, cibles), positions };
}

const enCours = new Set();   // chaînes en train de lancer leur côté suivant (les attentes ci-dessus)

async function lancerCote(chaine, index, quoi) {
  const step = chaine.steps[index];
  const sig = signature(chaine.task_id);
  let run;
  try {
    const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(step.verifier_id);
    if (!verifier) throw new Error(t('err.verify.verifier-gone'));
    const { cibles, positions } = await preparerCote(verifier, chaine.task_id, quoi);
    // En file plutôt que refusé : le même dépôt ou le même vérificateur occupé ailleurs fait attendre.
    const { verification } = creerVerification({ verifier, cibles, enFile: true, automatique: true, positions });
    db.prepare('UPDATE verification SET chaine_id = ? WHERE id = ?').run(chaine.id, verification.id);
    run = { verification_id: verification.id, sig, at: maintenant() };
  } catch (e) {
    run = null;
    const frais = chaineDe(chaine.task_id);
    frais.steps[index] = { ...frais.steps[index], erreur: e.message };
    ecrire(frais.id, frais.steps, 'attention');
    signalerAttention(frais);
    return null;
  }
  const frais = chaineDe(chaine.task_id);
  const cote = { runs: [], depuis: 0, ...(frais.steps[index][quoi] || {}) };
  cote.runs = [...cote.runs, run];
  frais.steps[index] = { ...frais.steps[index], [quoi]: cote, erreur: null };
  ecrire(frais.id, frais.steps, 'running');
  return run.verification_id;
}

/* ---------- Avancer ---------- */

/* Le côté suivant, s'il y en a un à lancer et que rien ne tourne déjà pour cette chaîne. Sinon, la
   chaîne est finie : toute verte (validée), ou arrêtée sur ce qui attend l'utilisateur. */
async function avancer(taskId) {
  let chaine = chaineDe(taskId);
  if (!chaine || enCours.has(chaine.id)) return null;
  /* UN DIAGNOSTIC EN ROUTE : la session va pousser (ou non) un correctif, rien ne part avant. Fini sans
     être passé par `apresSession` (session en erreur, arrêtée) : on le conclut ici. */
  if (chaine.steps.some((s) => s.diag && s.diag.en_cours)) {
    if (diagnostic.enRoute(chaine.task_id)) return null;
    conclureDiagnostics(chaine);
    chaine = chaineDe(taskId);
  }
  // Même règle pour le scénario : la session l'écrit (ou le corrige), on attend — sinon, conclu sans écrire.
  if (chaine.scenario && chaine.scenario.en_cours) {
    if (scenarioMod.enRoute(chaine.task_id)) return null;
    await conclureScenario(chaine, { ecrire: false });
    chaine = chaineDe(taskId);
  }
  const etats = etat(chaine);
  if (etats.some((s) => ACTIVE.has(s.base.etat) || ACTIVE.has(s.head.etat))) return null;
  const sig = signature(chaine.task_id);
  if (chaine.scenario && ACTIVE.has((etatScenario(chaine.scenario, sig) || {}).etat)) return null;
  for (let i = 0; i < etats.length; i += 1) {
    if (chaine.steps[i].erreur) continue;
    for (const quoi of COTES) {
      if (etats[i][quoi].etat !== 'todo') continue;
      enCours.add(chaine.id);
      try { return await lancerCote(chaine, i, quoi); } finally { enCours.delete(chaine.id); }
    }
    // La branche casse ce vérificateur : la session qui l'a écrite cherche pourquoi (étape 2).
    if (etats[i].head.etat === 'broken' && diagnostic.peutDiagnostiquer(chaine.steps[i], sig)) {
      return lancerDiagnostic(chaine, i, etats[i].head.verification_id, sig);
    }
  }
  let finale = etats.every((s) => s.head.etat === 'pass') && !chaine.steps.some((s) => s.erreur) ? 'passed' : 'attention';
  /* TOUT EST VERT : le scénario de couverture, s'il est demandé (étape 3). Il écrit, lance, corrige ; il ne
     rend la main qu'arrêté — validé, ou « À toi ». */
  if (finale === 'passed') {
    const task = db.prepare('SELECT * FROM task WHERE id = ?').get(chaine.task_id);
    const cfg = configScenario(task);
    if (cfg) {
      const r = await phaseScenario(chaine, task, cfg, sig);
      if (r === 'lance') return null;
      finale = r;
    }
  }
  if (finale !== chaine.status) {
    ecrire(chaine.id, chaine.steps, finale);
    if (finale === 'passed' || finale === 'validated') {
      notes.fermerTodoAuto('chaine_verif', chaine.task_id);
      notify.push('session_done', { task_id: chaine.task_id, chaine: finale });
    } else signalerAttention(chaine);
  }
  return null;
}

/* ---------- Le diagnostic ---------- */

function lancerDiagnostic(chaine, index, verificationId, sig) {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(chaine.task_id);
  const step = chaine.steps[index];
  let diag;
  try {
    diag = diagnostic.lancer(task, step, verificationId, sig, { couverts: groupes.couvertureVerifier(step.verifier_id), projets: projets(task.id) });
  } catch (e) {
    chaine.steps[index] = { ...step, erreur: e.message };
    ecrire(chaine.id, chaine.steps, 'attention');
    signalerAttention(chaine);
    return null;
  }
  chaine.steps[index] = { ...step, diag };
  ecrire(chaine.id, chaine.steps, 'running');
  return null;
}
/* Ce que la session a rendu, écrit sur l'étape : la cause et sa preuve, pour la carte. */
function conclureDiagnostics(chaine) {
  const steps = chaine.steps.map((s) => (s.diag && s.diag.en_cours
    ? { ...s, diag: { ...s.diag, en_cours: null, dernier: diagnostic.conclure(chaine.task_id, s.diag) } }
    : s));
  ecrire(chaine.id, steps, null);
}

/* ---------- Le scénario de couverture ---------- */

function etatScenario(scen, sig) {
  if (!scen || !scen.sha) return null;
  return etatCote({ runs: scen.runs || [], depuis: scen.depuis || 0 }, 'head', `${sig}|${scen.sha}`,
    verifs((scen.runs || []).map((r) => r.verification_id)));
}
/* Rend 'lance' (quelque chose part : la session ou le scénario), 'validated' ou 'attention'. */
async function phaseScenario(chaine, task, cfg, sig) {
  const scen = chaine.scenario || {};
  if (scen.couvert) return 'validated';
  if (scen.erreur) return 'attention';
  const tests = scenarioMod.depotTests(cfg.verifier_id, projets(task.id), groupes.couvertureVerifier);
  if (!tests) { ecrireScenario(chaine.id, { ...scen, erreur: t('task.chaine.scen.no-test-repo') }); return 'attention'; }
  if (!scen.sha) {
    if (scen.ecrit) return 'attention';   // la session n'a rien rendu d'utilisable : `erreur` le dit déjà
    ecrireScenario(chaine.id, { ...scenarioMod.lancerAgent(task, scen, { cfg, tests, quoi: 'ecrire', sig }), ecrit: true });
    ecrire(chaine.id, chaine.steps, 'running');
    return 'lance';
  }
  const e = etatScenario(scen, sig);
  if (e.etat === 'pass') return 'validated';
  if (e.etat === 'todo') { await lancerScenario(chaine, cfg, scen, sig); return 'lance'; }
  if (e.etat === 'broken' && (scen.corrections || 0) < scenarioMod.MAX_CORRECTIONS) {
    ecrireScenario(chaine.id, scenarioMod.lancerAgent(task, scen, { cfg, tests, quoi: 'corriger', verificationId: e.verification_id, sig }));
    ecrire(chaine.id, chaine.steps, 'running');
    return 'lance';
  }
  return 'attention';
}
async function lancerScenario(chaine, cfg, scen, sig) {
  try {
    const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(cfg.verifier_id);
    if (!verifier) throw new Error(t('err.verify.verifier-gone'));
    const { cibles, positions } = await preparerCote(verifier, chaine.task_id, 'head', { refTests: scen.branche });
    const { verification } = creerVerification({ verifier, cibles, enFile: true, automatique: true, positions });
    db.prepare('UPDATE verification SET chaine_id = ?, scenario = ? WHERE id = ?').run(chaine.id, (scen.fichiers || []).join(' '), verification.id);
    ecrireScenario(chaine.id, { ...scen, runs: [...(scen.runs || []), { verification_id: verification.id, sig: `${sig}|${scen.sha}`, at: maintenant() }] });
    ecrire(chaine.id, chaine.steps, 'running');
  } catch (e) {
    ecrireScenario(chaine.id, { ...scen, erreur: e.message });
    ecrire(chaine.id, chaine.steps, 'attention');
    signalerAttention(chaine);
  }
}
async function conclureScenario(chaine, { ecrire: ecrireFichiers, onLog } = {}) {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(chaine.task_id);
  const cfg = configScenario(task) || {};
  const tests = cfg.verifier_id ? scenarioMod.depotTests(cfg.verifier_id, projets(task.id), groupes.couvertureVerifier) : null;
  ecrireScenario(chaine.id, await scenarioMod.conclure(task, chaine.scenario, { tests, ecrire: ecrireFichiers, onLog }));
}

/* « À toi » : la notification d'une question, et une todo qui reste sous les yeux. */
function signalerAttention(chaine) {
  const tache = db.prepare('SELECT label, prompt FROM task WHERE id = ?').get(chaine.task_id) || {};
  const quoi = (tache.label || tache.prompt || '').split('\n')[0].slice(0, 80);
  notify.push('needs_input', { task_id: chaine.task_id, chaine: 1 });
  try {
    notes.todoAuto('chaine_verif', chaine.task_id,
      t('task.chaine.todo-title', { id: chaine.task_id, quoi }), t('task.chaine.todo-note'));
  } catch { /* une todo qu'on n'a pas pu poser ne doit pas arrêter la chaîne */ }
}

/* ---------- Les portes ---------- */

/* Les étapes d'une chaîne, refaites sur la liste de vérificateurs de la session : un vérificateur
   gardé garde ses lancements, un retiré disparaît, un ajouté arrive vierge. */
function etapesPour(task, anciennes = []) {
  return idsChaine(task).map((id) => {
    const avant = anciennes.find((s) => s.verifier_id === id);
    const nom = (db.prepare('SELECT name FROM verifier WHERE id = ?').get(id) || {}).name || `#${id}`;
    return avant ? { ...avant, verifier_name: nom } : { verifier_id: id, verifier_name: nom, base: { runs: [], depuis: 0 }, head: { runs: [], depuis: 0 } };
  });
}

/* Une session a fini une passe (code, suivi, convergence, push) : la chaîne démarre, ou reprend là où
   elle en est — un nouveau commit rend la branche à revérifier, rien d'autre. Sans chaîne choisie :
   rien. */
async function apresSession(taskId, onLog = () => {}) {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(Number(taskId));
  if (!task || task.kind === 'explore' || !idsChaine(task).length) return null;
  if (!projets(task.id).length) { onLog(t('log.chaine.skipped', { raison: t('err.chaine.nothing-pushed') })); return null; }
  const avant = chaineDe(task.id);
  const steps = etapesPour(task, avant ? avant.steps : []).map((s) => ({ ...s, erreur: null }));
  // Le statut n'est pas touché : `avancer` le recalcule, et ne redit « À toi » que s'il change.
  if (avant) ecrire(avant.id, steps, null);
  else {
    db.prepare('INSERT INTO verif_chaine (task_id, steps_json, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(task.id, JSON.stringify(steps), 'running', maintenant(), maintenant());
  }
  onLog(t('log.chaine.started', { n: steps.length, count: steps.length }));
  // Une passe de la session vient de finir : si c'était un diagnostic, sa réponse est là.
  const apres = chaineDe(task.id);
  const diagnostiquees = apres.steps.filter((s) => s.diag && s.diag.en_cours).map((s) => s.verifier_id);
  if (diagnostiquees.length) {
    conclureDiagnostics(apres);
    for (const s of chaineDe(task.id).steps.filter((x) => diagnostiquees.includes(x.verifier_id))) {
      onLog(t('log.chaine.diagnosed', { name: s.verifier_name, cause: s.diag.dernier.cause }));
    }
  }
  const avecScenario = chaineDe(task.id);
  if (avecScenario.scenario && avecScenario.scenario.en_cours) await conclureScenario(avecScenario, { ecrire: true, onLog });
  return avancer(task.id);
}

/* « Relancer » : les côtés cassés oublient leurs échecs (la base corrigée à la main, l'environnement
   réparé), les erreurs de lancement s'effacent, et la chaîne repart de ce qui n'est pas vert. */
async function relancer(taskId) {
  const chaine = chaineDe(taskId);
  if (!chaine) throw new Error(t('err.chaine.not-found'));
  const etats = etat(chaine);
  const scenActif = chaine.scenario && (chaine.scenario.en_cours
    || ACTIVE.has((etatScenario(chaine.scenario, signature(chaine.task_id)) || {}).etat));
  if (etats.some((s) => ACTIVE.has(s.base.etat) || ACTIVE.has(s.head.etat))
    || chaine.steps.some((s) => s.diag && s.diag.en_cours) || scenActif) throw new Error(t('err.chaine.running'));
  const steps = chaine.steps.map((s, i) => {
    const n = { ...s, erreur: null };
    for (const quoi of COTES) {
      if (etats[i][quoi].etat === 'broken') n[quoi] = { ...n[quoi], depuis: (n[quoi].runs || []).length };
    }
    // Relancer après une correction à la main : le diagnostic a de nouveau ses tours.
    if (etats[i].head.etat === 'broken' && n.diag && !n.diag.en_cours) n.diag = null;
    return n;
  });
  ecrire(chaine.id, steps, 'running');
  /* Le scénario : une erreur s'efface ; rouge deux fois après ses corrections, il repart de zéro. Rien
     d'écrit encore (la session n'avait rien rendu) : elle réécrit. */
  if (chaine.scenario) {
    const sc = chaine.scenario;
    const e = etatScenario(sc, signature(chaine.task_id));
    ecrireScenario(chaine.id, { ...sc, erreur: null, ecrit: sc.sha ? sc.ecrit : false,
      ...(e && e.etat === 'broken' ? { depuis: (sc.runs || []).length, corrections: 0 } : {}) });
  }
  notes.fermerTodoAuto('chaine_verif', chaine.task_id);
  await avancer(taskId);
  return resume(taskId);
}

/* Appelé par l'exécutant d'une vérification qui finit : la chaîne passe au côté suivant (ou relance le
   même, pour son deuxième essai). */
async function apresVerification(verificationId) {
  const v = db.prepare('SELECT chaine_id FROM verification WHERE id = ?').get(verificationId);
  if (!v || !v.chaine_id) return null;
  const c = db.prepare('SELECT task_id FROM verif_chaine WHERE id = ?').get(v.chaine_id);
  return c ? avancer(c.task_id) : null;
}

/* Ce que la carte de session affiche. */
function resume(taskId) {
  const chaine = chaineDe(taskId);
  if (!chaine) return null;
  const sc = chaine.scenario;
  return {
    status: chaine.status,
    // Le scénario de couverture : en écriture, couvert par un existant, ses fichiers et leur lancement.
    scenario: sc ? {
      en_cours: sc.en_cours ? sc.en_cours.quoi : null, couvert: sc.couvert || null, fichiers: sc.fichiers || [],
      branche: sc.branche || null, erreur: sc.erreur || null, corrections: sc.corrections || 0, max: scenarioMod.MAX_CORRECTIONS,
      run: etatScenario(sc, signature(chaine.task_id)),
    } : null,
    steps: etat(chaine).map((s, i) => {
      const d = chaine.steps[i].diag || null;
      return {
        ...s,
        erreur: chaine.steps[i].erreur || null,
        // Le diagnostic de la branche : en cours, ou sa dernière conclusion (cause, preuve), et les tours faits.
        diag: d ? { en_cours: !!d.en_cours, rounds: d.rounds || 0, max: diagnostic.MAX_DIAG, cause: d.dernier ? d.dernier.cause : null, preuve: d.dernier ? d.dernier.preuve : '' } : null,
      };
    }),
  };
}

module.exports = { ESSAIS, idsChaine, normaliserChaine, apresSession, avancer, relancer, apresVerification, resume };
