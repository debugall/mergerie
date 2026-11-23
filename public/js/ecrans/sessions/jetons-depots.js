'use strict';
/* Les jetons « &&dépôt » de la demande : un projet s'ajoute à la session sans quitter le clavier. */
/* ---------- Les jetons « &&dépôt » ----------
   Choisir ses dépôts dans la modale, c'est un combo par ligne, quarante noms, trois fois par
   jour. On les nomme donc DANS la demande, au fil de la frappe : `&&tarification` ajoute le
   dépôt dont le nom contient « tarification », `&&tarification:feature/x` pose aussi sa branche,
   `&&tarification:feature/x<develop` la crée depuis `develop` (codage). Quatre caractères au moins avant d'agir — à deux lettres,
   tout correspond. Un seul dépôt correspond → la ligne apparaît tout de suite ; plusieurs → le
   menu de l'autocomplétion propose, et c'est Entrée qui tranche : jamais deux dépôts ajoutés
   d'un coup pour un jeton flou, l'agent part sur ce qu'on a vu.

   LE JETON EST LA SÉLECTION, pas un déclencheur : il reste dans la demande tant qu'on rédige,
   et la soumission le retire du texte envoyé (`retirerJetonsDepots`). L'effacer retire la
   ligne qu'il avait posée — sauf si sa branche a été touchée à la main, signe qu'on y tient.

   `&&*:feature/x` — « * », tous — pose cette branche sur TOUTES les lignes : une session sur
   quatre dépôts porte le même nom de branche quatre fois, et le taper quatre fois était la
   corvée suivante. Une branche nommée dans le jeton d'un dépôt (`&&nom:branche`) l'emporte sur
   la globale ; effacer `&&*…` rend aux lignes leur proposition (le libellé) ou le vide. */
/* L'analyse du texte (expressions, résolution, retrait) vit dans `runtime/jetons-runtime.js`,
   partagée avec Node ; ici, ce qui pose les lignes de la modale. */
const depotsPourJeton = (nom) => JETONSRT.depotsPourJeton(nom, repoOptions);
const brancheGlobaleJeton = (texte) => JETONSRT.brancheGlobaleJeton(texte);
const retirerJetonsDepots = (texte) => JETONSRT.retirerJetonsDepots(texte);

/* LES JETONS QUI NE POSENT RIEN SE DISENT. Taper `&&tari` ouvre le menu ; mais un jeton venu
   d'un ticket Jira (sa description, son commentaire « #tech ») n'a jamais été tapé : ambigu ou
   inconnu, il était ignoré sans un mot, et la session partait sur un dépôt de moins. Le jeton
   sous le curseur n'est pas jugé — on est en train de l'écrire, le menu s'en charge. */
function noterJetonsDepots(r) {
  const note = $('#taskJetonsNote');
  if (!note) return;
  const lignes = [
    ...r.inconnus.map((nom) => tr('task.jeton.inconnu', { nom })),
    ...r.ambigus.map((a) => tr('task.jeton.ambigu', { nom: a.nom, n: a.projets.length, projets: a.projets.slice(0, 5).join(', ') })),
    ...r.court.map((nom) => tr('task.jeton.court', { nom })),
  ];
  note.textContent = lignes.join(' ');
  note.hidden = !lignes.length;
}

/* Ce que les jetons ont posé : dépôt → { nom du jeton, branche posée }. Mémoire du script et non
   du DOM : les lignes se reconstruisent à chaque ajout, un attribut n'y survivrait pas. */
let jetonsPoses = new Map();
/* Les branches de DÉPART posées par un jeton (`&&nom:branche<depart`, `&&*<depart`) : dépôt → valeur.
   Le jeton parti ou changé, le champ qui la montre encore repart à sa proposition (le dernier départ
   retenu pour ce dépôt) ; un départ réécrit à la main ne bouge pas. */
let departsPoses = new Map();
function oublierJetonsDepots() {
  jetonsPoses = new Map(); departsPoses = new Map();
  const note = $('#taskJetonsNote'); if (note) { note.hidden = true; note.textContent = ''; }
}
const synchroniserJetonsDepotsDebounce = debounce(() => synchroniserJetonsDepots(), 300);

function synchroniserJetonsDepots() {
  const f = $('#taskForm');
  const modale = $('#taskModal');
  if (!f || !f.prompt || !modale || modale.hidden) return;
  if (taskKind !== 'code' && taskKind !== 'explore') return;
  if (!repoOptions.length) return;
  // repo_id → { nom, branche } ; un jeton ambigu reste au menu, pas à une devinette.
  const enCours = document.activeElement === f.prompt ? f.prompt.selectionStart : -1;
  const r = JETONSRT.resoudreJetonsDepots(f.prompt.value, repoOptions, (j) => j.fin === enCours);
  noterJetonsDepots(r);
  const tous = JETONSRT.resoudreJetonsDepots(f.prompt.value, repoOptions);
  const voulus = tous.voulus;
  const lignes = $$('#targetRows .target-row');
  const idDe = (row) => Number((row.querySelector('.t-repo') || {}).value || 0);
  const globale = brancheGlobaleJeton(f.prompt.value);
  /* La globale se juge sur CE QUE MONTRENT LES CHAMPS, pas sur une mémoire : la proposition
     de branche (`proposerBranche`, synchrone) l'a souvent déjà posée avant cette synchro
     débouncée, et une mémoire la croirait neuve ou la croirait partie. Une ligne sans branche
     de jeton qui ne la porte pas, ou une proposition périmée (le jeton effacé, le champ
     montre encore sa branche) : on re-rend. */
  const proposition = propositionBranche();
  let aRendre = lignes.some((row) => {
    const champ = row.querySelector('.t-branch');
    if (!champ) return false;
    const j = voulus.get(idDe(row));
    if (j && j.branche) return champ.value !== j.branche;
    if (globale) return champ.value !== globale;
    return champ.dataset.propose === '1' && champ.value !== proposition;
  });
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
  // La branche de départ n'existe qu'en codage : une exploration lit la branche de sa ligne.
  if (taskKind === 'code') {
    for (const t of courantes) {
      const j = voulus.get(t.repo_id);
      const voulu = (j && j.depart) || tous.globaleDepart;
      const pose = departsPoses.get(t.repo_id);
      if (voulu) {
        if (t.base_branch !== voulu) { t.base_branch = voulu; aRendre = true; }
        departsPoses.set(t.repo_id, voulu);
      } else if (pose) {
        departsPoses.delete(t.repo_id);
        if (t.base_branch === pose) { t.base_branch = ''; aRendre = true; }
      }
    }
  }
  if (!aRendre) return;
  /* Le re-rendu recrée les champs : une branche seulement PROPOSÉE (`ai/…` depuis le libellé,
     ou la globale `&&*…`, `data-propose`) repart vide pour être re-proposée telle quelle — ou
     plus du tout, si le jeton qui la posait est parti ; une branche écrite à la main voyage
     sans changer. */
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
    /* La globale vaut pour TOUTE ligne sans branche de jeton, écrite à la main comprise : le
       jeton est un ordre, pas une suggestion. Marquée proposée, elle repart avec lui. */
    else if (globale && champ) { champ.value = globale; champ.dataset.propose = '1'; delete champ.dataset.touche; }
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
