'use strict';
/* Données partagées : le dépôt git d'équipe. */
/* ---------- DONNÉES PARTAGÉES ----------
 *
 * L'écran de la synchronisation : où l'on en est, un bouton pour rattacher ce poste, un pour
 * forcer un tour, et la liste des conflits gardés. Rien d'autre — et surtout aucune commande
 * git à taper : c'est l'outil qui fait le git, sinon la promesse tombe.
 *
 * La liste des conflits est le seul écran qui compte vraiment. Un conflit n'est jamais bloquant
 * (le distant l'emporte, toujours), mais la version écrasée est GARDÉE : cet écran est ce qui
 * permet de la reprendre. Sans lui, « le dernier gagne » serait « le premier perd en silence ».
 */
let dataSyncEtat = null;

async function chargerDataSync() {
  const zone = $('#dataSyncState');
  if (!zone) return;
  try { dataSyncEtat = await api('/data-sync'); } catch { return; }
  const e = dataSyncEtat;
  if (!e.configure) {
    zone.textContent = tr('datasync.state.off');
    $('#dataSyncConflicts').innerHTML = '';
    return;
  }
  const bouts = [];
  if (!e.clone) bouts.push(tr('datasync.state.not-attached'));
  else bouts.push(tr('datasync.state.counts', { up: e.enAvance, down: e.enRetard }));
  if (e.dernierPull) bouts.push(tr('datasync.state.last-pull', { at: new Date(e.dernierPull).toLocaleTimeString() }));
  /* L'IDENTITÉ GIT MANQUANTE EST UN CAS À PART : tout a l'air de marcher, mais rien n'est
     commité. On le dit en toutes lettres plutôt que de laisser chercher. */
  if (e.identite && !e.identite.ok) bouts.push(tr('datasync.state.no-identity'));
  else if (e.identite) bouts.push(tr('datasync.state.as', { name: e.identite.name }));
  if (e.erreur) bouts.push(tr('datasync.state.error', { msg: e.erreur }));
  zone.textContent = bouts.join(' · ');
  rendreConflits(e.conflits || []);
}

function rendreConflits(liste) {
  const zone = $('#dataSyncConflicts');
  if (!zone) return;
  if (!liste.length) { zone.innerHTML = ''; return; }
  zone.innerHTML = `<h3 class="conflits-h">${esc(tr('datasync.conflicts.head', { n: liste.length }))}</h3>`
    + liste.map((c) => `<div class="conflit" data-file="${esc(c.fichier)}">
        <div class="conflit-nom">${esc(c.fichier)}</div>
        <pre class="conflit-mienne">${esc(String(c.mienne || '').slice(0, 2000))}</pre>
        <div class="conflit-actions">
          <button class="btn btn-small" data-keep="mine">${esc(tr('datasync.conflicts.keep-mine'))}</button>
          <button class="btn btn-small" data-keep="theirs">${esc(tr('datasync.conflicts.keep-theirs'))}</button>
        </div>
      </div>`).join('');
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('#dataSyncConflicts [data-keep]');
  if (!b) return;
  const fichier = b.closest('.conflit').dataset.file;
  b.disabled = true;
  try {
    const r = await api('/data-sync/conflicts/resolve', { method: 'POST', body: { file: fichier, keep: b.dataset.keep } });
    rendreConflits(r.conflits || []);
    toast(tr('datasync.conflicts.settled'));
  } catch (e) { toast(explainError(e.message), true); b.disabled = false; }
});

/* CE QUI VA PARTIR SE LIT AVANT DE CLIQUER, PAS APRÈS.
 *
 * « Cloner / rattacher » est le geste qui ouvre son travail à d'autres. On demande donc au
 * serveur ce que l'export emporterait — sans rien écrire —, on le montre, et on n'agit qu'après
 * un « oui ». La liste de ce qui RESTE est la plus utile des deux : sessions et todos sont
 * privées par défaut, et l'apprendre ici vaut mieux que de chercher sa session chez un collègue.
 */
function resumeApercu(a, pied) {
  const nom = (cle) => tr(`datasync.apercu.${cle}`);
  /* UNE LIGNE PAR FAMILLE, le nombre à gauche. Tout sur une seule ligne séparée par des
     points médians, c'était une phrase de deux cents caractères où l'on cherchait son objet :
     on veut y trouver « mes sessions » du regard, pas la lire. */
  const liste = (xs) => `<ul class="apercu-liste">${(xs || []).map((x) => `<li><b>${esc(String(x.n))}</b> <span>${esc(nom(x.cle))}</span></li>`).join('')}</ul>`;
  const colonne = (cle, icone, xs, note) => `<section class="apercu-col apercu-col-${cle}">
      <h4>${svgIco(icone)}<span>${esc(tr(`datasync.apercu.${cle}-titre`))}</span></h4>
      ${xs && xs.length ? liste(xs) : `<p class="apercu-vide muted">${esc(tr('datasync.apercu.rien'))}</p>`}
      ${note ? `<p class="apercu-note muted">${esc(note)}</p>` : ''}
    </section>`;
  /* CE QUE L'ENVOI FERA, FICHIER PAR FICHIER. « 0 supprimé » n'est pas une estimation : l'export
     écrit, il ne supprime jamais — et ce qu'il ne touche pas, ce sont les documents des autres.
     Le zéro est donc AFFICHÉ, pas omis : c'est lui qu'on vient vérifier. */
  const e = a.ecriture || {};
  const chiffre = (cle, v, ton) => `<div class="apercu-chiffre${ton ? ` apercu-chiffre-${ton}` : ''}">
      <b>${esc(String(v))}</b><span>${esc(nom(cle))}</span></div>`;
  return `<div class="apercu">
    <p class="apercu-tete apercu-tete-${a.pourvu === null ? 'muet' : (a.pourvu ? 'rejoint' : 'init')}">${esc(
    a.pourvu === null ? tr('datasync.apercu.injoignable')
      : tr(a.pourvu ? 'datasync.apercu.rejoindre' : 'datasync.apercu.initialiser'),
  )}</p>
    <div class="apercu-cols">
      ${colonne('part', 'upload', a.partants, '')}
      ${colonne('reste', 'lock', a.retenus, tr('datasync.apercu.reste-note'))}
    </div>
    <div class="apercu-bloc">
      <h4>${svgIco('doc')}<span>${esc(tr('datasync.apercu.fichiers'))}</span></h4>
      <div class="apercu-chiffres">
        ${chiffre('ajoutes', e.nouveaux || 0)}
        ${chiffre('modifies', e.modifies || 0)}
        ${chiffre('inchanges', e.identiques || 0)}
        ${chiffre('supprimes', e.supprimes || 0, 'nul')}
      </div>
      <p class="apercu-note muted">${esc(e.intacts
    ? tr('datasync.apercu.ecriture-note', { intacts: e.intacts, n: e.intacts })
    : tr('datasync.apercu.ecriture-note-nul'))}</p>
    </div>
    ${/* CE QUE LE DÉPÔT PORTE DÉJÀ — la question qu'on se pose vraiment devant ce bouton :
         « est-ce que je vais écraser le travail des autres ? ». Un nombre, puis la règle. */
    a.distants ? `<p class="apercu-distants">${svgIco('users')}<span>${esc(tr('datasync.apercu.distants', { n: a.distants, count: a.distants }))}</span></p>` : ''}
    ${/* LA RÈGLE, EN BAS ET EN PETIT. Elle vivait dans le `<pre>` des détails — police à
         chasse fixe et pas de retour à la ligne : une phrase y sortait du cadre. */
    pied ? `<p class="apercu-pied muted">${esc(pied)}</p>` : ''}
  </div>`;
}

const btnDataAttach = $('#btnDataAttach');
if (btnDataAttach) btnDataAttach.addEventListener('click', async () => {
  const btn = btnDataAttach;
  const url = String(($('#configForm').data_repo_url || {}).value || '').trim();
  if (!url) { toast(tr('datasync.err.url-required'), true); return; }
  /* L'APERÇU INTERROGE LE DÉPÔT DISTANT : un `ls-remote` sur un dépôt lointain prend
     facilement plusieurs secondes, et un bouton qui ne bouge pas se re-clique. Le bouton
     tourne, et la ligne d'état dit ce qu'on attend. */
  let apercu = null;
  $('#dataSyncInfo').textContent = tr('datasync.apercu.calcul');
  try { apercu = await busy(btn, () => api('/data-sync/preview', { method: 'POST', body: { url } })); }
  catch (e) { $('#dataSyncInfo').textContent = ''; toast(explainError(e.message), true); return; }
  $('#dataSyncInfo').textContent = '';
  if (!await confirmDialog({
    title: tr('datasync.btn.attach'),
    html: resumeApercu(apercu, tr('datasync.apercu.detail')),
    confirmLabel: tr('datasync.apercu.go'),
    danger: false,
    wide: true,
  })) return;
  btn.disabled = true;
  $('#dataSyncInfo').textContent = tr('datasync.working');
  try {
    /* On ENREGISTRE d'abord : le rattachement lit la branche et la cadence en base, et
       rattacher avec l'ancienne branche pendant que l'écran en montre une autre serait
       exactement le genre de petit mensonge qu'on évite. */
    await api('/config', { method: 'PUT', body: {
      data_repo_url: url,
      data_repo_branch: ($('#configForm').data_repo_branch || {}).value || 'main',
      data_sync_seconds: ($('#configForm').data_sync_seconds || {}).value || '30',
    } });
    const r = await api('/data-sync/attach', { method: 'POST', body: { url } });
    /* ON VIENT DE REJOINDRE UNE ÉQUIPE : ce qui était caché faute d'équipe doit apparaître sans
       recharger la page — la case « partager » d'une page de notes, l'exécutant d'un agent. */
    moiCache = null;
    /* REJOINDRE VA DANS LES DEUX SENS, et le dire évite la question suivante : on reçoit ce que
       l'équipe a accumulé, ET ce que ce poste portait déjà part avec. Le compte le prouve. */
    const emportes = Object.values(r.compte || {}).reduce((n, x) => n + (Number(x) || 0), 0);
    $('#dataSyncInfo').textContent = r.mode === 'init'
      ? tr('datasync.done.init') : tr('datasync.done.clone', { n: emportes });
    await chargerDataSync();
  } catch (e) { $('#dataSyncInfo').textContent = ''; toast(explainError(e.message), true); }
  finally { btn.disabled = false; }
});

/* TOUT RÉ-ENVOYER. « Synchroniser » n'envoie que ce qui a CHANGÉ — après un dépôt vidé à la
   main, il ne remet donc rien. Ce bouton-là réécrit tout ce qui se partage, et il montre d'abord
   quoi : c'est le même récapitulatif que le rattachement. */
const btnDataReexport = $('#btnDataReexport');
if (btnDataReexport) btnDataReexport.addEventListener('click', async () => {
  let apercu = null;
  $('#dataSyncInfo').textContent = tr('datasync.apercu.calcul');
  try { apercu = await busy(btnDataReexport, () => api('/data-sync/preview', { method: 'POST', body: {} })); }
  catch (e) { $('#dataSyncInfo').textContent = ''; toast(explainError(e.message), true); return; }
  $('#dataSyncInfo').textContent = '';
  if (!await confirmDialog({
    title: tr('datasync.btn.reexport'),
    html: resumeApercu(apercu, tr('datasync.title.reexport')),
    confirmLabel: tr('datasync.reexport.go'),
    danger: false,
    wide: true,
  })) return;
  $('#dataSyncInfo').textContent = tr('datasync.working');
  try {
    const r = await busy(btnDataReexport, () => api('/data-sync/reexport', { method: 'POST' }));
    const n = Object.values(r.compte || {}).reduce((t2, x) => t2 + (Number(x) || 0), 0);
    $('#dataSyncInfo').textContent = tr('datasync.reexport.done', { n });
    await chargerDataSync();
  } catch (e) { $('#dataSyncInfo').textContent = ''; toast(explainError(e.message), true); }
});

const btnDataNow = $('#btnDataNow');
if (btnDataNow) btnDataNow.addEventListener('click', async () => {
  const btn = btnDataNow;
  btn.disabled = true;
  $('#dataSyncInfo').textContent = tr('datasync.working');
  try {
    await api('/data-sync/now', { method: 'POST' });
    $('#dataSyncInfo').textContent = '';
    await chargerDataSync();
    refreshStatus();   // ce que la synchro a apporté arrive à l'écran tout de suite
  } catch (e) { $('#dataSyncInfo').textContent = ''; toast(explainError(e.message), true); }
  finally { btn.disabled = false; }
});

/* LE PIED DE PAGE DIT OÙ EN EST LE PARTAGE, en trois caractères. On ne va pas dans les réglages
   pour savoir si son travail est parti : c'est la question qu'on se pose en passant, et c'est là
   qu'il faut y répondre. Trois états, et trois seulement — à jour, hors ligne (les commits sont
   locaux, rien n'est perdu), une modification à reprendre. */
async function rafraichirFooterSync() {
  const b = $('#footerSync');
  if (!b) return;
  let e = null;
  try { e = await api('/data-sync'); } catch { b.hidden = true; return; }
  dataSyncEtat = e;
  if (!e.configure) { b.hidden = true; return; }
  b.hidden = false;
  const conflits = (e.conflits || []).length;
  b.dataset.etat = conflits ? 'conflit' : (e.erreur ? 'horsligne' : 'ok');
  $('#footerSyncTxt').textContent = conflits
    ? tr('datasync.footer.conflicts', { n: conflits })
    : tr('datasync.state.counts', { up: e.enAvance, down: e.enRetard });
  /* L'INFOBULLE DU TÉMOIN DIT CE QUE LE CLIC FERA, pas seulement où l'on en est : c'est le seul
     bouton de synchro qu'on rencontre sans être venu pour ça. */
  baseBulleSync = conflits ? tr('datasync.footer.conflicts-title')
    : (e.erreur ? tr('datasync.state.error', { msg: e.erreur }) : tr('datasync.footer.tip'));
  prochainSync = e.prochain ? Date.parse(e.prochain) : 0;
  majTip(b, bulleSync());
}

/* « C'EST PARTI ? DANS COMBIEN DE TEMPS ? » — la question qu'on se pose en passant la souris sur
   le témoin, et à laquelle « Données partagées » ne répondait pas. La boucle bat côté serveur et
   sa cadence se règle : le compte à rebours vient donc de l'échéance que le serveur annonce, pas
   d'une cadence devinée ici. Il descend seconde par seconde TANT QU'ON REGARDE, et pas au-delà —
   une minuterie qui tourne pour personne est une minuterie de trop. */
let baseBulleSync = '';
let prochainSync = 0;

function bulleSync() {
  if (!prochainSync) return baseBulleSync;
  const s = Math.round((prochainSync - Date.now()) / 1000);
  return `${baseBulleSync}\n${s > 0 ? tr('datasync.footer.next', { s }) : tr('datasync.footer.next-now')}`;
}

{
  const b = $('#footerSync');
  if (b) {
    b.addEventListener('click', async () => {
      /* Un conflit se règle dans les réglages, pas ici : il demande de LIRE sa version avant de
         choisir, et un pied de page n'est pas l'endroit pour ça. */
      if (dataSyncEtat && (dataSyncEtat.conflits || []).length) {
        const onglet = $('nav button[data-tab="admin"]');
        if (onglet) onglet.click();
        const sous = $('#tab-admin button[data-sub="datasync"]');
        if (sous) sous.click();
        return;
      }
      b.disabled = true;
      try { await api('/data-sync/now', { method: 'POST' }); } catch { /* hors ligne : l'état le dira */ }
      await rafraichirFooterSync();
      refreshStatus();   // ce que la synchro a apporté arrive à l'écran tout de suite
      b.disabled = false;
    });
    /* Le compte à rebours ne bat que sous la souris (ou sous le focus clavier) : ouvrir la bulle
       arme la seconde, la quitter la désarme. */
    let batteur = null;
    const ouvrir = () => {
      majTip(b, bulleSync());
      if (!batteur) batteur = setInterval(() => majTip(b, bulleSync()), 1000);
    };
    const fermer = () => { if (batteur) clearInterval(batteur); batteur = null; };
    b.addEventListener('mouseenter', ouvrir);
    b.addEventListener('focus', ouvrir);
    b.addEventListener('mouseleave', fermer);
    b.addEventListener('blur', fermer);

    /* Même cadence que le reste du pied de page : on ne sonde pas la forge, seulement notre
       propre état, déjà calculé par la boucle du serveur. */
    setInterval(rafraichirFooterSync, 15000);
    rafraichirFooterSync();
  }
}

