'use strict';
/* Les deux adresses que le plugin accepte, et RIEN d'autre :
   — le lien Teams : https, jamais http (un lien de canal porte l'identifiant du locataire) ;
   — l'adresse CDP : la machine locale seulement. Un port de débogage est une porte ouverte sur
     TOUT le navigateur (cookies, sessions) : ni un nom de domaine, ni une autre machine. */
const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '[::1]']);

/** @returns {{ ok: boolean, url?: string, erreur?: string }} */
function lienTeams(valeur) {
  let u;
  try { u = new URL(String(valeur || '').trim()); } catch { return { ok: false, erreur: 'adresse invalide' }; }
  if (u.protocol !== 'https:') return { ok: false, erreur: 'https obligatoire' };
  if (u.username || u.password) return { ok: false, erreur: 'adresse avec identifiants refusée' };
  return { ok: true, url: u.toString() };
}

/** @returns {{ ok: boolean, url?: string, erreur?: string }} */
function urlCdp(valeur) {
  let u;
  try { u = new URL(String(valeur || '').trim()); } catch { return { ok: false, erreur: 'adresse invalide' }; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return { ok: false, erreur: 'http, https, ws ou wss attendu' };
  if (!HOTES_LOCAUX.has(u.hostname)) return { ok: false, erreur: 'localhost uniquement' };
  if (u.username || u.password) return { ok: false, erreur: 'adresse avec identifiants refusée' };
  return { ok: true, url: u.toString().replace(/\/$/, '') };
}

/** Ce qui empêche d'envoyer, pour l'écran : une liste de { champ, erreur } (vide = prêt). */
function problemes(reglages) {
  const r = reglages || {};
  const out = [];
  const lien = String(r.team_link || '').trim();
  if (!lien) out.push({ champ: 'team_link', erreur: 'manquant' });
  else { const v = lienTeams(lien); if (!v.ok) out.push({ champ: 'team_link', erreur: v.erreur }); }
  if (r.session_mode === 'cdp') {
    const c = String(r.cdp_url || '').trim();
    if (!c) out.push({ champ: 'cdp_url', erreur: 'manquant' });
    else { const v = urlCdp(c); if (!v.ok) out.push({ champ: 'cdp_url', erreur: v.erreur }); }
  }
  return out;
}

module.exports = { lienTeams, urlCdp, problemes, HOTES_LOCAUX };
