/* Autolink des notes — le MÊME code tourne dans le navigateur et dans Node (même montage
   que i18n-runtime.js et ansi-runtime.js).
 *
 * Ce qu'on écrit dans une note, ce sont les identifiants du quotidien : « voir !214 »,
 * « bloqué par PROJ-720 ». Les retranscrire en liens à la main serait le genre de corvée
 * qui fait abandonner l'outil. Ils deviennent donc cliquables AU RENDU — le stockage,
 * lui, reste du texte brut : on relit ses notes ailleurs, et un `.md` exporté ne doit pas
 * charrier du HTML.
 *
 * DEUX RÈGLES DE SÛRETÉ, dans cet ordre, et l'ordre est le point :
 *   1. le contenu est ÉCHAPPÉ par l'appelant ;
 *   2. l'autolink s'applique SUR L'ÉCHAPPÉ, et n'injecte que des balises qu'il fabrique
 *      lui-même, à partir de valeurs numériques ou d'une clé validée par sa regex.
 * Aucun fragment de la note ne peut donc devenir du balisage. C'est pour cela que cette
 * fonction prend du HTML déjà échappé et non du texte : l'inverse inviterait à échapper
 * après, c'est-à-dire à ré-échapper les liens qu'on vient de poser.
 *
 * HONNÊTETÉ DE LA RÉSOLUTION. Un `!214` peut désigner la MR 214 de trois dépôts différents.
 * On ne devine pas : un seul candidat → lien direct ; plusieurs → lien vers la recherche
 * pré-remplie, qui montre les candidats ; aucun → texte simple, sans lien mort. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NOTESRT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /* Un `!` collé à un nombre. La garde `(^|[^\w])` écarte le faux positif le plus courant :
     `a!=214`, `x!==214` — une comparaison dans une note technique, où le `!` appartient à
     l'opérateur et non à une merge request. */
  const MR_RE = /(^|[^\w])!(\d+)\b/g;
  /* Une clé Jira : deux lettres majuscules au moins, puis un tiret et des chiffres. La
     garde arrière (`(?![\w-])`) empêche `PROJ-720-suite` d'être coupé en deux. */
  const TICKET_RE = /(^|[^\w-])([A-Z][A-Z0-9]+-\d+)(?![\w-])/g;

  /* Transforme les références en liens. `index` :
       { mrs: { "214": [{id, project}, …] }, jira: true|false }
     Les liens portent leur cible en `data-` plutôt qu'en `href` : le module ne sait pas où
     vivent les onglets, et le front les intercepte par délégation — comme partout ailleurs
     dans l'application. */
  function autolink(htmlEchappe, index) {
    const mrs = (index && index.mrs) || {};
    const jira = !!(index && index.jira);
    let out = String(htmlEchappe == null ? '' : htmlEchappe);

    out = out.replace(MR_RE, (m, avant, iid) => {
      const cands = mrs[iid];
      if (!cands || !cands.length) return m;              // inconnue : pas de lien mort
      if (cands.length === 1) {
        return `${avant}<a href="#" class="note-link" data-note-mr="${cands[0].id}" `
          + `title="${attr(cands[0].project || '')}">!${iid}</a>`;
      }
      /* Plusieurs dépôts portent ce numéro : on l'annonce (le titre liste les candidats)
         et on emmène vers la recherche plutôt que d'en désigner un au hasard. */
      return `${avant}<a href="#" class="note-link note-link-multi" data-note-mr-search="!${iid}" `
        + `title="${attr(cands.map((c) => c.project).filter(Boolean).join(', '))}">!${iid}</a>`;
    });

    if (jira) {
      out = out.replace(TICKET_RE, (m, avant, key) => (
        `${avant}<a href="#" class="note-link" data-note-ticket="${attr(key)}">${key}</a>`
      ));
    }
    return out;
  }

  // Valeur d'attribut : le contenu est déjà échappé, mais les clés et projets viennent de
  // la base — on ne les recopie jamais bruts dans un attribut.
  function attr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  return { autolink, MR_RE, TICKET_RE };
}));
