'use strict';
/* Onglet Docker : projets compose (drift .env) et containers hors-compose, les badges santé. */
// @expose marquerDockerVu, refreshDockerBadges, showDockerSub
/* ---------- Onglet Docker : projets compose (drift .env) + containers hors-compose ---------- */
const DOCKER_BADGE = () => ({
  synced: { label: tr('docker.badge.synced'), cls: 'done' },
  'drift-config': { label: tr('docker.badge.drift-config'), cls: 'stale' },
  'drift-image': { label: tr('docker.badge.drift-image'), cls: 'reviewed' },
  'compose-modified': { label: tr('docker.badge.compose-modified'), cls: 'reviewed' },
  stopped: { label: tr('docker.badge.stopped'), cls: '' },
  missing: { label: tr('docker.badge.missing'), cls: 'to_review' },
});

function showDockerSub(name) {
  $$('#tab-docker .subnav [data-dsub]').forEach((b) => b.classList.toggle('active', b.dataset.dsub === name));
  $$('#tab-docker .subtab').forEach((p) => p.classList.toggle('active', p.id === `dsub-${name}`));
  try { localStorage.setItem('aidevtools_dsub', name); } catch { /* ignore */ }
  if (name === 'logs') loadDockerLogs();
  if (name === 'actions') loadDockerActions();
}
$$('#tab-docker .subnav [data-dsub]').forEach((b) => b.addEventListener('click', () => showDockerSub(b.dataset.dsub)));
$('#dockerRefresh') && $('#dockerRefresh').addEventListener('click', () => loadDocker(true));

/* Badges santé du menu Docker. ROUGE = les containers qui ne rendent plus service, qu'ils
   soient cassés (restarting/dead) ou simplement arrêtés (exited) — de l'extérieur c'est le
   même symptôme, et c'est ce chiffre-là qu'on veut voir de n'importe quel onglet. La bulle,
   elle, garde la distinction : « 2 arrêtés · 1 en erreur ». ORANGE = unhealthy.
   Rafraîchi au démarrage, à l'ouverture de l'onglet ET toutes les 30 s (cf. plus bas) via
   /docker/summary = un seul `docker ps -a` (léger). */
/* PAS D'ALARME AVANT LA PREMIÈRE VISITE. Sur une installation neuve, l'onglet Docker
   affichait « 7 » en rouge : sept containers d'autres projets, sur la machine, que Mergerie
   n'a jamais gérés et que rien dans l'écran ne demande de réparer. Un badge rouge est une
   dette qu'on doit à quelqu'un — pas un inventaire de la machine. Il n'apparaît donc qu'une
   fois l'onglet ouvert au moins une fois : à ce moment-là, on sait ce qu'il compte. */
let dockerVu = false;
try { dockerVu = localStorage.getItem('aidevtools_docker_vu') === '1'; } catch { /* ignore */ }
function marquerDockerVu() {
  if (dockerVu) return;
  dockerVu = true;
  try { localStorage.setItem('aidevtools_docker_vu', '1'); } catch { /* ignore */ }
  refreshDockerBadges();
}

async function refreshDockerBadges() {
  const eB = $('#dockerErrBadge'); const uB = $('#dockerUnhealthyBadge');
  if (!eB || !uB) return;
  if (!dockerVu) { eB.hidden = true; uB.hidden = true; return; }
  try {
    const s = await api('/docker/summary');
    const err = s.error || 0; const exited = s.exited || 0; const un = s.unhealthy || 0;
    /* Le ROUGE ne compte que l'anormal : restarting/dead, plus les containers sortis en ERREUR.
       Un arrêt propre (code 0) — « je l'ai arrêté », ou un job qui a fini — n'est pas une avarie ;
       le compter en rouge faisait sonner l'alarme tous les jours, et une alarme qui sonne toujours
       n'est plus lue. Les arrêts propres restent visibles dans la bulle, pas dans le chiffre. */
    const crashed = s.crashed || 0;
    const propres = Math.max(0, exited - crashed);
    /* `title = ''` (et non l'absence de title) : sur un enfant, un title VIDE empêche
       le navigateur de remonter à celui du bouton parent — sans ça, survoler le chiffre
       afficherait « Projets Docker Compose… » par-dessus notre bulle. */
    const setBadge = (el, n, label) => {
      el.hidden = !n; el.textContent = n;
      el.dataset.tip = label;            // bulle de l'app (immédiate, thémée)
      el.title = '';
      el.setAttribute('aria-label', label);
    };
    // Bulle composée : on n'énumère que ce qui est non nul, dans l'ordre de gravité.
    const down = [
      err ? tr('docker.badge.error', { n: err, count: err }) : '',
      crashed ? tr('docker.badge.crashed', { n: crashed, count: crashed }) : '',
      propres ? tr('docker.badge.exited-clean', { n: propres, count: propres }) : '',
    ].filter(Boolean).join(' · ');
    setBadge(eB, err + crashed, down);
    setBadge(uB, un, tr('docker.badge.unhealthy', { n: un, count: un }));
  } catch { eB.hidden = true; uB.hidden = true; }
}

