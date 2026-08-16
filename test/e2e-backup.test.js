'use strict';
/* Sauvegarde des données, et rétention de l'historique.
 *
 * Une sauvegarde ne vaut que par ce qu'on peut en RESTAURER : on ouvre donc l'archive avec
 * `unzip` — un outil tiers, qui ne partage rien avec le code testé — et on rouvre la base
 * qu'elle contient pour vérifier que les données y sont vraiment. Se contenter de compter
 * les octets laisserait passer une archive corrompue, ce qui ne se découvrirait que le jour
 * où l'on en a besoin.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp } = require('./helpers/app');

const dansLArchive = (fichier, entree) =>
  execFileSync('unzip', ['-p', fichier, entree.replace(/([[\]*?])/g, '\\$1')], { maxBuffer: 64 * 1024 * 1024 });
const listerArchive = (fichier) =>
  execFileSync('unzip', ['-Z1', fichier], { maxBuffer: 8 * 1024 * 1024 }).toString().split('\n').filter(Boolean);

/* UN SEUL démarrage pour tout le fichier : le harnais lance le serveur en processus, c'est
   un singleton — deux `startApp()` dans le même fichier se marchent dessus et le second
   n'obtient jamais la main. */
let app;
before(async () => { app = await startApp(); await app.configure(); });
after(async () => { if (app) await app.stop(); });

describe('Sauvegarde des données', () => {
  let archive;

  before(async () => {
    // De quoi peupler les trois familles de fichiers embarqués.
    fs.mkdirSync(path.join(app.dataDir, 'reviews', 'grp__app'), { recursive: true });
    fs.writeFileSync(path.join(app.dataDir, 'reviews', 'grp__app', 'review-v1.md'), '# Revue\n\nNote globale : 8/10\n');
    fs.mkdirSync(path.join(app.dataDir, 'tasks', '3'), { recursive: true });
    fs.writeFileSync(path.join(app.dataDir, 'tasks', '3', 'output.md'), 'ce que l’agent dit avoir fait\n');
    fs.mkdirSync(path.join(app.dataDir, 'tickets'), { recursive: true });
    fs.writeFileSync(path.join(app.dataDir, 'tickets', 'capture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    /* Un clone volumineux : il ne DOIT PAS entrer dans l'archive — il se retrouve avec un
       `git clone`, et l'inclure multiplierait la taille pour rien. */
    fs.mkdirSync(path.join(app.dataDir, 'clones', 'grp__app'), { recursive: true });
    fs.writeFileSync(path.join(app.dataDir, 'clones', 'grp__app', 'gros.bin'), Buffer.alloc(512 * 1024, 7));

    const res = await fetch(`${app.base}/api/backup`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /zip/);
    assert.match(res.headers.get('content-disposition') || '', /filename="mergerie-\d{4}-\d{2}-\d{2}/,
      'le nom porte la date : deux sauvegardes ne doivent pas s’écraser');
    archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'sauvegarde.zip');
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  });

  test('l’archive est valide et porte la base + les fichiers référencés', () => {
    assert.match(execFileSync('unzip', ['-t', archive]).toString(), /No errors detected/i);
    const noms = listerArchive(archive);
    assert.ok(noms.includes('reviewer.db'), 'la base est dedans');
    assert.ok(noms.includes('reviews/grp__app/review-v1.md'), 'les rapports aussi');
    assert.ok(noms.includes('tasks/3/output.md'), '…et les retours d’agent');
    assert.ok(noms.includes('tickets/capture.png'), '…et les captures de contexte');
  });

  test('les clones sont exclus : ils se retrouvent avec un git clone', () => {
    const noms = listerArchive(archive);
    assert.ok(!noms.some((n) => n.startsWith('clones/')), `aucun clone attendu, vu : ${noms.filter((n) => n.startsWith('clones/'))}`);
    // …et l'archive reste donc petite malgré le demi-mégaoctet posé à côté.
    assert.ok(fs.statSync(archive).size < 400 * 1024, `archive de ${Math.round(fs.statSync(archive).size / 1024)} Ko`);
  });

  /* Le test qui compte vraiment : la base extraite s'ouvre et contient les données. Une copie
     de fichier faite pendant une écriture donnerait une base corrompue — d'où l'API `backup()`
     de SQLite plutôt qu'un `cp`. */
  test('la base extraite s’ouvre et porte bien les données', () => {
    const dest = path.join(path.dirname(archive), 'reviewer.db');
    fs.writeFileSync(dest, dansLArchive(archive, 'reviewer.db'));
    // eslint-disable-next-line global-require
    const copie = require('better-sqlite3')(dest, { readonly: true });
    try {
      const tables = copie.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      assert.ok(tables.includes('mr') && tables.includes('review') && tables.includes('config'),
        `schéma attendu, vu : ${tables.slice(0, 8).join(',')}`);
      const attendu = app.db.prepare('SELECT COUNT(*) c FROM repo').get().c;
      assert.equal(copie.prepare('SELECT COUNT(*) c FROM repo').get().c, attendu,
        'les lignes sont là, pas seulement le schéma');
    } finally { copie.close(); }
  });

  /* Une archive qu'on ne sait plus restaurer ne vaut rien, et c'est six mois plus tard qu'on
     l'ouvre. Le mode d'emploi voyage donc avec elle. */
  test('un mode d’emploi accompagne l’archive', () => {
    const txt = dansLArchive(archive, 'LISEZ-MOI.txt').toString();
    assert.match(txt, /RESTAURER/);
    assert.match(txt, /Arrêter Mergerie/, 'la première étape est celle qu’on oublie');
    assert.match(txt, /clones/i, '…et ce qui n’est pas dedans est dit');
    assert.match(txt, /\d{4}-\d{2}-\d{2}T/, 'la date de la sauvegarde y figure');
  });
});

describe('Rétention de l’historique', () => {
  // eslint-disable-next-line global-require
  const retention = require('../src/retention');

  const vieux = (jours) => new Date(Date.now() - jours * 24 * 3600 * 1000).toISOString();

  // Un job terminé il y a `jours`, avec `n` lignes de journal.
  const poserJob = (jours, statut = 'done', n = 3) => {
    const id = app.db.prepare(
      "INSERT INTO job (kind, status, total, done_count, started_at, finished_at) VALUES ('review',?,1,1,?,?)",
    ).run(statut, vieux(jours), statut === 'running' ? null : vieux(jours)).lastInsertRowid;
    for (let i = 0; i < n; i += 1) {
      app.db.prepare('INSERT INTO job_log (job_id, ts, text) VALUES (?,?,?)').run(id, vieux(jours), `ligne ${i}`);
    }
    return id;
  };
  const compter = (t, id) => app.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${t === 'job' ? 'id' : 'job_id'} = ?`).get(id).c;

  test('au-delà du délai, journaux et jobs terminés sont supprimés', () => {
    const ancien = poserJob(120);
    const recent = poserJob(3);
    const r = retention.purger(90);
    assert.ok(r.job >= 1 && r.job_log >= 3, `des lignes doivent partir, vu ${JSON.stringify(r)}`);
    assert.equal(compter('job', ancien), 0, 'le job d’il y a 120 jours part');
    assert.equal(compter('job_log', ancien), 0, '…ses journaux aussi, sans rester orphelins');
    assert.equal(compter('job', recent), 1, 'celui d’il y a 3 jours reste');
    assert.equal(compter('job_log', recent), 3);
  });

  /* Un job encore EN COURS ne se purge jamais, quelle que soit sa date : un job lancé avant
     une longue coupure garderait sinon son statut sans une ligne pour l'expliquer. */
  test('un job en cours n’est jamais purgé, même très ancien', () => {
    const bloque = poserJob(400, 'running');
    retention.purger(30);
    assert.equal(compter('job', bloque), 1);
    assert.equal(compter('job_log', bloque), 3, 'son journal non plus — c’est lui qu’on lit');
  });

  test('0 = illimité : rien n’est supprimé', () => {
    const vieuxJob = poserJob(999);
    assert.equal(retention.purger(0), null, 'aucune purge annoncée');
    assert.equal(compter('job', vieuxJob), 1);
  });

  /* `usage` porte le coût CUMULÉ en tokens, affiché dans les statistiques : le purger ferait
     baisser un total censé ne jamais baisser. Il est épargné à dessein. */
  test('les coûts en tokens ne sont pas purgés', () => {
    app.db.prepare("INSERT INTO usage (kind, prompt_chars, output_chars, tokens_est, created_at) VALUES ('review',10,10,10,?)")
      .run(vieux(900));
    const avant = app.db.prepare('SELECT COUNT(*) c FROM usage').get().c;
    retention.purger(30);
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM usage').get().c, avant);
  });

  test('le réglage se borne : moins de 7 jours est remonté à 7, une saisie absurde vaut 0', async () => {
    assert.equal((await app.api('PUT', '/api/config', { retention_days: 1 })).body.retention_days, 7,
      'un délai d’un jour effacerait le journal qu’on est en train de lire');
    assert.equal((await app.api('PUT', '/api/config', { retention_days: 'beaucoup' })).body.retention_days, 0);
    assert.equal((await app.api('PUT', '/api/config', { retention_days: 30 })).body.retention_days, 30);
  });
});
