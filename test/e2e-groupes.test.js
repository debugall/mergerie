'use strict';
/* LES GROUPES DE DÉPÔTS, PAR L'API (ameliorations_proposal.md, §4.5).
 *
 * Créer, modifier, supprimer un groupe ; ce que la liste des dépôts et la fiche en disent ; une
 * règle de review limitée à un groupe ; un vérificateur qui couvre PAR le groupe — et qui vérifie
 * pour de vrai une merge request d'un membre sans ligne de couverture directe ; la configuration
 * effective d'un dépôt, avec l'origine de chaque valeur. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, waitForJobs, poserIdentiteGit } = require('./helpers/app');

describe('Groupes de dépôts', () => {
  let app; const ids = {}; let mrId; let bin;

  const depot = (nom) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `grp-${nom}-`));
    const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); poserIdentiteGit(d);
    fs.writeFileSync(path.join(d, 'a.txt'), 'base\n'); g('add', '-A'); g('commit', '-qm', 'base');
    g('checkout', '-q', '-b', 'feature/x'); fs.writeFileSync(path.join(d, 'a.txt'), 'tête\n'); g('add', '-A'); g('commit', '-qm', 'tête');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
    g('checkout', '-q', 'main');
    return { dir: d, head };
  };

  before(async () => {
    app = await startApp();
    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'grp-clones-')) });
    const api = depot('api'); const web = depot('web'); const legacy = depot('legacy');
    ids.api = (await app.api('POST', '/api/repos', { project: 'acme/api', url: api.dir })).body.id;
    ids.web = (await app.api('POST', '/api/repos', { project: 'acme/web', url: web.dir })).body.id;
    ids.legacy = (await app.api('POST', '/api/repos', { project: 'acme/legacy', url: legacy.dir })).body.id;
    app.state.projects = [{ id: 1, path_with_namespace: 'acme/web', http_url_to_repo: web.dir }];
    app.state.mrs['acme/web'] = [{ iid: 7, title: 'Changement', state: 'opened', source_branch: 'feature/x', target_branch: 'main', web_url: 'https://gitlab.test/acme/web/-/merge_requests/7', sha: web.head, created_at: new Date().toISOString(), author: { name: 'A' } }];
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 7).id;
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-bin-'));
  });
  after(async () => { if (app) await app.stop(); });

  test('créer, relire, modifier : le groupe porte ses membres et ses gabarits, un nom pris est refusé', async () => {
    const r = await app.api('POST', '/api/repo-groups', { name: 'backend', description: 'API', repos: [ids.api, ids.web], prompt_review: 'REVIEW-BACKEND {source}', ai_extra_instructions: 'consignes backend' });
    assert.equal(r.status, 200, r.text);
    ids.backend = r.body.id;
    assert.deepEqual(r.body.repos.map((x) => x.project), ['acme/api', 'acme/web']);
    assert.equal((await app.api('POST', '/api/repo-groups', { name: 'backend' })).status, 400, 'un nom pris');
    assert.equal((await app.api('POST', '/api/repo-groups', { name: 'x', repos: [999999] })).status, 400, 'un dépôt inconnu');
    assert.equal((await app.api('POST', '/api/repo-groups', { name: '   ' })).status, 400, 'un nom vide');
    const liste = (await app.api('GET', '/api/repo-groups')).body;
    assert.equal(liste.length, 1); assert.equal(liste[0].name, 'backend'); assert.equal(liste[0].rules, 0);
    const maj = await app.api('PUT', `/api/repo-groups/${ids.backend}`, { repos: [ids.api], description: 'API seule' });
    assert.equal(maj.status, 200, maj.text);
    assert.deepEqual(maj.body.repos.map((x) => x.project), ['acme/api']);
    assert.equal(maj.body.prompt_review, 'REVIEW-BACKEND {source}', 'un PUT partiel garde ce qu’il ne cite pas');
    await app.api('PUT', `/api/repo-groups/${ids.backend}`, { repos: [ids.api, ids.web] });
  });

  test('la liste des dépôts, la fiche et la configuration effective disent le groupe et l’origine des valeurs', async () => {
    const repos = (await app.api('GET', '/api/repos')).body;
    assert.deepEqual(repos.find((x) => x.id === ids.api).groups.map((g) => g.name), ['backend']);
    assert.deepEqual(repos.find((x) => x.id === ids.legacy).groups, []);
    const fiche = (await app.api('GET', `/api/repos/${ids.web}/sheet`)).body;
    assert.deepEqual(fiche.groups.map((g) => g.name), ['backend']);
    const eff = (await app.api('GET', `/api/repos/${ids.web}/effective`)).body;
    assert.equal(eff.fields.prompt_review.value, 'REVIEW-BACKEND {source}');
    assert.deepEqual(eff.fields.prompt_review.origin, { kind: 'group', group_id: ids.backend, name: 'backend' });
    assert.equal(eff.fields.prompt_fix.origin.kind, 'global');
    const effLegacy = (await app.api('GET', `/api/repos/${ids.legacy}/effective`)).body;
    assert.equal(effLegacy.fields.prompt_review.origin.kind, 'global');
  });

  test('une règle de review limitée au groupe apparaît sur la fiche de chaque membre, jamais ailleurs', async () => {
    const r = await app.api('POST', '/api/rules', { path_match: 'src/**', content: 'Contrat OpenAPI à jour.', group_id: ids.backend });
    assert.equal(r.status, 200, r.text); ids.regle = r.body.id;
    assert.equal((await app.api('POST', '/api/rules', { path_match: 'x', content: 'y', group_id: 999999 })).status, 400, 'un groupe inconnu');
    assert.ok((await app.api('GET', `/api/repos/${ids.api}/sheet`)).body.rules.some((x) => x.id === ids.regle));
    assert.ok(!(await app.api('GET', `/api/repos/${ids.legacy}/sheet`)).body.rules.some((x) => x.id === ids.regle));
    assert.equal((await app.api('GET', '/api/repo-groups')).body[0].rules, 1);
  });

  test('un vérificateur couvre PAR le groupe, et vérifie un membre sans ligne directe', async () => {
    const v = await app.api('POST', '/api/verifiers', { name: 'integ', kind: 'commands', commands: ['true'], groups: [ids.backend] });
    assert.equal(v.status, 200, v.text); ids.verif = v.body.id;
    assert.deepEqual(v.body.groups.map((g) => g.name), ['backend']);
    assert.deepEqual(v.body.covered.map((c) => `${c.repo_id}:${c.via}`).sort(), [`${ids.api}:group`, `${ids.web}:group`].sort());
    const pour = (await app.api('GET', `/api/verifiers/for?repos=${ids.api},${ids.web}`)).body.verifiers;
    assert.ok(pour.some((x) => x.id === ids.verif), 'couvre les deux membres');
    assert.ok(!(await app.api('GET', `/api/verifiers/for?repos=${ids.legacy}`)).body.verifiers.some((x) => x.id === ids.verif));
    assert.equal((await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId).verifiable, true, 'la carte sait qu’un vérificateur couvre ce dépôt');
    const lancement = await app.api('POST', `/api/mrs/${mrId}/verify`);
    assert.equal(lancement.status, 200, lancement.text);
    await waitForJobs(app.api);
    const verif = (await app.api('GET', `/api/mrs/${mrId}/verifications`)).body;
    const derniere = (verif.verifications || verif)[0] || verif.last || null;
    const ligne = app.db.prepare('SELECT verdict, status FROM verification ORDER BY id DESC LIMIT 1').get();
    assert.equal(ligne.status, 'done', JSON.stringify(ligne));
    assert.equal(ligne.verdict, 'verified_pass', `un membre couvert par le groupe se vérifie (${JSON.stringify(derniere)})`);
    /* L'empreinte d'approbation porte le groupe : élargir la couverture par la synchro est une
       chose à approuver, comme un dépôt de plus. */
    const emp = JSON.parse(require('../src/data/approbation').empreinteVerificateur(ids.verif));
    assert.equal(emp.groups.length, 1);
  });

  test('supprimer le groupe désactive la règle qui ne visait que lui et retire la couverture', async () => {
    const r = await app.api('DELETE', `/api/repo-groups/${ids.backend}`);
    assert.equal(r.status, 200, r.text);
    const regle = (await app.api('GET', '/api/rules')).body.find((x) => x.id === ids.regle);
    assert.equal(regle.enabled, 0); assert.equal(regle.group_id, null);
    assert.ok(!(await app.api('GET', `/api/verifiers/for?repos=${ids.api}`)).body.verifiers.some((x) => x.id === ids.verif));
    assert.deepEqual((await app.api('GET', '/api/repos')).body.find((x) => x.id === ids.api).groups, []);
    assert.equal((await app.api('DELETE', `/api/repo-groups/${ids.backend}`)).status, 400, 'déjà parti');
  });
});
