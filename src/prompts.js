'use strict';
/* Gabarits de prompt par défaut, dans les deux langues (i18n.md lot 5, option 1 :
   « les rapports suivent la langue de l'interface »).

   C'est le choix recommandé par le plan, et celui qu'on attend d'un changement de
   langue : une interface anglaise remplie de rapports français serait incohérente.

   ⚠ Piège n°4 du plan : changer de langue ne doit JAMAIS écraser un prompt que
   l'utilisateur a personnalisé. On ne remplace donc un gabarit que s'il est resté
   RIGOUREUSEMENT IDENTIQUE au défaut d'une des langues connues — c'est-à-dire s'il
   n'a jamais été touché. Dès qu'un caractère diffère, le prompt est considéré
   comme personnalisé et laissé intact. */

/* Le nom du skill est ÉCRIT DANS LE GABARIT, il n'a plus de champ à lui. Un réglage séparé
   obligeait à comprendre qu'il alimentait un `{skill}` caché dans un texte qu'on peut de toute
   façon réécrire : le gabarit est l'endroit où l'on choisit ce qu'on demande à l'IA, le nom du
   skill en fait partie. Les gabarits déjà personnalisés sont migrés (voir `src/db.js`). */
const PROMPTS = {
  fr: {
    prompt_review:
      'Utilise le skill git-review pour faire la revue de code UNIQUEMENT des changements ' +
      'de la branche {source} par rapport à {target} (le diff est dans le fichier {diff_file}). ' +
      'Ne parse pas tout le dépôt, concentre-toi sur ces changements. ' +
      'Produis un rapport de revue clair en Markdown (français) : problèmes, risques, ' +
      "suggestions concrètes avec fichier et ligne quand c'est possible, et une note globale.",
    prompt_explain:
      'Explique de façon pédagogique ce que fait la merge request représentée par le diff ' +
      'du fichier {diff_file} (branche {source} vers {target}). Objectif : que je comprenne ' +
      "et que je progresse techniquement. En Markdown (français) : résumé de l'intention, " +
      'mécanismes/patterns utilisés, points à retenir, et ce que je pourrais approfondir.',
    prompt_modify:
      'Voici un rapport de revue existant :\n\n{previous}\n\n' +
      'Applique la demande suivante et renvoie le rapport complet mis à jour en Markdown (français) :\n{instruction}',
  },
  en: {
    prompt_review:
      'Use the git-review skill to code-review ONLY the changes ' +
      'on branch {source} compared to {target} (the diff is in the file {diff_file}). ' +
      'Do not parse the whole repository, focus on these changes. ' +
      'Produce a clear review report in Markdown (English): problems, risks, ' +
      'concrete suggestions with file and line where possible, and an overall score.',
    prompt_explain:
      'Explain, in a way that teaches, what the merge request represented by the diff ' +
      'in file {diff_file} does (branch {source} into {target}). Goal: that I understand it ' +
      'and improve technically. In Markdown (English): summary of the intent, ' +
      'mechanisms/patterns used, key takeaways, and what I could dig into next.',
    prompt_modify:
      'Here is an existing review report:\n\n{previous}\n\n' +
      'Apply the following request and return the complete updated report in Markdown (English):\n{instruction}',
  },
};

/* LES CONSIGNES PERMANENTES : ce qu'on redit à chaque session sans jamais vouloir le retaper.
   « Commente en français », « lance `npm run check` avant de committer », « pas de dépendance
   nouvelle ». Les recopier dans chaque prompt marche jusqu'au jour où on oublie — et c'est
   toujours celui-là qu'on relit trois heures plus tard.

   Elles s'ajoutent APRÈS la tâche : ce qu'on demande d'abord, comment le faire ensuite. Et
   avant le bloc <<<QUESTIONS>>>, qui est un protocole de réponse et doit rester le dernier mot.
   Une seule définition pour les sessions de dépôt et le codage hors dépôt : deux copies
   dériveraient, et personne ne s'en apercevrait avant de lire un prompt archivé. */
function avecConsignes(prompt, consignes) {
  const c = String(consignes == null ? '' : consignes).trim();
  return c ? `${prompt}\n\nConsignes permanentes, valables pour toutes les sessions :\n${c}` : prompt;
}

const FIELDS = ['prompt_review', 'prompt_explain', 'prompt_modify'];

// Un gabarit est « au défaut » s'il correspond au défaut de N'IMPORTE quelle langue
// (sinon, basculer fr → en → fr figerait les prompts après le premier aller-retour).
function isDefault(field, value) {
  const v = String(value == null ? '' : value);
  if (!v.trim()) return true;                     // vide = jamais renseigné
  return Object.keys(PROMPTS).some((l) => PROMPTS[l][field] === v);
}

/* Renvoie le patch de prompts à appliquer pour passer à `lang`, en ne touchant
   qu'aux gabarits non personnalisés. Renvoie {} s'il n'y a rien à faire. */
function promptsFor(lang, current) {
  const target = PROMPTS[lang];
  if (!target) return {};
  const patch = {};
  for (const f of FIELDS) {
    if (isDefault(f, current[f]) && current[f] !== target[f]) patch[f] = target[f];
  }
  return patch;
}

module.exports = { PROMPTS, FIELDS, isDefault, promptsFor, avecConsignes };
