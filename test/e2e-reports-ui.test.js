'use strict';
/* Colonne de gauche et rapport : deux zones de défilement distinctes, dans un VRAI navigateur.
 *
 * Le comportement est entièrement porté par la mise en page (grille, `position: sticky`,
 * `overflow`) : rien à interroger côté serveur. Et c'est exactement le genre de réglage
 * qu'une règle CSS ajoutée ailleurs casse sans bruit — d'où un test qui fait tourner la
 * molette pour de bon et regarde ce qui a bougé.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

describe('Reviews — liste et rapport défilent séparément', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  const NB = 6; // assez de cartes pour que la liste dépasse une fenêtre courte

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    app.state.mrs['grp/app'] = Array.from({ length: NB }, (_, i) => ({
      iid: 100 + i, title: `Merge request de démonstration numéro ${i + 1}`, state: 'opened',
      source_branch: repo.branch, target_branch: 'main',
      web_url: `https://gitlab.test/grp/app/-/merge_requests/${100 + i}`,
      sha: repo.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: repo.mainSha, start_sha: repo.mainSha, head_sha: repo.branchSha },
    }));
    for (let i = 0; i < NB; i++) app.state.changes[`grp/app!${100 + i}`] = [{ new_path: 'src/app.js' }];

    await app.configure();
    await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' });
    await app.api('POST', '/api/discover');
    // Reviewer TOUT : le stade « Reviewées » se remplit, c'est lui qui affiche les deux colonnes.
    for (const m of (await app.api('GET', '/api/mrs')).body) {
      await app.api('POST', `/api/mrs/${m.id}/review`, {});
      await waitForJobs(app.api);
    }
    /* L'agent en dry-run rend le MÊME rapport pour toutes : une seule couleur, donc rien à
       filtrer. On réécrit les rapports avec des notes étalées sur les trois tranches.
       La note est relue du FICHIER à chaque appel (`extractNote`), pas stockée : réécrire
       suffit, et on exerce au passage le vrai chemin d'extraction. */
    const NOTES = ['9,1', '7,5', '6,0', '4,2', '3,3', '1,8']; // 2 vertes, 2 oranges, 2 rouges
    app.db.prepare('SELECT mr_id, md_path FROM review ORDER BY mr_id').all().forEach((rv, i) => {
      fs.writeFileSync(rv.md_path, `# Revue\n\nDu texte.\n\n## Note globale\n\n**${NOTES[i % NOTES.length]}/10**\n`, 'utf8');
    });

    navigateur = await chromium.launch();
    // Fenêtre volontairement courte : sans elle, la liste tiendrait à l'écran et il n'y
    // aurait rien à faire défiler — le test passerait sans rien prouver.
    page = await navigateur.newPage({ viewport: { width: 1440, height: 520 } });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  // Ouvre un stade et sélectionne son premier rapport, pour que la colonne de droite soit pleine.
  async function ouvrirStade(seg) {
    await page.locator(`[data-seg="${seg}"]`).click();
    await page.waitForSelector('#reportSplit:not([hidden]) #reportList .card');
    await page.locator('#reportList .card').first().click();
    /* Le rapport de droite est chargé : ses actions n'existent que là (« Marquer traitée » ou
       « Rouvrir » selon le stade). C'est l'effet qu'on attend, pas un délai. */
    await page.waitForSelector('#aDone, #aReopen');
  }

  /* MARQUER TRAITÉE FAIT CHANGER DE STADE : la MR quitte « Reviewées » pour « Traitées ». Le
     bouton du rapport ne rafraîchissait que le panneau de droite — la carte restait dans une
     liste où elle n'avait plus sa place, et le compteur du segment mentait jusqu'au prochain
     rechargement. Le même geste depuis la file « À traiter » mettait déjà la liste à jour. */
  test('« Marquer traitée » retire la carte de la liste, et « Rouvrir » la ramène', async () => {
    /* EN PREMIER dans ce fichier, et il rend ce qu'il a pris. Les tests suivants filtrent par
       note et mémorisent leur choix : les laisser passer d'abord ferait observer un retrait de
       carte dans une liste déjà réduite par un filtre — et l'on ne saurait plus qui l'a retirée. */
    await ouvrirStade('reviewed');
    const cartes = () => page.locator('#reportList .card').count();
    const avant = await cartes();
    assert.ok(avant >= 2, 'il faut de quoi observer un retrait');

    await page.locator('#aDone').click();
    await page.waitForFunction((n) => document.querySelectorAll('#reportList .card').length === n - 1, avant);
    // Le compteur est rafraîchi à part : on l'attend plutôt que de l'affirmer dans la foulée.
    await page.waitForFunction((n) => new RegExp(`\\b${n}\\b`)
      .test(document.querySelector('[data-seg="reviewed"]').textContent), avant - 1);
    assert.equal(await page.locator('#aReopen').count(), 1, 'le rapport propose maintenant de rouvrir');

    await page.locator('#aReopen').click();
    await page.waitForFunction((n) => document.querySelectorAll('#reportList .card').length === n, avant);
  });

  // Fait tourner la molette AU-DESSUS de la liste et rend compte de ce qui a bougé.
  async function moletteSurLaListe() {
    const avant = await page.evaluate(() => ({
      rapport: Math.round(document.querySelector('#reportDetail').getBoundingClientRect().top),
      page: Math.round(window.scrollY),
    }));
    const boite = await page.locator('#reportList').boundingBox();
    await page.mouse.move(boite.x + boite.width / 2, boite.y + 60);
    await page.mouse.wheel(0, 800);
    /* La molette est asynchrone : on attend que le défilement ait ABOUTI (la liste a bougé, ou
       elle est déjà au bout — c'est le cas que le test d'à côté éprouve), pas un délai fixe. */
    await page.waitForFunction(() => {
      const l = document.querySelector('#reportSplit .col-list');
      return l.scrollTop > 0 || l.scrollHeight <= l.clientHeight + 2;
    });
    return page.evaluate((av) => ({
      liste: Math.round(document.querySelector('#reportSplit .col-list').scrollTop),
      rapportBouge: Math.round(document.querySelector('#reportDetail').getBoundingClientRect().top) - av.rapport,
      pageBouge: Math.round(window.scrollY) - av.page,
    }), avant);
  }

  /* Marquer les rapports « traités » les fait passer du premier stade au second : les tests
     qui suivent portent donc sur « Traitées ». C'est aussi ce qui impose l'ordre du fichier —
     le stade « Reviewées » se vide dès qu'on a marqué. */
  async function toutMarquerTraite() {
    for (const m of (await app.api('GET', '/api/mrs')).body) await app.api('POST', `/api/mrs/${m.id}/done`, {});
    await page.reload();
  }

  for (const [seg, libelle] of [['reviewed', 'Reviewées'], ['done', 'Traitées']]) {
    test(`« ${libelle} » : la liste défile seule, le rapport reste en place`, async () => {
      if (seg === 'done') await toutMarquerTraite();
      await ouvrirStade(seg);
      const r = await moletteSurLaListe();
      assert.ok(r.liste > 100, `la liste doit défirer pour de bon (vu ${r.liste} px)`);
      assert.equal(r.rapportBouge, 0, 'le rapport ne doit pas bouger d’un pixel');
      assert.equal(r.pageBouge, 0, 'et la page non plus');
    });
  }

  /* ---- Filtre par couleur de note ----
     Trois cases indépendantes au-dessus de la liste. Ce qui compte : elles se combinent,
     l'état survit au rechargement, et il reste toujours un chemin de retour vers la liste
     entière — un filtre sans issue est pire que pas de filtre. */
  const notesAffichees = () => page.$$eval('#reportList .card .note',
    (ns) => ns.map((n) => n.className.replace('note ', '').trim()));

  /* Le filtre s'applique DANS le gestionnaire (rendu synchrone) : ce qu'on attend, c'est que la
     case porte l'état voulu — un rendu qui l'aurait remplacée nous ferait lire l'ancienne. Et
     décocher la DERNIÈRE remet tout coché : c'est voulu, on l'accepte au lieu de l'attendre. */
  const cocher = async (couleur, veut) => {
    const c = page.locator(`#noteFilters input[value="${couleur}"]`);
    if ((await c.isChecked()) !== veut) await c.click();
    await page.waitForFunction(({ v, w }) => {
      const el = document.querySelector(`#noteFilters input[value="${v}"]`);
      if (!el) return false;
      if (w) return el.checked;
      return !el.checked || [...document.querySelectorAll('#noteFilters .note-pick')].every((x) => x.checked);
    }, { v: couleur, w: veut });
  };

  test('les cases de note se combinent, et le compteur annonce ce qu’on verra', async () => {
    await toutMarquerTraite();
    await ouvrirStade('done');

    const toutes = await notesAffichees();
    assert.ok(toutes.length >= 2, 'il faut plusieurs rapports pour que le filtre ait un sens');
    const compteurs = await page.$$eval('#noteFilters [data-nf-count]',
      (s) => Object.fromEntries(s.map((x) => [x.dataset.nfCount, Number(x.textContent)])));
    for (const couleur of ['good', 'mid', 'bad']) {
      assert.equal(compteurs[couleur], toutes.filter((c) => c === couleur).length,
        `le compteur ${couleur} doit annoncer ce que la case fera apparaître`);
    }

    // Une seule couleur : rien d'autre ne subsiste.
    const majoritaire = ['good', 'mid', 'bad'].find((c) => compteurs[c] > 0);
    for (const c of ['good', 'mid', 'bad']) await cocher(c, c === majoritaire);
    const restant = await notesAffichees();
    assert.ok(restant.length, 'la couleur choisie reste visible');
    assert.deepEqual([...new Set(restant)], [majoritaire], 'et elle seule');

    // Deux couleurs cochées : l'union, pas l'une ou l'autre.
    const seconde = ['good', 'mid', 'bad'].find((c) => c !== majoritaire && compteurs[c] > 0);
    if (seconde) {
      await cocher(seconde, true);
      const deux = new Set(await notesAffichees());
      assert.deepEqual([...deux].sort(), [majoritaire, seconde].sort(), 'les cases s’additionnent');
    }
  });

  test('le choix survit au rechargement, et tout décocher n’enferme personne', async () => {
    await ouvrirStade('done');
    const compteurs = await page.$$eval('#noteFilters [data-nf-count]',
      (s) => Object.fromEntries(s.map((x) => [x.dataset.nfCount, Number(x.textContent)])));
    const garde = ['good', 'mid', 'bad'].find((c) => compteurs[c] > 0);
    for (const c of ['good', 'mid', 'bad']) await cocher(c, c === garde);
    const avant = await notesAffichees();

    await page.reload();
    await ouvrirStade('done');
    assert.deepEqual(await notesAffichees(), avant, 'le filtre est retrouvé tel quel');
    assert.equal(await page.locator(`#noteFilters input[value="${garde}"]`).isChecked(), true,
      'et les cases le montrent — sinon la liste paraîtrait amputée sans raison');

    /* Décocher la DERNIÈRE case : la liste deviendrait vide et plus aucune case ne
       permettrait de la rouvrir. On revient donc à tout afficher. */
    await page.locator(`#noteFilters input[value="${garde}"]`).click();
    // Décocher la dernière remet TOUT : on attend cet effet-là, qui est l'objet du test.
    await page.waitForFunction(() => [...document.querySelectorAll('#noteFilters .note-pick')].every((c) => c.checked));
    const cases = await page.$$eval('#noteFilters .note-pick', (cs) => cs.map((c) => c.checked));
    assert.deepEqual(cases, [true, true, true], 'tout revient coché');
    assert.ok((await notesAffichees()).length >= avant.length, 'et la liste entière réapparaît');
  });

  /* Le pendant du test de défilement : arrivé au bas de la liste, la molette ne doit pas
     enchaîner sur la page. Sans `overscroll-behavior`, l'écran se met à glisser au moment
     précis où on croit encore parcourir la liste. */
  test('la fin de la liste n’entraîne pas la page', async () => {
    await toutMarquerTraite(); // idempotent : le test reste jouable seul
    await ouvrirStade('done');
    // Position de départ mesurée, pas supposée : sélectionner une carte peut déjà avoir
    // déplacé la page de quelques pixels. Ce qu'on défend, c'est qu'elle ne bouge PLUS.
    const depart = await page.evaluate(() => Math.round(window.scrollY));
    const boite = await page.locator('#reportList').boundingBox();
    await page.mouse.move(boite.x + boite.width / 2, boite.y + 60);
    /* Six coups de molette, chacun ATTENDU : on veut atteindre le bas de la liste, et une
       molette lancée avant que la précédente n'ait pris ne défile pas deux fois. */
    for (let i = 0; i < 6; i += 1) {
      const avantTour = await page.evaluate(() => document.querySelector('#reportSplit .col-list').scrollTop);
      await page.mouse.wheel(0, 1200);
      await page.waitForFunction((av) => {
        const l = document.querySelector('#reportSplit .col-list');
        return l.scrollTop !== av || l.scrollTop + l.clientHeight >= l.scrollHeight - 2;
      }, avantTour);
    }
    const fin = await page.evaluate((d) => {
      const l = document.querySelector('#reportSplit .col-list');
      return { enBas: l.scrollTop + l.clientHeight >= l.scrollHeight - 2, bouge: Math.round(window.scrollY) - d };
    }, depart);
    assert.ok(fin.enBas, 'la liste a bien été parcourue jusqu’en bas');
    assert.equal(fin.bouge, 0, 'la page n’a pas suivi');
  });

});
