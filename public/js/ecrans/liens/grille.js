'use strict';
/* La grille services × environnements. */
/* ---------- La grille ---------- */

/* TROIS ADRESSES PAR CASE, TOUJOURS. Le dépliage en place faisait des lignes de sept cents
   pixels : le nom du service et les cases voisines flottaient au milieu d'un vide, la section
   des liens libres partait sous l'écran, et le seul retour était un « Réduire » de onze pixels
   au bas de la pile. La hauteur d'une ligne de grille ne dépend plus de son contenu. */
const MAX_CASE = 3;

/* CE QU'ON LIT DANS LA CASE. `display` vient du serveur (`nomDepuisUrl`), qui connaît le nom de
   la colonne et celui de la ligne : `api-preprod.demo.invalid/health` s'y écrit « health ».
   L'URL entière reste dans la bulle et dans la copie. */
const nomAdresse = (u) => u.label || u.display || urlCourte(u.url);

/* LES TROIS PLUS OUVERTES, et non les trois premières. La frécence est comptée par adresse
   depuis toujours et ne servait qu'à la palette : sur un Kibana à cinquante filtres
   enregistrés, on en ouvre trois. L'ordre POSÉ est conservé entre elles — la case ne se
   réarrange pas sous les doigts à chaque ouverture. */
function troisPlusOuvertes(liste) {
  const rangs = new Map(liste.map((u, i) => [u, i]));
  return [...liste].sort((a, b) => ((b.uses || 0) - (a.uses || 0)) || (rangs.get(a) - rangs.get(b)))
    .slice(0, MAX_CASE)
    .sort((a, b) => rangs.get(a) - rangs.get(b));
}

/* Un gabarit RÉSOLU SUR UN EXEMPLE. « 1 lien contextuel » ne disait ni lequel ni où il mène ;
   il fallait ouvrir la fiche du service pour l'apprendre, et le chip avait le style d'un tag
   sans en être un. */
function bulleGabarits(s) {
  const env = (envsVisibles()[0] || (((LINKS.grid || {}).environments) || [])[0] || {}).name || 'dev';
  const ex = { env, branch: 'feat/x', mr_iid: '42', service: s.name };
  return (s.context_templates || []).map((c) => `${c.label} — ${String(c.url_template)
    .replace(/\{([a-z_]+)\}/gi, (m, n) => (ex[n] == null ? m : encodeURIComponent(ex[n])))}`).join('\n');
}

const initiale = (nom) => (String(nom || '').trim()[0] || '?').toUpperCase();

function renderLinkGrid() {
  const box = $('#linkGrid');
  if (!box) return;
  const { environments: toutesEnvs = [], services = [] } = LINKS.grid || {};
  const envs = envsVisibles();
  if (!toutesEnvs.length && !services.length) { box.innerHTML = etatVideLiens(); return; }
  const visibles = services.filter(serviceVisible);

  /* L'en-tête porte le nom (qui ouvre les réglages), l'ouverture de toute la colonne et les
     flèches — celles-ci ne servent plus qu'au clavier, la souris glisse la colonne. */
  const rang = (id) => toutesEnvs.findIndex((x) => x.id === id);
  const entete = envs.map((e) => `<th class="link-col" data-envcol="${e.id}" draggable="true" style="--envc:${esc(e.color)}"><span class="link-env">`
    + `<span class="link-env-dot" style="background:${esc(e.color)}"></span>`
    + `<button type="button" class="link-env-name" data-envedit="${e.id}" title="${esc(tr('links.env.settings'))}">${esc(e.name)}</button>`
    + `<span class="link-env-acts">`
    + `<button type="button" class="link-icon" data-envopen="${e.id}" title="${esc(tr('links.env.open-all'))}" aria-label="${esc(tr('links.env.open-all'))}">${svgIco('external')}</button>`
    + `<button type="button" class="link-icon" data-envmove="${e.id}" data-dir="-1"${rang(e.id) === 0 ? ' disabled' : ''} title="${esc(tr('links.env.move-left'))}" aria-label="${esc(tr('links.env.move-left'))}">${svgIco('left')}</button>`
    + `<button type="button" class="link-icon" data-envmove="${e.id}" data-dir="1"${rang(e.id) === toutesEnvs.length - 1 ? ' disabled' : ''} title="${esc(tr('links.env.move-right'))}" aria-label="${esc(tr('links.env.move-right'))}">${svgIco('right')}</button>`
    + `</span></span></th>`).join('');

  let vuNonEpingle = false;
  const lignes = visibles.map((s) => {
    /* UN TRAIT sépare les épinglés du reste. L'épingle était rendue avec une icône ÉTIQUETTE,
       et rien ne disait où s'arrêtait la tête de liste. */
    const premierLibre = !s.pinned && !vuNonEpingle && visibles.some((x) => x.pinned);
    if (!s.pinned) vuNonEpingle = true;
    const cases = envs.map((e) => caseHtml(s, e)).join('');
    const gab = (s.context_templates || []).length;
    return `<tr class="link-grid-row${s.pinned ? ' epingle' : ''}${premierLibre ? ' apres-epingles' : ''}" data-service="${s.id}" data-pinned="${s.pinned ? 1 : 0}">
      <td class="link-svc"><span class="link-svc-in">
        <span class="link-move" draggable="true" title="${esc(tr('links.service.move'))}" aria-hidden="true">${svgIco('grip')}</span>
        <span class="link-ava la-c${jkTeinte(s.name)}" aria-hidden="true">${esc(initiale(s.name))}</span>
        <span class="link-svc-txt">
          <button type="button" class="link-svc-btn" data-editservice="${s.id}" title="${esc(tr('links.service.edit'))}">${esc(s.name)}</button>
          ${s.project ? `<span class="link-svc-repo" title="${esc(tr('links.service.repo'))}">${esc(s.project)}</span>` : ''}
          ${/* Les tags en TEXTE, pas en pastilles : dans une colonne de 340 px, une pastille
                coupée en deux (« pro ») ne dit plus rien, là où « backend · prod… » se devine. */''}
          ${(s.tags || []).length ? `<span class="link-svc-tags" title="${esc((s.tags || []).join(' · '))}">${esc((s.tags || []).join(' · '))}</span>` : ''}
        </span>
        ${gab ? `<button type="button" class="link-icon link-zap" data-ctxopen="${s.id}" title="${esc(bulleGabarits(s))}"
            aria-label="${esc(tr('links.ctx.count', { n: gab, count: gab }))}">${svgIco('zap')}</button>` : ''}
        <button type="button" class="link-icon link-pin${s.pinned ? ' on' : ''}" data-pin="${s.id}"
          title="${esc(tr(s.pinned ? 'links.service.unpin' : 'links.service.pin'))}" aria-pressed="${s.pinned ? 'true' : 'false'}">${svgIco('pin')}</button>
      </span></td>${cases}</tr>`;
  }).join('');

  /* LE TABLEAU EXISTE DÈS QU'IL Y A UNE COLONNE, même sans une seule ligne : les réglages d'un
     environnement vivent dans son en-tête, et un environnement créé avant tout service serait
     sinon impossible à renommer ou à supprimer. */
  const vide = !visibles.length ? `<tr class="link-grid-empty"><td colspan="${envs.length + 1}">${esc(tr(
    services.length
      ? (((LINKS.grid || {}).free_links || []).some(freeVisible) ? 'links.grid.no-match' : 'links.no-match-all')
      : 'links.grid.no-service',
  ))}</td></tr>` : '';
  box.innerHTML = `<table class="link-grid"><thead><tr><th class="link-svc"></th>${entete}</tr></thead><tbody>${lignes}${vide}</tbody></table>`;
}

function caseHtml(s, e) {
  const cle = `${s.id}:${e.id}`;
  const liste = ((s.urls || {})[e.id]) || [];
  const attrs = `data-cell="${cle}" tabindex="-1" style="--envc:${esc(e.color)}"`;
  /* CASE VIDE : RIEN AU REPOS. Le `+` en pointillé pleine largeur dominait visuellement les
     adresses sur une grille où la moitié des cases sont légitimement vides — il n'y a pas de
     Kibana en local. Il revient au survol de la ligne, là où l'on visait déjà. */
  if (!liste.length) {
    return `<td class="link-cell vide" ${attrs}><button type="button" class="link-add" data-addurl="${s.id}" data-env="${e.id}"
      title="${esc(tr('links.url.add'))}" aria-label="${esc(tr('links.url.add'))}">+</button></td>`;
  }
  /* SOUS UNE RECHERCHE, LA CASE NE MONTRE QUE CE QUI CORRESPOND : afficher les huit adresses
     d'une case pour une seule trouvée oblige à relire la case au lieu de lire la réponse. */
  const retenues = LINKS.q ? liste.filter((u) => adresseTrouvee(s, u)) : liste;
  if (!retenues.length) return `<td class="link-cell" ${attrs}></td>`;
  const montrees = troisPlusOuvertes(retenues);
  const bulle = (u) => [u.label || '', u.url, u.last_used_at ? tr('links.last-open', { when: depuis(u.last_used_at) }) : '']
    .filter(Boolean).join('\n');
  const ligne = (u) => `<span class="link-line"><a class="link-open" href="${esc(safeUrl(u.url))}" target="_blank" rel="noopener noreferrer"
      data-usekind="service_url" data-useref="${s.id}:${e.id}:${u.id}" data-tip="${esc(bulle(u))}">
      <span>${esc(nomAdresse(u))}</span></a><button type="button" class="link-copy" data-copy-txt="${esc(u.url)}"
      title="${esc(tr('links.copy-url', { url: u.url }))}" aria-label="${esc(tr('links.copy-url', { url: u.url }))}">${svgIco('copy')}</button></span>`;
  /* `▸ N adresses` REMPLACE le « +N » de onze pixels et le dépliage en place. Le clic ouvre la
     liste dans un panneau ancré : la grille ne bouge pas, et cinquante adresses se tamisent au
     clavier au lieu de s'empiler sous la ligne.
     SOUS UNE RECHERCHE, il compte ce qui CORRESPOND : annoncer « 6 adresses » à côté de la
     seule trouvée renverrait à la case entière au lieu de la réponse. */
  const total = LINKS.q ? retenues.length : liste.length;
  const plus = total > montrees.length
    ? `<button type="button" class="link-more-addr" data-cellpanel="${cle}">▸ ${esc(tr('links.url.count', { n: total, count: total }))}</button>`
    : '';
  /* UNE CASE À UNE SEULE ADRESSE EST CLIQUABLE EN ENTIER. Viser un chip de 120 px au milieu
     d'une case de 190 px est une visée pour rien : l'adresse EST la case. */
  const une = retenues.length === 1 && !plus ? ' une' : '';
  return `<td class="link-cell${une}" ${attrs}>${montrees.map(ligne).join('')}${plus}
    <button type="button" class="link-icon link-edit" data-editurl="${s.id}" data-env="${e.id}"
      title="${esc(tr('links.url.edit'))}" aria-label="${esc(tr('links.url.edit'))}">${svgIco('edit')}</button></td>`;
}

/* L'ÉTAT VIDE NE PARLE PLUS DE VOCABULAIRE. Il disait : crée un environnement, puis des
   services — trois écrans avant la première adresse, et deux mots qu'on n'a pas encore
   rencontrés. Un champ, une adresse, et le rangement se propose. */
function etatVideLiens() {
  /* DEUX VIDES, ET DEUX MESSAGES. Sans cette distinction, importer ses marque-pages laissait
     l'écran répondre « aucun lien pour l'instant » AU-DESSUS des liens qu'on venait d'importer,
     en proposant de les importer une seconde fois. */
  const desLiens = (((LINKS.grid || {}).free_links) || []).length > 0;
  return `<div class="empty link-empty">
    <svg class="ico"><use href="#i-link"/></svg>
    <div class="empty-t">${esc(tr(desLiens ? 'links.grid.empty.title' : 'links.empty.title2'))}</div>
    <div class="link-empty-form">
      <input id="linkEmptyUrl" type="url" placeholder="https://…" aria-label="${esc(tr('links.paste.one'))}" />
      <button type="button" class="btn btn-primary" data-empty-act="paste">${esc(tr('ui.add'))}</button>
    </div>
    <p class="empty-s">${esc(tr('links.empty.text3'))}</p>
    ${desLiens ? '' : `<div class="empty-actions"><button type="button" class="btn" data-empty-act="import">${esc(tr('links.empty.import'))}</button></div>`}
  </div>`;
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

