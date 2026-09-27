'use strict';
/* Jenkins : le détail d'un job — paramètres, historique, console. */
// @expose jkPoserParams
/* ---------- Le détail d'un job : paramètres, historique, console ---------- */

const jkPastilleBuild = (b) => (b.building ? 'succes encours'
  : b.result === 'SUCCESS' ? 'succes' : b.result === 'UNSTABLE' ? 'instable' : b.result === 'ABORTED' ? 'jamais' : 'echec');

/* Une ligne d'historique. Elle SÉLECTIONNE (le détail s'affiche à droite) et garde son bouton
   Console : c'est le geste le plus fréquent, il ne doit pas coûter une sélection de plus. */
function jkBuildLigne(chemin, b, choisi) {
  const etat = b.building ? tr('jenkins.st.running') : (b.result || '—');
  const quand = b.timestamp ? dateHtml(new Date(b.timestamp).toISOString(), fmtDateTime(new Date(b.timestamp).toISOString())) : '';
  /* LES PARAMÈTRES SOUS LA LIGNE, ET DE LA MÊME COULEUR QUE DANS LA LISTE. C'est avec quoi
     l'exécution est partie qui distingue deux lignes autrement identiques : sans ça, retrouver
     « celle de la 1.5.2 en prod » demande de cliquer chaque ligne l'une après l'autre. La
     teinte vient du NOM (`jkTeinte`), la même partout : `ENV` a ici la couleur qu'il a dans la
     liste des jobs, et l'œil descend la colonne sans lire. Ici on colore TOUS les paramètres :
     dans l'historique d'un même job, ils reviennent tous d'une ligne à l'autre — c'est
     exactement ce que le seuil de la liste cherche à repérer. */
  const params = b.params || [];
  return `<div class="jk-build${choisi ? ' selected' : ''}">
    <div class="jk-build-l1">
      <button type="button" class="jk-build-btn" data-jkbuild="${b.number}" aria-pressed="${choisi ? 'true' : 'false'}">
        <span class="jk-dot ${jkPastilleBuild(b)}"></span>
        <strong>#${b.number}</strong>
        <span class="jk-verdict">${esc(etat)}</span>
        <span class="jk-meta">${quand}${b.duration ? ` · ${Math.round(b.duration / 1000)} s` : ''}</span>
      </button>
      <span class="jk-build-actions">
        <button type="button" class="btn btn-sm" data-jklog="${b.number}" data-jkpath="${esc(chemin)}">${esc(tr('jenkins.console'))}</button>
        <button type="button" class="btn btn-sm" data-jkreuse="${b.number}" title="${esc(tr('jenkins.reuse.title', { n: b.number }))}"><svg class="ico ico-sm"><use href="#i-copy"/></svg></button>
        <button type="button" class="btn btn-sm" data-jkrerunbuild="${b.number}" title="${esc(tr('jenkins.rerun.title-build', { n: b.number }))}"><svg class="ico ico-sm"><use href="#i-refresh"/></svg></button>
        ${/* B16 — « ce build casse une fois sur trois » : la note se prend là où on le
              constate, et la todo rouvre la fiche du job. */''}
        ${addTodoBtn('build', `${chemin}#${b.number}`, tr('notes.add-todo.build', { job: chemin, n: b.number }))}
      </span>
    </div>
    ${jkParamPastilles(params, params.map((p) => p.name))}
  </div>`;
}

// Le détail de l'exécution sélectionnée : avec quoi elle est partie, et ce qu'elle a donné.
/* Les dernières lignes de la console d'un build rouge. Un seul appel, à la demande, et le
   résultat est gardé pour la page : on revient sur le même build en comparant deux échecs. */
const cacheTail = new Map();
async function chargerTailJenkins(chemin, numero, el) {
  const cle = `${chemin}#${numero}`;
  if (!cacheTail.has(cle)) {
    cacheTail.set(cle, api(`/jenkins/console?path=${encodeURIComponent(chemin)}&build=${encodeURIComponent(numero)}`)
      .then((d) => String(d.text || '').split('\n').filter((l) => l.trim()).slice(-30).join('\n'))
      .catch(() => ''));
  }
  const texte = await cacheTail.get(cle);
  if (!el.isConnected) return;
  el.textContent = texte || tr('jenkins.build.tail-empty');
}

function jkBuildDetail(d, b) {
  if (!b) return `<p class="muted">${esc(tr('jenkins.build.pick'))}</p>`;
  const ligne = (k, v) => (v ? `<div class="jk-detail-row"><span class="jk-detail-k">${esc(k)}</span><span class="jk-detail-v">${esc(v)}</span></div>` : '');
  const params = (b.params || []).length
    ? (b.params || []).map((p) => ligne(p.name, String(p.value))).join('')
    : `<p class="muted">${esc(tr('jenkins.build.no-params'))}</p>`;
  return `<div class="jk-build-detail">
    <h4><span class="jk-dot ${jkPastilleBuild(b)}"></span>#${b.number} — ${esc(b.building ? tr('jenkins.st.running') : (b.result || '—'))} ${jkLienExterne(b.url)}</h4>
    ${ligne(tr('jenkins.build.when'), b.timestamp ? fmtDateTime(new Date(b.timestamp).toISOString()) : '')}
    ${ligne(tr('jenkins.build.duration'), b.duration ? `${Math.round(b.duration / 1000)} s` : '')}
    ${ligne(tr('jenkins.build.by'), jkAuteur(b.by))}
    ${ligne(tr('jenkins.build.ref'), b.ref || '')}
    <h4>${esc(tr('jenkins.params.used'))}</h4>
    ${params}
    ${/* LA FIN DE LA CONSOLE, POUR UN BUILD ROUGE. L'erreur se lit ici, sans ouvrir Jenkins :
          c'est la seule chose qu'on va y chercher neuf fois sur dix. Chargée à la demande —
          uniquement sur un échec, uniquement pour le build sélectionné. */''}
    ${b.result && b.result !== 'SUCCESS' && !b.building
    ? `<h4>${esc(tr('jenkins.build.tail'))}
        ${/* A/Jenkins 3 (C7) — la console se COPIE et le build s'OUVRE. On lisait l'erreur ici
              puis on la resélectionnait à la souris pour la coller à un collègue, et on
              retournait dans Jenkins à la main pour la suite. */''}
        <button type="button" class="btn btn-sm btn-ghost" data-jk-tail-copy="${b.number}" title="${esc(tr('jenkins.tail.copy'))}">${svgIco('copy')}</button>
        ${b.url ? `<a class="btn btn-sm btn-ghost" href="${esc(safeUrl(b.url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('jenkins.build.open'))}">${svgIco('external')}</a>` : ''}
      </h4><pre class="jk-tail verify-log" data-jk-tail="${b.number}">${esc(tr('ui.combo.loading'))}</pre>` : ''}
  </div>`;
}

/* Copier la console affichée : elle est déjà chargée, il n'y a rien à redemander. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-jk-tail-copy]');
  if (!b) return;
  const pre = $(`[data-jk-tail="${CSS.escape(b.dataset.jkTailCopy)}"]`);
  if (!pre) return;
  copyText(pre.textContent || '', null);
  toast(tr('jenkins.tail.copied'));
});

/* La fiche : l'historique à gauche, le détail du build choisi à droite. On sélectionne le
   plus récent d'office — c'est celui dont on vient chercher les paramètres neuf fois sur dix. */
/* UNE LISTE FERMÉE MENTIRAIT. Les valeurs proposées sont celles qu'on a VUES — celles des
   derniers lancements chargés. Une valeur parfaitement valide qui n'y figure pas (un tag plus
   ancien, un environnement rarement utilisé) serait alors impossible à demander. Le champ
   suggère donc, mais laisse taper : `input` + `datalist`, et non `select`. */
let jkListeSeq = 0;
function jkChampValeur(attr, nom, valeurs, choisie) {
  jkListeSeq += 1;
  const id = `jkdl-${jkListeSeq}`;
  return `<input list="${id}" data-${attr}="${esc(nom)}" value="${esc(choisie || '')}"
      placeholder="${esc(tr('jenkins.param.all'))}" spellcheck="false" />
    <datalist id="${id}">${valeurs.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
}

/* FILTRER L'HISTORIQUE SUR LES VALEURS DES PARAMÈTRES. « Quand est-ce parti en prod pour la
   dernière fois, et avec quelle version ? » est la question qu'on se pose devant l'historique
   d'un job de déploiement — et la lire à l'œil sur dix lignes de paramètres ne marche pas.

   Le filtrage porte sur les builds DÉJÀ chargés (les dix derniers) : aucune requête de plus, et
   on le DIT plutôt que de laisser croire qu'on cherche dans tout l'historique de Jenkins. */
function jkFiltresFiche(builds) {
  const noms = [...new Set(builds.flatMap((b) => (b.params || []).map((p) => p.name)))]
    .sort((a, b) => a.localeCompare(b));
  if (!noms.length) return '';
  return `<div class="jk-param-filtres jk-fiche-filtres">${noms.map((nom) => {
    const valeurs = [...new Set(builds.flatMap((b) => (b.params || [])
      .filter((p) => p.name === nom).map((p) => String(p.value))))].sort((a, b) => a.localeCompare(b));
    const choisie = (JENKINS.ficheFiltres || {})[nom] || '';
    return `<label class="jk-pf${choisie ? ' jk-pf-on' : ''}"><span class="jk-pf-k">${esc(nom)}</span>
      ${jkChampValeur('jkff', nom, valeurs, choisie)}</label>`;
  }).join('')}</div>`;
}

const jkBuildPasse = (b) => Object.entries(JENKINS.ficheFiltres || {})
  .filter(([, v]) => v)
  .every(([nom, valeur]) => (b.params || []).some((p) => p.name === nom && String(p.value) === valeur));

function renderJenkinsFiche() {
  const d = JENKINS.job;
  if (!d) return;
  const tous = d.builds || [];
  const builds = tous.filter(jkBuildPasse);
  /* La sélection suit le filtrage : garder à droite le détail d'une exécution qu'on ne voit
     plus à gauche laisserait lire des valeurs sans savoir d'où elles viennent. */
  if (!builds.some((b) => b.number === JENKINS.build)) JENKINS.build = builds.length ? builds[0].number : null;
  const choisi = builds.find((b) => b.number === JENKINS.build) || null;
  const filtre = builds.length !== tous.length;
  /* Le titre AVANT les filtres : une zone s'annonce, puis propose ses commandes. Les deux
     forment un en-tête qui reste collé en haut pendant qu'on descend l'historique — filtrer
     après avoir déroulé dix lignes ne doit pas demander de remonter. */
  const tete = `<div class="jk-col-head">
      <h4 class="jk-bloc-t">${esc(tr('jenkins.builds'))}${filtre ? ` <span class="muted">${esc(tr('jenkins.builds.filtered', { n: builds.length, count: builds.length, total: tous.length }))}</span>` : ''}</h4>
      ${jkFiltresFiche(tous)}
    </div>`;
  const gauche = tous.length
    ? tete + (builds.length
      ? `<div class="jk-builds">${builds.map((b) => jkBuildLigne(d.path, b, b.number === JENKINS.build)).join('')}</div>`
      : `<p class="muted jk-vide">${esc(tr('jenkins.builds.none-matching'))}</p>`)
    : `<p class="muted jk-vide">${esc(tr('jenkins.no-build'))}</p>`;
  const zone = $('#jenkinsFiche');
  if (zone) {
    zone.innerHTML = `<div class="jk-fiche-col jk-bloc jk-col-histo">${gauche}</div>`
      + `<div class="jk-fiche-col jk-bloc jk-col-detail">${jkBuildDetail(d, choisi)}</div>`;
    // La fin de la console n'est demandée QUE si le détail en montre l'emplacement.
    const tail = $('[data-jk-tail]', zone);
    if (tail && choisi) chargerTailJenkins(d.path, choisi.number, tail);
  }
}

/* REPRENDRE LES PARAMÈTRES D'UNE EXÉCUTION dans le formulaire, sans lancer. C'est le geste de
   celui qui veut repartir de ce qui a marché la dernière fois EN CHANGEANT une valeur — sinon
   « Relancer », juste à côté, suffisait. On remplit donc, et on laisse la main.

   Une valeur qui n'est plus proposée par le job (un tag supprimé depuis) est AJOUTÉE à la liste
   plutôt qu'ignorée : un pré-remplissage qui laisse le champ sur autre chose est pire que pas
   de pré-remplissage — on lancerait avec une valeur qu'on n'a pas choisie. */
/* La fiche rechargée AVEC son historique profond. On garde tout le reste tel quel — les
   paramètres saisis dans le formulaire ne doivent pas être effacés parce qu'on a filtré. */
const JK_HISTO_PROFOND = 200;
async function approfondirFiche() {
  const d = JENKINS.job;
  if (!d) return;
  try {
    const profond = await api(`/jenkins/job?path=${encodeURIComponent(d.path)}&builds=${JK_HISTO_PROFOND}`);
    JENKINS.job = { ...d, builds: profond.builds || d.builds, depth: profond.depth || JK_HISTO_PROFOND };
  } catch (e) { toast(explainError(e.message), true); }
}

/* Poser un jeu de valeurs dans le formulaire de paramètres. Une valeur qui ne fait PLUS partie
   des choix du job est ajoutée à la liste et signalée comme telle : la perdre en silence ferait
   repartir un lancement sur autre chose que ce qu'on croit relancer. */
function jkPoserParams(params) {
  let posés = 0;
  for (const p of params || []) {
    const champ = $(`#jenkinsModalBody [data-jkparam="${CSS.escape(p.name)}"]`);
    if (!champ) continue;
    const valeur = String(p.value);
    if (champ.type === 'checkbox') champ.checked = valeur === 'true';
    else if (champ.tagName === 'SELECT') {
      const voulues = champ.multiple ? valeur.split(',').map((x) => x.trim()) : [valeur];
      for (const v of voulues) {
        if (![...champ.options].some((o) => o.value === v)) champ.add(new Option(`${v} ${tr('jenkins.param.gone')}`, v));
      }
      [...champ.options].forEach((o) => { o.selected = voulues.includes(o.value); });
    } else champ.value = valeur;
    posés += 1;
  }
  return posés;
}

function jkReprendreParams(numero) {
  const d = JENKINS.job;
  const b = d && (d.builds || []).find((x) => x.number === Number(numero));
  if (!b) return;
  const repris = jkPoserParams(b.params);
  const zone = $('#jenkinsModalBody');
  if (zone) zone.scrollTop = 0;         // le formulaire est en haut de la fiche : on y remonte
  toast(repris ? tr('jenkins.reuse.done', { n: numero }) : tr('jenkins.reuse.none'), !repris);
}

