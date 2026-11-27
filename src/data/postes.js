'use strict';
/* LES POSTES DE L'ÉQUIPE (Réglages → Données partagées) : qui a commité en dernier dans le dépôt de données, et
 * quand. Un diagnostic de synchro — « les données de ce poste sont peut-être périmées » —, jamais une mesure de
 * la personne : une ligne par auteur git du dépôt, sa dernière synchro, « silencieux » au-delà de N jours
 * OUVRÉS (`config.team_quiet_days`). Lu dans le cache que la synchro tient (`datasync.fraicheurAuteurs`) :
 * aucun appel, aucune écriture. */
const datasync = require('./datasync');

const attache = () => datasync.estConfigure() || process.env.MERGERIE_DEMO === '1';

/* Les jours OUVRÉS écoulés depuis une date : le week-end ne compte pas — un poste muet du vendredi soir au
   lundi matin n'est pas silencieux. */
function joursOuvres(iso, maintenant) {
  const t0 = Date.parse(iso);
  if (!Number.isFinite(t0)) return null;
  let n = 0;
  const d = new Date(t0);
  d.setUTCHours(0, 0, 0, 0);
  const fin = new Date(maintenant); fin.setUTCHours(0, 0, 0, 0);
  while (d < fin) {
    d.setUTCDate(d.getUTCDate() + 1);
    const j = d.getUTCDay();
    if (j !== 0 && j !== 6) n += 1;
  }
  return n;
}

function postes({ maintenant = new Date(), silencieuxJours = 2 } = {}) {
  if (!attache()) return { attached: false, items: [] };
  const seuil = Number(silencieuxJours) >= 0 ? Number(silencieuxJours) : 2;
  const items = [...datasync.fraicheurAuteurs()].map(([name, last]) => {
    const ouvres = last ? joursOuvres(last, maintenant) : null;
    return { name, synced_at: last || null, quiet: ouvres == null ? false : ouvres > seuil };
  }).sort((a, b) => String(b.synced_at || '').localeCompare(String(a.synced_at || '')) || a.name.localeCompare(b.name));
  return { attached: true, items };
}

module.exports = { postes, joursOuvres };
