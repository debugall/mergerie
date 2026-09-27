'use strict';
/* PLUSIEURS BINAIRES, UN PAR DÉFAUT. Le défaut reste `local_config` ; `agent_cli` porte les
 * autres, complets. Une session choisit le sien (`cli_id`), son nom est photographié
 * (`cli_name`), et le job qui l'exécute pose le profil sur son contexte asynchrone : tout ce
 * que le lanceur lit — binaire, arguments, variables, backend — vient du profil, en bloc.
 * « Utiliser par défaut » échange la ligne avec le défaut.
 *
 * Un seul `startApp()`. Les modules de `src/` sont requis APRÈS lui (MERGERIE_DATA_DIR). */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, waitForJobs } = require('./helpers/app');

describe('Binaires d’agent : plusieurs, un par défaut, choisi par session', () => {
  let app; let repoId;
  let cli; let copilot; let policy; let backends;

  before(async () => {
    app = await startApp();
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' })).body.id;
    // eslint-disable-next-line global-require
    cli = require('../src/agent/cli'); copilot = require('../src/agent/copilot');
    // eslint-disable-next-line global-require
    policy = require('../src/agent/policy'); backends = require('../src/agent/backends');
  });
  after(async () => { await app.stop(); });

  const liste = async () => (await app.api('GET', '/api/agent-clis')).body;

  test('la saisie est validée comme le défaut : nom, binaire, variables NOM=valeur, jamais MERGERIE_*, backend connu, nom unique', async () => {
    assert.equal((await app.api('POST', '/api/agent-clis', { bin: 'claude' })).status, 400, 'sans nom');
    assert.equal((await app.api('POST', '/api/agent-clis', { name: 'X' })).status, 400, 'sans binaire');
    assert.equal((await app.api('POST', '/api/agent-clis', { name: 'X', bin: 'claude', env: 'pas une variable' })).status, 400);
    assert.equal((await app.api('POST', '/api/agent-clis', { name: 'X', bin: 'claude', env: 'MERGERIE_ACCESS_TOKEN=x' })).status, 400);
    assert.equal((await app.api('POST', '/api/agent-clis', { name: 'X', bin: 'claude', backend: 'plop' })).status, 400);
    const r = await app.api('POST', '/api/agent-clis', {
      name: '  Ollama qwen ', bin: ' /opt/agents/claude-ollama ', args: ' --model qwen3.6 ',
      env: ' ANTHROPIC_BASE_URL = http://localhost:11434 \n\n# rien\nANTHROPIC_AUTH_TOKEN=ollama', timeout_ms: 5, backend: 'claude',
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.name, 'Ollama qwen');
    assert.equal(r.body.bin, '/opt/agents/claude-ollama');
    assert.equal(r.body.args, '--model qwen3.6');
    assert.equal(r.body.env, 'ANTHROPIC_BASE_URL=http://localhost:11434\nANTHROPIC_AUTH_TOKEN=ollama');
    assert.equal(r.body.timeout_ms, 10000, 'le délai est borné comme celui du défaut');
    assert.equal(r.body.backend, 'claude');
    assert.equal((await app.api('POST', '/api/agent-clis', { name: 'ollama QWEN', bin: 'x' })).status, 400, 'nom déjà pris, casse ignorée');
    const d = await liste();
    assert.equal(d.items.length, 1);
    assert.equal(d.defaut.id, null, 'le défaut est en tête, sans id');
  });

  test('le défaut se nomme (agent_name, de poste) — sinon c’est le nom de son binaire', async () => {
    await app.api('PUT', '/api/config', { agent_bin: '/opt/agents/claude-principal', agent_name: '' });
    assert.equal((await liste()).defaut.name, 'claude-principal');
    const c = (await app.api('PUT', '/api/config', { agent_name: '  Claude Max  ' })).body;
    assert.equal(c.agent_name, 'Claude Max');
    assert.equal((await app.api('GET', '/api/config')).body.scopes.agent_name, 'poste');
    assert.equal((await liste()).defaut.name, 'Claude Max');
  });

  test('une session choisit son binaire : l’id est de poste, le nom est photographié — un id inconnu est refusé', async () => {
    const prof = (await liste()).items[0];
    assert.equal((await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'Où ?', targets: [{ repo_id: repoId }], cli_id: 999999 })).status, 400);
    const t = (await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'Où ?', targets: [{ repo_id: repoId }], cli_id: prof.id })).body;
    assert.equal(t.cli_id, prof.id); assert.equal(t.cli_name, 'Ollama qwen');
    // Sans choix : rien d'écrit. Édition : absent = on garde ; vide = retour au défaut.
    const sans = (await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'Où ?', targets: [{ repo_id: repoId }] })).body;
    assert.equal(sans.cli_id, null); assert.equal(sans.cli_name, null);
    assert.equal((await app.api('PUT', `/api/tasks/${t.id}`, { prompt: 'Où donc ?' })).body.cli_id, prof.id, 'absent du corps : on garde');
    assert.equal((await app.api('PUT', `/api/tasks/${t.id}`, { cli_id: '' })).body.cli_id, null, 'vide : le défaut');
    assert.equal((await app.api('PUT', `/api/tasks/${t.id}`, { cli_id: prof.id })).body.cli_name, 'Ollama qwen');
    // Hors dépôt : même contrat, sa propre route.
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'ldir-'));
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Range', dirs: [dir], cli_id: prof.id })).body;
    assert.equal(lt.cli_id, prof.id); assert.equal(lt.cli_name, 'Ollama qwen');
    assert.equal((await app.api('PUT', `/api/local-tasks/${lt.id}`, { cli_id: '' })).body.cli_id, null);
    // « Reprendre au terminal » nomme le binaire de la session, pas le défaut du moment.
    const avecHandle = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'x', targets: [{ repo_id: repoId, branch: 'ai/cli' }], cli_id: prof.id,
      session_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    })).body;
    assert.match(avecHandle.targets[0].resume_cmd || '', /\/opt\/agents\/claude-ollama --model qwen3\.6 --resume 6ba7b810/);
    const ltH = (await app.api('POST', '/api/local-tasks', { prompt: 'x', dirs: [dir], cli_id: prof.id, session_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c9' })).body;
    assert.match(ltH.dirs[0].resume_cmd || '', /\/opt\/agents\/claude-ollama/);
    // Une session fournie sur un profil d'un AUTRE backend est rangée avec ce backend-là.
    const cop = (await app.api('POST', '/api/agent-clis', { name: 'Cop', bin: '/opt/agents/cop', backend: 'copilot' })).body;
    const surCop = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'x', targets: [{ repo_id: repoId, branch: 'ai/cop' }], cli_id: cop.id, session_id: '/tmp/home-copilot',
    })).body;
    assert.match(surCop.targets[0].resume_cmd || '', /COPILOT_HOME|--continue/, `reprise copilot : ${surCop.targets[0].resume_cmd}`);
    assert.equal(app.db.prepare("SELECT session_backend b FROM local_session WHERE session_key = '/tmp/home-copilot'").get().b, 'copilot');
    // À l'ÉDITION aussi : un handle copilot (un chemin) passe sous ce profil, pas sous le défaut claude.
    const edite = await app.api('PUT', `/api/tasks/${surCop.id}`, { session_id: '/tmp/home-copilot-2' });
    assert.equal(edite.status, 200, edite.text);
    assert.equal((await app.api('PUT', `/api/tasks/${avecHandle.id}`, { session_id: '/tmp/pas-un-uuid' })).status, 400, 'sous un profil claude, un handle doit être un UUID');
    await app.api('DELETE', `/api/agent-clis/${cop.id}`);
    // Renommer le profil renomme les sessions qui le pointent ; l'échange, lui, se fait plus bas.
    await app.api('PUT', `/api/agent-clis/${prof.id}`, { name: 'Ollama local' });
    assert.equal((await app.api('GET', `/api/tasks/${t.id}`)).body.task.cli_name, 'Ollama local');
  });

  test('sous le profil, le lanceur lit TOUT du profil : binaire, arguments (même vides), variables (jamais celles du défaut), backend', async () => {
    await app.api('PUT', '/api/config', { agent_args: '--model claude-sonnet-5', agent_env: 'HTTPS_PROXY=http://proxy.defaut:3128', agent_backend: 'auto' });
    const prof = (await liste()).items[0];
    assert.equal(copilot.binActuel(), '/opt/agents/claude-principal', 'hors profil : le défaut');
    assert.deepEqual(policy.envAgent('claude').HTTPS_PROXY, 'http://proxy.defaut:3128');
    cli.avec(prof, () => {
      assert.equal(copilot.binActuel(), '/opt/agents/claude-ollama');
      assert.deepEqual(copilot.argsActuels(), ['--model', 'qwen3.6']);
      assert.equal(copilot.timeoutActuel(), 10000);
      const env = policy.envAgent('claude');
      assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama');
      assert.equal(env.HTTPS_PROXY, undefined, 'les variables du défaut ne fuient pas dans le profil');
      assert.equal(env.MERGERIE_ACCESS_TOKEN, undefined);
      assert.equal(backends.detecter('/opt/agents/claude-ollama'), 'claude', 'le backend explicite du profil');
    });
    assert.equal(copilot.binActuel(), '/opt/agents/claude-principal', 'après : le défaut, rien ne reste');
    // Un profil sans arguments n'hérite pas de ceux du défaut (ni de ceux du .env).
    const vide = (await app.api('POST', '/api/agent-clis', { name: 'Nu', bin: '/opt/agents/nu', backend: 'generic' })).body;
    cli.avec(vide, () => {
      assert.deepEqual(copilot.argsActuels(), []);
      assert.equal(backends.detecter('/opt/agents/nu'), 'unknown');
    });
    await app.api('DELETE', `/api/agent-clis/${vide.id}`);
    // Le contexte suit les promesses : deux profils en parallèle ne se voient pas.
    const [a, b] = await Promise.all([
      cli.avec(prof, async () => { await new Promise((r) => setTimeout(r, 20)); return copilot.binActuel(); }),
      cli.avec(null, async () => { await new Promise((r) => setTimeout(r, 5)); return copilot.binActuel(); }),
    ]);
    assert.equal(a, '/opt/agents/claude-ollama'); assert.equal(b, '/opt/agents/claude-principal');
  });

  test('« Tester » un binaire lance l’essai sur son profil ; en dry-run, il dit son chemin', async () => {
    const prof = (await liste()).items[0];
    const r = await app.api('POST', `/api/agent-clis/${prof.id}/test`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.bin, '/opt/agents/claude-ollama');
    assert.deepEqual(r.body.args, ['--model', 'qwen3.6']);
    assert.equal(r.body.dryRun, true);
    assert.equal((await app.api('POST', '/api/agent-clis/999999/test')).status, 400);
  });

  test('un job pose le profil de sa session : le journal nomme le binaire, et un profil disparu retombe sur le défaut en le disant', async () => {
    const prof = (await liste()).items[0];
    const dir = fs.mkdtempSync(path.join(app.dataDir, 'ldir-'));
    const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'Range les imports', dirs: [dir], cli_id: prof.id })).body;
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);
    const lignes = () => app.db.prepare('SELECT text FROM job_log ORDER BY id').all().map((l) => l.text);
    const journal = lignes();
    // Le dry-run hors dépôt ne lance rien (il pose un marqueur) : c'est la ligne du profil qui prouve le contexte.
    assert.ok(journal.some((l) => l.includes('Ollama local') && l.includes('/opt/agents/claude-ollama')), `le journal nomme le binaire : ${journal.join('\n')}`);
    // Le profil supprimé : la session garde son nom, l'id tombe (ON DELETE SET NULL), le run le dit.
    await app.api('DELETE', `/api/agent-clis/${prof.id}`);
    const apres = (await app.api('GET', `/api/local-tasks/${lt.id}`)).body.task;
    assert.equal(apres.cli_id, null); assert.equal(apres.cli_name, 'Ollama local');
    const avant = lignes().length;
    await app.api('POST', `/api/local-tasks/${lt.id}/run`);
    await waitForJobs(app.api);
    const suite = lignes().slice(avant);
    assert.ok(!suite.some((l) => l.includes('/opt/agents/claude-ollama')), 'plus de profil à nommer : le défaut, sans un mot');
    assert.equal(suite.some((l) => /codage \(dry-run\)/.test(l)), true, 'et la session a bien retourné');
  });

  test('« utiliser par défaut » échange la ligne et le défaut, et retire la preuve de sandbox', async () => {
    const prof = (await app.api('POST', '/api/agent-clis', {
      name: 'Copilot', bin: '/opt/agents/copilot', args: '--allow-all', env: 'GH_HOST=github.entreprise', timeout_ms: 20000, backend: 'copilot',
    })).body;
    await app.api('PUT', '/api/config', { agent_name: 'Claude Max', agent_bin: '/opt/agents/claude-principal', agent_args: '--model claude-sonnet-5', agent_env: 'HTTPS_PROXY=http://proxy.defaut:3128', agent_timeout_ms: 30000, agent_backend: 'claude' });
    app.db.prepare('UPDATE local_config SET agent_sandbox_verified = 1 WHERE id = 1').run();
    const t = (await app.api('POST', '/api/tasks', { kind: 'explore', prompt: 'Où ?', targets: [{ repo_id: repoId }], cli_id: prof.id })).body;
    const r = await app.api('POST', `/api/agent-clis/${prof.id}/default`);
    assert.equal(r.status, 200, r.text);
    const c = (await app.api('GET', '/api/config')).body;
    assert.equal(c.agent_bin, '/opt/agents/copilot'); assert.equal(c.agent_args, '--allow-all');
    assert.equal(c.agent_env, 'GH_HOST=github.entreprise'); assert.equal(Number(c.agent_timeout_ms), 20000);
    assert.equal(c.agent_backend, 'copilot'); assert.equal(c.agent_name, 'Copilot');
    assert.equal(Number(app.db.prepare('SELECT agent_sandbox_verified v FROM local_config WHERE id = 1').get().v), 0, 'un autre binaire, une preuve à refaire');
    const ligne = (await liste()).items.find((x) => x.id === prof.id);
    assert.equal(ligne.name, 'Claude Max'); assert.equal(ligne.bin, '/opt/agents/claude-principal');
    assert.equal(ligne.args, '--model claude-sonnet-5'); assert.equal(ligne.env, 'HTTPS_PROXY=http://proxy.defaut:3128');
    assert.equal(ligne.timeout_ms, 30000); assert.equal(ligne.backend, 'claude');
    // La session qui pointait la ligne pointe maintenant l'ancien défaut : un choix explicite reste explicite.
    assert.equal((await app.api('GET', `/api/tasks/${t.id}`)).body.task.cli_name, 'Claude Max');
    assert.equal((await app.api('POST', '/api/agent-clis/999999/default')).status, 400);
  });
});
