'use strict';
/* LIRE LE FRONT COMME DU TEXTE, où que ses fichiers soient rangés — le pendant de `sources.js`
   pour `public/`. Quelques tests sont des gardes de SOURCE : ils découpent une tranche du front
   (`GIT_DESTRUCTIVE`… `gitCmdIsDestructive`) et l'évaluent avec `new Function`. Écrire
   `public/app.js` en dur les casserait au premier découpage (réorganisation de public/ par écran
   et par couche) ; ici, `lireFront()` rend ce que le navigateur exécute — les scripts dans l'ordre
   du MANIFESTE, la liste des `<script src>` d'`index.html` —, `lireFichierFront('ecrans/git/commandes')`
   un fichier par son nom, et `lireHtml()` la page telle qu'elle est servie (assemblée par
   `src/core/page.js` dès qu'il existe, le fichier avant).

   Sans build ni modules, l'ordre des balises est l'ordre d'évaluation : le manifeste est la seule
   liste de ce qui est chargé, et c'est lui que `scripts/check-front.js` lit aussi. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX = path.join(PUBLIC, 'index.html');

/* La page telle que servie. `src/core/page.js` n'importe rien de `src/` (ni `paths.js`, ni la
   base) : le charger ici ne demande pas `MERGERIE_DATA_DIR`. */
function lireHtml() {
  const page = path.join(ROOT, 'src', 'core', 'page.js');
  if (fs.existsSync(page)) return require(page).assemblerPage(INDEX);
  return fs.readFileSync(INDEX, 'utf8');
}

/* Le manifeste : les scripts et les feuilles de style, dans l'ordre du document, en chemins
   relatifs à `public/` (`js/core/dom.js`, `css/socle.css`). Seules les adresses absolues locales
   comptent (`/x.js`) : le sprite et les images n'en sont pas. */
function manifeste(html = lireHtml()) {
  const scripts = [...html.matchAll(/<script\s+[^>]*?src="\/([^"]+)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\/([^"]+)"/g)].map((m) => m[1]);
  return { scripts, styles };
}

/* Ce qui, dans le manifeste, est LE CODE DE L'APPLICATION — ce qu'`app.js` contenait : ni les
   runtimes partagés avec Node, ni le dictionnaire, ni le thème posé dans le <head>. */
const PAS_APP = /^(?:runtime|i18n|vendor)\/|(?:^|\/)theme-early\.js$|^(?:i18n|i18n-runtime|ansi-runtime|notes-runtime|dictation-runtime)\.js$/;
function scriptsApp(m = manifeste()) {
  return m.scripts.filter((s) => !PAS_APP.test(s));
}

const lirePublic = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

/* La concaténation des scripts de l'application, dans l'ordre du manifeste, chacun précédé d'un
   repère `//// <chemin>` : une garde qui portait sur `app.js` porte désormais sur l'ensemble. */
function lireFront() {
  return scriptsApp().map((s) => `//// ${s}\n${lirePublic(s)}`).join('\n');
}

function tous(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tous(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* Un fichier du front par son nom, où qu'il soit rangé — même règle d'ambiguïté que
   `lireSource` : `ecrans/git/commandes` désigne sans chercher, `commandes` cherche sous
   `public/js/` et refuse deux homonymes. */
function cheminFront(nom) {
  const base = nom.replace(/\.js$/, '');
  const JS = path.join(PUBLIC, 'js');
  const rels = tous(JS).map((p) => path.relative(JS, p).split(path.sep).join('/'));
  if (base.includes('/')) {
    const exact = rels.find((rel) => rel === `${base}.js`);
    if (exact) return path.join(JS, exact);
  }
  const racine = rels.find((rel) => rel === `${base}.js`);
  const candidats = (racine ? [racine] : rels.filter((rel) => rel.endsWith(`/${base}.js`))).map((rel) => path.join(JS, rel));
  if (candidats.length !== 1) {
    throw new Error(`fichier du front « ${nom} » : ${candidats.length ? 'plusieurs fichiers' : 'aucun fichier'} sous public/js/ — ${candidats.join(', ')}`);
  }
  return candidats[0];
}

const lireFichierFront = (nom) => fs.readFileSync(cheminFront(nom), 'utf8');

module.exports = { ROOT, PUBLIC, INDEX, lireHtml, manifeste, scriptsApp, lireFront, cheminFront, lireFichierFront, lirePublic };
