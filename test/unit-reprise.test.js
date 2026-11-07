'use strict';
/* REPRENDRE LA SESSION D'UN COLLÈGUE : L'AGENT REÇOIT L'HISTOIRE, PAS UN RÉSUMÉ.
 *
 * Ce que ce fichier prouve, sans serveur ni réseau : `assembler` est une fonction pure, fixée octet pour
 * octet sur une fixture à trois passes, deux questions et un rapport de review — les sections dans
 * l'ordre, rien d'omis ; sans rapport ni question les sections sont absentes ; une réponse à la question
 * en attente précède la consigne ; le curseur à 2 passes sur 6 garde les deux dernières et l'en-tête dit
 * « 4 passes antérieures non incluses » ; un diff de 20 001 lignes devient une liste de fichiers, dit en
 * clair ; l'éligibilité (hors dépôt, exploration, ma propre session, branche non poussée, mergée) ; la
 * filiation calculée (`reprisesDe`, `origineDe`) ; l'export (`resumed_from` dans `session.json`) et le
 * module fermé à `agent/` — hors `agent/pass` et `agent/tasks`, qui ne sont pas l'IA. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lireSource } = require('./helpers/sources');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reprise-'));
const FIX = path.join(__dirname, 'fixtures', 'reprise');

describe('Reprendre la session d’un collègue sur ce poste', () => {
  let db; let rp; let registre;
  const NOW = Date.parse('2026-11-07T12:00:00Z');
  const fixture = {
    auteur: 'Claire', origineId: 123, project: 'groupe/tarification', branch: 'feature/tva',
    dernierCommit: 'a1b2c3d4e5f6', dernierePasse: { n: 3, at: '2026-11-04T09:30:00Z' }, teteForge: 'a1b2c3d4e5f6', ecart: 0, running: false,
    prompt: 'Applique le taux réduit de TVA aux abonnements annuels.',
    passes: [
      { n: 1, kind: 'run', prompt: 'Tu es un développeur…\n\nApplique le taux réduit de TVA aux abonnements annuels.', output: 'J’ai ajouté `tauxReduit()` dans src/tva/taux.js et un test.' },
      { n: 2, kind: 'followup', prompt: 'Le taux doit venir de la configuration, pas d’une constante.', output: 'Fait : `config.tva.reduit`, avec un défaut à 5,5 %.' },
      { n: 3, kind: 'answer', prompt: 'Réponses : la facture mensuelle reste au taux plein.', output: 'J’ai limité le taux réduit aux abonnements annuels ; les tests passent.' },
    ],
    questions: [
      { question: 'Le taux réduit s’applique-t-il aussi aux factures mensuelles ?', context: 'Le code actuel ne distingue pas.', answer: 'Non, annuel seulement.' },
      { question: 'Faut-il migrer les factures déjà émises ?', context: null, answer: null },
    ],
    review: { iid: 214, version: 2, note: 7.8, texte: '# Review\n\n🟠 Le taux est lu à chaque appel.' },
    verification: null, diff: null, reponse: null, consigne: 'Termine : migre les factures émises depuis le 1er janvier.', passesIncluses: null,
  };

  before(() => {
    db = require('../src/db');
    rp = require('../src/session/reprise');
    registre = require('../src/data/store-registry');
  });

  test('assembler : trois passes, deux questions, un rapport → le texte attendu, octet pour octet, sections dans l’ordre', () => {
    const texte = rp.assembler(fixture, { now: NOW });
    const attendu = fs.readFileSync(path.join(FIX, 'trois-passes.txt'), 'utf8');
    assert.equal(texte, attendu);
    const ordre = [...texte.matchAll(/^=== (.+?) ===$/gm)].map((m) => m[1]);
    assert.deepEqual(ordre, ["Prompt d'origine", 'Passe 1 · exécution', 'Passe 2 · suivi', 'Passe 3 · réponse', 'Questions posées et réponses', 'Dernier rapport de review lié (!214, v2, 7,8/10)', 'Consigne de reprise']);
    assert.ok(texte.includes('J’ai limité le taux réduit'), 'les retours sont inclus en entier');
    assert.ok(texte.includes('R : (sans réponse)'), 'une question sans réponse le dit');
    assert.ok(!/résum|summary/i.test(texte), 'rien n’est résumé');
  });

  test('sans rapport → section absente ; sans question → absente ; une réponse à la question en attente précède la consigne ; running et écart dits en tête', () => {
    const sans = rp.assembler({ ...fixture, review: null, questions: [] }, { now: NOW });
    assert.ok(!sans.includes('Dernier rapport') && !sans.includes('Questions posées'));
    const avec = rp.assembler({ ...fixture, reponse: 'Non : seulement celles émises après le 1er janvier.', running: true, derniereSynchro: '2026-11-07T10:00:00Z', ecart: 2, teteForge: 'ffff0000aaaa' }, { now: NOW });
    const iRep = avec.indexOf('=== Réponse à la question en attente ===');
    const iCons = avec.indexOf('=== Consigne de reprise ===');
    assert.ok(iRep > 0 && iRep < iCons, 'la réponse précède la consigne');
    assert.match(avec, /^La forge est 2 commits plus loin que la dernière passe connue\.$/m);
    assert.match(avec, /^La session d'origine était marquée en cours à la dernière synchronisation \(aujourd’hui\)\.$/m);
    assert.match(avec, /Tête sur la forge : ffff000\./);
    const verif = rp.assembler({ ...fixture, verification: { iid: 214, verdict: 'verified_fail', texte: 'Verdict : verified_fail\nTests imputables : ["tva › annuel"]' } }, { now: NOW });
    assert.ok(verif.includes('=== Dernière vérification liée (!214, verified_fail) ===\nVerdict : verified_fail'));
  });

  test('curseur à 2 passes sur 6 → les deux dernières, et l’en-tête dit « 4 passes antérieures non incluses »', () => {
    const six = Array.from({ length: 6 }, (x, i) => ({ n: i + 1, kind: 'followup', prompt: `demande ${i + 1}`, output: `retour ${i + 1}` }));
    const texte = rp.assembler({ ...fixture, passes: six, passesIncluses: 2 }, { now: NOW });
    assert.match(texte, /^4 passes antérieures non incluses\.$/m);
    assert.deepEqual([...texte.matchAll(/^=== Passe (\d) · suivi ===$/gm)].map((m) => m[1]), ['5', '6']);
    assert.ok(!texte.includes('retour 4'));
    const toutes = rp.assembler({ ...fixture, passes: six, passesIncluses: null }, { now: NOW });
    assert.ok(!toutes.includes('non incluses') && toutes.includes('retour 1'));
    const une = rp.assembler({ ...fixture, passes: six, passesIncluses: 1 }, { now: NOW });
    assert.match(une, /^5 passes antérieures non incluses\.$/m);
  });

  test('diff joint de 20 001 lignes → les fichiers listés, les lignes omises, dit en clair ; 20 000 lignes → tel quel', () => {
    const corps = Array.from({ length: 19997 }, (x, i) => `+ligne ${i}`).join('\n');
    const diff = `diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n${corps}`;
    assert.equal(diff.split('\n').length, 20000);
    const ok = rp.borneDiff(diff);
    assert.equal(ok.tronque, false);
    const gros = `${diff}\ndiff --git a/src/b.js b/src/b.js`;
    const b = rp.borneDiff(gros);
    assert.equal(b.tronque, true);
    assert.deepEqual(b.fichiers, ['src/a.js', 'src/b.js']);
    assert.match(b.texte, /^Diff de 20001 lignes, au-delà de 20000 : seuls les fichiers sont listés, les lignes sont omises\.\n- src\/a\.js\n- src\/b\.js$/);
    const texte = rp.assembler({ ...fixture, diff: gros }, { now: NOW });
    assert.ok(texte.includes('=== Diff de la branche reprise ===\nDiff de 20001 lignes'));
    assert.equal(rp.estimerTokens('a'.repeat(400)), 100);
  });

  test('éligibilité : hors codage, ma propre session, branche non poussée, mergée → pas de bouton, avec le motif ; poussée → ok, needs_input dit', () => {
    const tg = { branch: 'feature/tva', status: 'pushed', mr_iid: null, existing_mr_iid: null, push_command: null, mr_merged: 0 };
    assert.deepEqual(rp.eligibilite({ kind: 'explore' }, tg, { auteur: 'Claire', moi: 'Amady' }), { ok: false, reason: 'kind' });
    assert.deepEqual(rp.eligibilite({ kind: 'code' }, tg, { auteur: null, moi: 'Amady' }), { ok: false, reason: 'mine' }, 'sans auteur : jamais partie, donc à moi');
    assert.deepEqual(rp.eligibilite({ kind: 'code' }, tg, { auteur: 'Amady', moi: 'Amady' }), { ok: false, reason: 'mine' });
    assert.deepEqual(rp.eligibilite({ kind: 'code' }, { ...tg, status: 'committed' }, { auteur: 'Claire', moi: 'Amady' }), { ok: false, reason: 'unpushed' });
    assert.deepEqual(rp.eligibilite({ kind: 'code' }, { ...tg, mr_merged: 1, mr_iid: 214 }, { auteur: 'Claire', moi: 'Amady' }), { ok: false, reason: 'merged', iid: 214 });
    assert.deepEqual(rp.eligibilite({ kind: 'code' }, tg, { auteur: 'Claire', moi: 'Amady' }), { ok: true, needs_input: false });
    assert.deepEqual(rp.eligibilite({ kind: 'code' }, { ...tg, status: 'needs_input', mr_iid: 7 }, { auteur: 'Claire', moi: 'Amady' }), { ok: true, needs_input: true });
    assert.deepEqual(rp.eligibilite({ kind: 'code' }, { ...tg, status: 'committed', existing_mr_iid: 9 }, { auteur: 'Claire', moi: 'Amady' }), { ok: true, needs_input: false }, 'une MR connue sur la branche vaut branche poussée');
  });

  test('filiation : calculée sur `resumed_from_uid`, plusieurs reprises listées, les plus récentes d’abord ; l’export porte `resumed_from`, l’import le relit, jamais le handle', () => {
    const repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES ('grp/app', 'https://gitlab.test/grp/app.git', 1, 'gitlab')").run().lastInsertRowid);
    const ins = db.prepare("INSERT INTO task (repo_id, kind, prompt, branch, status, uid, resumed_from_uid, resumed_target_uid, created_at, updated_at) VALUES (?, 'code', ?, 'b', 'done', ?, ?, ?, ?, ?)");
    const origine = Number(ins.run(repoId, 'origine', 'UID-ORIGINE', null, null, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z').lastInsertRowid);
    const r1 = Number(ins.run(repoId, 'reprise 1', 'UID-R1', 'UID-ORIGINE', 'UID-CIBLE', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z').lastInsertRowid);
    const r2 = Number(ins.run(repoId, 'reprise 2', 'UID-R2', 'UID-ORIGINE', 'UID-CIBLE', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z').lastInsertRowid);
    const m = rp.reprisesDe(['UID-ORIGINE', 'UID-R1']);
    assert.deepEqual(m.get('UID-ORIGINE').map((r) => r.id), [r2, r1], 'les plus récentes d’abord, aucune « officielle »');
    assert.equal(m.get('UID-R1'), undefined);
    assert.deepEqual(rp.origineDe(db.prepare('SELECT * FROM task WHERE id = ?').get(r1)), { id: origine, uid: 'UID-ORIGINE', label: null, prompt: 'origine', status: 'done', target_uid: 'UID-CIBLE' });
    assert.equal(rp.origineDe(db.prepare('SELECT * FROM task WHERE id = ?').get(origine)), null);
    assert.deepEqual(rp.origineDe({ resumed_from_uid: 'UID-INCONNU', resumed_target_uid: 'X' }), { id: null, uid: 'UID-INCONNU', target_uid: 'X' }, 'une origine inconnue ici reste un uid');
    // L'export du store : la filiation voyage, et seulement elle.
    const e = registre.pour('task');
    const ctx = { enfants: () => [], repoRef: () => 'grp/app', lireDisque: () => null, masquer: (v) => v, slug: () => null, uid: () => null, margeInconnue: () => [] };
    const doc = e.toFile(db.prepare('SELECT * FROM task WHERE id = ?').get(r1), ctx);
    assert.equal(doc.resumed_from, 'UID-ORIGINE'); assert.equal(doc.resumed_target, 'UID-CIBLE');
    assert.ok(!('session_key' in doc) && !('auto_push' in doc), 'ni handle ni auto_push dans le fichier');
    const row = e.fromFile({ uid: 'UID-R1', kind: 'code', prompt: 'x', targets: [{ repo: 'grp/app' }], resumed_from: 'UID-ORIGINE', resumed_target: 'UID-CIBLE' }, { repoId: () => repoId, ecrireDisque: () => null, idParSlug: () => null, id: () => null });
    assert.deepEqual([row.resumed_from_uid, row.resumed_target_uid, row.auto_push], ['UID-ORIGINE', 'UID-CIBLE', 0]);
    assert.ok(!e.locales.includes('resumed_from_uid'), 'd’équipe : c’est ce qui fait apparaître « reprise par » chez tout le monde');
  });

  test('le module n’appelle aucune IA : fermé à agent/ (hors passes et tâches), aucun `resume`', () => {
    const src = lireSource('session/reprise');
    const imports = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    assert.deepEqual(imports.filter((i) => i.includes('/agent/')), ['../agent/pass', '../agent/tasks']);
    assert.ok(!/runInSession|copilot|tg\.session_key|resume:\s*true/.test(src), 'aucun handle d’agent repris, aucun appel d’IA');
    assert.ok(!/fetch\(/.test(src));
  });
});
