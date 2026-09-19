'use strict';
/* MENU « STATISTIQUES » — CE QUE L'ÉCRAN AFFICHE, bloc par bloc.
 *
 * Chaque carte est fabriquée côté navigateur à partir de `/api/stats` : tester la route ne dit
 * rien de ce qui est lu à l'écran (un libellé technique qui fuit, une barre à zéro qui dessine
 * un moignon, une médiane rendue en heures au lieu de jours). On pose donc un jeu de données
 * dont chaque chiffre se calcule de tête (`helpers/stats-seed`), et l'on lit l'écran.
 *
 * Couvert ici : l'ouverture par la barre latérale, l'entonnoir, la distribution des notes, les
 * reviews par semaine, la note moyenne par semaine, le coût en tokens, la carte « Activité »
 * (présence), le tableau par projet (portes, résolution, tendance, dernier commit) et son taux
 * global, les sessions de dev, le délai de cycle, les sessions et les reviews les plus chères,
 * le coût par agent, le ratio entrée/sortie, le taux de vert par dépôt, les opérations Git, les
 * constats qui reviennent, le Top 5 de la forge, « Rafraîchir », l'export CSV, et l'écran en
 * anglais.
 *
 * Les portes (clics vers Reviews, Dev IA, Réglages) sont dans `e2e-menu-stats-portes`, la
 * période et le dépôt dans `e2e-menu-stats-filtres`, les états vides et dégradés dans
 * `e2e-menu-stats-vide`. Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const seed = require('./helpers/stats-seed');

const { dispo } = navigateurDispo();

// Les nombres sont groupés par une espace fine insécable : on la retire pour comparer.
const sansEspaces = (s) => String(s).replace(/\s/g, '');

describe('Menu Statistiques — le tableau de bord', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  let donnees;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    const cree = await app.api('POST', '/api/agents', { name: 'Veilleur des stats', kind: 'explore' });
    assert.equal(cree.status, 201, cree.text);
    const agent = cree.body;
    donnees = await seed.semerTout(app, { agent });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="dashboard"]').click();
    // La dernière carte rendue par le rendu principal, puis les deux chargements asynchrones.
    await page.waitForSelector('#dashboard [data-rec-rule]');
    await page.waitForSelector('#dashTop5 table tbody tr');
    await page.waitForSelector('#dashActivity .pab');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Une carte, retrouvée par son titre (le titre est la seule chose stable d'une carte à l'autre).
  const carte = (titre) => page.locator('#dashboard .dash-card').filter({ has: page.locator('h3', { hasText: titre }) });

  test('le bouton de la barre latérale ouvre Statistiques, sans erreur de page', async () => {
    assert.equal(await page.locator('#tab-dashboard').isVisible(), true);
    assert.equal(await page.locator('nav button[data-tab="dashboard"]').getAttribute('class'), 'active');
    assert.match(await page.locator('#tab-dashboard .toolbar h2').textContent(), /^Stats/);
    assert.equal(await page.locator('#dashRefresh').isVisible(), true);
    assert.deepEqual(erreurs, [], 'aucune exception JavaScript pendant le rendu');
  });

  test('l’entonnoir compte les merge requests par stade', async () => {
    const tuiles = await page.$$eval('#dashboard > .stat-row .stat-tile', (ts) => ts.map((t) => [
      t.querySelector('.stat-lbl').textContent.trim(), t.querySelector('.stat-val').textContent.trim(),
    ]));
    assert.deepEqual(tuiles, [['À traiter', '2'], ['Reviewées', '3'], ['Traitées', '1']]);
  });

  test('la distribution des notes range chaque review dans sa tranche, et donne la moyenne', async () => {
    const c = carte('Distribution des notes');
    assert.match(await c.locator('h3').textContent(), /moyenne 6\.7\/10/);
    const barres = await c.locator('.hbar').evaluateAll((hs) => hs.map((h) => ({
      lbl: h.querySelector('.hbar-lbl').textContent.trim(),
      val: h.querySelector('.hbar-val').textContent.trim(),
      zero: h.querySelector('.hbar-fill').classList.contains('is-zero'),
    })));
    assert.deepEqual(barres.map((b) => [b.lbl, b.val]),
      [['0–2', '0'], ['2–4', '1'], ['4–6', '0'], ['6–8', '1'], ['8–10', '1'], ['sans note', '1']]);
    // Une tranche vide n'a pas de moignon coloré : elle porte `is-zero`, les autres non.
    for (const b of barres) assert.equal(b.zero, b.val === '0', `tranche ${b.lbl}`);
    assert.match(await c.locator('.dash-help').textContent(), /répartissent les notes/);
  });

  test('les reviews par semaine : huit semaines, chaque passe comptée une fois', async () => {
    const c = carte('Reviews par semaine');
    assert.equal(await c.locator('.vbar').count(), 8);
    assert.equal(await c.locator('.vbars-x span').count(), 8, 'une date sous chaque barre');
    const vals = await c.locator('.vbar-val').allTextContents();
    const total = vals.map((v) => Number(v.trim() || 0)).reduce((a, b) => a + b, 0);
    assert.equal(total, 4, 'quatre passes posées dans les huit dernières semaines');
    // L'infobulle porte la semaine et le compte : c'est elle qui dit ce que la barre mesure.
    const titres = await c.locator('.vbar').evaluateAll((bs) => bs.map((b) => b.title));
    assert.ok(titres.every((t) => /semaine du \d{4}-\d{2}-\d{2} : \d+/.test(t)), JSON.stringify(titres));
  });

  test('la note moyenne par semaine colore selon la note, et nomme les semaines sans review', async () => {
    const c = carte('Note moyenne par semaine');
    assert.equal(await c.locator('.vbars .vbar').count(), 8);
    const barres = await c.locator('.vbars .vbar').evaluateAll((bs) => bs.map((b) => ({
      vide: b.classList.contains('vbar-empty'), titre: b.title,
      classe: (b.querySelector('.vbar-fill') || { className: '' }).className,
    })));
    assert.ok(barres.some((b) => b.vide), 'au moins une semaine sans review');
    for (const b of barres) {
      if (b.vide) { assert.match(b.titre, /aucune review/); continue; }
      const moy = Number((b.titre.match(/: ([\d.]+)\/10/) || [])[1]);
      const attendu = moy >= 7 ? 'vf-good' : moy >= 4 ? 'vf-mid' : 'vf-bad';
      assert.ok(b.classe.includes(attendu), `${b.titre} → ${attendu}, vu « ${b.classe} »`);
    }
    // La date d'une semaine vide passe en gris et le dit en mots.
    const vides = await c.locator('.vbars-x span.no-data').count();
    assert.equal(vides, barres.filter((b) => b.vide).length);
  });

  test('le coût en tokens nomme toutes les familles, en clair, avec leur part', async () => {
    const c = carte('Coût en tokens');
    const legende = await c.locator('.donut-leg').evaluateAll((ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
    // Le nom est le texte propre de la ligne (hors pastille et hors chiffres, dans un `.muted`).
    const noms = await c.locator('.donut-leg').evaluateAll((ls) => ls.map((l) => [...l.childNodes]
      .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()));
    for (const n of ['Reviews', 'Sessions', 'Explorations', 'Questions libres', 'Questions sur une revue', 'Explications', 'Régénérations']) {
      assert.ok(noms.includes(n), `« ${n} » dans la légende (vu ${JSON.stringify(noms)})`);
    }
    assert.ok(!legende.some((l) => /stats\.kind|\bask\b|\bquestion\b/.test(l)), 'aucun nom technique à l’écran');
    // Sessions : 5000 + 1500 + 500 + 300 = 7300 sur 20500 → 36 %.
    const sessions = legende[noms.indexOf('Sessions')];
    assert.equal(sansEspaces(sessions), 'Sessions7300·36%');
    // Le camembert est un dégradé conique à un segment par famille.
    const fond = await c.locator('.donut').evaluate((d) => d.style.background);
    assert.match(fond, /conic-gradient/);
    const tuiles = await c.locator('.stat-tile').evaluateAll((ts) => ts.map((t) => t.textContent.replace(/\s/g, '')));
    assert.deepEqual(tuiles, ['2667Tokens/MRreviewée', '20500Total(minorant)']);
    assert.match(await c.locator('.dash-floor').textContent(), /sous-estimé/, 'le total est dit minorant');
  });

  test('le tableau par projet : pires notes d’abord, résolution, tendance et dernier commit', async () => {
    const c = carte('Par projet');
    const lignes = () => c.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    // Le dernier commit arrive à part, de la forge : on attend qu'il ait remplacé les « … ».
    await page.waitForFunction(() => [...document.querySelectorAll('.dash-lastcommit')].every((td) => !td.textContent.includes('…')));
    const rows = await lignes();
    assert.deepEqual(rows.map((r) => r[0]), ['grp/alpha', 'grp/beta'], 'la moyenne la plus basse en tête');
    const [alpha, beta] = rows;
    assert.deepEqual(alpha.slice(1, 7), ['3', '1', '5.5', '3.5', '75%', '▼ -3.5']);
    assert.deepEqual(beta.slice(1, 7), ['1', '1', '9', '9', '—', '—']);
    // Couleur des notes et du taux, qualifiés comme le reste de l'outil.
    assert.equal(await c.locator('tbody tr').first().locator('td').nth(3).locator('.note').getAttribute('class'), 'note mid');
    assert.equal(await c.locator('tbody tr').first().locator('td').nth(4).locator('.note').getAttribute('class'), 'note bad');
    assert.equal(await c.locator('.res-rate').first().getAttribute('class'), 'res-rate good');
    assert.match(await c.locator('.res-rate').first().getAttribute('title'), /3 résolus sur 4/);
    assert.equal(await c.locator('.proj-trend').getAttribute('class'), 'proj-trend down');
    // « En attente » et « Pire » sont des portes (boutons) ; « Reviewées » n'en est pas une.
    assert.equal(await c.locator('[data-stat-projet="grp/alpha"][data-stat-seg="to_review"]').textContent(), '1');
    assert.equal(await c.locator('[data-stat-projet="grp/alpha"][data-stat-seg="reviewed"]').count(), 1);
    // Dernier commit : un lien vers la forge, avec l'auteur.
    const lien = c.locator('.dash-lastcommit[data-project="grp/alpha"] a');
    assert.equal(await lien.getAttribute('href'), 'https://gitlab.test/grp/alpha/-/commit/c0ffee0');
    assert.equal(await lien.getAttribute('target'), '_blank');
    assert.match(alpha[7], /Auteur 1/);
    assert.match(await c.locator('.stats-res-global').textContent(), /75% — 3 constats corrigés sur 4/);
  });

  test('les sessions de dev : tâches, MR créées, MR mergées, commentaires postés', async () => {
    const tuiles = await carte('Sessions de dev').locator('.stat-tile').evaluateAll((ts) => ts.map((t) => [
      t.querySelector('.stat-lbl').textContent.trim(), t.querySelector('.stat-val').textContent.trim(),
    ]));
    assert.deepEqual(tuiles, [['Tâches', '4'], ['MR créées', '2'], ['MR mergées', '1'], ['Commentaires postés', '2']]);
  });

  test('le délai de cycle : médianes en heures ou en jours, et le détail par projet', async () => {
    const c = carte('Délai de cycle');
    const tuiles = await c.locator('.stat-row .stat-tile').evaluateAll((ts) => ts.map((t) => [
      t.querySelector('.stat-lbl').textContent.trim(), t.querySelector('.stat-val').textContent.trim(),
    ]));
    assert.deepEqual(tuiles, [['Ouverture → merge', '2.8 j'], ['Ouverture → 1re review', '18 h'], ['1re review → merge', '2 j']]);
    assert.match(await c.locator('p.muted').first().textContent(), /sur 2 merge requests mergées/);
    // Deux projets : le tableau détaillé paraît, le plus lent en tête.
    const rows = await c.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.deepEqual(rows, [['grp/alpha', '4 j', '24 h', '3 j', '1'], ['grp/beta', '36 h', '12 h', '24 h', '1']]);
  });

  test('les sessions les plus coûteuses, en tokens, chacune ouvrable', async () => {
    const c = carte('Les sessions les plus coûteuses');
    const rows = await c.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({
      tok: tr.querySelector('.stats-top-tok').textContent.replace(/\s/g, ''),
      lib: tr.querySelector('[data-go-session]').textContent.trim(),
      kind: tr.querySelector('[data-go-session]').dataset.goKind,
    })));
    assert.deepEqual(rows.map((r) => [r.tok, r.lib]), [
      ['5000', 'Session chère'], ['3000', 'Exploration TVA'], ['1500', 'Hors dépôt factures'],
      ['1000', 'Question cache'], ['500', 'Doc 1'],
    ], 'cinq au plus, de la plus chère à la moins chère');
    assert.equal(rows[2].kind, 'local');
    assert.equal(rows[3].kind, 'ask');
  });

  test('le coût par agent additionne ses runs', async () => {
    const c = carte('Coût par agent');
    const txt = (await c.locator('tbody tr').first().textContent()).replace(/\s+/g, ' ');
    assert.match(txt, /800/);
    assert.match(txt, /Veilleur des stats/);
    assert.match(txt, /2 runs/);
    assert.equal(await c.locator('[data-go-agent="Veilleur des stats"]').count(), 1);
  });

  test('les reviews les plus coûteuses mènent chacune à son rapport', async () => {
    const c = carte('Les reviews les plus coûteuses');
    const rows = await c.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()));
    assert.equal(rows.length, 2);
    assert.match(rows[0], /^6 ?000 !2 Alpha mal notée grp\/alpha$/);
    assert.match(rows[1], /^2 ?000 !1 Beta bien notée grp\/beta$/);
    assert.equal(await c.locator(`[data-stat-mr="${donnees.mr.a2}"]`).count(), 1);
  });

  test('ce qu’on envoie contre ce qu’on reçoit : un ratio par famille, les plus lourdes en tête', async () => {
    const c = carte('Ce qu’on envoie contre ce qu’on reçoit');
    const rows = await c.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    assert.equal(rows[0][0], 'Reviews');
    assert.equal(rows[0][1], '20×', '10 000 caractères envoyés pour 500 reçus');
    assert.equal(sansEspaces(rows[0][2]), '10000envoyés·500reçus·2appels');
    assert.ok(!rows.some((r) => /stats\.kind/.test(r[0])), 'aucune clé de traduction brute');
  });

  test('le taux de vert par dépôt met le moins vert en tête', async () => {
    const c = carte('Vérifications : taux de vert par dépôt');
    const rows = await c.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    assert.deepEqual(rows, [['grp/alpha', '33 %', '1 verts sur 3'], ['grp/beta', '100 %', '2 verts sur 2']]);
  });

  test('les opérations Git : volume par action, échecs à côté', async () => {
    const c = carte('Opérations Git');
    assert.equal((await c.locator('p.muted').first().textContent()).trim(), '6 opérations · 1 échec');
    const rows = await c.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    assert.deepEqual(rows, [
      ['Supprimer des branches', '3', '1 échec'],
      ['Créer une branche', '2', ''],
      ['Créer un tag', '1', ''],
    ]);
  });

  test('les constats qui reviennent : un titre normalisé, ses fichiers, et le geste « En faire une règle »', async () => {
    const c = carte('Constats qui reviennent');
    const rows = c.locator('tbody tr');
    assert.equal(await rows.count(), 1, '« Le numéro… loggé » et « le numéro… loggé. » ne font qu’un');
    const txt = (await rows.first().textContent()).replace(/\s+/g, ' ');
    assert.match(txt, /grp\/alpha/);
    assert.match(txt, /3 merge requests/);
    const fichiers = await rows.first().locator('.stats-rec-files code').allTextContents();
    assert.deepEqual([...fichiers].sort(), ['src/checkout/card.js', 'src/checkout/pay.js']);
    assert.equal((await rows.first().locator('[data-rec-rule]').textContent()).trim(), 'En faire une règle');
  });

  test('le Top 5 de la forge et la carte d’activité sont chargés à part', async () => {
    const top = await page.$$eval('#dashTop5 tbody tr', (trs) => trs.map((tr) => tr.children[0].textContent.trim()));
    assert.deepEqual(top, ['grp/alpha', 'grp/beta'], 'le commit le plus récent en tête');
    assert.equal(await page.locator('#dashTop5 tbody tr').first().locator('a code').textContent(), 'c0ffee0');
    assert.equal(await page.locator('#dashActivity .pab').count(), 2, 'une barre par dépôt suivi');
  });

  test('chaque carte porte sa question en légende', async () => {
    const aides = await page.$$eval('#dashboard .dash-card', (cs) => cs
      .filter((c) => c.querySelector('h3') && !c.querySelector('h3').textContent.includes('Coût par agent'))
      .map((c) => [c.querySelector('h3').textContent.trim(), !!c.querySelector('.dash-help')]));
    const sans = aides.filter(([, a]) => !a).map(([t]) => t);
    assert.deepEqual(sans, [], `cartes sans légende : ${sans.join(', ')}`);
  });

  /* « Rafraîchir » relit TOUT : une MR arrivée entre-temps doit apparaître sans recharger la
     page — et l'entonnoir la compter. */
  test('« Rafraîchir » relit les chiffres du serveur', async () => {
    seed.insererMr(app.db, donnees.repos['grp/beta'], 9, { titre: 'Arrivée après coup', statut: 'to_review' });
    const avant = await page.locator('#dashboard > .stat-row .stat-tile').first().locator('.stat-val').textContent();
    assert.equal(avant.trim(), '2', 'l’écran n’a pas encore relu');
    await page.locator('#dashRefresh').click();
    await page.waitForFunction(() => {
      const t = document.querySelector('#dashboard > .stat-row .stat-tile .stat-val');
      return t && t.textContent.trim() === '3';
    });
    // Et la ligne beta compte désormais deux MR en attente.
    await page.waitForFunction(() => {
      const b = document.querySelector('#dashboard [data-stat-projet="grp/beta"][data-stat-seg="to_review"]');
      return b && b.textContent.trim() === '2';
    });
    app.db.prepare('DELETE FROM mr WHERE repo_id = ? AND iid = 9').run(donnees.repos['grp/beta']);
    await page.locator('#dashRefresh').click();
    await page.waitForFunction(() => {
      const t = document.querySelector('#dashboard > .stat-row .stat-tile .stat-val');
      return t && t.textContent.trim() === '2';
    });
    await page.waitForSelector('#dashboard [data-rec-rule]');
  });

  /* L'export porte les colonnes du tableau, dans un format qu'Excel ouvre sans question sur un
     poste français : BOM, séparateur « ; », et une cellule contenant « ; » mise entre guillemets. */
  test('« Exporter (CSV) » télécharge le tableau par projet, prêt pour un tableur', async () => {
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#statsExport').click(),
    ]);
    assert.match(dl.suggestedFilename(), /^mergerie-projets-\d{4}-\d{2}-\d{2}\.csv$/);
    const brut = fs.readFileSync(await dl.path(), 'utf8');
    assert.equal(brut.charCodeAt(0), 0xFEFF, 'BOM en tête');
    const lignes = brut.slice(1).trim().split('\n');
    assert.equal(lignes[0], 'Projet;Reviewées;En attente;Note moy.;Pire;Résolution;Tendance');
    assert.deepEqual(lignes.slice(1), ['grp/alpha;3;1;5.5;3.5;75%;-3.5', 'grp/beta;1;1;9;9;;']);
  });

  test('en anglais, l’écran entier change de langue', async () => {
    await page.evaluate(() => localStorage.setItem('aidevtools_lang', 'en'));
    try {
      await page.reload();
      await page.locator('nav button[data-tab="dashboard"]').click();
      await page.waitForSelector('#dashboard [data-rec-rule]');
      const titres = await page.$$eval('#dashboard .dash-card h3', (hs) => hs.map((h) => h.textContent.trim()));
      assert.ok(titres.some((t) => /^Score distribution|^Notes? distribution|distribution/i.test(t)), JSON.stringify(titres));
      assert.ok(!titres.some((t) => /Distribution des notes|Délai de cycle|Constats qui reviennent/.test(t)),
        `aucun titre resté en français : ${JSON.stringify(titres)}`);
      assert.ok(!titres.some((t) => /^stats\./.test(t)), 'aucune clé brute');
      const periode = await page.locator('#dashboard [data-stats-jours]').allTextContents();
      assert.equal(periode.length, 4);
      assert.ok(!periode.includes('tout'), `période traduite (vu ${JSON.stringify(periode)})`);
    } finally {
      await page.evaluate(() => localStorage.setItem('aidevtools_lang', 'fr'));
      await page.reload();
    }
  });
});
