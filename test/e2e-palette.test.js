'use strict';
/* La palette Ctrl+K, côté serveur — ce que le cœur sait chercher (actions du client, merge requests, sessions) et la façon dont les entrées d'un plugin la
 * rejoignent. Les liens de travail n'en font plus partie : c'est le plugin `links` (dépôt `link-mergerie`) qui répond pour eux, et ses tests le prouvent.
 *
 * Un seul `startApp()` pour tout le fichier.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startApp } = require('./helpers/app');

describe('Palette — les sources du cœur', () => {
  let app;
  before(async () => { app = await startApp(); await app.configure(); });
  after(async () => { if (app) await app.stop(); });

  const cherche = async (q, actions = []) => (await app.api('POST', '/api/launcher', { q, actions })).body.results;

  test('les actions du client entrent dans le classement', async () => {
    const r = await cherche('docker', [{ id: 'act:1', label: 'Docker' }]);
    assert.ok(r.some((x) => x.kind === 'nav'), 'les actions du client sont classées avec le reste');
  });

  /* La palette s'ouvre PLEINE, mais de ce qu'on vient y chercher : les actions du client, que l'application envoie toujours. */
  test('une requête vide rend quand même des résultats — la palette s’ouvre pleine', async () => {
    const r = await cherche('', [{ id: 'act:0', label: 'Aller aux reviews' }]);
    assert.ok(r.length > 0, 'une palette qui s’ouvre vide se referme sans avoir servi');
    assert.equal(r[0].group, 'nav');
  });

  /* PALETTE OUVERTE, RIEN DE TAPÉ. Sans requête, tout se vaut : on y montre un échantillon des trois choses qu'on vient y chercher, trois de chaque. */
  test('à vide : trois actions, trois merge requests, trois sessions', async () => {
    const repo = app.db.prepare('SELECT id FROM repo LIMIT 1').get()
      || { id: (await app.api('POST', '/api/repos', { project: 'grp/palette', url: 'https://x.test/p.git' })).body.id };
    const now = new Date().toISOString();
    // Quatre de chaque, pour que le plafond de trois soit une VRAIE coupe, pas un hasard.
    for (let i = 0; i < 4; i += 1) {
      app.db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, status, updated_at)
        VALUES (?, ?, ?, 'main', 'to_review', ?)`).run(repo.id, 900 + i, `MR palette ${i}`, now);
      app.db.prepare(`INSERT INTO task (repo_id, prompt, branch, kind, label, created_at, updated_at)
        VALUES (?, ?, ?, 'code', ?, ?, ?)`).run(repo.id, `prompt ${i}`, `feat/pal-${i}`, `Session palette ${i}`, now, now);
    }
    const actions = [{ id: 'act:0', label: 'A' }, { id: 'act:1', label: 'B' }, { id: 'act:2', label: 'C' }, { id: 'act:3', label: 'D' }];
    const r = await cherche('', actions);
    assert.deepEqual(r.map((x) => x.group), ['nav', 'nav', 'nav', 'mrs', 'mrs', 'mrs', 'tasks', 'tasks', 'tasks'],
      `trois de chaque, dans l'ordre Actions → MR → Sessions, vu : ${JSON.stringify(r.map((x) => x.group))}`);
    // Les plus RÉCENTES : c'est ce qu'on vient rouvrir.
    assert.match(r.find((x) => x.group === 'mrs').label, /903/);
    assert.match(r.find((x) => x.group === 'tasks').label, /Session palette 3/);
  });

  /* Une session se retrouve par son libellé, son prompt ou sa branche. */
  test('une session se cherche par son libellé et ramène à son sous-onglet', async () => {
    const r = await cherche('Session palette 2');
    const s = r.find((x) => x.kind === 'task');
    assert.ok(s, `la session doit sortir, vu : ${JSON.stringify(r.map((x) => x.label))}`);
    assert.equal(s.nav.tab, 'task');
    assert.equal(s.nav.task_kind, 'code', 'la saveur voyage avec le résultat : sans elle on ouvre le mauvais sous-onglet');
    assert.ok(s.nav.task_id > 0);
    assert.ok((await cherche('feat/pal-1')).some((x) => x.kind === 'task'), 'la branche aussi désigne la session');
  });

  /* Le plafond par source est un garde-fou contre une réponse démesurée — pas un filtre sur ce qui est CHERCHABLE : une merge request au-delà des plus
     récentes se trouve par son numéro et par les mots de son titre. */
  test('une merge request ancienne se trouve par son numéro, le plafond ne la cache pas', async () => {
    const repo = app.db.prepare('SELECT id FROM repo LIMIT 1').get();
    const ins = app.db.prepare("INSERT INTO mr (repo_id, iid, title, status, updated_at) VALUES (?,?,?,'to_review',?)");
    const now = new Date().toISOString();
    for (let i = 200; i <= 400; i += 1) ins.run(repo.id, i, `Lot numero ${i}`, now);
    assert.deepEqual((await cherche('!214')).map((r) => r.label), ['!214 — Lot numero 214']);
    assert.deepEqual((await cherche('numero 214')).map((r) => r.label), ['!214 — Lot numero 214'], 'et par les mots de son titre');
  });

  /* Le `%` d'une saisie est du TEXTE, pas un joker SQL : sans échappement, le taper ramènerait toute la base. Les accents sont normalisés des deux côtés. */
  test('les jokers saisis ne font rien remonter, les accents ne cachent rien', async () => {
    assert.equal((await cherche('%')).length, 0);
    assert.equal((await cherche('_')).length, 0);
    const now = new Date().toISOString();
    app.db.prepare("INSERT INTO note_page (title, content, created_at, updated_at) VALUES ('Génération du rapport', '', ?, ?)").run(now, now);
    for (const q of ['generation', 'génération', 'GÉNÉRATION']) {
      assert.ok((await cherche(q)).some((x) => x.kind === 'note' && x.label === 'Génération du rapport'), q);
    }
  });

  /* Les entrées d'un plugin rejoignent la liste : celles qui nomment un groupe l'ouvrent, les autres suivent la section « actions ». Un plugin sans
     fournisseur de palette ne change rien. */
  test('un plugin ajoute ses entrées : son groupe en tête, les autres derrière les actions', async () => {
    const inst = await app.api('POST', '/api/plugins/install', { path: path.join(__dirname, 'fixtures', 'plugins', 'palette-fournisseur') });
    assert.equal(inst.status, 200, JSON.stringify(inst.body));
    assert.equal((await app.api('POST', '/api/plugins/palette-fournisseur/enable')).body.ok, true);
    const r = await cherche('zorglub', [{ id: 'act:0', label: 'zorglub (action du client)' }]);
    assert.equal(r[0].group, 'links', 'une entrée qui nomme son groupe ouvre la liste');
    assert.equal(r[0].kind, 'plugin:palette-fournisseur');
    assert.equal(r[0].nav.url, 'https://zorglub.test/');
    assert.ok(r.findIndex((x) => x.group === 'actions' && x.label === 'Zorglub sans groupe') > r.findIndex((x) => x.kind === 'nav'), 'une entrée sans groupe suit les actions du cœur');
    assert.deepEqual(await cherche(''), (await cherche('')), 'à vide, le plugin ne parle pas');
    assert.ok(!(await cherche('')).some((x) => x.kind === 'plugin:palette-fournisseur'));
  });
});
