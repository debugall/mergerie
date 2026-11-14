'use strict';
/* L'ÉCRAN STATISTIQUES EN QUATRE SOUS-ONGLETS. Un test qui lit une carte ouvre d'abord le
   sous-onglet qui la porte, et attend que SON contenu soit là — jamais un délai : changer de
   sous-onglet remplace le panneau par un squelette de façon synchrone, puis une réponse du
   serveur le remplit. Les marqueurs sont ce que chaque sous-onglet rend TOUJOURS, données ou
   pas (le bandeau, le bouton d'export, les barres de notes, la carte des sessions). */
const MARQUEURS = {
  apercu: '#dashKpi .stat-tile',
  flux: '#statsExport',
  qualite: '#dashPanel .hbars',
  cout: '#dashPanel .dash-card',
};

async function ouvrirSousOnglet(page, sub) {
  await page.locator(`#dashboard [data-stats-sub="${sub}"]`).click();
  await page.waitForFunction(([s, m]) => {
    const b = document.querySelector('#dashboard [data-stats-sub].active');
    return Boolean(b) && b.dataset.statsSub === s && Boolean(document.querySelector(m));
  }, [sub, MARQUEURS[sub]]);
}

/* Par la barre latérale, puis le sous-onglet demandé. */
async function allerStats(page, sub = 'apercu') {
  await page.locator('nav button[data-tab="dashboard"]').click();
  await page.waitForSelector('#tab-dashboard.active #dashboard .dash-periode');
  await ouvrirSousOnglet(page, sub);
}

module.exports = { MARQUEURS, ouvrirSousOnglet, allerStats };
