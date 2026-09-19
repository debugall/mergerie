'use strict';
/* Ce que plusieurs écrans demandent à Jira : le champ sprint, les statuts par projet, les tickets surveillés et leur timer, le badge du menu, ce qui est engagé sur un ticket, et prévenir Jira d’une MR.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const { etat: etatLocal, pref: prefLocale } = require('../../data/localstate');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const jira = require('../../integrations/jira');
const notify = require('../../core/notify');
const notes = require('../../notes/notes');
const demoDocker = require('../../demo/docker');
const demoJira = require('../../demo/jira');
const tasks = require('../../agent/tasks');
const { dernieresVerificationsParMr } = require('./verifications');

// Tickets assignés aux personnes cochées (`assignees` = accountIds séparés par des virgules ;
// vide = mes tickets). Filtre statut fait côté client.
/* Statuts par projet, mémorisés : un workflow ne change pas d'une minute à l'autre, et le
   filtre les redemanderait à chaque chargement de l'onglet. Vidé à l'enregistrement de la
   configuration, l'instance visée pouvant changer. */
const statutsParProjet = new Map();
/* Identifiant du champ « sprint », résolu une fois puis mémorisé : il ne change pas en cours
   de route, et le redemander à chaque chargement coûterait un appel Jira pour rien. Remis à
   zéro à l'enregistrement de la configuration (l'instance visée peut changer). */
let champSprint = null;   // null = pas encore cherché ; '' = cherché, absent
async function sprintFieldId(cfg) {
  if (champSprint !== null) return champSprint;
  try {
    const trouve = jira.detectSprintField(await jira.allFields(cfg));
    champSprint = trouve ? trouve.id : '';
  } catch {
    /* Droits manquants ou panne : on s'en passe cette fois, sans casser l'onglet — mais sans le
       mémoriser, sinon une coupure de quelques secondes cachait le filtre Sprints jusqu'au
       prochain enregistrement des réglages. */
    return '';
  }
  return champSprint;
}
/* ---------- Tickets Jira surveillés ----------------------------------------
   Surveiller un ticket = mémoriser son état, et être prévenu quand il change. On stocke le
   DERNIER état connu au moment de l'ajout : sans ça, la première vérification comparerait
   à du vide et notifierait un changement qui n'a pas eu lieu.

   Une erreur (ticket supprimé, droits perdus, Jira injoignable) est rangée sur la ligne
   concernée et affichée ; elle n'interrompt jamais la vérification des autres. */

/* `checked_at` et `error` ont quitté la table : QUAND CE POSTE a regardé, et l'erreur réseau
   qu'il a rencontrée, ne disent rien à un collègue — chez lui, la réponse de Jira sera
   différente et son horloge aussi. Ce qu'on surveille est d'équipe ; le fait de l'avoir
   regardé est de poste. On les recolle donc à la lecture, en DEUX requêtes et non une par
   ligne : cette liste se redessine souvent. */
function watchRows() {
  const vus = etatLocal.carte('jira_watch', 'checked_at');
  const erreurs = etatLocal.carte('jira_watch', 'error');
  return db.prepare('SELECT * FROM jira_watch ORDER BY key').all().map((r) => ({
    ...r, checked_at: vus.get(r.key) || null, error: erreurs.get(r.key) || null,
  }));
}
const marquerVu = (key, erreur = null) => {
  etatLocal.ecrire('jira_watch', key, 'checked_at', new Date().toISOString());
  etatLocal.ecrire('jira_watch', key, 'error', erreur);
};
// Compteur du menu, en cache : le client l'interroge souvent, Jira ne doit pas l'être autant.
let jiraBadge = { inProgress: 0, at: null, error: null };
/* La note tient sur une ligne ou deux : c'est un rappel, pas un journal. On la borne plutôt
   que de laisser une colonne libre s'étaler dans une liste où chaque ticket doit rester lisible. */
const MAX_NOTE_WATCH = 500;
const lireNote = (v) => String(v == null ? '' : v).trim().slice(0, MAX_NOTE_WATCH);
/* Vérifie tous les tickets surveillés et notifie les changements d'état.
   Appelée par le timer ET par le bouton « Vérifier maintenant » — même code, donc ce que
   le bouton montre est exactement ce que le timer fait. */
/* Une seule vérification à la fois, TOUS APPELANTS CONFONDUS (timer, bouton « Vérifier
   maintenant », double clic). Deux passages simultanés liraient le même ancien état et
   notifieraient deux fois le même changement — exactement ce qu'on ne veut pas. Les appels
   concurrents partagent donc le résultat de celle qui tourne déjà. */
let checkEnCours = null;
function checkJiraWatch() {
  if (!checkEnCours) checkEnCours = faireCheckJiraWatch().finally(() => { checkEnCours = null; });
  return checkEnCours;
}
async function faireCheckJiraWatch() {
  const rows = watchRows();
  const now = new Date().toISOString();
  const resultat = { checked: rows.length, changed: 0, errors: 0 };
  if (!rows.length) return resultat;

  let etats = [];
  try {
    etats = demoDocker.isDemo()
      ? rows.map((r) => { const d = demoJira.issue(r.key); return d && { key: r.key, summary: d.summary, status: d.status, statusCategory: d.statusCategory }; }).filter(Boolean)
      : await jira.statusOfKeys(getConfig(), rows.map((r) => r.key));
  } catch (e) {
    // Jira injoignable : on marque toutes les lignes, sans rien perdre de l'état connu.
    for (const r of rows) marquerVu(r.key, String(e.message).slice(0, 300));
    resultat.errors = rows.length;
    return resultat;
  }

  const parCle = new Map(etats.map((i) => [i.key, i]));
  const majSql = db.prepare(`UPDATE jira_watch SET summary = ?, status = ?, status_category = ?,
                             changed_at = ? WHERE key = ?`);
  const inchangeSql = db.prepare('UPDATE jira_watch SET summary = ? WHERE key = ?');
  const maj = (summary, statut, categorie, quand, cle) => { majSql.run(summary, statut, categorie, quand, cle); marquerVu(cle); };
  const inchange = (summary, cle) => { inchangeSql.run(summary, cle); marquerVu(cle); };
  const absent = (cle, erreur) => marquerVu(cle, erreur);
  for (const r of rows) {
    const cur = parCle.get(r.key);
    if (!cur) { absent(r.key, t('err.jira.watch-unreachable')); resultat.errors += 1; continue; }
    if ((cur.status || '') !== (r.status || '')) {
      maj(cur.summary || '', cur.status || '', cur.statusCategory || '', now, r.key);
      resultat.changed += 1;
      /* On ne notifie QUE si un état précédent était connu. Sans état de référence il n'y a pas
         de changement à annoncer, seulement une première observation — la signaler ferait sonner
         l'outil pour rien. Le nouvel état devient la référence : tant qu'il ne rebouge pas, plus
         aucune notification, quel que soit le nombre de vérifications. */
      if (r.status) {
        notify.push('jira_status', { key: r.key, summary: cur.summary || '', from: r.status, to: cur.status || '' });
        /* B5 — LA TODO QUI SURVIT À LA NOTIFICATION. Une notification bureau se ferme avec
           l'onglet ; une todo reste sous les yeux, dans Notes et dans le brief — c'est
           exactement ce que fait déjà une session arrêtée sur une question. Le MOTIF de
           surveillance devient la note : c'est lui qui dit quoi faire, trois semaines après
           l'avoir écrit. Opt-in, ticket par ticket. */
        if (r.todo_on_change) {
          try {
            notes.todoAuto('jira_watch', r.key,
              t('todo.jira-watch.title', { key: r.key, from: r.status, to: cur.status || '' }),
              [r.note || '', cur.summary || ''].filter(Boolean).join('\n'));
          } catch { /* best-effort : la surveillance ne doit pas casser pour une todo */ }
        }
      }
    } else {
      inchange(cur.summary || r.summary || '', r.key);
    }
  }
  return resultat;
}
/* ---------- « Dans Mergerie » : ce qui est déjà engagé sur un ticket ----------
   « Où en est PROJ-1408 ? » se répondait en ouvrant le ticket (rien), puis Reviews, puis en
   cherchant « 1408 », puis en revenant à Jira. Tout est en base : les merge requests portent
   la clé (relevée à la découverte, `ticket_jira_key`) ou l'ont dans leur branche ou leur
   titre, et les sessions de codage la portent dans le nom de branche qu'on leur a donné. */
function engagementsSurTicket(cle) {
  const k = String(cle || '').toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(k)) return { mrs: [], tasks: [] };
  const motif = `%${k}%`;
  const mrs = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.status, mr.closed_seen, mr.web_url, repo.project
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE UPPER(COALESCE(mr.ticket_jira_key, '')) = ?
       OR UPPER(mr.source_branch) LIKE ? OR UPPER(COALESCE(mr.title, '')) LIKE ?
    ORDER BY mr.id DESC LIMIT 20`).all(k, motif, motif);
  const notes = {};
  if (mrs.length) {
    const trous = mrs.map(() => '?').join(',');
    const ids = mrs.map((m) => m.id);
    for (const v of db.prepare(`SELECT mr_id, note_value FROM review_version rv WHERE mr_id IN (${trous})
      AND version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all(...ids)) {
      notes[v.mr_id] = v.note_value;
    }
  }
  const verifs = dernieresVerificationsParMr();
  const tasks = db.prepare(`SELECT DISTINCT task.id, task.prompt, task.label, task.status, task.kind
    FROM task JOIN task_target tt ON tt.task_id = task.id
    WHERE UPPER(COALESCE(tt.branch, '')) LIKE ? OR UPPER(COALESCE(task.prompt, '')) LIKE ?
       OR UPPER(COALESCE(task.label, '')) LIKE ?
    ORDER BY task.id DESC LIMIT 10`).all(motif, motif, motif);
  return {
    mrs: mrs.map((m) => ({
      ...m, closed: !!m.closed_seen,
      note: notes[m.id] != null ? notes[m.id] : null,
      verdict: (verifs.get(m.id) || {}).verdict || null,
    })),
    tasks,
  };
}
async function refreshJiraBadge() {
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) { jiraBadge = { inProgress: 0, at: null, error: null }; return; }
  try { jiraBadge = { inProgress: await jira.countMineInProgress(cfg), at: new Date().toISOString(), error: null }; }
  catch (e) { jiraBadge = { ...jiraBadge, error: String(e.message).slice(0, 200) }; }
}
/* Timer de surveillance : même forme que le rafraîchissement auto des MR (0 = désactivé,
   pas de chevauchement). Il porte les deux besoins — l'état des tickets surveillés et le
   compteur du menu — parce qu'ils interrogent la même API et ont la même cadence utile. */
let jiraWatchTimer = null;
let jiraWatchBusy = false;
function restartJiraWatch() {
  if (jiraWatchTimer) { clearInterval(jiraWatchTimer); jiraWatchTimer = null; }
  const min = Number(getConfig().jira_watch_minutes) || 0;
  if (min <= 0) { console.log('[jira-watch] désactivé'); return; }
  const tour = async () => {
    if (jiraWatchBusy) return;
    jiraWatchBusy = true;
    try {
      await refreshJiraBadge();
      const r = await checkJiraWatch();
      if (r.changed) console.log(`[jira-watch] ${r.changed} changement(s) d'état sur ${r.checked} ticket(s)`);
    } catch (e) { console.error(`[jira-watch] échec : ${e.message}`); }
    finally { jiraWatchBusy = false; }
  };
  jiraWatchTimer = setInterval(tour, min * 60 * 1000);
  tour();
  console.log(`[jira-watch] activé : toutes les ${min} min`);
}
/* LES MÊMES BOUTONS, SUR UNE LIGNE DE PROJET DE SESSION. Elle a un dépôt et une branche : les
   deux valeurs dont `{env}` et `{branch}` ont besoin. `{mr_iid}` n'est résolu que si la
   session a déjà ouvert sa merge request — sinon le gabarit qui la cite reste « incomplet »,
   ce que l'écran dit déjà. */
/* ---------- B5 : prévenir Jira quand la session ouvre sa merge request ----------
   La session multi-dépôts ouvre cinq merge requests ; on passait dix minutes dans Jira à
   coller cinq liens et à bouger cinq tickets. Un commentaire, et la transition vers l'état
   « en revue » si elle existe — en un appel, DERRIÈRE CONFIRMATION côté écran.

   La transition n'est pas devinée : on lit celles que Jira propose pour CE ticket et on prend
   la première dont l'état d'arrivée est de catégorie « en cours » (`indeterminate`). Aucune ne
   correspond ? On commente quand même et on le dit — écrire chez les autres est déjà le
   principal, et inventer un état serait pire que de n'en changer aucun. */
async function prevenirJira(cible) {
  const cle = jira.ticketKey(cible.branch || '', cible.branch || '');
  if (!cle) throw new Error(t('err.jira.no-key-in-branch'));
  const iid = cible.mr_iid || cible.existing_mr_iid;
  if (!iid) throw new Error(t('err.jira.no-mr-yet'));
  const cfg = getConfig();
  const texte = t('jira.notify.body', { iid, project: cible.project, url: cible.mr_url || '' });
  if (demoDocker.isDemo()) return { demo: true, key: cle, commented: true, transitioned: true };
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  await jira.addComment(cfg, cle, texte);
  let transitioned = false;
  try {
    const dispo = await jira.transitions(cfg, cle);
    const vers = dispo.find((x) => x.to && x.to.statusCategory === 'indeterminate');
    if (vers) { await jira.transitionIssue(cfg, cle, vers.id); transitioned = true; }
  } catch { transitioned = false; }   // commenter a réussi : c'est l'essentiel, on le dit
  return { key: cle, commented: true, transitioned };
}

/* Le champ sprint se recherche sur l'instance Jira configurée : quand elle change, on oublie
   ce qu'on avait trouvé. Appelé par PUT /api/config. */
function oublierChampSprint() { champSprint = null; }

/* Le compteur du menu est un état de module que `refreshJiraBadge` REMPLACE : un module qui
   l'importerait n'en verrait que la première valeur. On le lit donc par une fonction. */
function lireJiraBadge() { return jiraBadge; }

/* Arrêter la surveillance : appelé quand le serveur se ferme — un timer oublié garde le
   process en vie, et la suite de tests ne rendrait jamais la main. */
function arreterJiraWatch() { if (jiraWatchTimer) { clearInterval(jiraWatchTimer); jiraWatchTimer = null; } }

module.exports = {
  statutsParProjet, champSprint, sprintFieldId, watchRows, marquerVu, jiraBadge, MAX_NOTE_WATCH, lireNote, checkEnCours, checkJiraWatch, faireCheckJiraWatch, engagementsSurTicket, refreshJiraBadge, jiraWatchTimer, jiraWatchBusy, restartJiraWatch, prevenirJira, oublierChampSprint, lireJiraBadge, arreterJiraWatch,
};
