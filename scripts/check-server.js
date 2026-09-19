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
   retrouver ce bug en coûte beaucoup plus. */
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

/* 0. LA SYNTAXE, D'ABORD — même raison que côté front. Tous les contrôles de ce fichier lisent
   le serveur comme du TEXTE : une accolade non fermée leur échappe entièrement, et
   `npm run check` répondait OK sur un `server.js` que Node refuse de charger. Le symptôme est
   alors une suite de tests qui se BLOQUE (le hook de démarrage échoue avant tout log), ce qui
   ressemble à une lenteur et coûte une demi-heure à diagnostiquer. Vu une fois : une
   substitution qui avait mangé le `}` d'un `if`. */
for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js'))) {
  try {
    new (require('vm').Script)(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
  } catch (e) {
    fail(`src/${f} ne parse pas — le serveur ne démarre pas`, [String(e.message)]);
  }
}
if (!failures) ok(`Le serveur parse (${fs.readdirSync(SRC).filter((n) => n.endsWith('.js')).length} fichiers)`);

const fichiers = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

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

const coupables = [];
for (const f of fichiers) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  // Seuls les fichiers qui TRADUISENT sont concernés : ailleurs, `t` est un nom libre.
  if (!/require\(['"][^'"]*i18n-runtime[^'"]*['"]\)/.test(code)) continue;
  code.split('\n').forEach((ligne, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ligne)) return;           // commentaires
    for (const { re, quoi } of LIAISONS) {
      if (re.test(ligne)) coupables.push(`src/${f}:${i + 1}  ${quoi} — ${ligne.trim().slice(0, 88)}`);
    }
  });
}

coupables.length
  ? fail('Le nom `t` est réutilisé dans un fichier qui traduit (il masque la traduction)', coupables)
  : ok(`Le nom \`t\` reste la traduction (${fichiers.length} fichiers examinés)`);

/* UN CHAMP DE CONFIG SE DÉCLARE À DEUX ENDROITS dans src/config.js : la liste `ALLOWED`, qui
   dit ce qu'on accepte du client, et l'UPDATE, qui dit ce qu'on écrit. Manquer le second
   donne le pire des deux mondes : la route répond 200, l'écran affiche « enregistré », et la
   valeur n'est nulle part. Ça s'est produit en ajoutant Jenkins ; ce contrôle le rattrape. */
{
  const conf = fs.readFileSync(path.join(SRC, 'config.js'), 'utf8');
  const registre = require(path.join(SRC, 'store-registry.js'));
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
      soucis.push(`src/store-registry.js  ${c} — champ accepté sans destination : « locales » (ce poste) ou « partagees » (l'équipe) ?`);
      continue;
    }
    const table = ou === 'poste' ? 'local_config' : 'config';
    const autre = ou === 'poste' ? 'config' : 'local_config';
    if (new RegExp(`\\b${c}\\s*=\\s*@${c}\\b`).test(ecrit[ou])) {
      if (new RegExp(`\\b${c}\\s*=\\s*@${c}\\b`).test(ecrit[ou === 'poste' ? 'equipe' : 'poste'])) {
        soucis.push(`src/config.js  ${c} — écrit dans les DEUX tables : laquelle fait foi ?`);
      }
      continue;
    }
    soucis.push(`src/config.js  ${c} — accepté par ALLOWED, absent de l'UPDATE ${table}`
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
   CLAUDE.md ; elle est maintenant vérifiée. */
{
  const lignes = fs.readFileSync(path.join(SRC, 'db.js'), 'utf8').split('\n');
  const cree = new Map();
  lignes.forEach((l, i) => {
    // Le `(` est exigé : sans lui, un commentaire disant « le CREATE TABLE ci-dessus »
    // créerait une table fantôme nommée « ci ».
    const m = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/.exec(l);
    if (m && !cree.has(m[1])) cree.set(m[1], i + 1);
  });
  const avant = [];
  lignes.forEach((l, i) => {
    const m = /ALTER TABLE (\w+)/.exec(l);
    if (!m) return;
    const c = cree.get(m[1]);
    if (c == null) avant.push(`src/db.js:${i + 1}  ${m[1]} — ALTER sur une table jamais créée ici`);
    else if (c > i + 1) avant.push(`src/db.js:${i + 1}  ${m[1]} — ALTER avant son CREATE (ligne ${c})`);
  });
  avant.length
    ? fail('Migrations jouées AVANT le CREATE TABLE qu’elles retouchent (invisibles sur une base neuve)', avant)
    : ok(`Toute migration suit son CREATE TABLE (${cree.size} tables)`);
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
 * `src/conflits.js` existe séparément de `src/gitmerge.js`. */
{
  const SRC = path.join(ROOT, 'src');
  const atteintDb = new Map();
  const versDb = (nom, vus = new Set()) => {
    if (nom === 'db') return true;
    if (atteintDb.has(nom)) return atteintDb.get(nom);
    if (vus.has(nom)) return false;
    vus.add(nom);
    let code = '';
    try { code = fs.readFileSync(path.join(SRC, `${nom}.js`), 'utf8'); } catch { return false; }
    const r = [...code.matchAll(/require\('\.\/([\w-]+)'\)/g)].some((m) => versDb(m[1], vus));
    atteintDb.set(nom, r);
    return r;
  };
  const fautifs = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.test.js'))) {
    const lignes = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8').split('\n');
    /* POSER LE DOSSIER SOI-MÊME, AVANT L'IMPORT, est la façon correcte de faire — c'est ce que
       font les tests unitaires. Ce qui est fautif, c'est l'import qui précède : rien n'a alors
       défini `MERGERIE_DATA_DIR`, et `startApp()`, qui le posera, arrive trop tard. */
    const posé = lignes.findIndex((l) => /^\s*process\.env\.MERGERIE_DATA_DIR\s*=/.test(l));
    lignes.forEach((l, i) => {
      if (/^\s/.test(l)) return;                 // dans une fonction : l'env est déjà posé
      const m = /require\('\.\.\/src\/([\w-]+)'\)/.exec(l);
      if (!m || !versDb(m[1])) return;
      if (posé !== -1 && posé < i) return;        // le dossier est posé avant : rien à signaler
      fautifs.push(`test/${f}:${i + 1}  require('../src/${m[1]}') avant tout MERGERIE_DATA_DIR — ouvre la base RÉELLE`);
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
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const table of ['agent', 'note_page']) {
      /* On ne lit pas la liste de colonnes : elle est parfois CONSTRUITE (`${cols.join(', ')}`),
         et une lecture naïve s'arrêterait à la première parenthèse du code. On regarde donc si
         le mot `slug` figure dans l'instruction et son `.run(…)` — grossier, et suffisant : ce
         qu'on cherche est un oubli, pas une ruse. */
      const re = new RegExp(`INSERT INTO ${table}\\s*[(\`]`, 'g');
      for (const m of code.matchAll(re)) {
        if (/\bslug\b/.test(code.slice(m.index, m.index + 500))) continue;
        const ligne = code.slice(0, m.index).split('\n').length;
        fautifs.push(`src/${f}:${ligne}  INSERT INTO ${table} sans colonne slug — la ligne n'aura pas de nom de fichier`);
      }
    }
  }
  fautifs.length
    ? fail('Création d’un agent ou d’une page de notes sans slug', fautifs)
    : ok('Agents et pages de notes reçoivent leur slug à la création');
}

/* CHAQUE TABLE A UNE FAMILLE, ET UNE SEULE. Mergerie devient partageable : le travail accumulé
   part dans un dépôt git d'équipe, le reste ne bouge pas. La décision « cette table se partage-
   t-elle ? » se prend une fois, à la création de la table, et s'écrit dans `src/store-registry.js`.
   Oubliée, elle se prend toute seule plus tard, et dans les deux sens l'oubli est silencieux :
   une table classée par défaut en partagé enverrait un jour un secret sur la forge, une table
   classée par défaut en local ne serait jamais partagée sans que personne ne comprenne pourquoi.
   D'où ce contrôle, dans les deux sens. */
{
  const src = fs.readFileSync(path.join(SRC, 'db.js'), 'utf8');
  const registre = require(path.join(SRC, 'store-registry.js'));
  const creees = new Set([...src.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/g)].map((m) => m[1]));
  for (const t of registre.TRANSITOIRES) creees.delete(t);
  const declarees = new Set(registre.REGISTRE.map((e) => e.table));

  const manquantes = [...creees].filter((t) => !declarees.has(t)).sort();
  const fantomes = [...declarees].filter((t) => !creees.has(t)).sort();
  const soucis = [
    ...manquantes.map((t) => `src/store-registry.js  ${t} — table de db.js sans famille (P, L ou C ?)`),
    ...fantomes.map((t) => `src/store-registry.js  ${t} — classée ici, mais aucune table de ce nom dans db.js`),
  ];

  /* Une entrée P dit COMMENT elle devient un fichier : soit elle porte son propre fichier
     (`cle` + `chemin`), soit elle est une liste dans le fichier d'un parent (`parent` + `liste`).
     Sans l'un des deux, la classification est un vœu : rien ne saurait l'exporter. */
  for (const e of registre.REGISTRE) {
    if (!['P', 'L', 'C'].includes(e.famille)) {
      soucis.push(`src/store-registry.js  ${e.table} — famille « ${e.famille} » inconnue (P, L ou C)`);
      continue;
    }
    if (e.famille !== 'P') continue;
    const propre = e.cle && e.chemin;
    const fille = e.parent && e.liste;
    if (!propre && !fille) soucis.push(`src/store-registry.js  ${e.table} — table P sans « cle + chemin » ni « parent + liste »`);
    if (fille && !declarees.has(e.parent)) soucis.push(`src/store-registry.js  ${e.table} — parent « ${e.parent} » absent du registre`);
    if (!['append-only', 'last-writer', 'parent'].includes(e.fusion || '')) {
      soucis.push(`src/store-registry.js  ${e.table} — fusion « ${e.fusion} » inconnue`);
    }
  }

  soucis.length
    ? fail('Tables sans famille, ou famille sans table (src/store-registry.js)', soucis)
    : ok(`Chaque table a une famille et une seule (${declarees.size} : `
      + `${registre.famille('P').length} partagées, ${registre.famille('L').length} locales, `
      + `${registre.famille('C').length} caches)`);
}


/* LES VERROUS DE SÉCURITÉ DU SERVEUR (guard.md). Chacun fige un garde-fou qui, retiré sans bruit,
   rouvrirait une porte — et aucun test du chemin nominal ne le verrait partir.
   — un `app.get(` ne lance rien (spawn, git, clone, job) : une page tierce peut déclencher un GET ;
   — un `spawn(` hors proc.js/git.js ne passe pas `process.env` tel quel (le `.env` et ses jetons) ;
   — `res.sendFile(` ne sert que par `servirFichierNonFiable` (nosniff, sandbox, attachment) ;
   — l'import du dépôt partagé valide chaque document, et fixe les listes de ce qui exécute. */
{
  const soucis = [];
  const serveur = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  for (const bloc of serveur.split(/\n(?=app\.(?:get|post|put|patch|delete|use)\()/)) {
    if (!bloc.startsWith('app.get(')) continue;
    const corps = bloc.split(/\n\}\)\)?;?\n/)[0];
    /* Lire git (fetch d'un dépôt DÉCLARÉ, diff, liste des branches) est admis en GET pour ces
       routes-là, nommément : ce sont des lectures, derrière la garde Host + Sec-Fetch-Site. Une
       nouvelle route qui lit git en GET s'ajoute ici en connaissance de cause. */
    const LECTURES_GIT = ['/api/mrs/:id/diffview', '/api/git/compare/file', '/api/git/branches', '/api/git/tag-author', '/api/git/find-ref'];
    const route = (corps.match(/^app\.get\('([^']+)'/) || [])[1];
    const motif = LECTURES_GIT.includes(route) ? /\b(spawn\(|startJob\(|start\w+Job\()/ : /\b(spawn\(|git\.run\(|ensureRepo\(|startJob\(|start\w+Job\()/;
    const m = corps.match(motif);
    if (m) soucis.push(`src/server.js  ${corps.split('\n')[0].slice(0, 70)} — un GET qui lance « ${m[1]} »`);
  }
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js') && !['proc.js', 'git.js'].includes(n))) {
    const texte = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of texte.matchAll(/\bspawn\(([^;]{0,400})/g)) {
      if (/\benv\s*:\s*process\.env\b|\{\s*\.\.\.process\.env\b/.test(m[1])) soucis.push(`src/${f}  spawn(…) avec process.env tel quel`);
    }
  }
  const envoi = [...serveur.matchAll(/res\.sendFile\(/g)].length;
  const fonction = (serveur.match(/function servirFichierNonFiable[\s\S]*?\n\}\n/) || [''])[0];
  const dedans = [...fonction.matchAll(/res\.sendFile\(/g)].length;
  if (envoi !== dedans) soucis.push(`src/server.js  ${envoi - dedans} res.sendFile( hors de servirFichierNonFiable`);
  const store = fs.readFileSync(path.join(SRC, 'store.js'), 'utf8');
  if (!/validerDocument\(/.test(store.replace(/function validerDocument[\s\S]*?\n\}\n/, ''))) {
    soucis.push('src/store.js  validerDocument n’est plus appelé à l’import');
  }
  for (const table of ['verifier', 'agent']) {
    if (!new RegExp(`\\n\\s*${table}:\\s*\\{`).test((store.match(/const ENUMS = \{[\s\S]*?\n\};/) || [''])[0])) {
      soucis.push(`src/store.js  ENUMS sans entrée « ${table} » — ce qui décide d'une exécution n'a plus de liste fermée`);
    }
  }
  soucis.length
    ? fail('Verrous de sécurité du serveur (guard.md)', soucis)
    : ok('GET sans effet, env des processus filtré, fichiers servis par la porte prudente, import validé');
}


console.log(failures ? '\nContrôles serveur : ÉCHEC\n' : '\nContrôles serveur : OK\n');
process.exit(failures ? 1 : 0);
