'use strict';
/* LIRE ET VALIDER UN `plugin.json`. Pur : `fs` et le contrat, rien d'autre — lisible par
   `npm run check`, par les tests, par l'assemblage de page sans base ni dossier de données.

   Un manifeste invalide n'est pas chargé « à moitié » : il est listé avec ses erreurs, dans
   Réglages → Plugins, et c'est tout. Un `apiVersion` inconnu est une erreur comme une autre :
   « incompatible », jamais chargé. */
const fs = require('fs');
const path = require('path');

const contrat = require('../contract');

const CHEMIN_REL = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

/** Les erreurs d'un manifeste déjà parsé, sous forme de phrases. */
function valider(m) {
  const erreurs = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['plugin.json n’est pas un objet'];
  for (const k of contrat.MANIFESTE.requis) if (m[k] == null || m[k] === '') erreurs.push(`champ requis manquant : ${k}`);
  if (m.name != null && !contrat.MANIFESTE.nom.test(String(m.name))) erreurs.push(`name « ${m.name} » : kebab-case attendu (a-z, 0-9, tirets)`);
  if (m.version != null && !contrat.MANIFESTE.semver.test(String(m.version))) erreurs.push(`version « ${m.version} » : semver attendu (1.2.3)`);
  if (m.apiVersion != null && !contrat.API_VERSIONS_SUPPORTEES.includes(String(m.apiVersion))) {
    erreurs.push(`apiVersion « ${m.apiVersion} » non supportée par ce Mergerie (supportées : ${contrat.API_VERSIONS_SUPPORTEES.join(', ')})`);
  }
  if (m.main != null && !CHEMIN_REL.test(String(m.main))) erreurs.push(`main « ${m.main} » : chemin relatif sous le dossier du plugin attendu`);
  if (m.permissions != null) {
    if (!Array.isArray(m.permissions)) erreurs.push('permissions : tableau attendu');
    else for (const p of m.permissions) if (!contrat.PERMISSIONS[p]) erreurs.push(`permission inconnue : ${p}`);
  }
  if (m.requires != null && (!Array.isArray(m.requires) || m.requires.some((r) => !contrat.MANIFESTE.nom.test(String(r))))) erreurs.push('requires : tableau de noms de plugins attendu');
  if (m.events != null) {
    if (typeof m.events !== 'object') erreurs.push('events : { listens: [], emits: [] } attendu');
    else {
      for (const k of ['listens', 'emits']) if (m.events[k] != null && !Array.isArray(m.events[k])) erreurs.push(`events.${k} : tableau attendu`);
      for (const e of (Array.isArray(m.events.emits) ? m.events.emits : [])) {
        if (!String(e).startsWith(`${m.name}.`)) erreurs.push(`events.emits : « ${e} » doit être préfixé par « ${m.name}. »`);
      }
    }
  }
  if (m.settingsSchema != null) {
    const s = m.settingsSchema;
    if (typeof s !== 'object' || s.type !== 'object' || typeof s.properties !== 'object') erreurs.push('settingsSchema : JSON Schema d’objet attendu ({ type: "object", properties: {…} })');
    else for (const [k, p] of Object.entries(s.properties)) {
      if (!/^[a-z][a-z0-9_]*$/.test(k)) erreurs.push(`settingsSchema.properties.${k} : nom en snake_case attendu`);
      if (!p || !['string', 'number', 'integer', 'boolean'].includes(p.type)) erreurs.push(`settingsSchema.properties.${k} : type string | number | integer | boolean attendu`);
    }
  }
  if (m.ui != null) {
    if (typeof m.ui !== 'object') erreurs.push('ui : objet attendu');
    else {
      for (const k of ['styles', 'scripts', 'i18n']) {
        if (m.ui[k] != null && (!Array.isArray(m.ui[k]) || m.ui[k].some((f) => !CHEMIN_REL.test(String(f))))) erreurs.push(`ui.${k} : tableau de chemins relatifs attendu`);
      }
      if (m.ui.html != null) {
        if (typeof m.ui.html !== 'object') erreurs.push('ui.html : objet { tabs, modals, settings, sprite } attendu');
        else for (const [k, v] of Object.entries(m.ui.html)) {
          if (!['tabs', 'modals', 'settings', 'sprite'].includes(k)) erreurs.push(`ui.html.${k} : emplacement inconnu (tabs, modals, settings, sprite)`);
          else if (!Array.isArray(v) || v.some((f) => !CHEMIN_REL.test(String(f)))) erreurs.push(`ui.html.${k} : tableau de chemins relatifs attendu`);
        }
      }
    }
  }
  return erreurs;
}

/** Lit `plugin.json` d'un dossier. Rend { ok, manifeste, erreurs, dir }. */
function lire(dir) {
  const f = path.join(dir, 'plugin.json');
  if (!fs.existsSync(f)) return { ok: false, dir, manifeste: null, erreurs: ['plugin.json absent'] };
  let m;
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { ok: false, dir, manifeste: null, erreurs: [`plugin.json illisible : ${e.message}`] }; }
  const erreurs = valider(m);
  if (m && typeof m === 'object' && m.main && !fs.existsSync(path.join(dir, String(m.main)))) erreurs.push(`main « ${m.main} » introuvable`);
  for (const f2 of fichiersUi(m)) if (!fs.existsSync(path.join(dir, f2))) erreurs.push(`ui : « ${f2} » introuvable`);
  return { ok: !erreurs.length, dir, manifeste: m, erreurs };
}

/** Tous les fichiers de `ui` cités par un manifeste, à plat. */
function fichiersUi(m) {
  if (!m || !m.ui || typeof m.ui !== 'object') return [];
  const out = [];
  for (const k of ['styles', 'i18n', 'scripts']) if (Array.isArray(m.ui[k])) out.push(...m.ui[k].map(String));
  if (m.ui.html && typeof m.ui.html === 'object') for (const v of Object.values(m.ui.html)) if (Array.isArray(v)) out.push(...v.map(String));
  return out;
}

/** Les permissions effectives : celles déclarées, dédoublonnées. */
const permissionsDe = (m) => [...new Set(Array.isArray(m && m.permissions) ? m.permissions.map(String) : [])];

module.exports = { lire, valider, fichiersUi, permissionsDe, CHEMIN_REL };
