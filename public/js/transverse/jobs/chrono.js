'use strict';
/* Temps écoulé du job ; chrono de session de travail. */
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
    const ms = elapsed();
    $('#chronoTime').textContent = fmt(ms);
    const running = !!startedAt;
    $('#chrono').classList.toggle('running', running);
    /* À zéro et à l'arrêt, il se réduit : l'heure ne dit rien et la remise à zéro n'a rien à
       remettre. C'est l'état dans lequel il passe l'essentiel du temps, en haut à droite de
       tous les écrans. */
    $('#chrono').classList.toggle('idle', !running && ms === 0);
    $('#chronoStart').hidden = running;
    $('#chronoPause').hidden = !running;
    $('#chronoReset').hidden = !running && ms === 0;
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

