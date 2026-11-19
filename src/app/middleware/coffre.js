'use strict';
/* LE COFFRE VERROUILLÉ FERME L'APPLICATION (Réglages → Sécurité). Tant que le mot de passe maître n'a
   pas été saisi, `GET /` sert la page de connexion au lieu de l'application, toute route `/api/` répond
   423 (`code: 'COFFRE_VERROUILLE'` : un onglet resté ouvert se recharge et tombe sur la page), et les
   deux formulaires de la page — déverrouiller, repartir sans jetons — sont les seules écritures admises.
   Monté APRÈS la garde d'origine et le jeton local (les formulaires exigent le cookie que `GET /` pose :
   un processus du poste ne peut pas essayer des mots de passe sans lui) et après la langue (la page
   parle celle de l'utilisateur). Les fichiers statiques passent : c'est le code de l'application,
   publié, et la page n'en a pas besoin. */
const { app } = require('../app');
const express = require('express');
const coffre = require('../../data/coffre');
const garde = require('../../core/garde');
const jetonlocal = require('../../core/jetonlocal');
const { t } = require('../../core/i18n');
const { EXPOSE } = require('./origine');
const { pageCoffre } = require('../lib/page-coffre');

const lireFormulaire = express.urlencoded({ extended: false, limit: '2kb' });
const page = (extra = {}) => pageCoffre({ totp: coffre.etat().totp, ...extra });
const jetonPresent = (req) => EXPOSE || jetonlocal.valide(req);

app.post('/coffre/deverrouiller', lireFormulaire, (req, res) => {
  if (!coffre.verrouille()) return res.redirect(303, '/');
  if (!jetonPresent(req)) return res.status(401).type('html').send(page({ erreur: t('err.jeton-local-requis') }));
  const b = req.body || {};
  try {
    coffre.deverrouiller(String(b.mdp || ''), String(b.code || ''));
    return res.redirect(303, '/');
  } catch (e) {
    return res.status(e.status || 400).type('html').send(page({ erreur: e.message }));
  }
});
app.post('/coffre/reinitialiser', lireFormulaire, (req, res) => {
  if (!coffre.verrouille()) return res.redirect(303, '/');
  if (!jetonPresent(req)) return res.status(401).type('html').send(page({ erreurReset: t('err.jeton-local-requis') }));
  try {
    coffre.reinitialiser(String((req.body || {}).phrase || ''));
    return res.redirect(303, '/');
  } catch (e) {
    return res.status(e.status || 400).type('html').send(page({ erreurReset: e.message }));
  }
});
app.use((req, res, next) => {
  if (!coffre.verrouille()) return next();
  if (garde.estApi(req)) return res.status(423).json({ error: t('err.vault.locked'), code: 'COFFRE_VERROUILLE' });
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(page());
  }
  // Un fichier de l'application passe ; toute autre adresse ramène à la page de connexion.
  if (req.method === 'GET' && /\.[a-z0-9]{1,8}$/i.test(req.path)) return next();
  return res.redirect(303, '/');
});
