'use strict';
/* LES TYPES DES COUCHES PURES, sans build : `// @ts-check` + JSDoc sur `core/`, `forge/` et `verify/`.
   `tsc --noEmit` relit tout ce que ces fichiers importent (il ne sait pas s'arrêter à une couche),
   donc on ne retient que les erreurs QUI Y SONT : les autres couches s'y mettront quand elles
   porteront le pragme. Une erreur ici est une erreur de type dans un module qu'on prouve. */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const racine = path.resolve(__dirname, '..');
const tsc = path.join(racine, 'node_modules', '.bin', 'tsc');
const r = spawnSync(tsc, ['-p', 'tsconfig.check.json', '--pretty', 'false'], { cwd: racine, encoding: 'utf8' });
if (r.error) {
  console.log(`⚠️  Types : tsc introuvable (${r.error.message}) — npm ci d'abord`);
  process.exit(1);
}
const COUCHES = /^src\/(core|forge|verify)\//;
const lignes = String(r.stdout || '').split('\n').filter((l) => /error TS\d+/.test(l));
const retenues = lignes.filter((l) => COUCHES.test(l.replace(/\\/g, '/')));
if (retenues.length) {
  console.log(`❌ Types (${retenues.length})`);
  for (const l of retenues) console.log(`   ${l}`);
  process.exit(1);
}
console.log(`✅ Types : core/, forge/ et verify/ sous @ts-check (${lignes.length - retenues.length} erreur(s) hors périmètre, ignorées)`);
