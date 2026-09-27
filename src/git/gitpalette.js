'use strict';
/* LA PALETTE GIT EST UNE LISTE BLANCHE.
 *
 * Elle était une liste noire : on refusait `-c`, `--upload-pack`, `ext::`… et tout le reste
 * passait. Or git sait exécuter par bien d'autres portes — un alias `!cmd` posé par `config`,
 * `rebase -x`, `bisect run`, `submodule foreach`, `difftool`, un `--upload-pa=` abrégé que git
 * complète tout seul —, lire ou écrire hors du dépôt (`--output=`, `diff --no-index /etc/…`,
 * `archive -o`), ou rendre des secrets (`credential fill`). Une liste noire se contourne par ce
 * qu'elle n'a pas prévu ; une liste blanche ne laisse passer que ce qu'on a regardé.
 *
 * On admet les sous-commandes du quotidien d'un dépôt, et par-dessus on refuse, quelle que soit
 * la sous-commande : les options qui exécutent ou redirigent (par PRÉFIXE, puisque git accepte
 * les abréviations), tout chemin absolu ou qui remonte (`..` comme segment — `main..feature`,
 * une plage, reste permis), et un `remote add|set-url` vers autre chose que https ou ssh.
 */
const { t } = require('../core/i18n');

const SOUS_COMMANDES = new Set(['status', 'fetch', 'pull', 'push', 'log', 'show', 'diff', 'branch',
  'checkout', 'switch', 'stash', 'tag', 'merge', 'rebase', 'reset', 'restore', 'cherry-pick', 'remote',
  'rev-parse', 'ls-files', 'describe', 'blame', 'shortlog', 'reflog', 'clean']);

// Options globales ou qui redirigent le dépôt — même après la sous-commande, jamais.
const GLOBALES = /^(-c|--config(-env)?|-C|--exec-path|--git-dir|--work-tree|--namespace|--open-files-in-pager|--super-prefix)(=.*)?$/i;
/* Par PRÉFIXE : git complète `--upload-pa` en `--upload-pack`. `--ex` couvre --exec et
   --ext-diff, `--up` --upload-pack, `--rec` --receive-pack, `--out` --output, `--tex` --textconv. */
const PREFIXES_LONGS = ['--ex', '--up', '--rec', '--out', '--no-index', '--tex', '--tool', '--interactive'];
// Transport qui exécute une commande.
const TRANSPORT = /^(ext|fd)::/i;
/* Les options courtes qui exécutent, par sous-commande : `rebase -x <cmd>` (et `-i`, qui ouvre un
   éditeur dans un processus sans terminal). Une grappe (`-ix`) est examinée lettre par lettre. */
const COURTES = { rebase: ['x', 'i'], merge: [], 'cherry-pick': [], stash: [] };

const cheminAbsolu = (v) => /^(\/|~|[a-zA-Z]:[\\/]|\\\\)/.test(v);
const remonte = (v) => /(^|[\\/])\.\.([\\/]|$)/.test(v);
const urlAdmise = (u) => /^(https:\/\/|ssh:\/\/)[^\s]+$/i.test(u) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u);

const refus = (arg) => new Error(t('err.gitcmd.forbidden-arg', { arg }));

function verifierArgs(args) {
  if (!args.length) throw new Error(t('err.gitcmd.empty'));
  const sc = String(args[0]);
  if (!/^[a-z][a-z0-9-]*$/i.test(sc)) throw new Error(t('err.gitcmd.subcommand-first'));
  if (!SOUS_COMMANDES.has(sc)) throw new Error(t('err.gitcmd.subcommand-not-allowed', { cmd: sc, list: [...SOUS_COMMANDES].join(', ') }));
  const reste = args.slice(1).map(String);
  for (const a of reste) {
    if (GLOBALES.test(a) || TRANSPORT.test(a)) throw refus(a);
    const nom = a.split('=')[0].toLowerCase();
    if (a.startsWith('--') && PREFIXES_LONGS.some((p) => nom.startsWith(p))) throw refus(a);
    if (/^-[a-zA-Z]+$/.test(a) && (COURTES[sc] || []).some((l) => a.slice(1).includes(l))) throw refus(a);
    // Le chemin, qu'il soit l'argument entier ou la valeur d'une option (`--pathspec-from-file=/x`).
    const valeur = a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    for (const v of [a, valeur]) if (cheminAbsolu(v) || remonte(v)) throw refus(a);
  }
  if (sc === 'remote' && (reste[0] === 'add' || reste[0] === 'set-url')) {
    const positionnels = reste.slice(1).filter((x) => !x.startsWith('-'));
    const url = positionnels[positionnels.length - 1];
    if (!url || !urlAdmise(url)) throw new Error(t('err.gitcmd.remote-url', { url: url || '' }));
  }
  return true;
}

module.exports = { SOUS_COMMANDES, verifierArgs, urlAdmise };
