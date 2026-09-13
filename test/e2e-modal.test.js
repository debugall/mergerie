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

  /* LE PIED RESTE À L'ÉCRAN. La boîte défile (max-height 90vh) et le formulaire de session
     fait 720 px sur un écran de 800 : « Annuler » et le bouton principal tombaient sous la
     ligne de flottaison. On ouvrait une fenêtre dont on ne voyait aucune issue, et rien ne
     disait qu'elle défilait. */
  test('le pied de la modale de session reste visible à l’ouverture', async () => {
    const avant = page.viewportSize();
    await page.setViewportSize({ width: 1280, height: 800 });   // l'écran de la revue
    await ouvrir();
    const pied = await page.locator('#taskModal .modal-actions').boundingBox();
    const h = await page.evaluate(() => window.innerHeight);
    assert.ok(pied.y + pied.height <= h + 1,
      `le pied doit tenir dans l’écran (bas à ${Math.round(pied.y + pied.height)}, fenêtre ${h})`);
    assert.equal(await page.locator('#taskSubmit').isVisible(), true);
    assert.equal(await page.locator('#taskCancel').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.setViewportSize(avant);
  });

  /* Trois champs par projet et rien pour les nommer : dès qu'on tape, l'invite disparaît et
     « branche à créer » ne se distingue plus de « branche de départ ». */
  test('les champs d’un projet portent une ligne d’en-têtes, alignée sur eux', async () => {
    await ouvrir();
    const cols = await page.evaluate(() => {
      const x = (el) => Math.round(el.getBoundingClientRect().left);
      const tetes = [...document.querySelectorAll('.target-head-row > *')].map(x);
      const ligne = document.querySelector('#targetRows .target-row');
      return { tetes, champs: [...ligne.children].map(x) };
    });
    assert.equal(cols.tetes.length, cols.champs.length, 'une colonne d’en-tête par colonne de champ');
    cols.tetes.forEach((t, i) => {
      assert.ok(Math.abs(t - cols.champs[i]) <= 2,
        `l’en-tête ${i} doit coiffer son champ (${t} vs ${cols.champs[i]})`);
    });
    assert.equal(await page.locator('#targetRows .target-row').count(), 1,
      'la ligne d’en-têtes ne compte pas pour un projet');
    await page.keyboard.press('Escape');
  });

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

  /* ---------- METTRE LA FENÊTRE DE CÔTÉ ----------
     Le geste qu'aucune modale ne permettait : aller vérifier quelque chose ailleurs sans
     rien perdre. Ce qui se garde ici, c'est ce qui fait qu'on ose l'utiliser — la saisie,
     le curseur, l'onglet — et le fait que la fenêtre reprise se défende toujours contre un
     clic à côté, sans quoi on aurait déplacé la perte au lieu de l'éviter. */
  test('une fenêtre réduite se range dans le menu et se reprend intacte', async () => {
    // La fenêtre part d'un onglet précis : c'est celui-là qu'on doit retrouver en la reprenant.
    // (L'épreuve précédente a pu laisser une modale ouverte : son voile intercepterait le clic.)
    await page.evaluate(() => window.closeTaskModal());
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForFunction(() => document.querySelector('nav button[data-tab="task"]').classList.contains('active'));
    await ouvrir();
    await ecrire('ce que j’étais en train d’écrire');
    await page.locator('#taskModal .modal-reduire').click();

    assert.equal(await ouverte(), false, 'la fenêtre libère l’écran…');
    await page.locator('#modalDock .dock-chip').waitFor({ state: 'visible' });
    assert.match(await page.locator('#modalDock').innerText(), /session/i, '…et la puce dit LAQUELLE');

    // On va voir ailleurs : c'est tout l'objet de la manœuvre.
    await page.locator('nav button[data-tab="git"]').click();
    await page.waitForFunction(() => document.querySelector('nav button[data-tab="git"]').classList.contains('active'));

    await page.locator('#modalDock .dock-open').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    assert.equal(await page.inputValue('#taskModal textarea[name="prompt"]'), 'ce que j’étais en train d’écrire',
      'la fenêtre est masquée, jamais reconstruite : la saisie ne peut pas disparaître');
    await page.waitForFunction(() => document.activeElement && document.activeElement.name === 'prompt',
      null, { timeout: ATTENTE_ECRAN });
    assert.equal(await page.locator('nav button[data-tab="task"].active').count(), 1,
      'on reprend sur l’onglet d’où la fenêtre était partie — c’est là que son résultat s’affichera');
    assert.equal(await page.locator('#modalDock').isHidden(), true, 'reparue, elle n’est plus dans le menu');

    /* LA GARDE DE SAISIE SURVIT À L'ALLER-RETOUR. Le drapeau se remet à zéro à chaque
       masquage : sans exception pour la réduction, la fenêtre reprise se serait laissé
       fermer d'un clic à côté avec tout ce qu'elle contenait. */
    const { x, y } = await coinDuFond();
    await page.mouse.click(x, y);
    assert.equal(await ouverte(), true, 'une fenêtre reprise protège sa saisie comme avant');
    await page.keyboard.press('Escape');
  });

  /* LE BOUTON EST PARTOUT OÙ IL DOIT ÊTRE, ET NULLE PART AILLEURS. Il n'est écrit dans
     aucune liste : `fermerAuFond` le pose sur toute modale dont la saisie est protégée. On
     vérifie donc le RÉSULTAT de cette règle sur les fenêtres à formulaire — et qu'il ne se
     pose ni hors de la boîte ni sur le titre. */
  test('chaque fenêtre à saisie porte le bouton, au coin, sans recouvrir son titre', async () => {
    const IDS = ['taskModal', 'mergeModal', 'mrModal', 'convergeModal', 'ticketModal', 'bulkModal',
      'mergeCommitModal', 'captureModal', 'envModal', 'serviceModal', 'freeLinkModal', 'pasteModal',
      'toServiceModal', 'importModal', 'dictInstallModal'];
    await page.evaluate(() => window.closeTaskModal());
    const vu = await page.evaluate((ids) => ids.map((id) => {
      const m = document.getElementById(id);
      if (!m) return { id, err: 'modale absente' };
      const etait = m.hidden;
      m.hidden = false;
      const box = m.querySelector('.modal-box');
      const b = m.querySelector('.modal-reduire');
      if (!b) { m.hidden = etait; return { id, err: 'pas de bouton réduire' }; }
      const bb = b.getBoundingClientRect(); const cb = box.getBoundingClientRect();
      const h3 = box.querySelector('h3');
      let surLeTitre = false;
      if (h3) { const r = document.createRange(); r.selectNodeContents(h3); const t = r.getBoundingClientRect(); surLeTitre = t.right > bb.left && t.top < bb.bottom && t.bottom > bb.top; }
      m.hidden = etait;
      return { id, dedans: bb.width > 0 && bb.right <= cb.right + 1 && bb.top >= cb.top - 1, surLeTitre };
    }), IDS);
    assert.deepEqual(vu.filter((v) => v.err), [], 'toutes les fenêtres à saisie doivent l’avoir');
    assert.deepEqual(vu.filter((v) => !v.dedans).map((v) => v.id), [], 'le bouton doit être DANS la boîte, au coin haut-droit');
    assert.deepEqual(vu.filter((v) => v.surLeTitre).map((v) => v.id), [], 'et ne rien recouvrir du titre');
  });

  /* UNE FENÊTRE DONT ON NE PEUT PLUS ATTEINDRE LA COMMANDE DE RÉDUCTION N'EST PAS RÉDUCTIBLE.
     Le formulaire de session fait deux écrans de haut : posé dans le flux, le bouton partait
     avec le défilement, et il fallait remonter pour mettre la fenêtre de côté. */
  test('le bouton reste au coin quand le formulaire défile', async () => {
    await ouvrir();
    const haut = async () => page.evaluate(() => {
      const box = document.querySelector('#taskModal .modal-box');
      return Math.round(document.querySelector('#taskModal .modal-reduire').getBoundingClientRect().top
        - box.getBoundingClientRect().top);
    });
    const avant = await haut();
    await page.evaluate(() => { const b = document.querySelector('#taskModal .modal-box'); b.scrollTop = b.scrollHeight; });
    await page.waitForFunction(() => document.querySelector('#taskModal .modal-box').scrollTop > 40);
    assert.ok(Math.abs(await haut() - avant) <= 2, 'le bouton suit la boîte, pas son contenu');
    await page.keyboard.press('Escape');
  });

  test('la croix de la puce abandonne la fenêtre pour de bon', async () => {
    await ouvrir();
    await ecrire('à mettre de côté puis à jeter');
    await page.locator('#taskModal .modal-reduire').click();
    await page.locator('#modalDock .dock-close').click();
    await page.locator('#modalDock').waitFor({ state: 'hidden' });
    assert.equal(await ouverte(), false);
    // Abandonner passe par la VRAIE fermeture : la fenêtre suivante repart vierge.
    await ouvrir();
    assert.equal(await page.inputValue('#taskModal textarea[name="prompt"]'), '');
    await page.keyboard.press('Escape');
  });

  /* Une modale qui rend une PROMESSE (confirmation, choix d'un vérificateur) ne se réduit
     pas : son appelant attend une réponse, et la mettre de côté le laisserait attendre pour
     toujours — bouton figé en chargement, sans rien à l'écran pour le débloquer. La règle
     n'est pas une liste à tenir : ces modales-là sont exactement celles qu'on ne protège pas
     contre le clic au fond (`salissable: false`). */
  test('une confirmation ne porte pas de bouton « réduire »', async () => {
    await page.evaluate(() => { window.confirmDialog({ title: 'Test', text: 'On confirme ?' }); });
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.equal(await page.locator('#confirmModal .modal-reduire').count(), 0,
      'la réduire laisserait son appelant en attente pour toujours');
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
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
