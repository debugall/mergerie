'use strict';
/* Jenkins : rafraîchissement automatique, et fin de mes lancements. */
// @expose jkAutoRelance, jkPeriodeMs
/* ---------- Rafraîchissement automatique, et fin de MES lancements ----------

   TOUTES LES 30 SECONDES, et seulement quand on REGARDE : l'onglet doit être ouvert et la
   fenêtre visible. Un sondage qui continue derrière un onglet masqué ou pendant qu'on est
   ailleurs dans l'application coûte à un Jenkins partagé sans rien apprendre à personne.
   La case le débraye, et le choix est mémorisé — un réglage qu'il faut refaire à chaque
   ouverture n'est pas un réglage. */
const JENKINS_AUTO = 'mergerie_jenkins_auto';
const JENKINS_LANCES = 'mergerie_jenkins_lances';
/* La cadence vient des RÉGLAGES (Réglages → Jenkins), comme celle des MR et celle de Jira :
   c'est un réglage de l'outil, pas du navigateur, et il doit valoir d'où qu'on regarde. Elle
   arrive par /api/status, avec le reste de l'état — un changement s'applique donc sans
   recharger la page. 0 = jamais. La case « ne pas rafraîchir tout seul » reste, elle, une pause
   locale et immédiate : elle l'emporte sans toucher au réglage de fond. */
let jkPeriodeMs = 60000;
let jkTimer = null;

const jkAutoCoupe = () => { try { return localStorage.getItem(JENKINS_AUTO) === '0'; } catch { return false; } };

function jkAutoRelance() {
  if (jkTimer) { clearInterval(jkTimer); jkTimer = null; }
  const onglet = $('#tab-jenkins');
  if (!onglet || !onglet.classList.contains('active') || jkAutoCoupe() || !jkPeriodeMs) return;
  jkTimer = setInterval(() => {
    // Onglet du navigateur masqué : on ne demande rien. Il redemandera au retour.
    if (document.hidden || !$('#tab-jenkins').classList.contains('active')) return;
    loadJenkins({ silencieux: true });
  }, jkPeriodeMs);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) jkAutoRelance(); });

/* CE QUE J'AI LANCÉ AUJOURD'HUI — le filtre « Mes lancements ». Jenkins ne sait pas répondre
   à cette question : il connaît l'auteur d'un build, pas l'outil d'où le clic est parti. On
   garde donc la trace ici, dans le navigateur, avec une seule règle : elle expire au bout de
   vingt-quatre heures. Avant, chaque entrée était effacée dès la fin du build — ce qui vidait
   le filtre une minute après le lancement, et seulement si l'onglet Jenkins était resté ouvert
   pour le voir finir : la même liste disait donc des choses différentes selon l'onglet qu'on
   avait laissé ouvert. Une journée est la bonne fenêtre : « qu'est-ce que j'ai lancé ce
   matin ? » est la question qu'on se pose devant cette case. */
const JK_LANCE_TTL = 24 * 3600 * 1000;
function jkLances() {
  let l; try { l = JSON.parse(localStorage.getItem(JENKINS_LANCES) || '{}'); } catch { return {}; }
  const vivants = {};
  for (const [k, v] of Object.entries(l)) { if (v && Date.now() - (v.at || 0) < JK_LANCE_TTL) vivants[k] = v; }
  if (Object.keys(vivants).length !== Object.keys(l).length) {
    try { localStorage.setItem(JENKINS_LANCES, JSON.stringify(vivants)); } catch { /* stockage indisponible */ }
  }
  return vivants;
}
function jkPoserLance(chemin) {
  const l = jkLances();
  l[chemin] = { at: Date.now() };
  try { localStorage.setItem(JENKINS_LANCES, JSON.stringify(l)); } catch { /* stockage indisponible */ }
}

/* CE QUE J'AI LANCÉ, et qui tourne encore : c'est le SERVEUR qui l'attend maintenant.
   L'attente vivait ici, dans le `localStorage`, et ne progressait donc que pendant que
   l'onglet Jenkins rafraîchissait sa liste — or on lance un build pour aller faire autre
   chose, et fermer l'onglet était justement le cas d'usage. Le lancement passe déjà par le
   serveur (`POST /api/jenkins/build`) : il lui envoie le numéro du dernier build connu, et
   c'est la veille de fond qui pousse `jenkins_done` quand le suivant est terminé. La
   notification, elle, se décide toujours ici, comme toutes les autres. */

