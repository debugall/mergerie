'use strict';
/* LE MODE NON SANDBOXÉ — jamais choisi par défaut ni en repli silencieux : `runner.js` ne
 * l'utilise QUE quand un appelant a demandé `sandbox: 'disabled'` explicitement (§ Points de
 * vigilance du plan, #8 : « ne pas ajouter un fallback silencieux sur le backend legacy »).
 * Lance la commande directement sur l'hôte — dans le dossier du JOB (une extraction séparée,
 * voir `sandbox/fs.js`), jamais dans le clone partagé : seul `session/localcoder.js`, qui
 * n'emprunte pas ce backend, travaille réellement en place (§6.4).
 */
const { spawn } = require('node:child_process');
const proc = require('../../core/proc');

/* « Non sandboxé » veut dire « pas de namespaces » — jamais « tous les secrets de Mergerie
 * transmis en prime ». Le filet de `agent/policy.js` (jetons, `.env`) reste de mise ici aussi :
 * seul `env` (déjà décidé par l'appelant) et un `PATH` minimal partent, jamais l'environnement
 * complet du serveur repris tel quel (un verrou de sécurité vérifié par `check-server.js`). */
const envMinimal = (env) => ({ PATH: process.env.PATH, LANG: process.env.LANG, ...env });

async function capabilities() { return { platform: true, bin: null, namespaces: false, legacy: true }; }
async function assertAvailable() { /* toujours « disponible » : c'est justement l'absence de garantie */ }
function buildCommand(spec) { return [spec.command.program, ...spec.command.args]; }

function run(spec, layout, { onLog = () => {}, env = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const cwd = spec.permissions.filesystem === 'job-write' && layout.worktreeRw ? layout.worktreeRw : layout.sourceRo;
    const child = spawn(spec.command.program, spec.command.args, proc.options({ cwd, env: envMinimal(env) }));
    proc.setActive(child);
    let expire = false;
    const minuteur = setTimeout(() => {
      expire = true;
      proc.tuerGroupe(child, 'SIGTERM');
      setTimeout(() => proc.tuerGroupe(child, 'SIGKILL'), 2000);
    }, spec.limits.wallTimeMs);
    child.stdout.on('data', (d) => onLog(d.toString('utf8')));
    child.stderr.on('data', (d) => onLog(d.toString('utf8')));
    child.on('error', (e) => { clearTimeout(minuteur); proc.clearActive(child); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(minuteur);
      proc.clearActive(child);
      resolvePromise({ code, signal, timedOut: expire, truncated: false, degradedLimits: true });
    });
  });
}

function kill(handle, signal = 'SIGTERM') { proc.tuerGroupe(handle, signal); }
async function cleanup() { /* rien de propre à ce backend */ }

module.exports = { capabilities, assertAvailable, buildCommand, run, kill, cleanup };
