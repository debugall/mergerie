'use strict';
/* MENU « DEV IA » — LA LISTE, dans un VRAI navigateur.
 *
 * Tout ce qui entoure les cartes sans lancer d'agent : les quatre saveurs et leurs compteurs, le
 * bouton « Nouvelle session » qui change de nom, la recherche (et sa remise à zéro), le filtre
 * par agent, « afficher les sessions masquées », les listes vides et leur porte d'entrée, puis
 * les gestes sur la FICHE d'une carte — renommer sur place, ranger/ressortir, replier les
 * projets, « voir plus », le chapeau de réponse, la todo qui attend, la commande de reprise,
 * supprimer (avec son « Annuler ») — et l'adresse `#/sessions/<saveur>/<id>`.
 *
 * Chaque changement d'état est relu CÔTÉ SERVEUR : l'écran qui dit « rangée » ne prouve pas
 * que la préférence est écrite.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Dev IA — la liste', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app;
  let nav;
  let contexte;
  let page;
  const erreurs = [];
  const ids = {};
  let repoApp;
  let repoLib;
  let racine;
  let agent;

  const CARTE = {
    code: (id) => `#taskList .card[data-task="${id}"]`,
    explore: (id) => `#taskList .card[data-task="${id}"]`,
    local: (id) => `#localList .card[data-local="${id}"]`,
    ask: (id) => `#askList .card[data-ask="${id}"]`,
  };

  const aller = async (kind) => {
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`)
      .classList.contains('active'), kind);
  };
  // Relit les sessions depuis le serveur, comme le fait le sondage — sans attendre qu'il passe.
  const recharger = () => page.evaluate(() => loadTasks());
  const tr = (cle, p) => page.evaluate(([k, x]) => tr(k, x), [cle, p || {}]);
  const confirmer = async () => {
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmOk').click();
    await page.waitForSelector('#confirmModal[hidden]', { state: 'attached' });
  };
  const visible = (sel) => page.locator(sel).isVisible();

  before(async () => {
    app = await startApp();
    await app.configure();
    repoApp = (await app.api('POST', '/api/repos', { project: 'grp/app', url: 'https://gitlab.test/grp/app' })).body.id;
    repoLib = (await app.api('POST', '/api/repos', { project: 'grp/lib', url: 'https://gitlab.test/grp/lib' })).body.id;
    racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    for (const d of ['scripts', 'outils']) fs.mkdirSync(path.join(racine, d), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });
    agent = (await app.api('POST', '/api/agents', { name: 'Agent du filtre', kind: 'code' })).body;

    nav = await lancerNavigateur();
    contexte = await nav.newContext({ viewport: { width: 1400, height: 900 } });
    await contexte.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base });
    page = await contexte.newPage();
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  /* ------------------------------------------------------------ listes vides ---- */

  /* UNE LISTE VIDE EST UNE PORTE. Chaque saveur dit ce qu'elle est et propose de commencer —
     et le bouton ouvre la modale DANS LA BONNE SAVEUR : un « nouvelle question » qui ouvrirait
     le formulaire de codage enverrait la question dans `task`. */
  for (const kind of ['code', 'local', 'explore', 'ask']) {
    test(`${kind} : la liste vide propose de commencer, dans la bonne saveur`, async () => {
      await aller(kind);
      const liste = { code: '#taskList', explore: '#taskList', local: '#localList', ask: '#askList' }[kind];
      const porte = page.locator(`${liste} [data-empty-act="new-task"]`);
      await porte.waitFor();
      assert.equal((await porte.textContent()).trim(), await tr(`task.kind.${kind}.btn`));
      await porte.click();
      await page.waitForSelector('#taskModal:not([hidden])');
      assert.equal((await page.locator('#taskModalTitle').textContent()).trim(), await tr(`task.kind.${kind}.title`),
        'la modale s’ouvre dans la saveur de la liste vide');
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    });
  }

  /* ------------------------------------------------------------ semis ---- */

  test('préparation : une session de chaque sorte', async () => {
    const creer = async (corps) => (await app.api('POST', '/api/tasks', corps)).body.id;
    ids.panier = await creer({ kind: 'code', label: 'Panier', prompt: 'Coder le panier', targets: [{ repo_id: repoApp, branch: 'feat/panier' }] });
    ids.long = await creer({
      kind: 'code',
      prompt: Array.from({ length: 14 }, (_, i) => `Ligne ${i + 1} d’une consigne très longue qui déborde.`).join('\n'),
      targets: [{ repo_id: repoApp, branch: 'feat/long' }],
    });
    ids.deux = await creer({
      kind: 'code', prompt: 'Toucher deux dépôts',
      targets: [{ repo_id: repoApp, branch: 'feat/deux' }, { repo_id: repoLib, branch: 'feat/deux' }],
    });
    ids.agent = await creer({ kind: 'code', prompt: 'Portée par un agent', targets: [{ repo_id: repoApp, branch: 'feat/agent' }] });
    app.db.prepare('UPDATE task SET agent_id = ?, agent_name = ? WHERE id = ?').run(agent.id, agent.name, ids.agent);
    ids.jetable = await creer({ kind: 'code', prompt: 'Session à supprimer', targets: [{ repo_id: repoApp, branch: 'feat/jetable' }] });

    ids.explore = await creer({ kind: 'explore', prompt: 'Où est la configuration ?', targets: [{ repo_id: repoApp, branch: 'main' }] });
    // Une réponse sur le disque : c'est d'elle que la carte tire son chapeau.
    const md = path.join(app.dataDir, 'reponse-explore.md');
    fs.writeFileSync(md, '# Réponse\n\nLa configuration vit dans src/config.js et se lit au démarrage.\n');
    app.db.prepare("UPDATE task SET status = 'done', md_path = ? WHERE id = ?").run(md, ids.explore);

    ids.local = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Ranger les scripts', dirs: [path.join(racine, 'scripts'), path.join(racine, 'outils')],
    })).body.id;
    ids.localJetable = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Hors dépôt à supprimer', dirs: [path.join(racine, 'outils')],
    })).body.id;

    ids.ask = (await app.api('POST', '/api/questions', { prompt: 'Quelle différence entre un mutex et un sémaphore ?' })).body.id;
    ids.askJetable = (await app.api('POST', '/api/questions', { prompt: 'Question à supprimer' })).body.id;
    // Une session d'agent connue : la carte propose alors la commande de reprise.
    // eslint-disable-next-line global-require
    require('../src/data/localsession').ecrire('question',
      app.db.prepare('SELECT uid FROM question WHERE id = ?').get(ids.ask).uid,
      { session_key: 'sess-menu-devia', session_backend: 'claude', session_cwd: app.dataDir });

    // L'agent s'est arrêté sur une question : l'outil a posé une todo, la carte doit le dire.
    const maintenant = new Date().toISOString();
    app.db.prepare(`INSERT INTO todo (title, created_at, updated_at, auto_kind, auto_ref)
      VALUES ('Répondre à l’agent', ?, ?, 'session_question', ?)`).run(maintenant, maintenant, String(ids.panier));

    await aller('code');
    await recharger();
    await page.waitForSelector(CARTE.code(ids.panier));
  });

  /* ------------------------------------------------------------ les saveurs ---- */

  /* QUATRE SOUS-ONGLETS, QUATRE COMPTEURS, UN BOUTON QUI CHANGE DE NOM. Le compteur dit combien
     il y en a ; la pastille du menu, elle, ne compte que ce qui attend d'être lancé. Le panneau
     des lots n'a de sens qu'en codage — les autres saveurs ne produisent pas de merge request. */
  test('les compteurs des quatre saveurs et la pastille du menu suivent le serveur', async () => {
    const tasks = (await app.api('GET', '/api/tasks')).body;
    const locals = (await app.api('GET', '/api/local-tasks')).body;
    const asks = (await app.api('GET', '/api/questions')).body;
    const attendus = {
      '#kindCountCode': tasks.filter((t) => t.kind !== 'explore').length,
      '#kindCountExplore': tasks.filter((t) => t.kind === 'explore').length,
      '#kindCountLocal': locals.length,
      '#kindCountAsk': asks.length,
    };
    for (const [sel, n] of Object.entries(attendus)) {
      await page.waitForFunction(([s, v]) => document.querySelector(s).textContent.trim() === v, [sel, String(n)]);
    }
    const enAttente = [...tasks, ...locals, ...asks].filter((x) => x.status === 'new').length;
    assert.equal((await page.locator('#navCountTask').textContent()).trim(), String(enAttente),
      'la pastille du menu compte le travail jamais lancé, toutes saveurs confondues');
  });

  for (const kind of ['code', 'local', 'explore', 'ask']) {
    test(`${kind} : le sous-onglet montre sa liste, son bouton, son aide — et se retient`, async () => {
      await aller(kind);
      assert.equal((await page.locator('#btnNewTaskLabel').textContent()).trim(), await tr(`task.kind.${kind}.btn`));
      assert.equal((await page.locator('#taskKindHint').textContent()).trim(), await tr(`task.kind.${kind}.hint`));
      assert.equal(await page.locator('#taskList').isHidden(), kind === 'local' || kind === 'ask');
      assert.equal(await page.locator('#localPanel').isHidden(), kind !== 'local');
      assert.equal(await page.locator('#askPanel').isHidden(), kind !== 'ask');
      assert.equal(await page.locator('#lotPanel').isHidden(), kind !== 'code', 'les lots ne vivent que sous le codage');
      assert.equal(await page.locator('#taskSearch').getAttribute('placeholder'),
        await tr(kind === 'ask' ? 'ask.search.ph' : 'task.search.ph'),
        'une question libre n’a ni projet, ni branche, ni dossier à chercher');
      assert.equal(await page.evaluate(() => localStorage.getItem('aidevtools_task_kind')), kind,
        'le sous-onglet courant survit au rechargement');
    });
  }

  test('le sous-onglet retenu est celui qui rouvre après un rechargement', async () => {
    await aller('local');
    await page.reload();
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector(CARTE.local(ids.local));
    assert.equal(await page.locator('#tab-task .subnav [data-kind="local"]').getAttribute('class'), 'active');
  });

  /* ------------------------------------------------------------ recherche ---- */

  test('codage : la recherche filtre sur le libellé, le prompt, le projet et la branche', async () => {
    await aller('code');
    await page.waitForSelector(CARTE.code(ids.panier));
    const cartes = () => page.$$eval('#taskList .card[data-task]', (els) => els.map((e) => Number(e.dataset.task)));

    await page.locator('#taskSearch').fill('panier');
    await page.waitForFunction(() => document.querySelectorAll('#taskList .card[data-task]').length === 1);
    assert.deepEqual(await cartes(), [ids.panier]);

    await page.locator('#taskSearch').fill('grp/lib');
    await page.waitForFunction((id) => {
      const c = [...document.querySelectorAll('#taskList .card[data-task]')].map((e) => Number(e.dataset.task));
      return c.length === 1 && c[0] === id;
    }, ids.deux);

    await page.locator('#taskSearch').fill('feat/agent');
    await page.waitForFunction((id) => {
      const c = [...document.querySelectorAll('#taskList .card[data-task]')].map((e) => Number(e.dataset.task));
      return c.length === 1 && c[0] === id;
    }, ids.agent);

    await page.locator('#taskSearch').fill('introuvable-xyz');
    await page.waitForFunction(() => /introuvable-xyz/.test(document.querySelector('#taskList').textContent)
      && !document.querySelector('#taskList .card[data-task]'));

    // Changer de sous-onglet remet la recherche à zéro : les compteurs affichent des TOTAUX.
    await aller('explore');
    assert.equal(await page.locator('#taskSearch').inputValue(), '');
    await aller('code');
    await page.waitForFunction(() => document.querySelectorAll('#taskList .card[data-task]').length >= 5);
  });

  test('exploration : la recherche retrouve une session par sa RÉPONSE', async () => {
    await aller('explore');
    await page.locator('#taskSearch').fill('src/config.js');
    await page.waitForSelector(CARTE.explore(ids.explore));
    assert.equal(await page.locator('#taskList .card[data-task]').count(), 1);
    await page.locator('#taskSearch').fill('');
  });

  test('hors dépôt : la recherche porte aussi sur les chemins des dossiers', async () => {
    await aller('local');
    await page.locator('#taskSearch').fill('scripts');
    await page.waitForFunction((id) => {
      const c = [...document.querySelectorAll('#localList .card[data-local]')].map((e) => Number(e.dataset.local));
      return c.length === 1 && c[0] === id;
    }, ids.local);
    await page.locator('#taskSearch').fill('rien-de-tel');
    await page.waitForFunction(() => /rien-de-tel/.test(document.querySelector('#localList').textContent)
      && !document.querySelector('#localList .card'));
    await page.locator('#taskSearch').fill('');
    await page.waitForSelector(CARTE.local(ids.localJetable));
  });

  test('question libre : la recherche porte sur la question', async () => {
    await aller('ask');
    await page.locator('#taskSearch').fill('sémaphore');
    await page.waitForFunction((id) => {
      const c = [...document.querySelectorAll('#askList .card[data-ask]')].map((e) => Number(e.dataset.ask));
      return c.length === 1 && c[0] === id;
    }, ids.ask);
    await page.locator('#taskSearch').fill('');
    await page.waitForSelector(CARTE.ask(ids.askJetable));
  });

  /* ------------------------------------------------------------ filtre par agent ---- */

  /* Poser le filtre par agent, et s'assurer qu'il a pris. Le menu se referme 150 ms après la
     perte du focus : sur une machine chargée, le clic sur l'option peut arriver après. On juge à
     l'EFFET — la valeur retenue par le combo — et on rouvre tant qu'il n'est pas là. */
  const poserFiltreAgent = async (valeur, texte, essais = 5) => {
    for (let i = 1; i <= essais; i += 1) {
      await page.locator('#taskAgentFilterBox .cb-search').click();
      const opt = texte
        ? page.locator('.combo-options:not([hidden]) .combo-opt[data-v]', { hasText: texte })
        : page.locator('.combo-options:not([hidden]) .combo-opt[data-v=""]');
      try {
        await opt.first().click({ timeout: 3000 });
        await page.waitForFunction((v) => document.querySelector('#taskAgentFilterBox .taskAgentFilterVal').value === v,
          valeur, { timeout: 3000 });
        return;
      } catch (e) {
        if (i === essais) throw e;
        await page.locator('#taskKindHint').click();   // referme le menu avant de réessayer
      }
    }
  };

  test('le filtre par agent ne garde que ses sessions, et se retire par le même combo', async () => {
    await aller('code');
    await poserFiltreAgent(String(agent.id), 'Agent du filtre');
    await page.waitForFunction((id) => {
      const c = [...document.querySelectorAll('#taskList .card[data-task]')].map((e) => Number(e.dataset.task));
      return c.length === 1 && c[0] === id;
    }, ids.agent);
    assert.match(await page.locator(`${CARTE.code(ids.agent)} .tag-agent`).textContent(), /Agent du filtre/);
    assert.equal(await page.locator('#taskAgentFilterBox .cb-search').inputValue(), 'Agent du filtre',
      'le filtre posé se VOIT, sinon on cherche les sessions manquantes');

    // Revenir à toutes les sessions : l'option vide du même combo.
    await poserFiltreAgent('', null);
    await page.waitForFunction(() => document.querySelectorAll('#taskList .card[data-task]').length >= 5);
  });

  test('changer de sous-onglet retire le filtre par agent', async () => {
    await aller('code');
    await poserFiltreAgent(String(agent.id), 'Agent du filtre');
    await page.waitForFunction(() => document.querySelectorAll('#taskList .card[data-task]').length === 1);
    await aller('explore');
    await aller('code');
    await page.waitForFunction(() => document.querySelectorAll('#taskList .card[data-task]').length >= 5);
    assert.equal(await page.locator('#taskAgentFilterBox .cb-search').inputValue(), '');
  });

  /* ------------------------------------------------------------ ranger / ressortir ---- */

  for (const [kind, cle, route] of [
    ['code', 'panier', '/api/tasks'],
    ['explore', 'explore', '/api/tasks'],
    ['local', 'local', '/api/local-tasks'],
    ['ask', 'ask', '/api/questions'],
  ]) {
    test(`${kind} : ranger retire la carte, la case la ressort, et on la remet en vue`, async () => {
      const id = ids[cle];
      const lire = async () => (await app.api('GET', route)).body.find((x) => x.id === id).hidden;
      await aller(kind);
      const carte = CARTE[kind](id);
      await page.waitForSelector(carte);
      await page.locator(`${carte} [data-hide][data-on="0"]`).click();

      await attendreServeur(async () => (await lire()) === 1, 'la session est rangée côté serveur');
      await page.waitForSelector(carte, { state: 'detached' });
      assert.equal((await page.locator('#taskHiddenCount').textContent()).trim(), await tr('task.hidden.count', { n: 1, count: 1 }),
        'une session qui disparaît sans laisser de trace se croit supprimée');

      await page.locator('#taskShowHidden').check();
      await page.waitForSelector(`${carte}.is-hidden`);
      await page.locator(`${carte} [data-hide][data-on="1"]`).click();
      await attendreServeur(async () => (await lire()) === 0, 'la session est ressortie côté serveur');
      await page.waitForSelector(`${carte}:not(.is-hidden)`);
      await page.locator('#taskShowHidden').uncheck();
      await page.waitForSelector(carte);
      assert.equal((await page.locator('#taskHiddenCount').textContent()).trim(), '');
    });
  }

  test('« afficher les sessions masquées » est une préférence qui survit au rechargement', async () => {
    await aller('code');
    await page.locator('#taskShowHidden').check();
    await page.reload();
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector(CARTE.code(ids.panier));
    assert.equal(await page.locator('#taskShowHidden').isChecked(), true);
    await page.locator('#taskShowHidden').uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem('aidevtools_show_hidden')), '0');
  });

  /* ------------------------------------------------------------ libellé sur place ---- */

  for (const [kind, cle, relire] of [
    ['code', 'panier', async (id) => (await app.api('GET', `/api/tasks/${id}`)).body.task.label],
    ['explore', 'explore', async (id) => (await app.api('GET', `/api/tasks/${id}`)).body.task.label],
    ['local', 'local', async (id) => (await app.api('GET', `/api/local-tasks/${id}`)).body.task.label],
    ['ask', 'ask', async (id) => (await app.api('GET', `/api/questions/${id}`)).body.task.label],
  ]) {
    test(`${kind} : le libellé se renomme sur place — Échap renonce, Entrée enregistre`, async () => {
      const id = ids[cle];
      const avant = await relire(id);
      await aller(kind);
      const carte = CARTE[kind](id);
      await page.waitForSelector(carte);

      await page.locator(`${carte} [data-label-edit]`).click();
      const champ = page.locator(`${carte} .task-label-input`);
      await champ.waitFor();
      await champ.fill('Ne pas garder');
      await champ.press('Escape');
      await page.waitForSelector(`${carte} .task-label-input`, { state: 'detached' });
      assert.equal(await relire(id), avant, 'Échap ne doit rien écrire');

      await page.locator(`${carte} [data-label-edit]`).click();
      await page.locator(`${carte} .task-label-input`).fill(`Renommée ${kind}`);
      await page.locator(`${carte} .task-label-input`).press('Enter');
      await attendreServeur(async () => (await relire(id)) === `Renommée ${kind}`, 'le libellé est écrit');
      await page.waitForFunction(([s, v]) => {
        const e = document.querySelector(`${s} .task-label-txt`);
        return e && e.textContent.trim() === v;
      }, [carte, `Renommée ${kind}`]);
    });
  }

  /* ------------------------------------------------------------ repli, « voir plus », chapeau ---- */

  for (const [kind, cle] of [['code', 'deux'], ['local', 'local']]) {
    test(`${kind} : la liste des projets se replie, se déplie, et s’en souvient`, async () => {
      const id = ids[cle];
      await aller(kind);
      const carte = CARTE[kind](id);
      await page.waitForSelector(`${carte} [data-tfold]`);
      assert.equal(await page.locator(`${carte} .targets`).isHidden(), true, 'replié par défaut');

      await page.locator(`${carte} [data-tfold]`).click();
      await page.waitForSelector(`${carte} [data-tfold][aria-expanded="true"]`);
      assert.equal(await page.locator(`${carte} .targets`).isVisible(), true);
      assert.equal(await page.locator(`${carte} .targets .target-line`).count(), 2);

      await page.reload();
      await aller(kind);
      await page.waitForSelector(`${carte} [data-tfold][aria-expanded="true"]`);
      assert.equal(await page.locator(`${carte} .targets`).isVisible(), true, 'l’état déplié survit au rechargement');

      await page.locator(`${carte} [data-tfold]`).click();
      await page.waitForSelector(`${carte} [data-tfold][aria-expanded="false"]`);
      assert.equal(await page.locator(`${carte} .targets`).isHidden(), true);
    });
  }

  test('un prompt long se replie, « Voir plus » le déplie et « Voir moins » le replie', async () => {
    await aller('code');
    const carte = CARTE.code(ids.long);
    const plus = page.locator(`${carte} .prompt-more`);
    await plus.waitFor();
    assert.equal((await plus.textContent()).trim(), await tr('task.prompt.more'));
    assert.equal(await page.locator(`${CARTE.code(ids.panier)} .prompt-more`).isHidden(), true,
      'un prompt d’une ligne n’a rien à déplier');
    await plus.click();
    await page.waitForFunction((s) => !document.querySelector(`${s} .task-prompt`).classList.contains('clamped'), carte);
    assert.equal((await plus.textContent()).trim(), await tr('task.prompt.less'));
    await plus.click();
    await page.waitForFunction((s) => document.querySelector(`${s} .task-prompt`).classList.contains('clamped'), carte);
  });

  test('exploration : le chapeau de la réponse se lit sur la carte et se déplie', async () => {
    await aller('explore');
    const chapeau = page.locator(`${CARTE.explore(ids.explore)} details.task-chapeau`);
    await chapeau.waitFor();
    assert.match(await chapeau.locator('summary').textContent(), /src\/config\.js/,
      'la première phrase de la réponse, pas son titre');
    await chapeau.locator('summary').click();
    await page.waitForFunction((s) => document.querySelector(`${s} details.task-chapeau`).open, CARTE.explore(ids.explore));
  });

  /* ------------------------------------------------------------ todo, reprise ---- */

  test('« une todo t’attend » mène aux todos', async () => {
    await aller('code');
    const badge = page.locator(`${CARTE.code(ids.panier)} [data-todo-attente]`);
    await badge.waitFor();
    assert.equal(await page.locator(`${CARTE.code(ids.long)} [data-todo-attente]`).count(), 0,
      'seule la session dont l’agent attend porte le badge');
    await badge.click();
    await page.waitForFunction(() => document.querySelector('#tab-notes').classList.contains('active'));
    await page.waitForFunction(() => /Répondre à l’agent/.test(document.querySelector('#tab-notes').textContent));
  });

  /* La commande de reprise : le bouton copie `cd … && claude --resume …` dans le presse-papiers.
     Relu dans le presse-papiers lui-même — le toast ne prouverait que le clic. */
  const copierReprise = async (sel) => {
    const bouton = page.locator(sel);
    await bouton.waitFor();
    const attendu = await bouton.getAttribute('data-resume-cmd');
    assert.match(attendu, /--resume sess-menu-devia/);
    await bouton.click();
    await page.waitForFunction((c) => navigator.clipboard.readText().then((x) => x === c), attendu);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), attendu);
  };

  test('codage : la commande de reprise se copie depuis la ligne du projet', async () => {
    // eslint-disable-next-line global-require
    require('../src/data/localsession').ecrire('task_target',
      app.db.prepare('SELECT uid FROM task_target WHERE task_id = ?').get(ids.panier).uid,
      { session_key: 'sess-menu-devia-code', session_backend: 'claude', session_cwd: app.dataDir });
    await aller('code');
    await recharger();
    await copierReprise(`${CARTE.code(ids.panier)} .target-line [data-resume-cmd]`);
  });

  /* LA MÊME COMMANDE, SUR UNE QUESTION LIBRE. `GET /api/questions/:id` la calcule sur la ligne
     RECOLLÉE à sa session locale (`localsession.resoudre`) ; la LISTE la calculait sur la ligne
     brute de la table — où le handle n'est plus, depuis qu'il vit dans `local_session` — et la
     carte ne proposait jamais « Reprendre au terminal ». */
  test('question libre : la commande de reprise se copie depuis la carte', async () => {
    await aller('ask');
    await recharger();
    const liste = (await app.api('GET', '/api/questions')).body.find((x) => x.id === ids.ask);
    assert.match(String(liste.resume_cmd), /--resume sess-menu-devia/,
      'la liste doit servir la même commande que la fiche de la question');
    await copierReprise(`${CARTE.ask(ids.ask)} [data-resume-cmd]`);
  });

  /* ------------------------------------------------------------ supprimer ---- */

  test('codage : supprimer se confirme, s’annule pendant six secondes, puis part vraiment', async () => {
    await aller('code');
    const carte = CARTE.code(ids.jetable);
    await page.waitForSelector(carte);

    // Renoncer à la confirmation : rien ne bouge.
    await page.locator(`${carte} [data-tdel]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmCancel').click();
    assert.equal(await visible(carte), true);

    // Confirmer, puis « Annuler » dans le bandeau : la carte revient, la session est intacte.
    await page.locator(`${carte} [data-tdel]`).click();
    await confirmer();
    await page.waitForSelector(carte, { state: 'hidden' });
    await page.locator('.toast .toast-btn').last().click();
    await page.waitForSelector(carte, { state: 'visible' });
    assert.equal((await app.api('GET', `/api/tasks/${ids.jetable}`)).status, 200, 'rien n’a été supprimé');

    // Confirmer et laisser filer : la suppression part après le délai.
    await page.locator(`${carte} [data-tdel]`).click();
    await confirmer();
    await attendreServeur(async () => (await app.api('GET', `/api/tasks/${ids.jetable}`)).status >= 400,
      'la session est supprimée côté serveur', 30000);
    await page.waitForSelector(carte, { state: 'detached' });
  });

  test('hors dépôt : supprimer demande confirmation, puis supprime', async () => {
    await aller('local');
    const carte = CARTE.local(ids.localJetable);
    await page.waitForSelector(carte);
    await page.locator(`${carte} [data-ldel]`).click();
    await page.waitForSelector('#confirmModal:not([hidden])');
    await page.locator('#confirmCancel').click();
    assert.ok((await app.api('GET', '/api/local-tasks')).body.some((x) => x.id === ids.localJetable));
    await page.locator(`${carte} [data-ldel]`).click();
    await confirmer();
    await attendreServeur(async () => !(await app.api('GET', '/api/local-tasks')).body.some((x) => x.id === ids.localJetable),
      'la session hors dépôt est supprimée');
    await page.waitForSelector(carte, { state: 'detached' });
  });

  test('question libre : supprimer demande confirmation, puis supprime', async () => {
    await aller('ask');
    const carte = CARTE.ask(ids.askJetable);
    await page.waitForSelector(carte);
    await page.locator(`${carte} [data-qdel]`).click();
    await confirmer();
    await attendreServeur(async () => !(await app.api('GET', '/api/questions')).body.some((x) => x.id === ids.askJetable),
      'la question est supprimée');
    await page.waitForSelector(carte, { state: 'detached' });
  });

  /* ------------------------------------------------------------ adresse ---- */

  /* `#/sessions/<saveur>/<id>` : un lien collé dans une note doit ouvrir la BONNE saveur et
     montrer la carte — pas l'onglet d'avant, où elle n'est pas. */
  for (const [kind, cle] of [['local', 'local'], ['ask', 'ask'], ['explore', 'explore']]) {
    test(`l’adresse #/sessions/${kind}/<id> ouvre la saveur et montre la carte`, async () => {
      await aller('code');
      await page.goto(`${app.base}/#/sessions/${kind}/${ids[cle]}`);
      await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`)
        .classList.contains('active'), kind);
      await page.waitForSelector(CARTE[kind](ids[cle]), { state: 'visible' });
      assert.equal(await page.evaluate(() => location.hash), `#/sessions/${kind}/${ids[cle]}`);
    });
  }

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
