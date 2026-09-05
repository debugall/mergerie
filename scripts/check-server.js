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
  const bloc = (conf.match(/UPDATE config SET([\s\S]*?)WHERE id = 1/) || [])[1] || '';
  const liste = (conf.match(/const ALLOWED = \[([\s\S]*?)\]/) || [])[1] || '';
  const champs = [...liste.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  const oublies = champs.filter((c) => !new RegExp(`\\b${c}\\s*=\\s*@${c}\\b`).test(bloc));
  oublies.length
    ? fail('Champs de config acceptés mais jamais écrits (ALLOWED sans ligne dans l’UPDATE)',
      oublies.map((c) => `src/config.js  ${c} — accepté par ALLOWED, absent de l'UPDATE`))
    : ok(`Tout champ de config accepté est écrit (${champs.length})`);
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
    const m = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/.exec(l);
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

console.log(failures ? '\nContrôles serveur : ÉCHEC\n' : '\nContrôles serveur : OK\n');
process.exit(failures ? 1 : 0);
