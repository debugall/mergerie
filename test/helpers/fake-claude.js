'use strict';
/* Faux binaire `claude` pour les tests du flux d'événements — motif de `unit-stop.test.js`.
 *
 * Le vrai CLI n'est pas installable en CI, et le mode dry-run court-circuite le flux : sans
 * ce faux binaire, tout ce que `runClaudeStream` sait faire (journal des skills, sous-agents,
 * indentation, coût, refus de permission) ne serait prouvé par rien.
 *
 * Le script écrit son ARGV reçu dans un fichier, puis rejoue un flux NDJSON fourni : un test
 * vérifie donc à la fois ce qu'on a envoyé et ce qu'on sait lire. */

const fs = require('node:fs');
const path = require('node:path');

/* Crée le faux binaire dans `dir`. Son nom contient « claude » : `backendName()` déduit le
   backend du nom du binaire, et un autre nom emprunterait le chemin copilot. */
function creerFauxClaude(dir, { events, exitCode = 0, stderr = '' } = {}) {
  const bin = path.join(dir, 'claude-faux');
  const fluxPath = path.join(dir, 'flux.ndjson');
  const argvPath = path.join(dir, 'argv.json');
  fs.writeFileSync(fluxPath, (events || []).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(fs.readFileSync(${JSON.stringify(fluxPath)}, 'utf8'));`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : '',
    `process.exit(${exitCode});`,
    '',
  ].filter(Boolean).join('\n'), 'utf8');
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    argv() { return JSON.parse(fs.readFileSync(argvPath, 'utf8')); },
    ecrireFlux(evts) { fs.writeFileSync(fluxPath, evts.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'); },
  };
}

module.exports = { creerFauxClaude };
