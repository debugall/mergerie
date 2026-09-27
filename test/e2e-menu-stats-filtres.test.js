'use strict';
/* MENU « STATISTIQUES » — LA PÉRIODE ET LE DÉPÔT.
 *
 * La barre en tête de l'écran donne son sens à tout ce qui suit : « tout / 7 j / 30 j / 90 j »
 * et un combo À RECHERCHE des dépôts (une installation peut en suivre quarante). Les deux sont
 * des préférences d'écran, gardées par le navigateur comme le thème : elles survivent au
 * rechargement.
 *
 * Le contrat est écrit au-dessus de la route (src/server.js, `/api/stats`) : `days` et
 * `project` s'appliquent à ce qui se DATE et à ce qui se rattache à un dépôt ; seul
 * l'entonnoir, un état courant, ignore la période. Les tests marqués `todo` montrent les blocs
 * qui ne le respectent pas encore.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const seed = require('./helpers/stats-seed');

const { dispo } = navigateurDispo();

describe('Menu Statistiques — période et dépôt', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  let donnees;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    donnees = await seed.semerTout(app);
    /* Ce qui n'appartient qu'à « tout l'historique » : une session chère d'il y a cent jours et
       une suppression de tag d'il y a vingt jours (dans « 30 j », pas dans « 7 j »). */
    const ancienne = seed.insererTache(app.db, donnees.repos['grp/alpha'], {
      prompt: 'Migrer toute la base', label: 'Session ancienne', quand: seed.ilYa(100 * seed.J),
    });
    seed.insererUsage(app.db, { kind: 'task', tokens: 9000, owner: { kind: 'task', id: ancienne }, quand: seed.ilYa(100 * seed.J) });
    seed.insererGitOp(app.db, donnees.repos['grp/alpha'], 'grp/alpha', 'delete_tag', 'ok', seed.ilYa(20 * seed.J));

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await allerStats();
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  async function allerStats() {
    await page.locator('nav button[data-tab="dashboard"]').click();
    await page.waitForSelector('#tab-dashboard.active #dashboard .dash-periode');
  }
  /* Contournement du défaut couvert par le `todo` plus bas : un passage par Agents charge la
     liste des dépôts (`loadAgentList` l'attend avant de rendre ses cartes). */
  async function chargerDepots() {
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active #agentList .agent-card');
    await allerStats();
  }
  const carte = (titre) => page.locator('#dashboard .dash-card').filter({ has: page.locator('h3', { hasText: titre }) });
  const puceActive = () => page.locator('#dashboard [data-stats-jours].active').getAttribute('data-stats-jours');
  const sessionsChères = () => carte('Les sessions les plus coûteuses').locator('[data-go-session]').allTextContents();
  const entonnoir = () => page.$$eval('#dashboard > .stat-row .stat-tile .stat-val', (v) => v.map((x) => x.textContent.trim()));
  const totalGit = async () => (await carte('Opérations Git').locator('p.muted').first().textContent()).trim();
  const stocke = (cle) => page.evaluate((k) => localStorage.getItem(k), cle);

  /* Le rendu est SYNCHRONE après la réponse : on attend l'effet (la puce active change), jamais
     un délai. Chaque clic reconstruit la barre — on relit donc les locators à chaque fois. */
  async function choisirPeriode(jours) {
    await page.locator(`#dashboard [data-stats-jours="${jours}"]`).click();
    await page.waitForFunction((j) => {
      const b = document.querySelector('#dashboard [data-stats-jours].active');
      return b && b.dataset.statsJours === String(j) && document.querySelector('#dashboard .dash-periode');
    }, jours);
  }

  async function choisirDepot(tape, valeur) {
    const champ = page.locator('#statsProjetBox .cb-search');
    await champ.click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
    if (tape) await champ.fill(tape);
    await page.locator(`.combo-options:not([hidden]) .combo-opt[data-v="${valeur}"]`).click();
    await page.waitForFunction((v) => {
      const h = document.querySelector('#statsProjetBox .statsProjetVal');
      return h && h.value === v && document.querySelector('#dashboard .dash-periode');
    }, valeur);
  }

  test('la barre de période propose tout / 7 j / 30 j / 90 j, « tout » par défaut', async () => {
    const puces = await page.locator('#dashboard [data-stats-jours]').allTextContents();
    assert.deepEqual(puces.map((p) => p.trim()), ['tout', '7 j', '30 j', '90 j']);
    assert.equal(await puceActive(), '0');
    assert.match(await page.locator('#dashboard .dash-periode').textContent(), /Période/);
    // Tout l'historique : la session d'il y a cent jours est la plus chère, le tag supprimé compte.
    assert.equal((await sessionsChères())[0].trim(), 'Session ancienne');
    assert.equal(await totalGit(), '7 opérations · 1 échec');
  });

  test('« 7 j » écarte ce qui est plus ancien, et laisse l’entonnoir intact', async () => {
    await choisirPeriode(7);
    assert.equal(await stocke('aidevtools_stats_jours'), '7', 'la préférence est gardée par le navigateur');
    assert.ok(!(await sessionsChères()).some((s) => s.includes('Session ancienne')), 'la session d’il y a cent jours sort');
    assert.equal(await totalGit(), '6 opérations · 1 échec', 'le tag supprimé il y a vingt jours sort');
    // « À traiter » est un état courant : le borner dans le temps ne voudrait rien dire.
    assert.deepEqual(await entonnoir(), ['2', '3', '1']);
  });

  test('« 30 j » réintègre l’opération d’il y a vingt jours, pas la session d’il y a cent', async () => {
    await choisirPeriode(30);
    assert.equal(await totalGit(), '7 opérations · 1 échec');
    assert.ok(!(await sessionsChères()).some((s) => s.includes('Session ancienne')));
    await choisirPeriode(90);
    assert.ok(!(await sessionsChères()).some((s) => s.includes('Session ancienne')), 'cent jours > 90 j');
  });

  test('la période choisie survit au rechargement de la page', async () => {
    await choisirPeriode(7);
    await page.reload();
    await allerStats();
    assert.equal(await puceActive(), '7');
    assert.equal(await totalGit(), '6 opérations · 1 échec', 'et elle s’applique dès le premier rendu');
    await choisirPeriode(0);
    assert.equal((await sessionsChères())[0].trim(), 'Session ancienne');
  });

  /* Le combo se remplit de `repoOptions`, « la liste déjà chargée » — mais Statistiques ne la
     charge jamais : elle ne l'est que si un AUTRE écran (Dev IA, Agents, Git, les règles…) est
     passé avant. Ouvrir l'application sur Statistiques (onglet mémorisé, ou premier clic)
     donne un combo qui ne propose que « Tous les dépôts ». */
  test('dès la première visite, le combo propose les dépôts suivis', async () => {
    await page.reload();
    await allerStats();
    await page.locator('#statsProjetBox .cb-search').click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
    try {
      const options = await page.locator('.combo-options:not([hidden]) .combo-opt[data-v]').allTextContents();
      assert.deepEqual(options.map((o) => o.trim()), ['Tous les dépôts', 'grp/alpha', 'grp/beta']);
    } finally { await page.keyboard.press('Escape'); }
  });

  test('le combo des dépôts se cherche, et propose « Tous les dépôts »', async () => {
    await chargerDepots();
    const champ = page.locator('#statsProjetBox .cb-search');
    assert.equal(await champ.getAttribute('placeholder'), 'Tous les dépôts');
    await champ.click();
    await page.waitForSelector('.combo-options:not([hidden]) .combo-opt[data-v]');
    const options = await page.locator('.combo-options:not([hidden]) .combo-opt[data-v]').allTextContents();
    assert.deepEqual(options.map((o) => o.trim()), ['Tous les dépôts', 'grp/alpha', 'grp/beta']);
    // La recherche MASQUE les options qui ne correspondent pas.
    await champ.fill('bet');
    await page.waitForFunction(() => {
      const vus = [...document.querySelectorAll('.combo-options:not([hidden]) .combo-opt[data-v]')].map((o) => o.dataset.v);
      return vus.length === 1 && vus[0] === 'grp/beta';
    });
    await page.keyboard.press('Escape');
  });

  test('choisir un dépôt restreint l’entonnoir, les notes, Git et le délai de cycle', async () => {
    await choisirDepot('bet', 'grp/beta');
    assert.equal(await stocke('aidevtools_stats_projet'), 'grp/beta');
    assert.equal(await page.locator('#statsProjetBox .cb-search').inputValue(), 'grp/beta', 'le choix se voit');
    assert.deepEqual(await entonnoir(), ['1', '1', '0'], 'beta : une à traiter, une reviewée');
    assert.match(await carte('Distribution des notes').locator('h3').textContent(), /moyenne 9\/10/);
    assert.equal(await totalGit(), '1 opération');
    const cycle = carte('Délai de cycle');
    assert.equal((await cycle.locator('.stat-tile .stat-val').first().textContent()).trim(), '36 h');
    assert.equal(await cycle.locator('table').count(), 0, 'un seul projet : pas de tableau détaillé');
  });

  test('le dépôt choisi survit au rechargement, et « Tous les dépôts » le retire', async () => {
    await page.reload();
    await allerStats();
    // Relu du navigateur dès le premier rendu, avant même que la liste des dépôts soit chargée.
    assert.equal(await page.locator('#statsProjetBox .cb-search').inputValue(), 'grp/beta');
    assert.deepEqual(await entonnoir(), ['1', '1', '0']);
    await choisirDepot('', '');
    assert.equal(await stocke('aidevtools_stats_projet'), '');
    await chargerDepots();
    assert.deepEqual(await entonnoir(), ['2', '3', '1']);
  });

  /* Le tableau « Par projet » ajoute toute ligne qui a des MR en attente — requête SANS filtre
     de dépôt (src/server.js, `pending`) : choisir beta affiche encore alpha, avec « En attente 1 »
     et zéro reviewée. */
  test('choisir un dépôt ne laisse que lui dans « Par projet »', async () => {
    await choisirDepot('bet', 'grp/beta');
    try {
      const projets = await carte('Par projet').locator('tbody tr td:first-child').allTextContents();
      assert.deepEqual(projets.map((p) => p.trim()), ['grp/beta']);
    } finally { await choisirDepot('', ''); }
  });

  /* Le coût en tokens (total et camembert) et le ratio entrée/sortie lisent `usage` sans borne
     de date, alors que « les sessions les plus coûteuses », juste en dessous, la respectent :
     sur « 7 j », le total compte encore la session d'il y a cent jours. */
  test('la période s’applique au coût en tokens', async () => {
    await choisirPeriode(7);
    try {
      const total = await carte('Coût en tokens').locator('.stat-tile').nth(1).locator('.stat-val').textContent();
      assert.equal(total.replace(/\s/g, ''), '20500', 'sans la session d’il y a cent jours (9 000 tokens)');
    } finally { await choisirPeriode(0); }
  });

  /* Les constats qui reviennent et le taux de vert se rattachent à un dépôt — le premier par
     sa merge request, le second par ses cibles — mais ignorent le dépôt choisi : sur beta, on
     lit encore le constat d'alpha et la ligne d'alpha. */
  test('choisir un dépôt restreint les constats qui reviennent et le taux de vert', async () => {
    await choisirDepot('bet', 'grp/beta');
    try {
      // Les deux lectures d'abord, une seule assertion : l'échec nomme les deux blocs à la fois.
      const constats = await carte('Constats qui reviennent').locator('[data-rec-project]').evaluateAll((bs) => bs.map((b) => b.dataset.recProject));
      const verifs = await carte('Vérifications : taux de vert par dépôt').locator('tbody tr td:first-child').allTextContents();
      assert.deepEqual({ constats, verifs: verifs.map((v) => v.trim()) }, { constats: [], verifs: ['grp/beta'] });
    } finally { await choisirDepot('', ''); }
  });

  test('aucune exception JavaScript pendant les changements de filtre', () => {
    assert.deepEqual(erreurs, []);
  });
});
