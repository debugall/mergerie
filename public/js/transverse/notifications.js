'use strict';
/* Notifications bureau. */
/* ---------- Notifications bureau ----------
   Critère : une notif appelle une ACTION ou clôt une ATTENTE. Le reste (ambiance)
   est au footer. Le serveur émet des faits ; le client filtre selon SES préférences
   (types activés, seuil de note, mode silencieux) et navigue au clic. */
const NOTIF_KEY = 'mergerie_notif';
// Migration silencieuse depuis l'ancienne clé (renommage open-source) : on recopie une fois puis on l'efface.
try { const _oldNotif = localStorage.getItem('aidevtools_notif'); if (_oldNotif != null && localStorage.getItem(NOTIF_KEY) == null) { localStorage.setItem(NOTIF_KEY, _oldNotif); localStorage.removeItem('aidevtools_notif'); } } catch { /* stockage indisponible */ }
const NOTIF_DEFAULTS = {
  queue_done: true,   // fin de la file de reviews (le lot) — LE cas d'usage
  low_note: true,     // review sous un seuil — actionnable
  job_failed: true,   // échec (timeout, CLI, réseau) — silence = mauvaise surprise
  session_done: true, // session de codage prête à push/MR
  needs_input: true,  // l'agent a posé des questions — clôt une attente, actionnable
  converge_done: true, // boucle de convergence terminée — actionnable par excellence
  jira_status: true,  // un ticket surveillé change d'état — c'est LA raison de le surveiller
  verify_done: true,  // un verdict objectif est tombé — c'est ce qu'on attendait pour merger
  jenkins_done: true, // un job Jenkins QUE J'AI LANCÉ s'est terminé — on ne reste pas devant
  mr_new: false,      // nouvelle MR — utile pour certains, spam pour d'autres
  mr_merged: false,   // MR mergée — informatif, pas actionnable
  /* B14/B15 — LES TROIS FAMILLES QUI NE DISAIENT RIEN. Une opération git est le geste le plus
     irréversible de l'outil et ne notifiait ni succès ni échec ; un conteneur qui tombe ne
     réveillait personne ; un build Jenkins n'était vu que si l'onglet était ouvert. Docker est
     DÉCOCHÉ par défaut : sur une machine de développement, des conteneurs s'arrêtent tous les
     jours pour de bonnes raisons, et une alarme qui sonne toujours n'est plus lue. */
  git_done: true,     // une opération git a abouti — on est déjà parti voir ailleurs
  docker_down: false, // un conteneur est tombé — opt-in : une machine de dev en voit passer
  /* B12 — les deux silences du serveur. Un dossier de l'utilisateur laissé détaché est le
     pire état que l'outil puisse laisser et ne se voyait qu'en ouvrant le rapport ; un plafond
     atteint se lit comme « tout a été fait » alors que du travail attend un clic. */
  restore_error: true, // un dossier de travail n'a pas été rendu dans son état — toujours
  cap_reached: true,   // des MR laissées de côté par un plafond automatique
  threshold: 5,       // seuil « note basse » (sur 10)
  muted: false,       // mode silencieux global (toggle footer)
};
function notifPrefs() { try { return { ...NOTIF_DEFAULTS, ...JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}') }; } catch { return { ...NOTIF_DEFAULTS }; } }
function setNotifPrefs(p) { try { localStorage.setItem(NOTIF_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ } }
const notifSupported = () => typeof Notification !== 'undefined';
const notifPermission = () => (notifSupported() ? Notification.permission : 'unsupported');

// Navigation au clic : ramène au bon endroit via le routage d'onglets existant.
