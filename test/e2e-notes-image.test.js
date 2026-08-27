'use strict';
/* COLLER UNE CAPTURE DANS UNE PAGE DE NOTES.
 *
 * Une page de notes sert à consigner ce qu'on vient de voir — et ce qu'on vient de voir est
 * souvent à l'écran. Le geste attendu est donc : Ctrl+V dans l'éditeur.
 *
 * Ce qui se joue :
 *
 *   1. l'image part sur le DISQUE et la page ne garde qu'un lien. Mettre la capture en base64
 *      dans le contenu gonflerait la ligne de plusieurs mégaoctets, renvoyés en entier à
 *      chaque sauvegarde automatique — c'est-à-dire toutes les secondes pendant qu'on écrit ;
 *   2. le lien est inséré AU CURSEUR, sur sa propre ligne, et l'aperçu affiche l'image ;
 *   3. le rendu n'accepte QUE nos URL : une adresse écrite à la main dans le texte reste du
 *      texte, sinon un `![](javascript:…)` ou un pixel espion chez un tiers passerait ;
 *   4. supprimer la page emporte les fichiers — sinon le dossier de données enfle sans fin.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

// 32×32, quelques dizaines d'octets : ce qui compte est le chemin qu'elle suit.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOUlEQVR42u3OMQEAAAgDoJnc6BpjDyRgcrfTFRAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQPBvHkK7AAFPGdF3AAAAAElFTkSuQmCC';

describe('Captures dans une page de notes', () => {
  let app;

  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { await app.stop(); });

  const creerPage = async (titre) => (await app.api('POST', '/api/notes', { title: titre })).body;

  // Attend qu'une condition côté SERVEUR devienne vraie (sauvegarde automatique : ~1 s).
  async function attendre(cond, quoi, ms = 10000) {
    const fin = Date.now() + ms;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > fin) throw new Error(`délai dépassé : ${quoi}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  test('une capture est enregistrée sur disque et rendue par une URL à nous', async () => {
    const page = await creerPage('Bug du tunnel');
    const { status, body } = await app.api('POST', `/api/notes/${page.id}/images`, { image: PNG });
    assert.equal(status, 200);
    assert.equal(body.url, `/api/notes/${page.id}/images/${body.id}`,
      'l’URL est celle que le rendu accepte — le contenu de la page ne porte qu’un lien');

    const ligne = app.db.prepare('SELECT * FROM note_image WHERE id = ?').get(body.id);
    assert.equal(ligne.page_id, page.id);
    assert.ok(fs.existsSync(ligne.path), 'le fichier existe vraiment');
    assert.ok(fs.statSync(ligne.path).size > 0);

    const servi = await app.api('GET', body.url);
    assert.equal(servi.status, 200);
    assert.equal(servi.headers.get('content-type'), 'image/png');
  });

  test('une capture d’une AUTRE page n’est pas servie par ce chemin', async () => {
    const a = await creerPage('Page A');
    const b = await creerPage('Page B');
    const { body: img } = await app.api('POST', `/api/notes/${a.id}/images`, { image: PNG });
    // Le même identifiant d'image, demandé sous une autre page : introuvable, pas servi.
    assert.equal((await app.api('GET', `/api/notes/${b.id}/images/${img.id}`)).status, 404);
    assert.equal((await app.api('GET', `/api/notes/${a.id}/images/999999`)).status, 404);
  });

  test('une image invalide est refusée', async () => {
    const page = await creerPage('Page C');
    assert.equal((await app.api('POST', `/api/notes/${page.id}/images`, { image: 'coucou' })).status, 400);
    assert.equal((await app.api('POST', '/api/notes/999999/images', { image: PNG })).status, 404);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM note_image WHERE page_id = ?').get(page.id).c, 0);
  });

  /* Une page supprimée emporte ses lignes par cascade — mais les FICHIERS resteraient sur le
     disque, invisibles et pour toujours. */
  test('supprimer la page efface aussi ses fichiers', async () => {
    const page = await creerPage('Page à jeter');
    const { body: img } = await app.api('POST', `/api/notes/${page.id}/images`, { image: PNG });
    const chemin = app.db.prepare('SELECT path FROM note_image WHERE id = ?').get(img.id).path;
    assert.ok(fs.existsSync(chemin));

    assert.equal((await app.api('DELETE', `/api/notes/${page.id}`)).status, 200);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM note_image WHERE page_id = ?').get(page.id).c, 0);
    assert.ok(!fs.existsSync(chemin), 'le fichier ne survit pas à la page');
    assert.ok(!fs.existsSync(path.dirname(chemin)), 'ni son dossier');
  });

  describe('l’écran', { skip: navigateurDispo().dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page; const erreurs = [];
    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="notes"]').click();
      await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    const coller = () => page.evaluate((dataUrl) => {
      const bin = atob(dataUrl.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], 'capture.png', { type: 'image/png' }));
      document.querySelector('#pageContent').dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, PNG);

    /* Le chargement de l'image n'est pas le rendu de la balise : `waitForSelector` rend la
       main dès que le `<img>` existe, réseau non fait. On attend donc le DÉCODAGE — sinon
       `naturalWidth` vaut 0 sur une machine lente, et l'échec accuse la route qui sert le
       fichier alors qu'elle n'a simplement pas fini. */
    const chargee = (sel) => page.waitForFunction((s) => {
      const im = document.querySelector(s);
      return !!im && im.complete && im.naturalWidth > 0;
    }, sel);

    test('coller dans une page neuve insère le lien au curseur et affiche l’image', async () => {
      await page.locator('#pageNew').click();
      await page.waitForSelector('#pageContent');
      await page.locator('#pageContent').fill('Avant.\n\nAprès.');
      /* Curseur juste après « Avant. » (6 caractères) : la capture s'insère LÀ, pas à la fin
         du document — et sur sa propre ligne, sinon elle couperait le paragraphe au rendu. */
      await page.locator('#pageContent').evaluate((el) => { el.focus(); el.setSelectionRange(6, 6); });
      await coller();
      await page.waitForSelector('#pagePreview .note-inline-img');

      const md = await page.locator('#pageContent').inputValue();
      assert.match(md, /^Avant\.\n\n!\[[^\]]*\]\(\/api\/notes\/\d+\/images\/\d+\)\n\n\nAprès\.$/,
        `le lien est inséré au curseur, sur sa propre ligne : ${JSON.stringify(md)}`);
      assert.ok(!md.includes('base64'), 'le contenu de la page ne porte PAS l’image elle-même');

      await chargee('#pagePreview .note-inline-img');
      const img = page.locator('#pagePreview .note-inline-img');
      assert.equal(await img.evaluate((e) => e.naturalWidth), 32, 'l’image est bien chargée depuis le serveur');

      /* Et elle survit. On attend que la SAUVEGARDE AUTOMATIQUE ait vraiment écrit — la
         mention à l'écran passe par « enregistrement… » avant « enregistré », et recharger
         entre les deux emporte le minuteur en attente : c'est la base qu'on interroge. */
      const idPage = (await app.api('GET', '/api/notes')).body.pages
        .find((x) => x.title === 'Nouvelle page').id;   // la liste ne porte que titre et dates
      await attendre(async () => {
        const p2 = (await app.api('GET', `/api/notes/${idPage}`)).body;
        return /\/images\/\d+/.test(p2.content || '');
      }, 'la page enregistrée porte le lien de la capture');
      await page.reload();
      await page.locator('nav button[data-tab="notes"]').click();
      await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
      await page.locator('#pageList .note-item').first().click();
      await chargee('#pagePreview .note-inline-img');
      assert.equal(await page.locator('#pagePreview .note-inline-img').evaluate((e) => e.naturalWidth), 32);
      assert.deepEqual(erreurs, []);
    });

    /* Le rendu ne fabrique une image QUE depuis nos URL. Sans cette borne, une page de notes
       deviendrait un endroit où l'on colle une adresse qui appelle un serveur tiers. */
    test('une adresse écrite à la main ne devient pas une image', async () => {
      await page.locator('#pageNew').click();
      /* « Nouvelle page » crée la page, recharge la liste, PUIS réécrit l'éditeur. Le
         `#pageContent` qu'on trouve dans l'intervalle est encore celui de la page PRÉCÉDENTE :
         ce qu'on y écrit part avec lui au rendu suivant, et l'aperçu ne montre alors jamais ce
         qu'on croit y avoir tapé. On attend donc l'éditeur de la page NEUVE — reconnaissable à
         son contenu vide, là où celui d'avant porte la capture du test précédent. */
      await page.waitForFunction(() => {
        const t = document.querySelector('#pageContent');
        return !!t && t.value === '';
      });
      await page.locator('#pageContent').fill('![x](https://ailleurs.example/pixel.png)\n\n![y](javascript:alert(1))');
      // Ce qu'on tape doit avoir ATTERRI : sinon l'échec accuserait le rendu au lieu du champ.
      await page.waitForFunction(() => (document.querySelector('#pageContent') || {}).value.includes('ailleurs.example'));
      await page.waitForFunction(() => document.querySelector('#pagePreview').textContent.includes('ailleurs.example'));
      assert.equal(await page.locator('#pagePreview img').count(), 0,
        'aucune image : ni le tiers, ni le javascript:');
      assert.deepEqual(erreurs, []);
    });
  });
});
