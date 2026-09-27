'use strict';
/* MENU NOTES → AUJOURD'HUI : les sections qui viennent d'AILLEURS que la base.
 *
 * Trois sections du brief ne se remplissent qu'avec un tiers ou un autre écran :
 *   - « Conteneurs tombés » — ce que la veille de fond a relevé chez Docker ;
 *   - « CI rouge sur mes branches » — la liste Jenkins croisée avec les branches de mes MR ;
 *   - « À nettoyer » — le nombre de branches de MR mergées, lu par l'onglet Git.
 * Et deux saveurs de session qui attendent une réponse sans avoir de dépôt : hors dépôt et
 * question libre. Chacune mène à son écran, et c'est ce que ce fichier éprouve par l'écran.
 *
 * Docker est remplacé par une doublure posée sur le module (comme dans e2e-veille) : le runner
 * n'a pas de démon. Jenkins est le faux serveur de test/helpers/mock-jenkins.
 *
 * Un seul `startApp()` ; `src/` n'est chargé qu'APRÈS lui (voir e2e-veille). */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const mockJenkins = require('./helpers/mock-jenkins');

const { dispo } = navigateurDispo();

describe('Menu Notes · Aujourd’hui — Docker, Jenkins, Git et sessions sans dépôt', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let jenkins;
  let docker; let veille; let vraiStatus; let vraiListe;
  const erreurs = [];
  const s = {};

  before(async () => {
    app = await startApp();
    /* eslint-disable global-require */
    docker = require('../src/integrations/docker');
    veille = require('../src/integrations/veille');
    /* eslint-enable global-require */

    // Jenkins : un job ROUGE dont le dernier build porte la branche d'une de mes MR.
    jenkins = await mockJenkins.start();
    mockJenkins.reset();
    const build = (n, ref) => ({
      number: n, timestamp: Date.now() - 3600e3,
      actions: [{ causes: [{ userName: 'Alice' }] }, { lastBuiltRevision: { branch: [{ name: `refs/remotes/origin/${ref}` }] } }],
    });
    mockJenkins.state.jobs = [
      { name: 'boutique', _class: 'com.cloudbees.hudson.plugins.folder.Folder', jobs: [
        { name: 'panier-ci', color: 'red', buildable: true, lastBuild: build(57, 'feature/panier') },
        { name: 'autre-ci', color: 'blue', buildable: true, lastBuild: build(12, 'main') },
      ] },
    ];
    mockJenkins.state.details['/job/boutique/job/panier-ci'] = {
      name: 'panier-ci', color: 'red', buildable: true, property: [],
      builds: [{ number: 57, result: 'FAILURE', building: false, timestamp: Date.now(), duration: 4000, url: '' }],
    };
    await app.configure({ jenkins_url: jenkins.url, jenkins_user: mockJenkins.state.user, jenkins_token: mockJenkins.state.token });

    app.state.mrs['grp/app'] = [{
      iid: 41, title: 'Le panier en trois fois', state: 'opened',
      source_branch: 'feature/panier', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/41', sha: 'sha41',
      created_at: '2026-03-01T10:00:00.000Z', author: { name: 'Alice' },
      diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'sha41' },
    }];
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app.git', project: 'grp/app' });
    await app.api('POST', '/api/discover');
    const repoId = app.db.prepare("SELECT id FROM repo WHERE project = 'grp/app'").get().id;
    s.mr41 = app.db.prepare('SELECT id FROM mr WHERE iid = 41').get().id;

    // Dix merge requests mergées, dix branches mortes : le seuil du brief.
    for (let i = 0; i < 10; i += 1) {
      app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, closed_seen, updated_at)
        VALUES (?, ?, ?, ?, 'main', 'done', 1, datetime('now'))`).run(repoId, 500 + i, `mergée ${i}`, `feature/morte-${i}`);
    }

    // Deux sessions sans dépôt arrêtées sur une question.
    const now = new Date().toISOString();
    s.local = app.db.prepare(`INSERT INTO local_task (prompt, status, created_at, updated_at)
      VALUES ('Ranger mes scripts', 'needs_input', ?, ?)`).run(now, now).lastInsertRowid;
    s.ask = app.db.prepare(`INSERT INTO question (prompt, status, created_at, updated_at)
      VALUES ('Pourquoi le cache expire ?', 'needs_input', ?, ?)`).run(now, now).lastInsertRowid;

    // Docker : la veille a vu tomber un service compose et un conteneur lancé à la main.
    vraiStatus = docker.status; vraiListe = docker.listContainers;
    const conteneur = (name, project) => ({
      id: name, name, state: 'exited', status: 'Exited (1) 2 minutes ago', image: 'x',
      project, service: project ? 'api' : null, running: false,
    });
    docker.status = async () => ({ ok: true });
    docker.listContainers = async () => [conteneur('boutique-api-1', 'boutique'), conteneur('redis-seul', null)];
    await veille.tourDocker();

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    // L'application s'ouvre sur Reviews : la file (et ses branches) est chargée.
    await page.waitForSelector(`#toReviewList .card[data-id="${s.mr41}"]`);
  });

  after(async () => {
    if (docker) { docker.status = vraiStatus; docker.listContainers = vraiListe; }
    if (veille) veille.arreter();
    if (navigateur) await navigateur.close();
    if (jenkins) await jenkins.close();
    if (app) await app.stop();
  });

  const allerBrief = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
    await page.waitForSelector('#notesSubToday:not([hidden]) #briefBox .brief-head');
  };
  const section = (titre) => page.locator('#briefBox .brief-sec').filter({ has: page.locator('h3', { hasText: titre }) });

  test('les conteneurs tombés sont listés, datés, et chacun mène à son sous-onglet Docker', async () => {
    await allerBrief();
    const sec = section('Conteneurs tombés');
    await sec.waitFor();
    const texte = await sec.innerText();
    assert.match(texte, /boutique-api-1/);
    assert.match(texte, /redis-seul/);
    assert.match(texte, /Relevé/, 'un relevé, pas un direct');

    await sec.locator('[data-brief-docker="boutique-api-1"]').click();
    await page.waitForSelector('#tab-docker.active');
    await page.waitForSelector('#dsub-compose.active');

    await allerBrief();
    await section('Conteneurs tombés').locator('[data-brief-docker="redis-seul"]').click();
    await page.waitForSelector('#tab-docker.active');
    await page.waitForSelector('#dsub-orphans.active');
  });

  test('un job Jenkins rouge sur la branche d’une de mes MR apparaît, et « Détails » ouvre sa fiche', async () => {
    await allerBrief();
    // La liste Jenkins arrive APRÈS le brief, qui se redessine alors.
    const sec = section('CI rouge sur mes branches');
    await sec.waitFor();
    const texte = await sec.innerText();
    assert.match(texte, /boutique\/panier-ci/);
    assert.match(texte, /#57/);
    assert.match(texte, /feature\/panier — merge request !41/);
    assert.doesNotMatch(texte, /autre-ci/, 'un job vert ne s’y trouve pas');

    await sec.locator('[data-ci-job="boutique/panier-ci"]').click();
    await page.waitForSelector('#tab-jenkins.active');
    await page.waitForSelector('#jenkinsModal:not([hidden])');
    assert.equal(await page.locator('#jenkinsModalTitle').innerText(), 'boutique/panier-ci');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#jenkinsModal', { state: 'hidden' });
  });

  test('dix branches mergées à nettoyer : le brief le dit une fois l’onglet Git vu, et « Nettoyer » prépare le lot', async () => {
    // Le nombre est lu par l'onglet Git : on y passe, comme au quotidien.
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForSelector('#gitMergedBar:not([hidden])');
    await allerBrief();
    const sec = section('À nettoyer');
    await sec.waitFor();
    assert.match(await sec.innerText(), /10 branches de merge requests mergées à nettoyer/);
    await sec.locator('[data-brief-branches]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForSelector('#gsub-actions.active');
    await page.waitForFunction(() => document.querySelector('#gitAction').value === 'delete_branch');
  });

  test('une session hors dépôt et une question libre en attente mènent chacune à leur carte', async () => {
    await allerBrief();
    const sec = section('Sessions en attente de réponse');
    await sec.waitFor();
    assert.match(await sec.innerText(), /Ranger mes scripts/);
    assert.match(await sec.innerText(), /Pourquoi le cache expire/);

    await sec.locator(`[data-brief-session="${s.local}"][data-brief-kind="local"]`).click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((t) => window.location.hash === `#/sessions/local/${t}`, s.local);

    await allerBrief();
    await section('Sessions en attente de réponse').locator(`[data-brief-session="${s.ask}"][data-brief-kind="ask"]`).click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((t) => window.location.hash === `#/sessions/ask/${t}`, s.ask);
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
