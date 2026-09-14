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

  const ouvrirGeneral = async () => {
    await page.click('nav button[data-tab="admin"]');
    await page.click('button[data-sub="config"]');
    await page.waitForFunction(() => document.querySelector('#sub-config').classList.contains('active'),
      null, { timeout: ATTENTE });
    await page.waitForSelector('#dataSyncState', { timeout: ATTENTE });
  };

  test('sans dépôt configuré, l’écran le dit et le pied de page se tait', async () => {
    await ouvrirGeneral();
    await page.waitForFunction(() => (document.querySelector('#dataSyncState').textContent || '').length > 0,
      null, { timeout: ATTENTE });
    assert.match(await page.textContent('#dataSyncState'), /mono-poste/);
    assert.equal(await page.locator('#footerSync').isVisible(), false,
      'le mode mono-poste ne doit pas découvrir une fonctionnalité qu’il n’a pas demandée');
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

    await ouvrirGeneral();
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
    await app.api('POST', '/api/notes', { title: 'Bascule équipe', content: 'texte' });
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
