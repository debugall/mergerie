'use strict';
/* PARTAGE, OBJET PAR OBJET — CE QUI SE PARTAGE EN BLOC, ET CE QUI NE PART JAMAIS.
 *
 * Les sessions, pages et todos se partagent une à une, sur un geste (voir les deux autres
 * fichiers `e2e-menu-partage-*`). Tout le reste suit sa FAMILLE (`src/store-registry.js`) :
 *   - « P » — rapports de review, règles de review, agents, vérificateurs, réglages d'équipe —
 *     part d'office, parce que c'est un produit que l'équipe consomme ;
 *   - « L » — jetons, veille Jira, palette git, grille de liens et liens libres — ne part jamais,
 *     parce que ça décrit une façon de travailler sur CE poste.
 *
 * Ce fichier le prouve dans un vrai dépôt, menu par menu :
 *   - Reviews : le rapport part ; une passe reprise par Claire se lit « par Claire » au survol
 *     de la note, sur la carte du rapport ;
 *   - Réglages → Règles : une règle posée depuis le formulaire part ; corrigée par Claire, la
 *     carte dit qui l'a touchée en dernier ;
 *   - Agents : un agent part ; celui qu'écrit Claire arrive dans la liste ;
 *   - Réglages → Vérificateurs : un vérificateur part ; celui de Claire arrive dans la liste ;
 *   - Dev IA → Lots : un lot part ; celui de Claire arrive ; supprimé ici, le mien en sort ;
 *   - Réglages → Général et Merge requests : un réglage d'équipe et l'exécutant des automatismes
 *     enregistrés depuis le formulaire arrivent dans `settings.json`, celui que Claire y change
 *     s'affiche ici ; les jetons n'y sont jamais ;
 *   - Jira, Git, Liens : rien de ce qu'on y range n'est dans le dépôt.
 *
 * La cadence est poussée à 600 s : ce qu'on voit arriver vient du tour qu'on a demandé.
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, afficherMenusOptionnels,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const {
  creerDepotNu, fichiersDuDepot, contenuDuDepot, toutLeDepot, collegue, synchroniserJusqua, uidDe,
} = require('./helpers/partage');

const { dispo } = navigateurDispo();

describe('Partage — objets d’équipe et objets de poste', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let racine; let nu; let claire;
  let mrId; let repoId;
  const erreurs = [];

  const fichiers = () => fichiersDuDepot(nu);
  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  const ouvrirReglages = async (sub) => {
    await fermerModales();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
  };

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'partage-equipe-'));
    nu = creerDepotNu(racine);
    claire = collegue(racine, nu, 'Claire');

    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Paiement en trois fois', state: 'opened', source_branch: repo.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/7', sha: repo.branchSha,
      created_at: '2026-02-01T10:00:00.000Z', author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }];
    app.state.changes['grp/app!7'] = [{ new_path: 'src/app.js' }];
    app.state.jiraIssues['OPS-77'] = {
      key: 'OPS-77',
      fields: { summary: 'Veille privée du poste', status: { name: 'À faire', statusCategory: { key: 'new' } }, issuetype: { name: 'Tâche' } },
    };
    await app.configure({
      data_sync_seconds: '600', jira_url: app.gitlabUrl, jira_email: 'moi@example.com',
      jira_token: 'jeton-jira-du-poste', jira_watch_minutes: '0',
    });
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    await app.api('POST', '/api/discover');
    mrId = app.db.prepare('SELECT id FROM mr WHERE iid = 7').get().id;
    await app.api('POST', '/api/jobs/review');
    await waitForJobs(app.api);
    await attendreServeur(async () => Boolean(app.db.prepare('SELECT 1 FROM review WHERE mr_id = ?').get(mrId)), 'la review existe');

    const r = await app.api('POST', '/api/data-sync/attach', { url: nu });
    assert.equal(r.status, 200, r.text);
    await attendreServeur(async () => Boolean((await app.api('GET', '/api/data-sync')).body.dernierPush), 'le premier envoi');

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  /* ------------------------------------------------------------ Reviews ---- */

  test('Reviews : le rapport est dans le dépôt ; repris par Claire, la note dit « par Claire »', async () => {
    const rapport = fichiers().find((f) => /^reviews\/gitlab\/grp\/app\/7\/[0-9A-Z]{26}\.md$/.test(f));
    assert.ok(rapport, `le rapport est parti sans qu’on le demande (${fichiers().join(', ')})`);
    assert.match(contenuDuDepot(nu, rapport), /Note globale/);
    assert.ok(fichiers().includes('reviews/gitlab/grp/app/7/review.json'), 'l’état de la review part avec lui');

    claire.publier('review de Claire', ({ ecrire, lire }) => {
      ecrire(rapport, `${lire(rapport)}\n\nRelu et complété par Claire.\n`);
    });
    await synchroniserJusqua(app, async () => {
      const m = ((await app.api('GET', '/api/mrs?status=reviewed')).body || []).find((x) => x.id === mrId);
      return m && m.note_detail && m.note_detail.author === 'Claire';
    }, 'la dernière passe est attribuée à Claire');

    await page.reload();
    await page.locator('nav button[data-tab="review"]').click();
    await page.locator('[data-seg="reviewed"]').click();
    const note = page.locator(`#reportList .card[data-id="${mrId}"] .note`);
    await note.waitFor();
    await page.waitForFunction((id) => /par Claire/.test(
      (document.querySelector(`#reportList .card[data-id="${id}"] .note`) || { dataset: {} }).dataset.tip || '',
    ), mrId);
    /* Le survol le montre, dans la bulle. La bulle ne s'ouvre qu'au `mouseover` : si la carte se
       redessine entre le survol et la lecture (la liste se rafraîchit, la synchro tourne), le
       nouvel élément sous un curseur IMMOBILE ne reçoit pas d'événement, et la bulle reste fermée
       — c'est arrivé sur le runner à deux cœurs. On survole donc À NOUVEAU tant qu'elle n'est pas
       là, en re-résolvant la carte à chaque fois. */
    const bulle = () => page.waitForFunction(() => {
      const t = document.querySelector('#tip');
      return t && t.classList.contains('on') && /par Claire/.test(t.textContent);
    }, null, { timeout: 3000 });
    for (let essai = 1; ; essai += 1) {
      await page.mouse.move(0, 0);
      await note.hover();
      try { await bulle(); break; } catch (e) { if (essai === 10) throw e; }
    }
  });

  /* ------------------------------------------------------------ Règles de review ---- */

  test('Règles : posée depuis le formulaire, la règle part ; corrigée par Claire, la carte le dit', async () => {
    await ouvrirReglages('rules');
    await page.waitForSelector('#ruleRepoBox [data-repo-combo]');
    await page.locator('#ruleForm [name="branch_match"]').fill('PAY-');
    await page.locator('#ruleForm [name="label"]').fill('paiement-equipe');
    await page.locator('#ruleForm [name="content"]').fill('Toute migration doit être réversible.');
    await page.locator('#ruleForm button[type="submit"]').click();
    const regle = async () => ((await app.api('GET', '/api/rules')).body || []).find((r) => r.label === 'paiement-equipe');
    await attendreServeur(async () => Boolean(await regle()), 'la règle est créée');
    const { id, uid } = app.db.prepare("SELECT id, uid FROM review_rule WHERE label = 'paiement-equipe'").get();
    const fichier = `rules/${uid}.json`;
    await synchroniserJusqua(app, async () => fichiers().includes(fichier), 'la règle est dans le dépôt');
    assert.equal(JSON.parse(contenuDuDepot(nu, fichier)).content, 'Toute migration doit être réversible.');

    claire.publier('règle corrigée par Claire', ({ ecrire, lireJson }) => {
      const doc = lireJson(fichier);
      doc.content = 'Toute migration doit être réversible ET testée.';
      ecrire(fichier, doc);
    });
    await synchroniserJusqua(app, async () => {
      const r = await regle();
      return r && r.author === 'Claire' && /ET testée/.test(r.content);
    }, 'la correction de Claire est arrivée');

    await ouvrirReglages('rules');
    await page.evaluate(() => loadRules());
    const carte = `#ruleList .repo-row[data-rule="${id}"]`;
    await page.waitForFunction((s) => /Claire/.test((document.querySelector(s) || {}).textContent || ''), carte);
    assert.match(await page.locator(`${carte} [data-f="content"]`).inputValue(), /ET testée/, 'sa version est celle qu’on lit');
  });

  /* ------------------------------------------------------------ Agents ---- */

  test('Agents : un agent part dans le dépôt ; celui qu’écrit Claire arrive dans la liste', async () => {
    const a = await app.api('POST', '/api/agents', { name: 'Relecteur sécurité', kind: 'explore' });
    assert.equal(a.status, 201, a.text);
    const fichier = `agents/${a.body.slug}/agent.json`;
    await synchroniserJusqua(app, async () => fichiers().includes(fichier), 'l’agent est dans le dépôt');

    // Claire en écrit un, au format que Mergerie écrit lui-même : on part du fichier du nôtre.
    const doc = JSON.parse(contenuDuDepot(nu, fichier));
    claire.publier('agent de Claire', ({ ecrire }) => {
      ecrire('agents/auditeur-de-claire/agent.json', {
        ...doc, uid: uidDe('CLAGENT1'), slug: 'auditeur-de-claire', name: 'Auditeur de Claire', description: 'Écrit chez Claire',
      });
    });
    await synchroniserJusqua(app, async () => ((await app.api('GET', '/api/agents')).body || [])
      .some((x) => x.name === 'Auditeur de Claire'), 'l’agent de Claire est arrivé');

    await fermerModales();
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
        await page.locator('#agentList .agent-card', { hasText: 'Auditeur de Claire' }).first().waitFor();
    await page.locator('#agentList .agent-card', { hasText: 'Relecteur sécurité' }).first().waitFor();
  });

  /* ------------------------------------------------------------ Vérificateurs ---- */

  test('Vérificateurs : un vérificateur part dans le dépôt ; celui de Claire arrive dans la liste', async () => {
    const v = await app.api('POST', '/api/verifiers', {
      name: 'tests-equipe', kind: 'commands', commands: ['npm test'], repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.equal(v.status, 200, v.text);
    const uid = app.db.prepare("SELECT uid FROM verifier WHERE name = 'tests-equipe'").get().uid;
    const fichier = `verifiers/${uid}.json`;
    await synchroniserJusqua(app, async () => fichiers().includes(fichier), 'le vérificateur est dans le dépôt');
    const doc = JSON.parse(contenuDuDepot(nu, fichier));
    assert.deepEqual((doc.commands || []).map((c) => c.command || c), ['npm test']);

    claire.publier('vérificateur de Claire', ({ ecrire }) => {
      ecrire(`verifiers/${uidDe('CLVERIF1')}.json`, { ...doc, uid: uidDe('CLVERIF1'), name: 'lint-de-claire' });
    });
    await synchroniserJusqua(app, async () => {
      const b = (await app.api('GET', '/api/verifiers')).body;
      return (Array.isArray(b) ? b : (b.verifiers || [])).some((x) => x.name === 'lint-de-claire');
    }, 'le vérificateur de Claire est arrivé');

    await ouvrirReglages('verifiers');
    await page.evaluate(() => loadVerifiers());
    await page.locator('#verifierList .card', { hasText: 'lint-de-claire' }).first().waitFor();
  });

  /* ------------------------------------------------------------ Lots ---- */

  test('Lots : un lot part dans le dépôt ; celui de Claire arrive dans Dev IA ; supprimé ici, le mien en sort', async () => {
    const l = await app.api('POST', '/api/lots', { name: 'Lot paiement', members: [mrId] });
    assert.equal(l.status, 200, l.text);
    const uid = app.db.prepare('SELECT uid FROM lot WHERE id = ?').get(l.body.id).uid;
    const fichier = `lots/${uid}.json`;
    await synchroniserJusqua(app, async () => fichiers().includes(fichier), 'le lot est dans le dépôt');
    const doc = JSON.parse(contenuDuDepot(nu, fichier));
    claire.publier('lot de Claire', ({ ecrire }) => {
      ecrire(`lots/${uidDe('CLLOT001')}.json`, { ...doc, uid: uidDe('CLLOT001'), name: 'Lot de Claire' });
    });
    await synchroniserJusqua(app, async () => app.db.prepare("SELECT 1 FROM lot WHERE name = 'Lot de Claire'").get(),
      'le lot de Claire est arrivé');

    await fermerModales();
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.evaluate(() => loadLots());
    await page.locator('#lotList .card', { hasText: 'Lot de Claire' }).waitFor();
    const mien = page.locator(`#lotList .card[data-id="${l.body.id}"]`);
    await mien.waitFor();
    await mien.locator('[data-lotdel]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => !app.db.prepare('SELECT 1 FROM lot WHERE id = ?').get(l.body.id), 'le lot est supprimé');
    await page.waitForSelector(`#lotList .card[data-id="${l.body.id}"]`, { state: 'detached' });
    await synchroniserJusqua(app, async () => !fichiers().includes(fichier), 'le lot supprimé a quitté le dépôt');
    assert.ok(fichiers().includes(`lots/${uidDe('CLLOT001')}.json`), 'celui de Claire, lui, reste');
  });

  /* ------------------------------------------------------------ Réglages d'équipe ---- */

  test('Réglages : un réglage d’équipe part dans settings.json, celui de Claire revient ; les jetons jamais', async () => {
    await ouvrirReglages('config');
    await page.waitForSelector('#sub-config .scope-badge');
    const champ = page.locator('[form="configForm"][name="stale_mr_days"]');
    await champ.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[form="configForm"][name="stale_mr_days"]').value !== '');
    await champ.fill('12');
    await page.locator('#sub-config button[type="submit"][form="configForm"]').first().click();
    await attendreServeur(async () => String((await app.api('GET', '/api/config')).body.stale_mr_days) === '12', 'le réglage est en base');
    await synchroniserJusqua(app, async () => String(JSON.parse(contenuDuDepot(nu, 'settings.json')).stale_mr_days) === '12',
      'le réglage d’équipe est dans settings.json');

    claire.publier('réglage de Claire', ({ ecrire, lireJson }) => {
      const doc = lireJson('settings.json');
      doc.stale_mr_days = 21;
      ecrire('settings.json', doc);
    });
    await synchroniserJusqua(app, async () => String((await app.api('GET', '/api/config')).body.stale_mr_days) === '21',
      'le réglage de Claire est arrivé');
    await page.reload();
    await ouvrirReglages('config');
    await page.waitForFunction(() => document.querySelector('[form="configForm"][name="stale_mr_days"]').value === '21');

    // QUI EXÉCUTE LES AUTOMATISMES est une décision d'équipe : elle part dans le même fichier.
    await ouvrirReglages('mr');
    await page.waitForFunction(() => {
      const r = document.querySelector('#autoRunnerRow');
      return r && !r.hidden && [...document.querySelector('#autoRunnerSelect').options].some((o) => o.value === '@auteur');
    });
    await page.selectOption('#autoRunnerSelect', '@auteur');
    await page.locator('#sub-mr button[type="submit"][form="configForm"]').first().click();
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.auto_runner === '@auteur', 'l’exécutant est en base');
    await synchroniserJusqua(app, async () => JSON.parse(contenuDuDepot(nu, 'settings.json')).auto_runner === '@auteur',
      'l’exécutant des automatismes est dans settings.json');

    // Ce qui est du poste ne voyage pas : ni jeton, ni chemin de clone.
    const tout = toutLeDepot(nu);
    for (const secret of [app.state.token, 'jeton-jira-du-poste']) {
      assert.ok(!tout.includes(secret), `un jeton est parti dans le dépôt : ${secret}`);
    }
    const reglages = JSON.parse(contenuDuDepot(nu, 'settings.json'));
    for (const cle of ['access_token', 'jira_token', 'clone_path', 'data_repo_url']) {
      assert.equal(cle in reglages, false, `« ${cle} » est un réglage de poste`);
    }
  });

  /* ------------------------------------------------------------ ce qui ne part jamais ---- */

  test('Jira, Git, Liens : la veille, la palette, la grille et les liens libres restent sur ce poste', async () => {
    assert.equal((await app.api('POST', '/api/jira/watch', { key: 'OPS-77' })).status, 200);
    assert.equal((await app.api('POST', '/api/git-commands', { label: 'Palette privée', command: 'fetch --prune' })).status, 200);
    assert.equal((await app.api('POST', '/api/services', { name: 'Service-du-poste' })).status, 200);
    assert.equal((await app.api('POST', '/api/free-links', { label: 'Lien-libre-du-poste', url: 'https://interne.exemple.test/wiki' })).status, 200);
    // Une écriture d'équipe dans le même tour : la preuve que ce tour-là a bien poussé quelque chose.
    await app.api('POST', '/api/rules', { branch_match: 'LOCAL-', label: 'temoin-du-tour', content: 'témoin' });
    const uid = app.db.prepare("SELECT uid FROM review_rule WHERE label = 'temoin-du-tour'").get().uid;
    await synchroniserJusqua(app, async () => fichiers().includes(`rules/${uid}.json`), 'le tour a poussé');

    const tout = toutLeDepot(nu);
    for (const prive of ['OPS-77', 'Veille privée du poste', 'Palette privée', 'fetch --prune', 'Service-du-poste',
      'Lien-libre-du-poste', 'interne.exemple.test']) {
      assert.ok(!tout.includes(prive), `« ${prive} » ne devait pas quitter ce poste`);
    }
    assert.ok(!fichiers().some((f) => /^(jira|git|links|services|free)/.test(f)), fichiers().join(', '));

    // …et ils sont bien là, chez moi : ne pas partir n'est pas disparaître.
    assert.ok((await app.api('GET', '/api/jira/watch')).body.watched.some((w) => w.key === 'OPS-77'));
    await ouvrirReglages('gitcfg');
    await page.evaluate(() => (typeof loadGitCommands === 'function' ? loadGitCommands() : null));
    await page.waitForFunction(() => /Palette privée/.test((document.querySelector('#gitCmdList') || {}).textContent || ''));
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
