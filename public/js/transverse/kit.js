'use strict';
/* LE KIT — ce que le front du cœur prête aux plugins, et rien d'autre.

   Le bundle d'un plugin (`/plugins/<nom>/bundle.js`, assemblé par `src/plugins/pageplugins.js`)
   enveloppe ses scripts dans une fonction qui reçoit `window.mergerie` et met EN PORTÉE chaque
   clé de premier niveau de cet objet : `$`, `api`, `tr`, `confirmDialog`… Un plugin n'a donc
   accès ni à une fonction du cœur qui n'est pas ici, ni à l'état d'un écran. C'est le contrat
   du front, et `scripts/check-front.js` le fait respecter : un nom du cœur utilisé par un
   plugin sans être dans ce kit fait échouer `npm run check`.

   UNE CLÉ PAR LIGNE, en tête de ligne : c'est ce que le serveur et les contrôles lisent pour
   connaître le kit. Les fonctions d'un ÉCRAN (reviews, notes, agents…) passent par un relais
   `(...a) => fn(...a)` — elles sont déclarées dans des fichiers chargés APRÈS celui-ci, et le
   relais ne les touche qu'à l'appel. Ce que le kit expose est couvert par la version de l'API
   des plugins (docs/plugins/UI.md). */
window.mergerie = {
  $,
  $$,
  onEl,
  api,
  tr,
  esc,
  safeUrl,
  safeImg,
  toast,
  busy,
  skeleton,
  svgIco,
  emptyState,
  copyText,
  debounce,
  comboHtml,
  wireCombo,
  repoComboHtml,
  wireRepoCombos,
  clavierCombo,
  filtrerLignes,
  placerMenu,
  dateHtml,
  depuis,
  teinteDe,
  fmtDate,
  fmtHour,
  fmtDateTime: (...a) => fmtDateTime(...a),
  mdToHtml,
  confirmDialog: (...a) => confirmDialog(...a),
  navTab: (...a) => navTab(...a),
  fermerAuFond,
  errorBox,
  explainError,
  signalerChamp,
  viderErreursChamps,
  erreurChamp,
  showNotif: (...a) => showNotif(...a),
  i18n: I18Nrt,
  repos: {
    options: () => repoOptions,
    load: () => loadRepoOptions(),
  },
  reviews: {
    openReport: (...a) => openReport(...a),
    rows: () => toReviewRows.concat(reportRows),
    isMine: (m) => estDeMoi(m),
    me: () => moiSurLesForges,
    reload: () => { if ($('#tab-review').classList.contains('active')) loadSegment(currentSeg); },
  },
  notes: {
    todoButton: (...a) => addTodoBtn(...a),
    refreshBrief: () => rafraichirBrief(),
  },
  agents: {
    investigate: (texte) => enqueterSurTexte(texte),
    detectTrace: (texte) => detecterTrace(texte),
  },
  sessions: {
    followupField: (taskId, targetId) => $(`#taskList .followup[data-followform="${targetId ? `tg${targetId}` : taskId}"] .followup-text`),
  },
  settings: {
    showTab: (sub) => showAdminSub(sub),
  },
  ui: pluginsUi,
  events: pluginsEvenements,
};
