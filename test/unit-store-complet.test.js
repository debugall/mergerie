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
 * — L'ALLER-RETOUR COMPLET, sur la chaîne la plus profonde qui voyage : merge request → review →
 *   version → constats. `repo`, lui, n'en fait plus partie — la liste des dépôts suivis est
 *   locale — et c'est justement ce qui nuance « supprimer `reviewer.db` et tout retrouver » :
 *   le travail accumulé sur un dépôt revient, la liste des dépôts qu'on suivait, elle, ne revient
 *   que si on la retape.
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
    store = require('../src/data/store');
    registre = require('../src/data/store-registry');
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
    const ruleId = db.prepare(`INSERT INTO review_rule (branch_match, content, enabled, created_at)
      VALUES ('feat/', 'Vérifie les tests', 1, ?)`).run(now).lastInsertRowid;
    assert.ok(store.enRetard() > 0, 'le déclencheur doit avoir noté la ligne');
    store.ecouler();
    const uid = db.prepare('SELECT uid FROM review_rule WHERE id = ?').get(ruleId).uid;
    const doc = JSON.parse(store.lireFichier(`rules/${uid}.json`));
    assert.equal(doc.branch_match, 'feat/');
    assert.equal(doc.content, 'Vérifie les tests');
    assert.equal(store.enRetard(), 0, 'la file doit être vide une fois écoulée');
  });

  /* `repo` A REJOINT DOCKER, JENKINS, GIT ET JIRA : une machine et ce qu'elle suit, pas un
     travail accumulé. Partagée, elle faisait apparaître chez tout le monde les dépôts ajoutés
     par un seul, avec leur clonage et la découverte de leurs merge requests au démarrage
     suivant — sans case à cocher pour la refuser. */
  test('repo est locale : chacun garde sa propre liste, rien n’en part dans le dépôt d’équipe', () => {
    const now = new Date().toISOString();
    repoId = db.prepare(`INSERT INTO repo (project, url, forge, enabled, fetch_mrs, created_at)
      VALUES ('acme/web', 'https://x.test/a.git', 'gitlab', 1, 1, ?)`).run(now).lastInsertRowid;
    assert.equal(store.enRetard(), 0, 'aucun déclencheur ne note plus la ligne : la liste est à chacun');
    assert.equal(registre.cheminDe('repo', { forge: 'gitlab', project: 'acme/web' }), null,
      'repo n’a plus de gabarit de fichier');
  });

  test('une ligne FILLE marque son parent : elle n’a pas de fichier à elle', () => {
    const now = new Date().toISOString();
    const verifierId = db.prepare(`INSERT INTO verifier (name, command, created_at) VALUES ('Tests unitaires', '', ?)`)
      .run(now).lastInsertRowid;
    store.ecouler();
    db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(verifierId, 'npm test');
    assert.ok(store.enRetard() > 0);
    store.ecouler();
    const uidV = db.prepare('SELECT uid FROM verifier WHERE id = ?').get(verifierId).uid;
    assert.deepEqual(JSON.parse(store.lireFichier(`verifiers/${uidV}.json`)).commands, ['npm test']);
  });

  test('repo_link et repo_jenkins restent locaux, comme repo lui-même : rien ne se propage', () => {
    const autre = db.prepare(`INSERT INTO repo (project, url, forge, enabled, created_at)
      VALUES ('acme/api', 'https://x.test/b.git', 'gitlab', 1, ?)`).run(new Date().toISOString()).lastInsertRowid;
    db.prepare("INSERT INTO repo_link (repo_id, linked_repo_id, branch) VALUES (?, ?, 'main')").run(repoId, autre);
    /* LES JOBS JENKINS NE SONT PLUS DANS AUCUN FICHIER : l'onglet Jenkins décrit une machine et
       ses accès, pas un travail accumulé — et depuis, `repo` non plus. */
    db.prepare("INSERT INTO repo_jenkins (repo_id, job_path, param) VALUES (?, 'deploy/web', 'BRANCH')").run(repoId);
    assert.equal(store.enRetard(), 0, 'trois tables locales : aucune n’écrit dans le dépôt d’équipe');
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
    /* `repo` ET `repo_link` N'EN FONT PLUS PARTIE : locaux, ils n'ont pas de fichier, donc pas de
       retour possible — voir le test dédié plus bas. Ce qui reste à prouver ici, c'est que la
       merge request, sa review, ses versions et ses constats voyagent intégralement tant que le
       dépôt qui les ancre est encore là, ce qu'il est : ce test ne le touche pas. */
    const T = ['mr', 'review', 'review_version', 'finding'];
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
    /* CE QU'ON VIENT D'IMPORTER N'EST PAS « SALE » : aucune ÉCRITURE en attente. Le balayage,
       lui, reste armé — ce test efface six tables d'un coup, et chaque suppression demande de
       comparer le dossier aux lignes restantes. L'hydratation ne jette plus ce qui attendait
       avant elle (une ligne gardée faute de dépendance, un traitement de fond) : elle ne peut
       donc pas non plus désarmer un balayage qu'une vraie suppression aurait demandé. */
    assert.equal(db.prepare('SELECT COUNT(*) n FROM store_sale').get().n, 0,
      'ce qu’on vient d’importer n’est pas « sale »');
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
    const now = new Date().toISOString();
    const aGarder = db.prepare(`INSERT INTO review_rule (branch_match, content, enabled, created_at)
      VALUES ('main', 'Règle à garder', 1, ?)`).run(now).lastInsertRowid;
    const aSupprimer = db.prepare(`INSERT INTO review_rule (branch_match, content, enabled, created_at)
      VALUES ('hotfix/', 'Règle éphémère', 1, ?)`).run(now).lastInsertRowid;
    store.ecouler();
    const uidGarder = db.prepare('SELECT uid FROM review_rule WHERE id = ?').get(aGarder).uid;
    const uidSupprimer = db.prepare('SELECT uid FROM review_rule WHERE id = ?').get(aSupprimer).uid;
    assert.ok(store.existe(`rules/${uidSupprimer}.json`));

    db.prepare('DELETE FROM review_rule WHERE id = ?').run(aSupprimer);
    const bilan = store.ecouler();
    assert.ok(bilan.supprimes >= 1);
    assert.equal(store.existe(`rules/${uidSupprimer}.json`), false);
    assert.ok(store.existe(`rules/${uidGarder}.json`), 'le balayage ne doit pas emporter les voisins');
  });

  test('repo et repo_link ne reviennent pas d’une réhydratation : ils n’ont pas de fichier', () => {
    /* LE PENDANT EXACT DU TEST « chaîne entière » CI-DESSUS : ce qu'il exclut délibérément de T,
       ce test le vérifie explicitement. Posé en dernier, après que tout ce qui dépendait encore
       de `repoId` (les tâches, les passes d'agent) a fini de s'en servir : supprimer `repo` ici
       ne doit plus rien casser derrière. */
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM repo_link');
    db.exec('DELETE FROM repo');
    db.pragma('foreign_keys = ON');
    /* Les fichiers de `mr`, `review` et des sessions désignent encore ce dépôt par sa clé
       naturelle (« gitlab/acme/web ») : sans lui, ils le SIGNALENT au lieu de le deviner — le
       même comportement qu'une couverture de vérificateur visant un dépôt qu'un collègue n'a
       pas ajouté. Ce n'est pas ce que ce test surveille : ce qui compte est que `repo`, lui, ne
       revienne PAS. */
    store.hydraterTout();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM repo').get().n, 0,
      'la liste des dépôts suivis est locale : rien dans le dépôt d’équipe ne la reconstitue');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM repo_link').get().n, 0);
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

  /* UNE LIGNE QUI NE SAIT PAS ENCORE DEVENIR UN FICHIER RESTE DANS LA FILE.
     C'était l'intention écrite au-dessus du `catch`, et elle ne s'appliquait pas : un
     `oublier.run()` inconditionnel suivait, et retirait la ligne de toute façon. Une passe dont
     le chemin ne se calculait pas disparaissait donc POUR TOUJOURS — pas de fichier, file vide,
     aucune trace. Vu de l'équipe : un suivi qui n'arrive jamais chez personne. Vu en vrai, sur
     une vraie base : deux suivis évaporés sur sept.
     On reproduit la panne exactement : une passe dont la session ne se résout pas (le chemin
     `sessions/{session}/…` ne peut pas être écrit), puis la session apparaît. */
  test('une ligne qui ne sait pas ENCORE devenir un fichier attend, elle ne s’évapore pas', () => {
    const now = new Date().toISOString();
    /* LE CAS DU COMMENTAIRE, MOT POUR MOT : une passe dont la « session » ne se résout pas
       encore. Une passe de REVIEW appartient à la merge request — produit d'équipe, donc
       toujours partagée : rien ne la retient, et pourtant son chemin se calcule à partir de la
       MR. Sans elle, `cheminDe` refuse de nommer le fichier. C'est le « pas encore » que la
       file existe pour absorber. (`agent_pass` n'a pas de clé étrangère : deux tables parentes
       possibles selon le scope — c'est ce qui rend la situation atteignable.) */
    const absente = 999999;
    db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
      VALUES ('review', ?, 0, 1, 'question', 'la question qui doit finir par partir', NULL, ?)`)
      .run(absente, now);
    const rid = db.prepare("SELECT rowid AS r FROM agent_pass WHERE scope = 'review' AND task_id = ?").get(absente).r;
    /* `>= 1` : la file accepte les doublons — `INSERT OR IGNORE` ne fonctionne pas dans un
       déclencheur SQLite. Ce qui compte est qu'elle y soit, pas combien de fois. */
    const enFile = () => db.prepare("SELECT COUNT(*) n FROM store_sale WHERE tbl = 'agent_pass' AND rid = ?").get(rid).n;
    assert.ok(enFile() >= 1, 'le déclencheur l’a bien mise dans la file');
    store.ecouler();
    assert.ok(enFile() >= 1, 'elle doit ATTENDRE sa merge request, pas disparaître de la file');

    /* La MR apparaît : le passage suivant écrit le fichier, sans que personne ait à y penser.
       C'est toute la promesse de la file — et elle était morte. */
    const dep = db.prepare("INSERT INTO repo (project, url, forge, enabled) VALUES ('grp/attente','https://x/grp/attente.git','gitlab',1)").run();
    db.prepare(`INSERT INTO mr (id, repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?, ?, 4242, 'MR retrouvée', 'feat/x', 'main', 'to_review', ?)`)
      .run(absente, dep.lastInsertRowid, now);
    store.ecouler();
    assert.equal(enFile(), 0, 'une fois écrite, elle quitte la file');
    const mrUid = db.prepare('SELECT uid FROM mr WHERE id = ?').get(absente).uid;
    const passUid = db.prepare('SELECT uid FROM agent_pass WHERE rowid = ?').get(rid).uid;
    assert.ok(store.lireFichier(`sessions/${mrUid}/pass-${passUid}.md`) !== null,
      'et le fichier finit par exister : c’est tout ce qu’on lui demandait');
  });

  /* CE QUI ATTENDAIT DANS LA FILE SURVIT À UNE HYDRATATION.
     L'hydratation vidait la file entière à la fin — les lignes qu'elle venait d'écrire, mais
     aussi tout ce qui attendait AVANT : une ligne gardée faute de dépendance résolue, et ce
     qu'un traitement de fond avait écrit sans qu'aucune requête ne l'écoule. Ces fichiers-là
     n'auraient plus été écrits qu'à la prochaine modification de leur ligne, c'est-à-dire
     peut-être jamais. */
  test('une hydratation ne jette pas ce qui attendait déjà dans la file', () => {
    const now = new Date().toISOString();
    // Une passe de review dont la merge request n'existe pas : elle attend, c'est son droit.
    db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
      VALUES ('review', 888888, 0, 1, 'question', 'en attente de sa MR', NULL, ?)`).run(now);
    const rid = db.prepare("SELECT rowid AS r FROM agent_pass WHERE scope = 'review' AND task_id = 888888").get().r;
    store.ecouler();
    const enFile = () => db.prepare("SELECT COUNT(*) n FROM store_sale WHERE tbl = 'agent_pass' AND rid = ?").get(rid).n;
    assert.ok(enFile() >= 1, 'elle doit attendre : c’est le décor du test');

    store.hydraterFichiers([]);       // une hydratation qui n'apporte rien, mais qui vidait tout
    assert.ok(enFile() >= 1, 'l’hydratation ne doit pas emporter ce qui attendait avant elle');
  });

  /* UNE TABLE VIDE NE VIDE PAS LE DÉPÔT.
     Base neuve devant un clone plein : plus aucune ligne ne protège de fichier, et le premier
     balayage retirait tout ce que la table avait dans le dépôt — puis le poussait. Supprimer sa
     dernière note, elle, ne retire qu'un fichier : ce cas-là doit continuer de passer. */
  test('un balayage ne vide pas le dépôt quand la table, elle, est vide', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 12; i += 1) {
      db.prepare(`INSERT INTO note_page (slug, title, content, shared, created_at, updated_at)
        VALUES (?, ?, 'contenu', 1, ?, ?)`).run(`balayage-${i}`, `Balayage ${i}`, now, now);
    }
    store.ecouler();
    const compter = () => store.listerFichiers('notes').filter((f) => f.includes('balayage-')).length;
    assert.ok(compter() >= 12, `les douze pages doivent être dans le dépôt (${compter()})`);

    /* La base repart de zéro — c'est ce que fait une base neuve, pas un utilisateur : lui
       supprime page par page, et chaque balayage ne retire alors qu'un fichier. */
    db.exec('DELETE FROM note_page');
    db.exec('DELETE FROM store_sale');
    db.prepare("INSERT INTO store_menage (tbl) VALUES ('note_page')").run();
    store.ecouler();
    assert.ok(compter() >= 12,
      'le balayage doit REFUSER : douze fichiers dans le dépôt et aucune ligne ici, c’est une base non hydratée');
  });

  /* UN SEUL DOCUMENT MALFORMÉ N'EMPORTE PAS TOUTE L'HYDRATATION.
     Le commentaire du code le promettait, mais seul `upsert` était protégé : `fromFile` écrit
     sur le disque (il refuse un chemin qui sortirait du dossier de données), et son exception
     remontait jusqu'au tour. `hydrated_at` n'avançait pas, et chaque tour rejouait le même
     échec : la synchro de toute l'équipe bloquée par un fichier qu'un seul poste avait écrit. */
  test('un document qui refuse de s’hydrater n’emporte pas les autres', () => {
    const partage = path.join(process.env.MERGERIE_DATA_DIR, 'shared');
    /* L'`uid` NOMME UN DOSSIER sur le disque local : celui-ci tente d'en sortir, et
       `ecrireDisque` le refuse — depuis `fromFile`, avant tout `upsert`. */
    const piege = 'sessions/piege/session.json';
    fs.mkdirSync(path.join(partage, 'sessions', 'piege'), { recursive: true });
    fs.writeFileSync(path.join(partage, piege), JSON.stringify({
      uid: '../../../../evade', flavour: 'explore', kind: 'explore', prompt: 'où est le code ?',
      answer: 'une réponse qui veut s’écrire hors du dossier', status: 'done',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), targets: [],
    }), 'utf8');

    // Un document SAIN à côté, écrit par le store lui-même : c'est lui qui doit passer malgré l'autre.
    const now2 = new Date().toISOString();
    db.prepare(`INSERT INTO note_page (slug, title, content, shared, created_at, updated_at)
      VALUES ('temoin-sain', 'Témoin sain', 'du contenu', 1, ?, ?)`).run(now2, now2);
    store.ecouler();
    const sain = store.listerFichiers('notes').find((f) => f.includes('temoin-sain') && f.endsWith('.md'));
    assert.ok(sain, 'le décor doit porter un document sain à hydrater à côté');

    let bilan;
    assert.doesNotThrow(() => { bilan = store.hydraterFichiers([piege, sain]); },
      'un document refusé ne doit pas faire échouer l’hydratation entière');
    assert.ok(bilan.orphelins.some((o) => o.startsWith(piege)),
      `le document refusé doit être SIGNALÉ, pas avalé : ${JSON.stringify(bilan.orphelins)}`);
    assert.ok(bilan.ecrits >= 1, 'et ce qui suivait dans la liste doit être passé quand même');
  });
});
