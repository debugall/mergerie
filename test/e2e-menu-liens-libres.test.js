'use strict';
/* MENU LIENS — LES LIENS LIBRES, LE COLLAGE, LE RANGEMENT ET L'IMPORT, dans un vrai navigateur.
 *
 * Ce que les fichiers voisins ne prouvaient pas par l'écran :
 *   - la fiche d'un lien libre : les deux refus sous leur champ (dans l'ordre des champs),
 *     « Annuler » qui n'écrit rien, Entrée qui enregistre libellé et tags, « Supprimer » confirmé ;
 *   - un lien libre ouvert d'un clic sur son nom (l'ouverture compte) et copié au survol ;
 *   - le bouton d'un dossier qui plie et déplie ses sous-dossiers, sans refermer le dossier ;
 *   - ranger PLUSIEURS liens d'un coup dans un NOUVEAU service : nom proposé depuis le préfixe
 *     commun, « Tout ranger dans », un environnement par ligne, et « ne pas affecter » qui
 *     laisse le lien libre ;
 *   - le collage : ligne invalide nommée, compte sur le bouton, service existant choisi dans le
 *     sélecteur à recherche, nouvel environnement créé au passage, tags d'un lien libre ;
 *     « Annuler » qui ne pose rien ;
 *   - l'import avec la grille PROPOSÉE : la case qui la refuse rend les dossiers absorbés,
 *     l'état intermédiaire de la case d'un dossier, deux lignes réunies puis renommées,
 *     « Tout cocher » / « Tout décocher », et le rejeu qui dit ce qui était déjà là.
 *
 * Un seul `startApp()` : les tests partagent l'app et le navigateur, et se suivent. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, afficherMenusOptionnels, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

/* Un export de marque-pages dont l'arbre décrit une grille : deux services (`bo`, `api`) sur
   trois environnements (`pprod` et `preprod` n'en font qu'un), plus un dossier `doc` sans
   environnement, qui reste en lien libre. */
const ARBRE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Barre de favoris</H3>
  <DL><p>
    <DT><H3>app</H3>
    <DL><p>
      <DT><H3>dev</H3><DL><p>
        <DT><A HREF="https://bo-dev.demo.invalid/">bo dev</A>
        <DT><A HREF="https://api-dev.demo.invalid/">api</A>
      </DL><p>
      <DT><H3>pprod</H3><DL><p>
        <DT><A HREF="https://bo-pprod.demo.invalid/">bo pprod</A>
        <DT><A HREF="https://api-pprod.demo.invalid/">api</A>
      </DL><p>
      <DT><H3>preprod</H3><DL><p>
        <DT><A HREF="https://bo-preprod.demo.invalid/">bo preprod</A>
      </DL><p>
      <DT><H3>prod</H3><DL><p>
        <DT><A HREF="https://bo-prod.demo.invalid/">bo prod</A>
        <DT><A HREF="https://api-prod.demo.invalid/">api</A>
      </DL><p>
    </DL><p>
    <DT><H3>doc</H3><DL><p>
      <DT><A HREF="https://confluence.demo.invalid/x">Confluence</A>
    </DL><p>
  </DL><p>
</DL><p>`;

/* L'APPLICATION ROUVRE ELLE-MÊME LE DERNIER ONGLET, après avoir lu `/api/config` : cliquer
   « Liens » juste après un rechargement lance DEUX chargements de la grille, et le second —
   arrivé tard sur un runner chargé — efface ce que le test vient d'ouvrir (un panneau, une
   fiche). On pose donc « Liens » comme dernier onglet avant chaque chargement, et l'on attend
   que l'application y atterrisse, au lieu de cliquer. */
async function atterrirSurLiens(page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('aidevtools_tab', 'links'); } catch { /* stockage refusé */ }
  });
}

describe('Menu Liens : liens libres, collage, rangement et import', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const envs = {};
  let apiCore;
  const erreurs = [];

  const grille = async () => (await app.api('GET', '/api/links/grid')).body;
  const libre = async (label) => (await grille()).free_links.find((l) => l.label === label);

  before(async () => {
    app = await startApp();
    await app.configure();
    for (const [name, color] of [['dev', '#2f6fe0'], ['prod', '#b91c1c']]) {
      envs[name] = (await app.api('POST', '/api/environments', { name, color })).body;
    }
    apiCore = (await app.api('POST', '/api/services', { name: 'api-core', tags: 'backend' })).body;
    for (const l of [
      { label: 'Kibana dev', url: 'https://kibana-dev.demo.invalid/app', tags: 'logs' },
      { label: 'Kibana prod', url: 'https://kibana-prod.demo.invalid/app', tags: 'logs' },
      { label: 'Kibana recette', url: 'https://kibana-rec.demo.invalid/app' },
      { label: 'Jetable', url: 'https://jetable.demo.invalid/' },
      { label: 'Charte', url: 'https://charte.demo.invalid/', folder: 'doc' },
      { label: 'Runbook', url: 'https://run.demo.invalid/', folder: 'doc/astreinte' },
      { label: 'Specs', url: 'https://specs.demo.invalid/', folder: 'doc/specs' },
    ]) {
      const r = await app.api('POST', '/api/free-links', l);
      assert.equal(r.status, 200, r.text);
    }

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
    await afficherMenusOptionnels(page);
    await atterrirSurLiens(page);
    page.on('pageerror', (e) => erreurs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
    await page.goto(app.base);
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const ouvrirLiens = async () => {
    await page.reload();
    // Pas de clic : l'application rouvre « Liens » d'elle-même (voir `atterrirSurLiens`).
    await page.waitForSelector('#tab-links.active');
    await page.waitForSelector('#linkGrid .link-grid');
    await page.waitForSelector('#linkFreeList .link-free-row', { state: 'attached' });
  };
  const ligneLibre = (label) => page.locator('#linkFreeList .link-free-row').filter({ has: page.locator('.link-free-label', { hasText: label }) });
  const attendreToast = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.toast .toast-msg')]
    .some((t) => new RegExp(src).test(t.textContent)), re.source);
  const ouvrirFiche = async (label) => {
    await ligneLibre(label).hover();
    await ligneLibre(label).locator('[data-editfree]').click();
    await page.waitForSelector('#freeLinkModal:not([hidden])');
  };

  /* ------------------------------------------------- la fiche d'un lien libre ---- */

  test('la fiche d’un lien libre refuse une adresse ou un libellé vide, sous le bon champ', async () => {
    await ouvrirLiens();
    await ouvrirFiche('Kibana dev');
    assert.equal((await page.locator('#freeLinkTitle').innerText()).trim(), 'Modifier le lien');
    assert.equal(await page.locator('#freeUrl').inputValue(), 'https://kibana-dev.demo.invalid/app');
    assert.equal(await page.locator('#freeTags').inputValue(), 'logs');

    // Les deux vides : c'est l'adresse, premier champ, qui est signalée d'abord.
    await page.locator('#freeUrl').fill('');
    await page.locator('#freeLabel').fill('');
    await page.locator('#freeSave').click();
    await page.waitForSelector('#freeUrl-err');
    assert.match(await page.locator('#freeUrl-err').innerText(), /Une adresse est requise/);
    assert.equal(await page.locator('#freeLinkModal').isVisible(), true, 'la fiche reste ouverte');

    await page.locator('#freeUrl').fill('https://kibana-dev.demo.invalid/app');
    await page.locator('#freeSave').click();
    await page.waitForSelector('#freeLabel-err');
    assert.match(await page.locator('#freeLabel-err').innerText(), /Un libellé est requis/);
    assert.equal((await libre('Kibana dev')).url, 'https://kibana-dev.demo.invalid/app', 'rien n’a été écrit');

    // « Annuler » ne garde rien de ce qu'on a tapé.
    await page.locator('#freeLabel').fill('jamais');
    await page.locator('#freeCancel').click();
    await page.waitForSelector('#freeLinkModal', { state: 'hidden' });
    assert.ok(await libre('Kibana dev'));
    assert.equal(await libre('jamais'), undefined);
  });

  test('Entrée enregistre le libellé et les tags d’un lien libre', async () => {
    await ouvrirLiens();
    await ouvrirFiche('Kibana dev');
    await page.locator('#freeLabel').fill('Kibana DEV');
    await page.locator('#freeTags').fill('logs, dev');
    await page.locator('#freeTags').press('Enter');
    await page.waitForSelector('#freeLinkModal', { state: 'hidden' });
    await attendreServeur(async () => Boolean(await libre('Kibana DEV')), 'le lien est renommé');
    assert.deepEqual((await libre('Kibana DEV')).tags, ['logs', 'dev']);
    await page.waitForSelector('#linkFreeList .link-free-label:text-is("Kibana DEV")');
  });

  test('« Supprimer » dans la fiche se confirme', async () => {
    await ouvrirLiens();
    await ouvrirFiche('Jetable');
    assert.equal(await page.locator('#freeDelete').isVisible(), true);
    await page.locator('#freeDelete').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /Supprimer « Jetable » \?/);
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#freeLinkModal', { state: 'hidden' });
    await attendreServeur(async () => !(await libre('Jetable')), 'le lien est supprimé');
    await ligneLibre('Jetable').waitFor({ state: 'detached' });
  });

  test('un lien libre s’ouvre d’un clic sur son nom (l’ouverture compte), et se copie au survol', async () => {
    await ouvrirLiens();
    // Le lien s'ouvre AILLEURS : on neutralise la navigation, pas l'écouteur qui note l'usage.
    await page.evaluate(() => {
      window.__ouverts = [];
      window.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[target="_blank"]');
        if (a) { e.preventDefault(); window.__ouverts.push(a.href); }
      }, true);
    });
    await ligneLibre('Kibana prod').locator('.link-free-label').click();
    await page.waitForFunction(() => window.__ouverts.includes('https://kibana-prod.demo.invalid/app'));
    await attendreServeur(async () => (await libre('Kibana prod')).uses === 1, 'l’ouverture est comptée');

    await ligneLibre('Kibana prod').hover();
    await ligneLibre('Kibana prod').locator('[data-copy-txt]').click();
    await attendreToast(/Copié : https:\/\/kibana-prod\.demo\.invalid\/app/);
    assert.equal(await page.locator('#freeLinkModal').isHidden(), true, 'copier n’ouvre pas la fiche');
  });

  /* -------------------------------------------------------------- les dossiers ---- */

  test('le bouton d’un dossier déplie puis replie ses sous-dossiers, sans le refermer lui-même', async () => {
    await ouvrirLiens();
    const doc = page.locator('#linkFreeList > details.link-free-group').filter({ has: page.locator(':scope > summary', { hasText: /^doc/ }) });
    assert.equal(await doc.evaluate((d) => d.open), true, 'le premier niveau est ouvert');
    const sous = () => doc.locator('details').evaluateAll((ds) => ds.map((d) => d.open));
    assert.deepEqual(await sous(), [false, false], 'les sous-dossiers sont repliés');
    await doc.locator(':scope > summary [data-foldsub]').click();
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('#linkFreeList > details.link-free-group')]
        .find((x) => /^doc/.test(x.querySelector('summary').textContent.trim()));
      return [...d.querySelectorAll('details')].every((x) => x.open);
    });
    assert.equal(await doc.evaluate((d) => d.open), true, 'le clic sur le bouton ne replie pas le dossier');
    await doc.locator(':scope > summary [data-foldsub]').click();
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('#linkFreeList > details.link-free-group')]
        .find((x) => /^doc/.test(x.querySelector('summary').textContent.trim()));
      return [...d.querySelectorAll('details')].every((x) => !x.open);
    });
    assert.equal(await doc.evaluate((d) => d.open), true);
  });

  /* ------------------------------------------- ranger plusieurs liens d'un coup ---- */

  test('ranger trois liens dans un nouveau service : un environnement par ligne, et « ne pas affecter »', async () => {
    await ouvrirLiens();
    await page.locator('#linkMore').click();
    await page.locator('#linkMoreMenu [data-more="select"]').click();
    await page.waitForFunction(() => document.querySelector('#linkFreeList').classList.contains('mode-select'));
    for (const label of ['Kibana DEV', 'Kibana prod', 'Kibana recette']) {
      await ligneLibre(label).locator('.lfr-pick').click();
    }
    await page.waitForFunction(() => /Ranger 3 liens/.test(document.querySelector('#linkToService').textContent));
    await page.locator('#linkToService').click();
    await page.waitForSelector('#toServiceModal:not([hidden])');

    // Un nouveau service, nommé d'après ce que les libellés ont en commun.
    assert.equal(await page.locator('#toServiceNameRow').isVisible(), true);
    assert.equal(await page.locator('#toServiceName').inputValue(), 'Kibana');
    const ids = Object.fromEntries((await grille()).free_links.map((l) => [l.label, l.id]));

    // « Tout ranger dans » pose la même colonne partout…
    await page.locator('#toServiceAllEnv').selectOption(String(envs.prod.id));
    assert.deepEqual(await page.locator('#toServiceRows [data-mapfree]').evaluateAll((s) => s.map((x) => x.value)),
      [String(envs.prod.id), String(envs.prod.id), String(envs.prod.id)]);
    // …puis chaque ligne se corrige, et « ne pas affecter » laisse le lien là où il est.
    await page.locator(`#toServiceRows [data-mapfree="${ids['Kibana DEV']}"]`).selectOption(String(envs.dev.id));
    await page.locator(`#toServiceRows [data-mapfree="${ids['Kibana recette']}"]`).selectOption('');
    await page.locator('#toServiceOk').click();
    await page.waitForSelector('#toServiceModal', { state: 'hidden' });
    await attendreToast(/2 liens rangés dans « Kibana »/);

    const g = await grille();
    const kibana = g.services.find((s) => s.name === 'Kibana');
    assert.ok(kibana, 'le service est créé');
    assert.deepEqual((kibana.urls[envs.dev.id] || []).map((u) => [u.label, u.url]), [['Kibana DEV', 'https://kibana-dev.demo.invalid/app']]);
    assert.deepEqual((kibana.urls[envs.prod.id] || []).map((u) => [u.label, u.url]), [['Kibana prod', 'https://kibana-prod.demo.invalid/app']]);
    const restants = g.free_links.map((l) => l.label);
    assert.ok(restants.includes('Kibana recette'), 'le lien non affecté reste libre');
    assert.ok(!restants.includes('Kibana DEV') && !restants.includes('Kibana prod'), 'les liens rangés ne sont plus libres');
    // La sélection est terminée : plus de mode, plus de bouton.
    await page.waitForFunction(() => !document.querySelector('#linkFreeList').classList.contains('mode-select'));
    assert.equal(await page.locator('#linkToService').isHidden(), true);
    await page.waitForSelector(`#linkGrid tr[data-service="${kibana.id}"]`);
  });

  /* --------------------------------------------------------------- le collage ---- */

  test('coller : la ligne invalide est nommée, un service existant se choisit, un environnement se crée', async () => {
    await ouvrirLiens();
    await page.locator('#linkPaste').click();
    await page.waitForSelector('#pasteModal:not([hidden])');
    assert.equal(await page.locator('#pasteOk').isDisabled(), true, 'rien à ajouter tant que rien n’est collé');
    assert.equal(await page.locator('#pasteEmpty').isVisible(), true);

    await page.locator('#pasteText').fill([
      'pas une adresse',
      'https://sonar-dev.demo.invalid/projet',
      'https://suivi.demo.invalid/browse/X-1',
    ].join('\n'));
    await page.waitForFunction(() => document.querySelectorAll('#pasteRows .paste-row').length === 3);
    const invalide = page.locator('#pasteRows .paste-row.invalide');
    assert.equal(await invalide.count(), 1);
    assert.match(await invalide.innerText(), /URL invalide/);
    assert.equal((await page.locator('#pasteOk').innerText()).trim(), 'Ajouter 2', 'le bouton compte ce qui partira');

    // La ligne de grille : on la range dans api-core (service EXISTANT), dans un NOUVEL environnement.
    const cellule = page.locator('#pasteRows .paste-row[data-target="cell"]');
    await cellule.locator('.pr-svc-box .cb-search').click();
    await cellule.locator('.pr-svc-box .cb-search').fill('api');
    await cellule.locator('.pr-svc-box .combo-opt[data-v]').first().waitFor();
    await cellule.locator('.pr-svc-box .combo-opt[data-v]', { hasText: 'api-core' }).click();
    await page.waitForFunction(() => document.querySelector('#pasteRows .paste-row[data-i="1"] .pr-f-new').hidden);
    await cellule.locator('.pr-env').selectOption('new');
    await page.waitForSelector('#pasteRows .paste-row[data-i="1"] .pr-f-envname:not([hidden])');
    await cellule.locator('.pr-envname').fill('qa');

    // La ligne libre : pas de colonne, des tags.
    const libreRow = page.locator('#pasteRows .paste-row[data-i="2"]');
    assert.equal(await libreRow.getAttribute('data-target'), 'free');
    assert.equal(await libreRow.locator('.pr-f-env').isHidden(), true, 'un lien libre n’a pas de colonne');
    await libreRow.locator('.pr-label').fill('Suivi X-1');
    await libreRow.locator('.pr-tags').fill('outils, suivi');

    await page.locator('#pasteOk').click();
    await page.waitForSelector('#pasteModal', { state: 'hidden' });
    await attendreToast(/Ajouté : 1 dans la grille, 1 en liens libres/);
    const g = await grille();
    const qa = g.environments.find((e) => e.name === 'qa');
    assert.ok(qa, 'l’environnement est créé au passage');
    const svc = g.services.find((s) => s.id === apiCore.id);
    assert.deepEqual((svc.urls[qa.id] || []).map((u) => u.url), ['https://sonar-dev.demo.invalid/projet'],
      'l’adresse est dans la case du service choisi');
    assert.ok(!g.services.some((s) => s.name === 'sonar'), 'le service proposé n’a pas été créé : on en a choisi un autre');
    const l = g.free_links.find((x) => x.url === 'https://suivi.demo.invalid/browse/X-1');
    assert.equal(l.label, 'Suivi X-1');
    assert.deepEqual(l.tags, ['outils', 'suivi']);
  });

  test('coller puis « Annuler » ne pose rien', async () => {
    await ouvrirLiens();
    const avant = await grille();
    await page.locator('#linkPaste').click();
    await page.waitForSelector('#pasteModal:not([hidden])');
    await page.locator('#pasteText').fill('https://annule.demo.invalid/x');
    await page.waitForSelector('#pasteRows .paste-row');
    await page.locator('#pasteCancel').click();
    await page.waitForSelector('#pasteModal', { state: 'hidden' });
    const apres = await grille();
    assert.equal(apres.free_links.length, avant.free_links.length);
    assert.equal(apres.services.length, avant.services.length);
  });

  /* ----------------------------------------------------------------- l'import ---- */

  const ouvrirImport = async () => {
    await page.locator('#linkMore').click();
    await page.locator('#linkMoreMenu [data-more="import"]').click();
    await page.waitForSelector('#importModal:not([hidden])');
    await page.locator('#importFile').setInputFiles({ name: 'favoris.html', mimeType: 'text/html', buffer: Buffer.from(ARBRE) });
    await page.waitForSelector('#importPreview:not([hidden])');
  };

  test('l’import propose une grille : la refuser rend ses dossiers, deux lignes se réunissent et se renomment', async () => {
    await ouvrirLiens();
    const avant = await grille();
    await ouvrirImport();
    await page.waitForSelector('#importProposal:not([hidden])');
    assert.equal(await page.locator('#importGrid').isChecked(), true, 'la grille proposée est prise par défaut');
    assert.match(await page.locator('#importProposalTitle').innerText(), /3 environnements et 2 services/);
    assert.equal(await page.locator('#importProposalTable tbody tr').count(), 2);
    // Les dossiers absorbés par la grille ne sont pas proposés deux fois : reste « doc ».
    assert.equal(await page.locator('#importTree .import-folder-box').count(), 1);

    // Refuser la grille rend tous les dossiers à l'import à plat.
    await page.locator('#importGrid').click();
    await page.waitForFunction(() => document.querySelectorAll('#importTree .import-folder-box').length === 5);
    // Cocher UN lien d'un dossier qui en a deux : la case du dossier est « à moitié ».
    const premier = page.locator('#importTree .import-folder-box').first();
    await premier.locator('summary').click();
    await premier.locator('[data-imp]').first().click();
    assert.equal(await premier.locator('.imp-folder').evaluate((c) => c.indeterminate), true);
    assert.match(await page.locator('#importCount').innerText(), /1 lien sélectionné/);
    await page.locator('#importGrid').click();
    await page.waitForFunction(() => document.querySelectorAll('#importTree .import-folder-box').length === 1);

    // Réunir les deux lignes proposées, puis renommer la ligne réunie.
    await page.locator('#importProposalTable [data-igrow="0"]').click();
    assert.equal(await page.locator('#importMerge').isHidden(), true, 'une seule ligne cochée : rien à réunir');
    await page.locator('#importProposalTable [data-igrow="1"]').click();
    await page.waitForSelector('#importMerge:not([hidden])');
    await page.locator('#importMerge').click();
    await page.waitForFunction(() => document.querySelectorAll('#importProposalTable tbody tr').length === 1);
    await page.locator('#importProposalTable [data-igname="0"]').fill('plateforme');

    // « Tout décocher », « Tout cocher » : le compte et le bouton suivent.
    await page.locator('#importAll').click();
    assert.match(await page.locator('#importCount').innerText(), /1 lien sélectionné/);
    await page.locator('#importNone').click();
    assert.match(await page.locator('#importCount').innerText(), /^0 liens? sélectionnés?$/);
    assert.equal(await page.locator('#importApply').isDisabled(), true);
    await page.locator('#importAll').click();
    assert.equal(await page.locator('#importApply').isDisabled(), false);

    await page.locator('#importApply').click();
    await page.waitForSelector('#importModal', { state: 'hidden' });
    await attendreToast(/1 liens? importés? · 1 service et \d+ adresses dans la grille/);
    const g = await grille();
    const plateforme = g.services.find((s) => s.name === 'plateforme');
    assert.ok(plateforme, 'les deux lignes réunies font UN service, sous le nom donné');
    assert.ok(!g.services.some((s) => s.name === 'api' || s.name === 'bo'), 'et pas deux');
    assert.equal(g.services.length, avant.services.length + 1);
    const n = Object.values(plateforme.urls).flat().length;
    assert.equal(n, 7, 'les sept adresses de la grille proposée sont dans les cases du service réuni');
    const conf = g.free_links.find((l) => l.url === 'https://confluence.demo.invalid/x');
    assert.ok(conf, 'le dossier sans environnement reste en lien libre');
    assert.equal(conf.folder, 'doc');
  });

  /* Rejoué AVEC LES MÊMES GESTES (les deux lignes réunies sous « plateforme ») : ni service,
     ni adresse, ni lien libre en double — et le toast dit pourquoi rien n'est entré. */
  test('rejouer l’import ne double rien, et le dit', async () => {
    await ouvrirLiens();
    const avant = await grille();
    await ouvrirImport();
    await page.waitForSelector('#importProposal:not([hidden])');
    await page.locator('#importProposalTable [data-igrow="0"]').click();
    await page.locator('#importProposalTable [data-igrow="1"]').click();
    await page.locator('#importMerge').click();
    await page.waitForFunction(() => document.querySelectorAll('#importProposalTable tbody tr').length === 1);
    await page.locator('#importProposalTable [data-igname="0"]').fill('plateforme');
    await page.locator('#importAll').click();
    await page.locator('#importApply').click();
    await page.waitForSelector('#importModal', { state: 'hidden' });
    await attendreToast(/0 liens? importés? · 1 déjà présent/);
    const apres = await grille();
    assert.equal(apres.free_links.length, avant.free_links.length);
    assert.equal(apres.services.length, avant.services.length, 'aucun service doublé');
    assert.equal(Object.values(apres.services.flatMap((s) => Object.values(s.urls).flat())).length,
      Object.values(avant.services.flatMap((s) => Object.values(s.urls).flat())).length, 'aucune adresse doublée');
  });

  test('« Annuler » l’import ne crée rien', async () => {
    await ouvrirLiens();
    const avant = await grille();
    await ouvrirImport();
    await page.locator('#importAll').click();
    await page.locator('#importCancel').click();
    await page.waitForSelector('#importModal', { state: 'hidden' });
    const apres = await grille();
    assert.equal(apres.free_links.length, avant.free_links.length);
    assert.equal(apres.services.length, avant.services.length);
  });

  test('aucune erreur JavaScript pendant tout ce parcours', () => {
    assert.deepEqual(erreurs, [], `la console doit rester muette, vu : ${JSON.stringify(erreurs)}`);
  });
});
