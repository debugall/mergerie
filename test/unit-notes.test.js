'use strict';
/* Notes, todos et rappels — la logique pure.
 *
 * Ce qui est testé ici ne se provoque pas facilement de bout en bout : le calendrier
 * (snooze « demain 9 h » à cheval sur un mois, archivage à J+7), les regex d'autolink et
 * leurs faux positifs, la slugification d'un titre exotique. Le reste du comportement est
 * couvert par `e2e-notes.test.js`, qui passe par de vraies requêtes HTTP.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isole la base : ces modules chargent db.js (donc paths.js) au require.
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-unit-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const notes = require('../src/notes');
const { autolink } = require('../public/notes-runtime.js');
const db = require('../src/db');

describe('autolink : les références du quotidien deviennent des liens', () => {
  const index = { mrs: { 214: [{ id: 7, project: 'grp/app' }], 99: [{ id: 1, project: 'a/b' }, { id: 2, project: 'c/d' }] }, jira: true };

  test('une MR connue sur UN seul dépôt donne un lien direct', () => {
    const html = autolink('voir !214 avant de merger', index);
    assert.match(html, /data-note-mr="7"/);
    assert.match(html, />!214</);
    assert.match(html, /title="grp\/app"/, 'le dépôt est rappelé : un numéro nu ne dit rien');
  });

  /* Le cas qui interdit de deviner : le même numéro sur plusieurs dépôts. On emmène vers la
     recherche pré-remplie plutôt que d'en désigner un au hasard — un lien faux est pire
     qu'un lien qui demande de choisir. */
  test('une MR présente sur PLUSIEURS dépôts mène à la recherche, pas à l’une d’elles', () => {
    const html = autolink('bloqué par !99', index);
    assert.match(html, /data-note-mr-search="!99"/);
    assert.doesNotMatch(html, /data-note-mr="/, 'aucun dépôt n’est choisi à la place de l’utilisateur');
    assert.match(html, /a\/b, c\/d/, 'les candidats sont nommés dans l’info-bulle');
  });

  test('une MR inconnue reste du texte : pas de lien mort', () => {
    const html = autolink('note sur !4242', index);
    assert.equal(html, 'note sur !4242');
  });

  test('les clés de ticket deviennent des liens — et seulement si Jira est configuré', () => {
    assert.match(autolink('suite de PROJ-720', index), /data-note-ticket="PROJ-720"/);
    assert.equal(autolink('suite de PROJ-720', { mrs: {}, jira: false }), 'suite de PROJ-720',
      'sans Jira configuré, un lien mènerait nulle part');
  });

  /* Faux positifs vérifiés : ce sont eux qui rendraient l'autolink pénible à l'usage. */
  test('les faux positifs sont écartés', () => {
    assert.equal(autolink('if (a !== 214) return', index), 'if (a !== 214) return',
      'le ! d’un opérateur n’est pas une merge request');
    assert.match(autolink('PROJ-720-suite', index), /^PROJ-720-suite$/,
      'une clé suivie d’un tiret n’est pas coupée en deux');
  });

  /* L'ordre échappement → autolink est le cœur de la sûreté : on vérifie qu'aucun fragment
     de la note ne peut devenir du balisage. */
  test('l’échappement est préservé : rien de la note ne devient du HTML', () => {
    const echappe = '&lt;script&gt;alert(1)&lt;/script&gt; !214';
    const html = autolink(echappe, index);
    assert.match(html, /&lt;script&gt;/, 'le contenu reste échappé');
    assert.doesNotMatch(html, /<script/, 'aucune balise n’est reconstituée');
  });

  /* Une note, c'est là qu'on colle une URL sans la relire. Elle doit être cliquable — et
     n'ouvrir que ce qu'un lien a le droit d'ouvrir. */
  test('une URL collée devient un lien, http(s) seulement', () => {
    const html = autolink('doc ici https://exemple.test/guide?a=1&amp;b=2 et voilà', index);
    assert.match(html, /<a href="https:\/\/exemple\.test\/guide\?a=1&amp;b=2" class="note-url"/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/,
      'un lien externe ne donne jamais accès à window.opener');
    assert.match(autolink('voir http://intra.test/x', index), /<a href="http:/);
  });

  test('les protocoles dangereux restent du texte', () => {
    for (const mauvais of ['javascript:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', 'vbscript:x']) {
      assert.doesNotMatch(autolink(`clic ${mauvais}`, index), /<a /,
        `${mauvais} ne doit pas devenir un lien`);
    }
  });

  /* La ponctuation qui ferme la phrase n'appartient pas au lien : la garder donnait une
     adresse en 404 au premier clic. */
  test('la ponctuation finale reste hors du lien', () => {
    const html = autolink('voir https://exemple.test/page.', index);
    assert.match(html, />https:\/\/exemple\.test\/page<\/a>\./);
  });

  /* Le piège de l'ordre : une URL Jira CONTIENT une clé de ticket. La transformer aussi
     aurait posé un second lien à l'intérieur du texte du premier. */
  test('une référence contenue dans une URL n’est pas re-transformée', () => {
    const html = autolink('ticket https://jira.demo/browse/PROJ-720 à lire', index);
    assert.equal((html.match(/<a /g) || []).length, 1, 'un seul lien : celui de l’URL');
    assert.doesNotMatch(html, /data-note-ticket/);
    // Hors d'une URL, la clé redevient un lien de ticket.
    assert.match(autolink('PROJ-720 tout seul', index), /data-note-ticket="PROJ-720"/);
  });

  test('une adresse déjà dans un attribut n’est pas re-liée', () => {
    const html = autolink('<img src="https://exemple.test/a.png" alt="x" />', index);
    assert.doesNotMatch(html, /<a /, 'le rendu Markdown produit déjà cet attribut');
  });

  test('un lien fabriqué ne peut pas être détourné par un nom de projet', () => {
    const html = autolink('!5', { mrs: { 5: [{ id: 3, project: 'a" onmouseover="x' }] }, jira: false });
    assert.doesNotMatch(html, /onmouseover="x"/, 'le nom du dépôt est échappé dans l’attribut');
    assert.match(html, /&quot;/);
  });
});

describe('snooze : repousser un rappel', () => {
  const base = new Date('2026-08-07T14:30:00');

  test('+1 h ajoute une heure', () => {
    assert.equal(notes.calculerSnooze('hour', base), new Date('2026-08-07T15:30:00').toISOString());
  });

  /* « Demain 9 h » veut dire 9 h AU CADRAN. Ajouter 24 h dériverait d'une heure au
     changement d'heure — on construit donc la date par ses composants. */
  test('« demain 9 h » vise le prochain jour calendaire à 09:00 locale', () => {
    const d = new Date(notes.calculerSnooze('tomorrow', base));
    assert.equal(d.getDate(), 8);
    assert.equal(d.getHours(), 9);
    assert.equal(d.getMinutes(), 0);
  });

  test('« demain 9 h » franchit la fin du mois', () => {
    const d = new Date(notes.calculerSnooze('tomorrow', new Date('2026-08-31T22:00:00')));
    assert.equal(d.getMonth(), 8, 'septembre');
    assert.equal(d.getDate(), 1);
    assert.equal(d.getHours(), 9);
  });

  test('un mode inconnu ne fabrique pas de date au hasard', () => {
    assert.equal(notes.calculerSnooze('la-semaine-prochaine', base), null);
  });
});

describe('rappels : reminded_at, et pourquoi il se remet à zéro', () => {
  const msgs = {
    titreVide: 'titre', inconnue: 'inconnue', prioriteInvalide: 'prio',
    statutInvalide: 'statut', dateInvalide: 'date', lienInvalide: 'lien',
  };

  test('toute nouvelle échéance re-sonne : reminded_at repart à NULL', () => {
    const t = notes.creerTodo({ title: 'appeler la plateforme', due_at: '2026-08-01T09:00:00Z' }, msgs);
    notes.marquerNotifie(t.id, msgs);
    assert.ok(notes.lireTodo(t.id).reminded_at, 'la notification est consignée');
    // C'est LE piège : snoozer un rappel déjà notifié le rendrait définitivement muet.
    const apres = notes.majTodo(t.id, { due_at: notes.calculerSnooze('hour', new Date()) }, msgs);
    assert.equal(apres.reminded_at, null, 'repoussé = à re-notifier, sinon le snooze rend muet');
  });

  test('un rappel dû sort de la liste une fois notifié, pas avant', () => {
    const t = notes.creerTodo({ title: 'relire la migration', due_at: '2020-01-01T09:00:00Z' }, msgs);
    assert.ok(notes.rappelsDus().some((x) => x.id === t.id), 'échu et non notifié : il est dû');
    notes.marquerNotifie(t.id, msgs);
    assert.ok(!notes.rappelsDus().some((x) => x.id === t.id), 'notifié une fois, plus jamais');
  });

  test('une todo faite ne réclame plus, même son échéance passée', () => {
    const t = notes.creerTodo({ title: 'déjà réglé', due_at: '2020-01-01T09:00:00Z' }, msgs);
    notes.majTodo(t.id, { status: 'done' }, msgs);
    assert.ok(!notes.rappelsDus().some((x) => x.id === t.id));
  });
});

describe('archivage : les faites restent barrées sept jours', () => {
  const msgs = {
    titreVide: 'titre', inconnue: 'inconnue', prioriteInvalide: 'prio',
    statutInvalide: 'statut', dateInvalide: 'date', lienInvalide: 'lien',
  };
  const faiteIlYA = (jours) => {
    const t = notes.creerTodo({ title: `faite il y a ${jours} j` }, msgs);
    const quand = new Date(Date.now() - jours * 24 * 3600 * 1000).toISOString();
    db.prepare("UPDATE todo SET status = 'done', done_at = ? WHERE id = ?").run(quand, t.id);
    return t.id;
  };

  test('au-delà de sept jours elle s’archive, en deçà elle reste visible', () => {
    const vieille = faiteIlYA(9);
    const recente = faiteIlYA(2);
    notes.archiver();
    assert.ok(notes.lireTodo(vieille).archived_at, 'celle de la semaine dernière part au tiroir');
    assert.equal(notes.lireTodo(recente).archived_at, null, 'celle d’avant-hier reste : on veut voir ce qu’on a fait');
    assert.ok(notes.listerTodos('archived').some((t) => t.id === vieille));
    assert.ok(notes.listerTodos('done').some((t) => t.id === recente));
    assert.ok(!notes.listerTodos('done').some((t) => t.id === vieille), 'archivée ≠ faite : les listes ne se mélangent pas');
  });

  test('rien n’est SUPPRIMÉ : une archivée se retrouve, et se rouvre', () => {
    const id = faiteIlYA(30);
    notes.archiver();
    const rouverte = notes.majTodo(id, { status: 'open' }, msgs);
    assert.equal(rouverte.archived_at, null, 'rouvrir sort du tiroir, sinon elle resterait invisible');
    assert.equal(rouverte.done_at, null);
    assert.ok(notes.listerTodos('open').some((t) => t.id === id));
  });

  test('une todo OUVERTE et ancienne ne s’archive jamais', () => {
    const t = notes.creerTodo({ title: 'vieux chantier jamais fini' }, msgs);
    db.prepare('UPDATE todo SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', t.id);
    notes.archiver();
    assert.equal(notes.lireTodo(t.id).archived_at, null);
  });
});

describe('validations et bornes', () => {
  const msgs = {
    titreVide: 'TITRE-VIDE', inconnue: 'INCONNUE', prioriteInvalide: 'PRIO',
    statutInvalide: 'STATUT', dateInvalide: 'DATE', lienInvalide: 'LIEN',
  };

  test('un titre vide est refusé : une ligne blanche ne se relit pas demain', () => {
    assert.throws(() => notes.creerTodo({ title: '   ' }, msgs), /TITRE-VIDE/);
    assert.throws(() => notes.creerPage({ title: '' }, msgs), /TITRE-VIDE/);
  });

  test('les tailles sont bornées, pas rejetées : on tronque plutôt que de perdre la saisie', () => {
    const t = notes.creerTodo({ title: 'x'.repeat(500), note: 'n'.repeat(5000) }, msgs);
    assert.equal(t.title.length, notes.MAX_TITLE);
    assert.equal(t.note.length, notes.MAX_NOTE);
    const p = notes.creerPage({ title: 'page', content: 'c'.repeat(notes.MAX_PAGE + 1000) }, msgs);
    assert.equal(notes.lirePage(p.id).content.length, notes.MAX_PAGE);
  });

  test('priorité, statut, date et lien sont validés', () => {
    assert.throws(() => notes.creerTodo({ title: 'a', priority: 'urgente' }, msgs), /PRIO/);
    assert.throws(() => notes.creerTodo({ title: 'a', due_at: 'jeudi prochain' }, msgs), /DATE/);
    assert.throws(() => notes.creerTodo({ title: 'a', link_kind: 'facture', link_ref: '3' }, msgs), /LIEN/);
    const t = notes.creerTodo({ title: 'a' }, msgs);
    assert.throws(() => notes.majTodo(t.id, { status: 'en-cours' }, msgs), /STATUT/);
  });

  /* Un lien va par PAIRE : un type sans référence donnerait un bouton qui ne mène nulle part. */
  test('un lien sans référence n’est pas enregistré à moitié', () => {
    const t = notes.creerTodo({ title: 'a', link_kind: 'mr', link_ref: '' }, msgs);
    assert.equal(t.link_kind, null);
    assert.equal(t.link_ref, null);
  });
});

/* L'index d'autolink est relu à chaque ouverture de l'onglet — celui sur lequel l'application
   atterrit chaque matin. Sans borne, il sérialisait la table `mr` ENTIÈRE pour résoudre trois
   références dans une note ; et la rétention ne borne pas cette table. */
describe('index d’autolink : borné aux merge requests encore signifiantes', () => {
  const poserMr = (iid, { fermee = 0, ilYaJours = 0 } = {}) => {
    const repo = db.prepare("SELECT id FROM repo LIMIT 1").get()
      || { id: db.prepare("INSERT INTO repo (project, url, enabled) VALUES ('grp/app','u',1)").run().lastInsertRowid };
    const quand = new Date(Date.now() - ilYaJours * 24 * 3600 * 1000).toISOString();
    return db.prepare(`INSERT INTO mr (repo_id, iid, title, status, updated_at, closed_seen)
      VALUES (?,?,?,'to_review',?,?)`).run(repo.id, iid, `MR ${iid}`, quand, fermee).lastInsertRowid;
  };

  test('les MR ouvertes y sont, même très anciennes', () => {
    db.prepare('DELETE FROM mr').run();
    poserMr(101, { fermee: 0, ilYaJours: 900 });
    const idx = notes.indexAutolink();
    assert.ok(idx['101'], 'une MR encore ouverte reste une référence qu’on écrit dans une note');
  });

  test('une MR fermée et ancienne en sort — un lien de moins, jamais un lien faux', () => {
    db.prepare('DELETE FROM mr').run();
    poserMr(202, { fermee: 1, ilYaJours: notes.JOURS_AUTOLINK + 30 });
    poserMr(203, { fermee: 1, ilYaJours: 10 });
    const idx = notes.indexAutolink();
    assert.equal(idx['202'], undefined, 'fermée depuis plus de six mois : hors index');
    assert.ok(idx['203'], 'fermée récemment : encore résoluble');
  });

  test('un même iid sur plusieurs dépôts rend TOUS les candidats', () => {
    db.prepare('DELETE FROM mr').run();
    db.prepare("INSERT INTO repo (project, url, enabled) VALUES ('grp/autre','u2',1)").run();
    const repos = db.prepare('SELECT id FROM repo ORDER BY id LIMIT 2').all();
    const now = new Date().toISOString();
    for (const r of repos) {
      db.prepare("INSERT INTO mr (repo_id, iid, title, status, updated_at, closed_seen) VALUES (?,?,?,'to_review',?,0)")
        .run(r.id, 214, 'MR 214', now);
    }
    assert.equal(notes.indexAutolink()['214'].length, 2,
      'on ne devine pas : le rendu montrera les candidats plutôt que d’en choisir un');
  });
});

describe('export : le nom de fichier est slugifié', () => {
  test('accents, espaces et ponctuation deviennent un nom sûr', () => {
    assert.equal(notes.slugifier('Notes migration TypeORM / étape 2 !'), 'notes-migration-typeorm-etape-2');
  });

  /* `Content-Disposition` n'est pas l'endroit où découvrir qu'un titre contenait `../`. */
  test('une traversée de chemin ne survit pas à la slugification', () => {
    const nom = notes.slugifier('../../etc/passwd');
    assert.doesNotMatch(nom, /[./\\]/);
    assert.equal(nom, 'etc-passwd');
  });

  test('un titre sans aucun caractère latin retombe sur un nom lisible', () => {
    assert.equal(notes.slugifier('🎉🎉'), 'note');
    assert.equal(notes.slugifier(''), 'note');
  });
});

describe('recherche et tri des listes', () => {
  const msgs = {
    titreVide: 'titre', inconnue: 'inconnue', prioriteInvalide: 'prio',
    statutInvalide: 'statut', dateInvalide: 'date', lienInvalide: 'lien',
  };

  test('la recherche porte sur le titre ET le contenu', () => {
    notes.creerPage({ title: 'Réunion produit', content: 'décision sur le cache Redis' }, msgs);
    assert.ok(notes.listerPages('Réunion').length >= 1);
    assert.ok(notes.listerPages('Redis').length >= 1, 'le mot cherché est souvent dans le corps');
    assert.equal(notes.listerPages('zzz-introuvable').length, 0);
  });

  /* Le `%` d'une recherche est du texte, pas un joker SQL : sans échappement, taper « % »
     ramènerait toutes les pages. */
  test('les jokers SQL saisis par l’utilisateur restent du texte', () => {
    notes.creerPage({ title: 'taux 50% atteint', content: '' }, msgs);
    assert.equal(notes.listerPages('50%').length, 1);
    assert.equal(notes.listerPages('%').length, 1, 'un % seul ne doit pas tout ramener');
  });

  test('les épinglées passent devant, puis les plus récemment modifiées', () => {
    const a = notes.creerPage({ title: 'ancienne' }, msgs);
    const b = notes.creerPage({ title: 'récente' }, msgs);
    notes.majPage(a.id, { pinned: 1 }, msgs);
    const ids = notes.listerPages().map((p) => p.id);
    assert.ok(ids.indexOf(a.id) < ids.indexOf(b.id), 'épinglée d’abord, même moins récente');
  });

  /* Une todo SANS échéance passe après celles qui en ont une, à priorité égale : sinon les
     sans-date, plus nombreuses, repousseraient en bas ce qui est dû aujourd'hui. */
  test('tri : priorité d’abord, puis échéance, les sans-date en dernier', () => {
    db.prepare('DELETE FROM todo').run();
    const basse = notes.creerTodo({ title: 'basse', priority: 'low' }, msgs);
    const sansDate = notes.creerTodo({ title: 'normale sans date' }, msgs);
    const datee = notes.creerTodo({ title: 'normale datée', due_at: '2026-09-01T09:00:00Z' }, msgs);
    const haute = notes.creerTodo({ title: 'haute', priority: 'high' }, msgs);
    assert.deepEqual(notes.listerTodos('open').map((t) => t.id), [haute.id, datee.id, sansDate.id, basse.id]);
  });
});
