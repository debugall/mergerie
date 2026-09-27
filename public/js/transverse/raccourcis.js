'use strict';
/* Raccourcis clavier : le libellé selon le clavier, `SHORTCUTS`, la feuille « ? », le gestionnaire global. */
/* Le raccourci affiché doit être CELUI DU CLAVIER qu'on a sous les doigts : « Ctrl K » sur
   un Mac enverrait chercher une touche qui ne fait rien ici. */
(function libellerRaccourciPalette() {
  const k = $('#paletteKbd');
  if (!k) return;
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  k.textContent = mac ? '⌘ K' : 'Ctrl K';
})();

/* Feuille de raccourcis PERSISTANTE. Un toast de 3,5 s disparaissait pendant qu'on le lisait,
   ce qui est exactement le contraire de ce qu'on attend d'une aide. */
const SHORTCUTS = [
  ['Ctrl/Cmd + K', 'shortcuts.palette'],
  [null, 'shortcuts.tabs'],   // plage calculée au rendu : autant que d'onglets dans la barre
  ['/', 'shortcuts.search'],
  ['j / k', 'shortcuts.jk'],
  ['Entrée', 'shortcuts.enter'],
  ['d', 'shortcuts.diff'],
  ['v', 'shortcuts.verify'],
  ['c', 'shortcuts.context'],
  ['m', 'shortcuts.done'],
  ['f', 'shortcuts.fix'],
  ['x', 'shortcuts.pick'],
  ['r', 'shortcuts.discover'],
  ['n', 'shortcuts.notes'],
  ['N', 'shortcuts.new-task'],
  ['o', 'shortcuts.palette-o'],
  ['l', 'shortcuts.logs'],
  ['?', 'shortcuts.help'],
  ['Échap', 'shortcuts.escape'],
  /* C12 — LES DEUX GESTES QUE PERSONNE NE DEVINE. `Ctrl+Entrée` envoie un champ de texte
     (commentaire, suivi) et `⇧-clic` sur une branche copie la commande de checkout : ils
     existaient sans être écrits nulle part, donc sans exister pour qui ne lit pas le
     CHANGELOG. Le panneau `?` est l'endroit où on les cherche. */
  ['Ctrl/Cmd + Entrée', 'shortcuts.ctrl-enter'],
  ['⇧ + clic', 'shortcuts.shift-click'],
  /* LES COMBOS AU CLAVIER : quatre listes déroulantes à recherche dans l'outil, et le geste
     n'était écrit nulle part — on cliquait, faute de savoir qu'on pouvait taper. */
  ['↓ ↑ · Entrée', 'shortcuts.combo'],
  ['n p · [ ] · f', 'shortcuts.viewer'],
];

function openShortcuts() {
  const m = $('#shortcutsModal'); if (!m) return;
  /* Ce que les chiffres ouvrent, c'est la barre VISIBLE — c'est elle que compte le gestionnaire
     de touches. Compter tous les boutons annonçait « 1 – 9, 0 » à qui n'en voyait que sept. */
  const nbOnglets = $$('nav button[data-tab]:not([hidden])').length;
  // La plage annoncée doit être la VRAIE : au-delà de neuf onglets, le DERNIER est sur « 0 ».
  const plage = nbOnglets > 9 ? '1 – 9, 0' : `1 – ${nbOnglets}`;
  $('#shortcutsList').innerHTML = SHORTCUTS
    .map(([k, key]) => `<div class="shortcut-row"><kbd>${esc(k || plage)}</kbd><span>${esc(tr(key))}</span></div>`).join('')
    + `<h4 class="shortcut-titre">${esc(tr('shortcuts.badges-title'))}</h4>`
    + PASTILLES.map(([onglet, key]) => `<div class="shortcut-row"><kbd>${esc(tr(onglet))}</kbd><span>${esc(tr(key))}</span></div>`).join('');
  m.hidden = false;
}
$('#footerHelp') && $('#footerHelp').addEventListener('click', openShortcuts);
$('#shortcutsClose') && $('#shortcutsClose').addEventListener('click', () => { $('#shortcutsModal').hidden = true; });
fermerAuFond('#shortcutsModal', () => { $('#shortcutsModal').hidden = true; }, { salissable: false });

/* ---------- Raccourcis clavier ----------
   Un seul écouteur, avec garde de saisie : on ne détourne jamais une frappe
   destinée à un champ de texte. Les vues plein écran gardent leurs propres touches. */
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
/* Ctrl/Cmd+K passe AVANT la garde de saisie : c'est le seul raccourci qui doit fonctionner
   même le curseur dans un champ — sinon il ne marcherait pas là où on en a le plus besoin. */
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('#paletteModal').hidden) openPalette(); else closePalette();
  }
});
document.addEventListener('keydown', (e) => {
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  /* Une touche déjà traitée ailleurs (Entrée sur un chip de branche copie son nom) ne repart pas
     en raccourci global : `stopPropagation` n'arrête pas un autre écouteur du même `document`,
     et Entrée lançait en prime l'action de la carte visée — la review d'une autre MR. */
  if (e.defaultPrevented) return;
  // pas de raccourci global quand une vue plein écran ou une modale est ouverte
  if (!$('#splitView').hidden) return;
  if ($$('.modal').some((m) => !m.hidden)) return;
  /* Les chiffres suivent la BARRE, lue dans le DOM — jamais une liste recopiée à côté.
     Une copie se désynchronise au premier réordonnancement, et le décalage est silencieux :
     « 3 » ouvrirait un autre onglet que le troisième, sans que rien ne signale l'erreur. */
  /* `0` prend le DERNIER onglet, faute de touche « 10 » — la convention des navigateurs.
     Le dixième tant qu'il y en a dix ; au-delà, c'est bien le dernier qu'il faut viser :
     sinon ajouter un onglet retire en silence son raccourci à celui qui ferme la barre
     (Réglages), et le onzième onglet en prendrait un qui ne lui était pas destiné. */
  /* L'ONGLET LIENS A SON PROPRE CLAVIER dès qu'une case a le focus : `j`/`k` les lignes,
     `←`/`→` les cases, `Entrée` ouvre, `e` modifie, `c` copie. Il passe avant les touches
     globales, qui parlent des cartes de merge requests et n'ont rien à faire ici. */
  if ($('#tab-links') && $('#tab-links').classList.contains('active') && naviguerGrilleLiens(e)) return;
  if (/^[0-9]$/.test(e.key)) {
    // …et seulement ce qui est VISIBLE : un menu masqué n'a pas de numéro, sinon « 3 » ouvrirait
    // un onglet absent de la barre.
    const onglets = $$('nav button[data-tab]:not([hidden])');
    const t = onglets[e.key === '0' ? onglets.length - 1 : +e.key - 1];
    if (t) { e.preventDefault(); t.click(); }
    return;
  }
  switch (e.key) {
    /* C12 — « / » CHERCHE LÀ OÙ ON EST. Il éjectait vers Reviews : appuyer sur « / » dans
       Jenkins pour filtrer deux cents jobs changeait d'onglet. Chaque onglet a sa recherche ;
       on prend celle qui est visible, et on ne retombe sur Reviews que faute de mieux. */
    case '/': {
      e.preventDefault();
      /* …et « là où on est » couvre TOUS les onglets qui ont une recherche : Agents, Git
         (explorateur et « Trouver une ref »), Docker (journaux) et Réglages (dépôts) en
         étaient absents, si bien que « / » y faisait exactement ce que le commentaire
         ci-dessus dit avoir corrigé pour Jenkins — changer d'onglet. */
      const champ = $$(`#tab-review .search, #tab-task .search, #jiraSearch, #jiraWatchSearch,
        #jenkinsSearch, #pageSearch, #linkSearch, #dactSearch, #todoQuickAdd,
        #agentFilter, #repoSearch, #dlogSearch, .git-ex-filter, #findRefName`)
        .find((el) => el.offsetParent !== null);
      if (champ) { champ.focus(); if (champ.select) champ.select(); break; }
      const s = $('#searchReview');
      if (s) { $('nav button[data-tab="review"]').click(); s.focus(); }
      break;
    }
    /* C12 — `N` : une nouvelle session sans passer par l'onglet. Majuscule, parce que `n`
       est déjà la capture rapide et que les deux gestes ne se confondent pas. */
    case 'N': e.preventDefault(); navTab('task'); openTaskModal('code'); break;
    case 'r': if ($('#tab-review').classList.contains('active')) { e.preventDefault(); $('#btnDiscover').click(); } break;
    case 'l': {
      e.preventDefault();
      const panel = $('#logPanel');
      // Panneau masqué (par « masquer » ou repli auto) et un job existe → le rouvrir ; sinon
      // simple bascule déplier/replier du corps du journal.
      if (panel && panel.hidden && logJobId) showLogPanel();
      else { const t = $('#logToggle'); if (t) t.click(); }
      break;
    }
    case '?': e.preventDefault(); openShortcuts(); break;
    /* Capture rapide : la touche la plus utile de l'onglet Notes est celle qui n'oblige pas
       à y aller. On note ce qui vient de passer, on trie plus tard. */
    case 'n': e.preventDefault(); openCapture(); break;
    /* `o` comme « ouvrir » : la palette est le chemin le plus court vers n'importe quoi, et
       elle mérite une touche seule en plus de Ctrl/Cmd + K. */
    case 'o': e.preventDefault(); openPalette(); break;
    /* Navigation au clavier dans la liste courante. Ce qu'elle procure n'est pas une
       surprise mais un RYTHME : traiter vingt MR au clavier, c'est de la cadence ; à la
       souris, c'est de la visée. Aucune logique dupliquée — on clique les boutons rendus. */
    /* C12 — `f` comme « faire corriger » : le geste qui suit la lecture d'un rapport, au
       même titre que `v` vérifier ou `c` contexte. On clique le bouton RENDU. */
    /* …et sur une carte de SESSION, `f` ouvre le suivi : c'est le geste qui suit la lecture
       d'un retour d'IA, exactement comme « faire corriger » suit la lecture d'un rapport. Une
       seule touche, deux écrans, le même sens — « la suite, c'est moi qui la demande ». */
    case 'f': {
      const b = boutonDeCarte('[data-dev]') || boutonDeCarte('[data-tfollow]')
        || boutonDeCarte('[data-lfollow]') || boutonDeCarte('[data-qfollow]');
      if (b) { e.preventDefault(); b.click(); }
      break;
    }
    case 'j': e.preventDefault(); bougerFocusCarte(1); break;
    case 'k': e.preventDefault(); bougerFocusCarte(-1); break;
    /* L'action principale de la carte visée — et, pour un rapport, qui n'a pas de bouton
       principal, l'ouvrir : c'est ce que fait un clic sur la carte. */
    case 'Enter': { const c = carteFocus(); if (c) { e.preventDefault(); const b = c.querySelector('.btn-primary'); if (b) b.click(); else if (c.closest('#reportList')) c.click(); } break; }
    case 'd': { const c = carteFocus(); if (c) { e.preventDefault(); const b = c.querySelector('[data-diff]'); if (b) b.click(); } break; }
    /* LE RESTE DU RAIL AU CLAVIER. `j/k/Entrée/d` existaient ; traiter vingt merge requests
       demandait quand même la souris pour vérifier, ouvrir le contexte, classer ou cocher.
       Les actions vivent dans le menu ⋯ : on clique le BOUTON RENDU, jamais une route en
       double — ce qui est grisé le reste, et ce qui n'existe pas ne fait rien. */
    case 'v': { const b = boutonDeCarte('[data-verify]'); if (b) { e.preventDefault(); b.click(); } break; }
    case 'c': { const b = boutonDeCarte('[data-ticket]'); if (b) { e.preventDefault(); b.click(); } break; }
    case 'm': { const b = boutonDeCarte('[data-done]'); if (b) { e.preventDefault(); b.click(); } break; }
    case 'x': { const b = boutonDeCarte('.mr-pick'); if (b) { e.preventDefault(); b.click(); } break; }
    case 'Escape': { const c = carteFocus(); if (c) c.classList.remove('focused'); carteVisee = null; break; }
    default: break;
  }
});

