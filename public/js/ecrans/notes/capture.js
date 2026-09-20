'use strict';
/* Capture rapide (touche « n »), la syntaxe courte, C14, ajouter aux todos, rappels, atterrissage sur le brief. */
// @expose addTodoBtn, briefDejaVuAujourdHui, echeanceDepuisJira, marquerBriefVu, openCapture, pollReminders, prioriteDepuisJira
/* ---------- Capture rapide (touche « n ») ----------
   Un champ, Entrée, c'est fait. Le tri se fait plus tard : si la capture coûte plus de deux
   secondes, on retourne au post-it. La même modale sert à l'ÉDITION d'une todo existante —
   ce sont les mêmes champs, et deux formulaires jumeaux auraient divergé. */
let captureCtx = null;

function openCapture(ctx = {}) {
  captureCtx = ctx;
  const modal = $('#captureModal');
  const titre = $('#captureTitle');
  const details = $('#captureDetails');
  /* La todo à éditer se cherche d'abord parmi les ouvertes, puis parmi CELLES QUI SONT À
     L'ÉCRAN : le crayon est rendu sous « Faites » et « Archivées » aussi. Ne regarder que
     les ouvertes ouvrait une modale VIDE sur ces deux filtres — et valider écrasait alors
     priorité, note et échéance par les valeurs par défaut du formulaire. */
  const existante = ctx.editId
    ? (NOTES.open.find((t) => t.id === ctx.editId)
      || (NOTES.affichees || []).find((t) => t.id === ctx.editId))
    : null;
  if (ctx.editId && !existante) { toast(tr('err.notes.unknown'), true); return; }
  const source = existante || ctx;
  titre.value = source.title || '';
  /* C14 — LA PRIORITÉ PAR DÉFAUT EST LA DERNIÈRE CHOISIE. Quelqu'un qui pose surtout des
     todos « haute » repassait le sélecteur à chaque capture. Sur une todo qu'on ÉDITE ou qui
     arrive avec une priorité, c'est la sienne qui gagne — évidemment. */
  $('#capturePriority').value = source.priority
    || (() => { try { return localStorage.getItem('aidevtools_todo_prio') || 'normal'; } catch { return 'normal'; } })();
  $('#captureNote').value = source.note || '';
  $('#captureDue').value = source.due_at ? isoVersLocal(source.due_at) : '';
  /* Une todo qu'on édite s'ouvre dépliée : on vient justement changer un de ces champs. Et une
     todo qui ARRIVE avec une échéance ou une priorité reprises d'ailleurs aussi — sans quoi
     elles seraient posées à l'insu de celui qui valide. */
  details.hidden = !(ctx.editId || source.due_at || (source.priority && source.priority !== 'normal'));
  $('#captureMore').textContent = tr(details.hidden ? 'notes.capture.more' : 'notes.capture.less');
  modal.hidden = false;
  setTimeout(() => { titre.focus(); titre.select(); }, 0);
}
function closeCapture() { $('#captureModal').hidden = true; captureCtx = null; }

// ISO → valeur d'un <input type="datetime-local">, qui n'accepte que du LOCAL sans fuseau.
function isoVersLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- La syntaxe courte de la capture rapide ----------
   `n` ouvre une boîte pour noter ce qui vient de passer, sans changer d'écran. Trois choses
   revenaient à chaque fois — à quoi ça se rapporte, pour quand, et si ça presse — et il fallait
   déplier « détails » pour les trois. On les écrit donc DANS la phrase :

     !217  ou  PROJ-1408   ce à quoi la todo se rattache (merge request, ticket)
     @demain @lundi @12/09 l'échéance, posée à 9 h — l'heure où l'on lit ses rappels
     !!  /  !               priorité haute / basse

   Rien n'est deviné : ce qui n'est pas reconnu RESTE dans le titre, tel quel. Une note qui
   parlerait de « la version 1.2 » ne devient pas une échéance, et « !important » (deux
   caractères de plus) n'est pas la priorité `!!`. */
const RE_CAP_MR = /(?:^|\s)!(\d{1,6})(?=\s|$)/;
const RE_CAP_TICKET = /(?:^|\s)([A-Z][A-Z0-9]+-\d+)(?=\s|$)/;
const RE_CAP_HAUTE = /(?:^|\s)!!(?=\s|$)/;
const RE_CAP_BASSE = /(?:^|\s)!(?=\s|$)/;
const RE_CAP_QUAND = /(?:^|\s)@(\S+)(?=\s|$)/;

const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JOURS_SEMAINE_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/* Une échéance est un JOUR : on la pose à 9 h locales. « demain », un jour de la semaine (le
   prochain à venir), ou une date `12/09` / `12/09/2026` / `2026-09-12`. */
/* C14 — LES TROIS ÉCHÉANCES DU QUOTIDIEN, en un clic. La syntaxe courte (`@demain`, `@lundi`,
   `+1h`) les connaît déjà : le formulaire, lui, obligeait à passer par un sélecteur de date
   pour dire « demain matin ». On réutilise le MÊME calcul — deux façons de dire « demain » qui
   ne tomberaient pas le même jour seraient un piège. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-due-quick]');
  if (!b) return;
  const champ = $('#captureDue');
  if (!champ) return;
  const quoi = b.dataset.dueQuick;
  if (!quoi) { champ.value = ''; return; }
  if (quoi === '1h') {
    const d = new Date(Date.now() + 3600 * 1000);
    champ.value = isoVersLocal(d.toISOString());
    return;
  }
  const iso = quandDepuisMot(quoi);
  if (iso) champ.value = isoVersLocal(iso);
});

function quandDepuisMot(mot) {
  const m = String(mot || '').trim().toLowerCase();
  if (!m) return null;
  const a9h = (d) => { d.setHours(9, 0, 0, 0); return d.toISOString(); };
  const now = new Date();
  if (m === "aujourd'hui" || m === 'aujourdhui' || m === 'today') return a9h(new Date(now));
  if (m === 'demain' || m === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate() + 1); return a9h(d); }
  const ij = JOURS_SEMAINE.indexOf(m) >= 0 ? JOURS_SEMAINE.indexOf(m) : JOURS_SEMAINE_EN.indexOf(m);
  if (ij >= 0) {
    const d = new Date(now);
    // Le PROCHAIN : « @lundi » dit lundi, aujourd'hui compris s'il est encore devant nous.
    d.setDate(d.getDate() + ((ij - d.getDay() + 7) % 7 || 7));
    return a9h(d);
  }
  let g = m.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (g) {
    const an = g[3] ? (g[3].length === 2 ? 2000 + Number(g[3]) : Number(g[3])) : now.getFullYear();
    const d = new Date(an, Number(g[2]) - 1, Number(g[1]));
    if (!isNaN(d)) {
      // Sans année, une date déjà passée désigne l'an prochain : on ne pose pas un rappel mort.
      if (!g[3] && d < now) d.setFullYear(an + 1);
      return a9h(d);
    }
  }
  g = m.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (g) { const d = new Date(Number(g[1]), Number(g[2]) - 1, Number(g[3])); if (!isNaN(d)) return a9h(d); }
  return null;
}

function lireCaptureCourte(texte) {
  let t = String(texte || '');
  const out = { title: '', priority: '', due_at: '', link_kind: '', link_ref: '' };
  const mr = t.match(RE_CAP_MR);
  if (mr) { out.link_kind = 'mr'; out.link_ref = mr[1]; t = t.replace(mr[0], ' '); }
  if (!out.link_kind) {
    const tk = t.match(RE_CAP_TICKET);
    if (tk) { out.link_kind = 'ticket'; out.link_ref = tk[1].toUpperCase(); t = t.replace(tk[0], ' '); }
  }
  const q = t.match(RE_CAP_QUAND);
  if (q) {
    const iso = quandDepuisMot(q[1]);
    // Un `@mot` qu'on ne sait pas lire reste dans le titre : mieux vaut le voir que le perdre.
    if (iso) { out.due_at = iso; t = t.replace(q[0], ' '); }
  }
  if (RE_CAP_HAUTE.test(t)) { out.priority = 'high'; t = t.replace(RE_CAP_HAUTE, ' '); }
  else if (RE_CAP_BASSE.test(t)) { out.priority = 'low'; t = t.replace(RE_CAP_BASSE, ' '); }
  out.title = t.replace(/\s+/g, ' ').trim();
  return out;
}

/* `!217` désigne un NUMÉRO de merge request ; la todo, elle, se lie à son identifiant interne.
   Sans correspondance connue, on ne lie rien plutôt que de lier à côté. */
function idMrDepuisIid(iid) {
  const m = (toReviewRows || []).concat(reportRows || []).find((x) => Number(x.iid) === Number(iid));
  return m ? String(m.id) : '';
}

async function submitCapture() {
  const brut = $('#captureTitle').value;
  /* La syntaxe courte ne s'applique qu'à une capture NEUVE et non pré-liée : sur une édition,
     ou sur une todo créée depuis une merge request, le titre est déjà ce qu'il doit être. */
  const court = (captureCtx && (captureCtx.editId || captureCtx.link_kind)) ? null : lireCaptureCourte(brut);
  const body = {
    title: court && court.title ? court.title : brut,
    priority: (court && court.priority) || $('#capturePriority').value,
    note: $('#captureNote').value,
    due_at: (court && court.due_at) || $('#captureDue').value || null,
  };
  if (court && court.link_kind) {
    const ref = court.link_kind === 'mr' ? idMrDepuisIid(court.link_ref) : court.link_ref;
    if (ref) { body.link_kind = court.link_kind; body.link_ref = ref; }
    else { body.title = brut.trim(); }   // référence inconnue : on garde la phrase entière
  }
  if (captureCtx && captureCtx.link_kind) { body.link_kind = captureCtx.link_kind; body.link_ref = captureCtx.link_ref; }
  /* La priorité retenue est celle qui a servi à CRÉER, pas celle d'une édition : corriger une
     vieille todo en « basse » ne doit pas changer l'habitude de tous les jours. */
  if (!(captureCtx && captureCtx.editId)) {
    try { localStorage.setItem('aidevtools_todo_prio', body.priority || 'normal'); } catch { /* ignore */ }
  }
  const edit = captureCtx && captureCtx.editId;
  try {
    if (edit) await api(`/todos/${edit}`, { method: 'PUT', body });
    else await api('/todos', { method: 'POST', body });
    closeCapture();
    toast(tr(edit ? 'notes.todo.saved' : 'notes.capture.added'));
    await refreshOpenTodos();
    // Pas de navigation après une capture : on était en train de faire autre chose.
    if ($('#tab-notes').classList.contains('active')) { if (NOTES.sub === 'todos') loadTodos(); else loadBrief(); }
    majBoutonsTodo();
  } catch (e) { toast(explainError(e.message), true); }
}

$('#captureOk') && $('#captureOk').addEventListener('click', () => submitCapture());
$('#captureCancel') && $('#captureCancel').addEventListener('click', () => closeCapture());
$('#captureMore') && $('#captureMore').addEventListener('click', () => {
  const d = $('#captureDetails');
  d.hidden = !d.hidden;
  $('#captureMore').textContent = tr(d.hidden ? 'notes.capture.more' : 'notes.capture.less');
});
$('#captureTitle') && $('#captureTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitCapture(); }
});
fermerAuFond('#captureModal', () => closeCapture(), { salissable: true });

/* ---------- « Ajouter aux todos » depuis une MR ou un ticket ----------
   Le bouton connaît l'existant : une todo ouverte déjà liée au même objet le fait devenir
   « Voir la todo ». Créer un doublon silencieux serait la façon la plus sûre de rendre la
   liste inutilisable au bout d'une semaine. */
const todoLie = (kind, ref) => NOTES.open.find((t) => t.link_kind === kind && String(t.link_ref) === String(ref));

/* PRIORITÉ JIRA → PRIORITÉ DE TODO. Les noms varient d'une instance à l'autre (« Highest »,
   « Bloquant », « P1 »…) : on reconnaît les familles courantes dans les deux langues et, dans
   le doute, on ne décide pas — « normal » est le défaut du formulaire, et se change d'un clic. */
function prioriteDepuisJira(nom) {
  const n = String(nom || '').trim().toLowerCase();
  if (!n) return '';
  if (/^(highest|high|urgent|bloquant|blocker|critical|critique|haute|majeur|major|p0|p1)/.test(n)) return 'high';
  if (/^(lowest|low|basse|mineur|minor|trivial|p4|p5)/.test(n)) return 'low';
  return '';
}
/* L'échéance d'un ticket Jira est une DATE (`2026-09-12`), le rappel de Mergerie un INSTANT :
   on le pose à 9 h locales, l'heure à laquelle on lit ses rappels. */
function echeanceDepuisJira(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  const [a, m, j] = String(date).split('-').map(Number);
  return new Date(a, m - 1, j, 9, 0, 0).toISOString();
}

function addTodoBtn(kind, ref, titre, extra = {}) {
  const existante = todoLie(kind, ref);
  if (existante) {
    return `<button type="button" class="btn btn-sm" data-see-todo="${existante.id}" title="${esc(tr('notes.view-todo-title'))}">${svgIco('check')}${esc(tr('notes.view-todo'))}</button>`;
  }
  const sup = `${extra.due ? ` data-add-due="${esc(extra.due)}"` : ''}${extra.priority ? ` data-add-priority="${esc(extra.priority)}"` : ''}`;
  return `<button type="button" class="btn btn-sm" data-add-todo="${esc(kind)}" data-add-ref="${esc(ref)}" data-add-title="${esc(titre)}"${sup} title="${esc(tr('notes.add-todo-title'))}">${svgIco('clip')}${esc(tr('notes.add-todo'))}</button>`;
}

// Après création, le bouton encore à l'écran doit basculer : sinon on clique deux fois et
// on obtient le doublon que l'anti-doublon existe pour éviter.
function majBoutonsTodo() {
  $$('[data-add-todo]').forEach((b) => {
    const t = todoLie(b.dataset.addTodo, b.dataset.addRef);
    if (!t) return;
    b.outerHTML = `<button type="button" class="btn btn-sm" data-see-todo="${t.id}" title="${esc(tr('notes.view-todo-title'))}">${svgIco('check')}${esc(tr('notes.view-todo'))}</button>`;
  });
}

document.addEventListener('click', (e) => {
  const add = e.target.closest && e.target.closest('[data-add-todo]');
  if (add) {
    openCapture({
      title: add.dataset.addTitle, link_kind: add.dataset.addTodo, link_ref: add.dataset.addRef,
      due_at: add.dataset.addDue || '', priority: add.dataset.addPriority || 'normal',
    });
    return;
  }
  const see = e.target.closest && e.target.closest('[data-see-todo]');
  if (see) { navTab('notes'); showNotesSub('todos'); }
});

/* ---------- Rappels ----------
   Le poll existant des notifications interroge aussi les échéances. Deux subtilités :
     — le serveur n'écrit `reminded_at` qu'après CONFIRMATION du client, pour ne pas perdre
       un rappel quand la notification échoue ;
     — au premier passage (rattrapage), plusieurs rappels en retard donnent UNE notification
       groupée : dix pop-ups au démarrage se ferment sans être lues. */
let rappelsAmorces = false;
async function pollReminders() {
  const p = notifPrefs();
  let d;
  try { d = await api('/todos/reminders/due'); } catch { return; }
  const dus = d.due || [];
  /* Une échéance qui vient d'échoir fait passer sa todo du bleu au rouge : on relit la liste
     ici, sinon la pastille ne bougerait qu'à la prochaine visite de l'onglet. */
  await refreshOpenTodos();
  if (!dus.length) { rappelsAmorces = true; return; }
  const rattrapage = !rappelsAmorces && dus.length >= 2;
  rappelsAmorces = true;
  if (p.muted || notifPermission() !== 'granted' || !p.reminder) return;
  if (rattrapage) {
    showNotif(tr('notif.reminders-group.title', { n: dus.length, count: dus.length }),
      tr('notif.reminders-group.body'), () => { navTab('notes'); showNotesSub('today'); });
  } else {
    for (const t of dus) {
      showNotif(tr('notif.reminder.title', { title: t.title }), tr('notif.reminder.body'),
        () => { navTab('notes'); showNotesSub('todos'); });
    }
  }
  // Confirmation d'affichage : c'est elle qui consomme le rappel, pas la lecture.
  for (const t of dus) { try { await api(`/todos/${t.id}/reminded`, { method: 'POST' }); } catch { /* réessai au prochain passage */ } }
}
setInterval(pollReminders, 60000);

/* ---------- Atterrissage sur le brief ----------
   Une fois par jour CALENDAIRE, et seulement si le réglage est actif. La date du dernier
   affichage reste locale au navigateur : deux navigateurs ouverts n'ont pas à se voler le
   brief l'un l'autre, alors que le réglage, lui, vaut pour l'outil. */
const BRIEF_KEY = 'mergerie_brief_seen';
function briefDejaVuAujourdHui() {
  try { return localStorage.getItem(BRIEF_KEY) === new Date().toDateString(); } catch { return true; }
}
function marquerBriefVu() {
  try { localStorage.setItem(BRIEF_KEY, new Date().toDateString()); } catch { /* stockage indisponible */ }
}

