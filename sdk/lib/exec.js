'use strict';
/* `ctx.exec` : lancer un binaire SANS shell, avec une liste blanche de sous-commandes et un
   refus des drapeaux à exécution arbitraire. Prévu pour Docker et Git (non éprouvé par Jenkins) ;
   la forme est celle que `src/git/git.js` applique déjà à git. */
const { spawn } = require('node:child_process');

/* LES VARIABLES D'ENVIRONNEMENT QU'UN PLUGIN NE POSE PAS. `env` s'ajoute à un environnement minimal ; certaines clés changent CE QUE le binaire
   exécute malgré la liste blanche de sous-commandes (`git` obéit à GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_CONFIG_* ; tout binaire à PATH, LD_PRELOAD,
   DYLD_*, NODE_OPTIONS…) — le même but que `-c` ou `--upload-pack` refusés plus bas. Passent : les variables d'un outil (DISPLAY,
   PLAYWRIGHT_BROWSERS_PATH, NODE_PATH…). */
const ENV_REFUSEES = /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|LD_.*|DYLD_.*|NODE_OPTIONS|GIT_.*)$/i;

const DRAPEAUX_REFUSES = [/^-c$/, /^--exec(?:=|$)/, /^--config(?:=|$)/, /^--upload-pack(?:=|$)/, /^--receive-pack(?:=|$)/, /^-e$/, /^--eval(?:=|$)/, /^--?ext-diff$/, /^--textconv$/];

/* `fournisseur` : { options(opts) → options de spawn (groupe de processus du cœur), tuer(child, signal) }.
   Sans lui (SDK de test), un spawn ordinaire et `child.kill`. */
function executer(plugin, bin, args, { cwd, timeoutMs = 60_000, allowlist, denyFlags = [], env = {} } = {}, fournisseur = {}) {
  const options = fournisseur.options || ((o) => o);
  const tuer = fournisseur.tuer || ((child, signal) => child.kill(signal));
  return new Promise((resolve, reject) => {
    if (typeof bin !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(bin)) return reject(new Error(`${plugin} : exec — binaire invalide`));
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return reject(new Error(`${plugin} : exec — args : tableau de chaînes`));
    if (!Array.isArray(allowlist) || !allowlist.length) return reject(new Error(`${plugin} : exec — allowlist de sous-commandes requise`));
    const sous = args.find((a) => !a.startsWith('-'));
    if (!sous || !allowlist.includes(sous)) return reject(new Error(`${plugin} : exec — sous-commande « ${sous || '(aucune)'} » hors liste blanche (${allowlist.join(', ')})`));
    for (const k of Object.keys(env || {})) if (ENV_REFUSEES.test(k)) return reject(new Error(`${plugin} : exec — variable d'environnement ${k} refusée`));
    const refuses = [...DRAPEAUX_REFUSES, ...denyFlags.map((d) => (d instanceof RegExp ? d : new RegExp(`^${String(d).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:=|$)`)))];
    for (const a of args) if (refuses.some((re) => re.test(a))) return reject(new Error(`${plugin} : exec — drapeau refusé : ${a}`));
    const envMinimal = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C.UTF-8', ...env };
    let child;
    try { child = spawn(bin, args, options({ cwd, env: envMinimal })); }
    catch (e) { return reject(e); }
    let stdout = ''; let stderr = ''; let fini = false;
    const timer = setTimeout(() => { if (!fini) tuer(child, 'SIGKILL'); }, Math.max(1000, Number(timeoutMs) || 60_000));
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 5_000_000) stdout = stdout.slice(-5_000_000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000); });
    child.on('error', (e) => { fini = true; clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      fini = true; clearTimeout(timer);
      if (signal === 'SIGKILL') return reject(new Error(`${plugin} : exec — ${bin} ${sous} : délai dépassé après ${timeoutMs} ms`));
      resolve({ stdout, stderr, code: code == null ? -1 : code });
    });
  });
}

module.exports = { executer, DRAPEAUX_REFUSES, ENV_REFUSEES };
