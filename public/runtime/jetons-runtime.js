'use strict';
/* Les jetons « &&dépôt » d'un texte — le MÊME code tourne dans le navigateur et dans Node (même
   montage que notes-runtime.js).
 *
 * `&&tarification` désigne le dépôt dont le nom contient « tarification », `&&tarification:feature/x`
 * pose aussi sa branche de travail, `&&tarification:feature/x<develop` la crée depuis `develop`,
 * `&&tarification<develop` pose le départ seul. `&&*` vaut pour tous les dépôts : `&&*:feature/x<develop`.
 * Un seul préfixe, un signe par rôle — « : » la branche, « < » « depuis » : compter des esperluettes
 * (`&&&`, `&&&&`) pour dire « tous » ou « départ » ne se retenait pas. Une ligne qui commence par
 * `&&>` est la DEMANDE — ce que l'agent doit faire —, écrite dans le ticket à côté des dépôts.
 *
 * Le texte vient de la demande tapée, mais aussi du ticket Jira repris en contexte — sa description
 * et son commentaire « #tech » : l'équipe y nomme les dépôts touchés, et la session se prépare sans
 * les choisir.
 *
 * Ici, rien que du texte et une liste de dépôts `{ id, project }` : ni DOM, ni état. Ce qui pose
 * les lignes de la modale reste dans `js/ecrans/sessions/jetons-depots.js`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JETONSRT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // Quatre caractères au moins avant d'agir — à deux lettres, tout correspond.
  const JETON_DEPOT_MIN = 4;
  /* `(^|[\s(`])` : un jeton commence une ligne, suit une espace ou ouvre un code en ligne — un
     ticket Jira l'écrit volontiers `&&api:feature/x`, en code, pour que l'éditeur n'y touche pas ;
     `a&&b` dans du code n'en est pas un. Le nom accepte ce qu'un chemin de projet accepte (« * »
     non : c'est « tous »). Une branche s'arrête à l'espace, au backtick, à « : » — que git interdit
     dans un nom de branche — et à « < », qui ouvre le départ. Ni le nom ni une branche ne finissent
     par un point : celui d'une fin de phrase (« dans &&tarif. ») n'en fait pas partie, et git refuse
     d'ailleurs une branche qui finit ainsi. */
  const BR = '[^\\s,;)`:<]*[^\\s,;)`.:<]';
  const JETON_DEPOT_RE = new RegExp(`(^|[\\s(\`])&&([\\w./-]*\\w)(?::(${BR}))?(?:<(${BR}))?`, 'g');
  const JETON_BRANCHE_RE = new RegExp(`(^|[\\s(\`])&&\\*(?::(${BR}))?(?:<(${BR}))?`, 'g');

  function jetonsDepots(texte) {
    const out = [];
    for (const m of String(texte || '').matchAll(JETON_DEPOT_RE)) {
      out.push({ nom: m[2], branche: m[3] || '', depart: m[4] || '', debut: m.index + m[1].length, fin: m.index + m[0].length });
    }
    return out;
  }

  /* Les dépôts qu'un nom désigne : le nom exact (complet ou dernier segment) l'emporte sur les
     contenances, sinon `&&api` hésiterait entre `grp/api` et `grp/api-core` pour toujours. */
  function depotsPourJeton(nom, depots) {
    const q = String(nom || '').toLowerCase();
    if (q.length < JETON_DEPOT_MIN) return [];
    const liste = depots || [];
    const exacts = liste.filter((r) => { const p = String(r.project || '').toLowerCase(); return p === q || p.slice(p.lastIndexOf('/') + 1) === q; });
    if (exacts.length === 1) return exacts;
    return liste.filter((r) => String(r.project || '').toLowerCase().includes(q));
  }

  // La branche que `&&*:branche` pose sur toutes les lignes — la dernière écrite si plusieurs.
  function brancheGlobaleJeton(texte) {
    let b = '';
    for (const m of String(texte || '').matchAll(JETON_BRANCHE_RE)) if (m[2]) b = m[2];
    return b;
  }
  // La branche de départ que `&&*<depart` pose sur toutes les lignes — la dernière écrite.
  function departGlobalJeton(texte) {
    let b = '';
    for (const m of String(texte || '').matchAll(JETON_BRANCHE_RE)) if (m[3]) b = m[3];
    return b;
  }

  /* LA DEMANDE ÉCRITE DANS LE TICKET : les lignes qui commencent par `&&>`, réunies dans l'ordre,
     sans le préfixe. Un préfixe PAR LIGNE, pas un bloc ouvert puis fermé : Jira fait de chaque
     paragraphe une ligne à part, et une liste à puces passe telle quelle (`&&> - …`). */
  const DEMANDE_RE = /^[ \t]*&&>[ \t]?(.*)$/gm;
  function demandeDe(texte) {
    return [...String(texte || '').matchAll(DEMANDE_RE)].map((m) => m[1].replace(/[ \t]+$/, '')).join('\n').trim();
  }
  // Le texte sans ses lignes `&&>` : le contexte ne répète pas la consigne qu'on vient d'en tirer.
  function retirerDemande(texte) {
    return String(texte || '').replace(DEMANDE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* Le texte envoyé à l'agent : sans les jetons, sans les doubles espaces qu'ils laissent, ni le
     code en ligne vidé (``) d'un jeton écrit entre backticks — trois backticks restent un bloc. Une
     ligne `&&>` restée dans la demande perd son préfixe et garde son texte. */
  function retirerJetonsDepots(texte) {
    return String(texte || '')
      .replace(DEMANDE_RE, (m, l) => m.slice(0, m.indexOf('&&>')) + l)
      .replace(JETON_BRANCHE_RE, '$1')
      .replace(JETON_DEPOT_RE, '$1')
      .replace(/(^|[^`])``(?!`)/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  /* CE QUE LES JETONS D'UN TEXTE DÉSIGNENT : `voulus` (id → { nom, branche }) pour ceux qui ne
     désignent qu'un dépôt ; les autres, à montrer plutôt qu'à deviner — `court` (moins de quatre
     caractères), `inconnus` (aucun dépôt), `ambigus` (plusieurs, avec leurs noms).
     LA DERNIÈRE BRANCHE ÉCRITE POUR UN DÉPÔT L'EMPORTE. Depuis un ticket, la demande se lit dans l'ordre
     description, commentaire « #tech », puis ce qu'on tape (de même pour la branche de départ) : la précision technique passe devant
     la description, et ce qu'on écrit soi-même devant les deux. `exclure(j)` écarte un jeton
     — celui qu'on est en train de taper, que le menu de l'autocomplétion couvre déjà. */
  function resoudreJetonsDepots(texte, depots, exclure) {
    const voulus = new Map();
    const court = []; const inconnus = []; const ambigus = [];
    for (const j of jetonsDepots(texte)) {
      if (exclure && exclure(j)) continue;
      if (j.nom.length < JETON_DEPOT_MIN) { court.push(j.nom); continue; }
      const cibles = depotsPourJeton(j.nom, depots);
      if (!cibles.length) inconnus.push(j.nom);
      else if (cibles.length > 1) ambigus.push({ nom: j.nom, projets: cibles.map((r) => r.project) });
      else {
        // Un jeton sans branche nomme le dépôt sans retirer celles qu'un jeton précédent posait.
        const avant = voulus.get(cibles[0].id) || {};
        voulus.set(cibles[0].id, { nom: j.nom, branche: j.branche || avant.branche || '', depart: j.depart || avant.depart || '' });
      }
    }
    const uniques = (l) => [...new Set(l)];
    const ambigusUniques = [...new Map(ambigus.map((a) => [a.nom, a])).values()];
    return { voulus, court: uniques(court), inconnus: uniques(inconnus), ambigus: ambigusUniques,
      globale: brancheGlobaleJeton(texte), globaleDepart: departGlobalJeton(texte) };
  }

  return {
    JETON_DEPOT_MIN, JETON_DEPOT_RE, JETON_BRANCHE_RE,
    jetonsDepots, depotsPourJeton, brancheGlobaleJeton, departGlobalJeton, retirerJetonsDepots, resoudreJetonsDepots,
    demandeDe, retirerDemande,
  };
}));
