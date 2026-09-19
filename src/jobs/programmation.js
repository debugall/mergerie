'use strict';
/* LANCER PLUS TARD. Une session de codage, d'exploration ou hors dépôt part à la date et à
   l'heure qu'on a fixées ; un suivi écrit d'avance part à la sienne. Une date, pas un horaire :
   « demain à 7:00 », « ce soir quand la machine est libre » — les horaires récurrents sont
   l'affaire des agents (`agent/schedule.js`), dont ceci reprend la forme : un tick par minute,
   isolé de son minuteur pour qu'un test le déclenche sans attendre l'horloge.

   LA PROGRAMMATION EST DE POSTE, pas d'équipe. Une session se partage par le dépôt de données ;
   si la date voyageait avec elle, trois instances allumées lanceraient trois fois la même
   session, chacune persuadée d'être la seule. Elle vit donc dans `local_pref`, rangée sous
   l'`uid` de la session — une PRÉFÉRENCE (une intention qu'on a posée), pas de l'état dérivé :
   on ne la recalcule pas, on ne la vide pas sans prévenir. Le poste qui l'a posée est celui
   qui la tient ; éteint à l'heure dite, il rattrape le lancement au tick suivant son réveil,
   comme un horaire d'agent — une session programmée puis oubliée vaut mieux lancée en retard
   que jamais.

   ELLE PART UNE FOIS. La date est effacée AVANT le lancement : sans ça, un lancement refusé
   ou une session qui finit vite la retrouverait « due » à chaque minute. Et lancer la session
   à la main annule la date (les routes `/run` s'en chargent) : deux passes de la même session,
   l'une voulue, l'autre programmée, se marcheraient dessus dans le même clone. */
const db = require('../db');
const { pref } = require('../data/localstate');
const { t } = require('../core/i18n');
const { startLocalJob, startTaskJob } = require('./ordonnanceur');
const { envoyerSuiviEnAttente } = require('./apres-session');

/* Ce qu'on programme, et la clé de `local_pref` qui le porte. `run` lance la session ;
   `followup` envoie le suivi en attente sur la carte — celui d'`apres-session.js`. */
const CLES = { run: 'run_at', followup: 'followup_at' };
/* Les tables qui se programment, et le scope d'`apres-session` qui leur correspond. Une
   question libre ne s'y trouve pas : on programme un travail sur des fichiers, pas une
   conversation. */
const TABLES = { task: { scope: 'task' }, local_task: { scope: 'local' } };

/* La date telle qu'on l'accepte : lisible, et À VENIR. Une date passée n'est pas « tout de
   suite » — c'est presque toujours une faute de frappe, et la session partirait pendant qu'on
   la relit. Rendue en ISO, à la minute : c'est la granularité du tick, et une seconde de plus
   n'aurait aucun sens à l'écran. */
function lireDate(at, now = new Date()) {
  const d = new Date(String(at || ''));
  if (Number.isNaN(d.getTime())) { const e = new Error(t('err.programmation.date-invalide')); e.status = 400; throw e; }
  d.setSeconds(0, 0);
  if (d.getTime() <= now.getTime()) { const e = new Error(t('err.programmation.date-passee')); e.status = 400; throw e; }
  return d.toISOString();
}
function exigerKind(kind) {
  if (!TABLES[kind]) throw new Error(`programmation : table inconnue ${kind}`);
}
/* Pose (ou efface, avec `null`) la date d'un lancement ou d'un suivi. Rend la date retenue. */
function programmer(kind, uid, quoi, at, now = new Date()) {
  exigerKind(kind);
  if (!CLES[quoi]) throw new Error(`programmation : geste inconnu ${quoi}`);
  if (at === null || at === undefined || at === '') { pref.ecrire(kind, uid, CLES[quoi], null); return null; }
  const iso = lireDate(at, now);
  pref.ecrire(kind, uid, CLES[quoi], iso);
  return iso;
}
function lire(kind, uid) {
  exigerKind(kind);
  return { scheduled_at: pref.lire(kind, uid, CLES.run), followup_at: pref.lire(kind, uid, CLES.followup) };
}
/* `uid -> date` pour toute une liste : ces listes se redessinent toutes les secondes et demie,
   une requête par carte serait deux cents requêtes par seconde sur une base chargée. */
function cartes(kind) {
  exigerKind(kind);
  return { run: pref.carte(kind, CLES.run), followup: pref.carte(kind, CLES.followup) };
}
/* Tout ce qui est programmé, sur ce poste, dans l'ordre des dates. */
function lister() {
  const out = [];
  for (const kind of Object.keys(TABLES)) {
    for (const quoi of Object.keys(CLES)) {
      for (const [uid, at] of pref.carte(kind, CLES[quoi])) out.push({ kind, uid, quoi, at });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
// Ce qui est DÛ : une date atteinte ou dépassée.
function dus(now = new Date()) {
  return lister().filter((p) => new Date(p.at).getTime() <= now.getTime());
}

/* Un tick. Chaque programmation due est EFFACÉE puis honorée — dans cet ordre, pour qu'un
   échec ne la fasse pas revenir à chaque minute. Rend les jobs lancés. */
function tick(now = new Date(), onLog = () => {}) {
  const lances = [];
  for (const p of dus(now)) {
    pref.ecrire(p.kind, p.uid, CLES[p.quoi], null);
    const session = db.prepare(`SELECT id, uid FROM ${p.kind} WHERE uid = ?`).get(p.uid);
    if (!session) { onLog(t('log.programmation.disparue', { kind: p.kind, uid: p.uid })); continue; }
    try {
      if (p.quoi === 'run') {
        const job = p.kind === 'local_task' ? startLocalJob(session.id, {}) : startTaskJob(session.id, 'run', {});
        onLog(t('log.programmation.lancee', { kind: p.kind, id: session.id }));
        lances.push({ ...p, id: session.id, job });
      } else {
        /* Le suivi programmé part que la case « automatiquement » soit cochée ou non : la date
           EST l'armement. Sans texte, il n'y a rien à envoyer — le suivi a été envoyé à la main
           ou supprimé entre-temps, et on le dit plutôt que de lancer une passe vide. */
        const job = envoyerSuiviEnAttente(TABLES[p.kind].scope, session.id, onLog, { exigerCase: false });
        if (!job) { onLog(t('log.programmation.suivi-vide', { kind: p.kind, id: session.id })); continue; }
        lances.push({ ...p, id: session.id, job });
      }
    } catch (e) {
      onLog(t('log.programmation.echec', { kind: p.kind, id: session.id, message: e.message }));
    }
  }
  return lances;
}

let minuterie = null;
function demarrer(onLog = () => {}) {
  arreter();
  // Une minute : la granularité de la date qu'on saisit. Plus fin ne servirait à rien.
  minuterie = setInterval(() => { try { tick(new Date(), onLog); } catch { /* tick best-effort */ } }, 60000);
  if (minuterie.unref) minuterie.unref();
  return minuterie;
}
function arreter() { if (minuterie) { clearInterval(minuterie); minuterie = null; } }

module.exports = { CLES, TABLES, lireDate, programmer, lire, cartes, lister, dus, tick, demarrer, arreter };
