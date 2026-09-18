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
const {
  startApp, lancerNavigateur, navigateurDispo, attendreServeur, makeRemoteRepo,
} = require('./helpers/app');

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
    /* L'APERÇU INTERROGE LE DÉPÔT DISTANT, ce qui prend le temps que prend le réseau : le
       bouton doit tourner pendant ce temps-là, sinon on le re-clique. On RETIENT la réponse
       jusqu'à l'avoir vu tourner — un délai fixe ne prouverait que la vitesse de la machine. */
    let libererApercu;
    const apercuTenu = new Promise((r) => { libererApercu = r; });
    await page.route('**/api/data-sync/preview*', async (route) => { await apercuTenu; await route.continue(); });
    await page.click('#btnDataAttach');
    await page.waitForSelector('#btnDataAttach[data-busy]', { timeout: ATTENTE });
    libererApercu();
    /* CE QUI VA PARTIR SE LIT AVANT DE CLIQUER : le rattachement demande confirmation et montre
       ce qu'il emporte — et surtout ce qu'il NE PREND PAS, les sessions et todos étant privées
       par défaut. Rien n'est écrit tant qu'on n'a pas répondu. */
    await page.waitForSelector('#confirmModal:not([hidden])', { timeout: ATTENTE });
    await page.unroute('**/api/data-sync/preview*');
    const resume = await page.textContent('#confirmBody');
    assert.match(resume, /notes|merge requests|reviews|dépôts|repositories/i,
      'le récapitulatif doit dire ce qui part');
    /* DEUX COLONNES, PAS UN PARAGRAPHE : « ce qui part » et « ce qui reste » s'opposent, et
       cette opposition EST l'information. Plus le compte des fichiers, dont le zéro des
       suppressions — le chiffre qu'on vient vérifier avant de cliquer. */
    const forme = await page.evaluate(() => ({
      part: document.querySelectorAll('#confirmBody .apercu-col-part .apercu-liste li').length,
      reste: document.querySelectorAll('#confirmBody .apercu-col-reste').length,
      chiffres: [...document.querySelectorAll('#confirmBody .apercu-chiffre b')].map((n) => n.textContent),
      supprimes: (document.querySelector('#confirmBody .apercu-chiffre-nul b') || {}).textContent,
      large: document.querySelector('#confirmModal .modal-box').classList.contains('modal-confirm-lg'),
    }));
    assert.ok(forme.part >= 2, `une ligne par famille, pas une phrase (${forme.part})`);
    assert.equal(forme.reste, 1, 'ce qui reste sur ce poste a sa propre colonne');
    assert.equal(forme.chiffres.length, 4, 'ajoutés, modifiés, inchangés, supprimés');
    assert.equal(forme.supprimes, '0', 'l’envoi écrit, il ne supprime jamais — et il le montre');
    /* DEVANT UN DÉPÔT VIDE, TOUT EST NOUVEAU. Le compte se fait contre le répertoire de travail,
       qui porte déjà les fichiers que ce poste s'est écrits à lui-même : les annoncer
       « inchangés » avant d'initialiser un dépôt nu reviendrait à dire que rien ne part. */
    assert.ok(Number(forme.chiffres[0]) > 0,
      `le dépôt est vide : ce qui part doit être compté comme ajouté (${forme.chiffres.join('/')})`);
    assert.ok(forme.large, 'deux colonnes ne tiennent pas dans une modale de 460 px');
    await page.click('#confirmOk');
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
  test('« Tout ré-envoyer » remet ce qu’un dépôt vidé à la main a perdu', async () => {
    /* « Synchroniser » n'envoie que CE QUI A CHANGÉ : la file des écritures décide, et elle est
       vide quand rien n'a bougé. Un dépôt vidé à la main ne se rattrapait donc pas — et le seul
       chemin, « Cloner / rattacher », ne dit pas dans son nom qu'il ré-exporte.
       CE TEST VIENT APRÈS TOUS CEUX QUI DÉPENDENT DU DÉCOR : il vide le dépôt d'équipe. Le
       seul qui le suit apporte le sien — dépôt, merge request et review —, et éprouve au
       passage qu'on repart proprement d'un dépôt tout juste ré-envoyé. (Le garde-fou anti-vidage, lui, a son épreuve à l'échelle dans `unit-datasync` :
       sous dix documents, une suppression reste une suppression.) */
    const listing = () => execFileSync('git', ['-C', nu, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(listing(), /notes\/deploiement-prod\.md/, 'on part d’un dépôt pourvu');

    // On vide le dépôt À LA MAIN, comme on le ferait depuis la forge.
    const vide = path.join(racine, 'vidage');
    execFileSync('git', ['clone', nu, vide], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'checkout', '--orphan', 'neuve'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'rm', '-rf', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, '-c', 'user.name=T', '-c', 'user.email=t@x',
      'commit', '--allow-empty', '-m', 'vidé à la main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', vide, 'push', '-f', 'origin', 'neuve:main'], { stdio: 'ignore' });

    // Une synchro ordinaire ne remet rien — et surtout, elle ne VIDE pas la base.
    /* UNE SYNCHRO ORDINAIRE NE DOIT NI REMETTRE, NI DÉTRUIRE. Le dépôt ne porte plus rien : le
       garde-fou refuse d'appliquer la disparition, même à cette échelle-là — un petit dépôt est
       précisément celui où le seuil de dix ne suffirait pas. */
    const avantPages = app.db.prepare('SELECT COUNT(*) n FROM note_page').get().n;
    await app.api('POST', '/api/data-sync/now');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM note_page').get().n, avantPages,
      'il ne reste RIEN dans le dépôt : c’est un vidage, pas des suppressions');
    const apresSynchro = listing().split('\n').filter((f) => f.trim() && !/^\./.test(f));
    assert.deepEqual(apresSynchro, [],
      'une synchro ordinaire ne remet rien : elle n’envoie que ce qui a CHANGÉ, et rien n’a changé');

    /* Le geste qui remet tout, lui, existe et se nomme. Il passe par le rattachement : un dépôt
       vidé par une branche orpheline n'a plus d'ancêtre commun avec l'historique local, et un
       simple commit suivi d'un push serait refusé. */
    /* CE QUI VA SE PASSER SE LIT AVANT : ajoutés, modifiés, inchangés — et zéro supprimé, qui
       n'est pas une estimation mais une propriété de l'export. */
    const ap = (await app.api('GET', '/api/data-sync/preview')).body;
    assert.equal(ap.ecriture.supprimes, 0, 'l’envoi n’efface rien, jamais');
    assert.ok(ap.ecriture.nouveaux > 0, 'le dépôt est vide : tout est à (re)poser');

    const r = await app.api('POST', '/api/data-sync/reexport');
    assert.equal(r.status, 200);
    const total = Object.values(r.body.compte || {}).reduce((t2, x) => t2 + (Number(x) || 0), 0);
    assert.ok(total > 0, 'il doit avoir réécrit des documents');
    await attendreServeur(async () => listing().split('\n').filter((f) => f.trim() && !/^\./.test(f)).length >= total,
      'tout ce que la base porte de partageable est de retour dans le dépôt');
    assert.match(listing(), /settings\.json/, 'les réglages d’équipe compris');
  });



  /* LE LIEN DU RAPPORT, PLUTÔT QUE LE RAPPORT. (Placé après le vidage ci-dessus : il monte son
     propre décor, il ne dépend de celui de personne.) Six cents lignes recopiées en commentaire de
     merge request, personne ne les lit — et la passe suivante en repose six cents. Le rapport
     est déjà dans le dépôt de données : on en publie l'ADRESSE.
     Ce qui est éprouvé, c'est que le lien MÈNE QUELQUE PART : on relit le fichier dans le dépôt
     NU, celui qui joue la forge. Un lien publié à toute l'équipe et qui rend 404 serait pire
     qu'un commentaire absent — on croirait le travail fait. */
  test('« Publier le lien du rapport » poste une adresse, et le fichier est vraiment dans le dépôt', async () => {
    /* UN VRAI DÉPÔT : la review clone la branche pour en lire le diff. Une URL inventée ferait
       échouer le job, et le test attendrait une version qui ne viendrait jamais. */
    const depot = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'remote-lien-')));
    const { body: repo } = await app.api('POST', '/api/repos', { url: depot.url, project: 'eq/lien' });
    assert.ok(repo && repo.id);
    app.state.mrs['eq/lien'] = [{
      iid: 77, title: 'Publier le lien du rapport', state: 'opened',
      source_branch: depot.branch, target_branch: 'main',
      web_url: 'https://gitlab.test/eq/lien/-/merge_requests/77',
      sha: depot.branchSha, created_at: new Date().toISOString(), author: { name: 'Alice' },
      diff_refs: { base_sha: depot.mainSha, start_sha: depot.mainSha, head_sha: depot.branchSha },
    }];
    app.state.changes['eq/lien!77'] = [{ new_path: 'src/app.js', diff: '@@\n+une ligne\n' }];
    await app.api('POST', '/api/discover');
    const mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 77);
    assert.ok(mr, 'la merge request de ce test doit exister');

    await app.api('POST', `/api/mrs/${mr.id}/review`);
    await attendreServeur(async () => {
      const v = await app.api('GET', `/api/mrs/${mr.id}/versions`);
      return Array.isArray(v.body) && v.body.length > 0;
    }, 'la review a produit une version', 60000);

    /* LE DÉPÔT DE DONNÉES EST UN CHEMIN LOCAL ICI — un dépôt nu dans un dossier temporaire :
       c'est ce qui permet au test de relire son contenu. Un chemin n'a pas d'adresse web, et
       l'application le dit plutôt que d'inventer un lien. On lui donne donc l'adresse qu'aurait
       le même dépôt sur une forge, le temps de cette épreuve : `origin` du clone ne bouge pas
       (il est posé dans sa config git au rattachement), donc la synchro continue de pousser
       dans le dépôt nu — et c'est bien lui qu'on relit à la fin. */
    const urlLocale = (await app.api('GET', '/api/config')).body.data_repo_url;
    await app.api('PUT', '/api/config', { data_repo_url: 'https://gitlab.test/eq/mergerie-data.git' });

    // …et on passe par l'ÉCRAN : c'est le bouton qu'on éprouve, pas la route.
    await page.goto(app.base);
    await page.click('nav button[data-tab="review"]');
    await page.click('[data-seg="reviewed"]');
    await page.waitForSelector('#reportList .card', { timeout: ATTENTE });
    await page.evaluate((id) => window.openReport(id, { force: true }), mr.id);
    await page.waitForSelector('#aMore', { timeout: ATTENTE });
    await page.click('#aMore');
    await page.waitForSelector('#aPublishLink', { timeout: ATTENTE });
    await page.click('#aPublishLink');
    await page.waitForSelector('#confirmModal:not([hidden])', { timeout: ATTENTE });
    /* On attend la RÉPONSE, pas un toast : un toast s'efface au bout de quelques secondes et
       un échec ne laisserait qu'un « délai dépassé » muet. Le corps de la réponse, lui, porte
       la raison du refus — c'est elle qu'on veut lire dans l'échec. */
    const [reponse] = await Promise.all([
      page.waitForResponse((r) => /publish-review-link/.test(r.url()), { timeout: 60000 }),
      page.click('#confirmOk'),
    ]);
    assert.equal(reponse.status(), 200, `la publication doit passer — le serveur a dit : ${await reponse.text()}`);

    // Le commentaire parti est celui que le serveur a enregistré : on le relit en base.
    const dernier = () => app.db
      .prepare('SELECT body FROM comment_log WHERE mr_id = ? ORDER BY id DESC LIMIT 1').get(mr.id);
    await attendreServeur(async () => !!dernier(), 'le commentaire est enregistré', 20000);
    const poste = dernier();
    const lien = (String(poste.body).match(/https?:\/\/\S+/) || [])[0];
    assert.ok(lien, `le commentaire porte une adresse : ${poste.body}`);
    assert.match(lien, /\/-\/blob\/main\/reviews\//, `une adresse de fichier du dépôt de données : ${lien}`);
    assert.ok(!/glpat|oauth2|:\/\/[^/]*@/.test(lien), `et aucun secret dedans : ${lien}`);

    /* LE FICHIER EXISTE-T-IL LÀ-BAS ? On extrait le chemin de l'URL et on le relit dans le
       dépôt NU : c'est la seule preuve que le lien ne mène pas à un 404. */
    const chemin = decodeURI(lien.split('/-/blob/main/')[1]);
    const contenu = execFileSync('git', ['-C', nu, 'show', `main:${chemin}`], { encoding: 'utf8' });
    assert.ok(contenu.trim().length > 0, 'le rapport pointé par le lien est bien dans le dépôt');

    /* LE LIEN PORTE L'UID DE LA PASSE — le fichier du dépôt s'appelle `<uid>.md`. C'est là-dessus
       que repose « déjà publié ? » : sans colonne de plus, on cherche cet uid dans les
       commentaires enregistrés. Le jour où le chemin ne portera plus l'uid, ce test tombe, et
       c'est exactement là qu'il faut le savoir. */
    const uid = app.db.prepare('SELECT uid FROM review_version WHERE mr_id = ? ORDER BY version DESC LIMIT 1').get(mr.id).uid;
    assert.ok(poste.body.includes(uid), `le commentaire porte l’uid de la passe (${uid})`);

    /* ET LE BOUTON LE DIT MAINTENANT. La date est lue dans les commentaires, qui voyagent : un
       collègue qui a publié avant nous doit nous arrêter aussi. */
    await page.evaluate((id) => window.openReport(id, { force: true }), mr.id);
    await page.waitForSelector('#aMore', { timeout: ATTENTE });
    await page.click('#aMore');
    await page.waitForSelector('#aPublishLink', { timeout: ATTENTE });
    const bouton = page.locator('#aPublishLink');
    assert.ok(await bouton.getAttribute('data-posted'), 'le bouton porte la date du premier envoi');
    assert.match(await bouton.textContent(), /Republier/,
      'republier n’est pas une correction : ça pose un SECOND lien vers le même rapport');
    await page.keyboard.press('Escape');

    await app.api('PUT', '/api/config', { data_repo_url: urlLocale });   // les tests suivants retrouvent leur dépôt
  });

  /* LA PUBLICATION AUTOMATIQUE PEUT ENVOYER LE LIEN. Le réglage ne décide pas SI l'auteur est
     prévenu — c'est la case du dessus —, seulement de la FORME : trois lignes qui pointent le
     rapport, plutôt que six cents recopiées à chaque passe.
     Et quand le lien ne peut pas être fait, c'est le RAPPORT qui part : la promesse « préviens
     l'auteur » est tenue, et le journal dit pourquoi la forme a changé. Se taire laisserait une
     review sans destinataire, ce que personne n'a demandé en cochant la case. */
  test('la publication automatique envoie le lien — et retombe sur le rapport s’il n’y a pas d’adresse', async () => {
    const mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 77);
    assert.ok(mr, 'la merge request du test précédent');
    const urlLocale = (await app.api('GET', '/api/config')).body.data_repo_url;
    const compter = () => app.db.prepare('SELECT COUNT(*) n FROM comment_log WHERE mr_id = ?').get(mr.id).n;
    const dernier = () => app.db.prepare('SELECT body FROM comment_log WHERE mr_id = ? ORDER BY id DESC LIMIT 1').get(mr.id).body;

    // 1. dépôt de données avec une adresse web : c'est le LIEN qui part
    await app.api('PUT', '/api/config', {
      auto_post_review: '1', auto_post_review_link: '1',
      data_repo_url: 'https://gitlab.test/eq/mergerie-data.git',
    });
    let avant = compter();
    await app.api('POST', `/api/mrs/${mr.id}/rereview`);
    await attendreServeur(async () => compter() > avant, 'la publication automatique est partie', 90000);
    const parLien = dernier();
    assert.match(parLien, /https:\/\/gitlab\.test\/eq\/mergerie-data\/-\/blob\/main\/reviews\//,
      `c’est l’adresse du rapport qui est postée : ${parLien.slice(0, 200)}`);
    assert.ok(parLien.length < 500, `trois lignes, pas six cents (${parLien.length} caractères)`);

    // 2. dépôt sur un chemin local : pas d'adresse web, donc c'est le RAPPORT qui part
    await app.api('PUT', '/api/config', { data_repo_url: urlLocale });
    avant = compter();
    await app.api('POST', `/api/mrs/${mr.id}/rereview`);
    await attendreServeur(async () => compter() > avant, 'la publication automatique est repartie', 90000);
    const parRapport = dernier();
    assert.doesNotMatch(parRapport, /\/-\/blob\//, 'sans adresse web, il n’y a pas de lien à poster');
    assert.ok(parRapport.length > 200, `c’est le rapport lui-même qui part (${parRapport.length} caractères)`);

    await app.api('PUT', '/api/config', { auto_post_review: '0', auto_post_review_link: '0' });
  });

  /* LE TEXTE EST CELUI DE L'ÉQUIPE. Le gabarit n'est pas une préférence d'affichage : c'est ce
     que des collègues lisent sur leur merge request. On éprouve donc qu'il part MOT POUR MOT,
     variables remplacées — pas qu'il est enregistré, ce que prouve déjà le formulaire. */
  test('le gabarit de l’équipe est le texte qui part sur la merge request', async () => {
    const mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 77);
    const urlLocale = (await app.api('GET', '/api/config')).body.data_repo_url;
    await app.api('PUT', '/api/config', {
      data_repo_url: 'https://gitlab.test/eq/mergerie-data.git',
      review_link_template: 'Review de !{iid} ({project}) — rapport : {url} — note {note}/10',
    });

    const r = await app.api('POST', `/api/mrs/${mr.id}/publish-review-link`);
    assert.equal(r.status, 200, `la publication doit passer : ${r.text}`);
    const corps = app.db.prepare('SELECT body FROM comment_log WHERE mr_id = ? ORDER BY id DESC LIMIT 1').get(mr.id).body;
    assert.match(corps, /^Review de !77 \(eq\/lien\) — rapport : https:\/\/gitlab\.test\/eq\/mergerie-data\/-\/blob\/main\/reviews\//,
      `c’est le texte de l’équipe, pas le message livré : ${corps}`);
    assert.doesNotMatch(corps, /dépôt de données de l’équipe/, 'le message livré ne s’y ajoute pas');

    await app.api('PUT', '/api/config', { data_repo_url: urlLocale, review_link_template: '' });
  });

  /* L'EXÉCUTANT DES AUTOMATISMES OFFRE « L'AUTEUR ». Désigner un poste fait payer une personne
     pour toute l'équipe et suppose qu'elle soit allumée ; « chacun les siennes » met l'abonnement
     de chacun sur son propre travail. C'est un choix de liste, donc il doit être DANS la liste —
     et s'enregistrer depuis le formulaire, pas seulement par l'API. */
  test('« l’auteur de la merge request » est proposé comme exécutant, et s’enregistre', async () => {
    await page.click('nav button[data-tab="admin"]');
    await page.click('button[data-sub="mr"]');
    await page.waitForFunction(() => document.querySelector('#sub-mr').classList.contains('active'),
      null, { timeout: ATTENTE });
    await page.waitForFunction(() => {
      const r = document.querySelector('#autoRunnerRow');
      return r && !r.hidden && document.querySelector('#autoRunnerSelect').options.length > 1;
    }, null, { timeout: ATTENTE });

    const options = await page.locator('#autoRunnerSelect option').evaluateAll(
      (els) => els.map((e) => ({ v: e.value, t: e.textContent })));
    assert.ok(options.some((o) => o.v === ''), '« Personne » reste le premier choix — le défaut sûr');
    const auteur = options.find((o) => o.v === '@auteur');
    assert.ok(auteur, `« l’auteur » est dans la liste : ${JSON.stringify(options)}`);
    assert.match(auteur.t, /auteur|author/i, 'et il se lit, il ne se devine pas');
    assert.equal(options.filter((o) => o.v === '@auteur').length, 1,
      'une seule fois : la sentinelle ne doit pas aussi apparaître comme un nom de poste');

    await page.selectOption('#autoRunnerSelect', '@auteur');
    await page.locator('#sub-mr button[type="submit"][form="configForm"]').first().click();
    await attendreServeur(async () => (await app.api('GET', '/api/config')).body.auto_runner === '@auteur',
      'le choix arrive en base', ATTENTE);

    // …et il revient sélectionné : ce qui est enregistré est aussi ce qui est relu.
    await page.reload();
    await page.click('nav button[data-tab="admin"]');
    await page.click('button[data-sub="mr"]');
    await page.waitForFunction(() => {
      const sel = document.querySelector('#autoRunnerSelect');
      return sel && sel.value === '@auteur';
    }, null, { timeout: ATTENTE });

    await app.api('PUT', '/api/config', { auto_runner: '' });
  });
});
