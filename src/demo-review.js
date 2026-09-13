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
 *
 * LE RAPPORT SUIT LA LANGUE DE L'INTERFACE. Il était écrit en français en dur : une démo
 * lancée en anglais montrait donc, sur LA capture qui illustre l'outil, un rapport français
 * sous des menus anglais. Tout le texte passe par `t()` — le même dictionnaire que le reste
 * du serveur, donc `i18n:check` garantit qu'aucune phrase ne manque d'un côté. La note
 * elle-même change de séparateur (7,4 en français, 7.4 en anglais) ; `extractNote` lit les
 * deux, et le titre anglais « Overall score » est l'une des formes qu'il reconnaît.
 */

const path = require('path');
const { DATA_DIR, ensureDir, slugify } = require('./paths');
const { t } = require('../public/i18n-runtime.js');

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

/* Les trois constats sont des CLÉS, pas des phrases : la sévérité est la seule donnée qui
   ne se traduit pas (c'est le barème de `resolution.SEVERITIES`). */
const REMARQUES = [
  { severity: 'major', cle: 'missing' },
  { severity: 'minor', cle: 'test' },
  { severity: 'info', cle: 'constant' },
];
const remarque = (r) => ({
  severity: r.severity,
  titre: t(`demo.review.finding.${r.cle}.title`),
  detail: t(`demo.review.finding.${r.cle}.detail`),
});

const titreMr = (mr) => mr.title || t('demo.review.mr-fallback', { iid: mr.iid });

/* LA CONSIGNE DU RELECTEUR, REPRISE DANS LE RAPPORT. Le contexte saisi sur la merge request
   part avec le diff dans le prompt d'une vraie review ; en démo, personne ne le lit. Sans ce
   qui suit, l'écran affichait un rapport parfaitement générique pendant qu'on montrait la
   fonctionnalité « donne son contexte à l'IA » — l'image démentait le propos. On ne simule
   donc pas une analyse : on montre que la consigne est bien arrivée jusqu'au rapport, et on
   la reprend en tête des constats. Le bandeau « analyse simulée » reste au-dessus. */
function consigne(mr) {
  const t0 = String(mr.ticket_text || '').trim();
  if (!t0) return null;
  const phrases = t0.split('\n').map((l) => l.trim()).filter(Boolean);
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
  const constats = cibles.map((c, i) => ({ ...c, ...remarque(REMARQUES[i % REMARQUES.length]) }));
  /* Le premier constat REND COMPTE de la consigne, sur une ligne qui existe dans le diff. */
  if (c0 && constats.length) {
    constats[0] = {
      ...constats[0],
      severity: 'major',
      titre: t('demo.review.finding.context.title', { extrait: c0.premiere }),
      detail: t('demo.review.finding.context.detail'),
    };
  }
  const note = constats.some((c) => c.severity === 'major')
    ? t('demo.review.score.flawed') : t('demo.review.score.clean');
  const lignes = [
    `# ${t('demo.review.title', { title: titreMr(mr) })}`,
    '',
    /* Une SEULE ligne de citation : coupée en deux, le rendu Markdown en faisait deux blocs
       cités l'un sous l'autre, deux barres pour une seule phrase. */
    `> ${t('demo.review.banner')}`,
    '',
    ...(c0 ? [
      `## ${t('demo.review.context.h')}`,
      '',
      t('demo.review.context.intro'),
      '',
      ...c0.lignes.map((l) => `> ${l}`),
      '',
    ] : []),
    `## ${t('demo.review.what.h')}`,
    '',
    t('demo.review.what.branch', {
      branch: mr.source_branch,
      n: cibles.length || t('demo.review.what.several'),
      target: mr.target_branch,
    }),
    t('demo.review.what.scope'),
    '',
    `## ${t('demo.review.attention.h')}`,
    '',
  ];
  for (const c of constats) {
    lignes.push(`- **${c.titre}** — \`${c.file}\`:${c.line}`, `  ${c.detail}`, '');
  }
  lignes.push(
    `## ${t('demo.review.good.h')}`,
    '',
    `- ${t('demo.review.good.1')}`,
    `- ${t('demo.review.good.2')}`,
    '',
    `## ${t('demo.review.score.h')}`,
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
    `# ${t('demo.explain.title', { title: titreMr(mr) })}`,
    '',
    `> ${t('demo.explain.banner')}`,
    '',
    `## ${t('demo.explain.intent.h')}`,
    '',
    t('demo.explain.intent.p'),
    '',
    `## ${t('demo.explain.how.h')}`,
    '',
    ...(fichiers.length
      ? fichiers.map((f) => `- ${t('demo.explain.how.file', { file: f })}`)
      : [`- ${t('demo.explain.how.none')}`]),
    '',
    t('demo.explain.how.p'),
    '',
    `## ${t('demo.explain.takeaway.h')}`,
    '',
    `- ${t('demo.explain.takeaway.1')}`,
    `- ${t('demo.explain.takeaway.2')}`,
    '',
    `## ${t('demo.explain.further.h')}`,
    '',
    t('demo.explain.further.p'),
    '',
  ].join('\n');
}

/* LA RÉPONSE À UNE QUESTION POSÉE SUR LE RAPPORT. On ne simule pas une analyse : on montre ce
   que cette fonctionnalité garantit — la question est reprise telle quelle, la réponse s'appuie
   sur les fichiers que le diff touche vraiment, et le rapport, lui, n'a pas bougé. */
function reponseQuestion(mr, diff, question) {
  const cibles = ciblesDuDiff(diff).slice(0, 2);
  const ou = cibles.length
    ? cibles.map((c) => t('demo.answer.where-line', { file: c.file, line: c.line }))
      .join(t('demo.answer.where-join'))
    : t('demo.answer.where-fallback');
  /* La question n'est PAS reprise ici : l'écran l'affiche déjà au-dessus de la réponse, et la
     répéter donnait à lire deux fois la même phrase. Des paragraphes entiers, pas des lignes
     coupées à 80 colonnes : le Markdown en ferait autant de paragraphes séparés. */
  const mot = String(question || '').trim().split(/\s+/).slice(0, 6).join(' ');
  return [
    `**${t('demo.answer.banner')}**`,
    '',
    t('demo.answer.body', { question: mot, where: ou }),
    '',
    `*${t('demo.answer.footer')}*`,
    '',
  ].join('\n');
}

module.exports = { isDemo, dossierTravail, rapport, explication, reponseQuestion };
