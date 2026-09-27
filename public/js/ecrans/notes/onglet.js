'use strict';
/* Onglet Notes : en-tête, la table de l'autolien, rendu markdown + autolien, insérer au curseur. */
// @expose NOTES, loadNotes, showNotesSub
/* ============ Onglet Notes : brief, todos et pages ============
   Des post-it de poste de travail, pas une base de connaissances. Tout est local, tout est
   déterministe : aucun appel IA, aucun token — le brief doit s'afficher instantanément à
   l'ouverture, avant même le premier café. */
const NOTES = {
  sub: 'today',
  /* C6 — LE SEUL FILTRE QUOTIDIEN DE L'APPLICATION QUI REPARTAIT À ZÉRO. Reviews, Docker,
     Jenkins et Git retiennent le leur ; celui des todos revenait à « À faire » à chaque
     visite, y compris pour qui vit dans « Faites » en fin de semaine. Mémoire de navigateur :
     la perdre ne perd qu'un confort. */
  filter: (() => { try { return localStorage.getItem('aidevtools_todo_filtre') || 'open'; } catch { return 'open'; } })(),
  pages: [],
  pageId: null,
  page: null,
  index: { mrs: {}, jira: false },   // table de résolution de l'autolink
  open: [],             // todos ouvertes : sert à l'anti-doublon d'« Ajouter aux todos »
  affichees: [],        // la liste RÉELLEMENT à l'écran (le filtre courant), pour l'édition
};

const NOTES_SUBS = { today: 'notesSubToday', todos: 'notesSubTodos', pages: 'notesSubPages' };

function showNotesSub(sub) {
  NOTES.sub = NOTES_SUBS[sub] ? sub : 'today';
  $$('#tab-notes .subnav button').forEach((b) => b.classList.toggle('active', b.dataset.nsub === NOTES.sub));
  Object.entries(NOTES_SUBS).forEach(([k, id]) => { const el = $(`#${id}`); if (el) el.hidden = k !== NOTES.sub; });
  try { localStorage.setItem('mergerie_notes_sub', NOTES.sub); } catch { /* stockage indisponible */ }
  if (NOTES.sub !== 'pages') viderPageSave();
  if (NOTES.sub === 'today') loadBrief();
  if (NOTES.sub === 'todos') loadTodos();
  if (NOTES.sub === 'pages') loadPages();
}
$$('#tab-notes .subnav button').forEach((b) => b.addEventListener('click', () => showNotesSub(b.dataset.nsub)));

function loadNotes() {
  let sub = NOTES.sub;
  try { sub = localStorage.getItem('mergerie_notes_sub') || sub; } catch { /* stockage indisponible */ }
  showNotesSub(sub);
}

/* La table de résolution de l'autolink, mise en cache : elle change quand des MR arrivent,
   pas entre deux frappes. On la relit à chaque ouverture de l'onglet, pas à chaque rendu —
   une page qui se réaffiche à chaque caractère tapé ne doit pas interroger le serveur. */
async function notesIndex(force = false) {
  if (!force && NOTES.indexAt && Date.now() - NOTES.indexAt < 60000) return NOTES.index;
  try {
    NOTES.index = await api('/notes-index');
    NOTES.indexAt = Date.now();
  } catch { /* index indisponible : le texte reste du texte, sans lien mort */ }
  return NOTES.index;
}

/* Rendu Markdown + autolink. L'ordre importe : `mdToHtml` échappe, l'autolink s'applique
   APRÈS et n'injecte que des balises qu'il fabrique lui-même. On saute les blocs de code :
   `!42` dans un extrait de shell est du code, pas une merge request. */
const NOTE_CODE_RE = /(<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/;
/* Insère du texte à la position du curseur d'un champ, et laisse le curseur APRÈS — comme
   une frappe. Remplacer toute la valeur enverrait le curseur à la fin du document, ce qui se
   remarque tout de suite quand on colle une capture au milieu d'un paragraphe. */
function insererAuCurseur(champ, texte) {
  const debut = champ.selectionStart != null ? champ.selectionStart : champ.value.length;
  const fin = champ.selectionEnd != null ? champ.selectionEnd : debut;
  const avant = champ.value.slice(0, debut);
  const apres = champ.value.slice(fin);
  /* Une image sur SA ligne : collée en plein milieu d'une phrase, elle couperait le paragraphe
     en deux au rendu — et un Markdown qu'on relit ailleurs deviendrait illisible. */
  const tete = avant && !avant.endsWith('\n') ? '\n\n' : '';
  const queue = apres && !apres.startsWith('\n') ? '\n\n' : '\n';
  champ.value = avant + tete + texte + queue + apres;
  const pos = (avant + tete + texte + queue).length;
  champ.setSelectionRange(pos, pos);
  champ.focus();
}

function renderNoteMd(md) {
  const html = mdToHtml(md);
  /* Le rendu des diagrammes est demandé ICI, pas chez l'appelant : `renderNoteMd` est le seul
     passage obligé du Markdown des notes, et une douzaine d'appels à ne pas oublier auraient
     fini par en oublier un. La passe cherche dans tout le document, après insertion. */
  if (html.includes('data-mermaid')) planifierMermaid();
  return html.split(NOTE_CODE_RE)
    .map((part, i) => (i % 2 ? part : NOTESRT.autolink(part, NOTES.index)))
    .join('');
}

