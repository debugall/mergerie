'use strict';
/* LA CONNAISSANCE PARTAGÉE — l'aller-retour de ce qu'une équipe a le plus intérêt à écrire une
 * seule fois : ses règles de review, ses vérificateurs, ses agents et leur carte du code.
 *
 * Ce sous-lot est le cœur de la promesse. Une carte de domaine coûte des heures d'agent à
 * produire ; la refaire sur chaque poste, c'est payer six fois la même chose et obtenir six
 * réponses légèrement différentes. Un vérificateur, c'est la façon dont l'équipe teste — la
 * partager, c'est se mettre d'accord une fois.
 *
 * CE QUE CES ÉPREUVES TIENNENT :
 *
 * — AUCUN IDENTIFIANT DE POSTE NE SORT. Un dépôt se désigne `gitlab/acme/web`, un agent par son
 *   slug, une page par le sien. `repo_id: 12` désignerait autre chose chez le voisin.
 * — L'ORDRE DES COMMANDES SURVIT. `npm ci` avant `npm test` : inversé, le vérificateur échoue
 *   partout, et pour une raison qu'on ne soupçonnerait pas.
 * — UNE RÉFÉRENCE INCONNUE SE SIGNALE. Un vérificateur qui couvre un dépôt que ce poste n'a pas
 *   ne doit pas se croire complet : l'erreur tomberait bien plus tard, au lancement.
 * — LE NUMÉRO DE VERSION SE RECALCULE. `agent_knowledge.version` est un compteur par agent, donc
 *   local par nature : deux postes produiraient chacun une v4. On renumérote dans l'ordre des
 *   uid, qui est l'ordre de création, le même partout.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-store-partage-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

describe('store — règles, vérificateurs, agents et connaissance', () => {
  let db; let store; let agentprofile; let agentknowledge; let repoId;

  before(() => {
    db = require('../src/db');
    store = require('../src/store');
    agentprofile = require('../src/agentprofile');
    agentknowledge = require('../src/agentknowledge');
    const now = new Date().toISOString();
    repoId = db.prepare(`INSERT INTO repo (project, url, forge, enabled, created_at)
      VALUES ('acme/web', 'https://x.test/a.git', 'gitlab', 1, ?)`).run(now).lastInsertRowid;
  });

  test('une règle limitée à un dépôt le désigne par sa clé naturelle', () => {
    const now = new Date().toISOString();
    const ligne = store.ecrire('review_rule', () => db.prepare(
      `INSERT INTO review_rule (branch_match, path_match, label, content, repo_id, enabled, created_at)
       VALUES ('PROJ-', '**/migrations/**', 'risque', 'Relire les migrations.', ?, 1, ?)`,
    ).run(repoId, now).lastInsertRowid);
    const doc = JSON.parse(store.lireFichier(`rules/${ligne.uid}.json`));
    assert.equal(doc.repo, 'gitlab/acme/web');
    assert.ok(!('repo_id' in doc), 'un id entier désignerait un autre dépôt chez le voisin');
    assert.equal(doc.label, 'risque');
  });

  test('un vérificateur emporte ses commandes DANS L’ORDRE et sa couverture', () => {
    const now = new Date().toISOString();
    const v = store.ecrire('verifier', () => {
      const id = db.prepare(`INSERT INTO verifier (name, kind, command, timeout_s, run_base, created_at)
        VALUES ('CI web', 'commands', '', 600, 1, ?)`).run(now).lastInsertRowid;
      const ins = db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?,?,?)');
      ['npm ci', 'npm test', 'npm run lint'].forEach((c, i) => ins.run(id, i, c));
      db.prepare(`INSERT INTO verifier_repo (verifier_id, repo_id, mode, checkout_allowed)
                  VALUES (?, ?, 'worktree', 1)`).run(id, repoId);
      return id;
    });
    const doc = JSON.parse(store.lireFichier(`verifiers/${v.uid}.json`));
    assert.deepEqual(doc.commands, ['npm ci', 'npm test', 'npm run lint'],
      'l’ordre porte du sens : `npm ci` avant `npm test`');
    assert.deepEqual(doc.repos, [{ repo: 'gitlab/acme/web', mode: 'worktree', checkout_allowed: 1 }]);
  });

  test('un agent emporte son périmètre, par clé naturelle', () => {
    const a = agentprofile.creer({
      name: 'Documentaliste', kind: 'explore', scope_kind: 'repos',
      repos: [{ repo_id: repoId, role: 'readonly' }],
    });
    const doc = JSON.parse(store.lireFichier('agents/documentaliste/agent.json'));
    assert.equal(doc.slug, 'documentaliste');
    assert.deepEqual(doc.repos, [{ repo: 'gitlab/acme/web', role: 'readonly' }]);
    assert.ok(!('id' in doc));
    assert.ok(a.id);
  });

  test('une carte de domaine part avec son texte, et se relit hors de l’outil', () => {
    const agent = agentprofile.creer({ name: 'Domaine paiement', kind: 'explore', knowledge_prompt: 'le paiement' });
    agentknowledge.editer(agent, '# Paiement\n\nDeux services, une file.');
    const v = db.prepare('SELECT * FROM agent_knowledge WHERE agent_id = ?').get(agent.id);
    assert.equal(store.lireFichier(`agents/domaine-paiement/knowledge-${v.uid}.md`),
      '# Paiement\n\nDeux services, une file.');
    const meta = JSON.parse(store.lireFichier(`agents/domaine-paiement/knowledge-${v.uid}.json`));
    assert.equal(meta.agent, 'domaine-paiement');
    assert.equal(meta.status, 'active');
    assert.ok(!('version' in meta), 'le numéro de version est un compteur LOCAL : il se recalcule');
    assert.ok(!('md_path' in meta), 'un chemin absolu ne désigne rien sur l’autre poste');
  });

  test('l’aller-retour complet : effacer la base, réhydrater, tout revient', () => {
    const avant = {
      regles: db.prepare('SELECT uid, branch_match, content, repo_id FROM review_rule ORDER BY uid').all(),
      verifs: db.prepare('SELECT uid, name, timeout_s FROM verifier ORDER BY uid').all(),
      cmds: db.prepare('SELECT command FROM verifier_command ORDER BY verifier_id, position').all(),
      agents: db.prepare('SELECT uid, slug, name, kind FROM agent ORDER BY uid').all(),
      cartes: db.prepare('SELECT uid, status FROM agent_knowledge ORDER BY uid').all(),
    };
    assert.ok(avant.regles.length && avant.verifs.length && avant.agents.length && avant.cartes.length);

    db.exec('DELETE FROM review_rule');
    db.exec('DELETE FROM verifier');     // cascade sur commandes et couverture
    db.exec('DELETE FROM agent');        // cascade sur périmètre et connaissance
    const bilan = store.hydraterTout();
    assert.deepEqual(bilan.orphelins, [], 'rien ne devrait manquer : le dépôt est le même');

    assert.deepEqual(db.prepare('SELECT uid, branch_match, content, repo_id FROM review_rule ORDER BY uid').all(), avant.regles);
    assert.deepEqual(db.prepare('SELECT uid, name, timeout_s FROM verifier ORDER BY uid').all(), avant.verifs);
    assert.deepEqual(db.prepare('SELECT command FROM verifier_command ORDER BY verifier_id, position').all(), avant.cmds);
    assert.deepEqual(db.prepare('SELECT uid, slug, name, kind FROM agent ORDER BY uid').all(), avant.agents);
    assert.deepEqual(db.prepare('SELECT uid, status FROM agent_knowledge ORDER BY uid').all(), avant.cartes);
    // Le corps de la carte a été REPOSÉ sur le disque local, là où l'application le lit.
    const k = db.prepare("SELECT md_path FROM agent_knowledge WHERE status = 'active'").get();
    assert.match(fs.readFileSync(k.md_path, 'utf8'), /Deux services, une file/);
  });

  test('les versions de connaissance se renumérotent dans l’ordre des uid', () => {
    const agent = db.prepare("SELECT * FROM agent WHERE slug = 'domaine-paiement'").get();
    for (const texte of ['v deux', 'v trois']) agentknowledge.editer(agent, texte);
    db.exec('DELETE FROM agent_knowledge');
    store.hydraterTout();
    const versions = db.prepare(
      'SELECT version FROM agent_knowledge WHERE agent_id = (SELECT id FROM agent WHERE slug = ?) ORDER BY uid',
    ).all(agent.slug).map((r) => r.version);
    assert.deepEqual(versions, [1, 2, 3], 'deux postes ne doivent jamais produire deux v2');
  });

  test('un dépôt inconnu ici est SIGNALÉ, pas deviné', () => {
    const v = db.prepare('SELECT uid FROM verifier').get();
    const doc = JSON.parse(store.lireFichier(`verifiers/${v.uid}.json`));
    doc.repos = [{ repo: 'gitlab/equipe/service-inconnu', mode: 'worktree' }];
    store.ecrireFichier(`verifiers/${v.uid}.json`, store.serialize(doc));
    const bilan = store.hydraterFichiers([`verifiers/${v.uid}.json`]);
    assert.equal(bilan.orphelins.length, 1, 'le silence ferait échouer la vérification bien plus tard');
    assert.match(bilan.orphelins[0], /service-inconnu/);
  });
});
