'use strict';
/* LE DIFF D'UNE SEULE ITÉRATION.
 *
 * Une session de codage s'itère : un lancement, puis des suivis. Le diff de la branche, lui,
 * ne distingue rien — au troisième suivi, la correction de trois lignes qu'on vient de
 * demander se cherche au milieu de deux cents, et on relit tout à chaque fois.
 *
 * Ce que ce fichier surveille tient en une comparaison : le diff d'une ITÉRATION ne montre que
 * ce que cette itération-là a changé, là où le diff du PROJET montre tout. Prouver la première
 * moitié sans la seconde ne prouverait rien — un diff vide passerait le test.
 *
 * La même promesse vaut HORS DÉPÔT, là où il n'y a ni branche ni commit : les bornes viennent
 * d'un dépôt de suivi tenu à l'écart, et le dossier de l'utilisateur ne reçoit rien — pas même
 * le `.git` qui sert à mesurer.
 *
 * Et les bords qui, eux, ne doivent rien promettre : une itération qui n'a rien commité (elle
 * s'est arrêtée pour poser des questions), une itération qui n'existe pas, et un dossier trop
 * vaste pour être mesuré — où l'on renonce sans faire échouer le codage.
 *
 * Un seul `startApp()` : les deux `describe` partagent l'app et le navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, makeRemoteRepo, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

// Les lignes AJOUTÉES par un diff unifié. Le contexte, lui, reprend forcément le travail des
// itérations précédentes : c'est sur les ajouts que se lit ce qu'une itération a fait.
const ajouts = (diff) => String(diff || '').split('\n').filter((l) => /^\+(?!\+\+)/.test(l)).join('\n');

describe('Diff d’une itération de codage', () => {
  let app; let repoId; let tacheId; let cibleId;
  // Partagée avec le parcours d'écran : la session hors dépôt semée par le bloc « hors dépôt ».
  const localSession = {};
  const LANCEMENT = 'Ajoute un endpoint de sante applicative';
  const SUIVI = 'Renomme la variable compteur en total';

  before(async () => {
    app = await startApp();
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'pd-')));
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/app' })).body.id;

    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: LANCEMENT, targets: [{ repo_id: repoId, branch: 'ai/sante' }],
    });
    tacheId = t.body.id;
    await app.api('POST', `/api/tasks/${tacheId}/run`);
    await waitForJobs(app.api);
    cibleId = (await app.api('GET', `/api/tasks/${tacheId}`)).body.task.targets[0].id;

    await app.api('POST', `/api/tasks/${tacheId}/followup`, { instruction: SUIVI, targets: [cibleId] });
    await waitForJobs(app.api);
  });
  after(async () => { if (app) await app.stop(); });

  const passes = async () => (await app.api('GET', `/api/tasks/${tacheId}/targets/${cibleId}/passes`)).body.passes;
  const vue = async (n) => app.api('GET', `/api/tasks/${tacheId}/targets/${cibleId}/passes/${n}/diffview`);

  test('chaque itération porte son propre diff, et le dit', async () => {
    const liste = await passes();
    assert.deepEqual(liste.map((p) => p.kind), ['run', 'followup']);
    assert.deepEqual(liste.map((p) => p.has_diff), [true, true]);
  });

  /* LE CŒUR. Le suivi n'a demandé qu'un renommage : son diff ne doit pas reparler de
     l'endpoint du lancement. Le diff du PROJET, lui, porte les deux — c'est la comparaison des
     deux qui prouve qu'on a bien deux vues différentes, et pas deux fois la même. */
  test('le diff d’un suivi ne montre QUE ce que ce suivi a changé', async () => {
    const suivi = ajouts((await vue(2)).body.diff);
    assert.match(suivi, /compteur en total/, 'le suivi a bien écrit quelque chose');
    assert.doesNotMatch(suivi, /sante applicative/, 'le travail du lancement n’a rien à faire là');

    const lancement = ajouts((await vue(1)).body.diff);
    assert.match(lancement, /sante applicative/);
    assert.doesNotMatch(lancement, /compteur en total/);

    // …et le diff du projet, lui, porte bien les deux : sans cela, on aurait juste perdu du diff.
    const projet = ajouts((await app.api('GET', `/api/tasks/${tacheId}/targets/${cibleId}/diff`)).body.diff);
    assert.match(projet, /sante applicative/);
    assert.match(projet, /compteur en total/);
  });

  test('la vue d’une itération compte les fichiers de cette itération, et sait les nommer', async () => {
    const { body } = await vue(2);
    assert.equal(body.pass.n, 2);
    assert.equal(body.pass.kind, 'followup');
    // `prompt` est ce qui a RÉELLEMENT été envoyé : la demande, entourée de sa consigne de suivi.
    assert.match(body.pass.prompt, new RegExp(SUIVI));
    assert.equal(body.project, 'grp/app');
    assert.ok(body.stats.files >= 1, JSON.stringify(body.stats));
    assert.ok(body.files.some((f) => f.changed), 'au moins un fichier marqué dans l’arbre');
  });

  /* Le fichier entier à contexte complet, borné à l'itération. Les deux bornes sont des
     COMMITS : un `origin/<sha>` n'existe pas, et c'est exactement ce qui cassait avant. */
  test('le fichier entier d’une itération se lit, et ne montre que ses changements', async () => {
    const { body } = await vue(2);
    const chemin = body.files.find((f) => f.changed).path;
    const fd = await app.api('GET', `/api/tasks/${tacheId}/targets/${cibleId}/passes/2/filediff?path=${encodeURIComponent(chemin)}`);
    assert.equal(fd.status, 200);
    assert.match(ajouts(fd.body.diff), /compteur en total/);
    assert.doesNotMatch(ajouts(fd.body.diff), /sante applicative/);

    const f = await app.api('GET', `/api/tasks/${tacheId}/targets/${cibleId}/passes/2/file?path=${encodeURIComponent(chemin)}`);
    assert.equal(f.status, 200);
    assert.equal(f.body.path, chemin);
  });

  test('une itération qui n’existe pas répond une phrase, pas une trace', async () => {
    const r = await vue(99);
    assert.equal(r.status, 400);
    assert.ok(!/^err\./.test(r.body.error), `clé brute renvoyée : ${r.body.error}`);
  });

  /* Une itération qui s'est arrêtée pour poser des questions n'a rien commité : il n'y a pas
     de diff, et l'écran ne doit pas proposer d'en ouvrir un. */
  test('une itération sans commit ne promet aucun diff', async () => {
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'pq-')));
    const rid = (await app.api('POST', '/api/repos', { url: depot.url, project: 'grp/quest' })).body.id;
    const t = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'refonte du tunnel', ask_questions: 1,
      targets: [{ repo_id: rid, branch: 'ai/tunnel' }],
    });
    await app.api('POST', `/api/tasks/${t.body.id}/run`);
    await waitForJobs(app.api);
    const tg = (await app.api('GET', `/api/tasks/${t.body.id}`)).body.task.targets[0];
    assert.equal(tg.status, 'needs_input');

    const liste = (await app.api('GET', `/api/tasks/${t.body.id}/targets/${tg.id}/passes`)).body.passes;
    assert.deepEqual(liste.map((p) => [p.has_diff, p.no_change]), [[false, false]]);
    const r = await app.api('GET', `/api/tasks/${t.body.id}/targets/${tg.id}/passes/1/diffview`);
    assert.equal(r.status, 400);
    assert.ok(!/^err\./.test(r.body.error), `clé brute renvoyée : ${r.body.error}`);
  });

  /* LE HORS-DÉPÔT, qui code EN PLACE dans un dossier arbitraire. Il n'a ni branche ni commit :
     les bornes viennent d'un dépôt de SUIVI tenu à l'écart, dans le dossier de travail de
     Mergerie. La promesse est la même qu'au-dessus — et une promesse de plus, propre à cette
     saveur : le dossier de l'utilisateur ne reçoit rien. */
  describe('hors dépôt', () => {
    let localId; let dirId; let dossier;
    const SUIVI_LOCAL = 'Ajoute un test sur le parseur';

    before(async () => {
      dossier = fs.mkdtempSync(path.join(app.dataDir, 'hd-'));
      fs.writeFileSync(path.join(dossier, 'index.js'), 'const a = 1;\n');
      // Une dépendance installée : elle pèse tout et n'apprend rien. Elle ne doit pas être suivie.
      fs.mkdirSync(path.join(dossier, 'node_modules', 'gros'), { recursive: true });
      fs.writeFileSync(path.join(dossier, 'node_modules', 'gros', 'index.js'), 'module.exports = 1;\n');

      const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'range les imports', dirs: [dossier] })).body;
      localId = lt.id;
      localSession.id = lt.id;
      await app.api('POST', `/api/local-tasks/${localId}/run`);
      await waitForJobs(app.api);
      dirId = (await app.api('GET', `/api/local-tasks/${localId}`)).body.task.dirs[0].id;
      await app.api('POST', `/api/local-tasks/${localId}/followup`, { instruction: SUIVI_LOCAL });
      await waitForJobs(app.api);
    });

    const vueLocale = async (n) => app.api('GET', `/api/local-tasks/${localId}/dirs/${dirId}/passes/${n}/diffview`);

    test('chaque itération hors dépôt porte son propre diff', async () => {
      const liste = (await app.api('GET', `/api/local-tasks/${localId}/dirs/${dirId}/passes`)).body.passes;
      assert.deepEqual(liste.map((p) => p.kind), ['run', 'followup']);
      assert.deepEqual(liste.map((p) => p.has_diff), [true, true]);
    });

    /* Le point qui distingue un diff d'itération d'un diff cumulé : les deux passes écrivent
       ici la MÊME ligne dans le même fichier. Le diff de la seconde ne doit donc porter QUE
       l'ajout de la seconde — et le fichier, lui, en compte bien deux au bout. */
    test('le diff d’un suivi hors dépôt ne porte que l’ajout de ce suivi', async () => {
      const lignes = (d) => ajouts(d).split('\n').filter(Boolean).length;
      const p1 = lignes((await vueLocale(1)).body.diff);
      const p2 = lignes((await vueLocale(2)).body.diff);
      assert.ok(p1 >= 1 && p2 >= 1, `${p1} / ${p2}`);
      assert.equal(p2, p1, 'les deux passes ont écrit la même chose : autant de lignes chacune');

      const trace = fs.readFileSync(path.join(dossier, 'PROJ_LOCAL_DRYRUN.md'), 'utf8');
      assert.equal(trace.split('## ').length - 1, 2, 'le fichier, lui, a bien reçu les deux passages');
    });

    /* LA RÈGLE DU HORS-DÉPÔT : on ne dépose rien chez l'utilisateur. Pas même le `.git` qui
       sert à mesurer — il vit dans le dossier de travail de Mergerie. */
    test('le dossier de l’utilisateur ne reçoit aucun dépôt git', async () => {
      assert.equal(fs.existsSync(path.join(dossier, '.git')), false);
      const suivi = path.join(app.dataDir, 'tasks', 'local', String(localId), String(dirId), 'suivi.git');
      assert.equal(fs.existsSync(suivi), true, 'le suivi existe, mais ailleurs');
    });

    test('les dépendances installées ne sont pas suivies', async () => {
      const { body } = await vueLocale(2);
      assert.ok(body.files.some((f) => f.path === 'index.js'), 'le code, lui, est bien là');
      assert.deepEqual(body.files.filter((f) => f.path.startsWith('node_modules/')), []);
    });

    test('le fichier entier d’une itération hors dépôt se lit', async () => {
      const r = await app.api('GET', `/api/local-tasks/${localId}/dirs/${dirId}/passes/2/file?path=index.js`);
      assert.equal(r.status, 200);
      assert.match(r.body.content, /const a = 1/);
    });

    /* LE MÉNAGE. Un dépôt de suivi ne doit jamais survivre à ce qu'il suivait : changer la
       liste des dossiers d'une session recrée ses lignes avec de NOUVEAUX identifiants, et
       l'ancien suivi n'est plus atteignable par personne. Ce qui est encore référencé, lui,
       reste — une itération se relit des mois plus tard. */
    test('le ménage emporte les dépôts de suivi que plus rien ne référence, et garde les autres', async () => {
      const snapshot = require('../src/localsnapshot');
      const vivant = snapshot.dossierSuivi(localId, dirId);
      assert.equal(fs.existsSync(vivant), true);

      // Un orphelin, tel qu'en fabrique une édition de la liste des dossiers.
      const orphelin = snapshot.dossierSuivi(localId, 99999);
      fs.mkdirSync(orphelin, { recursive: true });
      fs.writeFileSync(path.join(orphelin, 'HEAD'), 'ref: refs/heads/main\n');

      const r = await snapshot.menage();
      assert.equal(fs.existsSync(orphelin), false, 'l’orphelin est parti');
      assert.equal(fs.existsSync(vivant), true, 'celui d’une session vivante est resté');
      assert.equal(r.supprimes, 1);
      assert.ok(r.compactes >= 1, JSON.stringify(r));

      // …et ce qu'il gardait se relit encore : compacter n'est pas perdre.
      const apres = await vueLocale(2);
      assert.equal(apres.status, 200);
      assert.ok(apres.body.files.some((f) => f.changed));
    });

    /* UN DOSSIER DÉMESURÉ NE DOIT PAS RALENTIR LE CODAGE. Au-delà du plafond, la mesure est
       abandonnée — une fois pour toutes sur ce dossier — et la session, elle, aboutit. */
    test('au-delà du plafond, on renonce à mesurer sans faire échouer la session', async () => {
      const snapshot = require('../src/localsnapshot');
      const plafond = snapshot.LIMITES.fichiers;
      snapshot.LIMITES.fichiers = 0;
      try {
        const d2 = fs.mkdtempSync(path.join(app.dataDir, 'gros-'));
        fs.writeFileSync(path.join(d2, 'a.js'), 'a\n');
        const lt = (await app.api('POST', '/api/local-tasks', { prompt: 'travaille ici', dirs: [d2] })).body;
        await app.api('POST', `/api/local-tasks/${lt.id}/run`);
        await waitForJobs(app.api);
        const t2 = (await app.api('GET', `/api/local-tasks/${lt.id}`)).body.task;
        assert.equal(t2.status, 'done', 'le codage aboutit quand même');
        const liste = (await app.api('GET', `/api/local-tasks/${lt.id}/dirs/${t2.dirs[0].id}/passes`)).body.passes;
        assert.deepEqual(liste.map((p) => [p.has_diff, p.no_change]), [[false, false]], 'aucune promesse de diff');
      } finally { snapshot.LIMITES.fichiers = plafond; }
    });
  });

  describe('à l’écran', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
    let navigateur; let page;
    const erreurs = [];

    before(async () => {
      navigateur = await lancerNavigateur();
      page = await navigateur.newPage({ viewport: { width: 1400, height: 900 } });
      page.on('pageerror', (e) => erreurs.push(e.message));
      await page.goto(app.base);
      await page.locator('nav button[data-tab="task"]').click();
      await page.locator('#tab-task .subnav [data-kind="code"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#taskList .task-row').length > 0);
    });
    after(async () => { if (navigateur) await navigateur.close(); });

    // Ouvre « Retour de l'IA » de la session, puis l'itération demandée.
    async function ouvrirIteration(n) {
      if (await page.locator('#taskMdView').isVisible()) await page.locator('#taskMdClose').click();
      await page.locator(`#taskList .task-row[data-task="${tacheId}"] [data-tgout="${cibleId}"]`).click();
      await page.waitForSelector('#taskPassList .pass-item');
      await page.locator(`#taskPassList .pass-item[data-pass="${n}"] .pass-open`).click();
      await page.waitForFunction((v) => {
        const a = document.querySelector('#taskPassList .pass-item.active');
        return a && a.dataset.pass === String(v);
      }, n);
    }

    test('le bouton de l’itération ouvre le diff de cette itération, et lui seul', async () => {
      await ouvrirIteration(2);
      await page.locator('#taskMdBody [data-passdiff="2"]').click();
      await page.waitForSelector('#splitView:not([hidden])');
      /* On attend le CONTENU, pas la vue : le viewer s'affiche avant d'avoir chargé son
         premier fichier, et l'assertion tomberait sur un écran encore vide. */
      await page.waitForFunction(() => document.querySelector('#fileContent').textContent.length > 10);

      const titre = await page.locator('#splitTitle').textContent();
      assert.match(titre, /ai\/sante/);
      assert.match(titre, /2/, `l’itération doit être nommée dans le titre : ${titre}`);
      // La demande de CE suivi reste sous les yeux : un diff relu sans elle n'apprend rien.
      assert.match(await page.locator('#splitMd').textContent(), new RegExp(SUIVI));
    });

    /* Le diff s'ouvre PAR-DESSUS la liste des itérations. Échap doit rendre la liste, pas
       tout refermer : sinon on revient aux sessions et on a perdu l'itération qu'on lisait. */
    test('Échap referme le diff et rend l’itération, pas la liste des sessions', async () => {
      const etat = await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return { diff: document.querySelector('#splitView').hidden, iterations: document.querySelector('#taskMdView').hidden };
      });
      assert.deepEqual(etat, { diff: true, iterations: false });
    });

    /* Le même geste hors dépôt, depuis l'onglet « Codage personnalisé ». Un dossier n'a pas de
       branche : le titre ne doit pas porter le tiret qui l'annoncerait. */
    test('hors dépôt aussi, l’itération ouvre son propre diff', async () => {
      // La vue des itérations du test précédent est encore là, et son voile prendrait le clic.
      if (await page.locator('#taskMdView').isVisible()) await page.locator('#taskMdClose').click();
      await page.locator('#tab-task .subnav [data-kind="local"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#localList .card').length > 0);
      await page.locator(`#localList .card[data-local="${localSession.id}"] [data-lout]`).click();
      await page.waitForSelector('#taskPassList .pass-item');
      await page.locator('#taskPassList .pass-item[data-pass="2"] .pass-open').click();
      await page.waitForFunction(() => {
        const a = document.querySelector('#taskPassList .pass-item.active');
        return a && a.dataset.pass === '2';
      });
      await page.locator('#taskMdBody [data-passdiff="2"]').click();
      await page.waitForSelector('#splitView:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#fileContent').textContent.length > 10);

      const titre = await page.locator('#splitTitle').textContent();
      assert.match(titre, /hd-/, `le dossier doit être nommé : ${titre}`);
      assert.doesNotMatch(titre, /—\s*·/, `pas de tiret sans branche à annoncer : ${titre}`);
      await page.locator('#splitClose').click();
      await page.waitForSelector('#splitView', { state: 'hidden' });
    });

    test('aucune erreur JavaScript pendant tout ce parcours', () => {
      assert.deepEqual(erreurs, []);
    });
  });
});
