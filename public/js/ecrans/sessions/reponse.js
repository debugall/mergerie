'use strict';
/* Ce qu'une session a répondu et ce qu'elle a coûté, une todo t'attend, la MR devenue, répondre aux questions. */
// @expose fmtMilliers
/* ---------- Ce qu'une session a répondu, et ce qu'elle a coûté ----------
   Les deux premières lignes de la réponse sur la carte : on retrouve celle qu'on cherche sans
   ouvrir « Voir la réponse » l'une après l'autre. Repliées par défaut sur une ligne — la carte
   reste une carte — et dépliables d'un clic pour lire le chapeau entier. */
function chapeauCarte(t) {
  if (!t || !t.answer_head) return '';
  return `<details class="task-chapeau"><summary>${esc(t.answer_head)}</summary><p class="muted">${esc(tr('task.head.more'))}</p></details>`;
}

/* Durée et tokens de la dernière passe : « quels prompts font relire trois dépôts pour rien »
   se répond ici, avant les statistiques. Absents (session jamais lancée, comptage indisponible)
   ils ne s'affichent pas — un « 0 token » se lirait comme une mesure, pas comme une absence. */
function coutCarte(t) {
  const bouts = [];
  /* « par Claire » quand l'équipe partage un dépôt de données : le nom vient de git, celui qui
     a commité le fichier de la session. Rien à saisir, aucune colonne à tenir — et rien du tout
     en mono-poste, où « par moi » sur chaque carte n'apprendrait à personne. */
  if (t && (t.shared || t.author)) bouts.push(esc(texteAuteurPartage(t)));
  if (t && t.duration_ms) bouts.push(esc(dureeCourte(t.duration_ms)));
  if (t && t.tokens_est) bouts.push(esc(tr('task.cost.tokens', { n: fmtMilliers(t.tokens_est) })));
  /* QUAND ÇA S'EST TERMINÉ. `finished_at` était stocké, servait au TRI de la liste, et
     n'apparaissait nulle part : on lisait « terminée » sans savoir si c'était il y a trois
     minutes ou trois semaines — puis, un temps, un relatif façon « hier »/« avant-hier » que
     `Intl.RelativeTimeFormat` invente pour -1 et -2 jours, tout aussi vague pour qui compare
     plusieurs sessions à l'œil. L'absolu (date ET heure, comme sur l'écran de merge) est ce
     qu'on lit d'un coup d'œil ; le relatif reste disponible au survol, comme partout ailleurs
     (`dateHtml` pose le `data-when` que `infobulle.js` sait lire). */
  if (t && t.finished_at && t.status !== 'running') {
    const phrase = tr('task.finished-on', { date: fmtDate(t.finished_at), time: fmtHour(t.finished_at) });
    bouts.push(dateHtml(t.finished_at, phrase));
  }
  return bouts.length ? `<span class="task-cout muted">${bouts.join(' · ')}</span>` : '';
}
/* UNE TODO T'ATTEND — l'agent s'est arrêté sur une question, l'outil a posé la todo, et la
   carte n'en disait rien : on la retrouvait dans Notes, ou pas. Le badge y mène. */
function badgeTodoAttente(t) {
  if (!t || !t.todo_waiting) return '';
  return `<button type="button" class="tag to_review" data-todo-attente`
    + ` title="${esc(tr('task.todo-waiting.title'))}">${svgIco('clip')} ${esc(tr('task.todo-waiting'))}</button>`;
}
/* B9 — lancer la review depuis la ligne de projet. Le MÊME appel que la file : il n'y a
   qu'une façon de reviewer, et c'est celle-là. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-tgreview]');
  if (!b) return;
  try {
    await busy(b, () => api(`/mrs/${b.dataset.tgreview}/review`, { method: 'POST' }));
    toast(tr('toast.review-de-lancee', { iid: b.dataset.iid || '' }));
    refreshStatus();
  } catch (err) { toast(explainError(err.message), true); }
});

document.addEventListener('click', (e) => {
  if (!(e.target.closest && e.target.closest('[data-todo-attente]'))) return;
  navTab('notes'); showNotesSub('todos');
});
const fmtMilliers = (n) => Number(n).toLocaleString(I18Nrt.currentLocale());
function dureeCourte(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return tr('task.cost.sec', { n: s });
  const m = Math.round(s / 60);
  return m < 60 ? tr('task.cost.min', { n: m }) : tr('task.cost.hour', { n: (m / 60).toFixed(1) });
}

/* CE QUE LA MERGE REQUEST EST DEVENUE, SUR LA LIGNE DU PROJET. « MR !216 ↗ » ne disait rien
   de ce qu'elle vaut : il fallait retourner dans Reviews pour lire la note et le verdict de ce
   que la session venait de produire. Trois faits, aucun calcul — ils viennent avec la ligne. */
function etatMrDeLaLigne(tg) {
  const bouts = [];
  // `note_value` est une FRACTION [0,1] en base : la note sur 10 vaut dix fois.
  if (tg.mr_note != null) bouts.push(`<span class="tmr-note">${esc(fmtNote10(tg.mr_note * 10))}</span>`);
  if (tg.mr_verdict) bouts.push(`<span class="tmr-verdict v-${esc(tg.mr_verdict)}">${esc(tr(`mr.ref.verdict.${tg.mr_verdict}`))}</span>`);
  if (tg.mr_drafts) bouts.push(esc(tr('task.mr.drafts', { n: tg.mr_drafts, count: tg.mr_drafts })));
  if (!bouts.length) return '';
  return ` <span class="tmr-etat muted">${bouts.join(' · ')}</span>`;
}

function targetLine(t, tg) {
  const st = TASK_STATUS[tg.status] || { label: tg.status, cls: '' };
  /* `has_diff` vient du serveur : le patch est un fichier de CE poste, mais le commit, lui,
     voyage — et la route refait le diff depuis le clone quand le fichier manque. Se fier au
     fichier faisait disparaître le bouton sur toute session reçue du dépôt d'équipe. */
  const showDiff = !!tg.has_diff && ['committed', 'pushed'].includes(tg.status);
  const showPush = tg.status === 'committed';
  /* Le rattrapage s'offre dans deux cas — un bouton qui réécrit une branche n'a pas à être
     proposé en permanence, donc ni l'un ni l'autre par défaut :
     - la merge request est réellement en conflit, la forge le dit (`mr_conflicts`, relevé par
       la découverte). `null` = la forge n'a pas encore tranché (GitHub calcule `mergeable` en
       différé) : on s'abstient plutôt que de deviner.
     - le dernier push a échoué en non-fast-forward (`pushDivergent`, transverse/erreurs.js) —
       la branche distante a juste avancé, sans que la forge ait besoin de flaguer quoi que ce
       soit sur la MR. Même remède (rejouer nos commits par-dessus), sinon le bouton « Rattraper
       la base » de l'errbox promet un geste que cette carte ne propose pas encore. */
  const peutRattraper = !!tg.branch && ['committed', 'pushed', 'error'].includes(tg.status)
    && (tg.mr_conflicts === 1 || pushDivergent(tg.last_error));
  // une MR peut préexister sur la branche (session lancée depuis une MR) :
  // dans ce cas il ne faut pas proposer d'en créer une seconde.
  const mrIid = tg.mr_iid || tg.existing_mr_iid;
  const mrUrl = tg.mr_url || tg.existing_mr_url;
  const canMr = tg.status === 'pushed' && !mrIid;
  /* Lancer UN projet d'une session multi-dépôts. Absent quand le projet est déjà en cours ou en
     attente de réponses : relancer par-dessus perdrait la question posée. Le bouton ne s'affiche
     que sur une session à plusieurs projets — sur un seul, il ferait doublon avec « Relancer ». */
  const runTarget = (t.targets || []).length > 1 && !['running', 'needs_input'].includes(tg.status);
  /* Corriger CE projet. Une remarque porte presque toujours sur un dépôt précis : l'envoyer à
     toute la session coûtait un appel IA par dépôt et faisait repasser l'agent sur du code
     qu'on ne voulait plus voir toucher. Comme « Lancer », le bouton n'apparaît qu'à partir de
     deux projets — sur un seul il ferait doublon avec « Demander une correction ». */
  const followTarget = (t.targets || []).length > 1 && ['committed', 'pushed'].includes(tg.status);
  const defaultMrTitle = t.commit_message || `${tg.branch}: ${(t.prompt || '').split('\n')[0].slice(0, 72)}`;
  return `<div class="target-line">
    <span class="tag ${st.cls}">${st.label}</span>
    ${tg.status === 'error' ? '' : targetStepper(tg)}
    <span class="t-name">${esc(tg.project)}</span>
    ${chipBranche(tg.branch || '')}
    ${/* La session demandée n'a pas pu être reprise : on le dit ICI, pas seulement dans un
          journal qui défile — sinon l'écran affiche un identifiant que personne n'a saisi. */''}
    ${tg.session_note ? `<span class="t-note" title="${esc(tr('task.session.fallback-title', { detail: tg.session_note }))}">${svgIco('alert')} ${esc(tr('task.session.fallback'))}</span>` : ''}
    ${mrIid ? (mrUrl ? ` <a href="${esc(safeUrl(mrUrl))}" target="_blank" rel="noopener noreferrer">MR !${mrIid} ↗</a>` : ` <span class="muted">MR !${mrIid}</span>`) : ''}
    ${etatMrDeLaLigne(tg)}
    ${/* LE MÊME TAG QUE DANS REVIEWS. Le bouton « Mettre à jour avec {base} » offre le geste,
          mais rien ne disait POURQUOI il est là — sur la file des MR, un conflit se voit avant
          de cliquer quoi que ce soit ; ici il fallait deviner. Seulement sur un vrai conflit
          flagué par la forge (`mr_conflicts`), pas sur un simple push non-fast-forward : le
          mot « conflit » doit rester vrai, la seconde moitié de `peutRattraper` n'en est pas un. */''}
    ${tg.mr_conflicts === 1 ? `<span class="tag conflict-info" title="${esc(tr('task.tag.conflict-title', { base: tg.base_branch || 'main' }))}">${svgIco('alert')} ${esc(tr('mr.tag.conflict'))}</span>` : ''}
    ${/* B5 — L'ÉTAT DU TICKET sur la ligne de projet. La ligne disait la note, le verdict et
          les brouillons ; le ticket, jamais — alors qu'« il est repassé en cours » change ce
          qu'on fait de la branche autant qu'un test rouge. */''}
    ${tg.ticket_key ? badgeTicket({ ticket_key: tg.ticket_key, ticket_status: tg.ticket_status, ticket_category: tg.ticket_category, status: 'reviewed' }) : ''}
    ${/* B9 — REVIEWER LA MR QUE CETTE SESSION VIENT D'OUVRIR. Le geste suivant évident, et il
          fallait aller dans Reviews, retrouver !250 dans la file, cliquer, puis revenir ici
          pour la suite. Le bouton ne s'affiche que si la MR existe ET n'a pas encore de
          rapport : proposer de reviewer ce qui est déjà reviewé n'aide personne. */''}
    ${tg.mr_row_id && !tg.has_review
    ? `<button class="btn btn-sm" data-tgreview="${tg.mr_row_id}" data-iid="${mrIid || ''}" title="${esc(tr('task.title.review-mr'))}"><svg class="ico ico-sm"><use href="#i-eye"/></svg>${esc(tr('mr.btn.review'))}</button>`
    : ''}
    ${badgeCI(tg.branch)}
    ${/* B5 — PRÉVENIR JIRA. La merge request est ouverte et la branche porte une clé : un
          commentaire avec le lien, et la transition « en revue » si Jira la propose. Derrière
          confirmation — c'est écrire chez les autres. */''}
    ${mrIid && jiraConfigured && /[A-Z][A-Z0-9]+-\d+/i.test(tg.branch || '')
    ? `<button class="btn btn-sm" data-tgjira="${tg.id}" data-task="${t.id}" data-iid="${mrIid}" data-key="${esc((String(tg.branch || '').match(/[A-Z][A-Z0-9]+-\d+/i) || [''])[0].toUpperCase())}" title="${esc(tr('task.title.notify-jira'))}"><svg class="ico ico-sm"><use href="#i-tag"/></svg>${esc(tr('task.btn.notify-jira'))}</button>` : ''}
    ${/* LES BOUTONS CONTEXTUELS, ICI AUSSI. La ligne a un dépôt et une branche : `{env}` et
          `{branch}` s'y résolvent exactement comme sur une carte de merge request. Le bloc
          arrive vide et se remplit — un projet sans service lié n'affiche rien. */''}
    <span class="tg-liens" data-liens-task="${t.id}" data-liens-target="${tg.id}"></span>
    ${tg.mr_merged ? `<span class="tag merged" title="${tr('task.tag.merged-title', { forge: forgeLabel(tg.forge) })}">${tr('task.tag.merged')}</span>` : ''}
    <span class="spacer"></span>
    ${resumeCmdBtn(tg.resume_cmd)}
    ${tg.has_output ? `<button class="btn btn-sm" data-tgout="${tg.id}" data-task="${t.id}" title="${esc(tr('task.title.view-output'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${tr('task.btn.view-output')}</button>` : ''}
    ${showDiff ? `<button class="btn btn-sm" data-tgdiff="${tg.id}" data-task="${t.id}" title="${esc(tr('task.title.view-diff'))}"><svg class="ico ico-sm"><use href="#i-eye"/></svg>${tr('mr.btn.diff')}</button>` : ''}
    ${runTarget ? `<button class="btn btn-sm" data-tgrun="${tg.id}" data-task="${t.id}" title="${esc(tg.status === 'new' ? tr('task.title.run-target') : tr('task.title.rerun-target'))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${tr('task.btn.run-target')}</button>` : ''}
    ${followTarget ? `<button class="btn btn-sm" data-tgfollow="${tg.id}" data-task="${t.id}" title="${esc(tr('task.title.request-fix-target', { project: tg.project }))}"><svg class="ico ico-sm"><use href="#i-repeat"/></svg>${tr('task.btn.request-fix')}</button>` : ''}
    ${peutRattraper ? (() => {
      /* RATTRAPER LA BRANCHE DE DÉPART. Le cas : la merge request existe, la branche de départ
         a avancé, la forge affiche des conflits. On rejoue nos commits par-dessus elle. */
      const dep = tg.base_branch || 'main';
      return `<button class="btn btn-sm" data-tgrebase="${tg.id}" data-task="${t.id}" data-branch="${esc(tg.branch || '')}" data-base="${esc(dep)}" title="${esc(tr('task.title.update-base', { base: dep }))}"><svg class="ico ico-sm"><use href="#i-repeat"/></svg>${tr('task.btn.update-base', { base: dep })}</button>`;
    })() : ''}
    ${showPush ? `<button class="btn btn-sm btn-primary" data-tgpush="${tg.id}" data-task="${t.id}" data-project="${esc(tg.project)}" data-branch="${esc(tg.branch || '')}" data-force="${tg.force_push ? '1' : ''}" title="${esc(tg.force_push ? tr('task.title.push-force') : tr('task.btn.push-title'))}"><svg class="ico ico-sm"><use href="#i-upload"/></svg>${tr('task.btn.push')}</button>` : ''}
    ${canMr ? `<button class="btn btn-sm btn-primary" data-tgmr="${tg.id}" data-task="${t.id}" data-project="${esc(tg.project || '')}" data-title="${esc(defaultMrTitle)}" data-branch="${esc(tg.branch || '')}" data-target="${esc(tg.base_branch || '')}" data-forge="${esc(tg.forge || '')}" title="${esc(tr('task.title.open-mr'))}"><svg class="ico ico-sm"><use href="#i-branch"/></svg>${tr('task.btn.create-mr')}</button>` : ''}
    ${mrIid && !tg.mr_merged ? `<button class="btn btn-sm btn-danger" data-tgmerge="${tg.id}" data-task="${t.id}" data-iid="${mrIid}" data-target="${esc(tg.mr_target || tg.base_branch || '')}" data-forge="${esc(tg.forge || '')}" data-project="${esc(tg.project || '')}" title="${esc(tr('task.title.merge-mr'))}"><svg class="ico ico-sm"><use href="#i-merge"/></svg>${tr('task.btn.merge')}</button>` : ''}
    ${tg.last_error ? `<span class="t-err" title="${esc(tg.last_error)}">${svgIco('alert')} ${tr('task.failed')}</span>` : ''}
  </div>${followTarget ? `
  <div class="mr-create followup followup-target" data-followform="tg${tg.id}" hidden>
    <textarea class="followup-text" placeholder="${esc(tr('task.followup.ph-target', { project: tg.project }))}"></textarea>
    ${suiviCapturesHtml()}
    ${tg.has_review ? boutonSuiviReview(t.id, tg.id) : ''}
    ${tg.has_verify_fail ? boutonSuiviVerif(t.id, tg.id) : ''}
    ${/* B3 — LA CONSOLE JENKINS ENTRE DANS LE SUIVI. `CI #42 ✗ · Module not found` : on
          ouvrait Détails, on sélectionnait la console à la souris, on copiait, on ouvrait
          « Envoyer un suivi », on collait, on expliquait. Le bouton fait le même chemin que
          « Reprendre le rapport de vérif », avec le texte que Jenkins a écrit. Le verdict
          reste celui de Jenkins : l'agent ne reçoit que le texte à corriger. */''}
    ${(() => {
    const ci = ciDeLaBranche(tg.branch);
    return ci && ci.statut === 'echec' && !ci.enCours && ['committed', 'pushed', 'error'].includes(tg.status)
      ? `<button class="btn btn-sm" data-followci="${t.id}" data-tgci="${tg.id}" data-job="${esc(ci.path)}" data-build="${ci.number}"
           title="${esc(tr('task.title.followup-ci', { job: ci.path, n: ci.number }))}">${svgIco('bot')}${esc(tr('task.btn.followup-ci'))}</button>`
      : '';
  })()}
    <button class="btn" data-followcancel="tg${tg.id}">${tr('ui.cancel')}</button>
    <button class="btn btn-primary" data-followsubmit="${t.id}" data-followtarget="${tg.id}">${tr('task.btn.run-iteration')}</button>
  </div>` : ''}${tg.status === 'needs_input' && tg.questions && tg.questions.length ? questionsForm(t, tg, `/tasks/${t.id}/targets/${tg.id}/answer`) : ''}`;
}

// Formulaire de réponses aux questions de l'agent (ask → stop → resume). Radio quand
// l'agent a proposé des options (+ « Autre » texte libre), champ texte sinon.
/* Le MÊME formulaire pour les trois saveurs de session — codage, exploration, hors dépôt.
   Seule la route de réponse diffère : elle voyage avec le bouton plutôt que d'être devinée,
   parce qu'une saveur oubliée ici enverrait les réponses au mauvais endroit. */
function questionsForm(t, tg, route) {
  const qs = tg.questions || [];
  const rows = qs.map((q) => {
    const name = `q_${tg.id}_${q.id}`;
    let field;
    if (q.options && q.options.length) {
      const opts = q.options.map((o, i) => `<label class="q-opt"><input type="radio" name="${esc(name)}" value="${esc(o.value)}" ${i === 0 ? '' : ''}/> <span>${esc(o.label)}</span></label>`).join('');
      field = `<div class="q-opts">${opts}
          <label class="q-opt q-other"><input type="radio" name="${esc(name)}" value="__other__" /> <span>${esc(tr('task.questions.other'))}</span>
            <input type="text" class="q-other-text" data-for="${esc(name)}" placeholder="${esc(tr('task.questions.other-ph'))}" /></label>
        </div>`;
    } else {
      field = `<textarea class="q-free" data-name="${esc(name)}" placeholder="${esc(tr('task.questions.free-ph'))}"></textarea>`;
    }
    return `<div class="q-item" data-qid="${esc(q.id)}" data-name="${esc(name)}">
        <div class="q-question">${esc(q.question)}</div>
        ${q.context ? `<div class="q-context muted">${esc(q.context)}</div>` : ''}
        ${field}
      </div>`;
  }).join('');
  return `<div class="questions-box" data-qtask="${t.id}" data-qtarget="${tg.id}" data-qroute="${esc(route)}">
      <div class="q-head"><svg class="ico ico-sm"><use href="#i-info"/></svg> <strong>${esc(tr('task.questions.title', { n: qs.length, count: qs.length }))}</strong></div>
      ${rows}
      <div class="q-actions">
        <button class="btn btn-primary btn-sm" data-qsubmit="${tg.id}" data-task="${t.id}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('task.questions.submit'))}</button>
        ${/* On peut aussi avoir repris la session DANS SON TERMINAL et répondu là-bas : l'agent y a
             poursuivi le travail, et Mergerie n'en sait rien. Sans ce bouton, le projet restait en
             attente pour toujours, et le formulaire proposait de répondre une seconde fois — ce qui
             aurait relancé l'agent sur un travail déjà fait. */''}
        <button class="btn btn-sm" data-qelsewhere="${tg.id}" data-task="${t.id}" title="${esc(tr('task.questions.elsewhere-title'))}">${svgIco('check')}${esc(tr('task.questions.elsewhere'))}</button>
      </div>
    </div>`;
}

// Carte EXPLORATION : pas de diff ni de merge — on lit la réponse.
function exploreCard(t) {
  const canRun = ['new', 'error', 'done'].includes(t.status);
  /* Une exploration tourne dans UNE session pour tous ses dépôts — son répertoire de travail
     est la racine des clones, pas un dépôt en particulier. La commande de reprise vit donc
     au niveau de la SESSION, pas de chaque projet : la répéter sur chaque ligne afficherait
     N fois la même chose. (Un codage, lui, a une session par projet : là elle reste en ligne.) */
  const resume = (t.targets || []).map((x) => x.resume_cmd).find(Boolean) || '';
  return `<div class="card task-row${t.hidden ? ' is-hidden' : ''}" data-task="${t.id}">
    <div style="min-width:0;flex:1">
      ${taskHead(t)}
      ${toggleProjetsHtml('explore', t.id, (t.targets || []).length)}
      <div class="targets"${projetsVisibles('explore', t.id, (t.targets || []).length) ? '' : ' hidden'}>
        ${(t.targets || []).map((tg) => `<div class="target-line">
          <span class="tag ${(TASK_STATUS[tg.status] || {}).cls || ''}">${(TASK_STATUS[tg.status] || {}).label || tg.status}</span>
          <span class="t-name">${esc(tg.project)}</span>
          ${tg.branch ? chipBranche(tg.branch) : `<code>${esc(tr('task.default-branch'))}</code>`}
          ${tg.last_error ? `<span class="t-err" title="${esc(tg.last_error)}">${svgIco('alert')} ${tr('task.failed')}</span>` : ''}
        </div>`).join('')}
      </div>
      ${(() => {
    /* Une exploration pose SES questions une seule fois : ses cibles partagent la même
       session d'agent, donc la même hésitation. Un formulaire par dépôt demanderait trois
       fois la même chose. */
    const att = (t.targets || []).find((tg) => tg.status === 'needs_input' && tg.questions && tg.questions.length);
    return att ? questionsForm(t, att, `/tasks/${t.id}/targets/${att.id}/answer`) : '';
  })()}
      ${suiviBlock(t, '')}
      <div class="mr-create followup" data-followform="${t.id}" hidden>
        <textarea class="followup-text" placeholder="${esc(tr('explore.followup.ph'))}">${esc(t.followup_draft || '')}</textarea>
        ${suiviCapturesHtml()}
        ${autoSuiviCase(t)}
        <button class="btn" data-followcancel="${t.id}">${tr('ui.cancel')}</button>
        <button class="btn" data-followsave="${t.id}">${tr('task.btn.save-followup')}</button>
        ${t.status === 'running' ? '' : `<button class="btn btn-primary" data-followsubmit="${t.id}">${tr('task.btn.ask')}</button>`}
      </div>
    </div>
    ${taskActions([
    t.md_path ? `<button class="btn btn-primary" data-tmd="${t.id}" title="${tr('task.title.view-answer')}"><svg class="ico"><use href="#i-doc"/></svg>${tr('task.btn.view-answer')}</button>` : '',
    canRun ? `<button class="btn" data-trun="${t.id}" title="${t.status === 'new' ? tr('task.title.run-explore') : tr('task.title.rerun-explore')}"><svg class="ico"><use href="#i-play"/></svg>${t.status === 'new' ? tr('local.run-short') : tr('task.btn.rerun')}</button>` : '',
    (t.md_path || t.status === 'running') ? followBtn(t, 'tfollow', 'task.title.follow-up', 'task.btn.follow-up') : '',
    /* B9 — DE LA RÉPONSE AU CODE, SANS RELIRE. On demandait « où est vérifié le jeton » sur
       trois dépôts, la réponse était bonne, et on rouvrait une session de codage à la main :
       mêmes dépôts à re-sélectionner, réponse à recopier, et l'agent relisait tout ce qu'il
       venait de lire. Ce bouton ouvre la modale de codage avec les mêmes projets, la question
       et la réponse en contexte, et la SESSION D'AGENT de l'exploration en reprise. */
    t.md_path ? `<button class="btn" data-tcode="${t.id}" title="${esc(tr('task.title.explore-to-code'))}"><svg class="ico"><use href="#i-bot"/></svg>${esc(tr('task.btn.explore-to-code'))}</button>` : '',
    resumeCmdBtn(resume),
  ], [
    `<button class="btn btn-icon btn-sm" data-tedit="${t.id}" title="${tr('task.title.edit')}"><svg class="ico"><use href="#i-edit"/></svg></button>`,
    `<button class="btn btn-icon btn-sm" data-tcopy="${t.id}" title="${esc(tr('task.title.duplicate'))}"><svg class="ico"><use href="#i-copy"/></svg></button>`,
    shareBtn('task', t),
    hideBtn('task', t),
    // La session d'un collègue ne se supprime pas : on la range, et le bouton disparaît.
    estAMoi(t) ? `<button class="btn btn-icon btn-sm btn-danger" data-tdel="${t.id}" title="${tr('task.title.delete')}"><svg class="ico"><use href="#i-close"/></svg></button>` : '',
  ])}
    ${t.last_error ? errorBox(t.last_error, null, t.id) : ''}
  </div>`;
}

/* Ranger / ressortir : délégué une fois pour les deux listes plutôt que recâblé à chaque
   rendu — le bouton existe sur les trois sous-onglets et le geste est le même partout. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-hide]');
  if (!b) return;
  const SCOPE_ROUTE = { local: 'local-tasks', ask: 'questions' };
  const scope = SCOPE_ROUTE[b.dataset.scope] || 'tasks';
  const hidden = b.dataset.on !== '1';   // on inverse l'état courant
  try {
    await busy(b, () => api(`/${scope}/${b.dataset.hide}/hidden`, { method: 'POST', body: { hidden } }));
    toast(tr(hidden ? 'task.hidden.done' : 'task.hidden.undone'));
    loadTasks();
  } catch (err) { toast(explainError(err.message), true); }
});

/* Partager / ne plus partager : délégué une fois, comme « ranger ». Le serveur fait suivre les
   passes et les pièces jointes — elles n'ont pas de case à elles. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-share]');
  if (!b) return;
  const SCOPE_ROUTE = { local: 'local-tasks', ask: 'questions' };
  const scope = SCOPE_ROUTE[b.dataset.scope] || 'tasks';
  const shared = b.dataset.on !== '1';
  try {
    await busy(b, () => api(`/${scope}/${b.dataset.share}/share`, { method: 'POST', body: { shared: shared ? 1 : 0 } }));
    toast(tr(shared ? 'session.shared' : 'session.unshared'));
    loadTasks();
  } catch (err) { toast(explainError(err.message), true); }
});

function wireTaskActions() {
  const on = (sel, fn) => $$(`#taskList ${sel}`).forEach((b) => b.addEventListener('click', () => fn(b)));

  /* `loadTasks()` sans attendre le prochain sondage : le serveur a déjà soldé l'échec à la mise
     en file, la carte doit cesser d'afficher « erreur » dans la seconde où l'on clique. */
  on('[data-trun]', async (b) => {
    const t2 = allTasks.find((x) => x.id === Number(b.dataset.trun));
    if (!await confirmerRelance(t2 && t2.status !== 'new')) return;
    busy(b, () => avecConfigAgent((accord) => api(`/tasks/${b.dataset.trun}/run`, { method: 'POST', body: accord })))
      .then(() => { toast(tr('toast.session-lancee')); loadTasks(); refreshStatus(); })
      .catch((e) => { if (!e.annule) toast(explainError(e.message), true); });
  });

  on('[data-tfold]', (b) => basculerProjets(b.dataset.tfold));

  on('[data-tpushall]', async (b) => {
    if (!await confirmDialog({ title: tr('confirm.push-all.title'), text: tr('confirm.push-all'), confirmLabel: tr('task.btn.push') })) return;
    busy(b, () => api(`/tasks/${b.dataset.tpushall}/push-all`, { method: 'POST' }))
      .then(() => { toast(tr('toast.push-all-lance')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  });

  /* Création en lot : une seule modale pour les options (squash, suppression de branche), et le
     titre de chaque MR est calculé côté serveur d'après la session — demander dix titres à la
     suite serait précisément la corvée qu'on veut supprimer. */
  on('[data-tmrall]', (b) => {
    const t2 = allTasks.find((x) => x.id === Number(b.dataset.tmrall));
    const cibles = ((t2 && t2.targets) || []).filter((tg) => tg.status === 'pushed' && !(tg.mr_iid || tg.existing_mr_iid));
    if (!cibles.length) return;
    openMrModal({
      url: `/tasks/${b.dataset.tmrall}/mrs`,
      bulk: tr('task.mr-all.intro', { n: cibles.length, count: cibles.length, projects: cibles.map((x) => x.project).join(', ') }),
      forge: cibles[0].forge,
      onDone: (r) => {
        const n = (r.created || []).length; const f = (r.failed || []).length;
        toast(f ? tr('task.mr-all.partial', { n, count: n, f, projects: r.failed.map((x) => x.project).join(', ') })
          : tr('task.mr-all.done', { n, count: n }), !!f);
        loadTasks();
      },
    });
  });

  on('[data-tgrun]', async (b) => {
    const t2 = allTasks.find((x) => x.id === Number(b.dataset.task));
    const tg = ((t2 && t2.targets) || []).find((x) => x.id === Number(b.dataset.tgrun));
    if (!await confirmerRelance(tg && tg.status !== 'new', 'confirm.rerun-target')) return;
    busy(b, () => avecConfigAgent((accord) => api(`/tasks/${b.dataset.task}/run`, { method: 'POST', body: { targets: [Number(b.dataset.tgrun)], ...accord } })))
      .then(() => { toast(tr('toast.projet-lance')); loadTasks(); refreshStatus(); })
      .catch((e) => { if (!e.annule) toast(explainError(e.message), true); });
  });

  on('[data-trunfailed]', (b) => {
    const t2 = allTasks.find((x) => x.id === Number(b.dataset.trunfailed));
    const echecs = ((t2 && t2.targets) || []).filter((tg) => tg.status === 'error').map((tg) => tg.id);
    if (!echecs.length) return;
    busy(b, () => avecConfigAgent((accord) => api(`/tasks/${b.dataset.trunfailed}/run`, { method: 'POST', body: { targets: echecs, ...accord } })))
      .then(() => { toast(tr('toast.session-lancee')); loadTasks(); refreshStatus(); })
      .catch((e) => { if (!e.annule) toast(explainError(e.message), true); });
  });

  on('[data-treconcile]', (b) => busy(b, () => api(`/tasks/${b.dataset.treconcile}/reconcile`, { method: 'POST' }))
    .then(() => { toast(tr('toast.reconcile-lancee')); loadTasks(); refreshStatus(); })
    .catch((e) => toast(explainError(e.message), true)));

  // Converger la session : ouvre la modale (seuil + plafond) ciblée sur cette session.
  on('[data-tconverge]', (b) => openConvergeModal({ type: 'task', id: Number(b.dataset.tconverge), label: b.dataset.label || '' }));

  on('[data-tdel]', async (b) => {
    if (!await confirmDialog({ text: tr('confirm.delete-task'), confirmLabel: tr('ui.delete') })) return;
    supprimerAvecAnnulation({
      element: b.closest('.card'),
      message: tr('toast.session-supprimee'),
      supprimer: () => api(`/tasks/${b.dataset.tdel}`, { method: 'DELETE' }),
      apres: loadTasks,
    });
  });
  on('[data-tedit]', (b) => openTaskEdit(Number(b.dataset.tedit)).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true)));
  on('[data-tcopy]', (b) => dupliquerTask(Number(b.dataset.tcopy)).catch((e) => toast(explainError(e.message), true)));
  on('[data-tmd]', (b) => openTaskMd(Number(b.dataset.tmd)));
  on('[data-tcode]', (b) => coderDepuisExploration(Number(b.dataset.tcode)));
  on('[data-tgjira]', async (b) => {
    /* La confirmation NOMME le ticket : « prévenir Jira » sans dire lequel se clique sans
       réfléchir, et c'est un commentaire chez quelqu'un d'autre. La clé est relue côté
       serveur — celle-ci ne sert qu'à la question. */
    if (!await confirmDialog({
      title: tr('task.btn.notify-jira'),
      text: tr('task.notify-jira.confirm', { key: b.dataset.key || '?', iid: b.dataset.iid }),
      confirmLabel: tr('task.btn.notify-jira'),
    })) return;
    try {
      const r = await busy(b, () => api(`/tasks/${b.dataset.task}/targets/${b.dataset.tgjira}/notify-jira`, { method: 'POST' }));
      toast(tr(r.transitioned ? 'task.notify-jira.done-moved' : 'task.notify-jira.done', { key: r.key }));
    } catch (e) { toast(explainError(e.message), true); }
  });

  // --- actions PAR PROJET (codage) ---
  on('[data-tgdiff]', (b) => openTargetDiff(b.dataset.task, b.dataset.tgdiff));
  on('[data-tgout]', (b) => openTargetOutput(b.dataset.task, b.dataset.tgout));
  on('[data-tgpush]', async (b) => {
    const where = `${b.dataset.project} · ${b.dataset.branch}`;
    /* LE FORÇAGE EST UNE DÉCISION, ET ELLE SE PREND ICI. La case est décochée par défaut ; elle
       n'arrive pré-cochée que dans le cas où l'on SAIT que le push normal sera refusé — la
       branche vient d'être rattrapée, son historique a été réécrit. Le texte le dit alors. */
    const rattrapee = !!b.dataset.force;
    const r = await confirmDialog({
      text: rattrapee
        ? tr('confirm.push-force', { branch: b.dataset.branch, project: b.dataset.project })
        : tr('confirm.push-branch', { branch: b.dataset.branch, project: b.dataset.project }),
      confirmLabel: tr('task.btn.push'),
      danger: false,
      check: { label: tr('confirm.push.force-check'), checked: rattrapee },
    });
    if (!r.ok) return;
    busy(b, () => api(`/tasks/${b.dataset.task}/targets/${b.dataset.tgpush}/push`, { method: 'POST', body: { force: r.checked } }))
      .then(() => { toast(tr('toast.push-lance', { where: where })); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  });
  on('[data-tgmr]', (b) => {
    openMrModal({
      url: `/tasks/${b.dataset.task}/targets/${b.dataset.tgmr}/mr`,
      title: b.dataset.title, source: b.dataset.branch, target: b.dataset.target || '',
      forge: b.dataset.forge, project: b.dataset.project || '',
      onDone: () => loadTasks(),
    });
  });
  on('[data-tgmerge]', (b) => {
    openMergeModal({
      url: `/tasks/${b.dataset.task}/targets/${b.dataset.tgmerge}/merge`,
      label: `!${b.dataset.iid}`, target: b.dataset.target, forge: b.dataset.forge,
      project: b.dataset.project || '',
      // Seul chemin où le rattrapage a un sens : il faut une session pour rejouer la branche.
      check: `/tasks/${b.dataset.task}/targets/${b.dataset.tgmerge}/merge-check`,
      rebase: `/tasks/${b.dataset.task}/targets/${b.dataset.tgmerge}/update-base`,
      onDone: () => loadTasks(),
    });
  });

  // --- itération / question de suivi ---
  on('[data-tfollow]', (b) => {
    const form = $(`#taskList .followup[data-followform="${b.dataset.tfollow}"]`);
    if (form) { form.hidden = false; form.querySelector('.followup-text').focus(); }
  });
  // Correction d'UN projet : même formulaire, restreint à cette cible.
  on('[data-tgfollow]', (b) => {
    const form = $(`#taskList .followup[data-followform="tg${b.dataset.tgfollow}"]`);
    if (form) { form.hidden = false; form.querySelector('.followup-text').focus(); }
  });
  /* Remplir le champ de suivi avec un prompt RENDU PAR LE SERVEUR : rapport de review ou
     rapport de vérification. Lui seul a les fichiers et les verdicts ; le navigateur, non.
     Un seul chemin pour les deux boutons — deux copies auraient fini par ne plus demander
     confirmation du même côté. */
  const remplirSuivi = async (b, { taskAttr, targetAttr, url, label, compteur }) => {
    const idTache = b.dataset[taskAttr];
    const idCible = b.dataset[targetAttr];
    const cle = idCible ? `tg${idCible}` : idTache;
    const champ = $(`#taskList .followup[data-followform="${cle}"] .followup-text`);
    if (!champ) return;
    try {
      const q = idCible ? `?target_id=${idCible}` : '';
      const d = await busy(b, () => api(`/tasks/${idTache}/${url}${q}`));
      /* On ne détruit pas ce qui est écrit sans demander : le champ garde un brouillon
         enregistré, parfois rédigé plusieurs jours plus tôt. */
      if (champ.value.trim() && !await confirmDialog({
        title: tr('confirm.followup-review.title'),
        text: tr('confirm.followup-review.text'),
        confirmLabel: tr(label),
        danger: false,
      })) return;
      champ.value = d.prompt;
      champ.focus();
      champ.dispatchEvent(new Event('input', { bubbles: true }));   // l'autosave doit le voir
      const n = compteur(d);
      toast(tr('toast.followup-review.filled', { n, count: n }));
    } catch (e) { toast(e.message, true); }
  };
  on('[data-followreview]', (b) => remplirSuivi(b, {
    taskAttr: 'followreview', targetAttr: 'followreviewtarget', url: 'review-prompt',
    label: 'task.btn.followup-review', compteur: (d) => d.projets.length,
  }));
  on('[data-followverif]', (b) => remplirSuivi(b, {
    taskAttr: 'followverif', targetAttr: 'followveriftarget', url: 'verify-prompt',
    label: 'task.btn.followup-verify', compteur: (d) => d.verificateurs.length,
  }));
  /* B3 — la console de Jenkins, dans le champ de suivi. Elle n'est pas composée par le
     serveur comme les deux autres : elle ne vient pas de nous, elle vient de Jenkins. On la
     demande à la route qui la sert déjà, on garde les trente dernières lignes utiles — la
     même borne que le panneau de détail — et on écrit un prompt qui DIT d'où ça sort. */
  on('[data-followci]', async (b) => {
    const cle = b.dataset.tgci ? `tg${b.dataset.tgci}` : b.dataset.followci;
    const champ = $(`#taskList .followup[data-followform="${cle}"] .followup-text`);
    if (!champ) return;
    try {
      const d = await busy(b, () => api(`/jenkins/console?path=${encodeURIComponent(b.dataset.job)}&build=${encodeURIComponent(b.dataset.build)}`));
      const lignes = String((d && d.text) || '').split('\n').filter((l) => l.trim()).slice(-30).join('\n');
      if (!lignes) { toast(tr('jenkins.build.tail-empty'), true); return; }
      if (champ.value.trim() && !await confirmDialog({
        title: tr('confirm.followup-review.title'),
        text: tr('confirm.followup-review.text'),
        confirmLabel: tr('task.btn.followup-ci'),
        danger: false,
      })) return;
      champ.value = tr('task.followup-ci.prompt', { job: b.dataset.job, n: b.dataset.build, log: lignes });
      champ.focus();
      champ.dispatchEvent(new Event('input', { bubbles: true }));   // l'autosave doit le voir
      toast(tr('task.followup-ci.filled', { n: b.dataset.build }));
    } catch (e) { toast(explainError(e.message), true); }
  });
  /* LE RATTRAPAGE TOURNE EN TÂCHE DE FOND (l'IA peut devoir trancher des conflits) : le clic ne
     dit que « lancé ». Sans repli, la seule preuve qu'il a réussi — et qu'il FAUT maintenant
     pousser en forçant — était de remarquer, sur une carte qui se redessine toutes les secondes
     et demie, qu'un bouton avait changé de libellé tout seul. On guette donc CE job précis
     jusqu'à sa fin pour le dire — succès ou échec, jamais un silence qui laisserait deviner. */
  async function suivreRattrapage(jobId, branch, base) {
    /* 800 × 1,5 s ≈ 20 min : jusqu'à `REBASE_MAX_PASSES` (5) passes IA sur des conflits, au
       même rythme que le reste de l'écran (« se redessine toutes les secondes et demie »). Passé
       ça, on se tait plutôt que de continuer à interroger un job qu'on n'attend plus — le
       rafraîchissement normal de la carte reste le filet. */
    for (let i = 0; i < 800; i += 1) {
      let d;
      try { d = await api(`/jobs/${jobId}/log?after=0`); } catch { return; }
      if (d.finished_at) {
        if (d.status === 'done') toast(tr('toast.update-base.done', { branch, base }));
        else if (d.status === 'error') toast(explainError(d.message || branch), true);
        refreshStatus(); loadTasks();
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  /* Le rebase RÉÉCRIT l'historique de la branche : on le dit avant, pas après. Le push qui
     suivra devra être forcé, et une branche que d'autres ont pu tirer n'est pas un détail. */
  on('[data-tgrebase]', async (b) => {
    const { branch, base } = b.dataset;
    if (!await confirmDialog({
      title: tr('confirm.update-base.title', { branch, base }),
      text: tr('confirm.update-base.text', { branch, base }),
      confirmLabel: tr('task.btn.update-base', { base }),
      danger: false,
    })) return;
    try {
      const job = await api(`/tasks/${b.dataset.task}/targets/${b.dataset.tgrebase}/update-base`, { method: 'POST' });
      toast(tr('toast.update-base.started', { branch }));
      refreshStatus(); loadTasks();
      if (job && job.id) suivreRattrapage(job.id, branch, base);
    } catch (e) { toast(e.message, true); }
  });
  on('[data-followcancel]', (b) => {
    const form = $(`#taskList .followup[data-followform="${b.dataset.followcancel}"]`);
    if (form) form.hidden = true;
  });
  // Enregistrer le suivi sans l'envoyer — et le rouvrir plus tard pour le corriger.
  on('[data-followsave]', (b) => enregistrerSuivi(b, `/tasks/${b.dataset.followsave}/followup-draft`));
  on('[data-followedit]', (b) => {
    const form = $(`#taskList .followup[data-followform="${b.dataset.followedit}"]`);
    if (form) { form.hidden = false; form.querySelector('.followup-text').focus(); }
  });
  on('[data-unschedule]', (b) => annulerProgrammation(b, `/tasks/${b.dataset.unschedule}/schedule`));
  on('[data-followdrop]', (b) => supprimerSuivi(b, `/tasks/${b.dataset.followdrop}/followup-draft`));
  // Envoi manuel : le corps est vide exprès, le serveur prend le suivi enregistré et l'efface.
  on('[data-followsend]', (b) => envoyerSuivi(b, `/tasks/${b.dataset.followsend}/followup`));
  on('[data-followsubmit]', async (b) => {
    const form = b.closest('.followup');
    const field = form.querySelector('.followup-text');
    const instruction = field.value.trim();
    if (!instruction) return;
    const cible = b.dataset.followtarget;
    const cle = cleFormSuivi(form);
    const images = suiviImages.get(cle) || [];
    try {
      await busy(b, () => api(`/tasks/${b.dataset.followsubmit}/followup`, {
        method: 'POST',
        body: {
          instruction,
          ...(cible ? { targets: [Number(cible)] } : {}),
          ...(images.length ? { files: images } : {}),
        },
      }));
      suiviImages.delete(cle);   // parties avec la demande : elles n'ont plus à traîner
      // La demande est partie : on referme et on vide. Sans ça le formulaire reste ouvert
      // avec son texte, et `captureTaskForms` le ROUVRE au rendu suivant — on croirait
      // que l'envoi a échoué.
      field.value = '';
      form.hidden = true;
      toast(tr('toast.lance')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  });
}

/* RÉPONDRE AUX QUESTIONS DE L'AGENT — délégué au document, et pas à une liste.
   Le même formulaire est rendu à TROIS endroits : la ligne d'un projet de codage et la carte
   d'une exploration (dans `#taskList`), et la ligne d'un dossier hors dépôt (dans `#localList`).
   Câblé sur la première liste seulement, le bouton du hors dépôt ne faisait rien du tout : on
   répondait à tout, on cliquait, et il ne se passait rien — pas même un message d'erreur. La
   route voyage déjà dans `data-qroute`, il n'y avait donc rien à savoir de plus ici. */
/* « J'ai répondu au terminal » : même formulaire, même route, un drapeau de plus. Le serveur ne
   devine rien de ce qui s'est passé dehors — il regarde la branche (sessions de dépôt) ou rend le
   dossier à l'état « fait » (hors dépôt, où l'agent travaille en place). */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-qelsewhere]');
  if (!b) return;
  const box = b.closest('.questions-box');
  if (!await confirmDialog({
    title: tr('task.questions.elsewhere'),
    text: tr('task.questions.elsewhere-confirm'),
    confirmLabel: tr('task.questions.elsewhere'),
  })) return;
  try {
    await busy(b, () => api(box.dataset.qroute, { method: 'POST', body: { elsewhere: true } }));
    box.classList.add('resuming');
    box.innerHTML = `<div class="q-head">${svgIco('check')} <strong>${esc(tr('task.questions.elsewhere-done'))}</strong></div>`;
    toast(tr('task.questions.elsewhere-done'));
    refreshStatus(); loadTasks();
  } catch (err) { toast(explainError(err.message), true); }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-qsubmit]');
  if (!b) return;
  const box = b.closest('.questions-box');
  const answers = {};
  let missing = false;
  $$('.q-item', box).forEach((item) => {
    const qid = item.dataset.qid;
    const name = item.dataset.name;
    const free = $('.q-free', item);
    if (free) { answers[qid] = free.value.trim(); }
    else {
      const picked = box.querySelector(`input[name="${name}"]:checked`);
      if (picked) {
        answers[qid] = picked.value === '__other__'
          ? (item.querySelector('.q-other-text')?.value.trim() || '')
          : picked.value;
      }
    }
    if (!answers[qid]) missing = true;
  });
  if (missing) { toast(tr('task.questions.fill-all'), true); return; }
  try {
    await busy(b, () => api(box.dataset.qroute, { method: 'POST', body: { answers } }));
    // Feedback immédiat : on remplace le formulaire par un état « reprise en cours »
    // sans attendre le prochain rechargement (le projet est déjà passé en running côté serveur).
    box.classList.add('resuming');
    box.innerHTML = `<div class="q-head"><span class="spin"></span> <strong>${esc(tr('task.questions.resuming'))}</strong></div>`;
    toast(tr('task.questions.resumed')); refreshStatus();
  } catch (err) { toast(explainError(err.message), true); }
});

