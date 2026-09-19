'use strict';
/* TRANSVERSE — LE MODE DÉMO (`npx mergerie demo`), DANS UN VRAI NAVIGATEUR.
 *
 * `unit-bin` prouve que la commande sème ~/.mergerie/demo et que la page SERVIE contient la
 * bannière ; `e2e-git-merge` que le dépôt local de la démo porte son conflit ; les `unit-demo-*`
 * que chaque décor (diff, Jenkins, review) répond. Personne n'avait ouvert la démo comme le fait
 * un visiteur : ce fichier la lance et la parcourt.
 *
 * PAS DE `startApp()` : la démo est un PROCESSUS À PART, lancé comme npx le lance — `bin/
 * mergerie.js demo`, un HOME jetable, et SURTOUT sans `MERGERIE_DATA_DIR` ni `MERGERIE_DEMO`
 * hérités : le semis efface le dossier que désigne `MERGERIE_DATA_DIR` avant de semer. Rien de
 * `src/` n'est chargé dans ce processus-ci.
 *
 * Ce qu'on regarde :
 *   - la bannière de démo et le badge dry-run sont visibles ;
 *   - chaque menu montre son décor : merge requests à traiter et rapports (un rapport s'ouvre),
 *     sessions, tickets Jira, jobs Jenkins, projets Docker ;
 *   - « Chercher les nouvelles MR » ne part pas sur le réseau et ne lève aucune erreur ;
 *   - une nouvelle session propose d'office le SEUL dépôt réellement clonable ;
 *   - la palette propose un projet compose du décor, et y mène ;
 *   - aucune erreur JavaScript. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur, afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
const BIN = path.join(__dirname, '..', 'bin', 'mergerie.js');
const portLibre = () => new Promise((ok) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

describe('Transverse — le mode démo, parcouru au navigateur', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let home; let enfant; let base; let navigateur; let page;
  let sortie = '';
  const erreurs = [];

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mergerie-demo-e2e-'));
    const port = await portLibre();
    const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port) };
    // Ni l'un ni l'autre ne doit être hérité : voir l'en-tête.
    delete env.MERGERIE_DATA_DIR; delete env.MERGERIE_DEMO; delete env.LIN_DATA_DIR; delete env.LIN_DEMO;
    delete env.HOST;
    enfant = spawn(process.execPath, [BIN, 'demo'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    enfant.stdout.on('data', (d) => { sortie += d; });
    enfant.stderr.on('data', (d) => { sortie += d; });
    base = `http://127.0.0.1:${port}`;
    await attendreServeur(async () => {
      try { return (await fetch(`${base}/api/status`)).ok; } catch { return false; }
    }, `la démo répond sur :${port}\n${sortie}`, 120000);
    assert.equal((await (await fetch(`${base}/api/status`)).json()).demo, true, 'le serveur tourne en mode démo');
    assert.ok(fs.existsSync(path.join(home, '.mergerie', 'demo')), 'la démo est semée dans le HOME jetable');

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.goto(base);
    await page.waitForSelector('nav button[data-tab="review"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (enfant && enfant.exitCode === null) {
      enfant.kill('SIGTERM');
      await new Promise((r) => enfant.once('exit', r));
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  async function aller(onglet) {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator(`nav button[data-tab="${onglet}"]`).click();
    await page.waitForSelector(`#tab-${onglet}.active`);
  }

  test('la bannière de démo et le badge dry-run sont affichés', async () => {
    await page.waitForSelector('#demoBanner:not([hidden])');
    assert.match(await page.locator('#demoBanner').textContent(), /Mode démo/);
    await page.waitForSelector('#dryBadge:not([hidden])');
  });

  test('Reviews : une file à traiter, des rapports, et un rapport qui s’ouvre', async () => {
    await aller('review');
    await page.locator('.segmented [data-seg="to_review"]').click();
    await page.waitForSelector('#toReviewList .card[data-id]');
    await page.locator('.segmented [data-seg="reviewed"]').click();
    await page.waitForSelector('#reportList .card[data-id]');
    await page.locator('#reportList .card[data-id]').first().click();
    await page.waitForFunction(() => /^#\/reviews\/\d+$/.test(window.location.hash));
    await page.waitForFunction(() => (document.querySelector('#mdView') || {}).textContent?.trim().length > 50);
  });

  test('« Chercher les nouvelles MR » ne part pas sur le réseau et ne lève aucune erreur', async () => {
    await aller('review');
    await page.locator('.segmented [data-seg="to_review"]').click();
    await page.waitForSelector('#toReviewList .card[data-id]');
    const avant = await page.locator('#toReviewList .card[data-id]').count();
    const reponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/discover' && r.request().method() === 'POST');
    await page.locator('#btnDiscover').click();
    const r = await reponse;
    const corps = await r.json();
    assert.deepEqual(corps.errors || [], [], 'aucune erreur de jeton en démo');
    await page.waitForFunction(() => !document.querySelector('#btnDiscover').disabled);
    assert.equal(await page.locator('#toasts .toast.err').count(), 0, 'aucun message d’erreur');
    await page.waitForFunction((n) => document.querySelectorAll('#toReviewList .card[data-id]').length === n, avant);
  });

  test('Dev IA : des sessions, et une nouvelle session vise d’office le dépôt clonable', async () => {
    await aller('task');
    await page.waitForSelector('#taskList .task-row[data-task]');
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => [...document.querySelectorAll('#taskModal input')].some((i) => i.value === 'groupe/tarification'));
  });

  test('Jira, Jenkins et Docker montrent leur décor', async () => {
    await aller('jira');
    await page.waitForSelector('#jiraList .jira-item');
    await aller('jenkins');
    await page.waitForSelector('#jenkinsBox .jk-row');
    await aller('docker');
    await page.waitForFunction(() => /boutique/.test(document.querySelector('#tab-docker').textContent));
  });

  test('la palette propose un projet compose du décor, et mène à Docker → Compose', async () => {
    // Docker sur un AUTRE sous-onglet, puis ailleurs : la palette doit ramener sur Compose.
    await aller('docker');
    await page.locator('#tab-docker .subnav [data-dsub="orphans"]').click();
    await page.waitForSelector('#dsub-orphans.active');
    await aller('review');
    await page.locator('#paletteTrigger').click();
    await page.waitForSelector('#paletteModal:not([hidden])');
    await page.locator('#paletteInput').fill('boutique');
    const entree = page.locator('#paletteList .palette-item')
      .filter({ has: page.locator('.palette-label', { hasText: /^Docker : projet boutique$/ }) }).first();
    await entree.click();
    await page.waitForSelector('#tab-docker.active');
    await page.waitForSelector('#tab-docker .subnav [data-dsub="compose"].active');
    await page.waitForSelector('#dsub-compose.active');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
