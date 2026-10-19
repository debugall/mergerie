'use strict';
/* Notes → Période, le PIED de l'écran : le résumé IA (option), les pipelines rouges, les tickets Jira qui ont bougé, ce que Mergerie a fait seul. */
/* Tout ce qui est informatif plutôt qu'une file à vider : rendu en sections repliées sous les
   merge requests, dans la même grammaire. Les helpers portent le préfixe `p` comme dans
   `periode.js` (un seul espace global). */

/* Le résumé IA : du Markdown écrit par un agent, rendu comme un rapport — balisé « non fiable ».
   Le bouton vit dans la barre ; ici, le texte et son état (en cours, en erreur). */
function pResumeHtml(d) {
  const job = d.resume_job;
  const enCours = job && !['done', 'error', 'stopped'].includes(job.status);
  if (!d.resume && !enCours && !(job && job.status === 'error')) return '';
  let corps = '';
  if (enCours) corps = `<div class="notes-periode-building"><span class="spinner"></span> ${esc(tr('notes.periode.resume.running'))}</div>`;
  else if (!d.resume && job && job.status === 'error') corps = `<p class="err">${esc(tr('notes.periode.resume.failed', { message: job.message || '' }))}</p>`;
  else corps = `<div class="notes-periode-resume-texte md-rendu">${mdToHtml(d.resume, IA)}</div>`;
  return `<details class="notes-periode-sec notes-periode-resume" open>
    <summary>${svgIco('bot')}<span>${esc(tr('notes.periode.sec.resume'))}</span>${d.resume_at ? `<span class="notes-periode-n">${esc(tr('notes.periode.resume.at', { when: fmtDate(d.resume_at) }))}</span>` : ''}</summary>
    ${corps}
  </details>`;
}

/* Un pipeline rouge sur une branche surveillée, à la date du retour. */
function pLignePipeline(it) {
  const x = it.extra || {};
  const lien = x.url ? `<a class="btn btn-sm" href="${safeUrl(x.url)}" target="_blank" rel="noopener">${svgIco('external')}</a>` : '';
  return `<div class="notes-periode-item notes-periode-pipeline ${it.seen ? 'seen' : ''}" data-pitem="${it.id}">
    <div class="notes-periode-main"><div class="notes-periode-title"><span class="tag risk">${svgIco('alert')} ${esc(tr('notes.periode.pipeline.red', { branch: x.branche || it.ref }))}</span> ${esc(pProjetDe(PERIODE.data, it.repo_id))}${it.title ? ` · ${esc(it.title)}` : ''}</div>
    <div class="meta">${pQuand(it.at)}</div></div>
    <div class="notes-periode-actions">${lien}${pVuBtn(it)}</div>
  </div>`;
}

/* Jira : les tickets passés d'un état à l'autre, et ceux qui m'ont été affectés pendant. */
function sectionJira(items, partielJira) {
  const corps = items.map((it) => {
    const x = it.extra || {};
    const etiquettes = [
      x.objet === 'assigned' ? `<span class="tag">${esc(tr('notes.periode.jira.assigned'))}</span>` : '',
      x.status_changed ? `<span class="tag ${x.done ? 'done' : ''}">${esc(tr('notes.periode.jira.status', { status: x.status || '' }))}</span>` : (x.status ? `<span class="tag">${esc(x.status)}</span>` : ''),
    ].join(' ');
    const lien = x.url ? `<a class="btn btn-sm" href="${safeUrl(x.url)}" target="_blank" rel="noopener">${svgIco('external')}</a>` : '';
    return `<div class="notes-periode-item ${it.seen ? 'seen' : ''}" data-pitem="${it.id}">
      <div class="notes-periode-main"><div class="notes-periode-title"><code>${esc(it.ref)}</code> ${esc(it.title || '')}</div>
      <div class="meta">${it.author ? `${esc(it.author)} · ` : ''}${x.type ? `${esc(x.type)} · ` : ''}${pQuand(it.at)} ${etiquettes}</div></div>
      <div class="notes-periode-actions">${lien}${pVuBtn(it)}</div>
    </div>`;
  }).join('');
  const avant = partielJira ? `<p class="notes-periode-partiel">${esc(tr('notes.periode.partial-jira', { reason: partielJira }))}</p>` : '';
  if (!items.length && !partielJira) return '';
  if (!items.length) return `<details class="notes-periode-sec notes-periode-jira" open><summary>${svgIco('doc')}<span>${esc(tr('notes.periode.sec.jira', { n: 0, count: 0 }))}</span></summary>${avant}</details>`;
  return pSectionHtml('jira', items, corps, { icon: 'doc', hint: tr('notes.periode.sec.jira.hint'), replie: true, avant });
}

/* Pendant ce temps, Mergerie a… — les passes d'agents planifiés et les vérifications, si le poste tournait. */
function sectionMergerie(items) {
  const corps = items.map((it) => {
    const x = it.extra || {};
    let titre = ''; let meta = ''; let action = '';
    if (x.objet === 'agent') {
      titre = tr('notes.periode.mergerie.agent', { name: it.title || '', n: x.runs || 0, count: x.runs || 0 });
      meta = x.erreurs ? tr('notes.periode.mergerie.agent.errors', { n: x.erreurs, count: x.erreurs }) : '';
      action = `<button type="button" class="btn btn-sm" data-psession="${x.task_id}" data-kind="${esc(x.task_kind || 'explore')}">${esc(tr('notes.periode.btn.open-mr'))}</button>`;
    } else if (x.objet === 'verification') {
      titre = tr('notes.periode.mergerie.verification', { name: it.title || '' });
      meta = x.verdict ? `<span class="tag ${x.rouge ? 'risk' : 'done'}">${esc(tr(`verify.verdict.${x.verdict}`))}</span>` : esc(x.status || '');
      action = `<button type="button" class="btn btn-sm" data-pverif="${x.verification_id}">${esc(tr('notes.periode.btn.report'))}</button>`;
    }
    return `<div class="notes-periode-item ${it.seen ? 'seen' : ''}" data-pitem="${it.id}">
      <div class="notes-periode-main"><div class="notes-periode-title">${esc(titre)}</div><div class="meta">${meta}${meta ? ' · ' : ''}${pQuand(it.at)}</div></div>
      <div class="notes-periode-actions">${action}${pVuBtn(it)}</div>
    </div>`;
  }).join('');
  return pSectionHtml('mergerie', items, corps, { icon: 'bot', hint: tr('notes.periode.sec.mergerie.hint'), replie: true });
}

/* Les gestes propres au pied : le rapport d'une vérification. Les sessions d'agent passent par
   `data-psession`, déjà câblé par `periode.js`. */
function brancherGestesPied(corps) {
  $$('[data-pverif]', corps).forEach((b) => b.addEventListener('click', () => openVerifyReport(Number(b.dataset.pverif))));
}
