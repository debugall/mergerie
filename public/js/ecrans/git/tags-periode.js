'use strict';
/* Tags par période : « qu'a-t-on livré ces deux semaines ? ». Deux dates, tous les dépôts actifs,
   un tableau Dépôt · Tag · Date (et heure) · Message — lignes et colonnes masquables — et un bouton qui le COPIE pour Teams.

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

/* Ce que le tableau montre, dans l'ordre : c'est exactement ce que « Copier » copie — moins les lignes
   MASQUÉES. Un tag de test, une rustine qu'on ne veut pas annoncer : la croix au bout de la ligne la
   retire de l'écran et de la copie, sans la perdre — une ligne au-dessus compte les masquées et les
   réaffiche toutes. Le masquage ne survit pas à une nouvelle recherche. */
let tagsPeriodeLignes = [];
let tagsPeriodeMasquees = new Set();   // index dans tagsPeriodeLignes
const tagsPeriodeVisibles = () => tagsPeriodeLignes.filter((_, i) => !tagsPeriodeMasquees.has(i));

/* Les COLONNES se masquent aussi (l'œil barré de l'en-tête) : un tableau pour Teams n'a pas
   toujours besoin du message ni de l'heure. Contrairement aux lignes, le choix SURVIT à une
   nouvelle recherche — c'est une mise en forme, pas une sélection. La dernière colonne visible
   ne se masque pas : il resterait un tableau vide à copier. */
const TAGS_PERIODE_COLONNES = ['repo', 'tag', 'date', 'message'];
let tagsPeriodeColsMasquees = new Set();
const tagsPeriodeColsVisibles = () => TAGS_PERIODE_COLONNES.filter((c) => !tagsPeriodeColsMasquees.has(c));

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

  tagsPeriodeLignes = d.repos.flatMap((r) => r.tags.map((tg) => ({ project: r.project, repo_id: r.repo_id, name: tg.name, date: tg.date, message: tg.message || '', url: tg.url || '' })));
  tagsPeriodeMasquees = new Set();
  const errored = d.repos.filter((r) => r.error);
  const undated = d.repos.reduce((n, r) => n + (r.undated || 0), 0);
  const repos = new Set(tagsPeriodeLignes.map((l) => l.project)).size;
  const bornes = { from: fmtDate(`${d.from}T12:00:00`), to: fmtDate(`${d.to}T12:00:00`) };
  info.textContent = tr('git.tags.period.count', { n: tagsPeriodeLignes.length, count: tagsPeriodeLignes.length, repos, ...bornes });

  let html = tagsPeriodeLignes.length
    ? `<p class="git-tags-actions"><button type="button" class="btn" id="tagsPeriodCopy" title="${esc(tr('git.tags.period.copy-title'))}">${svgIco('copy')}${esc(tr('git.tags.period.copy'))}</button>`
      + `<button type="button" class="btn" id="tagsPeriodVerify" title="${esc(tr('git.tags.period.verify-title'))}">${svgIco('check')}${esc(tr('git.tags.period.verify'))}</button>`
      + `<span id="tagsPeriodHidden" class="muted" hidden></span></p>`
      + '<div class="md-tablewrap"><table class="md-table git-tags-table"><thead><tr>'
      + TAGS_PERIODE_COLONNES.map((c) => `<th data-tags-col="${c}">${esc(tr(`git.tags.period.col.${c}`))}`
        + ` <button type="button" class="btn btn-icon btn-sm git-tags-colhide" data-tags-hide-col="${c}" title="${esc(tr('git.tags.period.hide-col-title'))}" aria-label="${esc(tr('git.tags.period.hide-col-title'))}">${svgIco('eye-off')}</button></th>`).join('')
      + '<th></th></tr></thead><tbody>'
      + tagsPeriodeLignes.map((l, i) => `<tr data-tags-row="${i}"><td data-tags-col="repo">${esc(l.project)}</td>`
        + `<td data-tags-col="tag">${l.url ? `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer"><code>${esc(l.name)}</code> ↗</a>` : `<code>${esc(l.name)}</code>`}</td>`
        + `<td data-tags-col="date" class="muted">${fmtDateHour(l.date)}</td>`
        + `<td data-tags-col="message" class="git-tags-msg" title="${esc(l.message)}">${esc(l.message) || '<span class="muted">—</span>'}</td>`
        + `<td class="git-tags-hide"><button type="button" class="btn btn-icon btn-sm" data-tags-hide="${i}" title="${esc(tr('git.tags.period.hide-title'))}" aria-label="${esc(tr('git.tags.period.hide-title'))}">${svgIco('eye-off')}</button></td></tr>`).join('')
      + '</tbody></table></div>'
    : emptyState({ icon: 'tag', title: tr('git.tags.period.none.title', bornes), text: tr('git.tags.period.none.text') });
  if (undated) html += `<p class="muted" style="margin-top:8px">${esc(tr('git.tags.period.undated', { n: undated, count: undated }))}</p>`;
  if (errored.length) {
    html += `<p class="muted" style="margin-top:8px">${svgIco('alert')} ${esc(tr('git.tags.period.errors', { n: errored.length, count: errored.length }))} : ${errored.map((r) => esc(r.project)).join(', ')}</p>`;
  }
  box.innerHTML = html;
  tagsPeriodeMajMasquees();
  const copier = $('#tagsPeriodCopy');
  if (copier) copier.addEventListener('click', () => tagsPeriodeCopier(copier));
  const verifier = $('#tagsPeriodVerify');
  if (verifier) verifier.addEventListener('click', tagsPeriodeVerifier);
}

/* « Vérifier ces tags » : la question d'après le tableau — « ce qu'on a livré passe-t-il encore ? ».
   Le bouton n'invente pas d'écran : il ouvre « Vérifier une branche » avec les dépôts du tableau
   cochés, chacun en genre TAG sur son tag — les lignes masquées restent dehors, comme pour la copie.
   Un dépôt n'a qu'une ref dans cette modale : avec plusieurs tags visibles, c'est le plus RÉCENT
   qui est proposé (le tableau est trié ainsi par dépôt), et la modale le dit — il se change sur sa
   ligne. */
function tagsPeriodeCibles() {
  const parDepot = new Map();
  for (const l of tagsPeriodeVisibles()) {
    const c = parDepot.get(l.repo_id);
    if (!c) parDepot.set(l.repo_id, { repo_id: l.repo_id, project: l.project, tag: l.name, date: l.date, n: 1 });
    else { c.n += 1; if (Date.parse(l.date) > Date.parse(c.date)) { c.tag = l.name; c.date = l.date; } }
  }
  return [...parDepot.values()];
}
function tagsPeriodeVerifier() {
  const cibles = tagsPeriodeCibles();
  if (!cibles.length) { toast(tr('git.tags.period.verify-none'), true); return; }
  ouvrirVerifBranche(null, { cibles });
}

/* Masquer, c'est cacher la ligne ou la colonne (pas la reconstruire : le tableau reste où il est) et le dire au-dessus. */
function tagsPeriodeMajMasquees() {
  const n = tagsPeriodeMasquees.size;
  const nc = tagsPeriodeColsMasquees.size;
  $$('#tagsPeriodBox tbody tr[data-tags-row]').forEach((tr_) => { tr_.hidden = tagsPeriodeMasquees.has(Number(tr_.dataset.tagsRow)); });
  $$('#tagsPeriodBox [data-tags-col]').forEach((c) => { c.hidden = tagsPeriodeColsMasquees.has(c.dataset.tagsCol); });
  const derniere = tagsPeriodeColsVisibles().length <= 1;
  $$('#tagsPeriodBox [data-tags-hide-col]').forEach((b) => { b.disabled = derniere; });
  const zone = $('#tagsPeriodHidden');
  if (!zone) return;
  const parts = [];
  if (n) parts.push(esc(tr('git.tags.period.hidden', { n, count: n })));
  if (nc) parts.push(esc(tr('git.tags.period.hidden-cols', { n: nc, count: nc, cols: TAGS_PERIODE_COLONNES.filter((c) => tagsPeriodeColsMasquees.has(c)).map((c) => tr(`git.tags.period.col.${c}`)).join(', ') })));
  zone.hidden = !parts.length;
  zone.innerHTML = parts.length ? `${parts.join(' · ')} <button type="button" class="croise-go" id="tagsPeriodShowAll">${esc(tr('git.tags.period.show-all'))}</button>` : '';
}
$('#tagsPeriodBox') && $('#tagsPeriodBox').addEventListener('click', (e) => {
  const h = e.target.closest('[data-tags-hide]');
  if (h) { tagsPeriodeMasquees.add(Number(h.dataset.tagsHide)); tagsPeriodeMajMasquees(); return; }
  const hc = e.target.closest('[data-tags-hide-col]');
  if (hc) { if (tagsPeriodeColsVisibles().length > 1) tagsPeriodeColsMasquees.add(hc.dataset.tagsHideCol); tagsPeriodeMajMasquees(); return; }
  if (e.target.closest('#tagsPeriodShowAll')) { tagsPeriodeMasquees = new Set(); tagsPeriodeColsMasquees = new Set(); tagsPeriodeMajMasquees(); }
});

/* Les deux formes du tableau — les lignes et colonnes visibles seulement. Le HTML est volontairement nu (bordures en ligne, pas de classe) :
   c'est ce que Teams conserve d'un collage ; le texte est tabulé, une ligne par tag, en-tête
   compris. Le libellé du tag porte son lien quand la forge en donne un. */
function tagsPeriodeExport() {
  const cols = tagsPeriodeColsVisibles();
  const colonnes = cols.map((c) => tr(`git.tags.period.col.${c}`));
  const cell = (s) => `<td style="border:1px solid #999;padding:4px 8px">${s}</td>`;
  const propre = (s) => String(s || '').replace(/[\t\r\n]+/g, ' ');
  const enHtml = {
    repo: (l) => esc(l.project),
    tag: (l) => (l.url ? `<a href="${esc(safeUrl(l.url))}">${esc(l.name)}</a>` : esc(l.name)),
    date: (l) => esc(fmtDateHour(l.date)),
    message: (l) => esc(l.message),
  };
  const enTexte = { repo: (l) => l.project, tag: (l) => l.name, date: (l) => fmtDateHour(l.date), message: (l) => propre(l.message) };
  const html = '<table style="border-collapse:collapse"><thead><tr>'
    + colonnes.map((c) => `<th style="border:1px solid #999;padding:4px 8px;text-align:left">${esc(c)}</th>`).join('')
    + '</tr></thead><tbody>'
    + tagsPeriodeVisibles().map((l) => '<tr>' + cols.map((c) => cell(enHtml[c](l))).join('') + '</tr>').join('')
    + '</tbody></table>';
  const text = [colonnes.join('\t'), ...tagsPeriodeVisibles().map((l) => cols.map((c) => enTexte[c](l)).join('\t'))].join('\n');
  return { html, text };
}

async function tagsPeriodeCopier(btn) {
  const { html, text } = tagsPeriodeExport();
  const n = tagsPeriodeVisibles().length;
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
