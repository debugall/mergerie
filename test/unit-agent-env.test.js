'use strict';
/* CE QUE L'AGENT REÇOIT VRAIMENT — argv et environnement, lus par un faux binaire.
 *
 * `agentpolicy` décide ; il reste à prouver que la décision arrive jusqu'au processus : une
 * review lancée avec `COPILOT_ARGS=--dangerously-skip-permissions` ne l'emporte plus, un codage
 * le garde, et ni l'un ni l'autre ne voit les jetons du `.env` de Mergerie (forge, Jira, accès).
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creerFauxClaude } = require('./helpers/fake-claude');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-env-'));
const RESULTAT = [{ type: 'result', subtype: 'success', session_id: 's', result: 'ok' }];
const faux = creerFauxClaude(tmp, { events: RESULTAT });

process.env.MERGERIE_DATA_DIR = tmp;
process.env.COPILOT_BIN = faux.bin;
process.env.COPILOT_ARGS = '--dangerously-skip-permissions';
process.env.GITLAB_TOKEN = 'glpat-NE-DOIT-PAS-PASSER';
process.env.JIRA_API_TOKEN = 'jira-NE-DOIT-PAS-PASSER';
process.env.MERGERIE_ACCESS_TOKEN = 'acces-NE-DOIT-PAS-PASSER';
delete process.env.COPILOT_DRY_RUN;

// Après les variables d'environnement : copilot.js fige COPILOT_BIN et COPILOT_ARGS au chargement.
// eslint-disable-next-line import/order
const agentsession = require('../src/agent/session');
// eslint-disable-next-line import/order
const copilot = require('../src/agent/copilot');

after(() => {
  for (const k of ['GITLAB_TOKEN', 'JIRA_API_TOKEN', 'MERGERIE_ACCESS_TOKEN', 'COPILOT_ARGS']) delete process.env[k];
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

const lancer = (saveur) => agentsession.runInSession({
  key: `k-${saveur}`, prompt: 'x', cwd: fs.mkdtempSync(path.join(tmp, 'w-')), resume: false, saveur,
});

describe('Ce que reçoit le processus de l’agent', () => {
  test('une review ne part pas avec --dangerously-skip-permissions', async () => {
    await lancer('review');
    const argv = faux.argv();
    assert.equal(argv.includes('--dangerously-skip-permissions'), false, argv.join(' '));
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'default');
  });

  test('un codage le garde, sans les chemins de fuite', async () => {
    await lancer('code');
    const argv = faux.argv();
    assert.ok(argv.includes('--dangerously-skip-permissions'));
    assert.match(argv[argv.indexOf('--disallowedTools') + 1], /Bash\(git push:\*\)/);
  });

  test('l’environnement n’emporte aucun jeton du .env de Mergerie', async () => {
    await lancer('code');
    const env = faux.env();
    assert.equal(env.GITLAB_TOKEN, undefined);
    assert.equal(env.JIRA_API_TOKEN, undefined);
    assert.equal(env.MERGERIE_ACCESS_TOKEN, undefined);
    assert.equal(env.MERGERIE_DATA_DIR, undefined, 'ni où est la base');
    assert.ok(env.PATH && env.HOME, 'mais de quoi trouver ses outils');
  });

  test('le chemin sans session (runPrompt) suit la même politique', async () => {
    assert.equal(copilot.isDryRun(), false, 'préalable : le faux binaire est vu comme disponible');
    await copilot.runPrompt('x', fs.mkdtempSync(path.join(tmp, 'w-')), { kind: 'explain' });
    assert.equal(faux.argv().includes('--dangerously-skip-permissions'), false);
    assert.equal(faux.env().GITLAB_TOKEN, undefined);
  });

  test('au-delà du plafond de dépense du jour, aucun agent ne part', async () => {
    const config = require('../src/data/config');
    const db = require('../src/db');
    config.updateConfig({ agent_daily_budget_usd: '1.5' });
    db.prepare('INSERT INTO usage (kind, prompt_chars, output_chars, tokens_est, created_at, cost_usd) VALUES (?,?,?,?,?,?)')
      .run('review', 1, 1, 1, new Date().toISOString(), 2);
    await assert.rejects(lancer('review'), (e) => e.code === 'BUDGET', 'le lancement est refusé');
    await assert.rejects(copilot.runPrompt('x', tmp, { kind: 'explain' }), (e) => e.code === 'BUDGET', 'par les deux chemins');
    config.updateConfig({ agent_daily_budget_usd: '0' });
    await lancer('review');                  // 0 = sans limite : ça repart
  });
});
