'use strict';
/* LA CONNAISSANCE D'UN AGENT DE DOMAINE.
 *
 * C'est la partie qui donne son sens à la fonctionnalité, et celle dont les erreurs se voient
 * le plus tard : une carte qui cite un chemin plausible fait perdre plus de temps qu'une carte
 * absente, parce qu'on lui fait confiance. Deux garanties sont tenues par le CODE et pas par
 * le prompt — un chemin est OUVERT sous le clone avant d'être cité sans réserve, et la section
 * « Notes de l'équipe » est recopiée d'une version à l'autre. Ce sont elles qu'on prouve ici,
 * sur un vrai dépôt git temporaire. */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentknow-'));
process.env.MERGERIE_DATA_DIR = path.join(tmp, 'data');
process.env.MERGERIE_CLAUDE_HOME = path.join(tmp, 'home');

// eslint-disable-next-line import/order
const db = require('../src/db');
// eslint-disable-next-line import/order
const agentknowledge = require('../src/agentknowledge');
// eslint-disable-next-line import/order
const agentprofile = require('../src/agentprofile');
// eslint-disable-next-line import/order
const { getConfig, updateConfig } = require('../src/config');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const clones = path.join(tmp, 'clones');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd, args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' });

let repoId; let cloneDir;
before(() => {
  updateConfig({ clone_path: clones });
  repoId = db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/api','https://x/a.git',1,'gitlab')").run().lastInsertRowid;
  // Le clone, là où `cloneDirFor` ira le chercher : un VRAI dépôt git, pour que le SHA existe.
  cloneDir = path.join(clones, 'grp__api');
  fs.mkdirSync(path.join(cloneDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, 'src/notify.js'), '// notify\n');
  fs.mkdirSync(path.join(cloneDir, 'src/templates'), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, 'src/templates/mail.txt'), 'x\n');
  git(cloneDir, ['init', '--initial-branch=main', '.']);
  git(cloneDir, ['add', '-A']);
  git(cloneDir, ['commit', '-m', 'init']);
});

const EN_TETE = [
  '<<<AGENT',
  'name: Notifications',
  'repo: grp/api | émet et route',
  'repo: grp/inconnu | pas chez nous',
  'path: grp/api | src/notify.js',
  'path: grp/api | src/templates',
  'path: grp/api | src/absent.js',
  'path: grp/api | ../../etc/passwd',
  'path: grp/api | /etc/hosts',
  'AGENT>>>',
].join('\n');

const CORPS = [
  '# Les notifications',
  '## Périmètre',
  'Ce que ça couvre : l’émission et le routage.',
  '## Dépôts concernés',
  '- **grp/api** — émission — chemins clés : `src/notify.js`, `src/templates`',
  '## Points d’entrée',
  '- `src/notify.js`',
  '## Mécanismes',
  '## Types / variantes',
  '## Configuration',
  '## Tests',
  '## Pièges',
  '## Non trouvé',
  '- `src/absent.js`',
  '## Notes de l’équipe',
  '',
].join('\n');

describe('agentknowledge : l’en-tête <<<AGENT>>>', () => {
  test('un en-tête valide donne le nom, les dépôts, les chemins — et le reste du document', () => {
    const h = agentknowledge.parseHeader(`${EN_TETE}\n\n${CORPS}`);
    assert.equal(h.name, 'Notifications');
    assert.deepEqual(h.repos.map((r) => r.project), ['grp/api', 'grp/inconnu']);
    assert.equal(h.repos[0].role, 'émet et route');
    assert.equal(h.paths.length, 5);
    assert.ok(h.rest.startsWith('# Les notifications'));
    assert.ok(!h.rest.includes('<<<AGENT'));
  });

  test('en-tête absent : rien — et surtout pas un agent créé au hasard', () => {
    assert.equal(agentknowledge.parseHeader('# Un document sans en-tête'), null);
  });

  test('en-tête mal formé : les lignes illisibles sont ignorées, pas le bloc entier', () => {
    const h = agentknowledge.parseHeader('<<<AGENT\nname: X\nn’importe quoi\nrepo: grp/api\nAGENT>>>\ncorps');
    assert.equal(h.name, 'X');
    assert.deepEqual(h.repos.map((r) => r.project), ['grp/api']);
    assert.deepEqual(h.paths, []);
  });
});

describe('agentknowledge : vérifier les chemins', () => {
  test('un chemin qui existe sous le clone est vérifié ; un chemin absent ne l’est pas', () => {
    const { verified, unverified } = agentknowledge.verifierChemins(getConfig(), [
      { project: 'grp/api', path: 'src/notify.js' },
      { project: 'grp/api', path: 'src/templates' },
      { project: 'grp/api', path: 'src/absent.js' },
    ]);
    assert.deepEqual(verified.map((x) => x.path).sort(), ['src/notify.js', 'src/templates']);
    assert.deepEqual(unverified.map((x) => x.path), ['src/absent.js']);
  });

  test('un « .. » ou un chemin absolu sort du dépôt : jamais vérifié', () => {
    // Vérifier un `../../etc/passwd` reviendrait à dire « ce chemin du sujet existe ».
    const { verified, unverified } = agentknowledge.verifierChemins(getConfig(), [
      { project: 'grp/api', path: '../../etc/passwd' },
      { project: 'grp/api', path: '/etc/hosts' },
    ]);
    assert.deepEqual(verified, []);
    assert.equal(unverified.length, 2);
  });

  test('un dépôt inconnu de Mergerie ne vérifie rien', () => {
    const { verified, unverified } = agentknowledge.verifierChemins(getConfig(), [
      { project: 'grp/inconnu', path: 'src/x.js' },
    ]);
    assert.deepEqual(verified, []);
    assert.equal(unverified.length, 1);
  });

  test('le Markdown porte la marque « non vérifié » — posée par le code, pas par le prompt', () => {
    const md = agentknowledge.marquerNonVerifies('Voir `src/absent.js` et `src/notify.js`.',
      [{ project: 'grp/api', path: 'src/absent.js' }]);
    assert.match(md, /`src\/absent\.js` \*\(non vérifié\)\*/);
    assert.ok(!/`src\/notify\.js` \*\(/.test(md), 'un chemin vérifié n’est pas marqué');
  });
});

describe('agentknowledge : créer puis mettre à jour', () => {
  let agentId;

  test('la sortie du cartographe CRÉE l’agent, son périmètre et sa connaissance v1', async () => {
    agentprofile.seedBuiltins();
    const carto = agentprofile.parCle('cartographer');
    const task = poserTask(carto, 'les notifications');
    const r = await agentknowledge.ingest(task, carto, `${EN_TETE}\n\n${CORPS}`, () => {});
    assert.equal(r.status, 'active');
    assert.equal(r.version, 1);
    agentId = r.agent_id;

    const a = agentprofile.lire(agentId);
    assert.equal(a.name, 'Notifications');
    assert.ok(a.is_domain, 'un sujet non nul fait l’agent de domaine');
    assert.equal(a.knowledge_prompt, 'les notifications');
    // `grp/inconnu` n'existe pas dans Mergerie : il est ignoré, pas inventé.
    assert.deepEqual(a.repos.map((x) => x.project), ['grp/api']);
    assert.equal(a.repos[0].role, 'readonly');
  });

  test('la version enregistre le SHA du dépôt et le compte de chemins non vérifiés', () => {
    const v = agentknowledge.versions(agentId)[0];
    assert.equal(v.version, 1);
    assert.equal(v.status, 'active');
    assert.equal(v.repos[0].sha, git(cloneDir, ['rev-parse', 'HEAD']).trim());
    assert.deepEqual(v.repos[0].paths.sort(), ['src/notify.js', 'src/templates']);
    assert.equal(v.unverified, 3, 'absent.js, .. et le chemin absolu');
  });

  test('une mise à jour rend une version EN ATTENTE — l’agent continue sur l’ancienne', async () => {
    const a = agentprofile.lire(agentId);
    // L'équipe a écrit une note à la main : c'est ce qu'aucune cartographie ne reproduit.
    agentknowledge.editer(a, `${agentknowledge.contenuActif(a)}\nLe canal Slack est coupé depuis mars.\n`);

    const carto = agentprofile.parCle('cartographer');
    const task = poserTask(carto, 'les notifications', agentId);
    // …et le cartographe, lui, a « oublié » la section.
    const nouveau = `${EN_TETE}\n\n${CORPS.replace('## Notes de l’équipe\n', '## Notes de l’équipe\n')}`;
    const r = await agentknowledge.ingest(task, carto, nouveau, () => {});
    assert.equal(r.status, 'pending');
    assert.equal(r.agent_id, agentId);

    const apres = agentprofile.lire(agentId);
    assert.equal(apres.knowledge.pending_version, r.version);
    assert.equal(apres.knowledge.version, r.version - 1, 'la version en service n’a pas bougé');
  });

  test('« Notes de l’équipe » est recopiée par le CODE, même si l’agent l’a effacée', () => {
    const v = agentknowledge.versions(agentId).find((x) => x.status === 'pending');
    const contenu = agentknowledge.versionDe(agentId, v.version).content;
    assert.match(contenu, /Le canal Slack est coupé depuis mars\./);
  });

  test('valider bascule : la nouvelle est en service, l’ancienne est remplacée', () => {
    const a = agentprofile.lire(agentId);
    const v = agentknowledge.versions(agentId).find((x) => x.status === 'pending');
    const avant = agentknowledge.versionActive(agentId).version;
    assert.deepEqual(agentknowledge.activer(a, v.version), { ok: true, version: v.version });
    assert.equal(agentknowledge.versionActive(agentId).version, v.version);
    assert.equal(agentknowledge.versions(agentId).find((x) => x.version === avant).status, 'superseded');
  });

  test('on ne valide pas deux fois, ni une version qui n’attend rien', () => {
    const a = agentprofile.lire(agentId);
    const active = agentknowledge.versionActive(agentId).version;
    assert.deepEqual(agentknowledge.activer(a, active), { error: 'agents.err.not-pending' });
    assert.deepEqual(agentknowledge.activer(a, 999), { error: 'agents.err.version-not-found' });
  });

  test('une édition à la main entre en service tout de suite, sans run', () => {
    const a = agentprofile.lire(agentId);
    const r = agentknowledge.editer(a, '# À la main\n## Périmètre\nCe que j’ai écrit moi-même.\n');
    const v = agentknowledge.versions(agentId).find((x) => x.version === r.version);
    assert.equal(v.status, 'active');
    assert.equal(v.task_id, null, 'cette version ne vient d’aucun run');
    assert.match(agentknowledge.contenuActif(a), /Ce que j’ai écrit moi-même\./);
  });

  test('les écarts remontés par un run s’accumulent sur la version en service', () => {
    const a = agentprofile.lire(agentId);
    agentknowledge.addGaps(a, { id: 42 }, [{ project: 'grp/api', path: 'src/templates', note: 'renommé' }]);
    assert.equal(agentprofile.lire(agentId).knowledge.gaps, 1);
  });

  test('un seul agent porte une version « active » à la fois', () => {
    // Garanti par l'index unique : deux cartes en service seraient deux vérités.
    const n = db.prepare("SELECT COUNT(*) n FROM agent_knowledge WHERE agent_id = ? AND status = 'active'").get(agentId).n;
    assert.equal(n, 1);
  });

  test('un nom déjà pris ne réécrit pas l’agent existant : il est suffixé', async () => {
    const carto = agentprofile.parCle('cartographer');
    const task = poserTask(carto, 'encore les notifications');
    const r = await agentknowledge.ingest(task, carto, `${EN_TETE}\n\n${CORPS}`, () => {});
    assert.notEqual(r.agent_id, agentId);
    assert.match(agentprofile.lire(r.agent_id).name, /Notifications \(2\)/);
  });

  test('sans en-tête, rien n’est créé — et c’est journalisé', async () => {
    const carto = agentprofile.parCle('cartographer');
    const avant = db.prepare('SELECT COUNT(*) n FROM agent').get().n;
    const journal = [];
    const r = await agentknowledge.ingest(poserTask(carto, 'x'), carto, '# Un document sans en-tête', (m) => journal.push(m));
    assert.equal(r, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agent').get().n, avant);
    assert.equal(journal.length, 1);
  });
});

describe('agentknowledge : l’index et le diff', () => {
  test('l’index tient sous 4 000 caractères et nomme le périmètre et les chemins', () => {
    const a = db.prepare("SELECT * FROM agent WHERE name = 'Notifications'").get();
    // Une connaissance longue ne doit pas remplir le prompt système.
    agentknowledge.editer(a, `# X\n## Périmètre\nUne phrase.\n## Corps\n${'x'.repeat(9000)}\n`);
    const idx = agentknowledge.indexFor(a);
    assert.ok(idx.length <= 4000, idx.length);
    assert.match(idx, /Notifications/);
    assert.match(idx, /Une phrase\./);
  });

  test('le diff mécanique nomme les dépôts entrés et sortis, et compte les chemins', () => {
    const avant = [{ project: 'a', paths: ['x.js'] }, { project: 'b', paths: [] }];
    const apres = [{ project: 'a', paths: ['x.js', 'y.js'] }, { project: 'c', paths: [] }];
    const d = agentknowledge.diffSummary('', '', apres, avant);
    assert.match(d, /c/);
    assert.match(d, /b/);
    assert.match(d, /1/);
  });

  test('sans changement, il le DIT plutôt que de rendre vide', () => {
    const l = [{ project: 'a', paths: ['x.js'] }];
    assert.ok(agentknowledge.diffSummary('', '', l, l).length > 0);
  });

  test('le paragraphe « Ce qui a changé » du cartographe s’ajoute au diff mécanique', () => {
    const md = '# X\n## Corps\n\n## Ce qui a changé\nLe dossier a été renommé.\n';
    assert.match(agentknowledge.diffSummary('', md, [], []), /Le dossier a été renommé\./);
  });
});

describe('agentknowledge : l’âge, sans IA', () => {
  test('compte les commits qui ont touché les chemins cités depuis le SHA de la carte', async () => {
    // C'est ce qui permet de dire qu'une carte a vieilli, pour rien, sans appel d'IA.
    const a = db.prepare("SELECT * FROM agent WHERE name = 'Notifications'").get();
    const sha = git(cloneDir, ['rev-parse', 'HEAD']).trim();
    // Un « origin » local pour que `origin/main` existe : c'est ce que l'âge compare.
    git(cloneDir, ['branch', '-f', 'origin-main']);
    fs.writeFileSync(path.join(cloneDir, 'src/notify.js'), '// notify v2\n');
    fs.writeFileSync(path.join(cloneDir, 'README.md'), 'hors périmètre\n');
    git(cloneDir, ['add', '-A']);
    git(cloneDir, ['commit', '-m', 'change notify']);
    const nouveau = git(cloneDir, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(sha, nouveau);
    // Le comptage lui-même, en direct : `age()` passe par un fetch, qu'un clone local n'a pas.
    const sortie = git(cloneDir, ['log', '--format=%H', `${sha}..HEAD`, '--', 'src/notify.js']);
    assert.equal(sortie.trim().split('\n').filter(Boolean).length, 1);
    const horsPerimetre = git(cloneDir, ['log', '--format=%H', `${sha}..HEAD`, '--', 'src/templates']);
    assert.equal(horsPerimetre.trim(), '', 'un commit hors des chemins cités ne vieillit pas la carte');
    assert.ok(a);
  });
});

function poserTask(agent, prompt, agentIdSur = null) {
  const now = new Date().toISOString();
  /* `agent_question` porte la demande telle qu'elle a été TAPÉE — `prompt`, lui, est la demande
     composée. C'est la question d'origine qui devient le sujet de l'agent de domaine. */
  const id = db.prepare(`INSERT INTO task (repo_id, kind, prompt, agent_question, branch, base_branch, status, agent_id, agent_name, created_at, updated_at)
    VALUES (?, 'explore', ?, ?, '', NULL, 'done', ?, ?, ?, ?)`)
    .run(repoId, `Sujet :\n\n${prompt}`, prompt, agentIdSur || agent.id, agent.name, now, now).lastInsertRowid;
  return db.prepare('SELECT * FROM task WHERE id = ?').get(id);
}
