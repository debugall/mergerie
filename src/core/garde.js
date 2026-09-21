'use strict';
/* LES GARDES DE LA PORTE — ce qui décide, AVANT toute route, si une requête a le droit d'entrer.
 *
 * Mergerie écoute sur 127.0.0.1 et se croyait donc à l'abri : seul l'utilisateur lui parle.
 * C'est faux dès qu'une page web est ouverte dans un autre onglet. Trois voies, trois gardes :
 *
 *   1. LE REBINDING DNS. Une page `evil.example:4319` fait re-résoudre son nom vers 127.0.0.1 :
 *      le navigateur la considère alors comme MÊME ORIGINE que l'application — `Origin` et
 *      `Host` valent tous deux `evil.example:4319`, et le filtre d'origine, qui compare l'un à
 *      l'autre, les laisse passer. Toute l'API devient lisible : la configuration, la sauvegarde
 *      avec ses jetons, le lancement d'un agent. La parade tient en une liste : un `Host` qui
 *      n'est ni une adresse IP, ni `localhost`, ni un nom déclaré, est refusé (421).
 *      Une IP littérale ne se re-résout pas — le rebinding a besoin d'un NOM —, on l'accepte donc
 *      telle quelle : c'est ce qui laisse marcher l'accès par l'IP du poste quand on expose.
 *
 *   2. LA LECTURE CROISÉE. Les navigateurs disent d'où vient une requête (`Sec-Fetch-Site`).
 *      Une page d'un autre site qui interroge l'API n'a rien à y faire, même en lecture : on
 *      refuse `cross-site` et `same-site` sur `/api/` (un autre port de localhost est
 *      « same-site »). Absent — curl, un script —, on laisse passer, comme le filtre d'origine.
 *
 *   3. L'EXPOSITION. `HOST=0.0.0.0` ouvre l'outil au réseau, et l'outil n'a pas de comptes : sans
 *      jeton d'accès, n'importe qui sur le réseau pilotait les agents du poste. On refuse donc de
 *      démarrer exposé sans `MERGERIE_ACCESS_TOKEN`, et chaque requête doit le présenter — par
 *      cookie (posé par la page d'accès) ou par `Authorization: Bearer`.
 */
const crypto = require('node:crypto');

const BOUCLES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Le nom d'hôte d'un en-tête `Host`, sans le port, en minuscules. `[::1]:4319` → `[::1]`. */
function nomHote(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const fin = h.indexOf(']');
    return fin === -1 ? h : h.slice(0, fin + 1);
  }
  const deuxPoints = h.lastIndexOf(':');
  return deuxPoints === -1 ? h : h.slice(0, deuxPoints);
}

const estIpLitterale = (nom) => /^\d{1,3}(\.\d{1,3}){3}$/.test(nom) || /^\[[0-9a-f:.]+\]$/.test(nom);

/** L'hôte d'écoute est-il une boucle locale ? `0.0.0.0`, `::`, une IP de réseau : non. */
const estBoucle = (host) => BOUCLES.has(String(host || '').trim().toLowerCase());

/** Les noms que le poste accepte dans `Host` : la boucle, `HOST` s'il est un nom, et la liste
 *  `MERGERIE_ALLOWED_HOSTS` — pour un reverse-proxy, ou un nom de machine sur le réseau. */
function nomsAutorises(env = process.env) {
  const noms = new Set(['localhost']);
  const hote = String(env.HOST || '').trim().toLowerCase();
  if (hote && hote !== '0.0.0.0' && hote !== '::') noms.add(hote);
  for (const brut of String(env.MERGERIE_ALLOWED_HOSTS || '').split(',')) {
    const nom = nomHote(brut);
    if (nom) noms.add(nom);
  }
  return noms;
}

/** La requête vise-t-elle un nom que ce poste reconnaît ? */
function hoteAutorise(host, env = process.env) {
  const nom = nomHote(host);
  if (!nom) return true;                     // pas d'en-tête Host : ce n'est pas un navigateur
  if (estIpLitterale(nom)) return true;      // une IP ne se re-résout pas
  return nomsAutorises(env).has(nom);
}

/** Une requête d'un autre site vers l'API ? `none` (URL tapée) et `same-origin` passent. */
function siteEtranger(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return site === 'cross-site' || site === 'same-site';
}

/* ---------------------------------------------------------------- les adresses de dépôt */

/* LES ADRESSES QU'ON ACCEPTE DE JOINDRE. `git` sait parler bien plus de langues qu'il n'en
   faut : `ext::` lance une commande, `fd::` lit un descripteur, `http://` envoie les
   identifiants en clair. On garde celles d'un dépôt d'équipe — HTTPS, SSH (les deux formes),
   et un chemin local ou `file://`, qui servent un dépôt sur un disque partagé et la démo.
   La vérification est DOUBLÉE côté git par `GIT_ALLOW_PROTOCOL` (voir `git()` dans `src/datasync.js`), pour qu'une
   adresse qui passerait ce filtre par un détour ne passe pas le suivant. */
function adresseAdmise(v) {
  const t = String(v || '').trim();
  if (!t) return true;                                          // vide = mono-poste, rien à joindre
  if (/^https:\/\//i.test(t) || /^ssh:\/\//i.test(t) || /^file:\/\//i.test(t)) return true;
  if (/^[\w.-]+@[\w.-]+:[^:]/.test(t) && !t.includes('::')) return true;      // git@hote:groupe/projet
  if (/^\//.test(t) || /^[a-z]:[\\/]/i.test(t)) return true;                 // chemin absolu
  return false;
}

/* ---------------------------------------------------------------- le jeton d'accès */

const COOKIE = 'mergerie_acces';

/* COMPARAISON À TEMPS CONSTANT. Comparer deux chaînes avec `===` s'arrête au premier caractère
   différent, et le temps de réponse dit alors combien de caractères étaient justes. On compare
   des empreintes de même longueur. */
function memeJeton(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a || '').length > 0;
}

function lireCookie(req, nom) {
  for (const morceau of String(req.headers.cookie || '').split(';')) {
    const i = morceau.indexOf('=');
    if (i === -1) continue;
    if (morceau.slice(0, i).trim() === nom) {
      try { return decodeURIComponent(morceau.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

/** Le jeton présenté par la requête : `Authorization: Bearer …` ou le cookie de la page d'accès. */
function jetonPresente(req, cookie = COOKIE) {
  const auth = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return lireCookie(req, cookie);
}

const echapper = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* LA PAGE D'ACCÈS. Autonome : ni script, ni feuille externe — elle doit s'afficher avant que
   quoi que ce soit d'autre soit autorisé, et sous la même politique de contenu que le reste. */
function pageAcces({ erreur = '' } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mergerie — accès</title>
<style>body{font:15px system-ui,sans-serif;background:#0f1420;color:#e7eaf0;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#171e2d;padding:28px 32px;border-radius:12px;width:min(380px,90vw)}h1{font-size:18px;margin:0 0 6px}
p{color:#9aa3b5;margin:0 0 18px;line-height:1.5}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #33405a;background:#0f1420;color:inherit}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
.err{color:#f87171;margin:10px 0 0}</style></head><body>
<form method="post" action="/acces"><h1>Mergerie</h1>
<p>Ce poste est ouvert au réseau : il faut le jeton d’accès (<code>MERGERIE_ACCESS_TOKEN</code>) pour entrer.</p>
<input type="password" name="jeton" autocomplete="current-password" autofocus aria-label="Jeton d’accès">
<button type="submit">Entrer</button>${erreur ? `<p class="err">${echapper(erreur)}</p>` : ''}</form></body></html>`;
}

/* « TESTER » AVEC UNE AUTRE ADRESSE EXIGE UN JETON TAPÉ. Le masque `***` veut dire « le jeton
   enregistré » : il ne doit partir que vers l'adresse où il est enregistré. Rien d'enregistré, rien
   à protéger ; un jeton tapé dans la requête est le sien. `defaut` est l'adresse que vaut un champ
   vide (pour GitHub, l'hôte WEB `https://github.com` — c'est ce que `github_url` désigne). */
function origineDe(u, defaut = '') {
  const v = String(u || '').trim() || defaut;
  try { return new URL(v).origin; } catch { return v; }
}

function jetonFraisRequis(urlCorps, urlBase, jetonCorps, jetonBase, defaut = '') {
  if (urlCorps == null || !jetonBase || (jetonCorps && jetonCorps !== '***')) return false;
  return origineDe(urlCorps, defaut) !== origineDe(urlBase, defaut);
}

module.exports = {
  jetonFraisRequis, origineDe,
  nomHote, estIpLitterale, estBoucle, nomsAutorises, hoteAutorise, siteEtranger, adresseAdmise,
  COOKIE, memeJeton, lireCookie, jetonPresente, pageAcces,
};
