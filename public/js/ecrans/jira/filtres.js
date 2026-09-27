'use strict';
/* Jira : filtre générique par champ, par sprint, par statut, par assigné. */
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
      ${/* Ce qui a déjà avancé côté code, en pied de carte : rempli après coup par
            `majEngagementsListe`, en un appel pour toute la liste. */''}
      <div class="jira-item-eng muted" data-eng-key="${esc(it.key)}" hidden></div>
    </button>`).join('');
  majEngagementsListe(items.map((x) => x.key));
}

