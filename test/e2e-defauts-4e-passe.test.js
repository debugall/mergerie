'use strict';
/* LES DÉFAUTS RELEVÉS EN LISANT (§5 du rapport de 4ᵉ passe).
 *
 * Ce ne sont pas des fonctionnalités : ce sont des écarts entre ce que le code prétend faire et
 * ce qu'il fait. Chacun était invisible à l'usage — c'est précisément pour ça qu'ils avaient
 * survécu, et pour ça qu'ils ont besoin d'un test plutôt que d'un coup d'œil.
 *
 * Chaque cas ci-dessous échoue sur le code d'avant. Quand un défaut se joue entièrement dans une
 * fonction pure (le total d'un rapport JUnit, la fraîcheur d'un fichier), c'est elle qu'on
 * interroge : passer par l'écran n'y ajouterait que du décor.
 *
 * Un seul `startApp()` pour tout le fichier.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp } = require('./helpers/app');

describe('Défauts de la 4ᵉ passe', () => {
  let app;

  before(async () => {
    app = await startApp();
    await app.configure();
  });
  after(async () => { if (app) await app.stop(); });

  /* §5.1 — DEUX défauts au même endroit, qui se compensaient. (a) `verification` n'a pas de
     colonne `mr_id` : la sous-requête qui l'utilisait était résolue sur le `review` de la
     requête externe, donc toujours vraie — une seule vérification verte, n'importe où,
     suffisait à déclarer prête toute MR bien notée. (b) Le seuil arrive sur 10 quand la note
     est stockée sur 1 (`0,84` pour 8,4) : `note_value >= 8` était toujours faux, et le compte
     rendait donc zéro quoi qu'il arrive. Le second cachait le premier ; il a fallu corriger
     l'un pour voir l'autre. */
  test('le brief ne compte comme prête que la MR qui a VRAIMENT une vérification verte', async () => {
    const d = app.db;
    const repoId = d.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/a','http://x',datetime('now'))").run().lastInsertRowid;
    const mr = (iid, sha) => d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, updated_at)
      VALUES (?,?,?,?, 'main', ?, 'reviewed', datetime('now'))`).run(repoId, iid, `T${iid}`, `f/${iid}`, sha).lastInsertRowid;
    const verte = mr(9001, 'sha-verte');
    const sans = mr(9002, 'sha-sans');
    for (const id of [verte, sans]) {
      d.prepare("INSERT INTO review (mr_id, md_path, note_value, created_at, updated_at) VALUES (?,'/tmp/x.md',0.9,datetime('now'),datetime('now'))").run(id);
    }
    // UNE seule vérification, et elle ne cible que la première MR.
    d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, created_at)
      VALUES ('v','done','verified_pass',?,datetime('now'))`)
      .run(JSON.stringify([{ repo_id: repoId, mr_id: verte, head_sha: 'sha-verte' }]));

    const b = (await app.api('GET', '/api/brief')).body;
    assert.equal(b.ready_to_merge, 1, 'la MR sans vérification n’est pas prête');
  });

  /* §5.1 (suite) — et un verdict PÉRIMÉ ne rend pas prêt : le SHA testé n'est plus le courant. */
  test('une vérification verte sur un SHA dépassé ne rend pas la MR prête', async () => {
    const d = app.db;
    const repoId = d.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/b','http://y',datetime('now'))").run().lastInsertRowid;
    const id = d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, updated_at)
      VALUES (?, 9100, 'T', 'f/9100', 'main', 'sha-neuf', 'reviewed', datetime('now'))`).run(repoId).lastInsertRowid;
    d.prepare("INSERT INTO review (mr_id, md_path, note_value, created_at, updated_at) VALUES (?,'/tmp/x.md',0.95,datetime('now'),datetime('now'))").run(id);
    d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, created_at)
      VALUES ('v','done','verified_pass',?,datetime('now'))`)
      .run(JSON.stringify([{ repo_id: repoId, mr_id: id, head_sha: 'sha-vieux' }]));

    const avant = (await app.api('GET', '/api/brief')).body.ready_to_merge;
    // …et la même, vérifiée sur le SHA courant, compte.
    d.prepare(`INSERT INTO verification (verifier_name, status, verdict, targets_json, created_at)
      VALUES ('v','done','verified_pass',?,datetime('now'))`)
      .run(JSON.stringify([{ repo_id: repoId, mr_id: id, head_sha: 'sha-neuf' }]));
    const apres = (await app.api('GET', '/api/brief')).body.ready_to_merge;
    assert.equal(apres, avant + 1, 'seule la vérification à jour compte');
  });

  /* §5.12 — « total » doit compter la même chose des deux côtés : ce qui a TOURNÉ. TAP excluait
     déjà les skips, JUnit les comptait — le même projet annonçait deux totaux selon son format. */
  test('le total d’un rapport JUnit exclut les tests sautés, comme TAP', () => {
    const verify = require('../src/verify');
    const junit = verify.parserJUnit(`<testsuite>
      <testcase name="a"/>
      <testcase name="b"><skipped/></testcase>
      <testcase name="c"><failure message="boom">trace</failure></testcase>
    </testsuite>`);
    assert.equal(junit.total, 2, 'deux tests ont tourné, le troisième a été sauté');
    assert.equal(junit.tests.length, 1);

    const tap = verify.parserTap('TAP version 13\nok 1 - a\nok 2 - b # SKIP\nnot ok 3 - c\n1..3\n');
    assert.equal(tap.total, 2, 'le TAP comptait déjà comme ça');
  });

  /* §5.5 — le bandeau de convergence affichait la clé brute `converge.status.needs_input` à
     l'endroit exact où l'on attend une consigne. */
  test('« en attente de réponses » a un libellé dans les deux langues', () => {
    const rt = require('../public/i18n-runtime.js');
    for (const lang of ['fr', 'en']) {
      rt.setLang(lang);
      const s = rt.t('converge.status.needs_input');
      assert.ok(!/^converge\./.test(s), `clé brute en ${lang} : ${s}`);
      assert.match(s, /question|répons|answer/i);
    }
    rt.setLang('fr');
  });

  /* §5.7 — la consigne de correction était recopiée en français dans deux fichiers. Elle est
     maintenant un gabarit comme les autres : traduit, éditable, et relu au même endroit. */
  test('le gabarit de correction est traduit, éditable, et pris dans les réglages', async () => {
    const prompts = require('../src/prompts');
    assert.ok(prompts.FIELDS.includes('prompt_fix'));
    assert.notEqual(prompts.PROMPTS.fr.prompt_fix, prompts.PROMPTS.en.prompt_fix);
    // Vide en base → le défaut de la langue configurée s'applique.
    assert.equal(prompts.gabarit('prompt_fix', { language: 'en' }), prompts.PROMPTS.en.prompt_fix);
    assert.equal(prompts.gabarit('prompt_fix', { prompt_fix: 'à moi {report}' }), 'à moi {report}');

    // …et il fait tout le chemin : accepté par l'API, écrit, relu.
    await app.api('PUT', '/api/config', { prompt_fix: 'Corrige {source} : {report}' });
    assert.equal((await app.api('GET', '/api/config')).body.prompt_fix, 'Corrige {source} : {report}');
    await app.api('PUT', '/api/config', { prompt_fix: '' });
  });

  /* §5.9 — `git_op` était la seule table de trace à croître sans fin. */
  test('la rétention purge aussi l’historique des opérations git', () => {
    const retention = require('../src/retention');
    const d = app.db;
    const ligne = (jours) => d.prepare(`INSERT INTO git_op (batch_id, created_at, action, project, ref_name, status)
      VALUES ('b', datetime('now', ?), 'delete_branch', 'grp/a', 'x', 'done')`).run(`-${jours} days`);
    ligne(400); ligne(1);
    const avant = d.prepare('SELECT COUNT(*) c FROM git_op').get().c;
    const r = retention.purger(30);
    assert.equal(r.git_op, 1, 'la vieille part, la récente reste');
    assert.equal(d.prepare('SELECT COUNT(*) c FROM git_op').get().c, avant - 1);
  });

  /* §5.13 — en mode « in place », le dépôt garde ses fichiers d'un run à l'autre : un rapport
     laissé par le run BASE ne doit pas être relu comme le résultat du run TÊTE. */
  test('un rapport JUnit plus ancien que le run est ignoré', () => {
    const verifyrun = require('../src/verifyrun');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frais-'));
    const rapport = path.join(dir, 'report.xml');
    fs.writeFileSync(rapport, '<testsuite><testcase name="a"/></testsuite>');
    const verifier = { report_path: 'report.xml', parse_tap: 0 };
    const journal = [];
    const log = (m) => journal.push(String(m));

    // Écrit il y a une heure, run démarré maintenant : ce n'est pas le nôtre.
    const vieux = Date.now() - 3600 * 1000;
    fs.utimesSync(rapport, vieux / 1000, vieux / 1000);
    assert.equal(verifyrun.detailDesTests(verifier, dir, [], log, null, Date.now()), null);
    assert.ok(journal.some((l) => /plus ancien/.test(l)), journal.join(' | '));

    // Régénéré par le run : il compte.
    fs.writeFileSync(rapport, '<testsuite><testcase name="a"/></testsuite>');
    const d = verifyrun.detailDesTests(verifier, dir, [], log, null, Date.now() - 5000);
    assert.equal(d && d.source, 'junit');
  });

  /* §5.3 — une vérification « in place » travaille dans le dossier de l'utilisateur, celui-là
     même qu'une session hors dépôt réserve. Sans la même clé, les deux tournaient ensemble. */
  test('une vérification in place réserve le dossier, comme une session hors dépôt', () => {
    const jobs = require('../src/jobs');
    const d = app.db;
    const repoId = d.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/c','http://z',datetime('now'))").run().lastInsertRowid;
    const vId = d.prepare("INSERT INTO verifier (name, command, kind, created_at) VALUES ('V','','commands',datetime('now'))").run().lastInsertRowid;
    d.prepare("INSERT INTO verifier_repo (verifier_id, repo_id, mode, workdir, checkout_allowed) VALUES (?,?, 'in_place', '/home/moi/projet', 1)").run(vId, repoId);
    const verifId = d.prepare(`INSERT INTO verification (verifier_id, verifier_name, status, targets_json, created_at)
      VALUES (?, 'V', 'queued', ?, datetime('now'))`)
      .run(vId, JSON.stringify([{ repo_id: repoId, branch: 'main' }])).lastInsertRowid;

    const cles = jobs.jobKeys({ kind: 'verify', verificationId: verifId });
    assert.ok(cles.has(`repo:${repoId}`), 'le dépôt reste réservé');
    assert.ok(cles.has('dir:/home/moi/projet'), `le dossier aussi : ${[...cles].join(', ')}`);
  });
});
