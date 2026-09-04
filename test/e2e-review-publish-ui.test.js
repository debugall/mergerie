'use strict';
/* PUBLIER LE RAPPORT — LES DEUX COMMANDES, DANS LE NAVIGATEUR.
 *
 * Le comportement serveur est prouvé ailleurs (`e2e-review-publish`). Ce qui se prouve ICI et
 * nulle part ailleurs, c'est le CÂBLAGE : un champ de réglage peut s'afficher, accepter la
 * souris et n'être jamais enregistré — il suffit qu'il manque à la liste blanche qui pilote la
 * sauvegarde, et rien à l'écran ne le dit. C'est arrivé à jira_email, puis à github_url.
 *
 * Même chose pour le bouton du rapport : une route qui répond ne prouve pas qu'un bouton
 * l'appelle. On vérifie donc la case ET le bouton depuis l'écran, en relisant chaque fois
 * l'ÉTAT DU SERVEUR — pas le libellé affiché, qui dit « enregistré » avant de savoir.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Publier le rapport de review — écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let mrId;

  before(async () => {
    app = await startApp();
    const distant = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-'));
    const git = (...a) => execFileSync('git', a, { cwd: distant, stdio: 'pipe' }).toString().trim();
    git('init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'feature/x');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'tete\n');
    git('add', '-A'); git('commit', '-qm', 'tete');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');

    await app.configure();
    await app.api('POST', '/api/repos', { project: 'grp/app', url: distant });
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    app.state.mrs['grp/app'] = [{
      iid: 7, title: 'Sujet', state: 'opened', source_branch: 'feature/x', target_branch: 'main',
      web_url: 'http://x/7', sha: head, created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 7).id;

    // Un vrai rapport, produit par la vraie review (COPILOT_DRY_RUN) : le bouton n'apparaît
    // qu'en présence d'un rapport, et on veut le voir apparaître pour de bon.
    await app.api('POST', `/api/mrs/${mrId}/review`);
    for (let i = 0; i < 900; i += 1) {
      const { body: st } = await app.api('GET', '/api/status');
      if (!st.running && !st.queued) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const reglage = async () => (await app.api('GET', '/api/config')).body.auto_post_review;

  /* --------------------------------------------------------------- la case ---- */

  test('la case existe dans Réglages → Merge request, et elle est décochée', async () => {
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="mr"]').click();
    const case_ = page.locator('#sub-mr input[name="auto_post_review"]');
    await case_.waitFor();
    assert.equal(await case_.isChecked(), false, 'décochée par défaut');
  });

  test('la cocher et enregistrer l’écrit VRAIMENT côté serveur', async () => {
    await page.locator('#sub-mr input[name="auto_post_review"]').click();
    await page.locator('#sub-mr .form-actions button[type="submit"]').click();
    /* On attend l'état du SERVEUR, pas le mot « enregistré » : le libellé s'affiche avant que
       la réponse soit arrivée, et un champ jamais sauvegardé l'affiche aussi. */
    await page.waitForFunction(async () => {
      const c = await (await fetch('/api/config')).json();
      return c.auto_post_review === '1';
    }, null, { timeout: 15000 });
    assert.equal(await reglage(), '1');
  });

  test('la décocher la remet à zéro, et l’écran la relit ainsi après rechargement', async () => {
    await page.locator('#sub-mr input[name="auto_post_review"]').click();
    await page.locator('#sub-mr .form-actions button[type="submit"]').click();
    await page.waitForFunction(async () => {
      const c = await (await fetch('/api/config')).json();
      return c.auto_post_review === '0';
    }, null, { timeout: 15000 });
    // Le chargement du formulaire est l'autre moitié du câblage : sauvegardé mais jamais
    // relu, le champ repartirait décoché à chaque ouverture.
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="mr"]').click();
    assert.equal(await page.locator('#sub-mr input[name="auto_post_review"]').isChecked(), false);

    await app.api('PUT', '/api/config', { auto_post_review: '1' });
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="mr"]').click();
    assert.equal(await page.locator('#sub-mr input[name="auto_post_review"]').isChecked(), true,
      'une case sauvegardée doit se rouvrir cochée');
    await app.api('PUT', '/api/config', { auto_post_review: '0' });
  });

  /* ------------------------------------------------------------- le bouton ---- */

  test('le rapport porte un bouton « Publier », qui poste après confirmation', async () => {
    await page.reload();
    await page.locator('[data-tab="review"]').click();
    await page.locator('[data-seg="reviewed"]').click();
    await page.locator('#reportList .card').first().click();
    const bouton = page.locator('#aPublish');
    await bouton.waitFor({ timeout: 15000 });
    assert.match(await bouton.innerText(), /GitLab/, 'le bouton nomme la forge du dépôt');

    // On confirme : écrire chez les autres ne doit pas partir sur un clic isolé.
    await bouton.click();
    await page.locator('#confirmModal:not([hidden])').waitFor();
    await page.locator('#confirmOk').click();

    /* L'effet qui compte est côté forge : le commentaire est-il parti ? On l'attend, plutôt
       que de parier sur la vitesse du rendu. */
    await page.waitForFunction(async (id) => {
      const d = await (await fetch(`/api/mrs/${id}`)).json();
      return !!(d.review && d.review.comment_posted_at);
    }, mrId, { timeout: 20000 });

    const postees = app.state.calls.filter((c) => c.method === 'POST' && /\/notes$/.test(c.path));
    assert.equal(postees.length, 1, 'un commentaire, et un seul');
    const surDisque = fs.readFileSync(
      app.db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(mrId).md_path, 'utf8').trim();
    assert.equal(postees[0].body.body, surDisque, 'c’est le rapport qui part, pas autre chose');
  });

  test('une fois publié, le bouton propose de REpublier — il ne se tait pas', async () => {
    // Sans ce changement de libellé, on reclique en croyant que le premier envoi a échoué,
    // et l'équipe reçoit deux fois le même rapport.
    await page.locator('#aPublish').waitFor({ timeout: 15000 });
    await page.waitForFunction(
      () => /republier/i.test(document.querySelector('#aPublish').innerText),
      null, { timeout: 15000 },
    );
    assert.ok(await page.locator('#aPublish').getAttribute('data-posted'), 'la date publiée est portée par le bouton');
  });

  test('annuler la confirmation ne publie rien', async () => {
    const avant = app.state.calls.filter((c) => c.method === 'POST' && /\/notes$/.test(c.path)).length;
    await page.locator('#aPublish').click();
    await page.locator('#confirmModal:not([hidden])').waitFor();
    await page.locator('#confirmCancel').click();
    /* `waitFor()` attend « visible » par défaut, et un élément `[hidden]` ne l'est jamais :
       on attend donc que le sélecteur « modale OUVERTE » cesse d'exister. */
    await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'detached' });
    assert.equal(app.state.calls.filter((c) => c.method === 'POST' && /\/notes$/.test(c.path)).length, avant);
  });

  /* ------------------------------------ l'autre case du même panneau ---- */

  /* Elle vit ici parce que le harnais démarre le serveur EN PROCESSUS : un second `startApp()`
     dans le même fichier attend un `listening` qui ne viendra jamais. Deux cases du même
     panneau partagent donc la même application — et c'est le même câblage qu'on vérifie :
     un champ peut s'afficher, accepter la souris et n'être jamais enregistré. */
  test('« Lancer automatiquement la review » s’enregistre, avec son plafond', async () => {
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="mr"]').click();
    const auto = page.locator('#sub-mr input[name="auto_review_new"]');
    await auto.waitFor();
    assert.equal(await auto.isChecked(), false, 'décochée par défaut : elle dépense des appels IA');

    await auto.click();
    await page.locator('#sub-mr input[name="review_auto_max"]').fill('3');
    await page.locator('#sub-mr .form-actions button[type="submit"]').click();
    await page.waitForFunction(async () => {
      const c = await (await fetch('/api/config')).json();
      return c.auto_review_new === '1' && Number(c.review_auto_max) === 3;
    }, null, { timeout: 15000 });

    // L'autre moitié du câblage : sauvegardé mais jamais relu, le champ repartirait vide.
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="mr"]').click();
    assert.equal(await page.locator('#sub-mr input[name="auto_review_new"]').isChecked(), true);
    assert.equal(await page.locator('#sub-mr input[name="review_auto_max"]').inputValue(), '3');
    await app.api('PUT', '/api/config', { auto_review_new: '0' });
  });

  test('un plafond à 0 se RÉAFFICHE « 0 », pas vide', async () => {
    // 0 veut dire « sans limite ». Affiché vide, il se lirait comme « valeur par défaut », et
    // on croirait le garde-fou en place alors qu'on vient de le retirer.
    await app.api('PUT', '/api/config', { review_auto_max: '0' });
    await page.reload();
    await page.locator('[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="mr"]').click();
    assert.equal(await page.locator('#sub-mr input[name="review_auto_max"]').inputValue(), '0');
    await app.api('PUT', '/api/config', { review_auto_max: '5' });
  });
});
