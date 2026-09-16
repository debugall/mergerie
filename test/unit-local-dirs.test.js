'use strict';
/* LE DOSSIER D'UNE SESSION HORS DÉPÔT — désigné partout, résolu chez soi.
 *
 * « Codage hors dépôt » fait travailler l'agent EN PLACE dans un dossier de la machine, et la
 * ligne portait le chemin absolu : `/Users/amady/lin/monprojet`. Sur le Linux du collègue, il ne
 * désigne rien — alors que la SESSION, elle, mérite d'être partagée : ses passes se relisent,
 * son verdict compte.
 *
 * On sépare donc ce qui voyage (l'empreinte du chemin, son dernier segment, son propriétaire) de
 * ce qui reste (le chemin lui-même, dans `local_dir_map`). Ce que ces épreuves tiennent :
 *
 * — L'EMPREINTE NE DIT PAS LE CHEMIN. Elle voyage : elle ne doit révéler ni l'arborescence de la
 *   machine, ni le nom de l'utilisateur.
 * — DEUX ÉCRITURES DU MÊME DOSSIER DONNENT LA MÊME EMPREINTE, slash final ou non — sinon deux
 *   sessions du même dossier ne se reconnaîtraient pas.
 * — LA CASSE N'EST PAS ÉCRASÉE : sous Linux, deux dossiers ne diffèrent parfois que par elle.
 * — LE CHEMIN A QUITTÉ LA LIGNE et n'y revient pas, même après une création par l'API.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-local-dirs-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { empreinte, libelle, normaliser } = require('../src/dirhash');

describe('dirhash — l’empreinte d’un chemin, sans base', () => {
  test('40 caractères hexadécimaux, et rien du chemin ne s’y lit', () => {
    const h = empreinte('/Users/amady/lin/monprojet');
    assert.match(h, /^[0-9a-f]{40}$/);
    for (const bout of ['amady', 'Users', 'monprojet']) {
      assert.ok(!h.includes(bout), `l’empreinte laisse fuir « ${bout} »`);
    }
  });

  test('le même dossier écrit de quatre façons donne la même empreinte', () => {
    const ref = empreinte('/a/b/monprojet');
    for (const variante of ['/a/b/monprojet/', '/a/b/monprojet//', '/a/b/./monprojet', '  /a/b/monprojet  ']) {
      assert.equal(empreinte(variante), ref, `variante non reconnue : « ${variante} »`);
    }
  });

  test('la casse N’EST PAS écrasée — sous Linux, deux dossiers peuvent n’en différer que', () => {
    assert.notEqual(empreinte('/a/Projet'), empreinte('/a/projet'));
  });

  test('le libellé est le dernier segment — c’est ce que voit le collègue', () => {
    assert.equal(libelle('/Users/amady/lin/monprojet/'), 'monprojet');
    assert.equal(normaliser('/a/b/'), '/a/b');
  });
});

describe('local_dir_map — où ce dossier se trouve SUR CETTE MACHINE', () => {
  let db; let localdirs;

  before(() => {
    db = require('../src/db');
    localdirs = require('../src/localdirs');
  });

  test('déclarer range le chemin ici et rend ce qui, lui, voyage', () => {
    const { dir_hash: h, dir_label: lbl } = localdirs.declarer('/Users/amady/lin/monprojet');
    assert.equal(lbl, 'monprojet');
    assert.equal(localdirs.cheminDe(h), '/Users/amady/lin/monprojet');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM local_dir_map').get().n, 1);
    // Redéclarer ne double pas la ligne : c'est le même dossier.
    localdirs.declarer('/Users/amady/lin/monprojet/');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM local_dir_map').get().n, 1);
  });

  test('un dossier d’un AUTRE poste ne se résout pas — et se dit, plutôt que de se deviner', () => {
    const ailleurs = empreinte('/home/bob/travail/monprojet');
    assert.equal(localdirs.cheminDe(ailleurs), null);
    const ligne = localdirs.resoudre({ dir_hash: ailleurs, dir_label: 'monprojet', owner: 'bob' });
    assert.equal(ligne.path, null, 'un chemin deviné ferait travailler l’agent dans un homonyme');
    assert.equal(ligne.dir_label, 'monprojet', 'la carte doit quand même dire QUEL dossier');
    assert.equal(ligne.owner, 'bob', '… et de qui');
  });

  test('RATTACHER son propre dossier à la même empreinte n’écrit que chez soi', () => {
    /* « C'est ce dossier chez moi » : le poste range SON chemin sous l'empreinte du collègue.
       Rien ne part nulle part — `local_dir_map` est une table de famille locale. */
    const h = empreinte('/home/bob/travail/monprojet');
    db.prepare(`INSERT INTO local_dir_map (dir_hash, path, updated_at) VALUES (?, ?, ?)
                ON CONFLICT (dir_hash) DO UPDATE SET path = excluded.path`)
      .run(h, '/Users/amady/lin/monprojet', new Date().toISOString());
    assert.equal(localdirs.cheminDe(h), '/Users/amady/lin/monprojet');
  });

  test('`carte` rend tout d’un coup — une liste de sessions ne fait pas une requête par dossier', () => {
    const m = localdirs.carte();
    assert.ok(m.size >= 2);
    assert.equal(m.get(empreinte('/Users/amady/lin/monprojet')), '/Users/amady/lin/monprojet');
  });

  test('la colonne `path` de la ligne partagée reste vide — c’est tout l’enjeu', () => {
    const now = new Date().toISOString();
    const tid = db.prepare('INSERT INTO local_task (prompt, status, created_at, updated_at) VALUES (?,?,?,?)')
      .run('x', 'new', now, now).lastInsertRowid;
    const { dir_hash: h, dir_label: lbl } = localdirs.declarer('/Users/amady/lin/autre');
    db.prepare(`INSERT INTO local_task_dir (task_id, path, dir_hash, dir_label, owner, status, updated_at)
                VALUES (?, '', ?, ?, 'amady', 'new', ?)`).run(tid, h, lbl, now);
    const restants = db.prepare(
      "SELECT COUNT(*) n FROM local_task_dir WHERE path IS NOT NULL AND path <> ''",
    ).get().n;
    assert.equal(restants, 0, 'un chemin absolu en base repartirait dans le dépôt d’équipe');
  });
});
