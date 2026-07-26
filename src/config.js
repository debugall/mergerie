'use strict';
const db = require('./db');
const { DEFAULT_CLONE_DIR } = require('./paths');
const { promptsFor } = require('./prompts');

function getConfig() {
  const row = db.prepare('SELECT * FROM config WHERE id = 1').get();
  if (!row.clone_path) row.clone_path = DEFAULT_CLONE_DIR;
  return row;
}

const ALLOWED = [
  'gitlab_url', 'access_token', 'clone_path', 'jira_url',
  'prompt_review', 'prompt_explain', 'prompt_modify', 'review_skill', 'language',
  'jira_email', 'jira_token', 'review_explain', 'converge_threshold', 'converge_max_passes',
];

function updateConfig(patch) {
  const current = getConfig();
  const next = { ...current };
  for (const key of ALLOWED) {
    if (key in patch && patch[key] != null) next[key] = String(patch[key]);
  }
  // normalise les URLs (pas de slash final) et le chemin de clonage (pas d'espaces)
  if (next.gitlab_url) next.gitlab_url = next.gitlab_url.trim().replace(/\/+$/, '');
  if (next.jira_url) next.jira_url = next.jira_url.trim().replace(/\/+$/, '');
  if (next.clone_path) next.clone_path = next.clone_path.trim();
  // Rafraîchissement auto : 0 = désactivé ; sinon minimum 1 minute (protège des rate limits API).
  if ('auto_refresh_minutes' in patch) {
    let m = parseInt(patch.auto_refresh_minutes, 10);
    next.auto_refresh_minutes = (!Number.isFinite(m) || m <= 0) ? 0 : Math.max(1, m);
  }
  // Langue : on refuse silencieusement une valeur inconnue plutôt que de casser l'interface.
  if (!['fr', 'en'].includes(next.language)) next.language = 'fr';
  // Explication : booléen stocké en texte, normalisé à '0'/'1' (défaut '1').
  next.review_explain = next.review_explain === '0' ? '0' : '1';
  // Convergence : seuil /10 borné [1,10] (défaut 8) ; plafond de passes borné [1,10] (défaut 3).
  {
    const th = parseFloat(String(next.converge_threshold).replace(',', '.'));
    next.converge_threshold = String(Number.isFinite(th) ? Math.min(10, Math.max(1, th)) : 8);
    const mp = parseInt(next.converge_max_passes, 10);
    next.converge_max_passes = String(Number.isFinite(mp) ? Math.min(10, Math.max(1, mp)) : 3);
  }
  // Les rapports produits par l'IA suivent la langue de l'interface (i18n.md lot 5,
  // option 1). On n'aligne QUE les gabarits restés au défaut : un prompt que
  // l'utilisateur a personnalisé n'est jamais écrasé (piège n°4 du plan).
  if (next.language !== current.language) Object.assign(next, promptsFor(next.language, next));
  db.prepare(`UPDATE config SET
      gitlab_url = @gitlab_url,
      access_token = @access_token,
      clone_path = @clone_path,
      jira_url = @jira_url,
      prompt_review = @prompt_review,
      prompt_explain = @prompt_explain,
      prompt_modify = @prompt_modify,
      review_skill = @review_skill,
      language = @language,
      jira_email = @jira_email,
      jira_token = @jira_token,
      review_explain = @review_explain,
      converge_threshold = @converge_threshold,
      converge_max_passes = @converge_max_passes,
      auto_refresh_minutes = @auto_refresh_minutes
    WHERE id = 1`).run(next);
  return getConfig();
}

module.exports = { getConfig, updateConfig };
