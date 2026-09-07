'use strict';
/* LES CROISEMENTS ET LES RACCOURCIS DU RAPPORT D'AMÉLIORATIONS.
 *
 * Ce fichier éprouve ce qu'aucun autre ne couvre : des faits qui vivent ENTRE deux écrans (une
 * merge request mergée qui ferme une todo, un build Jenkins qui s'écrit sur une carte de
 * review, un ticket Jira qui fait remonter une file) et des gestes qui remplacent une
 * manipulation (copier une branche, ouvrir une référence, écrire une todo en une phrase).
 *
 * Un seul `startApp()` : le harnais démarre le serveur EN PROCESSUS, un second appel dans le
 * même fichier attend un « listening » qui ne viendra jamais.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Améliorations — croisements et raccourcis', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repoId; let mrId; let depot;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 217, title: 'Paiement 3× : intégration du partenaire', state: 'opened',
      source_branch: depot.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/217',
      sha: depot.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: depot.mainSha, start_sha: depot.mainSha, head_sha: depot.branchSha },
    }];
    app.state.changes['grp/app!217'] = [
      { new_path: 'src/app.js', diff: '@@\n+une ligne\n+une autre\n-supprimée\n' },
    ];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body[0].id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(String(e)));
    await navigateur.contexts()[0].grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Attendre une condition du SERVEUR depuis le test, où `await` veut dire `await`. Une attente
     écrite côté PAGE avec un prédicat asynchrone serait un no-op déguisé : Playwright ne déroule
     pas la promesse rendue, il la voit « truthy » et rend la main au premier tour. */
  async function attendre(cond, quoi, ms = ATTENTE) {
    const fin = Date.now() + ms;
    for (;;) {
      const v = await cond();
      if (v) return v;
      if (Date.now() > fin) throw new Error(`délai dépassé : ${quoi}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /* ---------- Axe C : les gestes du quotidien ---------- */

  test('la taille et l’âge se lisent sur la carte, sans l’ouvrir', async () => {
    await page.waitForSelector('#toReviewList .mr-taille', { timeout: ATTENTE });
    const ligne = await page.locator('#toReviewList .mr-taille').first().innerText();
    assert.match(ligne, /1 fichier/, 'le nombre de fichiers vient du relevé fait à la découverte');
    assert.match(ligne, /\+2/, 'les lignes ajoutées');
    assert.match(ligne, /−1|-1/, 'les lignes retirées');
    assert.match(ligne, /activité/i, 'et la fraîcheur');
  });

  test('le chip de branche se copie, ⇧-clic donne la commande de récupération', async () => {
    const chip = page.locator('#toReviewList .branch-chip').first();
    await chip.click();
    await page.waitForSelector('.toast', { timeout: ATTENTE });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), depot.branch);

    await page.keyboard.down('Shift');
    await chip.click();
    await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()),
      `git fetch origin && git checkout ${depot.branch}`,
      '⇧-clic copie le geste qui SUIT le copier, neuf fois sur dix');
  });

  test('« Copier la référence » compose le message tout fait', async () => {
    await page.click('#toReviewList [data-more]');
    await page.click('#toReviewList [data-copy-ref]');
    const ref = await attendre(async () => {
      const v = await page.evaluate(() => navigator.clipboard.readText());
      return /^!217/.test(v) ? v : null;
    }, 'la référence est copiée');
    assert.match(ref, /^!217 — Paiement 3×/);
    assert.match(ref, /merge_requests\/217/, 'avec l’adresse : c’est ce qu’on colle dans Slack');
  });

  test('la capture rapide comprend « !217 relire @demain !! »', async () => {
    await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    await page.click('nav button[data-tab="review"]');
    await page.keyboard.press('n');
    await page.waitForSelector('#captureModal:not([hidden])', { timeout: ATTENTE });
    await page.fill('#captureTitle', '!217 relire le calcul @demain !!');
    await page.press('#captureTitle', 'Enter');
    const todo = await attendre(async () => {
      const r = await app.api('GET', '/api/todos');
      return (r.body.todos || []).find((x) => /relire le calcul/.test(x.title || ''));
    }, 'la todo est créée');
    assert.equal(todo.title, 'relire le calcul', 'la syntaxe sort du titre, elle n’y reste pas');
    assert.equal(todo.priority, 'high');
    assert.equal(todo.link_kind, 'mr');
    assert.equal(String(todo.link_ref), String(mrId), '« !217 » est le NUMÉRO ; la todo se lie à l’identifiant interne');
    assert.ok(todo.due_at, 'et l’échéance est posée');
  });

  test('la palette ouvre « !217 » tapé seul', async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
      // `o` est ignoré tant qu'un champ a le focus — c'est voulu : on tape « o » dans un champ.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    });
    await page.click('#paletteTrigger');
    await page.waitForSelector('#paletteModal:not([hidden])', { timeout: ATTENTE });
    await page.fill('#paletteInput', '!217');
    await page.waitForFunction(() => document.querySelectorAll('#paletteList .palette-item').length > 0, null, { timeout: ATTENTE });
    await page.press('#paletteInput', 'Enter');
    await page.waitForFunction(() => document.querySelector('#paletteModal').hidden, null, { timeout: ATTENTE });
    assert.equal(await page.locator('nav button[data-tab].active').evaluate((e) => e.dataset.tab), 'review',
      'une référence tapée seule est une ADRESSE : on y va, on ne la cherche pas');
  });

  /* ---------- Axe A : ce que l'existant ne disait pas ---------- */

  test('un constat mène à sa ligne, le commentaire pré-rempli', async () => {
    await app.api('POST', `/api/mrs/${mrId}/review`);
    await attendre(async () => {
      const r = await app.api('GET', `/api/mrs/${mrId}/findings`);
      return (r.body.findings || []).length > 0;
    }, 'la review a produit des constats', 60000);
    /* DEUX PASSES. Le bandeau des constats est celui du SUIVI DE RÉSOLUTION : il n'existe qu'à
       partir de la deuxième review, quand il y a un delta à raconter. Une seule passe n'affiche
       aucune liste — et le test porterait alors sur un écran qui n'a rien à montrer. */
    await app.api('POST', `/api/mrs/${mrId}/rereview`);
    await attendre(async () => {
      // La route rend un TABLEAU de versions, pas un objet enveloppe.
      const r = await app.api('GET', `/api/mrs/${mrId}/versions`);
      return Array.isArray(r.body) && r.body.length >= 2;
    }, 'la deuxième passe est enregistrée', 60000);

    await page.goto(app.base);
    await page.click('nav button[data-tab="review"]');
    await page.click('[data-seg="reviewed"]');
    await page.waitForSelector('#reportList .card', { timeout: ATTENTE });
    await page.click('#reportList .card');
    await page.waitForSelector('#findingsList [data-finding-go]', { timeout: ATTENTE });

    const cible = page.locator('#findingsList [data-finding-go]').first();
    const titre = await cible.evaluate((e) => e.dataset.ftitle);
    await cible.click();

    /* DEUX ISSUES CORRECTES, ET UNE SEULE INTERDITE. Le constat peut nommer un fichier qui
       n'est PAS dans le diff — la review tourne ici en dry-run, et le fichier qu'elle cite
       varie d'une passe à l'autre. L'application le dit alors (un toast nomme le fichier)
       au lieu d'ouvrir un fichier au hasard : c'est le comportement voulu.
       Exiger toujours l'éditeur, c'était affirmer sur un état que l'écran a le droit de ne pas
       atteindre — d'où un test rouge une fois sur trois, qui accusait la fonctionnalité.
       Ce qui ne doit JAMAIS arriver, c'est qu'il ne se passe rien : on l'éprouve. */
    const editeur = page.locator('#fileContent .cmt-editor textarea');
    const issue = await Promise.race([
      editeur.waitFor({ state: 'visible', timeout: ATTENTE }).then(() => 'editeur'),
      page.locator('#toasts .toast').first().waitFor({ state: 'visible', timeout: ATTENTE }).then(() => 'toast'),
    ]).catch(() => 'rien');
    assert.notEqual(issue, 'rien', 'cliquer un constat fait quelque chose : l’éditeur, ou la raison');

    if (issue === 'editeur') {
      assert.equal(await editeur.inputValue(), titre,
        'on relit et on ajuste — on ne retape pas ce que l’IA vient d’écrire');
      await page.click('#fileContent .cmt-editor .cmt-cancel');
    } else {
      // Le toast NOMME le fichier absent : une raison sans le nom ne servirait à rien.
      const t = await page.locator('#toasts .toast').first().textContent();
      assert.match(String(t), /\S+\.\w+/, 'la raison nomme le fichier introuvable');
    }
    await page.click('#splitClose').catch(() => {});
  });

  test('le badge de note dit de quelle passe il vient', async () => {
    const tip = await page.locator('#reportList .note[data-tip]').first().getAttribute('data-tip');
    assert.match(tip, /^v\d/, 'la version, puis sa date — ce que le sélecteur dit une fois ouvert');
  });

  test('un vérificateur dit son dernier verdict et ce qui l’attend', async () => {
    await app.api('POST', '/api/verifiers', {
      name: 'intégration', kind: 'commands', commands: ['true'],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    const r = await app.api('GET', '/api/verifiers');
    const v = r.body[0];
    assert.equal(v.last, null, 'jamais lancé : on le dit, on n’invente pas de verdict');
    assert.equal(typeof v.pending_mrs, 'number', 'et le nombre de merge requests qu’il couvre');
  });

  test('une règle de review dit combien de merge requests elle touche', async () => {
    await app.api('POST', '/api/rules', { branch_match: 'feature', path_match: '', label: 'x', content: 'y' });
    await app.api('POST', '/api/rules', { branch_match: 'jamais-vu-ailleurs', path_match: '', label: 'z', content: 'w' });
    const r = await app.api('GET', '/api/rules');
    const touche = r.body.find((x) => x.branch_match === 'feature');
    const morte = r.body.find((x) => x.branch_match === 'jamais-vu-ailleurs');
    assert.equal(touche.open_mrs, 1, 'la branche de la merge request commence par « feature »');
    assert.equal(morte.open_mrs, 0, 'une règle qui ne matche plus rien se repère');
  });

  test('un dépôt dit son état : merge requests, découverte, clone', async () => {
    const r = await app.api('GET', '/api/repos');
    const d = r.body.find((x) => x.id === repoId);
    assert.equal(d.open_mrs, 1);
    assert.ok(d.last_seen_at, 'la date de la dernière découverte');
    assert.ok(['present', 'absent'].includes(d.clone_state), 'et l’état du clone');
  });

  /* ---------- Axe B : les croisements ---------- */

  test('B1 — la todo liée se coche quand sa merge request est mergée', async () => {
    const todo = (await app.api('POST', '/api/todos', {
      title: 'Suivre !217', link_kind: 'mr', link_ref: String(mrId),
    })).body;
    assert.equal(todo.status, 'open');

    // La merge request disparaît des ouvertes : la découverte la voit mergée.
    app.state.mrs['grp/app'] = [];
    await app.api('POST', '/api/discover');

    const apres = await attendre(async () => {
      const r = await app.api('GET', '/api/todos?status=all');
      const x = (r.body.todos || []).find((y) => y.id === todo.id);
      return x && x.status === 'done' ? x : null;
    }, 'la todo se ferme avec sa merge request');
    assert.match(apres.note || '', /!217/, 'et elle DIT ce qui l’a fermée — rien n’est supprimé');
  });

  test('B7 — les branches des merge requests mergées se ramassent en un lot', async () => {
    const r = await app.api('GET', '/api/git/merged-branches');
    assert.equal(r.body.total, 1, 'la branche de !217, dont la merge request vient d’être vue mergée');
    assert.equal(r.body.repos[0].refs[0].name, depot.branch);
  });

  test('B8 — un job Jenkins se lie à un dépôt, et rien ne part sans clic', async () => {
    await app.api('POST', '/api/jenkins/links', { repo_id: repoId, job_path: 'boutique/deploy', param: 'BRANCH' });
    const liens = (await app.api('GET', '/api/jenkins/links')).body.links;
    assert.equal(liens.length, 1);
    assert.equal(liens[0].job_path, 'boutique/deploy');
    assert.equal(liens[0].param, 'BRANCH', 'le paramètre qui recevra la branche');
    const mrs = (await app.api('GET', '/api/mrs')).body;
    assert.deepEqual(mrs[0].jenkins_jobs, [{ path: 'boutique/deploy', param: 'BRANCH' }],
      'la merge request porte le job de son dépôt ; l’écran décide de l’AFFICHER ou non');
  });

  test('B4 — un constat qui revient trois fois devient une proposition de règle', async () => {
    /* Trois merge requests du même dépôt portant le même constat : c'est le seuil à partir
       duquel une consigne mérite d'être écrite une fois pour toutes. */
    const now = new Date().toISOString();
    const ins = app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?,?,?,?,'main','reviewed',?)`);
    const insF = app.db.prepare(`INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at)
      VALUES (?,1,?,?,?,'major',?,'new',?)`);
    for (let i = 0; i < 3; i += 1) {
      const id = ins.run(repoId, 900 + i, `MR ${i}`, `feat/x${i}`, now).lastInsertRowid;
      insF.run(id, `fp-${i}`, 'src/checkout/total.js', 8, 'le numéro de carte est loggé', now);
    }
    const s = (await app.api('GET', '/api/stats')).body;
    const rec = (s.recurrents || []).find((x) => /numéro de carte/.test(x.title));
    assert.ok(rec, 'le constat remonte');
    assert.equal(rec.count, 3);
    assert.ok(rec.files.includes('src/checkout/total.js'), 'avec les fichiers : c’est le `path_match` de la future règle');
  });

  test('les sessions les plus coûteuses se classent', async () => {
    const tache = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'une tâche chère', targets: [{ repo_id: repoId, branch: 'ai/chere' }],
    })).body;
    app.db.prepare(`INSERT INTO usage (kind, prompt_chars, output_chars, tokens_est, created_at, owner_kind, owner_id)
      VALUES ('task', 10, 10, 99000, ?, 'task', ?)`).run(new Date().toISOString(), tache.id);
    const s = (await app.api('GET', '/api/stats')).body;
    assert.equal((s.topTasks || [])[0].tokens, 99000);
    assert.match((s.topTasks || [])[0].prompt, /une tâche chère/,
      '« combien coûtent les sessions » ne disait pas LESQUELLES');
  });

  test('aucune erreur de page pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
