'use strict';
/* LES AUTRES BINAIRES, VUS DE L'ÉCRAN. Réglages → Session IA : on en ajoute un depuis le
 * formulaire, il apparaît dans la liste. Dev IA : la modale d'une exploration propose alors un
 * sélecteur « Binaire » (caché tant qu'il n'y a que le défaut), la session créée porte le choix,
 * sa carte l'affiche, et l'édition le relit. Hors dépôt : le même sélecteur, câblé à part.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Binaires d’agent — réglages, modale de session, carte', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let repoId; let profil; let localTask;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    // Un vrai dépôt distant : la session de codage « créer et lancer » doit pouvoir cloner et committer.
    const r = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'app-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: r.mainSha } }];
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: r.url, project: 'grp/app' })).body.id;
    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  const ouvrirModale = async (kind) => {
    await fermerModales();
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForLoadState('networkidle');
  };
  const fermer = async () => {
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  };
  const choisirDepot = async (projet) => {
    await page.waitForSelector('#targetRows .target-row .t-repo-search');
    for (let i = 1; i <= 5; i += 1) {
      await page.locator('#targetRows .target-row').first().locator('.t-repo-search').click();
      try {
        await page.locator('#targetRows .combo-options:not([hidden]) .combo-opt[data-r]', { hasText: projet }).first().click({ timeout: 3000 });
        await page.waitForFunction((p) => document.querySelector('#targetRows .target-row .t-repo-search').value === p, projet, { timeout: 3000 });
        return;
      } catch (e) { if (i === 5) throw e; await page.locator('#taskModalTitle').click(); }
    }
  };

  test('sans autre binaire, la modale ne montre pas de sélecteur', async () => {
    await ouvrirModale('explore');
    assert.equal(await page.locator('#taskCliRow').isVisible(), false);
    await fermer();
  });

  test('Réglages → Session IA : une liste, le défaut en tête ; le même formulaire édite le défaut et en ajoute d’autres', async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="aisession"]').click();
    await page.waitForSelector('#sub-aisession.active');
    await page.waitForSelector('#cliList [data-cli="default"]');
    assert.equal(await page.locator('#cliList [data-cli]').count(), 1, 'le défaut seul, en tête');
    assert.equal(await page.locator('#cliForm').isVisible(), false, 'le formulaire est replié tant qu’on ne fait rien');
    // Le DÉFAUT s'édite par le même formulaire : il part dans la config de poste.
    await page.locator('#cliList [data-cliedit="default"]').click();
    await page.waitForSelector('#cliForm:not([hidden])');
    assert.equal(await page.locator('#cliDefaultNote').isVisible(), true, 'la note « changer de binaire » ne vaut que pour le défaut');
    await page.locator('#cliName').fill('Claude Max');
    await page.locator('#cliBin').fill('/opt/agents/claude-principal');
    await page.locator('#cliArgs').fill('--model claude-sonnet-5');
    await page.locator('#cliEnv').fill('HTTPS_PROXY=http://proxy.defaut:3128');
    await page.locator('#cliForm button[type="submit"]').click();
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.agent_bin === '/opt/agents/claude-principal', 'le défaut est enregistré dans la config');
    const cfg = (await app.api('GET', '/api/config')).body;
    assert.equal(cfg.agent_name, 'Claude Max'); assert.equal(cfg.agent_args, '--model claude-sonnet-5');
    assert.equal(cfg.agent_env, 'HTTPS_PROXY=http://proxy.defaut:3128');
    await page.waitForFunction(() => /Claude Max/.test(document.querySelector('#cliList [data-cli="default"]').textContent));
    await page.waitForSelector('#cliForm[hidden]', { state: 'attached' });
    // Un AUTRE binaire : « Ajouter », le formulaire s'ouvre vide, la liste le montre ensuite.
    await page.locator('#cliAdd').click();
    await page.waitForSelector('#cliForm:not([hidden])');
    assert.equal(await page.locator('#cliName').inputValue(), '');
    assert.equal(await page.locator('#cliDefaultNote').isVisible(), false);
    await page.locator('#cliName').fill('Ollama qwen');
    await page.locator('#cliBin').fill('/opt/agents/claude-ollama');
    await page.locator('#cliArgs').fill('--model qwen3.6');
    await page.locator('#cliEnv').fill('ANTHROPIC_BASE_URL=http://localhost:11434\nANTHROPIC_AUTH_TOKEN=ollama');
    await page.locator('#cliForm .agentcli-avance > summary').click();
    await page.locator('#cliBackend').selectOption('claude');
    await page.locator('#cliForm button[type="submit"]').click();
    await attendreServeur(async () => (await app.api('GET', '/api/agent-clis')).body.items.length === 1, 'le binaire est enregistré');
    [profil] = (await app.api('GET', '/api/agent-clis')).body.items;
    assert.equal(profil.env, 'ANTHROPIC_BASE_URL=http://localhost:11434\nANTHROPIC_AUTH_TOKEN=ollama');
    assert.equal(profil.backend, 'claude');
    await page.waitForSelector(`#cliList [data-cli="${profil.id}"]`);
    assert.equal(await page.locator('#cliList [data-cli]').count(), 2);
    assert.match(await page.locator('#cliList [data-cli="default"]').textContent(), /par défaut|default/i);
    // Modifier : le formulaire se remplit, « Annuler » le replie.
    await page.locator(`#cliList [data-cliedit="${profil.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#cliBin').value === '/opt/agents/claude-ollama');
    assert.equal(await page.locator('#cliEnv').inputValue(), profil.env);
    await page.locator('#cliCancel').click();
    await page.waitForSelector('#cliForm[hidden]', { state: 'attached' });
    // Une saisie refusée par le serveur reste à l'écran, avec son message.
    await page.locator('#cliAdd').click();
    await page.locator('#cliName').fill('Faux');
    await page.locator('#cliBin').fill('x');
    await page.locator('#cliEnv').fill('MERGERIE_ACCESS_TOKEN=fuite');
    await page.locator('#cliForm button[type="submit"]').click();
    await page.waitForSelector('.toast');
    assert.equal((await app.api('GET', '/api/agent-clis')).body.items.length, 1, 'rien d’ajouté');
    assert.equal(await page.locator('#cliForm').isVisible(), true, 'la saisie reste là pour être corrigée');
    await page.locator('#cliCancel').click();
    // « Tester » le défaut et l'autre : chacun sur son profil (dry-run : le chemin le dit).
    await page.locator('#cliList [data-clitest="default"]').click();
    await page.waitForFunction(() => /claude-principal/.test((document.querySelector('#cliTestResult') || {}).textContent || ''));
    await page.locator(`#cliList [data-clitest="${profil.id}"]`).click();
    await page.waitForFunction(() => /claude-ollama/.test((document.querySelector('#cliTestResult') || {}).textContent || ''));
  });

  test('« Utiliser par défaut » échange la ligne et le défaut, à l’écran comme en base', async () => {
    const prof = (await app.api('POST', '/api/agent-clis', { name: 'Copilot', bin: '/opt/agents/copilot', backend: 'copilot' })).body;
    await page.locator('#tab-admin .subnav [data-sub="aisession"]').click();
    await page.waitForSelector(`#cliList [data-clidefault="${prof.id}"]`);
    await page.locator(`#cliList [data-clidefault="${prof.id}"]`).click();
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.agent_bin === '/opt/agents/copilot', 'le défaut a changé');
    await page.waitForFunction(() => /Copilot/.test(document.querySelector('#cliList [data-cli="default"]').textContent));
    const ancien = (await app.api('GET', '/api/agent-clis')).body.items.find((x) => x.id === prof.id);
    assert.equal(ancien.name, 'Claude Max'); assert.equal(ancien.bin, '/opt/agents/claude-principal');
    // On remet le défaut d'avant pour la suite, par le même geste.
    await page.locator(`#cliList [data-clidefault="${prof.id}"]`).click();
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.agent_bin === '/opt/agents/claude-principal', 'le défaut est revenu');
    await app.api('DELETE', `/api/agent-clis/${prof.id}`);
  });

  test('la modale d’exploration propose le binaire ; la session créée le porte, sa carte l’affiche, l’édition le relit', async () => {
    await ouvrirModale('explore');
    await page.waitForSelector('#taskCliRow:not([hidden])');
    const options = await page.$$eval('#taskCli option', (els) => els.map((o) => [o.value, o.textContent]));
    assert.equal(options.length, 2);
    assert.equal(options[0][0], ''); assert.match(options[0][1], /défaut|default/i);
    assert.equal(options[1][1], 'Ollama qwen');
    await choisirDepot('grp/app');
    await page.locator('#taskForm [name="prompt"]').fill('Où est le panier ?');
    await page.locator('#taskCli').selectOption(String(profil.id));
    const avant = app.db.prepare('SELECT COUNT(*) c FROM task').get().c;
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => app.db.prepare('SELECT COUNT(*) c FROM task').get().c === avant + 1, 'la session est créée');
    const t = app.db.prepare('SELECT * FROM task ORDER BY id DESC LIMIT 1').get();
    assert.equal(t.cli_id, profil.id); assert.equal(t.cli_name, 'Ollama qwen');
    // La carte : un badge avec le nom du binaire.
    await page.waitForSelector(`#taskList [data-task="${t.id}"] .task-cli`);
    assert.match(await page.locator(`#taskList [data-task="${t.id}"] .task-cli`).textContent(), /Ollama qwen/);
    // L'édition relit le choix ; le vider ramène au défaut.
    await page.locator(`#taskList [data-task="${t.id}"] [data-tedit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((id) => document.querySelector('#taskCli').value === String(id), profil.id);
    await page.locator('#taskCli').selectOption('');
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => app.db.prepare('SELECT cli_id FROM task WHERE id = ?').get(t.id).cli_id === null, 'retour au défaut enregistré');
    await page.waitForFunction((id) => !document.querySelector(`#taskList [data-task="${id}"] .task-cli`), t.id);
  });

  test('hors dépôt : le même sélecteur, câblé à part — la carte et l’édition le relisent', async () => {
    // Une racine déclarée, un dossier dessous : la modale hors dépôt résout ses dossiers par racine.
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    const dir = path.join(racine, 'projet-x'); fs.mkdirSync(dir);
    await app.api('POST', '/api/local-roots', { path: racine, label: 'racine' });
    // Créée par l'API, éditée à l'écran.
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Range', dirs: [dir], cli_id: profil.id })).body;
    localTask = lt;
    await fermerModales();
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="local"]').click();
    await page.waitForSelector(`#localList [data-local="${lt.id}"] .task-cli`);
    await page.locator(`#localList [data-local="${lt.id}"] [data-ledit]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((id) => document.querySelector('#taskCli').value === String(id), profil.id);
    assert.equal(await page.locator('#taskCliRow').isVisible(), true);
    await fermer();
    // Une question libre part toujours sur le défaut : pas de sélecteur.
    await ouvrirModale('ask');
    assert.equal(await page.locator('#taskCliRow').isVisible(), false);
    await fermer();
    assert.deepEqual(erreurs, []);
  });

  test('codage, « créer et lancer » avec le binaire choisi : le job part dessus, le journal le nomme, la carte le porte', async () => {
    await ouvrirModale('code');
    await page.waitForSelector('#taskCliRow:not([hidden])');
    await choisirDepot('grp/app');
    await page.locator('#targetRows .target-row .t-branch').first().fill('ai/cli-ecran');
    await page.locator('#taskForm [name="prompt"]').fill('Ajoute un cache sur le panier');
    await page.locator('#taskCli').selectOption(String(profil.id));
    const avant = app.db.prepare('SELECT COUNT(*) c FROM task').get().c;
    await page.locator('#taskSubmit').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    await attendreServeur(async () => app.db.prepare('SELECT COUNT(*) c FROM task').get().c === avant + 1, 'la session est créée');
    const t = app.db.prepare('SELECT * FROM task ORDER BY id DESC LIMIT 1').get();
    assert.equal(t.cli_id, profil.id);
    await waitForJobs(app.api);
    const journal = app.db.prepare('SELECT text FROM job_log ORDER BY id').all().map((l) => l.text);
    assert.ok(journal.some((l) => l.includes('Ollama qwen') && l.includes('/opt/agents/claude-ollama')), `le journal nomme le binaire de la session :\n${journal.join('\n')}`);
    await page.waitForSelector(`#taskList [data-task="${t.id}"] .task-cli`);
    // Dupliquer reprend le binaire : la copie propose le même choix.
    await page.locator(`#taskList [data-task="${t.id}"] [data-tcopy]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((id) => document.querySelector('#taskCli').value === String(id), profil.id);
    await fermer();
    // …hors dépôt aussi, par son propre envoi.
    await page.locator('#tab-task .subnav [data-kind="local"]').click();
    await page.waitForSelector(`#localList [data-local="${localTask.id}"] [data-lcopy]`);
    await page.locator(`#localList [data-local="${localTask.id}"] [data-lcopy]`).click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction((id) => document.querySelector('#taskCli').value === String(id), profil.id);
    await fermer();
  });

  test('supprimer un binaire depuis la liste : confirmation, la ligne disparaît, les cartes gardent son nom, le sélecteur se replie', async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="aisession"]').click();
    await page.waitForSelector(`#cliList [data-clidel="${profil.id}"]`);
    await page.locator(`#cliList [data-clidel="${profil.id}"]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').textContent(), /Ollama qwen/);
    await page.locator('#confirmOk').click();
    await page.waitForFunction((id) => !document.querySelector(`#cliList [data-cli="${id}"]`), profil.id);
    await attendreServeur(async () => (await app.api('GET', '/api/agent-clis')).body.items.length === 0, 'le binaire est supprimé');
    // Les sessions qui l'avaient choisi retombent sur le défaut ; leur carte garde le nom (photo).
    const t = app.db.prepare("SELECT cli_id, cli_name FROM task WHERE cli_name = 'Ollama qwen' ORDER BY id DESC LIMIT 1").get();
    assert.equal(t.cli_id, null); assert.equal(t.cli_name, 'Ollama qwen');
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator('#tab-task .subnav [data-kind="code"]').click();
    await page.waitForSelector('#taskList .task-cli');
    // Sans autre binaire, une session neuve ne montre plus de sélecteur.
    await ouvrirModale('explore');
    assert.equal(await page.locator('#taskCliRow').isVisible(), false);
    await fermer();
    assert.deepEqual(erreurs, []);
  });
});
