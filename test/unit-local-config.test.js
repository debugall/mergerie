'use strict';
/* LES RÉGLAGES SONT COUPÉS EN DEUX — et le poste garde ses secrets.
 *
 * `config` est ce que l'équipe a décidé (gabarits de prompt, seuils, politiques, URL de la
 * forge) : c'est cette table qui partira un jour dans le dépôt de données partagé.
 * `local_config` est ce qui appartient à CETTE machine : les six jetons d'API, le chemin des
 * clones, la langue.
 *
 * Ce que ces tests tiennent, et pourquoi : un jeton resté dans `config` serait poussé sur la
 * forge, et un secret commité dans git est DÉFINITIF — l'historique est immuable, chaque clone
 * le garde, la forge le garde ; il faut révoquer. Il ne suffit donc pas que la lecture soit
 * juste : il faut que la colonne d'origine soit vide, et qu'elle le reste après une écriture.
 *
 * Le tout sans rien changer pour l'utilisateur : `getConfig()` rend le même objet qu'avant.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-local-config-'));

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const registre = require('../src/data/store-registry');

const GELEES = registre.localesDe('config').filter((c) => c !== 'id');

describe('local_config — ce qui reste sur ce poste', () => {
  let db; let config;

  before(() => {
    db = require('../src/db');
    config = require('../src/data/config');
  });

  test('la table existe, avec sa ligne unique et les colonnes du registre', () => {
    const cols = db.prepare('PRAGMA table_info(local_config)').all().map((c) => c.name);
    assert.deepEqual([...cols].sort(), ['id', ...GELEES].sort());
    assert.equal(db.prepare('SELECT COUNT(*) n FROM local_config').get().n, 1);
  });

  test('au démarrage, les colonnes de poste de `config` sont vides — le drain a eu lieu', () => {
    const row = db.prepare('SELECT * FROM config WHERE id = 1').get();
    const restantes = GELEES.filter((c) => row[c] !== null && row[c] !== undefined && row[c] !== '');
    assert.deepEqual(restantes, [], 'une colonne gelée encore remplie repartirait dans le dépôt');
  });

  test('le chemin de clone par défaut a bien DÉMÉNAGÉ, il n’a pas été perdu', () => {
    // La ligne initiale de `config` naît avec DEFAULT_CLONE_DIR : si le drain se contentait de
    // vider, l'application cloner‍ait dans un chemin vide au premier démarrage.
    const { DEFAULT_CLONE_DIR } = require('../src/core/paths');
    assert.equal(db.prepare('SELECT clone_path AS p FROM local_config WHERE id = 1').get().p, DEFAULT_CLONE_DIR);
    assert.equal(config.getConfig().clone_path, DEFAULT_CLONE_DIR);
  });

  test('getConfig() rend UN objet : le reste de l’application ne voit pas la coupure', () => {
    const cfg = config.getConfig();
    for (const champ of ['access_token', 'clone_path', 'language']) {
      assert.ok(champ in cfg, `${champ} (poste) doit rester lisible depuis getConfig()`);
    }
    for (const champ of ['prompt_review', 'gitlab_url', 'converge_threshold', 'brief_on_open']) {
      assert.ok(champ in cfg, `${champ} (équipe) doit rester lisible depuis getConfig()`);
    }
  });

  test('un jeton enregistré atterrit dans local_config, et JAMAIS dans config', () => {
    config.updateConfig({
      access_token: 'glpat-SECRET', github_token: 'ghp-SECRET', jira_token: 'jira-SECRET',
      jenkins_token: 'jk-SECRET',
      jira_email: 'moi@example.com', jenkins_user: 'moi',
    });
    const c = db.prepare('SELECT * FROM config WHERE id = 1').get();
    const l = db.prepare('SELECT * FROM local_config WHERE id = 1').get();
    assert.equal(l.access_token, 'glpat-SECRET');
    assert.equal(config.getConfig().access_token, 'glpat-SECRET');
    const fuites = GELEES.filter((col) => c[col] !== null && c[col] !== undefined && c[col] !== '');
    assert.deepEqual(fuites, [], 'écrire un réglage ne doit jamais re-remplir une colonne gelée');
  });

  test('un réglage d’équipe atterrit dans config, et pas dans local_config', () => {
    config.updateConfig({ gitlab_url: 'https://gl.example.com/', prompt_review: 'RELIS TOUT' });
    const c = db.prepare('SELECT * FROM config WHERE id = 1').get();
    assert.equal(c.gitlab_url, 'https://gl.example.com', 'le slash final est toujours normalisé');
    assert.equal(c.prompt_review, 'RELIS TOUT');
    const cols = db.prepare('PRAGMA table_info(local_config)').all().map((x) => x.name);
    assert.ok(!cols.includes('prompt_review'), 'un gabarit de prompt n’a rien à faire côté poste');
  });

  test('destinationDe range chaque champ du bon côté', () => {
    assert.equal(config.destinationDe('access_token'), 'poste');
    assert.equal(config.destinationDe('language'), 'poste');
    assert.equal(config.destinationDe('clone_path'), 'poste');
    assert.equal(config.destinationDe('prompt_review'), 'equipe');
    assert.equal(config.destinationDe('gitlab_url'), 'equipe');
  });

  test('l’amorçage des commandes git ne se rejoue pas — son drapeau a suivi', () => {
    // Le drapeau `git_commands_seeded` est devenu une donnée de poste. Lu du mauvais côté après
    // le drain, il vaudrait 0 à chaque démarrage et les cinq commandes reviendraient en double.
    assert.equal(db.prepare('SELECT git_commands_seeded AS s FROM local_config WHERE id = 1').get().s, 1);
    const avant = db.prepare('SELECT COUNT(*) n FROM git_command').get().n;
    assert.equal(avant, 5);
  });

  /* Revue de add-secure-layer-2 : `agent_read_unrestricted` est une colonne INTEGER — relue,
     c'est le NOMBRE 1, jamais la CHAÎNE '1'. Un `=== '1'` le ratait donc à chaque tour et
     remettait ce choix explicite à 0 dès la moindre mise à jour partielle qui ne le touchait
     pas — silencieusement, sans message. */
  test('agent_read_unrestricted survit à une mise à jour partielle qui ne le touche pas', () => {
    config.updateConfig({ agent_read_unrestricted: '1' });
    assert.equal(config.getConfig().agent_read_unrestricted, 1);
    config.updateConfig({ gitlab_url: 'https://gl-autre.example.com/' });
    assert.equal(config.getConfig().agent_read_unrestricted, 1,
      'un réglage sans rapport ne doit pas effacer ce choix explicite');
  });
});
