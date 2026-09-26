'use strict';
/* LE MODE LARGE, ET LE FILTRE QUI LE RETIRE — dans un module à part, importé par la politique
   ET par chaque backend, pour qu'aucun des deux n'ait à importer l'autre. La liste des options
   larges n'a de sens que dans `sansModeLarge` : `npm run check` refuse qu'elle soit lue
   ailleurs, et refuse toute fonction d'argv qui rendrait `extra` sans être passée par ici. */

/* Les options qui ÉLARGISSENT : retirées d'une saveur de lecture, et d'un profil qui porte sa
   propre liste (sans quoi sa liste ne vaut rien). `--permission-mode` prend une valeur. Les
   modes larges de chaque CLI connu sont là : claude, copilot, codex, gemini. */
const LARGES = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--yolo', '-y', '--allow-all-tools',
  '--dangerously-bypass-approvals-and-sandbox',
]);
function sansModeLarge(extra) {
  const out = [];
  const a = extra || [];
  for (let i = 0; i < a.length; i++) {
    const x = String(a[i]);
    if (LARGES.has(x)) continue;
    if (x === '--permission-mode' || x === '--approval-mode' || x === '--sandbox') { i += 1; continue; }
    if (x.startsWith('--permission-mode=') || x.startsWith('--approval-mode=') || x.startsWith('--sandbox=')) continue;
    out.push(a[i]);
  }
  return out;
}

module.exports = { sansModeLarge };
