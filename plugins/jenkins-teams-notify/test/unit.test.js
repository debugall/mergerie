'use strict';
/* Les briques PURES de jenkins-teams-notify : modèles, filtre, validation des adresses, arguments, file, codes de sortie.
   Aucun navigateur, aucun serveur — `node --test` suffit. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modeles = require('../src/modeles');
const validation = require('../src/validation');
const lanceur = require('../src/lanceur');

describe('modèles de message', () => {
  test('les six variables sont rendues', () => {
    const v = { job: 'boutique/deploy', number: '12', url: 'https://j/12/', result: 'SUCCESS', duration: '1 min', startedBy: 'moi' };
    assert.equal(modeles.rendre('{{job}}|{{number}}|{{url}}|{{result}}|{{duration}}|{{startedBy}}', v), 'boutique/deploy|12|https://j/12/|SUCCESS|1 min|moi');
  });
  test('une variable manquante, inconnue ou nulle rend une chaîne vide — sans crash', () => {
    assert.equal(modeles.rendre('a{{number}}b{{inconnue}}c{{ job }}d', { job: null }), 'abcd');
    assert.equal(modeles.rendre('{{job}} #{{number}}', {}), '#');
    assert.equal(modeles.rendre(undefined, undefined), '');
    assert.doesNotThrow(() => modeles.rendre('{{', null));
    assert.doesNotMatch(modeles.rendre('{{job}} {{x}}', { job: undefined }), /undefined|null/);
  });
  test('une variable ne peut pas en introduire une autre, et le message tient sur une ligne', () => {
    assert.equal(modeles.rendre('{{job}}', { job: '{{url}}', url: 'secret' }), '{{url}}');
    assert.equal(modeles.rendre('a\n\nb\tc\u0000d', {}), 'a b c d');
  });
  test('la durée se lit : secondes, minutes, heures ; vide si inconnue', () => {
    assert.deepEqual([83000, 5000, 120000, 3600000, 3700000, 0, 'x', null].map(modeles.formaterDuree), ['1 min 23 s', '5 s', '2 min', '1 h', '1 h 1 min', '', '', '']);
  });
  test('un événement Jenkins devient un type de message et ses variables — rien d’autre n’entre', () => {
    const fini = modeles.classer('jenkins.job.finished', { version: 1, path: 'a/b', number: 3, result: 'FAILURE', ok: false, url: 'u', duration: 61000, startedBy: 'x', session: 'SECRET', mr: { titre: 'privé' } });
    assert.equal(fini.type, 'failure');
    assert.deepEqual(Object.keys(fini.variables).sort(), [...modeles.VARIABLES].sort(), 'seules les variables connues existent');
    assert.ok(!JSON.stringify(fini).includes('SECRET') && !JSON.stringify(fini).includes('privé'));
    assert.deepEqual(['SUCCESS', 'ABORTED', 'FAILURE', 'UNSTABLE', 'NOT_BUILT', 'UNKNOWN', ''].map((r) => modeles.classer('jenkins.job.finished', { path: 'j', result: r }).type),
      ['success', 'aborted', 'failure', 'failure', 'failure', 'failure', 'failure']);
    const debut = modeles.classer('jenkins.job.started', { path: 'a/b', since: 2, url: 'u', startedBy: 's' });
    assert.deepEqual([debut.type, debut.variables.number, debut.variables.result, debut.variables.duration], ['started', '', '', '']);
    assert.equal(modeles.classer('autre.chose', {}), null);
  });
  test('le modèle vide retombe sur celui de la langue', () => {
    assert.equal(modeles.modeleDe({ template_started: '  ' }, 'started', (t) => `défaut ${t}`), 'défaut started');
    assert.equal(modeles.modeleDe({ template_started: 'à moi' }, 'started', () => 'défaut'), 'à moi');
  });
});

describe('filtre glob sur le nom complet du job', () => {
  const ok = (m, j) => modeles.filtreAccepte(m, j);
  test('vide = tous les jobs', () => { assert.equal(ok([], 'x/y'), true); assert.equal(ok('', 'x'), true); assert.equal(ok('\n , \n', 'x'), true); });
  test('* ne traverse pas « / », ** le traverse, ? remplace un caractère', () => {
    assert.equal(ok(['boutique/*'], 'boutique/deploy'), true);
    assert.equal(ok(['boutique/*'], 'boutique/a/b'), false);
    assert.equal(ok(['boutique/**'], 'boutique/a/b'), true);
    assert.equal(ok(['equipe/**/deploy'], 'equipe/a/b/deploy'), true);
    assert.equal(ok(['api-?'], 'api-1'), true);
    assert.equal(ok(['api-?'], 'api-12'), false);
    assert.equal(ok(['api-?'], 'api-/'), false);
  });
  test('le motif est ancré, et les caractères spéciaux d’une regex sont littéraux', () => {
    assert.equal(ok(['deploy'], 'boutique/deploy'), false);
    assert.equal(ok(['a.b'], 'axb'), false);
    assert.equal(ok(['a.b'], 'a.b'), true);
    assert.equal(ok(['(x)+[y]'], '(x)+[y]'), true);
    assert.doesNotThrow(() => modeles.filtreAccepte(['[', '(', '\\'], 'x'));
  });
  test('plusieurs motifs : l’un suffit ; la saisie accepte lignes et virgules', () => {
    assert.deepEqual(modeles.lireMotifs('a/*\n b/** ,c'), ['a/*', 'b/**', 'c']);
    assert.equal(ok('a/*\nb/**', 'b/x/y'), true);
    assert.equal(ok('a/*\nb/**', 'c/x'), false);
  });
});

describe('adresses acceptées', () => {
  test('le lien Teams : https uniquement, sans identifiants', () => {
    assert.equal(validation.lienTeams('https://teams.microsoft.com/l/channel/x?y=1').ok, true);
    for (const mauvais of ['http://teams.microsoft.com/x', 'ftp://x/y', 'javascript:alert(1)', 'file:///etc/passwd', 'teams.microsoft.com/x', '', 'https://u:p@teams.microsoft.com/x']) {
      assert.equal(validation.lienTeams(mauvais).ok, false, mauvais);
    }
  });
  test('l’adresse CDP : la machine locale uniquement', () => {
    for (const bon of ['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222', 'ws://127.0.0.1:9222/devtools/browser/abc']) assert.equal(validation.urlCdp(bon).ok, true, bon);
    for (const mauvais of ['http://evil.example:9222', 'http://localhost.evil.com:9222', 'http://127.0.0.1.evil.com:9222', 'http://127.0.0.1@evil.com:9222', 'http://192.168.1.5:9222', 'http://0.0.0.0:9222', 'file:///x', 'ftp://127.0.0.1', '']) {
      assert.equal(validation.urlCdp(mauvais).ok, false, mauvais);
    }
  });
  test('ce qui empêche d’envoyer : lien absent ou en http, adresse CDP absente ou distante', () => {
    assert.deepEqual(validation.problemes({ team_link: '' }).map((p) => p.champ), ['team_link']);
    assert.deepEqual(validation.problemes({ team_link: 'http://x/y' }).map((p) => p.champ), ['team_link']);
    assert.deepEqual(validation.problemes({ team_link: 'https://t/x', session_mode: 'profile' }), []);
    assert.deepEqual(validation.problemes({ team_link: 'https://t/x', session_mode: 'cdp', cdp_url: '' }).map((p) => p.champ), ['cdp_url']);
    assert.deepEqual(validation.problemes({ team_link: 'https://t/x', session_mode: 'cdp', cdp_url: 'http://evil.com:9222' }).map((p) => p.champ), ['cdp_url']);
    assert.deepEqual(validation.problemes({ team_link: 'https://t/x', session_mode: 'cdp', cdp_url: 'http://127.0.0.1:9222' }), []);
  });
});

describe('arguments du script', () => {
  const R = { team_link: 'https://teams.microsoft.com/l/channel/x', channel_name: 'Deploiements', session_mode: 'profile', headless: true };
  test('un tableau, le script en premier, le message en `--message=…`', () => {
    const args = lanceur.construireArgs('/p/teams-post.js', R, 'Bonjour', { profileDir: '/data/profile' });
    assert.ok(Array.isArray(args));
    assert.equal(args[0], '/p/teams-post.js');
    assert.deepEqual(args.slice(1), ['--message=Bonjour', `--channel-url=${R.team_link}`, '--channel-name=Deploiements', '--profile-dir=/data/profile', '--headless=true']);
  });
  test('un message plein de métacaractères arrive INTACT, en un seul élément — jamais découpé ni interprété', () => {
    const pieges = ['a; rm -rf /', 'x | cat /etc/passwd', '$(touch /tmp/pwn)', '`id`', 'a && b || c', "it's \"quoted\"", '> /tmp/out', '-c', '--exec=boom', '-e', '${HOME}', 'ligne1\nligne2', '*', '~', '\\'];
    for (const m of pieges) {
      const args = lanceur.construireArgs('/s.js', R, m, { profileDir: '/p' });
      const porteurs = args.filter((a) => a.startsWith('--message='));
      assert.equal(porteurs.length, 1);
      assert.equal(porteurs[0], `--message=${m}`, JSON.stringify(m));
      assert.ok(args.every((a) => typeof a === 'string'));
      assert.ok(!args.some((a) => /^-c$|^-e$|^--exec(=|$)/.test(a)), 'la valeur d’un message ne devient jamais un drapeau refusé par ctx.exec');
    }
  });
  test('mode cdp : l’adresse, et pas de profil ; dry-run et délai de connexion ; headless explicite', () => {
    const cdp = lanceur.construireArgs('/s.js', { ...R, session_mode: 'cdp', cdp_url: 'http://127.0.0.1:9222' }, 'm', { profileDir: '/p' });
    assert.ok(cdp.includes('--cdp-url=http://127.0.0.1:9222'));
    assert.ok(!cdp.some((a) => a.startsWith('--profile-dir=')));
    const login = lanceur.construireArgs('/s.js', R, '', { profileDir: '/p', dryRun: true, headless: false, loginTimeoutMs: 300000 });
    assert.ok(login.includes('--dry-run') && login.includes('--headless=false') && login.includes('--login-timeout-ms=300000'));
    assert.ok(!lanceur.construireArgs('/s.js', R, 'm', { profileDir: '/p' }).includes('--dry-run'));
  });
});

describe('codes de sortie', () => {
  test('0 posté · 2 session expirée · 3 prérequis · le reste, un échec', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 127, -1, null, undefined, 255].map(lanceur.statutDeSortie), ['ok', 'echec', 'session', 'prerequis', 'echec', 'echec', 'echec', 'echec', 'echec', 'echec']);
  });
  test('le texte d’erreur gardé est la dernière ligne utile, tronquée', () => {
    assert.equal(lanceur.erreurCourte('a\nb\n\n'), 'b');
    assert.equal(lanceur.erreurCourte('x'.repeat(500)).length, 200);
    assert.equal(lanceur.erreurCourte(undefined), '');
  });
});

describe('la file : un seul navigateur à la fois', () => {
  const attente = (ms) => new Promise((r) => setTimeout(r, ms));

  test('les tâches s’exécutent l’une après l’autre, dans l’ordre d’arrivée — jamais deux en même temps', async () => {
    let actifs = 0; let max = 0; const ordre = [];
    const file = lanceur.creerFile({ executer: async (args) => { actifs += 1; max = Math.max(max, actifs); ordre.push(args[0]); await attente(15); actifs -= 1; return { code: 0 }; } });
    const rs = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => file.pousser([x])));
    assert.equal(max, 1, 'un seul exécuteur à la fois');
    assert.deepEqual(ordre, ['a', 'b', 'c', 'd', 'e']);
    assert.ok(rs.every((r) => r.statut === 'ok'));
    assert.equal(file.longueur(), 0);
  });
  test('une tâche qui échoue (code ou exception) ne bloque pas la suivante', async () => {
    const codes = { a: 1, b: 'boom', c: 0 };
    const file = lanceur.creerFile({ executer: async (args) => { const c = codes[args[0]]; if (c === 'boom') throw new Error('spawn ENOENT'); return { code: c, stderr: 'raté' }; } });
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => file.pousser([x])));
    assert.deepEqual([a.statut, b.statut, c.statut], ['echec', 'echec', 'ok']);
    assert.match(b.erreur, /ENOENT/);
  });
  test('un échec est réessayé UNE fois ; une session expirée ou un prérequis manquant ne le sont pas', async () => {
    const appels = { echec: 0, session: 0, prerequis: 0, passe: 0 };
    const exec = async (args) => {
      appels[args[0]] += 1;
      if (args[0] === 'echec') return { code: 1, stderr: 'x' };
      if (args[0] === 'session') return { code: 2 };
      if (args[0] === 'prerequis') return { code: 3 };
      return appels.passe === 1 ? { code: 1 } : { code: 0 }; // échoue puis réussit
    };
    const file = lanceur.creerFile({ executer: exec });
    const rs = {};
    for (const k of Object.keys(appels)) rs[k] = await file.pousser([k]);
    assert.deepEqual(appels, { echec: 2, session: 1, prerequis: 1, passe: 2 });
    assert.deepEqual([rs.echec.statut, rs.echec.tentatives, rs.session.statut, rs.prerequis.statut, rs.passe.statut, rs.passe.tentatives], ['echec', 2, 'session', 'prerequis', 'ok', 2]);
  });
  test('un délai dépassé est un échec « delai », réessayé une fois', async () => {
    let n = 0;
    const file = lanceur.creerFile({ executer: async () => { n += 1; throw new Error('jenkins-teams-notify : exec — node : délai dépassé après 120000 ms'); } });
    const r = await file.pousser(['x']);
    assert.deepEqual([r.statut, n], ['delai', 2]);
  });
  test('le délai demandé est transmis à l’exécuteur', async () => {
    const vus = [];
    const file = lanceur.creerFile({ executer: async (a, ms) => { vus.push(ms); return { code: 0 }; } });
    await file.pousser(['a']); await file.pousser(['b'], { timeoutMs: 330000 });
    assert.deepEqual(vus, [lanceur.TIMEOUT_MS, 330000]);
    assert.equal(lanceur.TIMEOUT_MS, 120000);
  });
  test('une file pleine abandonne au lieu d’empiler', async () => {
    let libere; const porte = new Promise((r) => { libere = r; });
    const file = lanceur.creerFile({ max: 2, executer: async () => { await porte; return { code: 0 }; } });
    const ps = [file.pousser(['1']), file.pousser(['2']), file.pousser(['3'])];
    await attente(10);
    const refus = await file.pousser(['4']);
    assert.deepEqual([refus.statut, refus.tentatives], ['abandon', 0]);
    libere();
    assert.deepEqual((await Promise.all(ps)).map((r) => r.statut), ['ok', 'ok', 'ok']);
  });
});

describe('le plugin ne lance jamais un shell', () => {
  test('aucune source du plugin n’importe child_process ni n’active un shell', () => {
    const racine = path.join(__dirname, '..');
    for (const f of ['index.js', 'src/modeles.js', 'src/lanceur.js', 'src/validation.js']) {
      const src = fs.readFileSync(path.join(racine, f), 'utf8');
      assert.doesNotMatch(src, /child_process|shell\s*:\s*true|\bexecSync\b|\bspawnSync\b|\bexecFile\b/, f);
    }
  });
});
