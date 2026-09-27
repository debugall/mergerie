'use strict';
/* MENU « JIRA » → « SURVEILLÉS » — AJOUTER, VÉRIFIER, RÉGLER CHAQUE TICKET.
 *
 * Ce que `e2e-jira-watch-ui` ne fait pas : la barre d'ajout (bouton, Entrée dans la clé,
 * Ctrl+Entrée dans la raison, clé mise en majuscules, refus d'une clé invalide, d'un doublon,
 * d'un ticket introuvable), l'état vide et la pastille du sous-onglet, « Vérifier maintenant »
 * (aucun changement / un changement / un ticket devenu injoignable), la case « en faire une
 * todo au changement d'état » jusqu'à la todo elle-même, « Annuler » et « Enregistrer » la
 * raison à la souris, le lien vers Jira de la carte, et les actions du détail QUAND il est
 * ouvert dans « Surveillés » (ne plus surveiller, changer l'état) — qui doivent recharger ce
 * panneau-ci, pas l'autre (deux tests `todo` : ce n'est pas le cas aujourd'hui).
 *
 * Déjà prouvés dans `e2e-jira-watch-ui` : sélectionner / changer de ticket, les contrôles de la
 * carte qui n'ouvrent pas le détail, retirer le ticket affiché, la raison sur plusieurs lignes
 * et Ctrl+Entrée / Échap sur la carte, le rendu d'une description technique, les tickets liés,
 * la sélection propre à chaque sous-onglet.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });

describe('Menu Jira — Surveillés : ajouter, vérifier, régler', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  const surveilles = async () => (await app.api('GET', '/api/jira/watch')).body.watched;
  const ligne = async (cle) => (await surveilles()).find((w) => w.key === cle);
  const carte = (cle) => page.locator(`#jiraWatchList [data-jirawatchopen="${cle}"]`);
  const toast = (motif, err = false) => page.waitForFunction(([m, e]) => [...document.querySelectorAll(e ? '.toast.err' : '.toast')]
    .some((t) => new RegExp(m).test(t.textContent)), [motif, err]);

  async function ouvrirSurveilles() {
    await page.evaluate(() => { try { localStorage.removeItem('aidevtools_tab'); } catch { /* rien */ } });
    await page.reload();
    await page.locator('nav button[data-tab="jira"]').click();
    await page.locator('#tab-jira .subnav [data-jsub="watch"]').click();
    await page.locator('#jiraSubWatch').waitFor({ state: 'visible' });
    await page.waitForSelector('#jiraWatchList .jira-item, #jiraWatchList .empty');
  }

  before(async () => {
    app = await startApp();
    const ticket = (cle, resume, st) => {
      app.state.jiraIssues[cle] = { key: cle, fields: { summary: resume, status: st, issuetype: { name: 'Tâche' }, description: `Description de ${cle}.` } };
    };
    ticket('PROJ-20', 'Brancher le nouveau PSP', etat('À faire', 'new'));
    ticket('PROJ-21', 'Documenter l’API de remboursement', etat('À faire', 'new'));
    ticket('PROJ-22', 'Migrer la file des webhooks', etat('À faire', 'new'));
    ticket('OPS-5', 'Ouvrir le port du PSP', etat('En cours', 'indeterminate'));
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  test('sans ticket surveillé : un état vide, et pas de pastille', async () => {
    await ouvrirSurveilles();
    assert.match(await page.locator('#jiraWatchList').innerText(), /Aucun ticket surveillé/);
    assert.equal(await page.locator('#jiraWatchCount').isHidden(), true);
  });

  test('« Surveiller » : la clé passe en majuscules, la raison est gardée, les champs se vident', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchKey').fill('proj-20');
    await page.locator('#jiraWatchNote').fill('bloque la mise en production');
    await page.locator('#jiraWatchAdd').click();
    await attendreServeur(async () => !!(await ligne('PROJ-20')), 'PROJ-20 est surveillé');
    assert.equal((await ligne('PROJ-20')).note, 'bloque la mise en production');
    await toast('PROJ-20 est maintenant surveillé');

    await carte('PROJ-20').waitFor();
    const texte = await carte('PROJ-20').textContent();
    assert.match(texte, /Brancher le nouveau PSP/);
    assert.match(texte, /À faire/, 'l’état relevé à l’ajout');
    assert.match(texte, /bloque la mise en production/);
    assert.match(texte, /aucun changement depuis l'ajout/);
    assert.match(await carte('PROJ-20').locator('a.jira-key-link').getAttribute('href'), /\/browse\/PROJ-20$/, 'la clé mène au ticket dans Jira');
    assert.equal(await page.locator('#jiraWatchKey').inputValue(), '');
    assert.equal(await page.locator('#jiraWatchNote').inputValue(), '');
    await page.waitForFunction(() => document.querySelector('#jiraWatchCount').textContent === '1' && !document.querySelector('#jiraWatchCount').hidden);
  });

  test('Entrée dans la clé ajoute ; Ctrl+Entrée dans la raison aussi, Entrée seule y passe à la ligne', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchKey').fill('PROJ-21');
    await page.locator('#jiraWatchKey').press('Enter');
    await attendreServeur(async () => !!(await ligne('PROJ-21')), 'Entrée ajoute');
    // L'ajout est fini quand le champ est vidé et le bouton rendu : avant, une seconde saisie
    // tomberait sur un bouton encore occupé.
    await page.waitForFunction(() => document.querySelector('#jiraWatchKey').value === '' && !document.querySelector('#jiraWatchAdd').disabled);

    await page.locator('#jiraWatchKey').fill('OPS-5');
    await page.locator('#jiraWatchNote').click();
    await page.keyboard.type('attendre l’ouverture');
    await page.keyboard.press('Enter');
    await page.keyboard.type('puis relancer');
    assert.equal(await ligne('OPS-5'), undefined, 'Entrée seule n’envoie rien depuis la raison');
    await page.keyboard.press('ControlOrMeta+Enter');
    await attendreServeur(async () => !!(await ligne('OPS-5')), 'Ctrl+Entrée ajoute');
    assert.equal((await ligne('OPS-5')).note, 'attendre l’ouverture\npuis relancer');
    await page.waitForFunction(() => document.querySelector('#jiraWatchCount').textContent === '3');
  });

  test('clé invalide, doublon, ticket introuvable : refusés avec leur raison', async () => {
    await ouvrirSurveilles();
    const avant = (await surveilles()).length;
    await page.locator('#jiraWatchKey').fill('pas une clé');
    await page.locator('#jiraWatchAdd').click();
    await toast('Clé de ticket invalide', true);

    await page.locator('#jiraWatchKey').fill('PROJ-20');
    await page.locator('#jiraWatchAdd').click();
    await toast('déjà surveillé', true);

    await page.locator('#jiraWatchKey').fill('NOPE-9');
    await page.locator('#jiraWatchAdd').click();
    await toast('NOPE-9 introuvable', true);
    assert.equal((await surveilles()).length, avant, 'rien n’a été ajouté');
    assert.equal(await page.locator('#jiraWatchKey').inputValue(), 'NOPE-9', 'la saisie refusée reste à corriger');
  });

  test('« Vérifier maintenant » : rien ne bouge, puis un changement d’état', async () => {
    await ouvrirSurveilles();
    await page.locator('#jiraWatchCheck').click();
    await toast('Aucun changement d\'état');

    app.state.jiraIssues['PROJ-20'].fields.status = etat('En revue', 'indeterminate');
    await page.locator('#jiraWatchCheck').click();
    await toast('1 changement d\'état');
    assert.equal((await ligne('PROJ-20')).status, 'En revue');
    await page.waitForFunction(() => {
      const c = document.querySelector('#jiraWatchList [data-jirawatchopen="PROJ-20"]');
      return c && /En revue/.test(c.textContent) && /dernier changement/.test(c.textContent);
    });
  });

  test('« En faire une todo » : la case est gardée, et le changement suivant crée la todo', async () => {
    await ouvrirSurveilles();
    await carte('PROJ-21').locator('[data-jiratodo]').click();
    await attendreServeur(async () => (await ligne('PROJ-21')).todo_on_change === 1, 'la case est enregistrée');
    await ouvrirSurveilles();
    assert.equal(await carte('PROJ-21').locator('[data-jiratodo]').isChecked(), true, 'relue cochée au rechargement');

    app.state.jiraIssues['PROJ-21'].fields.status = etat('Terminé', 'done');
    await page.locator('#jiraWatchCheck').click();
    let todo;
    await attendreServeur(async () => {
      todo = (await app.api('GET', '/api/todos')).body.todos.find((x) => /PROJ-21/.test(x.title));
      return !!todo;
    }, 'la todo du changement d’état existe');
    assert.match(todo.title, /À faire.*Terminé|Terminé/);

    // Et la décocher tient aussi.
    await carte('PROJ-21').locator('[data-jiratodo]').click();
    await attendreServeur(async () => (await ligne('PROJ-21')).todo_on_change === 0, 'la case décochée est enregistrée');
  });

  test('un ticket devenu injoignable affiche son erreur sur la carte', async () => {
    if (!(await ligne('OPS-5'))) await app.api('POST', '/api/jira/watch', { key: 'OPS-5' });
    const garde = app.state.jiraIssues['OPS-5'];
    delete app.state.jiraIssues['OPS-5'];
    try {
      await ouvrirSurveilles();
      await page.locator('#jiraWatchCheck').click();
      await page.waitForFunction(() => /La surveillance échoue/.test(
        document.querySelector('#jiraWatchList [data-jirawatchopen="OPS-5"]')?.textContent || '',
      ));
      assert.ok((await ligne('OPS-5')).error, 'l’erreur est rangée sur la ligne');
      assert.match(await carte('OPS-5').textContent(), /En cours/, 'le dernier état connu n’est pas perdu');
    } finally {
      app.state.jiraIssues['OPS-5'] = garde;
    }
    await page.locator('#jiraWatchCheck').click();
    await attendreServeur(async () => !(await ligne('OPS-5')).error, 'l’erreur disparaît quand le ticket revient');
  });

  test('la raison : « Annuler » rétablit, « Enregistrer » écrit', async () => {
    await ouvrirSurveilles();
    const avant = (await ligne('PROJ-20')).note;
    await carte('PROJ-20').locator('[data-jiranote]').click();
    const champ = carte('PROJ-20').locator('.jira-note-input');
    await champ.fill('raison abandonnée');
    await carte('PROJ-20').locator('[data-jiranotecancel]').click();
    await page.waitForSelector('#jiraWatchList [data-jiranoteform="PROJ-20"][hidden]', { state: 'attached' });
    assert.equal((await ligne('PROJ-20')).note, avant);
    await carte('PROJ-20').locator('[data-jiranote]').click();
    assert.equal(await champ.inputValue(), avant, 'rouvert, le champ montre la raison enregistrée');

    await champ.fill('prévenir l’équipe paiement');
    await carte('PROJ-20').locator('[data-jiranotesave]').click();
    await attendreServeur(async () => (await ligne('PROJ-20')).note === 'prévenir l’équipe paiement', 'la raison est écrite');
    await toast('Raison enregistrée pour PROJ-20');
    await page.waitForFunction(() => /prévenir l’équipe paiement/.test(document.querySelector('#jiraWatchList [data-jirawatchopen="PROJ-20"] .jira-watch-note')?.textContent || ''));
  });

  /* `ouDuDetail(e)` décide quel panneau recharger d'après `e.currentTarget`… lu APRÈS la
     confirmation (`await confirmDialog`) ou l'appel réseau : l'événement a fini sa propagation,
     `currentTarget` vaut `null`, et c'est toujours « Mes tickets » qui est rechargé. Dans
     « Surveillés », le détail reste sur l'ancien état avec un sélecteur désactivé, et la carte
     ne bouge pas. */
  test('changer l’état depuis le détail ouvert dans « Surveillés » met à jour sa carte', async () => {
    app.state.jiraIssues['PROJ-22'].fields.status = etat('À faire', 'new');
    if (!(await ligne('PROJ-22'))) await app.api('POST', '/api/jira/watch', { key: 'PROJ-22' });
    await ouvrirSurveilles();
    await carte('PROJ-22').locator('.jira-item-summary').click();
    await page.waitForFunction(() => /Migrer la file des webhooks/.test(document.querySelector('#jiraWatchDetail .jira-title')?.textContent || ''));
    await page.locator('#jiraWatchDetail select.jira-transition').selectOption('21');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => app.state.jiraIssues['PROJ-22'].fields.status.name === 'En cours', 'Jira a changé l’état');
    // Le détail a eu tout le temps de se recharger : Jira a répondu, le panneau non.
    await page.waitForFunction(() => /En cours/.test(document.querySelector('#jiraWatchDetail .jira-dhead .jira-status')?.textContent || ''), null, { timeout: 10000 });
    await page.waitForFunction(() => /En cours/.test(document.querySelector('#jiraWatchList [data-jirawatchopen="PROJ-22"] .jira-status')?.textContent || ''), null, { timeout: 10000 });
    assert.equal(await page.locator('#jiraSubWatch').isVisible(), true, 'on reste dans « Surveillés »');
  });

  test('« Surveillé » dans le détail retire le ticket de la liste où l’on est', async () => {
    if (!(await ligne('PROJ-22'))) await app.api('POST', '/api/jira/watch', { key: 'PROJ-22' });
    await ouvrirSurveilles();
    await carte('PROJ-22').locator('.jira-item-summary').click();
    await page.waitForSelector('#jiraWatchDetail [data-jirawatch="PROJ-22"].active');
    await page.locator('#jiraWatchDetail [data-jirawatch="PROJ-22"]').click();
    await attendreServeur(async () => !(await ligne('PROJ-22')), 'PROJ-22 n’est plus surveillé');
    await carte('PROJ-22').waitFor({ state: 'detached' });
    await toast('PROJ-22 n\'est plus surveillé');
    assert.equal(await page.locator('#jiraSubWatch').isVisible(), true, 'on reste dans « Surveillés »');
  });

  // Même cause que plus haut : c'est le détail de « Mes tickets » qui est redessiné.
  test('après « ne plus surveiller », le détail ouvert propose de surveiller à nouveau', async () => {
    if (!(await ligne('PROJ-22'))) await app.api('POST', '/api/jira/watch', { key: 'PROJ-22' });
    await ouvrirSurveilles();
    await carte('PROJ-22').locator('.jira-item-summary').click();
    await page.waitForSelector('#jiraWatchDetail [data-jirawatch="PROJ-22"].active');
    await page.locator('#jiraWatchDetail [data-jirawatch="PROJ-22"]').click();
    await attendreServeur(async () => !(await ligne('PROJ-22')), 'PROJ-22 n’est plus surveillé');
    await carte('PROJ-22').waitFor({ state: 'detached' });
    await page.waitForFunction(() => {
      const b = document.querySelector('#jiraWatchDetail [data-jirawatch="PROJ-22"]');
      return b && !b.classList.contains('active') && /Surveiller/.test(b.textContent);
    }, null, { timeout: 10000 });
  });

  test('aucune erreur JavaScript', () => {
    assert.deepEqual(erreurs, []);
  });
});
