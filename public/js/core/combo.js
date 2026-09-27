'use strict';
/* Sélecteur de dépôt réutilisable (recherche à la frappe), le clavier d'un combo, le combo générique, `filtrerLignes` (masque sans décocher). */
/* ---- Sélecteur de dépôt réutilisable (recherche à la frappe) ----
   Un <select> natif devient inutilisable dès quelques dizaines de dépôts : ce
   combo filtre à la frappe. Il expose un input caché (la valeur réellement
   retenue) et déclenche un vrai événement 'change' dessus à la sélection, pour
   que le code appelant réagisse comme à un <select>.
   Le modale de session a son propre équivalent (wireRepoPickers), déjà éprouvé ;
   ce helper sert aux listes de l'onglet Git. */
function repoComboHtml(currentId, { idClass = '', idAttr = '', defaultFirst = true } = {}) {
  // Comme le <select> natif qu'il remplace : à défaut de sélection, le 1er dépôt
  // (sauf pour l'explorateur, où on ne veut rien analyser tant qu'on n'a pas choisi).
  const cur = repoOptions.find((r) => r.id === Number(currentId)) || (defaultFirst ? depotParDefaut() : null) || null;
  const dis = repoOptions.length ? '' : 'disabled';
  const ph = repoOptions.length ? tr('task.ph.search-repo') : tr('task.ph.no-repo');
  return `<div class="combo repo-combo">
    <input class="rc-search" data-repo-combo autocomplete="off" value="${esc(cur ? cur.project : '')}" title="${esc(cur ? cur.project : '')}" placeholder="${ph}" ${dis} />
    <input type="hidden" class="rc-id ${idClass}"${idAttr ? ` id="${idAttr}"` : ''} value="${cur ? cur.id : ''}" />
    <div class="combo-options" hidden></div>
  </div>`;
}
/* LE CLAVIER D'UN COMBO — une seule fois pour les quatre.
 *
 * L'outil compte quatre listes déroulantes à recherche (dépôts des réglages, dépôts d'une
 * ligne de session, branches, et le combo générique) : quatre copies du même comportement, qui
 * n'écoutaient que la souris. Choisir une branche parmi trois cents obligeait donc à lâcher le
 * clavier au milieu d'une saisie — alors qu'on venait de taper pour filtrer.
 *
 * Mêmes touches que le menu « / » des demandes, pour qu'un seul geste s'apprenne : flèches pour
 * désigner, Entrée pour prendre, Échap pour renoncer. Deux règles portent le reste :
 *   — Échap ferme LE MENU et rien d'autre (`stopPropagation`), sinon la modale qui l'entoure se
 *     referme avec lui en emportant ce qui était écrit ;
 *   — sans option désignée, Entrée prend la SEULE qui reste : on a filtré jusqu'à elle, la
 *     désigner une deuxième fois n'apprend rien. À plusieurs, on ne devine pas.
 */
function clavierCombo(input, box, { ouvrir, options, choisir, renoncer }) {
  /* ROUVRIR AU CLIC. La liste s'ouvre sur le FOCUS — donc une seule fois : refermée d'un Échap
     ou d'un choix, un second clic sur le champ ne faisait plus rien, puisque le focus y était
     déjà. On rouvre donc au clic quand elle est fermée, en vidant l'affichage comme le fait le
     focus : sinon le libellé courant filtrerait la liste à lui seul. */
  input.addEventListener('click', () => {
    if (!box.hidden || input.disabled) return;
    input.value = '';
    ouvrir();
  });
  const bouger = (pas) => {
    const opts = options();
    if (!opts.length) return;
    const i = opts.findIndex((o) => o.classList.contains('active'));
    const j = ((i < 0 ? (pas > 0 ? -1 : 0) : i) + pas + opts.length) % opts.length;
    opts.forEach((o) => o.classList.remove('active'));
    opts[j].classList.add('active');
    opts[j].scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('keydown', (e) => {
    // Menu fermé : la flèche bas l'ouvre — c'est le geste attendu devant une liste.
    if (box.hidden) { if (e.key === 'ArrowDown') { e.preventDefault(); ouvrir(); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); bouger(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bouger(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const opts = options();
      choisir(opts.find((o) => o.classList.contains('active')) || (opts.length === 1 ? opts[0] : null));
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renoncer(); }
  });
}

function wireRepoCombos(root) {
  $$('[data-repo-combo]', root || document).forEach((input) => {
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    const combo = input.closest('.repo-combo');
    const hidden = combo.querySelector('.rc-id');
    const box = combo.querySelector('.combo-options');
    const labelOf = (id) => { const r = repoOptions.find((x) => x.id === Number(id)); return r ? r.project : ''; };
    const open = () => {
      const q = input.value.trim().toLowerCase();
      const list = repoOptions.filter((r) => r.project.toLowerCase().includes(q)).slice(0, 200);
      box.innerHTML = list.map((r) => `<div class="combo-opt" data-r="${r.id}">${esc(r.project)}${marqueDemo(r)}</div>`).join('')
        || `<div class="combo-opt muted">${tr('task.combo.no-repo')}</div>`;
      box.hidden = false;
    };
    // Au focus on vide l'affichage : sinon le nom courant filtrerait la liste à
    // ce seul dépôt. Le blur le rétablit depuis `hidden` : rien n'est perdu.
    input.addEventListener('focus', () => { input.value = ''; open(); });
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement === input) return;   // le champ a été rouvert entre-temps
      box.hidden = true; input.value = labelOf(hidden.value); input.title = input.value; input.scrollLeft = input.scrollWidth;
    }, 150));
    const choisir = (o) => {
      if (!o) return;
      const changed = hidden.value !== o.dataset.r;
      hidden.value = o.dataset.r;
      input.value = labelOf(o.dataset.r);
      input.title = input.value; input.scrollLeft = input.scrollWidth; // nom complet au survol, fin visible
      box.hidden = true;
      if (changed) hidden.dispatchEvent(new Event('change', { bubbles: true }));
    };
    box.addEventListener('mousedown', (e) => choisir(e.target.closest('.combo-opt[data-r]')));
    clavierCombo(input, box, {
      ouvrir: open,
      options: () => $$('.combo-opt[data-r]', box),
      choisir,
      renoncer: () => { box.hidden = true; input.value = labelOf(hidden.value); input.blur(); },
    });
  });
}

/* ---- Combo GÉNÉRIQUE (liste déroulante avec recherche) ----
   Même comportement que le combo de dépôts ci-dessus, mais les options sont fournies
   par une FONCTION : elles peuvent dépendre d'un autre champ de la même ligne (les
   branches d'un projet) et être chargées à l'ouverture.
   Le libellé affiché est mémorisé sur l'input caché (`data-label`) : sans lui, un
   combo dont les options ne sont pas encore chargées afficherait un champ vide alors
   qu'une valeur est bel et bien retenue. */
function comboHtml(cls, { value = '', label = '', ph = '', disabled = false, wrapClass = '' } = {}) {
  return `<div class="combo ${wrapClass}">
    <input class="cb-search" data-combo="${cls}" autocomplete="off" value="${esc(label)}" title="${esc(label)}" placeholder="${esc(ph)}" ${disabled ? 'disabled' : ''} />
    <input type="hidden" class="${cls}" value="${esc(String(value))}" data-label="${esc(label)}" />
    <div class="combo-options" hidden></div>
  </div>`;
}
/* `load(rowEl)` renvoie [{ value, label, hint }] et peut être asynchrone. La mise en
   cache est laissée à l'appelant : lui seul sait quand une liste devient périmée
   (après un checkout, la branche courante d'un projet a changé). */
/* Le menu d'un combo est posé en `position: fixed`, aux coordonnées du champ.

   En absolu, il appartient au flux d'un ancêtre : dès que celui-ci défile (la liste des dépôts
   d'un vérificateur, la colonne des rapports…), le menu est ROGNÉ par lui. Le contournement
   d'avant — rendre l'overflow visible le temps de l'ouverture — coûtait deux défauts pour un :
   le navigateur remet `scrollTop` à zéro quand un conteneur cesse de défiler, donc la liste
   sautait en haut et le champ filait sous le menu ; et le menu, n'étant plus rogné, s'affichait
   jusqu'à 186 px SOUS le bloc, détaché de son champ.

   En fixed, plus d'ancêtre qui rogne, et le menu s'ouvre au-dessus du champ quand il n'y a pas
   la place en dessous — la fin d'une liste est justement là où on manque de place. */
function placerMenu(input, box) {
  const r = input.getBoundingClientRect();
  const marge = 8;
  box.style.position = 'fixed';
  box.style.left = `${r.left}px`;
  box.style.width = `${r.width}px`;
  const dessous = window.innerHeight - r.bottom - marge;
  const dessus = r.top - marge;
  // On ne bascule au-dessus que si c'est franchement mieux : sinon le menu sautillerait
  // d'un côté à l'autre au fil du filtrage, pendant qu'on tape.
  const versLeHaut = dessous < 160 && dessus > dessous;
  box.style.maxHeight = `${Math.max(120, Math.min(240, versLeHaut ? dessus : dessous))}px`;
  if (versLeHaut) { box.style.top = 'auto'; box.style.bottom = `${window.innerHeight - r.top + 2}px`; }
  else { box.style.bottom = 'auto'; box.style.top = `${r.bottom + 2}px`; }
}

function wireCombo(root, cls, load) {
  $$(`[data-combo="${cls}"]`, root || document).forEach((input) => {
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    const combo = input.closest('.combo');
    const hidden = combo.querySelector(`.${cls}`);
    const box = combo.querySelector('.combo-options');
    const restore = () => { input.value = hidden.dataset.label || ''; input.title = input.value; input.scrollLeft = input.scrollWidth; };
    /* Le menu ne fait plus partie du flux : il faut le suivre à la main quand ce qui l'entoure
       bouge. En capture, pour attraper AUSSI le défilement d'un conteneur interne, qui ne
       remonte pas jusqu'à `window`. */
    const suivre = () => { if (!box.hidden) placerMenu(input, box); };
    const ecouter = (on) => {
      const fn = on ? 'addEventListener' : 'removeEventListener';
      window[fn]('scroll', suivre, true);
      window[fn]('resize', suivre);
    };
    const open = async () => {
      box.innerHTML = `<div class="combo-opt muted">${esc(tr('ui.combo.loading'))}</div>`;
      box.hidden = false;
      placerMenu(input, box);
      ecouter(true);
      let opts;
      try { opts = await load(combo.closest('[data-row]')); }
      catch (e) { box.innerHTML = `<div class="combo-opt muted">${esc(explainError(e.message))}</div>`; return; }
      const q = input.value.trim().toLowerCase();
      const list = opts.filter((o) => String(o.label).toLowerCase().includes(q)).slice(0, 300);
      box.innerHTML = list.map((o) => `<div class="combo-opt" data-v="${esc(String(o.value))}" data-l="${esc(String(o.label))}">${esc(String(o.label))}${o.hint ? ` <span class="muted">${esc(o.hint)}</span>` : ''}</div>`).join('')
        || `<div class="combo-opt muted">${esc(tr('ui.combo.empty'))}</div>`;
      // Le contenu vient de changer de hauteur : ce qui tenait en dessous n'y tient plus forcément.
      placerMenu(input, box);
    };
    const fermer = () => { box.hidden = true; ecouter(false); };
    // Au focus on vide l'affichage : sinon le libellé courant servirait lui-même de
    // filtre et la liste se réduirait à cette seule option. Le blur le rétablit
    // depuis `data-label`, donc une saisie libre ne vaut jamais sélection.
    input.addEventListener('focus', () => { input.value = ''; open(); });
    input.addEventListener('input', open);
    /* Le délai laisse au clic sur une option le temps d'arriver. S'il a RENDU le focus au champ
       entre-temps, on ne ferme pas : le menu qu'on vient de rouvrir disparaîtrait tout seul. */
    input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement === input) return;
      fermer(); restore();
    }, 150));
    // Choisir une option — par le clic ou par Entrée : un seul chemin, donc un seul comportement.
    const choisir = (o) => {
      if (!o) return;
      const changed = hidden.value !== o.dataset.v;
      hidden.value = o.dataset.v;
      hidden.dataset.label = o.dataset.l;
      restore();
      fermer();
      // Un input caché n'émet pas 'change' tout seul : on le déclenche pour que les
      // champs qui en dépendent (branches d'un projet) se remettent à zéro.
      if (changed) hidden.dispatchEvent(new Event('change', { bubbles: true }));
    };
    box.addEventListener('mousedown', (e) => choisir(e.target.closest('.combo-opt[data-v]')));
    clavierCombo(input, box, {
      ouvrir: open,
      options: () => $$('.combo-opt[data-v]', box),
      choisir,
      renoncer: () => { fermer(); restore(); input.blur(); },
    });
  });
}

/* Un filtre qui MASQUE les lignes sans jamais décocher : c'est la règle du projet pour toute
   liste à cocher. Filtrer en retirant du DOM ferait perdre les cases cochées hors filtre —
   et l'utilisateur ne saurait pas qu'il vient d'annuler son propre choix. */
function filtrerLignes(input, liste, attr = 'data-cherche') {
  if (!input || !liste) return;
  const q = (input.value || '').trim().toLowerCase();
  let visibles = 0;
  $$(`[${attr}]`, liste).forEach((el) => {
    const ok = !q || el.getAttribute(attr).includes(q);
    el.hidden = !ok;
    if (ok) visibles += 1;
  });
  const vide = liste.querySelector('[data-no-match]');
  if (vide) vide.hidden = visibles > 0;
}

