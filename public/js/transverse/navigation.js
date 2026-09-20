'use strict';
/* Onglets : `[data-tab]` est la condition ; `navTab`, `navReviews`. */
/* ---------- Onglets ----------
   `[data-tab]` EST LA CONDITION, pas un raccourci d'écriture. Depuis que la navigation vit
   dans une colonne, le bouton de repli est lui aussi un `nav button` — sans ce filtre, le
   replier désactivait tous les onglets, vidait l'écran, et mémorisait « undefined » comme
   dernier onglet : le rechargement suivant n'affichait rien non plus. */
$$('nav button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  /* TOP 5 — CHANGER D'ONGLET QUITTE L'ADRESSE DE L'OBJET. Un onglet n'a pas d'adresse ; laisser
     `#/notes/4` dans la barre pendant qu'on regarde Docker ferait mentir le lien qu'on
     copierait, et ramènerait aux notes au prochain rechargement. Cela ANNULE aussi un routage
     encore en vol : ouvrir un lien puis cliquer aussitôt ailleurs doit laisser gagner le clic,
     pas le chargement parti une seconde plus tôt. Le routage, lui, passe par ici en se
     déclarant (`enRoutage`) : il ne s'annule donc pas lui-même. */
  if (!enRoutage) oublierAdresse();
  $$('nav button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'admin') showAdminSub();
  if (b.dataset.tab === 'task') loadTasks();
  if (b.dataset.tab === 'agents') loadAgents();
  if (b.dataset.tab === 'review') loadSegment();
  if (b.dataset.tab === 'dashboard') loadDashboard();
  if (b.dataset.tab === 'git') loadGit();
  if (b.dataset.tab === 'docker') { marquerDockerVu(); loadDocker(); }
  else dlogStop(); // en quittant Docker, on coupe le tail live (et ses process serveur)
  if (b.dataset.tab === 'jira') loadJira();
  if (b.dataset.tab === 'notes') loadNotes();
  if (b.dataset.tab === 'links') loadLinks();
  if (b.dataset.tab === 'jenkins') loadJenkins();
  try { localStorage.setItem('aidevtools_tab', b.dataset.tab); } catch { /* ignore */ }
}));

function navTab(tab) { const b = $(`nav button[data-tab="${tab}"]`); if (b) b.click(); }
function navReviews(seg) { navTab('review'); loadSegment(seg); }
/* Ouvrir un rapport depuis AILLEURS (palette, bandeau de job, notification). Deux pièges :
   — le stade. `#reportSplit` est masqué tant qu'on est sur « à traiter » : ouvrir le rapport
     sans changer de stade affiche un panneau invisible, et l'écran a l'air de n'avoir rien fait.
   — le moment. La version précédente attendait 300 ms « le temps que la liste arrive » ; sur une
     machine chargée elle n'était pas là. `loadSegment` rend une promesse : on l'attend.
   Une merge request classée vit dans « Traitées » : si elle n'est pas dans les reviewées, on y
   passe plutôt que d'ouvrir un rapport dans une liste où sa carte n'apparaît pas. */
