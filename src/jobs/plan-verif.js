'use strict';
/* GIT → VÉRIFICATEUR : des préparations de vérification, et leur lancement en SÉQUENCE.

   Une préparation = des dépôts, chacun sur une branche ou un tag, et des vérificateurs. « Lancer »
   les fait tourner l'un après l'autre, chacun dans son propre job de vérification (le journal les
   montre comme toute vérification) : le suivant part quand le précédent finit VERT. Un rouge ou une
   erreur arrête la séquence — les étapes restantes sont « non lancées », et chacune se lance à la
   main, seule.

   UN VÉRIFICATEUR NE COUVRE PAS FORCÉMENT TOUT LE LOT. Il tourne sur les dépôts qu'il couvre (ses
   cibles) ; les autres dépôts du lot sont mis sur leur ref dans le clone LOCAL de l'utilisateur le
   temps du run (`positions`, appliquées par `verifyrun`) puis remis — ses commandes peuvent lire un
   voisin, et ce voisin doit être sur la branche choisie pour le lot. Le clone local se trouve dans
   les répertoires locaux déclarés (Réglages → Dépôts), par le remote `origin`.

   L'ÉTAT D'UNE ÉTAPE SE DÉDUIT de sa vérification au lieu d'être stocké (voir `etatEtapes`) : un
   serveur coupé au milieu d'une séquence ne laisse pas une étape « en cours » pour toujours. */
const db = require('../db');
const git = require('../git/git');
const localrepos = require('../git/localrepos');
const groupes = require('../data/groupes');
const verifyLib = require('../verify/verify');
const { t } = require('../core/i18n');
const { appliquerModes, creerVerification, ciblesDepuisBranches, REF_SURE } = require('./verifications');

const lire = (j, defaut) => { try { return JSON.parse(j); } catch { return defaut; } };
const maintenant = () => new Date().toISOString();

function planParId(id) {
  const p = db.prepare('SELECT * FROM verif_plan WHERE id = ?').get(Number(id));
  if (!p) return null;
  return { ...p, targets: lire(p.targets_json, []), verifier_ids: lire(p.verifier_ids_json, []) };
}
function runParId(id) {
  const r = db.prepare('SELECT * FROM verif_plan_run WHERE id = ?').get(Number(id));
  return r ? { ...r, steps: lire(r.steps_json, []) } : null;
}
const ecrireEtapes = (runId, steps) => db.prepare('UPDATE verif_plan_run SET steps_json = ? WHERE id = ?').run(JSON.stringify(steps), runId);

/* ---------- La préparation ---------- */

/* Ce qu'on enregistre est relu ici, entièrement : des dépôts connus, une fois chacun, chacun sur une
   ref sûre (elle finira dans un `rev-parse`) ; des vérificateurs connus, sans doublon, et qui
   couvrent CHACUN au moins un dépôt du lot — un vérificateur qui n'en couvre aucun n'aurait rien à
   vérifier. */
function normaliser(body) {
  const name = String((body && body.name) || '').trim().slice(0, 120);
  if (!name) throw new Error(t('err.plan.name-required'));
  const targets = [];
  const vus = new Set();
  for (const e of (body && body.targets) || []) {
    const repo = db.prepare('SELECT id, project FROM repo WHERE id = ?').get(Number(e.repo_id));
    if (!repo) throw new Error(t('err.depot-introuvable'));
    if (vus.has(repo.id)) throw new Error(t('err.verify.repo-twice'));
    vus.add(repo.id);
    const tag = String(e.tag || '').trim();
    const branch = tag ? '' : String(e.branch || '').trim();
    if (!tag && !branch) throw new Error(t('err.verify.branch-required', { project: repo.project }));
    if (!REF_SURE.test(tag || branch)) throw new Error(t('err.verify.invalid-ref', { ref: tag || branch, project: repo.project }));
    targets.push({ repo_id: repo.id, branch: branch || null, tag: tag || null });
  }
  if (!targets.length) throw new Error(t('err.plan.no-repo'));
  const ids = [...new Set(((body && body.verifier_ids) || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error(t('err.plan.no-verifier'));
  for (const id of ids) {
    const v = db.prepare('SELECT id, name FROM verifier WHERE id = ?').get(id);
    if (!v) throw new Error(t('err.verify.verifier-gone'));
    const couverts = groupes.couvertureVerifier(id);
    if (!targets.some((c) => couverts.has(c.repo_id))) throw new Error(t('err.plan.verifier-covers-none', { name: v.name }));
  }
  return { name, targets, verifier_ids: ids };
}

function creerPlan(body) {
  const { name, targets, verifier_ids } = normaliser(body);
  const now = maintenant();
  const info = db.prepare('INSERT INTO verif_plan (name, targets_json, verifier_ids_json, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(name, JSON.stringify(targets), JSON.stringify(verifier_ids), now, now);
  return planParId(info.lastInsertRowid);
}
function modifierPlan(id, body) {
  if (!planParId(id)) throw new Error(t('err.plan.not-found'));
  const { name, targets, verifier_ids } = normaliser(body);
  db.prepare('UPDATE verif_plan SET name = ?, targets_json = ?, verifier_ids_json = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(targets), JSON.stringify(verifier_ids), maintenant(), Number(id));
  return planParId(id);
}
function supprimerPlan(id) {
  db.prepare('DELETE FROM verif_plan WHERE id = ?').run(Number(id));
}
function plans() {
  // Par nom : on vient y chercher « la recette du vendredi », pas la dernière créée.
  return db.prepare('SELECT id FROM verif_plan ORDER BY name COLLATE NOCASE, id DESC').all().map((p) => planParId(p.id));
}
function lancementsDe(planId) {
  return db.prepare('SELECT id FROM verif_plan_run WHERE plan_id = ? ORDER BY id DESC').all(Number(planId)).map((r) => runParId(r.id));
}

/* ---------- L'état des étapes, déduit ---------- */

const ACTIVE = new Set(['queued', 'running']);
/* `etat` : 'queued' | 'running' | 'done' (la vérification a rendu son verdict) | 'error' (l'étape n'a
   pas pu partir) | 'pending' (la précédente, enchaînée, tourne encore : elle partira après) |
   'not_run' (la séquence s'est arrêtée avant elle). */
function etatEtapes(run) {
  const out = [];
  for (const s of run.steps) {
    const v = s.verification_id ? db.prepare('SELECT id, status, verdict FROM verification WHERE id = ?').get(s.verification_id) : null;
    let etat;
    if (v) etat = ACTIVE.has(v.status) ? v.status : 'done';
    else if (s.erreur) etat = 'error';
    else {
      /* En attente si la précédente, enchaînée, tourne encore — ou vient de finir verte : la suite
         part dans la foulée (`apresVerification`), il n'y a que l'instant du lancement entre les deux. */
      const prec = out[out.length - 1];
      const enchaine = prec && prec.chaine && (ACTIVE.has(prec.etat) || prec.etat === 'pending'
        || (prec.etat === 'done' && prec.verdict === 'verified_pass'));
      etat = enchaine ? 'pending' : 'not_run';
    }
    out.push({ ...s, etat, verdict: v ? v.verdict : null });
  }
  return out;
}
const runActif = (run) => etatEtapes(run).some((s) => ACTIVE.has(s.etat) || s.etat === 'pending');

/* ---------- Lancer ---------- */

/* Le clone local d'un dépôt : le premier projet git des répertoires locaux déclarés dont le remote
   `origin` est ce dépôt. `null` si aucun — le run s'arrêtera alors en le disant, au lieu de lancer des
   commandes contre un voisin resté sur une autre branche. */
async function cloneLocalDe(repo) {
  for (const racine of localrepos.roots()) {
    let projets = [];
    try { projets = localrepos.projects(racine.id); } catch { continue; }
    for (const p of projets.filter((x) => x.git)) {
      try {
        const r = await git.run('git', ['config', '--get', 'remote.origin.url'], { cwd: p.path });
        if (verifyLib.memeDepot(String(r.stdout || '').trim(), repo.url)) return p.path;
      } catch { /* pas d'origin : ce n'est pas lui */ }
    }
  }
  return null;
}

/* Une étape : son vérificateur, ses cibles (les dépôts qu'il couvre), ses positions (les autres), une
   vérification en file. Un refus (vérificateur supprimé, non approuvé…) s'écrit sur l'étape : la
   séquence s'arrête là, et le bouton de l'étape permet de la relancer une fois corrigé. */
async function lancerEtape(runId, index, { chaine }) {
  const run = runParId(runId);
  if (!run || !run.steps[index]) throw new Error(t('err.plan.step-not-found'));
  if (run.steps[index].verification_id && ACTIVE.has((db.prepare('SELECT status FROM verification WHERE id = ?').get(run.steps[index].verification_id) || {}).status)) {
    throw new Error(t('err.plan.step-running'));
  }
  const plan = planParId(run.plan_id);
  let maj;
  try {
    if (!plan) throw new Error(t('err.plan.not-found'));
    const verifier = db.prepare('SELECT * FROM verifier WHERE id = ?').get(run.steps[index].verifier_id);
    if (!verifier) throw new Error(t('err.verify.verifier-gone'));
    const couverts = groupes.couvertureVerifier(verifier.id);
    const siens = plan.targets.filter((c) => couverts.has(c.repo_id));
    if (!siens.length) throw new Error(t('err.plan.verifier-covers-none', { name: verifier.name }));
    const positions = [];
    for (const c of plan.targets.filter((x) => !couverts.has(x.repo_id))) {
      const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(c.repo_id);
      if (!repo) continue;
      positions.push({ repo_id: repo.id, project: repo.project, branch: c.branch, tag: c.tag, workdir: await cloneLocalDe(repo) });
    }
    const cibles = appliquerModes(verifier, ciblesDepuisBranches(siens));
    /* En file plutôt que refusé : une séquence lancée puis laissée tourner ne doit pas s'arrêter
       parce qu'une autre vérification occupait les mêmes dépôts au moment de passer à la suivante. */
    const { verification } = creerVerification({ verifier, cibles, enFile: true, planRunId: runId, positions });
    maj = { verification_id: verification.id, chaine: !!chaine, erreur: null };
  } catch (e) {
    maj = { verification_id: null, chaine: !!chaine, erreur: e.message };
  }
  // Relu APRÈS les attentes : une autre étape a pu s'écrire entre-temps.
  const frais = runParId(runId);
  frais.steps[index] = { ...frais.steps[index], ...maj };
  ecrireEtapes(runId, frais.steps);
  return runParId(runId);
}

/* `seul` (rang d'un vérificateur) : un lancement où seul celui-là part, hors séquence — les autres
   étapes restent « non lancées », chacune avec son bouton. */
async function lancerPlan(planId, { seul = null } = {}) {
  const plan = planParId(planId);
  if (!plan) throw new Error(t('err.plan.not-found'));
  const dernier = lancementsDe(planId)[0];
  if (dernier && runActif(dernier)) throw new Error(t('err.plan.running'));
  const index = seul == null ? 0 : Number(seul);
  if (!Number.isInteger(index) || index < 0 || index >= plan.verifier_ids.length) throw new Error(t('err.plan.step-not-found'));
  const steps = plan.verifier_ids.map((id) => ({
    verifier_id: id,
    verifier_name: (db.prepare('SELECT name FROM verifier WHERE id = ?').get(id) || {}).name || `#${id}`,
    verification_id: null, chaine: seul == null, erreur: null,
  }));
  const info = db.prepare('INSERT INTO verif_plan_run (plan_id, steps_json, created_at) VALUES (?,?,?)')
    .run(plan.id, JSON.stringify(steps), maintenant());
  return lancerEtape(info.lastInsertRowid, index, { chaine: seul == null });
}

/* Une étape « non lancée », refusée au lancement, ou ÉCHOUÉE (rouge, erreur, base cassée), lancée à la
   main : SEULE — elle n'enchaîne pas sur les suivantes, la séquence s'est arrêtée et c'est l'utilisateur
   qui reprend la main. Relancer une étape échouée remplace sa vérification sur la carte ; l'ancienne
   reste un rapport comme un autre. Une étape verte ne se relance pas : « Lancer » refait la séquence. */
async function lancerEtapeSeule(runId, index) {
  const run = runParId(runId);
  if (!run) throw new Error(t('err.plan.step-not-found'));
  const { etat, verdict } = etatEtapes(run)[Number(index)] || {};
  const echouee = etat === 'done' && verdict !== 'verified_pass';
  if (etat !== 'not_run' && etat !== 'error' && !echouee) throw new Error(t('err.plan.step-not-launchable'));
  return lancerEtape(run.id, Number(index), { chaine: false });
}

/* Appelé par l'exécutant du job de vérification, quand une vérification finit : la suivante part si
   celle-ci était enchaînée et VERTE. Rien d'autre à faire sur un rouge : les étapes restantes se
   lisent « non lancées » d'elles-mêmes. */
async function apresVerification(verificationId, verdict) {
  const v = db.prepare('SELECT plan_run_id FROM verification WHERE id = ?').get(verificationId);
  if (!v || !v.plan_run_id) return null;
  const run = runParId(v.plan_run_id);
  if (!run) return null;
  const i = run.steps.findIndex((s) => s.verification_id === verificationId);
  if (i < 0 || !run.steps[i].chaine || verdict !== 'verified_pass') return null;
  const suivante = run.steps[i + 1];
  if (!suivante || suivante.verification_id || suivante.erreur) return null;
  return lancerEtape(run.id, i + 1, { chaine: true });
}

module.exports = {
  plans, planParId, creerPlan, modifierPlan, supprimerPlan, lancementsDe, runParId, etatEtapes, runActif,
  lancerPlan, lancerEtapeSeule, apresVerification, cloneLocalDe,
};
