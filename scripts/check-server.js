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

console.log(failures ? '\nContrôles serveur : ÉCHEC\n' : '\nContrôles serveur : OK\n');
process.exit(failures ? 1 : 0);
