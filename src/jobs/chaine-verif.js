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
const taskrunner = require('../session/taskrunner');

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
// L'étape tests demandée pour la session (étape 3) : `{ actif, attendu, attendu_source }`, ou rien.
const configScenario = (task) => scenarioMod.lireScenario(task);
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
/* LA SIGNATURE DE L'ÉTAPE 1. Les commits de l'étape tests changent la branche, mais ce sont les vérificateurs
   rejoués de cette étape qui la jugent : la chaîne elle-même garde le vert qu'elle a donné, tant que la
   branche n'a reçu que ces commits-là. Un autre commit (un suivi, un push) la rend à revérifier. */
function sigEtape1(chaine) {
  const sig = signature(chaine.task_id);
  const sc = chaine.scenario;
  return sc && sc.sig_chaine && (sc.sigs_etape || []).includes(sig) ? sc.sig_chaine : sig;
}
function etat(chaine) {
  const sig = sigEtape1(chaine);
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
async function preparerCote(verifier, taskId, quoi, { tests = [] } = {}) {
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
    // Un dépôt de tests où l'étape tests a écrit : la branche de la session, poussée, à son commit.
    const d = tests.find((x) => x.repo_id === repoId);
    if (d) { cibles.push({ repo_id: repoId, mr_id: null, head_sha: d.sha_final || d.sha_depart, base_sha: null, branch: d.branche, tag: null, mode: 'worktree' }); continue; }
    // Un dépôt hors session : sa branche par défaut.
    cibles.push({ repo_id: repoId, mr_id: null, head_sha: 'origin/HEAD', base_sha: null, branch: 'HEAD', tag: null, mode: 'worktree' });
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
const etapeEnCours = new Set();   // chaînes dont l'étape tests est en train d'avancer

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
  /* Même règle pour l'étape tests : la session écrit (ou corrige), on attend — sinon (arrêtée, en erreur),
     conclue sans rien constater. */
  if (chaine.scenario && chaine.scenario.en_cours) {
    if (scenarioMod.enRoute(chaine.task_id)) return null;
    conclureScenario(chaine, { fini: false });
    chaine = chaineDe(taskId);
  }
  const etats = etat(chaine);
  if (etats.some((s) => ACTIVE.has(s.base.etat) || ACTIVE.has(s.head.etat))) return null;
  const sig = sigEtape1(chaine);
  if (chaine.scenario && rejeuActif(chaine)) return null;
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
  /* TOUT EST VERT : les tests, s'ils sont demandés (étape 3). L'agent écrit, les vérificateurs rejouent,
     l'agent corrige ; l'étape ne rend la main qu'arrêtée — validée, ou « À toi ». */
  if (finale === 'passed') {
    const task = db.prepare('SELECT * FROM task WHERE id = ?').get(chaine.task_id);
    const cfg = configScenario(task);
    if (cfg) {
      /* Une seule fois à la fois par chaîne : deux vérifications qui finissent ensemble appellent `avancer`
         deux fois, et l'étape (asynchrone : préparer un clone prend du temps) partirait deux fois. */
      if (etapeEnCours.has(chaine.id)) return null;
      etapeEnCours.add(chaine.id);
      let r;
      try { r = await phaseScenario(chaineDe(taskId), task); } finally { etapeEnCours.delete(chaine.id); }
      if (r === 'lance') return null;
      finale = r;
      chaine = chaineDe(taskId);
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

/* ---------- L'étape tests ---------- */

/* Les dépôts de tests touchés, leurs SHA : avec ceux de la session, ce que les lancements du rejeu ont vu. */
const sigRejeu = (chaine) => `${signature(chaine.task_id)}|${((chaine.scenario || {}).depots || []).filter((d) => d.zone === 'tests')
  .map((d) => `${d.repo_id}:${d.sha_final || d.sha_depart}`).join(',')}`;
/* L'état du rejeu, vérificateur par vérificateur, dans l'ordre de la chaîne : deux essais chacun, comme un
   côté (`etatCote`). */
function etatsRejeu(chaine) {
  const sc = chaine.scenario || {};
  const par = sc.rejeu || {};
  const sig = sigRejeu(chaine);
  const parId = verifs(Object.values(par).flatMap((r) => (r.runs || []).map((x) => x.verification_id)));
  return chaine.steps.map((s) => ({ verifier_id: s.verifier_id, verifier_name: s.verifier_name,
    ...etatCote(par[s.verifier_id] || {}, 'head', sig, parId) }));
}
const rejeuActif = (chaine) => !!(chaine.scenario && chaine.scenario.a_rejouer && etatsRejeu(chaine).some((r) => ACTIVE.has(r.etat)));

/* Rend 'lance' (quelque chose part ou attend : l'agent, un vérificateur), 'validated' ou 'attention'. Toute
   sortie arrêtée passe par `sortirScenario`. */
async function phaseScenario(chaine, task) {
  let scen = chaine.scenario || {};
  // Conclue par le constat (couvert, ou une erreur) : on sort par la porte.
  if (scen.final) return scen.prepare ? sortirScenario(chaine, task, scen, 'validated') : 'validated';
  if (scen.erreur) return scen.prepare ? sortirScenario(chaine, task, scen, 'attention') : 'attention';
  if (scen.en_cours) return 'lance';   // la passe de l'agent tourne : sa fin relancera
  if (!scen.prepare) {
    const r = await scenarioMod.preparer(task, scen);
    if (r.erreur) return sortirScenario(chaine, task, { ...scen, erreur: r.erreur, cause: r.cause || 'preparer' }, 'attention');
    const sig = signature(task.id);
    scen = { ...scen, prepare: true, depots: [...(scen.depots || []).filter((d) => d.zone !== 'tests'), ...r.depots], positions: r.positions,
      sig_chaine: scen.sig_chaine || sig, sigs_etape: [...new Set([...(scen.sigs_etape || []), sig])] };
    ecrireScenario(chaine.id, scen);
  }
  if (!scen.ecrit) return lancerPasse(chaine, task, scen, { quoi: 'ecrire' });
  if (scen.reprise) {
    if ((scen.corrections || 0) >= scenarioMod.MAX_CORRECTIONS) {
      return sortirScenario(chaine, task, { ...scen, erreur: scen.reprise.raison, cause: scen.reprise.couvert ? 'couvert' : 'json' }, 'attention');
    }
    return lancerPasse(chaine, task, scen, { quoi: 'corriger', raison: scen.reprise.raison });
  }
  if (scen.final === 'couvert' || (scen.couvert && !scen.a_rejouer)) return sortirScenario(chaine, task, { ...scen, final: 'couvert' }, 'validated');
  if (!scen.a_rejouer) return 'attention';
  /* LE REJEU : tous les vérificateurs de la chaîne, dans l'ordre, côté branche seulement, commandes
     inchangées. Un vérificateur rouge deux fois n'arrête pas les suivants : ils tournent tous, puis on conclut. */
  const etats = etatsRejeu(chaine);
  if (etats.some((r) => ACTIVE.has(r.etat))) return 'lance';
  const suivant = etats.findIndex((r) => r.etat === 'todo');
  if (suivant >= 0) { await lancerRejeu(chaine, task, suivant); return 'lance'; }
  const rouges = etats.filter((r) => r.etat !== 'pass');
  if (!rouges.length) return sortirScenario(chaine, task, { ...scen, final: 'vert' }, 'validated');
  if ((scen.corrections || 0) < scenarioMod.MAX_CORRECTIONS) {
    return lancerPasse(chaine, task, scen, { quoi: 'corriger', rouges: rouges.map((r) => ({ nom: r.verifier_name, verification_id: r.verification_id })) });
  }
  return sortirScenario(chaine, task, { ...scen, erreur: t('task.chaine.scen.still-red', { names: rouges.map((r) => r.verifier_name).join(', ') }), cause: 'rouge',
    rouge: rouges.map((r) => ({ verifier_id: r.verifier_id, nom: r.verifier_name, verification_id: r.verification_id })) }, 'attention');
}
function lancerPasse(chaine, task, scen, opts) {
  try {
    ecrireScenario(chaine.id, scenarioMod.lancerAgent(task, scen, opts));
    ecrire(chaine.id, chaine.steps, 'running');
    return 'lance';
  } catch (e) {
    return sortirScenario(chaine, task, { ...scen, erreur: e.message, cause: 'agent' }, 'attention');
  }
}
async function lancerRejeu(chaine, task, index) {
  const step = chaine.steps[index];
  const scen = chaine.scenario;
  try {
    const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(step.verifier_id);
    if (!verifier) throw new Error(t('err.verify.verifier-gone'));
    const { cibles, positions } = await preparerCote(verifier, task.id, 'head', { tests: (scen.depots || []).filter((d) => d.zone === 'tests') });
    const { verification } = creerVerification({ verifier, cibles, enFile: true, automatique: true, positions });
    db.prepare('UPDATE verification SET chaine_id = ? WHERE id = ?').run(chaine.id, verification.id);
    const frais = chaineDe(task.id).scenario;
    const r = (frais.rejeu || {})[step.verifier_id] || { runs: [], depuis: 0 };
    const rejeu = { ...(frais.rejeu || {}), [step.verifier_id]: { ...r, runs: [...(r.runs || []), { verification_id: verification.id, sig: sigRejeu(chaineDe(task.id)), at: maintenant() }] } };
    ecrireScenario(chaine.id, { ...frais, rejeu });
    ecrire(chaine.id, chaine.steps, 'running');
  } catch (e) {
    sortirScenario(chaine, task, { ...chaineDe(task.id).scenario, erreur: `${step.verifier_name} : ${e.message}`, cause: 'rejeu' }, 'attention');
    ecrire(chaine.id, chaine.steps, 'attention');
    signalerAttention(chaine);
  }
}
/* LA SORTIE DE L'ÉTAPE, quelle qu'elle soit. Validée : les merge requests de tests passent de brouillon à
   prêtes — en arrière-plan, la forge ne retient pas la chaîne ; un refus reste dit sur la carte. */
function sortirScenario(chaine, task, scen, finale) {
  const s = { ...scen, prepare: false };
  ecrireScenario(chaine.id, s);
  if (finale === 'validated' && (s.depots || []).some((d) => d.zone === 'tests' && d.mr_iid && !d.mr_pret)) {
    scenarioMod.marquerPretes(s).then((depots) => {
      const frais = chaineDe(task.id);
      if (frais && frais.scenario) ecrireScenario(chaine.id, { ...frais.scenario, depots });
    }).catch(() => { /* la MR reste en brouillon : rien d'autre ne dépend d'elle */ });
  }
  return finale;
}
function conclureScenario(chaine, { fini }) {
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(chaine.task_id);
  const s = scenarioMod.conclure(task, chaine.scenario, { fini });
  // Les commits de cette passe dans la session : la chaîne ne les rejoue pas elle-même (voir `sigEtape1`).
  s.sigs_etape = [...new Set([...(s.sigs_etape || []), signature(task.id)])];
  ecrireScenario(chaine.id, s);
}

/* Après un redémarrage : une étape tests dont la passe tournait — son job est perdu. Les clones qu'elle avait
   déplacés reviennent où on les a trouvés (un échec est dit à la place de l'interruption) ; « À toi », avec la
   cause ; les branches restent, « Relancer » repart de là. */
function reprendreApresRedemarrage() {
  for (const c of db.prepare("SELECT task_id FROM verif_chaine WHERE scenario_json LIKE '%\"en_cours\":{%'").all()) {
    const chaine = chaineDe(c.task_id);
    if (!chaine || !chaine.scenario || !chaine.scenario.en_cours || scenarioMod.enRoute(c.task_id)) continue;
    const sorties = Object.values(chaine.scenario.en_cours.sorties || {});
    ecrireScenario(chaine.id, { ...chaine.scenario, en_cours: null, prepare: false, erreur: t('task.chaine.scen.interrupted'), cause: 'redemarrage' });
    ecrire(chaine.id, chaine.steps, 'attention');
    signalerAttention(chaine);
    (async () => {
      const erreurs = [];
      for (const sortie of sorties) erreurs.push(...await taskrunner.restaurerClonesLaisses(sortie));
      if (!erreurs.length) return;
      const frais = chaineDe(c.task_id);
      if (frais && frais.scenario) ecrireScenario(frais.id, { ...frais.scenario, erreur: erreurs.join('\n'), cause: 'restauration' });
    })().catch(() => { /* la carte dit déjà l'interruption */ });
  }
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
  if (avecScenario.scenario && avecScenario.scenario.en_cours) conclureScenario(avecScenario, { fini: true });
  return avancer(task.id);
}

/* « Relancer » : les côtés cassés oublient leurs échecs (la base corrigée à la main, l'environnement
   réparé), les erreurs de lancement s'effacent, et la chaîne repart de ce qui n'est pas vert. */
async function relancer(taskId) {
  const chaine = chaineDe(taskId);
  /* Jamais partie (la session ou sa convergence s'est arrêtée avant) : « Continuer » la démarre. */
  if (!chaine) {
    await apresSession(taskId);
    const r = resume(taskId);
    if (!r) throw new Error(t('err.chaine.not-found'));
    return r;
  }
  const etats = etat(chaine);
  const scenActif = chaine.scenario && (chaine.scenario.en_cours || rejeuActif(chaine));
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
  /* L'étape tests : l'erreur s'efface et la préparation est refaite (les branches existantes sont reprises).
     Rouge après ses corrections : le rejeu oublie ses échecs et les corrections repartent de zéro. Rien
     d'écrit (la session n'avait rien rendu, ou un push a échoué) : les passes repartent. */
  if (chaine.scenario) {
    const sc = chaine.scenario;
    const rejeu = Object.fromEntries(Object.entries(sc.rejeu || {}).map(([k, r]) => [k, { ...r, depuis: (r.runs || []).length }]));
    ecrireScenario(chaine.id, { ...sc, erreur: null, cause: null, prepare: false, rouge: null,
      ecrit: ['rien', 'interrompu', 'redemarrage', 'push', 'clone', 'restauration'].includes(sc.cause) ? !!sc.a_rejouer : sc.ecrit,
      reprise: null, ...(sc.cause === 'rouge' ? { rejeu, corrections: 0 } : {}) });
  }
  notes.fermerTodoAuto('chaine_verif', chaine.task_id);
  await avancer(taskId);
  return resume(taskId);
}

/* Une passe de la session arrêtée ou en erreur : si c'était l'étape tests, la chaîne la conclut. Rien d'autre
   ne repart sur un arrêt. */
async function apresArret(taskId) {
  const c = chaineDe(taskId);
  return c && c.scenario && c.scenario.en_cours ? avancer(taskId) : null;
}

/* Appelé par l'exécutant d'une vérification qui finit : la chaîne passe au côté suivant (ou relance le
   même, pour son deuxième essai). */
async function apresVerification(verificationId) {
  const v = db.prepare('SELECT chaine_id FROM verification WHERE id = ?').get(verificationId);
  if (!v || !v.chaine_id) return null;
  const c = db.prepare('SELECT task_id FROM verif_chaine WHERE id = ?').get(v.chaine_id);
  return c ? avancer(c.task_id) : null;
}

/* L'étape tests, pour la carte et la frise. */
function resumeScenario(chaine) {
  const sc = chaine.scenario;
  const task = db.prepare('SELECT verify_chain_scenario FROM task WHERE id = ?').get(chaine.task_id) || {};
  const cfg = scenarioMod.lireScenario(task) || {};
  const relu = (d) => {
    if (d.zone !== 'session' || !d.mr_iid || !d.sha_final || d.sha_final === d.sha_depart) return null;
    const mr = db.prepare('SELECT reviewed_sha FROM mr WHERE repo_id = ? AND iid = ?').get(d.repo_id, d.mr_iid);
    return !!(mr && mr.reviewed_sha === d.sha_final);
  };
  const depots = (sc.depots || []).filter((d) => d.zone === 'tests' || (d.sha_final && d.sha_final !== d.sha_depart)).map((d) => ({
    zone: d.zone, repo_id: d.repo_id, project: d.project, branche: d.branche, sha_depart: d.sha_depart, sha_final: d.sha_final || null,
    ajoutes: d.ajoutes || [], modifies: d.modifies || [], supprimes: d.supprimes || [], tests: d.tests || [],
    mr_iid: d.mr_iid || null, mr_url: d.mr_url || null, relu: relu(d),
    // Zone Tests : la merge request du dépôt de tests, en brouillon jusqu'au vert (`mr_pret`), ou le refus de la forge.
    ...(d.zone === 'tests' ? { mr_pret: !!d.mr_pret, mr_erreur: d.mr_erreur || null } : {}),
  }));
  return {
    en_cours: sc.en_cours ? sc.en_cours.quoi : null, final: sc.final || null,
    erreur: sc.erreur || null, cause: sc.cause || null, corrections: sc.corrections || 0, max: scenarioMod.MAX_CORRECTIONS,
    couvert: sc.couvert || null, depots, code_modifie: sc.code_modifie || [],
    attendu: cfg.attendu || null, attendu_source: cfg.attendu_source || null, demarre: !!(sc.prepare || sc.ecrit || sc.en_cours),
    rejeu: sc.a_rejouer ? etatsRejeu(chaine) : [],
  };
}

/* LE COMMIT DE TESTS NON RELU, PAR MERGE REQUEST : l'étape tests a poussé un commit dans la MR d'une session, et
   aucune review ne couvre encore son SHA. `repo_id:iid` → le SHA. L'étape ne relance ni review ni convergence :
   la carte de la MR le dit, la re-review incrémentale existante suffit. */
function commitsDeTestsParMr() {
  const out = new Map();
  for (const c of db.prepare('SELECT scenario_json FROM verif_chaine WHERE scenario_json IS NOT NULL').all()) {
    for (const d of (lire(c.scenario_json, {}) || {}).depots || []) {
      if (d.zone === 'session' && d.mr_iid && d.sha_final && d.sha_final !== d.sha_depart) out.set(`${d.repo_id}:${d.mr_iid}`, d.sha_final);
    }
  }
  return out;
}

/* La vue de diff d'un dépôt touché à l'étape tests : du SHA de départ au dernier commit de l'étape, dans le
   clone local de l'utilisateur (zone Tests, lu par ses commits) ou le clone de Mergerie (zone Session). */
function contexteDiffTests(taskId, repoId) {
  const chaine = chaineDe(taskId);
  const d = chaine && chaine.scenario && (chaine.scenario.depots || []).find((x) => x.repo_id === Number(repoId) && x.sha_final);
  if (!d) return null;
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(d.repo_id);
  const cwd = d.zone === 'tests' ? d.chemin : (repo ? require('../git/git').cloneDirFor(require('../data/config').getConfig(), repo) : null);
  return cwd ? { cwd, ref: d.sha_final, target: d.sha_depart, shaRange: true, project: d.project, branch: d.branche, sortie: d.sortie || null } : null;
}

/* Ce que la carte de session affiche. */
function resume(taskId) {
  const chaine = chaineDe(taskId);
  if (!chaine) return null;
  const sc = chaine.scenario;
  return {
    status: chaine.status,
    // L'étape tests : ce qui a été écrit, où, prouvé par quels vérificateurs, et la merge request des tests.
    scenario: sc ? resumeScenario(chaine) : null,
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

module.exports = { ESSAIS, idsChaine, normaliserChaine, apresSession, avancer, relancer, apresVerification, apresArret, resume, reprendreApresRedemarrage, contexteDiffTests, commitsDeTestsParMr };
