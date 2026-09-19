'use strict';
/* Les liens libres : la liste, les dossiers, la modale. */
/* ---------- Les liens libres ---------- */

/* UNE LISTE, PAS DES CARTES. Quarante-cinq pixels par lien, l'URL entière en clair et deux
   icônes dont une ARCHIVE QUI N'ARCHIVE RIEN (elle range le lien dans une case et le
   supprime) : soixante liens faisaient deux écrans et demi pour soixante lignes de texte.
   Vingt-huit pixels, une lettre, le nom, l'hôte abrégé, les tags — et les actions au survol. */
const ligneFreeLink = (l) => `<div class="link-free-row" data-free="${l.id}">
      <input type="checkbox" class="lfr-pick" data-freepick="${l.id}"${LINKS.selection.has(l.id) ? ' checked' : ''} aria-label="${esc(tr('links.free.pick'))}" />
      <span class="link-ava la-c${jkTeinte(l.label || l.url)}" aria-hidden="true">${esc(initiale(l.label))}</span>
      <a class="link-free-label" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer"
         data-usekind="free_link" data-useref="${l.id}" title="${esc(l.url)}">${esc(l.label)}</a>
      <span class="link-free-url muted">${esc(urlCourte(l.url))}</span>
      <span class="link-free-tags">${(l.tags || []).map((t) => `<span class="link-svc-tag">${esc(t)}</span>`).join('')}</span>
      <span class="link-free-acts">
        <button type="button" class="link-icon" data-copy-txt="${esc(l.url)}" title="${esc(tr('links.copy-url', { url: l.url }))}" aria-label="${esc(tr('links.copy-url', { url: l.url }))}">${svgIco('copy')}</button>
        <button type="button" class="link-icon" data-filefree="${l.id}" title="${esc(tr('links.free.file-title'))}" aria-label="${esc(tr('links.free.file-title'))}">${svgIco('grid')}</button>
        <button type="button" class="link-icon" data-editfree="${l.id}" title="${esc(tr('ui.edit'))}" aria-label="${esc(tr('ui.edit'))}">${svgIco('edit')}</button>
        <button type="button" class="link-icon" data-delfree="${l.id}" title="${esc(tr('ui.delete'))}" aria-label="${esc(tr('ui.delete'))}">${svgIco('trash')}</button>
      </span>
    </div>`;

/* GROUPÉS PAR DOSSIER DÈS QU'UN DOSSIER EXISTE. Le seuil de douze laissait les trois premiers
   dossiers importés à plat, c'est-à-dire au moment précis où l'on cherchait à reconnaître son
   propre rangement. Sous une recherche ou un tag, on reste à plat : le filtre EST le
   rangement, et deux niveaux de tri à la fois cachent ce qu'on vient de demander. */
function renderFreeLinks() {
  const box = $('#linkFreeList');
  if (!box) return;
  const tous = ((LINKS.grid && LINKS.grid.free_links) || []).filter(freeVisible);
  const filtre = LINKS.q || LINKS.tag;
  /* CE QU'ON VOIT EST CE SUR QUOI ON AGIT. Un lien coché puis filtré hors de vue partirait
     avec les autres au moment de ranger, sans que rien ne l'ait annoncé. */
  const vus = new Set(tous.map((l) => l.id));
  for (const id of [...LINKS.selection]) if (!vus.has(id)) LINKS.selection.delete(id);
  const btn = $('#linkToService');
  if (btn) {
    btn.hidden = LINKS.selection.size < 1;
    // Le compte SUR le bouton, et il SUIT LES COCHES : il ne bougeait qu'au rendu suivant.
    $('span', btn).textContent = LINKS.selection.size
      ? tr('links.free.file-n', { n: LINKS.selection.size, count: LINKS.selection.size })
      : tr('links.free.file');
  }
  const groupable = !filtre && tous.some((l) => l.folder);
  for (const [sel, actif] of [['#linkFreeExpand', LINKS.freeDeplie === true], ['#linkFreeFold', LINKS.freeDeplie === false]]) {
    const b2 = $(sel);
    if (!b2) continue;
    b2.hidden = !groupable;
    b2.classList.toggle('active', actif);
    b2.setAttribute('aria-pressed', String(actif));
  }
  const tout = $('#linkFreeAll');
  if (tout) {
    // « Tout sélectionner » n'a de sens qu'en train de sélectionner : sinon il occupe la barre.
    tout.hidden = !tous.length || !(LINKS.selectMode || LINKS.selection.size);
    const complet = tous.length > 0 && tous.every((l) => LINKS.selection.has(l.id));
    $('span', tout).textContent = tr(complet ? 'links.select.none' : 'links.select.all');
    tout.dataset.complet = complet ? '1' : '';
  }
  const sel = $('#linkMoreMenu [data-more="select"]');
  if (sel) {
    sel.hidden = !((LINKS.grid && LINKS.grid.free_links) || []).length;
    $('span', sel).textContent = tr(LINKS.selectMode ? 'links.select.done' : 'links.select');
  }
  box.classList.toggle('mode-select', LINKS.selectMode || LINKS.selection.size > 0);
  // Le compte se lit à côté du titre : il dit ce que le filtre a laissé, sans compter à la main.
  const cpt = $('#linkFreeCount');
  if (cpt) cpt.textContent = tous.length ? tr('links.free.count', { n: tous.length, count: tous.length }) : '';
  const wipe = $('#linkMoreMenu [data-more="wipe"]');
  if (wipe) wipe.hidden = !((LINKS.grid && LINKS.grid.free_links) || []).length;
  const bar = $('.link-free-bar');
  /* La section entière disparaît quand il n'y a rien : sur une base neuve, un titre et une
     phrase d'explication sous un écran déjà vide font deux vides pour un. */
  if (bar) bar.hidden = !((LINKS.grid && LINKS.grid.free_links) || []).length;
  if (!((LINKS.grid && LINKS.grid.free_links) || []).length) { box.innerHTML = ''; return; }
  if (!tous.length) {
    box.innerHTML = `<p class="muted">${esc(tr('links.free.no-match'))}</p>`;
    return;
  }
  box.innerHTML = groupable ? arbreFreeLinks(tous) : tous.map(ligneFreeLink).join('');
}

/* L'ARBRE RÉEL, et non un groupement sur le dernier segment du chemin. Grouper par la feuille
   faisait fusionner `seres/prod` et `logs/prod` dans un même « prod » : l'outil détruisait une
   structure que le navigateur, lui, préserve. */
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
     dossiers pour retrouver un lien. */
  const ouvert = (profondeur) => (LINKS.freeDeplie === null ? profondeur === 0 : LINKS.freeDeplie);
  const rendre = (n, nom, profondeur = 0) => {
    const dedans = [...n.enfants.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, e]) => rendre(e, k, profondeur + 1)).join('') + n.liens.map(ligneFreeLink).join('');
    if (nom === null) return dedans;                 // la racine n'est pas un dossier
    const t = compter(n);
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

/* Le nom d'un service, tel que son hôte le dit : on retire le protocole, le `www.`, le port
   et le chemin, puis on garde le premier segment — `https://grafana.interne.example/d/abc`
   donne « grafana ». Une adresse IP ou un `localhost:3000` ne donnent rien d'utile : on
   préfère alors ne rien proposer plutôt que d'écrire « 127 ». */
function libelleDepuisUrl(brut) {
  const v = String(brut || '').trim();
  if (!v) return '';
  let hote = '';
  try { hote = new URL(v.includes('://') ? v : `https://${v}`).hostname; } catch { return ''; }
  if (!hote || /^\d{1,3}(\.\d{1,3}){3}$/.test(hote)) return '';
  const seg = hote.replace(/^www\./i, '').split('.')[0];
  if (!seg || seg === 'localhost' || /^\d+$/.test(seg)) return '';
  return seg;
}

/* Le nom PROPOSÉ pour une adresse collée dans une case : le dernier segment du chemin, qui est
   ce qui la distingue de ses voisines (`/app/logs?q=checkout` → « logs »). Laissé vide quand
   il n'y a pas de chemin : le serveur sait alors quoi afficher (`nomDepuisUrl`), et une
   proposition inventée vaut moins que sa règle. */
function nomProposeAdresse(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    return segs.length ? decodeURIComponent(segs[segs.length - 1]).slice(0, 100) : '';
  } catch { return ''; }
}

/* Chaque ouverture nourrit la frécence de la palette : ce qu'on clique ici remonte là-bas.
   Par délégation et en `capture: false` — le lien s'ouvre normalement, on ne l'intercepte pas. */
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('[data-usekind]');
  if (!a) return;
  api('/launcher/used', { method: 'POST', body: { kind: a.dataset.usekind, ref: a.dataset.useref } })
    .catch(() => { /* la frécence n'est pas une donnée critique */ });
});

const rafraichirLiens = () => { renderLinkBarre(); renderLinkGrid(); renderFreeLinks(); };

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
  /* Le curseur se pose sur l'ADRESSE, premier champ du formulaire : c'est ce qu'on vient
     coller. Sauf en modification, où l'on vient presque toujours corriger le nom. */
  setTimeout(() => $(freeEnCours ? '#freeLabel' : '#freeUrl').focus(), 0);
  /* A/Liens 1 — LE LIBELLÉ SE PROPOSE DEPUIS L'HÔTE. On colle une URL, on remonte au champ
     précédent, on retape « grafana ». L'hôte le dit déjà : `grafana.interne.example` →
     « grafana ». Jamais par-dessus ce que l'utilisateur a écrit lui-même — écraser sa saisie
     serait pire que ne rien proposer. */
  const champUrl = $('#freeUrl');
  const champLbl = $('#freeLabel');
  /* Les deux drapeaux valent pour LA SAISIE EN COURS, pas pour la session : `touche` dit que
     l'utilisateur a écrit dans le libellé, `auto` que ce qui s'y trouve vient de nous. `touche`
     n'était jamais remis — il suffisait d'avoir tapé un libellé une fois pour que la
     proposition soit morte jusqu'au rechargement de la page, et pour tous les liens suivants. */
  if (champLbl) { delete champLbl.dataset.touche; delete champLbl.dataset.auto; }
  if (champUrl && champLbl && !champUrl.dataset.autoLabel) {
    champUrl.dataset.autoLabel = '1';
    champLbl.addEventListener('input', () => { champLbl.dataset.touche = '1'; });
    /* LA PROPOSITION SE MET À JOUR TANT QU'ELLE EST À NOUS. Elle ne se posait qu'une fois, sur
       un libellé vide : à la frappe, le premier caractère de l'adresse — « h » de « https » —
       faisait un hôte valide, donc un libellé « h », qui bloquait tout le reste (le champ
       n'était plus vide). Collé d'un coup, cela marchait ; tapé, on repartait avec « h ».
       On retient donc ce qu'on a proposé : tant que l'utilisateur n'a pas écrit LUI-MÊME dans
       le champ, la proposition suit l'adresse ; dès qu'il y touche, on ne la touche plus. */
    champUrl.addEventListener('input', () => {
      if (champLbl.dataset.touche) return;
      if (champLbl.value.trim() && champLbl.dataset.auto !== '1') return;
      const propose = libelleDepuisUrl(champUrl.value);
      champLbl.value = propose;
      if (propose) champLbl.dataset.auto = '1'; else delete champLbl.dataset.auto;
    });
  }
}
/* ENTRÉE VAUT « ENREGISTRER » dans une modale de trois champs. C'est déjà le geste de la
   capture rapide d'une todo, de la surveillance d'un ticket Jira et de l'éditeur d'une case de
   la grille : viser un bouton après avoir collé une adresse fait deux gestes là où il en faut
   un. Champ par champ, jamais sur la modale entière — un `Enter` sur un sélecteur à recherche
   choisit une option, et sur une zone de texte il va à la ligne. */
function entreeEnregistre(champs, bouton) {
  for (const sel of champs) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const b = $(bouton);
      if (b && !b.disabled) b.click();
    });
  }
}
/* `#freeFolder` en est exclu : il porte une liste de dossiers connus, et Entrée y sert d'abord
   à valider la suggestion en cours — enregistrer dans la foulée poserait le lien dans un
   dossier à moitié choisi. */
entreeEnregistre(['#freeUrl', '#freeLabel', '#freeTags'], '#freeSave');
entreeEnregistre(['#envName'], '#envSave');
entreeEnregistre(['#serviceName', '#serviceTags'], '#serviceSave');
entreeEnregistre(['#ctxLabel', '#ctxTemplate'], '#ctxAdd');
/* Les adresses par environnement sont refaites à chaque ouverture de la modale : on écoute le
   conteneur, qui lui ne bouge pas. */
$('#serviceUrlsList') && $('#serviceUrlsList').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('input')) return;
  e.preventDefault();
  $('#serviceSave').click();
});

$('#freeCancel') && $('#freeCancel').addEventListener('click', () => { $('#freeLinkModal').hidden = true; });
fermerAuFond('#freeLinkModal', () => { $('#freeLinkModal').hidden = true; }, { salissable: true });
$('#freeSave') && $('#freeSave').addEventListener('click', async () => {
  /* La modale n'est pas un <form> : `required` y est un marquage, pas une garde. Les deux
     champs sans lesquels le lien n'existe pas se signalent donc SOUS le champ. */
  viderErreursChamps($('#freeLinkModal'));
  // Dans l'ORDRE DES CHAMPS : un refus qui saute au second champ se lit comme un refus du premier.
  if (!$('#freeUrl').value.trim()) return void signalerChamp($('#freeUrl'), tr('err.lien-sans-url'));
  if (!$('#freeLabel').value.trim()) return void signalerChamp($('#freeLabel'), tr('err.lien-sans-libelle'));
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


