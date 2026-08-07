'use strict';
/* Health check — le minuteur et le démarrage.
 *
 * Ce qui se joue ici ne se voit pas depuis les routes : deux cycles qui se marchent dessus,
 * et un certificat déclaré mais absent. Les deux sont silencieux par nature — c'est
 * précisément pour ça qu'ils méritent un test. Le reste (verdicts, opt-in, purge) est couvert
 * par `e2e-links.test.js`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-unit-'));

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const health = require('../src/health');
const links = require('../src/links');
const db = require('../src/db');

const MSGS = { nomVide: 'x', nomPris: 'x', urlInvalide: 'x', tropDeTags: 'x', inconnu: 'x', envInconnu: 'x' };

const dodo = (ms) => new Promise((r) => setTimeout(r, ms));

describe('le minuteur ne lance qu’un cycle à la fois', () => {
  let serveur;
  let port;
  let recues = 0;

  before(async () => {
    /* Un service qui répond LENTEMENT : c'est le cas qui provoque le chevauchement. Vingt
       cases en délai dépassé font cent secondes de cycle, pour un intervalle plancher d'une
       minute — ici on tient la même disproportion en millisecondes. */
    serveur = http.createServer((req, res) => {
      recues += 1;
      setTimeout(() => { res.writeHead(200); res.end(); }, 120);
    });
    await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
    port = serveur.address().port;

    const env = links.creerEnvironnement({ name: 'dev', health_check: 1 }, MSGS);
    for (let i = 0; i < 5; i += 1) {
      const svc = links.creerService({ name: `lent-${i}` }, MSGS);
      links.poserUrl(svc.id, { environment_id: env.id, url: `http://127.0.0.1:${port}/${i}` }, MSGS);
    }
  });

  after(async () => { await new Promise((r) => serveur.close(r)); });

  test('un battement qui tombe pendant un cycle ne lance pas le second', async () => {
    const cases = db.prepare('SELECT COUNT(*) c FROM service_url').get().c;   // 5
    recues = 0;
    /* Battement de 15 ms, intervalle de 10 battements (150 ms), cycle séquentiel de
       5 × 120 ms ≈ 600 ms. Le cycle dure QUATRE FOIS l'intervalle : c'est la disproportion
       réelle (vingt cases en délai dépassé = 100 s, pour un intervalle plancher de 60 s), et
       c'est le seul cas où le défaut se manifeste. Sans verrou, quatre cycles partent
       les uns par-dessus les autres pendant que le premier tourne encore. */
    const t = health.demarrer(() => ({ health_check: '1', health_minutes: 10 }), () => Date.now(), () => {}, 15);
    await dodo(700);
    clearInterval(t);
    await dodo(200);

    assert.ok(recues <= cases, `un seul cycle doit être passé : ${recues} requêtes pour ${cases} cases`);
    assert.ok(recues > 0, 'et il doit bien être passé');
  });

  /* Le repère de temps est posé à la FIN du cycle : l'intervalle SÉPARE deux cycles, il ne
     court pas pendant l'un d'eux. Posé au lancement, un cycle plus long que l'intervalle
     enchaînerait sans répit. */
  test('sans client qui regarde, rien ne sort sur le réseau', async () => {
    recues = 0;
    const jamais = Date.now() - 10 * 60 * 1000;      // dernier signe de vie il y a dix minutes
    const t = health.demarrer(() => ({ health_check: '1' }), () => jamais, () => {}, 15);
    await dodo(200);
    clearInterval(t);
    assert.equal(recues, 0);
  });
});

/* Un CA déclaré mais introuvable échoue en silence : le premier appel rejette, puis la
   fabrique d'agents ayant mis son résultat en cache, tous les suivants retombent sur l'agent
   par défaut. Les URLs internes restent « down » sans que rien ne l'explique. */
test('un GITLAB_CA_CERT introuvable se signale au démarrage', () => {
  const absent = path.join(os.tmpdir(), 'ca-qui-nexiste-pas.pem');
  /* Dans un processus neuf : l'avertissement part au CHARGEMENT du module, celui d'ici est
     déjà chargé. Et il ne fait pas tomber le démarrage — c'est un mot, pas une erreur. */
  const lance = (env) => {
    const r = spawnSync(process.execPath, ['-e', "require('./src/health')"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, MERGERIE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'h-')), ...env },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'le chargement ne doit pas échouer pour autant');
    return r.stderr || '';
  };
  const avec = lance({ GITLAB_CA_CERT: absent });
  assert.match(avec, /GITLAB_CA_CERT introuvable/);
  assert.match(avec, new RegExp(absent.replace(/[.\\/]/g, '\\$&')), 'le chemin fautif est cité');

  const sans = lance({ GITLAB_CA_CERT: '' });
  assert.doesNotMatch(sans, /introuvable/, 'et pas de bruit quand rien n’est déclaré');
});
