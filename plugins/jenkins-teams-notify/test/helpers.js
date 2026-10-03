'use strict';
/* Aides de test : une COPIE du plugin dont `bin/teams-post.js` est un faux. Le plugin retrouve son script par
   `__dirname` : la copie lance donc le faux, sans qu'aucun réglage ni variable ne le désigne — rien dans le
   plugin n'existe « pour les tests ». Le faux note chaque appel (arguments, instants) et sort avec le code
   que dit `mode.json` — qu'un test change entre deux appels. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAUX_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');
const dir = __dirname;
let mode = {};
try { mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { /* défauts */ }
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), start: Date.now(), cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n');
setTimeout(() => {
  fs.appendFileSync(path.join(dir, 'ends.jsonl'), JSON.stringify({ end: Date.now() }) + '\\n');
  if (mode.stderr) console.error(mode.stderr);
  process.exit(mode.code || 0);
}, mode.delay || 0);
`;

/** Copie le plugin dans un dossier temporaire et remplace son script par le faux. */
function copierAvecFaux() {
  const src = path.join(__dirname, '..');
  const dst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jenkins-teams-notify-')), 'jenkins-teams-notify');
  fs.cpSync(src, dst, { recursive: true, filter: (f) => !f.includes(`${path.sep}node_modules`) && !f.endsWith(`${path.sep}calls.jsonl`) });
  fs.writeFileSync(path.join(dst, 'bin', 'teams-post.js'), FAUX_SCRIPT);
  const lire = (nom) => { try { return fs.readFileSync(path.join(dst, 'bin', nom), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return {
    dir: dst,
    appels: () => lire('calls.jsonl'),
    fins: () => lire('ends.jsonl'),
    mode: (m) => fs.writeFileSync(path.join(dst, 'bin', 'mode.json'), JSON.stringify(m)),
    /** La valeur d'un argument `--clé=…` du dernier appel (ou de l'appel n). */
    arg: (cle, n = -1) => { const a = lire('calls.jsonl'); const c = a.at(n); const x = c && c.argv.find((v) => v.startsWith(`--${cle}=`)); return x === undefined ? undefined : x.slice(cle.length + 3); },
    aDrapeau: (cle, n = -1) => { const c = lire('calls.jsonl').at(n); return !!c && c.argv.includes(`--${cle}`); },
  };
}

/** Attend qu'une condition devienne vraie — jamais une durée fixe : le test attend l'EFFET. */
async function attendre(cond, quoi, ms = 10000) {
  const fin = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > fin) throw new Error(`délai dépassé : ${quoi}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const LIEN = 'https://teams.microsoft.com/l/channel/19%3Aabc%40thread.tacv2/Deploiements?groupId=1&tenantId=2';
const SUCCES = { path: 'boutique/deploy', number: 12, result: 'SUCCESS', ok: true, url: 'https://jenkins.test/job/boutique/job/deploy/12/', duration: 83000, startedBy: 'moi' };
const DEBUT = { path: 'boutique/deploy', since: 11, parameters: {}, url: 'https://jenkins.test/job/boutique/job/deploy/', startedBy: 'moi' };

module.exports = { copierAvecFaux, attendre, LIEN, SUCCES, DEBUT, FAUX_SCRIPT };
