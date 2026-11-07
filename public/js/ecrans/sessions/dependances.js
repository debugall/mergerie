'use strict';
/* LES DÉPENDANCES QUE LA BRANCHE AJOUTE OU CHANGE, sur la ligne de projet d'une session de codage,
   dès le commit : « 2 dépendances ajoutées » (accentué) ou « 1 dépendance changée » (discret), après
   les tests modifiés — c'est là qu'un suivi « enlève left-pad, écris la fonction » coûte le moins.
   Le serveur ne rend rien sans commit, sans diff, hors dépôt ou réglage décoché. */
function badgeDepsCible(tg) {
  const c = tg && tg.deps;
  if (!c || !['committed', 'pushed'].includes(tg.status) || c.added + c.changed + c.removed === 0) return '';
  const texte = c.added ? tr('task.deps.added', { n: c.added, count: c.added }) : tr('task.deps.changed', { n: c.changed + c.removed, count: c.changed + c.removed });
  return `<span class="tag deps${c.added ? ' alert' : ''}" title="${esc(tr('task.deps.title', { added: c.added, changed: c.changed, removed: c.removed, major: c.major }))}">${esc(texte)}${c.major ? ` · ${esc(tr('mr.deps.major', { n: c.major, count: c.major }))}` : ''}</span>`;
}
