'use strict';
/* L'ÉCRAN APRÈS UNE SYNCHRONISATION — outils communs aux fichiers `e2e-menu-synchro-ecran-*`.
 *
 * La question de ces fichiers n'est pas « la donnée arrive-t-elle ? » (les tests de synchro
 * le prouvent déjà) mais « ce que J'AI SOUS LES YEUX suit-il, sans que je recharge ? ». Chaque
 * test a donc la même forme, en trois temps :
 *
 *   1. la collègue (une seconde instance de Mergerie, `helpers/synchro-collegue`) agit par son
 *      API et pousse avec son propre code de synchro ;
 *   2. ce poste synchronise comme l'utilisateur le fait — le témoin du pied de page, visible sur
 *      tous les écrans, ou la boucle automatique — et l'on EXIGE que la base locale porte la
 *      donnée (sinon l'échec accuserait l'écran d'une panne de synchro) ;
 *   3. on attend l'EFFET à l'écran, borné. Puis, quoi qu'il arrive, un TÉMOIN : l'écran rechargé
 *      montre bien la donnée. Le témoin est une assertion dure — s'il échoue, c'est le test qui
 *      est faux (sélecteur, préparation), pas l'application. Seulement ensuite, on juge le
 *      « sans recharger ». Un test marqué `todo` échoue donc pour la raison qu'il annonce, et
 *      pour aucune autre.
 *
 * Rien de `src/` n'est chargé ici. */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { attendreServeur } = require('./app');
const { lancerCollegue } = require('./synchro-collegue');

/* LE DÉLAI LAISSÉ À L'ÉCRAN POUR SUIVRE. Le sondage d'état de la page bat toutes les 5 s (1,5 s
   pendant un job) : un écran qui se tient au courant par lui a eu deux battements pour le faire.
   Au-delà, ce n'est plus « suivre », c'est « finir par voir ». */
const DELAI_ECRAN = 12000;

/**
 * Monte l'équipe : un dépôt nu, CE poste rattaché (cadence 600 s — aucun tour automatique ne
 * doit passer au mauvais moment), puis la collègue qui rejoint. `configCollegue` est posé chez
 * elle AVANT qu'elle rejoigne (jeton de la forge, chemin des clones : des réglages de poste).
 */
async function monterEquipe(app, { nom = 'Claire', configCollegue = null, configIci = {} } = {}) {
  const racine = fs.mkdtempSync(path.join(app.dataDir, 'ecran-'));
  const nu = path.join(racine, 'donnees.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
  const c = await app.api('PUT', '/api/config', {
    data_repo_url: nu, data_repo_branch: 'main', data_sync_seconds: '600', brief_on_open: '0', ...configIci,
  });
  assert.equal(c.status, 200, c.text);
  const r = await app.api('POST', '/api/data-sync/attach', { url: nu });
  assert.equal(r.status, 200, r.text);
  await attendreServeur(async () => Boolean((await app.api('GET', '/api/data-sync')).body.dernierPush), 'le premier envoi de ce poste');

  const collegue = await lancerCollegue({ nom, racine });
  if (configCollegue) {
    const cc = await collegue.api('PUT', '/api/config', configCollegue(collegue));
    assert.equal(cc.status, 200, cc.text);
  }
  await collegue.rattacher(nu);
  return { racine, nu, collegue };
}

/**
 * « Synchroniser » depuis le témoin du pied de page — le seul bouton de synchro présent sur
 * TOUS les écrans : c'est celui qu'on clique sans quitter ce qu'on regarde. On attend la
 * RÉPONSE du serveur (le tour est fini, la base est hydratée), puis le témoin rendu.
 */
async function synchroniserDepuisLePied(page) {
  await page.waitForSelector('#footerSync:not([hidden])');
  const [rep] = await Promise.all([
    page.waitForResponse((x) => /\/api\/data-sync\/now$/.test(x.url()) && x.request().method() === 'POST', { timeout: 60000 }),
    page.locator('#footerSync').click(),
  ]);
  assert.equal(rep.status(), 200, 'le tour de synchro a réussi');
  const corps = await rep.json();
  assert.equal(corps.statut && corps.statut.erreur, null, `synchro sans erreur (${corps.statut && corps.statut.erreur})`);
  await page.waitForFunction(() => !document.querySelector('#footerSync').disabled);
  return corps;
}

/** Attend un prédicat de page, borné ; rend `true` s'il a été vu, `false` sinon — sans lever. */
async function vuALEcran(page, predicat, arg, ms = DELAI_ECRAN) {
  try {
    await page.waitForFunction(predicat, arg, { timeout: ms });
    return true;
  } catch (e) {
    if (/Timeout/i.test(e.message)) return false;
    throw e;
  }
}

/**
 * Le cœur de chaque test : l'écran suit-il SANS recharger ?
 *   — `predicat`/`arg` : ce que l'écran doit montrer ;
 *   — `temoin` : ce qui ramène l'utilisateur sur le même écran APRÈS un rechargement (reload,
 *     onglet, stade) — le prédicat y est alors exigé, dur ;
 *   — `bug` : la phrase de l'assertion finale, quand l'écran n'a pas suivi.
 */
async function exigerQueLEcranSuive(page, { predicat, arg, temoin, bug }) {
  const suivi = await vuALEcran(page, predicat, arg);
  await temoin();
  await page.waitForFunction(predicat, arg, { timeout: 30000 })
    .catch((e) => { throw new Error(`TÉMOIN en échec — même rechargé, l'écran ne montre pas la donnée : le test est faux, pas l'application (${e.message.split('\n')[0]})`); });
  assert.ok(suivi, bug);
}

module.exports = {
  DELAI_ECRAN, monterEquipe, synchroniserDepuisLePied, vuALEcran, exigerQueLEcranSuive,
};
