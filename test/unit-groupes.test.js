'use strict';
/* LES GROUPES DE DÉPÔTS — ce que le reste du code leur demande (ameliorations_proposal.md, §4.5).
 *
 * Vingt micro-services, une configuration : un groupe porte règles, couverture de vérificateur,
 * gabarits et consignes, et se résout à l'exécution. On éprouve ici la résolution pure, sur une
 * base neuve isolée : global → groupe(s) → dépôt, premier groupe gagnant ; la couverture d'un
 * vérificateur par groupe (worktree, une ligne directe l'emporte) ; une règle limitée à un dépôt
 * OU à un groupe. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'groupes-'));
const db = require('../src/db');
const groupes = require('../src/data/groupes');

describe('data/groupes — la résolution', () => {
  const ids = {};
  before(() => {
    const now = new Date().toISOString();
    for (const p of ['acme/api', 'acme/web', 'acme/legacy']) {
      ids[p] = db.prepare("INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge) VALUES (?, ?, '', 1, ?, 'gitlab')").run(p, `https://gl/${p}.git`, now).lastInsertRowid;
    }
    ids.backend = db.prepare("INSERT INTO repo_group (name, prompt_review, ai_extra_instructions, created_at) VALUES ('backend', 'REVIEW-BACKEND {source}', 'consignes backend', ?)").run(now).lastInsertRowid;
    ids.paiement = db.prepare("INSERT INTO repo_group (name, prompt_fix, ai_extra_instructions, created_at) VALUES ('paiement', 'FIX-PAIEMENT', 'consignes paiement', ?)").run(now).lastInsertRowid;
    const m = db.prepare('INSERT INTO repo_group_member (group_id, repo_id) VALUES (?, ?)');
    m.run(ids.backend, ids['acme/api']); m.run(ids.backend, ids['acme/web']);
    m.run(ids.paiement, ids['acme/api']);
  });

  test('global → groupe(s) → dépôt : le premier groupe qui porte une valeur gagne, champ par champ', () => {
    const cfg = { prompt_review: 'REVIEW-GLOBAL', prompt_fix: 'FIX-GLOBAL', prompt_modify: 'MODIFY-GLOBAL', ai_extra_instructions: 'consignes globales' };
    const api = groupes.configPourDepot(cfg, ids['acme/api']);
    assert.equal(api.config.prompt_review, 'REVIEW-BACKEND {source}', 'backend le porte');
    assert.equal(api.config.prompt_fix, 'FIX-PAIEMENT', 'backend ne le porte pas, paiement oui');
    assert.equal(api.config.prompt_modify, 'MODIFY-GLOBAL', 'aucun groupe : le global');
    assert.equal(api.config.ai_extra_instructions, 'consignes backend', 'les deux le portent : le plus ancien (backend) gagne');
    assert.deepEqual(api.origines.prompt_review, { group_id: ids.backend, name: 'backend' });
    assert.equal(api.origines.prompt_modify, undefined, 'pas d’origine = global');
    const legacy = groupes.configPourDepot(cfg, ids['acme/legacy']);
    assert.deepEqual(legacy.config, cfg, 'un dépôt sans groupe garde la configuration globale telle quelle');
    assert.equal(groupes.consignesPour(cfg, ids['acme/web']), 'consignes backend');
    assert.equal(groupes.consignesPour(cfg, null), 'consignes globales', 'hors dépôt : le global');
  });

  test('la couverture d’un vérificateur : dépôts directs + dépôts des groupes, une ligne directe l’emporte', () => {
    const v = db.prepare("INSERT INTO verifier (name, command, created_at, kind) VALUES ('integ', '', ?, 'commands')").run(new Date().toISOString()).lastInsertRowid;
    db.prepare("INSERT INTO verifier_repo (verifier_id, repo_id, mode, workdir, checkout_allowed) VALUES (?, ?, 'in_place', '/tmp/api', 1)").run(v, ids['acme/api']);
    db.prepare('INSERT INTO verifier_group (verifier_id, group_id) VALUES (?, ?)').run(v, ids.backend);
    const c = groupes.couvertureVerifier(v);
    assert.deepEqual([...c.keys()].sort(), [ids['acme/api'], ids['acme/web']].sort());
    assert.equal(c.get(ids['acme/api']).mode, 'in_place', 'la ligne directe garde son mode');
    assert.equal(c.get(ids['acme/api']).via, 'direct');
    assert.equal(c.get(ids['acme/web']).mode, 'worktree', 'un dépôt apporté par le groupe est en worktree');
    assert.equal(c.get(ids['acme/web']).via, 'group');
    assert.equal(groupes.couvre(v, ids['acme/legacy']), false);
    // Un dépôt ajouté au groupe demain est couvert sans retoucher le vérificateur.
    db.prepare('INSERT INTO repo_group_member (group_id, repo_id) VALUES (?, ?)').run(ids.backend, ids['acme/legacy']);
    assert.equal(groupes.couvre(v, ids['acme/legacy']), true);
    db.prepare('DELETE FROM repo_group_member WHERE group_id = ? AND repo_id = ?').run(ids.backend, ids['acme/legacy']);
  });

  test('une règle vaut partout sans limite, et pour un dépôt OU un groupe avec', () => {
    assert.equal(groupes.regleVautPour({ repo_id: null, group_id: null }, ids['acme/legacy']), true);
    assert.equal(groupes.regleVautPour({ repo_id: ids['acme/web'], group_id: null }, ids['acme/api']), false);
    assert.equal(groupes.regleVautPour({ repo_id: null, group_id: ids.paiement }, ids['acme/api']), true);
    assert.equal(groupes.regleVautPour({ repo_id: null, group_id: ids.paiement }, ids['acme/web']), false);
    assert.equal(groupes.regleVautPour({ repo_id: ids['acme/legacy'], group_id: ids.paiement }, ids['acme/legacy']), true, 'l’un OU l’autre');
    assert.equal(groupes.regleVautPour({ repo_id: ids['acme/legacy'], group_id: ids.paiement }, ids['acme/web']), false);
  });

  test('les groupes d’un dépôt viennent dans l’ordre de création, et la liste porte ses membres', () => {
    assert.deepEqual(groupes.groupesDuDepot(ids['acme/api']).map((g) => g.name), ['backend', 'paiement']);
    const l = groupes.lister();
    assert.deepEqual(l.map((g) => g.name), ['backend', 'paiement']);
    assert.deepEqual(l[0].repos.map((r) => r.project), ['acme/api', 'acme/web']);
  });
});
