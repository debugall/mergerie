'use strict';
/* « Équipe » ou « ce poste ». */
// @expose loadConfig
/* ---------- « ÉQUIPE » OU « CE POSTE » ----------
 *
 * Les réglages ne sont plus tous de même nature. Certains décrivent ce que L'ÉQUIPE a décidé —
 * les gabarits de prompt, les seuils, l'URL de la forge — et partiront dans le dépôt de données
 * partagé ; d'autres appartiennent à CETTE machine : les six jetons, le chemin des clones, la
 * langue. Un écran qui ne le dit pas laisse croire qu'on règle son outil
 * alors qu'on règle celui de six personnes, ou l'inverse.
 *
 * La destination vient du SERVEUR (`scopes`, produit par le registre) : recopiée ici, la liste
 * mentirait au premier réglage déplacé — et un badge qui ment sur un jeton est pire que pas de
 * badge du tout.
 *
 * Le badge se glisse après le premier <span> du label : sur un champ texte c'est juste après
 * l'intitulé, sur une case à cocher juste après son libellé. Idempotent — `loadConfig` repasse
 * à chaque ouverture de sous-onglet. */
function poserBadgesConfig(scopes) {
  const f = $('#configForm');
  if (!f || !scopes) return;
  /* Les champs de réglages sont éclatés sur six sous-onglets et rattachés au formulaire par
     `form="configForm"` : `f.elements` est la seule liste qui les voie tous. */
  for (const el of [...f.elements]) {
    const scope = el.name && scopes[el.name];
    if (!scope) continue;
    const label = el.closest('label');
    if (!label) continue;
    let badge = label.querySelector(':scope > .scope-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'scope-badge';
      const titre = label.querySelector(':scope > span');
      if (titre) titre.insertAdjacentElement('afterend', badge);
      else label.appendChild(badge);
    }
    badge.dataset.scope = scope;
    badge.textContent = tr(scope === 'poste' ? 'settings.scope.poste' : 'settings.scope.equipe');
    badge.title = tr(scope === 'poste' ? 'settings.scope.poste.tip' : 'settings.scope.equipe.tip');
  }
}

async function loadConfig() {
  const depart = Date.now();
  const c = await api('/config');
  poserBadgesConfig(c.scopes);   // avant les abandons ci-dessous : un badge ne touche à aucune valeur
  chargerDataSync();             // l'état de la synchro, indépendant des champs
  if (configFrappe >= depart) return;      // l'utilisateur a tapé pendant ce temps : on s'abstient
  /* ET S'IL A TAPÉ AVANT ? Chaque sous-onglet de Réglages rappelle `loadConfig` en s'ouvrant :
     une valeur modifiée puis non enregistrée était écrasée par le serveur au premier changement
     de sous-onglet, sans un mot. Tant que le formulaire est sale, ce qui est à l'écran gagne —
     et la mention « modifications non enregistrées » reste sur les boutons, dans TOUS les
     sous-onglets : c'est elle, l'avertissement au changement d'onglet. */
  if (configSale) return;
  const f = $('#configForm');
  for (const k of CONFIG_FIELDS) { if (f[k]) f[k].value = c[k] || ''; }
  f.auto_refresh_minutes.value = Number(c.auto_refresh_minutes) || 0; // 0 affiché explicitement
  // Idem : 0 signifie « sans limite », il doit s'écrire plutôt que rester vide.
  if (f.retention_days) f.retention_days.value = Number(c.retention_days) || 0;
  if (f.review_explain) f.review_explain.checked = c.review_explain !== '0'; // défaut : activé
  // Publication automatique : défaut DÉSACTIVÉ — le test est donc `=== '1'`, pas `!== '0'`.
  if (f.auto_post_review) f.auto_post_review.checked = c.auto_post_review === '1';
  if (f.auto_post_blocking_only) f.auto_post_blocking_only.checked = c.auto_post_blocking_only === '1';
  if (f.auto_post_review_link) f.auto_post_review_link.checked = c.auto_post_review_link === '1';
  /* CE QUI PARTIRA SI ON NE TOUCHE À RIEN. Un champ vide avec une aide qui dit « laissez vide
     pour le message par défaut » oblige à publier une fois pour savoir de quoi il s'agit. */
  if (f.review_link_template) {
    f.review_link_template.placeholder = tr('mr.link.comment-note', {
      url: 'https://…/reviews/…/rapport.md', v: 2, note: '8,4',
    });
  }
  /* La ligne « publier le lien » n'a de sens qu'avec un dépôt de données : on retient ici ce
     que le serveur vient de dire, `syncAutoPostBlocking` s'en sert à chaque changement. */
  depotDonneesConfigure = !!String(c.data_repo_url || '').trim();
  if (f.auto_review_new) f.auto_review_new.checked = c.auto_review_new === '1';
  if (f.auto_rereview_stale) f.auto_rereview_stale.checked = c.auto_rereview_stale === '1';
  /* L'exécutant des automatismes : une LISTE, remplie des exécutants connus, et cachée en
     mono-poste. Posé après les cases, car l'avertissement dépend d'elles. */
  poserExecutantAuto(c.auto_runner || '');
  poserApprobationAuto(c);
  // 0 = « sans limite » : il doit s'ÉCRIRE, une case vide se lirait comme « valeur par défaut ».
  if (f.review_auto_max) f.review_auto_max.value = Number(c.review_auto_max) || 0;
  // Atterrissage sur le brief : coché par défaut, comme côté serveur.
  if (f.brief_on_open) f.brief_on_open.checked = c.brief_on_open !== '0';
  // Coché par défaut, comme côté serveur : le test est donc `!== '0'`.
  if (f.todo_close_on_merge) f.todo_close_on_merge.checked = c.todo_close_on_merge !== '0';
  // A/Réglages 1 : décochés par défaut, donc `=== '1'` — poser le réglage ne change rien
  // tant qu'on n'y a pas touché.
  /* `String(...)` : ces colonnes-là sont des INTEGER, SQLite rend donc 1 et non '1'. Comparer
     strictement laissait la case décochée au rechargement — voir `defautsSession`. */
  for (const k of ['task_default_auto_push', 'task_default_ask_questions', 'task_default_notify_jira', 'task_default_converge', 'verify_jira_comment']) {
    if (f[k]) f[k].checked = String(c[k]) === '1';
  }
  if (f.stale_mr_days) f.stale_mr_days.value = Number(c.stale_mr_days) || 5;
  // Partager sa dépense : DÉCOCHÉ par défaut, donc `=== '1'`, comme les autres réglages prudents.
  if (f.usage_share) f.usage_share.checked = c.usage_share === '1';
  /* C15 — LE DÉFAUT EFFECTIF S'ÉCRIT, il ne se devine pas dans un `placeholder`. Un champ vide
     avec « 5 » en gris se lit « rien n'est réglé », alors que 5 EST la valeur appliquée : on
     ne sait pas si l'on regarde un réglage ou une suggestion. `retention_days` et
     `stale_mr_days` le faisaient déjà ; le plafond de vérification automatique non. */
  if (f.verif_auto_max) f.verif_auto_max.value = Number(c.verif_auto_max) || 5;
  if (f.jenkins_refresh_minutes) f.jenkins_refresh_minutes.value = Number(c.jenkins_refresh_minutes) || 0;
  syncReviewAutoMax();
  syncAutoPostBlocking();
  convDefauts = { seuil: c.converge_threshold || '8', passes: c.converge_max_passes || '3' };
  configReference = corpsConfig(f);
  /* Ce qui vient du serveur n'est pas une modification : le rechargement qui suit un
     enregistrement effacerait sinon la mention qu'il vient tout juste de justifier. */
  marquerConfig(false);
  renderNotifSettings();
}
