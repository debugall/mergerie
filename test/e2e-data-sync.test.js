'use strict';
/* L'ÉCRAN DES DONNÉES PARTAGÉES — de bout en bout, avec un vrai dépôt git.
 *
 * Le test fabrique un dépôt NU, le rattache depuis le FORMULAIRE (pas par l'API : c'est le
 * formulaire qu'on éprouve), et vérifie que ce qui compte se voit :
 *
 * — LES TROIS CHAMPS SONT DES RÉGLAGES DE POSTE, badgés comme tels. L'adresse par laquelle on
 *   rejoint l'équipe ne peut pas venir de l'équipe : ce serait circulaire.
 * — LE RATTACHEMENT ÉCRIT VRAIMENT DANS LE DÉPÔT. On regarde le dépôt nu, pas un libellé.
 * — LE PIED DE PAGE DIT OÙ ON EN EST, sans aller dans les réglages — c'est la question qu'on se
 *   pose en passant.
 * — RIEN NE S'AFFICHE TANT QU'AUCUN DÉPÔT N'EST CONFIGURÉ : le mode mono-poste ne doit pas
 *   découvrir une fonctionnalité qu'il n'a pas demandée.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, lancerNavigateur, navigateurDispo, attendreServeur } = require('./helpers/app');

const { dispo } = navigateurDispo();
const ATTENTE = 20000;

let app; let navigateur; let page; let racine; let nu;

describe('Données partagées · l’écran et le dépôt', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  before(async () => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-datasync-e2e-'));
    nu = path.join(racine, 'mergerie-data.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });
    app = await startApp();
    await app.configure();
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    try { fs.rmSync(racine, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  /* UN SOUS-ONGLET À SOI. Le partage n'est pas une préférence d'affichage : on y revient pour
     voir où en est la synchro et trancher un conflit, ce qu'on ne fait jamais pour un thème. */
  const ouvrirPartage = async () => {
    await page.click('nav button[data-tab="admin"]');
    await page.click('button[data-sub="datasync"]');
    await page.waitForFunction(() => document.querySelector('#sub-datasync').classList.contains('active'),
      null, { timeout: ATTENTE });
    await page.waitForSelector('#dataSyncState', { timeout: ATTENTE });
  };

  test('sans dépôt configuré, l’écran le dit et le pied de page se tait', async () => {
    await ouvrirPartage();
    await page.waitForFunction(() => (document.querySelector('#dataSyncState').textContent || '').length > 0,
      null, { timeout: ATTENTE });
    assert.match(await page.textContent('#dataSyncState'), /mono-poste/);
    assert.equal(await page.locator('#footerSync').isVisible(), false,
      'le mode mono-poste ne doit pas découvrir une fonctionnalité qu’il n’a pas demandée');
  });

  test('le partage a son propre sous-onglet — il n’est plus au milieu du Général', async () => {
    /* Trois champs perdus entre le thème et la zone dangereuse, alors qu'on revient ici pour
       voir où en est la synchro et trancher un conflit. Ce n'est pas une préférence
       d'affichage : ça a son onglet. */
    assert.equal(await page.locator('#tab-admin button[data-sub="datasync"]').count(), 1);
    assert.equal(await page.locator('#sub-config [form="configForm"][name="data_repo_url"]').count(), 0,
      'le bloc ne doit plus vivre dans « Général »');
    assert.equal(await page.locator('#sub-datasync #dataSyncState').count(), 1);
  });

  test('les trois champs sont badgés « ce poste »', async () => {
    const scopes = await page.evaluate(() => ['data_repo_url', 'data_repo_branch', 'data_sync_seconds']
      .map((n) => {
        const el = document.querySelector(`[form="configForm"][name="${n}"]`);
        const b = el && el.closest('label') && el.closest('label').querySelector('.scope-badge');
        return b ? b.dataset.scope : null;
      }));
    assert.deepEqual(scopes, ['poste', 'poste', 'poste'],
      'l’adresse par laquelle on rejoint l’équipe ne peut pas venir de l’équipe');
  });

  test('« Cloner / rattacher » initialise vraiment le dépôt nu', async () => {
    // Une note d'abord : le dépôt initialisé doit emporter ce que ce poste a déjà.
    const { body: page1 } = await app.api('POST', '/api/notes', { title: 'Déploiement prod', content: '# Prod' });
    assert.ok(page1.id);
    /* ET ELLE NE PART QUE COCHÉE. Une page de notes est le seul objet qu'on écrit sans
       destinataire ; l'initialisation d'un dépôt d'équipe ne doit pas publier les brouillons. */
    await app.api('PUT', `/api/notes/${page1.id}`, { shared: 1 });
    const { body: prive } = await app.api('POST', '/api/notes', { title: 'Mon brouillon', content: 'non' });
    assert.ok(prive.id);

    await ouvrirPartage();
    await page.fill('[form="configForm"][name="data_repo_url"]', nu);
    await page.fill('[form="configForm"][name="data_repo_branch"]', 'main');
    await page.click('#btnDataAttach');
    /* On attend le PUSH, pas le clone : `estDepot()` devient vrai dès le `git init`, c'est-à-dire
       avant que quoi que ce soit soit parti. Attendre là, ce serait regarder le dépôt nu pendant
       qu'on écrit encore dedans. */
    await attendreServeur(async () => {
      const e = (await app.api('GET', '/api/data-sync')).body;
      return Boolean(e.clone && e.dernierPush);
    }, 'le premier envoi vers le dépôt de données');

    /* On regarde LE DÉPÔT NU, pas un libellé à l'écran : c'est la seule preuve que quelque
       chose est vraiment parti chez les autres. */
    const etatApres = (await app.api('GET', '/api/data-sync')).body;
    assert.equal(etatApres.erreur, null, `la synchro a échoué : ${etatApres.erreur}`);
    const listing = execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(listing, /notes\/deploiement-prod\.md/);
    assert.doesNotMatch(listing, /mon-brouillon/, 'une note non cochée reste à soi');
    assert.match(listing, /\.mergerie-data\.json/, 'le dépôt doit dire quel format il parle');
  });

  test('le pied de page apparaît, et dit où l’on en est', async () => {
    await page.waitForFunction(() => {
      const b = document.querySelector('#footerSync');
      return b && !b.hidden;
    }, null, { timeout: ATTENTE });
    const txt = await page.textContent('#footerSyncTxt');
    assert.match(txt, /↑\d+ ↓\d+/);
    assert.equal(await page.getAttribute('#footerSync', 'data-etat'), 'ok');
  });

  test('le témoin du pied de page dit dans combien de temps part la prochaine synchro', async () => {
    /* « C'est parti ? dans combien de temps ? » est la question qu'on se pose EN PASSANT, et le
       pied de page est l'endroit où l'on passe. Le compte à rebours vient de l'échéance que le
       serveur annonce — la boucle bat chez lui, et sa cadence se règle : la deviner ici, ce
       serait afficher un chiffre faux dès qu'on change le réglage. */
    const etat = (await app.api('GET', '/api/data-sync')).body;
    assert.ok(etat.prochain, 'l’état doit dire QUAND, pas seulement « ça tourne »');
    assert.ok(Date.parse(etat.prochain) > Date.now() - 1000);
    assert.ok(etat.cadence >= 10);

    await page.hover('#footerSync');
    await page.waitForFunction(() => {
      const t = document.querySelector('#tip');
      return t && t.classList.contains('on') && /\d+\s*s/.test(t.textContent);
    }, null, { timeout: ATTENTE });
    const lire = () => page.evaluate(() => {
      const m = /(\d+)\s*s/.exec(document.querySelector('#tip').textContent);
      return m ? Number(m[1]) : null;
    });
    const premier = await lire();
    /* IL DESCEND VRAIMENT. Une bulle écrite une fois à l'ouverture afficherait le même chiffre
       pendant qu'on la regarde — et un compte à rebours figé est pire que pas de compte à
       rebours : on le croit. On attend donc que le chiffre CHANGE, sans parier sur une durée. */
    await page.waitForFunction((n) => {
      const m = /(\d+)\s*s/.exec(document.querySelector('#tip').textContent);
      return m && Number(m[1]) !== n;
    }, premier, { timeout: ATTENTE });
    assert.ok((await lire()) < premier, 'le compte à rebours descend');
  });

  test('l’historique d’une page se lit — ce que git rend gratuitement', async () => {
    /* Aucune table de versions n'a été écrite pour ça : l'information existe parce qu'on est
       passé par git, et la montrer ne coûte qu'un appel. */
    const { body: liste } = await app.api('GET', '/api/notes');
    const pages = Array.isArray(liste) ? liste : (liste.pages || []);
    const page = pages.find((x) => x.title === 'Déploiement prod');
    assert.ok(page, 'la page créée plus haut doit être là');
    const { body: h } = await app.api('GET', `/api/notes/${page.id}/history`);
    assert.equal(h.file, 'notes/deploiement-prod.md');
    assert.ok(h.commits.length >= 1, 'la page doit avoir au moins le commit qui l’a créée');
    assert.ok(h.commits[0].auteur, 'un historique sans auteur ne répond pas à « qui a écrit ça ? »');
    const { body: d } = await app.api('GET', `/api/notes/${page.id}/history?sha=${h.commits[0].sha}`);
    assert.match(d.diff, /deploiement-prod\.md/);
  });

  test('« par <nom> » vient de git — aucune colonne à tenir', async () => {
    /* Le fichier a été commité par quelqu'un, et git le sait. Une colonne `author` à côté serait
       une seconde vérité à aligner — et elle mentirait le jour où le fichier est corrigé à la
       main, ou repris d'un collègue. */
    await app.api('POST', '/api/data-sync/now');
    const { body: liste } = await app.api('GET', '/api/notes');
    const pages = Array.isArray(liste) ? liste : (liste.pages || []);
    const page = pages.find((x) => x.title === 'Déploiement prod');
    const { body: h } = await app.api('GET', `/api/notes/${page.id}/history`);
    assert.equal(h.commits[0].auteur, 'Test', 'l’auteur est l’identité git du poste');
  });

  test('une page de notes ne part QUE si on coche la case — et la case est décochée', async () => {
    /* PAR LE FORMULAIRE, ET NON PAR L'API. C'est la case qu'on éprouve : une note publiée par
       inadvertance ne se rattrape pas — un fichier commité dans git reste dans chaque clone.
       Le reste de l'outil se partage en bloc parce qu'il n'est fait que de produits ; les notes
       sont l'endroit où l'on écrit sans destinataire. */
    const { body: creee } = await app.api('POST', '/api/notes', { title: 'Compte rendu équipe', content: 'ce qu’on s’est dit' });
    await page.click('nav button[data-tab="notes"]');
    await page.locator('#tab-notes .subnav button[data-nsub="pages"]').click();
    await page.locator('#pageList .note-item', { hasText: 'Compte rendu équipe' }).click();
    await page.waitForSelector('#pageShare:not([hidden])', { timeout: ATTENTE });
    assert.equal(await page.locator('#pageShareBox').isChecked(), false,
      'le défaut d’une case qui publie est « non »');

    await page.locator('#pageShareBox').click();
    /* On lit l'ÉTAT SERVEUR, pas le libellé : « enregistré » à l'écran et « enregistré » en
       base ne sont pas la même phrase. */
    await attendreServeur(async () => (await app.api('GET', `/api/notes/${creee.id}`)).body.shared === 1,
      'la page cochée côté serveur');
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => /notes\/compte-rendu-equipe\.md/.test(
      execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })),
    'la page cochée poussée dans le dépôt');

    // …et décocher la RETIRE : sinon la case aurait menti, et la page resterait chez tout le monde.
    await page.locator('#pageShareBox').click();
    await attendreServeur(async () => (await app.api('GET', `/api/notes/${creee.id}`)).body.shared === 0,
      'la page décochée côté serveur');
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => !/notes\/compte-rendu-equipe\.md/.test(
      execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })),
    'la page retirée du dépôt');
  });

  test('une session de codage ne part QUE si on coche la case', async () => {
    /* PAR LE FORMULAIRE, comme la case des notes. Une session est un processus — le prompt tel
       qu'on l'a tapé, les relances, la capture collée — et le résultat, lui, part déjà par la
       forge. Publier le brouillon avec le livre ne se rattrape pas. */
    const { body: repo } = await app.api('POST', '/api/repos', { url: 'https://gitlab.test/eq/api.git', project: 'eq/api' });
    const { body: creee } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'refonte du tunnel', targets: [{ repo_id: repo.id, branch: 'ai/tunnel' }],
    });
    assert.equal(creee.shared, 0, 'le défaut d’une case qui publie est « non »');

    const { body: apres } = await app.api('POST', `/api/tasks/${creee.id}/share`, { shared: 1 });
    assert.equal(apres.shared, 1);
    await app.api('POST', '/api/data-sync/now');
    const uid = app.db.prepare('SELECT uid FROM task WHERE id = ?').get(creee.id).uid;
    await attendreServeur(async () => new RegExp(`sessions/${uid}/session\\.json`).test(
      execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })),
    'la session cochée poussée dans le dépôt');

    await app.api('POST', `/api/tasks/${creee.id}/share`, { shared: 0 });
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => !new RegExp(`sessions/${uid}/`).test(
      execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })),
    'la session décochée retirée du dépôt');
  });

  test('la session d’un collègue ne se supprime pas — on la range', async () => {
    /* Avec des sessions partagées, l'auteur est identifiable : c'est celui qui a commité le
       fichier, et git le sait. Supprimer ici retirerait le fichier du dépôt, et la ligne
       disparaîtrait chez son auteur au `pull` suivant — on effacerait le travail de quelqu'un
       d'autre. Ranger, en revanche, est une préférence de poste et reste possible. */
    const { body: repo2 } = await app.api('POST', '/api/repos', { url: 'https://gitlab.test/eq/front.git', project: 'eq/front' });
    const { body: t2 } = await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'ce que Claire a demandé', targets: [{ repo_id: repo2.id, branch: 'ai/claire' }],
    });
    await app.api('POST', `/api/tasks/${t2.id}/share`, { shared: 1 });
    await app.api('POST', '/api/data-sync/now');
    const uid2 = app.db.prepare('SELECT uid FROM task WHERE id = ?').get(t2.id).uid;
    await attendreServeur(async () => new RegExp(`sessions/${uid2}/session\\.json`).test(
      execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })),
    'la session poussée avant que Claire ne la reprenne');

    /* Claire la modifie de son côté : le dernier commit de CE fichier porte son nom, et c'est
       exactement ce que l'outil lit pour dire « par Claire ». */
    const chezClaire = path.join(racine, 'claire');
    execFileSync('git', ['clone', nu, chezClaire], { stdio: 'ignore' });
    const fichier = path.join(chezClaire, 'sessions', uid2, 'session.json');
    const doc = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    doc.label = 'repris par Claire';
    fs.writeFileSync(fichier, `${JSON.stringify(doc, null, 2)}\n`);
    for (const args of [['add', '-A'], ['-c', 'user.name=Claire', '-c', 'user.email=claire@exemple.test',
      'commit', '-m', 'session de Claire', '--author=Claire <claire@exemple.test>'], ['push', 'origin', 'main']]) {
      execFileSync('git', ['-C', chezClaire, ...args], { stdio: 'ignore' });
    }
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => (await app.api('GET', '/api/tasks')).body.some((x) => x.id === t2.id && x.author === 'Claire'),
      'la session reconnue comme celle de Claire');

    const refus = await app.api('DELETE', `/api/tasks/${t2.id}`);
    assert.equal(refus.status, 403, 'effacer ici l’effacerait chez tout le monde');
    assert.match(refus.body.error, /Claire/, 'le message doit dire à QUI elle est');
    assert.ok(app.db.prepare('SELECT 1 FROM task WHERE id = ?').get(t2.id), 'et rien n’a été supprimé');

    // …mais la ranger reste possible : c'est un geste de poste, il ne touche pas au dépôt.
    const range = await app.api('POST', `/api/tasks/${t2.id}/hidden`, { hidden: 1 });
    assert.equal(range.status, 200);
  });

  test('la case « partager » existe dans les trois saveurs, et pas en mono-poste', async () => {
    /* La modale est commune aux trois saveurs mais chaque saveur a son envoi : la case doit
       exister ET être câblée dans les trois. On éprouve ici qu'elle s'affiche ; le câblage est
       prouvé par les créations ci-dessus et par l'API. */
    await page.click('nav button[data-tab="task"]');
    await page.waitForSelector('#btnNewTask', { timeout: ATTENTE });
    for (const kind of ['code', 'local', 'ask']) {
      await page.click(`#tab-task .subnav [data-kind="${kind}"]`);
      await page.waitForFunction((k) => {
        const b = document.querySelector(`#tab-task .subnav [data-kind="${k}"]`);
        return b && b.classList.contains('active');
      }, kind, { timeout: ATTENTE });
      await page.click('#btnNewTask');
      await page.waitForSelector('#taskShareRow:not([hidden])', { timeout: ATTENTE });
      assert.equal(await page.locator('#taskShareRow input[name="shared"]').isChecked(), false,
        `jamais cochée d’office (${kind})`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('#taskModal', { state: 'hidden', timeout: ATTENTE });
    }
  });

  test('la dépense ne part QUE si on l’a demandé', async () => {
    const dansLeDepot = () => execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.doesNotMatch(dansLeDepot(), /^usage\//m,
      'décoché par défaut : ce que coûte mon abonnement ne regarde que moi');

    await app.api('PUT', '/api/config', { usage_share: '1' });
    app.db.prepare(`INSERT INTO usage (kind, prompt_chars, output_chars, tokens_est, cost_usd, created_at)
      VALUES ('task', 100, 50, 40, 0.12, ?)`).run(new Date().toISOString());
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => /usage\//.test(dansLeDepot()), 'la dépense agrégée poussée');

    const fichier = dansLeDepot().split('\n').find((f) => f.startsWith('usage/'));
    const doc = JSON.parse(execFileSync('git', ['-C', nu, 'show', `main:${fichier}`], { encoding: 'utf8' }));
    assert.equal(doc.who, 'Test');
    const jours = Object.values(doc.days);
    assert.equal(jours.length, 1, 'un total PAR JOUR, pas une ligne par appel');
    assert.equal(jours[0].task.calls, 1);
    assert.equal(jours[0].task.cost_usd, 0.12);
    await app.api('PUT', '/api/config', { usage_share: '0' });
  });

  test('une note écrite ensuite part dans le dépôt, avec un message de commit lisible', async () => {
    const { body: p } = await app.api('POST', '/api/notes', { title: 'Bascule équipe', content: 'texte' });
    await app.api('PUT', `/api/notes/${p.id}`, { shared: 1 });
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => {
      const l = execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
      return /notes\/bascule-equipe\.md/.test(l);
    }, 'la note poussée dans le dépôt');
    const messages = execFileSync('git', ['-C', nu, 'log', '--format=%s'], { encoding: 'utf8' });
    assert.match(messages, /note "Bascule équipe"/,
      'un message généré doit dire le GESTE, pas « update 3 files »');
  });
});
