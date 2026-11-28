'use strict';
/* LES SESSIONS RÉCURRENTES. Un modèle (`recurrence`) porte ce qu'une session de codage ou
   d'exploration reçoit à la création, et un horaire ; à chaque échéance, une session NEUVE en
   naît et part. Rejouer la même session ne tiendrait pas : dès la deuxième fois sa branche est
   poussée, sa merge request peut être mergée, et les commits s'empileraient. Une session par
   échéance, c'est une branche, une MR, un rapport — et l'historique des explorations en prime.

   Même forme que « Lancer plus tard » (`programmation.js`) et les horaires d'agent : un tick par
   minute, isolé de son minuteur pour qu'un test le déclenche sans attendre l'horloge.

   TROIS GARDE-FOUS, dans l'ordre où le tick les rencontre :
     — LE CRÉNEAU EST MARQUÉ AVANT TOUT (`last_fired_at`) : lancée, sautée ou en échec, une échéance
       ne revient pas à chaque minute. Un poste éteint rattrape UNE fois au réveil, jamais N — le
       dernier créneau passé, pas tous ceux qu'il a manqués ;
     — PAS D'EMPILEMENT : la précédente tourne, attend une réponse ou un plan approuvé ? L'échéance
       est sautée, et le modèle le dit. Deux sessions du même modèle côte à côte ne s'attendraient
       pas, et la seconde partirait d'un état que la première n'a pas fini d'écrire ;
     — « SEULEMENT SI ÇA A BOUGÉ » (facultatif) : la tête de la branche de base de chaque projet,
       comparée à celle du dernier lancement. Rien de neuf, on ne paie pas une exploration pour
       relire le même code. Une forge injoignable ne fait pas sauter : on ne sait pas, on lance.

   LA RÉTENTION garde les N dernières sessions du modèle. Au-delà, ne part que ce qui a fini sa
   vie : jamais une session qui tourne, partagée, ou dont une merge request est encore ouverte. */
const db = require('../db');
const { t } = require('../core/i18n');
const { ulid } = require('../core/ulid');
const horaire = require('../agent/horaire');
const tasks = require('../agent/tasks');
const forge = require('../forge');
const { getConfig } = require('../data/config');
const { startTaskJob, jobEnCoursPour } = require('./ordonnanceur');

const GARDER_DEFAUT = 10;
const GARDER_MAX = 100;
// Ce qui OCCUPE encore une session : elle tourne, elle attend une réponse, ou un plan à approuver.
const OCCUPEE = ['running', 'needs_input', 'planned'];

function erreur(cle, status = 400, p = {}) {
  const e = new Error(t(cle, p));
  e.status = status;
  return e;
}

const parId = (id) => db.prepare('SELECT * FROM recurrence WHERE id = ?').get(Number(id) || 0);
const parUid = (uid) => db.prepare('SELECT * FROM recurrence WHERE uid = ?').get(String(uid || ''));

/* Le jour LOCAL en AAAA-MM-JJ : c'est lui qui nomme la branche. `toISOString` seul donnerait la
   veille après 23 h en hiver, et la branche de lundi s'appellerait dimanche. */
function jourLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* LA BRANCHE D'UNE ÉCHÉANCE. Le modèle la porte avec `{date}` ; sans lui, la date est ajoutée en
   fin de nom — deux échéances sur la même branche se marcheraient dessus. Un exemple de date sert
   à la valider : `{` n'est pas un caractère de branche. */
function gabaritBranche(branche) {
  const b = String(branche || '').trim();
  if (!b) return '';
  return b.includes('{date}') ? b : `${b}-{date}`;
}
const brancheDuJour = (gabarit, jour) => String(gabarit || '').split('{date}').join(jour);

/* Déjà prise (une autre session du même dépôt l'occupe) : « -2 », « -3 »… Lancer deux fois le
   même jour, à la main puis à l'heure, ne doit pas commiter dans la branche du matin. */
function brancheLibre(repoId, branche) {
  const prise = (b) => !!db.prepare('SELECT 1 FROM task_target WHERE repo_id = ? AND branch = ?').get(repoId, b);
  if (!prise(branche)) return branche;
  let n = 2;
  while (prise(`${branche}-${n}`)) n += 1;
  return `${branche}-${n}`;
}

/* Les champs d'un modèle, validés. `champs` est ce que `champsDeSession` (couche HTTP) a rendu
   pour une session ordinaire : on y retire ce qui ne vaut que pour UNE session (la session
   d'agent à reprendre, un agent, un brouillon de profil) et on impose ce qu'une récurrence de
   codage exige — pousser, et une branche datée. */
function normaliser({ label, kind, spec, champs, skipUnchanged, keepLast }) {
  const k = kind === 'explore' ? 'explore' : 'code';
  const lu = horaire.parse(spec);
  if (!lu) throw erreur('err.recur.horaire');
  if (!champs || !Array.isArray(champs.targets) || !champs.targets.length) throw erreur('err.recur.projets');
  if (k === 'code' && !champs.autoPush) throw erreur('err.recur.push');
  const targets = champs.targets.map((x) => ({
    repo_id: x.repo_id,
    branch: k === 'code' ? gabaritBranche(x.branch) : (x.branch || ''),
    base_branch: x.base_branch || null,
  }));
  const propre = { ...champs, kind: k, targets };
  for (const cle of ['sessionId', 'agentId', 'agentName', 'agentQuestion', 'agentDraft', 'forcePush', 'resumedFromUid', 'resumedTargetUid', 'triggeredBy', 'label', 'branch']) delete propre[cle];
  const garder = Math.round(Number(keepLast));
  return {
    label: String(label || '').trim().slice(0, 120) || String(champs.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    kind: k,
    spec: horaire.canonique(lu),
    payload: propre,
    skipUnchanged: skipUnchanged ? 1 : 0,
    keepLast: Number.isFinite(garder) && garder >= 1 ? Math.min(garder, GARDER_MAX) : GARDER_DEFAUT,
  };
}

/* À la création, `last_fired_at` = maintenant : le créneau de ce matin, déjà passé, n'est pas
   « dû » — un modèle neuf part à sa PROCHAINE échéance, ou tout de suite si on le demande. */
function creer(entree, now = new Date()) {
  const n = normaliser(entree);
  const iso = now.toISOString();
  const info = db.prepare(`INSERT INTO recurrence (uid, label, kind, spec, payload_json, skip_unchanged, keep_last, paused,
      last_fired_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(ulid(), n.label, n.kind, n.spec, JSON.stringify(n.payload), n.skipUnchanged, n.keepLast, iso, iso, iso);
  return parId(info.lastInsertRowid);
}

// Un horaire CHANGÉ repart de maintenant, pour la même raison qu'à la création.
function modifier(id, entree, now = new Date()) {
  const r = parId(id);
  if (!r) throw erreur('err.recur.introuvable', 404);
  const n = normaliser({ ...entree, kind: r.kind });
  const horaireChange = n.spec !== r.spec;
  db.prepare(`UPDATE recurrence SET label = ?, spec = ?, payload_json = ?, skip_unchanged = ?, keep_last = ?,
      last_fired_at = ?, updated_at = ? WHERE id = ?`)
    .run(n.label, n.spec, JSON.stringify(n.payload), n.skipUnchanged, n.keepLast,
      horaireChange ? now.toISOString() : r.last_fired_at, now.toISOString(), r.id);
  return parId(r.id);
}

// Les sessions déjà nées restent : elles ont leur branche, leur MR, leur rapport.
function supprimer(id) {
  const r = parId(id);
  if (!r) throw erreur('err.recur.introuvable', 404);
  db.prepare('DELETE FROM recurrence WHERE id = ?').run(r.id);
}

/* Reprendre ne rattrape pas : le créneau manqué pendant la pause est passé, et le lancer à la
   reprise ferait partir une session qu'on vient précisément de retenir. */
function mettreEnPause(id, paused, now = new Date()) {
  const r = parId(id);
  if (!r) throw erreur('err.recur.introuvable', 404);
  db.prepare('UPDATE recurrence SET paused = ?, last_fired_at = ?, updated_at = ? WHERE id = ?')
    .run(paused ? 1 : 0, paused ? r.last_fired_at : now.toISOString(), now.toISOString(), r.id);
  return parId(r.id);
}

const sessionsDe = (r) => db.prepare('SELECT * FROM task WHERE recurrence_uid = ? ORDER BY id DESC').all(r.uid);

function occupee(task) {
  return !!task && (OCCUPEE.includes(task.status) || !!jobEnCoursPour(task.id));
}

/* La tête de la branche de base de chaque projet : `{ repo_id: sha }`, ou `null` si la forge n'a
   pas répondu pour l'un d'eux — « on ne sait pas » ne vaut pas « rien n'a bougé ». */
async function tetes(payload) {
  const cfg = getConfig();
  const out = {};
  for (const x of payload.targets || []) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(x.repo_id);
    if (!repo) return null;
    try {
      const client = forge.clientFor(repo);
      const base = x.base_branch || (await client.listBranches(cfg, repo.project)).default;
      const ref = base ? await client.getRef(cfg, repo.project, 'branch', base) : null;
      const sha = ref && ref.commit && ref.commit.id;
      if (!sha) return null;
      out[x.repo_id] = sha;
    } catch { return null; }
  }
  return out;
}
const memesTetes = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every((k) => a[k] === b[k]);

function noterSaut(r, raison, now) {
  db.prepare('UPDATE recurrence SET last_skip = ?, last_skip_at = ?, updated_at = ? WHERE id = ?')
    .run(raison, now.toISOString(), now.toISOString(), r.id);
}

/* La rétention : au-delà des N plus récentes, ce qui a fini sa vie s'efface. */
function retention(r, onLog = () => {}) {
  const garder = Number(r.keep_last) || GARDER_DEFAUT;
  let n = 0;
  for (const task of sessionsDe(r).slice(garder)) {
    if (occupee(task) || task.shared) continue;
    const mrOuverte = db.prepare('SELECT 1 FROM task_target WHERE task_id = ? AND mr_iid IS NOT NULL AND COALESCE(mr_merged, 0) = 0').get(task.id);
    if (mrOuverte) continue;
    tasks.supprimerTask(task.id);
    require('./chaine-scenario').nettoyerSession(task.id);
    n += 1;
  }
  if (n) onLog(t('log.recur.retention', { label: r.label, n, count: n }));
  return n;
}

/* UNE ÉCHÉANCE. `manuel` (« ▶ Maintenant ») : une session occupée REFUSE au lieu de sauter — on
   est devant l'écran, on doit savoir pourquoi rien ne part — et « seulement si ça a bougé » ne
   s'applique pas : celui qui clique veut la session. */
async function declencher(r, { now = new Date(), manuel = false, onLog = () => {} } = {}) {
  const derniere = sessionsDe(r)[0];
  if (occupee(derniere)) {
    if (manuel) throw erreur('err.recur.occupee', 409, { id: derniere.id });
    noterSaut(r, 'busy', now);
    onLog(t('log.recur.sautee-occupee', { label: r.label, id: derniere.id }));
    return { skipped: 'busy' };
  }
  const payload = JSON.parse(r.payload_json);
  const shas = r.skip_unchanged ? await tetes(payload) : null;
  if (!manuel && r.skip_unchanged && memesTetes(shas, r.last_shas_json ? JSON.parse(r.last_shas_json) : null)) {
    noterSaut(r, 'unchanged', now);
    onLog(t('log.recur.sautee-inchangee', { label: r.label }));
    return { skipped: 'unchanged' };
  }
  const jour = jourLocal(now);
  const brut = payload.targets.map((x) => ({
    ...x, branch: r.kind === 'code' ? brancheLibre(x.repo_id, brancheDuJour(x.branch, jour)) : x.branch,
  }));
  // Revalidées : un dépôt retiré depuis, une branche devenue invalide, se disent ici.
  const targets = tasks.normalizeTargets(brut, r.kind);
  const taskId = tasks.creerTask({
    ...payload,
    kind: r.kind,
    targets,
    branch: targets[0].branch || '',
    label: `${r.label} — ${jour}`.slice(0, 120),
    triggeredBy: 'recurrence',
  });
  db.prepare('UPDATE task SET recurrence_uid = ? WHERE id = ?').run(r.uid, taskId);
  const task = db.prepare('SELECT uid FROM task WHERE id = ?').get(taskId);
  db.prepare(`UPDATE recurrence SET last_run_at = ?, last_task_uid = ?, last_skip = NULL, last_skip_at = NULL,
      last_shas_json = COALESCE(?, last_shas_json), updated_at = ? WHERE id = ?`)
    .run(now.toISOString(), task.uid, shas ? JSON.stringify(shas) : null, now.toISOString(), r.id);
  const job = startTaskJob(taskId, 'run', { auto: true });
  onLog(t('log.recur.lancee', { label: r.label, id: taskId }));
  retention(parId(r.id), onLog);
  return { taskId, job };
}

// Ce qui est dû : le dernier créneau passé est plus récent que le dernier honoré.
function dues(now = new Date()) {
  const out = [];
  for (const r of db.prepare('SELECT * FROM recurrence WHERE paused = 0 ORDER BY id').all()) {
    const creneau = horaire.prochainCreneau(horaire.parse(r.spec), now);
    if (!creneau) continue;
    if (r.last_fired_at && new Date(r.last_fired_at) >= creneau) continue;
    out.push(r);
  }
  return out;
}

/* Un tick. Le créneau est marqué AVANT de lancer : un échec ne le fait pas revenir à chaque
   minute. Un tick lent (la forge pour « si ça a bougé ») n'en chevauche pas un autre. */
let tickEnCours = false;
async function tick(now = new Date(), onLog = () => {}) {
  if (tickEnCours) return [];
  tickEnCours = true;
  const faits = [];
  try {
    for (const r of dues(now)) {
      db.prepare('UPDATE recurrence SET last_fired_at = ? WHERE id = ?').run(now.toISOString(), r.id);
      try {
        faits.push({ id: r.id, ...await declencher(r, { now, onLog }) });
      } catch (e) {
        noterSaut(r, `error:${String(e.message || e).slice(0, 300)}`, now);
        onLog(t('log.recur.echec', { label: r.label, message: e.message }));
        faits.push({ id: r.id, error: e.message });
      }
    }
  } finally { tickEnCours = false; }
  return faits;
}

/* Ce que l'écran montre d'un modèle : l'horaire en toutes lettres, la prochaine échéance, et la
   dernière session née — son état, ses merge requests — ou la raison du dernier saut. */
function vue(r) {
  const spec = horaire.parse(r.spec);
  const prochaine = !r.paused && spec ? horaire.creneauSuivant(spec, new Date()) : null;
  const payload = JSON.parse(r.payload_json || '{}');
  const derniere = sessionsDe(r)[0] || null;
  const cibles = derniere ? db.prepare('SELECT repo_id, branch, status, mr_iid, mr_url, mr_merged FROM task_target WHERE task_id = ?').all(derniere.id) : [];
  const projets = (payload.targets || []).map((x) => {
    const repo = db.prepare('SELECT project FROM repo WHERE id = ?').get(x.repo_id);
    return { repo_id: x.repo_id, project: repo ? repo.project : null, branch: x.branch || '', base_branch: x.base_branch || null };
  });
  return {
    id: r.id,
    uid: r.uid,
    label: r.label,
    kind: r.kind,
    spec: r.spec,
    said: horaire.phrase(r.spec),
    next_at: prochaine ? prochaine.toISOString() : null,
    paused: !!r.paused,
    skip_unchanged: !!r.skip_unchanged,
    keep_last: r.keep_last,
    payload,
    projects: projets,
    last_run_at: r.last_run_at,
    last_skip: r.last_skip,
    last_skip_at: r.last_skip_at,
    last_task: derniere ? { id: derniere.id, uid: derniere.uid, status: derniere.status, label: derniere.label, created_at: derniere.created_at, targets: cibles } : null,
    sessions: sessionsDe(r).length,
    created_at: r.created_at,
  };
}
const lister = () => db.prepare('SELECT * FROM recurrence ORDER BY label COLLATE NOCASE, id').all().map(vue);

let minuterie = null;
function demarrer(onLog = () => {}) {
  arreter();
  // Le mode démo montre des modèles ; il ne lance rien tout seul.
  if (process.env.MERGERIE_DEMO === '1') return null;
  minuterie = setInterval(() => { tick(new Date(), onLog).catch(() => { /* tick best-effort */ }); }, 60000);
  if (minuterie.unref) minuterie.unref();
  return minuterie;
}
function arreter() { if (minuterie) { clearInterval(minuterie); minuterie = null; } }

module.exports = {
  parId, parUid, creer, modifier, supprimer, mettreEnPause, declencher, dues, tick, vue, lister, retention,
  gabaritBranche, brancheDuJour, jourLocal, demarrer, arreter,
};
