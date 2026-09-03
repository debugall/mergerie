'use strict';
/* Review SIMULÉE pour le mode démo (MERGERIE_DEMO=1), sur le modèle de demo-verify.js.
 *
 * Pourquoi ce module existe : `reviewMr` commence par cloner le dépôt (`git.ensureRepo`), et
 * l'hôte `gitlab.demo` n'existe pas. Lancer une review en démo échouait donc toujours, sur
 * LA fonctionnalité centrale de l'outil : la démo montrait des rapports déjà là, sans jamais
 * pouvoir en produire un. Le bouton « Reviewer » était le seul de l'écran d'accueil qui ne
 * menait qu'à une erreur.
 *
 * On rejoue ici ce que l'IA AURAIT écrit, à partir du diff fictif de `demo-diff.js` : mêmes
 * sections, même bloc de constats, même note. Les constats pointent des fichiers et des lignes
 * qui existent VRAIMENT dans le diff affiché — un rapport dont les numéros ne mènent nulle part
 * apprendrait au lecteur à s'en méfier.
 *
 * Le rapport dit ce qu'il est : « mode démo — analyse simulée ». Rien ici ne doit pouvoir
 * passer pour le travail d'un vrai modèle.
 */

const path = require('path');
const { DATA_DIR, ensureDir, slugify } = require('./paths');

const isDemo = () => process.env.MERGERIE_DEMO === '1';

/* Un dossier de travail SANS git : `prepareContext` y dépose le diff et le diff numéroté,
   comme il le ferait dans un clone. Rien d'autre ne s'y passe. */
function dossierTravail(repo) {
  return ensureDir(path.join(DATA_DIR, 'clones-demo', slugify(repo.project)));
}

/* Les fichiers touchés, avec une ligne plausible : on lit les en-têtes du diff plutôt que
   d'inventer des numéros. `@@ -a,b +c,d @@` donne la première ligne du bloc côté nouveau. */
function ciblesDuDiff(diff) {
  const out = [];
  let fichier = null;
  let ligne = null;
  for (const l of String(diff || '').split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(l);
    if (f) { fichier = f[1]; ligne = null; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h && fichier && ligne == null) {
      ligne = Number(h[1]) + 2;
      out.push({ file: fichier, line: ligne });
    }
  }
  return out;
}

const REMARQUES = [
  { severity: 'major', titre: 'gérer le cas où la valeur est absente',
    detail: 'Le chemin nominal est couvert, pas le cas où la donnée manque — un `null` arriverait ici sans être intercepté.' },
  { severity: 'minor', titre: 'ajouter un test sur ce chemin',
    detail: 'Le comportement introduit n’est vérifié par aucun test : une régression passerait inaperçue.' },
  { severity: 'info', titre: 'extraire la valeur en constante',
    detail: 'La valeur est écrite en dur à deux endroits ; une constante nommée dirait ce qu’elle représente.' },
];

/* LA CONSIGNE DU RELECTEUR, REPRISE DANS LE RAPPORT. Le contexte saisi sur la merge request
   part avec le diff dans le prompt d'une vraie review ; en démo, personne ne le lit. Sans ce
   qui suit, l'écran affichait un rapport parfaitement générique pendant qu'on montrait la
   fonctionnalité « donne son contexte à l'IA » — l'image démentait le propos. On ne simule
   donc pas une analyse : on montre que la consigne est bien arrivée jusqu'au rapport, et on
   la reprend en tête des constats. Le bandeau « analyse simulée » reste au-dessus. */
function consigne(mr) {
  const t = String(mr.ticket_text || '').trim();
  if (!t) return null;
  const phrases = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const premiere = phrases[0].replace(/^[-•*]\s*/, '');
  // Coupe sur un MOT, pas au milieu d'un : un titre de constat tronqué en « first instalment »
  // se lit comme une erreur d'écriture, pas comme un extrait.
  const court = premiere.length <= 80 ? premiere
    : `${premiere.slice(0, 80).replace(/\s+\S*$/, '')}…`;
  return { lignes: phrases.slice(0, 4), premiere: court };
}

/** Le rapport de revue, bloc de constats compris — la forme exacte qu'attend `splitFindings`. */
function rapport(mr, diff, { START, END }) {
  const cibles = ciblesDuDiff(diff).slice(0, 3);
  const c0 = consigne(mr);
  const constats = cibles.map((c, i) => ({ ...c, ...REMARQUES[i % REMARQUES.length] }));
  /* Le premier constat REND COMPTE de la consigne, sur une ligne qui existe dans le diff. */
  if (c0 && constats.length) {
    constats[0] = {
      ...constats[0],
      severity: 'major',
      titre: `contexte du relecteur : ${c0.premiere}`,
      detail: 'Cette consigne a été jointe à la merge request et transmise avec le diff. '
        + 'Une vraie analyse y répondrait point par point ; ce rapport de démo montre '
        + 'seulement qu’elle est arrivée jusqu’ici.',
    };
  }
  const note = constats.some((c) => c.severity === 'major') ? '7,4' : '8,6';
  const lignes = [
    `# Revue — ${mr.title || `MR !${mr.iid}`}`,
    '',
    '> **Mode démo — analyse simulée.** Aucun modèle n’a lu ce code : ce rapport montre la FORME',
    '> d’une revue (sections, constats situés, note), pas le résultat d’une vraie analyse.',
    '',
    ...(c0 ? [
      '## Le contexte fourni par le relecteur',
      '',
      'Il est parti avec le diff, dans le même prompt :',
      '',
      ...c0.lignes.map((l) => `> ${l}`),
      '',
    ] : []),
    '## Ce que fait la merge request',
    '',
    `La branche \`${mr.source_branch}\` modifie ${cibles.length || 'plusieurs'} fichier(s) vers \`${mr.target_branch}\`.`,
    'Le changement est cohérent avec le reste du dépôt, et son périmètre reste contenu.',
    '',
    '## Points d’attention',
    '',
  ];
  for (const c of constats) {
    lignes.push(`- **${c.titre}** — \`${c.file}\`:${c.line}`, `  ${c.detail}`, '');
  }
  lignes.push(
    '## Ce qui est bien',
    '',
    '- Le découpage des commits suit le changement, il se relit sans effort.',
    '- Les noms introduits disent ce qu’ils font, sans abréviation à deviner.',
    '',
    '## Note globale',
    '',
    `**${note}/10**`,
    '',
    START,
    ...constats.map((c) => `${c.severity} | ${c.file} | ${c.line} | ${c.titre}`),
    END,
    '',
  );
  return lignes.join('\n');
}

/** L'explication pédagogique — l'onglet « Explication » du rapport. */
function explication(mr, diff) {
  const cibles = ciblesDuDiff(diff);
  const fichiers = [...new Set(cibles.map((c) => c.file))];
  return [
    `# Explication — ${mr.title || `MR !${mr.iid}`}`,
    '',
    '> **Mode démo — explication simulée.**',
    '',
    '## L’intention',
    '',
    'Cette merge request répond à un besoin simple : rendre le comportement existant plus sûr',
    'sans changer ce que voient les appelants. C’est un changement interne, pas une évolution',
    'du contrat public.',
    '',
    '## Comment c’est fait',
    '',
    ...(fichiers.length ? fichiers.map((f) => `- \`${f}\` porte l’essentiel du changement.`) : ['- Le changement tient en quelques lignes.']),
    '',
    'Le motif employé est celui qu’on retrouve ailleurs dans le dépôt : on isole la décision',
    'dans une fonction dédiée, puis on l’appelle depuis le chemin nominal. L’avantage est de',
    'pouvoir la tester seule.',
    '',
    '## Ce qu’il faut retenir',
    '',
    '- Un cas limite non couvert coûte plus cher qu’un test qui l’aurait attrapé.',
    '- Une valeur écrite en dur deux fois finit toujours par diverger.',
    '',
    '## Pour aller plus loin',
    '',
    'Regarde comment le même problème est traité dans les modules voisins : la convention du',
    'dépôt est déjà là, et s’y aligner évite d’en inventer une deuxième.',
    '',
  ].join('\n');
}

module.exports = { isDemo, dossierTravail, rapport, explication };
