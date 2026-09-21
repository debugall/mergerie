'use strict';
/* Log en direct du job, hauteur du panneau, le filtre A41, un volet de journal par job. */
/* ---------- Log en direct du job ---------- */
let logJobId = null;
let logHidden = false;
// Repli auto d'un job terminé : on ne veut pas que le bandeau reste collé en haut de tous les onglets.
let autoHideJobId = null;
let autoHideTimer = null;
let lastJobStatus = null; // dernière issue connue (done/error/stopped…) → pastille du bouton « journal »
let lastJobRunning = false; // le job tourne ENCORE derrière un panneau masqué → pastille en cours

// Rouvre le panneau de log (masqué par « masquer » ou par le repli auto).
function showLogPanel() {
  const p = $('#logPanel');
  if (p) { p.hidden = false; logHidden = false; clearTimeout(autoHideTimer); if (!logExpanded) $('#logToggle').click(); }
  updateFooterLogs();
}
/* LA HAUTEUR DU PANNEAU, DONNÉE AU CSS. `body` réserve cette place en bas : sans elle, la fin
   de chaque page passe SOUS un panneau `fixed` large de toute la colonne et haut de cent
   soixante-dix pixels, et ce qui s'y trouve devient incliquable. Le cas se produit pour de
   bon : un job en ERREUR ne se replie jamais tout seul — c'est voulu, on doit pouvoir lire
   l'erreur — et il recouvre alors le pied du formulaire des Réglages, donc « Enregistrer ».
   Mesurée plutôt que devinée : le panneau grandit avec sa file d'attente et sa progression.
   Le `+ 12` est le retrait qui le décolle du bandeau du bas. */
function mesurerLogPanel() {
  const p = $('#logPanel');
  const h = (p && !p.hidden) ? Math.round(p.getBoundingClientRect().height) + 12 : 0;
  document.documentElement.style.setProperty('--logpanel-h', `${h}px`);
}
if (typeof ResizeObserver === 'function' && $('#logPanel')) {
  new ResizeObserver(mesurerLogPanel).observe($('#logPanel'));
}

// Bouton « journal » du bandeau : visible seulement quand un job a tourné ET que le panneau est
// masqué (sinon il ferait doublon). La pastille rappelle l'issue du dernier job — ou, tant qu'il
// tourne encore derrière le panneau masqué (« masquer », ou un job qui redémarre en tâche de
// fond), le dit ambre et pulsante : sans elle rien ne distinguait « terminé » de « en cours,
// mais cette carte n'affiche que masquer/rafraîchir ».
function updateFooterLogs() {
  mesurerLogPanel();
  const b = $('#footerLogs');
  if (!b) return;
  b.hidden = !(logJobId && $('#logPanel').hidden);
  b.classList.toggle('st-running', lastJobRunning);
  b.classList.toggle('st-done', !lastJobRunning && lastJobStatus === 'done');
  b.classList.toggle('st-error', !lastJobRunning && lastJobStatus === 'error');
}

/* Coloration d'une ligne de journal. La détection d'erreur reste volontairement large et
   couvre les deux langues du serveur : elle ne sert qu'à teinter, jamais à décider — se
   tromper met une ligne en rouge, pas en péril. */
/* A41 — LE DOUBLE-CLIC sur une ligne de journal mène à la merge request dont elle parle.
   Double et non simple : on sélectionne du texte dans un journal, et un clic qui naviguerait
   rendrait la sélection impossible. */
document.addEventListener('dblclick', (e) => {
  const el = e.target.closest && e.target.closest('[data-log-mr]');
  if (!el) return;
  navMrReport(Number(el.dataset.logMr));
});

/* A41 — CHERCHER DANS LE JOURNAL. Un run de vérification déverse deux mille lignes, et
   retrouver `ECONNREFUSED` — ou ne garder que les erreurs — se faisait au défilement, à l'œil.
   On MASQUE les lignes qui ne correspondent pas, comme partout ailleurs dans l'outil : rien
   n'est coupé, décocher ramène tout, et le compte dit ce qui est caché. */
function filtrerJournal() {
  const champ = $('#logFilter');
  const q = ((champ && champ.value) || '').trim().toLowerCase();
  const erreursSeules = !!($('#logErrOnly') && $('#logErrOnly').checked);
  const panes = $$('#logBox .logpane');
  let caches = 0;
  for (const pane of panes) {
    for (const span of pane.children) {
      if (span.classList.contains('log-trunc')) continue;
      const txt = span.textContent || '';
      const masque = (q && !txt.toLowerCase().includes(q))
        || (erreursSeules && !span.classList.contains('err'));
      span.hidden = masque;
      if (masque) caches += 1;
    }
  }
  const info = $('#logFilterInfo');
  if (info) {
    info.textContent = (q || erreursSeules) && caches ? tr('job.log.filtered', { n: caches, count: caches }) : '';
  }
}
onEl($('#logFilter'), 'input', debounce(filtrerJournal, 120));
onEl($('#logErrOnly'), 'change', filtrerJournal);

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
    // Le double-clic mène à la MR de la ligne : le serveur donne `mr_id`, encore fallait-il le poser.
    if (l.mr_id) span.dataset.logMr = String(l.mr_id);
    span.textContent = l.text + '\n';
    frag.appendChild(span);
  }
  pane.appendChild(frag);
  // A41 — le filtre s'applique aussi à ce qui ARRIVE : un journal qui défile ne doit pas
  // ramener les lignes qu'on vient d'écarter.
  filtrerJournal();
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
  /* Les onglets gardent aussi les jobs FINIS ou ARRÊTÉS : on ne compte que ceux qui tournent
     encore, sinon « 2 jobs en cours » avec un seul job vivant. */
  const vivants = ids.filter((id) => id === d.job_id ? running : !TERMINAL.has(LOGP.state.get(id))).length;
  const plusieurs = vivants > 1 ? ` · ${tr('job.running-n', { n: vivants, count: vivants })}` : '';
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
  stopBtn.title = vivants > 1 ? tr('job.stop.all-title', { n: vivants }) : tr('job.stop.one-title');
  /* « Relancer » ne s'affiche que sur un job qui n'est pas allé au bout ET dont le serveur
     sait rejouer l'intention. Le bandeau disait « arrêté » et laissait deviner où cliquer. */
  const retry = $('#logRetry');
  if (retry) { retry.hidden = running || !d.can_retry; retry.dataset.job = d.job_id; }
  /* …et quand il ne s'affiche pas alors qu'un job a échoué, on DIT pourquoi : un bouton qui
     disparaît sans un mot se lit comme un oubli, pas comme une décision. */
  const sansRetry = $('#logNoRetry');
  if (sansRetry) {
    const raison = !running && !d.can_retry && d.no_retry_reason;
    sansRetry.hidden = !raison;
    sansRetry.textContent = raison || '';
  }
  if (d.lines.length && logExpanded && $('#logAutoscroll').checked && !pane.hidden) pane.scrollTop = pane.scrollHeight;
  // Repli auto quelques secondes après un job TERMINÉ (succès ou arrêt) : le panneau ne doit
  // pas rester collé en haut de tous les onglets. On garde l'ERREUR affichée (elle appelle une
  // action) et on ne masque pas si l'utilisateur a déplié le journal pour le lire.
  /* UN JOB QUI A PRODUIT QUELQUE CHOSE NE S'EFFACE PAS TOUT SEUL. Il se repliait six secondes
     après la fin, sans laisser de lien vers son résultat : le seul reste était une pastille de
     onze pixels dans le pied de page. Quand le job désigne un objet — la MR reviewée, la session
     — le bandeau garde un bouton qui y mène, et attend qu'on le ferme. */
  const res = $('#logResult');
  const menePar = !running && d.status === 'done' && d.target_kind && d.target_id;
  if (res) {
    res.hidden = !menePar;
    if (menePar) {
      res.dataset.kind = d.target_kind; res.dataset.id = d.target_id;
      /* Une VÉRIFICATION produit un rapport, pas une session : le bouton disait « Voir la
         session » et menait à Dev IA, où il n'y avait rien à voir. */
      res.querySelector('span').textContent = tr(
        d.target_kind === 'mr' || d.target_kind === 'verification' ? 'job.result.open' : 'job.result.open-task');
    }
  }
  /* COMBIEN DE TEMPS LE BANDEAU RESTE. Un job sans résultat à ouvrir part au bout de six
     secondes. Un job qui MÈNE quelque part attendait, lui, qu'on le ferme — et occupait donc
     cinquante pixels en haut de tous les onglets, indéfiniment, longtemps après qu'on soit
     passé à autre chose. Il part maintenant au bout de trente secondes : assez pour cliquer
     « Voir », pas assez pour s'installer. Rien n'est perdu — la pastille du pied de page le
     rouvre, et déplier le journal suspend le repli dans les deux cas. */
  const DELAI_REPLI = menePar ? 30000 : 6000;
  if (running) { autoHideJobId = null; clearTimeout(autoHideTimer); }
  else if ((d.status === 'done' || d.status === 'stopped') && d.job_id && autoHideJobId !== d.job_id) {
    autoHideJobId = d.job_id;
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(() => {
      // logHidden = true : empêche un pumpLog ultérieur (déclenché par une action) de ré-afficher
      // le job déjà terminé. Un NOUVEAU job réinitialise logHidden et ré-affiche le panneau.
      if (!logExpanded && !logHidden) { panel.hidden = true; logHidden = true; updateFooterLogs(); }
    }, DELAI_REPLI);
  }
  lastJobStatus = d.status;
  lastJobRunning = running;
  updateLogQueueBtn(d.queued || 0);
  if (logQueueOpen) renderLogQueue();
  updateFooterLogs();
}

