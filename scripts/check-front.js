#!/usr/bin/env node
'use strict';
/* Contrôles statiques du front — nés de bugs réels, pas de suppositions.

   `node --check` ne les voit pas : ce sont des erreurs de RUNTIME, qui ne se
   déclenchent qu'au clic sur l'écran concerné. D'où ces vérifications.

   LE FRONT SE LIT PAR SON MANIFESTE. Sans build ni modules, la liste des `<script src>` et des
   `<link rel="stylesheet">` d'`index.html` est la seule liste de ce qui est chargé, et dans quel
   ordre — l'ordre des balises est l'ordre d'évaluation. Les contrôles construisent donc le texte
   du front comme la CONCATÉNATION des scripts du manifeste, chacun précédé d'un repère
   `//// js/ecrans/git/merge.js`, et chaque message sort en `public/<fichier>:<ligne>`. Un front
   d'un seul `app.js` et un front de soixante-quinze fichiers se lisent de la même façon : la
   portée d'un script classique est celle d'une concaténation (`function` hissée, `const` avec sa
   zone morte, un nom pris deux fois), et les contrôles n° 10 et n° 14 gardent leur sens exact
   en lisant les fichiers dans l'ordre du manifeste. */
const fs = require('fs');
const path = require('path');
const { PUBLIC, lireHtml, morceauxHtml, manifeste, scriptsApp, lirePublic } = require('../test/helpers/front');

const ROOT = path.join(__dirname, '..');
const html = lireHtml();
const man = manifeste(html);
const nomDe = (rel) => `public/${rel}`;
const existe = (rel) => fs.existsSync(path.join(PUBLIC, rel));

let failures = 0;
const fail = (title, items) => {
  failures++;
  console.log(`\n❌ ${title} (${items.length})`);
  items.forEach((i) => console.log(`   ${i}`));
};
const ok = (t) => console.log(`✅ ${t}`);
const avertir = (title, items) => {
  console.log(`\n⚠️  ${title} (${items.length})`);
  items.forEach((i) => console.log(`   ${i}`));
};

/* LE TEXTE DU FRONT : les scripts de l'application (ce qu'`app.js` contenait — ni les runtimes
   partagés avec Node, ni le dictionnaire, ni le thème du <head>), dans l'ordre du manifeste.
   `lignes` garde pour chaque ligne le fichier d'où elle vient ; `app` est le texte d'un seul
   tenant, pour les contrôles qui cherchent un bloc à cheval sur plusieurs lignes. */
const fichiersApp = scriptsApp(man).filter(existe);
const lignes = fichiersApp.flatMap((f) => lirePublic(f).split('\n').map((texte, i) => ({ f, i: i + 1, texte })));
const app = fichiersApp.map((f) => `//// ${f}\n${lirePublic(f)}`).join('\n');
const ou = (l) => `${nomDe(l.f)}:${l.i}`;

/* 0. LA SYNTAXE, D'ABORD. Le commentaire d'en-tête dit que `node --check` « ne voit pas » ces
   contrôles — c'est vrai, et l'inverse l'est aussi : aucun de ces contrôles ne voit une
   accolade non fermée. Un script qui ne PARSE pas ne s'exécute pas du tout, et l'écran est
   blanc — mais `npm run check` répondait OK, parce que chaque garde-fou lit le fichier comme
   du TEXTE. Vu une fois : une signature de fonction dupliquée sur une seule ligne, invisible
   au garde-fou « fonction redéfinie », qui compare des lignes. C'est le contrôle le moins cher
   du fichier et le seul qui attrape la panne totale : il passe donc en premier. */
{
  const aParser = [...man.scripts, ...(existe('i18n/index.js') ? ['i18n/index.js'] : [])].filter(existe);
  let casse = 0;
  for (const f of aParser) {
    try {
      new (require('vm').Script)(lirePublic(f), { filename: nomDe(f) });
    } catch (e) {
      casse++;
      fail(`${nomDe(f)} ne parse pas — l'application entière ne démarre pas`, [String(e.message)]);
    }
  }
  if (!casse) ok(`Le front parse (${aParser.length} scripts du manifeste)`);
}

/* 1. $ vs $$ — LE bug qui est passé deux fois.
   `$` renvoie UN élément, `$$` un tableau. Appeler .forEach/.map/.filter sur le
   résultat de `$` explose au clic. La cause récurrente : dans une chaîne de
   remplacement JS, `$$` vaut un `$` littéral — insérer du code avec
   String.replace transforme silencieusement tous les `$$` en `$`. */
const singleOnList = [];
lignes.forEach((l) => {
  const m = l.texte.match(/(?<!\$)\$\((['"`][^'"`]*['"`][^)]*)\)\s*\.\s*(forEach|map|filter|some|every|slice|reduce)\b/);
  if (m) singleOnList.push(`${ou(l)}  $(…).${m[2]} — devrait être $$(…)`);
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
lignes.forEach((l) => {
  for (const m of l.texte.matchAll(/\$\$?\('#([\w-]+)'\)/g)) {
    const id = m[1];
    if (!htmlIds.has(id) && !created.has(id)) unknown.push(`${ou(l)}  #${id} n'existe ni dans index.html ni créé en JS`);
  }
});
unknown.length ? fail('Sélecteur pointant un id inconnu', unknown) : ok(`Tous les id référencés existent (${htmlIds.size} dans le HTML)`);

/* 3 bis. Un id porté DEUX FOIS. `$('#x')` rend alors le premier dans l'ordre du document, qui
   n'est pas forcément celui qu'on visait : le bouton se branche sur un autre écran et ne
   répond pas, sans la moindre erreur. Vu en vrai — un « Ajouter » de l'onglet Liens est allé
   se brancher sur l'« Ajouter » des projets liés d'une review. */
const vus = new Map();
for (const m of html.matchAll(/\bid="([\w-]+)"/g)) vus.set(m[1], (vus.get(m[1]) || 0) + 1);
const doubles = [...vus].filter(([, n]) => n > 1).map(([id, n]) => `#${id} apparaît ${n} fois dans index.html`);
doubles.length ? fail('Id porté par plusieurs éléments', doubles) : ok('Aucun id en double dans le HTML');

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
lignes.forEach((l) => {
  if (/\bbusy\(\s*[^,)]+,\s*(true|false)\s*\)/.test(l.texte)) {
    wrongBusy.push(`${ou(l)}  busy(…, true/false) — busy attend une fonction à envelopper`);
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
lignes.forEach((l) => {
  if (/<select[^>]*>.{0,40}repoOptions\.map/.test(l.texte) || /repoOptions\.map[^\n]*<option/.test(l.texte)) {
    bareRepoSelect.push(`${ou(l)}  <select> alimenté par repoOptions — utiliser repoComboHtml (recherche)`);
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
const HANDLED_APART = new Set(['auto_refresh_minutes', 'review_explain', 'brief_on_open', 'auto_post_review', 'auto_post_blocking_only', 'auto_review_new', 'auto_rereview_stale', 'agent_read_unrestricted']);
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

/* 8 bis. …et le trou que laisse cette liste d'exception. `HANDLED_APART` désactive le
   contrôle ci-dessus pour un champ, à charge pour l'auteur d'écrire à la main SES deux
   lignes : une dans `loadConfig` (relecture) et une dans le `submit` (envoi). Écrire la
   première et oublier la seconde donne exactement le défaut que le contrôle n°8 existe pour
   attraper — la case se coche, l'écran dit « enregistré », et rien n'est parti. On vérifie
   donc que chaque nom exempté est bien cité des DEUX côtés. */
// Le submit lit ses champs dans `corpsConfig` (il n'envoie que ce qui a changé) : les deux comptent.
const submitBloc = (app.match(/#configForm'\)\.addEventListener\('submit'[\s\S]*?\n\}\);/) || [''])[0]
  + (app.match(/function corpsConfig\(f\)[\s\S]*?\n\}\n/) || [''])[0];
const loadBloc = (app.match(/async function loadConfig\(\)[\s\S]*?\n\}\n/) || [''])[0];
const demiCables = [];
for (const name of HANDLED_APART) {
  if (!loadBloc.includes(name)) demiCables.push(`public/  ${name} — exempté de CONFIG_FIELDS mais jamais relu dans loadConfig()`);
  if (!submitBloc.includes(name)) demiCables.push(`public/  ${name} — exempté de CONFIG_FIELDS mais jamais envoyé par le submit de #configForm`);
}
demiCables.length
  ? fail('Champ exempté de CONFIG_FIELDS et câblé à moitié', demiCables)
  : ok(`Les ${HANDLED_APART.size} champs traités à part sont relus ET envoyés`);

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
const lostSearch = refPickers.filter(([m]) => !app.includes(m)).map(([m, why]) => `public/  \`${m}\` introuvable — ${why}`);
lignes.forEach((l) => {
  if (/<select[^>]*class=['"][^'"]*git-ref/.test(l.texte)) {
    lostSearch.push(`${ou(l)}  <select> de refs git — utiliser comboHtml('git-ref') (recherche)`);
  }
});
lostSearch.length
  ? fail('Liste de refs git sans recherche', lostSearch)
  : ok('Toutes les listes de refs git ont une recherche');

/* 10. Deux fonctions de même nom au premier niveau du front.
   Les scripts partagent une seule portée globale : une seconde `function foo()` écrase la
   première par hoisting, sans le moindre avertissement — qu'elle soit dans le même fichier
   ou dans un autre. Tous les appels partent alors sur l'autre corps — et sur l'autre
   SIGNATURE. C'est arrivé à toastUndo, redéfini avec (msg, undoLabel, onUndo) alors que
   l'original attendait (msg, onUndo, ms) : le callback d'annulation recevait une chaîne. */
/* Les `const nom = (…) => …` du premier niveau comptent AUSSI, et sont pires : une
   `function` redéclarée écrase silencieusement, un `const` en double est une SyntaxError
   qui empêche le script ENTIER de s'évaluer — plus une seule ligne d'interface ne
   fonctionne. C'est arrivé avec un `fmtDateTime` ajouté en haut du fichier alors qu'il
   existait déjà 3600 lignes plus bas, et ce contrôle ne regardait alors que `function`. */
const DECL = /^(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=)/;
const declaredFns = new Map();
const dupFns = [];
lignes.forEach((l) => {
  const m = l.texte.match(DECL);
  if (!m) return;
  const nom = m[1] || m[2];
  const quoi = m[1] ? `function ${nom}()` : `const ${nom}`;
  const prev = declaredFns.get(nom);
  if (prev) {
    dupFns.push(m[1]
      ? `${ou(l)}  ${quoi} — déjà défini ${ou(prev)} ; la seconde écrase la première`
      : `${ou(l)}  ${quoi} — déjà défini ${ou(prev)} ; SyntaxError, tout le front cesse de s'exécuter`);
  } else declaredFns.set(nom, l);
});
dupFns.length
  ? fail('Fonction redéfinie au premier niveau du front', dupFns)
  : ok(`Aucune fonction du front redéfinie (${declaredFns.size} au premier niveau)`);

/* 11. Fermeture d'une modale au clic sur le fond, écrite à la main.
   `if (e.target.id === 'xModal') close()` a l'air juste et ne l'est pas : un `click` naît
   sur l'ancêtre commun du mousedown et du mouseup, si bien qu'une sélection de texte
   relâchée hors du champ fermait la modale et emportait la saisie. `fermerAuFond()` exige
   que la pression ait commencé sur le fond, et refuse d'emporter une saisie en cours.
   La règle vaut aussi pour les modales à venir : elles doivent passer par le même chemin. */
const fondManuel = [];
lignes.forEach((l) => {
  const m = l.texte.match(/e\.target\.id === '(\w*[Mm]odal)'/);
  if (m) fondManuel.push(`${ou(l)}  clic sur le fond de #${m[1]} — passer par fermerAuFond()`);
});
// …et chaque modale déclarée doit exister : un id mal orthographié ne lève aucune erreur,
// la modale ne se ferme simplement plus au clic sur le fond.
const fondInconnu = [];
for (const m of app.matchAll(/fermerAuFond\('#(\w+)'/g)) {
  if (!html.includes(`id="${m[1]}"`)) fondInconnu.push(`public/  fermerAuFond('#${m[1]}') — cet id n'existe pas dans index.html`);
}
const fondKo = [...fondManuel, ...fondInconnu];
fondKo.length
  ? fail('Fermeture au clic sur le fond', fondKo)
  : ok(`Toutes les modales se ferment au fond par fermerAuFond() (${[...app.matchAll(/fermerAuFond\('#/g)].length})`);

/* 13. Une liste à cocher de skills, de sous-agents, de dépôts ou d'agents sans son filtre.
   Même raison que les contrôles 7 et 9, pour les listes qu'ont amenées les agents : un home
   d'utilisateur porte vite trente skills, et un parc, vingt dépôts. Le filtre doit être un
   FRÈRE de la liste (même parent) et son id se terminer par `Filter` — c'est la convention
   que suit `filtrerLignes()`, qui reçoit le couple. Une liste rendue sans lui redevient un
   mur de cases où l'on cherche à l'œil. */
const LISTES_A_FILTRER = ['skillList', 'taskSkills', 'taskSubagents', 'agentSkills', 'agentRepos', 'domainRepos'];
const sansFiltre = [];
for (const id of LISTES_A_FILTRER) {
  const re = new RegExp(`<[^>]*\\bid="${id}"[^>]*>`);
  const m = html.match(re);
  if (!m) continue;                                   // liste pas encore posée : rien à exiger
  // Le parent : le dernier <div ...> ouvert avant la liste, et ce qu'il contient jusqu'à elle.
  const avant = html.slice(0, html.indexOf(m[0]));
  const debutParent = avant.lastIndexOf('<div');
  const bloc = html.slice(debutParent, html.indexOf(m[0]) + m[0].length);
  if (!/<input[^>]*\bid="[\w-]*Filter"/.test(bloc)) {
    sansFiltre.push(`public/index.html  #${id} — aucun <input id="…Filter"> frère : la liste n'a pas de recherche`);
  }
}
sansFiltre.length
  ? fail('Liste à cocher sans champ de recherche', sansFiltre)
  : ok(`Toutes les listes à cocher ont leur filtre (${LISTES_A_FILTRER.filter((id) => html.includes(`id="${id}"`)).length})`);

/* 14. Un helper de premier niveau APPELÉ plus haut que sa déclaration `const`.
   Les scripts forment une seule portée globale, évaluée dans l'ordre du manifeste : les
   instructions de premier niveau s'exécutent dans l'ordre du texte, et un `const` n'existe
   qu'à partir de sa ligne. Un appel écrit plus haut — dans le même fichier ou dans un fichier
   chargé AVANT — lève « Cannot access X before initialization » — non pas au clic, mais
   PENDANT l'évaluation : tout ce qui suit cesse d'exister, et l'écran est mort dans son
   ensemble. Le contrôle n°10 ne voit que les doublons ; celui-ci voit l'ordre. Vu en vrai
   avec un `onEl` déclaré au milieu du fichier et utilisé mille lignes plus haut. Le remède est
   une déclaration de fonction, qui est hissée — ou, entre deux fichiers, `core/` en tête. */
const declLine = new Map();
const fnLine = new Map();
lignes.forEach((l, n) => {
  const m = l.texte.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
  if (m && !declLine.has(m[1])) declLine.set(m[1], n);
  const f = l.texte.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (f && !fnLine.has(f[1])) fnLine.set(f[1], n);
});
const avantDecl = [];
lignes.forEach((l, n) => {
  // Un APPEL en tout début de ligne : c'est la forme d'un câblage de premier niveau.
  const m = l.texte.match(/^([A-Za-z_$][\w$]*)\(/);
  if (!m) return;
  const decl = declLine.get(m[1]);
  if (decl != null && decl > n) {
    avantDecl.push(`${ou(l)}  ${m[1]}(…) appelé avant sa déclaration ${ou(lignes[decl])} — déclarer \`function ${m[1]}()\` (hissée)`);
  }
  /* Une `function` n'est hissée que DANS SON SCRIPT : appelée au chargement depuis un fichier
     évalué avant celui qui la déclare, c'est « X is not defined » — même panne, autre remède :
     charger le fichier qui déclare avant celui qui appelle. */
  const fn = fnLine.get(m[1]);
  if (fn != null && lignes[fn].f !== l.f && fn > n) {
    avantDecl.push(`${ou(l)}  ${m[1]}(…) appelé au chargement, déclaré ${ou(lignes[fn])} — un fichier chargé APRÈS : reculer l'appelant dans le manifeste`);
  }
});
/* La même panne par un OBJET DE PREMIER NIVEAU qui cite des fonctions (`const ADMIN_SUBS =
   { rules: loadRules, … }`) : le littéral s'évalue au chargement, et chaque nom cité doit déjà
   exister. On ne lit que les objets et tableaux littéraux, hors lignes de fonction. */
{
  let dans = null;
  lignes.forEach((l, n) => {
    if (/^(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*[[{]\s*$/.test(l.texte)) { dans = l; return; }
    if (!dans) return;
    if (/^[\]}]/.test(l.texte)) { dans = null; return; }
    if (/=>|\bfunction\b|^\s*(\/\/|\/\*|\*)/.test(l.texte)) return;
    for (const m of l.texte.matchAll(/(?<![.\w$'"])([A-Za-z_$][\w$]*)\b(?!\s*:)/g)) {
      const fn = fnLine.get(m[1]);
      if (fn != null && lignes[fn].f !== l.f && fn > n) {
        avantDecl.push(`${ou(l)}  ${m[1]} cité dans un littéral évalué au chargement, déclaré ${ou(lignes[fn])} — un fichier chargé APRÈS`);
      }
    }
  });
}
avantDecl.length
  ? fail('Helper appelé avant sa déclaration (l’évaluation du front s’arrête là)', avantDecl)
  : ok('Aucun helper de premier niveau appelé avant sa déclaration');

/* LES VERROUS DE SÉCURITÉ DE L'ÉCRAN (guard.md). Chacun fige un zéro atteint : une régression
   ici redonne à une page tierce ou à un texte venu d'ailleurs le moyen d'exécuter du code.
   — aucun gestionnaire `on…=` en attribut, aucun `<script>` en ligne : la CSP n'en admet pas ;
   — toute URL interpolée dans un `href`/`src` passe par `safeUrl`/`safeImg` (sinon `javascript:`) ;
   — tout `target="_blank"` porte un `rel` (sinon la page ouverte pilote la nôtre). */
{
  const soucis = [];
  const textes = [...lignes.map((l) => [ou(l), l.texte]), ...html.split('\n').map((t, i) => [`public/index.html:${i + 1}`, t])];
  for (const [nom, l] of textes) {
    if (/<[a-z][^>]*\son[a-z]+\s*=\s*["'{]/i.test(l)) soucis.push(`${nom}  gestionnaire en attribut : ${l.trim().slice(0, 90)}`);
    if (/(?<![\w-])(href|src)="\$\{(?!\s*(esc\()?\s*(safeUrl|safeImg)\()/.test(l)) soucis.push(`${nom}  URL interpolée sans safeUrl/safeImg : ${l.trim().slice(0, 90)}`);
    // …et la même URL construite par CONCATÉNATION (`'href="' + esc(url) + '"'`), qui échappait au motif.
    if (/(?<![\w-])(href|src)="'\s*\+(?!\s*(esc\()?\s*(safeUrl|safeImg)\()/.test(l)) soucis.push(`${nom}  URL concaténée sans safeUrl/safeImg : ${l.trim().slice(0, 90)}`);
    if (/target="_blank"/.test(l) && !/rel=/.test(l)) soucis.push(`${nom}  target="_blank" sans rel : ${l.trim().slice(0, 90)}`);
  }
  const enLigne = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].length;
  if (enLigne) soucis.push(`public/index.html  ${enLigne} <script> en ligne — la CSP les refuse, mettez le code dans un fichier`);
  soucis.length
    ? fail('Verrous de sécurité de l’écran (guard.md)', soucis)
    : ok('Aucun gestionnaire en attribut ni script en ligne ; URLs via safeUrl ; _blank avec rel');
}

/* ======================================================================================
   LE MANIFESTE ET L'ARBORESCENCE (réorganisation de public/ par écran et par couche). Les
   cinq contrôles qui suivent gardent ce qu'un dossier de fichiers courts rend possible — et
   ce qu'il rend possible de casser en silence. Sur un front d'un seul `app.js`, ils n'ont rien
   à dire et le disent : c'est ainsi qu'on a prouvé qu'ils ne changent pas le sens des autres.
   ====================================================================================== */

function tousLes(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tousLes(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(path.relative(PUBLIC, p).split(path.sep).join('/'));
  }
  return out;
}

/* (a) LE MANIFESTE ET LE DISQUE COÏNCIDENT. Un fichier de `js/`, `css/`, `i18n/` ou `runtime/`
   qui n'est pas cité est un écran mort en silence — et un morceau de `html/` que la coquille
   n'inclut pas (`<!--@include html/…-->`), un onglet ou une modale absents de la page servie — le pendant du « nouveau fichier non
   `git add`-é » de la relecture CI ; une balise qui vise un fichier absent est un 404 que seul
   le navigateur voit. Cité UNE fois : deux fois, un script s'évalue deux fois et un `const`
   en double arrête tout. Les exceptions sont nommées, avec ce qui les charge à la place. */
{
  const HORS_MANIFESTE = {
    'i18n/index.js': 'assemblage pour Node, jamais chargé par le navigateur',
  };
  const surDisque = [
    ...tousLes(path.join(PUBLIC, 'js'), '.js'), ...tousLes(path.join(PUBLIC, 'i18n'), '.js'),
    ...tousLes(path.join(PUBLIC, 'runtime'), '.js'), ...tousLes(path.join(PUBLIC, 'css'), '.css'),
  ];
  const morceaux = morceauxHtml();
  surDisque.push(...tousLes(path.join(PUBLIC, 'html'), '.html'));
  const cites = [...man.scripts, ...man.styles, ...morceaux];
  const compte = new Map();
  for (const c of cites) compte.set(c, (compte.get(c) || 0) + 1);
  const soucis = [];
  for (const f of surDisque) {
    const n = compte.get(f) || 0;
    if (n === 0 && !HORS_MANIFESTE[f]) soucis.push(`${nomDe(f)}  sur le disque, absent du manifeste — jamais chargé`);
    if (n > 1) soucis.push(`${nomDe(f)}  cité ${n} fois dans index.html — ${f.startsWith('html/') ? 'inclus' : 'évalué'} ${n} fois`);
    if (n && HORS_MANIFESTE[f]) soucis.push(`${nomDe(f)}  cité dans le manifeste alors qu'il est ${HORS_MANIFESTE[f]}`);
  }
  for (const c of cites) if (!existe(c)) soucis.push(`public/index.html  <${c.endsWith('.css') ? 'link' : c.endsWith('.html') ? '!--@include' : 'script'}> vise /${c}, qui n'existe pas`);
  for (const [f, pourquoi] of Object.entries(HORS_MANIFESTE)) if (!existe(f) && existe(path.dirname(f))) soucis.push(`${nomDe(f)}  nommé hors manifeste (${pourquoi}) mais absent du disque — retirer l'exception`);
  soucis.length
    ? fail('Le manifeste et le disque ne coïncident pas', soucis)
    : ok(`Le manifeste et le disque coïncident (${man.scripts.length} scripts, ${man.styles.length} feuilles, ${morceaux.length} morceaux de page, ${Object.keys(HORS_MANIFESTE).filter(existe).length} hors manifeste nommés)`);
}

/* (e) `'use strict';` EN TÊTE DE CHAQUE FICHIER. La directive en tête d'`app.js` couvrait
   vingt-cinq mille lignes ; découpé, un fichier sans directive tourne en mode relâché — une
   affectation à une variable non déclarée y crée un global au lieu de lever. C'est le seul
   changement de comportement possible d'un découpage, et il est silencieux. Première
   instruction du fichier, après son commentaire d'en-tête. */
{
  const premiereInstruction = (texte) => {
    const ls = texte.split('\n');
    let dans = false;
    for (const l of ls) {
      let t = l.trim();
      if (dans) { if (!t.includes('*/')) continue; t = t.slice(t.indexOf('*/') + 2).trim(); dans = false; }
      while (t.startsWith('/*')) {
        const fin = t.indexOf('*/', 2);
        if (fin === -1) { dans = true; t = ''; break; }
        t = t.slice(fin + 2).trim();
      }
      if (!t || t.startsWith('//')) continue;
      return t;
    }
    return '';
  };
  const relaches = [];
  const aVerifier = [...tousLes(path.join(PUBLIC, 'js'), '.js'), ...tousLes(path.join(PUBLIC, 'i18n'), '.js'), ...tousLes(path.join(PUBLIC, 'runtime'), '.js'), ...fichiersApp.filter((f) => !f.includes('/'))];
  for (const f of new Set(aVerifier)) {
    if (!/^'use strict';?$/.test(premiereInstruction(lirePublic(f)))) relaches.push(`${nomDe(f)}  ne commence pas par 'use strict' — mode relâché, une faute de frappe crée un global`);
  }
  relaches.length
    ? fail('Fichier du front sans \'use strict\' en tête', relaches)
    : ok(`'use strict' en tête de chaque fichier (${new Set(aVerifier).size})`);
}

/* (b) LA TAILLE D'UN FICHIER SE SURVEILLE — la règle de `check-server.js`, mot pour mot :
   avertissement passé 600 lignes de code, échec passé 1 200, les commentaires non comptés. Les
   exceptions sont NOMMÉES et ne font que disparaître. */
{
  const AVERTIR = 600;
  const ECHOUER = 1200;
  const EXCEPTIONS = [];
  const compter = (code) => code.split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)).length;
  const gros = [];
  const trop = [];
  for (const f of tousLes(path.join(PUBLIC, 'js'), '.js')) {
    const n = compter(lirePublic(f));
    if (n > ECHOUER && !EXCEPTIONS.includes(f)) trop.push(`${nomDe(f)}  ${n} lignes de code — à découper (seuil ${ECHOUER})`);
    else if (n > AVERTIR) gros.push(`${nomDe(f)}  ${n} lignes de code${n > ECHOUER ? ' (exception nommée)' : ''}`);
  }
  if (trop.length) fail(`Fichiers de js/ au-delà de ${ECHOUER} lignes de code, hors exceptions nommées`, trop);
  if (gros.length) avertir(`Fichiers de js/ au-delà de ${AVERTIR} lignes de code — à découper avant la prochaine fonctionnalité`, gros);
  if (!trop.length) ok(`Aucun fichier de js/ ne dépasse ${ECHOUER} lignes de code hors exceptions (${EXCEPTIONS.length} nommées, ${gros.length} au-delà de ${AVERTIR})`);
}

/* (d) AUCUN ORDRE CASSÉ PAR LE MANIFESTE. Le dictionnaire avant le moteur qui le lit, les
   runtimes avant l'application, `core/` — ce que tout le monde appelle et qui n'appelle
   personne — en tête de `js/`, `demarrage.js` en dernier : c'est lui qui câble, et il appelle
   ce qu'il veut. */
{
  const js = man.scripts.filter((s) => s.startsWith('js/') && !/theme-early\.js$/.test(s));
  const soucis = [];
  if (js.length) {
    const premierNonCore = js.findIndex((s) => !s.startsWith('js/core/'));
    js.forEach((s, i) => { if (s.startsWith('js/core/') && premierNonCore !== -1 && i > premierNonCore) soucis.push(`${nomDe(s)}  core/ chargé après ${nomDe(js[premierNonCore])} — core/ vient en tête`); });
    const dem = js.indexOf('js/demarrage.js');
    if (dem === -1) soucis.push('public/js/demarrage.js  absent du manifeste — rien ne câble l’application');
    else if (dem !== js.length - 1) soucis.push(`${nomDe(js[js.length - 1])}  chargé après js/demarrage.js — demarrage.js est le dernier script de js/`);
    const idx = (re) => man.scripts.findIndex((s) => re.test(s));
    const dernier = (re) => man.scripts.length - 1 - [...man.scripts].reverse().findIndex((s) => re.test(s));
    if (idx(/^runtime\//) !== -1 && idx(/^i18n\//) !== -1 && dernier(/^i18n\//) > idx(/^runtime\//)) soucis.push('public/index.html  un fichier de i18n/ est chargé après runtime/ — le dictionnaire précède le moteur');
    if (idx(/^runtime\//) !== -1 && dernier(/^runtime\//) > idx(/^js\/core\//)) soucis.push('public/index.html  un fichier de runtime/ est chargé après js/core/ — les runtimes précèdent l’application');
  }
  soucis.length ? fail('Ordre du manifeste', soucis) : ok(js.length ? `L'ordre du manifeste tient (core/ en tête, demarrage.js en dernier, ${js.length} scripts de js/)` : 'Ordre du manifeste : un seul script, rien à ordonner');
}

/* (c) LA DIRECTION DES DÉPENDANCES, ET LES PORTS.

       core  ←  transverse  ←  ecrans/<x>  ←  demarrage
                                 ↕ (entre écrans : par les PORTS déclarés)

   `core/` n'appelle que `core/` ; `transverse/` appelle `core/` et les ports des écrans ;
   un écran appelle `core/`, `transverse/`, son propre dossier — et les PORTS d'un autre écran,
   jamais son intérieur ; `demarrage.js` appelle ce qu'il veut, personne ne l'appelle. Un port
   est un nom déclaré en tête du fichier qui le définit : `// @expose nom1, nom2`. L'état global
   (`let`) obéit à la même règle : une variable lue depuis un autre dossier est un port, ou une
   erreur. Un port que personne d'autre n'appelle est une promesse : il s'enlève — sauf s'il est
   appelé par un test d'écran (`page.evaluate(() => loadTasks())`), qui est un appelant comme
   un autre.

   Le jour où un dossier passe en modules ES, ses `@expose` sont ses `export` et ses usages de
   `core/` ses `import` : la liste est déjà exacte. */
{
  const fichiersJs = fichiersApp.filter((f) => f.startsWith('js/'));
  const dossier = (f) => {
    if (f === 'js/demarrage.js') return { genre: 'demarrage', cle: 'demarrage' };
    const m = f.match(/^js\/(core|transverse)\//);
    if (m) return { genre: m[1], cle: m[1] };
    const e = f.match(/^js\/ecrans\/([^/]+)\//);
    if (e) return { genre: 'ecran', cle: `ecrans/${e[1]}` };
    return { genre: 'autre', cle: f };
  };
  /* Le texte sans ses commentaires ni ses chaînes simples — les gabarits (`…${x}…`) restent :
     leurs `${}` sont de vrais usages. Un mot dans le texte d'un gabarit qui serait aussi un nom
     de fonction compte donc comme un usage : rare, et il se règle par un `@expose` de plus. */
  const depouiller = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const declPar = new Map();      // nom → fichier
  const exposePar = new Map();    // fichier → Set(noms)
  const textes = new Map();
  for (const f of fichiersJs) {
    const texte = lirePublic(f);
    textes.set(f, texte);
    for (const l of texte.split('\n')) {
      const m = l.match(DECL);
      if (m && !declPar.has(m[1] || m[2])) declPar.set(m[1] || m[2], f);
    }
    const ex = new Set();
    for (const m of texte.matchAll(/^\/\/ @expose\s+(.+)$/gm)) m[1].split(',').map((x) => x.trim()).filter(Boolean).forEach((n) => ex.add(n));
    exposePar.set(f, ex);
  }
  /* LES ARÊTES TOLÉRÉES, une par une, avec leur motif — la règle de `check-deps.js`. La liste
     ne peut que rétrécir. */
  const EXCEPTIONS = [
    /* `explainError` traduit l'échec d'une action en un remède — et un remède est une porte vers
       un écran (« ouvrir la session », « aller aux réglages Git ») : il connaît donc les écrans,
       et vit en transverse/. Mais c'est aussi ce qu'affiche `toast` sur toute erreur, depuis le
       socle. Tolérée le temps de séparer le message (socle) de ses portes (transverse). */
    { nom: 'explainError', depuis: 'core', motif: 'le remède d’une erreur connaît les écrans ; le message, lui, est appelé du socle' },
  ];
  const toleree = (nom, genre) => EXCEPTIONS.some((e) => e.nom === nom && e.depuis === genre);
  const exceptionsVues = new Set();
  const soucis = [];
  const portsUtilises = new Map();  // fichier → Set(noms utilisés d'ailleurs)
  for (const f of fichiersJs) {
    const de = dossier(f);
    const vus = new Set();
    for (const m of depouiller(textes.get(f)).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) vus.add(m[1]);
    for (const nom of vus) {
      const d = declPar.get(nom);
      if (!d || d === f) continue;
      const vers = dossier(d);
      const meme = vers.cle === de.cle;
      if (de.genre === 'core' && vers.genre !== 'core' && toleree(nom, 'core')) { exceptionsVues.add(nom); continue; }
      if (de.genre === 'core' && vers.genre !== 'core') { soucis.push(`${nomDe(f)}  utilise ${nom} (${d}) — core/ n'appelle que core/`); continue; }
      if (vers.genre === 'demarrage') { soucis.push(`${nomDe(f)}  utilise ${nom} (${d}) — personne n'appelle demarrage.js`); continue; }
      if (vers.genre === 'core' || vers.genre === 'transverse' || meme) continue;
      // Un écran, appelé depuis un autre dossier : par un port déclaré, ou pas du tout.
      if (!portsUtilises.has(d)) portsUtilises.set(d, new Set());
      portsUtilises.get(d).add(nom);
      if (!exposePar.get(d).has(nom)) soucis.push(`${nomDe(f)}  utilise ${nom} (${d}) — non exposé : ajouter \`// @expose ${nom}\` en tête de ${d}`);
    }
  }
  /* Les ports que les tests d'écran appellent par `page.evaluate` : des appelants légitimes. */
  const motsTests = new Set();
  const TEST = path.join(ROOT, 'test');
  for (const t of fs.readdirSync(TEST).filter((x) => x.endsWith('.test.js'))) {
    for (const m of fs.readFileSync(path.join(TEST, t), 'utf8').matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) motsTests.add(m[1]);
    for (const m of fs.readFileSync(path.join(TEST, t), 'utf8').matchAll(/window\.([A-Za-z_$][\w$]*)/g)) motsTests.add(m[1]);
  }
  for (const [f, ex] of exposePar) {
    if (dossier(f).genre !== 'ecran' && ex.size) soucis.push(`${nomDe(f)}  porte un @expose — seuls les écrans déclarent des ports (core/ et transverse/ sont visibles de tous)`);
    for (const nom of ex) {
      if (!declPar.has(nom) || declPar.get(nom) !== f) soucis.push(`${nomDe(f)}  @expose ${nom} — pas une déclaration de premier niveau de ce fichier`);
      else if (!(portsUtilises.get(f) || new Set()).has(nom) && !motsTests.has(nom)) soucis.push(`${nomDe(f)}  @expose ${nom} — personne d'ailleurs ne l'appelle : une promesse, à retirer`);
    }
  }
  for (const e of EXCEPTIONS) if (fichiersJs.length && !exceptionsVues.has(e.nom)) soucis.push(`scripts/check-front.js  exception « ${e.nom} » sans usage : à retirer de la liste`);
  const nPorts = [...exposePar.values()].reduce((n, s) => n + s.size, 0);
  soucis.length
    ? fail('Direction des dépendances et ports du front', soucis)
    : ok(fichiersJs.length ? `Chaque usage respecte la direction core ← transverse ← ecrans ← demarrage (${fichiersJs.length} fichiers, ${nPorts} ports)` : 'Direction des dépendances : un seul script, rien à ordonner');
}

console.log('');
if (failures) { console.log(`${failures} contrôle(s) en échec.`); process.exit(1); }
console.log('Contrôles front : OK');
