'use strict';
/* Les jetons « &&dépôt » de la demande : un projet s'ajoute à la session sans quitter le clavier. */
/* ---------- Les jetons « &&dépôt » ----------
   Choisir ses dépôts dans la modale, c'est un combo par ligne, quarante noms, trois fois par
   jour. On les nomme donc DANS la demande, au fil de la frappe : `&&tarification` ajoute le
   dépôt dont le nom contient « tarification », `&&tarification&feature/x` pose aussi sa branche
   (« @ » accepté à la place de « & »). Quatre caractères au moins avant d'agir — à deux lettres,
   tout correspond. Un seul dépôt correspond → la ligne apparaît tout de suite ; plusieurs → le
   menu de l'autocomplétion propose, et c'est Entrée qui tranche : jamais deux dépôts ajoutés
   d'un coup pour un jeton flou, l'agent part sur ce qu'on a vu.

   LE JETON EST LA SÉLECTION, pas un déclencheur : il reste dans la demande tant qu'on rédige,
   et la soumission le retire du texte envoyé (`retirerJetonsDepots`). L'effacer retire la
   ligne qu'il avait posée — sauf si sa branche a été touchée à la main, signe qu'on y tient. */
const JETON_DEPOT_MIN = 4;
/* `(^|[\s(])` : un jeton commence une ligne ou suit une espace — `a&&b` dans du code n'en est
   pas un. Le nom accepte ce qu'un chemin de projet accepte ; la branche s'arrête à l'espace. */
const JETON_DEPOT_RE = /(^|[\s(])&&([\w./-]+)(?:[&@]([^\s,;)]+))?/g;

function jetonsDepots(texte) {
  const out = [];
  for (const m of String(texte || '').matchAll(JETON_DEPOT_RE)) {
    out.push({ nom: m[2], branche: m[3] || '', debut: m.index + m[1].length, fin: m.index + m[0].length });
  }
  return out;
}

/* Les dépôts qu'un nom désigne : le nom exact (complet ou dernier segment) l'emporte sur les
   contenances, sinon `&&api` hésiterait entre `grp/api` et `grp/api-core` pour toujours. */
function depotsPourJeton(nom) {
  const q = String(nom || '').toLowerCase();
  if (q.length < JETON_DEPOT_MIN) return [];
  const exacts = repoOptions.filter((r) => { const p = r.project.toLowerCase(); return p === q || p.slice(p.lastIndexOf('/') + 1) === q; });
  if (exacts.length === 1) return exacts;
  return repoOptions.filter((r) => r.project.toLowerCase().includes(q));
}

/* Le texte envoyé à l'agent : sans les jetons, sans les doubles espaces qu'ils laissent. */
function retirerJetonsDepots(texte) {
  return String(texte || '')
    .replace(JETON_DEPOT_RE, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/* Ce que les jetons ont posé : dépôt → { nom du jeton, branche posée }. Mémoire du script et non
   du DOM : les lignes se reconstruisent à chaque ajout, un attribut n'y survivrait pas. */
let jetonsPoses = new Map();
function oublierJetonsDepots() { jetonsPoses = new Map(); }
const synchroniserJetonsDepotsDebounce = debounce(() => synchroniserJetonsDepots(), 300);

function synchroniserJetonsDepots() {
  const f = $('#taskForm');
  const modale = $('#taskModal');
  if (!f || !f.prompt || !modale || modale.hidden) return;
  if (taskKind !== 'code' && taskKind !== 'explore') return;
  if (!repoOptions.length) return;
  const voulus = new Map();   // repo_id → { nom, branche }
  for (const j of jetonsDepots(f.prompt.value)) {
    const cibles = depotsPourJeton(j.nom);
    if (cibles.length !== 1) continue;   // ambigu : le menu, pas une devinette
    voulus.set(cibles[0].id, { nom: j.nom, branche: j.branche });
  }
  const lignes = $$('#targetRows .target-row');
  const idDe = (row) => Number((row.querySelector('.t-repo') || {}).value || 0);
  let aRendre = false;
  const courantes = readTargetRows();

  /* Les lignes qu'un jeton disparu avait posées : retirées — sauf si leur branche a été écrite
     à la main (ni celle du jeton, ni la proposition `ai/…`) : on y tient, elle reste. */
  for (const row of lignes) {
    const id = idDe(row);
    if (!id || !jetonsPoses.has(id) || voulus.has(id)) continue;
    const pose = jetonsPoses.get(id);
    jetonsPoses.delete(id);
    const champ = row.querySelector('.t-branch');
    const valeur = champ ? champ.value.trim() : '';
    if (valeur && valeur !== pose.branche && (!champ || champ.dataset.propose !== '1')) continue;
    /* La DERNIÈRE ligne ne part pas : une session veut au moins un projet, et la remplacer par
       une ligne neuve effacerait la branche qu'on venait de poser. Elle reste telle quelle,
       devenue une ligne ordinaire. */
    if (courantes.length <= 1) continue;
    const i = courantes.findIndex((t) => t.repo_id === id);
    if (i >= 0) { courantes.splice(i, 1); aRendre = true; }
  }
  // Les jetons nouveaux : une ligne par dépôt qui n'en a pas encore ; la branche du jeton avec.
  const nouveaux = [];
  for (const [id, j] of voulus) {
    const deja = courantes.find((t) => t.repo_id === id);
    if (deja) {
      if (j.branche && deja.branch !== j.branche) { deja.branch = j.branche; aRendre = true; }
    } else {
      courantes.push({ repo_id: id, branch: j.branche });
      nouveaux.push(id); aRendre = true;
    }
    jetonsPoses.set(id, { nom: j.nom, branche: j.branche });
  }
  if (!aRendre) return;
  /* Le re-rendu recrée les champs : une branche seulement PROPOSÉE (`ai/…` depuis le libellé,
     `data-propose`) repart vide pour être re-proposée telle quelle ; une branche écrite à la
     main voyage sans changer. */
  for (const row of lignes) {
    const champ = row.querySelector('.t-branch');
    const t = champ && champ.dataset.propose === '1' ? courantes.find((x) => x.repo_id === idDe(row)) : null;
    if (t) t.branch = '';
  }
  /* Une liste vidée par le dernier jeton retiré garde une ligne prête à choisir, comme
     « Tout retirer » ; la proposition de branche ne touche pas une branche venue d'un jeton. */
  renderTargetRows(courantes);
  for (const row of $$('#targetRows .target-row')) {
    const id = idDe(row);
    const j = jetonsPoses.get(id);
    const champ = row.querySelector('.t-branch');
    if (j && j.branche && champ) { champ.value = j.branche; champ.dataset.touche = '1'; delete champ.dataset.propose; }
    if (nouveaux.includes(id)) {
      row.classList.add('t-row-jeton');
      setTimeout(() => row.classList.remove('t-row-jeton'), 1500);
    }
  }
  proposerBranche();
  majVerificateursSession(); majSkillsSession();
}

/* Débouncé : on juge le jeton quand la frappe marque une pause, pas à chaque lettre — entre
   `&&tari` et `&&tarif`, l'ensemble des dépôts visés change, et une ligne qui clignote n'aide pas. */
document.addEventListener('input', (e) => {
  if (!e.target.matches || !e.target.matches('#taskPrompt')) return;
  synchroniserJetonsDepotsDebounce();
});
