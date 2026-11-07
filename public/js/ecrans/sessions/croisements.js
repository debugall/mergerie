'use strict';
/* Sous le choix des dépôts de la modale de session : ce que chaque dépôt coché porte comme MR
   ouvertes, les croisements de la MR dont la session repart, et les MR ouvertes qui touchent un
   chemin écrit dans le prompt. Une ligne grise, information seulement : rien n'est bloqué, aucun
   bouton de plus — la session se lance quand même. Lecture de la base, zéro réseau, zéro IA. */

let seqCroiseSession = 0;
async function majCroisementsSession() {
  const el = $('#taskCroisements');
  if (!el) return;
  const wrap = $('#taskReposWrap');
  if (!wrap || wrap.hidden) { el.hidden = true; return; }
  const targets = readTargetRows();
  const text = ($('#taskPrompt') || {}).value || '';
  if (!targets.length) { el.hidden = true; return; }
  const mon = ++seqCroiseSession;
  let d;
  try { d = await api('/croisements/session', { method: 'POST', body: { targets, text } }); } catch { return; }
  if (mon !== seqCroiseSession) return;     // une réponse plus récente est en route
  if (!d || !d.enabled) { el.hidden = true; return; }
  const plusieurs = (d.targets || []).length > 1;
  const lignes = [];
  for (const c of d.targets || []) {
    const prefixe = plusieurs ? `${esc(c.project)} : ` : '';
    const chemins = (c.paths || []).map((p) => esc(tr('task.croise.path', {
      n: p.mrs.length, count: p.mrs.length, path: p.path, mrs: p.mrs.map((x) => `!${x.iid}`).join(', '),
    })));
    // Un chemin cité dans le prompt remplace le compte : c'est lui qui répond à la question posée.
    if (chemins.length) lignes.push(...chemins.map((l) => prefixe + l));
    else lignes.push(prefixe + esc(tr('task.croise.open', { n: c.open, count: c.open })));
    if (c.mr && (c.overlaps || []).length) {
      lignes.push(prefixe + esc(tr('task.croise.branch', {
        iid: c.mr.iid, n: c.overlaps.length, count: c.overlaps.length, mrs: c.overlaps.map((o) => `!${o.iid}`).join(', '),
      })));
    }
  }
  el.innerHTML = lignes.join('<br>');
  el.hidden = !lignes.length;
}
const majCroisementsSessionBientot = debounce(majCroisementsSession, 400);
$('#targetRows').addEventListener('change', majCroisementsSessionBientot);
$('#targetRows').addEventListener('input', (e) => { if (e.target.matches && e.target.matches('.t-branch')) majCroisementsSessionBientot(); });
$('#taskPrompt').addEventListener('input', majCroisementsSessionBientot);
