'use strict';
/* TOUT CE QUI SE PARTAGE DEVIENT UN FICHIER — y compris ce qu'aucun appel explicite n'écrit.
 *
 * La bascule de ce lot : ce ne sont plus les points d'écriture qui appellent le `store`, c'est la
 * BASE qui le prévient. Un déclencheur par table partagée note la ligne touchée, `store.ecouler()`
 * écrit les fichiers. L'application compte plus de deux cents écritures réparties dans vingt
 * modules ; les passer une par une en revue, c'était se donner rendez-vous avec l'oubli — il
 * suffirait qu'une écriture ajoutée l'an prochain n'appelle pas le `store` pour qu'un objet cesse
 * silencieusement d'être partagé.
 *
 * CE QUE CES ÉPREUVES TIENNENT :
 *
 * — UNE ÉCRITURE EN SQL BRUT suffit. Le test n'appelle JAMAIS le store pour écrire : il insère
 *   comme le ferait n'importe quel module, et le fichier doit apparaître.
 * — LA FILE SURVIT À LA COUPURE. Elle vit dans la base, dans la même transaction que l'écriture :
 *   c'est ce qui fait qu'un processus tué entre la ligne et le fichier ne perd rien.
 * — UNE SUPPRESSION RETIRE LE FICHIER. Un fichier orphelin ferait revenir l'objet à la prochaine
 *   hydratation — c'est le bug qui ne se voit qu'une semaine plus tard, chez quelqu'un d'autre.
 * — L'ALLER-RETOUR COMPLET, sur la chaîne la plus profonde : dépôt → merge request → review →
 *   version → constats. C'est elle qui décide si « supprimer `reviewer.db` et tout retrouver »
 *   est vrai ou non.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-store-complet-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

describe('store — la base prévient, le store écrit', () => {
  let db; let store; let registre; let repoId; let mrId;

  before(() => {
    db = require('../src/db');
    store = require('../src/store');
    registre = require('../src/store-registry');
  });

  test('chaque table partagée sait aller ET revenir', () => {
    /* Un `toFile` sans `fromFile` produit un fichier que personne ne sait relire : l'objet part
       chez les collègues et n'y arrive jamais. Le contrôle vaut dans les deux sens. */
    const fautes = [];
    for (const e of registre.REGISTRE) {
      const partage = e.famille === 'P' || (e.partagees || []).length;
      if (!partage || !e.chemin) continue;
      if (!e.toFile) fautes.push(`${e.table} : pas de toFile`);
      if (!e.fromFile) fautes.push(`${e.table} : pas de fromFile`);
      if (!e.commitMessage) fautes.push(`${e.table} : pas de message de commit`);
      for (const l of e.listes || []) {
        if (!l.fromItem && !l.remplace) fautes.push(`${e.table}.${l.table} : ni fromItem ni remplace`);
        if (!registre.pour(l.table)) fautes.push(`${e.table}.${l.table} : liste fille absente du registre`);
      }
    }
    assert.deepEqual(fautes, [], fautes.join('\n'));
  });

  test('une écriture en SQL BRUT — sans passer par le store — produit son fichier', () => {
    const now = new Date().toISOString();
    repoId = db.prepare(`INSERT INTO repo (project, url, forge, enabled, fetch_mrs, created_at)
      VALUES ('acme/web', 'https://x.test/a.git', 'gitlab', 1, 1, ?)`).run(now).lastInsertRowid;
    assert.ok(store.enRetard() > 0, 'le déclencheur doit avoir noté la ligne');
    store.ecouler();
    const doc = JSON.parse(store.lireFichier('repos/gitlab/acme/web.json'));
    assert.equal(doc.project, 'acme/web');
    assert.equal(doc.url, 'https://x.test/a.git');
    assert.equal(store.enRetard(), 0, 'la file doit être vide une fois écoulée');
  });

  test('une ligne FILLE marque son parent : elle n’a pas de fichier à elle', () => {
    const autre = db.prepare(`INSERT INTO repo (project, url, forge, enabled, created_at)
      VALUES ('acme/api', 'https://x.test/b.git', 'gitlab', 1, ?)`).run(new Date().toISOString()).lastInsertRowid;
    store.ecouler();
    db.prepare("INSERT INTO repo_link (repo_id, linked_repo_id, branch) VALUES (?, ?, 'main')").run(repoId, autre);
    assert.ok(store.enRetard() > 0);
    store.ecouler();
    const doc = JSON.parse(store.lireFichier('repos/gitlab/acme/web.json'));
    assert.deepEqual(doc.linked, [{ repo: 'gitlab/acme/api', branch: 'main' }]);
    /* LES JOBS JENKINS, EUX, NE SONT PLUS DANS CE FICHIER : l'onglet Jenkins décrit une machine
       et ses accès, pas un travail accumulé. Une ligne écrite ici ne salit donc plus rien. */
    db.prepare("INSERT INTO repo_jenkins (repo_id, job_path, param) VALUES (?, 'deploy/web', 'BRANCH')").run(repoId);
    assert.equal(store.enRetard(), 0, 'une table redevenue locale ne déclenche plus rien');
    assert.ok(!('jenkins' in JSON.parse(store.lireFichier('repos/gitlab/acme/web.json'))));
  });

  test('la chaîne complète — dépôt, merge request, review, version, constats', () => {
    const now = new Date().toISOString();
    mrId = db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, reviewed_sha, ticket_text, web_url, gitlab_created_at, updated_at)
      VALUES (?, 218, 'Paiement 3×', 'feat/x', 'main', 'reviewed', 'abc123', 'Règle métier : au-dessus de 100 €.',
        'https://gitlab.test/acme/web/-/merge_requests/218', '2026-02-01T09:00:00Z', ?)`)
      .run(repoId, now).lastInsertRowid;
    const md = path.join(process.env.MERGERIE_DATA_DIR, 'rapport.md');
    fs.writeFileSync(md, '# Revue\n\nDeux constats.');
    db.prepare(`INSERT INTO review_version (mr_id, version, md_path, note_value, reviewed_sha, kind, created_at)
      VALUES (?, 1, ?, 0.74, 'abc123', 'review', ?)`).run(mrId, md, now);
    db.prepare(`INSERT INTO review (mr_id, md_path, note_value, created_at, updated_at)
      VALUES (?, ?, 0.74, ?, ?)`).run(mrId, md, now, now);
    db.prepare(`INSERT INTO finding (mr_id, version, fingerprint, file, line, severity, title, status, created_at)
      VALUES (?, 1, 'f1', 'src/pay.js', 42, 'major', 'Cas manquant', 'new', ?)`).run(mrId, now);
    store.ecouler();

    const mr = JSON.parse(store.lireFichier('mrs/gitlab/acme/web/218.json'));
    assert.equal(mr.repo, 'gitlab/acme/web');
    assert.equal(mr.status, 'reviewed');
    assert.match(mr.ticket_text, /100 €/);
    /* LE TITRE ET LES BRANCHES VOYAGENT, MÊME OUVERTE. Le poste qui reçoit n'a pas forcément
       découvert la MR chez la forge — il l'affichait alors SANS TITRE dans « à relire », et
       « Voir le diff » partait sur `origin/null...origin/null`. Les deux postes lisent la même
       forge, donc ils convergent : le pire cas est un titre d'une minute en retard, et il vaut
       infiniment mieux qu'une ligne vide. */
    assert.equal(mr.title, 'Paiement 3×');
    assert.equal(mr.source_branch, 'feat/x');
    assert.equal(mr.target_branch, 'main');
    /* LE SHA COURANT, LUI, NE PART PAS : il avance à chaque push, et c'est LE seul champ dont
       une valeur en retard fait prendre une décision fausse — relire un diff qui n'existe plus. */
    assert.ok(!('current_sha' in mr), 'le SHA courant avance : chaque poste le lit chez la forge');
    /* DEUX EXCEPTIONS, ET DEUX SEULEMENT : l'adresse de la merge request et sa date d'ouverture
       ne changent JAMAIS. Sans elles, le poste qui rejoint affiche un en-tête sans lien vers la
       forge tant qu'il n'a pas de jeton à lui, et le délai de cycle n'a pas de point de départ. */
    assert.equal(mr.web_url, 'https://gitlab.test/acme/web/-/merge_requests/218');
    assert.equal(mr.gitlab_created_at, '2026-02-01T09:00:00Z');

    /* …ET FERMÉE, RIEN NE CHANGE : ces colonnes-là ne dépendent plus de son état. */
    db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(mrId);
    store.ecouler();
    const fermee = JSON.parse(store.lireFichier('mrs/gitlab/acme/web/218.json'));
    assert.equal(fermee.title, 'Paiement 3×');
    assert.equal(fermee.source_branch, 'feat/x');
    assert.equal(fermee.target_branch, 'main');
    db.prepare('UPDATE mr SET closed_seen = 0 WHERE id = ?').run(mrId);
    store.ecouler();

    const uid = db.prepare('SELECT uid FROM review_version WHERE mr_id = ?').get(mrId).uid;
    assert.equal(store.lireFichier(`reviews/gitlab/acme/web/218/${uid}.md`), '# Revue\n\nDeux constats.',
      'le rapport part en TEXTE : c’est ce qui a de la valeur, et ça se relit hors de l’outil');
    const version = JSON.parse(store.lireFichier(`reviews/gitlab/acme/web/218/${uid}.json`));
    assert.equal(version.note_value, 0.74);
    assert.equal(version.findings.length, 1);
    assert.equal(version.findings[0].file, 'src/pay.js');
    assert.ok(!('version' in version), 'le numéro de passe est un compteur LOCAL : il se recalcule');
    assert.ok(!('md_path' in version), 'un chemin absolu ne désigne rien sur l’autre poste');
  });

  test('effacer la base et réhydrater rend la chaîne entière', () => {
    const T = ['repo', 'repo_link', 'mr', 'review', 'review_version', 'finding'];
    const avant = Object.fromEntries(T.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
    db.pragma('foreign_keys = OFF');
    for (const t of T) db.exec(`DELETE FROM ${t}`);
    db.pragma('foreign_keys = ON');

    const bilan = store.hydraterTout();
    assert.deepEqual(bilan.orphelins, [], bilan.orphelins.join('\n'));
    for (const t of T) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, avant[t], `${t} n’est pas revenue entière`);
    }
    /* Les identifiants entiers sont REATTRIBUÉS — c'est précisément la différence entre deux
       postes. Ce qui doit tenir, ce sont les liens. */
    const r = db.prepare('SELECT * FROM review').get();
    const m = db.prepare('SELECT * FROM mr WHERE id = ?').get(r.mr_id);
    assert.equal(m.iid, 218);
    assert.equal(m.status, 'reviewed');
    assert.equal(m.web_url, 'https://gitlab.test/acme/web/-/merge_requests/218',
      'le lien vers la forge doit survivre au voyage');
    assert.equal(m.gitlab_created_at, '2026-02-01T09:00:00Z');
    assert.equal(db.prepare('SELECT version FROM review_version WHERE mr_id = ?').get(m.id).version, 1,
      'la version se renumérote dans l’ordre des uid');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM finding WHERE mr_id = ? AND version = 1').get(m.id).n, 1);
    // Le rapport a été REPOSÉ sur le disque local, là où l'application le lit.
    const v = db.prepare('SELECT md_path FROM review_version WHERE mr_id = ?').get(m.id);
    assert.match(fs.readFileSync(v.md_path, 'utf8'), /Deux constats/);
    assert.equal(store.enRetard(), 0, 'ce qu’on vient d’importer n’est pas « sale »');
  });

  test('le retour de l’IA d’une session revient, et la cible sait où il est', () => {
    /* CE QU'ON VIENT LIRE TROIS SEMAINES PLUS TARD. Le texte de chaque itération voyage dans le
       fichier de sa passe ; le POINTEUR de la cible, lui, désigne un fichier du disque local et
       se recalcule donc à l'arrivée — sur la passe la plus récente, comme le fait le pipeline.
       Sans ce recalcul, la session s'ouvrait en annonçant « aucun retour » alors que le texte
       était bien là, à côté. */
    const now = new Date().toISOString();
    /* `shared = 1` : une session est PRIVÉE par défaut depuis qu'elle se partage une par une.
       Ce test-ci parle de l'aller-retour, pas de la case — on la coche donc explicitement. */
    const taskId = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, status, shared, created_at, updated_at)
      VALUES (?, 'code', 'Ajoute le paiement en 3 fois', 'feat/pay', 'pushed', 1, ?, ?)`).run(repoId, now, now).lastInsertRowid;
    const tgId = db.prepare(`INSERT INTO task_target (task_id, repo_id, branch, status, updated_at)
      VALUES (?, ?, 'feat/pay', 'pushed', ?)`).run(taskId, repoId, now).lastInsertRowid;
    const passe = (n, texte) => {
      const f = path.join(process.env.MERGERIE_DATA_DIR, `passe-${n}.md`);
      fs.writeFileSync(f, texte);
      db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
        VALUES ('task', ?, ?, ?, 'run', 'fais-le', ?, ?)`).run(taskId, tgId, n, f, now);
    };
    passe(1, 'première itération');
    passe(2, 'ce que l’IA a répondu en dernier');
    db.prepare('UPDATE task_target SET output_path = ? WHERE id = ?')
      .run(path.join(process.env.MERGERIE_DATA_DIR, 'passe-2.md'), tgId);
    store.ecouler();

    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM agent_pass'); db.exec('DELETE FROM task_target'); db.exec('DELETE FROM task');
    db.pragma('foreign_keys = ON');
    const bilan = store.hydraterTout();
    assert.deepEqual(bilan.orphelins, [], bilan.orphelins.join('\n'));

    const tg = db.prepare('SELECT id, output_path FROM task_target').get();
    assert.ok(tg, 'la cible doit revenir');
    assert.ok(tg.output_path, 'sans pointeur, l’écran annonce « aucun retour »');
    assert.equal(fs.readFileSync(tg.output_path, 'utf8'), 'ce que l’IA a répondu en dernier',
      'le pointeur vise la passe la plus RÉCENTE, pas la première');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_pass WHERE scope = 'task'").get().n, 2);
  });

  test('supprimer une ligne retire son fichier — un orphelin la ferait revenir', () => {
    const repo = db.prepare("SELECT rowid AS r FROM repo WHERE project = 'acme/api'").get();
    assert.ok(store.existe('repos/gitlab/acme/api.json'));
    db.prepare('DELETE FROM repo WHERE rowid = ?').run(repo.r);
    const bilan = store.ecouler();
    assert.ok(bilan.supprimes >= 1);
    assert.equal(store.existe('repos/gitlab/acme/api.json'), false);
    assert.ok(store.existe('repos/gitlab/acme/web.json'), 'le balayage ne doit pas emporter les voisins');
  });

  test('la file survit à la coupure — elle est dans la base, pas en mémoire', () => {
    /* C'est ce qui rend l'ensemble sûr : le processus peut mourir entre la ligne et le fichier,
       le démarrage suivant trouve la file et écrit ce qui manque. */
    /* `shared = 1` : une todo est personnelle par défaut depuis qu'elle se partage une par une.
       Ce test-ci parle de la FILE, pas de la case — on la coche donc explicitement. */
    db.prepare(`INSERT INTO todo (title, status, priority, shared, created_at, updated_at)
      VALUES ('Relire la file', 'open', 'normal', 1, ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
    const enFile = db.prepare("SELECT COUNT(*) n FROM store_sale WHERE tbl = 'todo'").get().n;
    assert.ok(enFile >= 1, 'la file vit dans SQLite, donc elle traverse un arrêt brutal');
    store.ecouler();
    const uid = db.prepare("SELECT uid FROM todo WHERE title = 'Relire la file'").get().uid;
    assert.ok(store.existe(`todos/${uid}.json`));
  });
});
