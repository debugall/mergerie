'use strict';
/* Rapport de vérification, publication du verdict, durée, A24 passages précédents. */
// @expose openVerifyReport
/* ---------- Rapport de vérification ---------- */

let verifyReportId = null;
let verifyReportVu = null;    // le rapport actuellement affiché (pour « Enquêter »)

/* Les échecs à confier à l'enquêteur : ceux imputables aux branches testées, et à défaut ceux
   de la base — une base rouge est justement le cas où l'on ne sait pas d'où ça vient. */
function echecsDuRapport(d) {
  const t2 = (d && d.imputable) || [];
  if (t2.length) return t2;
  return (d && d.base_run && d.base_run.failed) || [];
}

async function openVerifyReport(id) {
  verifyReportId = id;
  $('#verifyModalTitle').textContent = tr('verify.report.title');   // un seul rapport, titre au singulier
  $('#verifyReport').innerHTML = `<p class="muted">${esc(tr('ui.combo.loading'))}</p>`;
  $('#verifyFix').hidden = true;
  fermerBlocCommentaire();
  $('#verifyModal').hidden = false;
  try {
    const d = await api(`/verifications/${id}`);
    verifyReportVu = d;
    $('#verifyReport').innerHTML = verifyReportHtml(d);
    // « Corriger » n'a de sens que si l'échec est imputable aux branches testées.
    $('#verifyFix').hidden = d.verdict !== 'verified_fail';
    /* B9 — « Enquêter » va plus loin que « Corriger » : il vaut aussi quand la BASE est déjà
       rouge (ce n'est pas nous qui avons cassé, mais quelqu'un doit trouver où), et il n'a
       besoin que d'une chose — un échec nommé à se mettre sous la dent. */
    $('#verifyInvestigate').hidden = !(echecsDuRapport(d).length);
    /* Publier n'a de sens que s'il y a une merge request où écrire : une vérification de
       BRANCHE n'en a pas, et proposer un bouton qui échouerait serait pire que rien. */
    $('#verifyComment').hidden = !(d.targets || []).some((c) => c.mr_id);
    renderSuiteApresVerdict(d);
  } catch (e) { $('#verifyReport').innerHTML = errorBox(explainError(e.message)); }
}

/* A/Reviews 3 — CE QU'ON FAIT D'UN VERDICT VERT. On lit « ✓ vérifié », on ferme la fenêtre,
   on retrouve la carte, on ouvre son menu « ⋯ », on clique « Merger ». Les deux gestes qui
   suivent un vert existaient déjà — au même conditionnel exact — mais pas ici. Rien de neuf
   n'est calculé : on retrouve la merge request dans les listes déjà chargées.

   Vert NON PÉRIMÉ seulement : proposer de merger sur un verdict qui ne décrit plus le code
   serait exactement le contraire de ce que la vérification promet. */
function renderSuiteApresVerdict(d) {
  const zone = $('#verifySuite');
  if (!zone) return;
  zone.innerHTML = '';
  if (!d || d.verdict !== 'verified_pass' || d.stale) return;
  const ids = [...new Set((d.targets || []).map((c) => c.mr_id).filter(Boolean))];
  const mrs = toReviewRows.concat(reportRows).filter((m) => ids.includes(m.id) && !m.closed_seen);
  if (!mrs.length) return;
  zone.innerHTML = mrs.slice(0, 3).map((m) => {
    const jobs = (m.jenkins_jobs || []).slice(0, 1).map((j) => `<button type="button" class="btn"
        data-mr-jenkins="${esc(j.path)}" data-param="${esc(j.param || '')}" data-branch="${esc(m.source_branch)}"
        title="${esc(tr('mr.title.jenkins-run'))}">${esc(tr('mr.btn.jenkins-run', { job: j.path }))}</button>`).join('');
    return `<button type="button" class="btn btn-danger" data-merge="${m.id}">${esc(tr('report.btn.merge', { iid: m.iid }))}</button>${jobs}`;
  }).join('');
}

const lireListe = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };

/* ---------- Publication du verdict en commentaire ----------
   Le corps est composé PAR LE SERVEUR, exactement comme la publication automatique le
   composerait : ce qu'on relit doit être ce qui part, sinon relire ne prouve rien. */
function fermerBlocCommentaire() {
  $('#verifyCommentBox').hidden = true;
  $('#verifyCommentSend').hidden = true;
  $('#verifyComment').hidden = true;
  $('#verifyCommentPosted').hidden = true;
  $('#verifyCommentBody').value = '';
}

async function preparerCommentaire(bouton, id) {
  verifyReportId = id;
  try {
    const d = await busy(bouton, () => api(`/verifications/${id}/comment`));
    $('#verifyCommentBody').value = d.body || '';
    $('#verifyCommentWhere').textContent = tr('verify.comment.where', { liste: (d.mrs || []).join(', ') });
    /* DÉJÀ PUBLIÉ : on le dit au lieu de reproposer le bouton comme si de rien n'était — c'est
       ce qui évite de poster deux fois le même verdict sur la merge request de quelqu'un. */
    const dejaPublie = $('#verifyCommentPosted');
    dejaPublie.hidden = !d.posted_at;
    if (d.posted_at) {
      dejaPublie.textContent = tr('verify.comment.already', {
        date: fmtDateTime(d.posted_at), liste: (d.posted_targets || []).join(', '),
      });
    }
    $('#verifyCommentBox').hidden = false;
    $('#verifyComment').hidden = true;
    $('#verifyCommentSend').hidden = false;
    $('#verifyCommentBody').focus();
    $('#verifyCommentBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) { toast(explainError(err.message), true); }
}

// Pied de fenêtre : un seul rapport à l'écran, donc aucun doute sur ce qu'on publie.
$('#verifyComment') && $('#verifyComment').addEventListener('click', (e) => preparerCommentaire(e.currentTarget, verifyReportId));
/* Par BLOC : la fenêtre « résultats » en montre plusieurs. Un bouton unique en pied publierait
   « le » verdict sans dire lequel — chaque vérificateur porte donc le sien. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-vcomment]');
  if (b) preparerCommentaire(b, Number(b.dataset.vcomment));
});

$('#verifyCommentSend') && $('#verifyCommentSend').addEventListener('click', async (e) => {
  const body = $('#verifyCommentBody').value.trim();
  if (!body) { toast(tr('verify.comment.empty'), true); return; }
  const ou = $('#verifyCommentWhere').textContent;
  /* Confirmation qui NOMME la merge request : c'est la règle partout où l'outil écrit chez
     les autres, et c'est le dernier écran avant que d'autres gens le lisent. */
  if (!await confirmDialog({
    title: tr('verify.comment.confirm.title'),
    text: `${ou}\n\n${body.slice(0, 400)}${body.length > 400 ? '…' : ''}`,
    confirmLabel: tr('verify.btn.comment-send'),
  })) return;
  try {
    const d = await busy(e.currentTarget, () => api(`/verifications/${verifyReportId}/comment`, {
      method: 'POST', body: { body },
    }));
    toast(tr('verify.comment.posted', { liste: (d.posted || []).join(', ') }));
    $('#verifyCommentSend').hidden = true;
    const trace = $('#verifyCommentPosted');
    trace.textContent = tr('verify.comment.already', { date: fmtDateTime(d.posted_at), liste: (d.posted || []).join(', ') });
    trace.hidden = false;
    /* On NE VIDE PAS le champ : si la publication a échoué à moitié, ou si l'on veut relire ce
       qu'on vient d'envoyer, le texte doit rester sous les yeux. */
  } catch (err) { toast(explainError(err.message), true); }
});

/* Le déroulé réel des commandes. C'est ce qu'on veut voir en premier sur un vérificateur
   « commandes » : laquelle a cassé, en combien de temps, et ce qu'elle a écrit. */
/* LA DURÉE AU DIXIÈME sous la seconde. `Math.max(1, round(ms/1000))` affichait « 1 s » pour
   tout ce qui durait moins d'une seconde et demie : un `npm run lint` de 120 ms et un test de
   1,4 s se lisaient pareil, alors que c'est exactement là qu'on cherche ce qui coûte. Au-delà
   de dix secondes, le dixième n'apprend plus rien — on revient à l'entier. */
function fmtSecondes(ms) {
  const s2 = Math.max(0, Number(ms) || 0) / 1000;
  return `${s2 < 10 ? Math.round(s2 * 10) / 10 : Math.round(s2)} s`;
}

/* A25 — UNE DURÉE DE TEST se compte en millisecondes : `fmtSecondes(3.2)` rendait « 0 s », ce
   qui est faux et surtout inutile. En dessous de la seconde, on écrit les millisecondes. */
function fmtDuree(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return n < 1000 ? `${Math.round(n * 10) / 10} ms` : fmtSecondes(n);
}

const plusieursDepots = (run) => new Set((run.commands || []).map((c) => c.repo).filter(Boolean)).size > 1;

function commandesHtml(run) {
  if (!run || !(run.commands || []).length) return '';
  const src = {
    tap: tr('verify.report.source.tap'),
    junit: tr('verify.report.source.junit'),
    command: tr('verify.report.source.command'),
    mixte: tr('verify.report.source.mixte'),
  }[run.detail_source];
  return `<h4>${esc(tr('verify.report.commands'))}</h4>
    <ul class="verify-list">${run.commands.map((c) => `<li>
      <span class="tag ${c.code === 0 ? 'verify ok' : 'verify ko'}">${c.code === 0 ? '✓' : `✗ ${c.code}`}</span>
      ${/* Le dépôt n'est affiché que s'il y en a plusieurs : sinon il se répète pour rien. */''}
      ${plusieursDepots(run) && c.repo ? `<strong>${esc(c.repo)}</strong> · ` : ''}<code>${esc(c.command)}</code> <span class="muted">${fmtSecondes(c.duration_ms)}</span>
      ${c.output_tail ? `<pre class="verify-log">${esc(c.output_tail)}</pre>` : ''}
    </li>`).join('')}</ul>
    ${src ? `<p class="muted">${esc(src)}</p>` : ''}
    ${run.detail_partiel ? `<p class="muted">${esc(tr('verify.report.detail-partiel'))}</p>` : ''}
    ${run.incoherence ? `<p class="verify-restore">${svgIco('alert')} ${esc(tr('verify.report.incoherence'))}</p>` : ''}`;
}

/* Ce qui n'était pas là sur la base. Sans nom de test, c'est le renseignement le plus direct
   dont on dispose — et il ne coûte rien, les deux sorties existent déjà. */
function nouveautesHtml(run) {
  if (!run || !(run.new_lines || []).length) return '';
  return `<h4>${esc(tr('verify.report.new-lines'))}</h4>
    <pre class="verify-log">${esc(run.new_lines.join('\n'))}</pre>`;
}

function verifyReportHtml(d) {
  /* A26 — UN TEST QUI A DÉJÀ CLIGNOTÉ se signale à côté de son nom. Rouge ici, vert à un autre
     run sur le MÊME code : ce n'est pas la branche qui l'a cassé, et le savoir tout de suite
     évite la demi-heure passée à chercher ce qu'on aurait fait. */
  const instables = new Map((d.flaky || []).map((f) => [f.test, f]));
  const echec = (f) => {
    const inst = instables.get(f.test);
    return `<li>
    <code>${esc(f.test || '')}</code>${inst ? ` <span class="tag warn" title="${esc(tr('verify.report.flaky-title', { rouge: inst.rouge, runs: inst.runs }))}">${esc(tr('verify.report.flaky'))}</span>` : ''}${f.message ? ` — ${esc(f.message)}` : ''}
    ${f.log_excerpt ? `<pre class="verify-log">${esc(f.log_excerpt)}</pre>` : ''}
  </li>`;
  };
  /* L'IDENTIFIANT RAMÈNE À SA MERGE REQUEST. « !204 » était du texte mort : on lisait qu'un
     test casse sur cette MR sans pouvoir y aller — il fallait retenir le numéro, fermer, et
     la retrouver à la main dans la liste. */
  const cible = (c) => `<li>${esc(c.project || `#${c.repo_id}`)}${c.iid ? (c.mr_id
    ? ` <button type="button" class="lien-mr" data-vmr="${c.mr_id}" title="${esc(tr('verify.report.open-mr', { iid: c.iid }))}">!${esc(c.iid)}</button>`
    : ` !${esc(c.iid)}`) : ''} · <code>${esc(c.branch || '')}</code> @ <code>${esc(String(c.head_sha || '').slice(0, 8))}</code>${c.mode === 'in_place' ? ` <span class="tag warn" title="${esc(c.workdir || '')}">${esc(tr('verify.mode.in-place-short'))}</span>${c.workdir ? ` <code class="muted">${esc(c.workdir)}</code>` : ''}` : ''}</li>`;
  const duree = d.started_at && d.finished_at
    ? tr('verify.report.duration', { s: fmtSecondes(new Date(d.finished_at) - new Date(d.started_at)).replace(' s', '') }) : '';
  /* A23 — LE RAPPORT DIT CE QU'IL SAIT DÉJÀ. Stockés dans le run et jamais rendus : le NOMBRE
     de tests exécutés (un « 3 cassés » sur 2 000 ne se lit pas comme sur 12), le fait que la
     liste des échecs soit TRONQUÉE (on croyait en avoir trois, il y en avait quarante), et le
     détail du run de BASE quand elle était déjà rouge — sans lui, « base déjà rouge » est un
     verdict sans preuve. */
  const tete = d.head_run || {};
  const nTests = tete.total != null ? `<span class="muted">· ${esc(tr('verify.report.total', { n: tete.total, count: tete.total }))}</span>` : '';
  /* A25 — LES CINQ TESTS LES PLUS LENTS. La donnée existait dans la sortie des runners
     (`# time=` de vitest, `duration_ms` de node, l'attribut `time` de JUnit) et était jetée :
     un rapport disait « 214 tests, 3 cassés » sans jamais dire que quatre d'entre eux
     consomment la moitié du temps. Repliée : c'est du confort, pas un verdict. */
  const lents = (tete.slowest || []).length
    ? `<details class="verify-slow"><summary>${esc(tr('verify.report.slowest'))}</summary>
        <ul class="verify-list">${tete.slowest.map((x) => `<li><code>${esc(x.test)}</code> <span class="muted">${esc(fmtDuree(x.ms))}</span></li>`).join('')}</ul>
      </details>` : '';
  const tronque = tete.failed_tronque
    ? `<p class="muted">${svgIco('info')} ${esc(tr('verify.report.truncated', { n: (tete.failed || []).length }))}</p>` : '';
  /* BASE DÉJÀ ROUGE : le rapport n'affichait alors AUCUN nom — ni ceux de la base, ni ceux de
     la tête. On ne sait pas qui a cassé quoi, mais on sait CE QUI est rouge, et c'est ce qu'on
     vient chercher pour décider si ça nous concerne. */
  const baseRouge = d.verdict === 'broken_base' && d.base_run && (d.base_run.failed || []).length
    ? `<h4>${esc(tr('verify.report.base-failed'))}</h4>
       <ul class="verify-list">${d.base_run.failed.map(echec).join('')}</ul>` : '';
  /* B16 — « ce vérificateur est rouge depuis mardi » se note ici, sur l'objet lui-même. La
     todo rouvre CE rapport : sans le lien, elle dirait « une vérification a cassé » et il
     faudrait la retrouver dans la liste. */
  const todoV = addTodoBtn('verification', d.id,
    tr('notes.add-todo.verification', { verifier: d.verifier_name || '' }));
  return `
    <p>${verifyBadge({ ...d, failed_count: (d.imputable || []).length })}
       <strong>${esc(d.verifier_name || '')}</strong>
       ${todoV}
       ${d.lot_name ? `<span class="muted">· ${esc(tr('verify.report.lot', { name: d.lot_name }))}</span>` : ''}
       ${nTests}
       ${duree ? `<span class="muted">· ${esc(duree)}</span>` : ''}</p>
    ${tronque}
    ${lents}
    ${d.restore_error ? `<p class="verify-restore">${svgIco('alert')} ${esc(d.restore_error)}</p>` : ''}
    ${d.stale ? `<p class="muted">${esc(tr('verify.report.stale'))}</p>` : ''}
    ${d.base_run ? '' : `<p class="muted">${esc(tr('verify.report.no-base'))}</p>`}
    <h4>${esc(tr('verify.report.targets'))}</h4>
    <ul class="verify-list">${(d.targets || []).map(cible).join('')}</ul>
    ${/* Le contexte : les dépôts que le vérificateur sait tester mais qui n'étaient pas dans
          le lot. Un vert peut venir de l'un d'eux resté sur une vieille branche — on le dit. */''}
    ${(d.context || []).length ? `<h4>${esc(tr('verify.report.context'))}</h4>
      <ul class="verify-list">${d.context.map((c) => `<li>${c.warn ? `${svgIco('alert')} ` : ''}${esc(c.project)} — ${esc(c.raison || `${c.branche || '?'}${c.dirty ? tr('verify.report.context-dirty') : ''}${c.untracked ? tr('verify.report.context-untracked', { n: c.untracked, count: c.untracked }) : ''}`)}</li>`).join('')}</ul>` : ''}
    ${/* Sur une vérification de BRANCHE, rien n'est « cassé par ces branches » : la branche EST
          la base. Le titre le dit autrement, sinon on accuse un auteur qui n'existe pas. */''}
    ${(d.imputable || []).length ? `<h4>${esc(tr((d.targets || []).some((c) => c.mr_id) ? 'verify.report.failed' : 'verify.report.failed-branch'))}</h4>
      <ul class="verify-list">${d.imputable.map(echec).join('')}</ul>` : ''}
    ${/* DÉJÀ PUBLIÉ : la mention n'apparaissait qu'en ouvrant le bloc de commentaire — donc
          après avoir cliqué « Commenter », c'est-à-dire trop tard pour éviter le doublon. */''}
    ${d.comment_posted_at ? `<p class="muted">${svgIco('check')} ${esc(tr('verify.comment.already', { date: fmtDateTime(d.comment_posted_at), liste: (lireListe(d.comment_targets) || []).join(', ') }))}</p>` : ''}
    ${baseRouge}
    ${commandesHtml(d.head_run)}
    ${nouveautesHtml(d.head_run)}
    ${d.log_excerpt ? `<h4>${esc(tr('verify.report.log'))}</h4><pre class="verify-log">${esc(d.log_excerpt)}</pre>` : ''}`;
}

/* TOUS les résultats d'une merge request, un bloc par vérificateur. Le badge, lui, n'ouvre
   que le dernier verdict rendu : il répond à « ça passe ou non », pas à « qu'est-ce qui a
   tourné ». Chaque bloc rouge garde SON bouton « Corriger » — avec plusieurs rapports, un
   bouton unique en pied de fenêtre ne dirait pas lequel il corrige. */
async function openVerifResultats(mrId) {
  verifyReportId = null;
  $('#verifyFix').hidden = true;
  fermerBlocCommentaire();
  // La fenêtre montre PLUSIEURS vérificateurs : le titre au singulier ferait croire à un seul.
  $('#verifyModalTitle').textContent = tr('verify.results.title');
  $('#verifyReport').innerHTML = `<p class="muted">${esc(tr('ui.combo.loading'))}</p>`;
  $('#verifyModal').hidden = false;
  try {
    const liste = await api(`/mrs/${mrId}/verifications`);
    if (!liste.length) {
      $('#verifyReport').innerHTML = `<p class="muted">${esc(tr('verify.results.none'))}</p>`;
      return;
    }
    $('#verifyReport').innerHTML = liste.map((d) => `<section class="verify-bloc">
      ${verifyReportHtml(d)}
      <div class="verify-hist" data-hist-mr="${mrId}" data-hist-verif="${d.verifier_id || ''}"></div>
      <p>${d.verdict === 'verified_fail' && (d.imputable || []).length
    ? `<button class="btn btn-primary btn-sm" data-vfix="${d.id}"><svg class="ico ico-sm"><use href="#i-bot"/></svg>${tr('verify.btn.fix')}</button> ` : ''}
      <button class="btn btn-sm" data-vcomment="${d.id}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${tr('verify.btn.comment')}</button>
      ${d.comment_posted_at ? `<span class="muted">${esc(tr('verify.comment.already', { date: fmtDateTime(d.comment_posted_at), liste: (lireListe(d.comment_targets) || []).join(', ') }))}</span>` : ''}</p>
    </section>`).join('');
    remplirHistoriqueVerifs(mrId);
  } catch (e) { $('#verifyReport').innerHTML = errorBox(explainError(e.message)); }
}

/* A24 — LES PASSAGES PRÉCÉDENTS, sous le rapport. « C'était déjà rouge avant ? », « les mêmes
   tests ? », « depuis quand ça passe ? » : toutes les lignes sont en base et aucune ne
   s'affichait — chaque lecture ne montrait que le dernier run. La liste dit le verdict, le
   commit testé, et ce qui a CHANGÉ depuis le passage d'avant : c'est ce delta qui fait la
   différence entre « on tourne en rond sur les deux mêmes tests » et « ça avance ». */
async function remplirHistoriqueVerifs(mrId) {
  const boites = $$(`[data-hist-mr="${mrId}"]`);
  if (!boites.length) return;
  let hist;
  try { hist = await api(`/mrs/${mrId}/verifications/history`); } catch { return; }
  for (const box of boites) {
    const vid = box.dataset.histVerif;
    // Le même vérificateur seulement : mêler deux batteries rendrait le delta faux.
    const lignes = hist.filter((h) => String(h.verifier_id || '') === String(vid)).slice(0, 6);
    if (lignes.length < 2) continue;   // un seul passage : il n'y a rien à comparer
    box.innerHTML = `<h4>${esc(tr('verify.hist.title'))}</h4><ul class="verify-list">`
      + lignes.map((h) => {
        const nouveaux = h.nouveaux && h.nouveaux.length
          ? ` <span class="tag stale" title="${esc(h.nouveaux.join('\n'))}">${esc(tr('verify.hist.new', { n: h.nouveaux.length, count: h.nouveaux.length }))}</span>` : '';
        const corriges = h.corriges && h.corriges.length
          ? ` <span class="tag done" title="${esc(h.corriges.join('\n'))}">${esc(tr('verify.hist.fixed', { n: h.corriges.length, count: h.corriges.length }))}</span>` : '';
        return `<li>${verifyBadge({ verdict: h.verdict, failed_count: (h.failed || []).length })}`
          + ` <span class="muted" data-when="${esc(h.finished_at || '')}">${esc(h.finished_at ? fmtDateTime(h.finished_at) : '')}</span>`
          + `${h.head_sha ? ` <code class="muted">${esc(String(h.head_sha).slice(0, 8))}</code>` : ''}`
          + `${nouveaux}${corriges}</li>`;
      }).join('') + '</ul>';
  }
}

/* « Corriger » depuis un bloc : même route que le bouton de pied de fenêtre, mais il sait
   DE QUEL rapport il parle. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-vfix]');
  if (!b) return;
  try {
    await busy(b, () => api(`/verifications/${b.dataset.vfix}/fix`, { method: 'POST' }));
    $('#verifyModal').hidden = true;
    toast(tr('verify.fix.created'));
    const nav = $('nav button[data-tab="task"]');
    if (nav) nav.click();
    const sub = $('#tab-task .subnav [data-kind="code"]');
    if (sub) sub.click();
  } catch (err) { toast(explainError(err.message), true); }
});

/* Le clic sur « !204 » : on ferme, on va dans Reviews, et on ouvre CE rapport. Le stade
   « Reviewées » d'abord — c'est là que vit un rapport, et ouvrir sans changer de stade
   laisserait la colonne de gauche sur une liste où la carte n'apparaît pas. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-vmr]');
  if (!b) return;
  const id = Number(b.dataset.vmr);
  $('#verifyModal').hidden = true;
  const nav = $('nav button[data-tab="review"]');
  if (nav) nav.click();
  const seg = $('[data-seg="reviewed"]');
  if (seg) seg.click();
  try { await openReport(id, { force: true }); } catch (err) { toast(explainError(err.message), true); }
});

$('#verifyClose') && $('#verifyClose').addEventListener('click', () => { $('#verifyModal').hidden = true; });
/* B9 — l'enquête depuis un verdict rouge. On envoie les tests cassés AVEC leur extrait de
   journal : c'est ce qui distingue une demande exploitable (« NullPointer à tel endroit »)
   d'un « des tests échouent » que l'agent devra d'abord aller lire lui-même. */
$('#verifyInvestigate') && $('#verifyInvestigate').addEventListener('click', async () => {
  const d = verifyReportVu;
  if (!d) return;
  const echecs = echecsDuRapport(d).slice(0, 10)
    .map((f) => [f.test, f.message, f.log_excerpt].filter(Boolean).join('\n')).join('\n\n');
  $('#verifyModal').hidden = true;
  await enqueterSurTexte(tr('verify.investigate.prompt', { verifier: d.verifier_name || '', echecs }));
});
$('#verifyFix') && $('#verifyFix').addEventListener('click', async (e) => {
  try {
    const t2 = await busy(e.currentTarget, () => api(`/verifications/${verifyReportId}/fix`, { method: 'POST' }));
    $('#verifyModal').hidden = true;
    toast(tr('verify.fix.created'));
    /* On ouvre le sous-onglet Codage, pas celui qu'on consultait la dernière fois : la
       session qu'on vient de créer est une session de codage, et l'envoyer dans le vide
       (« Exploration », « hors dépôt ») donnerait l'impression que rien ne s'est passé. */
    const sub = $('#tab-task .subnav [data-kind="code"]');
    const nav = $('nav button[data-tab="task"]');
    if (nav) nav.click();
    if (sub) sub.click();
    void t2;
  } catch (err) { toast(explainError(err.message), true); }
});

// Le badge d'une carte ou d'un détail ouvre le rapport : un clic, partout, même geste.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-vreport]');
  if (b) openVerifyReport(Number(b.dataset.vreport));
  const r = e.target.closest && e.target.closest('[data-vresults]');
  if (r) openVerifResultats(Number(r.dataset.vresults));
});

