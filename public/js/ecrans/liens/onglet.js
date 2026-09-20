'use strict';
/* Onglet Liens : l'état, les filtres retenus, la barre. */
// @expose loadLinks
/* ============ Onglet Liens : grille services × environnements ============
   Les marque-pages d'un navigateur ne savent pas dire qu'un même service existe en local,
   en dev, en preprod et en prod : ils en font quatre entrées dans quatre dossiers. D'où une
   GRILLE — services en lignes, environnements en colonnes — et, à côté, des liens libres à
   plat pour tout ce qui n'a pas de dimension environnement. Deux formes, deux réalités. */
/* ═══════════════════════════════ Liens ═══════════════════════════════
   DEUX ÉCRANS EN UN, ASSUMÉS. *Lire et ouvrir* — calme, dense, un clic, le clavier ; et
   *écrire* — la fiche, le panneau d'une case, l'import, le réordonnancement, révélés par le
   survol. Les deux se marchaient dessus : l'onglet est devenu un référentiel (on y corrige des
   adresses, on y règle des colonnes, on y importe) que son écran présentait encore comme un
   moteur de recherche, trois rangées de filtres tout allumées avant d'arriver au contenu.

   UNE CASE EST UNE LISTE. La grille montre la CARTE — qui a quoi, où — et la liste vit dans un
   panneau ancré sur la case. C'est ce qui règle le cas d'un Kibana de production à cinquante
   adresses sans toucher au modèle : la ligne reste haute de trois adresses, toujours.

   ON AJOUTE EN COLLANT. Ce qu'on a en main, neuf fois sur dix, c'est une URL dans le
   presse-papiers ; le rangement se propose, et créer un environnement ou un service devient un
   sous-produit au lieu d'un préalable. */
const LINKS = {
  grid: null, tag: '', q: '', selectMode: false, selection: new Set(),
  importLinks: [], importGrid: null, freeDeplie: null,
  /* Les colonnes MASQUÉES, et non les colonnes retenues. Un interrupteur dit « je cache
     celle-là » : rien de posé cache donc rien, et une colonne créée demain s'affiche sans
     qu'on ait à repasser sur ses filtres. */
  envsCaches: new Set(),
  /* Filtrer sur la prod POUR VOIR LES TROUS DE PROD était impossible : masquer une colonne
     masquait aussi les lignes sans adresse dedans, c'est-à-dire exactement celles qu'on
     cherchait. Le comportement existe encore, mais il se demande. */
  masquerVides: false,
};

/* Les filtres servent tous les jours : les reposer à chaque ouverture serait absurde. Même
   mécanisme que le filtre des notes — `localStorage`, côté navigateur, parce que c'est une
   préférence d'affichage et pas un réglage de l'outil. */
const LINKS_FILTRES = 'mergerie_links_filters';
function chargerFiltresLiens() {
  try {
    const d = JSON.parse(localStorage.getItem(LINKS_FILTRES) || '{}');
    LINKS.envsCaches = new Set(Array.isArray(d.envsCaches) ? d.envsCaches : []);
    LINKS.tag = typeof d.tag === 'string' ? d.tag : '';
    LINKS.masquerVides = !!d.masquerVides;
    LINKS.freeDeplie = d.freeDeplie === true || d.freeDeplie === false ? d.freeDeplie : null;
  } catch { /* stockage indisponible */ }
}
function retenirFiltresLiens() {
  try {
    localStorage.setItem(LINKS_FILTRES, JSON.stringify({
      envsCaches: [...LINKS.envsCaches], tag: LINKS.tag, masquerVides: LINKS.masquerVides, freeDeplie: LINKS.freeDeplie,
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
  /* Un environnement supprimé depuis la dernière visite laisserait un filtre invisible et
     impossible à relâcher : on écarte ce qui n'existe plus. */
  const idsEnv = new Set((LINKS.grid.environments || []).map((e) => e.id));
  LINKS.envsCaches = new Set([...LINKS.envsCaches].filter((i) => idsEnv.has(i)));
  if (LINKS.tag && !(LINKS.grid.tags || []).includes(LINKS.tag)) LINKS.tag = '';
  rafraichirLiens();
}

/* ---------- La barre : des colonnes, un tag, et rien d'autre au repos ---------- */

/* TROIS RANGÉES DE FILTRES SONT PARTIES. Les pastilles SERVICES répétaient les lignes de la
   grille visibles cinq centimètres plus bas — avec leur propre champ de tamis, soit trois
   tamis pour une même liste ; « tout allumé » voulait dire « aucun filtre » mais se peignait
   comme une sélection ; et les tags mélangeaient services et liens libres dans un seul compte.
   Reste ce qui décide de ce qu'on voit : les colonnes, et un menu de tags qui dit sur quoi il
   porte. */
function renderLinkBarre() {
  const g = LINKS.grid || {};
  const envs = g.environments || [];
  const cols = $('#linkCols');
  if (cols) {
    cols.hidden = !envs.length;
    cols.innerHTML = !envs.length ? '' : `<span class="lf-lab">${esc(tr('links.filter.columns'))}</span>`
      + envs.map((e) => {
        const on = !LINKS.envsCaches.has(e.id);
        return `<button type="button" class="link-col-sw${on ? ' on' : ''}" data-linkenv="${e.id}" aria-pressed="${on}"
          title="${esc(tr(on ? 'links.filter.col-hide' : 'links.filter.col-show', { name: e.name }))}">
          <span class="link-env-dot" style="background:${esc(e.color)}"></span>${esc(e.name)}</button>`;
      }).join('')
      /* La case qui rend l'ANCIEN comportement, décochée par défaut et nommée pour ce qu'elle
         fait : masquer des LIGNES, jamais des colonnes. Les deux sémantiques ne se confondent
         plus, et celle qui surprend est celle qu'on a demandée. */
      + `<label class="link-col-empty"><input type="checkbox" id="linkHideEmpty"${LINKS.masquerVides ? ' checked' : ''} />`
      + `<span>${esc(tr('links.filter.hide-empty'))}</span></label>`;
  }
  const tags = g.tags || [];
  const bt = $('#linkTagBtn');
  if (bt) {
    bt.hidden = !tags.length;
    bt.classList.toggle('active', !!LINKS.tag);
    $('span', bt).textContent = LINKS.tag || tr('links.filter.tag');
  }
  const menu = $('#linkTagMenu');
  if (menu) {
    /* LE COMPTE DÉTAILLÉ. « produit 3 » ne disait pas trois quoi : trois services, trois liens
       libres, ou deux et un. Le filtre porte sur les deux moitiés de l'écran, il doit dire ce
       qu'il va y trouver de chaque côté. */
    menu.innerHTML = tags.map((t) => {
      const s = (g.services || []).filter((x) => (x.tags || []).includes(t)).length;
      const l = (g.free_links || []).filter((x) => (x.tags || []).includes(t)).length;
      return `<button type="button" data-linktag="${esc(t)}"${LINKS.tag === t ? ' class="active"' : ''}>`
        + `<span>${esc(t)}</span> <span class="muted">${esc([
          s ? tr('links.filter.tag-svc', { n: s, count: s }) : '',
          l ? tr('links.filter.tag-free', { n: l, count: l }) : '',
        ].filter(Boolean).join(' · '))}</span></button>`;
    }).join('');
  }
  const chips = $('#linkFilterChips');
  if (chips) {
    chips.innerHTML = LINKS.tag
      ? `<button type="button" class="chip active" data-untag title="${esc(tr('links.filter.tag-clear'))}">${esc(LINKS.tag)} ×</button>`
      : '';
  }
  const clear = $('#linkClearFilters');
  // « Tout afficher » vide TOUT, la recherche comprise : c'est ce que la phrase promet.
  if (clear) clear.hidden = !(LINKS.tag || LINKS.q || LINKS.envsCaches.size || LINKS.masquerVides);
}

// Les colonnes montrées. Rien de masqué = toutes.
const envsVisibles = () => ((LINKS.grid || {}).environments || [])
  .filter((e) => !LINKS.envsCaches.has(e.id));

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
  const foin = `${metaService(s)} ${u.label || u.display || ''} ${u.url}`.toLowerCase();
  return motsRecherche().every((m) => foin.includes(m));
}

function serviceVisible(s) {
  if (LINKS.tag && !(s.tags || []).includes(LINKS.tag)) return false;
  // Masquer les lignes sans adresse visible ne se fait plus QUE si on l'a demandé (voir 4.6).
  if (LINKS.masquerVides && !envsVisibles().some((e) => ((s.urls || {})[e.id] || []).length)) return false;
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

