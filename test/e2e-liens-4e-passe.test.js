'use strict';
/* LES LIENS MANQUANTS DE LA 4ᵉ PASSE (axe B).
 *
 * Ce ne sont pas des écrans : ce sont des JOINTURES qui n'étaient pas faites. La donnée existait
 * des deux côtés — une note cite `!217`, une carte de domaine cite des chemins, un dépôt porte
 * des vérificateurs — et personne ne faisait le produit. Un lien de ce genre se défait sans
 * bruit : il suffit qu'une colonne change de nom pour que la liste redevienne vide, et une
 * liste vide ne réveille personne. D'où ce fichier.
 *
 * On teste ce qui SE VÉRIFIE : ce que le serveur sert, et la règle de croisement. Le reste
 * (un badge, un panneau dépliant) se voit à l'œil.
 *
 * `src/` NE SE CHARGE QU'APRÈS `startApp()` — voir le commentaire de `e2e-veille.test.js` :
 * un require en tête de fichier viserait la base de production.
 *
 * Un seul `startApp()` pour tout le fichier.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

describe('Les liens manquants · 4ᵉ passe', () => {
  let app;
  let repoId;

  before(async () => {
    app = await startApp();
    await app.configure();
    repoId = app.db.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/liens','http://l',datetime('now'))")
      .run().lastInsertRowid;
  });
  after(async () => { if (app) await app.stop(); });

  /* B4 — L'AUTOLIEN, DANS L'AUTRE SENS. Une note mène à la merge request depuis toujours ;
     la merge request ignorait qu'on avait écrit trois paragraphes sur elle. Le piège est le
     faux positif : `a!=218` n'est pas une citation, et une liste qui en contient se vérifie
     à la main — c'est-à-dire ne sert à rien. */
  test('le rapport dit quelles notes citent cette merge request, sans faux positif', async () => {
    const d = app.db;
    const mrId = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?, 217, 'Tunnel', 'f/217', 'main', 'to_review', datetime('now'))`).run(repoId).lastInsertRowid;
    const autre = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?, 218, 'Autre', 'f/218', 'main', 'to_review', datetime('now'))`).run(repoId).lastInsertRowid;
    await app.api('POST', '/api/notes', { title: 'Réunion', content: 'On a parlé de !217 hier. a!=218 reste vrai.' });

    const cites = (await app.api('GET', `/api/mrs/${mrId}`)).body.citations;
    assert.equal(cites.length, 1, 'la note qui parle de !217');
    assert.equal(cites[0].title, 'Réunion');
    assert.match(cites[0].excerpt, /!217/, 'l’extrait est pris AUTOUR de la citation');
    assert.deepEqual((await app.api('GET', `/api/mrs/${autre}`)).body.citations, [],
      '« a!=218 » est une comparaison, pas une citation');
    /* La route autonome sert aussi le ticket — et elle est déclarée AVANT `/api/notes/:id`,
       sans quoi Express prendrait « citations » pour un identifiant de page. */
    const parTicket = await app.api('GET', '/api/notes/citations?ticket=PROJ-1');
    assert.equal(parTicket.status, 200, parTicket.text);
  });

  /* B7 — LA CARTE DU DOMAINE TOUCHÉ. Le produit des chemins du diff par ceux que la carte
     cite : un dossier cité par la carte couvre les fichiers qu'il contient (c'est ainsi qu'on
     décrit un domaine), et une carte d'un AUTRE dépôt ne s'invite pas. */
  test('une merge request annonce les cartes de domaine qu’elle touche', async () => {
    const d = app.db;
    const agentId = d.prepare(`INSERT INTO agent (name, kind, scope_kind, created_at, updated_at)
      VALUES ('Notifications', 'explore', 'all_repos', datetime('now'), datetime('now'))`).run().lastInsertRowid;
    d.prepare(`INSERT INTO agent_knowledge (agent_id, version, status, md_path, repos_json, created_at)
      VALUES (?, 1, 'active', '/tmp/k.md', ?, datetime('now'))`)
      .run(agentId, JSON.stringify([{ repo_id: repoId, project: 'grp/liens', paths: ['src/notifications/'] }]));

    const touche = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, changed_paths, updated_at)
      VALUES (?, 300, 'Push', 'f/300', 'main', 'to_review', ?, datetime('now'))`)
      .run(repoId, 'src/notifications/push.js\nREADME.md').lastInsertRowid;
    const ailleurs = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, changed_paths, updated_at)
      VALUES (?, 301, 'Doc', 'f/301', 'main', 'to_review', ?, datetime('now'))`)
      .run(repoId, 'README.md').lastInsertRowid;

    const liste = (await app.api('GET', '/api/mrs')).body;
    const a = liste.find((m) => m.id === touche);
    const b = liste.find((m) => m.id === ailleurs);
    assert.deepEqual((a.cards || []).map((c) => c.name), ['Notifications'],
      'un dossier cité par la carte couvre les fichiers qu’il contient');
    assert.deepEqual(b.cards || [], [], 'un README ne touche pas le domaine');
    // …et le rapport le dit aussi : c'est là qu'on décide de merger.
    assert.deepEqual(((await app.api('GET', `/api/mrs/${touche}`)).body.cards || []).map((c) => c.name), ['Notifications']);
  });

  /* B12 — UN VERDICT ROUGE SURVIT À SA NOTIFICATION. Une par merge request, pas une par
     vérification : relancer trois fois ne doit pas empiler trois lignes. Et un vert referme. */
  test('une vérification rouge laisse une todo, un vert la referme', async () => {
    const d = app.db;
    /* eslint-disable global-require */
    const verifyrun = require('../src/verifyrun');
    /* eslint-enable global-require */
    const mrId = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?, 400, 'Rouge', 'f/400', 'main', 'reviewed', datetime('now'))`).run(repoId).lastInsertRowid;
    const cibles = JSON.stringify([{ repo_id: repoId, mr_id: mrId, head_sha: 'sha1' }]);
    const verifId = d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, created_at)
      VALUES ('V', 'done', 'verified_fail', ?, datetime('now'))`).run(cibles).lastInsertRowid;

    verifyrun.todosDuVerdict(verifId, 'verified_fail');
    verifyrun.todosDuVerdict(verifId, 'verified_fail');   // deuxième passage : même ligne
    const ouvertes = () => d.prepare("SELECT * FROM todo WHERE auto_kind = 'verify_fail' AND auto_ref = ? AND status = 'open'").all(`mr:${mrId}`);
    assert.equal(ouvertes().length, 1, 'une todo par merge request, pas par vérification');
    assert.match(ouvertes()[0].title, /400/, 'elle nomme la merge request');

    verifyrun.todosDuVerdict(verifId, 'verified_pass');
    assert.equal(ouvertes().length, 0, 'le vert la coche');
    assert.equal(d.prepare("SELECT COUNT(*) c FROM todo WHERE auto_kind = 'verify_fail' AND status = 'done'").get().c, 1,
      'cochée, jamais supprimée');
  });

  /* B10 — LE VERDICT REMONTE VERS JIRA, mais seulement si on l'a demandé. Décoché = rien,
     même sur un rouge : écrire chez la QA ne se décide pas à la place de l'utilisateur. */
  test('le commentaire Jira d’un verdict est opt-in', async () => {
    /* eslint-disable global-require */
    const verifyrun = require('../src/verifyrun');
    /* eslint-enable global-require */
    const d = app.db;
    const mrId = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, ticket_jira_key, updated_at)
      VALUES (?, 401, 'Rouge', 'f/401', 'main', 'reviewed', 'PROJ-9', datetime('now'))`).run(repoId).lastInsertRowid;
    const verifId = d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, base_run_json, head_run_json, created_at)
      VALUES ('V', 'done', 'verified_fail', ?, ?, ?, datetime('now'))`)
      .run(JSON.stringify([{ repo_id: repoId, mr_id: mrId, head_sha: 'sha1' }]),
        JSON.stringify({ failed: [] }), JSON.stringify({ failed: [{ test: 'a' }] })).lastInsertRowid;

    assert.deepEqual(await verifyrun.commenterSurJira(verifId, { verify_jira_comment: '0' }, null), [],
      'case décochée : rien n’est écrit chez personne');
  });

  /* B13 — LA PALETTE AGIT. Quatre objets du quotidien y sont entrés ; ce qui se casse en
     silence, c'est le `nav` qu'ils portent — sans lui, le résultat s'affiche et ne fait rien. */
  test('la palette propose un vérificateur, un job Jenkins et une commande git, chacun avec son geste', async () => {
    const d = app.db;
    d.prepare("INSERT INTO verifier (name, command, kind, created_at) VALUES ('Tests liens','','commands',datetime('now'))").run();
    d.prepare('INSERT INTO repo_jenkins (repo_id, job_path) VALUES (?,?)').run(repoId, 'equipe/liens-deploy');

    const cherche = async (q) => (await app.api('POST', '/api/launcher', { q })).body.results;
    const v = (await cherche('Tests liens')).find((r) => r.kind === 'verifier');
    assert.ok(v && v.nav && v.nav.verifier_id, `le vérificateur porte son geste : ${JSON.stringify(v)}`);
    const j = (await cherche('liens-deploy')).find((r) => r.kind === 'jenkins');
    assert.equal(j && j.nav.jenkins_path, 'equipe/liens-deploy');
    const g = (await cherche('fetch')).find((r) => r.kind === 'gitcmd');
    assert.ok(g && /fetch/.test(g.nav.git_command), 'la commande git est posée telle quelle');
  });

  /* …et la merge request se retrouve par sa CLÉ DE TICKET, comme la moitié d'une équipe la
     désigne. La colonne était remplie depuis longtemps et la palette ne la lisait pas. */
  test('la palette retrouve une merge request par sa clé de ticket', async () => {
    app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, ticket_jira_key, updated_at)
      VALUES (?, 500, 'Sans clé dans le titre', 'f/500', 'main', 'to_review', 'ZZZ-4242', datetime('now'))`).run(repoId);
    const res = (await app.api('POST', '/api/launcher', { q: 'ZZZ-4242' })).body.results;
    assert.ok(res.some((r) => r.kind === 'mr' && r.nav && r.nav.mr_iid === 500),
      `la MR portant ZZZ-4242 : ${res.map((r) => r.kind).join(', ')}`);
  });

  /* B16 — UNE TODO S'ACCROCHE AUX QUATRE NOUVEAUX OBJETS. Le `CHECK` de la table et la liste
     du module doivent dire la même chose : ce que l'un accepte et que l'autre refuse sort en
     erreur SQLite brute à l'écran. */
  test('une todo se lie à une branche, une vérification, un build, un conteneur', async () => {
    for (const [kind, ref] of [['branch', `${repoId}:feature/x`], ['verification', '12'],
      ['build', 'equipe/deploy#42'], ['container', 'api-core']]) {
      const r = await app.api('POST', '/api/todos', { title: `todo ${kind}`, link_kind: kind, link_ref: ref });
      assert.equal(r.status, 200, `${kind} refusé : ${r.text}`);
      assert.equal(r.body.link_kind, kind);
      assert.equal(r.body.link_ref, ref);
    }
    const r = await app.api('POST', '/api/todos', { title: 'x', link_kind: 'inconnu', link_ref: '1' });
    assert.equal(r.status, 400, 'un type inventé reste refusé');
  });

  /* TOP 15 — LA LIGNE D'UNE BRANCHE PORTE CE QUE LA BASE SAIT D'ELLE : son ticket, le dernier
     verdict, et le job Jenkins du dépôt. Le bouton Jenkins n'existait que sur une merge request
     vérifiée verte — une branche qu'on veut déployer en recette AVANT d'en faire une merge
     request n'y avait pas droit. On teste l'ANNOTATION, pas la forge : la route complète parle
     à GitLab, la fonction qui annote se suffit à elle-même. */
  test('une branche porte son ticket, son verdict et le job Jenkins de son dépôt', async () => {
    const d = app.db;
    d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, ticket_jira_key, ticket_jira_status, updated_at)
      VALUES (?, 600, 'Tunnel', 'feat/PROJ-77-tunnel', 'main', 'to_review', 'PROJ-77', 'En cours', datetime('now'))`).run(repoId);
    d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, finished_at, created_at)
      VALUES ('V', 'done', 'verified_fail', ?, datetime('now'), datetime('now'))`)
      .run(JSON.stringify([{ repo_id: repoId, branch: 'feat/PROJ-77-tunnel' }]));

    const lignes = [{ name: 'feat/PROJ-77-tunnel' }, { name: 'main', default: true }];
    /* eslint-disable global-require */
    require('../src/server').nommerBranches(repoId, lignes);
    /* eslint-enable global-require */
    const br = lignes[0];
    assert.equal(br.ticket && br.ticket.key, 'PROJ-77');
    assert.equal(br.ticket.status, 'En cours');
    assert.equal(br.verification && br.verification.verdict, 'verified_fail');
    assert.deepEqual((br.jenkins || []).map((j) => j.path), ['equipe/liens-deploy']);
    assert.equal(lignes[1].jenkins, undefined, 'pas de déploiement proposé depuis la branche par défaut');
  });

  /* A7 — LES CONSTATS DEVIENNENT DES BROUILLONS INLINE. Trois règles, et chacune se casse en
     silence : un constat sans ligne n'a pas d'endroit où s'accrocher, un résolu n'a plus rien
     à dire, et cliquer deux fois ne doit pas doubler les remarques. */
  test('les constats se mettent en brouillons, sans doublon ni constat sans ligne', async () => {
    const d = app.db;
    const mrId = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?, 700, 'Constats', 'f/700', 'main', 'reviewed', datetime('now'))`).run(repoId).lastInsertRowid;
    /* LE DIFF DE LA REVIEW EST LA RÉFÉRENCE : une remarque inline s'accroche au diff, pas au
       fichier. `src/a.js` a une ligne 12 AJOUTÉE, `src/b.js` une ligne 40 de CONTEXTE (dans le
       hunk, inchangée — la forge veut alors les deux numéros), et `src/hors.js` n'est pas
       touché du tout. */
    const patch = [
      'diff --git a/src/a.js b/src/a.js',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -10,2 +10,3 @@',
      ' const a = 1;',
      ' const b = 2;',
      '+const motDePasse = lire();',
      'diff --git a/src/b.js b/src/b.js',
      '--- a/src/b.js',
      '+++ b/src/b.js',
      '@@ -38,3 +38,4 @@',
      ' ligne 38',
      '+ajout 39',
      ' ligne 40 inchangée',
      ' ligne 41',
      '',
    ].join('\n');
    const chemin = require('node:path').join(app.dataDir, 'diff-700.patch');
    require('node:fs').writeFileSync(chemin, patch);
    d.prepare("INSERT INTO review (mr_id, md_path, diff_path, note_value, created_at, updated_at) VALUES (?,'/tmp/r.md',?,0.8,datetime('now'),datetime('now'))")
      .run(mrId, chemin);
    const f = d.prepare(`INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?)`);
    f.run(mrId, 'fp1', 'src/a.js', 12, 'blocker', 'Le mot de passe est loggé', 'new');
    f.run(mrId, 'fp2', 'src/b.js', 40, 'minor', 'Nom de variable obscur', 'persistent');
    f.run(mrId, 'fp3', 'src/c.js', null, 'major', 'Sans ligne', 'new');
    f.run(mrId, 'fp4', 'src/d.js', 3, 'major', 'Déjà corrigé', 'resolved');
    f.run(mrId, 'fp5', 'src/hors.js', 900, 'major', 'Hors du diff', 'new');

    const r1 = (await app.api('POST', `/api/mrs/${mrId}/comment-drafts/from-findings`, {})).body;
    assert.equal(r1.created, 2, 'les deux constats qui tombent DANS le diff');
    assert.equal(r1.skipped_no_position, 1, 'celui sans ligne est laissé de côté, et on le dit');
    /* LE DÉFAUT QUI A MOTIVÉ CE TEST : un constat peut citer une ligne que la branche n'a pas
       touchée — c'est même fréquent, et légitime pour un rapport. En faire une remarque inline
       ne l'est pas : la forge refuse la position, et l'écran affichait la remarque collée à une
       ligne que personne n'a modifiée. */
    assert.equal(r1.skipped_outside_diff, 1, 'le constat hors du diff n’est PAS posé');

    const r2 = (await app.api('POST', `/api/mrs/${mrId}/comment-drafts/from-findings`, {})).body;
    assert.equal(r2.created, 0, 'deux clics ne doublent pas les remarques');
    assert.equal(r2.skipped_existing, 2);

    const drafts = (await app.api('GET', `/api/mrs/${mrId}/comment-drafts`)).body.drafts;
    assert.equal(drafts.length, 2);
    const bloquant = drafts.find((x) => x.new_path === 'src/a.js');
    assert.equal(bloquant.new_line, 12, 'la remarque s’accroche à la ligne du constat');
    assert.equal(bloquant.old_line, null, 'ligne AJOUTÉE : `new_line` seul');
    assert.match(bloquant.body, /mot de passe/, '…et porte le constat');
    const contexte = drafts.find((x) => x.new_path === 'src/b.js');
    assert.equal(contexte.new_line, 40);
    assert.equal(contexte.old_line, 39, 'ligne de CONTEXTE : les deux numéros, sinon la forge refuse');
    assert.equal(contexte.old_path, 'src/b.js', '…et le chemin d’origine, qui va avec');
    assert.ok(!drafts.some((x) => x.new_path === 'src/hors.js'));

    /* LA SORTIE DE SECOURS. Une remarque dont on ne veut plus — ou que la forge refuse — bloque
       l'envoi groupé, et se retirait une par une en rouvrant chaque fichier. */
    const vide = await app.api('DELETE', `/api/mrs/${mrId}/comment-drafts`);
    assert.equal(vide.body.deleted, 2, 'le nombre supprimé est rendu : l’écran le dit après, et demande avant');
    assert.deepEqual((await app.api('GET', `/api/mrs/${mrId}/comment-drafts`)).body.drafts, []);
    // …et sur une merge request sans brouillon, elle ne se plaint pas : il n'y a rien à vider.
    assert.equal((await app.api('DELETE', `/api/mrs/${mrId}/comment-drafts`)).body.deleted, 0);

    // « Les bloquants » ne prend que ceux-là.
    const r3 = (await app.api('POST', `/api/mrs/${mrId}/comment-drafts/from-findings`, { blocking_only: true })).body;
    assert.equal(r3.created, 1);
  });

  /* A14 — « REVIEWER » PORTE SUR CE QUI EST DÉSIGNÉ, pas sur la file entière : on cherchait
     « paiement », on cliquait, et trente-sept reviews sans rapport partaient avec. */
  test('reviewer une sélection ne lance que la sélection', async () => {
    const d = app.db;
    const ids = [801, 802, 803].map((iid) => d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?, ?, ?, ?, 'main', 'to_review', datetime('now'))`).run(repoId, iid, `T${iid}`, `f/${iid}`).lastInsertRowid);

    const job = (await app.api('POST', '/api/jobs/review', { mr_ids: ids.slice(0, 2) })).body;
    assert.equal(job.total, 2, 'deux merge requests désignées, deux à traiter');

    /* Une liste envoyée par un client ne décide pas de l'état des merge requests : ce qui
       n'est plus « à reviewer » est écarté, et une sélection entièrement périmée est refusée
       plutôt que silencieusement transformée en « toute la file ». */
    d.prepare("UPDATE mr SET status = 'done' WHERE id IN (?,?)").run(ids[0], ids[1]);
    const r = await app.api('POST', '/api/jobs/review', { mr_ids: ids.slice(0, 2) });
    assert.equal(r.status, 400, r.text);
  });

  /* A18 — « ESSAI » ESSAIE VRAIMENT LE PROFIL : la session part avec le modèle, les outils et
     les sous-agents du formulaire, sans qu'aucun agent soit créé. Ce qui se casse en silence,
     c'est le chemin des OPTIONS — un brouillon accepté mais ignoré ferait un essai qui ne
     prouve rien. */
  test('un profil essayé part avec ses options, sans créer d’agent', async () => {
    const d = app.db;
    const avant = d.prepare('SELECT COUNT(*) c FROM agent').get().c;
    const r = await app.api('POST', '/api/tasks', {
      kind: 'explore',
      prompt: 'Où sont émises les notifications ?',
      targets: [{ repo_id: repoId }],
      agent_draft: { name: 'Profil d’essai', kind: 'explore', max_turns: 12, model: 'sonnet' },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(d.prepare('SELECT COUNT(*) c FROM agent').get().c, avant, 'essayer ne laisse pas un agent derrière');
    assert.equal(r.body.agent_name, 'Profil d’essai', 'l’écran doit pouvoir dire ce qu’on essaie');

    /* eslint-disable global-require */
    const agentprofile = require('../src/agentprofile');
    /* eslint-enable global-require */
    const opts = agentprofile.optionsFor(d.prepare('SELECT * FROM task WHERE id = ?').get(r.body.id));
    assert.equal(opts.model, 'sonnet', 'le modèle du brouillon part avec la session');
    assert.equal(opts.maxTurns, 12);
    assert.match(opts.appendSystemPrompt, /Profil d’essai/);

    // Ce qui échouerait au lancement échoue ICI, pas trois minutes plus tard dans un journal.
    const ko = await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'x', targets: [{ repo_id: repoId }],
      agent_draft: { name: 'Mauvais', permission_mode: 'default' },
    });
    assert.equal(ko.status, 400, ko.text);
  });

  /* A26 — UN TEST INSTABLE se dénonce tout seul : rouge à un run, vert au suivant, sur le MÊME
     code. Deux runs au moins — un seul ne prouve rien, et le dire ferait douter d'un test qui
     n'a jamais menti. */
  test('un test rouge puis vert sur le même code est signalé instable', async () => {
    const d = app.db;
    /* eslint-disable global-require */
    const verifyrun = require('../src/verifyrun');
    /* eslint-enable global-require */
    const vId = d.prepare("INSERT INTO verifier (name, command, kind, created_at) VALUES ('V instable','','commands',datetime('now'))").run().lastInsertRowid;
    const cibles = JSON.stringify([{ repo_id: repoId, branch: 'main', head_sha: 'sha-stable-1' }]);
    const creer = () => d.prepare(`INSERT INTO verification (verifier_id, verifier_name, status, targets_json, created_at)
      VALUES (?, 'V', 'done', ?, datetime('now'))`).run(vId, cibles).lastInsertRowid;

    const v1 = creer();
    verifyrun.noterTestsDuRun(v1, { detail_source: 'tap', failed: [{ test: 'paiement › 3×' }, { test: 'toujours cassé' }] });
    assert.deepEqual(verifyrun.testsInstables(v1), [], 'un seul run : on ne conclut rien');

    const v2 = creer();
    verifyrun.noterTestsDuRun(v2, { detail_source: 'tap', failed: [{ test: 'toujours cassé' }] });
    const inst = verifyrun.testsInstables(v2);
    assert.deepEqual(inst.map((x) => x.test), ['paiement › 3×'],
      'celui qui a été vert une fois sur ce code est instable ; celui qui casse toujours ne l’est pas');
    assert.equal(inst[0].runs, 2);

    // Un code DIFFÉRENT ne se compare pas : deux SHAs, deux histoires.
    const autre = d.prepare(`INSERT INTO verification (verifier_id, verifier_name, status, targets_json, created_at)
      VALUES (?, 'V', 'done', ?, datetime('now'))`)
      .run(vId, JSON.stringify([{ repo_id: repoId, branch: 'main', head_sha: 'sha-autre' }])).lastInsertRowid;
    verifyrun.noterTestsDuRun(autre, { detail_source: 'tap', failed: [{ test: 'paiement › 3×' }] });
    assert.deepEqual(verifyrun.testsInstables(autre), []);
  });

  /* A25 — LA DURÉE D'UN TEST, quand la sortie la donne : elle était jetée avec le commentaire. */
  test('les tests les plus lents sortent du TAP et du JUnit', () => {
    /* eslint-disable global-require */
    const verify = require('../src/verify');
    /* eslint-enable global-require */
    const tap = verify.parserTap('TAP version 13\nok 1 - rapide # time=3.20ms\nok 2 - lent # time=1200.50ms\nnot ok 3 - cassé\n1..3\n');
    assert.deepEqual(tap.slowest.map((x) => x.test), ['lent', 'rapide'], 'les plus lents d’abord');
    assert.equal(tap.slowest[0].ms, 1200.5);
    assert.equal(tap.tests.length, 1, 'la durée ne change pas le NOM d’un test — sinon le delta n’apparie plus rien');
    assert.equal(tap.tests[0].test, 'cassé');

    const ju = verify.parserJUnit('<testsuite><testcase classname="A" name="vite" time="0.01"/><testcase classname="A" name="lent" time="2.5"/></testsuite>');
    assert.deepEqual(ju.slowest.map((x) => `${x.test} ${x.ms}`), ['A › lent 2500', 'A › vite 10'],
      'JUnit compte en secondes : on rend des millisecondes');
  });

  /* A31 — UN MERGE SE SOUVIENT DE CE QU'IL RATTRAPE. On arrive sur cet écran depuis le badge
     « en conflit » d'une merge request, et plus rien n'y disait de laquelle il s'agissait. La
     jointure se fait sur la branche : le merge rattrape la base DANS la branche de la MR. */
  test('un merge en cours nomme la merge request qu’il rattrape', async () => {
    const d = app.db;
    const mrId = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, ticket_jira_key, updated_at)
      VALUES (?, 900, 'Rattrapage', 'feat/PROJ-900', 'main', 'reviewed', 'PROJ-900', datetime('now'))`).run(repoId).lastInsertRowid;
    d.prepare("INSERT INTO review (mr_id, md_path, note_value, created_at, updated_at) VALUES (?,'/tmp/x.md',0.83,datetime('now'),datetime('now'))").run(mrId);
    d.prepare(`INSERT INTO git_merge (repo_id, source_branch, target_branch, dir, status, created_at, updated_at)
      VALUES (?, 'main', 'feat/PROJ-900', '/tmp/w900', 'conflict', datetime('now'), datetime('now'))`).run(repoId);

    const ligne = (await app.api('GET', '/api/git/merges')).body.find((m) => m.target_branch === 'feat/PROJ-900');
    assert.ok(ligne.mr, 'le merge nomme sa merge request');
    assert.equal(ligne.mr.iid, 900);
    assert.equal(ligne.mr.note, 8.3, '…avec sa note, sur 10');
    assert.equal(ligne.mr.ticket, 'PROJ-900');

    // Une merge request FERMÉE ne rattrape plus rien : on ne la rappelle pas.
    d.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(mrId);
    const apres = (await app.api('GET', '/api/git/merges')).body.find((m) => m.target_branch === 'feat/PROJ-900');
    assert.equal(apres.mr, undefined);
  });

  /* A42 — « FAIRE FAIRE CETTE TODO » part de ce que la todo SAIT : son titre, sa note, et son
     lien. Le lien vit dans `link_ref` — le front lisait `link_id`, qui n'a jamais existé : la
     cible était donc silencieusement perdue, et la session s'ouvrait sans dépôt. On éprouve ici
     ce que le SERVEUR sert, qui est la seule chose sur laquelle l'écran peut compter. */
  test('une todo sert son lien sous le nom que l’écran lit', async () => {
    const r = await app.api('POST', '/api/todos', { title: 'Rebaser avant lundi', link_kind: 'repo', link_ref: String(repoId) });
    assert.equal(r.status, 200, r.text);
    const t = (await app.api('GET', '/api/todos?status=open')).body.todos.find((x) => x.id === r.body.id);
    assert.equal(t.link_ref, String(repoId), 'la colonne est `link_ref`');
    assert.equal(t.link_id, undefined, '…et rien ne s’appelle `link_id`');
  });

  /* B17 — LA FICHE D'UN DÉPÔT : ce qui est ACCROCHÉ à lui, et que sa ligne taisait. */
  test('la fiche d’un dépôt liste ce qui lui est rattaché', async () => {
    const d = app.db;
    const vId = d.prepare("INSERT INTO verifier (name, command, kind, created_at) VALUES ('V fiche','','commands',datetime('now'))").run().lastInsertRowid;
    d.prepare("INSERT INTO verifier_repo (verifier_id, repo_id, mode, checkout_allowed) VALUES (?,?,'worktree',0)").run(vId, repoId);
    d.prepare("INSERT INTO review_rule (branch_match, content, enabled, repo_id, label, created_at) VALUES ('feat','règle',1,?,'Ma règle',datetime('now'))").run(repoId);
    const autreId = d.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/lie','http://x',datetime('now'))").run().lastInsertRowid;
    d.prepare('INSERT INTO repo_link (repo_id, linked_repo_id, branch) VALUES (?,?,?)').run(repoId, autreId, 'main');
    const agentId = d.prepare(`INSERT INTO agent (name, kind, scope_kind, created_at, updated_at)
      VALUES ('Agent fiche', 'explore', 'repos', datetime('now'), datetime('now'))`).run().lastInsertRowid;
    d.prepare("INSERT INTO agent_repo (agent_id, repo_id, role) VALUES (?,?,'readonly')").run(agentId, repoId);

    const f = (await app.api('GET', `/api/repos/${repoId}/sheet`)).body;
    assert.ok(f.verifiers.some((v) => v.name === 'V fiche'));
    assert.ok(f.jenkins.some((j) => j.job_path === 'equipe/liens-deploy'));
    assert.ok(f.rules.some((r) => r.label === 'Ma règle'), 'les règles LIMITÉES à ce dépôt');
    assert.ok(f.links.some((l) => l.project === 'grp/lie' && l.branch === 'main'));
    assert.ok(f.agents.some((a) => a.name === 'Agent fiche' && a.role === 'readonly'));
  });
});
