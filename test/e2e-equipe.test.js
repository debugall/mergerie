'use strict';
/* LA PAGE D'ÉQUIPE « NOTRE MATIN », DE BOUT EN BOUT.
 *
 * Sans dépôt de données attaché, l'onglet Équipe dit une phrase et ne calcule rien. Un dépôt nu attaché
 * (le vrai rattachement), deux auteurs connus de l'état local — Claire il y a dix minutes, Ali
 * silencieux —, une décision en attente, une question d'une session partagée, une session non partagée
 * qui n'apparaît nulle part : l'API rend les sept sections, l'écran les trois chiffres, les lignes, le
 * « silencieux », le filtre par personne, la phrase de la page vide ; une ligne mène à la carte ; rien
 * n'est écrit par la page (aucune ligne de plus en base après l'avoir lue). Aucun appel forge. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Page d’équipe « Notre matin »', () => {
  let app; let nu; let repoId; let etat; let store;
  const ids = {};
  const il_y_a = (j) => new Date(Date.now() - j * 86400000).toISOString();
  const page = async (q = '') => (await app.api('GET', `/api/equipe${q}`)).body;
  const auteur = (table, row, nom) => etat.ecrire('author', store.cheminSur(table, row), 'name', nom);

  before(async () => {
    app = await startApp();
    await app.configure();
    etat = require('../src/data/localstate').etat;
    store = require('../src/data/store');
    repoId = Number(app.db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/tarification', 'https://gitlab.test/grp/tarification.git', 1, 'gitlab')").run().lastInsertRowid);
  });
  after(async () => { if (app) await app.stop(); });

  test('sans dépôt de données attaché : la page dit qu’elle lit le dépôt partagé, et c’est tout', async () => {
    const d = await page();
    assert.deepEqual(Object.keys(d).sort(), ['attached', 'groups', 'sync']);
    assert.equal(d.attached, false);
  });

  test('attaché : les sept sections sur ce que l’équipe partage ; une session non partagée n’existe nulle part ; la lecture n’écrit rien', async () => {
    nu = path.join(fs.mkdtempSync(path.join(app.dataDir, 'equipe-')), 'donnees.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
    assert.equal((await app.api('PUT', '/api/config', { data_repo_url: nu, data_repo_branch: 'main', data_sync_seconds: '600' })).status, 200);
    assert.equal((await app.api('POST', '/api/data-sync/attach', { url: nu })).status, 200);
    // Deux postes connus du dépôt : Claire tout à l'heure, Ali il y a dix jours.
    etat.ecrire('author_last', 'Claire', 'at', new Date(Date.now() - 10 * 60000).toISOString());
    etat.ecrire('author_last', 'Ali', 'at', il_y_a(10));
    // Une décision : !214 de Claire, notée 8,6 par Ali il y a 5 jours, ouverte, non classée.
    ids.m214 = Number(app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, author, closed_seen, updated_at)
      VALUES (?, 214, 'Taux réduit', 'feature/tva', 'main', 'aaa', 'reviewed', 'Claire', 0, ?)`).run(repoId, il_y_a(5)).lastInsertRowid);
    const rv = Number(app.db.prepare('INSERT INTO review (mr_id, note_value, created_at, updated_at) VALUES (?, 0.86, ?, ?)').run(ids.m214, il_y_a(5), il_y_a(5)).lastInsertRowid);
    auteur('review', app.db.prepare('SELECT * FROM review WHERE id = ?').get(rv), 'Ali');
    // Une question de Claire, partagée ; une question d'une session PRIVÉE, qui ne doit paraître nulle part.
    const sc = Number(app.db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, shared, created_at, updated_at) VALUES (?, 'code', 'Arrondir la TVA', 'feature/tva', 'needs_input', 1, ?, ?)").run(repoId, il_y_a(2), il_y_a(2)).lastInsertRowid);
    auteur('task', app.db.prepare('SELECT * FROM task WHERE id = ?').get(sc), 'Claire');
    ids.sc = sc;
    app.db.prepare("INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, questions_json, updated_at) VALUES (?, ?, 'feature/tva', 'main', 'needs_input', ?, ?)")
      .run(sc, repoId, JSON.stringify([{ id: 'q1', question: 'Faut-il arrondir la TVA au centime ?', answer: null }]), il_y_a(2));
    const sp = Number(app.db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, shared, created_at, updated_at) VALUES (?, 'code', 'PRIVÉ', 'feature/privee', 'needs_input', 0, ?, ?)").run(repoId, il_y_a(1), il_y_a(1)).lastInsertRowid);
    app.db.prepare("INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, questions_json, updated_at) VALUES (?, ?, 'feature/privee', 'main', 'needs_input', ?, ?)")
      .run(sp, repoId, JSON.stringify([{ id: 'q1', question: 'QUESTION PRIVÉE ?', answer: null }]), il_y_a(1));
    const avant = app.db.prepare('SELECT (SELECT COUNT(*) FROM local_state) + (SELECT COUNT(*) FROM local_pref) + (SELECT COUNT(*) FROM task) + (SELECT COUNT(*) FROM review) AS n').get().n;
    const d = await page();
    assert.equal(d.attached, true);
    assert.deepEqual(d.counts, { decisions: 1, questions: 1, running: 0 });
    assert.deepEqual(d.decisions.items.map((x) => [x.iid, x.author, x.reviewer, x.score, Math.round(x.waiting_days)]), [[214, 'Claire', 'Ali', 8.6, 5]]);
    assert.deepEqual(d.questions.items.map((x) => [x.task_id, x.author, x.question]), [[sc, 'Claire', 'Faut-il arrondir la TVA au centime ?']]);
    assert.ok(!JSON.stringify(d).includes('PRIV'), 'rien d’une session non partagée, pas même son existence');
    const postes = Object.fromEntries(d.workstations.items.map((w) => [w.name, w]));
    assert.equal(postes.Claire.quiet, false); assert.equal(postes.Ali.quiet, true);
    assert.equal(postes.Claire.decisions_awaited, 1);
    assert.deepEqual(d.people.sort(), ['Ali', 'Claire']);
    assert.equal(d.empty, false);
    assert.ok(d.sync && 'last' in d.sync && 'next' in d.sync);
    assert.equal(app.db.prepare('SELECT (SELECT COUNT(*) FROM local_state) + (SELECT COUNT(*) FROM local_pref) + (SELECT COUNT(*) FROM task) + (SELECT COUNT(*) FROM review) AS n').get().n, avant, 'la page ne stocke rien');
    assert.equal(app.state.calls.filter((c) => !/\/api\/v4\/(projects\?|user)/.test(c.path)).length, 0, 'aucun appel forge pour la page');
    // Le filtre personne : ce qui attend Ali, c'est rien — sauf sa ligne de fraîcheur.
    const ali = await page('?person=Ali');
    assert.deepEqual([ali.counts.decisions, ali.counts.questions, ali.workstations.items.map((w) => w.name)], [0, 0, ['Ali']]);
    const claire = await page('?person=Claire');
    assert.deepEqual([claire.counts.decisions, claire.counts.questions], [1, 1]);
    // Les réglages d'équipe : le seuil de silence s'applique.
    assert.equal((await app.api('PUT', '/api/config', { team_quiet_days: '30' })).status, 200);
    assert.equal((await page()).workstations.items.find((w) => w.name === 'Ali').quiet, false);
    await app.api('PUT', '/api/config', { team_quiet_days: '2' });
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let pg;
    const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      pg = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
      pg.on('pageerror', (e) => erreurs.push(e.message));
      await pg.goto(app.base);
      await pg.locator('nav button[data-tab="team"]').click();
      await pg.locator('#tab-team.active').waitFor();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('les trois chiffres, les sections, « silencieux » sur Ali, le filtre par personne ; une ligne mène à la carte ; une personne n’est jamais un lien', async () => {
      await pg.locator('#equipeBox .equipe-tete').waitFor();
      const tete = await pg.locator('#equipeBox .equipe-tete').innerText();
      assert.match(tete, /1\s*(décision en attente|pending decision)/); assert.match(tete, /1\s*(question sans réponse|unanswered question)/); assert.match(tete, /0\s*(sessions? en cours|running sessions?)/);
      assert.match(await pg.locator('#equipeBox .equipe-sync').innerText(), /(Dépôt de données synchronisé|Data repository synced|jamais synchronisé|never synced)/);
      const decision = pg.locator('[data-equipe-sec="decisions"] .equipe-item').first();
      assert.match(await decision.innerText(), /!214 · grp\/tarification[\s\S]*8,6\/10 · Claire · (reviewée par|reviewed by) Ali · (attend depuis|awaiting for) 5 (j|d)/);
      assert.match(await pg.locator('[data-equipe-sec="questions"] .equipe-item').first().innerText(), /#\d+ · Claire · grp\/tarification[\s\S]*« Faut-il arrondir la TVA au centime \? »/);
      const postes = await pg.locator('[data-equipe-sec="workstations"] .equipe-item').allInnerTexts();
      assert.ok(postes.some((t) => /^Claire/.test(t) && /(1 décision attendue|1 decision awaited)/.test(t) && !/silencieux|quiet/.test(t)));
      assert.ok(postes.some((t) => /^Ali/.test(t) && /(silencieux|quiet)/.test(t)));
      assert.equal(await pg.locator('#equipeBox a[href]').count(), 0, 'aucun lien : ni sur un nom, ni ailleurs');
      assert.equal(await pg.locator('[data-equipe-sec="workstations"] .equipe-item.inerte').count(), 2, 'une personne n’est pas cliquable');
      // Le filtre personne.
      await pg.selectOption('#equipePersonne', 'Ali');
      await pg.waitForFunction(() => /0\s*(décision|pending)/.test(document.querySelector('#equipeBox .equipe-tete')?.textContent || ''));
      assert.equal(await pg.locator('[data-equipe-sec="decisions"]').count(), 0);
      assert.equal(await pg.locator('[data-equipe-sec="workstations"] .equipe-item').count(), 1);
      await pg.selectOption('#equipePersonne', '');
      await pg.waitForFunction(() => /1\s*(décision|pending)/.test(document.querySelector('#equipeBox .equipe-tete')?.textContent || ''));
      // Une ligne mène à la carte : la décision ouvre Reviews sur !214.
      await pg.locator('[data-equipe-sec="decisions"] .equipe-item').first().click();
      await pg.locator('#tab-review.active').waitFor();
      // Une merge request reviewée : la ligne ouvre Reviews sur son rapport (sa carte vit dans « reviewées »).
      await pg.waitForFunction((id) => !!document.querySelector(`.card[data-id="${id}"]`) || !(document.querySelector('#reportSplit') || { hidden: true }).hidden, ids.m214);
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });

    test('la page vide dit « Rien n’attend personne ce matin. » ; détachée, elle dit qu’elle lit le dépôt partagé', async () => {
      app.db.prepare("UPDATE mr SET status = 'done' WHERE id = ?").run(ids.m214);
      app.db.prepare("UPDATE task_target SET status = 'running' WHERE task_id = ?").run(ids.sc);
      app.db.prepare("UPDATE task SET status = 'done' WHERE id = ?").run(ids.sc);
      await pg.locator('nav button[data-tab="team"]').click();
      await pg.locator('#equipeBox .equipe-vide').waitFor();
      assert.match(await pg.locator('#equipeBox .equipe-vide').innerText(), /Rien n’attend personne ce matin\.|Nothing is waiting on anyone this morning\./);
      assert.equal(await pg.locator('[data-equipe-sec="workstations"]').count(), 1, 'la fraîcheur des postes reste');
      await app.api('PUT', '/api/config', { data_repo_url: '' });
      await pg.locator('nav button[data-tab="notes"]').click();
      await pg.locator('nav button[data-tab="team"]').click();
      await pg.locator('#equipeBox .equipe-absente').waitFor();
      assert.match(await pg.locator('#equipeBox .equipe-absente').innerText(), /lit le dépôt de données partagé|reads the shared data repository/);
      await pg.locator('#equipeBox [data-equipe-reglages]').click();
      await pg.locator('#sub-datasync.active').waitFor();
      assert.deepEqual(erreurs, [], 'aucune erreur de page');
    });
  });
});
