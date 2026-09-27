'use strict';
/* Docker · Logs — tail live multi-container. */
// @expose dlogStop
/* ============ Docker · Logs — tail live multi-container ============
 * Perf : le flux SSE alimente un buffer BORNÉ (raw), les insertions DOM sont GROUPÉES par
 * requestAnimationFrame (pas de reflow par ligne sur des logs en rafale) et le DOM est plafonné.
 * Le filtrage inclure/exclure est CÔTÉ CLIENT (toggle sans relancer le flux) et PERSISTÉ. */
const DLOG = {
  es: null, raw: [], pending: [], raf: 0, autoscroll: true, colors: {},
  containers: [], selected: new Set(), include: [], exclude: [],
  MAX_RAW: 5000, MAX_DOM: 2000, PALETTE: ['#4f9cf9', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#eab308', '#ec4899'],
};
const DLOG_K = { inc: 'aidevtools_docker_log_include', exc: 'aidevtools_docker_log_exclude', tail: 'aidevtools_docker_log_tail', color: 'aidevtools_docker_log_color', sel: 'aidevtools_docker_log_selection' };

/* ---------- Les containers cochés se retiennent, PAR PROJET COMPOSE ----------
   Les filtres inclure / exclure, la couleur et le tail survivaient au rechargement ; la
   sélection, non — et c'est elle qu'on refait à chaque fois : « api + worker + db », les
   mêmes trois containers, tous les matins. On retient par PROJET (et non globalement) parce
   qu'on ne suit pas les mêmes services d'une stack à l'autre. On retient des NOMS, pas des
   identifiants : un `docker compose up` recrée les containers avec de nouveaux ids, et une
   sélection mémorisée par id serait vide au premier redémarrage — c'est-à-dire toujours. */
const dlogSelMemo = () => { try { return JSON.parse(localStorage.getItem(DLOG_K.sel) || '{}'); } catch { return {}; } };
function dlogMemoriserSelection() {
  try {
    const m = dlogSelMemo();
    const parProjet = {};
    for (const c of DLOG.containers) {
      if (!DLOG.selected.has(c.id)) continue;
      const k = c.project || '';
      (parProjet[k] = parProjet[k] || []).push(c.name);
    }
    /* Un projet dont plus rien n'est coché perd son entrée : garder l'ancienne ferait
       revenir demain une sélection qu'on vient de défaire. */
    for (const c of DLOG.containers) { const k = c.project || ''; if (!parProjet[k]) delete m[k]; }
    Object.assign(m, parProjet);
    localStorage.setItem(DLOG_K.sel, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
}
function dlogRestaurerSelection() {
  const m = dlogSelMemo();
  if (!Object.keys(m).length) return;
  for (const c of DLOG.containers) {
    const noms = m[c.project || ''];
    if (noms && noms.includes(c.name)) DLOG.selected.add(c.id);
  }
}
/* Couleurs de l'application dans ses propres lignes : DÉSACTIVÉES par défaut. Le texte nu
   c'est un nœud de texte par ligne ; colorer, c'est un nœud par segment — sur un flux qui
   débite en rafale la différence se voit. Le choix est persisté comme les filtres. */
let dlogColorOn = (() => { try { return localStorage.getItem(DLOG_K.color) === '1'; } catch { return false; } })();

function dlogLoadFilters() {
  const rd = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v.filter((x) => x && x.w) : []; } catch { return []; } };
  DLOG.include = rd(DLOG_K.inc);
  DLOG.exclude = rd(DLOG_K.exc);
  dlogRebuildWords();
}
function dlogSaveFilters() {
  try {
    localStorage.setItem(DLOG_K.inc, JSON.stringify(DLOG.include));
    localStorage.setItem(DLOG_K.exc, JSON.stringify(DLOG.exclude));
  } catch { /* stockage indisponible */ }
}

/* Mots de filtre ACTIFS, préparés une fois pour toutes. `dlogVisible` les recalculait à
   CHAQUE ligne (deux `filter` + deux `map` + un `toLowerCase` par mot), pour un résultat
   qui ne change qu'au clic sur une puce — sur un flux qui débite en rafale, c'était deux
   allocations par ligne pour rien.
   TOUTE modification des filtres doit passer par `dlogFiltersChanged` : c'est le seul
   endroit qui reconstruit ce cache, un tableau modifié ailleurs le laisserait périmé. */
let dlogWords = { inc: [], exc: [] };
function dlogRebuildWords() {
  const actifs = (arr) => arr.filter((x) => x.on !== false).map((x) => x.w.toLowerCase());
  dlogWords = { inc: actifs(DLOG.include), exc: actifs(DLOG.exclude) };
}
function dlogFiltersChanged() {
  dlogSaveFilters(); dlogRebuildWords(); dlogRenderChips(); dlogRerender();
}
// Inclus : OU (la ligne passe si elle contient l'un des mots actifs). Exclus : la ligne
// tombe si elle contient l'un des mots actifs. Insensible à la casse.
/* Texte NU d'une ligne, calculé une fois et gardé sur l'entrée. C'est lui que voient les
   filtres et la recherche : sans ça, un mot coupé en deux par une séquence de couleur
   échapperait à un filtre, et les codes eux-mêmes pourraient matcher par accident. */
function dlogText(entry) {
  if (entry.t == null) entry.t = ANSI.stripAnsi(entry.m || '');
  return entry.t;
}
function dlogVisible(text) {
  const { inc, exc } = dlogWords;
  // Aucun filtre — le cas courant : on sort avant même de minusculer la ligne.
  if (!inc.length && !exc.length) return true;
  const s = String(text).toLowerCase();
  if (inc.length && !inc.some((w) => s.includes(w))) return false;
  return !exc.some((w) => s.includes(w));
}
function dlogColor(id) {
  if (!DLOG.colors[id]) { const n = Object.keys(DLOG.colors).length; DLOG.colors[id] = DLOG.PALETTE[n % DLOG.PALETTE.length]; }
  return DLOG.colors[id];
}
function dlogName(id) { const c = DLOG.containers.find((x) => x.id === id); return c ? c.name : id; }

// Une ligne = un <div> ; on utilise textContent (pas d'innerHTML) : rapide et sûr.
function dlogRowEl(entry) {
  const row = document.createElement('div');
  row.className = entry.sys ? `dlog-row dlog-sys dlog-sys-${entry.sys}` : 'dlog-row';
  const tag = document.createElement('span');
  tag.className = 'dlog-tag';
  tag.style.color = dlogColor(entry.c);
  tag.textContent = dlogName(entry.c);
  const msg = document.createElement('span');
  msg.className = 'dlog-msg';
  if (entry.sys) {
    msg.textContent = entry.sys === 'closed' ? tr('docker.logs.stream-closed') : `⚠ ${dlogText(entry)}`;
  } else if (dlogColorOn) {
    // Un <span> par segment, jamais d'innerHTML : le contenu vient d'un container.
    for (const seg of ANSI.parseAnsi(entry.m || '')) {
      const el = document.createElement('span');
      el.textContent = seg.text;
      const cls = [];
      if (seg.fg != null) cls.push(`ansi-fg-${seg.fg}`, ...(seg.bright ? ['ansi-bright'] : []));
      if (seg.bold) cls.push('ansi-b');
      if (seg.underline) cls.push('ansi-u');
      if (cls.length) el.className = cls.join(' ');
      msg.appendChild(el);
    }
  } else {
    msg.textContent = dlogText(entry);
  }
  row.appendChild(tag); row.appendChild(msg);
  return row;
}
function dlogScheduleFlush() {
  if (DLOG.raf) return;
  DLOG.raf = requestAnimationFrame(() => {
    DLOG.raf = 0;
    const view = $('#dlogView');
    if (!view || !DLOG.pending.length) { DLOG.pending = []; return; }
    const frag = document.createDocumentFragment();
    for (const e of DLOG.pending) frag.appendChild(dlogRowEl(e));
    DLOG.pending = [];
    view.appendChild(frag);
    let over = view.childNodes.length - DLOG.MAX_DOM; // plafond DOM : on retire les plus vieux
    while (over-- > 0 && view.firstChild) view.removeChild(view.firstChild);
    if (DLOG.autoscroll) view.scrollTop = view.scrollHeight;
    dlogStatus();
  });
}
function dlogOnEntry(entry) {
  DLOG.raw.push(entry);
  if (DLOG.raw.length > DLOG.MAX_RAW) DLOG.raw.splice(0, DLOG.raw.length - DLOG.MAX_RAW); // buffer borné
  if (entry.sys || dlogVisible(dlogText(entry))) { DLOG.pending.push(entry); dlogScheduleFlush(); }
}
// Rejoue le buffer à travers les filtres courants (changement inclure/exclure) — sans relancer le flux.
function dlogRerender() {
  const view = $('#dlogView'); if (!view) return;
  const rows = DLOG.raw.filter((e) => e.sys || dlogVisible(dlogText(e)));
  const start = Math.max(0, rows.length - DLOG.MAX_DOM);
  const frag = document.createDocumentFragment();
  for (let i = start; i < rows.length; i += 1) frag.appendChild(dlogRowEl(rows[i]));
  view.textContent = '';
  view.appendChild(frag);
  if (DLOG.autoscroll) view.scrollTop = view.scrollHeight;
  dlogStatus();
}
function dlogStatus() {
  const el = $('#dlogStatus'); if (!el) return;
  const shown = $('#dlogView') ? $('#dlogView').childNodes.length : 0;
  const live = DLOG.es ? tr('docker.logs.live') : tr('docker.logs.stopped');
  el.textContent = tr('docker.logs.status', { live, shown, total: DLOG.raw.length });
}
function dlogRenderPause() {
  const b = $('#dlogPauseLabel'); if (!b) return;
  b.textContent = DLOG.autoscroll ? tr('docker.logs.pause') : tr('docker.logs.resume');
  $('#dlogPause').classList.toggle('active', !DLOG.autoscroll);
}

function dlogChip(kind, x, i) {
  const off = x.on === false;
  return `<span class="dlog-chip${off ? ' off' : ''}" data-k="${kind}" data-i="${i}">`
    + `<button type="button" class="dlog-chip-w" data-tog title="${esc(off ? tr('docker.logs.chip-enable') : tr('docker.logs.chip-mute'))}">${esc(x.w)}</button>`
    + `<button type="button" class="dlog-chip-x" data-del aria-label="${esc(tr('docker.logs.chip-remove'))}">×</button></span>`;
}
function dlogRenderChips() {
  const inc = $('#dlogIncludeChips'); const exc = $('#dlogExcludeChips');
  if (inc) inc.innerHTML = DLOG.include.map((x, i) => dlogChip('inc', x, i)).join('') || `<span class="muted dlog-empty">${esc(tr('docker.logs.no-filter'))}</span>`;
  if (exc) exc.innerHTML = DLOG.exclude.map((x, i) => dlogChip('exc', x, i)).join('') || `<span class="muted dlog-empty">${esc(tr('docker.logs.no-filter'))}</span>`;
}
function dlogAddWord(kind, word) {
  const w = String(word || '').trim(); if (!w) return;
  const arr = kind === 'inc' ? DLOG.include : DLOG.exclude;
  if (arr.some((x) => x.w.toLowerCase() === w.toLowerCase())) return; // pas de doublon
  arr.push({ w, on: true });
  dlogFiltersChanged();
}

function dlogRenderContainers() {
  const box = $('#dlogContainers'); if (!box) return;
  const q = ($('#dlogSearch').value || '').toLowerCase();
  const list = DLOG.containers.filter((c) => !q || c.name.toLowerCase().includes(q)
    || (c.project || '').toLowerCase().includes(q) || (c.image || '').toLowerCase().includes(q));
  if (!list.length) { box.innerHTML = `<p class="muted">${esc(tr('docker.logs.no-container'))}</p>`; return; }
  box.innerHTML = list.map((c) => `<label class="dlog-citem">
      <input type="checkbox" value="${esc(c.id)}"${DLOG.selected.has(c.id) ? ' checked' : ''}/>
      <span class="dlog-dot ${c.running ? 'run' : 'stop'}" title="${esc(c.status || c.state)}"></span>
      ${/* A/Docker 2 — LE NOM SEUL, COPIABLE. Il n'était copiable qu'ENROBÉ dans un
            `docker logs -f` : pour un `docker exec`, un `docker inspect` ou un grep dans un
            journal d'équipe, on le resélectionnait à la souris. */''}
      <button type="button" class="dlog-cname" data-copy-txt="${esc(c.name)}" title="${esc(tr('docker.copy-name'))}">${esc(c.name)}</button>
      ${c.project ? `<span class="dlog-cproj">${esc(c.project)}</span>` : ''}
      ${/* La même commande, au terminal : `docker logs -f` sur CE container. */''}
      <button type="button" class="btn btn-sm btn-ghost" data-copy-cmd="docker logs -f --tail=200 ${esc(c.name)}" title="${esc(tr('docker.copy-cmd'))}" aria-label="${esc(tr('docker.copy-cmd'))}"><svg class="ico ico-sm"><use href="#i-copy"/></svg></button>
    </label>`).join('');
}

async function loadDockerLogs() {
  dlogLoadFilters(); dlogRenderChips(); dlogRenderPause(); dlogStatus();
  try { $('#dlogTail').value = localStorage.getItem(DLOG_K.tail) || '200'; } catch { /* ignore */ }
  const box = $('#dlogContainers'); box.innerHTML = skeleton(1);
  try {
    const { containers } = await api('/docker/containers');
    DLOG.containers = containers || [];
    dlogRestaurerSelection();
    dlogRenderContainers();
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); }
}

function dlogStart() {
  const ids = [...DLOG.selected];
  if (!ids.length) { toast(tr('docker.logs.pick-one'), true); return; }
  dlogStop();
  const tail = Math.max(0, Math.min(10000, parseInt($('#dlogTail').value, 10) || 200));
  try { localStorage.setItem(DLOG_K.tail, String(tail)); } catch { /* ignore */ }
  DLOG.raw = []; DLOG.pending = []; DLOG.colors = {}; $('#dlogView').textContent = '';
  DLOG.autoscroll = true; dlogRenderPause();
  const es = new EventSource(`/api/docker/logs/stream?ids=${encodeURIComponent(ids.join(','))}&tail=${tail}`);
  DLOG.es = es;
  es.onmessage = (ev) => { try { dlogOnEntry(JSON.parse(ev.data)); } catch { /* ligne partielle */ } };
  es.onerror = () => { dlogStatus(); }; // EventSource retente seul ; on ne ferme pas
  $('#dlogStart').disabled = true; $('#dlogStop').disabled = false;
  dlogStatus();
}
function dlogStop() {
  if (DLOG.es) { try { DLOG.es.close(); } catch { /* déjà fermé */ } DLOG.es = null; }
  const a = $('#dlogStart'); const b = $('#dlogStop');
  if (a) a.disabled = false; if (b) b.disabled = true;
  dlogStatus();
}
window.addEventListener('beforeunload', dlogStop);

// ---- Wiring (délégué : le contenu est recréé au fil des rendus) ----
$('#dlogStart') && $('#dlogStart').addEventListener('click', dlogStart);
$('#dlogStop') && $('#dlogStop').addEventListener('click', dlogStop);
$('#dlogSearch') && $('#dlogSearch').addEventListener('input', dlogRenderContainers);
$('#dlogClear') && $('#dlogClear').addEventListener('click', () => { DLOG.raw = []; DLOG.pending = []; $('#dlogView').textContent = ''; dlogStatus(); });
$('#dlogWrap') && $('#dlogWrap').addEventListener('change', (e) => { $('#dlogView').classList.toggle('wrap', e.target.checked); });
/* Basculer les couleurs REJOUE le tampon : les lignes brutes sont conservées, on ne relance
   donc pas le flux et rien n'est perdu — le rendu seul change. */
(() => {
  const cb = $('#dlogColor');
  if (!cb) return;
  cb.checked = dlogColorOn;
  cb.addEventListener('change', () => {
    dlogColorOn = cb.checked;
    try { localStorage.setItem(DLOG_K.color, dlogColorOn ? '1' : '0'); } catch { /* stockage indisponible */ }
    dlogRerender();
  });
})();
$('#dlogPause') && $('#dlogPause').addEventListener('click', () => {
  DLOG.autoscroll = !DLOG.autoscroll;
  if (DLOG.autoscroll) { const v = $('#dlogView'); v.scrollTop = v.scrollHeight; }
  dlogRenderPause();
});
// Défilement manuel : remonter met en pause, revenir en bas réactive (comportement terminal).
$('#dlogView') && $('#dlogView').addEventListener('scroll', () => {
  const v = $('#dlogView');
  const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 40;
  if (atBottom !== DLOG.autoscroll) { DLOG.autoscroll = atBottom; dlogRenderPause(); }
});
$('#dlogContainers') && $('#dlogContainers').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  if (cb.checked) DLOG.selected.add(cb.value); else DLOG.selected.delete(cb.value);
  dlogMemoriserSelection();
});
for (const [kind, form, input] of [['inc', '#dlogIncludeForm', '#dlogIncludeInput'], ['exc', '#dlogExcludeForm', '#dlogExcludeInput']]) {
  const f = $(form);
  if (f) f.addEventListener('submit', (e) => { e.preventDefault(); dlogAddWord(kind, $(input).value); $(input).value = ''; });
}
// Chips : toggle (activer/désactiver le filtre) ou suppression — délégué sur les deux zones.
for (const zone of ['#dlogIncludeChips', '#dlogExcludeChips']) {
  const z = $(zone);
  if (z) z.addEventListener('click', (e) => {
    const chip = e.target.closest('.dlog-chip'); if (!chip) return;
    const kind = chip.dataset.k; const i = Number(chip.dataset.i);
    const arr = kind === 'inc' ? DLOG.include : DLOG.exclude;
    if (!arr[i]) return;
    if (e.target.closest('[data-del]')) arr.splice(i, 1);           // retirer
    else if (e.target.closest('[data-tog]')) arr[i].on = arr[i].on === false; // (dés)activer sans perdre le mot
    else return;
    dlogFiltersChanged();
  });
}

