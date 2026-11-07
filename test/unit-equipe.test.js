'use strict';
/* LA PAGE D'ÉQUIPE « NOTRE MATIN » : DES FAITS DÉJÀ PARTAGÉS, RIEN SUR UNE PERSONNE QUI NE SOIT L'ÉTAT D'UN TRAVAIL.
 *
 * Ce que ce fichier prouve, sur une base temporaire à deux auteurs (l'auteur d'un fichier partagé est
 * semé dans l'état local, là où la synchro l'écrit) : une décision en attente (score 8,6 ≥ seuil, MR
 * ouverte non classée) est listée avec auteur, reviewer et attente — classée « traitée » ou notée 7,9,
 * elle ne l'est pas ; une question d'une session PARTAGÉE en `needs_input` est listée avec son texte,
 * une session non partagée n'existe pas (ni ligne, ni compteur), une reprise l'annote ; une session
 * partagée `running` dit la fraîcheur de la synchro de son auteur ; une reprise entre deux auteurs est
 * listée, pas entre une personne et elle-même, plus après la fenêtre ; une vérification `verified_fail`
 * est listée, pas une base cassée ; croisements et empilements portent les deux auteurs ; la fraîcheur
 * compte les jours OUVRÉS et marque « silencieux » le seul poste muet ; le filtre personne ne garde que
 * ce qui l'attend ; sans dépôt attaché, `{ attached: false }` et rien d'autre ; aucune métrique par
 * personne dans la sortie ; le module n'importe ni `agent/` ni `forge/`. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lireSource } = require('./helpers/sources');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'equipe-'));
process.env.GIT_AUTHOR_NAME = 'Amady';

describe('Page d’équipe « Notre matin »', () => {
  let db; let eq; let etat; let store;
  const NOW = new Date('2026-11-05T10:00:00Z');   // un jeudi
  const il_y_a = (j) => new Date(NOW.getTime() - j * 86400000).toISOString();
  let repoId; let repoId2;
  const ids = {};
  const cfg = {};
  const auteur = (table, row, nom) => etat.ecrire('author', store.cheminSur(table, row), 'name', nom);

  before(() => {
    db = require('../src/db');
    eq = require('../src/notes/equipe');
    etat = require('../src/data/localstate').etat;
    store = require('../src/data/store');
    repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/tarification', 'https://gitlab.test/grp/tarification.git', 1, 'gitlab')").run().lastInsertRowid);
    repoId2 = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/facturation', 'https://gitlab.test/grp/facturation.git', 1, 'gitlab')").run().lastInsertRowid);
    // Le dépôt de données « attaché » : l'adresse suffit au calcul, aucun git n'est touché ici.
    db.prepare("UPDATE local_config SET data_repo_url = 'https://gitlab.test/equipe/donnees.git' WHERE id = 1").run();
    // La fraîcheur des deux postes : Claire il y a 10 min, Ali il y a 3 jours ouvrés (le vendredi précédent).
    etat.ecrire('author_last', 'Claire', 'at', new Date(NOW.getTime() - 10 * 60000).toISOString());
    etat.ecrire('author_last', 'Ali', 'at', '2026-10-31T16:00:00Z');
  });

  const mr = (iid, { repo = repoId, author = 'Claire', status = 'to_review', sha = 'aaa', closed = 0 } = {}) => Number(db.prepare(
    `INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, author, closed_seen, updated_at)
     VALUES (?, ?, ?, ?, 'main', ?, ?, ?, ?, ?)`).run(repo, iid, `MR ${iid}`, `feature/${iid}`, sha, status, author, closed, il_y_a(1)).lastInsertRowid);
  const review = (mrId, note, { at = il_y_a(5), par = 'Ali' } = {}) => {
    const id = Number(db.prepare('INSERT INTO review (mr_id, note_value, created_at, updated_at) VALUES (?, ?, ?, ?)').run(mrId, note, at, at).lastInsertRowid);
    auteur('review', db.prepare('SELECT * FROM review WHERE id = ?').get(id), par);
    return id;
  };
  const session = ({ auteurNom = 'Claire', shared = 1, status = 'done', repo = repoId, kind = 'code', resumed = null, finished = null, updated = il_y_a(0.02) } = {}) => {
    const id = Number(db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, status, shared, resumed_from_uid, created_at, updated_at, finished_at)
      VALUES (?, ?, 'faire', 'b', ?, ?, ?, ?, ?, ?)`).run(repo, kind, status, shared, resumed, updated, updated, finished).lastInsertRowid);
    const row = db.prepare('SELECT * FROM task WHERE id = ?').get(id);
    if (shared && auteurNom) auteur('task', row, auteurNom);
    return row;
  };
  const cible = (task, { status = 'new', questions = null, branch = 'b' } = {}) => Number(db.prepare(
    'INSERT INTO task_target (task_id, repo_id, branch, base_branch, status, questions_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(task.id, task.repo_id, branch, 'main', status, questions ? JSON.stringify(questions) : null, il_y_a(2)).lastInsertRowid);

  test('sans dépôt de données attaché → { attached: false }, et rien d’autre', () => {
    db.prepare("UPDATE local_config SET data_repo_url = '' WHERE id = 1").run();
    assert.deepEqual(eq.construire(cfg, { maintenant: NOW }), { attached: false });
    db.prepare("UPDATE local_config SET data_repo_url = 'https://gitlab.test/equipe/donnees.git' WHERE id = 1").run();
    const vide = eq.construire(cfg, { maintenant: NOW });
    assert.equal(vide.attached, true); assert.equal(vide.empty, true);
    assert.deepEqual(vide.counts, { decisions: 0, questions: 0, running: 0 });
    assert.deepEqual(vide.people, ['Claire', 'Ali'], 'les postes connus du dépôt, même sans rien en attente');
  });

  test('décisions en attente : 8,6 ≥ seuil, ouverte, non classée → listée avec auteur, reviewer, attente ; « traitée » ou 7,9 → absente', () => {
    ids.m214 = mr(214); review(ids.m214, 0.86, { at: il_y_a(5) });
    ids.m215 = mr(215, { status: 'done' }); review(ids.m215, 0.9);
    ids.m216 = mr(216); review(ids.m216, 0.79);
    ids.m217 = mr(217, { closed: 1 }); review(ids.m217, 0.95);
    const d = eq.construire(cfg, { maintenant: NOW, seuilPret: 8 });
    assert.deepEqual(d.decisions.items.map((x) => [x.iid, x.author, x.reviewer, x.score, Math.round(x.waiting_days)]), [[214, 'Claire', 'Ali', 8.6, 5]]);
    assert.equal(d.counts.decisions, 1);
    assert.equal(eq.construire(cfg, { maintenant: NOW, seuilPret: 9 }).decisions.items.length, 0, 'le seuil est celui de l’équipe');
    // Une review faite ici et pas encore poussée a pour auteur l'identité locale.
    ids.m218 = mr(218, { repo: repoId2, author: 'Ali' });
    db.prepare('INSERT INTO review (mr_id, note_value, created_at, updated_at) VALUES (?, ?, ?, ?)').run(ids.m218, 0.82, il_y_a(1), il_y_a(1));
    const d2 = eq.construire(cfg, { maintenant: NOW });
    assert.deepEqual(d2.decisions.items.map((x) => [x.iid, x.reviewer]), [[214, 'Ali'], [218, 'Amady']], 'triées par attente décroissante');
  });

  test('questions sans réponse : partagée → listée avec la question ; non partagée → nulle part, pas même au compteur ; reprise → annotée', () => {
    ids.sClaire = session({ auteurNom: 'Claire', status: 'needs_input' });
    ids.tgClaire = cible(ids.sClaire, { status: 'needs_input', questions: [{ id: 'q1', question: 'Faut-il arrondir la TVA au centime ?', answer: null }] });
    const privee = session({ auteurNom: null, shared: 0, status: 'needs_input' });
    cible(privee, { status: 'needs_input', questions: [{ id: 'q1', question: 'SECRET ?', answer: null }] });
    const d = eq.construire(cfg, { maintenant: NOW });
    assert.deepEqual(d.questions.items.map((q) => [q.task_id, q.author, q.question, q.answered_in]), [[ids.sClaire.id, 'Claire', 'Faut-il arrondir la TVA au centime ?', null]]);
    assert.equal(d.counts.questions, 1, 'la session non partagée ne compte pas');
    assert.ok(!JSON.stringify(d).includes('SECRET'), 'rien d’une session non partagée ne paraît');
    // Une reprise de cette cible par Amady : la ligne le dit.
    const tgUid = db.prepare('SELECT uid FROM task_target WHERE id = ?').get(ids.tgClaire).uid;
    ids.reprise = session({ auteurNom: 'Amady', status: 'running', resumed: ids.sClaire.uid });
    db.prepare('UPDATE task SET resumed_target_uid = ? WHERE id = ?').run(tgUid, ids.reprise.id);
    assert.equal(eq.construire(cfg, { maintenant: NOW }).questions.items[0].answered_in, ids.reprise.id);
  });

  test('sessions en cours : partagée `running` → listée avec la synchro de son auteur ; reprises : deux auteurs, fenêtre de 7 jours', () => {
    ids.sAli = session({ auteurNom: 'Ali', status: 'running', repo: repoId2, updated: il_y_a(0.03) });
    const d = eq.construire(cfg, { maintenant: NOW });
    const ali = d.running.items.find((x) => x.task_id === ids.sAli.id);
    assert.deepEqual([ali.author, ali.project, ali.synced_at], ['Ali', 'grp/facturation', '2026-10-31T16:00:00Z']);
    assert.equal(d.counts.running, 2, 'la reprise d’Amady tourne aussi');
    assert.deepEqual(d.takeovers.items.map((t) => [t.from_task_id, t.from_author, t.task_id, t.author]), [[ids.sClaire.id, 'Claire', ids.reprise.id, 'Amady']]);
    // Même auteur des deux côtés → pas une reprise d'équipe ; terminée depuis 8 jours → sortie.
    session({ auteurNom: 'Claire', status: 'done', resumed: ids.sClaire.uid, finished: il_y_a(1) });
    session({ auteurNom: 'Ali', status: 'done', resumed: ids.sClaire.uid, finished: il_y_a(8), updated: il_y_a(8) });
    const d2 = eq.construire(cfg, { maintenant: NOW, repriseJours: 7 });
    assert.deepEqual(d2.takeovers.items.map((t) => t.author), ['Amady']);
    assert.deepEqual(eq.construire(cfg, { maintenant: NOW, repriseJours: 30 }).takeovers.items.map((t) => t.author).sort(), ['Ali', 'Amady']);
  });

  test('vérifications en échec : head KO / base OK → listée ; base KO aussi → absente ; croisements et empilements avec les deux auteurs', () => {
    ids.m219 = mr(219, { repo: repoId2, author: 'Ali', sha: 'bbb' });
    db.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, imputable_json, finished_at, created_at) VALUES ('tests', 'done', 'verified_fail', ?, ?, ?, ?)`)
      .run(JSON.stringify([{ repo_id: repoId2, mr_id: ids.m219, head_sha: 'bbb', branch: 'feature/219' }]), JSON.stringify([{ test: 'a' }, { test: 'b' }, { test: 'c' }]), il_y_a(1), il_y_a(1));
    const m220 = mr(220, { author: 'Claire', sha: 'ccc' });
    db.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, finished_at, created_at) VALUES ('tests', 'done', 'broken_base', ?, ?, ?)`)
      .run(JSON.stringify([{ repo_id: repoId, mr_id: m220, head_sha: 'ccc' }]), il_y_a(1), il_y_a(1));
    const d = eq.construire(cfg, { maintenant: NOW });
    assert.deepEqual(d.failing.items.map((f) => [f.iid, f.failed, f.author]), [[219, 3, 'Ali']]);
    // Croisements : !214 (Claire) et !220 (Claire → Ali pour le test) touchent le même fichier.
    db.prepare("UPDATE mr SET author = 'Ali' WHERE id = ?").run(m220);
    const now = new Date().toISOString();
    for (const [id, sha] of [[ids.m214, 'aaa'], [m220, 'ccc']]) {
      db.prepare('INSERT INTO mr_files (mr_id, path) VALUES (?, ?)').run(id, 'src/tva.js');
      db.prepare("INSERT INTO mr_file_fetch (mr_id, head_sha, fetched_at, files, source) VALUES (?, ?, ?, 1, 'forge')").run(id, sha, now);
    }
    const d2 = eq.construire({ mr_files_enabled: '1' }, { maintenant: NOW });
    assert.deepEqual(d2.pairs.items.filter((p) => p.kind === 'overlap').map((p) => [p.a_iid, p.a_author, p.b_iid, p.b_author, p.shared]), [[214, 'Claire', 220, 'Ali', 1]]);
  });

  test('fraîcheur : Claire il y a 10 min, Ali il y a 3 jours ouvrés → « silencieux » sur Ali seul (week-end non compté) ; décisions attendues comptées, rien d’autre', () => {
    const d = eq.construire(cfg, { maintenant: NOW, silencieuxJours: 2 });
    const parNom = Object.fromEntries(d.workstations.items.map((w) => [w.name, w]));
    assert.equal(parNom.Claire.quiet, false); assert.equal(parNom.Ali.quiet, true);
    assert.equal(parNom.Claire.decisions_awaited, 1, '!214 est à Claire');
    assert.equal(eq.joursOuvres('2026-10-31T16:00:00Z', NOW), 4, 'vendredi → jeudi : lun, mar, mer, jeu — le week-end ne compte pas');
    assert.equal(eq.joursOuvres('2026-10-31T16:00:00Z', new Date('2026-11-02T09:00:00Z')), 1, 'vendredi soir → lundi matin : un seul jour ouvré');
    assert.equal(eq.construire(cfg, { maintenant: NOW, silencieuxJours: 4 }).workstations.items.find((w) => w.name === 'Ali').quiet, false);
    assert.deepEqual(Object.keys(parNom.Ali).sort(), ['decisions_awaited', 'name', 'quiet', 'synced_at']);
  });

  test('filtre personne : ne garde que ce qui attend cette personne ; filtre groupe : ses dépôts', () => {
    const d = eq.construire(cfg, { maintenant: NOW, personne: 'Ali', repriseJours: 30 });
    assert.deepEqual(d.decisions.items.map((x) => x.iid), [218]);
    assert.deepEqual(d.questions.items, []);
    assert.deepEqual(d.running.items.map((x) => x.author), ['Ali']);
    assert.deepEqual(d.failing.items.map((x) => x.iid), [219]);
    assert.deepEqual(d.workstations.items.map((w) => w.name), ['Ali']);
    assert.ok(d.pairs.items.every((p) => p.a_author === 'Ali' || p.b_author === 'Ali'));
    const gid = Number(db.prepare("INSERT INTO repo_group (name, created_at) VALUES ('factu', ?)").run(new Date().toISOString()).lastInsertRowid);
    db.prepare('INSERT INTO repo_group_member (group_id, repo_id) VALUES (?, ?)').run(gid, repoId2);
    const g = eq.construire(cfg, { maintenant: NOW, groupId: gid });
    assert.deepEqual(g.decisions.items.map((x) => x.iid), [218]);
    assert.deepEqual(g.failing.items.map((x) => x.iid), [219]);
    assert.deepEqual(g.questions.items, []);
  });

  test('garanties : aucune métrique par personne dans la sortie ; le module n’importe ni agent/ ni forge/', () => {
    const d = eq.construire(cfg, { maintenant: NOW });
    const cles = new Set();
    const parcourir = (o) => { if (Array.isArray(o)) o.forEach(parcourir); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { cles.add(k); parcourir(v); } };
    parcourir(d);
    for (const k of cles) assert.ok(!/tokens|cost|merged|count$|_count|classement|rank/i.test(k) || k === 'counts', `clé de métrique refusée : ${k}`);
    assert.ok(!cles.has('usage') && !cles.has('cost_usd'));
    const src = lireSource('notes/equipe');
    assert.ok(!/require\(['"][^'"]*\/(agent|forge)[/'"]/.test(src), 'aucun require vers agent/ ni forge/');
    assert.ok(!/fetch\(|http\./.test(src), 'aucun appel sortant');
  });
});
