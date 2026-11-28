'use strict';
/* LA DÉMO MONTRE LA FRISE. Le semis de démo est la vitrine de l'écran : la session en pleine convergence
 * (« à toi » à la troisième correction, depuis un quart d'heure, sa MR en lien, l'objectif et les passes) et la
 * session prête sur deux dépôts, dont la validation se range par dépôt. Semée dans un dossier jetable, relue par
 * le cockpit dans un autre processus — aucun des deux ne touche `data/` ni `data-demo/`. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.resolve(__dirname, '..');

describe('La démo montre la frise', () => {
  test('la session en convergence et la session prête sur deux dépôts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-frise-'));
    const env = { ...process.env, MERGERIE_DATA_DIR: dir, MERGERIE_DEMO: '1' };
    execFileSync('node', [path.join(RACINE, 'scripts', 'demo-seed.js')], { env, stdio: 'pipe', cwd: RACINE });
    // Le cockpit relu dans un fichier : `process.exit` couperait une sortie longue écrite dans un tube.
    const fichier = path.join(dir, 'cockpit.json');
    execFileSync('node', ['-e', `require('fs').writeFileSync(process.argv[1], JSON.stringify(require('./src/jobs/cockpit').construire())); process.exit(0);`, fichier],
      { env, cwd: RACINE, stdio: 'pipe' });
    const d = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    try {
      const conv = d.a_toi.find((l) => /PROJ-1430/.test(l.label));
      assert.ok(conv, 'la session en convergence est « à toi »');
      const e = conv.workflow.etapes;
      const ici = e[conv.workflow.courante];
      assert.deepEqual([ici.cle, ici.n, ici.etat, ici.seuil, ici.max], ['fix', 3, 'a_toi', 8, 3]);
      assert.ok(Date.now() - Date.parse(ici.depuis) > 5 * 60000, `la question attend depuis un moment (${ici.depuis})`);
      assert.deepEqual(e.filter((x) => x.cle === 'review' && x.note != null).map((x) => x.note), [5.1, 6.4, 7.2]);
      assert.match(e.find((x) => x.cle === 'push').mr_url || '', /^https?:\/\//, 'la MR en lien');
      const pret = d.pret.find((l) => /PROJ-1421/.test(l.label));
      assert.equal(pret.projets.length, 2, 'prête sur deux dépôts');
      const lignes = [...new Set(pret.workflow.etapes.filter((x) => x.cible != null).map((x) => x.cible))];
      const range = (nom) => pret.workflow.etapes.filter((x) => x.cle === 'verif' && x.nom === nom).map((x) => x.cibles.length);
      assert.equal(lignes.length, 2);
      assert.deepEqual(range('integ (démo)'), [2, 2], '« integ » couvre les deux (groupe backend)');
      assert.deepEqual(range('tests front (démo)'), [1, 1], '« tests front » ne couvre que le front');
      // L'étape tests : un scénario attendu, des tests dans les deux zones, tous rejoués, la MR de tests prête.
      const tests = d.termine.find((l) => /PROJ-1433/.test(l.label));
      assert.ok(tests, 'la session aux tests écrits est dans « Terminé »');
      const et = tests.workflow.etapes;
      assert.deepEqual(et.filter((x) => x.cle === 'scen-ecrire').map((x) => x.zone), ['session', 'tests']);
      assert.ok(et.filter((x) => x.cle === 'scen-rejouer').every((x) => x.etat === 'fait'));
      assert.equal(et.at(-1).mr_tests, 'prete');
      assert.deepEqual(et.find((x) => x.cle === 'scen-ecrire' && x.zone === 'tests').mr, { url: 'https://gitlab.demo/groupe/webapp-front/-/merge_requests/88', iid: 88, pret: true });
      assert.match(tests.chaine.scenario.attendu, /3 factures/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
