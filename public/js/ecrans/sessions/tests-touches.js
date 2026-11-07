'use strict';
/* La pastille « tests touchés » de la ligne de projet d'une session de codage (`targetLine`, reponse.js). */
/* LES TESTS TOUCHÉS PAR LA BRANCHE, dès le commit : « 0 test modifié » (accentué) ou « 3 tests
   modifiés » (discret), à côté du fil d'étape — avant que la merge request n'existe, quand un
   suivi « ajoute les tests » coûte le moins. Le serveur ne rend rien sans commit, sans diff, ou
   réglage décoché : alors rien, jamais un faux « 0 test ». Des fichiers, pas une couverture. */
function badgeTestsCible(tg) {
  const c = tg && tg.tests_touched;
  if (!c || !['committed', 'pushed'].includes(tg.status) || (c.code === 0 && c.tests === 0)) return '';
  const alerte = c.tests === 0;
  return `<span class="tag tests${alerte ? ' alert' : ''}" title="${esc(tr('task.tests.title', { code: c.code, tests: c.tests, neutral: c.neutral }))}">${esc(c.tests ? tr('task.tests.touched', { n: c.tests, count: c.tests }) : tr('task.tests.none'))}</span>`;
}
