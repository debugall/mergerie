'use strict';
/* Le rafraîchissement automatique des MR : un seul timer, qui ne se superpose pas aux découvertes.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const configModule = require('../data/config');
const { getConfig, updateConfig } = configModule;
const { decouvrir } = require('./lib/decouverte');

// Rafraîchissement automatique des MR : (re)démarre le timer selon la config.
// 0 = désactivé. Un seul timer actif à la fois ; ne se superpose pas aux découvertes.
let autoRefreshTimer = null;
let autoRefreshBusy = false;
function restartAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const min = Number(getConfig().auto_refresh_minutes) || 0;
  if (min <= 0) { console.log('[auto-refresh] désactivé'); return; }
  autoRefreshTimer = setInterval(async () => {
    if (autoRefreshBusy) return; // évite le chevauchement si une découverte est déjà en cours
    autoRefreshBusy = true;
    try {
      const r = await decouvrir();
      console.log(`[auto-refresh] ${r.found} MR · ${r.created} nouvelles · ${r.updated} maj${r.errors && r.errors.length ? ` · ${r.errors.length} erreur(s)` : ''}${r.auto_verify && r.auto_verify.lancees ? ` · ${r.auto_verify.lancees} vérification(s) auto` : ''}`);
    } catch (e) {
      console.error(`[auto-refresh] échec : ${e.message}`);
    } finally { autoRefreshBusy = false; }
  }, min * 60 * 1000);
  console.log(`[auto-refresh] activé : toutes les ${min} min`);
}

function arreterAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } }

module.exports = { restartAutoRefresh, arreterAutoRefresh };
