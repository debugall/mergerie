'use strict';
/* Tags par période : « qu'a-t-on livré ces deux semaines ? ». Deux dates, tous les dépôts actifs,
   un tableau Dépôt · Tag · Date · Message — et un bouton qui le COPIE pour Teams.

   La copie pose DEUX représentations dans le presse-papiers : du HTML (un vrai <table>, que
   Teams, un mail ou Word rendent en tableau) et du texte tabulé (ce qu'un tableur ou un éditeur
   brut reçoit). Sans `ClipboardItem` (navigateur ancien, contexte non sécurisé), on retombe sur
   le texte seul via `copyText`, qui sait lui-même se rabattre sur un Ctrl+C. */

/* Le jour local en AAAA-MM-JJ : `toISOString` seul donnerait la veille après 22 h en France. */
function tagsPeriodeJour(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

function tagsPeriodePoser(jours) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - jours);
  $('#tagsPeriodFrom').value = tagsPeriodeJour(from);
  $('#tagsPeriodTo').value = tagsPeriodeJour(to);
}

/* À l'ouverture du sous-onglet : les 30 derniers jours, une seule fois — une période déjà
   saisie n'est pas écrasée par une simple visite d'un autre sous-onglet. */
function tagsPeriodeInit() {
  if ($('#tagsPeriodFrom') && !$('#tagsPeriodFrom').value) tagsPeriodePoser(30);
}

/* Ce que le tableau montre, dans l'ordre : c'est exactement ce que « Copier » copie. */
let tagsPeriodeLignes = [];

async function tagsPeriodeChercher(e) {
  if (e) e.preventDefault();
  const from = $('#tagsPeriodFrom').value;
  const to = $('#tagsPeriodTo').value;
  if (!from || !to) return;
  const info = $('#tagsPeriodInfo');
  const box = $('#tagsPeriodBox');
  if (from > to) { info.textContent = ''; box.innerHTML = errorBox(tr('git.tags.period.bad-range')); return; }
  info.textContent = tr('git.tags.period.searching');
  box.innerHTML = skeleton(3);
  let d;
  try { d = await busy($('#tagsPeriodGo'), () => api(`/git/tags-period?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)); }
  catch (err) { info.textContent = ''; box.innerHTML = errorBox(err.message); return; }

  tagsPeriodeLignes = d.repos.flatMap((r) => r.tags.map((tg) => ({ project: r.project, name: tg.name, date: tg.date, message: tg.message || '', url: tg.url || '' })));
  const errored = d.repos.filter((r) => r.error);
  const undated = d.repos.reduce((n, r) => n + (r.undated || 0), 0);
  const repos = new Set(tagsPeriodeLignes.map((l) => l.project)).size;
  const bornes = { from: fmtDate(`${d.from}T12:00:00`), to: fmtDate(`${d.to}T12:00:00`) };
  info.textContent = tr('git.tags.period.count', { n: tagsPeriodeLignes.length, count: tagsPeriodeLignes.length, repos, ...bornes });

  let html = tagsPeriodeLignes.length
    ? `<p class="git-tags-actions"><button type="button" class="btn" id="tagsPeriodCopy" title="${esc(tr('git.tags.period.copy-title'))}">${svgIco('copy')}${esc(tr('git.tags.period.copy'))}</button></p>`
      + '<div class="md-tablewrap"><table class="md-table git-tags-table"><thead><tr>'
      + `<th>${esc(tr('git.tags.period.col.repo'))}</th><th>${esc(tr('git.tags.period.col.tag'))}</th><th>${esc(tr('git.tags.period.col.date'))}</th><th>${esc(tr('git.tags.period.col.message'))}</th></tr></thead><tbody>`
      + tagsPeriodeLignes.map((l) => `<tr><td>${esc(l.project)}</td>`
        + `<td>${l.url ? `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer"><code>${esc(l.name)}</code> ↗</a>` : `<code>${esc(l.name)}</code>`}</td>`
        + `<td class="muted">${fmtDate(l.date)}</td>`
        + `<td class="git-tags-msg" title="${esc(l.message)}">${esc(l.message) || '<span class="muted">—</span>'}</td></tr>`).join('')
      + '</tbody></table></div>'
    : emptyState({ icon: 'tag', title: tr('git.tags.period.none.title', bornes), text: tr('git.tags.period.none.text') });
  if (undated) html += `<p class="muted" style="margin-top:8px">${esc(tr('git.tags.period.undated', { n: undated, count: undated }))}</p>`;
  if (errored.length) {
    html += `<p class="muted" style="margin-top:8px">${svgIco('alert')} ${esc(tr('git.tags.period.errors', { n: errored.length, count: errored.length }))} : ${errored.map((r) => esc(r.project)).join(', ')}</p>`;
  }
  box.innerHTML = html;
  const copier = $('#tagsPeriodCopy');
  if (copier) copier.addEventListener('click', () => tagsPeriodeCopier(copier));
}

/* Les deux formes du tableau. Le HTML est volontairement nu (bordures en ligne, pas de classe) :
   c'est ce que Teams conserve d'un collage ; le texte est tabulé, une ligne par tag, en-tête
   compris. Le libellé du tag porte son lien quand la forge en donne un. */
function tagsPeriodeExport() {
  const colonnes = ['repo', 'tag', 'date', 'message'].map((c) => tr(`git.tags.period.col.${c}`));
  const cell = (s) => `<td style="border:1px solid #999;padding:4px 8px">${s}</td>`;
  const html = '<table style="border-collapse:collapse"><thead><tr>'
    + colonnes.map((c) => `<th style="border:1px solid #999;padding:4px 8px;text-align:left">${esc(c)}</th>`).join('')
    + '</tr></thead><tbody>'
    + tagsPeriodeLignes.map((l) => '<tr>'
      + cell(esc(l.project))
      + cell(l.url ? `<a href="${esc(safeUrl(l.url))}">${esc(l.name)}</a>` : esc(l.name))
      + cell(esc(fmtDate(l.date)))
      + cell(esc(l.message)) + '</tr>').join('')
    + '</tbody></table>';
  const propre = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ');
  const text = [colonnes.join('\t'), ...tagsPeriodeLignes.map((l) => [l.project, l.name, fmtDate(l.date), propre(l.message)].join('\t'))].join('\n');
  return { html, text };
}

async function tagsPeriodeCopier(btn) {
  const { html, text } = tagsPeriodeExport();
  const n = tagsPeriodeLignes.length;
  try {
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') throw new Error('texte seul');
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    toast(tr('git.tags.period.copied', { n, count: n }));
  } catch {
    await copyText(text, btn);
  }
}

$('#tagsPeriodForm') && $('#tagsPeriodForm').addEventListener('submit', tagsPeriodeChercher);
$$('[data-tags-preset]').forEach((b) => b.addEventListener('click', () => tagsPeriodePoser(Number(b.dataset.tagsPreset))));
