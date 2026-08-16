'use strict';
/* Enregistre la vidéo de PRÉSENTATION de Mergerie, prête à publier — EN FRANÇAIS ET EN ANGLAIS.
 *
 *   npm run record:demo               les deux langues, l'une après l'autre
 *   npm run record:demo -- --lang=en  une seule
 *   DEMO_PORT=4321 npm run record:demo
 *
 * Autonome et rejouable : lance l'app EN MODE DÉMO (npm run demo → données fictives seedées,
 * AUCUNE connexion GitLab/Jira/Docker ni token), attend le port, pilote un Chromium qui
 * enregistre en 1920×1080 une visite guidée — faux curseur visible en permanence, cartons et
 * légendes explicatives synchronisés — puis ferme proprement (flush vidéo) et arrête l'app.
 *
 * Le script REFUSE de filmer un serveur qui n'est pas en mode démo (il ne doit jamais capturer
 * de vraies données). Pour l'exécuter à côté d'une instance déjà lancée : DEMO_PORT=<port libre>.
 *
 * LA LANGUE EST POSÉE AUX DEUX ENDROITS où l'app la lit — `localStorage` pour l'interface, et
 * `config.language` en base pour les messages venus du serveur. N'en poser qu'un donnerait une
 * vidéo anglaise ponctuée de phrases françaises.
 *
 * Prérequis (installation unique) :
 *   npm i -D playwright && npx playwright install chromium
 *
 * Vidéos écrites dans demo-recordings/mergerie-demo-<langue>.webm.
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  console.error('\n✗ Playwright manquant. Installe-le (une seule fois) :\n    npm i -D playwright && npx playwright install chromium\n');
  process.exit(1);
}

const PORT = Number(process.env.DEMO_PORT) || 4319;
const BASE = `http://127.0.0.1:${PORT}`;
const W = 1920; const H = 1080;
// URL du dépôt affichée sur le carton de fin (surchargeable).
const REPO_URL = process.env.REPO_URL || 'github.com/debugall/mergerie';
const OUT_DIR = path.resolve(__dirname, '..', 'demo-recordings');
const ROOT = path.resolve(__dirname, '..');
// La clé que l'app lit dans localStorage pour appliquer la langue avant le premier rendu.
const LANG_KEY = 'aidevtools_lang';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ textes ----
   Une entrée par légende, dans les deux langues. Elles sont réunies ICI et non
   dispersées dans le scénario : c'est la seule façon de voir d'un coup d'œil qu'aucune
   n'a été oubliée d'un côté — le même raisonnement que le contrôle de parité des
   dictionnaires de l'application. */
const TEXTES = {
  fr: {
    locale: 'fr-FR',
    introTitre: 'Mergerie',
    introSous: 'From prompt to merge — l’IA exécute, tu valides',
    review: 'Chaque MR est reviewée et notée par l’IA — sur des critères cadrés',
    converge: 'Converger : review → correction IA → re-review. De 5,8 à 8,4 en 3 passes, tout l’historique conservé',
    resolution: 'Chaque constat « résolu » est vérifié dans git — l’IA n’est pas crue sur parole',
    verif: 'Un vérificateur passe de vraies commandes sur la branche — tests, lint, build. Le verdict ne dépend d’aucun avis',
    verifAuto: 'Coché « automatique », il part tout seul dès qu’une merge request arrive, et le résultat attend sur la carte',
    session: 'Du prompt à la MR convergée : l’IA code, commit, pousse, ouvre la MR et la fait converger. Le merge reste à toi',
    question: 'En cas d’ambiguïté, l’IA s’arrête et te demande — au lieu de deviner',
    briefTitre: 'Notes',
    brief: 'Le brief du matin : ce qui t’attend, rassemblé avant que tu ne le cherches',
    todos: 'Des todos qui se cochent sur place, avec priorité, échéance et lien vers la MR concernée',
    pages: 'Des pages libres en Markdown — les MR et les tickets cités deviennent cliquables tout seuls',
    jira: 'Tes tickets Jira, leur contexte injecté automatiquement dans les reviews',
    git: 'Opérations git sur tous tes dépôts — toujours avec aperçu, suppressions restaurables',
    gitExplore: 'L’explorateur dit ce qu’il fait pendant qu’il travaille, et chaque dépôt se replie',
    liens: 'Un service par ligne, un environnement par colonne — l’adresse écrite, jamais devinée',
    palette: 'La palette cherche partout à la fois — liens, MR, tickets, notes, todos',
    jenkins: 'Tes jobs Jenkins, leur dernier résultat et leurs paramètres — filtrables par dossier, relançables d’ici',
    jenkinsDetail: 'L’historique d’un job run par run, les paramètres de chacun, et le détail à droite',
    docker: 'Le drift .env détecté variable par variable — secrets masqués',
    logs: 'Logs live multi-containers, filtrables',
    stats: 'La qualité progresse-t-elle ? Notes, taux de résolution, coût en tokens',
    sidebar: 'Dix onglets tiennent dans une colonne, qui se replie en icônes quand l’écran manque',
    finTitre: 'Mergerie — npm run demo',
    finSous: (u) => `30 secondes pour l’essayer. Aucune config, aucun token\n${u}`,
  },
  en: {
    locale: 'en-GB',
    introTitre: 'Mergerie',
    introSous: 'From prompt to merge — the AI does the work, you approve it',
    review: 'Every MR is reviewed and scored by the AI — against criteria you set',
    converge: 'Converge: review → AI fix → re-review. From 5.8 to 8.4 in 3 passes, every pass kept',
    resolution: 'Each “resolved” finding is checked against git — the AI is not taken at its word',
    verif: 'A verifier runs real commands on the branch — tests, lint, build. The verdict rests on no one’s opinion',
    verifAuto: 'Tick “automatic” and it fires on its own as soon as a merge request lands, with the result waiting on the card',
    session: 'From prompt to merged-ready MR: the AI codes, commits, pushes, opens the MR and converges it. The merge stays yours',
    question: 'When something is ambiguous the AI stops and asks — instead of guessing',
    briefTitre: 'Notes',
    brief: 'The morning brief: what is waiting for you, gathered before you go looking',
    todos: 'Todos you tick off in place, with priority, due date and a link to the MR they belong to',
    pages: 'Free-form Markdown pages — the MRs and tickets you mention become clickable on their own',
    jira: 'Your Jira tickets, their context fed into reviews automatically',
    git: 'Git operations across every repository — always with a preview, deletions restorable',
    gitExplore: 'The explorer says what it is doing while it works, and each repository folds away',
    liens: 'One service per row, one environment per column — the address written out, never guessed',
    palette: 'The palette searches everything at once — links, MRs, tickets, notes, todos',
    jenkins: 'Your Jenkins jobs, their latest result and their parameters — filter by folder, relaunch from here',
    jenkinsDetail: 'A job’s history run by run, the parameters of each, and the detail on the right',
    docker: '.env drift caught variable by variable — secrets masked',
    logs: 'Live logs across containers, filterable',
    stats: 'Is quality improving? Scores, resolution rate, token cost',
    sidebar: 'Ten tabs fit in one column, which folds down to icons when the screen runs short',
    finTitre: 'Mergerie — npm run demo',
    finSous: (u) => `Thirty seconds to try it. No config, no token\n${u}`,
  },
};

// --- Habillage injecté dans la page : faux curseur (Playwright ne filme pas celui de l'OS,
// et l'OS n'est pas filmé), + une légende bas-écran, un carton plein écran, et un rendu
// visible des listes déroulantes natives — voir __selOpen plus bas. ---
const OVERLAY_JS = `(() => {
  if (window.__demoOverlay) return; window.__demoOverlay = true;
  const S = (el, css) => { el.style.cssText = css; return el; };
  // Curseur ≥ 24px (lisible même sur mobile), toujours au-dessus de tout.
  const dot = S(document.createElement('div'),
    'position:fixed;left:0;top:0;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;background:rgba(59,130,246,.5);border:2px solid #3b82f6;box-shadow:0 0 0 2px rgba(255,255,255,.85),0 3px 12px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;transition:transform .05s linear;');
  const cap = S(document.createElement('div'),
    'position:fixed;left:50%;bottom:56px;transform:translateX(-50%) translateY(14px);max-width:1280px;width:max-content;padding:20px 38px;background:rgba(15,23,42,.93);color:#f8fafc;font:600 32px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border-radius:16px;box-shadow:0 16px 54px rgba(0,0,0,.55);border:1px solid rgba(148,163,184,.28);z-index:2147483200;pointer-events:none;opacity:0;transition:opacity .45s ease,transform .45s ease;text-align:center;');
  const card = S(document.createElement('div'),
    'position:fixed;inset:0;z-index:2147483300;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;background:radial-gradient(ellipse at center,rgba(15,23,42,.95),rgba(2,6,23,.99));opacity:0;transition:opacity .55s ease;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;');
  card.innerHTML = '<div id="__t" style="font-size:74px;font-weight:800;color:#fff;letter-spacing:.5px;text-align:center"></div><div id="__s" style="font-size:32px;color:#93c5fd;font-weight:500;max-width:72%;text-align:center;line-height:1.4;white-space:pre-line"></div>';
  const mount = () => { document.body.append(dot, cap, card); };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  let x = ${W / 2}, y = ${H / 2};
  dot.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; dot.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }, true);
  // Effet visuel au clic : anneau qui pulse là où le curseur se trouve.
  addEventListener('mousedown', () => {
    const r = S(document.createElement('div'),
      'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #60a5fa;z-index:2147483646;pointer-events:none;transform:translate(' + x + 'px,' + y + 'px) scale(.5);opacity:.95;transition:transform .55s ease-out,opacity .55s ease-out;');
    document.body.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(3.6)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 600);
  }, true);
  window.__cap = (t) => { cap.textContent = t; cap.style.opacity = '1'; cap.style.transform = 'translateX(-50%) translateY(0)'; };
  window.__capHide = () => { cap.style.opacity = '0'; cap.style.transform = 'translateX(-50%) translateY(14px)'; };
  window.__card = (t, s) => { card.querySelector('#__t').textContent = t; card.querySelector('#__s').textContent = s || ''; card.style.opacity = '1'; };
  window.__cardHide = () => { card.style.opacity = '0'; };

  /* LISTES DÉROULANTES — le seul élément de l'interface que la caméra ne voyait pas.
     La liste d'un <select> natif est dessinée par le SYSTÈME, hors de la page : Playwright
     filme la page, donc elle n'apparaissait jamais. On voyait le curseur cliquer, puis la
     valeur changer toute seule — le geste le plus incompréhensible de la vidéo.
     On en dessine donc un double DANS la page, aux vraies dimensions et avec les vraies
     options lues sur l'élément. C'est un artifice d'enregistrement, jamais chargé par
     l'application : il vit dans ce script et nulle part ailleurs. */
  let box = null;
  window.__selOpen = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    window.__selClose();
    const r = el.getBoundingClientRect();
    box = S(document.createElement('div'),
      'position:fixed;left:' + r.left + 'px;top:' + (r.bottom + 6) + 'px;min-width:' + Math.max(r.width, 240) + 'px;'
      + 'padding:6px;background:#0f172a;border:1px solid rgba(148,163,184,.45);border-radius:12px;'
      + 'box-shadow:0 22px 60px rgba(0,0,0,.6);z-index:2147483100;pointer-events:none;overflow:hidden;'
      + 'font:500 20px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
      + 'opacity:0;transform:translateY(-6px);transition:opacity .2s ease,transform .2s ease;');
    for (const o of el.options) {
      const it = S(document.createElement('div'),
        'padding:11px 16px;border-radius:8px;color:#e2e8f0;white-space:nowrap;');
      it.textContent = o.textContent;
      it.dataset.v = o.value;
      box.appendChild(it);
    }
    document.body.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = '1'; box.style.transform = 'translateY(0)'; });
    return el.options.length;
  };
  // Met en évidence l'option choisie, comme le ferait le survol dans une vraie liste.
  window.__selPick = (v) => {
    if (!box) return;
    for (const it of box.children) {
      const on = it.dataset.v === String(v);
      it.style.background = on ? '#2563eb' : 'transparent';
      it.style.color = on ? '#fff' : '#e2e8f0';
    }
  };
  window.__selClose = () => {
    if (!box) return;
    const b = box; box = null;
    b.style.opacity = '0';
    setTimeout(() => b.remove(), 220);
  };
})();`;

// --- Cycle de vie du serveur de démo ---
function fetchStatus() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/status`, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
/* La langue du SERVEUR, à part de celle de l'interface : ses messages d'erreur sont affichés
   tels quels. Sans ça, une vidéo anglaise se retrouve ponctuée de phrases françaises. */
function setServerLang(lang) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ language: lang });
    const req = http.request(`${BASE}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode < 400)); });
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}
async function waitForDemo(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await fetchStatus();
    if (st) return st;
    await sleep(500);
  }
  return null;
}
function startDemo() {
  // On force le PORT sur le serveur enfant pour ne jamais entrer en conflit avec une instance
  // déjà lancée (et rester en mode démo isolé : data-demo/, dry-run, sans token).
  const child = spawn('npm', ['run', 'demo'], {
    cwd: ROOT, detached: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
  return child;
}
function stopDemo(child) {
  if (!child || child.killed) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* déjà mort */ }
}

// --- Pilotage : curseur qui glisse (jamais de téléportation), légendes, cartons ---
let px = W / 2; let py = H / 2;
async function glide(page, x, y, ms = 650) {
  const steps = Math.max(14, Math.round(ms / 24));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps; const ease = t * (2 - t); // easeOutQuad
    await page.mouse.move(px + (x - px) * ease, py + (y - py) * ease);
    await sleep(ms / steps);
  }
  px = x; py = y;
}
async function moveTo(page, locator, ms = 650) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    const b = await locator.boundingBox();
    if (!b) return false;
    await glide(page, b.x + b.width / 2, b.y + Math.min(b.height / 2, 60), ms);
    return true;
  } catch { return false; }
}
// Amène le curseur sur un contrôle, marque une pause HUMAINE (300–500 ms) puis clique.
async function clickEl(page, locator) {
  await moveTo(page, locator);
  await sleep(420);
  await locator.click({ timeout: 8000 });
}

const cap = (page, t) => page.evaluate((x) => window.__cap && window.__cap(x), t).catch(() => {});
const capHide = (page) => page.evaluate(() => window.__capHide && window.__capHide()).catch(() => {});
const card = (page, t, s) => page.evaluate(([a, b]) => window.__card && window.__card(a, b), [t, s]).catch(() => {});
const cardHide = (page) => page.evaluate(() => window.__cardHide && window.__cardHide()).catch(() => {});

/* Choisir dans une liste déroulante, VISIBLEMENT : on ouvre le double dessiné dans la page,
   on laisse le temps de lire, on met en évidence l'option, puis on la sélectionne pour de
   vrai. Le spectateur voit le même enchaînement que celui qu'il ferait à la souris. */
async function pickOption(page, selector, valeur, { lire = 850, apres = 500 } = {}) {
  const loc = page.locator(selector);
  await moveTo(page, loc);
  await sleep(300);
  const n = await page.evaluate((s) => window.__selOpen && window.__selOpen(s), selector).catch(() => 0);
  if (!n) { await loc.selectOption(valeur).catch(() => {}); return; }
  await sleep(lire);
  await page.evaluate((v) => window.__selPick && window.__selPick(v), valeur).catch(() => {});
  await sleep(420);
  await loc.selectOption(valeur).catch(() => {});
  await sleep(apres);
  await page.evaluate(() => window.__selClose && window.__selClose()).catch(() => {});
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const demande = (args.find((a) => a.startsWith('--lang=')) || '').split('=')[1] || process.env.DEMO_LANG;
  const langues = demande ? [demande] : ['fr', 'en'];
  for (const l of langues) {
    if (!TEXTES[l]) throw new Error(`Langue inconnue : « ${l} » (attendu : ${Object.keys(TEXTES).join(', ')}).`);
  }

  // 1) Serveur de démo — obligatoire et vérifié. Partagé par les deux enregistrements.
  let demo = null;
  let st = await fetchStatus();
  if (st) {
    if (!st.demo) {
      throw new Error(`Un serveur NON-démo écoute sur ${BASE}. Arrête-le, ou relance avec un port libre : DEMO_PORT=4321 npm run record:demo. (La vidéo ne doit filmer QUE les données de démo.)`);
    }
    console.log('• App démo déjà en écoute sur', BASE, '— on l’utilise.');
  } else {
    console.log('• Démarrage de l’app en mode démo (npm run demo) sur le port', PORT, '…');
    demo = startDemo();
    st = await waitForDemo();
    if (!st) { stopDemo(demo); throw new Error(`Serveur muet sur ${BASE}.`); }
    if (!st.demo) { stopDemo(demo); throw new Error('Le serveur démarré n’est pas en mode démo (MERGERIE_DEMO manquant ?).'); }
  }
  console.log('• Mode démo confirmé.');

  try {
    for (const lang of langues) {
      console.log(`\n• Enregistrement « ${lang} » …`);
      await enregistrer(lang);
    }
  } finally {
    if (demo) stopDemo(demo);
  }
}

async function enregistrer(lang) {
  const T = TEXTES[lang];
  const OUT_FILE = path.join(OUT_DIR, `mergerie-demo-${lang}.webm`);
  const warnings = [];
  px = W / 2; py = H / 2;

  // Écrans vides à signaler EN FIN d'exécution plutôt que de filmer du vide.
  const present = async (page, selector, min = 1) => {
    try { return (await page.locator(selector).count()) >= min; } catch { return false; }
  };
  const need = async (page, selector, sceneLabel) => {
    const ok = await present(page, selector);
    if (!ok) warnings.push(`« ${sceneLabel} » : « ${selector} » absent → écran probablement vide en démo (non filmé)`);
    return ok;
  };
  // Chaque section est isolée : si un écran change, la vidéo se termine quand même.
  // 800 ms de respiration à la fin de chaque écran (rythme humain, jamais de saut brusque).
  const section = async (name, fn) => {
    try { await fn(); await sleep(800); }
    catch (e) { warnings.push(`« ${name} » interrompue : ${e.message}`); console.warn(`  ⚠ section « ${name} » : ${e.message}`); }
  };

  await setServerLang(lang);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
    locale: T.locale,
    deviceScaleFactor: 1,
  });
  /* La langue AVANT le premier rendu : l'app la lit dans localStorage tout en haut de son
     module, plusieurs tables de libellés étant construites à l'évaluation. La poser après
     chargement obligerait à recharger la page — au milieu de la vidéo. */
  await context.addInitScript(([k, v]) => {
    try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ }
  }, [LANG_KEY, lang]);
  await context.addInitScript(OVERLAY_JS);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const video = page.video();
  const recStart = Date.now();

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(OVERLAY_JS).catch(() => {});
    await page.mouse.move(px, py);
    await sleep(400);

    // ═══ Carton d'intro (≈3 s) ═══
    await card(page, T.introTitre, T.introSous);
    await sleep(3200);
    await cardHide(page);
    await sleep(800);

    // ═══ 1) Reviews → le rapport de la MR convergée (le moment fort d'abord) ═══
    await section('Reviews · rapport de la MR convergée', async () => {
      await clickEl(page, page.locator('nav button[data-tab="review"]'));
      await sleep(600);
      await clickEl(page, page.locator('button[data-seg="reviewed"]'));
      await page.waitForSelector('#reportList .card', { state: 'visible', timeout: 10000 });
      await sleep(700);
      await cap(page, T.review);
      await sleep(900);
      const target = page.locator('#reportList .card').first();
      if (!(await need(page, '#reportList .card', 'MR convergée'))) return;
      await clickEl(page, target);
      await page.waitForSelector('#mdView', { state: 'visible', timeout: 10000 });
      await glide(page, W * 0.5, H * 0.42);
      await sleep(4400);
    });

    // ═══ 2) Boucle « Converger » : v1 → v2 → v3, la liste déroulante VISIBLE ═══
    await section('Converger · progression des versions', async () => {
      if (!(await need(page, '#mdVersion', 'Sélecteur de versions'))) return;
      await cap(page, T.converge);
      await sleep(900);
      await pickOption(page, '#mdVersion', '1', { lire: 1100, apres: 1300 });
      await pickOption(page, '#mdVersion', '2', { lire: 500, apres: 1300 });
      await pickOption(page, '#mdVersion', '3', { lire: 500, apres: 1500 });
    });

    // ═══ 3) Suivi de résolution ═══
    await section('Suivi de résolution', async () => {
      if (!(await need(page, '#resolutionBox .res-chip', 'Suivi de résolution'))) return;
      await cap(page, T.resolution);
      await sleep(900);
      const chips = page.locator('#resolutionBox .res-chip');
      const cn = Math.min(await chips.count(), 4);
      for (let i = 0; i < cn; i += 1) { await moveTo(page, chips.nth(i), 450); await sleep(650); }
      await sleep(1600);
    });

    /* ═══ 3 bis) Vérification objective ═══
       La review est un avis d'IA ; le vérificateur, lui, exécute. C'est la réponse à
       « et si l'IA se trompait ? », donc ça se montre à côté du rapport, pas à la fin. */
    await section('Vérification · verdict objectif', async () => {
      await clickEl(page, page.locator('button[data-seg="to_review"]'));
      await page.waitForSelector('#toReviewList .card', { state: 'visible', timeout: 10000 }).catch(() => {});
      if (!(await need(page, '#toReviewList .tag.verify:not(.none)', 'Badge de vérification'))) return;
      await cap(page, T.verif);
      await sleep(900);
      await moveTo(page, page.locator('#toReviewList .tag.verify:not(.none)').first());
      await sleep(2400);
      if (!(await present(page, '#toReviewList [data-vresults]'))) {
        warnings.push('« Vérification » : aucun résultat semé sur une carte (modale non filmée)');
        return;
      }
      await cap(page, T.verifAuto);
      await clickEl(page, page.locator('#toReviewList [data-vresults]').first());
      await page.waitForSelector('#verifyModal .verify-bloc', { state: 'visible', timeout: 8000 }).catch(() => {});
      await glide(page, W * 0.5, H * 0.45);
      await sleep(4200);
      await page.keyboard.press('Escape');
      await sleep(700);
    });

    // ═══ 4) Dev IA : la session qui a produit CETTE MR (du prompt à la MR convergée) ═══
    await section('Dev IA · session reliée à la MR', async () => {
      await clickEl(page, page.locator('nav button[data-tab="task"]'));
      await sleep(700);
      await cap(page, T.session);
      await sleep(900);
      if (await need(page, '#taskList .card', 'Session reliée')) {
        await moveTo(page, page.locator('#taskList .card').first());
        await sleep(4200);
      }
    });

    // ═══ 5) Une session « l'IA pose une question » (needs_input) ═══
    await section('Dev IA · l’IA pose une question', async () => {
      if (!(await need(page, '#taskList .q-opt', 'Session en attente de réponse'))) return;
      await cap(page, T.question);
      await sleep(900);
      await moveTo(page, page.locator('#taskList .q-opt').first());
      await sleep(4000);
    });

    /* ═══ 6) Notes : le brief du matin, les todos, les pages ═══
       L'onglet n'existait pas quand la vidéo précédente a été tournée. C'est aussi le seul
       écran qui rassemble le travail des autres — il mérite ses trois temps. */
    await section('Notes · brief, todos et pages', async () => {
      await clickEl(page, page.locator('nav button[data-tab="notes"]'));
      await page.waitForSelector('#briefBox .brief-sec', { state: 'visible', timeout: 10000 }).catch(() => {});
      if (!(await need(page, '#briefBox .brief-sec', 'Brief du matin'))) return;
      await cap(page, T.brief);
      await sleep(900);
      await glide(page, W * 0.5, H * 0.45);
      await sleep(3800);

      await clickEl(page, page.locator('button[data-nsub="todos"]'));
      await page.waitForSelector('#todoList .todo-row', { state: 'visible', timeout: 8000 }).catch(() => {});
      if (await present(page, '#todoList .todo-row')) {
        await cap(page, T.todos);
        await sleep(700);
        const rows = page.locator('#todoList .todo-row');
        const n = Math.min(await rows.count(), 3);
        for (let i = 0; i < n; i += 1) { await moveTo(page, rows.nth(i), 480); await sleep(700); }
        await sleep(1600);
      } else warnings.push('« Notes · todos » : aucune todo en démo (non filmé)');

      await clickEl(page, page.locator('button[data-nsub="pages"]'));
      await page.waitForSelector('#pageList .note-item', { state: 'visible', timeout: 8000 }).catch(() => {});
      if (await present(page, '#pageList .note-item')) {
        await cap(page, T.pages);
        await sleep(700);
        await clickEl(page, page.locator('#pageList .note-item').first());
        await page.waitForSelector('#pageEditor', { state: 'visible', timeout: 6000 }).catch(() => {});
        await glide(page, W * 0.62, H * 0.45);
        await sleep(3800);
      } else warnings.push('« Notes · pages » : aucune page en démo (non filmé)');
    });

    // ═══ 7) Jira : liste puis détail d'un ticket ═══
    await section('Jira · tickets et détail', async () => {
      await clickEl(page, page.locator('nav button[data-tab="jira"]'));
      await page.waitForSelector('.jira-item', { state: 'visible', timeout: 10000 });
      await cap(page, T.jira);
      await sleep(900);
      if (!(await need(page, '.jira-item', 'Liste Jira'))) return;
      await clickEl(page, page.locator('.jira-item').first());
      await page.waitForSelector('#jiraDetail', { state: 'visible', timeout: 8000 }).catch(() => {});
      await glide(page, W * 0.62, H * 0.4);
      await sleep(3400);
      if (await present(page, '.jira-comment')) { await moveTo(page, page.locator('.jira-comment').first()); await sleep(2000); }
      else await sleep(1400);
    });

    // ═══ 8) Git : explorateur de branches multi-dépôts ═══
    await section('Git · explorateur de branches', async () => {
      await clickEl(page, page.locator('nav button[data-tab="git"]'));
      await sleep(500);
      await clickEl(page, page.locator('button[data-gsub="explore"]'));
      await cap(page, T.git);
      await sleep(900);
      if (!(await need(page, '#gitExploreRepoBox .git-multi-pick', 'Sélecteur de dépôts'))) return;
      await clickEl(page, page.locator('#gitExploreRepoBox .git-multi-pick').first());
      await sleep(400);
      await cap(page, T.gitExplore);
      await clickEl(page, page.locator('#gitExploreGo'));
      await page.waitForSelector('#gitExploreBox .git-ex-project', { state: 'visible', timeout: 10000 });
      await sleep(700);
      await clickEl(page, page.locator('#gitExploreBox .git-ex-project summary').first());
      await page.waitForSelector('#gitExploreBox table', { state: 'visible', timeout: 6000 }).catch(() => {});
      await glide(page, W * 0.5, H * 0.5);
      await sleep(3800);
    });

    /* ═══ 9) Liens : la grille, la santé, puis la palette globale ═══
       C'est la fonctionnalité qui se raconte le plus mal en mots et le mieux à l'écran :
       une grille services × environnements, et un lanceur qui trouve tout au clavier. */
    await section('Liens · grille, santé et palette', async () => {
      await clickEl(page, page.locator('nav button[data-tab="links"]'));
      await page.waitForSelector('.link-grid', { state: 'visible', timeout: 12000 }).catch(() => {});
      if (!(await need(page, '.link-grid', 'Grille de liens'))) return;
      await cap(page, T.liens);
      await sleep(900);
      await glide(page, W * 0.5, H * 0.4);
      await sleep(2400);
      // La palette : on l'ouvre par son champ, on tape, les résultats tombent.
      await clickEl(page, page.locator('#paletteTrigger'));
      await sleep(500);
      await cap(page, T.palette);
      /* « paiement » et non « kib » : c'est le fil rouge de la démo, et le seul mot qui
         ressorte à la fois d'un lien, d'une merge request, d'un ticket surveillé et d'une
         todo. La légende promet que la palette traverse tout le cockpit — autant que
         l'écran le prouve au lieu de rendre deux lignes de la même famille. */
      await page.locator('#paletteInput').type('paiement', { delay: 130 });
      await sleep(2800);
      await page.keyboard.press('Escape');
      await sleep(700);
    });

    // ═══ 10) Docker : liste compose + drift de variables ═══
    await section('Docker · drift .env', async () => {
      await clickEl(page, page.locator('nav button[data-tab="docker"]'));
      await page.waitForSelector('#dockerComposeBox .docker-svc', { state: 'visible', timeout: 12000 }).catch(() => {});
      await cap(page, T.docker);
      await sleep(900);
      // le diff de variables du service en drift (rendu inline sur sa carte)
      await page.waitForSelector('.env-diff', { state: 'visible', timeout: 8000 }).catch(() => {});
      if (!(await need(page, '.env-diff', 'Diff de variables'))) return;
      await moveTo(page, page.locator('.env-diff').first());
      await sleep(1200);
      if (await present(page, '.env-diff .env-added, .env-diff .env-removed')) {
        await moveTo(page, page.locator('.env-diff .env-added, .env-diff .env-removed').first(), 450);
      }
      await sleep(2400);
    });

    // ═══ 11) Docker → Logs : tail live de 2 containers ═══
    await section('Docker · logs live', async () => {
      await clickEl(page, page.locator('button[data-dsub="logs"]'));
      await page.waitForSelector('#dlogContainers .dlog-citem', { state: 'visible', timeout: 8000 });
      await cap(page, T.logs);
      await sleep(900);
      const items = page.locator('#dlogContainers .dlog-citem');
      const n = Math.min(await items.count(), 2);
      if (n === 0) { warnings.push('« Docker · logs » : aucun container en démo (non filmé)'); return; }
      for (let i = 0; i < n; i += 1) { await clickEl(page, items.nth(i)); await sleep(250); }
      await clickEl(page, page.locator('#dlogStart'));
      // on laisse le flux fictif remplir la vue, puis on vérifie qu'il y a bien du contenu.
      await sleep(2600);
      const gotLines = await page.evaluate(() => {
        const v = document.querySelector('#dlogView'); return !!v && v.textContent.trim().length > 20;
      }).catch(() => false);
      if (!gotLines) warnings.push('« Docker · logs » : aucune ligne reçue (flux vide) — écran peu parlant');
      await glide(page, W * 0.5, H * 0.55);
      await sleep(gotLines ? 4000 : 1000);
    });

    // ═══ 12) Statistiques : vue d'ensemble ═══
    /* ═══ 10 bis) Jenkins ═══
       Un onglet entier absent des vidéos précédentes. Le job se voit dans la liste, son
       historique dans la modale — et les paramètres de chaque run, qui sont la raison pour
       laquelle on ouvre un job plutôt que de lire un mail d'échec. */
    await section('Jenkins · jobs et historique', async () => {
      await clickEl(page, page.locator('nav button[data-tab="jenkins"]'));
      await page.waitForSelector('#jenkinsBox .jk-row', { state: 'visible', timeout: 12000 }).catch(() => {});
      if (!(await need(page, '#jenkinsBox .jk-row', 'Liste des jobs Jenkins'))) return;
      await cap(page, T.jenkins);
      await sleep(900);
      const jobs = page.locator('#jenkinsBox .jk-row');
      const nj = Math.min(await jobs.count(), 3);
      for (let i = 0; i < nj; i += 1) { await moveTo(page, jobs.nth(i), 460); await sleep(650); }
      await sleep(1400);

      /* UN JOB PARAMÉTRÉ, pas le premier de la liste. La légende annonce « les paramètres de
         chacun » : ouvert sur un job qui n'en a pas, l'écran dit « cette exécution est partie
         sans paramètre » pendant qu'on affirme le contraire. */
      await cap(page, T.jenkinsDetail);
      const parametre = page.locator('#jenkinsBox .jk-row[data-jkjob="boutique/api-deploy-prod"]');
      const cible = (await parametre.count()) ? parametre.first() : jobs.first();
      if (!(await parametre.count())) warnings.push('« Jenkins · historique » : job paramétré absent, ouvert sur le premier de la liste');
      await clickEl(page, cible);
      await page.waitForSelector('#jenkinsFiche', { state: 'visible', timeout: 10000 }).catch(() => {});
      await sleep(1200);
      await glide(page, W * 0.35, H * 0.5);
      await sleep(2600);
      await glide(page, W * 0.7, H * 0.5);
      await sleep(3200);
      await page.keyboard.press('Escape');
      await sleep(700);
    });

    await section('Statistiques', async () => {
      await clickEl(page, page.locator('nav button[data-tab="dashboard"]'));
      await page.waitForSelector('#tab-dashboard.active', { state: 'visible', timeout: 8000 }).catch(() => {});
      await cap(page, T.stats);
      await sleep(900);
      await glide(page, W * 0.5, H * 0.42);
      await sleep(3400);
      await page.mouse.wheel(0, 520).catch(() => {});
      await sleep(3200);
    });

    /* ═══ 13) La colonne de navigation, qui se replie ═══
       Dernier plan avant le carton : il montre l'app entière d'un coup, et le geste explique
       à lui seul pourquoi la navigation a quitté le bandeau du haut. */
    await section('Navigation · la colonne se replie', async () => {
      if (!(await need(page, '#sidebarToggle', 'Bouton de repli'))) return;
      /* REMONTER D'ABORD. L'écran précédent s'est terminé en bas de page ; sans ça, le
         dernier plan de la vidéo — celui qui montre l'application entière — se jouait sur
         une zone blanche, et l'outil avait l'air vide au moment de conclure. */
      await page.mouse.wheel(0, -3000).catch(() => {});
      await sleep(900);
      await cap(page, T.sidebar);
      await sleep(900);
      await clickEl(page, page.locator('#sidebarToggle'));
      await sleep(2200);
      await clickEl(page, page.locator('#sidebarToggle'));
      await sleep(1400);
    });

    // ═══ Carton de fin (≈4 s) ═══
    await capHide(page);
    await sleep(500);
    await card(page, T.finTitre, T.finSous(REPO_URL));
    await sleep(4000);
  } finally {
    const recMs = Date.now() - recStart;
    await context.close(); // flush de la vidéo
    await browser.close();

    // Renomme le .webm au nom stable de la langue.
    try {
      const raw = await video.path();
      if (raw && raw !== OUT_FILE) { fs.rmSync(OUT_FILE, { force: true }); fs.renameSync(raw, OUT_FILE); }
    } catch { /* nom automatique conservé */ }

    const secs = Math.round(recMs / 1000);
    console.log(`  ✓ ${path.relative(ROOT, OUT_FILE)}  (~${secs}s)`);
    if (secs < 150 || secs > 300) console.warn(`  ⚠ Durée hors cible 150–300 s (${secs}s).`);
    if (warnings.length) {
      console.warn('  ⚠ Écrans/sections à vérifier :');
      for (const w of warnings) console.warn('     -', w);
    } else {
      console.log('    Tous les écrans attendus ont été filmés.');
    }
  }
}

main().catch((e) => { console.error('\n✗ Échec :', e.message); process.exit(1); });
