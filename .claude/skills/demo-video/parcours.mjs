/* Démonstration réellement filmée : Playwright pilote un vrai Chromium sur l'application,
 * clique pour de bon, et enregistre la page. Rien n'est composé après coup — les transitions,
 * les défilements, les modales et les états de survol sont ceux du navigateur.
 *
 * Le curseur est un calque injecté qui suit les VRAIS événements souris : on ne dessine pas
 * une position supposée, on affiche celle que le navigateur reçoit.
 *
 * Le minutage est enregistré pas à pas (`repere`), et la narration est recollée ensuite à ces
 * repères : la voix ne peut donc pas dériver par rapport à l'image, même si un clic prend
 * 200 ms de plus que prévu.
 */
import { chromium } from '../../../node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ICI = path.dirname(new URL(import.meta.url).pathname);
const URL_APP = 'http://localhost:4321/';
const LARGEUR = 1600, HAUTEUR = 879;
// RAPIDE=1 : on parcourt tout sans tenir la pose, pour vérifier que chaque sélecteur répond.
const RAPIDE = process.env.RAPIDE === '1';
const LANGUE = process.env.LANGUE === 'en' ? 'en' : 'fr';

/* Libellés de l'interface, relevés dans l'application elle-même dans les deux langues.
   Les sélecteurs par texte sont le seul point où la langue transparaît : tout le reste du
   parcours est structurel (ids, position des sous-onglets) et donc identique. */
const LABELS = {
  fr: {
    review: 'Reviewer', diff: 'Voir le diff', context: 'Contexte',
    reviewAll: /Reviewer les \d+ MR/, fetch: 'Chercher les nouvelles',
    dismiss: 'Classer sans review', explanation: 'Explication', openCode: 'Ouvrir le code',
    rerunDelta: 'Relancer (delta)', markDone: 'Marquer traitée', comments: 'Commentaires',
    fixCode: 'Faire corriger le code', converge: 'Converger',
    newSession: 'Nouvelle session', cancel: 'Annuler', collapse: 'Replier les projets',
    push: 'Pousser', createMr: 'Créer la MR', rerunFailed: 'Relancer les projets en échec',
    checkBranches: "Vérifier l'état des branches", answerResume: 'Répondre et reprendre',
    resumeTerminal: 'Reprendre au terminal', distribution: 'Distribution',
    byProject: 'Par projet', devSessions: 'Sessions de dev', preview: 'Prévisualiser',
    checkout: 'Se positionner', analyse: 'Analyser', reconstruct: 'Reconstituer la commande',
    jiraCode: "Faire coder l'IA", bulkAdd: /GitLab/, testConn: /onnexion|onnection/i,
    dark: 'Sombre', phRepo: 'dépôt', phLog: 'expression',
    verify: 'Vérifier',
  },
  en: {
    review: 'Review', diff: 'View diff', context: 'Context',
    reviewAll: /Review \d+ MRs/, fetch: 'Fetch new',
    dismiss: 'Dismiss without review', explanation: 'Explanation', openCode: 'Open the code',
    rerunDelta: 'Re-run (delta)', markDone: 'Mark done', comments: 'MR comments',
    fixCode: 'Have the AI fix the code', converge: 'Converge',
    newSession: 'New coding session', cancel: 'Cancel', collapse: 'Collapse projects',
    push: 'Push', createMr: 'Create MR', rerunFailed: 'Re-run failed projects',
    checkBranches: 'Check branch state', answerResume: 'Answer and resume',
    resumeTerminal: 'Resume in terminal', distribution: 'Score distribution',
    byProject: 'By project', devSessions: 'Dev sessions', preview: 'Preview',
    checkout: 'Check out', analyse: 'Analyse', reconstruct: 'Reconstruct command',
    jiraCode: 'Let the AI code it', bulkAdd: /GitLab/, testConn: /onnexion|onnection/i,
    dark: 'Dark', phRepo: 'repository', phLog: 'phrase',
    verify: 'Verify',
  },
};
const L = LABELS[LANGUE];

const TRAVAIL = path.join(ICI, 'travail');
const SORTIE = path.join(TRAVAIL, `video-brute-${LANGUE}`);
const DUREES = JSON.parse(fs.readFileSync(path.join(TRAVAIL, `durees-${LANGUE}.json`), 'utf8'))
  .map((d) => (RAPIDE ? 0.12 : d));

const GLISSE = 900;      // ms pour amener le curseur sur sa cible
const PAS = 30;          // nombre de positions intermédiaires
const APRES_CLIC = 550;  // ms laissées à l'interface pour réagir

fs.rmSync(SORTIE, { recursive: true, force: true });

const repere = [];       // { i, t } : instant où commence la narration de l'étape i
let t0 = 0;
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const attenue = (t) => 3 * t * t - 2 * t * t * t;

const CURSEUR = () => {
  const poser = () => {
    if (document.getElementById('__curseur')) return;
    const c = document.createElement('div');
    c.id = '__curseur';
    c.innerHTML =
      '<svg width="26" height="32" viewBox="0 0 26 32">' +
      '<path d="M2 2 L2 26 L8.5 19.5 L13 29.5 L17.5 27.5 L13 17.5 L21 17.5 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/></svg>';
    c.style.cssText =
      'position:fixed;left:-50px;top:-50px;z-index:2147483647;pointer-events:none;' +
      'filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))';
    document.documentElement.appendChild(c);

    const style = document.createElement('style');
    style.textContent =
      '@keyframes __onde{from{transform:translate(-50%,-50%) scale(.25);opacity:.85}' +
      'to{transform:translate(-50%,-50%) scale(1);opacity:0}}' +
      '.__onde{position:fixed;width:86px;height:86px;border:4px solid #2563eb;border-radius:50%;' +
      'z-index:2147483646;pointer-events:none;animation:__onde .45s ease-out forwards}';
    document.documentElement.appendChild(style);

    addEventListener('mousemove', (e) => {
      c.style.left = e.clientX + 'px';
      c.style.top = e.clientY + 'px';
    }, true);
    addEventListener('mousedown', (e) => {
      const o = document.createElement('div');
      o.className = '__onde';
      o.style.left = e.clientX + 'px';
      o.style.top = e.clientY + 'px';
      document.documentElement.appendChild(o);
      setTimeout(() => o.remove(), 500);
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', poser);
  else poser();
};

async function principal() {
  const nav = await chromium.launch({ headless: true });
  const ctx = await nav.newContext({
    viewport: { width: LARGEUR, height: HAUTEUR },
    deviceScaleFactor: 1,
    recordVideo: { dir: SORTIE, size: { width: LARGEUR, height: HAUTEUR } },
    locale: LANGUE === 'en' ? 'en-US' : 'fr-FR',
    reducedMotion: 'no-preference',
  });
  // La langue de l'app se choisit avant le premier rendu, comme le fait l'app elle-même.
  await ctx.addInitScript((lang) => {
    try { localStorage.setItem('aidevtools_lang', lang); } catch { /* stockage indisponible */ }
  }, LANGUE);
  const page = await ctx.newPage();
  await page.addInitScript(CURSEUR);
  await page.goto(URL_APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  let sx = LARGEUR / 2, sy = 30;            // le curseur entre par le haut
  await page.mouse.move(sx, sy);

  /* ---------------------------------------------------------------- primitives */

  const loc = (sel) => (typeof sel === 'string' ? page.locator(sel).first() : sel);

  // Amène le curseur au centre d'un élément, en le faisant d'abord entrer dans la vue.
  async function versEl(cible) {
    const l = loc(cible);
    await l.waitFor({ state: 'visible', timeout: 15000 });
    await l.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    const b = await l.boundingBox();
    if (!b) throw new Error('élément sans boîte : ' + cible);
    const x = Math.round(b.x + b.width / 2);
    const y = Math.round(Math.min(Math.max(b.y + b.height / 2, 12), HAUTEUR - 12));
    const dx = sx, dy = sy;
    for (let k = 1; k <= PAS; k++) {
      const t = attenue(k / PAS);
      await page.mouse.move(Math.round(dx + (x - dx) * t), Math.round(dy + (y - dy) * t));
      await dors(GLISSE / PAS);
    }
    sx = x; sy = y;
    return l;
  }

  async function clique(cible) {
    const l = await versEl(cible);
    await page.mouse.down();
    await page.waitForTimeout(90);
    await page.mouse.up();
    await page.waitForTimeout(APRES_CLIC);
    return l;
  }

  /* Une liste déroulante NATIVE est dessinée par le système, hors de la page : Playwright
     n'enregistre que la page, la liste ouverte serait donc invisible dans le film — c'est ce
     qui donnait l'impression d'un clic sans effet. On l'affiche EN PAGE le temps de la
     montrer, avec ses vraies options (`size`), puis on la referme. Aucun contenu inventé :
     ce sont les options du vrai contrôle. */
  async function montreOptions(cible) {
    const l = await versEl(cible);
    const n = await l.evaluate((el) => el.options.length);
    await l.evaluate((el, k) => { el.dataset.tailleAvant = String(el.size || 0); el.size = k; }, Math.min(n, 8));
    await page.waitForTimeout(450);
    return l;
  }
  async function fermeOptions(cible) {
    await loc(cible).evaluate((el) => { el.size = Number(el.dataset.tailleAvant) || 0; delete el.dataset.tailleAvant; });
    await page.waitForTimeout(300);
  }

  async function touche(k) {
    await page.keyboard.press(k);
    await page.waitForTimeout(APRES_CLIC);
  }

  /* Ouvre la fenêtre de narration de l'étape suivante : on note l'instant, puis on tient la
     pose le temps du clip. Le compteur évite d'avoir à renuméroter 76 appels à la main. */
  let iEtape = 0;
  async function dit() {
    iEtape += 1;
    if (iEtape > DUREES.length) throw new Error(`étape ${iEtape} sans narration`);
    repere.push({ i: iEtape, t: Date.now() - t0 });
    await dors(DUREES[iEtape - 1] * 1000);
  }

  // `scope` peut contenir un `>> nth=0` : on chaîne les locators au lieu de concaténer du texte.
  const btn = (scope, nom) => page.locator(scope).locator('button', { hasText: nom }).first();
  const onglet = (t) => page.locator(`nav button[data-tab="${t}"]`).first();
  const sous = (tab, n) => page.locator(`#tab-${tab} > div > button`).nth(n);

  /* Ce que « Voir le diff » et « Contexte » ouvrent n'est pas toujours une .modal :
     le diff s'affiche dans la vue plein écran #splitView. On vise ce qui est ouvert. */
  const ouvert = () => page.locator('#splitView:visible, .modal-box:visible').first();

  async function fermeModale() {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }

  /* ---------------------------------------------------------------- le parcours */

  t0 = Date.now();

  // 1 — vue d'ensemble
  await versEl('nav');
  await dit();

  // Reviews / à traiter
  await clique(onglet('review'));
  await page.locator('[data-seg="to_review"]').first().click();
  await page.waitForTimeout(700);
  const carte = '#toReviewList .card >> nth=0';

  await versEl(carte); await dit();
  await versEl('#tab-review input[type=search]'); await dit();
  await versEl(btn('#toReviewList .card >> nth=0', L.review)); await dit();

  await versEl(btn('#toReviewList .card >> nth=0', L.diff)); await dit();
  await clique(btn('#toReviewList .card >> nth=0', L.diff));
  await versEl(ouvert()); await dit();
  await fermeModale();

  await versEl(btn('#toReviewList .card >> nth=0', L.context)); await dit();
  await clique(btn('#toReviewList .card >> nth=0', L.context));
  await versEl(ouvert()); await dit();
  await fermeModale();

  await versEl(page.locator('button', { hasText: L.reviewAll }).first()); await dit();
  await versEl(page.locator('button', { hasText: L.fetch }).first()); await dit();
  await versEl(btn('#toReviewList .card >> nth=0', L.dismiss)); await dit();

  // Reviews / reviewées
  await versEl('[data-seg="reviewed"]'); await dit();
  await clique('[data-seg="reviewed"]');

  await versEl('#reportDetail'); await dit();
  await versEl('#reportList .card >> nth=2'); await dit();
  await clique('#reportList .card >> nth=2');

  await versEl('#reportDetail'); await dit();
  await versEl(btn('#reportDetail', L.explanation)); await dit();
  await versEl(btn('#reportDetail', L.openCode)); await dit();
  await versEl(btn('#reportDetail', L.rerunDelta)); await dit();
  await versEl(btn('#reportDetail', L.markDone)); await dit();
  await versEl('#reportDetail textarea >> nth=0'); await dit();
  await versEl(page.locator('#reportDetail h2, #reportDetail h3, #reportDetail h4', { hasText: L.comments }).first()); await dit();
  await versEl(btn('#reportDetail', L.fixCode)); await dit();
  await versEl(btn('#reportDetail', L.converge)); await dit();
  await clique(btn('#reportDetail', L.converge));
  await versEl(ouvert()); await dit();
  await fermeModale();
  await versEl('[data-seg="done"]'); await dit();
  await clique('[data-seg="done"]');

  /* ---------- Vérification objective ----------
     La démo sème trois verdicts : un lot passé au vert après correction, et une merge request
     encore rouge, vérifiée par une liste de commandes. On montre donc de VRAIS badges, un vrai
     rapport et la modale de confirmation — jamais un écran qu'on ne sait pas produire. */
  await clique('[data-seg="to_review"]');
  await versEl('#toReviewList .tag.verify'); await dit();   // @@NEW:a1
  await clique(page.locator('#toReviewList .tag.verify.ko[data-vreport]').first());
  await versEl('#verifyReport'); await dit();               // @@NEW:a2
  await versEl('#verifyFix'); await dit();                  // @@NEW:a3
  await fermeModale();
  const btnVerif = page.locator('#toReviewList button:not([disabled])', { hasText: L.verify }).first();
  await versEl(btnVerif); await dit();                      // @@NEW:a4
  await clique(btnVerif);
  await versEl('#verifyPickList'); await dit();             // @@NEW:a5
  await fermeModale();
  await clique('#toReviewList .mr-pick >> nth=0');
  await clique('#toReviewList .mr-pick >> nth=1');
  await versEl('#mrBulkBar'); await dit();                  // @@NEW:a6
  await clique('#btnBulkClear');

  // Dev IA
  await versEl(onglet('task')); await dit();
  await clique(onglet('task'));
  await versEl(sous('task', 1)); await dit();
  await versEl(page.locator('#tab-task button', { hasText: L.newSession }).first()); await dit();
  await clique(page.locator('#tab-task button', { hasText: L.newSession }).first());

  await versEl(`#taskModal input[placeholder*="${L.phRepo}"]`); await dit();
  await versEl('#taskModal textarea >> nth=0'); await dit();
  await versEl('#taskModal input[type=checkbox] >> nth=0'); await dit();
  await versEl(btn('#taskModal', L.converge)); await dit();
  await clique(btn('#taskModal', L.cancel));

  const s1 = '#taskList .card >> nth=0';
  await versEl(s1); await dit();
  /* Sélecteur STRUCTUREL : le libellé du bouton change selon l'état (« Voir les N projets »
     replié, « Replier les projets » déplié) et selon la langue. */
  await versEl('#taskList .targets-toggle'); await dit();
  // …puis on déplie : les actions par projet vivent DANS la liste, invisibles repliées.
  await clique('#taskList .targets-toggle');
  await versEl(btn(s1, L.push)); await dit();
  await versEl(btn(s1, L.createMr)); await dit();
  await versEl(btn(s1, L.rerunFailed)); await dit();
  await versEl(btn(s1, L.checkBranches)); await dit();

  const sq = '#taskList .card >> nth=1';
  await versEl(sq); await dit();
  await versEl(btn(sq, L.answerResume)); await dit();
  await versEl(page.locator('#taskList button', { hasText: L.resumeTerminal }).first()); await dit();

  await clique(sous('task', 1));
  await versEl('#localList .card >> nth=0'); await dit();
  await clique(sous('task', 2));
  await versEl('#taskList .card >> nth=0'); await dit();

  await clique(sous('task', 0));
  await versEl('#lotList .card >> nth=0'); await dit();     // @@NEW:b1

  // Statistiques
  await versEl(onglet('dashboard')); await dit();
  await clique(onglet('dashboard'));
  await versEl(page.locator('#tab-dashboard h2, #tab-dashboard h3, #tab-dashboard h4', { hasText: L.distribution }).first()); await dit();
  await versEl(page.locator('#tab-dashboard h2, #tab-dashboard h3, #tab-dashboard h4', { hasText: L.byProject }).first()); await dit();
  await versEl(page.locator('#tab-dashboard h2, #tab-dashboard h3, #tab-dashboard h4', { hasText: L.devSessions }).first()); await dit();

  // Git
  await versEl(onglet('git')); await dit();
  await clique(onglet('git'));
  await versEl('#tab-git select >> nth=0'); await dit();
  await versEl('#tab-git input[placeholder*="branch"]'); await dit();
  await versEl(page.locator('#tab-git button', { hasText: L.preview }).first()); await dit();

  await clique(sous('git', 1));
  await versEl(page.locator('#tab-git button', { hasText: L.checkout }).first()); await dit();
  await clique(sous('git', 2));
  await versEl('#tab-git input[placeholder*="fetch"]'); await dit();
  await clique(sous('git', 3));
  await versEl(page.locator('#tab-git button', { hasText: L.analyse }).first()); await dit();
  await clique(sous('git', 4));
  await versEl('#tab-git input[placeholder*="v1.2.0"]'); await dit();
  await clique(sous('git', 5));
  await versEl('#tab-git'); await dit();

  // Docker
  await versEl(onglet('docker')); await dit();
  await clique(onglet('docker'));
  await versEl(page.locator('#tab-docker').getByText('DB_POOL_SIZE', { exact: false }).first()); await dit();
  await versEl('#dcState'); await dit();
  await versEl(page.locator('#tab-docker button', { hasText: 'Up' }).first()); await dit();
  await clique(sous('docker', 1));
  await versEl(page.locator('#tab-docker button', { hasText: L.reconstruct }).first()); await dit();
  await clique(sous('docker', 2));
  await versEl(`#tab-docker input[placeholder*="${L.phLog}"]`); await dit();
  await clique(sous('docker', 3));
  await versEl('#dactAction'); await dit();

  // Jira
  await versEl(onglet('jira')); await dit();
  await clique(onglet('jira'));
  await versEl('#tab-jira input[placeholder*="ticket"]'); await dit();
  await versEl(page.locator('#tab-jira button', { hasText: L.jiraCode }).first()); await dit();

  // Réglages
  await versEl(onglet('admin')); await dit();
  await clique(onglet('admin'));
  await clique(sous('admin', 3));
  await versEl('#sub-config select >> nth=0'); await dit();
  await clique(sous('admin', 1));
  await versEl(page.locator('#tab-admin button', { hasText: L.bulkAdd }).first()); await dit();
  await clique(sous('admin', 0));
  await versEl('#tab-admin input[placeholder*="migrations"]'); await dit();
  /* Vérificateurs (7) — l'onglet des sessions d'IA a glissé en 8 quand celui-ci a été
     inséré : un index périmé pointait sur le mauvais panneau sans rien casser. */
  await clique(sous('admin', 7));
  // Le formulaire s'ouvre à la demande depuis peu : sans ce clic, les trois pointages
  // suivants viseraient des champs masqués et le parcours s'arrêterait là.
  await clique('#btnNewVerifier');
  await montreOptions('#verifierForm select[name=kind]'); await dit();   // @@NEW:c1
  await fermeOptions('#verifierForm select[name=kind]');
  await versEl('#verifierCommandList'); await dit();                     // @@NEW:c2
  await versEl('#verifierRepoBox'); await dit();                         // @@NEW:c3
  await clique(sous('admin', 8));
  await versEl('#tab-admin'); await dit();
  await clique(sous('admin', 4));
  await versEl(page.locator('#tab-admin button', { hasText: L.testConn }).first()); await dit();
  await clique(sous('admin', 2));
  await versEl('#notifThreshold'); await dit();

  /* Journal : on lance une vraie recherche de MR (elle rend maintenant un compte propre en
     démo), puis on désigne la barre du bas. On n'ouvre PAS le panneau de logs : il ne se
     déplie qu'à partir d'un job suivi, et aucun n'a tourné ici — le forcer afficherait un
     panneau vide en prétendant montrer l'historique. */
  await clique(onglet('review'));
  await clique(page.locator('button', { hasText: L.fetch }).first());
  await page.waitForTimeout(1800);
  await versEl('.footer-prompt');
  await dit();

  // Palette, raccourcis, thème sombre
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(700);
  await versEl('#paletteModal input'); await dit();
  await fermeModale();
  await page.keyboard.press('?');
  await page.waitForTimeout(700);
  await versEl('#shortcutsModal'); await dit();
  await fermeModale();

  await clique(onglet('admin'));
  await clique(sous('admin', 3));
  const theme = page.locator('#sub-config select').first();
  await montreOptions(theme);
  await fermeOptions(theme);
  await theme.selectOption({ label: L.dark }).catch(() => theme.selectOption({ index: 1 }));
  await page.waitForTimeout(900);
  await clique(onglet('review'));
  await versEl('nav');
  await dit();

  await page.waitForTimeout(2000);
  const fin = Date.now() - t0;

  await ctx.close();
  await nav.close();

  const fichier = fs.readdirSync(SORTIE).find((f) => f.endsWith('.webm'));
  fs.writeFileSync(path.join(TRAVAIL, `reperes-${LANGUE}.json`),
    JSON.stringify({ reperes: repere, fin, video: path.join(SORTIE, fichier) }, null, 1));
  console.log(`vidéo brute : ${fichier}`);
  console.log(`durée pilotée : ${(fin / 1000).toFixed(1)} s · ${repere.length} repères`);
}

principal().catch((e) => { console.error('ÉCHEC :', e.message); process.exit(1); });
