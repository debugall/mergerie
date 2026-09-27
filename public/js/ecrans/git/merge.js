'use strict';
/* Git · Merge de branche à branche (onglet Git → Merge). */
// @expose mergeMemoriser
/* ============ Git · Merge de branche à branche (onglet Git → Merge) ============
 *
 * L'écran de conflits est le cœur : il doit se comprendre sans mode d'emploi. Le parti pris est
 * de ne JAMAIS montrer un fichier entier avec des marqueurs `<<<<<<<` à déchiffrer. On montre,
 * conflit par conflit, les deux versions face à face, chacune avec son bouton « Garder ». Trois
 * lignes de contexte de part et d'autre situent le passage sans noyer l'écran.
 *
 * Qui assemble quoi : les boutons envoient des CHOIX au serveur, qui recolle (`gitmerge.recoller`).
 * L'écran calcule bien un aperçu, mais pour l'AFFICHER seulement — la version qui part sur le
 * disque est toujours celle du serveur. L'édition à la main, elle, envoie le texte.
 */
let mergeEtat = null;              // état du merge ouvert
let mergeFichier = null;           // { path, morceaux, choix: [], edite: bool, texte }
/* « Demander à l'IA » porte sur TOUT le merge (voir plus bas), pas sur le fichier ouvert : son
   état de progression doit donc survivre au re-rendu de `merge-head`, qui arrive à chaque
   changement de fichier ou de choix — un état LOCAL à ce bloc serait perdu à chaque fois. */
let mergeAiEnCours = false;
/* …ET SURVIVRE PROPREMENT À UN CHANGEMENT DE MERGE PENDANT L'ATTENTE. Abandonner le merge A
   avec une demande encore en vol, puis ouvrir B et en lancer une autre : la réponse tardive de
   A ne doit pas effacer le drapeau « en cours » de B. Un jeton par demande, comparé à la fin :
   seule la DERNIÈRE lancée a le droit de toucher au drapeau global. */
let mergeAiGen = 0;

const mergeRefsCache = new Map();  // repoId -> [{ value, label }]
/* …ET SON OUBLI. Le cache n'était jamais vidé : après un merge poussé ou une branche créée
   depuis l'onglet Git, les listes de Merge proposaient encore l'état d'avant — une branche
   qu'on venait de supprimer restait choisissable, une branche neuve n'apparaissait pas. Les
   refs de l'onglet Git, elles, étaient déjà oubliées après `gitExecute` ; on suit la même
   règle : ce qui fait bouger les refs vide les deux. */
function oublierRefs() { gitRefsCache = {}; mergeRefsCache.clear(); }
async function mergeRefs(repoId) {
  if (!repoId) return [];
  if (mergeRefsCache.has(repoId)) return mergeRefsCache.get(repoId);
  const d = await api(`/git/refs?repo_id=${repoId}&kind=branch`);
  const opts = (d.refs || []).map((r) => ({ value: r.name, label: r.name, hint: r.default ? tr('git.refs.default-suffix') : '' }));
  mergeRefsCache.set(repoId, opts);
  return opts;
}
const mergeRepoId = () => Number(($('#mergeRepoBox .rc-id') || {}).value || 0);

/* Les trois choix passent par des combos AVEC RECHERCHE : un dépôt actif compte des centaines
   de branches, et `npm run check` refuse une liste de refs sans champ de recherche. */
/* A/Git 1 — MERGE SE SOUVIENT, comme *Comparer* le fait déjà. Trois sous-onglets voisins et
   deux politiques de mémoire, c'était la seule raison de retaper `develop → main` sur le même
   dépôt tous les matins. Mémoire de navigateur : la perdre ne perd qu'une proposition. */
const MERGE_FORM_MEMO = 'aidevtools_merge_form_memo';   // ≠ MERGE_MEMO, qui retient squash/suppression PAR DÉPÔT
const mergeMemo = () => { try { return JSON.parse(localStorage.getItem(MERGE_FORM_MEMO) || '{}'); } catch { return {}; } };
const mergeMemoriser = (etat) => {
  try { localStorage.setItem(MERGE_FORM_MEMO, JSON.stringify(etat)); } catch { /* stockage indisponible */ }
};

function mergeRenderPickers() {
  const rb = $('#mergeRepoBox'); if (!rb) return;
  const memo = mergeMemo();
  const repo = mergeRepoId() || Number(memo.repo_id) || null;
  rb.innerHTML = repoComboHtml(repo, { idClass: 'merge-repo' });
  /* Les branches ne sont reproposées QUE pour le dépôt qui les a vues : une branche d'un autre
     dépôt donnerait un formulaire qui a l'air valide et une erreur au lancement. */
  const meme = repo && Number(memo.repo_id) === Number(repo);
  $('#mergeSourceBox').innerHTML = comboHtml('merge-source', {
    ph: tr('git.merge.ph-branch'), value: meme ? (memo.source || '') : '', label: meme ? (memo.source || '') : '' });
  $('#mergeTargetBox').innerHTML = comboHtml('merge-target', {
    ph: tr('git.merge.ph-branch'), value: meme ? (memo.target || '') : '', label: meme ? (memo.target || '') : '' });
  wireRepoCombos($('#gsub-merge'));
  wireCombo($('#gsub-merge'), 'merge-source', () => mergeRefs(mergeRepoId()));
  wireCombo($('#gsub-merge'), 'merge-target', () => mergeRefs(mergeRepoId()));
}

/* Changer de dépôt vide les deux branches : garder « main » d'un autre dépôt donnerait un
   formulaire qui a l'air valide et une erreur au lancement. */
document.addEventListener('change', (e) => {
  if (!e.target.classList || !e.target.classList.contains('merge-repo')) return;
  for (const cls of ['merge-source', 'merge-target']) {
    const h = $(`.${cls}`, $('#gsub-merge')); const vis = $(`[data-combo="${cls}"]`, $('#gsub-merge'));
    if (h) { h.value = ''; h.dataset.label = ''; }
    if (vis) vis.value = '';
  }
});

async function mergeLoad() {
  mergeRenderPickers();
  await mergeRenderRunning();
}

/** Les merges non soldés : on peut en reprendre un, ou l'abandonner. */
async function mergeRenderRunning() {
  const box = $('#mergeRunning'); if (!box) return;
  let liste = [];
  try { liste = await api('/git/merges'); } catch { liste = []; }
  if (!liste.length) { box.innerHTML = ''; if (!mergeEtat) $('#mergeWork').hidden = true; return; }
  box.innerHTML = `<div class="box merge-running"><h4>${esc(tr('git.merge.running'))}</h4>${liste.map((m) => `
    <div class="merge-run-row">
      <span><strong>${esc(m.project)}</strong> <code>${esc(m.source_branch)}</code> → <code>${esc(m.target_branch)}</code>
      <span class="tag ${m.status === 'conflict' ? 'stale' : 'reviewed'}">${esc(tr(`git.merge.status.${m.status}`))}</span>
      ${/* A31 — CE QU'ON RATTRAPE. On arrive ici depuis le badge « en conflit » d'une merge
            request : sans son numéro, sa note et son ticket, on résout trente conflits sans
            plus savoir pour quoi. La puce ouvre le rapport. */''}
      ${m.mr ? `<button type="button" class="lien-reglage" data-merge-mr="${m.mr.id}" title="${esc(m.mr.title)}">!${esc(String(m.mr.iid))}</button>
        ${m.mr.note != null ? noteBadge(m.mr.note) : ''}
        ${m.mr.ticket ? `<span class="tag">${esc(m.mr.ticket)}</span>` : ''}` : ''}
      ${/* …et le diff de ce qui a été commité : `commit_sha` était stocké et relu par personne,
            alors que c'est la seule façon de vérifier ce qu'on vient d'assembler. */''}
      ${m.commit_sha ? `<button type="button" class="lien-reglage" data-merge-diff="${m.id}" title="${esc(tr('git.merge.diff-title'))}">${esc(tr('git.merge.diff', { sha: String(m.commit_sha).slice(0, 8) }))}</button>` : ''}</span>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" data-mopen="${m.id}">${esc(tr('git.merge.resume'))}</button>
      <button class="btn btn-sm btn-danger" data-mdrop="${m.id}">${esc(tr('git.merge.abandon'))}</button>
    </div>`).join('')}</div>`;
  $$('#mergeRunning [data-merge-mr]').forEach((b) => b.addEventListener('click', () => navMrReport(Number(b.dataset.mergeMr))));
  $$('#mergeRunning [data-merge-diff]').forEach((b) => b.addEventListener('click', () => ouvrirDiffMerge(Number(b.dataset.mergeDiff))));
}

async function mergeOuvrir(id) {
  mergeEtat = await api(`/git/merges/${id}`);
  mergeFichier = null;
  mergeAiEnCours = false; mergeAiGen += 1;   // un autre merge, sans lien avec une éventuelle demande passée
  const premier = mergeEtat.conflits[0];
  if (premier) await mergeOuvrirFichier(premier); else mergeRenderWork();
}

/* Le fichier ouvert : ses morceaux, et un choix par conflit. « ours » d'office — la destination
   est ce qui existe déjà, c'est le repli le moins surprenant, et chaque conflit reste à
   confirmer avant que le fichier ne soit marqué résolu. */
async function mergeOuvrirFichier(chemin) {
  const d = await api(`/git/merges/${mergeEtat.id}/file?path=${encodeURIComponent(chemin)}`);
  const nb = d.morceaux.filter((m) => m.type === 'conflit').length;
  mergeFichier = {
    path: chemin, morceaux: d.morceaux, texte: d.texte, choix: Array(nb).fill('ours'), edite: false,
    dates: d.dates || {},
    /* Une demande précédente peut déjà avoir une réponse : `propositions[n]` porte
       `{ texte, raison }` pour le n-ième conflit, absent (`undefined`) là où l'agent n'a rien
       proposé. `raisonsOuvertes` ne mémorise que ce qu'on a DÉPLIÉ à l'écran — jamais envoyé au
       serveur, jamais reçu de lui. */
    propositions: d.propositions || [],
    raisonsOuvertes: {},
  };
  mergeRenderWork();
}

/* CE QUE CETTE PROPOSITION VAUT COMME CHOIX. Le texte ne voyage qu'une fois : l'écran le
   reçoit avec le fichier, et le rejoue localement pour l'aperçu — c'est le SERVEUR qui
   résout « ia » en ce même texte au moment d'enregistrer (`gitmerge.resoudre`), jamais
   l'écran qui le lui redonnerait. */
const mergeLignesChoisies = (m, c, n) => {
  // `!= null` : une proposition absente revient `null` (jamais `undefined`) une fois passée
  // par le fichier — `null.split` planterait le rendu sur le conflit suivant, pas seulement
  // celui-là, puisque `mergeApercu`/`mergeFullColonne` s'arrêteraient à la première exception.
  if (c === 'ia' && mergeFichier.propositions[n] != null) return mergeFichier.propositions[n].texte.split('\n');
  return c === 'theirs' ? m.theirs : c === 'deux' ? [...m.ours, ...m.theirs] : m.ours;
};
const mergeApercu = () => {
  /* AFFICHAGE SEULEMENT. Ce que le serveur écrira vient de `gitmerge.recoller`, à qui l'on
     envoie les choix : deux assembleurs finiraient par ne plus dire la même chose. */
  let n = 0;
  return mergeFichier.morceaux.map((m) => {
    if (m.type === 'stable') return m.lignes.join('\n');
    const c = mergeFichier.choix[n];
    const lignes = mergeLignesChoisies(m, c, n);
    n += 1;
    return lignes.join('\n');
  }).join('\n');
};

function mergeRenderWork() {
  const box = $('#mergeWork'); if (!box) return;
  if (!mergeEtat) { box.hidden = true; return; }
  box.hidden = false;
  const e = mergeEtat;
  const reste = e.conflits.length;
  const fini = e.status === 'committed' || e.status === 'pushed';
  box.innerHTML = `
    <div class="box merge-head">
      <div>
        <strong>${esc(e.project)}</strong> — <code>${esc(e.source_branch)}</code> → <code>${esc(e.target_branch)}</code>
        ${/* A31 — CE QU'ON RATTRAPE. On arrive ici depuis un badge « en conflit » : sans ce
              rappel, on résout des conflits sans plus savoir sur quelle merge request. */''}
        ${e.mr ? `${e.mr.url ? `<a href="${esc(safeUrl(e.mr.url))}" target="_blank" rel="noopener noreferrer" class="tag">!${e.mr.iid} ↗</a>` : `<span class="tag">!${e.mr.iid}</span>`}
          ${e.mr.note != null ? noteBadge(Math.round(e.mr.note * 1000) / 100) : ''}
          ${e.mr.ticket ? `<span class="tag">${esc(e.mr.ticket)}</span>` : ''}
          <span class="muted">${esc(String(e.mr.title || '').slice(0, 60))}</span>` : ''}
        <span class="tag ${reste ? 'stale' : 'done'}">${esc(reste
    ? tr('git.merge.left', { n: reste, count: reste })
    : tr(`git.merge.status.${e.status}`))}</span>
        ${/* LE COMMIT DE FUSION, une fois qu'il existe. Il était écrit en base et jamais montré :
             après un merge résolu à la main, rien à l'écran ne permettait de retrouver l'objet
             qu'on venait de fabriquer — ni pour un `git show`, ni pour un message d'incident. */''}
        ${e.commit_sha ? `<button type="button" class="muted git-sha git-sha-copy" data-copy-txt="${esc(e.commit_sha)}" title="${esc(tr('git.copy-sha'))}">${esc(String(e.commit_sha).slice(0, 8))}</button>` : ''}
      </div>
      <div class="spacer"></div>
      ${/* « DEMANDER À L'IA » PORTE SUR TOUT LE MERGE, EN UN SEUL APPEL — jamais fichier par
            fichier : proposer pour `a.txt` sans savoir que `b.txt` renomme la même fonction
            donnerait deux résolutions cohérentes chacune pour soi, incohérentes ensemble.
            N'apparaît que s'il reste des conflits à résoudre. */''}
      ${reste ? (mergeAiEnCours
    ? `<span class="muted" id="mergeAiStatus"><span class="spin"></span> ${esc(tr('git.merge.ai.running'))}</span>`
    : `<button class="btn btn-sm" id="mergeAiPropose" title="${esc(tr('git.merge.ai.button-title'))}"><svg class="ico"><use href="#i-bot"/></svg>${esc(tr('git.merge.ai.button'))}</button>`) : ''}
      ${fini ? '' : `<button class="btn btn-danger" id="mergeAbandon">${esc(tr('git.merge.abandon'))}</button>`}
      ${e.status === 'ready' ? `<button class="btn btn-primary" id="mergeCommit"><svg class="ico"><use href="#i-save"/></svg>${esc(tr('git.merge.commit.go'))}</button>` : ''}
      ${e.status === 'committed' ? `<button class="btn btn-primary" id="mergePush"><svg class="ico"><use href="#i-upload"/></svg>${esc(tr('git.merge.push'))}</button>` : ''}
    </div>
    ${e.status === 'pushed' ? `<p class="converge-note">${svgIco('check')} <span>${esc(tr('git.merge.pushed', { target: e.target_branch }))}</span></p>` : ''}
    ${reste || mergeFichier ? `<div class="merge-body">
      <div class="merge-files">${(e.conflits.length ? e.conflits : [mergeFichier && mergeFichier.path].filter(Boolean)).map((f) => `
        <button class="mf-item${mergeFichier && mergeFichier.path === f ? ' active' : ''}" data-mfile="${esc(f)}">
          ${svgIco('alert')} <span>${esc(f)}</span></button>`).join('')}
        ${e.prets.length ? `<div class="mf-done">${esc(tr('git.merge.done-files', { n: e.prets.length, count: e.prets.length }))}</div>` : ''}
      </div>
      <div class="merge-pane" id="mergePane">${mergeFichier ? mergePaneHtml() : `<p class="muted">${esc(tr('git.merge.pick-file'))}</p>`}</div>
    </div>` : ''}`;
}

/* LA TROISIÈME COLONNE, avec sa raison DÉPLIABLE. La raison n'est jamais affichée d'office :
   trois colonnes ET une justification en dessous de chacune noierait l'écran, alors qu'une
   proposition sans réserve se garde ou s'ignore d'un coup d'œil. Le bouton n'apparaît QUE si
   l'IA a rendu un `<<<RiHj>>>` pour ce conflit précis — un bloc absent n'est pas une panne
   (voir `session/mergeai.js`), simplement rien à montrer. */
function blocIA(proposition, retenue, n, ouverte) {
  const lignes = proposition.texte.split('\n');
  return `<div class="cf-side cf-ia${retenue ? ' cf-keep' : ''}">
      <div class="cf-lab"><span>${esc(tr('git.merge.ai.side'))}</span>
        ${proposition.raison ? `<button class="btn btn-sm btn-ghost" data-reason="${n}">${esc(tr(ouverte ? 'git.merge.ai.reason-hide' : 'git.merge.ai.reason-show'))}</button>` : ''}
        <button class="btn btn-sm${retenue ? ' btn-primary' : ''}" data-keep="ia" data-h="${n}">${esc(tr('git.merge.keep'))}</button></div>
      <pre>${esc(lignes.join('\n')) || `<span class="muted">${esc(tr('git.merge.empty-side'))}</span>`}</pre>
      ${ouverte && proposition.raison ? `<p class="cf-reason">${esc(proposition.raison)}</p>` : ''}
    </div>`;
}

function mergePaneHtml() {
  const f = mergeFichier;
  const e = mergeEtat;
  if (f.edite) {
    return `<div class="mp-head"><code>${esc(f.path)}</code>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-medit="0">${esc(tr('git.merge.back-to-choices'))}</button>
        <button class="btn btn-sm btn-primary" id="mergeResolveText">${esc(tr('git.merge.resolve'))}</button></div>
      <p class="muted">${esc(tr('git.merge.edit-hint'))}</p>
      <textarea id="mergeEditor" class="merge-editor" spellcheck="false">${esc(mergeApercu())}</textarea>`;
  }
  let n = -1;
  const corps = f.morceaux.map((m, i) => {
    if (m.type === 'stable') {
      /* Trois lignes de contexte de chaque côté : de quoi se situer, pas de quoi relire le
         fichier. Un conflit se juge sur ses bords, pas sur les deux cents lignes d'avant. */
      const avant = i === 0 ? [] : m.lignes.slice(0, 3);
      const apres = m.lignes.slice(-3);
      const bouts = m.lignes.length <= 6 ? [m.lignes] : [avant, apres];
      return `<pre class="cf-ctx">${bouts.map((b) => esc(b.join('\n'))).join('\n<span class="cf-gap">⋯</span>\n')}</pre>`;
    }
    n += 1;
    const c = f.choix[n];
    /* LA DATE, À CÔTÉ DE LA BRANCHE. Le même repère que partout ailleurs dans l'écran : l'absolu
       à l'écran (il se compare), le relatif au survol. Une seule mesure par branche pour tout le
       fichier — `git log -1` sur le chemin, pas par conflit — donc identique sur chaque bloc. */
    const bloc = (cote, lignes, libelle, date) => `<div class="cf-side cf-${cote}${c === cote || (c === 'deux' && cote !== 'ia') ? ' cf-keep' : ''}">
        <div class="cf-lab"><span>${esc(libelle)}</span>
          ${date ? `<span class="muted cf-date" title="${esc(tr('git.merge.date-title'))}">${dateHtml(date, fmtDateTime(date))}</span>` : ''}
          <button class="btn btn-sm${c === cote ? ' btn-primary' : ''}" data-keep="${cote}" data-h="${n}">${esc(tr('git.merge.keep'))}</button></div>
        <pre>${esc(lignes.join('\n')) || `<span class="muted">${esc(tr('git.merge.empty-side'))}</span>`}</pre></div>`;
    // Une troisième colonne, SEULEMENT si l'IA a une proposition pour CE conflit précis — un
    // conflit qu'elle a ignoré n'en affiche aucune plutôt qu'une case vide sans raison donnée.
    const proposition = f.propositions[n];
    return `<div class="cf-hunk" data-hunk="${n}">
      <div class="cf-num">${esc(tr('git.merge.hunk', { n: n + 1, total: f.choix.length }))}</div>
      ${bloc('ours', m.ours, tr('git.merge.side-ours', { branch: e.target_branch }), f.dates.ours)}
      ${bloc('theirs', m.theirs, tr('git.merge.side-theirs', { branch: e.source_branch }), f.dates.theirs)}
      ${proposition != null ? blocIA(proposition, c === 'ia', n, !!f.raisonsOuvertes[n]) : ''}
      <div class="cf-both"><button class="btn btn-sm${c === 'deux' ? ' btn-primary' : ''}" data-keep="deux" data-h="${n}"
        title="${esc(tr('git.merge.keep-both-title', { target: e.target_branch, source: e.source_branch }))}">${esc(tr('git.merge.keep-both', { target: e.target_branch, source: e.source_branch }))}</button></div>
    </div>`;
  }).join('');
  return `<div class="mp-head"><code>${esc(f.path)}</code>
      <span class="spacer"></span>
      <button class="btn btn-sm" id="mergeFullOpen" title="${esc(tr('git.merge.fullscreen-title'))}"><svg class="ico"><use href="#i-expand"/></svg>${esc(tr('git.merge.fullscreen'))}</button>
      <button class="btn btn-sm" data-medit="1">${esc(tr('git.merge.edit'))}</button>
      <button class="btn btn-sm btn-primary" id="mergeResolveChoices">${esc(tr('git.merge.resolve'))}</button></div>
    ${corps}`;
}

/* ============ Vue plein écran : les deux versions et le résultat, côte à côte ============
 *
 * L'écran normal montre un conflit à la fois, avec trois lignes de contexte de chaque côté —
 * volontairement étroit, pour ne pas noyer un fichier de deux cents lignes dans les marqueurs.
 * Mais sur un fichier où les conflits s'enchaînent, on perd le fil de ce qui vient avant et
 * après : cette vue montre le fichier ENTIER, reconstruit trois fois — la destination, la
 * source, et le résultat des choix actuels — l'une à côté de l'autre. Cliquer un passage à
 * gauche ou à droite le choisit ; « garder les deux » et l'édition manuelle restent dans la vue
 * normale, qui reste la référence pour ces deux gestes.
 */
function mergeFullColonne(cote) {
  // cote: 'ours' | 'theirs' | null (résultat, selon les choix actuels)
  const f = mergeFichier;
  let n = -1;
  return f.morceaux.map((m) => {
    if (m.type === 'stable') return `<pre class="mf-ctx">${esc(m.lignes.join('\n'))}</pre>`;
    n += 1;
    const num = n;
    const cible = num === mergeFullIndex ? ' mf-nav-cible' : '';
    if (cote === null) {
      const lignes = mergeLignesChoisies(m, f.choix[num], num);
      return `<pre class="mf-hunk mf-result${cible}" data-h="${num}">${esc(lignes.join('\n')) || `<span class="muted">${esc(tr('git.merge.empty-side'))}</span>`}</pre>`;
    }
    const lignes = cote === 'ours' ? m.ours : m.theirs;
    const choisi = f.choix[num] === cote || f.choix[num] === 'deux';
    return `<pre class="mf-hunk mf-${cote}${choisi ? ' mf-chosen' : ''}${cible}" data-h="${num}" data-cote="${cote}"
      title="${esc(tr('git.merge.keep'))}">${esc(lignes.join('\n')) || `<span class="muted">${esc(tr('git.merge.empty-side'))}</span>`}</pre>`;
  }).join('');
}
/* LA QUATRIÈME COLONNE, la proposition de l'IA — SEULEMENT si le fichier en a au moins une
   (voir `mergeFullRender`, qui démasque la colonne). Un conflit que l'agent a ignoré montre un
   bloc neutre plutôt qu'un trou : les lignes restent alignées avec les trois autres colonnes.
   Cliquer une proposition la choisit, exactement comme un passage à gauche ou à droite —
   « garder la proposition » n'a pas de raison de rester réservé à la vue normale. */
function mergeFullColonneIA() {
  const f = mergeFichier;
  let n = -1;
  return f.morceaux.map((m) => {
    if (m.type === 'stable') return `<pre class="mf-ctx">${esc(m.lignes.join('\n'))}</pre>`;
    n += 1;
    const num = n;
    const cible = num === mergeFullIndex ? ' mf-nav-cible' : '';
    const proposition = f.propositions[num];
    if (proposition == null) {
      return `<pre class="mf-hunk mf-ia-empty${cible}" data-h="${num}"><span class="muted">${esc(tr('git.merge.ai.side-empty'))}</span></pre>`;
    }
    const choisi = f.choix[num] === 'ia';
    const ouverte = !!f.raisonsOuvertes[num];
    return `<div class="mf-hunk mf-ia${choisi ? ' mf-chosen' : ''}${cible}" data-h="${num}" data-cote="ia"
        title="${esc(tr('git.merge.keep'))}">
      ${proposition.raison ? `<button class="btn btn-sm btn-ghost mf-reason-btn" data-reason="${num}">${esc(tr(ouverte ? 'git.merge.ai.reason-hide' : 'git.merge.ai.reason-show'))}</button>` : ''}
      <pre>${esc(proposition.texte)}</pre>
      ${ouverte && proposition.raison ? `<p class="mf-reason">${esc(proposition.raison)}</p>` : ''}
    </div>`;
  }).join('');
}
/* NAVIGUER SANS SCROLLER, conflit par conflit : sur un long fichier, trouver le prochain à la
   main coûte plus cher que le clic lui-même. `mergeFullIndex` vaut pour TOUTES les colonnes à la
   fois (les panneaux défilent chacun le leur), et se marque dans le rendu (`mf-nav-cible`) pour
   qu'on voie lequel c'est une fois arrivé — pas seulement le compteur en haut.
   LES BOUTONS NE SE DÉSACTIVENT JAMAIS, même à un seul conflit ou à une borne : cliquer
   « suivant » sur le dernier ne désactive rien, il RÉAFFIRME juste le conflit courant (retour
   en vue, remarqué) plutôt que de rester un bouton mort qu'on clique sans effet visible. */
let mergeFullIndex = 0;
function mergeFullNavRender() {
  const total = (mergeFichier.choix || []).length;
  $('#mergeFullNav').hidden = !total;
  if (!total) return;
  mergeFullIndex = Math.max(0, Math.min(mergeFullIndex, total - 1));
  $('#mergeFullNavCount').textContent = tr('git.merge.full.nav-count', { n: mergeFullIndex + 1, total });
}
function mergeFullAllerA(n) {
  const total = (mergeFichier.choix || []).length;
  if (!total) return;
  mergeFullIndex = Math.max(0, Math.min(n, total - 1));
  mergeFullRender();
  $$('.merge-full-col:not([hidden]) [data-h="' + mergeFullIndex + '"]')
    .forEach((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}
/* CHAQUE COLONNE SE MASQUE INDÉPENDAMMENT, et les autres se partagent la largeur libérée — la
   grille passe de `repeat(N, 1fr)` à `repeat(N-1, 1fr)`, jamais figée à trois ou quatre. L'état
   survit au changement de fichier (une préférence d'affichage, pas une donnée du fichier), mais
   au moins une colonne reste visible : la masquer toutes rendrait la vue vide sans bouton pour
   en rouvrir une, puisque les boutons vivent dans la barre du haut, pas dans les colonnes. */
const mergeFullMasquees = new Set();
const MERGE_FULL_EL = { ours: 'mergeFullOurs', result: 'mergeFullResult', theirs: 'mergeFullTheirs', ia: 'mergeFullIa' };
function mergeFullColonnes() {
  const e = mergeEtat; const f = mergeFichier;
  const cols = [
    { cle: 'ours', titre: tr('git.merge.full.ours', { branch: e.target_branch }), court: tr('git.merge.full.toggle.ours') },
    { cle: 'result', titre: tr('git.merge.full.result'), court: tr('git.merge.full.toggle.result') },
    { cle: 'theirs', titre: tr('git.merge.full.theirs', { branch: e.source_branch }), court: tr('git.merge.full.toggle.theirs') },
  ];
  // La proposition n'existe QUE si le fichier a au moins une proposition — sinon pas de bouton
  // pour une colonne qui n'aurait jamais rien à montrer.
  if ((f.propositions || []).some((p) => p != null)) {
    cols.push({ cle: 'ia', titre: tr('git.merge.ai.side'), court: tr('git.merge.full.toggle.ia') });
  }
  return cols;
}
function mergeFullRender() {
  const e = mergeEtat; const f = mergeFichier;
  $('#mergeFullTitle').textContent = f.path;
  $('#mergeFullOurs').innerHTML = `<h4>${esc(tr('git.merge.full.ours', { branch: e.target_branch }))}</h4>${mergeFullColonne('ours')}`;
  $('#mergeFullResult').innerHTML = `<h4>${esc(tr('git.merge.full.result'))}</h4>${mergeFullColonne(null)}`;
  $('#mergeFullTheirs').innerHTML = `<h4>${esc(tr('git.merge.full.theirs', { branch: e.source_branch }))}</h4>${mergeFullColonne('theirs')}`;
  const cols = mergeFullColonnes();
  const aUneProposition = cols.some((c) => c.cle === 'ia');
  if (aUneProposition) $('#mergeFullIa').innerHTML = `<h4>${esc(tr('git.merge.ai.side'))}</h4>${mergeFullColonneIA()}`;

  let visibles = 0;
  cols.forEach((c) => { if (!mergeFullMasquees.has(c.cle)) visibles += 1; });
  cols.forEach((c) => { $(`#${MERGE_FULL_EL[c.cle]}`).hidden = mergeFullMasquees.has(c.cle); });
  if (!aUneProposition) $('#mergeFullIa').hidden = true;
  $('.merge-full-body').style.gridTemplateColumns = `repeat(${Math.max(visibles, 1)}, 1fr)`;
  $('#mergeFullToggles').innerHTML = cols.map((c) => {
    const cache = mergeFullMasquees.has(c.cle);
    return `<button type="button" class="btn btn-sm mf-toggle${cache ? '' : ' btn-primary'}" data-toggle-col="${c.cle}"
      title="${esc(c.titre)} — ${esc(tr('git.merge.full.toggle-title'))}">
      <svg class="ico ico-sm"><use href="#${cache ? 'i-eye-off' : 'i-eye'}"/></svg>${esc(c.court)}</button>`;
  }).join('');
  mergeFullNavRender();
}
function mergeFullFermer() { $('#mergeFullView').hidden = true; }
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#mergeFullOpen')) {
    mergeFullIndex = 0;   // on rouvre toujours au premier conflit, pas où on l'avait laissé
    mergeFullRender();
    $('#mergeFullView').hidden = false;
    return;
  }
  if (e.target.closest && e.target.closest('#mergeFullClose')) { mergeFullFermer(); return; }
  if (e.target.closest && e.target.closest('#mergeFullPrev')) { mergeFullAllerA(mergeFullIndex - 1); return; }
  if (e.target.closest && e.target.closest('#mergeFullNext')) { mergeFullAllerA(mergeFullIndex + 1); return; }
  const toggle = e.target.closest && e.target.closest('#mergeFullView [data-toggle-col]');
  if (toggle && mergeFichier) {
    const cle = toggle.dataset.toggleCol;
    if (mergeFullMasquees.has(cle)) {
      mergeFullMasquees.delete(cle);
    } else {
      const visibles = mergeFullColonnes().filter((c) => !mergeFullMasquees.has(c.cle));
      if (visibles.length > 1) mergeFullMasquees.add(cle);   // jamais la dernière colonne visible
    }
    mergeFullRender();
    return;
  }
  const fullReason = e.target.closest && e.target.closest('#mergeFullView [data-reason]');
  if (fullReason && mergeFichier) {
    // Avant le choix du bloc ci-dessous : le bouton vit DANS le bloc cliquable, et ne doit pas
    // en déclencher la sélection en plus de son propre effet.
    const n = Number(fullReason.dataset.reason);
    mergeFichier.raisonsOuvertes[n] = !mergeFichier.raisonsOuvertes[n];
    mergeFullRender();
    if ($('#mergePane')) $('#mergePane').innerHTML = mergePaneHtml();
    return;
  }
  const h = e.target.closest && e.target.closest('.mf-hunk[data-cote]');
  if (h && mergeFichier) {
    // Choisi ici, reflété dans les deux vues : la fermer ne doit pas faire revenir en arrière.
    mergeFichier.choix[Number(h.dataset.h)] = h.dataset.cote;
    mergeFullRender();
    if ($('#mergePane')) $('#mergePane').innerHTML = mergePaneHtml();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#mergeFullView').hidden) mergeFullFermer();
});
fermerAuFond('#mergeFullView', mergeFullFermer);

/* Toute l'interaction de l'écran passe par ici : le contenu est réécrit à chaque clic, des
   écouteurs posés sur les boutons seraient perdus au rendu suivant. */
document.addEventListener('click', async (e) => {
  const dans = (sel) => e.target.closest && e.target.closest(sel);
  const open = dans('[data-mopen]');
  if (open) { try { await mergeOuvrir(Number(open.dataset.mopen)); } catch (err) { toast(explainError(err.message), true); } return; }
  const drop = dans('[data-mdrop]');
  if (drop) {
    if (!await confirmDialog({ text: tr('git.merge.abandon-confirm'), confirmLabel: tr('git.merge.abandon') })) return;
    try {
      await api(`/git/merges/${drop.dataset.mdrop}`, { method: 'DELETE' });
      mergeEtat = null; mergeFichier = null; $('#mergeWork').hidden = true;
      await mergeRenderRunning();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if (!mergeEtat) return;
  const fich = dans('[data-mfile]');
  if (fich) { try { await mergeOuvrirFichier(fich.dataset.mfile); } catch (err) { toast(explainError(err.message), true); } return; }
  if (dans('#mergeAiPropose')) { await mergeDemanderIA(); return; }
  const keep = dans('[data-keep]');
  if (keep && mergeFichier) {
    mergeFichier.choix[Number(keep.dataset.h)] = keep.dataset.keep;
    $('#mergePane').innerHTML = mergePaneHtml();
    return;
  }
  // `#mergePane` seulement : la vue plein écran a son propre `data-reason`, avec son propre
  // écouteur (voir plus haut) — sans cette portée, un clic là-bas basculerait ici AUSSI, et les
  // deux togglent la même case dans le même mouvement, ce qui l'annule.
  const reason = dans('#mergePane [data-reason]');
  if (reason && mergeFichier) {
    const n = Number(reason.dataset.reason);
    mergeFichier.raisonsOuvertes[n] = !mergeFichier.raisonsOuvertes[n];
    $('#mergePane').innerHTML = mergePaneHtml();
    return;
  }
  const edit = dans('[data-medit]');
  if (edit && mergeFichier) { mergeFichier.edite = edit.dataset.medit === '1'; $('#mergePane').innerHTML = mergePaneHtml(); return; }
  if (dans('#mergeResolveChoices')) { await mergeResoudre({ choices: mergeFichier.choix }); return; }
  if (dans('#mergeResolveText')) { await mergeResoudre({ content: $('#mergeEditor').value }); return; }
  if (dans('#mergeAbandon')) {
    if (!await confirmDialog({ text: tr('git.merge.abandon-confirm'), confirmLabel: tr('git.merge.abandon') })) return;
    try {
      await api(`/git/merges/${mergeEtat.id}`, { method: 'DELETE' });
      mergeEtat = null; mergeFichier = null; $('#mergeWork').hidden = true;
      await mergeRenderRunning();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  if (dans('#mergeCommit')) { mergeOuvrirCommit(); return; }
  if (dans('#mergePush')) {
    const ok = await confirmDialog({
      title: tr('git.merge.push.confirm.title', { target: mergeEtat.target_branch }),
      text: tr('git.merge.push.confirm.text', { target: mergeEtat.target_branch, project: mergeEtat.project }),
      confirmLabel: tr('git.merge.push'), danger: false,
    });
    if (!ok) return;
    try {
      mergeEtat = await busy($('#mergePush'), () => api(`/git/merges/${mergeEtat.id}/push`, { method: 'POST' }));
      oublierRefs();                        // la cible vient d'avancer
      toast(tr('git.merge.pushed', { target: mergeEtat.target_branch }));
      mergeRenderWork(); await mergeRenderRunning();
    } catch (err) { toast(explainError(err.message), true); }
  }
});

/* Relit les propositions d'UN fichier et les applique EN PLACE (sans toucher aux choix déjà
   faits sur ses conflits) si c'est toujours lui qui est ouvert — utilisé après une demande à
   l'IA, qui répond pour tous les fichiers mais ne concerne visiblement que celui qu'on regarde. */
async function mergeRafraichirPropositions(mergeId, chemin) {
  const d = await api(`/git/merges/${mergeId}/file?path=${encodeURIComponent(chemin)}`);
  if (mergeFichier && mergeFichier.path === chemin) {
    mergeFichier.propositions = d.propositions || [];
    if ($('#mergePane')) $('#mergePane').innerHTML = mergePaneHtml();
  }
  return d.propositions || [];
}
/* DEMANDER À L'IA porte sur TOUT LE MERGE, en un seul appel — jamais fichier par fichier : voir
   `session/mergeai.js` pour le pourquoi (la cohérence entre fichiers se perd si chacun est
   proposé sans connaître les autres). Un job de fond, comme tout appel d'agent — ça peut
   prendre une minute, et on ne bloque pas l'écran pendant ce temps : on continue de pouvoir
   changer de fichier, de choisir « ours »/« theirs » ailleurs, etc. */
async function mergeDemanderIA() {
  // Un appel d'agent envoie le contenu des fichiers en conflit à l'IA : une confirmation avant
  // de partir, comme pour pousser — pas parce que c'est destructeur, mais parce que c'est un
  // envoi qui vaut la peine d'être conscient plutôt que déclenché par un clic distrait.
  const ok = await confirmDialog({
    title: tr('git.merge.ai.confirm.title'),
    text: tr('git.merge.ai.confirm.text'),
    confirmLabel: tr('git.merge.ai.button'), danger: false,
  });
  if (!ok) return;
  const mergeId = mergeEtat.id;
  const gen = (mergeAiGen += 1);
  mergeAiEnCours = true;
  mergeRenderWork();
  try {
    const job = await api(`/git/merges/${mergeId}/ai-propose`, { method: 'POST', body: {} });
    for (let i = 0; i < 800; i += 1) {
      let d;
      try { d = await api(`/jobs/${job.id}/log?after=0`); } catch { break; }
      if (d.finished_at) {
        if (d.status === 'error') { toast(explainError(d.message), true); break; }
        // Le fichier qu'on regarde a pu recevoir une proposition : on le relit pour l'afficher.
        if (mergeFichier) await mergeRafraichirPropositions(mergeId, mergeFichier.path);
        toast(tr('git.merge.ai.done'));
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) { toast(explainError(err.message), true); }
  finally {
    /* SEULE LA DERNIÈRE DEMANDE LANCÉE a le droit de toucher au drapeau global : entre-temps,
       ce merge a pu être abandonné et un autre ouvert, avec sa PROPRE demande déjà en cours —
       la réponse tardive de celle-ci ne doit alors ni l'effacer ni redessiner à sa place. */
    if (gen === mergeAiGen) {
      mergeAiEnCours = false;
      if (mergeEtat && mergeEtat.id === mergeId) mergeRenderWork();
    }
  }
}

async function mergeResoudre(body) {
  try {
    mergeEtat = await api(`/git/merges/${mergeEtat.id}/resolve`, {
      method: 'POST', body: { path: mergeFichier.path, ...body },
    });
    const suivant = mergeEtat.conflits[0];
    mergeFichier = null;
    if (suivant) await mergeOuvrirFichier(suivant); else mergeRenderWork();
    await mergeRenderRunning();
    if (!mergeEtat.conflits.length) toast(tr('git.merge.all-resolved'));
  } catch (err) { toast(explainError(err.message), true); }
}

function mergeOuvrirCommit() {
  $('#mergeCommitIntro').textContent = tr('git.merge.commit.intro', {
    source: mergeEtat.source_branch, target: mergeEtat.target_branch, project: mergeEtat.project,
  });
  $('#mergeCommitMsg').value = mergeEtat.message || '';
  $('#mergeCommitModal').hidden = false;
  setTimeout(() => $('#mergeCommitMsg').focus(), 0);
}
$('#mergeCommitCancel') && $('#mergeCommitCancel').addEventListener('click', () => { $('#mergeCommitModal').hidden = true; });
fermerAuFond('#mergeCommitModal', () => { $('#mergeCommitModal').hidden = true; });
$('#mergeCommitGo') && $('#mergeCommitGo').addEventListener('click', async () => {
  try {
    mergeEtat = await busy($('#mergeCommitGo'), () => api(`/git/merges/${mergeEtat.id}/commit`, {
      method: 'POST', body: { message: $('#mergeCommitMsg').value },
    }));
    $('#mergeCommitModal').hidden = true;
    toast(tr('git.merge.committed'));
    mergeRenderWork(); await mergeRenderRunning();
  } catch (err) { toast(explainError(err.message), true); }
});

async function mergeDemarrer({ sansAncetre = false } = {}) {
  const repoId = mergeRepoId();
  const source = ($('.merge-source', $('#gsub-merge')) || {}).value || '';
  const target = ($('.merge-target', $('#gsub-merge')) || {}).value || '';
  mergeMemoriser({ repo_id: repoId, source, target });   // retenu au LANCEMENT, pas à la saisie
  $('#mergeStartInfo').textContent = tr('git.merge.preparing');
  try {
    mergeEtat = await busy($('#mergeStart'), () => api('/git/merges', {
      method: 'POST', body: { repo_id: repoId, source, target, allow_unrelated: sansAncetre },
    }));
    $('#mergeUnrelated').hidden = true;
    mergeFichier = null;
    mergeAiEnCours = false; mergeAiGen += 1;   // un nouveau merge démarre, sans lien avec un ancien
    const premier = mergeEtat.conflits[0];
    if (premier) await mergeOuvrirFichier(premier); else mergeRenderWork();
    await mergeRenderRunning();
  } catch (err) {
    /* DEUX BRANCHES SANS ANCÊTRE COMMUN : ce n'est pas une panne, c'est une question. Git
       refuse par défaut, à juste titre — fusionner deux histoires étrangères juxtapose deux
       projets. On explique, et on propose de le demander explicitement, plutôt que de laisser
       un toast rouge sans suite. */
    if (err.code === 'UNRELATED') {
      const bloc = $('#mergeUnrelated');
      bloc.querySelector('.mu-text').textContent = err.message;
      bloc.hidden = false;
      return;
    }
    toast(explainError(err.message), true);
  } finally { $('#mergeStartInfo').textContent = ''; }
}
$('#mergeStart') && $('#mergeStart').addEventListener('click', () => mergeDemarrer());
$('#mergeUnrelatedGo') && $('#mergeUnrelatedGo').addEventListener('click', () => mergeDemarrer({ sansAncetre: true }));

