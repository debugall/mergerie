'use strict';
/* L'IDENTITÉ QUI SURVIT AU PARTAGE.
 *
 * Les entiers auto-incrémentés sont locaux par nature : deux postes créent chacun le dépôt
 * n° 12, deux reviews de la même MR reçoivent chacune la version 2. Quand le travail accumulé
 * part dans un dépôt git d'équipe, ces numéros se télescopent, et il n'y a personne pour
 * arbitrer — c'est tout l'intérêt d'une synchronisation sans serveur.
 *
 * CE QUE CES ÉPREUVES TIENNENT :
 *
 * — LE DÉCLENCHEUR POSE L'UID TOUT SEUL. C'est le point de conception : aucun des ~100 `INSERT`
 *   de l'application n'a à y penser, donc aucun ne peut l'oublier. Le test insère « à l'ancienne »,
 *   sans mentionner `uid`, exactement comme le fait le reste du code.
 * — L'ORDRE DES UID EST L'ORDRE DE CRÉATION. C'est ce qui remplace les compteurs partagés :
 *   les versions de review et les passes d'agent se renumérotent en lisant les uids dans
 *   l'ordre. Un ULID dont l'horodatage ne serait pas en tête casserait cette promesse en
 *   silence — les numéros seraient simplement dans le désordre chez le voisin.
 * — LA REPRISE D'UNE BASE EXISTANTE respecte cet ordre, au lieu de dater toutes les lignes de
 *   l'instant de la migration.
 * — LE SLUG EST FIGÉ. Renommer un agent ne déplace pas son dossier.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-uid-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { ulid, estUlid, instantDe, slugifier, slugLibre } = require('../src/core/ulid');
const registre = require('../src/data/store-registry');

describe('ulid — l’identité sans coordination', () => {
  test('26 caractères de l’alphabet Crockford, sans I, L, O ni U', () => {
    for (let i = 0; i < 200; i++) {
      const u = ulid();
      assert.equal(u.length, 26);
      assert.ok(estUlid(u), `forme invalide : ${u}`);
      assert.doesNotMatch(u, /[ILOU]/, 'ces quatre lettres se confondent à la lecture');
    }
  });

  test('deux tirages ne se rencontrent pas, même dans la même milliseconde', () => {
    const t = Date.now();
    const vus = new Set();
    for (let i = 0; i < 5000; i++) vus.add(ulid(t));
    assert.equal(vus.size, 5000, 'la partie aléatoire fait 80 bits : une collision ici serait un bug');
  });

  test('le tri alphabétique EST le tri chronologique', () => {
    // C'est la propriété sur laquelle repose toute la renumérotation des versions et des passes.
    const t = Date.now();
    const suite = [0, 1, 2, 999, 100000, 10 ** 9].map((d) => ulid(t + d));
    assert.deepEqual([...suite].sort(), suite);
  });

  test('l’horodatage se relit — à la milliseconde près', () => {
    const t = 1_700_000_000_123;
    assert.equal(instantDe(ulid(t)), t);
    assert.equal(instantDe('pas-un-ulid'), null);
  });

  test('slugifier écrase les accents, la casse et la ponctuation, et ne rend jamais vide', () => {
    assert.equal(slugifier('Déploiement prod !!'), 'deploiement-prod');
    assert.equal(slugifier('  A—B  '), 'a-b');
    assert.equal(slugifier('###'), 'sans-nom', 'un slug vide donnerait le fichier « .json »');
    assert.ok(slugifier('x'.repeat(200)).length <= 60, 'un nom de fichier ne se laisse pas déborder');
    assert.doesNotMatch(slugifier(`${'x'.repeat(59)} suite`), /-$/, 'jamais de tiret en fin de slug');
  });

  test('slugLibre suffixe -2, -3 plutôt que d’écraser', () => {
    const pris = new Set(['agent', 'agent-2']);
    assert.equal(slugLibre('Agent', (s) => pris.has(s)), 'agent-3');
    assert.equal(slugLibre('Autre', (s) => pris.has(s)), 'autre');
  });
});

describe('uid — posé par la base, jamais par l’appelant', () => {
  let db;
  before(() => { db = require('../src/db'); });

  test('chaque table déclarée `uidPropre` a bien sa colonne, son index unique et son déclencheur', () => {
    const attendues = registre.REGISTRE.filter((e) => e.uidPropre).map((e) => e.table);
    assert.ok(attendues.length >= 30, 'le registre a perdu ses tables partagées ?');
    const declencheurs = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    ).all().map((r) => r.name));
    const manques = [];
    for (const table of attendues) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes('uid')) manques.push(`${table} : pas de colonne uid`);
      const idx = db.prepare(`PRAGMA index_list(${table})`).all();
      if (!idx.some((i) => i.name === `idx_${table}_uid` && i.unique)) manques.push(`${table} : index uid non unique`);
      if (!declencheurs.has(`trg_${table}_uid`)) manques.push(`${table} : pas de déclencheur`);
    }
    assert.deepEqual(manques, [], manques.join('\n'));
  });

  test('un INSERT qui ignore `uid` — comme les cent autres du code — en reçoit un quand même', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO todo (title, priority, status, created_at, updated_at)
                VALUES ('relire !42', 'normal', 'open', ?, ?)`).run(now, now);
    const r = db.prepare("SELECT uid FROM todo WHERE title = 'relire !42'").get();
    assert.ok(estUlid(r.uid), `uid absent ou mal formé : ${r.uid}`);
  });

  test('un INSERT qui FOURNIT un uid le garde — c’est par là qu’entrera la synchro', () => {
    const now = new Date().toISOString();
    const mien = ulid();
    db.prepare(`INSERT INTO todo (uid, title, priority, status, created_at, updated_at)
                VALUES (?, 'venue d’ailleurs', 'normal', 'open', ?, ?)`).run(mien, now, now);
    assert.equal(db.prepare("SELECT uid FROM todo WHERE title = 'venue d’ailleurs'").get().uid, mien);
  });

  test('deux lignes ne peuvent pas porter le même uid', () => {
    const now = new Date().toISOString();
    const u = db.prepare("SELECT uid FROM todo WHERE title = 'relire !42'").get().uid;
    assert.throws(() => db.prepare(`INSERT INTO todo (uid, title, priority, status, created_at, updated_at)
      VALUES (?, 'doublon', 'normal', 'open', ?, ?)`).run(u, now, now), /UNIQUE/);
  });

  test('l’ordre des uid suit l’ordre de création — ce qui remplace les compteurs partagés', () => {
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO git_command (label, command, sort_order, created_at)
                            VALUES (?, 'status', 0, ?)`);
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push(Number(ins.run(`c${i}`, now).lastInsertRowid));
    const parId = db.prepare(`SELECT uid FROM git_command WHERE id IN (${ids.join(',')}) ORDER BY id`).all().map((r) => r.uid);
    assert.deepEqual([...parId].sort(), parId, 'trier par uid doit rendre l’ordre de création');
  });

  test('versions de review et passes d’agent : l’ordre des uid EST l’ordre des numéros', () => {
    /* Ce sont les deux cas que la spécification nomme : `review_version.version` et
       `agent_pass.n` deviennent DÉRIVÉS — on les renumérote en relisant les uids. Si les deux
       ordres divergeaient, la review v3 d'un collègue s'afficherait avant sa v2, sans erreur
       et sans que rien ne le signale. */
    const now = new Date().toISOString();
    const repo = db.prepare(`INSERT INTO repo (project, url, enabled, created_at)
      VALUES ('grp/app', 'https://x.test/a.git', 1, ?)`).run(now).lastInsertRowid;
    const mr = db.prepare(`INSERT INTO mr (repo_id, iid, title, status, updated_at)
      VALUES (?, 7, 'Paiement 3×', 'to_review', ?)`).run(repo, now).lastInsertRowid;
    for (let v = 1; v <= 6; v++) {
      db.prepare(`INSERT INTO review_version (mr_id, version, md_path, kind, created_at)
        VALUES (?, ?, ?, 'review', ?)`).run(mr, v, `/tmp/r-v${v}.md`, now);
    }
    const versions = db.prepare('SELECT version, uid FROM review_version WHERE mr_id = ? ORDER BY uid').all(mr);
    assert.deepEqual(versions.map((r) => r.version), [1, 2, 3, 4, 5, 6]);

    const task = db.prepare(`INSERT INTO task (repo_id, prompt, branch, kind, status, created_at, updated_at)
      VALUES (?, 'code', 'feat/x', 'code', 'new', ?, ?)`).run(repo, now, now).lastInsertRowid;
    for (let n = 1; n <= 6; n++) {
      db.prepare(`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, created_at)
        VALUES ('task', ?, 1, ?, 'run', 'p', ?)`).run(task, n, now);
    }
    const passes = db.prepare('SELECT n, uid FROM agent_pass WHERE task_id = ? ORDER BY uid').all(task);
    assert.deepEqual(passes.map((r) => r.n), [1, 2, 3, 4, 5, 6]);
  });

  test('un agent renommé garde son slug — son dossier ne se déplace pas', () => {
    const ap = require('../src/agentprofile');
    const a = ap.creer({ name: 'Documentaliste', kind: 'explore' });
    const slug = db.prepare('SELECT slug FROM agent WHERE id = ?').get(a.id).slug;
    assert.equal(slug, 'documentaliste');
    ap.modifier(a.id, { name: 'Le documentaliste de l’équipe' });
    assert.equal(db.prepare('SELECT slug FROM agent WHERE id = ?').get(a.id).slug, slug,
      'un slug qui suit le nom ferait, chez les collègues, une suppression puis un ajout');
  });

  test('deux noms qui se normalisent pareil reçoivent deux slugs', () => {
    const ap = require('../src/agentprofile');
    const b = ap.creer({ name: 'documentaliste ?', kind: 'explore' });
    assert.equal(db.prepare('SELECT slug FROM agent WHERE id = ?').get(b.id).slug, 'documentaliste-2');
  });
});
