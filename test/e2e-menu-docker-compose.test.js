'use strict';
/* MENU « DOCKER » — SOUS-ONGLET COMPOSE, DANS UN VRAI NAVIGATEUR.
 *
 * Tout ce que l'utilisateur voit et touche sur une carte de projet compose : branche et commit
 * du dossier, état et badge de chaque service (synchro, drift config, drift image, compose
 * modifié, arrêté, non créé), diff .env nominatif avec les secrets masqués, port publié,
 * durée de fonctionnement, redémarrages, rail d'actions (désactivées quand elles n'ont pas de
 * sens), recherche et filtre d'état persistés, cases de projets affichés, bloc Makefile
 * (recherche, exécution, dernière exécution), copie des commandes, « Poser dans la grille »,
 * Rafraîchir, et les actions : Stop (avec annulation), Redémarrer, Pull, Build, Démarrer,
 * Recréer, Up du projet, Down avec son aperçu.
 *
 * Docker n'est jamais appelé pour de vrai : `DOCKER_BIN` pointe sur un faux CLI
 * (helpers/fake-docker.js) qui répond depuis un état JSON et note chaque appel. Chaque geste
 * est jugé sur son EFFET — l'appel reçu par docker, l'état du conteneur, la base — jamais sur
 * le libellé qu'il laisse à l'écran.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, attendreServeur, git,
  navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, afficherMenusOptionnels,
} = require('./helpers/app');
const { installerFauxDocker, scenarioDocker, ecrireProjetsCompose } = require('./helpers/fake-docker');

const { dispo } = navigateurDispo();

describe('Menu Docker — onglet Compose', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let faux;
  let dirs; let fichiers; let shaBoutique; let serviceGrille; let envLocal;
  const erreurs = [];

  before(async () => {
    // Le faux binaire AVANT le serveur : le choix du binaire est mémorisé au premier appel.
    faux = installerFauxDocker(scenarioDocker());
    app = await startApp();
    await app.configure();
    const racine = path.join(app.dataDir, 'stacks');
    fs.mkdirSync(racine, { recursive: true });
    // boutique est un clone git : la carte doit dire sur quelle branche et quel commit on tourne.
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-')));
    git(racine, ['clone', depot.bare, 'boutique']);
    shaBoutique = depot.mainSha.slice(0, 8);
    dirs = ecrireProjetsCompose(racine);
    fichiers = { boutique: path.join(dirs.boutique, 'compose.yaml'), monitoring: path.join(dirs.monitoring, 'compose.yaml') };
    assert.equal((await app.api('POST', '/api/local-roots', { path: racine })).status, 200);

    // La grille des liens connaît le dépôt de boutique, un environnement « local » à la case vide.
    const repoId = (await app.api('POST', '/api/repos', { url: depot.bare, project: 'grp/boutique' })).body.id;
    serviceGrille = (await app.api('POST', '/api/services', { name: 'Boutique', repo_id: repoId })).body.id;
    envLocal = (await app.api('POST', '/api/environments', { name: 'local' })).body.id;
    assert.ok(serviceGrille && envLocal, 'grille préparée');

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await afficherMenusOptionnels(page);
    await page.addInitScript(() => {
      window.__copies = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copies.push(t); }, readText: async () => '' },
      });
    });
    await page.goto(app.base);
    await ouvrirDocker();
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    if (faux) faux.nettoyer();
  });

  /* ---------------------------------------------------------------- outils ---- */

  const slot = (p) => page.locator(`#dockerComposeBox .docker-slot[data-path="${fichiers[p]}"]`);
  // Une ligne de service, reconnue à son bouton « Démarrer » (présent sur toutes, actif ou non).
  const ligne = (p, svc) => slot(p).locator('.docker-svc')
    .filter({ has: page.locator(`[data-dockeract="up"][data-svc="${svc}"]`) });
  const bouton = (p, svc, action) => ligne(p, svc).locator(`[data-dockeract="${action}"]`);

  // Attend que les cartes VISIBLES aient toutes reçu leur détail (plus de squelette).
  async function cartesChargees(noms) {
    await page.waitForFunction((chemins) => chemins.every((c) => {
      const s = [...document.querySelectorAll('#dockerComposeBox .docker-slot')].find((x) => x.dataset.path === c);
      return s && s.querySelector('.docker-project:not(.docker-ph)');
    }), noms.map((n) => fichiers[n]));
  }
  async function ouvrirDocker() {
    await page.locator('nav button[data-tab="docker"]').click();
    await page.locator('#tab-docker .subnav [data-dsub="compose"]').click();
    await cartesChargees(['boutique', 'monitoring']);
  }
  // Recharge l'onglet en vidant d'abord la boîte : on n'attend pas l'ancien écran pour le nouveau.
  async function rafraichir(noms = ['boutique', 'monitoring']) {
    await page.evaluate(() => { document.querySelector('#dockerComposeBox').innerHTML = ''; });
    await page.locator('#dockerRefresh').click();
    await cartesChargees(noms);
  }
  const etatLigne = (p, svc) => ligne(p, svc).locator('.docker-state').getAttribute('class');
  const badge = (p, svc) => ligne(p, svc).locator('.docker-svc-head > .tag').first().innerText();
  const appelsCompose = (sous) => faux.appels().filter((a) => a.args[0] === 'compose' && a.args[1] === sous);
  async function attendreEtat(nomConteneur, predicat, quoi) {
    await attendreServeur(async () => predicat(faux.conteneur(nomConteneur)), quoi);
  }
  async function repos() {
    await waitForJobs(app.api);
  }

  /* ------------------------------------------------------------ affichage ---- */

  test('les deux projets s’affichent, avec la version de Docker, la branche et le commit du dossier', async () => {
    assert.match(await page.locator('#dockerInfo').innerText(), /Docker 99\.0\.0-faux/);
    assert.equal(await page.locator('#dockerError').innerText(), '');
    const titre = await slot('boutique').locator('.docker-project-head .title').innerText();
    assert.match(titre, /boutique/);
    assert.match(titre, /compose\.yaml/);
    assert.equal(await slot('boutique').locator('.docker-git .git-sha').innerText(), shaBoutique);
    assert.match(await slot('boutique').locator('.docker-git').innerText(), /main/);
    assert.equal(await slot('monitoring').locator('.docker-git').count(), 0, 'pas un dépôt git : rien à dire');
  });

  test('chaque service porte son état et le badge qui le distingue', async () => {
    const attendu = {
      boutique: { web: ['running', 'synchro'], api: ['running', 'drift config'], worker: ['running', 'drift image'], db: ['exited', 'arrêté'], cache: ['none', 'non créé'] },
      monitoring: { grafana: ['running', 'compose modifié'], prometheus: ['restarting', 'arrêté'], alertmanager: ['created', 'arrêté'] },
    };
    for (const [p, services] of Object.entries(attendu)) {
      for (const [svc, [etat, libelle]] of Object.entries(services)) {
        assert.match(await etatLigne(p, svc), new RegExp(`docker-state-${etat}\\b`), `${p}/${svc} : état ${etat}`);
        assert.equal((await badge(p, svc)).trim(), libelle, `${p}/${svc} : badge`);
      }
    }
    assert.match(await ligne('boutique', 'worker').locator('.docker-imgdrift').innerText(), /worker:2\.0.*worker:1\.0/);
    assert.equal(await ligne('boutique', 'web').locator('.docker-imgdrift').count(), 0);
  });

  test('le drift .env est nominatif, et un jeton n’est jamais montré', async () => {
    const diff = ligne('boutique', 'api').locator('.env-diff');
    // Texte à plat : chaque morceau d'une ligne de diff est un élément à part.
    const texte = (await diff.textContent()).replace(/\s+/g, ' ');
    assert.match(texte, /modifiée\s+DB_POOL_SIZE\s+10 → 25/);
    assert.match(texte, /ajoutée\s+FEATURE_X\s+→ true/);
    assert.match(texte, /API_TOKEN\s+valeur masquée/);
    assert.doesNotMatch(await page.locator('#dockerComposeBox').innerText(), /jeton-neuf|jeton-vieux/);
    assert.equal(await ligne('boutique', 'web').locator('.env-diff').count(), 0, 'synchro : pas de diff');
  });

  test('port publié ouvrable seulement quand le service tourne, durée de fonctionnement, redémarrages', async () => {
    const port = ligne('boutique', 'web').locator('a.dk-port');
    assert.equal(await port.getAttribute('href'), 'http://localhost:8080');
    assert.equal(await port.getAttribute('target'), '_blank');
    assert.equal(await ligne('boutique', 'db').locator('a.dk-port').count(), 0, 'arrêté : aucun lien');
    assert.match(await ligne('boutique', 'web').locator('[data-when]').innerText(), /démarré/);
    assert.equal(await ligne('boutique', 'db').locator('[data-when]').count(), 0);
    const redem = ligne('boutique', 'api').locator('.tag', { hasText: '4' });
    assert.equal(await redem.count(), 1);
    assert.match(await redem.getAttribute('class'), /stale/, 'quatre redémarrages : signalé');
  });

  test('le rail d’actions garde sa forme, et désactive ce qui n’a pas de sens', async () => {
    const actif = async (p, s, a) => !(await bouton(p, s, a).isDisabled());
    assert.deepEqual(await Promise.all(['stop', 'restart', 'pull', 'build', 'up', 'recreate'].map((a) => actif('boutique', 'web', a))),
      [true, true, true, true, false, false], 'web tourne et est synchro');
    assert.equal(await actif('boutique', 'api', 'recreate'), true, 'drift config : Recréer');
    assert.equal(await actif('boutique', 'worker', 'recreate'), true, 'drift image : Recréer');
    assert.equal(await actif('monitoring', 'grafana', 'recreate'), true, 'compose modifié : Recréer');
    assert.deepEqual(await Promise.all(['stop', 'restart', 'up'].map((a) => actif('boutique', 'db', a))), [false, false, true]);
    assert.equal(await actif('boutique', 'cache', 'up'), true);
  });

  test('les boutons « copier » donnent la commande exacte au terminal', async () => {
    await ligne('boutique', 'web').locator('[data-copy-cmd]').click();
    await page.waitForFunction(() => window.__copies.length >= 1);
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), `docker compose -f ${fichiers.boutique} up -d web`);
    await slot('boutique').locator('.mk-item[data-name="migrate"] .mk-copy').click();
    await page.waitForFunction(() => window.__copies.length >= 2);
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), `cd ${dirs.boutique} && make migrate`);
  });

  /* ------------------------------------------------------------- filtres ---- */

  test('la recherche ne garde que les services qui correspondent, et survit au rechargement', async () => {
    await page.locator('#dcSearch').fill('work');
    await page.waitForFunction(() => document.querySelectorAll('#dockerComposeBox .docker-svc').length === 1);
    assert.equal(await ligne('boutique', 'worker').count(), 1);
    assert.equal(await slot('monitoring').count(), 0, 'aucun service retenu : la carte disparaît');
    assert.match(await slot('boutique').locator('.docker-svc-hidden').innerText(), /4 services masqués/);

    await page.reload();
    await page.locator('nav button[data-tab="docker"]').click();
    await cartesChargees(['boutique']);
    assert.equal(await page.locator('#dcSearch').inputValue(), 'work');
    assert.equal(await page.locator('#dockerComposeBox .docker-svc').count(), 1);

    await page.locator('#dcSearch').fill('zzz-rien');
    // Le message, et non « zéro ligne » : pendant le rendu différé, les squelettes n'en ont pas non plus.
    await page.waitForFunction(() => /Aucun service ne correspond/.test(document.querySelector('#dockerComposeBox').innerText));
    assert.equal(await page.locator('#dockerComposeBox .docker-svc').count(), 0);
    await page.locator('#dcSearch').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#dockerComposeBox .docker-svc').length === 8);
  });

  test('les pastilles d’état filtrent les services — la même règle que l’onglet Actions', async () => {
    const cas = {
      running: ['web', 'api', 'worker', 'grafana'],
      stopped: ['db', 'cache', 'prometheus', 'alertmanager'],
      exited: ['db'],
      crashed: ['db'],
      created: ['alertmanager'],
      missing: ['cache'],
      unhealthy: ['grafana'],
      restarting: ['prometheus'],
      drift: ['api', 'worker', 'grafana'],
      all: ['web', 'api', 'worker', 'db', 'cache', 'grafana', 'prometheus', 'alertmanager'],
    };
    for (const [etat, services] of Object.entries(cas)) {
      await page.locator(`#dcState [data-dstate="${etat}"]`).click();
      await page.waitForFunction(([e, n]) => {
        const actif = document.querySelector('#dcState [data-dstate].active');
        return actif && actif.dataset.dstate === e
          && document.querySelectorAll('#dockerComposeBox .docker-svc').length === n;
      }, [etat, services.length]);
      const vus = await page.locator('#dockerComposeBox .docker-svc [data-dockeract="up"]').evaluateAll((b) => b.map((x) => x.dataset.svc));
      assert.deepEqual(vus.sort(), [...services].sort(), `filtre ${etat}`);
    }
    await page.locator('#dcState [data-dstate="crashed"]').click();
    await page.reload();
    await page.locator('nav button[data-tab="docker"]').click();
    await cartesChargees(['boutique']);
    assert.equal(await page.locator('#dcState [data-dstate].active').getAttribute('data-dstate'), 'crashed', 'retenu au rechargement');
    await page.locator('#dcState [data-dstate="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#dockerComposeBox .docker-svc').length === 8);
  });

  test('décocher un projet le retire de la vue, durablement ; le recocher le recharge', async () => {
    await page.locator(`.docker-filter-cb[value="${fichiers.monitoring}"]`).click();
    await slot('monitoring').waitFor({ state: 'detached' });
    await page.reload();
    await page.locator('nav button[data-tab="docker"]').click();
    await cartesChargees(['boutique']);
    assert.equal(await slot('monitoring').count(), 0, 'retenu au rechargement');
    assert.equal(await page.locator(`.docker-filter-cb[value="${fichiers.monitoring}"]`).isChecked(), false);

    await page.locator(`.docker-filter-cb[value="${fichiers.boutique}"]`).click();
    await page.waitForFunction(() => /Tous les projets sont masqués/.test(document.querySelector('#dockerComposeBox').innerText));
    await page.locator(`.docker-filter-cb[value="${fichiers.boutique}"]`).click();
    await page.locator(`.docker-filter-cb[value="${fichiers.monitoring}"]`).click();
    await cartesChargees(['boutique', 'monitoring']);
  });

  /* ------------------------------------------------------------ Makefile ---- */

  test('le bloc Makefile liste les cibles, avec leur description et leur recette, et se filtre', async () => {
    const bloc = slot('boutique').locator('.docker-make');
    assert.match(await bloc.locator('summary').innerText(), /3 commandes Makefile/);
    const cibles = await bloc.locator('.mk-item').evaluateAll((l) => l.map((x) => x.dataset.name));
    assert.deepEqual(cibles, ['migrate', 'seed', 'casse']);
    assert.match(await bloc.locator('.mk-item[data-name="seed"] .mk-desc').innerText(), /Injecte les données de démo/);
    assert.equal(await bloc.locator('.mk-item[data-name="migrate"] .mk-eye').getAttribute('data-tip'), 'echo migrate > .fait-migrate');
    assert.equal(await slot('monitoring').locator('.docker-make').count(), 0, 'pas de Makefile : pas de bloc');

    await bloc.locator('.mk-search').fill('démo');
    await page.waitForFunction(() => [...document.querySelectorAll('.mk-item')].filter((x) => !x.hidden).length === 1);
    assert.equal(await bloc.locator('.mk-item:not([hidden])').getAttribute('data-name'), 'seed');
    await bloc.locator('.mk-search').fill('introuvable');
    await bloc.locator('.mk-none').waitFor({ state: 'visible' });
    await bloc.locator('.mk-search').fill('');
    await bloc.locator('.mk-none').waitFor({ state: 'hidden' });
  });

  test('« Exécuter » lance la cible make dans le dossier, et la dernière exécution s’affiche sous le bouton', async () => {
    await slot('boutique').locator('.mk-item[data-name="migrate"] .mk-run').click();
    await attendreServeur(async () => fs.existsSync(path.join(dirs.boutique, '.fait-migrate')), 'make migrate a tourné');
    await repos();
    const runs = async () => (await app.api('GET', `/api/docker/make/runs?dir=${encodeURIComponent(dirs.boutique)}`)).body.runs;
    await attendreServeur(async () => (await runs()).migrate && (await runs()).migrate.ok === 1, 'exécution notée réussie');

    await slot('boutique').locator('.mk-item[data-name="casse"] .mk-run').click();
    await attendreServeur(async () => (await runs()).casse && (await runs()).casse.finished_at != null, 'exécution en échec notée');
    await repos();
    assert.equal((await runs()).casse.ok, 0);
    assert.ok(!fs.existsSync(path.join(dirs.boutique, '.fait-seed')), 'seules les cibles cliquées tournent');

    await rafraichir();
    const derniere = (c) => slot('boutique').locator(`[data-mk-last="${c}"]`);
    await page.waitForFunction(() => {
      const ok = document.querySelector('[data-mk-last="migrate"]');
      const ko = document.querySelector('[data-mk-last="casse"]');
      return ok && !ok.hidden && /✓/.test(ok.textContent) && ko && !ko.hidden && /✗/.test(ko.textContent);
    });
    assert.match(await derniere('casse').getAttribute('class'), /mk-last-ko/);
    assert.equal(await derniere('seed').isHidden(), true, 'jamais lancée : rien');
  });

  /* ---------------------------------------------------- grille des liens ---- */

  /* BUG : `/api/docker/local-links` (src/server.js) appelle `docker.gitDuRepertoire`, que
     src/docker.js définit mais n'EXPORTE pas. La route répond donc toujours une erreur
     (« docker.gitDuRepertoire is not a function »), l'écran l'avale (`.catch`) et le bouton
     « Poser dans la grille » n'apparaît jamais. */
  test('« Poser dans la grille » renseigne la case « local » du service lié, avec le port publié', async () => {
    const liens = (await app.api('GET', `/api/docker/local-links?dir=${encodeURIComponent(dirs.boutique)}`)).body;
    assert.equal(liens.error, undefined, `la route répond : ${liens.error}`);
    assert.equal(liens.service && liens.service.id, serviceGrille, 'le dossier est relié au service de la grille');
    assert.equal(liens.filled, false);
    const b = slot('boutique').locator('[data-dk-poser]');
    await b.waitFor();
    assert.equal(await b.getAttribute('data-url'), 'http://localhost:8080');
    assert.equal(await slot('monitoring').locator('[data-dk-poser]').count(), 0, 'dossier sans dépôt lié : rien à proposer');
    await b.click();
    const url = () => app.db.prepare('SELECT url FROM service_url WHERE service_id = ? AND environment_id = ?').get(serviceGrille, envLocal);
    await attendreServeur(async () => Boolean(url()), 'case écrite');
    assert.equal(url().url, 'http://localhost:8080');
    await b.waitFor({ state: 'detached' });

    await rafraichir();
    await page.waitForFunction(() => document.querySelectorAll('[data-dk-grille]').length === 2);
    // La case est remplie : le serveur ne propose plus rien.
    const d = (await app.api('GET', `/api/docker/local-links?dir=${encodeURIComponent(dirs.boutique)}`)).body;
    assert.equal(d.filled, true);
    assert.equal(await slot('boutique').locator('[data-dk-poser]').count(), 0);
  });

  /* ------------------------------------------------------------- actions ---- */

  test('« Rafraîchir » relit l’état de Docker', async () => {
    faux.modifier((e) => { const c = e.containers.find((x) => x.name === 'boutique-db-1'); c.state = 'running'; c.status = 'Up 1 second'; });
    await rafraichir();
    assert.match(await etatLigne('boutique', 'db'), /docker-state-running/);
    faux.modifier((e) => { const c = e.containers.find((x) => x.name === 'boutique-db-1'); c.state = 'exited'; c.status = 'Exited (1) 1 second ago'; });
    await rafraichir();
    assert.match(await etatLigne('boutique', 'db'), /docker-state-exited/);
  });

  test('Stop arrête le service seul, et « Annuler » le redémarre', async () => {
    faux.viderJournal();
    await bouton('boutique', 'web', 'stop').click();
    const annuler = page.locator('#toasts .toast .toast-btn');
    await annuler.first().waitFor();
    await attendreEtat('boutique-web-1', (c) => c.state === 'exited', 'web arrêté');
    const stop = appelsCompose('stop');
    assert.equal(stop.length, 1);
    assert.deepEqual(stop[0].args, ['compose', 'stop', '--', 'web']);
    assert.equal(stop[0].cwd, 'boutique', 'lancé dans le dossier du compose');

    await annuler.first().click();
    await attendreEtat('boutique-web-1', (c) => c.state === 'running', 'web redémarré par l’annulation');
    assert.deepEqual(appelsCompose('up').at(-1).args, ['compose', 'up', '-d', '--', 'web']);
    await repos();
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-dockeract="stop"][data-svc="web"]');
      return b && !b.disabled;
    });
  });

  test('Redémarrer, Pull et Build envoient chacun leur commande au seul service visé', async () => {
    faux.viderJournal();
    await bouton('boutique', 'api', 'restart').click();
    await attendreServeur(async () => appelsCompose('restart').length === 1, 'restart reçu');
    assert.deepEqual(appelsCompose('restart')[0].args, ['compose', 'restart', '--', 'api']);
    await repos();
    await attendreEtat('boutique-api-1', (c) => c.restarts === 5, 'compteur de redémarrages');

    await bouton('boutique', 'worker', 'pull').click();
    await attendreServeur(async () => appelsCompose('pull').length === 1, 'pull reçu');
    assert.deepEqual(appelsCompose('pull')[0].args, ['compose', 'pull', '--', 'worker']);
    await repos();

    await bouton('boutique', 'worker', 'build').click();
    await attendreServeur(async () => appelsCompose('up').some((a) => a.args.includes('--build')), 'build reçu');
    assert.deepEqual(appelsCompose('up').find((a) => a.args.includes('--build')).args, ['compose', 'up', '-d', '--build', '--', 'worker']);
    await repos();
    // Après le job, l'écran se relit : worker tourne désormais sur l'image demandée.
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-dockeract="recreate"][data-svc="worker"]');
      return b && b.disabled;
    });
    assert.equal((await badge('boutique', 'worker')).trim(), 'synchro');
  });

  test('Démarrer crée le service qui n’avait pas de conteneur', async () => {
    await bouton('boutique', 'cache', 'up').click();
    await attendreServeur(async () => Boolean(faux.conteneur('boutique-cache-1')), 'conteneur créé');
    await repos();
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-dockeract="stop"][data-svc="cache"]');
      return b && !b.disabled;
    });
    assert.match(await etatLigne('boutique', 'cache'), /docker-state-running/);
  });

  test('Recréer résorbe le drift de configuration', async () => {
    faux.viderJournal();
    await bouton('boutique', 'api', 'recreate').click();
    await attendreServeur(async () => appelsCompose('up').length === 1, 'recreate reçu');
    assert.deepEqual(appelsCompose('up')[0].args, ['compose', 'up', '-d', '--force-recreate', '--', 'api']);
    await repos();
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-dockeract="recreate"][data-svc="api"]');
      return b && b.disabled;
    });
    assert.equal(await ligne('boutique', 'api').locator('.env-diff').count(), 0);
    assert.ok(faux.conteneur('boutique-api-1').env.includes('DB_POOL_SIZE=25'));
  });

  test('« Up » démarre tout le projet, sans liste de services', async () => {
    faux.viderJournal();
    await slot('monitoring').locator('.docker-project-actions [data-dockeract="up"]').click();
    await attendreServeur(async () => appelsCompose('up').length === 1, 'up du projet reçu');
    const [appel] = appelsCompose('up');
    assert.deepEqual(appel.args, ['compose', 'up', '-d']);
    assert.equal(appel.cwd, 'monitoring');
    await repos();
    await attendreEtat('monitoring-alertmanager-1', (c) => c.state === 'running', 'alertmanager démarré');
  });

  test('« Down » montre d’abord ce qui va s’arrêter ; Annuler ne touche à rien, confirmer arrête le projet', async () => {
    faux.viderJournal();
    const down = slot('monitoring').locator('[data-dockerdown]');
    await down.click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    assert.match(await page.locator('#confirmText').innerText(), /Arrêter 3 containers \?/);
    assert.match(await page.locator('#confirmText').innerText(), /volumes ne sont PAS supprimés/);
    const detail = await page.locator('#confirmDetail').innerText();
    for (const n of ['monitoring-grafana-1 (grafana)', 'monitoring-prometheus-1 (prometheus)', 'monitoring-alertmanager-1 (alertmanager)']) {
      assert.ok(detail.includes(`• ${n}`), `${n} annoncé`);
    }
    await page.locator('#confirmCancel').click();
    await page.waitForSelector('#confirmModal', { state: 'hidden' });
    assert.equal(appelsCompose('down').length, 0, 'annulé : aucun down');
    assert.ok(faux.conteneur('monitoring-grafana-1'));

    await slot('monitoring').locator('[data-dockerdown]').click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await attendreServeur(async () => appelsCompose('down').length === 1, 'down reçu');
    assert.deepEqual(appelsCompose('down')[0].args, ['compose', 'down'], 'jamais -v : les volumes restent');
    await repos();
    assert.equal(faux.lire().containers.filter((c) => c.project === 'monitoring').length, 0);
    await page.waitForFunction(() => ['grafana', 'prometheus', 'alertmanager'].every((s) => {
      const b = document.querySelector(`[data-dockeract="up"][data-svc="${s}"]`);
      return b && b.closest('.docker-svc').querySelector('.docker-state-none');
    }));
  });

  test('aucune erreur JavaScript pendant le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
