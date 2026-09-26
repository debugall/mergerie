'use strict';
/* DONNÉES PARTAGÉES — CE QUI NE PART JAMAIS, ET CE QUI N'ENTRE PAS SANS UN GESTE.
 *
 * Deux frontières, éprouvées entre DEUX VRAIS POSTES (ce serveur piloté par l'écran, et Claire,
 * seconde instance de Mergerie en processus enfant — `helpers/synchro-collegue`) :
 *
 * 1. CE QUI NE QUITTE PAS CE POSTE. Les jetons saisis À L'ÉCRAN (GitLab, GitHub, Jira, Jenkins),
 *    l'e-mail et l'utilisateur de connexion, les VALEURS d'environnement d'un
 *    vérificateur, les chemins de ce disque (dossier de clonage, dossier d'une session hors
 *    dépôt), les poignées de session d'agent. On ne regarde pas un libellé : on fouille TOUT
 *    l'historique du dépôt nu — un secret commité puis retiré reste dans chaque clone, il faut le
 *    révoquer. Et on vérifie que l'OBJET, lui, a bien voyagé (sinon « rien ne fuit » serait
 *    vrai d'un dépôt vide) : Claire reçoit le vérificateur avec le NOM de sa variable, sans valeur.
 *
 * 2. CE QUI EXÉCUTE DU CODE N'ENTRE PAS SANS APPROBATION. `e2e-approbation` pose l'arrivée en
 *    base à la main ; ici elle vient d'un vrai push de Claire : ses commandes de vérificateur,
 *    les permissions de son agent, sa review automatique et son exécutant attendent un clic SUR
 *    CE POSTE — et l'approbation d'un écran périmé (Claire a encore changé entre l'affichage et
 *    le clic) est refusée à l'écran, puis la version montrée est approuvée. L'approbation ne
 *    voyage pas : approuver n'écrit rien dans le dépôt.
 *
 * Cadence 600 s des deux côtés : chaque synchro est un geste du test. Un seul `startApp()`. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');
const { lancerCollegue } = require('./helpers/synchro-collegue');

const { dispo } = navigateurDispo();

/* Chaque valeur est unique et reconnaissable : la chercher dans l'historique ne peut pas tomber
   sur autre chose. */
const SECRETS = {
  access_token: 'glpat-FUITE-ECRAN-GITLAB',
  github_token: 'ghp-FUITE-ECRAN-GITHUB',
  jira_email: 'fuite-jira@poste.test',
  jira_token: 'ATATT-FUITE-ECRAN-JIRA',
  jenkins_user: 'fuite-jenkins-utilisateur',
  jenkins_token: 'jk-FUITE-ECRAN-JENKINS',
  env: 'postgres://FUITE-VERIF@db.interne/app',
  session_key: 'SESSION-FUITE-POIGNEE',
};

describe('Données partagées · ce qui ne part jamais, ce qui n’entre pas sans un geste', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let racine; let nu; let claire;
  const erreurs = [];

  const gitNu = (...args) => execFileSync('git', ['-C', nu, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const fichiers = () => gitNu('ls-tree', '-r', '--name-only', 'main').split('\n').filter((f) => f.trim());
  const teteNu = () => gitNu('rev-parse', 'main').trim();
  /* TOUT l'historique, toutes branches : le contenu de chaque version de chaque fichier, et les
     messages de commit. `git log -p` montre ce qui a été ajouté ET retiré. */
  const histoireComplete = () => gitNu('log', '--all', '-p', '--format=%H%n%an%n%B');

  before(async () => {
    app = await startApp();
    racine = fs.mkdtempSync(path.join(app.dataDir, 'confiance-'));
    nu = path.join(racine, 'donnees.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', nu], { stdio: 'ignore' });

    await app.configure({ data_repo_url: nu, data_repo_branch: 'main', data_sync_seconds: '600' });
    const r = await app.api('POST', '/api/data-sync/attach', { url: nu });
    assert.equal(r.status, 200, r.text);
    await attendreServeur(async () => Boolean((await app.api('GET', '/api/data-sync')).body.dernierPush), 'le premier envoi');

    claire = await lancerCollegue({ nom: 'Claire', racine });
    await claire.rattacher(nu);
    await claire.synchroniser();

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (claire) await claire.stop();
    if (app) await app.stop();
  });

  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  const ouvrirReglages = async (sub) => {
    await fermerModales();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
    await page.waitForLoadState('networkidle');
  };
  const synchroniser = async () => {
    await ouvrirReglages('datasync');
    const [rep] = await Promise.all([
      page.waitForResponse((r) => /\/api\/data-sync\/now$/.test(r.url()) && r.request().method() === 'POST', { timeout: 60000 }),
      page.locator('#btnDataNow').click(),
    ]);
    assert.equal(rep.status(), 200);
    await page.waitForFunction(() => !document.querySelector('#btnDataNow').disabled);
    const e = (await app.api('GET', '/api/data-sync')).body;
    assert.equal(e.erreur, null, `la synchro de ce poste a échoué : ${e.erreur}`);
  };
  const oublierToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

  /* ------------------------------------------------------------------ 1. rien ne fuit ---- */

  test('les secrets saisis à l’écran, les chemins et les poignées de session ne quittent jamais ce poste', async () => {
    const localCfg = () => app.db.prepare('SELECT * FROM local_config WHERE id = 1').get();
    // Les jetons, PAR LE FORMULAIRE — sous-onglet par sous-onglet, avec son propre bouton.
    const groupes = [
      ['gitcfg', { access_token: SECRETS.access_token, github_url: 'https://github.equipe.test', github_token: SECRETS.github_token,
        clone_path: path.join(app.dataDir, 'CLONES-DE-CE-POSTE') }],
      ['jiracfg', { jira_url: 'https://jira.equipe.test', jira_email: SECRETS.jira_email, jira_token: SECRETS.jira_token }],
      ['jenkinscfg', { jenkins_url: 'https://jenkins.equipe.test', jenkins_user: SECRETS.jenkins_user, jenkins_token: SECRETS.jenkins_token }],
    ];
    for (const [sub, champs] of groupes) {
      await ouvrirReglages(sub);
      for (const [nom, v] of Object.entries(champs)) {
        const el = page.locator(`#sub-${sub} [form="configForm"][name="${nom}"]`);
        await el.waitFor({ state: 'visible' });
        await el.fill(v);
      }
      await page.locator(`#sub-${sub} button[type="submit"][form="configForm"]`).first().click();
      // Les adresses sont d'équipe (table `config`) ; tout le reste de ces champs est de poste.
      await attendreServeur(async () => Object.entries(champs).every(([n, v]) => n.endsWith('_url') || localCfg()[n] === v),
        `les champs de « ${sub} » sont en base, côté poste`);
    }
    // Un vérificateur avec la VALEUR d'une variable, et un réglage d'équipe qui, lui, doit partir.
    const v = await app.api('POST', '/api/verifiers', {
      name: 'Vérif du poste', kind: 'commands', commands: ['npm test'], env: `DATABASE_URL=${SECRETS.env}`, repos: [],
    });
    assert.equal(v.status, 200, v.text);
    await app.api('PUT', '/api/config', { stale_mr_days: '11' });

    // Une session de code partagée, avec la poignée d'agent et le dossier de CE poste.
    const repo = (await app.api('POST', '/api/repos', { url: 'https://gitlab.equipe.test/eq/app.git', project: 'eq/app' })).body;
    const tache = (await app.api('POST', '/api/tasks', {
      kind: 'code', prompt: 'Refonte du panier', targets: [{ repo_id: repo.id, branch: 'ai/panier' }],
    })).body;
    const cible = app.db.prepare('SELECT uid FROM task_target WHERE task_id = ?').get(tache.id);
    // eslint-disable-next-line global-require
    const localsession = require('../src/data/localsession');
    localsession.ecrire('task_target', cible.uid, {
      session_key: SECRETS.session_key, session_backend: 'claude', session_cwd: path.join(app.dataDir, 'CWD-DE-CE-POSTE'),
    });
    await app.api('POST', `/api/tasks/${tache.id}/share`, { shared: 1 });

    // Une session HORS dépôt, partagée : le dossier de ce disque ne part pas, son libellé si.
    const dossier = path.join(app.dataDir, 'DOSSIER-DE-CE-POSTE', 'projet-client');
    fs.mkdirSync(dossier, { recursive: true });
    const hors = await app.api('POST', '/api/local-tasks', { prompt: 'Nettoie les imports', dirs: [dossier], shared: 1 });
    assert.ok(hors.body && hors.body.id, hors.text);

    await synchroniser();
    const uidTache = app.db.prepare('SELECT uid FROM task WHERE id = ?').get(tache.id).uid;
    const uidVerif = app.db.prepare('SELECT uid FROM verifier WHERE id = ?').get(v.body.id).uid;
    const uidHors = app.db.prepare('SELECT uid FROM local_task WHERE id = ?').get(hors.body.id).uid;
    await attendreServeur(async () => {
      const f = fichiers();
      return f.includes(`verifiers/${uidVerif}.json`) && f.includes(`sessions/${uidTache}/session.json`)
        && f.includes(`sessions/${uidHors}/local.json`);
    }, 'le vérificateur et les deux sessions sont dans le dépôt');
    assert.match(gitNu('show', `main:sessions/${uidHors}/local.json`), /projet-client/,
      'le LIBELLÉ du dossier voyage : chez le voisin, la session se relit');

    // CE QUI A VOYAGÉ : l'objet, avec le NOM de la variable et le LIBELLÉ du dossier.
    const docVerif = JSON.parse(gitNu('show', `main:verifiers/${uidVerif}.json`));
    assert.deepEqual(docVerif.env_keys, ['DATABASE_URL'], 'le nom de la variable voyage — le collègue sait quoi renseigner');
    assert.match(gitNu('show', 'main:settings.json'), /"stale_mr_days": "?11"?/, 'le réglage d’équipe, lui, est parti');

    // CE QUI N'A PAS VOYAGÉ : rien, nulle part dans l'histoire.
    const histoire = histoireComplete();
    for (const [nom, valeur] of Object.entries(SECRETS)) {
      assert.ok(!histoire.includes(valeur), `« ${nom} » a fui dans le dépôt de données`);
    }
    for (const chemin of ['CLONES-DE-CE-POSTE', 'CWD-DE-CE-POSTE', 'DOSSIER-DE-CE-POSTE', app.dataDir]) {
      assert.ok(!histoire.includes(chemin), `un chemin de ce disque a fui dans le dépôt : ${chemin}`);
    }
    const reglages = JSON.parse(gitNu('show', 'main:settings.json'));
    for (const cle of ['access_token', 'github_token', 'jira_email', 'jira_token', 'jenkins_user', 'jenkins_token',
      'clone_path', 'data_repo_url', 'data_repo_branch', 'data_sync_seconds']) {
      assert.ok(!(cle in reglages), `settings.json ne porte pas « ${cle} »`);
    }
  });

  test('chez Claire, le vérificateur arrive avec le nom de sa variable, sans valeur — et attend son approbation', async () => {
    /* La liste des dépôts suivis est locale à chacun : Claire ne verra la CIBLE de la session
       (qui désigne son dépôt par sa clé naturelle) que si elle suit elle-même ce dépôt — elle
       l'ajoute donc ici, comme elle le ferait en vrai avant de reprendre une session d'équipe. */
    await claire.api('POST', '/api/repos', { url: 'https://gitlab.equipe.test/eq/app.git', project: 'eq/app' });
    await claire.synchroniser();
    const liste = (await claire.api('GET', '/api/verifiers')).body;
    const recu = liste.find((x) => x.name === 'Vérif du poste');
    assert.ok(recu, 'le vérificateur est arrivé chez Claire');
    assert.deepEqual(recu.env_missing, ['DATABASE_URL'], 'Claire sait quoi renseigner');
    assert.equal(recu.env, 'DATABASE_URL=', 'et elle n’a PAS la valeur');
    assert.equal(recu.approval_pending, true, 'des commandes jamais vues chez elle attendent son geste');
    const session = (await claire.api('GET', '/api/tasks')).body.find((t) => t.prompt === 'Refonte du panier');
    assert.ok(session, 'la session partagée est arrivée chez Claire');
    assert.ok((session.targets || []).length >= 1, `la cible voyage avec la session : ${JSON.stringify(session).slice(0, 300)}`);
    assert.ok(!session.targets.some((t) => t.session_key), 'sans la poignée d’agent de ce poste');
  });

  /* ------------------------------------------------ 2. rien n'entre sans un geste ici ---- */

  test('un vérificateur de Claire : en attente ici, variable manquante signalée, approuvé à l’écran', async () => {
    const cree = await claire.api('POST', '/api/verifiers', {
      name: 'Suite de Claire', kind: 'commands', commands: ['npm ci', 'npm test'], env: 'NPM_TOKEN=npm-FUITE-CLAIRE', repos: [],
    });
    assert.equal(cree.status, 200, cree.text);
    await claire.synchroniser();
    await synchroniser();
    const recu = (await app.api('GET', '/api/verifiers')).body.find((x) => x.name === 'Suite de Claire');
    assert.ok(recu, 'le vérificateur de Claire est arrivé');
    assert.equal(recu.approval_pending, true);
    assert.equal(recu.env, 'NPM_TOKEN=', 'la valeur de Claire n’est pas venue');
    assert.ok(!histoireComplete().includes('npm-FUITE-CLAIRE'), 'ni par le dépôt');

    await ouvrirReglages('verifiers');
    const carte = page.locator(`#verifierList .card[data-id="${recu.id}"]`);
    await carte.locator(`[data-vapprove="${recu.id}"]`).waitFor();
    const texte = await carte.innerText();
    assert.match(texte, /npm ci/, `les commandes à approuver se lisent : ${texte}`);
    assert.match(await carte.locator('.tag.warn[title="NPM_TOKEN"]').innerText(), /1/, 'la variable manquante est signalée');
    await carte.locator(`[data-vapprove="${recu.id}"]`).click();
    await page.waitForSelector(`#verifierList [data-vapprove="${recu.id}"]`, { state: 'detached' });
    assert.equal((await app.api('GET', '/api/verifiers')).body.find((x) => x.id === recu.id).approval_pending, false);
  });

  test('Claire change encore ses commandes pendant qu’on regarde : l’approbation de l’écran périmé est refusée, celle de l’écran à jour passe', async () => {
    const chezElle = (await claire.api('GET', '/api/verifiers')).body.find((x) => x.name === 'Suite de Claire');
    await claire.api('PUT', `/api/verifiers/${chezElle.id}`, { ...chezElle, commands: ['npm ci', 'npm test', 'npm run lint'], repos: [] });
    await claire.synchroniser();
    await synchroniser();
    const recu = (await app.api('GET', '/api/verifiers')).body.find((x) => x.name === 'Suite de Claire');
    assert.equal(recu.approval_pending, true, 'une commande AJOUTÉE redemande le geste');

    // L'écran montre « npm run lint »…
    await ouvrirReglages('verifiers');
    const carte = page.locator(`#verifierList .card[data-id="${recu.id}"]`);
    await carte.locator(`[data-vapprove="${recu.id}"]`).waitFor();
    assert.match(await carte.locator('.approval-box').innerText(), /\+ npm run lint/, 'ce qui change est montré comme tel');

    // …pendant que la synchro apporte ENCORE autre chose, sans redessiner l'écran.
    await claire.api('PUT', `/api/verifiers/${chezElle.id}`, { ...chezElle, commands: ['npm ci', 'npm test', 'npm run lint', 'node scripts/telecharge-et-lance.js'], repos: [] });
    await claire.synchroniser();
    await app.api('POST', '/api/data-sync/now');
    await attendreServeur(async () => (await app.api('GET', '/api/verifiers')).body
      .find((x) => x.id === recu.id).commands.length === 4, 'la dernière version de Claire est arrivée');

    await oublierToasts();
    await carte.locator(`[data-vapprove="${recu.id}"]`).click();
    await page.locator('.toast.err', { hasText: /a changé depuis/ }).first().waitFor();
    assert.equal((await app.api('GET', '/api/verifiers')).body.find((x) => x.id === recu.id).approval_pending, true,
      'la version jamais montrée n’est pas approuvée');

    // L'écran se redessine avec ce qui est arrivé : c'est CELA qu'on approuve.
    await page.waitForFunction((id) => /node scripts\/telecharge-et-lance\.js/.test(
      (document.querySelector(`#verifierList .card[data-id="${id}"] .approval-box`) || {}).textContent || ''), recu.id);
    await page.locator(`#verifierList [data-vapprove="${recu.id}"]`).click();
    await page.waitForSelector(`#verifierList [data-vapprove="${recu.id}"]`, { state: 'detached' });
    assert.equal((await app.api('GET', '/api/verifiers')).body.find((x) => x.id === recu.id).approval_pending, false);
  });

  test('un agent de Claire aux permissions élargies : son lancement est refusé ici tant qu’on ne l’a pas approuvé à l’écran', async () => {
    /* `kind: 'code'` — pas `'explore'` : depuis plan_secure.md (lot A, S3), un profil
       d'exploration ne peut plus porter de `permission_mode` du tout ; l'élévation à éprouver
       ici tient à `allowed_tools_json`, jamais vu de ce côté avant la synchro. */
    const cree = await claire.api('POST', '/api/agents', {
      name: 'Agent de Claire', kind: 'code', scope_kind: 'all_repos', permission_mode: 'acceptEdits', allowed_tools_json: ['Bash'],
    });
    assert.equal(cree.status, 201, cree.text);
    await claire.synchroniser();
    await synchroniser();
    const recu = (await app.api('GET', '/api/agents')).body.find((a) => a.name === 'Agent de Claire');
    assert.ok(recu, 'l’agent de Claire est arrivé');

    const refus = await app.api('POST', `/api/agents/${recu.id}/run`, { mode: 'ask', question: 'x' });
    assert.equal(refus.status, 409, 'un agent jamais vu ici ne tourne pas');
    assert.equal(refus.body.code, 'APPROBATION');

    await fermerModales();
    await page.locator('nav button[data-tab="agents"]').click();
    const carte = page.locator(`#agentList .agent-card[data-id="${recu.id}"]`);
    await carte.locator('.btn-agent-approve').waitFor();
    assert.match(await carte.locator('.approval-box').innerText(), /acceptEdits/, 'la permission se lit avant d’approuver');
    await carte.locator('.btn-agent-approve').click();
    await page.waitForSelector(`#agentList .agent-card[data-id="${recu.id}"] .btn-agent-approve`, { state: 'detached' });
    assert.equal((await app.api('GET', `/api/agents/${recu.id}`)).body.approval_pending, false);
  });

  test('la review automatique et l’exécutant choisis par Claire attendent ici : le bandeau les montre, l’exécutant est sélectionné', async () => {
    const c = await claire.api('PUT', '/api/config', { auto_review_new: '1', auto_runner: 'Claire' });
    assert.equal(c.status, 200, c.text);
    await claire.synchroniser();
    await synchroniser();
    const cfg = (await app.api('GET', '/api/config')).body;
    assert.equal(cfg.auto_review_new, '1', 'le réglage d’équipe est arrivé');
    assert.equal(cfg.auto_runner, 'Claire');
    assert.equal(cfg.auto_approval.pending, true, 'allumé ailleurs : en attente ici');

    await ouvrirReglages('mr');
    await page.waitForSelector('#autoApprovalBanner:not([hidden]) #btnApproveAuto');
    const bandeau = await page.locator('#autoApprovalBanner').innerText();
    assert.match(bandeau, /Claire/, `l’exécutant désigné se lit dans le bandeau : ${bandeau}`);
    assert.match(bandeau, /activée/, `la review automatique aussi : ${bandeau}`);
    await page.waitForFunction(() => {
      const s = document.querySelector('#autoRunnerSelect');
      return s && s.value === 'Claire';
    });
    await page.locator('#btnApproveAuto').click();
    await page.waitForSelector('#autoApprovalBanner[hidden]', { state: 'attached' });
    assert.equal((await app.api('GET', '/api/config')).body.auto_approval.pending, false);
  });

  test('approuver ne voyage pas : rien n’est écrit dans le dépôt, et Claire n’en sait rien', async () => {
    const avant = teteNu();
    await synchroniser();
    assert.equal(teteNu(), avant, 'trois approbations, et pas un commit : elles vivent sur CE poste');
    assert.ok(!/approbation|empreinte/i.test(fichiers().join('\n')), 'aucun fichier d’approbation dans le dépôt');
    // Chez Claire, le vérificateur du poste attend TOUJOURS son geste à elle.
    await claire.synchroniser();
    const chezElle = (await claire.api('GET', '/api/verifiers')).body.find((x) => x.name === 'Vérif du poste');
    assert.equal(chezElle.approval_pending, true, 'approuver chez soi n’approuve rien chez les autres');
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
