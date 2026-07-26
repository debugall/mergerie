'use strict';
/* Aiguillage de forge : GitLab ou GitHub, dépôt par dépôt.

   RÈGLE DU PROJET : aucun module n'appelle `gitlab.js` ou `github.js` en direct.
   On passe toujours par `clientFor(repo)`, qui renvoie le client de la forge du
   dépôt. Les deux clients exposent la MÊME interface et la même forme de données
   (celle historiquement produite par gitlab.js), si bien que l'appelant n'a aucune
   branche `if (github)` à écrire.

   `repo` est n'importe quelle ligne portant une colonne `forge` : une ligne `repo`,
   ou une jointure qui remonte `repo.forge AS forge` (mr, task_target…). Une valeur
   absente vaut 'gitlab' : les dépôts créés avant l'arrivée de GitHub restent valides
   sans migration de données. */

const gitlab = require('./gitlab');
const github = require('./github');

const FORGES = ['gitlab', 'github'];

function forgeOf(repo) {
  const f = repo && typeof repo === 'object' ? repo.forge : repo;
  return f === 'github' ? 'github' : 'gitlab';
}

function clientFor(repo) {
  return forgeOf(repo) === 'github' ? github : gitlab;
}

// Normalise une forge saisie côté API (défaut : gitlab, jamais d'erreur).
function normalizeForge(value) {
  return FORGES.includes(String(value || '').trim()) ? String(value).trim() : 'gitlab';
}

// Une forge est utilisable si sa connexion est renseignée.
function isConfigured(cfg, forge) {
  return forgeOf(forge) === 'github'
    ? !!(cfg && cfg.github_token)
    : !!(cfg && cfg.gitlab_url && cfg.access_token);
}

// Libellé affichable (messages d'erreur, logs).
function label(forge) {
  return forgeOf(forge) === 'github' ? 'GitHub' : 'GitLab';
}

/* URL web d'une ref, pour les liens de l'onglet Git. GitLab : /-/tree|tags/<name>. */
function refUrl(cfg, repo, kind, name) {
  if (forgeOf(repo) === 'github') return github.refWebUrl(cfg, repo.project || repo, kind, name);
  const base = String(cfg.gitlab_url || '').replace(/\/+$/, '');
  const proj = gitlab.normalizeProject(repo.project || repo);
  const seg = kind === 'tag' ? 'tags' : 'tree';
  return `${base}/${proj}/-/${seg}/${encodeURIComponent(name)}`;
}

module.exports = { FORGES, forgeOf, clientFor, normalizeForge, isConfigured, label, refUrl, gitlab, github };
