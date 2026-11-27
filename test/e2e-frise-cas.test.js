'use strict';
/* LA FRISE DU DÉROULÉ, CAS PAR CAS — ce que les tests du cockpit, de la chaîne et de la convergence ne
 * parcourent pas en faisant tourner de vrais jobs : chaque état d'étape, chaque action de « Continuer », chaque
 * heure de « depuis », posés directement en base et relus par `jobs/workflow.js`, puis l'écran.
 *
 *   1. le codage : question, plan, un projet en échec sur deux, push refusé, MR ouverte, job en cours ou en file ;
 *   2. la convergence : review initiale qui tourne, coupée en pleine correction, plafond, objectif des réglages,
 *      question de correction répondue (on reprend) ou non (on répond) ;
 *   3. la chaîne : base cassée en attente ou en échec, erreur d'un vérificateur, diagnostic en cours / qui
 *      accuse l'environnement / qui accuse la branche, scénario couvert, en écriture, en erreur, relancé,
 *      corrigé, validée — et l'heure d'une vérification en cours ou en file ;
 *   4. plusieurs dépôts : un vérificateur rangé dans ceux qu'il couvre, dans tous s'il n'en couvre aucun ;
 *      « Vérifier après » aussi ;
 *   5. hors dépôt : la question d'un dossier, sa MR sautée, en échec ou ouverte, un dossier inchangé ;
 *   6. l'écran : les routes de « Continuer », la grille au clic et au clavier, ce que chaque phase dit, une
 *      phase dépliée qui le reste, la frise étroite à la verticale, « réduire les animations », « depuis »,
 *      l'aperçu d'une carte à plusieurs dépôts. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('La frise du déroulé, cas par cas', () => {
  let app; let wf; let r1; let r2; let r3; let vA; let vAilleurs;
  const maintenant = () => new Date().toISOString();
  const tache = (id) => app.db.prepare('SELECT * FROM task WHERE id = ?').get(id);
  const cibles = (id) => app.db.prepare('SELECT id FROM task_target WHERE task_id = ? ORDER BY id').all(id).map((x) => x.id);
  const resume = (etapes) => etapes.map((e) => `${e.cle}${e.cote ? `-${e.cote}` : ''}${e.n ? e.n : ''}:${e.etat}`);
  const creer = async (corps) => (await app.api('POST', '/api/tasks', { kind: 'code', prompt: 'frise', ...corps })).body;
  const depot = async (nom) => {
    const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, `${nom.replace('/', '-')}-`)));
    return (await app.api('POST', '/api/repos', { url: r.url, project: nom })).body.id;
  };

  before(async () => {
    app = await startApp();
    // eslint-disable-next-line global-require
    wf = require('../src/jobs/workflow');
    r1 = await depot('grp/api'); r2 = await depot('grp/front'); r3 = await depot('grp/tests');
    vA = (await app.api('POST', '/api/verifiers', { name: 'unitaires', kind: 'commands', commands: ['true'], timeout_s: 60, run_base: 0, repos: [{ repo_id: r1, mode: 'worktree' }] })).body.id;
    vAilleurs = (await app.api('POST', '/api/verifiers', { name: 'e2e', kind: 'commands', commands: ['true'], timeout_s: 60, run_base: 0, repos: [{ repo_id: r3, mode: 'worktree' }] })).body.id;
  });
  after(async () => { if (app) await app.stop(); });

  test('le codage : question, plan, un projet en échec sur deux, push refusé, MR ouverte — l’étape, son heure, « Continuer »', async () => {
    const t = await creer({ auto_push: true, targets: [{ repo_id: r1, branch: 'ai/a' }, { repo_id: r2, branch: 'ai/a' }] });
    const [c1, c2] = cibles(t.id);
    const poser = (tache_, a, b) => {
      app.db.prepare('UPDATE task SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(...tache_, t.id);
      app.db.prepare('UPDATE task_target SET status = ?, commit_sha = ?, last_error = ?, mr_iid = ?, mr_url = ? WHERE id = ?').run(...a, c1);
      app.db.prepare('UPDATE task_target SET status = ?, commit_sha = ?, last_error = ?, mr_iid = ?, mr_url = ? WHERE id = ?').run(...b, c2);
      return wf.frise(tache(t.id));
    };
    // Une question sur le premier projet : à toi depuis le dernier mouvement de la session ; on y répond.
    let f = poser(['needs_input', null, '2026-11-27T08:00:00.000Z'], ['needs_input', null, null, null, null], ['new', null, null, null, null]);
    assert.deepEqual(resume(f.etapes), ['code:a_toi', 'push:a_venir', 'code:a_venir', 'push:a_venir']);
    assert.equal(f.courante, 0);
    assert.equal(f.etapes[0].depuis, '2026-11-27T08:00:00.000Z');
    assert.deepEqual(f.continuer, { action: 'repondre' });
    // Un plan à approuver : à toi aussi, partout.
    f = poser(['planned', null, '2026-11-27T08:00:00.000Z'], ['new', null, null, null, null], ['new', null, null, null, null]);
    assert.deepEqual(resume(f.etapes).filter((x) => x.startsWith('code')), ['code:a_toi', 'code:a_toi']);
    assert.deepEqual(f.continuer, { action: 'repondre' });
    // Le second projet a échoué, le premier est commité : sa raison (première ligne), et « Continuer » le recode, lui seul.
    f = poser(['error', 'boom', maintenant()], ['committed', 'abc1234', null, null, null], ['error', null, 'boom\nla pile', null, null]);
    assert.deepEqual(resume(f.etapes), ['code:fait', 'push:a_venir', 'code:echec', 'push:a_venir']);
    assert.equal(f.etapes[2].detail, 'boom');
    assert.equal(f.etapes[2].depuis, undefined, 'un échec n’a pas de durée');
    assert.deepEqual(f.continuer, { action: 'code', targets: [c2] });
    // Tout est commité mais le push a été refusé : l'échec se pose sur le push, « Continuer » pousse.
    f = poser(['error', 'push refusé', maintenant()], ['committed', 'abc1234', null, null, null], ['committed', 'def5678', null, null, null]);
    assert.equal(f.etapes[1].etat, 'echec');
    assert.equal(f.etapes[1].detail, 'push refusé');
    assert.deepEqual(f.continuer, { action: 'push' });
    // Poussé, MR ouverte : le push porte la MR, que la phase Code donne en lien.
    f = poser(['pushed', null, maintenant()], ['pushed', 'abc1234', null, 12, 'https://gitlab.test/grp/api/-/merge_requests/12'], ['pushed', 'def5678', null, null, null]);
    assert.deepEqual([f.etapes[1].mr_iid, f.etapes[1].mr_url], [12, 'https://gitlab.test/grp/api/-/merge_requests/12']);
    assert.equal(f.courante, null);
    assert.equal(f.continuer, null);
    await app.api('DELETE', `/api/tasks/${t.id}`);
  });

  test('un job : en cours depuis son départ, en file sans heure — et rien à continuer tant qu’il tourne', async () => {
    const t = await creer({ targets: [{ repo_id: r1, branch: 'ai/job' }, { repo_id: r2, branch: 'ai/job' }] });
    const [c1] = cibles(t.id);
    const jobId = app.db.prepare("INSERT INTO job (kind, status, started_at) VALUES ('task', 'running', '2026-11-27T07:00:00.000Z')").run().lastInsertRowid;
    app.db.prepare("UPDATE task_target SET status = 'running' WHERE id = ?").run(c1);
    let f = wf.frise(tache(t.id), { job: { jobId, enFile: false } });
    assert.deepEqual(resume(f.etapes), ['code:en_cours', 'code:en_file'], 'le second attend que le premier finisse');
    assert.equal(f.etapes[0].depuis, '2026-11-27T07:00:00.000Z');
    assert.equal(f.etapes[1].depuis, undefined);
    assert.equal(f.continuer, null);
    app.db.prepare("UPDATE task_target SET status = 'new' WHERE id = ?").run(c1);
    f = wf.frise(tache(t.id), { job: { jobId, enFile: true } });
    assert.deepEqual(resume(f.etapes), ['code:en_file', 'code:en_file']);
    assert.ok(f.etapes.every((e) => e.depuis === undefined), 'en file : pas encore parti');
    await app.api('DELETE', `/api/tasks/${t.id}`);
  });

  test('le codage, encore : une question de suivi après le code, une question avant tout commit, le push qui part', async () => {
    const t = await creer({ auto_push: true, targets: [{ repo_id: r1, branch: 'ai/suivi' }] });
    const [c1] = cibles(t.id);
    // Le code est fait, la session pose une question de suivi : l'attente se pose sur le codage.
    app.db.prepare("UPDATE task SET status = 'needs_input', updated_at = '2026-11-27T04:00:00.000Z' WHERE id = ?").run(t.id);
    app.db.prepare("UPDATE task_target SET status = 'pushed', commit_sha = 'abc' WHERE id = ?").run(c1);
    let f = wf.frise(tache(t.id));
    assert.deepEqual(resume(f.etapes), ['code:a_toi', 'push:fait']);
    assert.deepEqual([f.etapes[0].depuis, f.continuer], ['2026-11-27T04:00:00.000Z', { action: 'repondre' }]);
    // Une seule cible, rien de commité, la session attend : à toi aussi.
    app.db.prepare("UPDATE task_target SET status = 'new', commit_sha = NULL WHERE id = ?").run(c1);
    f = wf.frise(tache(t.id));
    assert.deepEqual(resume(f.etapes), ['code:a_toi', 'push:a_venir']);
    // La session en erreur avant que sa cible n'ait bougé : l'échec se pose sur le codage, qu'on relance.
    app.db.prepare("UPDATE task SET status = 'error', last_error = 'agent introuvable' WHERE id = ?").run(t.id);
    f = wf.frise(tache(t.id));
    assert.deepEqual([resume(f.etapes)[0], f.etapes[0].detail, f.continuer], ['code:echec', 'agent introuvable', { action: 'code', targets: [c1] }]);
    // Commité, le job pousse : le push tourne.
    const jobId = app.db.prepare("INSERT INTO job (kind, status, started_at) VALUES ('task', 'running', '2026-11-27T07:30:00.000Z')").run().lastInsertRowid;
    app.db.prepare("UPDATE task SET status = 'running' WHERE id = ?").run(t.id);
    app.db.prepare("UPDATE task_target SET status = 'committed', commit_sha = 'abc' WHERE id = ?").run(c1);
    f = wf.frise(tache(t.id), { job: { jobId, enFile: false } });
    assert.deepEqual(resume(f.etapes), ['code:fait', 'push:en_cours']);
    await app.api('DELETE', `/api/tasks/${t.id}`);
  });

  test('« Vérifier après » sans chaîne : à venir, en file, en cours, vert, rouge ; un vérificateur supprimé de la chaîne ne laisse pas d’étape', async () => {
    const vSeul = (await app.api('POST', '/api/verifiers', { name: 'seul', kind: 'commands', commands: ['true'], timeout_s: 60, run_base: 0, repos: [{ repo_id: r1, mode: 'worktree' }] })).body.id;
    const t = await creer({ targets: [{ repo_id: r1, branch: 'ai/apres' }] });
    app.db.prepare("UPDATE task SET verifier_id = ?, status = 'pushed' WHERE id = ?").run(vSeul, t.id);
    app.db.prepare("UPDATE task_target SET status = 'pushed', commit_sha = 'abc' WHERE task_id = ?").run(t.id);
    const verif = () => wf.frise(tache(t.id)).etapes.find((e) => e.cle === 'verif');
    assert.deepEqual([verif().nom, verif().etat, verif().verification_id], ['seul', 'a_venir', null]);
    const id = app.db.prepare(`INSERT INTO verification (verifier_id, verifier_name, status, targets_json, created_at)
      VALUES (?, 'seul', 'queued', '[]', ?)`).run(vSeul, maintenant()).lastInsertRowid;
    assert.deepEqual([verif().etat, verif().verification_id, !!verif().depuis], ['en_file', id, true]);
    const etats = [];
    for (const [status, verdict] of [['running', null], ['done', 'verified_pass'], ['done', 'verified_fail']]) {
      app.db.prepare('UPDATE verification SET status = ?, verdict = ?, started_at = ? WHERE id = ?').run(status, verdict, maintenant(), id);
      etats.push(verif().etat);
    }
    assert.deepEqual(etats, ['en_cours', 'fait', 'echec']);
    // Un vérificateur supprimé que la chaîne nommait encore : pas d'étape pour lui, les autres restent.
    app.db.prepare('UPDATE task SET verifier_id = NULL, verify_chain = ? WHERE id = ?').run(JSON.stringify([999999, vSeul]), t.id);
    assert.deepEqual(wf.frise(tache(t.id)).etapes.filter((e) => e.cle === 'verif').map((e) => e.nom), ['seul', 'seul']);
    await app.api('DELETE', `/api/tasks/${t.id}`);
  });

  test('la convergence : review initiale qui tourne, coupée en pleine correction, plafond, objectif des réglages', async () => {
    // La première review tourne (pas encore de note) : depuis le changement d'étape.
    const initiale = wf.etapesConvergence({ status: 'running', phase: 'review', passes_done: 0, max_passes: 2, threshold: 8, notes_json: null, start_note: null, started_at: '2026-11-27T07:00:00.000Z', phase_at: '2026-11-27T07:05:00.000Z' }, null, 3);
    assert.deepEqual(resume(initiale), ['review:en_cours', 'fix1:a_venir', 'review1:a_venir', 'fix2:a_venir', 'review2:a_venir']);
    assert.equal(initiale[0].depuis, '2026-11-27T07:05:00.000Z');
    assert.ok(initiale.slice(1).every((e) => e.si), 'les passes n’auront lieu que si la note reste basse');
    // Avant la colonne `phase_at` : le départ de la boucle.
    assert.equal(wf.etapesConvergence({ status: 'running', phase: 'review', passes_done: 0, max_passes: 1, notes_json: null, started_at: '2026-11-27T07:00:00.000Z' }, null, 3)[0].depuis, '2026-11-27T07:00:00.000Z');
    // Coupée pendant la deuxième correction : l'échec et sa raison, rien après, pas de fin.
    const coupee = wf.etapesConvergence({ status: 'error', phase: 'fix', passes_done: 1, max_passes: 3, threshold: 8, notes_json: '[5,6]', message: 'agent planté' }, null, 3);
    assert.deepEqual(resume(coupee), ['review:fait', 'fix1:fait', 'review1:fait', 'fix2:echec']);
    assert.equal(coupee[3].detail, 'agent planté');
    // Au plafond : la fin le dit, avec la meilleure note.
    const plafond = wf.etapesConvergence({ status: 'capped', phase: null, passes_done: 2, max_passes: 2, threshold: 9, notes_json: '[5,6,7]', best_note: 7 }, null, 3);
    assert.deepEqual(resume(plafond).at(-1), 'converge-fin:fait');
    assert.deepEqual([plafond.at(-1).detail, plafond.at(-1).note], ['capped', 7]);
    // Arrêtée en erreur après la boucle (phase close) : la fin porte l'échec.
    const finEchec = wf.etapesConvergence({ status: 'error', phase: null, passes_done: 1, max_passes: 3, threshold: 8, notes_json: '[5,6]', best_note: 6 }, null, 3);
    assert.deepEqual([resume(finEchec).at(-1), finEchec.at(-1).detail], ['converge-fin:echec', 'error']);
    // Pas encore de boucle : l'objectif et le nombre de passes viennent des réglages.
    await app.api('PUT', '/api/config', { converge_threshold: '7.5' });
    const avant = wf.etapesConvergence(null, null, 2);
    assert.ok(avant.every((e) => e.seuil === 7.5 && e.max === 2), JSON.stringify(avant));
    await app.api('PUT', '/api/config', { converge_threshold: '8' });
  });

  test('une question pendant une correction : répondue, « Continuer » reprend la convergence ; sinon, il faut y répondre', async () => {
    const t = await creer({ auto_push: true, targets: [{ repo_id: r1, branch: 'ai/conv' }] });
    const [c1] = cibles(t.id);
    const mrId = app.db.prepare('INSERT INTO mr (repo_id, iid) VALUES (?, 30)').run(r1).lastInsertRowid;
    app.db.prepare("UPDATE task_target SET status = 'pushed', commit_sha = 'abc', mr_iid = 30 WHERE id = ?").run(c1);
    app.db.prepare("UPDATE task SET status = 'pushed' WHERE id = ?").run(t.id);
    app.db.prepare(`INSERT INTO convergence_run (mr_id, status, threshold, max_passes, passes_done, notes_json, phase, started_at, finished_at)
      VALUES (?, 'needs_input', 8, 3, 1, '[5,6]', 'fix', ?, '2026-11-27T09:30:00.000Z')`).run(mrId, maintenant());
    let f = wf.frise(tache(t.id));
    const c = f.etapes[f.courante];
    assert.deepEqual([c.cle, c.n, c.etat, c.depuis], ['fix', 2, 'a_toi', '2026-11-27T09:30:00.000Z']);
    assert.deepEqual(f.continuer, { action: 'converge' }, 'les réponses sont données : on reprend');
    app.db.prepare("UPDATE task_target SET status = 'needs_input' WHERE id = ?").run(c1);
    app.db.prepare("UPDATE task SET status = 'needs_input' WHERE id = ?").run(t.id);
    f = wf.frise(tache(t.id));
    assert.deepEqual(f.continuer, { action: 'repondre' }, 'la question attend encore');
    // Une boucle plus récente, finie en erreur : « Continuer » reprend la convergence depuis sa fin.
    app.db.prepare("UPDATE task_target SET status = 'pushed' WHERE id = ?").run(c1);
    app.db.prepare("UPDATE task SET status = 'pushed' WHERE id = ?").run(t.id);
    app.db.prepare(`INSERT INTO convergence_run (mr_id, status, threshold, max_passes, passes_done, notes_json, phase, started_at, finished_at)
      VALUES (?, 'error', 8, 3, 1, '[5,6]', NULL, ?, ?)`).run(mrId, maintenant(), maintenant());
    f = wf.frise(tache(t.id));
    assert.deepEqual([f.etapes[f.courante].cle, f.etapes[f.courante].etat], ['converge-fin', 'echec']);
    assert.deepEqual(f.continuer, { action: 'converge' });
    await app.api('DELETE', `/api/tasks/${t.id}`);
  });

  test('la chaîne : chaque état d’un côté, d’un diagnostic et du scénario, l’action de « Continuer », l’heure d’une vérification', async () => {
    const t = await creer({ auto_push: true, verify_chain: [vA], verify_chain_scenario: { verifier_id: vA }, targets: [{ repo_id: r1, branch: 'ai/ch' }] });
    const [c1] = cibles(t.id);
    app.db.prepare("UPDATE task_target SET status = 'pushed', commit_sha = 'abc' WHERE id = ?").run(c1);
    app.db.prepare("UPDATE task SET status = 'pushed' WHERE id = ?").run(t.id);
    const cote = (etat, extra = {}) => ({ etat, essai: 1, verification_id: null, ...extra });
    const pas = (base, head, extra = {}) => ({ verifier_id: vA, verifier_name: 'unitaires', base: cote(base), head: cote(head), erreur: null, diag: null, ...extra });
    const lire = (status, steps, scenario = null) => wf.frise(tache(t.id), { chaine: { status, steps, scenario } });
    const chaine = (f) => f.etapes.filter((e) => e.cle === 'verif' || e.cle === 'diag' || e.cle.startsWith('scen-') || e.cle === 'validee');
    // Base cassée : à toi quand la chaîne s'est arrêtée pour toi, en échec sinon ; « Continuer » relance la chaîne.
    let f = lire('attention', [pas('broken', 'waiting')]);
    assert.deepEqual(resume(chaine(f)).slice(0, 2), ['verif-base:a_toi', 'verif-head:a_venir']);
    assert.deepEqual(f.continuer, { action: 'chaine' });
    f = lire('running', [pas('broken', 'waiting')]);
    assert.equal(chaine(f)[0].etat, 'echec');
    assert.deepEqual(f.continuer, { action: 'chaine' });
    // L'erreur d'un vérificateur (base verte) se pose sur la branche, avec sa raison.
    f = lire('attention', [pas('pass', 'waiting', { erreur: 'dépôt introuvable' })]);
    assert.deepEqual([chaine(f)[1].etat, chaine(f)[1].detail], ['a_toi', 'dépôt introuvable']);
    // Le diagnostic : en cours ; il accuse l'environnement (à toi, avec sa cause) ; il accuse la branche (fait).
    f = lire('running', [pas('pass', 'broken', { diag: { en_cours: true, rounds: 1, cause: null } })]);
    assert.equal(chaine(f).find((e) => e.cle === 'diag').etat, 'en_cours');
    f = lire('attention', [pas('pass', 'broken', { diag: { en_cours: false, rounds: 1, cause: 'environnement' } })]);
    assert.deepEqual(['etat', 'detail'].map((k) => chaine(f).find((e) => e.cle === 'diag')[k]), ['a_toi', 'environnement']);
    f = lire('running', [pas('pass', 'broken', { diag: { en_cours: false, rounds: 2, cause: 'branche' } })]);
    assert.equal(chaine(f).find((e) => e.cle === 'diag').etat, 'fait');
    // Le scénario : déjà couvert par un existant (pousser et lancer sans objet), validée.
    f = lire('validated', [pas('pass', 'pass')], { couvert: { par: 'scenarios/existant.sh' }, fichiers: [] });
    assert.deepEqual(resume(chaine(f)), ['verif-base:fait', 'verif-head:fait', 'scen-ecrire:fait', 'scen-pousser:saute', 'scen-lancer:saute', 'validee:fait']);
    assert.equal(f.etapes.find((e) => e.cle === 'scen-ecrire').detail, 'scenarios/existant.sh');
    assert.deepEqual([f.courante, f.continuer], [null, null]);
    // En écriture ; en erreur avant d'avoir écrit (à toi, sa raison, on relance) ; écrit, poussé sur sa branche, lancé et cassé.
    f = lire('running', [pas('pass', 'pass')], { en_cours: 'ecrire', fichiers: [] });
    assert.equal(f.etapes.find((e) => e.cle === 'scen-ecrire').etat, 'en_cours');
    f = lire('attention', [pas('pass', 'pass')], { fichiers: [], erreur: 'pas de dépôt de tests' });
    assert.deepEqual(['etat', 'detail'].map((k) => f.etapes.find((e) => e.cle === 'scen-ecrire')[k]), ['a_toi', 'pas de dépôt de tests']);
    assert.deepEqual(f.continuer, { action: 'chaine' });
    f = lire('attention', [pas('pass', 'pass')], { fichiers: ['tests/panier.spec.js'], branche: 'tests/ai-ch', run: { etat: 'broken', essai: 2, verification_id: null } });
    assert.deepEqual(resume(f.etapes.filter((e) => e.cle.startsWith('scen-'))), ['scen-ecrire:fait', 'scen-pousser:fait', 'scen-lancer:a_toi']);
    assert.equal(f.etapes.find((e) => e.cle === 'scen-pousser').detail, 'tests/ai-ch');
    assert.equal(f.etapes.find((e) => e.cle === 'scen-lancer').essai, 2);
    // Écrit, mais une erreur ensuite (le push du test refusé) : le lancement porte l'erreur — à toi ou en échec.
    f = lire('attention', [pas('pass', 'pass')], { fichiers: ['tests/panier.spec.js'], erreur: 'push du test refusé', run: { etat: 'pass' } });
    assert.deepEqual(['etat', 'detail'].map((k) => f.etapes.find((e) => e.cle === 'scen-lancer')[k]), ['a_toi', 'push du test refusé']);
    f = lire('running', [pas('pass', 'pass')], { fichiers: ['tests/panier.spec.js'], erreur: 'push du test refusé', run: { etat: 'pass' } });
    assert.equal(f.etapes.find((e) => e.cle === 'scen-lancer').etat, 'echec');
    // La session corrige le test : le lancement est en échec, la correction tourne ; puis elle a corrigé.
    f = lire('running', [pas('pass', 'pass')], { fichiers: ['tests/panier.spec.js'], en_cours: 'corriger', corrections: 0, run: { etat: 'broken' } });
    assert.deepEqual(resume(f.etapes.filter((e) => e.cle.startsWith('scen-'))).slice(2), ['scen-lancer:echec', 'scen-corriger:en_cours']);
    f = lire('running', [pas('pass', 'pass')], { fichiers: ['tests/panier.spec.js'], corrections: 1, run: { etat: 'running' } });
    assert.deepEqual(resume(f.etapes.filter((e) => e.cle.startsWith('scen-'))).slice(2), ['scen-lancer:en_cours', 'scen-corriger1:fait']);
    // L'heure d'une vérification : en cours depuis son départ, en file depuis sa création.
    const verif = (status, debut) => app.db.prepare(`INSERT INTO verification (verifier_id, verifier_name, status, targets_json, started_at, created_at)
      VALUES (?, 'unitaires', ?, '[]', ?, '2026-11-27T06:00:00.000Z')`).run(vA, status, debut).lastInsertRowid;
    const enCours = verif('running', '2026-11-27T06:02:00.000Z');
    f = lire('running', [{ ...pas('running', 'waiting'), base: cote('running', { verification_id: enCours }) }]);
    assert.equal(chaine(f)[0].depuis, '2026-11-27T06:02:00.000Z');
    const enFile = verif('queued', null);
    f = lire('running', [{ ...pas('queued', 'waiting'), base: cote('queued', { verification_id: enFile }) }]);
    assert.deepEqual([chaine(f)[0].etat, chaine(f)[0].depuis], ['en_file', '2026-11-27T06:00:00.000Z']);
    await app.api('DELETE', `/api/tasks/${t.id}`);
  });

  test('plusieurs dépôts : chaque vérificateur dans les dépôts qu’il couvre, dans tous s’il n’en couvre aucun ; « Vérifier après » aussi', async () => {
    const t = await creer({ auto_push: true, verify_chain: [vA, vAilleurs], targets: [{ repo_id: r1, branch: 'ai/m' }, { repo_id: r2, branch: 'ai/m' }] });
    const [c1, c2] = cibles(t.id);
    let f = wf.frise(tache(t.id));
    const range = (nom) => f.etapes.filter((e) => e.cle === 'verif' && e.nom === nom).map((e) => e.cibles);
    assert.deepEqual(range('unitaires'), [[c1], [c1]], '« unitaires » ne couvre que grp/api');
    assert.deepEqual(range('e2e'), [[c1, c2], [c1, c2]], '« e2e » ne couvre que le dépôt de tests : dans toutes les frises');
    assert.deepEqual(f.etapes.find((e) => e.cle === 'validee').cibles, [c1, c2]);
    assert.ok(f.etapes.filter((e) => e.cle === 'code').every((e) => e.cibles === undefined && e.cible != null), 'le code reste sur sa ligne');
    // « Vérifier après » (sans chaîne) : rangé de même.
    app.db.prepare('UPDATE task SET verify_chain = NULL, verifier_id = ? WHERE id = ?').run(vA, t.id);
    f = wf.frise(tache(t.id));
    assert.deepEqual(f.etapes.filter((e) => e.cle === 'verif').map((e) => e.cibles), [[c1]]);
    // Un seul dépôt : rien à ranger.
    const seul = await creer({ verify_chain: [vA], targets: [{ repo_id: r1, branch: 'ai/s' }] });
    assert.ok(wf.frise(tache(seul.id)).etapes.every((e) => e.cibles === undefined));
    await app.api('DELETE', `/api/tasks/${t.id}`);
    await app.api('DELETE', `/api/tasks/${seul.id}`);
  });

  test('hors dépôt : la question d’un dossier, sa MR sautée, en échec ou ouverte, un dossier inchangé', async () => {
    const ltId = app.db.prepare(`INSERT INTO local_task (prompt, status, branch, auto_push, create_mr, converge_after, created_at, updated_at)
      VALUES ('frise', 'running', 'feature/x', 1, 1, 1, ?, ?)`).run(maintenant(), maintenant()).lastInsertRowid;
    const dossier = (label, champs) => app.db.prepare(`INSERT INTO local_task_dir (task_id, path, dir_label, status, git_status, git_note, mr_iid, mr_url, updated_at)
      VALUES (@t, '', @label, @status, @git, @note, @iid, @url, @at)`).run({ t: ltId, label, status: 'done', git: null, note: null, iid: null, url: null, at: null, ...champs }).lastInsertRowid;
    const question = dossier('a', { status: 'needs_input', at: '2026-11-27T05:00:00.000Z' });
    dossier('b', { git: 'pushed', note: 'no-origin' });
    dossier('c', { git: 'pushed', note: 'mr-error: 403 interdit' });
    dossier('d', { git: 'pushed', iid: 5, url: 'https://gitlab.test/grp/d/-/merge_requests/5' });
    dossier('e', { git: 'unchanged' });
    const lt = app.db.prepare('SELECT * FROM local_task WHERE id = ?').get(ltId);
    let f = wf.friseLocale(lt);
    const de = (label) => resume(f.etapes.filter((e) => e.projet === label));
    assert.equal(f.etapes[0].depuis, '2026-11-27T05:00:00.000Z', 'la question, depuis le dernier mouvement de son dossier');
    assert.deepEqual(f.continuer, { action: 'repondre' });
    assert.deepEqual(de('b'), ['code:fait', 'commit:fait', 'push:fait', 'mr:saute'], 'sans remote connue : ni MR ni convergence');
    assert.equal(f.etapes.find((e) => e.projet === 'b' && e.cle === 'mr').detail, 'no-origin');
    assert.equal(f.etapes.find((e) => e.projet === 'c' && e.cle === 'mr').detail, '403 interdit');
    assert.deepEqual(['mr_iid', 'mr_url'].map((k) => f.etapes.find((e) => e.projet === 'd' && e.cle === 'mr')[k]), [5, 'https://gitlab.test/grp/d/-/merge_requests/5']);
    assert.deepEqual(de('e'), ['code:fait', 'commit:saute'], 'rien de modifié : rien après');
    // La question répondue, la MR en échec devient l'étape arrêtée : « Converger » la reprend.
    app.db.prepare("UPDATE local_task_dir SET status = 'done', git_status = 'unchanged' WHERE id = ?").run(question);
    f = wf.friseLocale(lt);
    assert.deepEqual([f.etapes[f.courante].projet, f.etapes[f.courante].cle], ['c', 'mr']);
    assert.deepEqual(f.continuer, { action: 'converge' });
    app.db.prepare('DELETE FROM local_task WHERE id = ?').run(ltId);
  });

  test('hors dépôt, un job : le dossier qui code, ceux qui attendent, le push et la MR en route ; une session en erreur ; sans convergence, rien à reprendre', async () => {
    const ltId = app.db.prepare(`INSERT INTO local_task (prompt, status, branch, auto_push, create_mr, converge_after, created_at, updated_at)
      VALUES ('job', 'running', 'feature/y', 1, 1, 0, ?, ?)`).run(maintenant(), maintenant()).lastInsertRowid;
    const dossier = (label, status, git) => app.db.prepare(`INSERT INTO local_task_dir (task_id, path, dir_label, status, git_status)
      VALUES (?, '', ?, ?, ?)`).run(ltId, label, status, git).lastInsertRowid;
    dossier('a', 'running', null); dossier('b', 'new', null); dossier('c', 'done', 'committed'); dossier('d', 'done', 'pushed');
    const jobId = app.db.prepare("INSERT INTO job (kind, status, started_at) VALUES ('local-task', 'running', '2026-11-27T03:00:00.000Z')").run().lastInsertRowid;
    const lt = () => app.db.prepare('SELECT * FROM local_task WHERE id = ?').get(ltId);
    let f = wf.friseLocale(lt(), { job: { jobId, enFile: false } });
    const de = (label) => resume(f.etapes.filter((e) => e.projet === label));
    assert.deepEqual(de('a'), ['code:en_cours', 'commit:a_venir', 'push:a_venir', 'mr:a_venir']);
    assert.equal(f.etapes[0].depuis, '2026-11-27T03:00:00.000Z');
    assert.deepEqual(de('b'), ['code:en_file', 'commit:a_venir', 'push:a_venir', 'mr:a_venir']);
    assert.deepEqual(de('c'), ['code:fait', 'commit:fait', 'push:en_cours', 'mr:a_venir']);
    assert.deepEqual(de('d'), ['code:fait', 'commit:fait', 'push:fait', 'mr:en_cours']);
    assert.equal(f.continuer, null, 'un job tourne');
    // Le job fini, la session en erreur sans étape active : l'échec se pose sur la première, avec sa raison.
    app.db.prepare("UPDATE local_task_dir SET status = 'done', git_status = 'unchanged' WHERE task_id = ?").run(ltId);
    app.db.prepare("UPDATE local_task SET status = 'error', last_error = 'disque plein\nla pile' WHERE id = ?").run(ltId);
    f = wf.friseLocale(lt());
    assert.deepEqual([f.etapes[0].etat, f.etapes[0].detail, f.courante], ['echec', 'disque plein', 0]);
    // Une MR en échec sans « …puis converger » : rien que « Continuer » saurait reprendre.
    app.db.prepare("UPDATE local_task SET status = 'done' WHERE id = ?").run(ltId);
    app.db.prepare("UPDATE local_task_dir SET git_status = 'pushed', git_note = 'mr-error: 500' WHERE task_id = ? AND dir_label = 'a'").run(ltId);
    f = wf.friseLocale(lt());
    assert.deepEqual([f.etapes[f.courante].cle, f.etapes[f.courante].etat, f.continuer], ['mr', 'echec', null]);
    app.db.prepare('DELETE FROM local_task WHERE id = ?').run(ltId);
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; const erreurs = [];
    // Une frise posée dans la page, sur ses données : le rendu de `friseHtml`, tel que les écrans l'écrivent.
    const poser = (s, opts = {}, largeur = null) => page.evaluate(([s_, o, l]) => {
      let box = document.getElementById('friseEssai');
      if (!box) { box = document.createElement('div'); box.id = 'friseEssai'; document.querySelector('#tab-task').appendChild(box); }
      box.style.width = l ? `${l}px` : '';
      friseHorloge();
      box.innerHTML = friseHtml(s_, o);
    }, [s, opts, largeur]);
    const boite = () => page.locator('#friseEssai');
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    test('« Continuer » appelle la route de son action : recoder les projets, pousser, converger, relancer la chaîne ; hors dépôt, recoder les dossiers, converger', async () => {
      const visee = (url) => /\/api\/(local-)?tasks\/987654\//.test(new URL(url).pathname);
      await page.route((url) => visee(url.href), (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
      const cas = [
        ['code', { action: 'code', targets: [3, 4] }, 'POST /api/tasks/987654/run {"targets":[3,4]}'],
        ['code', { action: 'code' }, 'POST /api/tasks/987654/run {"targets":[]}'],
        ['code', { action: 'push' }, 'POST /api/tasks/987654/push-all {}'],
        ['code', { action: 'converge' }, 'POST /api/tasks/987654/converge {}'],
        ['code', { action: 'chaine' }, 'POST /api/tasks/987654/chaine/relancer {}'],
        ['local', { action: 'code', targets: [5] }, 'POST /api/local-tasks/987654/run {"dirs":[5]}'],
        ['local', { action: 'converge' }, 'POST /api/local-tasks/987654/converge {}'],
      ];
      for (const [kind, continuer, attendu] of cas) {
        await poser({ id: 987654, kind, workflow: { etapes: [{ cle: 'code', etat: 'echec' }], courante: 0, continuer } });
        const [req] = await Promise.all([
          page.waitForRequest((r) => visee(r.url())),
          boite().locator('[data-frise-continuer]').click(),
        ]);
        assert.equal(`${req.method()} ${new URL(req.url()).pathname} ${req.postData() || ''}`, attendu);
      }
      await page.unrouteAll({ behavior: 'wait' });
    });

    test('« Répondre pour continuer » ouvre la session', async () => {
      const t = await creer({ targets: [{ repo_id: r1, branch: 'ai/repondre' }] });
      await poser({ id: t.id, kind: 'code', workflow: { etapes: [{ cle: 'code', etat: 'a_toi' }], courante: 0, continuer: { action: 'repondre' } } });
      await boite().locator('[data-frise-continuer][data-action="repondre"]').click();
      await page.locator(`#taskList .task-row[data-task="${t.id}"]`).waitFor();
      assert.equal(await page.locator('#tab-task .subnav [data-kind="code"].active').count(), 1);
      await app.api('DELETE', `/api/tasks/${t.id}`);
    });

    test('une case de la grille ouvre son rapport, au clic comme au clavier', async () => {
      const v = (cote, etat, id) => ({ cle: 'verif', cote, nom: 'unitaires', etat, verification_id: id });
      const s = { id: 9100, kind: 'code', workflow: { etapes: [v('base', 'fait', 41), v('head', 'echec', 42), { cle: 'validee', etat: 'a_venir' }], courante: 1, continuer: null } };
      await poser(s);
      await boite().locator('.frise-case[data-chaine-verif="42"]').click();
      await page.locator('#verifyModal:not([hidden])').waitFor();
      await page.evaluate(() => { document.getElementById('verifyModal').hidden = true; });
      await poser(s);
      await boite().locator('.frise-case[data-chaine-verif="41"]').focus();
      await page.keyboard.press('Enter');
      await page.locator('#verifyModal:not([hidden])').waitFor();
      await page.evaluate(() => { document.getElementById('verifyModal').hidden = true; });
    });

    test('chaque phase dit ce qu’elle a produit : raison d’un échec, objectif avant la boucle, fin de convergence, scénario, arrivée', async () => {
      // Un codage en échec : son statut et sa raison ; hors dépôt avec MR, la phase s'appelle « Code, push & MR ».
      await poser({ id: 9101, kind: 'local', workflow: { etapes: [{ cle: 'code', etat: 'echec', detail: 'agent en échec' }, { cle: 'commit', etat: 'a_venir' }, { cle: 'mr', etat: 'a_venir' }], courante: 0, continuer: null } });
      const code = boite().locator('.frise-phase.ph-code');
      assert.equal(await code.locator('.frise-nom').textContent(), 'Code, push & MR');
      assert.match(await code.locator('.frise-statut').textContent(), /en échec/);
      assert.equal(await code.locator('.frise-raison').textContent(), 'agent en échec');
      // La convergence pas encore partie : l'objectif et les passes ; finie : la meilleure note, la courbe en vert, la fin.
      await poser({ id: 9102, kind: 'code', workflow: { etapes: [{ cle: 'code', etat: 'fait' }, { cle: 'review', n: 0, etat: 'a_venir', seuil: 8, max: 3 }], courante: null, continuer: null } });
      assert.equal(await boite().locator('.ph-convergence .frise-meta').textContent(), 'objectif 8/10 · 3 passes max');
      await poser({ id: 9103, kind: 'code', workflow: { etapes: [{ cle: 'review', n: 0, etat: 'fait', note: 6.5, seuil: 8, max: 3 }, { cle: 'fix', n: 1, etat: 'fait', seuil: 8, max: 3 },
        { cle: 'review', n: 1, etat: 'fait', note: 8.4, seuil: 8, max: 3 }, { cle: 'converge-fin', etat: 'fait', detail: 'converged', note: 8.4, seuil: 8, max: 3 }], courante: null, continuer: null } });
      const conv = boite().locator('.frise-phase.ph-convergence');
      assert.match(await conv.getAttribute('class'), /is-fait/);
      assert.equal(await conv.locator('.frise-score').textContent(), '8,4');
      assert.match(await conv.textContent(), /seuil atteint/);
      assert.equal(await conv.locator('.frise-statut').count(), 0, 'rien d’actif');
      // Une seule note : pas de courbe ; la boucle finie en erreur : la fin, en échec.
      await poser({ id: 9108, kind: 'code', workflow: { etapes: [{ cle: 'review', n: 0, etat: 'fait', note: 5, seuil: 8, max: 3 },
        { cle: 'converge-fin', etat: 'echec', detail: 'error', seuil: 8, max: 3 }], courante: 1, continuer: null } });
      assert.equal(await boite().locator('.ph-convergence .frise-score').textContent(), '5');
      assert.equal(await boite().locator('.ph-convergence svg.frise-courbe').count(), 0);
      assert.match(await boite().locator('.ph-convergence').textContent(), /Fin de convergence[\s\S]*en échec/);
      // Une boucle d'avant l'objectif enregistré : la courbe sans ligne visée, la passe sur ce qu'on sait.
      await poser({ id: 9110, kind: 'code', workflow: { etapes: [{ cle: 'review', n: 0, etat: 'fait', note: 6 }, { cle: 'fix', n: 1, etat: 'fait' },
        { cle: 'review', n: 1, etat: 'fait', note: 6 }, { cle: 'fix', n: 2, etat: 'en_cours' }], courante: 3, continuer: null } });
      assert.equal(await boite().locator('.ph-convergence svg.frise-courbe').getAttribute('aria-label'), '6 → 6');
      assert.equal(await boite().locator('.ph-convergence .frise-courbe-cible').count(), 0);
      assert.match(await boite().locator('.ph-convergence').textContent(), /passe 2\/2 · correction/);
      // Le scénario : dans le dépôt de tests ; déjà couvert ; son lancement qui attend.
      const scen = (etapes) => poser({ id: 9104, kind: 'code', workflow: { etapes: [...etapes, { cle: 'validee', etat: etapes.every((e) => ['fait', 'saute'].includes(e.etat)) ? 'fait' : 'a_venir' }], courante: etapes.findIndex((e) => e.etat === 'a_toi') < 0 ? null : etapes.findIndex((e) => e.etat === 'a_toi'), continuer: null } });
      await scen([{ cle: 'scen-ecrire', etat: 'a_venir', projet: 'grp/tests' }, { cle: 'scen-pousser', etat: 'a_venir', projet: 'grp/tests' }, { cle: 'scen-lancer', etat: 'a_venir', projet: 'grp/tests' }]);
      assert.equal(await boite().locator('.ph-scenario .frise-meta').textContent(), 'dans grp/tests');
      await scen([{ cle: 'scen-ecrire', etat: 'fait', projet: 'grp/tests', detail: 'existant.sh' }, { cle: 'scen-pousser', etat: 'saute' }, { cle: 'scen-lancer', etat: 'saute' }]);
      assert.equal(await boite().locator('.ph-scenario .frise-meta').textContent(), 'déjà couvert');
      assert.match(await boite().locator('.frise-phase.is-terminus').getAttribute('class'), /is-fait/, 'l’arrivée s’allume');
      await scen([{ cle: 'scen-ecrire', etat: 'fait', projet: 'grp/tests' }, { cle: 'scen-pousser', etat: 'fait', projet: 'grp/tests' }, { cle: 'scen-lancer', etat: 'a_toi', projet: 'grp/tests' }]);
      assert.match(await boite().locator('.ph-scenario').textContent(), /Exécution du test[\s\S]*à toi/);
    });

    test('une phase dépliée le reste quand la frise est redessinée ; l’en-tête se déplie au clavier', async () => {
      const s = { id: 9105, kind: 'code', workflow: { etapes: [{ cle: 'code', etat: 'fait' }, { cle: 'push', etat: 'fait' }, { cle: 'review', n: 0, etat: 'en_cours', seuil: 8, max: 3 }], courante: 2, continuer: null } };
      await poser(s);
      await boite().locator('.ph-convergence .frise-phase-tete').focus();
      await page.keyboard.press('Enter');
      await boite().locator('.frise-etapes:not([hidden])').waitFor();
      await poser(s);   // la liste relue : un nouveau DOM
      assert.equal(await boite().locator('.ph-convergence .frise-phase-tete').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(await boite().locator('.frise-etapes:not([hidden]) .frise-nom').allTextContents(), ['Review initiale']);
      await boite().locator('.ph-convergence .frise-phase-tete').click();
      await poser(s);
      assert.equal(await boite().locator('.frise-etapes:not([hidden])').count(), 0, 'repliée, elle le reste aussi');
    });

    test('étroite, la frise se redresse à la verticale ; « réduire les animations » arrête l’arc qui tourne', async () => {
      const s = { id: 9106, kind: 'code', workflow: { etapes: [{ cle: 'code', etat: 'fait' }, { cle: 'review', n: 0, etat: 'en_cours' }, { cle: 'validee', etat: 'a_venir' }], courante: 1, continuer: null } };
      await poser(s);
      assert.equal(await boite().locator('.frise-phases').evaluate((e) => getComputedStyle(e).flexDirection), 'row');
      const arc = () => boite().locator('.frise-phase.is-en_cours .frise-noeud').evaluate((e) => getComputedStyle(e, '::before').animationName);
      assert.equal(await arc(), 'frise-tourne');
      await poser(s, {}, 380);
      assert.equal(await boite().locator('.frise-phases').evaluate((e) => getComputedStyle(e).flexDirection), 'column');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await arc(), 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    });

    test('« depuis » : moins d’une minute, en minutes, en heures, en jours', async () => {
      const dits = await page.evaluate(() => [0.5, 14, 125, 3 * 1440 + 10].map((min) => friseDepuis(new Date(Date.now() - min * 60000).toISOString())));
      assert.deepEqual(dits, ['depuis moins d’1 min', 'depuis 14 min', 'depuis 2 h 05', 'depuis 3 j']);
      assert.equal(await page.evaluate(() => friseDepuis(null)), '');
    });

    test('l’aperçu d’une carte à plusieurs dépôts : par dépôt, ses phases en points, celle où il en est et son statut ; « Continuer » à côté', async () => {
      const e = (cle, etat, cible, extra = {}) => ({ cle, etat, cible, projet: cible === 1 ? 'grp/api' : 'grp/front', ...extra });
      const etapes = [e('code', 'fait', 1), e('push', 'fait', 1), e('review', 'a_toi', 1, { n: 0 }), e('code', 'fait', 2), e('push', 'fait', 2),
        { cle: 'validee', etat: 'a_venir', cibles: [1, 2] }];
      await poser({ id: 9107, kind: 'code', workflow: { etapes, courante: 2, continuer: { action: 'converge' } } }, { commun: true });
      const lignes = boite().locator('.frise-apercu-l');
      assert.equal(await lignes.count(), 2);
      assert.match(await lignes.nth(0).textContent(), /grp\/api[\s\S]*Convergence[\s\S]*à toi/);
      assert.equal(await lignes.nth(0).locator('.frise-mini-p.is-ici').getAttribute('class'), 'frise-mini-p is-a_toi is-ici');
      assert.match(await lignes.nth(1).textContent(), /grp\/front[\s\S]*Validée/, 'le second n’attend plus que la validation');
      assert.equal(await boite().locator('.frise-ou [data-frise-continuer][data-action="converge"]').count(), 1);
      // La ligne d'un dépôt porte sa frise entière, validation comprise, sans « Continuer » (il est sur la carte).
      await poser({ id: 9107, kind: 'code', workflow: { etapes, courante: 2, continuer: { action: 'converge' } } }, { cible: 2 });
      assert.deepEqual(await boite().locator('.frise-phase .frise-nom').allTextContents(), ['Code & push', 'Validée']);
      assert.equal(await boite().locator('[data-frise-continuer]').count(), 0);
      // Une étape d'aucun dépôt (donnée d'avant le rangement) : un groupe commun la garde visible.
      await poser({ id: 9109, kind: 'code', workflow: { etapes: [...etapes.slice(0, 5), { cle: 'validee', etat: 'a_venir' }], courante: 2, continuer: null } });
      assert.deepEqual(await boite().locator('.frise-groupe-nom').allTextContents(), ['grp/api', 'grp/front', 'Validation (tous les dépôts)']);
      await page.evaluate(() => document.getElementById('friseEssai').remove());
      assert.deepEqual(erreurs, []);
    });
  });
});
