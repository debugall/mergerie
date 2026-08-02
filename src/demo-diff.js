'use strict';

/* Viewer de code STATIQUE pour le mode démo (MERGERIE_DEMO=1), sur le modèle de
 * demo-git.js et demo-docker.js.
 *
 * Pourquoi ce module existe : les routes du viewer (`/diffview`, `/tree`, `/file`,
 * `/filediff`) passent toutes par un clone git réel — `git.ensureRepo` va cloner
 * `git@gitlab.demo:…`, une machine qui n'existe pas. En démo, « Voir le diff » échouait
 * donc systématiquement, sur une fonctionnalité pourtant centrale. On sert ici un dépôt
 * fictif cohérent : même arborescence, vrais diffs unifiés, mêmes formes de réponse.
 *
 * Le contrat est celui de `viewerPayload` / `viewerFile` / `viewerFileDiff` dans
 * server.js — toute divergence casserait le front sans prévenir.
 */

const isDemo = () => process.env.MERGERIE_DEMO === '1';

/* Arborescence par projet. Volontairement courte : elle doit tenir dans le panneau de
   gauche du viewer sans défilement interminable, tout en restant crédible. */
const ARBRES = {
  'groupe/api-core': [
    'README.md',
    'package.json',
    'src/index.js',
    'src/webhooks/validate.js',
    'src/webhooks/router.js',
    'src/pricing.js',
    'src/metrics.js',
    'src/db/pool.js',
    'test/webhooks.test.js',
    'test/pricing.test.js',
  ],
  'groupe/webapp-front': [
    'README.md',
    'package.json',
    'src/main.js',
    'src/theme.js',
    'src/upload/uploader.js',
    'src/checkout/tunnel.js',
    'src/checkout/total.js',
    'styles/dark.css',
    'test/theme.test.js',
  ],
  'groupe/batch-jobs': [
    'README.md',
    'jobs/nightly.js',
    'jobs/retry.js',
    'lib/backoff.js',
    'test/backoff.test.js',
  ],
  'acme/design-system': [
    'README.md',
    'src/components/Tooltip.jsx',
    'src/components/Button.jsx',
    'src/tokens.css',
    'test/Tooltip.test.jsx',
  ],
};

const ARBRE_DEFAUT = ['README.md', 'src/index.js', 'test/index.test.js'];

/* Un diff unifié par merge request, référencé par son numéro. Ce sont de vrais diffs :
   le front les découpe par fichier et compte les lignes, donc un format approximatif se
   verrait immédiatement à l'écran. */
const DIFFS = {
  207: `diff --git a/src/webhooks/validate.js b/src/webhooks/validate.js
index 7a1c2e4..b93f5d1 100644
--- a/src/webhooks/validate.js
+++ b/src/webhooks/validate.js
@@ -1,12 +1,26 @@
 'use strict';

+const SCHEMAS = require('./schemas');
+
 // Valide le payload d'un webhook entrant avant tout traitement metier.
 function validate(payload, type) {
-  if (!payload) return true;
-  return true;
+  if (!payload || typeof payload !== 'object') {
+    throw new Error('payload absent ou invalide');
+  }
+  const schema = SCHEMAS[type];
+  if (!schema) {
+    throw new Error(\`type de webhook inconnu : \${type}\`);
+  }
+  for (const [champ, regle] of Object.entries(schema)) {
+    const valeur = payload[champ];
+    if (regle.requis && (valeur === undefined || valeur === null)) {
+      throw new Error(\`champ requis manquant : \${champ}\`);
+    }
+    if (valeur !== undefined && typeof valeur !== regle.type) {
+      throw new Error(\`champ \${champ} : attendu \${regle.type}\`);
+    }
+  }
+  return true;
 }

 module.exports = { validate };
diff --git a/test/webhooks.test.js b/test/webhooks.test.js
index 2f8b1a0..c4d9e77 100644
--- a/test/webhooks.test.js
+++ b/test/webhooks.test.js
@@ -3,6 +3,18 @@ const assert = require('node:assert');
 const { validate } = require('../src/webhooks/validate');

 test('accepte un payload conforme', () => {
   assert.equal(validate({ id: 'evt_1', amount: 10 }, 'payment'), true);
 });
+
+test('refuse un payload nul', () => {
+  assert.throws(() => validate(null, 'payment'), /payload absent/);
+});
+
+test('refuse un champ requis manquant', () => {
+  assert.throws(() => validate({ amount: 10 }, 'payment'), /champ requis/);
+});
+
+test('refuse un type inconnu', () => {
+  assert.throws(() => validate({ id: 'x' }, 'inconnu'), /type de webhook/);
+});
`,
  205: `diff --git a/src/theme.js b/src/theme.js
index 1b2c3d4..9e8f7a6 100644
--- a/src/theme.js
+++ b/src/theme.js
@@ -1,10 +1,24 @@
 'use strict';

+const CLES = { theme: 'mergerie_theme' };
+
 function themeActuel() {
-  return 'clair';
+  const enregistre = localStorage.getItem(CLES.theme);
+  if (enregistre === 'clair' || enregistre === 'sombre') return enregistre;
+  return matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
 }

+function appliquerTheme(nom) {
+  document.documentElement.dataset.theme = nom;
+  localStorage.setItem(CLES.theme, nom);
+}
+
+matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
+  if (!localStorage.getItem(CLES.theme)) appliquerTheme(e.matches ? 'sombre' : 'clair');
+});
+
-module.exports = { themeActuel };
+module.exports = { themeActuel, appliquerTheme };
diff --git a/styles/dark.css b/styles/dark.css
index 0000000..3a5b8c2 100644
--- a/styles/dark.css
+++ b/styles/dark.css
@@ -1,3 +1,18 @@
+:root[data-theme='sombre'] {
+  --fond: #14161a;
+  --texte: #e6e8ec;
+  --bordure: #2a2f37;
+  --accent: #6aa2ff;
+}
+
+:root[data-theme='sombre'] .card {
+  background: var(--fond);
+  border-color: var(--bordure);
+}
`,
  215: `diff --git a/src/upload/uploader.js b/src/upload/uploader.js
index 5d4c3b2..8a7f6e1 100644
--- a/src/upload/uploader.js
+++ b/src/upload/uploader.js
@@ -1,16 +1,31 @@
 'use strict';

+const TYPES_AUTORISES = new Set(['image/png', 'image/jpeg', 'application/pdf']);
+const TAILLE_MAX = 10 * 1024 * 1024;
+
 async function envoyer(fichier) {
-  const corps = new FormData();
-  corps.append('fichier', fichier);
-  return fetch('/api/upload', { method: 'POST', body: corps });
+  if (!TYPES_AUTORISES.has(fichier.type)) {
+    throw new Error(\`type de fichier refuse : \${fichier.type}\`);
+  }
+  if (fichier.size > TAILLE_MAX) {
+    throw new Error('fichier trop volumineux (10 Mo maximum)');
+  }
+  const corps = new FormData();
+  corps.append('fichier', fichier, sanitiserNom(fichier.name));
+  const r = await fetch('/api/upload', { method: 'POST', body: corps });
+  if (!r.ok) throw new Error('envoi refuse par le serveur');
+  return r.json();
 }

+// Un nom de fichier venu du poste client ne doit jamais servir de chemin.
+function sanitiserNom(nom) {
+  return String(nom).replace(/[/\\\\]/g, '_').replace(/\\.{2,}/g, '.').slice(0, 120);
+}
+
 module.exports = { envoyer };
`,
  216: `diff --git a/src/checkout/tunnel.js b/src/checkout/tunnel.js
index 3c2b1a0..7f6e5d4 100644
--- a/src/checkout/tunnel.js
+++ b/src/checkout/tunnel.js
@@ -1,20 +1,34 @@
 'use strict';

+const { calculerTotal } = require('./total');
+
 async function payer(panier, carte) {
-  console.log('paiement', carte.numero);
-  const total = panier.reduce((s, l) => s + l.prix, 0);
-  return psp.charge(carte, total);
+  // Le numero de carte ne doit jamais atteindre les logs.
+  const total = calculerTotal(panier);
+  if (!total.devise) throw new Error('devise absente du panier');
+  try {
+    return await psp.charge(carte, total.montant, total.devise);
+  } catch (e) {
+    if (e.reseau) throw new Error('paiement indisponible, reessaie dans un instant');
+    throw e;
+  }
 }

 module.exports = { payer };
diff --git a/src/checkout/total.js b/src/checkout/total.js
index 0000000..2d1e9f8 100644
--- a/src/checkout/total.js
+++ b/src/checkout/total.js
@@ -1,2 +1,16 @@
+'use strict';
+
+// Le total est recalcule cote serveur : le panier client n'est pas une source de verite.
+function calculerTotal(panier) {
+  const montant = panier.reduce((s, l) => s + Math.round(l.prixUnitaire * l.quantite), 0);
+  return { montant, devise: panier[0] && panier[0].devise };
+}
+
+module.exports = { calculerTotal };
`,
  208: `diff --git a/src/db/pool.js b/src/db/pool.js
index 9a8b7c6..1d2e3f4 100644
--- a/src/db/pool.js
+++ b/src/db/pool.js
@@ -1,10 +1,22 @@
 'use strict';

+const cache = require('../cache/redis');
+
 async function catalogue() {
-  return db.query('SELECT * FROM produit');
+  const enCache = await cache.get('catalogue');
+  if (enCache) return JSON.parse(enCache);
+  const lignes = await db.query('SELECT * FROM produit');
+  await cache.set('catalogue', JSON.stringify(lignes), { ttl: 300 });
+  return lignes;
 }

 module.exports = { catalogue };
`,
  209: `diff --git a/src/index.js b/src/index.js
index 4b5c6d7..8e9f0a1 100644
--- a/src/index.js
+++ b/src/index.js
@@ -12,8 +12,17 @@ app.get('/clients', async (req, res) => {
-  const clients = await db.query('SELECT * FROM client');
-  res.json(clients);
+  const page = Math.max(1, Number(req.query.page) || 1);
+  const parPage = Math.min(100, Number(req.query.par_page) || 25);
+  const clients = await db.query(
+    'SELECT * FROM client ORDER BY id LIMIT ? OFFSET ?',
+    [parPage, (page - 1) * parPage],
+  );
+  const total = await db.compte('client');
+  res.json({ clients, page, par_page: parPage, total });
 });
`,
  214: `diff --git a/src/components/Tooltip.jsx b/src/components/Tooltip.jsx
index 6f5e4d3..2a1b0c9 100644
--- a/src/components/Tooltip.jsx
+++ b/src/components/Tooltip.jsx
@@ -1,14 +1,28 @@
 import { useId, useState } from 'react';

 export function Tooltip({ label, children }) {
   const [ouvert, setOuvert] = useState(false);
+  const id = useId();
   return (
-    <span onMouseEnter={() => setOuvert(true)} onMouseLeave={() => setOuvert(false)}>
-      {children}
-      {ouvert && <span className="tip">{label}</span>}
+    <span
+      onMouseEnter={() => setOuvert(true)}
+      onMouseLeave={() => setOuvert(false)}
+      onFocus={() => setOuvert(true)}
+      onBlur={() => setOuvert(false)}
+    >
+      {/* aria-describedby : le lecteur d'ecran annonce le libelle avec l'element decrit */}
+      <span aria-describedby={ouvert ? id : undefined}>{children}</span>
+      <span id={id} role="tooltip" hidden={!ouvert} className="tip">
+        {label}
+      </span>
     </span>
   );
 }
`,
  250: `diff --git a/src/metrics.js b/src/metrics.js
index 0000000..5c4b3a2 100644
--- a/src/metrics.js
+++ b/src/metrics.js
@@ -1,2 +1,21 @@
+'use strict';
+
+const compteurs = new Map();
+
+function incrementer(nom, valeur = 1) {
+  compteurs.set(nom, (compteurs.get(nom) || 0) + valeur);
+}
+
+// Format d'exposition Prometheus : une ligne HELP, une ligne TYPE, une ligne de valeur.
+function rendu() {
+  const lignes = [];
+  for (const [nom, valeur] of compteurs) {
+    lignes.push(\`# HELP \${nom} compteur applicatif\`);
+    lignes.push(\`# TYPE \${nom} counter\`);
+    lignes.push(\`\${nom} \${valeur}\`);
+  }
+  return lignes.join('\\n') + '\\n';
+}
+
+module.exports = { incrementer, rendu };
`,
};

/* Diff de repli, construit à partir de l'arborescence du projet : une MR de démo ajoutée
   plus tard doit montrer QUELQUE CHOSE plutôt qu'un viewer vide. */
function diffDeRepli(projet, branche) {
  const fichiers = ARBRES[projet] || ARBRE_DEFAUT;
  const cible = fichiers.find((f) => f.endsWith('.js')) || fichiers[fichiers.length - 1];
  return `diff --git a/${cible} b/${cible}
index 1111111..2222222 100644
--- a/${cible}
+++ b/${cible}
@@ -1,6 +1,10 @@
 'use strict';

+// ${branche}
+const OPTIONS = { strict: true };
+
 function principal(entree) {
-  return entree;
+  if (!entree) throw new Error('entree requise');
+  return { ...entree, options: OPTIONS };
 }
`;
}

function diffPour(mr) {
  return DIFFS[Number(mr.iid)] || diffDeRepli(mr.project, mr.source_branch || 'feature');
}

// Chemins « b/… » touchés par un diff unifié — même règle que changedFilesFromDiff côté serveur.
function fichiersModifies(diff) {
  const set = new Set();
  for (const m of String(diff).matchAll(/^\+\+\+ b\/(.+)$/gm)) set.add(m[1]);
  return set;
}

function arbrePour(mr) {
  const base = ARBRES[mr.project] || ARBRE_DEFAUT;
  const touches = fichiersModifies(diffPour(mr));
  // Un fichier créé par la MR ne figure pas dans l'arbre de base : on l'ajoute.
  return [...new Set([...base, ...touches])].sort();
}

function statsDe(diff) {
  return {
    files: fichiersModifies(diff).size,
    added: (diff.match(/^\+(?!\+\+)/gm) || []).length,
    removed: (diff.match(/^-(?!--)/gm) || []).length,
  };
}

// Charge utile d'ouverture du viewer, à la forme de `viewerPayload`.
function viewFor(mr) {
  const diff = diffPour(mr);
  const touches = fichiersModifies(diff);
  return {
    diff,
    source: mr.source_branch,
    target: mr.target_branch || 'main',
    files: arbrePour(mr).map((f) => ({ path: f, changed: touches.has(f) })),
    stats: statsDe(diff),
  };
}

// Arborescence marquée, à la forme de la route /tree.
function treeFor(mr) {
  const touches = fichiersModifies(diffPour(mr));
  return {
    ref: `origin/${mr.source_branch}`,
    target: mr.target_branch || 'main',
    files: arbrePour(mr).map((f) => ({ path: f, changed: touches.has(f) })),
  };
}

/* Contenu d'un fichier. On ne stocke pas un dépôt entier : on rend un corps plausible et
   cohérent avec le chemin demandé. Le chemin est validé contre l'arborescence, exactement
   comme en vrai — une démo qui laisserait passer un chemin arbitraire enseignerait le
   mauvais réflexe. */
function fileFor(mr, p) {
  if (!p) throw new Error('path requis');
  if (!arbrePour(mr).includes(p)) throw new Error('fichier hors arborescence');
  return { path: p, content: corpsDe(p, mr) };
}

function corpsDe(p, mr) {
  if (p.endsWith('.md')) {
    return `# ${mr.project}\n\nDépôt de démonstration.\n\n`
      + `Branche courante : \`${mr.source_branch}\`\n\n`
      + '## Installation\n\n```\nnpm install\nnpm start\n```\n';
  }
  if (p.endsWith('.json')) {
    return `{\n  "name": "${mr.project.split('/').pop()}",\n  "version": "1.4.2",\n`
      + '  "scripts": {\n    "test": "node --test",\n    "lint": "eslint ."\n  }\n}\n';
  }
  if (p.endsWith('.css')) {
    return ':root {\n  --fond: #ffffff;\n  --texte: #14161a;\n  --accent: #2563eb;\n}\n\n'
      + '.card {\n  background: var(--fond);\n  border: 1px solid #e5e7eb;\n  border-radius: 10px;\n}\n';
  }
  if (p.endsWith('.jsx')) {
    return "import { useState } from 'react';\n\n"
      + `export function Composant() {\n  const [etat, setEtat] = useState(null);\n`
      + '  return <div onClick={() => setEtat(Date.now())}>{String(etat)}</div>;\n}\n';
  }
  const nom = p.split('/').pop().replace(/\.[^.]+$/, '');
  return `'use strict';\n\n// ${p}\n\nfunction ${nom.replace(/[^a-zA-Z0-9_]/g, '_')}(entree) {\n`
    + "  if (!entree) throw new Error('entree requise');\n  return entree;\n}\n\n"
    + `module.exports = { ${nom.replace(/[^a-zA-Z0-9_]/g, '_')} };\n`;
}

/* Diff d'un seul fichier : on extrait sa section du diff complet. Renvoyer le diff entier
   ferait croire à l'utilisateur que le fichier sélectionné change partout. */
function fileDiffFor(mr, p) {
  if (!p) throw new Error('path requis');
  if (!arbrePour(mr).includes(p)) throw new Error('fichier hors arborescence');
  const sections = String(diffPour(mr)).split(/^(?=diff --git )/m);
  const section = sections.find((s) => s.includes(`+++ b/${p}`));
  return { diff: section || '' };
}

module.exports = {
  isDemo, viewFor, treeFor, fileFor, fileDiffFor, diffPour, arbrePour,
};
