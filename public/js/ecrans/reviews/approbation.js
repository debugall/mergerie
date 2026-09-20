'use strict';
/* Approuver sur ce poste. */
// @expose blocApprobation
/* ---------- Approuver sur ce poste ----------
   CE QUI EXÉCUTE DU CODE, arrivé changé par la synchro, attend un geste ici. Le bloc montre CE
   qui a changé — les commandes d'avant et celles d'aujourd'hui —, pas seulement QUE quelque chose
   a changé : approuver sans voir serait un clic sans valeur. */
function blocApprobation({ texte, avant, apres, bouton }) {
  const ligne = (c, cls) => `<div class="approval-line ${cls}"><code>${esc(c)}</code></div>`;
  const diff = avant
    ? [...avant.filter((c) => !apres.includes(c)).map((c) => ligne(`− ${c}`, 'gone')),
      ...apres.map((c) => ligne(`${avant.includes(c) ? '  ' : '+ '}${c}`, avant.includes(c) ? 'same' : 'added'))].join('')
    : apres.map((c) => ligne(c, 'added')).join('');
  return `<div class="approval-box" role="note">
    <p class="approval-text">${svgIco('alert')} ${esc(texte)}</p>
    ${diff ? `<div class="approval-diff">${diff}</div>` : ''}
    <div class="approval-actions">${bouton}</div>
  </div>`;
}

