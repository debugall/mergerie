'use strict';
/* Notes, todos, rappels et brief — par de vraies requêtes HTTP.
 *
 * Ce que l'unitaire ne prouve pas : que les routes existent, qu'elles valident, que l'export
 * porte le bon en-tête, et surtout que le BRIEF compose ses sept sections à partir des mêmes
 * données que le reste de l'application (MR découvertes, sessions en attente, verdicts). Le
 * brief est la seule vue qui lit toutes les tables : c'est là qu'une régression se cache.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

/* UN SEUL démarrage pour tout le fichier : le harnais lance le serveur en processus, c'est
   un singleton — deux `startApp()` dans le même fichier se marchent dessus. */
let app;
before(async () => { app = await startApp(); await app.configure(); });
after(async () => { if (app) await app.stop(); });

const jours = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString();

describe('Pages de notes', () => {
  test('cycle complet : créer, écrire, épingler, rechercher, supprimer', async () => {
    const creee = await app.api('POST', '/api/notes', { title: 'Points à aborder au daily' });
    assert.equal(creee.status, 200);
    const id = creee.body.id;
    assert.equal(creee.body.content, '', 'une page naît vide, pas absente');

    // L'autosauvegarde n'envoie que ce qui a bougé : le reste ne doit pas être écrasé.
    const ecrite = await app.api('PUT', `/api/notes/${id}`, { content: '# Migration\n\nvoir !100' });
    assert.equal(ecrite.body.title, 'Points à aborder au daily', 'un PUT partiel ne perd pas le titre');
    assert.match(ecrite.body.content, /voir !100/);
    assert.notEqual(ecrite.body.updated_at, creee.body.updated_at, 'la date de modification suit');

    const seconde = await app.api('POST', '/api/notes', { title: 'Notes migration TypeORM' });
    await app.api('PUT', `/api/notes/${id}`, { pinned: 1 });
    const liste = await app.api('GET', '/api/notes');
    assert.equal(liste.body.pages[0].id, id, 'l’épinglée passe devant');
    assert.equal(liste.body.pages[0].content, undefined,
      'la liste ne charrie pas le contenu : vingt pages à chaque affichage de colonne');

    const cherche = await app.api('GET', '/api/notes?q=TypeORM');
    assert.equal(cherche.body.pages.length, 1);
    assert.equal(cherche.body.pages[0].id, seconde.body.id);

    assert.equal((await app.api('DELETE', `/api/notes/${seconde.body.id}`)).status, 200);
    assert.equal((await app.api('GET', `/api/notes/${seconde.body.id}`)).status, 404);
  });

  test('un titre vide est refusé, une page inconnue rend 404', async () => {
    assert.equal((await app.api('POST', '/api/notes', { title: '  ' })).status, 400);
    assert.equal((await app.api('GET', '/api/notes/999999')).status, 404);
    assert.equal((await app.api('PUT', '/api/notes/999999', { content: 'x' })).status, 404);
  });

  /* L'export doit être TÉLÉCHARGEABLE et nommé : un `.md` qui s'affiche dans l'onglet, ou
     qui s'appelle « download », ne remplace pas le fichier qu'on voulait emporter. */
  test('l’export rend un Markdown téléchargeable au nom slugifié', async () => {
    const p = await app.api('POST', '/api/notes', { title: 'Réunion / cadrage été 2026' });
    await app.api('PUT', `/api/notes/${p.body.id}`, { content: 'contenu de la page' });
    const res = await app.api('GET', `/api/notes/${p.body.id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/markdown/);
    assert.equal(res.headers.get('content-disposition'),
      'attachment; filename="reunion-cadrage-ete-2026.md"');
    assert.match(res.text, /^# Réunion \/ cadrage été 2026/, 'le titre ouvre le document');
    assert.match(res.text, /contenu de la page/);
  });
});

describe('Todos', () => {
  test('capture rapide, cocher, décocher, filtres', async () => {
    const t = await app.api('POST', '/api/todos', { title: 'Relancer la migration' });
    assert.equal(t.status, 200);
    assert.equal(t.body.priority, 'normal', 'la capture rapide ne demande rien d’autre qu’un titre');
    assert.equal(t.body.due_at, null);

    const fait = await app.api('PUT', `/api/todos/${t.body.id}`, { status: 'done' });
    assert.ok(fait.body.done_at, 'c’est done_at qui fait courir les sept jours');
    assert.ok(!(await app.api('GET', '/api/todos?status=open')).body.todos.some((x) => x.id === t.body.id));
    assert.ok((await app.api('GET', '/api/todos?status=done')).body.todos.some((x) => x.id === t.body.id));

    const rouverte = await app.api('PUT', `/api/todos/${t.body.id}`, { status: 'open' });
    assert.equal(rouverte.body.done_at, null, 'décocher efface la date, sinon elle s’archiverait seule');
    await app.api('DELETE', `/api/todos/${t.body.id}`);
  });

  test('édition complète : priorité, note, échéance, lien', async () => {
    const t = await app.api('POST', '/api/todos', { title: 'Suivre le lot facturation' });
    const maj = await app.api('PUT', `/api/todos/${t.body.id}`, {
      priority: 'high', note: 'bloque la release', due_at: jours(2),
      link_kind: 'ticket', link_ref: 'PROJ-720',
    });
    assert.equal(maj.body.priority, 'high');
    assert.equal(maj.body.note, 'bloque la release');
    assert.equal(maj.body.link_kind, 'ticket');
    assert.equal(maj.body.link_ref, 'PROJ-720');
    await app.api('DELETE', `/api/todos/${t.body.id}`);
  });

  test('les entrées invalides sont refusées, l’objet inconnu rend 404', async () => {
    assert.equal((await app.api('POST', '/api/todos', { title: '' })).status, 400);
    assert.equal((await app.api('POST', '/api/todos', { title: 'a', priority: 'urgente' })).status, 400);
    assert.equal((await app.api('POST', '/api/todos', { title: 'a', due_at: 'jeudi' })).status, 400);
    assert.equal((await app.api('PUT', '/api/todos/999999', { status: 'done' })).status, 404);
    assert.equal((await app.api('DELETE', '/api/todos/999999')).status, 404);
  });

  test('snooze : +1 h et demain 9 h, un report inconnu est refusé', async () => {
    const t = await app.api('POST', '/api/todos', { title: 'appeler la plateforme', due_at: jours(-1) });
    const avant = new Date(t.body.due_at).getTime();

    const plusUne = await app.api('PUT', `/api/todos/${t.body.id}`, { snooze: 'hour' });
    const ecart = new Date(plusUne.body.due_at).getTime() - Date.now();
    assert.ok(ecart > 55 * 60 * 1000 && ecart < 65 * 60 * 1000, `+1 h attendu, vu ${Math.round(ecart / 60000)} min`);
    assert.ok(new Date(plusUne.body.due_at).getTime() > avant);

    const demain = await app.api('PUT', `/api/todos/${t.body.id}`, { snooze: 'tomorrow' });
    assert.equal(new Date(demain.body.due_at).getHours(), 9, '9 h AU CADRAN, pas « dans 24 h »');

    assert.equal((await app.api('PUT', `/api/todos/${t.body.id}`, { snooze: 'lundi' })).status, 400);
    await app.api('DELETE', `/api/todos/${t.body.id}`);
  });
});

describe('Rappels', () => {
  test('un rappel dû est annoncé une seule fois, et la confirmation vient du client', async () => {
    const t = await app.api('POST', '/api/todos', { title: 'relire la migration', due_at: jours(-1) });
    const id = t.body.id;

    const dus = await app.api('GET', '/api/todos/reminders/due');
    assert.ok(dus.body.due.some((x) => x.id === id), 'échu et jamais notifié : il est dû');

    /* Le serveur ne consomme PAS le rappel en répondant : sans confirmation, une notification
       qui échoue (permission refusée, onglet fermé) perdrait l'unique occasion de prévenir. */
    const encore = await app.api('GET', '/api/todos/reminders/due');
    assert.ok(encore.body.due.some((x) => x.id === id), 'lire la liste ne consomme rien');

    assert.equal((await app.api('POST', `/api/todos/${id}/reminded`)).status, 200);
    assert.ok(!(await app.api('GET', '/api/todos/reminders/due')).body.due.some((x) => x.id === id));

    // Et LE piège : repousser un rappel déjà notifié doit le faire re-sonner.
    await app.api('PUT', `/api/todos/${id}`, { due_at: jours(-1) });
    assert.ok((await app.api('GET', '/api/todos/reminders/due')).body.due.some((x) => x.id === id),
      'une nouvelle échéance re-sonne, sinon le snooze rendrait la todo définitivement muette');
    await app.api('DELETE', `/api/todos/${id}`);
  });

  test('une échéance future ne réclame rien', async () => {
    const t = await app.api('POST', '/api/todos', { title: 'plus tard', due_at: jours(3) });
    assert.ok(!(await app.api('GET', '/api/todos/reminders/due')).body.due.some((x) => x.id === t.body.id));
    await app.api('DELETE', `/api/todos/${t.body.id}`);
  });
});

describe('Index d’autolink', () => {
  test('il rend la table iid → dépôts des MR connues', async () => {
    await app.api('POST', '/api/repos', { project: 'grp/app', url: `${app.gitlabUrl}/grp/app.git` });
    app.state.mrs['grp/app'] = [{
      iid: 214, title: 'PROJ-42 ajoute le panier', state: 'opened',
      source_branch: 'feature/PROJ-42', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/214',
      sha: 'abc123', author: { name: 'Dev' }, created_at: new Date().toISOString(),
      diff_refs: { base_sha: 'base1', start_sha: 'start1', head_sha: 'abc123' },
    }];
    await app.api('POST', '/api/discover');

    const idx = await app.api('GET', '/api/notes-index');
    assert.ok(idx.body.mrs['214'], 'la MR découverte est résoluble');
    assert.equal(idx.body.mrs['214'][0].project, 'grp/app');
    assert.equal(idx.body.jira, false, 'Jira n’est pas configuré : pas de lien mort vers un ticket');
  });
});

describe('Brief « Aujourd’hui »', () => {
  /* Le fil d'activité est alimenté par la découverte de MR faite plus haut : on repart d'un
     fil vide, sinon « ce qui a bougé depuis hier » compterait le décor du test précédent. */
  before(() => { app.db.prepare('DELETE FROM feed').run(); });

  /* Les sections vides ne sont pas rendues côté front ; côté API elles arrivent vides —
     c'est ce qui permet au front d'appliquer la règle en un endroit. */
  test('sur une instance calme, tout est vide et l’activité est nulle', async () => {
    const b = await app.api('GET', '/api/brief');
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.reminders, []);
    assert.deepEqual(b.body.sessions, []);
    assert.deepEqual(b.body.verifications, []);
    assert.equal(b.body.activity, null, 'une activité toute à zéro est un vide, pas trois zéros');
    assert.equal(b.body.stale_days, 5);
  });

  test('rappels et todos du jour : chaque todo n’apparaît qu’une fois', async () => {
    const echue = await app.api('POST', '/api/todos', { title: 'échue depuis hier', due_at: jours(-1) });
    const haute = await app.api('POST', '/api/todos', { title: 'importante sans date', priority: 'high' });
    const plusTard = await app.api('POST', '/api/todos', { title: 'la semaine prochaine', due_at: jours(6) });

    const b = (await app.api('GET', '/api/brief')).body;
    const ids = (l) => l.map((x) => x.id);
    assert.ok(ids(b.reminders).includes(echue.body.id));
    assert.ok(ids(b.todos).includes(haute.body.id), 'une haute priorité sans date ne remonte jamais toute seule');
    assert.ok(!ids(b.todos).includes(echue.body.id),
      'déjà en Rappels : l’afficher deux fois ferait douter d’en avoir deux');
    assert.ok(!ids(b.reminders).includes(plusTard.body.id));
    assert.ok(!ids(b.todos).includes(plusTard.body.id));

    for (const t of [echue, haute, plusTard]) await app.api('DELETE', `/api/todos/${t.body.id}`);
  });

  test('une todo faite ne remonte plus dans le brief', async () => {
    const t = await app.api('POST', '/api/todos', { title: 'réglée', due_at: jours(-1) });
    await app.api('PUT', `/api/todos/${t.body.id}`, { status: 'done' });
    assert.ok(!(await app.api('GET', '/api/brief')).body.reminders.some((x) => x.id === t.body.id));
    await app.api('DELETE', `/api/todos/${t.body.id}`);
  });

  /* La section « MR à traiter » ne redit pas la file entière : elle signale ce qui est TOMBÉ
     depuis hier, c'est-à-dire ce qu'on n'a pas encore pu voir. */
  test('MR fraîches : celles d’hier, pas la file entière', async () => {
    const vieille = app.db.prepare('SELECT id FROM mr LIMIT 1').get();
    assert.ok(vieille, 'la MR découverte plus haut sert de base');
    const b1 = (await app.api('GET', '/api/brief')).body;
    assert.ok(b1.fresh_mrs.some((m) => m.id === vieille.id), 'découverte à l’instant : elle est fraîche');

    app.db.prepare('UPDATE mr SET gitlab_created_at = ? WHERE id = ?')
      .run(jours(-10), vieille.id);
    const b2 = (await app.api('GET', '/api/brief')).body;
    assert.ok(!b2.fresh_mrs.some((m) => m.id === vieille.id), 'celle d’il y a dix jours n’est plus une nouvelle');
  });

  test('MR dormantes : reviewées il y a longtemps et toujours ouvertes, seuil réglable', async () => {
    const mr = app.db.prepare('SELECT id FROM mr LIMIT 1').get();
    const vieux = jours(-8);
    app.db.prepare("UPDATE mr SET status = 'reviewed', closed_seen = 0 WHERE id = ?").run(mr.id);
    app.db.prepare('INSERT INTO review (mr_id, md_path, created_at, updated_at) VALUES (?,?,?,?)')
      .run(mr.id, '/tmp/rien.md', vieux, vieux);

    const b = (await app.api('GET', '/api/brief')).body;
    const ligne = b.stale_mrs.find((m) => m.id === mr.id);
    assert.ok(ligne, 'reviewée il y a huit jours, seuil à cinq : elle dort');
    assert.ok(ligne.days >= 7, `l’âge est annoncé (vu ${ligne.days} j)`);

    // Le seuil est réglable parce qu'il dépend du rythme de l'équipe : à 30 jours, elle sort.
    await app.api('PUT', '/api/config', { stale_mr_days: 30 });
    const large = (await app.api('GET', '/api/brief')).body;
    assert.equal(large.stale_days, 30);
    assert.ok(!large.stale_mrs.some((m) => m.id === mr.id));

    // Et une MR déjà mergée ne dort pas : elle est finie.
    await app.api('PUT', '/api/config', { stale_mr_days: 5 });
    app.db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(mr.id);
    assert.ok(!(await app.api('GET', '/api/brief')).body.stale_mrs.some((m) => m.id === mr.id));

    app.db.prepare('DELETE FROM review WHERE mr_id = ?').run(mr.id);
    app.db.prepare("UPDATE mr SET status = 'to_review', closed_seen = 0 WHERE id = ?").run(mr.id);
  });

  test('sessions en attente de réponse : elles bloquent du travail, elles remontent', async () => {
    const repo = app.db.prepare('SELECT id FROM repo LIMIT 1').get();
    const now = new Date().toISOString();
    const task = app.db.prepare(`INSERT INTO task (repo_id, prompt, branch, kind, status, created_at, updated_at)
      VALUES (?, 'migre les imports vers ESM', 'feature/esm', 'code', 'needs_input', ?, ?)`)
      .run(repo.id, now, now).lastInsertRowid;
    app.db.prepare("INSERT INTO task_target (task_id, repo_id, branch, status) VALUES (?,?,?,'needs_input')")
      .run(task, repo.id, 'feature/esm');

    const b = (await app.api('GET', '/api/brief')).body;
    const s = b.sessions.find((x) => x.task_id === task);
    assert.ok(s, 'une session qui attend une réponse est ce qu’il y a de plus coûteux à oublier');
    assert.equal(s.targets, 1);
    assert.match(s.prompt, /ESM/);

    app.db.prepare('DELETE FROM task_target WHERE task_id = ?').run(task);
    app.db.prepare('DELETE FROM task WHERE id = ?').run(task);
  });

  test('activité depuis hier : ce qui a bougé, et rien d’avant-hier', async () => {
    app.db.prepare('DELETE FROM feed').run();
    const ins = app.db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)');
    ins.run('mr_merged', 1, 'grp/app', 'Dev', 'hier', jours(-0.5));
    ins.run('mr_opened', 2, 'grp/app', 'Dev', 'hier aussi', jours(-0.2));
    ins.run('mr_merged', 3, 'grp/app', 'Dev', 'la semaine dernière', jours(-9));

    const a = (await app.api('GET', '/api/brief')).body.activity;
    assert.ok(a, 'trois événements : la ligne existe');
    assert.equal(a.merged, 1, 'celui d’il y a neuf jours n’est pas « depuis hier »');
    assert.equal(a.opened, 1);
    app.db.prepare('DELETE FROM feed').run();
  });

  /* Un verdict rouge dont la branche a bougé porte sur du code qui n'est plus là : l'afficher
     comme actionnable enverrait corriger un problème peut-être déjà corrigé. */
  test('vérifications en échec : les verdicts périmés sont écartés', async () => {
    const mr = app.db.prepare('SELECT id, current_sha FROM mr LIMIT 1').get();
    const repo = app.db.prepare('SELECT id FROM repo LIMIT 1').get();
    const now = new Date().toISOString();
    const poser = (headSha) => app.db.prepare(`INSERT INTO verification
      (verifier_name, status, verdict, targets_json, imputable_json, finished_at, created_at)
      VALUES ('integ', 'done', 'verified_fail', ?, ?, ?, ?)`).run(
      JSON.stringify([{ repo_id: repo.id, mr_id: mr.id, head_sha: headSha, branch: 'feature/x', mode: 'worktree' }]),
      JSON.stringify([{ test: 'panier › remise' }]), now, now,
    ).lastInsertRowid;

    const frais = poser(mr.current_sha);
    let b = (await app.api('GET', '/api/brief')).body;
    const v = b.verifications.find((x) => x.verification_id === frais);
    assert.ok(v, 'un rouge sur le SHA courant est actionnable');
    assert.equal(v.failed, 1);
    assert.equal(v.failed_label, 'panier › remise', 'le test cassé est nommé : un compte ne dit pas quoi corriger');

    app.db.prepare('DELETE FROM verification WHERE id = ?').run(frais);
    const perime = poser('sha-d-avant-hier');
    b = (await app.api('GET', '/api/brief')).body;
    assert.ok(!b.verifications.some((x) => x.verification_id === perime),
      'la branche a bougé : le verdict ne porte plus sur ce code');
    app.db.prepare('DELETE FROM verification WHERE id = ?').run(perime);
  });

  /* ÉCARTER une ligne du brief. Le brief recalcule tout chaque matin : un verdict rouge dont
     on a déjà fait le tour revient indéfiniment et finit par apprendre à ne plus lire la
     section. On écarte donc le CONSTAT, pas le sujet — et rien n'est supprimé. */
  test('une vérification écartée ne revient plus, et se réaffiche d’un bouton', async () => {
    const mr = app.db.prepare('SELECT id, current_sha FROM mr LIMIT 1').get();
    const repo = app.db.prepare('SELECT id FROM repo LIMIT 1').get();
    const now = new Date().toISOString();
    const poser = () => app.db.prepare(`INSERT INTO verification
      (verifier_name, status, verdict, targets_json, imputable_json, finished_at, created_at)
      VALUES ('integ', 'done', 'verified_fail', ?, ?, ?, ?)`).run(
      JSON.stringify([{ repo_id: repo.id, mr_id: mr.id, head_sha: mr.current_sha, branch: 'feature/x', mode: 'worktree' }]),
      JSON.stringify([{ test: 'panier › remise' }]), now, now,
    ).lastInsertRowid;

    const id = poser();
    const vu = () => app.api('GET', '/api/brief').then((r) => r.body);
    assert.ok((await vu()).verifications.some((x) => x.verification_id === id), 'le rouge est là');

    const ec = await app.api('POST', '/api/brief/hidden', { kind: 'verification', ref: String(id) });
    assert.equal(ec.status, 200);
    let b = await vu();
    assert.ok(!b.verifications.some((x) => x.verification_id === id), 'écarté : il ne revient pas');
    assert.equal(b.hidden_count, 1, 'le brief dit combien il cache — sinon on croit à une perte');

    // Écarter deux fois n'empile rien : le geste est idempotent, un double clic ne compte pas double.
    await app.api('POST', '/api/brief/hidden', { kind: 'verification', ref: String(id) });
    assert.equal((await vu()).hidden_count, 1);

    // La vérification EXISTE toujours : on a masqué une ligne de brief, pas supprimé un verdict.
    assert.ok(app.db.prepare('SELECT 1 FROM verification WHERE id = ?').get(id), 'rien n’a été supprimé');

    const restaure = await app.api('DELETE', '/api/brief/hidden');
    assert.equal(restaure.body.restored, 1);
    b = await vu();
    assert.ok(b.verifications.some((x) => x.verification_id === id), 'tout réafficher le ramène');
    assert.equal(b.hidden_count, 0);

    /* Un NOUVEAU verdict du même sujet reparaît : on a écarté un constat, pas éteint une
       alarme. Sans ça, une vraie régression resterait invisible pour toujours. */
    await app.api('POST', '/api/brief/hidden', { kind: 'verification', ref: String(id) });
    const neuf = poser();
    assert.ok((await vu()).verifications.some((x) => x.verification_id === neuf),
      'un verdict plus récent n’est pas couvert par l’écart de l’ancien');

    await app.api('DELETE', '/api/brief/hidden');
    app.db.prepare('DELETE FROM verification WHERE id IN (?, ?)').run(id, neuf);
  });

  /* Une section plafonne à huit lignes. Écarter la première doit faire remonter la NEUVIÈME,
     sinon la section rétrécit à chaque geste et le travail caché derrière le plafond ne se
     montre jamais — on écarterait huit fois pour voir un brief vide qui ment. */
  test('écarter une ligne fait remonter la suivante', async () => {
    const repo = app.db.prepare('SELECT id FROM repo LIMIT 1').get();
    const ids = [];
    for (let i = 0; i < 9; i += 1) {
      const t = (await app.api('POST', '/api/tasks', {
        kind: 'code', prompt: `Question ${i}`, targets: [{ repo_id: repo.id, branch: `feat/q${i}` }],
      })).body;
      app.db.prepare("UPDATE task_target SET status = 'needs_input' WHERE task_id = ?").run(t.id);
      ids.push(t.id);
    }
    const sessions = () => app.api('GET', '/api/brief').then((r) => r.body.sessions.map((s) => s.task_id));
    const avant = await sessions();
    assert.equal(avant.length, 8, 'le brief se lit debout : huit lignes au plus');
    const cachee = avant[0];
    const absente = ids.find((id) => !avant.includes(id));

    await app.api('POST', '/api/brief/hidden', { kind: 'session', ref: String(cachee) });
    const apres = await sessions();
    assert.ok(!apres.includes(cachee));
    assert.equal(apres.length, 8, 'toujours huit : la place libérée est reprise');
    assert.ok(apres.includes(absente), 'c’est la neuvième qui monte, pas un trou');

    await app.api('DELETE', '/api/brief/hidden');
    for (const id of ids) await app.api('DELETE', `/api/tasks/${id}`);
  });

  test('un type d’élément inventé est refusé', async () => {
    const r = await app.api('POST', '/api/brief/hidden', { kind: 'nimporte', ref: '1' });
    assert.equal(r.status, 400, 'une clé inconnue resterait en base sans rien masquer');
    assert.equal((await app.api('POST', '/api/brief/hidden', { kind: 'mr', ref: '  ' })).status, 400);
  });
});

describe('Réglages du brief', () => {
  test('l’atterrissage se débraye, et le seuil de dormance est borné', async () => {
    /* Le harnais l'a mis à '0' pour ne pas faire atterrir les tests de navigateur sur le
       brief ; c'est donc la BASCULE qu'on éprouve ici, et le défaut d'une base neuve est
       vérifié à part, sur la valeur du schéma. */
    assert.equal(app.db.prepare("SELECT dflt_value v FROM pragma_table_info('config') WHERE name = 'brief_on_open'").get().v,
      "'1'", 'activé par défaut sur une base neuve');
    assert.equal((await app.api('PUT', '/api/config', { brief_on_open: '1' })).body.brief_on_open, '1');
    assert.equal((await app.api('PUT', '/api/config', { brief_on_open: '0' })).body.brief_on_open, '0');
    // Une valeur inattendue ne casse pas l'interface : tout ce qui n'est pas '0' vaut activé.
    assert.equal((await app.api('PUT', '/api/config', { brief_on_open: 'oui' })).body.brief_on_open, '1');

    /* À 0 jour, toute MR reviewée ce matin serait « dormante » — et une section qui contient
       tout ne signale plus rien. On retombe donc sur le défaut plutôt que d'obéir. */
    assert.equal((await app.api('PUT', '/api/config', { stale_mr_days: 0 })).body.stale_mr_days, 5);
    assert.equal((await app.api('PUT', '/api/config', { stale_mr_days: 400 })).body.stale_mr_days, 90);
    assert.equal((await app.api('PUT', '/api/config', { stale_mr_days: 'beaucoup' })).body.stale_mr_days, 5);
    assert.equal((await app.api('PUT', '/api/config', { stale_mr_days: 12 })).body.stale_mr_days, 12);
  });
});

describe('Sauvegarde', () => {
  /* Les notes sont la seule chose que Mergerie ne sait pas reconstruire : elles n'existent
     nulle part ailleurs. Elles doivent donc voyager dans l'archive — c'est l'argument même
     de les tenir ici plutôt que dans un fichier texte à côté. */
  test('les notes et les todos entrent dans l’archive de sauvegarde', async () => {
    await app.api('POST', '/api/notes', { title: 'page à sauvegarder' });
    await app.api('POST', '/api/todos', { title: 'todo à sauvegarder' });
    const res = await fetch(`${app.base}/api/backup`);
    assert.equal(res.status, 200);
    const zip = Buffer.from(await res.arrayBuffer());
    assert.ok(zip.length > 0);
    // La base entière est dans l'archive : le contenu des tables est couvert par e2e-backup.
    assert.equal(zip.slice(0, 2).toString(), 'PK');
    const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes('note_page') && tables.includes('todo'),
      'les tables vivent dans la base du dataDir, donc dans la sauvegarde');
  });
});

describe('Ordre de la liste « à faire »', () => {
  /* Le tri automatique répond à « qu'est-ce qui presse » ; il ne répond pas à « dans quel
     ordre je m'y prends ce matin ». La liste suit donc l'ordre qu'on lui donne — priorité et
     échéance restent affichées et continuent d'alimenter le brief et les pastilles du menu. */
  const titres = () => app.api('GET', '/api/todos').then((r) => r.body.todos.map((t) => t.title));

  test('la liste se réordonne, et l’ordre tient', async () => {
    for (const t of (await app.api('GET', '/api/todos')).body.todos) await app.api('DELETE', `/api/todos/${t.id}`);
    const a = (await app.api('POST', '/api/todos', { title: 'A', priority: 'low' })).body;
    const b = (await app.api('POST', '/api/todos', { title: 'B', priority: 'high' })).body;
    const c = (await app.api('POST', '/api/todos', { title: 'C', priority: 'normal' })).body;

    assert.equal((await app.api('POST', '/api/todos/reorder', { ids: [a.id, c.id, b.id] })).status, 200);
    assert.deepEqual(await titres(), ['A', 'C', 'B'],
      'l’ordre demandé prime sur la priorité : une liste qui se réarrange toute seule ne se réordonne pas');
    // Il tient d'un appel à l'autre — sinon ce n'est pas un ordre, c'est un accident.
    assert.deepEqual(await titres(), ['A', 'C', 'B']);

    /* Une todo NEUVE se range en tête, là où on vient de la taper : la chercher en bas d'une
       liste de trente serait absurde. */
    await app.api('POST', '/api/todos', { title: 'D' });
    assert.deepEqual(await titres(), ['D', 'A', 'C', 'B']);
  });

  test('cocher une todo ne dérange pas l’ordre des autres', async () => {
    const avant = await titres();
    const liste = (await app.api('GET', '/api/todos')).body.todos;
    await app.api('PUT', `/api/todos/${liste[1].id}`, { status: 'done' });
    assert.deepEqual(await titres(), avant.filter((t) => t !== avant[1]));
  });

  test('un ordre vide est refusé, une todo inconnue ignorée', async () => {
    assert.equal((await app.api('POST', '/api/todos/reorder', { ids: [] })).status, 400);
    const avant = await titres();
    await app.api('POST', '/api/todos/reorder', { ids: [999999] });
    assert.deepEqual(await titres(), avant, 'une todo inconnue ne fait pas échouer le reste');
  });
});
