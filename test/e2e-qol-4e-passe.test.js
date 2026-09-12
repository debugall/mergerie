'use strict';
/* LES MICRO-AMÉLIORATIONS DE LA 4ᵉ PASSE (axe C).
 *
 * Chacune tient en quelques lignes de code ; ensemble, elles font la différence entre un outil
 * qu'on subit et un outil qui suit la main. Ce sont aussi les plus faciles à défaire sans s'en
 * apercevoir — un libellé qui repasse en clé brute, un filtre qui cesse de s'appliquer, un
 * clavier qui redevient une souris. D'où ce fichier.
 *
 * On teste ce qui se VÉRIFIE : les tables de libellés, les règles de recherche et de filtre, le
 * clavier des listes déroulantes, ce que le serveur sert en plus. Le reste du lot (une bulle,
 * un bouton de copie) relève de l'écran et se voit à l'œil.
 *
 * Un seul `startApp()` pour tout le fichier.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Qualité de vie · 4ᵉ passe', () => {
  let app;

  before(async () => {
    app = await startApp();
    await app.configure();
  });
  after(async () => { if (app) await app.stop(); });

  /* C16 — cinq saveurs de job et deux familles d'appel s'affichaient sous leur nom technique
     au milieu de libellés en clair. Un libellé manquant se voit ici, pas à l'écran. */
  test('toutes les saveurs de job et d’appel ont un libellé, dans les deux langues', () => {
    const rt = require('../public/i18n-runtime.js');
    const jobs = ['review', 'rereview', 'modify', 'explain', 'task', 'local', 'gitops', 'docker',
      'converge', 'verify', 'install', 'ask', 'ask-review', 'reconcile'];
    const appels = ['review', 'explain', 'modify', 'task', 'explore', 'ask', 'question'];
    for (const lang of ['fr', 'en']) {
      rt.setLang(lang);
      for (const k of jobs) {
        const s = rt.t(`job.kind.${k}`);
        assert.ok(!/^job\./.test(s), `job.kind.${k} en ${lang} : clé brute`);
      }
      for (const k of appels) {
        const s = rt.t(`stats.kind.${k}`);
        assert.ok(!/^stats\./.test(s), `stats.kind.${k} en ${lang} : clé brute`);
      }
    }
    rt.setLang('fr');
  });

  /* C4 — la clé de ticket était redéduite à l'écran avec une règle qui n'était pas celle du
     serveur. Elle est maintenant servie, calculée à un seul endroit. */
  test('la clé du ticket est servie avec la merge request', async () => {
    const d = app.db;
    const repoId = d.prepare("INSERT INTO repo (project, url, created_at) VALUES ('grp/tk','http://x',datetime('now'))").run().lastInsertRowid;
    d.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at)
      VALUES (?, 7010, '[ABC-12] Corrige le tunnel', 'feature/DEF-34-x', 'main', 'to_review', datetime('now'))`).run(repoId);
    const m = (await app.api('GET', '/api/mrs')).body.find((x) => x.iid === 7010);
    /* La règle du serveur : les crochets du TITRE d'abord, la branche ensuite. L'écran, lui,
       prenait la première clé rencontrée dans « titre + branche » — soit l'autre réponse. */
    assert.equal(m.ticket_key, 'ABC-12');
  });

  /* C23 — le badge de l'onglet Agents existait dans le menu et n'était jamais rempli. */
  test('le badge des agents compte les cartes de connaissance à valider', async () => {
    const avant = (await app.api('GET', '/api/status')).body.agentsPending;
    assert.equal(typeof avant, 'number');
    const d = app.db;
    const agentId = d.prepare(`INSERT INTO agent (name, kind, scope_kind, created_at, updated_at)
      VALUES ('Cartographe test', 'explore', 'all_repos', datetime('now'), datetime('now'))`).run().lastInsertRowid;
    d.prepare(`INSERT INTO agent_knowledge (agent_id, version, status, md_path, created_at)
      VALUES (?, 1, 'pending', '/tmp/k.md', datetime('now'))`).run(agentId);
    assert.equal((await app.api('GET', '/api/status')).body.agentsPending, avant + 1);
  });

  /* C15 — « Relancer » disparaît sur un job git en échec : c'est un choix, il était muet. */
  test('un job qu’on ne rejoue pas dit pourquoi', async () => {
    const d = app.db;
    const id = d.prepare(`INSERT INTO job (kind, status, started_at, finished_at, total, done_count)
      VALUES ('gitops', 'error', datetime('now'), datetime('now'), 1, 0)`).run().lastInsertRowid;
    const j = (await app.api('GET', `/api/jobs/${id}/log`)).body;
    assert.equal(j.can_retry, false);
    assert.ok(j.no_retry_reason, 'la raison est donnée');
    assert.ok(!/^job\./.test(j.no_retry_reason), `clé brute : ${j.no_retry_reason}`);
  });

  /* C25 — les noms de conteneurs se dictent tous les jours ; ils s'écrivaient de travers.
     On ne sonde pas Docker pour autant : on lit ce que le badge de santé a déjà vu. */
  test('le vocabulaire de dictée sait lire les noms de conteneurs déjà vus', () => {
    const docker = require('../src/docker');
    assert.deepEqual(docker.nomsConnus(), [], 'rien tant que Docker n’a pas été regardé');
    assert.doesNotThrow(() => docker.nomsConnus());
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    const erreurs = [];

    before(async () => {
      const depot = require('./helpers/app').makeRemoteRepo(require('node:fs').mkdtempSync(require('node:path').join(app.dataDir, 'qol-')));
      await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' });
      await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/autre' });
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 950 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    /* C3 — quatre listes déroulantes à recherche dans l'outil, et aucune ne répondait au
       clavier : on tapait pour filtrer, puis on lâchait le clavier pour cliquer. */
    test('une liste déroulante se parcourt et se choisit au clavier', async () => {
      await page.locator('nav button[data-tab="task"]').click();
      await page.locator('#btnNewTask').click();
      await page.waitForSelector('#taskModal:not([hidden])');
      const champ = page.locator('#targetRows .target-row [data-pick-repo]').first();
      await champ.click();
      await page.waitForSelector('#targetRows .combo-opt');

      await page.keyboard.press('ArrowDown');
      await page.waitForSelector('#targetRows .combo-opt.active');
      const designe = (await page.locator('#targetRows .combo-opt.active').textContent()).trim();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#targetRows [data-pick-repo]').value.length > 0);
      assert.equal((await champ.inputValue()).trim(), designe, 'Entrée prend ce qui est désigné');
    });

    /* …et Échap ferme LA LISTE, pas la fenêtre : sans cette garde, on perdait tout ce qui
       était écrit dans la modale en voulant seulement refermer un menu. */
    test('Échap referme la liste sans emporter la fenêtre', async () => {
      const champ = page.locator('#targetRows .target-row [data-pick-repo]').first();
      const choisi = await champ.inputValue();
      await champ.click();
      await page.waitForSelector('#targetRows .combo-opt');
      await page.keyboard.press('Escape');
      const etat = await page.evaluate(() => ({
        menu: document.querySelector('#targetRows .repo-combo .combo-options').hidden,
        modale: document.querySelector('#taskModal').hidden,
        champ: document.querySelector('#targetRows [data-pick-repo]').value,
      }));
      assert.deepEqual(etat, { menu: true, modale: false, champ: choisi },
        'le menu part, la fenêtre reste, le choix est rendu');
      await page.locator('#taskCancel').click();
      await page.waitForSelector('#taskModal', { state: 'hidden' });
    });

    /* C2 — « / » éjectait vers Reviews depuis les onglets qui ont pourtant leur recherche. */
    test('« / » cherche dans l’onglet où l’on est', async () => {
      await page.locator('nav button[data-tab="agents"]').click();
      await page.waitForSelector('#tab-agents.active');
      // Le champ n'existe qu'une fois la liste rendue : « / » vise ce qui est VISIBLE.
      await page.waitForFunction(() => {
        const el = document.querySelector('#agentFilter');
        return el && el.offsetParent !== null;
      });
      await page.keyboard.press('/');
      const actif = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(actif, 'agentFilter', 'le champ de l’onglet Agents a le focus');
      assert.ok(await page.locator('#tab-agents').evaluate((el) => el.classList.contains('active')),
        'et on n’a pas changé d’onglet');
    });

    /* TOP 5 — LES OBJETS ONT UNE ADRESSE. Trois conséquences quotidiennes tenaient à son
       absence : on ne pouvait pas coller un lien vers un objet, Précédent quittait
       l'application, et une notification ouverte depuis un autre onglet atterrissait à
       l'aveugle. On éprouve les deux sens : ouvrir écrit l'adresse, et une adresse collée
       ouvre l'objet — y compris au CHARGEMENT, qui est le cas du lien qu'on reçoit. */
    test('une page de notes s’ouvre par son adresse, et son adresse s’écrit en l’ouvrant', async () => {
      const page1 = (await app.api('POST', '/api/notes', { title: 'Page adressable', content: 'x' })).body;
      await page.goto(`${app.base}#/notes/${page1.id}`);
      await page.waitForFunction((t) => {
        const el = document.querySelector('#pageTitle');
        return el && el.value === t;
      }, 'Page adressable');
      assert.ok(await page.locator('#tab-notes').evaluate((el) => el.classList.contains('active')),
        'l’adresse l’emporte sur l’onglet de la dernière visite');

      // …et l'inverse : ouvrir une autre page réécrit l'adresse.
      const page2 = (await app.api('POST', '/api/notes', { title: 'Seconde page', content: 'y' })).body;
      await page.evaluate((id) => window.openNotePage(id), page2.id);
      await page.waitForFunction((id) => window.location.hash === `#/notes/${id}`, page2.id);
    });

    /* UNE CASE À COCHER DES RÉGLAGES S'ENREGISTRE VRAIMENT. `input[type=checkbox].value` vaut
       « on » cochée COMME décochée : les quatre cases « cochées d'office » d'une nouvelle
       session partaient donc en base avec la chaîne « on », que tout le monde relit en
       `=== '1'` — la case revenait décochée au rechargement et le réglage n'était jamais
       appliqué. On éprouve le chemin complet : cocher, enregistrer, relire le SERVEUR (l'état
       de l'écran ne prouve rien), puis décocher et relire. */
    test('une case des réglages s’enregistre, et se décoche aussi', async () => {
      await page.locator('nav button[data-tab="admin"]').click();
      await page.locator('#tab-admin .subnav [data-sub="config"]').click();
      const caseAsk = page.locator('#configForm [name="task_default_ask_questions"], [form="configForm"][name="task_default_ask_questions"]').first();
      await caseAsk.waitFor({ state: 'visible' });

      await caseAsk.click();
      await page.locator('#sub-config button[type="submit"][form="configForm"]').first().click();
      /* `String(...)` : la colonne est un INTEGER, l'API rend donc 1 et non '1' — c'est
         exactement le piège qui faisait revenir la case décochée. */
      await attendreServeur(async () => String((await app.api('GET', '/api/config')).body.task_default_ask_questions) === '1',
        'la case cochée arrive en base comme « 1 »');

      // …et l'écran la montre cochée après un rechargement complet : c'est ce que voit l'utilisateur.
      await page.reload();
      await page.locator('nav button[data-tab="admin"]').click();
      await page.locator('#tab-admin .subnav [data-sub="config"]').click();
      await page.waitForFunction(() => {
        const el = document.querySelector('#configForm') && document.querySelector('#configForm').task_default_ask_questions;
        return el && el.checked;
      });

      await caseAsk.click();
      await page.locator('#sub-config button[type="submit"][form="configForm"]').first().click();
      await attendreServeur(async () => String((await app.api('GET', '/api/config')).body.task_default_ask_questions) === '0',
        'et décochée, comme « 0 » — pas « on » dans les deux cas');
    });

    test('aucune erreur JavaScript pendant tout ce parcours', () => {
      assert.deepEqual(erreurs, []);
    });
  });
});
