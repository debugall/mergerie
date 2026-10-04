'use strict';
/* LA TAILLE DES CHAMPS DE SAISIE, MESURÉE.
 *
 * (Les éditeurs de l'onglet Liens — adresses d'un service, case de la grille — sont mesurés dans le dépôt du plugin `link-mergerie`, avec les mêmes planchers.)
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
  afficherMenusOptionnels,
} = require('./helpers/app');

const { dispo } = navigateurDispo();
/* DEUX PLANCHERS, POUR DEUX QUESTIONS DIFFÉRENTES.
   - `PLANCHER` répond à « ce champ a-t-il été habillé ? ». Le champ nu du navigateur fait
     21 px ; les champs volontairement compacts de l'outil (un pied de modale, une barre
     d'outils) tiennent à 33-34. En dessous de 30, personne n'a choisi : c'est un oubli.
   - `CHAMP_FORME` est la hauteur d'un vrai champ de formulaire, celle qu'on attend là où l'on
     saisit une valeur — 38 px, moins un pixel de tolérance de rendu. */
const PLANCHER = 30;

describe('Champs de saisie — taille', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    await afficherMenusOptionnels(page);
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="review"]');
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
});
