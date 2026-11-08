'use strict';
/* L'ATTERRISSAGE SUR UNE SESSION, depuis ailleurs (une review, une notification, la palette).
   Le balayage de 0,9 s suffisait à l'explorateur ; pas à une liste de trente cartes qu'un
   défilement lissé met une seconde à atteindre, et qui se redessine toutes les 1,5 s. Ici la
   carte garde un contour tant que l'utilisateur n'a pas cliqué ailleurs (ou Échap), le contour
   survit aux re-rendus, et un bandeau en tête de liste dit laquelle et d'où l'on vient. */
// @expose poserAtterrissage

let atterri = null;       // { sel, observateur }

function carteAtterrie() { return atterri ? $(atterri.sel) : null; }

function reappliquer() {
  const c = carteAtterrie();
  if (c && !c.classList.contains('landed')) c.classList.add('landed');
}

function effacerAtterrissage() {
  if (!atterri) return;
  const c = carteAtterrie();
  if (c) c.classList.remove('landed');
  atterri.observateur.disconnect();
  atterri = null;
  const b = $('#taskLanded');
  if (b) { b.hidden = true; b.innerHTML = ''; }
}

/* `depuis` : { mr: '!12', branch, project } quand on vient d'une merge request ; `revelee` quand
   la liste a dû lever un filtre (sessions rangées, auteur, spec) pour montrer la carte. */
function poserAtterrissage(carte, { id, depuis = null, revelee = false } = {}) {
  effacerAtterrissage();
  const liste = carte.closest('.list');
  if (!liste) return;
  const sel = `#${liste.id} [data-task="${id}"], #${liste.id} [data-local="${id}"], #${liste.id} [data-ask="${id}"]`;
  const observateur = new MutationObserver(reappliquer);
  observateur.observe(liste, { childList: true });
  atterri = { sel, observateur };
  carte.classList.add('landed');
  const b = $('#taskLanded');
  if (!b) return;
  b.innerHTML = `<span class="task-landed-text">${svgIco('bot')} <strong>${esc(tr('task.landed', { id }))}</strong>
      ${depuis && depuis.mr ? `<span class="muted">· ${esc(tr('task.landed.from', { mr: depuis.mr, project: depuis.project || '', branch: depuis.branch || '' }))}</span>` : ''}
      ${revelee ? `<span class="muted">· ${esc(tr('task.landed.revealed'))}</span>` : ''}</span>
    <button type="button" class="btn btn-sm" data-landed-show>${esc(tr('task.landed.show'))}</button>
    <button type="button" class="btn btn-icon btn-sm" data-landed-close title="${esc(tr('task.landed.close'))}" aria-label="${esc(tr('task.landed.close'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>`;
  b.hidden = false;
}

/* Un clic hors de la carte et du bandeau lève le marquage : l'utilisateur a repris la main.
   Les `click()` du routage ne sont pas des gestes (`isTrusted`). */
document.addEventListener('pointerdown', (e) => {
  if (!atterri || !e.isTrusted) return;
  const c = carteAtterrie();
  if ((c && c.contains(e.target)) || e.target.closest('#taskLanded')) return;
  effacerAtterrissage();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && atterri) effacerAtterrissage(); });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-landed-close]')) { effacerAtterrissage(); return; }
  if (e.target.closest('[data-landed-show]')) {
    const c = carteAtterrie();
    if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});
