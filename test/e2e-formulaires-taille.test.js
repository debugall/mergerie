'use strict';
/* LA TAILLE DES CHAMPS DE SAISIE, MESURÉE.
 *
 * Le défaut est banal et invisible en relecture de code : un champ fabriqué en JavaScript hors
 * d'un `.form` ne reçoit AUCUN style. Le navigateur lui en donne un — 21 px de haut, 1 px de
 * marge intérieure, la police du système — à côté de champs de 38 px, dans la même boîte. On
 * l'a eu sur les adresses par environnement d'un service (où l'on saisit une URL), sur le
 * libellé d'une règle de review, sur la réponse libre à une question de l'agent.
 *
 * Aucune revue de code ne l'attrape : le HTML est correct, la CSS est correcte, c'est leur
 * rencontre qui manque. Il se MESURE, dans un navigateur, et c'est ce que fait ce fichier.
 *
 * Le seuil de 34 px n'est pas un idéal esthétique : c'est la hauteur des champs normaux de
 * l'application (38 px), moins la marge de ceux qui vivent dans une barre d'outils.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
/* DEUX PLANCHERS, POUR DEUX QUESTIONS DIFFÉRENTES.
   - `PLANCHER` répond à « ce champ a-t-il été habillé ? ». Le champ nu du navigateur fait
     21 px ; les champs volontairement compacts de l'outil (un pied de modale, une barre
     d'outils) tiennent à 33-34. En dessous de 30, personne n'a choisi : c'est un oubli.
   - `CHAMP_FORME` est la hauteur d'un vrai champ de formulaire, celle qu'on attend là où l'on
     saisit une valeur — 38 px, moins un pixel de tolérance de rendu. */
const PLANCHER = 30;
const CHAMP_FORME = 34;
const MINI_URL = 240;     // largeur plancher du champ où l'on saisit une URL

describe('Champs de saisie — taille', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let env;

  before(async () => {
    app = await startApp();
    await app.configure();
    /* SIX environnements : c'est le nombre que l'outil annonce lui-même, et c'est là que la
       grille serre — chaque colonne tombe à 190 px, dont l'éditeur d'une case héritait. */
    env = (await app.api('POST', '/api/environments', { name: 'local', color: '#8b97ad' })).body;
    for (const n of ['dev', 'preprod', 'staging', 'qualif', 'prod']) {
      await app.api('POST', '/api/environments', { name: n, color: '#2f6fe0' });
    }
    const svc = (await app.api('POST', '/api/services', { name: 'api-core', tags: 'backend' })).body;
    await app.api('PUT', `/api/services/${svc.id}/urls`, { environment_id: env.id, url: 'https://api-local.demo.invalid/health' });
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="links"]');
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* --------------------------------------------------- toutes les modales ---- */

  test('aucun champ de modale ne tombe sur le champ par défaut du navigateur', async () => {
    /* On les ouvre TOUTES, y compris celles qu'aucun autre test n'ouvre : c'est exactement là
       que le défaut se cache, dans la modale qu'on regarde une fois par an. */
    const petits = await page.evaluate((mini) => {
      const out = [];
      for (const m of document.querySelectorAll('.modal')) {
        const boite = m.querySelector('.modal-box');
        if (!boite) continue;
        const etait = m.hidden;
        m.hidden = false;
        for (const el of m.querySelectorAll('input, textarea, select')) {
          const t = (el.type || el.tagName).toLowerCase();
          if (['checkbox', 'radio', 'hidden'].includes(t)) continue;
          const r = el.getBoundingClientRect();
          if (!r.height) continue;                       // dans un bloc replié : invisible
          if (r.height < mini) out.push(`${m.id} · ${el.id || el.className || t} · ${Math.round(r.height)}px`);
        }
        m.hidden = etait;
      }
      return out;
    }, PLANCHER);
    assert.deepEqual(petits, [], `champs trop bas : ${petits.join(' | ')}`);
  });

  /* ------------------------------------------------- les lignes fabriquées ---- */

  test('les adresses par environnement d’un service sont des champs, pas des lignes de texte', async () => {
    await page.locator('nav button[data-tab="links"]').click();
    await page.waitForSelector('#linkGrid .link-grid');
    await page.locator('#linkGrid [data-editservice]').first().click();
    await page.waitForSelector('#serviceModal:not([hidden])');
    /* Une ligne par environnement, fabriquée à l'ouverture : c'est le cas qui a motivé ce
       fichier — ces champs faisaient 21 px de haut sous un « Nom » de 38. */
    await page.waitForFunction(() => document.querySelectorAll('#serviceUrlsList input').length === 6);
    const tailles = await page.locator('#serviceUrlsList input')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    assert.ok(tailles.every((h) => h >= CHAMP_FORME), `hauteurs : ${tailles.join(', ')}`);
    // Et le formulaire d'ajout d'un lien contextuel, qui vit dans la même modale.
    const ctx = await page.locator('#ctxLabel').evaluate((e) => Math.round(e.getBoundingClientRect().height));
    assert.ok(ctx >= CHAMP_FORME, `le champ « libellé » d’un lien contextuel fait ${ctx}px`);
    await page.locator('#serviceCancel').click();
  });

  /* ------------------------------------------- l'éditeur d'une case de grille ---- */

  /* LE CAS QUI A DÉCLENCHÉ TOUT ÇA. L'éditeur vit dans la case — c'est le geste à un clic de
     l'onglet, et il doit le rester — mais une case de grille fait 190 px à six environnements.
     Le champ d'URL en faisait 90 : on y collait une adresse de soixante caractères. */
  for (const largeur of [1280, 1400, 1680]) {
    test(`l’éditeur d’une case reste lisible et dans l’écran (${largeur}px)`, async () => {
      await page.setViewportSize({ width: largeur, height: 950 });
      await page.locator('nav button[data-tab="links"]').click();
      await page.waitForSelector('#linkGrid .link-grid');
      await page.locator('#linkGrid .link-add').first().click();
      await page.waitForSelector('.link-cell-edit');
      const m = await page.evaluate(() => {
        const p = document.querySelector('.link-cell-edit').getBoundingClientRect();
        const u = document.querySelector('.lce-url').getBoundingClientRect();
        return {
          url: Math.round(u.width), hauteurUrl: Math.round(u.height),
          dedans: p.left >= 0 && p.right <= window.innerWidth && p.top >= 0 && p.bottom <= window.innerHeight,
          bords: `${Math.round(p.left)}…${Math.round(p.right)} / ${window.innerWidth}`,
        };
      });
      assert.ok(m.url >= MINI_URL, `le champ d’URL fait ${m.url}px de large`);
      assert.ok(m.hauteurUrl >= CHAMP_FORME, `le champ d’URL fait ${m.hauteurUrl}px de haut`);
      assert.ok(m.dedans, `le panneau sort de l’écran : ${m.bords}`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.link-cell-edit', { state: 'detached' });
    });
  }

  test('sur la dernière colonne, le panneau se recale au lieu de sortir à droite', async () => {
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.locator('nav button[data-tab="links"]').click();
    await page.waitForSelector('#linkGrid .link-grid');
    // La dernière case de la première ligne : celle dont le bord droit touche celui de la grille.
    await page.locator('#linkGrid tbody tr').first().locator('td.link-cell').last()
      .locator('.link-add, .link-edit').first()
      .click({ force: true });
    await page.waitForSelector('.link-cell-edit');
    const ok = await page.evaluate(() => {
      const p = document.querySelector('.link-cell-edit').getBoundingClientRect();
      return { dedans: p.right <= window.innerWidth, droite: Math.round(p.right), ecran: window.innerWidth };
    });
    assert.ok(ok.dedans, `le panneau dépasse : bord droit ${ok.droite} pour ${ok.ecran}px d’écran`);
    await page.keyboard.press('Escape');
  });

  test('une case en édition se voit, et garde ce qu’elle contenait', async () => {
    await page.locator('nav button[data-tab="links"]').click();
    await page.waitForSelector('#linkGrid .link-grid');
    /* Le panneau S'AJOUTE à la case : en la remplaçant, on faisait disparaître l'adresse qu'on
       venait ouvrir pour la corriger — et la ligne se rétractait sous l'éditeur. */
    const cell = page.locator('#linkGrid td.link-cell').filter({ has: page.locator('.link-open') }).first();
    await cell.hover();
    await cell.locator('.link-edit').click();
    await page.waitForSelector('.link-cell-edit');
    assert.equal(await cell.locator('.link-open').count(), 1, 'l’adresse reste affichée sous l’éditeur');
    assert.ok(await cell.evaluate((e) => e.classList.contains('en-edition')), 'la case en cours d’édition se souligne');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.link-cell-edit', { state: 'detached' });
  });
});
