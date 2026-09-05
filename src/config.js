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
  'github_url', 'github_token',
  'prompt_review', 'prompt_explain', 'prompt_modify', 'language', 'ai_extra_instructions',
  'jira_email', 'jira_token', 'review_explain', 'converge_threshold', 'converge_max_passes',
  'brief_on_open', 'auto_post_review', 'auto_review_new', 'review_auto_max', 'auto_rereview_stale',
  'jenkins_url', 'jenkins_user', 'jenkins_token', 'jenkins_refresh_minutes',
  'verif_auto_max',
];

function updateConfig(patch) {
  const current = getConfig();
  const next = { ...current };
  for (const key of ALLOWED) {
    if (key in patch && patch[key] != null) next[key] = String(patch[key]);
  }
  // normalise les URLs (pas de slash final) et le chemin de clonage (pas d'espaces)
  if (next.gitlab_url) next.gitlab_url = next.gitlab_url.trim().replace(/\/+$/, '');
  if (next.github_url) next.github_url = next.github_url.trim().replace(/\/+$/, '');
  if (next.jira_url) next.jira_url = next.jira_url.trim().replace(/\/+$/, '');
  if (next.jenkins_url) next.jenkins_url = next.jenkins_url.trim().replace(/\/+$/, '');
  if (next.clone_path) next.clone_path = next.clone_path.trim();
  // Rafraîchissement auto : 0 = désactivé ; sinon minimum 1 minute (protège des rate limits API).
  if ('auto_refresh_minutes' in patch) {
    let m = parseInt(patch.auto_refresh_minutes, 10);
    next.auto_refresh_minutes = (!Number.isFinite(m) || m <= 0) ? 0 : Math.max(1, m);
  }
  // Surveillance Jira : même règle — 0 = désactivée, sinon minimum 1 minute.
  if ('jira_watch_minutes' in patch) {
    const w = parseInt(patch.jira_watch_minutes, 10);
    next.jira_watch_minutes = (!Number.isFinite(w) || w <= 0) ? 0 : Math.max(1, w);
  }
  /* Onglet Jenkins : 0 = pas de rafraîchissement automatique, sinon au moins une minute et au
     plus une heure. Le plancher protège l'installation partagée — une liste de trois cents jobs
     redemandée toutes les dix secondes pèse sur tout le monde, pas seulement sur soi. */
  if ('jenkins_refresh_minutes' in patch) {
    const jr = parseInt(patch.jenkins_refresh_minutes, 10);
    next.jenkins_refresh_minutes = (!Number.isFinite(jr) || jr <= 0) ? 0 : Math.min(60, Math.max(1, jr));
  }
  /* Rétention de l'historique : 0 = illimité, sinon au moins 7 jours. Le plancher évite
     qu'une saisie à « 1 » n'efface le journal du job qu'on est en train de lire. */
  if ('retention_days' in patch) {
    const d = parseInt(patch.retention_days, 10);
    next.retention_days = (!Number.isFinite(d) || d <= 0) ? 0 : Math.max(7, d);
  }
  /* MR dormante : au bout de combien de jours une MR reviewée et toujours ouverte remonte
     dans le brief. Au moins 1 jour — à 0, toute MR reviewée ce matin serait « dormante »,
     et une section qui contient tout ne signale plus rien. */
  if ('stale_mr_days' in patch) {
    const s = parseInt(patch.stale_mr_days, 10);
    next.stale_mr_days = (!Number.isFinite(s) || s <= 0) ? 5 : Math.min(90, s);
  }
  // Brief à la première ouverture de la journée : booléen en texte, comme review_explain.
  next.brief_on_open = next.brief_on_open === '0' ? '0' : '1';
  // Langue : on refuse silencieusement une valeur inconnue plutôt que de casser l'interface.
  if (!['fr', 'en'].includes(next.language)) next.language = 'fr';
  // Explication : booléen stocké en texte, normalisé à '0'/'1' (défaut '1').
  next.review_explain = next.review_explain === '0' ? '0' : '1';
  /* Publication automatique du rapport sur la merge request : même stockage, DÉFAUT INVERSE.
     Le doute profite au silence — un réglage illisible ne doit pas se mettre à écrire chez
     les collègues à la prochaine review. */
  next.auto_post_review = next.auto_post_review === '1' ? '1' : '0';
  /* Review automatique à l'arrivée d'une MR : même stockage, même défaut prudent. Une case mal
     lue ne doit pas se mettre à dépenser des appels IA à chaque découverte. */
  next.auto_review_new = next.auto_review_new === '1' ? '1' : '0';
  next.auto_rereview_stale = next.auto_rereview_stale === '1' ? '1' : '0';
  // Convergence : seuil /10 borné [1,10] (défaut 8) ; plafond de passes borné [1,10] (défaut 3).
  {
    const th = parseFloat(String(next.converge_threshold).replace(',', '.'));
    next.converge_threshold = String(Number.isFinite(th) ? Math.min(10, Math.max(1, th)) : 8);
    const mp = parseInt(next.converge_max_passes, 10);
    next.converge_max_passes = String(Number.isFinite(mp) ? Math.min(10, Math.max(1, mp)) : 3);
  }
  /* Plafond des vérifications automatiques : entier borné [0, 50]. 0 signifie « sans limite »
     et doit s'écrire — une case vide se lirait comme « valeur par défaut ». Une saisie
     illisible retombe sur 5 plutôt que de désactiver le garde-fou en silence. */
  /* Plafond des reviews automatiques : même barème que celui des vérifications. 0 signifie
     « sans limite » et doit s'écrire — une case vide se lirait comme « valeur par défaut ». */
  if ('review_auto_max' in patch) {
    const rm = parseInt(patch.review_auto_max, 10);
    next.review_auto_max = Number.isFinite(rm) && rm >= 0 ? Math.min(50, rm) : 5;
  }
  if ('verif_auto_max' in patch) {
    const vm = parseInt(patch.verif_auto_max, 10);
    next.verif_auto_max = Number.isFinite(vm) && vm >= 0 ? Math.min(50, vm) : 5;
  }
  // Les rapports produits par l'IA suivent la langue de l'interface (i18n.md lot 5,
  // option 1). On n'aligne QUE les gabarits restés au défaut : un prompt que
  // l'utilisateur a personnalisé n'est jamais écrasé (piège n°4 du plan).
  if (next.language !== current.language) Object.assign(next, promptsFor(next.language, next));
  db.prepare(`UPDATE config SET
      gitlab_url = @gitlab_url,
      access_token = @access_token,
      clone_path = @clone_path,
      github_url = @github_url,
      github_token = @github_token,
      jira_url = @jira_url,
      prompt_review = @prompt_review,
      prompt_explain = @prompt_explain,
      prompt_modify = @prompt_modify,
      ai_extra_instructions = @ai_extra_instructions,
      language = @language,
      jira_email = @jira_email,
      jira_token = @jira_token,
      review_explain = @review_explain,
      auto_post_review = @auto_post_review,
      auto_review_new = @auto_review_new,
      auto_rereview_stale = @auto_rereview_stale,
      review_auto_max = @review_auto_max,
      converge_threshold = @converge_threshold,
      converge_max_passes = @converge_max_passes,
      auto_refresh_minutes = @auto_refresh_minutes,
      jira_watch_minutes = @jira_watch_minutes,
      retention_days = @retention_days,
      brief_on_open = @brief_on_open,
      stale_mr_days = @stale_mr_days,
      jenkins_url = @jenkins_url,
      jenkins_user = @jenkins_user,
      jenkins_token = @jenkins_token,
      jenkins_refresh_minutes = @jenkins_refresh_minutes,
      verif_auto_max = @verif_auto_max
    WHERE id = 1`).run(next);
  return getConfig();
}

module.exports = { getConfig, updateConfig };
