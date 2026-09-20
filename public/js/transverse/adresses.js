'use strict';
/* TOP 5 : des adresses pour les objets (`#/reviews/<id>`…), `isTrusted`, aller à une session. */
/* ---------- TOP 5 : des adresses pour les objets ----------
 *
 * L'application vivait à une seule adresse. Trois conséquences, toutes les trois quotidiennes :
 * on ne pouvait pas COLLER un lien vers une merge request dans une note ou un message, le
 * bouton Précédent du navigateur QUITTAIT l'outil (au lieu de revenir au rapport précédent), et
 * une notification cliquée depuis un autre onglet ne savait où atterrir qu'à l'aveugle.
 *
 * Trois objets portent donc une adresse : `#/reviews/<id>`, `#/sessions/<saveur>/<id>`,
 * `#/notes/<id>`. Volontairement PAS les onglets : l'outil rouvre déjà sur l'onglet et le stade
 * qu'on a quittés, et écrire l'onglet courant dans l'adresse ferait de chaque clic de menu une
 * entrée d'historique — Précédent deviendrait un « onglet précédent » que personne n'a demandé.
 *
 * `enRoutage` est la garde qui empêche la boucle : router écrit l'adresse, écrire l'adresse
 * déclenche `hashchange`, et `hashchange` router. */
let enRoutage = false;
/* Le routage est ASYNCHRONE (il charge une file, une liste, une page) et l'utilisateur, lui,
   ne l'attend pas : ouvrir un lien puis cliquer aussitôt un onglet doit laisser gagner le
   CLIC — sinon le routage atterrit une seconde plus tard et ramène là où l'on ne veut plus
   être. Chaque routage porte donc un numéro, et tout changement d'onglet manuel l'invalide. */
let seqRoutage = 0;

function poserAdresse(chemin) {
  if (window.location.hash === chemin) return;
  try { window.history.pushState(null, '', chemin); } catch { /* contexte sans historique */ }
}

/* Quitter l'objet, c'est quitter son adresse : un onglet n'en a pas (voir plus haut), et
   laisser `#/notes/4` dans la barre pendant qu'on regarde Docker ferait mentir le lien qu'on
   copierait — et ramènerait aux notes au prochain rechargement. */
function oublierAdresse() {
  seqRoutage += 1;                       // un routage en vol ne doit plus rien ramener
  if (!window.location.hash) return;
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search); }
  catch { /* contexte sans historique */ }
}

/* L'adresse → l'objet. Une adresse inconnue ou un objet disparu ne fait RIEN : atterrir sur
   une page d'erreur parce qu'un lien de la semaine dernière pointe une MR supprimée serait
   pire que de rester où l'on est. */
async function ouvrirDepuisAdresse() {
  const h = String(window.location.hash || '');
  const m = /^#\/(reviews|sessions|notes)\/(.+)$/.exec(h);
  if (!m) return false;
  const [, quoi, reste] = m;
  /* LES ÉTAPES SONT DÉROULÉES ICI, pas déléguées à `navMrReport`/`ouvrirSession` : entre deux
     chargements, l'utilisateur a pu reprendre la main (un chiffre du clavier, un clic sur un
     onglet). `vivant()` est le point de contrôle — sans lui, le routage arrivait une seconde
     plus tard et ramenait là où l'on ne voulait plus être. */
  const mon = ++seqRoutage;
  const vivant = () => mon === seqRoutage;
  enRoutage = true;
  try {
    if (quoi === 'reviews') {
      const id = Number(reste);
      navTab('review');
      await loadSegment('reviewed');
      if (vivant() && !reportRows.some((x) => x.id === id)) await loadSegment('done');
      if (vivant()) await openReport(id);
    } else if (quoi === 'notes') {
      navTab('notes');
      showNotesSub('pages');
      await openNotePage(Number(reste));
    } else {
      const [saveur, id] = reste.includes('/') ? reste.split('/') : ['code', reste];
      await ouvrirSession(Number(id), saveur, { vivant });
    }
  } catch { /* objet disparu : on reste où l'on est */ }
  finally { if (vivant()) enRoutage = false; }
  return true;
}

/* UN GESTE DE L'UTILISATEUR REPREND LA MAIN. `isTrusted` distingue la vraie frappe et le vrai
   clic des `click()` que le routage déclenche lui-même : sans ce filtre, le routage
   s'annulerait tout seul en naviguant. */
for (const ev of ['keydown', 'pointerdown']) {
  document.addEventListener(ev, (e) => { if (e.isTrusted && enRoutage) { seqRoutage += 1; enRoutage = false; } }, true);
}

window.addEventListener('hashchange', () => { ouvrirDepuisAdresse(); });
window.addEventListener('popstate', () => { ouvrirDepuisAdresse(); });

async function navMrReport(id) {
  navTab('review');
  await loadSegment('reviewed');
  if (!reportRows.some((m) => m.id === id)) await loadSegment('done');
  try { await openReport(id); } catch { /* rapport illisible : la liste reste utilisable */ }
}

let notifSeq = 0;
function showNotif(title, body, onclick) {
  if (!notifSupported() || Notification.permission !== 'granted') return;
  try {
    // requireInteraction : la notif RESTE affichée jusqu'à action/fermeture (au lieu de
    // s'effacer en quelques secondes → risque de la manquer). Tag unique par appel pour
    // que des événements distincts ne s'écrasent pas entre eux.
    const n = new Notification(title, {
      body: body || '', icon: '/favicon.ico',
      tag: `aidevtools-${notifSeq++}`, requireInteraction: true,
    });
    n.onclick = () => { try { window.focus(); } catch { /* focus refusé */ } if (onclick) onclick(); n.close(); };
  } catch { /* certains navigateurs restreignent hors interaction : on ignore */ }
}

function handleNotifEvent(e, p) {
  switch (e.type) {
    case 'queue_done':
      if (p.queue_done) showNotif(tr('notif.queue-done.title'), tr('notif.queue-done.body', { n: e.count, count: e.count }), () => navReviews('reviewed'));
      break;
    case 'review_done':
      if (p.low_note && e.note10 != null && e.note10 < p.threshold) {
        showNotif(tr('notif.low-note.title', { iid: e.iid, note: e.note10 }), tr('notif.low-note.body'), () => navMrReport(e.mr_id));
      }
      break;
    /* TOP 6 — UNE NOTIFICATION MÈNE À SON OBJET, pas à l'onglet. « L'IA a une question » ouvrait
       Dev IA sur le sous-onglet consulté la dernière fois, à charge de retrouver laquelle des
       douze sessions attend — alors que l'événement porte son identifiant depuis toujours. */
    case 'job_failed':
      if (p.job_failed) {
        showNotif(tr('notif.job-failed.title'), e.message || '', () => (e.mr_id ? navMrReport(e.mr_id)
          : (e.task_id ? ouvrirSession(e.task_id, 'code')
            : (e.local_task_id ? ouvrirSession(e.local_task_id, 'local')
              : (e.question_id ? ouvrirSession(e.question_id, 'ask') : navReviews('to_review'))))));
      }
      break;
    case 'session_done':
      if (p.session_done) {
        showNotif(tr('notif.session-done.title'), tr('notif.session-done.body'),
          () => (e.task_id ? ouvrirSession(e.task_id, 'code')
            : (e.local_task_id ? ouvrirSession(e.local_task_id, 'local') : navTab('task'))));
      }
      break;
    case 'needs_input':
      if (p.needs_input) {
        showNotif(tr('notif.needs-input.title'), tr('notif.needs-input.body'),
          () => (e.task_id ? ouvrirSession(e.task_id, 'code')
            : (e.local_task_id ? ouvrirSession(e.local_task_id, 'local') : navTab('task'))));
      }
      break;
    /* B14 — une opération git qui aboutit le dit : c'est le geste le plus irréversible de
       l'outil, et il se lançait en silence pendant qu'on regardait un autre onglet. */
    case 'git_done':
      if (p.git_done) {
        showNotif(tr('notif.git-done.title'), tr(`notif.git-done.${e.action || 'other'}`, { n: e.n || 1, count: e.n || 1 }),
          () => { navTab('git'); showGitSub('history'); });
      }
      break;
    /* B15 — un conteneur tombé. Décoché par défaut : sur une machine de développement, des
       conteneurs s'arrêtent tous les jours pour de bonnes raisons. */
    case 'docker_down':
      if (p.docker_down) {
        showNotif(tr('notif.docker-down.title', { n: e.n || 1, count: e.n || 1 }), e.names || '',
          () => navTab('docker'));
      }
      break;
    case 'converge_done':
      if (p.converge_done) {
        showNotif(
          tr(`notif.converge.${e.status === 'converged' ? 'converged' : 'stopped'}.title`, { iid: e.iid, note: e.note10 == null ? '—' : e.note10 }),
          tr('notif.converge.body', { passes: e.passes }),
          () => navMrReport(e.mr_id),
        );
      }
      break;
    case 'jira_status':
      /* Le corps porte l'ancien ET le nouvel état : « À faire → En cours » se lit d'un coup
         d'œil dans la notification, sans avoir à ouvrir l'outil pour comprendre. */
      if (p.jira_status) {
        showNotif(tr('notif.jira-status.title', { key: e.key }),
          tr('notif.jira-status.body', { from: e.from || '—', to: e.to || '—', summary: e.summary || '' }),
          () => { navTab('jira'); showJiraSub('watch'); });
      }
      break;
    case 'verify_done':
      /* Le verdict est ce qu'on attendait pour décider : on le met dans le TITRE, pas dans un
         corps qu'il faudrait déplier. Et on rafraîchit les listes, pour que le badge suive
         même si la notification n'est pas cliquée. */
      if (p.verify_done) {
        showNotif(tr(`notif.verify.${e.verdict === 'verified_pass' ? 'pass' : e.verdict === 'verified_fail' ? 'fail' : 'other'}.title`),
          tr('notif.verify.body'), () => openVerifyReport(e.verification_id));
      }
      break;
    /* TOP 14 — la fin d'un build QUE J'AI LANCÉ. L'événement vient du serveur : il arrive donc
       l'onglet fermé, l'onglet Jenkins jamais ouvert, ou la page rechargée entre-temps. */
    case 'jenkins_done':
      if (p.jenkins_done) {
        showNotif(tr('jenkins.notif.title', { job: e.path }),
          tr(`notif.jenkins-done.${e.ok ? 'ok' : 'ko'}`, { number: e.number || '', result: e.result || '' }),
          () => { navTab('jenkins'); openJenkinsJob(e.path); });
      }
      break;
    /* B12 — le dossier de l'utilisateur laissé détaché : on ouvre LE rapport qui le dit. */
    case 'restore_error':
      if (p.restore_error) {
        showNotif(tr('notif.restore-error.title'), e.message || '', () => openVerifyReport(e.verification_id));
      }
      break;
    /* B12 — le plafond : le travail n'est pas fait, et rien ne le disait hors de la console. */
    case 'cap_reached':
      if (p.cap_reached) {
        showNotif(tr(`notif.cap.${e.what === 'review' ? 'review' : 'verify'}.title`, { n: e.n, count: e.n }),
          tr('notif.cap.body', { cap: e.cap }), () => navReviews('to_review'));
      }
      break;
    case 'mr_new':
      if (p.mr_new) showNotif(tr('notif.mr-new.title', { iid: e.iid, project: e.project }), e.title || '', () => navReviews('to_review'));
      break;
    case 'mr_merged':
      if (p.mr_merged) showNotif(tr('notif.mr-merged.title', { iid: e.iid, project: e.project }), e.title || '',
        () => (e.mr_id ? navMrReport(e.mr_id) : navReviews('reviewed')));
      break;
    default: break;
  }
}

let notifCursor = null; // dernier id vu ; null = pas encore initialisé (on ne rejoue pas l'historique)
async function pollNotifications() {
  let d;
  try { d = await api('/notifications?after=' + (notifCursor == null ? '' : notifCursor)); } catch { return; }
  // 1er passage : on cale le curseur sans rien afficher (pas de rejeu de l'historique).
  if (notifCursor == null) { notifCursor = d.latest; return; }
  const p = notifPrefs();
  /* Rafraîchir l'écran n'est PAS une notification : ça ne doit dépendre ni du mode silencieux
     ni d'une permission navigateur. Un verdict qui vient de tomber doit apparaître sur les
     badges même quand les notifications bureau sont refusées. */
  if ((d.events || []).some((e) => e.type === 'verify_done')) {
    if (currentSeg === 'to_review') loadToReview(); else loadReports(currentSeg);
    loadLots();
  }
  // Muet ou permission non accordée : on avance quand même le curseur (pas d'accumulation).
  if (!p.muted && notifPermission() === 'granted') {
    for (const e of (d.events || [])) handleNotifEvent(e, p);
  }
  notifCursor = d.latest;
}
setInterval(pollNotifications, 5000);
pollNotifications();
$("#footerMute") && $("#footerMute").addEventListener("click", toggleMute);
updateMuteBtn();

// Toggle « mode silencieux » du footer (un clic, sans passer par les Réglages).
function toggleMute() {
  const p = notifPrefs();
  p.muted = !p.muted;
  setNotifPrefs(p);
  updateMuteBtn();
  toast(p.muted ? tr('notif.muted-on') : tr('notif.muted-off'));
}
function updateMuteBtn() {
  const b = $('#footerMute');
  if (!b) return;
  const muted = notifPrefs().muted;
  b.classList.toggle('on', muted);
  b.title = muted ? tr('notif.unmute-title') : tr('notif.mute-title');
  const u = b.querySelector('use');
  if (u) u.setAttribute('href', muted ? '#i-bell-off' : '#i-bell');
}

/* ALLER À UNE SESSION, ET LA MONTRER. Trois entrées menaient jusqu'ici à l'ONGLET seulement —
   la notification « l'IA a une question », la session créatrice d'une branche, un résultat de
   palette — en laissant chercher la bonne carte dans la liste. On ouvre donc la saveur qui la
   contient (sinon on atterrit sur le sous-onglet d'avant, où elle n'est pas), on recharge, et
   on défile dessus avec le même balayage unique que l'atterrissage d'un résultat.
   `kind` : 'code' | 'explore' | 'local' | 'ask'. */
const SESSION_SELECTEUR = {
  local: (id) => `#localList .card[data-local="${id}"]`,
  ask: (id) => `#askList .card[data-ask="${id}"]`,
};
async function ouvrirSession(id, kind = 'code', { vivant = () => true } = {}) {
  const saveur = ['explore', 'local', 'ask'].includes(kind) ? kind : 'code';
  navTab('task');
  const sous = $(`#tab-task .subnav [data-kind="${saveur}"]`);
  if (sous && saveur !== taskKind) sous.click();
  await loadTasks();
  if (!vivant()) return;                 // l'utilisateur a repris la main pendant le chargement
  const sel = (SESSION_SELECTEUR[saveur] || ((x) => `#taskList .task-row[data-task="${x}"]`))(Number(id) || 0);
  const carte = $(sel);
  if (!carte) return;
  // L'adresse est posée une fois qu'on a VRAIMENT atterri : une adresse vers une session
  // introuvable ne ramènerait nulle part au rechargement.
  poserAdresse(`#/sessions/${saveur}/${id}`);
  carte.scrollIntoView({ block: 'center', behavior: 'smooth' });
  carte.classList.add('just-landed');
  carte.addEventListener('animationend', () => carte.classList.remove('just-landed'), { once: true });
}

