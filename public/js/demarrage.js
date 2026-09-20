'use strict';
/* Init : ce qui s'exécute au chargement — restaurer l'onglet, les rafraîchissements, Échap ferme la modale ouverte. */
/* ---------- Init ---------- */
/* Restaure le dernier onglet consulté (un rechargement ne renvoie plus sur « Reviews »),
   SAUF à la première ouverture de la journée : le brief passe alors devant. Une fois par
   jour calendaire, jamais deux — sinon chaque rechargement de la page ramènerait sur le
   brief celui qui était en train de lire un rapport. Le réglage vit en base (il vaut pour
   l'outil), la date du dernier affichage en localStorage (elle vaut pour ce navigateur). */
(function restoreTab() {
  /* UNE ADRESSE D'OBJET L'EMPORTE : `ouvrirDepuisAdresse()` y mène. Restaurer le dernier onglet —
     ou poser le brief du matin — par-dessus ouvrait le rapport dans un onglet caché, et le
     clic de restauration effaçait même l'adresse. On décide tout comme d'habitude (le brief est
     compté vu), on ne clique simplement pas. Une adresse mal formée, elle, ne mène nulle part :
     l'écran habituel s'ouvre. */
  const lienObjet = /^#\/(reviews\/\d+|notes\/\d+|sessions\/(\d+|[a-z]+\/\d+))$/.test(String(window.location.hash || ''));
  let tab = 'review';
  try { tab = localStorage.getItem('aidevtools_tab') || 'review'; } catch { /* ignore */ }
  const atterrir = () => {
    if (lienObjet) return;
    const btn = $(`nav button[data-tab="${tab}"]`);
    // Masqué depuis la dernière visite : on n'ouvre pas un écran dont le menu a disparu.
    if (btn && btn.hidden) { const premier = boutonsNav().find((x) => !x.hidden); if (premier) { premier.click(); return; } }
    if (btn && tab !== 'review') { btn.click(); return; }
    // B2 : sans catch, un échec d'API laissait la liste vide (écran blanc muet).
    loadSegment().catch((e) => { $('#toReviewList').innerHTML = errorBox(`Chargement impossible : ${e.message}`); });
  };
  /* LE CLIC ARRIVE APRÈS L'ÉVALUATION DU SCRIPT. Ouvrir un onglet appelle son chargement, et
     celui-ci lit des données déclarées plus bas dans ce fichier : cliquer ici, en pleine
     évaluation, échouait avec « Cannot access X before initialization » — l'onglet restait
     vide et l'écran affichait « Erreur inattendue » au rechargement. L'autre chemin passe par
     une promesse, donc après : le défaut ne se voyait qu'un rechargement sur deux. */
  if (briefDejaVuAujourdHui()) { queueMicrotask(atterrir); return; }
  api('/config').then((c) => {
    if (c.brief_on_open === '0') { atterrir(); return; }
    /* PREMIÈRE OUVERTURE, RIEN DE CONFIGURÉ : on n'ouvre pas sur le brief. Il dirait « rien ne
       réclame ton attention » à quelqu'un qui n'a encore rien branché, et le seul écran qui
       explique par où commencer — les trois étapes de démarrage — est celui des Reviews. Le
       brief est le bon écran d'accueil À PARTIR DU DEUXIÈME JOUR, pas à la première seconde. */
    if (!(c.gitlab_url && c.access_token)) { atterrir(); return; }
    marquerBriefVu();
    if (lienObjet) return;
    tab = 'notes';
    atterrir();
    /* APRÈS le clic, et pas avant : ouvrir l'onglet appelle `loadNotes()`, qui restaure le
       dernier sous-onglet consulté. On atterrirait donc sur Pages ou Todos — alors que ce
       qu'on vient chercher, une fois par jour, est précisément le brief. */
    showNotesSub('today');
  }).catch(atterrir);   // configuration illisible : on ne bloque jamais le démarrage
})();
rafraichirDemarrage();
refreshCounts();
refreshStatus();
rafraichirHistCount();
refreshOpenTodos();     // l'anti-doublon d'« Ajouter aux todos » a besoin de la liste
pollReminders();        // rattrapage des rappels échus pendant que l'onglet était fermé
/* TOP 5 — UNE ADRESSE COLLÉE L'EMPORTE SUR LE DERNIER ONGLET. On ouvre un lien reçu pour aller
   à CET objet-là ; restaurer l'onglet de la dernière visite par-dessus reviendrait à ignorer le
   lien qu'on vient de cliquer. Sans hash, rien ne change : la restauration habituelle a lieu. */
ouvrirDepuisAdresse();
refreshDockerBadges(); // badge santé Docker visible dès le démarrage, sans ouvrir l'onglet
amorcerBadgeJenkins();  // « combien de jobs ont tourné aujourd'hui », sans ouvrir l'onglet
// Rafraîchissement PÉRIODIQUE du badge santé Docker : on voit un container qui bascule en
// restarting/unhealthy (rouge/orange dans le titre du menu) même sans être sur l'onglet Docker.
// Léger : /docker/summary = un seul `docker ps -a` (pas d'inspect/compose config). En pause
// quand l'onglet du navigateur est masqué (rien à afficher), repris au retour.
setInterval(() => { if (!document.hidden) refreshDockerBadges(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDockerBadges(); });

// Mesure la hauteur réelle de l'en-tête → le panneau de logs sticky se cale juste en dessous.
(function stickHeader() {
  const hdr = document.querySelector('header'); if (!hdr) return;
  const set = () => document.documentElement.style.setProperty('--header-h', hdr.offsetHeight + 'px');
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(hdr);
  window.addEventListener('resize', set);
})();
setInterval(() => { if (!pollTimer) refreshStatus(); }, 5000);


/* Échap ferme la modale ouverte (avant : seules les vues plein écran réagissaient). */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#splitView').hidden) return; // gérée ailleurs
  const open = $$('.modal').filter((m) => !m.hidden).pop();
  if (!open) return;
  e.preventDefault();
  /* Certaines modales rendent une PROMESSE (choix d'un vérificateur, confirmation) : les
     masquer sans passer par leur bouton d'annulation laisse l'appelant en attente pour
     toujours — le bouton qui a ouvert la modale reste alors en chargement, indéfiniment.
     On clique donc le vrai bouton quand il existe. */
  const cancel = open.querySelector('#confirmCancel, #taskCancel, #ticketCancel, #bulkCancel, #verifyPickCancel');
  if (cancel) cancel.click(); else open.hidden = true;
});

