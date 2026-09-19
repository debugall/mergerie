'use strict';
/* Palette de commandes (Ctrl/Cmd + K) : les actions, la recherche côté serveur, ouvrir un résultat, une référence tapée seule est une adresse. */
/* ---------- Palette de commandes (Ctrl/Cmd+K) ----------
   On navigue entre sept onglets, une vingtaine de sous-onglets et des centaines de MR toute
   la journée. La palette transforme « où est cette MR déjà » en un réflexe.

   RÈGLE ABSOLUE : une entrée ne contient jamais de logique métier, seulement de quoi cliquer
   un bouton ou appeler une fonction de navigation qui existe déjà. Une palette qui
   réimplémente les actions devient une seconde interface, et elle dérive de la vraie au
   premier renommage. C'est aussi ce qui la rend testable par le contrôle statique des ids. */

const PALETTE_ACTIONS = [
  { key: 'palette.go.reviews', tab: 'review', run: () => $('nav button[data-tab="review"]').click() },
  { key: 'palette.go.to-review', tab: 'review', run: () => { $('nav button[data-tab="review"]').click(); loadSegment('to_review'); } },
  { key: 'palette.go.reviewed', tab: 'review', run: () => { $('nav button[data-tab="review"]').click(); loadSegment('reviewed'); } },
  { key: 'palette.go.done', tab: 'review', run: () => { $('nav button[data-tab="review"]').click(); loadSegment('done'); } },
  { key: 'palette.go.task', tab: 'task', run: () => $('nav button[data-tab="task"]').click() },
  { key: 'palette.go.notes', tab: 'notes', run: () => { navTab('notes'); showNotesSub('today'); } },
  { key: 'palette.go.todos', tab: 'notes', run: () => { navTab('notes'); showNotesSub('todos'); } },
  { key: 'palette.go.pages', tab: 'notes', run: () => { navTab('notes'); showNotesSub('pages'); } },
  { key: 'palette.go.jira', tab: 'jira', run: () => $('nav button[data-tab="jira"]').click() },
  { key: 'palette.go.git', tab: 'git', run: () => $('nav button[data-tab="git"]').click() },
  { key: 'palette.go.docker', tab: 'docker', run: () => $('nav button[data-tab="docker"]').click() },
  { key: 'palette.go.jenkins', tab: 'jenkins', run: () => $('nav button[data-tab="jenkins"]').click() },
  { key: 'palette.go.stats', tab: 'dashboard', run: () => $('nav button[data-tab="dashboard"]').click() },
  { key: 'palette.go.agents', tab: 'agents', run: () => $('nav button[data-tab="agents"]').click() },
  { key: 'palette.go.settings', run: () => $('nav button[data-tab="admin"]').click() },
  { key: 'palette.act.discover', tab: 'review', run: () => { $('nav button[data-tab="review"]').click(); $('#btnDiscover').click(); } },
  { key: 'palette.act.review-all', tab: 'review', run: () => { $('nav button[data-tab="review"]').click(); $('#btnReview').click(); } },
  { key: 'palette.act.new-task', tab: 'task', run: () => { $('nav button[data-tab="task"]').click(); $('#btnNewTask').click(); } },
  { key: 'palette.act.new-todo', run: () => openCapture() },
  { key: 'palette.act.new-page', tab: 'notes', run: () => { navTab('notes'); showNotesSub('pages'); $('#pageNew').click(); } },
  { key: 'palette.act.logs', run: () => showLogPanel() },
  { key: 'palette.act.shortcuts', run: () => openShortcuts() },
];

let paletteItems = [];
// La palette est-elle ouverte SANS requête ? Pilote l'affichage des en-têtes de section.
let paletteVide = true;
let paletteIdx = 0;
let paletteSeq = 0;

/* Les ACTIONS que le client sait faire, envoyées au serveur avec la requête : lui seul
   connaît les liens, les MR et les notes, nous seuls savons ouvrir un onglet ou une modale.
   Les lister côté serveur aurait fait deux endroits à tenir d'accord. */
/* Un menu masqué ne s'ouvre pas non plus par la palette : masquer, c'est dire « je ne me sers
   pas de ça » — proposer quand même l'entrée ouvrirait un écran sans entrée de menu, donc sans
   moyen évident d'y revenir. L'index reste celui de PALETTE_ACTIONS : c'est lui qui exécute. */
const paletteActions = () => PALETTE_ACTIONS
  .map((a, i) => ({ id: `act:${i}`, label: tr(a.key), tab: a.tab }))
  .filter((a) => !a.tab || !navMasque(a.tab))
  .map(({ id, label }) => ({ id, label }));

/* La palette interroge le SERVEUR. Auparavant elle ne fouillait que les objets déjà chargés
   dans l'onglet courant : chercher une MR depuis Docker ne rendait rien, et les liens
   n'existaient nulle part. Une requête par frappe, débouncée, et le résultat le plus récent
   gagne — `paletteSeq` écarte la réponse d'une frappe précédente arrivée en retard. */
async function paletteChercher(q) {
  const seq = ++paletteSeq;
  let d;
  try { d = await api('/launcher', { method: 'POST', body: { q, actions: paletteActions() } }); }
  catch { return; }
  if (seq !== paletteSeq) return;              // une frappe plus récente a déjà répondu
  paletteVide = !String(q || '').trim();
  paletteItems = (d.results || []).map((r) => ({
    label: r.label,
    /* L'ÉTIQUETTE DE TYPE, toujours. Une ligne de merge request n'affichait que son projet :
       à côté d'une action et d'un ticket qui, eux, disent « Action » et « À faire », on ne
       savait pas ce qu'on s'apprêtait à ouvrir. */
    kind: r.detail ? `${r.detail} · ${tr(`palette.group.${r.group}`)}` : tr(`palette.group.${r.group}`),
    group: r.group,
    // Ce qu'il faut pour reconnaître une référence tapée seule, et pour ouvrir le diff.
    iid: r.nav && r.nav.mr_iid ? Number(r.nav.mr_iid) : null,
    mrId: r.nav && r.nav.mr_id ? Number(r.nav.mr_id) : null,
    ref: r.ref || '',
    run: () => ouvrirResultatPalette(r),
  }));
  paletteIdx = 0;
  renderPalette();
}

/* Ouvrir un résultat. Un lien EXTERNE part dans un nouvel onglet ; un objet interne navigue.
   Dans les deux cas on note l'usage — c'est ce qui fait remonter demain ce qu'on ouvre
   aujourd'hui. */
function ouvrirResultatPalette(r) {
  api('/launcher/used', { method: 'POST', body: { kind: r.kind, ref: r.ref } }).catch(() => {});
  if (r.url) { window.open(safeUrl(r.url), '_blank', 'noopener,noreferrer'); return; }
  if (r.action) {
    const i = Number(String(r.action).split(':')[1]);
    const a = PALETTE_ACTIONS[i];
    if (a) a.run();
    return;
  }
  /* UN AGENT : on ouvre sa carte et on clique SON bouton, plutôt que de refaire le geste ici.
     La palette ne sait rien faire que l'écran ne sache déjà faire — c'est ce qui garantit
     qu'elle ne se met pas à diverger de lui. */
  if (r.kind === 'agent' || r.kind === 'agent-investigate') { lancerAgentDepuisPalette(r); return; }
  const n = r.nav || {};
  /* B13/TOP 12 — LES QUATRE GESTES. Chacun ouvre l'écran qui sait le faire et y pose ce qu'on
     vient de désigner ; aucun ne lance quoi que ce soit tout seul — un job Jenkins et une
     commande git se lancent en connaissance de cause, pas au clavier depuis une liste. */
  if (n.verifier_id) { ouvrirVerifBranche(Number(n.verifier_id)); return; }
  if (n.jenkins_path) { navTab('jenkins'); loadJenkins().then(() => openJenkinsJob(n.jenkins_path)); return; }
  if (n.compose) { navTab('docker'); showDockerSub('compose'); return; }
  if (n.git_command) {
    navTab('git'); showGitSub('commands');
    const champ = $('#cmdInput');
    if (champ) { champ.value = n.git_command; champ.dispatchEvent(new Event('input', { bubbles: true })); champ.focus(); }
    return;
  }
  if (n.mr_id) { navMrReport(n.mr_id); return; }
  if (n.ticket) { ouvrirTicketJira(n.ticket); return; }
  if (n.page_id) { navTab('notes'); showNotesSub('pages'); openNotePage(n.page_id); return; }
  if (n.todo_id) { navTab('notes'); showNotesSub('todos'); return; }
  /* Une session : on ouvre Dev IA sur la SAVEUR de cette session, sans quoi on atterrit sur
     le sous-onglet consulté la dernière fois, où elle n'est pas. */
  if (n.task_id) { ouvrirSession(n.task_id, n.task_kind); return; }
  if (n.tab) navTab(n.tab);
}

// Conservé pour les tests hors ligne et l'ouverture instantanée : les actions locales.
function paletteMatches(q) {
  const out = PALETTE_ACTIONS.filter((a) => tr(a.key).toLowerCase().includes(q))
    .map((a) => ({ label: tr(a.key), kind: tr('palette.kind.action'), group: 'nav', run: a.run }));
  if (q.length >= 2) {
    for (const m of [...toReviewRows, ...reportRows]) {
      if (!matchMr(m, q)) continue;
      out.push({
        label: `!${m.iid} — ${m.title || ''}`,
        kind: `${m.project} · ${tr('palette.group.mrs')}`, group: 'mrs',
        run: () => {
          $('nav button[data-tab="review"]').click();
          loadSegment(m.status === 'to_review' ? 'to_review' : (m.status === 'done' ? 'done' : 'reviewed'))
            .then(() => { if (m.status !== 'to_review') openReport(m.id); });
        },
      });
    }
    for (const t2 of allTasks) {
      if (!taskMatches(t2, q, (t2.targets || []).map((x) => x.project))) continue;
      out.push({
        label: (t2.prompt || '').slice(0, 70),
        kind: tr(t2.kind === 'explore' ? 'task.kind.explore.btn' : 'task.kind.code.btn'), group: 'tasks',
        run: () => { $('nav button[data-tab="task"]').click(); $(`[data-kind="${t2.kind === 'explore' ? 'explore' : 'code'}"]`).click(); },
      });
    }
  }
  return out.slice(0, 8);
}

function renderPalette() {
  const box = $('#paletteList');
  if (!paletteItems.length) { box.innerHTML = `<div class="palette-empty muted">${esc(tr('palette.empty'))}</div>`; return; }
  /* À VIDE, ON MONTRE TROIS SECTIONS TITRÉES — Actions, Merge requests, Sessions — plutôt
     qu'une liste plate où l'on ne sait pas de quoi chaque ligne parle. Dès qu'on tape, les
     en-têtes disparaissent : le classement est alors par pertinence, pas par famille. */
  const sections = !paletteVide ? null : (() => {
    const vus = new Set(); const groupes = [];
    paletteItems.forEach((it, i) => {
      if (!vus.has(it.group)) { vus.add(it.group); groupes.push(i); }
    });
    return new Set(groupes);
  })();
  box.innerHTML = paletteItems.map((it, i) => (sections && sections.has(i)
    ? `<div class="palette-head">${esc(tr(`palette.section.${it.group}`))}</div>` : '')
    + `<div class="palette-item${i === paletteIdx ? ' active' : ''}" role="option" data-i="${i}">`
    + `<span class="palette-label">${esc(it.label)}</span><span class="palette-kind muted">${esc(it.kind)}</span></div>`).join('');
  const act = $('#paletteList .palette-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function closePalette() { $('#paletteModal').hidden = true; }
/* Ancre la boîte SOUS le champ de l'en-tête. Repli au centre haut si le déclencheur est
   masqué (écran étroit) : mieux vaut une palette utilisable qu'une palette bien alignée. */
function placerPalette() {
  const box = $('#paletteModal .palette-box');
  const dec = $('#paletteTrigger');
  if (!box) return;
  const large = box.offsetWidth || 560;
  if (!dec || !dec.offsetParent) {
    box.style.left = `${Math.max(8, (window.innerWidth - large) / 2)}px`;
    box.style.top = '64px';
    return;
  }
  const r = dec.getBoundingClientRect();
  // Aligné sur le champ, puis borné à la fenêtre : sur un écran étroit, la boîte est plus
  // large que le déclencheur et déborderait à droite.
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - large - 8))}px`;
  box.style.top = `${r.bottom + 6}px`;
}

function openPalette() {
  const m = $('#paletteModal'); if (!m) return;
  m.hidden = false;
  placerPalette();
  const inp = $('#paletteInput');
  inp.value = ''; paletteIdx = 0;
  // Les actions locales s'affichent TOUT DE SUITE, la réponse du serveur les remplace :
  // une palette qui s'ouvre vide en attendant le réseau se referme avant d'avoir servi.
  paletteItems = paletteMatches('');
  renderPalette();
  inp.focus();
  paletteChercher('');
}
/* Ouvrir le DIFF d'une merge request depuis ailleurs (palette). Il faut d'abord la file qui la
   porte : `openDiffPreview` travaille sur la ligne chargée, pas sur un identifiant. */
async function ouvrirDiffMr(id) {
  navTab('review');
  await loadSegment('to_review');
  let m = (toReviewRows || []).find((x) => x.id === id);
  if (!m) { await loadSegment('reviewed'); m = (reportRows || []).find((x) => x.id === id); }
  if (!m) { await loadSegment('done'); m = (reportRows || []).find((x) => x.id === id); }
  if (m) await openDiffPreview(m);
}

function runPaletteItem(i) {
  const it = paletteItems[i];
  if (!it) return;
  closePalette();
  it.run();
}

let paletteTimer = null;
$('#paletteInput') && $('#paletteInput').addEventListener('input', () => {
  const q = $('#paletteInput').value.trim();
  clearTimeout(paletteTimer);
  // 120 ms : assez pour ne pas interroger à chaque lettre, assez peu pour ne pas se sentir.
  paletteTimer = setTimeout(() => paletteChercher(q), 120);
});
/* UNE RÉFÉRENCE TAPÉE SEULE EST UNE ADRESSE. « !217 » ou « PROJ-1408 » ne se cherchent pas :
   on sait déjà ce qu'on veut. Entrée y va directement, sans attendre que la liste se compose
   ni viser la bonne ligne. On ne saute que si la référence est SANS AMBIGUÏTÉ (une seule
   merge request porte ce numéro) — sinon la liste reste la bonne réponse. */
const RE_REF_MR = /^!?(\d{1,6})$/;
const RE_REF_TICKET = /^[A-Z][A-Z0-9]+-\d+$/i;
function refDirecte(q) {
  const t = String(q || '').trim();
  const mr = t.match(RE_REF_MR);
  if (mr) {
    const iid = Number(mr[1]);
    const cands = paletteItems.filter((it) => it.group === 'mrs' && it.iid === iid);
    return cands.length === 1 ? cands[0] : null;
  }
  if (RE_REF_TICKET.test(t)) {
    const cle = t.toUpperCase();
    const cands = paletteItems.filter((it) => it.group === 'tickets' && String(it.ref || '').toUpperCase() === cle);
    return cands.length === 1 ? cands[0] : null;
  }
  return null;
}
$('#paletteInput') && $('#paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteItems.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const direct = refDirecte($('#paletteInput').value);
    const cible = direct || paletteItems[paletteIdx];
    if (!cible) return;
    /* ⌘/Ctrl + Entrée sur une merge request ouvre le DIFF plutôt que le rapport : quand on
       cherche une MR par son numéro, c'est souvent le code qu'on vient voir. */
    if ((e.metaKey || e.ctrlKey) && cible.group === 'mrs' && cible.mrId) {
      closePalette();
      ouvrirDiffMr(cible.mrId);
      return;
    }
    closePalette();
    cible.run();
  } else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('#paletteList') && $('#paletteList').addEventListener('click', (e) => {
  const it = e.target.closest('.palette-item');
  if (it) runPaletteItem(Number(it.dataset.i));
});
fermerAuFond('#paletteModal', closePalette, { salissable: false });
$('#paletteTrigger') && $('#paletteTrigger').addEventListener('click', () => openPalette());
// Redimensionner la fenêtre déplace le champ : la boîte le suit au lieu de rester en l'air.
window.addEventListener('resize', () => { if (!$('#paletteModal').hidden) placerPalette(); });
