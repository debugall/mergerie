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
    const rapports = app.db.prepare('SELECT mr_id, md_path FROM review ORDER BY mr_id').all();
    rapports.forEach((rv, i) => {
      fs.writeFileSync(rv.md_path, `# Revue\n\nDu texte.\n\n## Note globale\n\n**${NOTES[i % NOTES.length]}/10**\n`, 'utf8');
    });
    /* …et UN rapport sans note du tout. L'IA n'en met pas toujours : ce rapport-là existe, se
       lit, et doit rester atteignable — il sortait de la liste au premier filtre posé. */
    fs.writeFileSync(rapports[rapports.length - 1].md_path, '# Revue\n\nDu texte, et pas de note.\n', 'utf8');

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
       « Rouvrir » selon le stade). C'est l'effet qu'on attend, pas un délai. Elles vivent dans
       le menu « ⋯ », donc repliées : on attend leur PRÉSENCE, pas leur visibilité. */
    await page.waitForSelector('#aDone, #aReopen', { state: 'attached' });
  }

  /* Les actions secondaires du rapport vivent maintenant dans le menu « ⋯ » : trois actions
     seulement restent visibles (ouvrir le code, faire corriger, merger). Les cliquer suppose
     donc d'ouvrir le menu — comme le fait l'utilisateur. */
  async function ouvrirMenuRapport() {
    await page.locator('#aMore').click();
    await page.waitForSelector('#reportDetail .split-menu:not([hidden])');
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

    await ouvrirMenuRapport();
    await page.locator('#aDone').click();
    await page.waitForFunction((n) => document.querySelectorAll('#reportList .card').length === n - 1, avant);
    // Le compteur est rafraîchi à part : on l'attend plutôt que de l'affirmer dans la foulée.
    await page.waitForFunction((n) => new RegExp(`\\b${n}\\b`)
      .test(document.querySelector('[data-seg="reviewed"]').textContent), avant - 1);
    assert.equal(await page.locator('#aReopen').count(), 1, 'le rapport propose maintenant de rouvrir');

    await ouvrirMenuRapport();
    await page.locator('#aReopen').click();
    await page.waitForFunction((n) => document.querySelectorAll('#reportList .card').length === n, avant);
  });

  /* LA LISTE FINIT DE SE POSER AVANT QU'ON LA TOUCHE. Les cartes entrent avec une animation
     (`animate-in`) : leur hauteur, donc `scrollHeight`, grandit encore quelques dizaines de
     millisecondes après que la première carte est apparue. Défiler pendant ce temps, c'est
     défiler une liste qui n'a pas encore sa taille — la molette délivrait 84 px sur une marge
     de 84, puis la marge passait à 628 et l'assertion accusait le défilement.
     On attend donc DEUX mesures identiques de `scrollHeight` à une image d'intervalle. */
  async function attendreListeStable() {
    /* Le prédicat est SYNCHRONE : `waitForFunction` n'attend pas une promesse rendue par le
       prédicat (il la voit comme une valeur vraie et sort aussitôt). La mesure précédente est
       donc mémorisée sur l'élément, et c'est le rythme de sondage de Playwright qui fait
       l'intervalle entre deux relevés. */
    await page.evaluate(() => {
      const l = document.querySelector('#reportSplit .col-list');
      if (l) delete l.dataset.hMesure;              // une liste d'avant ne valide pas celle-ci
    });
    await page.waitForFunction(() => {
      const l = document.querySelector('#reportSplit .col-list');
      if (!l) return false;
      const h = String(l.scrollHeight);
      const stable = l.dataset.hMesure === h;
      l.dataset.hMesure = h;
      return stable;
    });
  }

  /* LE MUR D'ACTIONS. Onze boutons sur trois rangées précédaient la première ligne du rapport :
     à 1280×800 on ne lisait rien sans faire défiler, alors qu'on vient pour LIRE. Et « Merger »
     (irréversible) jouxtait « Supprimer le rapport » (destructif) dans exactement le même rouge. */
  test('le rapport porte trois actions et commence dans le premier écran', async () => {
    await ouvrirStade('reviewed');
    const visibles = await page.evaluate(() => [...document.querySelectorAll(
      '#reportDetail .detail-actions .btn-group > button, #reportDetail .detail-actions .split-menu-wrap > button',
    )].map((b) => b.id));
    assert.deepEqual(visibles, ['aSplit', 'aFix', 'aMerge', 'aMore'],
      `trois actions et le menu, pas onze boutons — vu : ${JSON.stringify(visibles)}`);

    const y = await page.locator('#mdView').evaluate((el) => el.getBoundingClientRect().top);
    const h = await page.evaluate(() => window.innerHeight);
    assert.ok(y < h, `la première ligne du rapport doit être dans l’écran (y=${Math.round(y)}, fenêtre ${h})`);

    // Le menu contient bien le reste, dont la suppression — en dernier, derrière un séparateur.
    await page.locator('#aMore').click();
    await page.waitForSelector('#reportDetail .split-menu:not([hidden])');
    const items = await page.evaluate(() => [...document.querySelectorAll('#reportDetail .split-menu > *')]
      .map((e) => (e.tagName === 'BUTTON' ? (e.id || e.className) : e.className)));
    assert.equal(items[items.length - 1], 'aDelReport', 'la suppression est la dernière du menu');
    assert.equal(items[items.length - 2], 'menu-sep', 'et elle est séparée : on ne la clique pas par inertie');
    await page.keyboard.press('Escape');
  });

  /* AMENER LE CURSEUR SUR LA PARTIE VISIBLE DE LA COLONNE. Viser « le haut de #reportList
     plus 60 px » suppose que ce haut est dans la fenêtre : à 420 px de hauteur il est à
     y=366 et le point visé tombait à 426, hors écran — la molette ne touchait alors aucun
     élément défilable, et le test accusait le défilement. */
  async function curseurSurLaListe() {
    const pt = await page.evaluate(() => {
      const l = document.querySelector('#reportSplit .col-list');
      const r = l.getBoundingClientRect();
      const haut = Math.max(0, r.top);
      const bas = Math.min(window.innerHeight, r.bottom);
      return { x: Math.round(r.left + r.width / 2), y: Math.round((haut + bas) / 2) };
    });
    await page.mouse.move(pt.x, pt.y);
  }

  // Fait tourner la molette AU-DESSUS de la liste et rend compte de ce qui a bougé.
  async function moletteSurLaListe() {
    await attendreListeStable();
    const avant = await page.evaluate(() => ({
      rapport: Math.round(document.querySelector('#reportDetail').getBoundingClientRect().top),
      page: Math.round(window.scrollY),
    }));
    await curseurSurLaListe();
    await page.mouse.wheel(0, 800);
    /* La molette est asynchrone, et elle ne délivre pas ses 800 px d'un coup : on attend que
       le défilement ait ABOUTI — arrivé aux 800 px demandés, ou au bout de la liste s'il y en
       avait moins. `scrollTop > 0` ne suffisait pas : sur un runner lent, le premier cran
       (84 px) satisfaisait l'attente pendant que le reste était encore en route. */
    await page.waitForFunction(() => {
      const l = document.querySelector('#reportSplit .col-list');
      const marge = l.scrollHeight - l.clientHeight;
      return marge <= 2 || l.scrollTop >= Math.min(800, marge) - 1;
    });
    return page.evaluate((av) => {
      const l = document.querySelector('#reportSplit .col-list');
      return {
        liste: Math.round(l.scrollTop),
        marge: Math.round(l.scrollHeight - l.clientHeight),   // ce qu'il y avait à défiler
        rapportBouge: Math.round(document.querySelector('#reportDetail').getBoundingClientRect().top) - av.rapport,
        pageBouge: Math.round(window.scrollY) - av.page,
      };
    }, avant);
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
      /* On mesure ce qui est VÉRIFIABLE : la liste avait de quoi défiler, et elle a défilé de
         tout ce qu'elle pouvait (ou des 800 px demandés si elle en avait davantage). Un seuil
         en dur — « plus de 100 px » — dépendait de la hauteur des cartes, donc de la largeur
         de la colonne : élargir la page d'un onglet suffisait à le faire échouer, sans que
         rien du comportement éprouvé ici n'ait changé. */
      assert.ok(r.marge > 0, 'la liste doit avoir de quoi défiler pour que le test ait un sens');
      assert.ok(r.liste >= Math.min(800, r.marge) - 1,
        `la liste doit défiler pour de bon (vu ${r.liste} px sur ${r.marge} possibles)`);
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

    // Une seule couleur : rien d'autre ne subsiste — « sans note » est une case comme les autres.
    const majoritaire = ['good', 'mid', 'bad'].find((c) => compteurs[c] > 0);
    for (const c of ['good', 'mid', 'bad', 'none']) await cocher(c, c === majoritaire);
    const restant = await notesAffichees();
    assert.ok(restant.length, 'la couleur choisie reste visible');
    assert.deepEqual([...new Set(restant)], [majoritaire], 'et elle seule');

    // Deux couleurs cochées : l'union, pas l'une ou l'autre.
    const seconde = ['good', 'mid', 'bad', 'none'].find((c) => c !== majoritaire && compteurs[c] > 0);
    if (seconde) {
      await cocher(seconde, true);
      const deux = new Set(await notesAffichees());
      assert.deepEqual([...deux].sort(), [majoritaire, seconde].sort(), 'les cases s’additionnent');
    }
  });

  /* UN RAPPORT SANS NOTE N'EST PAS UN RAPPORT ABSENT. L'IA n'en produit pas toujours : la
     carte affiche « — ». Tant que « sans note » n'était pas une case, ces rapports quittaient
     la liste dès qu'on filtrait par couleur, sans compteur ni case pour les rappeler — on les
     croyait perdus, ou jamais reviewés. */
  test('un rapport sans note reste atteignable, et sa case le compte', async () => {
    await ouvrirStade('done');
    // Le test précédent a laissé un filtre posé : le compteur se lit « tout coché », sinon il
    // annonce ce qui apparaîtrait, pas ce qui est affiché.
    for (const c of ['good', 'mid', 'bad', 'none']) await cocher(c, true);
    const compteurs = await page.$$eval('#noteFilters [data-nf-count]',
      (s2) => Object.fromEntries(s2.map((x) => [x.dataset.nfCount, Number(x.textContent)])));
    assert.equal(compteurs.none, (await notesAffichees()).filter((c) => c === 'none').length,
      'la case « sans note » annonce ce qu’elle fera apparaître');
    assert.ok(compteurs.none > 0, 'le décor porte bien un rapport sans note');

    for (const c of ['good', 'mid', 'bad', 'none']) await cocher(c, c === 'none');
    const restant = await notesAffichees();
    assert.deepEqual([...new Set(restant)], ['none'], 'seule la case cochée subsiste');
    assert.equal(restant.length, compteurs.none, 'et tous ceux qu’elle annonçait sont là');

    // Filtrer sur une couleur ne doit PAS faire disparaître les sans-note en silence : ils
    // sont simplement rangés sous leur propre case, qu'on peut cocher avec.
    await cocher('good', true);
    const deux = new Set(await notesAffichees());
    assert.ok(deux.has('none') && deux.has('good'), 'les cases s’additionnent, celle-ci comprise');
    for (const c of ['good', 'mid', 'bad', 'none']) await cocher(c, true);
  });

  test('le choix survit au rechargement, et tout décocher n’enferme personne', async () => {
    await ouvrirStade('done');
    const compteurs = await page.$$eval('#noteFilters [data-nf-count]',
      (s) => Object.fromEntries(s.map((x) => [x.dataset.nfCount, Number(x.textContent)])));
    const garde = ['good', 'mid', 'bad'].find((c) => compteurs[c] > 0);
    for (const c of ['good', 'mid', 'bad', 'none']) await cocher(c, c === garde);
    const avant = await notesAffichees();

    await page.reload();
    await ouvrirStade('done');
    assert.deepEqual(await notesAffichees(), avant, 'le filtre est retrouvé tel quel');
    assert.equal(await page.locator(`#noteFilters input[value="${garde}"]`).isChecked(), true,
      'et les cases le montrent — sinon la liste paraîtrait amputée sans raison');

    /* Décocher la DERNIÈRE case : la liste deviendrait vide et plus aucune case ne
       permettrait de la rouvrir. On revient donc à tout afficher. */
    await cocher('none', false);
    await page.locator(`#noteFilters input[value="${garde}"]`).click();
    // Décocher la dernière remet TOUT : on attend cet effet-là, qui est l'objet du test.
    await page.waitForFunction(() => [...document.querySelectorAll('#noteFilters .note-pick')].every((c) => c.checked));
    const cases = await page.$$eval('#noteFilters .note-pick', (cs) => cs.map((c) => c.checked));
    assert.deepEqual(cases, [true, true, true, true], 'tout revient coché, « sans note » comprise');
    assert.ok((await notesAffichees()).length >= avant.length, 'et la liste entière réapparaît');
  });

  /* Le pendant du test de défilement : arrivé au bas de la liste, la page ne doit pas bouger.
     (L'intention derrière la règle CSS est d'empêcher le chaînage de la molette ; voir la
     limite mesurée, notée dans le corps du test.) */
  test('la fin de la liste n’entraîne pas la page', async () => {
    await toutMarquerTraite(); // idempotent : le test reste jouable seul
    /* FENÊTRE COURTE : pour que « la page ne suit pas » veuille dire quelque chose, il faut
       au moins que la page AIT de quoi défiler — à pleine hauteur elle tient dans l'écran.
       ⚠ Mesuré : même ainsi, retirer `overscroll-behavior: contain` ne fait pas échouer ce
       test. Le chaînage du défilement est une mécanique du compositeur que `mouse.wheel`, qui
       synthétise l'événement, ne déclenche pas en Chromium headless. Ce que ce test prouve
       donc vraiment : la colonne se parcourt jusqu'au bout, et la page reste où elle est.
       La règle CSS, elle, n'a pas de filet automatique — la toucher demande un contrôle à
       l'œil, dans un vrai navigateur. */
    const tailleAvant = page.viewportSize();
    await page.setViewportSize({ width: 1280, height: 420 });
    await ouvrirStade('done');
    await attendreListeStable();   // les cartes entrent en s'animant : la liste grandit encore
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 20),
      'la page doit pouvoir défiler pour que le test ait un sens');
    // Position de départ mesurée, pas supposée : sélectionner une carte peut déjà avoir
    // déplacé la page de quelques pixels. Ce qu'on défend, c'est qu'elle ne bouge PLUS.
    const depart = await page.evaluate(() => Math.round(window.scrollY));
    await curseurSurLaListe();
    /* On descend jusqu'au bout, un cran à la fois, en attendant à chaque tour que le
       défilement SE STABILISE — pas qu'il « ait bougé ». Attendre un mouvement suppose qu'il
       en reste : sur un runner lent, la molette du tour précédent était encore en route quand
       on relevait la position de départ, si bien qu'un tour ne changeait plus rien et que
       l'attente expirait au lieu de constater qu'on était arrivé. */
    const enBas = () => page.evaluate(() => {
      const l = document.querySelector('#reportSplit .col-list');
      return l.scrollTop + l.clientHeight >= l.scrollHeight - 2;
    });
    for (let i = 0; i < 20 && !(await enBas()); i += 1) {
      await page.evaluate(() => {
        const l = document.querySelector('#reportSplit .col-list');
        if (l) delete l.dataset.sMesure;
      });
      await page.mouse.wheel(0, 1200);
      await page.waitForFunction(() => {
        const l = document.querySelector('#reportSplit .col-list');
        const v = String(l.scrollTop);
        const stable = l.dataset.sMesure === v;
        l.dataset.sMesure = v;
        return stable;
      });
    }
    // Et on insiste UNE FOIS DE PLUS, arrivé en bas : c'est ce coup-là qui entraînerait la page.
    await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => {
      const l = document.querySelector('#reportSplit .col-list');
      const v = String(l.scrollTop);
      const stable = l.dataset.sMesure === v;
      l.dataset.sMesure = v;
      return stable;
    });
    const fin = await page.evaluate((d) => {
      const l = document.querySelector('#reportSplit .col-list');
      return { enBas: l.scrollTop + l.clientHeight >= l.scrollHeight - 2, bouge: Math.round(window.scrollY) - d };
    }, depart);
    await page.setViewportSize(tailleAvant);
    assert.ok(fin.enBas, 'la liste a bien été parcourue jusqu’en bas');
    assert.equal(fin.bouge, 0, 'la page n’a pas suivi');
  });

});
