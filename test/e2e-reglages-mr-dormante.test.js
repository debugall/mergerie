'use strict';
/* « MR dormante au bout de (jours) » vit dans Réglages → Merge Request (plus dans Général). Dans un vrai navigateur : le champ est affiché (libellé, « i », valeur
   effective), il s'ÉDITE, s'enregistre par le bouton de son onglet, et quand on REVIENT — en changeant d'onglet puis après un rechargement complet — l'enregistrement
   est bien pris en compte : l'écran réaffiche la valeur retenue par le serveur, qui est aussi celle que le brief applique. Les bornes (0 → 5, au-delà de 90 → 90)
   se voient à l'écran après relecture. Chaque geste est jugé sur son EFFET (l'API, le brief), pas sur un libellé. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const jours = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

describe('Réglages → Merge Request : « MR dormante au bout de (jours) »', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let mrId;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    // Une MR reviewée il y a 8 jours et toujours ouverte : dormante à 5 jours, plus à 30.
    await app.api('POST', '/api/repos', { project: 'grp/app', url: `${app.gitlabUrl}/grp/app.git` });
    app.state.mrs['grp/app'] = [{
      iid: 31, title: 'Une MR qui dort', state: 'opened', source_branch: 'feature/dort', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/31', sha: 'abc123', author: { name: 'Dev' }, created_at: jours(-9),
      diff_refs: { base_sha: 'base1', start_sha: 'start1', head_sha: 'abc123' },
    }];
    await app.api('POST', '/api/discover');
    mrId = app.db.prepare('SELECT id FROM mr WHERE iid = 31').get().id;
    const vieux = jours(-8);
    app.db.prepare("UPDATE mr SET status = 'reviewed', closed_seen = 0 WHERE id = ?").run(mrId);
    app.db.prepare('INSERT INTO review (mr_id, md_path, created_at, updated_at) VALUES (?,?,?,?)').run(mrId, '/tmp/rien.md', vieux, vieux);

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => { if (navigateur) await navigateur.close(); if (app) await app.stop(); });

  const ouvrir = async (sub) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
    await page.waitForSelector(`#sub-${sub} .scope-badge`);
    await page.waitForLoadState('networkidle');
  };
  const champ = () => page.locator('#sub-mr [name="stale_mr_days"]');
  const valeurServeur = async () => Number((await app.api('GET', '/api/config')).body.stale_mr_days);
  const enregistrer = async (valeur) => {
    await ouvrir('mr');
    await champ().fill(String(valeur));
    await page.locator('#sub-mr button[type="submit"][form="configForm"]').first().click();
  };
  const dormantes = async () => (await app.api('GET', '/api/brief')).body;

  test('le champ est dans l’onglet Merge Request, plus dans Général : libellé, « i » rempli, valeur effective (5 par défaut)', async () => {
    assert.equal(await page.locator('#sub-mr [name="stale_mr_days"]').count(), 1);
    assert.equal(await page.locator('#sub-config [name="stale_mr_days"]').count(), 0);
    await ouvrir('mr');
    const rang = page.locator('#sub-mr label:has([name="stale_mr_days"])');
    assert.equal(await rang.isVisible(), true);
    assert.match(await rang.locator('span').first().innerText(), /MR dormante/);
    assert.ok(((await rang.locator('.hint').getAttribute('data-tip')) || '').length > 40, 'son « i » explique le champ');
    assert.equal(await champ().inputValue(), '5', 'la valeur appliquée s’écrit dans le champ, pas seulement en grisé');
    assert.equal(await valeurServeur(), 5);
  });

  test('on édite : enregistrée par le bouton de l’onglet, la valeur arrive en base ; en changeant d’onglet puis en revenant, elle est toujours là', async () => {
    await enregistrer(30);
    await attendreServeur(async () => (await valeurServeur()) === 30, 'le serveur retient 30');
    await ouvrir('config');                    // on s'en va…
    await ouvrir('mr');                        // …et on revient
    assert.equal(await champ().inputValue(), '30');
  });

  test('après un rechargement complet, l’écran réaffiche l’enregistrement — et le brief l’applique (à 30 jours la MR de 8 jours ne dort plus)', async () => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="admin"]');
    await ouvrir('mr');
    assert.equal(await champ().inputValue(), '30');
    const b = await dormantes();
    assert.equal(b.stale_days, 30, 'le brief lit le même réglage');
    assert.ok(!b.stale_mrs.some((m) => m.id === mrId));
  });

  test('on le rebaisse à 5 : la MR reviewée il y a 8 jours redevient dormante dans le brief, et l’écran relu le confirme', async () => {
    await enregistrer(5);
    await attendreServeur(async () => (await valeurServeur()) === 5, 'le serveur retient 5');
    await page.reload();
    await page.waitForSelector('nav button[data-tab="admin"]');
    await ouvrir('mr');
    assert.equal(await champ().inputValue(), '5');
    const b = await dormantes();
    assert.equal(b.stale_days, 5);
    assert.ok(b.stale_mrs.some((m) => m.id === mrId), 'dormante à 5 jours');
  });

  test('les bornes : le champ refuse 0 et 400 (rien n’est enregistré), accepte 1 et 90 — relus après rechargement', async () => {
    for (const [hors, raison] of [['400', 'rangeOverflow'], ['0', 'rangeUnderflow']]) {
      await enregistrer(hors);
      assert.equal(await champ().evaluate((e, r) => e.validity[r], raison), true, `${hors} : le navigateur le refuse (${raison})`);
      assert.equal(await valeurServeur(), 5, `${hors} : rien n’est parti vers le serveur`);
    }
    for (const borne of [90, 1]) {
      await enregistrer(borne);
      await attendreServeur(async () => (await valeurServeur()) === borne, `la borne ${borne} est acceptée`);
      await page.reload();
      await page.waitForSelector('nav button[data-tab="admin"]');
      await ouvrir('mr');
      assert.equal(await champ().inputValue(), String(borne), `${borne} réaffiché après rechargement`);
    }
  });

  test('indépendance : enregistrer ce champ ne touche pas au rafraîchissement automatique voisin', async () => {
    await ouvrir('mr');
    await page.locator('#sub-mr [name="auto_refresh_minutes"]').fill('15');
    await champ().fill('12');
    await page.locator('#sub-mr button[type="submit"][form="configForm"]').first().click();
    await attendreServeur(async () => (await valeurServeur()) === 12 && Number((await app.api('GET', '/api/config')).body.auto_refresh_minutes) === 15, 'les deux sont retenus ensemble');
    await page.reload();
    await page.waitForSelector('nav button[data-tab="admin"]');
    await ouvrir('mr');
    assert.equal(await champ().inputValue(), '12');
    assert.equal(await page.locator('#sub-mr [name="auto_refresh_minutes"]').inputValue(), '15');
  });

  test('aucune erreur de page pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
