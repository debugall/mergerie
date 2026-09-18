'use strict';
/* MENU « DEV IA » EN ÉQUIPE — ce que la liste et la modale montrent quand un dépôt de données
 * est partagé, dans un VRAI navigateur et avec un vrai dépôt git.
 *
 * En mono-poste, tout est à soi : ni filtre « les miennes / l'équipe », ni bouton « partager »,
 * ni case dans la modale. Dès qu'un dépôt de données est rattaché, trois choses apparaissent et
 * sont éprouvées ici par l'écran :
 * — la case « Partager avec l'équipe » de la modale, câblée dans CHACUN des trois envois
 *   (sessions sur dépôt, hors dépôt, question libre) — la voir ne prouve pas qu'elle part ;
 * — le bouton « partager / ne plus partager » d'une carte, et le pictogramme qui en résulte ;
 * — le filtre « Toutes / Les miennes / L'équipe », qui sépare son travail de celui d'un collègue
 *   (auteur lu dans git : c'est Claire qui a commité le fichier de sa session), et la carte de ce
 *   collègue, qui se range mais ne se supprime ni ne se départage.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Menu Dev IA — en équipe (dépôt de données partagé)', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app;
  let nav;
  let page;
  const erreurs = [];
  let racine;
  let nu;
  let repoId;
  let localRoot;
  const ids = {};

  const aller = async (kind) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`)
      .classList.contains('active'), kind);
  };
  const recharger = () => page.evaluate(() => loadTasks());
  const compte = (table) => app.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  const derniere = (table) => app.db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`).get();
  const dansLeDepot = () => execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
  const cartesCode = () => page.$$eval('#taskList .card[data-task]', (els) => els.map((e) => Number(e.dataset.task)).sort((a, b) => a - b));

  before(async () => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'menu-devia-partage-'));
    nu = path.join(racine, 'mergerie-data.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
    app = await startApp();
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'eq/app', url: 'https://gitlab.test/eq/app' })).body.id;
    localRoot = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    fs.mkdirSync(path.join(localRoot, 'projet'), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: localRoot });

    ids.mienne = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ma session à moi', targets: [{ repo_id: repoId, branch: 'ai/moi' }],
    })).body.id;
    ids.claire = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Ce que Claire a demandé', targets: [{ repo_id: repoId, branch: 'ai/claire' }],
    })).body.id;

    // Rattacher le poste au dépôt d'équipe : c'est ce qui fait passer l'écran en mode partagé.
    const r = await app.api('POST', '/api/data-sync/attach', { url: nu });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
    try { fs.rmSync(racine, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /* ------------------------------------------------------------ la case de la modale ---- */

  const creerPartagee = async (kind) => {
    await aller(kind);
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    await page.waitForSelector('#taskShareRow:not([hidden])');
    assert.equal(await page.locator('#taskShareRow [name="shared"]').isChecked(), false, 'jamais cochée d’office');
    await page.locator('#taskPrompt').fill(`Partagée depuis la modale (${kind})`);
    if (kind === 'code') {
      await page.waitForSelector('#targetRows .target-row .t-branch');
      await page.locator('#targetRows .target-row .t-branch').first().fill(`ai/partagee-${kind}`);
    }
    if (kind === 'local') {
      /* Le menu se referme 150 ms après la perte du focus : sur une machine chargée, le clic sur
         l'option peut arriver après. On juge à l'effet et on rouvre tant qu'il n'est pas là. */
      for (let i = 1; ; i += 1) {
        await page.locator('#taskLocalDirRows .cb-search').first().click();
        try {
          await page.locator('.combo-options:not([hidden]) .combo-opt[data-v]', { hasText: 'projet' }).first().click({ timeout: 3000 });
          await page.waitForFunction(() => document.querySelector('#taskLocalDirRows .cb-search').value === 'projet', null, { timeout: 3000 });
          break;
        } catch (e) {
          if (i === 5) throw e;
          await page.locator('#taskModalTitle').click();
        }
      }
    }
    await page.locator('#taskShareRow [name="shared"]').check();
    await page.locator('#taskSubmitOnly').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
  };

  for (const [kind, table] of [['code', 'task'], ['local', 'local_task'], ['ask', 'question']]) {
    test(`${kind} : la case « partager » de la modale arrive jusqu’à la base`, async () => {
      const avant = compte(table);
      await creerPartagee(kind);
      await attendreServeur(async () => compte(table) === avant + 1, `la session ${kind} est créée`);
      const ligne = derniere(table);
      assert.equal(ligne.prompt, `Partagée depuis la modale (${kind})`);
      assert.equal(ligne.shared, 1, `la case est câblée dans l’envoi ${kind}`);
    });
  }

  /* ------------------------------------------------------------ le bouton de la carte ---- */

  test('« Partager » depuis la carte : le pictogramme apparaît, et « ne plus partager » le retire', async () => {
    await aller('code');
    const carte = `#taskList .card[data-task="${ids.mienne}"]`;
    await page.waitForSelector(`${carte} [data-share][data-on="0"]`);
    assert.equal(await page.locator(`${carte} .note-partagee`).count(), 0);
    await page.locator(`${carte} [data-share]`).click();
    await attendreServeur(async () => app.db.prepare('SELECT shared FROM task WHERE id = ?').get(ids.mienne).shared === 1,
      'la session est partagée');
    await page.waitForSelector(`${carte} .note-partagee`);
    await page.locator(`${carte} [data-share][data-on="1"]`).click();
    await attendreServeur(async () => app.db.prepare('SELECT shared FROM task WHERE id = ?').get(ids.mienne).shared === 0,
      'la session n’est plus partagée');
    await page.waitForSelector(`${carte} .note-partagee`, { state: 'detached' });
  });

  /* ------------------------------------------------------------ la session d'un collègue ---- */

  test('préparation : Claire reprend une session partagée — git dit qu’elle est à elle', async () => {
    await app.api('POST', `/api/tasks/${ids.claire}/share`, { shared: 1 });
    await app.api('POST', '/api/data-sync/now');
    const uid = app.db.prepare('SELECT uid FROM task WHERE id = ?').get(ids.claire).uid;
    await attendreServeur(async () => new RegExp(`sessions/${uid}/session\\.json`).test(dansLeDepot()), 'la session est dans le dépôt');

    const chezClaire = path.join(racine, 'claire');
    execFileSync('git', ['clone', nu, chezClaire], { stdio: 'ignore' });
    const fichier = path.join(chezClaire, 'sessions', uid, 'session.json');
    const doc = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    doc.label = 'Reprise par Claire';
    fs.writeFileSync(fichier, `${JSON.stringify(doc, null, 2)}\n`);
    for (const args of [['add', '-A'], ['-c', 'user.name=Claire', '-c', 'user.email=claire@exemple.test',
      'commit', '-m', 'session de Claire', '--author=Claire <claire@exemple.test>'], ['push', 'origin', 'main']]) {
      execFileSync('git', ['-C', chezClaire, ...args], { stdio: 'ignore' });
    }
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.some((x) => x.id === ids.claire && x.author === 'Claire'),
      'la session est reconnue comme celle de Claire');
  });

  test('la carte d’un collègue dit « par Claire », se range, mais ne se supprime ni ne se départage', async () => {
    await aller('code');
    await recharger();
    const carte = `#taskList .card[data-task="${ids.claire}"]`;
    await page.waitForFunction((s) => /Claire/.test((document.querySelector(`${s} .task-cout`) || {}).textContent || ''), carte);
    assert.equal(await page.locator(`${carte} [data-tdel]`).count(), 0, 'supprimer ici l’effacerait chez tout le monde');
    assert.equal(await page.locator(`${carte} [data-share]`).count(), 0, 'seul l’auteur décide de partager');
    assert.equal(await page.locator(`${carte} [data-hide]`).count(), 1, 'ranger reste possible : c’est une préférence de poste');
    // …et ma session à moi garde les deux boutons.
    const mienne = `#taskList .card[data-task="${ids.mienne}"]`;
    assert.equal(await page.locator(`${mienne} [data-tdel]`).count(), 1);
    assert.equal(await page.locator(`${mienne} [data-share]`).count(), 1);
  });

  /* ------------------------------------------------------------ le filtre ---- */

  test('« Les miennes / L’équipe / Toutes » sépare mon travail de celui des collègues, et se retient', async () => {
    await aller('code');
    await page.waitForSelector('#taskOwnerFiltre:not([hidden]) [data-task-proprio]');
    assert.deepEqual(await page.$$eval('#taskOwnerFiltre [data-task-proprio]', (els) => els.map((e) => e.dataset.taskProprio)),
      ['toutes', 'miennes', 'equipe']);
    const toutes = await cartesCode();
    assert.ok(toutes.includes(ids.claire) && toutes.includes(ids.mienne));

    await page.locator('#taskOwnerFiltre [data-task-proprio="miennes"]').click();
    await page.waitForFunction((id) => !document.querySelector(`#taskList .card[data-task="${id}"]`), ids.claire);
    assert.ok((await cartesCode()).includes(ids.mienne), 'une session sans auteur n’est jamais partie : elle est à moi');
    assert.equal(await page.locator('#taskOwnerFiltre [data-task-proprio="miennes"]').getAttribute('class'), 'chip active');

    await page.locator('#taskOwnerFiltre [data-task-proprio="equipe"]').click();
    await page.waitForFunction((id) => {
      const c = [...document.querySelectorAll('#taskList .card[data-task]')].map((e) => Number(e.dataset.task));
      return c.length === 1 && c[0] === id;
    }, ids.claire);

    // Le choix survit au rechargement : c'est une préférence de vue.
    await page.reload();
    await aller('code');
    await page.waitForSelector('#taskOwnerFiltre [data-task-proprio="equipe"].active');
    await page.waitForFunction((id) => {
      const c = [...document.querySelectorAll('#taskList .card[data-task]')].map((e) => Number(e.dataset.task));
      return c.length === 1 && c[0] === id;
    }, ids.claire);

    await page.locator('#taskOwnerFiltre [data-task-proprio="toutes"]').click();
    await page.waitForFunction((n) => document.querySelectorAll('#taskList .card[data-task]').length === n, toutes.length);
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
