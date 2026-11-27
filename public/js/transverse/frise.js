'use strict';
/* LA FRISE DU DÉROULÉ d'une session — au cockpit, sur la carte d'une session de codage et sur celle d'un codage
   sur dépôt local. Toutes les étapes, dans l'ordre (le serveur les calcule : `jobs/workflow.js`) : ce qui est
   fait, ce qui tourne (mis en avant), ce qui attend, ce qui viendra ; en pointillé, une passe qui n'aura lieu
   que si la note reste sous le seuil. Une étape de vérification ouvre son rapport ; arrêtée sur une étape,
   la frise porte « Continuer ». */
const FRISE_ICONE = { fait: 'check', en_cours: 'refresh', en_file: 'clock', a_toi: 'inbox', echec: 'close' };

function friseLibelle(e, { sansProjet = false } = {}) {
  const v = { n: e.n || 0, nom: e.nom || '', projet: e.projet || '' };
  let libelle;
  if (e.cle === 'verif') libelle = tr(e.cote ? `cockpit.wf.verif-${e.cote}` : 'cockpit.wf.verif', v);
  else if (e.cle === 'review' && !e.n) libelle = tr('cockpit.wf.review-0', v);
  else libelle = tr(`cockpit.wf.${e.cle}`, v);
  // Plusieurs projets (ou dossiers) : chacun a ses étapes, la frise dit lequel.
  return e.projet && !sansProjet && !e.cle.startsWith('scen-') ? `${e.projet} · ${libelle}` : libelle;
}
function friseDetail(e) {
  const out = [];
  if (e.note != null) out.push(tr('cockpit.wf.note', { note: String(e.note).replace('.', ',') }));
  if (e.essai > 1) out.push(tr('task.chaine.attempt', { n: e.essai }));
  if (e.cle === 'converge-fin' && e.detail) out.push(tr(`cockpit.wf.fin.${e.detail}`));
  else if (e.cle === 'diag' && e.detail) out.push(tr(`task.chaine.diag.cause.${e.detail}`));
  else if (e.cle === 'mr' && e.etat === 'saute' && e.detail) out.push(tr(`cockpit.wf.mr.${e.detail}`));
  else if ((e.cle === 'scen-ecrire' || e.cle === 'scen-pousser') && e.etat === 'fait' && e.detail) out.push(e.detail);   // les fichiers, le scénario qui couvre, la branche
  else if (e.detail && (e.etat === 'echec' || e.etat === 'a_toi')) out.push(e.detail);
  if (e.projet && e.cle.startsWith('scen-')) out.push(tr('cockpit.wf.in', { projet: e.projet }));
  return out.join(' · ');
}
/* `s` : `{ id, kind: 'code' | 'local', workflow }`. Sur une carte à plusieurs dépôts, la frise se range :
   `cible` (l'id d'un projet ou d'un dossier) rend les seules étapes de cette ligne, sous elle dans « Replier les
   projets » ; `commun` rend « Étape en cours », « Continuer » et les étapes communes (la chaîne). Sans option :
   tout, groupé par dépôt — le cockpit, qui n'a pas de lignes de dépôts. */
function friseHtml(s, { cible = null, commun = false } = {}) {
  const wf = s && s.workflow;
  if (!wf || !wf.etapes || !wf.etapes.length) return '';
  const pastille = (e, i, sansProjet) => {
    const detail = friseDetail(e);
    const titre = `${tr(`cockpit.wf.etat.${e.etat}`)}${e.si ? ` — ${tr('cockpit.wf.si')}` : ''}${detail ? ` — ${detail}` : ''}`;
    const lien = e.verification_id ? ` data-chaine-verif="${e.verification_id}" role="button" tabindex="0"` : '';
    return `<li class="frise-etape is-${esc(e.etat)}${e.si ? ' is-si' : ''}${i === wf.courante ? ' is-courante' : ''}" title="${esc(titre)}"${lien}>
      <span class="frise-ico">${FRISE_ICONE[e.etat] ? svgIco(FRISE_ICONE[e.etat]) : '<span class="frise-point"></span>'}</span>
      <span class="frise-txt"><span class="frise-nom">${esc(friseLibelle(e, { sansProjet }))}</span>${detail ? `<span class="frise-detail">${esc(detail)}</span>` : ''}</span>
    </li>`;
  };
  if (cible != null) {
    const siennes = wf.etapes.map((e, i) => [e, i]).filter(([e]) => e.cible === cible);
    return siennes.length ? `<div class="frise frise-cible" data-frise-cible="${esc(String(cible))}">
      <ol class="frise-etapes">${siennes.map(([e, i]) => pastille(e, i, true)).join('')}</ol></div>` : '';
  }
  /* PLUSIEURS DÉPÔTS (ou dossiers) : une frise par dépôt — son codage, son push, sa convergence —, puis une frise
     commune pour ce qui porte sur l'ensemble (la chaîne de validation, son scénario). Un seul : une frise. */
  const groupes = [];
  wf.etapes.forEach((e, i) => {
    const cle = e.projet && !e.cle.startsWith('scen-') ? e.projet : '';
    let g = groupes.find((x) => x.cle === cle);
    if (!g) { g = { cle, items: [] }; groupes.push(g); }
    g.items.push([e, i]);
  });
  groupes.sort((a, b) => (a.cle === '') - (b.cle === ''));   // le commun après les dépôts
  const parDepot = groupes.some((g) => g.cle);
  const communes = wf.etapes.map((e, i) => [e, i]).filter(([e]) => e.cible == null);
  let etapes;
  if (commun) {
    etapes = communes.length ? `<div class="frise-groupe" data-frise-groupe="">
        <div class="frise-groupe-nom">${esc(tr('cockpit.wf.group.common'))}</div>
        <ol class="frise-etapes">${communes.map(([e, i]) => pastille(e, i, true)).join('')}</ol>
      </div>` : '';
  } else etapes = parDepot
    ? groupes.map((g) => `<div class="frise-groupe" data-frise-groupe="${esc(g.cle)}">
        <div class="frise-groupe-nom">${esc(g.cle || tr('cockpit.wf.group.common'))}</div>
        <ol class="frise-etapes">${g.items.map(([e, i]) => pastille(e, i, true)).join('')}</ol>
      </div>`).join('')
    : `<ol class="frise-etapes">${wf.etapes.map((e, i) => pastille(e, i, false)).join('')}</ol>`;
  const c = wf.courante == null ? null : wf.etapes[wf.courante];
  const ou = c ? tr('cockpit.wf.now', { etape: friseLibelle(c), etat: tr(`cockpit.wf.etat.${c.etat}`) }) : '';
  // Arrêtée sur une étape : « Continuer » fait repartir le déroulé (une question, elle, ouvre la session).
  const k = wf.continuer;
  const continuer = k ? `<button type="button" class="btn btn-sm btn-primary" data-frise-continuer="${s.id}" data-kind="${esc(s.kind || 'code')}" data-action="${esc(k.action)}"
      data-targets="${esc((k.targets || []).join(','))}" title="${esc(tr(`cockpit.wf.continue.${k.action}`))}">
      <svg class="ico"><use href="#i-${k.action === 'repondre' ? 'inbox' : 'play'}"/></svg>${esc(tr(k.action === 'repondre' ? 'cockpit.wf.answer' : 'cockpit.wf.continue'))}</button>` : '';
  if (commun && !etapes && !ou && !continuer) return '';
  return `<div class="frise" data-frise="${esc(s.kind || 'code')}-${s.id}">
    ${ou || continuer ? `<div class="frise-ou">${esc(ou)} ${continuer}</div>` : ''}
    ${etapes}
  </div>`;
}

/* « CONTINUER » : l'action que le serveur a choisie pour l'étape arrêtée, par la route qui la porte déjà. Une
   session de codage : relancer le codage des projets sans commit, pousser, reprendre la convergence, relancer
   (ou démarrer) la chaîne. Hors dépôt : recoder les dossiers en échec, reprendre par « Converger ». Une
   question n'a pas d'action : sa session s'ouvre pour y répondre. */
const FRISE_ROUTES = {
  code: {
    code: (id, b) => [`/tasks/${id}/run`, { targets: friseCibles(b) }],
    push: (id) => [`/tasks/${id}/push-all`, {}],
    converge: (id) => [`/tasks/${id}/converge`, {}],
    chaine: (id) => [`/tasks/${id}/chaine/relancer`, {}],
  },
  local: {
    code: (id, b) => [`/local-tasks/${id}/run`, { dirs: friseCibles(b) }],
    converge: (id) => [`/local-tasks/${id}/converge`, {}],
  },
};
const friseCibles = (b) => (b.dataset.targets || '').split(',').filter(Boolean).map(Number);
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-frise-continuer]');
  if (!b) return;
  const id = Number(b.dataset.friseContinuer);
  const kind = b.dataset.kind === 'local' ? 'local' : 'code';
  if (b.dataset.action === 'repondre') { ouvrirSession(id, kind); return; }
  const route = (FRISE_ROUTES[kind] || {})[b.dataset.action];
  if (!route) return;
  const [url, body] = route(id, b);
  try { await busy(b, () => api(url, { method: 'POST', body })); toast(tr('cockpit.wf.continued')); }
  catch (err) { toast(explainError(err.message), true); }
  // L'écran qui montrait la frise se relit : le cockpit, ou la liste des sessions.
  if ($('#tab-task.active.vue-cockpit')) loadCockpit(); else loadTasks();
  refreshStatus();
});
