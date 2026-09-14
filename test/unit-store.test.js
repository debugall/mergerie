'use strict';
/* LE DOSSIER DE FICHIERS EST LA BASE — et SQLite n'en est plus qu'un cache.
 *
 * C'est la bascule sur laquelle tout le partage repose : ce qu'une équipe se passe, ce sont des
 * FICHIERS, un par entité, que git sait transporter, fusionner et dater. Quatre promesses les
 * rendent utilisables à plusieurs, et ce fichier les tient une par une :
 *
 * 1. DÉTERMINISME. Deux écritures du même état donnent le même octet. Sans cela, « git status
 *    propre » ne voudrait plus dire « rien n'a changé », et chaque sauvegarde produirait un
 *    commit de bruit que personne ne relirait.
 * 2. AUCUN IDENTIFIANT DE POSTE. Un fichier ne porte que des uid et des clés naturelles : deux
 *    postes numérotent leurs lignes différemment, et `repo_id: 12` désignerait deux choses.
 * 3. L'ALLER-RETOUR EST FIDÈLE. Exporter puis réhydrater rend la même chose — c'est ce qui
 *    permet de supprimer `reviewer.db` et de tout retrouver.
 * 4. LA BASE NE PEUT PAS ÊTRE EN AVANCE. Si le fichier ne s'écrit pas, la ligne non plus.
 *    « Enregistré » ne doit jamais vouloir dire « enregistré ici seulement ».
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-store-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const MSGS = {
  titreVide: 'titre vide', inconnue: 'inconnue', tropProfond: 'trop profond', soiMeme: 'soi-même',
  prioriteInvalide: 'priorité', dateInvalide: 'date', lienInvalide: 'lien', statutInvalide: 'statut',
};

describe('store — la sérialisation qui ne bouge pas', () => {
  const { serialize } = require('../src/store');

  test('l’ordre des clés à l’écriture ne change pas le fichier', () => {
    const a = serialize({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = serialize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    assert.equal(a, b, 'sinon chaque sauvegarde produirait un diff de bruit');
  });

  test('un champ nul est OMIS, pas écrit `null`', () => {
    // « absent » et « vide » doivent produire le même octet, sinon deux postes qui ont le même
    // état s'enverraient des modifications l'un à l'autre sans fin.
    assert.equal(serialize({ a: 1, b: null, c: undefined }), '{\n  "a": 1\n}\n');
  });

  test('un tableau garde son ordre — il porte du sens', () => {
    // Les commandes d'un vérificateur : `npm ci` avant `npm test`.
    assert.match(serialize({ cmds: ['npm ci', 'npm test'] }), /"npm ci",\n\s+"npm test"/);
  });

  test('le fichier finit par une nouvelle ligne', () => {
    assert.ok(serialize({ a: 1 }).endsWith('\n'), 'sans elle, git signale « \\ No newline at end of file »');
  });
});

describe('store — écrire dans le dépôt de données', () => {
  let store; let db; let notes;

  before(() => {
    db = require('../src/db');
    store = require('../src/store');
    notes = require('../src/notes');
  });

  test('un chemin qui remonte hors du dépôt est refusé', () => {
    /* Les gabarits de chemin sont remplis avec des DONNÉES — un slug, une clé de ticket, un nom
       de projet — qui traversent des formulaires. `..` y est concevable, et
       `notes/../../.ssh/config` écrirait chez l'utilisateur. */
    assert.throws(() => store.ecrireFichier('../evade.json', 'x'), /hors du dépôt/);
    assert.throws(() => store.ecrireFichier('notes/../../evade.json', 'x'), /hors du dépôt/);
  });

  test('un chemin venu du DÉPÔT ne peut pas écrire hors du dossier de données', () => {
    /* L'autre sens, et le plus dangereux : ces noms-là ne viennent pas d'un formulaire mais d'un
       fichier écrit sur un AUTRE poste. Hydrater, c'est exécuter ce que l'équipe raconte — un
       collègue dont le dépôt a été repris, ou une branche poussée par erreur, ne doit pas
       pouvoir poser un fichier dans `~/.ssh` en nommant une capture. */
    const ctx = store.contexte();
    assert.throws(() => ctx.ecrireDisque('notes/../../..', 'authorized_keys', 'x'),
      /hors du dossier de données/);
    assert.throws(() => ctx.ecrireDisque('notes/1', '../../../evade', 'x'),
      /hors du dossier de données/);
    /* La copie d'un binaire, elle, rend `null` : une vignette refusée ne doit pas faire échouer
       toute la passe d'hydratation — mais elle ne doit rien écrire non plus. */
    assert.equal(ctx.copierDepuisDepot('../../etc/hosts', 'notes/1', 'vol.png'), null);
    assert.equal(ctx.copierDepuisDepot('notes/x.png', 'notes/1', '../../../evade.png'), null);
  });

  test('créer une page écrit ses DEUX fichiers : le corps lisible et ses métadonnées', () => {
    const page = notes.creerPage({ title: 'Déploiement prod', content: '# Prod\n\nUn paragraphe.' }, MSGS);
    assert.equal(store.lireFichier('notes/deploiement-prod.md'), '# Prod\n\nUn paragraphe.',
      'le corps du .md EST la page : une note exportée doit se relire hors de l’outil');
    const meta = JSON.parse(store.lireFichier('notes/deploiement-prod.json'));
    assert.equal(meta.title, 'Déploiement prod');
    assert.equal(meta.uid, db.prepare('SELECT uid FROM note_page WHERE id = ?').get(page.id).uid);
    assert.ok(!('id' in meta), 'un identifiant de poste n’a rien à faire dans un fichier partagé');
    assert.ok(!('parent_id' in meta), 'le parent se désigne par son slug, pas par un id');
  });

  test('renommer la page ne déplace pas son fichier — son historique git reste le sien', () => {
    const page = notes.creerPage({ title: 'Bascule', content: 'a' }, MSGS);
    notes.majPage(page.id, { title: 'Bascule v2' }, MSGS);
    assert.ok(store.existe('notes/bascule.md'));
    assert.ok(!store.existe('notes/bascule-v2.md'));
    assert.equal(JSON.parse(store.lireFichier('notes/bascule.json')).title, 'Bascule v2');
  });

  test('supprimer une page emporte ses fichiers ET ceux de ses sous-pages', () => {
    const mere = notes.creerPage({ title: 'Mère', content: 'm' }, MSGS);
    notes.creerPage({ title: 'Fille', content: 'f', parent_id: mere.id }, MSGS);
    assert.ok(store.existe('notes/fille.md'));
    notes.supprimerPage(mere.id, MSGS);
    assert.ok(!store.existe('notes/mere.md'));
    assert.ok(!store.existe('notes/fille.md'),
      'un fichier orphelin ferait revenir la page à la prochaine hydratation');
  });

  test('si le fichier ne s’écrit pas, la ligne n’est pas écrite non plus', () => {
    /* La garantie qui compte. On rend l'écriture impossible en plaçant un DOSSIER là où le
       fichier doit aller : `rename` échoue, la transaction SQLite revient en arrière. */
    const avant = db.prepare('SELECT COUNT(*) n FROM todo').get().n;
    const bloque = path.join(process.env.MERGERIE_DATA_DIR, 'shared', 'todos');
    fs.rmSync(bloque, { recursive: true, force: true });
    fs.writeFileSync(bloque, 'je suis un fichier, pas un dossier');
    assert.throws(() => notes.creerTodo({ title: 'Ne doit pas exister' }, MSGS));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM todo').get().n, avant,
      '« enregistré » ne doit jamais vouloir dire « enregistré ici seulement »');
    fs.rmSync(bloque, { force: true });
  });
});

describe('store — l’aller-retour par les fichiers', () => {
  let store; let db; let notes;

  before(() => {
    db = require('../src/db');
    store = require('../src/store');
    notes = require('../src/notes');
  });

  test('effacer la base et réhydrater rend les mêmes lignes', () => {
    notes.creerPage({ title: 'Aller-retour', content: 'du **markdown**' }, MSGS);
    notes.creerTodo({ title: 'Relire la spec', priority: 'high' }, MSGS);
    const avant = {
      pages: db.prepare('SELECT uid, slug, title, content, parent_id FROM note_page ORDER BY uid').all(),
      todos: db.prepare('SELECT uid, title, priority, status FROM todo ORDER BY uid').all(),
    };
    assert.ok(avant.pages.length >= 2 && avant.todos.length >= 1);

    db.exec('DELETE FROM note_page');
    db.exec('DELETE FROM todo');
    const bilan = store.hydraterTout();
    assert.ok(bilan.ecrits > 0);
    assert.deepEqual(bilan.orphelins, []);

    const apres = {
      pages: db.prepare('SELECT uid, slug, title, content, parent_id FROM note_page ORDER BY uid').all(),
      todos: db.prepare('SELECT uid, title, priority, status FROM todo ORDER BY uid').all(),
    };
    /* Les `parent_id` sont des entiers REATTRIBUÉS : on compare donc l'arborescence par slug,
       pas par id — c'est précisément la différence entre les deux postes d'une équipe. */
    const parSlug = (l) => l.map((p) => ({ ...p, parent_id: p.parent_id ? 'a un parent' : null }));
    assert.deepEqual(parSlug(apres.pages), parSlug(avant.pages));
    assert.deepEqual(apres.todos, avant.todos);
  });

  test('une sous-page arrivée AVANT son parent retrouve son parent', () => {
    /* Rien ne dit dans quel ordre git rend ses fichiers. On hydrate volontairement à l'envers. */
    const mere = notes.creerPage({ title: 'Zèbre', content: 'z' }, MSGS);
    notes.creerPage({ title: 'Abeille', content: 'a', parent_id: mere.id }, MSGS);
    db.exec('DELETE FROM note_page');
    store.hydraterFichiers(['notes/abeille.md', 'notes/zebre.md']);   // l'enfant d'abord
    const fille = db.prepare("SELECT parent_id FROM note_page WHERE slug = 'abeille'").get();
    const mereApres = db.prepare("SELECT id FROM note_page WHERE slug = 'zebre'").get();
    assert.equal(fille.parent_id, mereApres.id, 'la seconde passe doit rattraper la référence');
  });

  test('un fichier disparu supprime sa ligne', () => {
    notes.creerPage({ title: 'Éphémère', content: 'x' }, MSGS);
    store.supprimerFichier('notes/ephemere.md');
    store.supprimerFichier('notes/ephemere.json');
    const bilan = store.hydraterFichiers(['notes/ephemere.md']);
    assert.equal(bilan.supprimes, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM note_page WHERE slug = 'ephemere'").get().n, 0);
  });

  test('un dépôt écrit par une version plus récente est REFUSÉ, pas hydraté à moitié', () => {
    assert.ok(store.existe(store.MARQUEUR), 'le dépôt se présente dès sa première ligne écrite');
    store.ecrireFichier(store.MARQUEUR, store.serialize({ created_by: 'mergerie 9.9.9', schema: store.SCHEMA + 1 }));
    assert.equal(store.verifierFormat().ok, false);
    assert.throws(() => store.hydraterTout(), /mettez Mergerie à jour/i);
    store.marquer();
    assert.equal(store.verifierFormat().ok, true);
  });
});

describe('store — ce à quoi une todo est accrochée voyage, ou ne voyage pas', () => {
  let store; let db; let notes; let mrId;

  before(() => {
    db = require('../src/db');
    store = require('../src/store');
    notes = require('../src/notes');
    const now = new Date().toISOString();
    const repo = db.prepare(`INSERT INTO repo (project, url, forge, enabled, created_at)
      VALUES ('acme/web', 'https://x.test/a.git', 'gitlab', 1, ?)`).run(now).lastInsertRowid;
    mrId = db.prepare(`INSERT INTO mr (repo_id, iid, title, status, updated_at)
      VALUES (?, 218, 'Paiement 3×', 'to_review', ?)`).run(repo, now).lastInsertRowid;
  });

  test('une merge request est désignée par sa clé naturelle, pas par son id', () => {
    const todo = notes.creerTodo({ title: 'Suivre !218', link_kind: 'mr', link_ref: String(mrId) }, MSGS);
    const uid = db.prepare('SELECT uid FROM todo WHERE id = ?').get(todo.id).uid;
    const doc = JSON.parse(store.lireFichier(`todos/${uid}.json`));
    assert.equal(doc.link_ref, 'gitlab/acme/web!218');
    assert.ok(!/^\d+$/.test(doc.link_ref), 'un id entier désignerait autre chose chez le voisin');
  });

  test('… et se retrouve à l’hydratation', () => {
    db.exec('DELETE FROM todo');
    store.hydraterTout();
    const todo = db.prepare("SELECT * FROM todo WHERE title = 'Suivre !218'").get();
    assert.equal(todo.link_kind, 'mr');
    assert.equal(todo.link_ref, String(mrId));
  });

  test('une désignation inconnue fait perdre le LIEN, jamais la todo', () => {
    /* Mieux vaut un bouton en moins qu'un bouton qui mène à la mauvaise merge request. */
    const uid = db.prepare("SELECT uid FROM todo WHERE title = 'Suivre !218'").get().uid;
    const doc = JSON.parse(store.lireFichier(`todos/${uid}.json`));
    doc.link_ref = 'gitlab/inconnu/projet!999';
    store.ecrireFichier(`todos/${uid}.json`, store.serialize(doc));
    store.hydraterFichiers([`todos/${uid}.json`]);
    const todo = db.prepare("SELECT * FROM todo WHERE title = 'Suivre !218'").get();
    assert.ok(todo, 'la todo doit survivre');
    assert.equal(todo.link_ref, null);
    assert.equal(todo.link_kind, null, 'un genre sans référence donnerait un bouton qui ne mène nulle part');
  });

  test('le rappel déjà affiché ne part PAS dans le dépôt', () => {
    // `reminded_at` dit « cette machine a montré la notification » : partagé, il éteindrait le
    // rappel du collègue, qui, lui, ne l'a jamais vu.
    const todo = notes.creerTodo({ title: 'Avec échéance', due_at: '2026-12-01' }, MSGS);
    notes.marquerNotifie(todo.id, MSGS);
    const uid = db.prepare('SELECT uid FROM todo WHERE id = ?').get(todo.id).uid;
    const doc = JSON.parse(store.lireFichier(`todos/${uid}.json`));
    assert.ok(!('reminded_at' in doc), 'le fait d’avoir été prévenu est personnel');
    assert.ok(db.prepare('SELECT reminded_at FROM todo WHERE id = ?').get(todo.id).reminded_at);
  });
});
