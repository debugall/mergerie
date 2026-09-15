'use strict';
const db = require('./db');
const { DEFAULT_CLONE_DIR } = require('./paths');
const { promptsFor } = require('./prompts');
const registre = require('./store-registry');

/* DEUX TABLES, UN SEUL OBJET. Les réglages vivent désormais dans `config` (ce que l'ÉQUIPE a
   décidé : gabarits de prompt, seuils, politiques, URL de la forge) et dans `local_config` (ce
   qui appartient à CE POSTE : les sept jetons, le chemin des clones, la langue, le moteur de
   dictée). Le tri est déclaré une fois pour toutes dans `src/store-registry.js`, colonne par
   colonne, et `npm run check` refuse un champ sans destination.

   Le reste de l'application ne voit rien de ce découpage : `getConfig()` rend le même objet
   qu'avant, `updateConfig()` accepte le même patch. Seule change la table où chaque valeur
   atterrit — et c'est tout l'intérêt, puisque c'est ce qui décidera un jour de ce qui part
   dans le dépôt d'équipe. */
const CHAMPS_POSTE = registre.localesDe('config').filter((c) => c !== 'id');

function getConfig() {
  const row = { ...db.prepare('SELECT * FROM config WHERE id = 1').get() };
  const local = db.prepare('SELECT * FROM local_config WHERE id = 1').get() || {};
  for (const champ of CHAMPS_POSTE) row[champ] = local[champ];
  if (!row.clone_path) row.clone_path = DEFAULT_CLONE_DIR;
  return row;
}

/** Le champ est-il d'équipe (`config`) ou de ce poste (`local_config`) ? Sert aux badges. */
const destinationDe = (champ) => (CHAMPS_POSTE.includes(champ) ? 'poste' : 'equipe');

const ALLOWED = [
  'gitlab_url', 'access_token', 'clone_path', 'jira_url',
  'github_url', 'github_token',
  'prompt_review', 'prompt_explain', 'prompt_modify', 'prompt_fix', 'language', 'ai_extra_instructions',
  'jira_email', 'jira_token', 'review_explain', 'converge_threshold', 'converge_max_passes',
  'brief_on_open', 'auto_post_review', 'auto_post_blocking_only', 'auto_review_new', 'review_auto_max', 'auto_rereview_stale',
  'auto_runner',
  'jenkins_url', 'jenkins_user', 'jenkins_token', 'jenkins_refresh_minutes',
  'verif_auto_max', 'todo_close_on_merge', 'jira_test_key', 'agent_auto_max',
  'task_default_auto_push', 'task_default_ask_questions',
  'task_default_notify_jira', 'task_default_converge',
  'verify_jira_comment',
  'dictation_provider', 'dictation_model', 'dictation_vad_model', 'dictation_command',
  'dictation_url', 'dictation_api_key', 'dictation_remote_model', 'dictation_language',
  'dictation_vocabulary', 'dictation_replacements', 'dictation_final_pass',
  'data_repo_url', 'data_repo_branch', 'data_sync_seconds', 'usage_share',
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
  /* Coché par défaut : une todo « suivre !201 » n'a plus de raison d'être une fois !201
     mergée, et la cocher soi-même après coup est le geste qu'on oublie. */
  next.todo_close_on_merge = next.todo_close_on_merge === '0' ? '0' : '1';
  // Langue : on refuse silencieusement une valeur inconnue plutôt que de casser l'interface.
  if (!['fr', 'en'].includes(next.language)) next.language = 'fr';
  // Explication : booléen stocké en texte, normalisé à '0'/'1' (défaut '1').
  next.review_explain = next.review_explain === '0' ? '0' : '1';
  /* Publication automatique du rapport sur la merge request : même stockage, DÉFAUT INVERSE.
     Le doute profite au silence — un réglage illisible ne doit pas se mettre à écrire chez
     les collègues à la prochaine review. */
  next.auto_post_review = next.auto_post_review === '1' ? '1' : '0';
  /* Et son filtre : ne publier que les rapports qui portent au moins un constat bloquant.
     Décoché par défaut, sinon activer la publication automatique se mettrait à taire la
     plupart des rapports sans qu'on l'ait demandé. Il ne vaut que sous la case ci-dessus. */
  next.auto_post_blocking_only = next.auto_post_blocking_only === '1' ? '1' : '0';
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
  /* Plafond des runs d'agent déclenchés par un HORAIRE, par jour. Même barème que les deux
     précédents, sur une plage plus large : un documentaliste hebdomadaire et cinq agents de
     domaine à rafraîchir tiennent sous dix, mais rien n'oblige à s'y tenir. 0 = illimité. */
  if ('agent_auto_max' in patch) {
    const am = parseInt(patch.agent_auto_max, 10);
    next.agent_auto_max = Number.isFinite(am) && am >= 0 ? Math.min(1000, am) : 10;
  }
  /* ---------- Dictée vocale ----------
     Le fournisseur est une ÉNUMÉRATION : une valeur inconnue retombe sur « éteint » plutôt
     que d'être écrite telle quelle — un réglage illisible ne doit pas laisser croire qu'un
     micro est actif. Même règle que pour la langue. */
  if (!['off', 'local', 'openai', 'browser'].includes(next.dictation_provider)) next.dictation_provider = 'off';
  if (!['auto', 'fr', 'en'].includes(next.dictation_language)) next.dictation_language = 'auto';
  if (next.dictation_url) next.dictation_url = next.dictation_url.trim().replace(/\/+$/, '');
  /* Fin de phrase : bornée [400, 1500] ms. En dessous, on coupe au milieu d'une respiration
     et le moteur décode des bouts de mots ; au-dessus, le texte n'arrive plus « pendant
     qu'on parle », ce qui est toute la promesse. */
  if ('dictation_silence_ms' in patch) {
    const ds = parseInt(patch.dictation_silence_ms, 10);
    next.dictation_silence_ms = Number.isFinite(ds) ? Math.min(1500, Math.max(400, ds)) : 700;
  }
  /* Arrêt du moteur après inactivité : 0 = jamais (assumé), sinon au moins une minute.
     turbo occupe deux gigaoctets de mémoire unifiée — le défaut d'un quart d'heure est là
     pour ça, pas pour la vitesse. */
  if ('dictation_idle_minutes' in patch) {
    const di = parseInt(patch.dictation_idle_minutes, 10);
    next.dictation_idle_minutes = (!Number.isFinite(di) || di <= 0) ? 0 : Math.min(240, Math.max(1, di));
  }
  /* ---------- Données partagées ----------
     L'URL est normalisée comme les autres (pas de slash final). La branche vide retombe sur
     `main` : une branche vide ferait échouer le premier `push` avec un message que personne ne
     relierait au champ laissé blanc. La cadence est bornée [10, 600] s — en dessous, on
     interroge la forge plus souvent qu'on ne travaille ; au-dessus, « partagé » ne veut plus
     rien dire dans une journée. */
  if (next.data_repo_url) next.data_repo_url = next.data_repo_url.trim().replace(/\/+$/, '');
  next.data_repo_branch = String(next.data_repo_branch || '').trim() || 'main';
  // Partage de la dépense : booléen en texte, DÉCOCHÉ par défaut — le doute profite au silence.
  next.usage_share = next.usage_share === '1' ? '1' : '0';
  if ('data_sync_seconds' in patch) {
    const ds = parseInt(patch.data_sync_seconds, 10);
    next.data_sync_seconds = Number.isFinite(ds) ? Math.min(600, Math.max(10, ds)) : 30;
  }
  // Seconde passe : booléen en texte, ACTIVÉE par défaut (elle ne coûte rien en local).
  next.dictation_final_pass = next.dictation_final_pass === '0' ? '0' : '1';
  // Les rapports produits par l'IA suivent la langue de l'interface (i18n.md lot 5,
  // option 1). On n'aligne QUE les gabarits restés au défaut : un prompt que
  // l'utilisateur a personnalisé n'est jamais écrasé (piège n°4 du plan).
  if (next.language !== current.language) Object.assign(next, promptsFor(next.language, next));
  /* CE QUE L'ÉQUIPE A DÉCIDÉ. Un champ ajouté ici doit l'être aussi dans `ALLOWED` ci-dessus
     et dans `partagees` du registre — sans quoi la route répond 200, l'écran dit
     « enregistré », et la valeur n'est nulle part. `npm run check` rattrape les trois cas. */
  db.prepare(`UPDATE config SET
      gitlab_url = @gitlab_url,
      github_url = @github_url,
      jira_url = @jira_url,
      jenkins_url = @jenkins_url,
      prompt_review = @prompt_review,
      prompt_explain = @prompt_explain,
      prompt_modify = @prompt_modify,
      prompt_fix = @prompt_fix,
      ai_extra_instructions = @ai_extra_instructions,
      jira_test_key = @jira_test_key,
      verify_jira_comment = @verify_jira_comment,
      review_explain = @review_explain,
      auto_post_review = @auto_post_review,
      auto_post_blocking_only = @auto_post_blocking_only,
      auto_review_new = @auto_review_new,
      auto_rereview_stale = @auto_rereview_stale,
      auto_runner = @auto_runner,
      review_auto_max = @review_auto_max,
      converge_threshold = @converge_threshold,
      converge_max_passes = @converge_max_passes,
      retention_days = @retention_days,
      stale_mr_days = @stale_mr_days,
      verif_auto_max = @verif_auto_max,
      agent_auto_max = @agent_auto_max,
      dictation_vocabulary = @dictation_vocabulary,
      dictation_replacements = @dictation_replacements
    WHERE id = 1`).run(next);
  /* CE QUI APPARTIENT À CE POSTE. Les sept jetons sont ici, et nulle part ailleurs : les
     colonnes de même nom dans `config` sont vidées et gelées au démarrage (`src/db.js`). */
  db.prepare(`UPDATE local_config SET
      access_token = @access_token,
      clone_path = @clone_path,
      github_token = @github_token,
      language = @language,
      jira_email = @jira_email,
      jira_token = @jira_token,
      jenkins_user = @jenkins_user,
      jenkins_token = @jenkins_token,
      jenkins_refresh_minutes = @jenkins_refresh_minutes,
      dictation_provider = @dictation_provider,
      dictation_model = @dictation_model,
      dictation_vad_model = @dictation_vad_model,
      dictation_command = @dictation_command,
      dictation_url = @dictation_url,
      dictation_api_key = @dictation_api_key,
      dictation_remote_model = @dictation_remote_model,
      dictation_language = @dictation_language,
      dictation_silence_ms = @dictation_silence_ms,
      dictation_final_pass = @dictation_final_pass,
      dictation_idle_minutes = @dictation_idle_minutes,
      data_repo_url = @data_repo_url,
      data_repo_branch = @data_repo_branch,
      data_sync_seconds = @data_sync_seconds,
      usage_share = @usage_share,
      /* Des habitudes, pas des politiques : le brief au lancement, les cadences de CE poste,
         la fermeture des todos (devenues personnelles) et les cases d'office d'une session. */
      brief_on_open = @brief_on_open,
      auto_refresh_minutes = @auto_refresh_minutes,
      jira_watch_minutes = @jira_watch_minutes,
      todo_close_on_merge = @todo_close_on_merge,
      task_default_auto_push = @task_default_auto_push,
      task_default_ask_questions = @task_default_ask_questions,
      task_default_notify_jira = @task_default_notify_jira,
      task_default_converge = @task_default_converge
    WHERE id = 1`).run(next);
  return getConfig();
}

module.exports = { getConfig, updateConfig, destinationDe, CHAMPS_POSTE };
