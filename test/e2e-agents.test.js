'use strict';
/* L'ONGLET AGENTS, de bout en bout.
 *
 * Un agent n'est pas un écran de plus : c'est un profil qui, une fois choisi, change ce que
 * la session envoie au CLI. Le test suit donc le chemin complet — l'écran, la création, le
 * lancement, la session produite, et ce qui reste quand on supprime l'agent.
 *
 * Un seul `startApp()` : les `describe` partagent l'app et le navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Avant `startApp` : le scan des skills lit cette variable au chargement.
process.env.MERGERIE_CLAUDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-home-'));
/* …et le BACKEND, qui décide de l'argv : `claude` reçoit tout le profil, `copilot` le seul
   modèle. Sans ce réglage, le test dépendait du `.env` de la machine — vert ici avec
   `COPILOT_BIN=claude`, rouge sur un runner nu où le défaut est `copilot`. Le binaire n'est
   jamais lancé (le harnais force le dry-run) : seul son NOM compte, `backendName()` en
   déduisant le backend. */
process.env.COPILOT_BIN = 'claude';

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, makeRemoteRepo, waitForJobs } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Agents : l’onglet, les profils, les runs', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let repoId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    const depot = makeRemoteRepo(app.dataDir);
    const r = await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' });
    repoId = r.body.id;

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const rechargerListe = async () => {
    /* Une modale restée ouverte pose un voile qui intercepte tous les clics : un test en échec
       en ferait échouer sept autres, et la vraie cause se perdrait dans la cascade. */
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="agents"]').click();
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#agentList .agent-card').length > 0);
  };

  test('les deux exemples livrés sont là dès le premier démarrage', async () => {
    await rechargerListe();
    const noms = await page.$$eval('#agentList .agent-card strong', (els) => els.map((e) => e.textContent));
    assert.ok(noms.some((n) => /Enquêteur/i.test(n)), noms.join(', '));
    assert.ok(noms.some((n) => /Documentaliste/i.test(n)), noms.join(', '));
    // …et le cartographe, qui crée les autres.
    assert.ok(noms.some((n) => /Cartographe/i.test(n)), noms.join(', '));
  });

  test('l’onglet existe et se nomme dans les deux langues', async () => {
    const fr = await page.locator('nav button[data-tab="agents"] span').first().innerText();
    assert.equal(fr, 'Agents');
    // La bascule de langue ne doit pas laisser une clé brute à l'écran.
    await page.evaluate(() => { localStorage.setItem('aidevtools_lang', 'en'); });
    await page.reload();
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    const titre = await page.locator('#tab-agents .subnav [data-sub="skills"]').innerText();
    assert.ok(!/^agents\./.test(titre), `clé brute affichée : ${titre}`);
    assert.match(titre, /Skills/);
    await page.evaluate(() => { localStorage.setItem('aidevtools_lang', 'fr'); });
    await page.reload();
  });

  test('le filtre de la liste masque sans rien perdre', async () => {
    await rechargerListe();
    const total = await page.locator('#agentList .agent-card').count();
    await page.locator('#agentFilter').fill('documentaliste');
    await page.waitForFunction(() => [...document.querySelectorAll('#agentList .agent-card')].filter((e) => !e.hidden).length === 1);
    await page.locator('#agentFilter').fill('');
    await page.waitForFunction((n) => [...document.querySelectorAll('#agentList .agent-card')].filter((e) => !e.hidden).length === n, total);
  });

  test('créer un agent par le formulaire, et le relire par l’API', async () => {
    await page.locator('#btnNewAgent').click();
    await page.waitForSelector('#agentModal:not([hidden])');
    await page.locator('#agentName').fill('Relecteur maison');
    await page.locator('#agentDesc').fill('Relit ce qui vient d’être écrit.');
    await page.locator('#agentSystemPrompt').fill('Tu relis.');
    await page.locator('#agentTemplate').fill('Relis : {question}');
    await page.locator('#agentSave').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });

    const { body } = await app.api('GET', '/api/agents');
    const a = body.find((x) => x.name === 'Relecteur maison');
    assert.ok(a, 'agent introuvable côté API');
    assert.equal(a.system_prompt, 'Tu relis.');
    assert.equal(a.prompt_template, 'Relis : {question}');
    assert.equal(a.scope_kind, 'all_repos');
  });

  test('l’aperçu de la ligne de commande est affiché, et vient du serveur', async () => {
    await rechargerListe();
    const carte = page.locator('#agentList .agent-card', { hasText: 'Relecteur maison' });
    await carte.locator('.btn-agent-edit').click();
    await page.waitForSelector('#agentModal:not([hidden])');
    // « Capacités » est replié par défaut : on ne touche pas au modèle une fois sur dix.
    await page.evaluate(() => { document.querySelectorAll('#agentForm details').forEach((d) => { d.open = true; }); });
    await page.locator('#agentModel').fill('opus');
    await page.waitForFunction(() => /--model opus/.test(document.querySelector('#agentArgvPreview').textContent));
    const argv = await page.locator('#agentArgvPreview').innerText();
    assert.match(argv, /--append-system-prompt/);
    assert.match(argv, /--permission-mode acceptEdits/);
    // Jamais `--system-prompt` : il effacerait le CLAUDE.md du dépôt et ses skills.
    assert.ok(!/(^|\s)--system-prompt(\s|$)/.test(argv), argv);
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
  });

  test('« Demander » ouvre la session avec l’agent posé, et la soumission crée un run', async () => {
    await rechargerListe();
    const carte = page.locator('#agentList .agent-card', { hasText: 'Enquêteur' });
    await carte.locator('.btn-agent-ask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    // Le combo Agent porte le nom de l'agent choisi.
    await page.waitForFunction(() => {
      const c = document.querySelector('#taskAgentBox [data-combo="taskAgentVal"]');
      return c && /Enqu/.test(c.value);
    });
    await page.locator('#taskPrompt').fill('TypeError at src/app.js:12');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });

    const { body } = await app.api('GET', '/api/tasks');
    const t = body.find((x) => /TypeError/.test(x.prompt));
    assert.ok(t, 'session introuvable');
    assert.ok(t.agent_id, 'la session doit porter son agent');
    assert.match(t.agent_name, /Enquêteur/);
    assert.equal(t.kind, 'explore');
    assert.equal(t.auto_push, 0, 'un agent ne pousse jamais de lui-même');
    // La demande a été COMPOSÉE : le gabarit de l'enquêteur l'entoure.
    assert.match(t.prompt, /extrais de la trace/);
    assert.match(t.prompt, /<<<REPO/);
  });

  test('le run tourne en dry-run et rend un rapport — sans son bloc de protocole à l’écran', async () => {
    const { body } = await app.api('GET', '/api/tasks');
    const t = body.find((x) => /TypeError/.test(x.prompt));
    await app.api('POST', `/api/tasks/${t.id}/run`);
    await waitForJobs(app.api);
    const apres = (await app.api('GET', `/api/tasks/${t.id}`)).body.task;
    assert.equal(apres.status, 'done', apres.last_error || '');
    const md = (await app.api('GET', `/api/tasks/${t.id}/md`)).body;
    assert.ok(!md.md.includes('<<<REPO'), 'le bloc de service ne doit pas s’afficher');
    assert.match(md.md, /Dépôt et fichier/);
    // …et il reste lisible tel quel pour qui le demande.
    const brut = (await app.api('GET', `/api/tasks/${t.id}/md?raw=1`)).body;
    assert.ok(brut.md.includes('<<<REPO'));
  });

  test('« Corriger sur <dépôt> » est proposé, et il désigne un dépôt CONNU', async () => {
    const { body } = await app.api('GET', '/api/tasks');
    const t = body.find((x) => /TypeError/.test(x.prompt));
    const hint = (await app.api('GET', `/api/tasks/${t.id}/repo-hint`)).body;
    assert.ok(hint, 'aucun indice de dépôt');
    assert.equal(hint.repo_id, repoId);
    assert.equal(hint.project, 'grp/app');
  });

  test('un agent « tous les dépôts actifs » ouvre la session AVEC tous les dépôts actifs', async () => {
    /* Le périmètre de l'agent n'est pas une note d'intention : c'est ce qui partira. La modale
       ne posait de lignes que pour un périmètre nommé dépôt par dépôt, donc un cartographe
       « tous les dépôts actifs » s'ouvrait sur une ligne vide — et il fallait re-choisir à la
       main ce qui était déjà choisi. Un dépôt désactivé, lui, reste dehors : c'est le mot
       « actifs » du périmètre. */
    const autre = makeRemoteRepo(path.join(app.dataDir, 'depot2'));
    await app.api('POST', '/api/repos', { url: autre.url, project: 'grp/autre' });
    const eteint = await app.api('POST', '/api/repos', { url: 'https://gitlab.com/grp/eteint.git', project: 'grp/eteint' });
    await app.api('PUT', `/api/repos/${eteint.body.id}`, { enabled: 0 });

    await rechargerListe();
    await page.locator('#agentList .agent-card', { hasText: 'Enquêteur' }).locator('.btn-agent-ask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#targetRows .target-row').length === 2);
    const projets = await page.$$eval('#targetRows .target-row .t-repo-search', (els) => els.map((e) => e.value));
    assert.deepEqual(projets, ['grp/app', 'grp/autre']);

    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  });

  test('la carte de session porte la pastille de son agent', async () => {
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="explore"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#taskList .task-row').length > 0);
    const pastilles = await page.$$eval('#taskList .tag-agent', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(pastilles.some((x) => /Enquêteur/.test(x)), pastilles.join(' | '));
  });

  test('la liste des sessions se filtre par agent', async () => {
    const avant = await page.locator('#taskList .task-row').count();
    const { body } = await app.api('GET', '/api/agents');
    const enq = body.find((a) => a.builtin_key === 'investigator');
    const { body: runs } = await app.api('GET', `/api/tasks?agent_id=${enq.id}`);
    assert.ok(runs.length >= 1);
    assert.ok(runs.every((r) => r.agent_id === enq.id));
    assert.ok(avant >= runs.length);
  });

  test('dupliquer, restaurer, supprimer — et la session garde le nom de l’agent supprimé', async () => {
    await rechargerListe();
    const carte = page.locator('#agentList .agent-card', { hasText: 'Relecteur maison' });
    await carte.locator('.btn-agent-dup').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#agentList .agent-card strong')]
      .some((e) => /Relecteur maison \(copie\)/.test(e.textContent)));

    // Restaurer : sur un agent LIVRÉ seulement, et il reprend son texte d'origine.
    const enq = page.locator('#agentList .agent-card', { hasText: 'Enquêteur' });
    assert.equal(await enq.locator('.btn-agent-restore').count(), 1);
    assert.equal(await page.locator('#agentList .agent-card', { hasText: 'Relecteur maison (copie)' })
      .locator('.btn-agent-restore').count(), 0, 'une copie n’a pas de texte livré à restaurer');

    // Supprimer : la confirmation passe par la modale maison, jamais confirm().
    const copie = page.locator('#agentList .agent-card', { hasText: 'Relecteur maison (copie)' });
    await copie.locator('.btn-agent-del').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('#agentList .agent-card strong')]
      .some((e) => /\(copie\)/.test(e.textContent)));

    // L'enquêteur supprimé laisserait ses sessions : on le prouve sur un agent jetable.
    const cree = (await app.api('POST', '/api/agents', { name: 'Jetable', kind: 'explore' })).body;
    const tache = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'question jetable', targets: [{ repo_id: repoId }], agent_id: cree.id,
    })).body;
    await app.api('DELETE', `/api/agents/${cree.id}`);
    const apres = (await app.api('GET', `/api/tasks/${tache.id}`)).body.task;
    assert.equal(apres.agent_id, null);
    assert.equal(apres.agent_name, 'Jetable');
  });

  test('le plafond de runs automatiques se règle et se relit', async () => {
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="aisession"]').click();
    await page.waitForSelector('#cfgAgentAutoMax');
    await page.locator('#cfgAgentAutoMax').fill('4');
    await page.locator('#sub-aisession button[type="submit"][form="configForm"]').first().click();
    // La preuve est côté SERVEUR : l'écran dit « enregistré » avant que ce le soit.
    const attendu = async () => ((await app.api('GET', '/api/config')).body.agent_auto_max === 4);
    const fin = Date.now() + 15000;
    // eslint-disable-next-line no-await-in-loop
    while (!(await attendu())) {
      if (Date.now() > fin) throw new Error('agent_auto_max jamais enregistré');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test('un mode de permission « default » est refusé, avec une phrase', async () => {
    const r = await app.api('POST', '/api/agents', { name: 'Impossible', permission_mode: 'default' });
    assert.equal(r.status, 400);
    assert.ok(r.body.errors.includes('agents.err.permission-default'));
    assert.ok(!/^agents\./.test(r.body.error), `clé brute renvoyée : ${r.body.error}`);
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
