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
    assert.match(listing, /repos\/gitlab\/eq\/api\.json/, 'le dépôt suivi aussi');
    assert.match(listing, /mrs\/gitlab\/eq\/api\/41\.json/, 'et la MR relue — la question posée');
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
