'use strict';
/* MENU « RÉGLAGES » — CHAQUE CHAMP DE #configForm, SAISI À L'ÉCRAN, ENREGISTRÉ, RELU.
 *
 * Un réglage vit à trois endroits (le formulaire, `CONFIG_FIELDS`, `src/config.js`) et un oubli
 * dans l'un d'eux donne toujours le même symptôme : le champ s'affiche, accepte la saisie, l'écran
 * dit « enregistré »… et la valeur n'est nulle part. Passer par l'API prouverait l'API ; ici, tout
 * part du FORMULAIRE, sous-onglet par sous-onglet, avec le bouton « Enregistrer » de ce
 * sous-onglet. Puis :
 *   1. la valeur est relue depuis l'API (le serveur l'a vraiment retenue) ;
 *   2. la page est rechargée, et chaque champ doit réafficher ce qui est en base.
 * Un second passage inverse toutes les cases : une case qui ne sait que se cocher (« on » au lieu
 * de « 1 », `=== '1'` au lieu de `!== '0'`) est un bug que le premier passage ne voit pas.
 *
 * Les jetons ne redescendent jamais : l'écran relit « *** », la base (local_config) porte le
 * secret, et un enregistrement ultérieur qui renvoie « *** » ne l'efface pas.
 *
 * Un seul `startApp()`, un seul navigateur. Le sous-onglet « Données partagées » passe EN
 * DERNIER : une adresse de dépôt de données fait basculer l'écran en mode « équipe ». */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  startApp, navigateurDispo, lancerNavigateur, MSG_NAVIGATEUR, attendreServeur,
} = require('./helpers/app');

const { dispo } = navigateurDispo();

/* Valeur SAISIE → valeur attendue par l'API. Un booléen = une case à cocher. Les valeurs sont
   choisies DANS les bornes du serveur : ce fichier éprouve l'aller-retour, pas le bornage (qui a
   ses propres tests). L'ordre compte : une case qui déplie ou active un champ passe avant lui. */
const SECRETS = ['access_token', 'github_token', 'jira_token', 'jenkins_token'];

function groupes(app) {
  return [
    { sub: 'gitcfg', champs: [
      ['gitlab_url', 'https://gitlab.reglages.test'],
      ['access_token', 'glpat-reglages-ecran'],
      ['clone_path', path.join(app.dataDir, 'clones-reglages')],
      ['github_url', 'https://github.reglages.test'],
      ['github_token', 'ghp-reglages-ecran'],
    ] },
    { sub: 'mr', details: true, champs: [
      ['review_explain', false],
      ['auto_post_review', true],
      ['auto_post_blocking_only', true],
      ['auto_refresh_minutes', '30'],
      ['auto_review_new', true],
      ['review_auto_max', '7'],
      ['auto_rereview_stale', true],
      ['converge_threshold', '7.5'],
      ['converge_max_passes', '4'],
      ['prompt_review', 'Relis {source} vers {target} ({diff_file}).'],
      ['prompt_explain', 'Explique {source} simplement.'],
      ['prompt_modify', 'Applique : {instruction}'],
      ['prompt_fix', 'Corrige d’après {previous}.'],
    ] },
    { sub: 'verifiers', champs: [
      ['verif_auto_max', '9'],
      ['verif_auto_authors', 'all'],
    ] },
    { sub: 'config', champs: [
      ['task_default_auto_push', true],
      ['task_default_ask_questions', true],
      ['task_default_notify_jira', true],
      ['task_default_converge', true],
      ['retention_days', '30'],
      ['brief_on_open', true],
      ['todo_close_on_merge', false],
      ['stale_mr_days', '12'],
    ] },
    { sub: 'jiracfg', champs: [
      ['jira_url', 'https://jira.reglages.test'],
      ['jira_email', 'moi@reglages.test'],
      ['jira_token', 'ATATT-reglages-ecran'],
      ['jira_watch_minutes', '15'],
      ['verify_jira_comment', true],
      ['jira_test_key', 'PROJ-77'],
    ] },
    { sub: 'jenkinscfg', champs: [
      ['jenkins_url', 'https://jenkins.reglages.test'],
      ['jenkins_user', 'moi.jenkins'],
      ['jenkins_token', 'jk-reglages-ecran'],
      ['jenkins_refresh_minutes', '5'],
    ] },
    { sub: 'aisession', champs: [
      ['ai_extra_instructions', 'Commente en français ; lance les tests avant de committer.'],
      ['agent_auto_max', '25'],
      ['agent_max_turns', '150'],
      ['agent_daily_budget_usd', '2.5'],
    ] },
    { sub: 'datasync', champs: [
      ['data_repo_url', 'https://gitlab.reglages.test/equipe/donnees.git'],
      ['data_repo_branch', 'partage'],
      ['data_sync_seconds', '45'],
      ['usage_share', true],
    ] },
    /* Ce couple n'existe à l'écran qu'avec un dépôt de données (on publie l'ADRESSE du rapport,
       il faut qu'il y ait où pointer) : il passe donc après « Données partagées ». */
    { sub: 'mr', details: true, champs: [
      ['auto_post_review_link', true],
      ['review_link_template', 'Rapport v{v} : {url} — {note}'],
    ] },
  ];
}

describe('Menu Réglages — chaque champ s’enregistre depuis l’écran et se relit', { skip: dispo ? false : MSG_NAVIGATEUR }, () => {
  let app; let navigateur; let page;
  const erreurs = [];

  before(async () => {
    app = await startApp();
    const r = await app.configure();
    assert.equal(r.status, 200, r.text);
    navigateur = await lancerNavigateur();
    page = await navigateur.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(app.base);
    await page.waitForSelector('nav button[data-tab="admin"]');
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
  });

  const config = async () => (await app.api('GET', '/api/config')).body;
  const secretsEnBase = () => app.db.prepare(
    `SELECT ${SECRETS.join(', ')} FROM local_config WHERE id = 1`,
  ).get();

  /* On attend que le chargement du sous-onglet soit revenu AVANT de taper : `loadConfig` repart à
     chaque ouverture, et c'est sa réponse qu'on ne veut pas voir arriver au milieu de la saisie
     (le code s'en garde, mais un test n'a pas à parier sur cette garde). */
  const ouvrir = async (sub, { details = false } = {}) => {
    await page.evaluate(() => document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }));
    await page.locator('nav button[data-tab="admin"]').click();
    await page.locator(`#tab-admin .subnav [data-sub="${sub}"]`).click();
    await page.waitForSelector(`#sub-${sub}.active`);
    await page.waitForSelector(`#sub-${sub} .scope-badge`);
    await page.waitForLoadState('networkidle');
    // Les gabarits de prompt sont repliés sous « avancé » : on les déplie comme l'utilisateur.
    if (details) await page.evaluate((s) => document.querySelectorAll(`#sub-${s} details`).forEach((d) => { d.open = true; }), sub);
  };

  const champ = (nom) => page.locator(`[form="configForm"][name="${nom}"]`);

  async function poser(nom, valeur) {
    const el = champ(nom);
    await el.waitFor({ state: 'visible' });
    if (typeof valeur === 'boolean') { await el.setChecked(valeur); return; }
    const tag = await el.evaluate((e) => e.tagName);
    if (tag === 'SELECT') await el.selectOption(valeur);
    else await el.fill(valeur);
  }

  // Ce que l'écran montre, champ par champ : `checked` pour une case, `value` sinon.
  const lireEcran = (noms) => page.evaluate((ns) => Object.fromEntries(ns.map((n) => {
    const el = document.querySelector(`[form="configForm"][name="${n}"]`);
    if (!el) return [n, '<absent>'];
    return [n, el.type === 'checkbox' ? el.checked : el.value];
  })), noms);

  // Ce que l'écran DOIT montrer après rechargement : un secret revient masqué.
  const attenduEcran = (champs) => Object.fromEntries(champs.map(([n, v]) => [n, SECRETS.includes(n) ? '***' : v]));
  // Ce que l'API doit rendre : une case est « 1 »/« 0 », un nombre est comparé en texte.
  const attenduApi = (champs) => Object.fromEntries(champs.map(([n, v]) => [n,
    SECRETS.includes(n) ? '***' : (typeof v === 'boolean' ? (v ? '1' : '0') : v)]));
  const lireApi = (c, noms) => Object.fromEntries(noms.map((n) => [n, c[n] == null ? '' : String(c[n])]));

  async function enregistrer(g) {
    await ouvrir(g.sub, g);
    for (const [nom, v] of g.champs) await poser(nom, v);
    await page.locator(`#sub-${g.sub} button[type="submit"][form="configForm"]`).first().click();
    const noms = g.champs.map(([n]) => n);
    const attendu = attenduApi(g.champs);
    /* L'EFFET côté serveur, jamais le libellé « Enregistré » : il se confond avec
       « Enregistrement… », et l'autosave peut le produire sans ce clic. */
    await attendreServeur(async () => {
      const c = lireApi(await config(), noms);
      return noms.every((n) => c[n] === attendu[n]);
    }, `les champs de « ${g.sub} » sont en base`).catch(() => {});
    assert.deepEqual(lireApi(await config(), noms), attendu, `ce que le serveur a retenu pour « ${g.sub} »`);
  }

  async function relire(g) {
    await ouvrir(g.sub, g);
    const noms = g.champs.map(([n]) => n);
    const attendu = attenduEcran(g.champs);
    // Le formulaire est peuplé par une réponse asynchrone : on attend qu'il la porte.
    await page.waitForFunction(({ ns, a }) => ns.every((n) => {
      const el = document.querySelector(`[form="configForm"][name="${n}"]`);
      return el && (el.type === 'checkbox' ? el.checked : el.value) === a[n];
    }), { ns: noms, a: attendu }, { timeout: 10000 }).catch(() => {});
    assert.deepEqual(await lireEcran(noms), attendu, `ce que « ${g.sub} » réaffiche après rechargement`);
  }

  test('chaque sous-onglet enregistre ses champs par SON bouton, et le serveur les retient', async () => {
    for (const g of groupes(app)) await enregistrer(g);
  });

  test('les jetons sont en base sur CE poste, jamais renvoyés à l’écran', async () => {
    assert.deepEqual(secretsEnBase(), {
      access_token: 'glpat-reglages-ecran',
      github_token: 'ghp-reglages-ecran',
      jira_token: 'ATATT-reglages-ecran',
      jenkins_token: 'jk-reglages-ecran',
    });
    const c = await config();
    for (const s of SECRETS) assert.equal(c[s], '***', `${s} ne redescend jamais en clair`);
  });

  test('après rechargement, chaque champ réaffiche ce qui est en base', async () => {
    await page.reload();
    await page.waitForSelector('nav button[data-tab="admin"]');
    for (const g of groupes(app)) await relire(g);
  });

  test('ré-enregistrer avec « *** » dans les champs de jeton ne les efface pas', async () => {
    await ouvrir('gitcfg');
    assert.equal(await champ('access_token').inputValue(), '***');
    await champ('clone_path').fill(path.join(app.dataDir, 'clones-bis'));
    await page.locator('#sub-gitcfg button[type="submit"][form="configForm"]').first().click();
    await attendreServeur(async () => (await config()).clone_path === path.join(app.dataDir, 'clones-bis'),
      'le second enregistrement est parti');
    assert.equal(secretsEnBase().access_token, 'glpat-reglages-ecran', 'le masque n’écrase pas le secret');
    assert.equal(secretsEnBase().jira_token, 'ATATT-reglages-ecran', '…ni celui d’un autre sous-onglet');
  });

  /* LE CHEMIN INVERSE. Chaque case est inversée et ré-enregistrée : une case relue en
     `=== '1'` d'un côté et écrite « on » de l'autre revient décochée au rechargement, et
     seul ce second passage le voit. */
  test('toutes les cases s’inversent, s’enregistrent et se relisent inversées', async () => {
    const inverses = [];
    for (const g of groupes(app)) {
      const cases = g.champs.filter(([, v]) => typeof v === 'boolean').map(([n, v]) => [n, !v]);
      if (!cases.length) continue;
      inverses.push({ ...g, champs: cases });
    }
    // Une seule passe par sous-onglet : on regroupe (« mr » apparaît deux fois).
    const parSub = new Map();
    for (const g of inverses) {
      const deja = parSub.get(g.sub);
      if (deja) deja.champs.unshift(...g.champs); else parSub.set(g.sub, { ...g, champs: [...g.champs] });
    }
    /* Dans « mr », « publier le lien » et « seulement si bloquant » vivent SOUS « publier
       automatiquement » : on les décoche avant elle, sinon elles disparaissent de l'écran. */
    const mr = parSub.get('mr');
    const rang = (n) => (['auto_post_review_link', 'auto_post_blocking_only'].includes(n) ? 0 : n === 'auto_post_review' ? 1 : 2);
    mr.champs.sort(([a], [b]) => rang(a) - rang(b));

    for (const g of parSub.values()) await enregistrer(g);
    await page.reload();
    await page.waitForSelector('nav button[data-tab="admin"]');
    for (const g of parSub.values()) {
      /* Les deux cases filles, décochées sous une mère décochée, sont cachées : on relit leur
         état sans exiger qu'elles soient visibles — c'est `lireEcran`, qui lit le DOM. */
      await relire(g);
    }
  });

  test('aucune erreur JavaScript pendant tout le parcours', () => {
    assert.deepEqual(erreurs, []);
  });
});
