'use strict';
/* UN SECOND POSTE, POUR DE VRAI — la « collègue » des tests de synchronisation.
 *
 * Une seconde instance de Mergerie, lancée comme PROCESSUS ENFANT (`node src/server.js`), avec
 * SA base, SON dossier de données, SON port et SON identité git. Elle parle au même dépôt nu
 * que le poste du test : ce qu'elle écrit, elle le pousse avec le vrai code de synchro, au vrai
 * format du store — le test n'a donc rien à imiter.
 *
 * TROIS PRÉCAUTIONS, toutes tirées de CLAUDE.md :
 *   — l'environnement est RECONSTRUIT, pas hérité : `MERGERIE_DATA_DIR` du processus de test
 *     pointe la base du poste local, et un enfant qui en hériterait écrirait dedans ;
 *   — `PORT` est TOUJOURS posé (0 = port libre) : sans lui, le serveur prendrait 4319, celui de
 *     l'instance réelle de l'utilisateur ;
 *   — `MERGERIE_DEMO` est retiré : en démo, le serveur se fabrique son propre dépôt de données.
 *
 * Rien de `src/` n'est chargé ici : ce fichier ne fait que lancer un processus. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Lance la collègue. `nom` devient son identité git (l'auteur de ses commits, donc le
 * « par <nom> » que le poste local affichera). Rend `{ base, api, dataDir, stop, journal }`.
 */
async function lancerCollegue({ nom = 'Claire', racine = os.tmpdir() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(racine, `collegue-${nom.toLowerCase()}-`));
  const env = { ...process.env };
  for (const cle of ['MERGERIE_DATA_DIR', 'PORT', 'HOST', 'MERGERIE_DEMO', 'MERGERIE_ACCESS_TOKEN',
    'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[cle];
  Object.assign(env, {
    MERGERIE_DATA_DIR: dataDir,
    PORT: '0',
    COPILOT_DRY_RUN: '1',
    GIT_AUTHOR_NAME: nom,
    GIT_AUTHOR_EMAIL: `${nom.toLowerCase()}@exemple.test`,
    GIT_COMMITTER_NAME: nom,
    GIT_COMMITTER_EMAIL: `${nom.toLowerCase()}@exemple.test`,
  });
  const enfant = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const journal = [];
  const base = await new Promise((resolve, reject) => {
    const minuterie = setTimeout(() => reject(new Error(`la collègue ne démarre pas :\n${journal.join('')}`)), 60000);
    const lire = (d) => {
      journal.push(String(d));
      const m = /Mergerie sur (http:\/\/[^\s]+)/.exec(journal.join(''));
      if (m) { clearTimeout(minuterie); resolve(m[1].replace('localhost', '127.0.0.1')); }
    };
    enfant.stdout.on('data', lire);
    enfant.stderr.on('data', (d) => journal.push(String(d)));
    enfant.once('exit', (code) => { clearTimeout(minuterie); reject(new Error(`la collègue s’est arrêtée (${code}) :\n${journal.join('')}`)); });
  });
  enfant.removeAllListeners('exit');

  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* réponse non-JSON */ }
    return { status: res.status, body: json, text };
  }

  return {
    base, api, dataDir, journal, nom,
    /** Rattache la collègue au dépôt nu. Cadence au maximum : elle ne synchronise QUE sur ordre. */
    async rattacher(nu) {
      const c = await api('PUT', '/api/config', {
        data_repo_url: nu, data_repo_branch: 'main', data_sync_seconds: '600', brief_on_open: '0',
      });
      if (c.status !== 200) throw new Error(`réglages de la collègue refusés : ${c.text}`);
      const r = await api('POST', '/api/data-sync/attach', { url: nu });
      if (r.status !== 200) throw new Error(`rattachement de la collègue refusé : ${r.text}`);
      return r.body;
    },
    /** « Synchroniser maintenant », chez elle — et on exige que ça ait marché. */
    async synchroniser() {
      const r = await api('POST', '/api/data-sync/now');
      if (r.status !== 200) throw new Error(`synchro de la collègue refusée : ${r.text}`);
      if (r.body.statut && r.body.statut.erreur) throw new Error(`synchro de la collègue en erreur : ${r.body.statut.erreur}`);
      return r.body;
    },
    async stop() {
      if (enfant.exitCode === null) {
        await new Promise((resolve) => {
          const tuer = setTimeout(() => { try { enfant.kill('SIGKILL'); } catch { /* déjà mort */ } }, 5000);
          enfant.once('exit', () => { clearTimeout(tuer); resolve(); });
          enfant.kill('SIGTERM');
        });
      }
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

module.exports = { lancerCollegue };
