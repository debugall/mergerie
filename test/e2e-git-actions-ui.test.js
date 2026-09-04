'use strict';
/* Git · Actions — le champ de branche montre-t-il le nom EN ENTIER ?
 *
 * Ce n'est pas une coquetterie de mise en page. Le champ est un `<input>` : quand le nom
 * dépasse sa largeur, la fin sort du champ sans coupure visible, sans ellipse, sans rien qui
 * dise qu'il manque quelque chose. On croit lire `feature/PROJ-1408-integration-partenaire`
 * et on prévisualise une opération sur une AUTRE branche. Le champ tenait 180 px de base et
 * se partageait la place à égalité avec le dépôt, alors qu'un nom de branche est deux fois
 * plus long qu'un nom de projet.
 *
 * La mesure porte sur ce que voit l'œil (`scrollWidth` contre `clientWidth`), pas sur un
 * nombre de pixels écrit en dur : une largeur figée dans le test se démoderait au premier
 * changement de gouttière, et ne dirait toujours rien sur la lisibilité.
 *
 * Chromium vient de la dépendance de développement `playwright` ; le fichier se déclare
 * ignoré s'il n'a jamais été téléchargé.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

// 59 caractères — la longueur d'une vraie branche de correction, pas un cas d'école.
const LONGUE = 'hotfix/COMPTA-2210-correction-arrondi-echeances-fractionnees';

describe('Git · Actions — largeur du champ de branche', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;
  let page;

  before(async () => {
    app = await startApp();
    await app.configure();
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')), { branch: LONGUE });
    await app.api('POST', '/api/repos', { url: depot.url, project: 'groupe/comptabilite' });
    navigateur = await chromium.launch();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
    /* Les refs viennent de l'API de la forge, pas d'un clone : sans GitLab ni GitHub en face,
       la liste revient vide et il n'y a rien à mesurer. On répond donc à sa place — ce qui
       est testé ici, c'est la mise en page du champ, pas le client de forge (couvert
       ailleurs). Le reste du chemin est bien celui de l'application : `gitLoadRefs`,
       `wireCombo`, le clic sur l'option, puis `gitFillRow`. */
    await page.route('**/api/git/refs*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'branches',
        default: 'main',
        refs: [
          { name: 'main', sha: 'a'.repeat(40), default: true, protected: true, merged: false, date: '2026-08-01T10:00:00Z' },
          { name: LONGUE, sha: 'b'.repeat(40), default: false, protected: false, merged: false, date: '2026-08-02T10:00:00Z' },
        ],
      }),
    }));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="git"]').click();
    await page.locator('#tab-git .subnav [data-gsub="actions"]').click();
    await page.waitForSelector('#gitTargetRows .git-row');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /** Choisit la branche longue dans la première ligne d'action.
      Le dépôt, lui, est déjà posé : `repoComboHtml` retient le premier de la liste, et il
      n'y en a qu'un ici. */
  async function choisirLaBrancheLongue() {
    const ligne = page.locator('#gitTargetRows .git-row').first();
    assert.equal(await ligne.locator('.repo-combo .rc-search').inputValue(), 'groupe/comptabilite');
    await ligne.locator('.git-ref-combo [data-combo="git-ref"]').click();
    /* Le clonage précède le chargement des refs : on attend l'OPTION, pas un délai. */
    const option = ligne.locator('.git-ref-combo .combo-opt', { hasText: LONGUE }).first();
    await option.waitFor({ timeout: 60000 });
    await option.click();
    return ligne.locator('.git-ref-combo [data-combo="git-ref"]');
  }

  test('un nom de branche de soixante caractères tient dans le champ', async () => {
    const champ = await choisirLaBrancheLongue();
    assert.equal(await champ.inputValue(), LONGUE, 'la branche choisie doit être celle qu’on a cliquée');
    const m = await champ.evaluate((e) => ({ vu: e.clientWidth, texte: e.scrollWidth }));
    assert.ok(m.texte <= m.vu + 1,
      `le nom déborde du champ : ${m.texte} px de texte pour ${m.vu} px visibles`);
  });

  test('le champ de branche n’est pas plus étroit que celui du dépôt', async () => {
    // L'invariant qui survit aux changements de gouttière : un nom de branche est plus long
    // qu'un nom de projet, il ne peut pas recevoir moins de place.
    const ligne = page.locator('#gitTargetRows .git-row').first();
    const [depot, branche] = await Promise.all([
      ligne.locator('.repo-combo').evaluate((e) => e.getBoundingClientRect().width),
      ligne.locator('.git-ref-combo').evaluate((e) => e.getBoundingClientRect().width),
    ]);
    assert.ok(branche >= depot, `branche ${Math.round(branche)} px < dépôt ${Math.round(depot)} px`);
  });

  test('le nom à créer passe à la ligne plutôt que de rogner la branche', async () => {
    // « Un nom par projet » ajoute un troisième champ : s'il reste sur la ligne, il reprend
    // à la branche ce qu'on vient de lui donner.
    await page.locator('#gitSameName').click();
    const ligne = page.locator('#gitTargetRows .git-row').first();
    await ligne.locator('.git-name').waitFor();
    const m = await ligne.evaluate((row) => {
      const r = (s) => row.querySelector(s).getBoundingClientRect();
      const champ = row.querySelector('.git-ref-combo [data-combo="git-ref"]');
      return {
        brancheEnHaut: Math.round(r('.git-name').top) > Math.round(r('.git-ref-combo').top),
        boutonAvecLeNom: Math.round(r('[data-gitrm]').top) === Math.round(r('.git-name').top),
        vu: champ.clientWidth, texte: champ.scrollWidth,
      };
    });
    assert.ok(m.brancheEnHaut, 'le nom à créer doit descendre sous les deux listes');
    assert.ok(m.boutonAvecLeNom, 'le bouton de suppression suit le nom, il ne part pas seul sur une 3e ligne');
    assert.ok(m.texte <= m.vu + 1, `le nom de branche déborde encore : ${m.texte} px pour ${m.vu} px`);
    await page.locator('#gitSameName').click();   // on rend l'écran tel qu'on l'a trouvé
  });
});
