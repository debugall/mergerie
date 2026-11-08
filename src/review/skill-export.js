'use strict';
/* EXPORTER LE REVIEWER EN SKILL AUTONOME.
 *
 * Ce que l'application fait d'une merge request — le gabarit de review de l'équipe, les règles de review
 * configurées, la note sur 10 — tient dans un prompt et un diff. Un skill Claude Code, UN SEUL FICHIER
 * `SKILL.md`, reproduit donc la même review sur la branche courante de n'importe quel dépôt cloné :
 * `/branch-review [cible]`. Aucun script, aucune dépendance : l'agent lance lui-même les deux commandes
 * git dont il a besoin (le diff `cible...courante`, les messages de commit qui tiennent lieu d'intention).
 *
 * Le skill est AUTONOME et ne nomme pas l'application : qui le reçoit n'a pas à savoir d'où il vient,
 * et son texte doit se lire seul. Il porte le prompt que `review/reviewer.js` enverrait (`prompt_review`
 * de la configuration, le chemin du diff rempli, `{source}`/`{target}`/`{project}` laissés à l'agent),
 * les règles actives avec leur condition et leur portée, la consigne de note et la consigne de sortie,
 * l'explication en option. Rien de plus : pas de section sur ce qui manque — le skill dit ce qu'il fait.
 * Pur : ce module lit la configuration et la base, n'écrit rien. */
const db = require('../db');
const { zipper } = require('../core/zip');
const { t } = require('../core/i18n');
const prompts = require('../core/prompts');

const NOM = 'branch-review';
const DOSSIER = '.branch-review';
/* Le rapport est RANGÉ, pas jeté : un sous-dossier au nom de la branche relue, un fichier daté à la
   seconde — deux reviews de la même branche se succèdent sans s'écraser. Le diff, lui, est effacé à la fin.
   `<branche>` et `<date>` sont écrits tels quels : l'agent les remplace (nom de la branche courante, les
   `/` devenus `-` ; date au format AAAA-MM-JJ-HH-mm-ss). */
const FICHIERS = {
  diff: `${DOSSIER}/diff.patch`,
  rapport: `${DOSSIER}/<branche>/<branche>-<date>.md`,
  explication: `${DOSSIER}/<branche>/<branche>-<date>-explication.md`,
};

/* Une valeur du front matter, toujours entre guillemets doubles : un « : » ou un « # » nu dans la phrase
   est une erreur YAML, et le skill ne se charge pas. */
const yaml = (texte) => `"${String(texte || '').replace(/\s*\n\s*/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const remplir = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/* Le gabarit effectif : celui de la configuration, sinon le défaut livré dans la langue configurée. */
const gabarit = (cfg, champ) => prompts.gabarit(champ, cfg);

/* Les règles de review actives, avec leur condition et leur portée, telles que `reviewer.js` les
   applique : par fragment de branche OU par motif de chemin, limitées ou non à un dépôt ou un groupe. */
function regles() {
  return db.prepare(`SELECT r.id, r.label, r.branch_match, r.path_match, r.content, repo.project, g.name AS group_name
    FROM review_rule r LEFT JOIN repo ON repo.id = r.repo_id LEFT JOIN repo_group g ON g.id = r.group_id
    WHERE r.enabled = 1 ORDER BY r.id`).all();
}

function blocRegles(liste, lang) {
  if (!liste.length) return t('settings.skill.rules.none');
  const lignes = liste.map((r) => {
    const conditions = [];
    if (r.branch_match) conditions.push(t('settings.skill.rules.branch', { fragment: r.branch_match }));
    if (r.path_match) conditions.push(t('settings.skill.rules.path', { glob: r.path_match }));
    const portee = r.project ? t('settings.skill.rules.scope-repo', { project: r.project })
      : (r.group_name ? t('settings.skill.rules.scope-group', { name: r.group_name }) : t('settings.skill.rules.scope-all'));
    return `- ${conditions.join(` ${lang === 'fr' ? 'OU' : 'OR'} `)} · ${portee}\n  ${String(r.content).trim().replace(/\n/g, '\n  ')}`;
  });
  return `${t('settings.skill.rules.head')}\n\n${lignes.join('\n')}`;
}

/* Le prompt de review tel que l'application l'enverrait : le chemin du diff et celui du rapport remplis,
   les variables de branche et de projet laissées à l'agent (connues au moment de la review seulement),
   le titre et la description de merge request renvoyés à l'intention lue dans les commits. */
function promptReview(cfg) {
  const vars = {
    diff_file: FICHIERS.diff, lines_file: FICHIERS.diff, out_file: FICHIERS.rapport,
    title: t('settings.skill.var.title'), description: t('settings.skill.var.description'),
  };
  return remplir(gabarit(cfg, 'prompt_review'), vars);
}

function skillMd(cfg, { lang = 'fr', maintenant = new Date() } = {}) {
  const liste = regles();
  const explication = cfg.review_explain !== '0';
  const sections = [
    '---',
    `name: ${NOM}`,
    `description: ${yaml(t('settings.skill.desc'))}`,
    '---',
    '',
    `# ${t('settings.skill.title')}`,
    '',
    t('settings.skill.intro', { date: maintenant.toISOString().slice(0, 10) }),
    '',
    `## ${t('settings.skill.args.head')}`,
    '',
    t('settings.skill.args.body', { name: NOM }),
    '',
    `## ${t('settings.skill.step1.head')}`,
    '',
    t('settings.skill.step1.body', { diff: FICHIERS.diff, dossier: DOSSIER }),
    '',
    `## ${t('settings.skill.step2.head')}`,
    '',
    t('settings.skill.step2.body'),
    '',
    '```text',
    promptReview(cfg),
    '```',
    '',
    `### ${t('settings.skill.intent.head')}`,
    '',
    t('settings.skill.intent.body'),
    '',
    `### ${t('settings.skill.rules.title')}`,
    '',
    blocRegles(liste, lang),
    '',
    `### ${t('settings.skill.exec.head')}`,
    '',
    t('settings.skill.exec.intro'),
    '',
    `- ${t('settings.skill.lines')}`,
    `- ${t('settings.skill.note')}`,
    `- ${t('settings.skill.output', { file: FICHIERS.rapport, dossier: DOSSIER, diff: FICHIERS.diff })}`,
    '',
  ];
  if (explication) {
    sections.push(
      `## ${t('settings.skill.step3.head')}`,
      '',
      t('settings.skill.step3.body', { file: FICHIERS.explication }),
      '',
      '```text',
      remplir(gabarit(cfg, 'prompt_explain'), { diff_file: FICHIERS.diff, lines_file: FICHIERS.diff, out_file: FICHIERS.explication }),
      '```',
      '',
    );
  }
  return sections.join('\n');
}

/* Le fichier du skill, puis l'archive — un dossier `branch-review/` à poser dans `.claude/skills/`. */
function fichiers(cfg, opts = {}) {
  return [{ nom: `${NOM}/SKILL.md`, data: Buffer.from(skillMd(cfg, opts), 'utf8') }];
}
function construire(cfg, opts = {}) {
  const liste = fichiers(cfg, opts);
  return { nom: `${NOM}.zip`, buffer: zipper(liste), fichiers: liste.map((f) => f.nom) };
}

module.exports = { NOM, DOSSIER, FICHIERS, fichiers, construire, skillMd, promptReview, regles };
