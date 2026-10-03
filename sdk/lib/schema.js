'use strict';
/* UN VALIDATEUR DE `settingsSchema`, volontairement petit : le sous-ensemble de JSON Schema
   qu'un formulaire de réglages sait rendre — `string`, `number`, `integer`, `boolean`, `enum`,
   `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `format: "uri"`, `default`,
   `title`/`description` pour l'écran, et deux extensions nommées :
   — `x-secret: true` : la valeur est un secret, rangée à part, masquée « *** » en lecture ;
   — `x-bound-to: "<clé>"` : ce secret est lié à une adresse — si l'origine de cette adresse
     change sans que le secret soit refourni, il est effacé (un jeton ne part jamais vers un
     autre hôte que celui pour lequel il a été saisi).
   Pur, partagé par le cœur, le worker et le SDK de test. */

function defauts(schema) {
  const out = {};
  for (const [k, p] of Object.entries((schema && schema.properties) || {})) {
    if (p && p.default !== undefined) out[k] = p.default;
    else if (p && p.type === 'boolean') out[k] = false;
    else if (p && (p.type === 'number' || p.type === 'integer')) out[k] = 0;
    else if (p && p.type === 'string') out[k] = '';
  }
  return out;
}

/** Coerce une valeur venue d'un formulaire (chaîne) vers le type du schéma. */
function convertir(p, v) {
  if (v === undefined) return undefined;
  if (p.type === 'boolean') return v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
  if (p.type === 'number' || p.type === 'integer') {
    if (v === '' || v === null) return p.default !== undefined ? p.default : 0;
    /* Une saisie illisible (« x ») ne lève pas : elle retombe sur le minimum du schéma, ou 0 — ce que
       font les réglages du cœur (`parseInt` puis repli), et ce qu'attend un champ qui dit « 0 = jamais ». */
    const n = Number(v);
    if (!Number.isFinite(n)) return p.minimum != null ? p.minimum : 0;
    return p.type === 'integer' ? Math.round(n) : n;
  }
  return v === null ? '' : String(v);
}

/**
 * Valide un patch contre le schéma. Rend { valeurs, erreurs } : `valeurs` est le patch
 * converti et borné (on ne jette pas une saisie à cause d'une limite : on la ramène dans
 * les bornes, comme le font les réglages du cœur), `erreurs` ce qui ne passe pas.
 */
function valider(schema, patch) {
  const props = (schema && schema.properties) || {};
  const valeurs = {};
  const erreurs = [];
  for (const [k, brut] of Object.entries(patch || {})) {
    const p = props[k];
    if (!p) { erreurs.push(`réglage inconnu : ${k}`); continue; }
    const v = convertir(p, brut);
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isNaN(v)) { erreurs.push(`${k} : nombre attendu`); continue; }
    let val = v;
    if (typeof val === 'number') {
      if (p.minimum != null && val < p.minimum) val = p.minimum;
      if (p.maximum != null && val > p.maximum) val = p.maximum;
    }
    if (typeof val === 'string') {
      val = val.trim();
      if (p.maxLength != null && val.length > p.maxLength) val = val.slice(0, p.maxLength);
      if (p.minLength != null && val.length < p.minLength && val !== '') { erreurs.push(`${k} : au moins ${p.minLength} caractères`); continue; }
      if (p.pattern && val && !new RegExp(p.pattern).test(val)) { erreurs.push(`${k} : ne correspond pas au motif ${p.pattern}`); continue; }
      if (p.format === 'uri' && val) {
        try { const u = new URL(val); if (!/^https?:$/.test(u.protocol)) throw new Error(); val = val.replace(/\/+$/, ''); }
        catch { erreurs.push(`${k} : adresse http(s) attendue`); continue; }
      }
    }
    if (Array.isArray(p.enum) && !p.enum.includes(val)) { erreurs.push(`${k} : valeur hors de ${p.enum.join(', ')}`); continue; }
    valeurs[k] = val;
  }
  return { valeurs, erreurs };
}

/** Les clés secrètes du schéma. */
const secrets = (schema) => Object.entries((schema && schema.properties) || {}).filter(([, p]) => p && p['x-secret']).map(([k]) => k);

/** Les liens secret → clé d'adresse (`x-bound-to`). */
function liaisons(schema) {
  const out = {};
  for (const [k, p] of Object.entries((schema && schema.properties) || {})) if (p && p['x-secret'] && p['x-bound-to']) out[k] = String(p['x-bound-to']);
  return out;
}

/** L'origine d'une adresse (schéma + hôte + port), ou la chaîne telle quelle. */
function origineDe(u) {
  const v = String(u || '').trim();
  try { return new URL(v).origin; } catch { return v; }
}

module.exports = { defauts, valider, convertir, secrets, liaisons, origineDe };
