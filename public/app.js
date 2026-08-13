'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* Traduction. Nommée `tr` et non `t` comme le proposait i18n.md : `t` est déjà
   pris comme variable locale à onze endroits de ce fichier (const t = d.task,
   const t = s.tasks…). Ces locales masqueraient la fonction globale dans les
   fonctions de rendu — exactement celles qu’il faut traduire. */
const tr = (key, params) => I18Nrt.t(key, params);

/* La langue est posée ICI, tout en haut, et pas dans le bloc « Langue » plus bas :
   plusieurs tables de libellés sont construites à l'évaluation du module. Les
   initialiser avant setLang() les figerait en français quel que soit le réglage. */
const LANG_KEY = 'aidevtools_lang';
const readLang = () => { try { return localStorage.getItem(LANG_KEY) || 'fr'; } catch { return 'fr'; } };
I18Nrt.setLang(readLang());

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    cache: 'no-store', // jamais de cache : on veut toujours le contenu à jour
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const o = btn.textContent; btn.textContent = tr('ui.copied'); setTimeout(() => { btn.textContent = o; }, 1500); }
  } catch {
    // clipboard indisponible : on sélectionne le texte pour un copier manuel
    if (btn) { const o = btn.textContent; btn.textContent = 'Ctrl+C'; setTimeout(() => { btn.textContent = o; }, 2000); }
  }
}

// Bouton « copier la commande de reprise » (session de codage/review/hors-dépôt). Le clic est
// géré par délégation ci-dessous : il copie la commande `cd … && claude/copilot …` du terminal.
function resumeCmdBtn(cmd) {
  if (!cmd) return '';
  return `<button class="btn btn-sm btn-ghost resume-cmd-btn" data-resume-cmd="${esc(cmd)}" title="${esc(tr('resume.cmd.title'))}"><svg class="ico ico-sm"><use href="#i-copy"/></svg><span>${esc(tr('resume.cmd.btn'))}</span></button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-resume-cmd]');
  if (b) { e.preventDefault(); copyText(b.dataset.resumeCmd, null); toast(tr('resume.cmd.copied')); }
});

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;
  t.appendChild(span);
  if (isErr) {
    // erreur : reste affichée jusqu'à fermeture manuelle, texte sélectionnable + copier
    const copy = document.createElement('button');
    copy.className = 'toast-btn'; copy.textContent = tr('ui.copy');
    copy.addEventListener('click', () => copyText(msg, copy));
    const close = document.createElement('button');
    close.className = 'toast-btn'; close.innerHTML = svgIco('close');
    close.addEventListener('click', () => t.remove());
    t.appendChild(copy); t.appendChild(close);
  } else {
    setTimeout(() => dismissToast(t), 3500);
  }
  toastHost().appendChild(t);
  return t;
}
// B3 : les toasts s'empilent dans un conteneur au lieu de se superposer au même pixel.
function toastHost() {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  return host;
}
/* ---------- Feedback des actions ----------
   Un bouton qui déclenche un appel réseau doit le montrer : sans ça l'utilisateur
   reclique, ou croit que rien ne s'est passé. */
async function busy(btn, fn) {
  if (!btn) return fn();
  btn.dataset.busy = '1';
  btn.disabled = true;
  try { return await fn(); }
  finally { delete btn.dataset.busy; btn.disabled = false; }
}

// Squelettes de chargement : évite le saut de mise en page et le « chargement… » gris.
const skeleton = (n = 4) => `<div class="sk-wrap">${'<div class="sk"></div>'.repeat(n)}</div>`;

// Toast avec annulation : remplace avantageusement un confirm() sur les actions
// réversibles (l'utilisateur n'est pas interrompu, et peut revenir en arrière).
// Un seul exemplaire de cette fonction : une seconde définition du même nom écraserait
// silencieusement celle-ci (hoisting), et tous les appels partiraient sur l'autre signature.
function toastUndo(msg, onUndo, ms = 6000) {
  const t = document.createElement('div');
  t.className = 'toast';
  const span = document.createElement('span');
  span.className = 'toast-msg'; span.textContent = msg;
  const b = document.createElement('button');
  b.className = 'toast-btn'; b.innerHTML = `${svgIco('reset')} ${esc(tr('ui.undo'))}`;
  const timer = setTimeout(() => dismissToast(t), ms);
  b.addEventListener('click', () => { clearTimeout(timer); dismissToast(t); onUndo(); });
  t.appendChild(span); t.appendChild(b);
  toastHost().appendChild(t);
}

// Favicon dynamique : on suit l'avancement même dans un autre onglet.
let faviconState = '';
// Favicon = marque Mergerie : glyphe de « merge » (deux branches qui convergent, comme #i-merge)
// blanc sur une tuile arrondie. La TUILE porte l'état (bleu au repos, ambre en cours, rouge en erreur),
// le GLYPHE porte l'identité. SVG pur (aucun emoji ni police) → rendu fiable partout, WSL compris.
const FAVICON_TILE = { idle: '#2f6fe0', busy: '#a16207', error: '#c62828' };
/* Le glyphe est le logo du produit (public/images/mergerie-logo.svg) : le même « M » en graphe
   de commits, dessiné en blanc sur la tuile. Le fichier lui-même ne peut pas servir de favicon :
   son encre est sombre et transparente autour, donc invisible sur une barre d'onglets sombre —
   d'où la tuile, qui garantit le contraste ET porte l'état. */
function faviconHref(state) {
  const color = FAVICON_TILE[state] || FAVICON_TILE.idle;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
    + `<rect x="6" y="6" width="88" height="88" rx="22" fill="${color}"/>`
    + `<g transform="translate(14 10) scale(0.72)">`
    + `<path d="M14,84 L14,26 L50,62 L86,26 L86,84" fill="none" stroke="#fff" stroke-width="9"`
    + ` stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="14" cy="26" r="7.5" fill="#fff"/><circle cx="86" cy="26" r="7.5" fill="#fff"/>`
    // vert plus clair que celui du logo sur fond blanc : il doit tenir sur les trois tuiles.
    + `<circle cx="50" cy="62" r="11" fill="#2da44e"/><circle cx="50" cy="62" r="4.5" fill="#fff"/>`
    + `</g></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
function setFavicon(state) {
  if (faviconState === state) return;
  faviconState = state;
  const link = $('#favicon');
  if (link) link.href = faviconHref(state);
}

// Petite icône SVG inline (hérite de currentColor → se teinte selon l'état). Utilisée là où on
// mettait un emoji comme marqueur d'état : fiable sur toutes les plateformes, thème compris.
const svgIco = (name) => `<svg class="ico ico-sm"><use href="#i-${name}"/></svg>`;

// Apparition échelonnée des cartes (plafonnée : sur 80 MR on n'attend pas 2 s).
/* Regroupe les appels rapprochés (frappe au clavier) en un seul : un champ de recherche
   qui reconstruit une liste entière à CHAQUE caractère rame dès que la liste s'allonge. */
function debounce(fn, ms = 120) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* L'animation d'entrée n'appartient qu'à un VRAI chargement de données. Un filtrage ou un
   rafraîchissement réécrivent aussi le DOM, mais ils ne sont pas un événement : les animer
   revenait à faire clignoter la liste à chaque frappe.
   Le drapeau est posé par les fonctions de CHARGEMENT et consommé ici — c'est le seul endroit
   qui sait distinguer « les données sont arrivées » de « on a re-rendu ». */
let listeChargee = false;
function stagger(sel) {
  const nodes = $$(sel);
  nodes.forEach((c, i) => c.style.setProperty('--i', Math.min(i, 10)));
  const list = nodes[0] && nodes[0].parentElement;
  const animer = listeChargee;
  listeChargee = false;
  if (!list) return;
  list.classList.remove('animate-in');
  if (!animer) return;
  void list.offsetWidth;                 // redémarre l'animation même si la classe y était déjà
  list.classList.add('animate-in');
}

/* Écrire dans le DOM seulement si le contenu a VRAIMENT changé. Le rafraîchissement
   automatique et la frappe dans une recherche rejouaient sinon toute la liste — position de
   défilement perdue, menus refermés, cartes qui clignotent. La signature doit décrire tout
   ce qui est AFFICHÉ : si elle en oublie une part, l'écran se fige sur une donnée périmée. */
const domSig = new Map();
/* La ligne d'identité d'une carte (projet · auteur · date) est tronquée à la largeur de la
   carte : sur un chemin de projet long, la fin devient illisible. On pose donc une info-bulle —
   mais UNIQUEMENT quand le texte est réellement coupé. Une bulle qui répète ce qu'on lit déjà
   est du bruit, et elle s'ouvrirait sous la souris à chaque survol d'une carte.
   Le test coûte une lecture de mise en page par ligne : on le fait en un seul passage juste
   après le rendu (donc rarement, cf. renderIfChanged) et au redimensionnement, jamais en boucle. */
function titrerTextesTronques(racine = document) {
  /* Sélecteur RELATIF à la racine : `renderIfChanged` passe la liste elle-même (#toReviewList
     porte la classe `list`), donc chercher `.list .card .meta` ne trouverait rien — il faudrait
     un `.list` DANS la liste. On part donc de `.card`. Les cartes hors liste ne risquent rien :
     seule `.list .card .meta` est tronquée en CSS, ailleurs le texte tient et aucune bulle
     n'est posée. */
  for (const el of racine.querySelectorAll('.card .meta:not(.branches):not(.links)')) {
    if (el.scrollWidth > el.clientWidth + 1) el.title = el.textContent.trim();
    else if (el.title) el.removeAttribute('title');
  }
}
// La troncature dépend de la largeur : ce qui tenait dans une fenêtre large est coupé dans une
// fenêtre étroite, et inversement. On repasse donc à chaque redimensionnement, groupé.
window.addEventListener('resize', debounce(() => titrerTextesTronques(), 200));

function renderIfChanged(el, sig, html) {
  if (domSig.get(el.id) === sig) return false;
  domSig.set(el.id, sig);
  el.innerHTML = html;
  titrerTextesTronques(el);
  // Le repère « ça tourne » vit sur les cartes : un re-rendu l'effacerait jusqu'au
  // prochain sondage de statut. On le repose tout de suite (cf. marquerEnCours).
  if (ciblesEnCours) marquerEnCours(ciblesEnCours);
  return true;
}

function dismissToast(t) {
  t.classList.add('leaving');
  t.addEventListener('animationend', () => t.remove(), { once: true });
  setTimeout(() => t.remove(), 400); // filet si l'animation est désactivée
}

// Délégation : « Répondre » à une discussion (fils inline ou généraux).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cmt-reply-btn');
  if (!btn) return;
  const wrap = btn.closest('.cmt-reply');
  if (wrap.querySelector('.cmt-editor')) { wrap.querySelector('textarea').focus(); return; }
  const disc = btn.dataset.disc; const mr = btn.dataset.mr;
  const inline = !!btn.closest('#fileContent');
  const ed = document.createElement('div');
  ed.className = 'cmt-editor';
  ed.innerHTML = `<textarea placeholder="${tr('cmt.reply.ph')}"></textarea>`
    + `<div class="cmt-actions"><button type="button" class="btn btn-sm cmt-cancel" title="${tr('cmt.cancel.title')}">${tr('ui.cancel')}</button>`
    + `<button type="button" class="btn btn-sm btn-primary cmt-send" title="${tr('cmt.reply.title', { forge: forgeLabel(split.forge) })}">${tr('cmt.reply.btn')}</button></div>`;
  wrap.appendChild(ed);
  btn.hidden = true;
  const ta = ed.querySelector('textarea'); ta.focus();
  ed.querySelector('.cmt-cancel').addEventListener('click', () => { ed.remove(); btn.hidden = false; });
  ed.querySelector('.cmt-send').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    const s = ed.querySelector('.cmt-send'); s.disabled = true;
    try {
      await api(`/mrs/${mr}/discussions/${encodeURIComponent(disc)}/reply`, { method: 'POST', body: { body } });
      toast(tr('toast.reponse-envoyee'));
      if (inline) {
        try { const dd = await api(`/mrs/${mr}/discussions`); split.discussions = dd.discussions || []; } catch { /* ignore */ }
        renderFile();
      } else { loadMrComments(mr); }
    } catch (err) { s.disabled = false; toast(err.message, true); }
  });
});

// Bloc d'erreur persistant, copiable et fermable.
// mrId (optionnel) : si fourni, le ✕ efface aussi l'erreur en base.
// Traduit les erreurs techniques en message actionnable, SANS masquer l'original
// (le message brut reste affiché et copiable — il sert au diagnostic).
const ERROR_HINTS = [
  [/UNABLE_TO_GET_ISSUER_CERT|self.signed|CERT_|DEPTH_ZERO/i, 'err.hint.cert'],
  [/\b401\b|\b403\b|Unauthorized|Forbidden|invalid.token/i, 'err.hint.token'],
  [/ENOENT|command not found|copilot.*introuvable|spawn .* ENOENT/i, 'err.hint.cli'],
  [/timeout|ETIMEDOUT/i, 'err.hint.timeout'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'err.hint.network'],
];
function errorHint(msg) {
  const hit = ERROR_HINTS.find(([re]) => re.test(String(msg || '')));
  return hit ? tr(hit[1]) : null;
}
function explainError(msg) {
  const hint = errorHint(msg);
  return hint ? tr('err.hint.detail', { hint, msg }) : msg;
}

// mrId / taskId : permet d'effacer l'erreur EN BASE (sinon elle revient au refresh).
function errorBox(text, mrId, taskId) {
  const hint = errorHint(text);
  const hintHtml = hint ? `<div class="errhint">${esc(hint)}</div>` : '';
  const clear = mrId ? ` data-clear-mr="${mrId}"` : (taskId ? ` data-clear-task="${taskId}"` : '');
  return `<div class="errbox"><div class="errhead"><span>${svgIco('alert')} ${tr('ui.error')}</span>`
    + `<span class="errbtns"><button class="btn btn-sm errcopy" title="${esc(tr('err.copy-title'))}">${tr('ui.copy')}</button>`
    + `<button class="btn btn-icon btn-sm btn-danger errclear"${clear} title="${esc(tr('err.clear-title'))}"><svg class=\"ico ico-sm\"><use href=\"#i-close\"/></svg></button></span></div>`
    + `${hintHtml}<pre>${esc(text)}</pre></div>`;
}

// Délégation : bouton "copier" de n'importe quel errbox (liste, détail, discover).
document.addEventListener('click', (e) => {
  const b = e.target.closest('.errcopy');
  if (!b) return;
  const pre = b.closest('.errbox').querySelector('pre');
  copyText(pre.textContent, b);
});

// Délégation : bouton "✕" pour fermer un errbox (et effacer en base si MR).
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.errclear');
  if (!b) return;
  const box = b.closest('.errbox');
  const mrId = b.dataset.clearMr;
  const taskId = b.dataset.clearTask;
  const url = mrId ? `/mrs/${mrId}/clear-error` : (taskId ? `/tasks/${taskId}/clear-error` : null);
  if (url) { try { await api(url, { method: 'POST' }); } catch { /* on ferme quand même */ } }
  box.remove();
});

function esc(s) {
  // échappe pour contexte contenu ET attribut (guillemets inclus)
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Lien vers le ticket Jira (si une URL Jira est configurée et une clé détectée).
function ticketLink(url, key) {
  if (!url || !key) return '';
  return ` · <a href="${esc(url)}" target="_blank" title="${esc(tr('mr.link.ticket-title'))}">${svgIco('tag')} ${esc(key)} ↗</a>`;
}

/* Les liens sortants (ticket, forge) ont leur PROPRE ligne. Dans la ligne d'identité, ils
   arrivaient après le projet, l'auteur et la date : celle-ci est tronquée à la largeur de la
   carte, et c'est donc exactement eux qui disparaissaient derrière les points de suspension —
   d'autant plus sûrement que le chemin du projet est long. Sur leur ligne, ils passent à la
   ligne au lieu d'être coupés. Rien n'est rendu quand il n'y a aucun lien : une carte sans
   ticket ne doit pas payer une ligne vide. */
function mrLinks(m) {
  const liens = [];
  if (m.ticket_url && m.ticket_key) {
    liens.push(`<a href="${esc(m.ticket_url)}" target="_blank" title="${esc(tr('mr.link.ticket-title'))}">`
      + `${svgIco('tag')} ${esc(m.ticket_key)} ↗</a>`);
  }
  if (m.web_url) {
    liens.push(`<a href="${esc(m.web_url)}" target="_blank" title="${esc(tr('mr.link.forge-title', { forge: forgeLabel(m.forge) }))}">`
      + `${svgIco('merge')} ${forgeLabel(m.forge)} ↗</a>`);
  }
  return liens.length ? `<div class="meta links">${liens.join('')}</div>` : '';
}

// Date courte lisible (JJ/MM/AAAA) à partir d'un ISO GitLab.
// Séparateur de milliers, partagé par les cartes du tableau de bord.
const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(I18Nrt.currentLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return ''; }
}

/* L'heure seule, à composer avec `fmtDate`. Utile là où l'ORDRE est le sujet : dans un
   classement par fraîcheur, plusieurs dépôts partagent la même journée et le rang paraît
   alors arbitraire — « pourquoi celui-ci est-il devant ? ».
   Distinct de `fmtDateTime`, qui abrège l'année sur deux chiffres : à côté d'une colonne
   qui l'écrit en entier, deux formats de date dans le même écran se remarquent. */
function fmtHour(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString(I18Nrt.currentLocale(), { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// Rendu markdown minimal (titres, gras, code, listes, blockquote, tableaux GFM).
function mdToHtml(md) {
  if (!md) return '<p class="muted">(vide)</p>';
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  let inCode = false;
  const inline = (t) => esc(t)
    // Image embarquée Jira → vignette inline cliquable (URL restreinte à NOTRE proxy = sûr).
    .replace(/!\[([^\]]*)\]\((\/api\/jira\/attachment\/\d+)\)/g, '<img class="jira-inline-img" src="$2" alt="$1" data-jimg="$2" data-jname="$1" loading="lazy" />')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  /* Le `|` d'une cellule est échappé à la source (`\|`) : sans quoi il ouvrirait une colonne
     de plus et décalerait toute la ligne. On coupe donc sur les `|` NON échappés, puis on
     rend le caractère à la cellule. */
  const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const isSep = (line) => { const c = splitRow(line); return c.length > 0 && c.every((x) => /^:?-+:?$/.test(x)); };
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (raw.trim().startsWith('```')) {
      if (inCode) { html += '</pre>'; inCode = false; }
      else { closeList(); html += '<pre>'; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(raw) + '\n'; continue; }

    // Tableau GFM : ligne avec « | » immédiatement suivie d'une ligne séparateur.
    if (raw.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      closeList();
      const headers = splitRow(raw);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'); const r = c.endsWith(':');
        return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      const cellStyle = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      const thead = '<tr>' + headers.map((hh, k) => `<th${cellStyle(k)}>${inline(hh)}</th>`).join('') + '</tr>';
      let body = '';
      let j = i + 2;
      for (; j < lines.length; j++) {
        const r = lines[j];
        if (!r.includes('|') || r.trim() === '') break;
        const cells = splitRow(r);
        body += '<tr>' + headers.map((_, k) => `<td${cellStyle(k)}>${inline(cells[k] || '')}</td>`).join('') + '</tr>';
      }
      const sansEnTete = headers.every((hh) => hh === '');
      html += `<div class="md-tablewrap"><table class="md-table${sansEnTete ? ' md-table-nohead' : ''}">`
        + `<thead>${thead}</thead><tbody>${body}</tbody></table></div>`;
      i = j - 1;
      continue;
    }

    const h = raw.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    if (/^\s*[-*]\s+/.test(raw)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(raw.replace(/^\s*[-*]\s+/, ''))}</li>`; continue; }
    closeList();
    if (raw.trim().startsWith('>')) { html += `<blockquote>${inline(raw.replace(/^\s*>\s?/, ''))}</blockquote>`; continue; }
    if (raw.trim() === '---') { html += '<hr>'; continue; }
    if (raw.trim() === '') { continue; }
    html += `<p>${inline(raw)}</p>`;
  }
  if (inList) html += '</ul>';
  if (inCode) html += '</pre>';
  return html;
}

/* ---------- Onglets ----------
   `[data-tab]` EST LA CONDITION, pas un raccourci d'écriture. Depuis que la navigation vit
   dans une colonne, le bouton de repli est lui aussi un `nav button` — sans ce filtre, le
   replier désactivait tous les onglets, vidait l'écran, et mémorisait « undefined » comme
   dernier onglet : le rechargement suivant n'affichait rien non plus. */
$$('nav button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  $$('nav button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'admin') showAdminSub();
  if (b.dataset.tab === 'task') loadTasks();
  if (b.dataset.tab === 'review') loadSegment();
  if (b.dataset.tab === 'dashboard') loadDashboard();
  if (b.dataset.tab === 'git') loadGit();
  if (b.dataset.tab === 'docker') loadDocker();
  else dlogStop(); // en quittant Docker, on coupe le tail live (et ses process serveur)
  if (b.dataset.tab === 'jira') loadJira();
  if (b.dataset.tab === 'notes') loadNotes();
  if (b.dataset.tab === 'links') loadLinks();
  if (b.dataset.tab === 'jenkins') loadJenkins();
  try { localStorage.setItem('aidevtools_tab', b.dataset.tab); } catch { /* ignore */ }
}));

/* ---------- Réglages : sous-onglets (Git · Dépôts · Merge Request · …) ----------
   Chaque panneau charge ses données à l'ouverture (rien d'inutile au démarrage),
   et le dernier sous-onglet consulté est mémorisé — on revient dans Réglages pour finir ce
   qu'on y faisait. Le repli, lui, est `gitcfg` : rien de mémorisé = installation neuve, et
   sans jeton aucun autre réglage ne sert à quoi que ce soit. C'est déjà là que l'onboarding
   envoie sa première étape. */
// `mr` partage la logique de `config` : ses champs sont rattachés à #configForm (attribut form=),
// donc loadConfig les peuple et le submit les enregistre — un seul /config pour les deux onglets.
const ADMIN_SUBS = { rules: loadRules, repos: loadRepos, notif: renderNotifSettings, config: loadConfig, mr: loadConfig, gitcfg: loadGitConfig, jiracfg: loadConfig, jenkinscfg: loadConfig, verifiers: loadVerifiers, aisession: renderAiSessionSettings };
function showAdminSub(sub) {
  if (!sub) { try { sub = localStorage.getItem('aidevtools_admin_sub') || 'gitcfg'; } catch { sub = 'gitcfg'; } }
  if (!ADMIN_SUBS[sub]) sub = 'gitcfg';
  $$('#tab-admin .subnav [data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  $$('#tab-admin .subtab').forEach((p) => p.classList.toggle('active', p.id === `sub-${sub}`));
  try { localStorage.setItem('aidevtools_admin_sub', sub); } catch { /* ignore */ }
  try { ADMIN_SUBS[sub](); } catch { /* chargement best-effort */ }
}
$$('#tab-admin .subnav [data-sub]').forEach((b) => b.addEventListener('click', () => showAdminSub(b.dataset.sub)));

/* ---------- Réglages → AI sessions : banc d'essai « reprise de session » ---------- */
function renderAiSessionSettings() {
  const btn = $('#aiSessionTest');
  if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.addEventListener('click', runAiSessionTest); }
}
async function runAiSessionTest() {
  const btn = $('#aiSessionTest');
  const box = $('#aiSessionResult');
  $('#aiSessionInfo').textContent = tr('settings.aisession.running');
  box.innerHTML = skeleton(2);
  try {
    const d = await busy(btn, () => api('/ai-sessions/test', { method: 'POST' }));
    box.innerHTML = aiSessionResultHtml(d);
  } catch (e) {
    box.innerHTML = errorBox(e.message);
  } finally {
    $('#aiSessionInfo').textContent = '';
  }
}
function aiSessionResultHtml(d) {
  const verdict = d.recalled
    ? `<div class="ai-verdict ok">${svgIco('check')} ${esc(tr('settings.aisession.ok'))}</div>`
    : `<div class="ai-verdict bad">${svgIco('close')} ${esc(tr('settings.aisession.ko'))}</div>`;
  const flags = [
    d.dryRun ? `<span class="tag">${esc(tr('settings.aisession.dryrun'))}</span>` : '',
    d.sameSession === true ? `<span class="tag done">${esc(tr('settings.aisession.same-session'))}</span>` : '',
    d.sameSession === false ? `<span class="tag stale">${esc(tr('settings.aisession.diff-session'))}</span>` : '',
  ].filter(Boolean).join(' ');
  const pass = (title, prompt, output) => `<div class="ai-pass"><h4>${esc(title)}</h4>
      <div class="ai-prompt"><span class="muted">${esc(tr('settings.aisession.prompt'))}</span> ${esc(prompt)}</div>
      <pre class="ai-output">${esc(output || '—')}</pre></div>`;
  return `${verdict}
    <p class="muted ai-meta">${esc(tr('settings.aisession.meta', { backend: d.backend, marker: d.marker }))} ${flags}</p>
    ${pass(tr('settings.aisession.pass1'), d.prompt1, d.output1)}
    ${pass(tr('settings.aisession.pass2'), d.prompt2, d.output2)}`;
}

/* ---------- Converger : panneau de run + modale de lancement ---------- */
// Bandeau d'état de la dernière boucle de convergence d'une MR.
function convergeBoxHtml(run) {
  if (!run) return '';
  const n = (v) => (v == null ? '—' : `${v}/10`);
  const cls = { converged: 'ok', capped: 'warn', regressed: 'warn', no_change: 'warn', stopped: 'muted', error: 'danger', running: 'run' }[run.status] || 'muted';
  const icon = { converged: 'i-check', capped: 'i-clock', regressed: 'i-reset', no_change: 'i-info', stopped: 'i-stop', error: 'i-close', running: 'i-zap' }[run.status] || 'i-info';
  const label = tr(`converge.status.${run.status}`, { note: n(run.best_note), passes: run.passes_done, threshold: run.threshold });
  const delta = (run.start_note != null && run.best_note != null && run.best_note !== run.start_note)
    ? `<span class="converge-delta">${n(run.start_note)} → ${n(run.best_note)}</span>` : '';
  return `<div class="converge-box converge-${cls}">
      <svg class="ico"><use href="#${icon}"/></svg>
      <div><strong>${tr('converge.title')}</strong> — ${esc(label)} ${delta}</div>
    </div>`;
}

/* ---------- Fermeture d'une modale au clic sur le fond ----------
   Deux gestes se ressemblaient et n'ont rien à voir l'un avec l'autre.

   Un `click` naît sur l'ANCÊTRE COMMUN du mousedown et du mouseup. Sélectionner du texte dans
   un champ et relâcher trois pixels en dehors vise donc le FOND, tout comme tirer la poignée
   de redimensionnement d'un textarea : la modale se fermait — et emportait la saisie — alors
   que personne n'avait cliqué à côté. On exige donc que la pression AIT COMMENCÉ sur le fond.

   Reste le vrai clic à côté. Tant que rien n'a été saisi il ferme, et c'est ce qu'on veut :
   on ouvre une modale, on change d'avis, ça doit rester rapide. Dès qu'il y a une saisie il
   ne l'emporte plus ; la modale bat une fois et rappelle Échap, plutôt qu'une deuxième modale
   par-dessus la première. Le drapeau se lève sur `input`/`change`, qui ne partent QUE d'une
   action humaine : remplir les champs à l'ouverture ne salit donc rien. */
function fermerAuFond(sel, close, { salissable = true } = {}) {
  const modal = $(sel);
  if (!modal) return;
  let depart = null;
  modal.addEventListener('pointerdown', (e) => { depart = e.target; });
  if (salissable) {
    const marquer = (e) => {
      /* Un champ de recherche filtre la vue, il ne se saisit pas : le protéger empêcherait
         de fermer une modale qu'on a seulement parcourue. Le `.cb-search` d'un combo est
         dans ce cas — le choix, lui, atterrit dans l'input caché, qui émet son `change`
         et compte donc bien comme une saisie. */
      const el = e.target;
      if (el.type === 'search' || el.classList.contains('search') || el.classList.contains('cb-search')) return;
      modal.dataset.saisi = '1';
    };
    modal.addEventListener('input', marquer);
    modal.addEventListener('change', marquer);
    // Chaque ouverture repart d'une modale vierge — et chaque fermeture aussi, au cas où
    // elle serait rouverte sans repasser par sa fonction d'ouverture.
    new MutationObserver(() => { delete modal.dataset.saisi; })
      .observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  }
  modal.addEventListener('click', (e) => {
    if (e.target !== modal || depart !== modal) return;
    depart = null;
    if (modal.dataset.saisi) { refuserFermeture(modal); return; }
    close();
  });
}

function refuserFermeture(modal) {
  const boite = modal.querySelector('.modal-box') || modal;
  boite.classList.remove('modal-refus');
  void boite.offsetWidth; // relance l'animation quand on clique deux fois de suite
  boite.classList.add('modal-refus');
  boite.addEventListener('animationend', () => boite.classList.remove('modal-refus'), { once: true });
  toast(tr('ui.modal.protegee'));
}

// Cible de la convergence : soit une MR (rapport), soit une session de dev (du prompt
// à la MR convergée). La même modale sert les deux ; seul l'endpoint et l'avertissement changent.
let convergeTarget = null; // { type: 'mr' | 'task', id }
/* Confirmation générique — remplace les `confirm()` natifs, qui ne suivaient ni le
   thème, ni la langue du navigateur, ni le vocabulaire de l'app, et dont le bouton
   « OK » ne disait jamais CE QU'ON VALIDE. Renvoie une promesse booléenne, donc les
   appelants deviennent `async`.

   `danger` (par défaut) rend l'action de confirmation reconnaissable AU REPOS : une
   suppression ne doit pas ressembler à un bouton neutre. */
let confirmResolve = null;
function confirmDialog({ title, text, detail, confirmLabel, danger = true } = {}) {
  $('#confirmTitle').textContent = title || tr('confirm.default-title');
  $('#confirmText').textContent = text || '';
  const d = $('#confirmDetail');
  d.hidden = !detail;
  d.textContent = detail || '';
  const ok = $('#confirmOk');
  ok.textContent = confirmLabel || tr('confirm.default-ok');
  ok.className = danger ? 'btn btn-danger btn-solid' : 'btn btn-primary';
  $('#confirmModal').hidden = false;
  setTimeout(() => ok.focus(), 0);
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(answer) {
  $('#confirmModal').hidden = true;
  const r = confirmResolve; confirmResolve = null;
  if (r) r(answer);
}
$('#confirmCancel') && $('#confirmCancel').addEventListener('click', () => closeConfirm(false));
$('#confirmOk') && $('#confirmOk').addEventListener('click', () => closeConfirm(true));
fermerAuFond('#confirmModal', () => closeConfirm(false), { salissable: false });

/* ---------- Modales de merge et de création de MR ----------
   Elles remplacent les `confirm()`/`prompt()` natifs : ceux-ci ne permettaient aucune
   option, et une décision irréversible (merge) mérite mieux qu'un « OK / Annuler ».
   Même gabarit que la modale de convergence : titre, intro contextuelle, champs,
   note, puis Annuler + action à droite. */
let mergeCtx = null;

/* `ctx` : { url, label, target, forge, squash, removeSourceBranch, onDone }.
   `squash`/`removeSourceBranch` pré-cochent d'après ce qui avait été choisi à la
   création de la MR (mémorisé côté serveur). */
function openMergeModal(ctx) {
  mergeCtx = ctx;
  $('#mergeModalIntro').textContent = tr('merge.modal.intro', {
    what: ctx.label, target: ctx.target || tr('report.merge.target-fallback'),
  });
  $('#mergeSquash').checked = !!ctx.squash;
  $('#mergeRemoveBranch').checked = !!ctx.removeSourceBranch;
  const note = $('#mergeModalNote');
  note.hidden = false;
  note.querySelector('span').textContent = tr('merge.modal.warn', { forge: forgeLabel(ctx.forge) });
  $('#mergeGo').disabled = false;
  $('#mergeModal').hidden = false;
}
function closeMergeModal() { $('#mergeModal').hidden = true; mergeCtx = null; }
$('#mergeCancel') && $('#mergeCancel').addEventListener('click', closeMergeModal);
fermerAuFond('#mergeModal', closeMergeModal);
$('#mergeGo') && $('#mergeGo').addEventListener('click', async () => {
  const ctx = mergeCtx; if (!ctx) return;
  const b = $('#mergeGo');
  const body = { squash: $('#mergeSquash').checked, removeSourceBranch: $('#mergeRemoveBranch').checked };
  /* Un merge passe par la forge : ça prend une seconde ou deux, et la modale reste à l'écran
     pendant ce temps. Sans indicateur, le bouton paraît n'avoir rien fait — on reclique.
     `busy()` met le compte à rebours ET désactive, et rend la main dans tous les cas. */
  try {
    const r = await busy(b, () => api(ctx.url, { method: 'POST', body }));
    closeMergeModal();
    toast(r.merged ? tr('toast.mr-merged-ok') : tr('toast.merge-requested'));
    if (ctx.onDone) await ctx.onDone(r);
  } catch (e) { toast(explainError(e.message), true); }
});

let mrCtx = null;
/* `ctx` : { url, body, title, source, target, forge, onDone }. Les deux options sont
   proposées ici aussi : GitLab les retient dès la création ; pour GitHub, dont l'API
   de création ne les accepte pas, elles sont mémorisées et appliquées au merge — la
   note de la modale le dit explicitement. */
function openMrModal(ctx) {
  mrCtx = ctx;
  /* Mode « lot » : mêmes options, mais pas de champ titre — chaque MR reprend le message de
     commit de la session. Demander dix titres à la suite serait la corvée qu'on veut supprimer. */
  const enLot = !!ctx.bulk;
  $('#mrModalIntro').textContent = enLot ? ctx.bulk : tr('mr.modal.intro', { source: ctx.source, target: ctx.target });
  const champ = $('#mrTitle').closest('label') || $('#mrTitle');
  champ.hidden = enLot;
  $('#mrTitle').value = ctx.title || ctx.source || '';
  $('#mrSquash').checked = false;
  $('#mrRemoveBranch').checked = false;
  const note = $('#mrModalNote');
  const isGithub = forgeLabel(ctx.forge) === 'GitHub';
  note.hidden = !isGithub;
  if (isGithub) note.querySelector('span').textContent = tr('mr.modal.github-note');
  $('#mrGo').disabled = false;
  $('#mrModal').hidden = false;
  if (!enLot) setTimeout(() => { const f = $('#mrTitle'); if (f) { f.focus(); f.select(); } }, 0);
}
function closeMrModal() { $('#mrModal').hidden = true; mrCtx = null; }
$('#mrCancel') && $('#mrCancel').addEventListener('click', closeMrModal);
fermerAuFond('#mrModal', closeMrModal);
$('#mrGo') && $('#mrGo').addEventListener('click', async () => {
  const ctx = mrCtx; if (!ctx) return;
  const title = $('#mrTitle').value.trim();
  if (!ctx.bulk && !title) { $('#mrTitle').focus(); return; }
  const b = $('#mrGo');
  const body = { ...(ctx.body || {}), ...(ctx.bulk ? {} : { title }),
    squash: $('#mrSquash').checked, removeSourceBranch: $('#mrRemoveBranch').checked };
  // Même raison qu'au merge : l'appel part vers la forge et la modale reste affichée.
  try {
    const r = await busy(b, () => api(ctx.url, { method: 'POST', body }));
    closeMrModal();
    toast(tr('toast.mr-creee', { iid: r.iid }));
    if (ctx.onDone) await ctx.onDone(r);
  } catch (e) { toast(explainError(e.message), true); }
});

async function openConvergeModal(target) {
  convergeTarget = target;
  // Le bouton est grisé pendant le lancement et n'est réarmé que par le catch : sans
  // ce reset, la 2e convergence d'affilée trouverait un bouton inerte.
  const start = $('#convStart'); if (start) start.disabled = false;
  // Pré-remplit avec les réglages par défaut (surchargeables ici).
  try {
    const c = await api('/config');
    $('#convThreshold').value = c.converge_threshold || '8';
    $('#convPasses').value = c.converge_max_passes || '3';
  } catch { $('#convThreshold').value = '8'; $('#convPasses').value = '3'; }
  /* Titre et phrase d'accroche selon la CIBLE : depuis une session, l'IA va d'abord
     coder et ouvrir la MR — annoncer « Converger la MR » y serait faux. */
  const isTask = target.type === 'task';
  $('#convergeModalTitle').textContent = tr(isTask ? 'converge.modal.title-task' : 'converge.modal.title');
  const what = $('#convergeModalWhat');
  what.textContent = target.label ? tr(isTask ? 'converge.modal.what-task' : 'converge.modal.what', { what: target.label }) : '';
  what.hidden = !target.label;
  // Note spécifique session : l'IA va AUSSI coder et ouvrir la MR.
  const note = $('#convSessionNote'); if (note) note.hidden = !isTask;
  $('#convergeModal').hidden = false;
}
function closeConvergeModal() { $('#convergeModal').hidden = true; convergeTarget = null; }
$('#convCancel') && $('#convCancel').addEventListener('click', closeConvergeModal);
fermerAuFond('#convergeModal', closeConvergeModal);
$('#convStart') && $('#convStart').addEventListener('click', async () => {
  const tgt = convergeTarget; if (!tgt) return;
  const body = { threshold: $('#convThreshold').value, maxPasses: $('#convPasses').value };
  const b = $('#convStart'); b.disabled = true;
  try {
    const url = tgt.type === 'mr' ? `/mrs/${tgt.id}/converge` : `/tasks/${tgt.id}/converge`;
    await api(url, { method: 'POST', body });
    closeConvergeModal();
    toast(tr('toast.converge-lancee'));
    refreshStatus();
    if (tgt.type === 'task') { navTab('task'); loadTasks(); }
  } catch (e) { b.disabled = false; toast(explainError(e.message), true); }
});

/* ---------- Delta depuis la dernière visite ----------
   Le panneau de droite ouvre la journée. Son axe est STRICTEMENT « ce qui a changé depuis
   ma dernière session » — le bandeau du pied de page, lui, raconte le présent qui bouge ;
   deux endroits qui diraient la même chose s'annuleraient. D'où les trois règles dures :
   plafond à trois lignes, uniquement ce qui a changé (jamais de « 0 nouvelle MR »), et
   un instantané par stade pour qu'un simple changement de segment ne fasse pas tout
   passer pour nouveau. */
const VISITE_GAP_MS = 4 * 3600 * 1000; // en deçà, on est encore dans la même session de travail
const visiteKey = (seg) => `aidevtools_visite_${seg}`;
// Lu UNE fois par chargement de page : le delta doit rester stable pendant qu'on
// travaille, pas fondre au premier re-rendu de la liste.
const visitesPrec = {};
function visitePrecedente(seg) {
  if (!(seg in visitesPrec)) {
    let v = null;
    try {
      const raw = JSON.parse(localStorage.getItem(visiteKey(seg)) || 'null');
      if (raw && Array.isArray(raw.ids) && raw.ts) v = raw;
    } catch { /* instantané illisible : on repart de zéro */ }
    visitesPrec[seg] = v;
  }
  return visitesPrec[seg];
}
function memoriserVisite(seg, rows) {
  const prec = visitePrecedente(seg);
  // Tant qu'on est dans la même session, on garde la base de comparaison d'origine :
  // sinon le delta s'effacerait à mesure qu'on lit la liste.
  if (prec && Date.now() - prec.ts < VISITE_GAP_MS) return;
  try { localStorage.setItem(visiteKey(seg), JSON.stringify({ ts: Date.now(), ids: rows.map((m) => m.id) })); }
  catch { /* stockage indisponible */ }
}
// Renvoie au plus trois lignes de faits, ou [] s'il ne s'est rien passé.
function lignesDelta(seg, rows, maintenant = Date.now()) {
  const prec = visitePrecedente(seg);
  if (!prec) return []; // première visite : aucun passé à comparer
  const avant = new Set(prec.ids);
  const ids = new Set(rows.map((m) => m.id));
  const arrivees = rows.filter((m) => !avant.has(m.id)).length;
  const parties = prec.ids.filter((id) => !ids.has(id)).length;
  const jours = Math.max(0, Math.round((maintenant - prec.ts) / 86400000));
  const depuis = jours <= 0 ? tr('report.delta.since.today') : (jours === 1 ? tr('report.delta.since.yesterday') : tr('report.delta.since.days', { n: jours }));
  const lignes = [];
  if (arrivees) lignes.push(tr('report.delta.new', { n: arrivees }));
  if (parties) lignes.push(tr('report.delta.gone', { n: parties }));
  /* L'attente la plus longue n'est pas un delta : c'est un état permanent. Elle n'apparaît
     donc qu'en APPUI d'un vrai changement — seule, elle deviendrait la ligne immuable
     affichée tous les matins, et c'est ainsi qu'un panneau cesse d'être lu. */
  const vieilles = lignes.length ? rows.filter((m) => m.stale && m.gitlab_created_at) : [];
  if (vieilles.length) {
    const plusVieille = vieilles.reduce((a, b) => (new Date(a.gitlab_created_at) < new Date(b.gitlab_created_at) ? a : b));
    const j = Math.floor((maintenant - new Date(plusVieille.gitlab_created_at).getTime()) / 86400000);
    if (j > 0) lignes.push(tr('report.delta.wait', { n: j }));
  }
  return lignes.length ? [depuis, ...lignes.slice(0, 3)] : [];
}

// La colonne de droite était occupée par « Sélectionne une MR ». On y met plutôt
// un résumé actionnable : ce qu'il y a, et par quoi commencer.
function renderReportPlaceholder() {
  const el = $('#reportDetail');
  if (!el) return;
  const toutes = reportRows || [];
  if (!toutes.length) { el.innerHTML = `<p class="muted">${tr('report.ph.pick')}</p>`; return; }
  /* Le résumé décrit ce qui est À L'ÉCRAN : sinon « 6 rapports » et trois raccourcis vers des
     merge requests masquées s'affichent à côté d'une liste qui n'en montre qu'une.
     Le suivi des nouveautés, lui, reste sur le stade ENTIER : mémoriser une visite partielle
     ferait resignaler comme neuves des lignes que le filtre avait simplement cachées. */
  const rows = toutes.filter(passeFiltreNote);
  const noted = rows.filter((m) => m.note && m.note.value != null);
  const avg = noted.length ? Math.round((noted.reduce((s, m) => s + m.note.value, 0) / noted.length) * 100) / 10 : null;
  const stale = rows.filter((m) => m.stale).length;
  const worst = [...noted].sort((a, b) => a.note.value - b.note.value).slice(0, 3);
  const delta = lignesDelta(currentSeg, toutes);
  memoriserVisite(currentSeg, toutes);
  if (!rows.length) { el.innerHTML = `<p class="muted">${tr('report.ph.pick')}</p>`; return; }
  el.innerHTML = `
    <div class="ph-summary">
      ${delta.length ? `<div class="ph-delta">
        <div class="step-s">${esc(delta[0])}</div>
        <ul>${delta.slice(1).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>` : ''}
      <div class="empty-t">${tr('report.ph.count', { n: rows.length, total: rows.length })}</div>
      <p class="empty-s">${avg != null ? tr('report.ph.avg', { avg }) : tr('report.ph.no-note')}${stale ? tr('report.ph.stale', { stale }) : ''}</p>
      ${worst.length ? `<div class="ph-worst">
        <div class="step-s">${tr('report.ph.priority')}</div>
        ${worst.map((m) => `<button class="ph-item" data-open-mr="${m.id}">
            <span class="note ${noteClass(m.note)}">${esc(m.note.raw)}</span>
            <span class="ph-item-t">!${m.iid} — ${esc((m.title || '').slice(0, 48))}</span>
          </button>`).join('')}
      </div>` : ''}
      <p class="step-s" style="margin-top:12px">${tr('report.ph.pick-long')}</p>
    </div>`;
  $$('#reportDetail [data-open-mr]').forEach((b) => b.addEventListener('click', () => openReport(Number(b.dataset.openMr))));
}

/* ---------- États vides ----------
   Sur un outil qui démarre à vide, c'est le PREMIER écran vu : il doit expliquer
   ce qui va se passer et proposer l'action suivante, pas afficher « Aucun X. ». */
function emptyState({ icon = 'inbox', title, text = '', actions = [] }) {
  const btns = actions.map((a) => `<button class="btn ${a.primary ? 'btn-primary' : ''}" data-empty-act="${esc(a.act)}">${a.label}</button>`).join('');
  return `<div class="empty">
    <svg class="ico"><use href="#i-${icon}"/></svg>
    <div class="empty-t">${title}</div>
    ${text ? `<p class="empty-s">${text}</p>` : ''}
    ${btns ? `<div class="empty-actions">${btns}</div>` : ''}
  </div>`;
}

// Onboarding : tant que GitLab n'est pas connecté ou qu'aucun dépôt n'est suivi,
// on remplace la liste par les 3 étapes de démarrage, chacune avec son action directe.
let setupState = { configured: false, hasRepos: false, checked: false };
async function checkSetup() {
  try {
    const [cfg, repos] = await Promise.all([api('/config'), api('/repos')]);
    setupState = {
      configured: !!(cfg.gitlab_url && cfg.access_token),
      hasRepos: Array.isArray(repos) && repos.length > 0,
      checked: true,
    };
  } catch { setupState.checked = true; }
  return setupState;
}

// Jira configuré côté serveur ? Pilote l'affichage du bloc « enrichir depuis Jira »
// de la modale de session. Mis à jour à chaque /status.
let jiraConfigured = false;

// Bannière « mode démo » : affichée si le serveur tourne en mode démo (npm run demo).
(async () => {
  try {
    const s = await api('/status');
    if (s && s.demo) { const b = $('#demoBanner'); if (b) b.hidden = false; }
    if (s) jiraConfigured = !!s.jiraConfigured;
  } catch { /* status indisponible : pas de bannière */ }
})();
function onboardingHtml() {
  const s = setupState;
  const step = (n, done, t, sub, act, label) => `
    <div class="step ${done ? 'done' : ''}">
      <span class="step-n">${done ? svgIco('check') : n}</span>
      <span class="step-txt"><span class="step-t">${t}</span><br><span class="step-s">${sub}</span></span>
      ${done ? '' : `<button class="btn btn-sm ${n === 1 || (n === 2 && s.configured) ? 'btn-primary' : ''}" data-empty-act="${act}">${label}</button>`}
    </div>`;
  return `<div class="empty">
    <svg class="ico"><use href="#i-bot"/></svg>
    <div class="empty-t">${tr('onboard.title')}</div>
    <p class="empty-s">${tr('onboard.subtitle')}</p>
    <div class="steps">
      ${step(1, s.configured, tr('onboard.s1.title'), tr('onboard.s1.text'), 'go-config', tr('onboard.s1.btn'))}
      ${step(2, s.hasRepos, tr('onboard.s2.title'), tr('onboard.s2.text'), 'go-repos', tr('onboard.s2.btn'))}
      ${step(3, false, tr('onboard.s3.title'), tr('onboard.s3.text'), 'discover', tr('onboard.s3.btn'))}
    </div>
  </div>`;
}
// Actions des états vides / de l'onboarding (délégation : le HTML est régénéré souvent).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-empty-act]');
  if (!b) return;
  const go = (tab) => { const t = $(`nav button[data-tab="${tab}"]`); if (t) t.click(); };
  switch (b.dataset.emptyAct) {
    case 'go-config': closeBulk(); go('admin'); showAdminSub('gitcfg'); break;
    case 'go-repos': go('admin'); showAdminSub('repos'); break;
    case 'go-rules': go('admin'); showAdminSub('rules'); break;
    case 'discover': go('review'); $('#btnDiscover').click(); break;
    case 'new-task': go('task'); $('#btnNewTask').click(); break;
    case 'seg-to-review': loadSegment('to_review'); break;
    case 'seg-reviewed': loadSegment('reviewed'); break;
    case 'go-jira-config': go('admin'); showAdminSub('jiracfg'); break;
    case 'jenkins-config': go('admin'); showAdminSub('jenkinscfg'); break;
    case 'clear-search': $('#searchReview').value = ''; loadSegment(currentSeg); break;
    case 'clear-note-filter': reinitFiltreNote(); break;
    default: break;
  }
});

// Statuts de MR : la base stocke de l'anglais snake_case, l'UI parle français
// (symétrique de TASK_STATUS, qui le faisait déjà pour les tâches).
const MR_STATUS = {
  to_review: { label: tr('mr.status.to-review'), cls: 'to_review' },
  reviewed: { label: tr('mr.status.reviewed'), cls: 'reviewed' },
  done: { label: tr('mr.status.done'), cls: 'done' },
};
const mrStatus = (s) => MR_STATUS[s] || { label: s, cls: '' };

// Compteurs des segments + libellé du bouton de review globale (dit ce qui sera consommé).
async function refreshCounts() {
  try {
    const s = await api('/stats');
    const f = s.funnel || {};
    /* Un compteur qui saute de 12 à 13 ne se remarque pas ; un compteur qui COMPTE, si.
       C'est la seule part visible du travail qui vient de se terminer. Animation courte,
       coupée si l'onglet est masqué (rien à montrer) ou en mouvement réduit. */
    const set = (id, n) => {
      const el = $(id); if (!el) return;
      const cible = n || 0; const depart = Number(el.textContent) || 0;
      if (cible === depart || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = cible; return;
      }
      const t0 = performance.now(); const dur = 600;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        el.textContent = Math.round(depart + (cible - depart) * (1 - (1 - k) ** 3));
        if (k < 1) requestAnimationFrame(step); else el.textContent = cible;
      };
      requestAnimationFrame(step);
    };
    set('#segCountToReview', f.to_review); set('#segCountReviewed', f.reviewed); set('#segCountDone', f.done);
    const nav = $('#navCountReview');
    if (nav) { nav.textContent = f.to_review || 0; nav.hidden = !f.to_review; }
    /* Badge ORANGE : les rapports faibles qui attendent encore une décision. Il complète le
       badge neutre (« à traiter ») sans le remplacer — l'un dit combien de merge requests
       n'ont pas été lues, l'autre lesquelles méritent d'être lues en premier. */
    const bas = $('#navLowScores');
    if (bas) {
      const n = s.lowScores || 0;
      bas.textContent = n;
      bas.hidden = !n;
      bas.title = tr('nav.low-scores', { n, count: n });
    }
    const lbl = $('#btnReviewLabel'); const btn = $('#btnReview');
    if (lbl && btn) {
      const n = f.to_review || 0;
      lbl.textContent = n ? tr('review.btn.review-all', { n, count: n }) : tr('review.btn.none');
      btn.disabled = !n;
    }
  } catch { /* compteurs : jamais bloquant */ }
}

/* ---------- Onglet Reviews : 3 stades d'une même MR ----------
   « À traiter » = liste simple ; « Reviewées » / « Traitées » = liste + rapport.
   Un seul champ de recherche, partagé par les trois stades. */
/* Le segment de Reviews est mémorisé comme l'onglet l'était déjà : sur un outil relancé
   plusieurs fois par jour, repartir systématiquement sur « à traiter » est une taxe.
   On ne restaure QUE l'onglet et le segment — jamais une recherche, une modale, une vue
   plein écran ni un rapport ouvert : restaurer un état périmé est pire qu'un démarrage
   propre, et c'est le seul risque réel de cette idée. */
const SEGS = ['to_review', 'reviewed', 'done'];
let currentSeg = (() => {
  try { const v = localStorage.getItem('aidevtools_seg'); return SEGS.includes(v) ? v : 'to_review'; }
  catch { return 'to_review'; }
})();
function loadSegment(seg = currentSeg) {
  currentSeg = seg;
  try { localStorage.setItem('aidevtools_seg', seg); } catch { /* stockage indisponible */ }
  $$('.segmented [data-seg]').forEach((b) => b.classList.toggle('active', b.dataset.seg === seg));
  const isToReview = seg === 'to_review';
  $('#toReviewList').hidden = !isToReview;
  $('#reportSplit').hidden = isToReview;
  // La sélection multiple n'existe que dans la file « à traiter » : ailleurs elle traînerait
  // une barre d'actions sans cases à cocher pour la défaire.
  if (!isToReview) { mrSelection.clear(); renderMrBulkBar(); }
  refreshCounts();
  return isToReview ? loadToReview() : loadReports(seg);
}
$$('.segmented [data-seg]').forEach((b) => b.addEventListener('click', () => loadSegment(b.dataset.seg)));

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  const el = $('#dashboard');
  el.innerHTML = skeleton(4);
  let s;
  try { s = await api('/stats'); } catch (e) { el.innerHTML = errorBox(e.message); return; }

  const tile = (label, value, cls = '') => `<div class="stat-tile ${cls}"><div class="stat-val">${value}</div><div class="stat-lbl">${esc(label)}</div></div>`;
  const noteBadge = (v) => (v == null ? '<span class="note none">—</span>' : `<span class="note ${v >= 7 ? 'good' : v >= 4 ? 'mid' : 'bad'}">${v}</span>`);
  // Légende d'utilité sous chaque titre : « à quelle question ce graphe répond ».
  const cap = (key) => `<p class="dash-help">${tr(key)}</p>`;

  const funnelHtml = `<div class="stat-row">
    ${tile(tr('stats.funnel.to-review'), s.funnel.to_review, 'amber')}
    ${tile(tr('stats.funnel.reviewed'), s.funnel.reviewed, 'accent')}
    ${tile(tr('stats.funnel.done'), s.funnel.done, 'green')}
  </div>`;

  const noteColors = ['#e05a5a', '#e0863a', '#e0a838', '#8fce7f', '#35c07f'];
  const maxB = Math.max(1, ...s.notes.buckets.map((b) => b.count), s.notes.noNote);
  const notesHtml = `<div class="dash-card"><h3>${tr('stats.notes.title')} ${s.notes.avg != null ? `<span class="muted">${tr('stats.notes.avg', { avg: s.notes.avg })}</span>` : ''}</h3>${cap('stats.help.notes')}
    <div class="hbars">
      ${s.notes.buckets.map((b, i) => `<div class="hbar"><span class="hbar-lbl">${b.label}</span><div class="hbar-track"><div class="hbar-fill" style="width:${(b.count / maxB) * 100}%;background:${noteColors[i]}"></div></div><span class="hbar-val">${b.count}</span></div>`).join('')}
      <div class="hbar"><span class="hbar-lbl muted">${tr('stats.notes.none')}</span><div class="hbar-track"><div class="hbar-fill" style="width:${(s.notes.noNote / maxB) * 100}%;background:var(--line)"></div></div><span class="hbar-val">${s.notes.noNote}</span></div>
    </div></div>`;

  const maxW = Math.max(1, ...s.weekly.map((w) => w.count));
  const weeklyHtml = `<div class="dash-card"><h3>${tr('stats.weekly.title')}</h3>${cap('stats.help.weekly')}
    <div class="vbars">${s.weekly.map((w) => `<div class="vbar" title="${tr('stats.weekly.tooltip', { week: w.week, count: w.count })}"><div class="vbar-fill" style="height:${(w.count / maxW) * 100}%"></div><span class="vbar-val">${w.count || ''}</span></div>`).join('')}</div>
    <div class="vbars-x">${s.weekly.map((w) => `<span>${w.week.slice(8, 10)}-${w.week.slice(5, 7)}</span>`).join('')}</div></div>`;

  // Taux de résolution : la mesure la plus parlante de ce que l'outil apporte.
  const rateCell = (res) => (res && res.rate != null)
    ? `<span class="res-rate ${res.rate >= 70 ? 'good' : res.rate >= 40 ? 'mid' : 'bad'}" title="${esc(tr('stats.resolution.detail', { resolved: res.resolved, prior: res.prior }))}">${res.rate}%</span>`
    : '<span class="note none">—</span>';
  const trendCell = (pt) => !pt ? '<span class="note none">—</span>'
    : `<span class="proj-trend ${pt.dir}" title="${esc(tr('stats.trend.delta', { delta: (pt.delta > 0 ? '+' : '') + pt.delta }))}">${pt.dir === 'up' ? '▲' : pt.dir === 'down' ? '▼' : '→'} ${pt.delta > 0 ? '+' : ''}${pt.delta}</span>`;
  const projHtml = `<div class="dash-card"><h3>${tr('stats.proj.title')} <span class="muted">${tr('stats.proj.subtitle')}</span></h3>${cap('stats.help.proj')}
    <div class="md-tablewrap"><table class="md-table"><thead><tr><th>${tr('stats.col.project')}</th><th>${tr('stats.col.reviewed')}</th><th>${tr('stats.col.pending')}</th><th>${tr('stats.col.avg')}</th><th>${tr('stats.col.worst')}</th><th title="${esc(tr('stats.col.resolution-hint'))}">${tr('stats.col.resolution')}</th><th title="${esc(tr('stats.col.trend-hint'))}">${tr('stats.col.trend')}</th><th>${tr('stats.col.last-commit')}</th></tr></thead>
    <tbody>${s.projects.length ? s.projects.map((p) => `<tr><td>${esc(p.project)}</td><td>${p.reviewed}</td><td>${p.pending || ''}</td><td>${noteBadge(p.avg)}</td><td>${noteBadge(p.worst)}</td><td>${rateCell(p.resolution)}</td><td>${trendCell(p.trend)}</td><td class="dash-lastcommit" data-project="${esc(p.project)}"><span class="muted">…</span></td></tr>`).join('') : `<tr><td colspan="8" class="muted">${tr('stats.empty')}</td></tr>`}</tbody></table></div>
    ${s.resolution ? `<p class="muted stats-res-global">${tr('stats.resolution.global', { rate: s.resolution.rate, resolved: s.resolution.resolved, prior: s.resolution.prior })}</p>` : ''}</div>`;

  const t = s.tasks;
  const devHtml = `<div class="dash-card"><h3>${tr('stats.dev.title')}</h3>${cap('stats.help.dev')}<div class="stat-row">
    ${tile(tr('stats.dev.tasks'), t.total)}
    ${tile(tr('stats.dev.mr-created'), t.mrCreated, 'accent')}
    ${tile(tr('stats.dev.mr-merged'), t.mrMerged, 'green')}
    ${tile(tr('stats.dev.comments'), s.commentsPosted)}
  </div></div>`;

  // Tendance de la note : l'évolution hebdo, la question « la qualité progresse-t-elle ? ».
  // Défensif : si le serveur ne renvoie pas encore ce champ (version antérieure),
  // le bloc est simplement omis plutôt que de faire planter tout le dashboard.
  const scoreTrend = s.scoreTrend || [];
  const trendHtml = !scoreTrend.length ? '' : `<div class="dash-card"><h3>${tr('stats.trend.title')}</h3>${cap('stats.help.trend')}
    <div class="vbars">${scoreTrend.map((w) => w.avg == null
      ? `<div class="vbar vbar-empty" title="${tr('stats.trend.no-data', { week: w.week })}"></div>`
      : `<div class="vbar" title="${tr('stats.trend.tooltip', { week: w.week, avg: w.avg, count: w.count })}"><div class="vbar-fill ${w.avg >= 7 ? 'vf-good' : w.avg >= 4 ? 'vf-mid' : 'vf-bad'}" style="height:${(w.avg / 10) * 100}%"></div><span class="vbar-val">${w.avg}</span></div>`).join('')}</div>
    <div class="vbars-x">${scoreTrend.map((w) => `<span>${w.week.slice(8, 10)}-${w.week.slice(5, 7)}</span>`).join('')}</div></div>`;

  // Tokens : où part le quota. Camembert par type (conic-gradient, pas de calcul d'arc)
  // + coût moyen par MR reviewée. Le total est un MINORANT, dit dans la légende.
  const KIND_COLOR = { review: '#4f8cff', explain: '#35c07f', task: '#b47ce6', explore: '#e0a838', modify: '#e0863a' };
  // Clés littérales (et non tr('stats.kind.'+k)) pour rester greppables — cf. i18n-check.
  const KIND_KEY = { review: 'stats.kind.review', explain: 'stats.kind.explain', modify: 'stats.kind.modify', task: 'stats.kind.task', explore: 'stats.kind.explore' };
  const kindLabel = (k) => (KIND_KEY[k] ? tr(KIND_KEY[k]) : k);
  const tk = s.tokens || { total: 0, byKind: [] };
  let accP = 0;
  const segs = tk.byKind.map((r) => { const from = (accP / tk.total) * 100; accP += r.tokens; const to = (accP / tk.total) * 100; return `${KIND_COLOR[r.kind] || '#8b97ad'} ${from}% ${to}%`; }).join(', ');
  const tokHtml = tk.total ? `<div class="dash-card"><h3>${tr('stats.tokens.title')}</h3>${cap('stats.help.tokens')}
    <div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${segs})"></div>
      <div class="donut-legend">${tk.byKind.map((r) => `<div class="donut-leg"><span class="dot" style="background:${KIND_COLOR[r.kind] || '#8b97ad'}"></span>${esc(kindLabel(r.kind))}<span class="spacer"></span><span class="muted">${fmtNum(r.tokens)} · ${Math.round((r.tokens / tk.total) * 100)}%</span></div>`).join('')}</div>
    </div>
    <div class="stat-row">${tile(tr('stats.tokens.avg-per-mr'), tk.avgPerReviewedMr != null ? fmtNum(tk.avgPerReviewedMr) : '—', 'accent')}${tile(tr('stats.tokens.total-label'), fmtNum(tk.total))}</div>
    <p class="muted dash-floor">${tr('stats.tokens.floor')}</p></div>` : '';

  el.innerHTML = `<div id="dashTop5" class="dash-card">${skeleton(2)}</div>`
    + funnelHtml + `<div class="dash-grid">${notesHtml}${trendHtml}${weeklyHtml}${tokHtml}</div>`
    + `<div id="dashActivity" class="dash-card">${skeleton(3)}</div>` + projHtml + devHtml;

  // Activité GitLab en direct (dernier commit par projet) : chargée à part pour ne pas
  // ralentir le dashboard ni le faire échouer si GitLab est injoignable.
  fillDashboardCommits();
  // Même raison, en plus marqué : six mois d'historique se paginent depuis la forge.
  fillDashboardActivity();
}

/* Activité des projets sur six mois — un petit graphe PAR PROJET plutôt qu'un empilement.

   Le nombre de commits ne se compare pas d'un projet à l'autre : celui qui squash en fait un
   par merge request, celui qui ne squash pas en fait quarante pour le même travail. Ce qui se
   lit, c'est la FORME de chaque projet dans le temps — et un empilement écraserait de toute
   façon tous les petits derrière le plus gros. Chaque ligne a donc sa propre échelle, et
   l'ordre (du plus actif au plus calme) porte la comparaison. */
async function fillDashboardActivity() {
  const el = $('#dashActivity');
  if (!el) return;
  let d;
  try { d = await api('/dashboard/activity'); }
  catch { el.innerHTML = `<h3>${tr('stats.activity.title')}</h3><p class="muted">${tr('stats.top5.unavailable')}</p>`; return; }
  if (!$('#dashboard')) return;

  const mois = d.months || [];
  const projets = d.projects || [];
  const entete = `<h3>${tr('stats.activity.title')}</h3><p class="dash-help">${tr('stats.activity.help')}</p>`;
  if (!d.configured) { el.innerHTML = `${entete}<p class="muted">${tr('stats.top5.not-configured')}</p>`; return; }
  if (!projets.length) { el.innerHTML = `${entete}<p class="muted">${tr('stats.activity.empty')}</p>`; return; }

  const libelleMois = (m) => {
    const [a, mm] = m.split('-');
    return new Date(Date.UTC(Number(a), Number(mm) - 1, 1))
      .toLocaleDateString(I18Nrt.currentLocale(), { month: 'short', timeZone: 'UTC' });
  };
  /* Endormi : rien sur les DEUX derniers mois. Un seul mois creux arrive à tout le monde
     (congés, mise en production), deux dessinent une pente. Ils restent à l'écran — c'est
     précisément ce qu'on vient chercher, et une barre au ras du sol le dit mieux qu'un texte. */
  const endormi = (p) => p.counts.slice(-2).every((n) => n === 0);

  /* UNE barre par projet, hauteur = JOURS ACTIFS des six mois — les journées où au moins un
     commit est tombé. Le nombre de commits mesurerait surtout le style : squasher ou non
     change le compte du simple au quarantuple pour le même travail, et un dépôt gonflé
     écraserait tous les autres. Une journée travaillée, elle, veut dire la même chose
     partout, et la mesure est bornée (une vingtaine de jours ouvrés par mois) donc
     comparable d'un dépôt à l'autre. Les commits restent dans l'infobulle.

     La barre est EMPILÉE par mois, du plus ancien (pâle) au plus récent (plein) : la hauteur
     donne le volume, le dégradé dit si l'activité est récente ou ancienne — un projet actif
     cinq mois plus tôt n'est pas dans le même état qu'un projet actif aujourd'hui. */
  const maxi = Math.max(1, ...projets.map((p) => p.totalDays));
  const court = (nom) => (nom.includes('/') ? nom.slice(nom.lastIndexOf('/') + 1) : nom);

  const barre = (p) => {
    const dort = endormi(p);
    // Le détail montre les deux : les jours portent la barre, les commits éclairent.
    const detail = mois.map((m, i) => `${libelleMois(m)} ${tr('stats.activity.tip-line', { days: p.days[i], commits: p.counts[i] })}`).join('\n');
    const infobulle = `${p.project} — ${tr('stats.activity.total-tip', { n: p.totalDays, count: p.totalDays })}`
      + `\n${tr('stats.activity.commits-tip', { n: p.total, count: p.total })}`
      + (p.contributeurs ? ` · ${tr('stats.activity.authors-tip', { n: p.contributeurs, count: p.contributeurs })}` : '')
      + `\n\n${detail}`
      + (p.erreur ? `\n\n⚠ ${p.erreur}` : '')
      + (dort ? `\n\n${tr('stats.activity.asleep-tip')}` : '');
    /* Barres HORIZONTALES : le temps se lit de gauche à droite, du plus ancien au plus récent.
       Une couleur par mois — repérer « avril » demandait sinon de compter les segments. */
    const segments = p.days.map((n, i) => (n === 0 ? '' : `<span class="pab-seg" style="width:${(n / maxi) * 100}%;--c:var(--mois-${i + 1})"
        title="${esc(`${libelleMois(mois[i])} — ${tr('stats.activity.tip-line', { days: n, commits: p.counts[i] })}`)}"></span>`)).join('');
    /* TOUTE la colonne est le bouton — barre comprise, pas seulement le nom : viser trois
       lignes de texte de dix pixels est un geste inutilement précis quand la barre au-dessus
       désigne déjà le projet. Un `<button>` natif plutôt qu'un div cliquable : il se
       focalise au clavier, s'active à Entrée, et se lit correctement à voix haute — d'où
       l'`aria-label`, qui porte ce que l'infobulle ne dit qu'à la souris. */
    const resume = `${p.project} — ${tr('stats.activity.total-tip', { n: p.totalDays, count: p.totalDays })}, `
      + `${tr('stats.activity.commits-tip', { n: p.total, count: p.total })}`
      + (dort ? `. ${tr('stats.activity.asleep-tip')}` : '');
    /* Une LIGNE par projet : le nom tient en entier à gauche, ce qu'une colonne de 65 px ne
       permettait pas — à vingt projets, tous les libellés finissaient tronqués. La hauteur du
       graphe est bornée et défile : la liste peut s'allonger sans repousser le reste de la page. */
    return `<button type="button" class="pab${dort ? ' dort' : ''}" data-pab-detail="${p.repo_id}"
      title="${esc(infobulle)}" aria-label="${esc(`${resume}. ${tr('stats.activity.detail-title', { project: p.project })}`)}">
      <span class="pab-name" title="${esc(p.project)}">${esc(court(p.project))}</span>
      <span class="pab-stack">${segments}</span>
      <span class="pab-val">${p.totalDays ? fmtNum(p.totalDays) : '0'}</span>
    </button>`;
  };

  const dormants = projets.filter(endormi).length;
  const partiels = projets.filter((p) => p.partiel).length;
  el.innerHTML = entete
    + `<div class="pab-chart" role="group" aria-label="${esc(tr('stats.activity.title'))}">${projets.map(barre).join('')}</div>`
    // Légende : chaque mois avec sa pastille, dans l'ordre du graphe.
    + `<div class="pab-legend">
        ${mois.map((m, i) => `<span class="pab-mois"><span class="pab-key" style="--c:var(--mois-${i + 1})"></span>${esc(libelleMois(m))}${i === mois.length - 1 ? '*' : ''}</span>`).join('')}
        ${dormants ? `<span class="pab-legend-sleep"><span class="pab-key dort"></span>${esc(tr('stats.activity.asleep-group', { n: dormants, count: dormants }))}</span>` : ''}
      </div>`
    + (partiels ? `<p class="muted dash-floor">${tr('stats.activity.truncated', { n: partiels, count: partiels })}</p>` : '')
    + `<p class="muted dash-floor">* ${tr('stats.activity.partial-month')} · ${tr('stats.activity.note')}</p>`;

  // Le graphe est reconstruit à chaque visite de l'onglet : les écouteurs se reposent ici.
  $$('#dashActivity [data-pab-detail]', el).forEach((b2) =>
    b2.addEventListener('click', () => ouvrirActiviteProjet(Number(b2.dataset.pabDetail))));
}

/* ---------- Détail d'activité d'un projet sur 12 mois ----------
   Six mois répondent à « qui bouge ? », douze à « dans quel sens ? » : un dépôt calme depuis
   deux mois après dix mois soutenus ne raconte pas la même chose qu'un dépôt éteint depuis un
   an, et la vue d'ensemble ne peut pas les distinguer. */
async function ouvrirActiviteProjet(repoId) {
  const modale = $('#activityModal');
  const corps = $('#activityBody');
  if (!modale || !corps) return;
  $('#activityTitle').textContent = tr('stats.activity.detail.loading');
  corps.innerHTML = skeleton(3);
  modale.hidden = false;
  let d;
  try { d = await api(`/dashboard/activity/${repoId}`); }
  catch (e) { corps.innerHTML = errorBox(explainError(e.message)); return; }

  const libelle = (m) => {
    const [a, mm] = m.split('-');
    return new Date(Date.UTC(Number(a), Number(mm) - 1, 1))
      .toLocaleDateString(I18Nrt.currentLocale(), { month: 'short', year: '2-digit', timeZone: 'UTC' });
  };
  $('#activityTitle').textContent = tr('stats.activity.detail.title', { project: d.project });
  const maxi = Math.max(1, ...d.days);
  const barres = d.months.map((m, i) => {
    const encours = i === d.months.length - 1;
    const t = `${libelle(m)} — ${tr('stats.activity.tip-line', { days: d.days[i], commits: d.counts[i] })}`
      + (d.authors[i] ? ` · ${tr('stats.activity.authors-tip', { n: d.authors[i], count: d.authors[i] })}` : '')
      + (encours ? ` — ${tr('stats.activity.partial-month')}` : '');
    return `<div class="ad-col" title="${esc(t)}">
        <span class="ad-val">${d.days[i] || ''}</span>
        <span class="ad-bar${d.days[i] === 0 ? ' vide' : ''}${encours ? ' encours' : ''}" style="height:${(d.days[i] / maxi) * 100}%"></span>
        <span class="ad-x">${esc(libelle(m))}${encours ? '*' : ''}</span>
      </div>`;
  }).join('');

  const tuile = (val, lbl) => `<div class="stat-tile"><div class="stat-val">${val}</div><div class="stat-lbl">${esc(lbl)}</div></div>`;
  corps.innerHTML = `<div class="stat-row">
      ${tuile(fmtNum(d.totalDays), tr('stats.activity.detail.days'))}
      ${tuile(fmtNum(d.total), tr('stats.activity.detail.commits'))}
      ${tuile(d.contributeurs || '—', tr('stats.activity.detail.authors'))}
    </div>
    <div class="ad-chart">${barres}</div>
    ${/* Les repères, joints proprement : un projet sans activité n'a ni « mois le plus actif »
          ni « dernière activité », et la phrase ne doit pas commencer par un séparateur. */''}
    <p class="muted ad-facts">${[
    d.meilleurMois ? tr('stats.activity.detail.best', { month: libelle(d.meilleurMois) }) : '',
    d.dernierActif ? tr('stats.activity.detail.last', { month: libelle(d.dernierActif) }) : tr('stats.activity.detail.never'),
  ].filter(Boolean).join(' · ')}</p>
    ${d.erreur ? errorBox(d.erreur) : ''}
    <p class="muted dash-floor">* ${tr('stats.activity.partial-month')}${d.partiel ? ` · ${tr('stats.activity.truncated', { n: 1, count: 1 })}` : ''}</p>`;
}

/* ---------- Sauvegarde des données ----------
   Une archive de tout ce que Mergerie ne sait pas reconstruire : la base, les rapports, les
   retours d'agent, les captures. Pas les clones — ils se retrouvent avec un `git clone`.
   On dit ce que l'archive contient APRÈS l'avoir produite : « c'est fait » n'apprend rien,
   « 1 base, 34 rapports, 2,1 Mo » se vérifie. */
$('#btnBackup') && $('#btnBackup').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const info = $('#backupInfo');
  if (info) { info.className = 'muted'; info.textContent = tr('settings.backup.running'); }
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || res.statusText);
    const blob = await res.blob();
    // Le nom vient du serveur (daté) : deux sauvegardes ne doivent pas s'écraser.
    const nom = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
    telecharger(blob, nom ? nom[1] : 'mergerie-backup.zip');
    let detail = '';
    try {
      const brut = res.headers.get('X-Mergerie-Backup');
      if (brut) {
        detail = JSON.parse(atob(brut))
          .filter((c) => c.fichiers)
          .map((c) => `${c.nom} ${c.fichiers}`).join(' · ');
      }
    } catch { /* l'en-tête est un confort : son absence ne change rien au fichier */ }
    if (info) {
      info.className = 'muted ok';
      info.textContent = tr('settings.backup.done', { size: Math.max(1, Math.round(blob.size / 1024)) })
        + (detail ? ` — ${detail}` : '');
    }
  } catch (err) {
    if (info) { info.className = 'muted err'; info.textContent = explainError(err.message); }
  }
}));

const fermerActivite = () => { $('#activityModal').hidden = true; };
$('#activityClose') && $('#activityClose').addEventListener('click', fermerActivite);
fermerAuFond('#activityModal', fermerActivite, { salissable: false });

// Cellule « dernier commit » : date (lien vers le commit GitLab) + auteur.
function lastCommitCell(c) {
  const when = c.date ? fmtDate(c.date) : '—';
  const link = c.url ? `<a href="${esc(c.url)}" target="_blank" title="${esc(`${c.title || ''}${c.sha ? ` · ${c.sha}` : ''}`)}">${when}</a>` : when;
  return `${link}${c.author ? ` · <span class="muted">${esc(c.author)}</span>` : ''}`;
}

async function fillDashboardCommits() {
  let d;
  try { d = await api('/dashboard/commits'); }
  catch {
    // Best-effort : si l'activité GitLab est injoignable, ne pas laisser le squelette du Top 5
    // tourner en boucle — basculer sur un état « indisponible » explicite.
    const box0 = $('#dashboard'); if (!box0) return;
    const t5f = $('#dashTop5');
    if (t5f) t5f.innerHTML = `<h3>${tr('stats.top5.title')}</h3><p class="muted">${tr('stats.top5.unavailable')}</p>`;
    $$('.dash-lastcommit[data-project]', box0).forEach((td) => { td.innerHTML = '<span class="note none">—</span>'; });
    return;
  }
  const box = $('#dashboard'); if (!box) return;
  const byProject = Object.fromEntries((d.commits || []).map((c) => [c.project, c]));
  $$('.dash-lastcommit[data-project]', box).forEach((td) => {
    const c = byProject[td.dataset.project];
    td.innerHTML = c ? lastCommitCell(c) : '<span class="note none">—</span>';
  });
  // Top 5 : dépôts au commit le plus récent d'abord.
  const top = [...(d.commits || [])].filter((c) => c.date).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  const t5 = $('#dashTop5'); if (!t5) return;
  t5.innerHTML = `<h3>${tr('stats.top5.title')}</h3><p class="dash-help">${tr('stats.top5.help')}</p>`
    + (top.length
      ? `<div class="md-tablewrap"><table class="md-table"><thead><tr><th>${tr('stats.col.project')}</th><th>${tr('stats.col.last-commit')}</th><th>${tr('stats.col.author')}</th></tr></thead>
          <tbody>${top.map((c) => `<tr><td>${esc(c.project)}</td><td>${c.url ? `<a href="${esc(c.url)}" target="_blank" title="${esc(c.title)}"><code>${esc(c.sha)}</code></a>` : `<code>${esc(c.sha)}</code>`} · ${c.date ? `${fmtDate(c.date)} ${fmtHour(c.date)}` : '—'}</td><td class="muted">${esc(c.author)}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="muted">${d.configured ? tr('stats.top5.empty') : tr('stats.top5.not-configured')}</p>`);
}
$('#dashRefresh').addEventListener('click', loadDashboard);

/* ---------- Statut / progression ---------- */
let pollTimer = null;
// Identité du job en cours : sert à détecter le DÉMARRAGE d'un job (et pas seulement sa
// fin) pour rafraîchir les listes — sans ça, lancer une itération laissait la carte sur
// son ancien statut (« poussée ») jusqu'au rechargement de la page.
let lastSeenJobId = null;

// Polling auto des listes, à l'intervalle configuré (auto_refresh_minutes). Le serveur
// interroge GitLab de son côté ; le front ne fait que relire la base locale (pas d'appel
// API GitLab supplémentaire). Reconfiguré automatiquement quand la config change.
let autoRefreshPoll = null;
let autoRefreshMin = -1; // -1 = pas encore initialisé
function setupAutoRefreshPolling(minutes) {
  const m = Number(minutes) || 0;
  if (m === autoRefreshMin) return; // inchangé
  autoRefreshMin = m;
  if (autoRefreshPoll) { clearInterval(autoRefreshPoll); autoRefreshPoll = null; }
  if (m <= 0) return;
  autoRefreshPoll = setInterval(() => {
    loadToReview().catch(() => {});
    if (currentSeg !== 'to_review') loadReports(currentSeg).catch(() => {});
    refreshStatus();
  }, m * 60 * 1000);
}
/* ---------- « Ça tourne » attaché à l'objet concerné ----------
   Sans ça, l'information « un traitement est en cours » vit dans le pied de page, loin de la
   MR ou de la session qu'elle concerne : il faut faire le lien de tête. On marque donc la
   carte elle-même. Trois garde-fous, sinon le remède devient le mal :
   — au plus un objet par job en cours (le serveur ne renvoie que la MR courante d'un lot) ;
   — rien ne s'anime quand l'onglet est en arrière-plan (batterie, et personne ne regarde) ;
   — filet purement statique en mouvement réduit (cf. la règle @media dans style.css). */
let ciblesEnCours = null; // dernières cibles connues, réappliquées après un re-rendu de liste
/* Un objet qui SORT de la liste des cibles en cours vient de finir. C'est le seul signal fiable
   depuis que plusieurs jobs tournent de front : le bloc « job terminé » plus bas ne se déclenche
   que quand la file entière est vide, donc un job qui finit pendant qu'un autre tourne ne
   rafraîchissait aucune liste — la carte gardait son ancien état, badge d'erreur compris. */
function objetsTermines(avant, apres) {
  const set = (t, k) => new Set(((t || {})[k]) || []);
  const partis = (k) => [...set(avant, k)].filter((id) => !set(apres, k).has(id));
  return { mrs: partis('mrs'), tasks: partis('tasks'), locals: partis('locals') };
}
function marquerEnCours(targets) {
  const fini = objetsTermines(ciblesEnCours, targets);
  if (fini.tasks.length || fini.locals.length) { if ($('#tab-task').classList.contains('active')) loadTasks(); }
  if (fini.mrs.length && $('#tab-review').classList.contains('active')) loadSegment(currentSeg);
  ciblesEnCours = targets;
  const t = targets || { mrs: [], tasks: [], locals: [] };
  const veut = new Set([
    ...(t.mrs || []).map((id) => `[data-id="${id}"]`),
    ...(t.tasks || []).map((id) => `[data-task="${id}"]`),
    ...(t.locals || []).map((id) => `[data-local="${id}"]`),
  ]);
  const vise = new Set();
  for (const sel of veut) for (const el of $$(`.card${sel}`)) vise.add(el);
  for (const el of $$('.card.running-now')) if (!vise.has(el)) el.classList.remove('running-now');
  for (const el of vise) el.classList.add('running-now');
  document.body.classList.toggle('tab-cachee', document.hidden);
}
document.addEventListener('visibilitychange', () => document.body.classList.toggle('tab-cachee', document.hidden));

async function refreshStatus() {
  try {
    const s = await api('/status');
    marquerEnCours(s.running ? s.targets : null);
    jiraConfigured = !!s.jiraConfigured;
    setupAutoRefreshPolling(s.autoRefreshMinutes); // (re)configure le polling front si besoin
    /* Cadence Jenkins : relue à chaque état, donc changer le réglage s'applique tout de suite.
       Absente (vieux serveur) → on garde la valeur en cours plutôt que de couper le sondage. */
    if (s.jenkinsRefreshMinutes !== undefined) {
      const ms = Number(s.jenkinsRefreshMinutes) > 0 ? Number(s.jenkinsRefreshMinutes) * 60000 : 0;
      if (ms !== jkPeriodeMs) { jkPeriodeMs = ms; jkAutoRelance(); }
    }
    $('#dryBadge').hidden = !s.dryRun;
    const job = s.job;
    const running = s.running;
    const queued = s.queued || 0;
    /* Un nouveau job vient de démarrer : les statuts affichés (session, projet) sont
       déjà périmés. On recharge la liste concernée tout de suite, comme on le fait
       déjà à la fin d'un job. */
    if (running && job && job.id !== lastSeenJobId) {
      lastSeenJobId = job.id;   // n'est consommé qu'une fois le job RÉELLEMENT démarré
      if ($('#tab-task').classList.contains('active')) loadTasks();
      if ($('#tab-review').classList.contains('active')) loadSegment(currentSeg);
    }
    if (running && job) {
      // barre de progression intégrée au panneau de log (plus de bloc séparé)
      $('#logBar').hidden = false;
      const pct = job.total ? Math.round((job.done_count / job.total) * 100) : 0;
      $('#progressBar').style.width = pct + '%';
      document.title = tr('job.doc-title', { done: job.done_count, total: job.total, wait: queued ? ` (+${queued})` : '' });
      setFavicon('busy');
    } else {
      $('#logBar').hidden = true;
      $('#progressBar').style.width = '0%';
      document.title = 'Mergerie';
      setFavicon(job && job.status === 'error' ? 'error' : 'idle');
      if (job && ['done', 'stopped', 'error'].includes(job.status) && pollTimer) {
        // job vient de finir : rafraîchir les listes ET le détail ouvert
        const avant = new Map(reportRows.map((m) => [m.id, m.note && m.note.raw]));
        loadToReview();
        if (currentSeg !== 'to_review') loadReports(currentSeg).then(() => signalerAtterrissage(avant));
        if ($('#tab-task').classList.contains('active')) loadTasks();
        // action Docker terminée (up/restart/down…) → recharger la liste pour voir le nouvel état
        if ($('#tab-docker').classList.contains('active')) loadDocker();
        // `keep` : ne réécrit l'écran que si quelque chose d'affiché a changé.
        if (selectedMr) openReport(selectedMr, { keep: true });
        annoncerFinDeJob(job);
        rafraichirHistCount();          // « N terminés » sur le bouton Activité
        if (logHistOpen) renderLogHist();
      }
    }
    // Poll tant qu'un job occupe la file (en cours OU en attente). Les deux conditions
    // doivent être SYMÉTRIQUES : sinon on crée le timer puis on le détruit dans la foulée.
    const fileActive = running || queued > 0;
    if (fileActive && !pollTimer) pollTimer = setInterval(refreshStatus, 1500);
    if (!fileActive && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // log en direct (récupère aussi les dernières lignes après la fin)
    pumpLog();
  } catch (e) { /* silencieux */ }
}

/* ---------- L'atterrissage du résultat ----------
   Une review qui a tourné trois minutes se terminait en silence : la favicon repassait au
   repos, le panneau se repliait six secondes plus tard, et une carte changeait de place sans
   un mot. Le paiement de la boucle centrale du produit était muet.
   Ce qui rend une récompense supportable au 200ᵉ jour, c'est qu'elle soit MÉRITÉE et
   PROPORTIONNÉE : elle suit ici plusieurs minutes de travail réel, elle est unique par job,
   et elle ne vole ni le focus ni un clic. */
const atterrisSignales = new Set();

function annoncerFinDeJob(job) {
  if (!job || atterrisSignales.has(`job:${job.id}`)) return;
  atterrisSignales.add(`job:${job.id}`);
  if (job.status !== 'done') return;                 // un échec a déjà son bandeau rouge
  const cle = { review: 'job.landed.review', rereview: 'job.landed.review', task: 'job.landed.task',
    local: 'job.landed.task', converge: 'job.landed.converge', 'converge-session': 'job.landed.converge' }[job.kind];
  if (!cle) return;                                  // git, docker… : le résultat est déjà à l'écran
  toast(tr(cle, { n: job.total || 1, count: job.total || 1 }));
}

/* Les MR dont la note vient d'apparaître ou de changer : un balayage unique sur la PASTILLE,
   pas sur la carte — c'est la note qui est le résultat. Plafonné, joué une seule fois par
   MR, et jamais rejoué : sans ces trois gardes, ce serait un stroboscope à chaque poll. */
function signalerAtterrissage(avant) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let n = 0;
  for (const m of reportRows) {
    const note = m.note && m.note.raw;
    if (!note || avant.get(m.id) === note) continue;
    if (atterrisSignales.has(`mr:${m.id}:${note}`)) continue;
    atterrisSignales.add(`mr:${m.id}:${note}`);
    if (n++ >= 3) break;                             // trois au plus : au-delà c'est du bruit
    const el = $(`#reportList .card[data-id="${m.id}"] .note`);
    if (!el) continue;
    el.classList.add('just-landed');
    el.addEventListener('animationend', () => el.classList.remove('just-landed'), { once: true });
  }
}

/* ---------- Log en direct du job ---------- */
let logJobId = null;
let logHidden = false;
// Repli auto d'un job terminé : on ne veut pas que le bandeau reste collé en haut de tous les onglets.
let autoHideJobId = null;
let autoHideTimer = null;
let lastJobStatus = null; // dernière issue connue (done/error/stopped…) → pastille du bouton « journal »

// Rouvre le panneau de log (masqué par « masquer » ou par le repli auto).
function showLogPanel() {
  const p = $('#logPanel');
  if (p) { p.hidden = false; logHidden = false; clearTimeout(autoHideTimer); if (!logExpanded) $('#logToggle').click(); }
  updateFooterLogs();
}
// Bouton « journal » du bandeau : visible seulement quand un job a tourné ET que le panneau est
// masqué (sinon il ferait doublon). La pastille rappelle l'issue du dernier job.
function updateFooterLogs() {
  const b = $('#footerLogs');
  if (!b) return;
  b.hidden = !(logJobId && $('#logPanel').hidden);
  b.classList.toggle('st-done', lastJobStatus === 'done');
  b.classList.toggle('st-error', lastJobStatus === 'error');
}

/* Coloration d'une ligne de journal. La détection d'erreur reste volontairement large et
   couvre les deux langues du serveur : elle ne sert qu'à teinter, jamais à décider — se
   tromper met une ligne en rouge, pas en péril. */
function logLineClass(t) {
  if (t.startsWith('$ ')) return 'cmd';
  if (t.startsWith('===') || t.includes('────')) return 'hdr';
  if (/ERREUR|ERROR|❌|fatal|failed|échec|\berror\b/i.test(t)) return 'err';
  return '';
}

/* ---------- Un volet de journal PAR JOB ----------
   Deux jobs peuvent tourner ensemble (voir « Lancer en parallèle ») : chacun garde son
   propre volet, donc sa position de défilement et ses lignes. Changer d'onglet ne rejoue
   rien — on montre l'autre volet, c'est tout. */
/* `shown` : les jobs dont l'onglet reste affiché. Un job TERMINÉ y reste — c'est le moment
   où l'on veut lire sa sortie, surtout s'il a échoué. Il ne disparaît qu'au démarrage d'un
   job vraiment nouveau, qui remet le panneau à zéro.
   `state` retient le statut final de chacun : c'est lui qui colore l'onglet et qui dit
   quand cesser de l'interroger. */
const TERMINAL = new Set(['done', 'error', 'stopped']);
const LOGP = { after: new Map(), active: null, shown: [], state: new Map() };

function logReset() {
  $('#logBox').innerHTML = '';
  LOGP.after.clear(); LOGP.state.clear();
  LOGP.shown = []; LOGP.active = null;
}

function logPane(jobId) {
  const box = $('#logBox');
  let pane = $(`.logpane[data-job="${jobId}"]`, box);
  if (!pane) {
    pane = document.createElement('pre');
    pane.className = 'logpane';
    pane.dataset.job = jobId;
    box.appendChild(pane);
  }
  return pane;
}
let logPaneEpingle = null; // job passé qu'on est en train de relire (cf. pumpLog)
function showLogPane(jobId) {
  LOGP.active = jobId;
  for (const pane of $$('#logBox .logpane')) pane.hidden = Number(pane.dataset.job) !== jobId;
  for (const b of $$('#logTabs [data-jobtab]')) b.classList.toggle('active', Number(b.dataset.jobtab) === jobId);
}

// Récupère les nouvelles lignes d'UN job et les ajoute à son volet.
/* Ajout des lignes d'un lot : UN seul passage dans le DOM, et un plafond.
   Avant, c'était un `appendChild` par ligne dans un `<pre>` sans limite : un `docker compose
   build` ou une session d'agent bavarde y déversait des dizaines de milliers de nœuds, et le
   panneau finissait par ramer précisément quand on le regardait travailler.
   L'élagage se fait par la TÊTE : la fin d'un job est ce qui compte. Une ligne persistante
   dit ce qui a été retiré — un journal tronqué en silence ferait douter de ce qu'on lit. */
const LOG_MAX_NODES = 4000;
function appendLogLines(pane, lines) {
  if (!lines.length) return;
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    const span = document.createElement('span');
    const cls = logLineClass(l.text);
    if (cls) span.className = cls;
    span.textContent = l.text + '\n';
    frag.appendChild(span);
  }
  pane.appendChild(frag);
  let over = pane.childElementCount - LOG_MAX_NODES;
  if (over <= 0) return;
  let head = pane.querySelector('.log-trunc');
  if (!head) { head = document.createElement('span'); head.className = 'log-trunc'; }
  let coupees = Number(head.dataset.n || 0);
  while (over-- > 0) {
    const first = pane.firstElementChild;
    if (!first || first === head) break;
    first.remove(); coupees += 1;
  }
  head.dataset.n = coupees;
  head.textContent = `${tr('job.log.truncated', { n: coupees, count: coupees })}\n`;
  pane.prepend(head);
}

async function pumpOne(jobId) {
  const after = LOGP.after.get(jobId) || 0;
  let d;
  try { d = await api(`/jobs/${jobId}/log?after=${after}`); } catch { return null; }
  const pane = logPane(jobId);
  appendLogLines(pane, d.lines);
  if (d.lines.length) LOGP.after.set(jobId, d.lines[d.lines.length - 1].id);
  if (d.lines.length && logExpanded && $('#logAutoscroll').checked && !pane.hidden) pane.scrollTop = pane.scrollHeight;
  return d;
}

/* Onglets : un par job du lot courant, terminés compris. Masqués tant qu'il n'y en a qu'un —
   un onglet solitaire n'apprend rien et vole une ligne au journal. La pastille reprend le
   vocabulaire du bandeau : ambre en cours, vert terminé, rouge en erreur, gris arrêté. */
function renderLogTabs(ids, main) {
  const bar = $('#logTabs');
  bar.hidden = ids.length < 2;
  if (bar.hidden) { bar.innerHTML = ''; return; }
  /* L'onglet est une ENVELOPPE, pas un bouton : il en contient deux (choisir / arrêter), et
     un bouton dans un bouton n'existe pas en HTML. L'arrêt n'est proposé que sur un job qui
     tourne encore — sur un job fini, il n'aurait rien à arrêter. */
  bar.innerHTML = ids.map((id) => {
    const st = LOGP.state.get(id) || 'running';
    const cls = ['jobtab', st === 'running' ? 'running' : st, id === LOGP.active ? 'active' : ''].filter(Boolean).join(' ');
    const nom = id === main ? tr('job.tab.main') : tr('job.tab.parallel');
    return `<span class="${cls}" data-jobtab="${id}">`
      + `<button type="button" class="jobtab-pick" title="${esc(tr(`job.tab.state.${st}`))}">`
      + `<span class="dot"></span>${esc(nom)} <span class="muted">#${id}</span></button>`
      + (st === 'running'
        ? `<button type="button" class="jobtab-stop" data-jobstop="${id}" title="${esc(tr('job.tab.stop', { name: nom }))}" aria-label="${esc(tr('job.tab.stop', { name: nom }))}"><svg class="ico ico-sm"><use href="#i-stop"/></svg></button>`
        : '')
      + '</span>';
  }).join('');
  for (const b of $$('#logTabs .jobtab-pick')) {
    b.addEventListener('click', () => { logPaneEpingle = null; showLogPane(Number(b.closest('[data-jobtab]').dataset.jobtab)); });
  }
  for (const b of $$('#logTabs [data-jobstop]')) {
    b.addEventListener('click', async () => {
      const id = Number(b.dataset.jobstop);
      // Confirmation comme pour le Stop global : arrêter n'est pas un geste de navigation.
      if (!await confirmDialog({ text: tr('confirm.job-stop-one', { id }), confirmLabel: tr('job.btn.stop') })) return;
      try { await busy(b, () => api(`/jobs/${id}/stop`, { method: 'POST' })); refreshStatus(); }
      catch (e) { toast(explainError(e.message), true); }
    });
  }
}

async function pumpLog() {
  let d;
  const cur = LOGP.after.get(logJobId) || 0;
  try { d = await api(`/jobs/current/log?after=${cur}&expect=${logJobId || 0}`); } catch { return; }
  // Aucun job : on arrête le compteur, sinon son intervalle survivrait au dernier job.
  if (!d.job_id) { jobClock = { started: null, finished: null, running: false, done: 0, total: 0 }; syncJobClock(); return; }
  const panel = $('#logPanel');
  /* On ne remet le panneau à zéro que pour un job VRAIMENT nouveau. Le job « courant » peut
     changer sans que rien ne commence : le principal se termine, un job parallèle devient
     le plus récent en cours. Effacer là ferait disparaître le journal du principal en pleine
     lecture. Tant que le job est déjà suivi, on se contente de changer qui est « principal ». */
  if (!LOGP.shown.includes(d.job_id)) { logReset(); logHidden = false; }
  logJobId = d.job_id;
  if (!logHidden) panel.hidden = false;
  const pane = logPane(d.job_id);
  appendLogLines(pane, d.lines);
  if (d.lines.length) LOGP.after.set(d.job_id, d.lines[d.lines.length - 1].id);
  LOGP.state.set(d.job_id, d.status);
  if (!LOGP.shown.includes(d.job_id)) LOGP.shown.push(d.job_id);
  // Tout job en cours rejoint le lot affiché ; aucun n'en sort avant le prochain lot.
  for (const id of d.running_ids || []) if (!LOGP.shown.includes(id)) LOGP.shown.push(id);
  /* On interroge les autres jobs du lot tant qu'ils n'ont pas fini. Un job terminé garde son
     onglet et son journal, mais on cesse de le solliciter — il ne produira plus rien. */
  for (const id of LOGP.shown) {
    if (id === d.job_id || TERMINAL.has(LOGP.state.get(id))) continue;
    const r = await pumpOne(id);
    if (r && r.status) LOGP.state.set(id, r.status);
  }
  const ids = LOGP.shown;
  /* Un job passé ouvert depuis le journal d'activité ÉPINGLE la vue : sans ça, le suivi du job
     courant la reprenait au sondage suivant — on cliquait « revoir le journal », on lisait trois
     secondes, et l'écran repartait ailleurs. Cliquer un onglet vivant relâche l'épingle. */
  if (logPaneEpingle != null && !ids.includes(logPaneEpingle)) {
    renderLogTabs(ids, d.job_id);
    showLogPane(logPaneEpingle);
    return;
  }
  logPaneEpingle = null;
  if (LOGP.active == null || !ids.includes(LOGP.active)) LOGP.active = d.job_id;
  renderLogTabs(ids, d.job_id);
  showLogPane(LOGP.active);
  const st = $('#logStatus');
  const running = d.running && d.status === 'running';
  st.className = 'logstatus ' + (running ? 'running' : (d.status === 'error' ? 'error' : (d.status === 'done' ? 'done' : '')));
  const wait = d.queued ? ` · ${tr('job.waiting', { n: d.queued })}` : '';
  /* Le bandeau décrit UN job — celui qui a son onglet actif. Avec plusieurs jobs en cours il
     mentirait par omission : on annonce donc combien tournent, l'onglet disant lequel on lit. */
  const plusieurs = ids.length > 1 ? ` · ${tr('job.running-n', { n: ids.length, count: ids.length })}` : '';
  const label = running
    ? `${tr('job.in-progress', { done: d.done_count || 0, total: d.total || 0, message: d.message || '' })}${plusieurs}${wait}`
    : (d.status === 'done' ? (d.message ? tr('job.done', { message: d.message }) : tr('job.done.bare'))
      : (d.status === 'error' ? (d.message ? tr('job.error', { message: d.message }) : tr('job.error.bare')) : (d.status === 'stopped' ? (d.message ? tr('job.stopped', { message: d.message }) : tr('job.stopped.bare')) : d.status)));
  st.innerHTML = `<span class="dot"></span>${esc(label)}`;
  jobClock = { started: d.started_at || null, finished: d.finished_at || null, running, done: d.done_count || 0, total: d.total || 0 };
  syncJobClock();
  const stopBtn = $('#logStop');
  stopBtn.hidden = !running;
  /* Ce bouton arrête TOUT et vide la file. Tant qu'un seul job tournait, « le job en cours »
     était exact ; à plusieurs il faut le dire, sinon on croit n'arrêter que ce qu'on lit. */
  stopBtn.title = ids.length > 1 ? tr('job.stop.all-title', { n: ids.length }) : tr('job.stop.one-title');
  /* « Relancer » ne s'affiche que sur un job qui n'est pas allé au bout ET dont le serveur
     sait rejouer l'intention. Le bandeau disait « arrêté » et laissait deviner où cliquer. */
  const retry = $('#logRetry');
  if (retry) { retry.hidden = running || !d.can_retry; retry.dataset.job = d.job_id; }
  if (d.lines.length && logExpanded && $('#logAutoscroll').checked && !pane.hidden) pane.scrollTop = pane.scrollHeight;
  // Repli auto quelques secondes après un job TERMINÉ (succès ou arrêt) : le panneau ne doit
  // pas rester collé en haut de tous les onglets. On garde l'ERREUR affichée (elle appelle une
  // action) et on ne masque pas si l'utilisateur a déplié le journal pour le lire.
  if (running) { autoHideJobId = null; clearTimeout(autoHideTimer); }
  else if ((d.status === 'done' || d.status === 'stopped') && d.job_id && autoHideJobId !== d.job_id) {
    autoHideJobId = d.job_id;
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(() => {
      // logHidden = true : empêche un pumpLog ultérieur (déclenché par une action) de ré-afficher
      // le job déjà terminé. Un NOUVEAU job réinitialise logHidden et ré-affiche le panneau.
      if (!logExpanded && !logHidden) { panel.hidden = true; logHidden = true; updateFooterLogs(); }
    }, 6000);
  }
  lastJobStatus = d.status;
  updateLogQueueBtn(d.queued || 0);
  if (logQueueOpen) renderLogQueue();
  updateFooterLogs();
}

/* ---------- File d'attente : voir ce qui attend, et doubler la file ----------
   Le bandeau annonçait « +3 en attente » sans dire QUOI. On peut maintenant ouvrir la
   liste et lancer un job précis à côté de celui en cours — à condition qu'il ne touche
   pas les mêmes dépôts, ce que le serveur vérifie et refuse le cas échéant. */
let logQueueOpen = false;

const JOB_KIND_LABEL = {
  review: 'job.kind.review', rereview: 'job.kind.rereview', modify: 'job.kind.modify',
  explain: 'job.kind.explain', task: 'job.kind.task', local: 'job.kind.local',
  gitops: 'job.kind.gitops', docker: 'job.kind.docker',
  converge: 'job.kind.converge', 'converge-session': 'job.kind.converge',
};
const jobKindLabel = (k) => (JOB_KIND_LABEL[k] ? tr(JOB_KIND_LABEL[k]) : k);

/* ---------- Journal d'activité ----------
   Répond à « qu'est-ce que j'avais lancé, et qu'est-ce qui est fini ? » sans ouvrir les sept
   onglets un par un. Il ne double pas les notifications : celles-ci ne vivent qu'en mémoire du
   serveur et le front saute volontairement l'historique au chargement — donc tout ce qui s'est
   terminé onglet fermé n'existait nulle part. La table `job`, elle, persiste.
   Le curseur est PAR NAVIGATEUR (localStorage) : c'est bien « depuis MA dernière visite ». */
let logHistOpen = false;
const HIST_KEY = 'aidevtools_hist_vu';
const histVu = () => { try { return Number(localStorage.getItem(HIST_KEY)) || 0; } catch { return 0; } };
const setHistVu = (id) => { try { localStorage.setItem(HIST_KEY, String(id)); } catch { /* ignore */ } };

const JOB_FINI = ['done', 'stopped', 'error'];
function jobDuree(j) {
  if (!j.started_at || !j.finished_at) return '';
  const ms = new Date(j.finished_at) - new Date(j.started_at);
  if (!(ms > 0)) return '';
  return ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
}
const JOB_STATUT = { done: 'ok', error: 'bad', stopped: 'mid', running: 'mid', queued: '' };

async function renderLogHist() {
  const box = $('#logHist');
  if (!box || !logHistOpen) return;
  let d;
  try { d = await api('/jobs/history?limit=40'); } catch (e) { box.innerHTML = errorBox(e.message); return; }
  if (!d.jobs.length) { box.innerHTML = `<p class="muted">${esc(tr('job.hist.empty'))}</p>`; return; }
  const vu = histVu();
  box.innerHTML = d.jobs.map((j) => {
    const neuf = JOB_FINI.includes(j.status) && j.id > vu;
    const duree = jobDuree(j);
    return `<div class="log-queue-row${neuf ? ' hist-neuf' : ''}">
      <span class="note ${JOB_STATUT[j.status] || ''}">${esc(tr(`job.status.${j.status}`))}</span>
      <span class="tag">${esc(jobKindLabel(j.kind))}</span>
      <span class="log-queue-what">${j.label ? `<button class="linklike" data-histgo="${j.id}">${esc(j.label)}</button>` : '<span class="muted">—</span>'}</span>
      <span class="spacer"></span>
      ${duree ? `<span class="muted">${esc(duree)}</span>` : ''}
      <span class="muted hist-quand">${esc(j.finished_at ? fmtDateTime(j.finished_at) : '')}</span>
      <button class="btn btn-icon btn-sm" data-histlog="${j.id}" title="${esc(tr('job.hist.log'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg></button>
    </div>`;
  }).join('');
  // Ouvrir le journal, c'est l'avoir lu : le compteur retombe.
  setHistVu(d.latest);
  majHistCount(d);
  for (const b of $$('#logHist [data-histgo]')) {
    b.addEventListener('click', () => {
      const j = d.jobs.find((x) => String(x.id) === b.dataset.histgo);
      if (j && j.href) allerVersObjet(j.href);
    });
  }
  for (const b of $$('#logHist [data-histlog]')) {
    b.addEventListener('click', () => ouvrirLogJob(Number(b.dataset.histlog)));
  }
}

// Mène à l'objet d'un job : la bonne liste, le bon stade, la bonne carte.
function allerVersObjet(href) {
  if (!href) return;
  if (href.kind === 'mr') { navTab('review'); openReport(href.id); return; }
  navTab('task');
  const sub = href.kind === 'local' ? 'local' : (href.kind === 'explore' ? 'explore' : 'code');
  const b = $(`#tab-task .subnav [data-kind="${sub}"]`);
  if (b) b.click();
  setTimeout(() => {
    const sel = href.kind === 'local' ? `[data-local="${href.id}"]` : `[data-task="${href.id}"]`;
    const c = $(`.card${sel}`);
    if (c) { c.scrollIntoView({ block: 'center' }); c.classList.add('focused'); }
  }, 300);
}

/* Relire le journal d'un job passé. On réutilise le MÉCANISME DE VOLETS du panneau — un volet
   par job — au lieu d'écrire dans le conteneur : sinon le suivi du job en cours écraserait ce
   qu'on vient d'afficher au sondage suivant. Le volet est rempli une fois puis simplement montré. */
async function ouvrirLogJob(id) {
  try {
    const d = await api(`/jobs/${id}/log`);
    showLogPanel();
    const pane = logPane(id);
    pane.innerHTML = '';
    appendLogLines(pane, d.lines || []);   // objets {text}, pas des chaînes
    logPaneEpingle = id;
    showLogPane(id);
    pane.scrollTop = pane.scrollHeight;
  } catch (e) { toast(explainError(e.message), true); }
}

// Compteur « terminés depuis ta dernière visite » sur le bouton.
function majHistCount(d) {
  const el = $('#logHistCount');
  if (!el || !d) return;
  const vu = histVu();
  const n = (d.jobs || []).filter((j) => JOB_FINI.includes(j.status) && j.id > vu).length;
  el.textContent = n;
  el.hidden = !n;
}
async function rafraichirHistCount() {
  try { majHistCount(await api('/jobs/history?limit=40')); } catch { /* silencieux */ }
}

async function renderLogQueue() {
  const box = $('#logQueue');
  if (!box || !logQueueOpen) return;
  let d;
  try { d = await api('/jobs/queue'); } catch (e) { box.innerHTML = errorBox(e.message); return; }
  if (!d.queued.length) { box.innerHTML = `<p class="muted">${esc(tr('job.queue.empty'))}</p>`; return; }
  box.innerHTML = d.queued.map((j) => {
    const bloque = j.conflicts.length ? tr('job.queue.conflict', { ids: j.conflicts.join(', ') })
      : (d.parallelBusy ? tr('job.queue.busy') : '');
    return `<div class="log-queue-row">
      <span class="tag">${esc(jobKindLabel(j.kind))}</span>
      <span class="muted">#${j.id}</span>
      <span class="log-queue-what">${esc(j.total ? tr('job.queue.count', { n: j.total, count: j.total }) : '')}</span>
      <span class="spacer"></span>
      ${bloque ? `<span class="muted log-queue-why" title="${esc(bloque)}">${esc(bloque)}</span>`
    : `<button class="btn btn-sm" data-jobnow="${j.id}" title="${esc(tr('job.queue.now-title'))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('job.queue.now'))}</button>`}
      <button class="btn btn-icon btn-sm btn-danger" data-jobcancel="${j.id}" title="${esc(tr('job.queue.cancel-title'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
    </div>`;
  }).join('');
  for (const b of $$('#logQueue [data-jobnow]')) {
    b.addEventListener('click', () => busy(b, () => api(`/jobs/${b.dataset.jobnow}/start-now`, { method: 'POST' }))
      .then(() => { toast(tr('job.queue.started')); refreshStatus(); renderLogQueue(); })
      .catch((e) => toast(explainError(e.message), true)));
  }
  for (const b of $$('#logQueue [data-jobcancel]')) {
    b.addEventListener('click', async () => {
      if (!await confirmDialog({ text: tr('job.queue.confirm-cancel'), confirmLabel: tr('job.queue.cancel-ok') })) return;
      try { await api(`/jobs/${b.dataset.jobcancel}/stop`, { method: 'POST' }); renderLogQueue(); refreshStatus(); }
      catch (e) { toast(explainError(e.message), true); }
    });
  }
}

function updateLogQueueBtn(queued) {
  const btn = $('#logQueueBtn');
  if (!btn) return;
  btn.hidden = !queued;
  $('#logQueueCount').textContent = queued;
  if (!queued) { logQueueOpen = false; $('#logQueue').hidden = true; }
}
$('#logHistBtn') && $('#logHistBtn').addEventListener('click', () => {
  logHistOpen = !logHistOpen;
  $('#logHist').hidden = !logHistOpen;
  if (logHistOpen) { logQueueOpen = false; $('#logQueue').hidden = true; renderLogHist(); }
});

$('#logQueueBtn') && $('#logQueueBtn').addEventListener('click', () => {
  logQueueOpen = !logQueueOpen;
  if (logQueueOpen) { logHistOpen = false; $('#logHist').hidden = true; }
  $('#logQueue').hidden = !logQueueOpen;
  if (logQueueOpen) renderLogQueue();
});

/* ---------- Temps écoulé du job ----------
   Une review sur trente MR peut tourner un quart d'heure : sans compteur, impossible de
   savoir si le job avance depuis dix secondes ou depuis dix minutes. On mesure à partir du
   `started_at` renvoyé par le SERVEUR, pas d'un chrono démarré à l'ouverture de la page —
   un onglet ouvert en cours de job afficherait sinon un temps faux.
   Une fois le job terminé, la valeur se fige sur la durée totale. */
let jobClock = { started: null, finished: null, running: false, done: 0, total: 0 };
let elapsedTimer = null;

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return (h ? `${h}:${two(Math.floor((s % 3600) / 60))}` : `${Math.floor(s / 60)}`) + `:${two(s % 60)}`;
}

/* Estimation de fin. « 4/30 » et « 03:12 » ne disent pas s'il reste deux minutes ou vingt :
   attendre avec un horizon et attendre à l'aveugle sont deux expériences différentes.
   Trois précautions, parce qu'une estimation fausse est PIRE que pas d'estimation :
     — au moins deux unités faites (la première MR d'un lot n'est jamais représentative) ;
     — arrondi grossier, jamais un décompte à la seconde ;
     — si l'estimation dévie de plus de moitié, on la RETIRE au lieu de la corriger d'un bond.
   Toujours précédée d'un « ≈ ». */
let etaLast = 0;
function etaText() {
  const { started, running, done, total } = jobClock;
  if (!running || !started || !total || done < 2 || done >= total) { etaLast = 0; return ''; }
  const ecoule = Date.now() - Date.parse(started);
  if (ecoule < 20000) { etaLast = 0; return ''; }
  const reste = (ecoule / done) * (total - done);
  if (etaLast && Math.abs(reste - etaLast) > etaLast * 0.5) { etaLast = reste; return ''; }
  etaLast = reste;
  const min = reste / 60000;
  const pas = min < 1 ? tr('job.eta.30s') : min < 2 ? tr('job.eta.min', { n: 1 })
    : min < 7 ? tr('job.eta.min', { n: 5 }) : min < 15 ? tr('job.eta.min', { n: 10 })
      : tr('job.eta.long');
  return ` ≈ ${pas}`;
}

function paintElapsed() {
  const el = $('#logElapsed');
  if (!el) return;
  if (!jobClock.started) { el.hidden = true; return; }
  const end = jobClock.running ? Date.now() : Date.parse(jobClock.finished || jobClock.started);
  el.hidden = false;
  el.textContent = fmtElapsed(end - Date.parse(jobClock.started)) + etaText();
  el.title = tr(jobClock.running ? 'job.elapsed.running' : 'job.elapsed.total');
}

/* Le timer n'existe QUE pendant qu'un job tourne. La condition de création et celle de
   destruction sont volontairement la même expression : dissymétriques, elles créaient puis
   détruisaient l'intervalle à chaque appel. */
function syncJobClock() {
  paintElapsed();
  const want = !!(jobClock.running && jobClock.started);
  if (want && !elapsedTimer) elapsedTimer = setInterval(paintElapsed, 1000);
  if (!want && elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

// repli/dépli du corps des logs (replié par défaut) — l'en-tête (statut) reste visible
let logExpanded = false;
function applyLogCollapsed() {
  $('#logBox').hidden = !logExpanded;
  $('#logToggle').textContent = logExpanded ? '▾' : '▸';
}
$('#logToggle').addEventListener('click', () => {
  logExpanded = !logExpanded; applyLogCollapsed();
  // Le volet VISIBLE est celui qu'on vient de déplier — c'est lui qu'on descend.
  if (logExpanded) { const p2 = $('#logBox .logpane:not([hidden])'); if (p2) p2.scrollTop = p2.scrollHeight; }
});
applyLogCollapsed();

$('#logRetry') && $('#logRetry').addEventListener('click', (e2) => {
  const b2 = e2.currentTarget;
  busy(b2, () => api(`/jobs/${b2.dataset.job}/retry`, { method: 'POST' }))
    .then(() => { toast(tr('job.retry.done')); refreshStatus(); })
    .catch((err) => toast(explainError(err.message), true));
});
$('#logHide').addEventListener('click', () => { $('#logPanel').hidden = true; logHidden = true; updateFooterLogs(); });
$('#footerLogs') && $('#footerLogs').addEventListener('click', showLogPanel);
// On copie le journal AFFICHÉ, pas la concaténation des deux jobs en cours.
$('#logCopy').addEventListener('click', () => {
  const p2 = $('#logBox .logpane:not([hidden])') || $('#logBox');
  // Le texte copié contient déjà la ligne « … tronqué » : on copie ce qu'on voit, sans
  // laisser croire que c'est l'intégralité. Le journal complet reste côté serveur.
  copyText(p2.textContent, $('#logCopy'));
});
$('#logStop').addEventListener('click', async () => {
  // Stop ne se contente pas d'interrompre le job courant : il VIDE aussi la file
  // d'attente. On l'annonce, sinon on perd des jobs sans s'en rendre compte.
  let queued = 0; let progress = '';
  try {
    const s = await api('/status');
    queued = s.queued || 0;
    if (s.job && s.job.total > 1) progress = tr('job.progress', { done: s.job.done_count, total: s.job.total });
  } catch { /* si le statut est indisponible, on demande quand même confirmation */ }
  const msg = tr('confirm.stop.head', { progress })
    + (queued ? tr('confirm.stop.queued', { n: queued, count: queued }) : '.')
    + tr('confirm.stop.tail');
  if (!await confirmDialog({ text: msg, confirmLabel: tr('job.btn.stop') })) return;
  const b = $('#logStop'); b.disabled = true; b.innerHTML = `<svg class="ico"><use href="#i-stop"/></svg>${tr('job.stopping')}`;
  try { await api('/jobs/stop', { method: 'POST' }); toast(tr('toast.arret-demande-process-en-cours')); }
  catch (e) { toast(e.message, true); }
  finally { setTimeout(() => { b.disabled = false; b.innerHTML = `<svg class="ico"><use href="#i-stop"/></svg>Stop`; refreshStatus(); }, 500); }
});

/* ---------- Recherche (filtre client sur titre / auteur / projet / ticket) ---------- */
function matchMr(m, q) {
  return [m.title, m.author, m.project, m.ticket_key, m.source_branch]
    .some((v) => (v || '').toLowerCase().includes(q));
}

/* ---------- À reviewer ---------- */
let toReviewRows = [];
async function loadToReview() {
  toReviewRows = await api('/mrs?status=to_review');
  listeChargee = true;
  renderToReview();
}
function renderToReview() {
  const el = $('#toReviewList');
  const q = ($('#searchReview').value || '').toLowerCase().trim();
  if (!toReviewRows.length) {
    // pas encore configuré → onboarding ; configuré et vide → file à jour
    el.innerHTML = (setupState.checked && (!setupState.configured || !setupState.hasRepos))
      ? onboardingHtml()
      : emptyState({
        icon: 'check',
        title: tr('review.empty.none.title'),
        text: tr('review.empty.all-done'),
        actions: [
          { act: 'discover', label: tr('review.btn.discover'), primary: true },
          { act: 'seg-reviewed', label: tr('review.btn.see-reports') },
        ],
      });
    return;
  }
  const rows = q ? toReviewRows.filter((m) => matchMr(m, q)) : toReviewRows;
  if (!rows.length) {
    el.innerHTML = emptyState({ icon: 'search', title: tr('report.search.none', { q: esc(q) }),
      text: tr('review.search.count', { n: toReviewRows.length, total: toReviewRows.length }),
      actions: [{ act: 'clear-search', label: tr('report.search.clear') }] });
    return;
  }
  /* Signature : tout ce que la carte affiche. Si le rendu est identique on ne touche pas au
     DOM — donc pas de clignotement au rafraîchissement automatique, et les écouteurs déjà
     posés restent valides (d'où le `return` : les recâbler serait du travail pour rien). */
  /* La signature doit couvrir TOUT ce que la carte affiche, sinon un champ modifié reste à
     l'écran dans son ancienne valeur — un dépôt renommé, un ticket rattaché après coup, une
     branche cible changée passeraient inaperçus. */
  const sig = rows.map((m) => [m.id, m.status, m.iid, m.title, m.project, m.author, m.gitlab_created_at,
    m.has_ticket, m.ticket_key, m.ticket_url, m.web_url, m.forge, m.source_branch, m.target_branch,
    (m.risk || []).map((r) => r.label).join(','), m.closed_seen, m.stale, m.last_error,
    /* Le badge de vérification fait partie de ce que la carte affiche : sans lui dans la
       signature, un verdict qui vient de tomber resterait invisible jusqu'au prochain
       changement d'un autre champ. */
    m.verification && [m.verification.id, m.verification.verdict, m.verification.stale,
      m.verification.failed_count, m.verification.detail_source].join(','),
    m.verifiable, mrSelection.has(m.id)].join('\u0001')).join('\u0002');
  if (!renderIfChanged(el, sig, rows.map(mrCard).join(''))) return;
  stagger('#toReviewList .card');
  $$('#toReviewList .mr-pick').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) mrSelection.add(Number(c.value)); else mrSelection.delete(Number(c.value));
    renderMrBulkBar();
  }));
  $$('#toReviewList [data-verify]').forEach((b) => b.addEventListener('click', () => {
    busy(b, () => lancerVerification([Number(b.dataset.verify)]));
  }));
  $$('#toReviewList [data-review]').forEach((b) => b.addEventListener('click', async () => {
    try { await busy(b, () => api(`/mrs/${b.dataset.review}/review`, { method: 'POST' })); toast(tr('toast.review-de-lancee', { iid: b.dataset.iid })); refreshStatus(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
  // Split-button : le caret ouvre le menu de surcharge ponctuelle (avec/sans explication).
  $$('#toReviewList [data-review-menu]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = b.parentElement.querySelector('.split-menu');
    const open = menu.hidden;
    closeSplitMenus();
    menu.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    if (open) {
      // La liste a `overflow: hidden` (coins arrondis) → elle rognerait le menu : on
      // débloque son overflow, et on élève la carte au-dessus des suivantes (l'animation
      // card-in crée un contexte d'empilement par carte, sinon le menu passerait dessous).
      b.closest('.card').classList.add('menu-open');
      const list = b.closest('.list'); if (list) list.classList.add('menu-open');
    }
  }));
  $$('#toReviewList [data-review-run]').forEach((b) => b.addEventListener('click', async () => {
    closeSplitMenus();
    try {
      await busy(b, () => api(`/mrs/${b.dataset.reviewRun}/review`, { method: 'POST', body: { explain: b.dataset.explain } }));
      toast(tr(b.dataset.explain === '1' ? 'toast.review-explain-lancee' : 'toast.review-seule-lancee', { iid: b.dataset.iid }));
      refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('#toReviewList [data-done]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const id = b.dataset.done;
      await busy(b, () => api(`/mrs/${id}/done`, { method: 'POST' }));
      toastUndo(tr('toast.classee-sans-review', { iid: b.dataset.iid }), async () => {
        try { await api(`/mrs/${id}/reopen`, { method: 'POST' }); loadSegment(currentSeg); refreshCounts(); } catch (e) { toast(e.message, true); }
      });
      loadToReview(); refreshCounts();
    }
    catch (e) { toast(explainError(e.message), true); }
  }));
  $$('#toReviewList [data-diff]').forEach((b) => b.addEventListener('click', () => {
    const m = toReviewRows.find((x) => x.id === Number(b.dataset.diff));
    if (m) busy(b, () => openDiffPreview(m));
  }));
  $$('#toReviewList [data-merge]').forEach((b) => b.addEventListener('click', () => {
    const m = toReviewRows.find((x) => x.id === Number(b.dataset.merge));
    if (m) mergeMrFromQueue(m, () => { loadToReview(); refreshCounts(); });
  }));
  $$('#toReviewList [data-ticket]').forEach((b) => b.addEventListener('click', () => openTicket(Number(b.dataset.ticket), b.dataset.title)));
  $$('#toReviewList [data-dev]').forEach((b) => b.addEventListener('click', () => {
    const m = toReviewRows.find((x) => x.id === Number(b.dataset.dev));
    if (!m) { toast(tr('toast.mr-introuvable-dans-la-liste'), true); return; }
    openTaskForMr(m).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true));
  }));
}
// une seule recherche pour les trois stades
/* Debouncé : chaque frappe reconstruisait la liste entière. `debounce` existait déjà et
   servait pour les autres recherches — celle-ci avait été oubliée. */
$('#searchReview').addEventListener('input', debounce(() => (currentSeg === 'to_review' ? renderToReview() : renderReports())));

/* Merge d'une MR depuis la file (sans passer par une review) — pour une MR
   triviale. Confirmation obligatoire (action irréversible et visible par l'équipe).
   Ne marque la MR « traitée » que si le merge a RÉELLEMENT eu lieu : une forge qui
   répond « en attente du pipeline » ne l'a pas encore mergée, on la laisse en file.
   Renvoie true si la MR a été mergée (l'appelant peut alors rafraîchir). */
function mergeMrFromQueue(m, onMerged) {
  openMergeModal({
    url: `/mrs/${m.id}/merge`,
    label: `!${m.iid}`,
    target: m.target_branch,
    forge: m.forge,
    squash: m.squash, removeSourceBranch: m.remove_source_branch,
    onDone: async (r) => {
      if (!r.merged) return;                                  // pipeline en attente : reste en file
      await api(`/mrs/${m.id}/done`, { method: 'POST' }).catch(() => {}); // sort de la file
      if (onMerged) onMerged();
    },
  });
}

// Ferme tous les menus déroulants des split-buttons (review avec/sans explication).
function closeSplitMenus() {
  $$('.split-menu').forEach((m) => { m.hidden = true; });
  $$('[data-review-menu], #taskMdExport').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  // Retire l'élévation (carte) et le déblocage d'overflow (liste) posés à l'ouverture.
  $$('.menu-open').forEach((el) => el.classList.remove('menu-open'));
}
// Un clic n'importe où ailleurs referme les menus ouverts (enregistré une seule fois).
// `.split-menu-wrap` aussi : sans lui, le clic qui OUVRE le menu d'export le refermerait aussitôt.
document.addEventListener('click', (e) => { if (!e.target.closest('.btn-split, .split-menu-wrap')) closeSplitMenus(); });

function mrCard(m) {
  return `<div class="card" data-id="${m.id}">
    ${/* Case à cocher : vérifier ENSEMBLE des MR qui ne valent qu'ensemble (§8). */''}
    <label class="mr-pick-box" title="${esc(tr('verify.pick.mr-title'))}"><input type="checkbox" class="mr-pick" value="${m.id}" ${mrSelection.has(m.id) ? 'checked' : ''} /></label>
    <div class="card-main">
      <div class="title">!${m.iid} — ${esc(m.title || '')}</div>
      <div class="meta">${esc(m.project)}${m.author ? ` · ${esc(m.author)}` : ''}${m.gitlab_created_at ? ` · ${fmtDate(m.gitlab_created_at)}` : ''}</div>
      ${mrLinks(m)}
      <div class="meta branches"><code>${esc(m.source_branch)}</code> <span class="branch-arrow">→</span> <code>${esc(m.target_branch)}</code></div>
      ${/* Les tags sont des MÉTADONNÉES, pas des actions : les laisser dans la rangée de
            boutons décalait celle-ci d'une carte à l'autre selon le nombre de tags. */''}
      <div class="card-tags">
        ${(m.risk || []).map((r) => `<span class="tag risk" title="${esc(tr('mr.risk-title', { pattern: r.path_match }))}">${svgIco('alert')} ${esc(r.label)}</span>`).join('')}
        <span class="tag ${mrStatus(m.status).cls}">${mrStatus(m.status).label}</span>
        ${verifyBadge(m.verification)}
        ${m.closed_seen ? `<span class="tag merged" title="${tr('mr.tag.closed-title', { forge: forgeLabel(m.forge) })}">${svgIco('merge')} ${tr('mr.tag.merged')}</span>` : ''}
        ${m.last_error ? `<span class="tag stale">${tr('mr.tag.error')}</span>` : ''}
      </div>
    </div>
    <div class="card-actions">
    <div class="btn-group">
    <button class="btn" data-diff="${m.id}" title="${tr('mr.btn.diff-title')}"><svg class="ico"><use href="#i-eye"/></svg>${tr('mr.btn.diff')}</button>
    <button class="btn" data-ticket="${m.id}" data-title="!${m.iid} — ${esc(m.title || '')}" title="${tr('mr.btn.context-title')}"><svg class="ico"><use href="#i-doc"/></svg>${m.has_ticket ? tr('mr.btn.context-done') : tr('mr.btn.context')}</button>
    </div>
    <div class="btn-group">
    <button class="btn" data-dev="${m.id}" data-branch="${esc(m.source_branch)}" title="${tr('mr.btn.code-title')}"><svg class=\"ico\"><use href=\"#i-bot\"/></svg>${tr('mr.btn.code')}</button>
    <span class="btn-split">
      <button class="btn btn-primary" data-review="${m.id}" data-iid="${m.iid}" title="${tr('mr.btn.review-title')}"><svg class=\"ico\"><use href=\"#i-play\"/></svg>${tr('mr.btn.review')}</button>
      <button class="btn btn-primary btn-split-caret" data-review-menu="${m.id}" title="${tr('mr.btn.review-opts-title')}" aria-haspopup="true" aria-expanded="false">▾</button>
      <div class="split-menu" hidden role="menu">
        <button role="menuitem" data-review-run="${m.id}" data-iid="${m.iid}" data-explain="1">${tr('mr.btn.review-with-explain')}</button>
        <button role="menuitem" data-review-run="${m.id}" data-iid="${m.iid}" data-explain="0">${tr('mr.btn.review-no-explain')}</button>
      </div>
    </span>
    </div>
    <div class="btn-group">
    <button class="btn" data-verify="${m.id}" ${m.verifiable ? '' : 'disabled'} title="${m.verifiable ? tr('verify.btn.verify-title') : tr('err.verify.no-verifier')}"><svg class="ico"><use href="#i-check"/></svg>${tr('verify.btn.verify')}</button>
    <button class="btn" data-done="${m.id}" data-iid="${m.iid}" title="${tr('mr.btn.dismiss-title')}"><svg class=\"ico\"><use href=\"#i-archive\"/></svg>${tr('mr.btn.dismiss')}</button>
    ${m.closed_seen ? '' : `<button class="btn btn-danger" data-merge="${m.id}" title="${tr('mr.btn.merge-title')}"><svg class="ico"><use href="#i-merge"/></svg>${tr('task.btn.merge')}</button>`}
    </div>
    </div>
  </div>${m.last_error ? errorBox(m.last_error, m.id) : ''}`;
}

$('#btnDiscover').addEventListener('click', async () => {
  const db_ = $('#btnDiscover');
  $('#discoverInfo').textContent = tr('review.discovering');
  db_.dataset.busy = '1'; db_.disabled = true;
  try {
    const r = await api('/discover', { method: 'POST' });
    $('#discoverInfo').textContent = tr('review.discover.result', { found: r.found, created: r.created, updated: r.updated })
      + (r.errors.length ? tr('review.discover.errors', { n: r.errors.length, count: r.errors.length }) : '');
    $('#reviewErrors').innerHTML = r.errors.length
      ? r.errors.map((er) => errorBox(`${er.repo} : ${er.error}`)).join('')
      : '';
    loadToReview();
  } catch (e) { $('#discoverInfo').textContent = ''; $('#reviewErrors').innerHTML = errorBox(e.message); }
  finally { delete db_.dataset.busy; db_.disabled = false; }
});

$('#btnReview').addEventListener('click', async () => {
  const n = toReviewRows.length;
  if (n > 5 && !await confirmDialog({ text: tr('confirm.review-all', { n }), confirmLabel: tr('mr.btn.review'), danger: false })) return;
  const b = $('#btnReview');
  try {
    await busy(b, () => api('/jobs/review', { method: 'POST' }));
    toast(tr('toast.review-de-mr-lancee', { n: n }));
    refreshStatus();
  } catch (e) { toast(explainError(e.message), true); }
});

/* ---------- Rapports ---------- */
let selectedMr = null;
let reportRows = [];

/* ---- Filtre par couleur de note (stades « Reviewées » et « Traitées ») ----
   Trois cases indépendantes : on cherche « les rouges ET les oranges », pas une tranche.
   Tout coché = pas de filtre, et c'est l'état par défaut — un filtre resté actif d'une
   session à l'autre ferait croire à une liste vide. Il survit quand même au rechargement :
   décocher à chaque visite serait pire.

   Une carte SANS note (rapport dont aucune note n'a pu être extraite) n'appartient à aucune
   des trois couleurs. Elle reste visible tant qu'on ne filtre pas ; dès qu'on choisit des
   couleurs, elle sort — demander « les rouges » ne doit pas ramener des cartes grises. */
const NOTE_CLASSES = ['good', 'mid', 'bad'];
let noteFilter = new Set(NOTE_CLASSES);
try {
  const brut = JSON.parse(localStorage.getItem('aidevtools_note_filter') || 'null');
  if (Array.isArray(brut)) {
    const garde = brut.filter((c) => NOTE_CLASSES.includes(c));
    // Un filtre vide n'afficherait rien et n'aurait pas d'issue évidente : on revient à tout.
    if (garde.length) noteFilter = new Set(garde);
  }
} catch { /* stockage indisponible ou valeur illisible : filtre par défaut */ }

const filtreNoteActif = () => noteFilter.size < NOTE_CLASSES.length;
const passeFiltreNote = (m) => !filtreNoteActif() || noteFilter.has(noteClass(m.note));

async function loadReports(status = 'reviewed') {
  reportRows = await api(`/mrs?status=${status}`);
  listeChargee = true;
  renderReports();
}
function renderReports() {
  const el = $('#reportList');
  const q = ($('#searchReview').value || '').toLowerCase().trim();
  majFiltreNote();
  if (!reportRows.length) {
    el.innerHTML = emptyState({ icon: 'doc',
      title: currentSeg === 'done' ? tr('report.empty.done.title') : tr('report.empty.none.title'),
      text: currentSeg === 'done' ? tr('report.empty.done.text') : tr('report.empty.none.text'),
      actions: [{ act: 'seg-to-review', label: tr('report.empty.action'), primary: true }] });
    return;
  }
  const cherchees = q ? reportRows.filter((m) => matchMr(m, q)) : reportRows;
  if (!cherchees.length) {
    el.innerHTML = emptyState({
      icon: 'search',
      title: tr('report.search.none', { q: esc(q) }),
      text: tr('report.search.count', { n: reportRows.length, total: reportRows.length }),
      actions: [{ act: 'clear-search', label: tr('report.search.clear') }],
    });
    return;
  }
  const rows = cherchees.filter(passeFiltreNote);
  /* Tout masqué par les couleurs : le dire, et proposer la sortie. Une liste vide sans
     explication au-dessus de trois cases décochées se lit comme « il n'y a rien ». */
  if (!rows.length) {
    el.innerHTML = emptyState({
      icon: 'search',
      title: tr('review.filter.empty.title'),
      text: tr('review.filter.empty.text', { n: cherchees.length, count: cherchees.length }),
      actions: [{ act: 'clear-note-filter', label: tr('review.filter.clear'), primary: true }],
    });
    return;
  }
  const sig = [selectedMr, ...rows.map((m) => [m.id, m.status, m.iid, m.title, m.project, m.author,
    m.gitlab_created_at, m.ticket_key, m.ticket_url, m.forge, m.note && m.note.raw, m.closed_seen,
    m.stale, m.verifiable, m.verification && [m.verification.id, m.verification.verdict, m.verification.stale,
      m.verification.failed_count, m.verification.detail_source].join(',')].join('\u0001'))].join('\u0002');
  const html = rows.map((m) => `
    <div class="card selectable report-card ${selectedMr === m.id ? 'active' : ''}" data-id="${m.id}">
      ${noteBadge(m.note)}
      <div class="report-main">
        <div class="title">!${m.iid} — ${esc(m.title || '')}</div>
        <div class="meta">${esc(m.project)}${m.author ? ` · ${esc(m.author)}` : ''}${m.gitlab_created_at ? ` · ${fmtDate(m.gitlab_created_at)}` : ''}${ticketLink(m.ticket_url, m.ticket_key)}</div>
        <div class="report-tags">
          <span class="tag ${mrStatus(m.status).cls}">${mrStatus(m.status).label}</span>
          ${verifyBadge(m.verification)}
          ${/* Une MR déjà reviewée se vérifie aussi : la review est un avis, le verdict un fait. */''}
          ${m.verifiable ? `<button class="btn btn-sm" data-verify-report="${m.id}" title="${tr('verify.btn.verify-title')}">${svgIco('check')}${tr('verify.btn.verify')}</button>` : ''}
          ${m.closed_seen ? `<span class="tag merged" title="${tr('mr.tag.closed-title', { forge: forgeLabel(m.forge) })}">${svgIco('merge')} ${tr('mr.tag.merged')}</span>` : ''}
          ${m.stale ? `<span class="tag stale">${tr('mr.tag.stale')}</span>` : ''}
        </div>
      </div>
    </div>`).join('');
  if (!renderIfChanged(el, sig, html)) return;
  stagger('#reportList .card');
  $$('#reportList .card').forEach((c) => c.addEventListener('click', () => openReport(Number(c.dataset.id))));
  // Le bouton vit DANS une carte cliquable : sans cette coupure, vérifier ouvrirait aussi le rapport.
  $$('#reportList [data-verify-report]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    busy(b, () => lancerVerification([Number(b.dataset.verifyReport)]));
  }));
  if (!selectedMr) renderReportPlaceholder();
}
// la recherche est partagée : #searchReview rafraîchit le stade courant

/* Cases et compteurs du filtre de note. Le compteur porte sur ce que la RECHERCHE a laissé,
   pas sur tout le stade : sinon « 3 rouges » resterait affiché à côté d'une liste filtrée
   qui n'en montre aucun. Il se lit donc « en cochant ceci, voilà ce qui apparaît ». */
function majFiltreNote() {
  const boite = $('#noteFilters');
  if (!boite) return;
  const q = ($('#searchReview').value || '').toLowerCase().trim();
  const base = q ? reportRows.filter((m) => matchMr(m, q)) : reportRows;
  const parCouleur = {};
  for (const m of base) {
    const c = noteClass(m.note);
    if (c) parCouleur[c] = (parCouleur[c] || 0) + 1;
  }
  $$('.note-pick', boite).forEach((c) => { c.checked = noteFilter.has(c.value); });
  $$('[data-nf-count]', boite).forEach((s) => { s.textContent = parCouleur[s.dataset.nfCount] || 0; });
  boite.classList.toggle('is-filtering', filtreNoteActif());
  /* Rien à filtrer, rien à montrer : sur un stade vide, trois cases au-dessus d'un message
     « aucun rapport » n'aident personne. (Le stade « À traiter » masque toute la colonne :
     ses cartes n'ont pas de note — une MR n'y revient qu'après suppression de son rapport.) */
  boite.hidden = !reportRows.length;
}

function ecrireFiltreNote() {
  try { localStorage.setItem('aidevtools_note_filter', JSON.stringify([...noteFilter])); } catch { /* ignore */ }
}

function reinitFiltreNote() {
  noteFilter = new Set(NOTE_CLASSES);
  ecrireFiltreNote();
  renderReports();
}

$$('#noteFilters .note-pick').forEach((c) => c.addEventListener('change', () => {
  if (c.checked) noteFilter.add(c.value); else noteFilter.delete(c.value);
  /* Tout décocher afficherait une liste vide dont la sortie n'est pas évidente — la case
     qu'on vient de décocher est la seule à pouvoir la rouvrir. On revient donc à « tout ». */
  if (!noteFilter.size) noteFilter = new Set(NOTE_CLASSES);
  ecrireFiltreNote();
  renderReports();
}));

/* Couleur d'une note. Une seule définition des seuils, partagée par la pastille et par le
   filtre : deux tables de seuils finiraient par diverger, et une carte verte se retrouverait
   masquée en cochant « vert ». `null` = pas de note extraite du rapport. */
function noteClass(note) {
  if (!note || note.value == null) return null;
  return note.value >= 0.7 ? 'good' : (note.value >= 0.4 ? 'mid' : 'bad');
}

// Pastille de note globale colorée (vert = bon, orange = moyen, rouge = mauvais).
function noteBadge(note) {
  const cls = noteClass(note);
  if (!cls) return `<span class="note none" title="${tr('review.note.none')}">—</span>`;
  return `<span class="note ${cls}" title="${esc(tr('review.note.title'))}">${esc(note.raw)}</span>`;
}

$('#btnResetReports').addEventListener('click', async () => {
  if (!await confirmDialog({ text: tr('confirm.reset-all'), confirmLabel: tr('ui.delete') })) return;
  try {
    const r = await api('/reports/reset', { method: 'POST' });
    selectedMr = null;
    renderReportPlaceholder();
    toast(tr('toast.rapport-s-supprime-s-repart', { deleted: r.deleted }));
    loadReports(currentSeg);
    loadToReview();
  } catch (e) { toast(e.message, true); }
});

/* HTML d'une note (auteur, date, corps markdown). Servie telle quelle par les commentaires
   généraux du rapport ET par les fils inline du visualiseur — une seule implémentation.
   `data-raw` garde le Markdown SOURCE : le corps affiché est du HTML rendu, il ne peut pas
   servir à repeupler l'éditeur sans reperdre la mise en forme d'origine. */
function noteHtml(n, mrId) {
  const edit = n.editable && n.id != null
    ? `<button type="button" class="cmt-edit-btn" data-note="${esc(n.id)}" data-mr="${esc(mrId)}"`
      + ` data-inline="${n.position ? 1 : 0}" title="${esc(tr('cmt.edit.title'))}">${tr('cmt.edit.btn')}</button>`
    : '';
  return `<div class="cmt" data-raw="${esc(n.body)}">`
    + `<div class="cmt-head"><b>${esc(n.author)}</b> <span class="muted">${fmtDate(n.created_at)}</span>`
    + `${n.resolved ? ` <span class="tag done">${tr('cmt.resolved')}</span>` : ''}`
    + `<span class="spacer"></span>${edit}</div>`
    + `<div class="cmt-body md">${mdToHtml(n.body)}</div></div>`;
}

/* Modification d'un commentaire déjà posté, en place : le corps rendu cède la place à un
   éditeur pré-rempli du Markdown source. Délégué une fois pour les deux endroits où des
   notes s'affichent — le geste et le rendu y sont identiques. */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cmt-edit-btn');
  if (!btn) return;
  const cmt = btn.closest('.cmt');
  const body = cmt.querySelector('.cmt-body');
  if (cmt.querySelector('.cmt-edit')) return;           // déjà en cours d'édition
  const ed = document.createElement('div');
  ed.className = 'cmt-editor cmt-edit';
  ed.innerHTML = '<textarea></textarea>'
    + `<div class="cmt-actions"><button type="button" class="btn btn-sm cmt-edit-cancel">${tr('ui.cancel')}</button>`
    + `<button type="button" class="btn btn-sm btn-primary cmt-edit-save">${tr('ui.save')}</button></div>`;
  const ta = ed.querySelector('textarea');
  ta.value = cmt.dataset.raw || '';
  body.hidden = true; btn.hidden = true;
  body.after(ed);
  ta.focus();

  const close = () => { ed.remove(); body.hidden = false; btn.hidden = false; };
  ed.querySelector('.cmt-edit-cancel').addEventListener('click', close);
  ed.querySelector('.cmt-edit-save').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) { toast(tr('cmt.edit.empty'), true); return; }
    const save = ed.querySelector('.cmt-edit-save');
    try {
      const d = await busy(save, () => api(`/mrs/${btn.dataset.mr}/notes/${encodeURIComponent(btn.dataset.note)}`, {
        method: 'PUT', body: { body: text, inline: btn.dataset.inline === '1' },
      }));
      // On réaffiche ce que la forge a RÉELLEMENT enregistré, pas ce qu'on a envoyé.
      cmt.dataset.raw = d.body || text;
      body.innerHTML = mdToHtml(cmt.dataset.raw);
      close();
      toast(tr('cmt.edit.done'));
    } catch (err) { toast(explainError(err.message), true); }
  });
});
// Bloc « Répondre » d'un fil de discussion.
function replyBtnHtml(discId, mrId) {
  return `<div class="cmt-reply"><button class="cmt-reply-btn" type="button" data-disc="${esc(discId)}" data-mr="${mrId}" title="${tr('cmt.reply-thread.title', { forge: forgeLabel(split.forge) })}">↩ ${tr('cmt.reply.btn')}</button></div>`;
}

// Commentaires généraux (non-inline) de la MR, dans le détail du rapport.
async function loadMrComments(id) {
  const el = $('#mrComments');
  if (!el) return;
  try {
    const dd = await api(`/mrs/${id}/discussions`);
    const general = (dd.discussions || []).filter((d) => d.notes[0] && !d.notes[0].position);
    if (!general.length) { el.innerHTML = `<p class="muted">${tr('cmt.none')}</p>`; return; }
    el.innerHTML = general.map((d) => `<div class="cmt-thread" data-disc="${esc(d.id)}">`
      + d.notes.map((n) => noteHtml(n, id)).join('') + replyBtnHtml(d.id, id) + '</div>').join('');
  } catch (e) { el.innerHTML = `<p class="muted">Commentaires indisponibles (${esc(e.message)})</p>`; }
}

/* Suivi de résolution : bandeau (résolus/persistants/nouveaux + évolution de la
   note) et liste des constats de la dernière passe. Chaque constat porte son état,
   avec la nuance « disparu » (non re-signalé, code inchangé) distincte de « résolu »
   (git-vérifié) — c'est le garde-fou du doc, rendu visible. */
// Clés écrites en toutes lettres (et non `tr('...' + status)`) pour rester
// greppables — c'est ce que vérifie npm run i18n:check.
const FINDING_STATUS = {
  resolved: { icon: svgIco('check'), cls: 'ok', key: 'resolution.status.resolved' },
  persistent: { icon: '●', cls: 'warn', key: 'resolution.status.persistent' },
  new: { icon: '+', cls: 'new', key: 'resolution.status.new' },
  disappeared: { icon: '~', cls: 'muted', key: 'resolution.status.disappeared' },
};
const SEV = {
  blocker: { cls: 'blocker', key: 'sev.blocker' },
  major: { cls: 'major', key: 'sev.major' },
  minor: { cls: 'minor', key: 'sev.minor' },
  info: { cls: 'info', key: 'sev.info' },
};

/* Joue une fois le compte des constats résolus. La clé (MR, version) vit en localStorage :
   elle doit survivre au rechargement de la page, sinon le tic revient à chaque F5. */
function jouerResolution(mrId, version, resolus) {
  if (!resolus || version < 2) return;
  const cle = `aidevtools_res_${mrId}_${version}`;
  try { if (localStorage.getItem(cle)) return; localStorage.setItem(cle, '1'); } catch { return; }
  const chip = $('#resolutionBox .res-chip.ok');
  if (!chip) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;  // le résultat, pas le trajet
  const texte = chip.textContent;
  const t0 = performance.now(); const dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const n = Math.round(resolus * (1 - (1 - k) ** 3));
    chip.textContent = texte.replace(String(resolus), String(n));
    if (k < 1 && !document.hidden) requestAnimationFrame(step); else chip.textContent = texte;
  };
  requestAnimationFrame(step);
}

async function renderResolution(id, versions) {
  const box = $('#resolutionBox');
  if (!box) return;
  const latest = versions[0];
  const r = latest && latest.resolution;
  if (!r) { box.hidden = true; return; }
  // Évolution de la note entre l'avant-dernière et la dernière passe.
  const prev = versions[1];
  const noteFrom = prev ? prev.note10 : null;
  const noteTo = latest.note10;
  const noteBit = (noteFrom != null && noteTo != null && noteFrom !== noteTo)
    ? ` · ${tr('resolution.note-evo', { from: noteFrom, to: noteTo })}` : '';
  const bits = [
    r.resolved ? `<span class="res-chip ok">${tr('resolution.resolved', { n: r.resolved, count: r.resolved })}</span>` : '',
    r.persistent ? `<span class="res-chip warn">${tr('resolution.persistent', { n: r.persistent, count: r.persistent })}</span>` : '',
    r.new ? `<span class="res-chip new">${tr('resolution.new', { n: r.new, count: r.new })}</span>` : '',
    r.disappeared ? `<span class="res-chip muted" title="${tr('resolution.disappeared-hint')}">${tr('resolution.disappeared', { n: r.disappeared, count: r.disappeared })}</span>` : '',
  ].filter(Boolean).join('');
  box.innerHTML = `<div class="resolution-banner">
      <span class="res-title">${tr('resolution.title', { v: latest.version })}</span>${bits}<span class="res-note">${noteBit}</span>
    </div><div id="findingsList" class="findings-list"></div>`;
  box.hidden = false;
  /* Le compte des constats résolus se JOUE, une seule fois par (MR, version). C'est la seule
     micro-récompense de l'app entièrement dérivée d'un fait : l'IA avait trouvé huit choses,
     il en reste deux. Rejouée à chaque ouverture du rapport elle deviendrait un tic — d'où la
     clé mémorisée. Jamais sur une première review : il n'y a rien à résoudre. */
  jouerResolution(id, latest.version, r.resolved);

  // Liste détaillée des constats de la dernière passe.
  const list = $('#findingsList');
  let data;
  try { data = await api(`/mrs/${id}/findings`); } catch { return; }
  if (!data.findings || !data.findings.length) { list.hidden = true; return; }
  list.innerHTML = data.findings.map((f) => {
    const st = FINDING_STATUS[f.status] || { icon: '·', cls: '', key: null };
    const sv = SEV[f.severity] || SEV.minor;
    const loc = f.file ? `<code>${esc(f.file)}${f.line ? ':' + f.line : ''}</code>` : '';
    return `<div class="finding f-${st.cls}">
        <span class="f-mark" title="${st.key ? esc(tr(st.key)) : ''}">${st.icon}</span>
        <span class="f-sev sev-${sv.cls}">${esc(tr(sv.key))}</span>
        ${loc}
        <span class="f-title">${esc(f.title || '')}</span>
      </div>`;
  }).join('');
  list.hidden = false;
}

/* Ce qui est actuellement rendu dans le détail : sert à ne PAS réécrire l'écran pour rien.
   Le rapport était réécrit intégralement à chaque fin de job — on lisait un constat en bas de
   page, un job se terminait ailleurs, et on repartait en haut, onglet et version reperdus.
   C'est le micro-agacement le plus coûteux de l'app : il se produit plusieurs fois par jour
   et il ne s'atténue jamais. */
let reportShown = { id: null, sig: null, stamp: null };

// Empreinte de tout ce que le détail AFFICHE. En oublier une part figerait l'écran sur une
// donnée périmée — c'est le risque exact de cette optimisation.
function reportSig(d) {
  const m = d.mr; const r = d.review; const t2 = d.ticket || {};
  return [m.status, m.closed_seen, m.squash, m.remove_source_branch, r && r.updated_at,
    d.convergence && d.convergence.status, d.stale, t2.text && t2.text.length, t2.has_image,
    t2.jira_text && t2.jira_text.length, (d.comments || []).length, d.resume_cmd].join('\u0001');
}

async function openReport(id, opts = {}) {
  selectedMr = id;
  // B8 : ne pas re-rendre toute la liste au clic dedans (flash + perte de scroll) —
  // on met simplement à jour la sélection.
  $$('#reportList .card').forEach((c) => c.classList.toggle('active', Number(c.dataset.id) === id));
  const d = await api(`/mrs/${id}`);
  const sig = reportSig(d);
  const stamp = (d.review && d.review.updated_at) || '';
  /* Rechargement de fond (fin de job, sauvegarde d'un contexte) : si rien de ce qui est
     affiché n'a changé, on ne touche pas au DOM. Un clic explicite, lui, rend toujours. */
  if (opts.keep && reportShown.id === id && reportShown.sig === sig) return;
  /* Le contexte de lecture n'est restauré que si le RAPPORT lui-même n'a pas changé : après
     une re-review, revenir en haut est le bon comportement — le texte n'est plus le même. */
  const memeRapport = reportShown.id === id && reportShown.stamp === stamp;
  const garde = memeRapport ? {
    y: window.scrollY,
    vue: ($('#reportDetail [data-view].active') || {}).dataset,
    version: ($('#mdVersion') || {}).value || '',
  } : null;
  reportShown = { id, sig, stamp };
  const m = d.mr;
  const rev = d.review;
  const detail = $('#reportDetail');
  detail.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div>
        <div class="title">!${m.iid} — ${esc(m.title || '')}</div>
        <div class="meta">${esc(m.project)}${ticketLink(d.ticket_url, d.ticket_key)} · <code>${esc(m.source_branch)}</code> → <code>${esc(m.target_branch)}</code>
          ${d.stale ? `<span class="tag stale">${tr('report.tag.stale')}</span>` : ''}</div>
      </div>
      <div class="spacer"></div>
      ${m.closed_seen ? `<span class="tag merged" title="${tr('mr.tag.closed-title', { forge: forgeLabel(m.forge) })}">${svgIco('merge')} ${tr('mr.tag.merged')}</span>` : ''}
      ${m.web_url ? `<a href="${esc(m.web_url)}" target="_blank">${forgeLabel(m.forge)} ↗</a>` : ''}
    </div>

    <div class="detail-actions">
      <div class="btn-group">
        <button id="aSplit" class="btn btn-primary" title="${tr('report.btn.split-title')}"><svg class=\"ico\"><use href=\"#i-expand\"/></svg>${tr('report.btn.split')}</button>
        <button id="aTicket" class="btn" title="${tr('report.btn.context-title')}"><svg class="ico"><use href="#i-doc"/></svg>${tr('mr.btn.context')}${d.ticket && (d.ticket.text || d.ticket.has_image) ? ` ${svgIco('check')}` : ''}</button>
        ${addTodoBtn('mr', m.id, tr('notes.add-todo.mr', { iid: m.iid, title: String(m.title || '').slice(0, 60) }))}
      </div>
      <div class="btn-group">
        ${d.review && m.status !== 'done' && !m.closed_seen ? `<button id="aConverge" class="btn btn-converge" title="${tr('report.btn.converge-title')}"><svg class="ico"><use href="#i-zap"/></svg>${tr('report.btn.converge')}</button>` : ''}
        ${d.review ? `<button id="aFix" class="btn" title="${tr('report.btn.fix-title')}"><svg class="ico"><use href="#i-bot"/></svg>${tr('report.btn.fix')}</button>` : ''}
        ${d.verifiable ? `<button id="aVerify" class="btn" title="${tr('verify.btn.verify-title')}"><svg class="ico"><use href="#i-check"/></svg>${tr('verify.btn.verify')}</button>` : ''}
        ${m.status !== 'done' ? `<button id="aRe" class="btn" title="${tr('report.btn.rerun-title')}"><svg class=\"ico\"><use href=\"#i-repeat\"/></svg>${tr('report.btn.rerun')}</button>` : ''}
        ${m.status !== 'done' && d.stale ? `<button id="aReInc" class="btn" title="${tr('report.btn.rerun-inc-title')}"><svg class=\"ico\"><use href=\"#i-repeat\"/></svg>${tr('report.btn.rerun-inc')}</button>` : ''}
        ${resumeCmdBtn(d.resume_cmd)}
      </div>
      <div class="btn-group">
        ${m.status !== 'done' ? `<button id="aDone" class="btn btn-ok" title="${tr('report.btn.done-title')}"><svg class=\"ico\"><use href=\"#i-check\"/></svg>${tr('report.btn.done')}</button>` : `<button id="aReopen" class="btn" title="${tr('report.btn.reopen-title')}"><svg class=\"ico\"><use href=\"#i-reset\"/></svg>${tr('report.btn.reopen')}</button>`}
        ${m.closed_seen ? '' : `<button id="aMerge" class="btn btn-danger" data-target="${esc(m.target_branch || '')}" title="${tr('report.btn.merge-title', { forge: forgeLabel(m.forge) })}"><svg class=\"ico\"><use href=\"#i-merge\"/></svg>${tr('task.btn.merge')}</button>`}
        <button id="aDelReport" class="btn btn-danger" data-iid="${m.iid}" title="${tr('mr.btn.delete-report-title')}"><svg class=\"ico\"><use href=\"#i-trash\"/></svg>${tr('report.btn.delete')}</button>
      </div>
    </div>

    <div id="mrLinksBox"></div>

    ${m.last_error ? errorBox(m.last_error, m.id) : ''}
    ${convergeBoxHtml(d.convergence)}

    <div class="tabbar">
      <button class="active" data-view="review" title="${tr('report.tab.review-title')}">${tr('report.tab.review')}</button>
      <button data-view="explanation" title="${tr('report.tab.explain-title')}">${tr('report.tab.explain')}</button>
      <span class="spacer"></span>
      <select id="mdVersion" class="md-version" title="${tr('report.version.title')}" hidden></select>
      <button id="mdCopy" class="btn btn-sm btn-ghost md-copy" title="${tr('report.btn.copy-title')}"><svg class="ico"><use href="#i-copy"/></svg>${tr('report.btn.copy')}</button>
    </div>
    <div id="mdVersionNote" class="version-note" hidden></div>
    <div id="resolutionBox" hidden></div>
    <div id="mdView" class="md">${mdToHtml(rev && rev.md)}</div>

    <div class="box">
      <h4>${tr('report.modify.title')}</h4>
      <div id="modifyHistory" class="modify-history" hidden></div>
      <textarea id="modifyInput" placeholder="${tr('report.modify.ph')}"></textarea>
      <button class="btn btn-primary" id="btnModify" title="${tr('report.btn.regen-title')}"><svg class=\"ico\"><use href=\"#i-repeat\"/></svg>${tr('report.btn.regen')}</button>
    </div>

    <div class="box">
      <h4>${tr('report.comments.title', { forge: forgeLabel(m.forge) })}</h4>
      <div id="mrComments" class="mr-comments"><p class="muted">${tr('ui.loading')}</p></div>
      <textarea id="commentInput" placeholder="${tr('report.comments.ph')}"></textarea>
      <button class="btn btn-primary" id="btnComment" title="${tr('report.btn.comment-title', { forge: forgeLabel(m.forge) })}"><svg class=\"ico\"><use href=\"#i-doc\"/></svg>${tr('report.btn.comment', { forge: forgeLabel(m.forge) })}</button>
      <p class="muted" style="margin-top:6px">${tr('report.comments.inline-hint')} <strong><svg class=\"ico\"><use href=\"#i-expand\"/></svg>${tr('report.btn.split')}</strong>.</p>
    </div>
  `;

  // charge et affiche les commentaires généraux (non-inline) de la MR
  loadMrComments(id);
  /* Les liens du service associé à ce dépôt (aucun service lié → rien ne s'affiche, et
     surtout pas un bloc vide). Chargé à part : ils ne doivent pas retarder le rapport. */
  renderMrLinks(id, $('#mrLinksBox'));

  // bascule rapport / explication
  // Historique des reviews : chaque passe est conservée, on peut relire les précédentes.
  let shown = { md: rev && rev.md, explanation: rev && rev.explanation };
  // Rendu d'un onglet. Cas particulier : explication absente (review lancée « seule »)
  // → on propose de la générer à la demande (1 appel IA), sans relancer la review.
  const renderView = (view) => {
    if (view === 'explanation' && !(shown.explanation && shown.explanation.trim())) {
      $('#mdView').innerHTML = `<div class="empty-explain">
          <p class="muted">${tr('report.explain.absent')}</p>
          <button id="genExplain" class="btn btn-primary"><svg class="ico"><use href="#i-bot"/></svg>${tr('report.explain.generate')}</button>
        </div>`;
      const g = $('#genExplain');
      if (g) g.addEventListener('click', async () => {
        try { await busy(g, () => api(`/mrs/${id}/explain`, { method: 'POST' })); toast(tr('toast.explain-lancee')); refreshStatus(); }
        catch (e) { toast(explainError(e.message), true); }
      });
      return;
    }
    $('#mdView').innerHTML = mdToHtml(view === 'review' ? shown.md : shown.explanation);
  };
  (async () => {
    let versions = [];
    try { versions = await api(`/mrs/${id}/versions`); } catch { return; }
    // Suivi de résolution : bandeau + liste des constats, dès qu'il y a un delta.
    renderResolution(id, versions);
    renderModifyHistory(versions);
    if (versions.length < 2) return;              // une seule passe : rien à choisir
    const sel = $('#mdVersion');
    const latest = versions[0].version;
    sel.innerHTML = versions.map((v) => {
      const d = new Date(v.created_at);
      const note = v.note10 != null ? ` · ${v.note10}/10` : '';
      const tag = v.kind === 'modify' ? tr('report.version.regen') : '';
      return `<option value="${v.version}">v${v.version}${v.version === latest ? ' — actuelle' : ''} · ${d.toLocaleDateString(I18Nrt.currentLocale())} ${d.toLocaleTimeString(I18Nrt.currentLocale(), { hour: '2-digit', minute: '2-digit' })}${note}${tag}</option>`;
    }).join('');
    sel.hidden = false;
    const note = $('#mdVersionNote');
    // Version relue restaurée APRÈS que la liste existe — sinon elle n'aurait rien à choisir.
    if (garde && garde.version && [...sel.options].some((o) => o.value === garde.version)) {
      sel.value = garde.version;
      sel.dispatchEvent(new Event('change'));
    }
    sel.addEventListener('change', async () => {
      const v = Number(sel.value);
      try {
        const data = await api(`/mrs/${id}/versions/${v}`);
        shown = { md: data.md, explanation: data.explanation };
        const active = $('#reportDetail .tabbar button[data-view].active');
        const view = active ? active.dataset.view : 'review';
        renderView(view);
        const older = v !== latest;
        note.hidden = !older;
        if (older) note.textContent = tr('report.version.note', { v, latest });
      } catch (e) { toast(explainError(e.message), true); }
    });
  })();

  $$('#reportDetail .tabbar button[data-view]').forEach((b) => b.addEventListener('click', () => {
    $$('#reportDetail .tabbar button[data-view]').forEach((x) => x.classList.toggle('active', x === b));
    renderView(b.dataset.view);
  }));
  /* Restauration du contexte de lecture : l'onglet qu'on regardait, puis la position dans la
     page. Le défilement est repositionné après le rendu du corps, sinon la page n'est pas
     encore assez haute pour l'accepter. */
  if (garde && garde.vue && garde.vue.view && garde.vue.view !== 'review') {
    const b = $(`#reportDetail .tabbar button[data-view="${garde.vue.view}"]`);
    if (b) b.click();
  }
  if (garde && garde.y) requestAnimationFrame(() => window.scrollTo({ top: garde.y, behavior: 'auto' }));
  // copie le markdown brut de l'onglet actif (rapport ou explication)
  $('#mdCopy').addEventListener('click', () => {
    const active = $('#reportDetail .tabbar button[data-view].active');
    const view = active ? active.dataset.view : 'review';
    copyText((view === 'review' ? shown.md : shown.explanation) || '', $('#mdCopy'));
  });

  $('#aSplit').addEventListener('click', () => openSplit(id, m));
  $('#aTicket').addEventListener('click', () => openTicket(id, `!${m.iid} — ${m.title || ''}`));
  const aFix = $('#aFix');
  if (aFix) aFix.addEventListener('click', () => {
    const md = (rev && rev.md) || '';
    if (!md) { toast(tr('toast.aucun-rapport-de-review-a'), true); return; }
    openTaskForMr(m, {
      title: tr('report.fix.modal-title', { iid: m.iid }),
      commitMessage: tr('report.fix.commit', { branch: m.source_branch, iid: m.iid }),
      prompt: tr('prompt.apply-review', { branch: m.source_branch, md }),
      // Session de codage d'où sort la branche : proposée, jamais imposée (cf. openTaskForMr).
      sessionId: d.origin_session || '',
    }).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true));
  });
  const aMerge = $('#aMerge'); // absent si la MR n'est plus ouverte sur GitLab
  if (aMerge) aMerge.addEventListener('click', () => {
    openMergeModal({
      url: `/mrs/${id}/merge`, label: `!${m.iid}`, target: m.target_branch, forge: m.forge,
      squash: m.squash, removeSourceBranch: m.remove_source_branch,
      onDone: () => openReport(id),          // recharge le détail (badge « mergée »)
    });
  });
  /* LA LISTE SUIT, pas seulement le rapport. Ces deux boutons changent le STADE de la MR : elle
     quitte « Reviewées » pour « Traitées », ou l'inverse. Ne rafraîchir que le panneau de droite
     laissait la carte dans une liste où elle n'a plus sa place, et le compteur du segment mentait
     jusqu'au prochain rechargement — le même geste depuis la file « À traiter » le faisait déjà. */
  const done = $('#aDone'); if (done) done.addEventListener('click', async () => {
    await api(`/mrs/${id}/done`, { method: 'POST' });
    toast(tr('toast.marquee-done'));
    openReport(id); loadSegment(); refreshCounts();
  });
  const reopen = $('#aReopen'); if (reopen) reopen.addEventListener('click', async () => {
    await api(`/mrs/${id}/reopen`, { method: 'POST' });
    toast(tr('toast.rouverte'));
    openReport(id); loadSegment(); refreshCounts();
  });
  /* Vérifier depuis le rapport : une MR déjà reviewée reste une MR à vérifier. La review
     donne un avis, le vérificateur un fait — les deux se lisent au même endroit. */
  const ver = $('#aVerify'); if (ver) ver.addEventListener('click', () => busy(ver, () => lancerVerification([id])));
  const re = $('#aRe'); if (re) re.addEventListener('click', async () => {
    try { await api(`/mrs/${id}/rereview`, { method: 'POST' }); toast(tr('toast.re-review-lancee')); refreshStatus(); }
    catch (e) { toast(e.message, true); }
  });
  // Re-review incrémentale : ne relit que le delta depuis le dernier SHA reviewé.
  const reInc = $('#aReInc'); if (reInc) reInc.addEventListener('click', async () => {
    try { await api(`/mrs/${id}/rereview`, { method: 'POST', body: { incremental: true } }); toast(tr('toast.re-review-inc-lancee')); refreshStatus(); }
    catch (e) { toast(e.message, true); }
  });
  // Converger : ouvre la modale de lancement (seuil + plafond pré-remplis depuis la config).
  const conv = $('#aConverge'); if (conv) conv.addEventListener('click', () => openConvergeModal({ type: 'mr', id, label: `!${m.iid}` }));

  /* Supprimer le rapport vit ici, avec les autres actions sur l'objet, et non plus sur la
     carte de la colonne de gauche : c'y était la SEULE action visible, ce qui la mettait
     très en avant pour ce qu'elle est — un nettoyage, pas une étape du parcours. */
  const del = $('#aDelReport'); if (del) del.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-report', { iid: m.iid }), confirmLabel: tr('ui.delete') })) return;
    try {
      await api(`/mrs/${id}/delete-review`, { method: 'POST' });
      selectedMr = null; renderReportPlaceholder();
      toast(tr('toast.rapport-de-supprime-mr-remise', { iid: m.iid }));
      loadReports(currentSeg); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  });

  $('#btnModify').addEventListener('click', async () => {
    const instruction = $('#modifyInput').value.trim();
    if (!instruction) return;
    const btn = $('#btnModify'); btn.disabled = true;
    try {
      // même pipeline que la review : job de fond + log en direct ; le rapport
      // affiché se recharge automatiquement à la fin du job.
      await api(`/mrs/${id}/modify`, { method: 'POST', body: { instruction } });
      $('#modifyInput').value = '';
      toast(tr('toast.modification-lancee-suivez-le-log'));
      refreshStatus();
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  });

  $('#btnComment').addEventListener('click', async () => {
    const body = $('#commentInput').value.trim();
    if (!body) return;
    const btn = $('#btnComment'); btn.disabled = true;
    try { await api(`/mrs/${id}/comment`, { method: 'POST', body: { body } }); $('#commentInput').value = ''; toast(tr('toast.commentaire-poste-sur-gitlab')); loadMrComments(id); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  });
}

/* ---------- Vue plein écran : explorateur de code (rapport | arbre | fichier) ---------- */
let split = { mrId: null, md: null, explanation: null, diffByFile: {}, files: [], target: '', view: 'diff', path: null, fullCache: {} };


// Rendu du diff en lignes structurées : numéros old/new + bouton « commenter ».
// Renvoie { html, oldPath, newPath }.
function renderDiffLines(diff) {
  if (!diff) return { html: '<div class="muted" style="padding:12px">(aucun diff)</div>', oldPath: '', newPath: '' };
  let oldPath = ''; let newPath = ''; let oldNo = 0; let newNo = 0;
  const strip = (p) => p.replace(/^[ab]\//, '');
  const rows = [];
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) { const p = l.slice(4); oldPath = p === '/dev/null' ? '' : strip(p); continue; }
    if (l.startsWith('+++ ')) { const p = l.slice(4); newPath = p === '/dev/null' ? '' : strip(p); continue; }
    if (l.startsWith('diff ') || l.startsWith('index ')) continue;
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hm) {
      oldNo = +hm[1]; newNo = +hm[2];
      rows.push(`<div class="dl-row hunk"><span class="ln"></span><span class="ln"></span><span class="cbtn"></span><span class="dl hunk">${esc(l)}</span></div>`);
      continue;
    }
    let type = ''; let o = ''; let n = ''; let code;
    if (l.startsWith('+')) { type = 'add'; n = newNo++; code = l.slice(1); }
    else if (l.startsWith('-')) { type = 'del'; o = oldNo++; code = l.slice(1); }
    else { o = oldNo++; n = newNo++; code = l.startsWith(' ') ? l.slice(1) : l; }
    const pfx = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
    rows.push(`<div class="dl-row ${type}" data-old="${o}" data-new="${n}">`
      + `<span class="ln ln-old">${o}</span><span class="ln ln-new">${n}</span>`
      + `<button class="cbtn ln-comment" title="${tr('cmt.inline.line-title')}"><svg class="ico"><use href="#i-plus"/></svg></button>`
      + `<span class="dl ${type}">${esc(pfx)}${highlightCode(code)}</span></div>`);
  }
  return { html: `<div class="difflines">${rows.join('')}</div>`, oldPath, newPath };
}

// Découpe un diff unifié en { chemin -> diff de ce fichier }.
function parseDiffByFile(diff) {
  const map = {};
  if (!diff) return map;
  for (const part of diff.split(/(?=^diff --git )/m)) {
    const m = /^diff --git a\/.+? b\/(.+)$/m.exec(part);
    if (m) map[m[1]] = part.replace(/\s+$/, '');
  }
  return map;
}

// bascule des onglets rapport / explication
function setSplitPane(which) {
  $$('#splitView .split-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.split === which));
  $('#splitMd').innerHTML = mdToHtml(which === 'review' ? split.md : split.explanation);
  $('#splitMd').scrollTop = 0;
}

// ---- arbre de fichiers ----
function buildTree(files) {
  const root = { children: {} };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((p, i) => {
      node.children = node.children || {};
      if (i === parts.length - 1) node.children[p] = { file: f };
      else { if (!node.children[p]) node.children[p] = { children: {} }; node = node.children[p]; }
    });
  }
  return root;
}
function treeFileRow(f, label) {
  return `<div class="tree-file${f.changed ? ' changed' : ''}${split.path === f.path ? ' active' : ''}" data-path="${esc(f.path)}">`
    + `${f.changed ? '<span class="dot">●</span>' : ''}<span class="tf-name">${esc(label)}</span></div>`;
}
// Un sous-arbre contient-il au moins un fichier modifié ? Sert à ne déplier par défaut
// que les dossiers qui portent un changement (les autres restent repliés).
function nodeHasChange(node) {
  if (node.file) return !!node.file.changed;
  return Object.values(node.children || {}).some(nodeHasChange);
}
/* Ce que l'utilisateur a ouvert ou fermé À LA MAIN, retenu par chemin de dossier. L'arbre est
   reconstruit à chaque clic sur un fichier : sans cette mémoire, l'état repart de la règle par
   défaut et un dossier ouvert se referme sous le curseur — au moment précis où on ouvre l'un de
   ses fichiers. Rangé dans `split`, il repart donc à zéro quand on ouvre un autre diff. */
function memoDossiers() { split.dirs = split.dirs || {}; return split.dirs; }
function renderTreeNode(node, name, parent = '') {
  if (node.file) return treeFileRow(node.file, name);
  const keys = Object.keys(node.children || {}).sort((a, b) => {
    const af = !!node.children[a].file, bf = !!node.children[b].file;
    if (af !== bf) return af ? 1 : -1;
    return a.localeCompare(b);
  });
  const chemin = name === null ? '' : (parent ? `${parent}/${name}` : name);
  const inner = keys.map((k) => renderTreeNode(node.children[k], k, chemin)).join('');
  if (name === null) return inner;
  // Ce que l'utilisateur a décidé prime ; sinon, déplié seulement si le dossier porte un changement.
  const memo = memoDossiers();
  const open = (chemin in memo ? memo[chemin] : nodeHasChange(node)) ? ' open' : '';
  return `<details${open} class="tree-folder" data-dir="${esc(chemin)}"><summary>${esc(name)}</summary><div class="tree-children">${inner}</div></details>`;
}
function renderTree() {
  const q = ($('#treeSearch').value || '').toLowerCase().trim();
  const el = $('#treeList');
  if (q) {
    const matches = split.files.filter((f) => f.path.toLowerCase().includes(q));
    el.innerHTML = matches.length ? matches.map((f) => treeFileRow(f, f.path)).join('') : '<p class="muted">aucun fichier</p>';
  } else {
    el.innerHTML = renderTreeNode(buildTree(split.files), null) || '<p class="muted">(vide)</p>';
  }
}

/* Base d'URL des routes du viewer. Le composant est le même pour une MR et pour un
   projet de session : seule la racine change (`split.base`), les chemins `/file` et
   `/filediff` sont identiques des deux côtés. */
function splitBase() { return split.base || `/mrs/${split.mrId}`; }

async function selectFile(path) {
  split.path = path;
  renderTree();
  await renderFile();
}

// Coloration syntaxique générique (commentaires, chaînes, nombres, mots-clés).
// Tokenise le code BRUT puis échappe chaque token (pas de casse d'entités HTML).
const CODE_TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d[\w.]*)\b|\b(function|fn|return|if|else|elseif|for|foreach|while|do|switch|case|break|continue|const|let|var|class|extends|implements|interface|trait|enum|new|public|private|protected|static|readonly|abstract|final|void|null|true|false|undefined|this|self|parent|echo|print|require|require_once|include|include_once|use|namespace|async|await|try|catch|finally|throw|throws|import|from|export|default|typeof|instanceof|yield|global|as|match)\b/g;
function highlightCode(code) {
  if (!code) return '';
  let out = ''; let last = 0; let m;
  CODE_TOKEN.lastIndex = 0;
  while ((m = CODE_TOKEN.exec(code))) {
    out += esc(code.slice(last, m.index));
    const cls = m[1] ? 'c-com' : m[2] ? 'c-str' : m[3] ? 'c-num' : 'c-kw';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

async function renderFile() {
  const path = split.path;
  $('#fileName').textContent = path || '';
  const el = $('#fileContent');
  if (!path) { el.innerHTML = ''; return; }
  const changed = !!split.diffByFile[path];
  el.innerHTML = skeleton(4);
  if (changed) {
    // fichier entier AVEC les changements surlignés (diff à contexte complet, façon GitLab)
    if (split.diffFullCache[path] == null) {
      try { const r = await api(`${splitBase()}/filediff?path=${encodeURIComponent(path)}`); split.diffFullCache[path] = r.diff || split.diffByFile[path] || ''; }
      catch { split.diffFullCache[path] = split.diffByFile[path] || ''; }
    }
    const rd = renderDiffLines(split.diffFullCache[path]);
    split.fileOldPath = rd.oldPath || path;
    split.fileNewPath = rd.newPath || path;
    el.innerHTML = rd.html;
    renderInlineThreads();     // commentaires existants sous leur ligne
    renderInlineDrafts();      // …et ceux qui attendent encore d'être envoyés
    el.scrollTop = 0;
    setupChangeNav();          // repère les changements + saute au premier
    return;
  }
  // fichier non modifié : contenu complet coloré, pas de navigation de changements
  $('#changeNav').hidden = true;
  $('#minimap').hidden = true;
  if (split.fullCache[path] == null) {
    try { const r = await api(`${splitBase()}/file?path=${encodeURIComponent(path)}`); split.fullCache[path] = r.content || ''; }
    catch (e) { el.innerHTML = errorBox(e.message); return; }
  }
  el.innerHTML = `<pre class="code">${highlightCode(split.fullCache[path])}</pre>`;
  el.scrollTop = 0;
}

// Repère les blocs de changement (runs contigus d'ajouts/suppressions), affiche
// la navigation et saute automatiquement au premier.
function setupChangeNav() {
  const lines = [...$('#fileContent').querySelectorAll('.dl-row')];
  const blocks = [];
  let inBlock = false;
  for (const l of lines) {
    const isChange = l.classList.contains('add') || l.classList.contains('del');
    if (isChange && !inBlock) { blocks.push(l); inBlock = true; }
    else if (!isChange) inBlock = false;
  }
  split.changeBlocks = blocks;
  split.changeIdx = -1;
  $('#changeNav').hidden = blocks.length === 0;
  renderMinimap();
  if (blocks.length) goToChange(0);
}

// Affiche les commentaires existants (discussions inline) sous leur ligne.
function renderInlineThreads() {
  const discs = (split.discussions || []).filter((d) => d.notes[0] && d.notes[0].position);
  for (const d of discs) {
    const pos = d.notes[0].position;
    if (pos.new_path !== split.fileNewPath && pos.old_path !== split.fileOldPath) continue;
    let row = null;
    if (pos.new_line != null) row = $(`#fileContent .dl-row[data-new="${pos.new_line}"]`);
    else if (pos.old_line != null) row = $(`#fileContent .dl-row[data-old="${pos.old_line}"]`);
    if (!row) continue;
    row.classList.add('has-comment');
    const el = document.createElement('div');
    el.className = 'cmt-thread';
    el.dataset.disc = d.id;
    el.innerHTML = d.notes.map((n) => noteHtml(n, split.mrId)).join('') + replyBtnHtml(d.id, split.mrId);
    row.after(el);
  }
}

/* LES COMMENTAIRES EN ATTENTE, sous leur ligne, comme les vrais — mais reconnaissables au
   premier regard : ils ne sont PAS partis. Les afficher comme les autres ferait croire le
   travail fait, et on refermerait la MR en laissant ses remarques en local. */
function renderInlineDrafts() {
  for (const d of split.drafts || []) {
    if (d.new_path !== split.fileNewPath && d.old_path !== split.fileOldPath) continue;
    let row = null;
    if (d.new_line != null) row = $(`#fileContent .dl-row[data-new="${d.new_line}"]`);
    else if (d.old_line != null) row = $(`#fileContent .dl-row[data-old="${d.old_line}"]`);
    if (!row) continue;
    row.classList.add('has-comment');
    const el = document.createElement('div');
    el.className = 'cmt-thread cmt-draft';
    el.dataset.draft = d.id;
    el.innerHTML = `<div class="cmt-draft-head">${svgIco('edit')}<span>${esc(tr('cmt.draft.badge'))}</span></div>`
      + `<div class="cmt-draft-body">${esc(d.body)}</div>`
      + `<div class="cmt-actions"><button type="button" class="btn btn-sm" data-draftedit="${d.id}">${esc(tr('ui.edit'))}</button>`
      + `<button type="button" class="btn btn-sm btn-danger" data-draftdel="${d.id}">${esc(tr('ui.delete'))}</button></div>`;
    // Après le fil existant de la même ligne s'il y en a un : les vrais d'abord, l'à-venir après.
    const apres = row.nextElementSibling && row.nextElementSibling.classList.contains('cmt-thread')
      ? row.nextElementSibling : row;
    apres.after(el);
  }
}

/* Le compteur, dans l'en-tête de la vue plein écran. C'est LUI qui rappelle qu'un travail
   attend : sans compteur visible, on referme la MR en laissant ses remarques en local. */
function majBoutonBrouillons() {
  const b = $('#draftsSend');
  if (!b) return;
  const n = (split.drafts || []).length;
  b.hidden = !n;
  $('#draftsCount').textContent = n;
}

async function chargerBrouillons() {
  if (!split.mrId) { split.drafts = []; majBoutonBrouillons(); return; }
  try {
    const d = await api(`/mrs/${split.mrId}/comment-drafts`);
    split.drafts = d.drafts || [];
  } catch { split.drafts = []; }
  majBoutonBrouillons();
}

// Mini-carte : marqueurs cliquables aux emplacements des changements.
function renderMinimap() {
  const mm = $('#minimap');
  const content = $('#fileContent');
  const blocks = split.changeBlocks || [];
  if (!blocks.length) { mm.hidden = true; mm.innerHTML = ''; return; }
  const total = content.scrollHeight || 1;
  const cTop = content.getBoundingClientRect().top;
  mm.innerHTML = blocks.map((b, i) => {
    const top = ((b.getBoundingClientRect().top - cTop + content.scrollTop) / total) * 100;
    const type = b.classList.contains('del') ? 'del' : 'add';
    return `<div class="minimap-mark ${type}" data-ci="${i}" title="changement ${i + 1}" style="top:${top}%"></div>`;
  }).join('');
  mm.hidden = false;
}
function goToChange(i) {
  const blocks = split.changeBlocks || [];
  if (!blocks.length) return;
  split.changeIdx = (i + blocks.length) % blocks.length;
  const el = blocks[split.changeIdx];
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
  $('#changeCounter').textContent = `${split.changeIdx + 1}/${blocks.length}`;
}

async function openSplit(id) {
  try {
    const [d, diffResp, tree, disc] = await Promise.all([
      api(`/mrs/${id}`), api(`/mrs/${id}/diff`), api(`/mrs/${id}/tree`).catch(() => ({ files: [] })),
      api(`/mrs/${id}/discussions`).catch(() => ({ discussions: [] })),
    ]);
    split = {
      mrId: id,
      forge: d.mr && d.mr.forge,        // libellés « GitLab »/« GitHub » des commentaires
      md: d.review && d.review.md,
      explanation: d.review && d.review.explanation,
      diffByFile: parseDiffByFile(diffResp.diff),
      files: tree.files || [],
      target: tree.target || '',
      discussions: disc.discussions || [],
      path: null, fullCache: {}, diffFullCache: {},
    };
    $('#splitTitle').textContent = `!${d.mr.iid} — ${d.mr.title || ''}`;
    setSplitPane('review');
    chargerBrouillons();
    renderTree();
    $('#splitView').hidden = false;
    const first = split.files.find((f) => f.changed) || split.files[0];
    if (first) selectFile(first.path);
    else { $('#fileName').textContent = 'Aucun fichier'; $('#fileContent').innerHTML = '<p class="muted">Arborescence indisponible — relance une review de cette MR.</p>'; }
  } catch (e) { toast(e.message, true); }
}

/* Aperçu du diff AVANT review : réutilise le viewer plein écran (arbre + diff
   inline + navigation), mais le panneau de gauche devient un panneau de DÉCISION —
   on juge la MR et on tranche (Reviewer / Classer sans review) sans dépenser un
   appel IA si elle est triviale. Le clone est chauffé côté serveur par /diffview,
   donc les endpoints /file et /filediff du viewer fonctionnent ensuite. */
async function openDiffPreview(m) {
  let dv;
  try { dv = await api(`/mrs/${m.id}/diffview`); }
  catch (e) { toast(explainError(e.message), true); return; }
  split = {
    mrId: m.id, mr: m, preview: true, forge: m.forge,
    md: '', explanation: '',
    diffByFile: parseDiffByFile(dv.diff),
    files: dv.files || [],
    target: dv.target || '',
    discussions: [],
    path: null, fullCache: {}, diffFullCache: {},
  };
  $('#splitView').classList.add('preview-mode');
  $('#splitTitle').textContent = `!${m.iid} — ${m.title || ''}`;
  renderDecisionPanel(m, dv.stats);
  renderTree();
  $('#splitView').hidden = false;
  const first = split.files.find((f) => f.changed) || split.files[0];
  if (first) selectFile(first.path);
  else { $('#fileName').textContent = tr('preview.no-file'); $('#fileContent').innerHTML = `<p class="muted">${tr('preview.no-file')}</p>`; }
}

// Panneau de décision (remplace le rapport en mode aperçu) : résumé du diff + les
// deux actions, câblées comme sur les cartes.
function renderDecisionPanel(m, stats) {
  $('#splitMd').innerHTML = `<div class="diff-decision">
      <h3>${tr('preview.decision.title')}</h3>
      <p class="diff-decision-stats">${tr('preview.decision.stats', { files: stats.files, added: stats.added, removed: stats.removed })}</p>
      <p class="muted">${tr('preview.decision.help')}</p>
      <div class="diff-decision-actions">
        <button id="pvReview" class="btn btn-primary"><svg class="ico"><use href="#i-play"/></svg>${tr('mr.btn.review')}</button>
        <button id="pvDismiss" class="btn"><svg class="ico"><use href="#i-archive"/></svg>${tr('mr.btn.dismiss')}</button>
        ${m.closed_seen ? '' : `<button id="pvMerge" class="btn btn-danger"><svg class="ico"><use href="#i-merge"/></svg>${tr('task.btn.merge')}</button>`}
      </div>
    </div>`;
  $('#pvReview').addEventListener('click', (e) => {
    const b = e.currentTarget;
    busy(b, () => api(`/mrs/${m.id}/review`, { method: 'POST' }))
      .then(() => { toast(tr('toast.review-de-lancee', { iid: m.iid })); closeSplit(); refreshStatus(); })
      .catch((err) => toast(explainError(err.message), true));
  });
  $('#pvDismiss').addEventListener('click', (e) => {
    const b = e.currentTarget;
    busy(b, () => api(`/mrs/${m.id}/done`, { method: 'POST' }))
      .then(() => {
        closeSplit();
        toastUndo(tr('toast.classee-sans-review', { iid: m.iid }), async () => {
          try { await api(`/mrs/${m.id}/reopen`, { method: 'POST' }); loadSegment(currentSeg); refreshCounts(); } catch (err) { toast(err.message, true); }
        });
        loadToReview(); refreshCounts();
      })
      .catch((err) => toast(explainError(err.message), true));
  });
  const pvMerge = $('#pvMerge');
  if (pvMerge) pvMerge.addEventListener('click', (e) => {
    mergeMrFromQueue(m, () => { closeSplit(); loadToReview(); refreshCounts(); });
  });
}

/* Historique des demandes de modification : chaque régénération a été déclenchée par une
   demande précise, et a produit SA version de rapport. Les afficher côte à côte évite de
   rejouer de tête « qu'est-ce que j'avais demandé pour arriver à ce rapport ? ». */
function renderModifyHistory(versions) {
  const box = $('#modifyHistory');
  if (!box) return;
  const asked = (versions || []).filter((v) => v.kind === 'modify' && v.instruction);
  box.hidden = !asked.length;
  if (!asked.length) return;
  box.innerHTML = `<p class="muted">${esc(tr('report.modify.history'))}</p>`
    + asked.map((v) => `<div class="modify-entry">
        <div class="modify-entry-head">
          <span class="muted">${esc(fmtDateTime(v.created_at))}</span>
          <button type="button" class="btn btn-sm btn-ghost" data-modifyv="${v.version}"
            title="${esc(tr('report.modify.see-report-title', { v: v.version }))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('report.modify.see-report', { v: v.version }))}</button>
        </div>
        <div class="modify-entry-text">${esc(v.instruction)}</div>
      </div>`).join('');
  // Ouvrir le rapport correspondant = piloter le sélecteur de versions existant.
  $$('#modifyHistory [data-modifyv]').forEach((b) => b.addEventListener('click', () => {
    const sel = $('#mdVersion');
    if (!sel || sel.hidden) return;
    sel.value = b.dataset.modifyv;
    sel.dispatchEvent(new Event('change'));
    sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
}

function closeSplit() {
  $('#splitView').hidden = true;
  $('#splitView').classList.remove('preview-mode', 'session-mode'); // sinon un openSplit suivant hériterait du mode
}

$$('#splitView .split-tabs button').forEach((b) => b.addEventListener('click', () => setSplitPane(b.dataset.split)));
$('#prevChange').addEventListener('click', () => goToChange(split.changeIdx - 1));
$('#nextChange').addEventListener('click', () => goToChange(split.changeIdx + 1));
$('#minimap').addEventListener('click', (e) => { const m = e.target.closest('.minimap-mark'); if (m) goToChange(Number(m.dataset.ci)); });

// Commentaire inline : bouton « ＋ » d'une ligne de diff -> éditeur -> discussion GitLab.
$('#fileContent').addEventListener('click', (e) => {
  const btn = e.target.closest('.ln-comment');
  if (!btn) return;
  const row = btn.closest('.dl-row');
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('cmt-editor')) {
    row.nextElementSibling.querySelector('textarea').focus(); return;
  }
  const ed = document.createElement('div');
  ed.className = 'cmt-editor';
  const forge = forgeLabel(split.forge);
  ed.innerHTML = `<textarea placeholder="${tr('cmt.inline.ph')}"></textarea>`
    + `<div class="cmt-actions"><button type="button" class="btn btn-sm cmt-cancel" title="${tr('cmt.cancel.title')}">${tr('ui.cancel')}</button>`
    /* ENREGISTRER SANS ENVOYER : le geste de relecture. On écrit ses remarques au fil des
       fichiers, on les corrige, on en retire — et on les envoie toutes quand on a fini. */
    + `<button type="button" class="btn btn-sm cmt-draft-save" title="${tr('cmt.draft.title')}">${tr('cmt.draft.btn')}</button>`
    + `<button type="button" class="btn btn-sm btn-primary cmt-send" title="${tr('cmt.inline.title', { forge })}">${tr('cmt.inline.btn', { forge })}</button></div>`;
  row.after(ed);
  const ta = ed.querySelector('textarea'); ta.focus();
  ed.querySelector('.cmt-cancel').addEventListener('click', () => ed.remove());
  ed.querySelector('.cmt-draft-save').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    const b = ed.querySelector('.cmt-draft-save'); b.disabled = true;
    try {
      const cree = await api(`/mrs/${split.mrId}/comment-drafts`, { method: 'POST', body: {
        body, old_path: split.fileOldPath, new_path: split.fileNewPath,
        old_line: row.dataset.old || null, new_line: row.dataset.new || null,
      } });
      split.drafts = [...(split.drafts || []), cree];
      majBoutonBrouillons();
      ed.remove();
      renderFile();
      toast(tr('toast.commentaire-en-attente'));
    } catch (err) { b.disabled = false; toast(explainError(err.message), true); }
  });
  ed.querySelector('.cmt-send').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    const send = ed.querySelector('.cmt-send'); send.disabled = true;
    try {
      await api(`/mrs/${split.mrId}/discussion`, { method: 'POST', body: {
        body, old_path: split.fileOldPath, new_path: split.fileNewPath,
        old_line: row.dataset.old || null, new_line: row.dataset.new || null,
      } });
      toast(tr('toast.commentaire-poste-sur-la-ligne'));
      ed.remove();
      // recharge les discussions pour afficher le nouveau commentaire en place
      try { const dd = await api(`/mrs/${split.mrId}/discussions`); split.discussions = dd.discussions || []; } catch { /* ignore */ }
      renderFile();
    } catch (err) { send.disabled = false; toast(err.message, true); }
  });
});
/* Modifier / supprimer un commentaire en attente, et les envoyer tous. Délégué : le contenu
   du fichier est régénéré à chaque changement de fichier. */
$('#fileContent').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-draftdel]');
  if (del) {
    const id = Number(del.dataset.draftdel);
    try {
      await api(`/mrs/${split.mrId}/comment-drafts/${id}`, { method: 'DELETE' });
      split.drafts = (split.drafts || []).filter((d) => d.id !== id);
      majBoutonBrouillons(); renderFile();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const edit = e.target.closest('[data-draftedit]');
  if (!edit) return;
  const id = Number(edit.dataset.draftedit);
  const bloc = edit.closest('.cmt-draft');
  const d = (split.drafts || []).find((x) => x.id === id);
  if (!bloc || !d || bloc.querySelector('textarea')) return;
  const corps = bloc.querySelector('.cmt-draft-body');
  corps.innerHTML = '<textarea class="cmt-draft-edit"></textarea>';
  const ta = corps.querySelector('textarea');
  ta.value = d.body; ta.focus();
  bloc.querySelector('.cmt-actions').innerHTML = `<button type="button" class="btn btn-sm" data-draftcancel="1">${esc(tr('ui.cancel'))}</button>`
    + `<button type="button" class="btn btn-sm btn-primary" data-draftsave="${id}">${esc(tr('ui.save'))}</button>`;
  bloc.querySelector('[data-draftcancel]').addEventListener('click', () => renderFile());
  bloc.querySelector('[data-draftsave]').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    try {
      const maj = await api(`/mrs/${split.mrId}/comment-drafts/${id}`, { method: 'PUT', body: { body } });
      split.drafts = (split.drafts || []).map((x) => (x.id === id ? maj : x));
      renderFile();
    } catch (err) { toast(explainError(err.message), true); }
  });
});

/* L'ENVOI GROUPÉ. Publier chez la forge notifie l'auteur : ça se confirme, et la question dit
   COMBIEN partent — c'est le seul moyen de s'apercevoir qu'on en avait oublié un. */
$('#draftsSend') && $('#draftsSend').addEventListener('click', async () => {
  const n = (split.drafts || []).length;
  if (!n) return;
  const ok = await confirmDialog({
    title: tr('cmt.draft.confirm.title'),
    text: tr('cmt.draft.confirm.text', { n, count: n, forge: forgeLabel(split.forge) }),
    detail: (split.drafts || []).map((d) => `${d.new_path || d.old_path}:${d.new_line || d.old_line || '?'} — ${String(d.body).split('\n')[0].slice(0, 80)}`).join('\n'),
    confirmLabel: tr('cmt.draft.send'),
    danger: false,
  });
  if (!ok) return;
  try {
    const r = await busy($('#draftsSend'), () => api(`/mrs/${split.mrId}/comment-drafts/send`, { method: 'POST' }));
    await chargerBrouillons();
    /* Ce qui a échoué RESTE en attente, et on le dit : un « envoyé » global sur un lot à
       moitié parti ferait fermer la MR en croyant le travail fait. */
    if (r.failed && r.failed.length) toast(tr('cmt.draft.partial', { n: r.sent, count: r.sent, f: r.failed.length }), true);
    else toast(tr('cmt.draft.sent', { n: r.sent, count: r.sent }));
    try { const dd = await api(`/mrs/${split.mrId}/discussions`); split.discussions = dd.discussions || []; } catch { /* ignore */ }
    renderFile();
  } catch (err) { toast(explainError(err.message), true); }
});

$('#treeSearch').addEventListener('input', renderTree);
$('#treeList').addEventListener('click', (e) => { const f = e.target.closest('.tree-file[data-path]'); if (f) selectFile(f.dataset.path); });
/* On note ce que l'utilisateur ouvre et ferme, à l'instant où il le fait. Rendre l'arbre avec
   `<details open>` ne déclenche PAS `toggle` : la mémoire ne retient donc que ses gestes à lui,
   jamais l'état par défaut recalculé. En phase de capture, car `toggle` ne remonte pas. */
$('#treeList').addEventListener('toggle', (e) => {
  const d = e.target.closest && e.target.closest('details.tree-folder');
  if (d) memoDossiers()[d.dataset.dir] = d.open;
}, true);
$('#reportToggle').addEventListener('click', () => {
  const hidden = $('.code-body', $('#splitView')).classList.toggle('no-report');
  $('#reportToggle').classList.toggle('off', hidden);
});
$('#treeToggle').addEventListener('click', () => {
  const hidden = $('.code-body', $('#splitView')).classList.toggle('no-tree');
  $('#treeToggle').classList.toggle('off', hidden);
});
$('#splitClose').addEventListener('click', closeSplit);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#splitView').hidden) closeSplit(); });

/* ---------- Modale contexte de la review ---------- */
let ticketState = { id: null, imageDataUrl: null, removeImage: false };

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function ticketSetPreview(src) {
  const wrap = $('#ticketDrop .ticket-preview-wrap');
  if (src) { $('#ticketPreview').src = src; wrap.hidden = false; }
  else { $('#ticketPreview').removeAttribute('src'); wrap.hidden = true; }
}

async function openTicket(id, title) {
  ticketState = { id, imageDataUrl: null, removeImage: false };
  $('#ticketMrTitle').textContent = title || '';
  await loadRepoOptions(); // nécessaire au combo dépôt des projets liés
  try {
    const d = await api(`/mrs/${id}`);
    $('#ticketText').value = (d.ticket && d.ticket.text) || '';
    ticketSetPreview(d.ticket && d.ticket.has_image ? `/api/mrs/${id}/ticket-image?t=${Date.now()}` : null);
    renderTicketJira(d.ticket || {});
    ticketState.repoId = d.mr ? d.mr.repo_id : (d.repo_id || null);
    // Liens de la MR si elle en a ; sinon on pré-remplit avec les défauts du dépôt.
    const links = (d.links && d.links.length) ? d.links : (d.repo_links || []);
    renderLinkRows(links.map((l) => ({ repo_id: l.repo_id, branch: l.branch || '' })));
  } catch (e) { toast(e.message, true); return; }
  $('#ticketModal').hidden = false;
}

/* Projets liés : une ligne = un dépôt (combo avec recherche, réutilisé) + une branche
   (combo alimenté par branchesFor, comme la modale de session). Sauvés avec le contexte. */
function linkRowHtml(idx, sel = {}) {
  return `<div class="link-row" data-row="${idx}">
    ${repoComboHtml(sel.repo_id, { idClass: 'link-repo', defaultFirst: false })}
    <div class="combo link-branch-combo">
      <input class="link-branch" data-pick-link="1" autocomplete="off" value="${esc(sel.branch || '')}" placeholder="${tr('context.links.branch-ph')}" />
      <div class="combo-options" hidden></div>
    </div>
    <button type="button" class="btn btn-icon btn-sm btn-danger" data-rmlink="${idx}" title="${tr('context.links.remove')}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
  </div>`;
}
function renderLinkRows(list) {
  const el = $('#linkRows');
  if (!el) return;
  el.innerHTML = (list || []).map((l, i) => linkRowHtml(i, l)).join('');
  wireRepoCombos(el);
  wireLinkBranchPickers();
  $$('#linkRows [data-rmlink]').forEach((b) => b.addEventListener('click', () => {
    b.closest('.link-row').remove();
  }));
}
// Sélecteur de branche des projets liés (liste déroulante avec recherche), calqué
// sur wireBranchPickers mais lisant le dépôt de la MÊME ligne.
function wireLinkBranchPickers() {
  $$('#linkRows .link-row').forEach((row) => {
    const input = row.querySelector('[data-pick-link]');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    const box = row.querySelector('.link-branch-combo .combo-options');
    const repoHidden = row.querySelector('.link-repo');
    const open = async () => {
      const repoId = Number(repoHidden.value);
      if (!repoId) { box.innerHTML = `<div class="combo-opt muted">${tr('context.links.pick-repo-first')}</div>`; box.hidden = false; return; }
      box.innerHTML = `<div class="combo-opt muted">${tr('task.combo.loading')}</div>`; box.hidden = false;
      let data;
      try { data = await branchesFor(repoId); }
      catch (e) { box.innerHTML = `<div class="combo-opt muted">${esc(errorHint(e.message) || e.message)}</div>`; return; }
      const q = input.value.toLowerCase();
      const list = data.branches.filter((b) => b.toLowerCase().includes(q)).slice(0, 200);
      const defOpt = data.def ? `<div class="combo-opt" data-b="">${tr('task.combo.default', { branch: esc(data.def) })}</div>` : '';
      box.innerHTML = defOpt + (list.map((b) => `<div class="combo-opt" data-b="${esc(b)}">${esc(b)}</div>`).join('')
        || `<div class="combo-opt muted">${tr('task.combo.no-branch')}</div>`);
    };
    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-b]');
      if (!o) return;
      input.value = o.dataset.b;
      box.hidden = true;
    });
  });
}
function readLinkRows() {
  return $$('#linkRows .link-row').map((row) => ({
    repo_id: Number(row.querySelector('.link-repo').value),
    branch: (row.querySelector('.link-branch').value || '').trim(),
  })).filter((l) => l.repo_id);
}

// Section « Contexte Jira » : le contenu récupéré (lecture), la fraîcheur, et
// l'erreur éventuelle (pour dire POURQUOI le contexte est vide plutôt que laisser
// croire à un oubli). Cachée si ni contenu ni erreur.
function renderTicketJira(ticket) {
  const box = $('#ticketJira');
  const hasContent = !!ticket.jira_text;
  const hasError = !!ticket.jira_error;
  // On montre la section — et donc le bouton Rafraîchir — dès qu'un ticket est
  // RÉCUPÉRABLE : Jira configuré + une clé détectée. Ça couvre les MR découvertes
  // AVANT que Jira soit configuré (jamais fetchées) : sinon aucun moyen de la tirer.
  const canFetch = ticket.jira_configured && ticket.jira_key;
  if (!hasContent && !hasError && !canFetch) { box.hidden = true; return; }
  box.hidden = false;
  $('#ticketJiraKey').textContent = ticket.jira_key || '';
  $('#ticketJiraAt').textContent = ticket.jira_at
    ? tr('context.jira.fetched', { when: fmtDateTime(ticket.jira_at) })
    : (hasContent ? '' : tr('context.jira.not-fetched'));
  $('#ticketJiraBody').innerHTML = hasContent ? mdToHtml(ticket.jira_text) : '';
  $('#ticketJiraBody').hidden = !hasContent;
  const err = $('#ticketJiraError');
  err.hidden = !hasError;
  if (hasError) err.textContent = tr('context.jira.error', { key: ticket.jira_key || '', error: ticket.jira_error });
}
function closeTicket() { $('#ticketModal').hidden = true; }

// Rafraîchir le contexte Jira depuis la modale (ne touche jamais au complément manuel).
const ticketJiraRefresh = $('#ticketJiraRefresh');
if (ticketJiraRefresh) ticketJiraRefresh.addEventListener('click', () => {
  if (!ticketState.id) return;
  busy(ticketJiraRefresh, () => api(`/mrs/${ticketState.id}/jira-refresh`, { method: 'POST' }))
    .then(() => api(`/mrs/${ticketState.id}`))
    .then((d) => { renderTicketJira(d.ticket || {}); toast(tr('toast.jira-refreshed')); })
    .catch((e) => {
      toast(explainError(e.message), true);
      api(`/mrs/${ticketState.id}`).then((d) => renderTicketJira(d.ticket || {})).catch(() => {});
    });
});

async function ticketPickFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const dataUrl = await readFileAsDataURL(file);
  ticketState.imageDataUrl = dataUrl;
  ticketState.removeImage = false;
  ticketSetPreview(dataUrl);
}

$('#ticketFile').addEventListener('change', (e) => { if (e.target.files[0]) ticketPickFile(e.target.files[0]); });
$('#ticketRemoveImg').addEventListener('click', () => {
  ticketState.imageDataUrl = null; ticketState.removeImage = true; ticketSetPreview(null); $('#ticketFile').value = '';
});
// collage d'une capture (Ctrl+V) quand la modale est ouverte
document.addEventListener('paste', (e) => {
  if ($('#ticketModal').hidden) return;
  const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
  if (item) { e.preventDefault(); ticketPickFile(item.getAsFile()); }
});
const linkSetDefault = $('#linkSetDefault');
if (linkSetDefault) linkSetDefault.addEventListener('click', () => {
  if (!ticketState.repoId) return;
  busy(linkSetDefault, () => api('/repos/' + ticketState.repoId + '/links', { method: 'POST', body: { links: readLinkRows() } }))
    .then((r) => toast(tr('toast.repo-links-set', { n: r.count, count: r.count })))
    .catch((e) => toast(explainError(e.message), true));
});
const linkAdd = $('#linkAdd');
if (linkAdd) linkAdd.addEventListener('click', () => {
  const cur = readLinkRows();
  cur.push({});
  renderLinkRows(cur);
});
$('#ticketCancel').addEventListener('click', closeTicket);
fermerAuFond('#ticketModal', closeTicket);
$('#ticketSave').addEventListener('click', async () => {
  const btn = $('#ticketSave'); btn.disabled = true;
  try {
    await api(`/mrs/${ticketState.id}/ticket`, { method: 'POST', body: {
      text: $('#ticketText').value,
      image: ticketState.imageDataUrl || undefined,
      removeImage: ticketState.removeImage || undefined,
    } });
    // Projets liés : enregistrés dans le même geste que le contexte.
    await api(`/mrs/${ticketState.id}/links`, { method: 'POST', body: { links: readLinkRows() } });
    toast(tr('toast.contexte-enregistre'));
    const savedId = ticketState.id;
    closeTicket();
    loadToReview();
    if (selectedMr && selectedMr === savedId) openReport(selectedMr, { keep: true }); // maj du ✓ dans le détail
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
});

/* ---------- Admin ---------- */
// Liste unique des champs texte du formulaire — chargement ET enregistrement
// itèrent dessus (une divergence entre les deux = un champ qui ne s'enregistre pas,
// exactement le bug qu'ont connu jira_email / jira_token).
const CONFIG_FIELDS = ['gitlab_url', 'jira_url', 'jira_email', 'jira_token', 'access_token',
  'github_url', 'github_token', 'jenkins_url', 'jenkins_user', 'jenkins_token', 'jenkins_refresh_minutes',
  'clone_path', 'prompt_review', 'prompt_explain', 'prompt_modify',
  'converge_threshold', 'converge_max_passes', 'jira_watch_minutes', 'retention_days',
  'stale_mr_days'];
async function loadConfig() {
  const c = await api('/config');
  const f = $('#configForm');
  for (const k of CONFIG_FIELDS) { if (f[k]) f[k].value = c[k] || ''; }
  f.auto_refresh_minutes.value = Number(c.auto_refresh_minutes) || 0; // 0 affiché explicitement
  // Idem : 0 signifie « sans limite », il doit s'écrire plutôt que rester vide.
  if (f.retention_days) f.retention_days.value = Number(c.retention_days) || 0;
  if (f.review_explain) f.review_explain.checked = c.review_explain !== '0'; // défaut : activé
  // Atterrissage sur le brief : coché par défaut, comme côté serveur.
  if (f.brief_on_open) f.brief_on_open.checked = c.brief_on_open !== '0';
  if (f.stale_mr_days) f.stale_mr_days.value = Number(c.stale_mr_days) || 5;
  if (f.jenkins_refresh_minutes) f.jenkins_refresh_minutes.value = Number(c.jenkins_refresh_minutes) || 0;
  renderNotifSettings();
}
$('#configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {};
  for (const k of CONFIG_FIELDS) { if (f[k]) body[k] = f[k].value; }
  body.auto_refresh_minutes = f.auto_refresh_minutes.value;
  if (f.review_explain) body.review_explain = f.review_explain.checked ? '1' : '0';
  if (f.brief_on_open) body.brief_on_open = f.brief_on_open.checked ? '1' : '0';
  // '***' = champ non touché (on n'écrase pas le secret) ; '' = effacement volontaire.
  if (body.access_token === '***') delete body.access_token;
  if (body.jira_token === '***') delete body.jira_token;
  if (body.github_token === '***') delete body.github_token;
  if (body.jenkins_token === '***') delete body.jenkins_token;
  try {
    await api('/config', { method: 'PUT', body });
    // Le formulaire est éclaté sur deux sous-onglets (Général / Merge Request) : on affiche
    // la confirmation dans l'onglet visible (chaque onglet a son propre `configInfo*`).
    const info = $('#sub-mr').classList.contains('active') ? $('#configInfoMr')
      : $('#sub-gitcfg').classList.contains('active') ? $('#configInfoGit')
      : $('#sub-jiracfg').classList.contains('active') ? $('#configInfoJira')
      : $('#configInfo');
    info.textContent = tr('ui.saved'); setTimeout(() => { info.textContent = ''; }, 2000);
    loadConfig(); refreshStatus();
  } catch (err) { toast(err.message, true); }
});

/* Section Réglages → Notifications : reflète l'état de la permission navigateur
   (le piège classique de cette API étant un refus silencieux) et les préférences
   par type. Tout est local (localStorage) — aucun aller-retour serveur. */
function renderNotifSettings() {
  const p = notifPrefs();
  $$('#sub-notif [data-notif]').forEach((cb) => { cb.checked = !!p[cb.dataset.notif]; });
  const th = $('#notifThreshold'); if (th) th.value = p.threshold;
  const status = $('#notifPermStatus');
  const reqBtn = $('#notifRequest');
  const perm = notifPermission();
  const map = { granted: 'settings.notif.perm-granted', denied: 'settings.notif.perm-denied', default: 'settings.notif.perm-default', unsupported: 'settings.notif.perm-unsupported' };
  if (status) status.textContent = tr(map[perm] || map.default);
  if (status) status.className = 'notif-status notif-' + perm;
  if (reqBtn) reqBtn.hidden = perm !== 'default';
}
$$('#sub-notif [data-notif]').forEach((cb) => cb.addEventListener('change', () => {
  const p = notifPrefs(); p[cb.dataset.notif] = cb.checked; setNotifPrefs(p); updateMuteBtn();
}));
{
  const th = $('#notifThreshold');
  if (th) th.addEventListener('change', () => { const p = notifPrefs(); const v = Number(th.value); p.threshold = Number.isFinite(v) ? v : NOTIF_DEFAULTS.threshold; setNotifPrefs(p); });
}
$('#notifRequest') && $('#notifRequest').addEventListener('click', async () => {
  if (!notifSupported()) return;
  try { await Notification.requestPermission(); } catch { /* refus */ }
  renderNotifSettings();
});
$('#notifTest') && $('#notifTest').addEventListener('click', async () => {
  if (!notifSupported()) { toast(tr('settings.notif.perm-unsupported'), true); return; }
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* refus */ } renderNotifSettings(); }
  if (Notification.permission !== 'granted') { toast(tr('settings.notif.test-blocked'), true); return; }
  showNotif(tr('settings.notif.test-title'), tr('settings.notif.test-body'));
});

// Nom de la forge d'une ligne, pour les libellés de lien (« GitLab ↗ » / « GitHub ↗ »).
function forgeLabel(forge) { return forge === 'github' ? 'GitHub' : 'GitLab'; }

// Badge de forge : deux dépôts homonymes sur GitLab et GitHub doivent se distinguer.
function forgeBadge(forge) {
  const f = forge === 'github' ? 'github' : 'gitlab';
  return `<svg class="ico forge-ico" title="${tr(`repo.forge.${f}`)}"><use href="#i-${f}"/></svg> `;
}

async function loadRepos() {
  const rows = await api('/repos');
  const el = $('#repoList');
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="card repo-row" data-repo="${r.id}">
      <div class="repo-view">
        <div style="min-width:0">
          <div class="title">${forgeBadge(r.forge)}${esc(r.project)}</div>
          <div class="meta">${esc(r.url)} · ${tr('settings.repo.pattern')} <code>${r.branch_pattern ? esc(r.branch_pattern) : tr('settings.repo.all-mrs')}</code></div>
        </div>
        <div class="spacer"></div>
        <label class="muted" title="${esc(tr('settings.repo.fetch-mrs-title'))}"><input type="checkbox" data-fetch="${r.id}" ${r.fetch_mrs == null || r.fetch_mrs ? 'checked' : ''}/> ${tr('settings.repo.fetch-mrs')}</label>
        <label class="muted" title="${esc(tr('settings.repo.enabled-title'))}"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''}/> ${tr('settings.repo.enabled')}</label>
        <button class="btn btn-sm" data-edit="${r.id}" title="${tr('settings.repo.edit-title')}"><svg class="ico"><use href="#i-edit"/></svg>${tr('settings.repo.edit')}</button>
        <button class="btn btn-icon btn-sm btn-danger" data-del="${r.id}" title="${tr('settings.repo.del-title')}"><svg class=\"ico\"><use href=\"#i-close\"/></svg></button>
      </div>
      <div class="repo-edit" hidden>
        <input data-f="url" value="${esc(r.url)}" placeholder="${tr('settings.repo.ph.url')}" />
        <input data-f="project" value="${esc(r.project)}" placeholder="${tr('settings.repo.ph.project')}" />
        <input data-f="branch_pattern" value="${esc(r.branch_pattern || '')}" placeholder="${tr('settings.repo.ph.pattern')}" />
        <div class="repo-edit-actions">
          <button class="btn" data-cancel="${r.id}" title="${tr('settings.repo.cancel-title')}">${tr('ui.cancel')}</button>
          <button class="btn btn-primary" data-save="${r.id}" title="${tr('settings.repo.save-title')}">${tr('ui.save')}</button>
        </div>
      </div>
    </div>`).join('') : emptyState({ icon: 'inbox', title: tr('settings.repo.empty.title'), text: tr('settings.repo.empty.text') });

  const rowEl = (id) => $(`#repoList .repo-row[data-repo="${id}"]`);
  const toggleEdit = (id, editing) => {
    const row = rowEl(id);
    row.querySelector('.repo-view').hidden = editing;
    row.querySelector('.repo-edit').hidden = !editing;
  };

  $$('#repoList [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-repo'), confirmLabel: tr('ui.delete') })) return;
    await api(`/repos/${b.dataset.del}`, { method: 'DELETE' }); loadRepos();
  }));
  $$('#repoList [data-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
    await api(`/repos/${cb.dataset.toggle}`, { method: 'PUT', body: { enabled: cb.checked } });
  }));
  /* Décocher ne touche pas aux MR DÉJÀ récupérées : elles restent dans la file, on cesse
     seulement d'en ramener de nouvelles. Le message le dit, sinon on croit à une purge. */
  $$('#repoList [data-fetch]').forEach((cb) => cb.addEventListener('change', async () => {
    try {
      await api(`/repos/${cb.dataset.fetch}`, { method: 'PUT', body: { fetch_mrs: cb.checked } });
      toast(tr(cb.checked ? 'toast.repo.fetch-on' : 'toast.repo.fetch-off'));
    } catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
  }));
  $$('#repoList [data-edit]').forEach((b) => b.addEventListener('click', () => toggleEdit(b.dataset.edit, true)));
  $$('#repoList [data-cancel]').forEach((b) => b.addEventListener('click', () => toggleEdit(b.dataset.cancel, false)));
  $$('#repoList [data-save]').forEach((b) => b.addEventListener('click', async () => {
    const row = rowEl(b.dataset.save);
    const body = {};
    row.querySelectorAll('.repo-edit [data-f]').forEach((i) => { body[i.dataset.f] = i.value; });
    b.disabled = true;
    try { await api(`/repos/${b.dataset.save}`, { method: 'PUT', body }); toast(tr('toast.depot-mis-a-jour')); loadRepos(); }
    catch (e) { b.disabled = false; toast(e.message, true); }
  }));
  // Les répertoires locaux vivent dans le même panneau : ils se chargent avec lui.
  loadLocalRootSettings();
}
$('#repoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/repos', { method: 'POST', body: { project: f.project.value, url: f.url.value, branch_pattern: f.branch_pattern.value } });
    f.project.value = ''; f.url.value = ''; loadRepos();
  } catch (err) { toast(err.message, true); }
});

/* ---- Réglages → Dépôts : les répertoires LOCAUX ----
   Rien n'est cloné ici : on déclare un dossier déjà présent sur la machine. Le
   décompte affiché (« 12 projets git sur 14 dossiers ») est ce qui dit d'un coup
   d'œil qu'on a désigné le bon niveau d'arborescence, et non son parent. */
async function loadLocalRootSettings() {
  const el = $('#localRootList');
  if (!el) return;
  await loadLocalRoots();
  el.innerHTML = localRoots.length ? localRoots.map((r) => `
    <div class="card local-root-card">
      <div style="min-width:0;flex:1">
        <div class="title">${esc(r.label || r.path)}
          <button class="btn btn-icon btn-sm btn-danger" data-rootdel="${r.id}" title="${esc(tr('settings.localroot.del-title'))}" style="float:right"><svg class="ico"><use href="#i-close"/></svg></button>
        </div>
        <div class="meta">${r.label ? `${esc(r.path)} · ` : ''}${r.error
          ? `<span class="t-err">${esc(r.error)}</span>`
          : esc(tr('settings.localroot.count', { n: r.count, count: r.count, git: r.git_count }))}</div>
        ${!r.error && r.projects && r.projects.length ? `<div class="local-root-projects">${r.projects.map((p) => `
          <span class="local-proj${p.git ? '' : ' local-proj-nogit'}" title="${esc(p.git ? tr('settings.localroot.proj-git', { branch: p.branch || '?' }) : tr('settings.localroot.proj-nogit'))}">
            <svg class="ico ico-sm"><use href="#${p.git ? 'i-branch' : 'i-doc'}"/></svg>${esc(p.name)}${p.git && p.branch ? ` <code>${esc(p.branch)}</code>` : ''}
          </span>`).join('')}</div>` : ''}
      </div>
    </div>`).join('')
    : emptyState({ icon: 'inbox', title: tr('settings.localroot.empty.title'), text: tr('settings.localroot.empty.text') });
  $$('#localRootList [data-rootdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-local-root'), confirmLabel: tr('ui.delete') })) return;
    try {
      await api(`/local-roots/${b.dataset.rootdel}`, { method: 'DELETE' });
      localProjectsCache.clear();
      toast(tr('toast.local-root-deleted'));
      loadLocalRootSettings();
    } catch (e) { toast(explainError(e.message), true); }
  }));
}
$('#localRootForm') && $('#localRootForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/local-roots', { method: 'POST', body: { path: f.path.value, label: f.label.value } });
    f.path.value = ''; f.label.value = '';
    localProjectsCache.clear();
    toast(tr('toast.local-root-added'));
    loadLocalRootSettings();
  } catch (err) { toast(explainError(err.message), true); }
});

/* ---------- Dev IA : sessions de codage et d'exploration ----------
   Une session porte sur UN OU PLUSIEURS projets, chacun avec sa branche.
   - Codage    : l'IA modifie le code de chaque projet → commit / push / MR PAR PROJET.
   - Exploration : lecture seule, l'IA répond à une question sur l'ensemble des projets
     et sa réponse est enregistrée dans un .md consultable. Ni diff ni merge. */
let taskNewImages = [];        // captures du formulaire (data URLs)
let taskKind = 'code';         // sous-onglet courant : 'code' | 'local' | 'explore'
// Sessions rangées : masquées par défaut, la préférence est relue au démarrage.
let showHiddenTasks = (() => { try { return localStorage.getItem('aidevtools_show_hidden') === '1'; } catch { return false; } })();
let allTasks = [];             // dernier chargement (sessions code/explore)
let localTasks = [];           // sessions « Codage hors dépôt »
let localRootId = '';          // répertoire local choisi dans le formulaire local
let localPicks = [''];         // projets choisis dans ce répertoire (noms de dossier)
let repoOptions = [];          // dépôts disponibles pour les sélecteurs

const KIND_LABEL = {
  code: { title: tr('task.kind.code.title'), btn: tr('task.kind.code.btn'), hint: tr('task.kind.code.hint') },
  local: { title: tr('task.kind.local.title'), btn: tr('task.kind.local.btn'), hint: tr('task.kind.local.hint') },
  explore: { title: tr('task.kind.explore.title'), btn: tr('task.kind.explore.btn'), hint: tr('task.kind.explore.hint') },
};

async function loadRepoOptions() {
  try { repoOptions = await api('/repos'); } catch { repoOptions = []; }
  return repoOptions;
}

/* ---- Sélecteur de dépôt réutilisable (recherche à la frappe) ----
   Un <select> natif devient inutilisable dès quelques dizaines de dépôts : ce
   combo filtre à la frappe. Il expose un input caché (la valeur réellement
   retenue) et déclenche un vrai événement 'change' dessus à la sélection, pour
   que le code appelant réagisse comme à un <select>.
   Le modale de session a son propre équivalent (wireRepoPickers), déjà éprouvé ;
   ce helper sert aux listes de l'onglet Git. */
function repoComboHtml(currentId, { idClass = '', idAttr = '', defaultFirst = true } = {}) {
  // Comme le <select> natif qu'il remplace : à défaut de sélection, le 1er dépôt
  // (sauf pour l'explorateur, où on ne veut rien analyser tant qu'on n'a pas choisi).
  const cur = repoOptions.find((r) => r.id === Number(currentId)) || (defaultFirst ? repoOptions[0] : null) || null;
  const dis = repoOptions.length ? '' : 'disabled';
  const ph = repoOptions.length ? tr('task.ph.search-repo') : tr('task.ph.no-repo');
  return `<div class="combo repo-combo">
    <input class="rc-search" data-repo-combo autocomplete="off" value="${esc(cur ? cur.project : '')}" title="${esc(cur ? cur.project : '')}" placeholder="${ph}" ${dis} />
    <input type="hidden" class="rc-id ${idClass}"${idAttr ? ` id="${idAttr}"` : ''} value="${cur ? cur.id : ''}" />
    <div class="combo-options" hidden></div>
  </div>`;
}
function wireRepoCombos(root) {
  $$('[data-repo-combo]', root || document).forEach((input) => {
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    const combo = input.closest('.repo-combo');
    const hidden = combo.querySelector('.rc-id');
    const box = combo.querySelector('.combo-options');
    const labelOf = (id) => { const r = repoOptions.find((x) => x.id === Number(id)); return r ? r.project : ''; };
    const open = () => {
      const q = input.value.trim().toLowerCase();
      const list = repoOptions.filter((r) => r.project.toLowerCase().includes(q)).slice(0, 200);
      box.innerHTML = list.map((r) => `<div class="combo-opt" data-r="${r.id}">${esc(r.project)}</div>`).join('')
        || `<div class="combo-opt muted">${tr('task.combo.no-repo')}</div>`;
      box.hidden = false;
    };
    // Au focus on vide l'affichage : sinon le nom courant filtrerait la liste à
    // ce seul dépôt. Le blur le rétablit depuis `hidden` : rien n'est perdu.
    input.addEventListener('focus', () => { input.value = ''; open(); });
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; input.value = labelOf(hidden.value); input.title = input.value; input.scrollLeft = input.scrollWidth; }, 150));
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-r]');
      if (!o) return;
      const changed = hidden.value !== o.dataset.r;
      hidden.value = o.dataset.r;
      input.value = labelOf(o.dataset.r);
      input.title = input.value; input.scrollLeft = input.scrollWidth; // nom complet au survol, fin visible
      box.hidden = true;
      if (changed) hidden.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

/* ---- Combo GÉNÉRIQUE (liste déroulante avec recherche) ----
   Même comportement que le combo de dépôts ci-dessus, mais les options sont fournies
   par une FONCTION : elles peuvent dépendre d'un autre champ de la même ligne (les
   branches d'un projet) et être chargées à l'ouverture.
   Le libellé affiché est mémorisé sur l'input caché (`data-label`) : sans lui, un
   combo dont les options ne sont pas encore chargées afficherait un champ vide alors
   qu'une valeur est bel et bien retenue. */
function comboHtml(cls, { value = '', label = '', ph = '', disabled = false, wrapClass = '' } = {}) {
  return `<div class="combo ${wrapClass}">
    <input class="cb-search" data-combo="${cls}" autocomplete="off" value="${esc(label)}" title="${esc(label)}" placeholder="${esc(ph)}" ${disabled ? 'disabled' : ''} />
    <input type="hidden" class="${cls}" value="${esc(String(value))}" data-label="${esc(label)}" />
    <div class="combo-options" hidden></div>
  </div>`;
}
/* `load(rowEl)` renvoie [{ value, label, hint }] et peut être asynchrone. La mise en
   cache est laissée à l'appelant : lui seul sait quand une liste devient périmée
   (après un checkout, la branche courante d'un projet a changé). */
/* Le menu d'un combo est posé en `position: fixed`, aux coordonnées du champ.

   En absolu, il appartient au flux d'un ancêtre : dès que celui-ci défile (la liste des dépôts
   d'un vérificateur, la colonne des rapports…), le menu est ROGNÉ par lui. Le contournement
   d'avant — rendre l'overflow visible le temps de l'ouverture — coûtait deux défauts pour un :
   le navigateur remet `scrollTop` à zéro quand un conteneur cesse de défiler, donc la liste
   sautait en haut et le champ filait sous le menu ; et le menu, n'étant plus rogné, s'affichait
   jusqu'à 186 px SOUS le bloc, détaché de son champ.

   En fixed, plus d'ancêtre qui rogne, et le menu s'ouvre au-dessus du champ quand il n'y a pas
   la place en dessous — la fin d'une liste est justement là où on manque de place. */
function placerMenu(input, box) {
  const r = input.getBoundingClientRect();
  const marge = 8;
  box.style.position = 'fixed';
  box.style.left = `${r.left}px`;
  box.style.width = `${r.width}px`;
  const dessous = window.innerHeight - r.bottom - marge;
  const dessus = r.top - marge;
  // On ne bascule au-dessus que si c'est franchement mieux : sinon le menu sautillerait
  // d'un côté à l'autre au fil du filtrage, pendant qu'on tape.
  const versLeHaut = dessous < 160 && dessus > dessous;
  box.style.maxHeight = `${Math.max(120, Math.min(240, versLeHaut ? dessus : dessous))}px`;
  if (versLeHaut) { box.style.top = 'auto'; box.style.bottom = `${window.innerHeight - r.top + 2}px`; }
  else { box.style.bottom = 'auto'; box.style.top = `${r.bottom + 2}px`; }
}

function wireCombo(root, cls, load) {
  $$(`[data-combo="${cls}"]`, root || document).forEach((input) => {
    if (input.dataset.wired) return;
    input.dataset.wired = '1';
    const combo = input.closest('.combo');
    const hidden = combo.querySelector(`.${cls}`);
    const box = combo.querySelector('.combo-options');
    const restore = () => { input.value = hidden.dataset.label || ''; input.title = input.value; input.scrollLeft = input.scrollWidth; };
    /* Le menu ne fait plus partie du flux : il faut le suivre à la main quand ce qui l'entoure
       bouge. En capture, pour attraper AUSSI le défilement d'un conteneur interne, qui ne
       remonte pas jusqu'à `window`. */
    const suivre = () => { if (!box.hidden) placerMenu(input, box); };
    const ecouter = (on) => {
      const fn = on ? 'addEventListener' : 'removeEventListener';
      window[fn]('scroll', suivre, true);
      window[fn]('resize', suivre);
    };
    const open = async () => {
      box.innerHTML = `<div class="combo-opt muted">${esc(tr('ui.combo.loading'))}</div>`;
      box.hidden = false;
      placerMenu(input, box);
      ecouter(true);
      let opts;
      try { opts = await load(combo.closest('[data-row]')); }
      catch (e) { box.innerHTML = `<div class="combo-opt muted">${esc(explainError(e.message))}</div>`; return; }
      const q = input.value.trim().toLowerCase();
      const list = opts.filter((o) => String(o.label).toLowerCase().includes(q)).slice(0, 300);
      box.innerHTML = list.map((o) => `<div class="combo-opt" data-v="${esc(String(o.value))}" data-l="${esc(String(o.label))}">${esc(String(o.label))}${o.hint ? ` <span class="muted">${esc(o.hint)}</span>` : ''}</div>`).join('')
        || `<div class="combo-opt muted">${esc(tr('ui.combo.empty'))}</div>`;
      // Le contenu vient de changer de hauteur : ce qui tenait en dessous n'y tient plus forcément.
      placerMenu(input, box);
    };
    const fermer = () => { box.hidden = true; ecouter(false); };
    // Au focus on vide l'affichage : sinon le libellé courant servirait lui-même de
    // filtre et la liste se réduirait à cette seule option. Le blur le rétablit
    // depuis `data-label`, donc une saisie libre ne vaut jamais sélection.
    input.addEventListener('focus', () => { input.value = ''; open(); });
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => { fermer(); restore(); }, 150));
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-v]');
      if (!o) return;
      const changed = hidden.value !== o.dataset.v;
      hidden.value = o.dataset.v;
      hidden.dataset.label = o.dataset.l;
      restore();
      fermer();
      // Un input caché n'émet pas 'change' tout seul : on le déclenche pour que les
      // champs qui en dépendent (branches d'un projet) se remettent à zéro.
      if (changed) hidden.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

/* ---- Répertoires locaux (Réglages → Dépôts · Git → Navigation · codage hors dépôt) ----
   Un répertoire local = un dossier de la machine contenant un sous-dossier par projet
   git. La liste des projets se relit du DISQUE : on ne la garde en cache que le temps
   d'un écran, sinon un dépôt cloné entre deux visites resterait invisible. */
let localRoots = [];
const localProjectsCache = new Map();

async function loadLocalRoots() {
  try { localRoots = await api('/local-roots'); } catch { localRoots = []; }
  return localRoots;
}
// Le chemin reste visible même quand un nom court est donné : deux dossiers « front »
// dans deux arborescences différentes seraient sinon indiscernables dans la liste.
const rootLabel = (r) => (r.label ? `${r.label} — ${r.path}` : r.path);

async function localProjectsOf(rootId) {
  const key = String(rootId);
  let entry = localProjectsCache.get(key);
  if (!entry) {
    // On mémoïse la PROMESSE (focus puis frappe ouvrent la liste deux fois de suite),
    // puis on lui substitue le résultat : la branche courante d'un projet se lit alors
    // sans attendre, depuis le même cache.
    entry = api(`/local-roots/${rootId}/projects`).then((d) => {
      const list = d.projects || [];
      localProjectsCache.set(key, list);
      return list;
    });
    localProjectsCache.set(key, entry);
  }
  try { return await entry; }
  catch (e) { localProjectsCache.delete(key); throw e; }   // un échec ne se fige pas en cache
}
// Branche courante d'un projet, telle que le dernier listing l'a vue (le cache vient
// d'être rempli par le sélecteur : pas d'appel supplémentaire pour une seule colonne).
function localProjectBranch(rootId, name) {
  const cached = localProjectsCache.get(String(rootId));
  if (!cached || typeof cached.then === 'function') return '';
  const p = cached.find((x) => x.name === name);
  return (p && p.branch) || '';
}

/* ---- Éditeur « projets et branches » de la modale ---- */
// Icône « i » + explication du champ. Même markup que les champs statiques
// d'index.html ; l'affichage est géré par la délégation en bas de fichier.
function hint(text) {
  const t = esc(text);
  return `<button type="button" class="hint" tabindex="0" aria-label="${t}" data-tip="${t}"><svg class="ico"><use href="#i-info"/></svg></button>`;
}

function targetRowHtml(idx, sel = {}) {
  // Le <select> natif devenait inutilisable au-delà de quelques dizaines de dépôts :
  // même composant combo que les branches, avec filtre à la frappe.
  // Comme avant, une nouvelle ligne présélectionne le 1er dépôt (sinon elle serait
  // silencieusement ignorée par readTargetRows, qui écarte les lignes sans repo_id).
  const cur = repoOptions.find((r) => r.id === Number(sel.repo_id)) || repoOptions[0] || null;
  // Le champ qui désigne une branche EXISTANTE est un sélecteur avec recherche :
  // en codage la branche de départ, en exploration la branche à regarder.
  // La branche de travail (codage) reste libre : elle est souvent à créer.
  const workHint = taskKind === 'code'
    ? hint(tr('task.tip.work-branch-code'))
    : hint(tr('task.tip.work-branch-explore'));
  const workField = taskKind === 'code'
    ? `<input class="t-branch" value="${esc(sel.branch || '')}" placeholder="${tr('task.ph.work-branch')}" />`
    : `<div class="combo"><input class="t-branch" data-pick="1" autocomplete="off" value="${esc(sel.branch || '')}" placeholder="${tr('task.ph.read-branch')}" /><div class="combo-options" hidden></div></div>`;
  const baseField = taskKind === 'code'
    ? `<div class="combo"><input class="t-base" data-pick="1" autocomplete="off" value="${esc(sel.base_branch || '')}" placeholder="${tr('task.ph.base-branch')}" /><div class="combo-options" hidden></div></div>`
    : '';
  return `<div class="target-row" data-row="${idx}">
    <div class="combo repo-combo">
      <input class="t-repo-search" data-pick-repo="1" autocomplete="off" value="${esc(cur ? cur.project : '')}" title="${esc(cur ? cur.project : '')}" placeholder="${repoOptions.length ? tr('task.ph.search-repo') : tr('task.ph.no-repo')}" ${repoOptions.length ? '' : 'disabled'} />
      <input type="hidden" class="t-repo" value="${cur ? cur.id : ''}" />
      <div class="combo-options" hidden></div>
    </div>${hint(tr('task.tip.repo'))}
    ${workField}${workHint}
    ${baseField}${taskKind === 'code' ? hint(tr('task.tip.base-branch')) : ''}
    <button type="button" class="btn btn-icon btn-sm btn-danger" data-rmrow="${idx}" title="${tr('task.title.remove-project')}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
  </div>`;
}
function readTargetRows() {
  return $$('#targetRows .target-row').map((row) => {
    const base = row.querySelector('.t-base');
    return {
      repo_id: Number(row.querySelector('.t-repo').value),
      branch: row.querySelector('.t-branch').value.trim(),
      base_branch: base ? base.value.trim() : '',
    };
  }).filter((t) => t.repo_id);
}
function renderTargetRows(list) {
  const el = $('#targetRows');
  el.innerHTML = (list.length ? list : [{}]).map((t, i) => targetRowHtml(i, t)).join('');
  $$('#targetRows [data-rmrow]').forEach((b) => b.addEventListener('click', () => {
    const cur = readTargetRows();
    if (cur.length <= 1) { toast(tr('toast.au-moins-un-projet-est'), true); return; }
    cur.splice(Number(b.dataset.rmrow), 1);
    renderTargetRows(cur);
  }));
  wireRepoPickers();
  wireBranchPickers();
  $('#targetsHint').textContent = taskKind === 'code'
    ? tr('task.hint.code')
    : tr('task.hint.explore');
}
$('#addTarget').addEventListener('click', () => renderTargetRows([...readTargetRows(), {}]));


/* ---- Sélecteur de branche existante (liste déroulante avec recherche) ----
   Les branches sont récupérées sur GitLab à la demande, puis mises en cache par
   dépôt : ouvrir plusieurs lignes du même projet ne relance pas d'appel. */
const branchCache = new Map();
async function branchesFor(repoId) {
  if (branchCache.has(repoId)) return branchCache.get(repoId);
  const r = await api(`/gitlab/branches?repo_id=${repoId}`);
  const v = { branches: r.branches || [], def: r.default || '' };
  branchCache.set(repoId, v);
  return v;
}
function wireRepoPickers() {
  $$('#targetRows .target-row').forEach((row) => {
    const input = row.querySelector('[data-pick-repo]');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    const hidden = row.querySelector('.t-repo');
    const box = row.querySelector('.repo-combo .combo-options');
    const labelOf = (id) => { const r = repoOptions.find((x) => x.id === Number(id)); return r ? r.project : ''; };
    const open = () => {
      const q = input.value.trim().toLowerCase();
      const list = repoOptions.filter((r) => r.project.toLowerCase().includes(q)).slice(0, 200);
      box.innerHTML = list.map((r) => `<div class="combo-opt" data-r="${r.id}">${esc(r.project)}</div>`).join('')
        || `<div class="combo-opt muted">${tr('task.combo.no-repo')}</div>`;
      box.hidden = false;
    };
    // Au focus on vide l'affichage : sinon le nom du dépôt courant servirait
    // lui-même de filtre et la liste se réduirait à ce seul dépôt. Le blur le
    // rétablit depuis `hidden`, donc rien n'est perdu si l'on ne choisit rien.
    input.addEventListener('focus', () => { input.value = ''; open(); });
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => {
      box.hidden = true;
      // Le texte libre ne vaut pas sélection : on réaffiche le dépôt réellement
      // retenu, sinon l'écran montrerait autre chose que ce qui sera enregistré.
      input.value = labelOf(hidden.value);
      input.title = input.value; input.scrollLeft = input.scrollWidth;
    }, 150));
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-r]');
      if (!o) return;
      const changed = hidden.value !== o.dataset.r;
      hidden.value = o.dataset.r;
      input.value = labelOf(o.dataset.r);
      input.title = input.value; input.scrollLeft = input.scrollWidth;
      box.hidden = true;
      // Un input caché n'émet pas 'change' tout seul : on le déclenche pour que
      // le sélecteur de branche remette son champ à zéro (branche d'un autre dépôt).
      if (changed) hidden.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

function wireBranchPickers() {
  $$('#targetRows .target-row').forEach((row) => {
    const input = row.querySelector('[data-pick]');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    // Le conteneur d'options DOIT être celui du .combo de CE champ (branche), sinon
    // row.querySelector renvoie le premier de la ligne — celui du combo projet — et la
    // liste s'affiche au mauvais endroit (sous le projet, à gauche).
    const box = input.closest('.combo').querySelector('.combo-options');
    const repoSel = row.querySelector('.t-repo');
    const open = async () => {
      const repoId = Number(repoSel.value);
      if (!repoId) return;
      box.innerHTML = '<div class="combo-opt muted">chargement des branches…</div>';
      box.hidden = false;
      let data;
      try { data = await branchesFor(repoId); }
      catch (e) { box.innerHTML = `<div class="combo-opt muted">${esc(errorHint(e.message) || e.message)}</div>`; return; }
      const q = input.value.toLowerCase();
      const list = data.branches.filter((b) => b.toLowerCase().includes(q)).slice(0, 200);
      const defOpt = data.def ? `<div class="combo-opt" data-b="">${tr('task.combo.default', { branch: esc(data.def) })}</div>` : '';
      box.innerHTML = defOpt + (list.map((b) => `<div class="combo-opt" data-b="${esc(b)}">${esc(b)}</div>`).join('')
        || '<div class="combo-opt muted">aucune branche ne correspond</div>');
    };
    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
    box.addEventListener('mousedown', (e) => {
      const o = e.target.closest('.combo-opt[data-b]');
      if (!o) return;
      input.value = o.dataset.b;
      box.hidden = true;
    });
    // changer de projet invalide la branche saisie (elle appartenait à l'autre dépôt)
    repoSel.addEventListener('change', () => { input.value = ''; box.hidden = true; });
  });
}

/* ---- Captures ---- */
function renderTaskPreviews() {
  $('#taskPreviews').innerHTML = taskNewImages.map((src, i) => `
    <span class="task-prev"><img src="${src}" /><button type="button" data-rmimg="${i}" title="Retirer cette capture"><svg class="ico"><use href="#i-close"/></svg></button></span>`).join('');
  $$('#taskPreviews [data-rmimg]').forEach((b) => b.addEventListener('click', () => {
    taskNewImages.splice(Number(b.dataset.rmimg), 1); renderTaskPreviews();
  }));
}
function readFileDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
async function addTaskImages(files) {
  for (const f of files) if (f && f.type.startsWith('image/')) taskNewImages.push(await readFileDataURL(f));
  renderTaskPreviews();
}
$('#taskFile').addEventListener('change', (e) => addTaskImages([...e.target.files]));
document.addEventListener('paste', (e) => {
  if ($('#taskModal').hidden) return;
  const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
  if (imgs.length) { e.preventDefault(); addTaskImages(imgs); }
});

/* ---- Modale ---- */
let editingTaskId = null;
let launchAfterCreate = false;
let convergeAfterCreate = false; // « Converger » depuis la modale : créer puis ouvrir la modale de convergence

function applyKindToModal(kind) {
  const isLocal = kind === 'local';
  $('#codeOnlyFields').hidden = kind !== 'code';
  // « Converger » : sessions de CODAGE GitLab, et seulement à la création (pas en édition).
  const cv = $('#taskConverge'); if (cv) cv.hidden = kind !== 'code' || !!editingTaskId;
  // Codage hors dépôt : dossiers locaux à la place des projets, Jira & avertissement.
  $('#taskReposWrap').hidden = isLocal;
  $('#taskLocalWrap').hidden = !isLocal;
  $('#taskLocalWarn').hidden = !isLocal;
  if (isLocal) { $('#taskJiraRow').hidden = true; renderLocalRootPicker(); renderLocalDirRows(); }
  const ta = $('#taskForm').prompt;
  ta.placeholder = isLocal ? tr('local.prompt-ph') : (kind === 'code' ? tr('task.ph.prompt-code') : tr('task.ph.prompt-explore'));
  $('#targetsLabel').textContent = kind === 'code' ? tr('task.targets.code') : tr('task.targets.explore');
}

/* LE VÉRIFICATEUR D'UNE SESSION. Il ne se propose que s'il COUVRE TOUS LES DÉPÔTS choisis :
   un vérificateur qui n'en couvre que la moitié rendrait un vert qui ne dit rien de l'autre,
   et le proposer serait promettre un verdict qu'on ne peut pas tenir. La liste se refait donc
   à chaque changement de projets. */
async function majVerificateursSession(choisi = null) {
  const sel = $('#taskVerifier');
  if (!sel) return;
  const garde = choisi === null ? sel.value : String(choisi || '');
  const repos = readTargetRows().map((t) => t.repo_id).filter(Boolean);
  let liste = [];
  // La route rend un TABLEAU, pas un objet enveloppe : s'en assurer ici évite un écran vide.
  try { const d = await api('/verifiers'); liste = Array.isArray(d) ? d : (d.verifiers || []); } catch { liste = []; }
  const couvrants = liste.filter((v) => repos.every((id) => (v.repos || []).some((r) => r.repo_id === id)));
  sel.innerHTML = `<option value="">${esc(tr('task.verifier.none'))}</option>`
    + couvrants.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  if (!couvrants.length && repos.length) {
    sel.innerHTML = `<option value="">${esc(tr('task.verifier.none-covering'))}</option>`;
  }
  sel.value = couvrants.some((v) => String(v.id) === garde) ? garde : '';
  majLienVerifPush();
}

/* LES DEUX CASES SONT LIÉES, dans les deux sens. Un vérificateur ne peut pas travailler sur du
   code qui n'est pas poussé : le choisir coche l'auto-push, et retirer l'auto-push retire le
   vérificateur. Le faire dans un seul sens laisserait une combinaison qui ne peut pas
   s'exécuter — et on ne le découvrirait qu'à la fin de la session. */
function majLienVerifPush() {
  const f = $('#taskForm');
  const sel = $('#taskVerifier');
  if (!f || !sel || !f.auto_push) return;
  const actif = !!sel.value;
  if (actif && !f.auto_push.checked) f.auto_push.checked = true;
  const note = $('#taskVerifierNote');
  if (note) note.hidden = !actif;
}
$('#taskVerifier') && $('#taskVerifier').addEventListener('change', majLienVerifPush);
/* Changer les projets change la liste : un vérificateur qui couvrait les deux premiers dépôts
   ne couvre pas forcément le troisième, et le laisser sélectionné promettrait un verdict
   qu'on ne peut pas tenir. */
$('#targetRows') && $('#targetRows').addEventListener('change', () => { majVerificateursSession(); });
document.addEventListener('change', (e) => {
  if (!e.target.closest || !e.target.matches('#taskForm [name="auto_push"]')) return;
  const sel = $('#taskVerifier');
  if (!sel) return;
  if (!e.target.checked && sel.value) { sel.value = ''; toast(tr('task.verifier.dropped')); }
  majLienVerifPush();
});

async function openTaskModal(kind = taskKind) {
  editingTaskId = null; launchAfterCreate = false; convergeAfterCreate = false;
  const f = $('#taskForm');
  f.reset(); taskNewImages = []; renderTaskPreviews();
  taskKind = kind;
  if (kind !== 'local') await loadRepoOptions();
  if (kind === 'local') { localPicks = ['']; await loadLocalRoots(); }
  applyKindToModal(kind);
  if (kind !== 'local') { renderTargetRows([{}]); setupTaskJira(''); }
  await majVerificateursSession('');
  $('#taskModalTitle').textContent = KIND_LABEL[kind].title;
  $('#taskExistingImgs').textContent = '';
  /* Codage hors dépôt : le bouton principal crée ET lance, c'est le geste courant. Mais
     « Créer sans lancer » l'accompagne, comme pour une session de codage ouverte depuis
     une MR — préparer un traitement et le déclencher plus tard est un besoin légitime, et
     rien ne le permettait ici. Codage et exploration, eux, enregistrent sans lancer : leur
     bouton principal EST déjà le « sans lancer ». */
  launchAfterCreate = kind === 'local';
  $('#taskSubmit').innerHTML = kind === 'local'
    ? `<svg class="ico"><use href="#i-play"/></svg>${tr('local.run')}`
    : `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
  $('#taskSubmitOnly').hidden = kind !== 'local';
  showTaskModal();
  f.prompt.focus();
}

// Depuis une MR : session de codage sur la branche de la MR, créée ET lancée.
/* Affiche la modale de session. Passe obligé de TOUS les points d'entrée (nouvelle session,
   depuis une MR, depuis un ticket, édition) : la mention sous le champ « identifiant de session »
   ne vaut que pour l'ouverture qui l'a posée, et cinq appelants qui pensent à l'effacer, c'est
   un sixième qui oubliera. */
function showTaskModal() {
  const hint = $('#taskSessionHint');
  if (hint && !hint.dataset.keep) { hint.textContent = ''; hint.hidden = true; }
  if (hint) delete hint.dataset.keep;
  $('#taskModal').hidden = false;
}

async function openTaskForMr(m, opts = {}) {
  const f = $('#taskForm');
  f.reset(); taskNewImages = []; renderTaskPreviews();
  editingTaskId = null; taskKind = 'code';
  await loadRepoOptions();
  applyKindToModal('code');
  // branche de travail = la branche de la MR ; départ = sa branche cible
  renderTargetRows([{ repo_id: m.repo_id, branch: m.source_branch, base_branch: m.target_branch }]);
  setupTaskJira(m.source_branch);
  launchAfterCreate = true; convergeAfterCreate = false;
  if (opts.prompt) f.prompt.value = opts.prompt;
  if (opts.commitMessage && f.commit_message) f.commit_message.value = opts.commitMessage;
  /* Reprendre la session de codage d'origine évite à l'IA de redécouvrir un code qu'elle vient
     d'écrire. Le champ est PRÉ-REMPLI, pas verrouillé : le lien est déduit de (dépôt, branche),
     ce qui n'est pas une preuve — la branche a pu être reprise à la main. On voit donc ce qui
     sera repris, et il suffit de vider le champ pour repartir d'une session neuve. */
  if (f.session_id) f.session_id.value = opts.sessionId || '';
  const hint = $('#taskSessionHint');
  if (hint && opts.sessionId) { hint.textContent = tr('task.session-id.from-mr'); hint.hidden = false; hint.dataset.keep = '1'; }
  $('#taskModalTitle').textContent = opts.title || `Faire coder l'IA sur ${m.source_branch}`;
  $('#taskExistingImgs').textContent = tr('task.from-mr', { branch: m.source_branch, iid: m.iid });
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-play"/></svg>${tr('task.btn.create-run')}`;
  $('#taskSubmitOnly').hidden = false;
  showTaskModal();
  f.prompt.focus();
}

/* Depuis un ticket Jira : ouvre la modale de codage déjà remplie du contexte du ticket.
   Même mécanique que `openTaskForMr`, mais la source est le ticket : on récupère son
   contenu (summary + description convertie en Markdown) et on le met en tête du prompt,
   comme le fait le bouton « Récupérer » de la modale — un seul format de contexte à
   maintenir. La branche est proposée d'après la clé du ticket, jamais imposée. */
async function openTaskForJira(key) {
  const f = $('#taskForm');
  f.reset(); taskNewImages = []; renderTaskPreviews();
  editingTaskId = null; taskKind = 'code';
  launchAfterCreate = false; convergeAfterCreate = false;   // on prépare, l'utilisateur lance
  await loadRepoOptions();
  applyKindToModal('code');

  let issue = null;
  try { issue = await api('/jira/fetch', { method: 'POST', body: { key } }); }
  catch (e) { toast(explainError(e.message), true); }      // le ticket reste ouvrable sans contexte

  const slug = String((issue && issue.summary) || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')      // sans accents (noms de branche)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const branch = `feature/${key}${slug ? `-${slug}` : ''}`;
  renderTargetRows([{ branch }]);                           // dépôt à choisir : on ne peut pas le deviner
  setupTaskJira(branch);

  if (issue) {
    f.prompt.value = `${tr('task.jira.context-header', { key: issue.key })}\n\n${(issue.context || '').trim()}\n\n---\n\n`;
    if (f.commit_message) f.commit_message.value = `${key} ${issue.summary || ''}`.trim();
  }
  $('#taskModalTitle').textContent = tr('jira.code-modal-title', { key });
  $('#taskExistingImgs').textContent = issue ? tr('jira.code-from', { key: issue.key, summary: issue.summary || '' }) : '';
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-play"/></svg>${tr('task.btn.create-run')}`;
  $('#taskSubmitOnly').hidden = false;
  showTaskModal();
  f.prompt.focus();
  // Curseur après le bloc de contexte : on écrit SA demande, pas au milieu du ticket.
  const end = f.prompt.value.length;
  try { f.prompt.setSelectionRange(end, end); } catch { /* champ non focusable */ }
}

async function openTaskEdit(id) {
  const f = $('#taskForm');
  f.reset(); taskNewImages = []; renderTaskPreviews();
  try {
    const d = await api(`/tasks/${id}`);
    const t = d.task;
    editingTaskId = id; launchAfterCreate = false; convergeAfterCreate = false;
    taskKind = t.kind || 'code';
    await loadRepoOptions();
    applyKindToModal(taskKind);
    renderTargetRows((t.targets || []).map((x) => ({ repo_id: x.repo_id, branch: x.branch, base_branch: x.base_branch })));
    setupTaskJira((t.targets && t.targets[0] && t.targets[0].branch) || '');
    f.prompt.value = t.prompt || '';
    if (f.label) f.label.value = t.label || '';
    if (f.commit_message) f.commit_message.value = t.commit_message || '';
    if (f.auto_push) f.auto_push.checked = !!t.auto_push;
    if (f.ask_questions) f.ask_questions.checked = !!t.ask_questions;
    await majVerificateursSession(t.verifier_id || '');
    if (f.session_id) f.session_id.value = sharedSessionKey(t.targets);
    $('#taskModalTitle').textContent = tr(taskKind === 'code' ? 'task.edit.code-title' : 'task.edit.explore-title');
    $('#taskExistingImgs').textContent = (d.images && d.images.length) ? tr('task.images-attached', { n: d.images.length, count: d.images.length }) : '';
    $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
    $('#taskSubmitOnly').hidden = true;
    showTaskModal();
  } catch (e) { toast(explainError(e.message), true); }
}

/* Session commune à TOUTES les unités d'une session (projets ou dossiers), s'il y en a une.
   Sert à pré-remplir « reprendre une session existante » en édition : tant que les unités
   s'accordent, le champ montre la vérité. Dès qu'elles divergent — une seule a tourné, par
   exemple — on préfère le vide au mensonge d'afficher l'une des deux. */
function sharedSessionKey(units) {
  const keys = (units || []).map((u) => u.session_key || '');
  return keys.length && keys.every((k) => k && k === keys[0]) ? keys[0] : '';
}

/* Édition d'une session hors dépôt. Les dossiers sont stockés en CHEMINS ABSOLUS ; la
   modale, elle, se pilote en « répertoire local + nom de projet ». On refait donc le chemin
   inverse : le répertoire est déduit du premier dossier, les projets de leur nom de base.
   Une session créée depuis cette modale a forcément tous ses dossiers sous UN répertoire
   (changer de répertoire remet la sélection à zéro), donc le cas normal est couvert ; un
   dossier venu d'ailleurs est signalé à l'enregistrement plutôt que perdu en silence. */
async function openLocalTaskEdit(id) {
  const f = $('#taskForm');
  f.reset(); taskNewImages = []; renderTaskPreviews();
  const d = await api(`/local-tasks/${id}`);
  const t = d.task;
  editingTaskId = id; launchAfterCreate = false; convergeAfterCreate = false;
  taskKind = 'local';
  await loadLocalRoots();
  const paths = (t.dirs || []).map((x) => x.path);
  const under = (root, p) => p.startsWith(`${String(root.path).replace(/\/+$/, '')}/`);
  const root = localRoots.find((r) => paths.some((p) => under(r, p))) || localRoots[0];
  localRootId = root ? String(root.id) : '';
  localPicks = paths.map((p) => p.split('/').filter(Boolean).pop() || '');
  if (!localPicks.length) localPicks = [''];
  applyKindToModal('local');
  f.prompt.value = t.prompt || '';
  if (f.label) f.label.value = t.label || '';
  if (f.session_id) f.session_id.value = sharedSessionKey(t.dirs);
  $('#taskModalTitle').textContent = tr('local.edit-title');
  $('#taskExistingImgs').textContent = (d.images && d.images.length)
    ? tr('task.images-attached', { n: d.images.length, count: d.images.length }) : '';
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
  $('#taskSubmitOnly').hidden = true;   // on modifie une session existante : rien à créer
  showTaskModal();
  f.prompt.focus();
}

function closeTaskModal() {
  // Les deux drapeaux vont de pair : un « Converger » dont le POST a échoué détournerait
  // sinon le submit suivant (session non lancée, modale de convergence à la place).
  editingTaskId = null; launchAfterCreate = false; convergeAfterCreate = false;
  $('#taskModal').hidden = true;
  $('#taskSubmitOnly').hidden = true;
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
}

// Détecte une clé de ticket (PROJ-1234) dans un nom de branche — même logique que côté serveur.
function jiraKeyFromBranch(branch) {
  const m = /([A-Za-z]+-\d+)/.exec(branch || '');
  return m ? m[1].toUpperCase() : '';
}
// Prépare le bloc « enrichir depuis Jira » à l'ouverture de la modale : visible seulement
// si Jira est configuré, avec le numéro pré-rempli depuis la branche de travail.
function setupTaskJira(branch) {
  const row = $('#taskJiraRow');
  if (!row) return;
  row.hidden = !jiraConfigured;
  const st = $('#taskJiraStatus'); if (st) st.textContent = '';
  const key = $('#taskJiraKey'); if (key) key.value = jiraKeyFromBranch(branch);
}
$('#taskJiraFetch') && $('#taskJiraFetch').addEventListener('click', async () => {
  const btn = $('#taskJiraFetch');
  const key = ($('#taskJiraKey').value || '').trim();
  if (!key) { toast(tr('task.jira.key-required'), true); return; }
  try {
    const d = await busy(btn, () => api('/jira/fetch', { method: 'POST', body: { key } }));
    const header = tr('task.jira.context-header', { key: d.key });
    const block = `${header}\n\n${(d.context || '').trim()}\n\n---`;
    const f = $('#taskForm');
    f.prompt.value = block + (f.prompt.value.trim() ? `\n\n${f.prompt.value}` : '\n\n');
    $('#taskJiraStatus').textContent = tr('task.jira.added', { key: d.key });
    f.prompt.focus();
  } catch (e) { $('#taskJiraStatus').textContent = ''; toast(explainError(e.message), true); }
});
$('#btnNewTask').addEventListener('click', () => openTaskModal(taskKind).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true)));
/* Le champ « reprendre une session » : la mise en garde s'affiche dès qu'on saisit quelque
   chose. Elle vit sinon dans une info-bulle, qui ne s'ouvre pas toute seule — or c'est
   précisément au moment de coller un identifiant qu'il faut savoir qu'une session est liée à
   son répertoire. Le message pré-rempli depuis une MR (`keep`) a priorité : il est plus précis. */
$('#taskSessionId') && $('#taskSessionId').addEventListener('input', (e) => {
  const hint = $('#taskSessionHint');
  if (!hint || hint.dataset.keep === '1') return;
  hint.hidden = !e.target.value.trim();
  hint.textContent = hint.hidden ? '' : tr('task.session-id.scope');
});

$('#taskCancel').addEventListener('click', closeTaskModal);
$('#taskSubmitOnly').addEventListener('click', () => {
  launchAfterCreate = false; convergeAfterCreate = false; // on crée, on ne lance pas
  $('#taskForm').requestSubmit();            // passe par la validation native du formulaire
});
// « Converger » : créer la session PUIS ouvrir la modale de convergence (kind code uniquement).
$('#taskConverge') && $('#taskConverge').addEventListener('click', () => {
  convergeAfterCreate = true; launchAfterCreate = false;
  $('#taskForm').requestSubmit();
});
fermerAuFond('#taskModal', closeTaskModal);

$('#taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  // Codage hors dépôt : projets d'un répertoire local + images, endpoint dédié, créé
  // ET lancé. Le serveur continue de recevoir des CHEMINS absolus : c'est la saisie
  // qui a changé, pas le contrat — les sessions déjà enregistrées restent lisibles.
  if (taskKind === 'local') {
    const picks = [...new Set(localPicks.map((p) => String(p || '').trim()).filter(Boolean))];
    let dirs = [];
    try {
      const all = picks.length ? await localProjectsOf(localRootId) : [];
      dirs = picks.map((name) => (all.find((p) => p.name === name) || {}).path).filter(Boolean);
    } catch (err) { toast(explainError(err.message), true); return; }
    if (!dirs.length) { toast(tr('local.dirs-required'), true); return; }
    /* Un projet choisi qui ne se résout pas en chemin dans le répertoire courant serait
       silencieusement retiré de la session. À la création c'est déjà fâcheux ; à l'édition
       ce serait une perte de données. On refuse plutôt que d'enregistrer une liste amputée. */
    if (dirs.length !== picks.length) { toast(tr('local.dirs-unresolved'), true); return; }
    const btn = $('#taskSubmit');
    try {
      if (editingTaskId) {
        await busy(btn, () => api(`/local-tasks/${editingTaskId}`, { method: 'PUT', body: {
          label: f.label ? f.label.value : '',
          prompt: f.prompt.value, dirs, images: taskNewImages,
          session_id: f.session_id ? f.session_id.value : '',
        } }));
        toast(tr('toast.session-mise-a-jour'));
        taskNewImages = []; renderTaskPreviews(); closeTaskModal(); loadTasks();
        return;
      }
      const created = await busy(btn, () => api('/local-tasks', { method: 'POST', body: {
        label: f.label ? f.label.value : '',
        prompt: f.prompt.value, dirs, images: taskNewImages, session_id: f.session_id ? f.session_id.value : '',
      } }));
      if (launchAfterCreate) {
        await api(`/local-tasks/${created.id}/run`, { method: 'POST' });
        toast(tr('local.started')); refreshStatus();
      } else {
        // Créée en statut « new » : la carte affiche « Lancer », le geste reste à un clic.
        toast(tr('toast.local-session-created'));
      }
      taskNewImages = []; renderTaskPreviews(); closeTaskModal(); loadTasks();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const targets = readTargetRows();
  if (!targets.length) { toast(tr('toast.selectionne-au-moins-un-projet'), true); return; }
  const body = {
    kind: taskKind,
    label: f.label ? f.label.value : '',
    prompt: f.prompt.value,
    commit_message: f.commit_message ? f.commit_message.value : '',
    auto_push: f.auto_push ? f.auto_push.checked : false,
    ask_questions: f.ask_questions ? f.ask_questions.checked : false,
    verifier_id: f.verifier_id ? Number(f.verifier_id.value) || null : null,
    // Session existante à reprendre. Vide = nouvelle session, le cas courant. Le champ
    // n'est lu qu'à la CRÉATION : la modale d'édition ne réaffecte pas une session déjà
    // en cours, qui a son propre handle par projet.
    session_id: f.session_id ? f.session_id.value : '',
    images: taskNewImages,
    targets,
  };
  const btn = $('#taskSubmit');
  let convergeId = null;
  try {
    await busy(btn, async () => {
      if (editingTaskId) { await api(`/tasks/${editingTaskId}`, { method: 'PUT', body }); toast(tr('toast.session-mise-a-jour')); return; }
      const created = await api('/tasks', { method: 'POST', body });
      if (convergeAfterCreate) {
        convergeId = created.id; // on ne lance PAS le run : la modale de convergence pilote tout
      } else if (launchAfterCreate) {
        await api(`/tasks/${created.id}/run`, { method: 'POST' });
        toast(tr('toast.session-lancee')); refreshStatus();
      } else {
        toast(taskKind === 'code'
          ? tr('toast.code-session-created')
          : tr('toast.exploration-created'));
      }
    });
    taskNewImages = []; renderTaskPreviews();
    closeTaskModal();
    loadTasks();
    if (convergeId) { convergeAfterCreate = false; openConvergeModal({ type: 'task', id: convergeId }); }
  } catch (err) { toast(explainError(err.message), true); }
});

/* ---- Sous-onglets Codage / Exploration ---- */
$$('#tab-task .subnav [data-kind]').forEach((b) => b.addEventListener('click', () => {
  taskKind = b.dataset.kind;
  try { localStorage.setItem('aidevtools_task_kind', taskKind); } catch { /* ignore */ }
  // La recherche est remise à zéro en changeant de sous-onglet : les compteurs des onglets
  // affichent des TOTAUX, une liste filtrée à côté d'un « Codage 3 » se contredirait.
  const sq = $('#taskSearch');
  if (sq) sq.value = '';
  renderTasks();
}));

const TASK_STATUS = {
  new: { label: tr('task.status.new'), cls: 'to_review' },
  running: { label: tr('task.status.running'), cls: 'reviewed' },
  committed: { label: tr('task.status.committed'), cls: 'reviewed' },
  pushed: { label: tr('task.status.pushed'), cls: 'done' },
  done: { label: tr('task.status.done'), cls: 'done' },
  needs_input: { label: tr('task.status.needs-input'), cls: 'needs-input' },
  error: { label: tr('task.status.error'), cls: 'stale' },
};
const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(I18Nrt.currentLocale(), { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString(I18Nrt.currentLocale(), { hour: '2-digit', minute: '2-digit' });
};

/* Sauvegarde/restaure les formulaires inline ouverts avant un re-rendu. Une session qui tourne
   se re-rend toutes les secondes et demie : sans ça, un suivi qu'on est en train d'écrire
   disparaît sous les doigts. La liste hors dépôt y a droit autant que les autres — c'est
   justement pendant que ça tourne qu'on écrit un suivi. */
const CLES_FORM = ['mrform', 'followform', 'lfollowform'];
function captureTaskForms(racine = '#taskList') {
  const state = {};
  $$(`${racine} .mr-create`).forEach((f) => {
    const cle = CLES_FORM.find((k) => f.dataset[k]);
    if (!cle || f.hidden) return;
    const field = f.querySelector('textarea, input');
    const auto = f.querySelector('.followup-auto');
    state[`${cle}:${f.dataset[cle]}`] = { v: field ? field.value : '', auto: auto ? auto.checked : null };
  });
  return state;
}
function restoreTaskForms(state, racine = '#taskList') {
  for (const [key, value] of Object.entries(state)) {
    const i = key.indexOf(':');   // l'identifiant peut contenir un préfixe (« tg12 »)
    const f = $(`${racine} .mr-create[data-${key.slice(0, i)}="${key.slice(i + 1)}"]`);
    if (!f) continue;
    f.hidden = false;
    const field = f.querySelector('textarea, input');
    if (field) field.value = value.v;
    const auto = f.querySelector('.followup-auto');
    if (auto && value.auto !== null) auto.checked = value.auto;
  }
}

/* LE SUIVI EN ATTENTE. Écrit pendant que la session travaille, il reste affiché sur la carte
   tant qu'on ne l'a pas envoyé — sinon on oublie qu'on en a un. Le bouton d'envoi est là dès
   le premier instant, désactivé, pour qu'on sache où il sera. */
/* La case qui arme le suivi. Décochée par défaut, et sur la MÊME ligne que le texte : c'est au
   moment où on écrit la remarque qu'on sait si elle mérite de partir toute seule. */
const autoSuiviCase = (t) => `<label class="inline-check followup-auto-line"><input type="checkbox" class="followup-auto"${t.followup_auto ? ' checked' : ''} />
    <span>${tr('task.followup.auto')}</span></label>`;

function suiviBlock(t, pre) {
  if (!t.followup_draft) return '';
  const enCours = t.status === 'running';
  return `<div class="followup-draft${t.followup_auto ? ' is-auto' : ''}">
    <div class="followup-draft-head">${svgIco('repeat')}<span>${tr(t.followup_auto ? 'task.followup.draft-auto' : 'task.followup.draft')}</span>
      <span class="muted">${tr(t.followup_auto ? 'task.followup.draft-hint-auto' : 'task.followup.draft-hint')}</span></div>
    <div class="followup-draft-text">${esc(t.followup_draft)}</div>
    <div class="followup-draft-actions">
      <button class="btn btn-sm" data-${pre}followedit="${t.id}">${tr('ui.edit')}</button>
      <button class="btn btn-sm btn-danger" data-${pre}followdrop="${t.id}">${tr('ui.delete')}</button>
      <button class="btn btn-sm btn-primary" data-${pre}followsend="${t.id}"${enCours ? ' disabled' : ''} title="${esc(tr(enCours ? 'task.title.send-followup-wait' : 'task.title.send-followup'))}">${tr('task.btn.send-followup')}</button>
    </div>
  </div>`;
}

/* Enregistrer, corriger, supprimer, envoyer : les quatre gestes du suivi, identiques pour une
   session de dépôt et pour une session hors dépôt — seule la route change. */
async function enregistrerSuivi(b, route) {
  const form = b.closest('.followup');
  const field = form.querySelector('.followup-text');
  const instruction = field.value.trim();
  if (!instruction) { supprimerSuivi(b, route); return; }   // effacer le texte, c'est supprimer
  const caseAuto = form.querySelector('.followup-auto');
  try {
    await busy(b, () => api(route, { method: 'PUT', body: { instruction, auto: !!(caseAuto && caseAuto.checked) } }));
    /* On referme AVANT de recharger : ouvert, `captureTaskForms` le rouvrirait au rendu
       suivant et on croirait que l'enregistrement n'a rien fait. */
    form.hidden = true;
    toast(tr('toast.suivi-enregistre'));
    loadTasks();
  } catch (e) { toast(explainError(e.message), true); }
}
async function supprimerSuivi(b, route) {
  try {
    await busy(b, () => api(route, { method: 'PUT', body: { instruction: '' } }));
    const form = b.closest('.followup');
    if (form) form.hidden = true;
    toast(tr('toast.suivi-supprime'));
    loadTasks();
  } catch (e) { toast(explainError(e.message), true); }
}
// Corps vide EXPRÈS : c'est le serveur qui reprend le suivi enregistré et l'efface, en un geste.
async function envoyerSuivi(b, route) {
  try {
    await busy(b, () => api(route, { method: 'POST', body: {} }));
    toast(tr('toast.lance'));
    refreshStatus(); loadTasks();
  } catch (e) { toast(explainError(e.message), true); }
}

/* RELANCER N'EST PAS CONTINUER. Une relance renvoie le PROMPT INITIAL : tout ce qu'on a demandé
   depuis — les suivis, les réponses aux questions — n'est pas rejoué, et l'agent repart du début
   sur du travail déjà fait. Le bouton voisine avec ceux qu'on utilise vraiment souvent, et le clic
   de trop coûte une session d'IA entière. On ne demande donc rien tant que rien n'a tourné : la
   toute première mise en route reste un seul clic. */
async function confirmerRelance(dejaLance, cle = 'confirm.rerun') {
  if (!dejaLance) return true;
  return confirmDialog({ title: tr('confirm.rerun.title'), text: tr(cle), confirmLabel: tr('task.btn.rerun') });
}

// Le bouton qui ouvre le formulaire de suivi : « préparer » tant que ça tourne, « corriger » après.
const followBtn = (t, attr, titreFini, libelleFini = 'task.btn.request-fix') => {
  const enCours = t.status === 'running';
  return `<button class="btn" data-${attr}="${t.id}" title="${esc(tr(enCours ? 'task.title.draft-followup' : titreFini))}"><svg class="ico"><use href="#i-repeat"/></svg>${tr(enCours ? 'task.btn.draft-followup' : libelleFini)}</button>`;
};

async function loadTasks() {
  try {
    const [tasks, locals] = await Promise.all([api('/tasks'), api('/local-tasks').catch(() => [])]);
    allTasks = tasks; localTasks = locals;
  } catch (e) { $('#taskList').innerHTML = errorBox(e.message); return; }
  listeChargee = true;
  renderTasks();
  loadLots();
}

// Texte de recherche courant (sessions de codage, hors dépôt et exploration partagent
// le même champ : une seule liste est visible à la fois).
function taskQuery() {
  const el = $('#taskSearch');
  return (el && el.value ? el.value : '').toLowerCase().trim();
}
// Une session correspond si le texte apparaît dans son prompt, son message de commit,
// ou dans l'un de ses projets/branches (ou dossiers, hors dépôt).
function taskMatches(t, q, units) {
  if (!q) return true;
  const hay = [t.label, t.prompt, t.commit_message, ...(units || [])].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

// Une session rangée ne sort que si la case le demande.
const taskVisible = (t) => showHiddenTasks || !t.hidden;

/* Combien de sessions le rangement retire de la vue. Affiché à côté de la case : une
   session qui disparaît sans laisser de trace se croit supprimée, et on la recrée. */
function reportHiddenCount(n) {
  const el = $('#taskHiddenCount');
  if (!el) return;
  el.textContent = n ? tr('task.hidden.count', { n, count: n }) : '';
}

function renderTasks() {
  const isLocal = taskKind === 'local';
  const el = $('#taskList');
  const openForms = isLocal ? {} : captureTaskForms();
  $$('#tab-task .subnav [data-kind]').forEach((b) => b.classList.toggle('active', b.dataset.kind === taskKind));
  // La barre d'outils (bouton « Nouvelle session ») reste visible pour tous les kinds —
  // en local elle ouvre la MÊME modale que le codage. Seule la liste change.
  el.hidden = isLocal;
  $('#localPanel').hidden = !isLocal;
  // Un lot regroupe des merge requests : il n'a rien à faire sous le codage hors dépôt
  // ni sous l'exploration, qui ne produisent pas de MR.
  $('#lotPanel').hidden = taskKind !== 'code';
  $('#btnNewTaskLabel').textContent = KIND_LABEL[taskKind].btn;
  $('#taskKindHint').textContent = KIND_LABEL[taskKind].hint;

  const counts = { code: 0, explore: 0 };
  allTasks.forEach((t) => { counts[t.kind === 'explore' ? 'explore' : 'code'] += 1; });
  $('#kindCountCode').textContent = counts.code;
  $('#kindCountExplore').textContent = counts.explore;
  $('#kindCountLocal').textContent = localTasks.length;
  // Le badge du menu signale le TRAVAIL EN ATTENTE (sessions jamais lancées, tous types),
  // comme celui de « Reviews » qui compte les MR à traiter — pas un total.
  const nav = $('#navCountTask');
  if (nav) {
    const pending = allTasks.filter((t) => t.status === 'new').length + localTasks.filter((t) => t.status === 'new').length;
    nav.textContent = pending;
    nav.hidden = !pending;
    nav.title = tr('task.nav.pending', { n: pending, count: pending });
  }

  if (isLocal) { renderLocalTasks(); return; }

  const q = taskQuery();
  const all = allTasks.filter((t) => (t.kind === 'explore' ? 'explore' : 'code') === taskKind);
  const visible = all.filter(taskVisible);
  reportHiddenCount(all.length - visible.length);
  const rows = visible.filter((t) => taskMatches(t, q, (t.targets || []).flatMap((x) => [x.project, x.branch])));
  if (!rows.length && q) {
    el.innerHTML = `<p class="muted">${tr('task.search.no-match', { q: esc(q) })}</p>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = taskKind === 'code'
      ? emptyState({ icon: 'bot', title: tr('task.empty.code.title'),
        text: tr('task.empty.code.text'),
        actions: [{ act: 'new-task', label: tr('task.kind.code.btn'), primary: true }] })
      : emptyState({ icon: 'search', title: tr('task.empty.explore.title'),
        text: tr('task.empty.explore.text'),
        actions: [{ act: 'new-task', label: tr('task.kind.explore.btn'), primary: true }] });
    return;
  }

  el.innerHTML = rows.map((t) => (t.kind === 'explore' ? exploreCard(t) : codeCard(t))).join('');
  stagger('#taskList .card');
  wirePromptToggles('#taskList');
  wireTaskActions();
  restoreTaskForms(openForms);
}

/* ---------- Codage hors dépôt (projets d'un répertoire local, sans git) ----------
   Le dossier de travail n'est plus SAISI mais CHOISI : un répertoire local, puis un
   projet parmi les siens. Le chemin absolu en découle — un chemin tapé à la main est
   une faute de frappe silencieuse, découverte au milieu du traitement. */
function renderLocalRootPicker() {
  const box = $('#localRootBox');
  if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<span class="muted">${esc(tr('local.no-root'))}</span>`; return; }
  const cur = localRoots.find((r) => String(r.id) === String(localRootId)) || localRoots[0];
  localRootId = String(cur.id);
  box.innerHTML = comboHtml('local-root', { value: cur.id, label: rootLabel(cur), ph: tr('git.navigate.ph.root') });
  wireCombo(box, 'local-root', () => localRoots.map((r) => ({ value: r.id, label: rootLabel(r) })));
  $('.local-root', box).addEventListener('change', (e) => {
    // Les projets sélectionnés appartenaient à l'autre répertoire : on repart à vide.
    localRootId = e.target.value; localPicks = [''];
    renderLocalDirRows();
  });
}

// Éditeur de projets de la modale (lignes ajoutables). Re-rendu à chaque ajout/retrait.
function renderLocalDirRows() {
  const box = $('#taskLocalDirRows');
  if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<p class="muted">${esc(tr('local.no-root'))}</p>`; return; }
  box.innerHTML = localPicks.map((name, i) => `<div class="local-dir-row" data-row="${i}">`
    + comboHtml('local-project', { value: name, label: name, ph: tr('local.dir-ph'), wrapClass: 'local-dir' })
    + `<button type="button" class="btn btn-icon btn-sm btn-danger" data-rmdir="${i}" title="${esc(tr('local.remove-dir'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></div>`).join('');
  // Ici on propose TOUS les sous-dossiers, git ou non : l'IA code en place, un dossier
  // sans dépôt est un cas d'usage normal de cet écran. La branche n'est qu'un repère.
  wireCombo(box, 'local-project', async () => (await localProjectsOf(localRootId))
    .map((p) => ({ value: p.name, label: p.name, hint: p.git && p.branch ? `· ${p.branch}` : '' })));
  $$('.local-project', box).forEach((h) => h.addEventListener('change', () => {
    localPicks[Number(h.closest('[data-row]').dataset.row)] = h.value;
  }));
  $$('[data-rmdir]', box).forEach((b) => b.addEventListener('click', () => {
    localPicks.splice(Number(b.dataset.rmdir), 1);
    if (!localPicks.length) localPicks = [''];
    renderLocalDirRows();
  }));
}
$('#taskLocalAddDir') && $('#taskLocalAddDir').addEventListener('click', () => {
  localPicks.push(''); renderLocalDirRows();
});

function localDirLine(d) {
  const st = TASK_STATUS[d.status] || { label: d.status, cls: '' };
  return `<div class="target-line"><span class="tag ${st.cls}">${st.label}</span>`
    + `<code class="local-dir-path">${esc(d.path)}</code>`
    + `${d.last_error ? `<span class="muted" title="${esc(d.last_error)}">${svgIco('alert')}</span>` : ''}`
    + `<span class="spacer"></span>`
    // Retour de l'agent : la seule fenêtre sur son travail quand le dossier n'a pas bougé.
    + `${d.output_path ? `<button class="btn btn-sm" data-ldout="${d.id}" data-ltask="${d.task_id}" title="${esc(tr('task.title.view-output'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${tr('task.btn.view-output')}</button>` : ''}`
    + `${resumeCmdBtn(d.resume_cmd)}</div>`;
}

function localCard(t) {
  const st = TASK_STATUS[t.status] || { label: t.status, cls: '' };
  const canRun = ['new', 'error', 'done'].includes(t.status);
  // Une correction n'a de sens que sur un dossier DÉJÀ traité : sinon il n'y a rien à corriger.
  /* … ou sur une session QUI TOURNE : là on ne corrige pas, on prépare. La remarque se voit
     pendant le travail, pas vingt minutes après. */
  const enCours = t.status === 'running';
  const canFollow = enCours || (canRun && (t.dirs || []).some((d) => d.status === 'done'));
  const n = (t.dirs || []).length;
  return `<div class="card task-row${t.hidden ? ' is-hidden' : ''}" data-local="${t.id}">
    <div style="min-width:0;flex:1">
      <div class="title">
        <span class="tag ${st.cls}">${st.label}</span>
        <span class="task-projects">${tr('local.dirs-count', { n, count: n })}</span>
        <span class="task-date" title="${tr('task.created-at')}">${fmtDateTime(t.created_at)}</span>
      </div>
      ${libelleBlock(t)}
      ${promptBlock(t.prompt)}
      ${toggleProjetsHtml('local', t.id, n)}
      <div class="targets"${projetsVisibles('local', t.id, n) ? '' : ' hidden'}>${(t.dirs || []).map(localDirLine).join('')}</div>
      ${suiviBlock(t, 'l')}
      <div class="mr-create followup" data-lfollowform="${t.id}" hidden>
        <textarea class="followup-text" placeholder="${esc(tr('local.followup.ph'))}">${esc(t.followup_draft || '')}</textarea>
        ${autoSuiviCase(t)}
        <button class="btn" data-lfollowcancel="${t.id}">${tr('ui.cancel')}</button>
        <button class="btn" data-lfollowsave="${t.id}">${tr('task.btn.save-followup')}</button>
        ${enCours ? '' : `<button class="btn btn-primary" data-lfollowsubmit="${t.id}">${tr('task.btn.run-iteration')}</button>`}
      </div>
    </div>
    ${taskActions([
    canRun ? `<button class="btn" data-lrun="${t.id}" title="${esc(tr('local.run-title'))}"><svg class="ico"><use href="#i-play"/></svg>${t.status === 'new' ? tr('local.run-short') : tr('task.btn.rerun')}</button>` : '',
    /* Le retour de l'agent au niveau de la SESSION : les boutons par dossier existent aussi,
       mais ils vivent dans la liste repliée — et c'est « qu'a fait l'IA ? » qu'on se demande
       en regardant la carte, pas « qu'a-t-elle fait dans ce dossier-là ». */
    (t.dirs || []).some((d) => d.output_path)
      ? `<button class="btn" data-lout="${t.id}" title="${esc(tr('task.title.view-output'))}"><svg class="ico"><use href="#i-doc"/></svg>${tr('task.btn.view-output')}</button>` : '',
    canFollow ? followBtn(t, 'lfollow', 'local.followup.title') : '',
  ], [
    `<button class="btn btn-icon btn-sm" data-ledit="${t.id}" title="${esc(tr('local.edit-title'))}"><svg class="ico"><use href="#i-edit"/></svg></button>`,
    hideBtn('local', t),
    `<button class="btn btn-icon btn-sm btn-danger" data-ldel="${t.id}" title="${esc(tr('local.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button>`,
  ])}
    ${t.last_error ? errorBox(t.last_error) : ''}
  </div>`;
}

function renderLocalTasks() {
  const el = $('#localList');
  const ouverts = captureTaskForms('#localList');
  const q = taskQuery();
  const visible = localTasks.filter(taskVisible);
  reportHiddenCount(localTasks.length - visible.length);
  const shown = visible.filter((t) => taskMatches(t, q, (t.dirs || []).map((d) => d.path)));
  if (!shown.length && q) {
    el.innerHTML = `<p class="muted">${tr('task.search.no-match', { q: esc(q) })}</p>`;
    return;
  }
  if (!localTasks.length) {
    el.innerHTML = emptyState({ icon: 'bot', title: tr('local.empty.title'), text: tr('local.empty.text'),
      actions: [{ act: 'new-task', label: tr('task.kind.local.btn'), primary: true }] });
    return;
  }
  el.innerHTML = shown.map(localCard).join('');
  restoreTaskForms(ouverts, '#localList');
  stagger('#localList .card');
  wirePromptToggles('#localList');
  /* Le codage hors dépôt a sa propre liste : `wireTaskActions` ne porte que sur `#taskList`,
     le repli doit donc être câblé ici aussi. */
  $$('#localList [data-tfold]').forEach((b) => b.addEventListener('click', () => basculerProjets(b.dataset.tfold)));
  $$('#localList [data-lrun]').forEach((b) => b.addEventListener('click', async () => {
    const t2 = localTasks.find((x) => String(x.id) === b.dataset.lrun);
    if (!await confirmerRelance(t2 && t2.status !== 'new')) return;
    busy(b, () => api(`/local-tasks/${b.dataset.lrun}/run`, { method: 'POST' }))
      .then(() => { toast(tr('local.started')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  }));
  $$('#localList [data-ldout]').forEach((b) => b.addEventListener('click',
    () => openLocalDirOutput(b.dataset.ltask, b.dataset.ldout)));
  // Depuis la carte : on ouvre le premier dossier ayant un retour, les autres sont au sélecteur.
  $$('#localList [data-lout]').forEach((b) => b.addEventListener('click', () => {
    const t = localTasks.find((x) => String(x.id) === b.dataset.lout);
    const premier = ((t && t.dirs) || []).find((d) => d.output_path);
    if (premier) openLocalDirOutput(b.dataset.lout, premier.id);
  }));
  // Itération sur la MÊME session : le formulaire se déplie sous les dossiers.
  $$('#localList [data-lfollow]').forEach((b) => b.addEventListener('click', () => {
    const form = $(`#localList .followup[data-lfollowform="${b.dataset.lfollow}"]`);
    if (form) { form.hidden = false; form.querySelector('.followup-text').focus(); }
  }));
  $$('#localList [data-lfollowcancel]').forEach((b) => b.addEventListener('click', () => {
    const form = $(`#localList .followup[data-lfollowform="${b.dataset.lfollowcancel}"]`);
    if (form) form.hidden = true;
  }));
  $$('#localList [data-lfollowsubmit]').forEach((b) => b.addEventListener('click', async () => {
    const form = b.closest('.followup');
    const field = form.querySelector('.followup-text');
    const instruction = field.value.trim();
    if (!instruction) return;
    try {
      await busy(b, () => api(`/local-tasks/${b.dataset.lfollowsubmit}/followup`, { method: 'POST', body: { instruction } }));
      field.value = '';
      form.hidden = true;
      toast(tr('local.started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  // Suivi préparé pendant que la session tourne : enregistré ici, envoyé plus tard, par nous.
  $$('#localList [data-lfollowsave]').forEach((b) => b.addEventListener('click',
    () => enregistrerSuivi(b, `/local-tasks/${b.dataset.lfollowsave}/followup-draft`)));
  $$('#localList [data-lfollowedit]').forEach((b) => b.addEventListener('click', () => {
    const form = $(`#localList .followup[data-lfollowform="${b.dataset.lfollowedit}"]`);
    if (form) { form.hidden = false; form.querySelector('.followup-text').focus(); }
  }));
  $$('#localList [data-lfollowdrop]').forEach((b) => b.addEventListener('click',
    () => supprimerSuivi(b, `/local-tasks/${b.dataset.lfollowdrop}/followup-draft`)));
  $$('#localList [data-lfollowsend]').forEach((b) => b.addEventListener('click',
    () => envoyerSuivi(b, `/local-tasks/${b.dataset.lfollowsend}/followup`)));
  $$('#localList [data-ledit]').forEach((b) => b.addEventListener('click',
    () => openLocalTaskEdit(Number(b.dataset.ledit)).catch((e) => toast(explainError(e.message), true))));
  $$('#localList [data-ldel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('local.confirm-delete'), confirmLabel: tr('ui.delete') })) return;
    try { await api(`/local-tasks/${b.dataset.ldel}`, { method: 'DELETE' }); toast(tr('local.deleted')); loadTasks(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
}


/* Colonne d'actions d'une carte Dev IA, en deux familles : ce qu'on fait avec le TRAVAIL
   (lancer, converger, demander une correction) au-dessus, ce qu'on fait avec la FICHE
   (modifier, supprimer) en dessous. Mélangées dans une seule pile, la suppression se
   retrouvait tantôt sous « Converger », tantôt sous « Lancer » selon le sous-onglet.
   L'ordre des emplacements est le même partout ; ceux qui ne s'appliquent pas sont omis. */
/* Prompt d'une session dans la liste. Il était coupé à 220 caractères, ce qui suffit à perdre
   l'essentiel d'une consigne un peu longue — et rien ne permettait de lire la suite sans
   ouvrir la session. Le texte COMPLET est désormais dans le DOM, replié sur trois lignes par
   CSS ; « Voir plus » le déplie sur place. Le bouton n'est révélé qu'après mesure (voir
   wirePromptToggles) : un prompt de deux lignes n'a rien à déplier. */
function promptBlock(prompt) {
  const txt = String(prompt || '');
  if (!txt.trim()) return '';
  return `<div class="task-prompt-wrap">
      <div class="task-prompt clamped">${esc(txt)}</div>
      <button type="button" class="prompt-more" hidden>${tr('task.prompt.more')}</button>
    </div>`;
}

/* Révèle « Voir plus » sur les seuls prompts réellement tronqués. Toutes les LECTURES de
   mise en page d'abord, toutes les ÉCRITURES ensuite : intercalées, elles forceraient un
   recalcul par carte. */
function wirePromptToggles(root) {
  const wraps = $$(`${root} .task-prompt-wrap`);
  const overflowing = wraps.filter((w) => {
    const p = w.querySelector('.task-prompt');
    return p.scrollHeight > p.clientHeight + 2;
  });
  for (const w of overflowing) w.querySelector('.prompt-more').hidden = false;
  for (const w of wraps) {
    const btn = w.querySelector('.prompt-more');
    btn.addEventListener('click', () => {
      const p = w.querySelector('.task-prompt');
      const open = p.classList.toggle('clamped');   // `clamped` présent = replié
      btn.textContent = open ? tr('task.prompt.more') : tr('task.prompt.less');
    });
  }
}

/* Bouton « ranger / ressortir » : il vit avec les actions sur la FICHE, pas sur le travail.
   `scope` distingue la session sur dépôt du codage hors dépôt — deux tables, deux routes. */
function hideBtn(scope, t) {
  const on = t.hidden ? 1 : 0;
  return `<button class="btn btn-icon btn-sm" data-hide="${t.id}" data-scope="${scope}" data-on="${on}"`
    + ` title="${esc(tr(on ? 'task.hidden.unhide-title' : 'task.hidden.hide-title'))}">`
    + `<svg class="ico"><use href="#i-${on ? 'eye' : 'eye-off'}"/></svg></button>`;
}

function taskActions(work, meta) {
  const w = work.filter(Boolean).join('');
  const m = meta.filter(Boolean).join('');
  return `<div class="task-actions">${w ? `<div class="ta-work">${w}</div>` : ''}${m ? `<div class="ta-meta">${m}</div>` : ''}</div>`;
}

// En-tête commun : statut, date de création, prompt.
/* Le libellé passe AVANT le prompt et le domine visuellement : c'est lui qu'on parcourt des
   yeux. Le prompt reste dessous — il dit ce qu'il faut faire, le libellé dit de quoi il s'agit. */
const libelleBlock = (t) => (t.label ? `<div class="task-label">${esc(t.label)}</div>` : '');

function taskHead(t) {
  const st = TASK_STATUS[t.status] || { label: t.status, cls: '' };
  const nb = (t.targets || []).length;
  return `<div class="title">
      <span class="tag ${st.cls}">${st.label}</span>
      <span class="task-projects">${tr('task.projects', { n: nb, count: nb })}</span>
      ${t.auto_push && t.kind !== 'explore' ? '<span class="tag">auto-push</span>' : ''}
      <span class="task-date" title="${tr('task.created-at')}">${fmtDateTime(t.created_at)}</span>
    </div>
    ${libelleBlock(t)}
    ${promptBlock(t.prompt)}`;
}

/* Repli de la liste de projets, PARTAGÉ par les trois familles de sessions (codage,
   exploration, codage hors dépôt).
 *
 * On mémorise les sessions DÉPLIÉES, pas les repliées : le repli est l'état par défaut, et
 * au-delà de quelques dépôts une seule session occupe sinon tout l'écran — on ne voit plus
 * les autres, qui sont pourtant ce qu'on est venu regarder.
 *
 * La clé est PRÉFIXÉE par la famille : `task` et `local_task` sont deux tables, un « 3 » de
 * chacune se confondrait. (L'ancien stockage ne contenait que des identifiants de codage,
 * sans préfixe et avec la convention inverse : il n'est pas repris, le repli se refait d'un
 * clic.)
 *
 * En stockage local, parce que le rendu se refait à chaque rafraîchissement : un état vivant
 * seulement dans le DOM serait perdu toutes les secondes et demie pendant un job. */
const projetsDeplies = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('aidevtools_projets_deplies') || '[]').map(String)); }
  catch { return new Set(); }
})();
const cleRepli = (famille, id) => `${famille}:${id}`;
const estDeplie = (famille, id) => projetsDeplies.has(cleRepli(famille, id));

function basculerProjets(cle) {
  if (projetsDeplies.has(cle)) projetsDeplies.delete(cle); else projetsDeplies.add(cle);
  try { localStorage.setItem('aidevtools_projets_deplies', JSON.stringify([...projetsDeplies])); }
  catch { /* stockage indisponible : le repli reste valable pour cette page */ }
  renderTasks();
}

/* Le bouton de repli. Rien du tout en dessous de deux projets : il n'y aurait rien à replier,
   et une ligne d'interface qui ne sert jamais est une ligne de trop. */
function toggleProjetsHtml(famille, id, n) {
  if (n <= 1) return '';
  const deplie = estDeplie(famille, id);
  // Le codage hors dépôt manipule des DOSSIERS, pas des projets : le libellé le dit.
  const cle = famille === 'local' ? 'local.toggle' : 'task.toggle';
  return `<button class="targets-toggle" data-tfold="${cleRepli(famille, id)}" aria-expanded="${deplie}">
    <svg class="ico ico-sm"><use href="#i-right"/></svg>
    ${deplie ? tr(`${cle}.collapse`) : tr(`${cle}.expand`, { n, count: n })}
  </button>`;
}

// Les projets sont-ils visibles ? Dépliés explicitement, ou seuls (rien à replier).
const projetsVisibles = (famille, id, n) => n <= 1 || estDeplie(famille, id);

// Carte CODAGE : une ligne par projet, avec ses propres actions.
function codeCard(t) {
  const cibles = t.targets || [];
  const enCours = t.status === 'running';
  const canFollow = enCours || cibles.some((x) => ['committed', 'pushed'].includes(x.status));
  const canRun = ['new', 'error', 'committed', 'pushed'].includes(t.status);
  /* Repli de la liste de projets. Au-delà de quelques dépôts, une session occupe tout l'écran et
     on ne voit plus les autres. L'état est PERSISTÉ : sans ça, il se rouvrirait à chaque
     rafraîchissement automatique, c'est-à-dire toutes les secondes et demie pendant un job. */
  const ouvert = projetsVisibles('code', t.id, cibles.length);
  const aPousser = cibles.filter((x) => x.status === 'committed').length;
  const aOuvrir = cibles.filter((x) => x.status === 'pushed' && !(x.mr_iid || x.existing_mr_iid)).length;
  return `<div class="card task-row${t.hidden ? ' is-hidden' : ''}" data-task="${t.id}">
    <div style="min-width:0;flex:1">
      ${taskHead(t)}
      ${toggleProjetsHtml('code', t.id, cibles.length)}
      <div class="targets"${ouvert ? '' : ' hidden'}>
        ${cibles.map((tg) => targetLine(t, tg)).join('')}
      </div>
      ${suiviBlock(t, '')}
      <div class="mr-create followup" data-followform="${t.id}" hidden>
        <textarea class="followup-text" placeholder="${esc(tr('task.followup.ph'))}">${esc(t.followup_draft || '')}</textarea>
        ${autoSuiviCase(t)}
        <button class="btn" data-followcancel="${t.id}">${tr('ui.cancel')}</button>
        <button class="btn" data-followsave="${t.id}">${tr('task.btn.save-followup')}</button>
        ${enCours ? '' : `<button class="btn btn-primary" data-followsubmit="${t.id}">${tr('task.btn.run-iteration')}</button>`}
      </div>
    </div>
    ${taskActions([
    canRun ? `<button class="btn" data-trun="${t.id}" title="${t.status === 'new' ? tr('task.title.run-all') : tr('task.title.rerun-all')}"><svg class="ico"><use href="#i-play"/></svg>${t.status === 'new' ? tr('local.run-short') : tr('task.btn.rerun')}</button>` : '',
    canRun ? `<button class="btn btn-converge" data-tconverge="${t.id}" data-label="${esc(tr('task.projects', { n: (t.targets || []).length, count: (t.targets || []).length }))}" title="${tr('task.title.converge')}"><svg class="ico"><use href="#i-zap"/></svg>${tr('report.btn.converge')}</button>` : '',
    canFollow ? followBtn(t, 'tfollow', 'task.title.request-fix') : '',
    /* N'apparaît que s'il y a quelque chose à réparer : un projet en erreur dont le travail
       peut très bien être déjà commité. Relancer coûterait un appel IA par dépôt pour refaire
       du travail fait — ce bouton ne fait que relire les branches. */
    aPousser > 1 ? `<button class="btn btn-primary" data-tpushall="${t.id}" title="${esc(tr('task.title.push-all'))}"><svg class="ico"><use href="#i-upload"/></svg>${tr('task.btn.push-all', { n: aPousser, count: aPousser })}</button>` : '',
    aOuvrir > 1 ? `<button class="btn btn-primary" data-tmrall="${t.id}" title="${esc(tr('task.title.mr-all'))}"><svg class="ico"><use href="#i-branch"/></svg>${tr('task.btn.mr-all', { n: aOuvrir, count: aOuvrir })}</button>` : '',
    (t.targets || []).filter((tg) => tg.status === 'error').length > 1
      ? `<button class="btn" data-trunfailed="${t.id}" title="${esc(tr('task.title.rerun-failed'))}"><svg class="ico"><use href="#i-repeat"/></svg>${tr('task.btn.rerun-failed')}</button>` : '',
    (t.targets || []).some((tg) => tg.status === 'error')
      ? `<button class="btn" data-treconcile="${t.id}" title="${esc(tr('task.title.reconcile'))}"><svg class="ico"><use href="#i-branch"/></svg>${tr('task.btn.reconcile')}</button>` : '',
  ], [
    `<button class="btn btn-icon btn-sm" data-tedit="${t.id}" title="${tr('task.title.edit')}"><svg class="ico"><use href="#i-edit"/></svg></button>`,
    hideBtn('task', t),
    `<button class="btn btn-icon btn-sm btn-danger" data-tdel="${t.id}" title="${tr('task.title.delete')}"><svg class="ico"><use href="#i-close"/></svg></button>`,
  ])}
    ${t.last_error ? errorBox(t.last_error, null, t.id) : ''}
  </div>`;
}

// Ligne d'UN projet dans une session de codage : état + actions propres.
// Fil d'étape compact (pips) du parcours d'un projet : créée → commit → push → MR.
// Dérivé de l'état du projet (tg.status) et de l'existence d'une MR — un coup d'œil suffit
// à situer où en est chaque projet d'une session multi-projets, sans lire le libellé.
function targetStepper(tg) {
  const mrIid = tg.mr_iid || tg.existing_mr_iid;
  let done = 1; // « créée » : le projet existe dans la session
  if (['committed', 'pushed'].includes(tg.status) || mrIid) done = 2; // commit
  if (tg.status === 'pushed' || mrIid) done = 3;                       // push
  if (mrIid) done = 4;                                                 // MR
  const labels = [tr('task.step.created'), tr('task.step.commit'), tr('task.step.push'), tr('task.step.mr')];
  const merged = !!tg.mr_merged;
  const pips = labels.map((lb, i) => {
    const cls = i < done ? 'done' : (i === done ? 'current' : '');
    return `<span class="tstep-pip ${cls}" title="${esc(lb)}"></span>`;
  }).join('');
  return `<span class="tstepper${merged ? ' merged' : ''}" aria-label="${esc(labels.slice(0, done).join(' → '))}">${pips}</span>`;
}
function targetLine(t, tg) {
  const st = TASK_STATUS[tg.status] || { label: tg.status, cls: '' };
  const showDiff = !!tg.diff_path && ['committed', 'pushed'].includes(tg.status);
  const showPush = tg.status === 'committed';
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
    <code>${esc(tg.branch || '')}</code>
    ${/* La session demandée n'a pas pu être reprise : on le dit ICI, pas seulement dans un
          journal qui défile — sinon l'écran affiche un identifiant que personne n'a saisi. */''}
    ${tg.session_note ? `<span class="t-note" title="${esc(tr('task.session.fallback-title', { detail: tg.session_note }))}">${svgIco('alert')} ${esc(tr('task.session.fallback'))}</span>` : ''}
    ${mrIid ? (mrUrl ? ` <a href="${esc(mrUrl)}" target="_blank">MR !${mrIid} ↗</a>` : ` <span class="muted">MR !${mrIid}</span>`) : ''}
    ${tg.mr_merged ? `<span class="tag merged" title="${tr('task.tag.merged-title', { forge: forgeLabel(tg.forge) })}">${tr('task.tag.merged')}</span>` : ''}
    <span class="spacer"></span>
    ${resumeCmdBtn(tg.resume_cmd)}
    ${tg.output_path ? `<button class="btn btn-sm" data-tgout="${tg.id}" data-task="${t.id}" title="${esc(tr('task.title.view-output'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${tr('task.btn.view-output')}</button>` : ''}
    ${showDiff ? `<button class="btn btn-sm" data-tgdiff="${tg.id}" data-task="${t.id}" title="${esc(tr('task.title.view-diff'))}"><svg class="ico ico-sm"><use href="#i-eye"/></svg>${tr('mr.btn.diff')}</button>` : ''}
    ${runTarget ? `<button class="btn btn-sm" data-tgrun="${tg.id}" data-task="${t.id}" title="${esc(tg.status === 'new' ? tr('task.title.run-target') : tr('task.title.rerun-target'))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${tr('task.btn.run-target')}</button>` : ''}
    ${followTarget ? `<button class="btn btn-sm" data-tgfollow="${tg.id}" data-task="${t.id}" title="${esc(tr('task.title.request-fix-target', { project: tg.project }))}"><svg class="ico ico-sm"><use href="#i-repeat"/></svg>${tr('task.btn.request-fix')}</button>` : ''}
    ${showPush ? `<button class="btn btn-sm btn-primary" data-tgpush="${tg.id}" data-task="${t.id}" data-project="${esc(tg.project)}" data-branch="${esc(tg.branch || '')}" title="${tr('task.btn.push-title')}"><svg class="ico ico-sm"><use href="#i-upload"/></svg>${tr('task.btn.push')}</button>` : ''}
    ${canMr ? `<button class="btn btn-sm btn-primary" data-tgmr="${tg.id}" data-task="${t.id}" data-title="${esc(defaultMrTitle)}" data-branch="${esc(tg.branch || '')}" data-target="${esc(tg.base_branch || '')}" data-forge="${esc(tg.forge || '')}" title="${esc(tr('task.title.open-mr'))}"><svg class="ico ico-sm"><use href="#i-branch"/></svg>${tr('task.btn.create-mr')}</button>` : ''}
    ${mrIid && !tg.mr_merged ? `<button class="btn btn-sm btn-danger" data-tgmerge="${tg.id}" data-task="${t.id}" data-iid="${mrIid}" data-target="${esc(tg.mr_target || tg.base_branch || '')}" data-forge="${esc(tg.forge || '')}" title="${esc(tr('task.title.merge-mr'))}"><svg class="ico ico-sm"><use href="#i-merge"/></svg>${tr('task.btn.merge')}</button>` : ''}
    ${tg.last_error ? `<span class="t-err" title="${esc(tg.last_error)}">${svgIco('alert')} ${tr('task.failed')}</span>` : ''}
  </div>${followTarget ? `
  <div class="mr-create followup followup-target" data-followform="tg${tg.id}" hidden>
    <textarea class="followup-text" placeholder="${esc(tr('task.followup.ph-target', { project: tg.project }))}"></textarea>
    <button class="btn" data-followcancel="tg${tg.id}">${tr('ui.cancel')}</button>
    <button class="btn btn-primary" data-followsubmit="${t.id}" data-followtarget="${tg.id}">${tr('task.btn.run-iteration')}</button>
  </div>` : ''}${tg.status === 'needs_input' && tg.questions && tg.questions.length ? questionsForm(t, tg) : ''}`;
}

// Formulaire de réponses aux questions de l'agent (ask → stop → resume). Radio quand
// l'agent a proposé des options (+ « Autre » texte libre), champ texte sinon.
function questionsForm(t, tg) {
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
  return `<div class="questions-box" data-qtask="${t.id}" data-qtarget="${tg.id}">
      <div class="q-head"><svg class="ico ico-sm"><use href="#i-info"/></svg> <strong>${esc(tr('task.questions.title', { n: qs.length, count: qs.length }))}</strong></div>
      ${rows}
      <div class="q-actions"><button class="btn btn-primary btn-sm" data-qsubmit="${tg.id}" data-task="${t.id}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('task.questions.submit'))}</button></div>
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
          <code>${esc(tg.branch || tr('task.default-branch'))}</code>
          ${tg.last_error ? `<span class="t-err" title="${esc(tg.last_error)}">${svgIco('alert')} ${tr('task.failed')}</span>` : ''}
        </div>`).join('')}
      </div>
      ${suiviBlock(t, '')}
      <div class="mr-create followup" data-followform="${t.id}" hidden>
        <textarea class="followup-text" placeholder="${esc(tr('explore.followup.ph'))}">${esc(t.followup_draft || '')}</textarea>
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
    resumeCmdBtn(resume),
  ], [
    `<button class="btn btn-icon btn-sm" data-tedit="${t.id}" title="${tr('task.title.edit')}"><svg class="ico"><use href="#i-edit"/></svg></button>`,
    hideBtn('task', t),
    `<button class="btn btn-icon btn-sm btn-danger" data-tdel="${t.id}" title="${tr('task.title.delete')}"><svg class="ico"><use href="#i-close"/></svg></button>`,
  ])}
    ${t.last_error ? errorBox(t.last_error, null, t.id) : ''}
  </div>`;
}

/* Ranger / ressortir : délégué une fois pour les deux listes plutôt que recâblé à chaque
   rendu — le bouton existe sur les trois sous-onglets et le geste est le même partout. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-hide]');
  if (!b) return;
  const scope = b.dataset.scope === 'local' ? 'local-tasks' : 'tasks';
  const hidden = b.dataset.on !== '1';   // on inverse l'état courant
  try {
    await busy(b, () => api(`/${scope}/${b.dataset.hide}/hidden`, { method: 'POST', body: { hidden } }));
    toast(tr(hidden ? 'task.hidden.done' : 'task.hidden.undone'));
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
    busy(b, () => api(`/tasks/${b.dataset.trun}/run`, { method: 'POST' }))
      .then(() => { toast(tr('toast.session-lancee')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  });

  on('[data-tfold]', (b) => basculerProjets(b.dataset.tfold));

  on('[data-tpushall]', async (b) => {
    if (!await confirmDialog({ text: tr('confirm.push-all'), confirmLabel: tr('task.btn.push') })) return;
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
    busy(b, () => api(`/tasks/${b.dataset.task}/run`, { method: 'POST', body: { targets: [Number(b.dataset.tgrun)] } }))
      .then(() => { toast(tr('toast.projet-lance')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  });

  on('[data-trunfailed]', (b) => {
    const t2 = allTasks.find((x) => x.id === Number(b.dataset.trunfailed));
    const echecs = ((t2 && t2.targets) || []).filter((tg) => tg.status === 'error').map((tg) => tg.id);
    if (!echecs.length) return;
    busy(b, () => api(`/tasks/${b.dataset.trunfailed}/run`, { method: 'POST', body: { targets: echecs } }))
      .then(() => { toast(tr('toast.session-lancee')); loadTasks(); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  });

  on('[data-treconcile]', (b) => busy(b, () => api(`/tasks/${b.dataset.treconcile}/reconcile`, { method: 'POST' }))
    .then(() => { toast(tr('toast.reconcile-lancee')); loadTasks(); refreshStatus(); })
    .catch((e) => toast(explainError(e.message), true)));

  // Converger la session : ouvre la modale (seuil + plafond) ciblée sur cette session.
  on('[data-tconverge]', (b) => openConvergeModal({ type: 'task', id: Number(b.dataset.tconverge), label: b.dataset.label || '' }));

  on('[data-tdel]', async (b) => {
    if (!await confirmDialog({ text: tr('confirm.delete-task'), confirmLabel: tr('ui.delete') })) return;
    try { await api(`/tasks/${b.dataset.tdel}`, { method: 'DELETE' }); toast(tr('toast.session-supprimee')); loadTasks(); }
    catch (e) { toast(explainError(e.message), true); }
  });
  on('[data-tedit]', (b) => openTaskEdit(Number(b.dataset.tedit)).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true)));
  on('[data-tmd]', (b) => openTaskMd(Number(b.dataset.tmd)));

  // --- actions PAR PROJET (codage) ---
  on('[data-tgdiff]', (b) => openTargetDiff(b.dataset.task, b.dataset.tgdiff));
  on('[data-tgout]', (b) => openTargetOutput(b.dataset.task, b.dataset.tgout));
  on('[data-tgpush]', async (b) => {
    const where = `${b.dataset.project} · ${b.dataset.branch}`;
    if (!await confirmDialog({ text: tr('confirm.push-branch', { branch: b.dataset.branch, project: b.dataset.project }), confirmLabel: tr('task.btn.push'), danger: false })) return;
    busy(b, () => api(`/tasks/${b.dataset.task}/targets/${b.dataset.tgpush}/push`, { method: 'POST' }))
      .then(() => { toast(tr('toast.push-lance', { where: where })); refreshStatus(); })
      .catch((e) => toast(explainError(e.message), true));
  });
  on('[data-tgmr]', (b) => {
    openMrModal({
      url: `/tasks/${b.dataset.task}/targets/${b.dataset.tgmr}/mr`,
      title: b.dataset.title, source: b.dataset.branch, target: b.dataset.target || '',
      forge: b.dataset.forge,
      onDone: () => loadTasks(),
    });
  });
  on('[data-tgmerge]', (b) => {
    openMergeModal({
      url: `/tasks/${b.dataset.task}/targets/${b.dataset.tgmerge}/merge`,
      label: `!${b.dataset.iid}`, target: b.dataset.target, forge: b.dataset.forge,
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
  on('[data-followdrop]', (b) => supprimerSuivi(b, `/tasks/${b.dataset.followdrop}/followup-draft`));
  // Envoi manuel : le corps est vide exprès, le serveur prend le suivi enregistré et l'efface.
  on('[data-followsend]', (b) => envoyerSuivi(b, `/tasks/${b.dataset.followsend}/followup`));
  on('[data-followsubmit]', async (b) => {
    const form = b.closest('.followup');
    const field = form.querySelector('.followup-text');
    const instruction = field.value.trim();
    if (!instruction) return;
    const cible = b.dataset.followtarget;
    try {
      await busy(b, () => api(`/tasks/${b.dataset.followsubmit}/followup`, {
        method: 'POST',
        body: cible ? { instruction, targets: [Number(cible)] } : { instruction },
      }));
      // La demande est partie : on referme et on vide. Sans ça le formulaire reste ouvert
      // avec son texte, et `captureTaskForms` le ROUVRE au rendu suivant — on croirait
      // que l'envoi a échoué.
      field.value = '';
      form.hidden = true;
      toast(tr('toast.lance')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  });
  // Soumission des réponses aux questions de l'agent → reprise de la session.
  on('[data-qsubmit]', async (b) => {
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
      await busy(b, () => api(`/tasks/${b.dataset.task}/targets/${b.dataset.qsubmit}/answer`, { method: 'POST', body: { answers } }));
      // Feedback immédiat : on remplace le formulaire par un état « reprise en cours »
      // sans attendre le prochain rechargement (le projet est déjà passé en running côté serveur).
      box.classList.add('resuming');
      box.innerHTML = `<div class="q-head"><span class="spin"></span> <strong>${esc(tr('task.questions.resuming'))}</strong></div>`;
      toast(tr('task.questions.resumed')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  });
}

/* ---- Vues plein écran : diff d'un projet, réponse d'une exploration ---- */
/* « Voir le diff » d'un projet de session : on RÉUTILISE le viewer des MR (arbre +
   fichier entier avec les changements en place + navigation), comme le fait déjà
   l'aperçu avant review. Seuls changent la base d'URL et le panneau de gauche, qui
   affiche ici le RETOUR DE L'IA au lieu du rapport de revue. */
async function openTargetDiff(taskId, targetId) {
  const base = `/tasks/${taskId}/targets/${targetId}`;
  let dv;
  try { dv = await api(`${base}/diffview`); }
  catch (e) { toast(explainError(e.message), true); return; }
  let output = '';
  try { output = (await api(`${base}/output`)).output || ''; } catch { /* pas de retour : panneau vide */ }

  split = {
    mrId: null, base, session: true,
    md: '', explanation: '',
    diffByFile: parseDiffByFile(dv.diff),
    files: dv.files || [],
    target: dv.target || '',
    discussions: [],                       // pas de MR → aucun fil à afficher
    path: null, fullCache: {}, diffFullCache: {},
  };
  $('#splitView').classList.add('session-mode');
  $('#splitTitle').textContent = `${dv.project} — ${dv.branch}`;
  $('#splitMd').innerHTML = output
    ? mdToHtml(output)
    : `<p class="muted">${esc(tr('task.no-output'))}</p>`;
  renderTree();
  $('#splitView').hidden = false;
  const first = split.files.find((f) => f.changed) || split.files[0];
  if (first) selectFile(first.path);
  else { $('#fileName').textContent = tr('preview.no-file'); $('#fileContent').innerHTML = `<p class="muted">${tr('preview.no-file')}</p>`; }
}

let currentMd = '';
// Réponse d'une exploration : même vue à itérations que les sessions — chaque question
// de suivi a sa propre entrée, avec la question posée et la réponse obtenue.
const openTaskMd = (id) => openPasses(`/tasks/${id}`);
/* Retour de l'agent — même vue plein écran que la réponse d'une exploration, avec un
   sélecteur d'ITÉRATION quand la session en compte plusieurs (comme le sélecteur de
   versions d'un rapport de review). Chaque itération montre le prompt envoyé ET le
   retour obtenu : relire une réponse sans savoir à quelle demande elle répondait
   n'apprend rien. `base` est la racine d'URL (session sur dépôt ou hors dépôt), le
   reste du rendu est commun. */
let passCtx = { base: null };
async function openPasses(base, n, dossiers = null) {
  try {
    const d = await api(`${base}/passes${n ? `?n=${n}` : ''}`);
    passCtx = { base, dossiers };
    $('#taskMdTitle').textContent = d.title || '';
    /* Sélecteur de DOSSIER : propre au codage hors dépôt, où une session en couvre plusieurs.
       Comme le sélecteur d'itération, il disparaît quand il n'y a rien à choisir. */
    const selDir = $('#taskPassDir');
    selDir.hidden = !dossiers || dossiers.length < 2;
    if (!selDir.hidden) {
      selDir.innerHTML = dossiers.map((x) => `<option value="${x.id}" ${base.endsWith(`/${x.id}`) ? 'selected' : ''}>${esc(x.path)}</option>`).join('');
    }
    const sel = $('#taskPassVersion');
    // Une seule passe : pas de sélecteur, il n'y a rien à choisir.
    sel.hidden = (d.passes || []).length < 2;
    if (!sel.hidden) {
      const cur = d.current ? d.current.n : 0;
      sel.innerHTML = d.passes.map((p) => `<option value="${p.n}" ${p.n === cur ? 'selected' : ''}>${
        esc(tr('task.pass.option', { n: p.n, kind: tr(`task.pass.kind.${p.kind}`), date: fmtDateTime(p.created_at) }))}</option>`).join('');
    }
    $('#taskMdBody').innerHTML = passBodyHtml(d.current);
    currentMd = d.current ? passMarkdown(d.current) : '';
    $('#taskMdView').hidden = false;
  } catch (e) { toast(explainError(e.message), true); }
}
// Corps d'une itération : la demande, puis la réponse.
function passBodyHtml(p) {
  if (!p) return `<p class="muted">${esc(tr('task.no-output'))}</p>`;
  const prompt = (p.prompt || '').trim();
  return (prompt ? `<h3>${esc(tr('task.pass.prompt'))}</h3><pre class="pass-prompt">${esc(prompt)}</pre>` : '')
    + `<h3>${esc(tr('task.pass.answer'))}</h3>`
    + (p.output ? mdToHtml(p.output) : `<p class="muted">${esc(tr('task.no-output'))}</p>`);
}
// Version copiable (le bouton Copier donne du Markdown, pas du HTML).
function passMarkdown(p) {
  const prompt = (p.prompt || '').trim();
  return `${prompt ? `## ${tr('task.pass.prompt')}\n\n${prompt}\n\n` : ''}## ${tr('task.pass.answer')}\n\n${p.output || ''}`;
}
$('#taskPassVersion').addEventListener('change', (e) => {
  /* Le contexte de DOSSIER se repasse : sans lui, changer d'itération refermerait le
     sélecteur de dossier, et on ne pourrait plus revenir aux autres sans rouvrir la vue. */
  if (passCtx.base) openPasses(passCtx.base, e.target.value, passCtx.dossiers);
});

const openTargetOutput = (taskId, targetId) => openPasses(`/tasks/${taskId}/targets/${targetId}`);
/* Retour de l'agent d'un codage hors dépôt. On passe la liste des dossiers QUI ONT un retour :
   la vue peut alors basculer de l'un à l'autre sans refermer — utile depuis le bouton de la
   session, qui ne désigne aucun dossier en particulier. */
function openLocalDirOutput(taskId, dirId) {
  const t = localTasks.find((x) => String(x.id) === String(taskId));
  const dossiers = ((t && t.dirs) || []).filter((d) => d.output_path).map((d) => ({ id: d.id, path: d.path }));
  return openPasses(`/local-tasks/${taskId}/dirs/${dirId}`, null, dossiers);
}
$('#taskPassDir') && $('#taskPassDir').addEventListener('change', (e) => {
  const base = String(passCtx.base || '');
  openPasses(base.replace(/\/dirs\/\d+$/, `/dirs/${e.target.value}`), null, passCtx.dossiers);
});
$('#taskMdClose').addEventListener('click', () => { $('#taskMdView').hidden = true; });
$('#taskMdCopy').addEventListener('click', () => copyText(currentMd, $('#taskMdCopy')));

/* ---------- Export d'une réponse d'agent (HTML · Word · PDF) ----------
   Une réponse d'IA se relit souvent ailleurs que dans Mergerie : dans un ticket, dans un
   compte rendu, envoyée à quelqu'un qui n'a pas l'outil. Copier le Markdown ne suffit pas
   quand le destinataire attend un document.

   Répartition : le HTML et le PDF se fabriquent ICI — le contenu rendu est déjà à l'écran,
   et le PDF passe par la boîte d'impression du navigateur, donc sans rien installer et avec
   le même rendu qu'à l'écran. Le .docx est un ZIP : c'est le serveur qui l'assemble. */

// Feuille de style embarquée dans l'export : le document doit rester lisible seul, sans
// l'application autour. Volontairement sobre — c'est un document, pas une capture d'écran.
const CSS_EXPORT = `
  body { font: 15px/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1b2230; background: #fff; max-width: 820px; margin: 32px auto; padding: 0 20px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 21px; margin: 28px 0 8px; }
  h3 { font-size: 17px; margin: 22px 0 6px; }
  h4 { font-size: 15px; margin: 18px 0 6px; }
  p, li { margin: 8px 0; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .9em;
    background: #f2f4f8; padding: 1px 5px; border-radius: 4px; }
  pre { background: #f6f8fa; border: 1px solid #e2e6ee; border-radius: 6px; padding: 12px;
    overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 10px 0; padding: 2px 14px; border-left: 3px solid #ccc; color: #555; }
  table { border-collapse: collapse; margin: 12px 0; width: 100%; }
  th, td { border: 1px solid #ccd2dd; padding: 6px 10px; text-align: left; }
  th { background: #f2f4f8; }
  .meta { color: #5d6a80; font-size: 12px; margin: 0 0 24px; }
  @media print { body { margin: 0; max-width: none; } }
`;

/* Le document autonome. Le titre et la date sont dans le corps, pas seulement dans le nom du
   fichier : un document imprimé ou transféré perd son nom de fichier bien avant son contenu. */
function documentExport(titre) {
  const corps = $('#taskMdBody');
  return `<!doctype html><html lang="${I18Nrt.currentLocale().slice(0, 2)}"><head><meta charset="utf-8" />`
    + `<title>${esc(titre)}</title><style>${CSS_EXPORT}</style></head><body>`
    + `<h1>${esc(titre)}</h1><p class="meta">Mergerie — ${esc(fmtDateTime(new Date().toISOString()))}</p>`
    + (corps ? corps.innerHTML : '') + '</body></html>';
}

// Nom de fichier lisible : on écarte ce qui casse un chemin, on garde les accents.
const nomExport = (titre) => (String(titre || '').trim()
  .replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').slice(0, 80).trim() || 'mergerie');

function telecharger(blob, nom) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nom;
  document.body.appendChild(a); a.click(); a.remove();
  // Révocation différée : sur certains navigateurs, révoquer trop tôt annule le téléchargement.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exporterReponse(format) {
  const titre = $('#taskMdTitle').textContent || 'Mergerie';
  if (!currentMd.trim()) { toast(tr('export.empty'), true); return; }
  try {
    if (format === 'html') {
      telecharger(new Blob([documentExport(titre)], { type: 'text/html;charset=utf-8' }), `${nomExport(titre)}.html`);
      toast(tr('export.done', { format: 'HTML' }));
      return;
    }
    if (format === 'docx') {
      /* `api()` renvoie du JSON : ici on veut l'octet brut, donc `fetch` direct. Le nom du
         fichier vient du serveur (`Content-Disposition`), mais on le repose côté client :
         `a.download` est ce que le navigateur écoute pour un Blob. */
      const res = await fetch('/api/export/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: titre, markdown: currentMd }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || res.statusText);
      telecharger(await res.blob(), `${nomExport(titre)}.docx`);
      toast(tr('export.done', { format: 'Word' }));
      return;
    }
    /* PDF : on passe par la boîte d'impression du navigateur, « Enregistrer au format PDF ».
       Produire un vrai PDF demanderait un moteur de rendu complet côté serveur (~300 Mo)
       pour un résultat moins fidèle que celui du navigateur, qui sait déjà mettre ce
       document en pages. Une iframe cachée plutôt qu'un onglet : rien ne clignote, et les
       bloqueurs de fenêtres n'ont pas leur mot à dire. */
    const cadre = document.createElement('iframe');
    cadre.setAttribute('aria-hidden', 'true');
    cadre.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(cadre);
    cadre.srcdoc = documentExport(titre);
    await new Promise((r) => { cadre.onload = r; });
    toast(tr('export.pdf-hint'));
    cadre.contentWindow.focus();
    cadre.contentWindow.print();
    // On attend la fermeture de la boîte avant de retirer l'iframe : la détruire pendant
    // l'impression annulerait le rendu sur certains navigateurs.
    setTimeout(() => cadre.remove(), 60_000);
  } catch (e) { toast(explainError(e.message), true); }
}

$('#taskMdExport') && $('#taskMdExport').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#taskMdExportMenu');
  const ouvert = menu.hidden;
  closeSplitMenus();
  menu.hidden = !ouvert;
  $('#taskMdExport').setAttribute('aria-expanded', String(ouvert));
});
$('#taskMdExportMenu') && $('#taskMdExportMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]'); if (!b) return;
  closeSplitMenus();
  busy(b, () => exporterReponse(b.dataset.export));
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#taskMdView').hidden) $('#taskMdView').hidden = true;
});

const taskSearchEl = $('#taskSearch');
// Filtrage local (aucun appel serveur), regroupé : renderTasks reconstruit toute la liste.
if (taskSearchEl) taskSearchEl.addEventListener('input', debounce(renderTasks));

/* La case « afficher les sessions masquées » vaut pour les trois sous-onglets et survit au
   rechargement : c'est une préférence de vue, pas un filtre de passage. Même stockage que
   le sous-onglet courant. */
const showHiddenEl = $('#taskShowHidden');
if (showHiddenEl) {
  showHiddenEl.checked = showHiddenTasks;
  showHiddenEl.addEventListener('change', () => {
    showHiddenTasks = showHiddenEl.checked;
    try { localStorage.setItem('aidevtools_show_hidden', showHiddenTasks ? '1' : '0'); } catch { /* ignore */ }
    renderTasks();
  });
}

try { taskKind = localStorage.getItem('aidevtools_task_kind') || 'code'; } catch { /* ignore */ }

/* ---------- Ajout en masse de dépôts (GitLab ou GitHub) ----------
   Une seule modale, paramétrée par la forge : même recherche, même « tout cocher »,
   seules la source et l'étiquette changent. */
let bulkProjects = [];
let bulkForge = 'gitlab';
const bulkSelected = new Set();

async function openBulk(forge = 'gitlab') {
  bulkForge = forge === 'github' ? 'github' : 'gitlab';
  bulkProjects = [];
  bulkSelected.clear();
  $('#bulkSearch').value = '';
  $('#bulkList').innerHTML = skeleton(5);
  const title = $('#bulkTitle');
  if (title) title.textContent = tr(`settings.bulk.title.${bulkForge}`);
  $('#bulkModal').hidden = false;
  try {
    bulkProjects = await api(`/${bulkForge}/projects`);
    renderBulk();
  } catch (e) {
    $('#bulkList').innerHTML = errorBox(e.message);
  }
}
function closeBulk() { $('#bulkModal').hidden = true; }

function renderBulk() {
  const q = ($('#bulkSearch').value || '').toLowerCase().trim();
  const list = bulkProjects.filter((p) => !q || (p.project || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
  const el = $('#bulkList');
  if (!bulkProjects.length) {
    el.innerHTML = emptyState({ icon: 'alert', title: tr('settings.bulk.empty.title'),
      text: tr(bulkForge === 'github' ? 'settings.bulk.empty.github.text' : 'settings.bulk.empty.text'),
      actions: [{ act: 'go-config', label: tr('settings.bulk.empty.action') }] });
    return;
  }
  el.innerHTML = list.length ? list.map((p) => `
    <label class="bulk-item ${p.already ? 'already' : ''}">
      <input type="checkbox" data-proj="${esc(p.project)}" ${p.already ? 'checked disabled' : (bulkSelected.has(p.project) ? 'checked' : '')}/>
      <span class="bulk-path">${esc(p.project)}</span>
      ${p.already ? `<span class="tag done">${tr('settings.bulk.already')}</span>` : ''}
    </label>`).join('') : `<p class="muted">${tr('settings.bulk.no-match', { q: esc(q) })}</p>`;
  updateBulkCount();
}
function updateBulkCount() {
  $('#bulkCount').textContent = bulkSelected.size ? tr('settings.bulk.selected', { n: bulkSelected.size, count: bulkSelected.size }) : '';
  $('#bulkAdd').disabled = bulkSelected.size === 0;
}

$('#btnBrowseProjects').addEventListener('click', () => openBulk('gitlab'));
const btnBrowseGithub = $('#btnBrowseGithub');
if (btnBrowseGithub) btnBrowseGithub.addEventListener('click', () => openBulk('github'));
$('#bulkCancel').addEventListener('click', closeBulk);
fermerAuFond('#bulkModal', closeBulk);
$('#bulkSearch').addEventListener('input', renderBulk);
$('#bulkList').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-proj]');
  if (!cb || cb.disabled) return;
  if (cb.checked) bulkSelected.add(cb.dataset.proj); else bulkSelected.delete(cb.dataset.proj);
  updateBulkCount();
});
$('#bulkAll').addEventListener('click', () => {
  const q = ($('#bulkSearch').value || '').toLowerCase().trim();
  bulkProjects.filter((p) => !p.already && (!q || (p.project || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)))
    .forEach((p) => bulkSelected.add(p.project));
  renderBulk();
});
$('#bulkNone').addEventListener('click', () => { bulkSelected.clear(); renderBulk(); });
$('#bulkAdd').addEventListener('click', async () => {
  const projects = bulkProjects.filter((p) => bulkSelected.has(p.project)).map((p) => ({ project: p.project, url: p.url }));
  if (!projects.length) return;
  const btn = $('#bulkAdd'); btn.disabled = true;
  try {
    const r = await api('/repos/bulk', { method: 'POST', body: { projects, branch_pattern: $('#bulkPattern').value, forge: bulkForge } });
    toast(tr('toast.repos-added', { n: r.added, added: r.added }) + (r.skipped ? tr('toast.repos-skipped', { n: r.skipped, skipped: r.skipped }) : ''));
    closeBulk();
    loadRepos();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
});

/* ---------- Règles de review spécifiques ---------- */
async function loadRules() {
  const rows = await api('/rules');
  const el = $('#ruleList');
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="card repo-row" data-rule="${r.id}">
      <div class="rule-head">
        <input data-f="branch_match" value="${esc(r.branch_match || '')}" class="rule-match" placeholder="${tr('settings.rule.ph.ex-proj-12344')}" title="${tr('settings.rule.match-title')}" />
        <input data-f="path_match" value="${esc(r.path_match || '')}" class="rule-match" placeholder="${tr('settings.rule.ph.path-match')}" title="${esc(tr('settings.rule.tip.path-match'))}" />
        <input data-f="label" value="${esc(r.label || '')}" class="rule-label" placeholder="${tr('settings.rule.ph.label')}" title="${esc(tr('settings.rule.tip.label'))}" />
        <div class="spacer"></div>
        <label class="muted"><input type="checkbox" data-rtoggle="${r.id}" ${r.enabled ? 'checked' : ''}/> ${tr('settings.rule.enabled')}</label>
        <button class="btn btn-primary" data-rsave="${r.id}" title="${tr('settings.rule.save-title')}">${tr('ui.save')}</button>
        <button class="btn btn-icon btn-sm btn-danger" data-rdel="${r.id}" title="${tr('settings.rule.del-title')}"><svg class=\"ico\"><use href=\"#i-close\"/></svg></button>
      </div>
      <textarea data-f="content" rows="3" class="rule-content">${esc(r.content)}</textarea>
    </div>`).join('') : emptyState({ icon: 'sliders', title: tr('settings.rule.empty.title'), text: tr('settings.rule.empty.text') });

  const ruleEl = (id) => $(`#ruleList .repo-row[data-rule="${id}"]`);
  const gather = (id) => {
    const row = ruleEl(id); const body = {};
    row.querySelectorAll('[data-f]').forEach((i) => { body[i.dataset.f] = i.value; });
    return body;
  };
  $$('#ruleList [data-rsave]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/rules/${b.dataset.rsave}`, { method: 'PUT', body: gather(b.dataset.rsave) }); toast(tr('toast.regle-enregistree')); loadRules(); }
    catch (e) { b.disabled = false; toast(e.message, true); }
  }));
  $$('#ruleList [data-rtoggle]').forEach((cb) => cb.addEventListener('change', async () => {
    try { await api(`/rules/${cb.dataset.rtoggle}`, { method: 'PUT', body: { enabled: cb.checked } }); }
    catch (e) { toast(e.message, true); }
  }));
  $$('#ruleList [data-rdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.delete-rule'), confirmLabel: tr('ui.delete') })) return;
    await api(`/rules/${b.dataset.rdel}`, { method: 'DELETE' }); loadRules();
  }));
}
$('#ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/rules', { method: 'POST', body: {
      branch_match: f.branch_match.value, path_match: f.path_match.value, label: f.label.value, content: f.content.value,
    } });
    f.branch_match.value = ''; f.path_match.value = ''; f.label.value = ''; f.content.value = ''; loadRules(); toast(tr('toast.regle-ajoutee'));
  } catch (err) { toast(err.message, true); }
});

/* ---------- Chrono de session de travail ---------- */
(function () {
  const KEY = 'aidevtools_chrono';
  const RESUME_GAP = 8000; // au-delà, on considère le navigateur fermé -> pas de reprise auto
  let accMs = 0;      // temps réellement compté (hors run en cours)
  let startedAt = 0;  // Date.now() du début du run courant (0 si en pause) — en mémoire seulement
  let tick = null;

  const elapsed = () => accMs + (startedAt ? Date.now() - startedAt : 0);
  // On persiste le temps RÉELLEMENT écoulé + un battement horodaté (pas l'horloge de départ).
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ ms: elapsed(), running: !!startedAt, beat: Date.now() })); } catch { /* ignore */ } };
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => {
    const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  };
  const render = () => {
    $('#chronoTime').textContent = fmt(elapsed());
    const running = !!startedAt;
    $('#chrono').classList.toggle('running', running);
    $('#chronoStart').hidden = running;
    $('#chronoPause').hidden = !running;
  };
  const beat = () => { render(); save(); };               // chaque battement met à jour ET sauvegarde
  const startTick = () => { if (!tick) tick = setInterval(beat, 1000); };
  const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } };

  $('#chronoStart').addEventListener('click', () => { if (!startedAt) { startedAt = Date.now(); save(); startTick(); render(); } });
  $('#chronoPause').addEventListener('click', () => { if (startedAt) { accMs = elapsed(); startedAt = 0; save(); stopTick(); render(); } });
  $('#chronoReset').addEventListener('click', () => { accMs = 0; startedAt = 0; save(); stopTick(); render(); });

  // Synchro multi-onglets : l'événement 'storage' ne se déclenche que dans les AUTRES
  // onglets. On adopte l'état écrit, en réinitialisant startedAt à maintenant quand ça
  // tourne (sinon deux onglets running divergeraient en ajoutant chacun leur propre delta).
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    let s;
    try { s = JSON.parse(e.newValue); } catch { return; }
    accMs = s.ms || 0;
    if (s.running) { startedAt = Date.now(); startTick(); }
    else { startedAt = 0; stopTick(); }
    render();
  });

  // Restauration : on repart du temps sauvegardé. On ne reprend le décompte QUE si le
  // dernier battement est récent (simple rechargement) ; sinon on reste en pause.
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    accMs = s.ms || 0;
    if (s.running && (Date.now() - (s.beat || 0)) < RESUME_GAP) { startedAt = Date.now(); startTick(); }
  } catch { /* ignore */ }
  render();
})();

/* ---------- Footer télémétrie « live » ----------
   Mode LIVE (défaut) : le bandeau reste CALME et n'affiche que l'actionnable —
   une MR qui vient d'arriver ou d'être mergée, une MR qui attend depuis trop
   longtemps. La frame apparaît en fondu, reste 8 s, disparaît. Elle est CLIQUABLE
   (ouvre la MR concernée) : c'est ce qui la distingue d'un économiseur d'écran.
   Mode STATS (optionnel) : rejoue l'ensemble des indicateurs dérivés des données.
   Pas de défilement : un mouvement continu en périphérie coûte de l'attention
   pendant la lecture d'un rapport, pour une valeur instantanée nulle. */
(function footer() {
  const frameEl = $('#footerFrame');
  const tokEl = $('#footerTokCount');
  if (!frameEl || !tokEl) return;

  let data = null;
  let dataTimer = null;
  let holdTimer = null;
  let tokShown = 0;
  let userHidden = false;
  let mode = 'live';
  const HOLD_MS = 8000;          // durée d'affichage d'une frame
  const NO_REPEAT_MS = 16 * 60 * 1000;
  const shownAt = new Map();
  const isPaused = () => document.hidden || userHidden;

  const fmt = (n) => Number(n || 0).toLocaleString(I18Nrt.currentLocale());
  const plur = (n) => (n > 1 ? 's' : '');
  const agoMin = (iso, nowIso) => Math.max(0, Math.floor((new Date(nowIso) - new Date(iso)) / 60000));
  const humanAgo = (m) => (m < 1 ? tr('footer.ago.now')
    : m < 60 ? tr('footer.ago.min', { n: m })
    : m < 1440 ? tr('footer.ago.hour', { n: Math.floor(m / 60) })
    : tr('footer.ago.day', { n: Math.floor(m / 1440) }));
  const feedText = (e, fresh) => {
    const who = e.author ? ` — ${e.author}` : '';
    if (e.type === 'mr_merged') return tr(fresh ? 'footer.feed.merged-fresh' : 'footer.feed.merged', { iid: e.mr_iid, who, project: e.project });
    return tr(fresh ? 'footer.feed.opened-fresh' : 'footer.feed.opened', { iid: e.mr_iid, who, project: e.project });
  };

  // Mode LIVE : uniquement ce sur quoi on peut AGIR, avec la cible du clic.
  function liveFrames(d) {
    const o = [];
    for (const e of (d.feed || [])) {
      const min = agoMin(e.at, d.now);
      if (min > 240) continue; // au-delà de 4 h ce n'est plus une actualité
      o.push({
        t: min <= 15 ? feedText(e, true) : `${feedText(e, false)} · ${humanAgo(min)}`,
        act: e.mr_id ? { mr: e.mr_id } : { seg: 'to_review' },
        w: min <= 15 ? 9 : 3,
      });
    }
    const t = d.team || {};
    if (t.oldestWaitingDays != null && t.oldestWaitingDays >= 2) {
      o.push({ t: tr('footer.oldest-waiting', { n: t.oldestWaitingDays }), act: { seg: 'to_review' }, w: 4 });
    }
    for (const m of (d.toReviewList || []).filter((x) => x.ageDays != null && x.ageDays >= 3).slice(0, 3)) {
      o.push({ t: tr('footer.mr-waiting', { iid: m.iid, n: m.ageDays, who: m.author ? ` — ${m.author}` : '' }), act: { mr: m.id }, w: 3 });
    }
    return o;
  }
  const providers = [
    // Événements FRAIS : « une MR vient d'arriver / vient d'être mergée par X »
    (d) => {
      const o = [];
      for (const e of (d.feed || [])) {
        const min = agoMin(e.at, d.now);
        if (min > 2880) continue; // > 2 j : trop vieux
        const fresh = min <= 15;
        o.push({ t: fresh ? feedText(e, true) : `${feedText(e, false)} · ${humanAgo(min)}`, w: fresh ? 9 : (min <= 120 ? 4 : 2) });
      }
      return o;
    },
    // Une frame PAR MR en attente (grosse source de variété)
    (d) => (d.toReviewList || []).map((m) => {
      const age = m.ageDays == null ? '' : ` · ${m.ageDays === 0 ? tr('footer.today') : tr('footer.ago.day', { n: m.ageDays })}`;
      return { t: tr('footer.mr-pending', { iid: m.iid, title: (m.title || '').slice(0, 60), who: m.author ? ` — ${m.author}` : '', project: m.project, age }), w: 3 };
    }),
    // Une frame PAR review récente
    (d) => (d.recentReviews || []).map((r) => ({
      t: tr('footer.reviewed', { iid: r.iid, note: r.note10 != null ? ` · ${r.note10}/10` : '', project: r.project, when: r.at ? ` · ${humanAgo(agoMin(r.at, d.now))}` : '' }),
      w: 2,
    })),
    // Plusieurs frames PAR projet (volume, note moyenne, meilleure, pire)
    (d) => (d.projects || []).flatMap((p) => {
      const f = [];
      if (p.reviewed > 0) f.push({ t: tr('footer.proj.reviewed', { n: p.reviewed, count: p.reviewed, project: p.project, avg: p.avgNote != null ? tr('footer.proj.avg', { avg: p.avgNote }) : '' }), w: 2 });
      if (p.pending > 0) f.push({ t: tr('footer.proj.pending', { n: p.pending, count: p.pending, project: p.project }), w: 2 });
      if (p.bestNote != null) f.push({ t: tr('footer.proj.best', { project: p.project, note: p.bestNote }), w: 1 });
      if (p.worstNote != null) f.push({ t: tr('footer.proj.worst', { project: p.project, note: p.worstNote }), w: 1 });
      return f;
    }),
    // Une frame PAR auteur (MR en attente)
    (d) => (d.authors || []).map((a) => ({ t: tr('footer.author.pending', { n: a.c, count: a.c, author: a.author }), w: 2 })),
    // Une frame PAR auteur (notes reçues sur ses MR)
    (d) => (d.authorNotes || []).filter((a) => a.avgNote != null)
      .map((a) => ({ t: tr('footer.author.notes', { n: a.reviewed, count: a.reviewed, author: a.author, avg: a.avgNote }), w: 2 })),
    // Une frame PAR semaine (8 dernières)
    (d) => (d.weekly || []).map((w) => {
      const label = w.weeksAgo === 0 ? tr('footer.week.this') : w.weeksAgo === 1 ? tr('footer.week.last') : tr('footer.week.ago', { n: w.weeksAgo });
      const bits = [];
      if (w.reviews) bits.push(tr('footer.bits.reviews', { n: w.reviews, count: w.reviews }));
      if (w.tokens) bits.push(`${fmt(w.tokens)} tokens`);
      return { t: `${label} · ${bits.join(' · ')}`, w: 2 };
    }),
    // Une frame PAR tranche de notes
    (d) => (d.noteBuckets || []).filter((b) => b.count > 0)
      .map((b) => ({ t: tr('footer.bucket', { n: b.count, count: b.count, label: b.label }), w: 1 })),
    // Comparaisons (aujourd'hui vs hier, semaine vs précédente)
    (d) => {
      const o = [];
      const today = (d.daily || []).find((x) => x.daysAgo === 0);
      const yest = (d.daily || []).find((x) => x.daysAgo === 1);
      if (today && yest) {
        if (today.reviews !== yest.reviews) o.push({ t: tr('footer.cmp.day', { n: today.reviews, count: today.reviews, yest: yest.reviews }), w: 2 });
        if (today.tokens && yest.tokens) o.push({ t: tr('footer.cmp.tokens', { today: fmt(today.tokens), yest: fmt(yest.tokens) }), w: 2 });
      }
      const w0 = (d.weekly || []).find((x) => x.weeksAgo === 0);
      const w1 = (d.weekly || []).find((x) => x.weeksAgo === 1);
      if (w0 && w1 && w0.reviews !== w1.reviews) o.push({ t: tr('footer.cmp.week', { n: w0.reviews, count: w0.reviews, prev: w1.reviews }), w: 2 });
      return o;
    },
    // Équivalences tangibles des tokens
    (d) => {
      const o = []; const tot = d.tokens.total || 0;
      if (tot > 1000) o.push({ t: tr('footer.eq.pages', { tokens: fmt(tot), n: fmt(Math.round(tot / 500)) }), w: 1 });
      if (tot > 1000) o.push({ t: tr('footer.eq.minutes', { tokens: fmt(tot), n: fmt(Math.round(tot / 200)) }), w: 1 });
      if (tot > 1000) o.push({ t: tr('footer.eq.novels', { n: tot >= 200000 ? 2 : 1, tokens: fmt(tot), count: (tot / 100000).toFixed(1) }), w: 1 });
      return o;
    },
    // Une frame PAR jour d'activité (14 derniers jours)
    (d) => (d.daily || []).map((x) => {
      let label;
      if (x.daysAgo === 0) label = tr('footer.today');
      else if (x.daysAgo === 1) label = tr('footer.yesterday');
      else label = new Date(`${x.day}T12:00:00`).toLocaleDateString(I18Nrt.currentLocale(), { weekday: 'long', day: '2-digit', month: '2-digit' });
      const bits = [];
      if (x.reviews) bits.push(tr('footer.bits.reviews', { n: x.reviews, count: x.reviews }));
      if (x.tokens) bits.push(`${fmt(x.tokens)} tokens`);
      return { t: `${label} · ${bits.join(' · ')}`, w: 2 };
    }),
    // Une frame PAR dev session récente
    (d) => (d.recentTasks || []).map((t) => ({
      t: tr(t.status === 'pushed' ? 'footer.task.pushed' : 'footer.task.committed', { branch: t.branch }), w: 2,
    })),
    // Tokens : répartition par type d'appel + repères
    (d) => {
      const o = [];
      const label = { review: tr('footer.kind.review'), explain: tr('footer.kind.explain'), task: tr('footer.kind.task') };
      for (const k of (d.tokensByKind || [])) {
        if (!k.tokens) continue;
        o.push({ t: tr('footer.tokens.by-kind', { n: k.calls, kind: label[k.kind] || k.kind, tokens: fmt(k.tokens), count: k.calls }), w: 2 });
      }
      const ts = d.tokenStats || {};
      if (ts.avgPerCall) o.push({ t: tr('footer.tokens.avg', { n: fmt(ts.avgPerCall) }), w: 1 });
      if (ts.maxCall) o.push({ t: tr('footer.tokens.max', { n: fmt(ts.maxCall) }), w: 1 });
      return o;
    },
    // Activité de l'équipe (agrégats)
    (d) => {
      const o = []; const t = d.team || {};
      if (t.newToday > 0) o.push({ t: tr('footer.team.new-today', { n: t.newToday, count: t.newToday }), w: 5 });
      if (t.toReview > 0) o.push({ t: tr('footer.team.to-review', { n: t.toReview, count: t.toReview }), w: 2 });
      if (t.oldestWaitingDays != null && t.oldestWaitingDays >= 2) o.push({ t: tr('footer.oldest-waiting', { n: t.oldestWaitingDays }), w: 3 });
      if (t.topAuthorToday && t.topAuthorToday.author) o.push({ t: tr('footer.team.top-author', { n: t.topAuthorToday.c, author: t.topAuthorToday.author, count: t.topAuthorToday.c }), w: 3 });
      return o;
    },
    // Records & cumuls — purement FACTUEL (pas d'objectif imposé)
    (d) => {
      const o = [];
      if (d.reviews.total > 0) o.push({ t: tr('footer.rec.total', { n: d.reviews.total, count: fmt(d.reviews.total) }), w: 2 });
      if (d.streak >= 2) o.push({ t: tr('footer.rec.streak', { n: d.streak }), w: 2 });
      if (d.reviews.bestNoteAllTime != null) o.push({ t: tr('footer.rec.best', { note: d.reviews.bestNoteAllTime }), w: 2 });
      if (d.reviews.today > 0) o.push({ t: tr('footer.rec.today', { n: d.reviews.today, count: d.reviews.today }), w: 2 });
      if (d.reviews.avgNote != null) o.push({ t: tr('footer.rec.avg', { avg: d.reviews.avgNote, total: d.reviews.total }), w: 2 });
      if (d.tokens.total > 0) o.push({ t: tr('footer.rec.tokens-total', { n: fmt(d.tokens.total) }), w: 1 });
      if (d.tokens.today > 0) o.push({ t: tr('footer.rec.tokens-today', { n: fmt(d.tokens.today) }), w: 2 });
      if (d.tokens.calls > 0) o.push({ t: tr('footer.rec.calls', { n: d.tokens.calls, count: fmt(d.tokens.calls) }), w: 1 });
      if (d.commits > 0) o.push({ t: tr('footer.rec.commits', { n: d.commits, count: fmt(d.commits) }), w: 2 });
      if (d.mrMerged > 0) o.push({ t: tr('footer.rec.merged', { n: d.mrMerged, count: d.mrMerged }), w: 2 });
      const coffees = Math.floor(d.tokens.total / 20000);
      if (coffees >= 1) o.push({ t: tr('footer.eq.coffee', { n: coffees, tokens: fmt(d.tokens.total), count: coffees }), w: 1 });
      return o;
    },
    // Contexte (heure / jour)
    (d) => {
      const dt = new Date(d.now); const h = dt.getHours(); const day = dt.getDay(); const o = [];
      if (h >= 22 || h < 6) o.push({ t: tr('footer.ctx.night'), w: 1 });
      else if (h < 10) o.push({ t: tr('footer.ctx.morning', { n: d.team.toReview || 0, count: d.team.toReview || 0 }), w: 1 });
      else if (h >= 12 && h < 14) o.push({ t: tr('footer.ctx.lunch'), w: 1 });
      if (day === 1) o.push({ t: tr('footer.ctx.monday'), w: 1 });
      else if (day === 5) o.push({ t: tr('footer.ctx.friday'), w: 1 });
      else if (day === 0 || day === 6) o.push({ t: tr('footer.ctx.weekend'), w: 1 });
      return o;
    },
  ];

  // Tirage pondéré, sans rejouer ce qui a été vu récemment. En mode live, s'il n'y
  // a rien de neuf à dire → null → le bandeau reste calme (c'est voulu).
  function pickFrame() {
    if (!data) return null;
    const now = Date.now();
    for (const [k, ts] of shownAt) if (now - ts > NO_REPEAT_MS * 3) shownAt.delete(k);
    let pool = [];
    if (mode === 'live') {
      pool = liveFrames(data);
    } else {
      for (const p of providers) {
        try { for (const f of p(data)) if (f && f.t) pool.push(f); } catch { /* provider tolérant */ }
      }
    }
    const unseen = pool.filter((f) => { const ts = shownAt.get(f.t); return ts == null || (now - ts) > NO_REPEAT_MS; });
    const from = unseen.length ? unseen : (mode === 'live' ? [] : pool);
    if (!from.length) return null;
    const total = from.reduce((s, f) => s + (f.w || 1), 0);
    let r = Math.random() * total; let chosen = from[0];
    for (const f of from) { r -= (f.w || 1); if (r <= 0) { chosen = f; break; } }
    shownAt.set(chosen.t, now);
    return chosen;
  }

  function runAct(act) {
    if (!act) return;
    const go = (tab) => { const t = $(`nav button[data-tab="${tab}"]`); if (t) t.click(); };
    if (act.mr) { go('review'); loadSegment('to_review').then(() => openReport(act.mr)).catch(() => {}); return; }
    if (act.seg) { go('review'); loadSegment(act.seg); }
  }

  function showFrame(f) {
    frameEl.innerHTML = '';
    if (!f) return;
    const el = document.createElement(f.act ? 'button' : 'span');
    el.className = 'footer-msg' + (f.act ? ' clickable' : '');
    el.textContent = f.t;
    if (f.act) {
      el.title = tr('ui.open');
      el.addEventListener('click', () => runAct(f.act));
    }
    frameEl.appendChild(el);
  }

  // Boucle : une frame, 8 s, puis silence. Rien à dire → on retente plus tard.
  function loop() {
    holdTimer = null;
    if (isPaused()) return;
    const f = pickFrame();
    if (!f) { showFrame(null); holdTimer = setTimeout(loop, 5000); return; }
    showFrame(f);
    holdTimer = setTimeout(() => {
      showFrame(null);
      holdTimer = setTimeout(loop, 900);
    }, HOLD_MS);
  }

  function animateTokens(target) {
    target = Number(target) || 0;
    const start = tokShown; const delta = target - start;
    if (!delta) { tokEl.textContent = fmt(target); return; }
    const t0 = performance.now(); const dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      tokShown = Math.round(start + delta * eased);
      tokEl.textContent = fmt(tokShown);
      if (k < 1 && !document.hidden) requestAnimationFrame(step);
      else { tokShown = target; tokEl.textContent = fmt(target); }
    };
    requestAnimationFrame(step);
  }

  async function refresh() {
    try {
      data = await api('/footer');
      animateTokens(data.tokens.total);
      if (!holdTimer && !isPaused()) loop(); // un événement frais peut sortir le bandeau du silence
    } catch { /* le footer ne doit jamais gêner */ }
  }
  function startData() { if (!dataTimer) dataTimer = setInterval(refresh, 20000); }
  function stopData() { if (dataTimer) { clearInterval(dataTimer); dataTimer = null; } }
  function pauseAll() { stopData(); if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } showFrame(null); }
  function resumeAll() { if (isPaused()) return; startData(); refresh(); if (!holdTimer) loop(); }

  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAll(); else resumeAll(); });

  // Bascule live / stats
  const modeBtn = $('#footerMode');
  function setMode(m) {
    mode = m;
    if (modeBtn) { modeBtn.textContent = m === 'live' ? 'live' : 'stats'; modeBtn.title = m === 'live' ? tr('footer.mode.live-title') : tr('footer.mode.stats-title'); }
    try { localStorage.setItem('aidevtools_footer_mode', m); } catch { /* ignore */ }
    shownAt.clear();
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (!isPaused()) loop();
  }
  if (modeBtn) modeBtn.addEventListener('click', () => setMode(mode === 'live' ? 'stats' : 'live'));

  // Masquer / réafficher le bandeau (état conservé d'une session à l'autre)
  const FKEY = 'aidevtools_footer_hidden';
  const footerEl = $('#footer'); const showBtn = $('#footerShow');
  function setHidden(h) {
    userHidden = h;
    if (footerEl) footerEl.hidden = h;
    if (showBtn) showBtn.hidden = !h;
    document.body.classList.toggle('footer-hidden', h);
    try { localStorage.setItem(FKEY, h ? '1' : '0'); } catch { /* ignore */ }
    if (h) pauseAll(); else resumeAll();
  }
  const hideBtn = $('#footerHide');
  if (hideBtn) hideBtn.addEventListener('click', () => setHidden(true));
  if (showBtn) showBtn.addEventListener('click', () => setHidden(false));

  try { userHidden = localStorage.getItem(FKEY) === '1'; } catch { /* ignore */ }
  try { mode = localStorage.getItem('aidevtools_footer_mode') || 'live'; } catch { /* ignore */ }
  setMode(mode);
  setHidden(userHidden);
})();


// Filet de sécurité : une promesse rejetée non gérée passait totalement inaperçue
// (bouton qui « ne fait rien »). On la remonte à l'écran.
// ---------- Info-bulles des champs de formulaire ----------
const tipEl = document.createElement('div');
tipEl.id = 'tip';
tipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tipEl);

function showTip(el) {
  tipEl.textContent = el.dataset.tip;
  // Tooltip « code » (large, monospace, multi-ligne) pour le contenu d'une commande Makefile.
  tipEl.classList.toggle('tip-code', el.classList.contains('hint-code'));
  tipEl.classList.add('on');
  const r = el.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  // Sous l'icône par défaut ; au-dessus s'il n'y a pas la place en bas.
  const below = r.bottom + 8 + t.height <= innerHeight;
  tipEl.style.top = `${below ? r.bottom + 8 : r.top - 8 - t.height}px`;
  // Recentrée sur l'icône, en restant dans la fenêtre.
  const left = r.left + r.width / 2 - t.width / 2;
  tipEl.style.left = `${Math.max(8, Math.min(left, innerWidth - t.width - 8))}px`;
}
const hideTip = () => tipEl.classList.remove('on');

/* Délégation : couvre aussi les champs rendus dynamiquement (lignes de projet).
   Le sélecteur vise TOUT porteur de `data-tip` et pas seulement les icônes `.hint` :
   des éléments non cliquables (badges de santé du menu) ont aussi besoin d'expliquer
   ce qu'ils affichent. */
document.addEventListener('mouseover', (e) => {
  const h = e.target.closest && e.target.closest('[data-tip]');
  if (h) showTip(h);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest && e.target.closest('[data-tip]')) hideTip();
});
document.addEventListener('focusin', (e) => {
  const h = e.target.closest && e.target.closest('[data-tip]');
  if (h) showTip(h); else hideTip();
});
document.addEventListener('focusout', hideTip);
// L'icône vit à l'intérieur d'un <label> : sans ça, cliquer dessus activerait
// le champ associé (la case Auto-push se cocherait toute seule).
document.addEventListener('click', (e) => {
  const h = e.target.closest && e.target.closest('.hint');
  if (!h) return;
  e.preventDefault();
  e.stopPropagation();
  showTip(h);          // clic = affichage persistant, utile sur tablette
});
// La bulle est en position fixe : au défilement elle se décrocherait de l'icône.
addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason || 'erreur inconnue');
  toast(tr('toast.erreur-inattendue', { msg: msg }), true);
});

/* ---------- Langue (i18n) ----------
   La préférence vit à DEUX endroits, volontairement :
   - localStorage : pour appliquer la langue avant le premier rendu (comme le thème) ;
   - config.language en base : parce que le SERVEUR en a besoin — ses messages
     d’erreur sont affichés tels quels à l’utilisateur (i18n.md §2.1).
   Au changement, on recharge la page. C’est délibéré : re-traduire à chaud
   supposerait de re-rendre chaque vue dynamique déjà affichée ; un rechargement
   couvre tout, et l’onglet courant est de toute façon mémorisé. */

(function language() {
  document.documentElement.lang = I18Nrt.getLang();
  I18Nrt.applyStaticI18n();
  const sel = $("#langSelect");
  if (!sel) return;
  sel.value = I18Nrt.getLang();
  sel.addEventListener("change", async () => {
    const lang = sel.value;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* stockage indisponible */ }
    // On persiste AVANT de recharger, sinon le serveur resterait dans l’ancienne langue.
    try { await api("/config", { method: "PUT", body: { language: lang } }); }
    catch (e) { toast(explainError(e.message), true); return; }
    location.reload();
  });
})();


/* ---------- Onglet Git : opérations multi-dépôts + explorateur ----------
   Deux principes structurent cet écran :
   - on ne SAISIT un nom que s'il n'existe pas encore ; dès qu'il existe, on le
     CHOISIT dans une liste. Supprimer par saisie libre, répliqué sur N dépôts,
     c'est la faute de frappe qui touche juste sans qu'on s'en aperçoive ;
   - rien ne s'exécute sans aperçu. L'aperçu EST la confirmation. */

let gitTargets = [{}];          // [{ repo_id, ref, refs: [], name }]
let gitRefsCache = {};          // "repoId|kind" -> { refs, default }
let gitPreviewData = null;

const gitAction = () => ($('#gitAction') || {}).value || 'new_branch';
const gitIsDelete = () => /^delete_/.test(gitAction());
const gitIsTag = () => /_tag$/.test(gitAction());
// Le nom de la ref à créer est saisi soit UNE fois pour tout le lot (le cas
// courant), soit dans chaque ligne quand les conventions diffèrent d'un dépôt à
// l'autre. C'est la même opération, pas deux écrans : seule la saisie se déplace.
const gitSameName = () => { const c = $('#gitSameName'); return !c || c.checked; };
const gitPerProjectName = () => !gitIsDelete() && !gitSameName();

/* Quelles refs proposer pour l'action courante : on ne supprime des tags que dans
   « supprimer un tag » ; partout ailleurs on part d'une branche. */
function gitRefKind() {
  return gitIsTag() && gitIsDelete() ? 'tags' : 'branches';
}
// « Rechercher un tag » quand c'est un tag qu'on choisit : le libellé doit dire le vrai.
const gitRefSearchPh = () => tr(gitRefKind() === 'tags' ? 'git.refs.search-ph-tag' : 'git.refs.search-ph');

async function gitLoadRefs(repoId, kind) {
  const key = repoId + '|' + kind;
  if (gitRefsCache[key]) return gitRefsCache[key];
  const d = await api('/git/refs?repo_id=' + repoId + '&kind=' + kind);
  gitRefsCache[key] = d;
  return d;
}

function gitTargetRow(idx, sel) {
  // Dépôt : combo avec recherche (la liste peut compter des dizaines de projets).
  // L'input caché porte la classe `git-repo`, lu par la délégation 'change'.
  const repo = repoComboHtml(sel.repo_id, { idClass: 'git-repo' });
  /* À la suppression, la sélection est MULTIPLE : on coche ce qu'on supprime, avec un
     filtre au-dessus de la liste. Sinon c'est un choix unique — combo avec recherche,
     comme pour les dépôts : un dépôt actif compte souvent des centaines de branches,
     qu'aucune liste déroulante native ne rend parcourable. */
  const picker = gitIsDelete()
    ? '<div class="git-refs" data-row="' + idx + '"><span class="muted">' + esc(tr('git.refs.loading')) + '</span></div>'
    : comboHtml('git-ref', { ph: tr('git.refs.loading'), wrapClass: 'git-ref-combo' });
  // Nom par projet : le champ n'apparaît que si l'utilisateur a décoché « le même
  // pour tous ». Il porte son propre libellé accessible, la ligne n'en ayant pas.
  const nameLbl = gitIsTag() ? tr('git.lbl.tag-name') : tr('git.lbl.branch-name');
  const nameInput = gitPerProjectName()
    ? '<input class="git-name" data-row="' + idx + '" value="' + esc(sel.name || '') + '"' +
      ' placeholder="' + esc(gitIsTag() ? tr('git.ph.tag-name') : tr('git.ph.name')) + '"' +
      ' aria-label="' + esc(nameLbl) + '" title="' + esc(nameLbl) + '" />'
    : '';
  return '<div class="target-row git-row" data-row="' + idx + '">' +
    repo +
    picker +
    nameInput +
    '<button type="button" class="btn btn-icon btn-sm btn-danger" data-gitrm="' + idx + '" title="' + esc(tr('git.title.remove-row')) + '"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>' +
    '</div>';
}

async function gitFillRow(idx) {
  const row = $('#gitTargetRows .git-row[data-row="' + idx + '"]');
  if (!row) return;
  const repoId = Number(row.querySelector('.git-repo').value);
  if (!repoId) return;
  const kind = gitRefKind();
  let d;
  try { d = await gitLoadRefs(repoId, kind); }
  catch (e) {
    const box = row.querySelector('.git-refs, .git-ref');
    if (box) box.innerHTML = '<span class="t-err">' + esc(explainError(e.message)) + '</span>';
    return;
  }
  if (gitIsDelete()) {
    const box = row.querySelector('.git-refs');
    if (!box) return;
    // La branche par défaut et les refs protégées ne sont PAS proposées :
    // on ne peut pas cocher par erreur ce que le serveur refuserait ensuite.
    const sel = (gitTargets[idx] && gitTargets[idx].refs) || [];
    const list = d.refs.filter((r) => !r.default && !r.protected);
    const hidden = d.refs.length - list.length;
    /* Filtre au-dessus de la liste : un dépôt actif compte souvent des centaines de
       branches, et la liste défile dans 190 px de haut. Il MASQUE au lieu de reconstruire,
       pour que les cases déjà cochées survivent à la frappe — et qu'on puisse cocher,
       filtrer autre chose, cocher encore, puis tout supprimer d'un coup. */
    box.innerHTML = (list.length
      ? '<input type="search" class="search git-ref-filter" data-row="' + idx + '" placeholder="' + esc(gitRefSearchPh()) + '" aria-label="' + esc(gitRefSearchPh()) + '" />'
        + '<div class="git-ref-list">'
        + list.map((r) => '<label class="git-ref-item" data-name="' + esc(r.name.toLowerCase()) + '"><input type="checkbox" data-row="' + idx + '" value="' + esc(r.name) + '"' + (sel.includes(r.name) ? ' checked' : '') + ' />' +
          '<code>' + esc(r.name) + '</code>' + (r.merged ? '<span class="tag done">' + esc(tr('git.tag.merged')) + '</span>' : '') +
          '<span class="muted git-ref-date">' + (r.date ? fmtDate(r.date) : '') + '</span></label>').join('')
        + '<div class="muted git-ref-nomatch" hidden>' + esc(tr('git.refs.no-match')) + '</div></div>'
      : '<span class="muted">' + esc(tr('git.refs.none')) + '</span>')
      + (hidden ? '<div class="muted git-ref-hidden">' + esc(tr('git.refs.hidden', { n: hidden, count: hidden })) + '</div>' : '');
  } else {
    // Combo : la valeur retenue vit dans l'input CACHÉ (classe `git-ref`), le champ
    // visible n'en est que l'affichage — c'est lui qui accueille la recherche.
    const hidden2 = row.querySelector('.git-ref');
    const search = row.querySelector('[data-combo="git-ref"]');
    if (!hidden2 || !search) return;
    const cur = (gitTargets[idx] && gitTargets[idx].ref) || d.default || (d.refs[0] && d.refs[0].name) || '';
    hidden2.value = cur;
    hidden2.dataset.label = cur;
    search.value = cur;
    search.title = cur;
    search.placeholder = gitRefSearchPh();
    gitTargets[idx] = { ...gitTargets[idx], repo_id: repoId, ref: cur };
  }
}

function gitRenderTargets() {
  const el = $('#gitTargetRows');
  if (!el) return;
  el.innerHTML = gitTargets.map((t, i) => gitTargetRow(i, t)).join('');
  wireRepoCombos(el);
  /* Les refs sont chargées à l'OUVERTURE de la liste, pas au rendu de la ligne : rien ne
     dit que l'utilisateur va la dérouler, et `gitLoadRefs` met déjà en cache par dépôt. */
  wireCombo(el, 'git-ref', async (row) => {
    const repoId = Number(row.querySelector('.git-repo').value);
    if (!repoId) return [];
    const kind = gitRefKind();
    const d = await gitLoadRefs(repoId, kind);
    return d.refs.map((r) => ({ value: r.name, label: r.name, hint: r.default ? tr('git.refs.default-suffix') : '' }));
  });
  gitTargets.forEach((_, i) => gitFillRow(i));
}

function gitReadTargets() {
  return $$('#gitTargetRows .git-row').map((row) => {
    const idx = Number(row.dataset.row);
    const repo_id = Number(row.querySelector('.git-repo').value);
    if (!repo_id) return null;
    if (gitIsDelete()) {
      const refs = [...row.querySelectorAll('.git-refs input:checked')].map((i) => i.value);
      return refs.length ? { repo_id, refs } : null;
    }
    const s = row.querySelector('.git-ref');
    const out = { repo_id, ref: s ? s.value : '' };
    const nm = row.querySelector('.git-name');
    if (nm) out.name = nm.value.trim();   // absent = le nom global s'applique
    return out;
  }).filter(Boolean);
}

// Le nom global et les noms par projet ne coexistent jamais : l'un est saisi, les
// autres sont vides. On lit donc celui qui est effectivement à l'écran.
function gitNameBody(targets) {
  const body = { message: $('#gitTagMsg').value.trim() };
  if (gitPerProjectName()) {
    if (targets.some((t) => !t.name)) return null;   // une ligne sans nom = rien n'est prévisualisé
    return body;
  }
  body.name = $('#gitRefName').value.trim();
  return body;
}

/* Jette l'aperçu affiché. À appeler dès qu'une saisie ne correspond plus à ce que
   le tableau montre : l'exécution relit les CHAMPS, pas le tableau, donc laisser
   un aperçu périmé à l'écran reviendrait à faire confirmer autre chose que ce qui
   part réellement. */
function gitDropPreview() {
  const box = $('#gitPreviewBox');
  if (box) box.hidden = true;
  gitPreviewData = null;
}

// Le formulaire change de forme selon l'action : c'est le même écran, pas quatre.
function gitApplyAction() {
  const del = gitIsDelete();
  const tag = gitIsTag();
  $('#gitNameField').hidden = del;                  // on ne saisit rien pour supprimer
  $('#gitSameNameField').hidden = del;
  $('#gitNameRow').hidden = del || !gitSameName();  // saisi par projet → plus de champ global
  $('#gitMsgField').hidden = !(tag && !del);
  $('#gitTargetsLabel').textContent = del
    ? (tag ? tr('git.targets.tags-to-delete') : tr('git.targets.branches-to-delete'))
    : (tag ? tr('git.targets.tag-source') : tr('git.targets.source'));
  $('#gitNameLabel').textContent = tag ? tr('git.lbl.tag-name') : tr('git.lbl.branch-name');
  $('#gitSameNameLabel').textContent = tag ? tr('git.lbl.same-tag-all') : tr('git.lbl.same-name-all');
  $('#gitRefName').placeholder = tag ? tr('git.ph.tag-name') : tr('git.ph.name');
  gitDropPreview();
  // Les refs ne sont plus valides ; les noms saisis par projet, si.
  gitTargets = gitTargets.map((t) => ({ repo_id: t.repo_id, name: t.name }));
  gitRenderTargets();
}

/* Les clés sont écrites EN TOUTES LETTRES et non construites par concaténation :
   `tr('git.state.' + state)` fonctionnerait, mais rendrait la clé introuvable par
   recherche textuelle — et c'est précisément ce que vérifie npm run i18n:check. */
const GIT_STATE = {
  ok: { cls: 'ok', icon: svgIco('check'), key: 'git.state.ok' },
  exists: { cls: 'skip', icon: svgIco('right'), key: 'git.state.exists' },
  missing: { cls: 'warn', icon: svgIco('alert'), key: 'git.state.missing' },
  missing_source: { cls: 'warn', icon: svgIco('alert'), key: 'git.state.missing-source' },
  protected: { cls: 'warn', icon: svgIco('lock'), key: 'git.state.protected' },
  is_default: { cls: 'warn', icon: svgIco('lock'), key: 'git.state.is-default' },
  nothing_selected: { cls: 'warn', icon: '—', key: 'git.state.nothing-selected' },
  duplicate: { cls: 'warn', icon: svgIco('repeat'), key: 'git.state.duplicate' },
  error: { cls: 'err', icon: svgIco('close'), key: 'git.state.error' },
  done: { cls: 'ok', icon: svgIco('check'), key: 'git.state.done' },
};

function gitRenderPreview(pv) {
  gitPreviewData = pv;
  const box = $('#gitPreviewBox');
  const rows = pv.rows.map((r) => {
    const st = GIT_STATE[r.state] || { cls: '', icon: '', key: null };
    const label = st.key ? tr(st.key) : r.state;
    // À la création, la ref affichée est la SOURCE : le nom fabriqué est montré
    // à côté, ligne par ligne — c'est le seul endroit où l'on voit qu'un tag
    // diffère d'un projet à l'autre avant de l'écrire.
    const ref = (r.ref ? '<code>' + esc(r.ref) + '</code>' : '<span class="muted">—</span>')
      + (r.target ? ' <span class="muted git-pv-arrow">→</span> <code class="git-pv-target">' + esc(r.target) + '</code>' : '');
    const sha = r.sha ? '<span class="muted git-sha">' + esc(String(r.sha).slice(0, 8)) + '</span>' : '';
    const when = r.committed_date ? '<span class="muted">' + fmtDate(r.committed_date) + '</span>' : '';
    // La commande n'est affichée que sur les lignes qui vont s'exécuter : la
    // montrer sur une ligne bloquée laisserait croire qu'elle passe.
    const cmd = r.cmd ? '<tr class="git-cmd-row"><td></td><td colspan="2">' +
      (r.cmd.real || []).map((x) => '<div class="git-cmd git-cmd-real"><span class="git-cmd-tag">' + esc(tr('git.cmd.real')) + '</span><code>' + esc(x) + '</code></div>').join('') +
      '<div class="git-cmd"><span class="git-cmd-tag">' + esc(tr('git.cmd.equiv')) + '</span><code>' + esc(r.cmd.equiv) + '</code></div>' +
      '<div class="git-cmd git-cmd-api"><span class="git-cmd-tag">' + esc(tr('git.cmd.api')) + '</span><code>' + esc(r.cmd.api) + '</code></div>' +
      '</td></tr>' : '';
    return '<tr class="git-pv-' + st.cls + '"><td>' + esc(r.project) + '</td><td>' + ref + ' ' + sha + ' ' + when + '</td>' +
      '<td>' + st.icon + ' ' + esc(label) + (r.error ? ' <span class="muted">' + esc(r.error) + '</span>' : '') + '</td></tr>' + cmd;
  }).join('');
  const c2 = pv.counts;
  box.hidden = false;
  box.innerHTML = '<div class="box git-preview">' +
    '<h4>' + esc(tr('git.preview.title')) + '</h4>' +
    '<div class="md-tablewrap"><table class="md-table"><thead><tr>' +
      '<th>' + esc(tr('git.col.project')) + '</th><th>' + esc(tr('git.col.ref')) + '</th><th>' + esc(tr('git.col.result')) + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<p class="muted git-pv-counts">' + esc(tr('git.preview.counts', { ok: c2.ok, skipped: c2.skipped, blocked: c2.blocked })) + '</p>' +
    (c2.ok ? '<p class="muted git-pv-legend">' + esc(tr('git.cmd.legend')) + '</p>' : '') +
    (gitIsDelete() && c2.ok ? '<p class="muted git-pv-safe">' + esc(tr('git.preview.safety')) + '</p>' : '') +
    '<div class="form-actions">' +
      '<button id="gitCancel" class="btn">' + esc(tr('ui.cancel')) + '</button>' +
      '<button id="gitRun" class="btn ' + (gitIsDelete() ? 'btn-danger' : 'btn-primary') + '"' + (c2.ok ? '' : ' disabled') + '>' +
        '<svg class="ico"><use href="#i-play"/></svg>' + esc(tr('git.btn.execute', { n: c2.ok, count: c2.ok })) + '</button>' +
    '</div></div>';
  $('#gitCancel').addEventListener('click', () => { box.hidden = true; });
  $('#gitRun').addEventListener('click', gitExecute);
}

async function gitDoPreview() {
  const btn = $('#gitPreview');
  const targets = gitReadTargets();
  if (!targets.length) { toast(tr('err.git.no-target'), true); return; }
  const body = { action: gitAction(), targets };
  if (!gitIsDelete()) {
    const names = gitNameBody(targets);
    if (!names) { toast(tr('err.git.name-per-project'), true); return; }
    Object.assign(body, names);
  }
  try { gitRenderPreview(await busy(btn, () => api('/git/preview', { method: 'POST', body }))); }
  catch (e) { toast(explainError(e.message), true); }
}

async function gitExecute() {
  if (!gitPreviewData) return;
  const n = gitPreviewData.counts.ok;
  if (gitIsDelete() && !await confirmDialog({ text: tr('confirm.git-delete', { n, count: n }), confirmLabel: tr('ui.delete') })) return;
  const targets = gitReadTargets();
  const body = { action: gitAction(), targets };
  if (!gitIsDelete()) {
    const names = gitNameBody(targets);
    if (!names) { toast(tr('err.git.name-per-project'), true); return; }
    Object.assign(body, names);
  }
  try {
    await api('/git/execute', { method: 'POST', body });
    toast(tr('toast.git-started'));
    $('#gitPreviewBox').hidden = true;
    gitRefsCache = {};                    // les refs ont changé
    refreshStatus();
  } catch (e) { toast(explainError(e.message), true); }
}

/* ---- Explorateur de branches ---- */
function gitOriginCell(b) {
  if (!b.origin) return '<span class="muted">—</span>';
  const name = '<code>' + esc(b.origin) + '</code>';
  if (b.origin_confidence === 'certain') return name;
  // Une origine inférée ne doit JAMAIS avoir l'air d'un fait : italique + intitulé.
  const alt = b.origin_alternatives && b.origin_alternatives.length
    ? ' ' + tr('git.origin.alt', { list: b.origin_alternatives.join(', ') }) : '';
  const lbl = b.origin_confidence === 'ambiguous' ? tr('git.origin.ambiguous') : tr('git.origin.inferred');
  return '<em class="git-inferred" title="' + esc(lbl + alt) + '">' + name + ' <span class="muted">(' + esc(lbl) + ')</span></em>';
}

// Branche(s) portant un tag (commit contenu). Serveur = branche par défaut d'abord.
// On en montre quelques-unes en pastilles, le reste replié en « +N ».
function tagBranchesHtml(branches, all) {
  const list = Array.isArray(branches) ? branches : [];
  if (!list.length) return '<span class="muted">—</span>';
  if (all) return list.map((b) => `<span class="tag">${esc(b)}</span>`).join(' ');
  const shown = list.slice(0, 3).map((b) => `<span class="tag">${esc(b)}</span>`).join(' ');
  const extra = list.length - 3;
  return shown + (extra > 0 ? ` <span class="muted" title="${esc(list.join(', '))}">+${extra}</span>` : '');
}

// Liste des tags, triée par date de création décroissante (fournie triée par le serveur).
function gitTagsHtml(tags, repoId) {
  if (!tags.length) return `<div class="git-tags"><h4>${esc(tr('git.tags.title'))}</h4><p class="muted">${esc(tr('git.tags.none'))}</p></div>`;
  return `<div class="git-tags"><h4>${esc(tr('git.tags.title', { n: tags.length, count: tags.length }))}</h4>`
    + '<div class="md-tablewrap"><table class="md-table"><thead><tr>'
    + `<th>${esc(tr('git.tags.col.name'))}</th><th>${esc(tr('git.tags.col.date'))}</th><th>${esc(tr('git.tags.col.branches'))}</th><th>${esc(tr('git.tags.col.author'))}</th><th>${esc(tr('git.tags.col.type'))}</th><th>${esc(tr('git.tags.col.message'))}</th>`
    + '</tr></thead><tbody>'
    + tags.map((tg) => `<tr><td><code>${esc(tg.name)}</code></td>`
      + `<td class="muted">${tg.committed_date ? fmtDate(tg.committed_date) : '—'}</td>`
      + `<td class="git-tag-branches">${tagBranchesHtml(tg.branches)}</td>`
      + `<td class="git-tag-author"><span class="muted">${tg.author ? esc(tg.author) : '—'}</span> `
        + `<button type="button" class="btn btn-sm btn-ghost" data-tagauthor="${esc(tg.name)}" data-repo="${repoId}" title="${esc(tr('git.tags.fetch-author-title'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('git.tags.fetch-author'))}</button></td>`
      + `<td>${tg.annotated ? `<span class="tag">${esc(tr('git.tags.annotated'))}</span>` : `<span class="muted">${esc(tr('git.tags.lightweight'))}</span>`}</td>`
      + `<td class="muted git-tag-msg">${esc((tg.message || '').split('\n')[0].slice(0, 80))}</td></tr>`).join('')
    + '</tbody></table></div></div>';
}

// Rend l'explorateur d'UN dépôt dans le conteneur `box` (scopé : plusieurs dépôts
// peuvent être affichés en parallèle, chacun dans son bloc).
function gitRenderExplorer(d, box) {
  // Tri : dernier commit le plus récent d'abord (les branches sans date en dernier).
  const rows = [...d.branches].sort((a, b) => (b.committed_date ? new Date(b.committed_date).getTime() : -Infinity) - (a.committed_date ? new Date(a.committed_date).getTime() : -Infinity));
  /* Filtre au-dessus du tableau : c'est aussi une liste où l'on CHOISIT des branches
     (les cases servent à la suppression groupée), et un dépôt actif en compte des
     centaines. Comme ailleurs, il masque des lignes sans toucher aux cases cochées. */
  box.innerHTML = '<input type="search" class="search git-ex-filter" placeholder="' + esc(tr('git.refs.search-ph')) + '" aria-label="' + esc(tr('git.refs.search-ph')) + '" />' +
    '<div class="md-tablewrap"><table class="md-table git-explorer"><thead><tr>' +
    '<th></th><th>' + esc(tr('git.col.branch')) + '</th><th>' + esc(tr('git.col.vs-default')) + '</th>' +
    '<th>' + esc(tr('git.col.origin')) + '</th><th>' + esc(tr('git.col.merged-into')) + '</th><th>' + esc(tr('git.col.last-commit')) + '</th><th></th>' +
    '</tr></thead><tbody>' + rows.map((b) => {
      const stale = !b.default && b.committed_date && (Date.now() - new Date(b.committed_date).getTime()) > 90 * 86400000;
      const cleanable = !b.default && b.merged_into && (b.ahead === 0);
      const pick = b.default || b.protected ? '' :
        '<input type="checkbox" class="git-ex-pick" value="' + esc(b.name) + '" />';
      const ab = b.default ? '<span class="muted">—</span>'
        : '<span class="git-ab">' + (b.ahead ? '↑' + b.ahead : '') + (b.behind ? ' <strong class="git-behind">↓' + b.behind + '</strong>' : (b.ahead ? '' : '=')) + '</span>';
      const merged = b.merged_into
        ? '<code>' + esc(b.merged_into) + '</code>' + (b.merged_mr ? ' <a href="' + esc(b.merged_mr.url) + '" target="_blank">!' + b.merged_mr.iid + '</a>' : '')
        : '<span class="muted">—</span>';
      // « Créer la MR » entre la branche et sa SOURCE : cible = l'origine déduite,
      // sinon la branche par défaut. Proposé seulement si la branche a des commits
      // d'avance, n'est pas la branche par défaut, ET n'a pas déjà une MR ouverte.
      // Si une MR ouverte existe, on montre le lien vers elle à la place du bouton.
      const mrTarget = (b.origin && b.origin !== b.name) ? b.origin : d.default;
      const canMr = !b.default && b.ahead > 0 && mrTarget && mrTarget !== b.name && !b.open_mr;
      const mrBtn = b.open_mr
        ? '<a class="btn btn-sm" href="' + esc(b.open_mr.url) + '" target="_blank" title="' + esc(tr('git.mr.open-title', { target: b.open_mr.target })) + '"><svg class="ico ico-sm"><use href="#i-branch"/></svg>!' + b.open_mr.iid + ' ↗</a>'
        : (canMr
          ? '<button class="btn btn-sm" data-gitmr="' + esc(b.name) + '" data-target="' + esc(mrTarget) + '" title="' + esc(tr('git.mr.title', { target: mrTarget })) + '"><svg class="ico ico-sm"><use href="#i-branch"/></svg>' + esc(tr('git.btn.create-mr')) + '</button>'
          : '');
      return '<tr' + (b.default ? ' class="git-ex-default"' : '') + '><td>' + pick + '</td>' +
        '<td><code>' + esc(b.name) + '</code>' + (b.default ? ' <span class="tag">' + esc(tr('git.tag.default')) + '</span>' : '') +
          (b.protected ? ' <span class="tag stale">' + esc(tr('git.tag.protected')) + '</span>' : '') +
          (cleanable ? ' ' + svgIco('trash') : '') + (stale && !b.merged_into ? ' ' + svgIco('alert') : '') + '</td>' +
        '<td>' + ab + '</td><td>' + gitOriginCell(b) + '</td><td>' + merged + '</td>' +
        '<td class="muted">' + (b.committed_date ? fmtDate(b.committed_date) : '—') + (b.author ? ' · ' + esc(b.author) : '') + '</td>' +
        '<td class="git-ex-actions">' + mrBtn + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    '<p class="muted git-ex-nomatch" hidden>' + esc(tr('git.refs.no-match')) + '</p>' +
    '<div class="form-actions"><button class="btn btn-danger git-ex-delete" disabled><svg class="ico"><use href="#i-trash"/></svg>' + esc(tr('git.btn.delete-selected')) + '</button>' +
    '<span class="muted git-ex-count"></span></div>' +
    gitTagsHtml(d.tags || [], d.repo_id);

  const filter = $('.git-ex-filter', box);
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const tr_ of $$('.git-explorer tbody tr', box)) {
      const name = (tr_.querySelector('code') || {}).textContent || '';
      const hit = !q || name.toLowerCase().includes(q);
      tr_.hidden = !hit;
      if (hit) shown += 1;
    }
    $('.git-ex-nomatch', box).hidden = shown > 0;
  });

  const refresh = () => {
    const n = $$('.git-ex-pick:checked', box).length;
    $('.git-ex-delete', box).disabled = !n;
    $('.git-ex-count', box).textContent = n ? tr('git.explorer.selected', { n, count: n }) : '';
  };
  $$('.git-ex-pick', box).forEach((cb) => cb.addEventListener('change', refresh));
  /* « Créer la MR » : même modale que Dev IA, mais entre la branche et sa source.
     L'intro rappelle source → cible, car la cible est une origine DÉDUITE : on la
     montre pour pouvoir renoncer. */
  $$('[data-gitmr]', box).forEach((b) => b.addEventListener('click', () => {
    const source = b.dataset.gitmr;
    const target = b.dataset.target;
    openMrModal({
      url: '/git/mr', body: { repo_id: d.repo_id, source, target },
      title: source, source, target, forge: d.forge,
      onDone: (r) => {
        // Remplace le bouton par le lien vers la MR : l'écran reflète la réalité
        // sans re-analyser tout le dépôt (coûteux).
        b.outerHTML = '<a class="btn btn-sm" href="' + esc(r.url) + '" target="_blank" title="' + esc(tr('git.mr.open-title', { target })) + '"><svg class="ico ico-sm"><use href="#i-branch"/></svg>!' + r.iid + ' ↗</a>';
      },
    });
  }));
  // Le pont entre les deux écrans : c'est le parcours réel du nettoyage.
  $('.git-ex-delete', box).addEventListener('click', () => {
    const refs = $$('.git-ex-pick:checked', box).map((c2) => c2.value);
    $('#gitAction').value = 'delete_branch';
    gitApplyAction();
    gitTargets = [{ repo_id: d.repo_id, refs }];
    showGitSub('actions');
    gitRenderTargets();
    setTimeout(gitDoPreview, 400);   // laisse les refs se charger
  });

  // « Auteur du tag » : appel dédié à la demande (le tagger d'un tag annoté).
  $$('[data-tagauthor]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      const info = await busy(b, () => api(`/git/tag-author?repo_id=${b.dataset.repo}&tag=${encodeURIComponent(b.dataset.tagauthor)}`));
      const author = (info.found && info.author) ? esc(info.author) : '—';
      const badge = info.found && info.author
        ? (info.annotated ? `<span class="tag">${esc(tr('git.tags.tagger'))}</span>` : `<span class="muted">${esc(tr('git.tags.lightweight'))}</span>`)
        : '';
      b.outerHTML = `<span class="git-tagger">${author} ${badge}</span>`;
    } catch (e) { toast(explainError(e.message), true); }
  }));
}

async function gitAnalyze() {
  // Multi-projets : on analyse tous les dépôts cochés. Chaque résultat va dans son
  // propre bloc <details>, REPLIÉ par défaut (on ouvre celui qu'on veut inspecter).
  const ids = $$('#gitExploreRepoBox .git-multi-pick:checked').map((c) => Number(c.value));
  if (!ids.length) { toast(tr('git.explorer.pick-one'), true); return; }
  const btn = $('#gitExploreGo');
  const wrap = $('#gitExploreBox');
  $('#gitExploreInfo').textContent = tr('git.explorer.analyzing');
  /* Chaque dépôt annonce son ÉTAT dans son propre en-tête. Le squelette du corps ne se voyait
     pas : les blocs naissent repliés, et un clone peut durer une minute — on cliquait
     « Analyser » sans plus rien voir bouger. L'analyse étant séquentielle, on distingue ce
     qui ATTEND de ce qui TOURNE : sur trois dépôts cochés, on veut savoir lequel travaille. */
  wrap.innerHTML = ids.map((id) => {
    const repo = repoOptions.find((r) => r.id === id);
    return `<details class="git-ex-project" data-repo="${id}">
        <summary><span class="git-ex-proj-name">${esc(repo ? repo.project : id)}</span> <span class="git-ex-proj-info muted">${esc(tr('git.explorer.pending'))}</span></summary>
        <div class="git-ex-proj-body">${skeleton(2)}</div>
      </details>`;
  }).join('');
  try {
    // Séquentiel : un clone/fetch à la fois, comme le reste de l'app (ménage les I/O).
    await busy(btn, async () => {
      for (const id of ids) {
        const details = $(`.git-ex-project[data-repo="${id}"]`, wrap);
        const body = $('.git-ex-proj-body', details);
        const info = $('.git-ex-proj-info', details);
        info.innerHTML = `<span class="spin"></span> ${esc(tr('git.explorer.running'))}`;
        try {
          const d = await api('/git/branches?repo_id=' + id);
          info.textContent = tr('git.explorer.count', { n: d.branches.length, count: d.branches.length, def: d.default });
          body.innerHTML = '';
          gitRenderExplorer(d, body);
        } catch (e) {
          info.textContent = '';
          body.innerHTML = errorBox(e.message);
          // Une erreur reste invisible dans un bloc replié : on l'ouvre pour la montrer.
          details.open = true;
        }
      }
    });
  } finally {
    $('#gitExploreInfo').textContent = '';
  }
}

/* ---- Trouver une ref (tag ou branche) dans tous les dépôts ---- */
// Branches portant le tag, chacune avec la date de SON dernier commit. Un ✓ signale que
// le tag pointe justement ce dernier commit (comparé à la « Date » du tag, colonne voisine).
function findRefBranchesHtml(branches) {
  const list = Array.isArray(branches) ? branches : [];
  if (!list.length) return '<span class="muted">—</span>';
  return '<div class="findref-branches">' + list.map((b) => {
    const name = typeof b === 'string' ? b : (b && b.name) || '';
    const date = b && b.tipDate ? fmtDate(b.tipDate) : '—';
    const tip = b && b.isTip;
    return `<div class="findref-branch"><span class="tag">${esc(name)}</span>`
      + `<span class="muted" title="${esc(tr('git.findref.branch-tip-date'))}">${date}</span>`
      + (tip ? `<span class="findref-tip" title="${esc(tr('git.findref.on-tip'))}">${svgIco('check')}</span>` : '')
      + '</div>';
  }).join('') + '</div>';
}
async function findRefSearch(e) {
  if (e) e.preventDefault();
  const name = $('#findRefName').value.trim();
  if (!name) return;
  const type = $('#findRefType').value;
  const btn = $('#findRefGo');
  $('#findRefInfo').textContent = tr('git.findref.searching');
  $('#findRefBox').innerHTML = skeleton(3);
  let d;
  try { d = await busy(btn, () => api(`/git/find-ref?name=${encodeURIComponent(name)}&type=${type}`)); }
  catch (err) { $('#findRefInfo').textContent = ''; $('#findRefBox').innerHTML = errorBox(err.message); return; }

  const found = d.repos.filter((r) => r.matches.length);
  const errored = d.repos.filter((r) => r.error && !r.matches.length);
  $('#findRefInfo').textContent = tr('git.findref.count', { found: found.length, total: d.repos.length, name: d.name });

  const typeBadge = (k) => `<span class="tag">${esc(k === 'tag' ? tr('git.findref.tag') : tr('git.findref.branch'))}</span>`;
  let html = found.length
    ? '<div class="md-tablewrap"><table class="md-table"><thead><tr>'
      + `<th>${esc(tr('stats.col.project'))}</th><th>${esc(tr('git.findref.col.type'))}</th><th>${esc(tr('git.findref.col.commit'))}</th><th>${esc(tr('git.findref.col.tagdate'))}</th><th>${esc(tr('git.findref.col.branchdate'))}</th><th>${esc(tr('git.tags.col.author'))}</th><th>${esc(tr('git.tags.fetch-author'))}</th></tr></thead><tbody>`
      + found.map((r) => r.matches.map((m) => `<tr><td>${esc(r.project)}</td>`
        + `<td>${typeBadge(m.kind)}</td>`
        + `<td>${m.url ? `<a href="${esc(m.url)}" target="_blank"><code>${esc(m.sha || d.name)}</code> ↗</a>` : `<code>${esc(m.sha)}</code>`}</td>`
        + `<td class="muted">${m.date ? fmtDate(m.date) : '—'}</td>`
        + `<td>${m.kind === 'tag' ? findRefBranchesHtml(m.branches) : '<span class="muted">—</span>'}</td>`
        + `<td class="muted">${esc(m.author || '—')}</td>`
        + `<td class="git-tag-author">${m.kind === 'tag'
          ? `<button type="button" class="btn btn-sm btn-ghost" data-findref-author="${esc(d.name)}" data-repo="${r.repo_id}" title="${esc(tr('git.tags.fetch-author-title'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('git.tags.fetch-author'))}</button>`
          : '<span class="muted">—</span>'}</td></tr>`).join('')).join('')
      + '</tbody></table></div>'
    : emptyState({ icon: 'search', title: tr('git.findref.none.title', { name: esc(d.name) }), text: tr('git.findref.none.text') });
  if (errored.length) {
    html += `<p class="muted" style="margin-top:8px">${svgIco('alert')} ${tr('git.findref.errors', { n: errored.length, count: errored.length })} : ${errored.map((r) => esc(r.project)).join(', ')}</p>`;
  }
  $('#findRefBox').innerHTML = html;
  // Auteur PRÉCIS du tag à la demande (le tagger annoté n'est pas dans l'API GitLab).
  $$('[data-findref-author]', $('#findRefBox')).forEach((b) => b.addEventListener('click', async () => {
    try {
      const info = await busy(b, () => api(`/git/tag-author?repo_id=${b.dataset.repo}&tag=${encodeURIComponent(b.dataset.findrefAuthor)}`));
      const author = (info.found && info.author) ? esc(info.author) : '—';
      const badge = info.found && info.author
        ? (info.annotated ? `<span class="tag">${esc(tr('git.tags.tagger'))}</span>` : `<span class="muted">${esc(tr('git.tags.lightweight'))}</span>`)
        : '';
      b.outerHTML = `<span class="git-tagger">${author} ${badge}</span>`;
    } catch (e) { toast(explainError(e.message), true); }
  }));
}
$('#findRefForm') && $('#findRefForm').addEventListener('submit', findRefSearch);

/* ---- Historique et restauration ---- */
const GIT_ACTION_LABEL = () => ({
  new_branch: tr('git.action.new_branch'), create_tag: tr('git.action.create_tag'),
  delete_branch: tr('git.action.delete_branch'), delete_tag: tr('git.action.delete_tag'),
});
async function gitLoadHistory() {
  const el = $('#gitHistoryBox');
  let rows;
  try { rows = await api('/git/ops'); } catch (e) { el.innerHTML = errorBox(e.message); return; }
  if (!rows.length) { el.innerHTML = emptyState({ icon: 'clock', title: tr('git.history.empty.title'), text: tr('git.history.empty.text') }); return; }
  const L = GIT_ACTION_LABEL();
  el.innerHTML = rows.map((o) => '<div class="card git-op">' +
    '<div class="report-main"><div class="title">' + esc(L[o.action] || o.action) + ' · <code>' + esc(o.ref_name) + '</code></div>' +
    '<div class="meta">' + esc(o.project) + ' · ' + fmtDateTime(o.created_at) + (o.ref_sha ? ' · <span class="git-sha">' + esc(o.ref_sha.slice(0, 8)) + '</span>' : '') + '</div></div>' +
    '<span class="spacer"></span>' +
    (o.status === 'error' ? '<span class="tag stale" title="' + esc(o.error || '') + '">' + esc(tr('git.op.failed')) + '</span>' : '') +
    (o.restored_at ? '<span class="tag done">' + esc(tr('git.op.restored')) + '</span>' : '') +
    (o.restorable ? '<button class="btn btn-sm" data-gitrestore="' + o.id + '" title="' + esc(tr('git.title.restore')) + '"><svg class="ico ico-sm"><use href="#i-reset"/></svg>' + esc(tr('git.btn.restore')) + '</button>' : '') +
    '</div>').join('');
  $$('#gitHistoryBox [data-gitrestore]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('confirm.git-restore'), confirmLabel: tr('git.op.restore'), danger: false })) return;
    try {
      await busy(b, () => api('/git/ops/' + b.dataset.gitrestore + '/restore', { method: 'POST' }));
      toast(tr('toast.git-restore-started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
}

/* ---- Navigation : positionner des projets LOCAUX sur une branche distante ----
   Un répertoire local en haut, N lignes (projet, branche) en dessous. La branche
   COURANTE de chaque projet est affichée à côté du sélecteur : sans elle, on choisit
   à l'aveugle et on ne sait pas si l'opération a changé quoi que ce soit.
   Rien n'est jeté : le bilan dit projet par projet ce qui est passé, ce qui a échoué,
   et quels fichiers modifiés ont été emportés d'une branche à l'autre. */
let navRootId = '';                 // répertoire local courant
let navTargets = [{}];              // [{ name, branch, current }]
const navBranchCache = new Map();   // "rootId|projet" -> { branches, current }

async function navBranchesOf(rootId, name) {
  const key = `${rootId}|${name}`;
  if (!navBranchCache.has(key)) {
    // La promesse est mémoïsée : focus puis frappe ouvrent la liste deux fois de
    // suite, et chaque ouverture déclencherait sinon un `git fetch` complet.
    navBranchCache.set(key, api(`/local-projects/branches?root_id=${encodeURIComponent(rootId)}&name=${encodeURIComponent(name)}`));
  }
  try { return await navBranchCache.get(key); }
  catch (e) { navBranchCache.delete(key); throw e; }
}

function navDropResult() {
  const box = $('#navResultBox');
  if (box) box.hidden = true;
}

function navRenderRoot() {
  const box = $('#navRootBox');
  if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<span class="muted">${esc(tr('git.navigate.no-root'))}</span>`; return; }
  const cur = localRoots.find((r) => String(r.id) === String(navRootId)) || localRoots[0];
  navRootId = String(cur.id);
  box.innerHTML = comboHtml('nav-root', { value: cur.id, label: rootLabel(cur), ph: tr('git.navigate.ph.root') });
  wireCombo(box, 'nav-root', () => localRoots.map((r) => ({ value: r.id, label: rootLabel(r) })));
  $('.nav-root', box).addEventListener('change', (e) => {
    navRootId = e.target.value;
    navTargets = [{}];        // les projets choisis appartenaient à l'autre répertoire
    navDropResult();
    navRenderTargets();
  });
}

function navCurrentLabel(t) {
  return t.current ? tr('git.navigate.current', { branch: t.current }) : '';
}

function navTargetRow(idx, sel) {
  const cur = navCurrentLabel(sel);
  return `<div class="target-row nav-row" data-row="${idx}">
    ${comboHtml('nav-project', { value: sel.name || '', label: sel.name || '', ph: tr('git.navigate.ph.project') })}
    <span class="nav-current muted" title="${esc(cur)}">${esc(cur)}</span>
    ${comboHtml('nav-branch', { value: sel.branch || '', label: sel.branch || '', ph: tr('git.navigate.ph.branch') })}
    <button type="button" class="btn btn-icon btn-sm btn-danger" data-navrm="${idx}" title="${esc(tr('git.navigate.remove-row'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>
  </div>`;
}

function navRenderTargets() {
  const el = $('#navTargetRows');
  if (!el) return;
  if (!localRoots.length) { el.innerHTML = `<p class="muted">${esc(tr('git.navigate.no-root'))}</p>`; return; }
  el.innerHTML = navTargets.map((t, i) => navTargetRow(i, t)).join('');
  // Seuls les dossiers qui SONT des dépôts git sont proposés : proposer les autres
  // reviendrait à laisser choisir une ligne qui échouera forcément au checkout.
  wireCombo(el, 'nav-project', async () => (await localProjectsOf(navRootId))
    .filter((p) => p.git)
    .map((p) => ({ value: p.name, label: p.name, hint: p.branch ? `· ${p.branch}` : '' })));
  wireCombo(el, 'nav-branch', async (row) => {
    const name = row.querySelector('.nav-project').value;
    if (!name) throw new Error(tr('git.navigate.pick-project-first'));
    const d = await navBranchesOf(navRootId, name);
    return d.branches.map((b) => ({ value: b.name, label: b.name, hint: b.date ? fmtDate(b.date) : '' }));
  });
}

function navReadTargets() {
  return $$('#navTargetRows .nav-row').map((row) => ({
    root_id: Number(navRootId),
    name: row.querySelector('.nav-project').value,
    branch: row.querySelector('.nav-branch').value,
  })).filter((t) => t.name);
}

const NAV_STATE = {
  done: { cls: 'ok', icon: svgIco('check'), key: 'git.navigate.state.done' },
  done_dirty: { cls: 'warn', icon: svgIco('alert'), key: 'git.navigate.state.done-dirty' },
  already: { cls: 'ok', icon: svgIco('check'), key: 'git.navigate.state.already' },
  already_dirty: { cls: 'warn', icon: svgIco('alert'), key: 'git.navigate.state.already-dirty' },
  error: { cls: 'err', icon: svgIco('close'), key: 'git.navigate.state.error' },
};

function navRenderResult(d) {
  const box = $('#navResultBox');
  const rows = d.results.map((r) => {
    const st = NAV_STATE[r.state] || { cls: '', icon: '', key: null };
    const notes = [
      r.error ? `<div class="t-err">${esc(r.error)}</div>` : '',
      (r.from && r.from !== r.branch && r.state !== 'error') ? `<div class="muted">${esc(tr('git.navigate.from', { branch: r.from }))}</div>` : '',
      r.fetch_error ? `<div class="muted">${esc(tr('git.navigate.fetch-failed', { error: r.fetch_error }))}</div>` : '',
      r.ff_error ? `<div class="muted">${esc(tr('git.navigate.ff-failed', { error: r.ff_error }))}</div>` : '',
      r.local_only ? `<div class="muted">${esc(tr('git.navigate.local-only'))}</div>` : '',
      /* La LISTE des fichiers, pas seulement leur nombre : c'est elle qui dit ce qu'on
         emporte d'une branche à l'autre — un compte ne permet pas de le vérifier. */
      (r.files && r.files.length) ? `<details class="nav-files"><summary>${esc(tr('git.navigate.files', { n: r.files.length, count: r.files.length }))}</summary>`
        + `<ul>${r.files.map((f) => `<li><code>${esc(f.code)}</code> ${esc(f.file)}</li>`).join('')}</ul></details>` : '',
    ].join('');
    return `<tr class="git-pv-${st.cls}"><td>${esc(r.project)}</td><td><code>${esc(r.branch || '—')}</code></td>`
      + `<td>${st.icon} ${esc(st.key ? tr(st.key) : r.state)}${notes}</td></tr>`;
  }).join('');
  box.hidden = false;
  box.innerHTML = `<div class="box git-preview">
    <h4>${esc(tr('git.navigate.result'))}</h4>
    <div class="md-tablewrap"><table class="md-table"><thead><tr>
      <th>${esc(tr('git.col.project'))}</th><th>${esc(tr('git.col.branch'))}</th><th>${esc(tr('git.navigate.col.state'))}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted git-pv-counts">${esc(tr('git.navigate.counts', d.counts))}</p>
  </div>`;
}

async function navCheckout() {
  const btn = $('#navGo');
  const targets = navReadTargets();
  if (!targets.length) { toast(tr('err.navigate.no-target'), true); return; }
  // On refuse AVANT l'appel : une ligne sans branche ne produirait qu'une erreur de
  // plus dans le bilan, alors que c'est une saisie incomplète, pas un échec git.
  if (targets.some((t) => !t.branch)) { toast(tr('git.navigate.select-branch'), true); return; }
  $('#navInfo').textContent = tr('git.navigate.running');
  try {
    const d = await busy(btn, () => api('/navigate/checkout', { method: 'POST', body: { targets } }));
    navRenderResult(d);
    toast(tr('toast.navigate-done', { done: d.counts.done, failed: d.counts.failed }), d.counts.failed > 0);
    // Les branches courantes viennent de changer : le cache les décrirait à tort.
    localProjectsCache.delete(String(navRootId));
    navBranchCache.clear();
    for (const r of d.results) {
      const i = navTargets.findIndex((t) => t.name === r.project);
      if (i >= 0 && r.state !== 'error') navTargets[i] = { ...navTargets[i], current: r.branch };
    }
    navRenderTargets();
  } catch (e) { toast(explainError(e.message), true); }
  finally { $('#navInfo').textContent = ''; }
}

$('#navAddTarget') && $('#navAddTarget').addEventListener('click', () => { navTargets.push({}); navDropResult(); navRenderTargets(); });
$('#navGo') && $('#navGo').addEventListener('click', navCheckout);
document.addEventListener('change', (e) => {
  const row = e.target.closest && e.target.closest('.nav-row');
  if (!row) return;
  const i = Number(row.dataset.row);
  if (e.target.classList.contains('nav-project')) {
    const name = e.target.value;
    navTargets[i] = { name, current: localProjectBranch(navRootId, name) };
    // Changer de projet invalide la branche choisie : elle appartenait à l'autre dépôt.
    const hidden = row.querySelector('.nav-branch');
    if (hidden) { hidden.value = ''; hidden.dataset.label = ''; }
    const search = row.querySelector('[data-combo="nav-branch"]');
    if (search) { search.value = ''; search.title = ''; }
    const cell = row.querySelector('.nav-current');
    if (cell) { cell.textContent = navCurrentLabel(navTargets[i]); cell.title = cell.textContent; }
  }
  if (e.target.classList.contains('nav-branch')) navTargets[i] = { ...navTargets[i], branch: e.target.value };
  navDropResult();
});
document.addEventListener('click', (e) => {
  const rm = e.target.closest && e.target.closest('[data-navrm]');
  if (!rm) return;
  const i = Number(rm.dataset.navrm);
  if (navTargets.length > 1) { navTargets.splice(i, 1); navDropResult(); navRenderTargets(); }
});

function showGitSub(name) {
  $$('#tab-git .subnav [data-gsub]').forEach((b) => b.classList.toggle('active', b.dataset.gsub === name));
  $$('#tab-git .subtab').forEach((s) => s.classList.toggle('active', s.id === 'gsub-' + name));
  try { localStorage.setItem('aidevtools_gitsub', name); } catch { /* stockage indisponible */ }
  if (name === 'history') gitLoadHistory();
  if (name === 'commands') loadGitCommands();
}

// Explorateur : sélection MULTIPLE de dépôts (cases à cocher) avec recherche à la frappe
// (le nombre de dépôts peut être élevé). Pas de présélection : on n'analyse rien sans choix.
function renderGitExploreRepos() {
  const box = $('#gitExploreRepoBox');
  if (!box) return;
  const items = repoOptions.map((r) =>
    `<label class="repo-multi-item"><input type="checkbox" class="git-multi-pick" value="${r.id}" /> <span>${esc(r.project)}</span></label>`).join('');
  box.innerHTML = `<input class="repo-multi-search" type="search" placeholder="${esc(tr('git.explorer.search-ph'))}" />
    <div class="repo-multi-list">${items || `<span class="muted">${esc(tr('settings.repo.empty.title'))}</span>`}</div>`;
  const search = $('.repo-multi-search', box);
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase().trim();
    $$('.repo-multi-item', box).forEach((it) => { it.hidden = !!q && !$('span', it).textContent.toLowerCase().includes(q); });
  });
}

async function loadGit() {
  await loadRepoOptions();
  await loadLocalRoots();
  renderGitExploreRepos();
  navRenderRoot();
  navRenderTargets();
  gitRenderTargets();
  let sub = 'actions';
  try { sub = localStorage.getItem('aidevtools_gitsub') || 'actions'; } catch { /* stockage indisponible */ }
  showGitSub(sub);
}

$$('#tab-git .subnav [data-gsub]').forEach((b) => b.addEventListener('click', () => showGitSub(b.dataset.gsub)));
$('#gitAction').addEventListener('change', gitApplyAction);

/* ============ Git · Commandes multi-projets (onglet « Commandes Git ») ============
 * Choisir un répertoire local → cocher des projets → une commande git (palette ou libre) →
 * prévisualiser → exécuter à la racine de chacun → sortie par projet. Réutilise localRoots /
 * localProjectsOf de la Navigation. Palette alimentée par Réglages → Git (/git-commands). */
const CMD = { rootId: null, selected: new Set(), palette: [], projects: [] };

function cmdRenderRoot() {
  const box = $('#cmdRootBox'); if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<span class="muted">${esc(tr('git.navigate.no-root'))}</span>`; $('#cmdProjectBox').innerHTML = ''; return; }
  const cur = localRoots.find((r) => String(r.id) === String(CMD.rootId)) || localRoots[0];
  CMD.rootId = String(cur.id);
  box.innerHTML = comboHtml('cmd-root', { value: cur.id, label: rootLabel(cur), ph: tr('git.navigate.ph.root') });
  wireCombo(box, 'cmd-root', () => localRoots.map((r) => ({ value: r.id, label: rootLabel(r) })));
  $('.cmd-root', box).addEventListener('change', (e) => { CMD.rootId = e.target.value; CMD.selected.clear(); cmdRenderProjects(); });
  cmdRenderProjects();
}

async function cmdRenderProjects() {
  const box = $('#cmdProjectBox'); if (!box) return;
  if (!localRoots.length) { box.innerHTML = `<p class="muted">${esc(tr('git.navigate.no-root'))}</p>`; return; }
  box.innerHTML = skeleton(1);
  let projects = [];
  try { projects = (await localProjectsOf(CMD.rootId)).filter((p) => p.git); }
  catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  CMD.projects = projects;
  if (!projects.length) { box.innerHTML = `<p class="muted">${esc(tr('git.commands.no-project'))}</p>`; cmdUpdateCount(); return; }
  box.innerHTML = `<div class="cmd-picker-top">
      <input class="cmd-search" type="search" placeholder="${esc(tr('git.commands.search-ph'))}" />
      <label class="cmd-selall"><input type="checkbox" id="cmdSelAll" /> <span>${esc(tr('git.commands.select-all'))}</span></label>
    </div>
    <div class="cmd-plist">${projects.map((p) => `<label class="cmd-pitem"><input type="checkbox" value="${esc(p.name)}"${CMD.selected.has(p.name) ? ' checked' : ''}/>
      <span class="cmd-pname">${esc(p.name)}</span>${p.branch ? `<span class="cmd-pbranch muted">${esc(p.branch)}</span>` : ''}</label>`).join('')}</div>`;
  cmdUpdateCount();
}

function cmdUpdateCount() {
  const el = $('#cmdPickCount');
  if (el) el.textContent = CMD.selected.size ? tr('git.commands.picked', { n: CMD.selected.size, count: CMD.selected.size }) : '';
  const boxes = $$('#cmdProjectBox .cmd-plist input[type="checkbox"]');
  const all = $('#cmdSelAll'); const checked = boxes.filter((b) => b.checked).length;
  if (all) { all.checked = boxes.length > 0 && checked === boxes.length; all.indeterminate = checked > 0 && checked < boxes.length; }
}

async function loadGitCommands() {
  try { CMD.palette = await api('/git-commands'); } catch { CMD.palette = []; }
  const sel = $('#cmdPalette');
  if (sel) sel.innerHTML = `<option value="">${esc(tr('git.commands.palette-ph'))}</option>`
    + CMD.palette.map((c) => `<option value="${esc(c.command)}">${esc(c.label)} — git ${esc(c.command)}</option>`).join('');
  cmdRenderRoot();
}

function cmdReadTargets() { return [...CMD.selected].map((name) => ({ root_id: Number(CMD.rootId), name })); }

/* Commandes git qui peuvent détruire du travail non poussé. La prévisualisation liste bien
   les projets ciblés, mais elle n'alerte pas : `git reset --hard` sur trente dépôts ne se
   rattrape pas. On ne demande confirmation que pour ces verbes-là — confirmer un `git fetch`
   n'apprendrait qu'à cliquer sans lire. */
const GIT_DESTRUCTIVE = [
  /(^|\s)reset\s+.*(--hard|--merge|--keep)/, /(^|\s)clean\s+.*-[a-zA-Z]*[fdx]/,
  /(^|\s)checkout\s+.*(-f|--force)/, /(^|\s)switch\s+.*(-f|--force|--discard-changes)/,
  /(^|\s)push\s+.*(--force|--delete|\s-f(\s|$)|\s-d(\s|$))/,
  /(^|\s)branch\s+.*-D/, /(^|\s)tag\s+.*(-d|--delete)/,
  /(^|\s)(rm|restore|rebase|filter-branch)(\s|$)/,
  /(^|\s)stash\s+(drop|clear)/, /(^|\s)update-ref\s+.*-d/, /(^|\s)gc\s+.*--prune/,
];
function gitCmdIsDestructive(cmd) { return GIT_DESTRUCTIVE.some((re) => re.test(cmd)); }

function cmdPreview() {
  const targets = cmdReadTargets();
  const command = ($('#cmdInput').value || '').trim();
  if (!targets.length) { toast(tr('err.gitcmd.no-target'), true); return; }
  if (!command) { toast(tr('err.gitcmd.empty'), true); return; }
  const box = $('#cmdPreviewBox'); box.hidden = false; $('#cmdResultBox').hidden = true;
  box.innerHTML = `<div class="box cmd-preview">
    <h4>${esc(tr('git.commands.preview-h'))}</h4>
    <p><code class="cmd-full">git ${esc(command)}</code></p>
    <p class="muted">${esc(tr('git.commands.on-projects', { n: targets.length, count: targets.length }))}</p>
    <ul class="cmd-preview-list">${targets.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ul>
    <div class="form-actions">
      <button id="cmdCancel" class="btn">${esc(tr('git.commands.cancel'))}</button>
      <button id="cmdRun" class="btn btn-primary"><svg class="ico"><use href="#i-play"/></svg>${esc(tr('git.commands.execute'))}</button>
    </div>
  </div>`;
  $('#cmdRun').addEventListener('click', async () => {
    if (gitCmdIsDestructive(command) && !await confirmDialog({
      title: tr('git.commands.confirm-title'),
      text: tr('git.commands.confirm-text', { n: targets.length, count: targets.length }),
      detail: `git ${command}`,
      confirmLabel: tr('git.commands.execute'),
    })) return;
    cmdExecute(targets, command);
  });
  $('#cmdCancel').addEventListener('click', () => { box.hidden = true; });
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function cmdExecute(targets, command) {
  const btn = $('#cmdRun');
  try {
    const d = await busy(btn, () => api('/git-run', { method: 'POST', body: { targets, command } }));
    $('#cmdPreviewBox').hidden = true;
    cmdRenderResult(d);
    toast(tr('git.commands.done', { ok: d.counts.ok, failed: d.counts.failed }), d.counts.failed > 0);
  } catch (e) { toast(explainError(e.message), true); }
}

function cmdRenderResult(d) {
  const box = $('#cmdResultBox'); box.hidden = false;
  const rows = d.results.map((r) => `<div class="cmd-res ${r.ok ? 'ok' : 'err'}">
    <div class="cmd-res-head"><span class="dlog-dot ${r.ok ? 'run' : 'stop'}"></span><strong>${esc(r.project)}</strong>
      <span class="muted">${r.ok ? esc(tr('git.commands.exit-ok')) : esc(tr('git.commands.exit-code', { code: r.code }))}</span></div>
    <pre class="cmd-res-out">${esc(r.output || '')}${r.truncated ? '\n…' : ''}</pre>
  </div>`).join('');
  box.innerHTML = `<div class="box"><h4>${esc(tr('git.commands.result'))} — <code>${esc(d.command)}</code></h4>
    <p class="muted">${esc(tr('git.commands.counts', d.counts))}</p>${rows}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#cmdPalette') && $('#cmdPalette').addEventListener('change', (e) => { if (e.target.value) $('#cmdInput').value = e.target.value; });
$('#cmdPreview') && $('#cmdPreview').addEventListener('click', cmdPreview);
$('#cmdProjectBox') && $('#cmdProjectBox').addEventListener('change', (e) => {
  if (e.target.id === 'cmdSelAll') {
    for (const cb of $('#cmdProjectBox .cmd-plist input[type="checkbox"]')) { cb.checked = e.target.checked; if (e.target.checked) CMD.selected.add(cb.value); else CMD.selected.delete(cb.value); }
    cmdUpdateCount(); return;
  }
  const cb = e.target.closest('.cmd-plist input[type="checkbox"]'); if (!cb) return;
  if (cb.checked) CMD.selected.add(cb.value); else CMD.selected.delete(cb.value);
  cmdUpdateCount();
});
$('#cmdProjectBox') && $('#cmdProjectBox').addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('cmd-search')) return;
  const q = e.target.value.toLowerCase().trim();
  $$('#cmdProjectBox .cmd-pitem').forEach((it) => { it.hidden = !!q && !$('.cmd-pname', it).textContent.toLowerCase().includes(q); });
});

/* ============ Réglages · Git : palette de commandes (CRUD) ============ */
let gitCmdEditId = null;
async function loadGitConfig() {
  await loadConfig();           // peuple URL GitLab / token / clone (rattachés à #configForm)
  await renderGitCmdList();
}
async function renderGitCmdList() {
  const box = $('#gitCmdList'); if (!box) return;
  let list = [];
  try { list = await api('/git-commands'); } catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  if (!list.length) { box.innerHTML = `<p class="muted">${esc(tr('settings.gitcmd.empty'))}</p>`; return; }
  box.innerHTML = list.map((c) => `<div class="gitcmd-item">
    <div class="gitcmd-main"><strong>${esc(c.label)}</strong> <code>git ${esc(c.command)}</code></div>
    <div class="gitcmd-actions">
      <button class="btn btn-sm" data-gcedit="${c.id}" data-label="${esc(c.label)}" data-command="${esc(c.command)}" title="${esc(tr('settings.gitcmd.edit'))}"><svg class="ico ico-sm"><use href="#i-edit"/></svg></button>
      <button class="btn btn-sm btn-danger" data-gcdel="${c.id}" title="${esc(tr('settings.gitcmd.delete'))}"><svg class="ico ico-sm"><use href="#i-trash"/></svg></button>
    </div>
  </div>`).join('');
}
function gitCmdResetForm() {
  gitCmdEditId = null;
  $('#gitCmdLabel').value = ''; $('#gitCmdCommand').value = '';
  $('#gitCmdSubmitLabel').textContent = tr('settings.gitcmd.add');
  $('#gitCmdCancel').hidden = true;
}
$('#gitCmdForm') && $('#gitCmdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = $('#gitCmdLabel').value.trim();
  const command = $('#gitCmdCommand').value.trim().replace(/^git\s+/i, ''); // « git » de tête toléré
  if (!label || !command) { toast(tr('err.gitcmd.label-command-required'), true); return; }
  try {
    if (gitCmdEditId) await api(`/git-commands/${gitCmdEditId}`, { method: 'PUT', body: { label, command } });
    else await api('/git-commands', { method: 'POST', body: { label, command } });
    gitCmdResetForm(); renderGitCmdList();
    $('#gitCmdInfo').textContent = tr('ui.saved'); setTimeout(() => { $('#gitCmdInfo').textContent = ''; }, 2000);
  } catch (err) { toast(explainError(err.message), true); }
});
$('#gitCmdCancel') && $('#gitCmdCancel').addEventListener('click', gitCmdResetForm);
$('#gitCmdList') && $('#gitCmdList').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-gcedit]');
  const del = e.target.closest('[data-gcdel]');
  if (edit) {
    gitCmdEditId = Number(edit.dataset.gcedit);
    $('#gitCmdLabel').value = edit.dataset.label; $('#gitCmdCommand').value = edit.dataset.command;
    $('#gitCmdSubmitLabel').textContent = tr('settings.gitcmd.save'); $('#gitCmdCancel').hidden = false;
    $('#gitCmdLabel').focus();
  } else if (del) {
    if (!await confirmDialog({ text: tr('settings.gitcmd.confirm-delete'), confirmLabel: tr('ui.delete') })) return;
    try { await api(`/git-commands/${del.dataset.gcdel}`, { method: 'DELETE' }); renderGitCmdList(); }
    catch (err) { toast(explainError(err.message), true); }
  }
});


/* ---------- Onglet Docker : projets compose (drift .env) + containers hors-compose ---------- */
const DOCKER_BADGE = () => ({
  synced: { label: tr('docker.badge.synced'), cls: 'done' },
  'drift-config': { label: tr('docker.badge.drift-config'), cls: 'stale' },
  'drift-image': { label: tr('docker.badge.drift-image'), cls: 'reviewed' },
  'compose-modified': { label: tr('docker.badge.compose-modified'), cls: 'reviewed' },
  stopped: { label: tr('docker.badge.stopped'), cls: '' },
  missing: { label: tr('docker.badge.missing'), cls: 'to_review' },
});

function showDockerSub(name) {
  $$('#tab-docker .subnav [data-dsub]').forEach((b) => b.classList.toggle('active', b.dataset.dsub === name));
  $$('#tab-docker .subtab').forEach((p) => p.classList.toggle('active', p.id === `dsub-${name}`));
  try { localStorage.setItem('aidevtools_dsub', name); } catch { /* ignore */ }
  if (name === 'logs') loadDockerLogs();
  if (name === 'actions') loadDockerActions();
}
$$('#tab-docker .subnav [data-dsub]').forEach((b) => b.addEventListener('click', () => showDockerSub(b.dataset.dsub)));
$('#dockerRefresh') && $('#dockerRefresh').addEventListener('click', () => loadDocker(true));

/* Badges santé du menu Docker. ROUGE = les containers qui ne rendent plus service, qu'ils
   soient cassés (restarting/dead) ou simplement arrêtés (exited) — de l'extérieur c'est le
   même symptôme, et c'est ce chiffre-là qu'on veut voir de n'importe quel onglet. La bulle,
   elle, garde la distinction : « 2 arrêtés · 1 en erreur ». ORANGE = unhealthy.
   Rafraîchi au démarrage, à l'ouverture de l'onglet ET toutes les 30 s (cf. plus bas) via
   /docker/summary = un seul `docker ps -a` (léger). */
async function refreshDockerBadges() {
  const eB = $('#dockerErrBadge'); const uB = $('#dockerUnhealthyBadge');
  if (!eB || !uB) return;
  try {
    const s = await api('/docker/summary');
    const err = s.error || 0; const exited = s.exited || 0; const un = s.unhealthy || 0;
    /* Le ROUGE ne compte que l'anormal : restarting/dead, plus les containers sortis en ERREUR.
       Un arrêt propre (code 0) — « je l'ai arrêté », ou un job qui a fini — n'est pas une avarie ;
       le compter en rouge faisait sonner l'alarme tous les jours, et une alarme qui sonne toujours
       n'est plus lue. Les arrêts propres restent visibles dans la bulle, pas dans le chiffre. */
    const crashed = s.crashed || 0;
    const propres = Math.max(0, exited - crashed);
    /* `title = ''` (et non l'absence de title) : sur un enfant, un title VIDE empêche
       le navigateur de remonter à celui du bouton parent — sans ça, survoler le chiffre
       afficherait « Projets Docker Compose… » par-dessus notre bulle. */
    const setBadge = (el, n, label) => {
      el.hidden = !n; el.textContent = n;
      el.dataset.tip = label;            // bulle de l'app (immédiate, thémée)
      el.title = '';
      el.setAttribute('aria-label', label);
    };
    // Bulle composée : on n'énumère que ce qui est non nul, dans l'ordre de gravité.
    const down = [
      err ? tr('docker.badge.error', { n: err, count: err }) : '',
      crashed ? tr('docker.badge.crashed', { n: crashed, count: crashed }) : '',
      propres ? tr('docker.badge.exited-clean', { n: propres, count: propres }) : '',
    ].filter(Boolean).join(' · ');
    setBadge(eB, err + crashed, down);
    setBadge(uB, un, tr('docker.badge.unhealthy', { n: un, count: un }));
  } catch { eB.hidden = true; uB.hidden = true; }
}

/* ============ Docker · Logs — tail live multi-container ============
 * Perf : le flux SSE alimente un buffer BORNÉ (raw), les insertions DOM sont GROUPÉES par
 * requestAnimationFrame (pas de reflow par ligne sur des logs en rafale) et le DOM est plafonné.
 * Le filtrage inclure/exclure est CÔTÉ CLIENT (toggle sans relancer le flux) et PERSISTÉ. */
const DLOG = {
  es: null, raw: [], pending: [], raf: 0, autoscroll: true, colors: {},
  containers: [], selected: new Set(), include: [], exclude: [],
  MAX_RAW: 5000, MAX_DOM: 2000, PALETTE: ['#4f9cf9', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#eab308', '#ec4899'],
};
const DLOG_K = { inc: 'aidevtools_docker_log_include', exc: 'aidevtools_docker_log_exclude', tail: 'aidevtools_docker_log_tail', color: 'aidevtools_docker_log_color' };
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
      <span class="dlog-cname">${esc(c.name)}</span>
      ${c.project ? `<span class="dlog-cproj">${esc(c.project)}</span>` : ''}
    </label>`).join('');
}

async function loadDockerLogs() {
  dlogLoadFilters(); dlogRenderChips(); dlogRenderPause(); dlogStatus();
  try { $('#dlogTail').value = localStorage.getItem(DLOG_K.tail) || '200'; } catch { /* ignore */ }
  const box = $('#dlogContainers'); box.innerHTML = skeleton(1);
  try {
    const { containers } = await api('/docker/containers');
    DLOG.containers = containers || [];
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

/* ============ Docker · Actions groupées ============
 * On choisit UNE action, la liste des services CONCERNÉS s'affiche (filtrée par l'action :
 * up→arrêtés, restart/stop→démarrés, recreate/pull→tous), un filtre d'état optionnel la
 * réduit (drift / unhealthy / restarting…), on coche, on valide → un `docker compose <action>`
 * par projet (regroupé côté serveur). Source = /docker/compose. */
const DACT = { projects: [], selected: new Map() }; // Map clé→{dir,service} : pas de parsing fragile
const dactKey = (dir, service) => `${dir}␟${service}`; // clé OPAQUE (unicité) — jamais re-découpée

function dactApplicable(action, svc) {
  const running = !!(svc.container && svc.container.state === 'running');
  if (action === 'up') return !running;                    // démarrer ce qui ne tourne pas
  if (action === 'restart' || action === 'stop') return running; // agir sur ce qui tourne
  return true;                                             // recreate / pull : tous les services
}
// Un service est « en drift » s'il diverge du compose (config, image, ou compose modifié depuis).
function dactIsDrift(svc) {
  // « drift » = ce que le badge compose signale (MÊME définition que l'onglet Compose) : la
  // config/env, l'image, ou le fichier compose a divergé du container en cours d'exécution.
  return svc.badge === 'drift-config' || svc.badge === 'drift-image' || svc.badge === 'compose-modified';
}
/* Filtre d'état optionnel (indépendant de l'action) pour ne montrer que les containers
   pertinents. « Ne tourne pas » recouvre trois situations que Docker distingue et qui
   n'appellent pas les mêmes gestes :
     exited   le container a tourné puis s'est arrêté      → on le redémarre
     created  il existe mais n'a JAMAIS démarré            → souvent un échec de démarrage
     missing  aucun container : le service n'a jamais été créé (« non démarré ») → `up`
   `stopped` reste le chapeau des trois, et pas seulement pour la commodité : c'est une
   valeur déjà PERSISTÉE dans le navigateur, la retirer casserait le filtre enregistré. */
function dactMatchesFilter(filter, svc) {
  const st = svc.container && svc.container.state ? svc.container.state : null;
  const health = svc.container && svc.container.health ? svc.container.health : null;
  switch (filter) {
    case 'drift': return dactIsDrift(svc);
    case 'unhealthy': return health === 'unhealthy';
    case 'restarting': return st === 'restarting';
    case 'running': return st === 'running';
    case 'exited': return st === 'exited';
    /* Sorti EN ERREUR : le seul « arrêté » qui appelle une action. Un code de sortie inconnu
       n'y entre pas — on ne classe pas un container en panne sur une supposition. */
    case 'crashed': return st === 'exited' && Number(svc.container.exitCode) > 0;
    case 'created': return st === 'created';
    case 'missing': return !svc.container;
    case 'stopped': return st !== 'running'; // arrêté, créé-jamais-démarré OU non créé
    default: return true;                    // 'all'
  }
}
/* Liste des états proposés, dans l'ordre : ce qui va bien, puis ce qui ne tourne pas (du
   chapeau au détail), puis ce qui alerte. Partagée par le filtre de Compose et celui
   d'Actions — deux menus « N'afficher que » côte à côte doivent offrir les mêmes choix. */
const DOCKER_STATE_FILTERS = [
  ['all', 'docker.actions.f-all'],
  ['running', 'docker.actions.f-running'],
  ['stopped', 'docker.actions.f-stopped'],
  ['exited', 'docker.actions.f-exited'],
  ['crashed', 'docker.actions.f-crashed'],
  ['created', 'docker.actions.f-created'],
  ['missing', 'docker.actions.f-missing'],
  ['unhealthy', 'docker.actions.f-unhealthy'],
  ['restarting', 'docker.actions.f-restarting'],
  ['drift', 'docker.actions.f-drift'],
];
const dockerStateOptions = (cur) => DOCKER_STATE_FILTERS
  .map(([v, k]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(tr(k))}</option>`).join('');
// Le menu d'Actions est bâti une fois, depuis cette liste (celui de Compose l'est à chaque
// rendu, dans son gabarit). Un changement de langue recharge la page : rien à retraduire.
(() => { const el = $('#dactFilter'); if (el) el.innerHTML = dockerStateOptions('all'); })();
// Clés i18n complètes (littérales) pour réutiliser EXACTEMENT le libellé de l'onglet Compose.
const DACT_DRIFT_LABEL = { 'drift-config': 'docker.badge.drift-config', 'drift-image': 'docker.badge.drift-image', 'compose-modified': 'docker.badge.compose-modified' };
function dactItems() {
  const action = $('#dactAction').value;
  const filter = $('#dactFilter') ? $('#dactFilter').value : 'all';
  const q = ($('#dactSearch').value || '').toLowerCase();
  const out = [];
  for (const p of DACT.projects) {
    for (const s of (p.services || [])) {
      if (!dactApplicable(action, s)) continue;
      if (!dactMatchesFilter(filter, s)) continue;
      if (q && !`${p.name} ${s.name}`.toLowerCase().includes(q)) continue;
      const state = s.container && s.container.state ? s.container.state : null;
      out.push({
        project: p.name, dir: p.dir, service: s.name, state, running: state === 'running',
        drift: dactIsDrift(s), health: s.container && s.container.health, badge: s.badge,
      });
    }
  }
  return out;
}
function dactUpdateCount() {
  const n = DACT.selected.size;
  $('#dactCount').textContent = n ? tr('docker.actions.selected', { n, count: n }) : '';
  $('#dactApply').disabled = !n;
  const boxes = $$('#dactList input[type="checkbox"]');
  const checked = boxes.filter((b) => b.checked).length;
  const all = $('#dactAll');
  if (all) { all.checked = boxes.length > 0 && checked === boxes.length; all.indeterminate = checked > 0 && checked < boxes.length; }
}
function renderDockerActions() {
  const box = $('#dactList'); if (!box) return;
  dactSyncApply();
  const items = dactItems();
  if (!items.length) { box.innerHTML = `<p class="muted">${esc(tr('docker.actions.none'))}</p>`; dactUpdateCount(); return; }
  const byProj = new Map();
  for (const it of items) { if (!byProj.has(it.project)) byProj.set(it.project, []); byProj.get(it.project).push(it); }
  let html = '';
  for (const [proj, svcs] of byProj) {
    html += `<div class="dact-proj"><div class="dact-proj-name">${esc(proj)}</div>`;
    html += svcs.map((it) => {
      const key = dactKey(it.dir, it.service);
      const tags = [];
      if (it.drift && DACT_DRIFT_LABEL[it.badge]) tags.push(`<span class="dact-tag drift">${esc(tr(DACT_DRIFT_LABEL[it.badge]))}</span>`);
      if (it.health === 'unhealthy') tags.push('<span class="dact-tag warn">unhealthy</span>');
      if (it.state === 'restarting') tags.push('<span class="dact-tag err">restarting</span>');
      return `<label class="dact-item"><input type="checkbox" data-dir="${esc(it.dir)}" data-service="${esc(it.service)}" value="${esc(key)}"${DACT.selected.has(key) ? ' checked' : ''}/>
        <span class="dlog-dot ${it.running ? 'run' : 'stop'}"></span>
        <span class="dact-svc">${esc(it.service)}</span>
        <span class="dact-state">${esc(it.state || tr('docker.actions.not-created'))}</span>${tags.join('')}</label>`;
    }).join('');
    html += '</div>';
  }
  box.innerHTML = html;
  dactUpdateCount();
}
async function loadDockerActions() {
  const box = $('#dactList'); if (box) box.innerHTML = skeleton(2);
  try {
    const { projects } = await api('/docker/compose');
    DACT.projects = (projects || []).filter((p) => !p.error);
    renderDockerActions();
  } catch (e) { if (box) box.innerHTML = errorBox(explainError(e.message)); }
}
/* Verbes qui coupent un service en cours. Le bouton d'action groupée devient rouge et demande
   confirmation, comme l'aperçu git le fait déjà pour une suppression : ici l'action porte sur
   N services d'un coup, et rien à l'écran ne rappelle lesquels une fois la liste défilée.
   Les autres verbes (build, pull, up, restart) n'interrompent rien de durable. */
const DACT_DESTRUCTIVE = new Set(['stop', 'recreate']);
function dactSyncApply() {
  const btn = $('#dactApply'); const sel = $('#dactAction');
  if (!btn || !sel) return;
  btn.className = DACT_DESTRUCTIVE.has(sel.value) ? 'btn btn-danger btn-solid' : 'btn btn-primary';
}

async function dactApply() {
  const action = $('#dactAction').value;
  const targets = [...DACT.selected.values()]; // {dir, service} directement — aucun re-parsing
  if (!targets.length) return;
  const b = $('#dactApply');
  if (DACT_DESTRUCTIVE.has(action) && !await confirmDialog({
    title: tr('docker.actions.confirm-title'),
    text: tr(`docker.actions.confirm-${action}`, { n: targets.length, count: targets.length }),
    detail: targets.map((t) => `• ${t.service}`).join('\n'),
    confirmLabel: tr('docker.actions.apply'),
  })) return;
  try {
    await busy(b, () => api('/docker/bulk-action', { method: 'POST', body: { action, targets } }));
    // Feedback chiffré : l'action est asynchrone (file de jobs), le détail par service arrive
    // ensuite dans le panneau de logs — mais on confirme tout de suite le nombre de cibles lancées.
    toast(tr('docker.act.started-n', { n: targets.length })); DACT.selected.clear(); renderDockerActions(); refreshStatus();
  } catch (e) { toast(explainError(e.message), true); }
}
// Changer d'action réinitialise la sélection (elle appartient à une action) ; le filtre d'état
// et la recherche ne font que masquer/afficher — ils préservent la sélection.
$('#dactAction') && $('#dactAction').addEventListener('change', () => { DACT.selected.clear(); dactSyncApply(); renderDockerActions(); });
$('#dactFilter') && $('#dactFilter').addEventListener('change', renderDockerActions);
$('#dactSearch') && $('#dactSearch').addEventListener('input', renderDockerActions);
$('#dactApply') && $('#dactApply').addEventListener('click', dactApply);
$('#dactList') && $('#dactList').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  if (cb.checked) DACT.selected.set(cb.value, { dir: cb.dataset.dir, service: cb.dataset.service });
  else DACT.selected.delete(cb.value);
  dactUpdateCount();
});
$('#dactAll') && $('#dactAll').addEventListener('change', (e) => {
  for (const cb of $$('#dactList input[type="checkbox"]')) {
    if (e.target.checked) DACT.selected.set(cb.value, { dir: cb.dataset.dir, service: cb.dataset.service });
    else DACT.selected.delete(cb.value);
  }
  renderDockerActions();
});
async function loadDocker(force) {
  let sub = 'compose';
  try { sub = localStorage.getItem('aidevtools_dsub') || 'compose'; } catch { /* ignore */ }
  showDockerSub(sub);
  refreshDockerBadges(); // met à jour les compteurs santé du menu (indépendant du rendu ci-dessous)
  const errBox = $('#dockerError');
  $('#dockerInfo').textContent = tr('docker.loading');
  $('#dockerComposeBox').innerHTML = skeleton(2);
  $('#dockerOrphansBox').innerHTML = skeleton(2);
  try {
    const st = await api('/docker/status');
    if (!st.ok) {
      // Démon injoignable → bannière ACTIONNABLE (l'erreur n°1). On n'appelle pas le reste.
      errBox.innerHTML = errorBox(st.error || tr('docker.daemon-down'));
      $('#dockerInfo').textContent = '';
      $('#dockerComposeBox').innerHTML = ''; $('#dockerOrphansBox').innerHTML = '';
      return;
    }
    errBox.innerHTML = '';
    $('#dockerInfo').textContent = st.version ? `Docker ${esc(st.version)}` : '';
    // Compose en AFFICHAGE PROGRESSIF (liste rapide → détails au fil de l'eau) ; orphelins en parallèle.
    // En cas d'échec, ne pas laisser le squelette des orphelins tourner en boucle.
    const orphP = api('/docker/orphans').then((orph) => renderDockerOrphans(orph))
      .catch((e) => { const ob = $('#dockerOrphansBox'); if (ob) ob.innerHTML = errorBox(explainError(e.message)); });
    await loadComposeProgressive();
    await orphP;
  } catch (e) {
    errBox.innerHTML = errorBox(e.message);
    $('#dockerInfo').textContent = '';
  }
}

function envDiffHtml(diffs) {
  if (!diffs || !diffs.length) return '';
  const one = (d) => {
    const val = d.masked ? `<span class="muted">${esc(tr('docker.masked'))}</span>`
      : d.kind === 'modified' ? `<code>${esc(d.from)}</code> → <code>${esc(d.to)}</code>`
        : d.kind === 'added' ? `→ <code>${esc(d.to)}</code>` : '';
    const k = tr(`docker.diff.${d.kind}`);
    return `<li><span class="env-kind env-${d.kind}">${esc(k)}</span> <code class="env-name">${esc(d.name)}</code> ${val}</li>`;
  };
  return `<ul class="env-diff">${diffs.map(one).join('')}</ul>`;
}

function dockerServiceRow(proj, s) {
  const b = (DOCKER_BADGE()[s.badge]) || { label: s.badge, cls: '' };
  const canRecreate = ['drift-config', 'drift-image', 'compose-modified'].includes(s.badge);
  const act = (a, label, cls) => `<button class="btn btn-sm${cls ? ` ${cls}` : ''}" data-dockeract="${a}" data-dir="${esc(proj.dir)}" data-svc="${esc(s.name)}">${esc(label)}</button>`;
  // État du container MIS EN ÉVIDENCE : pastille colorée + libellé (vert = running, rouge =
  // exited/dead, ambre = paused/restarting/created, pointillé = non démarré).
  const state = s.container ? (s.container.state || 'unknown') : 'none';
  const isRunning = state === 'running';
  const stateLabel = state === 'none' ? tr('docker.not-started') : state;
  const stateChip = `<span class="docker-state docker-state-${esc(state)}" title="${esc(stateLabel)}"><span class="docker-dot"></span>${esc(stateLabel)}</span>`;
  return `<div class="docker-svc">
      <div class="docker-svc-head">
        ${stateChip}
        <strong>${esc(s.name)}</strong>
        <span class="tag ${b.cls}">${esc(b.label)}</span>
        ${s.image ? `<code class="muted">${esc(s.image)}</code>` : ''}
        ${s.container && s.container.name ? `<span class="muted">${esc(s.container.name)}</span>` : ''}
        <span class="spacer"></span>
        ${isRunning ? act('stop', tr('docker.act.stop'), 'btn-danger') : ''}
        ${isRunning ? act('restart', tr('docker.act.restart')) : ''}
        ${act('pull', tr('docker.act.pull'))}
        ${act('build', tr('docker.act.build'))}
        ${canRecreate ? act('recreate', tr('docker.act.recreate'), 'btn-primary') : (isRunning ? '' : act('up', tr('docker.act.up')))}
      </div>
      ${s.imgDrift && s.container ? `<div class="muted docker-imgdrift">${esc(tr('docker.imgdrift', { compose: s.image || '?', running: (s.container.image || '?') }))}</div>` : ''}
      ${envDiffHtml(s.envDiffs)}
    </div>`;
}

// Compose masqués (par chemin de fichier, stable). Choix persisté dans le navigateur.
/* Filtre de SERVICES de l'onglet Compose : recherche libre + état. Persisté comme le
   filtre de projets — on retrouve sa vue au rechargement. Le prédicat d'état est celui
   de l'onglet Actions (`dactMatchesFilter`) : un seul comportement à maintenir. */
function composeSvcFilter() {
  try { return { q: '', state: 'all', ...JSON.parse(localStorage.getItem('aidevtools_docker_svcfilter') || '{}') }; }
  catch { return { q: '', state: 'all' }; }
}
function setComposeSvcFilter(patch) {
  try { localStorage.setItem('aidevtools_docker_svcfilter', JSON.stringify({ ...composeSvcFilter(), ...patch })); }
  catch { /* stockage indisponible */ }
}
// Un service passe-t-il le filtre courant ? `name` sert aussi à chercher par projet.
function composeSvcMatches(project, svc) {
  const f = composeSvcFilter();
  if (f.state !== 'all' && !dactMatchesFilter(f.state, svc)) return false;
  const q = (f.q || '').trim().toLowerCase();
  if (!q) return true;
  const cname = (svc.container && svc.container.name) || '';
  return `${project} ${svc.name} ${cname}`.toLowerCase().includes(q);
}
function composeFilterActive() {
  const f = composeSvcFilter();
  return !!(f.q || '').trim() || f.state !== 'all';
}

function dockerHidden() { try { return new Set(JSON.parse(localStorage.getItem('aidevtools_docker_hidden') || '[]')); } catch { return new Set(); } }
function setDockerHidden(set) { try { localStorage.setItem('aidevtools_docker_hidden', JSON.stringify([...set])); } catch { /* stockage indisponible */ } }

// Dernière activité d'un projet = container le plus récemment (re)créé (max de .Created).
function dockerProjectLastActivity(p) {
  let max = 0;
  for (const s of (p.services || [])) {
    const t = s.container && s.container.created ? Date.parse(s.container.created) : 0;
    if (t && t > max) max = t;
  }
  return max;
}

// Bloc Makefile (si un Makefile est à côté du compose) : recherche instantanée + exécution.
function dockerMakefileBlock(p) {
  const mk = p.makefile;
  if (!mk || !mk.targets || !mk.targets.length) return '';
  const item = (t) => `<div class="mk-item" data-name="${esc(t.name)}" data-desc="${esc(t.desc || '')}">
      <button class="btn btn-sm mk-run" data-dir="${esc(p.dir)}" data-target="${esc(t.name)}" title="${esc(tr('docker.make.run-title', { target: t.name }))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('docker.make.run'))}</button>
      <code class="mk-name">${esc(t.name)}</code>
      ${t.recipe ? `<button type="button" class="hint hint-code mk-eye" tabindex="0" aria-label="${esc(tr('docker.make.view-cmd'))}" data-tip="${esc(t.recipe.slice(0, 1400))}"><svg class="ico ico-sm"><use href="#i-eye"/></svg></button>` : ''}
      ${t.desc ? `<span class="muted mk-desc">${esc(t.desc)}</span>` : ''}
    </div>`;
  // Ouvert par défaut : dans sa colonne, le bloc est en haut à gauche → visible sans scroller.
  return `<details class="docker-make" open>
      <summary><svg class="ico ico-sm"><use href="#i-doc"/></svg> ${esc(tr('docker.make.title', { n: mk.targets.length, count: mk.targets.length }))} <span class="muted">· ${esc(mk.file)}</span></summary>
      <input type="search" class="search mk-search" placeholder="${esc(tr('docker.make.search-ph'))}" />
      <div class="mk-list">${mk.targets.map(item).join('')}</div>
      <p class="muted mk-none" hidden>${esc(tr('docker.make.no-match'))}</p>
    </details>`;
}

function dockerProjectCard(p) {
  const make = dockerMakefileBlock(p);
  const kept = p.error ? [] : (p.services || []).filter((s) => composeSvcMatches(p.name, s));
  // Filtre actif et aucun service retenu → le projet entier disparaît de la vue
  // (afficher une carte vide ferait croire à un projet sans service).
  if (!p.error && !kept.length && composeFilterActive()) return '';
  const hiddenCount = (p.services || []).length - kept.length;
  const services = p.error
    ? errorBox(p.error)
    : `<div class="docker-svcs">${kept.map((s) => dockerServiceRow(p, s)).join('')}</div>`
      + (hiddenCount > 0 ? `<p class="muted docker-svc-hidden">${esc(tr('docker.filter.svc-hidden', { n: hiddenCount, count: hiddenCount }))}</p>` : '');
  return `<div class="card docker-project">
      <div class="docker-project-head">
        <div class="title" style="flex:1;min-width:0"><code>${esc(p.name)}</code> <span class="muted">${esc(p.file)} · ${esc(p.rootLabel || p.dir)}</span></div>
        <div class="docker-project-actions">
          <button class="btn btn-sm" data-dockeract="up" data-dir="${esc(p.dir)}" title="${esc(tr('docker.act.up-all-title'))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('docker.act.up-all'))}</button>
          <button class="btn btn-sm btn-danger" data-dockerdown data-dir="${esc(p.dir)}" data-project="${esc(p.name)}" title="${esc(tr('docker.act.down-title'))}"><svg class="ico ico-sm"><use href="#i-stop"/></svg>${esc(tr('docker.act.down'))}</button>
        </div>
      </div>
      <div class="docker-project-body">
        ${make ? `<div class="docker-make-col">${make}</div>` : ''}
        <div class="docker-svcs-col">${services}</div>
      </div>
    </div>`;
}


/* ============ Docker · Compose en affichage PROGRESSIF ============
 * D'abord la liste légère des fichiers (rapide : un scan + un `docker ps -a`), rendue en
 * cartes « placeholder » déjà triées ; puis le détail de chaque projet est chargé au fil de
 * l'eau (concurrence bornée) et remplace SA carte — l'écran se remplit sans tout attendre. */
const COMPOSE = { files: [], details: new Map() };

async function pMapFront(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i; i += 1; await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
}

function dockerPlaceholderCard(f) {
  return `<div class="card docker-project docker-ph">
      <div class="docker-project-head">
        <div class="title" style="flex:1;min-width:0"><code>${esc(f.name)}</code> <span class="muted">${esc(f.file)} · ${esc(f.rootLabel || f.dir)}</span></div>
        <span class="muted dlog-loading"><span class="spin"></span> ${esc(tr('docker.loading'))}${f.count ? ` · ${f.count}` : ''}</span>
      </div>
    </div>`;
}

function renderComposeTab() {
  const box = $('#dockerComposeBox');
  if (!box) return;
  if (!COMPOSE.files.length) { box.innerHTML = emptyState({ icon: 'inbox', title: tr('docker.compose.empty.title'), text: tr('docker.compose.empty.text') }); return; }
  const hidden = dockerHidden();
  const sf = composeSvcFilter();
  // Recherche + état : mêmes intitulés et mêmes valeurs que le sous-onglet Actions.
  // Recherche et état ont la MÊME structure (.dact-action : libellé au-dessus du contrôle),
  // sinon un champ nu se centrerait contre un bloc plus haut et les deux seraient décalés.
  const svcBar = `<div class="docker-svcbar">
      <label class="dact-action dact-action-grow"><span>${esc(tr('docker.compose.search-label'))}</span>
        <input id="dcSearch" class="dact-search" type="search" value="${esc(sf.q || '')}"
          placeholder="${esc(tr('docker.compose.search'))}" />
      </label>
      <label class="dact-action"><span>${esc(tr('docker.actions.filter'))}</span>
        <select id="dcState">${dockerStateOptions(sf.state)}</select>
      </label>
    </div>`;
  // Filtre persistant : une case par fichier compose (cochée = affiché).
  const filter = `<div class="docker-filter"><span class="muted">${esc(tr('docker.filter.label'))}</span>${COMPOSE.files.map((f) => `
      <label class="inline-check inline-check-mid"><input type="checkbox" class="docker-filter-cb" value="${esc(f.path)}" ${hidden.has(f.path) ? '' : 'checked'} /> <span>${esc(f.name)}</span></label>`).join('')}</div>`;
  const visible = COMPOSE.files.filter((f) => !hidden.has(f.path));
  const slots = visible.map((f) => {
    const d = COMPOSE.details.get(f.path);
    // Détail pas encore chargé : on garde le squelette, sinon un filtre actif masquerait
    // des projets qu'on n'a simplement pas encore reçus.
    const inner = d ? (d.__error ? errorBox(d.__error) : dockerProjectCard(d)) : dockerPlaceholderCard(f);
    return inner ? `<div class="docker-slot" data-path="${esc(f.path)}">${inner}</div>` : '';
  }).join('');
  const empty = visible.length
    ? (composeFilterActive() ? `<p class="muted">${esc(tr('docker.filter.no-svc-match'))}</p>` : '')
    : `<p class="muted">${esc(tr('docker.filter.all-hidden'))}</p>`;
  box.innerHTML = svcBar + filter + (slots || empty);
  wireDockerActions(box);
  const search = $('#dcSearch', box);
  if (search) {
    // Debounce : chaque frappe reconstruit toutes les cartes de projet (et les recâble).
    const apply = debounce(() => {
      const pos = search.selectionStart;
      renderComposeTab();                                  // filtrage local : aucun appel Docker
      const again = $('#dcSearch');
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* champ recréé */ } }
    });
    search.addEventListener('input', () => { setComposeSvcFilter({ q: search.value }); apply(); });
  }
  const stateSel = $('#dcState', box);
  if (stateSel) stateSel.addEventListener('change', () => { setComposeSvcFilter({ state: stateSel.value }); renderComposeTab(); });
  $$('.docker-filter-cb', box).forEach((cb) => cb.addEventListener('change', () => {
    const set = dockerHidden();
    if (cb.checked) set.delete(cb.value); else set.add(cb.value);
    setDockerHidden(set);
    renderComposeTab();               // ré-rendu instantané (les détails déjà chargés viennent du cache)
    fetchVisibleComposeDetails();     // charge ceux nouvellement affichés
  }));
}

function fillComposeSlot(path) {
  const box = $('#dockerComposeBox'); if (!box) return;
  const slot = $$('.docker-slot', box).find((s) => s.dataset.path === path);
  if (!slot) return;
  const d = COMPOSE.details.get(path);
  const html = d && d.__error ? errorBox(d.__error) : dockerProjectCard(d);
  // Le détail arrive après coup : s'il ne passe pas le filtre, le slot disparaît.
  if (!html) { slot.remove(); return; }
  slot.innerHTML = html;
  wireDockerActions(slot);
}

async function fetchVisibleComposeDetails() {
  const hidden = dockerHidden();
  const todo = COMPOSE.files.filter((f) => !hidden.has(f.path) && !COMPOSE.details.has(f.path));
  await pMapFront(todo, 5, async (f) => {
    let detail;
    try {
      const d = await api(`/docker/compose/one?dir=${encodeURIComponent(f.dir)}&file=${encodeURIComponent(f.file)}`);
      detail = d.error ? { __error: d.error } : (d.project || { __error: tr('docker.compose.empty.title') });
    } catch (e) { detail = { __error: explainError(e.message) }; }
    COMPOSE.details.set(f.path, detail);
    fillComposeSlot(f.path);
  });
}

async function loadComposeProgressive() {
  const box = $('#dockerComposeBox');
  box.innerHTML = skeleton(2);
  let list;
  try { list = await api('/docker/compose/list'); }
  catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  if (list.error) { box.innerHTML = errorBox(list.error); return; }
  COMPOSE.files = list.files || [];
  COMPOSE.details = new Map();
  renderComposeTab();
  await fetchVisibleComposeDetails();
}

function renderDockerOrphans(d) {
  const box = $('#dockerOrphansBox');
  if (d.error) { box.innerHTML = errorBox(d.error); return; }
  const orphans = d.orphans || [];
  if (!orphans.length) { box.innerHTML = emptyState({ icon: 'inbox', title: tr('docker.orphans.empty.title'), text: tr('docker.orphans.empty.text') }); return; }
  box.innerHTML = `<p class="muted">${esc(tr('docker.orphans.intro'))}</p>` + orphans.map((c) => {
    const state = c.state || 'unknown';
    return `
    <div class="card docker-orphan">
      <div style="flex:1;min-width:0">
        <div class="title"><span class="docker-state docker-state-${esc(state)}" title="${esc(state)}"><span class="docker-dot"></span>${esc(state)}</span> ${esc(c.name)} <code class="muted">${esc(c.image)}</code></div>
        <div class="meta muted">${esc(c.status || '')}${c.ports ? ` · ${esc(c.ports)}` : ''}</div>
        <pre class="docker-run" data-run="${esc(c.id)}" hidden></pre>
      </div>
      <div class="task-actions">
        ${state === 'running' ? `<button class="btn btn-sm btn-danger" data-dockerstop="${esc(c.id)}" title="${esc(tr('docker.orphan.stop-title'))}"><svg class="ico ico-sm"><use href="#i-stop"/></svg>${esc(tr('docker.orphan.stop'))}</button>` : ''}
        <button class="btn btn-sm" data-dockerrun="${esc(c.id)}" title="${esc(tr('docker.orphan.reconstitute-title'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('docker.orphan.reconstitute'))}</button>
        <button class="btn btn-sm btn-danger" data-dockerrm="${esc(c.id)}" data-name="${esc(c.name)}" title="${esc(tr('docker.orphan.remove-title'))}"><svg class="ico ico-sm"><use href="#i-trash"/></svg>${esc(tr('docker.orphan.remove'))}</button>
      </div>
    </div>`;
  }).join('');
  wireDockerActions(box);
}

function wireDockerActions(box) {
  $$('[data-dockeract]', box).forEach((b) => b.addEventListener('click', async () => {
    const services = b.dataset.svc ? [b.dataset.svc] : [];
    const { dir } = b.dataset;
    const action = b.dataset.dockeract;
    const run = (a) => api('/docker/compose/action', { method: 'POST', body: { dir, action: a, services } });
    try {
      await busy(b, () => run(action));
      // Un stop de service se rattrape par un up : on l'offre plutôt que de le faire confirmer.
      if (action === 'stop' && services.length) {
        toastUndo(tr('docker.act.started'), () => run('up')
          .then(() => { toast(tr('docker.act.started')); refreshStatus(); })
          .catch((e) => toast(explainError(e.message), true)));
      } else toast(tr('docker.act.started'));
      refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerdown]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      const pv = await api('/docker/compose/preview-down', { method: 'POST', body: { dir: b.dataset.dir, project: b.dataset.project } });
      const lines = (pv.containers || []).map((c) => `• ${c.name}${c.service ? ` (${c.service})` : ''}`).join('\n');
      const ok = await confirmDialog({
        text: `${tr('docker.down.confirm', { n: (pv.containers || []).length })}\n${tr('docker.down.volumes')}`,
        detail: lines, confirmLabel: tr('docker.act.down'),
      });
      if (!ok) return;
      await busy(b, () => api('/docker/compose/action', { method: 'POST', body: { dir: b.dataset.dir, action: 'down', services: [] } }));
      toast(tr('docker.act.started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerrun]', box).forEach((b) => b.addEventListener('click', async () => {
    const pre = $(`.docker-run[data-run="${b.dataset.dockerrun}"]`, box);
    if (pre && !pre.hidden) { pre.hidden = true; return; }
    try { const d = await busy(b, () => api(`/docker/orphan/${b.dataset.dockerrun}/reconstitute`)); if (pre) { pre.textContent = d.command || ''; pre.hidden = false; } }
    catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerstop]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      await busy(b, () => api(`/docker/orphan/${b.dataset.dockerstop}/stop`, { method: 'POST' }));
      toast(tr('docker.act.started')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  // Recherche instantanée dans les commandes du Makefile.
  $$('.mk-search', box).forEach((inp) => inp.addEventListener('input', () => {
    const q = inp.value.trim().toLowerCase();
    const wrap = inp.closest('.docker-make');
    let shown = 0;
    $$('.mk-item', wrap).forEach((it) => {
      const hit = !q || `${it.dataset.name} ${it.dataset.desc}`.toLowerCase().includes(q);
      it.hidden = !hit; if (hit) shown += 1;
    });
    $('.mk-none', wrap).hidden = shown > 0;
  }));
  // Exécution d'une commande make (log streamé, comme les actions compose).
  $$('.mk-run', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      await busy(b, () => api('/docker/make/run', { method: 'POST', body: { dir: b.dataset.dir, target: b.dataset.target } }));
      toast(tr('docker.make.started', { target: b.dataset.target })); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
  $$('[data-dockerrm]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog({ text: tr('docker.orphan.remove-confirm', { name: b.dataset.name }), confirmLabel: tr('ui.delete') })) return;
    try {
      await busy(b, () => api(`/docker/orphan/${b.dataset.dockerrm}/remove`, { method: 'POST' }));
      toast(tr('docker.orphan.removed')); refreshStatus();
    } catch (e) { toast(explainError(e.message), true); }
  }));
}
$('#gitSameName').addEventListener('change', () => {
  $('#gitNameRow').hidden = !gitSameName();
  gitDropPreview();                    // l'aperçu ne correspond plus à la saisie
  gitRenderTargets();
});
$('#gitAddTarget').addEventListener('click', () => { gitTargets.push({}); gitDropPreview(); gitRenderTargets(); });
$('#gitPreview').addEventListener('click', gitDoPreview);
$('#gitExploreGo').addEventListener('click', gitAnalyze);
document.addEventListener('change', (e) => {
  // L'index vient de la LIGNE, pas de l'élément : l'input caché du combo dépôt
  // ne porte pas data-row (il vit dans le combo, pas directement sur la ligne).
  const gitRow = e.target.closest && e.target.closest('.git-row');
  if (!gitRow) return;
  const i = Number(gitRow.dataset.row);
  if (e.target.classList.contains('git-repo')) {
    // Changer de dépôt invalide la ref choisie, pas le nom saisi pour la ligne.
    gitTargets[i] = { repo_id: Number(e.target.value), name: (gitTargets[i] || {}).name };
    gitFillRow(i);
  }
  if (e.target.classList.contains('git-ref')) {
    gitTargets[i] = { ...gitTargets[i], ref: e.target.value };
  }
  gitDropPreview();   // dépôt ou ref source changés : l'aperçu ne les décrit plus
});
// Les noms par projet sont mémorisés à la frappe : ajouter ou retirer une ligne
// redessine TOUTES les lignes, et une saisie restée dans le DOM serait perdue.
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('git-name')) return;
  const i = Number(e.target.dataset.row);
  gitTargets[i] = { ...gitTargets[i], name: e.target.value };
  gitDropPreview();
});
/* Filtre de la liste de refs à supprimer. Purement visuel : on masque des lignes, on n'en
   décoche aucune — la sélection appartient à l'utilisateur, pas au filtre. */
document.addEventListener('input', (e) => {
  if (!e.target.classList || !e.target.classList.contains('git-ref-filter')) return;
  const list = e.target.closest('.git-refs').querySelector('.git-ref-list');
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  for (const it of list.querySelectorAll('.git-ref-item')) {
    const hit = !q || it.dataset.name.includes(q);
    it.hidden = !hit;
    if (hit) shown += 1;
  }
  list.querySelector('.git-ref-nomatch').hidden = shown > 0;
});
/* Retoucher un nom APRÈS l'aperçu périme celui-ci : l'exécution relit les champs,
   pas le tableau affiché. Sans ça on prévisualise v2.3.0, on corrige en v2.4.0, et
   c'est v2.4.0 qui part sous un tableau qui annonce toujours v2.3.0 — alors que
   l'aperçu est censé ÊTRE la confirmation. */
$('#gitRefName').addEventListener('input', gitDropPreview);
$('#gitTagMsg').addEventListener('input', gitDropPreview);
document.addEventListener('click', (e) => {
  const rm = e.target.closest && e.target.closest('[data-gitrm]');
  if (!rm) return;
  const i = Number(rm.dataset.gitrm);
  if (gitTargets.length > 1) { gitTargets.splice(i, 1); gitDropPreview(); gitRenderTargets(); }
});

/* ---------- Notifications bureau ----------
   Critère : une notif appelle une ACTION ou clôt une ATTENTE. Le reste (ambiance)
   est au footer. Le serveur émet des faits ; le client filtre selon SES préférences
   (types activés, seuil de note, mode silencieux) et navigue au clic. */
const NOTIF_KEY = 'mergerie_notif';
// Migration silencieuse depuis l'ancienne clé (renommage open-source) : on recopie une fois puis on l'efface.
try { const _oldNotif = localStorage.getItem('aidevtools_notif'); if (_oldNotif != null && localStorage.getItem(NOTIF_KEY) == null) { localStorage.setItem(NOTIF_KEY, _oldNotif); localStorage.removeItem('aidevtools_notif'); } } catch { /* stockage indisponible */ }
const NOTIF_DEFAULTS = {
  queue_done: true,   // fin de la file de reviews (le lot) — LE cas d'usage
  low_note: true,     // review sous un seuil — actionnable
  job_failed: true,   // échec (timeout, CLI, réseau) — silence = mauvaise surprise
  session_done: true, // session de codage prête à push/MR
  needs_input: true,  // l'agent a posé des questions — clôt une attente, actionnable
  converge_done: true, // boucle de convergence terminée — actionnable par excellence
  jira_status: true,  // un ticket surveillé change d'état — c'est LA raison de le surveiller
  verify_done: true,  // un verdict objectif est tombé — c'est ce qu'on attendait pour merger
  jenkins_done: true, // un job Jenkins QUE J'AI LANCÉ s'est terminé — on ne reste pas devant
  mr_new: false,      // nouvelle MR — utile pour certains, spam pour d'autres
  mr_merged: false,   // MR mergée — informatif, pas actionnable
  threshold: 5,       // seuil « note basse » (sur 10)
  muted: false,       // mode silencieux global (toggle footer)
};
function notifPrefs() { try { return { ...NOTIF_DEFAULTS, ...JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}') }; } catch { return { ...NOTIF_DEFAULTS }; } }
function setNotifPrefs(p) { try { localStorage.setItem(NOTIF_KEY, JSON.stringify(p)); } catch { /* stockage indisponible */ } }
const notifSupported = () => typeof Notification !== 'undefined';
const notifPermission = () => (notifSupported() ? Notification.permission : 'unsupported');

// Navigation au clic : ramène au bon endroit via le routage d'onglets existant.
/* ============ Onglet Jira : mes tickets affectés (liste → détail) ============ */
const JIRA = { me: null, people: [], issues: [], selectedKey: null, current: null, currentBox: null, total: null, connus: {} };
const JIRA_CAT = { new: 'todo', indeterminate: 'progress', done: 'done' };

function jiraStatusChip(it) {
  const cls = JIRA_CAT[it.statusCategory] || 'todo';
  return `<span class="jira-status jira-status-${cls}">${esc(it.status || '—')}</span>`;
}
function jiraInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function jiraSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} o`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} Ko`;
  return `${(b / 1024 / 1024).toFixed(1)} Mo`;
}

// Filtre par statut (persisté) : on mémorise les statuts MASQUÉS (décochés).
function jiraHiddenStatuses() { try { return new Set(JSON.parse(localStorage.getItem('aidevtools_jira_status_hidden') || '[]')); } catch { return new Set(); } }
function setJiraHiddenStatuses(set) { try { localStorage.setItem('aidevtools_jira_status_hidden', JSON.stringify([...set])); } catch { /* ignore */ } }
/* Les statuts masqués sont exclus PAR Jira : ils disparaîtraient donc de la liste, et on ne
   pourrait plus les recocher. On garde en mémoire ceux déjà vus, comme pour les sprints. */
/* Statuts du WORKFLOW des projets concernés, en plus de ceux portés par les tickets chargés :
   un statut peut exister sans qu'aucun ticket rapporté ne l'ait — il doit rester filtrable.
   On interroge les projets sélectionnés, sinon ceux des tickets affichés : demander tous les
   statuts de l'instance donnerait des dizaines d'entrées sans rapport. */
let jiraStatutsDemandes = '';
async function chargerStatutsDuWorkflow() {
  const choisis = jiraFiltres().project || [];
  const cles = [...new Set(choisis.length ? choisis : JIRA.issues.map((i) => i.projectKey).filter(Boolean))].sort();
  const signature = cles.join(',');
  if (!signature || signature === jiraStatutsDemandes) return;
  jiraStatutsDemandes = signature;
  try {
    const d = await api(`/jira/statuses?projects=${encodeURIComponent(signature)}`);
    if (!(d.statuses || []).length) return;
    jiraMemoriseValeurs('status', d.statuses.map((st) => ({ v: st.name, l: st.name, cat: st.cat })));
    renderJiraStatusFilter();
  } catch { /* filtre : jamais bloquant */ }
}

function jiraDistinctStatuses() {
  const seen = new Map();
  for (const it of JIRA.issues) if (it.status && !seen.has(it.status)) seen.set(it.status, it.statusCategory);
  const vus = [...seen.entries()].map(([status, cat]) => ({ v: status, l: status, cat }));
  return jiraUnionValeurs('status', vus).map((x) => ({ status: x.v, cat: x.cat }));
}
/* ---------- Jira : filtre générique par champ ----------------------------------
   Choisir le CHAMP puis les valeurs, plutôt qu'un filtre codé en dur par champ. Les valeurs
   proposées sont celles réellement présentes dans les tickets chargés : proposer une valeur
   qui ne ramène rien n'aide personne, et une liste figée se périme.

   Sémantique : ET entre les champs, OU à l'intérieur d'un champ. C'est ce que les gens
   attendent — « les bugs ET les tâches, de cet epic-ci ». Un champ dont aucune valeur n'est
   cochée ne filtre pas : sinon, ajouter un critère viderait la liste avant qu'on ait coché
   quoi que ce soit.

   `JIRA_CHAMPS` et `jiraPasseFiltres` restent contigus : un test les évalue ensemble. */
const JIRA_CHAMPS = [
  { cle: 'epic', i18n: 'jira.meta.epic', vals: (it) => (it.epic ? [{ v: it.epic.key, l: `${it.epic.key} — ${it.epic.summary}` }] : []) },
  { cle: 'type', i18n: 'jira.meta.type', vals: (it) => (it.type ? [{ v: it.type, l: it.type }] : []) },
  { cle: 'priority', i18n: 'jira.meta.priority', vals: (it) => (it.priority ? [{ v: it.priority, l: it.priority }] : []) },
  { cle: 'project', i18n: 'jira.meta.project', vals: (it) => (it.projectKey ? [{ v: it.projectKey, l: it.project || it.projectKey }] : []) },
  { cle: 'reporter', i18n: 'jira.meta.reporter', vals: (it) => (it.reporter && it.reporter.name ? [{ v: it.reporter.name, l: it.reporter.name }] : []) },
  { cle: 'assignee', i18n: 'jira.meta.assignee', vals: (it) => (it.assignee && it.assignee.name ? [{ v: it.assignee.name, l: it.assignee.name }] : []) },
  { cle: 'labels', i18n: 'jira.meta.labels', vals: (it) => (it.labels || []).map((x) => ({ v: x, l: x })) },
  { cle: 'components', i18n: 'jira.meta.components', vals: (it) => (it.components || []).map((x) => ({ v: x, l: x })) },
  { cle: 'fixVersions', i18n: 'jira.meta.fixversions', vals: (it) => (it.fixVersions || []).map((x) => ({ v: x, l: x })) },
];
function jiraPasseFiltres(it, filtres, champs = JIRA_CHAMPS) {
  for (const ch of champs) {
    const choisies = (filtres && filtres[ch.cle]) || [];
    if (!choisies.length) continue;                       // critère sans valeur cochée = inactif
    const siennes = ch.vals(it).map((x) => x.v);
    if (!siennes.some((v) => choisies.includes(v))) return false;
  }
  return true;
}



/* ---------- Jira : filtre par sprint ---------------------------------------
   Le sprint est un vrai champ, et JQL sait le filtrer. La sélection part donc DANS la requête
   (`sprint IN (…)`), comme les projets : filtrer après coup ne trierait qu'un extrait de cent
   tickets, et les tickets du sprint voulu pourraient n'y être même pas.

   On mémorise les sprints CHOISIS (et non les masqués, contrairement aux statuts) : sans choix,
   on ne veut aucune contrainte, pas « tous les sprints » — un ticket hors sprint doit rester
   visible tant qu'on n'a rien demandé. */
const JIRA_SPRINT_KEY = 'aidevtools_jira_sprints';
function jiraSprintsChoisis() { try { const v = JSON.parse(localStorage.getItem(JIRA_SPRINT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function setJiraSprintsChoisis(l) { try { localStorage.setItem(JIRA_SPRINT_KEY, JSON.stringify(l)); } catch { /* stockage indisponible */ } }

/* Les sprints (comme les projets) sont filtrés PAR Jira : une fois un sprint choisi, les
   tickets rapportés n'en portent plus d'autre, et la liste des sprints proposés se réduirait
   à celui-là — impossible d'en cocher un second. On mémorise donc les valeurs vues quand
   AUCUNE contrainte n'est active, et on les propose toujours. */
function jiraMemoriseValeurs(cle, vues) {
  const memo = new Map((JIRA.connus[cle] || []).map((x) => [x.v, x]));
  // On garde la valeur ENTIÈRE (dont la date du sprint) : c'est elle qui sert au tri.
  for (const x of vues) memo.set(x.v, { ...x, n: undefined });
  JIRA.connus[cle] = [...memo.values()];
}
function jiraUnionValeurs(cle, vues) {
  const par = new Map((JIRA.connus[cle] || []).map((x) => [x.v, { ...x, n: 0 }]));
  for (const x of vues) par.set(x.v, x);
  return [...par.values()];
}

function jiraSprintsDistincts() {
  const par = new Map();
  for (const it of JIRA.issues) {
    for (const { v, l, d, etat } of (it.sprints || [])) {
      const e = par.get(v) || { v, l, d, etat, n: 0 };
      e.n += 1; par.set(v, e);
    }
  }
  /* Les plus récents en tête, par DATE de sprint. Un sprint sans date (Jira n'en donne pas
     toujours pour un sprint futur) retombe sur son identifiant, qui croît avec le temps —
     il passe donc après ceux qui en ont une, plutôt que d'atterrir n'importe où. */
  return jiraUnionValeurs('sprint', [...par.values()]).sort((a, b) => {
    /* Le sprint EN COURS d'abord : c'est celui qu'on cherche neuf fois sur dix, et la date
       seule ne le distingue pas — un sprint futur commence plus tard que lui. */
    const enCours = (x) => (x.etat === 'active' ? 0 : 1);
    if (enCours(a) !== enCours(b)) return enCours(a) - enCours(b);
    if (a.d && b.d && a.d !== b.d) return a.d < b.d ? 1 : -1;
    if (a.d && !b.d) return -1;
    if (!a.d && b.d) return 1;
    return Number(b.v) - Number(a.v);
  });
}

function jiraFilterSprintSearch() {
  const q = (($('#jiraSprintSearch') && $('#jiraSprintSearch').value) || '').toLowerCase().trim();
  $$('#jiraSprintFilterBody .jira-sf-item').forEach((it) => { it.hidden = !!q && !it.textContent.toLowerCase().includes(q); });
}

function renderJiraSprintFilter() {
  const det = $('#jiraSprintFilter'); const body = $('#jiraSprintFilterBody'); if (!det || !body) return;
  const vals = jiraSprintsDistincts();
  const choisis = jiraSprintsChoisis();
  /* Le panneau reste visible tant qu'une sélection est active, même si plus aucun ticket
     affiché ne porte ce sprint : sinon le filtre disparaîtrait avec le moyen de le retirer. */
  det.hidden = !vals.length && !choisis.length;
  if (det.hidden) return;
  const lignes = vals;
  body.innerHTML = lignes.map((x) => `<label class="jira-sf-item">
      <input type="checkbox" value="${esc(x.v)}"${choisis.includes(x.v) ? ' checked' : ''} />
      <span>${esc(x.l)}</span>${x.etat === 'active' ? ` <span class="muted">${esc(tr('jira.sprint-active'))}</span>` : ''}${x.n ? ` <span class="muted">${x.n}</span>` : ''}</label>`).join('');
  const cnt = $('#jiraSprintFilterCount');
  if (cnt) cnt.textContent = choisis.length ? tr('jira.ff.picked', { n: choisis.length, total: lignes.length }) : '';
  jiraFilterSprintSearch();
}

$('#jiraSprintFilterBody') && $('#jiraSprintFilterBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  const set = new Set(jiraSprintsChoisis());
  if (cb.checked) set.add(cb.value); else set.delete(cb.value);
  setJiraSprintsChoisis([...set]);
  loadJiraTickets();   // la contrainte est appliquée par Jira, pas ici
});
$('#jiraSprintSearch') && $('#jiraSprintSearch').addEventListener('input', jiraFilterSprintSearch);
$$('[data-jsfnone="sprint"]').forEach((b) => b.addEventListener('click', () => {
  setJiraSprintsChoisis([]);
  loadJiraTickets();
}));

const JIRA_FF_KEY = 'aidevtools_jira_filtres';
function jiraFiltres() {
  try {
    const v = JSON.parse(localStorage.getItem(JIRA_FF_KEY) || '{}');
    if (!v || typeof v !== 'object') return {};
    /* Le critère « projet » a stocké un temps le libellé « CLE — Nom » ; il porte désormais la
       CLÉ, seule forme qu'on puisse envoyer à Jira. On convertit à la lecture, sinon une
       sélection enregistrée ne correspondrait plus à rien et masquerait tout. */
    if (Array.isArray(v.project)) v.project = v.project.map((x) => String(x).split(' — ')[0]);
    return v;
  } catch { return {}; }
}
function setJiraFiltres(f) { try { localStorage.setItem(JIRA_FF_KEY, JSON.stringify(f)); } catch { /* stockage indisponible */ } }

// Valeurs distinctes d'un champ dans les tickets chargés, avec le nombre de tickets par valeur.
function jiraValeursDe(cle) {
  const ch = JIRA_CHAMPS.find((c) => c.cle === cle);
  if (!ch) return [];
  const par = new Map();
  for (const it of JIRA.issues) {
    for (const { v, l } of ch.vals(it)) {
      const e = par.get(v) || { v, l, n: 0 };
      e.n += 1; par.set(v, e);
    }
  }
  return jiraUnionValeurs(cle, [...par.values()])
    .sort((a, b) => a.l.localeCompare(b.l, undefined, { numeric: true }));
}

function renderJiraFieldFilter() {
  const det = $('#jiraFieldFilter'); const body = $('#jiraFieldFilterBody'); const pick = $('#jiraFieldFilterPick');
  if (!det || !body || !pick) return;
  // Champs réellement exploitables sur le jeu courant : proposer « Composants » quand aucun
  // ticket n'en porte ferait cliquer pour rien.
  const dispo = JIRA_CHAMPS.filter((c) => jiraValeursDe(c.cle).length > 0);
  det.hidden = !dispo.length;
  if (!dispo.length) return;

  const f = jiraFiltres();
  const actifs = Object.keys(f).filter((k) => JIRA_CHAMPS.some((c) => c.cle === k));
  const nb = actifs.reduce((n, k) => n + (f[k] || []).length, 0);
  const cnt = $('#jiraFieldFilterCount');
  if (cnt) cnt.textContent = nb ? tr('jira.ff.count', { n: nb, count: nb }) : '';

  pick.innerHTML = comboHtml('jf-champ', { ph: tr('jira.ff.add') });
  wireCombo(pick, 'jf-champ', () => dispo
    .filter((c) => !actifs.includes(c.cle))
    .map((c) => ({ value: c.cle, label: tr(c.i18n), hint: String(jiraValeursDe(c.cle).length) })));

  body.innerHTML = actifs.map((cle) => {
    const ch = JIRA_CHAMPS.find((c) => c.cle === cle);
    const choisies = f[cle] || [];
    const vals = jiraValeursDe(cle);
    return `<div class="jira-ff-crit" data-ffcrit="${esc(cle)}">
      <div class="jira-ff-head">
        <b>${esc(tr(ch.i18n))}</b>
        <span class="muted">${esc(tr('jira.ff.picked', { n: choisies.length, total: vals.length }))}</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-icon btn-sm" data-ffdel="${esc(cle)}" title="${esc(tr('jira.ff.remove'))}"><svg class="ico"><use href="#i-close"/></svg></button>
      </div>
      <input type="search" class="jira-sf-search" data-ffsearch="${esc(cle)}" placeholder="${esc(tr('jira.ff.search'))}" />
      <div class="jira-status-filter-body">
        ${vals.map((x) => `<label class="jira-sf-item" data-ffrow="${esc(String(x.l).toLowerCase())}">
          <input type="checkbox" data-ffval="${esc(cle)}" value="${esc(x.v)}"${choisies.includes(x.v) ? ' checked' : ''} />
          <span>${esc(x.l)}</span> <span class="muted">${x.n}</span></label>`).join('')}
      </div>
    </div>`;
  }).join('');
}

// Ajout d'un critère : le combo signale son choix par un `change` sur son input caché.
$('#jiraFieldFilterPick') && $('#jiraFieldFilterPick').addEventListener('change', (e) => {
  const h = e.target.closest('.jf-champ'); if (!h || !h.value) return;
  const f = jiraFiltres();
  if (!f[h.value]) f[h.value] = [];
  setJiraFiltres(f);
  renderJiraFieldFilter();
  renderJiraList();
});
$('#jiraFieldFilterBody') && $('#jiraFieldFilterBody').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-ffval]'); if (!cb) return;
  const f = jiraFiltres();
  const cle = cb.dataset.ffval;
  const set = new Set(f[cle] || []);
  if (cb.checked) set.add(cb.value); else set.delete(cb.value);
  f[cle] = [...set];
  setJiraFiltres(f);
  // Le projet est appliqué par Jira : changer la sélection change la requête, pas l'affichage.
  if (cle === 'project') { loadJiraTickets(); return; }
  // On ne redessine PAS le critère : cela replierait la recherche en cours et ferait
  // sauter le focus. Seuls le compteur et la liste des tickets bougent.
  const tete = cb.closest('.jira-ff-crit').querySelector('.jira-ff-head .muted');
  if (tete) tete.textContent = tr('jira.ff.picked', { n: f[cle].length, total: jiraValeursDe(cle).length });
  const nb = Object.values(jiraFiltres()).reduce((n, v) => n + v.length, 0);
  const cnt = $('#jiraFieldFilterCount');
  if (cnt) cnt.textContent = nb ? tr('jira.ff.count', { n: nb, count: nb }) : '';
  renderJiraList();
});
$('#jiraFieldFilterBody') && $('#jiraFieldFilterBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ffdel]'); if (!b) return;
  const f = jiraFiltres();
  const avaitProjet = b.dataset.ffdel === 'project' && (f.project || []).length;
  delete f[b.dataset.ffdel];
  setJiraFiltres(f);
  if (avaitProjet) { loadJiraTickets(); return; }
  renderJiraFieldFilter();
  renderJiraList();
});
/* La recherche MASQUE les lignes sans rien décocher : un filtre qui décoche en cachant
   ferait perdre une sélection sans le dire. */
$('#jiraFieldFilterBody') && $('#jiraFieldFilterBody').addEventListener('input', (e) => {
  const s = e.target.closest('[data-ffsearch]'); if (!s) return;
  const q = (s.value || '').toLowerCase().trim();
  for (const row of $$('[data-ffrow]', s.closest('.jira-ff-crit'))) {
    row.hidden = !!q && !row.dataset.ffrow.includes(q);
  }
});

function jiraVisibleIssues() {
  const q = ($('#jiraSearch').value || '').toLowerCase().trim();
  const hidden = jiraHiddenStatuses();
  // L'epic entre dans la recherche : « montre-moi les tickets de tel epic » est une demande courante.
  const foin = (it) => `${it.key} ${it.summary} ${it.epic ? `${it.epic.key} ${it.epic.summary}` : ''}`.toLowerCase();
  const filtres = jiraFiltres();
  return JIRA.issues.filter((it) => (!q || foin(it).includes(q)) && !hidden.has(it.status)
    && jiraPasseFiltres(it, filtres));
}
function jiraUpdateStatusFilterCount() {
  const el = $('#jiraStatusFilterCount'); if (!el) return;
  const statuses = jiraDistinctStatuses(); const hidden = jiraHiddenStatuses();
  el.textContent = tr('jira.status-filter-count', { shown: statuses.filter((s) => !hidden.has(s.status)).length, total: statuses.length });
}
/* Comme pour les assignés : la recherche MASQUE les lignes, elle ne décoche rien. Un filtre
   qui décocherait en cachant ferait perdre une sélection sans le dire. */
function jiraFilterStatusSearch() {
  const q = (($('#jiraStatusSearch') && $('#jiraStatusSearch').value) || '').toLowerCase().trim();
  $$('#jiraStatusFilterBody .jira-sf-item').forEach((it) => { it.hidden = !!q && !it.textContent.toLowerCase().includes(q); });
}
function renderJiraStatusFilter() {
  const det = $('#jiraStatusFilter'); const body = $('#jiraStatusFilterBody'); if (!det || !body) return;
  const statuses = jiraDistinctStatuses();
  if (statuses.length <= 1) { det.hidden = true; return; }   // pas de filtre utile s'il n'y a qu'un statut
  det.hidden = false;
  const hidden = jiraHiddenStatuses();
  body.innerHTML = statuses.map(({ status, cat }) => `<label class="jira-sf-item">
      <input type="checkbox" value="${esc(status)}"${hidden.has(status) ? '' : ' checked'} />
      <span class="jira-status jira-status-${JIRA_CAT[cat] || 'todo'}">${esc(status)}</span></label>`).join('');
  jiraUpdateStatusFilterCount();
  jiraFilterStatusSearch(); // conserve la recherche courante après reconstruction
}
function renderJiraList() {
  const box = $('#jiraList'); if (!box) return;
  const items = jiraVisibleIssues();
  // Compteur = nombre de tickets APRÈS filtres (assigné côté serveur + statut/recherche côté client).
  if ($('#jiraInfo')) {
    /* Jira plafonne à cent résultats, triés par date de mise à jour. Sans le dire, on croit voir
       « tous » les tickets et on s'étonne qu'un filtre en fasse disparaître. */
    const tronque = JIRA.total != null && JIRA.total > JIRA.issues.length;
    $('#jiraInfo').textContent = tr('jira.count', { n: items.length, count: items.length })
      + (tronque ? ` · ${tr('jira.truncated', { total: JIRA.total, shown: JIRA.issues.length })}` : '');
  }
  if (!items.length) { box.innerHTML = `<p class="muted jira-empty">${esc(tr('jira.no-match'))}</p>`; return; }
  box.innerHTML = items.map((it) => `<button class="jira-item jira-cat-${JIRA_CAT[it.statusCategory] || 'todo'}${it.key === JIRA.selectedKey ? ' active' : ''}" data-jira="${esc(it.key)}">
      <div class="jira-item-row1"><code class="jira-key">${esc(it.key)}</code> ${jiraStatusChip(it)}</div>
      ${it.epic ? `<span class="jira-item-epic" title="${esc(tr('jira.epic-of', { key: it.epic.key, summary: it.epic.summary }))}"><svg class="ico ico-sm"><use href="#i-tag"/></svg><code>${esc(it.epic.key)}</code> ${esc(it.epic.summary)}</span>` : ''}
      <div class="jira-item-summary">${esc(it.summary)}</div>
      <div class="jira-item-foot muted">${esc(it.type || '')}${it.priority ? ` · ${esc(it.priority)}` : ''} · ${esc(fmtDate(it.updated))}</div>
    </button>`).join('');
}

function jiraMetaRow(label, valueHtml) {
  if (!valueHtml) return '';
  return `<div class="jira-meta-row"><span class="jira-meta-label muted">${esc(label)}</span><span class="jira-meta-val">${valueHtml}</span></div>`;
}

function jiraAttachmentsBlock(it) {
  const list = it.attachments || [];
  if (!list.length) return '';
  const src = (a) => `/api/jira/attachment/${encodeURIComponent(a.id)}`;
  const isImg = (a) => /^image\//i.test(a.mimeType || '') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.filename || '');
  // Les IMAGES s'affichent directement (aperçu chargé via le proxy) ; clic = plein écran.
  const images = list.filter(isImg).map((a) => `<a class="jira-img" href="${src(a)}" data-jimg="${src(a)}" data-jname="${esc(a.filename)}" title="${esc(a.filename)}">
      <img src="${src(a)}" alt="${esc(a.filename)}" loading="lazy" />
      <span class="jira-img-name muted">${esc(a.filename)}</span>
    </a>`).join('');
  // Les autres fichiers restent en « chip » téléchargeable.
  const files = list.filter((a) => !isImg(a)).map((a) => `<a class="jira-attach" href="${src(a)}" download="${esc(a.filename)}" title="${esc(tr('jira.download'))}">
      <svg class="ico"><use href="#i-clip"/></svg>
      <span class="jira-attach-name">${esc(a.filename)}</span>
      <span class="jira-attach-size muted">${esc(jiraSize(a.size))}</span>
      <svg class="ico ico-sm jira-attach-dl"><use href="#i-download"/></svg>
    </a>`).join('');
  return `<div class="jira-section"><h4>${esc(tr('jira.attachments', { n: list.length, count: list.length }))}</h4>
      ${images ? `<div class="jira-img-grid">${images}</div>` : ''}
      ${files ? `<div class="jira-attachments">${files}</div>` : ''}</div>`;
}

/* Le détail d'un ticket s'affiche dans DEUX endroits — « Mes tickets » et « Surveillés » —
   avec exactement les mêmes actions (transitions, commentaires, pièces jointes, « faire coder
   l'IA »). D'où un conteneur en paramètre plutôt qu'un second rendu : deux copies finiraient
   par diverger, et c'est le genre d'écart qu'on ne voit qu'en production. */
function renderJiraDetail(it, box = $('#jiraDetail')) {
  if (!box) return;
  JIRA.current = it || null; // gardé pour ajouter un commentaire sans tout recharger
  JIRA.currentBox = box;     // …et pour le réafficher au bon endroit
  if (!it) { box.innerHTML = ''; return; }
  const person = (p) => (p ? esc(p.name) : '—');
  const chips = [
    it.type ? `<span class="jira-chip">${esc(it.type)}</span>` : '',
    it.priority ? `<span class="jira-chip">${esc(tr('jira.meta.priority'))} : ${esc(it.priority)}</span>` : '',
    it.assignee ? `<span class="jira-chip">${esc(tr('jira.meta.assignee'))} : ${esc(it.assignee.name)}</span>` : '',
  ].join('');
  const meta = [
    jiraMetaRow(tr('jira.meta.reporter'), person(it.reporter)),
    jiraMetaRow(tr('jira.meta.project'), esc(it.project)),
    it.epic ? jiraMetaRow(tr('jira.meta.epic'), it.epic.url
      ? `<a href="${esc(it.epic.url)}" target="_blank" rel="noopener" class="jira-epic-link" title="${esc(tr('jira.epic-open', { key: it.epic.key, summary: it.epic.summary }))}"><code>${esc(it.epic.key)}</code> ${esc(it.epic.summary)} ↗</a>`
      : `<code>${esc(it.epic.key)}</code> ${esc(it.epic.summary)}`) : '',
    jiraMetaRow(tr('jira.meta.created'), esc(fmtDate(it.created))),
    jiraMetaRow(tr('jira.meta.updated'), esc(fmtDate(it.updated))),
    it.duedate ? jiraMetaRow(tr('jira.meta.due'), esc(fmtDate(it.duedate))) : '',
    (it.labels && it.labels.length) ? jiraMetaRow(tr('jira.meta.labels'), it.labels.map((l) => `<span class="jira-label">${esc(l)}</span>`).join(' ')) : '',
    (it.components && it.components.length) ? jiraMetaRow(tr('jira.meta.components'), esc(it.components.join(', '))) : '',
    (it.fixVersions && it.fixVersions.length) ? jiraMetaRow(tr('jira.meta.fixversions'), esc(it.fixVersions.join(', '))) : '',
  ].join('');
  const cList = (it.comments || []).length
    ? (it.comments || []).map((c) => `<div class="jira-comment">
          <div class="jira-avatar" aria-hidden="true">${esc(jiraInitials(c.author))}</div>
          <div class="jira-comment-main">
            <div class="jira-comment-head"><strong>${esc(c.author)}</strong> <span class="muted">${esc(fmtDate(c.created))}</span></div>
            <div class="jira-comment-body md-body">${mdToHtml(c.bodyMd || '')}</div>
          </div></div>`).join('')
    : `<p class="muted">${esc(tr('jira.no-comment'))}</p>`;
  // Composer : poster un commentaire (texte simple → converti en ADF côté serveur).
  const composer = `<form class="jira-comment-form" data-key="${esc(it.key)}" autocomplete="off">
      <textarea class="jira-comment-input" rows="3" placeholder="${esc(tr('jira.comment-ph'))}"></textarea>
      <div class="jira-comment-actions"><button class="btn btn-primary btn-sm" type="submit"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(tr('jira.add-comment'))}</button></div>
    </form>`;
  const comments = `<div class="jira-section"><h4>${esc(tr('jira.comments', { n: (it.comments || []).length, count: (it.comments || []).length }))}</h4>${cList}${composer}</div>`;
  box.innerHTML = `<article class="jira-detail-inner jira-cat-${JIRA_CAT[it.statusCategory] || 'todo'}">
      <header class="jira-dhead">
        <div class="jira-dhead-top">
          <code class="jira-key">${esc(it.key)}</code>
          ${jiraStatusChip(it)}
          ${(it.transitions && it.transitions.length) ? `<select class="jira-transition" data-key="${esc(it.key)}" aria-label="${esc(tr('jira.change-status'))}">
            <option value="">${esc(tr('jira.change-status'))}</option>
            ${it.transitions.map((tt) => `<option value="${esc(tt.id)}">→ ${esc(tt.to ? tt.to.name : tt.name)}</option>`).join('')}
          </select>` : ''}
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm${jiraIsWatched(it.key) ? ' active' : ''}" data-jirawatch="${esc(it.key)}" title="${esc(tr(jiraIsWatched(it.key) ? 'jira.watch.stop-title' : 'jira.watch.start-title'))}"><svg class="ico ico-sm"><use href="#i-eye"/></svg>${esc(tr(jiraIsWatched(it.key) ? 'jira.watch.stop' : 'jira.watch.start'))}</button>
          ${addTodoBtn('ticket', it.key, tr('notes.add-todo.ticket', { key: it.key, title: String(it.summary || '').slice(0, 60) }))}
          <button type="button" class="btn btn-sm btn-primary" data-jiracode="${esc(it.key)}" title="${esc(tr('jira.code-title'))}"><svg class="ico ico-sm"><use href="#i-bot"/></svg>${esc(tr('jira.code'))}</button>
          <a href="${esc(it.url)}" target="_blank" rel="noopener" class="jira-open">${esc(tr('jira.open'))} ↗</a>
        </div>
        <h2 class="jira-title">${esc(it.summary)}</h2>
        <div class="jira-chips">${chips}</div>
      </header>
      <div class="jira-section"><h4>${esc(tr('jira.description'))}</h4>
        <div class="jira-card md-body">${it.descriptionMd ? mdToHtml(it.descriptionMd) : `<p class="muted">${esc(tr('jira.no-description'))}</p>`}</div>
      </div>
      ${jiraAttachmentsBlock(it)}
      <div class="jira-section"><h4>${esc(tr('jira.details'))}</h4><div class="jira-meta">${meta}</div></div>
      ${comments}
    </article>`;
}

/* `ou` : 'mine' (Mes tickets) ou 'watch' (Surveillés). Les deux sous-onglets ont leur propre
   liste et leur propre sélection — passer de l'un à l'autre ne doit pas déplacer le curseur
   de celui qu'on vient de quitter. */
async function selectJiraIssue(key, ou = 'mine') {
  const surveille = ou === 'watch';
  const box = $(surveille ? '#jiraWatchDetail' : '#jiraDetail');
  if (!box) return;
  if (surveille) { JIRA_WATCH.selectedKey = key; renderJiraWatch(); }
  else { JIRA.selectedKey = key; renderJiraList(); }
  box.innerHTML = skeleton(2);
  try {
    const d = await api(`/jira/issue/${encodeURIComponent(key)}`);
    /* Synchronise l'entrée de la liste (statut/priorité/date) avec le détail à jour — utile
       notamment après un changement d'état. Côté surveillés, l'état affiché vient de la
       dernière vérification : le détail est plus frais, on en profite. */
    const li = JIRA.issues.find((x) => x.key === key);
    if (li && d.issue) { li.status = d.issue.status; li.statusCategory = d.issue.statusCategory; li.priority = d.issue.priority; li.updated = d.issue.updated; renderJiraList(); }
    const w = JIRA_WATCH.rows.find((x) => x.key === key);
    if (w && d.issue) { w.status = d.issue.status; w.status_category = d.issue.statusCategory; if (surveille) renderJiraWatch(); }
    renderJiraDetail(d.issue, box);
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); }
}

// Filtre par ASSIGNÉ (persisté) : on mémorise les accountIds COCHÉS. Non défini → [moi].
function jiraCheckedAssignees() { try { const v = JSON.parse(localStorage.getItem('aidevtools_jira_assignees') || 'null'); return Array.isArray(v) ? v : null; } catch { return null; } }
function setJiraCheckedAssignees(arr) { try { localStorage.setItem('aidevtools_jira_assignees', JSON.stringify(arr)); } catch { /* ignore */ } }
function jiraCheckedSet() {
  const persisted = jiraCheckedAssignees();
  if (persisted) return new Set(persisted);
  return new Set(JIRA.me && JIRA.me.accountId ? [JIRA.me.accountId] : []); // défaut : moi seul
}
function jiraUpdateAssigneeCount() {
  const el = $('#jiraAssigneeFilterCount'); if (!el) return;
  el.textContent = tr('jira.status-filter-count', { shown: jiraCheckedSet().size, total: JIRA.people.length });
}
// Filtre la LISTE des personnes (pas les tickets) selon la recherche de personne.
function jiraFilterAssigneeSearch() {
  const q = (($('#jiraAssigneeSearch') && $('#jiraAssigneeSearch').value) || '').toLowerCase().trim();
  $$('#jiraAssigneeFilterBody .jira-sf-item').forEach((it) => { it.hidden = !!q && !it.textContent.toLowerCase().includes(q); });
}
function renderJiraAssigneeFilter() {
  const det = $('#jiraAssigneeFilter'); const body = $('#jiraAssigneeFilterBody'); if (!det || !body) return;
  if (!JIRA.people.length) { det.hidden = true; return; }
  det.hidden = false;
  const checked = jiraCheckedSet();
  body.innerHTML = JIRA.people.map((p) => `<label class="jira-sf-item">
      <input type="checkbox" value="${esc(p.accountId)}"${checked.has(p.accountId) ? ' checked' : ''} />
      <span class="jira-avatar jira-avatar-sm" aria-hidden="true">${esc(jiraInitials(p.name))}</span>
      <span>${esc(p.name)}${JIRA.me && p.accountId === JIRA.me.accountId ? ` <span class="muted">(${esc(tr('jira.me'))})</span>` : ''}</span></label>`).join('');
  jiraUpdateAssigneeCount();
  jiraFilterAssigneeSearch(); // conserve la recherche courante après reconstruction
}

// 1) charge « moi » + les personnes candidates ; 2) charge les tickets des personnes cochées.
async function loadJira() {
  const errBox = $('#jiraError'); errBox.innerHTML = '';
  $('#jiraList').innerHTML = skeleton(3); $('#jiraDetail').innerHTML = ''; $('#jiraInfo').textContent = '';
  try { $('#jiraIncludeDone').checked = localStorage.getItem('aidevtools_jira_done') === '1'; } catch { /* ignore */ }
  let a;
  try { a = await api('/jira/assignees'); }
  catch (e) { $('#jiraList').innerHTML = ''; errBox.innerHTML = errorBox(explainError(e.message)); return; }
  if (!a.configured) {
    errBox.innerHTML = '';
    // État « non configuré » actionnable (comme l'onboarding Reviews) plutôt qu'un simple message.
    $('#jiraList').innerHTML = emptyState({ icon: 'tag',
      title: tr('jira.not-configured.title'),
      text: tr('jira.not-configured'),
      actions: [{ act: 'go-jira-config', label: tr('jira.not-configured.cta'), primary: true }] });
    $('#jiraAssigneeFilter').hidden = true; $('#jiraStatusFilter').hidden = true;
    return;
  }
  JIRA.me = a.me; JIRA.people = a.people || [];
  renderJiraAssigneeFilter();
  // La liste surveillée est chargée AVEC l'onglet : le bouton « Surveiller » du détail doit
  // connaître l'état réel dès le premier rendu, sinon il propose d'ajouter un ticket déjà suivi.
  await loadJiraWatch();
  await loadJiraTickets();
  refreshJiraBadge();
}

async function loadJiraTickets() {
  $('#jiraList').innerHTML = skeleton(3);
  const done = $('#jiraIncludeDone').checked ? 1 : 0;
  const assignees = [...jiraCheckedSet()].join(',');
  // Les projets cochés sont appliqués PAR Jira : filtrer après coup ne verrait qu'un extrait.
  const projects = (jiraFiltres().project || []).join(',');
  const sprints = jiraSprintsChoisis().join(',');
  /* Séparateur « unité » (U+001F) : un nom de statut peut contenir une virgule
     (« En attente, client »), la virgule ne peut donc pas servir de séparateur. */
  const masques = [...jiraHiddenStatuses()].join('\u001f');
  let d;
  try { d = await api(`/jira/tickets?assignees=${encodeURIComponent(assignees)}&includeDone=${done}&projects=${encodeURIComponent(projects)}&sprints=${encodeURIComponent(sprints)}&hideStatuses=${encodeURIComponent(masques)}`); }
  catch (e) { $('#jiraList').innerHTML = ''; $('#jiraError').innerHTML = errorBox(explainError(e.message)); return; }
  JIRA.issues = d.issues || [];
  JIRA.total = d.total != null ? d.total : null;
  /* On ne mémorise que ce qu'on a vu SANS la contrainte correspondante : sinon on figerait
     une liste déjà réduite par le filtre lui-même. */
  if (!sprints) jiraMemoriseValeurs('sprint', JIRA.issues.flatMap((i) => i.sprints || []));
  if (!masques) {
    jiraMemoriseValeurs('status', JIRA.issues.filter((i) => i.status)
      .map((i) => ({ v: i.status, l: i.status, cat: i.statusCategory })));
  }
  if (!projects) {
    jiraMemoriseValeurs('project', JIRA.issues
      .filter((i) => i.projectKey).map((i) => ({ v: i.projectKey, l: i.project || i.projectKey })));
  }
  JIRA.selectedKey = null;
  $('#jiraInfo').textContent = tr('jira.count', { n: JIRA.issues.length, count: JIRA.issues.length });
  renderJiraStatusFilter();
  renderJiraSprintFilter();
  renderJiraFieldFilter();
  renderJiraList();
  const vis = jiraVisibleIssues();
  chargerStatutsDuWorkflow();   // complète la liste des statuts, sans bloquer l'affichage
  if (vis.length) selectJiraIssue(vis[0].key);
  else $('#jiraDetail').innerHTML = `<div class="jira-empty muted">${esc(tr(JIRA.issues.length ? 'jira.no-match' : 'jira.empty'))}</div>`;
}

/* ---------- Jira : tickets surveillés ----------------------------------------
   Surveiller un ticket n'a rien à voir avec « m'être affecté » : on suit souvent un ticket
   tenu par quelqu'un d'autre parce qu'il débloque le sien. C'est précisément pour ça que
   cette liste est un SOUS-ONGLET et pas un filtre de la première : elle n'a ni la même
   source, ni le même sens, et les mélanger rendrait le compteur incompréhensible. */
const JIRA_WATCH = { rows: [], keys: new Set(), selectedKey: null };
const jiraIsWatched = (key) => JIRA_WATCH.keys.has(String(key || '').toUpperCase());

function renderJiraWatch() {
  const box = $('#jiraWatchList'); if (!box) return;
  const rows = JIRA_WATCH.rows;
  const pastille = $('#jiraWatchCount');
  if (pastille) { pastille.textContent = rows.length; pastille.hidden = !rows.length; }
  if (!rows.length) {
    box.innerHTML = emptyState({ icon: 'eye', title: tr('jira.watch.empty.title'), text: tr('jira.watch.empty.text') });
    return;
  }
  box.innerHTML = rows.map((r) => `<div class="jira-item jira-watch-item jira-cat-${JIRA_CAT[r.status_category] || 'todo'}${r.key === JIRA_WATCH.selectedKey ? ' active' : ''}" data-jirawatchopen="${esc(r.key)}">
      <div class="jira-item-row1">
        ${r.url
          ? `<a class="jira-key jira-key-link" href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(tr('jira.watch.open', { key: r.key }))}">${esc(r.key)} ↗</a>`
          : `<code class="jira-key">${esc(r.key)}</code>`}
        <span class="jira-status jira-status-${JIRA_CAT[r.status_category] || 'todo'}">${esc(r.status || '—')}</span>
        <span class="spacer"></span>
        <button type="button" class="btn btn-icon btn-sm btn-danger" data-jiraunwatch="${esc(r.key)}" title="${esc(tr('jira.watch.stop-title'))}"><svg class="ico"><use href="#i-close"/></svg></button>
      </div>
      <div class="jira-item-summary">${esc(r.summary || '')}</div>
      ${/* La raison de surveiller. Absente, on propose de la dire : trois mois plus tard, une
            clé et un résumé ne rappellent plus pourquoi ce ticket est là. */''}
      <div class="jira-watch-note-row">
        ${r.note
    ? `<span class="jira-watch-note">${esc(r.note)}</span>`
    : `<span class="muted">${esc(tr('jira.watch.note-add'))}</span>`}
        <button type="button" class="btn btn-icon btn-sm" data-jiranote="${esc(r.key)}" title="${esc(tr('jira.watch.note-edit'))}"><svg class="ico ico-sm"><use href="#i-edit"/></svg></button>
      </div>
      <div class="jira-note-form" data-jiranoteform="${esc(r.key)}" hidden>
        <textarea class="jira-note-input" rows="3" maxlength="500" placeholder="${esc(tr('jira.watch.note-ph'))}" title="${esc(tr('jira.watch.note-hint'))}">${esc(r.note || '')}</textarea>
        <div class="jira-note-actions">
          <button type="button" class="btn btn-sm" data-jiranotecancel="${esc(r.key)}">${esc(tr('ui.cancel'))}</button>
          <button type="button" class="btn btn-sm btn-primary" data-jiranotesave="${esc(r.key)}">${esc(tr('jira.watch.note-save'))}</button>
        </div>
      </div>
      <div class="jira-item-foot muted">${r.changed_at
        ? esc(tr('jira.watch.changed-at', { at: fmtDate(r.changed_at) }))
        : esc(tr('jira.watch.no-change'))}${r.checked_at ? ` · ${esc(tr('jira.watch.checked-at', { at: fmtDate(r.checked_at) }))}` : ''}</div>
      ${r.error ? `<div class="jira-item-foot err">${esc(r.error)}</div>` : ''}
    </div>`).join('');
}

async function loadJiraWatch() {
  let d;
  try { d = await api('/jira/watch'); }
  catch { return; }   // la surveillance ne doit jamais casser l'onglet
  JIRA_WATCH.rows = d.watched || [];
  JIRA_WATCH.keys = new Set(JIRA_WATCH.rows.map((r) => String(r.key).toUpperCase()));
  renderJiraWatch();
}

async function jiraWatchAdd(key, note) {
  const k = String(key || '').trim().toUpperCase();
  if (!k) return;
  await api('/jira/watch', { method: 'POST', body: { key: k, note: note || '' } });
  await loadJiraWatch();
  toast(tr('toast.jira.watch-added', { key: k }));
}

$('#jiraWatchAdd') && $('#jiraWatchAdd').addEventListener('click', async (e) => {
  const inp = $('#jiraWatchKey');
  await busy(e.currentTarget, async () => {
    const note = $('#jiraWatchNote');
    try { await jiraWatchAdd(inp.value, note && note.value); inp.value = ''; if (note) note.value = ''; }
    catch (err) { toast(explainError(err.message), true); }
  });
});
$('#jiraWatchKey') && $('#jiraWatchKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#jiraWatchAdd').click(); }
});
/* La note est un textarea : Entrée y passe à la ligne, sinon on ne pourrait pas écrire les
   deux phrases pour lesquelles on l'a agrandie. C'est Ctrl/Cmd + Entrée qui valide. */
$('#jiraWatchNote') && $('#jiraWatchNote').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#jiraWatchAdd').click(); }
});
$('#jiraWatchList') && $('#jiraWatchList').addEventListener('keydown', (e) => {
  const champ = e.target.closest && e.target.closest('.jira-note-input');
  if (!champ) return;
  const f = champ.closest('.jira-note-form');
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    const b = $('[data-jiranotesave]', f); if (b) b.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    const b = $('[data-jiranotecancel]', f); if (b) b.click();
  }
});
$('#jiraWatchList') && $('#jiraWatchList').addEventListener('click', async (e) => {
  const form = (key) => $(`#jiraWatchList .jira-note-form[data-jiranoteform="${key}"]`);

  const ouvrir = e.target.closest('[data-jiranote]');
  if (ouvrir) {
    const f = form(ouvrir.dataset.jiranote);
    if (f) { f.hidden = false; const i = $('.jira-note-input', f); i.focus(); i.select(); }
    return;
  }
  const annuler = e.target.closest('[data-jiranotecancel]');
  if (annuler) {
    const f = form(annuler.dataset.jiranotecancel);
    // On rétablit la valeur enregistrée : annuler doit vraiment annuler, y compris à la réouverture.
    const ligne = JIRA_WATCH.rows.find((r) => r.key === annuler.dataset.jiranotecancel);
    if (f) { $('.jira-note-input', f).value = (ligne && ligne.note) || ''; f.hidden = true; }
    return;
  }
  const enregistrer = e.target.closest('[data-jiranotesave]');
  if (enregistrer) {
    const key = enregistrer.dataset.jiranotesave;
    const f = form(key);
    try {
      await busy(enregistrer, () => api(`/jira/watch/${encodeURIComponent(key)}`, {
        method: 'PATCH', body: { note: $('.jira-note-input', f).value },
      }));
      await loadJiraWatch();
      toast(tr('jira.watch.note-saved', { key }));
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }

  const b = e.target.closest('[data-jiraunwatch]');
  if (b) {
    try {
      await api(`/jira/watch/${encodeURIComponent(b.dataset.jiraunwatch)}`, { method: 'DELETE' });
      // Le ticket retiré était peut-être celui affiché à droite : le panneau doit suivre.
      if (JIRA_WATCH.selectedKey === b.dataset.jiraunwatch) {
        JIRA_WATCH.selectedKey = null;
        $('#jiraWatchDetail').innerHTML = '';
      }
      await loadJiraWatch();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }

  /* Clic sur la carte : on ouvre le ticket à droite. Les contrôles de la carte (retirer,
     modifier la raison, lien vers Jira) gardent leur propre effet — sans cette exclusion,
     ouvrir le formulaire de note sélectionnerait aussi le ticket, ce qui n'est pas demandé. */
  const carte = e.target.closest('[data-jirawatchopen]');
  if (carte && !e.target.closest('button, a, input, textarea, .jira-note-form')) {
    selectJiraIssue(carte.dataset.jirawatchopen, 'watch');
  }
});
$('#jiraWatchCheck') && $('#jiraWatchCheck').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try {
    const r = await api('/jira/watch/check', { method: 'POST' });
    await loadJiraWatch();
    // On dit ce qui a été VU, pas « c'est fait » : zéro changement est une information.
    toast(tr(r.changed ? 'toast.jira.watch-changed' : 'toast.jira.watch-none', { n: r.changed, count: r.changed }));
  } catch (err) { toast(explainError(err.message), true); }
}));

// Bouton « Surveiller » du détail d'un ticket : bascule, puis redessine l'en-tête.
/* Le détail vit dans deux panneaux (Mes tickets · Surveillés) et porte les mêmes actions.
   On câble donc chaque gestionnaire SUR LES DEUX, une fois pour toutes : dupliquer les
   écouteurs par sous-onglet, c'est se garantir qu'une action marchera d'un côté seulement. */
function surLeDetailJira(type, handler) {
  $$('.js-jira-detail').forEach((el) => el.addEventListener(type, handler));
}
// Dans quel panneau l'action a-t-elle eu lieu ? Ce qui est rechargé ensuite en dépend :
// recharger « Mes tickets » depuis le panneau des surveillés viderait celui qu'on regarde.
const ouDuDetail = (e) => (e.currentTarget && e.currentTarget.id === 'jiraWatchDetail' ? 'watch' : 'mine');

surLeDetailJira('click', async (e) => {
  const b = e.target.closest('[data-jirawatch]'); if (!b) return;
  const key = b.dataset.jirawatch;
  try {
    if (jiraIsWatched(key)) { await api(`/jira/watch/${encodeURIComponent(key)}`, { method: 'DELETE' }); await loadJiraWatch(); toast(tr('toast.jira.watch-removed', { key })); }
    else await jiraWatchAdd(key);
    selectJiraIssue(key, ouDuDetail(e));
  } catch (err) { toast(explainError(err.message), true); }
});

// Sous-onglets de Jira.
function showJiraSub(sub) {
  $$('#tab-jira .subnav [data-jsub]').forEach((b) => b.classList.toggle('active', b.dataset.jsub === sub));
  $('#jiraSubMine').hidden = sub !== 'mine';
  $('#jiraSubWatch').hidden = sub !== 'watch';
  if (sub === 'watch') loadJiraWatch();
}
$$('#tab-jira .subnav [data-jsub]').forEach((b) => b.addEventListener('click', () => showJiraSub(b.dataset.jsub)));

/* Pastille du menu : combien de tickets me sont affectés ET en cours. La valeur vient d'un
   cache serveur, jamais d'un appel Jira direct — on peut donc l'interroger tranquillement
   sans dépendre de l'ouverture de l'onglet. */
async function refreshJiraBadge() {
  const el = $('#navCountJira'); if (!el) return;
  try {
    const d = await api('/jira/badge');
    const n = d.configured ? (d.inProgress || 0) : 0;
    el.textContent = n;
    el.hidden = !n;
    el.title = n ? tr('jira.badge.title', { n, count: n }) : '';
  } catch { /* pastille : jamais bloquante */ }
}
setInterval(refreshJiraBadge, 60000);
refreshJiraBadge();

$('#jiraRefresh') && $('#jiraRefresh').addEventListener('click', loadJira);
$('#jiraIncludeDone') && $('#jiraIncludeDone').addEventListener('change', (e) => {
  try { localStorage.setItem('aidevtools_jira_done', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
  loadJiraTickets(); // re-fetch (le filtre terminés change la requête), garde le pool d'assignés
});
$('#jiraAssigneeFilterBody') && $('#jiraAssigneeFilterBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  const set = jiraCheckedSet();
  if (cb.checked) set.add(cb.value); else set.delete(cb.value);
  setJiraCheckedAssignees([...set]);
  jiraUpdateAssigneeCount(); // maj du compteur SANS reconstruire (préserve la recherche)
  loadJiraTickets();         // les assignés cochés changent la requête serveur
});
/* « Tout cocher » / « Tout décocher » des deux filtres. Les deux boutons vont ensemble : sans
   le premier, décocher tout devient un aller sans retour — il faudrait recocher une à une les
   quinze lignes qu'on vient de vider. */
/* Ciblage explicite : un `[data-jsfnone]` nu attrapait aussi le bouton du filtre par sprint,
   qui a son propre gestionnaire — et le faisait passer par la branche « statuts ». */
$$('[data-jsfall="assignee"], [data-jsfnone="assignee"], [data-jsfall="status"], [data-jsfnone="status"]').forEach((b) => b.addEventListener('click', () => {
  const quoi = b.dataset.jsfall || b.dataset.jsfnone;
  const tout = !!b.dataset.jsfall;
  if (quoi === 'assignee') {
    // Sélection vide = aucune contrainte d'assigné : le serveur renvoie tout ce que le compte voit.
    setJiraCheckedAssignees(tout ? JIRA.people.map((p) => p.accountId) : []);
    renderJiraAssigneeFilter();
    loadJiraTickets();          // les assignés cochés changent la requête serveur
  } else {
    const statuts = jiraDistinctStatuses().map((x) => x.status);
    setJiraHiddenStatuses(new Set(tout ? [] : statuts));
    renderJiraStatusFilter();
    renderJiraList();
    loadJiraTickets();
  }
}));

/* Un <details> ne se referme pas tout seul quand on clique ailleurs. Devenus des menus
   flottants au-dessus de la liste, ils masqueraient les tickets tant qu'on ne les rouvre pas. */
document.addEventListener('click', (e) => {
  for (const d of $$('.jira-filters > details[open]')) {
    if (!d.contains(e.target)) d.open = false;
  }
});

$('#jiraAssigneeSearch') && $('#jiraAssigneeSearch').addEventListener('input', jiraFilterAssigneeSearch);
$('#jiraStatusSearch') && $('#jiraStatusSearch').addEventListener('input', jiraFilterStatusSearch);
$('#jiraSearch') && $('#jiraSearch').addEventListener('input', renderJiraList);
$('#jiraStatusFilterBody') && $('#jiraStatusFilterBody').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
  const hidden = jiraHiddenStatuses();
  if (cb.checked) hidden.delete(cb.value); else hidden.add(cb.value);
  setJiraHiddenStatuses(hidden);
  jiraUpdateStatusFilterCount();
  renderJiraList();          // réponse immédiate, sans attendre le serveur
  loadJiraTickets();         // …puis on redemande : l'exclusion est appliquée par Jira
});
$('#jiraList') && $('#jiraList').addEventListener('click', (e) => {
  /* Dans la LISTE, l'epic n'est qu'une information : la carte est un bouton de sélection, et y
     loger une seconde cible de clic obligeait à viser. Le lien vers Jira vit dans le détail. */
  const b = e.target.closest('[data-jira]'); if (b) selectJiraIssue(b.dataset.jira);
});
// Lightbox : clic sur une vignette d'image → aperçu en grand (Échap/clic dehors ferme, cf. handler modales).
surLeDetailJira('click', (e) => {
  const code = e.target.closest('[data-jiracode]');
  if (code) { openTaskForJira(code.dataset.jiracode).catch((err) => toast(explainError(err.message), true)); return; }
  const img = e.target.closest('[data-jimg]'); if (!img) return; // vignettes ET images inline
  e.preventDefault();
  $('#jiraLightboxImg').src = img.dataset.jimg;
  $('#jiraLightboxImg').alt = img.dataset.jname || '';
  $('#jiraLightboxName').textContent = img.dataset.jname || '';
  $('#jiraLightboxOpen').href = img.dataset.jimg;
  $('#jiraLightbox').hidden = false;
});
$('#jiraLightbox') && $('#jiraLightbox').addEventListener('click', (e) => {
  // Clic sur le fond (pas sur l'image ni la légende) → fermer.
  if (e.target.id === 'jiraLightbox') e.currentTarget.hidden = true;
});
// Changer l'état du ticket : sélection d'une transition → POST → recharge le détail (+ la liste).
surLeDetailJira('change', async (e) => {
  const sel = e.target.closest('.jira-transition'); if (!sel || !sel.value) return;
  const key = sel.dataset.key; const transitionId = sel.value;
  sel.disabled = true;
  try {
    await api(`/jira/issue/${encodeURIComponent(key)}/transition`, { method: 'POST', body: { transitionId } });
    toast(tr('jira.status-changed'));
    await selectJiraIssue(key, ouDuDetail(e)); // détail re-fetché : nouvel état + nouvelles transitions possibles
    // La pastille du menu compte les tickets EN COURS : ce qu'on vient de faire la change.
    // Sans ça elle reste fausse jusqu'au prochain sondage, soit une minute d'affichage faux.
    refreshJiraBadge();
  } catch (err) { toast(explainError(err.message), true); sel.disabled = false; }
});
// Poster un commentaire : on l'ajoute au détail affiché sans tout recharger.
surLeDetailJira('submit', async (e) => {
  const form = e.target.closest('.jira-comment-form'); if (!form) return;
  e.preventDefault();
  const key = form.dataset.key;
  const ta = $('.jira-comment-input', form);
  const text = (ta.value || '').trim();
  if (!text) { toast(tr('err.jira.comment-empty'), true); return; }
  const btn = $('button[type="submit"]', form);
  try {
    const d = await busy(btn, () => api(`/jira/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: { text } }));
    toast(tr('jira.comment-added'));
    if (JIRA.current && JIRA.current.key === key && d.comment) {
      JIRA.current.comments = [...(JIRA.current.comments || []), d.comment];
      renderJiraDetail(JIRA.current, JIRA.currentBox);
    } else { await selectJiraIssue(key, ouDuDetail(e)); }
  } catch (err) { toast(explainError(err.message), true); }
});
function navTab(tab) { const b = $(`nav button[data-tab="${tab}"]`); if (b) b.click(); }
function navReviews(seg) { navTab('review'); loadSegment(seg); }
function navMrReport(id) { navTab('review'); loadSegment('reviewed'); setTimeout(() => { try { openReport(id); } catch { /* liste pas prête */ } }, 300); }

let notifSeq = 0;
function showNotif(title, body, onclick) {
  if (!notifSupported() || Notification.permission !== 'granted') return;
  try {
    // requireInteraction : la notif RESTE affichée jusqu'à action/fermeture (au lieu de
    // s'effacer en quelques secondes → risque de la manquer). Tag unique par appel pour
    // que des événements distincts ne s'écrasent pas entre eux.
    const n = new Notification(title, {
      body: body || '', icon: '/favicon.ico',
      tag: `aidevtools-${notifSeq++}`, requireInteraction: true,
    });
    n.onclick = () => { try { window.focus(); } catch { /* focus refusé */ } if (onclick) onclick(); n.close(); };
  } catch { /* certains navigateurs restreignent hors interaction : on ignore */ }
}

function handleNotifEvent(e, p) {
  switch (e.type) {
    case 'queue_done':
      if (p.queue_done) showNotif(tr('notif.queue-done.title'), tr('notif.queue-done.body', { n: e.count, count: e.count }), () => navReviews('reviewed'));
      break;
    case 'review_done':
      if (p.low_note && e.note10 != null && e.note10 < p.threshold) {
        showNotif(tr('notif.low-note.title', { iid: e.iid, note: e.note10 }), tr('notif.low-note.body'), () => navMrReport(e.mr_id));
      }
      break;
    case 'job_failed':
      if (p.job_failed) showNotif(tr('notif.job-failed.title'), e.message || '', () => (e.mr_id ? navMrReport(e.mr_id) : e.task_id ? navTab('task') : navReviews('to_review')));
      break;
    case 'session_done':
      if (p.session_done) showNotif(tr('notif.session-done.title'), tr('notif.session-done.body'), () => navTab('task'));
      break;
    case 'needs_input':
      if (p.needs_input) showNotif(tr('notif.needs-input.title'), tr('notif.needs-input.body'), () => navTab('task'));
      break;
    case 'converge_done':
      if (p.converge_done) {
        showNotif(
          tr(`notif.converge.${e.status === 'converged' ? 'converged' : 'stopped'}.title`, { iid: e.iid, note: e.note10 == null ? '—' : e.note10 }),
          tr('notif.converge.body', { passes: e.passes }),
          () => navMrReport(e.mr_id),
        );
      }
      break;
    case 'jira_status':
      /* Le corps porte l'ancien ET le nouvel état : « À faire → En cours » se lit d'un coup
         d'œil dans la notification, sans avoir à ouvrir l'outil pour comprendre. */
      if (p.jira_status) {
        showNotif(tr('notif.jira-status.title', { key: e.key }),
          tr('notif.jira-status.body', { from: e.from || '—', to: e.to || '—', summary: e.summary || '' }),
          () => { navTab('jira'); showJiraSub('watch'); });
      }
      break;
    case 'verify_done':
      /* Le verdict est ce qu'on attendait pour décider : on le met dans le TITRE, pas dans un
         corps qu'il faudrait déplier. Et on rafraîchit les listes, pour que le badge suive
         même si la notification n'est pas cliquée. */
      if (p.verify_done) {
        showNotif(tr(`notif.verify.${e.verdict === 'verified_pass' ? 'pass' : e.verdict === 'verified_fail' ? 'fail' : 'other'}.title`),
          tr('notif.verify.body'), () => openVerifyReport(e.verification_id));
      }
      break;
    case 'mr_new':
      if (p.mr_new) showNotif(tr('notif.mr-new.title', { iid: e.iid, project: e.project }), e.title || '', () => navReviews('to_review'));
      break;
    case 'mr_merged':
      if (p.mr_merged) showNotif(tr('notif.mr-merged.title', { iid: e.iid, project: e.project }), e.title || '', () => navReviews('reviewed'));
      break;
    default: break;
  }
}

let notifCursor = null; // dernier id vu ; null = pas encore initialisé (on ne rejoue pas l'historique)
async function pollNotifications() {
  let d;
  try { d = await api('/notifications?after=' + (notifCursor == null ? '' : notifCursor)); } catch { return; }
  // 1er passage : on cale le curseur sans rien afficher (pas de rejeu de l'historique).
  if (notifCursor == null) { notifCursor = d.latest; return; }
  const p = notifPrefs();
  /* Rafraîchir l'écran n'est PAS une notification : ça ne doit dépendre ni du mode silencieux
     ni d'une permission navigateur. Un verdict qui vient de tomber doit apparaître sur les
     badges même quand les notifications bureau sont refusées. */
  if ((d.events || []).some((e) => e.type === 'verify_done')) {
    if (currentSeg === 'to_review') loadToReview(); else loadReports(currentSeg);
    loadLots();
  }
  // Muet ou permission non accordée : on avance quand même le curseur (pas d'accumulation).
  if (!p.muted && notifPermission() === 'granted') {
    for (const e of (d.events || [])) handleNotifEvent(e, p);
  }
  notifCursor = d.latest;
}
setInterval(pollNotifications, 5000);
pollNotifications();
$("#footerMute") && $("#footerMute").addEventListener("click", toggleMute);
updateMuteBtn();

// Toggle « mode silencieux » du footer (un clic, sans passer par les Réglages).
function toggleMute() {
  const p = notifPrefs();
  p.muted = !p.muted;
  setNotifPrefs(p);
  updateMuteBtn();
  toast(p.muted ? tr('notif.muted-on') : tr('notif.muted-off'));
}
function updateMuteBtn() {
  const b = $('#footerMute');
  if (!b) return;
  const muted = notifPrefs().muted;
  b.classList.toggle('on', muted);
  b.title = muted ? tr('notif.unmute-title') : tr('notif.mute-title');
  const u = b.querySelector('use');
  if (u) u.setAttribute('href', muted ? '#i-bell-off' : '#i-bell');
}

/* ---------- Palette de commandes (Ctrl/Cmd+K) ----------
   On navigue entre sept onglets, une vingtaine de sous-onglets et des centaines de MR toute
   la journée. La palette transforme « où est cette MR déjà » en un réflexe.

   RÈGLE ABSOLUE : une entrée ne contient jamais de logique métier, seulement de quoi cliquer
   un bouton ou appeler une fonction de navigation qui existe déjà. Une palette qui
   réimplémente les actions devient une seconde interface, et elle dérive de la vraie au
   premier renommage. C'est aussi ce qui la rend testable par le contrôle statique des ids. */
const PALETTE_ACTIONS = [
  { key: 'palette.go.reviews', run: () => $('nav button[data-tab="review"]').click() },
  { key: 'palette.go.to-review', run: () => { $('nav button[data-tab="review"]').click(); loadSegment('to_review'); } },
  { key: 'palette.go.reviewed', run: () => { $('nav button[data-tab="review"]').click(); loadSegment('reviewed'); } },
  { key: 'palette.go.done', run: () => { $('nav button[data-tab="review"]').click(); loadSegment('done'); } },
  { key: 'palette.go.task', run: () => $('nav button[data-tab="task"]').click() },
  { key: 'palette.go.notes', run: () => { navTab('notes'); showNotesSub('today'); } },
  { key: 'palette.go.todos', run: () => { navTab('notes'); showNotesSub('todos'); } },
  { key: 'palette.go.pages', run: () => { navTab('notes'); showNotesSub('pages'); } },
  { key: 'palette.go.jira', run: () => $('nav button[data-tab="jira"]').click() },
  { key: 'palette.go.git', run: () => $('nav button[data-tab="git"]').click() },
  { key: 'palette.go.docker', run: () => $('nav button[data-tab="docker"]').click() },
  { key: 'palette.go.jenkins', run: () => $('nav button[data-tab="jenkins"]').click() },
  { key: 'palette.go.stats', run: () => $('nav button[data-tab="dashboard"]').click() },
  { key: 'palette.go.settings', run: () => $('nav button[data-tab="admin"]').click() },
  { key: 'palette.act.discover', run: () => { $('nav button[data-tab="review"]').click(); $('#btnDiscover').click(); } },
  { key: 'palette.act.review-all', run: () => { $('nav button[data-tab="review"]').click(); $('#btnReview').click(); } },
  { key: 'palette.act.new-task', run: () => { $('nav button[data-tab="task"]').click(); $('#btnNewTask').click(); } },
  { key: 'palette.act.new-todo', run: () => openCapture() },
  { key: 'palette.act.new-page', run: () => { navTab('notes'); showNotesSub('pages'); $('#pageNew').click(); } },
  { key: 'palette.act.logs', run: () => showLogPanel() },
  { key: 'palette.act.shortcuts', run: () => openShortcuts() },
];

let paletteItems = [];
let paletteIdx = 0;
let paletteSeq = 0;

/* Les ACTIONS que le client sait faire, envoyées au serveur avec la requête : lui seul
   connaît les liens, les MR et les notes, nous seuls savons ouvrir un onglet ou une modale.
   Les lister côté serveur aurait fait deux endroits à tenir d'accord. */
const paletteActions = () => PALETTE_ACTIONS.map((a, i) => ({ id: `act:${i}`, label: tr(a.key) }));

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
  paletteItems = (d.results || []).map((r) => ({
    label: r.label,
    kind: r.detail || tr(`palette.group.${r.group}`),
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
  if (r.url) { window.open(r.url, '_blank', 'noopener,noreferrer'); return; }
  if (r.action) {
    const i = Number(String(r.action).split(':')[1]);
    const a = PALETTE_ACTIONS[i];
    if (a) a.run();
    return;
  }
  const n = r.nav || {};
  if (n.mr_id) { navMrReport(n.mr_id); return; }
  if (n.ticket) { navTab('jira'); showJiraSub('mine'); selectJiraIssue(n.ticket, 'mine'); return; }
  if (n.page_id) { navTab('notes'); showNotesSub('pages'); openNotePage(n.page_id); return; }
  if (n.todo_id) { navTab('notes'); showNotesSub('todos'); return; }
  if (n.tab) navTab(n.tab);
}

// Conservé pour les tests hors ligne et l'ouverture instantanée : les actions locales.
function paletteMatches(q) {
  const out = PALETTE_ACTIONS.filter((a) => tr(a.key).toLowerCase().includes(q))
    .map((a) => ({ label: tr(a.key), kind: tr('palette.kind.action'), run: a.run }));
  if (q.length >= 2) {
    for (const m of [...toReviewRows, ...reportRows]) {
      if (!matchMr(m, q)) continue;
      out.push({
        label: `!${m.iid} — ${m.title || ''}`,
        kind: m.project,
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
        kind: tr(t2.kind === 'explore' ? 'task.kind.explore.btn' : 'task.kind.code.btn'),
        run: () => { $('nav button[data-tab="task"]').click(); $(`[data-kind="${t2.kind === 'explore' ? 'explore' : 'code'}"]`).click(); },
      });
    }
  }
  return out.slice(0, 8);
}

function renderPalette() {
  const box = $('#paletteList');
  if (!paletteItems.length) { box.innerHTML = `<div class="palette-empty muted">${esc(tr('palette.empty'))}</div>`; return; }
  box.innerHTML = paletteItems.map((it, i) => `<div class="palette-item${i === paletteIdx ? ' active' : ''}" role="option" data-i="${i}">`
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
$('#paletteInput') && $('#paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteItems.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteIdx); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('#paletteList') && $('#paletteList').addEventListener('click', (e) => {
  const it = e.target.closest('.palette-item');
  if (it) runPaletteItem(Number(it.dataset.i));
});
fermerAuFond('#paletteModal', closePalette, { salissable: false });
$('#paletteTrigger') && $('#paletteTrigger').addEventListener('click', () => openPalette());
// Redimensionner la fenêtre déplace le champ : la boîte le suit au lieu de rester en l'air.
window.addEventListener('resize', () => { if (!$('#paletteModal').hidden) placerPalette(); });
/* Le raccourci affiché doit être CELUI DU CLAVIER qu'on a sous les doigts : « Ctrl K » sur
   un Mac enverrait chercher une touche qui ne fait rien ici. */
(function libellerRaccourciPalette() {
  const k = $('#paletteKbd');
  if (!k) return;
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  k.textContent = mac ? '⌘ K' : 'Ctrl K';
})();

/* Feuille de raccourcis PERSISTANTE. Un toast de 3,5 s disparaissait pendant qu'on le lisait,
   ce qui est exactement le contraire de ce qu'on attend d'une aide. */
const SHORTCUTS = [
  ['Ctrl/Cmd + K', 'shortcuts.palette'],
  [null, 'shortcuts.tabs'],   // plage calculée au rendu : autant que d'onglets dans la barre
  ['/', 'shortcuts.search'],
  ['j / k', 'shortcuts.jk'],
  ['Entrée', 'shortcuts.enter'],
  ['d', 'shortcuts.diff'],
  ['r', 'shortcuts.discover'],
  ['n', 'shortcuts.notes'],
  ['o', 'shortcuts.palette-o'],
  ['l', 'shortcuts.logs'],
  ['?', 'shortcuts.help'],
  ['Échap', 'shortcuts.escape'],
];
function openShortcuts() {
  const m = $('#shortcutsModal'); if (!m) return;
  const nbOnglets = $$('nav button[data-tab]').length;
  // La plage annoncée doit être la VRAIE : au-delà de neuf onglets, le dixième est sur « 0 ».
  const plage = nbOnglets > 9 ? '1 – 9, 0' : `1 – ${nbOnglets}`;
  $('#shortcutsList').innerHTML = SHORTCUTS
    .map(([k, key]) => `<div class="shortcut-row"><kbd>${esc(k || plage)}</kbd><span>${esc(tr(key))}</span></div>`).join('');
  m.hidden = false;
}
$('#shortcutsClose') && $('#shortcutsClose').addEventListener('click', () => { $('#shortcutsModal').hidden = true; });
fermerAuFond('#shortcutsModal', () => { $('#shortcutsModal').hidden = true; }, { salissable: false });

/* ---------- Thème clair / sombre ----------
   Préférence locale au navigateur : 'auto' (suit le système), 'dark' ou 'light'.
   Le thème résolu est posé sur <html data-theme>, le CSS fait le reste.
   (Une première application a déjà lieu dans <head> pour éviter le flash.) */
(function theme() {
  const KEY = 'aidevtools_theme';
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const read = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
  const apply = (pref) => {
    const resolved = pref === 'auto' ? (mq.matches ? 'light' : 'dark') : pref;
    document.documentElement.setAttribute('data-theme', resolved);
  };
  const sel = $('#themeSelect');
  if (sel) {
    sel.value = read();
    sel.addEventListener('change', () => {
      const pref = sel.value;
      try { localStorage.setItem(KEY, pref); } catch { /* stockage indisponible */ }
      apply(pref);
    });
  }
  // en mode auto, on suit les changements de thème du système en direct
  const onSys = () => { if (read() === 'auto') apply('auto'); };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys); // navigateurs plus anciens
  apply(read());
})();

/* ---------- Densité (confortable / compact) ----------
   Préférence locale au navigateur ; posée sur <html data-density>, le CSS resserre les listes. */
(function density() {
  const KEY = 'mergerie_density';
  const read = () => { try { return localStorage.getItem(KEY) || 'cozy'; } catch { return 'cozy'; } };
  const apply = (v) => document.documentElement.setAttribute('data-density', v === 'compact' ? 'compact' : 'cozy');
  const sel = $('#densitySelect');
  if (sel) {
    sel.value = read();
    sel.addEventListener('change', () => {
      try { localStorage.setItem(KEY, sel.value); } catch { /* stockage indisponible */ }
      apply(sel.value);
    });
  }
  apply(read());
})();

/* Liste actuellement visible : celle dans laquelle `j`/`k` se déplacent. */
function listeCourante() {
  for (const sel of ['#toReviewList', '#reportList', '#taskList', '#localList']) {
    const el = $(sel);
    if (el && !el.hidden && el.offsetParent !== null && el.querySelector('.card')) return el;
  }
  return null;
}
const carteFocus = () => $('.card.focused');

/* AUCUN anneau au départ : il n'apparaît qu'à la première pression de `j` ou `k`. Un
   raccourci invisible qui agit sur un élément qu'on n'a pas désigné est un piège. */
function bougerFocusCarte(pas) {
  const liste = listeCourante();
  if (!liste) return;
  const cartes = $$('.card', liste);
  if (!cartes.length) return;
  const cur = cartes.indexOf(carteFocus());
  const next = cur === -1 ? (pas > 0 ? 0 : cartes.length - 1) : Math.min(cartes.length - 1, Math.max(0, cur + pas));
  cartes.forEach((c) => c.classList.remove('focused'));
  cartes[next].classList.add('focused');
  cartes[next].scrollIntoView({ block: 'nearest' });
}

/* ============ Onglet Notes : brief, todos et pages ============
   Des post-it de poste de travail, pas une base de connaissances. Tout est local, tout est
   déterministe : aucun appel IA, aucun token — le brief doit s'afficher instantanément à
   l'ouverture, avant même le premier café. */
const NOTES = {
  sub: 'today',
  filter: 'open',       // open | done | archived
  pages: [],
  pageId: null,
  page: null,
  index: { mrs: {}, jira: false },   // table de résolution de l'autolink
  open: [],             // todos ouvertes : sert à l'anti-doublon d'« Ajouter aux todos »
  affichees: [],        // la liste RÉELLEMENT à l'écran (le filtre courant), pour l'édition
};

const NOTES_SUBS = { today: 'notesSubToday', todos: 'notesSubTodos', pages: 'notesSubPages' };

function showNotesSub(sub) {
  NOTES.sub = NOTES_SUBS[sub] ? sub : 'today';
  $$('#tab-notes .subnav button').forEach((b) => b.classList.toggle('active', b.dataset.nsub === NOTES.sub));
  Object.entries(NOTES_SUBS).forEach(([k, id]) => { const el = $(`#${id}`); if (el) el.hidden = k !== NOTES.sub; });
  try { localStorage.setItem('mergerie_notes_sub', NOTES.sub); } catch { /* stockage indisponible */ }
  if (NOTES.sub !== 'pages') viderPageSave();
  if (NOTES.sub === 'today') loadBrief();
  if (NOTES.sub === 'todos') loadTodos();
  if (NOTES.sub === 'pages') loadPages();
}
$$('#tab-notes .subnav button').forEach((b) => b.addEventListener('click', () => showNotesSub(b.dataset.nsub)));

function loadNotes() {
  let sub = NOTES.sub;
  try { sub = localStorage.getItem('mergerie_notes_sub') || sub; } catch { /* stockage indisponible */ }
  showNotesSub(sub);
}

/* La table de résolution de l'autolink, mise en cache : elle change quand des MR arrivent,
   pas entre deux frappes. On la relit à chaque ouverture de l'onglet, pas à chaque rendu —
   une page qui se réaffiche à chaque caractère tapé ne doit pas interroger le serveur. */
async function notesIndex(force = false) {
  if (!force && NOTES.indexAt && Date.now() - NOTES.indexAt < 60000) return NOTES.index;
  try {
    NOTES.index = await api('/notes-index');
    NOTES.indexAt = Date.now();
  } catch { /* index indisponible : le texte reste du texte, sans lien mort */ }
  return NOTES.index;
}

/* Rendu Markdown + autolink. L'ordre importe : `mdToHtml` échappe, l'autolink s'applique
   APRÈS et n'injecte que des balises qu'il fabrique lui-même. On saute les blocs de code :
   `!42` dans un extrait de shell est du code, pas une merge request. */
const NOTE_CODE_RE = /(<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/;
function renderNoteMd(md) {
  const html = mdToHtml(md);
  return html.split(NOTE_CODE_RE)
    .map((part, i) => (i % 2 ? part : NOTESRT.autolink(part, NOTES.index)))
    .join('');
}

/* Clic sur un lien d'autolink : la navigation vit ici, pas dans le module de rendu, qui ne
   sait pas où sont les onglets. Délégation, comme partout ailleurs. */
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.note-link');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.noteMr) { navMrReport(Number(a.dataset.noteMr)); return; }
  if (a.dataset.noteMrSearch) {
    navReviews('reviewed');
    const s = $('#searchReview');
    if (s) { s.value = a.dataset.noteMrSearch; s.dispatchEvent(new Event('input')); }
    return;
  }
  if (a.dataset.noteTicket) { navTab('jira'); showJiraSub('mine'); selectJiraIssue(a.dataset.noteTicket, 'mine'); }
});

/* ---------- Le brief « Aujourd'hui » ---------- */

async function loadBrief() {
  const box = $('#briefBox');
  if (!box) return;
  box.innerHTML = skeleton(4);
  await notesIndex();
  let d;
  try { d = await api('/brief'); } catch (err) { box.innerHTML = `<p class="err">${esc(explainError(err.message))}</p>`; return; }
  renderBrief(d);
}

/* Une section vide n'est pas rendue. Un écran qui affiche sept titres dont six sous-titrés
   « rien » apprend qu'il ne s'est rien passé — ce qui n'était pas la question posée. */
function briefSection(titre, corps, { icon = 'inbox', hint = '' } = {}) {
  if (!corps) return '';
  return `<section class="brief-sec">
    <h3><svg class="ico"><use href="#i-${icon}"/></svg>${esc(titre)}</h3>
    ${hint ? `<p class="muted brief-hint">${esc(hint)}</p>` : ''}
    ${corps}
  </section>`;
}

/* Écarter une ligne : une croix discrète, à droite, sur chaque item qui peut revenir tous les
   matins. Sans confirmation — rien n'est supprimé, et « Tout réafficher » est au pied du brief. */
const briefHideBtn = (kind, ref) => `<button type="button" class="btn btn-icon btn-sm brief-hide" data-brief-hide="${kind}:${ref}" title="${esc(tr('notes.brief.hide'))}" aria-label="${esc(tr('notes.brief.hide'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button>`;

function renderBrief(d) {
  const box = $('#briefBox');
  const jour = new Date(d.date).toLocaleDateString(I18Nrt.currentLocale(), {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const rappels = (d.reminders || []).map((t) => briefTodoRow(t, true)).join('');
  const todos = (d.todos || []).map((t) => briefTodoRow(t, false)).join('');

  const sessions = (d.sessions || []).map((s) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(String(s.prompt || '').slice(0, 120))}</div>
        <div class="meta">${esc(tr('notes.brief.session.targets', { n: s.targets, count: s.targets }))}</div>
      </div>
      <button type="button" class="btn btn-sm btn-primary" data-brief-session="${s.task_id}">${esc(tr('notes.brief.session.go'))}</button>
      ${briefHideBtn('session', s.task_id)}
    </div>`).join('');

  const verifs = (d.verifications || []).map((v) => `<div class="brief-item">
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(v.lot_name || v.verifier_name || '')}${v.failed_label ? ` — <code>${esc(v.failed_label)}</code>` : ''}</div>
        <div class="meta">${esc(tr('notes.brief.verif.failed', { n: v.failed, count: v.failed }))}
          ${v.targets.map((c) => (c.iid ? ` · !${c.iid}` : '')).join('')}</div>
      </div>
      <button type="button" class="btn btn-sm" data-brief-verif="${v.verification_id}">${esc(tr('notes.brief.verif.go'))}</button>
      ${briefHideBtn('verification', v.verification_id)}
    </div>`).join('');

  const fresh = (d.fresh_mrs || []).map((m) => `<div class="brief-item brief-clickable" data-brief-mr="${m.id}">
      <div class="brief-item-main">
        <div class="brief-item-title">!${m.iid} — ${esc(m.title || '')}</div>
        <div class="meta">${esc(m.project)}${m.author ? ` · ${esc(m.author)}` : ''}</div>
      </div>
      ${briefHideBtn('mr', m.id)}
    </div>`).join('');

  const stale = (d.stale_mrs || []).map((m) => `<div class="brief-item brief-clickable" data-brief-mr="${m.id}">
      <div class="brief-item-main">
        <div class="brief-item-title">!${m.iid} — ${esc(m.title || '')}</div>
        <div class="meta">${esc(m.project)} · ${esc(tr('notes.brief.stale.line', { n: m.days, count: m.days }))}</div>
      </div>
      ${briefHideBtn('mr', m.id)}
    </div>`).join('');

  /* LES SESSIONS QUI ATTENDENT UN GESTE. Trois attentes, un seul oubli : le travail est fait,
     il ne manque qu'un clic. Des nombres, pas des listes — le détail vit dans Dev IA, et à trois
     lignes de plus le brief cesserait d'être un brief. Une attente à zéro ne s'affiche pas. */
  const ps = d.pending_sessions || {};
  const attentes = [
    ['to_run', 'notes.brief.sess.to-run', ps.to_run],
    ['to_push', 'notes.brief.sess.to-push', ps.to_push],
    ['to_mr', 'notes.brief.sess.to-mr', ps.to_mr],
  ].filter(([, , n]) => n > 0).map(([cle, k, n]) => `<div class="brief-item brief-clickable" data-brief-sess="${cle}">
      <div class="brief-item-main"><div class="brief-item-title">${esc(tr(k, { n, count: n }))}</div></div>
      ${briefHideBtn('sess', cle)}
    </div>`).join('');

  const a = d.activity;
  const activite = a ? `<p class="brief-activity">${[
    a.merged ? esc(tr('notes.brief.activity.merged', { n: a.merged, count: a.merged })) : '',
    a.opened ? esc(tr('notes.brief.activity.opened', { n: a.opened, count: a.opened })) : '',
    a.verified ? esc(tr('notes.brief.activity.verified', { n: a.verified, count: a.verified })) : '',
  ].filter(Boolean).join(' · ')}</p>` : '';

  const corps = [
    briefSection(tr('notes.brief.sec.reminders'), rappels, { icon: 'clock' }),
    briefSection(tr('notes.brief.sec.todos'), todos, { icon: 'check' }),
    briefSection(tr('notes.brief.sec.sessions'), sessions, { icon: 'bot' }),
    briefSection(tr('notes.brief.sec.verifications'), verifs, { icon: 'alert' }),
    briefSection(tr('notes.brief.sec.pending'), attentes, { icon: 'bot', hint: tr('notes.brief.pending.hint') }),
    briefSection(tr('notes.brief.sec.fresh'), fresh, { icon: 'merge', hint: tr('notes.brief.fresh.hint') }),
    briefSection(tr('notes.brief.sec.stale'), stale, { icon: 'clock', hint: tr('notes.brief.stale.hint', { n: d.stale_days }) }),
    briefSection(tr('notes.brief.sec.activity'), activite, { icon: 'chart' }),
  ].join('');

  box.innerHTML = `<header class="brief-head">
      <div class="brief-hello">${esc(tr('notes.brief.hello'))}</div>
      <div class="brief-date">${esc(jour)}</div>
    </header>
    ${corps || emptyState({ icon: 'check', title: esc(tr('notes.brief.empty.title')), text: esc(tr('notes.brief.empty.text')) })}
    ${d.hidden_count ? `<p class="brief-hidden-foot muted">${esc(tr('notes.brief.hidden', { n: d.hidden_count, count: d.hidden_count }))}
      <button type="button" class="btn btn-sm" id="briefRestore">${esc(tr('notes.brief.restore'))}</button></p>` : ''}`;
}

// Une ligne de todo dans le brief : cochable et snoozable sur place — c'est tout l'intérêt
// d'un brief, agir sans changer d'écran.
function briefTodoRow(t, avecSnooze) {
  return `<div class="brief-item todo-row" data-todo="${t.id}">
    <input type="checkbox" class="todo-check" data-todo-check="${t.id}" aria-label="${esc(tr('notes.todo.done'))}" />
    <div class="brief-item-main">
      <div class="brief-item-title">${esc(t.title)}</div>
      <div class="meta">${todoPrioBadge(t.priority)}${todoDueHtml(t)}${todoLinkHtml(t)}</div>
    </div>
    ${avecSnooze ? todoSnoozeHtml(t.id) : ''}
  </div>`;
}

/* Les deux pastilles du menu Notes, calculées depuis les todos ouvertes déjà en mémoire :
   ROUGE = ce qui presse, BLEU = le reste à faire. Leur somme est le nombre de todos à faire.

   « Presse » n'est pas seulement la priorité haute : une todo normale dont l'échéance est
   dépassée depuis trois jours réclame autant. Compter la seule priorité aurait laissé le
   retard invisible dans le menu — et le retard est précisément ce qu'on vient d'oublier.
   La bulle énumère la composition, pour qu'un chiffre qui ne correspond pas au nombre de
   pastilles « Haute » s'explique de lui-même. */
function majBadgeNotes() {
  const rouge = $('#navTodoUrgent');
  const bleu = $('#navCountNotes');
  if (!rouge || !bleu) return;
  const maintenant = Date.now();
  const ouvertes = NOTES.open || [];
  const enRetard = ouvertes.filter((t) => t.due_at && new Date(t.due_at).getTime() <= maintenant);
  const hautes = ouvertes.filter((t) => t.priority === 'high' && !enRetard.includes(t));
  const urgentes = enRetard.length + hautes.length;
  const reste = ouvertes.length - urgentes;

  const poser = (el, n, bulle) => {
    el.hidden = !n;
    el.textContent = String(n);
    el.dataset.tip = bulle;
    /* `title = ''` et non l'absence de title : sur un enfant, un title VIDE empêche le
       navigateur de remonter à celui du bouton parent — sans ça, survoler le chiffre
       afficherait « Notes, todos et rappels… » par-dessus notre bulle. */
    el.title = '';
    el.setAttribute('aria-label', bulle);
  };
  poser(rouge, urgentes, [
    enRetard.length ? tr('nav.todos.late', { n: enRetard.length, count: enRetard.length }) : '',
    hautes.length ? tr('nav.todos.high', { n: hautes.length, count: hautes.length }) : '',
  ].filter(Boolean).join(' · '));
  poser(bleu, reste, tr('nav.todos.rest', { n: reste, count: reste }));
}

document.addEventListener('click', async (e) => {
  /* La croix EST dans une ligne cliquable (une MR ouvre son rapport) : elle se teste donc en
     premier, sinon écarter une ligne l'ouvrirait en même temps. */
  const h = e.target.closest && e.target.closest('[data-brief-hide]');
  if (h) {
    const [kind, ...reste] = h.dataset.briefHide.split(':');
    try {
      await busy(h, () => api('/brief/hidden', { method: 'POST', body: { kind, ref: reste.join(':') } }));
      toast(tr('toast.brief-ecarte')); loadBrief();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const r = e.target.closest && e.target.closest('#briefRestore');
  if (r) {
    try {
      await busy(r, () => api('/brief/hidden', { method: 'DELETE' }));
      toast(tr('toast.brief-restaure')); loadBrief();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const s = e.target.closest && e.target.closest('[data-brief-session]');
  if (s) { navTab('task'); return; }
  const att = e.target.closest && e.target.closest('[data-brief-sess]');
  if (att) { navTab('task'); return; }
  const v = e.target.closest && e.target.closest('[data-brief-verif]');
  if (v) { openVerifyReport(Number(v.dataset.briefVerif)); return; }
  const m = e.target.closest && e.target.closest('[data-brief-mr]');
  if (m) navMrReport(Number(m.dataset.briefMr));
});

/* ---------- Todos ---------- */

function todoPrioBadge(p) {
  if (p === 'normal') return '';   // la normale est le cas courant : la baliser serait du bruit
  return `<span class="prio prio-${esc(p)}">${esc(tr(`notes.prio.${p}`))}</span>`;
}

/* L'échéance en RELATIF. « 2026-08-09 09:00 » oblige à calculer ; « demain 9 h » se lit.
   Le rouge est réservé au dépassé : une échéance à venir n'est pas une alarme. */
function todoDueLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return { texte: '', enRetard: false };
  const now = new Date();
  const jour = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dj = Math.round((jour(d) - jour(now)) / 86400000);
  if (d.getTime() < now.getTime()) {
    const retard = -dj;
    return {
      texte: retard >= 1 ? tr('notes.todo.due.overdue', { n: retard, count: retard }) : tr('notes.todo.due.now'),
      enRetard: true,
    };
  }
  if (dj === 0) return { texte: tr('notes.todo.due.today', { time: fmtHour(iso) }), enRetard: false };
  if (dj === 1) return { texte: tr('notes.todo.due.tomorrow', { time: fmtHour(iso) }), enRetard: false };
  return { texte: tr('notes.todo.due.in-days', { n: dj, count: dj }), enRetard: false };
}

function todoDueHtml(t) {
  if (!t.due_at) return '';
  const { texte, enRetard } = todoDueLabel(t.due_at);
  return `<span class="todo-due${enRetard ? ' late' : ''}" title="${esc(`${fmtDate(t.due_at)} ${fmtHour(t.due_at)}`)}">${svgIco('clock')} ${esc(texte)}</span>`;
}

const todoSnoozeHtml = (id) => `<span class="todo-snooze">
  <button type="button" class="btn btn-sm btn-ghost" data-snooze="hour" data-todo-id="${id}" title="${esc(tr('notes.todo.snooze.hour-title'))}">${esc(tr('notes.todo.snooze.hour'))}</button>
  <button type="button" class="btn btn-sm btn-ghost" data-snooze="tomorrow" data-todo-id="${id}" title="${esc(tr('notes.todo.snooze.tomorrow-title'))}">${esc(tr('notes.todo.snooze.tomorrow'))}</button>
</span>`;

/* Le lien vers l'objet suivi. Une MR dont l'id ne résout plus (rapport supprimé, dépôt
   retiré) reste affichée comme telle plutôt que de disparaître : la todo, elle, existe. */
function todoLinkHtml(t) {
  if (!t.link_kind || !t.link_ref) return '';
  if (t.link_kind === 'mr') {
    return `<a href="#" class="note-link" data-note-mr="${esc(t.link_ref)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('merge')} ${esc(tr('notes.todo.link.mr', { iid: todoMrIid(t.link_ref) }))}</a>`;
  }
  if (t.link_kind === 'ticket') {
    return `<a href="#" class="note-link" data-note-ticket="${esc(t.link_ref)}" title="${esc(tr('notes.todo.link-title'))}">${svgIco('tag')} ${esc(tr('notes.todo.link.ticket', { key: t.link_ref }))}</a>`;
  }
  return `<span class="muted">${svgIco('branch')} ${esc(tr('notes.todo.link.repo', { project: t.link_ref }))}</span>`;
}

// L'iid affiché vient de l'index d'autolink : la todo ne stocke que l'id interne, et un
// numéro interne n'a jamais rien dit à personne.
function todoMrIid(mrId) {
  for (const [iid, cands] of Object.entries(NOTES.index.mrs || {})) {
    if (cands.some((c) => String(c.id) === String(mrId))) return iid;
  }
  return '?';
}

async function loadTodos() {
  const box = $('#todoList');
  if (!box) return;
  box.innerHTML = skeleton(4);
  await notesIndex();
  let d;
  try { d = await api(`/todos?status=${encodeURIComponent(NOTES.filter)}`); }
  catch (e) { box.innerHTML = `<p class="err">${esc(explainError(e.message))}</p>`; return; }
  renderTodos(d.todos || []);
}

function renderTodos(rows) {
  NOTES.affichees = rows;   // le crayon existe aussi sous « Faites » et « Archivées »
  const box = $('#todoList');
  const info = $('#todoInfo');
  if (info) info.textContent = rows.length ? tr('notes.todo.count', { n: rows.length, count: rows.length }) : '';
  /* La pastille du sous-onglet ne bouge QUE sur la vue « à faire » : sur les faites ou les
     archivées, elle annoncerait un travail en attente qui n'existe pas. */
  if (NOTES.filter === 'open') {
    const b = $('#notesTodoCount');
    if (b) { b.hidden = !rows.length; b.textContent = String(rows.length); }
  }
  if (!rows.length) {
    const texte = NOTES.filter === 'archived'
      ? tr('notes.todo.empty.archived', { n: 7 })
      : NOTES.filter === 'done' ? tr('notes.todo.empty.done') : tr('notes.todo.empty.text');
    box.innerHTML = emptyState({ icon: 'check', title: esc(tr('notes.todo.empty.title')), text: esc(texte) });
    return;
  }
  /* On ne réordonne que « à faire » : les faites et les archivées ont un ordre chronologique
     qui leur est propre, et les arranger à la main n'aurait aucun sens. */
  const ordonnable = NOTES.filter === 'open';
  /* On ne réordonne qu'À L'INTÉRIEUR d'une priorité : la liste est d'abord triée par priorité,
     donc emmener une todo dans un autre groupe la ferait revenir aussitôt — un geste qui
     n'aboutit pas est pire que pas de geste. Les flèches s'éteignent donc aux bords du groupe. */
  const memeGroupe = (a, b2) => a && b2 && a.priority === b2.priority;
  box.innerHTML = rows.map((t, i) => `<div class="todo-row card${t.status === 'done' ? ' done' : ''}${ordonnable ? ' todo-move' : ''}" data-todo="${t.id}" data-prio="${esc(t.priority)}"${ordonnable ? ' draggable="true"' : ''}>
      ${ordonnable ? `<span class="todo-grip" aria-hidden="true" title="${esc(tr('notes.todo.reorder-title'))}">${svgIco('grip')}</span>` : ''}
      <input type="checkbox" class="todo-check" data-todo-check="${t.id}"${t.status === 'done' ? ' checked' : ''} aria-label="${esc(tr('notes.todo.done'))}" />
      <div class="brief-item-main">
        <div class="brief-item-title">${esc(t.title)}</div>
        <div class="meta">${todoPrioBadge(t.priority)}${todoDueHtml(t)}${todoLinkHtml(t)}
          ${t.archived_at ? `<span class="muted">${esc(tr('notes.todo.archived-at', { date: fmtDate(t.archived_at) }))}</span>` : ''}</div>
        ${t.note ? `<div class="todo-note md-body">${renderNoteMd(t.note)}</div>` : ''}
      </div>
      ${t.due_at && t.status === 'open' ? todoSnoozeHtml(t.id) : ''}
      ${ordonnable ? `<button type="button" class="btn btn-sm btn-ghost" data-todo-up="${t.id}"${memeGroupe(rows[i - 1], t) ? '' : ' disabled'} title="${esc(tr('notes.todo.up'))}" aria-label="${esc(tr('notes.todo.up'))}">${svgIco('up')}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-todo-down="${t.id}"${memeGroupe(rows[i + 1], t) ? '' : ' disabled'} title="${esc(tr('notes.todo.down'))}" aria-label="${esc(tr('notes.todo.down'))}">${svgIco('down')}</button>` : ''}
      <button type="button" class="btn btn-sm btn-ghost" data-todo-edit="${t.id}" title="${esc(tr('notes.todo.edit-title'))}">${svgIco('edit')}</button>
      <button type="button" class="btn btn-sm btn-ghost btn-danger" data-todo-del="${t.id}" title="${esc(tr('notes.todo.delete-title'))}">${svgIco('trash')}</button>
    </div>`).join('');
}

/* RÉORDONNER. Deux gestes pour le même résultat : le glisser-déposer, naturel à la souris,
   et deux flèches — qui existent pour le clavier et le tactile, où « glisser » n'est ni
   annonçable ni fiable. Les deux passent par la même route : l'écran envoie l'ordre COMPLET
   qu'il affiche, le serveur numérote. */
async function enregistrerOrdreTodos(ids) {
  try {
    await api('/todos/reorder', { method: 'POST', body: { ids } });
    NOTES.affichees = ids.map((id) => NOTES.affichees.find((t) => t.id === id)).filter(Boolean);
    renderTodos(NOTES.affichees);
  } catch (e) { toast(explainError(e.message), true); loadTodos(); }
}

function deplacerTodo(id, delta) {
  const liste = NOTES.affichees;
  const i = liste.findIndex((t) => t.id === Number(id));
  const j = i + delta;
  if (i === -1 || j < 0 || j >= liste.length) return;
  // Jamais hors du groupe de priorité : la todo reviendrait à sa place au rendu suivant.
  if (liste[j].priority !== liste[i].priority) return;
  const ids = liste.map((t) => t.id);
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  enregistrerOrdreTodos(ids);
}

$('#todoList') && $('#todoList').addEventListener('click', (e) => {
  const up = e.target.closest('[data-todo-up]');
  if (up) { deplacerTodo(up.dataset.todoUp, -1); return; }
  const down = e.target.closest('[data-todo-down]');
  if (down) deplacerTodo(down.dataset.todoDown, 1);
});

/* Glisser-déposer natif. On déplace la ligne DANS le DOM pendant le geste — sans ça, on
   déplace à l'aveugle et on ne sait pas où l'on va lâcher. L'ordre n'est enregistré qu'au
   lâcher : une liste qui appelle le serveur à chaque survol le ferait cent fois. */
let todoTire = null;
$('#todoList') && $('#todoList').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.todo-row.todo-move');
  if (!row) return;
  todoTire = row;
  row.classList.add('dragging');
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.dataset.todo); } catch { /* refusé */ } }
});
$('#todoList') && $('#todoList').addEventListener('dragover', (e) => {
  if (!todoTire) return;
  e.preventDefault();
  const cible = e.target.closest('.todo-row.todo-move');
  // Même règle que les flèches : on ne traverse pas une frontière de priorité.
  if (!cible || cible === todoTire || cible.dataset.prio !== todoTire.dataset.prio) return;
  const r = cible.getBoundingClientRect();
  // Au-dessus ou en dessous, selon le côté de la ligne où l'on est : le geste se voit.
  cible.parentNode.insertBefore(todoTire, e.clientY < r.top + r.height / 2 ? cible : cible.nextSibling);
});
$('#todoList') && $('#todoList').addEventListener('drop', (e) => { if (todoTire) e.preventDefault(); });
$('#todoList') && $('#todoList').addEventListener('dragend', () => {
  if (!todoTire) return;
  todoTire.classList.remove('dragging');
  todoTire = null;
  enregistrerOrdreTodos($$('#todoList .todo-row').map((r) => Number(r.dataset.todo)));
});

$$('#tab-notes .todo-filter button').forEach((b) => b.addEventListener('click', () => {
  NOTES.filter = b.dataset.tfilter;
  $$('#tab-notes .todo-filter button').forEach((x) => x.classList.toggle('active', x === b));
  loadTodos();
}));

// Ajout inline : le champ et le bouton font la même chose, parce qu'on tape puis on
// valide — sans quitter le clavier.
async function todoQuickAdd() {
  const input = $('#todoQuickAdd');
  const titre = (input.value || '').trim();
  if (!titre) return;
  try {
    await api('/todos', { method: 'POST', body: { title: titre } });
    input.value = '';
    await refreshOpenTodos();
    loadTodos();
  } catch (e) { toast(explainError(e.message), true); }
}
$('#todoQuickBtn') && $('#todoQuickBtn').addEventListener('click', () => todoQuickAdd());
$('#todoQuickAdd') && $('#todoQuickAdd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); todoQuickAdd(); }
});

/* Cocher, snoozer, éditer, supprimer — par délégation, parce que ces lignes sont rendues
   à trois endroits (brief, liste, et le brief se re-rend tout seul). */
document.addEventListener('change', async (e) => {
  const cb = e.target.closest && e.target.closest('[data-todo-check]');
  if (!cb) return;
  const id = Number(cb.dataset.todoCheck);
  try {
    await api(`/todos/${id}`, { method: 'PUT', body: { status: cb.checked ? 'done' : 'open' } });
    toast(tr(cb.checked ? 'notes.todo.done' : 'notes.todo.reopened'));
    await refreshOpenTodos();
    if (NOTES.sub === 'todos') loadTodos(); else loadBrief();
  } catch (err) { cb.checked = !cb.checked; toast(explainError(err.message), true); }
});

document.addEventListener('click', async (e) => {
  const sn = e.target.closest && e.target.closest('[data-snooze]');
  if (sn) {
    try {
      await api(`/todos/${Number(sn.dataset.todoId)}`, { method: 'PUT', body: { snooze: sn.dataset.snooze } });
      toast(tr('notes.todo.snoozed'));
      if (NOTES.sub === 'todos') loadTodos(); else loadBrief();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const del = e.target.closest && e.target.closest('[data-todo-del]');
  if (del) {
    if (!await confirmDialog({
      title: tr('notes.todo.delete'),
      text: tr('notes.todo.confirm-delete', { n: 7 }),
      confirmLabel: tr('notes.todo.delete'),
    })) return;
    try {
      await api(`/todos/${Number(del.dataset.todoDel)}`, { method: 'DELETE' });
      toast(tr('notes.todo.deleted'));
      await refreshOpenTodos();
      loadTodos();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const ed = e.target.closest && e.target.closest('[data-todo-edit]');
  if (ed) openCapture({ editId: Number(ed.dataset.todoEdit) });
});

// Les todos ouvertes en cache : elles servent à savoir si un objet est DÉJÀ suivi, pour ne
// pas proposer d'en créer une seconde qui dirait la même chose.
async function refreshOpenTodos() {
  try { NOTES.open = (await api('/todos?status=open')).todos || []; }
  catch { /* liste indisponible : le bouton proposera simplement de créer */ }
  majBadgeNotes();   // une seule porte d'entrée : qui relit la liste remet les pastilles à jour
}

/* ---------- Pages ---------- */

async function loadPages() {
  const box = $('#pageList');
  if (!box) return;
  await notesIndex();
  const q = ($('#pageSearch') && $('#pageSearch').value) || '';
  try { NOTES.pages = (await api(`/notes?q=${encodeURIComponent(q)}`)).pages || []; }
  catch (e) { box.innerHTML = `<p class="err">${esc(explainError(e.message))}</p>`; return; }
  renderPageList(q);
  // La page ouverte a pu être filtrée : on garde l'éditeur tel quel, c'est une recherche,
  // pas une fermeture.
  if (!NOTES.page) renderPageEditor();
}

function renderPageList(q) {
  const box = $('#pageList');
  if (!NOTES.pages.length) {
    box.innerHTML = q
      ? `<p class="muted">${esc(tr('notes.page.no-match', { q }))}</p>`
      : emptyState({ icon: 'doc', title: esc(tr('notes.page.empty.title')), text: esc(tr('notes.page.empty.text')) });
    return;
  }
  box.innerHTML = NOTES.pages.map((p) => `<button type="button" class="note-item${p.id === NOTES.pageId ? ' active' : ''}" data-page="${p.id}">
      <span class="note-item-title">${p.pinned ? `${svgIco('tag')} ` : ''}${esc(p.title || tr('notes.page.untitled'))}</span>
      <span class="note-item-date">${esc(fmtDate(p.updated_at))}</span>
    </button>`).join('');
}

$('#pageList') && $('#pageList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (b) openNotePage(Number(b.dataset.page));
});

let pageSearchTimer = null;
$('#pageSearch') && $('#pageSearch').addEventListener('input', () => {
  clearTimeout(pageSearchTimer);
  pageSearchTimer = setTimeout(loadPages, 200);
});

async function openNotePage(id) {
  await viderPageSave();          // la frappe en attente appartient à la page qu'on quitte
  try { NOTES.page = await api(`/notes/${id}`); } catch (e) { toast(explainError(e.message), true); return; }
  NOTES.pageId = id;
  renderPageList(($('#pageSearch') && $('#pageSearch').value) || '');
  renderPageEditor();
}

/* La sauvegarde en attente d'une page — AU NIVEAU MODULE, avec ses valeurs figées.
   Deux pièges qu'un minuteur enfermé dans le rendu ne voyait pas :

   — il restait armé quand on ouvrait une AUTRE page, et relisait le DOM au moment de tirer :
     il écrivait donc le contenu de la nouvelle page dans l'ancienne. Corriger un mot puis
     cliquer la page suivante dans la seconde suffisait à perdre la première, en silence ;
   — l'annuler purement et simplement aurait perdu la dernière frappe. On le VIDE : avant
     tout changement de page, la sauvegarde en attente part avec SES propres valeurs. */
let pageSave = null;   // { id, title, content, timer }

async function viderPageSave() {
  const att = pageSave;
  if (!att) return;
  clearTimeout(att.timer);
  pageSave = null;
  const surCettePage = () => NOTES.page && NOTES.page.id === att.id;
  const dire = (cle, params) => { const el = $('#pageSaved'); if (el && surCettePage()) el.textContent = tr(cle, params); };
  try {
    const maj = await api(`/notes/${att.id}`, { method: 'PUT', body: { title: att.title, content: att.content } });
    const ligne = NOTES.pages.find((x) => x.id === att.id);
    if (ligne) { ligne.title = maj.title; ligne.updated_at = maj.updated_at; }
    /* On ne remet à jour l'état affiché que si c'est TOUJOURS cette page : sinon on
       écraserait celle qu'on vient d'ouvrir avec le contenu de la précédente. */
    if (surCettePage()) NOTES.page = maj;
    dire('notes.page.saved');
    renderPageList(($('#pageSearch') && $('#pageSearch').value) || '');
  } catch (e) { dire('notes.page.save-failed', { error: e.message }); }
}

// Une page supprimée n'a plus rien à recevoir : on jette sa sauvegarde au lieu de la vider.
function oublierPageSave(id) {
  if (pageSave && pageSave.id === id) { clearTimeout(pageSave.timer); pageSave = null; }
}

function renderPageEditor() {
  const box = $('#pageEditor');
  if (!box) return;
  const p = NOTES.page;
  if (!p) {
    box.innerHTML = `<p class="muted note-none">${esc(tr('notes.page.none-selected'))}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="note-editor-head">
      <input id="pageTitle" type="text" class="note-title" maxlength="200" value="${esc(p.title)}" placeholder="${esc(tr('notes.page.title-ph'))}" />
      <span id="pageSaved" class="note-saved"></span>
      <span class="spacer"></span>
      <button type="button" id="pagePin" class="btn btn-sm${p.pinned ? ' active' : ''}" title="${esc(tr('notes.page.pin-title'))}">${svgIco('tag')}<span>${esc(tr(p.pinned ? 'notes.page.unpin' : 'notes.page.pin'))}</span></button>
      <button type="button" id="pageExport" class="btn btn-sm" title="${esc(tr('notes.page.export-title'))}">${svgIco('download')}<span>${esc(tr('notes.page.export'))}</span></button>
      <button type="button" id="pageDelete" class="btn btn-sm btn-danger">${svgIco('trash')}<span>${esc(tr('notes.page.delete'))}</span></button>
    </div>
    <div class="note-panes">
      <textarea id="pageContent" class="note-content" placeholder="${esc(tr('notes.page.content-ph'))}" spellcheck="true">${esc(p.content || '')}</textarea>
      <div class="note-preview md-body" id="pagePreview">${renderNoteMd(p.content || '')}</div>
    </div>`;

  const marquer = (cle, param) => { const el = $('#pageSaved'); if (el) el.textContent = cle ? tr(cle, param) : ''; };
  /* Autosauvegarde à la frappe, avec un délai : enregistrer à chaque caractère ferait une
     requête par lettre ; n'enregistrer qu'à la fermeture perdrait le travail d'une page
     restée ouverte. L'aperçu, lui, suit immédiatement — c'est du rendu local.
     Les valeurs sont FIGÉES ici : au tir, le DOM peut déjà montrer une autre page. */
  const planifier = () => {
    marquer('notes.page.saving');
    if (pageSave) clearTimeout(pageSave.timer);
    pageSave = { id: p.id, title: $('#pageTitle').value, content: $('#pageContent').value, timer: null };
    pageSave.timer = setTimeout(viderPageSave, 1000);
  };
  $('#pageContent').addEventListener('input', () => {
    $('#pagePreview').innerHTML = renderNoteMd($('#pageContent').value);
    planifier();
  });
  $('#pageTitle').addEventListener('input', planifier);

  $('#pagePin').addEventListener('click', async () => {
    await viderPageSave();
    try {
      NOTES.page = await api(`/notes/${p.id}`, { method: 'PUT', body: { pinned: p.pinned ? 0 : 1 } });
      await loadPages();
      renderPageEditor();
    } catch (e) { toast(explainError(e.message), true); }
  });
  $('#pageExport').addEventListener('click', () => { window.location.href = `/api/notes/${p.id}/export`; });
  $('#pageDelete').addEventListener('click', async () => {
    if (!await confirmDialog({
      title: tr('notes.page.delete'),
      text: tr('notes.page.confirm-delete', { title: p.title }),
      confirmLabel: tr('notes.page.delete'),
    })) return;
    try {
      oublierPageSave(p.id);
      await api(`/notes/${p.id}`, { method: 'DELETE' });
      NOTES.page = null; NOTES.pageId = null;
      toast(tr('notes.page.deleted'));
      await loadPages();
      renderPageEditor();
    } catch (e) { toast(explainError(e.message), true); }
  });
}

$('#pageNew') && $('#pageNew').addEventListener('click', async () => {
  try {
    const p = await api('/notes', { method: 'POST', body: { title: tr('notes.page.default-title') } });
    await loadPages();
    await openNotePage(p.id);
    const t = $('#pageTitle'); if (t) { t.focus(); t.select(); }
  } catch (e) { toast(explainError(e.message), true); }
});

/* ---------- Capture rapide (touche « n ») ----------
   Un champ, Entrée, c'est fait. Le tri se fait plus tard : si la capture coûte plus de deux
   secondes, on retourne au post-it. La même modale sert à l'ÉDITION d'une todo existante —
   ce sont les mêmes champs, et deux formulaires jumeaux auraient divergé. */
let captureCtx = null;

function openCapture(ctx = {}) {
  captureCtx = ctx;
  const modal = $('#captureModal');
  const titre = $('#captureTitle');
  const details = $('#captureDetails');
  /* La todo à éditer se cherche d'abord parmi les ouvertes, puis parmi CELLES QUI SONT À
     L'ÉCRAN : le crayon est rendu sous « Faites » et « Archivées » aussi. Ne regarder que
     les ouvertes ouvrait une modale VIDE sur ces deux filtres — et valider écrasait alors
     priorité, note et échéance par les valeurs par défaut du formulaire. */
  const existante = ctx.editId
    ? (NOTES.open.find((t) => t.id === ctx.editId)
      || (NOTES.affichees || []).find((t) => t.id === ctx.editId))
    : null;
  if (ctx.editId && !existante) { toast(tr('err.notes.unknown'), true); return; }
  const source = existante || ctx;
  titre.value = source.title || '';
  $('#capturePriority').value = source.priority || 'normal';
  $('#captureNote').value = source.note || '';
  $('#captureDue').value = source.due_at ? isoVersLocal(source.due_at) : '';
  // Une todo qu'on édite s'ouvre dépliée : on vient justement changer un de ces champs.
  details.hidden = !ctx.editId;
  $('#captureMore').textContent = tr(details.hidden ? 'notes.capture.more' : 'notes.capture.less');
  modal.hidden = false;
  setTimeout(() => { titre.focus(); titre.select(); }, 0);
}
function closeCapture() { $('#captureModal').hidden = true; captureCtx = null; }

// ISO → valeur d'un <input type="datetime-local">, qui n'accepte que du LOCAL sans fuseau.
function isoVersLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function submitCapture() {
  const body = {
    title: $('#captureTitle').value,
    priority: $('#capturePriority').value,
    note: $('#captureNote').value,
    due_at: $('#captureDue').value || null,
  };
  if (captureCtx && captureCtx.link_kind) { body.link_kind = captureCtx.link_kind; body.link_ref = captureCtx.link_ref; }
  const edit = captureCtx && captureCtx.editId;
  try {
    if (edit) await api(`/todos/${edit}`, { method: 'PUT', body });
    else await api('/todos', { method: 'POST', body });
    closeCapture();
    toast(tr(edit ? 'notes.todo.saved' : 'notes.capture.added'));
    await refreshOpenTodos();
    // Pas de navigation après une capture : on était en train de faire autre chose.
    if ($('#tab-notes').classList.contains('active')) { if (NOTES.sub === 'todos') loadTodos(); else loadBrief(); }
    majBoutonsTodo();
  } catch (e) { toast(explainError(e.message), true); }
}

$('#captureOk') && $('#captureOk').addEventListener('click', () => submitCapture());
$('#captureCancel') && $('#captureCancel').addEventListener('click', () => closeCapture());
$('#captureMore') && $('#captureMore').addEventListener('click', () => {
  const d = $('#captureDetails');
  d.hidden = !d.hidden;
  $('#captureMore').textContent = tr(d.hidden ? 'notes.capture.more' : 'notes.capture.less');
});
$('#captureTitle') && $('#captureTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitCapture(); }
});
fermerAuFond('#captureModal', () => closeCapture(), { salissable: true });

/* ---------- « Ajouter aux todos » depuis une MR ou un ticket ----------
   Le bouton connaît l'existant : une todo ouverte déjà liée au même objet le fait devenir
   « Voir la todo ». Créer un doublon silencieux serait la façon la plus sûre de rendre la
   liste inutilisable au bout d'une semaine. */
const todoLie = (kind, ref) => NOTES.open.find((t) => t.link_kind === kind && String(t.link_ref) === String(ref));

function addTodoBtn(kind, ref, titre) {
  const existante = todoLie(kind, ref);
  if (existante) {
    return `<button type="button" class="btn btn-sm" data-see-todo="${existante.id}" title="${esc(tr('notes.view-todo-title'))}">${svgIco('check')}${esc(tr('notes.view-todo'))}</button>`;
  }
  return `<button type="button" class="btn btn-sm" data-add-todo="${esc(kind)}" data-add-ref="${esc(ref)}" data-add-title="${esc(titre)}" title="${esc(tr('notes.add-todo-title'))}">${svgIco('clip')}${esc(tr('notes.add-todo'))}</button>`;
}

// Après création, le bouton encore à l'écran doit basculer : sinon on clique deux fois et
// on obtient le doublon que l'anti-doublon existe pour éviter.
function majBoutonsTodo() {
  $$('[data-add-todo]').forEach((b) => {
    const t = todoLie(b.dataset.addTodo, b.dataset.addRef);
    if (!t) return;
    b.outerHTML = `<button type="button" class="btn btn-sm" data-see-todo="${t.id}" title="${esc(tr('notes.view-todo-title'))}">${svgIco('check')}${esc(tr('notes.view-todo'))}</button>`;
  });
}

document.addEventListener('click', (e) => {
  const add = e.target.closest && e.target.closest('[data-add-todo]');
  if (add) {
    openCapture({ title: add.dataset.addTitle, link_kind: add.dataset.addTodo, link_ref: add.dataset.addRef });
    return;
  }
  const see = e.target.closest && e.target.closest('[data-see-todo]');
  if (see) { navTab('notes'); showNotesSub('todos'); }
});

/* ---------- Rappels ----------
   Le poll existant des notifications interroge aussi les échéances. Deux subtilités :
     — le serveur n'écrit `reminded_at` qu'après CONFIRMATION du client, pour ne pas perdre
       un rappel quand la notification échoue ;
     — au premier passage (rattrapage), plusieurs rappels en retard donnent UNE notification
       groupée : dix pop-ups au démarrage se ferment sans être lues. */
let rappelsAmorces = false;
async function pollReminders() {
  const p = notifPrefs();
  let d;
  try { d = await api('/todos/reminders/due'); } catch { return; }
  const dus = d.due || [];
  /* Une échéance qui vient d'échoir fait passer sa todo du bleu au rouge : on relit la liste
     ici, sinon la pastille ne bougerait qu'à la prochaine visite de l'onglet. */
  await refreshOpenTodos();
  if (!dus.length) { rappelsAmorces = true; return; }
  const rattrapage = !rappelsAmorces && dus.length >= 2;
  rappelsAmorces = true;
  if (p.muted || notifPermission() !== 'granted' || !p.reminder) return;
  if (rattrapage) {
    showNotif(tr('notif.reminders-group.title', { n: dus.length, count: dus.length }),
      tr('notif.reminders-group.body'), () => { navTab('notes'); showNotesSub('today'); });
  } else {
    for (const t of dus) {
      showNotif(tr('notif.reminder.title', { title: t.title }), tr('notif.reminder.body'),
        () => { navTab('notes'); showNotesSub('todos'); });
    }
  }
  // Confirmation d'affichage : c'est elle qui consomme le rappel, pas la lecture.
  for (const t of dus) { try { await api(`/todos/${t.id}/reminded`, { method: 'POST' }); } catch { /* réessai au prochain passage */ } }
}
setInterval(pollReminders, 60000);

/* ---------- Atterrissage sur le brief ----------
   Une fois par jour CALENDAIRE, et seulement si le réglage est actif. La date du dernier
   affichage reste locale au navigateur : deux navigateurs ouverts n'ont pas à se voler le
   brief l'un l'autre, alors que le réglage, lui, vaut pour l'outil. */
const BRIEF_KEY = 'mergerie_brief_seen';
function briefDejaVuAujourdHui() {
  try { return localStorage.getItem(BRIEF_KEY) === new Date().toDateString(); } catch { return true; }
}
function marquerBriefVu() {
  try { localStorage.setItem(BRIEF_KEY, new Date().toDateString()); } catch { /* stockage indisponible */ }
}

/* ============ Onglet Liens : grille services × environnements ============
   Les marque-pages d'un navigateur ne savent pas dire qu'un même service existe en local,
   en dev, en preprod et en prod : ils en font quatre entrées dans quatre dossiers. D'où une
   GRILLE — services en lignes, environnements en colonnes — et, à côté, des liens libres à
   plat pour tout ce qui n'a pas de dimension environnement. Deux formes, deux réalités. */
const LINKS = {
  grid: null, tag: '', q: '', selectMode: false, selection: new Set(), ouvertes: new Set(), importLinks: [], importGrid: null, freeDeplie: null,
  // Filtres : Set VIDE = « tout », jamais « rien ». Un filtre qu'on n'a pas posé ne cache rien.
  envs: new Set(), svcs: new Set(), svcQ: '', toutDeplier: false,
};

/* Les filtres servent tous les jours : les reposer à chaque ouverture serait absurde. Même
   mécanisme que le filtre des notes — `localStorage`, côté navigateur, parce que c'est une
   préférence d'affichage et pas un réglage de l'outil. */
const LINKS_FILTRES = 'mergerie_links_filters';
function chargerFiltresLiens() {
  try {
    const d = JSON.parse(localStorage.getItem(LINKS_FILTRES) || '{}');
    LINKS.envs = new Set(Array.isArray(d.envs) ? d.envs : []);
    LINKS.svcs = new Set(Array.isArray(d.svcs) ? d.svcs : []);
    LINKS.tag = typeof d.tag === 'string' ? d.tag : '';
    LINKS.toutDeplier = !!d.toutDeplier;
    LINKS.freeDeplie = d.freeDeplie === true || d.freeDeplie === false ? d.freeDeplie : null;
  } catch { /* stockage indisponible */ }
}
function retenirFiltresLiens() {
  try {
    localStorage.setItem(LINKS_FILTRES, JSON.stringify({
      envs: [...LINKS.envs], svcs: [...LINKS.svcs], tag: LINKS.tag, toutDeplier: LINKS.toutDeplier, freeDeplie: LINKS.freeDeplie,
    }));
  } catch { /* stockage indisponible */ }
}

async function loadLinks() {
  const box = $('#linkGrid');
  if (!box) return;
  box.innerHTML = skeleton(3);
  try { LINKS.grid = await api('/links/grid'); }
  catch (e) { box.innerHTML = errorBox(e.message); return; }
  chargerFiltresLiens();
  /* Un environnement ou un service supprimé depuis la dernière visite laisserait un filtre
     invisible et impossible à relâcher : on écarte ce qui n'existe plus. */
  const idsEnv = new Set((LINKS.grid.environments || []).map((e) => e.id));
  const idsSvc = new Set((LINKS.grid.services || []).map((x) => x.id));
  LINKS.envs = new Set([...LINKS.envs].filter((i) => idsEnv.has(i)));
  LINKS.svcs = new Set([...LINKS.svcs].filter((i) => idsSvc.has(i)));
  if (LINKS.tag && !(LINKS.grid.tags || []).includes(LINKS.tag)) LINKS.tag = '';
  rafraichirLiens();
}



/* Le COMPTE sur chaque pastille. Une rangée de tags sans chiffres ne dit pas où est la
   matière ; avec, elle devient le sommaire de ce qu'on a importé. */
function renderLinkTags() {
  const box = $('#linkTags');
  const g = LINKS.grid || {};
  const tags = g.tags || [];
  if (!tags.length) { box.innerHTML = ''; return; }
  const compte = (t) => (g.services || []).filter((x) => (x.tags || []).includes(t)).length
    + (g.free_links || []).filter((x) => (x.tags || []).includes(t)).length;
  box.innerHTML = tags.map((t) => `<button type="button" class="link-tag${LINKS.tag === t ? ' active' : ''}" data-linktag="${esc(t)}">${esc(t)}<span class="lt-n">${compte(t)}</span></button>`).join('');
}

function renderLinkFiltres() {
  const g = LINKS.grid || {};
  const envs = g.environments || [];
  const chips = $('#linkEnvChips');
  if (chips) {
    chips.innerHTML = envs.map((e) => `<button type="button" class="link-tag link-env-chip${LINKS.envs.size && !LINKS.envs.has(e.id) ? '' : ' active'}" data-linkenv="${e.id}">`
      + `<span class="link-env-dot" style="background:${esc(e.color)}"></span>${esc(e.name)}</button>`).join('');
  }
  /* Les services à plat, comme les environnements. Le champ qui les tamise n'apparaît qu'au-delà
     d'une douzaine : plus bas, il occuperait la barre sans rien rendre. Il MASQUE des pastilles
     sans en décocher — un service filtré hors de vue reste actif, et son compte le rappelle. */
  const SEUIL_TAMIS = 12;
  const tousSvc = g.services || [];
  const tamis = $('#linkSvcSearch');
  if (tamis) tamis.hidden = tousSvc.length <= SEUIL_TAMIS;
  const chipsSvc = $('#linkSvcChips');
  if (chipsSvc) {
    const q = LINKS.svcQ.toLowerCase();
    const vus = tousSvc.filter((x) => !q || x.name.toLowerCase().includes(q));
    const caches = LINKS.svcs.size ? [...LINKS.svcs].filter((id) => !vus.some((x) => x.id === id)).length : 0;
    chipsSvc.innerHTML = vus.map((x) => `<button type="button" class="link-tag link-svc-chip${LINKS.svcs.size && !LINKS.svcs.has(x.id) ? '' : ' active'}" data-linksvc="${x.id}">${esc(x.name)}</button>`).join('')
      + (caches ? `<span class="muted lf-hidden">${esc(tr('links.filter.hidden-active', { n: caches, count: caches }))}</span>` : '');
  }
  const clear = $('#linkClearFilters');
  if (clear) clear.hidden = !(LINKS.envs.size || LINKS.svcs.size || LINKS.tag);
  const exp = $('#linkExpandAll');
  if (exp) {
    exp.classList.toggle('active', LINKS.toutDeplier);
    exp.setAttribute('aria-pressed', String(LINKS.toutDeplier));
    $('span', exp).textContent = tr(LINKS.toutDeplier ? 'links.url.collapse-all' : 'links.url.expand-all');
    /* Le bouton ne s'affiche que s'il y a quelque chose à déplier : sur une grille dont
       aucune case ne dépasse le seuil, il ne ferait rien et occuperait la barre. */
    const dense = ((LINKS.grid || {}).services || []).some((x) => Object.values(x.urls || {}).some((l) => l.length > SEUIL_LIGNE));
    exp.hidden = !dense && !LINKS.toutDeplier;
  }
}

// Les colonnes retenues. Set vide = toutes : un filtre non posé ne cache rien.
const envsVisibles = () => ((LINKS.grid || {}).environments || [])
  .filter((e) => !LINKS.envs.size || LINKS.envs.has(e.id));

/* UNE requête pour les deux moitiés de l'écran. Un service se cherche par son nom, ses tags,
   son dépôt ou n'importe laquelle de ses URLs — c'est souvent l'URL qu'on a en tête (« celui
   qui est sur kibana-preprod ») plutôt que le nom qu'on lui a donné. */
const motsRecherche = () => LINKS.q.split(/\s+/).filter(Boolean);
const metaService = (s) => [s.name, s.project || '', ...(s.tags || [])].join(' ').toLowerCase();

/* UNE ADRESSE EST TROUVÉE si la requête tient dans « ce que dit son service » PLUS « ce qu'elle
   dit elle-même ». C'est ce qui rend « logs apache » juste : « logs » vient de la ligne,
   « apache » de l'adresse, et seules les adresses apache s'affichent. Chercher « logs » seul,
   à l'inverse, laisse passer toutes les adresses de la ligne — la ligne entière a été demandée. */
function adresseTrouvee(s, u) {
  const foin = `${metaService(s)} ${u.label || ''} ${u.url}`.toLowerCase();
  return motsRecherche().every((m) => foin.includes(m));
}

function serviceVisible(s) {
  if (LINKS.svcs.size && !LINKS.svcs.has(s.id)) return false;
  /* Filtrer sur la prod et voir dix lignes entièrement vides ne montre pas la prod, ça montre
     ce qu'elle n'a pas. Une ligne sans aucune adresse dans les colonnes retenues sort donc. */
  if (LINKS.envs.size && !envsVisibles().some((e) => ((s.urls || {})[e.id] || []).length)) return false;
  if (LINKS.tag && !(s.tags || []).includes(LINKS.tag)) return false;
  if (!LINKS.q) return true;
  const mots = motsRecherche();
  const meta = metaService(s);
  // Le service se trouve par lui-même, ou par l'une de ses adresses.
  return mots.every((m) => meta.includes(m))
    || Object.values(s.urls || {}).flat().some((u) => adresseTrouvee(s, u));
}
const freeVisible = (l) => (!LINKS.tag || (l.tags || []).includes(LINKS.tag))
  && (!LINKS.q || LINKS.q.split(/\s+/).filter(Boolean)
    .every((m) => `${l.label} ${l.url} ${(l.tags || []).join(' ')}`.toLowerCase().includes(m)));

/* Au-delà de quatre adresses dans la case la plus fournie d'une ligne, on replie. */
const SEUIL_LIGNE = 4;

function renderLinkGrid() {
  const box = $('#linkGrid');
  const { environments: toutesEnvs = [], services = [] } = LINKS.grid || {};
  const envs = envsVisibles();
  if (!toutesEnvs.length && !services.length) {
    /* DEUX vides, et deux messages. Sans cette distinction, importer ses marque-pages laissait
       l'écran répondre « aucun lien pour l'instant » au-dessus des liens qu'on venait
       d'importer — en proposant de les importer une seconde fois.
       L'IMPORT EN PREMIER dans le vrai vide : c'est le chemin le plus court entre « écran
       vide » et « outil utile ». Créer un environnement, puis un service, puis coller une URL
       demande trois gestes avant de voir quoi que ce soit. */
    const desLiens = (((LINKS.grid || {}).free_links) || []).length > 0;
    box.innerHTML = desLiens
      ? emptyState({
        icon: 'link', title: esc(tr('links.grid.empty.title')), text: esc(tr('links.grid.empty.text')),
        actions: [{ act: 'newenv', label: esc(tr('links.env.new')), primary: true }],
      })
      : emptyState({
        icon: 'link', title: esc(tr('links.empty.title')), text: esc(tr('links.empty.text2')),
        actions: [
          { act: 'import', label: esc(tr('links.empty.import')), primary: true },
          { act: 'newenv', label: esc(tr('links.env.new')) },
        ],
      });
    return;
  }
  const visibles = services.filter(serviceVisible);

  /* L'en-tête ÉTAIT cliquable sans rien pour le dire, et l'ordre des colonnes ne se corrigeait
     pas. Les trois boutons n'apparaissent qu'au survol (et au focus clavier) : la grille reste
     calme au repos, et ce qui est faisable finit par se voir. */
  const rang = (id) => toutesEnvs.findIndex((x) => x.id === id);
  /* LE NOM EST LE BOUTON. Régler ou supprimer un environnement se cachait derrière une roue
     dentée n'apparaissant qu'au survol : la fonction existait, personne ne la trouvait. Le nom
     est ce qu'on vise naturellement quand on veut agir sur une colonne. */
  const entete = envs.map((e) => `<th><span class="link-env">`
    + `<span class="link-env-dot" style="background:${esc(e.color)}"></span>`
    + `<button type="button" class="link-env-name" data-envedit="${e.id}" title="${esc(tr('links.env.settings'))}">${esc(e.name)}</button>`
    + `<span class="link-env-acts">`
    + `<button type="button" class="link-icon" data-envmove="${e.id}" data-dir="-1"${rang(e.id) === 0 ? ' disabled' : ''} title="${esc(tr('links.env.move-left'))}" aria-label="${esc(tr('links.env.move-left'))}">${svgIco('left')}</button>`
    + `<button type="button" class="link-icon" data-envmove="${e.id}" data-dir="1"${rang(e.id) === toutesEnvs.length - 1 ? ' disabled' : ''} title="${esc(tr('links.env.move-right'))}" aria-label="${esc(tr('links.env.move-right'))}">${svgIco('right')}</button>`
    + `</span></span></th>`).join('');

  const lignes = visibles.map((s) => {
    const maxLigne = Math.max(0, ...envs.map((e) => (((s.urls || {})[e.id]) || []).length));
    const cases = envs.map((e) => {
      /* SOUS UNE RECHERCHE, LA CASE NE MONTRE QUE CE QUI CORRESPOND. Afficher les huit adresses
         d'une case pour une seule trouvée oblige à relire la case au lieu de lire la réponse.
         Le `+` d'ajout ne revient pas pour autant : la case n'est pas vide, elle est filtrée. */
      const liste = ((s.urls || {})[e.id]) || [];
      if (!liste.length) {
        return `<td class="link-cell"><button type="button" class="link-add" data-addurl="${s.id}" data-env="${e.id}">+</button></td>`;
      }
      /* COMBIEN D'ADRESSES MONTRER. Un chiffre en dur ne convient à personne : à deux, une
         grille dont chaque case en porte trois se déplie sans arrêt ; à dix, une seule case
         chargée fait une ligne haute comme un écran.
         Le seuil se juge donc SUR LA LIGNE : tant que la case la plus fournie reste sous
         `SEUIL_LIGNE`, on montre tout — la ligne garde une hauteur raisonnable et plus rien
         n'est caché. Au-delà, on retombe à deux et le « +N » prend le relais. */
      /* SOUS UNE RECHERCHE, la case montre tout : laisser l'adresse trouvée derrière un « +7 »
         obligerait à déplier pour voir ce qu'on vient de chercher. */
      const retenues = LINKS.q ? liste.filter((u) => adresseTrouvee(s, u)) : liste;
      if (LINKS.q && !retenues.length) return '<td class="link-cell"></td>';
      const deplie = LINKS.q || LINKS.toutDeplier || LINKS.ouvertes.has(`${s.id}:${e.id}`) || maxLigne <= SEUIL_LIGNE;
      const montrees = deplie ? retenues : retenues.slice(0, 2);
      /* `rel="noopener noreferrer"` sur TOUTES les ouvertures externes : l'onglet ouvert ne
         doit rien pouvoir faire de la page qui l'a ouvert. */
      const lignes = montrees.map((u) => `<a class="link-open" href="${esc(u.url)}" target="_blank" rel="noopener noreferrer"
          data-usekind="service_url" data-useref="${s.id}:${e.id}:${u.id}" title="${esc(u.url)}">
          <span>${esc(u.label || urlCourte(u.url))}</span></a>`).join('');
      const caches = retenues.slice(montrees.length);
      /* Le « +N » DIT CE QU'IL CACHE au survol. Un compteur seul oblige à déplier pour savoir
         s'il valait la peine d'être déplié — sur une grille entière, c'est autant d'allers et
         retours pour rien. */
      const plus = caches.length
        ? `<button type="button" class="link-plus" data-cellopen="${s.id}:${e.id}"
             title="${esc(caches.map((u) => u.label || urlCourte(u.url)).join('\n'))}">+${caches.length}</button>`
        /* « Réduire » n'a de sens que si le dépliage vient d'un clic. Sous une recherche ou sous
           « Tout déplier », il serait visible et inerte — un bouton qui ne fait rien est pire
           qu'un bouton absent. */
        : (deplie && retenues.length > 2 && !LINKS.q && !LINKS.toutDeplier && maxLigne > SEUIL_LIGNE
          ? `<button type="button" class="link-plus" data-cellopen="${s.id}:${e.id}">${esc(tr('links.url.less'))}</button>`
          : '');
      /* LE CRAYON. Une case remplie n'offrait aucun chemin de retour : pour corriger une faute
         de frappe il fallait supprimer le service — et perdre ses autres URLs et ses liens
         contextuels — puis tout ressaisir. */
      return `<td class="link-cell">${lignes}${plus}
        <button type="button" class="link-icon link-edit" data-editurl="${s.id}" data-env="${e.id}"
          title="${esc(tr('links.url.edit'))}" aria-label="${esc(tr('links.url.edit'))}">${svgIco('edit')}</button></td>`;
    }).join('');
    return `<tr>
      <td class="link-svc">
        <div class="link-svc-name">
          ${s.pinned ? `<span title="${esc(tr('links.service.pinned'))}">${svgIco('tag')}</span>` : ''}
          <button type="button" class="btn btn-sm btn-ghost" data-editservice="${s.id}" title="${esc(tr('links.service.edit'))}">${esc(s.name)}</button>
          <button type="button" class="link-icon link-edit" data-editservice="${s.id}"
            title="${esc(tr('links.service.edit'))}" aria-label="${esc(tr('links.service.edit'))}">${svgIco('edit')}</button>
        </div>
        <div class="link-svc-meta">
          ${s.project ? `<span title="${esc(tr('links.service.repo'))}">${svgIco('branch')} ${esc(s.project)}</span>` : ''}
          ${(s.tags || []).map((t) => `<span class="link-svc-tag">${esc(t)}</span>`).join('')}
          ${s.context_links ? `<span class="link-svc-tag">${svgIco('zap')} ${esc(tr('links.ctx.count', { n: s.context_links, count: s.context_links }))}</span>` : ''}
        </div>
      </td>${cases}</tr>`;
  }).join('');

  /* LE TABLEAU EXISTE DÈS QU'IL Y A UNE COLONNE, même sans une seule ligne. Sans ça, un
     environnement créé avant tout service devenait inatteignable : ses réglages vivent dans
     son en-tête, et l'en-tête n'était pas rendu — impossible de le renommer ni de le
     supprimer, et l'écran annonçait « rien ne correspond à cette recherche » à quelqu'un qui
     n'avait rien cherché. */
  const vide = !visibles.length ? `<tr class="link-grid-empty"><td colspan="${envs.length + 1}">${esc(tr(
    services.length
      ? (((LINKS.grid || {}).free_links || []).some(freeVisible) ? 'links.grid.no-match' : 'links.no-match-all')
      : 'links.grid.no-service',
  ))}</td></tr>` : '';
  box.innerHTML = `<table class="link-grid"><thead><tr><th class="link-svc"></th>${entete}</tr></thead><tbody>${lignes}${vide}</tbody></table>`;
}

/* L'URL raccourcie : l'hôte et le début du chemin. Une case de grille montre OÙ l'on va, pas
   la requête complète — celle-ci vit dans l'info-bulle. */
function urlCourte(url) {
  try {
    const u = new URL(url);
    const chemin = u.pathname === '/' ? '' : u.pathname;
    return (u.host + chemin).slice(0, 42);
  } catch { return String(url).slice(0, 42); }
}


/* GROUPÉS PAR DOSSIER au-delà d'une douzaine, en reprenant l'arbre du navigateur. Une liste
   plate de deux cents entrées ne se parcourt pas ; les mêmes rangées par dossier se survolent.
   Sous une recherche ou un tag, on reste à plat : le filtre EST le rangement, et deux niveaux de
   tri à la fois cachent ce qu'on vient de demander. */
const SEUIL_GROUPES = 12;

function renderFreeLinks() {
  const box = $('#linkFreeList');
  const tous = ((LINKS.grid && LINKS.grid.free_links) || []).filter(freeVisible);
  const filtre = LINKS.q || LINKS.tag;
  /* CE QU'ON VOIT EST CE SUR QUOI ON AGIT. Un lien coché puis filtré hors de vue partirait
     avec les autres au moment de ranger, sans que rien ne l'ait annoncé. On retire donc de la
     sélection ce que le filtre a écarté — quitte à devoir recocher, ce qui se voit. */
  if (LINKS.selectMode) {
    const vus = new Set(tous.map((l) => l.id));
    for (const id of [...LINKS.selection]) if (!vus.has(id)) LINKS.selection.delete(id);
  }
  const btn = $('#linkToService');
  if (btn) {
    btn.hidden = !LINKS.selectMode || LINKS.selection.size < 1;
    // Le compte SUR le bouton : « ranger » sans dire combien se fait à l'aveugle.
    $('span', btn).textContent = LINKS.selection.size
      ? tr('links.free.file-n', { n: LINKS.selection.size, count: LINKS.selection.size })
      : tr('links.free.file');
  }
  /* « Tout sélectionner » porte sur ce que le filtre a laissé, pas sur la base entière : on
     tamise d'abord (« kibana »), on coche tout, on range. C'est le geste d'après l'import. */
  /* Replier ou déplier TOUS les dossiers d'un coup. Le pliage un par un suffit à trois dossiers ;
     à treize, on veut voir l'arbre nu ou tout son contenu, pas cliquer treize fois. */
  const groupable = !filtre && tous.length > SEUIL_GROUPES;
  for (const [sel, actif] of [['#linkFreeExpand', LINKS.freeDeplie === true], ['#linkFreeFold', LINKS.freeDeplie === false]]) {
    const b2 = $(sel);
    if (!b2) continue;
    b2.hidden = !groupable;
    b2.classList.toggle('active', actif);
    b2.setAttribute('aria-pressed', String(actif));
  }
  const tout = $('#linkFreeAll');
  if (tout) {
    tout.hidden = !LINKS.selectMode || !tous.length;
    const complet = tous.length > 0 && tous.every((l) => LINKS.selection.has(l.id));
    $('span', tout).textContent = tr(complet ? 'links.select.none' : 'links.select.all');
    tout.dataset.complet = complet ? '1' : '';
  }
  const sel = $('#linkFreeSelect');
  if (sel) {
    // Rien à cocher : proposer de sélectionner serait proposer un geste sans objet.
    sel.hidden = !((LINKS.grid && LINKS.grid.free_links) || []).length;
    sel.classList.toggle('active', LINKS.selectMode);
    sel.setAttribute('aria-pressed', String(LINKS.selectMode));
    $('span', sel).textContent = tr(LINKS.selectMode ? 'links.select.done' : 'links.select');
  }
  // Le compte se lit à côté du titre : il dit ce que le filtre a laissé, sans compter à la main.
  const cpt = $('#linkFreeCount');
  if (cpt) cpt.textContent = tous.length ? tr('links.free.count', { n: tous.length, count: tous.length }) : '';
  const wipe = $('#linkMoreMenu [data-more="wipe"]');
  if (wipe) wipe.hidden = !((LINKS.grid && LINKS.grid.free_links) || []).length;
  if (!tous.length) {
    box.innerHTML = `<p class="muted">${esc(tr(LINKS.q || LINKS.tag ? 'links.free.no-match' : 'links.free.empty'))}</p>`;
    return;
  }
  if (!filtre && tous.length > SEUIL_GROUPES) {
    box.innerHTML = arbreFreeLinks(tous);
    return;
  }
  box.innerHTML = tous.map(ligneFreeLink).join('');
}

/* L'ARBRE RÉEL, et non un groupement sur le dernier segment du chemin. Grouper par la feuille
   faisait fusionner `seres/prod` et `logs/prod` dans un même « prod » : l'outil détruisait une
   structure que le navigateur, lui, préserve. Le chemin complet est conservé à l'import, et
   l'écran le rend tel quel — déplié, parce que ranger sert à structurer, pas à cacher. */
function arbreFreeLinks(liens) {
  const racine = { enfants: new Map(), liens: [] };
  for (const l of liens) {
    let n = racine;
    for (const seg of String(l.folder || '').split('/').filter(Boolean)) {
      if (!n.enfants.has(seg)) n.enfants.set(seg, { enfants: new Map(), liens: [] });
      n = n.enfants.get(seg);
    }
    n.liens.push(l);
  }
  const compter = (n) => n.liens.length + [...n.enfants.values()].reduce((t, e) => t + compter(e), 0);
  /* PAR DÉFAUT, LE PREMIER NIVEAU SEULEMENT. Un arbre entièrement déplié à cinq niveaux redonne
     la liste plate qu'on cherchait à quitter ; entièrement replié, il oblige à ouvrir dix
     dossiers pour retrouver un lien. Le premier niveau montre le sommaire et rien de plus.
     Les deux boutons, eux, disent explicitement « tout » ou « rien ». */
  const ouvert = (profondeur) => (LINKS.freeDeplie === null ? profondeur === 0 : LINKS.freeDeplie);
  const rendre = (n, nom, profondeur = 0) => {
    const dedans = [...n.enfants.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, e]) => rendre(e, k, profondeur + 1)).join('') + n.liens.map(ligneFreeLink).join('');
    if (nom === null) return dedans;                 // la racine n'est pas un dossier
    const t = compter(n);
    /* Le bouton de pliage n'apparaît QUE si le dossier en contient d'autres : sur une feuille,
       il ne ferait rien de plus que le chevron du dossier lui-même. */
    const sousDossiers = n.enfants.size > 0;
    const bouton = sousDossiers
      ? `<button type="button" class="link-icon lfg-fold" data-foldsub
           title="${esc(tr('links.free.fold-here'))}" aria-label="${esc(tr('links.free.fold-here'))}">${svgIco('unfold')}</button>`
      : '';
    return `<details class="link-free-group"${ouvert(profondeur) ? ' open' : ''}>
      <summary>${esc(nom)} <span class="muted">${esc(tr('links.free.count', { n: t, count: t }))}</span>${bouton}</summary>
      ${dedans}</details>`;
  };
  // La racine n'est pas un dossier : ses enfants sont le PREMIER niveau, donc profondeur 0.
  return rendre(racine, null, -1);
}

const ligneFreeLink = (l) => `<div class="link-free-row">
      ${LINKS.selectMode ? `<input type="checkbox" data-freepick="${l.id}"${LINKS.selection.has(l.id) ? ' checked' : ''} aria-label="${esc(tr('links.free.pick'))}" />` : ''}
      <span class="link-free-label">${esc(l.label)}</span>
      ${(l.tags || []).map((t) => `<span class="link-svc-tag">${esc(t)}</span>`).join('')}
      <a class="link-free-url" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"
         data-usekind="free_link" data-useref="${l.id}">${esc(l.url)}</a>
      <button type="button" class="btn btn-sm btn-ghost" data-filefree="${l.id}" title="${esc(tr('links.free.file-title'))}" aria-label="${esc(tr('links.free.file-title'))}">${svgIco('archive')}</button>
      <button type="button" class="btn btn-sm btn-ghost" data-editfree="${l.id}" title="${esc(tr('ui.edit'))}">${svgIco('edit')}</button>
    </div>`;

/* Chaque ouverture nourrit la frécence de la palette : ce qu'on clique ici remonte là-bas.
   Par délégation et en `capture: false` — le lien s'ouvre normalement, on ne l'intercepte pas. */
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-usekind]');
  if (!a) return;
  api('/launcher/used', { method: 'POST', body: { kind: a.dataset.usekind, ref: a.dataset.useref } })
    .catch(() => { /* la frécence n'est pas une donnée critique */ });
});

$('#linkTags') && $('#linkTags').addEventListener('click', (e) => {
  const b = e.target.closest('[data-linktag]');
  if (!b) return;
  LINKS.tag = LINKS.tag === b.dataset.linktag ? '' : b.dataset.linktag;
  retenirFiltresLiens();
  rafraichirLiens();
});
const rafraichirLiens = () => { renderLinkFiltres(); renderLinkTags(); renderLinkGrid(); renderFreeLinks(); };

/* Une frappe, un clic sur une pastille ou une coche refont le MÊME rendu : quatre fonctions
   appelées dans le même ordre partout, plutôt qu'un sous-ensemble différent à chaque endroit —
   c'est ainsi qu'un compteur finit par ne plus suivre son filtre. */
$('#linkEnvChips') && $('#linkEnvChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-linkenv]');
  if (!b) return;
  const id = Number(b.dataset.linkenv);
  const envs = ((LINKS.grid || {}).environments || []).map((x) => x.id);
  /* Depuis « tout affiché », un clic veut dire « CELLE-LÀ » — c'est le geste courant, on part
     travailler sur un environnement. Ensuite seulement les clics ajoutent et retirent.
     Retirer la dernière ramène à tout : une grille sans colonne ne montrerait rien, et il
     faudrait alors chercher comment en sortir. */
  if (!LINKS.envs.size) LINKS.envs = new Set([id]);
  else if (LINKS.envs.has(id)) LINKS.envs.delete(id);
  else LINKS.envs.add(id);
  if (!LINKS.envs.size || LINKS.envs.size === envs.length) LINKS.envs.clear();
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkSvcSearch') && $('#linkSvcSearch').addEventListener('input', () => {
  LINKS.svcQ = $('#linkSvcSearch').value.trim();
  renderLinkFiltres();
});

$('#linkSvcChips') && $('#linkSvcChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-linksvc]');
  if (!b) return;
  const id = Number(b.dataset.linksvc);
  const tous = ((LINKS.grid || {}).services || []).map((x) => x.id);
  // Même geste que les colonnes : depuis « tout », un clic veut dire « celui-là ».
  if (!LINKS.svcs.size) LINKS.svcs = new Set([id]);
  else if (LINKS.svcs.has(id)) LINKS.svcs.delete(id);
  else LINKS.svcs.add(id);
  if (!LINKS.svcs.size || LINKS.svcs.size === tous.length) LINKS.svcs.clear();
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkExpandAll') && $('#linkExpandAll').addEventListener('click', () => {
  LINKS.toutDeplier = !LINKS.toutDeplier;
  // Les dépliages individuels s'effacent : deux états superposés donneraient une grille dont
  // on ne saurait plus dire pourquoi telle case est ouverte et telle autre non.
  LINKS.ouvertes.clear();
  retenirFiltresLiens();
  rafraichirLiens();
});
$('#linkClearFilters') && $('#linkClearFilters').addEventListener('click', () => {
  LINKS.envs.clear(); LINKS.svcs.clear(); LINKS.tag = '';
  retenirFiltresLiens();
  rafraichirLiens();
});

$('#linkSearch') && $('#linkSearch').addEventListener('input', () => {
  LINKS.q = $('#linkSearch').value.trim().toLowerCase();
  renderLinkGrid();
  renderFreeLinks();
});

const menuLiens = (bouton, menu) => {
  const b = $(bouton);
  if (!b) return;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const ouvrir = $(menu).hidden;
    closeSplitMenus();
    $(menu).hidden = !ouvrir;
    b.setAttribute('aria-expanded', String(ouvrir));
  });
};
menuLiens('#linksAdd', '#linkAddMenu');
menuLiens('#linkMore', '#linkMoreMenu');

$('#linkAddMenu') && $('#linkAddMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  closeSplitMenus();
  if (b.dataset.add === 'free') openFreeModal(null);
  else if (b.dataset.add === 'service') openServiceModal(null);
  else openEnvModal(null);
});
$('#linkMoreMenu') && $('#linkMoreMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-more]');
  if (!b) return;
  closeSplitMenus();
  if (b.dataset.more === 'import') { ouvrirImport(); return; }
  if (b.dataset.more === 'wipe') viderLiensLibres();
});


/* Le mode sélection : les cases à cocher n'existent que le temps de s'en servir. En sortir
   vide la sélection — la garder en mémoire ferait agir plus tard sur des lignes invisibles. */
/* Recliquer sur le bouton actif REVIENT AU DÉFAUT — le premier niveau. Sans ça, on ne pourrait
   plus y retourner qu'en vidant son stockage. */
const plierLiens = (valeur) => {
  LINKS.freeDeplie = LINKS.freeDeplie === valeur ? null : valeur;
  retenirFiltresLiens();
  renderFreeLinks();
};
/* Plier ou déplier UN dossier et tout ce qu'il contient. Le geste est local et ne se retient
   pas : c'est un coup d'œil, pas une préférence. L'icône bascule pour dire ce que fera le
   prochain clic — sans quoi on ne saurait pas si l'on va ouvrir ou fermer. */
$('#linkFreeList') && $('#linkFreeList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-foldsub]');
  if (!b) return;
  e.preventDefault();                 // ne pas basculer le <details> qui porte le bouton
  e.stopPropagation();
  const sous = $$('details', b.closest('details'));
  const tousOuverts = sous.length > 0 && sous.every((d) => d.open);
  sous.forEach((d) => { d.open = !tousOuverts; });
  $('use', b).setAttribute('href', tousOuverts ? '#i-unfold' : '#i-fold');
});

$('#linkFreeExpand') && $('#linkFreeExpand').addEventListener('click', () => plierLiens(true));
$('#linkFreeFold') && $('#linkFreeFold').addEventListener('click', () => plierLiens(false));
$('#linkFreeAll') && $('#linkFreeAll').addEventListener('click', (e) => {
  const visibles = ((LINKS.grid && LINKS.grid.free_links) || []).filter(freeVisible);
  if (e.currentTarget.dataset.complet) visibles.forEach((l) => LINKS.selection.delete(l.id));
  else visibles.forEach((l) => LINKS.selection.add(l.id));
  renderFreeLinks();
});
$('#linkFreeSelect') && $('#linkFreeSelect').addEventListener('click', () => {
  LINKS.selectMode = !LINKS.selectMode;
  if (!LINKS.selectMode) LINKS.selection.clear();
  renderFreeLinks();
});

/* Ajout d'une URL DANS la case : le champ remplace le `+`, Entrée valide, Échap annule.
   Ouvrir une modale pour coller une adresse aurait coûté trois clics là où il en faut un. */
/* Ouvre le champ DANS la case, vide pour un ajout, pré-rempli pour une correction. La
   sélection du texte à l'ouverture est délibérée : neuf fois sur dix on remplace l'adresse
   plutôt qu'on ne la retouche, et retaper par-dessus ne doit pas demander un Ctrl+A. */
/* L'ÉDITEUR TIENT DANS LA CASE, et la case grandit. Un menu surgissant aurait demandé d'être
   positionné, de se refermer au bon moment, et de survivre au défilement du tableau ; la case
   qui s'étire ne demande rien de tout ça et montre exactement où l'on écrit.
   Une ligne par adresse : un nom (facultatif — une case à une seule adresse n'en a pas besoin)
   et l'URL. Vider une URL retire sa ligne à l'enregistrement ; tout vider efface la case. */
function ligneEdition(u = { label: '', url: '' }) {
  return `<div class="lce-row">
    <input type="text" class="lce-label" maxlength="100" placeholder="${esc(tr('links.url.label-ph'))}" value="${esc(u.label || '')}" />
    <input type="url" class="lce-url" placeholder="https://…" value="${esc(u.url || '')}" />
    <button type="button" class="link-icon lce-del" title="${esc(tr('ui.delete'))}" aria-label="${esc(tr('ui.delete'))}">${svgIco('trash')}</button>
  </div>`;
}
function ouvrirCase(td, sid, eid, liste = []) {
  const lignes = (liste.length ? liste : [{ label: '', url: '' }]).map(ligneEdition).join('');
  td.innerHTML = `<div class="link-cell-edit" data-cellfor="${sid}" data-env="${eid}">
    <div class="lce-rows">${lignes}</div>
    <div class="lce-actions">
      <button type="button" class="btn btn-sm btn-ghost lce-add">${svgIco('plus')}<span>${esc(tr('links.url.add'))}</span></button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm lce-cancel">${esc(tr('ui.cancel'))}</button>
      <button type="button" class="btn btn-sm btn-primary lce-save">${esc(tr('ui.save'))}</button>
    </div>
    <p class="muted lce-hint">${esc(tr('links.url.edit-hint'))}</p>
  </div>`;
  const i = $('.lce-url', td);
  i.focus();
  i.select();
}

// Ce que l'éditeur d'une case contient à l'instant t.
const lireCase = (box) => $$('.lce-row', box).map((r) => ({
  label: $('.lce-label', r).value.trim(),
  url: $('.lce-url', r).value.trim(),
})).filter((u) => u.url);

async function enregistrerCase(box) {
  try {
    await api(`/services/${box.dataset.cellfor}/urls`, {
      method: 'PUT',
      body: { environment_id: Number(box.dataset.env), urls: lireCase(box) },
    });
    await loadLinks();
  } catch (err) { toast(explainError(err.message), true); }
}
$('#linkGrid') && $('#linkGrid').addEventListener('click', (e) => {
  const mv = e.target.closest('[data-envmove]');
  if (mv) {
    busy(mv, async () => {
      try {
        await api(`/environments/${mv.dataset.envmove}/move`, { method: 'POST', body: { dir: Number(mv.dataset.dir) } });
        await loadLinks();
      } catch (err) { toast(explainError(err.message), true); }
    });
    return;
  }
  const ee = e.target.closest('[data-envedit]');
  if (ee) {
    const env = ((LINKS.grid && LINKS.grid.environments) || []).find((x) => x.id === Number(ee.dataset.envedit));
    if (env) openEnvModal(env);
    return;
  }
  const plus = e.target.closest('[data-cellopen]');
  if (plus) {
    const cle = plus.dataset.cellopen;
    if (LINKS.ouvertes.has(cle)) LINKS.ouvertes.delete(cle); else LINKS.ouvertes.add(cle);
    renderLinkGrid();
    return;
  }
  const add = e.target.closest('[data-addurl]');
  if (add) { ouvrirCase(add.closest('.link-cell'), add.dataset.addurl, add.dataset.env); return; }
  const maj = e.target.closest('[data-editurl]');
  if (maj) {
    const svc = ((LINKS.grid && LINKS.grid.services) || []).find((x) => x.id === Number(maj.dataset.editurl));
    ouvrirCase(maj.closest('.link-cell'), maj.dataset.editurl, maj.dataset.env,
      (svc && (svc.urls || {})[maj.dataset.env]) || []);
    return;
  }
  const box = e.target.closest('.link-cell-edit');
  if (box) {
    if (e.target.closest('.lce-add')) {
      $('.lce-rows', box).insertAdjacentHTML('beforeend', ligneEdition());
      $$('.lce-url', box).pop().focus();
      return;
    }
    // Retirer la dernière ligne la vide au lieu de la supprimer : sinon la case n'aurait plus
    // de champ où écrire, et il faudrait ressortir puis rentrer pour repartir.
    const del = e.target.closest('.lce-del');
    if (del) {
      const rows = $$('.lce-row', box);
      if (rows.length > 1) del.closest('.lce-row').remove();
      else { $('.lce-label', rows[0]).value = ''; $('.lce-url', rows[0]).value = ''; }
      return;
    }
    if (e.target.closest('.lce-cancel')) { renderLinkGrid(); return; }
    if (e.target.closest('.lce-save')) { enregistrerCase(box); }
  }
  const ed = e.target.closest('[data-editservice]');
  if (ed) openServiceModal(Number(ed.dataset.editservice));
});
$('#linkGrid') && $('#linkGrid').addEventListener('keydown', (e) => {
  const box = e.target.closest('.link-cell-edit');
  if (!box) return;
  if (e.key === 'Escape') { e.preventDefault(); renderLinkGrid(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  enregistrerCase(box);
});
$('#linkFreeList') && $('#linkFreeList').addEventListener('click', (e) => {
  const ra = e.target.closest('[data-filefree]');
  if (ra) { ouvrirRangement([Number(ra.dataset.filefree)]); return; }
  const ed = e.target.closest('[data-editfree]');
  if (ed) { openFreeModal(Number(ed.dataset.editfree)); return; }
  const pick = e.target.closest('[data-freepick]');
  if (pick) {
    const id = Number(pick.dataset.freepick);
    if (pick.checked) LINKS.selection.add(id); else LINKS.selection.delete(id);
    const btn = $('#linkToService');
    if (btn) btn.hidden = LINKS.selection.size < 1;
  }
});

/* ---------- Environnements ---------- */

let envEnCours = null;
function openEnvModal(env) {
  envEnCours = env || null;
  $('#envModalTitle').textContent = tr(env ? 'links.env.edit' : 'links.env.new');
  $('#envName').value = env ? env.name : '';
  $('#envColor').value = (env && env.color) || '#2f6fe0';
  $('#envDelete').hidden = !env;
  $('#envModal').hidden = false;
  setTimeout(() => $('#envName').focus(), 0);
}
$('#envCancel') && $('#envCancel').addEventListener('click', () => { $('#envModal').hidden = true; });
fermerAuFond('#envModal', () => { $('#envModal').hidden = true; }, { salissable: true });
$('#envSave') && $('#envSave').addEventListener('click', async () => {
  const body = { name: $('#envName').value, color: $('#envColor').value };
  try {
    if (envEnCours) await api(`/environments/${envEnCours.id}`, { method: 'PUT', body });
    else await api('/environments', { method: 'POST', body });
    $('#envModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});
$('#envDelete') && $('#envDelete').addEventListener('click', async () => {
  if (!envEnCours) return;
  /* COMBIEN D'ADRESSES PARTENT AVEC LA COLONNE. « Les URLs sont supprimées avec lui » ne dit
     pas s'il y en a une ou quarante, et c'est ce qu'on a besoin de savoir pour répondre. */
  const n = ((LINKS.grid && LINKS.grid.services) || [])
    .reduce((t, s2) => t + (((s2.urls || {})[envEnCours.id] || []).length), 0);
  if (!await confirmDialog({
    title: tr('links.env.delete'),
    text: n
      ? tr('links.env.delete-text-n', { name: envEnCours.name, n, count: n })
      : tr('links.env.delete-text-empty', { name: envEnCours.name }),
    confirmLabel: tr('ui.delete'), danger: true,
  })) return;
  try {
    await api(`/environments/${envEnCours.id}`, { method: 'DELETE' });
    $('#envModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});
/* L'en-tête entier N'EST PLUS cliquable : il l'était sans que rien ne le dise, et le clic
   partait aussi quand on visait les flèches de déplacement. Un bouton nommé, c'est plus long
   à écrire et plus court à comprendre. */

/* ---------- Services et liens contextuels ---------- */

let serviceEnCours = null;
async function openServiceModal(id) {
  serviceEnCours = id ? ((LINKS.grid.services || []).find((s) => s.id === id) || null) : null;
  $('#serviceModalTitle').textContent = tr(serviceEnCours ? 'links.service.edit' : 'links.service.new');
  $('#serviceName').value = serviceEnCours ? serviceEnCours.name : '';
  $('#serviceTags').value = serviceEnCours ? (serviceEnCours.tags || []).join(', ') : '';
  // Le choix du dépôt passe par le sélecteur À RECHERCHE, comme partout ailleurs.
  /* Le dépôt se choisit dans le sélecteur À RECHERCHE, comme partout : la liste peut
     compter des dizaines d'entrées. `defaultFirst: false` — un service sans dépôt est le
     cas courant, en pré-sélectionner un au hasard poserait des boutons sur ses MR. */
  await loadRepoOptions();
  $('#serviceRepoBox').innerHTML = repoComboHtml(serviceEnCours ? serviceEnCours.repo_id : null, { idClass: 'js-service-repo', defaultFirst: false });
  wireRepoCombos($('#serviceRepoBox'));
  $('#servicePinned').checked = !!(serviceEnCours && serviceEnCours.pinned);
  renderServiceUrls();
  $('#serviceDelete').hidden = !serviceEnCours;
  $('#serviceCtxBox').hidden = !serviceEnCours;
  if (serviceEnCours) await renderCtxLinks(serviceEnCours.id);
  $('#serviceModal').hidden = false;
  setTimeout(() => $('#serviceName').focus(), 0);
}

/* Une ligne par environnement, pré-remplie à l'édition. C'est le second chemin vers une URL,
   et il vaut la peine d'exister : la grille sert quand on corrige une case, la modale quand on
   pose tout un service d'un coup. */
/* UNE SEULE adresse par environnement ici — la PREMIÈRE. Les cases qui en portent plusieurs se
   gèrent dans la grille, où l'on voit ce qu'on modifie. La modale sert à poser un service
   utilisable en une passe, pas à administrer dix adresses dans un formulaire.
   Le compte des autres est ANNONCÉ à côté : sans lui, on croirait que la case n'en a qu'une,
   et l'enregistrement — qui remplace la case entière — semblerait les avoir mangées. */
function renderServiceUrls() {
  const envs = ((LINKS.grid && LINKS.grid.environments) || []);
  const box = $('#serviceUrlsList');
  if (!envs.length) { box.innerHTML = `<p class="muted">${esc(tr('links.service.no-env'))}</p>`; return; }
  box.innerHTML = envs.map((e) => {
    const liste = (serviceEnCours && (serviceEnCours.urls || {})[e.id]) || [];
    const premiere = liste[0] || { label: '', url: '' };
    const autres = liste.length - 1;
    return `<label class="link-url-row">
      <span class="link-env"><span class="link-env-dot" style="background:${esc(e.color)}"></span>${esc(e.name)}</span>
      <input type="url" data-svcurl="${e.id}" placeholder="https://…" value="${esc(premiere.url)}" />
      <span class="muted link-url-more">${autres > 0 ? esc(tr('links.url.several', { n: autres, count: autres })) : ''}</span>
    </label>`;
  }).join('');
}
async function renderCtxLinks(serviceId) {
  const box = $('#serviceCtxList');
  try {
    const d = await api(`/services/${serviceId}/context-links`);
    box.innerHTML = (d.links || []).length
      ? d.links.map((l) => `<div class="link-ctx-row"><strong>${esc(l.label)}</strong>`
        + `<code>${esc(l.url_template)}</code>`
        + `<button type="button" class="btn btn-sm btn-ghost btn-danger" data-delctx="${l.id}">${svgIco('trash')}</button></div>`).join('')
      : `<p class="muted">${esc(tr('links.ctx.empty'))}</p>`;
  } catch (e) { box.innerHTML = errorBox(e.message); }
}
$('#serviceCtxList') && $('#serviceCtxList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-delctx]');
  if (!b || !serviceEnCours) return;
  try { await api(`/context-links/${b.dataset.delctx}`, { method: 'DELETE' }); await renderCtxLinks(serviceEnCours.id); }
  catch (err) { toast(explainError(err.message), true); }
});
$('#ctxAdd') && $('#ctxAdd').addEventListener('click', async () => {
  if (!serviceEnCours) return;
  try {
    await api(`/services/${serviceEnCours.id}/context-links`, { method: 'POST', body: { label: $('#ctxLabel').value, url_template: $('#ctxTemplate').value } });
    $('#ctxLabel').value = ''; $('#ctxTemplate').value = '';
    await renderCtxLinks(serviceEnCours.id);
  } catch (e) { toast(explainError(e.message), true); }
});
$('#serviceCancel') && $('#serviceCancel').addEventListener('click', () => { $('#serviceModal').hidden = true; });
fermerAuFond('#serviceModal', () => { $('#serviceModal').hidden = true; }, { salissable: true });
$('#serviceSave') && $('#serviceSave').addEventListener('click', async () => {
  const repo = $('#serviceRepoBox .js-service-repo');
  const body = {
    name: $('#serviceName').value,
    tags: $('#serviceTags').value,
    repo_id: repo ? Number(repo.value) || null : null,
    pinned: $('#servicePinned').checked ? 1 : 0,
  };
  const saisies = $$('#serviceUrlsList [data-svcurl]').map((i) => ({ environment_id: Number(i.dataset.svcurl), url: i.value.trim() }));
  /* La case entière est remplacée à l'enregistrement. On REPOSE donc les adresses suivantes
     telles quelles : sans ça, corriger la première effacerait silencieusement les autres. */
  const casesCompletes = (envId, url) => {
    const liste = (serviceEnCours && (serviceEnCours.urls || {})[envId]) || [];
    const suite = liste.slice(1);
    if (!url) return suite;                       // vider la première ne touche pas aux autres
    return [{ label: (liste[0] || {}).label || '', url }, ...suite];
  };
  try {
    let id;
    if (serviceEnCours) {
      await api(`/services/${serviceEnCours.id}`, { method: 'PUT', body });
      id = serviceEnCours.id;
      /* On n'envoie QUE ce qui a bougé : rejouer les autres pour rien ferait autant d'écritures
         inutiles, et effacerait le verdict de santé de cases qu'on n'a pas touchées. */
      const avant = serviceEnCours.urls || {};
      for (const u of saisies) {
        if ((((avant[u.environment_id] || [])[0]) || {}).url === u.url) continue;
        if (!((avant[u.environment_id] || []).length) && !u.url) continue;
        await api(`/services/${id}/urls`, {
          method: 'PUT',
          body: { environment_id: u.environment_id, urls: casesCompletes(u.environment_id, u.url) },
        });
      }
    } else {
      id = (await api('/services', { method: 'POST', body: { ...body, urls: saisies } })).id;
    }
    $('#serviceModal').hidden = true;
    await loadLinks();
    montrerLigneService(id);
  } catch (e) { toast(explainError(e.message), true); }
});

/* Après enregistrement, on AMÈNE À la ligne au lieu de laisser chercher : la grille est
   alphabétique, un service nouvellement créé atterrit n'importe où. Le surlignage s'efface
   tout seul — il dit « c'est ici », il n'a pas à rester. */
function montrerLigneService(id) {
  if (!id) return;
  const b = $(`#linkGrid [data-editservice="${id}"]`);
  if (!b) return;
  const tr2 = b.closest('tr');
  tr2.scrollIntoView({ block: 'center', behavior: 'smooth' });
  tr2.classList.add('link-flash');
  setTimeout(() => tr2.classList.remove('link-flash'), 1600);
}
$('#serviceDelete') && $('#serviceDelete').addEventListener('click', async () => {
  if (!serviceEnCours) return;
  if (!await confirmDialog({
    title: tr('links.service.delete'), text: tr('links.service.delete-text', { name: serviceEnCours.name }),
    confirmLabel: tr('ui.delete'),
  })) return;
  try {
    await api(`/services/${serviceEnCours.id}`, { method: 'DELETE' });
    $('#serviceModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});

/* ---------- Liens libres ---------- */

let freeEnCours = null;
function openFreeModal(id) {
  freeEnCours = id ? (((LINKS.grid && LINKS.grid.free_links) || []).find((l) => l.id === id) || null) : null;
  $('#freeLinkTitle').textContent = tr(freeEnCours ? 'links.free.edit' : 'links.free.new');
  $('#freeLabel').value = freeEnCours ? freeEnCours.label : '';
  $('#freeUrl').value = freeEnCours ? freeEnCours.url : '';
  $('#freeTags').value = freeEnCours ? (freeEnCours.tags || []).join(', ') : '';
  $('#freeFolder').value = freeEnCours ? (freeEnCours.folder || '') : '';
  /* Tous les dossiers connus, y compris les niveaux INTERMÉDIAIRES : « doc/specs » existe même
     si aucun lien n'est posé directement dans « doc », et le proposer évite de le retaper. */
  const dossiers = new Set();
  for (const l of ((LINKS.grid && LINKS.grid.free_links) || [])) {
    const p2 = String(l.folder || '').split('/').filter(Boolean);
    for (let i = 1; i <= p2.length; i += 1) dossiers.add(p2.slice(0, i).join('/'));
  }
  $('#freeFolders').innerHTML = [...dossiers].sort()
    .map((d) => `<option value="${esc(d)}"></option>`).join('');
  $('#freeDelete').hidden = !freeEnCours;
  $('#freeLinkModal').hidden = false;
  setTimeout(() => $('#freeLabel').focus(), 0);
}
$('#linkNewFree') && $('#linkNewFree').addEventListener('click', () => openFreeModal(null));
$('#freeCancel') && $('#freeCancel').addEventListener('click', () => { $('#freeLinkModal').hidden = true; });
fermerAuFond('#freeLinkModal', () => { $('#freeLinkModal').hidden = true; }, { salissable: true });
$('#freeSave') && $('#freeSave').addEventListener('click', async () => {
  const body = { label: $('#freeLabel').value, url: $('#freeUrl').value, tags: $('#freeTags').value, folder: $('#freeFolder').value };
  try {
    if (freeEnCours) await api(`/free-links/${freeEnCours.id}`, { method: 'PUT', body });
    else await api('/free-links', { method: 'POST', body });
    $('#freeLinkModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});
$('#freeDelete') && $('#freeDelete').addEventListener('click', async () => {
  if (!freeEnCours) return;
  if (!await confirmDialog({ title: tr('links.free.delete'), text: tr('links.free.delete-text', { label: freeEnCours.label }), confirmLabel: tr('ui.delete') })) return;
  try {
    await api(`/free-links/${freeEnCours.id}`, { method: 'DELETE' });
    $('#freeLinkModal').hidden = true;
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
});

/* ---------- Convertir des liens libres en service ---------- */

/* Le geste d'après l'import : deux cents adresses arrivent à plat et il faut les classer.
   On y entre par la ligne d'un lien (le cas courant, un lien à la fois) ou par le mode
   sélection (plusieurs d'un coup, dans le même service). */
function ouvrirRangement(ids) {
  const choisis = ((LINKS.grid && LINKS.grid.free_links) || []).filter((l) => ids.includes(l.id));
  if (!choisis.length) return;
  const envs = (LINKS.grid.environments || []);
  if (!envs.length) { toast(tr('links.free.need-env'), true); return; }

  /* Le sélecteur À RECHERCHE, comme partout où une liste peut être longue. La première entrée
     crée un service à la volée : ne savoir que créer obligeait à tout ranger du premier coup,
     ne savoir que choisir obligeait à créer le service avant. */
  $('#toServiceBox').innerHTML = comboHtml('js-toservice', { value: 'new', label: tr('links.free.file-new'), ph: tr('links.free.pick-service') });
  wireCombo($('#toServiceBox'), 'js-toservice', () => [
    { value: 'new', label: tr('links.free.file-new') },
    ...((LINKS.grid.services || []).map((x) => ({ value: String(x.id), label: x.name, hint: (x.tags || []).join(' · ') }))),
  ]);
  $('#toServiceName').value = nomCommun(choisis.map((l) => l.label));
  majRangementNom();

  const options = (sel) => `<option value="">${esc(tr('links.free.skip'))}</option>`
    + envs.map((e) => `<option value="${e.id}"${String(sel) === String(e.id) ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
  // Un seul environnement à choisir pour tous : c'est le cas courant, et le refaire ligne à
  // ligne sur douze liens est exactement ce qui fait renoncer.
  $('#toServiceAllEnv').innerHTML = options(envs[0].id);
  /* Une ligne par lien, un environnement à choisir : le mapping est EXPLICITE. Deviner
     « dev » depuis une URL contenant « -dev » marcherait neuf fois sur dix — et la dixième
     poserait une URL de production dans la colonne de développement. */
  $('#toServiceRows').innerHTML = choisis.map((l) => `<div class="link-ctx-row">
      <span class="link-free-url" title="${esc(l.url)}">${esc(l.label)} — ${esc(l.url)}</span>
      <select data-mapfree="${l.id}">${options(envs[0].id)}</select>
    </div>`).join('');
  $('#toServiceModal').hidden = false;
}

// Le nom ne se demande que pour un service qu'on crée : sinon il n'a rien à dire.
function majRangementNom() {
  const v = ($('#toServiceBox .js-toservice') || {}).value;
  $('#toServiceNameRow').hidden = v !== 'new';
}
$('#toServiceBox') && $('#toServiceBox').addEventListener('change', majRangementNom);
$('#toServiceAllEnv') && $('#toServiceAllEnv').addEventListener('change', () => {
  const v = $('#toServiceAllEnv').value;
  $$('#toServiceRows [data-mapfree]').forEach((sel) => { sel.value = v; });
});

$('#linkToService') && $('#linkToService').addEventListener('click', () => {
  ouvrirRangement([...LINKS.selection]);
});
// Le plus long préfixe commun aux libellés : « Kibana dev » + « Kibana prod » → « Kibana ».
function nomCommun(labels) {
  if (!labels.length) return '';
  let p = labels[0];
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < p.length && i < l.length && p[i].toLowerCase() === l[i].toLowerCase()) i += 1;
    p = p.slice(0, i);
  }
  return p.replace(/[\s\-—·|]+$/, '').trim() || labels[0];
}
$('#toServiceCancel') && $('#toServiceCancel').addEventListener('click', () => { $('#toServiceModal').hidden = true; });
fermerAuFond('#toServiceModal', () => { $('#toServiceModal').hidden = true; }, { salissable: true });
$('#toServiceOk') && $('#toServiceOk').addEventListener('click', async () => {
  const mapping = $$('#toServiceRows [data-mapfree]')
    .filter((s) => s.value)
    .map((s) => ({ free_link_id: Number(s.dataset.mapfree), environment_id: Number(s.value) }));
  const choix = ($('#toServiceBox .js-toservice') || {}).value;
  const corps = choix === 'new'
    ? { name: $('#toServiceName').value, mapping }
    : { service_id: Number(choix), mapping };
  try {
    const r = await api('/free-links/to-service', { method: 'POST', body: corps });
    $('#toServiceModal').hidden = true;
    LINKS.selectMode = false;
    LINKS.selection.clear();
    // Le nom du service est DIT : rangé quelque part, on veut savoir où sans aller vérifier.
    toast(tr('links.free.filed', { n: r.ranges, count: r.ranges, service: (r.service || {}).name || '' }));
    await loadLinks();
    montrerLigneService((r.service || {}).id);
  } catch (e) { toast(explainError(e.message), true); }
});

/* ---------- Import Chrome ---------- */

/* Tout effacer, derrière une confirmation qui ANNONCE LE NOMBRE. « Supprimer tous les liens ? »
   ne dit pas s'il y en a trois ou deux cents, et c'est exactement ce qu'on a besoin de savoir
   avant de répondre. Le message précise aussi ce qui n'est PAS touché : de là où on clique, la
   grille est juste au-dessus, et rien ne dit que « les liens » ne la désigne pas. */
async function viderLiensLibres() {
  const n = (((LINKS.grid || {}).free_links) || []).length;
  if (!n) return;
  if (!await confirmDialog({
    title: tr('links.free.delete-all'), text: tr('links.free.delete-all-text', { n, count: n }),
    confirmLabel: tr('ui.delete'), danger: true,
  })) return;
  try {
    const r = await api('/free-links', { method: 'DELETE' });
    toast(tr('links.free.deleted-all', { n: r.deleted, count: r.deleted }));
    LINKS.selection.clear();
    await loadLinks();
  } catch (e) { toast(explainError(e.message), true); }
}

/* Nommée, parce qu'on y entre maintenant par trois portes : le menu « Autres actions »,
   l'état vide, et rien d'autre — le bouton de barre a disparu avec la barre de configuration. */
function ouvrirImport() {
  LINKS.importLinks = [];
  $('#importPreview').hidden = true;
  $('#importApply').disabled = true;
  $('#importFile').value = '';
  $('#importModal').hidden = false;
}
$('#importCancel') && $('#importCancel').addEventListener('click', () => { $('#importModal').hidden = true; });
fermerAuFond('#importModal', () => { $('#importModal').hidden = true; }, { salissable: true });
$('#importFile') && $('#importFile').addEventListener('change', async () => {
  const f = $('#importFile').files[0];
  if (!f) return;
  try {
    const html = await f.text();
    const d = await api('/links/import', { method: 'POST', body: { html } });
    LINKS.importLinks = d.links || [];
    LINKS.importGrid = d.proposal && (d.proposal.services || []).length ? d.proposal : null;
    renderImport();
  } catch (e) { toast(explainError(e.message), true); }
});
/* L'arbre des dossiers, tel qu'il était dans le navigateur : on reconnaît son propre
   rangement, ce qui rend le choix évident. Les tags proposés viennent de ce chemin. */
function renderImport() {
  const box = $('#importTree');
  if (!LINKS.importLinks.length) {
    box.innerHTML = `<p class="muted">${esc(tr('links.import.empty'))}</p>`;
    $('#importPreview').hidden = false;
    $('#importApply').disabled = true;
    return;
  }
  renderImportProposal();
  /* Les dossiers absorbés par la grille ne sont plus proposés en liens libres : les laisser
     ferait importer deux fois la même adresse, une fois dans une case et une fois à plat. */
  const absorbes = new Set(pris());
  const parDossier = new Map();
  LINKS.importLinks.forEach((l, i) => {
    if (absorbes.has(dossierCourt(l.folder))) return;
    const d = l.folder || tr('links.import.root');
    if (!parDossier.has(d)) parDossier.set(d, []);
    parDossier.get(d).push({ ...l, i });
  });
  /* REPLIÉ, ET RIEN DE COCHÉ. Deux cents favoris cochés d'office entrent d'un clic, et on
     passe le reste de la journée à faire le tri dans une liste plate. Un dossier par ligne,
     avec son compte et sa case : on déplie celui qu'on veut, on coche, on importe douze liens.
     Choisir ce qui entre coûte dix secondes ; trier ce qui est entré coûte une demi-heure. */
  box.innerHTML = [...parDossier.entries()].map(([dossier, liens], k) => `
    <details class="import-folder-box"${k === 0 && parDossier.size === 1 ? ' open' : ''}>
      <summary>
        <input type="checkbox" class="imp-folder" data-folder="${k}" aria-label="${esc(tr('links.import.pick-folder'))}" />
        <span class="import-folder">${esc(dossier)}</span>
        <span class="muted">${esc(tr('links.import.count-folder', { n: liens.length, count: liens.length }))}</span>
      </summary>
      ${liens.map((l) => `<label class="import-item" data-in="${k}">
        <input type="checkbox" data-imp="${l.i}" />
        <span>${esc(l.label)}</span>
        <span class="import-url">${esc(l.url)}</span>
      </label>`).join('')}
    </details>`).join('');
  $('#importPreview').hidden = false;
  majImportCount();
}
/* Le chemin tel que le serveur le compte : sans la racine du navigateur, qui ne dit rien. */
const RACINES_VUES = /^(barre de favoris|autres favoris|favoris mobiles|barre personnelle|menu des marque-pages|marque-pages mobiles|autres marque-pages|bookmarks bar|bookmarks toolbar|other bookmarks|mobile bookmarks|bookmarks menu|favorites bar)\//i;
const dossierCourt = (f) => String(f || '').replace(RACINES_VUES, '');
const pris = () => (LINKS.importGrid && $('#importGrid') && $('#importGrid').checked ? LINKS.importGrid.folders : []);

function renderImportProposal() {
  const box = $('#importProposal');
  if (!box) return;
  box.hidden = !LINKS.importGrid;
  if (!LINKS.importGrid) return;
  const { environments: envs, services } = LINKS.importGrid;
  $('#importProposalTitle').textContent = tr('links.import.grid', {
    envs: tr('links.import.grid-envs', { n: envs.length, count: envs.length }),
    svcs: tr('links.import.grid-svcs', { n: services.length, count: services.length }),
  });
  /* La grille TELLE QU'ELLE SERA, pas une phrase qui la décrit : c'est en la voyant qu'on sait
     si elle a du sens, et un compte par case suffit à s'en rendre compte.
     Chaque ligne est COCHABLE parce que la détection ne peut pas tout savoir : elle ne sait pas
     que « logs · keycloak » et « logs · purge » sont, pour toi, le même service. Deux lignes
     cochées, un nom, et elles n'en font plus qu'une. */
  const entete = envs.map((e) => `<th>${esc(e)}</th>`).join('');
  /* Le nom de chaque ligne est MODIFIABLE ici : la détection le tire d'un nom de dossier, qui
     n'est pas toujours celui qu'on donnerait au service. Le corriger avant la création coûte
     une frappe ; le corriger après demande d'ouvrir la fiche du service. */
  const lignes = services.map((svc, i) => {
    const n = (env) => ((svc.cells.find((c) => c.env === env) || {}).links || []).length;
    return `<tr><td class="ig-first"><input type="checkbox" data-igrow="${i}" aria-label="${esc(tr('links.import.merge'))}" />
        <input type="text" class="ig-name" data-igname="${i}" maxlength="100" value="${esc(svc.name)}" /></td>${envs.map((e) => `<td>${n(e) || '·'}</td>`).join('')}</tr>`;
  }).join('');
  $('#importProposalTable').innerHTML = `<table class="import-grid"><thead><tr><th></th>${entete}</tr></thead><tbody>${lignes}</tbody></table>`
    + `<div class="toolbar toolbar-tight"><button type="button" id="importMerge" class="btn btn-sm" hidden>`
    + `${svgIco('merge')}<span>${esc(tr('links.import.merge'))}</span></button>`
    + `<span class="muted">${esc(tr('links.import.grid-help'))}</span></div>`;
}
$('#importGrid') && $('#importGrid').addEventListener('change', renderImport);

/* FUSIONNER DES LIGNES. La détection lit des noms de dossiers ; elle ne sait pas que deux
   d'entre eux désignent le même service chez toi. On coche, on nomme, et les cases se
   rejoignent — environnement par environnement, sans rien perdre. */
$('#importProposalTable') && $('#importProposalTable').addEventListener('change', () => {
  const n = $$('#importProposalTable [data-igrow]:checked').length;
  const b = $('#importMerge');
  if (b) b.hidden = n < 2;
});
/* On note le nom SANS re-rendre : re-rendre à chaque frappe reprendrait le focus au champ, et
   l'on ne pourrait pas écrire trois lettres d'affilée. */
$('#importProposalTable') && $('#importProposalTable').addEventListener('input', (e) => {
  const i = e.target.closest('[data-igname]');
  if (!i || !LINKS.importGrid) return;
  const svc = LINKS.importGrid.services[Number(i.dataset.igname)];
  if (svc) svc.name = i.value;
});
$('#importProposalTable') && $('#importProposalTable').addEventListener('click', (e) => {
  if (!e.target.closest('#importMerge')) return;
  const idx = $$('#importProposalTable [data-igrow]:checked').map((c) => Number(c.dataset.igrow));
  if (idx.length < 2) return;
  const choisis = idx.map((i) => LINKS.importGrid.services[i]);
  // Le nom part du préfixe commun — celui qu'on allait taper — et reste modifiable dans le tableau.
  const fusion = { name: prefixeCommun(choisis.map((s2) => s2.name)), source: choisis[0].source, cells: [] };
  for (const svc of choisis) {
    for (const cell of svc.cells) {
      let c = fusion.cells.find((x) => x.env === cell.env);
      if (!c) { c = { env: cell.env, links: [] }; fusion.cells.push(c); }
      c.links.push(...cell.links);
    }
  }
  LINKS.importGrid.services = [fusion, ...LINKS.importGrid.services.filter((s2) => !choisis.includes(s2))]
    .sort((a, b2) => a.name.localeCompare(b2.name));
  renderImport();
});

// « logs · keycloak » + « logs · purge » → « logs ». Le préfixe commun est le nom qu'on allait taper.
function prefixeCommun(noms) {
  if (!noms.length) return '';
  let p = noms[0];
  for (const n of noms.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i].toLowerCase() === n[i].toLowerCase()) i += 1;
    p = p.slice(0, i);
  }
  return p.replace(/[\s·\-—|]+$/, '').trim() || noms[0];
}

function majImportCount() {
  const n = $$('#importTree [data-imp]:checked').length;
  $('#importCount').textContent = tr('links.import.count', { n, count: n });
  $('#importApply').disabled = !n;
}
$('#importTree') && $('#importTree').addEventListener('change', (e) => {
  // La case d'un dossier coche ses liens ; cocher les liens à la main met la sienne d'accord.
  const f = e.target.closest('.imp-folder');
  if (f) {
    $$(`#importTree .import-item[data-in="${f.dataset.folder}"] [data-imp]`).forEach((c) => { c.checked = f.checked; });
  } else {
    $$('#importTree .import-folder-box').forEach((d) => {
      const cases = $$('[data-imp]', d);
      const chef = $('.imp-folder', d);
      if (!chef) return;
      chef.checked = cases.length > 0 && cases.every((c) => c.checked);
      chef.indeterminate = !chef.checked && cases.some((c) => c.checked);
    });
  }
  majImportCount();
});
$('#importAll') && $('#importAll').addEventListener('click', () => { $$('#importTree input[type=checkbox]').forEach((c) => { c.checked = true; c.indeterminate = false; }); majImportCount(); });
$('#importNone') && $('#importNone').addEventListener('click', () => { $$('#importTree input[type=checkbox]').forEach((c) => { c.checked = false; c.indeterminate = false; }); majImportCount(); });
$('#importApply') && $('#importApply').addEventListener('click', async (e) => {
  const choisis = $$('#importTree [data-imp]:checked').map((c) => LINKS.importLinks[Number(c.dataset.imp)]).filter(Boolean);
  const grid = LINKS.importGrid && $('#importGrid').checked ? LINKS.importGrid : null;
  try {
    const r = await busy(e.currentTarget, () => api('/links/import/apply', { method: 'POST', body: { links: choisis, grid } }));
    $('#importModal').hidden = true;
    /* Le compte des IGNORÉS est dit : un import rejoué qui ne crée rien doit s'expliquer,
       sinon il passe pour un échec silencieux. */
    /* Ce que la grille a produit est DIT : sans ça, on voit soixante-neuf liens importés et on
       cherche où sont passés les soixante-treize autres. */
    if (r.services_created || r.urls_created) {
      toast(tr('links.import.done-grid', {
        n: r.created,
        svcs: tr('links.import.grid-svcs', { n: r.services_created, count: r.services_created }),
        urls: tr('links.import.urls-n', { n: r.urls_created, count: r.urls_created }),
      }));
    } else {
      toast(r.skipped
        ? tr('links.import.done-skipped', { n: r.created, count: r.created, skipped: r.skipped })
        : tr('links.import.done', { n: r.created, count: r.created }));
    }
    await loadLinks();
  } catch (err) { toast(explainError(err.message), true); }
});

$('#linkGrid') && $('#linkGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-empty-act]');
  if (!b) return;
  if (b.dataset.emptyAct === 'import') ouvrirImport();
  else openEnvModal(null);
});

/* ---------- Boutons contextuels sur une merge request ---------- */

/* Les liens du service associé au dépôt de la MR : ses URLs de grille, puis ses gabarits
   résolus avec la branche et le numéro. Un gabarit non résoluble ICI reste affiché, GRISÉ,
   avec sa raison — le faire disparaître laisserait croire qu'il n'existe pas. */
async function renderMrLinks(mrId, box) {
  if (!box) return;
  let d;
  try { d = await api(`/mrs/${mrId}/links`); } catch { return; }
  if (!d.service || (!d.envs.length && !d.context.length)) return;
  const boutons = [
    /* Un bouton PAR ADRESSE : une case qui porte « erreurs paiement » et « latence API » en
       donne deux, chacun nommé. Sans le libellé, deux boutons « Ouvrir · prod » côte à côte
       obligeraient à en survoler un pour savoir lequel est lequel. */
    ...d.envs.map((e) => `<a class="btn btn-sm" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer"
        data-usekind="service_url" data-useref="${d.service.id}:${e.environment_id}" title="${esc(e.url)}">
        <span class="link-env-dot" style="background:${esc(e.color)}"></span>${esc(e.label
          ? tr('links.mr.open-named', { env: e.env, name: e.label })
          : tr('links.mr.open', { env: e.env }))}</a>`),
    ...d.context.flatMap((c) => {
      if (c.per_env.length) {
        return c.per_env.map((k) => (k.url
          ? `<a class="btn btn-sm" href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">${svgIco('zap')}${esc(c.label)} · ${esc(k.env)}</a>`
          : `<button type="button" class="btn btn-sm" disabled title="${esc(tr('links.mr.unresolved', { name: `{${k.manquante}}` }))}">${svgIco('zap')}${esc(c.label)} · ${esc(k.env)}</button>`));
      }
      return [c.url
        ? `<a class="btn btn-sm" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${svgIco('zap')}${esc(c.label)}</a>`
        : `<button type="button" class="btn btn-sm" disabled title="${esc(tr('links.mr.unresolved', { name: `{${c.manquante}}` }))}">${svgIco('zap')}${esc(c.label)}</button>`];
    }),
  ];
  box.innerHTML = `<div class="mr-links"><span class="muted">${esc(d.service.name)}</span>${boutons.join('')}</div>`;
}

/* ---------- Sidebar ---------- */

const SIDEBAR_KEY = 'mergerie_sidebar';
function appliquerSidebar(compacte) {
  document.body.classList.toggle('sidebar-compacte', compacte);
  /* Sous 1100 px, le CSS compacte de lui-même. `sidebar-large` dit « l'utilisateur a
     DEMANDÉ le format large » et lève cette compaction automatique — sans quoi son choix
     serait ignoré sur un écran moyen sans qu'il comprenne pourquoi. */
  document.body.classList.toggle('sidebar-large', !compacte);
  const b = $('#sidebarToggle');
  if (b) b.title = tr(compacte ? 'nav.expand' : 'nav.collapse');
}
$('#sidebarToggle') && $('#sidebarToggle').addEventListener('click', () => {
  const compacte = !document.body.classList.contains('sidebar-compacte');
  try { localStorage.setItem(SIDEBAR_KEY, compacte ? '1' : '0'); } catch { /* stockage indisponible */ }
  appliquerSidebar(compacte);
});
(function restaurerSidebar() {
  let v = null;
  try { v = localStorage.getItem(SIDEBAR_KEY); } catch { /* stockage indisponible */ }
  // Sans choix enregistré, on laisse le CSS décider selon la largeur.
  if (v !== null) appliquerSidebar(v === '1');
})();

/* ---------- Raccourcis clavier ----------
   Un seul écouteur, avec garde de saisie : on ne détourne jamais une frappe
   destinée à un champ de texte. Les vues plein écran gardent leurs propres touches. */
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
/* Ctrl/Cmd+K passe AVANT la garde de saisie : c'est le seul raccourci qui doit fonctionner
   même le curseur dans un champ — sinon il ne marcherait pas là où on en a le plus besoin. */
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('#paletteModal').hidden) openPalette(); else closePalette();
  }
});
document.addEventListener('keydown', (e) => {
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  // pas de raccourci global quand une vue plein écran ou une modale est ouverte
  if (!$('#splitView').hidden) return;
  if ($$('.modal').some((m) => !m.hidden)) return;
  /* Les chiffres suivent la BARRE, lue dans le DOM — jamais une liste recopiée à côté.
     Une copie se désynchronise au premier réordonnancement, et le décalage est silencieux :
     « 3 » ouvrirait un autre onglet que le troisième, sans que rien ne signale l'erreur. */
  /* `0` prend le DIXIÈME onglet, faute de touche « 10 » — la convention des navigateurs.
     Sans lui, ajouter un onglet retirait en silence son raccourci au dernier de la barre. */
  if (/^[0-9]$/.test(e.key)) {
    const t = $$('nav button[data-tab]')[e.key === '0' ? 9 : +e.key - 1];
    if (t) { e.preventDefault(); t.click(); }
    return;
  }
  switch (e.key) {
    case '/': e.preventDefault(); { const s = $('#searchReview'); if (s && !$('#tab-review').classList.contains('active')) $('nav button[data-tab="review"]').click(); if (s) s.focus(); } break;
    case 'r': if ($('#tab-review').classList.contains('active')) { e.preventDefault(); $('#btnDiscover').click(); } break;
    case 'l': {
      e.preventDefault();
      const panel = $('#logPanel');
      // Panneau masqué (par « masquer » ou repli auto) et un job existe → le rouvrir ; sinon
      // simple bascule déplier/replier du corps du journal.
      if (panel && panel.hidden && logJobId) showLogPanel();
      else { const t = $('#logToggle'); if (t) t.click(); }
      break;
    }
    case '?': e.preventDefault(); openShortcuts(); break;
    /* Capture rapide : la touche la plus utile de l'onglet Notes est celle qui n'oblige pas
       à y aller. On note ce qui vient de passer, on trie plus tard. */
    case 'n': e.preventDefault(); openCapture(); break;
    /* `o` comme « ouvrir » : la palette est le chemin le plus court vers n'importe quoi, et
       elle mérite une touche seule en plus de Ctrl/Cmd + K. */
    case 'o': e.preventDefault(); openPalette(); break;
    /* Navigation au clavier dans la liste courante. Ce qu'elle procure n'est pas une
       surprise mais un RYTHME : traiter vingt MR au clavier, c'est de la cadence ; à la
       souris, c'est de la visée. Aucune logique dupliquée — on clique les boutons rendus. */
    case 'j': e.preventDefault(); bougerFocusCarte(1); break;
    case 'k': e.preventDefault(); bougerFocusCarte(-1); break;
    case 'Enter': { const c = carteFocus(); if (c) { e.preventDefault(); const b = c.querySelector('.btn-primary'); if (b) b.click(); } break; }
    case 'd': { const c = carteFocus(); if (c) { e.preventDefault(); const b = c.querySelector('[data-diff]'); if (b) b.click(); } break; }
    case 'Escape': { const c = carteFocus(); if (c) c.classList.remove('focused'); break; }
    default: break;
  }
});

/* ---------- Test de connexion GitLab (réutilise un endpoint existant) ---------- */
const btnTestGitlab = $('#btnTestGitlab');
if (btnTestGitlab) btnTestGitlab.addEventListener('click', async () => {
  const info = $('#configInfoGit') || $('#configInfo');
  btnTestGitlab.disabled = true; info.textContent = tr('settings.test.running');
  try {
    const r = await api('/gitlab/projects');
    const n = (r.projects || r || []).length;
    info.textContent = tr('settings.conn.ok', { n, count: n });
  } catch (e) {
    info.textContent = '';
    toast(explainError(e.message), true);
  } finally { btnTestGitlab.disabled = false; }
});

const btnTestGithub = $('#btnTestGithub');
if (btnTestGithub) btnTestGithub.addEventListener('click', async () => {
  const info = $('#configInfoGithub');
  btnTestGithub.disabled = true; info.textContent = tr('settings.test.running');
  try {
    const f = $('#configForm');
    const r = await api('/github/test', { method: 'POST', body: {
      github_url: f.github_url.value.trim(),
      github_token: f.github_token.value,
    } });
    info.textContent = tr('settings.github.test-ok', { login: r.login });
    info.className = 'ok';
  } catch (e) {
    info.textContent = e.message; info.className = 'err';
  } finally { btnTestGithub.disabled = false; }
});

const btnTestJira = $('#btnTestJira');
if (btnTestJira) btnTestJira.addEventListener('click', async () => {
  const f = $('#configForm');
  const key = prompt(tr('settings.jira.test-prompt'));
  if (!key) return;
  const info = $('#configInfoJira') || $('#configInfo');
  info.textContent = tr('settings.jira.testing');
  try {
    // On envoie les valeurs SAISIES (URL/email/token) pour tester avant d'enregistrer.
    const r = await api('/jira/test', { method: 'POST', body: {
      key: key.trim(),
      jira_url: f.jira_url.value.trim(),
      jira_email: f.jira_email.value.trim(),
      jira_token: f.jira_token.value,
    } });
    info.textContent = tr('settings.jira.ok', { key: r.key, summary: (r.summary || '').slice(0, 60) });
  } catch (e) {
    info.textContent = '';
    toast(explainError(e.message), true);
  }
});

/* Tester Jenkins : mêmes règles que Jira — on teste les valeurs SAISIES, et le masque veut
   dire « garde le jeton déjà enregistré ». Le nom du compte rendu par Jenkins prouve que le
   couple utilisateur/jeton est le bon, pas seulement que l'URL répond. */
const btnTestJenkins = $('#btnTestJenkins');
if (btnTestJenkins) btnTestJenkins.addEventListener('click', async () => {
  const f = $('#configForm');
  const info = $('#configInfoJenkins') || $('#configInfo');
  info.textContent = tr('settings.jenkins.testing');
  try {
    const r = await busy(btnTestJenkins, () => api('/jenkins/test', { method: 'POST', body: {
      jenkins_url: f.jenkins_url.value.trim(),
      jenkins_user: f.jenkins_user.value.trim(),
      jenkins_token: f.jenkins_token.value,
    } }));
    info.textContent = tr('settings.jenkins.ok', { user: r.user, n: r.jobs, count: r.jobs });
  } catch (e) {
    info.textContent = '';
    toast(explainError(e.message), true);
  }
});

/* ================= Vérification objective (plan_add_verify.md §8) =================
   Trois écrans se partagent le sujet : les vérificateurs (Réglages), les badges et la
   sélection multiple (Reviews), les lots (Dev IA). Tout ce qui vient d'un script de
   vérification est une donnée NON FIABLE : elle est échappée sans exception. */

/* ---------- Réglages → Vérificateurs ---------- */

let verifiers = [];

async function loadVerifiers() {
  await loadRepoOptions();
  // Le mode « in place » propose de piocher dans les répertoires locaux déclarés.
  await loadLocalRoots();
  try { verifiers = await api('/verifiers'); } catch (e) { verifiers = []; toast(explainError(e.message), true); }
  renderVerifierRepoBox();
  renderCommandList([]);
  appliquerKind();
  renderVerifierList();
}

/* Couverture déclarative : une ligne par dépôt, cochée ou non. Recherche obligatoire — le
   nombre de dépôts peut être élevé, et elle MASQUE sans décocher : filtrer ne doit jamais
   modifier la sélection en cours. */
function renderVerifierRepoBox(lignes = []) {
  const box = $('#verifierRepoBox');
  if (!box) return;
  const par = new Map(lignes.map((l) => [l.repo_id, l]));
  const items = repoOptions.map((r) => {
    const l = par.get(r.id);
    return `<div class="vr-row" data-repo="${r.id}">
      <label class="repo-multi-item"><input type="checkbox" class="vr-pick" value="${r.id}" ${l ? 'checked' : ''} /> <span>${esc(r.project)}</span></label>
      <div class="vr-cfg" ${l ? '' : 'hidden'}>
        <select class="vr-mode">
          <option value="worktree" ${!l || l.mode === 'worktree' ? 'selected' : ''}>${esc(tr('verify.mode.worktree'))}</option>
          <option value="in_place" ${l && l.mode === 'in_place' ? 'selected' : ''}>${esc(tr('verify.mode.in-place'))}</option>
        </select>
        <span class="vr-ip" ${l && l.mode === 'in_place' ? '' : 'hidden'}>
          ${/* Piocher dans les répertoires locaux déclarés plutôt que retaper un chemin : une
                faute de frappe ici ne se découvre qu'au premier run, et coûte le run. Le champ
                libre reste, pour un répertoire hors de toute racine déclarée. */''}
          ${localRoots.length
    ? comboHtml('vr-local', { ph: tr('verify.ph.pick-local'), wrapClass: 'vr-local-combo' })
    : `<span class="muted">${esc(tr('verify.no-local-root'))}</span>`}
          <input class="vr-workdir" type="text" placeholder="${esc(tr('verify.ph.workdir'))}" value="${esc((l && l.workdir) || '')}" />
          <button type="button" class="btn vr-test">${esc(tr('verify.btn.test-workdir'))}</button>
          <label class="inline-check"><input type="checkbox" class="vr-allow" ${l && l.checkout_allowed ? 'checked' : ''} /> <span>${esc(tr('verify.lbl.checkout-allowed'))}</span></label>
          <span class="vr-test-info muted"></span>
        </span>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = `<input class="repo-multi-search" type="search" placeholder="${esc(tr('git.explorer.search-ph'))}" />
    <div class="repo-multi-list vr-list">${items || `<span class="muted">${esc(tr('settings.repo.empty.title'))}</span>`}</div>`;
  const search = $('.repo-multi-search', box);
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase().trim();
    $$('.vr-row', box).forEach((it) => { it.hidden = !!q && !$('.repo-multi-item span', it).textContent.toLowerCase().includes(q); });
  });
  cablerChoixLocal(box);
}

/* Le sélecteur de projet local. Il liste TOUS les projets git de TOUTES les racines : ce
   qu'on cherche ici, c'est un répertoire de travail précis, pas une racine — la faire choisir
   d'abord ajouterait un geste sans rien apprendre. Recherche à la frappe (`wireCombo`), parce
   qu'une racine contient couramment des dizaines de projets. */
function cablerChoixLocal(box) {
  wireCombo(box, 'vr-local', async () => {
    const parRacine = await Promise.all(localRoots.map(async (r) => {
      let projets = [];
      try { projets = await localProjectsOf(r.id); } catch { projets = []; }
      return { racine: r, projets };
    }));
    const plusieurs = localRoots.length > 1;
    return parRacine.flatMap(({ racine, projets }) => projets
      // Seuls les dépôts git : le mode in place exige un dépôt dont l'origine correspond,
      // proposer un dossier ordinaire ne proposerait qu'un échec.
      .filter((p) => p.git)
      .map((p) => ({
        value: p.path,
        label: plusieurs ? `${racine.label || racine.path} / ${p.name}` : p.name,
        hint: p.branch ? `· ${p.branch}` : '',
      })));
  });
  $$('.vr-local', box).forEach((h) => h.addEventListener('change', () => {
    const champ = $('.vr-workdir', h.closest('.vr-row'));
    if (champ && h.value) champ.value = h.value;
  }));
}

// Le genre pilote la moitié du formulaire : liste de commandes d'un côté, script de l'autre.
function verifierKind() {
  const f = $('#verifierForm');
  return f && f.kind.value === 'script' ? 'script' : 'commands';
}

function appliquerKind() {
  const k = verifierKind();
  const cmds = $('#verifierCommandsBlock');
  const scr = $('#verifierScriptBlock');
  if (cmds) cmds.hidden = k !== 'commands';
  if (scr) scr.hidden = k === 'commands';
  const aide = $('#verifierRepoHint');
  if (aide) aide.textContent = k === 'commands' ? tr('settings.verifier.repos.commands') : tr('settings.verifier.repos.script');
}

/* Une commande par ligne éditable. L'ordre est PORTEUR DE SENS — `npm ci` avant `npm test` —
   donc il se corrige sans tout retaper : deux flèches par ligne, désactivées aux extrémités
   plutôt qu'inertes, pour qu'on voie où on est dans la liste. */
function renderCommandList(commands) {
  const el = $('#verifierCommandList');
  if (!el) return;
  const liste = commands && commands.length ? commands : [''];
  el.innerHTML = liste.map((c, i) => `<div class="vc-row">
    <span class="vc-rank muted">${i + 1}</span>
    <input class="vc-cmd" type="text" value="${esc(c)}" placeholder="${esc(tr('settings.verifier.ph.command-line'))}" />
    <button type="button" class="btn vc-move" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="${esc(tr('settings.verifier.btn.move-up'))}">${svgIco('up')}</button>
    <button type="button" class="btn vc-move" data-dir="1" ${i === liste.length - 1 ? 'disabled' : ''} title="${esc(tr('settings.verifier.btn.move-down'))}">${svgIco('down')}</button>
    <button type="button" class="btn btn-danger vc-del" title="${esc(tr('ui.delete'))}">${svgIco('trash')}</button>
  </div>`).join('');
}

/* Déplace la ligne `i` d'un cran. On relit les valeurs À L'ÉCRAN avant de réordonner : une
   commande en cours de frappe, pas encore enregistrée, ne doit pas être perdue par le
   réaffichage. */
function deplacerCommande(i, dir) {
  const vals = $$('#verifierCommandList .vc-cmd').map((x) => x.value);
  const j = i + dir;
  if (j < 0 || j >= vals.length) return;
  [vals[i], vals[j]] = [vals[j], vals[i]];
  renderCommandList(vals);
  const champs = $$('#verifierCommandList .vc-cmd');
  if (champs[j]) champs[j].focus();
}

function commandesDuFormulaire() {
  return $$('#verifierCommandList .vc-cmd').map((i) => i.value.trim()).filter(Boolean);
}

// Les lignes de couverture telles que l'API les attend.
function verifierReposFromForm() {
  return $$('#verifierRepoBox .vr-row').filter((row) => $('.vr-pick', row).checked).map((row) => {
    const mode = $('.vr-mode', row).value;
    return {
      repo_id: Number(row.dataset.repo),
      mode,
      workdir: mode === 'in_place' ? $('.vr-workdir', row).value.trim() : null,
      checkout_allowed: mode === 'in_place' && $('.vr-allow', row).checked ? 1 : 0,
    };
  });
}

$('#verifierRepoBox') && $('#verifierRepoBox').addEventListener('change', (e) => {
  const row = e.target.closest && e.target.closest('.vr-row');
  if (!row) return;
  if (e.target.classList.contains('vr-pick')) $('.vr-cfg', row).hidden = !e.target.checked;
  if (e.target.classList.contains('vr-mode')) $('.vr-ip', row).hidden = e.target.value !== 'in_place';
});

/* « Tester le répertoire » : on répond pendant que le formulaire est encore sous les yeux.
   Découvrir un mauvais chemin au premier run, c'est un run perdu et une erreur loin de sa cause. */
$('#verifierRepoBox') && $('#verifierRepoBox').addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('.vr-test');
  if (!b) return;
  const row = b.closest('.vr-row');
  const info = $('.vr-test-info', row);
  const workdir = $('.vr-workdir', row).value.trim();
  info.className = 'vr-test-info muted';
  info.textContent = tr('verify.test.running');
  try {
    const r = await busy(b, () => api('/verifiers/test-workdir', { method: 'POST', body: { repo_id: Number(row.dataset.repo), workdir } }));
    if (!r.ok) { info.className = 'vr-test-info err'; info.textContent = r.raison || tr('verify.test.ko'); return; }
    /* Deux réserves distinctes, et une seule est bloquante : des modifications non commitées
       feraient refuser le run, des fichiers non suivis non — mais il faut savoir qu'ils
       seront là pendant les tests. Les taire ferait passer pour propre un répertoire qui ne
       l'est pas tout à fait. */
    info.className = 'vr-test-info ok';
    const reserves = [
      r.dirty ? tr('verify.test.dirty') : '',
      r.untracked ? tr('verify.test.untracked', { n: r.untracked, count: r.untracked }) : '',
    ].filter(Boolean);
    info.textContent = tr('verify.test.ok', { branch: r.branche || '?' })
      + (reserves.length ? ` — ${reserves.join(' · ')}` : '');
  } catch (err) { info.className = 'vr-test-info err'; info.textContent = explainError(err.message); }
});

function renderVerifierList() {
  const el = $('#verifierList');
  if (!el) return;
  if (!verifiers.length) {
    el.innerHTML = emptyState({ icon: 'check', title: tr('verify.verifiers.empty.title'), text: tr('verify.verifiers.empty.text') });
    return;
  }
  el.innerHTML = verifiers.map((v) => `<div class="card" data-id="${v.id}">
    <div class="card-main">
      <div class="title">${esc(v.name)}</div>
      <div class="meta">${v.kind === 'commands'
    ? (v.commands || []).map((c) => `<code>${esc(c)}</code>`).join(' <span class="muted">→</span> ')
    : `<code>${esc(v.command)}</code>`}</div>
      <div class="meta">${(v.repos || []).map((r) => {
    const p = (repoOptions.find((x) => x.id === r.repo_id) || {}).project || `#${r.repo_id}`;
    return `<span class="tag">${esc(p)} · ${esc(r.mode === 'in_place' ? tr('verify.mode.in-place-short') : tr('verify.mode.worktree-short'))}</span>`;
  }).join(' ')}</div>
      <div class="meta muted">${esc(v.kind === 'commands' ? tr('verify.kind.commands') : tr('verify.kind.script'))} · ${esc(tr('verify.verifier.meta', { timeout: v.timeout_s }))}${v.run_base ? ` · ${esc(tr('verify.verifier.with-base'))}` : ''}${v.comment_on_forge ? ` · ${esc(tr('verify.verifier.comments'))}` : ''}</div>
    </div>
    <div class="card-actions"><div class="btn-group">
      <button class="btn" data-vedit="${v.id}">${svgIco('edit')}${esc(tr('settings.repo.edit'))}</button>
      <button class="btn btn-danger" data-vdel="${v.id}">${svgIco('trash')}${esc(tr('ui.delete'))}</button>
    </div></div>
  </div>`).join('');
  $$('#verifierList [data-vedit]').forEach((b) => b.addEventListener('click', () => editerVerifier(Number(b.dataset.vedit))));
  $$('#verifierList [data-vdel]').forEach((b) => b.addEventListener('click', async () => {
    const v = verifiers.find((x) => x.id === Number(b.dataset.vdel));
    if (!await confirmDialog({ title: tr('verify.verifier.del.title'), text: tr('verify.verifier.del.text', { name: (v && v.name) || '' }), confirmLabel: tr('ui.delete') })) return;
    try { await busy(b, () => api(`/verifiers/${b.dataset.vdel}`, { method: 'DELETE' })); loadVerifiers(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
}

function editerVerifier(id) {
  const v = verifiers.find((x) => x.id === id);
  if (!v) return;
  const f = $('#verifierForm');
  f.id.value = v.id;
  f.name.value = v.name;
  f.kind.value = v.kind === 'script' ? 'script' : 'commands';
  f.command.value = v.command || '';
  f.report_path.value = v.report_path || '';
  f.parse_tap.checked = v.parse_tap == null ? true : !!v.parse_tap;
  let env = '';
  try { env = Object.entries(JSON.parse(v.env_json || '{}')).map(([k, val]) => `${k}=${val}`).join('\n'); }
  catch { env = ''; }
  f.env.value = env;
  f.timeout_s.value = v.timeout_s;
  f.run_base.checked = !!v.run_base;
  f.comment_on_forge.checked = !!v.comment_on_forge;
  renderCommandList(v.commands || []);
  renderVerifierRepoBox(v.repos || []);
  appliquerKind();
  $('#verifierInfo').textContent = tr('verify.verifier.editing', { name: v.name });
  ouvrirFormVerifier(true);
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#verifierForm') && $('#verifierForm').addEventListener('change', (e) => {
  if (e.target.name === 'kind') appliquerKind();
});
$('#btnAddCommand') && $('#btnAddCommand').addEventListener('click', () => {
  renderCommandList([...commandesDuFormulaire(), '']);
  const champs = $$('#verifierCommandList .vc-cmd');
  if (champs.length) champs[champs.length - 1].focus();
});
$('#verifierCommandList') && $('#verifierCommandList').addEventListener('click', (e) => {
  const lignes = $$('#verifierCommandList .vc-row');
  const bouge = e.target.closest && e.target.closest('.vc-move');
  if (bouge) {
    deplacerCommande(lignes.indexOf(bouge.closest('.vc-row')), Number(bouge.dataset.dir));
    return;
  }
  const b = e.target.closest && e.target.closest('.vc-del');
  if (!b) return;
  renderCommandList(lignes.filter((r) => r !== b.closest('.vc-row')).map((r) => $('.vc-cmd', r).value));
});

/* Le formulaire reste FERMÉ tant qu'on ne demande rien. Déployé en permanence, il occupait
   l'écran entier — champs, liste de commandes, tableau des dépôts couverts — au-dessus de la
   liste des vérificateurs, qui est pourtant ce qu'on vient consulter. Il s'ouvre sur
   « Ajouter » ou sur « Modifier », et se referme dès qu'on a fini. */
function ouvrirFormVerifier(ouvert) {
  const f = $('#verifierForm');
  if (!f) return;
  f.hidden = !ouvert;
  const b = $('#btnNewVerifier');
  // Le bouton d'ouverture disparaît pendant l'édition : deux formulaires n'ont pas de sens,
  // et « Ajouter » alors qu'on modifie un vérificateur existant se lirait comme une erreur.
  if (b) b.hidden = ouvert;
}

function viderFormVerifier() {
  const f = $('#verifierForm');
  f.reset(); f.id.value = ''; f.run_base.checked = true; f.parse_tap.checked = true;
  renderVerifierRepoBox([]);
  renderCommandList([]);
  appliquerKind();
  $('#verifierInfo').textContent = '';
}

$('#btnNewVerifier') && $('#btnNewVerifier').addEventListener('click', () => {
  viderFormVerifier();
  ouvrirFormVerifier(true);
  const f = $('#verifierForm');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  f.name.focus();
});

$('#btnVerifierCancel') && $('#btnVerifierCancel').addEventListener('click', () => {
  viderFormVerifier();
  ouvrirFormVerifier(false);
});

$('#verifierForm') && $('#verifierForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(),
    kind: verifierKind(),
    command: f.command.value.trim(),
    commands: commandesDuFormulaire(),
    report_path: f.report_path.value.trim(),
    env: f.env.value,
    parse_tap: f.parse_tap.checked ? 1 : 0,
    timeout_s: Number(f.timeout_s.value) || undefined,
    run_base: f.run_base.checked ? 1 : 0,
    comment_on_forge: f.comment_on_forge.checked ? 1 : 0,
    repos: verifierReposFromForm(),
  };
  const id = f.id.value;
  try {
    await api(id ? `/verifiers/${id}` : '/verifiers', { method: id ? 'PUT' : 'POST', body });
    toast(tr('verify.verifier.saved'));
    viderFormVerifier();
    ouvrirFormVerifier(false);
    await loadVerifiers();
  } catch (err) { toast(explainError(err.message), true); }
});

/* ---------- Badges de verdict ---------- */

/* Un badge dit trois choses en un coup d'œil : le verdict, s'il porte encore sur le code
   actuel (⟳ périmé), et s'il a été rendu dans un répertoire de travail (in place). */
const raccourci = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

function verifyBadge(v) {
  if (!v) return `<span class="tag verify none" title="${esc(tr('verify.badge.none.title'))}">${esc(tr('verify.badge.none'))}</span>`;
  const suffixe = v.in_place ? ` ${tr('verify.badge.in-place')}` : '';
  if (v.stale) {
    return `<span class="tag verify stale" data-vreport="${v.id}" title="${esc(tr('verify.badge.stale.title'))}">${svgIco('refresh')}${esc(tr('verify.badge.stale') + suffixe)}</span>`;
  }
  /* Sans nom de test, on ne prétend pas en compter : le badge nomme la COMMANDE qui a
     échoué. Annoncer « 1 test cassé » là où on ne sait rien des tests serait une invention. */
  const par = {
    verified_pass: ['ok', tr('verify.badge.pass'), tr('verify.badge.pass.title')],
    verified_fail: ['ko',
      v.detail_source === 'command'
        ? tr('verify.badge.fail-command', { command: raccourci(v.failed_label || '', 28) })
        : tr('verify.badge.fail', { n: v.failed_count }),
      tr('verify.badge.fail.title')],
    broken_base: ['warn', tr('verify.badge.broken-base'), tr('verify.badge.broken-base.title')],
    verify_error: ['warn', tr('verify.badge.error'), tr('verify.badge.error.title')],
  }[v.verdict];
  if (!par) return '';
  return `<span class="tag verify ${par[0]}" data-vreport="${v.id}" title="${esc(par[2])}">${esc(par[1] + suffixe)}</span>`;
}

/* ---------- Rapport de vérification ---------- */

let verifyReportId = null;

async function openVerifyReport(id) {
  verifyReportId = id;
  $('#verifyReport').innerHTML = `<p class="muted">${esc(tr('ui.combo.loading'))}</p>`;
  $('#verifyFix').hidden = true;
  $('#verifyModal').hidden = false;
  try {
    const d = await api(`/verifications/${id}`);
    $('#verifyReport').innerHTML = verifyReportHtml(d);
    // « Corriger » n'a de sens que si l'échec est imputable aux branches testées.
    $('#verifyFix').hidden = d.verdict !== 'verified_fail';
  } catch (e) { $('#verifyReport').innerHTML = errorBox(explainError(e.message)); }
}

/* Le déroulé réel des commandes. C'est ce qu'on veut voir en premier sur un vérificateur
   « commandes » : laquelle a cassé, en combien de temps, et ce qu'elle a écrit. */
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
      ${plusieursDepots(run) && c.repo ? `<strong>${esc(c.repo)}</strong> · ` : ''}<code>${esc(c.command)}</code> <span class="muted">${Math.max(1, Math.round((c.duration_ms || 0) / 1000))} s</span>
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
  const echec = (f) => `<li>
    <code>${esc(f.test || '')}</code>${f.message ? ` — ${esc(f.message)}` : ''}
    ${f.log_excerpt ? `<pre class="verify-log">${esc(f.log_excerpt)}</pre>` : ''}
  </li>`;
  const cible = (c) => `<li>${esc(c.project || `#${c.repo_id}`)}${c.iid ? ` !${c.iid}` : ''} · <code>${esc(c.branch || '')}</code> @ <code>${esc(String(c.head_sha || '').slice(0, 8))}</code>${c.mode === 'in_place' ? ` <span class="tag warn">${esc(tr('verify.mode.in-place-short'))}</span>` : ''}</li>`;
  const duree = d.started_at && d.finished_at
    ? tr('verify.report.duration', { s: Math.max(1, Math.round((new Date(d.finished_at) - new Date(d.started_at)) / 1000)) }) : '';
  return `
    <p>${verifyBadge({ ...d, failed_count: (d.imputable || []).length })}
       <strong>${esc(d.verifier_name || '')}</strong>
       ${d.lot_name ? `<span class="muted">· ${esc(tr('verify.report.lot', { name: d.lot_name }))}</span>` : ''}
       ${duree ? `<span class="muted">· ${esc(duree)}</span>` : ''}</p>
    ${d.restore_error ? `<p class="verify-restore">${svgIco('alert')} ${esc(d.restore_error)}</p>` : ''}
    ${d.stale ? `<p class="muted">${esc(tr('verify.report.stale'))}</p>` : ''}
    ${d.base_run ? '' : `<p class="muted">${esc(tr('verify.report.no-base'))}</p>`}
    <h4>${esc(tr('verify.report.targets'))}</h4>
    <ul class="verify-list">${(d.targets || []).map(cible).join('')}</ul>
    ${/* Le contexte : les dépôts que le vérificateur sait tester mais qui n'étaient pas dans
          le lot. Un vert peut venir de l'un d'eux resté sur une vieille branche — on le dit. */''}
    ${(d.context || []).length ? `<h4>${esc(tr('verify.report.context'))}</h4>
      <ul class="verify-list">${d.context.map((c) => `<li>${c.warn ? `${svgIco('alert')} ` : ''}${esc(c.project)} — ${esc(c.raison || `${c.branche || '?'}${c.dirty ? tr('verify.report.context-dirty') : ''}${c.untracked ? tr('verify.report.context-untracked', { n: c.untracked, count: c.untracked }) : ''}`)}</li>`).join('')}</ul>` : ''}
    ${(d.imputable || []).length ? `<h4>${esc(tr('verify.report.failed'))}</h4>
      <ul class="verify-list">${d.imputable.map(echec).join('')}</ul>` : ''}
    ${commandesHtml(d.head_run)}
    ${nouveautesHtml(d.head_run)}
    ${d.log_excerpt ? `<h4>${esc(tr('verify.report.log'))}</h4><pre class="verify-log">${esc(d.log_excerpt)}</pre>` : ''}`;
}

$('#verifyClose') && $('#verifyClose').addEventListener('click', () => { $('#verifyModal').hidden = true; });
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
});

/* ---------- Lancer une vérification ---------- */

/* On CONFIRME toujours, même quand un seul vérificateur couvre le dépôt. La modale ne sert
   pas d'abord à choisir : lancer des commandes sur sa machine mérite un écran qui annonce
   lesquelles, dans quel dépôt et sur quels commits. */
async function lancerVerification(mrIds, { lotId = null, repoIds = null } = {}) {
  /* `repoIds` : les dépôts déjà connus de l'appelant (membres d'un lot). Sans eux, on retombe
     sur les listes Reviews — vides tant que l'onglet n'a pas été chargé, et un lot lancé
     depuis « Dev IA » échouerait à tort sur « aucun vérificateur ». */
  const repos = [...new Set(repoIds && repoIds.length ? repoIds : mrIds.map((id) => mrRepoId(id)).filter(Boolean))];
  let choix = null;
  try {
    const r = await api(`/verifiers/for?repos=${repos.join(',')}`);
    if (!r.verifiers.length) { toast(tr('err.verify.no-verifier'), true); return; }
    choix = await choisirVerifier(r.verifiers, mrIds);
    if (!choix) return;
  } catch (e) { toast(explainError(e.message), true); return; }
  try {
    const body = { verifier_id: choix };
    if (lotId) await api(`/lots/${lotId}/verify`, { method: 'POST', body });
    else await api('/verify/mrs', { method: 'POST', body: { ...body, mr_ids: mrIds } });
    toast(tr('verify.toast.started'));
    refreshStatus();
  } catch (e) { toast(explainError(e.message), true); }
}

function mrRepoId(mrId) {
  const m = toReviewRows.find((x) => x.id === mrId) || reportRows.find((x) => x.id === mrId);
  return m ? m.repo_id : null;
}

let verifyPickResolve = null;
let verifyPickListe = [];

function choisirVerifier(liste, mrIds) {
  verifyPickListe = liste;
  const mrs = (mrIds || []).map((id) => toReviewRows.concat(reportRows).find((m) => m.id === id)).filter(Boolean);
  $('#verifyPickWhat').textContent = mrs.length
    ? tr('verify.pick.what', { n: mrs.length, list: mrs.map((m) => `${m.project} !${m.iid}`).join(', ') })
    : '';
  /* Radio et non bouton-qui-lance : on choisit d'abord, on voit ce que ça implique, puis on
     lance. Le détail change sous les yeux à chaque sélection. */
  $('#verifyPickList').innerHTML = liste.map((v, i) => `<label class="inline-check verify-pick-opt">
    <input type="radio" name="verifyPick" value="${v.id}" ${i === 0 ? 'checked' : ''} />
    <span>${esc(v.name)} <span class="tag">${esc(v.kind === 'commands' ? tr('verify.kind.commands') : tr('verify.kind.script'))}</span></span>
  </label>`).join('');
  majDetailChoix();
  $('#verifyPickModal').hidden = false;
  return new Promise((resolve) => { verifyPickResolve = resolve; });
}

// Ce qui va réellement tourner : les commandes ou le script, le mode, le délai.
function majDetailChoix() {
  const sel = $('#verifyPickList input:checked');
  const v = verifyPickListe.find((x) => String(x.id) === (sel && sel.value));
  const box = $('#verifyPickDetail');
  if (!box) return;
  if (!v) { box.innerHTML = ''; return; }
  const modes = (v.repos || []).map((r) => `${esc(r.project || `#${r.repo_id}`)} <span class="tag ${r.mode === 'in_place' ? 'warn' : ''}">${esc(r.mode === 'in_place' ? tr('verify.mode.in-place-short') : tr('verify.mode.worktree-short'))}</span>`).join(' · ');
  box.innerHTML = `
    ${v.kind === 'commands'
    ? `<p class="muted">${esc(tr('verify.pick.commands'))}</p><pre class="verify-log">${(v.commands || []).map((c) => `$ ${esc(c)}`).join('\n')}</pre>`
    : `<p class="muted">${esc(tr('verify.pick.script'))}</p><pre class="verify-log">${esc(v.command)}</pre>`}
    <p class="muted">${modes}</p>
    <p class="muted">${esc(v.run_base ? tr('verify.pick.with-base') : tr('verify.pick.no-base'))} · ${esc(tr('verify.verifier.meta', { timeout: v.timeout_s }))}</p>
    ${(v.repos || []).some((r) => r.mode === 'in_place') ? `<p class="converge-note">${svgIco('alert')} <span>${esc(tr('verify.pick.in-place-warn'))}</span></p>` : ''}`;
}

function fermerChoixVerifier(v) {
  $('#verifyPickModal').hidden = true;
  const r = verifyPickResolve; verifyPickResolve = null;
  if (r) r(v);
}
$('#verifyPickCancel') && $('#verifyPickCancel').addEventListener('click', () => fermerChoixVerifier(null));
$('#verifyPickList') && $('#verifyPickList').addEventListener('change', majDetailChoix);
$('#verifyPickGo') && $('#verifyPickGo').addEventListener('click', () => {
  const sel = $('#verifyPickList input:checked');
  fermerChoixVerifier(sel ? Number(sel.value) : null);
});

/* ---------- Sélection multiple dans la liste des MR ---------- */

const mrSelection = new Set();

function mrSelectionRepos() {
  const par = new Map();
  for (const id of mrSelection) {
    const r = mrRepoId(id);
    if (r) par.set(id, r);
  }
  return par;
}

function renderMrBulkBar() {
  const bar = $('#mrBulkBar');
  if (!bar) return;
  bar.hidden = mrSelection.size === 0;
  if (!mrSelection.size) return;
  $('#mrBulkCount').textContent = tr('verify.bulk.count', { n: mrSelection.size });
  /* Deux MR du même dépôt rendraient le verdict ininterprétable — on ne saurait pas quel code
     a été testé. On le dit ICI, avant le clic, plutôt que de renvoyer une erreur après. */
  const repos = [...mrSelectionRepos().values()];
  const double = repos.length !== new Set(repos).size;
  $('#mrBulkWarn').hidden = !double;
  $('#mrBulkWarn').textContent = double ? tr('err.verify.repo-twice') : '';
  $('#btnBulkVerify').disabled = double;
  $('#btnBulkLot').disabled = double;
}

$('#btnBulkClear') && $('#btnBulkClear').addEventListener('click', () => {
  mrSelection.clear();
  $$('#toReviewList .mr-pick').forEach((c) => { c.checked = false; });
  renderMrBulkBar();
});

$('#btnBulkVerify') && $('#btnBulkVerify').addEventListener('click', () => lancerVerification([...mrSelection]));

$('#btnBulkLot') && $('#btnBulkLot').addEventListener('click', async (e) => {
  const name = $('#mrBulkLotName').value.trim();
  if (!name) { toast(tr('err.lot.name-required'), true); $('#mrBulkLotName').focus(); return; }
  try {
    await busy(e.currentTarget, () => api('/lots', { method: 'POST', body: { name, members: [...mrSelection] } }));
    $('#mrBulkLotName').value = '';
    toast(tr('verify.toast.lot-created', { name }));
    loadLots();
  } catch (err) { toast(explainError(err.message), true); }
});

/* ---------- Lots (Dev IA) ---------- */

let lots = [];

async function loadLots() {
  await loadRepoOptions();
  try { lots = await api('/lots'); } catch { lots = []; }
  renderLots();
}

function renderLots() {
  const el = $('#lotList');
  if (!el) return;
  if (!lots.length) {
    el.innerHTML = emptyState({ icon: 'inbox', title: tr('verify.lots.empty.title'), text: tr('verify.lots.empty.text') });
    return;
  }
  el.innerHTML = lots.map((l) => `<div class="card" data-id="${l.id}">
    <div class="card-main">
      <div class="title">${esc(l.name)}</div>
      <div class="meta">${(l.members || []).map((m) => `<span class="tag">${esc(m.project || '')} !${esc(String(m.iid || m.ref_id))}</span>`).join(' ')}</div>
      <div class="card-tags">${verifyBadge(l.last_verification ? { ...l.last_verification, failed_count: (l.last_verification.imputable || []).length } : null)}</div>
    </div>
    <div class="card-actions"><div class="btn-group">
      <button class="btn btn-primary" data-lotverify="${l.id}">${svgIco('play')}${esc(tr('verify.btn.verify-lot'))}</button>
      <button class="btn btn-danger" data-lotdel="${l.id}">${svgIco('trash')}${esc(tr('ui.delete'))}</button>
    </div></div>
  </div>`).join('');
  $$('#lotList [data-lotverify]').forEach((b) => b.addEventListener('click', () => {
    const l = lots.find((x) => x.id === Number(b.dataset.lotverify));
    if (!l) return;
    const membres = (l.members || []).filter((m) => m.kind === 'mr');
    lancerVerification(membres.map((m) => m.ref_id), { lotId: l.id, repoIds: membres.map((m) => m.repo_id).filter(Boolean) });
  }));
  $$('#lotList [data-lotdel]').forEach((b) => b.addEventListener('click', async () => {
    const l = lots.find((x) => x.id === Number(b.dataset.lotdel));
    if (!await confirmDialog({ title: tr('verify.lot.del.title'), text: tr('verify.lot.del.text', { name: (l && l.name) || '' }), confirmLabel: tr('ui.delete') })) return;
    try { await busy(b, () => api(`/lots/${b.dataset.lotdel}`, { method: 'DELETE' })); loadLots(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
}

/* ---------- Init ---------- */
/* Restaure le dernier onglet consulté (un rechargement ne renvoie plus sur « Reviews »),
   SAUF à la première ouverture de la journée : le brief passe alors devant. Une fois par
   jour calendaire, jamais deux — sinon chaque rechargement de la page ramènerait sur le
   brief celui qui était en train de lire un rapport. Le réglage vit en base (il vaut pour
   l'outil), la date du dernier affichage en localStorage (elle vaut pour ce navigateur). */
(function restoreTab() {
  let tab = 'review';
  try { tab = localStorage.getItem('aidevtools_tab') || 'review'; } catch { /* ignore */ }
  const atterrir = () => {
    const btn = $(`nav button[data-tab="${tab}"]`);
    if (btn && tab !== 'review') { btn.click(); return; }
    // B2 : sans catch, un échec d'API laissait la liste vide (écran blanc muet).
    loadSegment().catch((e) => { $('#toReviewList').innerHTML = errorBox(`Chargement impossible : ${e.message}`); });
  };
  /* LE CLIC ARRIVE APRÈS L'ÉVALUATION DU SCRIPT. Ouvrir un onglet appelle son chargement, et
     celui-ci lit des données déclarées plus bas dans ce fichier : cliquer ici, en pleine
     évaluation, échouait avec « Cannot access X before initialization » — l'onglet restait
     vide et l'écran affichait « Erreur inattendue » au rechargement. L'autre chemin passe par
     une promesse, donc après : le défaut ne se voyait qu'un rechargement sur deux. */
  if (briefDejaVuAujourdHui()) { queueMicrotask(atterrir); return; }
  api('/config').then((c) => {
    if (c.brief_on_open === '0') { atterrir(); return; }
    marquerBriefVu();
    tab = 'notes';
    atterrir();
    /* APRÈS le clic, et pas avant : ouvrir l'onglet appelle `loadNotes()`, qui restaure le
       dernier sous-onglet consulté. On atterrirait donc sur Pages ou Todos — alors que ce
       qu'on vient chercher, une fois par jour, est précisément le brief. */
    showNotesSub('today');
  }).catch(atterrir);   // configuration illisible : on ne bloque jamais le démarrage
})();
checkSetup().then(() => { if (currentSeg === 'to_review') renderToReview(); });
refreshCounts();
refreshStatus();
rafraichirHistCount();
refreshOpenTodos();     // l'anti-doublon d'« Ajouter aux todos » a besoin de la liste
pollReminders();        // rattrapage des rappels échus pendant que l'onglet était fermé
refreshDockerBadges(); // badge santé Docker visible dès le démarrage, sans ouvrir l'onglet
amorcerBadgeJenkins();  // « combien de jobs ont tourné aujourd'hui », sans ouvrir l'onglet
// Rafraîchissement PÉRIODIQUE du badge santé Docker : on voit un container qui bascule en
// restarting/unhealthy (rouge/orange dans le titre du menu) même sans être sur l'onglet Docker.
// Léger : /docker/summary = un seul `docker ps -a` (pas d'inspect/compose config). En pause
// quand l'onglet du navigateur est masqué (rien à afficher), repris au retour.
setInterval(() => { if (!document.hidden) refreshDockerBadges(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDockerBadges(); });

// Mesure la hauteur réelle de l'en-tête → le panneau de logs sticky se cale juste en dessous.
(function stickHeader() {
  const hdr = document.querySelector('header'); if (!hdr) return;
  const set = () => document.documentElement.style.setProperty('--header-h', hdr.offsetHeight + 'px');
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(hdr);
  window.addEventListener('resize', set);
})();
setInterval(() => { if (!pollTimer) refreshStatus(); }, 5000);


/* Échap ferme la modale ouverte (avant : seules les vues plein écran réagissaient). */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#splitView').hidden) return; // gérée ailleurs
  const open = $$('.modal').filter((m) => !m.hidden).pop();
  if (!open) return;
  e.preventDefault();
  /* Certaines modales rendent une PROMESSE (choix d'un vérificateur, confirmation) : les
     masquer sans passer par leur bouton d'annulation laisse l'appelant en attente pour
     toujours — le bouton qui a ouvert la modale reste alors en chargement, indéfiniment.
     On clique donc le vrai bouton quand il existe. */
  const cancel = open.querySelector('#taskCancel, #ticketCancel, #bulkCancel, #verifyPickCancel');
  if (cancel) cancel.click(); else open.hidden = true;
});

/* ============ Onglet Jenkins : voir l'état des jobs, et les lancer ============

   RIEN N'EST SONDÉ. L'écran demande quand on l'ouvre ou quand on clique « Rafraîchir » —
   surveiller un serveur d'intégration n'est pas le travail de l'outil, et un sondage de
   fond sur une installation partagée pèse sur tout le monde. C'est aussi pourquoi le menu
   ne porte pas de pastille : elle supposerait d'interroger Jenkins à chaque ouverture de
   l'application, et un compteur figé depuis la dernière visite ment plus qu'il n'informe. */

const JENKINS = { jobs: [], configured: true, q: '', echecsSeuls: false, job: null, build: null, qDossier: '', horsDossiers: new Set(), masques: new Set(), paramFiltres: {}, paramsMasques: new Set() };

/* Les dossiers DÉCOCHÉS sont mémorisés, pas les cochés. La différence compte le jour où
   l'équipe crée un dossier : mémoriser les cochés le rendrait invisible jusqu'à ce qu'on
   pense à aller le cocher — un job neuf n'apparaîtrait jamais. */
const JENKINS_FILTRE = 'mergerie_jenkins_dossiers';
/* DEUX ÉTATS, et non un seul, parce que ce sont deux gestes différents :
   — DÉCOCHÉ : « pas maintenant ». La case reste sous la main, on la recoche d'un clic.
   — MASQUÉ : « ce dossier ne me concerne pas ». Il sort de la liste des cases, qui redevient
     lisible — sur une installation à quarante dossiers, une rangée de cases qu'on ne coche
     jamais est du bruit qu'on relit chaque matin.
   Un dossier masqué ne montre pas ses jobs non plus : le masquer en laissant ses jobs dans la
   liste donnerait des jobs qu'on ne peut plus filtrer.
   L'ancien format (un simple tableau) est relu : personne ne doit perdre son filtre. */
function chargerFiltreJenkins() {
  JENKINS.horsDossiers = new Set();
  JENKINS.masques = new Set();
  JENKINS.paramsMasques = new Set();
  try {
    const brut = JSON.parse(localStorage.getItem(JENKINS_FILTRE) || '{}');
    if (Array.isArray(brut)) { JENKINS.horsDossiers = new Set(brut.map(String)); return; }
    JENKINS.horsDossiers = new Set((brut.hors || []).map(String));
    JENKINS.masques = new Set((brut.masques || []).map(String));
    JENKINS.paramsMasques = new Set((brut.paramsMasques || []).map(String));
  } catch { /* stockage illisible : on repart d'un filtre vide */ }
}
function sauverFiltreJenkins() {
  try {
    localStorage.setItem(JENKINS_FILTRE, JSON.stringify({
      hors: [...JENKINS.horsDossiers], masques: [...JENKINS.masques],
      paramsMasques: [...JENKINS.paramsMasques],
    }));
  } catch { /* stockage indisponible */ }
}

// Les états que Jenkins exprime par une couleur, traduits côté serveur en `statut`.
const JK_ENNUI = ['echec', 'instable'];

async function loadJenkins({ silencieux = false } = {}) {
  const box = $('#jenkinsBox');
  if (!box) return;
  chargerFiltreJenkins();
  const auto = $('#jenkinsNoAuto');
  if (auto) auto.checked = jkAutoCoupe();
  // Un rafraîchissement de fond ne remplace pas la liste par un squelette : l'écran
  // clignoterait toutes les trente secondes sous les yeux de quelqu'un qui lit.
  if (!silencieux) box.innerHTML = skeleton(4);
  try {
    const d = await api('/jenkins/jobs');
    JENKINS.jobs = d.jobs || [];
    JENKINS.configured = d.configured !== false;
  } catch (e) {
    if (!silencieux) box.innerHTML = errorBox(explainError(e.message));
    return;   // en silencieux, on garde l'écran précédent : un réseau qui hoquette n'efface rien
  }
  renderJenkins();
  majBadgeJenkins();
  jkVerifierFins(JENKINS.jobs);
  jkAutoRelance();
}

/* LE BADGE DU MENU : combien de jobs ont tourné AUJOURD'HUI. La question qu'on se pose en
   passant devant l'onglet est « est-ce que ça a bougé ce matin ? », pas « combien de jobs
   existe-t-il ». On compte donc les jobs dont le dernier lancement tombe dans la journée en
   cours — heure locale, celle de la personne qui regarde.

   Un job lancé cinq fois compte pour un : la liste ne porte que le DERNIER build de chacun,
   et prétendre compter les exécutions demanderait d'interroger l'historique de chaque job à
   chaque rafraîchissement. Le titre du badge dit donc « jobs », pas « lancements ». */
function jkAujourdhui(jobs) {
  const debut = new Date(); debut.setHours(0, 0, 0, 0);
  return (jobs || []).filter((j) => j.last && j.last >= debut.getTime()).length;
}

function majBadgeJenkins() {
  const el = $('#navCountJenkins');
  if (!el) return;
  const n = jkAujourdhui(JENKINS.jobs);
  el.textContent = String(n);
  el.hidden = !n;
  el.title = tr('jenkins.nav.today', { n, count: n });
}

/* Une fois au démarrage, pour que le badge existe sans avoir ouvert l'onglet — comme celui de
   Docker. Ensuite c'est le rafraîchissement de l'onglet qui l'entretient : on ne sonde pas
   Jenkins en continu depuis les autres onglets. Silencieux : Jenkins non configuré,
   injoignable ou lent ne doit rien afficher ni rien signaler au démarrage. */
async function amorcerBadgeJenkins() {
  try {
    const d = await api('/jenkins/jobs');
    if (d.configured === false) return;
    JENKINS.jobs = d.jobs || [];
    majBadgeJenkins();
  } catch { /* pas de badge, et c'est tout */ }
}

function jkStatutLabel(j) {
  if (j.enCours) return tr('jenkins.st.running');
  return tr(`jenkins.st.${j.statut}`);
}

/* « il y a 3 h » plutôt qu'une date : sur une liste triée par date, c'est la FRAÎCHEUR qu'on
   lit, pas le jour exact. `Intl` s'en charge dans la langue courante — une table de
   traductions maison pour « minute/heure/jour » n'aurait rien apporté. */
function jkQuand(ms) {
  if (!ms) return tr('jenkins.st.jamais');
  const s = Math.round((ms - Date.now()) / 1000);
  const paliers = [['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.35], ['month', 12], ['year', Infinity]];
  let v = s;
  for (const [unite, taille] of paliers) {
    if (Math.abs(v) < taille) return new Intl.RelativeTimeFormat(I18Nrt.currentLocale(), { numeric: 'auto' }).format(Math.round(v), unite);
    v /= taille;
  }
  return '';
}

// « Qui a lancé » : un nom, ou la nature du déclencheur — jamais un blanc, qui laisserait
// croire à une information manquante alors que la réponse est « personne, c'est l'horloge ».
function jkAuteur(by) {
  if (!by) return '';
  if (by.user) return tr('jenkins.by.user', { user: by.user });
  if (by.trigger) return tr(`jenkins.by.${by.trigger}`);
  return by.label || '';
}

/* Les paramètres du dernier lancement, en clair dans la ligne. Trois au plus : au-delà, la
   ligne devient un paragraphe et on ne lit plus rien — le reste est dans l'infobulle, et la
   fiche du job les montre tous. Celui qui a DONNÉ la branche affichée n'est pas répété. */
/* LA RECHERCHE PORTE SUR CE QUE LA LIGNE MONTRE. Le chemin entier d'abord — on cherche autant
   « le job de déploiement » que « tout ce qui est dans boutique ». Mais aussi la branche,
   l'auteur et les PARAMÈTRES du dernier lancement : chercher `v1.5.0` ou `ENV=prod` et ne rien
   trouver alors que c'est écrit à l'écran est la façon la plus sûre de ne plus se servir d'un
   champ de recherche. */
function jkCherchable(j) {
  if (j._q === undefined) {
    j._q = [
      j.path, j.ref || '',
      (j.by && (j.by.user || j.by.label)) || '',
      ...(j.lastParams || []).map((p) => `${p.name}=${p.value} ${p.name} ${p.value}`),
    ].join(' ').toLowerCase();
  }
  return j._q;
}

/* TOUS les paramètres du dernier lancement, en clair dans la ligne. Un « +3 » obligeait à
   survoler ou à ouvrir la fiche pour savoir avec quoi le job était parti — exactement la
   question qu'on se pose en lisant la liste. La ligne se replie sur plusieurs lignes s'il le
   faut. Celui qui a DONNÉ la branche affichée n'est pas répété. */
function jkParams(j) {
  return (j.lastParams || []).filter((p) => String(p.value) !== String(j.ref || ''));
}

/* LES PARAMÈTRES QUI REVIENNENT PARTOUT MÉRITENT UNE COLONNE. Sur une installation d'équipe,
   les mêmes trois ou quatre paramètres (ENV, VERSION, BRANCHE) reviennent d'un job à l'autre :
   affichés dans l'ordre propre à chaque job, l'œil doit les rechercher à chaque ligne. À partir
   de TROIS jobs, un paramètre est considéré comme fréquent : il prend la même place sur toutes
   les lignes — vide comprise, sinon la colonne suivante se décale et l'alignement ne tient plus.
   Les autres, propres à un job, suivent à la fin.

   Trois plutôt que deux : à deux, une coïncidence entre deux jobs figerait une colonne pour
   tout le monde. */
const JK_PARAM_FREQUENT = 3;

/* Combien de JOBS portent chaque paramètre — pas combien de fois il apparaît : un job qui le
   passerait deux fois ne le rendrait pas plus courant. */
function jkFrequences(jobs) {
  const par = new Map();
  for (const j of jobs) {
    for (const nom of new Set((j.lastParams || []).map((p) => p.name))) {
      par.set(nom, (par.get(nom) || 0) + 1);
    }
  }
  return par;
}

/* Les paramètres qui reviennent : du plus répandu au moins répandu, puis alphabétique. Ce sont
   eux qui reçoivent une teinte et un filtre — colorer un paramètre porté par un seul job
   n'aiderait à rien et remplirait la liste de couleurs sans signification. */
function jkColonnes(jobs) {
  return [...jkFrequences(jobs)]
    .filter(([, n]) => n >= JK_PARAM_FREQUENT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([nom]) => nom);
}

/* LA COULEUR PLUTÔT QUE LA COLONNE. Aligner les paramètres en grille rendait la liste raide et
   pleine de trous ; ce qu'on cherche vraiment, c'est retrouver `ENV` d'une ligne à l'autre du
   coin de l'œil. Une teinte stable par NOM le fait sans rien déranger de la mise en page.

   La teinte vient d'un hachage du nom, pas de son rang : elle ne bouge donc pas quand un job
   apparaît ou disparaît de la liste. Deux noms peuvent tomber sur la même teinte — le nom reste
   écrit dans la pastille, la couleur aide, elle ne remplace rien. */
const JK_TEINTES = 8;
function jkTeinte(nom) {
  let h = 0;
  for (let i = 0; i < nom.length; i += 1) h = (h * 31 + nom.charCodeAt(i)) % 9973;
  return h % JK_TEINTES;
}

const jkChip = (nom, valeur, colore) => `<span class="jk-chip${colore ? ` jk-c${jkTeinte(nom)}` : ''}"><span class="jk-chip-k">${esc(nom)}</span><span class="jk-chip-v">${esc(String(valeur))}</span></span>`;

/* Sur LEUR PROPRE LIGNE, en pastilles nom/valeur. Alignés à la suite du statut, de la date et
   de l'auteur — tous en gris, tous séparés par des points médians —, ils se confondaient avec
   eux : on lisait une phrase, pas des couples. Le nom reste discret, la valeur porte la
   couleur du texte : c'est elle qu'on cherche. */
function jkParamPastilles(liste, frequents) {
  if (!liste.length) return '';
  return `<div class="jk-params">${liste.map((p) => jkChip(p.name, p.value, frequents.includes(p.name))).join('')}</div>`;
}

/* Le lien vers le job DANS Jenkins. L'URL vient de Jenkins, donc d'une source externe : on
   n'ouvre que du http(s), comme partout ailleurs dans l'application — une `javascript:` glissée
   dans un nom de job n'aurait aucune chance de s'exécuter, mais on ne compte pas là-dessus.
   `noopener` : la page ouverte ne doit pas pouvoir reprendre la main sur la nôtre. */
function jkLienExterne(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  return `<a class="btn btn-icon btn-sm jk-open-ext" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(tr('jenkins.open-ext'))}" aria-label="${esc(tr('jenkins.open-ext'))}"><svg class="ico ico-sm"><use href="#i-external"/></svg></a>`;
}

function jkRow(j, colonnes = []) {
  const ennui = JK_ENNUI.includes(j.statut);
  const params = jkParams(j);
  const infos = [
    jkStatutLabel(j),
    // Sans date, le statut dit DÉJÀ « jamais lancé » : le répéter ferait croire à deux faits.
    j.last ? fmtDateTime(new Date(j.last).toISOString()) : '',
    jkAuteur(j.by),
    j.ref ? `⎇ ${j.ref}` : '',
    (j.buildable || j.statut === 'desactive') ? '' : tr('jenkins.st.desactive'),
  ].filter(Boolean);
  return `<div class="card jk-row" data-jkjob="${esc(j.path)}">
    <span class="jk-dot ${esc(j.statut)}${j.enCours ? ' encours' : ''}" aria-hidden="true"></span>
    <div style="min-width:0;flex:1">
      <div class="jk-name">${j.folder ? `<span class="jk-path">${esc(j.folder)}/</span>` : ''}${esc(j.name)}${j.lastNumber ? ` <span class="jk-path">#${j.lastNumber}</span>` : ''}</div>
      <div class="jk-meta" title="${esc(j.last ? jkQuand(j.last) : '')}">${infos.map(esc).join(' · ')}</div>
      ${jkParamPastilles(params, colonnes)}
    </div>
    ${ennui ? `<span class="tag stale">${esc(jkStatutLabel(j))}</span>` : ''}
    ${jkLienExterne(j.url)}
    <button type="button" class="btn btn-sm" data-jkopen="${esc(j.path)}">${esc(tr('jenkins.open'))}</button>
    ${(j.buildable && j.last && (j.lastParams || []).length) ? `<button type="button" class="btn btn-sm" data-jkrerun="${esc(j.path)}" title="${esc(tr('jenkins.rerun.title-btn'))}"><svg class="ico ico-sm"><use href="#i-refresh"/></svg>${esc(tr('jenkins.rerun'))}</button>` : ''}
    ${j.buildable ? `<button type="button" class="btn btn-sm btn-primary" data-jkrun="${esc(j.path)}" title="${esc(j.params ? tr('jenkins.run.params-title', { n: j.params, count: j.params }) : tr('jenkins.run.title'))}"><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(j.params ? tr('jenkins.run.params') : tr('jenkins.run'))}</button>` : ''}
  </div>`;
}

function renderJenkins() {
  const box = $('#jenkinsBox');
  if (!JENKINS.configured) {
    box.innerHTML = emptyState({
      icon: 'sliders', title: tr('jenkins.empty.title'), text: tr('jenkins.empty.text'),
      actions: [{ act: 'jenkins-config', label: tr('jenkins.empty.btn'), primary: true }],
    });
    $('#jenkinsCount').textContent = '';
    return;
  }
  renderJenkinsDossiers();
  renderJenkinsParamFiltres();
  const q = JENKINS.q.toLowerCase();
  const vus = JENKINS.jobs.filter((j) => (!q || jkCherchable(j).includes(q))
    && !JENKINS.horsDossiers.has(j.folder) && !JENKINS.masques.has(j.folder)
    && jkPasseFiltresParam(j)
    && (!JENKINS.echecsSeuls || JK_ENNUI.includes(j.statut) || j.enCours));
  $('#jenkinsCount').textContent = tr('jenkins.count', { n: vus.length, count: vus.length, total: JENKINS.jobs.length });

  if (!JENKINS.jobs.length) {
    box.innerHTML = emptyState({ icon: 'inbox', title: tr('jenkins.none.title'), text: tr('jenkins.none.text') });
    return;
  }
  if (!vus.length) {
    box.innerHTML = `<p class="muted">${esc(tr('jenkins.no-match'))}</p>`;
    return;
  }
  /* À PLAT, dans l'ordre rendu par le serveur : du dernier lancement au plus ancien. Le
     dossier n'est plus un en-tête mais une case à cocher au-dessus — et il reste écrit
     devant chaque nom, sinon deux `api-build` de projets différents se confondent. */
  /* Calculés sur TOUS les jobs, pas sur ceux qui restent après filtrage : sinon une teinte
     changerait de sens à chaque frappe, et un filtre disparaîtrait au moment où l'on s'en sert. */
  const colonnes = jkColonnes(JENKINS.jobs);
  box.innerHTML = vus.map((j) => jkRow(j, colonnes)).join('');
}

/* FILTRER SUR LES VALEURS D'UN PARAMÈTRE FRÉQUENT. C'est la question qu'on se pose devant une
   liste de trois cents jobs : « qu'est-ce qui est parti en prod ? », « qu'est-ce qui tourne sur
   la 2.4 ? ». Un job SANS le paramètre est écarté dès qu'on filtre dessus : il ne répond pas à
   la question posée, et le garder « au cas où » viderait le filtre de son sens. */
function jkPasseFiltresParam(j) {
  const filtres = Object.entries(JENKINS.paramFiltres || {}).filter(([, v]) => v);
  if (!filtres.length) return true;
  const par = new Map((j.lastParams || []).map((p) => [p.name, String(p.value)]));
  return filtres.every(([nom, valeur]) => par.get(nom) === valeur);
}

function renderJenkinsParamFiltres() {
  const box = $('#jenkinsParamFiltres');
  if (!box) return;
  /* Un filtre MASQUÉ sort de la barre : tous les paramètres fréquents ne servent pas à
     chercher (un numéro de build, un horodatage), et une rangée de listes qu'on n'ouvre jamais
     est du bruit qu'on relit chaque matin. */
  const colonnes = jkColonnes(JENKINS.jobs).filter((n) => !JENKINS.paramsMasques.has(n));
  const caches = jkColonnes(JENKINS.jobs).filter((n) => JENKINS.paramsMasques.has(n));
  box.hidden = !colonnes.length && !caches.length;
  if (box.hidden) return;
  box.innerHTML = colonnes.map((nom) => {
    const valeurs = [...new Set(JENKINS.jobs.flatMap((j) => (j.lastParams || [])
      .filter((p) => p.name === nom).map((p) => String(p.value))))].sort((a, b) => a.localeCompare(b));
    const choisie = (JENKINS.paramFiltres || {})[nom] || '';
    return `<label class="jk-pf${choisie ? ' jk-pf-on' : ''}"><span class="jk-pf-k">${esc(nom)}</span>
      ${jkChampValeur('jkpf', nom, valeurs, choisie)}
      <button type="button" class="btn btn-icon btn-sm jk-pf-hide" data-jkpfhide="${esc(nom)}" title="${esc(tr('jenkins.param.hide'))}" aria-label="${esc(tr('jenkins.param.hide'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></label>`;
  }).join('')
    + (caches.length ? `<button type="button" class="btn btn-sm jk-pf-caches" id="jenkinsParamHidden" title="${esc(tr('jenkins.param.hidden-title'))}">${esc(tr('jenkins.param.hidden', { n: caches.length, count: caches.length }))}</button>` : '');
}

/* Le filtre par dossiers. Sa propre recherche masque des cases sans jamais en décocher :
   filtrer ce qu'on regarde ne doit pas changer ce qu'on a choisi de voir. */
function renderJenkinsDossiers() {
  const bloc = $('#jenkinsFolders');
  const liste = $('#jenkinsFolderList');
  if (!bloc || !liste) return;
  const comptes = new Map();
  for (const j of JENKINS.jobs) comptes.set(j.folder, (comptes.get(j.folder) || 0) + 1);
  const dossiers = [...comptes.keys()].sort((a, b) => a.localeCompare(b));
  // Un seul dossier (ou aucun) : le filtre n'aurait rien à filtrer.
  bloc.hidden = dossiers.length < 2;
  if (bloc.hidden) return;
  const nom = (d) => (d ? esc(d) : esc(tr('jenkins.folders.root')));
  const qd = JENKINS.qDossier.toLowerCase();
  const visibles = dossiers.filter((d) => !JENKINS.masques.has(d));
  const montres = visibles.filter((d) => !qd || (d || '').toLowerCase().includes(qd));
  liste.innerHTML = montres.map((d) => `<label><input type="checkbox" data-jkfolder="${esc(d)}"${JENKINS.horsDossiers.has(d) ? '' : ' checked'} />
    <span>${nom(d)}</span>
    <span class="jk-folder-count">${comptes.get(d)}</span>
    <button type="button" class="btn btn-icon btn-sm jk-folder-hide" data-jkhide="${esc(d)}" title="${esc(tr('jenkins.folders.hide'))}" aria-label="${esc(tr('jenkins.folders.hide'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></label>`).join('')
    || `<p class="muted">${esc(tr('jenkins.folders.no-match'))}</p>`;

  /* Ce qui est masqué se COMPTE, il ne s'étale pas. Une rangée de boutons qu'on ne clique
     presque jamais mangeait la place de ce qu'on regarde vraiment ; mais le taire ferait d'un
     filtre un mystère au bout de trois semaines. Un mot, donc, et la liste au clic. */
  const caches = dossiers.filter((d) => JENKINS.masques.has(d));
  const pied = $('#jenkinsFolderHidden');
  pied.hidden = !caches.length;
  pied.textContent = caches.length ? tr('jenkins.folders.hidden', { n: caches.length, count: caches.length }) : '';
  pied.title = tr('jenkins.folders.hidden-title');
  if (!$('#jenkinsHiddenModal').hidden) renderJenkinsMasques();
}

// La liste des masqués, dans sa modale. Un bouton par dossier : on en masque dix, on en
// récupère un seul — « tout remettre » existe aussi, pour le jour où on change d'avis en bloc.
function renderJenkinsMasques() {
  const box = $('#jenkinsHiddenList');
  if (!box) return;
  const comptes = new Map();
  for (const j of JENKINS.jobs) comptes.set(j.folder, (comptes.get(j.folder) || 0) + 1);
  const dossiers = [...JENKINS.masques].sort((a, b) => a.localeCompare(b));
  const params = [...JENKINS.paramsMasques].sort((a, b) => a.localeCompare(b));
  const ligne = (nom, compte, attr) => `<div class="jk-hidden-row">
      <span>${nom}</span>
      ${compte == null ? '' : `<span class="jk-folder-count">${compte}</span>`}
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" ${attr}>${esc(tr('jenkins.hidden.restore'))}</button>
    </div>`;
  /* Une seule modale pour les deux familles : ce qu'on a rangé se retrouve au même endroit,
     qu'il s'agisse d'un dossier ou d'un filtre. Un titre n'apparaît que s'il a du contenu. */
  const bloc = (titre, lignes) => (lignes.length ? `<h4>${esc(titre)}</h4>${lignes.join('')}` : '');
  box.innerHTML = (dossiers.length || params.length)
    ? bloc(tr('jenkins.folders'), dossiers.map((d) => ligne(d ? esc(d) : esc(tr('jenkins.folders.root')), comptes.get(d) || 0, `data-jkshow="${esc(d)}"`)))
      + bloc(tr('jenkins.params'), params.map((n) => ligne(esc(n), null, `data-jkpfshow="${esc(n)}"`)))
    : `<p class="muted">${esc(tr('jenkins.hidden.empty'))}</p>`;
  $('#jenkinsHiddenAll').hidden = !dossiers.length && !params.length;
}

/* ---------- Rafraîchissement automatique, et fin de MES lancements ----------

   TOUTES LES 30 SECONDES, et seulement quand on REGARDE : l'onglet doit être ouvert et la
   fenêtre visible. Un sondage qui continue derrière un onglet masqué ou pendant qu'on est
   ailleurs dans l'application coûte à un Jenkins partagé sans rien apprendre à personne.
   La case le débraye, et le choix est mémorisé — un réglage qu'il faut refaire à chaque
   ouverture n'est pas un réglage. */
const JENKINS_AUTO = 'mergerie_jenkins_auto';
const JENKINS_LANCES = 'mergerie_jenkins_lances';
/* La cadence vient des RÉGLAGES (Réglages → Jenkins), comme celle des MR et celle de Jira :
   c'est un réglage de l'outil, pas du navigateur, et il doit valoir d'où qu'on regarde. Elle
   arrive par /api/status, avec le reste de l'état — un changement s'applique donc sans
   recharger la page. 0 = jamais. La case « ne pas rafraîchir tout seul » reste, elle, une pause
   locale et immédiate : elle l'emporte sans toucher au réglage de fond. */
let jkPeriodeMs = 60000;
let jkTimer = null;

const jkAutoCoupe = () => { try { return localStorage.getItem(JENKINS_AUTO) === '0'; } catch { return false; } };

function jkAutoRelance() {
  if (jkTimer) { clearInterval(jkTimer); jkTimer = null; }
  const onglet = $('#tab-jenkins');
  if (!onglet || !onglet.classList.contains('active') || jkAutoCoupe() || !jkPeriodeMs) return;
  jkTimer = setInterval(() => {
    // Onglet du navigateur masqué : on ne demande rien. Il redemandera au retour.
    if (document.hidden || !$('#tab-jenkins').classList.contains('active')) return;
    loadJenkins({ silencieux: true });
  }, jkPeriodeMs);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) jkAutoRelance(); });

/* CE QUE J'AI LANCÉ, et qui tourne encore. On retient le numéro du dernier build AU MOMENT du
   lancement : le build neuf n'existe pas encore (Jenkins met en file), donc c'est son
   apparition — un numéro plus grand, terminé — qui fait la notification. Persisté : fermer
   l'onglet en attendant la fin est justement le cas d'usage. */
function jkLances() { try { return JSON.parse(localStorage.getItem(JENKINS_LANCES) || '{}'); } catch { return {}; } }
function jkPoserLance(chemin, depuis) {
  const l = jkLances();
  l[chemin] = { depuis: depuis || 0, at: Date.now() };
  try { localStorage.setItem(JENKINS_LANCES, JSON.stringify(l)); } catch { /* stockage indisponible */ }
}
function jkOublierLance(chemin) {
  const l = jkLances(); delete l[chemin];
  try { localStorage.setItem(JENKINS_LANCES, JSON.stringify(l)); } catch { /* stockage indisponible */ }
}

/* La notification de fin. Elle ne concerne QUE mes lancements : être prévenu du build nocturne
   de l'équipe serait du bruit, et on couperait tout au bout de deux jours. */
function jkVerifierFins(jobs) {
  const attendus = jkLances();
  if (!Object.keys(attendus).length) return;
  const prefs = notifPrefs();
  for (const j of jobs) {
    const a = attendus[j.path];
    if (!a) continue;
    // Le build attendu est arrivé (numéro strictement plus grand) ET il ne tourne plus.
    if (!j.lastNumber || j.lastNumber <= a.depuis || j.enCours) continue;
    jkOublierLance(j.path);
    if (prefs.jenkins_done && !prefs.muted) {
      showNotif(tr('jenkins.notif.title', { job: j.path }), tr(`jenkins.st.${j.statut}`), () => {
        navTab('jenkins'); openJenkinsJob(j.path);
      });
    }
  }
}

/* ---------- Le détail d'un job : paramètres, historique, console ---------- */

const jkPastilleBuild = (b) => (b.building ? 'succes encours'
  : b.result === 'SUCCESS' ? 'succes' : b.result === 'UNSTABLE' ? 'instable' : b.result === 'ABORTED' ? 'jamais' : 'echec');

/* Une ligne d'historique. Elle SÉLECTIONNE (le détail s'affiche à droite) et garde son bouton
   Console : c'est le geste le plus fréquent, il ne doit pas coûter une sélection de plus. */
function jkBuildLigne(chemin, b, choisi) {
  const etat = b.building ? tr('jenkins.st.running') : (b.result || '—');
  const quand = b.timestamp ? fmtDateTime(new Date(b.timestamp).toISOString()) : '';
  /* LES PARAMÈTRES SOUS LA LIGNE, ET DE LA MÊME COULEUR QUE DANS LA LISTE. C'est avec quoi
     l'exécution est partie qui distingue deux lignes autrement identiques : sans ça, retrouver
     « celle de la 1.5.2 en prod » demande de cliquer chaque ligne l'une après l'autre. La
     teinte vient du NOM (`jkTeinte`), la même partout : `ENV` a ici la couleur qu'il a dans la
     liste des jobs, et l'œil descend la colonne sans lire. Ici on colore TOUS les paramètres :
     dans l'historique d'un même job, ils reviennent tous d'une ligne à l'autre — c'est
     exactement ce que le seuil de la liste cherche à repérer. */
  const params = b.params || [];
  return `<div class="jk-build${choisi ? ' selected' : ''}">
    <div class="jk-build-l1">
      <button type="button" class="jk-build-btn" data-jkbuild="${b.number}" aria-pressed="${choisi ? 'true' : 'false'}">
        <span class="jk-dot ${jkPastilleBuild(b)}"></span>
        <strong>#${b.number}</strong>
        <span class="jk-verdict">${esc(etat)}</span>
        <span class="jk-meta">${esc(quand)}${b.duration ? ` · ${Math.round(b.duration / 1000)} s` : ''}</span>
      </button>
      <span class="jk-build-actions">
        <button type="button" class="btn btn-sm" data-jklog="${b.number}" data-jkpath="${esc(chemin)}">${esc(tr('jenkins.console'))}</button>
        <button type="button" class="btn btn-sm" data-jkreuse="${b.number}" title="${esc(tr('jenkins.reuse.title', { n: b.number }))}"><svg class="ico ico-sm"><use href="#i-copy"/></svg></button>
        <button type="button" class="btn btn-sm" data-jkrerunbuild="${b.number}" title="${esc(tr('jenkins.rerun.title-build', { n: b.number }))}"><svg class="ico ico-sm"><use href="#i-refresh"/></svg></button>
      </span>
    </div>
    ${jkParamPastilles(params, params.map((p) => p.name))}
  </div>`;
}

// Le détail de l'exécution sélectionnée : avec quoi elle est partie, et ce qu'elle a donné.
function jkBuildDetail(d, b) {
  if (!b) return `<p class="muted">${esc(tr('jenkins.build.pick'))}</p>`;
  const ligne = (k, v) => (v ? `<div class="jk-detail-row"><span class="jk-detail-k">${esc(k)}</span><span class="jk-detail-v">${esc(v)}</span></div>` : '');
  const params = (b.params || []).length
    ? (b.params || []).map((p) => ligne(p.name, String(p.value))).join('')
    : `<p class="muted">${esc(tr('jenkins.build.no-params'))}</p>`;
  return `<div class="jk-build-detail">
    <h4><span class="jk-dot ${jkPastilleBuild(b)}"></span>#${b.number} — ${esc(b.building ? tr('jenkins.st.running') : (b.result || '—'))} ${jkLienExterne(b.url)}</h4>
    ${ligne(tr('jenkins.build.when'), b.timestamp ? fmtDateTime(new Date(b.timestamp).toISOString()) : '')}
    ${ligne(tr('jenkins.build.duration'), b.duration ? `${Math.round(b.duration / 1000)} s` : '')}
    ${ligne(tr('jenkins.build.by'), jkAuteur(b.by))}
    ${ligne(tr('jenkins.build.ref'), b.ref || '')}
    <h4>${esc(tr('jenkins.params.used'))}</h4>
    ${params}
  </div>`;
}

/* La fiche : l'historique à gauche, le détail du build choisi à droite. On sélectionne le
   plus récent d'office — c'est celui dont on vient chercher les paramètres neuf fois sur dix. */
/* UNE LISTE FERMÉE MENTIRAIT. Les valeurs proposées sont celles qu'on a VUES — celles des
   derniers lancements chargés. Une valeur parfaitement valide qui n'y figure pas (un tag plus
   ancien, un environnement rarement utilisé) serait alors impossible à demander. Le champ
   suggère donc, mais laisse taper : `input` + `datalist`, et non `select`. */
let jkListeSeq = 0;
function jkChampValeur(attr, nom, valeurs, choisie) {
  jkListeSeq += 1;
  const id = `jkdl-${jkListeSeq}`;
  return `<input list="${id}" data-${attr}="${esc(nom)}" value="${esc(choisie || '')}"
      placeholder="${esc(tr('jenkins.param.all'))}" spellcheck="false" />
    <datalist id="${id}">${valeurs.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
}

/* FILTRER L'HISTORIQUE SUR LES VALEURS DES PARAMÈTRES. « Quand est-ce parti en prod pour la
   dernière fois, et avec quelle version ? » est la question qu'on se pose devant l'historique
   d'un job de déploiement — et la lire à l'œil sur dix lignes de paramètres ne marche pas.

   Le filtrage porte sur les builds DÉJÀ chargés (les dix derniers) : aucune requête de plus, et
   on le DIT plutôt que de laisser croire qu'on cherche dans tout l'historique de Jenkins. */
function jkFiltresFiche(builds) {
  const noms = [...new Set(builds.flatMap((b) => (b.params || []).map((p) => p.name)))]
    .sort((a, b) => a.localeCompare(b));
  if (!noms.length) return '';
  return `<div class="jk-param-filtres jk-fiche-filtres">${noms.map((nom) => {
    const valeurs = [...new Set(builds.flatMap((b) => (b.params || [])
      .filter((p) => p.name === nom).map((p) => String(p.value))))].sort((a, b) => a.localeCompare(b));
    const choisie = (JENKINS.ficheFiltres || {})[nom] || '';
    return `<label class="jk-pf${choisie ? ' jk-pf-on' : ''}"><span class="jk-pf-k">${esc(nom)}</span>
      ${jkChampValeur('jkff', nom, valeurs, choisie)}</label>`;
  }).join('')}</div>`;
}

const jkBuildPasse = (b) => Object.entries(JENKINS.ficheFiltres || {})
  .filter(([, v]) => v)
  .every(([nom, valeur]) => (b.params || []).some((p) => p.name === nom && String(p.value) === valeur));

function renderJenkinsFiche() {
  const d = JENKINS.job;
  if (!d) return;
  const tous = d.builds || [];
  const builds = tous.filter(jkBuildPasse);
  /* La sélection suit le filtrage : garder à droite le détail d'une exécution qu'on ne voit
     plus à gauche laisserait lire des valeurs sans savoir d'où elles viennent. */
  if (!builds.some((b) => b.number === JENKINS.build)) JENKINS.build = builds.length ? builds[0].number : null;
  const choisi = builds.find((b) => b.number === JENKINS.build) || null;
  const filtre = builds.length !== tous.length;
  /* Le titre AVANT les filtres : une zone s'annonce, puis propose ses commandes. Les deux
     forment un en-tête qui reste collé en haut pendant qu'on descend l'historique — filtrer
     après avoir déroulé dix lignes ne doit pas demander de remonter. */
  const tete = `<div class="jk-col-head">
      <h4 class="jk-bloc-t">${esc(tr('jenkins.builds'))}${filtre ? ` <span class="muted">${esc(tr('jenkins.builds.filtered', { n: builds.length, count: builds.length, total: tous.length }))}</span>` : ''}</h4>
      ${jkFiltresFiche(tous)}
    </div>`;
  const gauche = tous.length
    ? tete + (builds.length
      ? `<div class="jk-builds">${builds.map((b) => jkBuildLigne(d.path, b, b.number === JENKINS.build)).join('')}</div>`
      : `<p class="muted jk-vide">${esc(tr('jenkins.builds.none-matching'))}</p>`)
    : `<p class="muted jk-vide">${esc(tr('jenkins.no-build'))}</p>`;
  const zone = $('#jenkinsFiche');
  if (zone) {
    zone.innerHTML = `<div class="jk-fiche-col jk-bloc jk-col-histo">${gauche}</div>`
      + `<div class="jk-fiche-col jk-bloc jk-col-detail">${jkBuildDetail(d, choisi)}</div>`;
  }
}

/* REPRENDRE LES PARAMÈTRES D'UNE EXÉCUTION dans le formulaire, sans lancer. C'est le geste de
   celui qui veut repartir de ce qui a marché la dernière fois EN CHANGEANT une valeur — sinon
   « Relancer », juste à côté, suffisait. On remplit donc, et on laisse la main.

   Une valeur qui n'est plus proposée par le job (un tag supprimé depuis) est AJOUTÉE à la liste
   plutôt qu'ignorée : un pré-remplissage qui laisse le champ sur autre chose est pire que pas
   de pré-remplissage — on lancerait avec une valeur qu'on n'a pas choisie. */
/* La fiche rechargée AVEC son historique profond. On garde tout le reste tel quel — les
   paramètres saisis dans le formulaire ne doivent pas être effacés parce qu'on a filtré. */
const JK_HISTO_PROFOND = 200;
async function approfondirFiche() {
  const d = JENKINS.job;
  if (!d) return;
  try {
    const profond = await api(`/jenkins/job?path=${encodeURIComponent(d.path)}&builds=${JK_HISTO_PROFOND}`);
    JENKINS.job = { ...d, builds: profond.builds || d.builds, depth: profond.depth || JK_HISTO_PROFOND };
  } catch (e) { toast(explainError(e.message), true); }
}

function jkReprendreParams(numero) {
  const d = JENKINS.job;
  const b = d && (d.builds || []).find((x) => x.number === Number(numero));
  if (!b) return;
  let repris = 0;
  for (const p of b.params || []) {
    const champ = $(`#jenkinsModalBody [data-jkparam="${CSS.escape(p.name)}"]`);
    if (!champ) continue;
    const valeur = String(p.value);
    if (champ.type === 'checkbox') champ.checked = valeur === 'true';
    else if (champ.tagName === 'SELECT') {
      const voulues = champ.multiple ? valeur.split(',').map((x) => x.trim()) : [valeur];
      for (const v of voulues) {
        if (![...champ.options].some((o) => o.value === v)) champ.add(new Option(`${v} ${tr('jenkins.param.gone')}`, v));
      }
      [...champ.options].forEach((o) => { o.selected = voulues.includes(o.value); });
    } else champ.value = valeur;
    repris += 1;
  }
  const zone = $('#jenkinsModalBody');
  if (zone) zone.scrollTop = 0;         // le formulaire est en haut de la fiche : on y remonte
  toast(repris ? tr('jenkins.reuse.done', { n: numero }) : tr('jenkins.reuse.none'), !repris);
}

// Un paramètre, rendu selon SON type : un booléen se coche, un choix se choisit. Les
// présenter tous comme un champ texte ferait retaper des valeurs que Jenkins connaît déjà.
function jkParamChamp(p) {
  const id = `jkp-${p.name}`;
  if (p.choices && p.choices.length) {
    /* MULTIPLE quand le job l'accepte (« choose one or multiple machines ») : une liste à choix
       unique obligerait à lancer autant de fois qu'il y a de cibles. Les valeurs partent
       séparées par des virgules, la forme qu'attendent les plugins qui posent la question. */
    const choisies = new Set(String(p.value == null ? '' : p.value).split(',').map((x) => x.trim()).filter(Boolean));
    const taille = p.multiple ? ` multiple size="${Math.min(8, Math.max(3, p.choices.length))}"` : '';
    return `<select id="${esc(id)}" data-jkparam="${esc(p.name)}"${taille}>${p.choices
      .map((c) => `<option value="${esc(c)}"${choisies.has(String(c)) ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
  }
  if (/boolean/i.test(p.type)) {
    return `<label class="inline-check"><input type="checkbox" id="${esc(id)}" data-jkparam="${esc(p.name)}"${p.value === true || p.value === 'true' ? ' checked' : ''} /> <span>${esc(tr('jenkins.param.on'))}</span></label>`;
  }
  return `<input id="${esc(id)}" data-jkparam="${esc(p.name)}" value="${esc(p.value == null ? '' : String(p.value))}" />`;
}

async function openJenkinsJob(chemin) {
  const modal = $('#jenkinsModal');
  $('#jenkinsModalTitle').textContent = chemin;
  $('#jenkinsModalDesc').textContent = '';
  $('#jenkinsModalBody').innerHTML = skeleton(2);
  modal.hidden = false;
  try {
    const d = await api(`/jenkins/job?path=${encodeURIComponent(chemin)}`);
    JENKINS.job = d;
    $('#jenkinsModalDesc').textContent = d.description || '';
    const params = d.parameters.length
      ? `<section class="jk-bloc">
         <h4 class="jk-bloc-t">${esc(tr('jenkins.params'))}</h4>
         <p class="muted jk-param-intro">${esc(tr('jenkins.params.intro'))}</p>${d.parameters.map((p) => `<label class="jk-param"><span class="jk-param-name">${esc(p.name)}</span>
          ${p.description ? `<span class="jk-param-desc">${esc(p.description)}</span>` : ''}
          ${jkParamChamp(p)}
          ${p.unresolved ? `<span class="jk-param-warn">${esc(tr('jenkins.param.unresolved'))} ${jkLienExterne(d.url)}</span>` : ''}</label>`).join('')}</section>`
      : '';
    JENKINS.build = null;
    JENKINS.ficheFiltres = {};          // les filtres d'une fiche ne suivent pas d'un job à l'autre
    $('#jenkinsModalBody').innerHTML = `${params}<div class="jk-fiche" id="jenkinsFiche"></div>`;
    renderJenkinsFiche();
    $('#jenkinsRun').hidden = !d.buildable;
  } catch (e) {
    $('#jenkinsModalBody').innerHTML = errorBox(explainError(e.message));
    $('#jenkinsRun').hidden = true;
  }
}

// Les valeurs saisies, relues du formulaire au moment du lancement.
function jkParamsSaisis() {
  const out = {};
  $$('#jenkinsModalBody [data-jkparam]').forEach((el) => {
    if (el.type === 'checkbox') { out[el.dataset.jkparam] = String(el.checked); return; }
    // Choix multiple : Jenkins attend une seule valeur, les sélections séparées par des virgules.
    if (el.multiple) { out[el.dataset.jkparam] = [...el.selectedOptions].map((o) => o.value).join(','); return; }
    out[el.dataset.jkparam] = el.value;
  });
  return out;
}

/* RELANCER À L'IDENTIQUE. Le geste le plus fréquent après un échec : le même job, les mêmes
   valeurs — sans les retaper, et sans risquer d'en oublier une. La confirmation MONTRE ce qui
   va repartir : « relancer » ne veut rien dire si on ne voit pas avec quoi.

   Les paramètres secrets n'ont pas été rendus par Jenkins (on ne les affiche jamais) : ils ne
   peuvent donc pas repartir. On le DIT plutôt que de laisser partir un job amputé de son mot
   de passe sans que personne ne s'en aperçoive. */
async function relancerJenkins(chemin, params, caches) {
  const liste = params || [];
  const ok = await confirmDialog({
    title: tr('jenkins.rerun.title'),
    text: caches
      ? `${tr('jenkins.rerun.text', { job: chemin })} ${tr('jenkins.rerun.secrets', { n: caches, count: caches })}`
      : tr('jenkins.rerun.text', { job: chemin }),
    detail: liste.length ? liste.map((p) => `${p.name} = ${p.value}`).join('\n') : tr('jenkins.build.no-params'),
    confirmLabel: tr('jenkins.rerun'),
  });
  if (!ok) return false;
  try {
    const avant = (JENKINS.jobs.find((x) => x.path === chemin) || {}).lastNumber || 0;
    await api('/jenkins/build', { method: 'POST', body: {
      path: chemin, parameters: Object.fromEntries(liste.map((p) => [p.name, p.value])),
    } });
    jkPoserLance(chemin, avant);
    toast(tr('jenkins.queued', { job: chemin }));
    loadJenkins();
    return true;
  } catch (e) { toast(explainError(e.message), true); return false; }
}

/* LANCER DEMANDE CONFIRMATION. Un job Jenkins n'est pas une page qu'on ouvre : il déploie,
   il publie, il tourne sur une machine partagée. Le clic de trop n'est pas rattrapable
   depuis ici, et le nom du job dans la question est ce qui permet de s'en apercevoir. */
async function lancerJenkins(chemin, parametres) {
  if (!await confirmDialog({
    title: tr('jenkins.confirm.title'), text: tr('jenkins.confirm.text', { job: chemin }),
    confirmLabel: tr('jenkins.run'),
  })) return false;
  try {
    const avant = (JENKINS.jobs.find((x) => x.path === chemin) || {}).lastNumber || 0;
    await api('/jenkins/build', { method: 'POST', body: { path: chemin, parameters: parametres || {} } });
    jkPoserLance(chemin, avant);
    toast(tr('jenkins.queued', { job: chemin }));
    // Jenkins met en file : l'état ne change pas dans la seconde, on redemande quand même.
    loadJenkins();
    return true;
  } catch (e) { toast(explainError(e.message), true); return false; }
}

async function openJenkinsLog(chemin, numero) {
  $('#jenkinsLogTitle').textContent = `${chemin} #${numero}`;
  $('#jenkinsLogBody').textContent = '…';
  $('#jenkinsLogModal').hidden = false;
  try {
    const d = await api(`/jenkins/console?path=${encodeURIComponent(chemin)}&build=${encodeURIComponent(numero)}`);
    $('#jenkinsLogBody').textContent = (d.truncated ? `${tr('jenkins.log.truncated')}\n\n` : '') + (d.text || '');
    $('#jenkinsLogBody').scrollTop = $('#jenkinsLogBody').scrollHeight;   // l'erreur est en bas
  } catch (e) {
    $('#jenkinsLogBody').textContent = explainError(e.message);
  }
}

$('#jenkinsSearch') && $('#jenkinsSearch').addEventListener('input', (e) => { JENKINS.q = e.target.value; renderJenkins(); });
$('#jenkinsFailOnly') && $('#jenkinsFailOnly').addEventListener('change', (e) => { JENKINS.echecsSeuls = e.target.checked; renderJenkins(); });
$('#jenkinsReload') && $('#jenkinsReload').addEventListener('click', () => loadJenkins());
$('#jenkinsNoAuto') && $('#jenkinsNoAuto').addEventListener('change', (e) => {
  try { localStorage.setItem(JENKINS_AUTO, e.target.checked ? '0' : '1'); } catch { /* stockage indisponible */ }
  jkAutoRelance();
});
$('#jenkinsParamFiltres') && $('#jenkinsParamFiltres').addEventListener('click', (e) => {
  const h = e.target.closest('[data-jkpfhide]');
  if (h) {
    e.preventDefault();
    const nom = h.dataset.jkpfhide;
    JENKINS.paramsMasques.add(nom);
    /* On efface AUSSI sa valeur : un filtre invisible qui continue de filtrer est le meilleur
       moyen de chercher pendant dix minutes pourquoi la liste est vide. */
    JENKINS.paramFiltres = { ...JENKINS.paramFiltres, [nom]: '' };
    sauverFiltreJenkins();
    renderJenkins();
    return;
  }
  if (e.target.closest('#jenkinsParamHidden')) { renderJenkinsMasques(); $('#jenkinsHiddenModal').hidden = false; }
});
/* On attend un court repos avant de filtrer : à chaque frappe, le rendu remplacerait le champ
   qu'on est en train de remplir et le curseur sauterait. */
let jkFrappe = null;
const jkApresFrappe = (fn) => { clearTimeout(jkFrappe); jkFrappe = setTimeout(fn, 250); };

$('#jenkinsParamFiltres') && $('#jenkinsParamFiltres').addEventListener('input', (e) => {
  const champ = e.target.closest('[data-jkpf]');
  if (!champ) return;
  const nom = champ.dataset.jkpf;
  const valeur = champ.value.trim();
  jkApresFrappe(() => {
    JENKINS.paramFiltres = { ...JENKINS.paramFiltres, [nom]: valeur };
    renderJenkins();
    const rendu = $(`#jenkinsParamFiltres [data-jkpf="${CSS.escape(nom)}"]`);
    if (rendu) { rendu.focus(); rendu.setSelectionRange(rendu.value.length, rendu.value.length); }
  });
});
$('#jenkinsFolderSearch') && $('#jenkinsFolderSearch').addEventListener('input', (e) => { JENKINS.qDossier = e.target.value; renderJenkinsDossiers(); });
/* Masquer / remettre. Le clic sur la croix est intercepté AVANT le `change` du label : sans
   ça, cliquer la croix cocherait aussi la case qui la porte. */
$('#jenkinsFolderList') && $('#jenkinsFolderList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-jkhide]');
  if (!b) return;
  e.preventDefault();
  JENKINS.masques.add(b.dataset.jkhide);
  sauverFiltreJenkins();
  renderJenkins();
});
$('#jenkinsFolderHidden') && $('#jenkinsFolderHidden').addEventListener('click', () => {
  renderJenkinsMasques();
  $('#jenkinsHiddenModal').hidden = false;
});
$('#jenkinsHiddenList') && $('#jenkinsHiddenList').addEventListener('click', (e) => {
  const d = e.target.closest('[data-jkshow]');
  const p = e.target.closest('[data-jkpfshow]');
  if (!d && !p) return;
  if (d) JENKINS.masques.delete(d.dataset.jkshow);
  if (p) JENKINS.paramsMasques.delete(p.dataset.jkpfshow);
  sauverFiltreJenkins();
  renderJenkins();
  // Plus rien à remettre : la modale n'a plus de raison d'être ouverte.
  if (!JENKINS.masques.size && !JENKINS.paramsMasques.size) $('#jenkinsHiddenModal').hidden = true;
  else renderJenkinsMasques();
});
$('#jenkinsHiddenAll') && $('#jenkinsHiddenAll').addEventListener('click', () => {
  JENKINS.masques.clear();
  JENKINS.paramsMasques.clear();
  sauverFiltreJenkins();
  renderJenkins();
  $('#jenkinsHiddenModal').hidden = true;
});
$('#jenkinsHiddenClose') && $('#jenkinsHiddenClose').addEventListener('click', () => { $('#jenkinsHiddenModal').hidden = true; });
fermerAuFond('#jenkinsHiddenModal', () => { $('#jenkinsHiddenModal').hidden = true; }, { salissable: false });
$('#jenkinsFolderList') && $('#jenkinsFolderList').addEventListener('change', (e) => {
  const c = e.target.closest('[data-jkfolder]');
  if (!c) return;
  const d = c.dataset.jkfolder;
  if (c.checked) JENKINS.horsDossiers.delete(d); else JENKINS.horsDossiers.add(d);
  sauverFiltreJenkins();
  renderJenkins();
});
/* « Tout cocher / décocher » ne portent que sur ce qui est VISIBLE dans le filtre : sinon,
   après une recherche, le bouton toucherait des dossiers qu'on ne voit pas. */
const jkDossiersVisibles = () => $$('#jenkinsFolderList [data-jkfolder]').map((c) => c.dataset.jkfolder);
$('#jenkinsFoldersAll') && $('#jenkinsFoldersAll').addEventListener('click', () => {
  jkDossiersVisibles().forEach((d) => JENKINS.horsDossiers.delete(d));
  sauverFiltreJenkins(); renderJenkins();
});
$('#jenkinsFoldersNone') && $('#jenkinsFoldersNone').addEventListener('click', () => {
  jkDossiersVisibles().forEach((d) => JENKINS.horsDossiers.add(d));
  sauverFiltreJenkins(); renderJenkins();
});
$('#jenkinsModalBody') && $('#jenkinsModalBody').addEventListener('input', (e) => {
  const champ = e.target.closest('[data-jkff]');
  if (!champ) return;
  const nom = champ.dataset.jkff;
  const valeur = champ.value.trim();
  jkApresFrappe(async () => {
    JENKINS.ficheFiltres = { ...JENKINS.ficheFiltres, [nom]: valeur };
    /* CHERCHER PLUS LOIN QUE CE QU'ON A SOUS LES YEUX. Dix builds suffisent pour « ce qui vient
       de se passer », pas pour « quand est-ce parti en prod la dernière fois ». Dès qu'un filtre
       est posé, on redemande la fiche avec un historique profond — une seule fois par job. */
    if (valeur && JENKINS.job && (JENKINS.job.depth || 0) < JK_HISTO_PROFOND) await approfondirFiche();
    renderJenkinsFiche();
    const rendu = $(`#jenkinsModalBody [data-jkff="${CSS.escape(nom)}"]`);
    if (rendu) { rendu.focus(); rendu.setSelectionRange(rendu.value.length, rendu.value.length); }
  });
});
$('#jenkinsClose') && $('#jenkinsClose').addEventListener('click', () => { $('#jenkinsModal').hidden = true; });
$('#jenkinsLogClose') && $('#jenkinsLogClose').addEventListener('click', () => { $('#jenkinsLogModal').hidden = true; });
fermerAuFond('#jenkinsModal', () => { $('#jenkinsModal').hidden = true; }, { salissable: false });
fermerAuFond('#jenkinsLogModal', () => { $('#jenkinsLogModal').hidden = true; }, { salissable: false });
$('#jenkinsRun') && $('#jenkinsRun').addEventListener('click', async () => {
  const j = JENKINS.job;
  if (!j) return;
  // Lancé depuis la fiche : on la referme, le geste est fait et la liste redemande l'état.
  if (await lancerJenkins(j.path, jkParamsSaisis())) $('#jenkinsModal').hidden = true;
});

document.addEventListener('click', (e) => {
  const box = e.target.closest && e.target.closest('#jenkinsBox');
  if (box) {
    const run = e.target.closest('[data-jkrun]');
    if (run) {
      /* Un job PARAMÉTRÉ ne se lance pas depuis la liste : on ouvre sa fiche, où les
         paramètres se lisent. Lancer avec les valeurs par défaut sans les avoir vues est
         exactement la façon de déployer la mauvaise version. */
      const j = JENKINS.jobs.find((x) => x.path === run.dataset.jkrun);
      openJenkinsJob(run.dataset.jkrun).then(() => {
        if (JENKINS.job && !JENKINS.job.parameters.length) {
          $('#jenkinsModal').hidden = true;
          lancerJenkins(j ? j.path : run.dataset.jkrun, {});
        }
      });
      return;
    }
    const rerun = e.target.closest('[data-jkrerun]');
    if (rerun) {
      const j = JENKINS.jobs.find((x) => x.path === rerun.dataset.jkrerun);
      if (j) relancerJenkins(j.path, j.lastParams, j.lastParamsCaches);
      return;
    }
    const open = e.target.closest('[data-jkopen]') || e.target.closest('[data-jkjob]');
    if (open) { openJenkinsJob(open.dataset.jkopen || open.dataset.jkjob); return; }
  }
  const ff = e.target.closest && e.target.closest('[data-jkreuse]');
  if (ff) { jkReprendreParams(ff.dataset.jkreuse); return; }
  /* Relancer UNE exécution précise, avec SES valeurs : c'est ce qu'on veut après avoir lu la
     console d'un build raté, pas les valeurs du dernier lancement qui n'est pas celui-là. */
  const rb = e.target.closest && e.target.closest('[data-jkrerunbuild]');
  if (rb) {
    const d = JENKINS.job;
    const b = d && (d.builds || []).find((x) => x.number === Number(rb.dataset.jkrerunbuild));
    if (b) relancerJenkins(d.path, b.params, b.paramsCaches).then((parti) => { if (parti) $('#jenkinsModal').hidden = true; });
    return;
  }
  const build = e.target.closest && e.target.closest('[data-jkbuild]');
  if (build) { JENKINS.build = Number(build.dataset.jkbuild); renderJenkinsFiche(); return; }
  const log = e.target.closest && e.target.closest('[data-jklog]');
  if (log) openJenkinsLog(log.dataset.jkpath, log.dataset.jklog);
});
