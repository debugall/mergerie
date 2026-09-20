'use strict';
/* Statut et progression d'un job : « ça tourne » attaché à l'objet, le bouton dit ce qu'il fait, ce qu'un collègue a changé, l'atterrissage du résultat. */
/* ---------- Statut / progression ---------- */
let pollTimer = null;
// Identité du job en cours : sert à détecter le DÉMARRAGE d'un job (et pas seulement sa
// fin) pour rafraîchir les listes — sans ça, lancer une itération laissait la carte sur
// son ancien statut (« poussée ») jusqu'au rechargement de la page.
let lastSeenJobId = null;
/* Le dernier job dont on a DÉJÀ traité la fin. La détection reposait sur `pollTimer` : « il y
   avait un sondage en cours, donc un job vient de finir ». C'est faux pour un job court — une
   review qui dure moins d'un tour de boucle n'a jamais fait naître le timer, et rien ne
   rafraîchissait la liste ni les compteurs. L'écran affichait alors « À traiter 10 » quand
   l'API répondait 9, indéfiniment : la première action du produit paraissait sans effet.
   L'identifiant, lui, ne dépend d'aucune cadence. `null` tant qu'on n'a rien vu ; le PREMIER
   état reçu ne déclenche rien (au chargement, le dernier job de la base est fini depuis
   longtemps et son annonce n'aurait aucun sens). */
let dernierJobFini = null;
let premierStatutRecu = false;

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
  if (fini.mrs.length) {
    if ($('#tab-review').classList.contains('active')) loadSegment(currentSeg);
    // Les compteurs ne sont pas dans la liste : sans ça, ils gardent la valeur d'avant.
    refreshCounts();
    if ($('#tab-notes').classList.contains('active')) loadBrief();
  }
  ciblesEnCours = targets;
  const t = targets || { mrs: [], tasks: [], locals: [], verifying: [] };
  const veut = new Set([
    ...(t.mrs || []).map((id) => `[data-id="${id}"]`),
    ...(t.tasks || []).map((id) => `[data-task="${id}"]`),
    ...(t.locals || []).map((id) => `[data-local="${id}"]`),
  ]);
  const vise = new Set();
  for (const sel of veut) for (const el of $$(`.card${sel}`)) vise.add(el);
  for (const el of $$('.card.running-now')) if (!vise.has(el)) el.classList.remove('running-now');
  for (const el of vise) el.classList.add('running-now');
  marquerVerifEnCours(t.verifying || []);
  document.body.classList.toggle('tab-cachee', document.hidden);
}
/* LE BOUTON DIT CE QU'IL FAIT, EN TOUTES LETTRES. Une vérification dure des minutes et vit dans
   un job : le `busy()` du clic retombe dès que la requête a répondu, bien avant que le travail
   commence — et plus rien ne disait qu'il avait commencé. Le bouton devient donc
   « Vérification… », spinner compris, tant que le SERVEUR compte ce job comme en cours : ça
   survit à un re-rendu de la liste, à un changement d'onglet et à un rechargement, ce qu'un
   état gardé dans la page ne ferait pas.

   Pas le `data-busy` de `busy()` : il masque le libellé, et un bouton devenu rond blanc oblige
   à se rappeler sur quoi on a cliqué. On garde donc le libellé d'origine dans `data-verif` —
   qui sert aussi à ne relâcher que les boutons qu'on a nous-mêmes pris. */
function marquerVerifEnCours(ids) {
  const veut = new Set(ids.map(Number));
  for (const b of $$('[data-verify], [data-verify-report], #aVerify')) {
    const id = Number(b.dataset.verify || b.dataset.verifyReport || (selectedMr || 0));
    const enCours = veut.has(id);
    if (enCours && !b.dataset.verif) {
      b.dataset.verif = b.innerHTML;
      b.innerHTML = `<span class="spin"></span>${esc(tr('verify.btn.running'))}`;
      b.disabled = true;
      b.title = tr('verify.btn.running-title');
    } else if (!enCours && b.dataset.verif) {
      b.innerHTML = b.dataset.verif; delete b.dataset.verif;
      b.disabled = false;
      b.title = tr('verify.btn.verify-title');
    }
  }
}
document.addEventListener('visibilitychange', () => document.body.classList.toggle('tab-cachee', document.hidden));

let copilotBinCourant = '';
/* ---------- Ce qu'un collègue a changé, à l'écran ----------
   La synchro met la base à jour ; la page, elle, n'en savait rien. Une merge request reviewée par
   un collègue restait « à traiter » ici jusqu'au rechargement, ses compteurs avec. Le serveur
   donne un numéro (`dataVersion`) qui avance quand une synchro pose ou retire des lignes : à
   chaque changement, on recharge les compteurs et l'écran AFFICHÉ — les autres se chargent de
   toute façon à l'ouverture. Rien de ce qu'on est en train d'écrire n'est touché : le formulaire
   des réglages garde ses champs modifiés, la page de notes en cours de frappe passe par son
   propre contrôle de conflit. */
let versionDonneesVue = null;
function suivreVersionDonnees(v) {
  if (v === undefined || v === null) return;
  if (versionDonneesVue === null) { versionDonneesVue = v; return; }
  if (v === versionDonneesVue) return;
  versionDonneesVue = v;
  rafraichirApresSynchro().catch(() => { /* un écran qui ne se recharge pas n'est pas une panne */ });
}
async function rafraichirApresSynchro() {
  const actif = (id) => { const t = $(`#tab-${id}`); return !!(t && t.classList.contains('active')); };
  refreshCounts();
  refreshOpenTodos();           // les pastilles de Notes
  loadTasks();                  // compteurs des saveurs et badge de Dev IA, même onglet fermé
  if (actif('review')) {
    loadToReview();
    if (currentSeg !== 'to_review') {
      await loadReports(currentSeg);
      if (selectedMr && !reportRows.some((m) => m.id === selectedMr)) {
        // Le rapport ouvert a quitté ce stade (supprimé, rouvert, classé) : on ne le montre plus.
        selectedMr = null; renderReportPlaceholder();
      } else if (selectedMr) openReport(selectedMr, { keep: true });
    }
  }
  if (actif('notes')) {
    if (NOTES.sub === 'today') loadBrief();
    if (NOTES.sub === 'todos') loadTodos();
    if (NOTES.sub === 'pages') await rafraichirPagesApresSynchro();
  }
  if (actif('agents')) loadAgentList();
  if (actif('dashboard')) loadDashboard();
  if (actif('admin')) {
    let sub = 'gitcfg';
    try { sub = localStorage.getItem('aidevtools_admin_sub') || 'gitcfg'; } catch { /* défaut */ }
    try { (ADMIN_SUBS[sub] || loadConfig)(); } catch { /* best-effort */ }
  }
}
/* La page ouverte : relue si personne n'y écrit. Si une frappe attend son enregistrement, c'est
   lui qui découvrira le changement — et le dira (conflit), au lieu d'écraser l'un ou l'autre. */
async function rafraichirPagesApresSynchro() {
  await loadPages();
  const p = NOTES.page;
  if (!p) return;
  if (pageSave && pageSave.id === p.id) return;
  if (NOTES.conflit && NOTES.conflit.id === p.id) return;
  let frais;
  try { frais = await api(`/notes/${p.id}`); }
  catch { NOTES.page = null; NOTES.pageId = null; renderPageEditor(); return; }   // supprimée ailleurs
  if (!NOTES.page || NOTES.page.id !== p.id || String(frais.updated_at) === String(NOTES.page.updated_at)) return;
  NOTES.page = frais;
  renderPageEditor();
}

async function refreshStatus() {
  try {
    const s = await api('/status');
    suivreVersionDonnees(s.dataVersion);
    // Le binaire configuré : c'est lui qui décide si un profil d'agent s'applique en entier
    // (claude) ou seulement par son modèle (copilot). L'éditeur le dit avant la sauvegarde.
    copilotBinCourant = s.copilotBin || '';
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
    /* PREMIER ÉTAT REÇU : on note ce qui était déjà fini avant notre arrivée, et on ne
       déclenche rien. Sans ça, ouvrir la page annoncerait la fin du dernier job de la base —
       terminé la veille — et rafraîchirait des listes qu'on vient tout juste de charger. */
    if (!premierStatutRecu) {
      premierStatutRecu = true;
      if (job && JOB_FINI.includes(job.status)) dernierJobFini = job.id;
    }
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
      if (job && JOB_FINI.includes(job.status) && premierStatutRecu && job.id !== dernierJobFini) {
        dernierJobFini = job.id;
        // job vient de finir : rafraîchir les listes ET le détail ouvert
        const avant = new Map(reportRows.map((m) => [m.id, m.note && m.note.raw]));
        loadToReview();
        if (currentSeg !== 'to_review') loadReports(currentSeg).then(() => signalerAtterrissage(avant));
        /* LES COMPTEURS AUSSI. Les listes se rechargeaient déjà, pas les segments : après une
           review, l'écran affichait encore « À traiter 10 / Reviewées 7 » quand l'API répondait
           9/8, et il fallait changer d'onglet pour voir son propre travail. C'est la seule part
           visible du résultat sur cet écran. */
        refreshCounts();
        // Et le brief, qui compte les MR fraîches et les rapports qui attendent une décision.
        if ($('#tab-notes').classList.contains('active')) loadBrief();
        if ($('#tab-task').classList.contains('active')) loadTasks();
        // action Docker terminée (up/restart/down…) → recharger la liste pour voir le nouvel état
        if ($('#tab-docker').classList.contains('active')) loadDocker();
        // `keep` : ne réécrit l'écran que si quelque chose d'affiché a changé.
        if (selectedMr) {
          const rendu = openReport(selectedMr, { keep: true });
          /* UNE QUESTION NE CHANGE RIEN À CE QUI EST AFFICHÉ — c'est tout son intérêt. `keep`
             ne réécrirait donc pas l'écran, et la réponse n'y arriverait jamais : on recharge
             les échanges à part, APRÈS le rendu, pour ne pas se faire écraser par lui. */
          if (job.kind === 'ask-review') Promise.resolve(rendu).then(() => chargerEchangesRevue(selectedMr));
        }
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

/* Le bouton du bandeau mène à ce que le job a produit — et le referme, puisqu'on l'a lu. */
$('#logResult') && $('#logResult').addEventListener('click', () => {
  const b = $('#logResult');
  const id = Number(b.dataset.id);
  // `navMrReport` et non `openReport` seul : il faut AUSSI le bon stade, sinon le rapport
  // s'ouvre dans un panneau masqué et le lien paraît sans effet.
  if (b.dataset.kind === 'mr') { navMrReport(id); }
  else if (b.dataset.kind === 'verification') { openVerifyReport(id); }
  else { navTab('task'); loadTasks(); }
  const panel = $('#logPanel'); if (panel) { panel.hidden = true; logHidden = true; updateFooterLogs(); }
});
