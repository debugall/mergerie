'use strict';
/* DEUX POSTES, UN DÉPÔT GIT — la synchronisation, éprouvée pour de vrai.
 *
 * Le test fabrique un dépôt NU (le rôle de la forge) et DEUX dossiers de données, A et B, avec
 * chacun sa base. Ce n'est pas une simulation : ce sont de vraies commandes git, de vrais
 * commits, un vrai `pull --rebase`.
 *
 * CE QUE CHAQUE ÉPREUVE GARDE :
 *
 * — CE QUI EST ÉCRIT CHEZ A ARRIVE CHEZ B, et devient une LIGNE chez B — pas un fichier posé
 *   dans un coin.
 * — LES IDENTIFIANTS NE SE TÉLESCOPENT PAS. B numérote ses lignes comme il veut ; c'est l'uid
 *   qui fait l'identité, et une note de B ne doit jamais écraser une note de A.
 * — UN CONFLIT NE BLOQUE JAMAIS. Deux postes éditent la même note : le distant gagne, la version
 *   écrasée est GARDÉE, et un clic la reprend. Jamais de marqueur de conflit dans le dépôt.
 * — AUCUN SECRET NE PART. Un jeton saisi chez A ne doit se retrouver dans aucun commit du dépôt
 *   nu — c'est la seule épreuve dont l'échec serait irréversible : un secret commité dans git
 *   reste dans l'historique, dans chaque clone et sur la forge. Il faut révoquer.
 *
 * Deux bases dans un seul processus : impossible avec `require`, qui met `src/db` en cache. On
 * lance donc chaque poste dans un SOUS-PROCESSUS, qui fait son travail et rend du JSON.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const BALISE = '<<<MERGERIE-JSON>>>';

let racine; let nu; let posteA; let posteB;

/* Exécute du code DANS un poste : un processus à lui, avec son `MERGERIE_DATA_DIR`, donc sa
   base. Le code reçoit `{ db, store, datasync, notes, config, MSGS }` et rend ce qu'il veut. */
function dans(poste, corps) {
  const script = `
    const MSGS = { titreVide: 'v', inconnue: 'i', tropProfond: 'p', soiMeme: 's',
      prioriteInvalide: 'p', dateInvalide: 'd', lienInvalide: 'l', statutInvalide: 'st' };
    const db = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
    const store = require(${JSON.stringify(path.join(ROOT, 'src/store'))});
    const datasync = require(${JSON.stringify(path.join(ROOT, 'src/datasync'))});
    const notes = require(${JSON.stringify(path.join(ROOT, 'src/notes'))});
    const config = require(${JSON.stringify(path.join(ROOT, 'src/config'))});
    (async () => {
      const sortie = await (${corps})({ db, store, datasync, notes, config, MSGS });
      process.stdout.write(${JSON.stringify(BALISE)} + JSON.stringify(sortie === undefined ? null : sortie));
    })().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(1); });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MERGERIE_DATA_DIR: poste,
      GIT_AUTHOR_NAME: path.basename(poste),
      GIT_AUTHOR_EMAIL: `${path.basename(poste)}@example.com`,
      GIT_COMMITTER_NAME: path.basename(poste),
      GIT_COMMITTER_EMAIL: `${path.basename(poste)}@example.com`,
    },
  });
  const i = out.indexOf(BALISE);
  return i === -1 ? null : JSON.parse(out.slice(i + BALISE.length));
}

describe('datasync — deux postes, un dépôt de données', () => {
  before(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-datasync-'));
    nu = path.join(racine, 'mergerie-data.git');
    posteA = path.join(racine, 'A');
    posteB = path.join(racine, 'B');
    fs.mkdirSync(posteA); fs.mkdirSync(posteB);
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
    // Chaque poste pointe le même dépôt, puis s'y rattache. A initialise, B clone.
    for (const poste of [posteA, posteB]) {
      dans(poste, `async ({ config, datasync }) => {
        config.updateConfig({ data_repo_url: ${JSON.stringify(nu)}, data_repo_branch: 'main', data_sync_seconds: '10' });
        await datasync.rattacher({});
        return datasync.statut().configure;
      }`);
    }
  });

  after(() => { try { fs.rmSync(racine, { recursive: true, force: true }); } catch { /* best-effort */ } });

  test('une note écrite chez A devient une LIGNE chez B', () => {
    dans(posteA, `async ({ notes, datasync, MSGS }) => {
      notes.creerPage({ title: 'Déploiement prod', content: '# Prod\\n\\nTrois étapes.' }, MSGS);
      await datasync.commiter('note "Déploiement prod"');
      await datasync.tour();
    }`);
    const chezB = dans(posteB, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare('SELECT slug, title, content FROM note_page').all();
    }`);
    assert.deepEqual(chezB, [{ slug: 'deploiement-prod', title: 'Déploiement prod', content: '# Prod\n\nTrois étapes.' }]);
  });

  test('chaque poste garde SES identifiants entiers — c’est l’uid qui fait l’identité', () => {
    /* B crée d'abord une note à lui : sa note venue de A porte donc un `id` différent de celui
       qu'elle a chez A. Si l'identité passait par l'entier, l'une écraserait l'autre. */
    const chezB = dans(posteB, `async ({ notes, db, datasync, MSGS }) => {
      notes.creerPage({ title: 'Chez B', content: 'local' }, MSGS);
      await datasync.commiter('note "Chez B"');
      await datasync.tour();
      return db.prepare('SELECT id, slug, uid FROM note_page ORDER BY slug').all();
    }`);
    const chezA = dans(posteA, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare('SELECT id, slug, uid FROM note_page ORDER BY slug').all();
    }`);
    assert.equal(chezA.length, 2);
    assert.deepEqual(chezA.map((p) => p.slug), ['chez-b', 'deploiement-prod']);
    const parSlug = (l) => Object.fromEntries(l.map((p) => [p.slug, p.uid]));
    assert.deepEqual(parSlug(chezA), parSlug(chezB), 'les uid sont les mêmes des deux côtés');
  });

  test('une note SUPPRIMÉE chez A disparaît chez B', () => {
    dans(posteA, `async ({ notes, db, datasync, MSGS }) => {
      const p = db.prepare("SELECT id FROM note_page WHERE slug = 'deploiement-prod'").get();
      notes.supprimerPage(p.id, MSGS);
      await datasync.commiter('remove note "Déploiement prod"');
      await datasync.tour();
    }`);
    const restant = dans(posteB, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare('SELECT slug FROM note_page ORDER BY slug').all().map((r) => r.slug);
    }`);
    assert.deepEqual(restant, ['chez-b'], 'un fichier parti doit emporter sa ligne');
  });

  test('deux postes éditent la même note : le distant gagne, et la version écrasée est GARDÉE', () => {
    dans(posteA, `async ({ db, notes, datasync, MSGS }) => {
      const p = db.prepare("SELECT id FROM note_page WHERE slug = 'chez-b'").get();
      notes.majPage(p.id, { content: 'version de A' }, MSGS);
      await datasync.commiter('note "Chez B"');
      await datasync.tour();
    }`);
    const bilan = dans(posteB, `async ({ db, notes, store, datasync, MSGS }) => {
      const p = db.prepare("SELECT id FROM note_page WHERE slug = 'chez-b'").get();
      notes.majPage(p.id, { content: 'version de B' }, MSGS);
      await datasync.commiter('note "Chez B"');
      await datasync.tour();
      return {
        contenuFichier: store.lireFichier('notes/chez-b.md'),
        conflits: datasync.conflitsGardes().map((c) => ({ fichier: c.fichier, mienne: c.mienne })),
      };
    }`);
    assert.equal(bilan.contenuFichier, 'version de A', 'la version distante l’emporte');
    /* UN conflit, et non deux : la page produit deux fichiers (son corps et son `.json`
       jumeau), mais l'utilisateur a modifié UNE page. Lui en montrer deux lui demanderait de
       comprendre notre format de stockage pour répondre deux fois à la même question. */
    assert.equal(bilan.conflits.length, 1, 'la version écrasée doit être gardée, pas perdue');
    assert.equal(bilan.conflits[0].mienne, 'version de B');
    assert.doesNotMatch(bilan.contenuFichier, /<{7}/, 'jamais de marqueur de conflit dans le dépôt');
  });

  test('« reprendre la mienne » réécrit le fichier et repart chez tout le monde', () => {
    const apres = dans(posteB, `async ({ db, datasync }) => {
      const c = datasync.conflitsGardes()[0];
      datasync.reprendreVersion(c.fichier);
      await datasync.commiter('restore note "Chez B"');
      await datasync.tour();
      return { restants: datasync.conflitsGardes().length };
    }`);
    assert.equal(apres.restants, 0);
    const chezA = dans(posteA, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare("SELECT content FROM note_page WHERE slug = 'chez-b'").get().content;
    }`);
    assert.equal(chezA, 'version de B');
  });

  test('AUCUN SECRET dans le dépôt nu — ni dans sa dernière version, ni dans son historique', () => {
    dans(posteA, `async ({ config, datasync }) => {
      config.updateConfig({ access_token: 'glpat-NE-DOIT-JAMAIS-PARTIR', jira_token: 'jira-NE-DOIT-JAMAIS-PARTIR' });
      await datasync.commiter('settings');
      await datasync.tour();
    }`);
    /* Sur TOUT l'historique, pas seulement sur la dernière version : un secret commité puis
       retiré reste dans chaque clone et sur la forge — le retirer ne suffit pas, il faut
       révoquer. C'est pour ça que ce test cherche dans `rev-list --all`. */
    const commits = execFileSync('git', ['-C', nu, 'rev-list', '--all'], { encoding: 'utf8' })
      .split('\n').map((x) => x.trim()).filter(Boolean);
    assert.ok(commits.length > 0, 'le dépôt nu doit avoir reçu des commits');
    let trouve = '';
    try {
      trouve = execFileSync('git', ['-C', nu, 'grep', '-I', '-l', 'NE-DOIT-JAMAIS-PARTIR', ...commits],
        { encoding: 'utf8' });
    } catch { trouve = ''; }        // `git grep` sort en 1 quand il ne trouve rien : c'est le cas vert
    assert.equal(trouve.trim(), '', `un jeton est parti dans le dépôt de données : ${trouve}`);
  });
});
