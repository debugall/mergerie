'use strict';
/* Fermeture des modales au clic sur le fond — dans un VRAI navigateur.
 *
 * Ce comportement ne se teste pas autrement : il repose sur la façon dont le moteur
 * fabrique l'événement `click` (émis sur l'ancêtre commun du mousedown et du mouseup).
 * Le simuler à la main reviendrait à tester ma propre idée du DOM, pas le DOM — or c'est
 * précisément cette idée qui était fausse et qui faisait perdre des saisies.
 *
 * Chromium vient de la dépendance de développement `playwright`. S'il n'a jamais été
 * téléchargé (`npx playwright install chromium`), le fichier se déclare ignoré plutôt que
 * de faire échouer la suite sur une machine qui n'a pas encore l'outillage vidéo.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

/* Une attente d'écran généreuse. Ces suites tournent à plusieurs sur un runner CI de
   quatre cœurs : un délai calibré sur une machine de développement y échoue sans que rien
   ne soit cassé, et l'échec du premier test entraîne tous les suivants qui dépendent de
   son état. Mieux vaut attendre longtemps pour rien que rendre un rouge qui ne veut rien dire. */
const ATTENTE_ECRAN = 20000;

describe('Modales : le clic sur le fond', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(app.base);
    await page.waitForFunction(() => typeof window.openTaskModal === 'function');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrir = async () => {
    // On repart d'une modale fermée : dans l'application on ne « rouvre » jamais une modale
    // déjà à l'écran, et c'est la fermeture qui remet le drapeau de saisie à zéro.
    await page.evaluate(() => window.closeTaskModal());
    await page.evaluate(() => window.openTaskModal('code'));
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForFunction(() => !document.querySelector('#taskModal').dataset.saisi);
  };
  const ouverte = () => page.evaluate(() => !document.querySelector('#taskModal').hidden);
  // Le fond est le seul endroit cliquable hors de la boîte : la modale occupe tout l'écran.
  const coinDuFond = async () => {
    const b = await page.locator('#taskModal .modal-box').boundingBox();
    return { x: Math.max(8, b.x / 2), y: 40 };
  };
  const ecrire = async (texte) => {
    await page.locator('#taskModal textarea[name="prompt"]').fill(texte);
    // `fill` passe par les vrais événements ; on s'assure que le drapeau est bien levé.
    await page.waitForFunction(() => document.querySelector('#taskModal').dataset.saisi === '1');
  };

  test('un clic franc sur le fond ferme une modale intacte', async () => {
    await ouvrir();
    const { x, y } = await coinDuFond();
    await page.mouse.click(x, y);
    assert.equal(await ouverte(), false, 'ouvrir puis renoncer doit rester un geste rapide');
  });

  /* LE bug d'origine. Sélectionner du texte dans le prompt et relâcher hors du champ
     émet un `click` dont la cible est le fond : la modale se fermait, la saisie était
     perdue, et l'utilisateur n'avait pourtant pas cliqué à côté. */
  // Le geste : presser DANS la boîte, relâcher sur le fond.
  const tirerVersLeFond = async (depuis) => {
    const b = await page.locator(depuis).boundingBox();
    const { x, y } = await coinDuFond();
    await page.mouse.move(b.x + b.width - 12, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 }); // le geste sort de la boîte
    await page.mouse.up();
  };

  /* Sur une modale INTACTE — donc sans que le refus de perdre une saisie n'entre en jeu :
     seule la garde « la pression a-t-elle commencé sur le fond ? » tient ici. */
  test('une sélection de texte relâchée sur le fond ne ferme rien', async () => {
    await ouvrir();
    await tirerVersLeFond('#taskModalTitle');
    assert.equal(await ouverte(), true, 'la pression a commencé DANS la modale : ce n’est pas un clic à côté');
  });

  test('…et la saisie survit au même geste depuis le champ de prompt', async () => {
    await ouvrir();
    await ecrire('un prompt qu’on ne veut surtout pas perdre');
    await tirerVersLeFond('#taskModal textarea[name="prompt"]');
    assert.equal(await ouverte(), true);
    assert.equal(await page.inputValue('#taskModal textarea[name="prompt"]'), 'un prompt qu’on ne veut surtout pas perdre');
  });

  test('un clic à côté n’emporte pas une saisie : la modale se signale et reste', async () => {
    await ouvrir();
    await ecrire('deux jours de réflexion');
    const { x, y } = await coinDuFond();
    await page.mouse.click(x, y);

    assert.equal(await ouverte(), true);
    // La pulsation dit que le clic a bien été reçu — sans elle, la modale paraîtrait figée.
    assert.equal(await page.locator('#taskModal .modal-box.modal-refus').count(), 1);
    // …et le message rappelle comment fermer pour de bon.
    await page.locator('#toasts .toast-msg', { hasText: 'Échap' }).first().waitFor({ state: 'visible' });
  });

  test('Échap et Annuler ferment, saisie ou pas : le refus ne piège personne', async () => {
    await ouvrir();
    await ecrire('à jeter');
    await page.keyboard.press('Escape');
    assert.equal(await ouverte(), false, 'Échap est un geste délibéré, lui');

    await ouvrir();
    await ecrire('à jeter aussi');
    await page.locator('#taskCancel').click();
    assert.equal(await ouverte(), false);
  });

  test('filtrer une liste ne compte pas comme une saisie', async () => {
    await ouvrir();
    const combo = page.locator('#taskModal .cb-search').first();
    if (await combo.count()) {
      await combo.fill('proj');
      await page.locator('#taskModalTitle').click(); // sort du combo sans rien choisir
    }
    const { x, y } = await coinDuFond();
    await page.mouse.click(x, y);
    assert.equal(await ouverte(), false, 'chercher n’est pas saisir : la modale reste refermable d’un clic');
  });

  /* L'ERREUR SE LIT AU-DESSUS DE CE QUI L'A CAUSÉE. Une erreur naît le plus souvent DANS une
     modale — c'est là qu'on valide un formulaire. Sous la modale, le message se produisait
     derrière elle : on voyait un formulaire qui refuse sans jamais lire pourquoi, et le bouton
     « Copier » restait hors d'atteinte. Un `z-index` ne se relit pas, il se mesure : on demande
     au navigateur QUI est réellement au point où s'affiche le toast. */
  test('un message d’erreur reste lisible et cliquable par-dessus une modale', async () => {
    await ouvrir();
    await page.evaluate(() => window.toast('échec de la chose', true));
    const t = page.locator('#toasts .toast.err').last();
    await t.waitFor({ state: 'visible' });

    for (const cible of ['.toast-msg', '.toast-btn']) {
      const b = await t.locator(cible).first().boundingBox();
      const dessus = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return !!(el && el.closest('.toast'));
      }, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      assert.ok(dessus, `${cible} : la modale passe devant, le message est illisible`);
    }

    // Et « Copier » répond vraiment au clic — un élément « au-dessus » mais inerte ne sert à rien.
    await t.locator('.toast-btn').first().click();
    await page.waitForFunction(() => {
      const b = document.querySelector('#toasts .toast.err .toast-btn');
      return b && !/copier|copy/i.test(b.textContent);
    }, null, { timeout: ATTENTE_ECRAN });
    await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((x) => x.remove()));
  });

  test('la modale rouverte repart vierge', async () => {
    await ouvrir();
    await ecrire('resté d’une fois précédente');
    await page.keyboard.press('Escape');
    await ouvrir();
    const { x, y } = await coinDuFond();
    await page.mouse.click(x, y);
    assert.equal(await ouverte(), false, 'sans remise à zéro, une saisie ancienne bloquerait toutes les ouvertures suivantes');
  });
});
