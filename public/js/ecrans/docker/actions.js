'use strict';
/* Docker · Actions groupées. */
// @expose dockerStateLabel, loadDocker
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
/* `docker stop` — donc `docker compose stop` — envoie SIGTERM puis SIGKILL : un container qui
   ne piège pas SIGTERM sort en 143 ou 137 sans que rien ne soit cassé. Ces deux codes disent
   « on me l'a demandé », pas « je suis tombé ». Sauf s'il a été tué faute de mémoire : même
   code, sens opposé, et l'inspect le dit. */
const DACT_ARRET_DEMANDE = [137, 143];
function dactEstPlantage(c) {
  const code = Number(c && c.exitCode);
  if (!(code > 0)) return false;
  return !!(c && c.oom) || !DACT_ARRET_DEMANDE.includes(code);
}

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
       n'y entre pas — on ne classe pas un container en panne sur une supposition. MÊME RÈGLE
       que le badge du menu (`healthSummary`, côté serveur) : les deux doivent désigner les
       mêmes containers, sinon cliquer le chiffre rouge ouvre une autre liste que lui. */
    case 'crashed': return st === 'exited' && dactEstPlantage(svc.container);
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
/* DIX VALEURS FIXES, UN SEUL CHOIX : des pastilles, pas un menu déroulant. Un menu cache son
   état derrière un clic — sur un filtre qu'on manipule en boucle, c'est un clic par coup d'œil.
   C'est la règle écrite dans style.css (`.chip`), déjà tenue par Liens et par les tranches de
   note des Reviews ; Docker était le dernier à s'en écarter. */
const dockerStateChips = (cur) => DOCKER_STATE_FILTERS
  .map(([v, k]) => `<button type="button" class="chip${cur === v ? ' active' : ''}" data-dstate="${v}" aria-pressed="${cur === v}">${esc(tr(k))}</button>`).join('');
// Le groupe d'Actions est bâti une fois, depuis cette liste (celui de Compose l'est à chaque
// rendu, dans son gabarit). Un changement de langue recharge la page : rien à retraduire.
/* A/Docker 2 — LE SEUL ÉCRAN DOCKER SANS MÉMOIRE. Compose retient son filtre, les logs
   retiennent leurs containers cochés, la couleur et le tail ; Actions repartait sur
   « Recréer » et « tous » à chaque visite, alors que c'est l'écran le plus répétitif des
   quatre. Les SÉLECTIONS, elles, ne sont pas retenues : appliquer « stop » à des services
   cochés hier, sans les revoir, serait une action à l'aveugle. */
const DACT_MEMO = 'aidevtools_docker_actions';
const dactMemo = () => { try { return JSON.parse(localStorage.getItem(DACT_MEMO) || '{}'); } catch { return {}; } };
function dactMemoriser() {
  try {
    localStorage.setItem(DACT_MEMO, JSON.stringify({
      action: ($('#dactAction') || {}).value || 'recreate',
      state: ($('#dactFilter') && $('#dactFilter').dataset.state) || 'all',
    }));
  } catch { /* stockage indisponible */ }
}
(() => {
  const m = dactMemo();
  const el = $('#dactFilter');
  if (el) { el.innerHTML = dockerStateChips(m.state || 'all'); el.dataset.state = m.state || 'all'; }
  const sel = $('#dactAction');
  if (sel && m.action && [...sel.options].some((o) => o.value === m.action)) sel.value = m.action;
})();
// Clés i18n complètes (littérales) pour réutiliser EXACTEMENT le libellé de l'onglet Compose.
const DACT_DRIFT_LABEL = { 'drift-config': 'docker.badge.drift-config', 'drift-image': 'docker.badge.drift-image', 'compose-modified': 'docker.badge.compose-modified' };
function dactItems() {
  const action = $('#dactAction').value;
  const filter = $('#dactFilter') ? ($('#dactFilter').dataset.state || 'all') : 'all';
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
$('#dactAction') && $('#dactAction').addEventListener('change', () => { DACT.selected.clear(); dactMemoriser(); dactSyncApply(); renderDockerActions(); });
$('#dactFilter') && $('#dactFilter').addEventListener('click', (e) => {
  const c = e.target.closest('[data-dstate]'); if (!c) return;
  const grp = $('#dactFilter');
  grp.dataset.state = c.dataset.dstate;
  grp.innerHTML = dockerStateChips(c.dataset.dstate);
  dactMemoriser();
  renderDockerActions();
});
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
    /* Les sauvegardes arrivent à part et ne bloquent rien : c'est un filet, pas l'écran
       principal. Sans sauvegarde, le bloc n'existe pas. */
    const bkP = chargerSauvegardesDocker().catch(() => {});
    await loadComposeProgressive();
    await orphP;
    await bkP;
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

/* Les états que Docker sait rendre. Un état hors liste (une version future du démon)
   s'affiche tel quel plutôt que de laisser une clé de traduction à l'écran. */
const DOCKER_STATES = ['running', 'exited', 'created', 'restarting', 'paused', 'dead', 'removing', 'unknown'];
function dockerStateLabel(state) {
  if (state === 'none') return tr('docker.not-started');
  return DOCKER_STATES.includes(state) ? tr(`docker.state.${state}`) : state;
}

/* B8 — proposer de poser l'adresse locale dans la grille. Une requête par projet compose et
   par page (mémorisée) : elle ne sort pas de la base, et elle ne rend rien dans l'immense
   majorité des cas — d'où le remplissage APRÈS le rendu, jamais pendant. */
const cacheGrilleLocale = new Map();
async function remplirGrilleLocale(projets) {
  for (const zone of $$('[data-dk-grille]')) {
    const dir = zone.dataset.dkGrille;
    const p = (projets || []).find((x) => x.dir === dir);
    if (!p) continue;
    const port = (p.services || []).filter((s) => s.container && s.container.state === 'running')
      .flatMap((s) => s.ports || [])[0];
    if (!port) continue;
    if (!cacheGrilleLocale.has(dir)) {
      cacheGrilleLocale.set(dir, api(`/docker/local-links?dir=${encodeURIComponent(dir)}`).catch(() => ({ service: null })));
    }
    const d = await cacheGrilleLocale.get(dir);
    if (!d || !d.service || !d.environment || d.filled || !zone.isConnected) continue;
    zone.innerHTML = `<button type="button" class="btn btn-sm" data-dk-poser="${esc(dir)}"
        data-service="${d.service.id}" data-env="${d.environment.id}" data-url="http://localhost:${port}"
        title="${esc(tr('docker.grid.fill.title', { service: d.service.name, env: d.environment.name, url: `http://localhost:${port}` }))}">${svgIco('link')}${esc(tr('docker.grid.fill'))}</button>`;
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-dk-poser]');
  if (!b) return;
  try {
    /* La MÊME route que la grille elle-même : il n'y a qu'une façon d'écrire une case, et
       c'est celle-là. Elle remplace le contenu de la case — d'où la garde côté serveur qui
       ne propose ce bouton que sur une case VIDE. */
    await busy(b, () => api(`/services/${b.dataset.service}/urls`, {
      method: 'PUT',
      body: { environment_id: Number(b.dataset.env), url: b.dataset.url, label: 'local' },
    }));
    cacheGrilleLocale.delete(b.dataset.dkPoser);
    b.remove();
    toast(tr('docker.grid.filled', { url: b.dataset.url }));
  } catch (err) { toast(explainError(err.message), true); }
});

function dockerServiceRow(proj, s) {
  const b = (DOCKER_BADGE()[s.badge]) || { label: s.badge, cls: '' };
  const canRecreate = ['drift-config', 'drift-image', 'compose-modified'].includes(s.badge);
  /* ORDRE FIXE, LES ACTIONS INDISPONIBLES DÉSACTIVÉES. Auparavant elles étaient absentes :
     la rangée changeait de composition d'un container à l'autre (`Stop · Redémarrer · Pull ·
     Build · Recréer` puis `Pull · Build · Démarrer`), donc « Recréer », bleu et primaire,
     tombait sous « Stop » de la ligne précédente. Une colonne d'actions doit être un rail :
     on vise la même position sur toutes les lignes. */
  const act = (a, label, cls, actif) => `<button class="btn btn-sm${cls ? ` ${cls}` : ''}" data-dockeract="${a}" data-dir="${esc(proj.dir)}" data-svc="${esc(s.name)}"${actif ? '' : ` disabled title="${esc(tr('docker.act.unavailable'))}"`}>${esc(label)}</button>`;
  // État du container MIS EN ÉVIDENCE : pastille colorée + libellé (vert = running, rouge =
  // exited/dead, ambre = paused/restarting/created, pointillé = non démarré).
  const state = s.container ? (s.container.state || 'unknown') : 'none';
  const isRunning = state === 'running';
  /* Le libellé passe par le dictionnaire. Docker rend son état en anglais (`running`,
     `exited`, `created`…) et il s'affichait tel quel, dans la même colonne que « non créé »
     et « arrêté » : trois langues pour une seule information. */
  const stateLabel = dockerStateLabel(state);
  const stateChip = `<span class="docker-state docker-state-${esc(state)}" title="${esc(stateLabel)}"><span class="docker-dot"></span>${esc(stateLabel)}</span>`;
  return `<div class="docker-svc">
      <div class="docker-svc-head">
        ${stateChip}
        <strong>${esc(s.name)}</strong>
        <span class="tag ${b.cls}">${esc(b.label)}</span>
        ${/* B8 — LE PORT PUBLIÉ EST UNE ADRESSE. Le compose déclare `3000:3000` : on ouvrait
              quand même un onglet à la main en tapant localhost:3000. Le bouton n'apparaît
              que si le service TOURNE — proposer d'ouvrir un service arrêté mènerait à une
              page d'erreur, ce qui est pire que ne rien proposer. */''}
        ${isRunning ? (s.ports || []).slice(0, 3).map((port) => `<a class="btn btn-sm btn-ghost dk-port" href="http://localhost:${port}"
            target="_blank" rel="noopener noreferrer" title="${esc(tr('docker.open-local', { port }))}">${svgIco('external')}:${port}</a>`).join('') : ''}
        ${s.image ? `<code class="muted">${esc(s.image)}</code>` : ''}
        ${s.container && s.container.name ? `<span class="muted">${esc(s.container.name)}</span>` : ''}
        ${/* A35 — DEPUIS QUAND IL TOURNE, ET COMBIEN DE FOIS IL A REDÉMARRÉ. « Il vient de
              repartir » est la première chose à savoir devant un service qui répond mal, et
              une boucle de redémarrage ne se voyait qu'en regardant deux fois à cinq minutes
              d'intervalle. Les deux sont dans l'inspect déjà fait pour le drift. */''}
        ${isRunning && s.container && s.container.started_at
    ? `<span class="muted" data-when="${esc(s.container.started_at)}" title="${esc(tr('docker.uptime-title', { when: fmtDateTime(s.container.started_at) }))}">${esc(tr('docker.uptime', { when: depuis(s.container.started_at) }))}</span>` : ''}
        ${s.container && s.container.restarts > 0
    ? `<span class="tag ${s.container.restarts >= 3 ? 'stale' : ''}" title="${esc(tr('docker.restarts-title'))}">${svgIco('repeat')} ${s.container.restarts}</span>` : ''}
        <span class="spacer"></span>
        ${/* Les six actions dans leur PROPRE bloc, insécable : dans la tête de ligne elles se
             repliaient à un endroit qui dépendait de la longueur du nom du container, si bien
             que « Stop » n'était jamais deux fois à la même abscisse d'une ligne à l'autre. */''}
        <div class="docker-svc-actions">
          ${/* CONTINUER AU TERMINAL. Mergerie fait le geste courant ; pour le reste — un
                `exec`, un flag de plus — on repart de la commande exacte plutôt que de la
                reconstruire de mémoire. */''}
          <button type="button" class="btn btn-sm btn-ghost" data-copy-cmd="docker compose -f ${esc(proj.path)} up -d ${esc(s.name)}" title="${esc(tr('docker.copy-cmd'))}" aria-label="${esc(tr('docker.copy-cmd'))}"><svg class="ico ico-sm"><use href="#i-copy"/></svg></button>
          ${act('stop', tr('docker.act.stop'), 'btn-danger', isRunning)}
          ${act('restart', tr('docker.act.restart'), '', isRunning)}
          ${act('pull', tr('docker.act.pull'), '', true)}
          ${act('build', tr('docker.act.build'), '', true)}
          ${act('up', tr('docker.act.up'), '', !isRunning)}
          ${act('recreate', tr('docker.act.recreate'), 'btn-primary', canRecreate)}
        </div>
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
      ${/* CONTINUER AU TERMINAL exactement là où Mergerie s'arrête : la commande se copie. */''}
      <button type="button" class="btn btn-sm btn-ghost mk-copy" data-copy-cmd="cd ${esc(p.dir)} &amp;&amp; make ${esc(t.name)}" title="${esc(tr('docker.copy-cmd'))}" aria-label="${esc(tr('docker.copy-cmd'))}"><svg class="ico ico-sm"><use href="#i-copy"/></svg></button>
      ${/* « Ai-je déjà passé les migrations ce matin ? » : rempli après coup, par répertoire. */''}
      <span class="mk-last muted" data-mk-last="${esc(t.name)}" hidden></span>
    </div>`;
  // Ouvert par défaut : dans sa colonne, le bloc est en haut à gauche → visible sans scroller.
  return `<details class="docker-make" open>
      <summary><svg class="ico ico-sm"><use href="#i-doc"/></svg> ${esc(tr('docker.make.title', { n: mk.targets.length, count: mk.targets.length }))} <span class="muted">· ${esc(mk.file)}</span></summary>
      <input type="search" class="search mk-search" placeholder="${esc(tr('docker.make.search-ph'))}" />
      <div class="mk-list" data-mk-dir="${esc(p.dir)}">${mk.targets.map(item).join('')}</div>
      <p class="muted mk-none" hidden>${esc(tr('docker.make.no-match'))}</p>
    </details>`;
}

/* Les dernières exécutions des cibles d'un répertoire, posées APRÈS le rendu : la carte ne
   doit pas attendre cette réponse, et un répertoire dont aucune cible n'a jamais tourné
   n'affiche rien du tout. */
async function majDernieresCibles() {
  for (const liste of $$('[data-mk-dir]')) {
    if (liste.dataset.mkFait === '1') continue;
    liste.dataset.mkFait = '1';
    let d;
    try { d = await api(`/docker/make/runs?dir=${encodeURIComponent(liste.dataset.mkDir)}`); } catch { continue; }
    for (const el of $$('[data-mk-last]', liste)) {
      const r = (d.runs || {})[el.dataset.mkLast];
      if (!r) { el.hidden = true; continue; }
      const etat = r.finished_at == null ? '⋯' : (r.ok ? '✓' : '✗');
      el.hidden = false;
      el.textContent = `${depuis(r.finished_at || r.started_at)} ${etat}`;
      el.classList.toggle('mk-last-ko', r.finished_at != null && !r.ok);
    }
  }
}
/* Le bouton « copier » d'une commande : service Docker, logs, cible Make — un seul écouteur. */
document.addEventListener('click', (e) => {
  const txt = e.target.closest && e.target.closest('[data-copy-txt]');
  if (txt) {
    e.preventDefault(); e.stopPropagation();
    copyText(txt.dataset.copyTxt, null);
    toast(tr('toast.copied-value', { valeur: txt.dataset.copyTxt }));
    return;
  }
  const b = e.target.closest && e.target.closest('[data-copy-cmd]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  copyText(b.dataset.copyCmd, null);
  toast(tr('docker.copy-cmd.done'));
});

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
        <div class="title" style="flex:1;min-width:0"><code>${esc(p.name)}</code> <span class="muted">${esc(p.file)} · ${esc(p.rootLabel || p.dir)}</span>
          ${/* QU'EST-CE QUE JE SUIS EN TRAIN DE TESTER ? La branche et le commit du répertoire
                qui porte le compose répondent à la question là où on démarre la stack. Lu dans
                `.git` sur le disque, sans processus ni sondage — absent, rien ne s'affiche. */''}
          ${p.git && p.git.branch ? ` <span class="docker-git">${svgIco('branch')} ${chipBranche(p.git.branch)}${p.git.sha ? ` <span class="git-sha muted">${esc(p.git.sha)}</span>` : ''}</span>` : ''}
        </div>
        <div class="docker-project-actions">
          ${/* B8 — LA CASE « LOCAL » DE LA GRILLE, que ce compose sait déjà remplir. Le bloc
                arrive vide et se remplit après le rendu : il n'apparaît QUE si le dossier
                porte le dépôt d'un service de la grille, que l'environnement « local »
                existe, et que sa case est VIDE. Rien n'est écrit sans clic. */''}
          <span class="dk-grille" data-dk-grille="${esc(p.dir)}"></span>
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


