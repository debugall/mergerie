'use strict';
/* MENU AGENTS — L'ÉDITEUR D'AGENT, CHAMP PAR CHAMP, À L'ÉCRAN.
 *
 * `e2e-agents.test.js` crée un agent avec son nom, sa description, son rôle et son gabarit.
 * Le formulaire porte bien plus : le type, le périmètre dépôt par dépôt (avec un rôle par
 * dépôt), le mode de permission, les outils permis et interdits, la borne de tours, les skills
 * emportés, les sous-agents en JSON, la sortie (et sa page racine), l'horaire. Chacun de ces
 * champs forme avec `lireAgentForm` et la route une chaîne qui peut casser seule : on les
 * remplit TOUS dans l'écran, et on relit par l'API ce que le serveur a vraiment gardé.
 *
 * Un seul `startApp()` : les tests partagent l'app et le navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// AVANT `startApp` : le scan des skills lit ce home au chargement.
const fauxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-agents-ed-home-'));
process.env.MERGERIE_CLAUDE_HOME = fauxHome;
/* Le backend décide de l'aperçu : `claude` reçoit tout le profil. Sans ce réglage, le test
   dépendrait du `.env` de la machine. Le binaire n'est jamais lancé (dry-run). */
process.env.COPILOT_BIN = 'claude';

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ecrire = (p, texte) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, texte, 'utf8'); };

describe('Menu Agents : l’éditeur d’agent', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let idApp; let idAutre; let pageId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    idApp = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' })).body.id;
    idAutre = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/autre', project: 'grp/autre' })).body.id;
    // Deux skills du home, et un sous-agent de fichier nommé comme celui que pose le bouton.
    ecrire(path.join(fauxHome, '.claude/skills/audit-secu/SKILL.md'),
      '---\nname: audit-secu\ndescription: Cherche les failles évidentes.\n---\n');
    ecrire(path.join(fauxHome, '.claude/skills/doc-api/SKILL.md'),
      '---\nname: doc-api\ndescription: Documente une route.\n---\n');
    ecrire(path.join(fauxHome, '.claude/agents/chercheur.md'),
      '---\nname: chercheur\ndescription: Cherche dans un dépôt.\n---\n');
    await app.api('POST', '/api/skills/rescan');
    pageId = (await app.api('POST', '/api/notes', { title: 'Carte des services' })).body.id;
    assert.ok(pageId, 'page de notes de départ');

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
    try { fs.rmSync(fauxHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const agentsApi = async () => (await app.api('GET', '/api/agents')).body;
  const agentNomme = async (nom) => (await agentsApi()).find((a) => a.name === nom);

  const allerListe = async () => {
    // Une modale restée ouverte intercepterait tous les clics : on repart d'un écran propre.
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="agents"]').click();
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#agentList .agent-card').length > 0);
  };
  const ouvrirNouveau = async () => {
    await allerListe();
    await page.locator('#btnNewAgent').click();
    await page.waitForSelector('#agentModal:not([hidden])');
    // Les skills arrivent d'un appel API : on attend la liste peuplée, pas son conteneur.
    await page.waitForFunction(() => document.querySelectorAll('#agentSkills [data-skill]').length >= 2);
    // Les sections repliées cachent leurs champs.
    await page.evaluate(() => document.querySelectorAll('#agentForm details').forEach((d) => { d.open = true; }));
  };
  const attendreApercu = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#agentArgvPreview').textContent), re.source);

  test('le périmètre « dépôts choisis » montre la liste, et son filtre masque sans décocher', async () => {
    await ouvrirNouveau();
    assert.equal(await page.locator('#agentModalTitle').innerText(), 'Nouvel agent');
    // « Tous les dépôts actifs » par défaut : la liste des dépôts n'a rien à dire.
    assert.equal(await page.locator('#agentReposBox').isHidden(), true);
    await page.locator('#agentForm input[name="scope_kind"][value="repos"]').click();
    await page.waitForSelector('#agentReposBox', { state: 'visible' });
    assert.equal(await page.locator('#agentRepos .ag-repo').count(), 2);

    await page.locator(`#agentRepos .ag-repo[value="${idApp}"]`).click();
    await page.locator('#agentRepoFilter').fill('autre');
    await page.waitForFunction((id) => document.querySelector(`#agentRepos .ag-repo[value="${id}"]`).closest('label').hidden, idApp);
    assert.equal(await page.locator(`#agentRepos .ag-repo[value="${idApp}"]`).isChecked(), true,
      'filtrer masque la ligne, sans la décocher');
    await page.locator('#agentRepoFilter').fill('zzz-aucun');
    await page.waitForFunction(() => [...document.querySelectorAll('#agentRepos .agent-repo-row')].every((l) => l.hidden));
    await page.locator('#agentRepoFilter').fill('');
    await page.waitForFunction(() => [...document.querySelectorAll('#agentRepos .agent-repo-row')].every((l) => !l.hidden));

    // Revenir à « tous les dépôts » replie la liste.
    await page.locator('#agentForm input[name="scope_kind"][value="all_repos"]').click();
    await page.waitForSelector('#agentReposBox', { state: 'hidden' });
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
  });

  test('le filtre des skills masque sans décocher', async () => {
    await ouvrirNouveau();
    await page.locator('#agentSkills [data-skill$="|audit-secu"]').click();
    await page.locator('#agentSkillFilter').fill('doc-api');
    await page.waitForFunction(() => document.querySelector('#agentSkills [data-skill$="|audit-secu"]').closest('label').hidden);
    assert.equal(await page.locator('#agentSkills [data-skill$="|audit-secu"]').isChecked(), true);
    await page.locator('#agentSkillFilter').fill('zzz-aucun');
    await page.waitForSelector('#agentSkills [data-no-match]:not([hidden])');
    await page.locator('#agentSkillFilter').fill('');
    await page.waitForSelector('#agentSkills [data-no-match]', { state: 'hidden' });
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
  });

  test('l’horaire : chaque type montre ses champs, dit sa forme, et réclame une borne de tours', async () => {
    await ouvrirNouveau();
    assert.equal(await page.locator('#agentScheduleKind').inputValue(), '', 'à la main par défaut');
    assert.equal(await page.locator('#agentScheduleTime').isHidden(), true);

    await page.locator('#agentScheduleKind').selectOption('daily');
    await page.waitForSelector('#agentScheduleTime', { state: 'visible' });
    assert.equal(await page.locator('#agentScheduleDow').isHidden(), true);
    assert.equal(await page.locator('#agentScheduleDom').isHidden(), true);
    await page.waitForFunction(() => /daily 07:00/.test(document.querySelector('#agentScheduleSaid').textContent));
    // Sans borne de tours, la remarque le dit AVANT la sauvegarde.
    await page.waitForSelector('#agentScheduleNeeds:not([hidden])');
    // …et l'aperçu, calculé par le serveur, porte la même erreur en toutes lettres.
    await page.locator('#agentName').fill('Planifié sans borne');
    await page.waitForSelector('#agentFormErr:not([hidden])');
    assert.match(await page.locator('#agentFormErr').innerText(), /borne de tours/);

    await page.locator('#agentScheduleKind').selectOption('weekly');
    await page.waitForSelector('#agentScheduleDow', { state: 'visible' });
    await page.locator('#agentScheduleDow').selectOption('fri');
    await page.waitForFunction(() => /weekly fri 07:00/.test(document.querySelector('#agentScheduleSaid').textContent));

    await page.locator('#agentScheduleKind').selectOption('monthly');
    await page.waitForSelector('#agentScheduleDom', { state: 'visible' });
    assert.equal(await page.locator('#agentScheduleDow').isHidden(), true);
    await page.locator('#agentScheduleDom').selectOption('15');
    await page.waitForFunction(() => /monthly 15 07:00/.test(document.querySelector('#agentScheduleSaid').textContent));

    await page.locator('#agentMaxTurns').fill('12');
    await page.waitForSelector('#agentScheduleNeeds', { state: 'hidden' });
    await page.waitForSelector('#agentFormErr', { state: 'hidden' });

    await page.locator('#agentScheduleKind').selectOption('');
    await page.waitForSelector('#agentScheduleTime', { state: 'hidden' });
    assert.equal(await page.locator('#agentScheduleSaid').innerText(), '');
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    assert.equal(await agentNomme('Planifié sans borne'), undefined, 'Annuler n’enregistre rien');
  });

  test('un JSON de sous-agents invalide est signalé à la frappe, et la sauvegarde n’envoie rien', async () => {
    await ouvrirNouveau();
    await page.locator('#agentName').fill('Agent au JSON cassé');
    await page.locator('#agentSubagents').fill('{ "x": ');
    await page.waitForSelector('#agentSubagentsErr:not([hidden])');
    assert.match(await page.locator('#agentSubagentsErr').innerText(), /JSON/);
    await page.locator('#agentSave').click();
    await page.waitForSelector('.toast.err');
    assert.equal(await page.locator('#agentModal').isVisible(), true, 'la modale reste ouverte');
    assert.equal(await agentNomme('Agent au JSON cassé'), undefined);

    await page.locator('#agentSubagents').fill('');
    await page.waitForSelector('#agentSubagentsErr', { state: 'hidden' });
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  });

  test('« Ajouter un sous-agent » pose un exemple valide, numéroté, et signale l’homonyme d’un fichier', async () => {
    await ouvrirNouveau();
    await page.locator('#agentSubagentAdd').click();
    await page.waitForFunction(() => /"chercheur"/.test(document.querySelector('#agentSubagents').value));
    const premier = JSON.parse(await page.locator('#agentSubagents').inputValue());
    assert.deepEqual(Object.keys(premier), ['chercheur']);
    assert.deepEqual(premier.chercheur.tools, ['Read', 'Grep']);
    assert.equal(await page.locator('#agentSubagentsErr').isHidden(), true, 'l’exemple posé est du JSON valide');
    // `.claude/agents/chercheur.md` existe dans le home : la définition du profil le masquera.
    await page.waitForSelector('#agentSubagentShadow:not([hidden])');
    assert.match(await page.locator('#agentSubagentShadow').innerText(), /chercheur/);

    // Un second clic AJOUTE, sans écraser le premier.
    await page.locator('#agentSubagentAdd').click();
    await page.waitForFunction(() => /"chercheur-2"/.test(document.querySelector('#agentSubagents').value));
    const deux = JSON.parse(await page.locator('#agentSubagents').inputValue());
    assert.deepEqual(Object.keys(deux).sort(), ['chercheur', 'chercheur-2']);
    await attendreApercu(/--agents/);

    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
  });

  test('tous les champs remplis à l’écran sont enregistrés tels quels', async () => {
    await ouvrirNouveau();
    await page.locator('#agentName').fill('Profil complet');
    await page.locator('#agentDesc').fill('Tout est réglé.');
    await page.locator('#agentKind').selectOption('code');
    await page.locator('#agentForm input[name="scope_kind"][value="repos"]').click();
    await page.waitForSelector('#agentReposBox', { state: 'visible' });
    await page.locator(`#agentRepos .ag-repo[value="${idAutre}"]`).click();
    await page.locator(`#agentRepos .ag-repo[value="${idAutre}"]`).locator('xpath=..').locator('.ag-role').selectOption('target');
    await page.locator('#agentSystemPrompt').fill('Tu es rigoureux.');
    await page.locator('#agentTemplate').fill('Fais : {question}');
    await page.locator('#agentModel').fill('sonnet');
    await page.locator('#agentPermission input[value="plan"]').click();
    await page.locator('#agentAllowed').fill('Read, Grep');
    await page.locator('#agentDisallowed').fill('Bash(rm *)');
    await page.locator('#agentMaxTurns').fill('30');
    await page.locator('#agentSkills [data-skill$="|audit-secu"]').click();
    await page.locator('#agentSubagents').fill('{ "fouineur": { "description": "Fouille", "prompt": "Cherche", "tools": ["Read"] } }');
    await page.locator('#agentOutputKind').selectOption('note_page');
    await page.waitForSelector('#agentOutputRefRow', { state: 'visible' });
    // La page racine : un combo avec recherche, comme partout où l'on choisit dans une liste.
    await page.locator('#agentOutputRefBox [data-combo="agentOutputRefVal"]').click();
    await page.locator('.combo-options:not([hidden]) .combo-opt[data-l="Carte des services"]').click();
    await page.waitForFunction((id) => document.querySelector('#agentOutputRefBox .agentOutputRefVal').value === String(id), pageId);
    await page.locator('#agentScheduleKind').selectOption('monthly');
    await page.locator('#agentScheduleDom').selectOption('15');
    await page.locator('#agentScheduleTime').fill('08:30');

    // L'aperçu reflète ce qui vient d'être réglé — il vient du serveur.
    await attendreApercu(/--permission-mode plan/);
    const argv = await page.locator('#agentArgvPreview').innerText();
    for (const attendu of [/--model sonnet/, /--allowedTools\S*\s+\S*Read,Grep/, /--disallowedTools/, /--max-turns 30/, /--agents/, /--append-system-prompt/]) {
      assert.match(argv, attendu, argv);
    }

    await page.locator('#agentSave').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    await attendreServeur(async () => Boolean(await agentNomme('Profil complet')), 'l’agent est enregistré');
    const a = await agentNomme('Profil complet');
    assert.equal(a.description, 'Tout est réglé.');
    assert.equal(a.kind, 'code');
    assert.equal(a.scope_kind, 'repos');
    assert.deepEqual(a.repos.map((r) => [r.repo_id, r.role]), [[idAutre, 'target']]);
    assert.equal(a.system_prompt, 'Tu es rigoureux.');
    assert.equal(a.prompt_template, 'Fais : {question}');
    assert.equal(a.model, 'sonnet');
    assert.equal(a.permission_mode, 'plan');
    assert.deepEqual(JSON.parse(a.allowed_tools_json), ['Read', 'Grep']);
    assert.deepEqual(JSON.parse(a.disallowed_tools_json), ['Bash(rm *)']);
    assert.equal(a.max_turns, 30);
    assert.deepEqual(JSON.parse(a.skills_json).map((s) => [s.name, s.source]), [['audit-secu', 'user']]);
    assert.deepEqual(Object.keys(JSON.parse(a.subagents_json)), ['fouineur']);
    assert.equal(a.output_kind, 'note_page');
    assert.equal(String(a.output_ref), String(pageId));
    assert.equal(a.schedule, 'monthly 15 08:30');

    // La carte le dit : horaire, périmètre, et « Coder » puisqu'il code.
    const carte = page.locator('#agentList .agent-card', { hasText: 'Profil complet' });
    await carte.waitFor();
    const texte = await carte.innerText();
    assert.match(texte, /1 dépôt/);
    assert.equal(await carte.locator('.btn-agent-code').count(), 1);
    assert.equal(await carte.locator('.agent-head .badge').count() >= 1, true, 'l’horaire est affiché en pastille');
  });

  test('« Modifier » relit chaque champ enregistré, et la modification est gardée', async () => {
    await allerListe();
    await page.locator('#agentList .agent-card', { hasText: 'Profil complet' }).locator('.btn-agent-edit').click();
    await page.waitForSelector('#agentModal:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#agentSkills [data-skill]').length >= 2);
    await page.evaluate(() => document.querySelectorAll('#agentForm details').forEach((d) => { d.open = true; }));
    assert.equal(await page.locator('#agentModalTitle').innerText(), 'Profil complet');
    assert.equal(await page.locator('#agentName').inputValue(), 'Profil complet');
    assert.equal(await page.locator('#agentDesc').inputValue(), 'Tout est réglé.');
    assert.equal(await page.locator('#agentKind').inputValue(), 'code');
    assert.equal(await page.locator('#agentForm input[name="scope_kind"][value="repos"]').isChecked(), true);
    assert.equal(await page.locator(`#agentRepos .ag-repo[value="${idAutre}"]`).isChecked(), true);
    assert.equal(await page.locator(`#agentRepos .ag-repo[value="${idApp}"]`).isChecked(), false);
    assert.equal(await page.locator(`#agentRepos .ag-repo[value="${idAutre}"]`).locator('xpath=..').locator('.ag-role').inputValue(), 'target');
    assert.equal(await page.locator('#agentSystemPrompt').inputValue(), 'Tu es rigoureux.');
    assert.equal(await page.locator('#agentTemplate').inputValue(), 'Fais : {question}');
    assert.equal(await page.locator('#agentModel').inputValue(), 'sonnet');
    assert.equal(await page.locator('#agentPermission input[value="plan"]').isChecked(), true);
    assert.equal(await page.locator('#agentAllowed').inputValue(), 'Read, Grep');
    assert.equal(await page.locator('#agentDisallowed').inputValue(), 'Bash(rm *)');
    assert.equal(await page.locator('#agentMaxTurns').inputValue(), '30');
    assert.equal(await page.locator('#agentSkills [data-skill$="|audit-secu"]').isChecked(), true);
    assert.equal(await page.locator('#agentSkills [data-skill$="|doc-api"]').isChecked(), false);
    assert.deepEqual(Object.keys(JSON.parse(await page.locator('#agentSubagents').inputValue())), ['fouineur']);
    assert.equal(await page.locator('#agentOutputKind').inputValue(), 'note_page');
    assert.equal(await page.locator('#agentOutputRefBox .agentOutputRefVal').inputValue(), String(pageId));
    assert.equal(await page.locator('#agentScheduleKind').inputValue(), 'monthly');
    assert.equal(await page.locator('#agentScheduleDom').inputValue(), '15');
    assert.equal(await page.locator('#agentScheduleTime').inputValue(), '08:30');

    // Changer, enregistrer : c'est un PUT sur le même agent, pas un second agent.
    const avant = (await agentsApi()).length;
    await page.locator('#agentDesc').fill('Réglé, puis revu.');
    await page.locator('#agentPermission input[value="dontAsk"]').click();
    await page.locator('#agentSave').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    await attendreServeur(async () => (await agentNomme('Profil complet')).description === 'Réglé, puis revu.', 'la modification est enregistrée');
    const a = await agentNomme('Profil complet');
    assert.equal(a.permission_mode, 'dontAsk');
    assert.equal((await agentsApi()).length, avant, 'modifier ne crée pas d’agent');
    /* Le créneau du 15 est déjà passé ce mois-ci : laissé en place, le tic d'une minute du
       serveur pourrait le lancer au milieu des tests suivants. */
    await app.api('PUT', `/api/agents/${a.id}`, { schedule: '' });
  });

  test('un nom déjà pris est refusé par le serveur : message d’erreur, modale ouverte, rien de créé', async () => {
    await ouvrirNouveau();
    const avant = (await agentsApi()).length;
    await page.locator('#agentName').fill('Profil complet');
    await page.locator('#agentSave').click();
    await page.waitForSelector('.toast.err');
    assert.match(await page.locator('.toast.err').last().innerText(), /déjà ce nom/);
    assert.equal(await page.locator('#agentModal').isVisible(), true);
    assert.equal((await agentsApi()).length, avant);
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  });

  test('« Essai » ouvre une session portée par le profil, sans créer d’agent', async () => {
    await ouvrirNouveau();
    const avant = (await agentsApi()).length;
    await page.locator('#agentName').fill('Profil à l’essai');
    await page.locator('#agentTemplate').fill('Essaie : {question}');
    await page.locator('#agentModel').fill('haiku');
    await page.locator('#agentTry').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForSelector('#taskAgentEssai:not([hidden])');
    assert.match(await page.locator('#taskAgentEssai').innerText(), /Profil à l’essai/);
    // Le gabarit, sans son `{question}`, remplit la demande.
    assert.equal(await page.locator('#taskPrompt').inputValue(), 'Essaie :');

    // Un dépôt à la ligne de cible, s'il n'y en a pas déjà un.
    if (!(await page.locator('#targetRows .t-repo').first().inputValue())) {
      await page.locator('#targetRows .t-repo-search').first().click();
      await page.locator('.combo-options:not([hidden]) .combo-opt', { hasText: 'grp/app' }).first().click();
      await page.waitForFunction(() => document.querySelector('#targetRows .t-repo').value !== '');
    }
    await page.locator('#taskPrompt').fill('Essaie : où sont les routes ?');
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal', { state: 'hidden' });

    await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.some((t) => /où sont les routes/.test(t.prompt)),
      'la session d’essai existe');
    const t = (await app.api('GET', '/api/tasks')).body.find((x) => /où sont les routes/.test(x.prompt));
    assert.equal(t.agent_name, 'Profil à l’essai', 'la session dit quel profil elle essaie');
    assert.equal(t.agent_id, null, 'aucun agent enregistré derrière');
    assert.equal((await agentsApi()).length, avant, 'essayer ne laisse aucun agent');
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
