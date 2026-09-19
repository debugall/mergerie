'use strict';
/* D’où vient cette requête ? Host, Sec-Fetch-Site, le jeton d’accès quand le poste est exposé, et l’origine des requêtes qui écrivent.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const express = require('express');
const garde = require('../../core/garde');
const i18n = require('../../core/i18n');
const { t } = i18n;
const path = require('path');

/* ============ D'OÙ VIENT CETTE REQUÊTE ? ============
   Mergerie n'écoute que sur la boucle locale, mais ça ne protège de rien ici : c'est TON
   navigateur qui émet, et n'importe quelle page ouverte dans un autre onglet peut lui faire
   poster chez nous. Un simple `<form method="POST" action="http://127.0.0.1:4319/api/…">`
   part sans préflight (formulaire = requête « simple ») et, sur les 130 routes mutantes, les
   45 qui ne lisent pas leur corps s'exécutent telles quelles : effacer tous les rapports,
   publier tes commentaires en attente sur une vraie merge request avec ton jeton, lancer un
   agent sur tes dossiers. Le code étant publié, la liste des routes n'est un secret pour
   personne.

   La règle : une requête qui ÉCRIT et qui annonce une origine étrangère est refusée. Les
   requêtes de l'application portent l'origine de l'application ; un formulaire tiers porte la
   sienne, et se fait renvoyer. On n'exige PAS que l'en-tête soit présent : `curl`, un script
   maison ou l'onglet « Commandes » n'en envoient pas, et refuser les requêtes sans origine
   casserait des usages légitimes sans rien empêcher — un navigateur, lui, en envoie toujours
   un sur une requête cross-site.

   Les lectures passent : elles ne changent rien, et la réponse n'est de toute façon pas
   lisible par la page tierce (pas de CORS ici). */
/* LA PORTE, AVANT TOUT LE RESTE (voir `src/garde.js`).
 *
 * 1. `Host` : sans elle, une page qui re-résout son nom vers 127.0.0.1 devient « même origine »
 *    et lit toute l'API. 421 et non 403 : c'est le code de « tu t'adresses au mauvais serveur »,
 *    et le message nomme la variable qui corrige un reverse-proxy légitime.
 * 2. `Sec-Fetch-Site` sur `/api/` : une page d'un autre site n'a rien à y lire.
 * 3. Le jeton d'accès, quand le poste est ouvert au réseau. */
const EXPOSE = !garde.estBoucle(process.env.HOST || '127.0.0.1');
const JETON_ACCES = String(process.env.MERGERIE_ACCESS_TOKEN || '');
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (garde.hoteAutorise(req.headers.host)) return next();
  res.status(421).json({ error: i18n.t('err.hote-inconnu', { host: garde.nomHote(req.headers.host) }) });
});
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || !garde.siteEtranger(req)) return next();
  res.status(403).json({ error: i18n.t('err.origine-etrangere') });
});
if (EXPOSE) {
  /* La page d'accès et son envoi sont les SEULES choses servies sans jeton. Le formulaire arrive
     en urlencoded : on le lit à la main plutôt que d'ouvrir un analyseur de plus à tout le
     serveur. */
  app.get('/acces', (req, res) => res.type('html').send(garde.pageAcces()));
  app.post('/acces', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    if (!garde.memeJeton((req.body || {}).jeton, JETON_ACCES)) {
      return res.status(401).type('html').send(garde.pageAcces({ erreur: 'Jeton incorrect.' }));
    }
    /* HttpOnly : aucun script ne le lit. SameSite=Strict : aucun autre site ne le fait voyager. */
    res.setHeader('Set-Cookie', `${garde.COOKIE}=${encodeURIComponent(JETON_ACCES)}; HttpOnly; SameSite=Strict; Path=/`);
    return res.redirect(303, '/');
  });
  app.use((req, res, next) => {
    if (garde.memeJeton(garde.jetonPresente(req), JETON_ACCES)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: i18n.t('err.acces-requis') });
    return res.redirect(303, '/acces');
  });
}
const MUTANTES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function memeOrigine(req) {
  const brut = req.headers.origin;
  if (!brut) return true;                       // pas de navigateur derrière : rien à trancher
  let hote;
  try { hote = new URL(brut).host; } catch { return false; }   // origine illisible = refus
  return hote === req.headers.host;
}
app.use((req, res, next) => {
  if (!MUTANTES.has(req.method) || memeOrigine(req)) return next();
  res.status(403).json({ error: i18n.t('err.origine-etrangere') });
});

module.exports = { EXPOSE, JETON_ACCES };
