'use strict';
/* LE PANNEAU DE JOURNAL DES JOBS — BANDEAU, CORPS, FILTRES, STOP — DANS UN VRAI NAVIGATEUR.
 *
 * Ce panneau est commun à tous les menus : tout job de fond (review, session, Git, Docker,
 * vérification…) s'y raconte. On l'exerce ici sur des jobs qu'on tient en main — des cibles
 * `make` qui attendent un feu vert posé par le test (helpers/journal.js) — pour observer chaque
 * état sans parier sur la vitesse de la machine :
 *   - un job qui tourne : bandeau « en cours », barre de progression, Stop, temps écoulé qui
 *     avance, titre de l'onglet du navigateur ; puis terminé : tout retombe, la durée se fige ;
 *   - la barre de progression à mi-parcours et la file annoncée dans le titre ;
 *   - le corps replié par défaut, ▸/▾ ;
 *   - le filtre texte, « Erreurs » seules, le compte des lignes masquées, et le filtre appliqué
 *     aux lignes qui ARRIVENT ;
 *   - la copie du journal affiché ;
 *   - un job en échec : bandeau rouge, et la raison pour laquelle « Relancer » n'est pas offert ;
 *   - Stop : confirmation, arrêt réel côté serveur ;
 *   - masquer / le bouton « journal » du pied de page / la touche « l » ;
 *   - un nouveau job qui rouvre un panneau masqué ;
 *   - l'auto-défilement, coché puis décoché ;
 *   - le repli automatique d'un job terminé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, attendreServeur, waitForJobs,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker } = require('./helpers/fake-docker');
const { preparerChantier, jobServeur } = require('./helpers/journal');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

describe('Panneau de journal — bandeau et corps', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let faux; let chantier;
  const erreurs = [];

  before(async () => {
    faux = installerFauxDocker(scenarioDocker());
    app = await startApp();
    await app.configure();
    const racine = path.join(app.dataDir, 'stacks');
    fs.mkdirSync(racine, { recursive: true });
    chantier = await preparerChantier(app, racine);
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    // Le presse-papiers réel n'est pas garanti en headless : on note ce qui y serait écrit.
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(t); }, readText: async () => '' },
      });
    });
    await page.goto(app.base);
    await page.locator('nav button[data-tab="review"]').waitFor();
  });

  after(async () => {
    if (chantier) chantier.toutLiberer();
    if (app) { try { await waitForJobs(app.api, { timeout: 30000 }); } catch { /* on arrête quand même */ } }
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  /* ---------------------------------------------------------------- outils ---- */

  // Ce que fait chaque bouton « lancer » de l'application après sa requête : demander l'état.
  const rafraichir = () => page.evaluate(() => refreshStatus()); // eslint-disable-line no-undef
  const attendreStatut = (re) => page.waitForFunction(
    (src) => new RegExp(src, 'i').test((document.querySelector('#logStatus') || {}).textContent || ''),
    re.source, { timeout: ATTENTE },
  );
  const volet = (id) => page.locator(`#logBox .logpane[data-job="${id}"]`);
  const attendreDansVolet = (id, texte) => page.waitForFunction(
    ([j, t]) => { const p = document.querySelector(`#logBox .logpane[data-job="${j}"]`); return !!p && p.textContent.includes(t); },
    [id, texte], { timeout: ATTENTE },
  );
  async function deplier() {
    await page.locator('#logPanel').waitFor({ state: 'visible', timeout: ATTENTE });
    if (await page.locator('#logBox').isHidden()) await page.locator('#logToggle').click();
    await page.locator('#logBox').waitFor({ state: 'visible' });
  }
  // Les lignes visibles du volet affiché : [{ texte, classe }].
  const lignesVisibles = () => page.evaluate(() => {
    const p = document.querySelector('#logBox .logpane:not([hidden])');
    return p ? [...p.children].filter((s) => !s.hidden).map((s) => ({ texte: s.textContent.trim(), classe: s.className })) : [];
  });
  const attendreFin = (id, statut) => attendreServeur(async () => {
    const j = await jobServeur(app, id);
    return j && j.status === statut;
  }, `job #${id} ${statut}`);

  /* ------------------------------------------------------- un job qui tourne ---- */

  test('un job qui tourne : bandeau « en cours », barre, Stop, temps écoulé qui avance, titre de l’onglet', async () => {
    const id = await chantier.lancer('porte-a');
    await rafraichir();
    await page.locator('#logPanel').waitFor({ state: 'visible', timeout: ATTENTE });
    await attendreStatut(/en cours/);
    assert.match(await page.locator('#logStatus').getAttribute('class'), /\brunning\b/);
    await page.locator('#logBar').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#progressBar').evaluate((e) => e.style.width), '0%', 'rien de fait sur 1');
    await page.locator('#logStop').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /0\/1 — job en cours/.test(document.title));

    // Le corps est REPLIÉ par défaut : l'en-tête suffit à savoir que ça tourne.
    assert.equal(await page.locator('#logBox').isHidden(), true, 'corps replié par défaut');
    assert.equal((await page.locator('#logToggle').innerText()).trim(), '▸');
    await page.locator('#logToggle').click();
    await page.locator('#logBox').waitFor({ state: 'visible' });
    assert.equal((await page.locator('#logToggle').innerText()).trim(), '▾');
    await attendreDansVolet(id, 'porte-a : en attente du feu vert');
    const cmd = volet(id).locator('span.cmd').first();
    assert.match(await cmd.innerText(), /^\$ make porte-a/, 'la commande lancée ouvre le journal, colorée comme telle');

    // Le temps écoulé AVANCE tant que le job tourne.
    const el = page.locator('#logElapsed');
    await el.waitFor({ state: 'visible' });
    assert.match(await el.getAttribute('title'), /depuis le lancement/);
    const t0 = await el.innerText();
    await page.waitForFunction((v) => document.querySelector('#logElapsed').textContent !== v, t0, { timeout: ATTENTE });

    // Feu vert : le job se termine, et tout ce qui disait « en cours » retombe.
    chantier.feuVert('porte-a');
    await attendreFin(id, 'done');
    await attendreStatut(/terminé/);
    await attendreDansVolet(id, 'porte-a : feu vert reçu');
    assert.match(await page.locator('#logStatus').getAttribute('class'), /\bdone\b/);
    await page.locator('#logBar').waitFor({ state: 'hidden' });
    await page.locator('#logStop').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.title === 'Mergerie');
    await page.waitForFunction(() => /Durée totale/.test(document.querySelector('#logElapsed').title));
    assert.equal(await page.locator('#logRetry').isHidden(), true, 'un succès n’a rien à relancer');
    assert.equal(await page.locator('#logNoRetry').isHidden(), true, 'ni à expliquer');
    assert.equal(await page.locator('#logResult').isHidden(), true, 'une cible make ne désigne aucun objet à ouvrir');
  });

  /* L'écran rend l'avancement que le SERVEUR annonce. Une cible make compte 0/1 puis 1/1 :
     pour voir la barre à mi-course, on sert à la page un état « 1 sur 4, 2 en attente »,
     exactement ce que renverrait une review de quatre MR derrière laquelle deux jobs patientent. */
  test('la barre de progression suit « fait / total », et la file s’annonce dans le titre', async () => {
    const route = '**/api/status';
    await page.route(route, async (r) => {
      const vrai = await (await r.fetch()).json();
      await r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ...vrai, running: true, queued: 2, targets: { mrs: [], tasks: [], locals: [], verifying: [] },
          job: { id: 99999, kind: 'review', status: 'running', done_count: 1, total: 4 },
        }),
      });
    });
    try {
      await rafraichir();
      await page.locator('#logBar').waitFor({ state: 'visible', timeout: ATTENTE });
      await page.waitForFunction(() => document.querySelector('#progressBar').style.width === '25%');
      await page.waitForFunction(() => document.title.startsWith('1/4 (+2)'));
    } finally {
      await page.unroute(route);
    }
    await rafraichir();
    await page.locator('#logBar').waitFor({ state: 'hidden', timeout: ATTENTE });
    await page.waitForFunction(() => document.title === 'Mergerie' && document.querySelector('#progressBar').style.width === '0%');
  });

  /* ------------------------------------------------------ filtrer, copier ---- */

  test('filtrer le journal : par texte, « Erreurs » seules, avec le compte de ce qui est masqué', async () => {
    const id = await chantier.lancer('bavard');
    await rafraichir();
    await deplier();
    await attendreDansVolet(id, 'compilation terminée');
    await attendreFin(id, 'done');
    await page.waitForFunction((j) => {
      const p = document.querySelector('#logBox .logpane:not([hidden])');
      return p && Number(p.dataset.job) === j;
    }, id, { timeout: ATTENTE });

    const toutes = await lignesVisibles();
    assert.equal(toutes.length, 7, `la commande et six lignes : ${JSON.stringify(toutes)}`);
    assert.equal(toutes.find((l) => l.texte === '=== Préparation ===').classe, 'hdr');
    assert.deepEqual(toutes.filter((l) => l.classe === 'err').map((l) => l.texte),
      ['ERROR: connexion ECONNREFUSED 127.0.0.1:5432', 'fatal: délai dépassé sur le registre']);

    await page.locator('#logFilter').fill('econnrefused');
    await page.waitForFunction(() => document.querySelector('#logFilterInfo').textContent === '6 lignes masquées');
    assert.deepEqual((await lignesVisibles()).map((l) => l.texte), ['ERROR: connexion ECONNREFUSED 127.0.0.1:5432']);

    // Vider le champ ramène tout : le filtre MASQUE, il ne coupe rien.
    await page.locator('#logFilter').fill('');
    await page.waitForFunction(() => document.querySelector('#logFilterInfo').textContent === '');
    assert.equal((await lignesVisibles()).length, 7);

    await page.locator('#logErrOnly').check();
    await page.waitForFunction(() => document.querySelector('#logFilterInfo').textContent === '5 lignes masquées');
    assert.deepEqual((await lignesVisibles()).map((l) => l.classe), ['err', 'err']);
    await page.locator('#logErrOnly').uncheck();
    await page.waitForFunction(() => document.querySelector('#logFilterInfo').textContent === '');
    assert.equal((await lignesVisibles()).length, 7);
  });

  test('copier : c’est le journal AFFICHÉ qui part dans le presse-papiers', async () => {
    await page.locator('#logCopy').click();
    await page.waitForFunction(() => window.__copies.length > 0);
    const copie = await page.evaluate(() => window.__copies[window.__copies.length - 1]);
    assert.match(copie, /\$ make bavard/);
    assert.match(copie, /compilation terminée/);
    assert.doesNotMatch(copie, /porte-a/, 'pas le journal du job précédent');
    await page.waitForFunction(() => /copié/.test(document.querySelector('#logCopy').textContent));
  });

  /* ------------------------------------------------------------- l'échec ---- */

  test('un job en échec : bandeau rouge, « Relancer » absent et sa raison dite, filtre appliqué aux lignes qui arrivent', async () => {
    // « Erreurs » coché AVANT que le job ne parle : ses lignes ordinaires doivent arriver masquées.
    await page.locator('#logErrOnly').check();
    const id = await chantier.lancer('casse');
    await rafraichir();
    await deplier();
    await attendreFin(id, 'error');
    await attendreStatut(/erreur/);
    assert.match(await page.locator('#logStatus').getAttribute('class'), /\berror\b/);
    await attendreDansVolet(id, 'avant la casse');

    const visibles = await lignesVisibles();
    assert.ok(visibles.length >= 1, 'la ligne d’erreur de make reste visible');
    assert.ok(visibles.every((l) => l.classe === 'err'), `seules les erreurs restent : ${JSON.stringify(visibles)}`);
    assert.ok(visibles.some((l) => /Error 3/.test(l.texte)), 'le code de sortie de make est lisible');
    assert.equal(await volet(id).locator('span', { hasText: 'avant la casse' }).isHidden(), true,
      'la ligne ordinaire arrivée après le filtre est masquée');

    // Un job Docker ne se relance pas d'ici : le bouton est absent, et l'écran dit pourquoi.
    const raison = (await app.api('GET', `/api/jobs/${id}/log`)).body.no_retry_reason;
    assert.ok(raison, 'le serveur donne une raison');
    await page.locator('#logNoRetry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#logNoRetry').innerText(), raison);
    assert.equal(await page.locator('#logRetry').isHidden(), true);
    await page.locator('#logErrOnly').uncheck();
    await page.waitForFunction(() => document.querySelector('#logFilterInfo').textContent === '');
  });

  /* ---------------------------------------------------------------- Stop ---- */

  test('Stop : une confirmation, puis le job est réellement arrêté côté serveur', async () => {
    const id = await chantier.lancer('porte-b');
    await rafraichir();
    await attendreStatut(/en cours/);
    await page.locator('#logStop').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    const texte = await page.locator('#confirmText').innerText();
    assert.match(texte, /Arrêter le traitement en cours/);
    assert.doesNotMatch(texte, /en attente/, 'rien en file : la confirmation ne parle pas de jobs annulés');
    await page.locator('#confirmOk').click();

    await attendreFin(id, 'stopped');
    await attendreStatut(/arrêté/);
    await page.locator('#logStop').waitFor({ state: 'hidden', timeout: ATTENTE });
    await page.locator('#logNoRetry').waitFor({ state: 'visible' });
    assert.match(await page.locator('#logNoRetry').innerText(), /Docker/);
    await attendreDansVolet(id, 'Arrêté par l’utilisateur');
  });

  test('Stop puis « Annuler » dans la confirmation : le job continue', async () => {
    const id = await chantier.lancer('porte-c');
    await rafraichir();
    await attendreStatut(/en cours/);
    await page.locator('#logStop').click();
    await page.locator('#confirmModal').waitFor({ state: 'visible' });
    await page.locator('#confirmCancel').click();
    await page.locator('#confirmModal').waitFor({ state: 'hidden' });
    // Le job doit encore tourner APRÈS le refus : on le libère, et il doit finir « done », pas « stopped ».
    assert.equal((await jobServeur(app, id)).status, 'running');
    chantier.feuVert('porte-c');
    await attendreFin(id, 'done');
    await attendreStatut(/terminé/);
  });

  /* ------------------------------------------------ masquer et retrouver ---- */

  test('masquer : le panneau part, « journal » dans le pied de page et la touche « l » le ramènent', async () => {
    await page.locator('#logHide').click();
    await page.locator('#logPanel').waitFor({ state: 'hidden' });
    const pied = page.locator('#footerLogs');
    await pied.waitFor({ state: 'visible' });
    assert.match(await pied.getAttribute('class'), /\bst-done\b/, 'la pastille rappelle l’issue du dernier job');

    await pied.click();
    await page.locator('#logPanel').waitFor({ state: 'visible' });
    await page.locator('#logBox').waitFor({ state: 'visible' });
    await pied.waitFor({ state: 'hidden' });

    await page.locator('#logHide').click();
    await page.locator('#logPanel').waitFor({ state: 'hidden' });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('l');
    await page.locator('#logPanel').waitFor({ state: 'visible' });
    // Panneau affiché : « l » replie puis redéplie le corps.
    await page.keyboard.press('l');
    await page.locator('#logBox').waitFor({ state: 'hidden' });
    await page.keyboard.press('l');
    await page.locator('#logBox').waitFor({ state: 'visible' });
  });

  test('un nouveau job rouvre le panneau qu’on avait masqué', async () => {
    await page.locator('#logHide').click();
    await page.locator('#logPanel').waitFor({ state: 'hidden' });
    const id = await chantier.lancer('porte-d');
    await rafraichir();
    await page.locator('#logPanel').waitFor({ state: 'visible', timeout: ATTENTE });
    await attendreStatut(/en cours/);
    await attendreDansVolet(id, 'porte-d : en attente');
    chantier.feuVert('porte-d');
    await attendreFin(id, 'done');
    await attendreStatut(/terminé/);
  });

  /* -------------------------------------------------------- auto-défilement ---- */

  test('auto-défilement : suit la fin quand coché, laisse la lecture en place quand décoché', async () => {
    await deplier();
    assert.equal(await page.locator('#logAutoscroll').isChecked(), true, 'coché par défaut');
    const id = await chantier.lancer('flot');
    await rafraichir();
    await attendreDansVolet(id, 'flot ligne 150');
    const mesure = () => volet(id).evaluate((p) => ({ top: p.scrollTop, h: p.scrollHeight, vue: p.clientHeight }));
    await page.waitForFunction((j) => {
      const p = document.querySelector(`#logBox .logpane[data-job="${j}"]`);
      return p.scrollHeight > p.clientHeight && p.scrollTop + p.clientHeight >= p.scrollHeight - 2;
    }, id, { timeout: ATTENTE });

    await page.locator('#logAutoscroll').uncheck();
    await volet(id).evaluate((p) => { p.scrollTop = 0; });
    chantier.feuVert('flot');
    await attendreDansVolet(id, 'flot ligne 300');
    const m = await mesure();
    assert.equal(m.top, 0, 'décoché : les nouvelles lignes n’arrachent pas la lecture en cours');
    assert.ok(m.h > m.vue);
    await attendreFin(id, 'done');
    await page.locator('#logAutoscroll').check();
  });

  /* ---------------------------------------------------------- repli auto ---- */

  test('un job terminé sans résultat à ouvrir se replie tout seul quand le journal est replié', async () => {
    // Replié : c'est la seule condition où le repli automatique a le droit d'agir.
    if (await page.locator('#logBox').isVisible()) await page.locator('#logToggle').click();
    await page.locator('#logBox').waitFor({ state: 'hidden' });
    const id = await chantier.lancer('bavard');
    await rafraichir();
    await attendreFin(id, 'done');
    await attendreStatut(/terminé/);
    await page.locator('#logPanel').waitFor({ state: 'hidden', timeout: ATTENTE });
    await page.locator('#footerLogs').waitFor({ state: 'visible' });
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
