'use strict';
/* LE CONTRASTE, MESURÉ PLUTÔT QU'ESPÉRÉ.
 *
 * L'application a deux thèmes et une palette de couleurs sémantiques, et le motif le plus
 * courant de son interface — une couleur de marque posée sur un fond teinté de cette MÊME
 * couleur — se lit très bien en gros et échoue en petit. Dix-neuf libellés de 10 à 12 px
 * étaient sous les 4,5:1 exigés par WCAG AA en thème clair, sans que rien ne le signale : le
 * dark mode passait, les captures étaient jolies, et personne ne calculait.
 *
 * Ce fichier calcule. Il parcourt les dix onglets dans les deux thèmes, compose les fonds
 * semi-transparents jusqu'à la racine (un `color-mix(... 14%, transparent)` ne se lit pas sans
 * ce qu'il y a dessous) et refuse tout texte visible sous son seuil.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startApp } = require('./helpers/app');

let chromium = null;
let dispo = false;
try {
  ({ chromium } = require('playwright'));
  dispo = fs.existsSync(chromium.executablePath());
} catch { /* playwright absent */ }

/* La sonde tourne DANS la page : elle a besoin des styles calculés, que seul le navigateur
   connaît. Rendue en chaîne parce qu'elle est passée à `page.evaluate`. */
const SONDE = `(() => {
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
  const compose = (fg, bg) => { const a = fg[3] === undefined ? 1 : fg[3]; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
  const fondDe = (el) => {
    const pile = []; let e = el;
    while (e) { const p = parse(getComputedStyle(e).backgroundColor); if (p.length >= 3) pile.push(p); e = e.parentElement; }
    let bg = [255, 255, 255];
    for (const p of pile.reverse()) bg = compose(p, bg);
    return bg;
  };
  const out = [];
  let vus = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (!txt) continue;
    vus += 1;
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize);
    // WCAG : 3:1 pour du « grand texte » (24px, ou 18.66px en gras), 4.5:1 sinon.
    const seuil = (px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700)) ? 3 : 4.5;
    const bg = fondDe(el);
    const fg = compose(parse(cs.color), bg);
    const a = lum(fg); const b = lum(bg);
    const r = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    if (r < seuil) out.push({ txt: txt.slice(0, 34), sel: String(el.className || el.tagName).slice(0, 40), px, r, seuil });
  }
  return { vus, sous: out };
})()`;

/* Le témoin de chaque onglet : ce qu'il faut avoir vu pour dire qu'il a fini de se peindre.
   « Il y a du texte » ne suffit pas — la chrome est là tout de suite, les DONNÉES arrivent
   après, et ce sont elles qui portent les couleurs qu'on mesure (puces d'état, statuts,
   étiquettes). Sans ces témoins, la sonde ne voyait que des menus et rendait toujours vert. */
const ONGLETS = [
  ['notes', '#briefBox'],
  ['review', null],
  ['task', '#taskList .card'],
  ['git', null],
  ['docker', '.docker-svc'],
  ['jenkins', '#jenkinsBox .jk-row'],
  ['jira', '#jiraList .jira-item'],
  ['links', null],
  ['dashboard', '.dash-card'],
  ['admin', null],
];

describe('Contraste WCAG AA', { skip: dispo ? false : 'chromium absent — npx playwright install chromium' }, () => {
  let app;
  let navigateur;

  before(async () => {
    /* MODE DÉMO : sans lui, un serveur de test neuf a des onglets vides et la sonde ne mesure
       presque rien — le test passerait pour de mauvaises raisons. Les jeux statiques de
       `demo-docker`, `demo-jira` et `demo-jenkins` peuplent précisément les écrans qui
       portaient les fautes (puces d'état, statuts, paramètres de job). */
    process.env.MERGERIE_DEMO = '1';
    app = await startApp();
    /* La dictée ALLUMÉE : son panneau de diagnostic est fait de couleurs sémantiques posées sur
       des fonds teintés de la même couleur — vert « prêt », rouge « installation incomplète »,
       remède en rouge sur fond de panneau —, c'est-à-dire exactement le motif que ce fichier
       existe pour mesurer. Éteinte, le panneau reste vide et n'est jamais éprouvé. */
    await app.configure({ dictation_provider: 'local' });
    /* Des sessions dans les états qui PORTENT les couleurs : « poussée » (vert), « en attente
       de réponses » (accent) et « erreur » (rouge) étaient trois des libellés sous le seuil. */
    const repo = app.db.prepare("INSERT INTO repo (project, url, enabled) VALUES ('grp/app', 'https://x.test/a.git', 1)").run().lastInsertRowid;
    const now = new Date().toISOString();
    for (const [statut, err] of [['pushed', null], ['needs_input', null], ['error', 'push refusé : la branche a divergé']]) {
      app.db.prepare(`INSERT INTO task (repo_id, prompt, branch, kind, status, last_error, created_at, updated_at)
        VALUES (?, ?, ?, 'code', ?, ?, ?, ?)`).run(repo, `Session ${statut}`, `feat/${statut}`, statut, err, now, now);
    }
    navigateur = await chromium.launch();
  });

  after(async () => {
    if (navigateur) await navigateur.close();
    if (app) await app.stop();
    delete process.env.MERGERIE_DEMO;
  });

  for (const theme of ['light', 'dark']) {
    test(`aucun texte sous son seuil — thème ${theme}`, async () => {
      const page = await navigateur.newPage({ viewport: { width: 1500, height: 950 } });
      await page.goto(app.base);
      await page.evaluate((t) => localStorage.setItem('aidevtools_theme', t), theme);
      await page.reload();
      await page.waitForSelector('nav button[data-tab]');

      const fautes = new Map();
      let mesures = 0;
      for (const [o, temoin] of ONGLETS) {
        const b = page.locator(`nav button[data-tab="${o}"]`);
        if (!await b.count()) continue;
        await b.click().catch(() => { /* onglet masqué */ });
        if (temoin) {
          await page.waitForSelector(temoin, { timeout: 20000 });
        } else {
          await page.waitForFunction((sel) => {
            const t = document.querySelector(sel);
            return t && t.textContent.trim().length > 0;
          }, `#tab-${o}`, { timeout: 15000 }).catch(() => { /* onglet légitimement vide */ });
        }
        let { vus, sous } = await page.evaluate(SONDE);
        mesures += vus;
        /* Les sous-onglets de Réglages ne s'ouvrent pas tout seuls, et « Dictée vocale » est le
           seul qui porte un tableau de verdicts. On le déroule pour de vrai — le test le fait
           passer par ses trois états d'étape (✓, ⚠, ✗ : le micro est refusé dans un navigateur
           sans permission, ce qui est précisément le cas rouge à mesurer). */
        if (o === 'admin') {
          await page.click('#tab-admin .subnav [data-sub="dictation"]');
          await page.waitForSelector('#sub-dictation.active');
          await page.click('#dictationTest');
          await page.waitForSelector('#dictationVerdict:not([hidden])', { timeout: 20000 });
          await page.waitForFunction(() => document.querySelectorAll('#dictationSteps .dict-step').length >= 8, null, { timeout: 20000 })
            .catch(() => { /* les étapes navigateur peuvent manquer : on mesure ce qui est là */ });
          /* ON ATTEND QUE LE BOUTON AIT FINI DE REDEVENIR LUI-MÊME. Un bouton en cours porte
             `data-busy`, qui met son libellé en `transparent` le temps du spinner — c'est
             voulu. L'attribut retiré ne suffit pas : la couleur REVIENT PAR UNE TRANSITION, et
             `getComputedStyle` rend pendant ce temps une valeur intermédiaire (mesuré : blanc à
             5 % d'opacité). Mesurer un écran encore en train de se peindre n'apprend rien sur
             ses couleurs — on attend donc que l'alpha soit revenu à 1. */
          await page.waitForSelector('#dictationTest:not([data-busy])', { timeout: 20000 });
          await page.waitForFunction(() => ['#dictationTest', '#dictationInstall']
            .map((sel) => document.querySelector(`${sel} span`))
            .every((el) => !el || !/rgba/.test(getComputedStyle(el).color)), null, { timeout: 20000 });
          const dict = await page.evaluate(SONDE);
          mesures += dict.vus;
          sous = sous.concat(dict.sous);
        }
        for (const x of sous) {
          const k = `${x.sel}|${x.txt}`;
          if (!fautes.has(k)) fautes.set(k, { ...x, onglet: o });
        }
      }
      await page.close();

      /* COMBIEN A-T-ON RÉELLEMENT MESURÉ ? Un test de contraste qui parcourt des écrans vides
         est toujours vert. On exige donc un plancher : en dessous, c'est la sonde ou le jeu de
         données qui a un problème, pas l'interface qui est irréprochable. */
      assert.ok(mesures >= 200, `sonde suspecte : seulement ${mesures} textes visibles mesurés`);

      const liste = [...fautes.values()].sort((a, b) => a.r - b.r)
        .map((v) => `${v.r}:1 (seuil ${v.seuil}) ${v.px}px [${v.onglet}] ${v.sel} « ${v.txt} »`);
      assert.deepEqual(liste, [], `texte(s) sous le seuil :\n  ${liste.join('\n  ')}`);
    });
  }
});
