'use strict';
/* LE REGISTRE DES FAMILLES — ce qui part dans le dépôt d'équipe, ce qui reste ici.
 *
 * `src/store-registry.js` est une déclaration : elle ne s'exécute pas, donc rien ne la contredit
 * quand elle ment. Ces tests sont ce qui la tient. Ils lisent le schéma d'une base NEUVE — donc
 * migrations jouées, donc les vraies colonnes — et confrontent chaque ligne du registre à ce
 * schéma.
 *
 * Le contrôle qui compte est le troisième : une colonne dont le NOM dit qu'elle porte un secret
 * ou un chemin de poste (`access_token`, `session_key`, `md_path`, `session_cwd`) doit être
 * déclarée locale, ou justifiée nommément. C'est la seule barrière qui échoue en se FERMANT :
 * une colonne ajoutée l'an prochain et oubliée fait échouer les tests au lieu de partir sur la
 * forge. Un secret commité dans git est définitif — l'historique est immuable, chaque clone le
 * garde, la forge le garde ; il faut révoquer. La barrière vaut donc plus que sa gêne.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-registry-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const registre = require('../src/store-registry');

describe('store-registry — la classification des tables', () => {
  let colonnes;   // table -> [colonnes], lu d'une base NEUVE
  let tables;

  before(() => {
    const db = require('../src/db');
    tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((r) => r.name);
    colonnes = new Map(tables.map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)]));
  });

  test('chaque table d’une base neuve a une famille, et réciproquement', () => {
    const declarees = registre.REGISTRE.map((e) => e.table).sort();
    const reelles = tables.filter((t) => !registre.TRANSITOIRES.includes(t)).sort();
    assert.deepEqual(declarees, reelles,
      'une table sans famille se classerait toute seule plus tard, et l’oubli est silencieux');
  });

  test('aucune table n’est déclarée deux fois', () => {
    const vues = new Set();
    for (const e of registre.REGISTRE) {
      assert.ok(!vues.has(e.table), `${e.table} est déclarée deux fois — laquelle fait foi ?`);
      vues.add(e.table);
    }
  });

  test('toute colonne au nom de secret ou de chemin de poste est locale, ou justifiée', () => {
    const fautes = [];
    for (const e of registre.REGISTRE) {
      if (e.famille !== 'P' && !(e.partagees || []).length) continue;
      const locales = new Set(e.locales || []);
      // Sur une table C à colonnes partagées (`mr`), seul ce qui est listé sort : le reste est déjà retenu.
      const candidates = e.famille === 'P' ? colonnes.get(e.table) : e.partagees;
      for (const col of candidates) {
        if (locales.has(col)) continue;
        if (registre.EXCEPTIONS[`${e.table}.${col}`]) continue;
        const interdit = registre.INTERDITS.find((re) => re.test(col));
        if (interdit) fautes.push(`${e.table}.${col} (${interdit}) — ni locale, ni justifiée dans EXCEPTIONS`);
      }
    }
    assert.deepEqual(fautes, [], `colonnes qui partiraient dans le dépôt :\n  ${fautes.join('\n  ')}`);
  });

  test('les colonnes déclarées locales ou partagées existent vraiment', () => {
    const fautes = [];
    for (const e of registre.REGISTRE) {
      /* `config` s'étend sur DEUX tables : ce que l'équipe a décidé y reste, ce qui appartient
         au poste vit dans `local_config`. Certains réglages — l'adresse du dépôt de données —
         n'ont même jamais existé côté équipe. Le classement porte donc sur l'union des deux. */
      const cols = new Set(e.table === 'config'
        ? [...colonnes.get('config'), ...colonnes.get('local_config')]
        : (colonnes.get(e.table) || []));
      for (const c of e.locales || []) if (!cols.has(c)) fautes.push(`${e.table}.${c} déclarée locale, absente du schéma`);
      for (const c of e.partagees || []) if (!cols.has(c)) fautes.push(`${e.table}.${c} déclarée partagée, absente du schéma`);
    }
    assert.deepEqual(fautes, [], fautes.join('\n'));
  });

  test('chaque justification d’EXCEPTIONS porte sur une colonne qui existe', () => {
    // Une justification périmée est pire que pas de justification : elle couvre un nom qui a pu
    // être réattribué à autre chose.
    for (const cle of Object.keys(registre.EXCEPTIONS)) {
      const [table, col] = cle.split('.');
      assert.ok(colonnes.has(table), `EXCEPTIONS mentionne une table inconnue : ${table}`);
      assert.ok(colonnes.get(table).includes(col), `EXCEPTIONS mentionne une colonne inconnue : ${cle}`);
      assert.ok(String(registre.EXCEPTIONS[cle]).length > 10, `${cle} : une exception se justifie en une phrase`);
    }
  });

  test('une table partagée sait devenir un fichier : son propre fichier, ou une liste chez son parent', () => {
    for (const e of registre.REGISTRE.filter((x) => x.famille === 'P')) {
      const propre = Boolean(e.cle && e.chemin);
      const fille = Boolean(e.parent && e.liste);
      assert.ok(propre !== fille, `${e.table} : « cle + chemin » OU « parent + liste », pas les deux ni aucun`);
      if (fille) {
        const p = registre.pour(e.parent);
        assert.ok(p, `${e.table} : parent « ${e.parent} » absent du registre`);
        assert.equal(e.fusion, 'parent', `${e.table} : une liste fille suit la fusion de son parent`);
      }
      if (propre) assert.ok(['append-only', 'last-writer'].includes(e.fusion), `${e.table} : fusion « ${e.fusion} »`);
    }
  });

  test('la clé d’une table partagée est une colonne réelle, ou une identité que le lot 2 ajoute', () => {
    // `uid` (ULID) et `slug` n'existent pas encore : ils arrivent avec le lot 2. Ce test les
    // accepte nommément — pas « n'importe quel nom inconnu ».
    const A_VENIR = new Set(['uid', 'slug']);
    for (const e of registre.REGISTRE.filter((x) => x.famille === 'P' && x.cle)) {
      const cols = colonnes.get(e.table) || [];
      assert.ok(cols.includes(e.cle) || A_VENIR.has(e.cle),
        `${e.table} : clé « ${e.cle} » qui n’est ni une colonne ni une identité prévue`);
    }
  });

  test('aucun fichier de deux tables ne se marche dessus, sauf les sessions qui partagent un dossier', () => {
    // Trois genres de session (dépôt, hors dépôt, question) écrivent `sessions/{uid}/session.json` :
    // l'uid est un ULID, donc deux sessions ne se rencontrent jamais, quel que soit leur genre.
    const SESSIONS = new Set(['task', 'question', 'local_task']);
    const vus = new Map();
    for (const e of registre.REGISTRE.filter((x) => x.chemin && x.famille === 'P')) {
      if (SESSIONS.has(e.table)) continue;
      assert.ok(!vus.has(e.chemin), `${e.table} et ${vus.get(e.chemin)} écrivent le même gabarit : ${e.chemin}`);
      vus.set(e.chemin, e.table);
    }
  });

  test('cheminDe remplit le gabarit, et refuse de deviner un champ manquant', () => {
    assert.equal(registre.cheminDe('todo', { uid: '01J9' }), 'todos/01J9.json');
    assert.equal(registre.cheminDe('repo', { forge: 'gitlab', project: 'acme/web' }),
      'repos/gitlab/acme/web.json');
    // Un champ vide donnerait `todos/.json` — un fichier unique où toutes les todos s'écraseraient.
    assert.throws(() => registre.cheminDe('todo', {}), /uid/);
    assert.throws(() => registre.cheminDe('todo', { uid: '' }), /uid/);
    assert.equal(registre.cheminDe('job_log', { id: 1 }), null, 'une table C n’a pas de fichier');
  });

  test('partage() dit vrai des tables P et de `mr`, faux du reste', () => {
    assert.equal(registre.partage('todo'), true);
    assert.equal(registre.partage('mr'), true, 'mr est un cache, mais son état de relecture se partage');
    assert.equal(registre.partage('job_log'), false);
    assert.equal(registre.partage('local_root'), false);
    assert.equal(registre.partage('table_qui_nexiste_pas'), false);
  });

  test('les deux listes de `config` couvrent son schéma exactement, sans recouvrement', () => {
    /* `config` est le seul fourre-tout du schéma : des gabarits de prompt y voisinent avec sept
       jetons d'API. Ailleurs, une colonne nouvelle est partagée par défaut et c'est le bon
       défaut ; ici ce serait une fuite. Les deux listes doivent donc COUVRIR le schéma —
       une colonne ajoutée demain n'appartient à aucune, et ce test rougit. */
    const e = registre.pour('config');
    const declarees = [...(e.locales || []), ...(e.partagees || [])].sort();
    // L'union des deux tables : un réglage de poste peut ne jamais avoir existé côté équipe.
    const reelles = [...new Set([...colonnes.get('config'), ...colonnes.get('local_config')])].sort();
    assert.deepEqual(declarees, reelles, 'toute colonne de config est « de poste » ou « d’équipe »');
    assert.equal(new Set(declarees).size, declarees.length, 'aucune colonne des deux côtés à la fois');
  });

  test('les jetons de config sont locaux — le contrôle nominatif, pas seulement le motif', () => {
    // Ce test nomme les colonnes une par une : un renommage de `access_token` en `forge_auth`
    // passerait sous le radar de INTERDITS, pas sous celui-ci.
    const locales = new Set(registre.localesDe('config'));
    for (const secret of ['access_token', 'github_token', 'jira_token', 'jenkins_token',
      'jira_email', 'jenkins_user', 'dictation_api_key', 'clone_path']) {
      assert.ok(locales.has(secret), `config.${secret} doit rester sur le poste`);
    }
    // Et l'inverse : les gabarits de prompt sont d'équipe (décision § 13 de la spec).
    for (const equipe of ['prompt_review', 'prompt_explain', 'prompt_modify', 'prompt_fix',
      'review_skill', 'ai_extra_instructions']) {
      assert.ok(!locales.has(equipe), `config.${equipe} est d’équipe : deux reviews avec des consignes différentes ne sont pas comparables`);
    }
  });
});
