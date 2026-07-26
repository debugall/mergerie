#!/usr/bin/env node
'use strict';
/* Contrôles statiques du front — nés de bugs réels, pas de suppositions.

   `node --check` ne les voit pas : ce sont des erreurs de RUNTIME, qui ne se
   déclenchent qu'au clic sur l'écran concerné. D'où ces vérifications. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let failures = 0;
const fail = (title, items) => {
  failures++;
  console.log(`\n❌ ${title} (${items.length})`);
  items.forEach((i) => console.log(`   ${i}`));
};
const ok = (t) => console.log(`✅ ${t}`);
const lines = app.split('\n');

/* 1. $ vs $$ — LE bug qui est passé deux fois.
   `$` renvoie UN élément, `$$` un tableau. Appeler .forEach/.map/.filter sur le
   résultat de `$` explose au clic. La cause récurrente : dans une chaîne de
   remplacement JS, `$$` vaut un `$` littéral — insérer du code avec
   String.replace transforme silencieusement tous les `$$` en `$`. */
const singleOnList = [];
lines.forEach((l, i) => {
  const m = l.match(/(?<!\$)\$\((['"`][^'"`]*['"`][^)]*)\)\s*\.\s*(forEach|map|filter|some|every|slice|reduce)\b/);
  if (m) singleOnList.push(`public/app.js:${i + 1}  $(…).${m[2]} — devrait être $$(…)`);
});
singleOnList.length ? fail('Sélecteur $ utilisé comme une liste', singleOnList) : ok('Aucun $(…) traité comme un tableau');

/* 2. Sous-onglets sans la classe qui les habille.
   `.subnav` ne pose que des marges : l'apparence vient de `.segmented`.
   Un sous-onglet qui l'oublie s'affiche en boutons bruts. */
const badSubnav = [];
for (const m of html.matchAll(/<div class="([^"]*\bsubnav\b[^"]*)"/g)) {
  if (!/\bsegmented\b/.test(m[1])) badSubnav.push(`public/index.html  class="${m[1]}" — il manque « segmented »`);
}
badSubnav.length ? fail('Sous-onglet sans la classe segmented', badSubnav) : ok('Tous les sous-onglets sont habillés');

/* 3. Références à des id inexistants dans le HTML statique.
   Une faute de frappe sur un id donne `null`, et l'erreur ne survient qu'à
   l'ouverture de l'écran. On ne vérifie que les id littéraux (pas construits). */
const htmlIds = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
// Ids créés côté JS : soit dans un gabarit HTML (id="x"), soit par affectation
// (el.id = 'x'), soit via setAttribute. Les trois formes existent dans ce fichier.
const created = new Set([
  ...[...app.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]),
  ...[...app.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]/g)].map((m) => m[1]),
  ...[...app.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)['"]/g)].map((m) => m[1]),
  // ids posés via un paramètre injecté dans un gabarit (ex. repoComboHtml({ idAttr })).
  ...[...app.matchAll(/idAttr:\s*['"]([\w-]+)['"]/g)].map((m) => m[1]),
]);
const unknown = [];
lines.forEach((l, i) => {
  for (const m of l.matchAll(/\$\$?\('#([\w-]+)'\)/g)) {
    const id = m[1];
    if (!htmlIds.has(id) && !created.has(id)) unknown.push(`public/app.js:${i + 1}  #${id} n'existe ni dans index.html ni créé en JS`);
  }
});
unknown.length ? fail('Sélecteur pointant un id inconnu', unknown) : ok(`Tous les id référencés existent (${htmlIds.size} dans le HTML)`);

/* 4. Symboles d'icône utilisés mais absents du sprite. */
const symbols = new Set([...html.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]));
const usedIcons = new Set([...(app + html).matchAll(/href="#(i-[\w-]+)"/g)].map((m) => m[1]));
const missingIcons = [...usedIcons].filter((i) => !symbols.has(i));
missingIcons.length
  ? fail('Icône utilisée mais absente du sprite', missingIcons)
  : ok(`Toutes les icônes utilisées existent (${symbols.size} symboles)`);

/* 5. Helpers appelés avec un booléen là où une FONCTION est attendue.
   `busy(btn, fn)` enveloppe une opération asynchrone ; l'appeler comme un
   interrupteur (`busy(btn, true)`) donne « fn is not a function » au clic. */
const wrongBusy = [];
lines.forEach((l, i) => {
  if (/\bbusy\(\s*[^,)]+,\s*(true|false)\s*\)/.test(l)) {
    wrongBusy.push(`public/app.js:${i + 1}  busy(…, true/false) — busy attend une fonction à envelopper`);
  }
});
wrongBusy.length ? fail('busy() appelé comme un interrupteur', wrongBusy) : ok('busy() toujours appelé avec une fonction');

/* 6. Icônes passées à emptyState({ icon }) : construites en `#i-${icon}`,
   donc invisibles au contrôle n°4 qui ne voit que les littérales. */
const dynIcons = [...app.matchAll(/emptyState\(\{[^}]*icon:\s*'([\w-]+)'/g)].map((m) => 'i-' + m[1]);
const missingDyn = [...new Set(dynIcons)].filter((i) => !symbols.has(i));
missingDyn.length
  ? fail('Icône dynamique (emptyState) absente du sprite', missingDyn)
  : ok(`Icônes dynamiques d'états vides toutes présentes (${new Set(dynIcons).size})`);

/* 7. <select> de dépôts sans recherche.
   Au-delà de quelques dizaines de projets, un <select> natif est inutilisable :
   toute liste de dépôts doit passer par le combo repoComboHtml (recherche à la
   frappe). On repère un <select> dont le contenu vient de repoOptions. */
const bareRepoSelect = [];
lines.forEach((l, i) => {
  if (/<select[^>]*>.{0,40}repoOptions\.map/.test(l) || /repoOptions\.map[^\n]*<option/.test(l)) {
    bareRepoSelect.push(`public/app.js:${i + 1}  <select> alimenté par repoOptions — utiliser repoComboHtml (recherche)`);
  }
});
bareRepoSelect.length
  ? fail('Liste de dépôts en <select> sans recherche', bareRepoSelect)
  : ok('Toutes les listes de dépôts ont une recherche');

/* 8. Champ de #configForm absent de CONFIG_FIELDS.
   Le formulaire de réglages est ÉCLATÉ sur plusieurs sous-onglets via l'attribut
   HTML `form=`, mais son chargement et son enregistrement itèrent sur une liste
   blanche, CONFIG_FIELDS. Un champ ajouté au HTML sans être ajouté à cette liste
   s'affiche, se saisit… et n'est jamais enregistré, sans la moindre erreur.
   C'est arrivé à jira_email/jira_token, puis à github_url/github_token. */
const declared = new Set(
  [...(app.match(/const CONFIG_FIELDS = \[[^\]]*\]/s) || [''])[0]
    .matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]),
);
// Champs libres du formulaire : on exclut ceux traités à part (cases à cocher,
// nombres) car ils ont leur propre ligne dans le chargement/enregistrement.
const HANDLED_APART = new Set(['auto_refresh_minutes', 'review_explain']);
const orphanFields = [];
for (const m of html.matchAll(/<input[^>]*\bform="configForm"[^>]*>/g)) {
  const tag = m[0];
  const name = (tag.match(/\bname="([a-z0-9_]+)"/) || [])[1];
  if (!name || HANDLED_APART.has(name) || declared.has(name)) continue;
  orphanFields.push(`public/index.html  name="${name}" — absent de CONFIG_FIELDS : le champ ne sera jamais enregistré`);
}
orphanFields.length
  ? fail('Champ de #configForm absent de CONFIG_FIELDS', orphanFields)
  : ok(`Tous les champs de #configForm sont enregistrés (${declared.size} déclarés)`);

console.log('');
if (failures) { console.log(`${failures} contrôle(s) en échec.`); process.exit(1); }
console.log('Contrôles front : OK');
