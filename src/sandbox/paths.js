'use strict';
/* CONFINEMENT DE CHEMINS — la digue entre « ce qu'un job peut toucher » et le reste du disque.
 *
 * Les NAMESPACES du backend Linux protègent déjà l'ENTRÉE (§4.1 du plan) : un job qui ne voit que
 * `/workspace` ne peut suivre un lien absolu vers `/etc/passwd`, ce chemin n'existant simplement
 * pas dans sa vue du système de fichiers. Ce que les namespaces NE protègent PAS, c'est la SORTIE :
 * un job `plan`/`edit` écrit dans `worktree-rw/`, et c'est Mergerie — hors sandbox, avec ses
 * propres droits — qui relit ensuite ce dossier pour construire le patch. Un lien créé là par
 * l'agent et suivi aveuglément lirait ou écraserait n'importe quoi que le PROCESSUS HÔTE peut
 * atteindre. `assertNoExternalSymlink` est donc appelé côté HÔTE, sur chaque chemin modifié,
 * avant de le copier vers `out/` (voir `fs.js`) — jamais à l'intérieur du bac à sable lui-même.
 */
const fs = require('node:fs');
const path = require('node:path');
const { erreurSandbox } = require('./errors');

/** Résout `candidate` (relatif ou absolu) sous `root`. Renvoie le chemin réel absolu, ou lève
 *  `SANDBOX_PATH_OUTSIDE_ROOT` / `SANDBOX_SYMLINK_ESCAPE` s'il en sort — avant ou après résolution
 *  des liens, l'un n'empêchant pas l'autre (`realpath` d'un chemin qui n'existe pas encore
 *  échouerait, d'où la double vérification : sur le chemin normalisé, puis sur son réel). */
function resolveInside(root, candidate) {
  /* `racineReelle`, jamais `root`, sert de base à un candidat RELATIF : sur macOS, `/tmp` est un
     lien vers `/private/tmp` — joindre sur `root` tel quel produirait un préfixe qui ne
     correspond plus à `racineReelle` une fois celle-ci résolue, et un chemin pourtant À
     L'INTÉRIEUR serait refusé à tort. */
  const racineReelle = fs.realpathSync(root);
  const cible = path.isAbsolute(candidate) ? candidate : path.join(racineReelle, candidate);
  const normalise = path.normalize(cible);
  if (normalise !== racineReelle && !normalise.startsWith(racineReelle + path.sep)) {
    throw erreurSandbox('SANDBOX_PATH_OUTSIDE_ROOT', { chemin: String(candidate) });
  }
  let reel;
  try { reel = fs.realpathSync(normalise); } catch { reel = normalise; } // pas encore créé : le chemin normalisé fait foi
  if (reel !== racineReelle && !reel.startsWith(racineReelle + path.sep)) {
    throw erreurSandbox('SANDBOX_SYMLINK_ESCAPE', { chemin: String(candidate) });
  }
  return reel;
}

function assertInside(root, candidate) { resolveInside(root, candidate); }

/** Refuse tout lien symbolique — sur le chemin final ou l'un de ses dossiers parents jusqu'à
 *  `root` — qui pointerait hors de `root`. Utilisé côté hôte, après le job, sur chaque chemin
 *  modifié d'un worktree avant de le copier vers `out/` (§4.3). */
function assertNoExternalSymlink(root, candidate) {
  const racineReelle = fs.realpathSync(root);
  const absolu = path.isAbsolute(candidate) ? candidate : path.join(racineReelle, candidate);
  const relatif = path.relative(racineReelle, absolu);
  if (relatif.startsWith('..') || path.isAbsolute(relatif)) {
    throw erreurSandbox('SANDBOX_PATH_OUTSIDE_ROOT', { chemin: String(candidate) });
  }
  let courant = racineReelle;
  for (const segment of relatif.split(path.sep).filter(Boolean)) {
    courant = path.join(courant, segment);
    let stat;
    try { stat = fs.lstatSync(courant); } catch { return; } // pas encore créé : rien à suivre
    if (stat.isSymbolicLink()) {
      const cible = fs.realpathSync(courant);
      if (cible !== racineReelle && !cible.startsWith(racineReelle + path.sep)) {
        throw erreurSandbox('SANDBOX_SYMLINK_ESCAPE', { chemin: String(candidate) });
      }
    }
  }
}

/** La liste des montages d'un job — pure : ne crée rien, ne lance rien. `layout` vient de
 *  `sandbox/fs.js` (les dossiers déjà créés pour CE job). Jamais `/`, `$HOME`, `/run`, un socket
 *  ou un clone entier : seulement ce que ce job précis a demandé (§3.3).
 *
 *  `source.sourceMode === 'local-dir'` (un worktree de vérification déjà préparé par
 *  l'appelant, par ex.) : UN SEUL montage, à `/workspace`, en écriture si la politique
 *  l'autorise — pas de `source-ro` séparé, puisqu'il n'y a rien à comparer après coup. */
function listMountsFor(spec, layout) {
  if (spec.source.sourceMode === 'local-dir') {
    return [
      { host: spec.source.sourcePath, guest: '/workspace', mode: spec.permissions.filesystem === 'job-write' ? 'rw' : 'ro' },
      { host: layout.home, guest: '/home/mergerie', mode: 'ro' },
      { host: layout.scratch, guest: '/tmp', mode: 'rw' },
      { host: layout.out, guest: '/out', mode: 'rw' },
      ...spec.source.allowExtraDirs.map((dir) => ({ host: dir, guest: `/extra/${path.basename(dir)}`, mode: 'ro' })),
    ];
  }
  const mounts = [
    { host: layout.sourceRo, guest: '/workspace', mode: 'ro' },
    { host: layout.home, guest: '/home/mergerie', mode: 'ro' },
    { host: layout.scratch, guest: '/tmp', mode: 'rw' },
    { host: layout.out, guest: '/out', mode: 'rw' },
  ];
  if (spec.permissions.filesystem === 'job-write' && layout.worktreeRw) {
    mounts.push({ host: layout.worktreeRw, guest: '/workspace-rw', mode: 'rw' });
  }
  for (const dir of spec.source.allowExtraDirs) {
    mounts.push({ host: dir, guest: `/extra/${path.basename(dir)}`, mode: 'ro' });
  }
  return mounts;
}

module.exports = { resolveInside, assertInside, assertNoExternalSymlink, listMountsFor };
