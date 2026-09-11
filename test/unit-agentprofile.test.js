'use strict';
/* Un PROFIL d'agent devient une session : cibles, demande, options de lancement.
 *
 * Trois choses se cassent séparément et se voient tard :
 *   — les CIBLES (un agent « tous les dépôts » qui n'en prend qu'un, ou l'inverse) ;
 *   — l'ORDRE de la demande (le gabarit avant les skills, la question perdue) ;
 *   — les REFUS de la sauvegarde, qui sont la seule chose qui empêche un profil impossible
 *     d'être découvert au moment où l'on comptait dessus.
 * On les prouve ici sans serveur : ce module ne dépend d'aucune route. */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprofile-'));
process.env.MERGERIE_DATA_DIR = tmp;
process.env.MERGERIE_CLAUDE_HOME = path.join(tmp, 'home');

// eslint-disable-next-line import/order
const db = require('../src/db');
// eslint-disable-next-line import/order
const agentprofile = require('../src/agentprofile');
// eslint-disable-next-line import/order
const agentdefaults = require('../src/agentdefaults');

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

let idApi; let idFront; let idOff;
before(() => {
  const ins = db.prepare("INSERT INTO repo (project, url, enabled, forge) VALUES (?,?,?,'gitlab')");
  idApi = ins.run('grp/api', 'https://x/grp/api.git', 1).lastInsertRowid;
  idFront = ins.run('grp/front', 'https://x/grp/front.git', 1).lastInsertRowid;
  idOff = ins.run('grp/archive', 'https://x/grp/archive.git', 0).lastInsertRowid;
});

const creer = (p) => agentprofile.creer({
  name: p.name, kind: p.kind || 'explore', scope_kind: p.scope_kind || 'all_repos',
  prompt_template: p.prompt_template !== undefined ? p.prompt_template : '{question}',
  system_prompt: p.system_prompt || '', subagents_json: p.subagents_json || {},
  defaults_json: p.defaults_json || {}, knowledge_prompt: p.knowledge_prompt || null,
  max_turns: p.max_turns || null, repos: p.repos || [],
});

describe('agentprofile : les cibles d’un run', () => {
  test('« tous les dépôts » prend les dépôts ACTIFS, jamais les désactivés', () => {
    const a = creer({ name: 'Tout' });
    const m = agentprofile.materialize(a, { mode: 'ask', question: 'q' });
    const ids = m.targets.map((x) => x.repo_id).sort();
    assert.deepEqual(ids, [idApi, idFront].sort());
    assert.ok(!ids.includes(idOff), 'un dépôt désactivé n’est plus suivi : il n’est pas une cible');
  });

  test('un périmètre de liste prend ses dépôts, avec leur branche', () => {
    const a = creer({ name: 'Liste', scope_kind: 'repos', repos: [{ repo_id: idFront, branch: 'develop', role: 'readonly' }] });
    const m = agentprofile.materialize(a, { mode: 'ask', question: 'q' });
    assert.deepEqual(m.targets, [{ repo_id: idFront, branch: 'develop', base_branch: null }]);
  });

  test('en mode « coder », les dépôts reçus RESTREIGNENT le périmètre sans jamais l’élargir', () => {
    const a = creer({ name: 'Codeur', kind: 'code', scope_kind: 'repos',
      repos: [{ repo_id: idApi, role: 'target' }, { repo_id: idFront, role: 'readonly' }] });
    const m = agentprofile.materialize(a, { mode: 'code', question: 'q', repoIds: [idApi] });
    assert.deepEqual(m.targets.map((x) => x.repo_id), [idApi]);
    // Un dépôt hors périmètre demandé par le client ne s'y ajoute pas.
    const m2 = agentprofile.materialize(a, { mode: 'code', question: 'q', repoIds: [idOff] });
    assert.deepEqual(m2.targets, []);
  });

  test('auto_push est toujours 0 — un agent ne pousse jamais de lui-même', () => {
    const a = creer({ name: 'Poussif', kind: 'code' });
    assert.equal(agentprofile.materialize(a, { mode: 'code', question: 'q' }).auto_push, 0);
  });

  test('les cases par défaut du profil sont reprises', () => {
    const a = creer({ name: 'Défauts', defaults_json: { ask_questions: true, notify_jira: true } });
    const m = agentprofile.materialize(a, { mode: 'ask', question: 'q' });
    assert.equal(m.ask_questions, 1);
    assert.equal(m.notify_jira, 1);
    assert.equal(m.label, 'Défauts');
  });
});

describe('agentprofile : la demande composée', () => {
  test('le gabarit remplace {question}, {repos} et {today}', () => {
    const a = creer({ name: 'Gabarit', prompt_template: 'Sujet : {question}\nDépôts :\n{repos}\nDate : {today}' });
    const m = agentprofile.materialize(a, { mode: 'ask', question: 'les notifications' });
    assert.match(m.prompt, /Sujet : les notifications/);
    assert.match(m.prompt, /- grp\/api/);
    assert.match(m.prompt, new RegExp(`Date : ${new Date().toISOString().slice(0, 10)}`));
  });

  test('un gabarit sans {question} n’AVALE pas la demande : elle est ajoutée après', () => {
    // Le piège classique : on affine son gabarit, on retire le marqueur, et la question
    // saisie n'arrive plus jamais à l'agent — sans que rien ne le dise.
    const a = creer({ name: 'SansMarqueur', prompt_template: 'Fais la carte des services.' });
    const m = agentprofile.materialize(a, { mode: 'ask', question: 'et surtout les webhooks' });
    assert.match(m.prompt, /Fais la carte des services\./);
    assert.match(m.prompt, /et surtout les webhooks/);
    assert.ok(m.prompt.indexOf('Fais la carte') < m.prompt.indexOf('et surtout'), 'le gabarit d’abord');
  });

  test('les sous-agents sont NOMMÉS dans la demande, avec leur description', () => {
    const a = creer({ name: 'AvecSous', subagents_json: { chercheur: { description: 'Cherche dans un dépôt.', prompt: 'p' } } });
    const m = agentprofile.materialize(a, { mode: 'ask', question: 'q' });
    assert.match(m.prompt, /chercheur/);
    assert.match(m.prompt, /Cherche dans un dépôt\./);
  });

  test('l’enquêteur reçoit le protocole REPO, le cartographe AGENT, un agent de domaine STALE', () => {
    agentprofile.seedBuiltins();
    const enq = agentprofile.parCle('investigator');
    const carto = agentprofile.parCle('cartographer');
    const dom = creer({ name: 'Domaine', knowledge_prompt: 'les notifications' });
    assert.match(agentprofile.materialize(enq, { mode: 'ask', question: 'trace' }).prompt, /<<<REPO/);
    assert.match(agentprofile.materialize(carto, { mode: 'ask', question: 'sujet' }).prompt, /<<<AGENT/);
    assert.match(agentprofile.materialize(dom, { mode: 'ask', question: 'q' }).prompt, /<<<STALE/);
    // …et chacun n'a QUE le sien : un rapport d'enquête ne doit pas créer d'agent.
    assert.ok(!agentprofile.materialize(enq, { mode: 'ask', question: 'trace' }).prompt.includes('<<<AGENT'));
  });
});

describe('agentprofile : les options de lancement', () => {
  test('sans profil, aucune option — l’argv d’une session ordinaire ne bouge pas', () => {
    assert.deepEqual(agentprofile.optionsFor({ id: 1, agent_id: null }), {});
    assert.deepEqual(agentprofile.optionsFor(null), {});
  });

  test('une allowlist vide retombe sur celle du TYPE d’agent', () => {
    const a = creer({ name: 'Outils', kind: 'code' });
    const t = poserTask(a);
    const o = agentprofile.optionsFor(t);
    assert.deepEqual(o.allowedTools, agentprofile.OUTILS_DEFAUT.code);
    assert.equal(o.permissionMode, 'acceptEdits', 'vide = acceptEdits');
    const b = creer({ name: 'Outils2' });
    assert.deepEqual(agentprofile.optionsFor(poserTask(b)).allowedTools, agentprofile.OUTILS_DEFAUT.explore);
  });

  test('le prompt système fabriqué nomme l’agent et ses dépôts, et AJOUTE le rôle', () => {
    const a = creer({ name: 'Rôlé', system_prompt: 'Tu es l’enquêteur.' });
    const t = poserTask(a);
    const sys = agentprofile.optionsFor(t).appendSystemPrompt;
    assert.match(sys, /Rôlé/);
    assert.match(sys, /grp\/api/);
    assert.match(sys, /Tu es l’enquêteur\./);
  });

  test('une exploration n’ajoute aucun dossier : son cwd est déjà la racine des clones', () => {
    const a = creer({ name: 'Exploratrice', scope_kind: 'repos', repos: [{ repo_id: idApi, role: 'readonly' }] });
    assert.deepEqual(agentprofile.optionsFor(poserTask(a)).addDirs, []);
  });
});

function poserTask(agent) {
  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, status, agent_id, agent_name, created_at, updated_at)
    VALUES (?, 'explore', 'q', '', NULL, 'new', ?, ?, ?, ?)`).run(idApi, agent.id, agent.name, now, now).lastInsertRowid;
  db.prepare("INSERT INTO task_target (task_id, repo_id, branch, status, updated_at) VALUES (?,?,'','new',?)").run(id, idApi, now);
  return db.prepare('SELECT * FROM task WHERE id = ?').get(id);
}

describe('agentprofile : ce que la sauvegarde refuse', () => {
  test('un nom vide, ou déjà pris', () => {
    assert.deepEqual(agentprofile.valider({ name: '' }), ['agents.err.name-required']);
    const a = creer({ name: 'Unique' });
    assert.deepEqual(agentprofile.valider({ name: 'Unique' }), ['agents.err.name-taken']);
    // …mais l'agent lui-même garde son nom en se modifiant.
    assert.deepEqual(agentprofile.valider({ name: 'Unique' }, a.id), []);
  });

  test('un agent de domaine ne peut pas produire des agents : un seul niveau', () => {
    assert.deepEqual(agentprofile.valider({ name: 'X1', output_kind: 'agent', knowledge_prompt: 'un sujet' }),
      ['agents.err.domain-cannot-create']);
    // Le cartographe, lui, n'a pas de connaissance : il a le droit.
    assert.deepEqual(agentprofile.valider({ name: 'X2', output_kind: 'agent' }), []);
  });

  test('un horaire sans borne de tours est refusé', () => {
    // La borne est la seule chose qui rende acceptable un agent qui part seul, la nuit.
    assert.deepEqual(agentprofile.valider({ name: 'X3', schedule: 'daily 07:00' }),
      ['agents.err.schedule-needs-max-turns']);
    assert.deepEqual(agentprofile.valider({ name: 'X4', schedule: 'daily 07:00', max_turns: 40 }), []);
  });

  test('un horaire mal écrit est refusé', () => {
    assert.deepEqual(agentprofile.valider({ name: 'X5', schedule: '* * * * *', max_turns: 40 }),
      ['agents.err.schedule-syntax']);
  });

  test('les refus d’agentargs remontent aussi (mode de permission, sous-agent)', () => {
    assert.ok(agentprofile.valider({ name: 'X6', permission_mode: 'default' }).includes('agents.err.permission-default'));
    assert.ok(agentprofile.valider({ name: 'X7', subagents_json: { a: { description: 'd' } } })
      .includes('agents.err.subagent-incomplete'));
  });
});

describe('agentprofile : les agents livrés', () => {
  test('seedBuiltins est idempotent : deux appels, trois agents', () => {
    agentprofile.seedBuiltins();
    agentprofile.seedBuiltins();
    for (const cle of agentdefaults.CLES) {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM agent WHERE builtin_key = ?').get(cle).n, 1, cle);
    }
  });

  test('il ne RÉÉCRIT jamais un agent modifié — le rôle affiné survit au redémarrage', () => {
    const enq = agentprofile.parCle('investigator');
    agentprofile.modifier(enq.id, { system_prompt: 'Mon rôle à moi.' });
    agentprofile.seedBuiltins();
    assert.equal(agentprofile.lire(enq.id).system_prompt, 'Mon rôle à moi.');
  });

  test('« Restaurer » remet les textes par défaut, et lui seul', () => {
    const enq = agentprofile.parCle('investigator');
    agentprofile.restaurer(enq.id);
    assert.equal(agentprofile.lire(enq.id).system_prompt, agentdefaults.DEFAULTS.fr.investigator.system_prompt);
    // Un agent ordinaire n'a rien à restaurer.
    const perso = creer({ name: 'Perso' });
    assert.equal(agentprofile.restaurer(perso.id), null);
  });

  test('dupliquer donne un agent neuf, sans clé de livraison ni connaissance', () => {
    const enq = agentprofile.parCle('investigator');
    const copie = agentprofile.dupliquer(enq.id);
    assert.notEqual(copie.id, enq.id);
    assert.equal(copie.builtin_key, null);
    assert.equal(copie.knowledge, null);
    assert.match(copie.name, /copie/i);
    assert.equal(copie.system_prompt, enq.system_prompt);
  });

  test('supprimer un agent laisse ses sessions, avec son nom', () => {
    const a = creer({ name: 'Éphémère' });
    const t = poserTask(a);
    agentprofile.supprimer(a.id);
    const apres = db.prepare('SELECT * FROM task WHERE id = ?').get(t.id);
    assert.equal(apres.agent_id, null, 'le lien tombe');
    assert.equal(apres.agent_name, 'Éphémère', '…mais le nom reste : la session est encore lisible');
  });
});
