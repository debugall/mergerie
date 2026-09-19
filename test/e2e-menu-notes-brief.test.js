'use strict';
/* MENU NOTES → AUJOURD'HUI (le brief), dans un VRAI navigateur.
 *
 * Chaque section du brief porte un geste, et ce geste mène à un écran précis. Les fichiers
 * existants prouvaient la composition PAR L'API (e2e-notes, e2e-veille) et, par l'écran,
 * l'atterrissage du matin et l'écart d'une MR (e2e-notes-ui). Il manquait tout le reste :
 *
 *   - le brief vide, puis le brief plein : chaque section s'affiche sous son titre ;
 *   - cocher et reporter une todo SUR PLACE (rappels, todos du jour) ;
 *   - « Copier pour le daily » : le texte réellement mis dans le presse-papiers ;
 *   - écarter une session, une vérification, une attente, puis « Tout réafficher » ;
 *   - chaque bouton : répondre à une session, voir / corriger une vérification, relire les
 *     remarques jamais envoyées, reprendre un suivi, lancer / pousser / créer la MR, reprendre
 *     un merge, voir l'historique git filtré, ouvrir la page d'un agent, relire une
 *     connaissance, reviewer une MR fraîche, ouvrir une MR (fraîche ou dormante), voir les
 *     prêtes à merger.
 *
 * Les sections qui dépendent d'une veille ou d'un service tiers (conteneurs tombés, CI rouge,
 * nettoyage des branches) vivent dans e2e-menu-notes-brief-veille.
 *
 * Un seul `startApp()` ; rien de `src/` n'est chargé en tête de fichier. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Notes · Aujourd’hui', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repo; let repoId;
  const erreurs = [];
  const id = {};          // iid → id interne des MR
  const s = {};           // identifiants des objets posés pour le brief

  const brief = async () => (await app.api('GET', '/api/brief')).body;
  const ilYA = (jours) => new Date(Date.now() - jours * 86400e3).toISOString();

  before(async () => {
    app = await startApp();
    repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    // Le brief mène à Git, un menu replié par défaut.
    await afficherMenusOptionnels(page);
    // Le presse-papiers d'un navigateur sans tête ne se relit pas : on garde ce qui y part.
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(String(t)); }, readText: async () => window.__copies.at(-1) || '' },
      });
    });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Notes → Aujourd'hui, brief RECHARGÉ (le sous-onglet relit /api/brief à chaque clic).
  const allerBrief = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="notes"]').click();
    await page.waitForSelector('#tab-notes.active');
    await page.locator('#tab-notes .subnav button[data-nsub="today"]').click();
    await page.waitForSelector('#notesSubToday:not([hidden]) #briefBox .brief-head');
  };
  const section = (titre) => page.locator('#briefBox .brief-sec').filter({ has: page.locator('h3', { hasText: titre }) });

  /* Tout ce qui remplit le brief, posé comme l'application le poserait. Les MR viennent du
     faux GitLab et d'un VRAI dépôt (le viewer des remarques a besoin d'un diff) ; ce qu'aucune
     API ne fabrique (une session arrêtée sur une question, un merge laissé à moitié) est écrit
     en base, comme dans e2e-veille. */
  async function peupler() {
    const d = app.db;
    const now = new Date().toISOString();
    const mr = (iid, titre, creee) => ({
      iid, title: titre, state: 'opened', source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${iid}`, sha: repo.branchSha,
      created_at: creee, author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    });
    app.state.mrs['grp/app'] = [
      mr(31, 'Fraîche du matin', now),
      mr(32, 'Endormie depuis longtemps', '2026-03-01T10:00:00.000Z'),
      mr(33, 'Prête à partir', '2026-03-02T10:00:00.000Z'),
      mr(34, 'Remarques en souffrance', '2026-03-03T10:00:00.000Z'),
    ];
    for (const iid of [31, 32, 33, 34]) app.state.changes[`grp/app!${iid}`] = [{ new_path: 'src/app.js' }];
    await app.api('POST', '/api/discover');
    for (const m of (await app.api('GET', '/api/mrs')).body) id[m.iid] = m.id;
    for (const iid of [32, 33, 34]) {
      await app.api('POST', `/api/mrs/${id[iid]}/review`, { explain: false });
      await waitForJobs(app.api);
    }
    // !32 dort : sa review a dix jours. !33 est notée 9/10 et vérifiée verte.
    d.prepare('UPDATE review SET updated_at = ? WHERE mr_id = ?').run(ilYA(10), id[32]);
    d.prepare('UPDATE review SET note_value = 0.9 WHERE mr_id = ?').run(id[33]);
    d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, finished_at, created_at)
      VALUES ('V', 'done', 'verified_pass', ?, ?, ?)`).run(JSON.stringify([{ mr_id: id[33], repo_id: repoId }]), now, now);
    // Une vérification ROUGE sur !31 (sans SHA : jamais périmée), et deux tests imputables.
    s.verif = d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, imputable_json, finished_at, created_at)
      VALUES ('Tests d’intégration', 'done', 'verified_fail', ?, ?, ?, ?)`)
      .run(JSON.stringify([{ mr_id: id[31], repo_id: repoId, branch: repo.branch }]),
        JSON.stringify([{ test: 'panier.total' }, { test: 'panier.remise' }]), now, now).lastInsertRowid;
    // Deux remarques inline jamais envoyées sur !34.
    for (const ligne of [1, 2]) {
      d.prepare(`INSERT INTO mr_comment_draft (mr_id, new_path, new_line, body, created_at, updated_at)
        VALUES (?, 'src/app.js', ?, 'à revoir', ?, ?)`).run(id[34], ligne, ilYA(2), ilYA(2));
    }

    const tache = (prompt, statut, extra = {}) => d.prepare(`INSERT INTO task
      (repo_id, prompt, branch, status, kind, created_at, updated_at, followup_draft, finished_at)
      VALUES (?, ?, ?, ?, 'code', ?, ?, ?, ?)`).run(repoId, prompt, extra.branch || 'feat/brief', statut, now, now,
      extra.followup || null, extra.finished || null).lastInsertRowid;
    const cible = (taskId, statut, branche) => d.prepare(`INSERT INTO task_target (task_id, repo_id, branch, status, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(taskId, repoId, branche, statut, now);
    // Une session arrêtée sur une question.
    s.question = tache('Quelle base de test utiliser ?', 'needs_input', { branch: 'feat/question' });
    cible(s.question, 'needs_input', 'feat/question');
    // Les trois attentes : jamais lancée, commitée non poussée, poussée sans MR.
    s.aLancer = tache('Ajouter un healthcheck', 'new', { branch: 'feat/health' });
    cible(s.aLancer, 'new', 'feat/health');
    s.aPousser = tache('Renommer le module', 'done', { branch: 'feat/rename' });
    cible(s.aPousser, 'committed', 'feat/rename');
    s.sansMr = tache('Corriger la remise', 'done', { branch: 'feat/remise' });
    cible(s.sansMr, 'pushed', 'feat/remise');
    // Un suivi écrit et jamais envoyé.
    s.suivi = tache('Refondre le cache', 'done', { branch: 'feat/cache', followup: 'Ajoute aussi les tests du cache', finished: now });
    cible(s.suivi, 'done', 'feat/cache');

    // Git : un merge en conflit, une suppression de branche refusée.
    d.prepare(`INSERT INTO git_merge (repo_id, source_branch, target_branch, dir, status, created_at, updated_at)
      VALUES (?, 'main', 'release/2.0', '/tmp/merge-brief', 'conflict', ?, ?)`).run(repoId, now, now);
    d.prepare(`INSERT INTO git_op (batch_id, created_at, action, repo_id, project, ref_name, status, error)
      VALUES ('lot-brief', ?, 'delete_branch', ?, 'grp/app', 'old/feature', 'error', 'protected branch')`).run(now, repoId);

    // Un agent a réécrit une page cette nuit ; un autre attend qu'on valide sa connaissance.
    const pageAgent = (await app.api('POST', '/api/notes', { title: 'Carte des services', content: 'écrite par l’agent' })).body;
    s.pageAgent = pageAgent.id;
    const doc = await app.api('POST', '/api/agents', { name: 'Veilleur de nuit', kind: 'explore' });
    assert.equal(doc.status, 201, doc.text);
    d.prepare("UPDATE agent SET output_kind = 'note_page', output_ref = ? WHERE id = ?").run(String(pageAgent.id), doc.body.id);
    d.prepare(`INSERT INTO task (repo_id, prompt, branch, status, kind, agent_id, agent_name, created_at, updated_at, finished_at)
      VALUES (?, 'documenter', 'agent/doc', 'done', 'explore', ?, 'Veilleur de nuit', ?, ?, ?)`).run(repoId, doc.body.id, now, now, now);
    const carto = await app.api('POST', '/api/agents', { name: 'Cartographe d’essai', kind: 'explore' });
    assert.equal(carto.status, 201, carto.text);
    s.cartographe = carto.body.id;
    d.prepare(`INSERT INTO agent_knowledge (agent_id, version, md_path, status, created_at)
      VALUES (?, 1, 'inexistant.md', 'pending', ?)`).run(carto.body.id, now);

    // L'activité d'hier : un merge (les ouvertures, la découverte vient de les écrire).
    d.prepare("INSERT INTO feed (type, mr_iid, project, title, at) VALUES ('mr_merged', 12, 'grp/app', 'x', ?)").run(now);

    // Un rappel échu, une todo haute sans échéance.
    s.rappel = (await app.api('POST', '/api/todos', { title: 'Relancer le support', due_at: ilYA(0.1) })).body.id;
    s.haute = (await app.api('POST', '/api/todos', { title: 'Préparer la mise en prod', priority: 'high' })).body.id;
  }

  test('sans rien à dire, le brief salue, date, et le dit', async () => {
    await allerBrief();
    assert.equal(await page.locator('#briefBox .brief-hello').innerText(), 'Bonjour');
    assert.match(await page.locator('#briefBox .brief-date').innerText(), /\d{4}/);
    assert.match(await page.locator('#briefBox').innerText(), /Rien ne réclame ton attention/);
    assert.equal(await page.locator('#briefBox .brief-sec').count(), 0, 'aucune section vide n’est rendue');
    // Le daily d'un matin calme se copie aussi.
    await page.locator('#briefCopy').click();
    await page.waitForFunction(() => window.__copies.length === 1);
    assert.equal(await page.evaluate(() => window.__copies[0]), 'Rien ne réclame ton attention');
  });

  test('plein, le brief range chaque chose sous son titre', async () => {
    await peupler();
    await allerBrief();
    await page.waitForFunction(() => document.querySelectorAll('#briefBox .brief-sec').length >= 12);
    // textContent et non innerText : les titres sont mis en capitales par la feuille de style.
    const titres = await page.locator('#briefBox .brief-sec h3').allTextContents();
    for (const t of ['Rappels', 'Todos du jour', 'Sessions en attente de réponse', 'Vérifications en échec',
      'Remarques jamais envoyées', 'Suivis jamais envoyés', 'Sessions de dev en attente', 'Git en suspens',
      'MR à traiter', 'MR dormantes', 'Prêtes à merger', 'Activité depuis hier']) {
      assert.ok(titres.some((x) => x.trim() === t), `section « ${t} » absente : ${titres.join(' | ')}`);
    }
    assert.ok(titres.some((x) => /agent/i.test(x)), `la section des agents : ${titres.join(' | ')}`);
    // Et ce qu'elles disent.
    assert.match(await section('Vérifications en échec').innerText(), /2 tests cassés/);
    assert.match(await section('Vérifications en échec').innerText(), /panier\.total/);
    assert.match(await section('Remarques jamais envoyées').innerText(), /2 commentaires en attente/);
    assert.match(await section('Sessions de dev en attente').innerText(), /1 session jamais lancée/);
    assert.match(await section('Sessions de dev en attente').innerText(), /1 projet commité, pas encore poussé/);
    assert.match(await section('Sessions de dev en attente').innerText(), /1 branche poussée sans merge request/);
    assert.match(await section('MR dormantes').innerText(), /reviewée il y a 10 jours/);
    assert.match(await section('Prêtes à merger').innerText(), /1 merge request ne demande plus rien/);
    assert.match(await section('Activité depuis hier').innerText(), /1 MR mergée · 4 nouvelles · 2 vérifications/);
    assert.match(await section('Git en suspens').innerText(), /main → release\/2\.0/);
    assert.match(await section('Git en suspens').innerText(), /1 opération en échec — old\/feature/);
  });

  test('« Copier pour le daily » met le résumé du brief dans le presse-papiers', async () => {
    await allerBrief();
    const avant = await page.evaluate(() => window.__copies.length);
    await page.locator('#briefCopy').click();
    await page.waitForFunction((n) => window.__copies.length === n + 1, avant);
    const texte = await page.evaluate(() => window.__copies.at(-1));
    assert.match(texte, /Activité depuis hier : .*1 MR mergée/);
    assert.match(texte, /MR à traiter : 1/);
    assert.match(texte, /MR dormantes : 1/);
    assert.match(texte, /Prêtes à merger : 1/);
    assert.match(texte, /Sessions de dev en attente : 3/);
    assert.match(texte, /Vérifications en échec : 1/);
    await page.locator('.toast', { hasText: 'Brief copié.' }).first().waitFor();
  });

  test('un rappel se reporte d’une heure, sans quitter le brief', async () => {
    await allerBrief();
    const ligne = section('Rappels').locator(`.todo-row[data-todo="${s.rappel}"]`);
    await ligne.locator('[data-snooze="hour"]').click();
    await attendreServeur(async () => {
      const t = (await app.api('GET', '/api/todos?status=open')).body.todos.find((x) => x.id === s.rappel);
      return t && new Date(t.due_at).getTime() > Date.now() + 50 * 60e3;
    }, 'l’échéance est repoussée d’une heure');
    await page.locator('.toast', { hasText: 'Rappel repoussé.' }).first().waitFor();
    assert.equal(await page.locator('#tab-notes').isVisible(), true, 'on reste sur le brief');
  });

  test('cocher une todo du jour dans le brief la fait, et elle quitte le brief', async () => {
    await allerBrief();
    const ligne = () => section('Todos du jour').locator(`.todo-row[data-todo="${s.haute}"]`);
    await ligne().waitFor();
    // `click()` : la ligne disparaît au succès, `check()` voudrait la relire.
    await ligne().locator('.todo-check').click();
    await attendreServeur(async () => {
      const t = (await app.api('GET', '/api/todos?status=done')).body.todos.find((x) => x.id === s.haute);
      return Boolean(t);
    }, 'la todo est faite côté serveur');
    await page.waitForFunction((tid) => !document.querySelector(`#briefBox .todo-row[data-todo="${tid}"]`), s.haute);
  });

  test('écarter une session, une vérification et une attente, puis tout réafficher', async () => {
    await allerBrief();
    for (const cle of [`session:${s.question}`, `verification:${s.verif}`, 'sess:to_run']) {
      await page.locator(`#briefBox [data-brief-hide="${cle}"]`).click();
      await page.waitForFunction((c) => !document.querySelector(`#briefBox [data-brief-hide="${c}"]`), cle);
    }
    const b = await brief();
    assert.equal(b.hidden_count, 3);
    assert.ok(!b.sessions.some((x) => x.task_id === s.question), 'la session n’est plus servie');
    assert.ok(!b.verifications.some((x) => x.verification_id === s.verif));
    assert.equal(b.pending_sessions.to_run, 0);
    await page.waitForFunction(() => /3 éléments écartés du brief/.test(document.querySelector('#briefBox').textContent));

    await page.locator('#briefRestore').click();
    await attendreServeur(async () => (await brief()).hidden_count === 0, 'plus rien d’écarté');
    await page.waitForSelector(`#briefBox [data-brief-hide="session:${s.question}"]`);
    assert.equal(await page.locator('#briefRestore').count(), 0);
  });

  test('« Répondre » mène à la session arrêtée sur sa question', async () => {
    await allerBrief();
    await section('Sessions en attente de réponse').locator(`[data-brief-session="${s.question}"]`).click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((t) => window.location.hash === `#/sessions/code/${t}`, s.question);
    await page.locator(`#taskList .task-row[data-task="${s.question}"]`).waitFor();
  });

  test('un suivi jamais envoyé mène à sa session', async () => {
    await allerBrief();
    assert.match(await section('Suivis jamais envoyés').innerText(), /Ajoute aussi les tests du cache/);
    await section('Suivis jamais envoyés').locator(`[data-brief-session="${s.suivi}"]`).click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((t) => window.location.hash === `#/sessions/code/${t}`, s.suivi);
  });

  test('« Voir le rapport » ouvre la vérification rouge', async () => {
    await allerBrief();
    await page.locator(`#briefBox [data-brief-verif="${s.verif}"]`).click();
    await page.waitForSelector('#verifyModal:not([hidden])');
    await page.waitForSelector('#verifyFix:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#verifyModal', { state: 'hidden' });
  });

  test('« Corriger » depuis le brief crée la session de correction et mène à Dev IA', async () => {
    const avant = app.db.prepare('SELECT COUNT(*) c FROM task').get().c;
    await allerBrief();
    await page.locator(`#briefBox [data-brief-verif-fix="${s.verif}"]`).click();
    await attendreServeur(async () => app.db.prepare('SELECT COUNT(*) c FROM task').get().c === avant + 1,
      'une session de correction est créée');
    const t = app.db.prepare('SELECT * FROM task ORDER BY id DESC LIMIT 1').get();
    assert.equal(t.status, 'new', 'préparée, pas lancée');
    assert.match(t.prompt, /panier\.total/);
    await page.waitForSelector('#tab-task.active');
    await page.waitForSelector('#verifyModal', { state: 'hidden' });
  });

  test('« Les relire et les envoyer » ouvre le viewer de la MR aux remarques', async () => {
    await allerBrief();
    await page.locator(`#briefBox [data-brief-drafts="${id[34]}"]`).click();
    await page.waitForSelector('#splitView:not([hidden])');
    await page.waitForFunction((m) => window.location.hash === `#/reviews/${m}`, id[34]);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#splitView', { state: 'hidden' });
  });

  test('les trois attentes mènent à Dev IA, sur le codage', async () => {
    for (const cle of ['to_run', 'to_push', 'to_mr']) {
      await allerBrief();
      await page.locator(`#briefBox [data-brief-sess-go="${cle}"]`).click();
      await page.waitForSelector('#tab-task.active');
      await page.waitForSelector('#tab-task .subnav [data-kind="code"].active');
    }
    // La ligne elle-même mène aussi à Dev IA.
    await allerBrief();
    await page.locator('#briefBox [data-brief-sess="to_mr"] .brief-item-title').click();
    await page.waitForSelector('#tab-task.active');
  });

  test('« Reprendre » un merge mène à Git → Merge', async () => {
    await allerBrief();
    await section('Git en suspens').locator('[data-brief-merge]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForSelector('#gsub-merge.active');
  });

  test('« Voir l’historique » d’une opération en échec filtre l’historique git', async () => {
    await allerBrief();
    await section('Git en suspens').locator('[data-brief-gitop="grp/app"]').click();
    await page.waitForSelector('#tab-git.active');
    await page.waitForSelector('#gsub-history.active');
    assert.equal(await page.locator('#gitHistFilter').inputValue(), 'grp/app');
    assert.equal(await page.locator('#gitHistErrOnly').isChecked(), true, 'les seuls échecs');
  });

  test('la page écrite par un agent s’ouvre depuis le brief', async () => {
    await allerBrief();
    await page.locator(`#briefBox [data-brief-agent-page="${s.pageAgent}"]`).click();
    await page.waitForSelector('#notesSubPages:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#pageTitle') && (document.querySelector('#pageTitle') || {}).value === 'Carte des services');
  });

  test('une connaissance à valider ouvre la fenêtre de relecture de l’agent', async () => {
    await allerBrief();
    await page.locator(`#briefBox [data-brief-agent-review="${s.cartographe}"]`).click();
    await page.waitForSelector('#tab-agents.active');
    await page.waitForSelector('#knowledgeModal:not([hidden])');
    assert.match(await page.locator('#knowledgeTitle').innerText(), /Cartographe d’essai/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#knowledgeModal', { state: 'hidden' });
  });

  test('une MR du brief (fraîche ou dormante) s’ouvre sur son rapport', async () => {
    for (const iid of [32, 31]) {
      await allerBrief();
      await page.locator(`#briefBox [data-brief-mr="${id[iid]}"] .brief-item-title`).first().click();
      await page.waitForSelector('#tab-review.active');
      await page.waitForFunction((m) => window.location.hash === `#/reviews/${m}`, id[iid]);
    }
  });

  test('une MR fraîche se reviewe depuis le brief, sans le quitter', async () => {
    await allerBrief();
    await page.locator(`#briefBox [data-brief-review="${id[31]}"]`).first().click();
    await attendreServeur(async () => (await app.api('GET', `/api/mrs/${id[31]}`)).body.review != null,
      'la review de !31 est faite', 60000);
    await waitForJobs(app.api);
    assert.equal(await page.locator('#tab-notes').isVisible(), true, 'le bouton ne fait pas changer d’écran');
  });

  test('« Les voir » mène aux MR reviewées', async () => {
    await allerBrief();
    await page.locator('#briefBox [data-brief-pretes]').click();
    await page.waitForSelector('#tab-review.active');
    await page.waitForSelector('[data-seg="reviewed"].active');
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
