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
const HANDLED_APART = new Set(['auto_refresh_minutes', 'review_explain', 'brief_on_open', 'health_check']);
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

/* 9. Liste de refs git sans recherche.
   Même raison que le contrôle n°7 pour les dépôts : un dépôt actif compte souvent des
   centaines de branches. Un <select> natif ou une liste à cocher sans filtre y devient
   impraticable — c'est ce qu'était l'onglet Git → Actions. Les trois listes où l'on
   CHOISIT une branche doivent donc garder leur recherche. */
// On cherche l'endroit qui CRÉE le champ, pas une mention de sa classe ailleurs : sinon
// le gestionnaire d'événement suffirait à faire passer le contrôle alors que le champ
// n'est plus rendu nulle part.
const refPickers = [
  ["comboHtml('git-ref'", 'la ref source (Git → Actions) doit être un combo avec recherche'],
  ['class="search git-ref-filter"', 'la liste des refs à supprimer (Git → Actions) doit garder son champ de recherche'],
  ['class="search git-ex-filter"', 'le tableau de branches (Git → Explorateur) doit garder son champ de recherche'],
];
const lostSearch = refPickers.filter(([m]) => !app.includes(m)).map(([m, why]) => `public/app.js  \`${m}\` introuvable — ${why}`);
lines.forEach((l, i) => {
  if (/<select[^>]*class=['"][^'"]*git-ref/.test(l)) {
    lostSearch.push(`public/app.js:${i + 1}  <select> de refs git — utiliser comboHtml('git-ref') (recherche)`);
  }
});
lostSearch.length
  ? fail('Liste de refs git sans recherche', lostSearch)
  : ok('Toutes les listes de refs git ont une recherche');

/* 10. Deux fonctions de même nom au premier niveau d'app.js.
   Le fichier est un seul script global : une seconde `function foo()` écrase la
   première par hoisting, sans le moindre avertissement. Tous les appels partent
   alors sur l'autre corps — et sur l'autre SIGNATURE. C'est arrivé à toastUndo,
   redéfini avec (msg, undoLabel, onUndo) alors que l'original attendait
   (msg, onUndo, ms) : le callback d'annulation recevait une chaîne. */
/* Les `const nom = (…) => …` du premier niveau comptent AUSSI, et sont pires : une
   `function` redéclarée écrase silencieusement, un `const` en double est une SyntaxError
   qui empêche le script ENTIER de s'évaluer — plus une seule ligne d'interface ne
   fonctionne. C'est arrivé avec un `fmtDateTime` ajouté en haut du fichier alors qu'il
   existait déjà 3600 lignes plus bas, et ce contrôle ne regardait alors que `function`. */
const declaredFns = new Map();
const dupFns = [];
lines.forEach((l, i) => {
  const m = l.match(/^(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)/);
  if (!m) return;
  const nom = m[1] || m[2];
  const quoi = m[1] ? `function ${nom}()` : `const ${nom}`;
  const prev = declaredFns.get(nom);
  if (prev) {
    dupFns.push(m[1]
      ? `public/app.js:${i + 1}  ${quoi} — déjà défini ligne ${prev} ; la seconde écrase la première`
      : `public/app.js:${i + 1}  ${quoi} — déjà défini ligne ${prev} ; SyntaxError, tout app.js cesse de s'exécuter`);
  } else declaredFns.set(nom, i + 1);
});
dupFns.length
  ? fail('Fonction redéfinie au premier niveau d’app.js', dupFns)
  : ok(`Aucune fonction d'app.js redéfinie (${declaredFns.size} au premier niveau)`);

/* 11. Fermeture d'une modale au clic sur le fond, écrite à la main.
   `if (e.target.id === 'xModal') close()` a l'air juste et ne l'est pas : un `click` naît
   sur l'ancêtre commun du mousedown et du mouseup, si bien qu'une sélection de texte
   relâchée hors du champ fermait la modale et emportait la saisie. `fermerAuFond()` exige
   que la pression ait commencé sur le fond, et refuse d'emporter une saisie en cours.
   La règle vaut aussi pour les modales à venir : elles doivent passer par le même chemin. */
const fondManuel = [];
lines.forEach((l, i) => {
  const m = l.match(/e\.target\.id === '(\w*[Mm]odal)'/);
  if (m) fondManuel.push(`public/app.js:${i + 1}  clic sur le fond de #${m[1]} — passer par fermerAuFond()`);
});
// …et chaque modale déclarée doit exister : un id mal orthographié ne lève aucune erreur,
// la modale ne se ferme simplement plus au clic sur le fond.
const fondInconnu = [];
for (const m of app.matchAll(/fermerAuFond\('#(\w+)'/g)) {
  if (!html.includes(`id="${m[1]}"`)) fondInconnu.push(`public/app.js  fermerAuFond('#${m[1]}') — cet id n'existe pas dans index.html`);
}
const fondKo = [...fondManuel, ...fondInconnu];
fondKo.length
  ? fail('Fermeture au clic sur le fond', fondKo)
  : ok(`Toutes les modales se ferment au fond par fermerAuFond() (${[...app.matchAll(/fermerAuFond\('#/g)].length})`);

console.log('');
if (failures) { console.log(`${failures} contrôle(s) en échec.`); process.exit(1); }
console.log('Contrôles front : OK');
