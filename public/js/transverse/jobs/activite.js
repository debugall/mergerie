'use strict';
/* Journal d'activité : ce qui a tourné. */
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

/* `interrupted` est un job FINI : la base le pose au démarrage sur ce que l'arrêt précédent a
   coupé, et le processus n'existe plus. Absent d'ici, il restait éternellement « en cours »
   pour le client, qui continuait de l'interroger. */
const JOB_FINI = ['done', 'stopped', 'error', 'interrupted'];
function jobDuree(j) {
  if (!j.started_at || !j.finished_at) return '';
  const ms = new Date(j.finished_at) - new Date(j.started_at);
  if (!(ms > 0)) return '';
  return ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
}
const JOB_STATUT = { done: 'ok', error: 'bad', stopped: 'mid', interrupted: 'mid', running: 'mid', queued: '' };

/* Le filtre de l'historique des jobs : il MASQUE. « Échecs seulement » répond à la question
   qu'on se pose en l'ouvrant — « qu'est-ce qui a raté pendant que je regardais ailleurs ? ». */
function filtrerHistoriqueJobs() {
  const q = (($('#histFilter') || {}).value || '').trim().toLowerCase();
  const ratesSeuls = !!(($('#histErrOnly') || {}).checked);
  $$('#logHist .log-queue-row').forEach((r) => {
    const rate = r.dataset.histStatut === 'error' || r.dataset.histStatut === 'stopped';
    r.hidden = (q && !(r.dataset.cherche || '').includes(q)) || (ratesSeuls && !rate);
  });
}
onEl($('#histFilter'), 'input', debounce(filtrerHistoriqueJobs, 120));
onEl($('#histErrOnly'), 'change', filtrerHistoriqueJobs);

async function renderLogHist() {
  const box = $('#logHist');
  if (!box || !logHistOpen) return;
  let d;
  try { d = await api('/jobs/history?limit=40'); } catch (e) { box.innerHTML = errorBox(e.message); return; }
  if (!d.jobs.length) { box.innerHTML = `<p class="muted">${esc(tr('job.hist.empty'))}</p>`; return; }
  const vu = histVu();
  /* A40 — CE QUE L'HISTORIQUE TAISAIT : la RAISON d'un échec (le message est renvoyé depuis
     toujours), le moyen de RELANCER sans passer par le bandeau, et un filtre — quarante lignes
     de tous types mêlés, on cherchait « la review d'hier » à l'œil. */
  box.innerHTML = d.jobs.map((j) => {
    const neuf = JOB_FINI.includes(j.status) && j.id > vu;
    const duree = jobDuree(j);
    const rate = j.status === 'error' || j.status === 'stopped';
    return `<div class="log-queue-row${neuf ? ' hist-neuf' : ''}" data-hist-statut="${esc(j.status)}"
      data-cherche="${esc([j.label, jobKindLabel(j.kind), j.message].filter(Boolean).join(' ').toLowerCase())}">
      <span class="note ${JOB_STATUT[j.status] || ''}">${esc(tr(`job.status.${j.status}`))}</span>
      <span class="tag">${esc(jobKindLabel(j.kind))}</span>
      <span class="log-queue-what">${j.label ? `<button class="linklike" data-histgo="${j.id}">${esc(j.label)}</button>` : '<span class="muted">—</span>'}
        ${rate && j.message ? `<div class="hist-raison muted" title="${esc(j.message)}">${esc(String(j.message).split('\n')[0].slice(0, 120))}</div>` : ''}</span>
      <span class="spacer"></span>
      ${duree ? `<span class="muted">${esc(duree)}</span>` : ''}
      <span class="muted hist-quand">${esc(j.finished_at ? fmtDateTime(j.finished_at) : '')}</span>
      ${j.can_retry ? `<button class="btn btn-icon btn-sm" data-histretry="${j.id}" title="${esc(tr('job.retry.title'))}">${svgIco('repeat')}</button>` : ''}
      <button class="btn btn-icon btn-sm" data-histlog="${j.id}" title="${esc(tr('job.hist.log'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg></button>
    </div>`;
  }).join('');
  filtrerHistoriqueJobs();
  $$('#logHist [data-histretry]').forEach((b) => b.addEventListener('click', async () => {
    try { await busy(b, () => api(`/jobs/${b.dataset.histretry}/retry`, { method: 'POST' })); toast(tr('job.retry.done')); refreshStatus(); renderLogHist(); }
    catch (e) { toast(explainError(e.message), true); }
  }));
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
  // La barre de filtre vit avec la liste : seule, elle proposerait de filtrer le vide.
  if ($('#logHistBar')) $('#logHistBar').hidden = !logHistOpen;
  if (logHistOpen) { logQueueOpen = false; $('#logQueue').hidden = true; renderLogHist(); }
});

$('#logQueueBtn') && $('#logQueueBtn').addEventListener('click', () => {
  logQueueOpen = !logQueueOpen;
  if (logQueueOpen) { logHistOpen = false; $('#logHist').hidden = true; if ($('#logHistBar')) $('#logHistBar').hidden = true; }
  $('#logQueue').hidden = !logQueueOpen;
  if (logQueueOpen) renderLogQueue();
});

