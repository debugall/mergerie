'use strict';
/* Installer le moteur de dictée depuis l'écran (whisper.md §6.5).
 *
 * Ce qui se joue ici est une question de SÛRETÉ autant que de confort : un bouton qui lance
 * un script avec les paramètres du client est exactement la forme d'une exécution arbitraire.
 * La règle du projet est donc : le chemin du script est FIXE, le modèle vient d'une liste
 * fermée, le GPU d'une énumération, le VAD d'un booléen — et rien d'autre ne traverse.
 *
 * L'autre moitié, c'est la lecture du RÉSULTAT. Le script termine par une ligne JSON que le
 * serveur relit pour remplir les réglages ; sans elle, l'installation est en erreur. Deviner
 * les chemins à la place du script les inventerait, et l'écran dirait « prêt » sur un moteur
 * qui n'existe pas.
 *
 * Le chemin Windows n'est couvert QU'ICI : le runner est Linux.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-install-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const dictation = require('../src/dictation');
const { getConfig, updateConfig } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');

describe('Installation · la commande construite', () => {
  test('macOS et Linux lancent le script shell du dépôt, avec le dossier de données forcé', () => {
    for (const platform of ['darwin', 'linux']) {
      const c = dictation.commandeInstallation({ platform, model: 'large-v3-turbo', vad: true, dataDir: '/donnees' });
      assert.equal(c.programme, 'sh');
      assert.equal(c.args[0], path.join(ROOT, 'scripts', 'install-whisper.sh'));
      assert.deepEqual(c.args.slice(1), ['--dir', '/donnees', '--model', 'large-v3-turbo']);
    }
  });

  test('Windows lance PowerShell sans profil, la politique n’étant relâchée que pour ce process', () => {
    const c = dictation.commandeInstallation({ platform: 'win32', model: 'large-v3', vad: false, gpu: 'cuda', dataDir: 'C:\\d' });
    assert.equal(c.programme, 'powershell.exe');
    assert.ok(c.args.includes('-NoProfile') && c.args.includes('-NonInteractive'));
    assert.equal(c.args[c.args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
    assert.equal(c.args[c.args.indexOf('-File') + 1], path.join(ROOT, 'scripts', 'install-whisper.ps1'));
    assert.equal(c.args[c.args.indexOf('-Dir') + 1], 'C:\\d');
    assert.equal(c.args[c.args.indexOf('-Model') + 1], 'large-v3');
    assert.ok(c.args.includes('-NoVad') && c.args.includes('-Cuda'));
  });

  test('sans VAD, l’option de refus est passée ; avec, rien n’est ajouté', () => {
    assert.ok(dictation.commandeInstallation({ platform: 'linux', vad: false }).args.includes('--no-vad'));
    assert.ok(!dictation.commandeInstallation({ platform: 'linux', vad: true }).args.includes('--no-vad'));
  });

  test('un modèle hors liste est refusé en 400 — jamais transmis au script', () => {
    for (const modele of ['../../etc/passwd', 'large-v3; rm -rf /', 'inconnu']) {
      assert.throws(() => dictation.commandeInstallation({ platform: 'linux', model: modele }),
        (e) => e.status === 400 && /mod[èe]le/i.test(e.message), modele);
    }
    for (const m of dictation.MODELES) {
      assert.ok(dictation.commandeInstallation({ platform: 'linux', model: m }).args.includes(m));
    }
  });

  test('un GPU hors énumération est refusé, et macOS n’en accepte aucun', () => {
    assert.throws(() => dictation.commandeInstallation({ platform: 'linux', gpu: 'opencl' }), (e) => e.status === 400);
    assert.throws(() => dictation.commandeInstallation({ platform: 'darwin', gpu: 'cuda' }), (e) => e.status === 400 && /Metal/i.test(e.message));
    assert.throws(() => dictation.commandeInstallation({ platform: 'win32', gpu: 'vulkan' }), (e) => e.status === 400);
    assert.ok(dictation.commandeInstallation({ platform: 'linux', gpu: 'vulkan' }).args.includes('--vulkan'));
  });

  test('un système inconnu ne fabrique aucune commande', () => {
    assert.throws(() => dictation.commandeInstallation({ platform: 'aix' }), (e) => e.status === 400 && /aix/.test(e.message));
  });

  test('l’environnement du script est minimal, et ne porte aucun jeton', () => {
    process.env.GITLAB_TOKEN_FACTICE = 'secret-a-ne-pas-fuiter';
    const env = dictation.envInstallation('/donnees');
    assert.equal(env.MERGERIE_JOB, '1', 'sans terminal : pas de barre de progression, et une ligne de résultat');
    assert.equal(env.MERGERIE_DATA_DIR, '/donnees');
    assert.ok(!('GITLAB_TOKEN_FACTICE' in env));
    assert.deepEqual(
      Object.keys(env).filter((k) => !['PATH', 'HOME', 'LANG', 'MERGERIE_JOB', 'MERGERIE_DATA_DIR', 'SystemRoot', 'TEMP', 'USERPROFILE'].includes(k)),
      [],
    );
    delete process.env.GITLAB_TOKEN_FACTICE;
  });
});

describe('Installation · la dernière ligne du script', () => {
  test('elle est lue même noyée dans un journal', () => {
    const sortie = 'blabla\n  ✓ ok\nMERGERIE_RESULT {"server":"/b/whisper-server","model":"/m/g.bin","vad":null,"backend":"Metal","in_path":true}\n';
    const r = dictation.lireResultatInstallation(sortie);
    assert.equal(r.server, '/b/whisper-server');
    assert.equal(r.backend, 'Metal');
    assert.equal(r.in_path, true);
  });

  test('absente ou tronquée, on ne rend RIEN — l’appelant en fera une erreur', () => {
    assert.equal(dictation.lireResultatInstallation('tout va bien\n'), null);
    assert.equal(dictation.lireResultatInstallation('MERGERIE_RESULT {"server":"/b",'), null);
    assert.equal(dictation.lireResultatInstallation('MERGERIE_RESULT {}'), null, 'un objet sans chemin ne dit rien');
    assert.equal(dictation.lireResultatInstallation(''), null);
  });

  test('la dernière l’emporte : une installation relancée écrase la précédente', () => {
    const s = 'MERGERIE_RESULT {"server":"/a","model":"/1.bin"}\nMERGERIE_RESULT {"server":"/b","model":"/2.bin"}';
    assert.equal(dictation.lireResultatInstallation(s).model, '/2.bin');
  });
});

describe('Installation · les réglages qu’elle remplit', () => {
  test('binaire dans le PATH ⇒ commande VIDE (un chemin absolu figerait l’installation)', () => {
    updateConfig({ dictation_provider: 'off', dictation_command: 'ancien' });
    const patch = dictation.reglagesDepuisResultat({ server: '/opt/homebrew/bin/whisper-server', model: '/m/g.bin', vad: '/m/s.bin', in_path: true });
    assert.equal(patch.dictation_command, '');
    assert.equal(patch.dictation_model, '/m/g.bin');
    assert.equal(patch.dictation_vad_model, '/m/s.bin');
    assert.equal(patch.dictation_provider, 'local', 'une dictée éteinte s’allume : c’est ce qu’on venait d’installer');
  });

  test('hors PATH ⇒ le chemin est écrit ; un VAD absent efface l’ancien', () => {
    const patch = dictation.reglagesDepuisResultat({ server: '/data/whisper/bin/whisper-server', model: '/m/g.bin', vad: null, in_path: false });
    assert.equal(patch.dictation_command, '/data/whisper/bin/whisper-server');
    assert.equal(patch.dictation_vad_model, '');
  });

  test('un fournisseur DÉJÀ choisi n’est pas écrasé', () => {
    updateConfig({ dictation_provider: 'openai' });
    const patch = dictation.reglagesDepuisResultat({ server: '/b', model: '/m.bin', in_path: true });
    assert.ok(!('dictation_provider' in patch), 'installer un moteur local ne débranche pas le fournisseur distant');
    updateConfig({ dictation_provider: 'off' });
  });

  test('les valeurs écrites se relisent bien depuis la base', () => {
    const patch = dictation.reglagesDepuisResultat({ server: '/b/whisper-server', model: '/m/turbo.bin', vad: '/m/silero.bin', in_path: true });
    updateConfig(patch);
    const c = getConfig();
    assert.equal(c.dictation_model, '/m/turbo.bin');
    assert.equal(c.dictation_vad_model, '/m/silero.bin');
    assert.equal(c.dictation_command, '');
    assert.equal(c.dictation_provider, 'local');
  });
});

describe('Installation · le script de test répond au contrat', () => {
  test('le faux script du harnais rend une ligne de résultat exploitable', async () => {
    const { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-whisper-'));
    const sortie = execFileSync('sh', [path.join(ROOT, 'test/helpers/fake-install-whisper.sh'), '--dir', dir, '--model', 'large-v3-turbo'],
      { encoding: 'utf8', env: { ...process.env, FAKE_INSTALL_SLEEP: '0' } });
    const r = dictation.lireResultatInstallation(sortie);
    assert.ok(r, 'le faux script doit rendre un MERGERIE_RESULT, comme le vrai');
    assert.equal(r.model, path.join(dir, 'models', 'ggml-large-v3-turbo.bin'));
    assert.ok(fs.existsSync(r.model), 'et le fichier qu’il annonce doit exister');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* TUER UN PID LU SUR LE DISQUE est le geste le plus dangereux de tout le module : un numéro
   de process est réattribué, et un fichier périmé désignerait alors n'importe quoi. La garde
   est qu'on ne tue QUE si le port noté répond encore — c'est-à-dire si c'est bien notre
   moteur. Ces deux épreuves tiennent les deux côtés de cette garde. */
describe('Moteur · l’orphelin d’une vie précédente', () => {
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const fichier = () => path.join(process.env.MERGERIE_DATA_DIR, 'dictation-engine.json');

  test('une note dont le port ne répond pas est jetée, et personne n’est tué', async () => {
    // Le PID de CE process : bien vivant, et surtout à ne pas tuer.
    fs.writeFileSync(fichier(), JSON.stringify({ pid: process.pid, port: 1 }));
    await dictation.tuerOrphelin();
    assert.equal(fs.existsSync(fichier()), false, 'la note périmée est retirée');
    assert.equal(process.killed, undefined, 'et ce process est toujours là');
  });

  test('un moteur qui répond encore sur son port est bien arrêté', async () => {
    const enfant = spawn(process.execPath, ['-e',
      "require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"],
    { stdio: ['ignore', 'pipe', 'ignore'] });
    const port = await new Promise((r) => enfant.stdout.once('data', (d) => r(Number(String(d).trim()))));
    await new Promise((r) => http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); r(); }));

    dictation.noterMoteur(enfant.pid, port);
    const mort = new Promise((r) => enfant.once('exit', r));
    await dictation.tuerOrphelin();
    await mort;
    assert.equal(fs.existsSync(fichier()), false, 'la note part avec le process qu’elle désignait');
  });
});

describe('Diagnostic · le composeur', () => {
  test('la similarité distingue « fonctionne » de « répond n’importe quoi »', () => {
    const attendu = 'Mergerie, test de la dictée : merge request 214 sur webapp-front.';
    assert.ok(dictation.similarite(attendu, 'mergerie test de la dictee merge request 214 sur webapp front') >= 0.8);
    assert.ok(dictation.similarite(attendu, 'la la la la la') < 0.5);
    assert.equal(dictation.similarite(attendu, ''), 0);
  });

  test('éteinte, la dictée ne prétend rien : une seule étape, en échec, avec son remède', async () => {
    updateConfig({ dictation_provider: 'off' });
    const d = await dictation.diagnostic();
    assert.equal(d.verdict, 'off');
    assert.equal(d.steps.length, 1);
    assert.equal(d.steps[0].status, 'fail');
    assert.ok(d.steps[0].remedy && !d.steps[0].remedy.startsWith('dictation.'), 'le remède est traduit');
  });

  /* La démo remplace le MOTEUR, jamais le réglage : « éteinte » reste éteinte même en
     dry-run. Le fournisseur est donc posé explicitement. */
  test('en démo, tout est vert et le moteur s’annonce comme simulé', async () => {
    updateConfig({ dictation_provider: 'local' });
    process.env.DICTATION_DRY_RUN = '1';
    const d = await dictation.diagnostic();
    assert.equal(d.verdict, 'ready');
    assert.equal(d.steps.filter((s) => s.status === 'ok').length, 6);
    assert.match(d.steps[0].detail, /simul|demo/i);
    delete process.env.DICTATION_DRY_RUN;
  });

  test('sans binaire, on s’arrête à la première marche et les suivantes sont sautées', async () => {
    updateConfig({ dictation_provider: 'local', dictation_command: '/binaire/qui/nexiste/pas' });
    const d = await dictation.diagnostic();
    assert.equal(d.verdict, 'incomplete');
    const par = Object.fromEntries(d.steps.map((s) => [s.key, s]));
    assert.equal(par.binary.status, 'fail');
    assert.ok(par.binary.remedy, 'la marche cassée dit comment la réparer');
    assert.equal(par.model.status, 'skip', 'inutile de chercher un modèle sans moteur pour le lire');
    assert.equal(par.start.status, 'skip');
    assert.equal(par.transcribe.status, 'skip');
    updateConfig({ dictation_provider: 'off', dictation_command: '' });
  });
});
