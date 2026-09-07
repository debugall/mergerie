'use strict';
/* L'ORDRE DES CHAMPS DU FORMULAIRE DE SESSION, DANS SES QUATRE SAVEURS.
 *
 * Le formulaire est unique et se réarrange par saveur : codage, hors dépôt, exploration,
 * question libre. Il raconte cinq choses, et l'ordre EST le propos —
 *
 *   1. QUOI          le prompt, d'abord : c'est ce que l'utilisateur vient dire, et c'est là
 *                    que se pose le curseur. Le ticket Jira, qui le REMPLIT, se lit juste après ;
 *   2. OÙ            projets et branches, ou répertoire et dossiers (et l'avertissement
 *                    « en place », qui qualifie ce choix-là) ;
 *   3. LE NOM        le libellé — facultatif, et il nomme la carte : après ce qu'il résume ;
 *   4. APRÈS         ce qui change le RÉSULTAT une fois le code écrit : le vérificateur, la
 *                    convergence, l'auto-push. Puis les pièces jointes, qui sont une possibilité ;
 *   5. AVANCÉ        questions de l'IA, message de commit, reprise d'une session d'agent —
 *                    trois champs qu'on ne touche pas une fois sur dix. Regroupés et repliables,
 *                    mais DÉPLIÉS : ils ne coupent plus le parcours principal, ils le ferment.
 *
 * Le bloc gris des projets ouvrait ce formulaire : on choisissait des dépôts avant d'avoir
 * formulé la tâche. Un champ qui remonte ou qui descend d'un cran ne casse rien et ne se voit
 * dans aucun autre test : c'est exactement ce qui laisse un formulaire redevenir une pile de
 * champs.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR } = require('./helpers/app');

const { dispo } = navigateurDispo();

describe('Formulaire de session : l’ordre des champs', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    // Jira configuré : sans lui, la ligne « enrichir depuis un ticket » ne s'affiche pas et
    // le test ne prouverait rien de sa place.
    await app.configure({ jira_url: 'https://jira.test', jira_email: 'moi@test', jira_token: 'x' });
    await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app', project: 'grp/app' });
    const racine = fs.mkdtempSync(path.join(app.dataDir, 'racine-'));
    fs.mkdirSync(path.join(racine, 'outil'), { recursive: true });
    await app.api('POST', '/api/local-roots', { path: racine });

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector('#tab-task .subnav [data-kind="code"]', { state: 'visible' });
  });
  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  /* Ce que l'écran montre, de haut en bas, sans les champs masqués. On désigne chaque bloc par
     son `id` ou le `name` de son champ — un libellé traduit changerait avec la langue, un
     intertitre est identifié par sa CLÉ de traduction pour la même raison. */
  const ordreAffiche = async (kind) => {
    await page.locator(`#tab-task .subnav [data-kind="${kind}"]`).click();
    await page.locator('#btnNewTask').click();
    await page.waitForSelector('#taskModal:not([hidden])');
    const vu = await page.evaluate(() => {
      const out = [];
      const cle = (el) => {
        if (el.dataset && el.classList.contains('form-group-title')) return `groupe:${el.dataset.i18n}`;
        if (el.id) return el.id;
        const champ = el.querySelector('[name]');
        return champ ? champ.name : el.className;
      };
      const marche = (parent) => {
        for (const el of parent.children) {
          if (el.hidden || el.getClientRects().length === 0) continue;
          if (el.id === 'codeOnlyFields') { marche(el); continue; }
          if (el.classList.contains('modal-actions')) continue;
          out.push(cle(el));
        }
      };
      marche(document.querySelector('#taskForm'));
      return out;
    });
    await page.locator('#taskCancel').click();
    await page.waitForSelector('#taskModal[hidden]', { state: 'attached' });
    return vu;
  };

  test('codage : quoi → où → le nom → ce qui change le résultat → avancé', async () => {
    assert.deepEqual(await ordreAffiche('code'), [
      'prompt',                        // QUOI : ce qu'on vient dire ouvre le formulaire
      'taskJiraRow',                   // le ticket le remplit : il se lit contre lui
      'taskReposWrap',                 // OÙ
      'label',                         // LE NOM : facultatif, après ce qu'il résume
      'groupe:task.group.after',       // APRÈS : les décisions qui changent le résultat
      'verifier_id',
      /* La liste des vérificateurs est vide ici (aucun ne couvre le dépôt) : elle DIT pourquoi,
         juste dessous, au lieu de laisser un menu muet. */
      'taskVerifierMissing',
      /* « Prévenir Jira » vit avec les décisions qui portent sur la merge request : il
         n'apparaît qu'en codage, et seulement si Jira est connecté. */
      'taskNotifyJiraRow',
      /* « Reviewer dès la création » précède « converger » : c'est la décision la plus simple
         des deux (un avis sur ce qui vient d'être écrit), et la convergence l'englobe. */
      'taskReviewAfterRow',
      'taskConvergeRow',
      'auto_push',
      'taskImages',                    // une possibilité, pas une étape
      'taskAdvanced',                  // questions, message de commit, session d'agent
    ]);
    assert.deepEqual(erreurs, []);
  });

  /* Hors dépôt : l'avertissement « l'IA modifie en place, sans commit » suit le choix des
     dossiers qu'il qualifie. Lu en bas du formulaire, il arrivait après la décision. */
  test('hors dépôt : l’avertissement suit le choix des dossiers', async () => {
    const ordre = await ordreAffiche('local');
    assert.deepEqual(ordre, [
      'prompt',
      'taskLocalWrap',
      'taskLocalWarn',
      'label',
      'taskImages',
      'taskAdvanced',
    ]);
    assert.equal(ordre[ordre.indexOf('taskLocalWrap') + 1], 'taskLocalWarn',
      '« l’IA modifie en place, sans commit » qualifie le choix des dossiers : il le suit '
      + 'immédiatement, au lieu d’attendre le bas du formulaire');
    assert.ok(!ordre.includes('taskJiraRow'), 'pas de ticket Jira hors dépôt : il n’y a pas de branche');
  });

  test('exploration : rien de ce qui suppose un commit', async () => {
    const ordre = await ordreAffiche('explore');
    assert.deepEqual(ordre, [
      'prompt',
      'taskJiraRow',
      'taskReposWrap',
      'label',
      'taskImages',
      'taskAdvanced',
    ]);
    assert.ok(!ordre.includes('groupe:task.group.after'),
      'une exploration ne commite rien : le groupe entier disparaît, intertitre compris');
  });

  /* La question libre n'a ni cible, ni passe sur un dépôt : il ne reste que la demande. Un
     intertitre « comment l'IA travaille » qui surmonterait le vide serait pire que rien. */
  test('question libre : la demande, et rien d’autre', async () => {
    /* L'accordéon « Avancé » disparaît lui aussi : ses trois champs supposent une cible sur
       laquelle l'agent hésite ou travaille. Un accordéon vide serait pire que rien. */
    assert.deepEqual(await ordreAffiche('ask'), ['prompt', 'label', 'taskImages']);
    assert.deepEqual(erreurs, []);
  });
});
