'use strict';
/* LA PRÉSENCE — ce qui nourrit la bannière « tu n'as pas ouvert Mergerie depuis N jours ».
 *
 * Mesurée sur un GESTE, pas sur le poll de statut : un poste de bureau resté allumé avec
 * l'onglet ouvert interroge le serveur toutes les cinq secondes pendant tout un congé, et la
 * bannière ne s'afficherait jamais — précisément là où on en a besoin. On n'envoie donc
 * `POST /api/presence` qu'après un clavier ou un pointeur réel, au plus une fois par minute,
 * et l'onglet visible. Le serveur borne encore de son côté. */
(() => {
  let geste = false;
  let dernierEnvoi = 0;
  const noter = () => { geste = true; };
  document.addEventListener('keydown', noter, { passive: true });
  document.addEventListener('pointerdown', noter, { passive: true });
  const envoyer = () => {
    if (!geste || document.visibilityState !== 'visible') return;
    if (Date.now() - dernierEnvoi < 60000) return;
    geste = false;
    dernierEnvoi = Date.now();
    api('/presence', { method: 'POST' }).catch(() => { /* hors ligne : le prochain geste réessaiera */ });
  };
  // Le premier geste part tout de suite ; les suivants attendent la minute.
  document.addEventListener('keydown', envoyer, { passive: true });
  document.addEventListener('pointerdown', envoyer, { passive: true });
  setInterval(envoyer, 60000);
})();
