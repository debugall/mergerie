'use strict';
/* MENU AGENTS — CE QUI DÉPEND DU POSTE : le backend copilot, et l'exécutant d'un agent planifié.
 *
 * Deux avertissements et un champ qui n'apparaissent que dans une configuration précise, donc
 * jamais dans les autres fichiers :
 *   - backend `copilot` : seul le modèle est transmis. La liste et l'éditeur le disent, et
 *     l'aperçu de la ligne de commande ne montre que `--model` ;
 *   - dépôt de données configuré (on travaille à plusieurs) : l'éditeur montre « Exécutant »,
 *     avertit quand un agent planifié n'en a pas, et l'exécutant choisi est enregistré.
 *
 * Fichier à part : `COPILOT_BIN` est lu au chargement du serveur, une fois.
 * Un seul `startApp()` : les tests partagent l'app et le navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fauxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-agents-poste-home-'));
process.env.MERGERIE_CLAUDE_HOME = fauxHome;
// Le binaire n'est jamais lancé (dry-run) : seul son NOM compte, il décide du backend.
process.env.COPILOT_BIN = 'copilot';

// eslint-disable-next-line import/order
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Agents : backend copilot et exécutant', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    /* Un dépôt de données configuré suffit à faire « équipe » pour l'écran (`/api/whoami`).
       La synchro, elle, ne démarre qu'au lancement ou au rattachement : rien ne part vers cette
       adresse pendant les tests. */
    const r = await app.configure({ data_repo_url: 'https://gitlab.test/equipe/donnees.git' });
    assert.equal(r.status, 200, r.text);
    assert.equal((await app.api('GET', '/api/whoami')).body.partage, true);
    // Un exécutant connu : un agent d'un collègue, sans horaire (le tic ne le lancera pas).
    const c = await app.api('POST', '/api/agents', { name: 'Agent du collègue', kind: 'explore', runner: 'poste-collegue' });
    assert.equal(c.status, 201, c.text);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    // L'état du serveur (qui porte le binaire) est lu au chargement : on attend qu'il soit là.
    await page.waitForFunction(() => document.querySelector('#dryBadge') && !document.querySelector('#dryBadge').hidden);
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    try { fs.rmSync(fauxHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const allerListe = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.locator('#tab-agents .subnav [data-sub="list"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#agentList .agent-card').length > 0);
  };
  const ouvrirNouveau = async () => {
    await allerListe();
    await page.locator('#btnNewAgent').click();
    await page.waitForSelector('#agentModal:not([hidden])');
    await page.evaluate(() => document.querySelectorAll('#agentForm details').forEach((d) => { d.open = true; }));
  };

  test('backend copilot : la liste et l’éditeur préviennent que seul le modèle est transmis', async () => {
    await allerListe();
    await page.waitForSelector('#agentListCopilotWarn:not([hidden])');
    assert.match(await page.locator('#agentListCopilotWarn').innerText(), /seul le modèle est transmis/);

    await ouvrirNouveau();
    await page.waitForSelector('#agentCopilotWarn:not([hidden])');
    await page.locator('#agentName').fill('Profil sous copilot');
    await page.locator('#agentSystemPrompt').fill('Tu es prudent.');
    await page.locator('#agentModel').fill('gpt-5');
    await page.locator('#agentMaxTurns').fill('9');
    // L'aperçu dit ce qui partira VRAIMENT : le modèle, et rien d'autre du profil.
    await page.waitForFunction(() => /--model gpt-5/.test(document.querySelector('#agentArgvPreview').textContent));
    const argv = await page.locator('#agentArgvPreview').innerText();
    assert.ok(!/--append-system-prompt|--max-turns|--permission-mode/.test(argv), argv);
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
  });

  test('à plusieurs, « Exécutant » apparaît, avertit sans exécutant, et le choix est enregistré', async () => {
    await ouvrirNouveau();
    await page.waitForSelector('#agentRunnerRow:not([hidden])');
    const options = await page.$$eval('#agentRunner option', (els) => els.map((o) => [o.value, o.textContent]));
    assert.ok(options.some(([v, l]) => v === '' && /Personne/.test(l)), JSON.stringify(options));
    assert.ok(options.some(([v]) => v === 'poste-collegue'), JSON.stringify(options));

    // Sans horaire, pas de remarque : la question ne se pose pas.
    assert.equal(await page.locator('#agentRunnerNone').isHidden(), true);
    await page.locator('#agentName').fill('Planifié en équipe');
    await page.locator('#agentMaxTurns').fill('7');
    await page.locator('#agentScheduleKind').selectOption('daily');
    // Planifié sans exécutant : il ne tournera nulle part, et l'éditeur le dit.
    await page.waitForSelector('#agentRunnerNone:not([hidden])');
    await page.locator('#agentRunner').selectOption('poste-collegue');
    await page.waitForSelector('#agentRunnerNone', { state: 'hidden' });

    await page.locator('#agentSave').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
    const trouve = async () => (await app.api('GET', '/api/agents')).body.find((a) => a.name === 'Planifié en équipe');
    await attendreServeur(async () => Boolean(await trouve()), 'l’agent est enregistré');
    const a = await trouve();
    assert.equal(a.runner, 'poste-collegue');
    assert.equal(a.schedule, 'daily 07:00');

    // Relu à l'édition.
    await allerListe();
    await page.locator(`#agentList .agent-card[data-id="${a.id}"] .btn-agent-edit`).click();
    await page.waitForSelector('#agentModal:not([hidden])');
    await page.waitForSelector('#agentRunnerRow:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#agentRunner').value === 'poste-collegue');
    await page.locator('#agentCancel').click();
    await page.waitForSelector('#agentModal', { state: 'hidden' });
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
