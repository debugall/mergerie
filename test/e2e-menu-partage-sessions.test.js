'use strict';
/* PARTAGE, OBJET PAR OBJET — LES SESSIONS HORS DÉPÔT, D'EXPLORATION ET LES QUESTIONS LIBRES.
 *
 * `e2e-menu-devia-partage` éprouve la saveur « codage » (bouton de carte, carte d'un collègue,
 * filtre) et la case de la modale dans les trois envois. Restaient les trois autres saveurs, qui
 * ont chacune leur liste, leur carte et leur route de partage (`/local-tasks/:id/share`,
 * `/questions/:id/share`, `/tasks/:id/share` pour une exploration) — un bouton câblé sur une
 * saveur ne prouve rien pour sa voisine.
 *
 * Pour chacune, par l'écran :
 *   - « partager » depuis la carte pose le drapeau (relu par l'API), le fichier ARRIVE dans le
 *     dépôt nu au tour de synchro suivant, et « ne plus partager » l'en RETIRE ;
 *   - la session d'un collègue — arrivée comme la synchro la fait arriver : un fichier commité
 *     sous son nom dans le dépôt, puis un tour de ce poste — dit « par Claire », ne se supprime
 *     ni ne se départage, mais se range, et ranger ne touche pas au dépôt ;
 *   - le filtre « Toutes / Les miennes / L'équipe » sépare les deux dans CES listes-là.
 *
 * La cadence est poussée à 600 s : aucun tour automatique ne passe pendant le fichier, ce qu'on
 * voit arriver dans le dépôt vient du tour qu'on a demandé.
 *
 * Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  startApp, attendreServeur, waitForJobs, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const {
  creerDepotNu, fichiersDuDepot, collegue, synchroniserJusqua, uidDe,
} = require('./helpers/partage');

const { dispo } = navigateurDispo();

/* Les trois saveurs : où vit la carte, ce qui la nomme, la table, le fichier dans le dépôt, la
   route de l'API et le bouton de suppression. */
const SAVEURS = {
  explore: { liste: '#taskList', attr: 'data-task', table: 'task', fichier: 'session.json', route: 'tasks', suppr: 'data-tdel' },
  local: { liste: '#localList', attr: 'data-local', table: 'local_task', fichier: 'local.json', route: 'local-tasks', suppr: 'data-ldel' },
  ask: { liste: '#askList', attr: 'data-ask', table: 'question', fichier: 'question.json', route: 'questions', suppr: 'data-qdel' },
};

describe('Partage — sessions hors dépôt, explorations et questions libres', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let nav; let page; let racine; let nu; let claire;
  const erreurs = [];
  const ids = { miennes: {}, claire: {} };

  const uid = (kind, id) => app.db.prepare(`SELECT uid FROM ${SAVEURS[kind].table} WHERE id = ?`).get(id).uid;
  const cheminDe = (kind, id) => `sessions/${uid(kind, id)}/${SAVEURS[kind].fichier}`;
  const dansLeDepot = (f) => fichiersDuDepot(nu).includes(f);
  // Les fichiers des passes d'agent d'une session : `sessions/<uid de la session>/pass-<uid>.md`.
  const SCOPE = { explore: 'task', local: 'local', ask: 'ask' };
  const passesDe = (kind, id) => app.db.prepare('SELECT uid FROM agent_pass WHERE scope = ? AND task_id = ?')
    .all(SCOPE[kind], id).map((p) => `sessions/${uid(kind, id)}/pass-${p.uid}.md`);
  const lire = async (kind, id) => {
    const { body } = await app.api('GET', `/api/${SAVEURS[kind].route}`);
    return (Array.isArray(body) ? body : []).find((x) => x.id === id);
  };
  const carte = (kind, id) => `${SAVEURS[kind].liste} .card[${SAVEURS[kind].attr}="${id}"]`;
  const idsVisibles = (kind) => page.$$eval(`${SAVEURS[kind].liste} .card[${SAVEURS[kind].attr}]`,
    (els, a) => els.map((e) => Number(e.getAttribute(a))).sort((x, y) => x - y), SAVEURS[kind].attr);

  const aller = async (kind) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="task"]').click();
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.waitForFunction((k) => document.querySelector(`#tab-task .subnav [data-kind="${k}"]`)
      .classList.contains('active'), kind);
  };
  // Recharger la liste depuis le serveur, sans attendre le sondage.
  const recharger = () => page.evaluate(() => loadTasks());

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'partage-sessions-'));
    nu = creerDepotNu(racine);
    claire = collegue(racine, nu, 'Claire');
    await app.configure({ data_sync_seconds: '600' });
    const repoId = (await app.api('POST', '/api/repos', { project: 'eq/app', url: 'https://gitlab.test/eq/app' })).body.id;
    const localRoot = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    fs.mkdirSync(path.join(localRoot, 'projet'), { recursive: true });

    // Mes trois sessions, privées : rien ne part sans qu'on l'ait demandé.
    ids.miennes.explore = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Où est vérifié le jeton ?', targets: [{ repo_id: repoId }],
    })).body.id;
    ids.miennes.local = (await app.api('POST', '/api/local-tasks', {
      prompt: 'Range les imports du projet', dirs: [path.join(localRoot, 'projet')],
    })).body.id;
    ids.miennes.ask = (await app.api('POST', '/api/questions', { prompt: 'Quelle différence entre rebase et merge ?' })).body.id;
    /* La question tourne une fois (agent simulé) : elle a donc une PASSE, le retour de l'agent,
       qui n'a pas de case à elle et doit suivre la session dans le dépôt — et en sortir avec. */
    assert.equal((await app.api('POST', `/api/questions/${ids.miennes.ask}/run`)).status, 200);
    await waitForJobs(app.api);
    await attendreServeur(async () => Boolean(app.db.prepare("SELECT 1 FROM agent_pass WHERE scope = 'ask' AND task_id = ?")
      .get(ids.miennes.ask)), 'la question a sa passe');
    // Une exploration que Claire reprendra : partagée d'emblée.
    ids.claire.explore = (await app.api('POST', '/api/tasks', {
      kind: 'explore', prompt: 'Cartographie du module paiement', shared: 1, targets: [{ repo_id: repoId }],
    })).body.id;
    for (const [k, id] of Object.entries(ids.miennes)) assert.ok(id, `session ${k} créée`);

    const r = await app.api('POST', '/api/data-sync/attach', { url: nu });
    assert.equal(r.status, 200, r.text);
    await attendreServeur(async () => Boolean((await app.api('GET', '/api/data-sync')).body.dernierPush), 'le premier envoi');

    nav = await lancerNavigateur();
    page = await nav.newPage({ viewport: { width: 1400, height: 950 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="task"]');
  });
  after(async () => {
    if (nav) await nav.close();
    if (app) await app.stop();
  });

  /* ------------------------------------------------ partager depuis la carte ---- */

  for (const kind of ['explore', 'local', 'ask']) {
    test(`${kind} : « partager » depuis la carte envoie le fichier au dépôt, « ne plus partager » l’en retire`, async () => {
      const id = ids.miennes[kind];
      const fichier = cheminDe(kind, id);
      assert.equal(dansLeDepot(fichier), false, 'privée tant qu’on n’a rien demandé');
      await aller(kind);
      await recharger();
      const c = carte(kind, id);
      await page.waitForSelector(`${c} [data-share][data-on="0"]`);
      assert.equal(await page.locator(`${c} .note-partagee`).count(), 0);

      await page.locator(`${c} [data-share]`).click();
      await attendreServeur(async () => (await lire(kind, id)).shared === 1, 'le drapeau est posé côté serveur');
      await page.waitForSelector(`${c} .note-partagee`);
      await synchroniserJusqua(app, async () => dansLeDepot(fichier), `le fichier ${fichier} est dans le dépôt`);
      const passes = passesDe(kind, id);
      if (kind === 'ask') assert.ok(passes.length > 0, 'la question simulée a une passe');
      for (const p of passes) assert.ok(dansLeDepot(p), `la passe suit sa session : ${p}`);

      await page.locator(`${c} [data-share][data-on="1"]`).click();
      await attendreServeur(async () => (await lire(kind, id)).shared === 0, 'le drapeau est retiré côté serveur');
      await page.waitForSelector(`${c} .note-partagee`, { state: 'detached' });
      await synchroniserJusqua(app, async () => !dansLeDepot(fichier), `le fichier ${fichier} a quitté le dépôt`);
      for (const p of passes) assert.equal(dansLeDepot(p), false, `la passe part avec sa session : ${p}`);
      // Retirée du dépôt, elle reste chez moi : départager n'est pas supprimer.
      assert.ok(await lire(kind, id), 'la session existe toujours sur ce poste');
    });
  }

  /* ------------------------------------------------ les sessions d'un collègue ---- */

  test('préparation : Claire publie une question et une session hors dépôt, et reprend une exploration', async () => {
    const fichierExplo = cheminDe('explore', ids.claire.explore);
    await synchroniserJusqua(app, async () => dansLeDepot(fichierExplo), 'l’exploration partagée est dans le dépôt');
    const maintenant = new Date().toISOString();
    const uq = uidDe('CLQUEST1');
    const ul = uidDe('CLLOCAL1');
    // Le format que Mergerie écrit lui-même : clés triées, `flavour` qui dit la saveur.
    claire.publier('sessions de Claire', ({ ecrire, lireJson }) => {
      ecrire(`sessions/${uq}/question.json`, {
        created_at: maintenant, flavour: 'ask', followup_auto: 0, prompt: 'Question posée par Claire',
        status: 'new', uid: uq, updated_at: maintenant,
      });
      ecrire(`sessions/${ul}/local.json`, {
        ask_questions: 0, created_at: maintenant, dirs: [], flavour: 'local', followup_auto: 0,
        prompt: 'Nettoyage local de Claire', status: 'new', uid: ul, updated_at: maintenant,
      });
      const doc = lireJson(fichierExplo);
      doc.label = 'Reprise par Claire';
      ecrire(fichierExplo, doc);
    });
    await synchroniserJusqua(app, async () => {
      const q = ((await app.api('GET', '/api/questions')).body || []).find((x) => x.prompt === 'Question posée par Claire');
      const l = ((await app.api('GET', '/api/local-tasks')).body || []).find((x) => x.prompt === 'Nettoyage local de Claire');
      const e = await lire('explore', ids.claire.explore);
      if (q) ids.claire.ask = q.id;
      if (l) ids.claire.local = l.id;
      return q && q.author === 'Claire' && l && l.author === 'Claire' && e && e.author === 'Claire';
    }, 'les trois sessions sont reconnues comme celles de Claire');
    const q = await lire('ask', ids.claire.ask);
    assert.equal(q.shared, 1, 'arrivée du dépôt, elle y est donc partagée');
  });

  for (const kind of ['explore', 'local', 'ask']) {
    test(`${kind} : la carte d’un collègue dit « par Claire », se range, mais ne se supprime ni ne se départage`, async () => {
      await aller(kind);
      await recharger();
      const c = carte(kind, ids.claire[kind]);
      await page.waitForFunction((s) => /Claire/.test((document.querySelector(`${s} .task-cout`) || {}).textContent || ''), c);
      assert.equal(await page.locator(`${c} .note-partagee`).count(), 1, 'le pictogramme dit qu’elle est chez tout le monde');
      assert.equal(await page.locator(`${c} [${SAVEURS[kind].suppr}]`).count(), 0, 'supprimer ici l’effacerait chez tout le monde');
      assert.equal(await page.locator(`${c} [data-share]`).count(), 0, 'seule l’autrice décide de partager');
      assert.equal(await page.locator(`${c} [data-hide]`).count(), 1, 'ranger reste possible : c’est une préférence de poste');
      // …et ma session à moi, dans la même liste, garde ses deux boutons.
      const m = carte(kind, ids.miennes[kind]);
      await page.waitForSelector(`${m} [data-share]`);
      assert.equal(await page.locator(`${m} [${SAVEURS[kind].suppr}]`).count(), 1);

      // Ranger : la carte quitte la vue, la préférence est posée, le fichier reste dans le dépôt.
      const fichier = cheminDe(kind, ids.claire[kind]);
      await page.locator(`${c} [data-hide]`).click();
      await attendreServeur(async () => (await lire(kind, ids.claire[kind])).hidden === 1, 'la session est rangée');
      await page.waitForSelector(c, { state: 'detached' });
      await app.api('POST', '/api/data-sync/now');
      assert.ok(dansLeDepot(fichier), 'ranger chez soi ne retire rien du dépôt');
      await app.api('POST', `/api/${SAVEURS[kind].route}/${ids.claire[kind]}/hidden`, { hidden: 0 });
    });
  }

  test('le serveur tient la même règle que l’écran : ni départager ni supprimer la session d’un collègue', async () => {
    for (const kind of ['explore', 'local', 'ask']) {
      const id = ids.claire[kind];
      const route = SAVEURS[kind].route;
      assert.equal((await app.api('POST', `/api/${route}/${id}/share`, { shared: 0 })).status, 403, `${kind} : départager`);
      const del = await app.api('DELETE', `/api/${route}/${id}`);
      assert.equal(del.status, 403, `${kind} : supprimer`);
      assert.match(del.body.error, /Claire/, 'le refus dit à QUI elle est');
      assert.equal((await lire(kind, id)).shared, 1);
    }
    await app.api('POST', '/api/data-sync/now');
    for (const kind of ['explore', 'local', 'ask']) {
      assert.ok(dansLeDepot(cheminDe(kind, ids.claire[kind])), `${kind} : toujours dans le dépôt`);
    }
  });

  /* ------------------------------------------------ le filtre des listes ---- */

  for (const kind of ['local', 'ask', 'explore']) {
    test(`${kind} : « Les miennes / L’équipe / Toutes » sépare mon travail de celui de Claire`, async () => {
      await aller(kind);
      await recharger();
      await page.waitForSelector('#taskOwnerFiltre:not([hidden]) [data-task-proprio="toutes"]');
      await page.locator('#taskOwnerFiltre [data-task-proprio="toutes"]').click();
      const mienne = ids.miennes[kind];
      const sienne = ids.claire[kind];
      await page.waitForFunction(({ s, a, ids: v }) => {
        const vus = [...document.querySelectorAll(s)].map((e) => Number(e.getAttribute(a)));
        return v.every((i) => vus.includes(i));
      }, { s: `${SAVEURS[kind].liste} .card[${SAVEURS[kind].attr}]`, a: SAVEURS[kind].attr, ids: [mienne, sienne] });

      await page.locator('#taskOwnerFiltre [data-task-proprio="miennes"]').click();
      await page.waitForSelector(carte(kind, sienne), { state: 'detached' });
      assert.ok((await idsVisibles(kind)).includes(mienne), 'la mienne reste');
      await page.waitForSelector('#taskOwnerFiltre [data-task-proprio="miennes"].active');

      await page.locator('#taskOwnerFiltre [data-task-proprio="equipe"]').click();
      await page.waitForSelector(carte(kind, mienne), { state: 'detached' });
      assert.deepEqual(await idsVisibles(kind), [sienne], 'l’équipe, c’est Claire et elle seule');

      await page.locator('#taskOwnerFiltre [data-task-proprio="toutes"]').click();
      await page.waitForSelector(carte(kind, mienne));
      await page.waitForSelector(carte(kind, sienne));
    });
  }

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
