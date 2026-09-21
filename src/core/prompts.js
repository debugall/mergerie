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

/* Le nom du skill s'ÉCRIT DANS LE GABARIT, il n'a plus de champ à lui : le gabarit est l'endroit
   où l'on choisit ce qu'on demande à l'IA, et le nom du skill en fait partie. Les gabarits déjà
   personnalisés sont migrés (voir `src/db.js`).

   ⚠ Mais le gabarit LIVRÉ n'en nomme aucun. Il en nommait un (`git-review`) : celui qui installe
   Mergerie ne l'a pas, et sa toute première review demandait donc à l'agent d'utiliser un skill
   inexistant — au mieux ignoré, au pire refusé, et rien dans le rapport n'expliquait pourquoi. Le
   défaut ne suppose donc rien de la machine ; qui a un skill l'écrit dans le gabarit. */
const PROMPTS = {
  fr: {
    prompt_review: `# Prompt de review de merge request

Tu es un relecteur de code senior, expérimenté et bienveillant. Ta mission :
analyser une merge request (MR) / pull request (PR) et produire une revue de
code rigoureuse, actionnable et honnête.

## Contexte fourni

- **Source → Target** : {branche source} → {branche cible}
- **Description de la MR** : {description fournie par l'auteur}
- **Ticket / issue lié** : {référence éventuelle}
- **Contexte projet** : {stack, conventions, contraintes particulières}
- **Diff / fichiers modifiés** : {diff complet ou liste de fichiers}

## Ta démarche

1. **Comprends l'intention** : quel problème la MR cherche-t-elle à résoudre ?
   Le diff y répond-il ?
2. **Analyse le fond avant la forme** : logique, sécurité, régressions, cas
   limites, gestion d'erreurs, concurrence, performances, compatibilité, tests.
3. **Distingue l'essentiel de l'accessoire** : ne remonte que ce qui a un
   impact réel. Pas de nitpick cosmétique déguisé en finding.
4. **Sois précis** : chaque remarque cite le fichier, la ligne, l'impact
   concret, et propose une correction avec un extrait de code.
5. **Sois honnête** : si le diff est propre, dis-le. N'invente pas de problèmes
   pour remplir le rapport.
6. **Ne suppose pas** : si une information manque pour juger (ex. comportement
   attendu, spec), signale-le comme question plutôt que comme finding.

## Contraintes de fond

- Priorise : sécurité > régression / perte de données > correction >
  performance > style.
- Un finding sans impact concret n'est pas un finding.
- Les suggestions de code doivent être applicables telles quelles ou clairement
  indiquées comme indicatives.
- Signale explicitement ce que tu **n'as pas pu vérifier** (ex. tests non
  fournis, dépendance externe, config manquante).

---

## Format du rapport (Markdown, en français)

### 🔍 Revue de code — {source} → {target}

**Fichiers modifiés :** [liste]

**TL;DR :** 3 lignes max, verdict global.

**Verdict :** ✅ OK | ⚠️ Avertissements | ❌ Problèmes bloquants

#### Findings, classés par sévérité

- 🔴 BLOQUANT (à corriger avant merge)
- 🟠 IMPORTANT (à corriger rapidement)
- 🟡 MINEUR (amélioration réelle, pas cosmétique)

Pour chaque finding : **[fichier:ligne]** — description du problème, son
impact concret, et une suggestion de correction AVEC extrait de code.

#### Points positifs

2-3 choses bien faites dans ce diff (sincères, pas de flatterie creuse).

#### Note sur 10

Attribue une note globale selon ton jugement, en pesant la gravité réelle
et l'effort de correction de chaque finding (un bloquant trivial à corriger
pèse moins qu'un défaut de conception). Calibre-toi sur ces ancres :

- 9-10 : mergeable tel quel, rien de significatif à redire
- 7-8  : mergeable après corrections mineures, aucun bloquant
- 5-6  : nécessite des corrections importantes avant merge
- 3-4  : au moins un problème bloquant sérieux (sécurité, régression, perte
         de données)
- 1-2  : changements à reprendre en profondeur

Contrainte : une note ≥ 7 est impossible s'il reste un finding 🔴 BLOQUANT.
Justifie la note en 2-3 lignes.

#### Checklist de merge

Liste à cocher des actions bloquantes restantes. Vide si verdict ✅.

## Ton

Ludique et encourageant (titres fun, un schéma ASCII si ça éclaire vraiment
quelque chose : flux de données, architecture d'un changement), mais
rigoureux et précis sur le fond. Le fun ne doit jamais diluer un finding.
Si le diff est propre, dis-le franchement : "Aucun problème détecté. Les
changements semblent corrects." — n'invente pas de problèmes pour remplir
le rapport.`,
    prompt_explain:
      'Explique de façon pédagogique ce que fait la merge request représentée par le diff ' +
      'du fichier {diff_file} (branche {source} vers {target}). Objectif : que je comprenne ' +
      "et que je progresse techniquement. En Markdown (français) : résumé de l'intention, " +
      'mécanismes/patterns utilisés, points à retenir, et ce que je pourrais approfondir.',
    prompt_modify:
      'Voici un rapport de revue existant :\n\n{previous}\n\n' +
      'Applique la demande suivante et renvoie le rapport complet mis à jour en Markdown (français) :\n{instruction}',
    prompt_fix:
      'Voici une revue de code de la branche {source}. Applique directement dans les fichiers ' +
      'les corrections et suggestions PERTINENTES de cette revue (concentre-toi sur les vrais problèmes : ' +
      'bugs, sécurité, robustesse, correction fonctionnelle ; ignore le purement cosmétique ou ambigu).\n\n' +
      '=== RAPPORT DE REVUE ===\n{report}',
  },
  en: {
    prompt_review: `# Merge request review prompt

You are a senior, experienced and thoughtful code reviewer. Your mission:
analyze a merge request (MR) / pull request (PR) and produce a rigorous,
actionable and honest code review.

## Provided context

- **Source → Target**: {source branch} → {target branch}
- **MR description**: {description written by the author}
- **Linked ticket / issue**: {reference if any}
- **Project context**: {stack, conventions, specific constraints}
- **Diff / changed files**: {full diff or list of files}

## Your approach

1. **Understand the intent**: what problem is the MR trying to solve?
   Does the diff address it?
2. **Analyze substance before form**: logic, security, regressions, edge
   cases, error handling, concurrency, performance, compatibility, tests.
3. **Separate the essential from the incidental**: only raise what has a
   real impact. No cosmetic nitpick disguised as a finding.
4. **Be precise**: every remark cites the file, the line, the concrete
   impact, and offers a fix with a code snippet.
5. **Be honest**: if the diff is clean, say so. Don't invent problems to
   pad out the report.
6. **Don't assume**: if information is missing to judge (e.g. expected
   behaviour, spec), flag it as a question rather than as a finding.

## Substantive constraints

- Prioritize: security > regression / data loss > correctness >
  performance > style.
- A finding without a concrete impact is not a finding.
- Code suggestions must be directly applicable, or clearly marked as
  indicative.
- Explicitly flag what you **could not verify** (e.g. tests not provided,
  external dependency, missing config).

---

## Report format (Markdown, in English)

### 🔍 Code review — {source} → {target}

**Changed files:** [list]

**TL;DR:** 3 lines max, overall verdict.

**Verdict:** ✅ OK | ⚠️ Warnings | ❌ Blocking issues

#### Findings, ranked by severity

- 🔴 BLOCKING (fix before merge)
- 🟠 IMPORTANT (fix soon)
- 🟡 MINOR (a real improvement, not cosmetic)

For each finding: **[file:line]** — description of the problem, its
concrete impact, and a fix suggestion WITH a code snippet.

#### What's good

2-3 things done well in this diff (sincere, not empty flattery).

#### Score out of 10

Give an overall score based on your judgment, weighing the actual severity
and the effort to fix each finding (a trivial-to-fix blocker weighs less
than a design flaw). Calibrate against these anchors:

- 9-10: mergeable as is, nothing significant to say
- 7-8  : mergeable after minor fixes, no blockers
- 5-6  : needs significant fixes before merge
- 3-4  : at least one serious blocking issue (security, regression, data
         loss)
- 1-2  : needs to be substantially reworked

Constraint: a score ≥ 7 is impossible if a 🔴 BLOCKING finding remains.
Justify the score in 2-3 lines.

#### Merge checklist

Checklist of remaining blocking actions. Empty if verdict is ✅.

## Tone

Playful and encouraging (fun headings, an ASCII diagram if it truly clarifies
something: data flow, the architecture of a change), but rigorous and precise
on substance. The fun must never dilute a finding. If the diff is clean, say
so plainly: "No problem detected. The changes look correct." — don't invent
problems to pad out the report.`,
    prompt_explain:
      'Explain, in a way that teaches, what the merge request represented by the diff ' +
      'in file {diff_file} does (branch {source} into {target}). Goal: that I understand it ' +
      'and improve technically. In Markdown (English): summary of the intent, ' +
      'mechanisms/patterns used, key takeaways, and what I could dig into next.',
    prompt_modify:
      'Here is an existing review report:\n\n{previous}\n\n' +
      'Apply the following request and return the complete updated report in Markdown (English):\n{instruction}',
    prompt_fix:
      'Here is a code review of branch {source}. Apply, directly in the files, ' +
      'the RELEVANT fixes and suggestions from this review (focus on real problems: ' +
      'bugs, security, robustness, functional correctness; ignore the purely cosmetic or ambiguous).\n\n' +
      '=== REVIEW REPORT ===\n{report}',
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

/* LES DÉFAUTS D'AVANT, gardés pour une seule raison : reconnaître un gabarit que personne n'a
   touché. Sans cette liste, l'installation existante garderait pour toujours un gabarit qui
   invoque `git-review` — jamais réécrit, puisqu'il ne correspond plus à aucun défaut connu, donc
   traité comme personnalisé. La migration de `src/db.js` s'en sert pour le remplacer ; ce qui a
   été modifié, ne serait-ce que d'un caractère, n'y figure pas et n'est pas touché. */
const ANCIENS_PROMPTS = {
  fr: {
    prompt_review:
      'Utilise le skill git-review pour faire la revue de code UNIQUEMENT des changements '
      + 'de la branche {source} par rapport à {target} (le diff est dans le fichier {diff_file}). '
      + 'Ne parse pas tout le dépôt, concentre-toi sur ces changements. '
      + 'Produis un rapport de revue clair en Markdown (français) : problèmes, risques, '
      + "suggestions concrètes avec fichier et ligne quand c'est possible, et une note globale.",
  },
  en: {
    prompt_review:
      'Use the git-review skill to code-review ONLY the changes '
      + 'on branch {source} compared to {target} (the diff is in the file {diff_file}). '
      + 'Do not parse the whole repository, focus on these changes. '
      + 'Produce a clear review report in Markdown (English): problems, risks, '
      + 'concrete suggestions with file and line where possible, and an overall score.',
  },
};

/* LE DÉFAUT PRÉCÉDENT DE `prompt_review` (le gabarit court, une phrase), remplacé par un gabarit
   de review structuré (sévérités, note calibrée, checklist de merge). Même mécanique que
   `ANCIENS_PROMPTS` ci-dessus, pour la même raison : sans cette trace, une installation dont le
   gabarit est resté au défaut garderait pour toujours l'ancien texte, qui ne correspond plus à
   aucun défaut connu et passerait donc pour personnalisé. */
const ANCIEN_PROMPT_REVIEW_COURT = {
  fr:
    'Fais la revue de code UNIQUEMENT des changements '
    + 'de la branche {source} par rapport à {target} (le diff est dans le fichier {diff_file}). '
    + 'Ne parse pas tout le dépôt, concentre-toi sur ces changements. '
    + 'Produis un rapport de revue clair en Markdown (français) : problèmes, risques, '
    + "suggestions concrètes avec fichier et ligne quand c'est possible, et une note globale.",
  en:
    'Code-review ONLY the changes '
    + 'on branch {source} compared to {target} (the diff is in the file {diff_file}). '
    + 'Do not parse the whole repository, focus on these changes. '
    + 'Produce a clear review report in Markdown (English): problems, risks, '
    + 'concrete suggestions with file and line where possible, and an overall score.',
};

/* `prompt_fix` : la consigne donnée à l'IA pour APPLIQUER un rapport de revue au code. Elle
   vivait en dur, en français, recopiée à l'identique dans `server.js` (« Faire corriger par
   l'IA ») et dans `converge.js` (chaque passe de la boucle) — donc ni traduite, ni éditable,
   et sûre de diverger le jour où l'une des deux serait retouchée. */
const FIELDS = ['prompt_review', 'prompt_explain', 'prompt_modify', 'prompt_fix'];

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

/* LE GABARIT EFFECTIF d'un champ : celui des réglages s'il est renseigné, sinon le défaut de
   la langue configurée. Les trois premiers champs sont écrits en base au premier démarrage ;
   `prompt_fix` est arrivé plus tard et peut donc être vide sur une base existante — sans ce
   repli, la correction serait partie avec un prompt vide. */
function gabarit(field, cfg = {}) {
  const v = String(cfg[field] == null ? '' : cfg[field]).trim();
  if (v) return v;
  const lang = PROMPTS[cfg.language] ? cfg.language : 'fr';
  return PROMPTS[lang][field] || '';
}

module.exports = {
  PROMPTS, ANCIENS_PROMPTS, ANCIEN_PROMPT_REVIEW_COURT, FIELDS, isDefault, promptsFor, avecConsignes, gabarit,
};
