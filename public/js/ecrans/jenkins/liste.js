'use strict';
/* Onglet Jenkins : la liste, les jobs épinglés, le badge, la recherche, les paramètres, les MR croisées, les filtres. */
// @expose JENKINS, amorcerBadgeJenkins, loadJenkins
/* ============ Onglet Jenkins : voir l'état des jobs, et les lancer ============

   RIEN N'EST SONDÉ. L'écran demande quand on l'ouvre ou quand on clique « Rafraîchir » —
   surveiller un serveur d'intégration n'est pas le travail de l'outil, et un sondage de
   fond sur une installation partagée pèse sur tout le monde. C'est aussi pourquoi le menu
   ne porte pas de pastille : elle supposerait d'interroger Jenkins à chaque ouverture de
   l'application, et un compteur figé depuis la dernière visite ment plus qu'il n'informe. */

/* A/Jenkins 2 — LES QUATRE FILTRES VOLATILS REJOIGNENT LES QUATRE AUTRES. L'onglet retenait
   déjà les dossiers rangés, les jobs épinglés, les paramètres masqués et l'ordre des menus,
   mais oubliait la recherche, « seulement ce qui ne va pas », « mes lancements » et les valeurs
   de paramètres — c'est-à-dire précisément ce qu'on repose à chaque visite. */
const JENKINS_FILTRES = 'mergerie_jenkins_filtres';
const jkFiltresMemo = () => { try { return JSON.parse(localStorage.getItem(JENKINS_FILTRES) || '{}'); } catch { return {}; } };
function jkMemoriserFiltres() {
  try {
    localStorage.setItem(JENKINS_FILTRES, JSON.stringify({
      q: JENKINS.q, echecsSeuls: JENKINS.echecsSeuls, miensSeuls: JENKINS.miensSeuls,
      mesBranches: JENKINS.mesBranches, paramFiltres: JENKINS.paramFiltres,
    }));
  } catch { /* stockage indisponible */ }
}
const JK_MEMO0 = (() => { try { return JSON.parse(localStorage.getItem('mergerie_jenkins_filtres') || '{}'); } catch { return {}; } })();
const JENKINS = { jobs: [], configured: true, q: JK_MEMO0.q || '', echecsSeuls: !!JK_MEMO0.echecsSeuls, miensSeuls: !!JK_MEMO0.miensSeuls, mesBranches: !!JK_MEMO0.mesBranches, job: null, build: null, qDossier: '', horsDossiers: new Set(), masques: new Set(), paramFiltres: JK_MEMO0.paramFiltres || {}, paramsMasques: new Set() };

/* ---------- Les jobs épinglés ----------
   Trois jobs du quotidien dans une liste de deux cents : on les cherchait à chaque fois. Une
   épingle les remonte en tête — c'est un arrangement d'écran, il vit donc dans le navigateur,
   comme les dossiers rangés et l'ordre des menus. */
const JENKINS_EPINGLES = 'mergerie_jenkins_epingles';
const jkEpingles = () => { try { return new Set(JSON.parse(localStorage.getItem(JENKINS_EPINGLES) || '[]')); } catch { return new Set(); } };
function jkBasculerEpingle(chemin) {
  const e = jkEpingles();
  if (e.has(chemin)) e.delete(chemin); else e.add(chemin);
  try { localStorage.setItem(JENKINS_EPINGLES, JSON.stringify([...e])); } catch { /* stockage indisponible */ }
  renderJenkins();
}

/* Les dossiers DÉCOCHÉS sont mémorisés, pas les cochés. La différence compte le jour où
   l'équipe crée un dossier : mémoriser les cochés le rendrait invisible jusqu'à ce qu'on
   pense à aller le cocher — un job neuf n'apparaîtrait jamais. */
const JENKINS_FILTRE = 'mergerie_jenkins_dossiers';
/* DEUX ÉTATS, et non un seul, parce que ce sont deux gestes différents :
   — DÉCOCHÉ : « pas maintenant ». La case reste sous la main, on la recoche d'un clic.
   — MASQUÉ : « ce dossier ne me concerne pas ». Il sort de la liste des cases, qui redevient
     lisible — sur une installation à quarante dossiers, une rangée de cases qu'on ne coche
     jamais est du bruit qu'on relit chaque matin.
   Un dossier masqué ne montre pas ses jobs non plus : le masquer en laissant ses jobs dans la
   liste donnerait des jobs qu'on ne peut plus filtrer.
   L'ancien format (un simple tableau) est relu : personne ne doit perdre son filtre. */
function chargerFiltreJenkins() {
  JENKINS.horsDossiers = new Set();
  JENKINS.masques = new Set();
  JENKINS.paramsMasques = new Set();
  try {
    const brut = JSON.parse(localStorage.getItem(JENKINS_FILTRE) || '{}');
    if (Array.isArray(brut)) { JENKINS.horsDossiers = new Set(brut.map(String)); return; }
    JENKINS.horsDossiers = new Set((brut.hors || []).map(String));
    JENKINS.masques = new Set((brut.masques || []).map(String));
    JENKINS.paramsMasques = new Set((brut.paramsMasques || []).map(String));
  } catch { /* stockage illisible : on repart d'un filtre vide */ }
}
function sauverFiltreJenkins() {
  try {
    localStorage.setItem(JENKINS_FILTRE, JSON.stringify({
      hors: [...JENKINS.horsDossiers], masques: [...JENKINS.masques],
      paramsMasques: [...JENKINS.paramsMasques],
    }));
  } catch { /* stockage indisponible */ }
}

// Les états que Jenkins exprime par une couleur, traduits côté serveur en `statut`.
const JK_ENNUI = ['echec', 'instable'];

async function loadJenkins({ silencieux = false } = {}) {
  const box = $('#jenkinsBox');
  if (!box) return;
  chargerFiltreJenkins();
  const auto = $('#jenkinsNoAuto');
  if (auto) auto.checked = jkAutoCoupe();
  // Un rafraîchissement de fond ne remplace pas la liste par un squelette : l'écran
  // clignoterait toutes les trente secondes sous les yeux de quelqu'un qui lit.
  if (!silencieux) box.innerHTML = skeleton(4);
  try {
    const [d] = await Promise.all([api('/jenkins/jobs'), assurerMrsJenkins()]);
    JENKINS.jobs = d.jobs || [];
    JENKINS.configured = d.configured !== false;
  } catch (e) {
    if (!silencieux) box.innerHTML = errorBox(explainError(e.message));
    return;   // en silencieux, on garde l'écran précédent : un réseau qui hoquette n'efface rien
  }
  renderJenkins();
  majBadgeJenkins();
  jkAutoRelance();
}

/* LE BADGE DU MENU : combien de jobs ont tourné AUJOURD'HUI. La question qu'on se pose en
   passant devant l'onglet est « est-ce que ça a bougé ce matin ? », pas « combien de jobs
   existe-t-il ». On compte donc les jobs dont le dernier lancement tombe dans la journée en
   cours — heure locale, celle de la personne qui regarde.

   Un job lancé cinq fois compte pour un : la liste ne porte que le DERNIER build de chacun,
   et prétendre compter les exécutions demanderait d'interroger l'historique de chaque job à
   chaque rafraîchissement. Le titre du badge dit donc « jobs », pas « lancements ». */
const jkDuJour = (jobs) => {
  const debut = new Date(); debut.setHours(0, 0, 0, 0);
  return (jobs || []).filter((j) => j.last && j.last >= debut.getTime());
};
const jkAujourdhui = (jobs) => jkDuJour(jobs).length;

/* Les deux pastilles du menu. ROUGE : les jobs dont le dernier lancement du JOUR a échoué —
   c'est ce qu'on veut voir de n'importe quel onglet, sans passer par Jenkins. BLEU : ce qui a
   tourné aujourd'hui, tous états confondus.

   Trois bornes, assumées :
   — `echec` SEUL. L'instable a sa propre couleur et son propre filtre dans l'onglet ; le
     mettre en rouge ferait sonner l'alarme pour un test capricieux, et une alarme qui sonne
     pour tout n'est plus lue ;
   — un échec d'HIER ne compte pas : le badge dit « aujourd'hui », il ne raconte pas l'histoire
     de la semaine. Le voir suppose d'ouvrir l'onglet, où il est en tête ;
   — un job relancé et redevenu vert ne compte plus : la liste ne porte que le DERNIER build de
     chacun. Compter les exécutions demanderait d'interroger l'historique de chaque job à chaque
     rafraîchissement, pour dire quelque chose que la ligne dit déjà mieux. */
function majBadgeJenkins() {
  const bleu = $('#navCountJenkins');
  const rouge = $('#navJenkinsFail');
  if (!bleu || !rouge) return;
  const duJour = jkDuJour(JENKINS.jobs);
  const n = duJour.length;
  bleu.textContent = String(n);
  bleu.hidden = !n;
  bleu.title = tr('jenkins.nav.today', { n, count: n });

  const rates = duJour.filter((j) => !j.enCours && j.statut === 'echec').length;
  rouge.textContent = String(rates);
  rouge.hidden = !rates;
  const libelle = tr('jenkins.nav.failed-today', { n: rates, count: rates });
  rouge.dataset.tip = libelle;                 // bulle de l'app, immédiate et thémée
  rouge.title = '';                            // …et jamais celle du bouton parent par-dessus
  rouge.setAttribute('aria-label', libelle);
}

/* Une fois au démarrage, pour que le badge existe sans avoir ouvert l'onglet — comme celui de
   Docker. Ensuite c'est le rafraîchissement de l'onglet qui l'entretient : on ne sonde pas
   Jenkins en continu depuis les autres onglets. Silencieux : Jenkins non configuré,
   injoignable ou lent ne doit rien afficher ni rien signaler au démarrage. */
async function amorcerBadgeJenkins() {
  try {
    const d = await api('/jenkins/jobs');
    if (d.configured === false) return;
    JENKINS.jobs = d.jobs || [];
    majBadgeJenkins();
  } catch { /* pas de badge, et c'est tout */ }
}

function jkStatutLabel(j) {
  if (j.enCours) return tr('jenkins.st.running');
  return tr(`jenkins.st.${j.statut}`);
}

// Cf. `depuis()` : ici on part d'un horodatage en millisecondes (ce que rend l'API Jenkins).
function jkQuand(ms) {
  return ms ? depuis(new Date(ms).toISOString()) : tr('jenkins.st.jamais');
}

// « Qui a lancé » : un nom, ou la nature du déclencheur — jamais un blanc, qui laisserait
// croire à une information manquante alors que la réponse est « personne, c'est l'horloge ».
function jkAuteur(by) {
  if (!by) return '';
  if (by.user) return tr('jenkins.by.user', { user: by.user });
  if (by.trigger) return tr(`jenkins.by.${by.trigger}`);
  return by.label || '';
}

/* Les paramètres du dernier lancement, en clair dans la ligne. Trois au plus : au-delà, la
   ligne devient un paragraphe et on ne lit plus rien — le reste est dans l'infobulle, et la
   fiche du job les montre tous. Celui qui a DONNÉ la branche affichée n'est pas répété. */
/* LA RECHERCHE PORTE SUR CE QUE LA LIGNE MONTRE. Le chemin entier d'abord — on cherche autant
   « le job de déploiement » que « tout ce qui est dans boutique ». Mais aussi la branche,
   l'auteur et les PARAMÈTRES du dernier lancement : chercher `v1.5.0` ou `ENV=prod` et ne rien
   trouver alors que c'est écrit à l'écran est la façon la plus sûre de ne plus se servir d'un
   champ de recherche. */
function jkCherchable(j) {
  if (j._q === undefined) {
    j._q = [
      j.path, j.ref || '',
      (j.by && (j.by.user || j.by.label)) || '',
      ...(j.lastParams || []).map((p) => `${p.name}=${p.value} ${p.name} ${p.value}`),
    ].join(' ').toLowerCase();
  }
  return j._q;
}

/* TOUS les paramètres du dernier lancement, en clair dans la ligne. Un « +3 » obligeait à
   survoler ou à ouvrir la fiche pour savoir avec quoi le job était parti — exactement la
   question qu'on se pose en lisant la liste. La ligne se replie sur plusieurs lignes s'il le
   faut. Celui qui a DONNÉ la branche affichée n'est pas répété. */
function jkParams(j) {
  return (j.lastParams || []).filter((p) => String(p.value) !== String(j.ref || ''));
}

/* LES PARAMÈTRES QUI REVIENNENT PARTOUT MÉRITENT UNE COLONNE. Sur une installation d'équipe,
   les mêmes trois ou quatre paramètres (ENV, VERSION, BRANCHE) reviennent d'un job à l'autre :
   affichés dans l'ordre propre à chaque job, l'œil doit les rechercher à chaque ligne. À partir
   de TROIS jobs, un paramètre est considéré comme fréquent : il prend la même place sur toutes
   les lignes — vide comprise, sinon la colonne suivante se décale et l'alignement ne tient plus.
   Les autres, propres à un job, suivent à la fin.

   Trois plutôt que deux : à deux, une coïncidence entre deux jobs figerait une colonne pour
   tout le monde. */
const JK_PARAM_FREQUENT = 3;

/* Combien de JOBS portent chaque paramètre — pas combien de fois il apparaît : un job qui le
   passerait deux fois ne le rendrait pas plus courant. */
function jkFrequences(jobs) {
  const par = new Map();
  for (const j of jobs) {
    for (const nom of new Set((j.lastParams || []).map((p) => p.name))) {
      par.set(nom, (par.get(nom) || 0) + 1);
    }
  }
  return par;
}

/* Les paramètres qui reviennent : du plus répandu au moins répandu, puis alphabétique. Ce sont
   eux qui reçoivent une teinte et un filtre — colorer un paramètre porté par un seul job
   n'aiderait à rien et remplirait la liste de couleurs sans signification. */
function jkColonnes(jobs) {
  return [...jkFrequences(jobs)]
    .filter(([, n]) => n >= JK_PARAM_FREQUENT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([nom]) => nom);
}

/* LA COULEUR PLUTÔT QUE LA COLONNE. Aligner les paramètres en grille rendait la liste raide et
   pleine de trous ; ce qu'on cherche vraiment, c'est retrouver `ENV` d'une ligne à l'autre du
   coin de l'œil. Une teinte stable par NOM le fait sans rien déranger de la mise en page.

   La teinte vient d'un hachage du nom, pas de son rang : elle ne bouge donc pas quand un job
   apparaît ou disparaît de la liste. Deux noms peuvent tomber sur la même teinte — le nom reste
   écrit dans la pastille, la couleur aide, elle ne remplace rien. */
const JK_TEINTES = 8;
function jkTeinte(nom) {
  let h = 0;
  for (let i = 0; i < nom.length; i += 1) h = (h * 31 + nom.charCodeAt(i)) % 9973;
  return h % JK_TEINTES;
}

const jkChip = (nom, valeur, colore) => `<span class="jk-chip${colore ? ` jk-c${jkTeinte(nom)}` : ''}"><span class="jk-chip-k">${esc(nom)}</span><span class="jk-chip-v">${esc(String(valeur))}</span></span>`;

/* Sur LEUR PROPRE LIGNE, en pastilles nom/valeur. Alignés à la suite du statut, de la date et
   de l'auteur — tous en gris, tous séparés par des points médians —, ils se confondaient avec
   eux : on lisait une phrase, pas des couples. Le nom reste discret, la valeur porte la
   couleur du texte : c'est elle qu'on cherche. */
function jkParamPastilles(liste, frequents) {
  if (!liste.length) return '';
  return `<span class="jk-params">${liste.map((p) => jkChip(p.name, p.value, frequents.includes(p.name))).join('')}</span>`;
}

/* Le lien vers le job DANS Jenkins. L'URL vient de Jenkins, donc d'une source externe : on
   n'ouvre que du http(s), comme partout ailleurs dans l'application — une `javascript:` glissée
   dans un nom de job n'aurait aucune chance de s'exécuter, mais on ne compte pas là-dessus.
   `noopener` : la page ouverte ne doit pas pouvoir reprendre la main sur la nôtre. */
function jkLienExterne(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  return `<a class="btn btn-icon btn-sm jk-open-ext" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer" title="${esc(tr('jenkins.open-ext'))}" aria-label="${esc(tr('jenkins.open-ext'))}"><svg class="ico ico-sm"><use href="#i-external"/></svg></a>`;
}

function jkRow(j, colonnes = []) {
  const params = jkParams(j);
  const infos = [
    jkStatutLabel(j),
    // Sans date, le statut dit DÉJÀ « jamais lancé » : le répéter ferait croire à deux faits.
    j.last ? fmtDateTime(new Date(j.last).toISOString()) : '',
    jkAuteur(j.by),
    j.ref ? `⎇ ${j.ref}` : '',
    (j.buildable || j.statut === 'desactive') ? '' : tr('jenkins.st.desactive'),
  ].filter(Boolean);
  /* La fiche s'ouvre en cliquant le NOM, pas la ligne entière : les boutons de droite lancent,
     relancent ou sortent vers Jenkins, et le clic ne doit pas leur ajouter une fenêtre par-dessus.
     Un vrai <button> — donc au clavier aussi, et le curseur dit où ça se passe. */
  const epingle = jkEpingles().has(j.path);
  return `<div class="card jk-row${epingle ? ' jk-pinned' : ''}">
    <span class="jk-dot ${esc(j.statut)}${j.enCours ? ' encours' : ''}" aria-hidden="true"></span>
    ${/* L'ÉPINGLE : trois jobs du quotidien ne se cherchent plus dans deux cents. */''}
    <button type="button" class="btn btn-icon btn-sm btn-ghost jk-pin${epingle ? ' active' : ''}" data-jkpin="${esc(j.path)}" title="${esc(tr(epingle ? 'jenkins.unpin' : 'jenkins.pin'))}" aria-label="${esc(tr(epingle ? 'jenkins.unpin' : 'jenkins.pin'))}"><svg class="ico ico-sm"><use href="#i-${epingle ? 'star-filled' : 'star'}"/></svg></button>
    <button type="button" class="jk-ident" data-jkjob="${esc(j.path)}" title="${esc(tr('jenkins.open.title'))}">
      <span class="jk-name">${j.folder ? `<span class="jk-path">${esc(j.folder)}/</span>` : ''}${esc(j.name)}${j.lastNumber ? ` <span class="jk-path">#${j.lastNumber}</span>` : ''}</span>
      <span class="jk-meta" title="${esc(j.last ? jkQuand(j.last) : '')}">${infos.map(esc).join(' · ')}</span>
      ${jkParamPastilles(params, colonnes)}
    </button>
    ${/* Le badge d'état a été retiré d'ici : il reprenait MOT POUR MOT le `jkStatutLabel`
          déjà écrit dans `.jk-meta`, à côté d'une pastille qui porte la même couleur.
          Trois fois la même information, dont une au milieu des boutons d'action. */''}
    ${/* MÊME RAIL QUE DOCKER : ordre fixe, actions indisponibles DÉSACTIVÉES et non absentes.
          « Relancer » manquait sur les jobs sans paramètres et « Lancer » sur les jobs
          désactivés : « Lancer », bleu, se retrouvait à trois abscisses différentes d'une
          ligne à l'autre, exactement là où l'œil venait de cliquer sur autre chose. */''}
    <div class="jk-actions">
      ${/* B10 — « EST-CE BIEN PARTI ? ». Le build est vert, il porte `ENV=préprod`, le job est
            lié à un dépôt : l'adresse de cet environnement est dans la grille des liens. On
            allait la chercher deux onglets plus loin. Le bloc arrive VIDE et se remplit après
            le rendu (une requête par job lié, une seule fois) — un job sans lien, sans build
            vert ou sans paramètre d'environnement n'affiche rien du tout. */''}
      <span class="jk-depot" data-jk-depot="${esc(j.path)}"></span>
      <span class="jk-liens" data-jk-liens="${esc(j.path)}"></span>
      ${jkLienExterne(j.url)}
      ${/* « Ouvrir » à côté d'une icône « ouvrir dans Jenkins » : deux fois le même verbe pour
            deux destinations. Celui-ci reste DANS Mergerie et montre la fiche — « Détails ». */''}
      <button type="button" class="btn btn-sm" data-jkopen="${esc(j.path)}">${esc(tr('jenkins.open'))}</button>
      ${(() => {
        const peutRelancer = !!(j.buildable && j.last && (j.lastParams || []).length);
        return `<button type="button" class="btn btn-sm" data-jkrerun="${esc(j.path)}"${peutRelancer
          ? ` title="${esc(tr('jenkins.rerun.title-btn'))}"`
          : ` disabled title="${esc(tr('jenkins.rerun.unavailable'))}"`}><svg class="ico ico-sm"><use href="#i-refresh"/></svg>${esc(tr('jenkins.rerun'))}</button>`;
      })()}
      <button type="button" class="btn btn-sm btn-primary" data-jkrun="${esc(j.path)}"${j.buildable
        ? ` title="${esc(j.params ? tr('jenkins.run.params-title', { n: j.params, count: j.params }) : tr('jenkins.run.title'))}"`
        : ` disabled title="${esc(tr('jenkins.run.unavailable'))}"`}><svg class="ico ico-sm"><use href="#i-play"/></svg>${esc(j.params ? tr('jenkins.run.params') : tr('jenkins.run'))}</button>
    </div>
  </div>`;
}

/* Les branches de MES merge requests ouvertes — celles dont je suis l'auteur si les forges
   ont pu dire qui je suis, sinon toutes les ouvertes : mieux vaut un filtre un peu large
   qu'un filtre vide sur un jeton qui ne lit pas son propre compte. */
/* LES MERGE REQUESTS QUE JENKINS CROISE. Elles venaient de l'onglet Reviews, chargé ou non :
   ouvert directement sur Jenkins, « Mes branches » (restauré coché) vidait la liste et les
   pastilles `!iid` n'apparaissaient pas. On les lit donc ici si Reviews ne l'a pas fait, sans
   toucher à son état. */
let jkMrsConnues = [];
const mrsPourJenkins = () => (toReviewRows.length || reportRows.length ? toReviewRows.concat(reportRows) : jkMrsConnues);
async function assurerMrsJenkins() {
  if (toReviewRows.length || reportRows.length || jkMrsConnues.length) return;
  try {
    const [a, b] = await Promise.all([api('/mrs?status=to_review'), api('/mrs?status=reviewed')]);
    jkMrsConnues = (a || []).concat(b || []);
  } catch { /* file indisponible : ni filtre ni pastille, comme avant */ }
}
function mesBranchesOuvertes() {
  const rows = mrsPourJenkins().filter((m) => !m.closed_seen);
  const miennes = moiSurLesForges ? rows.filter(estDeMoi) : rows;
  return new Set(miennes.map((m) => String(m.source_branch || '').trim()).filter(Boolean));
}

/* A/Jenkins 1 — DE QUEL DÉPÔT PARLE CE JOB. `repo_jenkins` n'était lu que dans l'autre sens
   (depuis une merge request, pour proposer « Lancer <job> ») : l'onglet Jenkins, lui, affichait
   deux cents chemins sans jamais dire lequel concerne le code qu'on suit. La liste est
   minuscule (quelques lignes) et chargée une fois par page. */
let jenkinsLiensParJob = null;
async function assurerLiensJenkins() {
  if (jenkinsLiensParJob) return jenkinsLiensParJob;
  jenkinsLiensParJob = new Map();
  try {
    const d = await api('/jenkins/links');
    for (const l of (d.links || [])) jenkinsLiensParJob.set(l.job_path, l);
  } catch { /* pas de lien : la colonne reste vide, c'est le cas courant */ }
  return jenkinsLiensParJob;
}

/* B10 — remplir les boutons d'environnement APRÈS le rendu. Une requête par job LIÉ et par
   page (mémorisée) : la liste en compte deux cents, mais deux ou trois seulement sont liés à
   un dépôt, et eux seuls posent la question « c'est parti où ? ». */
const cacheLiensJob = new Map();
/* Le dépôt lié, et la merge request OUVERTE qui porte la branche du dernier build. Les deux
   sont déjà en mémoire — les liens (une requête) et la file (chargée par l'onglet Reviews) :
   on ne demande rien de plus, et un job sans lien n'affiche rien. */
async function remplirDepotsJenkins() {
  const liens = await assurerLiensJenkins();
  if (!liens.size) return;
  for (const zone of $$('[data-jk-depot]')) {
    const chemin = zone.dataset.jkDepot;
    const l = liens.get(chemin);
    if (!l || !zone.isConnected) continue;
    const j = (JENKINS.jobs || []).find((x) => x.path === chemin);
    const ref = String((j && j.ref) || '').trim();
    const mr = ref ? mrsPourJenkins().find((m) => !m.closed_seen && m.source_branch === ref) : null;
    zone.innerHTML = `<span class="tag jk-depot-tag" title="${esc(tr('jenkins.linked-repo.title', { project: l.project }))}">${svgIco('merge')} ${esc(l.project)}</span>`
      + (mr ? `<button type="button" class="tag jk-depot-mr" data-jk-mr="${mr.id}" title="${esc(tr('jenkins.linked-mr.title', { iid: mr.iid, branch: ref }))}">!${esc(String(mr.iid))}</button>` : '');
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-jk-mr]');
  if (!b) return;
  navTab('review');
  openReport(Number(b.dataset.jkMr));
});

async function remplirLiensJenkins() {
  for (const zone of $$('[data-jk-liens]')) {
    const chemin = zone.dataset.jkLiens;
    const j = (JENKINS.jobs || []).find((x) => x.path === chemin);
    if (!j || j.statut !== 'succes' || j.enCours) continue;
    /* La valeur d'un paramètre qui NOMME un environnement : c'est le seul indice fiable
       (`ENV=préprod`, `TARGET=prod`). On compare aux environnements de la grille, sans
       deviner — un `ENV=dev-perso-karim` qui ne correspond à rien n'affiche rien. */
    const valeurs = new Set((j.lastParams || []).map((p) => String(p.value || '').trim().toLowerCase()).filter(Boolean));
    if (!valeurs.size) continue;
    if (!cacheLiensJob.has(chemin)) {
      cacheLiensJob.set(chemin, api(`/jenkins/build-links?path=${encodeURIComponent(chemin)}`).catch(() => ({ envs: [] })));
    }
    const d = await cacheLiensJob.get(chemin);
    const cases = (d.envs || []).filter((c) => valeurs.has(String(c.env || '').trim().toLowerCase()));
    if (!cases.length || !zone.isConnected) continue;
    zone.innerHTML = cases.slice(0, 3).map((c) => `<a class="btn btn-sm" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer"
        style="border-color:${esc(c.color || 'var(--line)')}"
        title="${esc(tr('jenkins.open-env.title', { env: c.env, url: c.url }))}">${svgIco('external')}${esc(c.env)}</a>`).join('');
  }
}

function renderJenkins() {
  const box = $('#jenkinsBox');
  /* Les filtres restaurés doivent SE VOIR : une liste réduite par une recherche qu'on ne lit
     nulle part passe pour une liste vide, et on la croit cassée. */
  const champQ = $('#jenkinsSearch'); if (champQ && champQ.value !== JENKINS.q) champQ.value = JENKINS.q;
  const cKo = $('#jenkinsFailOnly'); if (cKo) cKo.checked = !!JENKINS.echecsSeuls;
  const cMoi = $('#jenkinsMineOnly'); if (cMoi) cMoi.checked = !!JENKINS.miensSeuls;
  const cBr = $('#jenkinsMineBranches'); if (cBr) cBr.checked = !!JENKINS.mesBranches;
  if (!JENKINS.configured) {
    box.innerHTML = emptyState({
      icon: 'sliders', title: tr('jenkins.empty.title'), text: tr('jenkins.empty.text'),
      actions: [{ act: 'jenkins-config', label: tr('jenkins.empty.btn'), primary: true }],
    });
    $('#jenkinsCount').textContent = '';
    return;
  }
  renderJenkinsDossiers();
  renderJenkinsParamFiltres();
  const q = JENKINS.q.toLowerCase();
  const vus = JENKINS.jobs.filter((j) => (!q || jkCherchable(j).includes(q))
    && !JENKINS.horsDossiers.has(j.folder) && !JENKINS.masques.has(j.folder)
    && jkPasseFiltresParam(j)
    && (!JENKINS.echecsSeuls || JK_ENNUI.includes(j.statut) || j.enCours)
    && (!JENKINS.miensSeuls || Object.prototype.hasOwnProperty.call(jkLances(), j.path))
    /* « Mes branches » : le dernier build porte la branche d'une de MES merge requests
       ouvertes. Aucune requête de plus — la file est déjà chargée, et c'est elle qui dit ce
       qui est à moi. Sans file chargée (onglet jamais ouvert), le filtre ne retient rien
       plutôt que de tout retenir : une case qui ne filtre pas ment sur ce qu'elle promet. */
    && (!JENKINS.mesBranches || mesBranchesOuvertes().has(String(j.ref || '').trim())));
  $('#jenkinsCount').textContent = tr('jenkins.count', { n: vus.length, count: vus.length, total: JENKINS.jobs.length });

  if (!JENKINS.jobs.length) {
    box.innerHTML = emptyState({ icon: 'inbox', title: tr('jenkins.none.title'), text: tr('jenkins.none.text') });
    return;
  }
  if (!vus.length) {
    box.innerHTML = `<p class="muted">${esc(tr('jenkins.no-match'))}</p>`;
    return;
  }
  /* À PLAT, dans l'ordre rendu par le serveur : du dernier lancement au plus ancien. Le
     dossier n'est plus un en-tête mais une case à cocher au-dessus — et il reste écrit
     devant chaque nom, sinon deux `api-build` de projets différents se confondent. */
  /* Calculés sur TOUS les jobs, pas sur ceux qui restent après filtrage : sinon une teinte
     changerait de sens à chaque frappe, et un filtre disparaîtrait au moment où l'on s'en sert. */
  const colonnes = jkColonnes(JENKINS.jobs);
  /* LES ÉPINGLÉS EN TÊTE, dans l'ordre du serveur pour le reste. Un tri stable : deux jobs
     épinglés gardent entre eux l'ordre « dernier lancement d'abord ». */
  const epingles = jkEpingles();
  const ordonnes = [...vus].sort((a, b) => (epingles.has(b.path) ? 1 : 0) - (epingles.has(a.path) ? 1 : 0));
  box.innerHTML = ordonnes.map((j) => jkRow(j, colonnes)).join('');
  remplirLiensJenkins();   // B10 : après le rendu, sans le retarder
  remplirDepotsJenkins();  // A/Jenkins 1 : idem — le dépôt lié et sa merge request
}

/* FILTRER SUR LES VALEURS D'UN PARAMÈTRE FRÉQUENT. C'est la question qu'on se pose devant une
   liste de trois cents jobs : « qu'est-ce qui est parti en prod ? », « qu'est-ce qui tourne sur
   la 2.4 ? ». Un job SANS le paramètre est écarté dès qu'on filtre dessus : il ne répond pas à
   la question posée, et le garder « au cas où » viderait le filtre de son sens. */
function jkPasseFiltresParam(j) {
  const filtres = Object.entries(JENKINS.paramFiltres || {}).filter(([, v]) => v);
  if (!filtres.length) return true;
  const par = new Map((j.lastParams || []).map((p) => [p.name, String(p.value)]));
  return filtres.every(([nom, valeur]) => par.get(nom) === valeur);
}

function renderJenkinsParamFiltres() {
  const box = $('#jenkinsParamFiltres');
  if (!box) return;
  /* Un filtre MASQUÉ sort de la barre : tous les paramètres fréquents ne servent pas à
     chercher (un numéro de build, un horodatage), et une rangée de listes qu'on n'ouvre jamais
     est du bruit qu'on relit chaque matin. */
  const colonnes = jkColonnes(JENKINS.jobs).filter((n) => !JENKINS.paramsMasques.has(n));
  const caches = jkColonnes(JENKINS.jobs).filter((n) => JENKINS.paramsMasques.has(n));
  box.hidden = !colonnes.length && !caches.length;
  if (box.hidden) return;
  box.innerHTML = colonnes.map((nom) => {
    const valeurs = [...new Set(JENKINS.jobs.flatMap((j) => (j.lastParams || [])
      .filter((p) => p.name === nom).map((p) => String(p.value))))].sort((a, b) => a.localeCompare(b));
    const choisie = (JENKINS.paramFiltres || {})[nom] || '';
    return `<label class="jk-pf${choisie ? ' jk-pf-on' : ''}"><span class="jk-pf-k">${esc(nom)}</span>
      ${jkChampValeur('jkpf', nom, valeurs, choisie)}
      <button type="button" class="btn btn-icon btn-sm jk-pf-hide" data-jkpfhide="${esc(nom)}" title="${esc(tr('jenkins.param.hide'))}" aria-label="${esc(tr('jenkins.param.hide'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></label>`;
  }).join('')
    + (caches.length ? `<button type="button" class="btn btn-sm jk-pf-caches" id="jenkinsParamHidden" title="${esc(tr('jenkins.param.hidden-title'))}">${esc(tr('jenkins.param.hidden', { n: caches.length, count: caches.length }))}</button>` : '');
}

/* Le filtre par dossiers. Sa propre recherche masque des cases sans jamais en décocher :
   filtrer ce qu'on regarde ne doit pas changer ce qu'on a choisi de voir. */
function renderJenkinsDossiers() {
  const bloc = $('#jenkinsFolders');
  const liste = $('#jenkinsFolderList');
  if (!bloc || !liste) return;
  const comptes = new Map();
  for (const j of JENKINS.jobs) comptes.set(j.folder, (comptes.get(j.folder) || 0) + 1);
  const dossiers = [...comptes.keys()].sort((a, b) => a.localeCompare(b));
  // Un seul dossier (ou aucun) : le filtre n'aurait rien à filtrer.
  bloc.hidden = dossiers.length < 2;
  if (bloc.hidden) return;
  const nom = (d) => (d ? esc(d) : esc(tr('jenkins.folders.root')));
  const qd = JENKINS.qDossier.toLowerCase();
  const visibles = dossiers.filter((d) => !JENKINS.masques.has(d));
  const montres = visibles.filter((d) => !qd || (d || '').toLowerCase().includes(qd));
  liste.innerHTML = montres.map((d) => `<label><input type="checkbox" data-jkfolder="${esc(d)}"${JENKINS.horsDossiers.has(d) ? '' : ' checked'} />
    <span>${nom(d)}</span>
    <span class="jk-folder-count">${comptes.get(d)}</span>
    <button type="button" class="btn btn-icon btn-sm jk-folder-hide" data-jkhide="${esc(d)}" title="${esc(tr('jenkins.folders.hide'))}" aria-label="${esc(tr('jenkins.folders.hide'))}"><svg class="ico ico-sm"><use href="#i-close"/></svg></button></label>`).join('')
    || `<p class="muted">${esc(tr('jenkins.folders.no-match'))}</p>`;

  /* Ce qui est masqué se COMPTE, il ne s'étale pas. Une rangée de boutons qu'on ne clique
     presque jamais mangeait la place de ce qu'on regarde vraiment ; mais le taire ferait d'un
     filtre un mystère au bout de trois semaines. Un mot, donc, et la liste au clic. */
  const caches = dossiers.filter((d) => JENKINS.masques.has(d));
  const pied = $('#jenkinsFolderHidden');
  pied.hidden = !caches.length;
  pied.textContent = caches.length ? tr('jenkins.folders.hidden', { n: caches.length, count: caches.length }) : '';
  pied.title = tr('jenkins.folders.hidden-title');
  if (!$('#jenkinsHiddenModal').hidden) renderJenkinsMasques();
}

// La liste des masqués, dans sa modale. Un bouton par dossier : on en masque dix, on en
// récupère un seul — « tout remettre » existe aussi, pour le jour où on change d'avis en bloc.
function renderJenkinsMasques() {
  const box = $('#jenkinsHiddenList');
  if (!box) return;
  const comptes = new Map();
  for (const j of JENKINS.jobs) comptes.set(j.folder, (comptes.get(j.folder) || 0) + 1);
  const dossiers = [...JENKINS.masques].sort((a, b) => a.localeCompare(b));
  const params = [...JENKINS.paramsMasques].sort((a, b) => a.localeCompare(b));
  const ligne = (nom, compte, attr) => `<div class="jk-hidden-row">
      <span>${nom}</span>
      ${compte == null ? '' : `<span class="jk-folder-count">${compte}</span>`}
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" ${attr}>${esc(tr('jenkins.hidden.restore'))}</button>
    </div>`;
  /* Une seule modale pour les deux familles : ce qu'on a rangé se retrouve au même endroit,
     qu'il s'agisse d'un dossier ou d'un filtre. Un titre n'apparaît que s'il a du contenu. */
  const bloc = (titre, lignes) => (lignes.length ? `<h4>${esc(titre)}</h4>${lignes.join('')}` : '');
  box.innerHTML = (dossiers.length || params.length)
    ? bloc(tr('jenkins.folders'), dossiers.map((d) => ligne(d ? esc(d) : esc(tr('jenkins.folders.root')), comptes.get(d) || 0, `data-jkshow="${esc(d)}"`)))
      + bloc(tr('jenkins.params'), params.map((n) => ligne(esc(n), null, `data-jkpfshow="${esc(n)}"`)))
    : `<p class="muted">${esc(tr('jenkins.hidden.empty'))}</p>`;
  $('#jenkinsHiddenAll').hidden = !dossiers.length && !params.length;
}

