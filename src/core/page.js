'use strict';
// @ts-check
/* LA PAGE, ASSEMBLÉE PAR MORCEAUX — l'unique exception au « pas de build » du front.

   Un `<script src>` découpe le JavaScript et un `<link>` la feuille de style ; le HTML, lui,
   n'a pas d'inclusion native. `public/index.html` garde donc la COQUILLE (le `<head>`, le
   squelette du `<body>`, le manifeste des `<script>` et des `<link>`) et des MARQUEURS :

       <!--@include html/ecrans/reviews.html-->

   Cette fonction résout chaque marqueur par le contenu du morceau (chemin relatif à `public/`,
   UN niveau : un morceau n'inclut pas de morceau, un marqueur n'a pas de paramètre), en laissant
   la ligne du marqueur en place — un commentaire HTML, qui dit dans la page servie d'où vient
   chaque bloc. Le DOM que voit le navigateur est le même que celui de l'ancien fichier unique ;
   celui que voient les tests aussi.

   Le résultat est MÉMORISÉ et relu quand la coquille ou un morceau change (mtime et taille) :
   un morceau modifié est servi sans redémarrage, comme un fichier statique.

   AUCUNE DÉPENDANCE DE `src/` — `fs` et `path` seulement. `scripts/check-front.js`,
   `scripts/i18n-check.js` et `test/helpers/front.js` chargent ce module pour lire la page telle
   qu'elle est servie, sans `MERGERIE_DATA_DIR` : il ne touche ni `paths.js` ni la base
   (`check-deps` le garantit pour tout `core/`). */
const fs = require('fs');
const path = require('path');

/* `\r?` en fin : `public/` peut être extrait avec des fins de ligne CRLF (checkout Windows,
   `core.autocrlf=true`) — sans lui, le marqueur ne matche plus jamais et la page sert les
   commentaires `<!--@include …-->` tels quels, coquille vide, tous les `$(...)` de scripts null. */
const MARQUEUR = /^[ \t]*<!--@include ([^\s>]+)-->[ \t]*\r?$/;
/* LES MARQUEURS DE PLUGINS : `<!--@plugins:styles-->`, `<!--@plugins:nav-->`… Chacun est
   remplacé par ce que les plugins ACTIFS apportent à cet endroit (voir `src/plugins/pageplugins.js`),
   la ligne du marqueur restant en place. Sans fragments (contrôles, tests sans plugin), le
   marqueur reste seul : la page est celle du cœur. `nav` admet des positions nommées
   (`before:links`), résolues contre les boutons `data-tab` de la coquille. */
const MARQUEUR_PLUGINS = /^([ \t]*)<!--@plugins:([a-z0-9-]+)-->[ \t]*\r?$/;

/* Le chemin d'un morceau, vérifié : relatif, sous `public/`, jamais au-dessus. */
function cheminMorceau(base, rel, ou) {
  if (rel.startsWith('/') || /^[a-z]+:/i.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`page : ${ou} — le marqueur « ${rel} » n'est pas un chemin relatif sous public/`);
  }
  const f = path.join(base, rel);
  if (!fs.existsSync(f)) throw new Error(`page : ${ou} — le morceau « ${rel} » n'existe pas`);
  return f;
}

/* Les marqueurs de la coquille, dans l'ordre — ce que `check-front` compare au disque. */
function morceaux(cheminIndex) {
  const out = [];
  fs.readFileSync(cheminIndex, 'utf8').split('\n').forEach((l, i) => {
    const m = MARQUEUR.exec(l);
    if (m) out.push({ rel: m[1], ligne: i + 1 });
  });
  return out;
}

const empreinte = (f) => { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; };
const memo = new Map();

function inchange(entree) {
  try {
    for (const [f, e] of entree.empreintes) if (empreinte(f) !== e) return false;
    return true;
  } catch { return false; }
}

/**
 * @param {string} cheminIndex
 * @param {{ fragments?: Record<string, any> }} [options] les fragments des plugins actifs, par marqueur
 */
function assemblerPage(cheminIndex, { fragments } = {}) {
  const base = assemblerCoquille(cheminIndex);
  if (!fragments) return base;
  return poserFragments(base, fragments);
}

/** La page avec ses fragments de plugins posés sur les marqueurs `<!--@plugins:x-->`. */
function poserFragments(page, fragments) {
  const positions = (fragments && fragments.navPositions) || {};
  const lignes = page.split('\n');
  const out = [];
  for (const l of lignes) {
    const m = MARQUEUR_PLUGINS.exec(l);
    if (m) {
      out.push(l);
      const texte = fragments[m[2]];
      if (texte) out.push(texte);
      continue;
    }
    /* Un bouton d'onglet du cœur : un plugin peut demander à passer AVANT ou APRÈS lui. */
    const tab = l.match(/<button data-tab="([a-z-]+)"/);
    if (tab && positions[`before:${tab[1]}`]) out.push(positions[`before:${tab[1]}`]);
    out.push(l);
    if (tab && positions[`after:${tab[1]}`]) out.push(positions[`after:${tab[1]}`]);
  }
  return out.join('\n');
}

function assemblerCoquille(cheminIndex) {
  const deja = memo.get(cheminIndex);
  if (deja && inchange(deja)) return deja.page;
  const base = path.dirname(cheminIndex);
  const nom = path.basename(cheminIndex);
  const empreintes = new Map([[cheminIndex, empreinte(cheminIndex)]]);
  const out = [];
  fs.readFileSync(cheminIndex, 'utf8').split('\n').forEach((l, i) => {
    const m = MARQUEUR.exec(l);
    if (!m) { out.push(l); return; }
    const ou = `${nom}:${i + 1}`;
    const f = cheminMorceau(base, m[1], ou);
    empreintes.set(f, empreinte(f));
    const texte = fs.readFileSync(f, 'utf8');
    const imbrique = texte.split('\n').findIndex((t) => MARQUEUR.test(t));
    if (imbrique !== -1) throw new Error(`page : ${m[1]}:${imbrique + 1} — un morceau n'inclut pas de morceau (un seul niveau)`);
    out.push(l, texte.replace(/\n$/, ''));
  });
  const page = out.join('\n');
  memo.set(cheminIndex, { empreintes, page });
  return page;
}

/** Les marqueurs de plugins de la coquille assemblée, dans l'ordre. */
function marqueursPlugins(cheminIndex) {
  return assemblerCoquille(cheminIndex).split('\n').map((l) => MARQUEUR_PLUGINS.exec(l)).filter(Boolean).map((m) => m[2]);
}

module.exports = { assemblerPage, poserFragments, morceaux, marqueursPlugins, MARQUEUR, MARQUEUR_PLUGINS };
