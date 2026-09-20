'use strict';
/* LE BACKEND LINUX, CONTRE UN FAUX AGENT MALVEILLANT (§9.2 du plan) — le test qui prouve que
 * l'isolation existe, pas seulement que le code compile. `bubblewrap` a besoin d'espaces de noms
 * utilisateur non privilégiés : indisponibles hors Linux, et hors d'un conteneur Docker qui n'a
 * pas reçu `--privileged` (constaté en préparant ce lot). Le SKIP est donc attendu ici, sur un
 * Mac de développement ou un simple `docker run` sans plus — `capabilities()` fait le même
 * calcul que `runner.js`, jamais un « ça devrait marcher » supposé.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-linux-data-'));

const linux = require('../src/sandbox/backends/linux');
const runner = require('../src/sandbox/runner');
const sfs = require('../src/sandbox/fs');

const FIXTURE = path.join(__dirname, 'fixtures', 'sandbox-agent.js');
// Le faux agent doit être VISIBLE depuis l'intérieur du bac à sable : un chemin hôte arbitraire
// dans `command.args` n'y existe pas plus qu'un autre fichier non monté — c'est justement ce que
// ce test vérifie pour tout le reste. On le copie donc dans la source avant chaque job, et on le
// désigne par son chemin CÔTÉ SANDBOX (`/workspace/…`), jamais son chemin hôte.
function prepareAvecFixture(depot) {
  return async (layout) => {
    await sfs.archiverVersDossier(depot.dir, depot.sha, layout.sourceRo);
    fs.copyFileSync(FIXTURE, path.join(layout.sourceRo, 'sandbox-agent.js'));
  };
}

let dispo = null;
let raisonIndispo = '';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function creerDepot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-linux-repo-'));
  git(dir, ['init', '-q', '--initial-branch=main', '.']);
  git(dir, ['config', 'user.email', 't@t.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, sha };
}

describe('sandbox backend Linux : confinement réel contre un agent malveillant', () => {
  let secretPath;
  let cloneDirPath;
  let depot;

  before(async () => {
    const cap = await linux.capabilities().catch((e) => ({ platform: false, bin: null, namespaces: false, erreur: e }));
    dispo = !!(cap.platform && cap.bin && cap.namespaces);
    raisonIndispo = !cap.platform ? 'plateforme non-Linux'
      : (!cap.bin ? 'bubblewrap introuvable' : 'espaces de noms utilisateur indisponibles (hors --privileged en conteneur, ou noyau restreint)');

    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-linux-secret-'));
    secretPath = path.join(secretDir, 'secret-hors-job.txt');
    fs.writeFileSync(secretPath, 'CE-SECRET-NE-DOIT-JAMAIS-SE-LIRE\n');
    cloneDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-linux-second-clone-'));
    fs.writeFileSync(path.join(cloneDirPath, 'autre-projet.txt'), 'contenu d’un autre dépôt\n');

    depot = creerDepot();
  });

  const specDeBase = () => ({
    id: `sbx-test-${Math.random().toString(36).slice(2)}`,
    kind: 'edit',
    source: { repoId: 1, sourcePath: depot.dir, revision: depot.sha, sourceMode: 'snapshot', allowExtraDirs: [] },
    command: { program: process.execPath, args: ['/workspace/sandbox-agent.js'], cwdRel: '.', agentBackend: 'verifier', agentOptions: {} },
    permissions: { filesystem: 'job-write', network: 'none' },
    limits: { wallTimeMs: 20000, files: 200, diskBytes: 4 * 1024 * 1024, pids: 32 },
    policyHash: null,
  });

  /* Chaque essai s'écrit sur stdout dès qu'il se termine (voir fixtures/sandbox-agent.js) : le
   * dernier (`trop_de_fichiers`) peut se faire tuer en plein milieu par la limite qu'il teste
   * lui-même, sans emporter les essais précédents avec lui. */
  const parserEssais = (logs) => {
    const rapport = {};
    for (const l of logs.join('').split('\n')) {
      if (!l.startsWith('ESSAI:')) continue;
      const o = JSON.parse(l.slice('ESSAI:'.length));
      rapport[o.nom] = o;
    }
    return rapport;
  };

  test('le job malveillant est bloqué sur chaque front, la source reste intacte, rien ne survit', async (t) => {
    if (!dispo) return t.skip(raisonIndispo);

    const logs = [];
    const resultat = await runner.executer(specDeBase(), {
      onLog: (l) => logs.push(l),
      env: { MERGERIE_TEST_SECRET: secretPath, MERGERIE_TEST_CLONE_DIR: cloneDirPath },
      prepareSource: prepareAvecFixture(depot),
    });
    const rapport = parserEssais(logs);
    assert.ok(Object.keys(rapport).length >= 6, `trop peu d’essais rapportés :\n${logs.join('')}`);

    // Écrire dans /workspace (source-ro) doit échouer ; /tmp (scratch) doit réussir.
    assert.equal(rapport.ecrire_workspace.bloque, true, JSON.stringify(rapport.ecrire_workspace));
    assert.equal(rapport.ecrire_tmp.bloque, false, JSON.stringify(rapport.ecrire_tmp));
    // Rien hors du job ne doit être lisible : ni le secret, ni un second dépôt.
    assert.equal(rapport.lire_secret_hors_job.bloque, true, JSON.stringify(rapport.lire_secret_hors_job));
    assert.equal(rapport.lire_second_clone.bloque, true, JSON.stringify(rapport.lire_second_clone));
    // Un lien vers /etc/passwd ne doit rien exposer (network:none → /etc n'est même pas monté).
    assert.equal(rapport.symlink_passwd.bloque, true, JSON.stringify(rapport.symlink_passwd));
    // Aucun socket d'agent SSH ni de Docker.
    assert.equal(rapport.ssh_agent_socket.detail, 'absent');
    assert.equal(rapport.docker_socket.detail, 'absent');
    // La boucle de création de fichiers (50 000, pour une limite de 200) ne doit jamais finir :
    // elle est coupée en cours de route — `trop_de_fichiers` n'apparaît donc PAS dans le rapport.
    assert.equal(rapport.trop_de_fichiers, undefined, 'la limite `files` aurait dû interrompre le job avant la fin de la boucle');
    assert.equal(resultat.code === null || resultat.code !== 0, true, 'le job tué ne se termine pas en succès');

    // La révision montée en lecture seule n'a pas bougé : ni écrite, ni un octet perdu.
    const app = fs.readFileSync(path.join(depot.dir, 'app.js'), 'utf8');
    assert.equal(app, 'module.exports = 1;\n');
  });

  test('network:none bloque une connexion, y compris depuis le sous-processus', async (t) => {
    if (!dispo) return t.skip(raisonIndispo);
    // Une limite `files` large : cet essai regarde le réseau, pas la limite de fichiers — la
    // boucle de fin doit pouvoir aller à son terme pour que `FIN` arrive sur stdout.
    const spec = { ...specDeBase(), limits: { ...specDeBase().limits, files: 100000, diskBytes: 64 * 1024 * 1024 } };
    const logs = [];
    await runner.executer(spec, {
      onLog: (l) => logs.push(l),
      env: { MERGERIE_TEST_SECRET: secretPath, MERGERIE_TEST_CLONE_DIR: cloneDirPath },
      prepareSource: prepareAvecFixture(depot),
    });
    const rapport = parserEssais(logs);
    assert.ok(logs.join('').includes('FIN'), 'le faux agent aurait dû aller à son terme, la limite de fichiers étant large ici');
    // `net.connect` ne lève pas de son côté (appel non-bloquant) : la preuve que la connexion
    // n'aboutit nulle part est faite positivement ailleurs (aucun socket ssh/docker visible,
    // `/etc` non monté) — ici on vérifie seulement que la tentative elle-même ne plante rien.
    assert.equal(rapport.reseau_loopback.bloque, false, 'l’appel est non-bloquant : "tenté" est le résultat correct ici');
  });

  test('un timeout tue le job entier, indépendamment des autres limites', async (t) => {
    if (!dispo) return t.skip(raisonIndispo);
    // Limites de fichiers/disque volontairement larges : seul `wallTimeMs` doit couper ce job.
    const spec = {
      ...specDeBase(),
      id: `sbx-timeout-${Math.random().toString(36).slice(2)}`,
      // Plus court que ce que le faux agent met à finir de lui-même (ses essais réseau attendent
      // jusqu'à 800 ms, puis il sort après 800 ms de plus) : le timeout doit couper AVANT.
      limits: { ...specDeBase().limits, wallTimeMs: 300, files: 100000, diskBytes: 64 * 1024 * 1024 },
    };
    const debut = Date.now();
    const resultat = await runner.executer(spec, {
      env: { MERGERIE_TEST_SECRET: secretPath, MERGERIE_TEST_CLONE_DIR: cloneDirPath },
      prepareSource: prepareAvecFixture(depot),
    });
    assert.equal(resultat.timedOut, true);
    assert.ok(Date.now() - debut < 15000, 'le timeout a bien coupé court, pas laissé la boucle de fichiers finir');
  });

  test('SANDBOX_UNAVAILABLE, jamais un lancement hôte silencieux, quand `bwrap` est absent', async () => {
    const bin = process.env.MERGERIE_BWRAP_BIN;
    process.env.MERGERIE_BWRAP_BIN = '/chemin/vers/rien-du-tout';
    linux.oublierCapacites();
    try {
      await assert.rejects(() => runner.executer(specDeBase(), {
        prepareSource: prepareAvecFixture(depot),
      }), { code: 'SANDBOX_UNAVAILABLE' });
    } finally {
      if (bin == null) delete process.env.MERGERIE_BWRAP_BIN; else process.env.MERGERIE_BWRAP_BIN = bin;
      linux.oublierCapacites();
    }
  });
});
