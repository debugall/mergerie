'use strict';
/* MENU AGENTS — LA LISTE, LES CARTES, LE SOUS-ONGLET « SKILLS & SOUS-AGENTS », À L'ÉCRAN.
 *
 * Ce que les autres fichiers ne font pas passer par le navigateur : le filtre par dépôt, le
 * message « aucun agent ne correspond », Restaurer et ses deux issues, Supprimer annulé,
 * « Sessions » (la liste filtrée par agent), la pastille du dernier run qui mène à sa session,
 * le prochain créneau d'un agent planifié, l'approbation d'un état devenu périmé entre
 * l'affichage et le clic, les versions de la connaissance, la fenêtre « Nouvel agent de
 * domaine » (filtre, annulation, sujet vide), l'état vide — et tout le sous-onglet Skills :
 * sources, badges, dépôts non clonés, filtre, relecture du disque, sous-onglet retenu.
 *
 * Un seul `startApp()` : les tests partagent l'app et le navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// AVANT `startApp` : le scan des skills lit ce home au chargement.
const fauxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-agents-li-home-'));
process.env.MERGERIE_CLAUDE_HOME = fauxHome;
process.env.COPILOT_BIN = 'claude';

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, makeRemoteRepo, waitForJobs, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ecrire = (p, texte) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, texte, 'utf8'); };

describe('Menu Agents : la liste, les cartes et les skills', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let idReel; let idDocs; let idVeilleur; let idCoureur;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    const depot = makeRemoteRepo(path.join(app.dataDir, 'reel'));
    idReel = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/reel' })).body.id;
    idDocs = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/docs', project: 'grp/docs' })).body.id;
    // Un dépôt jamais cloné : ses skills manquent, et l'écran doit le dire.
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/lointain', project: 'grp/lointain' });

    /* Un skill « de dépôt » suppose un clone : on le fabrique là où `cloneDirFor` ira le
       chercher, plutôt que de faire tourner une vraie session pour l'obtenir. */
    const cfg = (await app.api('GET', '/api/config')).body;
    const clone = path.join(cfg.clone_path, 'grp__docs');
    ecrire(path.join(clone, '.claude/skills/revue-docs/SKILL.md'),
      '---\nname: revue-docs\ndescription: Relit la documentation.\nallowed-tools: Read, Grep\n---\n');
    ecrire(path.join(clone, '.claude/skills/interne/SKILL.md'),
      '---\nname: interne\ndescription: Réservé au modèle.\nuser-invocable: false\n---\n');
    ecrire(path.join(clone, '.claude/agents/relecteur.md'),
      '---\nname: relecteur\ndescription: Relit un fichier.\n---\n');
    ecrire(path.join(fauxHome, '.claude/skills/perso/SKILL.md'),
      '---\nname: perso\ndescription: Le mien.\n---\n');
    await app.api('POST', '/api/skills/rescan');

    // Un agent borné à grp/docs, un autre à grp/reel qui a déjà tourné, un planifié.
    await app.api('POST', '/api/agents', {
      name: 'Doc seulement', kind: 'explore', scope_kind: 'repos', repos: [{ repo_id: idDocs, role: 'readonly' }],
    });
    idCoureur = (await app.api('POST', '/api/agents', {
      name: 'Coureur', kind: 'explore', scope_kind: 'repos', repos: [{ repo_id: idReel, role: 'readonly' }],
    })).body.id;
    const run = await app.api('POST', `/api/agents/${idCoureur}/run`, { mode: 'ask', question: 'où est le point d’entrée ?' });
    assert.equal(run.status, 200, run.text);
    await attendreServeur(async () => (await app.api('GET', `/api/tasks?agent_id=${idCoureur}`)).body.length === 1, 'le run existe');
    await waitForJobs(app.api, { timeout: 120000 });
    /* Planifié, mais pour un AUTRE poste : le tic d'une minute du serveur ne le lancera pas
       pendant les tests, et le prochain créneau s'affiche quand même. */
    idVeilleur = (await app.api('POST', '/api/agents', {
      name: 'Veilleur du lundi', kind: 'explore', max_turns: 5, schedule: 'weekly mon 07:00', runner: 'poste-collegue',
    })).body.id;
    assert.ok(idVeilleur);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    try { fs.rmSync(fauxHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const agentsApi = async () => (await app.api('GET', '/api/agents')).body;
  const carte = (nom) => page.locator('#agentList .agent-card', { hasText: nom }).first();
  const visibles = () => page.$$eval('#agentList .agent-card', (els) => els.filter((e) => !e.hidden).map((e) => e.querySelector('strong').textContent));
  const viderToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

  const allerListe = async () => {
    // Une modale restée ouverte intercepterait tous les clics : on repart d'un écran propre.
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#agentList .agent-card').length > 0);
  };
  const allerSkills = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.locator('#tab-agents .subnav [data-sub="skills"]').click();
    await page.waitForSelector('#sub-agents-skills.active');
    await page.waitForFunction(() => document.querySelectorAll('#skillList .skill-row').length > 0);
  };

  /* ---------- Sous-onglet « Skills & sous-agents » ---------- */

  test('les skills du disque sont listés par source, avec leur type, leurs badges et leurs outils', async () => {
    await allerSkills();
    const groupes = await page.$$eval('#skillList .skill-group h3', (els) => els.map((e) => e.textContent));
    assert.deepEqual(groupes, ['Dépôts', 'Ton home']);
    const ligne = (nom) => page.locator('#skillList .skill-row', { has: page.locator(`strong:text-is("${nom}")`) });
    assert.match(await ligne('revue-docs').innerText(), /skill/);
    assert.match(await ligne('revue-docs').innerText(), /Read, Grep/, 'les outils du skill sont lus');
    assert.match(await ligne('revue-docs').innerText(), /Relit la documentation/);
    assert.match(await ligne('interne').innerText(), /pas invocable par \//, 'user-invocable: false se voit');
    assert.match(await ligne('relecteur').innerText(), /sous-agent/);
    assert.equal(await page.locator('#skillList .skill-group', { hasText: 'Ton home' }).locator('strong', { hasText: 'perso' }).count(), 1);
    // Le dépôt jamais cloné est nommé : son absence de la liste s'explique.
    assert.match(await page.locator('#skillList .field-note').innerText(), /grp\/lointain/);
  });

  test('le filtre des skills masque, et dit quand rien ne correspond', async () => {
    await allerSkills();
    await page.locator('#skillFilter').fill('grp/docs');
    await page.waitForFunction(() => {
      const v = [...document.querySelectorAll('#skillList .skill-row')].filter((r) => !r.hidden);
      return v.length === 3;
    });
    await page.locator('#skillFilter').fill('zzz-aucun');
    await page.waitForSelector('#skillList [data-no-match]:not([hidden])');
    await page.locator('#skillFilter').fill('');
    await page.waitForSelector('#skillList [data-no-match]', { state: 'hidden' });
  });

  test('« Relire le disque » fait apparaître un skill écrit après coup', async () => {
    await allerSkills();
    assert.equal(await page.locator('#skillList strong', { hasText: 'tout-neuf' }).count(), 0);
    ecrire(path.join(fauxHome, '.claude/skills/tout-neuf/SKILL.md'), '---\nname: tout-neuf\ndescription: Arrivé après.\n---\n');
    await page.locator('#btnSkillRescan').click();
    await page.waitForSelector('#skillList strong:text-is("tout-neuf")');
    await page.waitForSelector('.toast', { state: 'attached' });
    assert.match(await page.locator('.toast').last().innerText(), /Disque relu/);
    await viderToasts();
  });

  test('le sous-onglet choisi est retenu d’un chargement à l’autre', async () => {
    await allerSkills();
    await page.reload();
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.waitForSelector('#sub-agents-skills.active');
    assert.equal(await page.locator('#tab-agents .subnav [data-sub="skills"]').evaluate((b) => b.classList.contains('active')), true);
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
    await page.waitForSelector('#sub-agents-list.active');
  });

  /* ---------- La liste ---------- */

  test('le filtre par dépôt masque les agents bornés ailleurs et garde les « tous dépôts »', async () => {
    await allerListe();
    const tous = await visibles();
    assert.ok(tous.includes('Doc seulement') && tous.includes('Coureur'), tous.join(', '));
    await page.locator('#agentRepoFilterBox [data-combo="agentRepoFilterVal"]').click();
    await page.locator('.combo-options:not([hidden]) .combo-opt[data-l="grp/reel"]').click();
    await page.waitForFunction(() => ![...document.querySelectorAll('#agentList .agent-card')]
      .some((c) => !c.hidden && /Doc seulement/.test(c.textContent)));
    const filtres = await visibles();
    assert.ok(filtres.includes('Coureur'), 'l’agent borné à grp/reel reste');
    assert.ok(filtres.some((n) => /Enquêteur/.test(n)), 'un agent « tous les dépôts » reste');

    // Texte ET dépôt se cumulent : « coureur » sur grp/reel ne laisse que lui.
    await page.locator('#agentFilter').fill('coureur');
    await page.waitForFunction(() => [...document.querySelectorAll('#agentList .agent-card')].filter((c) => !c.hidden).length === 1);

    await page.locator('#agentRepoFilterBox [data-combo="agentRepoFilterVal"]').click();
    await page.locator('.combo-options:not([hidden]) .combo-opt[data-v=""]').click();
    await page.locator('#agentFilter').fill('');
    await page.waitForFunction((n) => [...document.querySelectorAll('#agentList .agent-card')].filter((c) => !c.hidden).length === n, tous.length);
  });

  test('un filtre qui n’attrape rien le dit', async () => {
    await allerListe();
    await page.locator('#agentFilter').fill('zzz-aucun-agent');
    await page.waitForSelector('#agentList [data-no-match]:not([hidden])');
    assert.match(await page.locator('#agentList [data-no-match]').innerText(), /Aucun agent ne correspond/);
    await page.locator('#agentFilter').fill('');
    await page.waitForSelector('#agentList [data-no-match]', { state: 'hidden' });
  });

  test('la carte dit le périmètre, « jamais lancé », et le prochain créneau d’un agent planifié', async () => {
    await allerListe();
    assert.match(await carte('Doc seulement').innerText(), /1 dépôt/);
    assert.match(await carte('Doc seulement').innerText(), /jamais lancé/);
    const veilleur = carte('Veilleur du lundi');
    assert.equal(await veilleur.locator('.tag[data-when]').count(), 1, 'le prochain créneau est affiché');
    assert.match(await veilleur.locator('.tag[data-when]').innerText(), /repasse/);
    const quand = await veilleur.locator('.tag[data-when]').getAttribute('data-when');
    assert.equal(new Date(quand).getDay(), 1, 'le prochain créneau tombe un lundi');
    assert.ok(new Date(quand) > new Date(), 'il est dans le futur');
  });

  test('la pastille du dernier run mène à sa session', async () => {
    await allerListe();
    const t = (await app.api('GET', `/api/tasks?agent_id=${idCoureur}`)).body[0];
    const pastille = carte('Coureur').locator('[data-go-session]');
    assert.equal(await pastille.getAttribute('data-go-session'), String(t.id));
    assert.match(await carte('Coureur').innerText(), /1 run/);
    await pastille.click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction((id) => location.hash === `#/sessions/explore/${id}`, t.id);
    await page.waitForSelector(`#taskList .task-row[data-task="${t.id}"]`);
  });

  test('« Sessions » ouvre la liste des sessions filtrée sur l’agent, et le filtre se lit', async () => {
    // Une seconde session d'un AUTRE agent, qui doit disparaître du filtre.
    const autre = (await agentsApi()).find((a) => a.name === 'Doc seulement');
    await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'question hors filtre', targets: [{ repo_id: idDocs }], agent_id: autre.id });
    /* On part de la saveur « Exploration » : changer de sous-onglet remet le filtre par agent à
       zéro (voulu), il faut donc y être AVANT le clic. */
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="explore"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#taskList .task-row')].some((r) => /hors filtre/.test(r.textContent)));
    await allerListe();
    await carte('Coureur').locator('.btn-agent-runs').click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction(() => {
      const c = document.querySelector('#taskAgentFilterBox [data-combo="taskAgentFilterVal"]');
      return c && c.value === 'Coureur';
    });
    // L'effet : la session de l'autre agent a quitté la liste.
    await page.waitForFunction(() => document.querySelectorAll('#taskList .task-row').length > 0
      && ![...document.querySelectorAll('#taskList .task-row')].some((r) => /hors filtre/.test(r.textContent)));
    const lignes = await page.$$eval('#taskList .task-row', (els) => els.map((e) => e.textContent));
    assert.ok(lignes.length >= 1);
    assert.ok(lignes.every((l) => /Coureur/.test(l)), lignes.join(' | '));
    assert.ok(!lignes.some((l) => /hors filtre/.test(l)), 'la session d’un autre agent est masquée');

    // Le filtre s'enlève par le même combo.
    await page.locator('#taskAgentFilterBox [data-combo="taskAgentFilterVal"]').click();
    await page.locator('.combo-options:not([hidden]) .combo-opt[data-v=""]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#taskList .task-row')].some((r) => /hors filtre/.test(r.textContent)));
  });

  test('« Sessions » d’un agent d’exploration, cliqué depuis la saveur Codage, montre ses runs', async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.waitForSelector('#tab-task .subnav [data-kind="code"].active');
    await allerListe();
    await carte('Coureur').locator('.btn-agent-runs').click();
    await page.waitForSelector('#tab-task.active');
    await page.waitForFunction(() => {
      const c = document.querySelector('#taskAgentFilterBox [data-combo="taskAgentFilterVal"]');
      return c && c.value === 'Coureur';
    });
    const saveur = await page.$eval('#tab-task .subnav [data-kind].active', (b) => b.dataset.kind);
    assert.equal(saveur, 'explore', 'les runs d’un explorateur vivent dans « Exploration »');
    await page.waitForFunction(() => [...document.querySelectorAll('#taskList .task-row')].some((r) => /Coureur/.test(r.textContent)),
      null, { timeout: 5000 });
  });

  test('« Coder » d’un agent qui code ouvre la session de codage pré-remplie sur ses dépôts', async () => {
    await app.api('POST', '/api/agents', {
      name: 'Codeur borné', kind: 'code', scope_kind: 'repos', prompt_template: 'Corrige : {question}',
      repos: [{ repo_id: idReel, role: 'target' }],
    });
    await allerListe();
    assert.equal(await carte('Doc seulement').locator('.btn-agent-code').count(), 0, 'un explorateur ne code pas');
    await carte('Codeur borné').locator('.btn-agent-code').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((id) => [...document.querySelectorAll('#targetRows .t-repo')].map((e) => e.value).join() === String(id), idReel);
    assert.match(await page.locator('#taskPrompt').inputValue(), /Corrige/);
    await page.waitForFunction(() => /Codeur/.test((document.querySelector('#taskAgentBox [data-combo="taskAgentVal"]') || {}).value || ''));
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });
  });

  test('« Restaurer » : annulé il ne touche à rien, confirmé il rend le texte livré', async () => {
    const enq = (await agentsApi()).find((a) => a.builtin_key === 'investigator');
    const origine = enq.system_prompt;
    await app.api('PUT', `/api/agents/${enq.id}`, { system_prompt: 'Rôle réécrit à la main.' });
    await allerListe();

    await carte(enq.name).locator('.btn-agent-restore').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmModal').innerText(), /Restaurer/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.equal((await app.api('GET', `/api/agents/${enq.id}`)).body.system_prompt, 'Rôle réécrit à la main.');

    await carte(enq.name).locator('.btn-agent-restore').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => (await app.api('GET', `/api/agents/${enq.id}`)).body.system_prompt === origine,
      'le rôle livré est revenu');
    await viderToasts();
  });

  test('« Supprimer » annulé garde l’agent', async () => {
    await allerListe();
    await carte('Doc seulement').locator('.btn-agent-del').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmModal').innerText(), /Doc seulement/);
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.ok((await agentsApi()).some((a) => a.name === 'Doc seulement'));
    assert.equal(await carte('Doc seulement').count(), 1);
  });

  /* ---------- L'approbation ---------- */

  test('approuver un état devenu périmé : refus dit, la carte montre le nouvel état, le second clic passe', async () => {
    const a = (await app.api('POST', '/api/agents', { name: 'Arrivé par la synchro', kind: 'explore' })).body;
    app.db.prepare("UPDATE agent SET allowed_tools_json = '[\"Bash\"]' WHERE id = ?").run(a.id);
    await allerListe();
    const bouton = `#agentList .agent-card[data-id="${a.id}"] .btn-agent-approve`;
    await page.waitForSelector(bouton);
    assert.match(await page.locator(`#agentList .agent-card[data-id="${a.id}"] .approval-box`).innerText(), /Bash/);
    // La synchro change encore l'agent pendant qu'on lit l'écran.
    app.db.prepare("UPDATE agent SET permission_mode = 'dontAsk' WHERE id = ?").run(a.id);
    await page.locator(bouton).click();
    await page.waitForSelector('.toast.err');
    assert.match(await page.locator('.toast.err').last().innerText(), /a changé depuis que l’écran l’a affiché/);
    // L'écran recharge et montre ce qui est arrivé entre-temps — toujours à approuver.
    await page.waitForFunction((id) => /dontAsk/.test((document.querySelector(`#agentList .agent-card[data-id="${id}"] .approval-box`) || {}).textContent || ''), a.id);
    assert.equal((await app.api('GET', `/api/agents/${a.id}`)).body.approval_pending, true);
    await viderToasts();

    await page.locator(bouton).click();
    await page.waitForFunction((sel) => !document.querySelector(sel), bouton);
    assert.equal((await app.api('GET', `/api/agents/${a.id}`)).body.approval_pending, false);
  });

  /* LE REFUS D'UN AGENT EN ATTENTE. « Dupliquer » et « Coder » appellent une route qui répond
     409 tant que l'agent n'est pas approuvé ici. L'effet attendu : rien n'est créé, rien ne
     s'ouvre, et le refus s'affiche. Les rejets de promesse non rattrapés sont mis de côté
     (`rejets`) : le test plus bas vérifie qu’il n’y en a aucun. */
  const rejets = [];
  const mettreDeCote = (n) => { rejets.push(...erreurs.splice(n)); };

  test('dupliquer un agent en attente d’approbation est refusé, et l’écran le dit', async () => {
    const a = (await app.api('POST', '/api/agents', { name: 'En attente à copier', kind: 'explore' })).body;
    app.db.prepare("UPDATE agent SET model = 'opus' WHERE id = ?").run(a.id);
    await allerListe();
    await page.waitForSelector(`#agentList .agent-card[data-id="${a.id}"] .btn-agent-approve`);
    const avant = (await agentsApi()).length;
    const n = erreurs.length;
    await page.locator(`#agentList .agent-card[data-id="${a.id}"] .btn-agent-dup`).click();
    await page.waitForSelector('.toast.err');
    assert.match(await page.locator('.toast.err').last().innerText(), /En attente à copier.*attend une approbation/s);
    assert.equal((await agentsApi()).length, avant, 'aucune copie n’est créée');
    mettreDeCote(n);
    await viderToasts();
  });

  test('« Coder » un agent en attente d’approbation est refusé, et l’écran le dit', async () => {
    const a = (await app.api('POST', '/api/agents', { name: 'Codeur en attente', kind: 'code', scope_kind: 'repos', repos: [{ repo_id: idReel, role: 'target' }] })).body;
    app.db.prepare("UPDATE agent SET permission_mode = 'dontAsk' WHERE id = ?").run(a.id);
    await allerListe();
    await page.waitForSelector(`#agentList .agent-card[data-id="${a.id}"] .btn-agent-approve`);
    const n = erreurs.length;
    await page.locator(`#agentList .agent-card[data-id="${a.id}"] .btn-agent-code`).click();
    await page.waitForSelector('.toast.err');
    assert.match(await page.locator('.toast.err').last().innerText(), /Codeur en attente.*attend une approbation/s);
    assert.equal(await page.locator('#taskModal').isVisible(), false, 'aucune session ne s’ouvre');
    mettreDeCote(n);
    await viderToasts();
  });

  test('ces deux refus sont TRAITÉS par l’écran, pas rattrapés comme une « erreur inattendue »', () => {
    assert.deepEqual(rejets, []);
  });

  /* ---------- Agents de domaine : la fenêtre de création, les versions ---------- */

  test('« Nouvel agent de domaine » : le filtre masque sans décocher, un sujet vide ne part pas, Annuler ne lance rien', async () => {
    await viderToasts();
    await allerListe();
    const avant = (await app.api('GET', '/api/tasks')).body.length;
    await page.locator('#btnNewDomainAgent').click();
    await page.waitForSelector('#domainModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#domainRepos .dom-repo').length === 3);
    await page.locator(`#domainRepos .dom-repo[value="${idDocs}"]`).click();
    await page.locator('#domainRepoFilter').fill('reel');
    await page.waitForFunction((id) => document.querySelector(`#domainRepos .dom-repo[value="${id}"]`).closest('label').hidden, idDocs);
    assert.equal(await page.locator(`#domainRepos .dom-repo[value="${idDocs}"]`).isChecked(), true);
    await page.locator('#domainRepoFilter').fill('zzz');
    await page.waitForSelector('#domainRepos [data-no-match]:not([hidden])');
    await page.locator('#domainRepoFilter').fill('');

    // Sujet vide : le champ est requis, rien ne part et la fenêtre reste.
    await page.locator('#domainStart').click();
    assert.equal(await page.locator('#domainSubject').evaluate((el) => el.validity.valueMissing), true);
    assert.equal(await page.locator('#domainModal').isVisible(), true);

    await page.locator('#domainSubject').fill('un sujet qu’on abandonne');
    await page.locator('#domainCancel').click();
    await page.waitForSelector('#domainModal', { state: 'hidden' });
    assert.equal((await app.api('GET', '/api/tasks')).body.length, avant, 'annuler ne lance aucune cartographie');
    // Rouvrir repart d'un formulaire vierge.
    await page.locator('#btnNewDomainAgent').click();
    await page.waitForSelector('#domainModal:not([hidden])');
    assert.equal(await page.locator('#domainSubject').inputValue(), '');
    await page.locator('#domainCancel').click();
    await page.waitForSelector('#domainModal', { state: 'hidden' });
  });

  test('la connaissance : chaque version se relit en cliquant dessus', async () => {
    const r = await app.api('POST', '/api/agents/domain', { subject: 'les notifications : émission et routage', repo_ids: [idReel] });
    assert.equal(r.status, 200, r.text);
    await waitForJobs(app.api, { timeout: 120000 });
    await attendreServeur(async () => (await agentsApi()).some((a) => a.is_domain), 'l’agent de domaine existe');
    const dom = (await agentsApi()).find((a) => a.is_domain);
    await app.api('PUT', `/api/agents/${dom.id}/knowledge`, { content: '# Réécrite\nMarqueur de la deuxième version.\n' });

    await allerListe();
    await carte(dom.name).locator('.btn-agent-knowledge').click();
    await page.waitForSelector('#knowledgeModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#knowledgeVersions .knowledge-version').length === 2);
    // Ouverte sur la version EN SERVICE.
    await page.waitForFunction(() => /Marqueur de la deuxième version/.test(document.querySelector('#knowledgeBody').textContent));
    assert.match(await page.locator('#knowledgeVersions').innerText(), /remplacée/);
    assert.match(await page.locator('#knowledgeVersions').innerText(), /en service/);

    await page.locator('#knowledgeVersions .knowledge-version[data-id="1"]').click();
    await page.waitForFunction(() => document.querySelector('#knowledgeVersions .knowledge-version.active').dataset.id === '1');
    await page.waitForFunction(() => !/Marqueur de la deuxième version/.test(document.querySelector('#knowledgeBody').textContent)
      && document.querySelector('#knowledgeBody').textContent.trim().length > 0);
    // Une version remplacée ne se valide pas.
    assert.equal(await page.locator('#knowledgeValidate').isHidden(), true);
    await page.locator('#knowledgeClose').click();
    await page.waitForSelector('#knowledgeModal', { state: 'hidden' });
  });

  /* ---------- L'état vide (en dernier : il supprime tout) ---------- */

  test('sans aucun agent, l’état vide propose de créer un agent de domaine', async () => {
    for (const a of await agentsApi()) await app.api('DELETE', `/api/agents/${a.id}`);
    assert.equal((await agentsApi()).length, 0);
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="agents"]').click();
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
    await page.waitForSelector('#agentList .empty [data-empty-act="new-domain"]');
    await page.locator('#agentList [data-empty-act="new-domain"]').click();
    await page.waitForSelector('#domainModal:not([hidden])');
    await page.locator('#domainCancel').click();
    await page.waitForSelector('#domainModal', { state: 'hidden' });
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
