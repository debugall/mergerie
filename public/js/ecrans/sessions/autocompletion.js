'use strict';
/* Autocomplétion « / » et « @ » dans une demande. */
/* ---------- Autocomplétion « / » et « @ » dans une demande ----------
   Retrouver le nom exact d'un skill se faisait au `ls` dans ~/.claude/skills/. Le menu
   réutilise `.combo-options` et `placerMenu` : même apparence, même comportement au clavier
   que les combos du reste de l'outil. Rien ne s'insère sans une sélection EXPLICITE — un
   menu qui complète tout seul écrirait dans la demande de qui tapait juste un slash. */
let acMenu = null;
let acCible = null;
let acDebut = -1;
let acIndex = 0;
let acOptions = [];

function acFermer() {
  if (acMenu) acMenu.hidden = true;
  acCible = null; acDebut = -1; acOptions = []; acIndex = 0;
}

function acBoite() {
  if (!acMenu) {
    acMenu = document.createElement('div');
    acMenu.className = 'combo-options ac-menu';
    acMenu.hidden = true;
    document.body.appendChild(acMenu);
    acMenu.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-v]');
      if (!o) return;
      e.preventDefault();
      acInserer(o.dataset.v);
    });
  }
  return acMenu;
}

function acRendre() {
  const box = acBoite();
  box.innerHTML = acOptions.map((o, i) => `<div class="combo-opt${i === acIndex ? ' is-sel' : ''}" data-v="${esc(o.insert)}">${esc(o.label)}${o.hint ? ` <span class="muted">${esc(o.hint)}</span>` : ''}</div>`).join('');
  box.hidden = !acOptions.length;
  if (acOptions.length && acCible) placerMenu(acCible, box);
}

function acInserer(texte) {
  if (!acCible || acDebut < 0) return acFermer();
  const el = acCible;
  const avant = el.value.slice(0, acDebut);
  const apres = el.value.slice(el.selectionStart);
  el.value = avant + texte + apres;
  const pos = (avant + texte).length;
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  acFermer();
  el.focus();
}

/* Le jeton en cours de frappe : « / » ou « @ » en début de ligne ou après une espace, suivi
   de ce qui a été tapé depuis. Ailleurs (au milieu d'un chemin, d'une adresse), il n'y a rien
   à compléter — et un menu qui s'ouvrirait sur `src/app.js` serait insupportable. */
function acJeton(el) {
  const pos = el.selectionStart;
  const avant = el.value.slice(0, pos);
  const m = avant.match(/(^|[\s(])([/@])([\w.-]*)$/);
  if (!m) return null;
  return { signe: m[2], debut: pos - m[3].length - 1, q: m[3].toLowerCase() };
}

function acMaj(el) {
  const j = acJeton(el);
  if (!j) return acFermer();
  const items = skillsCache.items || [];
  const source = j.signe === '/'
    // `user-invocable: false` interdit le `/nom` : le proposer serait proposer une commande
    // que le CLI refusera.
    ? items.filter((x) => x.kind === 'skill' && x.userInvocable)
    : items.filter((x) => x.kind === 'agent');
  acOptions = source
    .filter((x) => x.name.toLowerCase().includes(j.q))
    .slice(0, 20)
    .map((x) => ({
      label: (j.signe === '/' ? '/' : '@') + x.name,
      hint: x.source === 'user' ? tr('agents.skills.source-user') : (x.project || ''),
      insert: j.signe === '/' ? `/${x.name} ` : `@"${x.name} (agent)" `,
    }));
  if (!acOptions.length) return acFermer();
  acCible = el; acDebut = j.debut; acIndex = 0;
  acRendre();
}

/* CE QUI DÉCIDE EST LE MENU À L'ÉCRAN, PAS LE FOCUS.
   Échap était intercepté à la condition que la frappe vienne du champ qui avait ouvert le
   menu. Il suffisait alors que le focus glisse un instant — un rendu de liste, un
   repositionnement — pour que le menu reste affiché et qu'Échap tombe sur le gestionnaire
   global : la fenêtre se fermait, et la demande à moitié écrite partait avec elle. Tant qu'un
   menu est SOUS LES YEUX, Échap le ferme, lui et rien d'autre. Les flèches et Entrée, qui
   écrivent dans le champ, exigent en revanche que la frappe en vienne bien. */
function acTouche(e) {
  if (!acMenu || acMenu.hidden || !acOptions.length) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); acFermer(); return; }
  if (e.target !== acCible) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acOptions.length; acRendre(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex - 1 + acOptions.length) % acOptions.length; acRendre(); }
  else if (e.key === 'Enter') { e.preventDefault(); acInserer(acOptions[acIndex].insert); }
}

document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('#taskPrompt, .followup-text')) acMaj(e.target);
});
document.addEventListener('keydown', acTouche, true);
/* Le délai laisse au clic sur une option le temps d'arriver — et s'il a RENDU le focus au
   champ entre-temps, on ne ferme pas : le menu qu'on vient de rouvrir disparaîtrait tout seul.
   Même règle que les combos de l'outil, pour la même raison. */
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!el.matches || !el.matches('#taskPrompt, .followup-text')) return;
  setTimeout(() => { if (document.activeElement !== el) acFermer(); }, 150);
});

