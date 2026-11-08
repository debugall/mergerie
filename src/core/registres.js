'use strict';
// @ts-check
/* LES REGISTRES PUBLICS, un par écosystème — la table du contrôle au registre (`review/registre.js`),
   et la validation du réglage `registry_urls` que `data/config.js` applique à l'enregistrement. Pur :
   ni base, ni réseau, ni couche supérieure. */

const REGISTRES = {
  npm: { url: 'https://registry.npmjs.org', label: 'npm' },
  composer: { url: 'https://repo.packagist.org', label: 'Packagist' },
  pypi: { url: 'https://pypi.org', label: 'PyPI' },
  crates: { url: 'https://crates.io', label: 'crates.io' },
  rubygems: { url: 'https://rubygems.org', label: 'RubyGems' },
  go: { url: 'https://proxy.golang.org', label: 'proxy.golang.org' },
  maven: { url: 'https://search.maven.org', label: 'Maven Central' },
  nuget: { url: 'https://api.nuget.org', label: 'NuGet' },
};
const ECOSYSTEMES = Object.keys(REGISTRES);
const URLS_DEFAUT = ECOSYSTEMES.map((e) => `${e}=${REGISTRES[e].url}`).join('\n');

/* `écosystème=url`, une ligne par registre à surcharger (de ce poste). Vide après le `=` :
   l'écosystème n'est pas contrôlé ; absent : l'URL publique. Rend `{ eco: url|'' }` complet.
   @param {string|null|undefined} texte */
function urlsDepuis(texte) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const e of ECOSYSTEMES) out[e] = REGISTRES[e].url;
  for (const ligne of String(texte || '').split('\n')) {
    const m = ligne.trim().match(/^([a-z]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const eco = m[1].toLowerCase();
    if (!(eco in REGISTRES)) continue;
    out[eco] = m[2].trim().replace(/\/+$/, '');
  }
  return out;
}

/* La validation du réglage, à l'enregistrement : un écosystème inconnu ou une URL qui n'est pas
   http(s) sont refusés avec leur ligne — jamais à l'affichage.
   @param {string|null|undefined} texte */
function normaliserUrls(texte) {
  const lignes = String(texte || '').split('\n').map((l) => l.trim()).filter(Boolean);
  /** @type {string[]} */
  const out = [];
  lignes.forEach((l, i) => {
    const m = l.match(/^([a-z]+)\s*=\s*(.*)$/i);
    if (!m) throw new Error(`registry_urls : ligne ${i + 1} — attendu « écosystème=url »`);
    const eco = m[1].toLowerCase();
    if (!(eco in REGISTRES)) throw new Error(`registry_urls : ligne ${i + 1} — écosystème inconnu « ${m[1]} » (${ECOSYSTEMES.join(', ')})`);
    const url = m[2].trim();
    if (url) {
      let u = null;
      try { u = new URL(url); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`registry_urls : ligne ${i + 1} — URL http(s) attendue`);
    }
    out.push(`${eco}=${url.replace(/\/+$/, '')}`);
  });
  return out.join('\n');
}

module.exports = { REGISTRES, ECOSYSTEMES, URLS_DEFAUT, urlsDepuis, normaliserUrls };
