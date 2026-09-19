'use strict';
/* LES OBJETS D'ÉQUIPE APRÈS UNE SYNCHRONISATION — Dev IA, Agents, Réglages, sous mes yeux.
 *
 * Claire (seconde instance de Mergerie — `helpers/synchro-collegue`) pose une question libre
 * partagée puis la fait tourner, crée et supprime un agent, crée puis modifie un vérificateur
 * (deux cas où CE poste doit approuver avant que rien ne s'exécute), crée, modifie et supprime une
 * règle de review, change un réglage d'équipe. Ce poste synchronise par le témoin du pied de page
 * sans quitter l'écran qu'il regarde, et l'on attend l'effet :
 *   — Dev IA → Question libre : la carte, son statut, sa réponse, le compteur et le badge du menu ;
 *   — Agents : la carte ET le bloc « à approuver » (ce poste n'exécute rien sans ce clic : un
 *     bloc qui n'apparaît pas, c'est un agent qu'on croit absent ou déjà approuvé) ;
 *   — Réglages → Vérificateurs, Règles, Général.
 * Et le réglage d'équipe va plus loin qu'un affichage périmé : le formulaire des réglages renvoie
 * TOUS ses champs à l'enregistrement, donc une valeur périmée à l'écran REPART, et défait ce que
 * Claire avait décidé.
 *
 * Forme des tests : `helpers/synchro-ecran`. Un seul `startApp()`, un seul navigateur. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, attendreServeur, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR,
} = require('./helpers/app');
const {
  monterEquipe, synchroniserDepuisLePied, exigerQueLEcranSuive,
} = require('./helpers/synchro-ecran');

const { dispo } = navigateurDispo();


describe('Équipe · Dev IA, Agents et Réglages suivent la collègue, après une synchro', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page; let claire;
  const erreurs = [];

  // ---- côté serveur
  const ici = async (route, cle, nom, champ = 'name') => {
    const b = (await app.api('GET', route)).body;
    return (Array.isArray(b) ? b : (b[cle] || [])).find((x) => x[champ] === nom);
  };
  const chezClaire = async (route, cle, nom, champ = 'name') => {
    const b = (await claire.api('GET', route)).body;
    return (Array.isArray(b) ? b : (b[cle] || [])).find((x) => x[champ] === nom);
  };
  const questionIci = (label) => ici('/api/questions', null, label, 'label');
  const agentIci = (nom) => ici('/api/agents', 'agents', nom);
  const verifIci = (nom) => ici('/api/verifiers', 'verifiers', nom);
  const regleIci = (label) => ici('/api/rules', null, label, 'label');
  const ok = (r) => { assert.ok(r.status >= 200 && r.status < 300, r.text); return r.body; };
  async function claireAuRepos() {
    await attendreServeur(async () => {
      const { body } = await claire.api('GET', '/api/jobs/current');
      return body && !body.running && !body.queued;
    }, 'les jobs de Claire sont finis', 60000);
  }
  async function echanger(arrive, quoi) {
    await claire.synchroniser();
    await synchroniserDepuisLePied(page);
    await attendreServeur(arrive, quoi);
  }

  // ---- côté écran
  const fermerModales = () => page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
  const allerQuestions = async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="task"]').click();
    await page.waitForSelector('#tab-task.active');
    await page.locator('#tab-task .subnav [data-kind="ask"]').click();
    await page.waitForFunction(() => document.querySelector('#tab-task .subnav [data-kind="ask"]').classList.contains('active')
      && document.querySelector('#askList').children.length > 0);
  };
  const allerAgents = async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="agents"]').click();
    await page.waitForSelector('#tab-agents.active');
    await page.waitForSelector('#agentList .agent-card');
  };
  const allerReglages = (sub) => async () => {
    await fermerModales();
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
  };
  const recharger = async (aller) => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="task"]');
    await aller();
  };

  before(async () => {
    app = await startApp();
    await app.configure();
    ({ collegue: claire } = await monterEquipe(app));
    /* Une question à moi : la liste « Question libre » n'est jamais vide ici, on sait donc
       quand elle est chargée. */
    ok(await app.api('POST', '/api/questions', { prompt: 'Question du poste', label: 'La mienne' }));

    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="task"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (claire) await claire.stop();
    if (app) await app.stop();
  });

  /* --------------------------------------------------------- Dev IA · questions ---- */

  test('une question partagée de Claire arrive dans la base par le témoin du pied de page', async () => {
    await allerQuestions();
    ok(await claire.api('POST', '/api/questions', { prompt: 'Pourquoi la recette est-elle lente ?', label: 'Lenteur recette', shared: 1 }));
    await claire.synchroniser();
    assert.equal(await questionIci('Lenteur recette'), undefined, 'rien avant la synchro de ce poste');
    await synchroniserDepuisLePied(page);
    const q = await questionIci('Lenteur recette');
    assert.ok(q && q.status === 'new' && q.author === 'Claire', 'la question de Claire est une ligne ici, signée');
    await recharger(allerQuestions);
    await page.waitForSelector(`#askList .card[data-ask="${q.id}"]`);
    assert.deepEqual(erreurs, []);
  });

  test('Question libre ouverte : une NOUVELLE question de Claire apparaît, compteur et badge du menu suivent', async () => {
    await recharger(allerQuestions);
    const avant = await page.evaluate(() => ({
      n: Number(document.querySelector('#kindCountAsk').textContent),
      nav: document.querySelector('#navCountTask').hidden ? 0 : Number(document.querySelector('#navCountTask').textContent),
    }));
    ok(await claire.api('POST', '/api/questions', { prompt: 'Faut-il migrer vers Node 22 ?', label: 'Node 22', shared: 1 }));
    await echanger(async () => Boolean(await questionIci('Node 22')), 'la question est arrivée');
    const q = await questionIci('Node 22');
    await exigerQueLEcranSuive(page, {
      predicat: ({ qid, n, nav }) => Boolean(document.querySelector(`#askList .card[data-ask="${qid}"]`))
        && document.querySelector('#kindCountAsk').textContent.trim() === String(n)
        && document.querySelector('#navCountTask').textContent.trim() === String(nav),
      arg: { qid: q.id, n: avant.n + 1, nav: avant.nav + 1 },
      temoin: () => recharger(allerQuestions),
      bug: 'ni la carte, ni « Question libre N », ni le badge du menu Dev IA ne bougent',
    });
  });

  test('Claire fait tourner sa question : la carte change de statut et propose la réponse', async () => {
    await recharger(allerQuestions);
    const q = await questionIci('Node 22');
    await page.waitForSelector(`#askList .card[data-ask="${q.id}"]`);
    assert.equal(await page.locator(`#askList .card[data-ask="${q.id}"] [data-qmd]`).count(), 0, 'pas encore de réponse');
    const qc = await chezClaire('/api/questions', null, 'Node 22', 'label');
    ok(await claire.api('POST', `/api/questions/${qc.id}/run`));
    await claireAuRepos();
    assert.equal((await claire.api('GET', `/api/questions/${qc.id}`)).body.task.status, 'done', 'la question a tourné chez Claire');
    await echanger(async () => (await questionIci('Node 22')).status === 'done', 'le statut et la réponse sont arrivés');
    await exigerQueLEcranSuive(page, {
      predicat: (qid) => Boolean(document.querySelector(`#askList .card[data-ask="${qid}"] [data-qmd]`)),
      arg: q.id,
      temoin: () => recharger(allerQuestions),
      bug: 'la carte reste « nouvelle », sans « Voir la réponse »',
    });
  });

  test('Claire SUPPRIME sa question : la carte disparaît', async () => {
    await recharger(allerQuestions);
    const q = await questionIci('Lenteur recette');
    await page.waitForSelector(`#askList .card[data-ask="${q.id}"]`);
    const qc = await chezClaire('/api/questions', null, 'Lenteur recette', 'label');
    ok(await claire.api('DELETE', `/api/questions/${qc.id}`));
    await echanger(async () => !(await questionIci('Lenteur recette')), 'la suppression est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (qid) => !document.querySelector(`#askList .card[data-ask="${qid}"]`),
      arg: q.id,
      temoin: () => recharger(allerQuestions),
      bug: 'la question supprimée par Claire reste affichée',
    });
  });

  /* ----------------------------------------------------------------- Agents ---- */

  test('Agents ouverts : l’agent créé par Claire apparaît, AVEC son bloc « à approuver »', async () => {
    await recharger(allerAgents);
    ok(await claire.api('POST', '/api/agents', { name: 'Enquêteur de Claire', kind: 'explore', description: 'Cherche la cause d’un incident' }));
    await echanger(async () => Boolean(await agentIci('Enquêteur de Claire')), 'l’agent est arrivé');
    const a = await agentIci('Enquêteur de Claire');
    assert.equal(a.approval_pending, true, 'venu d’un autre poste, il attend l’approbation de celui-ci');
    await exigerQueLEcranSuive(page, {
      predicat: (aid) => Boolean(document.querySelector(`#agentList .agent-card[data-id="${aid}"] .approval-box .btn-agent-approve`)),
      arg: a.id,
      temoin: () => recharger(allerAgents),
      bug: 'l’agent de Claire — et la demande d’approbation qui va avec — n’apparaissent qu’au rechargement',
    });
  });

  test('Claire SUPPRIME son agent : la carte disparaît', async () => {
    await recharger(allerAgents);
    const a = await agentIci('Enquêteur de Claire');
    await page.waitForSelector(`#agentList .agent-card[data-id="${a.id}"]`);
    const ac = await chezClaire('/api/agents', 'agents', 'Enquêteur de Claire');
    ok(await claire.api('DELETE', `/api/agents/${ac.id}`));
    await echanger(async () => !(await agentIci('Enquêteur de Claire')), 'la suppression est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (aid) => !document.querySelector(`#agentList .agent-card[data-id="${aid}"]`),
      arg: a.id,
      temoin: () => recharger(allerAgents),
      bug: 'l’agent supprimé par Claire reste affiché, bouton « Approuver » compris',
    });
  });

  /* ------------------------------------------------------ Réglages · vérificateurs ---- */

  test('Vérificateurs ouverts : celui que Claire crée apparaît « à approuver »', async () => {
    await recharger(allerReglages('verifiers'));
    ok(await claire.api('POST', '/api/verifiers', { name: 'Lint équipe', kind: 'commands', commands: ['npm run lint'] }));
    await echanger(async () => Boolean(await verifIci('Lint équipe')), 'le vérificateur est arrivé');
    const v = await verifIci('Lint équipe');
    assert.equal(v.approval_pending, true);
    await exigerQueLEcranSuive(page, {
      predicat: (vid) => Boolean(document.querySelector(`#verifierList .card[data-id="${vid}"] [data-vapprove]`)),
      arg: v.id,
      temoin: () => recharger(allerReglages('verifiers')),
      bug: 'le vérificateur de Claire et sa demande d’approbation n’apparaissent qu’au rechargement',
    });
  });

  test('Claire CHANGE la commande d’un vérificateur que j’avais approuvé : l’écran redemande l’approbation', async () => {
    const v = await verifIci('Lint équipe');
    ok(await app.api('POST', `/api/verifiers/${v.id}/approve`, { signature: v.approval_signature }));
    await recharger(allerReglages('verifiers'));
    await page.waitForSelector(`#verifierList .card[data-id="${v.id}"]`);
    assert.equal(await page.locator(`#verifierList .card[data-id="${v.id}"] [data-vapprove]`).count(), 0, 'approuvé : plus de bouton');
    const vc = await chezClaire('/api/verifiers', 'verifiers', 'Lint équipe');
    ok(await claire.api('PUT', `/api/verifiers/${vc.id}`, { name: 'Lint équipe', kind: 'commands', commands: ['npm run lint', 'npm run test:integration'] }));
    await echanger(async () => (await verifIci('Lint équipe')).approval_pending === true, 'la modification est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (vid) => {
        const c = document.querySelector(`#verifierList .card[data-id="${vid}"]`);
        return Boolean(c && c.querySelector('[data-vapprove]') && /test:integration/.test(c.textContent));
      },
      arg: v.id,
      temoin: () => recharger(allerReglages('verifiers')),
      bug: 'le vérificateur reste affiché « approuvé » avec l’ancienne commande, alors que le serveur attend une nouvelle approbation',
    });
  });

  /* ------------------------------------------------------------ Réglages · règles ---- */

  test('Règles ouvertes : la règle créée par Claire apparaît, « par Claire »', async () => {
    await recharger(allerReglages('rules'));
    ok(await claire.api('POST', '/api/rules', { branch_match: 'feature/*', label: 'Migrations', content: 'Chaque migration a son retour arrière.' }));
    await echanger(async () => Boolean(await regleIci('Migrations')), 'la règle est arrivée');
    const r = await regleIci('Migrations');
    await exigerQueLEcranSuive(page, {
      predicat: (rid) => {
        const row = document.querySelector(`#ruleList .repo-row[data-rule="${rid}"]`);
        return Boolean(row && /par Claire/.test(row.textContent));
      },
      arg: r.id,
      temoin: () => recharger(allerReglages('rules')),
      bug: 'la règle de Claire n’apparaît qu’au rechargement',
    });
  });

  test('Claire MODIFIE la règle : le nouveau texte s’affiche', async () => {
    await recharger(allerReglages('rules'));
    const r = await regleIci('Migrations');
    await page.waitForSelector(`#ruleList .repo-row[data-rule="${r.id}"]`);
    const rc = await chezClaire('/api/rules', null, 'Migrations', 'label');
    ok(await claire.api('PUT', `/api/rules/${rc.id}`, { content: 'Chaque migration a son retour arrière ET son test.' }));
    await echanger(async () => /ET son test/.test((await regleIci('Migrations')).content), 'la modification est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (rid) => {
        const row = document.querySelector(`#ruleList .repo-row[data-rule="${rid}"]`);
        return Boolean(row) && (/ET son test/.test(row.textContent)
          || [...row.querySelectorAll('textarea, input')].some((x) => /ET son test/.test(x.value)));
      },
      arg: r.id,
      temoin: () => recharger(allerReglages('rules')),
      bug: 'la règle garde l’ancien texte à l’écran',
    });
  });

  test('Claire SUPPRIME la règle : elle disparaît de la liste', async () => {
    await recharger(allerReglages('rules'));
    const r = await regleIci('Migrations');
    await page.waitForSelector(`#ruleList .repo-row[data-rule="${r.id}"]`);
    const rc = await chezClaire('/api/rules', null, 'Migrations', 'label');
    ok(await claire.api('DELETE', `/api/rules/${rc.id}`));
    await echanger(async () => !(await regleIci('Migrations')), 'la suppression est arrivée');
    await exigerQueLEcranSuive(page, {
      predicat: (rid) => !document.querySelector(`#ruleList .repo-row[data-rule="${rid}"]`),
      arg: r.id,
      temoin: () => recharger(allerReglages('rules')),
      bug: 'la règle supprimée par Claire reste affichée (et modifiable)',
    });
  });

  /* ---------------------------------------------------------- Réglages · Général ---- */

  const champ = (nom) => page.locator(`[form="configForm"][name="${nom}"]`);

  test('Réglages ouverts : un réglage d’ÉQUIPE changé par Claire s’affiche', async () => {
    await recharger(allerReglages('config'));
    await page.waitForFunction(() => document.querySelector('[form="configForm"][name="stale_mr_days"]').value !== ''
      || document.querySelector('[form="configForm"][name="stale_mr_days"]').placeholder !== '');
    const avant = await champ('stale_mr_days').inputValue();
    assert.notEqual(avant, '9');
    ok(await claire.api('PUT', '/api/config', { stale_mr_days: '9' }));
    await echanger(async () => String((await app.api('GET', '/api/config')).body.stale_mr_days) === '9', 'le réglage est arrivé');
    await exigerQueLEcranSuive(page, {
      predicat: () => document.querySelector('[form="configForm"][name="stale_mr_days"]').value === '9',
      temoin: () => recharger(allerReglages('config')),
      bug: 'le champ garde la valeur d’avant la synchro',
    });
  });

  /* LA CONSÉQUENCE : `#configForm` envoie TOUS ses champs (`CONFIG_FIELDS`) à l'enregistrement.
     Un champ resté sur la valeur d'avant la synchro repart donc avec le moindre autre réglage
     enregistré — et la décision d'équipe de Claire est défaite, sans conflit ni message, chez
     tout le monde au tour suivant. */
  test('enregistrer un AUTRE réglage ne défait pas le réglage d’équipe que Claire vient de changer', async () => {
    await recharger(allerReglages('config'));
    await page.waitForFunction(() => document.querySelector('[form="configForm"][name="stale_mr_days"]').value === '9');
    ok(await claire.api('PUT', '/api/config', { stale_mr_days: '12' }));
    await echanger(async () => String((await app.api('GET', '/api/config')).body.stale_mr_days) === '12', 'le nouveau réglage est arrivé');
    // Je change un réglage de CE poste, sur le même écran (ouvrir le brief au lancement), et j'enregistre.
    assert.equal(await champ('brief_on_open').isChecked(), false);
    await champ('brief_on_open').click();
    await page.locator('#sub-config button[form="configForm"][type="submit"]').first().click();
    await attendreServeur(async () => String((await app.api('GET', '/api/config')).body.brief_on_open) === '1', 'mon réglage est enregistré');
    assert.equal(String((await app.api('GET', '/api/config')).body.stale_mr_days), '12',
      'le réglage d’équipe de Claire doit survivre à l’enregistrement d’un autre champ');
  });
});
