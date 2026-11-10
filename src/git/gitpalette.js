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
  'rev-parse', 'ls-files', 'describe', 'blame', 'shortlog', 'reflog', 'clean', 'submodule']);
/* `submodule` n'entre qu'avec SES sous-commandes du quotidien — `update --init --recursive`, `sync`,
   `status`… `foreach` exécute une commande arbitraire : jamais. `add` et `set-url` prennent une
   adresse : la même règle que `remote` (https ou ssh seulement). Sans sous-commande, c'est `status`. */
const SOUS_SUBMODULE = new Set(['status', 'init', 'update', 'sync', 'summary', 'deinit', 'set-branch', 'add', 'set-url']);
// Les options de `submodule add` qui prennent une valeur dans l'argument SUIVANT (`--name=x` n'en a pas besoin).
const OPTIONS_A_VALEUR_SUBMODULE = new Set(['-b', '--branch', '--name', '--reference', '--depth']);

// Options globales ou qui redirigent le dépôt — même après la sous-commande, jamais.
const GLOBALES = /^(-c|--config(-env)?|-C|--exec-path|--git-dir|--work-tree|--namespace|--open-files-in-pager|--super-prefix)(=.*)?$/i;
/* Par PRÉFIXE : git complète `--upload-pa` en `--upload-pack`. `--ex` couvre --exec et
   --ext-diff, `--up` --upload-pack, `--rec` --receive-pack, `--out` --output, `--tex` --textconv. */
const PREFIXES_LONGS = ['--ex', '--up', '--rec', '--out', '--no-index', '--tex', '--tool', '--interactive'];
/* Les seules options ENTIÈRES admises sous un préfixe refusé : `--recursive` et `--recurse-submodules`
   (sous-modules, fetch, checkout) commencent comme `--receive-pack` sans rien exécuter. Entières
   seulement — un `--rec` abrégé resterait ambigu, et refusé. */
const EXACTES_ADMISES = new Set(['--recursive', '--recurse-submodules']);
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
    if (a.startsWith('--') && !EXACTES_ADMISES.has(nom) && PREFIXES_LONGS.some((p) => nom.startsWith(p))) throw refus(a);
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
  if (sc === 'submodule') {
    // La sous-commande de `submodule` est le premier mot qui n'est pas une option (`--quiet status`).
    const iSous = reste.findIndex((x) => !x.startsWith('-'));
    const sous = iSous >= 0 ? reste[iSous] : null;
    if (sous && !SOUS_SUBMODULE.has(sous)) throw refus(sous);
    if (sous === 'add' || sous === 'set-url') {
      /* LES POSITIONNELS, OPTIONS À VALEUR COMPRISES : `add --name <nom> <url> [chemin]` — lire « le
         premier mot sans tiret » prenait le nom pour l'adresse et laissait passer le vrai dépôt
         derrière. On saute donc la valeur de chaque option qui en prend une, `--` ferme les options,
         et on exige le compte exact : `add <url> [chemin]`, `set-url <chemin> <url>`. */
      const positionnels = [];
      let fin = false;
      for (let i = iSous + 1; i < reste.length; i += 1) {
        const a = reste[i];
        if (!fin && a === '--') { fin = true; continue; }
        if (!fin && a.startsWith('-')) {
          if (OPTIONS_A_VALEUR_SUBMODULE.has(a)) i += 1;   // `-b main`, `--name x` : la valeur n'est pas un positionnel
          continue;
        }
        positionnels.push(a);
      }
      const url = sous === 'add' ? positionnels[0] : positionnels[1];
      const attendus = sous === 'add' ? [1, 2] : [2];
      if (!attendus.includes(positionnels.length) || !url || !urlAdmise(url)) throw new Error(t('err.gitcmd.remote-url', { url: url || '' }));
      // Rien d'autre ne doit pouvoir se lire comme un dépôt : un chemin reste un chemin relatif.
      for (const p of positionnels) if (p !== url && /^[a-z][a-z0-9+.-]*:/i.test(p)) throw refus(p);
    }
  }
  return true;
}

module.exports = { SOUS_COMMANDES, verifierArgs, urlAdmise };
