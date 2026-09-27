'use strict';
/* Captures, pièces déjà jointes, ce que la session précédente emportait. */
// @expose readFileDataURL
/* ---- Captures ---- */
/* Une pièce jointe est un `{ name, data }` : le nom sert à l'écran ET dans le prompt — « le
   devis du client » dit ce qu'est le fichier, `pj_2.pdf` ne dit rien. Une capture collée n'en a
   pas : on lui en fabrique un. Vignette pour une image, puce nommée pour un document — c'est la
   seule différence entre les deux, et elle est d'affichage. */
const estImage = (p) => /^data:image\//i.test(p.data || '');
function renderTaskPreviews() {
  $('#taskPreviews').innerHTML = taskNewImages.map((p, i) => (estImage(p)
    ? `<span class="task-prev"><img src="${esc(safeImg(p.data))}" title="${esc(p.name)}" /><button type="button" data-rmimg="${i}" title="${esc(tr('task.piece.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button></span>`
    : `<span class="task-prev task-prev-doc" title="${esc(p.name)}">${svgIco('doc')}<span class="task-prev-nom">${esc(p.name)}</span><button type="button" data-rmimg="${i}" title="${esc(tr('task.piece.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button></span>`)).join('');
  $$('#taskPreviews [data-rmimg]').forEach((b) => b.addEventListener('click', () => {
    taskNewImages.splice(Number(b.dataset.rmimg), 1); renderTaskPreviews();
  }));
}
/* ---- Pièces DÉJÀ jointes (édition) ---- */
/* À la création, on voit ce qu'on vient de joindre. À l'édition, on ne voyait qu'une phrase :
   « 2 captures déjà jointes » — impossible de savoir LESQUELLES, de les rouvrir, ni d'en retirer
   une. On montre donc les vraies pièces : la vignette pour une image, le nom pour un document,
   les deux ouvrables, et la croix retire pour de bon (fichier compris).
   Le `scope` suit la saveur de la session ouverte : le formulaire est le même pour les quatre,
   la route l'est aussi, seul le mot change. */
let taskPieces = [];
let taskPiecesScope = 'task';
const pieceEstImage = (pj) => /^image\//i.test(pj.mime || '');
function renderTaskPieces() {
  const box = $('#taskPieces');
  if (!box) return;
  box.innerHTML = taskPieces.map((pj) => {
    const url = `/api/pieces/${taskPiecesScope}/${pj.id}`;
    /* Une pièce arrivée AVEC UN SUIVI n'a pas été jointe à la consigne qu'on est en train de
       modifier : la montrer sans le dire ferait croire qu'on peut la remplacer en réécrivant
       le prompt. */
    const titre = esc(pj.name + (pj.followup ? ` — ${tr('task.piece.from-followup')}` : ''));
    const dedans = pieceEstImage(pj)
      ? `<img src="${esc(safeImg(url))}" alt="${titre}" />`
      : `${svgIco('doc')}<span class="task-prev-nom">${esc(pj.name)}</span>`;
    return `<span class="task-prev${pieceEstImage(pj) ? '' : ' task-prev-doc'}${pj.followup ? ' task-prev-suivi' : ''}" title="${titre}">`
      + `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${dedans}</a>`
      + `<button type="button" data-rmpj="${pj.id}" title="${esc(tr('task.piece.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button></span>`;
  }).join('');
  $$('#taskPieces [data-rmpj]').forEach((b) => b.addEventListener('click', async () => {
    const pj = taskPieces.find((x) => String(x.id) === b.dataset.rmpj);
    if (!pj) return;
    // Le fichier part du disque : irréversible, donc on demande — comme partout ailleurs.
    if (!await confirmDialog({
      title: tr('task.piece.remove'), text: tr('task.piece.remove-confirm', { name: pj.name }),
      confirmLabel: tr('ui.remove'),
    })) return;
    try {
      await api(`/pieces/${taskPiecesScope}/${pj.id}`, { method: 'DELETE' });
      taskPieces = taskPieces.filter((x) => x.id !== pj.id);
      renderTaskPieces();
    } catch (e) { toast(explainError(e.message), true); }
  }));
}
function setTaskPieces(scope, liste) {
  taskPiecesScope = scope || 'task';
  taskPieces = Array.isArray(liste) ? liste : [];
  renderTaskPieces();
}
// Remet à neuf les DEUX listes du formulaire : ce qu'on vient de choisir, et ce qui est déjà là.
/* `piecesNoteProposees` est remis à zéro ICI, avec les autres pièces : c'est le passage
   obligé de TOUTES les ouvertures de la modale. Le laisser traîner ferait joindre les
   captures d'une note à la session suivante, qui n'a rien demandé. */
/* CE QUE LA SESSION PRÉCÉDENTE EMPORTAIT NE SUIT PAS LA SUIVANTE. Les skills cochés
   survivaient à la fermeture de la modale : la ligne `/deploy` d'hier repartait en tête d'un
   prompt qui n'avait rien demandé, invisible puisque le panneau des skills est replié. Une
   session ne les stocke nulle part (`skills_json` est sur l'AGENT, pas sur la session) : il
   n'y a donc rien à restaurer en édition, et les vider est le seul état honnête. */
function resetTaskFiles() {
  taskNewImages = []; piecesNoteProposees = []; taskSkillsCoches = new Set();
  renderTaskPreviews(); setTaskPieces('task', []);
}

function readFileDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
// Un nom pour ce qui n'en a pas : une image collée vient du presse-papiers, sans nom de fichier.
const nomDeCapture = (f, i) => (f && f.name && f.name !== 'image.png' ? f.name
  : `capture-${i}.${((f && f.type) || 'image/png').split('/')[1].replace('jpeg', 'jpg')}`);
async function addTaskImages(files) {
  for (const f of files) {
    if (!f) continue;
    taskNewImages.push({ name: nomDeCapture(f, taskNewImages.length + 1), data: await readFileDataURL(f) });
  }
  renderTaskPreviews();
}
$('#taskFile').addEventListener('change', (e) => { addTaskImages([...e.target.files]); e.target.value = ''; });
document.addEventListener('paste', (e) => {
  if ($('#taskModal').hidden) return;
  const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
  if (imgs.length) { e.preventDefault(); addTaskImages(imgs); }
});

