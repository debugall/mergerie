'use strict';
/* Options d'un profil d'agent → arguments de ligne de commande (spec agents §8.1).
 *
 * Un « agent Mergerie » est un PROFIL DE SESSION : ce qu'on met autour d'un lancement du CLI.
 * Tout ce qui distingue un agent d'un autre (rôle, modèle, outils, bornes, sous-agents) se
 * traduit ici en arguments — nulle part ailleurs. Le reste du code passe un objet d'options
 * et ne sait rien des drapeaux du binaire.
 *
 * INVARIANT : `argsFor(backend, undefined)` rend `[]`. Une session sans profil doit produire
 * un argv BYTE-IDENTIQUE à celui d'avant cette fonctionnalité — sinon on aurait changé le
 * comportement de toutes les sessions existantes en ajoutant une option à personne.
 *
 * `--append-system-prompt`, jamais `--system-prompt` : le second REMPLACERAIT le prompt système
 * du CLI, c'est-à-dire le CLAUDE.md du dépôt, ses skills et ses conventions — précisément ce
 * qu'une session lancée dans un clone a de plus que Mergerie.
 */

/* `bypassPermissions` n'en est plus : un profil venu du dépôt partagé n'a pas à pouvoir rendre à
   l'agent le mode large que la politique par saveur (`agentpolicy`) lui retire. Un profil qui le
   portait encore est refusé à la sauvegarde ; au lancement, l'option est retirée. */
const MODES = ['acceptEdits', 'plan', 'dontAsk', 'default'];
/* Un modèle, un nom d'outil : des lettres, des chiffres, et la ponctuation d'un motif d'outil
   (`Bash(git log:*)`, `mcp__serveur__outil`). Jamais un `-` en tête : `--model "--dangerously-…"`
   serait une OPTION pour le CLI, pas un modèle. */
const SUR = /^[\w.:\-[\]()* /]+$/;
const sur = (v) => SUR.test(v) && !v.startsWith('-');
const SUBAGENT_MODELS = ['inherit', 'sonnet', 'opus', 'haiku'];

const liste = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : []);
const texte = (v) => String(v == null ? '' : v).trim();

/* Les sous-agents partent en JSON sur la ligne de commande. `model: 'inherit'` est le défaut
   du CLI : le passer explicitement n'apporte rien et allonge un argv déjà long. */
function subagentsPropres(agents) {
  if (!agents || typeof agents !== 'object') return null;
  const out = {};
  for (const [nom, def] of Object.entries(agents)) {
    if (!def || typeof def !== 'object') continue;
    const d = { ...def };
    if (d.model === 'inherit' || !texte(d.model)) delete d.model;
    out[nom] = d;
  }
  return Object.keys(out).length ? out : null;
}

/* Argv pour un backend donné. Rend aussi ce qui a été IGNORÉ : sur copilot, seul `--model`
   existe, et l'utilisateur doit l'apprendre par le journal du run plutôt que par un profil
   qui semble appliqué et ne l'est pas. */
function argsFor(backend, options) {
  const o = options || {};
  const args = [];
  const ignored = [];

  const model = sur(texte(o.model)) ? texte(o.model) : '';
  const sys = texte(o.appendSystemPrompt);
  const mode = texte(o.permissionMode);
  const allowed = liste(o.allowedTools).filter(sur);
  const disallowed = liste(o.disallowedTools).filter(sur);
  const maxTurns = Number(o.maxTurns);
  const agents = subagentsPropres(o.agents);
  const dirs = liste(o.addDirs).filter((d) => !d.startsWith('-'));

  if (backend === 'copilot') {
    if (model) args.push('--model', model);
    if (sys) ignored.push('--append-system-prompt');
    if (mode) ignored.push('--permission-mode');
    if (allowed.length) ignored.push('--allowedTools');
    if (disallowed.length) ignored.push('--disallowedTools');
    if (Number.isInteger(maxTurns) && maxTurns > 0) ignored.push('--max-turns');
    if (agents) ignored.push('--agents');
    if (dirs.length) ignored.push('--add-dir');
    return { args, ignored };
  }

  // claude : ordre stable, une option n'apparaît que si elle est renseignée.
  if (model) args.push('--model', model);
  if (sys) args.push('--append-system-prompt', sys);
  if (mode && MODES.includes(mode)) args.push('--permission-mode', mode);
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  if (disallowed.length) args.push('--disallowedTools', disallowed.join(','));
  if (Number.isInteger(maxTurns) && maxTurns > 0) args.push('--max-turns', String(maxTurns));
  if (agents) args.push('--agents', JSON.stringify(agents));
  for (const d of dirs) args.push('--add-dir', d);
  return { args, ignored };
}

// Aperçu affiché dans l'éditeur d'agent : la même construction, rendue lisible.
function previewFor(backend, options) {
  const { args } = argsFor(backend, options);
  return args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/* Refus à la SAUVEGARDE, pas au lancement : un profil invalide découvert au moment où l'on
   comptait sur lui coûte un run et une attente. `default` est refusé parce que l'entrée
   standard de l'agent est fermée (`stdio: ['ignore', …]`) : le CLI poserait une question à
   laquelle personne ne peut répondre, et la session partirait au délai de quinze minutes. */
function validate(options, kind) {
  const o = options || {};
  const errs = [];
  const mode = texte(o.permissionMode);
  if (mode === 'default') errs.push('agents.err.permission-default');
  else if (mode && !MODES.includes(mode)) errs.push('agents.err.permission-unknown');
  if (kind === 'explore' && mode) errs.push('agents.err.permission-explore');
  const model = texte(o.model);
  if (model && !sur(model)) errs.push('agents.err.model-invalid');
  if ([...liste(o.allowedTools), ...liste(o.disallowedTools)].some((x) => !sur(x))) errs.push('agents.err.tool-invalid');

  if (o.maxTurns != null && texte(o.maxTurns) !== '') {
    const n = Number(o.maxTurns);
    if (!Number.isInteger(n) || n <= 0) errs.push('agents.err.max-turns');
  }

  const agents = o.agents;
  if (agents != null && (typeof agents !== 'object' || Array.isArray(agents))) {
    errs.push('agents.err.subagents-shape');
  } else if (agents) {
    for (const def of Object.values(agents)) {
      if (!def || typeof def !== 'object' || !texte(def.description) || !texte(def.prompt)) {
        errs.push('agents.err.subagent-incomplete');
      } else if (texte(def.model) && !SUBAGENT_MODELS.includes(texte(def.model))) {
        errs.push('agents.err.subagent-model');
      }
    }
  }
  return [...new Set(errs)];
}

module.exports = { argsFor, previewFor, validate, MODES, SUBAGENT_MODELS };
