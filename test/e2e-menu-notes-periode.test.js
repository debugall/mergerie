'use strict';
/* MENU NOTES → PÉRIODE, dans un VRAI navigateur.
 *
 * Le sous-onglet, vide puis plein : deux dates, « Construire », le job, et l'écran qui se
 * redessine à sa fin — jamais un délai, toujours l'effet. Les pushs directs en tête, « vu » qui
 * fait sortir la ligne, le filtre des bots, le diff d'un push dans sa modale, la session
 * d'exploration pré-remplie. Puis la bannière du brief : absente tant qu'aucun geste n'a été
 * vu, présente au-delà du seuil, et son bouton qui ouvre la période de l'absence.
 *
 * Un seul `startApp()` ; rien de `src/` en tête de fichier. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, git, poserIdentiteGit, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ISO = (d = Date.now()) => new Date(d).toISOString();
const JOUR = 86400e3;

describe('Menu Notes · Période', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let bare;
  const erreurs = [];
  const sha = {};

  const commit = (dir, auteur, msg, date = null) => {
    const email = `${auteur.replace(/[^a-z]/gi, '')}@x.test`;
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', msg], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: auteur, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: auteur, GIT_COMMITTER_EMAIL: email, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    });
    return git(dir, ['rev-parse', 'HEAD']).trim();
  };
  const ecrire = (dir, f, contenu) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), contenu); git(dir, ['add', '-A']); };

  before(async () => {
    app = await startApp();
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'remote-'));
    bare = path.join(dir, 'origin.git'); const work = path.join(dir, 'work');
    fs.mkdirSync(bare, { recursive: true }); fs.mkdirSync(work, { recursive: true });
    git(bare, ['init', '--bare', '--initial-branch=main', '.']);
    git(work, ['init', '--initial-branch=main', '.']);
    poserIdentiteGit(work);
    git(work, ['remote', 'add', 'origin', bare]);
    ecrire(work, 'README.md', '# app\n');
    sha.c0 = commit(work, 'sofia', 'init', ISO(Date.now() - 30 * JOUR));
    git(work, ['checkout', '-q', '-b', 'feat/a']);
    ecrire(work, 'src/a.js', 'module.exports = 1;\n');
    sha.a1 = commit(work, 'sofia', 'feat: a');
    git(work, ['checkout', '-q', 'main']);
    git(work, ['merge', '-q', '--no-ff', '-m', 'Merge branch feat/a', 'feat/a']);
    sha.M1 = git(work, ['rev-parse', 'HEAD']).trim();
    ecrire(work, 'src/hotfix.js', 'module.exports = 4;\n');
    sha.d1 = commit(work, 'karim', 'hotfix: timeout on /health');
    sha.bot = commit(work, 'dependabot[bot]', 'chore(deps): bump lodash');
    git(work, ['push', '-q', 'origin', 'main', `${sha.a1}:refs/merge-requests/1/head`]);

    const il = (j) => ISO(Date.now() - j * JOUR);
    app.state.mrs['grp/app'] = [{
      iid: 1, title: 'Ajout de a', state: 'merged', source_branch: 'feat/a', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/1', author: { name: 'sofia' },
      sha: sha.a1, created_at: il(6), updated_at: ISO(), merged_at: il(3), merge_commit_sha: sha.M1,
      diff_refs: { base_sha: sha.c0, start_sha: sha.c0, head_sha: sha.a1 },
    }];
    // Le pied de l'écran : un pipeline rouge sur main, une vérification et un agent planifié dans la fenêtre.
    app.state.refPipelines['grp/app'] = { main: [{ id: 77, status: 'failed', web_url: 'https://gitlab.test/grp/app/-/pipelines/77', sha: sha.bot }] };
    app.db.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, created_at, started_at, finished_at)
      VALUES ('tests unitaires', 'done', 'verified_fail', '[]', ?, ?, ?)`).run(il(2), il(2), il(1.9));
    const agentId = app.db.prepare("INSERT INTO agent (name, description, kind, created_at, updated_at) VALUES ('veille', '', 'explore', ?, ?)").run(il(3), il(3)).lastInsertRowid;
    await app.configure({ review_explain: '0' });
    const repoId = (await app.api('POST', '/api/repos', { url: bare, project: 'grp/app', branch_pattern: '' })).body.id;
    app.db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, agent_id, agent_name, created_at, updated_at) VALUES (?, 'explore', 'p', '', 'done', ?, 'veille', ?, ?)").run(repoId, agentId, il(2), il(2));

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const allerPeriode = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="periode"]').click();
    await page.waitForSelector('#notesSubPeriode:not([hidden]) #periodeBarre');
  };

  test('vide au départ, puis construite depuis deux dates : les pushs directs en tête, la MR mergée dessous', async () => {
    await allerPeriode();
    await page.waitForSelector('#periodeCorps .empty-state, #periodeCorps .empty');
    await page.fill('#periodeFrom', ISO(Date.now() - 10 * JOUR).slice(0, 10));
    await page.fill('#periodeTo', ISO().slice(0, 10));
    await page.locator('#periodeBuild').click();
    // L'effet : la section des pushs apparaît quand le job est fini — pas un délai.
    await page.waitForSelector('#periodeCorps .notes-periode-push', { timeout: 60000 });
    await waitForJobs(app.api);
    const pushs = page.locator('#periodeCorps .notes-periode-push .notes-periode-item');
    assert.equal(await pushs.count(), 1, 'le bot est masqué d’office : un seul push visible');
    assert.match(await pushs.first().innerText(), /karim/);
    assert.match(await pushs.first().innerText(), /hotfix: timeout/);
    const mergees = page.locator('#periodeCorps .notes-periode-merged .notes-periode-item');
    assert.equal(await mergees.count(), 1);
    assert.match(await mergees.first().innerText(), /!1 — Ajout de a/);
    assert.match(await mergees.first().innerText(), /jamais reviewée|never reviewed/);
    // Le compteur du sous-onglet = les lignes non vues.
    const badge = await page.locator('#notesPeriodeCount').innerText();
    assert.ok(Number(badge) >= 2, `badge : ${badge}`);
  });

  test('afficher les bots les fait revenir ; « vu » fait sortir une ligne et survit au rechargement', async () => {
    await page.locator('#periodeFiltreBots').uncheck();
    await page.waitForFunction(() => document.querySelectorAll('#periodeCorps .notes-periode-push .notes-periode-item').length === 2);
    await page.locator('#periodeFiltreBots').check();
    await page.waitForFunction(() => document.querySelectorAll('#periodeCorps .notes-periode-push .notes-periode-item').length === 1);
    const ligne = page.locator('#periodeCorps .notes-periode-push .notes-periode-item').first();
    const itemId = await ligne.getAttribute('data-pitem');
    await ligne.locator('[data-pseen]').click();
    // La ligne part (le filtre « déjà vus » est décoché) : la section disparaît avec elle.
    await page.waitForFunction(() => !document.querySelector('#periodeCorps .notes-periode-push'));
    await attendreServeur(async () => {
      const p = (await app.api('GET', '/api/periode')).body.periodes[0];
      return (await app.api('GET', `/api/periode/${p.id}`)).body.items.find((it) => it.id === Number(itemId)).seen_at;
    }, 'le serveur tient le « vu »');
    await page.reload();
    await allerPeriode();
    await page.waitForSelector('#periodeCorps .notes-periode-merged');
    assert.equal(await page.locator('#periodeCorps .notes-periode-push').count(), 0, 'toujours vu après rechargement');
    await page.locator('#periodeFiltreSeen').check();
    await page.waitForSelector('#periodeCorps .notes-periode-push .notes-periode-item.seen');
  });

  test('le diff d’un push s’ouvre dans sa modale ; « Relire ce push » ouvre une exploration pré-remplie', async () => {
    const ligne = page.locator('#periodeCorps .notes-periode-push .notes-periode-item').first();
    await ligne.locator('[data-pdiff]').click();
    await page.waitForSelector('#periodeDiffModal:not([hidden])');
    assert.match(await page.locator('#periodeDiffBody').innerText(), /src\/hotfix\.js/);
    await page.locator('#periodeDiffClose').click();
    await page.waitForSelector('#periodeDiffModal[hidden]', { state: 'attached' });
    await ligne.locator('[data-pexplore]').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    const prompt = await page.locator('#taskForm [name="prompt"]').inputValue();
    assert.match(prompt, /hotfix: timeout on \/health/);
    assert.match(prompt, /karim/);
    assert.match(await page.locator('#taskModalTitle').innerText(), /karim/);
    await page.evaluate(() => { document.querySelector('#taskModal').hidden = true; });
  });

  test('la MR mergée se relit a posteriori depuis la ligne, et le rapport s’ouvre ensuite', async () => {
    const ligne = page.locator('#periodeCorps .notes-periode-merged .notes-periode-item').first();
    await ligne.locator('[data-pmrreview]').click();
    await waitForJobs(app.api);
    const m = (await app.api('GET', '/api/mrs')).body.find((x) => x.iid === 1);
    assert.equal(m.status, 'reviewed');
    assert.equal(m.reviewed_sha, sha.a1);
    await page.locator('#periodeRebuild').click();
    await page.waitForSelector('#periodeCorps .notes-periode-building');
    await page.waitForSelector('#periodeCorps .notes-periode-merged .notes-periode-item [data-pmrreport]', { timeout: 60000 });
    assert.match(await page.locator('#periodeCorps .notes-periode-merged .notes-periode-item').first().innerText(), /reviewée avant le merge|reviewed before the merge/);
  });

  test('le pied : pipeline rouge, « Mergerie a fait » (agent, vérification) — et le rapport de la vérification s’ouvre', async () => {
    await page.reload();
    await allerPeriode();
    await page.waitForSelector('#periodeCorps .notes-periode-merged');
    const pipeline = page.locator('#periodeCorps .notes-periode-tags .notes-periode-pipeline');
    assert.equal(await pipeline.count(), 1);
    assert.match(await pipeline.innerText(), /pipeline rouge sur main|red pipeline on main/);
    assert.ok(await page.locator('#periodeCorps .notes-periode-tags').getAttribute('open') !== null, 'un pipeline rouge ouvre la section');
    const mergerie = page.locator('#periodeCorps .notes-periode-mergerie');
    assert.equal(await mergerie.count(), 1);
    await mergerie.locator('summary').click();
    const lignes = mergerie.locator('.notes-periode-item');
    await lignes.first().waitFor({ state: 'visible' });
    const textes = await lignes.allInnerTexts();
    assert.ok(textes.some((t) => /veille/.test(t)), `l’agent : ${textes.join(' | ')}`);
    assert.ok(textes.some((t) => /tests unitaires/.test(t)), 'la vérification');
    await mergerie.locator('[data-pverif]').click();
    await page.waitForSelector('#verifyModal:not([hidden])');
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  });

  test('« Résumer la période » lance un job et le texte s’affiche à sa fin, daté et balisé IA', async () => {
    await page.locator('#periodeResume').click();
    // L'effet : le résumé apparaît quand le job est fini — pas un délai.
    await page.waitForSelector('#periodeCorps .notes-periode-resume .notes-periode-resume-texte', { timeout: 60000 });
    await waitForJobs(app.api);
    const texte = await page.locator('#periodeCorps .notes-periode-resume').innerText();
    assert.match(texte, /dry-run|mock/i, 'le texte de l’agent (dry-run)');
    assert.match(texte, /non fiable|not to be trusted/);
    const p = (await app.api('GET', '/api/periode')).body.periodes[0];
    assert.ok((await app.api('GET', `/api/periode/${p.id}`)).body.resume_at, 'daté côté serveur');
  });

  test('« Je pars » pose l’absence à la minute et la barre le dit ; Annuler l’efface', async () => {
    await page.locator('#periodeDepart').click();
    await page.waitForSelector('#periodeDepartCancel');
    assert.match(await page.locator('#periodeBarre .notes-periode-depart').innerText(), /Parti le|Left on/);
    const a = (await app.api('GET', '/api/periode/absence')).body;
    assert.equal(a.explicit, true);
    await page.locator('#periodeDepartCancel').click();
    await page.waitForSelector('#periodeDepart');
    await attendreServeur(async () => (await app.api('GET', '/api/periode/absence')).body.explicit === false, 'l’absence explicite est oubliée');
  });

  test('la bannière du brief : jamais sans dernier geste connu, présente au-delà du seuil, et son bouton ouvre la période', async () => {
    const allerBrief = async () => {
      await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
      await page.waitForSelector('#notesSubToday:not([hidden]) #briefBox .brief-head');
    };
    // Les clics des tests précédents ont déjà écrit la présence : c'est le premier effet attendu.
    assert.ok((await app.api('GET', '/api/periode/absence')).body.last_seen, 'les gestes précédents ont écrit la présence');
    app.db.prepare("DELETE FROM local_state WHERE kind = 'absence'").run();
    // Page rechargée : le client ne retient plus son dernier envoi (au plus un par minute).
    await page.reload();
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await allerBrief();
    assert.equal(await page.locator('#briefBox .notes-periode-banner').count(), 0, 'pas de dernier geste connu : pas de bannière');
    // Un geste dans la page : la présence part (transverse/presence.js), et ce n'est pas une absence.
    await page.keyboard.press('Shift');
    await attendreServeur(async () => (await app.api('GET', '/api/periode/absence')).body.last_seen, 'la présence est écrite sur un geste');
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await allerBrief();
    assert.equal(await page.locator('#briefBox .notes-periode-banner').count(), 0, 'vu à l’instant : pas une absence');
    app.db.prepare("UPDATE local_state SET value = ? WHERE kind = 'absence' AND ref = 'poste' AND key = 'last_seen'").run(ISO(Date.now() - 12 * JOUR));
    await page.locator('#tab-notes .subnav button[data-nsub="todos"]').click();
    await allerBrief();
    const banniere = page.locator('#briefBox .notes-periode-banner');
    assert.equal(await banniere.count(), 1);
    assert.match(await banniere.innerText(), /12/);
    await banniere.locator('#briefAbsenceGo').click();
    await page.waitForSelector('#notesSubPeriode:not([hidden]) #periodeBarre');
    /* L'EFFET QUE SEUL LE NOUVEL ÉCRAN SATISFAIT : la date de départ de l'absence dans le champ. La
       période précédente peut s'afficher un instant avant (sa lecture était déjà partie) — attendre
       une section ne prouverait rien. */
    const attendu = ISO(Date.now() - 12 * JOUR).slice(0, 10);
    await page.waitForFunction((v) => (document.querySelector('#periodeFrom') || {}).value === v, attendu, { timeout: 60000 });
    await page.waitForSelector('#periodeCorps .notes-periode-merged, #periodeCorps .notes-periode-building', { timeout: 60000 });
    await waitForJobs(app.api);
    assert.equal((await app.api('GET', '/api/periode')).body.periodes[0].depuis.slice(0, 10), attendu, 'la période construite part du départ de l’absence');
  });

  test('aucune erreur de page', () => {
    assert.deepEqual(erreurs, []);
  });
});
