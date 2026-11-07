'use strict';
/* REPRENDRE LA SESSION D'UN COLLÈGUE SUR CE POSTE — DEUX POSTES, POUR DE VRAI.
 *
 * Claire (une seconde instance de Mergerie, processus enfant — `helpers/synchro-collegue`) code en
 * dry-run sur `feature/tva` d'un dépôt que les deux postes suivent, pousse, relance un suivi, partage sa
 * session et synchronise. Ce poste rejoint le dépôt de données, reçoit sa session, et la reprend :
 * l'aperçu montre le premier message (tout l'historique, puis la consigne), le lancement crée une
 * session NEUVE à moi — mes réglages (`auto_push` à ma valeur, pas la sienne), nouvelle branche posée
 * sur la tête de `feature/tva` telle que la forge la donne, première passe dont le prompt EST le premier
 * message, aucun handle repris —, la session de Claire est identique avant et après, et la filiation
 * part dans `session.json` : chez Claire, sa carte dit « reprise par Test ». Deux reprises → deux lignes.
 * Puis à l'écran : le bouton, la modale verrouillée avec son encart, le lancement, les deux cartes. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, makeRemoteRepo, pushChange, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const { lancerCollegue } = require('./helpers/synchro-collegue');
const { synchroniserJusqua } = require('./helpers/partage');

const { dispo } = navigateurDispo();
const GL = 'grp/app';

describe('Reprendre la session d’un collègue sur ce poste', () => {
  let app; let claire; let gl; let nu; let racine;
  let tClaire; let tgClaire; let repriseId; let repriseId2;
  const shaDe = (ref) => execFileSync('git', ['-C', gl.bare, 'rev-parse', ref], { encoding: 'utf8' }).trim();
  const brancheMock = (sha) => { app.state.branches[GL] = [{ name: 'main', default: true, commit: { id: gl.mainSha, committed_date: '2026-11-01T10:00:00Z', author_name: 'Test' } }, { name: 'feature/tva', default: false, commit: { id: sha, committed_date: '2026-11-05T10:00:00Z', author_name: 'Claire' } }]; };
  const mesTaches = async () => (await app.api('GET', '/api/tasks')).body;
  const deClaire = async () => (await mesTaches()).find((t) => t.author === 'Claire');
  const attendreClaire = async (id, cond) => {
    for (let i = 0; i < 600; i += 1) {
      const t = (await claire.api('GET', `/api/tasks/${id}`)).body.task;
      if (cond(t)) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('la session de Claire n’a pas fini');
  };

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'reprise-'));
    nu = path.join(racine, 'donnees.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
    gl = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-gl-')), { branch: 'feature/tva' });

    // Claire : la même forge factice, le même dépôt, sa session de codage en dry-run, poussée, puis un suivi.
    claire = await lancerCollegue({ nom: 'Claire', racine });
    await claire.rattacher(nu);
    const c = await claire.api('PUT', '/api/config', { gitlab_url: app.gitlabUrl, access_token: app.state.token, clone_path: path.join(claire.dataDir, 'clones') });
    assert.equal(c.status, 200, c.text);
    const rc = await claire.api('POST', '/api/repos', { url: gl.url, project: GL });
    assert.equal(rc.status, 200, rc.text);
    const tc = await claire.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Applique le taux réduit de TVA aux abonnements annuels.', auto_push: 1, shared: 1, label: 'TVA réduite',
      targets: [{ repo_id: rc.body.id, branch: 'feature/tva', base_branch: 'main' }],
    });
    assert.equal(tc.status, 200, tc.text);
    tClaire = tc.body;
    assert.equal((await claire.api('POST', `/api/tasks/${tClaire.id}/run`)).status, 200);
    await attendreClaire(tClaire.id, (t) => t.targets[0].status === 'pushed');
    assert.equal((await claire.api('POST', `/api/tasks/${tClaire.id}/followup`, { instruction: 'Le taux doit venir de la configuration, pas d’une constante.' })).status, 200);
    await attendreClaire(tClaire.id, (t) => t.status !== 'running' && t.passes_count !== 1);
    await claire.synchroniser();

    // Ce poste : la forge factice connaît la branche telle que Claire l'a poussée ; on rejoint le dépôt d'équipe.
    await app.configure();
    await app.api('POST', '/api/repos', { url: gl.url, project: GL });
    brancheMock(shaDe('feature/tva'));
    assert.equal((await app.api('PUT', '/api/config', { data_repo_url: nu, data_repo_branch: 'main', data_sync_seconds: '600' })).status, 200);
    assert.equal((await app.api('POST', '/api/data-sync/attach', { url: nu })).status, 200);
    await synchroniserJusqua(app, async () => !!(await deClaire()), 'la session de Claire arrive ici');
  });

  after(async () => { if (claire) await claire.stop(); if (app) await app.stop(); });

  test('la session reçue porte le bouton (branche poussée, pas la mienne) ; en attente d’une réponse, il devient « Répondre et reprendre »', async () => {
    const t = await deClaire();
    assert.equal(t.kind, 'code'); assert.equal(t.auto_push, 0, '`auto_push` ne voyage pas');
    tgClaire = t.targets[0];
    assert.deepEqual(tgClaire.reprise, { ok: true, needs_input: false });
    assert.deepEqual(t.resumed_by, []); assert.equal(t.resumed_from, null);
    assert.ok(t.passes_count >= 2, `deux passes reçues (${t.passes_count})`);
    // La cible attend une réponse (comme si l'agent de Claire s'était arrêté sur une question).
    app.db.prepare("UPDATE task_target SET status = 'needs_input', questions_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: 'q1', question: 'Le taux réduit vaut-il aussi pour le mensuel ?', context: null, options: null, answer: null }]), tgClaire.id);
    assert.deepEqual((await deClaire()).targets[0].reprise, { ok: true, needs_input: true });
    // Pas de bouton : ma propre session, une exploration, une branche non poussée.
    const mienne = (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'x', targets: [{ repo_id: tgClaire.repo_id, branch: 'feature/moi' }] })).body;
    const r = await app.api('POST', `/api/tasks/${mienne.id}/reprise/${mienne.targets[0].id}/apercu`, {});
    assert.equal(r.status, 409); assert.match(r.body.error || r.text, /à toi|yours/);
    assert.equal((await mesTaches()).find((x) => x.id === mienne.id).targets[0].reprise.reason, 'mine');
    await app.api('DELETE', `/api/tasks/${mienne.id}`);
  });

  test('l’aperçu : tout l’historique dans l’ordre, la tête de la forge, l’écart quand Claire a poussé depuis — zéro token', async () => {
    const t = await deClaire();
    const a = (await app.api('POST', `/api/tasks/${t.id}/reprise/${tgClaire.id}/apercu`, { consigne: 'Termine.' })).body;
    assert.equal(a.task.author, 'Claire');
    assert.equal(a.forge.sha, shaDe('feature/tva')); assert.equal(a.forge.absent, false);
    assert.ok(a.passes >= 2 && a.questions === 1);
    const sections = [...a.texte.matchAll(/^=== (.+?) ===$/gm)].map((m) => m[1]);
    assert.equal(sections[0], "Prompt d'origine");
    assert.ok(sections.some((s) => /^Passe 1 · exécution$/.test(s)) && sections.some((s) => /^Passe 2 · suivi$/.test(s)));
    assert.ok(sections.includes('Questions posées et réponses') && sections[sections.length - 1] === 'Consigne de reprise');
    assert.match(a.texte, /^Reprise de la session de Claire \(#\d+\) — grp\/app, branche feature\/tva\./m);
    assert.ok(a.texte.includes('Le taux doit venir de la configuration'), 'le prompt réellement envoyé au suivi');
    assert.ok(a.texte.includes('Termine.'));
    assert.match(a.branch_proposee, /^feature\/tva-reprise-test$/);
    // Claire pousse encore : la forge est un commit plus loin que la dernière passe connue.
    execFileSync('git', ['-C', gl.work, 'fetch', 'origin'], { stdio: 'ignore' });
    execFileSync('git', ['-C', gl.work, 'checkout', 'feature/tva'], { stdio: 'ignore' });
    execFileSync('git', ['-C', gl.work, 'reset', '--hard', 'origin/feature/tva'], { stdio: 'ignore' });
    pushChange(gl, 'src/tva.js', 'export const reduit = 5.5;\n', 'feat: taux configurable');
    brancheMock(shaDe('feature/tva'));
    const b = (await app.api('POST', `/api/tasks/${t.id}/reprise/${tgClaire.id}/apercu`, { consigne: 'Termine.', passes_incluses: 1, diff: true })).body;
    assert.equal(b.forge.ecart, 1);
    assert.match(b.texte, /^La forge est 1 commit plus loin que la dernière passe connue\.$/m);
    assert.match(b.texte, /antérieure non incluse\./m);
    assert.ok(b.texte.includes('=== Diff de la branche reprise ===') && b.texte.includes('reduit = 5.5'));
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM agent_pass WHERE task_id <> ?').get(t.id).c, 0, 'aucune passe créée : zéro token avant le lancement');
  });

  test('le lancement : une session neuve, mes réglages, la nouvelle branche sur la tête de la forge, le premier message en première passe, Claire intouchée', async () => {
    const t = await deClaire();
    const avant = JSON.stringify({ t: app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id), tg: app.db.prepare('SELECT * FROM task_target WHERE id = ?').get(tgClaire.id) });
    const r = await app.api('POST', `/api/tasks/${t.id}/reprise/${tgClaire.id}`, { consigne: 'Termine : migre les factures émises.', reponse: 'Non : annuel seulement.', passes_incluses: 2, diff: true });
    assert.equal(r.status, 200, r.text);
    repriseId = r.body.id;
    assert.equal(r.body.resumed_from_uid, t.uid); assert.equal(r.body.resumed_target_uid, tgClaire.uid);
    assert.equal(r.body.auto_push, 0, 'ma valeur par défaut, pas celle de Claire (1)');
    assert.equal(r.body.prompt, 'Termine : migre les factures émises.');
    assert.deepEqual([r.body.targets[0].branch, r.body.targets[0].base_branch], ['feature/tva-reprise-test', 'feature/tva']);
    await waitForJobs(app.api);
    const mine = (await app.api('GET', `/api/tasks/${repriseId}`)).body.task;
    assert.equal(mine.targets[0].status, 'committed', mine.targets[0].last_error || '');
    const passes = (await app.api('GET', `/api/tasks/${repriseId}/targets/${mine.targets[0].id}/passes`)).body;
    const premiere = (passes.passes || passes)[0];
    const prompt = premiere.prompt || '';
    for (const s of ["=== Prompt d'origine ===", '=== Passe 1 · exécution ===', '=== Passe 2 · suivi ===', '=== Diff de la branche reprise ===', '=== Réponse à la question en attente ===\nNon : annuel seulement.', '=== Consigne de reprise ===\nTermine : migre les factures émises.']) {
      assert.ok(prompt.includes(s), `la première passe conserve « ${s.split('\n')[0]} »`);
    }
    assert.ok(prompt.indexOf('Réponse à la question en attente') < prompt.indexOf('Consigne de reprise'));
    const journal = app.db.prepare('SELECT text FROM job_log WHERE text LIKE ? ORDER BY ts').all('%Reprise #%').map((l) => l.text).join('\n');
    assert.match(journal, new RegExp(`Reprise #${repriseId} de la session #${t.id} de Claire · feature/tva@[0-9a-f]{7} · 2 passe\\(s\\)`));
    assert.equal(JSON.stringify({ t: app.db.prepare('SELECT * FROM task WHERE id = ?').get(t.id), tg: app.db.prepare('SELECT * FROM task_target WHERE id = ?').get(tgClaire.id) }), avant, 'la session de Claire est identique avant et après');
    assert.equal(app.db.prepare('SELECT session_key FROM task_target WHERE id = ?').get(mine.targets[0].id).session_key, null, 'dry-run : aucun handle — et jamais celui de Claire');
    // La filiation, des deux côtés, sur la liste.
    const liste = await mesTaches();
    const c = liste.find((x) => x.id === t.id); const m = liste.find((x) => x.id === repriseId);
    assert.deepEqual(c.targets[0].resumed_by.map((x) => x.id), [repriseId]);
    assert.deepEqual([m.resumed_from.id, m.resumed_from.author, m.resumed_from.target_uid], [t.id, 'Claire', tgClaire.uid]);
    assert.equal(c.targets[0].status, 'needs_input', 'la question reste ouverte sur la carte de Claire');
  });

  test('exportée, la filiation voyage : chez Claire, sa carte dit « reprise par Test » ; une seconde reprise fait deux lignes', async () => {
    assert.equal((await app.api('POST', `/api/tasks/${repriseId}/share`, { shared: 1 })).status, 200);
    const uid = app.db.prepare('SELECT uid FROM task WHERE id = ?').get(repriseId).uid;
    await synchroniserJusqua(app, async () => {
      try { return execFileSync('git', ['-C', nu, 'show', `main:sessions/${uid}/session.json`], { encoding: 'utf8' }).includes('"resumed_from"'); } catch { return false; }
    }, 'ma session part avec sa filiation');
    const doc = JSON.parse(execFileSync('git', ['-C', nu, 'show', `main:sessions/${uid}/session.json`], { encoding: 'utf8' }));
    assert.equal(doc.resumed_from, tClaire.uid); assert.equal(doc.resumed_target, tgClaire.uid);
    assert.ok(!JSON.stringify(doc).includes('session_key') && doc.auto_push === undefined, 'rien de sensible de plus');
    await claire.synchroniser();
    const chezElle = (await claire.api('GET', '/api/tasks')).body.find((x) => x.id === tClaire.id);
    assert.deepEqual(chezElle.targets[0].resumed_by.map((x) => x.author), ['Test']);
    const t = await deClaire();
    const r2 = await app.api('POST', `/api/tasks/${t.id}/reprise/${tgClaire.id}`, { consigne: 'Autre angle : garde la constante.', passes_incluses: 0 });
    assert.equal(r2.status, 200, r2.text);
    repriseId2 = r2.body.id;
    await waitForJobs(app.api);
    const c = (await mesTaches()).find((x) => x.id === t.id);
    assert.deepEqual(c.targets[0].resumed_by.map((x) => x.id), [repriseId2, repriseId], 'deux reprises, les plus récentes d’abord, aucune « officielle »');
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
      await page.locator(`#taskList .task-row[data-task="${tClaire.id}"]`).waitFor({ state: 'visible' });
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('la carte de Claire porte « Répondre et reprendre », ses reprises ; la modale est verrouillée, l’encart montre le premier message ; ma carte dit d’où elle vient', async () => {
      const carte = page.locator(`#taskList .task-row[data-task="${tClaire.id}"]`);
      const btn = carte.locator('[data-reprise]');
      assert.match(await btn.innerText(), /Répondre et reprendre sur ce poste|Answer and take over on this machine/);
      assert.match(await carte.locator('.reprise-par').innerText(), /(reprise par|taken over by) Test \(#\d+\)/);
      assert.match(await carte.locator('.reprise-par').innerText(), /question répondue dans la reprise|question answered in takeover/);
      await btn.click();
      await page.locator('#taskModal:not([hidden])').waitFor();
      await page.locator('#taskReprise:not([hidden])').waitFor();
      assert.match(await page.locator('#taskReprise .reprise-bandeau').innerText(), /Claire .*grp\/app .*feature\/tva/);
      assert.ok(await page.locator('#taskReposWrap input.t-base').isDisabled(), 'la branche de départ est verrouillée');
      assert.ok(await page.locator('#taskReposWrap input.t-repo-search').isDisabled(), 'le dépôt aussi');
      assert.equal(await page.inputValue('#taskReposWrap input.t-base'), 'feature/tva');
      assert.equal(await page.inputValue('#taskReposWrap input.t-branch'), 'feature/tva-reprise-test');
      await page.locator('#taskReprise details summary').click();
      assert.match(await page.locator('#taskRepriseApercu').textContent(), /=== Prompt d'origine ===/);
      assert.match(await page.locator('#taskRepriseTokens').textContent(), /~\d+ ?k tokens/);
      assert.equal(await page.locator('#taskRepriseReponse').count(), 1, 'le champ de réponse, puisque la cible attend');
      assert.ok(await page.locator('#taskSubmitOnly').isHidden());
      assert.match(await page.locator('#taskSubmit').innerText(), /Lancer la reprise|Launch the takeover/);
      await page.fill('#taskRepriseReponse', 'Oui pour l’annuel.');
      await page.fill('#taskPrompt', 'Depuis l’écran : termine la migration.');
      await page.waitForFunction(() => /Depuis l’écran/.test(document.querySelector('#taskRepriseApercu').textContent));
      await page.locator('#taskSubmit').click();
      await page.locator('#taskModal').waitFor({ state: 'hidden' });
      await waitForJobs(app.api);
      const mienne = (await mesTaches()).find((x) => x.prompt === 'Depuis l’écran : termine la migration.');
      assert.ok(mienne && mienne.resumed_from && mienne.resumed_from.id === tClaire.id);
      const maCarte = page.locator(`#taskList .task-row[data-task="${mienne.id}"]`);
      await maCarte.waitFor({ state: 'visible' });
      assert.match(await maCarte.locator('.reprise-origine').innerText(), /(reprise de la session de|takeover of) Claire/);
      assert.equal(await maCarte.locator('.tag.reprise').count(), 1);
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });
  });
});
