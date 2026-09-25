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
function dans(poste, corps, avant = '') {
  const script = `
    ${avant}
    const MSGS = { titreVide: 'v', inconnue: 'i', tropProfond: 'p', soiMeme: 's',
      prioriteInvalide: 'p', dateInvalide: 'd', lienInvalide: 'l', statutInvalide: 'st' };
    const db = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
    const store = require(${JSON.stringify(path.join(ROOT, 'src/data/store'))});
    const datasync = require(${JSON.stringify(path.join(ROOT, 'src/data/datasync'))});
    const notes = require(${JSON.stringify(path.join(ROOT, 'src/notes/notes'))});
    const config = require(${JSON.stringify(path.join(ROOT, 'src/data/config'))});
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
      /* UNE NOTE NE PART QUE SI ON L'A DIT : c'est le seul objet de l'outil qu'on écrit sans
         destinataire, et la case est décochée par défaut. */
      const p = notes.creerPage({ title: 'Déploiement prod', content: '# Prod\\n\\nTrois étapes.' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      await datasync.commiter('note "Déploiement prod"');
      await datasync.tour();
    }`);
    const chezB = dans(posteB, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare('SELECT slug, title, content, shared FROM note_page').all();
    }`);
    /* `shared = 1` À L'ARRIVÉE : la page est dans le dépôt, donc elle est partagée. Arriver
       décochée la ferait retirer par le premier écoulement — B effacerait chez tout le monde la
       page que A vient de lui envoyer. */
    assert.deepEqual(chezB, [{ slug: 'deploiement-prod', title: 'Déploiement prod', content: '# Prod\n\nTrois étapes.', shared: 1 }]);
  });

  test('chaque poste garde SES identifiants entiers — c’est l’uid qui fait l’identité', () => {
    /* B crée d'abord une note à lui : sa note venue de A porte donc un `id` différent de celui
       qu'elle a chez A. Si l'identité passait par l'entier, l'une écraserait l'autre. */
    const chezB = dans(posteB, `async ({ notes, db, datasync, MSGS }) => {
      const p = notes.creerPage({ title: 'Chez B', content: 'local' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
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
      return {
        restants: datasync.conflitsGardes().length,
        ligne: db.prepare("SELECT content FROM note_page WHERE slug = 'chez-b'").get().content,
      };
    }`);
    assert.equal(apres.restants, 0);
    /* Reprendre la sienne repose le FICHIER ; si la LIGNE restait celle du voisin, l'écran
       montrerait le contraire du dépôt et le clic passerait pour perdu. */
    assert.equal(apres.ligne, 'version de B', 'le fichier repris doit redevenir la ligne');
    const chezA = dans(posteA, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare("SELECT content FROM note_page WHERE slug = 'chez-b'").get().content;
    }`);
    assert.equal(chezA, 'version de B');
  });

  test('un poste qui REJOINT emporte ce qu’il avait déjà — le dépôt ne s’ouvre pas sur du vide', () => {
    /* LE CAS ORDINAIRE DE LA BASCULE D'UNE ÉQUIPE. On crée le dépôt sur la forge — qui y met un
       commit initial, un README —, puis on clique « Cloner / rattacher » depuis le poste qui
       porte des mois de relectures. Si rejoindre se contentait d'hydrater, ces mois resteraient
       à quai : seul ce qui serait écrit APRÈS partirait, et l'équipe ouvrirait un dépôt vide.
       C'est exactement ce qui s'est produit avant ce test. */
    const posteC = path.join(racine, 'C');
    fs.mkdirSync(posteC);
    dans(posteC, `async ({ db, notes, MSGS }) => {
      const p = notes.creerPage({ title: 'Avant l’équipe', content: 'écrit en mono-poste' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      notes.creerPage({ title: 'Mon brouillon', content: 'pas pour les autres' }, MSGS);
      const r = db.prepare("INSERT INTO repo (forge, project, url, enabled) VALUES ('gitlab', 'eq/api', 'https://x/eq/api', 1)").run();
      db.prepare("INSERT INTO mr (repo_id, iid, status, ticket_text) VALUES (?, 41, 'reviewed', 'contexte saisi à la main')").run(r.lastInsertRowid);
    }`);

    /* Ce que le dépôt contenait AVANT que C ne le rejoigne : rejoindre doit AJOUTER, et ne
       jamais réécrire le fichier d'un collègue. */
    const avant = execFileSync('git', ['-C', nu, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();

    const mode = dans(posteC, `async ({ config, datasync }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nu)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      const r = await datasync.rattacher({});
      await datasync.tour();
      return r.mode;
    }`);
    assert.equal(mode, 'clone', 'un dépôt déjà pourvu se rejoint, il ne s’initialise pas');

    const listing = execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(listing, /notes\/avant-l-equipe\.md/, 'la note d’avant doit monter avec');
    /* LE DÉPÔT SUIVI, LUI, RESTE LOCAL : chacun ajoute les siens, et rejoindre une équipe ne les
       lui impose ni ne les lui emporte. */
    assert.doesNotMatch(listing, /repos\/gitlab\/eq\/api\.json/,
      'la liste des dépôts suivis n’a rien à faire dans le dépôt d’équipe');
    assert.match(listing, /mrs\/gitlab\/eq\/api\/41\.json/,
      'et la MR relue — la question posée — voyage quand même, désignée par sa clé naturelle');
    assert.doesNotMatch(listing, /mon-brouillon/,
      'rejoindre n’emporte PAS les notes qu’on n’a pas cochées : ce serait publier un brouillon');

    const touches = execFileSync('git', ['-C', nu, 'diff', '--name-status', avant, 'main'], { encoding: 'utf8' })
      .split('\n').map((x) => x.trim()).filter(Boolean).filter((l) => !l.startsWith('A'));
    assert.deepEqual(touches, [],
      `rejoindre AJOUTE : les fichiers des collègues ne doivent pas être réécrits — ${touches.join(', ')}`);
  });

  test('décocher « partager » retire la page de l’équipe SANS la perdre chez soi', () => {
    /* LE PIÈGE. Décocher retire le fichier du dépôt ; ce commit-là revient ensuite par
       l'hydratation, et « un fichier parti emporte sa ligne » effacerait la page de la base de
       celui-là même qui vient de la décocher. On ne retire donc une ligne que si elle se
       partage : une absence qu'on a voulue n'est pas une suppression. */
    dans(posteA, `async ({ notes, datasync, MSGS }) => {
      const p = notes.creerPage({ title: 'Rétro du sprint', content: 'ce qu’on garde' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      await datasync.commiter('note "Rétro du sprint"');
      await datasync.tour();
      notes.majPage(p.id, { shared: 0 }, MSGS);
      await datasync.commiter('unshare note "Rétro du sprint"');
      await datasync.tour();
    }`);
    const listing = execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.doesNotMatch(listing, /retro-du-sprint/, 'elle a bien quitté le dépôt d’équipe');

    /* B pousse autre chose : c'est ce qui oblige A à tirer, donc à réhydrater un intervalle qui
       CONTIENT SON PROPRE retrait — le moment exact où la page risquait de disparaître de la
       base de celle qui venait de la décocher. */
    const chezB = dans(posteB, `async ({ db, notes, datasync, MSGS }) => {
      await datasync.tour();
      const p = notes.creerPage({ title: 'Ordre du jour', content: 'chez B' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      await datasync.commiter('note "Ordre du jour"');
      await datasync.tour();
      return db.prepare("SELECT COUNT(*) n FROM note_page WHERE slug = 'retro-du-sprint'").get().n;
    }`);
    assert.equal(chezB, 0, 'chez le voisin, qui ne l’a pas décochée, elle disparaît : elle n’était pas à lui');

    const garde = dans(posteA, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare("SELECT content, shared FROM note_page WHERE slug = 'retro-du-sprint'").get() || null;
    }`);
    assert.ok(garde, 'la page décochée ne doit pas disparaître de la base de celle qui l’a écrite');
    assert.equal(garde.shared, 0);
    assert.equal(garde.content, 'ce qu’on garde', 'elle reste chez soi, entière');
  });

  test('les pages écrites AVANT la case sortent du dépôt au démarrage suivant', () => {
    /* LE PASSAGE. Avant la case, toutes les pages partaient ; la colonne arrive à 0, donc elles
       deviennent privées — mais leurs FICHIERS, eux, sont déjà dans le dépôt, et le prochain
       `git add -A` les emporterait. Le démarrage qui suit la migration doit donc les retirer.
       On reconstitue l'état exact : le fichier présent, la ligne non partagée, la file vide. */
    const posteD = path.join(racine, 'D');
    fs.mkdirSync(posteD);
    const avant = dans(posteD, `async ({ db, notes, store, MSGS }) => {
      const p = notes.creerPage({ title: 'Avant la case', content: 'tout partait' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      notes.majPage(p.id, { shared: 0 }, MSGS);
      store.ecouler();
      // le fichier d'avant, tel que l'ancienne version l'avait laissé dans le dépôt
      store.ecrireFichier('notes/avant-la-case.md', 'tout partait');
      db.prepare("DELETE FROM local_state WHERE key = 'unshared_swept'").run();
      db.prepare('DELETE FROM store_sale').run();
      return store.existe('notes/avant-la-case.md');
    }`);
    assert.equal(avant, true, 'on part bien d’un fichier présent dans le dépôt');

    const apres = dans(posteD, `async ({ store }) => {
      store.ecouler();                       // ce que le serveur fait au démarrage
      return store.existe('notes/avant-la-case.md');
    }`);
    assert.equal(apres, false,
      'une page d’avant laissée dans le dépôt repartirait au prochain « git add -A »');
  });

  test('la merge request reviewée par un collègue passe « reviewée » chez moi', () => {
    /* LA QUESTION DE TOUS LES JOURS. Chacun découvre les mêmes merge requests chez la forge, et
       chacun leur donne un uid à soi : ce n'est donc PAS l'uid qui les rapproche, mais (dépôt,
       numéro). Sans ce rapprochement, la base refusait la ligne du collègue — « UNIQUE
       constraint failed: mr.repo_id, mr.iid » — et sa relecture n'arrivait jamais. */
    const decouvrir = `(db) => {
      const r = db.prepare("SELECT id FROM repo WHERE project = 'eq/front'").get()
        || { id: db.prepare("INSERT INTO repo (forge, project, url, enabled) VALUES ('gitlab','eq/front','https://x/eq/front',1)").run().lastInsertRowid };
      const e = db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = 77').get(r.id);
      if (e) return e.id;
      return db.prepare("INSERT INTO mr (repo_id, iid, title, status, updated_at) VALUES (?, 77, 'Le panier', 'to_review', ?)")
        .run(r.id, new Date().toISOString()).lastInsertRowid;
    }`;
    // Les deux postes la découvrent chacun de leur côté : deux uid pour une seule merge request.
    const uidA = dans(posteA, `async ({ db, datasync }) => {
      const id = (${decouvrir})(db);
      await datasync.commiter('repo + mr'); await datasync.tour();
      return db.prepare('SELECT uid FROM mr WHERE id = ?').get(id).uid;
    }`);
    /* B LA DÉCOUVRE DE SON CÔTÉ, AVANT d'avoir reçu quoi que ce soit : c'est là que naissent les
       deux identités, et c'est le cas ordinaire — chacun découvre la même file de merge
       requests chez la forge. */
    const uidB = dans(posteB, `async ({ db, datasync }) => {
      const r = db.prepare("INSERT INTO repo (forge, project, url, enabled) VALUES ('gitlab','eq/front','https://x/eq/front',1)").run().lastInsertRowid;
      const id = db.prepare("INSERT INTO mr (repo_id, iid, title, status, updated_at) VALUES (?, 77, 'Le panier', 'to_review', ?)")
        .run(r, new Date().toISOString()).lastInsertRowid;
      await datasync.commiter('repo + mr (chez B)');
      return db.prepare('SELECT uid FROM mr WHERE id = ?').get(id).uid;
    }`);
    assert.ok(uidA && uidB, 'les deux postes connaissent la merge request');
    assert.notEqual(uidA, uidB, 'deux découvertes, deux uid — c’est tout le problème');

    // A la reviewe : le statut part dans le dépôt.
    dans(posteA, `async ({ db, datasync }) => {
      const m = db.prepare("SELECT id FROM mr WHERE iid = 77").get();
      db.prepare("UPDATE mr SET status = 'reviewed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), m.id);
      await datasync.commiter('mr reviewed'); await datasync.tour();
    }`);

    const chezB = dans(posteB, `async ({ db, datasync }) => {
      await datasync.tour();
      const l = db.prepare("SELECT status FROM mr WHERE iid = 77").all();
      return { lignes: l.length, status: l[0] && l[0].status };
    }`);
    assert.equal(chezB.lignes, 1, 'une merge request, une ligne — pas deux identités pour un objet');
    assert.equal(chezB.status, 'reviewed',
      'ce que le collègue a relu doit se voir ici : c’est tout l’intérêt du partage');
  });

  test('une règle qui se déclenche sur un CHEMIN, sans branche, arrive chez le collègue', () => {
    /* La règle la plus courante d'une équipe — « sur le dossier migrations, vérifie la réversibilité » —
       n'a pas de branche : l'application écrit '' dans `branch_match`, colonne NOT NULL. L'export
       omet un champ vide, et l'hydratation rendait `null` : « NOT NULL constraint failed », la
       règle restait orpheline, et l'équipe ne recevait jamais ce qui gagne le plus à être commun. */
    dans(posteA, `async ({ db, store, datasync }) => {
      store.ecrire('review_rule', () => db.prepare(
        "INSERT INTO review_rule (branch_match, path_match, label, content, enabled, created_at) VALUES ('', '**/migrations/**', 'migrations', 'Vérifier la réversibilité.', 1, ?)",
      ).run(new Date().toISOString()).lastInsertRowid);
      await datasync.commiter('rule migrations'); await datasync.tour();
    }`);
    const chezB = dans(posteB, `async ({ db, datasync }) => {
      const bilan = await datasync.tour();
      return { orphelins: (bilan.hydrate && bilan.hydrate.orphelins) || [],
        regles: db.prepare("SELECT label, branch_match, path_match FROM review_rule WHERE label = 'migrations'").all() };
    }`);
    assert.deepEqual(chezB.orphelins, [], 'aucun fichier laissé de côté');
    assert.deepEqual(chezB.regles, [{ label: 'migrations', branch_match: '', path_match: '**/migrations/**' }]);
  });

  test('Docker, Jenkins, Git et Jira redevenus locaux SORTENT du dépôt', () => {
    /* Ces quatre onglets décrivent une machine, ses accès et sa façon de travailler, pas un
       travail accumulé. Leurs
       fichiers étaient déjà partis chez les équipes qui ont synchronisé avant : rien ne les en
       aurait retirés — le balayage ne connaît que les tables qui écrivent encore — et la
       prochaine hydratation d'un collègue les aurait reposés chez lui. */
    const posteE = path.join(racine, 'E');
    fs.mkdirSync(posteE);
    // On reconstitue l'ancien dépôt : des fichiers de ces trois onglets, et un dépôt suivi.
    const avant = dans(posteE, `async ({ db, store, datasync, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nu)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      store.ecrireFichier('git-commands/01M2GAAAAAAAAAAAAAAAAAAAAA.json', store.serialize({ uid: '01M2GAAAAAAAAAAAAAAAAAAAAA', label: 'Statut', command: 'status' }));
      store.ecrireFichier('git-ops/01M2GBBBBBBBBBBBBBBBBBBBBB.json', store.serialize({ uid: '01M2GBBBBBBBBBBBBBBBBBBBBB', action: 'delete_branch', status: 'done' }));
      store.ecrireFichier('docker-backups/01M2GCCCCCCCCCCCCCCCCCCCCC.json', store.serialize({ uid: '01M2GCCCCCCCCCCCCCCCCCCCCC', name: 'api' }));
      store.ecrireFichier('jira/PROJ-1408.json', store.serialize({ key: 'PROJ-1408', summary: 'Le panier' }));
      db.prepare("DELETE FROM local_state WHERE key = 'menus_locaux'").run();
      return store.listerFichiers('git-commands').length + store.listerFichiers('git-ops').length
        + store.listerFichiers('docker-backups').length + store.listerFichiers('jira').length;
    }`);
    assert.equal(avant, 4, 'on part bien d’un dépôt qui les porte');

    // Le démarrage suivant les retire — une seule fois, et sans rien demander.
    const apres = dans(posteE, `async ({ store }) => ({
      restants: store.listerFichiers('git-commands').length + store.listerFichiers('git-ops').length
        + store.listerFichiers('docker-backups').length + store.listerFichiers('jira').length,
    })`);
    assert.equal(apres.restants, 0, 'ce qui ne se partage plus doit sortir du dépôt');

    // …et une commande git écrite ensuite ne produit plus aucun fichier.
    const ecrit = dans(posteE, `async ({ db, store }) => {
      db.prepare("INSERT INTO git_command (label, command, sort_order, created_at) VALUES ('Log', 'log --oneline', 1, ?)").run(new Date().toISOString());
      store.ecouler();
      return store.listerFichiers('git-commands').length;
    }`);
    assert.equal(ecrit, 0, 'la palette de commandes reste à soi');
  });

  test('la liste des dépôts suivis, redevenue locale, SORT du dépôt sur le même calendrier', () => {
    /* MÊME BASCULE, PLUS TARD : `repo` a rejoint Docker, Jenkins, Git et Jira, sur un second
       passage plutôt qu'une entrée de plus dans celui du dessus — un poste déjà à jour du
       premier ne doit pas sauter le second. */
    const posteG = path.join(racine, 'G');
    fs.mkdirSync(posteG);
    const avant = dans(posteG, `async ({ db, store, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nu)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      store.ecrireFichier('repos/gitlab/acme/web.json', store.serialize({
        uid: '01M2GDDDDDDDDDDDDDDDDDDDD', forge: 'gitlab', project: 'acme/web', url: 'https://x/acme/web.git',
      }));
      db.prepare("DELETE FROM local_state WHERE key = 'repos_locaux'").run();
      return store.listerFichiers('repos').length;
    }`);
    assert.equal(avant, 1, 'on part bien d’un dépôt d’équipe qui porte encore un dépôt suivi');

    const apres = dans(posteG, `async ({ store }) => store.listerFichiers('repos').length`);
    assert.equal(apres, 0, 'la liste des dépôts suivis doit sortir du dépôt d’équipe');

    // …et un dépôt ajouté ensuite ne produit plus aucun fichier.
    const ecrit = dans(posteG, `async ({ db, store }) => {
      db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'acme/api', 'https://x/acme/api.git', 1, ?)")
        .run(new Date().toISOString());
      store.ecouler();
      return store.listerFichiers('repos').length;
    }`);
    assert.equal(ecrit, 0, 'chacun ajoute les dépôts qu’il veut suivre, sans en avertir l’équipe');
  });

  test('UN DÉPÔT VIDÉ NE VIDE PAS LA BASE — le garde-fou', () => {
    /* CE QUI EST ARRIVÉ POUR DE VRAI. On remet le dépôt d'équipe à zéro (`push --force` d'une
       branche orpheline, ou un projet recréé sur la forge) pendant qu'une instance synchronise
       toutes les trente secondes. Elle tire, voit que TOUS les fichiers ont disparu, applique
       « un fichier parti emporte sa ligne » — et la base se vide : dépôts, merge requests,
       reviews, sessions, agents, vérificateurs, et la cascade SQL pour le reste.
       La règle est juste pour UN document supprimé. Pour un dépôt vidé, c'est un accident : on
       refuse, on garde tout, et on le dit. */
    const posteF = path.join(racine, 'F');
    fs.mkdirSync(posteF);
    const nuF = path.join(racine, 'equipe-f.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuF], { stdio: 'ignore' });

    // Un poste avec de quoi perdre : douze notes partagées, poussées dans le dépôt.
    const avant = dans(posteF, `async ({ db, notes, datasync, config, MSGS }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuF)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      for (let i = 0; i < 12; i++) {
        const p = notes.creerPage({ title: 'Page ' + i, content: 'du contenu' }, MSGS);
        notes.majPage(p.id, { shared: 1 }, MSGS);
      }
      await datasync.rattacher({});
      await datasync.tour();
      return db.prepare('SELECT COUNT(*) n FROM note_page').get().n;
    }`);
    assert.equal(avant, 12);

    // Le dépôt est remis à zéro : une branche orpheline, vide, poussée en force.
    const vide = path.join(racine, 'vide');
    execFileSync('git', ['clone', nuF, vide], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'checkout', '--orphan', 'neuve'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'rm', '-rf', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, '-c', 'user.name=T', '-c', 'user.email=t@x',
      'commit', '--allow-empty', '-m', 'reset'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'push', '-f', 'origin', 'neuve:main'], { stdio: 'ignore' });

    const apres = dans(posteF, `async ({ db, datasync }) => {
      const bilan = await datasync.tour();
      return {
        pages: db.prepare('SELECT COUNT(*) n FROM note_page').get().n,
        refuses: (bilan && bilan.hydrate && bilan.hydrate.refuses) || 0,
        erreur: datasync.statut().erreur,
      };
    }`);
    assert.equal(apres.pages, 12, 'le travail de quelqu’un ne se supprime pas parce qu’un fichier manque');
    assert.ok(apres.refuses >= 10, 'le refus doit être compté');
    assert.match(String(apres.erreur || ''), /vidé/, 'et DIT : l’écran ne doit pas afficher « à jour »');
  });

  test('« Tout ré-envoyer » n’écrase pas ce qu’un collègue a partagé', () => {
    /* La question qu'on se pose devant ce bouton. La réponse tient à l'ordre des gestes : le
       rattachement LIT d'abord ce que le dépôt porte et l'ajoute ici, et l'export n'ÉCRIT que
       des fichiers — il n'en supprime jamais. Le travail d'un collègue survit donc, même s'il
       porte sur des objets que ce poste ne connaissait pas. */
    const uidA = dans(posteA, `async ({ notes, datasync, MSGS }) => {
      const p = notes.creerPage({ title: 'Écrit par A', content: 'ce que A a rédigé' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      await datasync.commiter('note "Écrit par A"');
      await datasync.tour();
      return p.id;
    }`);
    assert.ok(uidA);

    /* B ne l'a jamais vue : il ne synchronise pas avant de tout ré-envoyer, ce qui est le pire
       cas — sa base ignore la page de A. */
    const chezB = dans(posteB, `async ({ db, notes, store, datasync, MSGS }) => {
      const p = notes.creerPage({ title: 'Écrit par B', content: 'ce que B a rédigé' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      /* Le geste du bouton : rattacher (qui lit le dépôt, puis réécrit tout), puis un tour. */
      await datasync.rattacher({});
      await datasync.tour();
      return {
        pages: db.prepare('SELECT title FROM note_page ORDER BY title').all().map((x) => x.title),
        fichiers: store.listerFichiers('notes').filter((f) => f.endsWith('.md')).sort(),
      };
    }`);
    assert.ok(chezB.pages.includes('Écrit par A'), 'le rattachement LIT le dépôt avant d’écrire');
    assert.ok(chezB.pages.includes('Écrit par B'));

    const listing = execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(listing, /notes\/ecrit-par-a\.md/, 'la page de A est toujours dans le dépôt');
    assert.match(listing, /notes\/ecrit-par-b\.md/, '…et celle de B est arrivée');
    const chezA = dans(posteA, `async ({ db, datasync }) => {
      await datasync.tour();
      return db.prepare("SELECT content FROM note_page WHERE slug = 'ecrit-par-a'").get().content;
    }`);
    assert.equal(chezA, 'ce que A a rédigé', 'et son contenu n’a pas été réécrit par celui de B');
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

  /* DEUX GESTES EN MÊME TEMPS NE SE DISPUTENT PAS `index.lock`.
     Le tour périodique, le commit groupé et le rattachement écrivent dans le même dépôt sans se
     connaître. Deux d'entre eux à la fois, et git rend « Unable to create index.lock: File
     exists » — c'est le geste de l'utilisateur qui échoue parce qu'une minuterie avait pris le
     verrou. On ne compte donc pas les erreurs (elles dépendent du moment), on compte les
     PROCESSUS git vivants en même temps : la propriété est « jamais deux », et elle se vérifie
     sans rien parier sur la vitesse de la machine. */
  test('deux gestes en même temps ne lancent jamais deux git à la fois', () => {
    /* `execFile` est déstructuré au chargement de datasync : on l'enveloppe AVANT les `require`,
       d'où le prologue. Le compteur monte à l'appel, redescend au rappel. */
    const espion = `
      const cp = require('node:child_process');
      const vraiExecFile = cp.execFile;
      global.__gitMax = 0;
      let vivants = 0;
      cp.execFile = function (...args) {
        const i = args.length - 1;
        const rappel = args[i];
        if (typeof rappel !== 'function') return vraiExecFile.apply(this, args);
        vivants += 1;
        if (vivants > global.__gitMax) global.__gitMax = vivants;
        args[i] = function (...r) { vivants -= 1; return rappel.apply(this, r); };
        return vraiExecFile.apply(this, args);
      };
    `;
    const max = dans(posteA, `async ({ datasync, notes, MSGS }) => {
      notes.creerPage({ title: 'Deux gestes', content: 'x' }, MSGS);
      /* Lancés dans le MÊME tour de boucle : sans file, les deux premiers git partent ensemble. */
      await Promise.all([
        datasync.commiter('un geste').catch(() => null),
        datasync.rattacher({}).catch(() => null),
      ]);
      return global.__gitMax;
    }`, espion);
    assert.ok(max >= 1, 'le test doit avoir vu passer des commandes git');
    assert.equal(max, 1, `deux git en même temps dans le même dépôt : c'est ça, index.lock (${max})`);
  });

  /* UN TOUR ENVOIE CE QU'UN TRAITEMENT DE FOND A ÉCRIT.
     La file d'écritures est écoulée par le serveur à la fin de chaque requête non-GET. Tout ce
     qui s'écrit HORS d'une requête — une découverte de MR, une review qui se termine, une
     session qui commite — ne passe par personne : le travail restait dans la file, aucun commit
     n'était armé, et le tour ne trouvait rien à pousser. Vu de l'utilisateur : « ça ne part que
     quand je clique », puisque le bouton, lui, commite d'abord. On reproduit exactement ça — on
     écrit SANS écouler la file — et on regarde le dépôt nu. */
  test('un tour envoie ce qu’un traitement de fond a écrit, sans attendre une requête', () => {
    const retard = dans(posteA, `async ({ db, store, notes, datasync, MSGS }) => {
      const p = notes.creerPage({ title: 'Ecrit par un job de fond', content: 'du fond' }, MSGS);
      db.prepare('UPDATE note_page SET shared = 1 WHERE id = ?').run(p.id);
      const enFile = store.enRetard();
      await datasync.tour();
      return enFile;
    }`);
    assert.ok(retard > 0, 'le décor doit bien être « des écritures en attente, personne pour les écouler »');
    const listing = execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(listing, /notes\/ecrit-par-un-job-de-fond\.md/,
      'la synchro automatique doit envoyer sans qu’on ait à cliquer');
  });

  /* DEUX DÉCOUVERTES SANS CHANGEMENT NE PRODUISENT AUCUN COMMIT.
     La découverte réécrit chaque merge request ouverte à chaque passage — mêmes valeurs,
     horodatage neuf. Tant que `updated_at` partait dans le fichier, cela faisait un commit par
     MR et par tour sur CHAQUE poste, et un conflit de rebase sur chaque fichier dès que deux
     postes découvraient entre deux synchros : des conflits sur des documents que personne
     n'avait touchés. On rejoue ici ce que fait `updateMr` — toutes les colonnes réécrites à
     l'identique, `updated_at` en plus — et on compte les commits du dépôt nu. */
  test('une découverte qui ne change rien ne produit aucun commit', () => {
    const compter = () => execFileSync('git', ['-C', nu, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim();
    dans(posteA, `async ({ db, store, datasync }) => {
      const repoId = (db.prepare("SELECT id FROM repo LIMIT 1").get()
        || { id: db.prepare("INSERT INTO repo (forge, project, url, enabled) VALUES ('gitlab','eq/temoin','https://x/eq/temoin',1)").run().lastInsertRowid }).id;
      store.ecrire('mr', () => db.prepare(
        "INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, status, updated_at) VALUES (?, 4321, 'Rien ne bouge', 'feat/rien', 'main', 'to_review', ?)",
      ).run(repoId, new Date().toISOString()).lastInsertRowid);
      await datasync.commiter('mr témoin'); await datasync.tour();
    }`);
    const avant = compter();

    dans(posteA, `async ({ db, store, datasync }) => {
      const id = db.prepare('SELECT id FROM mr WHERE iid = 4321').get().id;
      // Exactement ce que fait la découverte sur une MR inchangée : tout réécrit, l'heure en plus.
      store.ecrire('mr', () => db.prepare(
        "UPDATE mr SET title = 'Rien ne bouge', source_branch = 'feat/rien', target_branch = 'main', closed_seen = 0, updated_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), id) && id);
      await datasync.commiter('découverte'); await datasync.tour();
    }`);
    assert.equal(compter(), avant,
      'une découverte sans changement ne doit RIEN commiter : sinon chaque tour pousse un commit par MR, et deux postes se retrouvent en conflit sur des fichiers que personne n’a touchés');
  });

  /* DEUX COMMITS LOCAUX EN CONFLIT : LE REBASE DOIT CONVERGER.
     Deux sauvegardes de la même note avant une synchro font deux commits locaux. Le rebase n'en
     résolvait qu'un : le second faisait échouer `--continue`, on abandonnait le rebase, et le
     tour suivant rejouait la même scène — le poste restait « en avance » pour toujours, sans un
     mot à l'écran. On monte exactement ce décor et on regarde si B finit par retomber à zéro. */
  test('deux commits locaux en conflit finissent par passer, sans rester bloqués', () => {
    dans(posteA, `async ({ db, store, notes, datasync, MSGS }) => {
      const p = notes.creerPage({ title: 'Duel', content: 'version de départ' }, MSGS);
      db.prepare('UPDATE note_page SET shared = 1 WHERE id = ?').run(p.id);
      await datasync.commiter('note duel'); await datasync.tour();
    }`);
    dans(posteB, `async ({ datasync }) => { await datasync.tour(); }`);

    // A change la note et pousse.
    dans(posteA, `async ({ db, store, datasync }) => {
      const p = db.prepare("SELECT * FROM note_page WHERE slug = 'duel'").get();
      store.ecrire('note_page', () => db.prepare('UPDATE note_page SET content = ?, updated_at = ? WHERE id = ?')
        .run('écrit par A', new Date().toISOString(), p.id) && p.id);
      await datasync.commiter('A écrit'); await datasync.tour();
    }`);

    /* B écrit DEUX FOIS sans synchroniser : deux commits locaux, tous deux sur le même fichier
       que A vient de changer. C'est le cas ordinaire — on enregistre, on se reprend. */
    const etat = dans(posteB, `async ({ db, store, datasync }) => {
      const p = db.prepare("SELECT * FROM note_page WHERE slug = 'duel'").get();
      for (const texte of ['premier jet de B', 'second jet de B']) {
        store.ecrire('note_page', () => db.prepare('UPDATE note_page SET content = ?, updated_at = ? WHERE id = ?')
          .run(texte, new Date().toISOString(), p.id) && p.id);
        await datasync.commiter('B écrit');
      }
      await datasync.tour();
      await datasync.tour();          // un second tour : un poste bloqué le reste au suivant
      const s = datasync.statut();
      return { enAvance: s.enAvance, enRetard: s.enRetard, erreur: s.erreur };
    }`);
    assert.equal(etat.enAvance, 0, `B reste bloqué avec des commits qui ne partent pas : ${JSON.stringify(etat)}`);
    assert.equal(etat.enRetard, 0, 'et il a bien reçu ce que A avait poussé');
  });

  /* « SUPPRIME `reviewer.db` ET TOUT REVIENT DES FICHIERS » — y compris sans rien cliquer.
     Une base neuve devant un clone déjà à jour est à ↑0 ↓0 : le tour sortait avant la branche
     qui hydrate, et la base restait vide tant qu'on n'avait pas cliqué « Cloner / rattacher ».
     On reproduit l'état exact — les lignes effacées, le repère d'hydratation retiré, le clone
     intact — et on demande un simple tour. */
  test('une base vide devant un clone à jour se réhydrate toute seule', () => {
    const revenu = dans(posteB, `async ({ db, datasync }) => {
      await datasync.tour();                                  // B est à jour
      await datasync.tour();
      const s0 = datasync.statut();                           // …et vraiment à ↑0 ↓0
      const avant = db.prepare('SELECT COUNT(*) n FROM note_page').get().n;
      // La base repart de zéro : les lignes partent, le repère aussi, le clone reste.
      db.exec('DELETE FROM note_page');
      db.exec("DELETE FROM local_state WHERE kind = 'data' AND ref = 'repo' AND key = 'hydrated_at'");
      db.exec('DELETE FROM store_sale'); db.exec('DELETE FROM store_menage');
      await datasync.tour();
      return { avant, s0: { enAvance: s0.enAvance, enRetard: s0.enRetard },
        apres: db.prepare('SELECT COUNT(*) n FROM note_page').get().n };
    }`);
    assert.ok(revenu.avant > 0, 'le décor doit contenir des pages avant l’effacement');
    assert.deepEqual(revenu.s0, { enAvance: 0, enRetard: 0 },
      'le décor DOIT être « rien à échanger » : c’est le cas où le tour sortait trop tôt');
    assert.equal(revenu.apres, revenu.avant,
      'un tour doit suffire à retrouver ce que le dépôt contient : c’est la promesse « supprime la base, tout revient »');
  });

  /* UNE ADRESSE N'EST PAS UNE OPTION. L'URL du dépôt part telle quelle dans l'argv de `git`, et
     elle ne vient pas que des réglages : l'aperçu la prend dans la query string d'un GET, donc
     n'importe quelle page ouverte dans le navigateur peut l'appeler. Une valeur qui commence par
     un tiret est refusée AVANT git — un `--` oublié à un seul appel serait invisible. */
  /* L'ADRESSE WEB D'UN FICHIER DU DÉPÔT — c'est elle qu'on publie sur une merge request quand
     on donne le lien du rapport plutôt que le rapport. Trois choses s'y jouent :
       — l'URL de CLONE devient une URL de NAVIGATION, quelle que soit sa forme (SSH, ssh://,
         HTTPS) : c'est un lien qu'un humain va cliquer ;
       — GitLab range ses fichiers sous `/-/blob/`, GitHub sous `/blob/` ;
       — et surtout AUCUN SECRET N'EN SORT. Une URL de clone peut porter un jeton
         (`https://oauth2:glpat-…@…`) ; publié en commentaire, il serait lu par toute l'équipe,
         archivé par la forge, et il n'y aurait plus qu'à le révoquer. */
  test('le lien web d’un fichier du dépôt : SSH ou HTTPS, la bonne forge, et jamais le jeton', () => {
    const r = dans(posteA, `async ({ config, datasync }) => {
      const cas = {};
      const essai = (nom, url, extra = {}) => {
        config.updateConfig({ data_repo_url: url, data_repo_branch: 'main', ...extra });
        cas[nom] = datasync.lienFichier('reviews/gitlab/grp/app/42/01JZERO.md');
      };
      essai('ssh', 'git@gitlab.com:equipe/mergerie-data.git');
      essai('https', 'https://gitlab.com/equipe/mergerie-data.git');
      essai('jeton', 'https://oauth2:glpat-NE-DOIT-JAMAIS-PARTIR@gitlab.com/equipe/mergerie-data.git');
      essai('ssh_port', 'ssh://git@gitlab.interne:2222/equipe/data.git');
      essai('github', 'https://github.com/equipe/mergerie-data.git');
      config.updateConfig({ data_repo_url: 'git@gitlab.com:equipe/data.git', data_repo_branch: 'equipe' });
      cas.branche = datasync.lienFichier('reviews/gitlab/grp/app/42/01JZERO.md');
      config.updateConfig({ data_repo_url: '' });
      cas.sansDepot = datasync.lienFichier('reviews/gitlab/grp/app/42/01JZERO.md');
      return cas;
    }`);

    const FICHIER = 'reviews/gitlab/grp/app/42/01JZERO.md';
    assert.equal(r.ssh, `https://gitlab.com/equipe/mergerie-data/-/blob/main/${FICHIER}`,
      'une URL SSH devient une adresse qu’on clique');
    assert.equal(r.https, `https://gitlab.com/equipe/mergerie-data/-/blob/main/${FICHIER}`,
      'et l’URL HTTPS donne exactement la même');
    assert.equal(r.jeton, `https://gitlab.com/equipe/mergerie-data/-/blob/main/${FICHIER}`,
      'le jeton de l’URL de clone ne passe pas dans le lien');
    assert.ok(!/glpat|oauth2/.test(r.jeton), `aucun secret dans le lien publié : ${r.jeton}`);
    assert.equal(r.ssh_port, `https://gitlab.interne/equipe/data/-/blob/main/${FICHIER}`,
      'le port SSH n’est pas celui du web : il ne suit pas');
    assert.equal(r.github, `https://github.com/equipe/mergerie-data/blob/main/${FICHIER}`,
      'GitHub range ses fichiers sous /blob/, sans le tiret de GitLab');
    assert.equal(r.branche, `https://gitlab.com/equipe/data/-/blob/equipe/${FICHIER}`,
      'et c’est la branche du dépôt de données, pas « main » d’office');
    assert.equal(r.sansDepot, null, 'sans dépôt de données, il n’y a pas d’adresse — et pas de bouton');
  });

  /* CE QUE LE CODE SAIT LIRE CHANGE — et les fichiers déjà lus, non.
   *
   * L'hydratation est incrémentale : elle applique ce qui a changé depuis le dernier repère. Un
   * champ compris par une NOUVELLE version ne sera donc jamais lu dans un fichier que l'ANCIENNE
   * a déjà hydraté : le fichier n'a plus à changer, la base garde sa valeur, et redémarrer n'y
   * change rien — le repère est passé devant. C'est exactement ce qui est arrivé à « publier le
   * lien plutôt que le rapport », resté décoché sur un poste dont le `settings.json` le portait
   * pourtant à « 1 ».
   *
   * Le test décrit le MÉCANISME, pas un champ : un objet d'équipe reçu, puis une divergence entre
   * le fichier et la base que personne ne réexporte, puis un tour ordinaire qui ne la voit pas, et
   * enfin la signature de format qui change — le fichier redevient la référence.
   *
   * DEUX POSTES À LUI : les épreuves précédentes vident le dépôt et le ré-envoient, et un test de
   * rattrapage doit partir d'un décor dont il répond. */
  test('ce que l’ancienne version avait mal lu est rattrapé quand le format change', () => {
    const nu2 = path.join(racine, 'format.git');
    const posteFormatBormatA = path.join(racine, 'format-A');
    const posteFormatB = path.join(racine, 'format-B');
    fs.mkdirSync(posteFormatBormatA); fs.mkdirSync(posteFormatB);
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu2], { stdio: 'ignore' });
    for (const poste of [posteFormatBormatA, posteFormatB]) {
      dans(poste, `async ({ config, datasync }) => {
        config.updateConfig({ data_repo_url: ${JSON.stringify(nu2)}, data_repo_branch: 'main', data_sync_seconds: '10' });
        await datasync.rattacher({});
      }`);
    }

    dans(posteFormatBormatA, `async ({ notes, datasync, MSGS }) => {
      const p = notes.creerPage({ title: 'Format', content: '# La version de l’équipe' }, MSGS);
      notes.majPage(p.id, { shared: 1 }, MSGS);
      await datasync.commiter('note "Format"');
      await datasync.tour();
    }`);

    const r = dans(posteFormatB, `async ({ db, datasync }) => {
      await datasync.tour();                            // le second poste reçoit le fichier…
      datasync.rattraperFormat();                       // …et note ce que CE code comprend
      const lire = () => (db.prepare("SELECT content FROM note_page WHERE slug = 'format'").get() || {}).content;
      const recu = lire();

      /* L'ANCIENNE VERSION : elle a lu le fichier et n'en a pas tout compris, donc la base et le
         fichier divergent — et rien n'est réexporté, puisque ce qu'elle a manqué n'existait pas
         pour elle. */
      db.prepare("UPDATE note_page SET content = '# Ce que l’ancienne version en avait fait' WHERE slug = 'format'").run();
      db.exec('DELETE FROM store_sale');
      await datasync.tour();
      const apresTour = lire();

      // Le code monte de version : la signature change, et les fichiers redeviennent la référence.
      db.prepare("UPDATE local_state SET value = 'une-version-d-avant' WHERE kind = 'data' AND ref = 'repo' AND key = 'format_compris'").run();
      const bilan = datasync.rattraperFormat();
      return { recu, apresTour, apres: lire(), ecrits: bilan && bilan.ecrits };
    }`);

    assert.match(String(r.recu), /version de l’équipe/, 'le décor : le second poste a bien reçu ce que le premier a écrit');
    assert.match(String(r.apresTour), /ancienne version/,
      'un tour ordinaire ne relit pas un fichier qui n’a pas changé — c’est le défaut à corriger, pas un bug du test');
    assert.match(String(r.apres), /version de l’équipe/,
      'la signature de format a changé : tout est relu, et le dépôt reprend le dessus');
    assert.ok(r.ecrits > 0, 'et le rattrapage dit combien de lignes il a reprises');

    /* ET IL NE SE REJOUE PAS À CHAQUE DÉMARRAGE : sans changement de signature il ne fait rien,
       sinon chaque lancement relirait tout le dépôt d'une équipe pour rien. */
    const encore = dans(posteFormatB, `async ({ datasync }) => datasync.rattraperFormat()`);
    assert.equal(encore, null, 'signature inchangée : aucun rattrapage');
  });

  test('une adresse qui commence par un tiret n’est jamais passée à git', () => {
    const r = dans(posteA, `async ({ config, datasync, db }) => {
      const piege = '--upload-pack=touch /tmp/mergerie-injection';
      /* PREMIÈRE PORTE : l'enregistrement. Une adresse que git ne doit pas joindre est refusée
         là où l'écran peut encore le dire. */
      let aLEnregistrement;
      try { config.updateConfig({ data_repo_url: piege }); aLEnregistrement = 'accepté'; }
      catch (e) { aLEnregistrement = String(e.message); }
      /* SECONDE PORTE : si la valeur arrive quand même en base — une ancienne version, une
         édition à la main —, elle ne part toujours pas vers git. */
      db.prepare('UPDATE local_config SET data_repo_url = ? WHERE id = 1').run(piege);
      let auRattachement;
      try { await datasync.rattacher({}); auRattachement = 'rattaché'; }
      catch (e) { auRattachement = String(e.message); }
      db.prepare("UPDATE local_config SET data_repo_url = '' WHERE id = 1").run();
      return { aLEnregistrement, auRattachement };
    }`);
    assert.match(r.aLEnregistrement, /Adresse refusée/, 'l’enregistrement refuse une valeur qui ne vaut pas adresse');
    assert.match(r.auRattachement, /aucune URL/, 'et, glissée en base malgré tout, elle ne part pas vers git');
  });

  /* UNE ADRESSE D'AVANT LA RÈGLE NE BLOQUE PAS TOUS LES RÉGLAGES. Un dépôt d'équipe enregistré en
     `http://` (un GitLab interne) empêchait d'enregistrer quoi que ce soit — la langue comprise —
     avec un message sur l'adresse du dépôt. On ne refuse que ce qu'on SAISIT ; la synchro, elle,
     se suspend et le dit. */
  test('une adresse enregistrée hors règle n’empêche pas d’enregistrer les autres réglages', () => {
    const r = dans(posteA, `async ({ config, datasync, db }) => {
      db.prepare("UPDATE local_config SET data_repo_url = 'http://gitlab.interne/eq/data.git' WHERE id = 1").run();
      let autre;
      try { config.updateConfig({ stale_mr_days: '9' }); autre = 'enregistré'; } catch (e) { autre = String(e.message); }
      let memeAdresse;
      try { config.updateConfig({ data_repo_url: 'http://gitlab.interne/eq/data.git' }); memeAdresse = 'enregistré'; } catch (e) { memeAdresse = String(e.message); }
      let nouvelle;
      try { config.updateConfig({ data_repo_url: 'http://autre/eq/data.git' }); nouvelle = 'accepté'; } catch (e) { nouvelle = String(e.message); }
      const lignes = []; const log = console.log; console.log = (m) => lignes.push(String(m));
      const actif = datasync.estConfigure();
      console.log = log;
      db.prepare("UPDATE local_config SET data_repo_url = '' WHERE id = 1").run();
      return { autre, memeAdresse, nouvelle, actif, dit: lignes.some((l) => /synchro suspendue/.test(l)) };
    }`);
    assert.equal(r.autre, 'enregistré', 'un autre réglage s’enregistre');
    assert.equal(r.memeAdresse, 'enregistré', 'renvoyer l’adresse inchangée (le formulaire le fait) passe aussi');
    assert.match(r.nouvelle, /Adresse refusée/, 'une adresse SAISIE hors règle reste refusée');
    assert.equal(r.actif, false, 'la synchro ne part pas vers cette adresse');
    assert.equal(r.dit, true, 'et le journal dit pourquoi, au lieu d’un mono-poste silencieux');
  });

  /* `repo` EST LOCALE : UN POSTE QUI N'EN SUIT QU'UNE PARTIE N'HYDRATE PAS LES MR DE L'AUTRE.
   * Avant ce garde, le balayage comparait ce qu'il PORTE (les MR des dépôts qu'il suit) à TOUT
   * ce que la racine `mrs/` contient dans le dépôt d'équipe — MR d'autres dépôts comprises,
   * jamais hydratées ici faute de dépôt connu. La moindre suppression déclenchant un balayage de
   * `mr` (ici : I supprime une de SES PROPRES MR sur eq/app) balayait donc aussi les MR de
   * dépôts que I n'a jamais suivis, et les retirait du dépôt d'équipe pour tout le monde. Le
   * garde doit jouer dans les deux sens : protéger ce que I ne peut pas juger (eq/api), sans
   * empêcher de balayer ce qu'il peut légitimement juger (sa propre suppression sur eq/app). */
  test('un poste qui ne suit qu’un des deux dépôts ne balaie pas les MR de l’autre', () => {
    const posteH = path.join(racine, 'H');
    const posteI = path.join(racine, 'I');
    fs.mkdirSync(posteH); fs.mkdirSync(posteI);
    const nuH = path.join(racine, 'equipe-h.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuH], { stdio: 'ignore' });

    // H suit DEUX dépôts, et pousse une MR de chacun.
    dans(posteH, `async ({ db, datasync, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuH)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      db.prepare("INSERT INTO mr (repo_id, iid, status, title, updated_at) VALUES (?, 1, 'to_review', 'App', ?)").run(app, now);
      db.prepare("INSERT INTO mr (repo_id, iid, status, title, updated_at) VALUES (?, 1, 'to_review', 'Api', ?)").run(api, now);
      await datasync.commiter('mr app + mr api');
      await datasync.tour();
    }`);

    // I ne suit QUE eq/app, ajouté AVANT de rejoindre : la MR de eq/api ne s'hydrate pas chez
    // lui, faute de dépôt connu — et une passe ultérieure ne la retente pas sans nouveau commit.
    // I pousse aussi SA PROPRE MR sur eq/app (iid 5), pour avoir de quoi supprimer ensuite.
    const chezI = dans(posteI, `async ({ db, datasync, config }) => {
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuH)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      db.prepare("INSERT INTO mr (repo_id, iid, status, title, updated_at) VALUES (?, 5, 'to_review', 'App bis', ?)").run(app, now);
      await datasync.commiter('mr app bis');
      await datasync.tour();
      return db.prepare('SELECT COUNT(*) n FROM mr').get().n;
    }`);
    assert.equal(chezI, 2, 'les MR des dépôts suivis doivent exister chez I — pas celle d’eq/api');

    // I supprime SA propre MR (iid 5) : ceci déclenche un balayage de `mr`.
    dans(posteI, `async ({ db, datasync }) => {
      db.prepare("DELETE FROM mr WHERE iid = 5").run();
      await datasync.commiter('retire ma MR bis');
      await datasync.tour();
    }`);

    const restant = execFileSync('git', ['-C', nuH, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(restant, /mrs\/gitlab\/eq\/api\/1\.json/,
      'la MR d’un dépôt que I n’a jamais suivi ne doit pas disparaître du dépôt d’équipe');
    assert.match(restant, /mrs\/gitlab\/eq\/app\/1\.json/,
      'la MR d’un dépôt encore suivi par I, elle, doit rester');
    assert.doesNotMatch(restant, /mrs\/gitlab\/eq\/app\/5\.json/,
      'en revanche la MR que I vient lui-même de supprimer doit bien sortir : le balayage reste actif sur ce qu’il peut juger');
  });

  /* CE QU'UNE LISTE NE SAIT PAS RATTACHER SURVIT À UN RÉÉCRIT PAR UN POSTE QUI N'EN SUIT QU'UNE
   * PARTIE. Un vérificateur couvrant deux dépôts, réécrit par un poste qui n'en suit qu'un —
   * modifier ses commandes, par exemple — ne doit pas revenir amputé de l'autre : un périmètre
   * amputé est plus dangereux qu'absent, le vérificateur tournerait sur le reste en ayant l'air
   * complet. */
  test('un vérificateur couvrant deux dépôts garde sa couverture entière, réécrit par un poste qui n’en suit qu’un', () => {
    const posteJ = path.join(racine, 'J');
    const posteK = path.join(racine, 'K');
    fs.mkdirSync(posteJ); fs.mkdirSync(posteK);
    const nuJ = path.join(racine, 'equipe-j.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuJ], { stdio: 'ignore' });

    // J suit deux dépôts et couvre les deux avec un vérificateur.
    dans(posteJ, `async ({ db, datasync, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuJ)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      const v = db.prepare("INSERT INTO verifier (name, command, created_at) VALUES ('Tests', '', ?)").run(now).lastInsertRowid;
      db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(v, 'npm test');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, app, 'worktree');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, api, 'worktree');
      await datasync.commiter('verifier sur deux depots');
      await datasync.tour();
    }`);

    // K ne suit que eq/app — ajouté AVANT de rejoindre, pour que la couverture sur eq/app se
    // résolve VRAIMENT en une ligne locale, et seule celle sur eq/api parte dans la marge.
    // K modifie ensuite ses commandes et repousse le fichier.
    const chezK = dans(posteK, `async ({ db, datasync, config }) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now);
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuJ)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      db.prepare("UPDATE verifier_command SET command = 'npm ci && npm test' WHERE position = 0").run();
      await datasync.commiter('modifie la commande');
      await datasync.tour();
      return db.prepare('SELECT COUNT(*) n FROM verifier_repo').get().n;
    }`);
    assert.equal(chezK, 1, 'seule la couverture d’eq/app doit exister en ligne chez K — eq/api reste dans la marge');

    const uid = dans(posteJ, `async ({ db }) => db.prepare("SELECT uid FROM verifier WHERE name = 'Tests'").get().uid`);
    const doc = JSON.parse(execFileSync('git', ['-C', nuJ, 'show', `main:verifiers/${uid}.json`], { encoding: 'utf8' }));
    assert.deepEqual(doc.repos.map((r) => r.repo).sort(), ['gitlab/eq/api', 'gitlab/eq/app'],
      'la couverture doit rester entière — K n’a pas de quoi juger eq/api, il ne doit pas la retirer');
    assert.equal(doc.commands[0], 'npm ci && npm test',
      'et le fichier doit bien porter l’écriture de K, pas être resté celui de J');
  });

  /* LA MARGE NE DOIT PAS DISPARAÎTRE DÈS QUE SON DÉPÔT DEVIENT RÉSOLUBLE, SANS QUE LA LIGNE
   * FILLE EXISTE POUR AUTANT : celle-ci n'apparaît qu'à la PROCHAINE hydratation de CE fichier,
   * qui ne rejoue pas sans nouveau commit. Ajouter le dépôt à ses dépôts suivis, entre l'arrivée
   * du vérificateur et sa réécriture, ne doit donc rien changer à ce qui repart : un filtre sur
   * la seule résolvabilité retirerait l'entrée de la marge sans qu'aucune ligne ne la remplace —
   * recréant l'amputation que la marge devait empêcher. */
  test('un poste qui se met à suivre un dépôt déjà dans sa marge ne perd pas la couverture entre-temps', () => {
    const posteN = path.join(racine, 'N');
    const posteO = path.join(racine, 'O');
    fs.mkdirSync(posteN); fs.mkdirSync(posteO);
    const nuN = path.join(racine, 'equipe-n.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuN], { stdio: 'ignore' });

    // N suit deux dépôts et couvre les deux avec un vérificateur.
    dans(posteN, `async ({ db, datasync, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuN)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      const v = db.prepare("INSERT INTO verifier (name, command, created_at) VALUES ('Tests bis', '', ?)").run(now).lastInsertRowid;
      db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(v, 'npm test');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, app, 'worktree');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, api, 'worktree');
      await datasync.commiter('verifier bis sur deux depots');
      await datasync.tour();
    }`);

    // O ne suit d'abord que eq/app : eq/api part dans sa marge, sans ligne verifier_repo. O
    // ajoute ENSUITE eq/api à ses dépôts suivis — sans nouveau commit sur ce vérificateur, donc
    // sans que la ligne verifier_repo pour eq/api soit créée — puis modifie une commande.
    const chezO = dans(posteO, `async ({ db, datasync, config }) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now);
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuN)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now);
      db.prepare("UPDATE verifier_command SET command = 'npm ci && npm test' WHERE position = 0").run();
      await datasync.commiter('modifie la commande, apres avoir ajoute eq/api');
      await datasync.tour();
      return db.prepare('SELECT COUNT(*) n FROM verifier_repo').get().n;
    }`);
    assert.equal(chezO, 1,
      'eq/api est désormais résoluble chez O, mais sa ligne verifier_repo n’a pas encore été créée : une seule ligne locale');

    const uid = dans(posteN, `async ({ db }) => db.prepare("SELECT uid FROM verifier WHERE name = 'Tests bis'").get().uid`);
    const doc = JSON.parse(execFileSync('git', ['-C', nuN, 'show', `main:verifiers/${uid}.json`], { encoding: 'utf8' }));
    assert.deepEqual(doc.repos.map((r) => r.repo).sort(), ['gitlab/eq/api', 'gitlab/eq/app'],
      'la couverture doit rester entière : eq/api résoluble ne veut pas dire eq/api déjà émis par la ligne locale');
    assert.equal(doc.commands[0], 'npm ci && npm test');
  });

  /* UNE COUVERTURE REPRISE PAR UNE LIGNE LOCALE PUIS RETIRÉE NE REVIENT PAS PAR LA MARGE : le
   * choix de l'utilisateur de la décocher ne doit pas être annulé au prochain export. */
  test('une couverture ajoutée puis retirée chez un poste ne revient pas par la marge', () => {
    const posteP = path.join(racine, 'P');
    const posteQ = path.join(racine, 'Q');
    fs.mkdirSync(posteP); fs.mkdirSync(posteQ);
    const nuP = path.join(racine, 'equipe-p.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuP], { stdio: 'ignore' });

    dans(posteP, `async ({ db, datasync, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuP)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      const v = db.prepare("INSERT INTO verifier (name, command, created_at) VALUES ('Tests ter', '', ?)").run(now).lastInsertRowid;
      db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(v, 'npm test');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, app, 'worktree');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, api, 'worktree');
      await datasync.commiter('verifier ter');
      await datasync.tour();
    }`);

    dans(posteQ, `async ({ db, datasync, config }) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now);
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuP)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      const v = db.prepare("SELECT id FROM verifier WHERE name = 'Tests ter'").get().id;
      // Q coche la couverture d'eq/api : une ligne locale reprend l'entrée de la marge…
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, api, 'worktree');
      await datasync.commiter('couvre eq/api');
      // …puis la décoche : elle ne doit pas revenir.
      db.prepare('DELETE FROM verifier_repo WHERE verifier_id = ? AND repo_id = ?').run(v, api);
      await datasync.commiter('ne couvre plus eq/api');
      await datasync.tour();
    }`);

    const uid = dans(posteP, `async ({ db }) => db.prepare("SELECT uid FROM verifier WHERE name = 'Tests ter'").get().uid`);
    const doc = JSON.parse(execFileSync('git', ['-C', nuP, 'show', `main:verifiers/${uid}.json`], { encoding: 'utf8' }));
    assert.deepEqual(doc.repos.map((r) => r.repo), ['gitlab/eq/app'],
      'la couverture retirée par Q ne doit pas être réémise par la marge');
  });

  /* RETIRER UN DÉPÔT DE SES DÉPÔTS SUIVIS N'AMPUTE PAS LA COUVERTURE DES COLLÈGUES : la cascade
   * SQL emporte la ligne `verifier_repo`, et sans `verserEnMarge` le fichier repartait sans lui. */
  test('un poste qui retire un dépôt de sa liste ne retire pas sa couverture chez les autres', () => {
    const posteR = path.join(racine, 'R');
    const posteS = path.join(racine, 'S');
    fs.mkdirSync(posteR); fs.mkdirSync(posteS);
    const nuR = path.join(racine, 'equipe-r.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuR], { stdio: 'ignore' });
    const mise = `
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;`;

    dans(posteR, `async ({ db, datasync, config }) => {
      ${mise}
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuR)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const v = db.prepare("INSERT INTO verifier (name, command, created_at) VALUES ('Tests quater', '', ?)").run(now).lastInsertRowid;
      db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?, 0, ?)').run(v, 'npm test');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, app, 'worktree');
      db.prepare('INSERT INTO verifier_repo (verifier_id, repo_id, mode) VALUES (?, ?, ?)').run(v, api, 'worktree');
      await datasync.commiter('verifier quater');
      await datasync.tour();
    }`);

    dans(posteS, `async ({ db, store, datasync, config }) => {
      ${mise}
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuR)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      store.verserEnMarge(api);
      db.prepare('DELETE FROM repo WHERE id = ?').run(api);
      await datasync.commiter('retire eq/api de mes dépôts');
      await datasync.tour();
    }`);

    const uid = dans(posteR, `async ({ db }) => db.prepare("SELECT uid FROM verifier WHERE name = 'Tests quater'").get().uid`);
    const doc = JSON.parse(execFileSync('git', ['-C', nuR, 'show', `main:verifiers/${uid}.json`], { encoding: 'utf8' }));
    assert.deepEqual(doc.repos.map((r) => r.repo).sort(), ['gitlab/eq/api', 'gitlab/eq/app'],
      'S ne suit plus eq/api : c’est sa décision de poste, pas celle de R');
  });

  /* UNE SESSION MULTI-DÉPÔTS RÉÉCRITE PAR UN POSTE QUI N'EN SUIT QU'UN GARDE SES DEUX CIBLES :
   * la cible d'eq/api n'a pas de ligne chez U (dépôt inconnu), mais elle reste dans la marge de la
   * session et repart telle quelle — branche, MR et sortie de l'agent comprises. Et retirer un
   * dépôt de sa liste verse ses cibles dans la marge avant la cascade. */
  test('une session multi-dépôts réécrite par un poste qui n’en suit qu’un garde ses deux cibles', () => {
    const posteT = path.join(racine, 'T');
    const posteU = path.join(racine, 'U');
    fs.mkdirSync(posteT); fs.mkdirSync(posteU);
    const nuT = path.join(racine, 'equipe-t.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuT], { stdio: 'ignore' });

    dans(posteT, `async ({ db, datasync, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuT)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      const t = db.prepare(\`INSERT INTO task (repo_id, kind, prompt, branch, status, shared, created_at, updated_at)
        VALUES (?, 'code', 'Multi', 'feat/x', 'pushed', 1, ?, ?)\`).run(app, now, now).lastInsertRowid;
      for (const r of [app, api]) {
        db.prepare("INSERT INTO task_target (task_id, repo_id, branch, status, mr_iid, updated_at) VALUES (?, ?, 'feat/x', 'pushed', 7, ?)").run(t, r, now);
      }
      await datasync.commiter('session multi-depots');
      await datasync.tour();
    }`);

    const chezU = dans(posteU, `async ({ db, datasync, config }) => {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now);
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuT)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      db.prepare("UPDATE task SET status = 'done', updated_at = ? WHERE prompt = 'Multi'").run(new Date().toISOString());
      await datasync.commiter('change le statut');
      await datasync.tour();
      return db.prepare('SELECT COUNT(*) n FROM task_target').get().n;
    }`);
    assert.equal(chezU, 1, 'une seule cible en ligne chez U : eq/api reste dans la marge');

    const uid = dans(posteT, `async ({ db }) => db.prepare("SELECT uid FROM task WHERE prompt = 'Multi'").get().uid`);
    const doc = JSON.parse(execFileSync('git', ['-C', nuT, 'show', `main:sessions/${uid}/session.json`], { encoding: 'utf8' }));
    assert.equal(doc.status, 'done', 'le fichier porte bien l’écriture de U');
    assert.deepEqual(doc.targets.map((x) => x.repo).sort(), ['gitlab/eq/api', 'gitlab/eq/app']);
    assert.equal(doc.targets.find((x) => x.repo === 'gitlab/eq/api').mr_iid, 7, 'la cible d’eq/api repart intacte');

    // Retirer eq/api de SA liste, chez T (qui la suit) : sa cible passe dans la marge, pas à la trappe.
    dans(posteU, `async ({ db, store, datasync }) => {
      const now = new Date().toISOString();
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      const t = db.prepare("SELECT id FROM task WHERE prompt = 'Multi'").get().id;
      db.prepare("INSERT INTO task_target (task_id, repo_id, branch, status, mr_iid, updated_at) VALUES (?, ?, 'feat/x', 'pushed', 7, ?)").run(t, api, now);
      await datasync.commiter('suit eq/api');
      store.verserEnMarge(api);
      db.prepare('DELETE FROM repo WHERE id = ?').run(api);
      await datasync.commiter('ne suit plus eq/api');
      await datasync.tour();
    }`);
    const apres = JSON.parse(execFileSync('git', ['-C', nuT, 'show', `main:sessions/${uid}/session.json`], { encoding: 'utf8' }));
    assert.deepEqual(apres.targets.map((x) => x.repo).sort(), ['gitlab/eq/api', 'gitlab/eq/app'],
      'retirer un dépôt de sa liste ne retire pas sa cible de la session d’équipe');
  });

  /* LE PENDANT POUR `agent_pass` : UNE PASSE DE CODAGE SUR UN DÉPÔT NON SUIVI SURVIT À UN
   * BALAYAGE DÉCLENCHÉ AILLEURS. Le dépôt n'est même pas dans le fichier de la passe — il est
   * dans celui de sa SESSION, relu via `porteeRepo: { parent }`. */
  test('un poste qui ne suit qu’un des deux dépôts ne balaie pas les passes de codage de l’autre', () => {
    const posteL = path.join(racine, 'L');
    const posteM = path.join(racine, 'M');
    fs.mkdirSync(posteL); fs.mkdirSync(posteM);
    const nuL = path.join(racine, 'equipe-l.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nuL], { stdio: 'ignore' });

    // L suit deux dépôts, lance une session de codage partagée sur chacun, avec une passe.
    dans(posteL, `async ({ db, datasync, config }) => {
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuL)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});
      const now = new Date().toISOString();
      const creerSession = (repoId, iid) => {
        const t = db.prepare(\`INSERT INTO task (repo_id, kind, prompt, branch, status, shared, created_at, updated_at)
          VALUES (?, 'code', 'Prompt', 'feat/x', 'pushed', 1, ?, ?)\`).run(repoId, now, now).lastInsertRowid;
        const tg = db.prepare(\`INSERT INTO task_target (task_id, repo_id, branch, status, updated_at)
          VALUES (?, ?, 'feat/x', 'pushed', ?)\`).run(t, repoId, now).lastInsertRowid;
        const f = require('node:path').join(process.env.MERGERIE_DATA_DIR, \`passe-\${iid}.md\`);
        require('node:fs').writeFileSync(f, 'réponse de l’IA');
        db.prepare(\`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
          VALUES ('task', ?, ?, 1, 'run', 'fais-le', ?, ?)\`).run(t, tg, f, now);
      };
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      const api = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/api', 'https://x/eq/api.git', 1, ?)").run(now).lastInsertRowid;
      creerSession(app, 'app');
      creerSession(api, 'api');
      await datasync.commiter('deux sessions');
      await datasync.tour();
    }`);

    // M ne suit que eq/app, ajouté AVANT de rejoindre : la session sur eq/api (et sa passe) ne
    // s'hydratent pas chez lui, faute de dépôt connu. M lance ensuite SA PROPRE session sur
    // eq/app, avec sa propre passe, pour avoir de quoi supprimer et déclencher un balayage.
    const chezM = dans(posteM, `async ({ db, datasync, config }) => {
      const now = new Date().toISOString();
      const app = db.prepare("INSERT INTO repo (forge, project, url, enabled, created_at) VALUES ('gitlab', 'eq/app', 'https://x/eq/app.git', 1, ?)").run(now).lastInsertRowid;
      config.updateConfig({ data_repo_url: ${JSON.stringify(nuL)}, data_repo_branch: 'main', data_sync_seconds: '10' });
      await datasync.rattacher({});

      const t = db.prepare(\`INSERT INTO task (repo_id, kind, prompt, branch, status, shared, created_at, updated_at)
        VALUES (?, 'code', 'Prompt de M', 'feat/y', 'pushed', 1, ?, ?)\`).run(app, now, now).lastInsertRowid;
      const tg = db.prepare(\`INSERT INTO task_target (task_id, repo_id, branch, status, updated_at)
        VALUES (?, ?, 'feat/y', 'pushed', ?)\`).run(t, app, now).lastInsertRowid;
      const f = require('node:path').join(process.env.MERGERIE_DATA_DIR, 'passe-m.md');
      require('node:fs').writeFileSync(f, 'réponse à M');
      db.prepare(\`INSERT INTO agent_pass (scope, task_id, unit_id, n, kind, prompt, output_path, created_at)
        VALUES ('task', ?, ?, 1, 'run', 'fais-le', ?, ?)\`).run(t, tg, f, now);
      await datasync.commiter('ma propre session');
      await datasync.tour();

      // M supprime SA propre passe : ceci déclenche un balayage de \`agent_pass\`.
      db.prepare('DELETE FROM agent_pass WHERE task_id = ?').run(t);
      await datasync.commiter('retire ma passe');
      await datasync.tour();
      return db.prepare('SELECT COUNT(*) n FROM agent_pass').get().n;
    }`);
    assert.equal(chezM, 1, 'seule la passe du dépôt suivi doit exister chez M — pas celle d’eq/api, ni celle qu’il vient de retirer');

    const restant = execFileSync('git', ['-C', nuL, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    const passes = (restant.match(/pass-[^/]+\.md/g) || []).length;
    assert.equal(passes, 2,
      'la passe d’eq/api (jamais suivi par M) et celle d’eq/app (encore suivie) doivent survivre ; seule celle que M a supprimée doit sortir');
  });
});
