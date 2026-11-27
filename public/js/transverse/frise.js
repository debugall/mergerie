'use strict';
/* LA FRISE DU DÉROULÉ d'une session — au cockpit, sur la carte d'une session de codage et sur celle d'un codage
   sur dépôt local. Toutes les étapes, dans l'ordre (le serveur les calcule : `jobs/workflow.js`), lues par
   phases sur un rail : ce qui est fait, ce qui tourne, ce qui attend et depuis quand, ce qui viendra ; en
   pointillé, une passe qui n'aura lieu que si la note reste sous le seuil. Une vérification ouvre son
   rapport ; arrêtée sur une étape, la frise porte « Continuer ». */
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
/* ---------- LES PHASES ----------
   Une pastille par étape fait vite dix-sept pastilles au même poids : le passé crie autant que le présent. La
   frise se lit donc comme un PIPELINE : un rail, un nœud par phase — code, convergence, validation, test de
   couverture, validée —, plein jusqu'où l'on en est, en pointillé pour ce qui vient. Sous chaque nœud, ce que
   la phase a produit (la MR, la courbe des notes vers la note visée, la grille des vérificateurs) et, pour la
   phase active, son étape et depuis quand, avec « Continuer ». Le détail des étapes se déplie au clic, une
   phase à la fois, et le reste malgré le rafraîchissement. */
const PHASE_DE = { code: 'code', commit: 'code', push: 'code', mr: 'code', review: 'convergence', fix: 'convergence',
  'converge-fin': 'convergence', verif: 'validation', diag: 'validation', 'scen-ecrire': 'scenario',
  'scen-pousser': 'scenario', 'scen-lancer': 'scenario', 'scen-corriger': 'scenario', validee: 'fin' };
const GRAVITE = ['echec', 'a_toi', 'en_cours', 'en_file'];
const friseDepliees = new Map();   // `${frise}|${bande}` → la phase ouverte, choisie au clic
const friseNote = (n) => String(n).replace('.', ',');
const friseNombre = (cle, n, v) => tr(`${cle}.${n > 1 ? 'many' : 'one'}`, v);

/* « depuis 14 min » : l'heure vient du serveur (le job, la vérification, le changement d'étape), le calcul se
   refait à chaque rendu. */
function friseDepuis(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const min = Math.floor(Math.max(0, Date.now() - t) / 60000);
  let d;
  if (min < 1) d = tr('cockpit.wf.dur.lt1');
  else if (min < 60) d = tr('cockpit.wf.dur.min', { n: min });
  else if (min < 1440) d = tr('cockpit.wf.dur.h', { h: Math.floor(min / 60), m: String(min % 60).padStart(2, '0') });
  else d = tr('cockpit.wf.dur.j', { n: Math.floor(min / 1440) });
  return tr('cockpit.wf.since', { d });
}

/* L'HORLOGE DES ANIMATIONS. Les listes se redessinent toutes les quelques secondes : un arc qui tourne ou un
   nœud qui respire repartirait de zéro à chaque fois, d'un à-coup. Le retard négatif, calé sur l'heure, fait
   reprendre chaque animation là où l'ancienne en était. À appeler juste avant d'écrire la liste. */
// Les durées (1,2 s, 2,4 s) divisent 2,4 s : une seule phase pour toutes.
function friseHorloge() {
  document.documentElement.style.setProperty('--frise-t', `${-(Date.now() % 2400) / 1000}s`);
}

/* L'état d'une phase : la plus grave de ses étapes actives ; sinon faite, à venir, ou commencée. */
function etatPhase(items) {
  for (const g of GRAVITE) if (items.some(([e]) => e.etat === g)) return g;
  const etats = items.filter(([e]) => !e.si).map(([e]) => e.etat);
  if (etats.every((x) => x === 'fait' || x === 'saute')) return 'fait';
  if (etats.every((x) => x === 'a_venir')) return 'a_venir';
  return 'en_cours';
}
function titrePhase(cle, items) {
  if (cle !== 'code') return tr(`cockpit.wf.phase.${cle}`);
  const cles = new Set(items.map(([e]) => e.cle));
  if (cles.has('mr')) return tr('cockpit.wf.phase.code-mr');
  return tr(cles.has('push') ? 'cockpit.wf.phase.code-push' : 'cockpit.wf.phase.code');
}
/* Les étapes regroupées en phases, dans l'ordre : `[{ cle, items, etat }]`. */
function phasesDe(items) {
  const phases = [];
  for (const it of items) {
    const cle = PHASE_DE[it[0].cle] || 'code';
    const der = phases[phases.length - 1];
    if (der && der.cle === cle) der.items.push(it); else phases.push({ cle, items: [it] });
  }
  for (const ph of phases) ph.etat = etatPhase(ph.items);
  return phases;
}
/* L'étape active d'une convergence, dite par sa passe : « passe 3/3 · correction », ou « review initiale ». */
function nomConvergence(e) {
  if (e.cle === 'review' && !e.n) return tr('cockpit.wf.review-0');
  if (e.cle === 'converge-fin') return tr('cockpit.wf.converge-fin');
  return tr('cockpit.wf.phase.pass', { n: e.n, max: e.max || e.n, quoi: tr(`cockpit.wf.phase.${e.cle}-short`) });
}

/* La courbe des notes, la note visée en pointillé : d'où l'on part, où l'on va, ce qu'il manque. */
function friseCourbe(notes, seuil) {
  if (notes.length < 2) return '';
  const W = 96; const H = 30; const P = 3;
  const vals = notes.concat(seuil != null ? [seuil] : []);
  const bas = Math.max(0, Math.floor(Math.min(...vals) - 0.5));
  const haut = Math.min(10, Math.ceil(Math.max(...vals) + 0.5));
  const x = (i) => (P + (i * (W - 2 * P)) / (notes.length - 1)).toFixed(1);
  const y = (v) => (H - P - ((v - bas) / (haut - bas || 1)) * (H - 2 * P)).toFixed(1);
  const pts = notes.map((n, i) => `${x(i)},${y(n)}`).join(' ');
  const label = `${notes.map(friseNote).join(' → ')}${seuil != null ? ` · ${tr('cockpit.wf.phase.goal', { seuil: friseNote(seuil) })}` : ''}`;
  const der = notes.length - 1;
  return `<svg class="frise-courbe" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>
    ${seuil != null ? `<line class="frise-courbe-cible" x1="0" x2="${W}" y1="${y(seuil)}" y2="${y(seuil)}"/>` : ''}
    <polygon class="frise-courbe-aire" points="${x(0)},${H} ${pts} ${x(der)},${H}"/><polyline points="${pts}"/>
    <circle cx="${x(der)}" cy="${y(notes[der])}" r="2.6"/></svg>`;
}

/* La validation se lit en grille : un vérificateur par ligne, une case par côté (base, branche) et son
   diagnostic, sous un en-tête qui les nomme. Chaque case dit son état par une icône — pas par la seule
   couleur — et ouvre son rapport d'un clic. Pas encore partie, elle nomme déjà les vérificateurs. */
function grilleVerifs(items) {
  const noms = [...new Set(items.filter(([e]) => e.cle === 'verif').map(([e]) => e.nom))];
  const diags = items.some(([e]) => e.cle === 'diag');
  if (!noms.length) return '';
  const caseHtml = (e, quoi) => {
    const label = `${e.nom} — ${quoi} — ${tr(`cockpit.wf.etat.${e.etat}`)}`;
    const lien = e.verification_id ? ` data-chaine-verif="${e.verification_id}" role="button" tabindex="0"` : '';
    return `<span class="frise-case is-${esc(e.etat)}" title="${esc(label)}" aria-label="${esc(label)}"${lien}>${FRISE_ICONE[e.etat] ? svgIco(FRISE_ICONE[e.etat]) : '<span class="frise-point"></span>'}</span>`;
  };
  const vide = '<span class="frise-case is-vide" aria-hidden="true"></span>';
  const tete = `<span class="frise-grille-l frise-grille-tete" aria-hidden="true"><span class="frise-grille-nom"></span>
    <span class="frise-grille-col">${esc(tr('task.chaine.base'))}</span><span class="frise-grille-col">${esc(tr('task.chaine.head'))}</span>${diags ? `<span class="frise-grille-col">${esc(tr('cockpit.wf.grid.diag'))}</span>` : ''}</span>`;
  return `<span class="frise-grille${diags ? ' avec-diag' : ''}">${tete}${noms.map((n) => {
    const cote = (c) => items.find(([e]) => e.cle === 'verif' && e.nom === n && (e.cote || 'head') === c);
    const diag = items.find(([e]) => e.cle === 'diag' && e.nom === n);
    const cases = ['base', 'head'].map((c) => { const it = cote(c); return it ? caseHtml(it[0], tr(`task.chaine.${c}`)) : vide; }).join('');
    return `<span class="frise-grille-l"><span class="frise-grille-nom" title="${esc(n)}">${esc(n)}</span>${cases}${diags ? (diag ? caseHtml(diag[0], tr('cockpit.wf.grid.diag')) : vide) : ''}</span>`;
  }).join('')}</span>`;
}
/* La MR ouverte, en lien sur la phase Code : c'est l'objet qu'on vient chercher. */
function lienMr(items) {
  const it = items.find(([e]) => e.mr_url && e.mr_iid);
  return it ? `<a class="frise-mr" href="${esc(safeUrl(it[0].mr_url))}" target="_blank" rel="noopener" title="${esc(tr('cockpit.wf.phase.mr-title'))}">!${esc(String(it[0].mr_iid))}${svgIco('external')}</a>` : '';
}
/* Le statut de l'étape active : une pastille teintée, « à toi · depuis 14 min ». */
function statutHtml(e) {
  const texte = [tr(`cockpit.wf.etat.${e.etat}`), e.depuis ? friseDepuis(e.depuis) : ''].filter(Boolean).join(' · ');
  return `<span class="frise-statut is-${esc(e.etat)}">${esc(texte)}</span>`;
}
const friseMeta = (texte, cls = '') => (texte ? `<span class="frise-meta${cls}" title="${esc(texte)}">${esc(texte)}</span>` : '');

/* Sous le nom d'une phase : ce qu'elle a produit, puis — active — son étape, son statut et sa raison. */
function corpsPhase(ph) {
  const { cle, items, etat } = ph;
  const actif = items.find(([e]) => GRAVITE.includes(e.etat));
  const a = actif ? actif[0] : null;
  const out = [];
  // L'étape active, nommée — sauf quand elle porte le nom de sa phase (« Codage » sous « Codage ») —, son statut, sa raison.
  const etapeActive = (nom) => {
    if (!a) return;
    if (nom && nom !== titrePhase(cle, items)) out.push(friseMeta(nom));
    out.push(statutHtml(a));
    const raison = (a.etat === 'echec' || a.etat === 'a_toi') && a.detail && a.cle !== 'diag' ? friseDetail(a) : '';
    if (raison) out.push(friseMeta(raison, ' frise-raison'));
  };
  if (cle === 'code') {
    out.push(lienMr(items));
    etapeActive(a ? friseLibelle(a, { sansProjet: true }) : '');
  } else if (cle === 'convergence') {
    const notes = items.filter(([e]) => e.cle === 'review' && e.note != null).map(([e]) => Number(e.note));
    const seuil = (items.find(([e]) => e.seuil != null) || [{}])[0].seuil;
    const max = (items.find(([e]) => e.max != null) || [{}])[0].max;
    const fin = items.find(([e]) => e.cle === 'converge-fin');
    if (notes.length) {
      out.push(`<span class="frise-score-l"><span class="frise-score">${esc(friseNote(notes[notes.length - 1]))}</span>
        ${seuil != null ? `<span class="frise-score-cible">${esc(tr('cockpit.wf.phase.goal', { seuil: friseNote(seuil) }))}</span>` : ''}${friseCourbe(notes, seuil)}</span>`);
    } else if (seuil != null) out.push(friseMeta(tr('cockpit.wf.phase.target', { seuil: friseNote(seuil), max })));
    if (a) etapeActive(nomConvergence(a));
    else if (fin && fin[0].detail) out.push(friseMeta(tr(`cockpit.wf.fin.${fin[0].detail}`)));
  } else if (cle === 'validation') {
    if (a) etapeActive(friseLibelle(a, { sansProjet: true }));
    out.push(grilleVerifs(items));
  } else if (cle === 'scenario') {
    const couvert = items.find(([e]) => e.cle === 'scen-ecrire' && e.etat === 'fait' && items.some(([x]) => x.etat === 'saute'));
    const ou = items.find(([e]) => e.projet);
    out.push(friseMeta(couvert ? tr('cockpit.wf.phase.covered') : (ou ? tr('cockpit.wf.in', { projet: ou[0].projet }) : '')));
    etapeActive(a ? friseLibelle(a, { sansProjet: true }) : '');
  }
  return out.filter(Boolean).join('');
}
/* Le compte d'une validation à côté de son nom : « 1/3 » vérificateurs verts. */
function comptePhase(ph) {
  if (ph.cle !== 'validation') return '';
  const noms = [...new Set(ph.items.filter(([e]) => e.cle === 'verif').map(([e]) => e.nom))];
  if (!noms.length) return '';
  const verts = noms.filter((n) => ph.items.filter(([e]) => e.cle === 'verif' && e.nom === n).every(([e]) => e.etat === 'fait')).length;
  const titre = friseNombre('cockpit.wf.phase.verifiers', verts, { n: verts, total: noms.length });
  return `<span class="frise-compte" title="${esc(titre)}" aria-label="${esc(titre)}">${verts}/${noms.length}</span>`;
}
function noeudHtml(etat, numero) {
  let dedans = `<span class="frise-noeud-n">${numero}</span>`;
  if (etat === 'en_cours') dedans = '<span class="frise-noeud-coeur"></span>';
  else if (FRISE_ICONE[etat]) dedans = svgIco(FRISE_ICONE[etat]);
  return `<span class="frise-noeud" aria-hidden="true">${dedans}</span>`;
}

/* LES FRISES D'UNE SESSION À PLUSIEURS DÉPÔTS : une par dépôt (ou dossier), chacune entière — son code, sa
   convergence, et la validation qui le concerne (le serveur range chaque étape de la chaîne dans les dépôts
   que son vérificateur couvre : `cibles`). Ce qui n'est d'aucun dépôt reste commun. */
function groupesParCible(wf) {
  const parCible = new Map();
  wf.etapes.forEach((e) => {
    if (e.cible != null && !parCible.has(e.cible)) parCible.set(e.cible, { cible: e.cible, nom: e.projet || '', items: [] });
  });
  const communes = [];
  wf.etapes.forEach((e, i) => {
    if (e.cible != null) parCible.get(e.cible).items.push([e, i]);
    else if (e.cibles && e.cibles.some((c) => parCible.has(c))) e.cibles.forEach((c) => { if (parCible.has(c)) parCible.get(c).items.push([e, i]); });
    else communes.push([e, i]);
  });
  return { groupes: [...parCible.values()], communes };
}

/* `s` : `{ id, kind: 'code' | 'local', workflow }`. Sur une carte à plusieurs dépôts, la frise se range :
   `cible` (l'id d'un projet ou d'un dossier) rend la frise entière de cette ligne, sous elle dans « Replier
   les projets » ; `commun` rend, au-dessus, un aperçu d'une ligne par dépôt — tant que les lignes sont
   repliées — et « Continuer ». Sans option : tout, une frise par dépôt — le cockpit, qui n'a pas de lignes
   de dépôts. « Continuer » se pose sous la phase arrêtée. */
function friseHtml(s, { cible = null, commun = false } = {}) {
  const wf = s && s.workflow;
  if (!wf || !wf.etapes || !wf.etapes.length) return '';
  const pastille = (e, i, sansProjet) => {
    const detail = friseDetail(e);
    const titre = `${tr(`cockpit.wf.etat.${e.etat}`)}${e.si ? ` — ${tr('cockpit.wf.si')}` : ''}${detail ? ` — ${detail}` : ''}${e.depuis ? ` — ${friseDepuis(e.depuis)}` : ''}`;
    const lien = e.verification_id ? ` data-chaine-verif="${e.verification_id}" role="button" tabindex="0"` : '';
    return `<li class="frise-etape is-${esc(e.etat)}${e.si ? ' is-si' : ''}${i === wf.courante ? ' is-courante' : ''}" title="${esc(titre)}"${lien}>
      <span class="frise-ico">${FRISE_ICONE[e.etat] ? svgIco(FRISE_ICONE[e.etat]) : '<span class="frise-point"></span>'}</span>
      <span class="frise-txt"><span class="frise-nom">${esc(friseLibelle(e, { sansProjet }))}</span>${detail ? `<span class="frise-detail">${esc(detail)}</span>` : ''}</span>
    </li>`;
  };
  // Arrêtée sur une étape : « Continuer » fait repartir le déroulé (une question, elle, ouvre la session).
  const k = wf.continuer;
  const continuer = k ? `<button type="button" class="btn btn-sm btn-primary frise-continuer" data-frise-continuer="${s.id}" data-kind="${esc(s.kind || 'code')}" data-action="${esc(k.action)}"
      data-targets="${esc((k.targets || []).join(','))}" title="${esc(tr(`cockpit.wf.continue.${k.action}`))}">
      <svg class="ico"><use href="#i-${k.action === 'repondre' ? 'inbox' : 'play'}"/></svg>${esc(tr(k.action === 'repondre' ? 'cockpit.wf.answer' : 'cockpit.wf.continue'))}</button>` : '';
  let continuerPose = false;
  /* Une bande : le rail des phases, puis le détail de la phase ouverte. `ref` distingue les bandes d'une même
     frise ; la première qui porte l'étape arrêtée reçoit « Continuer », sous cette phase. */
  const racine = `${s.kind || 'code'}-${s.id}`;
  const bande = (items, sansProjet, ref, { avecContinuer = true } = {}) => {
    const phases = phasesDe(items);
    const cleB = `${racine}|${ref}`;
    const ouverte = friseDepliees.get(cleB);
    const puces = phases.map((ph, n) => {
      ph.cleP = `${ph.cle}|${n}`;
      ph.ouverte = ouverte === ph.cleP;
      ph.idD = `frise-d-${racine}-${ref}-${n}`.replace(/[^\w-]/g, '_');
      const courante = ph.items.some(([, i]) => i === wf.courante);
      const suivante = phases[n + 1];
      let bout = '';
      if (avecContinuer && courante && continuer && !continuerPose) { bout = continuer; continuerPose = true; }
      const corps = corpsPhase(ph) + bout;
      const cls = [`is-${ph.etat}`, `ph-${ph.cle}`, ph.cle === 'fin' ? 'is-terminus' : '', ph.ouverte ? 'is-ouverte' : '',
        courante ? 'is-courante' : '', suivante ? `suivi-${suivante.etat}` : ''].filter(Boolean).map(esc).join(' ');
      return `<div class="frise-phase ${cls}" data-frise-phase="${esc(ph.cleP)}">
        <button type="button" class="frise-phase-tete" data-frise-bascule="${esc(ph.cleP)}" aria-expanded="${ph.ouverte}" aria-controls="${esc(ph.idD)}" title="${esc(tr('cockpit.wf.phase.toggle'))}">
          ${noeudHtml(ph.etat, n + 1)}<span class="frise-phase-nom"><span class="frise-nom">${esc(titrePhase(ph.cle, ph.items))}</span>${comptePhase(ph)}<svg class="ico frise-chevron"><use href="#i-down"/></svg></span>
        </button>${corps ? `<div class="frise-corps">${corps}</div>` : ''}
      </div>`;
    }).join('');
    const details = phases.map((ph) => `<ol class="frise-etapes" id="${esc(ph.idD)}" data-frise-detail="${esc(ph.cleP)}" aria-label="${esc(titrePhase(ph.cle, ph.items))}"${ph.ouverte ? '' : ' hidden'}>${ph.items.map(([e, i]) => pastille(e, i, sansProjet)).join('')}</ol>`).join('');
    return `<div class="frise-bande" data-frise-bande="${esc(cleB)}"><div class="frise-phases">${puces}</div>${details}</div>`;
  };
  if (cible != null) {
    const siennes = wf.etapes.map((e, i) => [e, i]).filter(([e]) => e.cible === cible || (e.cibles || []).includes(cible));
    return siennes.length ? `<div class="frise frise-cible" data-frise-cible="${esc(String(cible))}">
      ${bande(siennes, true, `c${cible}`, { avecContinuer: false })}</div>` : '';
  }
  const { groupes, communes } = groupesParCible(wf);
  const groupeHtml = (nom, cleG, items, ref) => `<div class="frise-groupe" data-frise-groupe="${esc(cleG)}">
      <div class="frise-groupe-nom">${svgIco(s.kind === 'local' ? 'doc' : 'branch')}<span>${esc(nom)}</span></div>
      ${bande(items, true, ref)}
    </div>`;
  // Rendu à la demande : une bande rendue pose « Continuer », une bande calculée pour rien le volerait.
  const communesHtml = () => (communes.length ? groupeHtml(tr('cockpit.wf.group.common'), '', communes, 'commun') : '');
  let corps;
  if (commun) corps = (groupes.length > 1 ? apercuHtml(groupes) : '') + communesHtml();
  else if (groupes.length > 1) corps = groupes.map((g) => groupeHtml(g.nom, g.nom, g.items, `g${g.cible}`)).join('') + communesHtml();
  else corps = bande(wf.etapes.map((e, i) => [e, i]), false, 'tout');
  // L'étape arrêtée n'est sous aucune phase rendue ici (elle est sur la ligne de son dépôt) : « Continuer » seul.
  const seul = continuer && !continuerPose ? `<div class="frise-ou">${continuer}</div>` : '';
  if (commun && !corps && !seul) return '';
  return `<div class="frise" data-frise="${esc(s.kind || 'code')}-${s.id}">${corps}${seul}</div>`;
}

/* L'APERÇU d'une carte à plusieurs dépôts, lignes repliées : une ligne par dépôt — son nom, ses phases en
   points sur un rail, la phase où il en est. Les lignes dépliées portent la frise entière : l'aperçu
   s'efface (CSS, `:has`). */
function apercuHtml(groupes) {
  return `<div class="frise-apercu">${groupes.map((g) => {
    const phases = phasesDe(g.items);
    const ici = phases.find((ph) => GRAVITE.includes(ph.etat)) || phases.find((ph) => ph.etat !== 'fait') || phases[phases.length - 1];
    const actif = ici.items.find(([e]) => GRAVITE.includes(e.etat));
    const points = phases.map((ph) => `<span class="frise-mini-p is-${esc(ph.etat)}${ph === ici ? ' is-ici' : ''}" title="${esc(`${titrePhase(ph.cle, ph.items)} — ${tr(`cockpit.wf.etat.${ph.etat}`)}`)}"></span>`).join('');
    return `<div class="frise-apercu-l"><span class="frise-apercu-nom" title="${esc(g.nom)}">${esc(g.nom)}</span>
      <span class="frise-mini" aria-hidden="true">${points}</span>
      <span class="frise-apercu-ici"><span class="frise-apercu-phase">${esc(titrePhase(ici.cle, ici.items))}</span>${actif ? statutHtml(actif[0]) : (ici.etat === 'fait' ? '' : `<span class="frise-meta">${esc(tr(`cockpit.wf.etat.${ici.etat}`))}</span>`)}</span>
    </div>`;
  }).join('')}</div>`;
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

/* Déplier une phase, une seule à la fois par bande : ouvrir l'une referme l'autre, et le choix tient au
   rafraîchissement (la liste se redessine toutes les quelques secondes). Le détail glisse à l'ouverture
   seulement — pas à chaque rafraîchissement. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-frise-bascule]');
  if (!b) return;
  const bande = b.closest('.frise-bande');
  if (!bande) return;
  const cle = b.dataset.friseBascule;
  const ouvrir = b.getAttribute('aria-expanded') !== 'true';
  friseDepliees.set(bande.dataset.friseBande, ouvrir ? cle : null);
  bande.querySelectorAll('[data-frise-bascule]').forEach((x) => {
    const ici = ouvrir && x.dataset.friseBascule === cle;
    x.setAttribute('aria-expanded', String(ici));
    x.closest('.frise-phase').classList.toggle('is-ouverte', ici);
  });
  bande.querySelectorAll('[data-frise-detail]').forEach((d) => {
    d.hidden = !(ouvrir && d.dataset.friseDetail === cle);
    d.classList.toggle('vient-de-souvrir', !d.hidden);
  });
});
// Au clavier, une case de la grille ou une étape qui ouvre son rapport s'active comme un bouton.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const c = e.target.closest && e.target.closest('.frise [data-chaine-verif]');
  if (!c) return;
  e.preventDefault();
  c.click();
});
