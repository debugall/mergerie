'use strict';
/* CE QUI N'APPARTIENT QU'À CETTE MACHINE — `local_state` et `local_pref`.
 *
 * Trois colonnes vivaient dans des tables partagées où elles n'avaient rien à faire, non parce
 * qu'elles sont secrètes, mais parce qu'elles ne VEULENT RIEN DIRE ailleurs :
 *
 *   `agent.schedule_fired_at` — « cet agent a tiré ». Chez qui ? Trois instances allumées
 *      liraient chacune le tir des deux autres et n'en feraient aucun, ou trois.
 *   `jira_watch.checked_at` / `error` — quand CE poste a regardé, et SON erreur réseau. Ce
 *      qu'on surveille est d'équipe ; le fait de l'avoir regardé ne l'est pas.
 *   `task.hidden` et ses jumelles — ranger une session la retire de SA vue. La supprimer, en
 *      revanche, la supprime pour tout le monde, et la confirmation le dit.
 *
 * CE QUE CES ÉPREUVES TIENNENT : la colonne d'origine reste VIDE après une écriture (sinon la
 * donnée repartirait un jour dans le dépôt d'équipe), la référence est l'`uid` et jamais l'`id`
 * entier (qui se renumérote d'un poste à l'autre), et le ménage est fait à la suppression —
 * il n'y a pas de clé étrangère pour le faire à notre place.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-local-state-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

describe('local_state / local_pref — l’état et les préférences de ce poste', () => {
  let db; let etat; let pref;

  before(() => {
    db = require('../src/db');
    ({ etat, pref } = require('../src/localstate'));
  });

  test('écrire puis relire, et `null` efface au lieu de garder une ligne vide', () => {
    etat.ecrire('agent', 'UID1', 'schedule_fired_at', '2026-03-10T07:00:00.000Z');
    assert.equal(etat.lire('agent', 'UID1', 'schedule_fired_at'), '2026-03-10T07:00:00.000Z');
    etat.ecrire('agent', 'UID1', 'schedule_fired_at', null);
    assert.equal(etat.lire('agent', 'UID1', 'schedule_fired_at'), null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM local_state WHERE ref = 'UID1'").get().n, 0,
      'une ligne à valeur nulle se relirait comme « il y a quelque chose »');
  });

  test('une deuxième écriture remplace, elle ne double pas', () => {
    etat.ecrire('agent', 'UID2', 'schedule_fired_at', 'a');
    etat.ecrire('agent', 'UID2', 'schedule_fired_at', 'b');
    assert.equal(etat.lire('agent', 'UID2', 'schedule_fired_at'), 'b');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM local_state WHERE ref = 'UID2'").get().n, 1);
  });

  test('les deux tables ne se voient pas — durées de vie différentes, rangements différents', () => {
    pref.ecrire('task', 'UID3', 'hidden', '1');
    assert.equal(etat.lire('task', 'UID3', 'hidden'), null, 'vider l’état ne doit pas déranger');
    assert.equal(pref.lire('task', 'UID3', 'hidden'), '1');
  });

  test('`kind` sépare deux parents qui porteraient la même référence', () => {
    etat.ecrire('agent', 'MEME', 'k', 'côté agent');
    etat.ecrire('jira_watch', 'MEME', 'k', 'côté ticket');
    assert.equal(etat.lire('agent', 'MEME', 'k'), 'côté agent');
    assert.equal(etat.lire('jira_watch', 'MEME', 'k'), 'côté ticket');
  });

  test('`carte` rend tout d’un coup — une liste ne fait pas une requête par ligne', () => {
    etat.ecrire('jira_watch', 'PROJ-1', 'checked_at', 't1');
    etat.ecrire('jira_watch', 'PROJ-2', 'checked_at', 't2');
    etat.ecrire('jira_watch', 'PROJ-2', 'error', 'boum');
    const m = etat.carte('jira_watch', 'checked_at');
    assert.equal(m.get('PROJ-1'), 't1');
    assert.equal(m.get('PROJ-2'), 't2');
    assert.equal(m.has('PROJ-3'), false);
  });

  test('`oublier` fait le ménage du parent — aucune clé étrangère ne le fera', () => {
    etat.oublier('jira_watch', 'PROJ-2');
    assert.equal(etat.lire('jira_watch', 'PROJ-2', 'checked_at'), null);
    assert.equal(etat.lire('jira_watch', 'PROJ-2', 'error'), null);
    assert.equal(etat.lire('jira_watch', 'PROJ-1', 'checked_at'), 't1', 'les voisins ne bougent pas');
  });

  test('une référence vide n’écrit rien — un parent sans uid ne doit pas créer de ligne fourre-tout', () => {
    etat.ecrire('agent', null, 'k', 'v');
    etat.ecrire('agent', '', 'k', 'v');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM local_state WHERE ref = ''").get().n, 0);
    assert.equal(etat.lire('agent', null, 'k'), null);
  });

  test('les colonnes d’origine sont vides et gelées après le démarrage', () => {
    /* « Gelée » veut dire « ne porte plus que sa valeur neutre » : `task.hidden` a un DEFAULT 0,
       qu'on laisse tranquille — c'est « non rangée », et le réécrire à chaque démarrage
       toucherait toutes les sessions pour rien. */
    const vide = (table, col) => db.prepare(
      `SELECT COUNT(*) n FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} <> 0`,
    ).get().n;
    assert.equal(vide('agent', 'schedule_fired_at'), 0);
    assert.equal(vide('jira_watch', 'checked_at'), 0);
    assert.equal(vide('jira_watch', 'error'), 0);
    for (const t of ['task', 'local_task', 'question']) assert.equal(vide(t, 'hidden'), 0);
  });

  test('ranger une session n’écrit RIEN dans sa table — c’est là tout l’enjeu', () => {
    const now = new Date().toISOString();
    const repo = db.prepare(`INSERT INTO repo (project, url, enabled, created_at)
      VALUES ('grp/app', 'https://x.test/a.git', 1, ?)`).run(now).lastInsertRowid;
    const id = db.prepare(`INSERT INTO task (repo_id, prompt, branch, kind, status, created_at, updated_at)
      VALUES (?, 'p', 'feat/x', 'code', 'new', ?, ?)`).run(repo, now, now).lastInsertRowid;
    const uid = db.prepare('SELECT uid FROM task WHERE id = ?').get(id).uid;

    pref.ecrire('task', uid, 'hidden', '1');
    assert.equal(pref.drapeau('task', uid, 'hidden'), true);
    assert.ok(!db.prepare('SELECT hidden FROM task WHERE id = ?').get(id).hidden,
      'un `hidden` en base partirait dans le dépôt et rangerait la session chez les collègues');
  });
});
