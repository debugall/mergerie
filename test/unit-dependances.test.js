'use strict';
/* LES DÉPENDANCES AJOUTÉES SONT UN FAIT LU DANS LE DIFF DES MANIFESTES — une ligne de manifeste qui
 * n'existait pas avant — sans IA, sans registre, sans lockfile.
 *
 * Ce que ce fichier prouve, sur une base temporaire et sans serveur : chacun des dix analyseurs sur
 * sa fixture (`test/fixtures/manifests/`) ; une ligne déplacée ne compte pas ; un `package.json` dont
 * seuls les scripts changent ne compte rien ; le majeur se lit (`^0.27` → `^1.7`), ne se lit pas
 * (`*`), ou ne change pas ; un manifeste sans analyseur est « non analysé », jamais compté ; le
 * monorepo donne deux sections ; `mr_manifest_diff` ne garde que les manifestes, refuse au-delà de
 * 200 Ko, et la carte ne dit rien sans relevé frais ; la résolution des motifs ; la ligne de projet
 * d'une session ; le brief ; l'aperçu ; le module fermé à l'agent. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lireSource } = require('./helpers/sources');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dependances-'));
const FIX = path.join(__dirname, 'fixtures', 'manifests');
const fixture = (nom) => fs.readFileSync(path.join(FIX, nom), 'utf8');

describe('Dépendances ajoutées par une merge request', () => {
  let db; let dp; let c;
  const cfg = { mr_files_enabled: '1', deps_enabled: '1', manifest_patterns: '' };
  let repoId;
  const mrs = {};
  const now = new Date().toISOString();
  const noms = (l) => l.map((e) => e.name);

  before(() => {
    db = require('../src/db');
    dp = require('../src/review/dependances');
    c = require('../src/review/croisements');
    repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/app', 'https://gitlab.test/grp/app.git', 1, 'gitlab')").run().lastInsertRowid);
  });

  test('package.json : ajoutées en prod et en dev, un passage de majeur, un script ignoré ; sans contexte, la section est inconnue', () => {
    const a = dp.analyser('package.json', fixture('package-json-added.diff'));
    assert.equal(a.parser, 'package.json');
    assert.deepEqual(a.added, [{ name: 'left-pad', version: '^1.3.0', section: 'prod' }, { name: 'vitest', version: '^2.0.0', section: 'dev' }]);
    assert.deepEqual(a.changed, [{ name: 'axios', from: '^0.27.2', to: '^1.7.0', section: 'prod', major: true }]);
    assert.deepEqual(a.removed, []);
    const sans = dp.analyser('package.json', fixture('package-json-no-context.diff'));
    assert.deepEqual(sans.added, [{ name: 'left-pad', version: '^1.3.0', section: null }], 'hunk sans en-tête de section : comptée, section inconnue');
  });

  test('package.json : mineur → pas majeur ; « * » → majeur non lisible ; scripts et description seuls → rien ; ligne déplacée → rien', () => {
    const a = dp.analyser('package.json', fixture('package-json-minor.diff'));
    assert.deepEqual(a.changed.map((x) => [x.name, x.major]), [['axios', false], ['lodash', null]]);
    const s = dp.analyser('package.json', fixture('package-json-scripts-only.diff'));
    assert.deepEqual([s.added, s.changed, s.removed], [[], [], []]);
    const m = dp.analyser('package.json', fixture('package-json-moved.diff'));
    assert.deepEqual([m.added, m.changed, m.removed], [[], [], []], 'même nom, même contrainte des deux côtés : déplacée');
  });

  test('les neuf autres écosystèmes, sur leur fixture', () => {
    const comp = dp.analyser('composer.json', fixture('composer-json.diff'));
    assert.deepEqual(noms(comp.added), ['guzzlehttp/guzzle']); assert.equal(comp.changed[0].section, 'dev'); assert.equal(comp.changed[0].major, true);
    const req = dp.analyser('requirements.txt', fixture('requirements-txt.diff'));
    assert.deepEqual(noms(req.added), ['requests'], '-r, # et --index-url ignorés');
    assert.deepEqual(req.changed.map((x) => [x.name, x.from, x.to, x.major]), [['flask', '==2.3.0', '==3.0.0', true]], 'Flask et flask sont le même paquet');
    const py = dp.analyser('pyproject.toml', fixture('pyproject-toml.diff'));
    assert.deepEqual(py.added.map((x) => [x.name, x.section]), [['httpx', 'prod'], ['ruff', 'dev']]);
    assert.deepEqual(py.changed.map((x) => [x.name, x.major]), [['pytest', true]]);
    const go = dp.analyser('go.mod', fixture('go-mod.diff'));
    assert.deepEqual(noms(go.added), ['github.com/spf13/cobra'], '// indirect ignoré');
    assert.deepEqual(noms(go.removed), ['github.com/pkg/errors']);
    const cargo = dp.analyser('Cargo.toml', fixture('cargo-toml.diff'));
    assert.deepEqual(cargo.added.map((x) => [x.name, x.version]), [['tokio', '1.38'], ['anyhow', '1.0']], 'table inline et chaîne');
    assert.deepEqual(cargo.changed.map((x) => [x.name, x.section, x.major]), [['criterion', 'dev', false]]);
    const gem = dp.analyser('Gemfile', fixture('gemfile.diff'));
    assert.deepEqual(gem.added.map((x) => [x.name, x.section]), [['sidekiq', 'prod'], ['factory_bot', 'dev']], 'groupe :test → dev');
    assert.equal(gem.changed[0].name, 'rspec-rails');
    const pom = dp.analyser('pom.xml', fixture('pom-xml.diff'));
    assert.deepEqual(pom.added.map((x) => [x.name, x.version, x.section]), [['junit-jupiter', '5.10.0', 'dev']], '<scope>test</scope> → dev');
    assert.deepEqual(pom.changed.map((x) => [x.name, x.from, x.to, x.major]), [['commons-lang3', '3.12.0', '3.14.0', false]]);
    const gradle = dp.analyser('build.gradle', fixture('build-gradle.diff'));
    assert.deepEqual(gradle.added.map((x) => [x.name, x.version]), [['com.google.guava:guava', '33.0.0-jre']]);
    assert.deepEqual(gradle.changed.map((x) => [x.name, x.section, x.to]), [['org.junit.jupiter:junit-jupiter', 'dev', '5.10.0']], 'notation group/name/version lue');
    const cs = dp.analyser('src/App/App.csproj', fixture('csproj.diff'));
    assert.deepEqual(cs.added, [{ name: 'Serilog', version: '3.1.1', section: 'prod' }]);
  });

  test('un manifeste sans analyseur est « non analysé », jamais compté ; le majeur se lit sur les formes usuelles', () => {
    const a = dp.analyser('deps.edn', '+{:deps {org.clojure/core.async {:mvn/version "1.6.681"}}}');
    assert.equal(a.parser, null);
    assert.deepEqual(dp.totaux([a]), { added: 0, removed: 0, changed: 0, major: 0, major_unknown: 0, unparsed: 1 });
    assert.equal(dp.sautDeMajeur('^3.2', '^4.0'), true); assert.equal(dp.sautDeMajeur('~3', '3.x'), false);
    assert.equal(dp.sautDeMajeur('>=3.0', '>=4'), true); assert.equal(dp.sautDeMajeur('*', '^2'), null); assert.equal(dp.sautDeMajeur('', '1.0'), null);
  });

  test('monorepo : deux manifestes → deux analyses, le compte total sur le badge ; le diff des autres fichiers n’est pas un manifeste', () => {
    const blocs = dp.blocsManifestes(fixture('monorepo.diff'), dp.predicat(dp.DEFAUT_MANIFESTES));
    assert.deepEqual(blocs.map((b) => b.path), ['packages/api/package.json', 'packages/web/package.json']);
    const t = dp.totaux(blocs.map((b) => dp.analyser(b.path, b.diff)));
    assert.equal(t.added, 2);
  });

  test('mr_manifest_diff ne garde que les manifestes, refuse au-delà de 200 Ko, et la carte ne dit rien sans relevé frais', () => {
    const mr = (iid, paths, manifests, sha = `sha${iid}`) => {
      const r = db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, updated_at, gitlab_created_at, closed_seen)
        VALUES (?, ?, ?, ?, 'main', ?, 'to_review', ?, ?, 0)`).run(repoId, iid, `MR ${iid}`, `feature/${iid}`, sha, now, `2026-11-0${iid}T10:00:00.000Z`);
      mrs[iid] = Number(r.lastInsertRowid);
      c.poserFichiers(mrs[iid], sha, paths);
      dp.poserManifestes(mrs[iid], sha, manifests);
      return mrs[iid];
    };
    mr(1, ['package.json', 'src/a.js'], [{ path: 'package.json', diff: fixture('package-json-added.diff') }]);
    mr(2, ['src/a.js'], []);
    mr(3, ['package.json'], [{ path: 'package.json', diff: fixture('package-json-scripts-only.diff') }]);
    mr(4, ['package.json'], [{ path: 'package.json', diff: `+${'x'.repeat(201 * 1024)}` }]);
    mr(5, ['package.json'], null);
    mr(6, ['deps.edn'], [{ path: 'deps.edn', diff: '+{:deps {}}' }]);
    assert.deepEqual(db.prepare('SELECT DISTINCT path FROM mr_manifest_diff ORDER BY path').all().map((r) => r.path), ['deps.edn', 'package.json']);
    const cartes = dp.pourCartes(cfg);
    assert.deepEqual([cartes[mrs[1]].added, cartes[mrs[1]].changed, cartes[mrs[1]].major, cartes[mrs[1]].alert], [2, 1, 1, true]);
    assert.equal(cartes[mrs[1]].manifests[0].parser, 'package.json');
    assert.deepEqual(cartes[mrs[1]].patterns, { kind: 'default' });
    assert.equal(cartes[mrs[2]], undefined, 'aucun manifeste touché : rien');
    assert.equal(cartes[mrs[3]], undefined, 'scripts seuls : rien');
    assert.equal(cartes[mrs[4]].refused, 'too-large'); assert.equal(cartes[mrs[4]].added, 0, 'refusé : aucun compte inventé');
    assert.equal(db.prepare('SELECT refused, diff FROM mr_manifest_diff WHERE mr_id = ?').get(mrs[4]).diff, null);
    assert.equal(cartes[mrs[5]], undefined, 'relevé sans recherche de manifestes (NULL) : rien');
    assert.equal(db.prepare('SELECT manifests FROM mr_file_fetch WHERE mr_id = ?').get(mrs[5]).manifests, null);
    assert.equal(cartes[mrs[6]].unparsed, 1); assert.equal(cartes[mrs[6]].added, 0);
    // SHA de tête changé : le relevé ne parle plus de la tête, le badge disparaît.
    db.prepare("UPDATE mr SET current_sha = 'sha1-bis' WHERE id = ?").run(mrs[1]);
    assert.equal(dp.pourCartes(cfg)[mrs[1]], undefined);
    db.prepare("UPDATE mr SET current_sha = 'sha1' WHERE id = ?").run(mrs[1]);
    assert.ok(dp.pourCartes(cfg)[mrs[1]]);
    assert.deepEqual(dp.pourCartes({ ...cfg, deps_enabled: '0' }), {}, 'réglage décoché : rien');
    assert.deepEqual(dp.pourCartes({ ...cfg, mr_files_enabled: '0' }), {}, 'sans relevé des fichiers : rien');
  });

  test('résolution des motifs : dépôt → groupes (union) → global → défauts ; un glob invalide est refusé', () => {
    assert.equal(dp.motifsPour(cfg, repoId).source.kind, 'default');
    const glob = { ...cfg, manifest_patterns: 'deps.edn' };
    assert.deepEqual(dp.motifsPour(glob, repoId), { manifests: ['deps.edn'], source: { kind: 'config' } });
    const g1 = Number(db.prepare("INSERT INTO repo_group (name, manifest_patterns, created_at) VALUES ('clj', 'deps.edn', ?)").run(now).lastInsertRowid);
    const g2 = Number(db.prepare("INSERT INTO repo_group (name, manifest_patterns, created_at) VALUES ('node', 'package.json', ?)").run(now).lastInsertRowid);
    db.prepare('INSERT INTO repo_group_member (group_id, repo_id) VALUES (?, ?), (?, ?)').run(g1, repoId, g2, repoId);
    const m = dp.motifsPour(glob, repoId);
    assert.deepEqual(m.manifests, ['deps.edn', 'package.json']);
    assert.deepEqual(m.source, { kind: 'group', groups: [{ id: g1, name: 'clj' }, { id: g2, name: 'node' }] });
    db.prepare("UPDATE repo SET manifest_patterns = '**/Gemfile' WHERE id = ?").run(repoId);
    assert.deepEqual(dp.motifsPour(glob, repoId), { manifests: ['**/Gemfile'], source: { kind: 'repo', repo_id: repoId } });
    db.prepare("UPDATE repo SET manifest_patterns = '' WHERE id = ?").run(repoId);
    db.prepare('DELETE FROM repo_group').run();
    assert.throws(() => dp.normaliserMotifs('package.json\n*.{json}'), /ligne 2|line 2/);
    assert.ok(dp.predicat(dp.DEFAUT_MANIFESTES)('packages/api/package.json'));
    assert.ok(dp.predicat(dp.DEFAUT_MANIFESTES)('requirements-dev.txt'));
    assert.ok(!dp.predicat(dp.DEFAUT_MANIFESTES)('package-lock.json'), 'le lockfile n’est pas un manifeste');
  });

  test('la ligne de projet d’une session : un ajout → 1 ajoutée ; avant le commit → rien', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
    const avec = path.join(dir, 'avec.patch');
    fs.writeFileSync(avec, `${fixture('monorepo.diff')}`);
    assert.deepEqual(dp.pourCible(cfg, { id: 1, repo_id: repoId, commit_sha: 'c1', diff_path: avec }), { added: 2, removed: 0, changed: 0, major: 0 });
    const sans = path.join(dir, 'sans.patch');
    fs.writeFileSync(sans, 'diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\n+x\n');
    assert.deepEqual(dp.pourCible(cfg, { id: 2, repo_id: repoId, commit_sha: 'c2', diff_path: sans }), { added: 0, removed: 0, changed: 0, major: 0 });
    assert.equal(dp.pourCible(cfg, { id: 3, repo_id: repoId, commit_sha: null, diff_path: sans }), null);
    assert.equal(dp.pourCible({ ...cfg, deps_enabled: '0' }, { id: 1, repo_id: repoId, commit_sha: 'c1', diff_path: avec }), null);
  });

  test('le brief : les MR qui ajoutent, les plus anciennes d’abord, plafonnées, écartables sur un SHA ; l’aperçu compte les manifestes', () => {
    const l = dp.ajoutantDesDependances(cfg, 0);
    assert.deepEqual(l.map((m) => m.iid), [1], '!3 (scripts), !4 (refusée), !6 (non analysée) absentes');
    assert.equal(l[0].key, `${mrs[1]}:sha1`); assert.equal(l[0].added, 2); assert.equal(l[0].major, 1);
    assert.equal(dp.ajoutantDesDependances(cfg, 1).length, 1);
    const a = dp.apercu(cfg, { repoId });
    assert.equal(a.mrs, 6); assert.equal(a.manifests, 4, 'le package.json de !1, !3, !4 et !5 ; deps.edn n’en est pas un par défaut');
    assert.equal(a.with_manifest, 4);
    assert.equal(dp.apercu(cfg, { repoId, manifest_patterns: 'deps.edn' }).manifests, 1, 'les motifs proposés remplacent les défauts');
    assert.equal(dp.apercu(cfg, { repoId: 999 }).mrs, 0);
  });

  test('le module n’importe aucun module d’agent ni de forge', () => {
    const src = lireSource('review/dependances');
    assert.ok(!/require\(['"][^'"]*\/(agent|ai|forge)[/'"]/.test(src), 'aucun require vers agent/, ai* ou forge/');
    assert.ok(!/https?:\/\/(registry\.npmjs|pypi|packagist|crates\.io|rubygems)/.test(src), 'aucun registre');
  });
});
