'use strict';
/* Pages, conflit d'une page. */
// @expose loadPages, openNotePage, pageSave, renderPageEditor
/* ---------- Pages ---------- */

/* QUELLES COLONNES ON MONTRE : 'preview' (le rendu seul, par défaut — on relit ses notes plus
   souvent qu'on ne les écrit), 'editor' (le Markdown seul) ou 'both'. Retenu par navigateur,
   comme le thème : c'est une commodité de lecture, elle n'a rien à faire en base. */
/* Les pages générales dont on a déplié les sous-pages. En mémoire, pas en base ni dans le
   navigateur : « replié par défaut » veut dire qu'on rouvre l'outil sur une colonne propre.
   Au niveau module, parce que la liste se redessine à chaque sauvegarde automatique — un
   ensemble tenu dans le rendu se reviderait à chaque frappe. */
const sousOuvertes = new Set();

const CLE_PANES = 'aidevtools_note_panes';
let notePanesMode = (() => {
  try { const v = localStorage.getItem(CLE_PANES); return ['preview', 'editor', 'both'].includes(v) ? v : 'preview'; }
  catch { return 'preview'; }
})();

/* PLEIN ÉCRAN D'UNE PAGE : la colonne des pages n'aide pas à LIRE une page, et prend
   justement la place qui manque pour ça. Un confort de session, pas un réglage : il n'a rien
   à faire en base ni dans le navigateur, comme le pli des sous-pages. */
let notePleinEcran = false;

function appliquerPleinEcran() {
  const zone = $('.notes-layout');
  if (zone) zone.classList.toggle('note-fullscreen', notePleinEcran);
  const b = $('#pageFullscreen');
  if (!b) return;
  b.classList.toggle('active', notePleinEcran);
  b.dataset.tip = tr(notePleinEcran ? 'notes.page.fullscreen-exit-title' : 'notes.page.fullscreen-title');
  b.innerHTML = `${svgIco(notePleinEcran ? 'close' : 'expand')}<span>${esc(tr(notePleinEcran ? 'notes.page.fullscreen-exit' : 'notes.page.fullscreen'))}</span>`;
}
// ÉCHAP EN SORT, d'où qu'on parte dans la page (le titre, le Markdown) : le clavier reste
// sinon capturé par le champ actif et la touche n'atteindrait jamais ce gestionnaire global.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !notePleinEcran) return;
  notePleinEcran = false;
  appliquerPleinEcran();
});

async function loadPages() {
  const box = $('#pageList');
  if (!box) return;
  // « partagé par moi » ou par un autre : il faut savoir qui l'on est.
  await Promise.all([notesIndex(), partageActif().catch(() => null)]);
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
  /* LA COLONNE EST UN ARBRE D'UN SEUL ÉTAGE. Une sous-page listée à plat, entre deux pages
     sans rapport, perd ce qui fait sa valeur : on ne sait plus de quoi elle est le détail.
     L'ordre des parents reste celui de la liste (épinglées d'abord, puis les plus récentes) ;
     les sous-pages suivent leur parent, par titre — on y cherche un point précis, pas la
     dernière frappe. Une page ramenée seulement pour porter ses enfants trouvés par la
     recherche est grisée : c'est le rayon, pas le livre. */
  const enfantsDe = new Map();
  for (const p of NOTES.pages) {
    if (!p.parent_id) continue;
    if (!enfantsDe.has(p.parent_id)) enfantsDe.set(p.parent_id, []);
    enfantsDe.get(p.parent_id).push(p);
  }
  /* CE QUI EST DÉPLIÉ. Replié par défaut : une colonne où chaque page générale déroule ses
     huit sous-pages ne se lit plus, et on vient d'abord y chercher une page, pas un détail.
     Deux exceptions, sans quoi le pli cacherait ce qu'on demande :
       — le parent de la page OUVERTE (sinon ouvrir une sous-page par un lien la ferait
         disparaître de la colonne, active et invisible) ;
       — pendant une RECHERCHE (une sous-page trouvée qui reste pliée n'est pas trouvée). */
  const ouverte = NOTES.pages.find((x) => x.id === NOTES.pageId);
  /* Le parent de la page ouverte est déplié SANS être marqué comme tel : le marquer le
     laisserait déplié après qu'on a quitté la sous-page, et « replié par défaut » ne tiendrait
     plus dès la première visite. Le pli revient tout seul quand on s'en va. */
  const autoOuvert = (ouverte && ouverte.parent_id) || 0;
  const cherche = !!String(q || '').trim();
  const estDeplie = (id) => cherche || id === autoOuvert || sousOuvertes.has(id);

  const item = (p, sous, dernier = false) => {
    const enfants = enfantsDe.get(p.id) || [];
    const deplie = estDeplie(p.id);
    /* Le dépliant est un bouton À CÔTÉ de la page, pas dedans : un bouton dans un bouton
       n'est pas du HTML valide, et le clic n'y serait attribuable ni à l'un ni à l'autre.
       Les pages sans sous-page gardent un vide de la même largeur, pour que les titres
       restent alignés — une colonne en dents de scie se lit moins bien qu'une colonne droite. */
    const pli = enfants.length
      ? `<button type="button" class="note-fold" data-fold="${p.id}" aria-expanded="${deplie}"
          data-tip="${esc(tr(deplie ? 'notes.page.fold' : 'notes.page.unfold', { n: enfants.length, count: enfants.length }))}"
          >${svgIco(deplie ? 'down' : 'right')}</button>`
      : '<span class="note-fold-vide"></span>';
    return `<div class="note-row${sous ? ' note-sub' : ''}${sous && dernier ? ' note-sub-last' : ''}">${sous ? '' : pli}
      <button type="button" class="note-item${sous ? ' note-sub' : ''}${p.id === NOTES.pageId ? ' active' : ''}${p.contexte ? ' note-contexte' : ''}" data-page="${p.id}">
        <span class="note-item-title">${p.pinned ? `${svgIco('tag')} ` : ''}${esc(p.title || tr('notes.page.untitled'))}${p.shared ? ` <span class="note-partagee" title="${esc(tr('notes.page.shared-mark'))}">${svgIco('users')}</span>${auteurPartage(p)}` : ''}</span>
        ${enfants.length && !deplie ? `<span class="note-item-count">${esc(String(enfants.length))}</span>` : ''}
        <span class="note-item-date">${esc(fmtDate(p.updated_at))}</span>
      </button></div>`;
  };
  const out = [];
  for (const p of NOTES.pages) {
    if (p.parent_id) continue;
    out.push(item(p, false));
    if (!estDeplie(p.id)) continue;
    const enfants = (enfantsDe.get(p.id) || []).sort((x, y) => String(x.title).localeCompare(String(y.title)));
    /* Le DERNIER enfant est marqué : c'est lui qui arrête le trait vertical de
       l'arborescence. Sans cette marque, le trait descendrait au-delà du groupe et
       semblerait rattacher la page suivante, qui n'a rien à voir. */
    enfants.forEach((f, i) => out.push(item(f, true, i === enfants.length - 1)));
  }
  /* Une sous-page dont le parent n'est nulle part (parent supprimé entre deux rendus) reste
     visible : la perdre de la colonne la rendrait introuvable sans rien réparer. */
  for (const p of NOTES.pages) {
    if (p.parent_id && !NOTES.pages.some((x) => x.id === p.parent_id)) out.push(item(p, true));
  }
  box.innerHTML = out.join('');
}

$('#pageList') && $('#pageList').addEventListener('click', (e) => {
  /* Le dépliant AVANT la page : il est à côté, mais un clic qui ouvrirait aussi la page
     ferait deux choses pour un geste — et on déplie souvent pour REGARDER, sans ouvrir. */
  const f = e.target.closest('[data-fold]');
  if (f) {
    const id = Number(f.dataset.fold);
    if (sousOuvertes.has(id)) sousOuvertes.delete(id); else sousOuvertes.add(id);
    renderPageList(($('#pageSearch') && $('#pageSearch').value) || '');
    return;
  }
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
  poserAdresse(`#/notes/${id}`);   // après le chargement : la page existe, l'adresse mène quelque part
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
  /* LA VERSION QU'ON A SOUS LES YEUX part avec la frappe : si la synchro en a apporté une autre
     entre-temps, le serveur refuse au lieu d'écraser (voir le bandeau de conflit). */
  const base = surCettePage() ? NOTES.page.updated_at : att.base;
  try {
    const maj = await api(`/notes/${att.id}`, { method: 'PUT', body: { title: att.title, content: att.content, base_updated_at: base } });
    const ligne = NOTES.pages.find((x) => x.id === att.id);
    if (ligne) { ligne.title = maj.title; ligne.updated_at = maj.updated_at; }
    /* On ne remet à jour l'état affiché que si c'est TOUJOURS cette page : sinon on
       écraserait celle qu'on vient d'ouvrir avec le contenu de la précédente. */
    if (surCettePage()) NOTES.page = maj;
    dire('notes.page.saved');
    renderPageList(($('#pageSearch') && $('#pageSearch').value) || '');
  } catch (e) {
    if (e.code === 'PAGE_MODIFIEE' && e.data && e.data.page) {
      NOTES.conflit = { id: att.id, mine: { title: att.title, content: att.content }, theirs: e.data.page, author: e.data.author || null };
      dire('notes.page.save-failed', { error: e.message });
      if (surCettePage()) afficherConflitPage();
      return;
    }
    dire('notes.page.save-failed', { error: e.message });
  }
}

/* LE CONFLIT D'UNE PAGE, À L'ÉCRAN. Deux gestes, et rien ne part tant qu'on n'a pas choisi :
   prendre la version arrivée (la sienne est jetée), ou garder la sienne (elle remplace l'autre,
   en connaissance de cause). */
function afficherConflitPage() {
  const c = NOTES.conflit;
  const box = $('#pageEditor');
  if (!box) return;
  let el = $('#pageConflict');
  if (!c || !NOTES.page || NOTES.page.id !== c.id) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'pageConflict'; el.className = 'note-conflict'; box.prepend(el); }
  el.innerHTML = `<p><strong>${esc(c.author ? tr('notes.page.conflict', { who: c.author }) : tr('notes.page.conflict.anon'))}</strong>
      <span class="muted">${esc(tr('notes.page.conflict.hint'))}</span></p>
    <div class="note-conflict-acts">
      <button type="button" class="btn btn-sm" data-conflit="theirs">${esc(tr('notes.page.conflict.theirs'))}</button>
      <button type="button" class="btn btn-sm btn-primary" data-conflit="mine">${esc(tr('notes.page.conflict.mine'))}</button>
    </div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-conflit]');
  if (!b || !NOTES.conflit) return;
  const c = NOTES.conflit;
  if (pageSave && pageSave.id === c.id) { clearTimeout(pageSave.timer); pageSave = null; }
  try {
    if (b.dataset.conflit === 'theirs') {
      NOTES.page = await api(`/notes/${c.id}`);
    } else {
      // La dernière frappe l'emporte sur ce que le conflit avait figé.
      const mine = ($('#pageContent') && NOTES.page && NOTES.page.id === c.id)
        ? { title: $('#pageTitle').value, content: $('#pageContent').value } : c.mine;
      NOTES.page = await api(`/notes/${c.id}`, { method: 'PUT', body: { ...mine, base_updated_at: c.theirs.updated_at } });
    }
    NOTES.conflit = null;
    renderPageEditor();
    loadPages();
  } catch (err) { toast(explainError(err.message), true); }
});

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
  /* UNE PAGE VIDE N'A RIEN À MONTRER. Le mode par défaut est la lecture — on ouvre ses notes
     bien plus souvent qu'on ne les écrit —, mais servir un aperçu blanc à qui vient de créer
     une page est un cul-de-sac : rien à lire, et pas de champ où écrire. */
  const mode = (notePanesMode === 'preview' && !String(p.content || '').trim()) ? 'editor' : notePanesMode;
  box.innerHTML = `
    <div class="note-editor-head">
      <input id="pageTitle" type="text" class="note-title" maxlength="200" value="${esc(p.title)}" placeholder="${esc(tr('notes.page.title-ph'))}" />
      <span id="pageSaved" class="note-saved"></span>
      <span class="spacer"></span>
      <button type="button" id="pagePin" class="btn btn-sm${p.pinned ? ' active' : ''}" title="${esc(tr('notes.page.pin-title'))}">${svgIco('tag')}<span>${esc(tr(p.pinned ? 'notes.page.unpin' : 'notes.page.pin'))}</span></button>
      ${/* PAGE PAR PAGE, ET NON PAR DÉFAUT. Les notes sont le seul endroit de l'outil où l'on
            écrit sans destinataire : un brouillon, un mot de passe collé le temps d'un test, ce
            qu'on pense d'une architecture avant de savoir le dire. Une case, cochée par un
            geste conscient, et rien d'autre. Elle n'apparaît pas en mono-poste : il n'y aurait
            personne à qui partager. */''}
      <label id="pageShare" class="note-share" title="${esc(tr('notes.page.share-title'))}" hidden>
        <input type="checkbox" id="pageShareBox"${p.shared ? ' checked' : ''} />
        <span>${esc(tr('notes.page.share'))}</span>${auteurPartage(p)}
      </label>
      ${/* B6 — UNE NOTE DEVIENT UNE SESSION. La page « Bug du tunnel de paiement » est écrite
            en réunion, avec sa capture collée. Pour la faire corriger : copier le texte,
            ouvrir la modale, retrouver la capture dans Téléchargements, la ré-attacher. Or
            c'est exactement ce que « Faire coder l'IA » fait déjà depuis un ticket Jira —
            même chemin, autre source. Rien n'est lancé : on relit avant. */''}
      ${/* UNE SOUS-PAGE NE PEUT PAS EN CONTENIR : le bouton n'apparaît que sur une page
            racine, plutôt que d'être proposé puis refusé par le serveur. */''}
      ${p.parent_id ? '' : `<button type="button" id="pageNewSub" class="btn btn-sm" data-tip="${esc(tr('notes.page.new-sub-tip'))}">${svgIco('plus')}<span>${esc(tr('notes.page.new-sub'))}</span></button>`}
      <button type="button" id="pageToCode" class="btn btn-sm" title="${esc(tr('notes.page.to-code-title'))}">${svgIco('bot')}<span>${esc(tr('notes.page.to-code'))}</span></button>
      <button type="button" id="pageExport" class="btn btn-sm" title="${esc(tr('notes.page.export-title'))}">${svgIco('download')}<span>${esc(tr('notes.page.export'))}</span></button>
      ${/* L'HISTOIRE DE LA PAGE — le seul service que git rend gratuitement, et qu'il faut
            prendre. Le bouton n'apparaît que si un dépôt de données est configuré : sans lui il
            n'y a pas d'historique, et un bouton qui ouvre le vide vaut moins que rien. */''}
      <button type="button" id="pageHistory" class="btn btn-sm" title="${esc(tr('notes.page.history-title'))}" hidden>${svgIco('doc')}<span>${esc(tr('notes.page.history'))}</span></button>
      <button type="button" id="pageDelete" class="btn btn-sm btn-danger">${svgIco('trash')}<span>${esc(tr('notes.page.delete'))}</span></button>
    </div>
    ${/* LIRE ET ÉCRIRE NE SE FONT PAS EN MÊME TEMPS. Deux demi-colonnes coupaient les deux :
          un tableau de doc débordait de l'aperçu, et une ligne de Markdown revenait à la
          ligne au milieu d'un lien. Le choix est un segment à TROIS positions plutôt que deux
          cases à cocher : « tout masquer » n'est pas un état qu'on puisse vouloir, et deux
          cases le rendent atteignable en deux clics. */''}
    ${/* OÙ L'ON EST DANS L'ARBRE. Une sous-page ouverte seule ne disait pas de quoi elle
          était le détail ; une page générale ne disait pas ce qu'elle chapeautait. Les deux
          se lisent ici, et mènent d'un clic à l'autre bout du lien. */''}
    ${p.parent_id ? `<p class="muted note-parent">${esc(tr('notes.page.child-of'))}
      <button type="button" class="lien-page" data-page="${p.parent_id}">${esc(p.parent_title || tr('notes.page.untitled'))}</button></p>` : ''}
    ${(p.children || []).length ? `<p class="muted note-children">${esc(tr('notes.page.children', { n: p.children.length, count: p.children.length }))}
      ${p.children.map((c) => `<button type="button" class="lien-page" data-page="${c.id}">${esc(c.title || tr('notes.page.untitled'))}</button>`).join(' ')}</p>` : ''}
    <div class="note-panes-row">
      <div class="segmented note-panes-pick" role="tablist">
        <button type="button" data-panes="preview" class="${mode === 'preview' ? 'active' : ''}" role="tab" data-tip="${esc(tr('notes.panes.preview-tip'))}">${esc(tr('notes.panes.preview'))}</button>
        <button type="button" data-panes="both" class="${mode === 'both' ? 'active' : ''}" role="tab" data-tip="${esc(tr('notes.panes.both-tip'))}">${esc(tr('notes.panes.both'))}</button>
        <button type="button" data-panes="editor" class="${mode === 'editor' ? 'active' : ''}" role="tab" data-tip="${esc(tr('notes.panes.editor-tip'))}">${esc(tr('notes.panes.editor'))}</button>
      </div>
      <button type="button" id="pageFullscreen" class="btn btn-sm"></button>
    </div>
    <div id="pageHistoryPanel" class="note-history-panel" hidden></div>
    <div class="note-panes panes-${esc(mode)}">
      <textarea id="pageContent" class="note-content" placeholder="${esc(tr('notes.page.content-ph'))}" spellcheck="true">${esc(p.content || '')}</textarea>
      <div class="note-preview md-body" id="pagePreview">${renderNoteMd(p.content || '')}</div>
    </div>`;

  /* Le segment change les colonnes SANS re-rendre l'éditeur : un re-rendu recréerait le
     textarea, donc perdrait le curseur et la frappe non encore enregistrée. */
  for (const b of $$('.note-panes-pick [data-panes]')) {
    b.addEventListener('click', () => {
      notePanesMode = b.dataset.panes;
      try { localStorage.setItem(CLE_PANES, notePanesMode); } catch { /* stockage indisponible */ }
      $('.note-panes').className = `note-panes panes-${notePanesMode}`;
      $$('.note-panes-pick [data-panes]').forEach((x) => x.classList.toggle('active', x === b));
      if (notePanesMode !== 'preview') $('#pageContent').focus();
    });
  }

  appliquerPleinEcran();
  $('#pageFullscreen').addEventListener('click', () => {
    notePleinEcran = !notePleinEcran;
    appliquerPleinEcran();
  });

  for (const b of $$('#pageEditor .lien-page')) {
    b.addEventListener('click', () => openNotePage(Number(b.dataset.page)));
  }

  /* ---------- Partager cette page ---------- */
  (async () => {
    const zone = $('#pageShare');
    if (!zone || !await partageActif()) return;
    zone.hidden = false;
    $('#pageShareBox').addEventListener('change', async (ev) => {
      const coche = ev.target.checked;
      /* On VIDE LA SAUVEGARDE EN ATTENTE d'abord : partager une page dont les trois dernières
         phrases ne sont pas encore enregistrées enverrait à l'équipe une version tronquée. */
      await viderPageSave();
      try {
        NOTES.page = await api(`/notes/${p.id}`, { method: 'PUT', body: { shared: coche ? 1 : 0 } });
        const suivis = NOTES.page.entraine || [];
        /* CE QUI A SUIVI SE DIT. Une case qui en coche une autre en silence est une case à
           laquelle on n'a plus envie de toucher. */
        if (suivis.length) toast(tr(coche ? 'notes.page.share-parent' : 'notes.page.unshare-children', { pages: suivis.join(', '), n: suivis.length, count: suivis.length }));
        else toast(tr(coche ? 'notes.page.shared' : 'notes.page.unshared'));
        await loadPages();
        renderPageEditor();
      } catch (e) { ev.target.checked = !coche; toast(explainError(e.message), true); }
    });
  })();

  /* ---------- Historique d'une page ----------
     Une page de notes est un fichier du dépôt de données : son historique EXISTE déjà, avec son
     auteur et sa date, sans qu'on ait eu à tenir la moindre table de versions. On le montre, et
     c'est tout. Le bouton reste caché tant qu'aucun dépôt n'est configuré — il n'y aurait rien
     à montrer, et un bouton qui ouvre le vide apprend à ne plus cliquer. */
  (async () => {
    const bouton = $('#pageHistory');
    if (!bouton) return;
    let h = null;
    try { h = await api(`/notes/${p.id}/history`); } catch { return; }
    if (!h.commits || !h.commits.length) return;
    bouton.hidden = false;
    /* Un PANNEAU dans la page, et non une modale : on consulte l'historique EN ÉCRIVANT, pour
       retrouver ce qu'on avait dit avant. Une modale masquerait précisément le texte qu'on est
       en train de comparer. */
    bouton.addEventListener('click', () => {
      const panneau = $('#pageHistoryPanel');
      if (!panneau) return;
      panneau.hidden = !panneau.hidden;
      bouton.classList.toggle('active', !panneau.hidden);
      if (panneau.hidden || panneau.dataset.rendu === '1') return;
      panneau.dataset.rendu = '1';
      panneau.innerHTML = `<p class="muted">${esc(tr('notes.history.intro', { file: h.file }))}</p>
        <ul class="note-history">${h.commits.map((c) => `<li><button type="button" class="lien-commit" data-sha="${esc(c.sha)}">
          <b>${esc(c.sujet || c.sha.slice(0, 7))}</b>
          <span class="muted"> — ${esc(c.auteur)}, ${esc(new Date(c.date).toLocaleString())}</span>
        </button></li>`).join('')}</ul>
        <pre id="noteHistoryDiff" class="note-history-diff" hidden></pre>`;
      for (const b of $$('#pageHistoryPanel .lien-commit')) {
        b.addEventListener('click', async () => {
          const zone = $('#noteHistoryDiff');
          zone.hidden = false;
          zone.textContent = tr('notes.history.loading');
          try {
            const d = await api(`/notes/${p.id}/history?sha=${encodeURIComponent(b.dataset.sha)}`);
            zone.textContent = d.diff || tr('notes.history.empty');
          } catch (e) { zone.textContent = explainError(e.message); }
        });
      }
    });
  })();
  /* NOUVELLE SOUS-PAGE : créée sous la page ouverte, puis ouverte à son tour — vide, donc
     l'éditeur, parce qu'on vient d'appuyer sur « nouvelle » pour écrire. */
  $('#pageNewSub') && $('#pageNewSub').addEventListener('click', async () => {
    await viderPageSave();
    try {
      const cree = await api('/notes', { method: 'POST', body: { title: tr('notes.page.new-sub-title'), parent_id: p.id } });
      await loadPages();
      await openNotePage(cree.id);
      $('#pageTitle') && $('#pageTitle').select();
    } catch (e) { toast(explainError(e.message), true); }
  });

  const marquer = (cle, param) => { const el = $('#pageSaved'); if (el) el.textContent = cle ? tr(cle, param) : ''; };
  /* Autosauvegarde à la frappe, avec un délai : enregistrer à chaque caractère ferait une
     requête par lettre ; n'enregistrer qu'à la fermeture perdrait le travail d'une page
     restée ouverte. L'aperçu, lui, suit immédiatement — c'est du rendu local.
     Les valeurs sont FIGÉES ici : au tir, le DOM peut déjà montrer une autre page. */
  const planifier = () => {
    marquer('notes.page.saving');
    if (pageSave) clearTimeout(pageSave.timer);
    pageSave = { id: p.id, title: $('#pageTitle').value, content: $('#pageContent').value, timer: null, base: p.updated_at };
    pageSave.timer = setTimeout(viderPageSave, 1000);
  };
  $('#pageContent').addEventListener('input', () => {
    $('#pagePreview').innerHTML = renderNoteMd($('#pageContent').value);
    planifier();
  });

  /* COLLER UNE CAPTURE. L'image part sur le disque et la page ne garde qu'un lien : le
     contenu d'une page est réenregistré à chaque frappe (à une seconde près), une image en
     base64 dedans repartirait en entier à chaque fois.
     Le lien est inséré AU CURSEUR, comme un texte qu'on aurait tapé — on continue d'écrire
     sans avoir à retrouver sa place. */
  $('#pageContent').addEventListener('paste', async (e) => {
    const fichiers = [...(e.clipboardData?.items || [])]
      .filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
    if (!fichiers.length) return;
    e.preventDefault();
    const champ = $('#pageContent');
    for (const f of fichiers) {
      marquer('notes.page.image-sending');
      try {
        const { url } = await api(`/notes/${p.id}/images`, { method: 'POST', body: { image: await readFileDataURL(f) } });
        insererAuCurseur(champ, `![${tr('notes.page.image-alt')}](${url})`);
      } catch (err) { marquer(null); toast(explainError(err.message), true); return; }
    }
    $('#pagePreview').innerHTML = renderNoteMd(champ.value);
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
  /* B6 — la page devient une session de codage. On PRÉPARE, on ne lance pas : le prompt est
     la page, les pièces jointes ses captures, le dépôt le dernier utilisé. C'est le même
     chemin que depuis un ticket Jira, et il se relit avant de partir. */
  $('#pageToCode') && $('#pageToCode').addEventListener('click', () => openTaskForNote(p));
  $('#pageDelete').addEventListener('click', async () => {
    /* SUPPRIMER UNE PAGE EMPORTE SES SOUS-PAGES. Le dire AVANT : « supprimer » sur une page
       générale qui en chapeaute six n'est pas le même geste que sur une page seule. */
    const nEnfants = (p.children || []).length;
    if (!await confirmDialog({
      title: tr('notes.page.delete'),
      text: tr('notes.page.confirm-delete', { title: p.title }),
      detail: nEnfants ? tr('notes.page.confirm-delete-children', { n: nEnfants, count: nEnfants }) : '',
      confirmLabel: tr('notes.page.delete'),
    })) return;
    /* La page quitte l'éditeur tout de suite ; l'appel, lui, part six secondes plus tard. Si
       l'on annule, on la rouvre — d'où l'identifiant gardé de côté. */
    oublierPageSave(p.id);
    const idPage = p.id;
    NOTES.page = null; NOTES.pageId = null;
    await loadPages();
    renderPageEditor();
    supprimerAvecAnnulation({
      message: tr('notes.page.deleted'),
      supprimer: () => api(`/notes/${idPage}`, { method: 'DELETE' }),
      apres: loadPages,
      annuler: async () => { await loadPages(); await openNotePage(idPage); },
    });
  });
  afficherConflitPage();   // un conflit en cours survit au redessin de l'éditeur
}

$('#pageNew') && $('#pageNew').addEventListener('click', async () => {
  try {
    const p = await api('/notes', { method: 'POST', body: { title: tr('notes.page.default-title') } });
    await loadPages();
    await openNotePage(p.id);
    const t = $('#pageTitle'); if (t) { t.focus(); t.select(); }
  } catch (e) { toast(explainError(e.message), true); }
});

