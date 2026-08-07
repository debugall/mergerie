'use strict';
/* Enregistre la vidéo de PRÉSENTATION de Mergerie, prête à publier.
 *
 *   node scripts/record-demo.js            (ou : npm run record:demo)
 *
 * Autonome et rejouable : lance l'app EN MODE DÉMO (npm run demo → données fictives seedées,
 * AUCUNE connexion GitLab/Jira/Docker ni token), attend le port, pilote un Chromium qui
 * enregistre en 1920×1080 une visite guidée — faux curseur visible en permanence, cartons et
 * légendes explicatives synchronisés — puis ferme proprement (flush vidéo) et arrête l'app.
 *
 * Le script REFUSE de filmer un serveur qui n'est pas en mode démo (il ne doit jamais capturer
 * de vraies données). Pour l'exécuter à côté d'une instance déjà lancée : DEMO_PORT=<port libre>.
 *
 * Prérequis (installation unique) :
 *   npm i -D playwright && npx playwright install chromium
 *
 * Vidéo écrite dans demo-recordings/mergerie-demo.webm.
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
const OUT_FILE = path.join(OUT_DIR, 'mergerie-demo.webm');
const ROOT = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Habillage injecté dans la page : faux curseur (Playwright ne filme pas celui de l'OS,
// et l'OS n'est pas filmé), + une légende bas-écran et un carton plein écran pilotables. ---
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

// Écrans vides à signaler EN FIN d'exécution plutôt que de filmer du vide.
const warnings = [];
async function present(page, selector, min = 1) {
  try { return (await page.locator(selector).count()) >= min; } catch { return false; }
}
async function need(page, selector, sceneLabel) {
  const ok = await present(page, selector);
  if (!ok) warnings.push(`« ${sceneLabel} » : « ${selector} » absent → écran probablement vide en démo (non filmé)`);
  return ok;
}

// Chaque section est isolée : si un écran change, la vidéo se termine quand même.
// 800 ms de respiration à la fin de chaque écran (rythme humain, jamais de saut brusque).
async function section(name, fn) {
  try { await fn(); await sleep(800); }
  catch (e) { warnings.push(`« ${name} » interrompue : ${e.message}`); console.warn(`  ⚠ section « ${name} » : ${e.message}`); }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) Serveur de démo — obligatoire et vérifié.
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
  console.log('• Mode démo confirmé. Enregistrement…');

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
    locale: 'fr-FR',
    deviceScaleFactor: 1,
  });
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
    await card(page, 'Mergerie', 'From prompt to merge — l’IA exécute, tu valides');
    await sleep(3200);
    await cardHide(page);
    await sleep(800);

    // ═══ 1) Reviews → le rapport de la MR convergée (le moment fort d'abord) ═══
    await section('Reviews · rapport de la MR convergée', async () => {
      await clickEl(page, page.locator('button[data-tab="review"]'));
      await sleep(600);
      await clickEl(page, page.locator('button[data-seg="reviewed"]'));
      await page.waitForSelector('#reportList .card', { state: 'visible', timeout: 10000 });
      await sleep(700);
      await cap(page, 'Chaque MR est reviewée et notée par l’IA — sur des critères cadrés');
      await sleep(900);
      const target = page.locator('#reportList .card', { hasText: 'Refonte du tunnel de paiement' }).first();
      if (!(await need(page, '#reportList .card:has-text("Refonte du tunnel de paiement")', 'MR convergée'))) return;
      await clickEl(page, target);
      await page.waitForSelector('#mdView', { state: 'visible', timeout: 10000 });
      await glide(page, W * 0.5, H * 0.42);
      await sleep(4800);
    });

    // ═══ 2) Boucle « Converger » : v1 → v2 → v3 (1,5 s par version) ═══
    await section('Converger · progression des versions', async () => {
      if (!(await need(page, '#mdVersion', 'Sélecteur de versions'))) return;
      await cap(page, 'Converger : review → correction IA → re-review. De 5,8 à 8,4 en 3 passes, tout l’historique conservé');
      await sleep(900);
      const sel = page.locator('#mdVersion');
      await moveTo(page, sel);
      await sleep(500);
      await sel.selectOption('1'); await sleep(1500);
      await sel.selectOption('2'); await sleep(1500);
      await sel.selectOption('3'); await sleep(1600);
    });

    // ═══ 3) Suivi de résolution ═══
    await section('Suivi de résolution', async () => {
      if (!(await need(page, '#resolutionBox .res-chip', 'Suivi de résolution'))) return;
      await cap(page, 'Chaque constat « résolu » est vérifié dans git — l’IA n’est pas crue sur parole');
      await sleep(900);
      const chips = page.locator('#resolutionBox .res-chip');
      const cn = Math.min(await chips.count(), 4);
      for (let i = 0; i < cn; i += 1) { await moveTo(page, chips.nth(i), 450); await sleep(650); }
      await sleep(1600);
    });

    // ═══ 4) Dev IA : la session qui a produit CETTE MR (du prompt à la MR convergée) ═══
    await section('Dev IA · session reliée à la MR', async () => {
      await clickEl(page, page.locator('button[data-tab="task"]'));
      await sleep(700);
      await cap(page, 'Du prompt à la MR convergée : l’IA code, commit, pousse, ouvre la MR et la fait converger. Le merge reste à toi');
      await sleep(900);
      const linked = page.locator('#taskList .card', { hasText: 'tunnel de paiement' }).first();
      if (await need(page, '#taskList .card:has-text("tunnel de paiement")', 'Session reliée')) {
        await moveTo(page, linked);
        await sleep(4400);
      }
    });

    // ═══ 5) Une session « l'IA pose une question » (needs_input) ═══
    await section('Dev IA · l’IA pose une question', async () => {
      if (!(await need(page, '#taskList .q-opt', 'Session en attente de réponse'))) return;
      await cap(page, 'En cas d’ambiguïté, l’IA s’arrête et te demande — au lieu de deviner');
      await sleep(900);
      const q = page.locator('#taskList .q-opt').first();
      await moveTo(page, q);
      await sleep(4400);
    });

    // ═══ 6) Jira : liste puis détail d'un ticket ═══
    await section('Jira · tickets et détail', async () => {
      await clickEl(page, page.locator('button[data-tab="jira"]'));
      await page.waitForSelector('.jira-item', { state: 'visible', timeout: 10000 });
      await cap(page, 'Tes tickets Jira, leur contexte injecté automatiquement dans les reviews');
      await sleep(900);
      if (!(await need(page, '.jira-item', 'Liste Jira'))) return;
      await clickEl(page, page.locator('.jira-item').first());
      await page.waitForSelector('#jiraDetail', { state: 'visible', timeout: 8000 }).catch(() => {});
      await glide(page, W * 0.62, H * 0.4);
      await sleep(3600);
      const comment = page.locator('.jira-comment').first();
      if (await present(page, '.jira-comment')) { await moveTo(page, comment); await sleep(2200); }
      else await sleep(1400);
    });

    // ═══ 7) Git : explorateur de branches multi-dépôts ═══
    await section('Git · explorateur de branches', async () => {
      await clickEl(page, page.locator('button[data-tab="git"]'));
      await sleep(500);
      await clickEl(page, page.locator('button[data-gsub="explore"]'));
      await cap(page, 'Opérations git sur tous tes dépôts — toujours avec aperçu, suppressions restaurables');
      await sleep(900);
      if (!(await need(page, '#gitExploreRepoBox .git-multi-pick', 'Sélecteur de dépôts'))) return;
      await clickEl(page, page.locator('#gitExploreRepoBox .git-multi-pick').first());
      await sleep(400);
      await clickEl(page, page.locator('#gitExploreGo'));
      await page.waitForSelector('#gitExploreBox .git-ex-project', { state: 'visible', timeout: 10000 });
      await sleep(700);
      await clickEl(page, page.locator('#gitExploreBox .git-ex-project summary').first());
      await page.waitForSelector('#gitExploreBox table', { state: 'visible', timeout: 6000 }).catch(() => {});
      await glide(page, W * 0.5, H * 0.5);
      await sleep(4200);
    });

    /* ═══ 7 bis) Liens : la grille, puis la palette globale ═══
       C'est la fonctionnalité qui se raconte le plus mal en mots et le mieux à l'écran :
       une grille services × environnements, et un lanceur qui trouve tout au clavier. */
    await section('Liens · grille et palette', async () => {
      await clickEl(page, page.locator('button[data-tab="links"]'));
      await page.waitForSelector('.link-grid', { state: 'visible', timeout: 12000 }).catch(() => {});
      if (!(await need(page, '.link-grid', 'Grille de liens'))) return;
      await cap(page, 'Un service par ligne, un environnement par colonne — et l’état de chacun');
      await moveTo(page, page.locator('.link-health.down').first());
      await sleep(1400);
      // La palette : on l'ouvre par son champ, on tape, les résultats tombent.
      await clickEl(page, page.locator('#paletteTrigger'));
      await sleep(500);
      await page.locator('#paletteInput').type('kib', { delay: 140 });
      await sleep(1400);
      await cap(page, 'La palette cherche partout à la fois — liens, MR, tickets, notes');
      await page.keyboard.press('Escape');
      await sleep(700);
    });

    // ═══ 8) Docker : liste compose + drift de variables ═══
    await section('Docker · drift .env', async () => {
      await clickEl(page, page.locator('button[data-tab="docker"]'));
      await page.waitForSelector('#dockerComposeBox .docker-svc', { state: 'visible', timeout: 12000 }).catch(() => {});
      await cap(page, 'Le drift .env détecté variable par variable — secrets masqués');
      await sleep(900);
      // le diff de variables du service en drift (rendu inline sur sa carte)
      await page.waitForSelector('.env-diff', { state: 'visible', timeout: 8000 }).catch(() => {});
      if (!(await need(page, '.env-diff', 'Diff de variables'))) return;
      await moveTo(page, page.locator('.env-diff').first());
      await sleep(1200);
      const chg = page.locator('.env-diff .env-added, .env-diff .env-removed').first();
      if (await present(page, '.env-diff .env-added, .env-diff .env-removed')) { await moveTo(page, chg, 450); }
      await sleep(2600);
    });

    // ═══ 9) Docker → Logs : tail live de 2 containers ═══
    await section('Docker · logs live', async () => {
      await clickEl(page, page.locator('button[data-dsub="logs"]'));
      await page.waitForSelector('#dlogContainers .dlog-citem', { state: 'visible', timeout: 8000 });
      await cap(page, 'Logs live multi-containers, filtrables');
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
      await sleep(gotLines ? 4400 : 1000);
    });

    // ═══ 10) Statistiques : vue d'ensemble ═══
    await section('Statistiques', async () => {
      await clickEl(page, page.locator('button[data-tab="dashboard"]'));
      await page.waitForSelector('#tab-dashboard.active', { state: 'visible', timeout: 8000 }).catch(() => {});
      await cap(page, 'La qualité progresse-t-elle ? Notes, taux de résolution, coût en tokens');
      await sleep(900);
      await glide(page, W * 0.5, H * 0.42);
      await sleep(3600);
      await page.mouse.wheel(0, 520).catch(() => {});
      await sleep(3400);
    });

    // ═══ Carton de fin (≈4 s) ═══
    await capHide(page);
    await sleep(500);
    await card(page, 'Mergerie — npm run demo', `30 secondes pour l’essayer. Aucune config, aucun token\n${REPO_URL}`);
    await sleep(4000);
  } finally {
    const recMs = Date.now() - recStart;
    await context.close(); // flush de la vidéo
    await browser.close();
    if (demo) stopDemo(demo);

    // Renomme le .webm au nom stable.
    try {
      const raw = await video.path();
      if (raw && raw !== OUT_FILE) { fs.rmSync(OUT_FILE, { force: true }); fs.renameSync(raw, OUT_FILE); }
    } catch { /* nom automatique conservé */ }

    const secs = Math.round(recMs / 1000);
    console.log(`\n✓ Vidéo enregistrée : ${path.relative(ROOT, OUT_FILE)}  (~${secs}s)`);
    if (secs < 100 || secs > 200) console.warn(`  ⚠ Durée hors cible 100–200 s (${secs}s).`);
    if (warnings.length) {
      console.warn('\n⚠ Écrans/sections à vérifier :');
      for (const w of warnings) console.warn('   -', w);
    } else {
      console.log('  Tous les écrans attendus ont été filmés.');
    }
  }
}

main().catch((e) => { console.error('\n✗ Échec :', e.message); process.exit(1); });
