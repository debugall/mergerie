'use strict';
/* L'ERGONOMIE DE « ENREGISTRER » dans Réglages → Sessions IA. Cinq sections, un seul /config : il y avait cinq boutons identiques — et la confirmation n'apparaissait
   que près de l'un d'eux. Désormais UN bouton, dans une barre collée au bas de l'écran, qui dit « modifications non enregistrées » dès qu'on change un champ, puis
   « enregistré » (mention ET toast). Chaque geste est jugé sur son EFFET : ce que le serveur retient, ce que l'écran réaffiche après rechargement. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Réglages → Sessions IA : un seul « Enregistrer », sa barre, sa confirmation', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 700 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });
  after(async () => { if (navigateur) await navigateur.close(); if (app) await app.stop(); });

  const config = async () => (await app.api('GET', '/api/config')).body;
  const ouvrir = async () => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator('#tab-admin .subnav [data-sub="aisession"]').click();
    await page.waitForSelector('#sub-aisession.active');
    await page.waitForSelector('#sub-aisession .scope-badge');
    await page.waitForLoadState('networkidle');
  };
  const recharger = async () => { await page.reload(); await page.waitForSelector('nav button[data-tab="admin"]'); await ouvrir(); };
  const champ = (nom) => page.locator(`#sub-aisession [name="${nom}"]`);
  const barre = () => page.locator('#aiSaveBar');
  const mention = () => page.locator('#configInfoAi');

  test('un seul bouton « Enregistrer » pour les réglages de l’onglet, dans une barre collée en bas — visible sans défiler', async () => {
    await ouvrir();
    assert.equal(await page.locator('#sub-aisession button[type="submit"][form="configForm"]').count(), 1, 'un seul bouton, plus un par section');
    assert.equal(await barre().evaluate((e) => getComputedStyle(e).position), 'sticky');
    // L'onglet est plus haut que la fenêtre (700 px) : la barre est pourtant à l'écran, sans défiler.
    assert.ok(await page.locator('#sub-aisession').evaluate((e) => e.scrollHeight) > 700, 'l’onglet est long');
    const bas = await barre().evaluate((e) => e.getBoundingClientRect().bottom);
    assert.ok(bas <= 700 + 1 && bas > 0, `la barre est dans la fenêtre (bas à ${Math.round(bas)} px)`);
    assert.equal(await page.locator('#aiSaveBtn').isVisible(), true);
  });

  test('changer un champ : la barre dit « modifications non enregistrées » et le bouton est marqué ; enregistrer : un toast, la mention, le marquage levé', async () => {
    await ouvrir();
    assert.equal(((await mention().innerText()) || '').trim(), '', 'rien à dire tant qu’on n’a rien changé');
    await champ('agent_max_turns').fill('173');
    await page.waitForFunction(() => document.querySelector('#configInfoAi').classList.contains('form-info-dirty'));
    assert.ok((await mention().innerText()).length > 5, 'la mention annonce des modifications non enregistrées');
    assert.equal(await page.locator('#aiSaveBtn').evaluate((e) => e.classList.contains('is-dirty')), true);

    await page.locator('#aiSaveBtn').click();
    await page.waitForSelector('#toasts .toast:not(.err)');
    assert.match(await page.locator('#toasts .toast:not(.err)').first().innerText(), /enregistré|saved/i, 'un toast de succès');
    await attendreServeur(async () => Number((await config()).agent_max_turns) === 173, 'le serveur retient 173');
    await page.waitForFunction(() => /enregistré|saved/i.test(document.querySelector('#configInfoAi').textContent));
    assert.equal(await mention().evaluate((e) => e.classList.contains('form-info-dirty')), false, 'plus de marquage « non enregistré »');
    assert.equal(await page.locator('#aiSaveBtn').evaluate((e) => e.classList.contains('is-dirty')), false);
  });

  test('un seul clic enregistre les champs de TOUTES les sections de l’onglet, relus après rechargement', async () => {
    await ouvrir();
    await champ('task_default_auto_push').setChecked(true);                       // Nouvelle session — cases cochées d'office
    await champ('ai_extra_instructions').fill('Réponds en français.');            // Consignes permanentes
    await champ('agent_daily_budget_usd').fill('3.5');                            // Bornes du jour
    await champ('agent_mode').selectOption('secure');                             // Sécurisé ou yolo — ce qui montre le sandbox
    await page.waitForSelector('#sandboxDetails:not([hidden])');
    await champ('agent_write_mode').selectOption('allowlist');                    // Sandbox de l'agent en écriture
    await champ('agent_sandbox_network_domains').fill('registry.npmjs.org\npypi.org');
    await page.locator('#aiSaveBtn').click();
    await attendreServeur(async () => {
      const c = await config();
      return String(c.task_default_auto_push) === '1' && c.ai_extra_instructions === 'Réponds en français.' && Number(c.agent_daily_budget_usd) === 3.5
        && c.agent_mode === 'secure' && c.agent_write_mode === 'allowlist' && c.agent_sandbox_network_domains === 'registry.npmjs.org\npypi.org';
    }, 'les cinq sections sont enregistrées d’un seul clic');
    await recharger();
    assert.equal(await champ('task_default_auto_push').isChecked(), true);
    assert.equal(await champ('ai_extra_instructions').inputValue(), 'Réponds en français.');
    assert.equal(await champ('agent_daily_budget_usd').inputValue(), '3.5');
    assert.equal(await champ('agent_mode').inputValue(), 'secure');
    assert.equal(await champ('agent_write_mode').inputValue(), 'allowlist');
    assert.equal(await champ('agent_sandbox_network_domains').inputValue(), 'registry.npmjs.org\npypi.org');
  });

  test('hors bornes : le serveur ramène la valeur (-5 → 200), et l’écran réaffiche ce que le serveur tient, pas ce qui a été tapé', async () => {
    await ouvrir();
    await page.evaluate(() => { const e = document.querySelector('#sub-aisession [name="agent_max_turns"]'); e.removeAttribute('min'); e.removeAttribute('max'); });
    await champ('agent_max_turns').fill('-5');
    await page.locator('#aiSaveBtn').click();
    await attendreServeur(async () => Number((await config()).agent_max_turns) === 200, 'ramené à 200 par le serveur');
    await recharger();
    assert.equal(await champ('agent_max_turns').inputValue(), '200');
  });

  test('un refus du serveur (une modification restée dans un autre onglet) : toast d’ERREUR, jamais un faux « enregistré », et le marquage « non enregistré » reste', async () => {
    await ouvrir();
    // Un gabarit Jira sans {url} (champ d'un autre onglet, même formulaire) : le serveur le refuse.
    await page.evaluate(() => {
      const e = document.querySelector('#configForm [name="jira_notify_template"]') || document.querySelector('[form="configForm"][name="jira_notify_template"]');
      e.value = 'sans lien'; e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#configInfoAi').classList.contains('form-info-dirty'));
    await page.locator('#aiSaveBtn').click();
    await page.waitForSelector('#toasts .toast.err');
    assert.equal(await page.locator('#toasts .toast:not(.err)').count(), 0, 'aucun toast de succès');
    assert.ok(!/enregistré ✓|saved ✓/.test(await mention().innerText()), 'la mention ne dit pas « enregistré »');
    assert.equal(await mention().evaluate((e) => e.classList.contains('form-info-dirty')), true, 'ce qui n’est pas parti reste annoncé');
    assert.equal(((await config()).jira_notify_template || ''), '', 'rien n’est enregistré');
  });

  test('le bouton du formulaire des binaires (formulaire à part, autre route) reste le sien, distinct de la barre', async () => {
    await ouvrir();
    await page.locator('#cliAdd').click();
    await page.waitForSelector('#cliForm:not([hidden])');
    assert.equal(await page.locator('#cliForm button[type="submit"]').count(), 1);
    assert.equal(await page.locator('#cliForm button[type="submit"]').evaluate((e) => e.getAttribute('form')), null, 'il envoie SON formulaire (/api/agent-clis), pas /config');
  });

  test('aucune erreur de page pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
