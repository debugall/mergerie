'use strict';
/* QUI EST-CE ? — l'identité git du poste, et rien d'autre.
 *
 * Mergerie n'a pas de compte, pas de mot de passe, pas d'annuaire, et n'en aura pas : le jour
 * où une équipe partage un dépôt de données, l'auteur d'une review est celui qui a commité le
 * fichier, et git le sait déjà. Inventer une identité Mergerie à côté de celle de git, ce serait
 * deux vérités à tenir alignées pour ne rien gagner.
 *
 * Elle sert à quatre choses : l'auteur des commits du dépôt de données, le propriétaire d'un
 * dossier local (qui ne se résout que chez lui), l'exécutant d'un agent planifié (sans quoi
 * trois instances allumées lanceraient trois fois le même agent), et le « par <nom> » des cartes.
 *
 * LUE UNE FOIS, puis gardée : `git config` fait tourner un processus, et l'affichage des cartes
 * la demanderait à chaque seconde et demie. `oublier()` existe pour les tests et pour l'écran
 * des réglages, qui doit pouvoir constater qu'on vient de la configurer.
 */
const { execFileSync } = require('node:child_process');

let cache = null;

function lireGit(cle) {
  try {
    return String(execFileSync('git', ['config', '--get', cle], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch {
    // `git config --get` sort en 1 quand la clé n'existe pas : c'est une absence, pas une panne.
    return '';
  }
}

/**
 * `{ name, email, ok }` — `ok` est faux quand git n'a pas de `user.name`, auquel cas rien ne
 * doit être commité dans le dépôt de données : un historique dont l'auteur est « unknown » ne
 * répond pas à « qui a reviewé ça ? », et c'est la seule chose qu'on lui demande.
 */
function identite() {
  if (cache) return cache;
  /* L'environnement l'emporte : c'est ainsi que les tests et la CI se donnent une identité sans
     toucher au `~/.gitconfig` de la machine, et c'est aussi ce que git lui-même respecte. */
  const name = (process.env.GIT_AUTHOR_NAME || '').trim() || lireGit('user.name');
  const email = (process.env.GIT_AUTHOR_EMAIL || '').trim() || lireGit('user.email');
  cache = { name, email, ok: Boolean(name) };
  return cache;
}

/** Le nom seul, ou `''`. Ce qui s'affiche sur une carte. */
const nom = () => identite().name;

/** Oublie ce qui est en cache — après avoir configuré git, ou entre deux tests. */
const oublier = () => { cache = null; };

module.exports = { identite, nom, oublier };
