#!/usr/bin/env node
'use strict';
/* Contrôles statiques du serveur — nés de bugs réels, pas de suppositions.

   LE bug récurrent : la fonction de traduction du serveur s'appelle `t`. Dès qu'une
   variable locale, un paramètre de callback ou une boucle réutilise ce nom, tous les
   `t('err.…')` du bloc appellent l'objet local au lieu de traduire. Le symptôme est
   « t is not a function », loin de sa cause, et UNIQUEMENT sur le chemin d'erreur —
   donc invisible aux tests du chemin nominal et à `node --check`.

   C'est arrivé trois fois : sur six routes de session, puis sur `normalizeTargets`.
   D'où cette règle, simple et vérifiable : dans un fichier qui importe `t`, le nom `t`
   n'appartient qu'à la traduction. Renommer une variable locale coûte cinq secondes ;
   retrouver ce bug en coûte beaucoup plus.

   TOUS LES CONTRÔLES PARCOURENT `src/` RÉCURSIVEMENT et retrouvent les fichiers qu'ils
   inspectent par leur CONTENU, pas par un chemin écrit en dur : un module déplacé dans un
   sous-dossier (refacto.md) reste sous contrôle. Un contrôle qui lirait `src/config.js` en
   dur cesserait de voir le fichier le jour où il devient `src/data/config.js`, sans le dire. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Argument optionnel : un autre dossier `src` — permet d'auditer une autre branche
// (`git archive main src | tar -x -C /tmp/x` puis `node scripts/check-server.js /tmp/x/src`).
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src');

let failures = 0;
const fail = (title, items) => {
  failures++;
  console.log(`\n❌ ${title} (${items.length})`);
  items.forEach((i) => console.log(`   ${i}`));
};
const ok = (msg) => console.log(`✅ ${msg}`);
const avertir = (title, items) => {
  console.log(`\n⚠️  ${title} (${items.length})`);
  items.forEach((i) => console.log(`   ${i}`));
};

/* Tous les `.js` sous un dossier, en chemins relatifs à `src/` (`app/routes/mrs.js`). */
function tousLesJs(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tousLesJs(p, base, out);
    else if (e.name.endsWith('.js')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
const fichiers = tousLesJs(SRC);
const lire = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const nomDe = (rel) => `src/${rel}`;

/* LE FICHIER QUI PORTE UN MARQUEUR — et un seul. Deux fichiers qui le portent, ou aucun, c'est
   une erreur qu'on veut voir, pas un contrôle qui se tait. */
function fichierUnique(marqueur, quoi) {
  const trouves = fichiers.filter((f) => marqueur.test(lire(f)));
  if (trouves.length === 1) return trouves[0];
  fail(`${quoi} : ${trouves.length ? 'plusieurs fichiers le portent' : 'aucun fichier ne le porte'}`, trouves.map(nomDe));
  return null;
}

/* Résout un `require` relatif comme Node : tel quel, puis `.js`, puis `/index.js`. Rend un
   chemin relatif à `src/`, ou null hors de `src/` (`../public/i18n-runtime.js`). */
function resoudre(depuisRel, rel) {
  const base = path.resolve(SRC, path.dirname(depuisRel), rel);
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const r = path.relative(SRC, c);
      return r.startsWith('..') ? null : r.split(path.sep).join('/');
    }
  }
  return null;
}
const requiresDe = (rel) => [...lire(rel).matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)].map((m) => m[2]);

/* 0. LA SYNTAXE, D'ABORD — même raison que côté front. Tous les contrôles de ce fichier lisent
   le serveur comme du TEXTE : une accolade non fermée leur échappe entièrement, et
   `npm run check` répondait OK sur un `server.js` que Node refuse de charger. Le symptôme est
   alors une suite de tests qui se BLOQUE (le hook de démarrage échoue avant tout log), ce qui
   ressemble à une lenteur et coûte une demi-heure à diagnostiquer. Vu une fois : une
   substitution qui avait mangé le `}` d'un `if`. */
for (const f of fichiers) {
  try {
    new (require('vm').Script)(lire(f), { filename: f });
  } catch (e) {
    fail(`${nomDe(f)} ne parse pas — le serveur ne démarre pas`, [String(e.message)]);
  }
}
if (!failures) ok(`Le serveur parse (${fichiers.length} fichiers)`);

/* Formes qui LIENT le nom `t` : déclaration, paramètre unique de flèche, premier
   paramètre, boucle for…of. On ne cherche pas à parser le JS — ces quatre formes
   couvrent tout ce qu'on écrit ici, et un faux positif se règle en renommant. */
const LIAISONS = [
  { re: /\b(?:const|let|var)\s+t\s*=/, quoi: 'déclaration `t =`' },
  { re: /\(\s*t\s*\)\s*=>/, quoi: 'paramètre de flèche `(t) =>`' },
  { re: /\(\s*t\s*,[^)]*\)\s*=>/, quoi: 'premier paramètre `(t, …) =>`' },
  { re: /\bfor\s*\(\s*(?:const|let|var)\s+t\s+(?:of|in)\b/, quoi: 'boucle `for (const t of …)`' },
  { re: /\bfunction\s*[\w$]*\s*\(\s*t\s*[,)]/, quoi: 'paramètre de fonction `function (t…)`' },
];

/* Un fichier TRADUIT s'il importe le dictionnaire : `public/i18n-runtime.js` directement, ou
   `core/i18n.js`, qui le ré-exporte pour que la profondeur du dossier n'entre pas en compte. */
const IMPORTE_T = /require\(['"][^'"]*(?:i18n-runtime|\/i18n)(?:\.js)?['"]\)/;
const coupables = [];
for (const f of fichiers) {
  const code = lire(f);
  // Seuls les fichiers qui TRADUISENT sont concernés : ailleurs, `t` est un nom libre.
  if (!IMPORTE_T.test(code)) continue;
  code.split('\n').forEach((ligne, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ligne)) return;           // commentaires
    for (const { re, quoi } of LIAISONS) {
      if (re.test(ligne)) coupables.push(`${nomDe(f)}:${i + 1}  ${quoi} — ${ligne.trim().slice(0, 88)}`);
    }
  });
}

coupables.length
  ? fail('Le nom `t` est réutilisé dans un fichier qui traduit (il masque la traduction)', coupables)
  : ok(`Le nom \`t\` reste la traduction (${fichiers.length} fichiers examinés)`);

/* LES FICHIERS QUE PLUSIEURS CONTRÔLES RELISENT, retrouvés par ce qu'ils contiennent. */
const F_CONFIG = fichierUnique(/const ALLOWED = \[/, 'Le module de configuration (`const ALLOWED = [`)');
const F_REGISTRE = fichierUnique(/^const REGISTRE = \[/m, 'Le registre des familles (`const REGISTRE = [`)');
const F_STORE = fichierUnique(/^function validerDocument\(/m, 'La couche store (`function validerDocument(`)');
const registre = F_REGISTRE && require(path.join(SRC, F_REGISTRE));

/* LE SCHÉMA, dans l'ordre où il se joue. Un seul `db.js` aujourd'hui ; demain `db/` — la
   réparation, puis `schema/` dans l'ordre numérique, puis `migrations/`, puis `index.js`. Les
   contrôles le lisent comme UN texte, en gardant pour chaque ligne le fichier d'où elle vient. */
const FICHIERS_DB = (() => {
  if (fichiers.includes('db.js')) return ['db.js'];
  const sous = fichiers.filter((f) => f.startsWith('db/'));
  const ordre = (f) => (f === 'db/reparation.js' ? 0 : f.startsWith('db/schema/') ? 1 : f.startsWith('db/migrations/') ? 2 : 3);
  return sous.sort((a, b) => ordre(a) - ordre(b) || a.localeCompare(b));
})();
const lignesDb = FICHIERS_DB.flatMap((f) => lire(f).split('\n').map((texte, i) => ({ f, i: i + 1, texte })));
const texteDb = lignesDb.map((l) => l.texte).join('\n');

/* UN CHAMP DE CONFIG SE DÉCLARE À DEUX ENDROITS dans config.js : la liste `ALLOWED`, qui
   dit ce qu'on accepte du client, et l'UPDATE, qui dit ce qu'on écrit. Manquer le second
   donne le pire des deux mondes : la route répond 200, l'écran affiche « enregistré », et la
   valeur n'est nulle part. Ça s'est produit en ajoutant Jenkins ; ce contrôle le rattrape. */
if (F_CONFIG && registre) {
  const conf = lire(F_CONFIG);
  const bloc = (nom) => (conf.match(new RegExp(`UPDATE ${nom} SET([\\s\\S]*?)WHERE id = 1`)) || [])[1] || '';
  const ecrit = { equipe: bloc('config'), poste: bloc('local_config') };
  const liste = (conf.match(/const ALLOWED = \[([\s\S]*?)\]/) || [])[1] || '';
  const champs = [...liste.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);

  /* DEPUIS QUE LES RÉGLAGES SONT COUPÉS EN DEUX, un champ n'a pas seulement besoin d'être
     écrit : il doit l'être dans LA BONNE TABLE. `config` est ce que l'équipe a décidé et
     partira un jour dans le dépôt partagé ; `local_config` est ce qui appartient à ce poste,
     à commencer par les sept jetons. Un jeton écrit du mauvais côté serait poussé sur la
     forge — et un secret commité dans git est définitif. D'où les trois contrôles ci-dessous,
     le registre faisant foi de la destination. */
  const poste = new Set(registre.localesDe('config'));
  const equipe = new Set(registre.pour('config').partagees);
  const soucis = [];
  for (const c of champs) {
    const ou = poste.has(c) ? 'poste' : (equipe.has(c) ? 'equipe' : null);
    if (!ou) {
      soucis.push(`${nomDe(F_REGISTRE)}  ${c} — champ accepté sans destination : « locales » (ce poste) ou « partagees » (l'équipe) ?`);
      continue;
    }
    const table = ou === 'poste' ? 'local_config' : 'config';
    const autre = ou === 'poste' ? 'config' : 'local_config';
    if (new RegExp(`\\b${c}\\s*=\\s*@${c}\\b`).test(ecrit[ou])) {
      if (new RegExp(`\\b${c}\\s*=\\s*@${c}\\b`).test(ecrit[ou === 'poste' ? 'equipe' : 'poste'])) {
        soucis.push(`${nomDe(F_CONFIG)}  ${c} — écrit dans les DEUX tables : laquelle fait foi ?`);
      }
      continue;
    }
    soucis.push(`${nomDe(F_CONFIG)}  ${c} — accepté par ALLOWED, absent de l'UPDATE ${table}`
      + (new RegExp(`\\b${c}\\s*=\\s*@${c}\\b`).test(ecrit[ou === 'poste' ? 'equipe' : 'poste'])
        ? ` (il est écrit dans ${autre}, qui n'est pas sa destination)` : ''));
  }
  soucis.length
    ? fail('Champs de config sans destination, ou écrits dans la mauvaise table', soucis)
    : ok(`Tout champ de config accepté est écrit, et du bon côté (${champs.length} : `
      + `${champs.filter((c) => poste.has(c)).length} de poste, ${champs.filter((c) => equipe.has(c)).length} d'équipe)`);
}

/* UNE MIGRATION SE JOUE APRÈS LE `CREATE TABLE` QU'ELLE RETOUCHE. Placée avant, elle lève
   « no such table » sur une base neuve, le `catch {}` l'avale, et la colonne n'existe alors que
   sur les bases où la table préexistait. Tout marche sur la sienne et casse chez les autres :
   `task_target.session_note` a vécu ainsi, et faisait échouer la PREMIÈRE session de codage
   d'une installation neuve, après avoir payé une passe d'agent. La règle était écrite dans
   CLAUDE.md ; elle est maintenant vérifiée.

   ET, DANS `db/schema/`, UN ALTER VIT DANS LE FICHIER DU CREATE DE SA TABLE : c'est ce qui
   fait qu'on lit l'histoire d'une table à un seul endroit, et que « avant son CREATE » devient
   impossible par construction. Les fichiers de `db/migrations/` (déclencheurs, reprises) ont
   le droit de retoucher n'importe quelle table déjà créée. */
{
  const cree = new Map();
  lignesDb.forEach((l, n) => {
    // Le `(` est exigé : sans lui, un commentaire disant « le CREATE TABLE ci-dessus »
    // créerait une table fantôme nommée « ci ».
    const m = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/.exec(l.texte);
    if (m && !cree.has(m[1])) cree.set(m[1], { n, f: l.f, i: l.i });
  });
  const avant = [];
  lignesDb.forEach((l, n) => {
    const m = /ALTER TABLE (\w+)/.exec(l.texte);
    if (!m) return;
    const c = cree.get(m[1]);
    if (c == null) avant.push(`${nomDe(l.f)}:${l.i}  ${m[1]} — ALTER sur une table jamais créée ici`);
    else if (c.n > n) avant.push(`${nomDe(l.f)}:${l.i}  ${m[1]} — ALTER avant son CREATE (${nomDe(c.f)}:${c.i})`);
    else if (l.f.startsWith('db/schema/') && c.f !== l.f) {
      avant.push(`${nomDe(l.f)}:${l.i}  ${m[1]} — ALTER hors du fichier de son CREATE (${nomDe(c.f)})`);
    }
  });
  avant.length
    ? fail('Migrations jouées AVANT le CREATE TABLE qu’elles retouchent (invisibles sur une base neuve)', avant)
    : ok(`Toute migration suit son CREATE TABLE (${cree.size} tables, ${FICHIERS_DB.length} fichier${FICHIERS_DB.length > 1 ? 's' : ''})`);
}

/* UN TEST NE DOIT PAS OUVRIR LA BASE RÉELLE.
 *
 * `src/db` ouvre `data/reviewer.db` AU CHARGEMENT. Le harnais pose `MERGERIE_DATA_DIR` dans
 * `startApp()`, pas à l'import : un `require('../src/x')` en tête d'un fichier de test, où `x`
 * atteint `db`, ouvre donc la base de l'utilisateur — et le serveur de test, servi par le cache
 * de `require`, écrit dedans. C'est arrivé : un fichier de test a inséré un dépôt et écrasé la
 * configuration (jeton GitLab compris) de l'installation réelle.
 *
 * Ce qui est PUR (aucun chemin vers `db`) reste importable librement — c'est pour ça que
 * `conflits.js` existe séparément de `gitmerge.js`. Le chemin vers `db` se suit comme Node le
 * suit : `../src/data/store`, `./db` ou `../db` — tout ce qui finit sur `db.js` ou dans `db/`. */
{
  const estDb = (rel) => rel === 'db.js' || rel.startsWith('db/');
  const atteintDb = new Map();
  const versDb = (rel, vus = new Set()) => {
    if (estDb(rel)) return true;
    if (atteintDb.has(rel)) return atteintDb.get(rel);
    if (vus.has(rel)) return false;
    vus.add(rel);
    let r = false;
    try {
      r = requiresDe(rel).map((q) => resoudre(rel, q)).some((cible) => cible && versDb(cible, vus));
    } catch { r = false; }
    atteintDb.set(rel, r);
    return r;
  };
  const fautifs = [];
  const TEST = path.join(ROOT, 'test');
  for (const f of fs.readdirSync(TEST).filter((x) => x.endsWith('.test.js'))) {
    const lignes = fs.readFileSync(path.join(TEST, f), 'utf8').split('\n');
    /* POSER LE DOSSIER SOI-MÊME, AVANT L'IMPORT, est la façon correcte de faire — c'est ce que
       font les tests unitaires. Ce qui est fautif, c'est l'import qui précède : rien n'a alors
       défini `MERGERIE_DATA_DIR`, et `startApp()`, qui le posera, arrive trop tard. */
    const posé = lignes.findIndex((l) => /^\s*process\.env\.MERGERIE_DATA_DIR\s*=/.test(l));
    lignes.forEach((l, i) => {
      if (/^\s/.test(l)) return;                 // dans une fonction : l'env est déjà posé
      const m = /require\('(\.\.\/src\/[^']+)'\)/.exec(l);
      if (!m) return;
      const base = path.resolve(TEST, m[1]);
      let cible = null;
      for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) { cible = path.relative(SRC, c).split(path.sep).join('/'); break; }
      }
      if (!cible || !versDb(cible)) return;
      if (posé !== -1 && posé < i) return;        // le dossier est posé avant : rien à signaler
      fautifs.push(`test/${f}:${i + 1}  require('${m[1]}') avant tout MERGERIE_DATA_DIR — ouvre la base RÉELLE`);
    });
  }
  fautifs.length
    ? fail('Un test importe un module qui ouvre la base, avant que le harnais n’ait posé son dossier', fautifs)
    : ok('Aucun test n’ouvre la base réelle au chargement');
}

/* UNE ATTENTE QUI N'ATTEND PAS. `page.waitForFunction(async () => …)` rend la main au PREMIER
   tour : Playwright ne déroule pas la promesse, il la voit « truthy ». L'attente est un no-op
   déguisé, et le test continue trop tôt — mesuré : 62 ms au lieu d'expirer. Côté serveur, on
   interroge l'API depuis Node (`attendreServeur`), où `await` veut dire `await`. */
{
  const creuses = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.test.js'))) {
    fs.readFileSync(path.join(ROOT, 'test', f), 'utf8').split('\n').forEach((l, i) => {
      if (/waitForFunction\(\s*async/.test(l)) creuses.push(`test/${f}:${i + 1}  waitForFunction(async …) — rend la main aussitôt, utiliser attendreServeur()`);
    });
  }
  creuses.length
    ? fail('Attente de test qui n’attend rien', creuses)
    : ok('Aucune attente creuse (waitForFunction async)');
}

/* UN OBJET QU'ON NOMME EN TOUTES LETTRES REÇOIT SON SLUG À LA CRÉATION, et jamais après.
   C'est le slug qui nommera son fichier dans le dépôt de données partagé
   (`agents/documentaliste/`, `notes/deploiement-prod.md`) : le figer à la création est ce qui
   fait qu'un renommage reste un renommage chez les collègues, et non une suppression suivie
   d'un ajout qui perdrait l'historique git du fichier.

   L'`uid`, lui, est posé par un déclencheur de `db.js` : aucun `INSERT` n'a à y penser. Le
   slug ne peut pas l'être — il demande de relire la table pour suffixer `-2`, `-3`, ce qu'une
   fonction SQL n'a pas le droit de faire. D'où ce contrôle, qui tient les deux seuls points de
   création concernés. */
{
  const fautifs = [];
  for (const f of fichiers) {
    const code = lire(f);
    for (const table of ['agent', 'note_page']) {
      /* On ne lit pas la liste de colonnes : elle est parfois CONSTRUITE (`${cols.join(', ')}`),
         et une lecture naïve s'arrêterait à la première parenthèse du code. On regarde donc si
         le mot `slug` figure dans l'instruction et son `.run(…)` — grossier, et suffisant : ce
         qu'on cherche est un oubli, pas une ruse. */
      const re = new RegExp(`INSERT INTO ${table}\\s*[(\`]`, 'g');
      for (const m of code.matchAll(re)) {
        if (/\bslug\b/.test(code.slice(m.index, m.index + 500))) continue;
        const ligne = code.slice(0, m.index).split('\n').length;
        fautifs.push(`${nomDe(f)}:${ligne}  INSERT INTO ${table} sans colonne slug — la ligne n'aura pas de nom de fichier`);
      }
    }
  }
  fautifs.length
    ? fail('Création d’un agent ou d’une page de notes sans slug', fautifs)
    : ok('Agents et pages de notes reçoivent leur slug à la création');
}

/* CHAQUE TABLE A UNE FAMILLE, ET UNE SEULE. Mergerie devient partageable : le travail accumulé
   part dans un dépôt git d'équipe, le reste ne bouge pas. La décision « cette table se partage-
   t-elle ? » se prend une fois, à la création de la table, et s'écrit dans `store-registry.js`.
   Oubliée, elle se prend toute seule plus tard, et dans les deux sens l'oubli est silencieux :
   une table classée par défaut en partagé enverrait un jour un secret sur la forge, une table
   classée par défaut en local ne serait jamais partagée sans que personne ne comprenne pourquoi.
   D'où ce contrôle, dans les deux sens. */
if (registre) {
  const creees = new Set([...texteDb.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/g)].map((m) => m[1]));
  for (const t of registre.TRANSITOIRES) creees.delete(t);
  const declarees = new Set(registre.REGISTRE.map((e) => e.table));

  const manquantes = [...creees].filter((t) => !declarees.has(t)).sort();
  const fantomes = [...declarees].filter((t) => !creees.has(t)).sort();
  const soucis = [
    ...manquantes.map((t) => `${nomDe(F_REGISTRE)}  ${t} — table du schéma sans famille (P, L ou C ?)`),
    ...fantomes.map((t) => `${nomDe(F_REGISTRE)}  ${t} — classée ici, mais aucune table de ce nom dans le schéma`),
  ];

  /* Une entrée P dit COMMENT elle devient un fichier : soit elle porte son propre fichier
     (`cle` + `chemin`), soit elle est une liste dans le fichier d'un parent (`parent` + `liste`).
     Sans l'un des deux, la classification est un vœu : rien ne saurait l'exporter. */
  for (const e of registre.REGISTRE) {
    if (!['P', 'L', 'C'].includes(e.famille)) {
      soucis.push(`${nomDe(F_REGISTRE)}  ${e.table} — famille « ${e.famille} » inconnue (P, L ou C)`);
      continue;
    }
    if (e.famille !== 'P') continue;
    const propre = e.cle && e.chemin;
    const fille = e.parent && e.liste;
    if (!propre && !fille) soucis.push(`${nomDe(F_REGISTRE)}  ${e.table} — table P sans « cle + chemin » ni « parent + liste »`);
    if (fille && !declarees.has(e.parent)) soucis.push(`${nomDe(F_REGISTRE)}  ${e.table} — parent « ${e.parent} » absent du registre`);
    if (!['append-only', 'last-writer', 'parent'].includes(e.fusion || '')) {
      soucis.push(`${nomDe(F_REGISTRE)}  ${e.table} — fusion « ${e.fusion} » inconnue`);
    }
  }

  soucis.length
    ? fail(`Tables sans famille, ou famille sans table (${nomDe(F_REGISTRE)})`, soucis)
    : ok(`Chaque table a une famille et une seule (${declarees.size} : `
      + `${registre.famille('P').length} partagées, ${registre.famille('L').length} locales, `
      + `${registre.famille('C').length} caches)`);
}


/* LES VERROUS DE SÉCURITÉ DU SERVEUR (guard.md). Chacun fige un garde-fou qui, retiré sans bruit,
   rouvrirait une porte — et aucun test du chemin nominal ne le verrait partir.
   — un `app.get(` ne lance rien (spawn, git, clone, job) : une page tierce peut déclencher un GET ;
   — un `spawn(` hors proc.js/git.js ne passe pas `process.env` tel quel (le `.env` et ses jetons) ;
   — `res.sendFile(` ne sert que par `servirFichierNonFiable` (nosniff, sandbox, attachment) ;
   — l'import du dépôt partagé valide chaque document, et fixe les listes de ce qui exécute.
   La couche HTTP, c'est `server.js` ET tout `app/` : les routes se lisent où qu'elles soient. */
{
  const soucis = [];
  const HTTP = fichiers.filter((f) => f === 'server.js' || f.startsWith('app/'));
  for (const f of HTTP) {
    const serveur = lire(f);
    for (const bloc of serveur.split(/\n(?=\s*app\.(?:get|post|put|patch|delete|use)\()/)) {
      if (!/^\s*app\.get\(/.test(bloc)) continue;
      const corps = bloc.split(/\n\s*\}\)\)?;?\n/)[0];
      /* Lire git (fetch d'un dépôt DÉCLARÉ, diff, liste des branches) est admis en GET pour ces
         routes-là, nommément : ce sont des lectures, derrière la garde Host + Sec-Fetch-Site. Une
         nouvelle route qui lit git en GET s'ajoute ici en connaissance de cause. */
      const LECTURES_GIT = ['/api/mrs/:id/diffview', '/api/git/compare/file', '/api/git/branches', '/api/git/tag-author', '/api/git/find-ref'];
      const route = (corps.match(/^\s*app\.get\('([^']+)'/) || [])[1];
      const motif = LECTURES_GIT.includes(route) ? /\b(spawn\(|startJob\(|start\w+Job\()/ : /\b(spawn\(|git\.run\(|ensureRepo\(|startJob\(|start\w+Job\()/;
      const m = corps.match(motif);
      if (m) soucis.push(`${nomDe(f)}  ${corps.split('\n')[0].trim().slice(0, 70)} — un GET qui lance « ${m[1]} »`);
    }
  }
  for (const f of fichiers.filter((n) => !['proc.js', 'git.js'].includes(path.basename(n)))) {
    const texte = lire(f);
    for (const m of texte.matchAll(/\bspawn\(([^;]{0,400})/g)) {
      if (/\benv\s*:\s*process\.env\b|\{\s*\.\.\.process\.env\b/.test(m[1])) soucis.push(`${nomDe(f)}  spawn(…) avec process.env tel quel`);
    }
  }
  let envoi = 0;
  let dedans = 0;
  for (const f of fichiers) {
    const texte = lire(f);
    envoi += [...texte.matchAll(/res\.sendFile\(/g)].length;
    const fonction = (texte.match(/function servirFichierNonFiable[\s\S]*?\n\}\n/) || [''])[0];
    dedans += [...fonction.matchAll(/res\.sendFile\(/g)].length;
  }
  if (envoi !== dedans) soucis.push(`src/  ${envoi - dedans} res.sendFile( hors de servirFichierNonFiable`);
  if (F_STORE) {
    const store = lire(F_STORE);
    if (!/validerDocument\(/.test(store.replace(/function validerDocument[\s\S]*?\n\}\n/, ''))) {
      soucis.push(`${nomDe(F_STORE)}  validerDocument n’est plus appelé à l’import`);
    }
    for (const table of ['verifier', 'agent']) {
      if (!new RegExp(`\\n\\s*${table}:\\s*\\{`).test((store.match(/const ENUMS = \{[\s\S]*?\n\};/) || [''])[0])) {
        soucis.push(`${nomDe(F_STORE)}  ENUMS sans entrée « ${table} » — ce qui décide d'une exécution n'a plus de liste fermée`);
      }
    }
  }
  soucis.length
    ? fail('Verrous de sécurité du serveur (guard.md)', soucis)
    : ok('GET sans effet, env des processus filtré, fichiers servis par la porte prudente, import validé');
}

/* LA TAILLE D'UN FICHIER SE SURVEILLE (refacto.md, §3.4). Un fichier de huit mille lignes ne
   naît pas en un jour : il grossit de cinquante lignes par fonctionnalité, et personne ne
   décide jamais de le couper. Ce contrôle décide à sa place — avertissement passé 600 lignes,
   échec passé 1 200 —, les lignes de commentaire non comptées : la documentation en tête de
   fichier est une règle du projet, elle ne doit pas pousser à se raccourcir.

   Les exceptions sont NOMMÉES, et la liste ne peut que RÉTRÉCIR : ce sont les fichiers qui
   dépassaient déjà le seuil quand la règle est née. Retirer un nom de la liste, c'est le
   commit qui découpe le fichier ; en ajouter un demande de dire pourquoi, en revue. */
{
  const AVERTIR = 600;
  const ECHOUER = 1200;
  const EXCEPTIONS = ['db.js', 'store-registry.js', 'links.js', 'store.js', 'jobs.js', 'taskrunner.js', 'datasync.js'];
  const compter = (code) => code.split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)).length;
  const gros = [];
  const trop = [];
  for (const f of fichiers) {
    const n = compter(lire(f));
    if (n > ECHOUER && !EXCEPTIONS.includes(path.basename(f))) trop.push(`${nomDe(f)}  ${n} lignes de code — à découper (seuil ${ECHOUER})`);
    else if (n > AVERTIR) gros.push(`${nomDe(f)}  ${n} lignes de code${n > ECHOUER ? ' (exception nommée)' : ''}`);
  }
  if (trop.length) fail(`Fichiers au-delà de ${ECHOUER} lignes de code, hors exceptions nommées`, trop);
  if (gros.length) avertir(`Fichiers au-delà de ${AVERTIR} lignes de code — à découper avant la prochaine fonctionnalité`, gros);
  if (!trop.length) ok(`Aucun fichier ne dépasse ${ECHOUER} lignes de code hors exceptions (${EXCEPTIONS.length} nommées, ${gros.length} au-delà de ${AVERTIR})`);
}


console.log(failures ? '\nContrôles serveur : ÉCHEC\n' : '\nContrôles serveur : OK\n');
process.exit(failures ? 1 : 0);
